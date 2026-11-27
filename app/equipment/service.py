"""Equipment responsibility: one canonical category list, and who answers for each one.

Two things live here.

**The canonical catalogue.** The portal already names the same equipment differently in
different modules: Preventive Maintenance assigns ``4 Pole + ACDB + Aux. TX`` and ``GSS visit``,
an issue is raised against a ``work_categories`` row such as ``VCB Panel``, and Module Cleaning
calls its work "washing". ``CATALOGUE`` is the one list of categories, each with the aliases the
other modules use, so a responsibility is configured once and recognised everywhere. Categories
configured in ``work_categories`` that match no alias are added to the list as they are — the
master table stays authoritative and nothing is duplicated.

**The lookups.** Who is responsible for a category, portfolio-wide. These decide where work and
notifications are *routed*; they are not an authorization boundary. Plant visibility still comes
from ``user_plant_assignments`` via ``app.core.security.user_scoped_plant_ids``, and approval and
sequence-override authority still come from the role.
"""
from __future__ import annotations

import re
import time
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.models import EquipmentResponsibility, User, WorkCategory

# key, label, area, aliases (lower-case, trimmed) used by the other modules.
CATALOGUE: list[dict] = [
    {"key": "inverter", "label": "Inverter", "area": "Plant side",
     "aliases": {"inverter", "inverters", "inv"}},
    {"key": "module", "label": "Module", "area": "Plant side",
     "aliases": {"module", "modules", "pv module", "solar module"}},
    {"key": "mms", "label": "Module Mounting Structure (MMS)", "area": "Plant side",
     "aliases": {"mms", "module mounting structure", "module mounting structure (mms)", "structure"}},
    {"key": "accb", "label": "ACCB", "area": "Plant side",
     "aliases": {"accb", "accb panel"}},
    {"key": "acdb", "label": "ACDB", "area": "Plant side",
     "aliases": {"acdb", "acdb panel"}},
    {"key": "idt_transformer", "label": "IDT Transformer", "area": "Plant side",
     "aliases": {"idt", "idt transformer", "transformer", "inverter duty transformer"}},
    {"key": "aux_transformer", "label": "Auxiliary Transformer", "area": "Plant side",
     "aliases": {"aux. transformer", "aux transformer", "auxiliary transformer",
                 "aux. transformer + acdb"}},
    {"key": "vcb", "label": "VCB", "area": "Plant side",
     "aliases": {"vcb", "vcb panel"}},
    {"key": "four_pole", "label": "Four Pole Equipment", "area": "Plant side",
     "aliases": {"4 pole", "four pole", "4 pole structure", "four pole equipment"}},
    {"key": "transmission_line", "label": "Transmission Line", "area": "Plant side",
     "aliases": {"transmission line", "tx line", "transmission"}},
    {"key": "gss", "label": "GSS / Switchyard", "area": "GSS side",
     "aliases": {"gss", "gss visit", "switchyard", "vcb - gss side", "4 pole - gss side",
                 "gss / switchyard"}},
    {"key": "earthing", "label": "Earthing System", "area": "Plant side",
     "aliases": {"earthing", "earth pit", "earthing system", "earth pits"}},
    {"key": "weather", "label": "Weather Monitoring System", "area": "Plant side",
     "aliases": {"wms", "weather station", "weather monitoring system", "weather station & ups"}},
    {"key": "communication", "label": "Communication System", "area": "Plant side",
     "aliases": {"communication", "communication system", "scada", "rms", "com100"}},
    {"key": "water_system", "label": "Water Pipeline and Motor", "area": "Plant side",
     "aliases": {"water pipeline and motor", "water pipeline", "water system", "motor",
                 "water pipe line and motor"}},
    {"key": "washing", "label": "Module Cleaning / Washing", "area": "Plant side",
     "aliases": {"washing", "module cleaning", "module cleaning / washing", "cleaning"}},
    {"key": "misc", "label": "Miscellaneous", "area": "Plant side",
     "aliases": {"miscellaneous", "misc", "other", "others"}},
]

_BY_KEY = {item["key"]: item for item in CATALOGUE}
_BY_ALIAS: dict[str, str] = {}
for _item in CATALOGUE:
    _BY_ALIAS[_item["label"].casefold()] = _item["key"]
    for _alias in _item["aliases"]:
        _BY_ALIAS[_alias] = _item["key"]

# A PM activity can cover several categories at once. Its checklist is one combined document,
# so each section's equipment is told about it rather than inventing a new category for the pair.
PM_EQUIPMENT_KEYS: dict[str, list[str]] = {
    "Inverter": ["inverter"],
    "ACCB": ["accb"],
    "IDT Transformer": ["idt_transformer"],
    "VCB": ["vcb"],
    "4 Pole + ACDB + Aux. TX": ["four_pole", "acdb", "aux_transformer"],
    "Transmission line": ["transmission_line"],
    "GSS visit": ["gss"],
    "Earth pit": ["earthing"],
    "Miscellaneous": ["misc", "weather", "communication", "water_system"],
}

POSITIONS = ("primary", "backup")


def slug(name: str) -> str:
    """A stable key for a category that is not in the built-in catalogue."""
    cleaned = re.sub(r"[^a-z0-9]+", "_", (name or "").casefold()).strip("_")
    return ("cat_" + cleaned)[:60] if cleaned else ""


