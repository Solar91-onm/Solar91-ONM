from __future__ import annotations

from datetime import date, datetime, timezone

from app.core.models import Issue, OMTask, Plant, UserEquipmentTypeAssignment, UserPlantAssignment, WashingConfig
from tests.conftest import login_user
from tests import conftest
from tests.test_washing_cycles import BASE, _plant, _setup_cycle_users


def _pm(db, assignee_type="Inverter"):
    plant = Plant(site_code="DT01", plant_name="Date Plant")
    db.add(plant); db.commit(); db.refresh(plant)
    db.add_all([
        OMTask(work_order_no="WO-DT-INV", plant_id=plant.id, task_name="Clean fans", task_type="Inverter",
               frequency="Monthly", start_on=date(2026, 11, 1), due_on=date(2026, 11, 10), status="Scheduled"),
        OMTask(work_order_no="WO-DT-TR", plant_id=plant.id, task_name="Check oil", task_type="Transformer",
               frequency="Monthly", due_on=date(2026, 11, 10), status="Scheduled"),
    ])
    db.commit()
    return plant


def test_pm_start_date_head_edit_and_validation(client, db):
    login_user(client, db, role="O&M Head", name="Head", email="dt-head@example.com")
    _pm(db)
    r = client.patch("/api/scheduled/tasks/WO-DT-INV/schedule", json={"start_on": "2026-11-03"})
    assert r.status_code == 200, r.text
    assert r.json()["task"]["start"] == "2026-11-03"
    bad = client.patch("/api/scheduled/tasks/WO-DT-INV/schedule", json={"start_on": "2026-11-20"})
    assert bad.status_code == 422


def test_pm_assignee_dates_only_and_site_engineer_blocked(client, db):
    plant = _pm(db)
    assignee = login_user(client, db, role="Assignee", name="Ravi", email="dt-assignee@example.com")
    db.add(UserEquipmentTypeAssignment(user_id=assignee.id, equipment_type="Inverter")); db.commit()
    ok = client.patch("/api/scheduled/tasks/WO-DT-INV/schedule", json={"start_on": "2026-11-02", "due_on": "2026-11-12"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["task"]["start"] == "2026-11-02" and ok.json()["task"]["due"] == "2026-11-12"
    assert client.patch("/api/scheduled/tasks/WO-DT-INV/schedule", json={"name": "Renamed"}).status_code == 403
    assert client.patch("/api/scheduled/tasks/WO-DT-TR/schedule", json={"due_on": "2026-11-12"}).status_code == 403
    se = login_user(client, db, role="Site Engineer", name="SE", email="dt-se@example.com")
    db.add(UserPlantAssignment(user_id=se.id, plant_id=plant.id, assignment_role="Site Engineer")); db.commit()
    assert client.patch("/api/scheduled/tasks/WO-DT-INV/schedule", json={"due_on": "2026-11-12"}).status_code == 403


def test_washing_start_date_roles_and_rules(client, db):
    plant = _plant(db)
    _head, assignee = _setup_cycle_users(client, db, plant)
    url = f"{BASE}/plants/{plant.id}/cycle-date"
    conftest._CURRENT_USER = _head
    ok = client.patch(url, json={"month": "2026-10", "cycle_no": 1, "field": "start", "start_date": "2026-10-03"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["start_dates"][0] == "2026-10-03"
    late = client.patch(url, json={"month": "2026-10", "cycle_no": 1, "field": "start", "start_date": "2026-10-15"})
    assert late.status_code == 422                       # after the 10th deadline
    reset = client.patch(url, json={"month": "2026-10", "cycle_no": 1, "field": "start", "start_date": None})
    assert reset.json()["start_dates"][0] == "2026-10-01"
    conftest._CURRENT_USER = assignee
    assert client.patch(url, json={"month": "2026-10", "cycle_no": 2, "field": "start", "start_date": "2026-10-12"}).status_code == 200
    se = login_user(client, db, role="Site Engineer", name="Cycle SE", email="cycle-se@example.com")
    db.add(UserPlantAssignment(user_id=se.id, plant_id=plant.id, assignment_role="Site Engineer")); db.commit()
    assert client.patch(url, json={"month": "2026-10", "cycle_no": 2, "field": "start", "start_date": "2026-10-13"}).status_code == 403


def test_issue_dates_head_assignee_and_site_engineer(client, db):
    plant = Plant(site_code="DT02", plant_name="Issue Date Plant")
    db.add(plant); db.commit(); db.refresh(plant)
    assignee = login_user(client, db, role="Assignee", name="Ravi", email="dt-iss-assignee@example.com")
    other = login_user(client, db, role="Assignee", name="Other", email="dt-iss-other@example.com")
    for u in (assignee, other):
        db.add(UserEquipmentTypeAssignment(user_id=u.id, equipment_type="Inverter"))
    issue = Issue(ticket_no="DT-1", plant_id=plant.id, vertical="Inverter", description="Fault", severity="Medium",
                  status="Assigned", assigned_to=assignee.id, assignee_text="Ravi",
                  occurred_at=datetime(2026, 10, 1, 9, tzinfo=timezone.utc), etc_at=datetime(2026, 10, 5, 9, tzinfo=timezone.utc))
    db.add(issue); db.commit(); db.refresh(issue)
    url = f"/api/issues/{issue.id}/dates"
    conftest._CURRENT_USER = assignee
    ok = client.patch(url, json={"occurred_at": "2026-10-02T09:00:00", "etc_at": "2026-10-08T09:00:00", "reason": "Part delayed"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["etc_at"].startswith("2026-10-08")
    assert client.patch(url, json={"etc_at": "2026-10-01T09:00:00", "reason": "Too early"}).status_code == 422
    assert client.patch(url, json={"etc_at": "2026-10-09T09:00:00"}).status_code == 422          # reason required
    conftest._CURRENT_USER = other
    assert client.patch(url, json={"etc_at": "2026-10-09T09:00:00", "reason": "Not mine"}).status_code == 403
    se = login_user(client, db, role="Site Engineer", name="SE", email="dt-iss-se@example.com")
    db.add(UserPlantAssignment(user_id=se.id, plant_id=plant.id, assignment_role="Site Engineer")); db.commit()
    assert client.patch(url, json={"etc_at": "2026-10-09T09:00:00", "reason": "Nope"}).status_code == 403
    login_user(client, db, role="O&M Head", name="Head", email="dt-iss-head@example.com")
    assert client.patch(url, json={"etc_at": "2026-10-12T09:00:00", "reason": "Head override"}).status_code == 200
