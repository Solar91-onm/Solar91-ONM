"""PM findings become site issues only when the plant's PM Assignee (or an O&M Head) raises them.

Submitting a checklist creates no ticket. The PM Assignee is notified, opens the record and
raises the Not OK items they choose in one go: routed, attributable and deduplicated.
"""
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import select, func
from app.core.models import Issue, Notification, IssueHistory, PlantResponsibility
from app.pmplan.tracking import CHECKLISTS, PMTrackingActivity
from tests.conftest import login_user, seed_work_categories
from tests.test_pm_tracking import setup_rows, engineer, submit, act, BASE
from tests.test_equipment_responsibility import _act_as, _assignee
from tests.test_site_issue_routing import set_rule
from tests.test_site_issue_responsibility_dialog import chromium  # noqa: F401  (browser fixture)


def findings(row):
    checks = [{'result': 'OK'} for _ in CHECKLISTS[row.equipment]]
    checks[0] = {'result': 'Not OK', 'note': 'Dust and debris found'}
    checks[1] = {'result': 'Not OK', 'note': 'Loose terminal observed'}
    checks[2] = {'result': 'N/A', 'note': 'Not applicable to this unit'}
    return checks


def pm_owner(db, plant, name='PM owner', email='pm-owner@pm.test'):
    owner = _assignee(db, name, email)
    db.add(PlantResponsibility(plant_id=plant.id, area='pm', assigned_user_id=owner.id))
    db.commit()
    return owner


def item_ids(db, row):
    db.expire_all()
    stored = db.get(PMTrackingActivity, row.id).checklist
    return [c['id'] for c in stored if c['result'] != 'OK' and c['result'] != 'N/A']


def raise_issues(client, row, ids):
    return client.post(f'{BASE}/{row.id}/raise-issues', json={'item_ids': ids})


def activity(client, row):
    body = client.get(BASE, params={'month': '2026-11', 'site_code': 'ABH01'}).json()
    return next(a for a in body['activities'] if a['id'] == str(row.id))


def test_submit_creates_no_issue_and_notifies_the_pm_assignee_to_review(client, db, monkeypatch):
    plant, _, rows = setup_rows(db, monkeypatch)
    row = rows[0]
    head = login_user(client, db, role='O&M Head', email='head@pm.test')
    owner = pm_owner(db, plant)
    unrelated = _assignee(db, 'Unrelated', 'unrelated@pm.test')
    se = engineer(client, db, plant)
    abnormal = findings(row); abnormal[1] = {'result': 'Abnormality', 'note': 'Retired option'}
    assert submit(client, row, abnormal).status_code == 422
    resp = submit(client, row, findings(row))
    assert resp.status_code == 200, resp.text
    assert resp.json()['corrective_issues'] == []
    assert db.scalar(select(func.count()).select_from(Issue)) == 0
    notes = list(db.scalars(select(Notification).where(Notification.target_type == 'pm_activity',
                                                      Notification.target_id == str(row.id))))
    assert {n.user_id for n in notes} == {head.id, owner.id}
    assert all(n.title == 'PM checklist submitted · 2 Not OK to review' for n in notes)
    assert all('open the record to raise site issues' in n.message for n in notes)
    assert all(n.payload['activity_id'] == str(row.id) and n.payload['page'] == 'pm' for n in notes)
    # Who sees the "Raise site issues" control on the record.
    for person, expected in [(se, False), (unrelated, False), (owner, True), (head, True)]:
        _act_as(db, person)
        out = activity(client, row)
        assert out['can_raise_issues'] is expected, person.role
        assert out['raised_issues'] == {}


