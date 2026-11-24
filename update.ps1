param(
    [Parameter(Mandatory)][ValidatePattern('^v\d+\.\d+\.\d+$')][string]$Tag,
    [Parameter(Mandatory)][int]$HubId,
    [Parameter(Mandatory)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$stage = Join-Path ([IO.Path]::GetTempPath()) ('agent-room-update-' + [guid]::NewGuid())
$files = @('hub.cjs','db.cjs','limits.cjs','updater.cjs','bridge.cjs','codex-ipc.cjs','managed-codex.cjs','index.html','setup.ps1','start.ps1','update.ps1','Start Agent Room.cmd','README.md','LICENSE','SECURITY.md','CHANGELOG.md','VERSION','smoke-test.cjs','native-chat.ps1','remote-sync.cjs','REMOTE-SETUP.md','HANDOFF.md','bind-desktop.cjs','handoff.cjs')
$applied = [Collections.Generic.List[string]]::new()
$restart = $false
$failed = $false
$newHub = $null
$keepBackup = $false
$oldVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'VERSION') -Raw).Trim()

function Start-RoomHub {
    Start-Process -FilePath $NodePath -ArgumentList ('"' + (Join-Path $PSScriptRoot 'hub.cjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
}

function Wait-RoomHub($process, [string]$expectedVersion) {
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline -and -not $process.HasExited) {
        try {
            $state = Invoke-RestMethod -Uri ($hubConfig.url + '/state') -TimeoutSec 2
            if ($state.version -eq $expectedVersion -and $state.PSObject.Properties['rooms'] -and -not $process.HasExited) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}
try {
    $hub = Get-Process -Id $HubId
    $zip = Join-Path $stage 'update.zip'
    $unpacked = Join-Path $stage 'unpacked'
    $backup = Join-Path $stage 'backup'
    [void][IO.Directory]::CreateDirectory($backup)
    Write-Output '업데이트 패키지를 내려받는 중...'
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/lemoncube7/agent-room-local/releases/download/$Tag/Agent-Room-$Tag-Windows.zip" -OutFile $zip -TimeoutSec 60
    Write-Output '업데이트 패키지를 검증하는 중...'
    Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
    $payload = Join-Path $unpacked 'Agent-Room'
    if ((Get-Content -LiteralPath (Join-Path $payload 'VERSION') -Raw).Trim() -ne $Tag.Substring(1)) { throw '내려받은 릴리스 버전이 일치하지 않습니다.' }
    $payloadFiles = @(Get-ChildItem -LiteralPath $payload -File | Select-Object -ExpandProperty Name)
    $files = @($files + $payloadFiles | Select-Object -Unique)
    foreach ($file in $files) {
        if (-not (Test-Path -LiteralPath (Join-Path $payload $file) -PathType Leaf)) { throw "업데이트 파일이 없습니다: $file" }
        $current = Join-Path $PSScriptRoot $file
        if (Test-Path -LiteralPath $current) { Copy-Item -LiteralPath $current -Destination (Join-Path $backup $file) }
    }
    $hubConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'local/hub.json') -Raw | ConvertFrom-Json
    if ($hubConfig.url -ne 'http://127.0.0.1:4317') { throw '예상하지 못한 Agent Room 주소입니다.' }
    Write-Output 'Agent Room 허브 종료를 기다리는 중...'
    $shutdownDeadline = (Get-Date).AddSeconds(330)
    $announced = $false
    while ($true) {
        try {
            Invoke-RestMethod -Method Post -Uri ($hubConfig.url + '/shutdown_for_update') -Headers @{Authorization='Bearer ' + $hubConfig.token} -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
            $restart = $true
            break
        } catch {
            if ($_.Exception.Response -eq $null -or [int]$_.Exception.Response.StatusCode -ne 409 -or (Get-Date) -gt $shutdownDeadline) { throw }
            if (-not $announced) { Write-Output '에이전트 답변이 마무리되는 대로 자동 설치됩니다. 새 메시지는 보존됩니다.'; $announced = $true }
            Start-Sleep -Seconds 2
        }
    }
    if (-not $hub.WaitForExit(15000)) { throw 'Agent Room 종료 시간이 초과되어 파일을 교체하지 않았습니다.' }
    Write-Output '새 버전 파일을 설치하는 중...'
    foreach ($file in $files) {
        $applied.Add($file)
        Copy-Item -LiteralPath (Join-Path $payload $file) -Destination (Join-Path $PSScriptRoot $file) -Force
    }
    try {
        $projectFile = Join-Path $PSScriptRoot 'local/project.txt'
        $savedProject = if (Test-Path -LiteralPath $projectFile) { (Get-Content -LiteralPath $projectFile -Raw).Trim() } else { $PSScriptRoot }
        if (-not $savedProject -or -not (Test-Path -LiteralPath $savedProject -PathType Container)) { $savedProject = $PSScriptRoot }
        & (Join-Path $PSScriptRoot 'setup.ps1') -Project $savedProject -Apply -SelectProject -Global | Out-Null
    } catch { }
    Write-Output '업데이트된 Agent Room 허브를 시작하고 확인하는 중...'
    $newHub = Start-RoomHub
    if (-not (Wait-RoomHub $newHub ($Tag.Substring(1)))) {
        throw "Agent Room $Tag 응답을 확인하지 못했습니다."
    }
    Write-Output "Agent Room $Tag 실행 중입니다."
} catch {
    $failed = $true
    Write-Output ('업데이트 실패 (Update failed): ' + $_.Exception.Message)
    if ($restart) {
        try {
            if ($newHub -and -not $newHub.HasExited) {
                Stop-Process -InputObject $newHub -Force
                if (-not $newHub.WaitForExit(10000)) { throw 'Updated hub did not exit.' }
            }
            if (-not $hub.HasExited -and -not $hub.WaitForExit(20000)) { throw 'Previous hub is still closing.' }
            foreach ($file in $applied) {
                $current = Join-Path $PSScriptRoot $file
                $original = Join-Path $backup $file
                if (Test-Path -LiteralPath $original) { Copy-Item -LiteralPath $original -Destination $current -Force }
                elseif (Test-Path -LiteralPath $current) { Remove-Item -LiteralPath $current }
            }
            $oldHub = Start-RoomHub
            if (-not (Wait-RoomHub $oldHub $oldVersion)) { throw "Previous version $oldVersion did not become healthy." }
            Write-Output "Previous Agent Room version $oldVersion is running."
        } catch {
            $keepBackup = $true
            Write-Output ('Rollback failed: ' + $_.Exception.Message)
            Write-Output "Previous application files are backed up at $backup"
        }
    }
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\agent-room-update-'
    if (-not $keepBackup -and $resolvedStage.StartsWith($tempPrefix,[StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStage)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
if($failed){exit 1}
