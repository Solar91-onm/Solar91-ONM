"""Print this checkout's deployment identity for comparison with the live service.

    python scripts/asset_version.py
    curl https://<your-service>/health/version

If "frontend_bundle" differs, the live service is not serving this checkout's JS/CSS.
If "commit" differs from `git rev-parse HEAD`, Render has not deployed this commit.
Reads only local files; no network access and no credentials.
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.core.assets import bundle_version  # noqa: E402


def main() -> int:
    try:
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=10).stdout.strip() or None
        dirty = bool(subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, timeout=10).stdout.strip())
    except (OSError, subprocess.SubprocessError):
        commit, dirty = None, None
    print(json.dumps({"frontend_bundle": bundle_version(), "commit": commit, "uncommitted_changes": dirty}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
