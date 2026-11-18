from __future__ import annotations

from app.core.models import Plant
from tests.conftest import grant_assignee_plants, login_user


def _plant(db, site_code: str) -> Plant:
    plant = Plant(site_code=site_code, plant_name=f"Plant {site_code}")
    db.add(plant)
    db.commit()
    db.refresh(plant)
    return plant


def _ticket(client, plant: Plant) -> dict:
    response = client.post("/api/requirements", json={
        "plant_id": str(plant.id),
        "description": "Replace damaged signage\n\nAdd a first-aid kit\nCheck the emergency light",
    })
    assert response.status_code == 201, response.text
    return response.json()


def test_site_engineer_creates_scoped_ticket_and_counts_nonempty_lines(client, db):
    plant = _plant(db, "REQ01")
    engineer = login_user(client, db, role="Site Engineer", email="requirements-engineer@example.com")
    grant_assignee_plants(db, engineer.id, plant.id)

    created = _ticket(client, plant)

    assert created["ticketNo"].startswith("REQ-")
    assert created["siteCode"] == "REQ01"
    assert created["demandCount"] == 3
    assert created["priority"] == "Medium"
    assert created["status"] == "Open"
    assert created["createdByName"] == engineer.display_name

    listed = client.get("/api/requirements?status=Open").json()
    assert listed["total"] == 1
    assert listed["items"][0]["id"] == created["id"]


def test_om_head_can_raise_a_requirement_and_the_page_permission_exposes_the_action(client, db):
    plant = _plant(db, "REQ09")
    head = login_user(client, db, role="O&M Head", email="requirements-create-head@example.com")
    session = client.get("/api/auth/session").json()

    created = _ticket(client, plant)

    assert "requirements.create" in session["permissions"]
    assert created["siteCode"] == plant.site_code
    assert created["createdByName"] == head.display_name


def test_requirement_create_rejects_unassigned_plants_and_empty_demands(client, db):
    assigned = _plant(db, "REQ02")
    other = _plant(db, "REQ03")
    engineer = login_user(client, db, role="Site Engineer", email="requirements-scope@example.com")
    grant_assignee_plants(db, engineer.id, assigned.id)

    denied = client.post("/api/requirements", json={
        "plant_id": str(other.id),
        "description": "A demand",
    })
    blank = client.post("/api/requirements", json={
        "plant_id": str(assigned.id),
        "description": " \n \n ",
    })
    assert denied.status_code == 403
    assert blank.status_code == 422
    assert client.get("/api/requirements").json()["total"] == 0


def test_assignee_manages_priority_and_completion_with_plant_scope(client, db):
    plant = _plant(db, "REQ04")
    engineer = login_user(client, db, role="Site Engineer", email="requirements-create@example.com")
    grant_assignee_plants(db, engineer.id, plant.id)
    created = _ticket(client, plant)

    assignee = login_user(client, db, role="Assignee", email="requirements-assignee@example.com")
    grant_assignee_plants(db, assignee.id, plant.id)
    priority = client.patch(
        f"/api/requirements/{created['id']}/priority",
        json={"priority": "Low"},
    )
    completed = client.patch(
        f"/api/requirements/{created['id']}/status",
        json={"status": "Completed"},
    )

    assert priority.status_code == 200, priority.text
    assert priority.json()["priority"] == "Low"
    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "Completed"
    assert completed.json()["completedByName"] == assignee.display_name
    assert completed.json()["completedAt"]
    assert client.get("/api/requirements?status=Open").json()["total"] == 0
    assert client.get("/api/requirements?status=Completed").json()["total"] == 1

    login_user(client, db, role="O&M Head", email="requirements-head@example.com")
    head_priority = client.patch(
        f"/api/requirements/{created['id']}/priority",
        json={"priority": "Critical"},
    )
    assert head_priority.status_code == 200, head_priority.text
    assert head_priority.json()["priority"] == "Critical"
    assert head_priority.json()["completedByName"] == assignee.display_name


def test_site_engineer_cannot_manage_ticket_and_assignee_cannot_cross_plant_scope(client, db):
    plant = _plant(db, "REQ05")
    other = _plant(db, "REQ06")
    engineer = login_user(client, db, role="Site Engineer", email="requirements-create-2@example.com")
    grant_assignee_plants(db, engineer.id, plant.id)
    created = _ticket(client, plant)

    assert client.patch(
        f"/api/requirements/{created['id']}/status",
        json={"status": "Completed"},
    ).status_code == 403

    assignee = login_user(client, db, role="Assignee", email="requirements-assignee-scope@example.com")
    grant_assignee_plants(db, assignee.id, other.id)
    assert client.get("/api/requirements").json()["total"] == 0
    assert client.patch(
        f"/api/requirements/{created['id']}/priority",
        json={"priority": "Critical"},
    ).status_code == 404


def test_requirement_priority_is_limited_to_supported_levels(client, db):
    plant = _plant(db, "REQ07")
    engineer = login_user(client, db, role="Site Engineer", email="requirements-priority@example.com")
    grant_assignee_plants(db, engineer.id, plant.id)
    created = _ticket(client, plant)
    assignee = login_user(client, db, role="Assignee", email="requirements-priority-assignee@example.com")
    grant_assignee_plants(db, assignee.id, plant.id)

    invalid = client.patch(
        f"/api/requirements/{created['id']}/priority",
        json={"priority": "Later"},
    )
    assert invalid.status_code == 422


def test_requirement_points_sort_numerically_and_column_filters_compose(client, db):
    plant = _plant(db, "REQ08")
    engineer = login_user(client, db, role="Site Engineer", email="requirements-sort@example.com")
    grant_assignee_plants(db, engineer.id, plant.id)
    many_points = _ticket(client, plant)
    one_point_response = client.post("/api/requirements", json={
        "plant_id": str(plant.id),
        "description": "Replace the damaged notice",
    })
    assert one_point_response.status_code == 201
    one_point = one_point_response.json()

    assignee = login_user(client, db, role="Assignee", email="requirements-sort-assignee@example.com")
    grant_assignee_plants(db, assignee.id, plant.id)
    critical = client.patch(f"/api/requirements/{many_points['id']}/priority", json={"priority": "Critical"})
    low = client.patch(f"/api/requirements/{one_point['id']}/priority", json={"priority": "Low"})
    assert critical.status_code == 200, critical.text
    assert low.status_code == 200, low.text

    sorted_rows = client.get(
        "/api/requirements?status=Open&sort_by=description&sort_dir=desc"
    ).json()["items"]
    sorted_point_rows = client.get(
        "/api/requirements?status=Open&sort_by=demandCount&sort_dir=desc"
    ).json()["items"]
    critical_rows = client.get(
        "/api/requirements?status=Open&filter_priority=Critical"
    ).json()["items"]

    assert [row["demandCount"] for row in sorted_rows] == [3, 1]
    assert [row["demandCount"] for row in sorted_point_rows] == [3, 1]
    assert [row["priority"] for row in critical_rows] == ["Critical"]
