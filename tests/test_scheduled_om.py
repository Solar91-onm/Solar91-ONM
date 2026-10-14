from __future__ import annotations

from datetime import date

from app.core.models import Equipment, Notification, OMTask, Plant, User, UserEquipmentAssignment, UserEquipmentTypeAssignment, UserPlantAssignment, WashingConfig, WashingHistory, WashingTable, Permit
from tests.conftest import login_user


def _scoped_engineer(db, client):
    plant = Plant(site_code='PM01', plant_name='PM Plant', assigned_engineer='Field Engineer')
    db.add(plant); db.commit(); db.refresh(plant)
    user = login_user(client, db, role='Site Engineer', name='Field Engineer', email='field@example.com')
    db.add(UserPlantAssignment(user_id=user.id, plant_id=plant.id, assignment_role='Site Engineer'))
    db.commit()
    return plant, user


def test_site_engineer_can_complete_scheduled_task_and_next_occurrence_is_generated(client, db):
    plant, user = _scoped_engineer(db, client)
    head = User(auth_provider='test', external_subject='pm-report-head', email='pm-report-head@example.com',
                display_name='Operations Head', role='O&M Head', is_active=True)
    db.add(head)
    task = OMTask(
        work_order_no='WO-PM-001', plant_id=plant.id, task_name='Inverter preventive maintenance',
        task_type='Electrical', equipment_ref='INV-01', frequency='Weekly', due_on=date(2026, 9, 28),
        assignee_text='Field Engineer', status='In Progress', sop='PM checklist', safety='LOTO',
        tools='IR tester', duration='2 h', created_by=user.id,
    )
    db.add(task); db.commit()

    task.evidence = [
        {'kind': 'before', 'storage_path': 'scheduled/test/before.jpg'},
        {'kind': 'after', 'storage_path': 'scheduled/test/after.jpg'},
    ]
    db.commit()
    response = client.post(
        '/api/scheduled/tasks/WO-PM-001/complete',
        json={
            'completed_on': '2026-09-29', 'readings': 'IR 5.2 MΩ',
            'remarks': 'PM complete', 'anomaly': False, 'checklist': [],
        },
    )
    assert response.status_code == 200, response.text
    repeated = client.post(
        '/api/scheduled/tasks/WO-PM-001/complete',
        json={
            'completed_on': '2026-09-29', 'readings': 'IR 5.2 MΩ',
            'remarks': 'PM complete', 'anomaly': False, 'checklist': [],
        },
    )
    assert repeated.status_code == 409, repeated.text

    db.expire_all()
    completed = db.query(OMTask).filter(OMTask.work_order_no == 'WO-PM-001').one()
    assert completed.status == 'Completed'
    assert completed.actual_completed_on == date(2026, 9, 29)
    assert completed.delay_days == 1
    assert db.query(Notification).filter_by(
        user_id=head.id, event_type='task_reported', target_id='WO-PM-001',
    ).count() == 1

    generated = db.query(OMTask).filter(OMTask.recurrence_parent_no == 'WO-PM-001').one()
    assert generated.status == 'Scheduled'
    assert generated.due_on == date(2026, 10, 5)
    assert generated.plant_id == plant.id


def test_site_engineer_can_log_washing_exception_and_reschedule(client, db):
    plant, user = _scoped_engineer(db, client)
    db.add(WashingConfig(plant_id=plant.id, frequency_days=14, team=['Field Engineer']))
    table = WashingTable(
        legacy_id='WT-PM-001', plant_id=plant.id, inverter_no=3, secondary_inverter_no=4,
        table_code='INV-03-T-014', next_due_on=date(2026, 9, 28), legacy_payload={},
    )
    db.add(table); db.commit(); db.refresh(table)

    boot = client.get('/api/bootstrap').json()
    state = boot['state']
    assert len(state['washing']) == 1
    row = state['washing'][0]
    assert row['invSecondary'] == 4
    row['history'].append({
        'type': 'exception', 'date': '2026-09-28', 'by': 'Field Engineer',
        'reason': 'Rain', 'notes': 'Auto-rescheduled to next available day',
    })
    row['rescheduledTo'] = '2026-09-29'
    row['nextDue'] = '2026-09-29'
    response = client.put('/api/state/sync', json={'revision': boot['revision'], 'state': state})
    assert response.status_code == 200, response.text

    db.expire_all()
    updated = db.query(WashingTable).filter(WashingTable.legacy_id == 'WT-PM-001').one()
    assert updated.rescheduled_to is None
    assert updated.next_due_on == date(2026, 9, 28)
    assert db.query(WashingHistory).filter(WashingHistory.washing_table_id == updated.id).count() == 0

