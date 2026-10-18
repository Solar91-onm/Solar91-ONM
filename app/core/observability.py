"""Lightweight request timing: request id, per-request database query count/time, slow-request log.

Nothing here logs credentials, tokens, query strings, request bodies or signed URLs - only the route template,
method, status code and timings.
"""
from __future__ import annotations

import logging
import os
import re
import time
import uuid
from contextvars import ContextVar

from sqlalchemy import event

logger = logging.getLogger("solar91.request")

_stats: ContextVar[dict | None] = ContextVar("solar91_request_stats", default=None)
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
_QUIET_PREFIXES = ("/static/",)
_QUIET_PATHS = {"/health", "/health/ready", "/favicon.ico"}


def install_query_counter(engine) -> None:
    """Count queries and their time for whichever request is currently running (no-op outside a request)."""
    if getattr(engine, "_solar91_query_counter", False):
        return
    engine._solar91_query_counter = True

    @event.listens_for(engine, "before_cursor_execute")
    def _before(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        conn.info.setdefault("solar91_t0", []).append(time.perf_counter())

    @event.listens_for(engine, "after_cursor_execute")
    def _after(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        stats = _stats.get()
        starts = conn.info.get("solar91_t0")
        if stats is not None and starts:
            stats["queries"] += 1
            stats["db_ms"] += (time.perf_counter() - starts.pop()) * 1000.0
        elif starts:
            starts.pop()

    @event.listens_for(engine, "handle_error")
    def _error(exception_context):  # noqa: ANN001
        # after_cursor_execute is not called for failed SQL. Keep the pooled connection's
        # timer stack balanced so its next request cannot inherit a stale start time.
        conn = exception_context.connection
        starts = conn.info.get("solar91_t0") if conn is not None else None
        if starts:
            started = starts.pop()
            stats = _stats.get()
            if stats is not None:
                stats["queries"] += 1
                stats["db_ms"] += (time.perf_counter() - started) * 1000.0


def _monotonic() -> float:  # separate so tests can simulate an idle connection without sleeping
    return time.monotonic()


def _add(key: str, value: float) -> None:
    stats = _stats.get()
    if stats is not None:
        stats[key] = stats.get(key, 0) + value


def install_connection_timing(engine) -> None:
    """Time new database connections (TCP + TLS + login) so slow-request logs show them instead of hiding
    them inside app_ms. A far-away database makes each new connection cost several network round trips."""
    if getattr(engine, "_solar91_connect_timer", False):
        return
    engine._solar91_connect_timer = True

    @event.listens_for(engine, "do_connect")
    def _start(dialect, conn_rec, cargs, cparams):  # noqa: ANN001
        conn_rec.record_info["solar91_connect_t0"] = time.perf_counter()

    @event.listens_for(engine, "connect")
    def _done(dbapi_connection, conn_rec):  # noqa: ANN001
        started = conn_rec.record_info.pop("solar91_connect_t0", None)
        if started is not None:
            _add("connects", 1)
            _add("connect_ms", (time.perf_counter() - started) * 1000.0)


def install_connection_health(engine, idle_seconds: float) -> None:
    """Pre-ping, but only for connections that have sat idle for idle_seconds or longer.

    SQLAlchemy's pool_pre_ping sends "SELECT 1" before every request, costing a full network round trip each time.
    A connection used a few seconds ago is still alive, so it is handed out directly; an idle one is pinged and,
    if dead, replaced through SQLAlchemy's normal disconnect handling (DisconnectionError -> new connection).
    Use instead of pool_pre_ping=True, never together with it."""
    from sqlalchemy import exc

    if getattr(engine, "_solar91_health", False):
        return
    engine._solar91_health = True

    @event.listens_for(engine, "checkin")
    def _returned(dbapi_connection, conn_rec):  # noqa: ANN001
        if conn_rec is not None and dbapi_connection is not None:
            conn_rec.info["solar91_returned_at"] = _monotonic()

    @event.listens_for(engine, "checkout")
    def _check(dbapi_connection, conn_rec, proxy):  # noqa: ANN001
        returned = conn_rec.info.get("solar91_returned_at")
        if returned is None:
            return  # just connected (a replaced connection starts with an empty info dict): nothing to test
        if _monotonic() - returned < idle_seconds:
            return
        started = time.perf_counter()
        try:
            alive = engine.dialect._do_ping_w_event(dbapi_connection)
        except Exception as error:  # an unusable connection must never reach a request
            raise exc.DisconnectionError("Connection failed its idle health check") from error
        finally:
            _add("pings", 1)
            _add("ping_ms", (time.perf_counter() - started) * 1000.0)
        if not alive:
            raise exc.DisconnectionError("Connection was closed while idle")


def measure_database_latency(engine, samples: int = 3) -> float | None:
    """Median time of a trivial query on one warm connection: the network round trip to the database.
    Logged once at startup so slow requests can be read against it. Returns None if the database is unreachable."""
    from sqlalchemy import text

    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))  # opens the connection and its transaction first
            timings = []
            for _ in range(max(1, samples)):
                started = time.perf_counter()
                connection.execute(text("SELECT 1"))
                timings.append((time.perf_counter() - started) * 1000.0)
    except Exception:  # never block or crash startup over a diagnostic
        return None
    timings.sort()
    return timings[len(timings) // 2]


def _request_id(request) -> tuple[str, str | None]:
    render_id = request.headers.get("rndr-id", "")
    if not _SAFE_ID.match(render_id):
        render_id = ""
    incoming = request.headers.get("x-request-id", "") or render_id
    return (incoming if _SAFE_ID.match(incoming) else uuid.uuid4().hex[:16], render_id or None)


def make_timing_middleware(slow_ms: int):
    async def request_timing(request, call_next):
        path = request.url.path
        quiet = path in _QUIET_PATHS or path.startswith(_QUIET_PREFIXES)
        stats = {"queries": 0, "db_ms": 0.0, "connects": 0, "connect_ms": 0.0, "pings": 0, "ping_ms": 0.0}
        token = _stats.set(stats)
        rid, render_id = _request_id(request)
        started = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            total_ms = (time.perf_counter() - started) * 1000.0
            if not quiet:
                response.headers["X-Request-ID"] = rid
                if render_id:
                    response.headers.setdefault("Rndr-Id", render_id)
                pool_ms = stats["connect_ms"] + stats["ping_ms"]
                response.headers["Server-Timing"] = (
                    f'app;dur={max(0.0, total_ms - stats["db_ms"] - pool_ms):.0f}, '
                    f'db;dur={stats["db_ms"]:.0f};desc="{stats["queries"]} queries", '
                    f'conn;dur={pool_ms:.0f};desc="{stats["connects"]} new, {stats["pings"]} checked", '
                    f'total;dur={total_ms:.0f}'
                )
            return response
        except Exception as exc:  # logged, then re-raised unchanged so error handling is not hidden
            route = request.scope.get("route")
            template = getattr(route, "path", None) or "unmatched"
            logger.error(
                "request_failed id=%s rndr_id=%s method=%s route=%s error=%s render_instance=%s render_commit=%s",
                rid,
                render_id or "-",
                request.method,
                template,
                type(exc).__name__,
                os.getenv("RENDER_INSTANCE_ID", "-"),
                os.getenv("RENDER_GIT_COMMIT", "-"),
            )
            raise
        finally:
            _stats.reset(token)
            total_ms = (time.perf_counter() - started) * 1000.0
            if not quiet and (total_ms >= slow_ms or status >= 500):
                route = request.scope.get("route")
                template = getattr(route, "path", None) or path
                level = logging.WARNING if total_ms >= slow_ms or status >= 500 else logging.INFO
                logger.log(
                    level,
                    "slow_or_failed_request id=%s rndr_id=%s method=%s route=%s status=%s total_ms=%.0f app_ms=%.0f db_ms=%.0f db_queries=%d new_connections=%d connect_ms=%.0f health_checks=%d health_check_ms=%.0f render_instance=%s render_commit=%s",
                    rid, render_id or "-", request.method, template, status, total_ms,
                    max(0.0, total_ms - stats["db_ms"] - stats["connect_ms"] - stats["ping_ms"]), stats["db_ms"], stats["queries"],
                    stats["connects"], stats["connect_ms"], stats["pings"], stats["ping_ms"],
                    os.getenv("RENDER_INSTANCE_ID", "-"), os.getenv("RENDER_GIT_COMMIT", "-"),
                )

    return request_timing
