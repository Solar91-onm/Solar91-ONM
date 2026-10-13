from __future__ import annotations

from datetime import date

from app.core.models import AuditLog, OMTask, Plant, UserEquipmentTypeAssignment, UserPlantAssignment
from tests.conftest import login_user


def _tasks(db):
    p1 = Plant(site_code='E01', plant_name='Edit Plant 1'); p2 = Plant(site_code='E02', plant_name='Edit Plant 2')
    db.add_all([p1, p2]); db.commit(); db.refresh(p1); db.refresh(p2)
    rows = []
    for i, p in enumerate((p1, p2), 1):
        rows.append(OMTask(work_order_no=f'WO-ED-{i}', plant_id=p.id, task_name='Clean fans', task_type='Inverter',
                           frequency='Monthly', due_on=date(2026, 11, 1), assignee_text='Ravi', status='Scheduled'))
    rows.append(OMTask(work_order_no='WO-ED-DONE', plant_id=p1.id, task_name='Clean fans', task_type='Inverter',
                       frequency='Monthly', due_on=date(2026, 10, 1), assignee_text='Ravi', status='Completed'))
    db.add_all(rows); db.commit()


def test_head_can_edit_one_task_schedule(client, db):
    login_user(client, db, role='O&M Head', name='Head', email='head@example.com')
    _tasks(db)
    r = client.patch('/api/scheduled/tasks/WO-ED-1/schedule', json={'frequency': 'Weekly', 'due_on': '2026-11-05', 'assignee': 'Anita'})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body['task']['freq'] == 'Weekly' and body['task']['due'] == '2026-11-05' and body['task']['assignee'] == 'Anita'
    assert body['count'] == 1
    db.expire_all()
    other = db.query(OMTask).filter(OMTask.work_order_no == 'WO-ED-2').one()
    assert other.frequency == 'Monthly' and other.due_on == date(2026, 11, 1)


def test_apply_to_similar_shifts_other_open_tasks_but_not_completed(client, db):
    login_user(client, db, role='O&M Head', name='Head', email='head@example.com')
    _tasks(db)
    r = client.patch('/api/scheduled/tasks/WO-ED-1/schedule', json={'frequency': 'Quarterly', 'due_on': '2026-11-04', 'apply_to_similar': True})
    assert r.status_code == 200, r.text
    assert r.json()['count'] == 2
    db.expire_all()
    other = db.query(OMTask).filter(OMTask.work_order_no == 'WO-ED-2').one()
    assert other.frequency == 'Quarterly' and other.due_on == date(2026, 11, 4)
    done = db.query(OMTask).filter(OMTask.work_order_no == 'WO-ED-DONE').one()
    assert done.frequency == 'Monthly' and done.due_on == date(2026, 10, 1)


def test_bad_frequency_and_completed_task_are_rejected(client, db):
    login_user(client, db, role='O&M Head', name='Head', email='head@example.com')
    _tasks(db)
    assert client.patch('/api/scheduled/tasks/WO-ED-1/schedule', json={'frequency': 'Sometimes'}).status_code == 422
    assert client.patch('/api/scheduled/tasks/WO-ED-DONE/schedule', json={'frequency': 'Weekly'}).status_code == 409


def test_unit_plan_can_expand_shrink_and_keeps_removed_tasks_as_history(client, db):
    login_user(client, db, role='O&M Head', name='Head', email='unit-head@example.com')
    plant = Plant(site_code='UNIT-1', plant_name='Unit Plan Plant')
    db.add(plant)
    db.flush()
    task = OMTask(work_order_no='WO-UNIT-1', plant_id=plant.id, task_name='Clean fans', task_type='Inverter',
                  frequency='Monthly', due_on=date(2026, 11, 1), status='Scheduled')
    db.add(task)
    db.commit()

    expanded = client.patch('/api/scheduled/tasks/WO-UNIT-1/units', json={'total_units': 4, 'units_per_day': 2})
    assert expanded.status_code == 200, expanded.text
    assert expanded.json()['count'] == 4
    db.expire_all()
    active = db.query(OMTask).filter(OMTask.cycle_id.is_not(None), OMTask.status == 'Scheduled').all()
    assert len(active) == 4
    assert sorted((row.unit_no, row.due_on) for row in active) == [
        (1, date(2026, 11, 1)), (2, date(2026, 11, 1)),
        (3, date(2026, 11, 2)), (4, date(2026, 11, 2)),
    ]

    reduced = client.patch('/api/scheduled/tasks/WO-UNIT-1/units', json={'total_units': 2, 'units_per_day': 1})
    assert reduced.status_code == 200, reduced.text
    db.expire_all()
    rows = db.query(OMTask).filter(OMTask.cycle_id.is_not(None)).all()
    assert len(rows) == 4
    assert sum(row.status == 'Scheduled' for row in rows) == 2
    assert sum(row.status == 'Cancelled' for row in rows) == 2
    assert db.query(AuditLog).filter(AuditLog.action == 'Cancelled scheduled unit outside revised PM plan').count() == 2


