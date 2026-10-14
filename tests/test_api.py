from __future__ import annotations

from datetime import date, datetime, timedelta
from uuid import UUID

from app.core.models import Equipment, InventoryItem, InventoryMovement, Issue, Plant, User, UserEquipmentAssignment, UserEquipmentTypeAssignment, UserPlantAssignment, WashingConfig, WashingTable
from tests.conftest import login_user


def test_authentication_protects_bootstrap(client):
    response = client.get('/api/bootstrap')
    assert response.status_code == 401


def test_legacy_session_cookie_does_not_authenticate(client):
    response = client.get('/api/bootstrap', cookies={'__session': 'legacy-session-token'})
    assert response.status_code == 401


def test_head_can_create_update_delete_plant_and_equipment(client, db):
    login_user(client, db)
    plant = client.post('/api/plants', json={'site_code':'QA01','plant_name':'QA Plant','district':'Jaipur'})
    assert plant.status_code == 201, plant.text
    plant_id = plant.json()['id']
    patched = client.patch(f'/api/plants/{plant_id}', json={'district':'Dausa'})
    assert patched.status_code == 200 and patched.json()['district'] == 'Dausa'
    equipment = client.post('/api/equipment', json={'plant_id':plant_id,'equipment_code':'INV-01','equipment_name':'Inverter 1','equipment_type':'Inverter','metadata':{}})
    assert equipment.status_code == 201, equipment.text
    assert equipment.json()['plant_id'] == plant_id
    assert client.delete(f"/api/equipment/{equipment.json()['id']}").status_code == 204
    assert client.delete(f'/api/plants/{plant_id}').status_code == 204


def test_site_engineer_is_plant_scoped_and_cannot_manage_plants(client, db):
    plant_a = Plant(site_code='A01', plant_name='Plant A', assigned_engineer='Engineer A')
    plant_b = Plant(site_code='B01', plant_name='Plant B')
    db.add_all([plant_a, plant_b]); db.commit()
    user = login_user(client, db, role='Site Engineer', name='Engineer A', email='eng@example.com')
    db.add(UserPlantAssignment(user_id=user.id, plant_id=plant_a.id, assignment_role='Site Engineer')); db.commit()
    rows = client.get('/api/plants').json()
    assert [x['site_code'] for x in rows] == ['A01']
    denied = client.post('/api/plants', json={'site_code':'X01','plant_name':'Nope'})
    assert denied.status_code == 403


def test_assignee_issue_list_is_scoped_by_equipment_type_across_plants(client, db):
    plant_a = Plant(site_code='EQ-A', plant_name='Equipment Plant A')
    plant_b = Plant(site_code='EQ-B', plant_name='Equipment Plant B')
    db.add_all([plant_a, plant_b]); db.commit()
    db.refresh(plant_a); db.refresh(plant_b)
    user = login_user(client, db, role='Assignee', name='Inverter Owner', email='equipment@example.com')
    db.add(UserEquipmentTypeAssignment(user_id=user.id, equipment_type='Inverter'))
    db.add_all([
        Issue(ticket_no='T-INV-A', plant_id=plant_a.id, vertical='Inverter', description='Inverter fault A', severity='High'),
        Issue(ticket_no='T-INV-B', plant_id=plant_b.id, vertical='inverter', description='Inverter fault B', severity='Low'),
        Issue(ticket_no='T-TR-A', plant_id=plant_a.id, vertical='Transformer', description='Transformer oil', severity='High'),
        Issue(ticket_no='T-NONE', plant_id=plant_b.id, description='No type', severity='Low'),
    ])
    db.commit()
    assert {row['ticket_no'] for row in client.get('/api/issues').json()} == {'T-INV-A', 'T-INV-B'}
    denied = client.post('/api/issues', json={'ticket_no': 'T-NEW', 'plant_id': str(plant_a.id), 'vertical': 'Transformer',
                                              'description': 'x', 'severity': 'Low'})
    assert denied.status_code == 403
    ok = client.post('/api/issues', json={'ticket_no': 'T-NEW2', 'plant_id': str(plant_b.id), 'vertical': 'Inverter',
                                          'description': 'x', 'severity': 'Low'})
    assert ok.status_code == 201, ok.text


