"""Movable Assets: how many units of each named part every plant holds.

Reading follows plant scope (same helpers as Asset & Warranty). Writing needs ``plants.manage``.
A part is just a name; the page's columns are the distinct names stored here.
"""
from __future__ import annotations

import re
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.models import AuditLog, MovableAsset, User
from app.core.security import get_current_user, require_csrf, require_permission
from app.warranty.sheets import _plant_for_code, _visible_plants

router = APIRouter(prefix="/api/movable-assets", tags=["Movable Assets"])

MAX_PARTS = 100
MAX_UNITS = 1_000_000


def _clean_part(value: str) -> str:
    part = re.sub(r"\s+", " ", str(value or "")).strip()
    if not part:
        raise HTTPException(422, "Part name is required")
    if len(part) > 160:
        raise HTTPException(422, "Part name must be 160 characters or fewer")
    return part


def _canonical(db: Session, part: str) -> str:
    """Reuse the spelling already stored, so 'Ladder' and 'ladder' stay one column."""
    wanted = part.lower()
    for (existing,) in db.execute(select(MovableAsset.part).distinct()):
        if existing.lower() == wanted:
            return existing
    return part


class UnitsIn(BaseModel):
    site_code: str = Field(min_length=1, max_length=40)
    part: str
    units: int = Field(ge=0, le=MAX_UNITS)


class PartIn(BaseModel):
    part: str


class UnitItem(BaseModel):
    part: str
    units: int = Field(ge=0, le=MAX_UNITS)


class PlantUnitsIn(BaseModel):
    site_code: str = Field(min_length=1, max_length=40)
    items: list[UnitItem] = Field(min_length=1, max_length=MAX_PARTS)


@router.get("")
def list_units(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
               site_code: str | None = None):
    """Every (plant, part, units) in the caller's scope, plus the part names for the columns."""
    plants = {p.id: p for p in ([_plant_for_code(db, user, site_code)] if site_code else _visible_plants(db, user))}
    if not plants:
        return {"parts": [], "records": []}
    rows = list(db.scalars(select(MovableAsset).where(MovableAsset.plant_id.in_(list(plants)))))
    # Columns come from the whole table, so a plant that holds nothing still shows the same columns.
    parts = sorted({r for (r,) in db.execute(select(MovableAsset.part).distinct())}, key=str.lower)
    return {
        "parts": parts,
        "records": [{"siteCode": plants[r.plant_id].site_code, "part": r.part, "units": r.units} for r in rows],
    }


@router.put("", dependencies=[Depends(require_csrf)])
def set_units(body: UnitsIn, db: Annotated[Session, Depends(get_db)],
              user: Annotated[User, Depends(require_permission("plants.manage"))]):
    plant = _plant_for_code(db, user, body.site_code)
    part = _canonical(db, _clean_part(body.part))
    row = db.scalar(select(MovableAsset).where(MovableAsset.plant_id == plant.id, MovableAsset.part == part))
    if row is None:
        row = MovableAsset(plant_id=plant.id, part=part, units=body.units, updated_by=user.id)
        db.add(row)
    else:
        row.units = body.units
        row.updated_by = user.id
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Updated movable asset units",
                    module="Movable Assets",
                    metadata_json={"site_code": plant.site_code, "part": part, "units": body.units}))
    db.commit()
    return {"siteCode": plant.site_code, "part": part, "units": body.units}


@router.put("/plant", dependencies=[Depends(require_csrf)])
def set_plant_units(body: PlantUnitsIn, db: Annotated[Session, Depends(get_db)],
                    user: Annotated[User, Depends(require_permission("plants.manage"))]):
    """Save several parts for one plant in a single transaction (the Edit dialog).

    Only parts that already exist as columns are accepted, so a stale dialog cannot bring back a
    part someone else just removed.
    """
    plant = _plant_for_code(db, user, body.site_code)
    known = {p.lower(): p for (p,) in db.execute(select(MovableAsset.part).distinct())}
    wanted: dict[str, int] = {}
    for item in body.items:
        clean = _clean_part(item.part)
        part = known.get(clean.lower())
        if part is None:
            raise HTTPException(422, f'Unknown part "{clean}". Reload the page and try again.')
        if part in wanted:
            raise HTTPException(422, f'Part "{part}" was sent twice')
        wanted[part] = item.units
    rows = {r.part: r for r in db.scalars(select(MovableAsset).where(
        MovableAsset.plant_id == plant.id, MovableAsset.part.in_(list(wanted))))}
    changes = []
    for part, units in wanted.items():
        row = rows.get(part)
        if row is None:
            db.add(MovableAsset(plant_id=plant.id, part=part, units=units, updated_by=user.id))
            changes.append({"part": part, "from": None, "to": units})
        elif row.units != units:
            changes.append({"part": part, "from": row.units, "to": units})
            row.units = units
            row.updated_by = user.id
    if changes:
        db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Updated movable asset units",
                        module="Movable Assets", metadata_json={"site_code": plant.site_code, "changes": changes}))
    db.commit()
    return {"siteCode": plant.site_code, "changed": len(changes),
            "records": [{"part": p, "units": u} for p, u in wanted.items()]}


@router.post("/parts", status_code=201, dependencies=[Depends(require_csrf)])
def add_part(body: PartIn, db: Annotated[Session, Depends(get_db)],
             user: Annotated[User, Depends(require_permission("plants.manage"))]):
    """Add a part column: every plant in scope gets a 0-unit row, which they then fill in."""
    part = _canonical(db, _clean_part(body.part))
    existing = {r for (r,) in db.execute(select(MovableAsset.part).distinct())}
    if part not in existing and len(existing) >= MAX_PARTS:
        raise HTTPException(422, f"At most {MAX_PARTS} different parts are supported")
    created = 0
    for plant in _visible_plants(db, user):
        has = db.scalar(select(MovableAsset.id).where(MovableAsset.plant_id == plant.id, MovableAsset.part == part))
        if has is None:
            db.add(MovableAsset(plant_id=plant.id, part=part, units=0, updated_by=user.id))
            created += 1
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Added movable asset part",
                    module="Movable Assets", metadata_json={"part": part, "plants": created}))
    db.commit()
    return {"part": part, "plantsAdded": created}


@router.delete("/parts", dependencies=[Depends(require_csrf)])
def delete_part(part: str, db: Annotated[Session, Depends(get_db)],
                user: Annotated[User, Depends(require_permission("plants.manage"))]):
    """Remove a part column for the plants in the caller's scope."""
    part = _canonical(db, _clean_part(part))
    ids = [p.id for p in _visible_plants(db, user)]
    rows = list(db.scalars(select(MovableAsset).where(MovableAsset.plant_id.in_(ids), MovableAsset.part == part))) if ids else []
    for row in rows:
        db.delete(row)
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Removed movable asset part",
                    module="Movable Assets", metadata_json={"part": part, "rows": len(rows)}))
    db.commit()
    return {"part": part, "removed": len(rows)}