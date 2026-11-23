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

    assert '"pm-overview": ["pm-cycle-plans"]' in modules
    assert "component" in modules, "the dependency is documented as a component, not a sibling panel"


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
    assert "data-pm-paused-filter" in overview, "the paused count filters the register in place"
    header = overview[overview.index("'<h1>Preventive Maintenance</h1>"):]
    assert "plannedLine()" in header[:400], "the line sits under the portfolio title"


def test_the_paused_count_filters_rather_than_opening_another_page():
    overview = _text(OVERVIEW)
    handler = overview[overview.index('if (event.target.closest("[data-pm-paused-filter]"))'):]
    handler = handler[:handler.index("var layoutButton")]

    assert "state.pausedOnly = !state.pausedOnly;" in handler
    assert "scrollIntoView" in handler
    assert "selectView" not in handler and "selectPlantPage" not in handler


def test_a_paused_plant_reads_as_paused_and_never_as_a_zero():
    """The Module Cleaning tile reported 0% for plants that had done real work. Not repeated."""
    overview = _text(OVERVIEW)

    assert "function isPaused(siteCode)" in overview
    assert "function pausedTag(siteCode)" in overview
    # Both register layouts leave the compliance figure blank rather than showing 0%.
    assert 'paused || pm.compliancePercent == null ? "—"' in overview
    assert 'cardPaused || pm.compliancePercent == null ? "—"' in overview
    assert 'isPaused(plant.siteCode) || pm.compliancePercent == null' in overview
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
