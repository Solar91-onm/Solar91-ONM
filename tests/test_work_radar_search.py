"""Work Radar and live search must remain truthful, scoped, and non-mutating."""
from datetime import date, datetime, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo
from app.core.timeutil import business_today
from app.core.models import User, UserEquipmentTypeAssignment, UserPlantAssignment, WashingConfig, WashingTable, WashingDailyReport, Equipment, Issue, OMTask
from tests import conftest
from tests.test_field_desk import fixture_data


def test_washing_worklist_distinguishes_tables_from_equipment(client, db):
    head, engineer, plants = fixture_data(client, db)
    today = business_today()
    for i, p in enumerate(plants):
        plant_id = UUID(p['id'])
        db.add(WashingConfig(plant_id=plant_id, active=True))
        db.add(WashingTable(legacy_id=f'PANEL-{i}', plant_id=plant_id,
                            table_code=f'ARRAY-{i}', next_due_on=today + timedelta(days=i*6-1)))
    db.commit()
    conftest._CURRENT_USER = db.get(User, engineer.id)
    response=client.get('/api/field/overview')
    assert response.status_code == 200
    rows=response.json()['washing']
    assert len(rows)==1 and rows[0]['table']=='ARRAY-0'
    assert rows[0]['equipment']=='Solar panel table'
    assert rows[0]['overdue_days']==1
    assert response.json()['summary']['washing_overdue']==1
    conftest._CURRENT_USER=db.get(User,head.id)
    assert len(client.get('/api/field/overview').json()['washing'])==2
    worker = User(auth_provider='test',external_subject='washer-assignee',email='washing@solar91.test',display_name='Washing worker',role='Assignee',is_active=True)
    db.add(worker);db.commit()
    conftest._CURRENT_USER=worker
    assert client.get('/api/field/overview').json()['washing']==[]
    db.add(UserEquipmentTypeAssignment(user_id=worker.id,equipment_type='Modules cleaning'));db.commit()
    conftest._CURRENT_USER=db.get(User,worker.id)
    assert len(client.get('/api/field/overview').json()['washing'])==2


def test_live_search_scopes_plant_and_equipment(client, db):
    head, engineer, plants=fixture_data(client, db)
    db.add_all([
        Equipment(plant_id=UUID(plants[0]['id']), equipment_name='Inv alpha',equipment_code='INV-0001',equipment_type='Inverter'),
        Equipment(plant_id=UUID(plants[1]['id']), equipment_name='Inv beta',equipment_code='INV-0002',equipment_type='Inverter'),
    ]);db.commit()
    from app.field.router import run_operational_search
    conftest._CURRENT_USER=db.get(User,engineer.id)
    assert client.get('/api/field/search',params={'q':'Inverter'}).status_code==403  # no Ask Solar91 for Site Engineers
    engineer=db.get(User,engineer.id)
    res=run_operational_search(db,engineer,'Inverter')
    assert res['records'] and all(row['plant']=='Field FE01' for row in res['records'])
    assert all('secret' not in row for row in res['records'])
    assert run_operational_search(db,engineer,'INV-0002')['records']==[]
    conftest._CURRENT_USER=db.get(User,head.id)
    assert any(row['id']=='INV-0002' for row in client.get('/api/field/search',params={'q':'INV-0002'}).json()['records'])
    viewer=User(auth_provider='test',external_subject='unapproved',email='unapproved@solar91.test',display_name='Unapproved',role='Viewer',is_active=True)
    db.add(viewer);db.commit();conftest._CURRENT_USER=viewer
    assert client.get('/api/field/search',params={'q':'inverter'}).status_code==403


def test_asset_pages_no_longer_reference_work_radar(client, db):
    page=client.get('/').text
    assert '37-work-radar.js' not in page
    assert '37-work-radar.css' not in page
    assert '36-field-desk.js' not in page
    assert '36-field-desk.css' not in page


