"""Regression tests for the portal frontend served at /.

The portal design replaced the previous layered frontend bundle. These tests pin
what that swap must keep true:

  * the page is served at / behind the unchanged sign-in gate
  * every stylesheet and script it references exists and parses
  * the sign-in panel loads before the application that boots after it
  * the retired equipment register stays removed; Asset & Warranty does not invent data
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


def test_login_access_uses_real_users_and_hides_categories_from_settings(client):
    page = _page(client)
    settings = (PORTAL_ASSETS / "js" / "settings.js").read_text(encoding="utf-8")
    assert "Login access" in page and "data-nav=\"settings\"" in page
    assert 'request("/api/users")' in settings
    assert "/api/users/invite" in settings
    assert "Arun Demo" not in settings and "Demo invite" not in settings
    assert "Solar91PortalCategories" not in settings
    assert "data-categories-host" not in settings
    assert "Equipment scope · Washing" in settings
    assert "washing_plant_ids" in settings
    assert "Role &amp; plant assignments" not in settings


def test_login_access_sidebar_icon_and_toggle_are_sized_and_scoped():
    styles = (PORTAL_ASSETS / "css" / "layout.css").read_text(encoding="utf-8")
    nav = (PORTAL_ASSETS / "js" / "navigation.js").read_text(encoding="utf-8")
    assert ".ep-sidebar__settings .ep-nav-icon { width: 16px; height: 16px; }" in styles
    assert ".ep-shell.is-login-access:not(.is-sidebar-collapsed) [data-sidebar-toggle]" in styles
    assert 'classList.toggle("is-login-access", navState.activeView === "settings")' in nav


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


# ── Asset & Warranty does not imply an inventory register ───────────────────

def test_asset_warranty_view_is_present_without_invented_register_data(client):
    page = _page(client)
    assert 'data-nav="view:asset-warranty"' in page
    assert 'data-tab-view="asset-warranty"' in page
    assert "/assets/js/asset-warranty.js" in page
    assert "/assets/css/asset-warranty.css" in page
    module = (PORTAL_ASSETS / "js" / "asset-warranty.js").read_text(encoding="utf-8")
    assert "No inventory records" in module
    assert "Not configured" in module
    assert "Unit counts and warranty status cannot be shown" in module


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

def test_plant_and_view_sub_pages_include_asset_warranty():
    nav = (PORTAL_ASSETS / "js" / "navigation.js").read_text(encoding="utf-8")
    for block in ("PLANT_SUB_PAGES", "VIEW_SUB_PAGES"):
        start = nav.index(block)
        section = nav[start:nav.index("];", start)]
        ids = re.findall(r'id:\s*"([a-z-]+)"', section)
        assert ids == ["details", "health", "pm", "washing", "asset-warranty"], (block, ids)


def test_plant_details_page_is_wired_up():
    page = TEMPLATE.read_text(encoding="utf-8")
    assert "data-plant-details-host" in page
    assert "/assets/js/plant-details.js" in page
    assert "/assets/css/plant-details.css" in page
    nav = (PORTAL_ASSETS / "js" / "navigation.js").read_text(encoding="utf-8")
    # Details is the plant table either way: one plant's row when a plant is
    # selected, every plant's row portfolio-wide.
    assert "Solar91PortalPlantsTable" in nav
    assert '{ siteCode: plantCode }' in nav
    assert "data-plant-details-host" in nav


def test_asset_warranty_routes_for_plant_and_portfolio_without_inventory_api():
    nav = (PORTAL_ASSETS / "js" / "navigation.js").read_text(encoding="utf-8")
    module = (PORTAL_ASSETS / "js" / "asset-warranty.js").read_text(encoding="utf-8")
    assert 'pageId === "asset-warranty"' in nav
    assert 'data-asset-warranty-host' in nav
    assert "{ plantCode: plantCode }" in nav
    assert "data.listPlants()" in module
    assert "/api/equipment" not in module
    assert "data-aw-view" in module and 'role="dialog"' in module


def test_single_plant_details_shows_only_that_plant_row():
    table = (PORTAL_ASSETS / "js" / "plants-table.js").read_text(encoding="utf-8")
    # A single plant shows its heading and row, without portfolio controls.
    assert '(single ? "" : toolbarHTML())' in table
    assert '(single ? "" :\n            \'<div class="ep-pt__meta">\' +' in table
    assert 'data-pt-export="csv"' in table
    assert 'data-pt-export="excel"' in table
    editor = (PORTAL_ASSETS / "js" / "plant-details.js").read_text(encoding="utf-8")
    # The removed detail page must not come back as a second rendering of the same record.
    assert "Solar91PortalPlantEditor" in editor
    assert "Solar91PortalPlantDetails" not in editor


def test_plant_table_uses_balanced_shared_columns_and_numeric_spv_label():
    styles = (PORTAL_ASSETS / "css" / "components.css").read_text(encoding="utf-8")
    widths = [
        int(value) for value in re.findall(
            r"\.ep-pt__table th:nth-child\(\d+\), \.ep-pt__table td:nth-child\(\d+\) \{ width: (\d+)%; \}",
            styles,
        )
    ]
    assert len(widths) == 12
    assert sum(widths) == 100
    assert widths[9] >= 7, "the Location column should not wrap its heading"
    assert "min-width: 1080px" in styles and "overflow-x: auto" in styles
    assert "function spvNumber(plant)" in (
        PORTAL_ASSETS / "js" / "plants-table.js"
    ).read_text(encoding="utf-8")
    assert '{ key: "assignee",  label: "Assignee" }' in (
        PORTAL_ASSETS / "js" / "plants-table.js"
    ).read_text(encoding="utf-8")

    script = """
      global.window = global;
      require('./assets/js/portal-api.js');
      const plant = Solar91PortalAPI.normalizePlant({
        id: 1, site_code: 'ABH01',
        project_company: 'Solar91 Project Thirty Five Private Limited'
      });
      if (plant.projectCompanyShort !== 'Project 35') {
        throw new Error('Expected numeric project label, got ' + plant.projectCompanyShort);
      }
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=20)
    assert run.returncode == 0, run.stderr


