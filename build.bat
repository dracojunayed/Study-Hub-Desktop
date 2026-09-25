@echo off
REM Build Study Hub 1.0.0 for Windows
echo Building Study Hub...
where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & pause & exit /b 1)
call npm install || (pause & exit /b 1)
call npm run build || (pause & exit /b 1)
echo.
echo Build complete. Check the dist folder.
pause
