"""Regression tests for defects reported during the October 2026 handover repair:
duplicate issue submission, equipment linkage, O&M washing entries with photos,
plant capacity save path, spreadsheet formula injection, and deployment diagnostics."""
from __future__ import annotations

import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

import pytest
from openpyxl import load_workbook
from sqlalchemy import select

from app.core.models import Equipment, Issue, Plant, UserEquipmentTypeAssignment, UserPlantAssignment
from tests import conftest
from tests.conftest import login_user

ROOT = Path(__file__).resolve().parents[1]
WASH = "/api/scheduled/washing"


def _plant_with_inverters(db, count=3):
    plant = Plant(site_code="DUP01", plant_name="Duplicate Test Plant")
    db.add(plant)
    db.commit()
    units = [Equipment(plant_id=plant.id, equipment_code=f"INV-{n:02d}", equipment_name=f"Inverter {n:02d}",
                       equipment_type="Inverter", status="active", serial_number=f"SN-{n:03d}") for n in range(1, count + 1)]
    db.add_all(units)
    db.commit()
    return plant, units


# ---------------------------------------------------------------- issues

def test_identical_resubmission_returns_the_same_ticket(client, db):
    login_user(client, db)
    plant, units = _plant_with_inverters(db)
    body = {"plant_id": str(plant.id), "equipment_id": str(units[1].id), "equipment_ref": "INV-02",
            "vertical": "Inverter", "description": "Inverter trips on DC overvoltage", "severity": "Medium"}
    first = client.post("/api/issues", json=body)
    second = client.post("/api/issues", json=body)
    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json()["ticket_no"] == second.json()["ticket_no"]
    assert db.scalar(select(Issue).where(Issue.description == body["description"]).limit(2)) is not None
    assert len(db.scalars(select(Issue)).all()) == 1


def test_one_issue_links_to_exactly_one_registered_unit(client, db):
    login_user(client, db)
    plant, units = _plant_with_inverters(db)
    created = client.post("/api/issues", json={
        "plant_id": str(plant.id), "equipment_id": str(units[2].id), "equipment_ref": "INV-03",
        "vertical": "Inverter", "description": "String fuse blown", "severity": "Medium"})
    assert created.status_code == 201, created.text
    assert created.json()["equipment_id"] == str(units[2].id)
    other = client.post("/api/issues", json={
        "plant_id": str(plant.id), "equipment_id": str(units[0].id), "equipment_ref": "INV-01",
        "vertical": "Inverter", "description": "String fuse blown", "severity": "Medium"})
    assert other.status_code == 201
    assert other.json()["ticket_no"] != created.json()["ticket_no"], "a different unit is a different ticket"
    assert len(db.scalars(select(Issue)).all()) == 2


def test_issue_overlay_and_wizard_show_registered_equipment():
    modals = (ROOT / "frontend/static/js/07-modal-renderers.js").read_text(encoding="utf-8")
    bridge = (ROOT / "frontend/static/js/19-production-identity-and-domain-bridge.js").read_text(encoding="utf-8")
    assert 'id="tk-units-box"' in modals and "s91IssueEquipmentLabel(t)" in modals
    # actions are the footer argument; the old call passed `true` as the footer and printed it
    assert "+acts+'</div>',true);}" not in modals
    # the wizard sends every selected unit so one fault on several units is one ticket
    assert "if(creatingTicket)return;" in bridge and "unit_ids:units.map(e=>e.id)" in bridge


def test_one_ticket_covers_several_units_of_one_plant(client, db):
    login_user(client, db)
    plant, units = _plant_with_inverters(db, count=4)
    body = {"plant_id": str(plant.id), "vertical": "Inverter", "description": "Four inverters tripped on grid fault",
            "severity": "Critical", "unit_ids": [str(u.id) for u in units]}
    created = client.post("/api/issues", json=body)
    assert created.status_code == 201, created.text
    data = created.json()
    assert data["equipment_id"] is None
    assert data["equipment_ref"] == "INV-01, INV-02, INV-03, INV-04"
    assert [u["code"] for u in data["units"]] == ["INV-01", "INV-02", "INV-03", "INV-04"]
    assert len(db.scalars(select(Issue)).all()) == 1
    # a repeated submit of the same multi-unit form is the same ticket
    again = client.post("/api/issues", json=body)
    assert again.status_code == 201 and again.json()["ticket_no"] == data["ticket_no"]
    assert len(db.scalars(select(Issue)).all()) == 1
    # the same text for a different set of units is a different ticket
    other = client.post("/api/issues", json={**body, "unit_ids": [str(units[0].id)]})
    assert other.status_code == 201 and other.json()["ticket_no"] != data["ticket_no"]
    assert other.json()["equipment_id"] == str(units[0].id)


