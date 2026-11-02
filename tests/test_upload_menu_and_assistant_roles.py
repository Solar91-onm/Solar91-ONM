from __future__ import annotations

from pathlib import Path

from app.core.models import Plant, UserPlantAssignment
from tests.conftest import login_user

ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / "frontend" / "static" / "js"


def test_ask_solar91_is_refused_for_site_engineers(client, db):
    plant = Plant(site_code="ASK01", plant_name="Ask Plant")
    db.add(plant)
    db.commit()
    engineer = login_user(client, db, role="Site Engineer", name="Ask Engineer", email="ask-se@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id))
    db.commit()
    assert client.post("/api/field/ask", json={"question": "open issues"}).status_code == 403
    assert client.get("/api/field/search?q=open").status_code == 403
    assert client.get("/api/field/overview").status_code == 200  # the field desk itself stays available

    for role in ("O&M Head", "Assignee", "Administration"):
        login_user(client, db, role=role, name=f"Ask {role}", email=f"ask-{role.replace(' ', '').replace('&', '')}@example.com")
        assert client.post("/api/field/ask", json={"question": "open issues"}).status_code == 200, role
        assert client.get("/api/field/search?q=open").status_code == 200, role

# Removed with the frontend bundle they asserted on (the portal replaced it):
#   test_frontend_hides_assistant_for_site_engineers_and_uses_an_account_menu
