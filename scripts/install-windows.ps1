# ATEM Logger - Windows installer.
# Builds the app and installs it as a Windows Service ("ATEM Logger") that starts at boot with
# nobody signed in, plus the `atem-logger` command and a system-tray icon. Re-run any time to update.
# Needs administrator rights (Windows will ask).
param([string]$ForUser = $env:USERNAME, [string]$ForProfile = $env:USERPROFILE)
$ErrorActionPreference = 'Stop'

# --- Elevate (keeping the original user's profile for settings) ---------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'Asking Windows for administrator rights to install the service...'
  $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -ForUser `"$ForUser`" -ForProfile `"$ForProfile`""
  $p = Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait -PassThru
  exit $p.ExitCode
}

$AppDir   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Port     = if ($env:PORT) { $env:PORT } else { '9920' }
$DataDir  = Join-Path $ForProfile '.atem-logger'
$SvcDir   = Join-Path $AppDir 'scripts\windows\service'
$SvcExe   = Join-Path $SvcDir 'atem-logger-service.exe'
$SvcXml   = Join-Path $SvcDir 'atem-logger-service.xml'
$SvcId    = 'ATEMLogger'
$WinSWUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe'
$WinSWSha = 'B5066B7BBDFBA1293E5D15CDA3CAAEA88FBEAB35BD5B38C41C913D492AADFC4F'

Write-Host '== ATEM Logger installer ==' -ForegroundColor Cyan
Write-Host "App folder: $AppDir"
Set-Location $AppDir

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

# --- Node.js ---------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Node.js not found - installing the LTS version with winget...'
    winget install --id OpenJS.NodeJS.LTS -e --silent --scope machine --accept-package-agreements --accept-source-agreements
    Refresh-Path
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js is required (version 20 or newer).' -ForegroundColor Yellow
    Write-Host 'Install the LTS version from https://nodejs.org, then run this installer again.'
    Start-Process 'https://nodejs.org/en/download'
    exit 1
  }
}
$NodeExe = (Get-Command node).Source
$nodeMajor = [int](& $NodeExe -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { Write-Host "Node.js $(& $NodeExe -v) is too old - version 20 or newer is required." -ForegroundColor Yellow; exit 1 }
if ($NodeExe -like "$ForProfile*") {
  Write-Host 'Note: Node.js is installed inside your user folder. That works, but a system-wide install' -ForegroundColor Yellow
  Write-Host '(the installer from nodejs.org) is more reliable for a service.' -ForegroundColor Yellow
}
Write-Host "Using Node.js $(& $NodeExe -v) at $NodeExe"

# --- Build -----------------------------------------------------------------
Write-Host 'Installing dependencies...'
& npm.cmd ci --include=dev --ignore-scripts --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
Write-Host 'Building...'
& npm.cmd run build --silent
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }

# --- Retire the 1.0 Startup-folder launcher, if present --------------------
& (Join-Path $PSScriptRoot 'windows\stop-logger.ps1')
$oldShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'ATEM Logger.lnk'
if (Test-Path $oldShortcut) { Remove-Item $oldShortcut -Force }
[Environment]::SetEnvironmentVariable('ATEM_LOGGER_PORT', $null, 'User')

# --- Service wrapper (WinSW) -----------------------------------------------
New-Item -ItemType Directory -Force -Path $SvcDir, $DataDir | Out-Null
if (-not (Test-Path $SvcExe) -or (Get-FileHash $SvcExe -Algorithm SHA256).Hash -ne $WinSWSha) {
  Write-Host 'Downloading the service wrapper (WinSW 2.12)...'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri $WinSWUrl -OutFile $SvcExe
  if ((Get-FileHash $SvcExe -Algorithm SHA256).Hash -ne $WinSWSha) { Remove-Item $SvcExe -Force; throw 'Service wrapper download failed its checksum - try again.' }
}

$esc = { param($s) [Security.SecurityElement]::Escape($s) }
$xml = @"
<service>
  <id>$SvcId</id>
  <name>ATEM Logger</name>
  <description>Logs every ATEM switcher cut to an EDL for DaVinci Resolve. Control page: http://localhost:$Port</description>
  <executable>$(& $esc $NodeExe)</executable>
  <arguments>"$(& $esc (Join-Path $AppDir 'dist\server.js'))"</arguments>
  <workingdirectory>$(& $esc $AppDir)</workingdirectory>
  <env name="PORT" value="$Port"/>
  <env name="DATA_DIR" value="$(& $esc $DataDir)"/>
  <env name="ATEM_LOGGER_DEFAULT_OUTPUT" value="$(& $esc (Join-Path $ForProfile 'Videos\ATEM EDLs'))"/>
  <startmode>Automatic</startmode>
  <delayedAutoStart>false</delayedAutoStart>
  <onfailure action="restart" delay="5 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>$(& $esc $DataDir)</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>3</keepFiles></log>
</service>
"@
Set-Content -Path $SvcXml -Value $xml -Encoding UTF8

# Reinstall cleanly if it already exists.
if (Get-Service $SvcId -ErrorAction SilentlyContinue) {
  & $SvcExe stop | Out-Null
  Start-Sleep -Seconds 2
  & $SvcExe uninstall | Out-Null
  Start-Sleep -Seconds 1
}
& $SvcExe install
if ($LASTEXITCODE -ne 0) { throw 'Installing the Windows service failed' }

# Let signed-in users start/stop/query the service without admin rights (CLI + tray icon).
$sd = (& sc.exe sdshow $SvcId | Where-Object { $_ -match 'D:' }).Trim()
if ($sd -and $sd -notmatch '\(A;;RPWPLOCRRC;;;IU\)') {
  $sd = $sd -replace 'D:', 'D:(A;;RPWPLOCRRC;;;IU)'
  & sc.exe sdset $SvcId $sd | Out-Null
}

# Firewall: let other devices on the network open the control page.
Get-NetFirewallRule -DisplayName 'ATEM Logger' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'ATEM Logger' -Direction Inbound -Program $NodeExe -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain | Out-Null

& $SvcExe start | Out-Null

# --- `atem-logger` command on the PATH -------------------------------------
$binDir = Join-Path $AppDir 'bin'
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if (($machinePath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable('Path', ($machinePath.TrimEnd(';') + ';' + $binDir), 'Machine')
}

# --- Tray icon: start at sign-in for every user, and now for this user -----
$trayVbs = Join-Path $AppDir 'tray\windows\tray-hidden.vbs'
$commonStartup = [Environment]::GetFolderPath('CommonStartup')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $commonStartup 'ATEM Logger Tray.lnk'))
$lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments = "`"$trayVbs`""
$lnk.WorkingDirectory = $AppDir
$lnk.Description = 'ATEM Logger tray icon'
$lnk.Save()
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*atem-logger-tray.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
# explorer.exe launches it un-elevated, as the signed-in user.
Start-Process explorer.exe -ArgumentList "`"$trayVbs`""

# --- Wait for it -----------------------------------------------------------
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://localhost:$Port/api/status" | Out-Null; $ok = $true; break } catch { }
}
if (-not $ok) {
  Write-Host "The service didn't respond on port $Port. Check the logs in $DataDir" -ForegroundColor Yellow
  Read-Host 'Press Enter to close'
  exit 1
}
Write-Host ''
Write-Host "ATEM Logger is running as a Windows service: http://localhost:$Port" -ForegroundColor Green
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1).IPAddress
if ($ip) { Write-Host "From other devices on the network: http://${ip}:$Port" }
Write-Host 'It starts automatically when Windows boots - no sign-in needed.'
Write-Host 'Control it from the tray icon, or in a new terminal window:'
Write-Host '  atem-logger status | start | stop | restart | open | logs'
Start-Process "http://localhost:$Port"
Read-Host 'Press Enter to close'
