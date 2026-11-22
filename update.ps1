param(
    [Parameter(Mandatory)][ValidatePattern('^v\d+\.\d+\.\d+$')][string]$Tag,
    [Parameter(Mandatory)][int]$HubId,
    [Parameter(Mandatory)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$stage = Join-Path ([IO.Path]::GetTempPath()) ('agent-room-update-' + [guid]::NewGuid())
$hub = Get-Process -Id $HubId
$files = @('hub.cjs','bridge.cjs','codex-ipc.cjs','managed-codex.cjs','index.html','setup.ps1','start.ps1','update.ps1','Start Agent Room.cmd','README.md','VERSION','smoke-test.cjs')
$applied = [Collections.Generic.List[string]]::new()
$restart = $false
try {
    $zip = Join-Path $stage 'update.zip'
    $unpacked = Join-Path $stage 'unpacked'
    $backup = Join-Path $stage 'backup'
    [void][IO.Directory]::CreateDirectory($backup)
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/lemoncube7/agent-room-local/releases/download/$Tag/Agent-Room-$Tag-Windows.zip" -OutFile $zip -TimeoutSec 60
    Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
    $payload = Join-Path $unpacked 'Agent-Room'
    if ((Get-Content -LiteralPath (Join-Path $payload 'VERSION') -Raw).Trim() -ne $Tag.Substring(1)) { throw 'The downloaded release version does not match.' }
    foreach ($file in $files) {
        if (-not (Test-Path -LiteralPath (Join-Path $payload $file) -PathType Leaf)) { throw "Missing update file: $file" }
        $current = Join-Path $PSScriptRoot $file
        if (Test-Path -LiteralPath $current) { Copy-Item -LiteralPath $current -Destination (Join-Path $backup $file) }
    }
    $hubConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'local/hub.json') -Raw | ConvertFrom-Json
    if ($hubConfig.url -ne 'http://127.0.0.1:4317') { throw 'Unexpected Agent Room address.' }
    Invoke-RestMethod -Method Post -Uri ($hubConfig.url + '/shutdown_for_update') -Headers @{Authorization='Bearer ' + $hubConfig.token} -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
    if (-not $hub.WaitForExit(15000)) { throw 'Agent Room is still closing. No files were replaced.' }
    $restart = $true
    foreach ($file in $files) {
        $applied.Add($file)
        Copy-Item -LiteralPath (Join-Path $payload $file) -Destination (Join-Path $PSScriptRoot $file) -Force
    }
} catch {
    foreach ($file in $applied) {
        $current = Join-Path $PSScriptRoot $file
        $original = Join-Path $backup $file
        if (Test-Path -LiteralPath $original) { Copy-Item -LiteralPath $original -Destination $current -Force }
        elseif (Test-Path -LiteralPath $current) { Remove-Item -LiteralPath $current }
    }
    [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Agent Room update')
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\agent-room-update-'
    if ($resolvedStage.StartsWith($tempPrefix,[StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStage)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
if ($restart) {
    Start-Process -FilePath $NodePath -ArgumentList ('"' + (Join-Path $PSScriptRoot 'hub.cjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
}
