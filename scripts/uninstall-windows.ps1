# ATEM Logger - stop it and remove it from Startup. Settings (%USERPROFILE%\.atem-logger)
# and EDL files are left in place; delete the app folder yourself if you want it gone.
& (Join-Path $PSScriptRoot 'windows\stop-logger.ps1')
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'ATEM Logger.lnk'
if (Test-Path $shortcut) { Remove-Item $shortcut -Force }
[Environment]::SetEnvironmentVariable('ATEM_LOGGER_PORT', $null, 'User')
Get-NetFirewallRule -DisplayName 'ATEM Logger' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
Write-Host 'ATEM Logger removed from Startup. Settings kept in %USERPROFILE%\.atem-logger'
