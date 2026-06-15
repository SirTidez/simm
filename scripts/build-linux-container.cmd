@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%build-linux-container.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo SIMM Linux Docker build failed with exit code %EXIT_CODE%.
  echo Run this command from a terminal to keep the full log visible:
  echo   scripts\build-linux-container.cmd %*
  echo.
  if /I not "%CI%"=="true" pause
)

exit /b %EXIT_CODE%
