"""/api/state/collections builds only the requested collections, with the same content and scope as the bootstrap."""
from app.core.models import Issue, OMTask, Plant, UserPlantAssignment
from tests.conftest import login_user

KEYS = ["plants", "issues", "tasks", "equipment", "washMeta", "audit", "inventory"]


def _seed(db):
    mine = Plant(site_code="OWN1", plant_name="Own Plant"); other = Plant(site_code="OTH1", plant_name="Other Plant")
    db.add_all([mine, other]); db.commit()
    for i, p in enumerate((mine, other)):
        db.add(Issue(ticket_no=f"ISS-{i}", plant_id=p.id, description="Inverter trip", severity="Major", status="Open"))
        db.add(OMTask(work_order_no=f"PM-{i}", plant_id=p.id, task_name="Inverter service", status="Scheduled"))
    db.commit()
    return mine


def _compare(client):
    full = client.get("/api/bootstrap").json()["state"]
    for key in KEYS:
        one = client.get("/api/state/collections", params={"keys": key}).json()
        assert one["state"][key] == full[key], key
    both = client.get("/api/state/collections", params={"keys": "issues,tasks"}).json()["state"]
    assert set(both) == {"issues", "tasks"}
    return full


def test_collections_match_bootstrap_for_portfolio_role(client, db):
    login_user(client, db)
    _seed(db)
    full = _compare(client)
    assert {x["id"] for x in full["issues"]} == {"ISS-0", "ISS-1"}


def test_collections_keep_plant_scope_for_site_engineer(client, db):
    engineer = login_user(client, db, role="Site Engineer")
    mine = _seed(db)
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=mine.id)); db.commit()
    full = _compare(client)
    assert [x["id"] for x in full["issues"]] == ["ISS-0"]
    assert client.get("/api/state/collections", params={"keys": "issues"}).json()["state"]["issues"][0]["id"] == "ISS-0"