def test_ticket_units_must_belong_to_the_ticket_plant(client, db):
    login_user(client, db)
    plant, units = _plant_with_inverters(db)
    elsewhere = Plant(site_code="OTH01", plant_name="Other Plant")
    db.add(elsewhere)
    db.commit()
    stray = Equipment(plant_id=elsewhere.id, equipment_code="INV-99", equipment_name="Inverter 99", equipment_type="Inverter", status="active")
    retired = Equipment(plant_id=plant.id, equipment_code="INV-50", equipment_name="Inverter 50", equipment_type="Inverter", status="inactive")
    db.add_all([stray, retired])
    db.commit()
    base = {"plant_id": str(plant.id), "vertical": "Inverter", "description": "Fault", "severity": "Low"}
    assert client.post("/api/issues", json={**base, "unit_ids": [str(units[0].id), str(stray.id)]}).status_code == 422
    assert client.post("/api/issues", json={**base, "unit_ids": [str(retired.id)]}).status_code == 422
    assert db.scalars(select(Issue)).all() == []


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
    db.add(UserEquipmentTypeAssignment(user_id=washer.id, equipment_type="Modules cleaning"))
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
    db.add(UserEquipmentTypeAssignment(user_id=washer.id, equipment_type="Modules cleaning"))
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


def test_washing_report_form_is_available_to_the_om_team():
    source = (ROOT / "frontend/static/js/26-washing-cycles.js").read_text(encoding="utf-8")
    assert source.count("isField()||isTeam()") >= 4
    assert "Save confirmed record" in source


# ---------------------------------------------------------------- plants / capacity

def test_plant_capacity_saved_through_api_and_rendered_with_units(client, db):
    login_user(client, db)
    created = client.post("/api/plants", json={"site_code": "CAP01", "plant_name": "Capacity Plant",
                                               "dc_capacity_kw": 5000, "ac_capacity_kw": 4000})
    assert created.status_code == 201, created.text
    plant = client.get("/api/bootstrap").json()["state"]["plants"][0]
    assert plant["dcCapacitykW"] == 5000 and plant["acCapacitykW"] == 4000
    core = (ROOT / "frontend/static/js/00-auth-data-and-imports.js").read_text(encoding="utf-8")
    actions = (ROOT / "frontend/static/js/08-actions-exports-and-submission.js").read_text(encoding="utf-8")
    render = (ROOT / "frontend/static/js/02-core-render-and-dashboard.js").read_text(encoding="utf-8")
    assert 'apiFetch("/api/plants",{method:"POST"' in core
    assert "_ccmw2" not in actions, "the DOM rewrite that mixed kW/MW labels must stay removed"
    assert 'kpiTile("DC capacity",plantDcKw(p)!=null?kWStr(plantDcKw(p))+" kWp"' in render
    assert 's91Mw(plantDcKw(p))+" MWp"' in render


# ---------------------------------------------------------------- exports

def test_equipment_export_does_not_execute_formulas(client, db):
    login_user(client, db)
    plant = Plant(site_code="XL01", plant_name="Export Plant")
    db.add(plant)
    db.commit()
    db.add(Equipment(plant_id=plant.id, equipment_code="=HYPERLINK(\"http://example.invalid\",\"x\")",
                     equipment_name="+cmd|' /C calc'!A0", equipment_type="Inverter", status="active", notes="@SUM(1)"))
    db.commit()
    response = client.get("/api/equipment/export.xlsx")
    assert response.status_code == 200, response.text
    sheet_xml = zipfile.ZipFile(io.BytesIO(response.content)).read("xl/worksheets/sheet1.xml").decode()
    assert "<f>" not in sheet_xml
    sheet = load_workbook(io.BytesIO(response.content)).active
    values = [cell.value for cell in sheet[2]]
    assert '=HYPERLINK("http://example.invalid","x")' in values


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is required for frontend helper tests")
def test_client_csv_cells_neutralise_formulas():
    script = r"""
const src = require('fs').readFileSync(process.argv[1], 'utf8');
eval(src.match(/function s91CsvText\(v\)\{.*\}\n/)[0]);
console.log(JSON.stringify(['=1+1', '+A1', '-5', '-2.5', '@x', 'Plain', null].map(s91CsvText)));
"""
    run = subprocess.run(["node", "-e", script, str(ROOT / "frontend/static/js/00-auth-data-and-imports.js")],
                         capture_output=True, text=True, encoding="utf-8", timeout=20)
    assert run.returncode == 0, run.stderr
    assert json.loads(run.stdout) == ["'=1+1", "'+A1", "-5", "-2.5", "'@x", "Plain", ""]


# ---------------------------------------------------------------- deployment diagnostics

def test_portal_page_uses_content_hashed_asset_urls(client):
    from app.core.assets import asset_hash
    html = client.get("/").text
    urls = re.findall(r'''(?:src|href)=["'](/static/[^"']+)["']''', html)
    assert len(urls) > 40
    for url in urls:
        path, _, query = url.partition("?")
        assert query == f"v={asset_hash(path[len('/static/'):])}", url
    assert re.search(r'<meta name="s91-build" content="[^"]+\.[0-9a-f]{12}"', html)


def test_version_endpoint_reports_build_without_secrets(client, monkeypatch):
    monkeypatch.setenv("RENDER_GIT_COMMIT", "0123456789abcdef0123456789abcdef01234567")
    data = client.get("/health/version").json()
    assert data["commit_short"] == "0123456" and re.fullmatch(r"[0-9a-f]{12}", data["frontend_bundle"])
    assert set(data) == {"app_version", "environment", "commit", "commit_short", "branch", "frontend_bundle", "started_at"}
    text = json.dumps(data).lower()
    assert "key" not in text and "password" not in text and "database" not in text
