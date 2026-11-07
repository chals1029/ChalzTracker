@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node.js and reopen this launcher.
  pause
  exit /b 1
)
node.exe server.js --open
if errorlevel 1 (
  echo The tracker stopped with an error.
  pause
)
endlocal
