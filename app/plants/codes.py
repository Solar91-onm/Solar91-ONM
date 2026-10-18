from __future__ import annotations

import re
from collections.abc import Iterable
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.orm import Session

if TYPE_CHECKING:
    from app.core.models import Plant


_SITE_CODE_ALIASES = {"KHO01": "KH001"}


def normalize_site_code(value: object) -> str:
    """Return the canonical plant code, removing separators without O/0 substitution."""
    code = re.sub(r"[^A-Z0-9]", "", str(value or "").upper())
    return _SITE_CODE_ALIASES.get(code, code)


def plant_code_index(plants: Iterable[Plant]) -> dict[str, Plant]:
    """Index plants canonically, preferring an already-canonical stored row on collisions."""
    index: dict[str, Plant] = {}
    for plant in plants:
        key = normalize_site_code(plant.site_code)
        if not key:
            continue
        current = index.get(key)
        if current is None or plant.site_code == key:
            index[key] = plant
    return index


def find_plant_by_code(db: Session, value: object) -> Plant | None:
    """Resolve old formatted input against existing rows without creating a duplicate."""
    from app.core.models import Plant

    key = normalize_site_code(value)
    if not key:
        return None
    exact = db.scalar(select(Plant).where(Plant.site_code == key))
    if exact is not None:
        return exact
    return plant_code_index(db.scalars(select(Plant))).get(key)
