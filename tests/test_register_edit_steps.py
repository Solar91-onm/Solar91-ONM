from __future__ import annotations

from datetime import date

from app.core.models import Issue, OMTask, Plant
from tests.conftest import login_user


def _seed(db, client):
    plant = Plant(site_code='ES01', plant_name='Edit Steps Plant')
    db.add(plant); db.commit(); db.refresh(plant)
    head = login_user(client, db, role='O&M Head', name='Head', email='head@example.com')
    task = OMTask(work_order_no='WO-ES-1', plant_id=plant.id, task_name='Inverter PM', task_type='Electrical',
                  equipment_ref='INV-01', frequency='Monthly', due_on=date(2026, 10, 10), status='Scheduled',
                  assignee_text='Tech', sop='SOP', safety='LOTO', tools='Kit', duration='2 h', created_by=head.id)
    issue = Issue(ticket_no='SI-ES-1', plant_id=plant.id, description='Fuse blown', severity='High',
                  status='Assigned', assignee_text='Tech', created_by=head.id)
    db.add_all([task, issue]); db.commit()
    return plant


def _sync(client, mutate):
    boot = client.get('/api/bootstrap').json()
    state = boot['state']
    mutate(state)
    r = client.put('/api/state/sync', json={'revision': boot['revision'], 'state': state})
    assert r.status_code == 200, r.text


def test_task_schedule_changes_use_the_dedicated_api(client, db):
    _seed(db, client)
    response = client.patch(
        '/api/scheduled/tasks/WO-ES-1/schedule',
        json={
            'name': 'Inverter PM (renamed)', 'due_on': '2026-11-02',
            'frequency': 'Quarterly',
            'steps': ['Isolate the inverter', 'Photograph the nameplate'],
        },
    )
    assert response.status_code == 200, response.text
    db.expire_all()
    row = db.query(OMTask).filter(OMTask.work_order_no == 'WO-ES-1').one()
    assert row.task_name == 'Inverter PM (renamed)' and row.due_on == date(2026, 11, 2) and row.frequency == 'Quarterly'
    back = client.get('/api/bootstrap').json()['state']['tasks'][0]
    assert back['name'] == 'Inverter PM (renamed)'
    assert back['steps'] == ['Isolate the inverter', 'Photograph the nameplate']


def test_task_reset_uses_the_dedicated_api(client, db):
    _seed(db, client)
    task = db.query(OMTask).filter(OMTask.work_order_no == 'WO-ES-1').one()
    task.status = 'Completed'
    task.completion = {'date': '2026-10-11'}
    task.actual_completed_on = date(2026, 10, 11)
    db.commit()

    response = client.post('/api/scheduled/tasks/WO-ES-1/reset')
    assert response.status_code == 200, response.text
    db.expire_all()
    row = db.query(OMTask).filter(OMTask.work_order_no == 'WO-ES-1').one()
    assert row.status == 'Scheduled' and row.actual_completed_on is None and row.completion is None


def test_task_to_issue_link_uses_the_dedicated_api(client, db):
    plant = _seed(db, client)
    response = client.post('/api/scheduled/tasks/WO-ES-1/link-issue', json={'ticket_no': 'SI-ES-1'})
    assert response.status_code == 200, response.text
    db.expire_all()
    row = db.query(OMTask).filter(OMTask.work_order_no == 'WO-ES-1').one()
    assert row.plant_id == plant.id and row.linked_issue == 'SI-ES-1'


def test_legacy_sync_cannot_change_task_or_issue_workflow(client, db):
    _seed(db, client)
    _sync(client, lambda state: state['tasks'][0].update(status='Completed'))
    db.expire_all()
    task = db.query(OMTask).filter(OMTask.work_order_no == 'WO-ES-1').one()
    assert task.status == 'Scheduled'
    _sync(client, lambda state: state['issues'][0].update(status='Open', assignee=None))
    db.expire_all()
    issue = db.query(Issue).filter(Issue.ticket_no == 'SI-ES-1').one()
    assert issue.status == 'Assigned' and issue.assignee_text == 'Tech'


def test_issue_steps_use_the_dedicated_api(client, db):
    _seed(db, client)
    issue = client.get('/api/issues').json()[0]
    issue_id = issue['id']
    first = client.post(f'/api/issues/{issue_id}/steps', json={'title': 'Isolate the string'})
    second = client.post(f'/api/issues/{issue_id}/steps', json={'title': 'Replace the fuse'})
    assert first.status_code == second.status_code == 200
    completed = client.patch(
        f"/api/issues/{issue_id}/steps/{first.json()['id']}",
        json={'done': True},
    )
    assert completed.status_code == 200, completed.text
    steps = client.get(f'/api/issues/{issue_id}/steps').json()
    assert [step['title'] for step in steps] == ['Isolate the string', 'Replace the fuse']
    assert steps[0]['done'] is True
    reset = client.post(f'/api/issues/{issue_id}/reset')
    assert reset.status_code == 200, reset.text
    assert reset.json()['status'] == 'Open'
