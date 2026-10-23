from __future__ import annotations

from datetime import date, timedelta
from uuid import UUID

from app.core.models import AppSetting, AuditLog, Notification, UserEquipmentTypeAssignment, UserPlantAssignment, WashingDailyReport
from app.core.timeutil import business_today
from app.scheduled import washing_cycles
from app.scheduled.washing_cycles import (
    DEFAULT_EXCUSED_REASONS,
    EXCUSED_REASONS_SETTING,
    _daily_table_target,
    _month_key,
    check_weekly_compliance_alerts,
)
from tests import conftest
from tests.conftest import login_user
from tests.test_washing_cycles import BASE, _plant

TABLES = 100


def _setup(client, db):
    """A plant with 100 tables per cycle; returns (plant, head, assignee). The O&M Head is the current user."""
    plant = _plant(db)
    assignee = login_user(client, db, role="Assignee", name="Reason Assignee", email="reason-assignee@example.com")
    db.add(UserEquipmentTypeAssignment(user_id=assignee.id, equipment_type="Modules cleaning"))
    db.commit()
    head = login_user(client, db, role="O&M Head", name="Reason Head", email="reason-head@example.com")
    setup = client.post(f"{BASE}/setup", json={"plant_id": str(plant.id), "table_count": TABLES, "assignee_user_id": str(assignee.id)})
    assert setup.status_code == 200, setup.text
    return plant, head, assignee


def _day(db, plant, day, tables, remarks=None, status="Confirmed", reason=None):
    db.add(WashingDailyReport(
        plant_id=plant.id, cycle_month=_month_key(day), cycle_no=1, report_date=day,
        job_status="Done" if tables else "Not done", tables_cleaned=tables, cleaned_table_codes=[],
        remarks=remarks, exception_reason=None if tables else (reason or "Other"),
        reported_by="Tester", review_status=status,
    ))
    db.commit()


def _weekly(client, plant):
    overview = client.get(f"{BASE}/overview")
    assert overview.status_code == 200, overview.text
    return next(p for p in overview.json()["plants"] if p["plant_id"] == str(plant.id))["weekly_compliance_percent"]


def _expected(today, washed, skip=()):
    due = sum(_daily_table_target(TABLES, today - timedelta(days=n)) for n in range(7) if today - timedelta(days=n) not in skip)
    return min(100, round(100 * washed / due)) if due else 100


def test_listed_reasons_excuse_a_zero_day_and_other_zero_days_lower_the_score(client, db):
    plant, _head, _assignee = _setup(client, db)
    today = business_today()
    rain, labour, worked = today - timedelta(days=1), today - timedelta(days=2), today - timedelta(days=3)
    _day(db, plant, worked, 5)
    _day(db, plant, rain, 0, "Heavy RAIN since   morning")        # listed reason, any case / spacing
    _day(db, plant, labour, 0, "Labour absent")                    # not listed: counts as 0 cleaned
    assert _weekly(client, plant) == _expected(today, 5, skip={rain})

    # once the O&M Head lists "labour absent", that day stops lowering the score too
    added = client.post(f"{BASE}/compliance-reasons", json={"reason": "  Labour   absent "})
    assert added.status_code == 200, added.text
    assert added.json()["reasons"] == [*DEFAULT_EXCUSED_REASONS, "Labour absent"]
    assert _weekly(client, plant) == _expected(today, 5, skip={rain, labour})


def test_reasons_match_whole_words_and_older_specific_reasons(client, db):
    plant, _head, _assignee = _setup(client, db)
    today = business_today()
    training, water, legacy = today - timedelta(days=1), today - timedelta(days=2), today - timedelta(days=3)
    _day(db, plant, training, 0, "Team training day")              # "rain" inside "training" is not a match
    _day(db, plant, water, 0, "water shortage at site")
    _day(db, plant, legacy, 0, None, reason="Rain")                # older entry saved with the Rain reason
    assert _weekly(client, plant) == _expected(today, 0, skip={water, legacy})


def test_pending_listed_day_is_excused_at_once_and_a_rejected_one_is_not(client, db):
    plant, _head, _assignee = _setup(client, db)
    today = business_today()
    pending, rejected = today - timedelta(days=1), today - timedelta(days=2)
    _day(db, plant, pending, 0, "Work not started", status="Pending")
    _day(db, plant, rejected, 0, "Rain", status="Rejected")
    assert _weekly(client, plant) == _expected(today, 0, skip={pending})


