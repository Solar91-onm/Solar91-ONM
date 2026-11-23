"""Per-plant monthly PM cycle plans (migration 049).

The engine rule is unchanged: a phase starts on its nominal cycle day or the day after the
previous phase's work actually ended, whichever is later. What these tests cover is that the
rule now runs on EACH PLANT'S OWN data instead of one hardcoded table, that a phase can run on
alternate days, and that a plant with no tracker is paused rather than silently producing nothing.
"""
from __future__ import annotations

from datetime import date, timedelta

from app.core.models import OMTask, PMCyclePlan, PMUnitConfig, Plant
from app.pmplan.cycle import CYCLE, CYCLE_DAYS, chained_window, phase_for, phase_index, plan_problem, resolve_cycle
from app.pmplan.units import distribute
from tests.conftest import login_user

START = date(2026, 11, 1)


def _plant(db, code="KRN_01", name="Kerli"):
    p = Plant(site_code=code, plant_name=name)
    db.add(p); db.commit(); db.refresh(p)
    return p


def _phase(name, categories, start_day, days=1, step_days=1, area="Plant side"):
    return {"phase": name, "area": area, "categories": list(categories),
            "start_day": start_day, "days": days, "step_days": step_days}


def _store_plan(db, plant, phases):
    db.add(PMCyclePlan(plant_id=plant.id, phases=phases)); db.commit()


def _body(**over):
    b = {"equipment_type": "Inverter", "task_name": "Inverter service", "frequency": "Monthly", "safety": "—",
         "est_hours": 2, "plants": ["KRN_01"], "start_date": START.isoformat(), "assignees": [],
         "per_unit": True, "follow_cycle": True}
    b.update(over)
    return b


# ── a plant with no plan is paused ──────────────────────────────────────────

def test_a_plant_without_a_plan_generates_nothing_and_reports_as_paused(client, db):
    login_user(client, db, role="O&M Head")
    _plant(db)
    res = client.post("/api/pm-plan/tasks", json=_body(equipment_type="VCB Panel", task_name="VCB PM"))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["count"] == 0 and db.query(OMTask).count() == 0
    assert body["paused"] == 1
    assert [p["plant"] for p in body["paused_plants"]] == ["Kerli"]
    # It must read as a state with an action, not as a failure or a bare zero.
    assert "no cycle plan" in body["paused_reason"]
    assert "Configure a cycle plan" in body["paused_hint"]


def test_paused_plants_are_excluded_from_compliance_not_counted_as_zero(client, db):
    """The Module Cleaning tile reported 0% for plants that had done real work. Not repeated here."""
    login_user(client, db, role="O&M Head")
    planned = _plant(db, "HAS_01", "Has tracker")
    _plant(db, "NON_01", "No tracker")
    _store_plan(db, planned, [_phase("VCB", ["VCB Panel"], 10, 2)])
    listing = client.get("/api/pm-plan/cycle-plans")
    assert listing.status_code == 200, listing.text
    body = listing.json()
    assert (body["total"], body["configured"], body["paused"]) == (2, 1, 1)
    rows = {r["site_code"]: r for r in body["plans"]}
    assert rows["HAS01"]["configured"] is True and rows["HAS01"]["paused"] is False
    assert rows["NON01"]["paused"] is True and rows["NON01"]["phases"] == 0
    # The paused plant is listed and named, never folded into the denominator as a 0%.
    assert body["configured"] + body["paused"] == body["total"]


def test_pausing_a_plant_leaves_work_already_generated_untouched(client, db):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    _store_plan(db, plant, [_phase("VCB", ["VCB Panel"], 10, 2)])
    assert client.post("/api/pm-plan/tasks", json=_body(equipment_type="VCB Panel", task_name="VCB PM")).status_code == 200
    before = {t.work_order_no: (t.start_on, t.due_on, t.status) for t in db.query(OMTask)}
    assert len(before) == 1
    assert client.delete(f"/api/pm-plan/cycle-plans/{plant.site_code}").status_code == 204
    db.expire_all()
    assert {t.work_order_no: (t.start_on, t.due_on, t.status) for t in db.query(OMTask)} == before
    # Pausing stops NEW cycles; it does not withdraw planned work.
    again = client.post("/api/pm-plan/tasks", json=_body(equipment_type="VCB Panel", task_name="VCB second"))
    assert again.json()["paused"] == 1 and db.query(OMTask).count() == 1