def test_pm_assignee_raises_chosen_findings_once_routed_and_notified(client, db, monkeypatch):
    plant, _, rows = setup_rows(db, monkeypatch)
    row = rows[0]
    head = login_user(client, db, role='O&M Head', email='head@pm.test')
    primary = _assignee(db, 'Primary', 'primary@pm.test')
    backup = _assignee(db, 'Backup', 'backup@pm.test')
    seed_work_categories(db, 'Inverter')
    assert set_rule(client, [plant], 'inverter', primary, backup).status_code == 200
    primary.is_active = False
    db.commit()
    owner = pm_owner(db, plant)
    se = engineer(client, db, plant)
    assert submit(client, row, findings(row)).status_code == 200
    first, second = item_ids(db, row)

    _act_as(db, owner)
    resp = raise_issues(client, row, [first])
    assert resp.status_code == 200, resp.text
    assert [x['created'] for x in resp.json()['corrective_issues']] == [True]
    ticket = db.scalar(select(Issue))
    assert ticket.plant_id == plant.id and ticket.assigned_to == backup.id and ticket.status == 'Assigned'
    assert ticket.vertical == 'Inverter' and ticket.serial_no == row.equipment_id and ticket.created_by == owner.id
    assert ticket.equipment_running is None and ticket.severity == 'Medium'
    assert 'Dust and debris found' in ticket.description and f'Found by: {se.display_name}' in ticket.description
    assert ticket.legacy_payload['pm_source']['submitted_name'] == se.display_name
    assert ticket.source_task == f'PM:{row.id}:{first}'
    notices = list(db.scalars(select(Notification).where(Notification.target_type == 'issue',
                                                        Notification.target_id == ticket.ticket_no)))
    assert {n.user_id for n in notices} == {head.id, backup.id}
    assert all(n.event_type == 'ticket_assigned' for n in notices)
    out = activity(client, row)
    assert out['raised_issues'] == {first: ticket.ticket_no} and out['can_raise_issues'] is True

    # A repeat (double click, a second reviewer) links the existing ticket instead of a duplicate.
    again = raise_issues(client, row, [first, second])
    assert [x['created'] for x in again.json()['corrective_issues']] == [False, True]
    assert db.scalar(select(func.count()).select_from(Issue)) == 2
    assert db.scalar(select(func.count()).select_from(IssueHistory).where(IssueHistory.action == 'issue.auto_assigned')) == 2
    assert activity(client, row)['can_raise_issues'] is False
    _act_as(db, backup)
    register = client.get('/api/issues', params={'mine': True}).json()
    assert len(register) == 2 and all(i['source_task'].startswith('PM:') for i in register)

    # Still raisable after approval; a returned checklist is being redone, so it is not.
    _act_as(db, head)
    assert act(client, row, 'approve').status_code == 200
    assert raise_issues(client, row, [first]).status_code == 200
    assert db.scalar(select(func.count()).select_from(Issue)) == 2


def test_only_the_plant_pm_assignee_or_an_om_head_may_raise(client, db, monkeypatch):
    plant, _, rows = setup_rows(db, monkeypatch)
    row = rows[0]
    head = login_user(client, db, role='O&M Head', email='head@pm.test')
    owner = pm_owner(db, plant)
    unrelated = _assignee(db, 'Unrelated', 'unrelated@pm.test')
    se = engineer(client, db, plant)
    assert raise_issues(client, rows[0], ['x']).status_code == 403  # Site Engineer
    assert submit(client, row, findings(row)).status_code == 200
    first, _ = item_ids(db, row)
    _act_as(db, se)
    assert raise_issues(client, row, [first]).status_code == 403
    _act_as(db, unrelated)
    assert raise_issues(client, row, [first]).status_code == 403
    _act_as(db, owner)
    ok_item = next(c['id'] for c in db.get(PMTrackingActivity, row.id).checklist if c['result'] == 'OK')
    assert raise_issues(client, row, [ok_item]).status_code == 422
    assert raise_issues(client, row, []).status_code == 422
    assert raise_issues(client, rows[1], [first]).status_code == 409  # not submitted
    _act_as(db, head)
    assert act(client, row, 'return', 'Recheck').status_code == 200
    _act_as(db, owner)
    assert raise_issues(client, row, [first]).status_code == 409  # returned for correction
    assert db.scalar(select(func.count()).select_from(Issue)) == 0


def test_head_can_raise_when_the_plant_has_no_pm_assignee(client, db, monkeypatch):
    plant, _, rows = setup_rows(db, monkeypatch)
    head = login_user(client, db, role='O&M Head', email='unconfigured-head@pm.test')
    engineer(client, db, plant)
    assert submit(client, rows[0], findings(rows[0])).status_code == 200
    ids = item_ids(db, rows[0])
    _act_as(db, head)
    resp = raise_issues(client, rows[0], ids)
    assert resp.status_code == 200, resp.text
    issues = list(db.scalars(select(Issue)))
    assert len(issues) == 2 and all(i.assigned_to is None and i.status == 'Open' for i in issues)
    notices = list(db.scalars(select(Notification).where(Notification.target_type == 'issue')))
    assert {n.user_id for n in notices} == {head.id} and all(n.event_type == 'issue_unassigned' for n in notices)


