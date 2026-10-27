from __future__ import annotations

from datetime import date

from app.core.timeutil import business_today
from app.core.models import (
    Notification,
    Plant,
    User,
    UserEquipmentTypeAssignment,
    UserPlantAssignment,
    WashingConfig,
    WashingDailyReport,
    WashingTable,
)
from app.scheduled.washing_cycles import check_cycle_compliance_alerts, check_missed_monthly_targets
from tests.conftest import login_user
from tests import conftest


BASE = "/api/scheduled/washing"

def _act_as(user):
    conftest._CURRENT_USER = user


def _plant(db):
    plant = Plant(site_code="CYCLE01", plant_name="Cycle Test Plant")
    db.add(plant)
    db.commit()
    db.refresh(plant)
    return plant


def _setup_cycle_users(client, db, plant):
    head = login_user(client, db, role="O&M Head", name="Cycle Head", email="cycle-head@example.com")
    assignee = login_user(client, db, role="Assignee", name="Cycle Assignee", email="cycle-assignee@example.com")
    db.add(UserEquipmentTypeAssignment(user_id=assignee.id, equipment_type="Modules cleaning"))
    db.commit()
    login_user(client, db, role="O&M Head", name="Cycle Head", email="cycle-head-setup@example.com")
    setup = client.post(f"{BASE}/setup", json={
        "plant_id": str(plant.id),
        "table_count": 4,
        "assignee_user_id": str(assignee.id),
    })
    assert setup.status_code == 200, setup.text
    return head, assignee


def test_cycle_requires_daily_reports_and_reviewer_confirmation(client, db, monkeypatch):
    _stub_washing_storage(monkeypatch)
    plant = _plant(db)
    _head, assignee = _setup_cycle_users(client, db, plant)
    engineer = login_user(client, db, role="Site Engineer", name="Cycle Engineer", email="cycle-engineer@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()

    submitted = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 2,
        "cleaned_table_codes": ["Table 001", "Table 002"], "remarks": "First half cleaned",
    })
    assert submitted.status_code == 200, submitted.text
    first_report_id = submitted.json()["id"]
    assert submitted.json()["review_status"] == "Pending"
    assert submitted.json()["remarks"] == "First half cleaned"

    other_assignee = login_user(client, db, role="Assignee", name="Unassigned Reviewer", email="cycle-assignee-other@example.com")
    db.add(UserEquipmentTypeAssignment(user_id=other_assignee.id, equipment_type="Modules cleaning"))
    db.commit()
    # A different account with the Assignee role is not the configured Assignee.
    response = client.post(f"{BASE}/daily-reports/{first_report_id}/review", json={"decision": "Confirm"})
    assert response.status_code == 403

    # The configured Assignee confirms the first daily report.
    _act_as(assignee)
    confirmed = client.post(f"{BASE}/daily-reports/{first_report_id}/review", json={"decision": "Confirm"})
    assert confirmed.status_code == 409 and "before and after" in confirmed.json()["detail"]
    _act_as(engineer)
    _upload_washing_photos(client, first_report_id)
    _act_as(assignee)
    confirmed = client.post(f"{BASE}/daily-reports/{first_report_id}/review", json={"decision": "Confirm"})
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["review_status"] == "Confirmed"

    second = login_user(client, db, role="Site Engineer", name="Cycle Engineer 2", email="cycle-engineer-2@example.com")
    db.add(UserPlantAssignment(user_id=second.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()
    last_report = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 2,
        "cleaned_table_codes": ["Table 003", "Table 004"], "remarks": "Remaining tables cleaned",
    })
    assert last_report.status_code == 200, last_report.text
    _act_as(second)
    _upload_washing_photos(client, last_report.json()["id"])

    head = db.query(User).filter_by(email="cycle-head-setup@example.com").one()
    _act_as(head)
    completion = client.post(f"{BASE}/daily-reports/{last_report.json()['id']}/review", json={"decision": "Confirm"})
    assert completion.status_code == 200, completion.text
    assert completion.json()["cycle_completed"] is True

    overview = client.get(f"{BASE}/overview").json()
    plant_row = next(row for row in overview["plants"] if row["plant_id"] == str(plant.id))
    assert plant_row["cycles_this_month"] == 1
    assert plant_row["confirmed_tables_cleaned"] == 0
    assert db.query(WashingDailyReport).filter_by(plant_id=plant.id, review_status="Confirmed").count() == 2


