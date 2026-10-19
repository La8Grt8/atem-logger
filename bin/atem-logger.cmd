@echo off
rem `atem-logger` command for Windows - see scripts\windows\atem-logger.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\windows\atem-logger.ps1" %*
