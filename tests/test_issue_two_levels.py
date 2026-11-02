"""Issues have two levels (Critical, Medium); old High/Low values read as Critical/Medium; resolved tickets are "Solved"."""
from __future__ import annotations

import io

from openpyxl import load_workbook

from app.core.models import Issue, Plant
from app.field.router import run_operational_search
from app.issues.schemas import normalize_issue_severity
from tests.conftest import seed_work_categories, login_user


def _plant(db):
    plant = Plant(site_code="LVL01", plant_name="Level Plant")
    db.add(plant); db.commit(); db.refresh(plant)
    return plant


def test_old_values_map_to_the_two_levels():
    assert [normalize_issue_severity(v) for v in ("High", "critical", " low ", "Medium", "LOW")] == \
        ["Critical", "Critical", "Medium", "Medium", "Medium"]


def test_low_is_saved_as_medium_and_unknown_levels_are_rejected(client, db):
    plant = _plant(db)
    login_user(client, db)
    base = {"plant_id": str(plant.id), "vertical": "Inverter", "description": "Fault"}
    low = client.post("/api/issues", json={**base, "severity": "Low"})
    assert low.status_code in (200, 201), low.text
    assert low.json()["severity"] == "Medium"
    assert db.query(Issue).filter_by(ticket_no=low.json()["ticket_no"]).one().severity == "Medium"
    bad = client.post("/api/issues", json={**base, "severity": "Minor"})
    assert bad.status_code == 422 and "Critical or Medium" in bad.text


def test_stored_low_rows_show_and_filter_as_medium(client, db):
    plant = _plant(db)
    login_user(client, db)
    db.add_all([
        Issue(ticket_no="OLD-LOW", plant_id=plant.id, vertical="Inverter", description="legacy", severity="Low", status="Open"),
        Issue(ticket_no="OLD-HIGH", plant_id=plant.id, vertical="Inverter", description="legacy", severity="High", status="Open"),
    ]); db.commit()
    rows = {r["ticket_no"]: r["severity"] for r in client.get("/api/issues").json()}
    assert rows == {"OLD-LOW": "Medium", "OLD-HIGH": "Critical"}
    for wanted in ("Medium", "Low"):
        assert [r["ticket_no"] for r in client.get("/api/issues", params={"severity": wanted}).json()] == ["OLD-LOW"]
    assert [r["ticket_no"] for r in client.get("/api/issues", params={"severity": "Critical"}).json()] == ["OLD-HIGH"]


def test_upload_template_offers_two_levels_and_old_low_rows_import_as_medium(client, db):
    _plant(db)
    seed_work_categories(db)
    login_user(client, db)
    wb = load_workbook(io.BytesIO(client.get("/api/issues/import/template").content))
    formulas = [dv.formula1 for ws in wb.worksheets for dv in ws.data_validations.dataValidation]
    assert '"Critical,Medium"' in formulas and not any("Low" in (f or "") for f in formulas)
    csv_text = ("Site code,Issue category,Problem,Description,Severity,Occurred on,Target date,Assignee email\n"
                "LVL01,Inverter,,Old sheet row,Low,,,\n")
    r = client.post("/api/issues/import?dry_run=false", files={"file": ("i.csv", csv_text.encode(), "text/csv")})
    assert r.status_code == 200 and r.json()["saved"] == 1, r.text
    assert db.query(Issue).filter_by(description="Old sheet row").one().severity == "Medium"


def test_search_shows_resolved_tickets_as_solved(client, db):
    plant = _plant(db)
    head = login_user(client, db)
    db.add_all([
        Issue(ticket_no="S-OPEN", plant_id=plant.id, vertical="Inverter", description="inverter trip", severity="Critical", status="Open"),
        Issue(ticket_no="S-DONE", plant_id=plant.id, vertical="Inverter", description="inverter trip", severity="Critical", status="Resolved"),
        Issue(ticket_no="S-OLD", plant_id=plant.id, vertical="Inverter", description="inverter trip", severity="Low", status="Open"),
    ]); db.commit()
    res = run_operational_search(db, head, "inverter trip")
    by_ticket = {r.get("ticket"): r["severity"] for r in res["records"] if r.get("ticket")}
    assert by_ticket == {"S-OPEN": "Critical", "S-DONE": "Solved", "S-OLD": "Medium"}
    assert res["facets"]["severity"] == {"Critical": 1, "Solved": 1, "Medium": 1}
    solved = run_operational_search(db, head, "inverter trip", severity="Solved")
    assert [r.get("ticket") for r in solved["records"]] == ["S-DONE"]
    assert [r.get("ticket") for r in run_operational_search(db, head, "solved inverter")["records"]] == ["S-DONE"]


# Removed with the frontend bundle they asserted on (the portal replaced it):
#   test_frontend_levels_show_solved_and_keep_old_low_tickets_at_medium
# The backend behaviour they sat beside is still covered by the tests above.