def test_not_done_exception_is_distinct_and_does_not_consume_cycle_tables(client, db):
    plant = _plant(db)
    _head, _assignee = _setup_cycle_users(client, db, plant)
    engineer = login_user(client, db, role="Site Engineer", name="Exception Engineer", email="exception-engineer@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()

    exception = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Not done", "tables_cleaned": 0,
        "cleaned_table_codes": [], "exception_reason": "Rain", "remarks": "Heavy rain",
    })
    assert exception.status_code == 200, exception.text
    assert exception.json()["exception_reason"] == "Rain"

    done = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 4,
        "cleaned_table_codes": ["Table 001", "Table 002", "Table 003", "Table 004"],
    })
    assert done.status_code == 200, done.text
    assert done.json()["cycle_no"] == exception.json()["cycle_no"] == 1


def test_done_report_is_never_rejected_for_count_or_codes(client, db):
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    engineer = login_user(client, db, role="Site Engineer", name="Invalid Table Engineer", email="invalid-table-engineer@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()

    # The plant number is only a compliance target: any reported count is accepted.
    response = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1,
        "cleaned_table_codes": ["Table 999"],
    })
    assert response.status_code == 200, response.text


def test_setup_can_change_tables_per_cycle_after_reports(client, db):
    plant = _plant(db)
    _head, assignee = _setup_cycle_users(client, db, plant)
    db.add(WashingDailyReport(
        plant_id=plant.id, cycle_month=business_today().strftime("%Y-%m"), cycle_no=1,
        report_date=business_today(), job_status="Not done", tables_cleaned=0, reported_by="Field",
    ))
    db.commit()
    head = db.query(User).filter_by(email="cycle-head-setup@example.com").one()
    _act_as(head)
    response = client.post(f"{BASE}/setup", json={
        "plant_id": str(plant.id), "table_count": 2, "assignee_user_id": str(assignee.id),
    })
    assert response.status_code == 200, response.text
    db.expire_all()
    assert db.get(WashingConfig, plant.id).tables_per_cycle == 2
    assert db.query(WashingTable).filter_by(plant_id=plant.id).count() == 0


def test_missed_monthly_target_notification_is_deduplicated(client, db):
    login_user(client, db, role="O&M Head", name="Target Head", email="target-head@example.com")
    plant = _plant(db)
    db.add(WashingConfig(plant_id=plant.id, team=[], frequency_days=14))
    db.add_all(WashingTable(legacy_id=f"CYCLE-T-{number}", plant_id=plant.id, table_code=f"Table {number}")
               for number in range(1, 3))
    db.commit()

    first_day = date(2026, 11, 1)
    assert check_missed_monthly_targets(db, first_day) == 1
    assert check_missed_monthly_targets(db, first_day) == 0
    alert = db.query(Notification).filter_by(event_type="washing_monthly_target_missed").one()
    assert "0 of 3 required cycles" in alert.message


def test_cycle_compliance_alert_uses_threshold_and_is_deduplicated(client, db):
    login_user(client, db, role="O&M Head", name="Compliance Head", email="compliance-head@example.com")
    plant = _plant(db)
    db.add(WashingConfig(plant_id=plant.id, team=[], frequency_days=14, compliance_threshold_percent=85))
    db.add_all(WashingTable(legacy_id=f"COMPLIANCE-T-{number}", plant_id=plant.id, table_code=f"Table {number}")
               for number in range(1, 11))
    db.commit()

    assert check_cycle_compliance_alerts(db, date(2026, 11, 8)) == 0      # cycle 1 (1-10 Nov) has not ended yet
    assert check_cycle_compliance_alerts(db, date(2026, 11, 11)) == 1     # the day after it ends
    assert check_cycle_compliance_alerts(db, date(2026, 11, 12)) == 0     # once per cycle
    notification = db.query(Notification).filter_by(event_type="washing_cycle_compliance_low").one()
    assert "Cycle 1 ended with 0 of 10 tables done (0%)" in notification.message
    assert notification.user_id is not None


