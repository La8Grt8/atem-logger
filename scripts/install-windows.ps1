# ATEM Logger - Windows installer.
# Builds the app and adds a hidden background launcher to your Startup folder,
# so it runs at sign-in with no console window. Re-run any time to update.
$ErrorActionPreference = 'Stop'
$AppDir  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Port    = if ($env:PORT) { $env:PORT } else { '9920' }
$DataDir = Join-Path $env:USERPROFILE '.atem-logger'
$WinDir  = Join-Path $AppDir 'scripts\windows'
$Startup = [Environment]::GetFolderPath('Startup')
$Shortcut = Join-Path $Startup 'ATEM Logger.lnk'

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
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
    Refresh-Path
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host 'Node.js is required (version 20 or newer).' -ForegroundColor Yellow
    Write-Host 'Install the LTS version from https://nodejs.org, then run this installer again.'
    Start-Process 'https://nodejs.org/en/download'
    exit 1
  }
}
$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
  Write-Host "Node.js $(& node -v) is too old - version 20 or newer is required (https://nodejs.org)." -ForegroundColor Yellow
  exit 1
}
Write-Host "Using Node.js $(& node -v)"

# --- Build -----------------------------------------------------------------
Write-Host 'Installing dependencies...'
& npm.cmd ci --include=dev --ignore-scripts --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
Write-Host 'Building...'
& npm.cmd run build --silent
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }

# --- Stop any running copy, then install the Startup launcher ---------------
& (Join-Path $PSScriptRoot 'windows\stop-logger.ps1')
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
[Environment]::SetEnvironmentVariable('ATEM_LOGGER_PORT', $Port, 'User')
$env:ATEM_LOGGER_PORT = $Port

$launcher = Join-Path $WinDir 'launch-hidden.vbs'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($Shortcut)
$lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments = "`"$launcher`""
$lnk.WorkingDirectory = $AppDir
$lnk.Description = 'ATEM Logger (background)'
$lnk.Save()

# Allow other devices on the network to open the control page (needs admin; skipped otherwise).
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  Get-NetFirewallRule -DisplayName 'ATEM Logger' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName 'ATEM Logger' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain | Out-Null
}

# --- Start it now ----------------------------------------------------------
Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList "`"$launcher`""
$ok = $false
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 1
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://localhost:$Port/api/status" | Out-Null; $ok = $true; break } catch { }
}
if (-not $ok) {
  Write-Host "The app didn't respond on port $Port. Check the log: $DataDir\logger.log" -ForegroundColor Yellow
  exit 1
}
Write-Host ''
Write-Host "ATEM Logger is running: http://localhost:$Port" -ForegroundColor Green
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1).IPAddress
if ($ip) { Write-Host "From other devices on the network: http://${ip}:$Port" }
Write-Host "It starts automatically when you sign in. Log: $DataDir\logger.log"
if (-not $isAdmin) {
  Write-Host ''
  Write-Host 'If Windows Firewall asks about "Node.js", tick Private networks and click Allow' -ForegroundColor Yellow
  Write-Host 'so the switcher and other devices can reach the app.'
}
Start-Process "http://localhost:$Port"
