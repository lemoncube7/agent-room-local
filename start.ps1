param([switch]$Native, [switch]$Setup, [switch]$Check)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms

$localDir = Join-Path $PSScriptRoot 'local'
$lastProjectFile = Join-Path $localDir 'project.txt'
$recentFile = Join-Path $localDir 'recent-projects.json'
$launcherFile = Join-Path $localDir 'launcher.json'
$expectedVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'VERSION') -Raw).Trim()

function Read-JsonFile($path, $default) {
    if (-not (Test-Path -LiteralPath $path)) { return $default }
    try { return (Get-Content -LiteralPath $path -Raw -Encoding utf8 | ConvertFrom-Json) } catch { return $default }
}

function Save-RecentProject([string]$dir) {
    [void][IO.Directory]::CreateDirectory($localDir)
    $items = @()
    $existing = Read-JsonFile $recentFile @()
    foreach ($p in @($dir) + @($existing)) {
        if ($p -and ($p -is [string])) {
            $trimmed = $p.Trim()
            if ($trimmed -and -not ($items | Where-Object { $_.Equals($trimmed, [StringComparison]::OrdinalIgnoreCase) })) {
                $items += $trimmed
            }
        }
        if ($items.Count -ge 8) { break }
    }
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($recentFile, (ConvertTo-Json -InputObject @($items) -Compress), $utf8)
}

function Save-LauncherConfig([bool]$autoOpen) {
    [void][IO.Directory]::CreateDirectory($localDir)
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($launcherFile, (ConvertTo-Json -InputObject @{ autoOpen = $autoOpen } -Compress), $utf8)
}

function Get-RoomHub {
    try {
        $state = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/state' -TimeoutSec 1
        if ($state.PSObject.Properties['rooms'] -and $state.PSObject.Properties['members'] -and $state.PSObject.Properties['deliveries']) { return $state }
    } catch { }
}

function Test-RoomHub {
    $hub = Get-RoomHub
    return ($null -ne $hub -and $hub.version -eq $expectedVersion)
}

function Open-AgentRoomClient {
    $appBrowser = @(
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
    $appProfile = Join-Path $PSScriptRoot 'local\app-window'
    if ($appBrowser) {
        Start-Process -FilePath $appBrowser -ArgumentList ('--app=http://127.0.0.1:4317 --user-data-dir="' + $appProfile + '" --no-first-run --no-default-browser-check --window-size=1440,900')
    } else {
        Start-Process 'http://127.0.0.1:4317'
    }
}

function Start-AgentRoom([string]$projectDir, [bool]$skipSetupIfConfigured = $false) {
    $resolved = (Resolve-Path -LiteralPath $projectDir).Path
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        throw '선택한 프로젝트 폴더를 찾을 수 없습니다.'
    }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js 24 이상을 먼저 설치한 뒤 Agent Room을 다시 열어 주세요.' }
    $globalCodex = Join-Path $env:USERPROFILE '.codex\config.toml'
    $globalClaude = Join-Path $env:USERPROFILE '.claude.json'
    $hasGlobalMcp = (Test-Path -LiteralPath $globalCodex) -and (Select-String -LiteralPath $globalCodex -Pattern '\[mcp_servers\.(?:agent-room|"agent-room"|''agent-room'')\]' -Quiet) -and (Test-Path -LiteralPath $globalClaude) -and (Select-String -LiteralPath $globalClaude -Pattern '"agent-room"\s*:' -Quiet)
    $needsSetup = -not $skipSetupIfConfigured -or -not $hasGlobalMcp -or -not (
        (Test-Path -LiteralPath (Join-Path $resolved '.codex\config.toml')) -or
        (Test-Path -LiteralPath (Join-Path $resolved '.mcp.json'))
    )
    if ($needsSetup) {
        & (Join-Path $PSScriptRoot 'setup.ps1') -Project $resolved -Apply -SelectProject -Global | Out-Null
    } else {
        [void][IO.Directory]::CreateDirectory($localDir)
        [IO.File]::WriteAllText($lastProjectFile, $resolved)
    }
    Save-RecentProject $resolved

    $hubPath = Join-Path $PSScriptRoot 'hub.cjs'
    $running = Get-RoomHub
    if ($running -and $running.version -ne $expectedVersion) {
        $escapedHub = [regex]::Escape($hubPath)
        $matching = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
            Where-Object CommandLine -Match ('\s+"' + $escapedHub + '"\s*\z'))
        if ($matching.Count -ne 1) {
            throw '이전 버전의 Agent Room 허브가 실행 중입니다. 기존 허브를 닫고 다시 열어 주세요.'
        }
        $oldHub = Get-Process -Id $matching[0].ProcessId
        if (-not $oldHub.HasExited) { $oldHub.Kill() }
        if (-not $oldHub.WaitForExit(5000)) { throw '이전 버전의 Agent Room 허브가 종료되지 않았습니다.' }
    }
    if (-not (Test-RoomHub)) {
        $hub = Start-Process -FilePath $node.Source -ArgumentList ('"' + $hubPath + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
        for ($attempt = 0; $attempt -lt 15 -and -not (Test-RoomHub); $attempt++) {
            if ($hub.HasExited) { break }
            Start-Sleep -Milliseconds 200
        }
        if (-not (Test-RoomHub)) { throw 'Agent Room 허브를 시작하지 못했습니다. 포트 4317 사용 여부를 확인해 주세요.' }
    }
    Open-AgentRoomClient
}

