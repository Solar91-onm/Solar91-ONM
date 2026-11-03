"""Asset & Warranty setup: equipment, parts and their warranty / certification dates by spreadsheet.

The page had no inventory source at all (migration 032 removed the old equipment register). This
covers the new one: the template carries the agreed columns including the reserved certification
file column, the upload validates before it writes, a re-upload updates instead of duplicating, and
nothing crosses a plant scope.
"""
from __future__ import annotations

import io
from datetime import date

from openpyxl import Workbook, load_workbook

from app.core.models import AssetWarranty, User, UserPlantAssignment
from app.warranty import sheets
from tests.conftest import login_user

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
HEADERS = list(sheets.HEADERS)


def _plants(client):
    out = []
    for code in ("AW01", "AW02"):
        created = client.post("/api/plants", json={"site_code": code, "plant_name": "Warranty " + code})
        assert created.status_code == 201, created.text
        out.append(created.json())
    return out


def _upload(rows, headers=None):
    """Build an .xlsx the importer will read, with one row per list in `rows`."""
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = sheets.SHEET
    sheet.append(headers if headers is not None else HEADERS)
    for row in rows:
        sheet.append(row)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _post(client, content, dry_run):
    return client.post(
        f"/api/asset-warranty/import?dry_run={'true' if dry_run else 'false'}",
        files={"file": ("assets.xlsx", content, XLSX)},
    )


def _row(site="AW01", equipment="Inverter INV-03", part="Cooling fan", part_number="CF-22",
         make="Acme", serial="SN-1", qty=2, w_start="01-01-2026", w_end="31-12-2028",
         c_date="15-01-2026", c_expiry="14-01-2029", cert_file="", remarks="Shed 2"):
    return [site, "", equipment, part, part_number, make, serial, qty,
            w_start, w_end, c_date, c_expiry, cert_file, remarks]


# ── Template ─────────────────────────────────────────────────────────────────

def test_template_carries_the_agreed_columns_including_the_reserved_certificate_column(client, db):
    login_user(client, db, role="O&M Head", name="AW Head", email="aw-head@example.com")
    _plants(client)
    response = client.get("/api/asset-warranty/import/template")
    assert response.status_code == 200, response.text
    workbook = load_workbook(io.BytesIO(response.content), data_only=True)
    assert sheets.SHEET in workbook.sheetnames
    headers = [cell.value for cell in workbook[sheets.SHEET][1]]
    for column in ("Equipment", "Part", "Part number", "Warranty start", "Warranty end",
                   "Certification date", "Certification expiry"):
        assert column in headers, column
    # Reserved for the certificate API that is not built yet; the column must exist and be empty.
    assert "Certification file" in headers
    data = [r for r in workbook[sheets.SHEET].iter_rows(min_row=2, values_only=True)
            if any(v not in (None, "") for v in r)]
    assert data == [], "the template must ship with no data rows"


# ── Upload ───────────────────────────────────────────────────────────────────

def test_a_dry_run_reports_what_would_happen_and_saves_nothing(client, db):
    login_user(client, db, role="O&M Head", name="AW Head", email="aw-head@example.com")
    _plants(client)
    response = _post(client, _upload([_row()]), dry_run=True)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["dry_run"] is True and body["rows"] == 1 and body["new"] == 1 and body["saved"] == 0
    assert body["problems"] == []
    assert db.query(AssetWarranty).count() == 0, "a dry run must not write"


def test_a_committed_upload_stores_the_equipment_and_its_dates(client, db):
    login_user(client, db, role="O&M Head", name="AW Head", email="aw-head@example.com")
    _plants(client)
    assert _post(client, _upload([_row()]), dry_run=False).json()["saved"] == 1

    item = db.query(AssetWarranty).one()
    assert item.equipment == "Inverter INV-03" and item.part == "Cooling fan"
    assert item.part_number == "CF-22" and item.make == "Acme" and item.quantity == 2
    assert item.warranty_start == date(2026, 1, 1) and item.warranty_end == date(2028, 12, 31)
    assert item.certification_date == date(2026, 1, 15)
    assert item.certification_expiry == date(2029, 1, 14)
    # Nothing writes the certificate reference until that service exists.
    assert item.certification_file is None


