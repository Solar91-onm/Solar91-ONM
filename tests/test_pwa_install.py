"""Installable-portal guarantees: the manifest and the offline service worker.

The photo-intelligence UI tests were removed with the frontend bundle they
exercised; the photo API keeps its own tests (test_photo_live_api.py,
test_photo_paging.py, test_photo_webp_pipeline.py).
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_pwa_manifest_shortcut_and_service_worker_cache_nothing_private():
    manifest = json.loads((ROOT / "frontend/static/pwa/manifest.webmanifest").read_text(encoding="utf-8"))
    assert manifest["start_url"] == "/" and manifest["scope"] == "/" and manifest["display"] == "standalone"
    assert "SOLAR 91" in manifest["name"]
    for icon in manifest["icons"] + [i for s in manifest["shortcuts"] for i in s["icons"]]:
        # /static/pwa/... is served from frontend/static/pwa/...
        assert (ROOT / "frontend" / "static" / icon["src"][len("/static/"):]).is_file(), icon["src"]
    # Every shortcut must point at a page the portal actually has.
    assert [s["url"] for s in manifest["shortcuts"]] == ["/#/calendar"]
    sw = (ROOT / "frontend/static/pwa/sw.js").read_text(encoding="utf-8")
    # the worker only answers failed page navigations with an offline page: no Cache API, no API or photo responses kept
    assert "caches." not in sw and "cache.put" not in sw.lower()
    assert "request.mode === 'navigate'" in sw
