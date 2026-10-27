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
    # d2 reaches the count and completes cycle 1; its 1 table above the count carries over to cycle 2, so d3 (1 + 3)
    # completes cycle 2 and d4 starts cycle 3 — all without another save
    assert _cycles(db, plant) == [(3, 1, False, "Confirmed"), (2, 1, True, "Confirmed"),
                                  (3, 2, True, "Confirmed"), (1, 3, False, "Confirmed")]


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


def test_tables_above_the_count_carry_over_to_the_next_cycle(client, db):
    plant = _plant(db)                                   # 4 tables per cycle, like 206 at a real plant
    head, _assignee = _setup_cycle_users(client, db, plant)
    conftest._CURRENT_USER = head
    d1, d2, d3, d4 = _days(4)
    # cycle 1: 4. cycle 2: 2 + 3 = 5 -> complete on d3 with 1 carried over. cycle 3: 1 carried + 2 = 3
    assert _sheet(client, plant, [_done(d1, 4), _done(d2, 2), _done(d3, 3), _done(d4, 2)]).status_code == 200
    assert [c[1:3] for c in _cycles(db, plant)] == [(1, True), (2, False), (2, True), (3, False)]
    month = d1.strftime("%Y-%m")
    cycles = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": month}).json()["cycles"]
    assert [(c["confirmed"], c["carried_in"], c["carried_out"]) for c in cycles] == [(4, 0, 0), (4, 0, 1), (3, 1, 0)]
    # an edit later in the cycle moves the carry with it: d3 rechecked as 1 table -> cycle 2 = 3, nothing carried
    assert client.patch(f"{BASE}/daily-reports/{_report(db, plant, d3).id}", json={"tables_cleaned": 1}).status_code == 200
    assert [c[1:3] for c in _cycles(db, plant)] == [(1, True), (2, False), (2, False), (2, True)]
    cycles = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": month}).json()["cycles"]
    assert [(c["confirmed"], c["carried_out"]) for c in cycles] == [(4, 0), (4, 1), (1, 0)]


def test_overview_counts_the_carried_tables_in_the_open_cycle(client, db):
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)
    conftest._CURRENT_USER = head
    from app.core.timeutil import business_today
    today = business_today()
    if today.day < 3:
        return                                           # needs three days of this month
    days = [today.replace(day=today.day - 2), today.replace(day=today.day - 1), today]
    assert _sheet(client, plant, [_done(days[0], 4), _done(days[1], 6), _done(days[2], 1)]).status_code == 200
    row = next(p for p in client.get(f"{BASE}/overview").json()["plants"] if p["plant_id"] == str(plant.id))
    assert [(c["confirmed"], c["carried_in"]) for c in row["cycles"]] == [(4, 0), (4, 0), (3, 2)]


def test_saved_months_are_recounted_once_automatically(client, db):
    from app.core.models import AppSetting, AuditLog
    from app.scheduled.washing_cycles import CYCLE_RULE_SETTING, CYCLE_RULE_VERSION, recount_all_months
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)
    conftest._CURRENT_USER = head
    d1, d2, d3 = _days(3)
    assert _sheet(client, plant, [_done(d1, 4), _done(d2, 6), _done(d3, 1)]).status_code == 200
    for report in db.query(WashingDailyReport).filter_by(plant_id=plant.id):      # as the old rule saved them:
        report.cycle_no = 1 if report.report_date == d1 else 2                    # d2 kept whole in cycle 2, d3 too
        report.cycle_completed = report.report_date in (d1, d2)
    db.commit()
    result = recount_all_months(db)
    assert result["moved_days"] == 1 and result["plants"] >= 1
    # cycle 2 = 6 -> complete on d2 with 2 carried over; d3 counts in cycle 3 (2 carried + 1)
    assert [c[1:3] for c in _cycles(db, plant)] == [(1, True), (2, True), (3, False)]
    assert db.get(AppSetting, CYCLE_RULE_SETTING).setting_value == CYCLE_RULE_VERSION
    assert db.query(AuditLog).filter_by(action="Recounted washing cycles", actor_name="Solar91 (automatic)").count() == 1
    assert recount_all_months(db) == {"skipped": True}                           # once per rule version


def test_overview_for_an_earlier_month_shows_it_as_it_stood_at_month_end(client, db):
    from datetime import timedelta
    from app.core.timeutil import business_today
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)
    conftest._CURRENT_USER = head
    today = business_today()
    last_month_end = today.replace(day=1) - timedelta(days=1)
    earlier = last_month_end - timedelta(days=2)
    db.add_all([WashingDailyReport(plant_id=plant.id, cycle_month=earlier.strftime("%Y-%m"), cycle_no=1, report_date=earlier,
                                   job_status="Done", tables_cleaned=4, cleaned_table_codes=[], reported_by="T", review_status="Confirmed",
                                   cycle_completed=True),
                WashingDailyReport(plant_id=plant.id, cycle_month=today.strftime("%Y-%m"), cycle_no=1, report_date=today,
                                   job_status="Done", tables_cleaned=2, cleaned_table_codes=[], reported_by="T", review_status="Confirmed")])
    db.commit()
    past = client.get(f"{BASE}/overview", params={"month": last_month_end.strftime("%Y-%m")})
    assert past.status_code == 200, past.text
    body = past.json()
    assert body["past_month"] is True and body["today"] == last_month_end.isoformat() and body["actual_today"] == today.isoformat()
    row = next(p for p in body["plants"] if p["plant_id"] == str(plant.id))
    assert row["cycles_this_month"] == 1 and row["last_report_date"] == earlier.isoformat()      # this month's report left out
    now = client.get(f"{BASE}/overview").json()
    assert now["past_month"] is False and now["month"] == today.strftime("%Y-%m")
    future = (today.replace(day=28) + timedelta(days=5)).strftime("%Y-%m")
    assert client.get(f"{BASE}/overview", params={"month": future}).status_code == 422
