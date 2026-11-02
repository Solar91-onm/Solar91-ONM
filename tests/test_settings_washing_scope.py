from __future__ import annotations

from app.core.models import Plant, User, UserPlantAssignment, WashingConfig
from tests.conftest import login_user


def _plant(db):
    plant = Plant(site_code="WASH01", plant_name="Washing scope plant")
    db.add(plant)
    db.commit()
    return plant


def _assignee(db):
    person = User(
        auth_provider="supabase",
        external_subject="test:washing-scope",
        email="washing-scope@example.com",
        display_name="Washing Assignee",
        role="Assignee",
        is_active=True,
    )
    db.add(person)
    db.commit()
    return person


def test_access_update_persists_washing_assignment_and_grants_plant_scope(client, db):
    plant = _plant(db)
    login_user(client, db)
    person = _assignee(db)
    db.add(WashingConfig(plant_id=plant.id, tables_per_cycle=8))
    db.commit()

    response = client.put(
        f"/api/users/{person.id}/access",
        json={
            "role": "Assignee",
            "plant_ids": [],
            "washing_plant_ids": [str(plant.id)],
        },
    )

    assert response.status_code == 200, response.text
    assert db.query(UserPlantAssignment).filter_by(
        user_id=person.id, plant_id=plant.id
    ).one()
    assert db.query(WashingConfig).filter_by(
        plant_id=plant.id, assigned_user_id=person.id
    ).one()

    listed = next(
        row for row in client.get("/api/users").json()
        if row["id"] == str(person.id)
    )
    assert listed["washing_plant_ids"] == [str(plant.id)]


def test_access_update_clears_removed_washing_assignment(client, db):
    plant = _plant(db)
    login_user(client, db)
    person = _assignee(db)
    db.add(UserPlantAssignment(user_id=person.id, plant_id=plant.id, assignment_role="Assignee"))
    db.add(WashingConfig(plant_id=plant.id, assigned_user_id=person.id))
    db.commit()

    response = client.put(
        f"/api/users/{person.id}/access",
        json={"role": "Assignee", "plant_ids": [str(plant.id)], "washing_plant_ids": []},
    )

    assert response.status_code == 200, response.text
    assert db.get(WashingConfig, plant.id).assigned_user_id is None


def test_access_update_requires_washing_setup_before_assignment(client, db):
    plant = _plant(db)
    login_user(client, db)
    person = _assignee(db)

    response = client.put(
        f"/api/users/{person.id}/access",
        json={
            "role": "Assignee",
            "plant_ids": [],
            "washing_plant_ids": [str(plant.id)],
        },
    )

    assert response.status_code == 422
    assert "Set up Washing" in response.json()["detail"]["message"]


def test_washing_scope_is_limited_to_active_assignees(client, db):
    plant = _plant(db)
    login_user(client, db)
    person = _assignee(db)

    response = client.put(
        f"/api/users/{person.id}/access",
        json={
            "role": "Viewer",
            "plant_ids": [],
            "washing_plant_ids": [str(plant.id)],
        },
    )

    assert response.status_code == 422
