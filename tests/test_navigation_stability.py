"""Runtime navigation regressions and safe deployment configuration."""
from pathlib import Path
import subprocess
import textwrap

ROOT=Path(__file__).resolve().parents[1]


def test_new_nav_bundle_served_and_revalidated(client):
    html=client.get("/")
    assert html.status_code==200
    assert html.headers.get("cache-control")=="no-store"
    assert "35-navigation-recovery.js?v=20261013-stability-r2" in html.text
    asset=client.get("/static/js/35-navigation-recovery.js")
    assert asset.status_code==200
    assert "must-revalidate" in asset.headers.get("cache-control","")
    assert "__s91StabilityGuard" in asset.text


def test_supabase_public_config_not_secret_in_example():
    source=(ROOT/".env.example").read_text()
    assert "SUPABASE_URL=\n" in source
    assert "CLERK_PUBLISHABLE_KEY=\n" in source
    assert "SUPABASE_SERVICE_ROLE_KEY=\n" in source
    assert "sb_publishable_" not in source
    assert "SUPABASE_SERVICE_ROLE_KEY=sb_secret_" not in source
    assert "<supabase-session-pooler-host>" in source


def test_navigation_recovery_closes_stale_overlay_without_bypassing_legacy_handler():
    script=textwrap.dedent(r"""
    const fs=require('fs'),vm=require('vm'),assert=require('assert');
    const src=fs.readFileSync('frontend/static/js/35-navigation-recovery.js','utf8');
    let removed=0,delegated=0,drawn=0;
    const overlay={parentNode:{},remove:()=>{removed++}};
    const window={addEventListener:()=>{},render:()=>{drawn++},
      goView:function(view){delegated++;S.view=view;},goTab:function(tab){delegated++;S.omTab=tab;},
      goScheduledOM:()=>{},openPlantPage:()=>{}};
    const S={view:'dashboard',omTab:'issues',modal:'ticket',modalCtx:{id:1}};
    const document={querySelectorAll:()=>[overlay],getElementById:()=>null};
    const sandbox={window,document,S,Date,console,setTimeout:()=>{},location:{reload:()=>{}}};
    vm.createContext(sandbox);vm.runInContext(src,sandbox);
    window.goView('plants');
    assert.strictEqual(removed,1);
    assert.strictEqual(delegated,1);
    assert.strictEqual(S.view,'plants');
    // Existing navigation owns modal state; resilience shim must not impersonate auth/DB APIs.
    window.render();
    assert.strictEqual(drawn,1);
    console.log('Overlay cleaned; existing route handler preserved');
    """)
    run=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True,timeout=10)
    assert run.returncode==0,run.stderr


def test_incomplete_supabase_database_url_is_detected_as_placeholder():
    from scripts.preflight import bad
    assert bad('postgresql+psycopg://<user>:<password>@<supabase-session-pooler-host>:5432/postgres?sslmode=require')
    assert not bad('postgresql+psycopg://example:example@localhost:5432/postgres?sslmode=require')