def test_plant_washing_calendar_has_date_cycle_hover_and_setup_action():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "calendar.css").read_text(encoding="utf-8")
    page = TEMPLATE.read_text(encoding="utf-8")
    assert "renderWashingHoverCard(state, day.dataset.date)" in calendar
    assert 'event.kind === "report" && event.date <= date' in calendar
    assert 'return event.date === date;' in calendar
    assert 'report.jobStatus === "Done"' in calendar
    assert 'report.reviewStatus === "Confirmed"' in calendar
    assert "ep-wash-cycle-card__ring" in calendar
    assert "ep-calendar__wash-tip-foot" in calendar and "plant.assignee_name" in calendar
    assert 'tooltip.dataset.requestId === String(state.requestId)' in calendar
    assert 'data-calendar-action="open-setup">Set up washing' in calendar
    assert '"/api/scheduled/washing/assignees"' in calendar
    assert '"/api/scheduled/washing/setup"' in calendar
    assert "ep-calendar__wash-hover-card" in styles
    assert "ep-calendar__setup-button" in styles
    assert "renderCycleSummary(state)" not in calendar
    assert "/assets/js/operations-calendar.js" in page
    assert "/assets/css/calendar.css" in page


def test_calendar_days_do_not_show_native_plain_text_hover_tooltips():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    grid = calendar[
        calendar.index("function renderCalendarGrid"):
        calendar.index("function renderEventCards")
    ]
    assert 'title="' not in grid
    assert 'aria-label="' in grid


def test_operations_calendar_month_dates_fit_one_responsive_frame():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "calendar.css").read_text(encoding="utf-8")
    assert 'ep-calendar__grid--weeks-' + "' + (cells / 7)" in calendar
    for weeks in (4, 5, 6):
        assert f".ep-calendar__grid--weeks-{weeks}" in styles
    assert "height: clamp(240px, calc(100dvh - 360px), 650px);" in styles
    assert "height: clamp(210px, calc(100dvh - 450px), 480px);" in styles
    assert ".ep-calendar__day {\n  display: flex;\n  min-width: 0;\n  min-height: 0;" in styles


def test_plant_pm_calendar_shows_job_hover_card_for_scheduled_dates():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "calendar.css").read_text(encoding="utf-8")
    page = TEMPLATE.read_text(encoding="utf-8")
    assert "function renderPreventiveHoverCard(state, date)" in calendar
    assert 'context.type === "pm" && !!context.plantCode' in calendar
    assert "renderPreventiveHoverCard(state, day.dataset.date)" in calendar
    assert 'event.date === date;' in calendar
    assert "equipmentLabel(event, active.context)" in calendar
    assert "event.unitNo && event.totalUnits" in calendar
    assert "event.assignee" in calendar
    assert 'id="' + "' + hoverId + '" in calendar
    assert "ep-calendar__pm-hover-card" in styles
    assert "ep-calendar__pm-tip-job" in styles
    assert "/assets/js/operations-calendar.js" in page
    assert "/assets/css/calendar.css" in page


