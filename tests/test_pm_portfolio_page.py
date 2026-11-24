"""The all-plants Preventive Maintenance page (Overview -> Preventive Maintenance).

This is the PORTFOLIO view only. The single-plant PM page and the PM calendar flow are
covered by ``test_pm_two_screens.py`` and ``test_operations_calendar.py`` and are not
changed by anything asserted here.

What the rebuild had to fix, reported from the live portal:

  1. The month picker could not reach the planned months, so a portfolio whose plans start
     next December read as completely empty.
  2. The page opened on a month with no data.
  3. Paused plants showed "Completed 0" and "Overdue 0". A paused plant's counts are
     UNKNOWN, not zero, and it must never be ranked or sorted as if it were failing.
  4. A section badge said "42 plants" beside "No plants currently require PM attention".
  5. The portfolio opened on Cards; Table is the right default for 42 plants.

The structure assertions below pin the shape of the page and the places a regression would
hide. The Node test under them drives the real module and checks the behaviour.
"""
from __future__ import annotations

import shutil
import subprocess
from datetime import date
from pathlib import Path

import pytest

from app.core.models import OMTask, PMCyclePlan, PMUnitConfig, Plant, User, UserPlantAssignment
from app.core.timeutil import business_today
from tests.conftest import login_user

ROOT = Path(__file__).resolve().parents[1]
OVERVIEW = ROOT / "assets" / "js" / "pm-overview.js"
PM_CSS = ROOT / "assets" / "css" / "pm-overview.css"
MODULES = ROOT / "assets" / "js" / "modules.js"
ADAPTER = ROOT / "assets" / "js" / "data-adapter.js"


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _portfolio(source: str) -> str:
    """The portfolio page's own markup builder, so a plant-page string cannot satisfy a check."""
    start = source.index("  function portfolioContent() {")
    return source[start:source.index("\n  }\n", start)]


# ── the page's shape ────────────────────────────────────────────────────────


def test_the_header_states_what_the_page_is_for_and_what_it_can_do():
    page = _portfolio(_text(OVERVIEW))

    assert "<h1>Preventive Maintenance</h1>" in page
    assert "Track scheduled work, overdue activities and upcoming maintenance across all plants." in page
    # Period, plant scope, then Export as the primary action.
    assert page.index("data-pm-month") < page.index('data-pm-filter="plant"') < page.index("data-pm-export")
    assert 'class="ep-pm__primary-button" data-pm-export' in page
    assert "plannedLine()" in page, "the plan count and its optional filter stay under the subtitle"


def test_the_pm_calendar_button_is_not_on_this_screen():
    """The calendar is reached from a single plant's PM page, not from the portfolio."""
    source = _text(OVERVIEW)

    assert "data-pm-calendar" not in _portfolio(source)
    # ...and the plant page keeps its own way through to the calendar, inside its activity tab.
    card = source[source.index("  function calendarCard(entries) {"):]
    card = card[:card.index(chr(10) + "  }" + chr(10))]
    assert 'class="ep-pm__calendar-button" data-pm-calendar>Open PM calendar ' in card
    workspace = source[source.index("  function plantWorkspace(entries) {"):]
    workspace = workspace[:workspace.index(chr(10) + "  }" + chr(10))]
    assert "calendarCard(entries)" in workspace


def test_four_stat_tiles_with_a_tinted_icon_each_and_a_bar_under_compliance():
    source = _text(OVERVIEW)
    tiles = source[source.index("  function summaryMetrics(rows) {"):]
    tiles = tiles[:tiles.index("\n  }\n")]

    for label, tone, icon in (
        ("PM compliance", "green", "compliance"),
        ("Scheduled activities", "blue", "calendar"),
        ("Completed", "green", "done"),
        ("Overdue", "red", "alert"),
    ):
        assert 'metric("' + label + '"' in tiles, label
        assert '"' + tone + '", "' + icon + '"' in tiles, (label, tone, icon)
    assert "ep-pm__metric-bar" in tiles, "compliance carries a progress bar beneath it"
    assert '"Needs attention"' in tiles
    assert 'number(counts.completed) + " of " + number(counts.all) + " activities"' in tiles

    css = _text(PM_CSS)
    assert ".ep-pm__metric-icon {" in css
    for tone in ("green", "blue", "red"):
        assert ".ep-pm__metric--" + tone + " .ep-pm__metric-icon {" in css


def test_compliance_leaves_paused_plants_out_of_its_denominator():
    """A plant with no cycle plan has not failed. Counting it as zero is the bug the Module
    Cleaning tile had."""
    source = _text(OVERVIEW)
    tiles = source[source.index("  function summaryMetrics(rows) {"):]
    tiles = tiles[:tiles.index("\n  }\n")]

    assert "var planned = rows.filter(function (row) { return !isPaused(row.plant.siteCode); });" in tiles
    assert "aggregate(planned)" in tiles
    assert "aggregate(rows)" not in tiles, "the whole portfolio must not feed the compliance figure"


def test_two_panels_side_by_side_with_the_left_one_wider():
    page = _portfolio(_text(OVERVIEW))
    source = _text(OVERVIEW)

    assert "registerPanel(rows)" in page and "portfolioWorkspace()" in page
    assert "upcomingPanelCard()" in source and "activitySection()" in source and "plannedCycleSection()" in source
    assert page.index("registerPanel(rows)") < page.index("portfolioWorkspace()")
    assert "Plant-wise PM status" in source and "Upcoming maintenance" in source
    # The panels these two replace are gone.
    assert "Plants to review" not in source
    assert "Top PM categories" not in source

    css = _text(PM_CSS)
    insights = css[css.index(".ep-pm__insights {"):]
    split = insights[:insights.index("}")]
    assert "grid-template-columns: minmax(0, 1." in split and "fr) minmax(0, 1fr)" in split, split


def test_the_plant_panel_carries_the_columns_the_register_needs_and_a_chevron():
    source = _text(OVERVIEW)
    columns = source[source.index("  var REGISTER_COLUMNS = ["):]
    columns = columns[:columns.index("\n  ];")]

    for label in ("Plant", "PM completion", "Completed / Scheduled", "Overdue", "Next due", "Status"):
        assert '"' + label + '"' in columns, label
    table = source[source.index("  function registerTable(rows) {"):]
    table = table[:table.index("\n  }\n")]
    assert 'class="ep-pm__chevron" ' in table
    assert 'data-pm-open-plant="' in table, "the row opens that plant's PM page"
    assert "completionCell(item)" in table, "a thin bar plus the percentage"


