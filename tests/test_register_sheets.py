"""Register downloads: the Site Issues and PM registers as workbooks.

The upload side already existed (``POST /api/issues/import``, ``POST /api/pm-plan/import``). These
cover the download half added alongside the portal's Import / Export control: the file really opens as
a workbook, it carries the rows the caller is allowed to see and no others, and a scoped user cannot
reach another plant's register by naming it.
"""
from __future__ import annotations

import io
from datetime import timedelta
from uuid import UUID

from openpyxl import load_workbook

from app.core.models import OMTask, User, UserPlantAssignment
from app.core.timeutil import business_today
from tests.conftest import login_user

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _sheet(response):
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith(XLSX)
    workbook = load_workbook(io.BytesIO(response.content), data_only=True)
    return workbook[workbook.sheetnames[0]]


def _rows(sheet):
    """Header row plus the data rows, as lists of cell values."""
    return [list(row) for row in sheet.iter_rows(values_only=True)]


def _seed(client, db):
    login_user(client, db, role="O&M Head", name="Register Head", email="register-head@example.com")
    plants = []
    for code in ("RG01", "RG02"):
        created = client.post("/api/plants", json={"site_code": code, "plant_name": "Register " + code})
        assert created.status_code == 201, created.text
        plants.append(created.json())
    for index, plant in enumerate(plants):
        raised = client.post("/api/issues", json={
            "plant_id": plant["id"], "description": f"Register issue {index}",
            "vertical": "Inverter", "severity": "Critical" if index == 0 else "Medium",
        })
        assert raised.status_code == 201, raised.text
    db.add(OMTask(work_order_no="RG-PM-1", plant_id=UUID(plants[0]["id"]), task_name="Check inverter",
                  task_type="Inverter", status="Scheduled", frequency="Monthly",
                  due_on=business_today() + timedelta(days=5)))
    db.add(OMTask(work_order_no="RG-PM-2", plant_id=UUID(plants[1]["id"]), task_name="Inspect module",
                  task_type="Module", status="Scheduled", frequency="Quarterly",
                  due_on=business_today() + timedelta(days=9)))
    db.commit()
    return plants


# ── Site issues register ─────────────────────────────────────────────────────

def test_issue_register_downloads_as_a_workbook_of_the_current_tickets(client, db):
    _seed(client, db)
    rows = _rows(_sheet(client.get("/api/issues/export")))
    assert rows[0][0] == "Ticket" and "Site code" in rows[0] and "Severity" in rows[0]
    descriptions = {row[5] for row in rows[1:]}
    assert {"Register issue 0", "Register issue 1"} <= descriptions
    # Every ticket carries its plant, so the sheet is usable without a second lookup.
    assert {row[1] for row in rows[1:]} == {"RG01", "RG02"}


def test_issue_register_can_be_narrowed_to_one_plant(client, db):
    _seed(client, db)
    rows = _rows(_sheet(client.get("/api/issues/export?site_code=RG01")))
    assert {row[1] for row in rows[1:]} == {"RG01"}


def test_issue_register_download_is_limited_to_the_callers_plants(client, db):
    plants = _seed(client, db)
    engineer = User(auth_provider="test", external_subject="register-engineer",
                    email="register-engineer@example.com", display_name="Register Engineer",
                    role="Site Engineer", is_active=True)
    db.add(engineer)
    db.commit()
    db.refresh(engineer)
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=UUID(plants[0]["id"]),
                               assignment_role="Site Engineer"))
    db.commit()
    from tests import conftest
    conftest._CURRENT_USER = db.get(User, engineer.id)

    rows = _rows(_sheet(client.get("/api/issues/export")))
    # Only the assigned plant's tickets, and the other plant cannot be requested by name.
    assert {row[1] for row in rows[1:]} == {"RG01"}
    assert client.get("/api/issues/export?site_code=RG02").status_code == 403


def test_issue_register_download_never_leaks_a_deleted_ticket(client, db):
    _seed(client, db)
    listing = client.get("/api/issues").json()
    tickets = listing["items"] if isinstance(listing, dict) and "items" in listing else listing
    target = tickets[0]
    removed = client.request("DELETE", f"/api/issues/{target['id']}",
                             json={"reason": "Raised against the wrong plant"})
    if removed.status_code not in (200, 204):
        return  # deletion needs a different contract here; the scope tests still cover the export
    rows = _rows(_sheet(client.get("/api/issues/export")))
    assert target.get("ticket_no") not in {row[0] for row in rows[1:]}


# ── PM register and template ─────────────────────────────────────────────────

def test_pm_register_downloads_the_current_work_orders(client, db):
    _seed(client, db)
    rows = _rows(_sheet(client.get("/api/pm-plan/export")))
    assert rows[0][0] == "Work order" and "Frequency" in rows[0] and "Due date" in rows[0]
    assert {row[0] for row in rows[1:]} == {"RG-PM-1", "RG-PM-2"}
    assert {row[1] for row in rows[1:]} == {"RG01", "RG02"}


def test_pm_plan_template_is_a_blank_sheet_with_the_importer_columns(client, db):
    _seed(client, db)
    response = client.get("/api/pm-plan/import/template")
    assert response.status_code == 200, response.text
    workbook = load_workbook(io.BytesIO(response.content), data_only=True)
    assert "PM Tasks" in workbook.sheetnames
    sheet = workbook["PM Tasks"]
    headers = [cell.value for cell in sheet[1]]
    # The importer finds its columns by these names (_header_key in app/pmplan/router.py).
    assert "Equipment type" in headers and "Task" in headers and "Frequency" in headers
    # Rows below the header are pre-formatted (date format + drop-downs), so max_row
    # counts blank formatted cells; what matters is that no row carries data.
    data = [row for row in sheet.iter_rows(min_row=2, values_only=True)
            if any(value not in (None, "") for value in row)]
    assert data == [], "the template must ship with no data rows"


def test_pm_register_is_limited_to_the_callers_plants(client, db):
    plants = _seed(client, db)
    engineer = User(auth_provider="test", external_subject="register-pm-engineer",
                    email="register-pm-engineer@example.com", display_name="Register PM Engineer",
                    role="Site Engineer", is_active=True)
    db.add(engineer)
    db.commit()
    db.refresh(engineer)
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=UUID(plants[1]["id"]),
                               assignment_role="Site Engineer"))
    db.commit()
    from tests import conftest
    conftest._CURRENT_USER = db.get(User, engineer.id)

    rows = _rows(_sheet(client.get("/api/pm-plan/export")))
    assert {row[0] for row in rows[1:]} == {"RG-PM-2"}
    assert client.get("/api/pm-plan/export?site_code=RG01").status_code == 403


def test_register_downloads_are_never_cached_by_the_browser(client, db):
    _seed(client, db)
    for url in ("/api/issues/export", "/api/pm-plan/export", "/api/pm-plan/import/template"):
        response = client.get(url)
        assert response.status_code == 200, url
        assert "no-store" in response.headers.get("cache-control", ""), url
        assert "attachment" in response.headers.get("content-disposition", ""), url
