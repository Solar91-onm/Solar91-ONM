@echo off
setlocal
cd /d "%~dp0.."
title Solar91 O&M Command Center - Docker
if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo First-time setup: fill .env with your Supabase Auth, database, and Storage settings.
  start "" notepad ".env"
  pause
  exit /b 1
)
where docker >nul 2>nul
if not %ERRORLEVEL%==0 (
  echo Docker Desktop is not installed or docker is not on PATH.
  echo Use launchers\START_SOLAR91_WINDOWS.bat instead, or install Docker Desktop.
  pause
  exit /b 1
)
start "" cmd /c "timeout /t 8 /nobreak >nul & start http://127.0.0.1:8000"
docker compose up --build
