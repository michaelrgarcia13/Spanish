@echo off
echo Starting Spanish Tutor Development Servers...

REM Kill any existing node processes
taskkill /f /im node.exe 2>nul

REM Wait a moment
timeout /t 2 /nobreak >nul

echo Starting Backend Server on port 3000...
start "Backend Server" cmd /k "cd /d \"c:\Spanish App\spanish-kiosk-server\" && npm start"

REM Wait for backend to start
timeout /t 3 /nobreak >nul

echo Starting Frontend Server on port 5173...
start "Frontend Server" cmd /k "cd /d \"c:\Spanish App\spanish-kiosk-react\" && npm run dev"

echo.
echo Servers starting...
echo Backend:  http://localhost:3000
echo Frontend: http://localhost:5173
echo.
echo Press any key to close this window...
pause >nul