def test_uploading_the_same_sheet_again_updates_instead_of_duplicating(client, db):
    login_user(client, db, role="O&M Head", name="AW Head", email="aw-head@example.com")
    _plants(client)
    _post(client, _upload([_row()]), dry_run=False)
    again = _post(client, _upload([_row(make="Beta", w_end="30-06-2029")]), dry_run=False).json()

    assert again["new"] == 0 and again["updated"] == 1
    item = db.query(AssetWarranty).one()
    assert item.make == "Beta" and item.warranty_end == date(2029, 6, 30)


def test_a_bad_row_blocks_the_whole_upload_and_names_the_problem(client, db):
    login_user(client, db, role="O&M Head", name="AW Head", email="aw-head@example.com")
    _plants(client)
    rows = [
        _row(),                                        # fine
        _row(site="AW99"),                             # no such plant
        _row(equipment=""),                            # equipment is required
        _row(part="Fan B", w_start="01-01-2027", w_end="01-01-2026"),   # end before start
        _row(part="Fan C", c_date="01-01-2027", c_expiry="01-01-2026"), # certification backwards
        _row(part="Fan D", qty="many"),                # not a number
    ]
    body = _post(client, _upload(rows), dry_run=False).json()
    assert body["saved"] == 0
    assert db.query(AssetWarranty).count() == 0, "no row may be written while any row is wrong"
    reported = {problem["row"]: " ".join(problem["errors"]) for problem in body["problems"]}
    assert "AW99" in reported[3]
    assert "Equipment is required" in reported[4]
    assert "before warranty start" in reported[5]
    assert "before the certification date" in reported[6]
    assert "whole number" in reported[7]


def test_the_same_equipment_twice_in_one_file_is_rejected(client, db):
    login_user(client, db, role="O&M Head", name="AW Head", email="aw-head@example.com")
    _plants(client)
    body = _post(client, _upload([_row(), _row()]), dry_run=True).json()
    assert body["saved"] == 0 and body["problems"], body
    assert "twice" in body["problems"][0]["errors"][0]


def test_a_sheet_without_the_required_columns_is_refused(client, db):
    login_user(client, db, role="O&M Head", name="AW Head", email="aw-head@example.com")
    _plants(client)
    response = _post(client, _upload([["x"]], headers=["Something else"]), dry_run=True)
    assert response.status_code == 422
    assert "Site code" in str(response.json())


# ── Export and scope ─────────────────────────────────────────────────────────

def test_the_register_exports_in_the_same_column_order_it_imports(client, db):
    login_user(client, db, role="O&M Head", name="AW Head", email="aw-head@example.com")
    _plants(client)
    _post(client, _upload([_row(), _row(site="AW02", equipment="Transformer T1", part="")]), dry_run=False)

    response = client.get("/api/asset-warranty/export")
    assert response.status_code == 200
    assert "no-store" in response.headers.get("cache-control", "")
    sheet = load_workbook(io.BytesIO(response.content), data_only=True)[sheets.SHEET]
    rows = [list(r) for r in sheet.iter_rows(values_only=True)]
    assert rows[0] == HEADERS, "an exported register must be re-uploadable"
    assert {r[2] for r in rows[1:]} == {"Inverter INV-03", "Transformer T1"}


def test_records_and_downloads_stay_inside_the_callers_plants(client, db):
    login_user(client, db, role="O&M Head", name="AW Head", email="aw-head@example.com")
    plants = _plants(client)
    _post(client, _upload([_row(), _row(site="AW02", equipment="Transformer T1", part="")]), dry_run=False)

    engineer = User(auth_provider="test", external_subject="aw-engineer", email="aw-engineer@example.com",
                    display_name="AW Engineer", role="Site Engineer", is_active=True)
    db.add(engineer)
    db.commit()
    db.refresh(engineer)
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=__import__("uuid").UUID(plants[0]["id"]),
                               assignment_role="Site Engineer"))
    db.commit()
    from tests import conftest
    conftest._CURRENT_USER = db.get(User, engineer.id)

    listing = client.get("/api/asset-warranty").json()
    assert {row["siteCode"] for row in listing["records"]} == {"AW01"}
    assert client.get("/api/asset-warranty/export?site_code=AW02").status_code == 403