def test_the_section_badges_count_what_their_section_lists():
    """"42 plants" beside "No plants currently require PM attention" was the reported bug."""
    source = _text(OVERVIEW)

    panel = source[source.index("  function registerPanel(rows) {"):]
    panel = panel[:panel.index("\n  }\n")]
    assert "number(rows.length)" in panel
    assert "rows.length === 1 ? ' plant' : ' plants'" in panel

    activities = source[source.index("  function activitySection() {"):]
    activities = activities[:activities.index("\n  }\n")]
    assert "var rows = activityVisible();" in activities
    assert "number(rows.length) + ' shown" in activities, "the badge counts the listed rows"

    # The upcoming panel carries "View all" rather than a count it would have to keep honest.
    upcoming = source[source.index("  function upcomingPanelCard() {"):]
    upcoming = upcoming[:upcoming.index("\n  }\n")]
    assert "data-pm-view-all>View all</button>" in upcoming


def test_view_all_jumps_to_the_activity_register_with_upcoming_applied():
    source = _text(OVERVIEW)
    handler = source[source.index('if (event.target.closest("[data-pm-view-all]"))'):]
    handler = handler[:handler.index("return;")]

    assert 'state.activityFilter = "upcoming";' in handler
    assert '[data-pm-activities]' in handler and "scrollIntoView" in handler


# ── the bottom register ────────────────────────────────────────────────────


def test_the_activity_register_maps_every_column_from_om_tasks():
    source = _text(OVERVIEW)
    columns = source[source.index("  var ACTIVITY_COLUMNS = ["):]
    columns = columns[:columns.index("\n  ];")]

    for label in ("Due date", "Plant", "Maintenance task", "Equipment / Unit", "Frequency",
                  "Assigned to", "Status"):
        assert '"' + label + '"' in columns, label
    # Every column sortable; the filterable ones carry the shared chevron.
    assert columns.count("sort:") == 7
    assert "filter: false" in columns, "a date column offers no option list"

    assert 'return entry.unitNo ? type + "-" + entry.unitNo : type;' in source, '"Inverter-1"'
    assert "function taskLabel(entry)" in source
    assert "entry.taskName || entry.title" in source, "task_name on its own, not the unit-suffixed title"


def test_upcoming_and_overdue_come_from_the_due_date_and_the_portals_own_open_states():
    source = _text(OVERVIEW)
    states = source[source.index("  function pmOpenStates() {"):source.index("  var ACTIVITY_LABELS")]

    assert "data.BUSINESS_RULES && data.BUSINESS_RULES.pm" in states, "no second list of status strings"
    assert "rules.openStates" in states
    assert 'return entry.date < businessToday() ? "overdue" : "upcoming";' in states


def test_the_chip_counts_add_up_to_the_all_count():
    source = _text(OVERVIEW)
    counts = source[source.index("  function activityCounts(entries) {"):]
    counts = counts[:counts.index("\n  }\n")]

    assert 'if (kind === "cancelled") return;' in counts, "cancelled work is outside the set entirely"
    assert "counts.all += 1;" in counts and "counts[kind] += 1;" in counts
    # Chips count the column-filtered set, so All is always the sum of the other three.
    section = source[source.index("  function activitySection() {"):]
    assert "activityCounts(activityFiltered())" in section[:section.index("\n  }\n")]


def test_the_register_uses_the_shared_column_filter_not_a_copy_of_it():
    source = _text(OVERVIEW)

    assert "var columnFilter = global.Solar91PortalColumnFilter;" in source
    assert "columnFilter.headerHTML(header, {" in source
    assert "columnFilter.wire(host, {" in source
    assert "global.Solar91PortalSort" in source
    # No re-implementation of the popover, its search box or its positioning.
    for invented in ("showPopover", "hidePopover", "getBoundingClientRect"):
        assert invented not in source, invented

    modules = _text(MODULES)
    assert '"pm-overview": ["pm-cycle-plans", "table-sort", "table-column-filter"]' in modules


def test_export_writes_the_filtered_sorted_rows_with_the_on_screen_columns():
    source = _text(OVERVIEW)
    export = source[source.index("  function exportActivities() {"):]
    export = export[:export.index("\n  }\n")]

    assert "activityVisible()" in export, "as currently filtered and sorted"
    assert "ACTIVITY_COLUMNS.map(function (column) { return column.label; })" in export
    assert "column.value(entry)" in export, "the same reading the cells show"
    assert "fmt.csvText" in export, "the portal's own spreadsheet-formula guard"

    name = source[source.index("  function exportName() {"):]
    name = name[:name.index("\n  }\n")]
    assert "state.month" in name and "state.filters.plant" in name and "state.activityFilter" in name


# ── status pills ───────────────────────────────────────────────────────────


def test_the_status_thresholds_live_in_one_named_place():
    source = _text(OVERVIEW)
    rules = source[source.index("  var PM_STATUS_RULES = Object.freeze({"):]
    rules = rules[:rules.index("});")]

    assert "onTrackCompletionPercent: 85" in rules, "the portal's existing compliance threshold"
    assert "overdueCompletionPercent: 70" in rules
    assert "onTrackOverdueItems: 1" in rules
    assert "attentionOverdueItems: 3" in rules

    status = source[source.index("  function statusFor(row, entries) {"):]
    status = status[:status.index("\n  }\n")]
    # Every threshold in statusFor is read from the named rules, never written inline.
    for literal in ("< 80", "< 85", "< 70", "> 1", "> 3"):
        assert literal not in status, literal
    assert status.count("PM_STATUS_RULES.") == 4


def test_every_one_of_the_six_states_is_reachable_and_paused_is_not_not_started():
    source = _text(OVERVIEW)
    status = source[source.index("  function statusFor(row, entries) {"):]
    status = status[:status.index("\n  }\n")]

    assert 'if (isPaused(row.plant.siteCode)) return "Paused";' in status
    assert 'if (!scheduled.length) return "Not Started";' in status
    for name in ("Overdue", "Attention Required", "Completed", "On Track"):
        assert 'return "' + name + '";' in status, name
    # A month whose work is all still ahead of it is not "Completed".
    assert "if (completed && !overdue && !openAndDue)" in status


