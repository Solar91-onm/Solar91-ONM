"""A Site Engineer sees only their own plant — across every read endpoint the portal uses."""
from __future__ import annotations

from datetime import date, timedelta

from app.core.models import Equipment, Issue, OMTask, Plant, UserPlantAssignment, WashingConfig, WashingTable
from tests.conftest import login_user


def _seed(db):
    mine = Plant(site_code="SEOWN1", plant_name="Own Plant")
    other = Plant(site_code="SEOTH1", plant_name="Other Plant")
    db.add_all([mine, other]); db.commit()
    for plant, tag in ((mine, "OWN"), (other, "OTHER")):
        db.add(Equipment(plant_id=plant.id, equipment_code=f"INV-{tag}", equipment_name=f"Inverter {tag}", equipment_type="Inverter"))
        db.add(Issue(ticket_no=f"ISS-{tag}", plant_id=plant.id, description=f"Fault at {tag}", severity="Medium", status="Open", vertical="Inverter"))
        db.add(OMTask(work_order_no=f"WO-{tag}", plant_id=plant.id, task_name=f"Inspect {tag}", task_type="Inverter", status="Scheduled",
                      due_on=date.today() + timedelta(days=2)))
        db.add(WashingConfig(plant_id=plant.id, team=[], frequency_days=14))
        db.add(WashingTable(plant_id=plant.id, legacy_id=f"W-{tag}", table_code=f"T-{tag}", inverter_no=1))
    db.commit()
    return mine, other


def _text(response) -> str:
    assert response.status_code in (200, 403, 404), (response.request.url, response.status_code, response.text[:300])
    return response.text if response.status_code == 200 else ""


def test_site_engineer_reads_only_their_own_plant(client, db):
    mine, other = _seed(db)
    engineer = login_user(client, db, role="Site Engineer", name="Field Person", email="field@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=mine.id)); db.commit()

    endpoints = [
        "/api/bootstrap", "/api/bootstrap?lite=1", "/api/state/collections?keys=plants,issues,tasks,equipment,washing,washMeta",
        "/api/plants", "/api/equipment", "/api/equipment/page", "/api/issues", "/api/issues/pulse",
        "/api/scheduled/tasks", "/api/scheduled/washing/overview", "/api/field/overview", "/api/field/search?q=Other",
        "/api/field/search?q=OTHER", "/api/notifications", "/api/audit", "/api/users", "/api/scada/latest",
        "/api/tasks", "/api/washing", "/api/handovers", "/api/documents", "/api/incidents", "/api/inventory",
        "/api/permits", "/api/service-requests", "/api/sla", "/api/vendors",
    ]
    leaks = {}
    for url in endpoints:
        body = _text(client.get(url))
        found = [marker for marker in ("Other Plant", "SEOTH1", "ISS-OTHER", "WO-OTHER", "INV-OTHER", "T-OTHER", str(other.id)) if marker in body]
        if found:
            leaks[url] = found
    assert not leaks, leaks

    # direct reads of the other plant's records are refused
    other_issue = db.query(Issue).filter_by(ticket_no="ISS-OTHER").one()
    assert client.get(f"/api/issues/{other_issue.id}/activity").status_code in (403, 404)
    assert client.get(f"/api/scheduled/tasks/WO-OTHER/followups").status_code in (403, 404)
    other_eq = db.query(Equipment).filter_by(equipment_code="INV-OTHER").one()
    assert client.get(f"/api/equipment/{other_eq.id}/detail").status_code in (403, 404)

    # and their own plant is visible
    assert "ISS-OWN" in client.get("/api/issues").text
    assert "Own Plant" in client.get("/api/scheduled/washing/overview").text