def test_a_paused_plant_in_an_upload_does_not_fail_the_whole_file(client, db):
    login_user(client, db, role="O&M Head")
    good = _plant(db, "GOOD_01", "Planned plant")
    _plant(db, "PAUS_01", "Paused plant")
    _store_plan(db, good, [_phase("VCB", ["VCB Panel"], 10, 2)])
    csv = ("Equipment type,Plant(s),Task - what to do,Frequency\n"
           "VCB Panel,\"GOOD_01, PAUS_01\",VCB service,Monthly\n").encode()
    q = f"follow_cycle=true&cycle_start={START.isoformat()}"
    res = client.post(f"/api/pm-plan/import?dry_run=false&{q}", files={"file": ("plan.csv", csv, "text/csv")})
    assert res.status_code == 200, res.text
    assert res.json()["paused"] == 1
    assert [p["plant"] for p in res.json()["paused_plants"]] == ["Paused plant"]
    assert {t.plant_id for t in db.query(OMTask)} == {good.id}


# ── a plant with a plan runs on its own stored days ─────────────────────────

def test_a_plant_generates_phases_on_its_stored_start_days(client, db):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    # Deliberately NOT the built-in days: the plan, not the hardcoded table, decides.
    _store_plan(db, plant, [_phase("VCB", ["VCB Panel"], 4, 1),
                            _phase("Earth pit", ["Earthing"], 12, 1),
                            _phase("GSS Switchyard", ["Switchyard"], 25, 2, area="GSS side")])
    for etype, start_day, end_day in (("VCB Panel", 4, 4), ("Earthing", 12, 12), ("Switchyard", 25, 26)):
        res = client.post("/api/pm-plan/tasks", json=_body(equipment_type=etype, task_name=f"{etype} PM"))
        assert res.status_code == 200, res.text
        task = db.query(OMTask).filter(OMTask.task_type == etype).one()
        assert task.start_on == START + timedelta(days=start_day - 1), etype
        assert task.due_on == START + timedelta(days=end_day - 1), etype


def test_two_plants_follow_their_own_different_plans(client, db):
    login_user(client, db, role="O&M Head")
    early = _plant(db, "EAR_01", "Early plant")
    late = _plant(db, "LAT_01", "Late plant")
    _store_plan(db, early, [_phase("VCB", ["VCB Panel"], 3, 1)])
    _store_plan(db, late, [_phase("VCB", ["VCB Panel"], 20, 1)])
    res = client.post("/api/pm-plan/tasks", json=_body(equipment_type="VCB Panel", task_name="VCB PM",
                                                      plants=["EAR_01", "LAT_01"]))
    assert res.status_code == 200, res.text
    due = {t.plant_id: t.due_on for t in db.query(OMTask)}
    assert due[early.id] == START + timedelta(days=2)
    assert due[late.id] == START + timedelta(days=19)


def test_a_multi_category_phase_is_scheduled_as_one_visit(client, db):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    # One visit covering three categories, exactly as the trackers record it.
    _store_plan(db, plant, [_phase("4 Pole + ACDB + Aux. TX", ["4 Pole", "ACDB", "Aux. Transformer"], 16, 1)])
    for etype in ("4 Pole", "ACDB", "Aux. Transformer"):
        res = client.post("/api/pm-plan/tasks", json=_body(equipment_type=etype, task_name=f"{etype} PM"))
        assert res.status_code == 200, res.text
    rows = db.query(OMTask).all()
    assert len(rows) == 3
    # One visit: every category of the phase lands on the same single day.
    assert {t.start_on for t in rows} == {START + timedelta(days=15)}
    assert {t.due_on for t in rows} == {START + timedelta(days=15)}
    assert len({phase_index(t.task_type, resolve_cycle(
        [_phase("4 Pole + ACDB + Aux. TX", ["4 Pole", "ACDB", "Aux. Transformer"], 16, 1)])) for t in rows}) == 1


