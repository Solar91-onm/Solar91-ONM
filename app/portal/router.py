"""Read-only portal endpoints that back the redesigned frontend.

The server enforces each route's role and plant scope. Overview is portfolio-wide
for permitted roles except Site Engineers, who remain plant-scoped.
Writes stay on the existing module APIs (issues, scheduled, washing).
"""
from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.models import Plant, User
from app.core.security import get_current_user, require_permission, user_scoped_plant_ids
from app.plants.codes import normalize_site_code
from app.portal import service

router = APIRouter(prefix="/api/portal", tags=["Portal"])

DB = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]
OverviewUser = Annotated[User, Depends(require_permission("plants.view"))]


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
    """Every plant the user may see, with its full stored record (one query for plants and people)."""
    return {"plants": [
        service.plant_out(plant, engineers, washer)
        for plant, engineers, washer in service.visible_plants_with_people(db, user)
    ]}


@router.get("/overview")
def overview(db: DB, user: OverviewUser):
    """Portfolio rows, except Site Engineers receive only their assigned plant."""
    return service.portfolio(db, user)


@router.get("/overview/range")
def overview_range(
    db: DB,
    user: OverviewUser,
    start_date: date = Query(...),
    end_date: date = Query(...),
):
    """Date-bounded Overview metrics, with Site Engineers restricted to assigned plants."""
    if start_date > end_date:
        raise HTTPException(422, "Start date must be on or before end date.")
    if end_date > service.business_today():
        raise HTTPException(422, "End date cannot be in the future.")
    if (end_date - start_date).days > 3660:
        raise HTTPException(422, "Overview date ranges cannot exceed 10 years.")
    return service.portfolio_for_range(db, user, start_date, end_date)


@router.get("/overview/trend")
def overview_trend(
    db: DB,
    user: OverviewUser,
    start_date: date = Query(...),
    end_date: date = Query(...),
    site_code: list[str] | None = Query(default=None),
):
    """Date-bucketed operational trend, restricted to the Overview plant scope."""
    if start_date > end_date:
        raise HTTPException(422, "Start date must be on or before end date.")
    if end_date > service.business_today():
        raise HTTPException(422, "End date cannot be in the future.")
    if (end_date - start_date).days > 3660:
        raise HTTPException(422, "Overview trend ranges cannot exceed 10 years.")

    plants = service.overview_plants(db, user)
    if site_code is not None:
        requested = {normalize_site_code(code) for code in site_code}
        selected = [plant for plant in plants if plant.site_code in requested]
        if not requested or len(selected) != len(requested):
            raise HTTPException(404, "Plant not found")
        plant_ids = [plant.id for plant in selected]
    else:
        plant_ids = [plant.id for plant in plants]
    return service.portfolio_trend(db, plant_ids, start_date, end_date)


@router.get("/plants/{site_code}")
def plant_details(site_code: str, db: DB, user: CurrentUser):
    """One plant: stored record, operational profile and recent activity."""
    plant = _plant_or_404(db, user, site_code)
    today = service.business_today()
    issues = service._issue_counts(db, [plant.id]).get(plant.id)
    pm = service._pm_counts(db, [plant.id], today).get(plant.id)
    washing_rows = service._washing_rows(db, user, [plant.id])
    washing = (washing_rows or {}).get(str(plant.id))
    last_at = service._last_activity(db, [plant.id]).get(plant.id)
    engineers = service.site_engineers_by_plant(db, [plant.id]).get(plant.id, [])
    washer = service.washing_assignees_by_plant(db, [plant.id]).get(plant.id, "")
    return {
        "plant": service.plant_out(plant, engineers, washer),
        "profile": service.build_profile(plant, issues, pm, washing, last_at),
        "activity": service.activity(db, user, [plant.id], limit=10),
        "issueTotal": (issues or {}).get("total", 0),
        "pmCancelled": (pm or {}).get("cancelled", 0),
        "warnings": ["washing_unavailable"] if washing_rows is None else [],
    }


@router.get("/plants/{site_code}/operational")
def plant_operational(site_code: str, db: DB, user: CurrentUser):
    plant = _plant_or_404(db, user, site_code)
    today = service.business_today()
    return service.build_profile(
        plant,
        service._issue_counts(db, [plant.id]).get(plant.id),
        service._pm_counts(db, [plant.id], today).get(plant.id),
        (service._washing_rows(db, user, [plant.id]) or {}).get(str(plant.id)),
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
        page = service.calendar_page(db, user, kind, month, ids)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    # "truncated": the month has more entries than were sent; the UI says so instead of showing a partial month as whole.
    return {"kind": kind, "month": month, **page}
