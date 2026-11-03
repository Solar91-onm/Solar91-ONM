"""Asset & Warranty: the plant's equipment, parts and their warranty / certification dates.

Read endpoints are open to anyone who can see the plant; writing follows ``plants.manage``, the same
permission that governs the plant record the equipment belongs to.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Response, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.models import AssetWarranty, Plant, User
from app.core.security import get_current_user, require_csrf, require_permission
from app.warranty import sheets

router = APIRouter(prefix="/api/asset-warranty", tags=["Asset & Warranty"])

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
NO_STORE = {"Cache-Control": "private, no-store"}


@router.get("")
def list_records(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
                 site_code: str | None = None, limit: int = 500):
    """Records for one plant, or for every plant in the caller's scope."""
    limit = max(1, min(int(limit), sheets.MAX_EXPORT_ROWS))
    if site_code:
        plants = {p.id: p for p in [sheets._plant_for_code(db, user, site_code)]}
    else:
        plants = {p.id: p for p in sheets._visible_plants(db, user)}
    if not plants:
        return {"records": [], "total": 0}
    rows = list(db.scalars(
        select(AssetWarranty)
        .where(AssetWarranty.plant_id.in_(list(plants)))
        .order_by(AssetWarranty.equipment, AssetWarranty.part)
        .limit(limit)
    ))
    return {
        "records": [{
            "id": str(row.id),
            "siteCode": plants[row.plant_id].site_code,
            "plantName": plants[row.plant_id].plant_name,
            "equipment": row.equipment,
            "part": row.part,
            "partNumber": row.part_number,
            "make": row.make,
            "serialNo": row.serial_no,
            "quantity": row.quantity,
            "warrantyStart": row.warranty_start.isoformat() if row.warranty_start else None,
            "warrantyEnd": row.warranty_end.isoformat() if row.warranty_end else None,
            "certificationDate": row.certification_date.isoformat() if row.certification_date else None,
            "certificationExpiry": row.certification_expiry.isoformat() if row.certification_expiry else None,
            # Always null today: the certificate service is not connected yet.
            "certificationFile": row.certification_file,
            "remarks": row.remarks,
        } for row in rows],
        "total": len(rows),
    }


@router.get("/import/template")
def import_template(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
                    site_code: str | None = None):
    return Response(content=sheets.template_bytes(db, user, site_code=site_code), media_type=XLSX_MEDIA_TYPE,
                    headers={"Content-Disposition": 'attachment; filename="Asset_Warranty_Template.xlsx"', **NO_STORE})


@router.get("/export")
def export_records(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
                   site_code: str | None = None):
    return Response(content=sheets.export_bytes(db, user, site_code=site_code), media_type=XLSX_MEDIA_TYPE,
                    headers={"Content-Disposition": 'attachment; filename="Asset_Warranty_Register.xlsx"', **NO_STORE})


@router.post("/import", dependencies=[Depends(require_csrf)])
async def import_records(db: Annotated[Session, Depends(get_db)],
                         user: Annotated[User, Depends(require_permission("plants.manage"))],
                         file: UploadFile = File(...), dry_run: bool = True):
    content = await file.read()
    return sheets.import_rows(db, user, file.filename or "", content, dry_run=dry_run)