$lastProject = if (Test-Path -LiteralPath $lastProjectFile) { (Get-Content -LiteralPath $lastProjectFile -Raw).Trim() } else { '' }
$launcherCfg = Read-JsonFile $launcherFile ([pscustomobject]@{ autoOpen = $false })

if (-not $Check -and -not $Setup -and $launcherCfg.autoOpen -and $lastProject -and (Test-Path -LiteralPath $lastProject -PathType Container)) {
    try {
        Start-AgentRoom -projectDir $lastProject -skipSetupIfConfigured $true
        return
    } catch {
        # Fall through to launcher UI so the user can inspect or change the project.
    }
}

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Agent Room 시작" Width="590" SizeToContent="Height"
        WindowStartupLocation="CenterScreen" ResizeMode="NoResize"
        Background="#0F1117" Foreground="#E8EAF0" FontFamily="Malgun Gothic, Segoe UI" FontSize="13"
        AllowDrop="True">
  <Border Padding="22,20,22,20">
    <StackPanel>
      <DockPanel Margin="0,0,0,14">
        <TextBlock Text="Agent Room" FontSize="20" FontWeight="SemiBold" Foreground="#E8EAF0"/>
        <TextBlock Name="VersionText" Margin="8,6,0,0" FontSize="12" Foreground="#9AA1B0"/>
        <TextBlock Name="HubBadge" DockPanel.Dock="Right" HorizontalAlignment="Right" VerticalAlignment="Center" FontSize="11" Foreground="#9AA1B0"/>
      </DockPanel>

      <TextBlock Text="작업 프로젝트 폴더" FontWeight="SemiBold" Margin="0,0,0,6" Foreground="#D4DAE6"/>
      <Grid Margin="0,0,0,8">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="8"/>
          <ColumnDefinition Width="96"/>
        </Grid.ColumnDefinitions>
        <ComboBox Name="ProjectBox" Grid.Column="0" IsEditable="True" Height="34" VerticalContentAlignment="Center"
                  Padding="8,4" Background="#1E222D" Foreground="#111526" BorderBrush="#2A2F3B"/>
        <Button Name="BrowseBtn" Grid.Column="2" Content="폴더 찾기..." Height="34"
                Background="#1E222D" Foreground="#E8EAF0" BorderBrush="#384362" Cursor="Hand"/>
      </Grid>
      <TextBlock Text="탐색기에서 폴더를 이 창으로 끌어다 놓아도 됩니다. 실행 후 앱 안에서도 언제든 변경할 수 있어요."
                 FontSize="11.5" Foreground="#9AA1B0" TextWrapping="Wrap" Margin="0,0,0,12"/>

      <CheckBox Name="AutoOpenCheck" Content="다음부터 이 프로젝트로 바로 열기 (시작 창 건너뛰기)"
                Foreground="#D4DAE6" Margin="0,0,0,14"/>

      <Border Background="#161922" BorderBrush="#2A2F3B" BorderThickness="1" CornerRadius="8" Padding="10,8" Margin="0,0,0,14">
        <TextBlock Name="EnvSummary" FontSize="11.5" Foreground="#9AA1B0" TextWrapping="Wrap" Text="실행 환경 확인 중..."/>
      </Border>

      <DockPanel>
        <TextBlock Name="StatusText" VerticalAlignment="Center" Foreground="#9AA1B0" FontSize="12" Text="선택한 프로젝트에 Agent Room을 연결합니다."/>
        <StackPanel Orientation="Horizontal" DockPanel.Dock="Right" HorizontalAlignment="Right">
          <Button Name="CancelBtn" Content="닫기" Width="74" Height="34" Margin="0,0,8,0" IsCancel="True"
                  Background="#1E222D" Foreground="#D4DAE6" BorderBrush="#2A2F3B" Cursor="Hand"/>
          <Button Name="OpenBtn" Content="Agent Room 열기" MinWidth="148" Height="34" Padding="14,0" IsDefault="True"
                  Background="#7C9CFF" Foreground="#0F1117" FontWeight="SemiBold" BorderBrush="#7C9CFF" Cursor="Hand"/>
        </StackPanel>
      </DockPanel>
    </StackPanel>
  </Border>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$ui = @{}
