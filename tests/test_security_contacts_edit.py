from __future__ import annotations

from app.core.models import Plant
from tests.conftest import grant_assignee_plants, login_user


def _plant(db):
    plant = Plant(
        site_code="SEC01",
        plant_name="Register",
        custom_fields={
            "design_link": "https://example.test/sec01",
            "security_guard": {"guard_name": "Legacy", "mobile_no": "9999999999"},
            "security_contacts": {
                "site_engineers": [{"name": "Asha", "mobile_no": "9876543210", "shift": "day"}],
                "guards": [],
            },
        },
    )
    db.add(plant)
    db.commit()
    return plant


def test_head_can_edit_security_contacts_without_touching_other_fields(client, db):
    login_user(client, db)
    plant = _plant(db)

    response = client.patch(f"/api/plants/{plant.id}/security-contacts", json={
        "site_engineers": [{"name": "Bina", "mobile_no": "9000000001", "shift": "night"}],
        "guards": [{"name": "Gopal", "mobile_no": "9000000002", "shift": "day"}],
    })

    assert response.status_code == 200, response.text
    fields = response.json()["custom_fields"]
    assert fields["security_contacts"]["site_engineers"] == [
        {"name": "Bina", "mobile_no": "9000000001", "shift": "night"}
    ]
    assert fields["security_contacts"]["guards"] == [
        {"name": "Gopal", "mobile_no": "9000000002", "shift": "day"}
    ]
    # Other custom_fields survive the narrow write; the legacy single-guard key is retired.
    assert fields["design_link"] == "https://example.test/sec01"
    assert "security_guard" not in fields


def test_assignee_can_edit_contacts_without_plant_assignments(client, db):
    plant = _plant(db)
    assignee = login_user(client, db, role="Assignee", email="sec-assignee@example.com")

    response = client.patch(f"/api/plants/{plant.id}/security-contacts", json={
        "site_engineers": [{"name": "Chandan", "mobile_no": "9000000003", "shift": "day"}],
        "guards": [],
    })
    assert response.status_code == 200, response.text
    assert response.json()["custom_fields"]["security_contacts"]["site_engineers"][0]["name"] == "Chandan"


def test_other_roles_and_bad_input_are_rejected(client, db):
    plant = _plant(db)

    login_user(client, db, role="Administration", email="sec-admin@example.com")
    assert client.patch(f"/api/plants/{plant.id}/security-contacts", json={
        "site_engineers": [], "guards": [],
    }).status_code == 403

    login_user(client, db, role="Site Engineer", email="sec-eng@example.com")
    assert client.patch(f"/api/plants/{plant.id}/security-contacts", json={
        "site_engineers": [], "guards": [],
    }).status_code == 403

    # A bad mobile number is rejected for an allowed role (validation mirrors the full write).
    login_user(client, db)
    bad = client.patch(f"/api/plants/{plant.id}/security-contacts", json={
        "site_engineers": [{"name": "Dev", "mobile_no": "123", "shift": "day"}],
        "guards": [],
    })
    assert bad.status_code == 422, bad.text
