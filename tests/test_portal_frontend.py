"""Regression tests for the portal frontend served at /.

The portal design replaced the previous layered frontend bundle. These tests pin
what that swap must keep true:

  * the page is served at / behind the unchanged sign-in gate
  * every stylesheet and script it references exists and parses
  * the sign-in panel loads before the application that boots after it
  * the retired equipment register and Asset & Warranty pages stay removed
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


def test_sidebar_order_and_overview_metric_grid(client):
    page = _page(client)
    styles = (PORTAL_ASSETS / "css" / "components.css").read_text(encoding="utf-8")
    assert page.index('data-nav-group="views"') < page.index('data-nav-group="plants"')
    assert '<span class="ep-nav-item__label">Dashboard</span>' in page
    assert page.index('data-nav-group="plants"') < page.index('data-nav="security"')
    assert '<span class="ep-nav-item__label">Overview</span>' in page
    assert ".ep-metrics {\n  display: grid;\n  grid-template-columns: repeat(2, minmax(0, 1fr));\n}" in styles
    assert "@media (max-width: 760px) { .ep-metrics { grid-template-columns: 1fr; } }" in styles


def test_security_register_supports_multiple_contacts_and_edit_overlay():
    security = (PORTAL_ASSETS / "js" / "security.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "security.css").read_text(encoding="utf-8")
    for label in ("Site Engineer", "Site Engineer No.", "Engineer Shift", "Security Name", "Mobile No.", "Guard Shift"):
        assert label in security
    assert "<th>Guard Name</th>" not in security
    assert 'data-security-register-search' in security
    assert "applyRegisterFilters(container)" in security
    assert "plant code, site engineer, or security name" in security
    assert 'data-security-table="register"' in security
    assert 'data-security-open-edit' in security
    assert 'aria-modal="true"' in security
    assert 'data-security-search' in security and 'data-security-site-filter' in security
    assert 'data-security-contact-shift="' in security
    assert 'data-security-add="engineer"' in security and 'data-security-add="guard"' in security
    assert 'fields.security_contacts = payload.contacts;' in security
    assert "<th>Actions</th>" not in security
    assert ".ep-security__site-code {\n  text-align: center;" in styles
    assert ".ep-security__overlay {" in styles and "overflow-x: hidden;" in styles
    # The modal's flex child is the table wrapper; without its own sizing the table grows to fit
    # every plant and pushes Save/Cancel outside the clipped modal, where no user can reach them.
    assert ".ep-security__modal .ep-pt__table-wrap {" in styles
    assert ".ep-security__modal .ep-security__scroll {" in styles


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
    assert "Scope · Module Cleaning" in settings
    assert "Scope · Preventive Maintenance" in settings and "Scope · Health" in settings
    assert "pm_plant_ids" in settings and "health_plant_ids" in settings
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
    assert (PORTAL_ASSETS / "js" / "security.js").is_file()
    assert (PORTAL_ASSETS / "css" / "security.css").is_file()


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


def test_overview_area_filter_and_operational_trend_controls_are_wired(client):
    page = _page(client)
    overview = (PORTAL_ASSETS / "js" / "overview.js").read_text(encoding="utf-8")
    adapter = (PORTAL_ASSETS / "js" / "data-adapter.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "components.css").read_text(encoding="utf-8")
    overview_markup = page[page.index('data-tab-view="overview"'):page.index('data-tab-view="plants-table"')]

    assert 'data-filter="district"' in overview_markup
    assert "data-filter=\"period\"" not in overview_markup
    assert "data-trend-metric" not in overview_markup
    # The chart's own From / To / Apply are gone. They were wired to nothing and were hidden from
    # JavaScript after the data loaded, so a hard refresh painted them and a failed load left them
    # on screen. The Range selector in the filter bar is the one date control.
    assert "data-trend-from" not in overview_markup and "data-trend-to" not in overview_markup
    assert "data-trend-apply" not in overview_markup
    assert 'data-filter="date"' in overview_markup
    assert "districtsByKey" in overview and "(plant.district || \"\").trim()" in overview
    assert 'filters.district === "__all" || districtKey(plant.district) === districtKey(filters.district)' in overview
    assert overview.count("if (!districtMatches(plant)) return false;") == 1   # the tile rows
    # Picking a plant narrows SPV + district to it; All plants / an emptied plant box resets both.
    assert "syncLocationFilters(row ? row.plant : null);" in overview
    assert 'if (!plantInput.value.trim() && filters.plant !== "__all") selectPlantFilter("__all");' in overview
    assert "selectPlantFilter(code);" in overview
    # The Overview is the three tiles and nothing else: the trend chart was removed from the tab,
    # markup and script alike, so the tiles fit one screen without scrolling.
    assert "data-overview-trend-chart" not in overview_markup
    assert "ep-overview-trend" not in overview_markup
    assert "renderTrendChart" not in overview
    assert "fetchPortfolioTrend" not in overview
    assert 'data-overview-metrics' in overview_markup
    # The adapter keeps the endpoint it already exposed; only the Overview stopped calling it.
    assert "/api/portal/overview/trend?" in adapter


def test_overview_filters_keep_full_options_and_metric_tiles_open_scoped_pages():
    overview = (PORTAL_ASSETS / "js" / "overview.js").read_text(encoding="utf-8")
    page = TEMPLATE.read_text(encoding="utf-8")

    assert "syncDependentOptions" not in overview
    assert "const matched = allRows.filter(({ plant }) =>" in overview
    assert 'filters[filterName] = ev.target.value;' in overview
    assert 'data-overview-destination="${c.destination}"' in overview
    assert 'destination: "pm"' in overview
    assert 'destination: "washing"' in overview
    assert 'destination: "health"' in overview
    assert "global.Solar91PortalNav.selectView(destination, dateRange)" in overview
    assert "global.Solar91PortalNav.selectPlantPage(filters.plant, destination, dateRange, row.plant)" in overview
    assert 'role="link" tabindex="0"' in overview
    navigation = (PORTAL_ASSETS / "js" / "navigation.js").read_text(encoding="utf-8")
    assert "selectView: selectView" in navigation
    assert ">All SPV</option>" in page
    assert 'Filter by SPV' in page


def test_overview_range_and_trend_requests_are_cached_deduped_and_bounded():
    """The Overview refetches on every filter change, so repeats must not reach the API.

    Guards the four properties that make that safe: a repeat is served from
    cache, concurrent identical calls share one request, a failure is never
    cached, and the cache cannot grow without bound.
    """
    script = """
      global.window = global;
      let calls = 0;
      let fail = false;
      global.Solar91PortalAPI = {
        request: () => { calls++; return fail ? Promise.reject(new Error('boom'))
                                              : Promise.resolve({ rows: [], totals: {} }); },
        normalizePlant: (p) => p,
        plants: () => Promise.resolve([])
      };
      require('./assets/js/data-adapter.js');
      const d = global.Solar91PortalData;
      const fail_if = (cond, msg) => { if (cond) throw new Error(msg); };

      (async () => {
        // A repeated range costs one request, not three.
        calls = 0;
        await d.fetchPortfolioRange('2026-10-01', '2026-10-31');
        await d.fetchPortfolioRange('2026-10-01', '2026-10-31');
        await d.fetchPortfolioRange('2026-10-01', '2026-10-31');
        fail_if(calls !== 1, 'repeated range made ' + calls + ' requests, expected 1');

        // Concurrent identical trend calls share one in-flight request.
        calls = 0;
        await Promise.all([
          d.fetchPortfolioTrend('2026-10-01', '2026-10-31', ['A', 'B']),
          d.fetchPortfolioTrend('2026-10-01', '2026-10-31', ['B', 'A'])
        ]);
        fail_if(calls !== 1, 'concurrent trend made ' + calls + ' requests, expected 1');

        // A write invalidates, so the next read is fresh rather than stale.
        calls = 0;
        d.invalidate();
        await d.fetchPortfolioRange('2026-10-01', '2026-10-31');
        fail_if(calls !== 1, 'invalidate() did not force a refetch');

        // A failed request must not be cached, or the error would stick.
        fail = true;
        calls = 0;
        await d.fetchPortfolioTrend('2026-08-01', '2026-08-31', []).catch(() => {});
        fail = false;
        await d.fetchPortfolioTrend('2026-08-01', '2026-08-31', []).catch(() => {});
        fail_if(calls !== 2, 'a failure was cached; retry made ' + calls + ' requests, expected 2');

        // The cache is bounded: the oldest entry is evicted, not kept forever.
        await d.fetchPortfolioRange('2020-01-01', '2020-01-02');
        for (let i = 1; i <= 40; i++) {
          await d.fetchPortfolioRange('2021-01-01', '2021-02-' + String(i).padStart(2, '0'));
        }
        calls = 0;
        await d.fetchPortfolioRange('2020-01-01', '2020-01-02');
        fail_if(calls !== 1, 'the cache is unbounded: the oldest entry was never evicted');
      })().catch((error) => { console.error(error.message); process.exit(1); });
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stderr or run.stdout


def test_overview_no_longer_requests_a_trend_for_filter_changes():
    overview = (PORTAL_ASSETS / "js" / "overview.js").read_text(encoding="utf-8")
    # The chart is gone, so changing plant, district or company redraws the tiles and asks for nothing else.
    assert "trendTimer" not in overview
    assert "reloadTrendForFilters" not in overview
    assert "recomputeAndRender();" in overview


def test_register_import_export_is_offered_beside_raise_issue_and_set_up_pm():
    page = TEMPLATE.read_text(encoding="utf-8")
    register = (PORTAL_ASSETS / "js" / "register-io.js").read_text(encoding="utf-8")
    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "components.css").read_text(encoding="utf-8")

    # The shared control is fetched with the pages that use it (modules.js), not on every page load.
    assert '"register-io": "/assets/js/register-io.js"' in page
    assert '<script defer src="/assets/js/register-io.js"' not in page
    modules = (PORTAL_ASSETS / "js" / "modules.js").read_text(encoding="utf-8")
    assert '"site-issues": ["table-sort", "register-io"]' in modules
    assert '"operations-calendar": ["register-io"]' in modules

    # It points at the importers that already existed, plus the new downloads.
    for url in ("/api/issues/import", "/api/issues/import/template", "/api/issues/export",
                "/api/pm-plan/import", "/api/pm-plan/import/template", "/api/pm-plan/export"):
        assert url in register, url

    # Import is two steps: the file is validated with dry_run before anything is written.
    assert 'dry_run: "true"' in register and 'dry_run: "false"' in register

    # Mounted beside each primary action, not replacing it.
    assert 'Solar91RegisterIO.controls("issues"' in issues
    assert 'data-issue-action="raise"' in issues
    assert 'Solar91RegisterIO.controls("pm"' in calendar
    assert 'data-calendar-action="open-pm-setup"' in calendar
    assert ".ep-sheet-io__button" in styles


def test_register_import_is_gated_on_the_same_permission_as_creating_the_record():
    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    # Uploading issues raises tickets, so it follows canRaise; the PM plan follows PM setup rights.
    assert "canImport: state.canRaise" in issues
    assert "canImport: canManagePMSetup()" in calendar


def test_pm_setup_offers_all_plants_all_parts_and_all_tasks():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    assert 'var ALL_PLANTS = "__all"' in calendar
    assert 'var ALL_PARTS = "All parts"' in calendar
    assert 'var ALL_TASKS = "All tasks"' in calendar
    # Offered at the top of each list, beside the specific choices.
    assert "[ALL_PARTS].concat(partOptions)" in calendar
    assert "[ALL_TASKS].concat(taskOptions)" in calendar
    assert ">All plants (" in calendar
    # "All parts" must not be treated as a part name when narrowing the task list.
    assert 'item.part === ALL_PARTS ? "" : item.part' in calendar


