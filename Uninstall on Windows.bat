@echo off
rem Double-click to stop ATEM Logger and remove it from Startup.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-windows.ps1"
echo.
pause
