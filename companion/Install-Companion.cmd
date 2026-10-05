@echo off
rem MediaGrab Companion installer launcher. Double-click, or run from a terminal.
rem Works from any folder (including paths with spaces). Extra arguments are passed to Install-Companion.ps1.
setlocal
set "HERE=%~dp0"
if not exist "%HERE%Install-Companion.ps1" (
  echo.
  echo ERROR: "%HERE%Install-Companion.ps1" is missing. Re-extract the whole MediaGrab ZIP.
  echo.
  pause
  exit /b 2
)
echo.
echo Starting MediaGrab Companion installer...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%Install-Companion.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo INSTALL FAILED ^(exit code %RC%^). Read the red text above, or run Diagnose-Companion.cmd.
) else (
  echo Done.
)
if /i not "%MEDIAGRAB_NOPAUSE%"=="1" pause
endlocal & exit /b %RC%
