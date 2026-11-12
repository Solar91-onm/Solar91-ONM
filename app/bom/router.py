"""Bill of Materials: the parts inventory of every plant (item, maker/supplier, quantity, specs, ...).

Reading follows plant scope (same helpers as Asset & Warranty and Movable Assets). Writing needs
``plants.manage``. Lines are paged and filtered on the server so the portfolio view never loads the
whole table. Each line carries a ``version``; an update sent with an old version is refused (409)
instead of silently overwriting someone else's save.
"""
from __future__ import annotations

import re
import uuid
from decimal import Decimal
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, nulls_last, or_, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.models import AuditLog, BomItem, Plant, User
from app.core.security import get_current_user, require_csrf, require_permission
from app.plants.scope import plant_for_code, visible_plants

router = APIRouter(prefix="/api/bom", tags=["BOM"])

MAX_PAGE = 500
MAX_QUANTITY = 1_000_000
MAX_LINES_PER_PLANT = 2000
MAX_ITEM_NAME = 400          # a BOQ description runs long; migration 040 made the column text
MAX_SORT_ORDER = 1_000_000   # BOQ line order, not a quantity


def _text(value: str | None, limit: int, label: str, required: bool = False) -> str | None:
    clean = re.sub(r"[ \t]+", " ", str(value or "")).strip()
    if not clean:
        if required:
            raise HTTPException(422, f"{label} is required")
        return None
    if len(clean) > limit:
        raise HTTPException(422, f"{label} must be {limit} characters or fewer")
    return clean


def _number(value: Decimal | int | float | None) -> int | float | None:
    """A NUMERIC(14,3) quantity as a plain JSON number: 5368.23, 7180.8, 12 -- never "12.000"."""
    if value is None:
        return None
    amount = Decimal(str(value))
    return int(amount) if amount == amount.to_integral_value() else float(amount)


def _url(value: str | None) -> str | None:
    """An external invoice link: http(s) only (never javascript: or data:), no spaces, max 1000 chars."""
    clean = str(value or "").strip()
    if not clean:
        return None
    parts = urlsplit(clean)
    if len(clean) > 1000 or re.search(r"\s", clean) or parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        raise HTTPException(422, "Invoice link must be a full web address starting with http:// or https://")
    return clean


class BomIn(BaseModel):
    item_name: str
    maker_supplier: str | None = None
    # A BOQ quantity is fractional (5368.23 kWp, 7180.8 Mtrs), stored as NUMERIC(14,3).
    quantity: Decimal | None = Field(default=None, ge=0, le=MAX_QUANTITY, decimal_places=3, max_digits=14)
    unit: str | None = None
    section: str | None = None
    sort_order: int | None = Field(default=None, ge=0, le=MAX_SORT_ORDER)
    specs: str | None = None
    test_report: str | None = None
    warranty_cert: str | None = None
    serial_no: str | None = None
    invoice: str | None = None
    invoice_url: str | None = None


class BomCreate(BomIn):
    site_code: str = Field(min_length=1, max_length=40)


class BomUpdate(BomIn):
    version: int = Field(ge=1)


def _clean(body: BomIn) -> dict:
    specs = str(body.specs or "").strip()
    if len(specs) > 2000:
        raise HTTPException(422, "Specs must be 2000 characters or fewer")
    return {
        "item_name": _text(body.item_name, MAX_ITEM_NAME, "Item name", required=True),
        "maker_supplier": _text(body.maker_supplier, 160, "Maker/Supplier"),
        "quantity": None if body.quantity is None else body.quantity.quantize(Decimal("0.001")),
        "unit": _text(body.unit, 24, "Unit"),
        "section": _text(body.section, 160, "Section"),
        "sort_order": body.sort_order,
        "specs": specs or None,
        "test_report": _text(body.test_report, 200, "T.R."),
        "warranty_cert": _text(body.warranty_cert, 200, "W.C."),
        "serial_no": _text(body.serial_no, 120, "Item serial no."),
        "invoice": _text(body.invoice, 200, "Invoice"),
        "invoice_url": _url(body.invoice_url),
    }


def _out(row: BomItem, plant: Plant) -> dict:
    return {
        "id": str(row.id), "siteCode": plant.site_code, "itemName": row.item_name,
        "makerSupplier": row.maker_supplier, "quantity": _number(row.quantity), "unit": row.unit,
        "section": row.section, "sortOrder": row.sort_order, "specs": row.specs,
        "testReport": row.test_report, "warrantyCert": row.warranty_cert,
        "serialNo": row.serial_no, "invoice": row.invoice, "invoiceUrl": row.invoice_url, "version": row.row_version,
    }


def _log(value):
    """Audit metadata is stored as JSON: a Decimal quantity goes in as a number, not a Decimal."""
    return _number(value) if isinstance(value, Decimal) else value


def _like(term: str) -> str:
    return "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@router.get("")
