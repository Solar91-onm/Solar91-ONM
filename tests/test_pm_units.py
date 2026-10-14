from __future__ import annotations

from datetime import date, timedelta

from app.core.models import Notification, OMTask, PMTemplate, PMUnitConfig, Plant, User, UserEquipmentTypeAssignment
from app.pmplan.units import day_plan, distribute, run_daily
from tests.conftest import login_user


def _plant(db, code="KRN_01", name="Kerli"):
    p = Plant(site_code=code, plant_name=name)
    db.add(p); db.commit(); db.refresh(p)
    return p


def _body(**over):
    b = {"equipment_type": "Inverter", "task_name": "Inverter service", "frequency": "Monthly", "safety": "—", "est_hours": 2,
         "plants": ["KRN_01"], "start_date": date.today().isoformat(), "assignees": [], "per_unit": True}
    b.update(over)
    return b


def test_distribute_math():
    plan = distribute(list(range(1, 11)), 2, date(2026, 1, 1))
    assert [(n, d) for n, d, _ in plan][:4] == [(1, 1), (2, 1), (3, 2), (4, 2)]
    assert plan[-1] == (10, 5, date(2026, 1, 5))
    assert [p["units"] for p in day_plan([(n, due) for n, _, due in distribute([1, 2, 3], 2, date(2026, 1, 1))])] == [[1, 2], [3]]
    assert all(d == 1 for _, d, _ in distribute([1, 2, 3], None, date(2026, 1, 1)))


def test_units_spread_over_days(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db)
    res = client.post("/api/pm-plan/tasks", json=_body(total_units=10, units_per_day=2)).json()
    assert res["count"] == 10 and res["days"] == 5
    rows = db.query(OMTask).order_by(OMTask.unit_no).all()
    today = date.today()
    assert [(t.unit_no, t.due_on) for t in rows[:4]] == [(1, today), (2, today), (3, today + timedelta(days=1)), (4, today + timedelta(days=1))]
    assert rows[-1].due_on == today + timedelta(days=4) and rows[-1].cycle_day == 5
    assert {t.cycle_id for t in rows} and len({t.cycle_id for t in rows}) == 1 and rows[0].total_units == 10
    assert {t.task_name for t in rows} == {"Inverter service"}
    assert all(t.equipment_ref is None for t in rows)


def test_unit_subset_and_validation(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db)
    assert client.post("/api/pm-plan/tasks", json=_body(total_units=10, units_per_day=2, unit_numbers=[2, 5, 9], dry_run=True)).json()["count"] == 3
    assert client.post("/api/pm-plan/tasks", json=_body(total_units=4, units_per_day=2, unit_numbers=[7])).status_code == 422
    assert client.post("/api/pm-plan/tasks", json=_body(total_units=2, units_per_day=5)).status_code == 422


def test_plant_configuration_is_per_plant(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db, "A_01", "Plant A"); _plant(db, "B_01", "Plant B")
    for code, tot, per in (("A_01", 20, 4), ("B_01", 12, 2)):
        assert client.put("/api/pm-plan/unit-config", json={"plant": code, "equipment_type": "Inverter", "total_units": tot, "units_per_day": per}).status_code == 200
    cfg = client.get("/api/pm-plan/unit-config").json()["configs"]
    assert {(c["site_code"], c["total_units"], c["units_per_day"], c["days"]) for c in cfg} == {("A01", 20, 4, 5), ("B01", 12, 2, 6)}
    res = client.post("/api/pm-plan/tasks", json=_body(plants=["A_01", "B_01"])).json()     # no overrides: each plant uses its own config
    assert res["count"] == 32
    a = db.query(OMTask).join(Plant).filter(Plant.site_code == "A01")
    assert a.count() == 20 and max(t.cycle_day for t in a) == 5


def test_config_only_head_can_edit(client, db):
    login_user(client, db, role="Administration")
    _plant(db)
    r = client.put("/api/pm-plan/unit-config", json={"plant": "KRN_01", "equipment_type": "Inverter", "total_units": 4, "units_per_day": 2})
    assert r.status_code == 403
    assert client.get("/api/pm-plan/unit-config").status_code == 403


