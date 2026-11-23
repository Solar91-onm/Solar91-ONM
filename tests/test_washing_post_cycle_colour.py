"""Cleaning after the three cycles must not be shown as "extra cleaning".

Two different things were rendered identically, in the same purple:

  * re-cleaning done while a cycle was still running (`is_extra`) — a calendar record that never
    counts towards compliance;
  * ordinary cleaning done once all three cycles were complete — work the month IS credited for.

Reported by the O&M Head: "extra cleaning purple label is only when extra cleaning between cycles
are done, so after all cycles get complete mention it as a different colour like blue, as they are
contributing in compliance."

`post_cycle` on a report answers which one it is; the purple now means only re-cleaning.
"""
from __future__ import annotations

from pathlib import Path

from app.core.models import WashingDailyReport
from tests.test_washing_cycles import BASE
from tests.test_washing_extra_mid_cycle import _picked, _rows, _team
from tests.test_washing_sheet import _days, _sheet

ROOT = Path(__file__).resolve().parents[1]
CALENDAR_JS = ROOT / "assets" / "js" / "operations-calendar.js"
CALENDAR_CSS = ROOT / "assets" / "css" / "calendar.css"
TOTAL = 4


def _reports(client, plant, month):
    return client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": month}).json()["reports"]


# ── the API tells the two apart ────────────────────────────────────────────


def test_a_day_after_the_three_cycles_is_flagged_post_cycle(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3, d4 = _days(4, back=30)
    for day in (d1, d2, d3):
        assert _sheet(client, plant, [_picked(day, [1, 2, 3, 4])]).status_code == 200
    assert _sheet(client, plant, [_picked(d4, [1, 2, 3, 4])]).status_code == 200

    rows = {r["report_date"]: r for r in _reports(client, plant, d1.strftime("%Y-%m"))}
    after = rows[d4.isoformat()]
    assert after["post_cycle"] is True
    assert after["is_extra"] is False, "it is ordinary work, not re-cleaning"
    for day in (d1, d2, d3):
        assert rows[day.isoformat()]["post_cycle"] is False, "a cycle's own days are not post-cycle"


def test_re_cleaning_during_a_cycle_is_never_post_cycle(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2 = _days(2, back=30)
    assert _sheet(client, plant, [_picked(d1, [1, 2])]).status_code == 200
    assert _sheet(client, plant, [_picked(d2, [1, 2], extra=True)]).status_code == 200

    rows = {r["report_date"]: r for r in _reports(client, plant, d1.strftime("%Y-%m"))}
    assert rows[d2.isoformat()]["is_extra"] is True
    assert rows[d2.isoformat()]["post_cycle"] is False


def test_an_entry_marked_extra_after_the_cycles_stays_extra(client, db):
    """The stored flag is what separates them: a marked entry is re-cleaning wherever it falls."""
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3, d4 = _days(4, back=30)
    for day in (d1, d2, d3):
        assert _sheet(client, plant, [_picked(day, [1, 2, 3, 4])]).status_code == 200
    assert _sheet(client, plant, [_picked(d4, [1, 2], extra=True)]).status_code == 200

    rows = {r["report_date"]: r for r in _reports(client, plant, d1.strftime("%Y-%m"))}
    assert rows[d4.isoformat()]["is_extra"] is True
    assert rows[d4.isoformat()]["post_cycle"] is False, "marked extra is never counted work"


def test_converting_an_extra_entry_makes_it_post_cycle(client, db):
    """The conversion the O&M Head uses on entries saved before the sheet took those days."""
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3, d4 = _days(4, back=30)
    for day in (d1, d2, d3):
        assert _sheet(client, plant, [_picked(day, [1, 2, 3, 4])]).status_code == 200
    assert _sheet(client, plant, [_picked(d4, [1, 2], extra=True)]).status_code == 200

    extra = next(r for r in _rows(db, plant) if r.is_extra)
    body = client.patch(f"{BASE}/daily-reports/{extra.id}", json={"is_extra": False}).json()
    assert body["is_extra"] is False
    assert body["post_cycle"] is True, "the write response already says how it will be shown"

    db.expire_all()
    assert db.get(WashingDailyReport, extra.id).is_extra is False


# ── and the page shows them differently ────────────────────────────────────


def test_the_calendar_gives_post_cycle_work_its_own_treatment():
    js = CALENDAR_JS.read_text(encoding="utf-8")

    assert "function isPostCycleReport(report)" in js
    assert "report.post_cycle === true" in js
    for marker in ("ep-calendar__event--after-cycles", "ep-calendar__event-card--after-cycles",
                   "ep-calendar__after-badge", "ep-calendar__pm-summary-badge--after-cycles",
                   "ep-calendar__detail-after-note"):
        assert marker in js, marker
    assert "After cycle " in js, "the chip says which cycle it came after"


def test_the_two_notes_say_opposite_things_about_counting():
    js = CALENDAR_JS.read_text(encoding="utf-8")

    assert "calendar record only, never counted" in js          # re-cleaning
    assert "it counts towards the month and can take the" in js                # post-cycle
    assert "plant above 100%" in js


def test_the_record_sheet_does_not_call_post_cycle_work_extra():
    js = CALENDAR_JS.read_text(encoding="utf-8")
    row = js[js.index('if (row.report.is_extra === true) numbers += " (extra cleaning)";'):]
    row = row[:row.index("\n", row.index("isPostCycleReport(row.report)"))]

    assert '(after the three cycles · counts)' in row or "(after the three cycles" in row
    assert "isPostCycleReport(row.report)" in row


def test_blue_is_defined_and_is_not_the_purple_of_re_cleaning():
    css = CALENDAR_CSS.read_text(encoding="utf-8")

    after = css[css.index(".ep-calendar__event--after-cycles {"):]
    after = after[:after.index("}")]
    assert "#1366b0" in after, "the blue treatment"
    assert "#6b2f8f" not in after, "never the re-cleaning purple"

    extra = css[css.index(".ep-calendar__event--extra {"):]
    extra = extra[:extra.index("}")]
    assert "#6b2f8f" in extra, "re-cleaning keeps its purple"
