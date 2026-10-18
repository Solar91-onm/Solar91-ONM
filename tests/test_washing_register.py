from __future__ import annotations

from datetime import date

from app.core.models import Plant, WashingConfig, WashingHistory, WashingTable, StateRevision
from app.core.config import get_settings
from tests.conftest import login_user

BASE = '/api/scheduled/washing'


def _setup(db, client, role='O&M Head'):
    a = Plant(site_code='AAA_01', plant_name='Asadi')
    b = Plant(site_code='BBB_01', plant_name='Kerli Nadi')
    db.add_all([a, b]); db.commit(); db.refresh(a); db.refresh(b)
    login_user(client, db, role=role)
    return a, b


def _add(client, plant='Asadi', table='INV-01-T-01', inv=1, **extra):
    return client.post(f'{BASE}/register', json={'plant': plant, 'table_id': table, 'inverter': inv, **extra})


def test_bootstrap_retains_washing_and_compresses_valid_json(client, db, monkeypatch):
    plant, _ = _setup(db, client)
    table = WashingTable(
        legacy_id="WT-BOOT-001",
        plant_id=plant.id,
        inverter_no=1,
        table_code="INV-01-T-01",
        legacy_payload={},
    )
    db.add(table)
    db.flush()
    db.add(
        WashingHistory(
            washing_table_id=table.id,
            event_type="wash",
            event_date=date(2026, 10, 15),
            actor="Technician",
            notes="Initial bootstrap history",
        )
    )
    db.commit()
    monkeypatch.setattr(get_settings(), "bootstrap_include_washing", False)

    response = client.get("/api/bootstrap", headers={"Accept-Encoding": "gzip"})
    assert response.status_code == 200, response.text
    full = response.json()
    assert full["state"]["washing"][0]["history"][0]["notes"] == "Initial bootstrap history"
    assert response.headers["content-encoding"] == "gzip"
    assert int(response.headers["content-length"]) < len(response.content)

    lite_response = client.get("/api/bootstrap?lite=1")
    assert lite_response.status_code == 200, lite_response.text
    lite = lite_response.json()
    assert lite["state"]["washing"] == []
    for key in ("user", "scope", "permissions", "modules", "pending_access", "revision", "collection_revisions"):
        assert lite[key] == full[key]


def test_add_edit_move_delete_roundtrip(client, db):
    a, b = _setup(db, client)
    r = _add(client)
    assert r.status_code == 200, r.text
    tid = r.json()['table']['id']
    assert r.json()['table']['plant'] == 'Asadi'

    # edit: change table id + move to another plant (name typed with odd spacing/case)
    r = client.patch(f'{BASE}/{tid}/register', json={'plant': ' kerli  nadi ', 'table_id': 'INV-02-T-09', 'inverter': 2, 'secondary_inverter': 3, 'next_due': '2026-10-20'})
    assert r.status_code == 200, r.text
    db.expire_all()
    w = db.query(WashingTable).filter_by(legacy_id=tid).one()
    assert w.plant_id == b.id and w.table_code == 'INV-02-T-09' and w.secondary_inverter_no == 3

    # the table is served back under the right plant by bootstrap
    row = [x for x in client.get('/api/bootstrap').json()['state']['washing'] if x['id'] == tid][0]
    assert row['plant'] == 'Kerli Nadi' and row['tableId'] == 'INV-02-T-09'

    # delete is real (not resurrected by a later state sync)
    assert client.delete(f'{BASE}/{tid}/register').status_code == 200
    db.expire_all()
    assert db.query(WashingTable).filter_by(legacy_id=tid).count() == 0
    boot = client.get('/api/bootstrap').json()
    assert tid not in [x['id'] for x in boot['state']['washing']]


def test_validation_blocks_bad_links(client, db):
    _setup(db, client)
    assert _add(client, plant='No Such Plant').status_code == 404
    assert _add(client, table='  ').status_code == 422
    assert _add(client, inv='abc').status_code == 422
    assert _add(client, inv=0).status_code == 422
    assert _add(client, secondary_inverter=1, inv=1).status_code == 422
    assert _add(client, next_due='not-a-date').status_code == 422
    assert _add(client).status_code == 200
    # duplicate table id in same plant (case/space-insensitive) is refused; other plant is fine
    assert _add(client, table=' inv-01-t-01 ').status_code == 409
    assert _add(client, plant='Kerli Nadi').status_code == 200


def test_edit_cannot_create_duplicate(client, db):
    _setup(db, client)
    t1 = _add(client, table='T-1').json()['table']['id']
    _add(client, table='T-2')
    assert client.patch(f'{BASE}/{t1}/register', json={'table_id': 't-2'}).status_code == 409
    assert client.patch(f'{BASE}/{t1}/register', json={'table_id': 'T-1B'}).status_code == 200


def test_delete_removes_history_and_bumps_revision(client, db):
    a, _ = _setup(db, client)
    tid = _add(client).json()['table']['id']
    w = db.query(WashingTable).filter_by(legacy_id=tid).one()
    db.add(WashingHistory(washing_table_id=w.id, event_type='wash', event_date=__import__('datetime').date(2026, 10, 1), actor='x'))
    db.commit()
    before = db.get(StateRevision, 1).revision
    r = client.delete(f'{BASE}/{tid}/register')
    assert r.status_code == 200 and r.json()['revision'] == before + 1
    db.expire_all()
    assert db.query(WashingHistory).count() == 0


def test_move_relinks_unlinked_tables_and_blocks_clashes(client, db):
    a, b = _setup(db, client)
    # tables saved without a plant (the original bug): plant_id NULL, name only in payload
    for i in (1, 2):
        db.add(WashingTable(legacy_id=f'ORPH-{i}', plant_id=None, inverter_no=1, table_code=f'T-{i}', legacy_payload={'plant': 'Old  Name '}))
    db.commit()
    r = client.post(f'{BASE}/move', json={'from_plant': 'old name', 'to_plant': 'Asadi'})
    assert r.status_code == 200 and r.json()['moved'] == 2, r.text
    db.expire_all()
    assert db.query(WashingTable).filter(WashingTable.plant_id == a.id).count() == 2
    assert db.get(WashingConfig, a.id) is not None
    # moving Asadi -> Kerli Nadi when Kerli already has T-1 must be refused (no duplicates)
    assert _add(client, plant='Kerli Nadi', table='t-1').status_code == 200
    assert client.post(f'{BASE}/move', json={'from_plant': 'Asadi', 'to_plant': 'Kerli Nadi'}).status_code == 409
    assert client.post(f'{BASE}/move', json={'from_plant': 'Asadi', 'to_plant': 'Asadi'}).status_code == 422
    assert client.post(f'{BASE}/move', json={'from_plant': 'Ghost', 'to_plant': 'Asadi'}).status_code == 404


def test_only_o_and_m_head_can_edit_register(client, db):
    a, _ = _setup(db, client, role='Site Engineer')
    assert _add(client).status_code == 403
    login_user(client, db, role='O&M Head', name='Head', email='head@example.com')
    tid = _add(client).json()['table']['id']
    login_user(client, db, role='Site Engineer', name='SE', email='se2@example.com')
    assert client.patch(f'{BASE}/{tid}/register', json={'table_id': 'X'}).status_code == 403
    assert client.delete(f'{BASE}/{tid}/register').status_code == 403
    assert client.post(f'{BASE}/move', json={'from_plant': 'Asadi', 'to_plant': 'Kerli Nadi'}).status_code == 403