def test_setup_lists_every_assignee_and_grants_the_washing_scope(client, db):
    plant = _plant(db)
    assignee = login_user(client, db, role="Assignee", name="Fresh Assignee", email="fresh-assignee@example.com")
    login_user(client, db, role="O&M Head", name="Setup Head", email="setup-head@example.com")
    listed = client.get(f"{BASE}/assignees").json()
    row = next(a for a in listed if a["id"] == str(assignee.id))
    assert row["has_washing_scope"] is False                 # listed even though they have no washing scope yet
    setup = client.post(f"{BASE}/setup", json={"plant_id": str(plant.id), "table_count": 6, "assignee_user_id": str(assignee.id)})
    assert setup.status_code == 200, setup.text
    owned = [t.equipment_type for t in db.query(UserEquipmentTypeAssignment).filter_by(user_id=assignee.id)]
    assert owned == ["Modules cleaning"]
    again = client.get(f"{BASE}/assignees").json()
    assert next(a for a in again if a["id"] == str(assignee.id))["has_washing_scope"] is True


def test_setup_rejects_a_user_who_is_not_an_assignee(client, db):
    plant = _plant(db)
    engineer = login_user(client, db, role="Site Engineer", name="Not Assignee", email="not-assignee-wash@example.com")
    login_user(client, db, role="O&M Head", name="Setup Head 2", email="setup-head2@example.com")
    resp = client.post(f"{BASE}/setup", json={"plant_id": str(plant.id), "table_count": 6, "assignee_user_id": str(engineer.id)})
    assert resp.status_code in (404, 422)


def _engineer(client, db, plant, email="wash-eng@example.com"):
    engineer = login_user(client, db, role="Site Engineer", name="Wash Engineer", email=email)
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()
    return engineer


def test_site_engineer_reports_a_daily_count_with_no_upper_limit(client, db):
    plant = _plant(db)
    _head, assignee = _setup_cycle_users(client, db, plant)        # 4 tables in the plant
    _engineer(client, db, plant)
    first = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 3})
    assert first.status_code == 200, first.text
    assert first.json()["cleaned_table_codes"] == []                    # no individual tables are tracked
    second = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1})
    assert second.status_code == 200, second.text
    too_many = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1})
    assert too_many.status_code == 200                                   # above the target is still accepted
    zero = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 0})
    assert zero.status_code == 422


def test_completing_a_cycle_starts_the_next_one_and_is_listed_in_the_register(client, db):
    plant = _plant(db)
    head, assignee = _setup_cycle_users(client, db, plant)
    _engineer(client, db, plant)
    report = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 4}).json()
    _act_as(head)
    done = client.post(f"{BASE}/daily-reports/{report['id']}/review", json={"decision": "Confirm"})
    assert done.status_code == 200 and done.json()["cycle_completed"] is True
    note = db.query(Notification).filter(Notification.event_type == "washing_cycle_completed").first()
    assert note is not None and "Cycle 2 starts now" in note.message
    overview = client.get(f"{BASE}/overview").json()
    row = next(p for p in overview["plants"] if p["plant_id"] == str(plant.id))
    assert row["current_cycle"] == 2 and row["cycles_this_month"] == 1
    assert [c["state"] for c in row["cycles"]] == ["Completed", "In progress", "Upcoming"]
    event = overview["cycle_events"][0]
    assert event["cycle_no"] == 1 and event["next_cycle"] == 2 and event["site_code"] == "CYCLE01"
    assert overview["portfolio"]["cycles_completed_month"] == 1


def test_overdue_matrix_buckets_and_deadlines():
    from app.scheduled.washing_cycles import _cycle_due_dates, _overdue_info
    assert [d.day for d in _cycle_due_dates(date(2026, 10, 5))] == [10, 20, 31]
    assert _overdue_info(0, date(2026, 10, 9))["overdue_bucket"] == "on_track"
    assert _overdue_info(0, date(2026, 10, 11))["overdue_bucket"] == "1d"
    assert _overdue_info(0, date(2026, 10, 14)) ["overdue_bucket"] == "3d" and _overdue_info(0, date(2026, 10, 14))["overdue_days"] == 4
    assert _overdue_info(1, date(2026, 10, 14))["overdue_bucket"] == "on_track"      # cycle 1 done; cycle 2 due on the 20th
    late = _overdue_info(1, date(2026, 10, 27))
    assert late["overdue_bucket"] == "7d" and late["overdue_cycle"] == 2 and late["overdue_days"] == 7


