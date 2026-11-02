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
