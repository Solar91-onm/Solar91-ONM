"""Regression coverage for the daily site-engineer and O&M work queue."""
from datetime import date, timedelta
from uuid import UUID

from app.core.timeutil import business_today
from app.core.models import AuditLog, Issue, IssueHistory, OMTask, Plant, User, UserEquipmentTypeAssignment, UserPlantAssignment
from tests.conftest import login_user
from tests import conftest


def fixture_data(client, db):
    head = login_user(client, db, role='O&M Head', name='Field Head', email='field-head@example.com')
    plants=[]
    for code in ('FE01', 'FE02'):
        res=client.post('/api/plants',json={'site_code':code,'plant_name':'Field '+code})
        assert res.status_code==201, res.text
        plants.append(res.json())
    for i,plant in enumerate(plants):
        resp=client.post('/api/issues',json={'plant_id':plant['id'],'description':f'Inspect combiner {i}',
                                                    'vertical':'Inverter','severity':'Critical' if i==0 else 'Medium'})
        assert resp.status_code==201, resp.text
    db.add(OMTask(work_order_no='FIELD-PM-1',plant_id=UUID(plants[0]['id']),task_name='Check inverter',
                  task_type='Inverter',status='Scheduled',due_on=business_today()-timedelta(days=2)))
    db.add(OMTask(work_order_no='FIELD-PM-2',plant_id=UUID(plants[1]['id']),task_name='Inspect module',
                  task_type='Module',status='Scheduled',due_on=business_today()+timedelta(days=3)))
    db.commit()
    engineer=User(auth_provider='test',external_subject='field-engineer',email='field-engineer@example.com',
                  display_name='Field Engineer',role='Site Engineer',is_active=True)
    db.add(engineer);db.commit();db.refresh(engineer)
    db.add(UserPlantAssignment(user_id=engineer.id,plant_id=UUID(plants[0]['id']),assignment_role='Site Engineer'))
    db.commit()
    return head,engineer,plants


def test_engineer_only_sees_own_plant_and_can_post_field_updates(client,db):
    head,engineer,plants=fixture_data(client,db)
    conftest._CURRENT_USER=db.get(User,engineer.id)
    overview=client.get('/api/field/overview').json()
    assert overview['scope']=='one-plant'
    assert len(overview['plants'])==1 and overview['plants'][0]['code']=='FE01'
    assert [x['plant'] for x in overview['issues']]==['Field FE01']
    assert [x['id'] for x in overview['tasks']]==['FIELD-PM-1']
    issue=overview['issues'][0]
    response=client.post('/api/field/issues/'+issue['id']+'/updates',json={
        'note':'Checked connections and panel temperatures','day_status':'Worked',
        'hours':1.25,'next_step':'Check thermal scan tomorrow'})
    assert response.status_code==200, response.text
    db.expire_all()
    db_issue=db.get(Issue,UUID(issue['id']))
    assert db_issue.status=='Open'   # site engineer cannot advance/close the O&M ticket
    assert db_issue.legacy_payload['progress'][0]['note']=='Checked connections and panel temperatures'
    assert db.query(IssueHistory).filter_by(issue_id=db_issue.id,action='issue.site_field_update').count()==1
    assert db.query(AuditLog).filter_by(entity_id=str(db_issue.id)).count()>=1
    other=db.query(Issue).filter(Issue.plant_id==UUID(plants[1]['id'])).first()
    assert client.post(f'/api/field/issues/{other.id}/updates',json={'note':'Try updating wrong plant'}).status_code==403
    assert client.post(f'/api/field/issues/{issue["id"]}/updates',json={'note':'x'}).status_code==422
    assert client.post(f'/api/field/issues/{issue["id"]}/updates',json={'note':'Future report','work_date':'2099-01-01'}).status_code==422
    assert client.post(f'/api/issues/{issue["id"]}/close',json={'note':'No permission','direct':True}).status_code==403


