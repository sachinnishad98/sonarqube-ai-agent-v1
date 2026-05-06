@echo off
echo ================================================
echo Checking SonarQube Server Status
echo ================================================
echo.

curl -s http://localhost:9000/api/system/status >nul 2>&1

if %errorlevel% equ 0 (
    echo ✅ SonarQube is running!
    echo.
    curl -s http://localhost:9000/api/system/status
) else (
    echo ❌ SonarQube is NOT running!
    echo.
    echo Starting SonarQube...
    echo.
    cd /d "D:\SonarQube\sonarqube-26.4.0.121862\bin\windows-x86-64"
    start "" StartSonar.bat
    echo.
    echo ⏳ Wait 2-3 minutes for SonarQube to start...
    echo Then check: http://localhost:9000
)

echo.
echo ================================================
pause