def test_pm_calendar_setup_is_a_frontend_only_preview_for_plant_and_portfolio():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "calendar.css").read_text(encoding="utf-8")
    assert 'data-calendar-action="open-pm-setup">Set up PM' in calendar
    assert 'var showPMSetupButton = context.type === "pm" && canManagePMSetup();' in calendar
    for field in ("equipment", "part", "subpart", "task", "startDate"):
        assert 'field("' + field + '"' in calendar
    assert 'data-pm-setup-field="frequency"' in calendar
    assert 'data-pm-setup-field="remarks"' in calendar
    assert "Add another PM item" in calendar
    assert "Preview setup" in calendar
    assert "Frontend preview only. Nothing is saved or scheduled yet." in calendar
    assert "renderPMSetupModal(state, context)" in calendar
    assert "/api/pm-plan/" not in calendar
    assert ".ep-calendar__pm-setup-fields" in styles
    assert ".ep-calendar__pm-setup-preview-items" in styles


def test_plant_pm_calendar_date_click_opens_summary_then_saved_job_detail():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "calendar.css").read_text(encoding="utf-8")
    assert 'if (context.type === "pm" && context.plantCode)' in calendar
    assert 'aria-labelledby="calendar-dialog-title"' in calendar
    assert ">Daily summary</h2>" in calendar
    assert 'data-calendar-filter="modal-search"' in calendar
    assert "renderPlantPMSummaryEvents(events, state)" in calendar
    assert 'data-calendar-event-index="' in calendar
    assert "renderEventDetail(state, context)" in calendar
    assert 'data-calendar-action="close-event-detail"' in calendar
    assert "ep-calendar__pm-summary-modal" in styles
    assert "ep-calendar__pm-summary-item" in styles
    assert ".ep-calendar__event-detail-modal { z-index: 70; }" in styles


def test_portfolio_pm_and_washing_use_centered_daily_summary_not_side_drawer():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "calendar.css").read_text(encoding="utf-8")
    page = TEMPLATE.read_text(encoding="utf-8")
    assert "if (!context.plantCode)" in calendar
    assert "renderPortfolioSummaryEvents(events, context, state)" in calendar
    portfolio_branch = calendar[
        calendar.index("if (!context.plantCode)", calendar.index("function renderModal")):
        calendar.index('if (context.type === "pm" && context.plantCode)')
    ]
    assert 'data-calendar-filter="modal-plant"' in calendar
    assert 'data-calendar-filter="modal-equipment"' in calendar
    assert 'data-calendar-filter="modal-status"' in calendar
    assert 'placeholder="Search plant, reference, status..."' in calendar
    assert "ep-calendar__portfolio-summary-modal" in calendar
    assert "ep-calendar__modal--drawer" not in portfolio_branch
    assert 'class="ep-calendar__modal ep-calendar__pm-summary-modal' in portfolio_branch
    assert ".ep-calendar__portfolio-summary-modal .ep-calendar__dialog" in styles
    assert ".ep-calendar__portfolio-summary-filters" in styles
    assert "renderEventDetail(state, context)" in calendar
    assert "/assets/js/operations-calendar.js" in page
    assert "/assets/css/calendar.css" in page


def test_plant_washing_range_sheet_and_health_issue_wizard_are_wired():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    calendar_styles = (PORTAL_ASSETS / "css" / "calendar.css").read_text(encoding="utf-8")
    assert 'data-calendar-action="open-record">Record washing' in calendar
    assert '"/api/scheduled/washing/daily-reports/sheet"' in calendar
    assert "table_start: row.start" in calendar and "table_end: end" in calendar
    assert "function syncRecordRangeInputs" in calendar
    assert "previousCompletion" in calendar and "startDate = afterPrevious" in calendar
    assert "ep-calendar__record-modal" in calendar_styles

    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")
    issue_styles = (PORTAL_ASSETS / "css" / "site-issues.css").read_text(encoding="utf-8")
    assert 'data-issue-wizard' in issues
    assert 'renderRaiseWizard(context)' in issues
    assert 'state.draft = createDraft(active.context)' in issues
    assert '["Plant", "Classification", "Priority & details"]' in issues
    assert "ep-issues__stepper" in issue_styles and "ep-issues__wizard-fields--two" in issue_styles


def test_portfolio_health_hides_hero_and_summary_and_calendar_has_nested_detail():
    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")
    assert "renderSummary" not in issues
    assert "renderPlantSnapshot" not in issues
    assert 'content = \'<section class="ep-issues__results">' in issues
    header = issues[issues.index("function renderHeader"):issues.index("function renderFilters")]
    assert "Site Issues" not in header
    assert "Track reported issues across plants." not in header
    assert 'data-issue-action="raise"' in header
    assert "renderHeader(context)" in issues

    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "calendar.css").read_text(encoding="utf-8")
    assert 'data-calendar-filter="modal-equipment"' in calendar
    assert 'data-calendar-event-index="' in calendar
    assert "renderEventDetail(state, context)" in calendar
    assert 'data-calendar-action="close-event-detail"' in calendar
    assert "ep-calendar__event-detail-modal" in styles


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
