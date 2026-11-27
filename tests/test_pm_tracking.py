"""PM tracking security, independent inverter rows and approval sequence."""
from datetime import date
from sqlalchemy import select

from app.core.models import AuditLog, Plant, PMCyclePlan, UserPlantAssignment
from app.pmplan.tracking import CHECKLISTS, PMTrackingActivity
from tests.conftest import login_user

MONTH = "2026-11"
BASE = "/api/pm-plan/tracking"


def setup_rows(db, monkeypatch):
    monkeypatch.setattr("app.pmplan.tracking.business_today", lambda: date(2026, 11, 25))
    plant = Plant(site_code="ABH01", plant_name="ABHANERI", status="active")
    other = Plant(site_code="ALN01", plant_name="Alaniyawas", status="active")
    db.add_all([plant, other]); db.flush()
    rows = [PMTrackingActivity(plant_id=plant.id, equipment="Inverter", equipment_id=f"INV-{i:02d}", scheduled_on=date(2026,11,day))
            for i,day in [(1,1),(2,3),(3,5),(4,5)]]
    rows.append(PMTrackingActivity(plant_id=other.id, equipment="ACCB", equipment_id="ACCB-01", scheduled_on=date(2026,11,1)))
    db.add_all(rows); db.commit()
    return plant, other, rows


def submit(client, row, checks=None):
    return client.post(f"{BASE}/{row.id}/action",json={"action":"submit","inspected_on":"2026-11-25",
        "checks":checks if checks is not None else [{"result":"OK"} for _ in CHECKLISTS[row.equipment]]})


def act(client,row,action,reason=""):
    return client.post(f"{BASE}/{row.id}/action",json={"action":action,"reason":reason})


def state(client,code="ABH01"):
    r=client.get(BASE,params={"month":MONTH,"site_code":code}); assert r.status_code==200,r.text
    return {x["equipment_id"]:x for x in r.json()["activities"]}


def engineer(client,db,plant,email="se@example.com"):
    u=login_user(client,db,role="Site Engineer",email=email)
    db.add(UserPlantAssignment(user_id=u.id,plant_id=plant.id)); db.commit()
    return u


def test_approval_sequence_override_and_scopes(client,db,monkeypatch):
    plant, other, rows=setup_rows(db,monkeypatch)
    engineer(client,db,plant)
    s=state(client); assert s['INV-01']['can_submit']; assert s['INV-02']['label']=='Locked'
    assert client.get(BASE,params={'month':MONTH,'site_code':'ALN01'}).status_code==404
    assert submit(client,rows[4]).status_code==404
    assert submit(client,rows[1]).status_code==409
    assert submit(client,rows[0],[]).status_code==422
    assert submit(client,rows[0],[{'result':'Not OK'}]*len(CHECKLISTS['Inverter'])).status_code==422
    assert submit(client,rows[0]).status_code==200
    assert state(client)['INV-01']['status']=='Pending approval'
    assert state(client)['INV-02']['label']=='Locked'
    assert act(client,rows[0],'approve').status_code==409
    assert act(client,rows[1],'request','Engineer available today').status_code==200
    assignee=login_user(client,db,role='Assignee',email='assignee@example.com')
    db.add(UserPlantAssignment(user_id=assignee.id,plant_id=plant.id));db.commit()
    assert act(client,rows[0],'approve').status_code==409
    assert act(client,rows[1],'grant','Allow this unit only').status_code==200
    # Use a second scoped engineer to mimic a different logged-in session.
    engineer(client,db,plant,'se2@example.com')
    assert state(client)['INV-02']['can_submit']
    assert state(client)['INV-03']['label']=='Locked'
    assert submit(client,rows[1]).status_code==200
    login_user(client,db,role='O&M Head',email='head@example.com')
    assert act(client,rows[1],'approve').status_code==200
    assert state(client)['INV-03']['label']=='Locked'  # first unit still awaiting approval
    assert act(client,rows[0],'return','Please recheck').status_code==200
    engineer(client,db,plant,'se3@example.com')
    assert submit(client,rows[0]).status_code==200
    login_user(client,db,role='O&M Head',email='head2@example.com')
    assert act(client,rows[0],'approve').status_code==200
    s=state(client); assert s['INV-03']['blocker'] is None and s['INV-04']['blocker'] is None
    assert s['INV-01']['status']=='Approved' and s['INV-02']['status']=='Approved'
    assert db.scalar(select(AuditLog).where(AuditLog.action=='PM tracking: grant')) is not None


