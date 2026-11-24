"""Preventive Maintenance has exactly TWO screens, not two views stacked on one page.

The bug: `index.html` put `data-pm-cycle-plans-host` and `data-pm-overview-host` inside the same
tab, and `navigation.js` filled both whenever PM opened, so the cycle-plan editor appeared above the
portfolio view on the all-plants screen AND on a single plant's screen.

Now:
  1. ALL-PLANTS PM — the portfolio view pm-overview.js already rendered, plus a compact
     planned/paused line in its header and a planned-or-paused state per plant in the register.
     No editor anywhere on it.
  2. SINGLE-PLANT PM — the same page from either route (Overview -> plant, or Plants -> plant),
     differing only in the breadcrumb, with THAT PLANT'S tracker as a section of the page.

These are source-structure assertions, which is what the suite can check for navigation wiring; the
behaviour itself was driven in a browser.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "frontend" / "templates" / "index.html"
NAVIGATION = ROOT / "assets" / "js" / "navigation.js"
OVERVIEW = ROOT / "assets" / "js" / "pm-overview.js"
TRACKER = ROOT / "assets" / "js" / "pm-cycle-plans.js"
MODULES = ROOT / "assets" / "js" / "modules.js"
PM_CSS = ROOT / "assets" / "css" / "pm-overview.css"


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# ── one screen per page ─────────────────────────────────────────────────────


def test_the_pm_tab_holds_exactly_one_host():
    page = _text(INDEX)
    section = re.search(r'<section class="ep-tab-view" data-tab-view="pm-overview">(.*?)</section>', page, re.S)
    assert section, "the PM tab section moved"
    body = section.group(1)

    assert "data-pm-overview-host" in body
    assert "data-pm-cycle-plans-host" not in body, "the editor must not be stacked on the PM page"
    assert "data-pm-cycle-plans-host" not in page, "the orphaned host must be gone, not just unused"


def test_navigation_does_not_mount_the_tracker_itself():
    """Navigation picks a screen; it does not stack two modules into one."""
    navigation = _text(NAVIGATION)

    assert "Solar91PortalPMCyclePlans" not in navigation
    assert "Solar91PortalPMOverview" in navigation, "the PM page is still pm-overview's"


def test_the_plant_page_mounts_the_tracker_as_a_section_of_itself():
    overview = _text(OVERVIEW)

    assert "data-pm-tracker-host" in overview, "the tracker is a section of the plant page"
    assert "function mountTracker()" in overview
    assert "global.Solar91PortalPMCyclePlans.show(host, {" in overview
    assert "siteCode: state.siteCode" in overview
    # Mounted only on a plant's page: the portfolio branch of render() must not touch it.
    plant_branch = overview[overview.index("if (row) {"):overview.index("state.host.innerHTML = portfolioContent();")]
    assert "mountTracker();" in plant_branch


def test_the_tracker_needs_a_plant_and_refuses_to_render_without_one():
    """Belt and braces: even if something mounted it portfolio-wide, it draws nothing."""
    tracker = _text(TRACKER)
    show = tracker[tracker.index("function show(host, options)"):]

    assert 'if (!siteCode) { host.innerHTML = ""; return; }' in show


def test_modules_keeps_the_tracker_as_a_component_of_the_pm_page():
    modules = _text(MODULES)

    assert '"pm-overview": ["pm-cycle-plans"' in modules
    assert "component" in modules, "the dependency is documented as a component, not a sibling panel"
    # The portfolio's two registers use the SHARED sort and column-filter modules, not copies.
    assert '"pm-overview": ["pm-cycle-plans", "table-sort", "table-column-filter"]' in modules


def test_the_orphaned_stylesheet_is_gone_and_its_styles_live_with_the_plant_page():
    assert not (ROOT / "assets" / "css" / "pm-cycle-plans.css").exists()
    assert "pm-cycle-plans.css" not in _text(INDEX)

    css = _text(PM_CSS)
    assert ".ep-pm__tracker {" in css, "the tracker styles moved into the plant page's stylesheet"
    assert ".ep-pm__tracker-grid {" in css
    assert "ep-cp__" not in css, "the old panel's own visual system is dropped"


# ── the all-plants screen carries what the panel was carrying ───────────────


def test_the_portfolio_header_states_how_many_plants_are_planned_and_paused():
    overview = _text(OVERVIEW)

    assert "function plannedLine()" in overview
    assert "plants planned" in overview
    assert "data-pm-plan-filter" in overview, "the counts filter the register in place"
    header = overview[overview.index("'<h1>Preventive Maintenance</h1>"):]
    assert "plannedLine()" in header[:400], "the line sits under the portfolio title"


def test_the_plan_filter_is_three_way_and_opens_on_all():
    """Changed deliberately: it was a paused-only toggle.

    Reported from the live portal — with the toggle on, the page read "13 of 42 plants planned" over
    an empty register and there was no way to ask for those 13. This is the index page for every
    plant's PM, so it opens on All and can be pointed at Planned or Paused.
    """
    overview = _text(OVERVIEW)

    assert 'planFilter: "all"' in overview, "the page opens showing every plant"
    for choice in ('["all", "All "', '["planned", "Planned "', '["paused", "Paused "'):
        assert choice in overview, choice
    assert 'state.planFilter === "paused" && !isPaused(plant.siteCode)' in overview
    assert 'state.planFilter === "planned" && isPaused(plant.siteCode)' in overview
    assert "pausedOnly" not in overview, "no remnant of the two-way toggle"


def test_the_plan_filter_filters_rather_than_opening_another_page():
    overview = _text(OVERVIEW)
    handler = overview[overview.index('var planButton = event.target.closest("[data-pm-plan-filter]");'):]
    handler = handler[:handler.index("var layoutButton")]

    assert 'state.planFilter = planButton.getAttribute("data-pm-plan-filter") || "all";' in handler
    assert "scrollIntoView" in handler
    assert "selectView" not in handler and "selectPlantPage" not in handler


def test_asking_for_the_planned_plants_says_what_it_is_showing():
    overview = _text(OVERVIEW)

    assert "Showing plants with a cycle plan. Open a plant to see its tracker." in overview
    assert "Showing paused plants only." in overview


def test_a_paused_plant_reads_as_paused_and_never_as_a_zero():
    """The Module Cleaning tile reported 0% for plants that had done real work. Not repeated."""
    overview = _text(OVERVIEW)

    assert "function isPaused(siteCode)" in overview
    assert "function pausedTag(siteCode)" in overview
    # Every layout leaves a paused plant's figures blank rather than showing 0 or 0%.
    assert 'completion: paused || pm.compliancePercent == null ? null' in overview
    assert 'cardPaused || pm.compliancePercent == null ? "—"' in overview
    plant_tiles = overview[overview.index("  function plantMetrics(row, entries) {"):]
    plant_tiles = plant_tiles[:plant_tiles.index("\n  }\n")]
    assert "var paused = isPaused(row.plant.siteCode);" in plant_tiles
    assert "paused || pm.compliancePercent == null ? null" in plant_tiles
    assert 'paused ? "—"' in plant_tiles, "a paused plant's counts are unknown, not zero" 
    assert "ep-pm__paused-badge" in overview


def test_the_paused_state_is_muted_not_an_error_colour():
    css = _text(PM_CSS)
    badge = css[css.index(".ep-pm__paused-badge {"):]
    badge = badge[:badge.index("}")]

    assert "--ep-grey-soft" in badge and "--ep-text-muted" in badge
    assert "--ep-red" not in badge, "a paused plant has not failed"


# ── the tracker itself ─────────────────────────────────────────────────────


def test_the_grid_is_the_editor_and_can_be_driven_without_a_mouse():
    tracker = _text(TRACKER)

    assert "data-cp-day=" in tracker and "data-cp-chip=" in tracker
    assert 'addEventListener("dragstart"' in tracker and 'addEventListener("drop"' in tracker
    # Keyboard and touch paths for the same move.
    assert 'addEventListener("keydown"' in tracker and '"ArrowRight"' in tracker
    assert "data-cp-nudge" in tracker and "data-cp-set-day" in tracker


def test_the_tracker_shows_the_planned_day_and_what_will_actually_run():
    tracker = _text(TRACKER)

    assert "state.preview.chained" in tracker
    assert "is-run" in tracker, "where chaining will really run it"
    assert "moved_days" in tracker and "past_cycle_days" in tracker and "clamped_from" in tracker
    assert "next cycle" in tracker and "never rewritten" in tracker


def test_the_inverter_phase_is_marked_as_unit_derived():
    tracker = _text(TRACKER)

    assert 'UNIT_DERIVED = ["inverter"]' in tracker
    assert "is-derived" in tracker
    assert "unit count" in tracker


def test_validation_is_live_and_names_the_phase():
    tracker = _text(TRACKER)
    check = tracker[tracker.index("function localProblem(phases)"):tracker.index("function payloadPhases()")]

    assert "is already planned in" in check          # a repeated category
    assert "must come after the previous phase's day" in check
    assert "run past day" in check                   # month-end overflow
    assert "name +" in check, "every message names the phase at fault"
    assert "schedulePreview();" in tracker, "the server checks the same plan as it is typed"


def test_the_tracker_reads_as_a_tracker_not_only_an_editor():
    tracker = _text(TRACKER)

    assert "function dayWork(meta)" in tracker
    assert '"Completed"' in tracker and '"Overdue"' in tracker
    assert "is-done" in tracker and "is-overdue" in tracker and "is-open" in tracker


def test_editing_rights_come_from_the_server_not_from_a_role_guess():
    tracker = _text(TRACKER)

    assert "state.plan.can_edit" in tracker
    assert "Assignee" in tracker, "the page says who may change the days"
    # No local role list deciding who can write.
    assert 'role() === "O&M Head"' not in tracker


def test_the_month_grid_uses_the_months_real_length():
    tracker = _text(TRACKER)
    meta = tracker[tracker.index("function monthMeta(month)"):tracker.index("function dayNumber(")]

    assert "Date.UTC(year, mon, 0)" in meta, "the real last day of the month, not a fixed 30"
    assert "firstWeekday" in meta
    assert "AUTHOR_DAYS = 30" in tracker, "authoring stays month-length independent"


def test_the_cycle_month_is_what_the_api_is_asked_about():
    tracker = _text(TRACKER)

    assert "cycle_start=\" + meta.start" in tracker
    assert 'start: (m ? month : businessToday().slice(0, 7)) + "-01"' in tracker


def test_the_tracker_names_who_last_changed_the_plan():
    tracker = _text(TRACKER)

    assert "function attribution()" in tracker
    assert "Last changed" in tracker
    assert "plan.updated_by" in tracker and "plan.updated_at" in tracker


def test_the_paused_plant_page_offers_the_action_to_create_a_plan():
    tracker = _text(TRACKER)
    paused = tracker[tracker.index("function pausedBlock()"):tracker.index("function renderHeadActions()")]

    assert "from-default" in paused and "add-phase" in paused
    assert "left out of PM compliance" in paused or "paused_hint" in paused
    assert "already generated are not affected" in paused or "paused_hint" in paused


def test_the_modules_json_still_lists_the_tracker_as_a_lazy_module():
    page = _text(INDEX)
    block = re.search(r'<script id="s91-modules" type="application/json">(.*?)</script>', page, re.S)
    assert block
    modules = json.loads(block.group(1))

    assert modules.get("pm-cycle-plans") == "/assets/js/pm-cycle-plans.js"
    assert (ROOT / "assets" / "js" / "pm-cycle-plans.js").exists()


# ── looking at a month that has not started, and listing every plant ─────────
#
# Reported from the live portal: the PM page showed "13 of 42 plants planned" above a register that
# said "No active plants match these filters", and December — the month the loaded plans first run
# in — could not be selected at all.


def test_the_register_keeps_a_plant_that_has_no_work_orders():
    """The register is "PM status by plant", not "plants with work orders".

    The From/To filters are pre-filled with the whole month, so the old `(dateFrom || dateTo) &&
    !entries.length` test fired for every plant in a month where PM had not been generated yet and
    emptied the entire portfolio.
    """
    overview = _text(OVERVIEW)

    assert "function narrowedDates()" in overview
    assert "if (narrowedDates() && !entries.length) return false;" in overview
    assert "(state.filters.dateFrom || state.filters.dateTo) && !entries.length" not in overview

    narrowed = overview[overview.index("function narrowedDates()"):]
    narrowed = narrowed[:narrowed.index("\n  }")]
    assert "state.filters.dateFrom > bounds.start" in narrowed
    assert "state.filters.dateTo < bounds.end" in narrowed


def test_a_month_that_has_not_started_can_be_selected():
    """A plan takes effect from the NEXT cycle, so the month it will first run in must be reachable."""
    overview = _text(OVERVIEW)

    assert "function monthMax()" in overview
    assert 'max="\' + monthMax() + \'"' in overview
    assert "businessToday().slice(0, 7) + '\" /></label>'" not in overview, "the cap on the current month is gone"
    assert "Choose a month up to" in overview


def test_a_future_month_is_not_asked_of_the_compliance_range():
    """`/api/portal/overview/range` refuses a future end date, so the page must not ask."""
    overview = _text(OVERVIEW)

    assert "function futureMonth(month)" in overview
    assert "if (ahead) {" in overview
    ahead = overview[overview.index("if (ahead) {"):]
    ahead = ahead[:ahead.index("} else {")]
    assert "state.rows = plannedRows();" in ahead
    assert "fetchPortfolioRange" not in ahead, "no range request for a month with nothing due"


def test_a_future_month_still_lists_every_plant_with_its_plan_state():
    overview = _text(OVERVIEW)

    assert "function plannedRows()" in overview
    planned = overview[overview.index("function plannedRows()"):]
    planned = planned[:planned.index("\n  function periodRange")]
    assert "state.cyclePlans" in planned, "the plants come from the cycle-plan listing"
    assert "compliancePercent: null" in planned, "nothing is measurable yet, so it reads as unknown"
    assert "site_code" in planned and "p.plant" in planned


def test_a_future_month_says_why_the_figures_are_blank():
    overview = _text(OVERVIEW)

    assert "has not started yet, so there is nothing due to measure" in overview
    # Both screens say it: the portfolio and a plant's own page.
    assert overview.count("has not started yet, so there is nothing due to measure") == 2


def test_the_backend_rule_this_works_around_is_still_in_place():
    """The page avoids the request rather than loosening the API's own guard."""
    router = (ROOT / "app" / "portal" / "router.py").read_text(encoding="utf-8")

    assert "End date cannot be in the future." in router


