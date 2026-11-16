"""Short-lived cache for Storage bucket usage checks."""
from __future__ import annotations

from threading import Lock
from time import monotonic

from app.storage.service import SupabaseStorage

_CACHE_SECONDS = 180
_cache_lock = Lock()
_cached_key: str | None = None
_cached_at = 0.0
_cached_bytes = 0


def bucket_usage_bytes(storage: SupabaseStorage, *, force_refresh: bool = False) -> int:
    global _cached_at, _cached_bytes, _cached_key
    key = f"{storage.base}/{storage.bucket}"
    with _cache_lock:
        now = monotonic()
        if not force_refresh and _cached_key == key and now - _cached_at < _CACHE_SECONDS:
            return _cached_bytes
        used = storage.usage_bytes()
        _cached_key = key
        _cached_at = now
        _cached_bytes = used
        return used


def clear_bucket_usage_cache() -> None:
    global _cached_at, _cached_bytes, _cached_key
    with _cache_lock:
        _cached_key = None
        _cached_at = 0.0
        _cached_bytes = 0


def adjust_bucket_usage(storage: SupabaseStorage, delta_bytes: int) -> None:
    """Keep the short-lived cached total in step with successful local object changes."""
    global _cached_at, _cached_bytes
    key = f"{storage.base}/{storage.bucket}"
    with _cache_lock:
        if _cached_key == key:
            _cached_bytes = max(0, _cached_bytes + delta_bytes)
            _cached_at = monotonic()
