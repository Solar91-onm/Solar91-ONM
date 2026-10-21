"""Ask Solar91 structured search: plain words become filters, every other word must match, scope is kept."""
from app.core.models import User
from tests import conftest
from tests.test_field_desk import fixture_data

SEARCH = '/api/field/search'


def _ids(response):
    return [row.get('ticket') or row['id'] for row in response.json()['records']]


def test_words_become_filters_and_every_term_must_match(client, db):
    head, engineer, plants = fixture_data(client, db)  # issue 0: Critical inverter at FE01, issue 1: Medium at FE02
    conftest._CURRENT_USER = db.get(User, head.id)
    critical = client.get(SEARCH, params={'q': 'critical inverter issues'})
    assert critical.status_code == 200, critical.text
    body = critical.json()
    assert body['filters']['modules'] == ['issues'] and body['filters']['severities'] == ['Critical']
    assert body['filters']['terms'] == ['inverter']
    assert [r['title'] for r in body['records']] == ['Inspect combiner 0']
    assert body['records'][0]['severity'] == 'Critical' and body['records'][0]['site_code'] == 'FE01'

    # "inspect module" must match both words: only the PM task, not "Inspect combiner …"
    both = client.get(SEARCH, params={'q': 'inspect module'}).json()
    assert [r['title'] for r in both['records']] == ['Inspect module'] and both['partial'] is False

    # no record has every word: the closest matches are shown and flagged as partial
    partial = client.get(SEARCH, params={'q': 'inspect zzzz'}).json()
    assert partial['partial'] is True and partial['records']


def test_plant_status_and_explicit_filters(client, db):
    head, engineer, plants = fixture_data(client, db)
    conftest._CURRENT_USER = db.get(User, head.id)
    at_plant = client.get(SEARCH, params={'q': 'issues at FE02'}).json()
    assert at_plant['filters']['plant'] == {'site_code': 'FE02', 'name': 'Field FE02'}
    assert {r['site_code'] for r in at_plant['records']} == {'FE02'} and len(at_plant['records']) == 1

    overdue = client.get(SEARCH, params={'q': 'overdue maintenance'}).json()
    assert overdue['filters']['statuses'] == ['overdue']
    assert _ids(client.get(SEARCH, params={'q': 'overdue maintenance'})) == ['FIELD-PM-1']

    medium = client.get(SEARCH, params={'module': 'issues', 'severity': 'medium'}).json()
    assert [r['title'] for r in medium['records']] == ['Inspect combiner 1']

    facets = client.get(SEARCH, params={'q': 'inspect'}).json()['facets']
    assert facets['module'] == {'issues': 2, 'pm': 1}
    assert facets['severity'] == {'Critical': 1, 'Medium': 1}
    assert facets['plant'] == {'FE02': 2, 'FE01': 1}

    assert client.get(SEARCH, params={'q': 'issues', 'plant': 'NOPE'}).json()['records'] == []
    assert client.get(SEARCH, params={'q': 'inspect', 'sort': 'bogus'}).status_code == 422


def test_search_never_leaves_the_engineers_plant(client, db):
    from app.field.router import run_operational_search
    head, engineer, plants = fixture_data(client, db)
    conftest._CURRENT_USER = db.get(User, engineer.id)
    # Ask Solar91 is not offered to Site Engineers; the search itself still keeps them to their own plant.
    assert client.get(SEARCH, params={'q': 'inspect'}).status_code == 403
    engineer = db.get(User, engineer.id)
    other = run_operational_search(db, engineer, 'issues at FE02')
    assert other['records'] == []
    own = run_operational_search(db, engineer, 'inspect')
    assert own['records'] and all(r['site_code'] == 'FE01' for r in own['records'])
    assert set(own['facets']['plant']) == {'FE01'}
    assert all('secret' not in r and 'active' not in r for r in own['records'])


def test_exact_issue_count_respects_severity_and_equipment_words(client, db):
    head, engineer, plants = fixture_data(client, db)
    conftest._CURRENT_USER = db.get(User, head.id)
    response = client.post('/api/field/ask', json={'question': 'How many open critical inverter issues?'})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['mode'] == 'grounded-query'
    assert data['summary'] == {'label': 'Open critical inverter issues', 'value': 1}
    unassigned = client.post('/api/field/ask', json={'question': 'open unassigned issues'}).json()
    assert unassigned['summary']['value'] == 2

    searched = client.post('/api/field/ask', json={'question': 'critical inverter faults'}).json()
    assert searched['mode'] == 'grounded-search'
    assert searched['answer'].startswith('I found 1 matching record')
    assert searched['filters']['severities'] == ['Critical'] and searched['facets']['module'] == {'issues': 1}
