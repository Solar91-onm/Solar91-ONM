from concurrent.futures import ThreadPoolExecutor
from datetime import date

from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.exc import OperationalError

from app.core.database import engine
from app.core.models import Issue, OMTask, Plant, StateCollectionRevision, WashingHistory, WashingTable
from app.main import app
from tests.conftest import login_user


def _capture_sql():
    """Context-style helper: record every SQL statement the engine runs until released."""
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    return statements, lambda: event.remove(engine, "before_cursor_execute", record)


def _revision_sql(statements):
    return [s for s in statements if "state_collection_revisions" in s.lower()]


def test_collection_fetch_loads_washing_only_when_requested(client, db, monkeypatch):
    login_user(client, db)
    plant = Plant(site_code="WASH01", plant_name="Washing Plant")
    db.add(plant)
    db.flush()
    table = WashingTable(
        legacy_id="WT-001",
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
        )
    )
    db.commit()

    from app.operations import router as operations_router

    original_load_state = operations_router.load_state
    loaded_washing = []

    def track_load_state(*args, **kwargs):
        loaded_washing.append(kwargs["include_washing"])
        return original_load_state(*args, **kwargs)

    monkeypatch.setattr(operations_router, "load_state", track_load_state)

    unrelated = client.get("/api/state/collections?keys=opsDate")
    assert unrelated.status_code == 200, unrelated.text
    assert set(unrelated.json()["state"]) == {"opsDate"}
    assert loaded_washing == [False]

    washing = client.get("/api/state/collections?keys=washing")
    assert washing.status_code == 200, washing.text
    row = washing.json()["state"]["washing"][0]
    assert row["tableId"] == "INV-01-T-01"
    assert row["history"] == [
        {
            "type": "wash",
            "date": "2026-10-15",
            "by": "Technician",
        }
    ]
    assert loaded_washing == [False, True]


def test_collection_revisions_are_independent_and_return_scoped_conflicts(client, db):
    login_user(client, db)

    first = client.put(
        "/api/state/sync",
        json={
            "collection_revisions": {"customPlantColumns": 0},
            "state": {"customPlantColumns": [{"key": "feeder", "label": "Feeder"}]},
        },
    )
    assert first.status_code == 200, first.text
    assert first.json()["collection_revisions"] == {"customPlantColumns": 1}

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
            "collection_revisions": {"customPlantColumns": 0},
            "state": {"customPlantColumns": [{"key": "stale", "label": "Stale"}]},
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["changed_collections"] == {"customPlantColumns": 1}

    latest = client.get("/api/state/collections?keys=customPlantColumns").json()
    assert latest["state"]["customPlantColumns"] == [{"key": "feeder", "label": "Feeder"}]
    assert latest["collection_revisions"] == {"customPlantColumns": 1}


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
        "schedScope": "all",
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


def test_repeat_sync_does_not_insert_collection_revisions(client, db):
    # Steady state: the row already exists, so a second sync must lock-and-advance with no INSERT.
    login_user(client, db)
    first = client.put(
        "/api/state/sync",
        json={"collection_revisions": {"scadaConfig": 0}, "state": {"scadaConfig": {"connected": True}}},
    )
    assert first.status_code == 200, first.text

    statements, release = _capture_sql()
    try:
        second = client.put(
            "/api/state/sync",
            json={"collection_revisions": {"scadaConfig": 1}, "state": {"scadaConfig": {"connected": False}}},
        )
    finally:
        release()

    assert second.status_code == 200, second.text
    assert second.json()["collection_revisions"] == {"scadaConfig": 2}
    inserts = [s for s in _revision_sql(statements) if s.lstrip().lower().startswith("insert")]
    assert inserts == [], inserts  # confirmed by the logged SQL, not by reading the code


def test_new_collection_still_creates_its_row_and_locks_in_order(client, db):
    login_user(client, db)
    statements, release = _capture_sql()
    try:
        created = client.put(
            "/api/state/sync",
            json={"collection_revisions": {"plantEnrich": 0}, "state": {"plantEnrich": {"a": 1}}},
        )
    finally:
        release()

    assert created.status_code == 200, created.text
    assert created.json()["collection_revisions"] == {"plantEnrich": 1}
    row = db.get(StateCollectionRevision, "plantEnrich")
    assert row is not None and row.revision == 1
    # Both the first lock and the re-lock of the freshly inserted row read in collection order,
    # so the newly created row ends up locked in the same deterministic order as the rest.
    ordered_locks = [
        s for s in _revision_sql(statements)
        if s.lstrip().lower().startswith("select") and "order by" in s.lower() and "collection" in s.lower()
    ]
    assert len(ordered_locks) >= 2, _revision_sql(statements)


def test_racing_new_collection_yields_one_winner_and_one_clean_409(client, db):
    # Two syncs that both believe the collection is new (expected revision 0). The first wins and
    # advances it to 1; the second must get a clean 409 naming the new revision, never a duplicate
    # row, a crash, or a lost update.
    login_user(client, db)
    winner = client.put(
        "/api/state/sync",
        json={"collection_revisions": {"plantEnrich": 0}, "state": {"plantEnrich": {"by": "A"}}},
    )
    assert winner.status_code == 200, winner.text
    assert winner.json()["collection_revisions"] == {"plantEnrich": 1}

    loser = client.put(
        "/api/state/sync",
        json={"collection_revisions": {"plantEnrich": 0}, "state": {"plantEnrich": {"by": "B"}}},
    )
    assert loser.status_code == 409, loser.text
    assert loser.json()["detail"]["changed_collections"] == {"plantEnrich": 1}

    rows = db.query(StateCollectionRevision).filter_by(collection="plantEnrich").all()
    assert len(rows) == 1 and rows[0].revision == 1  # one winner, no duplicate, no lost update


def test_lock_timeout_returns_a_retriable_409_not_a_500(client, db, monkeypatch):
    # When the row lock wait is aborted (PostgreSQL SQLSTATE 55P03), the sync must surface the
    # existing 409 shape with a retry message, not a 500 or a hang.
    login_user(client, db)

    from app.core import legacy_state

    class _LockTimeout(Exception):
        pgcode = "55P03"

    def _raise_lock_timeout(*args, **kwargs):
        raise OperationalError("SELECT ... FOR UPDATE", {}, _LockTimeout("canceling statement due to lock timeout"))

    monkeypatch.setattr(legacy_state, "_lock_collection_rows", _raise_lock_timeout)

    response = client.put(
        "/api/state/sync",
        json={"collection_revisions": {"scadaConfig": 0}, "state": {"scadaConfig": {"connected": True}}},
    )
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["changed_collections"] == {}
    assert "progress" in detail["message"].lower() and "retry" in detail["message"].lower()


def test_lock_timeout_helper_only_matches_55P03():
    from app.core.legacy_state import _is_lock_timeout

    class _Orig:
        def __init__(self, code):
            self.pgcode = code

    assert _is_lock_timeout(OperationalError("s", {}, _Orig("55P03"))) is True
    assert _is_lock_timeout(OperationalError("s", {}, _Orig("40001"))) is False  # serialization failure, not a lock timeout
    assert _is_lock_timeout(OperationalError("s", {}, None)) is False
