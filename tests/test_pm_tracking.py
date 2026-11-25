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
    assert submit(client,rows[0],[{'result':'Not OK'}]*5).status_code==422
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
    assert 'VCB' not in CHECKLISTS and 'IDT Transformer' not in CHECKLISTS
    assert 'Weather Station & UPS' not in CHECKLISTS and 'Fire & Safety' not in CHECKLISTS
    assert len(CHECKLISTS['4 Pole + ACDB + Aux. TX'])==1


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
