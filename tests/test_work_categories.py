"""The work-category list: what replaced the per-asset equipment register.

It ships empty and is filled either in Supabase or from the portal
(Settings -> Categories). These tests pin that contract.
"""
from __future__ import annotations

from app.core.models import Issue, OMTask, Plant, WorkCategory
from tests import conftest
from tests.conftest import grant_assignee_plants, login_user

BASE = "/api/categories"


def _plant(db, code="CAT01", name="Category Plant"):
    plant = Plant(site_code=code, plant_name=name)
    db.add(plant)
    db.commit()
    db.refresh(plant)
    return plant


def test_the_list_starts_empty(client, db):
    login_user(client, db)
    body = client.get(BASE).json()
    assert body["categories"] == []
    assert body["configured"] is False
    assert body["can_edit"] is True


def test_head_adds_a_category_with_sub_problems_and_unit_count(client, db):
    login_user(client, db)
    created = client.post(BASE, json={
        "name": "  Inverter  ", "code": "INV", "default_units": 8, "area": "Plant side",
        "sub_problems": ["Fan failure", " IGBT fault ", "Fan failure", ""],
    })
    assert created.status_code == 201, created.text
    row = created.json()
    assert row["name"] == "Inverter"                      # trimmed
    assert row["sub_problems"] == ["Fan failure", "IGBT fault"]   # de-duplicated, blanks dropped
    assert (row["default_units"], row["area"], row["code"]) == (8, "Plant side", "INV")

    listed = client.get(BASE).json()
    assert [c["name"] for c in listed["categories"]] == ["Inverter"]
    assert listed["configured"] is True


def test_a_duplicate_name_is_refused_whatever_the_case(client, db):
    login_user(client, db)
    assert client.post(BASE, json={"name": "Transformer"}).status_code == 201
    clash = client.post(BASE, json={"name": "  transformer "})
    assert clash.status_code == 409, clash.text
    assert db.query(WorkCategory).count() == 1


def test_an_assignee_may_maintain_the_list_and_others_may_only_read_it(client, db):
    plant = _plant(db)
    login_user(client, db)
    client.post(BASE, json={"name": "Module"})

    assignee = login_user(client, db, role="Assignee", name="Team", email="cat-assignee@example.com")
    grant_assignee_plants(db, assignee.id, plant.id)
    added = client.post(BASE, json={"name": "RMS", "sub_problems": ["Communication loss"]})
    assert added.status_code == 201, added.text

    engineer = login_user(client, db, role="Site Engineer", name="Eng", email="cat-eng@example.com")
    conftest._CURRENT_USER = engineer
    readable = client.get(BASE)
    assert readable.status_code == 200
    assert {c["name"] for c in readable.json()["categories"]} == {"Module", "RMS"}
    assert readable.json()["can_edit"] is False
    assert client.post(BASE, json={"name": "Nope"}).status_code == 403


def test_a_category_in_use_is_deactivated_rather_than_deleted(client, db):
    plant = _plant(db)
    login_user(client, db)
    unused = client.post(BASE, json={"name": "CCTV"}).json()
    used = client.post(BASE, json={"name": "Inverter"}).json()
    db.add(Issue(ticket_no="CAT-1", plant_id=plant.id, vertical="Inverter",
                 description="Inverter fault", severity="Medium"))
    db.commit()

    # the list reports how many records reference each category
    counts = {c["name"]: c["in_use"] for c in client.get(BASE).json()["categories"]}
    assert counts == {"CCTV": 0, "Inverter": 1}

    assert client.delete(f"{BASE}/{unused['id']}").status_code == 204
    assert client.delete(f"{BASE}/{used['id']}").status_code == 204
    db.expire_all()
    assert db.query(WorkCategory).filter_by(name="CCTV").count() == 0
    kept = db.query(WorkCategory).filter_by(name="Inverter").one()
    assert kept.active is False, "a category a ticket already uses stays readable"
    # the ticket still reads the way it was raised
    assert db.query(Issue).one().vertical == "Inverter"


def test_pm_work_counts_towards_usage_too(client, db):
    plant = _plant(db)
    login_user(client, db)
    client.post(BASE, json={"name": "Transformer"})
    db.add(OMTask(work_order_no="CAT-WO-1", plant_id=plant.id, task_name="Oil test",
                  task_type="Transformer", status="Scheduled"))
    db.commit()
    assert client.get(BASE).json()["categories"][0]["in_use"] == 1


def test_bulk_import_loads_a_prepared_list(client, db):
    login_user(client, db)
    body = client.post(f"{BASE}/import", json={"categories": [
        {"name": "Inverter", "code": "INV", "default_units": 8,
         "sub_problems": ["Fan failure", "IGBT fault"]},
        {"name": "Module", "code": "MOD", "default_units": 2400, "sub_problems": ["Hotspot"]},
        {"name": "ACDB", "code": "ACDB"},
    ]})
    assert body.status_code == 200, body.text
    assert body.json() == {"created": 3, "updated": 0, "total": 3}
    # imported in the order given
    assert [c["name"] for c in client.get(BASE).json()["categories"]] == ["Inverter", "Module", "ACDB"]

    # re-importing updates in place rather than duplicating
    again = client.post(f"{BASE}/import", json={"categories": [
        {"name": "inverter", "sub_problems": ["Fan failure", "Derating"]},
    ]})
    assert again.json() == {"created": 0, "updated": 1, "total": 1}
    inverter = next(c for c in client.get(BASE).json()["categories"] if c["name"].casefold() == "inverter")
    assert inverter["sub_problems"] == ["Fan failure", "Derating"]
    assert db.query(WorkCategory).count() == 3


def test_replace_import_keeps_categories_that_records_depend_on(client, db):
    plant = _plant(db)
    login_user(client, db)
    client.post(f"{BASE}/import", json={"categories": [{"name": "Inverter"}, {"name": "Stale"}]})
    db.add(Issue(ticket_no="CAT-2", plant_id=plant.id, vertical="Inverter",
                 description="In use", severity="Medium"))
    db.commit()

    client.post(f"{BASE}/import", json={"categories": [{"name": "Module"}], "replace": True})
    db.expire_all()
    rows = {row.name: row.active for row in db.query(WorkCategory)}
    assert rows.get("Module") is True
    assert "Stale" not in rows, "an unused category is dropped by a replace"
    assert rows.get("Inverter") is False, "one a ticket uses is kept, deactivated"


def test_the_issue_importer_rejects_a_category_that_is_not_configured(client, db):
    plant = _plant(db, "CATIMP", "Importer Plant")
    login_user(client, db)
    head = "Site code,Issue category,Problem,Description,Severity,Occurred on,Target date,Assignee email\n"
    files = {"file": ("issues.csv", (head + f"{plant.site_code},Inverter,,Fault,Medium,,,\n").encode(), "text/csv")}

    # nothing configured yet: the upload says so instead of inventing a category
    empty = client.post("/api/issues/import?dry_run=true", files=files).json()
    assert "No issue categories are configured" in " ".join(empty["problems"][0]["errors"])

    client.post(BASE, json={"name": "Inverter"})
    files = {"file": ("issues.csv", (head + f"{plant.site_code},Inverter,,Fault,Medium,,,\n").encode(), "text/csv")}
    ok = client.post("/api/issues/import?dry_run=true", files=files).json()
    assert ok["problems"] == [] and ok["new"] == 1
