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
from sqlalchemy import Date, DateTime, ForeignKey, JSON, String, Text, UniqueConstraint, select, func, or_, case
from sqlalchemy.orm import Mapped, Session, mapped_column, load_only

from app.core.database import Base, get_db
from app.core.models import AuditLog, Plant, PMCyclePlan, SitePhoto, User, TimestampMixin, uuid_pk
from app.core.security import get_current_user, require_csrf, user_scoped_plant_ids
from app.core.timeutil import business_today
from app.portal.service import calendar as legacy_calendar

# Namespace for deterministic checklist-item UUIDs.
# uuid5(ITEM_ID_NS, "{activity_id}:{task_text}") is stable across template changes:
# the item keeps its id even if surrounding items are reordered or removed.
_ITEM_ID_NS = uuid.UUID("d4a3c2b1-e5f6-7890-abcd-ef1234567890")


def _checklist_item_id(activity_id: uuid.UUID, task: str) -> str:
    """A deterministic, stable UUID for one checklist item on one activity."""
    return str(uuid.uuid5(_ITEM_ID_NS, f"{activity_id}:{task}"))


def _ensure_checklist_ids(db: Session, row: "PMTrackingActivity") -> None:
    """Assign stable ids to every checklist item that lacks one, then persist.

    Called once per activity detail request; a no-op if ids are already present.
    For unsubmitted activities (checklist=[]) the template is locked in at this
    point so photos taken now bind to the same ids even if the template later changes.
    """
    checklist = row.checklist or []
    if checklist and all(isinstance(c, dict) and c.get("id") for c in checklist):
        return  # all items already have ids

    if checklist and all(isinstance(c, dict) and c.get("task") for c in checklist):
        # Submitted row: add ids to existing items preserving result/note.
        row.checklist = [
            {**c, "id": c.get("id") or _checklist_item_id(row.id, c["task"])}
            for c in checklist
        ]
    else:
        # Unsubmitted row: pre-populate from the current template.
        row.checklist = [
            {"id": _checklist_item_id(row.id, task), "task": task}
            for task in CHECKLISTS.get(row.equipment, [])
        ]
    db.add(row)
    db.commit()

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
    checks = _checks_for(row)
    # Deterministic checklist item IDs: stable across template edits, same as the DB backfill.
    # Derived here without a write so the GET endpoint stays read-only.
    item_ids = [_checklist_item_id(row.id, task) for task in checks]
    return {**base, **_snapshot(row), "checks": checks, "checklistItemIds": item_ids,
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


# ── Who is told about a checklist step ──────────────────────────────────────
#
# Notifications are created AFTER the action's own transaction has committed, and a failure
# here is logged and swallowed: a workflow step that the database accepted must never be undone
# or hidden because a notification could not be written. Each one carries a dedupe key derived
# from the row's own saved timestamps, so a retried request cannot produce a second copy.

_ACTION_TITLE = {
    "submit": "PM checklist submitted",
    "approve": "PM checklist approved",
    "return": "PM checklist returned for correction",
    "request": "PM sequence permission requested",
    "grant": "PM sequence permission granted",
    "deny": "PM sequence permission denied",
}
_ACTION_EVENT = {
    "submit": "pm_submitted", "approve": "pm_approved", "return": "pm_returned",
    "request": "pm_permission_requested", "grant": "pm_permission_granted",
    "deny": "pm_permission_denied",
}


def _notify_action(db: Session, row: PMTrackingActivity, plant: Plant, action: str, actor: User) -> None:
    import logging

    from app.notifications.service import notify_pm_event, pm_plant_recipients

    try:
        month = row.scheduled_on.strftime("%Y-%m")
        where = f"{plant.plant_name} · {row.equipment_id} · {_iso(row.scheduled_on)}"
        # The dedupe key uses the timestamp THIS action wrote, so a repeat of the same step on
        # the same row (a second permission request after a denial, a resubmission after a
        # return) is a new notification, while a retry of one request is not.
        stamps = {"submit": row.submitted_at, "approve": row.reviewed_at, "return": row.reviewed_at,
                  "request": row.requested_at, "grant": row.authorised_at, "deny": row.authorised_at}
        stamp = (stamps.get(action) or datetime.now(timezone.utc)).isoformat()
        if action == "submit":
            # The approver and the people answerable for this equipment, portfolio-wide.
            users = pm_plant_recipients(db, plant_id=row.plant_id, equipment=row.equipment)
            users = [u for u in users if u.id != actor.id]
            message = f"{where} — submitted by {actor.display_name} for approval."
        elif action in {"approve", "return"}:
            engineer = db.get(User, row.submitted_by) if row.submitted_by else None
            users = [engineer] if engineer and engineer.id != actor.id else []
            note = (row.review_note or "").strip()
            message = f"{where} — {'approved' if action == 'approve' else 'returned'} by {actor.display_name}."
            if action == "return" and note:
                message += f" Reason: {note[:300]}"
        elif action == "request":
            users = [u for u in pm_plant_recipients(db, plant_id=row.plant_id, equipment=row.equipment)
                     if u.id != actor.id and u.role in {"O&M Head", "Assignee"}]
            message = (f"{where} — {actor.display_name} asks to proceed out of sequence. "
                       f"Reason: {(row.permission_reason or '').strip()[:300]}")
        else:
            engineer = db.get(User, row.requested_by) if row.requested_by else None
            users = [engineer] if engineer and engineer.id != actor.id else []
            message = (f"{where} — permission {'granted' if action == 'grant' else 'denied'} by "
                       f"{actor.display_name}. {(row.authorisation_note or '').strip()[:300]}")
        if not users:
            return
        notify_pm_event(
            db, users=[u for u in users if u is not None], event_type=_ACTION_EVENT[action],
            title=_ACTION_TITLE[action], message=message, activity_id=str(row.id), plant=plant,
            month=month, equipment=row.equipment,
            dedupe_key=f"pm-{action}:{row.id}:{stamp}",
        )
        db.commit()
    except Exception:
        db.rollback()
        logging.getLogger("solar91.pm").exception(
            "PM notification failed; the checklist action itself was saved")


def check_pm_tracking_reminders(db: Session, today: date | None = None, *, max_plants: int = 200) -> dict:
    """Daily reminders for work that is already late or already waiting, for the hourly job.

    Two grouped queries, one notification per plant per day and one for the approver's queue, all
    keyed by the day so running the job again cannot repeat them. Only activities that are
    genuinely actionable are counted: a future activity that is merely sequence-locked is not a
    reminder, which is why nothing here looks at the blocker chain.
    """
    from app.notifications.service import notify_pm_event, notify_users, pm_plant_recipients, users_with_role

    day = today or business_today()
    out = {"overdue_plants_notified": 0, "pending_approval_notified": 0}
    overdue = db.execute(
        select(PMTrackingActivity.plant_id, func.count(), func.min(PMTrackingActivity.scheduled_on))
        .where(PMTrackingActivity.scheduled_on < day,
               PMTrackingActivity.status.in_(("Scheduled", "Returned")))
        .group_by(PMTrackingActivity.plant_id)
        .order_by(func.count().desc())
        .limit(max_plants)
    ).all()
    for plant_id, count, oldest in overdue:
        plant = db.get(Plant, plant_id)
        if plant is None or (plant.status or "").casefold() == "inactive":
            continue
        users = pm_plant_recipients(db, plant_id=plant_id)
        if not users:
            continue
        notify_pm_event(
            db, users=users, event_type="pm_overdue",
            title=f"{count} overdue PM activit{'y' if count == 1 else 'ies'} — {plant.plant_name}",
            message=f"Oldest scheduled {_iso(oldest)}. Approved completion only; submitted work still needs review.",
            activity_id="", plant=plant, month=day.strftime("%Y-%m"),
            dedupe_key=f"pm-overdue:{plant_id}:{day.isoformat()}",
        )
        out["overdue_plants_notified"] += 1
    pending = int(db.scalar(
        select(func.count()).select_from(PMTrackingActivity)
        .where(PMTrackingActivity.status == "Pending approval")) or 0)
    if pending:
        heads = users_with_role(db, {"O&M Head"})
        if heads:
            notify_users(
                db, heads, event_type="pm_submitted",
                title=f"{pending} PM checklist{'' if pending == 1 else 's'} awaiting your approval",
                message="Open Preventive Maintenance to review the submitted checklists.",
                target_type="pm_day", target_id=day.isoformat(),
                dedupe_key=f"pm-pending-digest:{day.isoformat()}",
                payload={"page": "pm", "month": day.strftime("%Y-%m")},
            )
            out["pending_approval_notified"] = len(heads)
    db.commit()
    return out


@router.get("")
def tracking_month(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
                   month: str = Query(...), site_code: str | None = None, summary: bool = False,
                   scheduled_date: date | None = Query(None, alias="date"), compliance: str | None = None):
    first, last = _bounds(month)
    if scheduled_date and not first <= scheduled_date <= last:
        raise HTTPException(422, "Date must be within the selected month")
    compliance_options = {"on_schedule", "behind", "not_started", "not_planned"}
    if compliance and compliance not in compliance_options:
        raise HTTPException(422, "Invalid compliance filter")
    scope = _role_scope(db, user)
    q = select(Plant).options(load_only(Plant.id, Plant.site_code, Plant.plant_name, Plant.district, Plant.supervisor)).where(or_(Plant.status.is_(None), func.lower(Plant.status) != "inactive")).order_by(Plant.plant_name, Plant.site_code)
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
    today = business_today()
    first_open = {}
    metrics = {}
    assigned_categories = set()
    if scheduled_date and ids:
        # Month-level compliance stays independent of the date filter. Return grouped
        # counts instead of hydrating every month's activity over the database link.
        a = PMTrackingActivity
        month_filter = (a.plant_id.in_(ids), a.scheduled_on.between(first, last))
        for pid, equipment, total, late, started in db.execute(select(
                a.plant_id, a.equipment, func.count(),
                func.sum(case(( (a.scheduled_on < today) & (a.status != "Approved"), 1), else_=0)),
                func.sum(case((a.status.in_(("Approved", "Pending approval", "Returned")), 1), else_=0))
            ).where(*month_filter).group_by(a.plant_id, a.equipment)):
            assigned_categories.add((pid, equipment))
            old = metrics.get(pid, (0, 0, 0))
            metrics[pid] = (old[0]+total, old[1]+late, old[2]+started)
        ranked = select(a.id, func.row_number().over(partition_by=a.plant_id,
            order_by=(a.scheduled_on, a.equipment, a.equipment_id, a.id)).label("rn")
            ).where(*month_filter, a.status != "Approved", a.scheduled_on < scheduled_date).subquery()
        for row in db.scalars(select(a).join(ranked, ranked.c.id == a.id).where(ranked.c.rn == 1)
                .options(load_only(a.id, a.plant_id, a.scheduled_on, a.equipment_id))):
            first_open[row.plant_id] = row
        rows = _rows(db, ids, scheduled_date, scheduled_date, summary=summary)
    else:
        rows = _rows(db, ids, first, last, summary=summary)
        for row in rows:
            assigned_categories.add((row.plant_id, row.equipment))
            total, late, started = metrics.get(row.plant_id, (0, 0, 0))
            metrics[row.plant_id] = (total + 1, late + int(row.scheduled_on < today and row.status != "Approved"),
                started + int(row.status in {"Approved", "Pending approval", "Returned"}))
            if row.status != "Approved":
                first_open.setdefault(row.plant_id, row)
    configured.update(metrics)
    # An authorized page can nudge the background scheduler, never block on it.
    # Only managed plants with no assignments in this month need the hint.
    assigned_plants = set(metrics)
    if any(first >= starts and plant_id not in assigned_plants
           for plant_id, starts in managed.items()):
        from app.pmplan.recurrence import request_schedule_check
        request_schedule_check(first)
    compliance_by_plant = {}
    for plant in plants:
        total, late, started = metrics.get(plant.id, (0, 0, 0))
        if not total:
            compliance_by_plant[plant.id] = "not_started" if plant.id in configured else "not_planned"
        elif late:
            compliance_by_plant[plant.id] = "behind"
        elif not started:
            compliance_by_plant[plant.id] = "not_started"
        else:
            compliance_by_plant[plant.id] = "on_schedule"
    selected_plant_ids = {plant.id for plant in plants}
    if compliance:
        selected_plant_ids.intersection_update(
            plant_id for plant_id, value in compliance_by_plant.items() if value == compliance
        )
    portfolio_plants = [plant for plant in plants if plant.id in selected_plant_ids]
    rows = [row for row in rows if row.plant_id in selected_plant_ids]
    legacy = legacy_calendar(db, user, "pm", month, [p.id for p in portfolio_plants], limit=20001, scheduled_date=scheduled_date)
    legacy_truncated = len(legacy) > 20000
    managed_codes = {p.site_code: (p.id, managed[p.id]) for p in plants if p.id in managed}
    portal_managed = {p.plant_id for p in plans if "[PM_PORTAL_EDITOR]" in (p.notes or "")}
    def visible_marker(entry):
        # Keep actual work orders and all untagged cycle plans.
        scoped = managed_codes.get(entry.get("plantSiteCode"))
        if entry.get("source") != "cycle_plan" or not scoped:
            return True
        plant_id, starts = scoped
        if first < starts:
            return False
        # Explicit SQL assignments replace the old calculated phase markers.
        if plant_id in portal_managed or (plant_id, entry.get("planPhase")) in assigned_categories:
            return False
        # Retain the nominal dates for remaining plan-only categories, not
        # artificial chained dates generated from the old uniform intervals.
        return entry.get("cyclePlanState") != "chained"
    legacy = [entry for entry in legacy if visible_marker(entry)]
    if scheduled_date:
        # Select plants only after both SQL-filtered work orders and visible plan markers
        # are available; legacy-only work must not vanish from the daily portfolio.
        selected_codes = {plant.site_code for plant in portfolio_plants}
        legacy = [entry for entry in legacy
                  if entry.get("date") == scheduled_date.isoformat() and entry.get("plantSiteCode") in selected_codes]
        daily_ids = {row.plant_id for row in rows}
        daily_codes = {entry.get("plantSiteCode") for entry in legacy}
        portfolio_plants = [plant for plant in portfolio_plants if plant.id in daily_ids or plant.site_code in daily_codes]
    return {"month": month, "as_of": datetime.now(timezone.utc).isoformat(), "today": _iso(today), "role": user.role, "categories": CATEGORIES,
            "covered": list(CHECKLISTS), "plants": [{"id": str(p.id), "site_code": p.site_code,
                "name": p.plant_name, "district": p.district or "", "supervisor": p.supervisor or "",
                "configured": p.id in configured, "compliance": compliance_by_plant[p.id]} for p in portfolio_plants],
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
    _notify_action(db, row, plant, action, user)
    return {"id": str(row.id), "status": row.status, "permission": row.permission}