def test_issue_workflow_assignment_scope_and_close_permission(client, db):
    plant = Plant(site_code='ISS01', plant_name='Issue Plant')
    db.add(plant); db.commit()
    engineer = login_user(client, db, role='Site Engineer', name='Engineer One', email='one@example.com')
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role='Site Engineer')); db.commit()
    created = client.post('/api/issues', json={
        'ticket_no':'TKT-QA-001','plant_id':str(plant.id),'description':'Inverter alarm','severity':'High','equipment_ref':'INV-01'
    })
    assert created.status_code == 201, created.text
    issue_id = created.json()['id']
    progress_denied = client.post(f'/api/issues/{issue_id}/progress', json={'note':'Checked inverter','hours':1})
    assert progress_denied.status_code == 403
    acknowledge_denied = client.post(f'/api/issues/{issue_id}/acknowledge')
    assert acknowledge_denied.status_code == 403

    login_user(client, db, role='O&M Head', name='Workflow Head', email='workflow-head@example.com')
    acknowledged = client.post(f'/api/issues/{issue_id}/acknowledge')
    assert acknowledged.status_code == 200 and acknowledged.json()['status'] == 'Acknowledged'
    progress = client.post(f'/api/issues/{issue_id}/progress', json={'note':'Checked inverter','hours':1})
    assert progress.status_code == 200 and progress.json()['status'] == 'In Progress'
    issue = db.query(Issue).filter(Issue.id == UUID(str(issue_id))).one()
    issue.legacy_payload = {'evidence':[{'id':'FIX-01','storage_path':'private/fix.jpg'}]}
    db.commit()
    resolved = client.post(f'/api/issues/{issue_id}/resolve', json={
        'root_cause':'Loose connector','corrective_action':'Connector reseated and tested',
        'evidence_ids':['FIX-01'],
    })
    assert resolved.status_code == 200 and resolved.json()['status'] == 'Resolved'
    assert resolved.json()['closure']['evidenceIds'] == ['FIX-01']
    assert resolved.json()['closure']['actualTimeToCloseHours'] >= 0
    closed = client.post(f'/api/issues/{issue_id}/close', json={'note':'verified'})
    assert closed.status_code == 200 and closed.json()['status'] == 'Closed'
    assert closed.json()['closure']['verifiedBy'] == 'Workflow Head'


def test_site_engineer_can_message_ticket_and_activity_is_persisted(client, db):
    plant = Plant(site_code='MSG01', plant_name='Message Plant')
    db.add(plant); db.commit(); db.refresh(plant)
    engineer = login_user(client, db, role='Site Engineer', name='Message Engineer', email='message-engineer@example.com')
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role='Site Engineer')); db.commit()
    created = client.post('/api/issues', json={
        'plant_id':str(plant.id),'description':'Site observation','severity':'Low',
    })
    assert created.status_code == 201, created.text
    issue_id = created.json()['id']

    response = client.post(f'/api/issues/{issue_id}/comments', json={'message':'The alarm is still visible on site.'})
    assert response.status_code == 200, response.text
    activity = client.get(f'/api/issues/{issue_id}/activity')
    assert activity.status_code == 200
    assert any(row['action']=='issue.message' and row['note']=='The alarm is still visible on site.' for row in activity.json())


