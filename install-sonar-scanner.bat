@echo off
echo ================================================
echo Installing SonarScanner CLI for JavaScript
echo ================================================
echo.

REM Download sonar-scanner CLI
echo Downloading sonar-scanner-cli...
curl -L https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-6.2.1.4610-windows-x64.zip -o sonar-scanner.zip

echo.
echo Extracting...
powershell -command "Expand-Archive -Path sonar-scanner.zip -DestinationPath . -Force"

echo.
echo Renaming folder...
ren sonar-scanner-6.2.1.4610-windows-x64 sonar-scanner

echo.
echo Cleaning up...
del sonar-scanner.zip

echo.
echo ================================================
echo Installation Complete!
echo ================================================
echo.
echo Add to PATH (run in PowerShell as Admin):
echo [Environment]::SetEnvironmentVariable("Path", $env:Path + ";%CD%\sonar-scanner\bin", [EnvironmentVariableTarget]::Machine)
echo.
echo Or manually add: %CD%\sonar-scanner\bin
echo.
pause
