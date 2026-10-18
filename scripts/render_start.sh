#!/usr/bin/env sh
set -eu

# The app binds Render's port first, then checks configuration and private Storage.
# Database migrations are deliberately excluded from automatic startup.
exec uvicorn app.main:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --proxy-headers \
  --forwarded-allow-ips="*"