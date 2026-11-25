"""Generate SQL-managed PM months from the app; no pg_cron dependency.

The existing solar91_pm.ensure_month(date) function remains the authority for
validating equipment, clamping month-end dates, and preserving existing records.
Only the app's trusted PostgreSQL connection may call it. No public write API.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import date
from threading import Lock
from time import monotonic
from typing import Callable

from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.core.timeutil import business_today

logger = logging.getLogger("solar91.pm.recurrence")
START_MONTH = date(2026, 12, 1)
ROLLING_MONTHS = 12
BATCH_SIZE = 3  # bound the lock duration and the work done in one transaction
CHECK_SECONDS = 3600
RETRY_SECONDS = 300
WAKE_COOLDOWN_SECONDS = 60
LOCK_KEY = 91391020261201  # same transaction lock as the supplied PM SQL


@dataclass(frozen=True)
class GenerationResult:
    state: str
    months: tuple[date, ...] = ()
    inserted: int = 0
    more: bool = False


def _add_months(value: date, count: int) -> date:
    index = value.year * 12 + value.month - 1 + count
    year, month = divmod(index, 12)
    return date(year, month + 1, 1)


def rolling_window(today: date) -> tuple[date, date]:
    current = max(START_MONTH, today.replace(day=1))
    return current, _add_months(current, ROLLING_MONTHS - 1)


def generate_missing_months(engine: Engine, *, today: date | None = None) -> GenerationResult:
    """One bounded, atomic generation batch; skip busy replicas, never update history.

    Discover gaps from the official start, including missed months after downtime.
    Prioritise the current rolling window over older gaps. The ledger and uniqueness
    constraints in the installed SQL prevent duplicate or reset activities.
    """
    if engine.dialect.name != "postgresql":
        return GenerationResult("unsupported")
    current, horizon = rolling_window(today or business_today())
    with engine.begin() as conn:
        conn.execute(text("SET LOCAL lock_timeout = '3s'"))
        conn.execute(text("SET LOCAL statement_timeout = '30s'"))
        configured = conn.scalar(text("""
            SELECT to_regprocedure('solar91_pm.ensure_month(date)') IS NOT NULL
               AND to_regclass('solar91_pm.generated_months') IS NOT NULL
               AND to_regclass('solar91_pm.monthly_rules') IS NOT NULL
        """))
        if not configured:
            return GenerationResult("not_configured")
        # All replicas and the manual SQL share this transaction lock. Never wait
        # in the request path or run parallel generators on the same database.
        if not conn.scalar(text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": LOCK_KEY}):
            return GenerationResult("busy")
        missing = tuple(conn.scalars(text("""
            SELECT candidate.month_start::date
            FROM generate_series(CAST(:start AS timestamp), CAST(:horizon AS timestamp),
                                 interval '1 month') AS candidate(month_start)
            WHERE NOT EXISTS (
                SELECT 1 FROM solar91_pm.generated_months AS g
                WHERE g.month_start = candidate.month_start::date
            )
            ORDER BY CASE WHEN candidate.month_start::date >= CAST(:current AS date)
                          THEN 0 ELSE 1 END, candidate.month_start
            LIMIT :limit
        """), {"start": START_MONTH, "horizon": horizon, "current": current,
                 "limit": BATCH_SIZE + 1}))
        months = missing[:BATCH_SIZE]
        inserted = 0
        for month in months:
            inserted += int(conn.scalar(text("SELECT solar91_pm.ensure_month(CAST(:month AS date))"),
                                        {"month": month}))
        # Do not report success until the context manager commits the transaction.
        result = GenerationResult("ok", months, inserted, len(missing) > BATCH_SIZE)
    return result


class _WakeSignal:
    """Coalesce request-thread hints; no extra database query in the HTTP handler."""
    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.event = asyncio.Event()
        self.lock = Lock()
        self.next_signal = 0.0

    def request(self) -> None:
        with self.lock:
            now = monotonic()
            if now < self.next_signal or self.loop.is_closed():
                return
            self.next_signal = now + WAKE_COOLDOWN_SECONDS
            try:
                self.loop.call_soon_threadsafe(self.event.set)
            except RuntimeError:  # shutdown may close the event loop concurrently
                pass


_active_signal: _WakeSignal | None = None


def request_schedule_check(month: date) -> None:
    """Hint only for an authorized PM page with a missing in-window assignment.

    Browsing arbitrarily far into the future cannot materialize unbounded records.
    Historical months from the start can also be recovered by the normal loop.
    """
    signal = _active_signal
    if signal is not None and START_MONTH <= month <= rolling_window(business_today())[1]:
        signal.request()


async def run_recurring_pm_loop(is_ready: Callable[[], bool]) -> None:
    """Startup + hourly rolling-window check, and bounded on-demand wakeups.

    Database work uses the existing pool off the event loop. Failure is isolated
    from API readiness; retries never run on every navigation or every request.
    """
    from app.core.database import engine
    from app.scheduled.washing_cycles import invalidate_overview_cache
    from app.issues.router import invalidate_pulse_cache

    global _active_signal
    if engine.dialect.name != "postgresql":
        return
    signal = _WakeSignal(asyncio.get_running_loop())
    _active_signal = signal
    try:
        while not is_ready():
            await asyncio.sleep(10)
        logger.info("Application-managed monthly PM scheduler started (no Cron required)")
        while True:
            signal.event.clear()
            try:
                result = await asyncio.to_thread(generate_missing_months, engine)
                if result.months:
                    logger.info("PM recurrence committed: months=%s inserted=%d", result.months, result.inserted)
                    invalidate_overview_cache()
                    invalidate_pulse_cache()
                if result.state == "not_configured":
                    logger.warning("PM recurrence SQL is not installed; apply Solar91_PM_Recurring_From_December.sql")
                    delay, cooldown = CHECK_SECONDS, RETRY_SECONDS
                elif result.state == "busy" or result.more:
                    delay = cooldown = WAKE_COOLDOWN_SECONDS
                else:
                    delay, cooldown = CHECK_SECONDS, WAKE_COOLDOWN_SECONDS
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Monthly PM generation failed; transaction rolled back; retry in %ds", RETRY_SECONDS)
                delay = cooldown = RETRY_SECONDS
            # A page hint cannot bypass the minimum retry/cooldown time.
            await asyncio.sleep(cooldown)
            if delay > cooldown:
                try:
                    await asyncio.wait_for(signal.event.wait(), timeout=delay - cooldown)
                except asyncio.TimeoutError:
                    pass
    finally:
        if _active_signal is signal:
            _active_signal = None