def test_role_access_and_read_only_viewer(client,db):
    head,engineer,plants=fixture_data(client,db)
    conftest._CURRENT_USER=db.get(User,head.id)
    head_overview=client.get('/api/field/overview').json()
    assert len(head_overview['plants'])==2 and len(head_overview['issues'])==2
    admin=User(auth_provider='test',external_subject='field-admin',email='observer@example.com',
               display_name='Read-only Operations Viewer',role='Administration',is_active=True)
    pending=User(auth_provider='test',external_subject='field-pending',email='pending@example.com',
                 display_name='Pending Signup',role='Viewer',is_active=True)
    assignee=User(auth_provider='test',external_subject='field-assignee',email='assignee@example.com',
                  display_name='Equipment Team',role='Assignee',is_active=True)
    db.add_all([admin,pending,assignee]);db.commit()
    db.add(UserEquipmentTypeAssignment(user_id=assignee.id,equipment_type='Inverter'));db.commit()
    conftest._CURRENT_USER=db.get(User,admin.id)
    assert len(client.get('/api/field/overview').json()['issues'])==2
    issue=head_overview['issues'][0]
    assert client.post(f'/api/field/issues/{issue["id"]}/updates',json={'note':'Forbidden note'}).status_code==403
    conftest._CURRENT_USER=db.get(User,pending.id)
    assert client.get('/api/field/overview').status_code==403
    conftest._CURRENT_USER=db.get(User,assignee.id)
    scoped=client.get('/api/field/overview').json()
    assert len(scoped['issues'])==2
    assert [x['id'] for x in scoped['tasks']]==['FIELD-PM-1']
    assert client.post(f'/api/field/issues/{issue["id"]}/updates',json={'note':'Forbidden note'}).status_code==403


def test_closed_tickets_reject_field_updates_and_no_unassigned_site_leak(client,db):
    head,engineer,plants=fixture_data(client,db)
    issue=db.query(Issue).filter_by(plant_id=UUID(plants[0]['id'])).first()
    issue.status='Closed';db.commit()
    conftest._CURRENT_USER=db.get(User,engineer.id)
    data=client.get('/api/field/overview').json()
    assert data['summary']['open_issues']==0
    assert client.post(f'/api/field/issues/{issue.id}/updates',json={'note':'Inspect closed ticket'}).status_code==409
    db.query(UserPlantAssignment).filter_by(user_id=engineer.id).delete();db.commit()
    empty=client.get('/api/field/overview').json()
    assert empty['scope']=='none' and empty['plants']==[] and empty['issues']==[]


def test_assignee_field_overview_query_count_does_not_grow_with_work_rows(client,db):
    head,_,plants=fixture_data(client,db)
    assignee=User(auth_provider='test',external_subject='field-batch-assignee',email='batch@example.com',
                  display_name='Batch Assignee',role='Assignee',is_active=True)
    db.add(assignee);db.flush()
    db.add(UserEquipmentTypeAssignment(user_id=assignee.id,equipment_type='Inverter'));db.commit()
    conftest._CURRENT_USER=db.get(User,assignee.id)

    def request_query_count():
        response=client.get('/api/field/overview?limit=50')
        assert response.status_code==200,response.text
        return int(response.headers['server-timing'].split('desc="')[1].split()[0])

    small_count=request_query_count()
    plant_id=UUID(plants[0]['id'])
    db.add_all([Issue(ticket_no=f'BATCH-{n:04d}',plant_id=plant_id,vertical='Inverter',
                      description='Synthetic field issue',severity='Medium',status='Open') for n in range(12)])
    db.add_all([OMTask(work_order_no=f'BATCH-PM-{n:04d}',plant_id=plant_id,task_name='Synthetic PM',
                       task_type='Inverter',status='Scheduled',due_on=business_today()) for n in range(12)])
    db.commit()
    large_count=request_query_count()
    assert large_count==small_count
    assert large_count<=12
