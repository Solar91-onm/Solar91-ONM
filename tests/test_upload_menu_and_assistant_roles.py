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


def test_frontend_hides_assistant_for_site_engineers_and_uses_an_account_menu():
    intelligence = (JS / "33-command-intelligence.js").read_text(encoding="utf-8")
    assert "const allowedAssistantRoles=['O&M Head','Assignee','Administration'];" in intelligence
    core = (JS / "02-core-render-and-dashboard.js").read_text(encoding="utf-8")
    assert 'onclick="clerkSignOut()" title="Sign out"' not in core, "clicking the name must open the menu, not sign out"
    assert "s91ToggleUserMenu(event)" in core and ">Log out</button>" in core
    assert '["O&M Head","Assignee","Administration"].includes(S._roleLabel||S.currentRole||"")?\'<button type="button" class="s91-side-ask"' in core


def test_upload_dialogs_are_wired():
    index = (ROOT / "frontend" / "templates" / "index.html").read_text(encoding="utf-8")
    assert "/static/js/43-issue-upload.js" in index
    uploads = (JS / "28-washing-import.js").read_text(encoding="utf-8")
    assert "/api/scheduled/washing/daily-import" in uploads and "/api/scheduled/washing/daily-template" in uploads
    assert "loadOverview()" not in uploads, "the washing overview loader is private to 26-washing-cycles.js"
    assert "window.washCyclesReload=loadOverview;" in (JS / "26-washing-cycles.js").read_text(encoding="utf-8")
    assert "/api/issues/import" in (JS / "43-issue-upload.js").read_text(encoding="utf-8")
    assert "issueUploadOpen()" in (JS / "22-site-issues-redesign.js").read_text(encoding="utf-8")
    assert "PM_Task_Plan_Template.xlsx" in (JS / "29-pm-live-dashboard.js").read_text(encoding="utf-8")