# ── step_days ───────────────────────────────────────────────────────────────

def test_distribute_places_working_days_on_the_step_spacing():
    # 7 units, 1 a day, every other day: calendar 1,3,5,7,9,11,13 ...
    plan = distribute(list(range(1, 8)), 1, date(2026, 1, 1), step_days=2)
    assert [due.day for _, _, due in plan] == [1, 3, 5, 7, 9, 11, 13]
    # ... but cycle_day stays the WORKING-day ordinal 1..7, never the calendar offset.
    assert [cycle_day for _, cycle_day, _ in plan] == [1, 2, 3, 4, 5, 6, 7]
    # Two a day on alternate days: ordinals pair up, dates still step by 2.
    paired = distribute(list(range(1, 5)), 2, date(2026, 1, 1), step_days=2)
    assert [(n, d, due.day) for n, d, due in paired] == [(1, 1, 1), (2, 1, 1), (3, 2, 3), (4, 2, 3)]
    # step_days 1 is exactly today's behaviour.
    assert distribute([1, 2, 3], 1, date(2026, 1, 1), step_days=1) == distribute([1, 2, 3], 1, date(2026, 1, 1))


def test_a_step_phase_lands_on_alternate_days_and_keeps_working_day_ordinals(client, db):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    db.add(PMUnitConfig(plant_id=plant.id, equipment_type="Inverter", total_units=7, units_per_day=1)); db.commit()
    # The real plan this exists for: inverters on days 1,3,5,7,9,11,13.
    _store_plan(db, plant, [{"phase": "Inverter", "area": "Plant side", "categories": ["Inverter"],
                             "start_day": 1, "days": None, "step_days": 2}])
    res = client.post("/api/pm-plan/tasks", json=_body())
    assert res.status_code == 200, res.text
    rows = db.query(OMTask).order_by(OMTask.unit_no).all()
    assert len(rows) == 7
    assert [t.due_on for t in rows] == [START + timedelta(days=o) for o in (0, 2, 4, 6, 8, 10, 12)]
    # cycle_day is the working-day ordinal: 1,2,3..., NOT the calendar offsets 1,3,5...
    assert [t.cycle_day for t in rows] == [1, 2, 3, 4, 5, 6, 7]


def test_a_step_phase_occupies_its_span_and_the_next_phase_is_not_overlapped():
    # 4 working days, every other day = (4-1)*2+1 = 7 calendar days: days 1..7.
    # The Inverter phase's length comes from the unit count, so it is supplied rather than stored.
    cycle = resolve_cycle([_phase("Inverter", ["Inverter"], 1, 4, step_days=2),
                           _phase("ACCB", ["ACCB Panel"], 9, 2)], {"Inverter": 4})
    assert (cycle[0]["days"], cycle[0]["step_days"]) == (4, 2)
    assert cycle[0]["end_day"] == 7, "span, not the working-day count"
    first = chained_window("Inverter", START, None, cycle)
    assert first["start"] == START and first["end"] == START + timedelta(days=6)
    # The gap at days 8 is real: ACCB keeps its own nominal day 9 rather than being pulled early
    # or overlapped by the inverter span.
    second = chained_window("ACCB Panel", START, None, cycle)
    assert second["start"] == START + timedelta(days=8) and second["moved_days"] == 0
    # With the span mis-computed as 4 days the inverter phase would end on day 4 and nothing would
    # catch an overlap; assert the chain explicitly.
    assert first["end"] < second["start"]


def test_a_steps_span_pushes_the_next_phase_when_it_has_no_gap():
    # Inverter 4 working days step 2 spans days 1..7, so a phase nominally on day 5 must move to 8.
    cycle = resolve_cycle([_phase("Inverter", ["Inverter"], 1, 4, step_days=2),
                           _phase("ACCB", ["ACCB Panel"], 5, 1)], {"Inverter": 4})
    pushed = chained_window("ACCB Panel", START, None, cycle)
    assert pushed["start"] == START + timedelta(days=7)      # day 8
    assert pushed["moved_days"] == 3


# ── re-convergence: the most important behaviour here ───────────────────────

