param([switch]$Check)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
[xml]$layout = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Title="Agent Room" Width="980" Height="680" MinWidth="660" MinHeight="440" Background="#141929" Foreground="#EAF0FA">
  <Grid Margin="16">
    <Grid.ColumnDefinitions><ColumnDefinition Width="210"/><ColumnDefinition Width="14"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
    <DockPanel Grid.Column="0">
      <StackPanel DockPanel.Dock="Top">
        <TextBlock FontSize="21" FontWeight="SemiBold" Text="Agent Room"/>
        <TextBlock x:Name="Version" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Margin="0,4,0,14"/>
        <TextBox Name="RoomName" MaxLength="70" Margin="0,0,0,5"/>
        <Button Name="AddRoom" Content="방 만들기" Margin="0,0,0,14"/>
      </StackPanel>
      <ListBox Name="Rooms" DisplayMemberPath="name" Background="#202943" Foreground="#EAF0FA"/>
    </DockPanel>
    <Grid Grid.Column="2">
      <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
      <StackPanel Grid.Row="0" Margin="0,0,0,10">
        <TextBlock Name="RoomTitle" FontSize="20" FontWeight="SemiBold"/>
        <TextBlock Name="Members" Margin="0,5,0,5" TextWrapping="Wrap"/>
        <Button Name="Pair" Content="기존 대화 연결 문장 복사" HorizontalAlignment="Left" Padding="9,4"/>
      </StackPanel>
      <ScrollViewer Name="History" Grid.Row="1" VerticalScrollBarVisibility="Auto" Background="#1A2236">
        <StackPanel Name="Messages" Margin="12"/>
      </ScrollViewer>
      <DockPanel Grid.Row="2" Margin="0,10,0,0" LastChildFill="True">
        <Button Name="Send" DockPanel.Dock="Right" Content="보내기" MinWidth="84" Margin="8,0,0,0"/>
        <TextBox Name="Draft" MaxLength="8000" MinHeight="35" MaxHeight="160" AcceptsReturn="True" VerticalScrollBarVisibility="Auto" TextWrapping="Wrap" VerticalContentAlignment="Center"/>
      </DockPanel>
      <TextBlock Name="Status" Grid.Row="3" Foreground="#FFC797" Margin="0,5,0,0" TextWrapping="Wrap"/>
    </Grid>
  </Grid>
