# Stops a running ATEM Logger (the restart loop first, then the app itself).
$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
$loops = $procs | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*run-logger.cmd*' }
$apps  = $procs | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*dist\server.js*' -and $_.CommandLine -notlike '*mcp*' }
foreach ($p in @($loops) + @($apps)) {
  if ($p) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}
if ($loops -or $apps) { Write-Host 'Stopped the running ATEM Logger.'; Start-Sleep -Seconds 1 }
