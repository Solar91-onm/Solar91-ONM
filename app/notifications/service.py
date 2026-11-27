from __future__ import annotations

from uuid import UUID
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.models import Notification, User, UserPlantAssignment

def create_notification(
    db: Session,
    *,
    user_id: UUID | None,
    event_type: str,
    title: str,
    message: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    dedupe_key: str | None = None,
    payload: dict | None = None,
) -> Notification:
    if dedupe_key and user_id:
        existing = db.scalar(
            select(Notification).where(
                Notification.user_id == user_id,
                Notification.dedupe_key == dedupe_key,
            )
        )
        if existing:
            return existing
    row = Notification(
        user_id=user_id,
        event_type=event_type,
        title=title,
        message=message,
        target_type=target_type,
        target_id=target_id,
        dedupe_key=dedupe_key,
        payload=payload or {},
    )
    db.add(row)
    return row

def notify_users(
    db: Session,
    users: list[User],
    *,
    event_type: str,
    title: str,
    message: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    dedupe_key: str | None = None,
    payload: dict | None = None,
) -> None:
    seen: set[UUID] = set()
    for user in users:
        if not user.is_active or user.id in seen:
            continue
        seen.add(user.id)
        key = f"{dedupe_key}:{user.id}" if dedupe_key else None
        create_notification(
            db,
            user_id=user.id,
            event_type=event_type,
            title=title,
            message=message,
            target_type=target_type,
            target_id=target_id,
            dedupe_key=key,
            payload=payload,
        )

def users_with_role(db: Session, roles: set[str]) -> list[User]:
    return list(
        db.scalars(
            select(User).where(
                User.role.in_(roles),
                User.is_active.is_(True),
            )
        )
    )

def users_for_plant(db: Session, plant_id: UUID, roles: set[str] | None = None) -> list[User]:
    stmt = (
        select(User)
        .join(UserPlantAssignment, UserPlantAssignment.user_id == User.id)
        .where(
            UserPlantAssignment.plant_id == plant_id,
            User.is_active.is_(True),
        )
    )
    if roles:
        stmt = stmt.where(User.role.in_(roles))
    return list(db.scalars(stmt))

def plant_responsible_users(db: Session, *, plant_id: UUID | None) -> list[User]:
    """Notification routing only: the Assignees responsible for this plant.

    Routing used to follow the per-asset "in charge" field, falling back to the
    holders of that equipment type — always O&M team members, never the Site
    Engineer who raised the ticket. With the asset register removed this routes
    to the plant's Assignees, which keeps that same audience: a Site Engineer is
    not notified of work they reported, and managers are alerted separately.

    Visibility is still enforced by the API's own scope checks.
    """
    if plant_id is None:
        return []
    return list(db.scalars(
        select(User).join(UserPlantAssignment, UserPlantAssignment.user_id == User.id).where(
            User.is_active.is_(True),
            User.role == "Assignee",
            UserPlantAssignment.plant_id == plant_id,
        ).order_by(User.display_name)
    ))

def notify_issue_assignee_and_heads(
    db: Session,
    *,
    plant_id: UUID | None,
    assigned_to: UUID | None,
    event_type: str,
    title: str,
    message: str,
    target_id: str,
    include_heads: bool = False,
    dedupe_key: str | None = None,
    additional_user_ids: list[UUID] | None = None,
) -> None:
    users: list[User] = []
    if assigned_to:
        assigned = db.get(User, assigned_to)
        if assigned:
            users.append(assigned)
    for user_id in additional_user_ids or []:
        additional=db.get(User,user_id)
        if additional:
            users.append(additional)
    if include_heads:
        users.extend(users_with_role(db, {"O&M Head"}))
    elif plant_id:
        users.extend(users_for_plant(db, plant_id, {"O&M Head"}))
    notify_users(
        db,
        users,
        event_type=event_type,
        title=title,
        message=message,
        target_type="issue",
        target_id=target_id,
        dedupe_key=dedupe_key,
    )


# ── How a notification is presented ─────────────────────────────────────────
#
# Category and priority are derived from the event type, so no column had to be added to
# `notifications` and every row already in the table gets a sensible one. The five tones are the
# portal's own: green (done), blue (information), amber (needs attention), red (critical),
# purple (a PM sequence permission request).

