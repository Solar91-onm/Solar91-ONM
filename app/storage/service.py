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
            response.raise_for_status()
            return response.content, response.headers.get("content-type", "application/octet-stream")
        except httpx.HTTPError as exc:
            raise HTTPException(404, "Photo evidence was not found") from exc

    def remove(self, paths: list[str]) -> None:
        if not paths:
            return
        url = f"{self.base}/object/{quote(self.bucket, safe='')}"
        try:
            response = get_storage_http_client().request(
                "DELETE", url,
                headers={**self.headers, "Content-Type": "application/json"},
                json={"prefixes": paths},
                timeout=20.0,
            )
            response.raise_for_status()
        except httpx.HTTPError:
            # Metadata removal still proceeds; a later maintenance job can clean orphaned objects.
            return
