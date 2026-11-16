from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError

from app.core.models import Plant
from app.plants.schemas import SecurityContactMove
from app.plants.service import PlantService
from tests.conftest import grant_assignee_plants, login_user


def _plants(db):
    source = Plant(
        site_code="MOVE01",
        plant_name="Source",
        custom_fields={
            "design_link": "https://example.test/source",
            "security_contacts": {
                "site_engineers": [{"name": "Asha", "mobile_no": "9876543210", "shift": "day"}],
                "guards": [],
            },
        },
    )
    destination = Plant(
        site_code="MOVE02",
        plant_name="Destination",
        custom_fields={
            "liasoning": {"folder": "destination"},
            "security_contacts": {"site_engineers": [], "guards": []},
        },
    )
    db.add_all([source, destination])
    db.commit()
    return source, destination


def test_security_contact_move_returns_both_plants_and_preserves_other_fields(client, db):
    head = login_user(client, db)
    source, destination = _plants(db)

    response = client.post("/api/plants/security/move", json={
        "from_site_code": source.site_code,
        "to_site_code": destination.site_code,
        "kind": "engineer",
        "index": 0,
    })

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["person"] == {"name": "Asha", "mobile_no": "9876543210", "shift": "day"}
    assert body["from_plant"]["custom_fields"]["design_link"] == "https://example.test/source"
    assert body["to_plant"]["custom_fields"]["liasoning"] == {"folder": "destination"}
    assert body["from_plant"]["custom_fields"]["security_contacts"]["site_engineers"] == []
    assert body["to_plant"]["custom_fields"]["security_contacts"]["site_engineers"] == [body["person"]]
    assert head.role == "O&M Head"


def test_security_contact_move_is_available_to_assignees_only_in_their_scope(client, db):
    source, destination = _plants(db)
    assignee = login_user(client, db, role="Assignee", email="move-assignee@example.com")
    grant_assignee_plants(db, assignee.id, source.id, destination.id)

    response = client.post("/api/plants/security/move", json={
        "from_site_code": source.site_code,
        "to_site_code": destination.site_code,
        "kind": "engineer",
        "index": 0,
    })

    assert response.status_code == 200, response.text


def test_security_contact_move_rejects_bad_codes_indexes_and_other_roles(client, db):
    source, destination = _plants(db)
    login_user(client, db)
    payload = {
        "from_site_code": source.site_code,
        "to_site_code": destination.site_code,
        "kind": "engineer",
        "index": 0,
    }
    assert client.post("/api/plants/security/move", json={**payload, "from_site_code": "UNKNOWN"}).status_code == 404
    assert client.post("/api/plants/security/move", json={**payload, "index": 1}).status_code == 400
    assert client.post("/api/plants/security/move", json={**payload, "to_site_code": source.site_code}).status_code == 400

    login_user(client, db, role="Administration", email="move-admin@example.com")
    assert client.post("/api/plants/security/move", json=payload).status_code == 403


def test_destination_write_failure_rolls_back_the_source_move(db):
    source, destination = _plants(db)
    db.connection().exec_driver_sql("""
        CREATE TRIGGER reject_security_move_destination
        BEFORE UPDATE OF custom_fields ON plants
        WHEN OLD.site_code = 'MOVE02'
        BEGIN SELECT RAISE(FAIL, 'destination write failed'); END
    """)
    request = SecurityContactMove(
        from_site_code=source.site_code,
        to_site_code=destination.site_code,
        kind="engineer",
        index=0,
    )

    with pytest.raises(IntegrityError):
        PlantService(db).move_security_contact(request)

    db.expire_all()
    current_source = db.get(Plant, source.id)
    current_destination = db.get(Plant, destination.id)
    assert current_source.custom_fields["security_contacts"]["site_engineers"][0]["name"] == "Asha"
    assert current_destination.custom_fields["security_contacts"]["site_engineers"] == []
