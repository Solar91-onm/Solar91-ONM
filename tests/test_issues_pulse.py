"""The pulse endpoint is the cheap change-detector open browsers poll every ~30 s."""
from app.core.models import Plant
from tests.conftest import login_user


def make_plant(db, code='PULSE-QA'):
    plant = Plant(site_code=code, plant_name='Pulse Test Solar Plant ' + code)
    db.add(plant); db.commit(); db.refresh(plant)
    return plant


def test_pulse_changes_when_a_ticket_is_raised_and_when_it_is_hidden(client, db):
    plant = make_plant(db)
    login_user(client, db, role='O&M Head', name='Pulse Manager', email='pulse-manager@example.com')
    empty = client.get('/api/issues/pulse')
    assert empty.status_code == 200, empty.text
    assert empty.json() == {'count': 0, 'latest': None, 'tasks': '0|'}

    created = client.post('/api/issues', json={'plant_id': str(plant.id), 'description': 'Breather damaged', 'severity': 'Low', 'vertical': 'Transformer'})
    assert created.status_code == 201, created.text
    after_create = client.get('/api/issues/pulse').json()
    assert after_create['count'] == 1 and after_create['latest']
    assert after_create != empty.json()

    issue = created.json()
    deleted = client.request('DELETE', f"/api/issues/{issue['id']}", json={'confirm_ticket': issue['ticket_no'], 'reason': 'Duplicate entered by mistake'})
    assert deleted.status_code == 200, deleted.text
    assert client.get('/api/issues/pulse').json()['count'] == 0


def test_pulse_does_not_swallow_the_issue_list_route(client, db):
    make_plant(db, 'PULSE-QB')
    login_user(client, db, role='O&M Head', name='Pulse Manager 2', email='pulse-manager2@example.com')
    assert client.get('/api/issues').status_code == 200
    assert client.get('/api/issues/pulse').status_code == 200


def test_bootstrap_audit_rows_stay_small(client, db):
    login_user(client, db, role='O&M Head', name='Pulse Manager 3', email='pulse-manager3@example.com')
    state = client.get('/api/bootstrap').json()['state']
    assert all('before' not in row and 'after' not in row for row in state.get('audit', []))
    assert len(state.get('audit', [])) <= 500


def test_pulse_is_shared_briefly_and_dropped_after_a_write(client, db):
    from app.core.models import Issue
    plant = make_plant(db, 'PULSE-QC')
    login_user(client, db, role='O&M Head', name='Pulse Manager 4', email='pulse-manager4@example.com')
    assert client.get('/api/issues/pulse').json()['count'] == 0
    # a change that did not go through this worker's API (e.g. another worker) shows once the short cache expires
    db.add(Issue(plant_id=plant.id, ticket_no='T-PULSE-1', description='x', severity='Medium', status='Open', vertical='Inverter'))
    db.commit()
    assert client.get('/api/issues/pulse').json()['count'] == 0
    from app.issues import router as issues_router
    issues_router._pulse_cache.clear()
    assert client.get('/api/issues/pulse').json()['count'] == 1
    # a write through the API drops the cache at once
    created = client.post('/api/issues', json={'plant_id': str(plant.id), 'description': 'Fan noise', 'severity': 'Low', 'vertical': 'Inverter'})
    assert created.status_code == 201, created.text
    assert client.get('/api/issues/pulse').json()['count'] == 2


def test_assignee_pulse_needs_an_equipment_type(client, db):
    from app.core.models import UserEquipmentTypeAssignment
    plant = make_plant(db, 'PULSE-QD')
    login_user(client, db, role='O&M Head', name='Pulse Manager 5', email='pulse-manager5@example.com')
    assert client.post('/api/issues', json={'plant_id': str(plant.id), 'description': 'Trip', 'severity': 'Low', 'vertical': 'Inverter'}).status_code == 201
    assignee = login_user(client, db, role='Assignee', name='Pulse Assignee', email='pulse-assignee@example.com')
    assert client.get('/api/issues/pulse').json() == {'count': 0, 'latest': None, 'tasks': '0|'}
    db.add(UserEquipmentTypeAssignment(user_id=assignee.id, equipment_type='Inverter')); db.commit()
    from app.issues import router as issues_router
    issues_router._pulse_cache.clear()
    assert client.get('/api/issues/pulse').json()['count'] == 1


def test_pulse_changes_when_pm_work_changes(client, db):
    from datetime import date
    from app.core.models import OMTask
    plant = make_plant(db, 'PULSE-QE')
    login_user(client, db, role='O&M Head', name='Pulse Manager 6', email='pulse-manager6@example.com')
    before = client.get('/api/issues/pulse').json()
    assert before['tasks'] == '0|'
    db.add(OMTask(work_order_no='WO-PULSE-1', plant_id=plant.id, task_name='ACDB PM', task_type='ACDB',
                  frequency='Monthly', due_on=date(2026, 11, 15), status='Scheduled'))
    db.commit()
    from app.issues import router as issues_router
    issues_router._pulse_cache.clear()       # as after the short cache expires, or a write on this worker
    after = client.get('/api/issues/pulse').json()
    assert after['tasks'].startswith('1|') and after['count'] == before['count']      # no issue changed, PM work did
