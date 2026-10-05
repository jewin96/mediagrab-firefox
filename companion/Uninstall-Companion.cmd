@echo off
setlocal
set "HERE=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%Uninstall-Companion.ps1" %*
if /i not "%MEDIAGRAB_NOPAUSE%"=="1" pause
endlocal