def test_issue_progress_consumes_tracked_spare_part(client, db):
    login_user(client, db)
    plant = Plant(site_code='PART01', plant_name='Parts Plant')
    db.add(plant); db.commit(); db.refresh(plant)
    created = client.post('/api/issues', json={
        'plant_id':str(plant.id),'description':'Fuse replacement','severity':'Medium',
    })
    assert created.status_code == 201, created.text
    issue_id=created.json()['id']
    item=InventoryItem(legacy_id='SPARE-FUSE-01',plant_id=plant.id,item_name='Fuse',quantity=5,unit='pcs')
    db.add(item); db.commit()
    assert client.post(f'/api/issues/{issue_id}/acknowledge').status_code == 200

    insufficient=client.post(f'/api/issues/{issue_id}/progress',json={
        'note':'Attempted to use more stock than available',
        'inventory_item_id':item.legacy_id,
        'quantity':6,
    })
    assert insufficient.status_code == 409, insufficient.text
    db.refresh(item)
    assert float(item.quantity)==5
    assert db.query(InventoryMovement).filter(InventoryMovement.inventory_item_id==item.id).count()==0

    progressed=client.post(f'/api/issues/{issue_id}/progress',json={
        'note':'Replaced blown fuse','hours':1.5,'inventory_item_id':item.legacy_id,'quantity':2,
    })
    assert progressed.status_code == 200, progressed.text
    db.refresh(item)
    assert float(item.quantity)==3
    movement=db.query(InventoryMovement).filter(InventoryMovement.inventory_item_id==item.id).one()
    assert movement.movement_type=='Issue consumption'
    assert float(movement.quantity)==-2


def test_issue_create_assigns_assignee_and_returns_intake_fields(client, db):
    from uuid import uuid4

    login_user(client, db)
    plant = client.post('/api/plants', json={'site_code':'INTAKE01','plant_name':'Intake Plant'}).json()
    assignee = User(
        auth_provider='test', external_subject='intake-assignee-'+str(uuid4()),
        email='intake-assignee@example.com', display_name='Inverter Assignee', role='Assignee',
    )
    db.add(assignee); db.flush()
    db.add(UserEquipmentTypeAssignment(user_id=assignee.id, equipment_type='Inverter')); db.commit()

    options = client.get('/api/issues/assignees')
    assert options.status_code == 200
    assert {'id':str(assignee.id),'name':'Inverter Assignee','equipment_types':['Inverter']} in options.json()

    response = client.post('/api/issues', json={
        'plant_id':plant['id'],'vertical':'Inverter','description':'Intake details',
        'severity':'Medium','assigned_to':str(assignee.id),'supplier':'Example Supplier',
        'serial_number':'INV-serial-123',
    })
    assert response.status_code == 201, response.text
    issue = response.json()
    assert issue['ticket_no'] == 'ISS-0001'
    assert issue['status'] == 'Assigned'
    assert issue['assigned_to'] == str(assignee.id)
    assert issue['assignee_text'] == 'Inverter Assignee'
    assert issue['supplier'] == 'Example Supplier'
    assert issue['serial_number'] == 'INV-serial-123'


def test_issue_create_rejects_non_assignee_target(client, db):
    from uuid import uuid4

    login_user(client, db)
    plant = client.post('/api/plants', json={'site_code':'INTAKE02','plant_name':'Intake Plant 2'}).json()
    user = User(
        auth_provider='test', external_subject='not-assignee-'+str(uuid4()),
        email='not-assignee@example.com', display_name='Not an Assignee', role='Site Engineer',
    )
    db.add(user); db.commit()
    response = client.post('/api/issues', json={
        'plant_id':plant['id'],'vertical':'Inverter','description':'Wrong target',
        'severity':'Low','assigned_to':str(user.id),
    })
    assert response.status_code == 422


def test_issue_evidence_enforces_ten_photo_limit(client, db):
    login_user(client, db)
    plant = client.post('/api/plants', json={'site_code':'INTAKE03','plant_name':'Evidence Plant'}).json()
    created = client.post('/api/issues', json={
        'plant_id':plant['id'],'description':'Evidence limit','severity':'Low',
    })
    assert created.status_code == 201, created.text
    issue_id = created.json()['id']
    issue = db.query(Issue).filter(Issue.id == UUID(str(issue_id))).one()
    issue.legacy_payload = {'evidence':[{'id':f'EV-{index}','storage_path':f'private/{index}'} for index in range(10)]}
    db.commit()

    response = client.post(
        f'/api/issues/{issue_id}/evidence',
        files=[('files',('extra.jpg',b'x'*40,'image/jpeg'))],
    )
    assert response.status_code == 422
    listed = client.get('/api/issues').json()
    evidence = next(row for row in listed if row['id'] == issue_id)['evidence']
    assert len(evidence) == 10
    assert all('storage_path' not in photo for photo in evidence)


