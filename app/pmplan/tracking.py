"""SQL-assigned monthly PM checklist execution. No scheduling write API.

Existing cycle plans and OMTask work orders stay separate and are read-only context
in this view. Only explicitly assigned, checklist-covered rows enter the sequence.
"""
from __future__ import annotations

import uuid
import re
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

# Source: PM check sheet Updated.xls (six equipment sheets), plus applicable
# unique Monthly-ticked items from Operation & Maintenance Schedule updated.xls.
# Descriptions are inspection scope, not live electrical work instructions.
# ACDB has no dedicated source sheet: two shared monthly panel checks are used.
CHECKLISTS = {'Inverter': ['Check inverter cleanliness',
              'Check tourqing of AC Termination',
              'Check All cooling fans are working',
              'String testig to be done - And Make String Report',
              'Check any abnormilities (Cable puncher,crack in cable insulation)',
              'Check Inverter Communication with RMS/COM100',
              'ERT of All DC Earthing Pits',
              'Check DC On/Off Switch',
              'Check Cable entry hole seald by PV Foam',
              'Module cleanning robot inspection',
              'Modules physical inspection- For any Damage',
              'Check/visually inspect the inverter-side MC4. Ensure all MC4 connectors are properly locked. '
              'Perform a string check to identify any cuts in the DC cable.',
              'MMS check ( rusting, wending nut bolts lossing)',
              'Cleaning of fan filter units'],
 'ACCB': ['Check ACCB fuse base',
          'Check Bus Bar Sleeve',
          'Check Bus Bar Bolt, Lug, Washer for Heat Up & Looseness',
          'Check Fan is working',
          'Check Power cable lug',
          'Check Fuse base connection tightness',
          'Check Temp. in ACCB',
          'Check Fuse failure',
          'Check ACCB cleanliness',
          'Check Acrylic sheet mounting',
          'Check Air filter & fan filter for cleanliness',
          'Check Cable dressing',
          'Check Door lock & Door working',
          'Check LED Indication',
          'Check for any unwanted opening or Hole',
          'Check Enclosure Rusting',
          'Check ACCB Rotary Switch is in ON condition',
          'Inspect MCBs, DPs, fuses, relays, and timers for abnormalities, burns, or overheating'],
 'IDT Transformer': ['Clean Complete Body of transformer',
                     'Check Oil Leakage from Transformer ( Radiator,Conservator, Tank and Air Release & Oil '
                     'Releive Valve)',
                     'Check Torqing of LT and HT termmination',
                     'Check Tightness of marshelling box connection',
                     'Check IR Values of HT nad LT Winding',
                     'Check tap changing take place both in Manual mode And Remote Mode',
                     'Check all the cable termination',
                     'Check OTI Alarm and Trip',
                     'Check WTI Alarm and Trip',
                     'Check Buchholz alarm and Trip',
                     'Check MOG Alarm',
                     'Check and release Air Vent in Buholz relay',
                     'Check Earth resistanse of Transformer Earthing',
                     'Visual check for any crack on Insulator',
                     'Check and remove Vegetation in the yard',
                     'Check Oil Level of transformer tank and OLTC',
                     'Check the Breather Silicagel condition'],
 'VCB': ['Check Breaker cleanliness',
         'Check Torqing of AC termination',
         'Check bolt, washer and lug for heatup',
         'Check Breaker Jointing Kit (Any Crack in Jointing Kit)',
         'Check manual Spring charge and On/Off',
         'Check operation of Breaker',
         'Check the Indication Lamp',
         'Check the Annunciator function',
         'Check the Hooter function',
         'Check the Function of Selector switch and TNC Switch and Push Button',
         'Check door lock and door working'],
 '4 Pole + ACDB + Aux. TX': ['Four Pole — Bush Should be Clear',
                             'Four Pole — Oil Leakage Issue from CT & PT',
                             'Four Pole — Yard Fencing Should be Proper',
                             'Four Pole — Grease on Isolator Operating Part',
                             'Four Pole — Equipment Bushing Proper',
                             'Four Pole — Jointing Kits Proper',
                             'Four Pole — Check ERT Value, if required fill water in pits',
                             'Four Pole — No Chattering Sound Heard in Yard',
                             'Four Pole — Yard Greet Should be Proper',
                             'Four Pole — Fire Bucket Filled with Sand & Fire Extinguisher Filled',
                             'Four Pole — Check horngap Rod and Fuse Condition',
                             'Four Pole — Check the LA is Intact',
                             'Four Pole — Visual inspection of the four-pole structure',
                             'ACDB — HT & LT Pannels Cleaning Record',
                             'ACDB — Inspect MCBs, DPs, fuses, relays, and timers for abnormalities, burns, or '
                             'overheating',
                             'Auxiliary Transformer — Clean Complete Body of transformer',
                             'Auxiliary Transformer — Check Oil Leakage from Transformer ( Radiator,Conservator, '
                             'Tank and Air Release & Oil Releive Valve)',
                             'Auxiliary Transformer — Check Torqing of LT and HT termmination',
                             'Auxiliary Transformer — Check Tightness of marshelling box connection',
                             'Auxiliary Transformer — Check IR Values of HT nad LT Winding',
                             'Auxiliary Transformer — Check tap changing take place both in Manual mode And '
                             'Remote Mode',
                             'Auxiliary Transformer — Check all the cable termination',
                             'Auxiliary Transformer — Check OTI Alarm and Trip',
                             'Auxiliary Transformer — Check WTI Alarm and Trip',
                             'Auxiliary Transformer — Check Buchholz alarm and Trip',
                             'Auxiliary Transformer — Check MOG Alarm',
                             'Auxiliary Transformer — Check and release Air Vent in Buholz relay',
                             'Auxiliary Transformer — Check Earth resistanse of Transformer Earthing',
                             'Auxiliary Transformer — Visual check for any crack on Insulator',
                             'Auxiliary Transformer — Check and remove Vegetation in the yard',
                             'Auxiliary Transformer — Check Oil Level of transformer tank and OLTC',
                             'Auxiliary Transformer — Check the Breather Silicagel condition'],
 'Transmission line': ['Check the insulator crackness from Ground',
                       'Check conductor Sag from Ground',
                       'Check and ensure the pole & Pin insulators are upright and free from slantinng from '
                       'Ground',
                       'Check and ensure poles are with out any damage/observation from Ground',
                       'Check and cut trees and shrubs during line clearance',
                       'Check conductors are properly seated in its slot from Ground',
                       'Check earth connection to the poles from Ground',
                       'Check the guard wire for properness from Ground',
                       'Check the stay insulator healthiness and stay wire properness',
                       'Check all jointing kits visually',
                       'Complete line patrolling from the plant to GSS',
                       'Check arcing horn for any carbon deposits'],
 'GSS visit': ['GSS-side VCB & Kiosk — Check Breaker cleanliness',
               'GSS-side VCB & Kiosk — Check Torqing of AC termination',
               'GSS-side VCB & Kiosk — Check bolt, washer and lug for heatup',
               'GSS-side VCB & Kiosk — Check Breaker Jointing Kit (Any Crack in Jointing Kit)',
               'GSS-side VCB & Kiosk — Check manual Spring charge and On/Off',
               'GSS-side VCB & Kiosk — Check operation of Breaker',
               'GSS-side VCB & Kiosk — Check the Indication Lamp',
               'GSS-side VCB & Kiosk — Check the Annunciator function',
               'GSS-side VCB & Kiosk — Check the Hooter function',
               'GSS-side VCB & Kiosk — Check the Function of Selector switch and TNC Switch and Push Button',
               'GSS-side VCB & Kiosk — Check door lock and door working',
               'GSS-side Switchyard — Bush Should be Clear',
               'GSS-side Switchyard — Oil Leakage Issue from CT & PT',
               'GSS-side Switchyard — Yard Fencing Should be Proper',
               'GSS-side Switchyard — Grease on Isolator Operating Part',
               'GSS-side Switchyard — Equipment Bushing Proper',
               'GSS-side Switchyard — Jointing Kits Proper',
               'GSS-side Switchyard — Check ERT Value, if required fill water in pits',
               'GSS-side Switchyard — No Chattering Sound Heard in Yard',
               'GSS-side Switchyard — Yard Greet Should be Proper',
               'GSS-side Switchyard — Fire Bucket Filled with Sand & Fire Extinguisher Filled',
               'GSS-side Switchyard — Check horngap Rod and Fuse Condition',
               'GSS-side Switchyard — Check the LA is Intact'],
 'Earth pit': ['Earthing system check- ERT and Watering of all Pits'],
 'Miscellaneous': ['Water pipe line and motor- Check for leakage and water preassure',
                   'Comminication system check- System online monitoring',
                   'WMS calibration checked- Check data as per Ambient Condition',
                   'Water Drainage System Check- Check for leakage']}
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
    result: Literal["OK", "Not OK", "Abnormality", "N/A"]
    note: str = Field(default="", max_length=2000)


