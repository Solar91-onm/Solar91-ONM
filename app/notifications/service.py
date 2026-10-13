from __future__ import annotations

from uuid import UUID
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.models import Equipment, Notification, User, UserEquipmentTypeAssignment, UserPlantAssignment

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

def equipment_responsible_users(
    db: Session, *, plant_id: UUID | None, equipment_id: UUID | None = None,
    equipment_ref: str | None = None, equipment_type: str | None = None,
) -> list[User]:
    """Notification routing only: per-item in-charge wins; visibility remains type/plant scoped elsewhere."""
    equipment = db.get(Equipment, equipment_id) if equipment_id else None
    if not equipment and plant_id and equipment_ref:
        ref = equipment_ref.strip().casefold()
        equipment = db.scalar(select(Equipment).where(
            Equipment.plant_id == plant_id,
            or_(func.lower(func.coalesce(Equipment.equipment_code, "")) == ref,
                func.lower(Equipment.equipment_name) == ref),
        ))
    if equipment and equipment.in_charge_user_id:
        person = db.get(User, equipment.in_charge_user_id)
        if person and person.is_active:
            return [person]
    etype = (equipment.equipment_type if equipment else equipment_type) or equipment_type
    if not etype:
        return []
    return list(db.scalars(
        select(User).join(UserEquipmentTypeAssignment, UserEquipmentTypeAssignment.user_id == User.id).where(
            User.is_active.is_(True),
            func.lower(UserEquipmentTypeAssignment.equipment_type) == etype.strip().lower(),
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
