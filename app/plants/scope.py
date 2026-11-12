"""Plant scope: which plants a caller may read, and resolving one site code within that scope.

Every per-plant register (BOM, Movable Assets, ...) answers the same two questions before it
reads or writes: which plants is this user allowed to see, and does this site code name one of
them. A role with portfolio scope sees every plant; anyone else sees only their assigned plants,
and a plant outside that set is refused.

These helpers lived in the Asset & Warranty module until that page was removed; they were never
specific to it.
"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.models import Plant, User
from app.core.security import has_portfolio_scope, user_scoped_plant_ids
from app.plants.codes import normalize_site_code


def scoped_plant_ids(db: Session, user: User) -> set | None:
    """The plant ids this user is limited to, or ``None`` when they may see the whole portfolio."""
    return None if has_portfolio_scope(user) else (user_scoped_plant_ids(db, user) or set())


def visible_plants(db: Session, user: User) -> list[Plant]:
    """Every plant in the caller's scope, ordered by site code."""
    allowed = scoped_plant_ids(db, user)
    return [plant for plant in db.scalars(select(Plant).order_by(Plant.site_code))
            if allowed is None or plant.id in allowed]


def plant_for_code(db: Session, user: User, site_code: str) -> Plant:
    """The plant with this site code, or 404; 403 when it exists but is outside the caller's scope."""
    wanted = normalize_site_code(site_code)
    match = next((p for p in db.scalars(select(Plant))
                  if normalize_site_code(p.site_code) == wanted), None)
    if match is None:
        raise HTTPException(404, "No plant matches that site code")
    allowed = scoped_plant_ids(db, user)
    if allowed is not None and match.id not in allowed:
        raise HTTPException(403, "That plant is outside your scope")
    return match
