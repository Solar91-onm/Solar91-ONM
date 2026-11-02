"""Regression tests for defects reported during the October 2026 handover repair:
duplicate issue submission, O&M washing entries with photos, the plant capacity save
path, spreadsheet formula injection, and deployment diagnostics.

The equipment-linkage tests were removed with the asset register; what an issue is
raised against is now a work category (``issues.vertical``), covered by
tests/test_issue_two_levels.py and tests/test_portal_frontend.py."""
from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import subprocess

import pytest
from sqlalchemy import select

from app.core.models import Issue, OMTask, Plant, UserPlantAssignment
from app.core.timeutil import business_today
from tests import conftest
from tests.conftest import grant_assignee_plants, login_user

ROOT = Path(__file__).resolve().parents[1]
WASH = "/api/scheduled/washing"


def _plant(db):
    plant = Plant(site_code="DUP01", plant_name="Duplicate Test Plant")
    db.add(plant)
    db.commit()
    db.refresh(plant)
    return plant


# ---------------------------------------------------------------- issues

def test_identical_resubmission_returns_the_same_ticket(client, db):
    login_user(client, db)
    plant = _plant(db)
    body = {"plant_id": str(plant.id),
            "vertical": "Inverter", "description": "Inverter trips on DC overvoltage", "severity": "Medium"}
    first = client.post("/api/issues", json=body)
    second = client.post("/api/issues", json=body)
    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json()["ticket_no"] == second.json()["ticket_no"]
    assert db.scalar(select(Issue).where(Issue.description == body["description"]).limit(2)) is not None
    assert len(db.scalars(select(Issue)).all()) == 1






# ---------------------------------------------------------------- washing

def _stub_storage(monkeypatch):
    import app.scheduled.router as scheduled_router

    class FakeStorage:
        objects = {}

        def upload(self, path, data, content_type):
            self.objects[path] = (data, content_type)

        def download(self, path):
            return self.objects[path]

        def remove(self, paths):
            for path in paths:
                self.objects.pop(path, None)

    monkeypatch.setattr(scheduled_router, "SupabaseStorage", FakeStorage)


def _photo(client, report_id, kind):
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 64
    return client.post(f"{WASH}/daily-reports/{report_id}/evidence",
                       files=[("files", (f"{kind}.png", png, "image/png"))], data={"kind": kind})


