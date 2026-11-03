"""Site Engineer scope on the Overview and Plants tabs, through the portal API.

Complements test_site_engineer_scope.py, which sweeps every read endpoint for cross-plant
leakage. This one pins the two views named in the requirement and the empty-scope case.

Overview and the Plants tab are portfolio-wide for the O&M Head, Administration and Assignees. A
Site Engineer is scoped to the plants they are assigned, and the server is what enforces it: these
go through the HTTP API, not the helpers, so a route that forgot to scope would fail here.
"""
from __future__ import annotations

from uuid import UUID

import pytest

from app.core.models import User, UserPlantAssignment
from tests.conftest import login_user


@pytest.fixture
def two_plants_one_engineer(client, db):
    login_user(client, db, role="O&M Head", name="Scope Head", email="scope-head@example.com")
    plants = []
    for code in ("SE01", "SE02"):
        created = client.post("/api/plants", json={"site_code": code, "plant_name": "Scope " + code})
        assert created.status_code == 201, created.text
        plants.append(created.json())
        raised = client.post("/api/issues", json={
            "plant_id": created.json()["id"], "description": f"Issue at {code}",
            "vertical": "Inverter", "severity": "Medium",
        })
        assert raised.status_code == 201, raised.text

    engineer = User(auth_provider="test", external_subject="scope-engineer",
                    email="scope-engineer@example.com", display_name="Scope Engineer",
                    role="Site Engineer", is_active=True)
    db.add(engineer)
    db.commit()
    db.refresh(engineer)
    # Assigned to the first plant only.
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=UUID(plants[0]["id"]),
                               assignment_role="Site Engineer"))
    db.commit()
    return plants, engineer


def _become(db, user):
    from tests import conftest
    conftest._CURRENT_USER = db.get(User, user.id)


def test_overview_shows_a_site_engineer_only_their_own_plant(two_plants_one_engineer, client, db):
    plants, engineer = two_plants_one_engineer

    head_codes = {row["plant"]["site_code"] for row in client.get("/api/portal/overview").json()["rows"]}
    assert head_codes == {"SE01", "SE02"}, "the O&M Head still sees the portfolio"

    _become(db, engineer)
    body = client.get("/api/portal/overview").json()
    codes = {row["plant"]["site_code"] for row in body["rows"]}
    assert codes == {"SE01"}, codes


def test_the_plants_tab_shows_a_site_engineer_only_their_own_plant(two_plants_one_engineer, client, db):
    plants, engineer = two_plants_one_engineer
    _become(db, engineer)
    codes = {plant["site_code"] for plant in client.get("/api/portal/plants").json()["plants"]}
    assert codes == {"SE01"}, codes


def test_a_site_engineer_cannot_reach_another_plant_by_naming_it(two_plants_one_engineer, client, db):
    plants, engineer = two_plants_one_engineer
    _become(db, engineer)
    # The trend endpoint takes explicit site codes; an unassigned one must not resolve.
    denied = client.get("/api/portal/overview/trend"
                        "?start_date=2026-10-01&end_date=2026-10-31&site_code=SE02")
    assert denied.status_code in (403, 404), denied.text
    allowed = client.get("/api/portal/overview/trend"
                         "?start_date=2026-10-01&end_date=2026-10-31&site_code=SE01")
    assert allowed.status_code == 200, allowed.text


def test_a_site_engineer_with_no_assignment_sees_nothing_rather_than_everything(client, db):
    login_user(client, db, role="O&M Head", name="Scope Head 2", email="scope-head2@example.com")
    created = client.post("/api/plants", json={"site_code": "SE09", "plant_name": "Scope SE09"})
    assert created.status_code == 201, created.text

    unassigned = User(auth_provider="test", external_subject="scope-none",
                      email="scope-none@example.com", display_name="Unassigned Engineer",
                      role="Site Engineer", is_active=True)
    db.add(unassigned)
    db.commit()
    db.refresh(unassigned)
    _become(db, unassigned)

    # An empty scope must mean no plants, never "no filter".
    assert client.get("/api/portal/plants").json()["plants"] == []
    assert client.get("/api/portal/overview").json()["rows"] == []
