"""PM findings create real, attributable and deduplicated site issues."""
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import select, func
from app.core.models import Issue, Notification, IssueHistory
from app.pmplan.tracking import CHECKLISTS, PMTrackingActivity
from tests.conftest import login_user, seed_work_categories
from tests.test_pm_tracking import setup_rows, engineer, submit, act, BASE
from tests.test_equipment_responsibility import _act_as, _assignee
from tests.test_site_issue_routing import set_rule


def findings(row):
    checks = [{'result': 'OK'} for _ in CHECKLISTS[row.equipment]]
    checks[0] = {'result': 'Not OK', 'note': 'Dust and debris found'}
    checks[1] = {'result': 'Abnormality', 'note': 'Loose terminal observed'}
    checks[2] = {'result': 'N/A', 'note': 'Not applicable to this unit'}
    return checks


def test_pm_findings_create_assigned_issues_once_and_notify_correct_people(client, db, monkeypatch):
    plant, _, rows = setup_rows(db, monkeypatch)
    row = rows[0]
    head = login_user(client, db, role='O&M Head', email='head@pm.test')
    primary = _assignee(db, 'Primary', 'primary@pm.test')
    backup = _assignee(db, 'Backup', 'backup@pm.test')
    unrelated = _assignee(db, 'Unrelated', 'unrelated@pm.test')
    seed_work_categories(db, 'Inverter')
    assert set_rule(client, [plant], 'inverter', primary, backup).status_code == 200
    primary.is_active = False
    db.commit()
    se = engineer(client, db, plant)
    resp = submit(client, row, findings(row))
    assert resp.status_code == 200, resp.text
    assert len(resp.json()['corrective_issues']) == 2
    assert all(x['created'] for x in resp.json()['corrective_issues'])
    tickets = list(db.scalars(select(Issue).order_by(Issue.ticket_no)))
    assert len(tickets) == 2
    assert all(t.plant_id == plant.id and t.assigned_to == backup.id and t.status == 'Assigned' for t in tickets)
    assert all(t.vertical == 'Inverter' and t.serial_no == row.equipment_id and t.created_by == se.id for t in tickets)
    assert all(t.equipment_running is None and t.severity == 'Medium' for t in tickets)
    assert 'Dust and debris found' in tickets[0].description
    assert tickets[0].source_task.startswith(f'PM:{row.id}:')
    assert len({t.source_task for t in tickets}) == 2
    assert db.scalar(select(func.count()).select_from(IssueHistory).where(IssueHistory.action == 'issue.auto_assigned')) == 2
    for ticket in tickets:
        notices = list(db.scalars(select(Notification).where(Notification.target_type == 'issue', Notification.target_id == ticket.ticket_no)))
        assert {n.user_id for n in notices} == {head.id, backup.id}
        assert all(n.event_type == 'ticket_assigned' for n in notices)
    _act_as(db, backup)
    register = client.get('/api/issues', params={'mine': True}).json()
    assert {i['ticket_no'] for i in register} == {t.ticket_no for t in tickets}
    assert all(i['source_task'].startswith('PM:') for i in register)
    _act_as(db, unrelated)
    assert client.get('/api/issues', params={'mine': True}).json() == []
    _act_as(db, se)
    assert submit(client, row, findings(row)).status_code == 409
    _act_as(db, head)
    assert act(client, row, 'return', 'Recheck').status_code == 200
    _act_as(db, se)
    again = submit(client, row, findings(row))
    assert again.status_code == 200, again.text
    assert not any(x['created'] for x in again.json()['corrective_issues'])
    assert db.scalar(select(func.count()).select_from(Issue)) == 2
    assert db.scalar(select(func.count()).select_from(Notification).where(Notification.target_type == 'issue')) == 4


def test_clean_and_na_checklist_no_issue_or_routing_lookup(client, db, monkeypatch):
    plant, _, rows = setup_rows(db, monkeypatch)
    engineer(client, db, plant)
    def forbidden(*args, **kw):
        pytest.fail('Healthy checklist must not invoke issue bridge')
    monkeypatch.setattr('app.pmplan.issue_bridge.create_corrective_issues', forbidden)
    checks = [{'result': 'OK'} for _ in CHECKLISTS['Inverter']]
    checks[1] = {'result': 'N/A', 'note': 'Not applicable'}
    assert submit(client, rows[0], checks).json()['corrective_issues'] == []
    assert db.scalar(select(func.count()).select_from(Issue)) == 0


