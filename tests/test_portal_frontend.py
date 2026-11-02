"""Regression tests for the portal frontend served at /.

The portal design replaced the previous layered frontend bundle. These tests pin
what that swap must keep true:

  * the page is served at / behind the unchanged sign-in gate
  * every stylesheet and script it references exists and parses
  * the sign-in panel loads before the application that boots after it
  * no equipment-register page, asset or nav item survives
  * no production token is embedded in the page
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "frontend" / "templates" / "index.html"
PORTAL_ASSETS = ROOT / "assets"


def _page(client) -> str:
    response = client.get("/")
    assert response.status_code == 200, response.text
    return response.text


# ── Shell ────────────────────────────────────────────────────────────────────

def test_root_serves_the_portal_shell(client):
    page = _page(client)
    assert "<title>Solar91 - O&amp;M Intelligence Centre</title>" in page
    # The sign-in panel replaces #app, so the shell must live inside it.
    assert '<div id="app">' in page
    assert page.index('<div id="app">') < page.index('class="ep-shell"')
    assert 'class="ep-sidebar"' in page and 'class="ep-main"' in page


def test_portal_route_redirects_to_the_app(client):
    moved = client.get("/portal", follow_redirects=False)
    assert moved.status_code == 308
    assert moved.headers["location"] == "/"


def test_sign_in_gate_loads_before_the_portal_application(client):
    page = _page(client)
    gate = page.index("/static/js/auth-gate.js")
    app_boot = page.index("/assets/js/app.js")
    assert gate < app_boot, "the access panel must be defined before the app boots"
    # The panel keeps its own stylesheet, unchanged.
    assert "/static/css/login.css" in page


def _on_disk(url_path: str) -> Path:
    """Map a served URL to its file: /assets/... -> assets/..., /static/... -> frontend/static/..."""
    if url_path.startswith("/assets/"):
        return ROOT / "assets" / url_path[len("/assets/"):]
    return ROOT / "frontend" / "static" / url_path[len("/static/"):]


def test_every_referenced_asset_exists(client):
    page = _page(client)
    referenced = set(re.findall(r'(?:href|src)="(/(?:assets|static)/[^"?]+)', page))
    assert referenced, "the page should reference local assets"
    missing = [path for path in sorted(referenced) if not _on_disk(path).is_file()]
    assert missing == [], f"page references files that do not exist: {missing}"


def test_assets_are_content_hashed_for_cache_busting(client):
    page = _page(client)
    for asset in ("/assets/js/app.js", "/assets/css/tokens.css", "/static/js/auth-gate.js"):
        assert re.search(re.escape(asset) + r"\?v=[0-9a-f]{12}", page), f"{asset} is not content-hashed"


def test_homepage_does_not_embed_production_tokens(client):
    page = _page(client)
    config = re.search(r'<script id="s91-config"[^>]*>(.*?)</script>', page, re.S)
    assert config, "the page must publish its public auth config as JSON"
    parsed = json.loads(config.group(1))
    assert set(parsed) == {"authProvider", "clerkPublishableKey"}
    assert parsed["authProvider"] == "clerk"
    # Only the publishable key may ever reach the browser.
    for secret in ("sk_live", "sk_test", "service_role", "CLERK_SECRET", "DATABASE_URL"):
        assert secret not in page


# ── Equipment register is gone ───────────────────────────────────────────────

def test_no_equipment_register_in_the_frontend(client):
    page = _page(client)
    assert "asset-warranty" not in page
    assert "Asset &amp; Warranty" not in page and "Asset & Warranty" not in page
    assert not (PORTAL_ASSETS / "js" / "asset-warranty.js").exists()
    assert not (PORTAL_ASSETS / "css" / "asset-warranty.css").exists()


def test_portal_scripts_do_not_reference_removed_endpoints():
    offenders = []
    for path in sorted(PORTAL_ASSETS.rglob("*.js")):
        body = path.read_text(encoding="utf-8")
        for dead in ("/api/equipment", "Solar91PortalAssets", "Solar91PortalMock"):
            if dead in body:
                offenders.append(f"{path.name}: {dead}")
    assert offenders == [], offenders


def test_no_mock_data_module_remains():
    assert not (PORTAL_ASSETS / "js" / "mock-data.js").exists()
    page = TEMPLATE.read_text(encoding="utf-8")
    assert "mock-data.js" not in page
    # The retired "Mock data" badge is replaced by a live-data badge.
    assert "Mock data" not in page
    assert "ep-badge-live" in page


# ── Navigation ───────────────────────────────────────────────────────────────

def test_plant_and_view_sub_pages_are_details_health_pm_washing():
    nav = (PORTAL_ASSETS / "js" / "navigation.js").read_text(encoding="utf-8")
    for block in ("PLANT_SUB_PAGES", "VIEW_SUB_PAGES"):
        start = nav.index(block)
        section = nav[start:nav.index("];", start)]
        ids = re.findall(r'id:\s*"([a-z-]+)"', section)
        assert ids == ["details", "health", "pm", "washing"], (block, ids)
        assert "asset-warranty" not in section


def test_plant_details_page_is_wired_up():
    page = TEMPLATE.read_text(encoding="utf-8")
    assert "data-plant-details-host" in page
    assert "/assets/js/plant-details.js" in page
    assert "/assets/css/plant-details.css" in page
    nav = (PORTAL_ASSETS / "js" / "navigation.js").read_text(encoding="utf-8")
    # One plant opens the detail page; the portfolio view keeps the comparison table.
    assert "Solar91PortalPlantDetails" in nav
    assert "Solar91PortalPlantsTable" in nav


# ── Syntax ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("script", sorted(p.name for p in (ROOT / "assets" / "js").glob("*.js")))
def test_portal_scripts_parse(script):
    target = PORTAL_ASSETS / "js" / script
    run = subprocess.run(["node", "--check", str(target)], capture_output=True, text=True, timeout=20)
    assert run.returncode == 0, run.stderr


def test_sign_in_gate_parses():
    gate = ROOT / "frontend" / "static" / "js" / "auth-gate.js"
    run = subprocess.run(["node", "--check", str(gate)], capture_output=True, text=True, timeout=20)
    assert run.returncode == 0, run.stderr


def test_issue_dates_typed_in_india_reach_the_api_as_exact_utc_instants():
    """A date typed in the browser is plant-local (IST); the API must receive the exact instant."""
    script = r"""
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const s=fs.readFileSync('assets/js/site-issues.js','utf8');
      const a=s.indexOf('function toUtcTimestamp(');assert(a>0,'toUtcTimestamp missing');
      let i=s.indexOf('{',a),depth=0,end=-1;
      for(let j=i;j<s.length;j++){if(s[j]==='{')depth++;else if(s[j]==='}'&&--depth===0){end=j+1;break}}
      const box={};vm.createContext(box);
      vm.runInContext(s.slice(a,end)+';this.f=toUtcTimestamp',box);
      // 09:00 IST on 2026-03-01 is 03:30 UTC the same day.
      assert.strictEqual(box.f('2026-03-01','09:00'),'2026-03-01T03:30:00.000Z');
      // A time after 18:30 IST rolls into the next UTC day.
      assert.strictEqual(box.f('2026-03-01T23:00'),'2026-03-01T17:30:00.000Z');
      assert.strictEqual(box.f(''),null);
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=20)
    assert run.returncode == 0, run.stderr
