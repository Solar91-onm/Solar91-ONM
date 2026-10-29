from __future__ import annotations

from typing import Annotated
from uuid import UUID
import re

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.service import upsert_user_for_claims, verify_session_token
from app.core.database import get_db
from app.core.models import Equipment, Plant, User, UserEquipmentTypeAssignment, UserPlantAssignment


def _session_token(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None


def get_current_user(request: Request, db: Annotated[Session, Depends(get_db)]) -> User:
    token = _session_token(request)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    claims = verify_session_token(token)
    return upsert_user_for_claims(db, claims, access_token=token)


def require_write_auth(request: Request, user: Annotated[User, Depends(get_current_user)]) -> None:
    """Require an explicit authenticated bearer token for state-changing requests.

    Read-only requests may use the provider's session cookie, but mutations must arrive through
    a valid authenticated API request so ambient browser cookies or stale client state cannot
    create a cross-site write path.
    """
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer ") or not auth.split(" ", 1)[1].strip():
        raise HTTPException(status_code=403, detail="Mutating requests require an authenticated bearer token")
    return None


require_csrf = require_write_auth

ROLE_PERMISSIONS: dict[str, set[str]] = {
    "O&M Head": {
        "plants.view", "plants.manage", "issues.view", "issues.create", "issues.progress", "issues.resolve",
        "issues.manage", "issues.close", "handover.manage", "tasks.view", "tasks.create", "tasks.execute",
        "tasks.manage", "washing.manage", "services.manage", "documents.view", "users.manage", "audit.view",
        "reports.view", "performance.view", "services.view",
    },
    # Assignee = Solar91 O&M team member, scoped to assigned registered equipment across plants.
    "Assignee": {
        "plants.view", "issues.view", "issues.create", "issues.progress", "issues.resolve",
        "tasks.view", "tasks.create", "tasks.execute", "washing.log", "handover.execute", "documents.view",
        "services.view",
    },
    # Administration is a read-only Command Center and Reports role.
    "Administration": {"plants.view", "issues.view", "tasks.view", "reports.view"},
    # Exactly one assigned plant; no fleet-wide modules.
    "Site Engineer": {"plants.view", "issues.view", "issues.create", "tasks.view", "tasks.execute", "washing.log"},
    # New Clerk-authenticated users wait here until an O&M Head assigns one of the four operational roles.
    "Viewer": set(),
}


def require_permission(permission: str):
    def dependency(user: Annotated[User, Depends(get_current_user)]) -> User:
        permissions = ROLE_PERMISSIONS.get(user.role, set())
        if permission in permissions:
            return user
        raise HTTPException(status_code=403, detail=f"Permission required: {permission}")
    return dependency


def is_head(user: User) -> bool:
    return user.role == "O&M Head"


def has_portfolio_scope(user: User) -> bool:
    return user.role in {"O&M Head", "Administration"}


def _identity_values(user: User) -> list[str]:
    values = [user.display_name]
    if user.email:
        values.append(user.email)
    return [v.strip().lower() for v in values if v and v.strip()]


WASHING_TYPE = "Modules cleaning"
# Mirrors VERTICALS in frontend/static/js/00-auth-data-and-imports.js
EQUIPMENT_TYPES = [
    "Inverter", "Module", "Transformer", "Aux. Transformer", "VCB Panel", "VCB-Kiosk", "ACCB Panel",
    "Switchyard - Plant side", "Switchyard - GSS side", "Transmission line", "RMS", "WMS", "CCTV",
    "Boundary wall", "String", "Earthing", "LA", "Water pipe line", "Vegetation", "Modules cleaning",
    "ABT meters", "Street Light", "MMS", "Other",
    "MCCB", "OLTC(RTCC)", "4 Pole", "VCB - GSS side",   # PM scope additions (Plant Side / GSS Side)
    "4 Pole - GSS side", "Transmission line - GSS side",   # GSS side of the 30-day PM cycle
    "Miscellaneous",   # Plant side PM job for Street Light, ERT, ... (one job per plant)
    "ACDB",            # Plant side, shares the Aux. Transformer days (one job per plant)
]


def _norm_type(value: str | None) -> str:
    return (value or "").strip().casefold()


def user_scoped_equipment_types(db: Session, user: User) -> set[str] | None:
    """Equipment types an Assignee is responsible for (None = portfolio roles, empty = nothing)."""
    if has_portfolio_scope(user):
        return None
    if user.role != "Assignee":
        return set()
    return {_norm_type(t) for t in db.scalars(
        select(UserEquipmentTypeAssignment.equipment_type).where(UserEquipmentTypeAssignment.user_id == user.id)
    ) if _norm_type(t)}


def assignee_has_type(db: Session, user: User, vertical: str | None) -> bool:
    types = user_scoped_equipment_types(db, user) or set()
    return bool(types) and _norm_type(vertical) in types


def user_scoped_plant_ids(db: Session, user: User) -> set[UUID] | None:
    """Return plants visible to a role.

    An Assignee owns equipment types across ALL plants, so any assigned type exposes every plant.
    Site Engineer is a deliberately strict special case: zero assignments is a pending-access
    state, while more than one assignment is a configuration error. A plant's free-text
    ``assigned_engineer`` field is never treated as an authorization boundary.
    """
    if has_portfolio_scope(user):
        return None
    if user.role == "Assignee":
        if not user_scoped_equipment_types(db, user):
            return set()
        return set(db.scalars(select(Plant.id)))
    explicit = set(
        db.scalars(
            select(UserPlantAssignment.plant_id).where(
                UserPlantAssignment.user_id == user.id
            )
        )
    )
    if user.role == "Site Engineer" and len(explicit) > 1:
        raise HTTPException(
            status_code=403,
            detail="Site Engineer account must be assigned to exactly one plant",
        )
    return explicit


def user_scoped_equipment_ids(db: Session, user: User) -> set[UUID] | None:
    """Registered equipment (if any) whose type an Assignee owns; None for portfolio roles."""
    if has_portfolio_scope(user):
        return None
    if user.role != "Assignee":
        return set()
    types = user_scoped_equipment_types(db, user) or set()
    if not types:
        return set()
    return set(db.scalars(
        select(Equipment.id).where(
            func.lower(func.trim(func.coalesce(Equipment.equipment_type, ""))).in_(types),
            Equipment.status != "inactive",
        )
    ))


def equipment_scope_matches(
    db: Session, user: User, plant_id: UUID | None, equipment_id: UUID | None, equipment_ref: str | None,
    vertical: str | None = None,
) -> bool:
    """Does a record belong to an Assignee's equipment types?

    The record's own type (issue vertical / task asset) decides. If it carries none, fall back
    to the type of the registered equipment it points at, when there is one.
    """
    if user.role != "Assignee":
        return False
    types = user_scoped_equipment_types(db, user) or set()
    if not types:
        return False
    if _norm_type(vertical):
        return _norm_type(vertical) in types
    eq_id = resolve_equipment_id(db, plant_id, equipment_id, equipment_ref)
    if eq_id is None:
        return False
    eq = db.get(Equipment, eq_id)
    return bool(eq) and _norm_type(eq.equipment_type) in types


def resolve_equipment_id(
    db: Session, plant_id: UUID | None, equipment_id: UUID | None, equipment_ref: str | None
) -> UUID | None:
    if equipment_id is not None:
        equipment = db.get(Equipment, equipment_id)
        if equipment and equipment.status != "inactive" and (plant_id is None or equipment.plant_id == plant_id):
            return equipment.id
    reference = (equipment_ref or "").strip().casefold()
    if not reference or plant_id is None:
        return None
    try:
        equipment = db.get(Equipment, UUID(reference))
    except ValueError:
        equipment = None
    if equipment and equipment.status != "inactive" and equipment.plant_id == plant_id:
        return equipment.id
    code_matches = list(db.scalars(
        select(Equipment.id).where(
            Equipment.plant_id == plant_id,
            Equipment.status != "inactive",
            func.lower(Equipment.equipment_code) == reference,
        )
    ))
    if code_matches:
        return code_matches[0] if len(code_matches) == 1 else None
    name_matches = list(db.scalars(
        select(Equipment.id).where(
            Equipment.plant_id == plant_id,
            Equipment.status != "inactive",
            func.lower(Equipment.equipment_name) == reference,
        )
    ))
    return name_matches[0] if len(name_matches) == 1 else None


def ensure_equipment_scope(
    db: Session, user: User, plant_id: UUID | None, equipment_id: UUID | None, equipment_ref: str | None,
    vertical: str | None = None,
) -> None:
    if has_portfolio_scope(user):
        return
    if not equipment_scope_matches(db, user, plant_id, equipment_id, equipment_ref, vertical):
        raise HTTPException(status_code=403, detail="This equipment type is outside your assigned scope")


def user_equipment_matches_record(
    db: Session, user: User, plant_id: UUID | None, equipment_id: UUID | None, equipment_ref: str | None
) -> bool:
    """Check access to a registered asset while preserving portfolio and plant roles."""
    if user.role == "Assignee":
        return equipment_scope_matches(db, user, plant_id, equipment_id, equipment_ref)
    if user.role == "Site Engineer":
        return plant_id is not None and plant_id in (user_scoped_plant_ids(db, user) or set())
    return has_portfolio_scope(user)

ROLE_MODULES: dict[str, list[str]] = {
    "O&M Head": ["Command Center", "Plants", "Site Issues", "Preventive Maintenance", "Work / Assignments",
                 "Performance", "Reports", "Data / Imports", "Settings", "Project Handover", "Extra Services",
                 "Notifications", "Operations Calendar", "My Profile"],
    "Assignee": ["Command Center", "Plants", "Site Issues", "Preventive Maintenance", "Work / Assignments",
                 "Project Handover", "Extra Services", "Notifications", "Operations Calendar", "My Profile"],
    "Administration": ["Command Center", "Reports", "Operations Calendar"],
    "Site Engineer": ["Command Center", "My Plant", "Site Issues", "Preventive Maintenance", "Notifications", "Operations Calendar", "My Profile"],
    "Viewer": ["Notifications", "My Profile"],
}


_ASSIGNEE_SPLIT = re.compile(r"[;,/&|]|\band\b")


def text_is_current_user(value: str | None, user: User) -> bool:
    """Does a free-text assignee field refer to this user?

    Names must match a whole entry (the field may list several people separated by , ; / & |).
    The old substring test let a user called "Ravi" match "Ravi Kumar" and see their tickets.
    An e-mail address is unique, so it may still appear anywhere in the text.
    """
    if not value:
        return False
    hay = value.strip().lower()
    entries = {part.strip() for part in _ASSIGNEE_SPLIT.split(hay) if part.strip()} | {hay}
    name = (user.display_name or "").strip().lower()
    email = (user.email or "").strip().lower()
    if email and (email in entries or email in hay):
        return True
    return bool(name and name in entries)


def ensure_plant_scope(db: Session, user: User, plant_id: UUID | None) -> None:
    if has_portfolio_scope(user):
        return
    allowed = user_scoped_plant_ids(db, user) or set()
    if plant_id is None or plant_id not in allowed:
        raise HTTPException(status_code=403, detail="This plant is outside your assigned scope")
