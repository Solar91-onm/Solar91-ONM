"""Extra cleaning must read as extra everywhere a day is shown, not only on the month grid.

A re-clean is work done on its date, but it is not the cycle's progress. If it renders like an
ordinary confirmed day, whoever reads the calendar at billing time counts it twice. These cover the
three places a washing entry is drawn: the chip in the date box, the cards in the day popup opened
by clicking a tile, and the single-entry detail panel behind those cards.

Rendering is done by `assets/js/operations-calendar.js`, so these load the module in node with the
browser globals stubbed and its one export line swapped for the renderers under test -- the same
harness `test_portal_frontend.py` uses.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CALENDAR = ROOT / "assets" / "js" / "operations-calendar.js"
STYLES = ROOT / "assets" / "css" / "calendar.css"

EXPORTS = ("renderCalendarEventChip", "renderEventCards", "renderPortfolioSummaryEvents",
           "renderEventDetail")
EXPORT_LINE = "  global.Solar91PortalCalendar = { render: render };"

PURPLE = "#6b2f8f"


def _event(**over):
    """One saved washing day as loadEvents builds it."""
    event = {
        "date": "2026-11-16", "title": "43 tables cleaned", "status": "Confirmed",
        "isExtra": False, "plantSiteCode": "ABH01", "plantName": "Abhaypur",
        "cycleNo": 3, "cycleCompleted": False, "tablesCleaned": 43,
        "tablesList": "310–352", "reviewStatus": "Confirmed", "jobStatus": "Done",
        "reportedBy": "Nikhil Sharma", "remarks": "", "exceptionReason": "",
        "kind": "washing.done", "equipmentType": "", "reference": "",
        "reportId": "", "canEdit": False, "canDelete": False,
    }
    event.update(over)
    return event


@pytest.fixture(scope="module")
def render():
    source = CALENDAR.read_text(encoding="utf-8")
    assert source.count(EXPORT_LINE) == 1, "the calendar module's export line moved"

    def call(events):
        script = """
          global.window = global;
          global.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
          global.Solar91PortalFormat = { escape: (s) => String(s == null ? '' : s) };
          global.Solar91PortalAPI = { request: () => Promise.resolve({}), can: () => true,
                                      currentUser: () => ({ role: 'O&M Head' }) };
          const fs = require('fs');
          let src = fs.readFileSync('./assets/js/operations-calendar.js', 'utf8');
          src = src.replace(%s, '  global.__i = { %s };');
          eval(src);
          const I = global.__i;
          const events = JSON.parse(process.argv[1]);
          const context = { type: 'washing', plantCode: 'ABH01' };
          const state = { events: events, modalDate: events[0].date, detailEventIndex: 0,
                          modalSearch: '', modalPlant: '', modalStatus: 'all', modalEquipment: '',
                          extraDeleteConfirmId: events[0].confirmDelete ? events[0].reportId : '',
                          extraDeleting: false, extraDeleteError: '' };
          process.stdout.write(JSON.stringify({
            chips: events.map((e) => I.renderCalendarEventChip(e, context)),
            cards: I.renderEventCards(events, context, state),
            summary: I.renderPortfolioSummaryEvents(events, context, state),
            detail: I.renderEventDetail(state, context)
          }));
        """ % (json.dumps(EXPORT_LINE), ", ".join(EXPORTS))
        run = subprocess.run(
            ["node", "-e", script, json.dumps(events)],
            # node emits UTF-8; Windows would otherwise decode it with the console codepage.
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=30,
        )
        assert run.returncode == 0, run.stderr or run.stdout
        return json.loads(run.stdout)

    return call


def test_the_date_box_chip_marks_extra_cleaning(render):
    """The box drawn inside the calendar's date cell -- the one with the table range under it."""
    out = render([_event(), _event(title="10 tables re-cleaned (extra)", isExtra=True,
                                   tablesCleaned=10, tablesList="1–10")])

    ordinary, extra = out["chips"]
    assert "ep-calendar__event--extra" not in ordinary
    assert "ep-calendar__event--complete" in ordinary
    assert "ep-calendar__event--extra" in extra, "no distinct class on the date-box chip"
    # it keeps the detail layout, so the table range still shows under the title
    assert "ep-calendar__event--washing-detail" in extra
    assert "1–10" in extra


