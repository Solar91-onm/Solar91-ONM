from app.core.models import Plant
from tests.conftest import login_user


def test_optional_supervisor_create_edit_clear_and_validation(client, db):
    login_user(client, db)
    res = client.post('/api/plants', json={'site_code': 'SUP01', 'plant_name': 'Test plant', 'address': 'Test plant address'})
    assert res.status_code == 201, res.text
    assert res.json()['supervisor'] is None
    url = '/api/plants/' + res.json()['id']
    res = client.patch(url, json={'supervisor': 'Site supervisor'})
    assert res.status_code == 200 and res.json()['supervisor'] == 'Site supervisor'
    res = client.patch(url, json={'district': 'Test district'})
    assert res.json()['supervisor'] == 'Site supervisor'
    assert client.patch(url, json={'supervisor': 'a'*161}).status_code == 422
    res = client.patch(url, json={'supervisor': None})
    assert res.status_code == 200 and res.json()['supervisor'] is None


def test_supervisor_blank_excel_does_not_erase_existing(client, db):
    login_user(client, db)
    db.add(Plant(site_code='SUP01', plant_name='Existing', supervisor='Keep name'))
    db.commit()
    res = client.post('/api/imports/plants', files={'file': ('plants.csv', b'Site Code,Plant Name,Supervisor\nSUP01,Existing,\nSUP02,New,New supervisor\n', 'text/csv')})
    assert res.status_code == 200, res.text
    db.expire_all()
    assert db.query(Plant).filter_by(site_code='SUP01').one().supervisor == 'Keep name'
    assert db.query(Plant).filter_by(site_code='SUP02').one().supervisor == 'New supervisor'
