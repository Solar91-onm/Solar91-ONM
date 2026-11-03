"""The equipment a ticket is raised on: serial number, supplier / maker and number of units.

Added with the Raise Issue form's Classification step. All three are optional, they survive the
round trip through the API and the Site Issues spreadsheet, and the form no longer sends a
severity — the ticket falls back to Medium, which is what the default deadline is keyed to.
"""
from __future__ import annotations

import io

from openpyxl import load_workbook

from app.core.models import Issue, Plant
from tests.conftest import login_user, seed_work_categories


def _plant(db):
    plant = Plant(site_code="EQD01", plant_name="Equipment Detail Plant")
    db.add(plant); db.commit(); db.refresh(plant)
    return plant


def test_create_stores_and_returns_the_equipment_details(client, db):
    plant = _plant(db)
    login_user(client, db, email="equip-head@example.com")
    created = client.post("/api/issues", json={
        "plant_id": str(plant.id), "vertical": "Inverter", "subcategory": "Fan failure",
        "serial_no": "INV-2023-004517", "supplier_maker": "Sungrow", "unit_count": 3,
        "description": "Cooling fan stopped on inverter 4",
    })
    assert created.status_code in (200, 201), created.text
    body = created.json()
    # No severity was sent: the form no longer asks for one.
    assert (body["serial_no"], body["supplier_maker"], body["unit_count"]) == ("INV-2023-004517", "Sungrow", 3)
    assert body["severity"] == "Medium"
    row = db.query(Issue).filter_by(ticket_no=body["ticket_no"]).one()
    assert (row.serial_no, row.supplier_maker, row.unit_count) == ("INV-2023-004517", "Sungrow", 3)
    assert client.get("/api/issues").json()[0]["supplier_maker"] == "Sungrow"


def test_the_details_are_optional_and_a_unit_count_must_be_a_sensible_number(client, db):
    plant = _plant(db)
    login_user(client, db, email="equip-head2@example.com")
    base = {"plant_id": str(plant.id), "vertical": "Inverter", "description": "No equipment detail"}
    bare = client.post("/api/issues", json=base)
    assert bare.status_code in (200, 201), bare.text
    assert (bare.json()["serial_no"], bare.json()["supplier_maker"], bare.json()["unit_count"]) == (None, None, None)
    assert client.post("/api/issues", json={**base, "description": "Zero units", "unit_count": 0}).status_code == 422
    assert client.post("/api/issues", json={**base, "description": "Too many", "unit_count": 100001}).status_code == 422


def test_upload_and_export_carry_the_columns(client, db):
    _plant(db)
    seed_work_categories(db)
    login_user(client, db, email="equip-head3@example.com")
    csv_text = ("Site code,Issue category,Problem,Serial number,Supplier / Maker,Units,Description,Severity\n"
                "EQD01,Inverter,Fan failure,INV-77,Sungrow,2,Fan stopped on inverter 7,Medium\n")
    uploaded = client.post("/api/issues/import?dry_run=false",
                           files={"file": ("i.csv", csv_text.encode(), "text/csv")})
    assert uploaded.status_code == 200 and uploaded.json()["saved"] == 1, uploaded.text
    row = db.query(Issue).filter_by(description="Fan stopped on inverter 7").one()
    assert (row.serial_no, row.supplier_maker, row.unit_count) == ("INV-77", "Sungrow", 2)

    sheet = load_workbook(io.BytesIO(client.get("/api/issues/export").content))["Site issues"]
    headers = [cell.value for cell in sheet[1]]
    assert ["Serial number", "Supplier / Maker", "Units"] == [h for h in headers
                                                              if h in {"Serial number", "Supplier / Maker", "Units"}]
    exported = dict(zip(headers, [cell.value for cell in sheet[2]]))
    assert (exported["Serial number"], exported["Supplier / Maker"], exported["Units"]) == ("INV-77", "Sungrow", 2)


def test_a_bad_unit_count_in_the_sheet_stops_the_upload(client, db):
    _plant(db)
    seed_work_categories(db)
    login_user(client, db, email="equip-head4@example.com")
    csv_text = ("Site code,Issue category,Description,Severity,Units\n"
                "EQD01,Inverter,Fan stopped,Medium,many\n")
    checked = client.post("/api/issues/import?dry_run=true",
                          files={"file": ("i.csv", csv_text.encode(), "text/csv")})
    assert checked.status_code == 200
    assert "Units must be a whole number" in checked.json()["problems"][0]["errors"]
    assert db.query(Issue).count() == 0
