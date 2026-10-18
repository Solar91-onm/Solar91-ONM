"""Idle-aware connection health check, connection timing and the startup latency probe."""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.pool import QueuePool

from app.core import observability
from app.core.observability import (
    _stats, install_connection_health, install_connection_timing, make_timing_middleware, measure_database_latency,
)


def _engine(tmp_path):
    engine = create_engine(f"sqlite:///{(tmp_path / 'health.db').as_posix()}", poolclass=QueuePool, pool_size=1, max_overflow=0)
    install_connection_timing(engine)
    install_connection_health(engine, idle_seconds=10)
    return engine


def _run(engine):
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))


def _stats_block():
    stats = {"queries": 0, "db_ms": 0.0, "connects": 0, "connect_ms": 0.0, "pings": 0, "ping_ms": 0.0}
    return stats, _stats.set(stats)


def test_recently_used_connections_skip_the_ping_and_idle_ones_are_checked(tmp_path, monkeypatch):
    engine = _engine(tmp_path)
    stats, token = _stats_block()
    try:
        _run(engine)  # new connection: timed, never pinged
        _run(engine)  # reused within 10 s: no extra round trip
        assert stats["connects"] == 1 and stats["pings"] == 0
        clock = observability._monotonic()
        monkeypatch.setattr(observability, "_monotonic", lambda: clock + 60)
        _run(engine)  # idle for a minute: checked once
        assert stats["pings"] == 1 and stats["connects"] == 1
    finally:
        _stats.reset(token)
        engine.dispose()


def test_a_dead_idle_connection_is_replaced_before_the_request_uses_it(tmp_path, monkeypatch):
    engine = _engine(tmp_path)
    stats, token = _stats_block()
    try:
        _run(engine)
        clock = observability._monotonic()
        monkeypatch.setattr(observability, "_monotonic", lambda: clock + 60)
        monkeypatch.setattr(engine.dialect, "_do_ping_w_event", lambda dbapi_connection: False)
        _run(engine)  # ping reports a dropped connection: SQLAlchemy opens a fresh one and the query still runs
        assert stats["pings"] == 1 and stats["connects"] == 2

        def broken(dbapi_connection):
            raise RuntimeError("socket closed")
        monkeypatch.setattr(observability, "_monotonic", lambda: clock + 120)
        monkeypatch.setattr(engine.dialect, "_do_ping_w_event", broken)
        _run(engine)  # an unexpected ping failure is treated the same way, never handed to the request
        assert stats["connects"] == 3
    finally:
        _stats.reset(token)
        engine.dispose()


def test_latency_probe_measures_round_trips_and_never_raises(tmp_path):
    engine = _engine(tmp_path)
    try:
        value = measure_database_latency(engine)
        assert value is not None and value >= 0
    finally:
        engine.dispose()
    unreachable = create_engine(f"sqlite:///{(tmp_path / 'missing' / 'nope.db').as_posix()}")
    assert measure_database_latency(unreachable) is None


def test_slow_request_line_and_server_timing_include_connection_time(caplog):
    mini = FastAPI()
    mini.middleware("http")(make_timing_middleware(0))

    @mini.get("/api/ping")
    def ping():
        return {"ok": True}

    with caplog.at_level(logging.WARNING, logger="solar91.request"):
        response = TestClient(mini).get("/api/ping")
    timing = response.headers["server-timing"]
    assert 'conn;dur=' in timing and '0 new, 0 checked' in timing
    text_logged = " ".join(record.getMessage() for record in caplog.records)
    assert "new_connections=0" in text_logged and "health_checks=0" in text_logged and "connect_ms=0" in text_logged
