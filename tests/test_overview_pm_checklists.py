from app.core.models import Plant
from app.core.timeutil import business_today
from app.pmplan.tracking import PMTrackingActivity
from tests.conftest import grant_assignee_plants, login_user


def test_overview_checklist_counts_and_scope(client, db):
    login_user(client, db)
    today = business_today()
    p = Plant(site_code='PMA01', plant_name='A')
    q = Plant(site_code='PMB01', plant_name='B')
    db.add_all([p,q]); db.commit()
    a = PMTrackingActivity(plant_id=p.id,equipment='Inverter',equipment_id='INV1',scheduled_on=today,status='Pending approval')
    b = PMTrackingActivity(plant_id=q.id,equipment='Inverter',equipment_id='INV2',scheduled_on=today,status='Approved')
    db.add_all([a,b]); db.commit()
    r = client.get('/api/portal/overview/range?period=month')
    assert r.status_code == 200, r.text
    data = r.json()
    assert data['totals']['pmChecklist']['scheduled'] == 2
    assert data['totals']['pmChecklist']['approved'] == 1
    assert data['totals']['pmChecklist']['pendingApproval'] == 1
    assert data['totals']['pmCompleted'] == 0
    before = client.get('/api/portal/overview?version_only=true').json()['dataVersion']
    approved = client.post(f'/api/pm-plan/tracking/{a.id}/action', json={'action': 'approve'})
    assert approved.status_code == 200, approved.text
    after = client.get('/api/portal/overview?version_only=true').json()['dataVersion']
    assert before != after
    user = login_user(client, db, role='Assignee', email='checklist-scope@example.com')
    grant_assignee_plants(db,user.id,p.id)
    r = client.get('/api/portal/overview/range?period=month')
    assert r.status_code == 200, r.text
    assert r.json()['totals']['pmChecklist']['scheduled'] == 1
    assert r.json()['totals']['pmChecklist']['approved'] == 1
    assert next(x for x in r.json()['rows'] if x['plant']['site_code']=='PMB01')['profile']['pmChecklist'] is None
