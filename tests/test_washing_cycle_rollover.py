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
