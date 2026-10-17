from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from app.core.timeutil import business_today
from app.core.models import (
    Notification,
    NotificationPreference,
    OMTask,
    PMAlertLog,
    PMFollowUp,
    Plant,
    User,
    UserPlantAssignment,
)
from app.pmplan.units import run_daily, send_reminders_and_escalations
from tests.conftest import login_user


def _plant(db, code="PMALERT", name="Alert Plant"):
    plant = Plant(site_code=code, plant_name=name)
    db.add(plant)
    db.flush()
    return plant


def _user(db, role, name, email):
    user = User(
        auth_provider="test",
        external_subject=f"pm-alert:{email}",
        email=email,
        display_name=name,
        role=role,
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def _task(db, plant, due_on, assignee, *, status="Scheduled", unit_no=None, cycle_id=None):
    task = OMTask(
        work_order_no=f"WO-PMALERT-{unit_no or 'SINGLE'}-{due_on.day}",
        plant_id=plant.id,
        task_name="Inverter service",
        task_type="Inverter",
        frequency="Monthly",
        due_on=due_on,
        planned_due_on=due_on if unit_no else None,
        status=status,
        assignee_user_id=assignee.id if assignee else None,
        assignee_text=assignee.display_name if assignee else None,
        unit_no=unit_no,
        total_units=2 if unit_no else None,
        cycle_id=cycle_id,
    )
    db.add(task)
    db.flush()
    return task


def _events(db):
    return [(row.event_type, row.user_id, row.dedupe_key) for row in db.query(Notification).all()]


def test_fixed_date_ladder_notifies_roles_once_and_logs_each_level(db):
    plant = _plant(db)
    assignee = _user(db, "Assignee", "Ravi", "ravi-alert@example.com")
    head = _user(db, "O&M Head", "Head", "head-alert@example.com")
    engineer = _user(db, "Site Engineer", "Engineer", "engineer-alert@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id))
    task = _task(db, plant, date(2026, 10, 1), assignee)
    db.commit()

    assert send_reminders_and_escalations(db, date(2026, 9, 28))["advance"] == 1
    db.flush()
    assert {(kind, uid) for kind, uid, _ in _events(db)} == {
        ("pm_due_soon", assignee.id), ("pm_due_soon", engineer.id),
    }
    assert send_reminders_and_escalations(db, date(2026, 9, 28))["advance"] == 0

    assert send_reminders_and_escalations(db, date(2026, 10, 1))["due_today"] == 1
    assert send_reminders_and_escalations(db, date(2026, 10, 2))["escalated"] == 1
    assert send_reminders_and_escalations(db, date(2026, 10, 4))["escalated"] == 1
    assert send_reminders_and_escalations(db, date(2026, 10, 8))["escalated"] == 1
    assert send_reminders_and_escalations(db, date(2026, 10, 8))["escalated"] == 0
    db.flush()

    event_recipients = {}
    for event, user_id, _ in _events(db):
        event_recipients.setdefault(event, set()).add(user_id)
    assert event_recipients["pm_due_today"] == {assignee.id, engineer.id}
    assert event_recipients["pm_late_1d"] == {assignee.id, head.id, engineer.id}
    assert event_recipients["pm_late_3d"] == {assignee.id, head.id, engineer.id}
    assert event_recipients["pm_critical_7d"] == {assignee.id, head.id, engineer.id}
    assert task.status == "Scheduled"
    assert {row.level for row in db.query(PMAlertLog).all()} >= {
        "due_soon", "due_today", "late_1d", "late_3d", "critical_7d",
    }


def test_site_engineer_gets_pm_alerts_even_when_team_routing_is_assignee_only(db):
    plant = _plant(db, code="PMALERT-SE")
    assignee = _user(db, "Assignee", "Ravi", "ravi-alert-se@example.com")
    head = _user(db, "O&M Head", "Head", "head-alert-se@example.com")
    engineer = _user(db, "Site Engineer", "Engineer", "engineer-alert-se@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id))
    db.add(NotificationPreference(
        user_id=head.id, module="pm", plant_id=plant.id,
        preferences={"team_who": "assignee_only"},
    ))
    _task(db, plant, date(2026, 10, 4), assignee)
    db.commit()

    send_reminders_and_escalations(db, date(2026, 10, 1))
    send_reminders_and_escalations(db, date(2026, 10, 4))
    db.flush()
    assert {(row.event_type, row.user_id) for row in db.query(Notification).all()} == {
        ("pm_due_soon", assignee.id), ("pm_due_soon", engineer.id),
        ("pm_due_today", assignee.id), ("pm_due_today", engineer.id),
    }


def test_preferences_disable_delivery_and_email_is_opt_in(db, monkeypatch):
    import app.pmplan.alerts as alerts

    plant = _plant(db, code="PMALERT2")
    assignee = _user(db, "Assignee", "Ravi", "ravi-alert2@example.com")
    head = _user(db, "O&M Head", "Head", "head-alert2@example.com")
    task = _task(db, plant, date(2026, 10, 1), assignee)
    db.add(NotificationPreference(
        user_id=assignee.id,
        module="pm",
        plant_id=None,
        preferences={"events": {"pm_late_1d": {"enabled": False, "in_app": True, "email": False}}},
    ))
    db.commit()

    email_calls = []
    monkeypatch.setattr(alerts, "send_pm_alert_email", lambda **kwargs: email_calls.append(kwargs) or (True, "sent"))
    send_reminders_and_escalations(db, date(2026, 10, 2))
    db.flush()
    assert {(row.event_type, row.user_id) for row in db.query(Notification).all()} == {
        ("pm_late_1d", head.id),
    }
    assert email_calls == []
    assert db.query(PMAlertLog).filter_by(level="late_1d").one().recipients_text == "Head"

    assignee_preference = db.query(NotificationPreference).filter_by(user_id=assignee.id).one()
    assignee_preference.preferences = {
        "events": {"pm_late_1d": {"enabled": True, "in_app": False, "email": True}},
    }
    head_preference = NotificationPreference(
        user_id=head.id,
        module="pm",
        preferences={"events": {"pm_late_1d": {"enabled": False, "in_app": False, "email": False}}},
    )
    db.add(head_preference)
    # The second due date gives the email-only delivery a fresh idempotency key.
    task.due_on = date(2026, 10, 2)
    task.planned_due_on = None
    db.commit()
    send_reminders_and_escalations(db, date(2026, 10, 3))
    db.flush()
    assert email_calls and email_calls[-1]["to_email"] == assignee.email


def test_promised_date_pauses_no_followup_and_missed_promise_alerts_once(db):
    plant = _plant(db, code="PMALERT3")
    assignee = _user(db, "Assignee", "Ravi", "ravi-alert3@example.com")
    head = _user(db, "O&M Head", "Head", "head-alert3@example.com")
    task = _task(db, plant, date(2026, 10, 1), assignee)
    db.add(PMFollowUp(
        task_id=task.id,
        by_user_id=assignee.id,
        by_name=assignee.display_name,
        how="Called",
        outcome="Will finish by the promised date",
        promised_on=date(2026, 10, 5),
        at=datetime(2026, 10, 3, 8, tzinfo=timezone.utc),
    ))
    db.commit()

    send_reminders_and_escalations(db, date(2026, 10, 4))
    db.flush()
    assert not db.query(Notification).filter_by(event_type="pm_no_followup").count()
    assert db.query(Notification).filter_by(event_type="pm_late_3d").count() == 2

    assert send_reminders_and_escalations(db, date(2026, 10, 6))["promise_missed"] == 1
    assert send_reminders_and_escalations(db, date(2026, 10, 6))["promise_missed"] == 0
    db.flush()
    assert db.query(Notification).filter_by(event_type="pm_promise_missed").count() == 2
    assert send_reminders_and_escalations(db, date(2026, 10, 7))["no_followup"] == 1
    db.flush()

    task.status = "Completed"
    db.commit()
    before = db.query(PMAlertLog).count()
    send_reminders_and_escalations(db, date(2026, 10, 20))
    assert db.query(PMAlertLog).count() == before


def test_legacy_unit_cycle_gets_one_alert_for_latest_unfinished_due_date(db):
    plant = _plant(db, code="PMALERT4")
    assignee = _user(db, "Assignee", "Ravi", "ravi-alert4@example.com")
    head = _user(db, "O&M Head", "Head", "head-alert4@example.com")
    first = _task(db, plant, date(2026, 9, 29), assignee, unit_no=1, cycle_id="old-cycle")
    _task(db, plant, date(2026, 10, 1), assignee, unit_no=2, cycle_id="old-cycle")
    db.commit()

    result = send_reminders_and_escalations(db, date(2026, 10, 2))
    assert result["escalated"] == 1
    db.flush()
    assert db.query(PMAlertLog).filter_by(level="late_1d").count() == 1
    assert db.query(PMAlertLog).filter_by(level="late_1d").one().task_id == first.id
    assert {(row.event_type, row.user_id) for row in db.query(Notification).all()} == {
        ("pm_late_1d", assignee.id),
        ("pm_late_1d", head.id),
    }
    assert send_reminders_and_escalations(db, date(2026, 10, 2))["escalated"] == 0


def test_alert_preferences_api_saves_personal_and_team_settings(client, db):
    head = login_user(client, db, role="O&M Head", email="pm-prefs-head@example.com")
    plant = _plant(db, code="PMPREFS")
    db.commit()
    url = "/api/pm-plan/alert-preferences"
    defaults = client.get(url, params={"plant_id": str(plant.id)})
    assert defaults.status_code == 200
    assert defaults.json()["preferences"]["events"]["pm_weekly_summary"]["enabled"] is False

    saved = client.put(url, json={
        "plant_id": str(plant.id),
        "team_who": "whole_team",
        "events": {
            "pm_late_1d": {"enabled": False, "in_app": False, "email": False},
        },
    })
    assert saved.status_code == 200, saved.text
    result = saved.json()["preferences"]
    assert result["team_who"] == "whole_team"
    assert result["events"]["pm_late_1d"]["enabled"] is False
    assert db.query(NotificationPreference).filter_by(
        user_id=head.id, module="pm", plant_id=plant.id,
    ).count() == 1

    assignee = login_user(client, db, role="Assignee", email="pm-prefs-assignee@example.com")
    rejected = client.put(url, json={"plant_id": str(plant.id), "team_who": None})
    assert rejected.status_code == 403
    assert assignee is not None


def test_team_recipient_mode_and_task_alert_log_endpoint(client, db):
    head = login_user(client, db, role="O&M Head", email="pm-alert-log-head@example.com")
    plant = _plant(db, code="PMALOG")
    assignee = _user(db, "Assignee", "Ravi", "ravi-alert-log@example.com")
    engineer = _user(db, "Site Engineer", "Engineer", "engineer-alert-log@example.com")
    admin = _user(db, "Administration", "Admin", "admin-alert-log@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id))
    task = _task(db, plant, date(2026, 10, 4), assignee)
    db.add(NotificationPreference(
        user_id=head.id,
        module="pm",
        plant_id=plant.id,
        preferences={"team_who": "whole_team"},
    ))
    db.commit()

    send_reminders_and_escalations(db, date(2026, 10, 1))
    db.commit()
    recipients = {row.user_id for row in db.query(Notification).filter_by(event_type="pm_due_soon")}
    assert recipients == {assignee.id, head.id, engineer.id}
    assert admin.id not in recipients

    response = client.get(f"/api/scheduled/tasks/{task.work_order_no}/alerts")
    assert response.status_code == 200, response.text
    assert response.json()["levels_reached"] == ["due_soon"]
    assert response.json()["alerts"][0]["recipients_text"] == "Engineer, Ravi, Test User"


def test_weekly_summary_is_optional_and_fixed_to_monday_morning(db):
    plant = _plant(db, code="PMALERT5")
    head = _user(db, "O&M Head", "Head", "head-alert5@example.com")
    task = _task(db, plant, date(2026, 10, 1), None)
    db.commit()
    monday = date(2026, 10, 5)

    run_daily(db, monday, datetime(2026, 10, 5, 8, 0))
    assert not db.query(Notification).filter_by(event_type="pm_weekly_summary").count()

    db.add(NotificationPreference(
        user_id=head.id,
        module="pm",
        preferences={"events": {"pm_weekly_summary": {"enabled": True, "in_app": True, "email": False}}},
    ))
    db.commit()
    result = run_daily(db, monday, datetime(2026, 10, 5, 8, 0))
    assert result["weekly_summary"] == 1
    assert db.query(Notification).filter_by(event_type="pm_weekly_summary", user_id=head.id).count() == 1


def test_task_output_marks_jobs_critical_after_seven_days(client, db):
    login_user(client, db, role="O&M Head", email="pm-critical-head@example.com")
    plant = _plant(db, code="PMCRITICAL")
    task = _task(db, plant, business_today() - timedelta(days=7), None)
    db.commit()

    response = client.get("/api/scheduled/tasks")
    assert response.status_code == 200
    row = next(item for item in response.json() if item["id"] == task.work_order_no)
    assert row["days_late"] == 7
    assert row["critical"] is True
