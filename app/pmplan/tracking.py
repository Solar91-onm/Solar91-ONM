"""SQL-assigned monthly PM checklist execution. No scheduling write API.

Existing cycle plans and OMTask work orders stay separate and are read-only context
in this view. Only explicitly assigned, checklist-covered rows enter the sequence.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from calendar import monthrange
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import Date, DateTime, ForeignKey, JSON, String, Text, UniqueConstraint, select, func, or_
from sqlalchemy.orm import Mapped, Session, mapped_column, load_only

from app.core.database import Base, get_db
from app.core.models import AuditLog, Plant, PMCyclePlan, User, TimestampMixin, uuid_pk
from app.core.security import get_current_user, require_csrf, user_scoped_plant_ids
from app.core.timeutil import business_today
from app.portal.service import calendar as legacy_calendar

router = APIRouter(prefix="/tracking", tags=["PM checklist tracking"])

# Exact source: Operation & Maintenance Schedule updated (1).xls, Monthly.
# Only the calendar's approved equipment scope. Four-pole is deliberately partial.
CHECKLISTS = {
    'ACCB': ['Fuse continuity & terminal arc checking and identification of any hotspot.', 'Panels cleaning record- Monthly Sheet for Cleaning', 'Cable and termination visual check.', 'Any abnormality, burn, or heat of MCBs, DP fuses, relays, timers, etc.'],
    'Inverter': ['Cleaning Fan Filter Unit', 'Modules physical inspection- For any Damage', 'MMS check ( rusting, wending nut bolts lossing)', 'Module cleanning robot inspection', 'Check /visual inspection of the Inverter Side MC4, Check all The MC4 are properly locked, String Check - If there is any Cut in DC Cable.'],
    '4 Pole + ACDB + Aux. TX': ['Visual check of four pole structure for any damage/abnormality.'],
    'Transmission line': ['Check Arching horn For any carbon deposit', 'Check ALL jointing kits visually.', 'Complete line patrolling from plant to GSS'],
    'Earth pit': ['Earthing system check- ERT and Watering of all Pits'],
    'Miscellaneous': ['Water pipe line and motor- Check for leakage and water preassure', 'Comminication system check- System online monitoring', 'WMS calibration checked- Check data as per Ambient Condition', 'Water Drainage System Check- Check for leakage'],
}
CATEGORIES = ["Inverter", "ACCB", "IDT Transformer", "VCB", "4 Pole + ACDB + Aux. TX",
              "Transmission line", "GSS visit", "Earth pit", "Miscellaneous"]
ROLES = {"Site Engineer", "Assignee", "O&M Head"}


class PMTrackingActivity(Base, TimestampMixin):
    __tablename__ = "pm_tracking_activities"
    id: Mapped[uuid.UUID] = uuid_pk()
    plant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plants.id", ondelete="CASCADE"), nullable=False, index=True)
    equipment: Mapped[str] = mapped_column(String(100), nullable=False)
    equipment_id: Mapped[str] = mapped_column(String(120), nullable=False)
    scheduled_on: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(30), default="Scheduled", nullable=False)
    checklist: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    remarks: Mapped[str | None] = mapped_column(Text)
    inspected_on: Mapped[date | None] = mapped_column(Date)
    submitted_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    submitted_name: Mapped[str | None] = mapped_column(String(255))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    reviewed_name: Mapped[str | None] = mapped_column(String(255))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_note: Mapped[str | None] = mapped_column(Text)
    permission: Mapped[str] = mapped_column(String(20), default="None", nullable=False)
    permission_reason: Mapped[str | None] = mapped_column(Text)
    requested_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    requested_name: Mapped[str | None] = mapped_column(String(255))
    requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    authorised_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    authorised_name: Mapped[str | None] = mapped_column(String(255))
    authorised_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    authorisation_note: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (UniqueConstraint("plant_id", "equipment", "equipment_id", "scheduled_on"),)


class CheckResult(BaseModel):
    result: Literal["OK", "Not OK", "Abnormality"]
    note: str = Field(default="", max_length=2000)


class TrackingAction(BaseModel):
    action: Literal["submit", "approve", "return", "request", "grant", "deny"]
    reason: str = Field(default="", max_length=4000)
    inspected_on: date | None = None
    checks: list[CheckResult] = Field(default_factory=list, max_length=30)


def _bounds(month: str) -> tuple[date, date]:
    try:
        if len(month) != 7 or month[4] != "-":
            raise ValueError
        first = date.fromisoformat(month + "-01")
        return first, first.replace(day=monthrange(first.year, first.month)[1])
    except ValueError as exc:
        raise HTTPException(422, "Use YYYY-MM for month") from exc


def _role_scope(db: Session, user: User):
    if user.role not in ROLES:
        raise HTTPException(403, "PM tracking is available to Site Engineers, Assignees and O&M Heads")
    return user_scoped_plant_ids(db, user)


def _blocker(row: PMTrackingActivity, first_open: PMTrackingActivity | None):
    # Same-date activities can proceed together. A granted override applies to one row only.
    if (row.status in {"Scheduled", "Returned"} and first_open is not None
            and first_open.scheduled_on < row.scheduled_on and row.permission != "Granted"):
        return first_open
    return None


def _iso(value):
    return value.isoformat() if value else None


def _snapshot(row):
    return {"status": row.status, "checklist": row.checklist, "remarks": row.remarks,
            "inspected_on": _iso(row.inspected_on), "submitted_by": str(row.submitted_by or ""),
            "submitted_name": row.submitted_name, "submitted_at": _iso(row.submitted_at),
            "reviewed_by": str(row.reviewed_by or ""), "reviewed_name": row.reviewed_name,
            "reviewed_at": _iso(row.reviewed_at), "review_note": row.review_note,
            "permission": row.permission, "permission_reason": row.permission_reason,
            "requested_by": str(row.requested_by or ""), "requested_name": row.requested_name,
            "requested_at": _iso(row.requested_at), "authorised_by": str(row.authorised_by or ""),
            "authorised_name": row.authorised_name, "authorised_at": _iso(row.authorised_at),
            "authorisation_note": row.authorisation_note}


def _out(row, blocker, user, today, summary=False):
    status = row.status
    if blocker:
        label = "Locked"
    elif status == "Scheduled":
        label = "Overdue" if row.scheduled_on < today else "Due today" if row.scheduled_on == today else "Scheduled"
    else:
        label = status
    base = {"id": str(row.id), "plant_id": str(row.plant_id), "equipment": row.equipment,
            "equipment_id": row.equipment_id, "date": _iso(row.scheduled_on), "status": status,
            "permission": row.permission, "label": label, "late": row.scheduled_on < today and status != "Approved",
            "blocker": {"id": str(blocker.id), "equipment_id": blocker.equipment_id,
                        "date": _iso(blocker.scheduled_on)} if blocker else None}
    if summary:
        return base
    return {**base, **_snapshot(row), "checks": CHECKLISTS.get(row.equipment, []),
            "can_submit": user.role == "Site Engineer" and not blocker and status in {"Scheduled", "Returned"}
                          and row.scheduled_on <= today and row.equipment in CHECKLISTS,
            "can_request": user.role == "Site Engineer" and bool(blocker) and row.permission in {"None", "Denied"},
            "can_grant": user.role in {"O&M Head", "Assignee"} and bool(blocker) and row.permission == "Requested",
            "can_review": user.role == "O&M Head" and status == "Pending approval"}


def _rows(db, plant_ids, first, last, summary=False):
    if not plant_ids:
        return []
    stmt = select(PMTrackingActivity).where(PMTrackingActivity.plant_id.in_(plant_ids),
        PMTrackingActivity.scheduled_on >= first, PMTrackingActivity.scheduled_on <= last)
    if summary:
        stmt = stmt.options(load_only(PMTrackingActivity.id, PMTrackingActivity.plant_id,
            PMTrackingActivity.equipment, PMTrackingActivity.equipment_id, PMTrackingActivity.scheduled_on,
            PMTrackingActivity.status, PMTrackingActivity.permission))
    return list(db.scalars(stmt.order_by(PMTrackingActivity.scheduled_on, PMTrackingActivity.equipment,
        PMTrackingActivity.equipment_id, PMTrackingActivity.id)))


@router.get("")
def tracking_month(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
                   month: str = Query(...), site_code: str | None = None, summary: bool = False):
    first, last = _bounds(month)
    scope = _role_scope(db, user)
    q = select(Plant).where(or_(Plant.status.is_(None), func.lower(Plant.status) != "inactive")).order_by(Plant.plant_name, Plant.site_code)
    if scope is not None:
        q = q.where(Plant.id.in_(scope))
    if site_code:
        q = q.where(Plant.site_code == site_code)
    plants = list(db.scalars(q))
    if site_code and not plants:
        raise HTTPException(404, "Plant not available in your scope")
    ids = [p.id for p in plants]
    configured = {r.plant_id for r in db.scalars(select(PMCyclePlan).where(PMCyclePlan.plant_id.in_(ids))) if r.phases} if ids else set()
    rows = _rows(db, ids, first, last, summary=summary)
    first_open = {}
    for row in rows:
        if row.status != "Approved":
            first_open.setdefault(row.plant_id, row)
    today = business_today()
    legacy = legacy_calendar(db, user, "pm", month, ids, limit=20001)
    return {"month": month, "as_of": datetime.now(timezone.utc).isoformat(), "today": _iso(today), "role": user.role, "categories": CATEGORIES,
            "covered": list(CHECKLISTS), "plants": [{"id": str(p.id), "site_code": p.site_code,
                "name": p.plant_name, "district": p.district or "", "supervisor": p.supervisor or "", "configured": p.id in configured} for p in plants],
            "activities": [_out(r, _blocker(r, first_open.get(r.plant_id)), user, today, summary=summary) for r in rows],
            "legacy": legacy[:20000], "legacy_truncated": len(legacy) > 20000}


@router.post("/{activity_id}/action", dependencies=[Depends(require_csrf)])
def tracking_action(activity_id: uuid.UUID, payload: TrackingAction,
                    db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    scope = _role_scope(db, user)
    # Serialize all actions for a plant in PostgreSQL, not only actions on the same row.
    # A simultaneous approval and submission must see a consistent sequence.
    target_plant = db.scalar(select(PMTrackingActivity.plant_id).where(PMTrackingActivity.id == activity_id))
    if target_plant is None or (scope is not None and target_plant not in scope):
        raise HTTPException(404, "PM activity not available in your scope")
    plant = db.scalar(select(Plant).where(Plant.id == target_plant).with_for_update())
    if plant is None or (plant.status or "").casefold() == "inactive":
        raise HTTPException(404, "Plant not available")
    row = db.scalar(select(PMTrackingActivity).where(PMTrackingActivity.id == activity_id,
        PMTrackingActivity.plant_id == target_plant).with_for_update().execution_options(populate_existing=True))
    if row is None or row.equipment not in CHECKLISTS:
        raise HTTPException(404, "Checklist activity not available")
    first, last = _bounds(row.scheduled_on.strftime("%Y-%m"))
    first_open = next((r for r in _rows(db, [target_plant], first, last) if r.status != "Approved"), None)
    today = business_today()
    caps = _out(row, _blocker(row, first_open), user, today)
    before = _snapshot(row)
    action, reason = payload.action, payload.reason.strip()
    now = datetime.now(timezone.utc)
    required = {"submit": "can_submit", "approve": "can_review", "return": "can_review",
                "request": "can_request", "grant": "can_grant", "deny": "can_grant"}
    if not caps[required[action]]:
        raise HTTPException(409, "Action not permitted for your role or current activity state. Refresh the page.")
    if action in {"return", "request", "grant", "deny"} and not reason:
        raise HTTPException(422, "A reason is required")
    if action == "submit":
        expected = CHECKLISTS[row.equipment]
        if len(payload.checks) != len(expected):
            raise HTTPException(422, "Complete every Monthly checklist item")
        if not payload.inspected_on or not row.scheduled_on <= payload.inspected_on <= today:
            raise HTTPException(422, "Inspection date must be on or after the scheduled date and not in the future")
        if any(c.result != "OK" and not c.note.strip() for c in payload.checks):
            raise HTTPException(422, "An observation is required for every Not OK / Abnormality result")
        row.checklist = [{"task": task, "result": c.result, "note": c.note.strip()} for task, c in zip(expected, payload.checks)]
        row.inspected_on, row.remarks = payload.inspected_on, reason
        row.submitted_by, row.submitted_name, row.submitted_at = user.id, user.display_name, now
        row.status = "Pending approval"
        row.reviewed_by = row.reviewed_name = row.reviewed_at = row.review_note = None
    elif action in {"approve", "return"}:
        row.status = "Approved" if action == "approve" else "Returned"
        row.reviewed_by, row.reviewed_name, row.reviewed_at, row.review_note = user.id, user.display_name, now, reason
    elif action == "request":
        row.permission, row.permission_reason = "Requested", reason
        row.requested_by, row.requested_name, row.requested_at = user.id, user.display_name, now
        row.authorised_by = row.authorised_name = row.authorised_at = row.authorisation_note = None
    else:
        row.permission = "Granted" if action == "grant" else "Denied"
        row.authorised_by, row.authorised_name, row.authorised_at, row.authorisation_note = user.id, user.display_name, now, reason
    # Precise change token for fast Overview refresh (SQLite CURRENT_TIMESTAMP is second-granular).
    row.updated_at = now
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="PM tracking: " + action,
        module="Preventive Maintenance", entity_type="pm_tracking_activity", entity_id=str(row.id),
        before_state=before, after_state=_snapshot(row), metadata_json={"plant_id": str(row.plant_id),
            "equipment_id": row.equipment_id, "scheduled_on": _iso(row.scheduled_on)}))
    db.commit()
    return {"id": str(row.id), "status": row.status, "permission": row.permission}
