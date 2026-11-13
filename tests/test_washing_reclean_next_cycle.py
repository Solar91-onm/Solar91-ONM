"""Module Cleaning: tables cleaned again before a cycle is complete.

When the O&M Head or a washing Assignee enters a day that lists a table already recorded in the open cycle, the whole
day starts the next cycle (even when only some of its tables repeat). The open cycle stays incomplete and every later
day counts in the new cycle. A Site Engineer's repeated table is still refused. Cycle 3 is the month's last cycle, so
a repeat there is refused for everyone.
"""
from __future__ import annotations

import uuid

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


def test_rule_on_its_own():
    om, se = True, False
    # (tables, counts, table numbers, entered by O&M); the plant has 4 tables
    assert _cycle_sequence([(2, True, {1, 2}, om), (2, True, {1, 2}, om)], 4) == [(1, False), (2, False)]
    assert _cycle_sequence([(2, True, {1, 2}, om), (2, True, {2, 3}, om)], 4) == [(1, False), (2, False)]  # partly
    assert _cycle_sequence([(2, True, {1, 2}, om), (2, True, {1, 2}, se)], 4) == [(1, False), (1, False)]  # engineer
    assert _cycle_sequence([(2, True, {1, 2}, om), (2, False, {1, 2}, om)], 4) == [(1, False), (1, False)]  # rejected
    assert _cycle_sequence([(2, True, {1, 2}, om), (2, True, {3, 4}, om)], 4) == [(1, False), (1, False)]  # no repeat
    # after the repeat, later days count in the new cycle, even tables the old cycle never had
    assert _cycle_sequence([(1, True, {1}, om), (1, True, {1}, om), (1, True, {4}, se)], 4) == [(1, False), (2, False), (2, False)]
    # cycle 3 has no next cycle; days still count there
    assert [c for c, _x in _cycle_sequence([(1, True, {1}, om)] * 4, 4)] == [1, 2, 3, 3]
    # the count rule is unchanged, including the old two-value form
    assert _cycle_sequence([(4, True), (2, True)], 4) == [(1, False), (2, False)]


def test_head_cleaning_the_same_tables_again_counts_in_the_next_cycle(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3 = _days(3, back=60)

    saved = _sheet(client, plant, [_picked(d1, [1, 2, 3])])
    assert saved.status_code == 200, saved.text
    again = _sheet(client, plant, [_picked(d2, [1, 2, 3])])

    assert again.status_code == 200, again.text
    assert again.json()["reports"][0]["cycle_no"] == 2
    cycles, completed = _cycles(db, plant)
    assert cycles == [1, 2] and completed == [False, False]  # cycle 1 stays incomplete

    # a later day goes to cycle 2 too, even with the table cycle 1 never had
    later = _sheet(client, plant, [_picked(d3, [4])])
    assert later.status_code == 200, later.text
    cycles, completed = _cycles(db, plant)
    assert cycles == [1, 2, 2] and completed == [False, False, True]  # cycle 2: 1, 2, 3 + 4 = all 4 tables

    # the month view: cycle 1 was left incomplete (Missed), cycle 2 is the one the work went to
    month = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": d1.strftime("%Y-%m")})
    assert month.status_code == 200, month.text
    by_no = {c["cycle_no"]: c for c in month.json()["cycles"]}
    assert by_no[1]["state"] == "Missed" and by_no[1]["confirmed"] == 3 and by_no[1]["completed_on"] is None
    assert by_no[2]["state"] == "Completed" and by_no[2]["confirmed"] == 4


def test_month_view_opens_on_the_cycle_the_re_clean_started(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2 = _days(2, back=60)
    assert _sheet(client, plant, [_picked(d1, [1, 2]), _picked(d2, [1])]).status_code == 200

    month = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": d1.strftime("%Y-%m")})

    assert month.status_code == 200, month.text
    states = {c["cycle_no"]: c["state"] for c in month.json()["cycles"]}
    assert states[1] == "Missed" and states[2] == "In progress"


def test_a_partly_repeated_day_moves_whole_to_the_next_cycle(client, db):
    plant, _head, _assignee = _team(client, db, who="assignee")
    d1, d2 = _days(2, back=30)

    response = _sheet(client, plant, [_picked(d1, [1, 2]), _picked(d2, [2, 3])])  # table 2 repeats, 3 is new

    assert response.status_code == 200, response.text
    assert [r["cycle_no"] for r in response.json()["reports"]] == [1, 2]
    assert _cycles(db, plant)[0] == [1, 2]


def test_engineer_cleaning_the_same_table_again_is_still_refused(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2 = _days(2)
    _engineer(client, db, plant)
    assert _sheet(client, plant, [_picked(d1, [1, 2])]).status_code == 200

    clash = _sheet(client, plant, [_picked(d2, [2, 3])])

    assert clash.status_code == 409 and "Table 2 is already recorded in cycle 1" in clash.json()["detail"]
    assert _cycles(db, plant)[0] == [1]


def test_engineer_day_after_an_om_re_clean_belongs_to_the_new_cycle(client, db):
    plant, head, _assignee = _team(client, db)
    d1, d2, d3 = _days(3)
    assert _sheet(client, plant, [_picked(d1, [1, 2]), _picked(d2, [1])]).status_code == 200  # d2 starts cycle 2
    _engineer(client, db, plant)

    clash = _sheet(client, plant, [_picked(d3, [1])])          # table 1 is already in cycle 2
    assert clash.status_code == 409 and "already recorded in cycle 2" in clash.json()["detail"]
    fresh = _sheet(client, plant, [_picked(d3, [3])])
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["reports"][0]["cycle_no"] == 2 and fresh.json()["reports"][0]["review_status"] == "Pending"
    conftest._CURRENT_USER = head


def test_om_repeat_in_cycle_three_is_refused(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2, d3, d4 = _days(4, back=60)
    assert _sheet(client, plant, [_picked(d1, [1]), _picked(d2, [1]), _picked(d3, [1])]).status_code == 200
    assert _cycles(db, plant)[0] == [1, 2, 3]

    refused = _sheet(client, plant, [_picked(d4, [1])])

    assert refused.status_code == 409
    assert "Table 1 is already recorded in cycle 3" in refused.json()["detail"]
    assert "last cycle" in refused.json()["detail"]
    assert _cycles(db, plant)[0] == [1, 2, 3]


def test_editing_away_the_repeat_brings_the_day_back_to_the_open_cycle(client, db):
    plant, _head, _assignee = _team(client, db)
    d1, d2 = _days(2, back=60)
    saved = _sheet(client, plant, [_picked(d1, [1, 2]), _picked(d2, [2])])
    assert [r["cycle_no"] for r in saved.json()["reports"]] == [1, 2]
    second = saved.json()["reports"][1]["id"]

    edited = client.patch(f"{BASE}/daily-reports/{second}", json={"table_numbers": [3]})

    assert edited.status_code == 200, edited.text
    assert edited.json()["cycle_no"] == 1
    assert _cycles(db, plant)[0] == [1, 1]
    db.expire_all()
    assert db.get(WashingDailyReport, uuid.UUID(second)).cleaned_table_codes == ["Table 003"]
