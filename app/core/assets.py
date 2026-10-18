"""Content-hashed static asset URLs and build identity.

Every ``/static/...`` URL in the rendered portal page gets ``?v=<12-char content hash>`` at request
time, so a deploy that changes a JS/CSS file always changes its URL and no browser keeps an old copy.
Hand-maintained ``?v=`` strings are no longer needed (they were easy to forget, which left users on
stale CSS for up to an hour after a deploy).

Hashes are cached per (path, mtime, size), so a changed file is re-hashed automatically, including
under ``uvicorn --reload`` during development.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import re
from threading import Lock

STATIC_ROOT = (Path(__file__).resolve().parents[2] / "frontend" / "static").resolve()
STARTED_AT = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
_ASSET_URL = re.compile(r"""(?P<path>/static/[A-Za-z0-9_./-]+?\.(?:js|css|png|svg|webp|jpg|jpeg|ico|webmanifest|xlsx))(?:\?v=[^"'\s>]*)?(?=["'\s>])""")
_cache: dict[str, tuple[int, int, str]] = {}
_lock = Lock()


def _resolve(relative: str) -> Path | None:
    candidate = (STATIC_ROOT / relative.lstrip("/")).resolve()
    if STATIC_ROOT not in candidate.parents or not candidate.is_file():
        return None
    return candidate


def asset_hash(relative: str) -> str | None:
    """Short content hash for a file under frontend/static (None if missing or outside it)."""
    path = _resolve(relative)
    if path is None:
        return None
    stat = path.stat()
    key = path.as_posix()
    with _lock:
        cached = _cache.get(key)
        if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
            return cached[2]
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    with _lock:
        _cache[key] = (stat.st_mtime_ns, stat.st_size, digest)
    return digest


def version_static_urls(html: str) -> str:
    """Replace each /static/... URL (with or without an old ?v=) by its content-hashed form."""
    def stamp(match: re.Match) -> str:
        path = match.group("path")
        digest = asset_hash(path[len("/static/"):])
        return f"{path}?v={digest}" if digest else match.group(0)
    return _ASSET_URL.sub(stamp, html)


def bundle_version() -> str:
    """One hash over every JS and CSS file: equal values mean the same frontend code is being served."""
    combined = hashlib.sha256()
    for folder in ("js", "css"):
        for path in sorted((STATIC_ROOT / folder).glob("*.*")):
            if path.suffix in {".js", ".css"}:
                combined.update(path.name.encode())
                combined.update((asset_hash(f"{folder}/{path.name}") or "").encode())
    return combined.hexdigest()[:12]


def build_info(app_version: str, environment: str) -> dict[str, str | None]:
    """Safe deployment identity: no hostnames, credentials, or instance details."""
    commit = os.getenv("RENDER_GIT_COMMIT") or os.getenv("GIT_COMMIT") or None
    return {
        "app_version": app_version,
        "environment": environment,
        "commit": commit,
        "commit_short": commit[:7] if commit else None,
        "branch": os.getenv("RENDER_GIT_BRANCH") or None,
        "frontend_bundle": bundle_version(),
        "started_at": STARTED_AT,
    }