def list_items(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
               site_code: str | None = None, spv: str | None = None, maker: str | None = None,
               section: str | None = None, q: str | None = None, limit: int = 200, offset: int = 0):
    """Lines in the caller's scope, filtered and paged. ``total`` counts every match, not just this page.

    Lines come back in BOQ order -- section, then the sheet's line order, then item name -- so the
    page can render them exactly as received. Lines with no section or no line order sort last.
    """
    limit = max(1, min(limit, MAX_PAGE))
    offset = max(0, offset)
    plants = [plant_for_code(db, user, site_code)] if site_code else visible_plants(db, user)
    if spv:
        plants = [p for p in plants if (p.project_company or "") == spv]
    by_id = {p.id: p for p in plants}
    if not by_id:
        return {"items": [], "total": 0, "makers": [], "sections": [], "limit": limit, "offset": offset}
    ids = list(by_id)
    where = [BomItem.plant_id.in_(ids)]
    # Makers and sections offered in the filters come from the plants in scope, before the
    # maker/section/search filters apply, so choosing one never empties the other list.
    makers = sorted({m for (m,) in db.execute(
        select(BomItem.maker_supplier).where(*where, BomItem.maker_supplier.is_not(None)).distinct())},
        key=str.lower)[:300]
    sections = sorted({x for (x,) in db.execute(
        select(BomItem.section).where(*where, BomItem.section.is_not(None)).distinct())},
        key=str.lower)[:300]
    if maker:
        where.append(func.lower(BomItem.maker_supplier) == maker.strip().lower())
    if section:
        where.append(func.lower(BomItem.section) == section.strip().lower())
    term = (q or "").strip()[:100]
    if term:
        pattern = _like(term.lower())
        where.append(or_(*[func.lower(col).like(pattern, escape="\\") for col in (
            BomItem.item_name, BomItem.maker_supplier, BomItem.specs, BomItem.serial_no,
            BomItem.invoice, BomItem.test_report, BomItem.warranty_cert)]))
    total = db.scalar(select(func.count()).select_from(BomItem).where(*where)) or 0
    rows = list(db.scalars(select(BomItem).where(*where).order_by(
        # The raw section column, not lower(section), so ix_bom_items_plant_section_order can serve this.
        nulls_last(BomItem.section), nulls_last(BomItem.sort_order),
        func.lower(BomItem.item_name), BomItem.created_at, BomItem.id).limit(limit).offset(offset)))
    return {"items": [_out(r, by_id[r.plant_id]) for r in rows], "total": total, "makers": makers,
            "sections": sections, "limit": limit, "offset": offset}


@router.post("", status_code=201, dependencies=[Depends(require_csrf)])
def add_item(body: BomCreate, db: Annotated[Session, Depends(get_db)],
             user: Annotated[User, Depends(require_permission("plants.manage"))]):
    plant = plant_for_code(db, user, body.site_code)
    count = db.scalar(select(func.count()).select_from(BomItem).where(BomItem.plant_id == plant.id)) or 0
    if count >= MAX_LINES_PER_PLANT:
        raise HTTPException(422, f"A plant can hold at most {MAX_LINES_PER_PLANT} BOM lines")
    values = _clean(body)
    row = BomItem(plant_id=plant.id, updated_by=user.id, row_version=1, **values)
    db.add(row)
    db.flush()
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Added BOM item", module="BOM",
                    metadata_json={"site_code": plant.site_code, "item": values["item_name"], "id": str(row.id)}))
    db.commit()
    return _out(row, plant)


def _owned(db: Session, user: User, item_id: str) -> tuple[BomItem, Plant]:
    try:
        row = db.get(BomItem, uuid.UUID(str(item_id)))
    except ValueError:  # malformed id
        row = None
    if row is None:
        raise HTTPException(404, "BOM line not found")
    plant = db.get(Plant, row.plant_id)
    # Re-checks plant scope: a line outside the caller's plants answers 404 like a missing one.
    plant_for_code(db, user, plant.site_code)
    return row, plant


@router.put("/{item_id}", dependencies=[Depends(require_csrf)])
def update_item(item_id: str, body: BomUpdate, db: Annotated[Session, Depends(get_db)],
                user: Annotated[User, Depends(require_permission("plants.manage"))]):
    row, plant = _owned(db, user, item_id)
    if body.version != row.row_version:
        raise HTTPException(409, "This line was changed by someone else. Reload the page and try again.")
    values = _clean(body)
    changes = {k: {"from": _log(getattr(row, k)), "to": _log(v)} for k, v in values.items() if getattr(row, k) != v}
    if changes:
        for key, value in values.items():
            setattr(row, key, value)
        row.row_version += 1
        row.updated_by = user.id
        db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Updated BOM item", module="BOM",
                        metadata_json={"site_code": plant.site_code, "id": str(row.id), "changes": changes}))
        db.commit()
    return _out(row, plant)


@router.delete("/{item_id}", dependencies=[Depends(require_csrf)])
def delete_item(item_id: str, version: int, db: Annotated[Session, Depends(get_db)],
                user: Annotated[User, Depends(require_permission("plants.manage"))]):
    row, plant = _owned(db, user, item_id)
    if version != row.row_version:
        raise HTTPException(409, "This line was changed by someone else. Reload the page and try again.")
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Removed BOM item", module="BOM",
                    metadata_json={"site_code": plant.site_code, "item": row.item_name, "id": str(row.id)}))
    db.delete(row)
    db.commit()
    return {"id": item_id, "removed": True}
