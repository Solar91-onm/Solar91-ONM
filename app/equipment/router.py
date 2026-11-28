"""Equipment responsibility configuration, for the Login Access page.

The same rows are written from either direction — a user's own card, or the equipment
responsibility matrix — so the two views can never disagree. Every change is written to
``audit_logs``, which is what the page's history list reads back.

Reading and writing the configuration needs ``users.manage`` (the O&M Head), the same authority
the rest of the Login Access page requires. ``/mine`` is open to any signed-in user, because it
only tells that user what they themselves are responsible for.
"""
from __future__ import annotations

from typing import Annotated, Callable
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.models import AppSetting, AuditLog, EquipmentResponsibility, Issue, Plant, User
from app.core.security import get_current_user, require_csrf, require_permission
from app.equipment.issue_routing import ALL, MAX_RULES, SETTING_KEY, IssueRouting, read_rules, rule_key
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


class IssueRoutingChange(BaseModel):
    plant_ids: list[UUID] = Field(default_factory=list, max_length=100)
    equipment_keys: list[str] = Field(default_factory=lambda: [ALL], min_length=1, max_length=64)
    primary_user_id: UUID | None = None
    backup_user_id: UUID | None = None
    apply_existing: bool = False

    @field_validator("equipment_keys")
    @classmethod
    def _keys(cls, value: list[str]) -> list[str]:
        keys = list(dict.fromkeys(value))
        if any(not key or len(key) > 60 for key in keys):
            raise ValueError("equipment keys must be 1-60 characters")
        # A plant-wide rule and a per-equipment rule are different tiers; one save is one tier.
        if ALL in keys and len(keys) > 1:
            raise ValueError("All equipment cannot be combined with specific equipment")
        return keys


@router.put("/issue-routing", dependencies=[Depends(require_csrf)])
def set_issue_routing(payload: IssueRoutingChange, db: DB, user: Manager):
    """Upsert/delete every plant × equipment rule in the batch, or the single portfolio default."""
    from app.issues.service import _lock_issue_ticket_numbers
    _lock_issue_ticket_numbers(db)
    plants = set(payload.plant_ids)
    keys = payload.equipment_keys
    plant_wide = keys == [ALL]
    deleting = not (payload.primary_user_id or payload.backup_user_id)
    if not plant_wide and (not plants or (not deleting and not set(keys) <= _known_keys(db).keys())):
        raise HTTPException(422, "Choose valid plants and equipment categories")
    if plants and not deleting:
        found = set(db.scalars(select(Plant.id).where(Plant.id.in_(plants), func.lower(Plant.status) == "active")))
        if plants != found:
            raise HTTPException(422, "One or more plants are inactive or do not exist")
    if payload.primary_user_id and payload.primary_user_id == payload.backup_user_id:
        raise HTTPException(422, "Primary and backup must be different people")
    for uid in (payload.primary_user_id, payload.backup_user_id):
        if uid and _holder(db, uid).role != "Assignee":
            raise HTTPException(422, "Site issue owners must be active Assignees")
    rules = read_rules(db)
    value = {"primary_user_id": str(payload.primary_user_id) if payload.primary_user_id else None,
             "backup_user_id": str(payload.backup_user_id) if payload.backup_user_id else None}
    after = value if any(value.values()) else None
    for plant_id in sorted(plants) if plants else [None]:
        for key in keys:
            identity = rule_key(plant_id, key)
            before = rules.get(identity)
            if before == after:
                continue
            if after:
                rules[identity] = after
            else:
                rules.pop(identity, None)
            db.add(AuditLog(user_id=user.id, actor_name=user.display_name,
                action="Site issue routing set" if after else "Site issue routing removed",
                module="Login access", entity_type="site_issue_routing", entity_id=identity,
                before_state=before, after_state=after,
                metadata_json={"plant_id": str(plant_id) if plant_id else None, "equipment_key": key}))
    if len(rules) > MAX_RULES:
        raise HTTPException(422, "Site issue routing rule limit reached")
    setting = db.get(AppSetting, SETTING_KEY)
    if setting is None:
        db.add(AppSetting(setting_key=SETTING_KEY, setting_value=rules, updated_by=user.id))
    else:
        setting.setting_value = rules
        setting.updated_by = user.id
    db.flush()
    report: dict = {"reassigned": 0, "left_active": 0}
    count = (_route_open_issues(db, user, None if plant_wide else set(keys), plants or None, reassign=True, report=report)
             if payload.apply_existing and not deleting else 0)
    _commit(db)
    return {"issues_auto_assigned": count, "issues_reassigned": report["reassigned"],
            "issues_left_active": report["left_active"], "rules": rules}


