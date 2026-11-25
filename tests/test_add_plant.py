"""Add New Plant: the Info page's button, its overlay, and who the API lets create a plant.

The button sits next to the Info page's search box and is offered only to the role that may
manage plants (O&M Head). The API enforces the same thing, so hiding the button is never what
keeps anyone out. Everything the overlay collects is a column of the plant record itself; the
Cleaning, PM and Health Assignee columns stay in Login access, where they are configured.
"""
from __future__ import annotations

from pathlib import Path

from sqlalchemy import select

from app.core.models import Plant, UserPlantAssignment
from tests.conftest import login_user

ROOT = Path(__file__).resolve().parents[1]
TABLE = ROOT / "assets" / "js" / "plants-table.js"
EDITOR = ROOT / "assets" / "js" / "plant-details.js"

FULL = {
    "site_code": "NEW01",
    "plant_name": "New Plant",
    "project_company": "Solar91 Project Fifty Private Limited",
    "ac_capacity_kw": 2520,
    "dc_capacity_kw": 3158.82,
    "district": "Jodhpur",
    "discom": "JDVVNL",
    "assigned_engineer": "Ratan Jani",
    "supervisor": "Site Supervisor",
    "commissioned_on": "2026-05-22",
    "location": "Jodhpur, Rajasthan",
    "latitude": 26.2389,
    "longitude": 73.0243,
    "status": "active",
    "custom_fields": {"cctv_url": "https://cctv.example.invalid/new01"},
}


def test_a_head_creates_a_plant_with_every_column_the_info_page_shows(client, db):
    login_user(client, db, role="O&M Head", email="add-head@example.com")

    created = client.post("/api/plants", json=FULL)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["site_code"] == "NEW01"
    assert body["supervisor"] == "Site Supervisor", "the supervisor column must not be dropped"
    assert body["assigned_engineer"] == "Ratan Jani"
    assert body["custom_fields"]["cctv_url"] == "https://cctv.example.invalid/new01"
    assert float(body["dc_capacity_kw"]) == 3158.82

    # It is a real catalogue row, so it is in the portal's plant list straight away.
    row = db.scalar(select(Plant).where(Plant.site_code == "NEW01"))
    assert row is not None and row.supervisor == "Site Supervisor"
    assert "NEW01" in client.get("/api/portal/plants").text

    # The same code twice is refused rather than silently duplicated.
    assert client.post("/api/plants", json=FULL).status_code == 409


