@echo off
setlocal
cd /d "%~dp0"
taskkill /F /IM ChalzTracker.exe >nul 2>&1
set "CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo .NET Framework C# compiler was not found at "%CSC%".
  if /I not "%~1"=="--no-pause" pause
  exit /b 1
)
"%CSC%" /nologo /target:winexe /optimize+ /win32icon:"assets\favicon.ico" /win32manifest:"app.manifest" /out:"ChalzTracker.exe" "ChalzTracker.cs"
if errorlevel 1 (
  echo Failed to build ChalzTracker.exe.
  if /I not "%~1"=="--no-pause" pause
  exit /b 1
)
echo Successfully built ChalzTracker.exe!
endlocal
