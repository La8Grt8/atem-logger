@echo off
rem Keeps ATEM Logger running: restarts it 3 seconds after any exit.
rem Started hidden by launch-hidden.vbs - don't run this directly unless you want a console window.
cd /d "%~dp0..\.."
if defined ATEM_LOGGER_PORT set PORT=%ATEM_LOGGER_PORT%
if not exist "%USERPROFILE%\.atem-logger" mkdir "%USERPROFILE%\.atem-logger"
:loop
node dist\server.js >> "%USERPROFILE%\.atem-logger\logger.log" 2>&1
timeout /t 3 /nobreak >nul
goto loop