foreach ($name in 'VersionText','HubBadge','ProjectBox','BrowseBtn','AutoOpenCheck','EnvSummary','StatusText','CancelBtn','OpenBtn') {
    $ui[$name] = $window.FindName($name)
    if (-not $ui[$name]) { throw "Missing launcher control: $name" }
}
if ($Check) { 'Launcher window loaded'; return }

$ui.VersionText.Text = "v$expectedVersion"
$ui.HubBadge.Text = if (Test-RoomHub) { '● 허브 실행 중' } else { '○ 허브 대기' }
$ui.AutoOpenCheck.IsChecked = [bool]$launcherCfg.autoOpen

$recent = @()
foreach ($p in @($lastProject) + @(Read-JsonFile $recentFile @())) {
    if ($p -and ($p -is [string]) -and $p.Trim() -and -not ($recent | Where-Object { $_.Equals($p.Trim(), [StringComparison]::OrdinalIgnoreCase) })) {
        $recent += $p.Trim()
    }
}
foreach ($item in $recent) { [void]$ui.ProjectBox.Items.Add($item) }
if ($lastProject) { $ui.ProjectBox.Text = $lastProject }

$nodeInfo = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeText = if ($nodeInfo) { 'Node.js 확인됨' } else { 'Node.js 없음 (24+ 필요)' }
$cliBadges = @($nodeText)
foreach ($pair in @(@('codex','Codex'), @('claude','Claude'), @('agy','Antigravity'))) {
    $found = Get-Command ($pair[0] + '.exe') -ErrorAction SilentlyContinue
    if (-not $found -and $pair[0] -eq 'claude') { $found = Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.local\bin\claude.exe') }
    if (-not $found -and $pair[0] -eq 'agy') { $found = Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe') }
    if (-not $found -and $pair[0] -eq 'codex') { $found = Test-Path -LiteralPath (Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\bin\codex.js') }
    $cliBadges += if ($found) { "$($pair[1]) ✓" } else { "$($pair[1]) 미감지" }
}
$ui.EnvSummary.Text = $cliBadges -join '   ·   '

function Sync-OpenButton {
    $ui.OpenBtn.IsEnabled = -not [string]::IsNullOrWhiteSpace($ui.ProjectBox.Text)
}
Sync-OpenButton
$ui.ProjectBox.AddHandler([Windows.Controls.Primitives.TextBoxBase]::TextChangedEvent, [Windows.RoutedEventHandler]{ Sync-OpenButton })

$window.Add_DragOver({
    param($s, $e)
    if ($e.Data.GetDataPresent([Windows.DataFormats]::FileDrop)) { $e.Effects = [Windows.DragDropEffects]::Copy }
    else { $e.Effects = [Windows.DragDropEffects]::None }
    $e.Handled = $true
})
$window.Add_Drop({
    param($s, $e)
    if ($e.Data.GetDataPresent([Windows.DataFormats]::FileDrop)) {
        $dropped = @($e.Data.GetData([Windows.DataFormats]::FileDrop)) | Select-Object -First 1
        if ($dropped) {
            $dir = if (Test-Path -LiteralPath $dropped -PathType Container) { $dropped } else { Split-Path -Parent $dropped }
            if ($dir) { $ui.ProjectBox.Text = $dir; Sync-OpenButton }
        }
    }
})

$ui.BrowseBtn.Add_Click({
    $picker = New-Object Windows.Forms.FolderBrowserDialog
    $picker.Description = 'Agent Room에서 사용할 프로젝트 폴더를 선택하세요.'
    $picker.ShowNewFolderButton = $true
    $cur = $ui.ProjectBox.Text.Trim()
    if ($cur -and (Test-Path -LiteralPath $cur -PathType Container)) { $picker.SelectedPath = $cur }
    try {
        if ($picker.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) {
            $ui.ProjectBox.Text = $picker.SelectedPath
            Sync-OpenButton
        }
    } finally { $picker.Dispose() }
})

$ui.OpenBtn.Add_Click({
    $ui.OpenBtn.IsEnabled = $false
    $ui.StatusText.Foreground = [Windows.Media.BrushConverter]::new().ConvertFromString('#9AA1B0')
    $ui.StatusText.Text = '프로젝트 설정 및 허브 시작 중...'
    $window.Dispatcher.Invoke([Action]{}, [Windows.Threading.DispatcherPriority]::Render)
    try {
        Save-LauncherConfig ([bool]$ui.AutoOpenCheck.IsChecked)
        Start-AgentRoom -projectDir $ui.ProjectBox.Text.Trim() -skipSetupIfConfigured $false
        $window.Close()
    } catch {
        $ui.StatusText.Foreground = [Windows.Media.BrushConverter]::new().ConvertFromString('#FFB9AD')
        $ui.StatusText.Text = '설정을 확인해 주세요.'
        [void][Windows.MessageBox]::Show($window, $_.Exception.Message, 'Agent Room', 'OK', 'Warning')
    } finally {
        Sync-OpenButton
    }
})

[void]$window.ShowDialog()
