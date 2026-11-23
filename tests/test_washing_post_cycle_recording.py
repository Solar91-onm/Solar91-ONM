"""Recording cleaning AFTER the month's three cycles are complete, and what counts.

The O&M Head's rules, in their words:

  * once the three cycles are complete, whatever cleaning takes place for the rest of the month
    is entered on the ordinary cycle sheet and contributes to the compliance score;
  * an entry recorded through "+ Extra cleaning" is re-cleaning: a calendar record that never
    contributes, wherever in the month it falls;
  * a new cycle started on the same day as a completion still counts.

Before this, the sheet refused ordinary readings once Cycle 3 was full, so post-cycle work could
only be saved as extra -- and a special case made *that* kind of extra count. Both halves are gone:
the sheet takes the readings, and "extra" means only re-cleaning. Entries saved the old way are
converted with PATCH `is_extra: false` rather than silently losing their credit.
"""
from __future__ import annotations

from datetime import date

from app.core.models import WashingDailyReport
from app.scheduled.washing_cycles import _cycle_work_scores
from tests import conftest
from tests.test_washing_cycles import BASE
from tests.test_washing_extra_mid_cycle import _R, _picked, _rows, _team
from tests.test_washing_sheet import _days, _engineer, _sheet

TOTAL = 4  # _plant(db) configures 4 tables per cycle


def _cycles(client, plant, month):
    return client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": month}).json()


def _fill_three_cycles(client, plant, days):
    """Cycles 1-3 of a 4-table plant, one full day each."""
    for day in days:
        assert _sheet(client, plant, [_picked(day, [1, 2, 3, 4])]).status_code == 200


# ─────────────────── the sheet keeps taking readings after the three cycles ───────────────────


