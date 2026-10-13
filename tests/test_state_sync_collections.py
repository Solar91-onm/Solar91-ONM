from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from app.core.models import Issue, OMTask, WashingTable
from app.main import app
from tests.conftest import login_user


def test_collection_revisions_are_independent_and_return_scoped_conflicts(client, db):
    login_user(client, db)

    first = client.put(
        "/api/state/sync",
        json={
            "collection_revisions": {"opsDate": 0},
            "state": {"opsDate": "2026-10-14"},
        },
    )
    assert first.status_code == 200, first.text
    assert first.json()["collection_revisions"] == {"opsDate": 1}

    independent = client.put(
        "/api/state/sync",
        json={
            "collection_revisions": {"scadaConfig": 0},
            "state": {"scadaConfig": {"connected": True}},
        },
    )
    assert independent.status_code == 200, independent.text
    assert independent.json()["collection_revisions"] == {"scadaConfig": 1}

    stale = client.put(
        "/api/state/sync",
        json={
            "collection_revisions": {"opsDate": 0},
            "state": {"opsDate": "2026-10-15"},
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["changed_collections"] == {"opsDate": 1}

    latest = client.get("/api/state/collections?keys=opsDate").json()
    assert latest["state"]["opsDate"] == "2026-10-14"
    assert latest["collection_revisions"] == {"opsDate": 1}


def test_legacy_sync_does_not_write_tasks_issues_or_washing(client, db):
    login_user(client, db)

    response = client.put(
        "/api/state/sync",
        json={
            "revision": 0,
            "state": {
                "tasks": [{"id": "WO-UNSAFE", "name": "Stale task", "status": "Completed"}],
                "issues": [{"id": "SI-UNSAFE", "desc": "Stale issue", "status": "Closed"}],
                "washing": [{"id": "WT-UNSAFE", "nextDue": "2026-10-14"}],
                "washMeta": {"unsafe": True},
            },
        },
    )

    assert response.status_code == 200, response.text
    assert db.query(OMTask).count() == 0
    assert db.query(Issue).count() == 0
    assert db.query(WashingTable).count() == 0


def test_twenty_parallel_collection_writes_do_not_conflict_globally(client, db):
    login_user(client, db)
    values = {
        "opsDate": "2026-10-14",
        "scadaConfig": {},
        "plantEnrich": {},
        "customPlantColumns": [],
        "plantCustomValues": {},
        "_seq": 1,
        "handovers": [],
        "inventory": [],
        "movements": [],
        "ptw": [],
        "incidents": [],
        "docs": [],
        "vendors": [],
        "rules": [],
        "sla": [],
        "audit": [],
        "offlineQueue": [],
        "serviceRequests": [],
        "events": [],
    }

    def write(key_value):
        key, value = key_value
        with TestClient(app, headers={"Authorization": "Bearer test"}) as concurrent_client:
            return concurrent_client.put(
                "/api/state/sync",
                json={
                    "collection_revisions": {key: 0},
                    "state": {key: value},
                },
            )

    with ThreadPoolExecutor(max_workers=20) as executor:
        responses = list(executor.map(write, values.items()))

    assert all(response.status_code == 200 for response in responses), [
        (response.status_code, response.text) for response in responses
    ]
    versions = client.get(
        "/api/state/collections?keys="+",".join(values)
    ).json()["collection_revisions"]
    assert versions == {key: 1 for key in values}
