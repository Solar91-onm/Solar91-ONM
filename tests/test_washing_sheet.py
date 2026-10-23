from __future__ import annotations

from datetime import timedelta
from pathlib import Path

from app.core.models import Notification, UserEquipmentTypeAssignment, UserPlantAssignment, WashingDailyReport
from app.core.timeutil import business_today
from tests import conftest
from tests.conftest import login_user
from tests.test_washing_cycles import BASE, _plant, _setup_cycle_users, _stub_washing_storage, _upload_washing_photos

ROOT = Path(__file__).resolve().parents[1]


def _engineer(client, db, plant, email="sheet-engineer@example.com"):
    user = login_user(client, db, role="Site Engineer", name="Sheet Engineer", email=email)
    db.add(UserPlantAssignment(user_id=user.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()
    return user


def _days(n, back=20):
    """n consecutive days in one calendar month, all at least `back` days ago (inside the 45-day limit)."""
    start = business_today() - timedelta(days=back)
    if start.day > n:
        return [start - timedelta(days=n - 1 - i) for i in range(n)]
    return [start + timedelta(days=i) for i in range(n)]


def _sheet(client, plant, entries):
    return client.post(f"{BASE}/daily-reports/sheet", json={"plant_id": str(plant.id), "entries": entries})


def _done(day, tables):
    return {"report_date": day.isoformat(), "job_status": "Done", "tables_cleaned": tables}


def test_engineer_sheet_saves_every_day_pending_with_one_notification(client, db):
    plant = _plant(db)
    head, assignee = _setup_cycle_users(client, db, plant)
    engineer = _engineer(client, db, plant)
    d1, d2, d3 = _days(3)
    before = db.query(Notification).filter_by(event_type="washing_daily_report").count()

    response = _sheet(client, plant, [
        _done(d2, 1),
        {"report_date": d3.isoformat(), "job_status": "Not done", "exception_reason": "Rain", "remarks": "Heavy rain"},
        _done(d1, 2),
    ])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["saved"] == 3
    assert [r["report_date"] for r in body["reports"]] == [d1.isoformat(), d2.isoformat(), d3.isoformat()]
    assert {r["review_status"] for r in body["reports"]} == {"Pending"}
    assert all(r["reported_by_id"] == str(engineer.id) for r in body["reports"])
    # back-filled days (entered 3+ days later) do not need photos to be confirmed, and are flagged as such
    assert all(r["backfilled"] and not r["photos_required"] for r in body["reports"])

    rows = db.query(Notification).filter_by(event_type="washing_daily_report").all()[before:]
    recipients = [n.user_id for n in rows]
    assert len(recipients) == len(set(recipients)), "one sheet must raise one notification per person, not one per day"
    assert head.id in recipients and assignee.id in recipients
    assert all("filled 3 days" in (n.message or "") for n in rows)


def test_sheet_is_all_or_nothing_and_rejects_days_already_reported(client, db):
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    _engineer(client, db, plant)
    d1, d2 = _days(2)
    assert _sheet(client, plant, [_done(d1, 1)]).status_code == 200

    taken = _sheet(client, plant, [_done(d2, 1), _done(d1, 1)])
    assert taken.status_code == 409 and "Edit those days" in taken.json()["detail"]
    duplicate = _sheet(client, plant, [_done(d2, 1), _done(d2, 2)])
    assert duplicate.status_code == 422
    too_old = _sheet(client, plant, [_done(d2, 1), _done(business_today() - timedelta(days=46), 1)])
    assert too_old.status_code == 422
    future = _sheet(client, plant, [_done(business_today() + timedelta(days=1), 1)])
    assert future.status_code == 422
    assert db.query(WashingDailyReport).filter_by(plant_id=plant.id).count() == 1


def test_sheet_requires_report_permission_and_plant_scope(client, db):
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    login_user(client, db, role="Viewer", name="Sheet Viewer", email="sheet-viewer@example.com")
    assert _sheet(client, plant, [_done(_days(1)[0], 1)]).status_code == 403
    login_user(client, db, role="Site Engineer", name="Unscoped Engineer", email="sheet-unscoped@example.com")
    assert _sheet(client, plant, [_done(_days(1)[0], 1)]).status_code == 403
    assert db.query(WashingDailyReport).filter_by(plant_id=plant.id).count() == 0


def test_om_sheet_is_saved_confirmed_and_rolls_into_the_next_cycle(client, db):
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)  # 4 tables per cycle
    conftest._CURRENT_USER = head
    d1, d2, d3 = _days(3, back=90)  # the O&M team may back-fill beyond 45 days
    response = _sheet(client, plant, [_done(d1, 2), _done(d2, 2), _done(d3, 1)])
    assert response.status_code == 200, response.text
    reports = response.json()["reports"]
    assert {r["review_status"] for r in reports} == {"Confirmed"}
    assert [r["cycle_no"] for r in reports] == [1, 1, 2]
    assert reports[1]["cycle_completed"] is True

    month = client.get(f"{BASE}/plants/{plant.id}/cycles", params={"month": d1.strftime("%Y-%m")}).json()
    assert [c["state"] for c in month["cycles"][:2]] == ["Completed", "In progress"]
    assert sorted(r["report_date"] for r in month["reports"]) == [d.isoformat() for d in (d1, d2, d3)]


def test_bulk_confirm_checks_reviewer_photos_and_completes_the_cycle(client, db, monkeypatch):
    _stub_washing_storage(monkeypatch)
    plant = _plant(db)
    head, assignee = _setup_cycle_users(client, db, plant)
    engineer = _engineer(client, db, plant)
    d1, d2 = _days(2)
    old = _sheet(client, plant, [_done(d1, 2), _done(d2, 2)]).json()["reports"]
    today = _sheet(client, plant, [_done(business_today(), 1)]).json()["reports"][0]
    assert today["photos_required"] is True and today["backfilled"] is False
    ids = [r["id"] for r in old]

    def confirm(report_ids):
        return client.post(f"{BASE}/daily-reports/confirm", json={"plant_id": str(plant.id), "report_ids": report_ids})

    assert confirm(ids).status_code == 403  # the engineer cannot confirm their own days
    other = login_user(client, db, role="Assignee", name="Other Sheet Assignee", email="sheet-other-assignee@example.com")
    db.add(UserEquipmentTypeAssignment(user_id=other.id, equipment_type="Modules cleaning"))
    db.commit()
    assert confirm(ids).status_code == 403  # washing scope, but not this plant's Assignee

    conftest._CURRENT_USER = assignee
    blocked = confirm(ids + [today["id"]])
    assert blocked.status_code == 409 and "photos" in blocked.json()["detail"]
    assert db.query(WashingDailyReport).filter_by(plant_id=plant.id, review_status="Confirmed").count() == 0

    before = db.query(Notification).filter_by(event_type="washing_cycle_completed").count()
    done = confirm(ids)
    assert done.status_code == 200, done.text
    assert done.json()["confirmed"] == 2
    assert done.json()["cycles_completed"] == [{"cycle_month": d1.strftime("%Y-%m"), "cycle_no": 1}]
    assert db.query(Notification).filter_by(event_type="washing_cycle_completed").count() > before
    engineer_notes = db.query(Notification).filter_by(user_id=engineer.id, event_type="washing_report_reviewed").all()
    assert len(engineer_notes) == 1 and "2 days" in engineer_notes[0].title
    assert confirm(ids).status_code == 409  # already reviewed

    # today's day still needs its photos, then a single confirm works as before
    conftest._CURRENT_USER = engineer
    _upload_washing_photos(client, today["id"])
    conftest._CURRENT_USER = head
    assert confirm([today["id"]]).status_code == 200


def test_single_review_also_skips_photos_for_backfilled_days(client, db):
    plant = _plant(db)
    _head, assignee = _setup_cycle_users(client, db, plant)
    _engineer(client, db, plant)
    recent = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1,
                                                       "report_date": (business_today() - timedelta(days=2)).isoformat()}).json()
    backfilled = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1,
                                                           "report_date": (business_today() - timedelta(days=3)).isoformat()}).json()
    conftest._CURRENT_USER = assignee
    assert client.post(f"{BASE}/daily-reports/{recent['id']}/review", json={"decision": "Confirm"}).status_code == 409
    assert client.post(f"{BASE}/daily-reports/{backfilled['id']}/review", json={"decision": "Confirm"}).status_code == 200