# ── a way out of the filters ────────────────────────────────────────────────
#
# The Plant filter already opens on "All active plants"; what was missing was any way back once a
# filter had been chosen. Combined with the register bug above, that left a page reading
# "13 of 42 plants planned" over "No active plants match these filters" and no control to undo it.


def test_the_plant_filter_opens_on_all_plants():
    overview = _text(OVERVIEW)
    options = overview[overview.index("function plantOptions(rows, selected)"):]
    options = options[:options.index("\n  }")]

    assert '<option value="">All active plants</option>' in options
    assert "row.plant.siteCode === selected" in options, "a chosen plant stays chosen"


def test_a_clear_control_appears_only_while_something_is_narrowing():
    overview = _text(OVERVIEW)

    assert "function filtersNarrowing()" in overview
    narrowing = overview[overview.index("function filtersNarrowing()"):]
    narrowing = narrowing[:narrowing.index("\n  }")]
    for condition in ("state.filters.query.trim()", "state.filters.plant", "state.filters.equipment",
                     'state.filters.status !== "all"', 'state.planFilter !== "all"', "narrowedDates()"):
        assert condition in narrowing, condition

    # The control is rendered only while something is narrowing, in the register panel and in the
    # empty register itself.
    assert overview.count(
        '(filtersNarrowing()') >= 2, "both the panel and the empty register ask filtersNarrowing()"
    assert overview.count(
        'data-pm-clear-filters>Clear filters</button>') >= 2