def test_issue_filters_are_server_side(client, db):
    user = login_user(client, db)
    plant = client.post('/api/plants', json={'site_code':'FLT01','plant_name':'Filter Plant'}).json()
    for no, sev in [('TKT-F-1','High'),('TKT-F-2','Low')]:
        response = client.post('/api/issues', json={'ticket_no':no,'plant_id':plant['id'],'description':no,'severity':sev})
        assert response.status_code == 201
    rows = client.get('/api/issues?severity=High').json()
    assert len(rows) == 1 and rows[0]['ticket_no'] == 'TKT-F-1'
    assert rows[0]['severity'] == 'Critical'
    assert len(client.get('/api/issues?severity=Critical').json()) == 1
    invalid = client.post('/api/issues', json={'ticket_no':'TKT-F-3','plant_id':plant['id'],'description':'Invalid severity','severity':'Normal'})
    assert invalid.status_code == 422


def test_validation_rejects_bad_latitude(client, db):
    login_user(client, db)
    response = client.post('/api/plants', json={'site_code':'BAD','plant_name':'Bad','latitude':120})
    assert response.status_code == 422


def test_issue_assign_reassign_and_close_as_head(client, db):
    from app.core.models import User
    login_user(client, db)
    plant = client.post('/api/plants', json={'site_code':'WF01','plant_name':'Workflow Plant'}).json()
    target1 = User(auth_provider='test', external_subject='target-1', email='t1@example.com', display_name='Tech One', role='Assignee')
    target2 = User(auth_provider='test', external_subject='target-2', email='t2@example.com', display_name='Tech Two', role='Assignee')
    db.add_all([target1,target2]); db.commit(); db.refresh(target1); db.refresh(target2)
    issue = client.post('/api/issues', json={'ticket_no':'TKT-WF-1','plant_id':plant['id'],'vertical':'Inverter','description':'Workflow issue','severity':'Critical'}).json()
    assigned = client.post(f"/api/issues/{issue['id']}/assign", json={'assignee_text':'Tech One','assigned_to':str(target1.id),'note':'initial'})
    assert assigned.status_code == 200 and assigned.json()['assignee_text'] == 'Tech One'
    reassigned = client.post(f"/api/issues/{issue['id']}/reassign", json={'assignee_text':'Tech Two','assigned_to':str(target2.id),'note':'shift change'})
    assert reassigned.status_code == 200 and reassigned.json()['assigned_to'] == str(target2.id)
    assert client.post(f"/api/issues/{issue['id']}/acknowledge").status_code == 200
    assert client.post(f"/api/issues/{issue['id']}/start").status_code == 200
    row = db.query(Issue).filter(Issue.id == UUID(issue['id'])).one()
    row.legacy_payload = {'evidence':[{'id':'FIX-CLOSE','storage_path':'private/fix-close.jpg'}]}
    db.commit()
    resolved = client.post(f"/api/issues/{issue['id']}/resolve", json={
        'root_cause':'Cable fault','corrective_action':'Cable replaced','evidence_ids':['FIX-CLOSE'],
    })
    assert resolved.status_code == 200 and resolved.json()['status'] == 'Resolved'
    closed = client.post(f"/api/issues/{issue['id']}/close", json={'note':'verified','closure':{'rootCause':'test'}})
    assert closed.status_code == 200 and closed.json()['status'] == 'Closed'