def test_new_equipment_types_accepted_and_template_units(client, db):
    login_user(client, db, role="O&M Head")
    for et in ("MCCB", "OLTC(RTCC)", "4 Pole", "VCB - GSS side"):
        r = client.post("/api/pm-plan/templates", json={"equipment_type": et, "task_name": f"{et} check", "units_per_day": 3})
        assert r.status_code == 201 and r.json()["units_per_day"] == 3


def test_one_assignee_per_plant(client, db):
    head = login_user(client, db, role="O&M Head")
    _plant(db, "A_01", "Plant A"); _plant(db, "B_01", "Plant B")
    for n in ("Asha", "Ravi"):
        db.add(User(auth_provider="t", external_subject=n, display_name=n, role="Administration")); db.commit()
    client.post("/api/pm-plan/tasks", json=_body(plants=["A_01", "B_01"], total_units=4, units_per_day=2, assignees=["Asha", "Ravi"]))
    by = {}
    for t in db.query(OMTask).join(Plant, OMTask.plant_id == Plant.id).add_columns(Plant.site_code):
        by.setdefault(t[1], set()).add(t[0].assignee_text)
    assert by == {"A01": {"Asha"}, "B01": {"Ravi"}}


def test_missed_units_roll_and_escalate(client, db):
    login_user(client, db, role="O&M Head")
    p = _plant(db)
    db.add(PMUnitConfig(plant_id=p.id, equipment_type="Inverter", total_units=6, units_per_day=2)); db.commit()
    start = date.today() - timedelta(days=8)           # a cycle that began 8 days ago: days 1..3 = -8,-7,-6
    client.post("/api/pm-plan/tasks", json=_body(start_date=start.isoformat()))
    rows = {t.unit_no: t for t in db.query(OMTask).all()}
    rows[1].status = "Completed"; db.commit()           # unit 1 done; unit 2 (due -5) and later ones are all overdue
    out = run_daily(db, date.today())
    db.expire_all()
    rows = {t.unit_no: t for t in db.query(OMTask).all()}
    today = date.today()
    assert out["rolled"] == 5 and out["escalated"] >= 1
    # missed units go to the front of today's capacity (2/day): 2,3 today, 4,5 tomorrow, 6 the day after
    assert [rows[n].due_on for n in (2, 3, 4, 5, 6)] == [today, today, today + timedelta(days=1), today + timedelta(days=1), today + timedelta(days=2)]
    assert rows[2].missed_days == 8 and rows[2].rolled_count == 1 and rows[2].planned_due_on == start
    assert rows[6].missed_days == 6                        # stored for reporting, original plan date kept
    again = run_daily(db, date.today())                    # idempotent
    assert again["rolled"] == 0
    assert db.query(Notification).filter(Notification.event_type.in_(["pm_late_1d", "pm_late_3d", "pm_critical_7d"])).count() >= 1


def test_reminders_three_days_before_and_on_due_date(client, db):
    head = login_user(client, db, role="O&M Head")
    _plant(db)
    a = User(auth_provider="t", external_subject="asha", email="asha@example.com", display_name="Asha", role="Assignee", is_active=True); db.add(a); db.flush()
    db.add(UserEquipmentTypeAssignment(user_id=a.id, equipment_type="Inverter")); db.commit()
    response = client.post("/api/pm-plan/tasks", json=_body(per_unit=False, assignees=["Asha"], start_date=(date.today() + timedelta(days=3)).isoformat()))
    assert response.status_code == 200, response.text
    assert run_daily(db, date.today())["advance"] == 1
    assert run_daily(db, date.today() + timedelta(days=3))["due_today"] == 1
    assert run_daily(db, date.today() + timedelta(days=3))["due_today"] == 0       # already sent for this due date
    assert db.query(Notification).filter(Notification.event_type.in_(["pm_due_soon", "pm_due_today"])).count() == 2


def test_completion_creates_same_unit_next_period(client, db):
    from app.scheduled.schemas import TaskCompletion  # noqa: F401
    login_user(client, db, role="O&M Head")
    _plant(db)
    client.post("/api/pm-plan/tasks", json=_body(total_units=4, units_per_day=2))
    t = db.query(OMTask).filter(OMTask.unit_no == 3).one()
    assert t.cycle_day == 2 and t.cycle_id