def test_overdue_alerts_fire_once_per_level(client, db):
    from app.scheduled.washing_cycles import check_washing_overdue
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    assert check_washing_overdue(db, date(2026, 10, 9)) == 0                  # nothing due yet
    assert check_washing_overdue(db, date(2026, 10, 11)) == 1                 # 1 day late
    assert check_washing_overdue(db, date(2026, 10, 11)) == 0                 # not repeated
    assert check_washing_overdue(db, date(2026, 10, 14)) == 1                 # now 3+ days late
    assert check_washing_overdue(db, date(2026, 10, 18)) == 1                 # 7+ days late
    titles = [n.title for n in db.query(Notification).filter(Notification.event_type == "washing_overdue")]
    assert any("overdue 8 days" in t for t in titles)


def test_overview_lists_unconfigured_plants_and_daily_status(client, db):
    configured = _plant(db)
    spare = Plant(site_code="SPARE01", plant_name="Spare Plant")
    db.add(spare); db.commit()
    head, _assignee = _setup_cycle_users(client, db, configured)
    _act_as(head)
    overview = client.get(f"{BASE}/overview").json()
    assert [p["site_code"] for p in overview["unconfigured"]] == ["SPARE01"]
    assert set(overview["overdue_matrix"]) == {"on_track", "1d", "3d", "7d"}
    row = overview["plants"][0]
    assert len(row["daily_status"]) == business_today().day and row["daily_status"][-1]["status"] in {"Not reported yet", "Awaiting review", "Confirmed", "Exception"}


def test_photo_kind_is_stored_for_before_and_after(client, db, monkeypatch):
    storage = _stub_washing_storage(monkeypatch)
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    _engineer(client, db, plant)
    report = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 2}).json()
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 64
    before = client.post(f"{BASE}/daily-reports/{report['id']}/evidence", files=[("files", ("b.png", png, "image/png"))], data={"kind": "before"})
    after = client.post(f"{BASE}/daily-reports/{report['id']}/evidence", files=[("files", ("a.png", png, "image/png"))], data={"kind": "after"})
    assert before.status_code == 200 and before.json()[0]["kind"] == "before"
    assert after.status_code == 200 and after.json()[0]["kind"] == "after"
    saved_photo = client.get(f"{BASE}/daily-reports/{report['id']}/evidence/{before.json()[0]['id']}")
    assert saved_photo.status_code == 200 and saved_photo.content.startswith(b"\x89PNG")
    assert len(storage.objects) == 2
    bad = client.post(f"{BASE}/daily-reports/{report['id']}/evidence", files=[("files", ("x.png", png, "image/png"))], data={"kind": "selfie"})
    assert bad.status_code == 422
    overview = client.get(f"{BASE}/overview").json()
    rep = next(r for r in overview["reports"] if r["id"] == report["id"])
    assert rep["has_before"] and rep["has_after"]


def _stub_washing_storage(monkeypatch):
    import app.scheduled.router as scheduled_router

    class FakeStorage:
        objects = {}

        def upload(self, path, data, content_type):
            self.objects[path] = (data, content_type)

        def download(self, path):
            return self.objects[path]

        def remove(self, paths):
            for path in paths:
                self.objects.pop(path, None)

    monkeypatch.setattr(scheduled_router, "SupabaseStorage", FakeStorage)
    return FakeStorage()


def _upload_washing_photos(client, report_id):
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 64
    before = client.post(
        f"{BASE}/daily-reports/{report_id}/evidence",
        files=[("files", ("before.png", png, "image/png"))],
        data={"kind": "before"},
    )
    after = client.post(
        f"{BASE}/daily-reports/{report_id}/evidence",
        files=[("files", ("after.png", png, "image/png"))],
        data={"kind": "after"},
    )
    assert before.status_code == 200, before.text
    assert after.status_code == 200, after.text


def _engineer(client, db, plant, email="ov-engineer@example.com"):
    engineer = login_user(client, db, role="Site Engineer", name="Overlay Engineer", email=email)
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()
    return engineer


