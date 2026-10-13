"""Work Radar and live search must remain truthful, scoped, and non-mutating."""
from datetime import date, timedelta
from uuid import UUID
from app.core.models import User, UserEquipmentTypeAssignment, UserPlantAssignment, WashingConfig, WashingTable, Equipment
from tests import conftest
from tests.test_field_desk import fixture_data


def test_washing_worklist_distinguishes_tables_from_equipment(client, db):
    head, engineer, plants = fixture_data(client, db)
    today = date.today()
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
    conftest._CURRENT_USER=db.get(User,engineer.id)
    res=client.get('/api/field/search',params={'q':'Inverter'})
    assert res.status_code==200
    assert all(row['plant']=='Field FE01' for row in res.json()['records'])
    assert all('secret' not in row for row in res.json()['records'])
    res=client.get('/api/field/search',params={'q':'INV-0002'})
    assert res.json()['records']==[]
    conftest._CURRENT_USER=db.get(User,head.id)
    assert any(row['id']=='INV-0002' for row in client.get('/api/field/search',params={'q':'INV-0002'}).json()['records'])
    viewer=User(auth_provider='test',external_subject='unapproved',email='unapproved@solar91.test',display_name='Unapproved',role='Viewer',is_active=True)
    db.add(viewer);db.commit();conftest._CURRENT_USER=viewer
    assert client.get('/api/field/search',params={'q':'inverter'}).status_code==403


def test_asset_pages_reference_interactive_workboard(client, db):
    page=client.get('/').text
    assert '37-work-radar.js' in page
    assert '37-work-radar.css' in page


def test_assistant_is_live_role_scoped_and_read_only(client, db, monkeypatch):
    monkeypatch.delenv('AI_ASSISTANT_ENABLED', raising=False)
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    head, engineer, plants=fixture_data(client,db)
    conftest._CURRENT_USER=db.get(User,engineer.id)
    before=db.query(__import__('app.core.models',fromlist=['Issue']).Issue).count()
    response=client.post('/api/field/ask',json={'question':'Inspect combiner','recent_questions':['Show issues']})
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