def test_older_abnormality_results_stay_raisable(client, db, monkeypatch):
    plant, _, rows = setup_rows(db, monkeypatch)
    row = rows[0]
    owner = pm_owner(db, plant)
    engineer(client, db, plant)
    assert submit(client, row, findings(row)).status_code == 200
    db.expire_all()
    stored = db.get(PMTrackingActivity, row.id)
    checklist = [dict(c) for c in stored.checklist]
    checklist[1]['result'] = 'Abnormality'  # recorded before the option was retired
    stored.checklist = checklist
    db.commit()
    _act_as(db, owner)
    assert raise_issues(client, row, [checklist[1]['id']]).json()['corrective_issues'][0]['created'] is True
    assert db.scalar(select(Issue.subcategory)) == 'PM checklist: Abnormality'


def test_submitting_never_reaches_the_issue_bridge(client, db, monkeypatch):
    plant, _, rows = setup_rows(db, monkeypatch)
    engineer(client, db, plant)
    def forbidden(*args, **kw):
        pytest.fail('Submitting must not invoke the issue bridge')
    monkeypatch.setattr('app.pmplan.issue_bridge.create_corrective_issues', forbidden)
    resp = submit(client, rows[0], findings(rows[0]))  # Not OK items included
    assert resp.status_code == 200, resp.text
    assert resp.json()['corrective_issues'] == []
    assert db.scalar(select(func.count()).select_from(Issue)) == 0


def test_invalid_preview_locked_and_out_of_scope_submissions(client, db, monkeypatch):
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


def test_ticket_notification_failure_rolls_back_the_whole_raise(client, db, monkeypatch):
    plant, _, rows = setup_rows(db, monkeypatch)
    owner = pm_owner(db, plant)
    engineer(client, db, plant)
    assert submit(client, rows[0], findings(rows[0])).status_code == 200
    ids = item_ids(db, rows[0])
    def fail(*args, **kw):
        raise RuntimeError('forced failure')
    monkeypatch.setattr('app.pmplan.issue_bridge.notify_users', fail)
    _act_as(db, owner)
    with pytest.raises(RuntimeError, match='forced failure'):
        raise_issues(client, rows[0], ids)
    db.expire_all()
    assert db.get(PMTrackingActivity, rows[0].id).status == 'Pending approval'
    assert db.scalar(select(func.count()).select_from(Issue)) == 0
    assert db.scalar(select(func.count()).select_from(Notification).where(Notification.target_type == 'issue')) == 0


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
    assert submit(client, row, checks).status_code == 200
    _act_as(db, head)
    response = raise_issues(client, row, item_ids(db, row))
    assert response.status_code == 200, response.text
    assert {(i.vertical, i.assigned_to) for i in db.scalars(select(Issue))} == {('ACDB', a.id), ('Aux. Transformer', b.id)}


ROOT = Path(__file__).resolve().parents[1]