def test_weekly_alert_and_day_view_follow_the_same_rule(client, db):
    plant, _head, _assignee = _setup(client, db)
    today = business_today()
    rain = today - timedelta(days=1)
    _day(db, plant, rain, 0, "rain")
    day = client.get(f"{BASE}/day-activity", params={"day": rain.isoformat(), "plant_id": str(plant.id)}).json()
    assert day["plants"][0]["difference"] is None                  # excused: no shortfall against target
    labour = today - timedelta(days=2)
    _day(db, plant, labour, 0, "labour absent")
    day = client.get(f"{BASE}/day-activity", params={"day": labour.isoformat(), "plant_id": str(plant.id)}).json()
    assert day["plants"][0]["difference"] == -_daily_table_target(TABLES, labour)

    db.query(Notification).delete()
    db.commit()
    assert check_weekly_compliance_alerts(db, today) == 1
    message = db.query(Notification).filter_by(event_type="washing_weekly_compliance_low").first().message
    due = sum(_daily_table_target(TABLES, today - timedelta(days=n)) for n in range(7) if today - timedelta(days=n) != rain)
    assert f"0 of {due} tables" in message


def test_only_the_om_head_changes_the_list_and_every_change_is_audited(client, db):
    _plant_row, head, assignee = _setup(client, db)
    listed = client.get(f"{BASE}/compliance-reasons").json()
    assert listed["reasons"] == list(DEFAULT_EXCUSED_REASONS) and listed["can_edit"] is True

    conftest._CURRENT_USER = assignee
    assert client.get(f"{BASE}/compliance-reasons").json()["can_edit"] is False
    assert client.post(f"{BASE}/compliance-reasons", json={"reason": "Fog"}).status_code == 403
    assert client.put(f"{BASE}/compliance-reasons", json={"reasons": []}).status_code == 403
    assert client.delete(f"{BASE}/compliance-reasons", params={"reason": "Rain"}).status_code == 403
    engineer = login_user(client, db, role="Site Engineer", name="Reason Engineer", email="reason-engineer@example.com")
    conftest._CURRENT_USER = engineer
    assert client.get(f"{BASE}/compliance-reasons").status_code == 403

    conftest._CURRENT_USER = head
    replaced = client.put(f"{BASE}/compliance-reasons", json={"reasons": ["Rain", "rain ", "Grid outage", ""]})
    assert replaced.status_code == 422                              # an empty reason is refused
    replaced = client.put(f"{BASE}/compliance-reasons", json={"reasons": ["Rain", "rain ", "Grid outage"]})
    assert replaced.status_code == 200 and replaced.json()["reasons"] == ["Rain", "Grid outage"]
    removed = client.delete(f"{BASE}/compliance-reasons", params={"reason": "GRID OUTAGE"})
    assert removed.status_code == 200 and removed.json()["reasons"] == ["Rain"]
    assert client.delete(f"{BASE}/compliance-reasons", params={"reason": "Fog"}).status_code == 404
    assert db.get(AppSetting, EXCUSED_REASONS_SETTING).setting_value == ["Rain"]
    audits = db.query(AuditLog).filter_by(entity_id=EXCUSED_REASONS_SETTING).all()
    assert len(audits) == 2 and audits[-1].metadata_json == {"from": ["Rain", "Grid outage"], "to": ["Rain"]}


def _late_plant(client, db, monkeypatch, excused_days):
    """13 Nov: cycle 1 was due 10 Nov and is not complete, so the plant is 3 days late."""
    today = date(2026, 11, 13)
    monkeypatch.setattr(washing_cycles, "business_today", lambda: today)
    plant, head, assignee = _setup(client, db)
    _day(db, plant, date(2026, 11, 2), 20)
    for n in range(excused_days):
        _day(db, plant, date(2026, 11, 5 + n), 0, "Rain all day" if n % 2 else "Water shortage")
    _day(db, plant, date(2026, 11, 12), 0, "Labour absent")        # not a listed reason: does not count
    washing_cycles.invalidate_overview_cache()
    row = next(p for p in client.get(f"{BASE}/overview").json()["plants"] if p["plant_id"] == str(plant.id))
    return row, assignee


def test_late_plant_is_delayed_by_reason_when_excused_days_cover_the_delay(client, db, monkeypatch):
    row, _assignee = _late_plant(client, db, monkeypatch, excused_days=3)
    assert row["overdue_bucket"] == "3d" and row["overdue_days"] == 3
    assert row["excused_days_late_cycle"] == 3 and row["delay_excused"] is True


def test_late_plant_is_not_on_track_when_excused_days_fall_short(client, db, monkeypatch):
    row, assignee = _late_plant(client, db, monkeypatch, excused_days=2)
    assert row["overdue_days"] == 3 and row["excused_days_late_cycle"] == 2 and row["delay_excused"] is False
    # an on-track plant is never "delayed by reason", and field users never receive these figures
    engineer = login_user(client, db, role="Site Engineer", name="Late Engineer", email="late-engineer@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=UUID(row["plant_id"]), assignment_role="Site Engineer"))
    db.commit()
    conftest._CURRENT_USER = engineer
    washing_cycles.invalidate_overview_cache()
    field_row = client.get(f"{BASE}/overview").json()["plants"][0]
    assert "delay_excused" not in field_row and "excused_days_late_cycle" not in field_row