def test_clearing_puts_every_filter_back_to_the_whole_month():
    overview = _text(OVERVIEW)
    clear = overview[overview.index("function clearFilters()"):]
    clear = clear[:clear.index("\n  }")]

    assert 'state.filters.query = "";' in clear
    assert 'state.filters.plant = "";' in clear
    assert 'state.filters.equipment = "";' in clear
    assert 'state.filters.status = "all";' in clear
    assert "state.filters.dateFrom = bounds.start;" in clear
    assert "state.filters.dateTo = bounds.end;" in clear
    assert 'state.planFilter = "all";' in clear, "the plan filter goes back to every plant too"


def test_both_register_layouts_offer_the_clear_control_when_empty():
    overview = _text(OVERVIEW)

    cards = overview[overview.index("No active plants match these filters."):]
    assert "data-pm-clear-filters" in cards[:400]
    table = overview[overview.index("No plants match these filters."):]
    assert "data-pm-clear-filters" in table[:300]
    # With nothing narrowing, an empty month says so plainly instead of blaming filters.
    assert "No active plants to show for this month." in overview


def test_the_clear_control_is_wired_before_the_other_filter_buttons():
    overview = _text(OVERVIEW)
    handler = overview[overview.index('if (event.target.closest("[data-pm-clear-filters]"))'):]
    handler = handler[:handler.index("[data-pm-plan-filter]")]

    assert "clearFilters();" in handler and "render();" in handler