class TrackingAction(BaseModel):
    action: Literal["submit", "approve", "return", "request", "grant", "deny"]
    reason: str = Field(default="", max_length=4000)
    inspected_on: date | None = None
    checks: list[CheckResult] = Field(default_factory=list, max_length=64)


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


def _checks_for(row):
    # Once submitted, the recorded descriptions are the activity's immutable
    # checklist version, including on return/resubmission. New rows use the
    # current template. Do not relabel saved results after a template upgrade.
    if row.checklist and all(isinstance(c, dict) and isinstance(c.get("task"), str)
                             and c["task"] for c in row.checklist):
        return [c["task"] for c in row.checklist]
    return CHECKLISTS.get(row.equipment, [])


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
    return {**base, **_snapshot(row), "checks": _checks_for(row),
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
    plans = list(db.scalars(select(PMCyclePlan).where(PMCyclePlan.plant_id.in_(ids)))) if ids else []
    # Only SQL-managed recurring plans carry this marker. Untagged plans retain
    # their existing behavior, and real work orders are never filtered here.
    managed = {}
    for plan in plans:
        marker = re.search(r"\[PM_TRACKING_START=(\d{4}-\d{2}-\d{2})\]", plan.notes or "")
        if marker:
            try:
                managed[plan.plant_id] = date.fromisoformat(marker.group(1))
            except ValueError:
                pass
    configured = {p.plant_id for p in plans if p.phases and
                  (p.plant_id not in managed or first >= managed[p.plant_id])}
    rows = _rows(db, ids, first, last, summary=summary)
    # An authorized page can nudge the background scheduler, never block on it.
    # Only managed plants with no assignments in this month need the hint.
    assigned_plants = {row.plant_id for row in rows}
    if any(first >= starts and plant_id not in assigned_plants
           for plant_id, starts in managed.items()):
        from app.pmplan.recurrence import request_schedule_check
        request_schedule_check(first)
    first_open = {}
    for row in rows:
        if row.status != "Approved":
            first_open.setdefault(row.plant_id, row)
    today = business_today()
    legacy = legacy_calendar(db, user, "pm", month, ids, limit=20001)
    legacy_truncated = len(legacy) > 20000
    managed_codes = {p.site_code: (p.id, managed[p.id]) for p in plants if p.id in managed}
    assigned_categories = {(r.plant_id, r.equipment) for r in rows}
    def visible_marker(entry):
        # Keep actual work orders and all untagged cycle plans.
        scoped = managed_codes.get(entry.get("plantSiteCode"))
        if entry.get("source") != "cycle_plan" or not scoped:
            return True
        plant_id, starts = scoped
        if first < starts:
            return False
        # Explicit SQL assignments replace the old calculated phase markers.
        if (plant_id, entry.get("planPhase")) in assigned_categories:
            return False
        # Retain the nominal dates for remaining plan-only categories, not
        # artificial chained dates generated from the old uniform intervals.
        return entry.get("cyclePlanState") != "chained"
    legacy = [entry for entry in legacy if visible_marker(entry)]
    return {"month": month, "as_of": datetime.now(timezone.utc).isoformat(), "today": _iso(today), "role": user.role, "categories": CATEGORIES,
            "covered": list(CHECKLISTS), "plants": [{"id": str(p.id), "site_code": p.site_code,
                "name": p.plant_name, "district": p.district or "", "supervisor": p.supervisor or "", "configured": p.id in configured} for p in plants],
            "activities": [_out(r, _blocker(r, first_open.get(r.plant_id)), user, today, summary=summary) for r in rows],
            "legacy": legacy[:20000], "legacy_truncated": legacy_truncated}


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
        expected = _checks_for(row)
        if len(payload.checks) != len(expected):
            raise HTTPException(422, "Complete every Monthly checklist item")
        if not payload.inspected_on or not row.scheduled_on <= payload.inspected_on <= today:
            raise HTTPException(422, "Inspection date must be on or after the scheduled date and not in the future")
        if any(c.result != "OK" and not c.note.strip() for c in payload.checks):
            raise HTTPException(422, "An observation or justification is required for every Not OK / Abnormality / N/A result")
        if all(c.result == "N/A" for c in payload.checks):
            raise HTTPException(422, "At least one applicable check is required; contact the O&M Head for an entirely inapplicable activity")
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
