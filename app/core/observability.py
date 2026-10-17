"""Lightweight request timing: request id, per-request database query count/time, slow-request log.

Nothing here logs credentials, tokens, query strings, request bodies or signed URLs - only the route template,
method, status code and timings.
"""
from __future__ import annotations

import logging
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


def _request_id(request) -> str:
    incoming = request.headers.get("x-request-id", "")
    return incoming if _SAFE_ID.match(incoming) else uuid.uuid4().hex[:16]


def make_timing_middleware(slow_ms: int):
    async def request_timing(request, call_next):
        path = request.url.path
        quiet = path in _QUIET_PATHS or path.startswith(_QUIET_PREFIXES)
        stats = {"queries": 0, "db_ms": 0.0}
        token = _stats.set(stats)
        rid = _request_id(request)
        started = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            total_ms = (time.perf_counter() - started) * 1000.0
            if not quiet:
                response.headers["X-Request-ID"] = rid
                response.headers["Server-Timing"] = (
                    f'app;dur={total_ms:.0f}, db;dur={stats["db_ms"]:.0f};desc="{stats["queries"]} queries"'
                )
            return response
        except Exception as exc:  # logged, then re-raised unchanged so error handling is not hidden
            route = request.scope.get("route")
            template = getattr(route, "path", None) or "unmatched"
            logger.error(
                "request_failed id=%s method=%s route=%s error=%s",
                rid,
                request.method,
                template,
                type(exc).__name__,
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
                    "slow_or_failed_request id=%s method=%s route=%s status=%s total_ms=%.0f db_ms=%.0f db_queries=%d",
                    rid, request.method, template, status, total_ms, stats["db_ms"], stats["queries"],
                )

    return request_timing
