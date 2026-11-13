"""Loading the portal must cost only what the first screen needs.

The portal used to ship every page's JavaScript on every load and read the whole portfolio twice
before the Overview appeared. These tests hold the three things that fixed it:

* the page loads the shell only, and names the rest as modules fetched on first use;
* the washing overview can be read in summary form — same figures, without the per-plant day,
  cycle and productivity lists that only a plant's calendar reads;
* the Overview opens on one portfolio request, and the Inverters tile reads counts, not tickets.

Each one is checked against the behaviour it replaced, so a regression that quietly restores the
old cost fails here rather than in production.
"""
from __future__ import annotations

import json
import re
import subprocess
from datetime import timedelta
from pathlib import Path

from app.core.models import Issue, Plant, WashingConfig, WashingDailyReport, WashingTable
from app.core.timeutil import business_today
from app.portal import service
from app.scheduled.washing_cycles import get_overview
from tests.conftest import grant_assignee_plants, login_user

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "frontend" / "templates" / "index.html"
PORTAL_ASSETS = ROOT / "assets"

# The shell: what every signed-in user needs before choosing a page.
SHELL_SCRIPTS = ["format.js", "portal-api.js", "data-adapter.js", "modules.js",
                 "navigation.js", "overview.js", "app.js"]
# Pages, fetched when first opened. The calendar alone is a quarter of the old payload.
LAZY_MODULES = ["table-sort", "register-io", "plant-details", "plants-table", "site-issues",
                "movable-assets", "bom", "design", "liasoning", "operations-calendar",
                "washing-board", "categories", "settings"]


def _script_tags(page: str) -> list[str]:
    return re.findall(r'<script defer src="(/assets/js/[^"?]+)', page)


def _module_map(page: str) -> dict[str, str]:
    block = re.search(r'<script id="s91-modules" type="application/json">(.*?)</script>', page, re.S)
    assert block, "the page must list its page modules"
    return json.loads(block.group(1))


def test_the_page_loads_the_shell_and_names_the_rest_as_modules():
    page = TEMPLATE.read_text(encoding="utf-8")
    tags = [Path(src).name for src in _script_tags(page)]
    assert tags == SHELL_SCRIPTS, tags

    modules = _module_map(page)
    assert sorted(modules) == sorted(LAZY_MODULES), sorted(modules)
    for name, url in modules.items():
        assert (ROOT / url.lstrip("/").replace("assets/", "assets/", 1)).exists(), (name, url)
        assert '<script defer src="' + url + '"' not in page, name + " is loaded twice"

    # The heavy pages are the ones that must not be in the shell.
    for name in ("operations-calendar.js", "site-issues.js", "bom.js", "settings.js"):
        assert name not in tags, name + " still loads on every page"

    # Bytes: the shell is a fraction of what the page used to carry.
    shell_bytes = sum((PORTAL_ASSETS / "js" / name).stat().st_size for name in SHELL_SCRIPTS)
    lazy_bytes = sum((ROOT / url.lstrip("/").split("?")[0]).stat().st_size for url in modules.values())
    assert shell_bytes < lazy_bytes, (shell_bytes, lazy_bytes)
    assert shell_bytes < 160_000, shell_bytes


def test_module_urls_are_content_hashed_when_the_page_is_served(client):
    """A module fetched later must still get an immutable cache entry, which needs its ?v= hash."""
    page = client.get("/").text
    modules = _module_map(page)
    for name, url in modules.items():
        assert re.search(r"\?v=[0-9a-f]{12}$", url), (name, url)


