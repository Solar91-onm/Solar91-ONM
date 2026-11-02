from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.models import AuditLog, Plant, User, UserPlantAssignment, WashingConfig
from app.core.security import require_csrf, require_permission

router = APIRouter(prefix="/api/users", tags=["Users"])
ALLOWED_ROLES = {"O&M Head", "Assignee", "Administration", "Site Engineer", "Viewer"}


class RoleUpdate(BaseModel):
    role: str


class AccessUpdate(BaseModel):
    """Atomic role, plant and (where applicable) per-plant washing assignment."""
    role: str
    plant_ids: list[UUID] = Field(default_factory=list, max_length=500)
    washing_plant_ids: list[UUID] = Field(default_factory=list, max_length=500)
    is_active: bool | None = None


class ActiveUpdate(BaseModel):
    is_active: bool


class PlantAssignmentsUpdate(BaseModel):
    plant_ids: list[UUID] = Field(default_factory=list, max_length=500)
    assignment_role: str | None = None


def out(u: User):
    return {
        "id": str(u.id),
        "name": u.display_name,
        "email": u.email,
        "role": u.role,
        "active": u.is_active,
        "provider": u.auth_provider,
        "invited": (u.external_subject or "").startswith("invite:"),
    }


PORTFOLIO_ROLES = {"O&M Head", "Administration"}


def _active_head_count(db: Session, exclude_id: UUID | None = None) -> int:
    stmt = select(func.count()).select_from(User).where(User.role == "O&M Head", User.is_active.is_(True))
    if exclude_id:
        stmt = stmt.where(User.id != exclude_id)
    return int(db.scalar(stmt) or 0)


def _validate_access(role: str, plant_ids: list[UUID]) -> None:
    if role not in ALLOWED_ROLES:
        raise HTTPException(422, "Unsupported role")
    if role == "Site Engineer" and len(plant_ids) != 1:
        raise HTTPException(422, "A Site Engineer must be assigned to exactly one plant")
    if role == "Assignee" and not plant_ids:
        raise HTTPException(422, "An Assignee must be assigned at least one plant")


@router.get("")
def list_users(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("users.manage"))],
):
    """All users with their plant scope, for the Team & Access screen."""
    rows = db.execute(
        select(UserPlantAssignment.user_id, Plant.id, Plant.site_code, Plant.plant_name)
        .join(Plant, Plant.id == UserPlantAssignment.plant_id)
        .order_by(Plant.site_code)
    ).all()
    by_user: dict[UUID, list[dict]] = {}
    for uid, pid, code, name in rows:
        by_user.setdefault(uid, []).append({"plant_id": str(pid), "site_code": code, "plant_name": name})
    washing_rows = db.execute(
        select(WashingConfig.assigned_user_id, WashingConfig.plant_id)
        .join(Plant, Plant.id == WashingConfig.plant_id)
        .where(WashingConfig.assigned_user_id.is_not(None))
        .order_by(Plant.site_code)
    ).all()
    washing_by_user: dict[UUID, list[str]] = {}
    for uid, plant_id in washing_rows:
        if uid is not None:
            washing_by_user.setdefault(uid, []).append(str(plant_id))
    result = []
    for u in db.scalars(select(User).order_by(User.display_name)):
        item = out(u)
        item["plants"] = by_user.get(u.id, [])
        item["washing_plant_ids"] = washing_by_user.get(u.id, [])
        item["created_at"] = u.created_at.isoformat() if getattr(u, "created_at", None) else None
        item["is_self"] = u.id == user.id
        result.append(item)
    return result


