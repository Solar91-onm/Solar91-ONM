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
            if check.status_code not in {400, 404}:
                print(f"ERROR: Could not verify Supabase Storage bucket ({check.status_code}): {check.text[:300]}")
                return 3

            create = client.post(
                f"{base}/bucket",
                headers=headers,
                json={
                    "id": bucket,
                    "name": bucket,
                    "public": False,
                    "file_size_limit": settings.max_upload_mb * 1024 * 1024,
                    "allowed_mime_types": ["image/jpeg", "image/png", "image/webp"],
                },
            )
            if create.status_code not in {200, 201}:
                # A race or provider variation may report an already-existing bucket as 400/409.
                retry = client.get(f"{base}/bucket/{bucket}", headers=headers)
                if retry.status_code == 200 and (retry.json() or {}).get("public") is not True:
                    print(f"OK: private Supabase Storage bucket '{bucket}' is ready.")
                    return 0
                print(f"ERROR: Could not create private Storage bucket '{bucket}' ({create.status_code}): {create.text[:300]}")
                return 3
            print(f"OK: created private Supabase Storage bucket '{bucket}'.")
            return 0
    except httpx.HTTPError as exc:
        print(f"ERROR: Supabase Storage connection failed: {exc}")
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
