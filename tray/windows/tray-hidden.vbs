' Starts the ATEM Logger tray icon with no console window.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & dir & "\atem-logger-tray.ps1""", 0, False
