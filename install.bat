@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 LTS was not found.
  echo Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
node -e "const major=Number(process.versions.node.split('.')[0]); if(major<24) process.exit(1)"
if errorlevel 1 (
  echo Node.js 24 or newer is required.
  pause
  exit /b 1
)
if not exist .env copy .env.example .env >nul
call npm install
if errorlevel 1 goto :error
call npm run build
if errorlevel 1 goto :error
echo.
echo Installation complete. Run start.bat.
pause
exit /b 0
:error
echo.
echo Installation failed.
pause
exit /b 1
