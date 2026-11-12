"""Preventive Maintenance / Health scope, the Liasoning record and the fit-the-frame table CSS."""
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import select

from app.core.models import Plant, PlantResponsibility, User, UserPlantAssignment
from app.core.security import visible_custom_fields
from app.portal.service import plant_out
from tests.conftest import login_user

ROOT = Path(__file__).resolve().parents[1]


def _plant(db, code):
    plant = Plant(site_code=code, plant_name=f"{code} Plant")
    db.add(plant)
    db.commit()
    db.refresh(plant)
    return plant


def _person(db, name, email, role="Assignee"):
    user = User(display_name=name, email=email, role=role, is_active=True, auth_provider="test",
                external_subject=f"test:{email}")
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _put_access(client, user, **body):
    body.setdefault("role", "Assignee")
    return client.put(f"/api/users/{user.id}/access", json=body)


def test_pm_and_health_scope_is_saved_listed_and_one_assignee_per_plant(client, db):
    alpha, bravo = _plant(db, "ALPHA"), _plant(db, "BRAVO")
    ravi, mina = _person(db, "Ravi", "ravi@example.com"), _person(db, "Mina", "mina@example.com")
    login_user(client, db, role="O&M Head")

    r = _put_access(client, ravi, plant_ids=[str(alpha.id)], pm_plant_ids=[str(alpha.id), str(bravo.id)],
                    health_plant_ids=[str(bravo.id)])
    assert r.status_code == 200, r.text
    # the chosen plants are added to plant access too
    assert set(db.scalars(select(UserPlantAssignment.plant_id).where(UserPlantAssignment.user_id == ravi.id))) == {alpha.id, bravo.id}

    listed = {u["email"]: u for u in client.get("/api/users").json()}
    assert set(listed["ravi@example.com"]["pm_plant_ids"]) == {str(alpha.id), str(bravo.id)}
    assert listed["ravi@example.com"]["health_plant_ids"] == [str(bravo.id)]

    # Mina takes over BRAVO's PM; Ravi keeps ALPHA only. One Assignee per plant per area.
    assert _put_access(client, mina, plant_ids=[str(bravo.id)], pm_plant_ids=[str(bravo.id)]).status_code == 200
    db.expire_all()
    rows = {(r.plant_id, r.area): r.assigned_user_id for r in db.scalars(select(PlantResponsibility))}
    assert rows[(alpha.id, "pm")] == ravi.id and rows[(bravo.id, "pm")] == mina.id
    assert rows[(bravo.id, "health")] == ravi.id

    # The plant Details data names them.
    plants = {p["site_code"]: p for p in client.get("/api/portal/plants").json()["plants"]}
    assert plants["ALPHA"]["pm_assignee"] == "Ravi" and plants["BRAVO"]["pm_assignee"] == "Mina"
    assert plants["BRAVO"]["health_assignee"] == "Ravi" and plants["ALPHA"]["health_assignee"] == ""

    # Saving the same person with empty lists releases their plants.
    assert _put_access(client, ravi, plant_ids=[str(alpha.id)]).status_code == 200
    db.expire_all()
    assert not [r for r in db.scalars(select(PlantResponsibility)) if r.assigned_user_id == ravi.id]


def test_pm_health_scope_is_only_for_assignees(client, db):
    alpha = _plant(db, "ALPHA")
    engineer = _person(db, "Eng", "eng@example.com", role="Site Engineer")
    login_user(client, db, role="O&M Head")
    r = _put_access(client, engineer, role="Site Engineer", plant_ids=[str(alpha.id)], pm_plant_ids=[str(alpha.id)])
    assert r.status_code == 422


def test_pm_health_scope_cannot_be_set_by_a_non_head(client, db):
    alpha = _plant(db, "ALPHA")
    ravi = _person(db, "Ravi", "ravi@example.com")
    login_user(client, db, role="Assignee")
    assert _put_access(client, ravi, plant_ids=[str(alpha.id)], pm_plant_ids=[str(alpha.id)]).status_code == 403


def test_liasoning_record_is_redacted_for_roles_that_may_not_open_links():
    fields = {"liasoning": {"land_lease_url": "https://x.example.invalid/a"},
              "design_link": "https://x.example.invalid/d", "cctv_url": "c"}
    for role in ("O&M Head", "Assignee", "Administration"):
        assert visible_custom_fields(fields, SimpleNamespace(role=role, is_active=True)) == fields
    out = visible_custom_fields(fields, SimpleNamespace(role="Site Engineer", is_active=True))
    assert "liasoning" not in out and "design_link" not in out and out["cctv_url"] == "c"
    assert "liasoning" in fields                                    # the stored value is untouched


def test_plant_out_carries_pm_and_health_assignee_names():
    plant = SimpleNamespace(
        id="p1", site_code="A1", plant_name="A", project_company=None, district=None, discom=None, location=None,
        latitude=None, longitude=None, dc_capacity_kw=None, ac_capacity_kw=None, commissioned_on=None,
        status="active", assigned_engineer=None, custom_fields={})
    head = SimpleNamespace(role="O&M Head", is_active=True)
    out = plant_out(plant, [], "", head, {"pm": "Ravi", "health": "Mina"})
    assert out["pm_assignee"] == "Ravi" and out["health_assignee"] == "Mina"
    assert plant_out(plant, [], "", head)["pm_assignee"] == ""


def test_liasoning_page_has_the_requested_columns_and_is_wired():
    module = (ROOT / "assets" / "js" / "liasoning.js").read_text(encoding="utf-8")
    labels = ["Site Code", "LOA", "PPA", "Tariff", "Registered Land Lease", "Commissioning Documents"]
    positions = [module.index(f'label: "{label}"') for label in labels]
    assert positions == sorted(positions)                           # in the requested order
    table = (ROOT / "assets" / "js" / "plants-table.js").read_text(encoding="utf-8")
    assert 'detailSection === "liasoning" && global.Solar91PortalLiasoning' in table
    page = (ROOT / "frontend" / "templates" / "index.html").read_text(encoding="utf-8")
    assert "/assets/js/liasoning.js" in page and "/assets/css/liasoning.css" in page
    assert "custom_fields" in module and "plants.manage" in module  # saved through the existing plant PATCH


def test_data_tables_fit_the_frame_without_a_desktop_minimum_width():
    components = (ROOT / "assets" / "css" / "components.css").read_text(encoding="utf-8")
    assert "width: 100%; min-width: 0; table-layout: fixed" in components     # Details table
    design = (ROOT / "assets" / "css" / "design.css").read_text(encoding="utf-8")
    assert ".is-portfolio { table-layout: fixed; min-width: 0; width: 100%; }" in design
    settings = (ROOT / "assets" / "css" / "settings.css").read_text(encoding="utf-8")
    assert ".ep-settings__table {\n  min-width: 0;" in settings