def test_root_url_opens_the_portal_with_its_sign_in_gate_without_redirecting(client):
    """Typing the bare site URL must land on the portal itself, not a redirect or a landing page."""
    response = client.get("/")
    assert response.status_code == 200
    assert response.history == [], "the root URL must serve the portal directly"
    assert "text/html" in response.headers["content-type"]
    page = response.text
    assert '<div id="app">' in page and 'class="ep-shell"' in page
    # The sign-in panel loads before the application that boots behind it.
    assert "/static/js/auth-gate.js" in page
    # The old /portal bookmark still arrives at the same place.
    legacy = client.get("/portal", follow_redirects=False)
    assert legacy.status_code == 308 and legacy.headers["location"] == "/"


def test_portal_is_not_offered_to_search_engines(client):
    """A sign-in-gated operations portal has nothing to index; being listed only advertises the login."""
    robots = client.get("/robots.txt")
    assert robots.status_code == 200
    assert robots.headers["content-type"].startswith("text/plain")
    assert "User-agent: *" in robots.text and "Disallow: /" in robots.text
    assert '<meta name="robots" content="noindex, nofollow"/>' in client.get("/").text


def test_shared_link_carries_a_preview_card_and_a_canonical_url(client):
    page = client.get("/").text
    for tag in ('property="og:type"', 'property="og:title"', 'property="og:description"',
                'property="og:url"', 'property="og:image"', 'name="twitter:card"'):
        assert tag in page, tag
    assert 'rel="canonical"' in page
    # Absolute, or a crawler and a chat client cannot resolve them.
    for attr in re.findall(r'(?:og:url|og:image)" content="([^"]+)"', page):
        assert attr.startswith("http"), attr
    assert re.search(r'<link rel="canonical" href="https?://[^"]+/"', page)
    # theme-color was already declared once; the preview tags must not duplicate it.
    assert page.count('name="theme-color"') == 1


def test_record_washing_keeps_the_last_cycle_open_for_extra_washing():
    """A plant that washes again after all three cycles are full must still get rows for those days.

    Cycles 1 and 2 hand the month over to the next cycle on the day they fill, so their grid stops
    there. The last cycle has nothing to hand over to - the backend keeps later days on it as extra
    washing - so closing its grid on the completion date hid work that was really done.
    """
    script = """
      global.window = global;
      global.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
      global.Solar91PortalFormat = { escape: (s) => String(s == null ? '' : s) };
      global.Solar91PortalAPI = { request: () => Promise.resolve({}), can: () => true,
                                  currentUser: () => ({ role: 'O&M Head' }) };
      const fs = require('fs');
      let src = fs.readFileSync('./assets/js/operations-calendar.js', 'utf8');
      src = src.replace('  global.Solar91PortalCalendar = { render: render };',
                        '  global.__i = { recordRows };');
      eval(src);

      const cycles = [
        { cycle_no: 1, start_date: '2026-10-01', due_date: '2026-10-10', confirmed: 10, state: 'Completed' },
        { cycle_no: 2, start_date: '2026-10-11', due_date: '2026-10-20', confirmed: 10, state: 'Completed' },
        { cycle_no: 3, start_date: '2026-10-21', due_date: '2026-10-31', confirmed: 20, state: 'Completed' }
      ];
      // Cycles filled on the 5th, 15th and 24th; the plant then washed everything again on the 28th.
      const reports = [5, 15, 24, 28].map((day, i) => ({
        report_date: '2026-10-' + String(day).padStart(2, '0'),
        cycle_no: [1, 2, 3, 3][i], tables_cleaned: 10, job_status: 'Done',
        review_status: 'Confirmed', cycle_completed: day !== 28
      }));
      const rowsFor = (cycleNo) => global.__i.recordRows({
        month: '2026-10', recordCycle: cycleNo, washingDataToday: '2026-10-31',
        washingReports: reports, recordDrafts: {},
        washingPlant: { cycles, table_count: 10, monthly_target: 3 }
      });

      const third = rowsFor(3);
      const dates = third.map((row) => row.date);
      if (!dates.includes('2026-10-28')) {
        throw new Error('the extra wash on the 28th has no row: ' + dates.join(','));
      }
      if (!third.find((row) => row.date === '2026-10-28' && row.report)) {
        throw new Error('the 28th has a row but not its saved report');
      }
      if (dates[dates.length - 1] !== '2026-10-31') {
        throw new Error('the last cycle must stay open to month end, ended ' + dates[dates.length - 1]);
      }
      // The earlier cycles must still close on the day they fill, or their days would double up.
      const first = rowsFor(1).map((row) => row.date);
      if (first[first.length - 1] !== '2026-10-05') {
        throw new Error('cycle 1 should stop at its handover, ended ' + first[first.length - 1]);
      }
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stderr or run.stdout


def test_record_sheet_lets_om_re_clean_tables_into_the_next_cycle():
    """O&M Head / Assignee may pick tables already cleaned in the open cycle: the day starts the next cycle (the backend
    rule in _cycle_sequence). A Site Engineer is still told the table is already cleaned. After a saved re-clean the
    overtaken cycle's grid ends the day before it, and the next cycle's grid starts on it."""
    script = """
      global.window = global;
      global.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
      global.Solar91PortalFormat = { escape: (s) => String(s == null ? '' : s) };
      let role = 'O&M Head';
      global.Solar91PortalAPI = { request: () => Promise.resolve({}), can: () => true, currentUser: () => ({ role: role }) };
      const fs = require('fs');
      let src = fs.readFileSync('./assets/js/operations-calendar.js', 'utf8');
      src = src.replace('  global.Solar91PortalCalendar = { render: render };', '  global.__i = { recordRows };');
      eval(src);
      const fail = (m) => { throw new Error(m); };
      const cycles = [
        { cycle_no: 1, start_date: '2026-10-01', due_date: '2026-10-10', state: 'In progress' },
        { cycle_no: 2, start_date: '2026-10-11', due_date: '2026-10-20', state: 'Upcoming' },
        { cycle_no: 3, start_date: '2026-10-21', due_date: '2026-10-31', state: 'Upcoming' }
      ];
      const day1 = { id: 'a', report_date: '2026-10-01', cycle_no: 1, tables_cleaned: 3, job_status: 'Done',
                     review_status: 'Confirmed', cycle_completed: false, cleaned_table_codes: ['Table 001', 'Table 002', 'Table 003'] };
      const rows = (reports, cycleNo, drafts) => global.__i.recordRows({
        month: '2026-10', recordCycle: cycleNo, washingDataToday: '2026-10-05', washingReports: reports,
        recordDrafts: drafts || {}, washingPlant: { cycles, table_count: 10, monthly_target: 3 } });

      // Unsaved: the Head picks 1-3 again on the 3rd; the 4th, from the start, is planned in cycle 2.
      const drafts = { '2026-10-03': { mode: 'pick', list: '2-5' }, '2026-10-04': { mode: 'start', end: '3' } };
      const planned = rows([day1], 1, drafts);
      const third = planned.find((r) => r.date === '2026-10-03');
      if (third.error) fail('O&M re-clean should not be an error: ' + third.error);
      if (third.numbers.join(',') !== '2,3,4,5') fail('picked tables ' + third.numbers);
      if (!/starts cycle 2/.test(third.note) || !/2\\u20133/.test(third.note)) fail('note: ' + third.note);
      const fourth = planned.find((r) => r.date === '2026-10-04');
      if (fourth.numbers.join(',') !== '1') fail('the day after plans against cycle 2: ' + fourth.numbers);
      if (!/Counts in cycle 2/.test(fourth.note)) fail('later day note: ' + fourth.note);

      // A Site Engineer picking the same tables is refused.
      role = 'Site Engineer';
      const se = rows([day1], 1, drafts).find((r) => r.date === '2026-10-03');
      if (!/already cleaned in this cycle/.test(se.error) || se.numbers.length) fail('engineer: ' + se.error);
      role = 'O&M Head';

      // Saved: the re-clean on the 3rd is cycle 2. Cycle 1's grid ends on the 2nd; cycle 2's starts on the 3rd.
      const day3 = Object.assign({}, day1, { id: 'b', report_date: '2026-10-03', cycle_no: 2 });
      const c1 = rows([day1, day3], 1).map((r) => r.date);
      if (c1[c1.length - 1] !== '2026-10-02') fail('cycle 1 should end the day before cycle 2 began: ' + c1.join(','));
      const c2 = rows([day1, day3], 2);
      if (c2[0].date !== '2026-10-03' || !c2[0].report) fail('cycle 2 should start on its first day: ' + c2.map((r) => r.date).join(','));
      if (c2.cleanedTables.join(',') !== '1,2,3') fail('cycle 2 cleaned tables: ' + c2.cleanedTables);
      if (rows([day1, day3], 1).cleanedTables.join(',') !== '1,2,3') fail('cycle 1 keeps only its own tables');

      // Cycle 3 has no next cycle: a repeat there is an error even for the Head.
      const c3day = Object.assign({}, day1, { id: 'c', report_date: '2026-10-02', cycle_no: 3 });
      const last = rows([c3day], 3, { '2026-10-04': { mode: 'pick', list: '1' } }).find((r) => r.date === '2026-10-04');
      if (!/last cycle/.test(last.error)) fail('cycle 3 repeat: ' + last.error);
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stderr or run.stdout


def test_every_portfolio_table_sorts_from_its_column_headings():
    """Clicking a heading orders the rows by that column and flips on a second click, with the
    arrow pair in the heading showing which way they run — the shared control in table-sort.js."""
    sort = (PORTAL_ASSETS / "js" / "table-sort.js").read_text(encoding="utf-8")
    page = TEMPLATE.read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "components.css").read_text(encoding="utf-8")

    # It is fetched with every table that uses it, and never on its own page load.
    assert '"table-sort": "/assets/js/table-sort.js"' in page
    assert '<script defer src="/assets/js/table-sort.js"' not in page
    modules = (PORTAL_ASSETS / "js" / "modules.js").read_text(encoding="utf-8")
    for module in ("plants-table", "liasoning", "bom", "site-issues"):
        needs = re.search(r'"?' + re.escape(module) + r'"?: \[([^\]]*)\]', modules)
        assert needs and "table-sort" in needs.group(1), module

    # Second click on the same column flips it; a different column starts ascending.
    assert 'if (sortState.key === key) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";' in sort
    assert 'else { sortState.key = key; sortState.dir = "asc"; }' in sort
    # Blanks sink in both directions, and equal values keep the order they arrived in.
    assert "if (aBlank) return 1;" in sort and "if (bBlank) return -1;" in sort
    assert "return result !== 0 ? result * dir : a.index - b.index;" in sort
    # A column with no reader (Edit, Action) stays a plain heading.
    assert 'if (!column.sort) return "<th" + cls + ">" + escape(column.label) + "</th>";' in sort
    assert "ep-sort__arrows" in sort and 'aria-sort="' in sort
    assert ".ep-sort[data-dir=\"asc\"] .ep-sort__up," in styles

    # The tables that use it, and the old plants "Sort:" dropdown it replaced.
    table = (PORTAL_ASSETS / "js" / "plants-table.js").read_text(encoding="utf-8")
    assert "COLUMNS.map(columnHeaderHTML).join(\"\")" in table
    assert 'global.Solar91PortalSort.thHTML(column, ui.sort, "data-pt-sort")' in table
    assert "Solar91PortalSort.apply(rows, ui.sort, COLUMNS)" in table
    assert "Sort: plant code" not in table
    liasoning = (PORTAL_ASSETS / "js" / "liasoning.js").read_text(encoding="utf-8")
    assert "Solar91PortalSort.headerHTML(COLUMNS, ui.sort, \"data-lia-sort\")" in liasoning
    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")
    issue_styles = (PORTAL_ASSETS / "css" / "site-issues.css").read_text(encoding="utf-8")
    assert 'Solar91PortalSort.thHTML(column, state.columnSort, "data-issue-sort")' in issues
    assert "ep-issues__column-filter-row" not in issues
    assert "ep-issues__th-content" in issues and "data-issue-column-filter" in issues
    assert ".ep-issues__th-content {" in issue_styles and "display: flex;" in issue_styles
    assert ".ep-issues__table th {\n  height: 36px;" in issue_styles
    assert "vertical-align: middle;" in issue_styles
    assert "text-overflow: ellipsis;" in issue_styles
    assert 'data-issue-column-filter-toggle="' in issues
    assert 'popover="auto"' in issues
    assert 'data-issue-column-filter-search="' in issues
    assert 'data-issue-column-filter-option="' in issues
    assert "function filterColumnOptions(menu, term)" in issues
    assert ".ep-issues__table-wrap {\n  width: 100%;\n  min-width: 0;\n  overflow: hidden;" in issue_styles
    assert ".ep-issues__table {\n  width: 100%;\n  border-collapse: collapse;\n  table-layout: fixed;" in issue_styles
    assert ".ep-issues__table td .ep-issues__date-age {\n  display: block;" in issue_styles
    # The phone card layout stacks the cells, so it must outrank the desktop per-column percentages.
    assert ".ep-issues__table td:nth-child(n) { width: 100%; }" in issue_styles