def test_unassigned_marker_and_future_activity(client,db,monkeypatch):
    plant, _, rows=setup_rows(db,monkeypatch)
    db.add(PMCyclePlan(plant_id=plant.id,phases=[{"phase":"ACCB","area":"Plant side","categories":["ACCB Panel"],"start_day":15,"days":1,"step_days":1}]))
    db.add(PMTrackingActivity(plant_id=plant.id,equipment="Earth pit",equipment_id="EARTH-01",scheduled_on=date(2026,11,27)))
    db.commit()
    engineer(client,db,plant)
    body=client.get(BASE,params={'month':MONTH}).json()
    assert len(body['plants'])==1 and body['plants'][0]['configured']
    assert any(x['source']=='cycle_plan' for x in body['legacy'])
    assert not state(client)['EARTH-01']['can_submit']
    assert len(CHECKLISTS['VCB']) == 22 and len(CHECKLISTS['IDT Transformer']) == 28
    assert 'Weather Station & UPS' not in CHECKLISTS and 'Fire & Safety' not in CHECKLISTS
    assert len(CHECKLISTS['4 Pole + ACDB + Aux. TX'])==54


def test_portfolio_summary_omits_details_without_changing_status(client,db,monkeypatch):
    plant, _, rows = setup_rows(db,monkeypatch)
    engineer(client,db,plant)
    assert submit(client,rows[0]).status_code==200
    full=client.get(BASE,params={'month':MONTH}).json()
    lite=client.get(BASE,params={'month':MONTH,'summary':True}).json()
    assert lite['as_of'] and lite['plants']==full['plants']
    assert len(lite['activities'])==len(full['activities'])
    for a,b in zip(lite['activities'],full['activities']):
        assert a=={k:b[k] for k in a}
        assert 'checks' not in a and 'checklist' not in a
    assert any(a['label']=='Locked' for a in lite['activities'])