class IssueRoutingApply(BaseModel):
    user_ids: list[UUID] = Field(min_length=1, max_length=2)


@router.post("/issue-routing/apply", dependencies=[Depends(require_csrf)])
def apply_issue_routing(payload: IssueRoutingApply, db: DB, user: Manager):
    """Re-apply these people's saved rules to existing open issues. No rule changes.

    Coverage is each person's plant + equipment rules, plant-wide rules, the portfolio default
    and their all-plant equipment. Unassigned, Assigned and Acknowledged tickets go to the
    owner the normal resolver picks (so where a person is only the backup, the eligible primary
    receives it); In Progress and later stay with their current owner.
    """
    from app.issues.service import _lock_issue_ticket_numbers
    _lock_issue_ticket_numbers(db)
    people = {str(uid) for uid in payload.user_ids}
    mine = {identity for identity, rule in read_rules(db).items()
            if people & {rule.get("primary_user_id"), rule.get("backup_user_id")}}
    portfolio_keys = set(db.scalars(select(EquipmentResponsibility.equipment_key).where(
        EquipmentResponsibility.user_id.in_(payload.user_ids), EquipmentResponsibility.active.is_(True))))
    everywhere = rule_key(None, ALL) in mine
    plant_wide = {identity.split(":", 1)[0] for identity in mine if identity.endswith(":" + ALL)}

    def covered(plant_id: UUID, key: str) -> bool:
        return (everywhere or key in portfolio_keys or str(plant_id) in plant_wide
                or rule_key(plant_id, key) in mine)

    report: dict = {"reassigned": 0, "left_active": 0}
    count = _route_open_issues(db, user, None, None, covered, reassign=True, report=report) if mine or portfolio_keys else 0
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Site issue routing applied",
        module="Login access", entity_type="site_issue_routing", entity_id="apply:" + ",".join(sorted(people)),
        before_state=None, after_state=None,
        metadata_json={"user_ids": sorted(people), "rules": len(mine), "portfolio_keys": sorted(portfolio_keys),
                       "issues_auto_assigned": count, "issues_reassigned": report["reassigned"],
                       "issues_left_active": report["left_active"]}))
    _commit(db)
    return {"issues_auto_assigned": count, "issues_reassigned": report["reassigned"],
            "issues_left_active": report["left_active"], "rules_covered": len(mine)}


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
def list_responsibilities(db: DB, user: Manager, include_routing: bool = True):
    """The whole matrix: every category, who holds it, and the people who can hold it."""
    people = _people(db)
    rows = list(db.scalars(select(EquipmentResponsibility).order_by(EquipmentResponsibility.user_id)))
    by_key: dict[str, list[dict]] = {}
    for row in rows:
        by_key.setdefault(row.equipment_key, []).append(_row_dto(row, people))
    items = []
    for item in catalogue(db):
        entries = by_key.get(item["key"], [])
        primary = next((e for e in entries if e["position"] == "primary" and e["active"]), None)
        backups = [e for e in entries if e["position"] == "backup" and e["active"]]
        eligible = lambda e: bool(e and e["user_active"] and e["user_role"] == "Assignee")
        backup = next((e for e in backups if eligible(e)), backups[0] if backups else None)
        status = "Active" if eligible(primary) else "Backup available" if eligible(backup) else "No eligible Assignee" if primary or backup else "Not configured"
        items.append({**item, "primary": primary, "backup": backup, "entries": entries, "status": status})
    holders = [{"id": str(u.id), "name": u.display_name, "role": u.role}
               for u in people.values() if u.is_active and u.role in HOLDER_ROLES]
    holders.sort(key=lambda h: (h["role"] != "Assignee", (h["name"] or "").casefold()))
    by_user = {}
    for row in rows:
        if row.active:
            by_user.setdefault(str(row.user_id), set()).add(row.equipment_key)
    result = {"categories": items, "holders": holders,
              "by_user": {uid: sorted(keys) for uid, keys in by_user.items()}}
    if include_routing:
        result.update(get_issue_routing(db, user))
    return result


