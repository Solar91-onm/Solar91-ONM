from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.models import AuditLog, Equipment, Plant, User, UserEquipmentAssignment, UserEquipmentTypeAssignment, UserPlantAssignment
from app.core.security import require_csrf, require_permission

router = APIRouter(prefix="/api/users", tags=["Users"])
ALLOWED_ROLES = {"O&M Head", "Assignee", "Administration", "Site Engineer", "Viewer"}


class RoleUpdate(BaseModel):
    role: str


class AccessUpdate(BaseModel):
    """Atomic role and scope change; Site Engineer scope is plants, Assignee scope is equipment."""
    role: str
    plant_ids: list[UUID] = Field(default_factory=list, max_length=500)
    equipment_ids: list[UUID] = Field(default_factory=list, max_length=2000)  # legacy, ignored for scope
    equipment_types: list[str] = Field(default_factory=list, max_length=100)
    is_active: bool | None = None


class ActiveUpdate(BaseModel):
    is_active: bool


class PlantAssignmentsUpdate(BaseModel):
    plant_ids: list[UUID] = Field(default_factory=list, max_length=500)
    assignment_role: str | None = None


class EquipmentAssignmentsUpdate(BaseModel):
    equipment_ids: list[UUID] = Field(default_factory=list, max_length=2000)


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


@router.get("")
def list_users(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("users.manage"))],
):
    """All users with their plant/equipment scope, for the Team & Access screen."""
    rows = db.execute(
        select(UserPlantAssignment.user_id, Plant.id, Plant.site_code, Plant.plant_name)
        .join(Plant, Plant.id == UserPlantAssignment.plant_id)
        .order_by(Plant.site_code)
    ).all()
    by_user: dict[UUID, list[dict]] = {}
    for uid, pid, code, name in rows:
        by_user.setdefault(uid, []).append({"plant_id": str(pid), "site_code": code, "plant_name": name})
    # Equipment and equipment-type scope for every user in two queries (not two per user): the Team & Access
    # screen reloads this list after each change, so per-user round trips to the database made it slow.
    equipment_by_user: dict[UUID, list[dict]] = {}
    for uid, eid, code, name, pid, site_code, plant_name, status in db.execute(
        select(UserEquipmentAssignment.user_id, UserEquipmentAssignment.equipment_id, Equipment.equipment_code,
               Equipment.equipment_name, Equipment.plant_id, Plant.site_code, Plant.plant_name, Equipment.status)
        .join(Equipment, Equipment.id == UserEquipmentAssignment.equipment_id)
        .join(Plant, Plant.id == Equipment.plant_id)
        .order_by(Plant.site_code, Equipment.equipment_code, Equipment.equipment_name)
    ).all():
        equipment_by_user.setdefault(uid, []).append(
            {"equipment_id": str(eid), "equipment_code": code, "equipment_name": name,
             "plant_id": str(pid), "site_code": site_code, "plant_name": plant_name, "status": status})
    types_by_user: dict[UUID, list[str]] = {}
    for uid, equipment_type in db.execute(
        select(UserEquipmentTypeAssignment.user_id, UserEquipmentTypeAssignment.equipment_type)
    ).all():
        types_by_user.setdefault(uid, []).append(equipment_type)
    result = []
    for u in db.scalars(select(User).order_by(User.display_name)):
        item = out(u)
        item["plants"] = by_user.get(u.id, [])
        item["equipment"] = equipment_by_user.get(u.id, [])
        item["equipment_types"] = sorted(types_by_user.get(u.id, []))
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
    _validate_access(data.role, unique_ids)
    equipment_ids = []  # equipment is assigned by type now; individual items are not used for scope
    equipment_types = list(dict.fromkeys(t.strip() for t in data.equipment_types if t and t.strip()))
    if data.role != "Assignee" and equipment_types:
        raise HTTPException(422, "Equipment assignments are only valid for Assignees")
    if data.role == "Assignee" and unique_ids:
        raise HTTPException(422, "Assignees are assigned equipment, not plants")
    if data.role != "Site Engineer":
        unique_ids = []
    if equipment_ids:
        valid_equipment = set(db.scalars(
            select(Equipment.id).where(Equipment.id.in_(equipment_ids), Equipment.status != "inactive")
        ))
        missing_equipment = [str(x) for x in equipment_ids if x not in valid_equipment]
        if missing_equipment:
            raise HTTPException(422, detail={"message": "Unknown equipment assignment", "equipment_ids": missing_equipment})
    # Portfolio roles see every plant; keeping per-plant rows for them would only confuse.
    if data.role in PORTFOLIO_ROLES:
        unique_ids = []
    if unique_ids:
        valid = set(db.scalars(select(Plant.id).where(Plant.id.in_(unique_ids))))
        missing = [str(x) for x in unique_ids if x not in valid]
        if missing:
            raise HTTPException(422, detail={"message": "Unknown plant assignment", "plant_ids": missing})

    new_active = target.is_active if data.is_active is None else data.is_active
    # Lock-out protection: the portal must always keep at least one active O&M Head.
    losing_head = target.role == "O&M Head" and (data.role != "O&M Head" or not new_active)
    if losing_head and _active_head_count(db, exclude_id=target.id) == 0:
        raise HTTPException(409, "At least one active O&M Head is required. Promote another person first.")
    if target.id == user.id and (data.role != "O&M Head" or not new_active):
        raise HTTPException(409, "You cannot remove your own O&M Head access. Ask another O&M Head.")

    before_ids = [str(x) for x in db.scalars(
        select(UserPlantAssignment.plant_id).where(UserPlantAssignment.user_id == user_id))]
    before_equipment_ids = [str(x) for x in db.scalars(
        select(UserEquipmentAssignment.equipment_id).where(UserEquipmentAssignment.user_id == user_id))]
    before = {"role": target.role, "active": target.is_active, "plant_ids": before_ids,
              "equipment_ids": before_equipment_ids}
    target.role = data.role
    target.is_active = new_active
    db.execute(delete(UserPlantAssignment).where(UserPlantAssignment.user_id == user_id))
    for pid in unique_ids:
        db.add(UserPlantAssignment(user_id=user_id, plant_id=pid, assignment_role=data.role))
    before["equipment_types"] = sorted(db.scalars(
        select(UserEquipmentTypeAssignment.equipment_type).where(UserEquipmentTypeAssignment.user_id == user_id)))
    db.execute(delete(UserEquipmentAssignment).where(UserEquipmentAssignment.user_id == user_id))
    db.execute(delete(UserEquipmentTypeAssignment).where(UserEquipmentTypeAssignment.user_id == user_id))
    for etype in equipment_types:
        db.add(UserEquipmentTypeAssignment(user_id=user_id, equipment_type=etype))
    after = {"role": target.role, "active": target.is_active, "plant_ids": [str(x) for x in unique_ids],
             "equipment_types": equipment_types}
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
    item["equipment_types"] = after["equipment_types"]
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
    if data.role != "Site Engineer":
        db.execute(delete(UserPlantAssignment).where(UserPlantAssignment.user_id == row.id))
    if data.role != "Assignee":
        db.execute(delete(UserEquipmentAssignment).where(UserEquipmentAssignment.user_id == row.id))
        db.execute(delete(UserEquipmentTypeAssignment).where(UserEquipmentTypeAssignment.user_id == row.id))
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
    if target_user and target_user.role == "Assignee":
        raise HTTPException(422, "Assignees are assigned equipment, not plants")
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