def test_sorting_orders_rows_and_keeps_blanks_last():
    """The comparator itself: numbers numerically, text naturally, blanks last either way."""
    script = """
      global.window = global;
      const fs = require('fs');
      eval(fs.readFileSync('./assets/js/table-sort.js', 'utf8'));
      const S = global.Solar91PortalSort;
      const cols = [{ key: 'n', label: 'N', sort: (r) => r.n }, { key: 't', label: 'T', sort: (r) => r.t }];
      const rows = [{ n: 10, t: 'b' }, { n: 2, t: null }, { n: null, t: 'a' }, { n: 7, t: 'c' }];
      const fail = (m) => { throw new Error(m); };
      const asc = S.apply(rows, { key: 'n', dir: 'asc' }, cols).map((r) => r.n);
      if (String(asc) !== '2,7,10,') fail('ascending: ' + asc);
      const desc = S.apply(rows, { key: 'n', dir: 'desc' }, cols).map((r) => r.n);
      if (String(desc) !== '10,7,2,') fail('descending keeps the blank last: ' + desc);
      const text = S.apply(rows, { key: 't', dir: 'asc' }, cols).map((r) => r.t);
      if (String(text) !== 'a,b,c,') fail('text: ' + text);
      // A heading shows the direction it is sorted; an unsorted one shows neither.
      const head = S.headerHTML(cols, { key: 'n', dir: 'desc' }, 'data-x');
      if (!/data-x="n" data-dir="desc"/.test(head)) fail('active heading: ' + head);
      if (!/data-x="t" data-dir=""/.test(head)) fail('idle heading: ' + head);
      if (!/aria-sort="descending"/.test(head)) fail('aria-sort: ' + head);
      // Clicking cycles asc then desc.
      const state = { key: '', dir: 'asc' };
      S.next(state, 'n'); if (state.dir !== 'asc') fail('first click is ascending');
      S.next(state, 'n'); if (state.dir !== 'desc') fail('second click flips');
      S.next(state, 't'); if (state.key !== 't' || state.dir !== 'asc') fail('another column restarts');
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stderr or run.stdout


def test_plant_links_open_the_matching_module_or_default_plant_page():
    app = (PORTAL_ASSETS / "js" / "app.js").read_text(encoding="utf-8")
    assert 'ev.target.closest("[data-open-plant]")' in app
    assert 'openBtn.getAttribute("data-open-plant-page")' in app
    assert "Solar91PortalNav.selectPlantPage(openBtn.getAttribute(\"data-open-plant\"), pageId)" in app
    assert "Solar91PortalNav.selectPlant(openBtn.getAttribute(\"data-open-plant\"))" in app

    for module in ("plants-table.js", "liasoning.js", "site-issues.js", "bom.js", "design.js"):
        source = (PORTAL_ASSETS / "js" / module).read_text(encoding="utf-8")
        assert 'class="ep-plantlink"' in source or 'ep-plantlink ep-plantlink--name' in source, module
        assert "data-open-plant=" in source, module

    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    assert 'data-open-plant-page="health"' in issues
    assert 'data-open-plant-page="' + "' + context.type +" in calendar
    assert 'global.Solar91PortalNav.selectPlantPage(plantRow.dataset.issuePlant, "health")' in issues

    # A single plant's own page has nothing to link to, so it keeps a plain cell.
    table = (PORTAL_ASSETS / "js" / "plants-table.js").read_text(encoding="utf-8")
    assert 'var codeCell = mode.kind === "single"' in table
    styles = (PORTAL_ASSETS / "css" / "components.css").read_text(encoding="utf-8")
    assert ".ep-plantlink" in styles


def test_details_and_health_header_filters_are_limited_to_head_and_assignee():
    plants = (PORTAL_ASSETS / "js" / "plants-table.js").read_text(encoding="utf-8")
    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")
    assert '["O&M Head", "Assignee"].indexOf(user.role) !== -1' in plants
    assert "function columnHeaderHTML(column)" in plants
    assert 'data-pt-column-filter-toggle="' in plants
    assert 'data-pt-column-filter-search="' in plants
    assert 'data-pt-column-filter-option="' in plants
    assert 'popover="auto"' in plants
    assert "columnFilterRowHTML" not in plants
    assert 'data-pt-column-filter="' not in plants
    assert 'FILTERABLE_COLUMNS.some(function (key)' in plants
    assert '["plant", "equipment", "subpart", "maker", "problem", "assignee", "status"]' in issues
    assert "if (state.canEdit && Object.keys(state.columnFilters).some(function (key)" in issues
    assert 'data-issue-column-filter-toggle="' in issues
    assert 'popover="auto"' in issues
    assert 'data-issue-column-filter-search="' in issues
    assert 'data-issue-column-filter-option="' in issues
    assert "function issueColumnOptions(key)" in issues
    assert "state.rows.forEach(function (issue)" in issues
    assert 'placeholder="Search options..."' in issues


def test_health_occurrence_date_age_uses_calendar_days():
    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "site-issues.css").read_text(encoding="utf-8")
    assert "function elapsedDays(date, today)" in issues
    assert "occurrenceDateCell(issue.occurredAt)" in issues
    assert 'class="ep-issues__date-age"' in issues
    assert ".ep-issues__date-age" in styles
    script = r"""
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const source=fs.readFileSync('assets/js/site-issues.js','utf8');
      const start=source.indexOf('function elapsedDays(');
      assert(start>=0,'elapsedDays missing');
      const open=source.indexOf('{',start);let depth=0,end=-1;
      for(let i=open;i<source.length;i++){
        if(source[i]==='{')depth++;
        else if(source[i]==='}'&&--depth===0){end=i+1;break}
      }
      const box={};vm.createContext(box);
      vm.runInContext(source.slice(start,end)+';this.elapsedDays=elapsedDays',box);
      assert.strictEqual(box.elapsedDays('2026-11-03','2026-11-13'),10);
      assert.strictEqual(box.elapsedDays('2024-02-28','2024-03-01'),2);
      assert.strictEqual(box.elapsedDays('2026-11-13','2026-11-13'),0);
      assert.strictEqual(box.elapsedDays('2026-11-15','2026-11-13'),-2);
      assert.strictEqual(box.elapsedDays('2026-02-30','2026-03-01'),null);
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=20)
    assert run.returncode == 0, run.stderr or run.stdout


def test_module_cleaning_board_shows_every_plant_and_opens_one_plants_calendar():
    """Views → Module Cleaning (and the Overview tile) is a board of plant cards; a card opens that
    plant's own cleaning calendar. One request feeds it, and the colour is the server's own
    lateness bucket, so the board and the calendar cannot disagree."""
    board = (PORTAL_ASSETS / "js" / "washing-board.js").read_text(encoding="utf-8")
    nav = (PORTAL_ASSETS / "js" / "navigation.js").read_text(encoding="utf-8")
    page = TEMPLATE.read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "washing-board.css").read_text(encoding="utf-8")

    assert "/assets/js/washing-board.js" in page
    assert "/assets/css/washing-board.css" in page
    assert 'data-tab-view="washing-board"' in page and "data-washing-board-host" in page

    # One read, the same figures the plant calendar uses.
    assert '"/api/scheduled/washing/overview?month="' in board
    assert "include_reports=false" in board

    # on_track / 1d / 3d / 7d are the server's buckets; they become the three words and colours.
    assert 'on_track: { key: "ontrack", label: "On track" }' in board
    assert '"3d": { key: "behind", label: "Behind" }' in board
    assert '"7d": { key: "late", label: "Really behind" }' in board
    for cls in ("ep-wb__card--ontrack", "ep-wb__card--behind", "ep-wb__card--late"):
        assert cls in styles

    # What a card carries: cycle ring, the three cycle pips, tables cleaned, assignee.
    for piece in ("ep-wb__ring", "ep-wb__pips", "ep-wb__tables", "ep-wb__assignee", "No tables cleaned"):
        assert piece in board
    assert 'class="ep-wb__date-label">Last Updated :' in board
    assert ".ep-wb__date-label {" in styles
    assert 'font-family: var(--ep-font-mono, "JetBrains Mono", monospace);' in styles

    # A card opens that plant's Module Cleaning page.
    assert 'Solar91PortalNav.selectPlantPage(card.getAttribute("data-wb-plant"), "washing")' in board

    # Portfolio-wide Module Cleaning is the board; one plant is still the calendar.
    assert 'if (calendarType === "washing" && !plantCode && global.Solar91PortalWashingBoard)' in nav
    assert "Solar91PortalWashingBoard.show(document.querySelector(\"[data-washing-board-host]\"))" in nav


def test_a_plants_module_cleaning_calendar_opens_on_the_week():
    """A plant's cleaning calendar opens on the current week (seven cells), with Month still one
    click away. PM and the portfolio calendar are untouched and still open on the month."""
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")

    assert 'span: context.type === "washing" && context.plantCode ? "week" : "month",' in calendar
    assert "weekStart: weekStartOf(" in calendar
    assert 'var week = state.span === "week";' in calendar
    assert "var cells = week ? 7 :" in calendar
    # ‹ › move a week at a time, and the month follows so that week's records are read.
    assert "state.weekStart = shiftDays(state.weekStart, shift * 7);" in calendar
    assert "state.month = state.weekStart.slice(0, 7);" in calendar
    # The Week / Month switch.
    assert 'data-calendar-action="span-week"' in calendar
    assert 'data-calendar-action="span-month"' in calendar
    assert "displayWeek(state.weekStart)" in calendar


def test_overview_inverter_tile_counts_units_and_opens_inverter_issues():
    """The fourth tile: how many inverters are running against how many are installed, narrowed by
    the Overview filters, opening the site-issues register filtered to inverter tickets."""
    overview = (PORTAL_ASSETS / "js" / "overview.js").read_text(encoding="utf-8")
    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")

    assert 'title: "Inverters"' in overview
    assert 'destination: "inverters"' in overview
    # Nothing is invented: units come from the saved PM unit configuration, and "not running"
    # from the server's count of open Inverter tickets and the units they name.
    assert '"/api/pm-plan/unit-config"' in overview
    assert '"/api/issues/equipment-summary?vertical=Inverter"' in overview
    assert "tickets += Number(row.open) || 0;" in overview
    assert "down += Number(row.units) || 0;" in overview
    # The filters narrow it: only the plants the tiles are showing are counted.
    assert "const codes = new Set(state ? state.rows.map(({ plant }) => plant.siteCode) : []);" in overview
    # The unit configuration is not open to every role; the tile still shows the tickets.
    assert "inverters.unitsRestricted = true;" in overview
    assert "Unit counts are not available to your role" in overview
    # Opening it: this plant when one is filtered, the portfolio otherwise.
    assert 'if (destination === "inverters") {' in overview
    assert 'Solar91PortalIssues.presetEquipment("Inverter")' in overview
    assert 'global.Solar91PortalNav.selectView("health", dateRange);' in overview

    # The register honours the preset and offers a way back to every category.
    assert "equipmentFilter:" in issues
    assert "presetEquipment: presetEquipment" in issues
    assert 'data-issue-action="clear-equipment"' in issues
    assert 'state.equipmentFilter &&' in issues


