"""Synthetic 42/72-plant API budget, with 12 months of maintenance history.
Wall-clock timings are diagnostic; only bounded query counts and bytes are gates.
"""
from datetime import date, datetime, timezone
from statistics import median
from time import perf_counter
import json
import pytest
from sqlalchemy import event
from app.core.models import Plant, Issue, Notification, PlantResponsibility, WashingConfig
from app.pmplan.tracking import PMTrackingActivity, CHECKLISTS
from app.notifications import router as nr
from tests.conftest import login_user
from tests.test_equipment_responsibility import _act_as

@pytest.mark.parametrize('size',[42,72])
def test_growth(client,db,monkeypatch,size):
    monkeypatch.setattr(nr,'business_today',lambda: date(2026,12,15))
    head=login_user(client,db,role='O&M Head',email='growth-head@example.com')
    assignee=login_user(client,db,role='Assignee',email='growth-owner@example.com')
    other=login_user(client,db,role='Assignee',email='growth-other@example.com')
    for i in range(size):
        p=Plant(site_code=f'G{i:03}',plant_name=f'Growth Plant {i}',status='active');db.add(p);db.flush()
        db.add(WashingConfig(plant_id=p.id,assigned_user_id=assignee.id if i%3==0 else other.id,tables_per_cycle=500))
        db.add(PlantResponsibility(plant_id=p.id,area='pm',assigned_user_id=assignee.id if i%3==0 else other.id))
        for j in range(10):
            db.add(Issue(ticket_no=f'G-{i}-{j}',plant_id=p.id,vertical='Inverter',description='Synthetic field issue',severity='Critical' if j==0 else 'Medium',status='Open',assigned_to=assignee.id if i%3==0 else other.id))
        if i>=size-9:continue
        for mo in range(12):
            year=2026+(mo+11)//12; month=(mo+11)%12+1
            for j,e in enumerate(['Inverter']*9+[e for e in CHECKLISTS if e!='Inverter']):
                db.add(PMTrackingActivity(plant_id=p.id,equipment=e,equipment_id=f'{e} {j}',scheduled_on=date(year,month,1+(i+j*3)%28),status='Pending approval' if j==0 else 'Scheduled',permission='Requested' if j==1 else 'None'))
    for i in range(size*25):
        db.add(Notification(user_id=assignee.id if i%3==0 else other.id,title='Synthetic alert',event_type='issue_created',read_at=None if i%5==0 else datetime(2026,11,1,tzinfo=timezone.utc)))
    db.commit();bind=db.get_bind();statements=[]
    def cap(conn,cursor,statement,*a):statements.append(statement)
    event.listen(bind,'before_cursor_execute',cap)
    try:
        for u,paths in [(head,{'plants':'/api/portal/plants','overview':'/api/portal/overview','dashboard_entry':'/api/portal/overview/range?period=month','inverter_summary':'/api/issues/equipment-summary?vertical=Inverter','version':'/api/portal/overview?version_only=true','pm_month':'/api/pm-plan/tracking?month=2026-12&summary=true','pm_day':'/api/pm-plan/tracking?month=2026-12&summary=true&date=2026-12-15','cleaning':'/api/scheduled/washing/overview?summary=true&include_reports=false','issues':'/api/issues?limit=200','head_notifications':'/api/notifications/summary?preview=true'}),(assignee,{'my_issues':'/api/issues?mine=true&limit=200','my_notifications':'/api/notifications/summary?preview=true'})]:
            _act_as(db,u)
            for key,path in paths.items():
                times=[]
                for _ in range(5):
                    statements.clear();t=perf_counter();r=client.get(path);times.append((perf_counter()-t)*1000);assert r.status_code==200,(key,r.text[:500])
                print('GROWTH',size,key,json.dumps({'queries':len(statements),'bytes':len(r.content),'ms':round(median(times[1:]),2)}))
                query_budget, byte_budget = {
                    'plants': (2, 80_000), 'overview': (12, 250_000), 'version': (3, 1_000),
                    'dashboard_entry': (20, 250_000), 'inverter_summary': (2, 15_000),
                    'pm_month': (9, 550_000), 'pm_day': (11, 50_000),
                    'cleaning': (5, 250_000), 'issues': (2, 200_000),
                    'my_issues': (2, 200_000), 'head_notifications': (3, 8_000),
                    'my_notifications': (4, 8_000),
                }[key]
                assert len(statements) <= query_budget, (key, size, len(statements))
                assert len(r.content) < byte_budget, (key, size, len(r.content))
                if key == 'dashboard_entry':
                    assert len(r.json()['rows']) == size
                if key == 'inverter_summary':
                    assert len(r.json()['plants']) == size
                if key == 'pm_month':
                    assert len(r.json()['plants']) == size
                    assert len(r.json()['activities']) == (size-9)*(9+len(CHECKLISTS)-1)
                if key == 'my_notifications':
                    actions = {a['kind']: a['count'] for a in r.json()['actions']}
                    assert actions['issue_assigned'] == ((size+2)//3)*10
                    assert actions['issue_critical'] == (size+2)//3
                    assert len(r.json()['recent_unread']) == 5
    finally:event.remove(bind,'before_cursor_execute',cap)