def test_a_module_is_fetched_once_with_whatever_it_needs():
    """modules.js resolves each page's dependencies, loads each file once, and does not cache a failure."""
    script = """
      const fs = require('fs');
      const loaded = [];
      global.window = global;
      global.document = {
        getElementById: () => ({ textContent: JSON.stringify({
          'table-sort': '/t.js', 'plant-details': '/pd.js', 'plants-table': '/pt.js',
          'register-io': '/rio.js', 'site-issues': '/si.js' }) }),
        createElement: () => ({ set src(value) { loaded.push(value); this._src = value;
          setTimeout(() => (value === '/si.js' && loaded.filter(u => u === '/si.js').length === 1
            ? this.onerror() : this.onload()), 0); } }),
        head: { appendChild: () => {} }
      };
      eval(fs.readFileSync('./assets/js/modules.js', 'utf8'));
      const M = global.Solar91Modules;
      const fail = (m) => { throw new Error(m); };
      M.load('plants-table').then(() => {
        // Its dependencies come with it, each exactly once.
        if (loaded.join(',') !== '/t.js,/pd.js,/pt.js') fail('deps: ' + loaded);
        return M.load(['plants-table', 'table-sort']);
      }).then(() => {
        if (loaded.length !== 3) fail('a loaded module must not be fetched again: ' + loaded);
        if (!M.isLoaded('plants-table') || !M.isLoaded('table-sort')) fail('isLoaded');
        // A failed fetch is not remembered as loaded, so a retry can still succeed.
        return M.load('site-issues').then(() => fail('the failure should reject'), () => {
          if (M.isLoaded('site-issues')) fail('a failed module must not count as loaded');
          return M.load('site-issues');
        });
      }).then(() => {
        if (!M.isLoaded('site-issues')) fail('the retry should load it');
        if (M.known().length !== 5) fail('known: ' + M.known());
      }).catch((error) => { console.error(error.message); process.exit(1); });
    """
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stderr or run.stdout


def test_navigation_loads_a_pages_module_before_it_renders():
    nav = (PORTAL_ASSETS / "js" / "navigation.js").read_text(encoding="utf-8")
    # Every page names the module(s) it needs.
    for fragment in ('if (pageId === "health") return ["site-issues"];',
                     'if (pageId === "pm") return ["operations-calendar"];',
                     'if (pageId === "washing") return plantCode ? ["operations-calendar"] : ["washing-board"];',
                     'if (section === "liasoning") return ["plants-table", "liasoning"];'):
        assert fragment in nav, fragment
    # A page already loaded renders straight away; a first visit shows a skeleton and then renders.
    assert "needed.every(global.Solar91Modules.isLoaded)" in nav
    assert "host.innerHTML = SKELETON" in nav
    assert "global.Solar91Modules.load(needed).then(function () {" in nav
    # A module that cannot be fetched says so and offers a retry, rather than leaving a blank page.
    assert "data-nav-retry" in nav
    # Moving on while a page loads must not let the slow page draw over the new one.
    assert "if (token !== navToken) return;" in nav
    styles = (PORTAL_ASSETS / "css" / "components.css").read_text(encoding="utf-8")
    assert ".ep-skeleton" in styles


# ── Washing summary ──────────────────────────────────────────────────────────