def test_site_issue_register_places_id_before_action_and_labels_description():
    """Issue ID is beside Action, with the description and date columns before them."""
    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")
    columns = issues[issues.index("var COLUMNS = ["):issues.index("  function renderTable(rows)")]
    order = re.findall(r'\{ key: "([a-zA-Z]+)"', columns)
    assert order == [
        "plant", "equipment", "subpart", "problem", "maker", "occurred",
        "etc", "assignee", "status", "id", "action"
    ], order
    assert '{ key: "problem", label: "Issue Description"' in columns
    assert '{ key: "occurred", label: "Occurred on"' in columns
    assert '{ key: "etc", label: "Est. completion"' in columns
    assert 'subpart: issue.subpart' in issues
    assert 'var FILTERABLE_ISSUE_COLUMNS = ["plant", "equipment", "subpart", "maker", "problem", "assignee", "status"]' in issues
    # Both read stored fields: occurred_at and etc_at, already mapped onto the row.
    assert "occurredAt: String(issue.occurred_at" in issues
    assert "dueAt: issue.etc_at" in issues
    # A ticket with no ETC says so rather than showing an empty cell.
    assert 'if (!value) return \'<span class="ep-issues__unassigned">Not set</span>\';' in issues


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

def test_plant_and_view_sub_pages_are_the_live_pages_only():
    """Asset & Warranty was removed from the portal; no sub-page, host or route may survive it."""
    nav = (PORTAL_ASSETS / "js" / "navigation.js").read_text(encoding="utf-8")
    for block in ("PLANT_SUB_PAGES", "VIEW_SUB_PAGES"):
        start = nav.index(block)
        section = nav[start:nav.index("];", start)]
        ids = re.findall(r'id:\s*"([a-z-]+)"', section)
        assert ids == ["details", "health", "pm", "washing", "movable-assets"], (block, ids)
    page = TEMPLATE.read_text(encoding="utf-8")
    for dead in ("asset-warranty", "data-asset-warranty-host", "Solar91PortalAssetWarranty"):
        assert dead not in nav, dead
        assert dead not in page, dead
    assert not (PORTAL_ASSETS / "js" / "asset-warranty.js").exists()
    assert not (PORTAL_ASSETS / "css" / "asset-warranty.css").exists()
    register = (PORTAL_ASSETS / "js" / "register-io.js").read_text(encoding="utf-8")
    assert "/api/asset-warranty" not in register


def test_plant_details_page_is_wired_up():
    page = TEMPLATE.read_text(encoding="utf-8")
    assert "data-plant-details-host" in page
    assert "/assets/js/plant-details.js" in page
    assert "/assets/css/plant-details.css" in page
    nav = (PORTAL_ASSETS / "js" / "navigation.js").read_text(encoding="utf-8")
    # Details is the plant table either way: one plant's row when a plant is
    # selected, every plant's row portfolio-wide.
    assert "Solar91PortalPlantsTable" in nav
    assert "siteCode: plantCode" in nav
    assert "section: navState.selectedDetailSection" in nav
    assert "data-plant-details-host" in nav


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


def test_plant_and_portfolio_details_sections_are_in_left_navigation():
    table = (PORTAL_ASSETS / "js" / "plants-table.js").read_text(encoding="utf-8")
    navigation = (PORTAL_ASSETS / "js" / "navigation.js").read_text(encoding="utf-8")
    page = TEMPLATE.read_text(encoding="utf-8")
    for section in ("design-mdl", "liasoning", "bom"):
        assert section in navigation
        assert f'data-nav="view:details:{section}"' in page
    assert 'var navId = "plant:" + siteCode + ":" + page.id;' in navigation
    assert "(parts.length === 3 || parts.length === 4)" in navigation
    assert 'section: navState.selectedDetailSection' in navigation
    assert "data-pt-detail-tab" not in table
    assert "ep-pt__detail-tabs" not in table
    assert 'var DETAIL_SECTIONS = ["details", "design-mdl", "liasoning", "bom"];' in table
    assert 'detailSection === "details"' in table
    assert 'data-detail-section="' in table
    assert 'if (loaded) {' in table


def test_design_mdl_renders_empty_index_and_saves_a_merged_custom_fields_patch():
    page = TEMPLATE.read_text(encoding="utf-8")
    table = (PORTAL_ASSETS / "js" / "plants-table.js").read_text(encoding="utf-8")
    module = (PORTAL_ASSETS / "js" / "design.js").read_text(encoding="utf-8")
    assert (PORTAL_ASSETS / "css" / "design.css").exists()
    assert page.index('/assets/js/bom.js"') < page.index('/assets/js/design.js"')
    assert page.index('/assets/css/plant-details.css"') < page.index('/assets/css/design.css"')
    assert 'detailSection === "design-mdl" && global.Solar91PortalDesign' in table
    assert "global.Solar91PortalDesign.show(container, { siteCode: mode.siteCode });" in table
    assert table.index("Solar91PortalBom.show") < table.index("Solar91PortalDesign.show") < table.index("if (loaded) {")
    assert "global.Solar91PortalDesign = {" in module

    script = r"""
      global.window = global;
      global.document = { activeElement: null };
      require('./assets/js/format.js');
      const plant = { dbId: '7', siteCode: 'ABH01', plantName: 'Abhaneri 01', displayName: 'Abhaneri',
        district: 'Dausa', projectCompany: 'P1', customFields: { cctv_url: 'https://cctv.example.invalid/a' } };
      let rows = [{ plant: plant, profile: {} }], invalidated = 0, patches = [];
      global.Solar91PortalData = {
        fetchPortfolio: () => Promise.resolve({ rows: rows }),
        invalidate: () => { invalidated++; }
      };
      global.Solar91PortalAPI = {
        can: (perm) => perm === 'plants.manage',
        currentUser: () => ({ role: 'O&M Head' }),
        // The freshly read record carries a key this page has not seen; the save must keep it.
        plants: () => Promise.resolve([Object.assign({}, plant, { customFields: { cctv_url: 'https://cctv.example.invalid/a',
          design_link: 'https://folder.example.invalid/ABH01', design_index: { legacy_extra: true } } })]),
        request: (url, opts) => { patches.push({ url, opts }); return Promise.resolve({}); }
      };
      require('./assets/js/design.js');

      function container() {
        const el = { isConnected: true, html: '', nodes: {}, checks: [] };
        Object.defineProperty(el, 'innerHTML', {
          get() { return el.html; },
          set(v) {
            el.html = v; el.nodes = {};
            el.checks = [...v.matchAll(/data-dsn-check="([a-z0-9_]+)"( checked)?/g)].map(m => ({ checked: !!m[2], getAttribute: () => m[1] }));
          }
        });
        el.querySelector = (sel) => {
          const key = (sel.match(/^\[(data-dsn-[a-z]+)\]$/) || [])[1];
          if (!key || el.html.indexOf(key) === -1) return null;
          return el.nodes[key] || (el.nodes[key] = { on: {}, textContent: '', classList: { toggle() {} },
            addEventListener(t, f) { this.on[t] = f; }, click() { this.on.click(); } });
        };
        el.querySelectorAll = (sel) => sel === '[data-dsn-check]' ? el.checks : [];
        return el;
      }
      const tick = () => new Promise(r => setTimeout(r, 0));
      const fail = (msg) => { throw new Error(msg); };

      (async () => {
        const reg = Solar91PortalDesign.REGISTER;
        if (reg.length !== 32 || reg.filter(d => d.section === 'key').length !== 10) fail('register size changed');

        // Portfolio with no design data: every plant row still renders with placeholders.
        const all = container();
        await Solar91PortalDesign.show(all, {});
        if (!all.html.includes('Not set') || !all.html.includes('0/32') || !all.html.includes('0/22')) fail('portfolio placeholders missing');
        if (!all.html.includes('data-dsn-export')) fail('portfolio CSV export missing');

        // Single plant with no design data: full two-section index, every drawing "Not added".
        const one = container();
        await Solar91PortalDesign.show(one, { siteCode: 'ABH01' });
        const html = one.html;
        if (!html.includes('Abhaneri · Design/MDL')) fail('header missing');
        if (!html.includes('Link not added yet') || html.includes('<a class="ep-dsn__code"')) fail('missing link should render plain');
        if (!html.includes('<strong>0</strong>/32 present')) fail('counter missing');
        if (html.indexOf('Key drawings') < 0 || html.indexOf('Key drawings') > html.indexOf('Miscellaneous')) fail('sections missing');
        if ((html.match(/class="ep-dsn__tile is-off"/g) || []).length !== 32) fail('every drawing should show as not added');
        if (html.includes('class="ep-dsn__tile is-on"')) fail('no drawing should show as added');
        if (!html.includes('data-dsn-edit')) fail('edit toggle missing for plants.manage');

        // Edit -> tick GA Layout -> Save sends the merged custom_fields.
        one.querySelector('[data-dsn-edit]').click();
        if (one.checks.length !== 32) fail('edit mode should show a checkbox per drawing');
        one.checks.find(c => c.getAttribute() === 'ga').checked = true;
        rows = [{ plant: Object.assign({}, plant, { customFields: { cctv_url: 'https://cctv.example.invalid/a',
          design_link: 'https://folder.example.invalid/ABH01', design_index: { ga: true, legacy_extra: true } } }), profile: {} }];
        one.querySelector('[data-dsn-save]').click();
        for (let i = 0; i < 6; i++) await tick();
        if (patches.length !== 1) fail('expected one PATCH, got ' + patches.length);
        const p = patches[0];
        if (p.url !== '/api/plants/7' || p.opts.method !== 'PATCH') fail('wrong PATCH target ' + p.url);
        const cf = p.opts.body.custom_fields;
        if (cf.cctv_url !== 'https://cctv.example.invalid/a') fail('cctv_url was dropped');
        if (cf.design_link !== 'https://folder.example.invalid/ABH01') fail('design_link was dropped');
        if (JSON.stringify(cf.design_index) !== JSON.stringify({ legacy_extra: true, ga: true })) fail('bad index ' + JSON.stringify(cf.design_index));
        if (!invalidated) fail('cache not invalidated');
        if (!one.html.includes('<strong>1</strong>/32 present') || !one.html.includes('href="https://folder.example.invalid/ABH01"')) fail('saved state not re-rendered');
        if (one.nodes['data-dsn-status'].textContent !== 'Saved.') fail('success not shown');
      })().catch(e => { console.error(e.message); process.exit(1); });
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=20)
    assert run.returncode == 0, run.stderr


def test_plant_table_uses_balanced_shared_columns_and_numeric_spv_label():
    styles = (PORTAL_ASSETS / "css" / "components.css").read_text(encoding="utf-8")
    widths = [
        int(value) for value in re.findall(
            r"\.ep-pt__table th:nth-child\(\d+\), \.ep-pt__table td:nth-child\(\d+\) \{ width: (\d+)%; \}",
            styles,
        )
    ]
    assert len(widths) == 15      # + PM Assignee and Health Assignee
    assert sum(widths) == 100
    assert widths[11] >= 7, "the Location column should not wrap its heading"
    # Every column shares the frame on a desktop: no table minimum width, so nothing scrolls sideways.
    # A phone is too narrow to fit 15 columns legibly, so the scroll fallback lives in that media query only.
    assert "width: 100%; min-width: 0; table-layout: fixed" in styles
    assert "min-width: 1200px" not in styles
    assert "@media (max-width: 700px) {\n  .ep-pt__table { min-width: 1080px; }" in styles
    assert "overflow-x: auto" in styles
    table = (PORTAL_ASSETS / "js" / "plants-table.js").read_text(encoding="utf-8")
    assert "function spvNumber(plant)" in table
    assert '{ key: "assignee",  label: "Cleaning Assignee",' in table
    assert '{ key: "pmAssignee",     label: "PM Assignee",' in table
    assert '{ key: "healthAssignee", label: "Health Assignee",' in table
    assert table.index('{ key: "location",  label: "Location",') < table.index('{ key: "cctv",      label: "CCTV",')
    assert table.index('{ key: "cctv",      label: "CCTV",') < table.index('{ key: "activity",  label: "Last Activity",')
    assert 'plant.customFields && plant.customFields.cctv_url' in table
    assert 'url.protocol === "http:" || url.protocol === "https:"' in table
    assert '<span class="ep-pt__cctv-placeholder">Add link</span>' in table
    assert 'class="ep-pt__loc" href="' in table
    assert 'aria-label="Open CCTV feed for ' in table
    assert "cctvUrl(p)" in table

    script = """
      const fs = require('fs');
      const vm = require('vm');
      global.window = global;
      require('./assets/js/portal-api.js');
      const plant = Solar91PortalAPI.normalizePlant({
        id: 1, site_code: 'ABH01',
        project_company: 'Solar91 Project Thirty Five Private Limited',
        custom_fields: { cctv_url: 'https://cctv.example.invalid/feed' }
      });
      if (plant.projectCompanyShort !== 'SPV 35') {
        throw new Error('Expected numeric project label, got ' + plant.projectCompanyShort);
      }
      const source = fs.readFileSync('assets/js/plants-table.js', 'utf8');
      const start = source.indexOf('function cctvUrl(plant)');
      if (start < 0) throw new Error('CCTV URL resolver is missing');
      const open = source.indexOf('{', start);
      let depth = 0, end = -1;
      for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}' && --depth === 0) { end = i + 1; break; }
      }
      const box = { URL };
      vm.createContext(box);
      vm.runInContext(source.slice(start, end) + ';this.resolve=cctvUrl;', box);
      if (box.resolve(plant) !== 'https://cctv.example.invalid/feed') {
        throw new Error('Configured CCTV URL was not preserved');
      }
      if (box.resolve({ customFields: { cctv_url: 'javascript:alert(1)' } }) !== '') {
        throw new Error('Unsafe CCTV URL protocol was accepted');
      }
      if (box.resolve({ customFields: {} }) !== '') {
        throw new Error('Missing CCTV URL should not create a link');
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
    assert 'data-calendar-action="open-setup">Set up module cleaning' in calendar
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
    assert ".ep-calendar__grid {\n  display: grid;\n  grid-template-columns: repeat(7, minmax(0, 1fr));\n  height: auto;" in styles
    assert ".ep-calendar__grid--weeks-6 { grid-template-rows: 34px repeat(6, minmax(128px, auto)); }" in styles
    assert ".ep-calendar__grid--weeks-6 { grid-template-rows: 28px repeat(6, minmax(144px, auto)); }" in styles
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
    # Equipment, Part and Maintenance task are pickers built from the category
    # list, so their attribute is assembled at runtime — see the picker test below.
    for field in ("equipment", "part", "task"):
        assert 'picker("' + field + '"' in calendar
    assert 'field("partNumber"' in calendar
    assert 'field("startDate"' in calendar
    assert 'data-pm-setup-field="frequency"' in calendar
    assert 'data-pm-setup-field="remarks"' in calendar
    assert "Add another PM item" in calendar
    assert "Preview setup" in calendar
    assert "Frontend preview only. Nothing is saved or scheduled yet." in calendar
    assert "renderPMSetupModal(state, context)" in calendar
    assert "/api/pm-plan/" not in calendar
    assert ".ep-calendar__pm-setup-fields" in styles
    assert ".ep-calendar__pm-setup-preview-items" in styles


def test_pm_setup_equipment_part_and_task_are_pickers_driven_by_work_categories():
    """Equipment, Part and Maintenance task come from the category list, and cascade.

    Equipment is the category, Part comes from that category's pm_parts, and the
    Maintenance task comes from the chosen part. Each is a datalist-backed input,
    so it drops down, filters as you type, and still accepts a value that is not
    on the list yet. Part number is free text: it belongs to the unit on site,
    not to the category.
    """
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "calendar.css").read_text(encoding="utf-8")

    assert 'api.request("/api/categories")' in calendar, "the picker lists come from the API"
    assert "function pmPartsFor(equipment)" in calendar
    assert "function pmTasksFor(equipment, part)" in calendar

    # the three cascading pickers, and part number left as a plain field
    assert 'picker("equipment", "Equipment"' in calendar
    assert 'picker("part", "Part"' in calendar
    assert 'picker("task", "Maintenance task"' in calendar
    assert 'field("partNumber", "Part number (optional)", "text", false)' in calendar

    # a datalist, not a <select>: typing a value that is not listed still works
    assert '<datalist id="' in calendar
    assert 'list="' + "' + listId + '" in calendar

    # changing the equipment clears the part and task below it
    assert 'if (field === "equipment") { item.part = ""; item.partNumber = ""; }' in calendar
    assert ".ep-calendar__pm-setup-hint" in styles

    # "subpart" was a fault field borrowed from Site Issues; PM uses parts instead
    assert "subpart" not in calendar


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
    assert 'data-calendar-action="open-record">Record module cleaning' in calendar
    assert '"/api/scheduled/washing/daily-reports/sheet"' in calendar
    assert "table_numbers: row.numbers" in calendar  # the sheet now sends the exact tables of each day
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