def test_portfolio_date_and_compliance_filters(client, db, monkeypatch):
    monkeypatch.setattr("app.pmplan.tracking.business_today", lambda: date(2026, 12, 7))
    lkt = Plant(site_code="LKT01", plant_name="LKT Plant", status="active")
    behind = Plant(site_code="BHD01", plant_name="Behind Plant", status="active")
    not_started = Plant(site_code="NST01", plant_name="Not Started Plant", status="active")
    not_planned = Plant(site_code="NPL01", plant_name="Not Planned Plant", status="active")
    no_activity_plants = [
        Plant(site_code=f"NPL{i:02d}", plant_name=f"Not Planned {i:02d}", status="active")
        for i in range(2, 10)
    ]
    db.add_all([lkt, behind, not_started, not_planned, *no_activity_plants]); db.flush()
    rows = [
        PMTrackingActivity(plant_id=lkt.id, equipment="Inverter", equipment_id="INV 1",
                           scheduled_on=date(2026, 12, 1), status="Approved"),
        PMTrackingActivity(plant_id=lkt.id, equipment="Inverter", equipment_id="INV 2",
                           scheduled_on=date(2026, 12, 1), status="Approved"),
        *[PMTrackingActivity(plant_id=lkt.id, equipment="Inverter", equipment_id=f"INV {i}",
                            scheduled_on=date(2026, 12, 8)) for i in (7, 8, 9)],
        PMTrackingActivity(plant_id=behind.id, equipment="ACCB", equipment_id="ACCB 1",
                           scheduled_on=date(2026, 12, 5), status="Scheduled"),
        PMTrackingActivity(plant_id=not_started.id, equipment="VCB", equipment_id="VCB 1",
                           scheduled_on=date(2026, 12, 15), status="Scheduled"),
    ]
    db.add_all(rows); db.commit()
    login_user(client, db, role="O&M Head", email="pm-filter-head@example.com")

    response_sizes = {}

    def get(**params):
        response = client.get(BASE, params={"month": "2026-12", "summary": True, **params})
        assert response.status_code == 200, response.text
        response_sizes[params.get("date", params.get("compliance", "month"))] = len(response.content)
        return response.json()

    month = get()
    first = get(date="2026-12-01")
    assert [plant["site_code"] for plant in first["plants"]] == ["LKT01"]
    assert [activity["equipment_id"] for activity in first["activities"]] == ["INV 1", "INV 2"]
    assert len(first["activities"]) < len(month["activities"])
    assert response_sizes["2026-12-01"] < response_sizes["month"]
    eighth = get(date="2026-12-08")
    assert [activity["equipment_id"] for activity in eighth["activities"]] == ["INV 7", "INV 8", "INV 9"]
    empty = get(date="2026-12-06")
    assert empty["plants"] == [] and empty["activities"] == []

    assert [plant["site_code"] for plant in get(compliance="on_schedule")["plants"]] == ["LKT01"]
    assert [plant["site_code"] for plant in get(compliance="behind")["plants"]] == ["BHD01"]
    assert [plant["site_code"] for plant in get(compliance="not_started")["plants"]] == ["NST01"]
    unplanned = get(compliance="not_planned")["plants"]
    assert len(unplanned) == 9
    assert all(plant["site_code"].startswith("NPL") for plant in unplanned)
    combined = get(date="2026-12-08", compliance="on_schedule")
    assert [plant["site_code"] for plant in combined["plants"]] == ["LKT01"]
    assert len(combined["activities"]) == 3
    assert get(date="2026-12-01", compliance="behind")["plants"] == []
    assert client.get(BASE, params={"month": "2026-12", "date": "2026-11-30"}).status_code == 422


def test_recurring_plan_start_and_explicit_dates(client, db, monkeypatch):
    plant=Plant(site_code="ABH01",plant_name="ABHANERI",status="active")
    db.add(plant); db.flush()
    db.add(PMCyclePlan(plant_id=plant.id,notes="Imported\n[PM_TRACKING_START=2026-12-01]",phases=[
        {"phase":"Inverter","area":"Plant side","categories":["Inverter"],"start_day":1,"days":None,"step_days":2},
        {"phase":"IDT Transformer","area":"Plant side","categories":["Transformer"],"start_day":17,"days":1,"step_days":1},
    ]))
    db.add(PMTrackingActivity(plant_id=plant.id,equipment="Inverter",equipment_id="INV 7",scheduled_on=date(2026,12,8)))
    db.commit(); engineer(client,db,plant)
    nov=client.get(BASE,params={"month":"2026-11"}).json()
    assert not nov["plants"][0]["configured"] and not nov["legacy"] and not nov["activities"]
    dec=client.get(BASE,params={"month":"2026-12"}).json()
    assert dec["plants"][0]["configured"]
    assert [(a["equipment_id"],a["date"]) for a in dec["activities"]]==[("INV 7","2026-12-08")]
    assert not any(a.get("planPhase")=="Inverter" for a in dec["legacy"])
    assert any(a.get("planPhase")=="IDT Transformer" and a["date"]=="2026-12-17" for a in dec["legacy"])


