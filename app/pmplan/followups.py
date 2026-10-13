from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.models import OMTask, PMFollowUp

FOLLOW_UP_OUTCOMES = {
    "Will finish by the promised date",
    "Blocked: waiting for shutdown",
    "Blocked: waiting for parts",
    "Blocked: no access",
    "Could not reach anyone",
}


def get_follow_up_state(
    db: Session, task: OMTask, today: date | None = None, latest: PMFollowUp | None = None,
    latest_loaded: bool = False,
) -> str:
    """Return none, missed, promised, old, or ok for the latest contact."""
    today = today or date.today()
    if latest is None and not latest_loaded:
        latest = db.scalar(
            select(PMFollowUp)
            .where(PMFollowUp.task_id == task.id)
            .order_by(PMFollowUp.at.desc(), PMFollowUp.id.desc())
            .limit(1)
        )
    if latest is None:
        return "none"
    if latest.promised_on:
        if latest.promised_on < today:
            return "missed"
        if latest.promised_on > today:
            return "promised"
    return "old" if latest.at.date() < today - timedelta(days=1) else "ok"


def follow_up_out(row: PMFollowUp) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "at": row.at.isoformat() if row.at else None,
        "by_user_id": str(row.by_user_id) if row.by_user_id else None,
        "by_name": row.by_name,
        "how": row.how,
        "spoke_to": row.spoke_to,
        "outcome": row.outcome,
        "promised_on": row.promised_on.isoformat() if row.promised_on else None,
        "next_follow_up_on": row.next_follow_up_on.isoformat() if row.next_follow_up_on else None,
        "note": row.note,
    }