@router.put("/{user_id}/access", dependencies=[Depends(require_csrf)])
def update_access(
    user_id: UUID,
    data: AccessUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("users.manage"))],
):
    """Set a person's role and role-appropriate scope in ONE transaction."""
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    unique_ids = list(dict.fromkeys(data.plant_ids))
    washing_ids = list(dict.fromkeys(data.washing_plant_ids))
    if washing_ids and data.role != "Assignee":
        raise HTTPException(422, "Washing scope can only be assigned to an Assignee")
    if data.role == "Assignee":
        unique_ids = list(dict.fromkeys(unique_ids + washing_ids))
    _validate_access(data.role, unique_ids)
    # Portfolio roles see every plant; keeping per-plant rows for them would only confuse.
    if data.role in PORTFOLIO_ROLES:
        unique_ids = []
    all_requested_ids = list(dict.fromkeys(unique_ids + washing_ids))
    if all_requested_ids:
        valid = set(db.scalars(select(Plant.id).where(Plant.id.in_(all_requested_ids))))
        missing = [str(x) for x in all_requested_ids if x not in valid]
        if missing:
            raise HTTPException(422, detail={"message": "Unknown plant assignment", "plant_ids": missing})

    new_active = target.is_active if data.is_active is None else data.is_active
    if washing_ids and not new_active:
        raise HTTPException(422, "Washing scope can only be assigned to an active Assignee")
    # Lock-out protection: the portal must always keep at least one active O&M Head.
    losing_head = target.role == "O&M Head" and (data.role != "O&M Head" or not new_active)
    if losing_head and _active_head_count(db, exclude_id=target.id) == 0:
        raise HTTPException(409, "At least one active O&M Head is required. Promote another person first.")
    if target.id == user.id and (data.role != "O&M Head" or not new_active):
        raise HTTPException(409, "You cannot remove your own O&M Head access. Ask another O&M Head.")

    before_ids = [str(x) for x in db.scalars(
        select(UserPlantAssignment.plant_id).where(UserPlantAssignment.user_id == user_id))]
    washing_configs = list(db.scalars(
        select(WashingConfig)
        .where(
            (WashingConfig.assigned_user_id == target.id)
            | WashingConfig.plant_id.in_(washing_ids)
        )
        .with_for_update()
    ))
    config_by_plant = {config.plant_id: config for config in washing_configs}
    unconfigured = [str(plant_id) for plant_id in washing_ids if plant_id not in config_by_plant]
    if unconfigured:
        raise HTTPException(
            422,
            detail={
                "message": "Set up Washing for each selected plant before assigning its Washing responsibility.",
                "plant_ids": unconfigured,
            },
        )
    before_washing_ids = [
        str(config.plant_id) for config in washing_configs
        if config.assigned_user_id == target.id
    ]
    before = {
        "role": target.role,
        "active": target.is_active,
        "plant_ids": before_ids,
        "washing_plant_ids": before_washing_ids,
    }
    target.role = data.role
    target.is_active = new_active
    db.execute(delete(UserPlantAssignment).where(UserPlantAssignment.user_id == user_id))
    for pid in unique_ids:
        db.add(UserPlantAssignment(user_id=user_id, plant_id=pid, assignment_role=data.role))
    selected_washing_ids = set(washing_ids)
    for config in washing_configs:
        if config.assigned_user_id == target.id and config.plant_id not in selected_washing_ids:
            config.assigned_user_id = None
    for plant_id in washing_ids:
        config_by_plant[plant_id].assigned_user_id = target.id
    after = {
        "role": target.role,
        "active": target.is_active,
        "plant_ids": [str(x) for x in unique_ids],
        "washing_plant_ids": [str(x) for x in washing_ids],
    }
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name, action="Changed user access",
        module="Users", entity_type="user", entity_id=str(target.id),
        before_state=before, after_state=after, metadata_json={"target_email": target.email},
    ))
    if before["role"] != after["role"]:
        from app.notifications.service import create_notification
        create_notification(
            db, user_id=target.id, event_type="role_changed",
            title=f"Your Solar91 access is now: {target.role}",
            message="An O&M Head updated your role. Reload the portal to see your new modules.",
            target_type="user", target_id=str(target.id),
        )
    db.commit()
    db.refresh(target)
    item = out(target)
    item["plant_ids"] = after["plant_ids"]
    return item


@router.patch("/{user_id}/active", dependencies=[Depends(require_csrf)])
def set_active(
    user_id: UUID,
    data: ActiveUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("users.manage"))],
):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    if not data.is_active:
        if target.id == user.id:
            raise HTTPException(409, "You cannot deactivate your own account")
        if target.role == "O&M Head" and _active_head_count(db, exclude_id=target.id) == 0:
            raise HTTPException(409, "At least one active O&M Head is required")
    before = target.is_active
    target.is_active = data.is_active
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name,
        action="Activated user" if data.is_active else "Deactivated user",
        module="Users", entity_type="user", entity_id=str(target.id),
        before_state={"active": before}, after_state={"active": data.is_active},
        metadata_json={"target_email": target.email},
    ))
    db.commit()
    db.refresh(target)
    return out(target)


