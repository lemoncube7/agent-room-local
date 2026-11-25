[CmdletBinding()]
param(
  [string]$Project = (Get-Location).Path,
  [switch]$Apply,
  [switch]$Global,
  [switch]$SelectProject,
  [switch]$Connect,
  [switch]$Test,
  [string]$CodexCli,
  [ValidateSet('mxc')][string]$CodexSandbox
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

$wantedClaude = [pscustomobject]@{ command='node'; args=@($bridgePath,'claude') }
$argsJson = ConvertTo-Json -InputObject @($bridgePath.Replace('\','/'),'codex') -Compress
$block = "[mcp_servers.agent-room]`ncommand = `"node`"`nargs = $argsJson"
$start = '# Agent Room setup begin'
$end = '# Agent Room setup end'
$managedBlock = "$start`n$block`n$end"

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
function Sync-ClaudeMcp($file,$writeChanges) {
  $cfg = if (Test-Path -LiteralPath $file) {
    Get-Content -LiteralPath $file -Raw -Encoding utf8 | ConvertFrom-Json
  } else { [pscustomobject]@{} }
  if ($cfg -isnot [pscustomobject]) { throw "Expected a JSON object in $file." }
  if (-not $cfg.PSObject.Properties['mcpServers']) {
    $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{})
  }
  if ($cfg.mcpServers -isnot [pscustomobject]) { throw "Expected an mcpServers object in $file." }
  $existing = $cfg.mcpServers.PSObject.Properties['agent-room']
  if ($existing) {
    $val = $existing.Value
    $isExact = $val.command -ceq 'node' -and (($val.args -join '|') -ceq ($wantedClaude.args -join '|'))
    if ($isExact) { return $true }
    $isOtherBridge = $val.command -eq 'node' -and $val.args -and $val.args.Count -ge 1 -and ($val.args[0] -like '*bridge.cjs') -and (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $val.args[0]) 'hub.cjs') -PathType Leaf)
    if (-not $isOtherBridge) {
      throw "Existing Claude agent-room config differs in $file. Review it before applying setup."
    }
    if ($writeChanges) {
      $cfg.mcpServers.PSObject.Properties.Remove('agent-room')
      $cfg.mcpServers | Add-Member -NotePropertyName 'agent-room' -NotePropertyValue $wantedClaude
      Save-Config $file ($cfg | ConvertTo-Json -Depth 30)
      return $true
    }
    return $false
  }
  if ($writeChanges) {
    $cfg.mcpServers | Add-Member -NotePropertyName 'agent-room' -NotePropertyValue $wantedClaude
    Save-Config $file ($cfg | ConvertTo-Json -Depth 30)
    return $true
  }
  return $false
}
function Sync-CodexMcp($file,$writeChanges,$trustDir=$null) {
  $raw = if (Test-Path -LiteralPath $file) { [IO.File]::ReadAllText($file) } else { '' }
  $norm = $raw -replace "`r`n","`n"
  $hasManaged = $norm.Contains($managedBlock)
  $oldBlockMatch = [regex]::Match($norm, '(?ms)^# Agent Room setup begin\n.*?^# Agent Room setup end\n?')
  $remainder = if ($oldBlockMatch.Success -and -not $hasManaged) { $norm.Remove($oldBlockMatch.Index, $oldBlockMatch.Length) } else { $norm }
  $hasOtherAgentRoom = [regex]::IsMatch($remainder,'(?m)^\s*\[mcp_servers\.(?:agent-room|"agent-room"|''agent-room'')\s*\]')
  if ($hasOtherAgentRoom -and -not $hasManaged) {
    throw "Existing Codex agent-room config differs in $file. Review it before applying setup."
  }
  $needsTrust = $trustDir -and -not [regex]::IsMatch($norm, ('(?mi)^\s*\[projects\.' + [regex]::Escape("'$trustDir'") + '\s*\]')) -and -not [regex]::IsMatch($norm, ('(?mi)^\s*\[projects\.' + [regex]::Escape('"' + $trustDir.Replace('\','\\') + '"') + '\s*\]'))
  if ((-not $hasManaged -or $needsTrust) -and $writeChanges) {
    $next = if ($oldBlockMatch.Success -and -not $hasManaged) { $remainder.TrimEnd() } else { $raw.TrimEnd() }
    if (-not $hasManaged) { $next = if ($next) { $next + "`n`n" + $managedBlock } else { $managedBlock } }
    if ($needsTrust) { $next = if ($next) { $next + "`n`n[projects.'$trustDir']`ntrust_level = `"trusted`"" } else { "[projects.'$trustDir']`ntrust_level = `"trusted`"" } }
    Save-Config $file ($next + "`n")
    return $true
  }
  return $hasManaged
}
$existingClaude = Sync-ClaudeMcp $claudePath $false
$existingCodex = Sync-CodexMcp $codexPath $false
if (($Connect -or $SelectProject) -and -not $Apply) { throw 'Use -Apply with -Connect or -SelectProject.' }
function Find-AgentCli($provider) {
    $app = Get-Command "$provider.exe" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($app) { return $app.Source }
    $candidates = if ($provider -eq 'codex') {
        if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue) {
            Get-AppxPackage -Name OpenAI.Codex | ForEach-Object { Join-Path $_.InstallLocation 'app/resources/codex.exe' }
        }
        Join-Path $env:APPDATA 'npm/node_modules/@openai/codex/bin/codex.js'
    } elseif ($provider -eq 'agy') {
        Join-Path $env:LOCALAPPDATA 'agy/bin/agy.exe'
    } else {
        Join-Path $env:USERPROFILE '.local/bin/claude.exe'
        Join-Path $env:APPDATA 'npm/node_modules/@anthropic-ai/claude-code/cli.js'
    }
    $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

if ($Apply) {
  $existingClaude = Sync-ClaudeMcp $claudePath $true
  $existingCodex = Sync-CodexMcp $codexPath $true
}
$cliSettings = @{codex=(Find-AgentCli 'codex');claude=(Find-AgentCli 'claude');agy=(Find-AgentCli 'agy')}
if ($CodexCli) {
  $cliSettings.codex=(Resolve-Path -LiteralPath $CodexCli).Path
  if(-not (Test-Path -LiteralPath $cliSettings.codex -PathType Leaf)){throw 'Codex CLI must be a file.'}
} else {
  $savedCliPath=Join-Path $PSScriptRoot 'local/cli.json'
  if(Test-Path -LiteralPath $savedCliPath){
    $savedCli=Get-Content -LiteralPath $savedCliPath -Raw | ConvertFrom-Json
    if($savedCli.codex -and (Test-Path -LiteralPath $savedCli.codex -PathType Leaf)){$cliSettings.codex=$savedCli.codex}
  }
}
if ($Apply -and $Global) {
  $globalCodexPath = Join-Path $env:USERPROFILE '.codex/config.toml'
  $globalClaudePath = Join-Path $env:USERPROFILE '.claude.json'
  [void](Sync-CodexMcp $globalCodexPath $true $projectPath)
  [void](Sync-ClaudeMcp $globalClaudePath $true)
  if ($env:APPDATA -and (Test-Path -LiteralPath (Join-Path $env:APPDATA 'Claude') -PathType Container)) {
    [void](Sync-ClaudeMcp (Join-Path $env:APPDATA 'Claude/claude_desktop_config.json') $true)
  }
  if ($cliSettings.agy -and (Test-Path -LiteralPath $cliSettings.agy -PathType Leaf)) {
    & $cliSettings.agy mcp add agent-room $node.Source $bridgePath agy 2>$null | Out-Null
    if ($LASTEXITCODE) { throw 'Failed to register Agent Room MCP in Antigravity (agy).' }
  }
}
if ($Connect -or $SelectProject) {
  $roomLocal = Join-Path $PSScriptRoot 'local'
  $savedSettingsPath=Join-Path $roomLocal 'cli.json'
  if($CodexSandbox){$cliSettings.codexSandbox=$CodexSandbox}
  elseif(Test-Path -LiteralPath $savedSettingsPath){
    $previous=Get-Content -LiteralPath $savedSettingsPath -Raw|ConvertFrom-Json
    if($previous.codexSandbox -eq 'mxc'){$cliSettings.codexSandbox='mxc'}
  }
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
  foreach ($provider in 'codex','claude','agy') {
    $cliPath=$cliSettings[$provider]
    if(-not $cliPath){$results[$provider]=@{status='not_found'}; continue}
    Push-Location -LiteralPath $projectPath
    $previousErrorAction=$ErrorActionPreference
    try {
      $ErrorActionPreference='Continue'
      $cliFlag=if($provider -eq 'agy'){'--help'}else{'--version'}
      $output = if($cliPath -match '\.(?:js|mjs|cjs)$'){ & $node.Source $cliPath $cliFlag 2>$null }else{ & $cliPath $cliFlag 2>$null }
      $results[$provider]=@{status=if($LASTEXITCODE -eq 0){'verified'}else{'execution_failed'}; version=if($provider -eq 'agy'){$null}else{($output -join ' ').Trim()}}
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