def test_engineer_can_backdate_edit_and_delete_own_pending_report(client, db):
    from datetime import timedelta
    plant = _plant(db)
    _setup_cycle_users(client, db, plant)
    engineer = _engineer(client, db, plant)
    _act_as(engineer)
    yesterday = business_today() - timedelta(days=1)
    made = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1, "report_date": yesterday.isoformat(),
    })
    assert made.status_code == 200, made.text
    body = made.json()
    assert body["report_date"] == yesterday.isoformat() and body["can_edit"] and body["can_delete"]
    future = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1,
        "report_date": (business_today() + timedelta(days=1)).isoformat(),
    })
    assert future.status_code == 422
    edited = client.patch(f"{BASE}/daily-reports/{body['id']}", json={"tables_cleaned": 3, "remarks": "fixed count"})
    assert edited.status_code == 200, edited.text
    assert edited.json()["tables_cleaned"] == 3 and edited.json()["remarks"] == "fixed count"
    assert client.patch(f"{BASE}/daily-reports/{body['id']}", json={"tables_cleaned": 99}).status_code == 200
    assert client.delete(f"{BASE}/daily-reports/{body['id']}").status_code == 200


def test_head_changes_cycle_deadline_and_edits_reviewed_report(client, db):
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)
    month = business_today().strftime("%Y-%m")
    target = business_today().replace(day=28)
    _act_as(head)
    changed = client.patch(f"{BASE}/plants/{plant.id}/cycle-date", json={"month": month, "cycle_no": 1, "due_date": target.isoformat()})
    assert changed.status_code == 200, changed.text
    assert changed.json()["due_dates"][0] == target.isoformat()
    overview = client.get(f"{BASE}/overview").json()
    row = next(p for p in overview["plants"] if p["plant_id"] == str(plant.id))
    assert row["cycles"][0]["due_date"] == target.isoformat() and row["cycles"][0]["due_overridden"] is True
    # outside the month is refused; reset restores the default
    other_month = (business_today().replace(day=1) - __import__("datetime").timedelta(days=1)).isoformat()
    assert client.patch(f"{BASE}/plants/{plant.id}/cycle-date", json={"month": month, "cycle_no": 1, "due_date": other_month}).status_code == 422
    reset = client.patch(f"{BASE}/plants/{plant.id}/cycle-date", json={"month": month, "cycle_no": 1, "due_date": None})
    assert reset.json()["due_dates"][0].endswith("-10")

    # O&M back-fills an older report (auto-confirmed), edits its date, then deletes it
    old = (business_today().replace(day=1))
    made = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 4, "report_date": old.isoformat()})
    assert made.status_code == 200, made.text
    assert made.json()["review_status"] == "Confirmed" and made.json()["cycle_completed"] is True
    moved = client.patch(f"{BASE}/daily-reports/{made.json()['id']}", json={"report_date": old.replace(day=min(5, business_today().day)).isoformat()})
    assert moved.status_code == 200 and moved.json()["cycle_completed"] is True
    assert client.delete(f"{BASE}/daily-reports/{made.json()['id']}").status_code == 200
    row = next(p for p in client.get(f"{BASE}/overview").json()["plants"] if p["plant_id"] == str(plant.id))
    assert row["cycles_this_month"] == 0


def test_site_engineer_report_counts_can_vary_by_day_without_daily_target(client, db):
    plant = _plant(db)
    _head, _assignee = _setup_cycle_users(client, db, plant)
    engineer = _engineer(client, db, plant, "variable-count-engineer@example.com")
    _act_as(engineer)
    first = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 3,
    })
    assert first.status_code == 200, first.text
    second = client.post(f"{BASE}/daily-reports", json={
        "plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1,
    })
    assert second.status_code == 200, second.text
    overview = client.get(f"{BASE}/overview").json()
    plant_row = next(row for row in overview["plants"] if row["plant_id"] == str(plant.id))
    assert "cycle_compliance_percent" not in plant_row and "cycle_compliance" not in plant_row
    assert all("target" not in day for day in plant_row["daily_status"])
    assert "cycle_compliance" not in overview["portfolio"]


def test_engineer_cannot_change_cycle_dates_or_confirmed_reports(client, db):
    plant = _plant(db)
    head, _assignee = _setup_cycle_users(client, db, plant)
    engineer = _engineer(client, db, plant, "ov-engineer-2@example.com")
    _act_as(head)
    made = client.post(f"{BASE}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 1})
    _act_as(engineer)
    month = business_today().strftime("%Y-%m")
    assert client.patch(f"{BASE}/plants/{plant.id}/cycle-date", json={"month": month, "cycle_no": 1, "due_date": business_today().isoformat()}).status_code == 403
    assert client.patch(f"{BASE}/daily-reports/{made.json()['id']}", json={"tables_cleaned": 2}).status_code == 403
    assert client.delete(f"{BASE}/daily-reports/{made.json()['id']}").status_code == 403