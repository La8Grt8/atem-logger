# atem-logger - control the ATEM Logger Windows service.
param([string]$Command = 'status')
$SvcId = 'ATEMLogger'
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$xmlPath = Join-Path $AppDir 'scripts\windows\service\atem-logger-service.xml'
$Port = '9920'; $DataDir = Join-Path $env:USERPROFILE '.atem-logger'
if (Test-Path $xmlPath) {
  [xml]$x = Get-Content $xmlPath
  $p = $x.service.env | Where-Object { $_.name -eq 'PORT' }; if ($p) { $Port = $p.value }
  $d = $x.service.env | Where-Object { $_.name -eq 'DATA_DIR' }; if ($d) { $DataDir = $d.value }
}
$Url = "http://localhost:$Port"

function Get-Api { try { Invoke-RestMethod -TimeoutSec 2 "$Url/api/status" } catch { $null } }
function Wait-State([string]$want) {
  for ($i = 0; $i -lt 40; $i++) {
    $svc = Get-Service $SvcId -ErrorAction SilentlyContinue
    if ($want -eq 'Running' -and $svc.Status -eq 'Running' -and (Get-Api)) { return $true }
    if ($want -eq 'Stopped' -and $svc.Status -eq 'Stopped') { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

$svc = Get-Service $SvcId -ErrorAction SilentlyContinue
if (-not $svc) { Write-Host "ATEM Logger service is not installed. Run 'Install on Windows.bat' first."; exit 1 }

switch ($Command.ToLower()) {
  'status' {
    if ($svc.Status -ne 'Running') { Write-Host "ATEM Logger: $($svc.Status.ToString().ToUpper())"; exit 3 }
    $s = Get-Api
    if (-not $s) { Write-Host 'ATEM Logger: STARTING'; break }
    Write-Host "ATEM Logger: RUNNING (v$($s.version)) - $Url"
    $a = $s.atem; $l = $s.logging
    Write-Host ("  Switcher:  " + $(if ($a.connected) { "connected - $($a.model)" } else { 'NOT connected' }) + " ($($a.ip))")
    Write-Host ("  Logging:   " + $(if ($l.active) { "YES - $($l.title) - $($l.events) switches - $($l.markers) markers" } else { 'no' }))
    if ($l.active) { Write-Host "  EDL file:  $($l.edlFile)" }
    if ($s.update.available) { Write-Host "  Update:    version $($s.update.latest) is available (update from the control page or tray icon)" }
  }
  'start' {
    if ($svc.Status -eq 'Running') { Write-Host "Already running - $Url"; break }
    Start-Service $SvcId; if (Wait-State 'Running') { Write-Host "Started - $Url" } else { Write-Host 'Start requested - check: atem-logger status' }
  }
  'stop' {
    if ($svc.Status -eq 'Stopped') { Write-Host 'Already stopped.'; break }
    $s = Get-Api; if ($s -and $s.logging.active) { Write-Host 'An EDL is being logged - it will be finalized before stopping.' }
    Stop-Service $SvcId; [void](Wait-State 'Stopped'); Write-Host "Stopped. It will start again at the next boot (or run 'atem-logger start')."
  }
  'restart' {
    $s = Get-Api; if ($s -and $s.logging.active) { Write-Host 'An EDL is being logged - it will be finalized before restarting.' }
    Restart-Service $SvcId; if (Wait-State 'Running') { Write-Host "Restarted - $Url" }
  }
  'open'    { Start-Process $Url }
  'logs'    { Get-Content (Join-Path $DataDir 'atem-logger-service.out.log') -Tail 50 -Wait }
  'enable'  { & sc.exe config $SvcId start= auto | Out-Null; if ($LASTEXITCODE -eq 0) { Write-Host 'Will start automatically at boot.' } else { Write-Host 'Run this from an administrator terminal.' } }
  'disable' { & sc.exe config $SvcId start= demand | Out-Null; if ($LASTEXITCODE -eq 0) { Write-Host "Will NOT start at boot (use 'atem-logger start' to run it now)." } else { Write-Host 'Run this from an administrator terminal.' } }
  default {
    Write-Host @"
Usage: atem-logger <command>
  status    Show whether the service is running, switcher connection and logging state
  start     Start the service
  stop      Stop the service (finalizes any EDL in progress)
  restart   Restart the service
  open      Open the control page ($Url)
  logs      Follow the log file
  enable    Start automatically at boot (default)   [administrator terminal]
  disable   Don't start at boot                     [administrator terminal]
"@
  }
}
