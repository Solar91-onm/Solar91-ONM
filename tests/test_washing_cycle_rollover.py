"""The next washing cycle starts by itself the moment the recorded tables reach the plant's table count."""
from __future__ import annotations

from app.core.models import WashingDailyReport
from tests import conftest
from tests.test_washing_cycles import BASE, _plant, _setup_cycle_users
from tests.test_washing_sheet import _days, _done, _engineer, _sheet


def _cycles(db, plant):
    db.expire_all()
    rows = db.query(WashingDailyReport).filter_by(plant_id=plant.id).order_by(WashingDailyReport.report_date).all()
    return [(r.tables_cleaned, r.cycle_no, r.cycle_completed, r.review_status) for r in rows]


def test_om_sheet_rolls_into_the_next_cycle_in_one_save(client, db):
    plant = _plant(db)                                   # 4 tables per cycle
    head, _assignee = _setup_cycle_users(client, db, plant)
    conftest._CURRENT_USER = head
    d1, d2, d3, d4 = _days(4)
    r = _sheet(client, plant, [_done(d1, 3), _done(d2, 2), _done(d3, 3), _done(d4, 1)])
    assert r.status_code == 200, r.text
    # d2 reaches the count (stays whole in cycle 1 and completes it); later days go to cycle 2 without another save
    assert _cycles(db, plant) == [(3, 1, False, "Confirmed"), (2, 1, True, "Confirmed"),
                                  (3, 2, False, "Confirmed"), (1, 2, True, "Confirmed")]


def test_site_engineer_keeps_going_while_the_full_cycle_awaits_confirmation(client, db):
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)
    _engineer(client, db, plant)
    d1, d2, d3, d4 = _days(4)
    assert _sheet(client, plant, [_done(d1, 3), _done(d2, 1), _done(d3, 2)]).status_code == 200
    # cycle 1 is full with work awaiting confirmation, so d3 already counts towards cycle 2
    assert [(c[1], c[3]) for c in _cycles(db, plant)] == [(1, "Pending"), (1, "Pending"), (2, "Pending")]
    single = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done",
                                                       "tables_cleaned": 1, "report_date": d4.isoformat()})
    assert single.status_code == 200, single.text
    assert single.json()["cycle_no"] == 2

    conftest._CURRENT_USER = head
    first_two = [str(r.id) for r in db.query(WashingDailyReport).filter_by(plant_id=plant.id, cycle_no=1)]
    confirmed = client.post(f"{BASE}/daily-reports/confirm", json={"plant_id": str(plant.id), "report_ids": first_two})
    assert confirmed.status_code == 200, confirmed.text
    states = _cycles(db, plant)
    assert states[1][:3] == (1, 1, True)                 # confirming completes cycle 1 on the day that reached 4
    assert [s[1] for s in states] == [1, 1, 2, 2]


def _not_done(day):
    return {"report_date": day.isoformat(), "job_status": "Not done", "tables_cleaned": 0, "exception_reason": "Rain"}


def _report(db, plant, day):
    db.expire_all()
    return db.query(WashingDailyReport).filter_by(plant_id=plant.id, report_date=day).one()


def test_editing_a_day_after_a_full_cycle_moves_it_to_the_next_cycle(client, db):
    plant = _plant(db)                                   # 4 tables per cycle
    head, _assignee = _setup_cycle_users(client, db, plant)
    conftest._CURRENT_USER = head
    d1, d2, d3, d4, d5 = _days(5)
    assert _sheet(client, plant, [_done(d1, 4), _done(d2, 2), _not_done(d3), _not_done(d4), _done(d5, 1)]).status_code == 200
    assert [c[1] for c in _cycles(db, plant)] == [1, 2, 2, 2, 2]
    # d2 was rechecked: 4 tables, so cycle 2 is full on d2 and the days after it belong to cycle 3
    assert client.patch(f"{BASE}/daily-reports/{_report(db, plant, d2).id}", json={"tables_cleaned": 4}).status_code == 200
    # d4 was rechecked too: 0 -> 3 tables. It counts in cycle 3 (not the already full cycle 2), and cycle 3 starts there
    r = client.patch(f"{BASE}/daily-reports/{_report(db, plant, d4).id}", json={"job_status": "Done", "tables_cleaned": 3})
    assert r.status_code == 200, r.text
    assert r.json()["cycle_no"] == 3
    assert _cycles(db, plant) == [(4, 1, True, "Confirmed"), (4, 2, True, "Confirmed"), (0, 3, False, "Confirmed"),
                                  (3, 3, False, "Confirmed"), (1, 3, True, "Confirmed")]
    sheet = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": d1.strftime("%Y-%m")}).json()
    c2, c3 = sheet["cycles"][1], sheet["cycles"][2]
    assert (c2["confirmed"], c2["completed_on"]) == (4, d2.isoformat())
    assert (c3["confirmed"], c3["started_on"], c3["completed_on"]) == (4, d4.isoformat(), d5.isoformat())


def test_deleting_or_lowering_a_day_moves_later_days_back(client, db):
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)
    conftest._CURRENT_USER = head
    d1, d2, d3 = _days(3)
    assert _sheet(client, plant, [_done(d1, 4), _done(d2, 2), _done(d3, 1)]).status_code == 200
    assert [c[1] for c in _cycles(db, plant)] == [1, 2, 2]
    assert client.patch(f"{BASE}/daily-reports/{_report(db, plant, d1).id}", json={"tables_cleaned": 1}).status_code == 200
    assert [c[1:3] for c in _cycles(db, plant)] == [(1, False), (1, False), (1, True)]     # 1 + 2 + 1 = 4: all cycle 1
    assert client.delete(f"{BASE}/daily-reports/{_report(db, plant, d2).id}").status_code == 200
    assert [c[1:3] for c in _cycles(db, plant)] == [(1, False), (1, False)]                # 1 + 1: cycle 1 open again


def test_recount_fixes_a_month_saved_with_the_old_numbering(client, db):
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)
    conftest._CURRENT_USER = head
    d1, d2, d3 = _days(3)
    assert _sheet(client, plant, [_done(d1, 4), _done(d2, 4), _done(d3, 3)]).status_code == 200
    stale = _report(db, plant, d3)
    stale.cycle_no = 2                                   # how the old code left an edited day: in the full cycle 2
    db.commit()
    month = d1.strftime("%Y-%m")
    r = client.post(f"{BASE}/plants/{plant.id}/recount", params={"month": month})
    assert r.status_code == 200, r.text
    assert r.json()["moved"] == [{"report_date": d3.isoformat(), "from": 2, "to": 3}]
    assert [c[1] for c in _cycles(db, plant)] == [1, 2, 3]
    assert [c["confirmed"] for c in r.json()["cycles"]] == [4, 4, 3]
    _engineer(client, db, plant)
    assert client.post(f"{BASE}/plants/{plant.id}/recount", params={"month": month}).status_code == 403
