@echo off
setlocal
start "" powershell.exe -NoProfile -WindowStyle Hidden -STA -File "%~dp0tools\server-manager\ServerManager.ps1" %*