def test_an_overrun_moves_the_next_phase_and_a_gap_lets_the_plan_reconverge():
    """The O&M Head's "leverage of time to complete all equipment by the end of the month".

    One phase runs a day long, the next moves by a day, and because a GAP follows, the phase
    after that still lands on its own stored day instead of the whole month sliding."""
    cycle = resolve_cycle([_phase("Inverter", ["Inverter"], 1, 3),       # days 1-3
                           _phase("ACCB", ["ACCB Panel"], 4, 1),        # day 4, straight after
                           _phase("VCB", ["VCB Panel"], 8, 1)],         # day 8: a 3-day gap absorbs slip
                          {"Inverter": 3})
    inverter = phase_index("Inverter", cycle)
    overran = {inverter: START + timedelta(days=3)}                      # inverters actually ran to day 4

    on_plan = chained_window("ACCB Panel", START, None, cycle)
    assert on_plan["start"] == START + timedelta(days=3) and on_plan["moved_days"] == 0

    moved = chained_window("ACCB Panel", START, overran, cycle)
    assert moved["start"] == START + timedelta(days=4)                   # day 5: one day later
    assert moved["moved_days"] == 1

    # The gap absorbs it: VCB is back on its stored day 8, not dragged to day 9.
    reconverged = chained_window("VCB Panel", START, overran, cycle)
    assert reconverged["start"] == START + timedelta(days=7)
    assert reconverged["moved_days"] == 0


def test_reconvergence_end_to_end_through_the_register(client, db):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    _store_plan(db, plant, [_phase("Inverter", ["Inverter"], 1, 3),
                            _phase("ACCB", ["ACCB Panel"], 4, 1),
                            _phase("VCB", ["VCB Panel"], 8, 1)])
    # 4 inverters at 1 a day overruns the 3-day phase by one day (Nov 1-4).
    db.add(PMUnitConfig(plant_id=plant.id, equipment_type="Inverter", total_units=4, units_per_day=1)); db.commit()
    assert client.post("/api/pm-plan/tasks", json=_body()).status_code == 200
    assert max(t.due_on for t in db.query(OMTask).filter(OMTask.task_type == "Inverter")) == START + timedelta(days=3)

    accb = client.post("/api/pm-plan/tasks", json=_body(equipment_type="ACCB Panel", task_name="ACCB PM"))
    assert accb.status_code == 200, accb.text
    assert db.query(OMTask).filter(OMTask.task_type == "ACCB Panel").one().start_on == START + timedelta(days=4)

    vcb = client.post("/api/pm-plan/tasks", json=_body(equipment_type="VCB Panel", task_name="VCB PM"))
    assert vcb.status_code == 200, vcb.text
    # Re-converged on its stored day 8 even though two earlier phases slipped.
    assert db.query(OMTask).filter(OMTask.task_type == "VCB Panel").one().start_on == START + timedelta(days=7)


# ── the Inverter phase still follows pm_unit_config ─────────────────────────

def test_the_inverter_phase_length_follows_unit_config_not_a_stored_days():
    phases = [{"phase": "Inverter", "area": "Plant side", "categories": ["Inverter"],
               "start_day": 1, "days": 99, "step_days": 1}]          # a stored days to be ignored
    assert resolve_cycle(phases, {"Inverter": 5})[0]["days"] == 5
    assert resolve_cycle(phases, {"Inverter": 5})[0]["end_day"] == 5
    # No unit count configured yet: the built-in length, not the bogus 99.
    assert resolve_cycle(phases)[0]["days"] == 7
    # Null days with a unit count is the normal stored shape.
    nulled = [{**phases[0], "days": None}]
    assert resolve_cycle(nulled, {"Inverter": 11})[0]["days"] == 11


