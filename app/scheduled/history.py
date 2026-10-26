"""Which finished PM work orders the browser loads by default.

Open work (anything not Completed / Cancelled) is always sent. Finished work piles up every cycle — 2,000 units on a
monthly plan add about 24,000 completed records a year — so sign-in (``/api/bootstrap``) and ``GET /api/scheduled/tasks``
send finished work only from the last ``BOOTSTRAP_PM_HISTORY_DAYS`` days (default 180, 0 = everything). Older records
stay in the database; ``GET /api/scheduled/tasks?history=all`` returns them (the compliance export uses it).
"""
from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import func, or_

from app.core.config import get_settings
from app.core.models import OMTask
from app.core.timeutil import business_today

FINISHED = ("Completed", "Cancelled")


def history_days() -> int:
    return max(0, int(getattr(get_settings(), "bootstrap_pm_history_days", 0) or 0))


def history_since(days: int | None = None) -> date | None:
    """First day of finished work that is loaded, or None when every record is loaded."""
    days = history_days() if days is None else max(0, int(days))
    return business_today() - timedelta(days=days) if days else None


def recent_or_open(since: date | None):
    """SQL condition: open work, or finished work completed (else due) on/after ``since``. None = no condition."""
    if since is None:
        return None
    return or_(
        OMTask.status.is_(None),
        OMTask.status.notin_(FINISHED),
        func.coalesce(OMTask.actual_completed_on, OMTask.due_on).is_(None),
        func.coalesce(OMTask.actual_completed_on, OMTask.due_on) >= since,
    )