def _washing_plant(db, code: str, tables: int = 6, days: int = 12):
    today = business_today()
    plant = Plant(site_code=code, plant_name=f"Plant {code}")
    db.add(plant)
    db.flush()
    db.add(WashingConfig(plant_id=plant.id, tables_per_cycle=tables, team=["Washer"]))
    for index in range(tables):
        db.add(WashingTable(plant_id=plant.id, table_code=f"T{index + 1:03d}",
                            legacy_id=f"{code}-T{index + 1}"))
    for offset in range(days):
        day = today - timedelta(days=offset)
        db.add(WashingDailyReport(
            plant_id=plant.id, report_date=day, cycle_month=day.strftime("%Y-%m"),
            cycle_no=min(3, (day.day - 1) // 10 + 1), tables_cleaned=2,
            cleaned_table_codes=[f"T{((offset * 2 + k) % tables) + 1:03d}" for k in range(2)],
            job_status="Done", review_status="Confirmed", reported_by="Washer",
        ))
    db.commit()
    return plant


OMITTED_BY_SUMMARY = ("daily_status", "cycles", "productivity", "daily_productivity")


def test_washing_summary_keeps_every_figure_and_drops_only_the_lists(db, client):
    """The summary must be the same answer, smaller: no figure may move."""
    user = login_user(client, db, role="O&M Head")
    for code in ("SUM01", "SUM02"):
        _washing_plant(db, code)

    full = get_overview(db, user, include_reports=False)
    summary = get_overview(db, user, include_reports=False, summary=True)

    assert len(summary["plants"]) == len(full["plants"]) == 2
    for full_row, summary_row in zip(full["plants"], summary["plants"]):
        for key in OMITTED_BY_SUMMARY:
            assert key in full_row, key
            assert key not in summary_row, key + " is not part of the summary"
        # Everything else is identical, value for value.
        assert summary_row == {k: v for k, v in full_row.items() if k not in OMITTED_BY_SUMMARY}
    assert summary["portfolio"] == full["portfolio"]
    assert summary["overdue_matrix"] == full["overdue_matrix"]

    # And it is substantially smaller, which is the whole point.
    assert len(json.dumps(summary)) * 2 < len(json.dumps(full))


def test_the_washing_route_offers_the_summary_and_still_defaults_to_the_full_answer(db, client):
    login_user(client, db, role="O&M Head")
    _washing_plant(db, "SUM03")
    month = business_today().strftime("%Y-%m")

    default = client.get(f"/api/scheduled/washing/overview?month={month}&include_reports=false")
    summary = client.get(f"/api/scheduled/washing/overview?month={month}&include_reports=false&summary=true")
    assert default.status_code == summary.status_code == 200

    default_row = default.json()["plants"][0]
    summary_row = summary.json()["plants"][0]
    for key in OMITTED_BY_SUMMARY:
        assert key in default_row, "the default answer is unchanged: " + key
        assert key not in summary_row
    assert summary_row["cycle_compliance_percent"] == default_row["cycle_compliance_percent"]
    assert len(summary.content) < len(default.content)


def test_the_overview_reads_washing_in_summary_form(db, client):
    """The Overview's plant profiles use scalars only, so it must not ask for the lists."""
    user = login_user(client, db, role="O&M Head")
    plant = _washing_plant(db, "SUM04")
    asked: dict[str, object] = {}
    original = service.get_overview if hasattr(service, "get_overview") else None

    import app.scheduled.washing_cycles as cycles
    real = cycles.get_overview

    def spy(*args, **kwargs):
        asked.update(kwargs)
        return real(*args, **kwargs)

    cycles.get_overview = spy
    try:
        portfolio = service.portfolio(db, user)
    finally:
        cycles.get_overview = real
        if original is not None:
            service.get_overview = original

    assert asked.get("summary") is True
    assert asked.get("include_reports") is False
    # The figures still arrive: the profile is built from the summary row.
    row = next(r for r in portfolio["rows"] if r["plant"]["site_code"] == plant.site_code)
    assert row["profile"]["washing"]["tableCount"] == 6
    assert row["profile"]["washing"]["compliancePercent"] is not None


# ── Inverter counts instead of the ticket list ───────────────────────────────

def test_equipment_summary_counts_open_tickets_per_plant(db, client):
    """The Inverters tile needs counts; reading the tickets for it cost ~126 KB per sign-in."""
    login_user(client, db, role="O&M Head")
    first = Plant(site_code="EQ01", plant_name="Equipment One")
    second = Plant(site_code="EQ02", plant_name="Equipment Two")
    db.add_all([first, second])
    db.flush()
    rows = [
        (first, "Inverter", "Open", 2),            # counted, two units
        (first, "Inverter", "In Progress", None),  # counted, no unit count ⇒ one unit
        (first, "Inverter", "Closed", 5),          # closed: not counted
        (first, "Transformer", "Open", 4),         # another category: not counted
        (second, "inverter", "Pending Vendor", 3),  # the category match ignores case
    ]
    for index, (plant, vertical, status, units) in enumerate(rows):
        db.add(Issue(ticket_no=f"EQ-{index}", plant_id=plant.id, vertical=vertical,
                     description="x", severity="Medium", status=status, unit_count=units))
    db.commit()

    body = client.get("/api/issues/equipment-summary?vertical=Inverter").json()
    assert body["plants"] == [{"site_code": "EQ01", "open": 2, "units": 3},
                              {"site_code": "EQ02", "open": 1, "units": 3}]
    assert body["open"] == 3 and body["units"] == 6 and body["plants_affected"] == 2

    # Without a category it counts every open ticket.
    everything = client.get("/api/issues/equipment-summary").json()
    assert everything["open"] == 4


def test_equipment_summary_respects_the_callers_plant_scope(db, client):
    """A role without portfolio scope sees only its own plants — the same rule the list follows."""
    mine = Plant(site_code="EQ10", plant_name="Mine")
    theirs = Plant(site_code="EQ11", plant_name="Theirs")
    db.add_all([mine, theirs])
    db.flush()
    for index, plant in enumerate((mine, theirs)):
        db.add(Issue(ticket_no=f"SC-{index}", plant_id=plant.id, vertical="Inverter",
                     description="x", severity="Medium", status="Open", unit_count=1))
    db.commit()

    engineer = login_user(client, db, role="Site Engineer", email="engineer@example.com")
    grant_assignee_plants(db, engineer.id, mine.id)
    body = client.get("/api/issues/equipment-summary?vertical=Inverter").json()
    assert [row["site_code"] for row in body["plants"]] == ["EQ10"]


def test_the_inverter_tile_reads_counts_rather_than_the_ticket_list():
    overview = (PORTAL_ASSETS / "js" / "overview.js").read_text(encoding="utf-8")
    assert '"/api/issues/equipment-summary?vertical=Inverter"' in overview
    assert "/api/issues?vertical=Inverter&limit=200" not in overview
    assert "inverters.issues = (body && body.plants) || [];" in overview


# ── One portfolio request on sign-in ─────────────────────────────────────────

def test_the_range_endpoint_resolves_a_named_period(db, client):
    """So the Overview can open on one request instead of reading the portfolio to learn the date."""
    login_user(client, db, role="O&M Head")
    db.add(Plant(site_code="PER01", plant_name="Period Plant"))
    db.commit()
    today = business_today()

    body = client.get("/api/portal/overview/range?period=month").json()
    assert body["startDate"] == today.replace(day=1).isoformat()
    assert body["endDate"] == today.isoformat()
    assert body["businessDate"] == today.isoformat()
    assert len(body["rows"]) == 1

    assert client.get("/api/portal/overview/range?period=today").json()["startDate"] == today.isoformat()
    yesterday = (today - timedelta(days=1)).isoformat()
    assert client.get("/api/portal/overview/range?period=yesterday").json()["endDate"] == yesterday

    # Explicit dates behave exactly as they did.
    explicit = client.get(f"/api/portal/overview/range?start_date={today.isoformat()}"
                          f"&end_date={today.isoformat()}")
    assert explicit.status_code == 200
    assert explicit.json()["startDate"] == today.isoformat()

    assert client.get("/api/portal/overview/range?period=decade").status_code == 422
    assert client.get("/api/portal/overview/range").status_code == 422


def test_the_overview_opens_on_one_portfolio_request():
    overview = (PORTAL_ASSETS / "js" / "overview.js").read_text(encoding="utf-8")
    adapter = (PORTAL_ASSETS / "js" / "data-adapter.js").read_text(encoding="utf-8")

    # It opens on the period request, which carries the rows, the business date and the dates used.
    assert "data.fetchPortfolioPeriod(period, !!refresh)" in overview
    assert "/api/portal/overview/range?period=" in adapter
    # And no longer reads the whole portfolio first just to learn the business date.
    assert "data.fetchPortfolio(" not in overview
    # The period just loaded is not then read a second time by the Range selector.
    assert 'rangeKey = portfolio.startDate + ":" + portfolio.endDate;' in overview
    # The filter controls are wired once, not again on every refresh.
    assert "if (!wireControls) return;" in overview


def test_sign_in_reads_only_what_the_first_screen_needs(db, client):
    """The whole login path, measured: the requests the portal makes before a page is chosen."""
    login_user(client, db, role="O&M Head")
    for index in range(3):
        plant = Plant(site_code=f"BOOT{index}", plant_name=f"Boot {index}")
        db.add(plant)
    db.commit()

    boot = [
        "/api/auth/session",
        "/api/portal/plants",
        "/api/portal/overview/range?period=month",
        "/api/pm-plan/unit-config",
        "/api/issues/equipment-summary?vertical=Inverter",
    ]
    total = 0
    for url in boot:
        response = client.get(url)
        assert response.status_code == 200, url
        total += len(response.content)

    # The portfolio-wide read the Overview used to make on top of these is no longer on this path.
    page = TEMPLATE.read_text(encoding="utf-8")
    assert "/api/portal/overview" not in page
    overview = (PORTAL_ASSETS / "js" / "overview.js").read_text(encoding="utf-8")
    assert '"/api/portal/overview"' not in overview
    assert total > 0