def test_inverter_phase_days_come_from_the_plants_own_unit_count(client, db):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    db.add(PMUnitConfig(plant_id=plant.id, equipment_type="Inverter", total_units=10, units_per_day=2)); db.commit()
    _store_plan(db, plant, [{"phase": "Inverter", "area": "Plant side", "categories": ["Inverter"],
                             "start_day": 1, "days": None, "step_days": 1},
                            _phase("ACCB", ["ACCB Panel"], 6, 1)])
    shown = client.get(f"/api/pm-plan/cycle-plans/{plant.site_code}")
    assert shown.status_code == 200, shown.text
    # 10 units at 2 a day = 5 working days, days 1-5, so ACCB's nominal day 6 still fits.
    inverter = next(p for p in shown.json()["resolved"] if p["phase"] == "Inverter")
    assert (inverter["days"], inverter["end_day"]) == (5, 5)
    accb = next(w for w in shown.json()["chained"] if w["phase"] == "ACCB")
    assert accb["moved_days"] == 0


# ── validation ──────────────────────────────────────────────────────────────

def test_plan_problem_names_the_offending_phase():
    ok = [_phase("Inverter", ["Inverter"], 1, 3), _phase("ACCB", ["ACCB Panel"], 8, 2)]
    assert plan_problem(ok) is None

    repeated = [_phase("First", ["VCB Panel"], 1, 1), _phase("Second", ["VCB Panel"], 5, 1)]
    assert plan_problem(repeated) == "Second: VCB Panel is already planned in First"

    empty = [{"phase": "Nothing", "area": "Plant side", "categories": [], "start_day": 1, "days": 1, "step_days": 1}]
    assert plan_problem(empty) == "Nothing: choose at least one work category"

    backwards = [_phase("First", ["Inverter"], 10, 1), _phase("Second", ["ACCB Panel"], 4, 1)]
    problem = plan_problem(backwards)
    assert problem.startswith("Second:") and "must come after" in problem

    overflow = [_phase("Late", ["Inverter"], 29, 4)]
    problem = plan_problem(overflow)
    assert problem.startswith("Late:") and f"past day {CYCLE_DAYS}" in problem

    # A span that overflows only because of its step is caught too.
    stepped = [_phase("Stepped", ["Inverter"], 25, 4, step_days=3)]
    assert f"past day {CYCLE_DAYS}" in plan_problem(stepped)

    assert plan_problem([_phase("Bad day", ["Inverter"], 31, 1)]).startswith("Bad day:")
    assert plan_problem([]) is not None


def test_saving_an_invalid_plan_is_rejected_with_the_phase_named(client, db):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    code = plant.site_code

    repeated = client.put(f"/api/pm-plan/cycle-plans/{code}", json={"phases": [
        _phase("First", ["VCB Panel"], 1, 1), _phase("Second", ["VCB Panel"], 5, 1)]})
    assert repeated.status_code == 422
    assert "Second" in repeated.json()["detail"] and "VCB Panel" in repeated.json()["detail"]

    backwards = client.put(f"/api/pm-plan/cycle-plans/{code}", json={"phases": [
        _phase("First", ["Inverter"], 10, 1), _phase("Second", ["ACCB Panel"], 4, 1)]})
    assert backwards.status_code == 422 and "Second" in backwards.json()["detail"]

    overflow = client.put(f"/api/pm-plan/cycle-plans/{code}", json={"phases": [
        _phase("Late", ["Inverter"], 29, 4)]})
    assert overflow.status_code == 422 and "Late" in overflow.json()["detail"]

    assert client.put(f"/api/pm-plan/cycle-plans/{code}", json={"phases": [
        _phase("Empty", [], 1, 1)]}).status_code == 422
    assert client.put(f"/api/pm-plan/cycle-plans/{code}", json={"phases": [
        _phase("Unknown", ["Not a category"], 1, 1)]}).status_code == 422
    # MCCB is out of PM entirely and cannot be planned.
    assert client.put(f"/api/pm-plan/cycle-plans/{code}", json={"phases": [
        _phase("MCCB", ["MCCB"], 1, 1)]}).status_code == 422
    # Nothing was stored by any of the rejected attempts.
    assert db.query(PMCyclePlan).count() == 0


# ── the editor's endpoints ──────────────────────────────────────────────────