def test_health_issue_date_filter_is_local_and_supports_a_date_range():
    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "site-issues.css").read_text(encoding="utf-8")
    header = issues[issues.index("function renderHeader"):issues.index("function renderFilters")]
    assert 'aria-label="Filter issues by occurrence date"' in header
    assert ">Range</span>" in header
    assert 'data-issue-date-mode' in header and 'data-issue-date-period' in header
    assert 'value="month"' in header and "Selected month</option>" in header
    assert 'type="month" data-issue-month' in header
    assert 'data-issue-date-start' in header and 'data-issue-date-end' in header
    assert 'data-issue-date-start' in issues and 'data-issue-date-end' in issues
    assert 'data-issue-date-apply' not in issues
    assert 'data-issue-date-clear' in issues
    assert 'state.issueDateRangeMode = event.target.checked;' in issues
    assert 'datePeriodRange(state.issueDatePeriod, today)' in issues
    assert 'state.issueMonth = today.slice(0, 7);' in issues
    assert 'monthPeriodRange(state.issueMonth, today)' in issues
    assert 'return { start: today.slice(0, 8) + "01", end: today };' in issues
    assert 'event.target.matches("[data-issue-date-start]") ||' in issues
    assert 'state.issueDateStart = dateStart;' in issues
    assert 'state.issueDateEnd = dateEnd;' in issues
    assert 'if (event.target.matches("[data-issue-month]"))' in issues
    assert 'url += "&occurred_from=" + encodeURIComponent(state.issueDateStart + "T00:00:00Z");' in issues
    assert 'url += "&occurred_to=" + encodeURIComponent(state.issueDateEnd + "T23:59:59.999999Z");' in issues
    assert "issue.occurredAt < state.issueDateStart" in issues
    assert "issue.occurredAt > state.issueDateEnd" in issues
    assert "state.issueDateStart = context.startDate || \"\";" in issues
    assert "state.issueDateDraftStart = state.issueDateStart;" in issues
    clear_action = issues[issues.index('action === "clear"'):issues.index("renderView();", issues.index('action === "clear"'))]
    assert 'state.issueDatePeriod = "all";' in clear_action
    assert 'state.issueDateRangeMode = false;' in clear_action
    assert "issue.occurredAt < context.startDate" not in issues
    assert ".ep-issues__date-filter" in styles and ".ep-issues__date-separator" in styles
    assert "min-height: 62px;" in styles and "border-radius: 15px;" in styles
    assert ".ep-issues__date-period" in styles
    assert "renderHeader(context)" in issues


def test_module_cleaning_board_can_load_a_past_month():
    board = (PORTAL_ASSETS / "js" / "washing-board.js").read_text(encoding="utf-8")
    assert 'type="month" data-wb-month' in board
    assert 'month.addEventListener("change"' in board
    assert 'show(container, st.selectedMonth)' in board
    assert '"/api/scheduled/washing/overview?month=" + encodeURIComponent(month)' in board
    assert 'data-wb-filter="plant"' in board
    assert 'data-wb-filter="cycle"' in board
    assert 'data-wb-filter="date"' in board
    assert '(row.cleaned_cycles || []).indexOf(Number(ui.cycle))' in board
    assert "function dateOptions()" in board


def test_module_cleaning_board_filters_missing_entries_for_any_past_or_current_date():
    board = (PORTAL_ASSETS / "js" / "washing-board.js").read_text(encoding="utf-8")
    assert 'data-wb-filter="entryStatus"' in board
    assert ">No entry</option>" in board
    assert '"/api/scheduled/washing/day-activity?day="' in board
    assert 'ui.entryStatus === "missing"' in board
    assert 'if (ui.date !== "__all") {' in board
    assert "No entry · " in board

    script = r"""
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const source=fs.readFileSync('assets/js/washing-board.js','utf8');
      function extract(name){
        const start=source.indexOf('function '+name+'(');
        assert(start>=0,name+' missing');
        const open=source.indexOf('{',start);let depth=0,end=-1;
        for(let i=open;i<source.length;i++){
          if(source[i]==='{')depth++;
          else if(source[i]==='}'&&--depth===0){end=i+1;break}
        }
        return source.slice(start,end);
      }
      const box={
        st:{month:'2026-10',selectedMonth:'2026-10',today:'2026-10-12'},
        ui:{date:'__all'},
        pad2:n=>String(n).padStart(2,'0'),
        shortDate:s=>s,
        escape:s=>String(s)
      };
      vm.createContext(box);
      vm.runInContext(extract('dateOptions')+';this.dates=dateOptions;'+
        extract('entryStatusMatches')+';this.matches=entryStatusMatches',box);
      const dates=box.dates();
      assert(dates.includes('value="2026-10-12"'));
      assert(!dates.includes('value="2026-10-13"'),'future dates must not appear');
      assert.strictEqual(box.matches('not_reported','missing'),true);
      for(const status of ['confirmed','awaiting','not_done','rejected'])
        assert.strictEqual(box.matches(status,'recorded'),true,status);
      for(const status of ['paused','upcoming','not_reported'])
        assert.strictEqual(box.matches(status,'recorded'),false,status);
      assert.strictEqual(box.matches('paused','missing'),false);
      assert.strictEqual(box.matches('not_reported','__all'),true);
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=20)
    assert run.returncode == 0, run.stderr or run.stdout


def test_calendar_day_cells_show_saved_washing_table_numbers():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "calendar.css").read_text(encoding="utf-8")
    assert "renderCalendarEventChip(event, context)" in calendar
    assert "ep-calendar__event--washing-detail" in calendar
    assert ".ep-calendar__event-tables {" in styles

    script = r"""
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const source=fs.readFileSync('assets/js/operations-calendar.js','utf8');
      const helperStart=source.indexOf('function isWashingCycleComplete(');
      assert(helperStart>=0,'isWashingCycleComplete missing');
      const helperOpen=source.indexOf('{',helperStart);let helperDepth=0,helperEnd=-1;
      for(let i=helperOpen;i<source.length;i++){
        if(source[i]==='{')helperDepth++;
        else if(source[i]==='}'&&--helperDepth===0){helperEnd=i+1;break}
      }
      const start=source.indexOf('function washingTablesLabel(');
      assert(start>=0,'washingTablesLabel missing');
      const open=source.indexOf('{',start);let depth=0,end=-1;
      for(let i=open;i<source.length;i++){
        if(source[i]==='{')depth++;
        else if(source[i]==='}'&&--depth===0){end=i+1;break}
      }
      const box={};vm.createContext(box);
      vm.runInContext(source.slice(helperStart,helperEnd)+'\n'+source.slice(start,end)+';this.label=washingTablesLabel',box);
      const label=box.label;
      assert.strictEqual(label({tablesCleaned:3,tablesList:'1–2, 4'},{type:'washing'}),'Tables: 1–2, 4');
      assert.strictEqual(label({tablesCleaned:3,tablesList:''},{type:'washing'}),'Table numbers not recorded');
      assert.strictEqual(label({tablesCleaned:0,tablesList:''},{type:'washing'}),'');
      assert.strictEqual(label({tablesCleaned:3,tablesList:'1–2, 4'},{type:'pm'}),'');
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=20)
    assert run.returncode == 0, run.stderr or run.stdout


