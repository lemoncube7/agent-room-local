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
$choose.add_Click({
    $picker = New-Object Windows.Forms.FolderBrowserDialog
    try {
        if ($picker.ShowDialog($form) -eq 'OK') { $project.Text = $picker.SelectedPath }
    } finally { $picker.Dispose() }
})

function Test-RoomHub {
    try {
        $state = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/state' -TimeoutSec 1
        return $null -ne $state.PSObject.Properties['rooms'] -and
            $null -ne $state.PSObject.Properties['members'] -and
            $null -ne $state.PSObject.Properties['deliveries']
    } catch { return $false }
}

$install.add_Click({
    $install.Enabled = $false
    $status.Text = 'Preparing project...'
    $form.Refresh()
    try {
        $node = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $node) { throw 'Install Node.js 24 or later, then reopen Agent Room.' }
        & (Join-Path $PSScriptRoot 'setup.ps1') -Project $project.Text.Trim() -Apply | Out-Null
        if (-not (Test-RoomHub)) {
            $hubPath = Join-Path $PSScriptRoot 'hub.cjs'
            $hub = Start-Process -FilePath $node.Source -ArgumentList ('"' + $hubPath + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
            for ($attempt = 0; $attempt -lt 10 -and -not (Test-RoomHub); $attempt++) {
                if ($hub.HasExited) { break }
                Start-Sleep -Milliseconds 200
            }
            if (-not (Test-RoomHub)) { throw 'Could not start Agent Room. Check whether port 4317 is in use.' }
        }
        Start-Process 'http://127.0.0.1:4317'
        $status.Text = 'Ready. Create a room and choose which conversation to connect.'
    } catch {
        $status.Text = 'Setup needs attention.'
        [void][Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, 'Agent Room')
    } finally { $install.Enabled = -not [string]::IsNullOrWhiteSpace($project.Text) }
})
[void]$form.ShowDialog()
