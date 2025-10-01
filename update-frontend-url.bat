@echo off
echo Updating frontend with backend URL...
echo.
set /p BACKEND_URL="Enter your backend URL (e.g. https://your-app.onrender.com): "
echo.
echo Updating index.html with backend URL: %BACKEND_URL%
echo.

REM Create a temporary file with the updated content
powershell -Command "(Get-Content 'spanish-kiosk-react\index.html') -replace '// window.__API_BASE__ = \"https://YOUR-BACKEND.example.com\";', 'window.__API_BASE__ = \"%BACKEND_URL%\";' | Set-Content 'spanish-kiosk-react\index.html'"

echo Frontend updated! Now you can build and deploy it.
echo.
echo Next steps:
echo 1. cd spanish-kiosk-react
echo 2. npm run build
echo 3. Deploy the dist/ folder to Vercel
pause