def test_save_then_read_a_plan_and_see_the_chained_calendar(client, db):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    phases = [_phase("Inverter", ["Inverter"], 1, 3), _phase("ACCB", ["ACCB Panel"], 8, 2)]
    saved = client.put(f"/api/pm-plan/cycle-plans/{plant.site_code}?cycle_start={START.isoformat()}",
                       json={"phases": phases, "notes": "From the Kerli tracker"})
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["configured"] is True and body["paused"] is False
    assert body["notes"] == "From the Kerli tracker"
    assert body["effective_from"] == "next cycle"
    assert [p["start_day"] for p in body["phases"]] == [1, 8]
    # The stored plan and what the engine will really do are both shown.
    assert [w["start"] for w in body["chained"]] == ["2026-11-01", "2026-11-08"]

    read = client.get(f"/api/pm-plan/cycle-plans/{plant.site_code}?cycle_start={START.isoformat()}")
    assert read.status_code == 200
    assert read.json()["phases"] == body["phases"]
    assert [w["start"] for w in read.json()["chained"]] == ["2026-11-01", "2026-11-08"]


def test_preview_validates_without_saving(client, db):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    good = client.post(f"/api/pm-plan/cycle-plans/{plant.site_code}/preview?cycle_start={START.isoformat()}",
                       json={"phases": [_phase("IDT", ["Transformer"], 1, 3)]})
    assert good.status_code == 200, good.text
    assert good.json()["saved"] is False
    assert good.json()["resolved"][0]["end_day"] == 3
    bad = client.post(f"/api/pm-plan/cycle-plans/{plant.site_code}/preview",
                      json={"phases": [_phase("Late", ["Inverter"], 29, 4)]})
    assert bad.status_code == 422 and "Late" in bad.json()["detail"]
    assert db.query(PMCyclePlan).count() == 0        # neither call stored anything


def test_preview_shows_a_collision_before_it_is_saved(client, db):
    """A plan whose phases collide must be obvious in the calendar before saving."""
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    res = client.post(f"/api/pm-plan/cycle-plans/{plant.site_code}/preview?cycle_start={START.isoformat()}",
                      json={"phases": [_phase("IDT", ["Transformer"], 1, 5),        # days 1-5
                                       _phase("ACCB", ["ACCB Panel"], 3, 1)]})      # nominal day 3: collides
    assert res.status_code == 200, res.text
    chained = {w["phase"]: w for w in res.json()["chained"]}
    # Stored day 3, but chaining actually runs it on day 6 and says so.
    assert chained["ACCB"]["start_day"] == 3
    assert chained["ACCB"]["start"] == "2026-11-06"
    assert chained["ACCB"]["moved_days"] == 3


def test_the_cycle_endpoint_returns_a_named_plants_plan_and_the_default_otherwise(client, db):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    default = client.get("/api/pm-plan/cycle")
    assert default.status_code == 200
    assert default.json()["source"] == "default" and default.json()["paused"] is False
    assert default.json()["phases"][0]["equipment_types"] == ["Inverter"]
    assert len(default.json()["phases"]) == len(CYCLE)

    paused = client.get(f"/api/pm-plan/cycle?plant={plant.site_code}")
    assert paused.status_code == 200
    assert paused.json()["paused"] is True and paused.json()["phases"] == []
    assert "no cycle plan" in paused.json()["paused_reason"]

    _store_plan(db, plant, [_phase("VCB", ["VCB Panel"], 4, 1)])
    named = client.get(f"/api/pm-plan/cycle?plant={plant.site_code}")
    assert named.status_code == 200
    assert named.json()["source"] == "plant" and named.json()["paused"] is False
    assert [p["start_day"] for p in named.json()["phases"]] == [4]
    assert named.json()["plant"]["site_code"] == plant.site_code


def test_only_the_head_can_edit_a_cycle_plan(client, db):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    phases = [_phase("VCB", ["VCB Panel"], 4, 1)]
    assert client.put(f"/api/pm-plan/cycle-plans/{plant.site_code}", json={"phases": phases}).status_code == 200

    login_user(client, db, role="Assignee", email="as@example.com")
    assert client.get("/api/pm-plan/cycle-plans").status_code == 200          # the team reads the plan
    assert client.put(f"/api/pm-plan/cycle-plans/{plant.site_code}", json={"phases": phases}).status_code == 403
    assert client.delete(f"/api/pm-plan/cycle-plans/{plant.site_code}").status_code == 403

    login_user(client, db, role="Site Engineer", email="se@example.com")
    assert client.get("/api/pm-plan/cycle-plans").status_code == 403
    assert db.query(PMCyclePlan).count() == 1


