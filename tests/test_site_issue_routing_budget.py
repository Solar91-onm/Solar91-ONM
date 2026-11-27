"""Synthetic 42-plant performance guard: query/byte budgets, not brittle wall time."""
from datetime import date
from pathlib import Path
from sqlalchemy import event
from app.core.models import AppSetting, EquipmentResponsibility, Issue
from app.equipment.issue_routing import SETTING_KEY
from app.equipment.service import canonical_key
from app.issues.service import IssueService
from app.pmplan.tracking import PMTrackingActivity
from tests.conftest import login_user, seed_work_categories
from tests.test_equipment_responsibility import _act_as, _assignee, _plants

BASE = '/api/equipment-responsibilities'


def test_routing_stays_off_page_read_paths_and_has_bounded_write_lookup(client, db):
    login_user(client, db, role='O&M Head')
    plants = _plants(db, *[f'BUD{i:02}' for i in range(42)])
    primary = _assignee(db, 'Primary', 'budget-primary@example.com')
    backup = _assignee(db, 'Backup', 'budget-backup@example.com')
    cats = ['Inverter'] + [f'Budget category {i}' for i in range(33)]
    seed_work_categories(db, *cats)
    for i in range(200):
        db.add(Issue(ticket_no=f'BUD-{i}', plant_id=plants[i % 42].id, vertical='Inverter',
                     description='Synthetic performance test', severity='Medium', status='Open'))
    for i in range(556):
        db.add(PMTrackingActivity(plant_id=plants[i % 33].id, equipment='Inverter',
                                  equipment_id=f'INV {i // 33 + 1}', scheduled_on=date(2026, 12, i % 28 + 1)))
    db.add(EquipmentResponsibility(equipment_key='inverter', equipment_label='Inverter',
                                    user_id=backup.id, position='primary', active=True))
    rules = {f'{p.id}:{canonical_key(c)}': {'primary_user_id': str(primary.id),
                                             'backup_user_id': str(backup.id)}
             for p in plants for c in cats}
    db.add(AppSetting(setting_key=SETTING_KEY, setting_value=rules))
    db.commit()
    statements = []
    bind = db.get_bind()

    def capture(conn, cursor, statement, parameters, *args):
        statements.append((statement, parameters))

    event.listen(bind, 'before_cursor_execute', capture)
    try:
        for path, query_budget, byte_budget in [
            ('/api/issues', 2, 80_000),
            ('/api/portal/plants', 3, 100_000),
            ('/api/portal/overview?version_only=true', 4, 1_000),
            ('/api/pm-plan/tracking?month=2026-12&summary=true', 12, 350_000),
            (BASE + '?include_routing=false', 4, 40_000),
        ]:
            statements.clear()
            response = client.get(path)
            assert response.status_code == 200, response.text
            assert len(statements) <= query_budget, (path, len(statements))
            assert len(response.content) < byte_budget, path
            assert not any(SETTING_KEY in str(params) for _, params in statements), path
            if path.startswith(BASE):
                assert 'issue_routing' not in response.json()
                assert 'plants' not in response.json()
        statements.clear()
        response = client.get(BASE + '/issue-routing')
        assert response.status_code == 200
        assert response.json()['issue_routing'] == rules
        assert len(response.json()['plants']) == 42
        assert len(statements) <= 2
        statements.clear()
        user, source = IssueService(db)._auto_assignee('Inverter', plants[0].id)
        assert user.id == primary.id and source == 'plant_equipment_primary'
        assert len(statements) == 2
        # A rule-specific owner who has no global equipment row must still be found.
        primary.is_active = False
        db.commit()
        statements.clear()
        user, source = IssueService(db)._auto_assignee('Inverter', plants[0].id)
        assert user.id == backup.id and source == 'plant_equipment_backup'
        assert len(statements) == 2
    finally:
        event.remove(bind, 'before_cursor_execute', capture)
    _act_as(db, backup)
    assert client.get(BASE + '/issue-routing').status_code == 403
    assert client.get(BASE + '?include_routing=false').status_code == 403


def test_settings_fetches_rules_only_on_explicit_open_or_refresh():
    source = (Path(__file__).resolve().parents[1] / 'assets/js/settings.js').read_text(encoding='utf-8')
    assert 'request("/api/equipment-responsibilities?include_routing=false")' in source
    page = source.split('function renderPage(host)', 1)[1]
    assert 'loadIssueRouting(' not in page
    assert 'equipment.routeOpen = false' in page
    assert 'if (equipment.routeOpen) loadIssueRouting(true)' in source