@router.get("/issue-routing")
def get_issue_routing(db: DB, user: Manager):
    """Load the manager-only exceptions editor on demand, not on every settings visit."""
    plants = [{"id": str(pid), "site_code": code, "plant_name": name, "active": (status or "").lower() == "active"}
              for pid, code, name, status in db.execute(select(Plant.id, Plant.site_code, Plant.plant_name, Plant.status).order_by(Plant.site_code))]
    return {"issue_routing": read_rules(db), "plants": plants}


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
        select(AuditLog).where(AuditLog.entity_type.in_((AUDIT_ENTITY, "site_issue_routing")))
        .order_by(AuditLog.created_at.desc()).limit(limit)
    )
    people = _people(db)
    plants = {str(pid): code for pid, code in db.execute(select(Plant.id, Plant.site_code))}
    out = []
    for row in rows:
        target = (row.metadata_json or {}).get("user_id")
        person = people.get(UUID(target)) if target else None
        if row.entity_type == "site_issue_routing":
            meta = row.metadata_json or {}
            key = meta.get("equipment_key", ALL)
            scope = plants.get(meta.get("plant_id"), "Removed plant") if meta.get("plant_id") else "Portfolio default"
            label = scope + " · " + ("All equipment" if key == ALL else label_for(key))
        else:
            key = row.entity_id
            label = label_for(key or "", None)
        out.append({
            "id": str(row.id), "action": row.action, "actor": row.actor_name,
            "equipment_key": key,
            "equipment_label": label,
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
    routed = _route_open_issues(db, user, {k for k, item in wanted.items() if item.active})
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
    routed = _route_open_issues(db, user, {equipment_key} if payload.active and holders else set())
    _commit(db)
    for target, assigned, changed_label, position in changed:
        _notify(db, user_id=target, assigned=assigned, label=changed_label, position=position)
    db.commit()
    return {"equipment_key": equipment_key, "active": payload.active, "issues_auto_assigned": routed}


# The tickets an O&M Head may reassign by hand (IssueService.assign); a rule change moves no others.
REASSIGNABLE = ("Open", "Assigned", "Acknowledged")
ACTIVE_WORK = ("In Progress", "Pending Vendor", "Pending Parts/Vendor", "Pending Closure")


def _route_open_issues(db: Session, actor: User, keys: set[str] | None, plants: set[UUID] | None = None,
                       only: Callable[[UUID, str], bool] | None = None, *, reassign: bool = False,
                       report: dict | None = None) -> int:
    """Give matching tickets to the owner the rules resolve to. Returns how many changed.

    By default only unassigned Open tickets are routed and an existing owner is never
    overwritten. ``reassign=True`` (a site-issue rule saved with "Also assign") also moves
    Assigned/Acknowledged tickets held by someone else, the same tickets the O&M Head can
    reassign by hand; In Progress and later stay, and ``report["left_active"]`` counts them.
    Same transaction as configuration and audit; row locks recheck eligibility.
    ``only(plant_id, key)`` narrows candidates further (one person's rules).
    """
    if keys is not None and not keys:
        return 0
    db.flush()
    routing = IssueRouting(db, keys, plants)
    from datetime import datetime, timezone
    from app.issues.service import IssueService
    from app.notifications.service import create_notification
    scope = (Issue.deleted_at.is_(None), Issue.plant_id.is_not(None)) + ((Issue.plant_id.in_(plants),) if plants else ())
    unassigned = and_(Issue.assigned_to.is_(None), func.trim(func.coalesce(Issue.assignee_text, "")) == "")
    eligible = scope + ((Issue.status.in_(REASSIGNABLE),) if reassign else (Issue.status == "Open", unassigned))

    def in_scope(plant_id, vertical) -> bool:
        key = canonical_key(vertical)
        return (keys is None or key in keys) and (only is None or only(plant_id, key))

    candidates = [i for i, plant_id, vertical in db.execute(select(Issue.id, Issue.plant_id, Issue.vertical).where(*eligible))
                  if in_scope(plant_id, vertical)]
    service = IssueService(db)
    counts: dict[UUID, int] = {}
    moved_from: dict[UUID, int] = {}
    moved = 0
    for offset in range(0, len(candidates), 250):
        rows = db.scalars(select(Issue).where(*eligible, Issue.id.in_(candidates[offset:offset+250]))
                          .order_by(Issue.id).with_for_update()).all()
        for row in rows:
            key = canonical_key(row.vertical)
            target, source = routing.resolve(row.plant_id, row.vertical)
            if target is None or row.assigned_to == target.id:
                continue
            had_owner = row.assigned_to is not None or bool((row.assignee_text or "").strip())
            before, previous, previous_id = row.status, row.assignee_text, row.assigned_to
            row.assigned_to = target.id
            row.assignee_text = target.display_name
            row.status = "Assigned"  # as in a manual reassign, the new owner acknowledges it themselves
            row.updated_at = datetime.now(timezone.utc)
            if had_owner:
                moved += 1
                if previous_id:
                    moved_from[previous_id] = moved_from.get(previous_id, 0) + 1
                service._history(row, "issue.reassigned", actor, status_from=before, status_to="Assigned",
                    note=f"Reassigned when the site issue responsibility rule changed ({source}).",
                    metadata={"rule": source, "equipment": key, "from_assignee": previous,
                              "to_assignee": target.display_name, "assigned_to": str(target.id), "automatic": True})
            else:
                service._history(row, "issue.auto_assigned", actor, status_from=before, status_to="Assigned",
                    note=f"Automatically assigned when responsibility was configured ({source}).",
                    metadata={"rule": source, "equipment": key, "assigned_to": str(target.id)})
            counts[target.id] = counts.get(target.id, 0) + 1
    for uid, count in counts.items():
        create_notification(db, user_id=uid, event_type="ticket_assigned",
            title=f"{count} open site issue(s) assigned to you",
            message="Existing issues matching your site issue responsibility.",
            target_type="issue", payload={"page": "site-issues"})
    for uid, count in moved_from.items():
        if uid not in counts:
            create_notification(db, user_id=uid, event_type="ticket_reassigned",
                title=f"{count} site issue(s) moved to another owner",
                message="A site issue responsibility rule changed; those tickets now belong to its owner.",
                target_type="issue", payload={"page": "site-issues"})
    if report is not None:
        report["reassigned"] = moved
        report["left_active"] = 0
        if reassign:
            # Active work the rule would now give to someone else, left with its current owner.
            for plant_id, vertical, owner in db.execute(select(Issue.plant_id, Issue.vertical, Issue.assigned_to)
                                                        .where(*scope, Issue.status.in_(ACTIVE_WORK))):
                if in_scope(plant_id, vertical):
                    target, _ = routing.resolve(plant_id, vertical)
                    if target is not None and target.id != owner:
                        report["left_active"] += 1
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