def test_record_tab_uses_the_cycle_sheet():
    washing = (ROOT / "frontend/static/js/26-washing-cycles.js").read_text(encoding="utf-8")
    assert "/api/scheduled/washing/daily-reports/sheet" in washing
    assert "/api/scheduled/washing/daily-reports/confirm" in washing
    assert "tab===\"record\"?sheetHtml(p)" in washing


def test_sheet_saves_a_zero_day_as_not_done_with_remarks(client, db):
    """The sheet has no reason column: typing 0 tables saves a not-done day (reason "Other") with the remarks."""
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    _engineer(client, db, plant)
    (d1,) = _days(1)
    response = _sheet(client, plant, [
        {"report_date": d1.isoformat(), "job_status": "Not done", "tables_cleaned": 0, "exception_reason": "Other", "remarks": "Pump down"},
    ])
    assert response.status_code == 200, response.text
    saved = db.query(WashingDailyReport).filter_by(plant_id=plant.id, report_date=d1).one()
    assert saved.job_status == "Not done" and saved.tables_cleaned == 0
    assert saved.exception_reason == "Other" and saved.remarks == "Pump down"


def test_record_sheet_has_no_reason_column_and_accepts_zero():
    washing = (ROOT / "frontend/static/js/26-washing-cycles.js").read_text(encoding="utf-8")
    assert "<th>Not done reason</th>" not in washing
    assert "<th>Tables cleaned</th><th>Remarks</th>" in washing
    assert 'type="number" min="0"' in washing
    assert 'job_status:"Not done",tables_cleaned:0,exception_reason:"Other"' in washing
    assert "tables cleaned must be a whole number" not in washing