def test_equipment_requires_existing_plant(client, db):
    import uuid
    login_user(client, db)
    response = client.post('/api/equipment', json={'plant_id':str(uuid.uuid4()),'equipment_code':'X','equipment_name':'Unknown Plant Equipment','metadata':{}})
    assert response.status_code == 404


def test_duplicate_plant_returns_conflict(client, db):
    login_user(client, db)
    payload = {'site_code':'DUP01','plant_name':'Duplicate Plant'}
    assert client.post('/api/plants', json=payload).status_code == 201
    assert client.post('/api/plants', json=payload).status_code == 409


def test_non_admin_state_sync_cannot_modify_other_plants(client, db):
    plant_a = Plant(site_code='SA01', plant_name='Scoped A', assigned_engineer='Scoped Engineer')
    plant_b = Plant(site_code='SB01', plant_name='Protected B', district='Original')
    db.add_all([plant_a, plant_b]); db.commit()
    user = login_user(client, db, role='Site Engineer', name='Scoped Engineer', email='scope@example.com')
    db.add(UserPlantAssignment(user_id=user.id, plant_id=plant_a.id, assignment_role='Site Engineer')); db.commit()
    boot = client.get('/api/bootstrap').json()
    malicious = dict(boot['state'])
    malicious['plants'] = [{'id':'SB01','name':'Protected B','district':'Tampered'}]
    response = client.put('/api/state/sync', json={'revision':boot['revision'],'state':malicious})
    assert response.status_code == 200
    db.expire_all()
    protected = db.query(Plant).filter(Plant.site_code=='SB01').one()
    assert protected.district == 'Original'


