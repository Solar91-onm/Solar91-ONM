from __future__ import annotations

import logging
from datetime import date

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.database import engine
from app.core.models import Plant, WashingHistory, WashingTable
from app.core.observability import _stats, make_timing_middleware
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


def test_render_request_id_is_correlated_and_server_timing_has_total():
    mini = FastAPI()
    mini.middleware("http")(make_timing_middleware(10_000))

    @mini.get("/api/health-check")
    def health_check():
        return {"ok": True}

    response = TestClient(mini).get("/api/health-check", headers={"Rndr-Id": "req-render-123456"})
    assert response.headers["x-request-id"] == "req-render-123456"
    assert response.headers["rndr-id"] == "req-render-123456"
    assert "total;dur=" in response.headers["server-timing"]


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


def test_failed_request_logs_route_template_instead_of_path_values(caplog):
    mini = FastAPI()
    mini.middleware("http")(make_timing_middleware(10_000))

    @mini.get("/api/private/{record_id}")
    def fail(record_id: str):
        raise RuntimeError("failed")

    with caplog.at_level(logging.ERROR, logger="solar91.request"):
        response = TestClient(mini, raise_server_exceptions=False).get("/api/private/SECRET-RECORD-ID")
    assert response.status_code == 500
    messages = " ".join(record.getMessage() for record in caplog.records)
    assert "route=/api/private/{record_id}" in messages
    assert "SECRET-RECORD-ID" not in messages


def test_failed_sql_does_not_leave_stale_query_timer_on_pooled_connection():
    stats = {"queries": 0, "db_ms": 0.0}
    token = _stats.set(stats)
    try:
        with engine.connect() as connection:
            with pytest.raises(SQLAlchemyError):
                connection.execute(text("SELEC invalid_sql"))
            connection.execute(text("SELECT 1"))
            assert connection.info.get("solar91_t0") == []
    finally:
        _stats.reset(token)

    assert stats["queries"] == 2


def test_cors_exposes_request_timing_headers_and_allows_request_id(client, db):
    login_user(client, db, role="O&M Head", name="CORS Head", email="cors-head@example.com")
    origin = "http://localhost:8000"
    preflight = client.options(
        "/api/bootstrap?lite=1",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-request-id",
        },
    )
    assert preflight.status_code == 200
    assert "x-request-id" in preflight.headers["access-control-allow-headers"].lower()

    response = client.get("/api/bootstrap?lite=1", headers={"Origin": origin})
    exposed = response.headers["access-control-expose-headers"].lower()
    assert "x-request-id" in exposed and "rndr-id" in exposed and "server-timing" in exposed


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