def test_command_center_hub_shows_the_operations_donut_cards():
    hub = (ROOT / "frontend/static/js/20-modern-ui-2026.js").read_text(encoding="utf-8")
    dash = (ROOT / "frontend/static/js/08-actions-exports-and-submission.js").read_text(encoding="utf-8")
    assert "function ccOpsOverviewPanel(" in dash
    assert "h+=ccOpsOverviewPanel(plants,open,f)" in dash
    assert "ccOpsOverviewPanel(plants,open,blankIssF())" in hub
    # the third card is panel washing (plant health was dropped); every slice opens a filtered register
    assert '"Panel washing"' in dash and '"Plant health"' not in dash
    assert 'act:canOpenWash?"ccWashQueue":""' in dash
    assert 'if(act==="ccWashQueue"){e.preventDefault();openDashboardWashQueue(id);return}' in dash
    data = (ROOT / "frontend/static/js/00-auth-data-and-imports.js").read_text(encoding="utf-8")
    assert "function openDashboardWashQueue(show)" in data
    washing = (ROOT / "frontend/static/js/26-washing-cycles.js").read_text(encoding="utf-8")
    assert 'f.show==="ontrack"' in washing and 'f.show==="slipping"' in washing
    # the old work lanes and the separate "Plant washing" panel are no longer on the Command Center
    assert "cx-lanes" not in hub and "function ccPanel()" not in washing


def test_washing_forms_and_views_ask_only_for_remarks_not_a_reason():
    washing = (ROOT / "frontend/static/js/26-washing-cycles.js").read_text(encoding="utf-8")
    assert "Reason not done" not in washing and "Reason work was not done" not in washing
    assert "Choose the reason the work was not done" not in washing
    assert '"Not done — "+h(r.exception_reason)' not in washing
    assert 'exception_reason:nd?"Other":null' in washing
    assert 'body.exception_reason=v("reason")||"Other"' in washing
