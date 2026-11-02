"""Read-only portal endpoints that back the redesigned frontend.

All routes require a signed-in user and are scoped server-side by
``user_scoped_plant_ids``; the browser never decides which plants it may see.
Writes stay on the existing module APIs (issues, scheduled, washing).
"""
from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.models import Plant, User
from app.core.security import get_current_user, user_scoped_plant_ids
from app.plants.codes import normalize_site_code
from app.portal import service

router = APIRouter(prefix="/api/portal", tags=["Portal"])

DB = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


def _plant_or_404(db: Session, user: User, site_code: str) -> Plant:
    """Resolve a site code inside the caller's scope. Out-of-scope reads as not found."""
    code = normalize_site_code(site_code)
    plant = db.query(Plant).filter(Plant.site_code == code).one_or_none() if code else None
    if plant is None:
        raise HTTPException(404, "Plant not found")
    allowed = user_scoped_plant_ids(db, user)
    if allowed is not None and plant.id not in allowed:
        raise HTTPException(404, "Plant not found")
    return plant


@router.get("/plants")
def list_plants(db: DB, user: CurrentUser):
    """Every plant the user may see, with its full stored record."""
    plants = service.visible_plants(db, user)
    ids = [p.id for p in plants]
    engineers = service.site_engineers_by_plant(db, ids)
    washers = service.washing_assignees_by_plant(db, ids)
    return {"plants": [service.plant_out(p, engineers.get(p.id, []), washers.get(p.id, "")) for p in plants]}


@router.get("/overview")
def overview(db: DB, user: CurrentUser):
    """Portfolio rows (plant + operational profile) and totals in one response."""
    return service.portfolio(db, user)


@router.get("/overview/range")
def overview_range(
    db: DB,
    user: CurrentUser,
    start_date: date = Query(...),
    end_date: date = Query(...),
):
    """Date-bounded portfolio metrics for Overview's quick periods and custom range."""
    if start_date > end_date:
        raise HTTPException(422, "Start date must be on or before end date.")
    if end_date > service.business_today():
        raise HTTPException(422, "End date cannot be in the future.")
    if (end_date - start_date).days > 3660:
        raise HTTPException(422, "Overview date ranges cannot exceed 10 years.")
    return service.portfolio_for_range(db, user, start_date, end_date)


@router.get("/plants/{site_code}")
def plant_details(site_code: str, db: DB, user: CurrentUser):
    """One plant: stored record, operational profile and recent activity."""
    plant = _plant_or_404(db, user, site_code)
    today = service.business_today()
    issues = service._issue_counts(db, [plant.id]).get(plant.id)
    pm = service._pm_counts(db, [plant.id], today).get(plant.id)
    washing = service._washing_rows(db, user).get(str(plant.id))
    last_at = service._last_activity(db, [plant.id]).get(plant.id)
    engineers = service.site_engineers_by_plant(db, [plant.id]).get(plant.id, [])
    washer = service.washing_assignees_by_plant(db, [plant.id]).get(plant.id, "")
    return {
        "plant": service.plant_out(plant, engineers, washer),
        "profile": service.build_profile(plant, issues, pm, washing, last_at),
        "activity": service.activity(db, user, [plant.id], limit=10),
        "issueTotal": (issues or {}).get("total", 0),
        "pmCancelled": (pm or {}).get("cancelled", 0),
    }


@router.get("/plants/{site_code}/operational")
def plant_operational(site_code: str, db: DB, user: CurrentUser):
    plant = _plant_or_404(db, user, site_code)
    today = service.business_today()
    return service.build_profile(
        plant,
        service._issue_counts(db, [plant.id]).get(plant.id),
        service._pm_counts(db, [plant.id], today).get(plant.id),
        service._washing_rows(db, user).get(str(plant.id)),
        service._last_activity(db, [plant.id]).get(plant.id),
    )


@router.get("/activity")
def portfolio_activity(db: DB, user: CurrentUser, limit: int = Query(25, ge=1, le=100),
                       site_code: str | None = None):
    if site_code:
        ids = [_plant_or_404(db, user, site_code).id]
    else:
        ids = [p.id for p in service.visible_plants(db, user)]
    return {"activity": service.activity(db, user, ids, limit=limit)}


@router.get("/calendar")
def calendar(db: DB, user: CurrentUser,
             kind: str = Query(..., pattern="^(pm|washing)$"),
             month: str = Query(..., pattern=r"^\d{4}-\d{2}$"),
             site_code: str | None = None):
    if site_code:
        ids = [_plant_or_404(db, user, site_code).id]
    else:
        ids = [p.id for p in service.visible_plants(db, user)]
    try:
        entries = service.calendar(db, user, kind, month, ids)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"kind": kind, "month": month, "entries": entries}