def test_frontend_contains_planned_maintenance_hub_and_washing_submodule(client):
    page = client.get('/')
    assert page.status_code == 200
    html = page.text
    assert 'Preventive Maintenance' in html
    assert 'Operations overview' in html
    assert 'Unplanned · Site Issues' in html
    assert 'Planned · Preventive Maintenance' in html
    assert 'aria-label="Filter dashboard by equipment"' in html
    assert 'cc-ops-overview' in html
    assert 'Scheduled O&amp;M' not in html
    assert 'link("scheduled","Scheduled O&amp;M"' not in html
    assert 'Washing' in html
    assert 'Sudden breakdowns and urgent requests remain in' in html


def test_site_engineer_cannot_create_problem_based_scheduled_task(client, db):
    plant, _user = _scoped_engineer(db, client)
    response = client.post('/api/scheduled/tasks/problem', json={
        'plant_id': str(plant.id),
        'asset': 'Inverter',
        'problem': 'Fan failure',
        'task_name': 'Weekly inverter fan inspection',
        'equipment_ref': 'INV-01',
        'frequency': 'Weekly',
        'due_on': '2026-10-01',
        'assignee': 'Field Engineer',
        'sop': 'INV-PM-01',
        'safety': 'LOTO required',
    })
    assert response.status_code == 403, response.text
    assert client.post("/api/pm-plan/tasks", json={
        "equipment_type": "Transformer", "task_name": "Transformer inspection",
        "frequency": "Monthly", "plants": ["Executive Plant"],
        "start_date": "2026-10-05",
    }).status_code == 403
    assert client.get("/api/pm-plan/unit-config").status_code == 403
    assert client.get("/api/pm-plan/scope").status_code == 403
    assert client.get("/api/pm-plan/alert-preferences").status_code == 403
    assert 'O&M Head' in response.json()['detail']


def test_administration_cannot_create_problem_based_scheduled_task(client, db):
    plant = Plant(site_code='CEO01', plant_name='Executive Plant')
    db.add(plant); db.commit(); db.refresh(plant)
    login_user(client, db, role='Administration', name='Executive User', email='exec@example.com')

    response = client.post('/api/scheduled/tasks/problem', json={
        'plant_id': str(plant.id),
        'asset': 'Transformer',
        'problem': 'Oil leakage',
        'task_name': 'Transformer oil leakage inspection',
        'equipment_ref': 'TR-01',
        'frequency': 'Monthly',
        'due_on': '2026-10-05',
        'assignee': 'O&M Team',
        'sop': 'TR-PM-01',
        'safety': 'PTW required',
    })
    assert response.status_code == 403, response.text


def test_assignee_problem_task_creation_is_limited_to_assigned_equipment_types_across_plants(client, db):
    own = Plant(site_code='AS01', plant_name='Assigned Plant')
    other = Plant(site_code='AS02', plant_name='Also Assigned Plant')
    db.add_all([own, other]); db.commit(); db.refresh(own); db.refresh(other)
    user = login_user(client, db, role='Assignee', name='O&M Member', email='om.member@example.com')
    db.add(UserEquipmentTypeAssignment(user_id=user.id, equipment_type='CCTV'))
    other_assignee = User(
        auth_provider='supabase', external_subject='other-assignee',
        email='other-assignee@example.com', display_name='Other User',
        role='Assignee', is_active=True,
    )
    db.add(other_assignee); db.commit()
    db.add(UserEquipmentTypeAssignment(user_id=other_assignee.id, equipment_type='Inverter')); db.commit()

    payload = {
        'asset': 'CCTV', 'problem': 'Camera offline', 'task_name': 'CCTV preventive inspection',
        'equipment_ref': 'CAM-01', 'frequency': 'Weekly', 'due_on': '2026-10-02',
        'assignee': 'O&M Member', 'sop': 'CCTV-PM-01', 'safety': '—',
    }
    denied_type = client.post('/api/scheduled/tasks/problem', json={**payload, 'asset': 'Transformer', 'plant_id': str(own.id)})
    assert denied_type.status_code == 403, denied_type.text
    for plant in (own, other):
        allowed = client.post('/api/scheduled/tasks/problem', json={**payload, 'plant_id': str(plant.id)})
        assert allowed.status_code == 201, allowed.text
    denied_assignment = client.post('/api/scheduled/tasks/problem', json={**payload, 'assignee': 'Other User', 'plant_id': str(other.id)})
    assert denied_assignment.status_code == 422, denied_assignment.text