@router.patch("/{user_id}/role", dependencies=[Depends(require_csrf)])
def update_role(
    user_id: UUID,
    data: RoleUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("users.manage"))],
):
    if data.role not in ALLOWED_ROLES:
        raise HTTPException(422, "Unsupported role")
    row = db.get(User, user_id)
    if not row:
        raise HTTPException(404, "User not found")
    assignment_ids = list(db.scalars(
        select(UserPlantAssignment.plant_id).where(UserPlantAssignment.user_id == row.id)
    ))
    if data.role == "Site Engineer" and len(assignment_ids) != 1:
        raise HTTPException(422, "A Site Engineer role requires exactly one plant assignment")
    if row.role == "O&M Head" and data.role != "O&M Head" and _active_head_count(db, exclude_id=row.id) == 0:
        raise HTTPException(409, "At least one active O&M Head is required")
    if row.id == user.id and data.role != "O&M Head":
        raise HTTPException(409, "You cannot remove your own O&M Head access")
    before = row.role
    row.role = data.role
    # Portfolio roles see every plant, so their per-plant rows are dropped.
    if data.role in PORTFOLIO_ROLES:
        db.execute(delete(UserPlantAssignment).where(UserPlantAssignment.user_id == row.id))
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name, action="Changed user role",
        module="Users", entity_type="user", entity_id=str(row.id),
        before_state={"role": before}, after_state={"role": row.role},
        metadata_json={"target_email": row.email},
    ))
    db.commit()
    db.refresh(row)
    return out(row)


@router.get("/{user_id}/plants")
def get_plant_assignments(
    user_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("users.manage"))],
):
    if not db.get(User, user_id):
        raise HTTPException(404, "User not found")
    rows = db.execute(
        select(UserPlantAssignment, Plant)
        .join(Plant, Plant.id == UserPlantAssignment.plant_id)
        .where(UserPlantAssignment.user_id == user_id)
        .order_by(Plant.site_code)
    ).all()
    return [
        {
            "plant_id": str(a.plant_id),
            "site_code": p.site_code,
            "plant_name": p.plant_name,
            "assignment_role": a.assignment_role,
        }
        for a, p in rows
    ]


@router.put("/{user_id}/plants", dependencies=[Depends(require_csrf)])
def replace_plant_assignments(
    user_id: UUID,
    data: PlantAssignmentsUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("users.manage"))],
):
    if not db.get(User, user_id):
        raise HTTPException(404, "User not found")
    unique_ids = list(dict.fromkeys(data.plant_ids))
    target_user = db.get(User, user_id)
    if target_user and target_user.role == "Site Engineer" and len(unique_ids) != 1:
        raise HTTPException(422, "Site Engineer must be assigned to exactly one plant")
    before_ids = list(db.scalars(
        select(UserPlantAssignment.plant_id).where(UserPlantAssignment.user_id == user_id)
    ))
    if unique_ids:
        valid = set(db.scalars(select(Plant.id).where(Plant.id.in_(unique_ids))))
        missing = [str(x) for x in unique_ids if x not in valid]
        if missing:
            raise HTTPException(422, detail={"message": "Unknown plant assignment", "plant_ids": missing})
    db.execute(delete(UserPlantAssignment).where(UserPlantAssignment.user_id == user_id))
    for plant_id in unique_ids:
        db.add(
            UserPlantAssignment(
                user_id=user_id,
                plant_id=plant_id,
                assignment_role=data.assignment_role,
            )
        )
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name, action="Changed plant assignment",
        module="Users", entity_type="user", entity_id=str(user_id),
        before_state={"plant_ids": [str(x) for x in before_ids]},
        after_state={"plant_ids": [str(x) for x in unique_ids]},
        metadata_json={"assignment_role": data.assignment_role},
    ))
    db.commit()
    return {"ok": True, "assigned": len(unique_ids)}
