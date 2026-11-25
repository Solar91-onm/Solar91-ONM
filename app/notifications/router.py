"""The notification centre's API: the bell's list, its unread count and its Action Required list.

Three rules this file keeps:

* **Recipients only.** Every query is restricted to the signed-in user's own rows plus the
  broadcast rows (``user_id IS NULL``). Nothing is served because a client asked for it.
* **Action Required is read from the records, not from notifications.** Marking a notification
  read never resolves the underlying task, so the list is recomputed from the live PM activities
  and tickets the user is actually allowed to see, under the same plant scope their pages use.
* **Cheap.** ``/summary`` is one count plus a handful of scoped, bounded counts, so the shared
  poller can call it often; the list itself is paginated with a keyset cursor.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.models import Issue, Notification, Plant, User
from app.core.security import get_current_user, require_csrf, user_scoped_plant_ids
from app.core.timeutil import business_today
from app.notifications.service import notification_dto

router = APIRouter(prefix="/api/notifications", tags=["Notifications"])

DB = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]
MAX_PAGE = 50
# Extra rows read past a page so notifications written in the same second can be skipped
# exactly, whatever precision the database stores them with.
SAME_SECOND_WINDOW = 60


def _mine(user: User):
    """Rows this user may read: their own, plus portal-wide broadcasts."""
    return or_(Notification.user_id == user.id, Notification.user_id.is_(None))


def _unread_count(db: Session, user: User) -> int:
    return int(db.scalar(
        select(func.count()).select_from(Notification)
        .where(_mine(user), Notification.read_at.is_(None))
    ) or 0)


@router.get("")
def list_notifications(
    db: DB,
    user: CurrentUser,
    unread: bool = False,
    limit: int = Query(default=20, ge=1, le=MAX_PAGE),
    before: datetime | None = None,
    before_id: UUID | None = None,
):
    """One page of the user's notifications, newest first.

    The cursor is the last row already shown — its ``created_at`` AND its id. Several
    notifications written by one transaction share a timestamp to the microsecond, so a
    timestamp alone would hand back a page that had already been seen; the id breaks the tie.
    Keyset, not OFFSET, so a long history stays cheap.
    """
    stmt = select(Notification).where(_mine(user))
    if unread:
        stmt = stmt.where(Notification.read_at.is_(None))
    # The cursor row itself is the anchor, read back from the database: the timestamp that went
    # out as JSON can come back with a different precision, and comparing those two in SQL is
    # not reliable across PostgreSQL and SQLite. So SQL does the coarse cut (everything at or
    # older than the anchor's second) and the exact "strictly after the anchor" test is done
    # here, on the stored values.
    anchor = None
    if before_id is not None:
        anchor = db.scalar(select(Notification).where(Notification.id == before_id, _mine(user)))
    if anchor is not None:
        stmt = stmt.where(Notification.created_at <= anchor.created_at)
    elif before is not None:
        stmt = stmt.where(Notification.created_at <= before)
    window = limit + 1 + (SAME_SECOND_WINDOW if anchor is not None else 0)
    rows = list(db.scalars(
        stmt.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(window)))
    if anchor is not None:
        after = [row for row in rows
                 if row.created_at < anchor.created_at
                 or (row.created_at == anchor.created_at and row.id < anchor.id)]
        if rows and not after:
            # Every row in this window still precedes the anchor (a very large batch written in
            # the same second). Advance the cursor so the next request makes progress.
            last = rows[-1]
            return {"notifications": [], "unread_count": _unread_count(db, user), "has_more": True,
                    "next_before": last.created_at, "next_before_id": str(last.id),
                    "as_of": datetime.now(timezone.utc)}
        rows = after
    elif before is not None:
        rows = [row for row in rows if row.created_at < before]
    page, more = rows[:limit], len(rows) > limit
    return {
        "notifications": [notification_dto(row) for row in page],
        "unread_count": _unread_count(db, user),
        "has_more": more,
        "next_before": page[-1].created_at if page and more else None,
        "next_before_id": str(page[-1].id) if page and more else None,
        "as_of": datetime.now(timezone.utc),
    }


@router.get("/summary")
def summary(db: DB, user: CurrentUser):
    """The bell's badge and the Action Required list, in one cheap request."""
    return {
        "unread_count": _unread_count(db, user),
        "actions": _actions_required(db, user),
        "as_of": datetime.now(timezone.utc),
    }


@router.post("/{notification_id}/read", dependencies=[Depends(require_csrf)])
def mark_read(notification_id: UUID, db: DB, user: CurrentUser):
    row = db.get(Notification, notification_id)
    if not row or (row.user_id and row.user_id != user.id):
        raise HTTPException(404, "Notification not found")
    if row.user_id is None:
        # A broadcast is shared: mark a per-user copy read rather than hiding it from everyone.
        copy = db.scalar(select(Notification).where(
            Notification.user_id == user.id,
            Notification.dedupe_key == f"broadcast-read:{row.id}",
        ))
        if copy is None:
            db.add(Notification(
                user_id=user.id, event_type=row.event_type, title=row.title, message=row.message,
                target_type=row.target_type, target_id=row.target_id,
                dedupe_key=f"broadcast-read:{row.id}", payload=row.payload or {},
                read_at=datetime.now(timezone.utc),
            ))
            db.commit()
        return {"ok": True, "unread_count": _unread_count(db, user)}
    if row.read_at is None:
        row.read_at = datetime.now(timezone.utc)
        db.commit()
    return {"ok": True, "unread_count": _unread_count(db, user)}


