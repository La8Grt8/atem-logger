# ATEM Logger system-tray icon: shows the service state and starts/stops/restarts it.
# Started at sign-in (hidden) by tray-hidden.vbs.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$ErrorActionPreference = 'SilentlyContinue'

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\ATEMLoggerTray', [ref]$created)
if (-not $created) { exit 0 }   # already running

$SvcId  = 'ATEMLogger'
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Port   = '9920'
$xmlPath = Join-Path $AppDir 'scripts\windows\service\atem-logger-service.xml'
if (Test-Path $xmlPath) { [xml]$x = Get-Content $xmlPath; $p = $x.service.env | Where-Object { $_.name -eq 'PORT' }; if ($p) { $Port = $p.value } }
$Url = "http://localhost:$Port"
$RegKey = 'HKCU:\Software\ATEMLogger'
$startVersion = (Get-Content (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json).version

function New-DotIcon([System.Drawing.Color]$color, [bool]$filled) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $pen = New-Object System.Drawing.Pen $color, 2
  $g.DrawEllipse($pen, 1, 1, 13, 13)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $color), $(if ($filled) { 4 } else { 5 }), $(if ($filled) { 4 } else { 5 }), $(if ($filled) { 8 } else { 6 }), $(if ($filled) { 8 } else { 6 }))
  $g.Dispose()
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$icons = @{
  stopped = New-DotIcon ([System.Drawing.Color]::Gray) $false
  waiting = New-DotIcon ([System.Drawing.Color]::Orange) $false
  ready   = New-DotIcon ([System.Drawing.Color]::FromArgb(31, 157, 99)) $false
  logging = New-DotIcon ([System.Drawing.Color]::FromArgb(229, 72, 77)) $true
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icons.stopped
$tray.Text = 'ATEM Logger'
$tray.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$tray.ContextMenuStrip = $menu
$script:state = $null
$script:svcStatus = 'Stopped'
$script:busy = $false
$script:prompting = $false

function Get-State {
  $svc = Get-Service $SvcId
  $script:svcStatus = if ($svc) { $svc.Status.ToString() } else { 'NotInstalled' }
  $script:state = $null
  if ($script:svcStatus -eq 'Running') {
    try { $script:state = Invoke-RestMethod -TimeoutSec 1 "$Url/api/status" } catch { }
  }
}

function Add-Item([string]$text, [scriptblock]$onClick, [bool]$enabled = $true) {
  $i = New-Object System.Windows.Forms.ToolStripMenuItem $text
  $i.Enabled = $enabled
  if ($onClick) { $i.add_Click($onClick) }
  [void]$menu.Items.Add($i)
}
function Add-Sep { [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) }

function Invoke-Service([string]$verb) {
  $s = $script:state
  if ($verb -ne 'Start' -and $s -and $s.logging.active) {
    $r = [System.Windows.Forms.MessageBox]::Show("The EDL for `"$($s.logging.title)`" is being logged. It will be finalized.`n`n$verb the service anyway?", 'ATEM Logger', 'YesNo', 'Warning')
    if ($r -ne 'Yes') { return }
  }
  $script:busy = $true
  try {
    switch ($verb) { 'Start' { Start-Service $SvcId -ErrorAction Stop } 'Stop' { Stop-Service $SvcId -ErrorAction Stop } 'Restart' { Restart-Service $SvcId -ErrorAction Stop } }
  } catch {
    [System.Windows.Forms.MessageBox]::Show("Couldn't $($verb.ToLower()) the ATEM Logger service:`n$($_.Exception.Message)", 'ATEM Logger', 'OK', 'Error') | Out-Null
  }
  $script:busy = $false
  Update-Tray
}

function Install-Update {
  try { Invoke-RestMethod -Method Post -TimeoutSec 5 -ContentType 'application/json' -Body '{}' "$Url/api/update/install" | Out-Null }
  catch {
    $msg = $_.ErrorDetails.Message; try { $msg = ($msg | ConvertFrom-Json).error } catch { }
    [System.Windows.Forms.MessageBox]::Show("Couldn't update ATEM Logger:`n$msg", 'ATEM Logger', 'OK', 'Error') | Out-Null
  }
}

function Show-UpdatePrompt {
  $s = $script:state; if (-not $s) { return }
  $u = $s.update
  $text = "ATEM Logger $($u.latest) is available (you have $($u.current)).`n`nUpdating takes about a minute and restarts the logger.`n`nUpdate now?"
  $r = [System.Windows.Forms.MessageBox]::Show($text, 'ATEM Logger update', 'YesNo', 'Information')
  if ($r -eq 'Yes') { Install-Update }
  else { New-Item -Path $RegKey -Force | Out-Null; Set-ItemProperty -Path $RegKey -Name LaterVersion -Value $u.latest }
}

function Build-Menu {
  $menu.Items.Clear()
  $s = $script:state
  $title = if ($script:busy) { 'ATEM Logger - working...' } elseif ($script:svcStatus -ne 'Running') { "ATEM Logger - $($script:svcStatus)" } elseif (-not $s) { 'ATEM Logger - Starting...' } else { 'ATEM Logger - Running' }
  Add-Item $title $null $false
  if ($s) {
    Add-Item $(if ($s.atem.connected) { "Switcher: $($s.atem.model) ($($s.atem.ip))" } else { "Switcher: not connected ($($s.atem.ip))" }) $null $false
    Add-Item $(if ($s.logging.active) { "Logging: $($s.logging.title) - $($s.logging.events) switches - $($s.logging.markers) markers" } else { 'Logging: off' }) $null $false
  }
  Add-Sep
  if ($s -and ($s.update.state -eq 'updating' -or $s.update.state -eq 'restarting')) { Add-Item $s.update.message $null $false }
  elseif ($s -and $s.update.available) {
    if ($s.update.canUpdate) { Add-Item "Update to $($s.update.latest)..." { Show-UpdatePrompt } }
    if ($s.update.releaseUrl) { Add-Item "What's new in $($s.update.latest)" { Start-Process $script:state.update.releaseUrl } }
  }
  Add-Item 'Open Control Page' { Start-Process $Url } ([bool]$s)
  if ($s -and $s.logging.active) {
    Add-Item 'Add Marker' { try { Invoke-RestMethod -Method Post -TimeoutSec 3 -ContentType 'application/json' -Body '{"note":"Marker (tray)"}' "$Url/api/marker" | Out-Null } catch { } }
  }
  Add-Sep
  $running = $script:svcStatus -eq 'Running'
  Add-Item 'Start Service' { Invoke-Service 'Start' } (-not $running -and -not $script:busy)
  Add-Item 'Stop Service' { Invoke-Service 'Stop' } ($running -and -not $script:busy)
  Add-Item 'Restart Service' { Invoke-Service 'Restart' } ($running -and -not $script:busy)
  Add-Sep
  if ($s) { Add-Item "Version $($s.version)" $null $false }
  Add-Item 'Quit Tray Icon' { $tray.Visible = $false; $timer.Stop(); [System.Windows.Forms.Application]::Exit() }
}

function Update-Tray {
  Get-State
  $s = $script:state
  if ($script:svcStatus -ne 'Running') { $tray.Icon = $icons.stopped; $tip = 'ATEM Logger - service stopped' }
  elseif (-not $s) { $tray.Icon = $icons.waiting; $tip = 'ATEM Logger - starting' }
  elseif ($s.logging.active) { $tray.Icon = $icons.logging; $tip = "ATEM Logger - logging $($s.logging.title) ($($s.logging.events))" }
  elseif ($s.atem.connected) { $tray.Icon = $icons.ready; $tip = 'ATEM Logger - running, switcher connected' }
  else { $tray.Icon = $icons.waiting; $tip = 'ATEM Logger - running, switcher NOT connected' }
  $tray.Text = $tip.Substring(0, [Math]::Min(63, $tip.Length))

  if ($s) {
    # After an app update, relaunch this tray script so it runs the new version too.
    $diskVersion = (Get-Content (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json).version
    if ($s.version -eq $diskVersion -and $diskVersion -ne $startVersion) {
      $tray.Visible = $false
      $mutex.ReleaseMutex()
      Start-Process wscript.exe -ArgumentList "`"$(Join-Path $PSScriptRoot 'tray-hidden.vbs')`""
      [System.Windows.Forms.Application]::Exit(); return
    }
    # Ask once per new version, never while logging.
    $later = (Get-ItemProperty -Path $RegKey -Name LaterVersion -ErrorAction SilentlyContinue).LaterVersion
    if ($s.update.available -and $s.update.canUpdate -and -not $s.logging.active -and $s.update.state -eq 'idle' -and $later -ne $s.update.latest -and -not $script:prompting) {
      $script:prompting = $true
      $tray.ShowBalloonTip(8000, 'ATEM Logger update', "Version $($s.update.latest) is available.", 'Info')
      Show-UpdatePrompt
      $script:prompting = $false
    }
  }
}

$menu.add_Opening({ Build-Menu })
$tray.add_DoubleClick({ Start-Process $Url })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ if (-not $script:prompting) { Update-Tray } })
$timer.Start()
Update-Tray
Build-Menu
[System.Windows.Forms.Application]::Run()
$tray.Dispose()
