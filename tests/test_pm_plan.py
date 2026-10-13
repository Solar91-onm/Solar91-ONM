from __future__ import annotations

import io
from datetime import date

from openpyxl import Workbook

from app.core.models import Equipment, OMTask, PMTemplate, Plant
from tests.conftest import login_user


def _plant(db, code="KRN_01", name="Kerli"):
    p = Plant(site_code=code, plant_name=name)
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def _quick(**over):
    body = {"equipment_type": "Inverter", "task_name": "Clean fans", "frequency": "Monthly", "safety": "PTW + LOTO required",
            "est_hours": 2, "plants": ["KRN_01"], "start_date": date.today().isoformat(), "assignees": [], "per_unit": True}
    body.update(over)
    return body


def test_quick_add_one_task_per_register_unit(client, db):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    db.add(Equipment(plant_id=plant.id, equipment_code="INV-01", equipment_name="Inverter 1", equipment_type="Inverter"))
    db.add(Equipment(plant_id=plant.id, equipment_code="INV-02", equipment_name="Inverter 2", equipment_type="Inverter"))
    db.commit()
    dry = client.post("/api/pm-plan/tasks", json=_quick(dry_run=True)).json()
    assert dry["count"] == 2 and db.query(OMTask).count() == 0
    done = client.post("/api/pm-plan/tasks", json=_quick()).json()
    assert done["count"] == 2
    names = sorted(t.task_name for t in db.query(OMTask).all())
    assert names == ["Clean fans", "Clean fans"]
    again = client.post("/api/pm-plan/tasks", json=_quick()).json()   # re-run is safe
    assert again["count"] == 0 and again["skipped"] == 2


def test_units_hint_used_when_register_empty(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db)
    res = client.post("/api/pm-plan/tasks", json=_quick(units=3)).json()
    assert res["count"] == 3
    assert db.query(OMTask).filter(OMTask.task_name == "Clean fans").count() == 3


def test_template_apply_and_save(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db)
    saved = client.post("/api/pm-plan/tasks", json=_quick(save_template=True, per_unit=False,
                        checks=[{"name": "Heatsink temperature", "unit": "C", "max": 75}])).json()
    assert saved["count"] == 1 and db.query(PMTemplate).count() == 1
    task = db.query(OMTask).one()
    assert "Heatsink temperature" in (task.sop or "")


def test_one_job_stores_equipment_register_quantity(client, db):
    login_user(client, db, role="O&M Head")
    plant=_plant(db)
    db.add_all([
        Equipment(plant_id=plant.id,equipment_code="INV-01",equipment_name="Inverter 1",equipment_type="Inverter",quantity=8),
        Equipment(plant_id=plant.id,equipment_code="INV-02",equipment_name="Inverter 2",equipment_type="Inverter",quantity=4),
    ])
    db.commit()
    response=client.post("/api/pm-plan/tasks",json=_quick(per_unit=False))
    assert response.status_code==200,response.text
    task=db.query(OMTask).one()
    assert task.unit_no is None and task.quantity==12


def test_site_engineer_cannot_add(client, db):
    login_user(client, db, role="Site Engineer", email="se@example.com")
    _plant(db)
    assert client.post("/api/pm-plan/tasks", json=_quick()).status_code == 403


def _xlsx(rows):
    wb = Workbook()
    ws = wb.active
    ws.title = "PM Tasks"
    ws.append(["Equipment type", "Plant(s)", "Task – what to do", "Frequency – when", "Safety needed", "Est. time (hours)", "No. of units"])
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_excel_import_rejects_number_as_equipment_type(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db)
    data = _xlsx([[9, "KRN_01", "Clean fans", "Monthly", "PTW required", 2, None]])
    r = client.post("/api/pm-plan/import?dry_run=true", files={"file": ("p.xlsx", data)})
    assert r.status_code == 422
    assert "number" in str(r.json())


def test_excel_import_dry_run_then_commit(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db)
    data = _xlsx([["Inverter", "KRN_01", "Clean fans", "Monthly", "PTW required", 2, 4],
                  ["Transformer", None, "Oil level check", "Quarterly", None, 1, None]])
    pre = client.post("/api/pm-plan/import?dry_run=true", files={"file": ("p.xlsx", data)}).json()
    assert pre["tasks"] == 4 and pre["template_only_rows"] == 1 and db.query(OMTask).count() == 0
    done = client.post("/api/pm-plan/import?dry_run=false", files={"file": ("p.xlsx", data)}).json()
    assert done["tasks"] == 4
    assert db.query(OMTask).count() == 4 and db.query(PMTemplate).count() == 2