def test_calendar_shows_confirmed_cycle_completion_distinct_from_deadline():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "calendar.css").read_text(encoding="utf-8")
    assert 'cycleCompleted: report.review_status === "Confirmed" && report.cycle_completed === true' in calendar
    assert 'event.kind === "washing.done" && event.status === "Confirmed"' in calendar
    assert ".ep-calendar__event--cycle-complete {" in styles
    assert "background: linear-gradient(120deg, #006b32, #004b24);" in styles
    assert ".ep-calendar__day-events {\n  display: flex;\n  flex: 0 0 auto;" in styles
    assert ".ep-calendar__event--cycle-complete {\n  white-space: normal;\n  overflow-wrap: anywhere;" in styles
    assert ".ep-calendar__event--complete {" in styles
    assert ".ep-calendar__event--deadline:not(.ep-calendar__event--overdue)" in styles
    assert "background: linear-gradient(120deg, #edf2fb, #dfe8f7);" in styles

    script = r"""
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const source=fs.readFileSync('assets/js/operations-calendar.js','utf8');
      const start=source.indexOf('function statusClass(');
      const end=source.indexOf('  function visibleEvents(',start);
      assert(start>=0&&end>start,'calendar chip helpers missing');
      const box={escape:value=>String(value)};vm.createContext(box);
      vm.runInContext(source.slice(start,end)+
        ';this.chip=renderCalendarEventChip;this.statusClass=statusClass;this.deadlineStatus=washingDeadlineStatus',box);
      const context={type:'washing'};
      assert.strictEqual(box.deadlineStatus({state:'In progress',due_date:'2026-11-10',late_days:2},'2026-11-14'),'Behind');
      assert.strictEqual(box.deadlineStatus({state:'Missed',due_date:'2026-11-07',late_days:7},'2026-11-14'),'Really behind');
      assert.strictEqual(box.deadlineStatus({state:'Upcoming',due_date:'2026-11-20',late_days:0},'2026-11-14'),'Scheduled');
      assert.strictEqual(box.deadlineStatus({state:'Completed',due_date:'2026-11-10',late_days:0},'2026-11-14'),'Completed');
      assert.strictEqual(box.statusClass('Behind'),'ep-calendar__event--behind');
      assert.strictEqual(box.statusClass('Really behind'),'ep-calendar__event--overdue');
      assert.strictEqual(box.statusClass('Awaiting confirmation'),'ep-calendar__event--awaiting');
      assert.strictEqual(box.statusClass('Rejected'),'ep-calendar__event--overdue');
      assert.strictEqual(box.statusClass('Scheduled'),'ep-calendar__event--scheduled');
      const plant=box.chip({title:'50 tables cleaned',status:'Completed',kind:'report',
        cycleNo:2,cycleCompleted:true,tablesCleaned:50,tablesList:'1–50'},context);
      const plantChips=plant.split('<span class="ep-calendar__event ');
      assert.strictEqual(plantChips.length-1,2,'report and cycle completion render as separate chips');
      assert(plantChips[1].includes('ep-calendar__event--complete'),'table report keeps regular completed style');
      assert(!plantChips[1].includes('ep-calendar__event--cycle-complete'),'table report is not the completion chip');
      assert(plantChips[1].includes('50 tables cleaned'),'table report title and count');
      assert(plantChips[1].includes('Tables: 1–50'),'table report numbers');
      assert(plantChips[2].includes('ep-calendar__event--cycle-complete'),'plant completion style');
      assert(plantChips[2].includes('Cycle 2 completed'),'plant completion message');
      const portfolio=box.chip({title:'Cycle 2 · 50 tables cleaned',status:'Confirmed',
        kind:'washing.done',reference:'Cycle 2',tablesCleaned:50,tablesList:'1–50'},context);
      assert.strictEqual((portfolio.match(/<span class="ep-calendar__event /g)||[]).length,2,
        'portfolio report and cycle completion render as separate chips');
      assert(portfolio.includes('ep-calendar__event--complete'),'confirmed portfolio wash uses completed colors');
      assert(portfolio.includes('Cycle 2 completed'),'portfolio completion message');
      const awaiting=box.chip({title:'Cycle 2 · 50 tables cleaned',status:'Pending',
        kind:'washing.done',reference:'Cycle 2',tablesCleaned:50,tablesList:'1–50'},context);
      assert(!awaiting.includes('ep-calendar__event--cycle-complete'),'unconfirmed cycle is not complete');
      assert(awaiting.includes('Cycle 2 · 50 tables cleaned'),'unconfirmed report keeps its report title');
      const deadline=box.chip({title:'Cycle 2 deadline',status:'Completed',kind:'deadline'},context);
      assert(deadline.includes('ep-calendar__event--deadline'),'deadline gets a distinct style');
      assert(!deadline.includes('ep-calendar__event--cycle-complete'),'deadline is not a completion report');
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=20)
    assert run.returncode == 0, run.stderr or run.stdout


def test_health_month_filter_uses_complete_month_bounds():
    script = r"""
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const source=fs.readFileSync('assets/js/site-issues.js','utf8');
      const start=source.indexOf('function monthPeriodRange(');
      assert(start>=0,'monthPeriodRange missing');
      const open=source.indexOf('{',start);let depth=0,end=-1;
      for(let i=open;i<source.length;i++){
        if(source[i]==='{')depth++;
        else if(source[i]==='}'&&--depth===0){end=i+1;break}
      }
      const box={};vm.createContext(box);
      vm.runInContext(source.slice(start,end)+';this.range=monthPeriodRange',box);
      const range=(month,today)=>JSON.parse(JSON.stringify(box.range(month,today)));
      assert.deepStrictEqual(range('2024-02','2024-03-10'),{start:'2024-02-01',end:'2024-02-29'});
      assert.deepStrictEqual(range('2026-10','2026-11-13'),{start:'2026-10-01',end:'2026-10-31'});
      assert.deepStrictEqual(range('2026-11','2026-11-13'),{start:'2026-11-01',end:'2026-11-13'});
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=20)
    assert run.returncode == 0, run.stderr or run.stdout


def test_health_loading_does_not_wait_for_categories_and_table_search_is_debounced():
    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")
    plants = (PORTAL_ASSETS / "js" / "plants-table.js").read_text(encoding="utf-8")

    issue_load = issues[issues.index("function load()"):issues.index("function loadCategoriesForWizard")]
    assert "loadLiveIssues(requestId)" in issue_load
    assert "loadCategories()" not in issue_load
    assert "loadCategoriesForWizard(host)" in issues
    assert 'data-issue-action="retry-categories"' in issues
    assert "setTimeout(function ()" in issues and "}, 120);" in issues
    assert "setTimeout(function ()" in plants and "}, 120);" in plants


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

def test_record_sheet_lets_managers_edit_saved_days_through_the_report_patch():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "calendar.css").read_text(encoding="utf-8")

    # The Edit button is offered only where the server says the viewer may change the day.
    assert "row.report.can_edit && !state.recordSaving" in calendar
    assert 'data-record-edit="' in calendar
    # Saving goes through the existing report PATCH, with the table range for numbered days.
    assert '"/api/scheduled/washing/daily-reports/" + encodeURIComponent(pending.id)' in calendar
    assert 'method: "PATCH"' in calendar
    assert "body.table_numbers = parsed.numbers;" in calendar  # an edited day sends the exact tables
    # A failed save stays visible in the editor and is never reported as success.
    assert 'saveState.recordEdit.error = "Not saved. "' in calendar
    assert 'saveState.recordNotice = "Day updated.";' in calendar
    assert "if (pending.saving) return;" in calendar  # no double submit
    assert ".ep-calendar__record-row--editing" in styles and ".ep-calendar__record-edit" in styles


def test_record_sheet_saves_a_zero_tables_day_like_the_excel_upload():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    assert "data-record-zero" in calendar and "0 cleaned" in calendar
    # a ticked day is sent as not done / "Other" / 0 tables and never carries a table range
    assert 'job_status: "Not done",' in calendar and 'exception_reason: "Other",' in calendar
    assert "tables_cleaned: 0," in calendar
    # Save is enabled for a zero day even though no last table number was typed
    assert "function rowEntered(row)" in calendar and "row.zero" in calendar


def test_record_sheet_tracks_exactly_which_tables_were_cleaned():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    # three ways to enter a day: from the start, from the end, or any list such as 1, 2, 4, 7-8, 13 / 100-91
    assert 'modes = [["start", "From start"], ["end", "From end"], ["pick", "Pick tables"]]' in calendar
    assert "function parseTableList(text, total)" in calendar and "function planDay(state, draft, used, total, movedTo)" in calendar
    # the exact tables are sent, shown for every saved day, and summarised for the cycle
    assert "table_numbers: row.numbers," in calendar
    assert "formatTableList(row.numbers)" in calendar
    assert "Cleaned this cycle:" in calendar and "Not cleaned yet:" in calendar


def test_record_sheet_keeps_number_entry_without_browser_stepper():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    styles = (PORTAL_ASSETS / "css" / "calendar.css").read_text(encoding="utf-8")
    assert 'data-record-end value="' in calendar
    assert 'data-record-edit-count value="' in calendar
    assert ".ep-calendar__record-range input[data-record-end],\n.ep-calendar__record-row--editing input[data-record-edit-count] {\n  appearance: textfield;" in styles
    assert "input[data-record-end]::-webkit-inner-spin-button" in styles
    assert "input[data-record-edit-count]::-webkit-outer-spin-button" in styles


def test_calendar_day_detail_lists_the_cleaned_tables():
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    assert '["Which tables", event.tablesList]' in calendar
    assert "tablesList: formatTableList(tableNumbersOf(report))" in calendar