def test_calendar_chip_distinguishes_same_table_range_across_cycles(render):
    out = render([
        _event(date="2026-11-01", title="14 tables cleaned", cycleNo=1, cycleCompleted=False,
               tablesCleaned=14, tablesList="14–1", kind="report"),
        _event(date="2026-11-08", title="14 tables cleaned", cycleNo=2, cycleCompleted=False,
               tablesCleaned=14, tablesList="14–1", kind="report"),
    ])

    first, next_cycle = out["chips"]
    assert "Cycle 1 · 14 tables cleaned" in first
    assert "Cycle 2 · 14 tables cleaned" in next_cycle
    assert "Tables: 14–1" in first and "Tables: 14–1" in next_cycle


def test_the_date_box_chip_colour_is_not_overridden_by_a_later_rule():
    """`--extra` and the status classes are all single-class selectors, so the LAST one in the file
    wins. The chip carries both, which makes source order load-bearing: a status rule added below
    `--extra` would silently turn extra cleaning back into an ordinary-looking day."""
    css = STYLES.read_text(encoding="utf-8")
    extra_at = css.index(".ep-calendar__event--extra {")
    assert PURPLE in css[extra_at:extra_at + 400], "the date-box chip is no longer solid purple"
    for loser in ("--complete", "--pending", "--awaiting", "--behind", "--overdue",
                  "--scheduled", "--washing-detail"):
        assert css.index(".ep-calendar__event" + loser + " {") < extra_at, (
            "ep-calendar__event" + loser + " now comes after --extra and overrides it"
        )
    # The table-range line sits inside the chip, so it must inherit the chip's white text. A colour
    # of its own would have higher specificity than `--extra` and stay dark on the purple fill.
    blocks = re.findall(r"([^{}]*\.ep-calendar__event-tables[^{}]*)\{([^}]*)\}", css)
    assert blocks, "the chip's table-range line lost its styling"
    colours = [value.strip() for _selector, body in blocks
               for value in re.findall(r"(?<!-)\bcolor\s*:\s*([^;]+);", body)]
    assert colours == ["inherit"] * len(colours) and colours, \
        "the chip's table-range line sets its own colour (%r) and will stay dark on purple" % colours


def test_opening_the_day_keeps_extra_cleaning_distinct(render):
    """Clicking a tile opens the day's cards; an extra entry must not read as cycle work there."""
    out = render([_event(title="10 tables re-cleaned (extra)", isExtra=True, tablesCleaned=10)])

    assert "ep-calendar__event-card--extra" in out["cards"]
    assert "ep-calendar__extra-badge" in out["cards"]
    assert "does not count towards this cycle" in out["cards"]
    assert "During cycle 3" in out["cards"] and "· Cycle 3 ·" not in out["cards"]


def test_an_ordinary_day_is_untouched_in_the_popup(render):
    out = render([_event()])

    assert "ep-calendar__event-card--extra" not in out["cards"]
    assert "ep-calendar__extra-badge" not in out["cards"]
    assert "Cycle 3" in out["cards"] and "During cycle" not in out["cards"]
    assert "EXTRA" not in out["summary"] and "CLEAN" in out["summary"]
    assert "ep-calendar__detail-extra-note" not in out["detail"]


def test_the_day_summary_badge_says_extra(render):
    out = render([_event(title="10 tables re-cleaned (extra)", isExtra=True)])

    assert "ep-calendar__pm-summary-item--extra" in out["summary"]
    assert "ep-calendar__pm-summary-badge--extra" in out["summary"]
    assert ">EXTRA<" in out["summary"] and ">CLEAN<" not in out["summary"]
    assert "During cycle 3" in out["summary"]


