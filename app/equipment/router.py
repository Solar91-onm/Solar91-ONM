"""Equipment responsibility configuration, for the Login Access page.

The same rows are written from either direction — a user's own card, or the equipment
responsibility matrix — so the two views can never disagree. Every change is written to
``audit_logs``, which is what the page's history list reads back.

Reading and writing the configuration needs ``users.manage`` (the O&M Head), the same authority
the rest of the Login Access page requires. ``/mine`` is open to any signed-in user, because it
only tells that user what they themselves are responsible for.
"""
from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.models import AuditLog, EquipmentResponsibility, Issue, User
from app.core.security import get_current_user, require_csrf, require_permission
from app.equipment.service import (
    POSITIONS,
    catalogue,
    canonical_key,
    invalidate_responsibility_cache,
    label_for,
    user_responsibility_keys,
)

router = APIRouter(prefix="/api/equipment-responsibilities", tags=["Equipment responsibility"])

DB = Annotated[Session, Depends(get_db)]
Manager = Annotated[User, Depends(require_permission("users.manage"))]
# Who may hold a responsibility. Only an Assignee can become a ticket's automatic assignee;
# an O&M Head may be configured so the routing reaches them, which changes no authority.
HOLDER_ROLES = {"Assignee", "O&M Head"}
AUDIT_ENTITY = "equipment_responsibility"


class Item(BaseModel):
    equipment_key: str = Field(min_length=1, max_length=60)
    position: str = "primary"
    active: bool = True
    note: str | None = Field(default=None, max_length=2000)

    @field_validator("position")
    @classmethod
    def _position(cls, value: str) -> str:
        if value not in POSITIONS:
            raise ValueError("position must be primary or backup")
        return value


class UserResponsibilities(BaseModel):
    items: list[Item] = Field(default_factory=list, max_length=200)


class CategoryResponsibility(BaseModel):
    primary_user_id: UUID | None = None
    backup_user_id: UUID | None = None
    active: bool = True
    note: str | None = Field(default=None, max_length=2000)


