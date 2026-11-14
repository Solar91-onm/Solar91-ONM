"""Runtime navigation regressions and safe deployment configuration."""
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def test_portal_nav_bundle_served_and_revalidated(client):
    """A deploy that changes navigation.js must change its URL, so no browser keeps the old copy."""
    html=client.get("/")
    assert html.status_code==200
    assert html.headers.get("cache-control")=="no-store"
    import re
    from app.core.assets import asset_hash_for_url
    current=asset_hash_for_url("/assets/js/navigation.js")
    assert re.fullmatch(r"[0-9a-f]{12}",current)
    assert f"navigation.js?v={current}" in html.text
    asset=client.get("/assets/js/navigation.js")
    assert asset.status_code==200
    assert "must-revalidate" in asset.headers.get("cache-control","")
    assert "Solar91PortalNav" in asset.text
    versioned=client.get(f"/assets/js/navigation.js?v={current}")
    assert "immutable" in versioned.headers.get("cache-control","")
    stale=client.get("/assets/js/navigation.js?v=20261013-stability-r2")
    assert "must-revalidate" in stale.headers.get("cache-control","")


def test_portal_navigation_restores_same_page_browser_history():
    source = (ROOT / "assets/js/navigation.js").read_text(encoding="utf-8")
    assert 'global.history.pushState(next, "")' in source
    assert 'global.history.replaceState(next, "")' in source
    assert 'global.addEventListener("popstate"' in source
    assert "restoreNavigationHistory(event.state)" in source


def test_supabase_public_config_not_secret_in_example():
    source=(ROOT/".env.example").read_text()
    assert "SUPABASE_URL=\n" in source
    assert "CLERK_PUBLISHABLE_KEY=\n" in source
    assert "SUPABASE_SERVICE_ROLE_KEY=\n" in source
    assert "sb_publishable_" not in source
    assert "SUPABASE_SERVICE_ROLE_KEY=sb_secret_" not in source
    assert "<supabase-session-pooler-host>" in source


def test_incomplete_supabase_database_url_is_detected_as_placeholder():
    from scripts.preflight import bad
    assert bad('postgresql+psycopg://<user>:<password>@<supabase-session-pooler-host>:5432/postgres?sslmode=require')
    assert not bad('postgresql+psycopg://example:example@localhost:5432/postgres?sslmode=require')