def test_the_detail_panel_explains_what_extra_cleaning_is(render):
    out = render([_event(title="10 tables re-cleaned (extra)", isExtra=True)])

    detail = out["detail"]
    assert "ep-calendar__event-detail-modal--extra" in detail
    assert "ep-calendar__extra-badge" in detail
    assert "ep-calendar__detail-extra-note" in detail
    assert "does not count towards cycle progress" in detail
    assert "does not count towards cycle progress or plant compliance" in detail
    assert "Only extra cleaning after all three cycles are complete increases monthly compliance" in detail
    assert "During cycle 3" in detail, "the Cycle field must not read as this cycle's work"


def test_extra_cleaning_inputs_update_without_replacing_the_focused_field():
    source = CALENDAR.read_text(encoding="utf-8")
    input_start = source.index('host.addEventListener("input", function (event) {')
    input_end = source.index('host.addEventListener("change", function (event) {', input_start)
    input_handler = source[
        input_start:input_end
    ]
    change_start = source.index('host.addEventListener("change", function (event) {', input_end)
    change_end = source.index('host.addEventListener("change", function (event) {', change_start + 1)
    change_handler = source[change_start:change_end]
    input_extra_start = input_handler.index(
        'event.target.matches("[data-extra-list], [data-extra-remarks], [data-extra-date]")'
    )
    input_extra = input_handler[input_extra_start:]
    change_extra_start = change_handler.index("if (active.state.extraOpen &&")
    change_extra_end = change_handler.index("var filter = event.target.dataset.calendarFilter;")
    change_extra = change_handler[change_extra_start:change_extra_end]
    preview_start = source.index("function refreshExtraPreview")
    preview_end = source.index("function syncRecordRangeInputs", preview_start)
    preview = source[preview_start:preview_end]

    assert "refreshExtraPreview(host, active.state);" in input_handler
    assert "refreshKeepingFocus" not in input_extra
    assert "refreshExtraPreview(host, active.state);" in change_extra
    assert "renderView(" not in change_extra
    assert "save.disabled =" in preview
    assert "renderView(" not in preview


def test_managers_can_edit_or_remove_extra_cleaning_from_its_detail(render):
    detail = render([_event(isExtra=True, reportId="report-1", canEdit=True, canDelete=True)])["detail"]

    assert 'data-calendar-action="edit-extra"' in detail
    assert 'data-calendar-action="request-extra-delete"' in detail
    assert "Remove extra cleaning" in detail


def test_removing_extra_cleaning_requires_a_second_confirmation(render):
    detail = render([_event(isExtra=True, reportId="report-1", canEdit=True, canDelete=True,
                            confirmDelete=True)])["detail"]

    assert "This cannot be undone." in detail
    assert 'data-calendar-action="confirm-extra-delete"' in detail
    assert 'data-calendar-action="cancel-extra-delete"' in detail


def test_extra_cleaning_detail_hides_management_actions_from_other_roles(render):
    detail = render([_event(isExtra=True, reportId="report-1")])["detail"]

    assert "Edit extra cleaning" not in detail
    assert "Remove extra cleaning" not in detail


def test_every_purple_class_the_renderers_emit_is_styled():
    """A class with no rule renders as nothing -- the fault that made rows read 'DayMon, 16 Nov'."""
    calendar = CALENDAR.read_text(encoding="utf-8")
    css = STYLES.read_text(encoding="utf-8")
    emitted = set(re.findall(r"ep-calendar__(?:extra-badge|event-card--extra|event-card-extra-note"
                             r"|pm-summary-item--extra|pm-summary-badge--extra"
                             r"|detail-extra-note|event--extra|day-chip--extra)", calendar))
    assert emitted, "the renderers stopped emitting the extra-cleaning classes"
    for name in sorted(emitted):
        assert "." + name in css, name + " is emitted but has no CSS rule"