def canonical_key(name: str | None) -> str | None:
    """The canonical key for any module's name for this equipment, or None."""
    if not name:
        return None
    text = str(name).strip().casefold()
    if text in _BY_ALIAS:
        return _BY_ALIAS[text]
    if text in _BY_KEY:
        return text
    # "Inverter (string)" and "VCB Panel - GSS side" still resolve to their category.
    for alias, key in _BY_ALIAS.items():
        if len(alias) >= 4 and (text.startswith(alias + " ") or text.startswith(alias + " -")):
            return key
    return slug(text) or None


def label_for(key: str, fallback: str | None = None) -> str:
    item = _BY_KEY.get(key)
    if item:
        return item["label"]
    return fallback or key.removeprefix("cat_").replace("_", " ").title()


def pm_keys(equipment: str | None) -> list[str]:
    """Canonical keys a PM equipment category belongs to (a combined one maps to several)."""
    if not equipment:
        return []
    mapped = PM_EQUIPMENT_KEYS.get(equipment)
    if mapped:
        return list(mapped)
    key = canonical_key(equipment)
    return [key] if key else []


def catalogue(db: Session) -> list[dict]:
    """The built-in catalogue plus any extra active work category, de-duplicated by key."""
    items = [{"key": i["key"], "label": i["label"], "area": i["area"]} for i in CATALOGUE]
    seen = {i["key"] for i in items}
    rows = db.scalars(
        select(WorkCategory).where(WorkCategory.active.is_(True)).order_by(
            WorkCategory.sort_order, WorkCategory.name)
    )
    for row in rows:
        key = canonical_key(row.name)
        if not key or key in seen:
            continue
        seen.add(key)
        items.append({"key": key, "label": row.name, "area": getattr(row, "area", None) or "Plant side"})
    return items


# ── Who is responsible ──────────────────────────────────────────────────────
#
# Routing lookups run on every ticket creation and PM action, so the mapping is cached in
# process for a few seconds and dropped the moment it is written through this API. The cache is
# per worker, so another worker's change is picked up within the TTL; nothing here is used as an
# authorization check, where that delay would matter.

_CACHE_TTL = 15.0
_cache: dict[str, list[tuple[str, UUID]]] | None = None
_cache_at = 0.0


def invalidate_responsibility_cache() -> None:
    global _cache, _cache_at
    _cache = None
    _cache_at = 0.0


def _mapping(db: Session) -> dict[str, list[tuple[str, UUID]]]:
    global _cache, _cache_at
    now = time.monotonic()
    if _cache is not None and now - _cache_at < _CACHE_TTL:
        return _cache
    mapping: dict[str, list[tuple[str, UUID]]] = {}
    rows = db.execute(
        select(EquipmentResponsibility.equipment_key, EquipmentResponsibility.position,
               EquipmentResponsibility.user_id)
        .join(User, User.id == EquipmentResponsibility.user_id)
        .where(EquipmentResponsibility.active.is_(True), User.is_active.is_(True))
    ).all()
    for key, position, user_id in rows:
        mapping.setdefault(key, []).append((position, user_id))
    for entries in mapping.values():
        entries.sort(key=lambda e: 0 if e[0] == "primary" else 1)
    _cache, _cache_at = mapping, now
    return mapping


def responsible_user_ids(db: Session, names: list[str] | str | None, *,
                        include_backup: bool = True) -> list[UUID]:
    """The configured user ids for one or more equipment names, primaries first."""
    if names is None:
        return []
    wanted: list[str] = []
    for name in ([names] if isinstance(names, str) else names):
        for key in (pm_keys(name) if name in PM_EQUIPMENT_KEYS else [canonical_key(name)]):
            if key and key not in wanted:
                wanted.append(key)
    mapping = _mapping(db)
    out: list[UUID] = []
    for position in POSITIONS:
        if position == "backup" and not include_backup:
            continue
        for key in wanted:
            for entry_position, user_id in mapping.get(key, []):
                if entry_position == position and user_id not in out:
                    out.append(user_id)
    return out


def equipment_responsible_users(db: Session, names: list[str] | str | None, *,
                                include_backup: bool = True) -> list[User]:
    ids = responsible_user_ids(db, names, include_backup=include_backup)
    if not ids:
        return []
    found = {u.id: u for u in db.scalars(select(User).where(User.id.in_(ids), User.is_active.is_(True)))}
    return [found[i] for i in ids if i in found]


def primary_assignee(db: Session, name: str | None) -> User | None:
    """The one active primary Assignee for this equipment, or None if not configured.

    Only an active user with the Assignee role can hold a ticket, which is what the Issues
    module requires of any assignee; an O&M Head configured as primary routes notifications
    but does not become the ticket's assignee.
    """
    # Assignment is a write decision, not a notification hint: read committed ownership
    # directly instead of using a per-worker cache that can be stale after a transfer.
    key = canonical_key(name)
    if not key:
        return None
    return db.scalar(select(User).join(EquipmentResponsibility, EquipmentResponsibility.user_id == User.id)
        .where(EquipmentResponsibility.equipment_key == key,
               EquipmentResponsibility.position == "primary", EquipmentResponsibility.active.is_(True),
               User.is_active.is_(True), User.role == "Assignee").limit(1))



def user_responsibility_keys(db: Session, user_id: UUID) -> set[str]:
    """Equipment keys this user is responsible for (either position), portfolio-wide."""
    return set(db.scalars(
        select(EquipmentResponsibility.equipment_key).where(
            EquipmentResponsibility.user_id == user_id,
            EquipmentResponsibility.active.is_(True),
        )
    ))