@router.post("/read-all", dependencies=[Depends(require_csrf)])
def mark_all(db: DB, user: CurrentUser):
    now = datetime.now(timezone.utc)
    changed = 0
    for row in db.scalars(select(Notification).where(
            Notification.user_id == user.id, Notification.read_at.is_(None))):
        row.read_at = now
        changed += 1
    for row in db.scalars(select(Notification).where(
            Notification.user_id.is_(None), Notification.read_at.is_(None)).limit(200)):
        if not db.scalar(select(Notification.id).where(
                Notification.user_id == user.id, Notification.dedupe_key == f"broadcast-read:{row.id}")):
            db.add(Notification(
                user_id=user.id, event_type=row.event_type, title=row.title, message=row.message,
                target_type=row.target_type, target_id=row.target_id,
                dedupe_key=f"broadcast-read:{row.id}", payload=row.payload or {}, read_at=now,
            ))
            changed += 1
    if changed:
        db.commit()
    return {"ok": True, "marked": changed, "unread_count": _unread_count(db, user)}


# ── Action Required ─────────────────────────────────────────────────────────


def _action(kind: str, label: str, count: int, tone: str, page: str,
            site_code: str | None = None, month: str | None = None) -> dict:
    return {"kind": kind, "label": label, "count": count, "tone": tone,
            "page": page, "site_code": site_code, "month": month}


def _actions_required(db: Session, user: User) -> list[dict]:
    """Unresolved items waiting for THIS user, counted from the records themselves.

    Scoped exactly like the pages they link to: a plant the user cannot open can never be
    counted here. Each count is one indexed aggregate; nothing is fetched row by row.
    """
    from app.pmplan.tracking import PMTrackingActivity

    scope = user_scoped_plant_ids(db, user)
    if scope is not None and not scope:
        return []
    today = business_today()
    out: list[dict] = []

    def pm_count(*conditions) -> int:
        stmt = select(func.count()).select_from(PMTrackingActivity).where(*conditions)
        if scope is not None:
            stmt = stmt.where(PMTrackingActivity.plant_id.in_(scope))
        return int(db.scalar(stmt) or 0)

    if user.role == "O&M Head":
        pending = pm_count(PMTrackingActivity.status == "Pending approval")
        if pending:
            out.append(_action("pm_pending_approval", "PM checklists awaiting your approval",
                               pending, "amber", "pm"))
    if user.role in {"O&M Head", "Assignee"}:
        requests = pm_count(PMTrackingActivity.permission == "Requested",
                            PMTrackingActivity.status != "Approved")
        if requests:
            out.append(_action("pm_permission_requested", "PM sequence permission requests",
                               requests, "purple", "pm"))
    if user.role == "Site Engineer":
        returned = pm_count(PMTrackingActivity.status == "Returned")
        if returned:
            out.append(_action("pm_returned", "PM checklists returned for correction",
                               returned, "red", "pm"))
        submitted = pm_count(PMTrackingActivity.status == "Pending approval",
                             PMTrackingActivity.submitted_by == user.id)
        if submitted:
            out.append(_action("pm_awaiting_review", "Your PM checklists awaiting approval",
                               submitted, "blue", "pm"))
    overdue = pm_count(PMTrackingActivity.scheduled_on < today,
                       PMTrackingActivity.status.in_(("Scheduled", "Returned")))
    if overdue:
        out.append(_action("pm_overdue", "Overdue PM activities", overdue, "red", "pm"))

    issue_stmt = select(func.count()).select_from(Issue).where(
        Issue.severity == "Critical",
        func.lower(Issue.status).notin_(("closed", "resolved", "cancelled")),
    )
    if scope is not None:
        issue_stmt = issue_stmt.where(Issue.plant_id.in_(scope))
    if user.role == "Assignee":
        issue_stmt = issue_stmt.where(or_(Issue.assigned_to == user.id, Issue.assigned_to.is_(None)))
    critical = int(db.scalar(issue_stmt) or 0)
    if critical:
        out.append(_action("issue_critical", "Open critical tickets", critical, "red", "health"))

    if user.role in {"O&M Head", "Administration"}:
        unassigned_stmt = select(func.count()).select_from(Issue).where(
            Issue.assigned_to.is_(None),
            func.lower(Issue.status).notin_(("closed", "resolved", "cancelled")),
        )
        if scope is not None:
            unassigned_stmt = unassigned_stmt.where(Issue.plant_id.in_(scope))
        unassigned = int(db.scalar(unassigned_stmt) or 0)
        if unassigned:
            out.append(_action("issue_unassigned", "Tickets without a responsible person",
                               unassigned, "amber", "health"))
    return out


@router.get("/plants")
def notification_plants(db: DB, user: CurrentUser):
    """Site codes the user may open, so the panel can link a notification to its plant."""
    scope = user_scoped_plant_ids(db, user)
    stmt = select(Plant.site_code, Plant.plant_name).order_by(Plant.site_code)
    if scope is not None:
        if not scope:
            return {"plants": []}
        stmt = stmt.where(Plant.id.in_(scope))
    return {"plants": [{"site_code": code, "plant_name": name} for code, name in db.execute(stmt).all()]}