def test_paused_is_muted_never_an_error_colour_and_never_sorts_worst():
    source = _text(OVERVIEW)
    css = _text(PM_CSS)

    pill = css[css.index(".ep-pm__status--paused {"):]
    pill = pill[:pill.index("}")]
    assert "--ep-grey-soft" in pill and "--ep-text-muted" in pill
    assert "--ep-red" not in pill

    # The register's own order puts paused plants after the planned ones...
    order = source[source.index("      var aPaused = isPaused(a.plant.siteCode);"):]
    assert "if (aPaused !== bPaused) return aPaused ? 1 : -1;" in order[:300]
    # ...and every sortable figure reads blank for them, which table-sort sinks either way.
    columns = source[source.index("  var REGISTER_COLUMNS = ["):]
    columns = columns[:columns.index("\n  ];")]
    assert columns.count("item.paused ? null") == 3


# ── the month picker and the landing month ─────────────────────────────────


def test_the_month_picker_reaches_the_planned_months():
    source = _text(OVERVIEW)
    horizon = source[source.index("  function monthMax() {"):]
    horizon = horizon[:horizon.index("\n  }\n")]

    assert "MONTH_HORIZON_AHEAD" in horizon
    assert "furthest > horizon ? furthest : horizon" in horizon, "widened to the furthest month with work"
    # Both month inputs take the same horizon, and neither is capped at the present month.
    assert source.count('max="\' + monthMax() + \'"') == 2
    assert "businessToday().slice(0, 7) + '\" /></label>'" not in source
    assert "today.slice(0, 7) + '\"" not in source


def test_opening_pm_lands_on_a_month_that_has_data():
    source = _text(OVERVIEW)
    settle = source[source.index("  function settleLandingMonth() {"):]
    settle = settle[:settle.index("\n  }\n")]

    assert "if (state.monthSettled || state.siteCode) return false;" in settle
    assert "if (!months.length || months.indexOf(state.month) !== -1) return false;" in settle, \
        "the current month is kept when it holds work"
    assert "goToMonth(nearest);" in settle
    # A month the person chose is never overridden.
    handler = source[source.index('if (event.target.matches("[data-pm-month]"))'):]
    assert "state.monthSettled = true;" in handler[:400]


def test_when_no_month_has_work_the_page_says_so_without_discarding_the_register():
    """No work anywhere is a NOTICE, not a replacement for the page.

    Replacing the whole page threw away the plant register — the planned / paused state of every
    plant, which is knowable before any work exists — and removed every control with it, leaving no
    route to the PM calendar where work is actually generated.
    """
    source = _text(OVERVIEW)
    page = _portfolio(source)

    assert "noWorkAnywhere()" in page
    assert page.index("noWorkAnywhere()") < page.index("summaryMetrics(rows)"), \
        "the notice sits above the page"
    assert "registerPanel(rows)" in page[page.index("noWorkAnywhere()"):], \
        "the plant register still renders when no month holds work"
    assert "No PM work orders exist for any plant" in source

    empty = source[source.index("  function emptyPortfolio() {"):]
    empty = empty[:empty.index("\n  }\n")]
    assert "Upload plan" in empty, "it names the step that actually generates work orders"
    assert "data-pm-calendar" in empty, "and offers the way through to it"

    gate = source[source.index("  function noWorkAnywhere() {"):]
    assert "return !!state.months && !workMonths().length;" in gate[:200], \
        "only once the index has arrived, so a pending read never looks like an empty portfolio"


def test_the_empty_states_are_deliberate_and_point_somewhere():
    source = _text(OVERVIEW)

    period = source[source.index("  function periodNotice() {"):]
    period = period[:period.index("\n  }\n")]
    assert "No PM activities fall in " in period
    assert "Use the period selector above to choose another month." in period
    assert "data-pm-goto-month=" in period, "and offers the nearest month that does have work"
    assert "state.calendarLoading" in period, "a pending read is not an empty month"

    scope = source[source.index("  function scopeNotice() {"):]
    scope = scope[:scope.index("\n  }\n")]
    assert "No plants in this scope have " in scope and "cycle plan" in scope
    assert "set up its cycle plan" in scope

    # The server-truncation notice this page already carried is still here.
    assert "The server returned the first " in _portfolio(source)


def test_the_portfolio_opens_on_table_and_remembers_a_chosen_layout():
    source = _text(OVERVIEW)

    assert 'layout: "table",' in source
    preference = source[source.index("  function loadLayoutPreference() {"):]
    preference = preference[:preference.index("\n  }\n")]
    assert 'state.layout = "table";' in preference, "no stored choice means Table"
    assert 'if (global.localStorage.getItem(key) === "cards") state.layout = "cards";' in preference
    assert "solar91.pmPortfolioLayout.v1." in source

    toggle = source[source.index('var layoutButton = event.target.closest("[data-pm-layout]");'):]
    toggle = toggle[:toggle.index("\n      }")]
    assert 'layoutButton.getAttribute("data-pm-layout") === "cards" ? "cards" : "table"' in toggle
    assert "saveLayoutPreference();" in toggle


def test_the_page_stays_usable_at_a_narrow_window():
    css = _text(PM_CSS)

    assert "@media (max-width: 1180px) {\n  .ep-pm__insights { grid-template-columns: 1fr; }" in css
    assert ".ep-pm__table-wrap { width: 100%; overflow-x: auto; }" in css, "the wide register scrolls"


def test_the_month_index_rides_on_the_existing_calendar_request():
    adapter = _text(ADAPTER)

    assert "options.includeMonths" in adapter
    assert '(withMonths ? "&include_months=1" : "")' in adapter
    # One cache entry is shared with the plain calendar read, so the month is not fetched twice.
    assert "if (withMonths && !calendarCache.has(plainKey)) calendarCache.set(plainKey, request);" in adapter


# ── the endpoint behind it ─────────────────────────────────────────────────