def test_an_ordinary_day_after_all_three_cycles_is_accepted_and_counts(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3, d4 = _days(4, back=30)
    _fill_three_cycles(client, plant, [d1, d2, d3])
    month = d1.strftime("%Y-%m")

    before = _cycles(client, plant, month)
    assert before["summary"]["cycles_completed"] == 3

    saved = _sheet(client, plant, [_picked(d4, [1, 2, 3, 4])])
    assert saved.status_code == 200, saved.text
    assert saved.json()["reports"][0]["is_extra"] is False, "post-cycle work is an ordinary day"

    after = _cycles(client, plant, month)
    assert after["summary"]["extra_tables"] == 4, "the surplus is reported as extra washing"
    assert after["summary"]["times_washed"] == 4.0
    assert [cycle["confirmed"] for cycle in after["cycles"]] == [4, 4, 8], \
        "the last cycle carries the month's surplus, which is what `extra_tables` measures"


def test_post_cycle_work_raises_the_monthly_score_above_the_plan(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3, d4 = _days(4, back=30)
    _fill_three_cycles(client, plant, [d1, d2, d3])

    assert _sheet(client, plant, [_picked(d4, [1, 2])]).status_code == 200

    work = _cycle_work_scores(_rows(db, plant), TOTAL, d4, None, set())
    assert work["month"]["tables_done"] == 14, "3 full cycles (12) + 2 tables cleaned afterwards"


def test_the_same_tables_can_be_cleaned_again_after_the_cycles(client, db):
    """A table is once-per-cycle while a cycle runs; after the three cycles it is free again."""
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3, d4, d5 = _days(5, back=30)
    _fill_three_cycles(client, plant, [d1, d2, d3])

    assert _sheet(client, plant, [_picked(d4, [1, 2, 3, 4])]).status_code == 200
    repeat = _sheet(client, plant, [_picked(d5, [1, 2, 3, 4])])
    assert repeat.status_code == 200, repeat.text


def test_a_date_that_already_has_a_cycle_day_can_carry_post_cycle_work(client, db):
    """The one-entry-per-date guard must not block cleaning once the cycles are full."""
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3 = _days(3, back=30)
    _fill_three_cycles(client, plant, [d1, d2, d3])

    same_day = _sheet(client, plant, [_picked(d3, [1, 2])])
    assert same_day.status_code == 200, same_day.text
    assert same_day.json()["reports"][0]["is_extra"] is False


def test_a_second_entry_in_a_running_cycle_is_still_refused(client, db):
    """The guard still holds where it matters: two entries that land in the SAME cycle."""
    plant, _head, _assignee = _team(client, db)
    d1, = _days(1, back=30)
    assert _sheet(client, plant, [_picked(d1, [1, 2])]).status_code == 200

    again = _sheet(client, plant, [_picked(d1, [3, 4])])
    assert again.status_code == 409
    assert "already" in again.json()["detail"].lower()


# ─────────────────────────── "+ Extra cleaning" never scores ───────────────────────────


def test_extra_cleaning_after_the_three_cycles_does_not_count(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3, d4 = _days(4, back=30)
    _fill_three_cycles(client, plant, [d1, d2, d3])

    assert _sheet(client, plant, [_picked(d4, [1, 2], extra=True)]).status_code == 200

    work = _cycle_work_scores(_rows(db, plant), TOTAL, d4, None, set())
    assert work["month"]["tables_done"] == 12, "the three cycles only; marked extra adds nothing"


def test_marked_extra_never_counts_wherever_it_falls():
    """The rule in isolation: before, during or after the cycles, marked extra is not scored."""
    today = date(2026, 11, 28)
    cycles = [
        _R(date(2026, 11, 5), 4, 1, completed=True, numbers=range(1, 5)),
        _R(date(2026, 11, 14), 4, 2, completed=True, numbers=range(1, 5)),
        _R(date(2026, 11, 24), 4, 3, completed=True, numbers=range(1, 5)),
    ]
    plain = _cycle_work_scores(cycles, TOTAL, today, None, set())["month"]["tables_done"]
    with_extra = _cycle_work_scores(
        cycles + [_R(date(2026, 11, 26), 4, 3, extra=True, numbers=range(1, 5))],
        TOTAL, today, None, set())["month"]["tables_done"]
    assert with_extra == plain


# ─────────────── converting work that was saved as extra before the sheet allowed it ───────────────


def test_an_extra_entry_can_be_converted_to_an_ordinary_counted_day(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3, d4 = _days(4, back=30)
    _fill_three_cycles(client, plant, [d1, d2, d3])
    assert _sheet(client, plant, [_picked(d4, [1, 2, 3, 4], extra=True)]).status_code == 200

    extra = next(r for r in _rows(db, plant) if r.is_extra)
    assert _cycle_work_scores(_rows(db, plant), TOTAL, d4, None, set())["month"]["tables_done"] == 12

    converted = client.patch(f"{BASE}/daily-reports/{extra.id}", json={"is_extra": False})
    assert converted.status_code == 200, converted.text
    assert converted.json()["is_extra"] is False

    db.expire_all()
    assert _cycle_work_scores(_rows(db, plant), TOTAL, d4, None, set())["month"]["tables_done"] == 16, \
        "once it is ordinary cleaning, the month is credited for it"


def test_an_assignee_can_convert_extra_cleaning(client, db):
    plant, _head, assignee = _team(client, db)
    d1, d2, d3, d4 = _days(4, back=30)
    _fill_three_cycles(client, plant, [d1, d2, d3])
    assert _sheet(client, plant, [_picked(d4, [1, 2], extra=True)]).status_code == 200
    extra = next(r for r in _rows(db, plant) if r.is_extra)

    conftest._CURRENT_USER = assignee
    assert client.patch(f"{BASE}/daily-reports/{extra.id}", json={"is_extra": False}).status_code == 200


def test_a_site_engineer_cannot_change_how_cleaning_is_counted(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3, d4 = _days(4, back=30)
    _fill_three_cycles(client, plant, [d1, d2, d3])
    assert _sheet(client, plant, [_picked(d4, [1, 2], extra=True)]).status_code == 200
    extra = next(r for r in _rows(db, plant) if r.is_extra)

    engineer = _engineer(client, db, plant, email="post-cycle-engineer@example.com")
    conftest._CURRENT_USER = engineer
    refused = client.patch(f"{BASE}/daily-reports/{extra.id}", json={"is_extra": False})
    assert refused.status_code == 403
    db.expire_all()
    assert db.get(WashingDailyReport, extra.id).is_extra is True