def test_new_equipment_and_large_combined_checklist(client, db, monkeypatch):
    from app.pmplan.tracking import CATEGORIES
    assert set(CATEGORIES) == set(CHECKLISTS)
    combined=CHECKLISTS['4 Pole + ACDB + Aux. TX']
    assert [c.removeprefix('Auxiliary Transformer — ') for c in combined if c.startswith('Auxiliary Transformer — ')] == CHECKLISTS['IDT Transformer']
    assert len(combined)==54 and len(CHECKLISTS['GSS visit'])==49
    assert all(c.startswith('GSS-side ') for c in CHECKLISTS['GSS visit'])
    monkeypatch.setattr('app.pmplan.tracking.business_today', lambda: date(2026,11,25))
    plant=Plant(site_code='ABH01',plant_name='ABHANERI',status='active'); db.add(plant); db.flush()
    row=PMTrackingActivity(plant_id=plant.id,equipment='4 Pole + ACDB + Aux. TX',equipment_id='4 Pole — structure inspection',scheduled_on=date(2026,11,1))
    db.add(row); db.commit(); engineer(client,db,plant)
    assert len(state(client)[row.equipment_id]['checks'])==54
    data=[{'result':'OK'} for _ in combined]; data[-1]={'result':'N/A'}
    assert submit(client,row,data).status_code==422
    data[-1]['note']='This measurement is not applicable to the installed transformer; approved site procedure verified.'
    assert submit(client,row,[{'result':'N/A','note':'not applicable'} for _ in combined]).status_code==422
    assert submit(client,row,data).status_code==200
    saved=state(client)[row.equipment_id]['checklist']
    assert len(saved)==54 and saved[-1]['result']=='N/A'
    login_user(client,db,role='O&M Head',email='reviewer@example.com')
    assert act(client,row,'approve').status_code==200


def test_returned_legacy_checklist_keeps_original_task_version(client,db,monkeypatch):
    plant,_,rows=setup_rows(db,monkeypatch)
    row=rows[0]; row.status='Returned'; row.checklist=[{'task':'Original monthly task','result':'Not OK','note':'Review requested'}]; db.commit()
    engineer(client,db,plant)
    assert state(client)[row.equipment_id]['checks']==['Original monthly task']
    assert submit(client,row,[{'result':'OK'}]).status_code==200
    assert state(client)[row.equipment_id]['checklist'][0]['task']=='Original monthly task'


def test_daily_filter_keeps_legacy_only_work_and_cycle_markers(client, db, monkeypatch):
    from app.core.models import OMTask
    monkeypatch.setattr("app.pmplan.tracking.business_today", lambda: date(2026, 12, 5))
    login_user(client, db, role="O&M Head", email="legacy-daily@example.com")
    legacy = Plant(site_code="LEG01", plant_name="Legacy only", status="active")
    marker = Plant(site_code="PLN01", plant_name="Plan only", status="active")
    empty = Plant(site_code="EMP01", plant_name="No work", status="active")
    db.add_all([legacy, marker, empty]); db.flush()
    db.add(OMTask(plant_id=legacy.id, work_order_no="LEG-DAY-01", task_name="Inverter PM", task_type="Inverter", due_on=date(2026,12,5), status="Scheduled"))
    db.add(PMCyclePlan(plant_id=marker.id, phases=[{"phase":"ACCB","area":"Plant side","categories":["ACCB Panel"],"start_day":5,"days":1,"step_days":1}]))
    db.commit()
    r = client.get(BASE, params={"month":"2026-12","date":"2026-12-05"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert {p["site_code"] for p in body["plants"]} == {"LEG01", "PLN01"}
    assert {x["source"] for x in body["legacy"]} == {"database", "cycle_plan"}
    assert not body["activities"]
    assert all(x["date"] == "2026-12-05" for x in body["legacy"])
    assert client.get(BASE, params={"month":"2026-12","date":"2026-12-06"}).json()["plants"] == []
    engineer(client, db, legacy, "legacy-daily-se@example.com")
    scoped = client.get(BASE, params={"month":"2026-12","date":"2026-12-05"}).json()
    assert {p["site_code"] for p in scoped["plants"]} == {"LEG01"}