def _row_dto(row: EquipmentResponsibility, names: dict[UUID, User]) -> dict:
    person = names.get(row.user_id)
    return {
        "id": str(row.id),
        "equipment_key": row.equipment_key,
        "equipment_label": row.equipment_label,
        "user_id": str(row.user_id),
        "user_name": person.display_name if person else None,
        "user_role": person.role if person else None,
        "user_active": bool(person.is_active) if person else False,
        "position": row.position,
        "active": row.active,
        "note": row.note,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _people(db: Session) -> dict[UUID, User]:
    return {u.id: u for u in db.scalars(select(User))}


def _holder(db: Session, user_id: UUID) -> User:
    person = db.get(User, user_id)
    if person is None or not person.is_active:
        raise HTTPException(404, "User not found or inactive")
    if person.role not in HOLDER_ROLES:
        raise HTTPException(422, "Equipment responsibility is held by an Assignee or the O&M Head")
    return person


def _known_keys(db: Session) -> dict[str, str]:
    return {item["key"]: item["label"] for item in catalogue(db)}


def _audit(db: Session, actor: User, action: str, key: str, before: dict | None, after: dict | None,
           user_id: UUID | None) -> None:
    db.add(AuditLog(
        user_id=actor.id, actor_name=actor.display_name, action=action, module="Login access",
        entity_type=AUDIT_ENTITY, entity_id=key, before_state=before, after_state=after,
        metadata_json={"equipment_key": key, "user_id": str(user_id) if user_id else None},
    ))


def _notify(db: Session, *, user_id: UUID, assigned: bool, label: str, position: str) -> None:
    """Tell the person their portfolio-wide responsibility changed. Never blocks the save."""
    try:
        from app.notifications.service import create_notification
        create_notification(
            db, user_id=user_id,
            event_type="equipment_responsibility_assigned" if assigned else "equipment_responsibility_removed",
            title=("You are now responsible for " + label) if assigned
                  else ("Responsibility removed: " + label),
            message=("Across all plants, as the " + position + " responsible person.") if assigned
                    else "You will no longer be notified about this equipment.",
            target_type="equipment", target_id=label,
            payload={"page": "settings", "equipment": label},
        )
    except Exception:  # pragma: no cover - notification must not undo a saved change
        pass


@router.get("")
def list_responsibilities(db: DB, user: Manager):
    """The whole matrix: every category, who holds it, and the people who can hold it."""
    people = _people(db)
    rows = list(db.scalars(select(EquipmentResponsibility)))
    by_key: dict[str, list[dict]] = {}
    for row in rows:
        by_key.setdefault(row.equipment_key, []).append(_row_dto(row, people))
    items = []
    for item in catalogue(db):
        entries = by_key.get(item["key"], [])
        primary = next((e for e in entries if e["position"] == "primary" and e["active"]), None)
        backup = next((e for e in entries if e["position"] == "backup" and e["active"]), None)
        items.append({**item, "primary": primary, "backup": backup, "entries": entries,
                      "status": "Active" if primary else "Not configured"})
    holders = [{"id": str(u.id), "name": u.display_name, "role": u.role}
               for u in people.values() if u.is_active and u.role in HOLDER_ROLES]
    holders.sort(key=lambda h: (h["role"] != "Assignee", (h["name"] or "").casefold()))
    return {"categories": items, "holders": holders,
            "by_user": {str(uid): sorted(user_responsibility_keys(db, uid))
                        for uid in {r.user_id for r in rows}}}


@router.get("/mine")
def my_responsibilities(db: DB, user: Annotated[User, Depends(get_current_user)]):
    """What the signed-in user is responsible for. Tells them nothing about anyone else."""
    keys = user_responsibility_keys(db, user.id)
    known = _known_keys(db)
    return {"keys": sorted(keys), "labels": [label_for(k, known.get(k)) for k in sorted(keys)]}


@router.get("/history")
def history(db: DB, user: Manager, limit: int = 50):
    """Who changed equipment responsibility, and when."""
    limit = max(1, min(limit, 200))
    rows = db.scalars(
        select(AuditLog).where(AuditLog.entity_type == AUDIT_ENTITY)
        .order_by(AuditLog.created_at.desc()).limit(limit)
    )
    people = _people(db)
    out = []
    for row in rows:
        target = (row.metadata_json or {}).get("user_id")
        person = people.get(UUID(target)) if target else None
        out.append({
            "id": str(row.id), "action": row.action, "actor": row.actor_name,
            "equipment_key": row.entity_id,
            "equipment_label": label_for(row.entity_id or "", None),
            "user_name": person.display_name if person else None,
            "before": row.before_state, "after": row.after_state,
            "created_at": row.created_at.isoformat() if row.created_at else None,
        })
    return {"entries": out}


@router.put("/user/{user_id}", dependencies=[Depends(require_csrf)])
def replace_user_responsibilities(user_id: UUID, payload: UserResponsibilities, db: DB, user: Manager):
    """Set exactly the equipment one person is responsible for, portfolio-wide.

    Categories the person no longer holds are removed; a category they take over as primary is
    released by whoever held it, so there is never a second active primary.
    """
    from app.issues.service import _lock_issue_ticket_numbers
    _lock_issue_ticket_numbers(db)
    person = _holder(db, user_id)
    known = _known_keys(db)
    wanted: dict[str, Item] = {}
    for item in payload.items:
        if item.equipment_key not in known:
            raise HTTPException(422, f"Unknown equipment category: {item.equipment_key}")
        wanted[item.equipment_key] = item
    existing = list(db.scalars(
        select(EquipmentResponsibility)
        .where(EquipmentResponsibility.user_id == user_id).with_for_update()
    ))
    changed: list[tuple[UUID, bool, str, str]] = []
    for row in existing:
        if row.equipment_key not in wanted:
            _audit(db, user, "Equipment responsibility removed", row.equipment_key,
                   {"position": row.position, "active": row.active}, None, user_id)
            changed.append((user_id, False, row.equipment_label, row.position))
            db.delete(row)
    db.flush()
    for key, item in wanted.items():
        label = known[key]
        row = next((r for r in existing if r.equipment_key == key), None)
        before = {"position": row.position, "active": row.active} if row else None
        if item.position == "primary" and item.active:
            _release_primary(db, key, keep_user_id=user_id, actor=user)
        if row is None:
            row = EquipmentResponsibility(equipment_key=key, equipment_label=label, user_id=user_id)
            db.add(row)
        row.equipment_label = label
        row.position, row.active, row.note = item.position, item.active, item.note
        row.updated_by = user.id
        after = {"position": row.position, "active": row.active}
        if before != after:
            _audit(db, user, "Equipment responsibility set", key, before, after, user_id)
            if item.active:
                changed.append((user_id, True, label, item.position))
    routed = _route_open_issues(db, user, {k: person for k, item in wanted.items()
        if item.active and item.position == "primary" and person.role == "Assignee"})
    _commit(db)
    for target, assigned, label, position in changed:
        _notify(db, user_id=target, assigned=assigned, label=label, position=position)
    db.commit()
    return {"user_id": str(person.id), "keys": sorted(user_responsibility_keys(db, user_id)), "issues_auto_assigned": routed}


@router.put("/category/{equipment_key}", dependencies=[Depends(require_csrf)])
def set_category_responsibility(equipment_key: str, payload: CategoryResponsibility, db: DB, user: Manager):
    """Set one category's primary and optional backup from the responsibility matrix."""
    from app.issues.service import _lock_issue_ticket_numbers
    _lock_issue_ticket_numbers(db)
    known = _known_keys(db)
    if equipment_key not in known:
        raise HTTPException(422, f"Unknown equipment category: {equipment_key}")
    label = known[equipment_key]
    if payload.primary_user_id and payload.primary_user_id == payload.backup_user_id:
        raise HTTPException(422, "The backup must be a different person from the primary")
    holders = {}
    for position in POSITIONS:
        target = payload.primary_user_id if position == "primary" else payload.backup_user_id
        if target:
            holders[position] = _holder(db, target)
    rows = list(db.scalars(
        select(EquipmentResponsibility)
        .where(EquipmentResponsibility.equipment_key == equipment_key).with_for_update()
    ))
    changed: list[tuple[UUID, bool, str, str]] = []
    keep = {str(h.id) for h in holders.values()}
    # Free the primary slot before the row that takes it is written.
    for row in rows:
        if row.position == "primary" and row.active and str(row.user_id) in keep                 and holders.get("primary") is not None and row.user_id != holders["primary"].id:
            row.position = "backup"
            db.flush()
    for row in rows:
        if str(row.user_id) not in keep:
            _audit(db, user, "Equipment responsibility removed", equipment_key,
                   {"position": row.position, "active": row.active}, None, row.user_id)
            changed.append((row.user_id, False, row.equipment_label, row.position))
            db.delete(row)
    db.flush()
    for position, person in holders.items():
        row = next((r for r in rows if r.user_id == person.id), None)
        before = {"position": row.position, "active": row.active} if row else None
        if row is None:
            row = EquipmentResponsibility(equipment_key=equipment_key, equipment_label=label,
                                          user_id=person.id)
            db.add(row)
        row.equipment_label = label
        row.position, row.active, row.note = position, payload.active, payload.note
        row.updated_by = user.id
        after = {"position": position, "active": payload.active}
        if before != after:
            _audit(db, user, "Equipment responsibility set", equipment_key, before, after, person.id)
            if payload.active:
                changed.append((person.id, True, label, position))
    primary = holders.get("primary")
    routed = _route_open_issues(db, user, {equipment_key: primary}
        if payload.active and primary and primary.role == "Assignee" else {})
    _commit(db)
    for target, assigned, changed_label, position in changed:
        _notify(db, user_id=target, assigned=assigned, label=changed_label, position=position)
    db.commit()
    return {"equipment_key": equipment_key, "active": payload.active, "issues_auto_assigned": routed}


def _route_open_issues(db: Session, actor: User, owners: dict[str, User]) -> int:
    """Route only previously unassigned open tickets; never overwrite an existing owner.

    Same transaction as responsibility configuration and audit. A bounded projection finds
    candidates by canonical alias; row locks then recheck eligibility before changing them.
    """
    if not owners:
        return 0
    from datetime import datetime, timezone
    from app.issues.service import IssueService
    from app.notifications.service import create_notification
    eligible = (Issue.status == "Open", Issue.deleted_at.is_(None), Issue.plant_id.is_not(None),
                Issue.assigned_to.is_(None), func.trim(func.coalesce(Issue.assignee_text, "")) == "")
    candidates = [i for i, vertical in db.execute(select(Issue.id, Issue.vertical).where(*eligible))
                  if canonical_key(vertical) in owners]
    service = IssueService(db)
    counts: dict[UUID, int] = {}
    for offset in range(0, len(candidates), 250):
        rows = db.scalars(select(Issue).where(*eligible, Issue.id.in_(candidates[offset:offset+250]))
                          .order_by(Issue.id).with_for_update()).all()
        for row in rows:
            key = canonical_key(row.vertical)
            target = owners.get(key)
            if target is None:
                continue
            row.assigned_to = target.id
            row.assignee_text = target.display_name
            row.status = "Assigned"
            row.updated_at = datetime.now(timezone.utc)
            service._history(row, "issue.auto_assigned", actor, status_from="Open", status_to="Assigned",
                note="Automatically assigned when equipment responsibility was configured.",
                metadata={"rule": "equipment_responsibility", "equipment": key, "assigned_to": str(target.id)})
            counts[target.id] = counts.get(target.id, 0) + 1
    for uid, count in counts.items():
        create_notification(db, user_id=uid, event_type="ticket_assigned",
            title=f"{count} open site issue(s) assigned to you",
            message="Existing unassigned issues matching your equipment responsibility.",
            target_type="issue", payload={"page": "site-issues"})
    return sum(counts.values())


def _release_primary(db: Session, equipment_key: str, *, keep_user_id: UUID, actor: User) -> None:
    """Whoever else holds this category as active primary becomes its backup."""
    for row in db.scalars(
        select(EquipmentResponsibility).where(
            EquipmentResponsibility.equipment_key == equipment_key,
            EquipmentResponsibility.position == "primary",
            EquipmentResponsibility.active.is_(True),
            EquipmentResponsibility.user_id != keep_user_id,
        ).with_for_update()
    ):
        _audit(db, actor, "Equipment primary replaced", equipment_key,
               {"position": "primary", "active": True}, {"position": "backup", "active": True}, row.user_id)
        row.position = "backup"
        row.updated_by = actor.id
        db.flush()


def _commit(db: Session) -> None:
    try:
        db.flush()
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "That equipment already has an active primary responsible person") from exc
    invalidate_responsibility_cache()
