[CmdletBinding()]
param(
  [string]$Project = (Get-Location).Path,
  [switch]$Apply,
  [switch]$SelectProject,
  [switch]$Connect,
  [switch]$Test
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
if (($Connect -or $SelectProject) -and -not $Apply) { throw 'Use -Apply with -Connect or -SelectProject.' }
function Find-AgentCli($provider) {
    $app = Get-Command "$provider.exe" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($app) { return $app.Source }
    $candidates = if ($provider -eq 'codex') {
        if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue) {
            Get-AppxPackage -Name OpenAI.Codex | ForEach-Object { Join-Path $_.InstallLocation 'app/resources/codex.exe' }
        }
        Join-Path $env:APPDATA 'npm/node_modules/@openai/codex/bin/codex.js'
    } else {
        Join-Path $env:USERPROFILE '.local/bin/claude.exe'
        Join-Path $env:APPDATA 'npm/node_modules/@anthropic-ai/claude-code/cli.js'
    }
    $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

if ($Apply) {
  if (-not $existingClaude) {
    $claudeConfig.mcpServers | Add-Member -NotePropertyName 'agent-room' -NotePropertyValue $wantedClaude
    Save-Config $claudePath ($claudeConfig | ConvertTo-Json -Depth 30)
  }
  if (-not $existingCodex) { Save-Config $codexPath ($codex.TrimEnd()+"`n`n"+$managedBlock+"`n") }
}
$cliSettings = @{codex=(Find-AgentCli 'codex');claude=(Find-AgentCli 'claude')}
if ($Connect -or $SelectProject) {
  $roomLocal = Join-Path $PSScriptRoot 'local'
  [void][IO.Directory]::CreateDirectory($roomLocal)
  [IO.File]::WriteAllText((Join-Path $roomLocal 'cli.json'), ($cliSettings | ConvertTo-Json -Compress))
  [IO.File]::WriteAllText((Join-Path $roomLocal 'project.txt'), $projectPath)
}
function Get-VerifiedHub {
  try {
    $connection = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'local/hub.json') -Raw | ConvertFrom-Json
    if ($connection.url -ne 'http://127.0.0.1:4317') { return $false }
    $null = Invoke-RestMethod -Uri ($connection.url+'/tool') -Method Post -Headers @{Authorization='Bearer '+$connection.token} -ContentType 'application/json' -Body '{"action":"list_rooms"}' -TimeoutSec 2
    return $true
  } catch { return $false }
}
if ($Connect -and -not (Get-VerifiedHub)) {
  $hub = Start-Process -FilePath $node.Source -ArgumentList ('"' + (Join-Path $PSScriptRoot 'hub.cjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
  for($attempt=0;$attempt -lt 12 -and -not (Get-VerifiedHub);$attempt++){
    if($hub.HasExited){break}
    Start-Sleep -Milliseconds 250
  }
  if(-not (Get-VerifiedHub)){throw 'The selected installation did not start its hub on port 4317. Check for another Agent Room installation.'}
}
$results = $null
if ($Test) {
  $results=@{}
  foreach ($provider in 'codex','claude') {
    $cliPath=$cliSettings[$provider]
    if(-not $cliPath){$results[$provider]=@{status='not_found'}; continue}
    Push-Location -LiteralPath $projectPath
    $previousErrorAction=$ErrorActionPreference
    try {
      $ErrorActionPreference='Continue'
      $output = if($cliPath -match '\.(?:js|mjs|cjs)$'){ & $node.Source $cliPath --version 2>$null }else{ & $cliPath --version 2>$null }
      $results[$provider]=@{status=if($LASTEXITCODE -eq 0){'verified'}else{'execution_failed'}; version=($output -join ' ').Trim()}
    } catch { $results[$provider]=@{status='execution_failed'} }
    finally { $ErrorActionPreference=$previousErrorAction; Pop-Location }
  }
  $smokeOutput = & $node.Source (Join-Path $PSScriptRoot 'smoke-test.cjs') 2>&1
  if($LASTEXITCODE){throw ('Agent Room isolated connection test failed: '+($smokeOutput -join ' '))}
  $results['isolated_mcp_test']='passed'
}
$claudeRegistered = $null -ne $existingClaude -or $Apply
$codexRegistered = $existingCodex -or $Apply
[pscustomobject]@{
  mode = if($Apply){'applied'}else{'preview'}
  project = $projectPath
  node_major = $major
  claude_config = $claudePath
  codex_config = $codexPath
  claude_registered = [bool]$claudeRegistered
  codex_registered = [bool]$codexRegistered
  cli_paths = $cliSettings
  tests = $results
  connected_hub = if($Connect){Get-VerifiedHub}else{$null}
  hub_command = "node `"$(Join-Path $PSScriptRoot 'hub.cjs')`""
  existing_claude_session = 'From the project folder: claude --resume <session-id> --dangerously-load-development-channels server:agent-room'
  existing_codex_session = 'Reopen the original project conversation after MCP reload and check /mcp.'
  pairing = 'Create a room code in Agent Room, paste the generated message into the existing conversation, approve the request.'
} | ConvertTo-Json
