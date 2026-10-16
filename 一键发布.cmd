@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release-launcher.ps1" %*
set "result=%errorlevel%"
echo.
if not defined XIANQIJI_RELEASE_NO_PAUSE pause
exit /b %result%
