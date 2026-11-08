@echo off
setlocal
cd /d "%~dp0"
if "%~2"=="" (
  echo Usage: build-setup.cmd path\to\release.zip path\to\setup.exe
  exit /b 1
)
if not exist "%~f1" (
  echo Release ZIP not found: %~f1
  exit /b 1
)
set "CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo .NET Framework C# compiler not found: %CSC%
  exit /b 1
)
"%CSC%" /nologo /codepage:65001 /target:winexe /optimize+ /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /win32icon:"assets\favicon.ico" /win32manifest:"app.manifest" "/resource:%~f1,package.zip" "/resource:%CD%\assets\favicon.ico,setup.ico" "/out:%~f2" "Installer.cs"
if errorlevel 1 exit /b 1
echo Setup built: %~f2
endlocal
