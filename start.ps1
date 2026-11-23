param([switch]$Native)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object Windows.Forms.Form
$form.Text = 'Agent Room'
$form.ClientSize = [Drawing.Size]::new(550, 171)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

function Add-Control($type, $label, $x, $y, $width, $height) {
    $control = New-Object "Windows.Forms.$type"
    $control.Text = $label
    $control.SetBounds($x, $y, $width, $height)
    $form.Controls.Add($control)
    return $control
}

$null = Add-Control Label '1. Codex and Claude Code project folder' 16 17 510 22
$project = Add-Control TextBox '' 16 45 410 24
$choose = Add-Control Button 'Browse...' 437 43 96 29
$install = Add-Control Button '2. Set up and open Agent Room' 16 88 270 32
$status = Add-Control Label 'This adds Agent Room to the selected project.' 16 134 520 25
$install.Enabled = $false
$project.add_TextChanged({ $install.Enabled = -not [string]::IsNullOrWhiteSpace($project.Text) })
$lastProject=Join-Path $PSScriptRoot 'local/project.txt'
if(Test-Path -LiteralPath $lastProject){$project.Text=(Get-Content -LiteralPath $lastProject -Raw).Trim()}
$form.AcceptButton=$install
$choose.add_Click({
    $picker = New-Object Windows.Forms.FolderBrowserDialog
    try {
        if ($picker.ShowDialog($form) -eq 'OK') { $project.Text = $picker.SelectedPath }
    } finally { $picker.Dispose() }
})

$expectedVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'VERSION') -Raw).Trim()
function Get-RoomHub {
    try {
        $state = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/state' -TimeoutSec 1
        if ($state.PSObject.Properties['rooms'] -and $state.PSObject.Properties['members'] -and $state.PSObject.Properties['deliveries']) { return $state }
    } catch { }
}
function Test-RoomHub {
    return (Get-RoomHub).version -eq $expectedVersion
}

$install.add_Click({
    $install.Enabled = $false
    $status.Text = 'Preparing project...'
    $form.Refresh()
    try {
        $node = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $node) { throw 'Install Node.js 24 or later, then reopen Agent Room.' }
        & (Join-Path $PSScriptRoot 'setup.ps1') -Project $project.Text.Trim() -Apply -SelectProject | Out-Null
        $hubPath = Join-Path $PSScriptRoot 'hub.cjs'
        $running = Get-RoomHub
        if ($running -and $running.version -ne $expectedVersion) {
            $escapedHub = [regex]::Escape($hubPath)
            $matching = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
                Where-Object CommandLine -Match ('\s+"' + $escapedHub + '"\s*\z'))
            if ($matching.Count -ne 1) {
                throw 'An older Agent Room hub is running. Close the old hub before opening this version.'
            }
            $oldHub = Get-Process -Id $matching[0].ProcessId
            if (-not $oldHub.HasExited) { $oldHub.Kill() }
            if (-not $oldHub.WaitForExit(5000)) { throw 'The older Agent Room hub did not exit.' }
        }
        if (-not (Test-RoomHub)) {
            $hub = Start-Process -FilePath $node.Source -ArgumentList ('"' + $hubPath + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
            for ($attempt = 0; $attempt -lt 10 -and -not (Test-RoomHub); $attempt++) {
                if ($hub.HasExited) { break }
                Start-Sleep -Milliseconds 200
            }
            if (-not (Test-RoomHub)) { throw 'Could not start Agent Room. Check whether port 4317 is in use.' }
        }
        if($Native){
            $nativePath=Join-Path $PSScriptRoot 'native-chat.ps1'
            Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -STA -ExecutionPolicy Bypass -File "'+$nativePath+'"') -WindowStyle Hidden
        }else{
            $appBrowser=@(
                (Get-Command msedge.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
                (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe' -ErrorAction SilentlyContinue).'(default)',
                "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
                "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
                (Get-Command chrome.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
                (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue).'(default)',
                "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
                "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
            ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
            $appProfile=Join-Path $PSScriptRoot 'local\app-window'
            if($appBrowser){Start-Process -FilePath $appBrowser -ArgumentList ('--app=http://127.0.0.1:4317 --user-data-dir="'+$appProfile+'" --no-first-run --no-default-browser-check --window-size=1440,900')}
            else{Start-Process 'http://127.0.0.1:4317'}
        }
        $form.Close()
    } catch {
        $status.Text = 'Setup needs attention.'
        [void][Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, 'Agent Room')
    } finally { $install.Enabled = -not [string]::IsNullOrWhiteSpace($project.Text) }
})
[void]$form.ShowDialog()
