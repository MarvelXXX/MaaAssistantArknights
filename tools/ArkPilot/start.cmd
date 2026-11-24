@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>&1 || (echo Install Node.js 22 or newer, then reopen this file. & pause & exit /b 1)
if not exist "node_modules\.package-lock.json" (
  call npm.cmd ci --ignore-scripts --no-audit --no-fund
  if errorlevel 1 (pause & exit /b 1)
)
node server.mjs --open
if errorlevel 1 pause
