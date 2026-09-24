@echo off
cd /d "%~dp0"

REM Prepend cargo's own directory. Newly added PATH entries do NOT reach
REM already-running explorer / terminal processes, which is why double-clicking
REM used to fail with "cargo metadata: program not found".
REM NOTE: keep this file pure ASCII. Non-ASCII comments get decoded under the
REM       console code page and their bytes can be read as command separators,
REM       which breaks the script before it reaches npm.
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

where cargo >nul 2>nul
if errorlevel 1 (
  echo [WARN] cargo not found in PATH.
  echo        Looked in: %USERPROFILE%\.cargo\bin
  echo        If it is missing, install Rust from https://rustup.rs
  echo.
)

echo Starting My AI Chat...
echo.
echo First launch may take 1-2 min to compile Rust backend.
echo The app window will open automatically when ready.
echo.
call npm run tauri dev
pause
