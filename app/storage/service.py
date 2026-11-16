from __future__ import annotations

from dataclasses import dataclass
from threading import Lock
from urllib.parse import quote

import httpx
from fastapi import HTTPException

from app.core.config import Settings, get_settings


_http_client: httpx.Client | None = None
_http_client_lock = Lock()


def get_storage_http_client() -> httpx.Client:
    """Return the process-wide thread-safe client used for Storage HTTP calls."""
    global _http_client
    with _http_client_lock:
        if _http_client is None or _http_client.is_closed:
            _http_client = httpx.Client(timeout=30.0)
        return _http_client


def close_storage_http_client() -> None:
    """Close the shared Storage client during application shutdown."""
    global _http_client
    with _http_client_lock:
        if _http_client is not None:
            _http_client.close()
            _http_client = None


@dataclass
class StoredObject:
    path: str
    content_type: str
    size: int


class SupabaseStorage:
    """Server-side private Storage adapter.

    Clerk authenticates users; the Supabase service-role key is used only by FastAPI to
    access the private evidence bucket and is never sent to the browser.
    """

    def __init__(self, settings: Settings | None = None):
        self.settings = settings or get_settings()
        if not self.settings.storage_configured:
            raise HTTPException(503, "Supabase Storage is not configured")
        self.base = self.settings.supabase_url.rstrip("/") + "/storage/v1"
        self.bucket = self.settings.supabase_storage_bucket
        self.headers = {
            "Authorization": f"Bearer {self.settings.supabase_service_role_key}",
            "apikey": self.settings.supabase_service_role_key or "",
        }

    def upload(self, path: str, data: bytes, content_type: str) -> StoredObject:
        url = f"{self.base}/object/{quote(self.bucket, safe='')}/{quote(path, safe='/')}"
        headers = {**self.headers, "Content-Type": content_type, "x-upsert": "false"}
        try:
            response = get_storage_http_client().post(url, headers=headers, content=data)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(502, "Could not save photo evidence to Supabase Storage") from exc
        return StoredObject(path=path, content_type=content_type, size=len(data))

    def download(self, path: str) -> tuple[bytes, str]:
        url = f"{self.base}/object/authenticated/{quote(self.bucket, safe='')}/{quote(path, safe='/')}"
        try:
            response = get_storage_http_client().get(url, headers=self.headers)
        except httpx.HTTPError as exc:
            # Timeouts and connection failures are an outage, not missing evidence.
            raise HTTPException(502, "Photo storage is temporarily unavailable. Please try again.") from exc
        if response.status_code in {400, 404}:
            # Supabase Storage answers a missing object with 400 or 404.
            raise HTTPException(404, "Photo evidence was not found")
        if response.status_code >= 400:
            raise HTTPException(502, "Photo storage is temporarily unavailable. Please try again.")
        return response.content, response.headers.get("content-type", "application/octet-stream")

    def remove(self, paths: list[str]) -> None:
        if not paths:
            return
        try:
            self._remove(paths)
        except httpx.HTTPError:
            # Existing workflows treat orphan cleanup as best effort.
            return

    def remove_strict(self, paths: list[str]) -> None:
        if not paths:
            return
        try:
            self._remove(paths)
        except httpx.HTTPError as exc:
            raise HTTPException(502, "Could not remove photo evidence from Supabase Storage") from exc

    def _remove(self, paths: list[str]) -> None:
        url = f"{self.base}/object/{quote(self.bucket, safe='')}"
        response = get_storage_http_client().request(
            "DELETE", url,
            headers={**self.headers, "Content-Type": "application/json"},
            json={"prefixes": paths},
            timeout=20.0,
        )
        response.raise_for_status()

    def usage_bytes(self) -> int:
        """Return the size of all objects in the configured private bucket."""
        url = f"{self.base}/object/list/{quote(self.bucket, safe='')}"
        pending = [""]
        total = 0
        try:
            while pending:
                prefix = pending.pop()
                offset = 0
                while True:
                    response = get_storage_http_client().post(
                        url,
                        headers={**self.headers, "Content-Type": "application/json"},
                        json={"prefix": prefix, "limit": 1000, "offset": offset},
                    )
                    response.raise_for_status()
                    rows = response.json()
                    if not isinstance(rows, list):
                        raise ValueError("Unexpected Storage listing response")
                    for row in rows:
                        if not isinstance(row, dict) or not isinstance(row.get("name"), str):
                            raise ValueError("Unexpected Storage object entry")
                        metadata = row.get("metadata") or {}
                        if row.get("id") is None and not metadata.get("size"):
                            pending.append(prefix + row["name"].strip("/") + "/")
                            continue
                        size = metadata.get("size", row.get("size"))
                        if size is None:
                            raise ValueError("Storage object size is missing")
                        total += int(size)
                    if len(rows) < 1000:
                        break
                    offset += len(rows)
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            raise HTTPException(502, "Could not verify photo storage usage") from exc
        return total

    def object_sizes(self, paths: list[str]) -> dict[str, int]:
        """Return listed sizes for specific object paths without downloading their bytes."""
        requested = set(paths)
        sizes: dict[str, int] = {}
        parents = {path.rpartition("/")[0] + "/" for path in requested if "/" in path}
        url = f"{self.base}/object/list/{quote(self.bucket, safe='')}"
        try:
            for prefix in parents:
                offset = 0
                while True:
                    response = get_storage_http_client().post(
                        url,
                        headers={**self.headers, "Content-Type": "application/json"},
                        json={"prefix": prefix, "limit": 1000, "offset": offset},
                    )
                    response.raise_for_status()
                    rows = response.json()
                    if not isinstance(rows, list):
                        raise ValueError("Unexpected Storage listing response")
                    for row in rows:
                        if not isinstance(row, dict) or not isinstance(row.get("name"), str):
                            raise ValueError("Unexpected Storage object entry")
                        path = prefix + row["name"]
                        metadata = row.get("metadata") or {}
                        size = metadata.get("size", row.get("size"))
                        if path in requested and size is not None:
                            sizes[path] = int(size)
                    if len(rows) < 1000:
                        break
                    offset += len(rows)
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            raise HTTPException(502, "Could not read photo object sizes from Storage") from exc
        return sizes
