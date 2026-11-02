"""Content-hashed static asset URLs and build identity.

Every ``/assets/...`` and ``/static/...`` URL in the rendered portal page gets ``?v=<12-char content
hash>`` at request time, so a deploy that changes a JS/CSS file always changes its URL and no browser
keeps an old copy. Hand-maintained ``?v=`` strings are no longer needed (they were easy to forget,
which left users on stale CSS for up to an hour after a deploy).

Two roots are served:

* ``/assets/`` → ``assets/`` — the portal design system (the application frontend).
* ``/static/`` → ``frontend/static/`` — the sign-in panel stylesheet, brand marks and PWA files.

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

_BASE = Path(__file__).resolve().parents[2]
STATIC_ROOT = (_BASE / "frontend" / "static").resolve()
PORTAL_ROOT = (_BASE / "assets").resolve()

# URL prefix → directory it is served from.
ASSET_ROOTS: dict[str, Path] = {"/static/": STATIC_ROOT, "/assets/": PORTAL_ROOT}

STARTED_AT = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
_ASSET_URL = re.compile(
    r"""(?P<path>/(?:static|assets)/[A-Za-z0-9_./-]+?"""
    r"""\.(?:js|css|png|svg|webp|jpg|jpeg|ico|webmanifest|xlsx))"""
    r"""(?:\?v=[^"'\s>]*)?(?=["'\s>])"""
)
_cache: dict[str, tuple[int, int, str]] = {}
_lock = Lock()


def _split_prefix(url_path: str) -> tuple[Path, str] | None:
    """Map ``/assets/css/tokens.css`` to (PORTAL_ROOT, "css/tokens.css")."""
    for prefix, root in ASSET_ROOTS.items():
        if url_path.startswith(prefix):
            return root, url_path[len(prefix):]
    return None


def _resolve(relative: str, root: Path = STATIC_ROOT) -> Path | None:
    candidate = (root / relative.lstrip("/")).resolve()
    if root not in candidate.parents or not candidate.is_file():
        return None
    return candidate


def asset_hash(relative: str, root: Path = STATIC_ROOT) -> str | None:
    """Short content hash for a file under an asset root (None if missing or outside it)."""
    path = _resolve(relative, root)
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


def asset_hash_for_url(url_path: str) -> str | None:
    """Content hash for a served URL path such as ``/assets/js/app.js``."""
    split = _split_prefix(url_path)
    if split is None:
        return None
    root, relative = split
    return asset_hash(relative, root)


def version_static_urls(html: str) -> str:
    """Replace each /assets/... and /static/... URL (with or without an old ?v=) by its hashed form."""
    def stamp(match: re.Match) -> str:
        path = match.group("path")
        digest = asset_hash_for_url(path)
        return f"{path}?v={digest}" if digest else match.group(0)
    return _ASSET_URL.sub(stamp, html)


def bundle_version() -> str:
    """One hash over every frontend JS and CSS file: equal values mean the same code is being served."""
    combined = hashlib.sha256()
    for root in (PORTAL_ROOT, STATIC_ROOT):
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if path.is_file() and path.suffix in {".js", ".css"}:
                combined.update(path.relative_to(root).as_posix().encode())
                combined.update((asset_hash(path.relative_to(root).as_posix(), root) or "").encode())
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