def test_scheduled_before_after_evidence_is_private_and_required(client, db, monkeypatch):
    from app.scheduled import router as scheduled_router

    class FakeStorage:
        objects = {}
        def __init__(self, *args, **kwargs):
            pass
        def upload(self, path, data, content_type):
            self.objects[path] = (bytes(data), content_type)
            return None
        def download(self, path):
            return self.objects[path]
        def remove(self, paths):
            for path in paths:
                self.objects.pop(path, None)

    monkeypatch.setattr(scheduled_router, 'SupabaseStorage', FakeStorage)

    plant, user = _scoped_engineer(db, client)
    task = OMTask(
        work_order_no='WO-EVIDENCE-01', plant_id=plant.id, task_name='Inverter PM with evidence',
        task_type='Inverter', problem='Fan failure', problem_source='Site Issues problem library',
        equipment_ref='INV-01', frequency='Weekly', due_on=date(2026, 9, 28),
        assignee_text='Field Engineer', status='In Progress', sop='INV-PM-01', safety='LOTO',
        tools='Standard toolkit', duration='2 h', evidence=[], created_by=user.id,
    )
    db.add(task); db.commit()

    incomplete = client.post('/api/scheduled/tasks/WO-EVIDENCE-01/complete', json={
        'completed_on': '2026-09-28', 'readings': 'Normal', 'remarks': 'Ready',
        'anomaly': False, 'checklist': ['Visual inspection'],
    })
    assert incomplete.status_code == 422, incomplete.text
    assert 'Before and After' in incomplete.json()['detail']

    before_bytes = b'B' * 128
    before = client.post(
        '/api/scheduled/tasks/WO-EVIDENCE-01/evidence/before',
        files={'file': ('before.jpg', before_bytes, 'image/jpeg')}, data={'note': 'Before maintenance'},
    )
    assert before.status_code == 200, before.text
    assert before.json()['kind'] == 'before'

    after_bytes = b'A' * 128
    after = client.post(
        '/api/scheduled/tasks/WO-EVIDENCE-01/evidence/after',
        files={'file': ('after.jpg', after_bytes, 'image/jpeg')}, data={'note': 'After maintenance'},
    )
    assert after.status_code == 200, after.text
    assert after.json()['kind'] == 'after'

    read_before = client.get('/api/scheduled/tasks/WO-EVIDENCE-01/evidence/before')
    assert read_before.status_code == 200
    assert read_before.content == before_bytes
    assert read_before.headers['content-type'].startswith('image/jpeg')

    complete = client.post('/api/scheduled/tasks/WO-EVIDENCE-01/complete', json={
        'completed_on': '2026-09-29', 'readings': 'IR 5.2 MΩ',
        'remarks': 'Fan vibration found; create Site Issue', 'anomaly': True,
        'checklist': ['Visual inspection', 'Fan inspection'],
    })
    assert complete.status_code == 200, complete.text
    body = complete.json()
    assert body['task']['status'] == 'Completed'
    assert body['task']['delayDays'] == 1
    assert body['linked_issue']
    assert {e['kind'] for e in body['task']['evidence']} == {'before', 'after'}

    # Completed evidence is an audit record and cannot be silently altered.
    remove_after_completion = client.delete('/api/scheduled/tasks/WO-EVIDENCE-01/evidence/before')
    assert remove_after_completion.status_code == 409

    db.expire_all()
    next_task = db.query(OMTask).filter(OMTask.recurrence_parent_no == 'WO-EVIDENCE-01').one()
    assert next_task.evidence == []
    assert next_task.problem == 'Fan failure'


