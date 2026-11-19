"""Module Cleaning cycles advance only after every configured table has been cleaned."""
from __future__ import annotations

from app.core.models import WashingDailyReport
from app.scheduled.washing_cycles import _cycle_sequence
from tests import conftest
from tests.test_washing_cycles import BASE, _plant, _setup_cycle_users
from tests.test_washing_sheet import _days, _engineer, _sheet


def _picked(day, numbers):
    return {"report_date": day.isoformat(), "job_status": "Done", "tables_cleaned": len(numbers), "table_numbers": numbers}


def _cycles(db, plant):
    db.expire_all()
    rows = db.query(WashingDailyReport).filter_by(plant_id=plant.id).order_by(WashingDailyReport.report_date).all()
    return [row.cycle_no for row in rows], [row.cycle_completed for row in rows]


def _team(client, db, who="head"):
    """A 4-table plant, with the O&M Head or the plant's washing Assignee signed in."""
    plant = _plant(db)
    head, assignee = _setup_cycle_users(client, db, plant)
    conftest._CURRENT_USER = head if who == "head" else assignee
    return plant, head, assignee


def test_cycle_sequence_counts_distinct_tables_not_calendar_dates_or_repeats():
    om, se = True, False
    # Repeated codes do not complete a cycle or force the next cycle, regardless of who entered them.
    assert _cycle_sequence([(2, True, {1, 2}, om), (2, True, {1, 2}, om)], 4) == [(1, False), (1, False)]
    assert _cycle_sequence([(2, True, {1, 2}, om), (2, True, {2, 3}, om)], 4) == [(1, False), (1, False)]
    assert _cycle_sequence([(2, True, {1, 2}, om), (2, True, {1, 2}, se)], 4) == [(1, False), (1, False)]
    assert _cycle_sequence([(2, True, {1, 2}, om), (2, False, {1, 2}, om)], 4) == [(1, False), (1, False)]
    # Cycle 2 starts on the day after the fourth distinct table is cleaned, even if dates are close together.
    assert _cycle_sequence([(2, True, {1, 2}, om), (2, True, {3, 4}, om), (1, True, {1}, se)], 4) == [
        (1, False), (1, False), (2, False)
    ]
    assert _cycle_sequence([(4, True), (2, True)], 4) == [(1, False), (2, False)]
    # Count-only reports remain supported, and further work after Cycle 3 is extra washing there.
    assert [cycle for cycle, _extra in _cycle_sequence([(4, True)] * 3 + [(1, True)], 4)] == [1, 2, 3, 3]
    assert _cycle_sequence([(4, True)] * 3 + [(1, True)], 4)[-1][1] is True