@router.get("/{user_id}/equipment")
def get_equipment_assignments(
    user_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("users.manage"))],
):
    if not db.get(User, user_id):
        raise HTTPException(404, "User not found")
    rows = db.execute(
        select(UserEquipmentAssignment, Equipment, Plant)
        .join(Equipment, Equipment.id == UserEquipmentAssignment.equipment_id)
        .join(Plant, Plant.id == Equipment.plant_id)
        .where(UserEquipmentAssignment.user_id == user_id)
        .order_by(Plant.site_code, Equipment.equipment_code, Equipment.equipment_name)
    ).all()
    return [
        {"equipment_id": str(a.equipment_id), "equipment_code": e.equipment_code,
         "equipment_name": e.equipment_name, "plant_id": str(e.plant_id),
         "site_code": p.site_code, "plant_name": p.plant_name}
        for a, e, p in rows
    ]


@router.put("/{user_id}/equipment", dependencies=[Depends(require_csrf)])
def replace_equipment_assignments(
    user_id: UUID,
    data: EquipmentAssignmentsUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("users.manage"))],
):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    if target.role != "Assignee" and data.equipment_ids:
        raise HTTPException(422, "Equipment assignments are only valid for Assignees")
    unique_ids = list(dict.fromkeys(data.equipment_ids))
    if unique_ids:
        valid = set(db.scalars(select(Equipment.id).where(
            Equipment.id.in_(unique_ids), Equipment.status != "inactive"
        )))
        missing = [str(eid) for eid in unique_ids if eid not in valid]
        if missing:
            raise HTTPException(422, detail={"message": "Unknown or inactive equipment", "equipment_ids": missing})
    before_ids = list(db.scalars(
        select(UserEquipmentAssignment.equipment_id).where(UserEquipmentAssignment.user_id == target.id)
    ))
    db.execute(delete(UserEquipmentAssignment).where(UserEquipmentAssignment.user_id == target.id))
    for equipment_id in unique_ids:
        db.add(UserEquipmentAssignment(user_id=target.id, equipment_id=equipment_id))
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name, action="Changed equipment assignment",
        module="Users", entity_type="user", entity_id=str(target.id),
        before_state={"equipment_ids": [str(x) for x in before_ids]},
        after_state={"equipment_ids": [str(x) for x in unique_ids]},
    ))
    db.commit()
    return {"ok": True, "assigned": len(unique_ids)}