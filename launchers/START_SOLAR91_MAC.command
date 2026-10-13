#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "============================================="
echo "  SOLAR91 O&M COMMAND CENTER - WEB APP"
echo "============================================="

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "First-time setup: .env has been created."
  echo "Add your Supabase URL, anon key, database URL and service-role key, then double-click this launcher again."
  open -e .env || true
  read -r -p "Press Enter to close..."
  exit 1
fi

PYTHON="$(command -v python3 || true)"
if [[ -z "$PYTHON" ]]; then
  echo "Python 3.12 or newer is required."
  read -r -p "Press Enter to close..."
  exit 1
fi

if ! "$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3,12) else 1)'; then
  echo "Python 3.12 or newer is required."
  read -r -p "Press Enter to close..."
  exit 1
fi

if [[ ! -x .venv/bin/python ]]; then
  "$PYTHON" -m venv .venv
fi
source .venv/bin/activate
python -m pip install --disable-pip-version-check -q -r requirements.txt
python scripts/preflight.py
python scripts/ensure_storage.py
( sleep 3; open http://127.0.0.1:8000 ) &
exec python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
