"""The session Back/Forward helper is shipped with the portal page and parses."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def test_session_nav_script_is_loaded_last_and_parses():
    index = (ROOT / "frontend/templates/index.html").read_text(encoding="utf-8")
    assert "/static/js/44-session-nav.js" in index
    assert index.index("/static/js/44-session-nav.js") > index.index("/static/js/43-issue-upload.js")
    run = subprocess.run(["node", "--check", "frontend/static/js/44-session-nav.js"], cwd=ROOT, capture_output=True, text=True, timeout=10)
    assert run.returncode == 0, run.stderr
