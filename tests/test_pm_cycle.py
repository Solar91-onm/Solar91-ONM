from __future__ import annotations

from datetime import date, timedelta

from app.core.models import OMTask, Plant
from app.pmplan.cycle import CYCLE, CYCLE_DAYS, phase_for, window
from tests.conftest import login_user

START = date(2026, 11, 1)


def _plant(db, code="KRN_01", name="Kerli"):
    p = Plant(site_code=code, plant_name=name)
    db.add(p); db.commit(); db.refresh(p)
    return p


def _body(**over):
    b = {"equipment_type": "Inverter", "task_name": "Inverter service", "frequency": "Monthly", "safety": "—", "est_hours": 2,
         "plants": ["KRN_01"], "start_date": START.isoformat(), "assignees": [], "per_unit": True, "follow_cycle": True}
    b.update(over)
    return b


def test_cycle_order_and_days_fill_thirty_days():
    days = {(p["area"], p["phase"]): (p["start_day"], p["end_day"]) for p in CYCLE}
    assert days[("Plant side", "Inverter")] == (1, 7)
    assert days[("Plant side", "ACCB + MCCB")] == (8, 9)
    assert days[("Plant side", "VCB")] == (10, 11)
    assert days[("Plant side", "IDT Transformer")] == (12, 13)
    assert days[("Plant side", "Aux. Transformer")] == (14, 15)
    assert days[("Plant side", "4 Pole")] == (16, 17)
    assert days[("Plant side", "Earth pit")] == (18, 19)
    assert days[("Plant side", "Miscellaneous")] == (20, 22)
    assert days[("Plant side", "Transmission line")] == (23, 24)
    assert days[("GSS side", "VCB")] == (25, 26)
    assert days[("GSS side", "4 Pole")] == (27, 28)
    assert days[("GSS side", "Transmission line")] == (29, 30)
    assert CYCLE[-1]["end_day"] == CYCLE_DAYS == 30
    assert phase_for("ACCB Panel") is phase_for("MCCB")
    assert phase_for("RMS")["phase"] == phase_for("CCTV")["phase"] == "Miscellaneous"
    assert phase_for("VCB Panel")["area"] == "Plant side" and phase_for("VCB - GSS side")["area"] == "GSS side"
    assert window("Earthing", START)["start"] == START + timedelta(days=17)


def test_inverter_units_spread_over_the_first_week(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db)
    res = client.post("/api/pm-plan/tasks", json=_body(total_units=14))
    assert res.status_code == 200, res.text
    assert res.json()["cycle"]["start"] == START.isoformat() and res.json()["cycle"]["end"] == (START + timedelta(days=6)).isoformat()
    rows = db.query(OMTask).order_by(OMTask.unit_no).all()
    assert len(rows) == 14
    assert {t.due_on for t in rows} == {START + timedelta(days=i) for i in range(7)}       # 2 a day for 7 days
    assert all(t.start_on == START for t in rows)


def test_single_unit_equipment_uses_its_turn_in_the_cycle(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db)
    for etype, start_day, end_day in (("VCB Panel", 10, 11), ("Transformer", 12, 13), ("VCB - GSS side", 25, 26),
                                      ("Transmission line - GSS side", 29, 30), ("RMS", 20, 22)):
        res = client.post("/api/pm-plan/tasks", json=_body(equipment_type=etype, task_name=f"{etype} PM"))
        assert res.status_code == 200, res.text
        task = db.query(OMTask).filter(OMTask.task_type == etype).one()
        assert task.start_on == START + timedelta(days=start_day - 1)
        assert task.due_on == START + timedelta(days=end_day - 1)      # one unit: due on the last day of its turn


def test_accb_units_share_two_days_and_template_apply_follows_cycle(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db)
    res = client.post("/api/pm-plan/tasks", json=_body(equipment_type="ACCB Panel", task_name="ACCB PM", total_units=2, save_template=True))
    assert res.status_code == 200, res.text
    assert sorted(t.due_on for t in db.query(OMTask).all()) == [START + timedelta(days=7), START + timedelta(days=8)]
    _plant(db, "B_01", "Plant B")
    tpl = client.get("/api/pm-plan/templates").json()[0]
    res = client.post(f"/api/pm-plan/templates/{tpl['id']}/apply", json={"plants": ["B_01"], "start_date": START.isoformat(),
                                                                          "follow_cycle": True, "total_units": 2})
    assert res.status_code == 200 and res.json()["cycle"]["start_day"] == 8


def test_without_cycle_dates_are_unchanged(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db)
    res = client.post("/api/pm-plan/tasks", json=_body(equipment_type="VCB Panel", follow_cycle=False))
    assert res.status_code == 200 and res.json()["cycle"] is None
    assert db.query(OMTask).one().due_on == START


def test_upload_sets_dates_from_the_cycle(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db)
    csv = ("Equipment type,Plant(s),Task - what to do,Frequency,No. of units,Start date\n"
           "Inverter,KRN_01,Inverter service,Monthly,7,\n"
           "Earthing,KRN_01,Earth pit check,Monthly,,\n"
           "4 Pole - GSS side,KRN_01,GSS 4 pole check,Monthly,,\n"
           "VCB Panel,KRN_01,VCB service,Monthly,,01-12-2026\n").encode()
    q = f"follow_cycle=true&cycle_start={START.isoformat()}"
    pre = client.post(f"/api/pm-plan/import?dry_run=true&{q}", files={"file": ("plan.csv", csv, "text/csv")})
    assert pre.status_code == 200, pre.text
    sched = {s["equipment_type"]: s for s in pre.json()["schedule"]}
    assert sched["Earthing"]["start"] == "2026-11-18" and sched["Earthing"]["end"] == "2026-11-19"
    assert sched["4 Pole - GSS side"]["start"] == "2026-11-27"
    assert sched["VCB Panel"]["start"] == "2026-12-10"          # a row's own Start date is its cycle start
    assert db.query(OMTask).count() == 0
    done = client.post(f"/api/pm-plan/import?dry_run=false&{q}", files={"file": ("plan.csv", csv, "text/csv")})
    assert done.status_code == 200, done.text
    inv = db.query(OMTask).filter(OMTask.task_type == "Inverter").order_by(OMTask.unit_no).all()
    assert [t.due_on for t in inv] == [START + timedelta(days=i) for i in range(7)]
    assert db.query(OMTask).filter(OMTask.task_type == "Earthing").one().due_on == date(2026, 11, 19)


def test_cycle_endpoint_roles(client, db):
    login_user(client, db, role="O&M Head")
    body = client.get("/api/pm-plan/cycle").json()
    assert body["cycle_days"] == 30 and body["phases"][0]["equipment_types"] == ["Inverter"]
    login_user(client, db, role="Site Engineer", email="se@example.com")
    assert client.get("/api/pm-plan/cycle").status_code == 403
