"""Regression tests for the plant/unit-aware PM redesign and native CSV uploads."""
from app.core.models import Equipment, OMTask, Plant, PMUnitConfig
from tests.conftest import login_user


def plant(db, code="PM-A", name="Plant A"):
    value = Plant(site_code=code, plant_name=name)
    db.add(value)
    db.commit()
    db.refresh(value)
    return value


def csv_bytes(row, bom=False):
    payload = "Equipment type,Plant(s),Task - what to do,Frequency,No. of units,Units per day,Start date\r\n" + row
    return (("\ufeff" if bom else "") + payload).encode("utf-8")


def test_csv_dry_run_then_commit_with_unit_quantities(client, db):
    login_user(client, db, role="O&M Head")
    plant(db)
    payload = csv_bytes('Inverter,PM-A,"Inspect, clean and test",Monthly,3,2,2026-11-02\r\n', bom=True)
    pre = client.post("/api/pm-plan/import?dry_run=true", files={"file": ("plan.csv", payload, "text/csv")})
    assert pre.status_code == 200, pre.text
    assert pre.json()["tasks"] == 3
    assert db.query(OMTask).count() == 0
    done = client.post("/api/pm-plan/import?dry_run=false", files={"file": ("plan.csv", payload, "text/csv")})
    assert done.status_code == 200, done.text
    assert done.json()["tasks"] == 3
    assert sorted(t.unit_no for t in db.query(OMTask).all()) == [1, 2, 3]


def test_csv_validation_never_partially_creates_tasks(client, db):
    login_user(client, db, role="O&M Head")
    plant(db)
    payload = csv_bytes('Inverter,PM-A,Clean,Monthly,2,1,2026-11-01\nUnknown,PM-A,Test,Monthly,2,1,2026-11-01\n')
    r = client.post("/api/pm-plan/import?dry_run=false", files={"file": ("plan.csv", payload)})
    assert r.status_code == 422
    assert db.query(OMTask).count() == 0


def test_csv_utf8_and_required_headers(client, db):
    login_user(client, db, role="O&M Head")
    assert client.post("/api/pm-plan/import", files={"file": ("x.csv", b"Name,Date\nX,2026-11-01")}).status_code == 422
    assert client.post("/api/pm-plan/import", files={"file": ("x.csv", b"\xff\xff")}).status_code == 422


def test_pm_unit_inventory_is_scoped_for_site_engineer(client, db):
    login_user(client, db, role="Site Engineer")
    assert client.get("/api/pm-plan/unit-config").status_code == 403


def test_pm_inventory_includes_equipment_without_scheduled_tasks(client, db):
    login_user(client, db, role="O&M Head")
    p = plant(db)
    db.add(Equipment(plant_id=p.id, equipment_code="TRANSFORMERS", equipment_name="Transformers", equipment_type="Transformer", quantity=7))
    db.commit()
    r = client.get("/api/pm-plan/unit-config")
    assert r.status_code == 200, r.text
    assert {"plant_id": str(p.id), "equipment_type": "Transformer", "units": 7, "critical": 0, "faulty": 0} in r.json()["register"]
    assert db.query(OMTask).count() == 0