def test_om_repeat_is_rejected_until_cycle_is_complete_then_next_cycle_starts(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3, d4 = _days(4, back=60)

    assert _sheet(client, plant, [_picked(d1, [1, 2, 3])]).status_code == 200
    repeat = _sheet(client, plant, [_picked(d2, [1, 2, 3])])
    assert repeat.status_code == 409 and "already recorded in cycle 1" in repeat.json()["detail"]
    assert _cycles(db, plant)[0] == [1]

    finish = _sheet(client, plant, [_picked(d2, [4])])
    assert finish.status_code == 200, finish.text
    assert finish.json()["reports"][0]["cycle_no"] == 1
    assert finish.json()["reports"][0]["cycle_completed"] is True

    next_cycle = _sheet(client, plant, [_picked(d3, [1, 2, 3]), _picked(d4, [4])])
    assert next_cycle.status_code == 200, next_cycle.text
    assert [row["cycle_no"] for row in next_cycle.json()["reports"]] == [2, 2]
    assert [row["cycle_completed"] for row in next_cycle.json()["reports"]] == [False, True]
    cycles, completed = _cycles(db, plant)
    assert cycles == [1, 1, 2, 2] and completed == [False, True, False, True]

    month = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": d1.strftime("%Y-%m")})
    assert month.status_code == 200, month.text
    by_no = {cycle["cycle_no"]: cycle for cycle in month.json()["cycles"]}
    assert by_no[1]["state"] == "Completed" and by_no[2]["state"] == "Completed"
    assert by_no[3]["state"] == "In progress"


def test_cycle_two_is_not_active_until_cycle_one_is_complete(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2 = _days(2, back=30)
    assert _sheet(client, plant, [_picked(d1, [1, 2])]).status_code == 200

    month = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": d1.strftime("%Y-%m")})
    assert month.status_code == 200, month.text
    states = {cycle["cycle_no"]: cycle["state"] for cycle in month.json()["cycles"]}
    assert states == {1: "In progress", 2: "Upcoming", 3: "Upcoming"}

    finish = _sheet(client, plant, [_picked(d2, [3, 4])])
    assert finish.status_code == 200, finish.text
    month = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": d1.strftime("%Y-%m")})
    states = {cycle["cycle_no"]: cycle["state"] for cycle in month.json()["cycles"]}
    assert states == {1: "Completed", 2: "In progress", 3: "Upcoming"}


def test_partly_repeated_day_is_rejected_for_the_whole_day(client, db):
    plant, _head, _assignee = _team(client, db, who="assignee")
    d1, d2 = _days(2, back=30)
    assert _sheet(client, plant, [_picked(d1, [1, 2])]).status_code == 200

    response = _sheet(client, plant, [_picked(d2, [2, 3])])

    assert response.status_code == 409 and "Table 2 is already recorded in cycle 1" in response.json()["detail"]
    assert _cycles(db, plant)[0] == [1]


def test_engineer_repeat_is_refused_and_next_cycle_begins_after_full_clean(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3, d4 = _days(4)
    assert _sheet(client, plant, [_picked(d1, [1, 2]), _picked(d2, [3, 4])]).status_code == 200
    _engineer(client, db, plant)

    first = _sheet(client, plant, [_picked(d3, [1])])
    assert first.status_code == 200, first.text
    assert first.json()["reports"][0]["cycle_no"] == 2
    repeat = _sheet(client, plant, [_picked(d4, [1])])
    assert repeat.status_code == 409 and "already recorded in cycle 2" in repeat.json()["detail"]
    assert _cycles(db, plant)[0] == [1, 1, 2]


def test_cycle_three_repeat_is_refused_before_it_is_full(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3, d4 = _days(4, back=60)
    assert _sheet(client, plant, [
        _picked(d1, [1, 2, 3, 4]),
        _picked(d2, [1, 2, 3, 4]),
        _picked(d3, [1]),
    ]).status_code == 200

    refused = _sheet(client, plant, [_picked(d4, [1])])

    assert refused.status_code == 409
    assert "Table 1 is already recorded in cycle 3" in refused.json()["detail"]
    assert "last cycle" in refused.json()["detail"]
    assert _cycles(db, plant)[0] == [1, 2, 3]


def test_editing_a_completed_cycle_below_table_count_reopens_it(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2 = _days(2, back=60)
    saved = _sheet(client, plant, [_picked(d1, [1, 2]), _picked(d2, [3, 4])])
    assert [row["cycle_no"] for row in saved.json()["reports"]] == [1, 1]
    assert saved.json()["reports"][1]["cycle_completed"] is True

    edited = client.patch(f"{BASE}/daily-reports/{saved.json()['reports'][1]['id']}", json={"table_numbers": [3]})

    assert edited.status_code == 200, edited.text
    assert edited.json()["cycle_no"] == 1 and edited.json()["cycle_completed"] is False
    assert _cycles(db, plant)[0] == [1, 1]


def test_one_date_can_finish_a_cycle_and_start_the_next_in_the_same_save(client, db):
    """The real case the record sheet now sends: the tables a cycle still needed, plus the tables
    re-cleaned the same afternoon, saved together for ONE date.

    Both entries share a date, so they are sequenced by created_at. The database default is the
    TRANSACTION timestamp, which is identical for every row of one request: without an explicit,
    increasing stamp per entry the two tie, the re-clean can be counted against the cycle that is
    still running, and the save is refused as a repeat. Order must be the order they were sent in.
    """
    plant, _head, _assignee = _team(client, db)                 # 4 tables per cycle
    d1, d2 = _days(2, back=30)
    assert _sheet(client, plant, [_picked(d1, [1, 2])]).status_code == 200

    rolled = _sheet(client, plant, [_picked(d2, [3, 4]), _picked(d2, [1, 2])])

    assert rolled.status_code == 200, rolled.text
    rows = rolled.json()["reports"]
    assert [row["cycle_no"] for row in rows] == [1, 2]
    assert [row["cycle_completed"] for row in rows] == [True, False]
    assert [row["report_date"] for row in rows] == [d2.isoformat(), d2.isoformat()]
    cycles, completed = _cycles(db, plant)
    assert cycles == [1, 1, 2] and completed == [False, True, False]

    month = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": d1.strftime("%Y-%m")}).json()
    by_no = {cycle["cycle_no"]: cycle for cycle in month["cycles"]}
    assert by_no[1]["state"] == "Completed" and by_no[1]["completed_on"] == d2.isoformat()
    # the re-cleaned tables are the next cycle's work on that same date, so the billing can see them
    assert by_no[2]["state"] == "In progress"
    assert (by_no[2]["confirmed"], by_no[2]["started_on"]) == (2, d2.isoformat())
    assert len([r for r in month["reports"] if r["report_date"] == d2.isoformat()]) == 2


def test_the_same_date_roll_over_survives_a_recount(client, db):
    """A recount re-reads the month from the database and must keep the two entries of one date in
    the order they were saved, or the cycle numbers would flip on the next deploy's recount."""
    plant, _head, _assignee = _team(client, db)
    d1, d2 = _days(2, back=30)
    assert _sheet(client, plant, [_picked(d1, [1, 2])]).status_code == 200
    assert _sheet(client, plant, [_picked(d2, [3, 4]), _picked(d2, [1, 2])]).status_code == 200

    recount = client.post(f"{BASE}/plants/{plant.id}/recount", params={"month": d1.strftime("%Y-%m")})

    assert recount.status_code == 200, recount.text
    assert recount.json()["moved"] == []
    assert _cycles(db, plant) == ([1, 1, 2], [False, True, False])


def test_the_last_cycle_records_the_same_date_roll_over_as_extra_washing(client, db):
    """Cycle 3 has no next cycle, so the tables re-cleaned on the day it fills are the month's extra
    cleaning. The sheet marks them `is_extra` (migration 048), which is what puts them in the
    month's extra total: the cycle ledger counts distinct tables, so a repeat alone adds nothing.
    """
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3 = _days(3, back=30)
    assert _sheet(client, plant, [_picked(d1, [1, 2, 3, 4]), _picked(d2, [1, 2, 3, 4])]).status_code == 200

    extra = dict(_picked(d3, [1, 2]), is_extra=True)
    last = _sheet(client, plant, [_picked(d3, [1, 2, 3, 4]), extra])

    assert last.status_code == 200, last.text
    rows = last.json()["reports"]
    assert [row["cycle_no"] for row in rows] == [3, 3]
    assert [row["cycle_completed"] for row in rows] == [True, False]
    assert [row["is_extra"] for row in rows] == [False, True]
    month = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": d1.strftime("%Y-%m")}).json()
    assert month["summary"]["cycles_completed"] == 3
    assert month["summary"]["extra_tables"] == 2
    # the extra entry never stands in for cycle work: cycle 3 is still exactly its table count
    assert month["cycles"][2]["confirmed"] == 4


def test_a_repeat_that_does_not_finish_the_cycle_is_still_refused(client, db):
    """The roll-over is only legal on the day the cycle actually closes. A repeat sent with less than
    the cycle's remaining tables stays a repeat, so a mistyped table cannot open the next cycle."""
    plant, _head, _assignee = _team(client, db)
    d1, d2 = _days(2, back=30)
    assert _sheet(client, plant, [_picked(d1, [1, 2])]).status_code == 200

    short = _sheet(client, plant, [_picked(d2, [3]), _picked(d2, [1])])

    assert short.status_code == 409 and "already recorded in cycle 1" in short.json()["detail"]
    assert _cycles(db, plant)[0] == [1], "a refused sheet saves nothing at all"
