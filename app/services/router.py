from __future__ import annotations

from typing import Annotated, Type

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.models import (
    Document, Incident, InventoryItem, Permit, SLAContract, ServiceRequest, User, Vendor,
)
from app.core.security import require_permission, user_scoped_plant_ids

router = APIRouter(prefix="/api", tags=["Extra Services"])

def payload(x):
    return dict(x.payload or {})

def rows(db, model: Type, limit: int, user: User):
    stmt = select(model)
    scope = user_scoped_plant_ids(db, user)
    if scope is not None and hasattr(model, "plant_id"):
        if not scope:
            return []
        stmt = stmt.where(model.plant_id.in_(scope))
    return list(db.scalars(stmt.order_by(model.created_at.desc()).limit(limit)))

@router.get("/inventory")
def inventory(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("services.view"))],
    limit: int = Query(100, le=500),
):
    return [payload(x) for x in rows(db, InventoryItem, limit, user)]

@router.get("/permits")
def permits(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("services.view"))],
    limit: int = Query(100, le=500),
):
    return [payload(x) for x in rows(db, Permit, limit, user)]

@router.get("/incidents")
def incidents(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("services.view"))],
    limit: int = Query(100, le=500),
):
    return [payload(x) for x in rows(db, Incident, limit, user)]

@router.get("/documents")
def documents(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("services.view"))],
    limit: int = Query(100, le=500),
):
    return [payload(x) for x in rows(db, Document, limit, user)]

@router.get("/vendors")
def vendors(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("services.manage"))],
    limit: int = Query(100, le=500),
):
    return [payload(x) for x in list(db.scalars(select(Vendor).order_by(Vendor.created_at.desc()).limit(limit)))]

@router.get("/service-requests")
def service_requests(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("services.view"))],
    limit: int = Query(100, le=500),
):
    return [payload(x) for x in rows(db, ServiceRequest, limit, user)]

@router.get("/sla")
def sla(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(require_permission("services.view"))],
    limit: int = Query(100, le=500),
):
    return [payload(x) for x in rows(db, SLAContract, limit, user)]