def test_scope_edit_head_only_and_validation(client, db):
    login_user(client, db, role="O&M Head")
    assert client.get("/api/pm-plan/scope").json() == {"customised": False}
    ok = client.put("/api/pm-plan/scope", json={"sections": {"pv": ["Inverter", "WMS"], "plant": ["OLTC(RTCC)"], "gss": []}, "hidden": ["VCB-Kiosk"]})
    assert ok.status_code == 200 and ok.json()["sections"]["pv"] == ["Inverter", "WMS"]
    assert client.get("/api/pm-plan/scope").json()["hidden"] == ["VCB-Kiosk"]
    assert client.put("/api/pm-plan/scope", json={"sections": {"pv": ["Inverter"], "plant": ["Inverter"], "gss": []}}).status_code == 422   # duplicate
    assert client.put("/api/pm-plan/scope", json={"sections": {"pv": ["Nope"], "plant": [], "gss": []}}).status_code == 422
    assert client.delete("/api/pm-plan/scope").status_code == 204
    assert client.get("/api/pm-plan/scope").json() == {"customised": False}


def test_scope_edit_forbidden_for_others(client, db):
    login_user(client, db, role="Administration")
    r = client.put("/api/pm-plan/scope", json={"sections": {"pv": [], "plant": [], "gss": []}})
    assert r.status_code == 403
    assert client.get("/api/pm-plan/scope").status_code == 403


def _xlsx(rows, header=None):
    import io
    from openpyxl import Workbook
    wb = Workbook(); ws = wb.active; ws.title = "PM Tasks"
    ws.append(header or ["Equipment type", "Plant(s)", "Task – what to do", "Frequency – when", "Assignee(s)", "Safety needed", "Est. time (hours)"])
    for r in rows:
        ws.append(r)
    buf = io.BytesIO(); wb.save(buf); buf.seek(0)
    return buf


def test_import_in_given_template_style(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db, "KRN_01", "Kerli"); _plant(db, "ASA_01", "Asadi")
    f = _xlsx([["Inverter", "KRN_01, ASA_01", "Clean fans", "Monthly", "", "PTW + LOTO required", 2]])
    r = client.post("/api/pm-plan/import?dry_run=false", files={"file": ("plan.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert r.status_code == 200 and r.json()["templates"] == 1
    assert db.query(OMTask).count() == 2            # no units known -> one task per plant, as before


def test_import_optional_unit_columns(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db, "KRN_01", "Kerli")
    head = ["Equipment type", "Plant(s)", "Task – what to do", "Frequency – when", "Assignee(s)", "Safety needed", "Est. time (hours)",
            "How to do it", "Start date", "No. of units", "Units per day"]
    f = _xlsx([["Inverter", "KRN_01", "Clean fans", "Monthly", "", "—", 2, "1. Isolate", "", 10, 2]], head)
    r = client.post("/api/pm-plan/import?dry_run=false", files={"file": ("plan.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert r.status_code == 200 and r.json()["tasks"] == 10
    assert max(t.cycle_day for t in db.query(OMTask).all()) == 5
    assert db.query(PMTemplate).one().units_per_day == 2


def test_import_number_in_equipment_column_is_explained(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db, "KRN_01", "Kerli")
    f = _xlsx([[9, "KRN_01", "Clean fans", "Monthly", "", "—", 2]])
    r = client.post("/api/pm-plan/import?dry_run=true", files={"file": ("plan.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert r.status_code == 422 and "No. of units" in str(r.json())


def test_bundled_template_matches_given_style():
    import openpyxl
    wb = openpyxl.load_workbook("frontend/static/templates/PM_Task_Plan_Template.xlsx")
    assert wb.sheetnames == ["How to fill", "PM Tasks", "Task ideas", "Lists"]
    head = [c.value for c in wb["PM Tasks"][1]][:7]
    assert head == ["Equipment type", "Plant(s)", "Task – what to do", "Frequency – when", "Assignee(s)", "Safety needed", "Est. time (hours)"]


def test_missing_migration_gives_clear_message(client, db):
    from sqlalchemy import text
    login_user(client, db, role="O&M Head")
    db.execute(text("ALTER TABLE om_tasks DROP COLUMN unit_no")); db.commit()
    r = client.get("/api/scheduled/tasks")
    assert r.status_code == 503 and r.json()["error"] == "database_migration_pending" and "SUPABASE_RUN_THIS.sql" in r.json()["detail"]