def test_saving_a_plan_replaces_it_rather_than_adding_a_second_row(client, db):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    code = plant.site_code
    assert client.put(f"/api/pm-plan/cycle-plans/{code}", json={"phases": [_phase("VCB", ["VCB Panel"], 4, 1)]}).status_code == 200
    assert client.put(f"/api/pm-plan/cycle-plans/{code}", json={"phases": [_phase("VCB", ["VCB Panel"], 9, 2)]}).status_code == 200
    assert db.query(PMCyclePlan).count() == 1
    row = db.query(PMCyclePlan).one()
    db.refresh(row)
    assert [p["start_day"] for p in row.phases] == [9]


def test_a_stale_editor_cannot_overwrite_a_newer_plan(client, db):
    """Two planners open the same plant; the second save must not silently erase the first."""
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    url = f"/api/pm-plan/cycle-plans/{plant.site_code}"
    opened = client.get(url).json()
    assert opened["updated_at"] is None                                  # no plan yet

    first = client.put(url, json={"phases": [_phase("VCB", ["VCB Panel"], 4, 1)],
                                  "expected_updated_at": opened["updated_at"]})
    assert first.status_code == 200, first.text
    # A second editor still holding the "no plan" view is refused, naming the plant.
    stale = client.put(url, json={"phases": [_phase("VCB", ["VCB Panel"], 9, 1)],
                                  "expected_updated_at": opened["updated_at"]})
    assert stale.status_code == 409 and "changed by someone else" in stale.json()["detail"]
    row = db.query(PMCyclePlan).one()
    db.refresh(row)
    assert [p["start_day"] for p in row.phases] == [4]                   # the first save survived

    # With the current version in hand the save goes through.
    fresh = client.put(url, json={"phases": [_phase("VCB", ["VCB Panel"], 9, 1)],
                                  "expected_updated_at": first.json()["updated_at"]})
    assert fresh.status_code == 200, fresh.text


def test_the_first_plan_for_a_plant_is_audited_as_configured(client, db):
    from app.core.models import AuditLog
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    url = f"/api/pm-plan/cycle-plans/{plant.site_code}"
    actions = lambda: sorted(a.action for a in db.query(AuditLog).filter(AuditLog.action.like("%PM cycle plan%")))
    assert client.put(url, json={"phases": [_phase("VCB", ["VCB Panel"], 4, 1)]}).status_code == 200
    assert actions() == ["Configured PM cycle plan"]                     # checked per save: ids are UUIDs
    assert client.put(url, json={"phases": [_phase("VCB", ["VCB Panel"], 5, 1)]}).status_code == 200
    assert actions() == ["Configured PM cycle plan", "Saved PM cycle plan"]


def test_deleting_a_plan_that_does_not_exist_is_a_404(client, db):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    assert client.delete(f"/api/pm-plan/cycle-plans/{plant.site_code}").status_code == 404


# ── the built-in cycle is untouched ────────────────────────────────────────

def test_the_builtin_cycle_still_has_its_original_days_and_a_step_of_one():
    """Nothing about the built-in table changed; it only gained an explicit step_days of 1."""
    days = {(p["area"], p["phase"]): (p["start_day"], p["end_day"]) for p in CYCLE}
    assert days[("Plant side", "Inverter")] == (1, 7)
    assert days[("Plant side", "Miscellaneous")] == (20, 22)
    assert days[("GSS side", "Switchyard")] == (29, 30)
    assert CYCLE[-1]["end_day"] == CYCLE_DAYS == 30
    assert all(p["step_days"] == 1 for p in CYCLE)
    # With step 1, a phase's span is exactly its working-day count, as before.
    assert all(p["end_day"] - p["start_day"] + 1 == p["days"] for p in CYCLE)
    # No cycle argument means the built-in table, so existing callers are unaffected.
    assert phase_for("Inverter") is CYCLE[0] and phase_index("Inverter") == 0
    assert chained_window("ACCB Panel", START)["start"] == START + timedelta(days=7)