def test_assistant_is_live_role_scoped_and_read_only(client, db, monkeypatch):
    monkeypatch.delenv('AI_ASSISTANT_ENABLED', raising=False)
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    head, engineer, plants=fixture_data(client,db)
    conftest._CURRENT_USER=db.get(User,engineer.id)
    assert client.post('/api/field/ask',json={'question':'Inspect combiner'}).status_code==403  # no Ask Solar91 for Site Engineers
    module_worker=User(auth_provider='test',external_subject='ask-module',email='ask-module@solar91.test',display_name='Module worker',role='Assignee',is_active=True)
    db.add(module_worker);db.commit()
    db.add(UserEquipmentTypeAssignment(user_id=module_worker.id,equipment_type='Module'));db.commit()
    conftest._CURRENT_USER=db.get(User,module_worker.id)
    scoped=client.post('/api/field/ask',json={'question':'Inspect combiner'}).json()
    assert not any('combiner' in str(x.get('title','')).lower() for x in scoped['records'])  # inverter issues are outside a Module scope
    conftest._CURRENT_USER=db.get(User,head.id)
    before=db.query(__import__('app.core.models',fromlist=['Issue']).Issue).count()
    response=client.post('/api/field/ask',json={'question':'Inspect combiner at FE01','recent_questions':['Show issues']})
    assert response.status_code==200,response.text
    data=response.json()
    assert data['mode']=='grounded-search'
    assert data['records'] and all(x['plant']=='Field FE01' for x in data['records'])
    assert db.query(__import__('app.core.models',fromlist=['Issue']).Issue).count()==before
    assert client.post('/api/field/ask',json={'question':'x'}).status_code==422
    assert client.post('/api/field/ask',json={'question':'hello','recent_questions':['x']*5}).status_code==422
    viewer=User(auth_provider='test',external_subject='assistant-viewer',email='assistant-viewer@solar91.test',display_name='Pending',role='Viewer',is_active=True)
    db.add(viewer);db.commit();conftest._CURRENT_USER=viewer
    assert client.post('/api/field/ask',json={'question':'combiner'}).status_code==403


def test_assistant_exact_overdue_issue_count_is_scoped_and_bounded(client, db):
    head, engineer, plants=fixture_data(client,db)
    today=datetime.now(ZoneInfo('Asia/Kolkata')).date()
    for index in range(503):
        plant_id=UUID(plants[0]['id'] if index < 501 else plants[1]['id'])
        db.add(Issue(ticket_no=f'ASK-OVERDUE-{index:04d}',plant_id=plant_id,
                     description='Grounded overdue issue',severity='High',status='Open',
                     vertical='Inverter',etc_at=datetime.combine(today-timedelta(days=1),datetime.min.time())))
    db.commit()
    conftest._CURRENT_USER=db.get(User,engineer.id)
    assert client.post('/api/field/ask',json={'question':'How many overdue issues?'}).status_code==403
    conftest._CURRENT_USER=db.get(User,head.id)
    response=client.post('/api/field/ask',json={'question':'How many overdue issues?'})
    assert response.status_code==200,response.text
    data=response.json()
    assert data['mode']=='grounded-query'
    assert data['total']==503
    assert data['summary']=={'label':'Overdue open issues','value':503}
    assert len(data['records'])==20 and data['limited'] is True
    module_worker=User(auth_provider='test',external_subject='ask-overdue-module',email='ask-overdue@solar91.test',display_name='Module worker',role='Assignee',is_active=True)
    db.add(module_worker);db.commit()
    db.add(UserEquipmentTypeAssignment(user_id=module_worker.id,equipment_type='Module'));db.commit()
    conftest._CURRENT_USER=db.get(User,module_worker.id)
    scoped=client.post('/api/field/ask',json={'question':'How many overdue issues?'}).json()
    assert scoped['total']==0 and scoped['records']==[]  # every overdue issue is an inverter issue


def test_assistant_washing_counts_are_date_accurate_and_permission_scoped(client, db):
    head, engineer, plants=fixture_data(client,db)
    today=datetime.now(ZoneInfo('Asia/Kolkata')).date()
    for item in plants:
        db.add(WashingConfig(plant_id=UUID(item['id']),active=True))
    db.add_all([
        WashingDailyReport(plant_id=UUID(plants[0]['id']),cycle_month=today.strftime('%Y-%m'),cycle_no=1,
            report_date=today,job_status='Completed',tables_cleaned=12,reported_by='Engineer',review_status='Confirmed'),
        WashingDailyReport(plant_id=UUID(plants[0]['id']),cycle_month=today.strftime('%Y-%m'),cycle_no=1,
            report_date=today,job_status='Completed',tables_cleaned=3,reported_by='Engineer',review_status='Pending'),
        WashingDailyReport(plant_id=UUID(plants[1]['id']),cycle_month=today.strftime('%Y-%m'),cycle_no=1,
            report_date=today,job_status='Completed',tables_cleaned=99,reported_by='Engineer',review_status='Confirmed'),
    ])
    db.commit()
    conftest._CURRENT_USER=db.get(User,engineer.id)
    assert client.post('/api/field/ask',json={'question':'Which washing records are awaiting confirmation?'}).status_code==403
    conftest._CURRENT_USER=db.get(User,head.id)
    response=client.post('/api/field/ask',json={'question':f'How many washing tables were cleaned at Field FE01 on {today.isoformat()}?'})
    assert response.status_code==200,response.text
    data=response.json()
    assert data['summary']=={'label':'Confirmed tables cleaned','value':12}
    assert data['breakdown']==[{'label':'Confirmed','value':12},{'label':'Pending review','value':3}]
    assert all(row['site_code']=='FE01' for row in data['records'])
    conftest._CURRENT_USER=db.get(User,head.id)
    pending=client.post('/api/field/ask',json={'question':'Which washing records are awaiting confirmation?'})
    assert pending.status_code==200,pending.text
    assert pending.json()['total']==1
    assert pending.json()['records'][0]['site_code']=='FE01'
    admin=User(auth_provider='test',external_subject='wash-assistant-admin',email='wash-admin@example.test',
               display_name='Report administrator',role='Administration',is_active=True)
    db.add(admin);db.commit();conftest._CURRENT_USER=db.get(User,admin.id)
    hidden=client.post('/api/field/ask',json={'question':'Which washing reports are awaiting confirmation?'})
    assert hidden.status_code==200 and hidden.json()['total']==0
    assert hidden.json()['records']==[] and 'outside the data scope' in hidden.json()['answer']


