@echo off
setlocal
cd /d "%~dp0.."
title Solar91 O&M Command Center

echo =============================================
echo   SOLAR91 O^&M COMMAND CENTER - WEB APP
echo =============================================
echo.

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo First-time setup: .env has been created.
  echo Enter your Supabase URL, anon key, database URL and service-role key, then run this launcher again.
  start "" notepad ".env"
  pause
  exit /b 1
)

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  set "PY=py -3"
) else (
  where python >nul 2>nul
  if not %ERRORLEVEL%==0 (
    echo Python 3.12 or newer is required. Install Python, then double-click this file again.
    pause
    exit /b 1
  )
  set "PY=python"
)

%PY% -c "import sys; raise SystemExit(0 if sys.version_info >= (3,12) else 1)"
if errorlevel 1 (
  echo Python 3.12 or newer is required.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating private Python environment...
  %PY% -m venv .venv
  if errorlevel 1 goto :fail
)

call ".venv\Scripts\activate.bat"
python -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 goto :fail

python scripts\preflight.py
if errorlevel 1 (
  echo.
  echo Fix the settings shown above in .env, then start Solar91 again.
  pause
  exit /b 1
)

python scripts\ensure_storage.py
if errorlevel 1 goto :fail
echo.
echo Database migrations and optional sample data are never applied automatically.
echo Review and apply approved SQL manually after backing up the target database.
echo Solar91 is starting at http://127.0.0.1:8000
echo Keep this window open while using the app. Press Ctrl+C to stop it.
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:8000"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
exit /b %ERRORLEVEL%

:fail
echo.
echo Solar91 could not start. Review the error above.
pause
exit /b 1
