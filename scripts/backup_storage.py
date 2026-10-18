#!/usr/bin/env python3
"""Download every object in a Supabase Storage bucket without buffering files."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


PAGE_SIZE = 1000
DOWNLOAD_ATTEMPTS = 3
CHUNK_SIZE = 1024 * 1024


class StorageBackupError(Exception):
    """An error that can be reported without exposing request details."""


def _request_json(url: str, headers: dict[str, str], payload: dict[str, object]) -> object:
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=60) as response:
        return json.load(response)


def _download(
    url: str,
    headers: dict[str, str],
    destination: Path,
) -> int:
    for attempt in range(DOWNLOAD_ATTEMPTS):
        try:
            request = Request(url, headers=headers, method="GET")
            size = 0
            with urlopen(request, timeout=120) as response:
                with destination.open("wb") as output:
                    while chunk := response.read(CHUNK_SIZE):
                        output.write(chunk)
                        size += len(chunk)
            return size
        except (HTTPError, URLError, OSError, TimeoutError):
            destination.unlink(missing_ok=True)
            if attempt + 1 < DOWNLOAD_ATTEMPTS:
                time.sleep(attempt + 1)
    raise StorageBackupError("A storage object could not be downloaded after three attempts.")


def backup_bucket(base_url: str, service_key: str, bucket: str, output_dir: Path) -> tuple[int, int, int]:
    base_url = base_url.rstrip("/")
    encoded_bucket = quote(bucket, safe="")
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
    }
    output_root = output_dir.resolve()
    downloaded_files = 0
    total_bytes = 0
    failed_files = 0
    visited_prefixes: set[str] = set()

    def list_prefix(prefix: str) -> None:
        nonlocal downloaded_files, total_bytes, failed_files
        if prefix in visited_prefixes:
            return
        visited_prefixes.add(prefix)
        offset = 0
        while True:
            list_url = f"{base_url}/storage/v1/object/list/{encoded_bucket}"
            page = _request_json(
                list_url,
                headers,
                {"prefix": prefix, "limit": PAGE_SIZE, "offset": offset},
            )
            if not isinstance(page, list):
                raise StorageBackupError("Storage returned an invalid object listing.")
            for entry in page:
                if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
                    raise StorageBackupError("Storage returned an invalid object listing.")
                name = entry["name"]
                object_path = f"{prefix}{name}"
                if not name or name in {".", ".."}:
                    raise StorageBackupError("Storage returned an unsafe object path.")
                if entry.get("id") is None:
                    list_prefix(f"{object_path}/")
                    continue

                relative_path = Path(*object_path.split("/"))
                destination = (output_root / relative_path).resolve()
                if not destination.is_relative_to(output_root):
                    failed_files += 1
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                encoded_path = "/".join(
                    quote(segment, safe="") for segment in object_path.split("/")
                )
                object_url = (
                    f"{base_url}/storage/v1/object/authenticated/"
                    f"{encoded_bucket}/{encoded_path}"
                )
                try:
                    total_bytes += _download(object_url, headers, destination)
                    downloaded_files += 1
                except StorageBackupError:
                    failed_files += 1

            if len(page) < PAGE_SIZE:
                break
            offset += PAGE_SIZE

    list_prefix("")
    return downloaded_files, total_bytes, failed_files


def main() -> int:
    parser = argparse.ArgumentParser(description="Back up a Supabase Storage bucket.")
    parser.add_argument("--output-dir", type=Path, default=Path("storage-backup"))
    args = parser.parse_args()

    base_url = os.environ.get("SUPABASE_URL", "").strip()
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    bucket = os.environ.get("SUPABASE_STORAGE_BUCKET", "scheduled-om-evidence").strip()
    if not base_url or not service_key or not bucket:
        print(
            "::error::SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and a bucket name are required.",
            file=sys.stderr,
        )
        return 2

    try:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        file_count, total_bytes, failed_count = backup_bucket(
            base_url,
            service_key,
            bucket,
            args.output_dir,
        )
    except (HTTPError, URLError, OSError, TimeoutError, json.JSONDecodeError, StorageBackupError):
        print(
            "::error::Storage backup could not complete because the bucket listing or local file operation failed.",
            file=sys.stderr,
        )
        return 1

    total_mb = total_bytes / (1024 * 1024)
    print(f"Files downloaded: {file_count}; total size: {total_mb:.2f} MB")
    if file_count == 0 and failed_count == 0:
        print("::warning::The storage bucket contains no files.")
    if failed_count:
        print(f"::error::Failed to download {failed_count} storage file(s).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
