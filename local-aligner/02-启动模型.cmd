@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manager.ps1" -Action Start
set "taskExit=%errorlevel%"
pause
exit /b %taskExit%