def test_excel_plant_and_location_imports_run_on_backend(client, db):
    from io import BytesIO
    from openpyxl import Workbook
    login_user(client, db)

    wb = Workbook(); ws = wb.active
    ws.append(['Site Code','Plant Name','District','DC Capacity kW'])
    ws.append(['XL01','Excel Plant','Dausa',1234.5])
    buf = BytesIO(); wb.save(buf)
    response = client.post('/api/imports/plants', files={'file':('plants.xlsx',buf.getvalue(),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')})
    assert response.status_code == 200, response.text
    assert response.json()['created'] == 1

    wb2 = Workbook(); ws2 = wb2.active
    ws2.append(['Plant Name','City','Latitude','Longitude'])
    ws2.append(['XL01 (Excel Plant)','Dausa',26.90,76.33])
    buf2 = BytesIO(); wb2.save(buf2)
    response2 = client.post('/api/imports/locations', files={'file':('locations.xlsx',buf2.getvalue(),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')})
    assert response2.status_code == 200, response2.text
    assert response2.json()['updated'] == 1
    db.expire_all()
    plant = db.query(Plant).filter(Plant.site_code=='XL01').one()
    assert round(float(plant.latitude),2) == 26.90


def test_auth_config_reports_supabase(client):
    from app.core.config import get_settings

    response = client.get("/api/auth/config")
    assert response.status_code == 200

    body = response.json()
    assert body["provider"] == "supabase"
    assert body["configured"] is get_settings().supabase_configured
def test_site_engineer_fails_closed_if_assigned_to_multiple_plants(client, db):
    from app.core.models import Plant, User, UserPlantAssignment, WashingConfig, WashingTable
    from tests.conftest import login_user

    p1 = Plant(site_code='LOCK01', plant_name='Locked Plant One')
    p2 = Plant(site_code='LOCK02', plant_name='Locked Plant Two')
    db.add_all([p1, p2]); db.commit(); db.refresh(p1); db.refresh(p2)
    user = login_user(client, db, role='Site Engineer', name='Scoped Engineer', email='scope.lock@example.com')
    db.add_all([
        UserPlantAssignment(user_id=user.id, plant_id=p1.id, assignment_role='Site Engineer'),
        UserPlantAssignment(user_id=user.id, plant_id=p2.id, assignment_role='Site Engineer'),
    ])
    db.commit()

    response = client.get('/api/bootstrap')
    assert response.status_code == 403, response.text
    assert 'exactly one plant' in response.json()['detail'].lower()


def test_site_engineer_scope_uses_explicit_assignment_not_legacy_engineer_text(client, db):
    plant = Plant(site_code='LEGACY01', plant_name='Legacy Text Plant', assigned_engineer='Text Only Engineer')
    db.add(plant); db.commit()
    login_user(client, db, role='Site Engineer', name='Text Only Engineer', email='text-only@example.com')

    boot = client.get('/api/bootstrap')
    assert boot.status_code == 200, boot.text
    body = boot.json()
    assert body['pending_access'] is True
    assert body['scope']['plant_ids'] == []
    assert body['modules'] == ['Command Center', 'My Plant', 'Site Issues', 'Preventive Maintenance', 'Notifications', 'My Profile']

    plants = client.get('/api/plants')
    assert plants.status_code == 200
    assert plants.json() == []


def test_site_engineer_cannot_create_issue_for_another_plant_or_equipment(client, db):
    own = Plant(site_code='SCOPE01', plant_name='Scoped Plant')
    other = Plant(site_code='SCOPE02', plant_name='Other Plant')
    db.add_all([own, other]); db.commit(); db.refresh(own); db.refresh(other)
    login_user(client, db, role='Site Engineer', name='Scoped Create Engineer', email='scope-create@example.com')
    from tests import conftest as test_conftest
    db.add(UserPlantAssignment(user_id=test_conftest._CURRENT_USER.id, plant_id=own.id, assignment_role='Site Engineer'))
    db.commit()
    # Cross-plant request is rejected even when the request body is otherwise valid.
    denied = client.post('/api/issues', json={
        'plant_id': str(other.id), 'description': 'Cross plant issue', 'severity': 'High',
        'equipment_ref': 'INV-OUTSIDE',
    })
    assert denied.status_code == 403, denied.text

    from app.core.models import Equipment
    outside = Equipment(plant_id=other.id, equipment_code='INV-OTHER', equipment_name='Other plant inverter', equipment_type='Inverter')
    db.add(outside); db.commit(); db.refresh(outside)
    same_plant_mismatch = client.post('/api/issues', json={
        'plant_id': str(own.id), 'equipment_id': str(outside.id), 'description': 'Mismatched equipment', 'severity': 'Medium',
    })
    assert same_plant_mismatch.status_code == 422, same_plant_mismatch.text

    created = client.post('/api/issues', json={
        'plant_id': str(own.id), 'description': 'Inverter fault at assigned plant',
        'severity': 'High', 'equipment_ref': 'INV-OWN',
    })
    assert created.status_code == 201, created.text
    assert created.json()['plant_id'] == str(own.id)


def test_bootstrap_contains_authenticated_scope_permissions_and_identity(client, db):
    plant = Plant(site_code='BOOT01', plant_name='Bootstrap Plant')
    db.add(plant); db.commit(); db.refresh(plant)
    user = login_user(client, db, role='Site Engineer', name='Bootstrap Engineer', email='bootstrap@example.com')
    db.add(UserPlantAssignment(user_id=user.id, plant_id=plant.id, assignment_role='Site Engineer')); db.commit()

    body = client.get('/api/bootstrap').json()
    assert body['user']['id'] == str(user.id)
    assert body['user']['role'] == 'Site Engineer'
    assert body['scope']['type'] == 'plant'
    assert body['scope']['plant_ids'] == [str(plant.id)]
    assert body['scope']['plant']['site_code'] == 'BOOT01'
    assert 'issues.create' in body['permissions']
    assert 'tasks.execute' in body['permissions']
    assert 'Settings' not in body['modules']


def test_administration_bootstrap_exposes_only_command_centre_and_reports(client, db):
    login_user(client, db, role='Administration', name='Executive', email='exec-modules@example.com')
    body = client.get('/api/bootstrap').json()
    assert body['modules'] == ['Command Center', 'Reports']
    assert 'tasks.create' not in body['permissions']


def test_issue_domain_mutations_create_user_notifications_and_server_ticket(client, db):
    plant = Plant(site_code='NOTIF01', plant_name='Notification Plant')
    db.add(plant); db.commit(); db.refresh(plant)
    engineer = login_user(client, db, role='Site Engineer', name='Notify Engineer', email='notify-engineer@example.com')
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id, assignment_role='Site Engineer'))
    head = User(auth_provider='supabase', external_subject='notify-head', email='notify-head@example.com', display_name='Notify Head', role='O&M Head', is_active=True)
    db.add(head); db.commit(); db.refresh(head)

    created = client.post('/api/issues', json={
        'plant_id': str(plant.id), 'description': 'Critical inverter alarm', 'severity': 'Critical',
    })
    assert created.status_code == 201, created.text
    assert created.json()['ticket_no'].startswith('ISS-')
    issue_id = created.json()['id']

    db.expire_all()
    from app.core.models import Notification
    assert db.query(Notification).filter(Notification.user_id == head.id, Notification.event_type == 'critical_issue').count() == 1
    assert db.query(Notification).filter(Notification.user_id == engineer.id).count() == 0

    login_user(client, db, role='O&M Head', name='Notification Reviewer', email='notification-reviewer@example.com')
    acknowledged = client.post(f'/api/issues/{issue_id}/acknowledge')
    assert acknowledged.status_code == 200
    progressed = client.post(f'/api/issues/{issue_id}/progress', json={'note': 'Investigating alarm'})
    assert progressed.status_code == 200
    issue = db.query(Issue).filter(Issue.id == UUID(str(issue_id))).one()
    issue.legacy_payload = {'evidence':[{'id':'FIX-NOTIF','storage_path':'private/fix-notif.jpg'}]}
    db.commit()
    resolved = client.post(f'/api/issues/{issue_id}/resolve', json={
        'note':'Resolved','root_cause':'Loose terminal','corrective_action':'Tightened terminal',
        'evidence_ids':['FIX-NOTIF'],
    })
    assert resolved.status_code == 200
    assert db.query(Notification).filter(Notification.user_id == head.id, Notification.event_type == 'issue_progress').count() == 1
    assert db.query(Notification).filter(Notification.user_id == head.id, Notification.event_type == 'issue_status_changed').count() == 2


def test_issue_filters_support_equipment_site_date_and_project_number(client, db):
    login_user(client, db)
    plant = Plant(site_code='FILTER02', plant_name='Filter Plant 2', custom_fields={'projectNumber': 'PRJ-9021'})
    db.add(plant); db.commit(); db.refresh(plant)
    from app.core.models import Equipment, Issue
    eq = Equipment(plant_id=plant.id, equipment_code='INV-9021', equipment_name='Inverter 9021', equipment_type='Inverter')
    db.add(eq); db.commit(); db.refresh(eq)
    db.add(Issue(ticket_no='TKT-FLT-9021', plant_id=plant.id, equipment_id=eq.id, equipment_ref='INV-9021', description='Date scoped issue', severity='High', occurred_at=datetime(2026, 9, 20), legacy_payload={'projectNumber':'PRJ-9021'}))
    db.commit()
    assert len(client.get('/api/issues?equipment=9021').json()) == 1
    assert len(client.get('/api/issues?site_code=FILTER02').json()) == 1
    assert len(client.get('/api/issues?occurred_from=2026-09-19&occurred_to=2026-09-21').json()) == 1
    assert len(client.get('/api/issues?project_number=9021').json()) == 1


def test_washing_domain_endpoint_is_plant_scoped(client, db):
    own = Plant(site_code='WAPI01', plant_name='Washing API Own')
    other = Plant(site_code='WAPI02', plant_name='Washing API Other')
    db.add_all([own, other]); db.commit(); db.refresh(own); db.refresh(other)
    user = login_user(client, db, role='Site Engineer', name='Washing Engineer', email='washing-api@example.com')
    db.add(UserPlantAssignment(user_id=user.id, plant_id=own.id, assignment_role='Site Engineer'))
    db.add_all([
        WashingTable(legacy_id='WAPI-OWN', plant_id=own.id, next_due_on=date(2026,9,29)),
        WashingTable(legacy_id='WAPI-OTHER', plant_id=other.id, next_due_on=date(2026,9,29)),
    ])
    db.add(WashingConfig(plant_id=own.id, frequency_days=14)); db.commit()
    denied = client.post('/api/scheduled/washing/WAPI-OTHER/log')
    assert denied.status_code == 403, denied.text
    logged = client.post('/api/scheduled/washing/WAPI-OWN/log')
    assert logged.status_code == 409, logged.text
    assert 'daily washing report' in logged.json()['detail'].lower()


def test_site_engineer_multiple_assignments_fails_closed(client, db):
    first = Plant(site_code='MULTI01', plant_name='Multi One')
    second = Plant(site_code='MULTI02', plant_name='Multi Two')
    db.add_all([first, second]); db.commit(); db.refresh(first); db.refresh(second)
    user = login_user(client, db, role='Site Engineer', name='Multi Engineer', email='multi@example.com')
    db.add_all([
        UserPlantAssignment(user_id=user.id, plant_id=first.id, assignment_role='Site Engineer'),
        UserPlantAssignment(user_id=user.id, plant_id=second.id, assignment_role='Site Engineer'),
    ]); db.commit()
    response = client.get('/api/bootstrap')
    assert response.status_code == 403
    assert 'exactly one plant' in response.json()['detail']


def test_assignee_can_read_only_scoped_extra_services(client, db):
    own = Plant(site_code='SVC01', plant_name='Service Own')
    other = Plant(site_code='SVC02', plant_name='Service Other')
    db.add_all([own, other]); db.commit(); db.refresh(own); db.refresh(other)
    user = login_user(client, db, role='Assignee', name='Service Assignee', email='service-assignee@example.com')
    db.add(UserEquipmentTypeAssignment(user_id=user.id, equipment_type='Inverter')); db.commit()
    from app.core.models import InventoryItem
    db.add_all([
        InventoryItem(legacy_id='INV-OWN', plant_id=own.id, item_name='Own Stock', payload={'id':'INV-OWN','plant':'Service Own'}),
        InventoryItem(legacy_id='INV-OTHER', plant_id=other.id, item_name='Other Stock', payload={'id':'INV-OTHER','plant':'Service Other'}),
    ]); db.commit()
    rows = client.get('/api/inventory').json()
    # An Assignee owns an equipment type across every plant, so both plants' stock is visible.
    assert sorted(r['id'] for r in rows) == ['INV-OTHER', 'INV-OWN']
    assert client.get('/api/vendors').status_code == 403


def test_viewer_and_ceo_cannot_mutate_legacy_state(client, db):
    login_user(client, db, role='Viewer', name='Pending User', email='viewer-state@example.com')
    state = client.get('/api/bootstrap').json()
    blocked = client.put('/api/state/sync', json={'revision':state['revision'], 'state':state['state']})
    assert blocked.status_code == 200

    # Switch to Administration and confirm the compatibility endpoint remains a no-op for this read-only role.
    from tests import conftest as test_conftest
    headless = login_user(client, db, role='Administration', name='Executive', email='exec-state@example.com')
    state2 = client.get('/api/bootstrap').json()
    before_revision = state2['revision']
    response = client.put('/api/state/sync', json={'revision':before_revision, 'state':state2['state']})
    assert response.status_code == 200
    assert response.json()['revision'] == before_revision



def test_app_can_be_installed_as_desktop_app(client):
    m = client.get('/manifest.webmanifest')
    assert m.status_code == 200 and m.json()['display'] == 'standalone'
    for icon in m.json()['icons']:
        assert client.get(icon['src']).status_code == 200
    sw = client.get('/sw.js')
    assert sw.status_code == 200 and sw.headers['service-worker-allowed'] == '/'
