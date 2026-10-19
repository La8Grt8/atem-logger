# Stops an ATEM Logger 1.0 install (Startup-folder launcher + restart loop), if one is running.
# 1.1+ runs as a Windows service and is not touched by this script.
$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
$loops = @($procs | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*run-logger.cmd*' })
$loopIds = $loops | ForEach-Object { $_.ProcessId }
$apps  = @($procs | Where-Object { $_.Name -eq 'node.exe' -and $loopIds -contains $_.ParentProcessId })
foreach ($p in $loops + $apps) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
if ($loops.Count -or $apps.Count) { Write-Host 'Stopped the old (1.0) ATEM Logger launcher.'; Start-Sleep -Seconds 1 }
