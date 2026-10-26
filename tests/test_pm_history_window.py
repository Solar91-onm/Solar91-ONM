"""Sign-in and the PM task list send open work plus recent finished work; full history stays one request away."""
from __future__ import annotations

from datetime import timedelta

from app.core.config import get_settings
from app.core.models import OMTask, Plant
from app.core.timeutil import business_today
from tests.conftest import login_user


def _tasks(db):
    plant = Plant(site_code="HIST01", plant_name="History Plant")
    db.add(plant); db.flush()
    today = business_today()
    rows = {
        "OLD-DONE": dict(status="Completed", due_on=today - timedelta(days=400), actual_completed_on=today - timedelta(days=399)),
        "OLD-CANCELLED": dict(status="Cancelled", due_on=today - timedelta(days=300)),
        "RECENT-DONE": dict(status="Completed", due_on=today - timedelta(days=20), actual_completed_on=today - timedelta(days=19)),
        # finished late: due long ago but completed recently, so it is recent history
        "LATE-DONE": dict(status="Completed", due_on=today - timedelta(days=250), actual_completed_on=today - timedelta(days=5)),
        "OLD-OPEN": dict(status="Scheduled", due_on=today - timedelta(days=500)),
        "NEXT": dict(status="Scheduled", due_on=today + timedelta(days=3)),
    }
    for no, fields in rows.items():
        db.add(OMTask(work_order_no=no, plant_id=plant.id, task_name="Inverter PM", task_type="Inverter", frequency="Monthly", **fields))
    db.commit()


def test_default_window_sends_open_and_recent_finished_work_only(client, db):
    login_user(client, db, role="O&M Head", name="Head", email="hist-head@example.com")
    _tasks(db)
    assert get_settings().bootstrap_pm_history_days == 180
    state = client.get("/api/bootstrap").json()["state"]
    assert {t["id"] for t in state["tasks"]} == {"RECENT-DONE", "LATE-DONE", "OLD-OPEN", "NEXT"}
    assert state["tasksHistoryFrom"] == (business_today() - timedelta(days=180)).isoformat()

    listed = client.get("/api/scheduled/tasks")
    assert {t["id"] for t in listed.json()} == {"RECENT-DONE", "LATE-DONE", "OLD-OPEN", "NEXT"}
    assert listed.headers["X-PM-History-From"] == state["tasksHistoryFrom"]

    full = client.get("/api/scheduled/tasks?history=all")
    assert {t["id"] for t in full.json()} == {"OLD-DONE", "OLD-CANCELLED", "RECENT-DONE", "LATE-DONE", "OLD-OPEN", "NEXT"}
    assert full.headers["X-PM-History-From"] == "all"


def test_zero_days_sends_every_record_as_before(client, db, monkeypatch):
    login_user(client, db, role="O&M Head", name="Head", email="hist-head0@example.com")
    _tasks(db)
    monkeypatch.setattr(get_settings(), "bootstrap_pm_history_days", 0)
    state = client.get("/api/bootstrap").json()["state"]
    assert len(state["tasks"]) == 6 and state["tasksHistoryFrom"] is None
    assert len(client.get("/api/scheduled/tasks").json()) == 6


def test_window_keeps_role_scope(client, db):
    _tasks(db)
    login_user(client, db, role="Assignee", name="No Scope", email="hist-assignee@example.com")
    # an Assignee without the Inverter type sees none of it, with or without full history
    assert client.get("/api/scheduled/tasks?history=all").json() == []
    assert client.get("/api/bootstrap").json()["state"]["tasks"] == []
