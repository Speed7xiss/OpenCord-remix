@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Dependencies are not installed. Run install.bat first.
  pause
  exit /b 1
)
call npm start
if errorlevel 1 (
  echo.
  echo Failed to start OpenCord.
  pause
  exit /b 1
)
pause
