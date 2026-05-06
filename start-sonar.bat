@echo off
echo ================================================
echo Starting SonarQube Server
echo ================================================
echo.

cd /d "D:\SonarQube\sonarqube-26.4.0.121862\bin\windows-x86-64"

echo Location: %CD%
echo.
echo Starting SonarQube... (This will take 2-3 minutes)
echo Console will show startup logs...
echo.
echo When you see "SonarQube is operational", open:
echo http://localhost:9000
echo.
echo Login: admin / admin
echo.
echo Press Ctrl+C to stop SonarQube
echo ================================================
echo.

call StartSonar.bat