def test_only_the_head_may_create_a_plant(client, db):
    plant = Plant(site_code="EXI01", plant_name="Existing")
    db.add(plant)
    db.commit()

    assignee = login_user(client, db, role="Assignee", email="add-assignee@example.com")
    db.add(UserPlantAssignment(user_id=assignee.id, plant_id=plant.id, assignment_role="Assignee"))
    db.commit()
    refused = client.post("/api/plants", json=dict(FULL, site_code="ASG01"))
    assert refused.status_code == 403, refused.text

    engineer = login_user(client, db, role="Site Engineer", email="add-engineer@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id))
    db.commit()
    assert client.post("/api/plants", json=dict(FULL, site_code="SEN01")).status_code == 403

    login_user(client, db, role="Administration", email="add-admin@example.com")
    assert client.post("/api/plants", json=dict(FULL, site_code="ADM01")).status_code == 403
    assert db.scalar(select(Plant).where(Plant.site_code.in_(("ASG01", "SEN01", "ADM01")))) is None


def test_an_invalid_plant_is_refused_by_the_api_not_only_by_the_form(client, db):
    login_user(client, db, role="O&M Head", email="add-invalid@example.com")

    assert client.post("/api/plants", json=dict(FULL, site_code="BAD01", latitude=120)).status_code == 422
    assert client.post("/api/plants", json=dict(FULL, site_code="BAD02", longitude=-200)).status_code == 422
    assert client.post("/api/plants", json={"plant_name": "No code"}).status_code == 422
    assert client.post("/api/plants", json=dict(FULL, site_code="BAD03", supervisor="x" * 161)).status_code == 422


# ── the button and its overlay ─────────────────────────────────────────────


def test_the_button_sits_with_the_search_box_and_only_for_the_role_that_may_use_it():
    table = TABLE.read_text(encoding="utf-8")

    toolbar = table[table.index('ep-pt__toolbar'):table.index("// ─── Render")]
    assert "data-pt-search" in toolbar and "data-pt-add" in toolbar, "the button belongs on the toolbar"
    assert '+ Add New Plant' in toolbar
    # Offered to the role that may manage plants, and only on the all-plants Info table.
    assert 'canEdit() && mode.kind === "all"' in toolbar
    assert 'function canEdit() {\n    return !!(global.Solar91PortalAPI && global.Solar91PortalAPI.can("plants.manage"));' in table
    # Clicking it opens the shared editor module's create overlay and re-reads the catalogue.
    assert "global.Solar91PortalPlantEditor.create(" in table
    wiring = table[table.index('container.querySelector("[data-pt-add]")'):]
    assert "loadPromise = null;" in wiring


def test_the_overlay_collects_every_plant_column_and_requires_all_of_them():
    editor = EDITOR.read_text(encoding="utf-8")

    fields = editor[editor.index("var CREATE_FIELDS = ["):editor.index("function createFieldHTML(")]
    for key in ("site_code", "plant_name", "project_company", "ac_capacity_kw", "dc_capacity_kw",
                "district", "discom", "assigned_engineer", "supervisor", "commissioned_on",
                "location", "latitude", "longitude", "cctv_url", "status"):
        assert '"' + key + '"' in fields, "missing field: " + key
    # The CCTV link is a custom field, not a column.
    assert '{ key: "cctv_url",        label: "CCTV link",             type: "url",    custom: true,' in fields
    # Every input is required, in the markup and again before anything is sent.
    markup = editor[editor.index("function createFieldHTML("):editor.index("function openCreate(")]
    assert 'required />' in markup and '<select name="' in markup and 'required>' in markup
    assert 'esc(field.label) + " *</span>"' in markup
    create = editor[editor.index("function openCreate("):editor.index("var PlantEditor = {")]
    assert 'if (!raw) { problem = field.label + " is required."; return; }' in create
    # Role gate on the client too, and the overlay's own guards.
    assert 'if (!global.Solar91PortalAPI.can("plants.manage")) return;' in create
    assert "Math.abs(num) > 90" in create and "Math.abs(num) > 180" in create
    assert "if (saving) return;" in create, "a double submission must not create two plants"


def test_the_plant_is_announced_only_after_the_server_confirms_it():
    editor = EDITOR.read_text(encoding="utf-8")
    create = editor[editor.index("function openCreate("):editor.index("var PlantEditor = {")]

    send = create.index('global.Solar91PortalAPI.request("/api/plants", { method: "POST"')
    after = create[send:]
    # Nothing is said or refreshed before the response: the success path is inside .then.
    assert after.index(".then(function (plant) {") < after.index("data.invalidate();")
    assert after.index("data.invalidate();") < after.index("Solar91PortalToast")
    # The new plant reaches the rest of the portal: cached reads dropped, sidebar reloaded.
    assert "global.Solar91PortalAPI.plants(true);" in after
    assert "global.Solar91PortalNav.loadPlants();" in after
    # A failure says so and leaves the form open with what was typed.
    assert 'errorEl.textContent = "Not added. "' in after
    assert 'Solar91PortalToast.error("Plant not added"' in after


def test_the_overlay_says_where_the_assignee_columns_are_configured():
    editor = EDITOR.read_text(encoding="utf-8")
    create = editor[editor.index("function openCreate("):editor.index("var PlantEditor = {")]

    assert "Cleaning, PM and Health Assignees" in create
    assert "Login access" in create
    # No assignee pickers here: those write Login access tables under their own permission.
    assert "washing_assignee" not in create and "pm_assignee" not in create
