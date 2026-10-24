# ATEM Logger - remove the Windows service, tray icon and `atem-logger` command.
# Settings (%USERPROFILE%\.atem-logger) and EDL files are kept; delete the app folder yourself if you want it gone.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $p = Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Wait -PassThru
  exit $p.ExitCode
}
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$SvcExe = Join-Path $AppDir 'scripts\windows\service\atem-logger-service.exe'

if (Get-Service 'ATEMLogger' -ErrorAction SilentlyContinue) {
  if (Test-Path $SvcExe) { & $SvcExe stop | Out-Null; Start-Sleep -Seconds 2; & $SvcExe uninstall | Out-Null }
  else { & sc.exe stop ATEMLogger | Out-Null; Start-Sleep -Seconds 2; & sc.exe delete ATEMLogger | Out-Null }
  Write-Host 'Removed the ATEM Logger service.'
}
& (Join-Path $PSScriptRoot 'windows\stop-logger.ps1')

# Tray icon
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*atem-logger-tray.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
foreach ($f in @((Join-Path ([Environment]::GetFolderPath('CommonStartup')) 'ATEM Logger Tray.lnk'), (Join-Path ([Environment]::GetFolderPath('Startup')) 'ATEM Logger.lnk'))) {
  if (Test-Path $f) { Remove-Item $f -Force }
}

# Command on PATH, firewall rule, 1.0 leftovers
$binDir = Join-Path $AppDir 'bin'
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
[Environment]::SetEnvironmentVariable('Path', (($machinePath -split ';') | Where-Object { $_ -and $_ -ne $binDir }) -join ';', 'Machine')
Get-NetFirewallRule -DisplayName 'ATEM Logger' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
[Environment]::SetEnvironmentVariable('ATEM_LOGGER_PORT', $null, 'User')

Write-Host 'ATEM Logger removed. Settings kept in %USERPROFILE%\.atem-logger'