def test_optional_ai_receives_only_current_question_and_scoped_records(client, db, monkeypatch):
    import httpx
    head, engineer, plants=fixture_data(client,db)
    conftest._CURRENT_USER=db.get(User,head.id)
    monkeypatch.setenv('AI_ASSISTANT_ENABLED','true')
    monkeypatch.setenv('OPENAI_API_KEY','test-only')
    sent={}
    class Response:
        def raise_for_status(self): pass
        def json(self):
            return {'output':[{'content':[{'type':'output_text','text':'One authorized inverter issue is available.'}]}]}
    def post(url,**kwargs):
        sent.update(kwargs['json'])
        return Response()
    monkeypatch.setattr(httpx,'post',post)
    response=client.post('/api/field/ask',json={'question':'Inspect combiner at FE01','recent_questions':['expired private chat']})
    assert response.status_code==200 and response.json()['mode']=='AI-grounded'
    assert response.json()['answer'].startswith('I found 1 matching record')
    assert response.json()['narration']=='One authorized inverter issue is available.'
    serialized=str(sent['input'])
    assert 'Inspect combiner' in serialized
    assert 'expired private chat' not in serialized
    assert all(record['plant']=='Field FE01' for record in response.json()['records'])

    class MalformedResponse(Response):
        def json(self): return {'output':None}
    monkeypatch.setattr(httpx,'post',lambda url,**kwargs:MalformedResponse())
    malformed=client.post('/api/field/ask',json={'question':'Inspect combiner'})
    assert malformed.status_code==200
    assert malformed.json()['mode']=='grounded-search'
    assert malformed.json()['narration'] is None


def test_assistant_issue_status_breakdown_uses_selected_week(client, db):
    head, engineer, plants=fixture_data(client,db)
    today=datetime.now(ZoneInfo('Asia/Kolkata')).date()
    old=db.query(Issue).filter_by(plant_id=UUID(plants[0]['id'])).first()
    old.updated_at=datetime.combine(today-timedelta(days=10),datetime.min.time())
    current=Issue(ticket_no='ASK-STATUS-CURRENT',plant_id=UUID(plants[0]['id']),description='Current status fixture',
                  severity='Low',status='Assigned',vertical='Inverter',updated_at=datetime.now(ZoneInfo('UTC')))
    db.add(current);db.commit()
    conftest._CURRENT_USER=db.get(User,head.id)
    response=client.post('/api/field/ask',json={'question':'Summarize issues by status this week'})
    assert response.status_code==200,response.text
    data=response.json()
    assert data['summary']['value']==2
    assert data['breakdown']==[{'label':'Assigned','value':1},{'label':'Open','value':1}]
    assert all(row['id']!=str(old.id) for row in data['records'])


def test_assistant_my_assigned_work_uses_authenticated_assignment_ids(client, db):
    head, engineer, plants=fixture_data(client,db)
    assignee=User(auth_provider='test',external_subject='assistant-assignee',email='assistant-assignee@example.test',
                  display_name='Inverter Assignee',role='Assignee',is_active=True)
    db.add(assignee);db.commit();db.refresh(assignee)
    db.add(UserEquipmentTypeAssignment(user_id=assignee.id,equipment_type='Inverter'))
    issue=Issue(ticket_no='ASK-ME-ISSUE',plant_id=UUID(plants[0]['id']),description='Assigned issue',severity='High',
                status='In Progress',vertical='Inverter',assigned_to=assignee.id,assignee_text=assignee.display_name)
    db.add(issue)
    db.add(OMTask(work_order_no='ASK-ME-PM',plant_id=UUID(plants[0]['id']),task_name='Assigned PM',task_type='Inverter',
                  status='In Progress',assignee_user_id=assignee.id,assignee_text=assignee.display_name))
    db.add(OMTask(work_order_no='ASK-OTHER-PM',plant_id=UUID(plants[0]['id']),task_name='Other type PM',task_type='Module',status='Scheduled'))
    db.commit();conftest._CURRENT_USER=db.get(User,assignee.id)
    response=client.post('/api/field/ask',json={'question':'Show my assigned work'})
    assert response.status_code==200,response.text
    data=response.json()
    assert data['summary']['value']==2
    assert {row['id'] for row in data['records']}=={'ASK-ME-PM',str(issue.id)}