def test_the_calendar_endpoint_reports_which_months_hold_pm_work(client, db):
    """The portfolio needs this to open on a month that has something in it, and to bound its
    month picker. It is opt-in, so the operations calendar pays nothing for it."""
    login_user(client, db, role="O&M Head", email="pm-months@example.com")
    plant = Plant(site_code="MON01", plant_name="Month Plant")
    db.add(plant)
    db.flush()
    today = business_today()
    later = (today.replace(day=1) + __import__("datetime").timedelta(days=70)).replace(day=12)
    db.add_all([
        OMTask(work_order_no="WO-MON-1", plant_id=plant.id, task_name="Clean inverter",
               task_type="Inverter", frequency="Monthly", due_on=later, status="Scheduled", unit_no=1),
        OMTask(work_order_no="WO-MON-2", plant_id=plant.id, task_name="Clean inverter",
               task_type="Inverter", frequency="Monthly", due_on=later, status="Scheduled", unit_no=2),
        OMTask(work_order_no="WO-MON-3", plant_id=plant.id, task_name="Cancelled work",
               due_on=later, status="Cancelled"),
    ])
    db.commit()

    month = today.strftime("%Y-%m")
    plain = client.get("/api/portal/calendar", params={"kind": "pm", "month": month})
    assert plain.status_code == 200, plain.text
    assert "months" not in plain.json(), "the index is opt-in"

    indexed = client.get("/api/portal/calendar",
                         params={"kind": "pm", "month": month, "include_months": "true"})
    assert indexed.status_code == 200, indexed.text
    body = indexed.json()
    assert body["entries"] == [], "the current month holds no work"
    # The month the work really falls in is listed, with cancelled work left out of the count.
    assert {"month": later.strftime("%Y-%m"), "count": 2} in body["months"]
    assert all(row["count"] > 0 for row in body["months"])


def test_a_pm_work_order_reports_its_assignees_display_name(client, db):
    login_user(client, db, role="O&M Head", email="pm-assignee@example.com")
    plant = Plant(site_code="ASG01", plant_name="Assignee Plant")
    engineer = User(auth_provider="supabase", external_subject="test:assignee:eng",
                    email="eng@example.com", display_name="Rakesh Kumar", role="Assignee")
    db.add_all([plant, engineer])
    db.flush()
    due = business_today()
    db.add_all([
        OMTask(work_order_no="WO-ASG-1", plant_id=plant.id, task_name="Inspect inverter",
               task_type="Inverter", unit_no=1, total_units=4, frequency="Monthly", due_on=due,
               status="Scheduled", assignee_user_id=engineer.id, assignee_text="Typed name"),
        OMTask(work_order_no="WO-ASG-2", plant_id=plant.id, task_name="Inspect fence",
               due_on=due, status="Scheduled", assignee_text="Vendor crew"),
        OMTask(work_order_no="WO-ASG-3", plant_id=plant.id, task_name="Inspect module",
               due_on=due, status="Scheduled"),
    ])
    db.commit()

    body = client.get("/api/portal/calendar", params={"kind": "pm", "month": due.strftime("%Y-%m")}).json()
    rows = {row["reference"]: row for row in body["entries"]}
    assert rows["WO-ASG-1"]["assignee"] == "Rakesh Kumar", "the user record wins"
    assert rows["WO-ASG-2"]["assignee"] == "Vendor crew", "assignee_text is the fallback"
    assert rows["WO-ASG-3"]["assignee"] == ""
    # The task name on its own, so "Maintenance task" is not the unit-suffixed title.
    assert rows["WO-ASG-1"]["taskName"] == "Inspect inverter"
    assert rows["WO-ASG-1"]["title"] == "Inspect inverter · unit 1/4"


def test_pm_calendar_includes_cycle_plan_days_and_chained_dates(client, db):
    login_user(client, db, role="O&M Head", email="calendar-plan@example.com")
    plant = Plant(site_code="PLAN01", plant_name="Planned Plant")
    db.add(plant)
    db.flush()
    db.add_all([
        PMUnitConfig(
            plant_id=plant.id,
            equipment_type="Inverter",
            total_units=3,
            units_per_day=2,
        ),
        PMCyclePlan(
            plant_id=plant.id,
            phases=[
                {"phase": "Inverter", "area": "Plant side", "categories": ["Inverter"],
                 "start_day": 4, "days": None, "step_days": 2},
                {"phase": "Earth pit", "area": "Plant side", "categories": ["Earthing"],
                 "start_day": 5, "days": 2, "step_days": 1},
            ],
        ),
        OMTask(
            plant_id=plant.id,
            work_order_no="WO-PLAN-EXISTING",
            task_name="Existing inverter work",
            task_type="Inverter",
            frequency="Monthly",
            due_on=date(2026, 12, 7),
            status="Scheduled",
        ),
    ])
    db.commit()

    response = client.get(
        "/api/portal/calendar",
        params={"kind": "pm", "month": "2026-12", "site_code": "PLAN01"},
    )
    assert response.status_code == 200, response.text
    plans = [row for row in response.json()["entries"] if row["source"] == "cycle_plan"]
    earth = [row for row in plans if row["planPhase"] == "Earth pit"]

    assert len(plans) == 6
    saved = next(row for row in response.json()["entries"] if row.get("reference") == "WO-PLAN-EXISTING")
    assert saved["source"] == "database" and saved["status"] == "Scheduled"
    assert {(row["date"], row["cyclePlanState"]) for row in earth} == {
        ("2026-12-05", "planned"),
        ("2026-12-06", "planned"),
        ("2026-12-07", "chained"),
        ("2026-12-08", "chained"),
    }
    assert all(row["plantName"] == "Planned Plant" for row in plans)
    assert all(row["status"] == "Planned" for row in plans)