</Window>
"@
$reader = New-Object System.Xml.XmlNodeReader $layout
$window = [Windows.Markup.XamlReader]::Load($reader)
$ui = @{}
foreach($item in 'Version','RoomName','AddRoom','Rooms','RoomTitle','Members','Pair','History','Messages','Send','Draft','Status'){
    $ui[$item] = $window.FindName($item)
    if(-not $ui[$item]){throw "Missing control: $item"}
}
if($Check){'Native Windows chat window loaded';return}
$base='http://127.0.0.1:4317'
$script:state=$null
$script:room=$null
$script:renderKey=''
$script:lastMessage=$null
$script:lastRoom=$null
function Request-Control($payload){
    Invoke-RestMethod -Uri "$base/control" -Method Post -Headers @{Origin=$base} -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($payload|ConvertTo-Json -Compress))) -TimeoutSec 3
}
function Make-Message($label,$body,$color,$own){
    $box=New-Object Windows.Controls.Border
    $box.Margin=[Windows.Thickness]::new(0,0,0,9)
    $box.Padding=[Windows.Thickness]::new(12,8,12,8)
    $box.CornerRadius=[Windows.CornerRadius]::new(8)
    $box.Background=[Windows.Media.BrushConverter]::new().ConvertFromString($color)
    $box.HorizontalAlignment=if($own){'Right'}else{'Left'}
    $box.MaxWidth=[Math]::Max(280,$ui.History.ActualWidth-45)
    $lines=New-Object Windows.Controls.StackPanel
    $title=New-Object Windows.Controls.TextBlock
    $title.Text=$label
    $title.FontWeight=[Windows.FontWeights]::SemiBold
    $text=New-Object Windows.Controls.TextBlock
    $text.Text=$body
    $text.TextWrapping='Wrap'
    $text.Margin=[Windows.Thickness]::new(0,4,0,0)
    [void]$lines.Children.Add($title)
    [void]$lines.Children.Add($text)
    $box.Child=$lines
    [void]$ui.Messages.Children.Add($box)
}
function Render-Room {
    if(-not $script:state){return}
    $selected=$script:state.rooms|Where-Object id -eq $script:room|Select-Object -First 1
    $ui.RoomTitle.Text=if($selected){$selected.name}else{'채팅방을 선택하세요'}
    $ui.Pair.IsEnabled=$null -ne $selected
    $ui.Send.IsEnabled=$null -ne $selected
    $people=@($script:state.members|Where-Object {$_.room -eq $script:room -and $_.state -ne 'disconnected'})
    $ui.Members.Text=($people|ForEach-Object {if($_.busy){$_.name+' · 응답 생성 중'}else{$_.name+' · '+$_.state}}) -join '   '
    $history=@($script:state.messages|Where-Object room -eq $script:room)
    $latest=($history|Select-Object -Last 1).seq
    $key=($history.Count.ToString()+'/'+$latest+'/'+$script:room)
    if($key -eq $script:renderKey){return}
    $script:renderKey=$key
    $ui.Messages.Children.Clear()
    foreach($message in $history){
        $own=$message.author -eq ('human:'+$script:room)
        $provider=($people|Where-Object id -eq $message.author|Select-Object -First 1).provider
        $color=if($own){'#224344'}elseif($provider -eq 'claude'){'#473039'}elseif($provider -eq 'agy'){'#283D29'}else{'#273555'}
        Make-Message $message.name $message.body $color $own
    }
    if($script:lastRoom -ne $script:room -or $script:lastMessage -ne $latest){$ui.History.ScrollToBottom()}
    $script:lastRoom=$script:room
    $script:lastMessage=$latest
}
function Refresh-Room {
    try {
        $script:state=Invoke-RestMethod -Uri "$base/state" -TimeoutSec 2
        $ui.Version.Text="v$($script:state.version)"
        $available=@($script:state.rooms)
        if((($ui.Rooms.ItemsSource|ForEach-Object {$_.id+':'+$_.name}) -join '|') -ne (($available|ForEach-Object {$_.id+':'+$_.name}) -join '|')){
            $wanted=$script:room
            $ui.Rooms.ItemsSource=$available
            $ui.Rooms.SelectedItem=$available|Where-Object id -eq $wanted|Select-Object -First 1
            if(-not $ui.Rooms.SelectedItem -and $available.Count){$ui.Rooms.SelectedIndex=0}
        }
        Render-Room
    } catch { $ui.Status.Text='로컬 채팅 연결을 확인하세요.' }
}
$ui.Rooms.Add_SelectionChanged({
    $previous=$script:room
    $script:room=$ui.Rooms.SelectedItem.id
    if($previous -ne $script:room){$ui.Draft.Clear()}
    Render-Room
})
$ui.AddRoom.Add_Click({
    if(-not $ui.RoomName.Text.Trim()){return}
    try{
        $result=Request-Control @{action='create';name=$ui.RoomName.Text}
        $script:room=($result.rooms|Select-Object -Last 1).id
        $ui.RoomName.Clear()
        Refresh-Room
    }catch{$ui.Status.Text=$_.Exception.Message}
})
$ui.Pair.Add_Click({
    if(-not $script:room){return}
    try{
        $result=Request-Control @{action='room_code';room=$script:room}
        [Windows.Clipboard]::SetText('Agent Room MCP의 join_room_code 도구로 '+$result.code+' 코드에 참가 요청해 줘.')
        $ui.Status.Text='연결 문장을 복사했어요. 기존 대화에 붙여 넣으세요.'
    }catch{$ui.Status.Text=$_.Exception.Message}
})
$ui.Send.Add_Click({
    if(-not $script:room -or -not $ui.Draft.Text.Trim()){return}
    try{
        $null=Request-Control @{action='user_message';room=$script:room;text=$ui.Draft.Text}
        $ui.Draft.Clear()
        $ui.Status.Text=''
        Refresh-Room
    }catch{$ui.Status.Text=$_.Exception.Message}
})
$ui.Draft.Add_KeyDown({param($sender,$event)
    if($event.Key -eq 'Enter' -and [Windows.Input.Keyboard]::Modifiers -eq 'None'){
        $event.Handled=$true
        $ui.Send.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Primitives.ButtonBase]::ClickEvent))
    }
})
$timer=New-Object Windows.Threading.DispatcherTimer
$timer.Interval=[TimeSpan]::FromSeconds(1.5)
$timer.Add_Tick({Refresh-Room})
$window.Add_Closed({$timer.Stop()})
Refresh-Room
$timer.Start()
[void]$window.ShowDialog()