def test_bom_table_merges_sections_splits_maker_and_supplier_and_keeps_boq_order():
    """The BOM table's columns, its merged Section cell and its unformatted quantities.

    Column order, left to right: (Plant) | Section | Item Description | Specs | Maker | Supplier |
    Quantity | Unit | T.R. | W.C. | Item Serial No. | Invoice | (Edit). The Section cell is drawn
    once per block with a rowspan, recomputed on every render, and quantities print as raw digits.
    """
    module = (PORTAL_ASSETS / "js" / "bom.js").read_text(encoding="utf-8")
    assert '{ key: "section", label: "Section", w: ' in module
    assert '{ key: "itemName", label: "Item Description", w: ' in module
    assert '{ key: "maker", label: "Maker", w: ' in module
    assert '{ key: "supplier", label: "Supplier", w: ' in module
    assert module.index('{ key: "itemName"') < module.index('{ key: "specs"') < module.index('{ key: "maker"')
    assert module.index('{ key: "maker"') < module.index('{ key: "supplier"') < module.index('{ key: "quantity"')
    assert module.index('{ key: "quantity"') < module.index('{ key: "unit"') < module.index('{ key: "testReport"')
    assert "Maker/Supplier" not in module and "makerSupplier" not in module
    # Still one table: a merged cell, not grouped header rows, cards or accordions.
    assert "ep-pt__table ep-bom__table" in module
    assert "ep-bom__group" not in module
    assert 'rowspan="' in module and "function sectionBlocks(items)" in module
    # The quantity cell is the only one that drops fmt.formatNumber.
    assert "function qtyText(value)" in module and "fmt.formatNumber(" not in module
    assert 'data-bom-filter="section"' in module and 'data-bom-filter="supplier"' in module
    assert 'step="0.001"' in module and 'data-bom-field="sort_order"' in module
    assert '"/api/bom/sections/order"' in module and 'method: "PATCH"' in module

    script = r"""
      global.window = global;
      global.document = { activeElement: null, body: { appendChild() {}, removeChild() {} },
        createElement: () => ({ click() {}, style: {} }), addEventListener() {}, removeEventListener() {} };
      let csv = '';
      global.Blob = function (parts) { csv = parts.join(''); };
      global.URL.createObjectURL = () => 'blob:bom';
      global.URL.revokeObjectURL = () => {};
      require('./assets/js/format.js');

      const abh = { id: 'p1', siteCode: 'ABH01', plantName: 'Abhaneri 01', displayName: 'Abhaneri', district: 'Dausa', projectCompany: 'P1' };
      const bgr = { id: 'p2', siteCode: 'BGR02', plantName: 'Bagru 02', displayName: 'Bagru', district: 'Jaipur', projectCompany: 'P1' };
      global.Solar91PortalData = { fetchPortfolio: () => Promise.resolve({ rows: [{ plant: abh, profile: {} }, { plant: bgr, profile: {} }] }) };

      const base = { siteCode: 'ABH01', maker: null, supplier: null, quantity: null, unit: null, section: null,
        sectionOrder: null, sortOrder: null, specs: null, testReport: null, warrantyCert: null,
        serialNo: null, invoice: null, invoiceUrl: null, version: 1 };
      const row = (over) => Object.assign({}, base, over);
      // Exactly as the API sends them: section ORDER, then BOQ line order. "PV Section" (order 1)
      // leads "14x2 MMS Hardware Quantity" (order 2) -- alphabetically it would be the other way.
      const PLANT_ITEMS = [
        row({ id: '1', itemName: 'Solar PV Modules', maker: 'Adani', supplier: 'Shakti Traders',
              quantity: 5334, unit: 'kWp', section: 'PV Section', sectionOrder: 1, sortOrder: 1, specs: 'Mono PERC 550 Wp' }),
        row({ id: '2', itemName: 'DC Cable', maker: 'Polycab', supplier: 'Shakti Traders',
              quantity: 7180.8, unit: 'Mtrs', section: 'PV Section', sectionOrder: 1, sortOrder: 2 }),
        row({ id: '3', itemName: 'JOINTING KIT', section: '14x2 MMS Hardware Quantity', sectionOrder: 2, sortOrder: 3, specs: '95 sqmm' }),
        row({ id: '4', itemName: 'JOINTING KIT', section: '14x2 MMS Hardware Quantity', sectionOrder: 2, sortOrder: 4,
              specs: '185 sqmm', quantity: 12, unit: 'Set' }),
        row({ id: '5', itemName: 'Aux transformer' })
      ];
      const SECTIONS = ['PV Section', '14x2 MMS Hardware Quantity'];
      // Two plants, both with a "PV Section": one plant's block must not merge into the next.
      const ALL_ITEMS = [
        row({ id: '1', itemName: 'Solar PV Modules', section: 'PV Section', sectionOrder: 1, sortOrder: 1 }),
        row({ id: '2', itemName: 'DC Cable', section: 'PV Section', sectionOrder: 1, sortOrder: 2 }),
        row({ id: '6', siteCode: 'BGR02', itemName: 'Solar PV Modules', section: 'PV Section', sectionOrder: 1, sortOrder: 1 }),
        row({ id: '7', siteCode: 'BGR02', itemName: 'DC Cable', section: 'PV Section', sectionOrder: 1, sortOrder: 2 })
      ];

      let items = PLANT_ITEMS, sections = SECTIONS, editor = false, urls = [], patched = null;
      global.Solar91PortalAPI = {
        can: () => editor,
        currentUser: () => ({ role: 'O&M Head' }),
        request: (url, opts) => {
          urls.push(url);
          if (opts && opts.method === 'PATCH') { patched = JSON.parse(opts.body); return Promise.resolve({ sections: patched.sections }); }
          // The server filters; this stands in for it, so the table re-renders over fewer rows.
          const want = (url.match(/[?&]section=([^&]*)/) || [])[1];
          const shown = want ? items.filter(i => i.section === decodeURIComponent(want)) : items;
          return Promise.resolve({ items: shown, total: shown.length, makers: ['Adani', 'Polycab'],
            suppliers: ['Shakti Traders'], sections: sections, limit: 200, offset: 0 });
        }
      };
      require('./assets/js/bom.js');

      function container() {
        const el = { isConnected: true, html: '', nodes: {} };
        Object.defineProperty(el, 'innerHTML', { get() { return el.html; }, set(v) { el.html = v; } });
        const make = (key) => el.nodes[key] || (el.nodes[key] = { on: {}, value: '', textContent: '',
          classList: { toggle() {} }, getAttribute: () => key.split('=')[1] || key,
          addEventListener(t, f) { this.on[t] = f; }, click() { if (this.on.click) this.on.click(); } });
        el.querySelector = (sel) => {
          const name = sel.charAt(0) === '.' ? sel.slice(1) : sel.slice(1, -1);
          return el.html.indexOf(name) === -1 ? null : make(name);
        };
        el.querySelectorAll = (sel) => {
          const name = sel.slice(1, -1), found = [];
          let i = -1;
          while ((i = el.html.indexOf(name + '="', i + 1)) !== -1) {
            const from = i + name.length + 2;
            found.push(make(name + '=' + el.html.slice(from, el.html.indexOf('"', from))));
          }
          return found;
        };
        return el;
      }
      const tick = () => new Promise(r => setTimeout(r, 0));
      const fail = (m) => { throw new Error(m); };
      const at = (html, text) => { const i = html.indexOf(text); if (i === -1) fail('missing: ' + text); return i; };
      const count = (html, re) => (html.match(re) || []).length;
      const settle = async (n) => { for (let i = 0; i < (n || 8); i++) await tick(); };

      (async () => {
        // ── Plant -> Details -> BOM ───────────────────────────────────────────
        let el = container();
        Solar91PortalBom.show(el, { siteCode: 'ABH01' });
        await settle();
        let html = el.html;

        // The whole header row, left to right, in one piece.
        if (html.indexOf('<th>Section</th><th>Item Description</th><th>Specs</th><th>Maker</th>' +
          '<th>Supplier</th><th>Quantity</th><th>Unit</th><th>T.R.</th><th>W.C.</th>' +
          '<th>Item Serial No.</th><th>Invoice</th>') === -1) fail('column order: ' + html.slice(at(html, '<thead>'), at(html, '</thead>')));
        if (html.indexOf('<th>Item Name</th>') !== -1 || html.indexOf('Maker/Supplier') !== -1) fail('old column names remain');
        if (html.indexOf('<table') !== html.lastIndexOf('<table')) fail('the page must stay one table');

        // Section: ONE merged cell per block of consecutive rows, not one per row.
        if (count(html, /class="ep-bom__section/g) !== 3) fail('expected three section blocks, got ' + count(html, /class="ep-bom__section/g));
        if (count(html, /rowspan="2"/g) !== 2) fail('two two-row blocks must carry rowspan="2"');
        if (count(html, />PV Section<\/td>/g) !== 1) fail('the section name must be printed once per block');
        if (count(html, />14x2 MMS Hardware Quantity<\/td>/g) !== 1) fail('second block repeated its name');
        if (html.indexOf('rowspan="1"') !== -1) fail('a one-row block needs no rowspan');
        // The no-section rows form their own block, shown as a dash, after the named ones.
        if (at(html, 'Aux transformer') < at(html, '>14x2 MMS Hardware Quantity</td>')) fail('unsectioned rows must come last');

        // The server's order is the page's order: BOQ order, never alphabetical.
        if (at(html, '>PV Section</td>') > at(html, '>14x2 MMS Hardware Quantity</td>')) fail('sections were re-sorted alphabetically');
        const order = ['Solar PV Modules', 'DC Cable', '95 sqmm', '185 sqmm', 'Aux transformer'].map(t => at(html, t));
        for (let i = 1; i < order.length; i++) if (order[i] < order[i - 1]) fail('row order changed');
        if (count(html, /JOINTING KIT<\/td>/g) !== 2) fail('a repeated item name was collapsed');

        // Maker and Supplier are two cells; Specs sits right after the description.
        if (html.indexOf('<td class="ep-bom__item">Solar PV Modules</td><td class="ep-bom__specs">Mono PERC 550 Wp</td>' +
          '<td>Adani</td><td>Shakti Traders</td>') === -1) fail('cell order: ' + html.slice(at(html, 'Solar PV Modules'), at(html, 'Solar PV Modules') + 260));

        // Quantities: the raw digits, no thousands separator, no padded zeros.
        if (html.indexOf('>5334<') === -1) fail('quantity must print as 5334');
        if (html.indexOf('5,334') !== -1 || html.indexOf('7,180.8') !== -1) fail('a thousands separator leaked in');
        if (html.indexOf('>7180.8<') === -1 || html.indexOf('>12<') === -1) fail('decimal or whole quantity lost');
        if (html.indexOf('12.000') !== -1 || html.indexOf('>5368<') !== -1) fail('quantity padded or rounded');

        // Nothing invented for the empty line.
        if (html.indexOf('undefined') !== -1) fail('undefined leaked into the table');
        if (count(html, /ep-pt__dash/g) < 10) fail('missing placeholders');

        // Both filter lists are fed by the API, in the API's order.
        if (at(html, '>PV Section</option>') > at(html, '>14x2 MMS Hardware Quantity</option>')) fail('the filter dropdown re-sorted the sections');
        if (html.indexOf('>Shakti Traders</option>') === -1 || html.indexOf('>All suppliers</option>') === -1) fail('supplier filter missing');

        // ── The spans are recomputed, never reused ────────────────────────────
        el.nodes['data-bom-filter=section'].value = 'PV Section';
        el.nodes['data-bom-filter=section'].on.change();
        await settle();
        html = el.html;
        if (urls[urls.length - 1].indexOf('section=PV%20Section') === -1) fail('section not sent: ' + urls[urls.length - 1]);
        if (count(html, /class="ep-bom__section/g) !== 1) fail('the filtered table must hold one block');
        if (count(html, /rowspan="2"/g) !== 1) fail('the span must be recomputed for the two rows left');
        if (html.indexOf('rowspan="4"') !== -1 || html.indexOf('rowspan="5"') !== -1) fail('a stale span survived the filter');
        if (html.indexOf('14x2 MMS Hardware Quantity</td>') !== -1) fail('a filtered-out block still rendered');

        // ── CSV: the table's columns, the section on every row, raw quantities ─
        el.nodes['data-bom-filter=section'].value = '__all';
        el.nodes['data-bom-filter=section'].on.change();
        await settle();
        el.nodes['data-bom-export=csv'].on.click();
        await settle();
        const lines = csv.replace(/^﻿/, '').split('\r\n');
        if (lines[0] !== 'Section,Item Description,Specs,Maker,Supplier,Quantity,Unit,T.R.,W.C.,Item Serial No.,Invoice,Invoice Link,Plant Code') fail('CSV header: ' + lines[0]);
        if (lines[1] !== 'PV Section,Solar PV Modules,Mono PERC 550 Wp,Adani,Shakti Traders,5334,kWp,,,,,,ABH01') fail('CSV row: ' + lines[1]);
        // A merged cell on screen, a repeated one in the file.
        if (lines[2].indexOf('PV Section,DC Cable,,Polycab,Shakti Traders,7180.8,Mtrs,') !== 0) fail('CSV must repeat the section: ' + lines[2]);
        if (lines[4].indexOf('14x2 MMS Hardware Quantity,JOINTING KIT,185 sqmm,,,12,Set,') !== 0) fail('CSV row 4: ' + lines[4]);
        if (lines[5].indexOf(',Aux transformer,,,,,') !== 0) fail('CSV empty row: ' + lines[5]);
        if (csv.indexOf('5,334') !== -1) fail('a formatted quantity reached the CSV');

        // ── Reorder sections: editors, single-plant mode only ─────────────────
        if (el.html.indexOf('data-bom-reorder') !== -1) fail('a viewer must not be offered the reorder button');
        editor = true;
        el = container();
        Solar91PortalBom.show(el, { siteCode: 'ABH01' });
        await settle();
        if (el.html.indexOf('data-bom-reorder') === -1) fail('an editor needs the reorder button');
        if (el.html.indexOf('>Reorder sections<') === -1) fail('reorder button label');

        // ── Views -> Details -> BOM (all plants) ──────────────────────────────
        items = ALL_ITEMS;
        el = container();
        Solar91PortalBom.show(el, {});
        await settle();
        html = el.html;
        if (html.indexOf('<th>Plant</th><th>Section</th><th>Item Description</th>') === -1) fail('Plant must lead across plants: ' + html.slice(at(html, '<thead>'), at(html, '</thead>')));
        if (html.indexOf('data-bom-reorder') !== -1) fail('reordering must not be offered across plants');
        // Same section name, two plants: two blocks of two, never one block of four.
        if (count(html, /class="ep-bom__section/g) !== 2) fail('plants were merged into one block');
        if (count(html, /rowspan="2"/g) !== 2) fail('expected a rowspan="2" per plant');
        if (html.indexOf('rowspan="4"') !== -1) fail('one plant\'s block ran into the next plant\'s');
        if (count(html, />PV Section<\/td>/g) !== 2) fail('each plant names its section once');
      })().catch(e => { console.error(e.message); process.exit(1); });
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stderr


def test_bom_removal_asks_twice_and_never_uses_a_bare_browser_confirm():
    """The x in the Edit column must not be one click away from deleting a BOQ line.

    It opens a dialog that states what is being removed, asks again for a final decision, and
    only then sends DELETE. The safe answer holds the focus, so Enter cannot remove a line.
    """
    module = (PORTAL_ASSETS / "js" / "bom.js").read_text(encoding="utf-8")
    assert "global.confirm(" not in module, "a browser confirm() is too easy to dismiss by reflex"
    assert "function openRemove(container, item, trigger)" in module
    assert "Is this your final decision?" in module and "Remove this BOM line?" in module
    assert 'role="alertdialog"' in module and "ep-pd__btn--danger" in module
    # The first question's safe answer is focused, and the step only advances on an explicit click.
    assert 'overlay.querySelector("[data-bom-del-no]")' in module
    assert "if (step === 1) { step = 2; paint(); return; }" in module

    script = r"""
      global.window = global;
      const listeners = {};
      let overlayEl = null;
      // A DOM small enough to drive the dialog: innerHTML is parsed only for the attributes
      // the module looks up, which is all the dialog needs to be clicked through.
      function node(tag) {
        const el = { tag, children: [], on: {}, html: '', disabled: false, focused: 0, parentNode: null,
          className: '', isConnected: true };
        Object.defineProperty(el, 'innerHTML', { get: () => el.html, set(v) { el.html = v; } });
        el.addEventListener = (t, f) => { el.on[t] = f; };
        el.focus = () => { el.focused += 1; };
        el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
        el.querySelectorAll = (sel) => {
          const name = sel.slice(1, -1), found = [];
          let i = -1;
          while ((i = el.html.indexOf(name, i + 1)) !== -1) {
            const before = el.html.lastIndexOf('<', i);
            const key = name + '@' + before;
            found.push(el.nodes[key] || (el.nodes[key] = Object.assign(node('button'), {
              disabled: el.html.slice(before, i).indexOf('disabled') !== -1 ||
                        el.html.slice(i, el.html.indexOf('>', i)).indexOf('disabled') !== -1 })));
          }
          return found;
        };
        el.nodes = {};
        return el;
      }
      global.document = {
        activeElement: null,
        body: { appendChild(el) { overlayEl = el; el.parentNode = { removeChild() { overlayEl = null; } }; },
                removeChild() {} },
        createElement: (tag) => node(tag),
        addEventListener(t, f) { listeners[t] = f; },
        removeEventListener() {}
      };
      global.Blob = function () {};
      global.URL.createObjectURL = () => 'blob:bom';
      global.URL.revokeObjectURL = () => {};
      require('./assets/js/format.js');

      const plant = { id: 'p1', siteCode: 'ABH01', plantName: 'Abhaneri 01', displayName: 'Abhaneri', district: 'Dausa', projectCompany: 'P1' };
      global.Solar91PortalData = { fetchPortfolio: () => Promise.resolve({ rows: [{ plant: plant, profile: {} }] }) };
      const ITEM = { id: 'line-1', siteCode: 'ABH01', itemName: 'Solar PV module (Wp)', maker: 'Renew',
        supplier: null, quantity: 9856, unit: 'Nos.', section: 'PV Section', sectionOrder: 1, sortOrder: 1,
        specs: '540/545/550', testReport: null, warrantyCert: null, serialNo: null, invoice: null,
        invoiceUrl: null, version: 3 };
      let calls = [], fails = false;
      global.Solar91PortalAPI = {
        can: () => true,
        currentUser: () => ({ role: 'O&M Head' }),
        request: (url, opts) => {
          if (opts && opts.method === 'DELETE') {
            calls.push(url);
            return fails ? Promise.reject(new Error('That line was changed by someone else.')) : Promise.resolve({ removed: true });
          }
          return Promise.resolve({ items: [ITEM], total: 1, makers: ['Renew'], suppliers: [],
            sections: ['PV Section'], limit: 200, offset: 0 });
        }
      };
      require('./assets/js/bom.js');

      function container() {
        const el = { isConnected: true, html: '', nodes: {} };
        Object.defineProperty(el, 'innerHTML', { get() { return el.html; }, set(v) { el.html = v; } });
        const make = (key) => el.nodes[key] || (el.nodes[key] = { on: {}, value: '', textContent: '',
          classList: { toggle() {} }, getAttribute: () => key.split('=')[1] || key,
          addEventListener(t, f) { this.on[t] = f; }, click() { if (this.on.click) this.on.click(); } });
        el.querySelector = (sel) => {
          const name = sel.charAt(0) === '.' ? sel.slice(1) : sel.slice(1, -1);
          return el.html.indexOf(name) === -1 ? null : make(name);
        };
        el.querySelectorAll = (sel) => {
          const name = sel.slice(1, -1), found = [];
          let i = -1;
          while ((i = el.html.indexOf(name + '="', i + 1)) !== -1) {
            const from = i + name.length + 2;
            found.push(make(name + '=' + el.html.slice(from, el.html.indexOf('"', from))));
          }
          return found;
        };
        return el;
      }
      const tick = () => new Promise(r => setTimeout(r, 0));
      const settle = async (n) => { for (let i = 0; i < (n || 8); i++) await tick(); };
      const fail = (m) => { throw new Error(m); };
      const no = () => overlayEl.querySelectorAll('[data-bom-del-no]')[0];
      const yes = () => overlayEl.querySelectorAll('[data-bom-del-yes]')[0];

      (async () => {
        const el = container();
        Solar91PortalBom.show(el, { siteCode: 'ABH01' });
        await settle();
        if (el.html.indexOf('data-bom-del="line-1"') === -1) fail('the remove button is missing');

        // One click opens the dialog and sends nothing.
        el.nodes['data-bom-del=line-1'].click();
        if (!overlayEl) fail('no dialog opened');
        if (overlayEl.html.indexOf('Remove this BOM line?') === -1) fail('step one missing');
        if (overlayEl.html.indexOf('Solar PV module (Wp)') === -1) fail('the dialog must name the line');
        if (overlayEl.html.indexOf('ABH01') === -1) fail('the dialog must name the plant');
        if (calls.length) fail('a click must not delete anything: ' + calls);
        if (no().focused < 1) fail('the safe answer must hold the focus');

        // "No, keep it" closes it, still without a delete.
        no().on.click();
        if (overlayEl) fail('the dialog stayed open');
        if (calls.length) fail('answering No deleted the line');

        // One "Yes" only advances to the final question.
        el.nodes['data-bom-del=line-1'].click();
        yes().on.click();
        if (overlayEl.html.indexOf('Is this your final decision?') === -1) fail('step two missing');
        if (calls.length) fail('the first Yes must not delete: ' + calls);
        // "Go back" returns to step one instead of closing.
        no().on.click();
        if (!overlayEl) fail('Go back must not close the dialog');
        if (overlayEl.html.indexOf('Remove this BOM line?') === -1) fail('Go back must return to step one');
        if (calls.length) fail('Go back deleted the line');

        // Escape at either step leaves the line alone.
        listeners.keydown({ key: 'Escape' });
        if (overlayEl) fail('Escape must close the dialog');
        if (calls.length) fail('Escape deleted the line');

        // Two Yes answers delete once, with the row's current version.
        el.nodes['data-bom-del=line-1'].click();
        yes().on.click();
        yes().on.click();
        await settle();
        if (calls.length !== 1) fail('expected exactly one DELETE, got ' + calls.length);
        if (calls[0] !== '/api/bom/line-1?version=3') fail('DELETE url: ' + calls[0]);
        if (overlayEl) fail('the dialog must close once the line is removed');

        // A refused delete is reported in the dialog and starts over; it is never silent.
        fails = true; calls = [];
        el.nodes['data-bom-del=line-1'].click();
        yes().on.click();
        yes().on.click();
        await settle();
        if (!overlayEl) fail('a failed removal must keep the dialog open');
        if (overlayEl.html.indexOf('Not removed.') === -1) fail('the failure must be shown: ' + overlayEl.html);
        if (overlayEl.html.indexOf('changed by someone else') === -1) fail('the server message must be shown');
        if (overlayEl.html.indexOf('Remove this BOM line?') === -1) fail('a failure must return to step one');
        if (calls.length !== 1) fail('a failed delete must not retry on its own');
      })().catch(e => { console.error(e.message); process.exit(1); });
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stderr


def test_only_the_om_head_role_can_remove_a_bom_line():
    """Removal is gated by `plants.manage`, and that permission belongs to O&M Head alone.

    Assignee, Administration and Site Engineer cannot delete a BOQ line, so the approval of
    someone else's deletion never arises: there is no role that can start one.
    """
    from app.core.security import ROLE_PERMISSIONS

    holders = {role for role, perms in ROLE_PERMISSIONS.items() if "plants.manage" in perms}
    assert holders == {"O&M Head"}, holders
    for role in ("Assignee", "Administration", "Site Engineer", "Viewer"):
        assert "plants.manage" not in ROLE_PERMISSIONS[role], role