def test_mutating_scheduled_api_rejects_cookie_only_style_request(client, db):
    plant = Plant(site_code='CSRF01', plant_name='Write Auth Plant')
    db.add(plant); db.commit(); db.refresh(plant)
    login_user(client, db, role='O&M Head', name='Admin', email='admin2@example.com')
    response = client.post('/api/scheduled/tasks/problem', headers={'Authorization': ''}, json={
        'plant_id': str(plant.id), 'asset': 'Inverter', 'problem': 'Fan failure',
        'task_name': 'Fan inspection', 'frequency': 'Weekly', 'due_on': '2026-10-01',
    })
    assert response.status_code == 403, response.text
    assert 'bearer token' in response.json()['detail'].lower()


def test_frontend_is_productionized_and_uses_site_issues(client):
    page = client.get('/')
    assert page.status_code == 200
    html = page.text
    assert 'Site Issues' in html
    assert 'Scheduled O&amp;M filters' not in html
    assert 'Scheduled O&M filters' not in html
    assert 'Standalone Prototype' not in html
    assert 'Reset demo data' not in html
    assert 'localStorage' not in html
    assert 'SUPABASE_SERVICE_ROLE_KEY' not in html
    assert 'PRODUCTION IDENTITY + ACCESS ENFORCEMENT' in html


def test_ptw_or_loto_task_is_blocked_until_approved_and_closes_on_completion(client, db):
    plant, user = _scoped_engineer(db, client)
    task = OMTask(
        work_order_no='WO-PTW-01', plant_id=plant.id, task_name='HT panel inspection',
        task_type='Electrical', problem='Inspection', problem_source='Site Issues problem library',
        equipment_ref='HT-01', frequency='Monthly', due_on=date(2026, 9, 28),
        assignee_text=user.display_name, assignee_user_id=user.id, status='Scheduled',
        sop='HT-01', safety='PTW + LOTO required', tools='PPE', duration='2 h',
        evidence=[], created_by=user.id,
    )
    db.add(task); db.commit()

    blocked = client.post('/api/scheduled/tasks/WO-PTW-01/start')
    assert blocked.status_code == 409, blocked.text
    assert 'PTW approval' in blocked.json()['detail']['message']
    permit_no = blocked.json()['detail']['permit_no']
    permit = db.query(Permit).filter(Permit.permit_no == permit_no).one()
    assert permit.status == 'Pending Approval'
    assert permit.loto is True

    manager = User(auth_provider='supabase', external_subject='ptw-manager', email='ptw-manager@example.com', display_name='PTW Manager', role='O&M Head', is_active=True)
    db.add(manager); db.commit()
    from tests import conftest as test_conftest
    test_conftest._CURRENT_USER = manager
    approved = client.post(f'/api/scheduled/permits/{permit_no}/approve')
    assert approved.status_code == 200, approved.text
    assert approved.json()['status'] == 'Approved'

    test_conftest._CURRENT_USER = user
    started = client.post('/api/scheduled/tasks/WO-PTW-01/start')
    assert started.status_code == 200, started.text

    # Completion still requires both evidence slots, but once completed the approved PTW closes.
    # Directly seed private-storage metadata for this focused lifecycle test.
    task = db.query(OMTask).filter(OMTask.work_order_no == 'WO-PTW-01').one()
    task.evidence = [
        {'kind':'before','storage_path':'scheduled/fake/before.jpg'},
        {'kind':'after','storage_path':'scheduled/fake/after.jpg'},
    ]
    db.add(task); db.commit()
    completed = client.post('/api/scheduled/tasks/WO-PTW-01/complete', json={
        'completed_on':'2026-09-29','readings':'Normal','remarks':'Completed','anomaly':False,'checklist':['Inspection'],
    })
    assert completed.status_code == 200, completed.text
    db.expire_all()
    assert db.query(Permit).filter(Permit.permit_no == permit_no).one().status == 'Closed'