def test_invalid_preview_locked_and_out_of_scope_never_raise_issue(client, db, monkeypatch):
    plant, _, rows = setup_rows(db, monkeypatch)
    engineer(client, db, plant)
    assert submit(client, rows[1], findings(rows[1])).status_code == 409
    assert submit(client, rows[4], findings(rows[4])).status_code == 404
    monkeypatch.setattr('app.pmplan.tracking.business_today', lambda: date(2026, 10, 31))
    assert submit(client, rows[0], findings(rows[0])).status_code == 409
    monkeypatch.setattr('app.pmplan.tracking.business_today', lambda: date(2026, 11, 25))
    bad = findings(rows[0]); bad[0]['note'] = ''
    assert submit(client, rows[0], bad).status_code == 422
    assert db.scalar(select(func.count()).select_from(Issue)) == 0


def test_assignee_can_submit_but_not_approve_and_unconfigured_escalates(client, db, monkeypatch):
    plant, _, rows = setup_rows(db, monkeypatch)
    head = login_user(client, db, role='O&M Head', email='unconfigured-head@pm.test')
    assignee = login_user(client, db, role='Assignee', email='reporter@pm.test')
    resp = submit(client, rows[0], findings(rows[0]))
    assert resp.status_code == 200, resp.text
    assert act(client, rows[0], 'approve').status_code == 409
    issues = list(db.scalars(select(Issue)))
    assert all(i.assigned_to is None and i.status == 'Open' for i in issues)
    notices = list(db.scalars(select(Notification).where(Notification.target_type == 'issue')))
    assert len(notices) == 2 and {n.user_id for n in notices} == {head.id}
    assert all(n.event_type == 'issue_unassigned' for n in notices)


def test_ticket_notification_failure_rolls_back_whole_submission(client, db, monkeypatch):
    plant, _, rows = setup_rows(db, monkeypatch)
    engineer(client, db, plant)
    def fail(*args, **kw):
        raise RuntimeError('forced failure')
    monkeypatch.setattr('app.pmplan.issue_bridge.notify_users', fail)
    with pytest.raises(RuntimeError, match='forced failure'):
        submit(client, rows[0], findings(rows[0]))
    db.expire_all()
    assert db.get(PMTrackingActivity, rows[0].id).status == 'Scheduled'
    assert db.scalar(select(func.count()).select_from(Issue)) == 0
    assert db.scalar(select(func.count()).select_from(Notification)) == 0


def test_combined_equipment_routes_specific_check_section(client, db, monkeypatch):
    plant, _, _ = setup_rows(db, monkeypatch)
    row = PMTrackingActivity(plant_id=plant.id, equipment='4 Pole + ACDB + Aux. TX', equipment_id='Combined visit', scheduled_on=date(2026, 11, 1))
    db.add(row); db.commit()
    head = login_user(client, db, role='O&M Head')
    a = _assignee(db, 'ACDB owner', 'acdb@pm.test')
    b = _assignee(db, 'Transformer owner', 'transformer@pm.test')
    seed_work_categories(db, 'ACDB', 'Aux. Transformer')
    assert set_rule(client, [plant], 'acdb', a).status_code == 200
    assert set_rule(client, [plant], 'aux_transformer', b).status_code == 200
    engineer(client, db, plant)
    checks = [{'result': 'OK'} for _ in CHECKLISTS[row.equipment]]
    for prefix in ('ACDB', 'Auxiliary Transformer'):
        i = next(i for i, text in enumerate(CHECKLISTS[row.equipment]) if text.startswith(prefix))
        checks[i] = {'result': 'Not OK', 'note': 'Corrective work required'}
    response = submit(client, row, checks)
    assert response.status_code == 200, response.text
    assert {(i.vertical, i.assigned_to) for i in db.scalars(select(Issue))} == {('ACDB', a.id), ('Aux. Transformer', b.id)}


def test_frontend_provenance_and_submit_feedback_present():
    root = Path(__file__).resolve().parents[1]
    js = (root/'assets/js/site-issues.js').read_text(encoding='utf-8-sig')
    pm = (root/'assets/js/pm-tracking.js').read_text(encoding='utf-8-sig')
    assert 'sourceTask: issue.source_task' in js
    assert js.count('pmSourceBadge(issue)') >= 3
    assert 'From Preventive Maintenance' in js
    assert 'saved?.corrective_issues' in pm
    assert 'Not OK and Abnormality results create corrective Site Issues on submission' in pm
