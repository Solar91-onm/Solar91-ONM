"""Business date and time helpers.

Solar91 plants operate in India. Operational "today" (report dates, due/overdue checks,
cycle months, reminders) follows Asia/Kolkata (UTC+05:30, no daylight saving) regardless
of where the server runs. Render containers run in UTC, so ``date.today()`` would roll over
5.5 hours late and file early-morning work under the previous day.

A fixed offset is used instead of ``zoneinfo`` so the result never depends on the
container having tz database files installed.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

BUSINESS_TZ = timezone(timedelta(hours=5, minutes=30), "Asia/Kolkata")


def utc_now() -> datetime:
    """Timezone-aware current UTC time (for stored timestamps)."""
    return datetime.now(timezone.utc)


def business_now() -> datetime:
    """Timezone-aware current time in the business timezone."""
    return datetime.now(BUSINESS_TZ)


def business_today() -> date:
    """Current calendar date in the business timezone."""
    return business_now().date()


def log_stamp() -> str:
    """ISO-8601 timestamp with explicit +05:30 offset for JSON activity logs.

    The explicit offset lets every browser render the moment correctly; the old naive
    server-local strings were UTC on Render but read as local time by browsers.
    """
    return business_now().replace(microsecond=0).isoformat()