def test_assignee_can_only_edit_units_for_assigned_equipment_type(client, db):
    assignee = login_user(client, db, role='Assignee', name='Ravi', email='unit-assignee@example.com')
    plant = Plant(site_code='UNIT-2', plant_name='Unit Scope Plant')
    db.add(plant)
    db.flush()
    db.add(UserEquipmentTypeAssignment(user_id=assignee.id, equipment_type='Inverter'))
    db.add_all([
        OMTask(work_order_no='WO-UNIT-INV', plant_id=plant.id, task_name='Clean fans', task_type='Inverter',
               frequency='Monthly', due_on=date(2026, 11, 1), status='Scheduled'),
        OMTask(work_order_no='WO-UNIT-TR', plant_id=plant.id, task_name='Check oil', task_type='Transformer',
               frequency='Monthly', due_on=date(2026, 11, 1), status='Scheduled'),
    ])
    db.commit()

    allowed = client.patch('/api/scheduled/tasks/WO-UNIT-INV/units', json={'total_units': 3, 'units_per_day': 1})
    assert allowed.status_code == 200, allowed.text
    denied = client.patch('/api/scheduled/tasks/WO-UNIT-TR/units', json={'total_units': 3, 'units_per_day': 1})
    assert denied.status_code == 403


def test_head_can_delete_open_task_and_similar_but_not_completed(client, db):
    login_user(client, db, role='O&M Head', name='Head', email='head@example.com')
    _tasks(db)
    assert client.delete('/api/scheduled/tasks/WO-ED-DONE').status_code == 409
    one = client.delete('/api/scheduled/tasks/WO-ED-1')
    assert one.status_code == 200 and one.json()['deleted'] == ['WO-ED-1']
    db.expire_all()
    assert db.query(OMTask).filter(OMTask.work_order_no == 'WO-ED-2').count() == 1
    both = client.delete('/api/scheduled/tasks/WO-ED-2?similar=true')
    assert both.status_code == 200 and both.json()['count'] == 1
    assert db.query(OMTask).filter(OMTask.work_order_no == 'WO-ED-DONE').count() == 1


def test_assignee_cannot_delete_tasks(client, db):
    login_user(client, db, role='Assignee', name='Ravi', email='ravi@example.com')
    _tasks(db)
    assert client.delete('/api/scheduled/tasks/WO-ED-1').status_code == 403


def test_site_engineer_can_start_own_plant_task_but_cannot_edit_schedule(client, db):
    engineer = login_user(client, db, role='Site Engineer', name='Field Engineer', email='se-schedule@example.com')
    plant = Plant(site_code='SE-SCHEDULE', plant_name='Site Engineer PM Plant')
    db.add(plant)
    db.flush()
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id))
    db.add(OMTask(
        work_order_no='WO-SE-SCHEDULE', plant_id=plant.id, task_name='Inspect inverter',
        task_type='Inverter', frequency='Monthly', start_on=date(2026, 10, 1),
        due_on=date(2026, 10, 15), status='Scheduled',
    ))
    db.commit()

    changed = client.patch('/api/scheduled/tasks/WO-SE-SCHEDULE/schedule', json={
        'start_on': '2026-10-05', 'due_on': '2026-10-20',
    })
    assert changed.status_code == 403
    started = client.post('/api/scheduled/tasks/WO-SE-SCHEDULE/start')
    assert started.status_code == 200, started.text