def review_page(browser, can_raise):
    page = browser.new_page(viewport={'width': 1280, 'height': 900})
    page.set_default_timeout(5000)
    page.set_content('<main id="host"></main>')
    for css in ('tokens.css', 'pm-tracking.css'):
        page.add_style_tag(path=str(ROOT / 'assets/css' / css))
    page.evaluate('''(canRaise) => {
      window.Solar91PortalFormat={escape:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
      window.Solar91PortalNav={getState:()=>({activeView:'plant-sub',selectedPlant:'P1',selectedSubPage:'pm',pmCalendarOpen:true})};
      window.posts=[];window.invalidated=0;
      window.Solar91PortalIssues={invalidate(){window.invalidated+=1;}};
      const checklist=[{id:'n1',task:'Check cooling fan',result:'Not OK',note:'Fan noisy'},
                       {id:'n2',task:'Check heat sink',result:'Not OK',note:'Dusty fins'},
                       {id:'k1',task:'Check display',result:'OK',note:''}];
      const activity={id:'a1',plant_id:'p1',equipment:'Inverter',equipment_id:'INV 1',date:'2026-12-01',status:'Pending approval',
        label:'Pending approval',can_submit:false,checklist,checks:checklist.map(c=>c.task),checklistItemIds:['n1','n2','k1'],
        submitted_name:'Site Engineer',inspected_on:'2026-12-01',permission:'None',raised_issues:{},can_raise_issues:canRaise};
      const body={month:'2026-12',today:'2026-12-01',role:'Assignee',plants:[{id:'p1',site_code:'P1',name:'Test plant',configured:true}],
        activities:[activity],legacy:[],categories:['Inverter'],covered:['Inverter']};
      window.Solar91PortalAPI={request:(url,opt)=>{
        if(opt?.method==='POST'){posts.push([url,opt.body]);activity.raised_issues={n1:'ISS-0101'};
          return Promise.resolve({corrective_issues:[{ticket_no:'ISS-0101',created:true}]});}
        return Promise.resolve(JSON.parse(JSON.stringify(body)));}};
    }''', can_raise)
    page.add_script_tag(path=str(ROOT / 'assets/js/pm-tracking.js'))
    page.evaluate("Solar91PMTracking.show(document.getElementById('host'),{siteCode:'P1',calendar:true,initialMonth:'2026-12',eventId:'a1'})")
    return page


def test_pm_assignee_reviews_and_raises_ticked_findings_in_one_go(chromium):
    page = review_page(chromium, True)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        form = page.locator('[data-pmx-raise-form]')
        form.wait_for()
        button = form.locator('[data-pmx-raise-btn]')
        assert button.inner_text() == 'Raise 2 site issues'
        assert form.locator('input[name=item]:checked').count() == 2
        assert 'Fan noisy' in form.inner_text() and 'Check display' not in form.inner_text()
        form.locator('input[value=n2]').uncheck()
        assert button.inner_text() == 'Raise 1 site issue'
        form.locator('input[value=n1]').uncheck()
        assert button.is_disabled() and button.inner_text() == 'Choose findings to raise'
        form.locator('input[value=n1]').check()
        button.click()
        page.get_by_text('1 site issue raised from INV 1: ISS-0101.').first.wait_for()
        assert page.evaluate('posts') == [['/api/pm-plan/tracking/a1/raise-issues', {'item_ids': ['n1']}]]
        assert page.evaluate('invalidated') == 1
        chip = page.locator('.s91pm-results [data-pmx="open-ticket"]')
        assert chip.count() == 1 and chip.inner_text() == 'ISS-0101'
        assert page.locator('[data-pmx-raise-form] [data-pmx-raise-btn]').inner_text() == 'Raise 1 site issue'
        assert page.locator('[data-pmx-raise-form] input[name=item]').count() == 1  # only the one left
        # The checklist no longer offers "Abnormality".
        page.get_by_role('button', name='Open checklist (preview)').click()
        options = page.locator('[data-pmx-submit-form] [name=result0] option').all_inner_texts()
        assert options == ['Select result', 'OK', 'Not OK', 'N/A']
        assert not errors, errors
    finally:
        page.close()


def test_other_people_see_findings_await_the_pm_assignee(chromium):
    page = review_page(chromium, False)
    try:
        page.get_by_text("2 Not OK findings awaiting review by the plant's PM Assignee").wait_for()
        assert page.locator('[data-pmx-raise-form]').count() == 0
    finally:
        page.close()


def test_frontend_offers_no_abnormality_and_a_one_go_raise():
    root = Path(__file__).resolve().parents[1]
    js = (root/'assets/js/site-issues.js').read_text(encoding='utf-8-sig')
    pm = (root/'assets/js/pm-tracking.js').read_text(encoding='utf-8-sig')
    assert 'sourceTask: issue.source_task' in js
    assert js.count('pmSourceBadge(issue)') >= 3
    assert 'From Preventive Maintenance' in js
    assert "['OK','Not OK','N/A']" in pm and "'Abnormality','N/A'" not in pm
    assert "Not OK results are sent to the plant's PM Assignee" in pm
    assert "/raise-issues'" in pm and 'data-pmx-raise-form' in pm
