@echo off
cd /d "%~dp0"
echo Starting My AI Chat...
echo.
echo First launch may take 1-2 min to compile Rust backend.
echo The app window will open automatically when ready.
echo.
call npm run tauri dev
pause