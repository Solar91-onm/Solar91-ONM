from __future__ import annotations

import logging
from datetime import date

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.models import Plant, WashingHistory, WashingTable
from app.core.observability import make_timing_middleware
from tests.conftest import login_user


def test_authenticated_request_reports_query_count_and_request_id(client, db):
    login_user(client, db, role="O&M Head", name="Timing Head", email="timing-head@example.com")
    response = client.get("/api/bootstrap?lite=1")
    assert response.status_code == 200
    timing = response.headers["server-timing"]
    assert timing.startswith("app;dur=") and "db;dur=" in timing and " queries" in timing
    assert not timing.endswith('desc="0 queries"')
    assert response.headers["x-request-id"]


def test_safe_incoming_request_id_is_kept_and_unsafe_one_is_replaced(client, db):
    login_user(client, db, role="O&M Head", name="Rid Head", email="rid-head@example.com")
    assert client.get("/api/bootstrap?lite=1", headers={"X-Request-ID": "abc-12345678"}).headers["x-request-id"] == "abc-12345678"
    replaced = client.get("/api/bootstrap?lite=1", headers={"X-Request-ID": "bad id\twith spaces"}).headers["x-request-id"]
    assert replaced != "bad id\twith spaces" and len(replaced) == 16


def test_health_endpoints_stay_cheap_and_untimed(client):
    response = client.get("/health")
    assert response.status_code == 200 and "server-timing" not in response.headers


def test_slow_requests_are_logged_without_query_string_or_credentials(caplog):
    mini = FastAPI()
    mini.middleware("http")(make_timing_middleware(0))

    @mini.get("/api/things/{thing_id}")
    def thing(thing_id: str):
        return {"ok": True}

    with caplog.at_level(logging.WARNING, logger="solar91.request"):
        TestClient(mini).get("/api/things/42?access_token=SECRET123", headers={"Authorization": "Bearer SECRET456"})
    text = " ".join(record.getMessage() for record in caplog.records)
    assert "route=/api/things/{thing_id}" in text and "db_queries=0" in text
    assert "SECRET123" not in text and "SECRET456" not in text and "access_token" not in text


def test_failed_requests_are_logged_and_still_raise(caplog):
    mini = FastAPI()
    mini.middleware("http")(make_timing_middleware(10_000))

    @mini.get("/api/boom")
    def boom():
        raise RuntimeError("secret internal detail")

    with caplog.at_level(logging.ERROR, logger="solar91.request"):
        response = TestClient(mini, raise_server_exceptions=False).get("/api/boom")
    assert response.status_code == 500
    text = " ".join(record.getMessage() for record in caplog.records)
    assert "error=RuntimeError" in text and "secret internal detail" not in text


def test_washing_bootstrap_rows_keep_their_exact_shape(client, db):
    plant = Plant(site_code="SHAPE01", plant_name="Shape Plant")
    db.add(plant)
    db.commit()
    table = WashingTable(
        legacy_id="WT-SHAPE-1", plant_id=plant.id, inverter_no=3, secondary_inverter_no=4, table_code="INV-03-T-01",
        next_due_on=date(2026, 10, 20), rescheduled_to=date(2026, 10, 22), legacy_payload={"custom": "kept"},
    )
    db.add(table)
    db.flush()
    db.add(WashingHistory(washing_table_id=table.id, event_type="wash", event_date=date(2026, 10, 1), actor="Tech",
                          reason=None, notes="done", payload={"extra": 1}))
    db.add(WashingHistory(washing_table_id=table.id, event_type="reschedule", event_date=date(2026, 10, 5), actor="Head",
                          reason="rain", notes=None, payload={}))
    db.commit()
    login_user(client, db, role="O&M Head", name="Shape Head", email="shape-head@example.com")
    row = client.get("/api/bootstrap").json()["state"]["washing"][0]
    assert row["id"] == "WT-SHAPE-1" and row["plant"] == "Shape Plant" and row["inv"] == 3 and row["invSecondary"] == 4
    assert row["tableId"] == "INV-03-T-01" and row["nextDue"] == "2026-10-20" and row["rescheduledTo"] == "2026-10-22"
    assert row["custom"] == "kept"
    assert row["history"] == [
        {"extra": 1, "type": "wash", "date": "2026-10-01", "by": "Tech", "notes": "done"},
        {"type": "reschedule", "date": "2026-10-05", "by": "Head", "reason": "rain"},
    ]
