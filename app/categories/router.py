"""The work-category taxonomy: equipment categories, their sub-problems and unit counts.

This is what replaced the per-asset register. The table ships empty and can be filled
two ways, both of which write the same rows:

  * **In Supabase** — insert into ``work_categories`` directly (see
    database/migrations/033_work_categories.sql for a ready-made INSERT).
  * **From the portal** — these endpoints. An O&M Head or an Assignee can add, edit,
    reorder, deactivate and bulk-import categories without touching the database.

Reads are open to any signed-in user, because every category dropdown needs them.
Writes require ``plants.manage`` (O&M Head) or the Assignee role, matching who is
expected to maintain the list.
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
from app.core.models import AuditLog, OMTask, Issue, User, WorkCategory
from app.core.security import get_current_user, require_csrf

router = APIRouter(prefix="/api/categories", tags=["Work categories"])

DB = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]

# Who maintains the list. Site Engineers and Administration read it but do not edit it.
EDITOR_ROLES = {"O&M Head", "Assignee"}


def _require_editor(user: User) -> User:
    if user.role not in EDITOR_ROLES:
        raise HTTPException(403, "Only the O&M Head or an Assignee can change the category list")
    return user


def _name_clash(db: Session, name: str, *, exclude_id: UUID | None = None) -> bool:
    """Is this name already taken? Matched case-insensitively, as the Postgres index does.

    Checked here as well as in the database so SQLite and PostgreSQL behave the same.
    """
    stmt = select(WorkCategory.id).where(
        func.lower(func.trim(WorkCategory.name)) == name.strip().casefold()
    )
    if exclude_id is not None:
        stmt = stmt.where(WorkCategory.id != exclude_id)
    return db.scalar(stmt) is not None


def _clean_sub_problems(values: list[str] | None) -> list[str]:
    """Trimmed, de-duplicated, order preserved."""
    out: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        text = " ".join(str(value).split())
        if text and text.casefold() not in seen:
            seen.add(text.casefold())
            out.append(text)
    return out


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    code: str | None = Field(default=None, max_length=60)
    sub_problems: list[str] = Field(default_factory=list, max_length=200)
    default_units: int | None = Field(default=None, ge=0, le=100000)
    area: str | None = Field(default=None, max_length=60)
    notes: str | None = None
    sort_order: int = Field(default=100, ge=0, le=100000)
    active: bool = True

    @field_validator("name")
    @classmethod
    def _tidy_name(cls, value: str) -> str:
        name = " ".join(value.split())
        if not name:
            raise ValueError("name is required")
        return name


class CategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    code: str | None = Field(default=None, max_length=60)
    sub_problems: list[str] | None = Field(default=None, max_length=200)
    default_units: int | None = Field(default=None, ge=0, le=100000)
    area: str | None = Field(default=None, max_length=60)
    notes: str | None = None
    sort_order: int | None = Field(default=None, ge=0, le=100000)
    active: bool | None = None


class CategoryImport(BaseModel):
    """Replace or extend the list in one call — the bulk path for a prepared sheet."""
    categories: list[CategoryIn] = Field(min_length=1, max_length=500)
    replace: bool = False      # true clears the list first (records already raised keep their text)


def _out(row: WorkCategory, used: dict[str, int] | None = None) -> dict:
    name_key = (row.name or "").casefold()
    return {
        "id": str(row.id),
        "name": row.name,
        "code": row.code,
        "sub_problems": row.sub_problems or [],
        "default_units": row.default_units,
        "area": row.area,
        "notes": row.notes,
        "sort_order": row.sort_order,
        "active": row.active,
        "in_use": (used or {}).get(name_key, 0),
    }


def _usage(db: Session) -> dict[str, int]:
    """How many records already reference each category, so the UI can warn before a rename."""
    counts: dict[str, int] = {}
    for column in (Issue.vertical, OMTask.task_type):
        rows = db.execute(
            select(func.lower(func.trim(column)), func.count())
            .where(column.is_not(None))
            .group_by(func.lower(func.trim(column)))
        ).all()
        for name, total in rows:
            if name:
                counts[name] = counts.get(name, 0) + int(total or 0)
    return counts


@router.get("")
def list_categories(db: DB, user: CurrentUser, include_inactive: bool = False):
    """The category list. Every signed-in user may read it; the dropdowns depend on it."""
    stmt = select(WorkCategory).order_by(WorkCategory.sort_order, WorkCategory.name)
    if not include_inactive:
        stmt = stmt.where(WorkCategory.active.is_(True))
    rows = list(db.scalars(stmt))
    used = _usage(db) if user.role in EDITOR_ROLES else {}
    return {
        "categories": [_out(row, used) for row in rows],
        "can_edit": user.role in EDITOR_ROLES,
        "configured": bool(rows),
    }


@router.post("", status_code=201, dependencies=[Depends(require_csrf)])
def create_category(data: CategoryIn, db: DB, user: CurrentUser):
    _require_editor(user)
    if _name_clash(db, data.name):
        raise HTTPException(409, f"A category called {data.name} already exists")
    row = WorkCategory(
        name=data.name, code=data.code, sub_problems=_clean_sub_problems(data.sub_problems),
        default_units=data.default_units, area=data.area, notes=data.notes,
        sort_order=data.sort_order, active=data.active, created_by=user.id,
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, f"A category called {data.name} already exists") from exc
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Added work category",
                    module="Settings", entity_type="work_category", entity_id=str(row.id),
                    after_state={"name": row.name, "sub_problems": row.sub_problems}))
    db.commit()
    db.refresh(row)
    return _out(row)


@router.patch("/{category_id}", dependencies=[Depends(require_csrf)])
def update_category(category_id: UUID, data: CategoryUpdate, db: DB, user: CurrentUser):
    _require_editor(user)
    row = db.get(WorkCategory, category_id)
    if row is None:
        raise HTTPException(404, "Category not found")
    before = {"name": row.name, "sub_problems": row.sub_problems, "active": row.active}
    payload = data.model_dump(exclude_unset=True)
    if "sub_problems" in payload:
        payload["sub_problems"] = _clean_sub_problems(payload["sub_problems"])
    if "name" in payload and payload["name"]:
        payload["name"] = " ".join(payload["name"].split())
        if _name_clash(db, payload["name"], exclude_id=row.id):
            raise HTTPException(409, "Another category already uses that name")
    for key, value in payload.items():
        setattr(row, key, value)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "Another category already uses that name") from exc
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Changed work category",
                    module="Settings", entity_type="work_category", entity_id=str(row.id),
                    before_state=before, after_state={"name": row.name, "sub_problems": row.sub_problems,
                                                      "active": row.active}))
    db.commit()
    db.refresh(row)
    return _out(row, _usage(db))


@router.delete("/{category_id}", status_code=204, dependencies=[Depends(require_csrf)])
def delete_category(category_id: UUID, db: DB, user: CurrentUser):
    """Remove a category. One already used by a ticket or PM job is deactivated instead,
    so historical records keep reading the way they were raised."""
    _require_editor(user)
    row = db.get(WorkCategory, category_id)
    if row is None:
        raise HTTPException(404, "Category not found")
    in_use = _usage(db).get((row.name or "").casefold(), 0)
    if in_use:
        row.active = False
        action = "Deactivated work category (in use)"
    else:
        db.delete(row)
        action = "Removed work category"
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action=action,
                    module="Settings", entity_type="work_category", entity_id=str(category_id),
                    before_state={"name": row.name}, metadata_json={"records_using_it": in_use}))
    db.commit()
    return None


@router.post("/import", dependencies=[Depends(require_csrf)])
def import_categories(data: CategoryImport, db: DB, user: CurrentUser):
    """Load a prepared list in one call. Existing names are updated, new ones added."""
    _require_editor(user)
    existing = {(row.name or "").casefold(): row for row in db.scalars(select(WorkCategory))}

    if data.replace:
        used = _usage(db)
        incoming = {item.name.casefold() for item in data.categories}
        for key, row in existing.items():
            if key in incoming:
                continue
            if used.get(key):
                row.active = False          # keep the name readable on records that use it
            else:
                db.delete(row)

    created = updated = 0
    for index, item in enumerate(data.categories):
        row = existing.get(item.name.casefold())
        values = dict(
            name=item.name, code=item.code, sub_problems=_clean_sub_problems(item.sub_problems),
            default_units=item.default_units, area=item.area, notes=item.notes,
            sort_order=item.sort_order if item.sort_order != 100 else (index + 1) * 10,
            active=item.active,
        )
        if row is None:
            db.add(WorkCategory(**values, created_by=user.id))
            created += 1
        else:
            for key, value in values.items():
                setattr(row, key, value)
            updated += 1
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "The list contains two categories with the same name") from exc
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Imported work categories",
                    module="Settings", entity_type="work_category",
                    metadata_json={"created": created, "updated": updated, "replace": data.replace}))
    db.commit()
    return {"created": created, "updated": updated, "total": created + updated}