def test_pm_calendar_does_not_expose_cycle_plan_days_to_site_engineers(client, db):
    engineer = login_user(
        client, db, role="Site Engineer", name="Calendar Engineer", email="calendar-engineer@example.com"
    )
    plant = Plant(site_code="PLAN02", plant_name="Scoped Plan")
    db.add(plant)
    db.flush()
    db.add_all([
        UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer"),
        PMCyclePlan(
            plant_id=plant.id,
            phases=[{"phase": "VCB", "area": "Plant side", "categories": ["VCB Panel"],
                     "start_day": 4, "days": 1, "step_days": 1}],
        ),
    ])
    db.commit()

    response = client.get(
        "/api/portal/calendar",
        params={"kind": "pm", "month": "2026-12", "site_code": "PLAN02"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["entries"] == []


def test_cycle_plan_markers_stay_separate_from_work_order_metrics_and_are_labeled():
    overview = _text(OVERVIEW)
    calendar = _text(CALENDAR)

    assert 'entry.source !== "cycle_plan"' in overview
    assert 'entry.source === "cycle_plan"' in overview
    assert "<h2>Planned plant activities</h2>" in overview
    assert "<th>Planned day</th><th>Run day</th>" in overview
    assert "event.source === \"cycle_plan\"" in calendar
    progress = calendar[calendar.index("  function pmDayProgress(dayEvents, context) {"):]
    progress = progress[:progress.index(chr(10) + "  }" + chr(10))]
    assert 'if (event.source === "cycle_plan") return;' in progress
    assert "ep-calendar__event--cycle-plan" in calendar
    assert "Cycle-plan marker only; no work order has been generated" in calendar


# ── driving the real page ──────────────────────────────────────────────────


CALENDAR = ROOT / "assets" / "js" / "operations-calendar.js"
CALENDAR_CSS = ROOT / "assets" / "css" / "calendar.css"


# -- a plant's own PM page --------------------------------------------------


def test_the_plant_page_leads_with_the_plant_and_a_generic_tile():
    source = _text(OVERVIEW)
    page = source[source.index("  function plantContent(row) {"):]
    page = page[:page.index(chr(10) + "  }" + chr(10))]

    assert "'<h1>' + escape(plantName(plant)) + '</h1>'" in page
    assert 'aria-label="Breadcrumb"' in page and 'aria-current="page">Preventive Maintenance' in page
    assert "ep-pm__plant-tile" in page
    assert "<img" not in page, "a plant has no photograph in the portal, and site evidence is private"
    assert "plantMetrics(row, entries)" in page
    assert "plantPlanningSummary(row, entries)" in page
    assert "plantWorkspace(entries)" in page


def test_the_plant_page_keeps_the_tracker_and_the_full_work_order_register():
    """The mockup does not draw them, but they are the only places a cycle plan is edited and a
    plant's work orders are filtered. They are redesigned into the page, not dropped."""
    source = _text(OVERVIEW)

    assert "data-pm-tracker-host" in source and "function mountTracker()" in source
    register = source[source.index("  function plantRegisterSection(entries) {"):]
    register = register[:register.index(chr(10) + "  }" + chr(10))]
    assert "<h2>PM work orders</h2>" in register
    assert "plantActivityChips(counts)" in register, "the plant-specific status filters remain available"
    assert "columnFilter.headerHTML(th, {" in register, "the shared searchable column filter"
    assert "sorter.thHTML(column, state.activitySort" in register
    for column in ('label: "Due date"', 'label: "Maintenance task"', 'label: "Equipment / Unit"',
                   'label: "Assigned to"', 'label: "Completed on"', 'label: "Schedule status"'):
        assert column in source, column


def test_plant_dashboard_adds_progress_adherence_and_a_mutually_exclusive_status_chart():
    source = _text(OVERVIEW)

    assert "plantCompletionProgress(entries, plant.siteCode)" in source
    assert "counts.completed * 100 / counts.all" in source
    assert "var remaining = Math.max(0, counts.all - counts.completed);" in source
    assert "function scheduleAdherence(entry)" in source
    assert 'completed < due ? "ahead" : completed > due ? "late" : "on-time"' in source
    assert "var eligible = counts.ahead + counts.on_time + counts.completed_late;" in source
    assert "Incomplete work and records missing either date are excluded." in source
    assert "function workOrderStatusCounts(entries)" in source
    assert 'else if (kind === "overdue") key = "overdue";' in source
    assert 'else if (entry.status === "In Progress") key = "in_progress";' in source
    assert 'aria-label="Work order status distribution for ' in source


def test_plant_kpis_match_portfolio_cards_and_keep_unmeasurable_values_neutral():
    source = _text(OVERVIEW)
    metrics = source[source.index("  function plantMetrics(row, entries) {"):]
    metrics = metrics[:metrics.index(chr(10) + "  }" + chr(10))]
    for label in ("PM compliance", "Scheduled activities", "Completed", "Overdue"):
        assert 'metric("' + label + '"' in metrics
    assert "paused || pm.compliancePercent == null ? null" in metrics
    assert 'paused ? "—"' in metrics
    assert "number(counts.completed) + \" of \" + number(counts.all) + \" activities\"" in metrics

    css = _text(PM_CSS)
    assert ".ep-pm__metric--green .ep-pm__metric-icon" in css


def test_the_task_breakdown_uses_a_categorical_ramp_clear_of_the_status_colours():
    """Task types are identities, not states. Hues are assigned in fixed slot order and never
    cycled; a seventh type folds into Other rather than inventing a hue."""
    source = _text(OVERVIEW)

    hues = source[source.index("  var BREAKDOWN_HUES = ["):]
    hues = hues[:hues.index("];") + 2]
    for status_colour in ("#009710", "#B4610A", "#B42318"):
        assert status_colour not in hues, "a status colour must never stand in for a series"
    assert "BREAKDOWN_OTHER" in source and "BREAKDOWN_SLOTS" in source

    parts = source[source.index("  function breakdownParts(entries) {"):]
    parts = parts[:parts.index(chr(10) + "  }" + chr(10))]
    assert "if (parts.length > BREAKDOWN_SLOTS + 1) {" in parts
    assert '"Other"' in parts

    panel = source[source.index("  function breakdownPanel(entries) {"):]
    panel = panel[:panel.index(chr(10) + "  }" + chr(10))]
    # Three of these hues sit under 3:1 on the page, so every name, count and share is in text.
    assert "ep-pm__breakdown-legend" in panel
    assert "escape(part.name)" in panel and "share + " in panel
    assert "' of ' + number(part.total) + ' done'" in panel


def test_the_workload_bars_never_rely_on_the_status_hues_alone():
    """Green/amber/red are near-identical to a red-green colourblind reader, so the stacking order
    is fixed, a legend names the three, and every column states its counts in words."""
    source = _text(OVERVIEW)
    panel = source[source.index("  function workloadPanel(entries) {"):]
    panel = panel[:panel.index(chr(10) + "  }" + chr(10))]

    dq = chr(34)
    assert '["completed", "open", "overdue"]' in panel, "a fixed stacking order"
    assert "ep-pm__workload-legend" in panel
    for phrase in (" completed, ", " open, ", " overdue"):
        assert (dq + phrase + dq) in panel, phrase
    assert 'title="' in panel and 'aria-label="' in panel
    assert "monthLabel(state.month)" in panel, "the chart is titled for the period it shows"

    css = _text(PM_CSS)
    assert ".ep-pm__bar-track { gap: 2px;" in css, "a surface gap divides the stacked segments"


# -- the PM calendar's day boxes --------------------------------------------


def test_the_pm_calendar_day_shows_how_much_of_that_day_is_done():
    calendar = _text(CALENDAR)
    progress = calendar[calendar.index("  function pmDayProgress(dayEvents, context) {"):]
    progress = progress[:progress.index(chr(10) + "  }" + chr(10))]

    assert 'if (context.type !== "pm") return null;' in progress, "PM only; washing keeps its chips"
    assert 'if (event.status === "Cancelled") return;' in progress
    assert 'band: done === total ? "complete" : overdue ? "overdue" : "open"' in progress
    assert "function renderPMDayCount(progress)" in calendar
    assert "function renderPMDayBar(progress)" in calendar
    # The count sits beside the day number and the bar is its own row beneath.
    assert 'ep-calendar__day-top' in calendar
    assert "renderPMDayBar(dayProgress)" in calendar
    assert '" of " + dayProgress.total + " done"' in calendar, "and it is announced, not just drawn"

    css = _text(CALENDAR_CSS)
    assert ".ep-calendar__day-top {" in css
    assert ".ep-calendar__day-count--overdue {" in css and ".ep-calendar__day-bar--complete > span {" in css
    # The existing washing day panel owns .ep-calendar__day-head; the grid must not reuse that name.
    assert ".ep-calendar__day-head h2" in css


PORTFOLIO_SCRIPT = r"""
const fs = require('fs');
const vm = require('vm');

const month = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit'
}).format(new Date());
const todayParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
}).formatToParts(new Date()).reduce((out, part) => {
  if (part.type !== 'literal') out[part.type] = part.value;
  return out;
}, {});
const today = todayParts.year + '-' + todayParts.month + '-' + todayParts.day;
const shiftDate = (date, offset) => {
  const value = new Date(date + 'T00:00:00Z');
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};
const nextMonth = (() => {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)) + 2;
  return (y + Math.floor((m - 1) / 12)) + '-' + String(((m - 1) % 12) + 1).padStart(2, '0');
})();
const day = (n) => month + '-' + String(n).padStart(2, '0');

// Alpha is clean, Bravo is late, Charlie is planned with nothing generated, Delta is paused.
const plants = ['AA-01', 'BB-02', 'CC-03', 'DD-04'].map((code, i) =>
  ({ siteCode: code, plantName: ['Alpha', 'Bravo', 'Charlie', 'Delta'][i], status: 'Active' }));
const pm = [
  { completed: 6, pending: 1, overdue: 0, compliancePercent: 100 },
  { completed: 2, pending: 0, overdue: 5, compliancePercent: 29 },
  { completed: 0, pending: 0, overdue: 0, compliancePercent: null },
  { completed: 0, pending: 0, overdue: 0, compliancePercent: null }
];
const rows = plants.map((plant, i) => ({ plant, profile: { pm: pm[i] } }));

let seq = 0;
const make = (code, name, over) => Object.assign({
  id: 'wo-' + (seq += 1), plantSiteCode: code, plantName: name,
  title: 'Clean inverter · unit 1/4', taskName: 'Clean inverter', reference: 'WO-' + seq,
  equipmentType: 'Inverter', unitNo: 1, totalUnits: 4, frequency: 'Monthly',
  status: 'Scheduled', assignee: 'Rakesh Kumar', date: day(28), completedOn: null
}, over);
const entries = [
  make('AA-01', 'Alpha', { status: 'Completed', date: day(2), completedOn: day(2) }),
  make('AA-01', 'Alpha', { status: 'Completed', date: day(5), completedOn: day(5) }),
  make('AA-01', 'Alpha', { status: 'Scheduled', date: day(27), assignee: '' }),
  make('BB-02', 'Bravo', { status: 'Overdue', date: day(1) }),
  make('BB-02', 'Bravo', { status: 'Overdue', date: day(3) }),
  make('BB-02', 'Bravo', { status: 'Overdue', date: day(4) }),
  make('BB-02', 'Bravo', { status: 'Overdue', date: day(6) }),
  make('BB-02', 'Bravo', { status: 'Overdue', date: day(7) }),
  make('BB-02', 'Bravo', { status: 'Cancelled', date: day(8) })
];
const cyclePlanMarkers = [
  {
    id: 'plan:inverter:planned', planActivityId: 'plan:inverter',
    source: 'cycle_plan', cyclePlanState: 'planned', status: 'Planned',
    title: 'Inverter', planPhase: 'Inverter', categories: ['Inverter'],
    plantSiteCode: 'CC-03', plantName: 'Charlie',
    plannedDate: day(14), scheduledDate: day(16), date: day(14)
  },
  {
    id: 'plan:inverter:chained', planActivityId: 'plan:inverter',
    source: 'cycle_plan', cyclePlanState: 'chained', status: 'Planned',
    title: 'Inverter', planPhase: 'Inverter', categories: ['Inverter'],
    plantSiteCode: 'CC-03', plantName: 'Charlie',
    plannedDate: day(14), scheduledDate: day(16), date: day(16)
  }
];

const empty = process.argv[1] === 'empty';
const bands = process.argv[1] === 'bands';
const plantPage = process.argv[1] === 'plant';

// One plant per status band, so every pill is reached with real records rather than asserted
// from the source. Compliance is held at 90% where the band must come from the overdue count.
if (bands) {
  const spec = [
    ['Paused plant',    'PA-01', null, 0, 0],
    ['Not started',     'NS-02', null, 0, 0],
    ['All done',        'CP-03', 100,  0, 2],
    ['One late',        'OT-04', 90,   1, 0],
    ['Two late',        'AT-05', 90,   2, 0],
    ['Four late',       'OD-06', 90,   4, 0]
  ];
  plants.length = 0; rows.length = 0; entries.length = 0;
  spec.forEach(([name, code, percent, late, done], i) => {
    const plant = { siteCode: code, plantName: name, status: 'Active' };
    plants.push(plant);
    rows.push({ plant: plant, profile: { pm: {
      completed: done, pending: 0, overdue: late, compliancePercent: percent } } });
    for (let n = 0; n < late; n += 1) entries.push(make(code, name, { status: 'Overdue', date: day(1 + n) }));
    for (let n = 0; n < done; n += 1) {
      entries.push(make(code, name, { status: 'Completed', date: day(1 + n), completedOn: day(1 + n) }));
    }
  });
}
if (plantPage) {
  entries.length = 0;
  entries.push(
    make('AA-01', 'Alpha', { status: 'Completed', date: day(10), completedOn: day(9) }),
    make('AA-01', 'Alpha', { status: 'Completed', date: day(11), completedOn: day(11) }),
    make('AA-01', 'Alpha', { status: 'Completed', date: day(12), completedOn: day(13) }),
    make('AA-01', 'Alpha', { status: 'Completed', date: day(14), completedOn: null }),
    make('AA-01', 'Alpha', { status: 'Scheduled', date: today }),
    make('AA-01', 'Alpha', { status: 'Scheduled', date: shiftDate(today, 1) }),
    make('AA-01', 'Alpha', { status: 'In Progress', date: shiftDate(today, 2) }),
    make('AA-01', 'Alpha', { status: 'Overdue', date: shiftDate(today, -1) })
  );
}
let html = '';
const listeners = {};
const emptyList = () => { const a = []; a.forEach = Array.prototype.forEach.bind(a); return a; };
const host = {
  set innerHTML(v) { html = v; }, get innerHTML() { return html; },
  addEventListener: (n, cb) => { listeners[n] = cb; },
  querySelector: () => null, querySelectorAll: emptyList
};
const store = {};
global.window = global;
global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
global.Solar91PortalFormat = {
  escape: (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  csvText: (v) => String(v == null ? '' : v)
};
const asked = [];
global.Solar91PortalData = {
  BUSINESS_RULES: { pm: { openStates: ['Scheduled', 'In Progress'] } },
  fetchPortfolioRange: () => Promise.resolve({ rows }),
  fetchCalendarMonth: (kind, wanted, code, options) => {
    asked.push([wanted, !!(options && options.includeMonths)]);
    const months = empty
      ? [{ month: nextMonth, count: 3 }]
      : [{ month: month, count: entries.length }, { month: nextMonth, count: 3 }];
    const later = entries.slice(0, 3).map((e, i) => Object.assign({}, e, {
      status: 'Scheduled', completedOn: null, date: nextMonth + '-1' + i
    }));
    const give = empty
      ? (wanted === nextMonth ? later : [])
      : (wanted === month ? entries : []);
    const plans = !empty && !bands && wanted === month ? cyclePlanMarkers : [];
    return Promise.resolve({ entries: give.concat(plans), truncated: false, limit: 4000, months: months });
  },
  aggregatePortfolio: (list) => {
    const c = list.reduce((n, r) => n + r.profile.pm.completed, 0);
    const p = list.reduce((n, r) => n + r.profile.pm.pending, 0);
    const o = list.reduce((n, r) => n + r.profile.pm.overdue, 0);
    return { pmCompleted: c, pmPending: p, pmOverdue: o,
      pmCompliancePercent: (c + p + o) ? Math.round(100 * c / (c + p + o)) : null };
  }
};
global.Solar91PortalAPI = {
  currentUser: () => ({ id: 'u1' }),
  request: () => Promise.resolve({
    total: 4, configured: 3, paused: 1, paused_reason: 'PM paused - no cycle plan',
    plans: plants.map((p) => ({ site_code: p.siteCode, plant: p.plantName,
      configured: p.siteCode !== 'DD-04' && p.siteCode !== 'PA-01',
      paused: p.siteCode === 'DD-04' || p.siteCode === 'PA-01' }))
  })
};
const nav = [];
global.Solar91PortalNav = {
  selectPlantPage: (...a) => nav.push(['plant', ...a]),
  openPMCalendar: (...a) => nav.push(['calendar', ...a]),
  selectView: (...a) => nav.push(['view', ...a])
};

vm.runInThisContext(fs.readFileSync('assets/js/table-sort.js', 'utf8'));
vm.runInThisContext(fs.readFileSync('assets/js/pm-overview.js', 'utf8'));

const tick = () => new Promise((r) => setTimeout(r, 0));
const bad = [];
const want = (label, ok) => { if (!ok) bad.push(label); };

(async () => {
  Solar91PortalPMOverview.show(host, plantPage
    ? { siteCode: 'AA-01', parent: 'plants' }
    : { parent: 'overview' });
  for (let i = 0; i < 8; i += 1) await tick();
  const selected = (html.match(/type="month"[^>]*value="([^"]*)"/) || [])[1];
  const picker = (html.match(/type="month"[^>]*max="([^"]+)"/) || [])[1];

  if (plantPage) {
    want('individual plant breadcrumb and identity', html.includes('aria-label="Breadcrumb"') &&
      html.includes('Alpha') && html.includes('AA-01'));
    want('four individual plant KPI cards', html.includes('PM compliance') &&
      html.includes('Scheduled activities') && html.includes('Completed') && html.includes('Overdue'));
    want('completion progress uses all scheduled activities', html.includes('aria-valuenow="50"') &&
      html.includes('4 / 8 activities'));
    want('schedule adherence excludes missing completion date',
      html.includes('Schedule Adherence') && html.includes('Eligible completed activities: 3') &&
      html.includes('33%'));
    want('work-order status chart includes exclusive status categories',
      html.includes('Work Order Status') && html.includes('<b>8</b><small>Work orders</small>') &&
      html.includes('In Progress') && html.includes('Due Today'));
    want('missing timing is explicit in the schedule table',
      html.includes('Completed · timing unavailable') && html.includes('Completed on'));
    want('all detailed activity filters are available',
      ['data-pm-activity-filter="due_today"', 'data-pm-activity-filter="ahead"',
       'data-pm-activity-filter="on_time"', 'data-pm-activity-filter="completed_late"']
        .every((key) => html.includes(key)));

    listeners.click({ target: { closest: (s) => s === '[data-pm-activity-filter]'
      ? { getAttribute: () => 'ahead' } : null } });
    const filteredRows = (html.match(/class="ep-pm__task-row"/g) || []).length;
    want('ahead filter isolates its matching completed work order', filteredRows === 1 &&
      html.includes('ep-pm__status--ahead-of-schedule'));
    console.log(JSON.stringify({ plant: true, rows: filteredRows }));
    if (bad.length) { console.error('FAILED\n - ' + bad.join('\n - ')); process.exit(1); }
    return;
  }

  if (bands) {
    const table = html.slice(html.indexOf('ep-pm__register-table'), html.indexOf('</table>'));
    [['paused', 'Paused plant'], ['not-started', 'Not started'], ['completed', 'All done'],
     ['on-track', 'One late'], ['attention-required', 'Two late'], ['overdue', 'Four late']
    ].forEach(([pill, plant]) => {
      const row = table.slice(table.indexOf('>' + plant + '<'));
      want(plant + ' reads as ' + pill, row.slice(0, row.indexOf('</tr>')).includes('ep-pm__status--' + pill));
    });
    console.log(JSON.stringify((table.match(/ep-pm__status--[a-z-]+/g) || [])));
    if (bad.length) { console.error('FAILED\n - ' + bad.join('\n - ')); process.exit(1); }
    return;
  }

  if (empty) {
    // 2. The page must not open on a month with no data.
    want('landed on the month holding work, got ' + selected, selected === nextMonth);
    want('asked for the empty month first, then the one with work: ' + JSON.stringify(asked),
      asked[0][0] === month && asked[0][1] === true && asked.some((a) => a[0] === nextMonth));
    // 1. That month must be inside the picker's range.
    want('the planned month is selectable', picker >= nextMonth);
    want('its work is listed', html.includes('Clean inverter'));
    console.log(JSON.stringify({ selected: selected, picker: picker, asked: asked }));
    if (bad.length) { console.error('FAILED\n - ' + bad.join('\n - ')); process.exit(1); }
    return;
  }

  // 5. Table is the default layout, and the toggle still works and is remembered.
  want('opens on Table', html.includes('ep-pm__register-table') && !html.includes('ep-pm__plants-grid'));
  listeners.click({ target: { closest: (s) => s === '[data-pm-layout]' ? { getAttribute: () => 'cards' } : null } });
  want('the toggle switches to Cards', html.includes('ep-pm__plants-grid'));
  want('the choice is remembered', store['solar91.pmPortfolioLayout.v1.u1'] === 'cards');
  listeners.click({ target: { closest: (s) => s === '[data-pm-layout]' ? { getAttribute: () => 'table' } : null } });

  // 4. Section badges count what they list.
  want('the register badge counts its rows', html.includes('<span>4 plants</span>'));
  if (!empty && !bands) {
    want('saved plan activities have their own section', html.includes('data-pm-cycle-activities'));
    want('the phase row shows planned and chained dates',
      html.includes('Inverter') && html.includes('>Chained</td>'));
    want('plan activities do not inflate work-order counts', html.includes('>8 shown</span>'));
  }

  // 3. A paused plant shows dashes, never zeros, and sits after the planned plants.
  const delta = html.slice(html.indexOf('>Delta<'));
  const deltaRow = delta.slice(0, delta.indexOf('</tr>'));
  want('paused shows dashes', (deltaRow.match(/—/g) || []).length >= 4);
  want('paused shows no zeros', !/>0</.test(deltaRow));
  want('paused takes the Paused pill', deltaRow.includes('ep-pm__status--paused'));
  want('paused sorts last', html.indexOf('>Delta<') > html.indexOf('>Charlie<'));
  want('Not Started is its own state', html.includes('ep-pm__status--not-started'));

  // Compliance ignores the paused plant: 8 of 14 over the three planned ones.
  want('compliance excludes paused plants', html.includes('>57%<'));

  // The chip counts add up to All, with cancelled work outside the set.
  const chips = {};
  html.replace(/data-pm-activity-filter="(\w+)" aria-pressed="\w+">(\w+) <b>(\d+)<\/b>/g,
    (_m, key, _l, n) => { chips[key] = Number(n); return ''; });
  want('chips add up: ' + JSON.stringify(chips),
    chips.all === 8 && chips.upcoming + chips.overdue + chips.completed === chips.all &&
    chips.overdue === 5 && chips.completed === 2 && chips.upcoming === 1);

  // The register reads om_tasks the way the page promises.
  want('equipment reads Inverter-1', html.includes('Inverter-1'));
  want('the assignee display name is used', html.includes('Rakesh Kumar'));
  want('an unassigned work order says so', html.includes('Unassigned'));

  // "View all" applies Upcoming; a row opens that plant's PM page.
  listeners.click({ target: { closest: (s) => s === '[data-pm-view-all]' ? {} : null } });
  want('View all applies Upcoming', /data-pm-activity-filter="upcoming" aria-pressed="true"/.test(html));
  listeners.click({ target: { closest: (s) => s === '[data-pm-open-plant]' ? { getAttribute: () => 'BB-02' } : null } });
  want('a row opens that plant PM page',
    nav.some((c) => c[0] === 'plant' && c[1] === 'BB-02' && c[5] && c[5].pmParent === 'overview'));

  want('portfolio offers only All and Planned plan filters',
    html.includes('data-pm-plan-filter="all"') && html.includes('data-pm-plan-filter="planned"') &&
    !html.includes('data-pm-plan-filter="paused"'));
  // The Planned chip filters the plant register in place without hiding paused status elsewhere.
  listeners.click({ target: { closest: (s) => s === '[data-pm-plan-filter]' ? { getAttribute: () => 'planned' } : null } });
  const registerOnly = html.slice(html.indexOf('ep-pm__register-table'), html.indexOf('</table>'));
  want('the Planned chip filters the plant register', html.includes('<span>3 plants</span>') &&
    registerOnly.includes('>Alpha<') && !registerOnly.includes('>Delta<'));
  listeners.click({ target: { closest: (s) => s === '[data-pm-plan-filter]' ? { getAttribute: () => 'all' } : null } });

  console.log(JSON.stringify({ picker: picker, chips: chips }));
  if (bad.length) { console.error('FAILED\n - ' + bad.join('\n - ')); process.exit(1); }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required for frontend tests")
@pytest.mark.parametrize("mode", ["populated", "empty", "bands", "plant"])
def test_pm_dashboard_behaves_on_real_record_shapes(mode):
    """Driven against the real module: a portfolio with work in the current month, the day-one
    shape where the only planned work is months ahead, and one plant per status band."""
    run = subprocess.run(["node", "-e", PORTFOLIO_SCRIPT, mode],
                         cwd=ROOT, capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr or run.stdout