def test_om_head_records_cleaning_and_adds_own_photos(client, db, monkeypatch):
    _stub_storage(monkeypatch)
    plant = Plant(site_code="WOM01", plant_name="Washing O&M Plant")
    db.add(plant)
    db.commit()
    washer = login_user(client, db, role="Assignee", name="Washer", email="washer@example.com")
    grant_assignee_plants(db, washer.id)
    db.commit()
    head = login_user(client, db, role="O&M Head", name="Head", email="wom-head@example.com")
    assert client.post(f"{WASH}/setup", json={"plant_id": str(plant.id), "table_count": 6,
                                              "assignee_user_id": str(washer.id)}).status_code == 200
    entry = client.post(f"{WASH}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 3})
    assert entry.status_code == 200, entry.text
    report = entry.json()
    assert report["review_status"] == "Confirmed"
    assert report["can_add_evidence"] is True
    assert _photo(client, report["id"], "before").status_code == 200
    assert _photo(client, report["id"], "after").status_code == 200
    # someone else may not change the O&M Head's confirmed record
    conftest._CURRENT_USER = washer
    assert _photo(client, report["id"], "other").status_code == 403
    conftest._CURRENT_USER = head
    edited = client.patch(f"{WASH}/daily-reports/{report['id']}", json={"tables_cleaned": 4})
    assert edited.status_code == 200 and edited.json()["tables_cleaned"] == 4


def test_engineer_report_confirmed_by_reviewer_stays_frozen(client, db, monkeypatch):
    _stub_storage(monkeypatch)
    plant = Plant(site_code="WOM02", plant_name="Frozen Plant")
    db.add(plant)
    db.commit()
    washer = login_user(client, db, role="Assignee", name="Washer2", email="washer2@example.com")
    grant_assignee_plants(db, washer.id)
    db.commit()
    login_user(client, db, role="O&M Head", name="Head2", email="wom-head2@example.com")
    assert client.post(f"{WASH}/setup", json={"plant_id": str(plant.id), "table_count": 2,
                                              "assignee_user_id": str(washer.id)}).status_code == 200
    engineer = login_user(client, db, role="Site Engineer", name="Eng", email="eng-wom@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role="Site Engineer"))
    db.commit()
    report = client.post(f"{WASH}/daily-reports", json={"plant_id": str(plant.id), "job_status": "Done", "tables_cleaned": 2}).json()
    conftest._CURRENT_USER = washer
    confirmed = client.post(f"{WASH}/daily-reports/{report['id']}/review", json={"decision": "Confirm"})
    assert confirmed.status_code == 200 and confirmed.json()["can_add_evidence"] is False
    conftest._CURRENT_USER = engineer
    assert _photo(client, report["id"], "after").status_code == 403



# ---------------------------------------------------------------- plants / capacity

def test_plant_capacity_saved_through_api_and_rendered_with_units(client, db):
    login_user(client, db)
    created = client.post("/api/plants", json={"site_code": "CAP01", "plant_name": "Capacity Plant",
                                               "dc_capacity_kw": 5000, "ac_capacity_kw": 4000})
    assert created.status_code == 201, created.text
    plant = client.get("/api/bootstrap").json()["state"]["plants"][0]
    assert plant["dcCapacitykW"] == 5000 and plant["acCapacitykW"] == 4000
    # The portal reads capacity back through its own API and shows both kWp and MWp.
    portal = client.get("/api/portal/plants").json()["plants"][0]
    assert (portal["dc_capacity_kw"], portal["ac_capacity_kw"]) == (5000, 4000)
    table = (ROOT / "assets/js/plants-table.js").read_text(encoding="utf-8")
    assert "AC (KW)" in table and "DC (KWP)" in table


def test_portfolio_calendar_exposes_saved_pm_equipment_and_unit_details(client, db):
    login_user(client, db, role="O&M Head", email="calendar-head@example.com")
    plant = Plant(site_code="CAL01", plant_name="Calendar Plant")
    db.add(plant)
    db.flush()
    due = business_today()
    db.add(OMTask(
        work_order_no="WO-CALENDAR-01",
        plant_id=plant.id,
        task_name="Inspect cooling fans",
        task_type="Inverter",
        frequency="Monthly",
        due_on=due,
        status="Scheduled",
        unit_no=3,
        total_units=20,
    ))
    db.commit()

    response = client.get("/api/portal/calendar", params={"kind": "pm", "month": due.strftime("%Y-%m")})
    assert response.status_code == 200, response.text
    event = next(row for row in response.json()["entries"] if row["reference"] == "WO-CALENDAR-01")
    assert event["equipmentType"] == "Inverter"
    assert event["frequency"] == "Monthly"
    assert (event["unitNo"], event["totalUnits"]) == (3, 20)


# ---------------------------------------------------------------- exports


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required for frontend helper tests")
def test_client_csv_cells_neutralise_formulas():
    """The portal's plant export must not hand a spreadsheet a live formula."""
    script = r"""
const fs = require('fs'), vm = require('vm');
const box = {window: {}};
vm.createContext(box);
vm.runInContext(fs.readFileSync(process.argv[1], 'utf8'), box);
const f = box.window.Solar91PortalFormat.csvText;
console.log(JSON.stringify(['=1+1', '+A1', '-5', '-2.5', '@x', 'Plain', null].map(f)));
"""
    run = subprocess.run(["node", "-e", script, str(ROOT / "assets/js/format.js")],
                         capture_output=True, text=True, encoding="utf-8", timeout=20)
    assert run.returncode == 0, run.stderr
    assert json.loads(run.stdout) == ["'=1+1", "'+A1", "-5", "-2.5", "'@x", "Plain", ""]
    # and the export actually routes its cells through it
    table = (ROOT / "assets/js/plants-table.js").read_text(encoding="utf-8")
    assert table.count("fmt.csvText(cell)") == 2, "both CSV and Excel export must neutralise formulas"


# ---------------------------------------------------------------- deployment diagnostics

def test_portal_page_uses_content_hashed_asset_urls(client):
    from app.core.assets import asset_hash_for_url
    html = client.get("/").text
    urls = re.findall(r'''(?:src|href)=["'](/(?:assets|static)/[^"']+)["']''', html)
    assert len(urls) > 10
    for url in urls:
        path, _, query = url.partition("?")
        assert query == f"v={asset_hash_for_url(path)}", url
    assert re.search(r'<meta name="s91-build" content="[^"]+\.[0-9a-f]{12}"', html)


def test_version_endpoint_reports_build_without_secrets(client, monkeypatch):
    monkeypatch.setenv("RENDER_GIT_COMMIT", "0123456789abcdef0123456789abcdef01234567")
    data = client.get("/health/version").json()
    assert data["commit_short"] == "0123456" and re.fullmatch(r"[0-9a-f]{12}", data["frontend_bundle"])
    assert set(data) == {"app_version", "environment", "commit", "commit_short", "branch", "frontend_bundle", "started_at"}
    text = json.dumps(data).lower()
    assert "key" not in text and "password" not in text and "database" not in text
