from __future__ import annotations

import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.core.config import get_settings


def main() -> int:
    settings = get_settings()
    if not settings.storage_configured:
        print("ERROR: Supabase Storage configuration is incomplete.")
        return 2

    base = settings.supabase_url.rstrip("/") + "/storage/v1"
    bucket = settings.supabase_storage_bucket
    headers = {
        "Authorization": f"Bearer {settings.supabase_service_role_key}",
        "apikey": settings.supabase_service_role_key or "",
        "Content-Type": "application/json",
    }

    try:
        with httpx.Client(timeout=20.0) as client:
            check = client.get(f"{base}/bucket/{bucket}", headers=headers)
            if check.status_code == 200:
                payload = check.json() if check.content else {}
                if payload.get("public") is True:
                    print(f"ERROR: Storage bucket '{bucket}' exists but is public. Make it private in Supabase Storage.")
                    return 4
                print(f"OK: private Supabase Storage bucket '{bucket}' is ready.")
                return 0
            if check.status_code in {400, 404}:
                print(
                    f"ERROR: Required Storage bucket '{bucket}' was not found. "
                    "Verify the existing bucket manually; startup will not create or recreate it."
                )
                return 5
            print(f"ERROR: Could not verify Supabase Storage bucket (HTTP {check.status_code}).")
            return 3

    except httpx.HTTPError as exc:
        print(f"ERROR: Supabase Storage connection failed ({type(exc).__name__}).")
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
