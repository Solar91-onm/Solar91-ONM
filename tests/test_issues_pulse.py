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
    assert empty.json() == {'count': 0, 'latest': None}

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
