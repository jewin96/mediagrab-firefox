@echo off
rem Prints a full diagnosis of the MediaGrab Companion installation. Extra arguments go to the PowerShell script.
setlocal
set "HERE=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%Diagnose-Companion.ps1" %*
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
