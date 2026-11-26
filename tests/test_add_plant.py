"""Plant record creation/editing: Info page controls and API permissions.

The button sits next to the Info page's search box and is offered to O&M Heads and Assignees.
The API enforces the same permissions, while deleting plant records remains O&M Head-only.
Everything the overlay collects is a column of the plant record itself; the Cleaning, PM and
Health Assignee columns stay in Login access, where they are configured.
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
    "address": "Plot 14, Solar Park Road, Jodhpur, Rajasthan",
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
    assert body["address"] == FULL["address"]
    assert body["custom_fields"]["cctv_url"] == "https://cctv.example.invalid/new01"
    assert float(body["dc_capacity_kw"]) == 3158.82

    # It is a real catalogue row, so it is in the portal's plant list straight away.
    row = db.scalar(select(Plant).where(Plant.site_code == "NEW01"))
    assert row is not None and row.supervisor == "Site Supervisor"
    assert "NEW01" in client.get("/api/portal/plants").text

    # The same code twice is refused rather than silently duplicated.
    assert client.post("/api/plants", json=FULL).status_code == 409


def test_plant_can_be_created_without_supervisor_or_cctv_link(client, db):
    login_user(client, db, role="O&M Head", email="add-optional-fields@example.com")

    created = client.post("/api/plants", json=dict(FULL, site_code="OPT01", supervisor=None, custom_fields={}))
    assert created.status_code == 201, created.text
    assert created.json()["supervisor"] is None
    assert created.json()["custom_fields"].get("cctv_url") is None
    row = db.scalar(select(Plant).where(Plant.site_code == "OPT01"))
    assert row is not None and row.supervisor is None


def test_head_and_assignee_may_create_and_edit_plants_but_other_roles_may_not(client, db):
    plant = Plant(site_code="EXI01", plant_name="Existing")
    db.add(plant)
    db.commit()

    assignee = login_user(client, db, role="Assignee", email="add-assignee@example.com")
    db.add(UserPlantAssignment(user_id=assignee.id, plant_id=plant.id, assignment_role="Assignee"))
    db.commit()
    created = client.post("/api/plants", json=dict(FULL, site_code="ASG01"))
    assert created.status_code == 201, created.text
    assert db.scalar(select(Plant).where(Plant.site_code == "ASG01")) is not None
    # Assignees can edit plant fields, but cannot delete plant records.
    plant_id = created.json()["id"]
    updated = client.patch(f"/api/plants/{plant_id}", json={"district": "Changed"})
    assert updated.status_code == 200, updated.text
    assert updated.json()["district"] == "Changed"
    assert client.delete(f"/api/plants/{plant_id}").status_code == 403

    engineer = login_user(client, db, role="Site Engineer", email="add-engineer@example.com")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id))
    db.commit()
    assert client.post("/api/plants", json=dict(FULL, site_code="SEN01")).status_code == 403
    assert client.patch(f"/api/plants/{plant_id}", json={"district": "No access"}).status_code == 403

    login_user(client, db, role="Administration", email="add-admin@example.com")
    assert client.post("/api/plants", json=dict(FULL, site_code="ADM01")).status_code == 403
    assert client.patch(f"/api/plants/{plant_id}", json={"district": "No access"}).status_code == 403
    assert db.scalar(select(Plant).where(Plant.site_code.in_(("SEN01", "ADM01")))) is None


def test_an_invalid_plant_is_refused_by_the_api_not_only_by_the_form(client, db):
    login_user(client, db, role="O&M Head", email="add-invalid@example.com")

    assert client.post("/api/plants", json=dict(FULL, site_code="BAD01", latitude=120)).status_code == 422
    assert client.post("/api/plants", json=dict(FULL, site_code="BAD02", longitude=-200)).status_code == 422
    assert client.post("/api/plants", json={"plant_name": "No code"}).status_code == 422
    assert client.post("/api/plants", json=dict(FULL, site_code="NOADDR", address="   ")).status_code == 422
    missing_address = dict(FULL)
    missing_address.pop("address")
    assert client.post("/api/plants", json=missing_address).status_code == 422
    assert client.post("/api/plants", json=dict(FULL, site_code="BAD03", supervisor="x" * 161)).status_code == 422


# ── the button and its overlay ─────────────────────────────────────────────


def test_the_button_sits_with_the_search_box_and_is_offered_to_heads_and_assignees():
    table = TABLE.read_text(encoding="utf-8")

    toolbar = table[table.index('ep-pt__toolbar'):table.index("// ─── Render")]
    assert "data-pt-search" in toolbar and "data-pt-add" in toolbar, "the button belongs on the toolbar"
    assert '+ Add New Plant' in toolbar
    # Offered to O&M Heads and Assignees, and only on the all-plants Info table.
    assert 'canCreatePlant() && mode.kind === "all"' in toolbar
    assert '["O&M Head", "Assignee"].indexOf(user.role) !== -1' in table
    assert "function canEdit() {\n    return canCreatePlant();" in table
    # Clicking it opens the shared editor module's create overlay and re-reads the catalogue.
    assert "global.Solar91PortalPlantEditor.create(" in table
    wiring = table[table.index('container.querySelector("[data-pt-add]")'):]
    assert "loadPromise = null;" in wiring


def test_the_overlay_collects_every_plant_column_and_requires_all_of_them():
    editor = EDITOR.read_text(encoding="utf-8")

    fields = editor[editor.index("var CREATE_FIELDS = ["):editor.index("function createFieldHTML(")]
    for key in ("site_code", "plant_name", "project_company", "ac_capacity_kw", "dc_capacity_kw",
                "district", "discom", "assigned_engineer", "supervisor", "commissioned_on",
                "address", "latitude", "longitude", "cctv_url", "status"):
        assert '"' + key + '"' in fields, "missing field: " + key
    # The CCTV link is a custom field, not a column.
    assert '{ key: "cctv_url",        label: "CCTV link",             type: "url",    custom: true, optional: true,' in fields
    assert '{ key: "supervisor",      label: "Supervisor",            type: "text", optional: true }' in fields
    # The address is required; Supervisor and CCTV link remain optional.
    markup = editor[editor.index("function createFieldHTML("):editor.index("function openCreate(")]
    assert 'field.optional !== true' in markup
    assert 'required ? " required" : ""' in markup
    assert '{ key: "address",         label: "Location",              type: "text", hint: "Full plant address" }' in fields
    create = editor[editor.index("function openCreate("):editor.index("var PlantEditor = {")]
    assert 'if (field.optional) return;' in create
    assert 'problem = field.label + " is required."' in create
    # Role gate on the client too, and the overlay's own guards.
    assert '["O&M Head", "Assignee"].indexOf(user.role) === -1' in create
    assert "Math.abs(num) > 90" in create and "Math.abs(num) > 180" in create
    assert "if (saving) return;" in create, "a double submission must not create two plants"
    edit = editor[editor.index("open: function (plant, onSaved) {"):]
    assert '["O&M Head", "Assignee"].indexOf(user.role) === -1' in edit


def test_the_plant_is_announced_only_after_the_server_confirms_it():
    editor = EDITOR.read_text(encoding="utf-8")
    create = editor[editor.index("function openCreate("):editor.index("var PlantEditor = {")]

    send = create.index('global.Solar91PortalAPI.request("/api/plants", { method: "POST"')
    after = create[send:]
    # Only a confirmed create invalidates the overview and plant-list caches.
    assert after.index(".then(function (plant) {") < after.index("refreshPlantViews();")
    refresh = editor[editor.index("function refreshPlantViews()"):editor.index("function openCreate(")]
    assert "data.invalidate(true);" in refresh
    assert "global.Solar91PortalAPI.plants(true)" in refresh
    assert 'typeof nav.loadPlants === "function" ? nav.loadPlants() : undefined' in refresh
    # A refresh error must not tell the user that the already-saved plant failed to create.
    assert 'Plant added, but portal refresh failed' in after
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
