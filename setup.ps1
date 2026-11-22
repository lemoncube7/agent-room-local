[CmdletBinding()]
param(
  [string]$Project = (Get-Location).Path,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$projectPath = (Resolve-Path -LiteralPath $Project).Path
if (-not (Test-Path -LiteralPath $projectPath -PathType Container)) { throw 'Project must be a directory.' }
$bridgePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'bridge.cjs')).Path
$claudePath = Join-Path $projectPath '.mcp.json'
$codexPath = Join-Path $projectPath '.codex/config.toml'
$utf8 = New-Object Text.UTF8Encoding($false)
$node = Get-Command node -ErrorAction Stop
$major = [int]((& $node.Source -p "process.versions.node.split('.')[0]") | Select-Object -First 1)
if ($major -lt 24) { throw 'Agent Room requires Node.js 24 or newer.' }

$claudeConfig = if (Test-Path -LiteralPath $claudePath) {
  Get-Content -LiteralPath $claudePath -Raw -Encoding utf8 | ConvertFrom-Json
} else { [pscustomobject]@{} }
if ($claudeConfig -isnot [pscustomobject]) { throw 'Expected a JSON object in .mcp.json.' }
if (-not $claudeConfig.PSObject.Properties['mcpServers']) {
  $claudeConfig | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{})
}
if ($claudeConfig.mcpServers -isnot [pscustomobject]) { throw 'Expected an mcpServers object.' }
$wantedClaude = [pscustomobject]@{ command='node'; args=@($bridgePath,'claude') }
$existingClaude = $claudeConfig.mcpServers.PSObject.Properties['agent-room']
if ($existingClaude) {
  $existing = $existingClaude.Value
  if ($existing.command -cne 'node' -or (($existing.args -join '|') -cne ($wantedClaude.args -join '|'))) {
    throw 'Existing Claude agent-room config differs. Review it before applying setup.'
  }
}
$codex = if (Test-Path -LiteralPath $codexPath) { [IO.File]::ReadAllText($codexPath) } else { '' }
$argsJson = ConvertTo-Json -InputObject @($bridgePath.Replace('\','/'),'codex') -Compress
$block = "[mcp_servers.agent-room]`ncommand = `"node`"`nargs = $argsJson"
$start = '# Agent Room setup begin'
$end = '# Agent Room setup end'
$managedBlock = "$start`n$block`n$end"
$normalized = $codex -replace '
',"`n"
$existingCodex = $normalized.Contains($managedBlock)
if (([regex]::IsMatch($normalized,'(?m)^\s*\[mcp_servers\.(?:agent-room|"agent-room"|''agent-room'')\s*\]')) -and -not $existingCodex) {
  throw 'Existing Codex agent-room config differs. Review it before applying setup.'
}
function Save-Config($file,$contents) {
  $folder = Split-Path -Parent $file
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  if (Test-Path -LiteralPath $file) {
    Copy-Item -LiteralPath $file -Destination ($file+'.agent-room-'+[guid]::NewGuid()+'.bak')
  }
  $temp = Join-Path $folder ('.agent-room-'+[guid]::NewGuid()+'.tmp')
  try {
    [IO.File]::WriteAllText($temp,$contents,$utf8)
    Move-Item -LiteralPath $temp -Destination $file -Force
  } finally { Remove-Item -LiteralPath $temp -ErrorAction SilentlyContinue }
}
if ($Apply) {
  if (-not $existingClaude) {
    $claudeConfig.mcpServers | Add-Member -NotePropertyName 'agent-room' -NotePropertyValue $wantedClaude
    Save-Config $claudePath ($claudeConfig | ConvertTo-Json -Depth 30)
  }
  if (-not $existingCodex) { Save-Config $codexPath ($codex.TrimEnd()+"`n`n"+$managedBlock+"`n") }
}
[pscustomobject]@{
  mode = if($Apply){'applied'}else{'preview'}
  project = $projectPath
  node_major = $major
  claude_config = $claudePath
  codex_config = $codexPath
  claude_cli_on_path = [bool](Get-Command claude -ErrorAction SilentlyContinue)
  codex_cli_on_path = [bool](Get-Command codex -ErrorAction SilentlyContinue)
  hub_command = "node `"$(Join-Path $PSScriptRoot 'hub.cjs')`""
  existing_claude_session = 'From the project folder: claude --resume <session-id> --dangerously-load-development-channels server:agent-room'
  existing_codex_session = 'Reopen the original project conversation after MCP reload and check /mcp.'
  pairing = 'Create a room code in Agent Room, paste the generated message into the existing conversation, approve the request.'
} | ConvertTo-Json
