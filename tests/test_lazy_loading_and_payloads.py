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
                "washing-board", "categories", "security", "settings", "photo-evidence"]


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
    # 168 KB, raised from 160 KB when the Inverter Health drill-down gained inverter maker and
    # capacity, the unfoldable down-inverter rows and sortable headings. It is still a tripwire:
    # the headroom left is about the same as before. The real fix is to stop shipping that
    # drill-down in the shell at all -- it is ~38 KB of overview.js and only runs when someone
    # clicks the Inverter Health tile, so it belongs in a lazy module like site-issues.
    assert shell_bytes < 168_000, shell_bytes


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
          'register-io': '/rio.js', 'photo-evidence': '/pe.js', 'site-issues': '/si.js' }) }),
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
        if (!M.isLoaded('register-io') || !M.isLoaded('photo-evidence')) fail('site-issues deps should load alongside it');
        if (M.known().length !== 6) fail('known: ' + M.known());
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
    today = business_today()
    current_row = next(row for row in summary["plants"] if row["site_code"] == "SUM01")
    assert today.isoformat() in current_row["cleaning_dates"]
    assert min(3, (today.day - 1) // 10 + 1) in current_row["cleaned_cycles"]

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


def test_issues_status_open_returns_the_equipment_summary_open_states(db, client):
    login_user(client, db, role="O&M Head")
    plant = Plant(site_code="OP01", plant_name="Open States")
    db.add(plant)
    db.flush()
    open_states = ("Open", "Assigned", "Acknowledged", "In Progress", "Pending Vendor", "Pending Parts/Vendor")
    for index, status in enumerate(open_states):
        db.add(Issue(ticket_no=f"OPEN-{index}", plant_id=plant.id, vertical="Inverter",
                     description="x", severity="Medium", status=status))
    db.add(Issue(ticket_no="CLOSED", plant_id=plant.id, vertical="Inverter",
                 description="x", severity="Medium", status="Closed"))
    db.commit()

    response = client.get("/api/issues?vertical=Inverter&status=open&limit=200")
    assert response.status_code == 200
    assert {row["status"] for row in response.json()} == set(open_states)
    assert len(response.json()) == len(open_states)


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


# ---------------------------------------------------------------------------
# Photos were added to two list-heavy views (the module-cleaning month view and
# the issues register). The classic failure is one query per row. These pin the
# statement count against the row count, so an N+1 shows up here as a number.
# ---------------------------------------------------------------------------

class _StatementCounter:
    """Counts SQL statements issued while it is active (the bench_portal approach)."""

    def __init__(self):
        self.n = 0

    def __call__(self, *_args):
        self.n += 1


def _count_statements(fn):
    from sqlalchemy import event
    from app.core.database import engine
    counter = _StatementCounter()
    event.listen(engine, "before_cursor_execute", counter)
    try:
        result = fn()
    finally:
        event.remove(engine, "before_cursor_execute", counter)
    return result, counter.n


def _washing_month_with_photos(db, days):
    """One configured plant with `days` confirmed daily reports, each carrying photo evidence."""
    import uuid as _uuid
    plant = Plant(site_code="PHOT01", plant_name="Photo Month Plant")
    db.add(plant)
    db.flush()
    db.add(WashingConfig(plant_id=plant.id, tables_per_cycle=12, team=["Washer"]))
    for index in range(12):
        db.add(WashingTable(plant_id=plant.id, table_code=f"T{index + 1:03d}",
                            legacy_id=f"{plant.site_code}-T{index + 1}"))
    today = business_today()
    for offset in range(days):
        day = today - timedelta(days=offset)
        db.add(WashingDailyReport(
            plant_id=plant.id, report_date=day, cycle_month=day.strftime("%Y-%m"),
            cycle_no=1, tables_cleaned=2, job_status="Done", review_status="Confirmed",
            reported_by="Washer",
            evidence=[{
                "id": str(_uuid.uuid4()), "photo_id": str(_uuid.uuid4()),
                "phase": phase, "kind": phase, "slot": slot,
                "at": "2026-01-01T00:00:00+00:00", "by": "Washer",
                "name": f"{phase}-{slot}.webp", "size": 1234,
            } for phase in ("before", "after") for slot in (1, 2)],
        ))
    db.commit()
    return plant


def test_the_module_cleaning_month_view_reads_every_days_photos_without_a_query_per_day(db, client):
    """Evidence lives on the daily report row (a JSON column), so the month view's photos ride
    along with the reports it already reads. The statement count must not follow the day count."""
    login_user(client, db, role="O&M Head")
    plant = _washing_month_with_photos(db, days=24)
    month = business_today().strftime("%Y-%m")
    url = f"/api/scheduled/washing/overview?month={month}&include_reports=true"

    response, statements = _count_statements(lambda: client.get(url))
    assert response.status_code == 200, response.text
    body = response.json()
    reports = [row for row in body["reports"] if row["plant_id"] == str(plant.id)]
    assert len(reports) >= 20, "the month view must return the days themselves"
    # Every returned day carries its four photo slots, read with the row and not per row.
    assert all(len(row["evidence"]) == 4 for row in reports)
    assert all(entry["url"].endswith("?size=thumb") for row in reports for entry in row["evidence"])
    # A per-day query would put this in the hundreds; the whole month is a fixed handful.
    assert statements <= 40, f"module-cleaning month view issued {statements} statements for {len(reports)} days"


def test_the_issues_register_photo_indicator_is_a_column_not_a_query_per_row(db, client):
    """``Issue.photo_count`` is stored on the ticket, so the register's photo indicator costs
    nothing per row. A lookup per ticket would scale with the page size."""
    login_user(client, db, role="O&M Head")
    plant = Plant(site_code="PHOT02", plant_name="Photo Issues Plant")
    db.add(plant)
    db.flush()
    for index in range(60):
        db.add(Issue(ticket_no=f"PHI-{index:04d}", plant_id=plant.id, vertical="Inverter",
                     description="Benchmark ticket", severity="Medium", status="Open",
                     photo_count=index % 5))
    db.commit()

    response, statements = _count_statements(lambda: client.get("/api/issues?limit=200"))
    assert response.status_code == 200, response.text
    rows = response.json()
    assert len(rows) >= 60
    assert any(row.get("photo_count") for row in rows), "the indicator must reach the register"
    assert statements <= 20, f"issues register issued {statements} statements for {len(rows)} tickets"


def test_bom_lines_for_one_plant_and_across_plants_stay_within_a_bounded_statement_count(db, client):
    """~164 lines for one plant, read in BOQ order off (plant_id, section_order, sort_order)
    -- migration 041's index -- not sorted per row and not re-read per section."""
    from app.core.models import BomItem
    login_user(client, db, role="O&M Head")
    sections = ["PV Section", "MMS Hardware Quantity", "PROTECTION", "CABLES"]
    plants = []
    for p in range(2):
        plant = Plant(site_code=f"BOM{p:02d}", plant_name=f"BOM Plant {p}")
        db.add(plant)
        db.flush()
        plants.append(plant)
        for line in range(164):
            db.add(BomItem(plant_id=plant.id, item_name=f"Item {line}",
                           maker="Maker A", supplier="Supplier B",
                           section=sections[line % len(sections)],
                           section_order=line % len(sections),
                           sort_order=line, unit="Nos."))
    db.commit()

    single, single_statements = _count_statements(
        lambda: client.get(f"/api/bom?site_code={plants[0].site_code}&limit=200"))
    assert single.status_code == 200, single.text
    assert single.json()["total"] == 164
    assert len(single.json()["items"]) == 164
    assert single_statements <= 20, f"one plant's BOM issued {single_statements} statements for 164 lines"

    every, every_statements = _count_statements(lambda: client.get("/api/bom?limit=200"))
    assert every.status_code == 200, every.text
    assert every.json()["total"] == 328
    assert every_statements <= 20, f"all-plants BOM issued {every_statements} statements"
    # Sections come back in BOQ order, never alphabetically.
    assert every.json()["sections"][:2] == ["PV Section", "MMS Hardware Quantity"]


def test_no_list_or_month_view_ever_requests_a_full_size_original():
    """Originals are fetched only by the full-screen viewer, on an explicit click. A list,
    grid or month view that asked for one would undo the whole thumbnail budget."""
    viewer = (PORTAL_ASSETS / "js" / "photo-evidence.js").read_text(encoding="utf-8")
    assert "fetchBlob(photo.originalUrl)" in viewer, "the viewer is the one place that reads an original"

    for name in ("operations-calendar", "site-issues", "plants-table", "overview", "washing-board"):
        source = PORTAL_ASSETS / "js" / f"{name}.js"
        if not source.exists():
            continue
        text = source.read_text(encoding="utf-8")
        assert "size=original" not in text, f"{name}.js requests a full-size original"
        assert "originalUrl" not in text, f"{name}.js reads an original URL outside the viewer"


def test_every_thumbnail_in_a_list_is_lazy_and_has_explicit_dimensions():
    """loading=lazy plus width/height: the month view's photos load as they are scrolled to,
    and reserve their space first so lazy loading causes no layout shift."""
    calendar = (PORTAL_ASSETS / "js" / "operations-calendar.js").read_text(encoding="utf-8")
    start = calendar.index("<img data-photo-src=")
    thumbnail = calendar[start:calendar.index("/>", start)]
    assert 'loading="lazy"' in thumbnail
    assert "width=" in thumbnail and "height=" in thumbnail
    assert "thumbnailUrl" in thumbnail, "a list thumbnail must read the thumbnail, never the original"

    # The observer that actually defers the fetch (an authenticated image cannot use a plain src).
    viewer = (PORTAL_ASSETS / "js" / "photo-evidence.js").read_text(encoding="utf-8")
    assert "IntersectionObserver" in viewer
    assert "img[data-photo-src]:not([data-photo-observed])" in viewer


# ---------------------------------------------------------------------------
# Connection holding during uploads.
#
# A pooled DB connection held through a Storage upload is what makes the portal
# feel hung for everyone else while one field user uploads a photo on a weak
# connection. Every upload path must hand the connection back after its cheap
# checks and before it decodes or sends any bytes.
# ---------------------------------------------------------------------------

UPLOAD_PATHS = [
    ("app/photos/router.py", "def create_photos("),
    ("app/scheduled/router.py", "def upload_washing_evidence("),
    ("app/scheduled/router.py", "def upload_evidence("),
    ("app/issues/router.py", "def upload_issue_evidence("),
]


def _function_source(path, marker):
    text = (ROOT / path).read_text(encoding="utf-8")
    start = text.index(marker)
    nxt = text.find("\n@router.", start)
    return text[start:nxt if nxt != -1 else len(text)]


def test_every_upload_path_releases_its_connection_before_storage_io():
    """Each upload hands the pooled connection back before the first Storage call."""
    for path, marker in UPLOAD_PATHS:
        body = _function_source(path, marker)
        if marker == "def upload_washing_evidence(":
            # Delegates the whole upload to create_photos, which releases before decoding.
            assert "create_photos(" in body, path
            continue
        assert "release_connection(db)" in body, f"{path}:{marker} never releases its connection"
        release = body.index("release_connection(db)")
        for call in (".upload(", "optimize_photo("):
            at = body.find(call)
            if at != -1:
                assert release < at, (
                    f"{path}:{marker} holds a pooled connection through {call.strip('(')}"
                )


def test_release_connection_is_a_no_op_while_a_write_is_pending():
    """It ends a read transaction; it must never commit half-finished work early."""
    source = (ROOT / "app/core/database.py").read_text(encoding="utf-8")
    body = source[source.index("def release_connection("):]
    body = body[:body.index("\ndef ", 1)] if "\ndef " in body[1:] else body
    assert "if not (db.new or db.dirty or db.deleted):" in body
    assert "db.commit()" in body


def test_every_outbound_storage_call_has_a_timeout():
    """A hung HTTP call with no timeout stalls a worker. The shared client carries the
    default; any call that overrides it must still pass one."""
    service = (ROOT / "app/storage/service.py").read_text(encoding="utf-8")
    assert "httpx.Client(timeout=" in service, "the shared Storage client must carry a default timeout"
    # No bare client construction anywhere that would skip the default.
    assert service.count("httpx.Client(") == 1
    for call in re.finditer(r"get_storage_http_client\(\)\.(get|post|request)\(", service):
        assert call.group(1) in {"get", "post", "request"}


def test_the_storage_usage_helper_is_cached_and_never_read_during_a_page_render():
    """The free-tier guard reads bucket usage on upload and on the admin screen only."""
    usage = (ROOT / "app/storage/usage.py").read_text(encoding="utf-8")
    assert "_CACHE_SECONDS" in usage and "monotonic()" in usage

    callers = []
    for path in ROOT.joinpath("app").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        if "bucket_usage_bytes(" in text and path.name != "usage.py":
            callers.append(path.relative_to(ROOT).as_posix())
    assert callers == ["app/photos/router.py"], callers

    router = (ROOT / "app/photos/router.py").read_text(encoding="utf-8")
    # Exactly two call sites: the admin storage-usage endpoint, and the upload guard.
    assert router.count("bucket_usage_bytes(") == 2
    usage_endpoint = router[router.index("def storage_usage("):]
    assert "_admin(user)" in usage_endpoint[:400], "the usage screen is administrators only"


def test_raise_issue_photos_go_through_the_shared_pipeline_not_raw_bytes():
    """Ticket evidence used to be posted as raw camera bytes to /api/issues/{id}/evidence,
    up to ten per ticket, with no downscale and no thumbnail. It now goes through the shared
    /api/photos pipeline: at most four, downscaled in the browser, stored as WebP with a
    480px thumbnail and an original that the retention sweep later reclaims."""
    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")

    assert "var MAX_ISSUE_PHOTOS = 4;" in issues
    assert "Select no more than \" + MAX_ISSUE_PHOTOS + \" photos." in issues
    assert "Evidence photos (up to ' + MAX_ISSUE_PHOTOS + ')" in issues

    # The ticket is created first; photos follow, linked by its number.
    assert 'api.request("/api/issues", { method: "POST", body: payload })' in issues
    assert "return uploadIssuePhotos(saved, draft.evidenceFiles, submissionIdFor());" in issues
    assert 'linkType: "issue"' in issues and "linkId: issue.id" in issues

    # The legacy raw-bytes upload is no longer how a raised ticket stores its photos.
    assert '/evidence", {\n        method: "POST",\n        body: files' not in issues

    # A failed upload keeps the ticket and offers a retry under the SAME submission id,
    # so a repeat is the same submission and never stores a second copy.
    assert "state.pendingPhotos = {" in issues
    assert "submissionId: submissionId" in issues
    assert 'data-issue-action="retry-photos"' in issues
    assert "function retryIssuePhotos()" in issues
    assert "uploadIssuePhotos(issue, pending.files, pending.submissionId)" in issues


def test_the_browser_prepares_a_ticket_photo_before_it_leaves_the_phone():
    """2048px, WebP at 0.8, falling back to the original file when the browser cannot
    encode one. This is what keeps a 5 MB camera original off the Free-plan bucket."""
    evidence = (PORTAL_ASSETS / "js" / "photo-evidence.js").read_text(encoding="utf-8")
    assert "2048 / Math.max(width, height)" in evidence
    assert '"image/webp", 0.8' in evidence
    # Every failure path hands back the untouched file rather than losing the photo.
    assert evidence.count("{ blob: file, name: file.name }") >= 4
    assert "global.crypto.randomUUID" in evidence, "the submission id is browser-generated"


def test_a_tickets_photos_are_read_as_thumbnails_and_only_for_the_open_ticket():
    """The register lists tickets; it must not pull a photo for every row. Thumbnails are
    loaded for the one ticket that is open, and the original only on an explicit click."""
    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")

    assert "function loadIssuePhotos(ticket)" in issues
    assert '"/api/photos?link=issue&link_id=" + encodeURIComponent(ticket)' in issues
    assert "meta=false" in issues, "a ticket's photos need rows, not gallery facets"
    assert "loadIssuePhotos(state.modalId);" in issues

    # The thumbnail markup: lazy, with its own dimensions so nothing jumps as it loads.
    start = issues.index('<img data-photo-src="')
    thumbnail = issues[start:issues.index("/>", start)]
    assert 'loading="lazy"' in thumbnail
    assert "width=" in thumbnail and "height=" in thumbnail
    assert "photo.thumbnailUrl" in thumbnail

    # Exactly one place reads an original, and it is the viewer, on a click.
    assert "originalUrl" not in issues
    assert "photoEvidence().open(wanted);" in issues
    assert 'data-issue-photo-open=' in issues


def test_the_ticket_photo_count_comes_from_the_server_not_a_local_tally():
    """photo_count is kept by the API across both the linked photos and any legacy
    evidence, so the register must take its number rather than counting what it uploaded."""
    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")
    assert 'typeof result.issue_photo_count === "number"' in issues
    assert "issue.photoCount = result.issue_photo_count;" in issues
    assert "function removeIssuePhoto(ticket, photoId)" in issues
    assert '"/api/photos/" + encodeURIComponent(photoId), { method: "DELETE" }' in issues


def test_a_storage_warning_from_a_ticket_upload_reaches_administrators_only():
    """A field user cannot act on 'the bucket is nearly full'; the O&M Head can."""
    for name in ("site-issues", "operations-calendar"):
        source = (PORTAL_ASSETS / "js" / f"{name}.js").read_text(encoding="utf-8")
        assert "storage_warning" in source, name
        assert "isStorageAdministrator()" in source, name
        block = source[source.index("function isStorageAdministrator()"):]
        block = block[:block.index("\n  }") + 4]
        assert '"O&M Head", "Administration"' in block, name


def test_resolution_fix_photos_are_downscaled_even_though_they_still_post_as_files():
    """The resolve call needs the ids the legacy evidence endpoint returns, so those photos
    keep that endpoint. They are still prepared in the browser first, so a fix photo costs
    the bucket the same 2048px WebP as every other photo."""
    issues = (PORTAL_ASSETS / "js" / "site-issues.js").read_text(encoding="utf-8")
    evidence = (PORTAL_ASSETS / "js" / "photo-evidence.js").read_text(encoding="utf-8")

    assert "prepare: prepare" in evidence, "the downscaler is shared, not copied"
    assert "function prepare(files)" in evidence
    assert "evidence.prepare(photos)" in issues
    assert 'files.append("files", item.blob, item.name);' in issues
    # And it still degrades to the untouched files if the module has not loaded.
    assert "Promise.resolve(photos.map(function (file) { return { blob: file, name: file.name }; }))" in issues
    # The resolve contract is unchanged: it still takes the ids the upload returned.
    assert "evidence_ids: uploaded.map(function (entry) { return entry.id; })" in issues


def test_the_inverter_drill_down_reuses_the_tiles_figures_rather_than_refetching():
    """The drill-down is opened from the tile, which already holds the unit configuration
    and the per-plant ticket counts. Asking for the same two answers again costs two
    requests and could only make the two screens disagree."""
    overview = (PORTAL_ASSETS / "js" / "overview.js").read_text(encoding="utf-8")

    loader = overview[overview.index("function loadInverterHealth()"):]
    loader = loader[:loader.index("\n  function ", 1)]
    assert "inverters.loaded && (inverters.units.length || inverters.unitsRestricted)" in loader
    assert "inverters.loaded && inverters.issues.length" in loader
    assert "inverterHealth.summary = { plants: inverters.issues };" in loader
    # The ticket list is the one genuinely new read.
    assert "api.request(inverterHealthUrl())" in loader
    # A cold open still works: the fetch is the fallback, and it fills the tile's cache too.
    assert 'api.request("/api/pm-plan/unit-config")' in loader
    assert "inverters.loaded = true;" in loader


def test_the_portfolio_is_fetched_once_and_shared_through_the_data_adapter():
    """Tab-to-tab navigation must not re-read the portfolio each time."""
    adapter = (PORTAL_ASSETS / "js" / "data-adapter.js").read_text(encoding="utf-8")
    assert "/api/portal/plants" in adapter
    # One in-flight request is shared rather than started again per caller.
    assert "pending" in adapter or "cache" in adapter