_CATEGORY = {
    "issue": {"issue_created", "critical_issue", "issue_status_changed", "issue_progress",
              "issue_reopened", "issue_stepped_back", "issue_message", "issue_etc_changed",
              "issue_closure_requested", "ticket_assigned", "ticket_reassigned", "ticket_completed",
              "issue_unassigned"},
    "pm": {"pm_daily_plan", "pm_submitted", "pm_approved", "pm_returned", "pm_overdue",
           "pm_permission_requested", "pm_permission_granted", "pm_permission_denied"},
    "washing": {"washing_overdue", "washing_cycle_completed", "washing_cycle_compliance_low",
                "washing_daily_report", "washing_monthly_target_missed", "washing_report_reviewed"},
    "task": {"task_assigned", "task_reassigned", "task_completed", "task_reported", "task_anomaly",
             "ptw_pending"},
    "access": {"role_changed", "equipment_responsibility_assigned", "equipment_responsibility_removed"},
}
_PRIORITY = {
    "critical": {"critical_issue", "washing_monthly_target_missed"},
    "high": {"pm_overdue", "pm_returned", "issue_closure_requested", "washing_overdue",
             "washing_cycle_compliance_low", "task_anomaly", "ptw_pending", "issue_reopened",
             "pm_permission_requested", "issue_unassigned"},
    "normal": set(),
}
# Which of the five portal tones a category/priority pair reads as.
_TONE = {"pm_approved": "green", "ticket_completed": "green", "task_completed": "green",
         "washing_cycle_completed": "green", "pm_permission_granted": "green",
         "pm_permission_requested": "purple", "pm_permission_denied": "red"}


def notification_category(event_type: str | None) -> str:
    for name, events in _CATEGORY.items():
        if event_type in events:
            return name
    return "general"


def notification_priority(event_type: str | None) -> str:
    for name, events in _PRIORITY.items():
        if event_type in events:
            return name
    return "normal"


def notification_tone(event_type: str | None) -> str:
    if event_type in _TONE:
        return _TONE[event_type]
    priority = notification_priority(event_type)
    if priority == "critical":
        return "red"
    if priority == "high":
        return "amber"
    return "blue"


def notification_dto(row: Notification) -> dict:
    payload = row.payload if isinstance(row.payload, dict) else {}
    return {
        "id": str(row.id),
        "title": row.title,
        "message": row.message,
        "event_type": row.event_type,
        "category": notification_category(row.event_type),
        "priority": notification_priority(row.event_type),
        "tone": notification_tone(row.event_type),
        "target_type": row.target_type,
        "target_id": row.target_id,
        # Where the portal should go when the notification is opened. Only values the
        # frontend router understands are passed through; nothing here grants access —
        # the destination page re-reads the record under the user's own scope.
        "link": {
            "site_code": payload.get("site_code") or None,
            "plant_name": payload.get("plant_name") or None,
            "page": payload.get("page") or None,
            "month": payload.get("month") or None,
            "activity_id": payload.get("activity_id") or None,
            "equipment": payload.get("equipment") or None,
        },
        "read": row.read_at is not None,
        "broadcast": row.user_id is None,
        "created_at": row.created_at,
    }


# ── Preventive Maintenance routing ──────────────────────────────────────────


def pm_plant_recipients(db: Session, *, plant_id: UUID | None, equipment: str | None = None) -> list[User]:
    """Who is answerable for a plant's PM: every O&M Head, the plant's PM Assignee, and the
    equipment Assignee only as a fallback if there is no active plant PM owner.

    Approval authority is unchanged — this decides who is told, not who may act.
    """
    users: list[User] = list(users_with_role(db, {"O&M Head"}))
    if plant_id is not None:
        from app.core.models import PlantResponsibility
        responsible_id = db.scalar(
            select(PlantResponsibility.assigned_user_id).where(
                PlantResponsibility.plant_id == plant_id,
                PlantResponsibility.area == "pm",
            )
        )
        if responsible_id:
            person = db.get(User, responsible_id)
            if person and person.is_active and person.role == "Assignee":
                users.append(person)
                return users
    if equipment:
        from app.equipment.service import equipment_responsible_users
        users.extend(equipment_responsible_users(db, equipment))
    return users


def notify_pm_event(
    db: Session,
    *,
    users: list[User],
    event_type: str,
    title: str,
    message: str,
    activity_id: str,
    plant: object | None,
    month: str,
    equipment: str | None = None,
    dedupe_key: str | None = None,
) -> None:
    """One PM notification, with enough context for the bell to open the activity itself."""
    notify_users(
        db,
        users,
        event_type=event_type,
        title=title,
        message=message,
        target_type="pm_activity",
        target_id=activity_id,
        dedupe_key=dedupe_key,
        payload={
            "page": "pm",
            "site_code": getattr(plant, "site_code", None),
            "plant_name": getattr(plant, "plant_name", None),
            "month": month,
            "activity_id": activity_id,
            "equipment": equipment,
        },
    )
