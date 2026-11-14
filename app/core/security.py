from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID
import re

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.service import upsert_user_for_claims, verify_session_token
from app.core.database import get_db
from app.core.models import User, UserPlantAssignment


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
    # Assignee = Solar91 O&M team member, scoped to their assigned plants.
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


# Plant custom_fields that hold document links (Design/MDL folder, Liasoning documents): only these roles receive them.
DESIGN_LINK_ROLES = {"O&M Head", "Assignee", "Administration"}
DESIGN_LINK_KEY = "design_link"
LIASONING_KEY = "liasoning"
RESTRICTED_CUSTOM_FIELDS = (DESIGN_LINK_KEY, LIASONING_KEY)
SECURITY_CONTACT_KEYS = ("security_guard", "security_contacts")
SECURITY_CONTACT_ROLES = {"O&M Head", "Administration"}


def can_view_design_link(user: User | None) -> bool:
    return bool(user is not None and user.is_active and user.role in DESIGN_LINK_ROLES)


def visible_custom_fields(fields: dict[str, Any] | None, user: User | None) -> dict[str, Any]:
    """Return plant fields redacted for roles that cannot view restricted contacts or links.

    Always returns a new dict, so the ORM object's stored value is never changed by redaction.
    """
    out = dict(fields or {})
    if not can_view_design_link(user):
        for key in RESTRICTED_CUSTOM_FIELDS:
            out.pop(key, None)
    if user is None or not user.is_active or user.role not in SECURITY_CONTACT_ROLES:
        for key in SECURITY_CONTACT_KEYS:
            out.pop(key, None)
    return out


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

# The work-category taxonomy. These are the categories a Site Issue is raised
# against (``issues.vertical``) and the sections a Preventive Maintenance cycle
# is planned in (``pm_templates.equipment_type``, ``pm_unit_config.equipment_type``,
# ``om_tasks.task_type``). They are plain strings and are NOT an asset register:
# the per-asset register (makers, serial numbers, warranties) was removed, and
# these categories are what remains of the taxonomy.
def _norm_type(value: str | None) -> str:
    return (value or "").strip().casefold()


# The work-category taxonomy now lives in the ``work_categories`` table, not in code.
#
# It is the list a Site Issue is raised against (``issues.vertical``) and the
# sections a Preventive Maintenance cycle is planned in (``pm_templates.equipment_type``,
# ``pm_unit_config.equipment_type``, ``om_tasks.task_type``).
#
# The table ships EMPTY. The previous hard-coded list of 32 entries was incomplete and
# inconsistent, so it was removed with the asset register. Fill the table either in
# Supabase directly or from the portal (Settings -> Categories, which any O&M Head or
# Assignee can edit) and every category dropdown picks it up with no code change.
#
# `work_categories()` reads it; call it instead of importing a constant, so a category
# added a moment ago is visible on the next request.
def work_categories(db: Session, *, include_inactive: bool = False) -> list[str]:
    """Every configured work category, in display order. Empty until the table is filled."""
    from app.core.models import WorkCategory

    stmt = select(WorkCategory.name).order_by(WorkCategory.sort_order, WorkCategory.name)
    if not include_inactive:
        stmt = stmt.where(WorkCategory.active.is_(True))
    return list(db.scalars(stmt))


def is_work_category(db: Session, value: str | None) -> bool:
    """Is this a configured category? Matching ignores case and surrounding spaces."""
    needle = _norm_type(value)
    return bool(needle) and needle in {_norm_type(name) for name in work_categories(db)}




def user_scoped_plant_ids(db: Session, user: User) -> set[UUID] | None:
    """Plants visible to a role. ``None`` means the whole portfolio.

    Scope is plant-based for every non-portfolio role, resolved only from the
    ``user_plant_assignments`` table. A plant's free-text ``assigned_engineer``
    field is never treated as an authorization boundary.

    * **Assignee** — one or more assigned plants. An Assignee with no assignment
      sees nothing (a pending-access state), never the whole fleet.
    * **Site Engineer** — deliberately strict: exactly one plant. Zero is a
      pending-access state and more than one is a configuration error.

    Before the asset register was removed, an Assignee's scope came from
    assigned equipment *types* and therefore spanned every plant. Scope is now
    explicit, so an Assignee must be given the plants they are responsible for.
    """
    if has_portfolio_scope(user):
        return None
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


def plant_scope_matches(db: Session, user: User, plant_id: UUID | None) -> bool:
    """Does a record's plant fall inside this user's scope?"""
    if has_portfolio_scope(user):
        return True
    if plant_id is None:
        return False
    return plant_id in (user_scoped_plant_ids(db, user) or set())


ROLE_MODULES: dict[str, list[str]] = {
    "O&M Head": ["Command Center", "Plants", "Site Issues", "Preventive Maintenance", "Work / Assignments",
                 "Data / Imports", "Settings", "Project Handover", "Extra Services",
                 "Notifications", "Operations Calendar", "My Profile"],
    "Assignee": ["Command Center", "Plants", "Site Issues", "Preventive Maintenance", "Work / Assignments",
                 "Project Handover", "Extra Services", "Notifications", "Operations Calendar", "My Profile"],
    "Administration": ["Command Center", "Operations Calendar"],
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
