"""Transactional editor for the permanent SQL-managed PM schedule.

Schema contract: migration 053 and app/pmplan/recurrence.py. No DDL at runtime.
Preview and commit share the same planner; the commit revalidates under locks.
"""
from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime, timezone
from hashlib import sha256
import json
import re
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session, load_only

from app.core.database import get_db
from app.core.models import AuditLog, OMTask, Plant, PMCyclePlan, PMUnitConfig, SitePhoto, User
from app.core.security import get_current_user, require_csrf
from app.core.timeutil import business_today
from app.pmplan.recurrence import LOCK_KEY, START_MONTH, _add_months
from app.pmplan.tracking import CHECKLISTS, PMTrackingActivity, _bounds

router = APIRouter(prefix="/schedules", tags=["PM schedule editor"])
DB = Annotated[Session, Depends(get_db)]
Actor = Annotated[User, Depends(get_current_user)]
SINGLE = tuple(k for k in CHECKLISTS if k != "Inverter")
LABELS = {k: k + " — plant visit" for k in SINGLE}
LABELS["GSS visit"] = "GSS visit — GSS side"
LABELS["4 Pole + ACDB + Aux. TX"] = "4 Pole — structure inspection"
ALIASES = {
    "Inverter": ["inverter"], "ACCB": ["accb", "accb panel"],
    "IDT Transformer": ["idt", "idt transformer", "transformer"], "VCB": ["vcb", "vcb panel"],
    "GSS visit": ["gss visit", "vcb - gss side", "4 pole - gss side", "switchyard"],
    "4 Pole + ACDB + Aux. TX": ["4 pole", "4 pole + acdb + aux. tx", "acdb", "aux. transformer", "auxiliary transformer", "aux. transformer + acdb"],
    "Transmission line": ["transmission line"], "Earth pit": ["earthing", "earth pit"], "Miscellaneous": ["miscellaneous"],
}
PHASE_CATEGORIES = {"Inverter": ["Inverter"], "ACCB": ["ACCB Panel"], "IDT Transformer": ["Transformer"],
    "VCB": ["VCB Panel"], "GSS visit": ["VCB - GSS side", "4 Pole - GSS side", "Switchyard"],
    "4 Pole + ACDB + Aux. TX": ["4 Pole", "ACDB", "Aux. Transformer"], "Transmission line": ["Transmission line"],
    "Earth pit": ["Earthing"], "Miscellaneous": ["Miscellaneous"]}


class Change(BaseModel):
    equipment: str = Field(max_length=100)
    inverter_no: int | None = Field(None, ge=1, le=1000, strict=True)
    day: int | None = Field(None, ge=1, le=31, strict=True)


class ScheduleRequest(BaseModel):
    month: str
    scope: Literal["month", "future"] = "future"
    changes: list[Change] = Field(min_length=1, max_length=1008)
    mode: Literal["create", "edit"]
    token: str | None = Field(None, max_length=64)


def _fail(message, status=409):
    raise HTTPException(status, message)


def _schedule_manager(user):
    if user.role not in {"O&M Head", "Assignee"}:
        _fail("Only an O&M Head or Assignee may manage recurring PM schedules", 403)


def _ready(db):
    if db.get_bind().dialect.name != "postgresql" or not db.scalar(text("""
        SELECT to_regclass('solar91_pm.monthly_rules') IS NOT NULL
           AND to_regclass('solar91_pm.generated_months') IS NOT NULL
           AND to_regprocedure('solar91_pm.ensure_month(date)') IS NOT NULL
    """)):
        _fail("Permanent PM recurrence SQL is not installed", 503)


def _lock(db):
    db.execute(text("SET LOCAL lock_timeout = '3s'"))
    db.execute(text("SET LOCAL statement_timeout = '20s'"))
    if not db.scalar(text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": LOCK_KEY}):
        _fail("PM recurrence or another schedule edit is running. Retry shortly.")


def _plant(db, code, lock=False):
    stmt = select(Plant).options(load_only(Plant.id, Plant.site_code, Plant.plant_name, Plant.status)).where(Plant.site_code == code)
    p = db.scalar(stmt.with_for_update() if lock else stmt)
    if p is None:
        _fail("Plant not found", 404)
    if (p.status or "").casefold() == "inactive":
        _fail(f"{code}: plant is inactive")
    return p


def _key(equipment, inverter_no=None):
    return equipment, inverter_no if equipment == "Inverter" else None


def _label(key):
    return f"Inverter {key[1]}" if key[0] == "Inverter" else key[0]


def _new_id(key):
    return f"INV {key[1]}" if key[0] == "Inverter" else LABELS[key[0]]


def _date(month, day):
    return month.replace(day=min(day, monthrange(month.year, month.month)[1]))


def _rule_rows(db, pid):
    return [dict(r) for r in db.execute(text("""
        SELECT equipment, equipment_id, day_no, inverter_no FROM solar91_pm.monthly_rules
        WHERE plant_id = CAST(:pid AS uuid) ORDER BY equipment, inverter_no, equipment_id
    """), {"pid": str(pid)}).mappings()]


def _rule_map(rows):
    result = {}
    for r in rows:
        k = _key(r["equipment"], r["inverter_no"])
        if k in result or k[0] not in CHECKLISTS or (k[0] == "Inverter" and k[1] is None):
            _fail(f"Existing rule collision or invalid equipment: {_label(k)}; reconcile before editing")
        result[k] = r
    return result


def _unit_count(db, pid, lock=False):
    stmt = select(PMUnitConfig).where(PMUnitConfig.plant_id == pid,
        func.lower(func.trim(PMUnitConfig.equipment_type)) == "inverter")
    configs = list(db.scalars(stmt.with_for_update() if lock else stmt))
    if len(configs) != 1 or not 1 <= configs[0].total_units <= 1000:
        _fail("Expected exactly one valid Inverter pm_unit_config (1–1000 units)")
    return configs[0].total_units


def _months(db):
    return list(db.scalars(text("SELECT month_start FROM solar91_pm.generated_months ORDER BY month_start")))


def _protected(row, photos):
    return (row.status != "Scheduled" or row.permission != "None" or any(not isinstance(c, dict) or c.get("result") or c.get("note") for c in (row.checklist or [])) or
            any(getattr(row, f) is not None for f in ("inspected_on", "submitted_at", "reviewed_at", "requested_at", "authorised_at",
                "submitted_by", "reviewed_by", "requested_by", "authorised_by", "remarks", "review_note", "permission_reason", "authorisation_note", "submitted_name", "reviewed_name", "requested_name", "authorised_name"))
            or str(row.id) in photos)


def _activity_key(row, rules, inverter_ids=None):
    if row.equipment != "Inverter":
        return _key(row.equipment)
    if inverter_ids is None:
        inverter_ids = {r["equipment_id"]: k for k, r in rules.items() if k[0] == "Inverter"}
    if row.equipment_id in inverter_ids:
        return inverter_ids[row.equipment_id]
    match = re.fullmatch(r"(?:INV(?:ERTER)?)[\s_-]*0*(\d+)", row.equipment_id, re.I)
    if not match:
        _fail(f"Unrecognized inverter ID {row.equipment_id}; reconcile before editing")
    return _key("Inverter", int(match.group(1)))


def _changes(payload, count):
    result = {}
    for c in payload.changes:
        if c.equipment not in CHECKLISTS or (c.equipment == "Inverter") != (c.inverter_no is not None):
            _fail(f"Invalid equipment or inverter number: {c.equipment}", 422)
        k = _key(c.equipment, c.inverter_no)
        if k in result:
            _fail(f"Duplicate equipment assignment: {_label(k)}", 422)
        if k[0] == "Inverter" and (c.day is None or not 1 <= k[1] <= count):
            _fail(f"{_label(k)}: inverter must be numbered 1..{count} and cannot be removed", 422)
        result[k] = c.day
    return result


def _validate_inverters(rules, count):
    nums = {k[1] for k in rules if k[0] == "Inverter"}
    if nums != set(range(1, count + 1)):
        _fail(f"Inverter numbers must be contiguous 1..{count}; found {sorted(nums)} (pm_unit_config)", 422)


def _target_months(payload, selected, generated, today):
    if selected < START_MONTH:
        _fail("PM schedules start in December 2026", 422)
    if payload.mode == "create":
        if payload.scope != "future":
            _fail("Create requires recurring scope", 422)
        return generated
    if payload.scope == "month":
        if selected not in generated:
            _fail("Selected month has not been generated; use recurring scope or generate it first")
        return [selected]
    effective = max(START_MONTH, today.replace(day=1))
    if selected != effective:
        _fail(f"From now on starts {effective:%Y-%m}; select that period or use this month only")
    # ensure_month uses current rules for missing months. Never rewrite a historical gap.
    probe = START_MONTH
    while probe < effective:
        if probe not in generated:
            _fail(f"Historical month {probe:%Y-%m} is missing; generate it before changing recurring rules")
        probe = _add_months(probe, 1)
    return [m for m in generated if m >= effective]


def _read_activities(db, pid, months, rules, lock=False):
    if not months:
        return {}, set()
    stmt = select(PMTrackingActivity).where(PMTrackingActivity.plant_id == pid,
        PMTrackingActivity.scheduled_on >= min(months), PMTrackingActivity.scheduled_on < _add_months(max(months), 1))
    rows = list(db.scalars(stmt.with_for_update() if lock else stmt))
    # Single bounded photo lookup, no per-row queries.
    photos = set(db.scalars(select(SitePhoto.link_id).where(SitePhoto.plant_id == pid, SitePhoto.link_type == "pm")))
    result = {}
    inverter_ids = {r["equipment_id"]: k for k, r in rules.items() if k[0] == "Inverter"}
    for row in rows:
        month = row.scheduled_on.replace(day=1)
        if month not in months:
            continue
        k = _activity_key(row, rules, inverter_ids)
        index = (month, k)
        if index in result:
            _fail(f"{month:%Y-%m}: multiple activities for {_label(k)}; reconcile the collision first")
        result[index] = row
    return result, photos


def _legacy_conflict(tasks, month, key):
    return any((task.task_type or "").strip().lower() in ALIASES[key[0]] and
        any(d and d.replace(day=1) == month for d in (task.due_on, task.planned_due_on, task.start_on)) for task in tasks)


def _plan_operations(months, changes, rules, activities, photos, tasks):
    operations, refused = [], []
    for month in months:
        for k, day in changes.items():
            row = activities.get((month, k))
            target = _date(month, day) if day is not None else None
            if (row is None and target is None) or (row is not None and row.scheduled_on == target):
                continue
            detail = {"month": month.strftime("%Y-%m"), "equipment": _label(k),
                "from": row.scheduled_on.isoformat() if row else None, "to": target.isoformat() if target else None}
            if row is not None and _protected(row, photos):
                refused.append({**detail, "reason": "Activity already started, reviewed, permitted or has evidence"})
                continue
            if target is not None and _legacy_conflict(tasks, month, k):
                refused.append({**detail, "reason": "Overlapping legacy PM work order"})
                continue
            equipment_id = row.equipment_id if row else rules.get(k, {}).get("equipment_id", _new_id(k))
            operations.append((k, row, target, equipment_id, detail))
    return operations, refused


def _prepare(db, plant, payload, lock=False):
    selected, _ = _bounds(payload.month)
    count = _unit_count(db, plant.id, lock)
    rules = _rule_map(_rule_rows(db, plant.id))
    generated = _months(db)
    months = _target_months(payload, selected, generated, business_today())
    changes = _changes(payload, count)
    if payload.mode == "create":
        if rules:
            _fail("Plant already has recurring PM rules; use Edit")
        if db.scalar(select(PMTrackingActivity.id).where(PMTrackingActivity.plant_id == plant.id).limit(1)):
            _fail("Plant already has PM activity history; creation refused")
        if db.scalar(select(OMTask.id).where(OMTask.plant_id == plant.id).limit(1)):
            _fail("Plant already has legacy PM work orders; reconcile history before creation")
        if any(day is None for day in changes.values()) or set(k[0] for k in changes) != set(CHECKLISTS):
            _fail("Creation requires every inverter and all eight single-visit equipment types", 422)
        _validate_inverters(changes, count)
    else:
        if not rules:
            _fail("No recurring PM rules exist; use Create")
        _validate_inverters(rules, count)
    activities, photos = _read_activities(db, plant.id, months, rules, lock)
    tasks = list(db.scalars(select(OMTask).options(load_only(OMTask.task_type, OMTask.due_on, OMTask.planned_due_on, OMTask.start_on)).where(OMTask.plant_id == plant.id))) if months else []
    ops, refused = _plan_operations(months, changes, rules, activities, photos, tasks)
    # Rule changes are explicit; a protected occurrence stays at its original date,
    # but later occurrences follow the new rule. Current month-only never changes rules.
    rule_changes = []
    if payload.scope == "future":
        for k, day in changes.items():
            old = rules.get(k)
            if (old["day_no"] if old else None) != day:
                rule_changes.append({"equipment": _label(k), "from_day": old["day_no"] if old else None, "to_day": day})
    details = [op[-1] for op in ops]
    public = {"months": [m.strftime("%Y-%m") for m in months], "changes": details,
        "refused": refused, "rule_changes": rule_changes, "scope": payload.scope}
    fingerprint = {**public, "plant": str(plant.id), "mode": payload.mode, "month": payload.month,
        "requested": [c.model_dump() for c in payload.changes], "existing_rules": list(rules.values()),
        "rows": sorted((str(r.id), r.scheduled_on.isoformat(), r.status, r.permission, _protected(r, photos)) for r in activities.values())}
    public["token"] = sha256(json.dumps(fingerprint, sort_keys=True).encode()).hexdigest()
    return public, ops, rules, changes, months


@router.get("")
def plants(db: DB, user: Actor):
    _schedule_manager(user); _ready(db)
    return [{"site_code": code, "name": name} for code, name in db.execute(select(Plant.site_code, Plant.plant_name)
        .where(or_(Plant.status.is_(None), func.lower(Plant.status) != "inactive")).order_by(Plant.plant_name))]


@router.get("/{site_code}")
def read_schedule(site_code: str, month: str, db: DB, user: Actor):
    _schedule_manager(user); _ready(db)
    p = _plant(db, site_code)
    selected, _ = _bounds(month)
    count = _unit_count(db, p.id)
    rules = _rule_map(_rule_rows(db, p.id))
    generated = _months(db)
    activities, photos = _read_activities(db, p.id, [selected], rules)
    items = []
    for k in [*(('Inverter', n) for n in range(1, count+1)), *((e, None) for e in SINGLE)]:
        rule = rules.get(k)
        row = activities.get((selected, k))
        items.append({"equipment": k[0], "inverter_no": k[1], "rule_day": rule["day_no"] if rule else None,
            "day": row.scheduled_on.day if row else None, "protected": bool(row and _protected(row, photos)),
            "equipment_id": row.equipment_id if row else rule["equipment_id"] if rule else _new_id(k)})
    return {"site_code": p.site_code, "name": p.plant_name, "inverter_count": count, "exists": bool(rules),
        "month_generated": selected in generated, "items": items, "start_month": START_MONTH.strftime("%Y-%m"),
        "effective_month": max(START_MONTH, business_today().replace(day=1)).strftime("%Y-%m")}


@router.post("/{site_code}/preview", dependencies=[Depends(require_csrf)])
def preview(site_code: str, payload: ScheduleRequest, db: DB, user: Actor):
    _schedule_manager(user); _ready(db)
    db.execute(text("SET LOCAL statement_timeout = '10s'"))
    return _prepare(db, _plant(db, site_code), payload)[0]


def _sync_legacy_marker(db, plant, rules, user):
    """Keep old planning metadata recognizable; tracking rows remain the date authority."""
    plan = db.scalar(select(PMCyclePlan).where(PMCyclePlan.plant_id == plant.id).with_for_update())
    if plan is None:
        plan = PMCyclePlan(plant_id=plant.id, phases=[]); db.add(plan)
    notes = plan.notes or ""
    if "[PM_TRACKING_START=" not in notes:
        notes += "\n[PM_TRACKING_START=2026-12-01]"
    if "[PM_PORTAL_EDITOR]" not in notes:
        notes += "\n[PM_PORTAL_EDITOR]"
    plan.notes = notes.strip()
    plan.updated_by = user.id
    # Preserve phase data for unrelated legacy equipment, but remove stale covered phases.
    # Legacy cycle engine cannot accurately represent grouped/irregular inverter days.
    phases = [p for p in (plan.phases or []) if p.get("phase") not in CHECKLISTS]
    for equipment in CHECKLISTS:
        days = [r["day_no"] for k, r in rules.items() if k[0] == equipment]
        if days:
            phases.append({"phase": equipment, "area": "GSS side" if equipment == "GSS visit" else "Plant side",
                "categories": PHASE_CATEGORIES[equipment], "start_day": min(days), "days": None if equipment == "Inverter" else 1,
                "step_days": 1, **({"days_list": days} if equipment == "Inverter" else {})})
    plan.phases = sorted(phases, key=lambda p: p["start_day"])


@router.post("/{site_code}/save", dependencies=[Depends(require_csrf)])
def save(site_code: str, payload: ScheduleRequest, db: DB, user: Actor):
    _schedule_manager(user); _ready(db)
    try:
        _lock(db)
        plant = _plant(db, site_code, True)
        result, ops, rules, changes, months = _prepare(db, plant, payload, True)
        if not payload.token or payload.token != result["token"]:
            _fail("Schedule or activity history changed after preview. Preview again before saving.")
        pid = str(plant.id)
        if payload.scope == "future":
            for k, day in changes.items():
                old = rules.get(k)
                if old and day is None:
                    db.execute(text("DELETE FROM solar91_pm.monthly_rules WHERE plant_id=CAST(:pid AS uuid) AND equipment=:equipment AND equipment_id=:equipment_id"), {"pid": pid, **{f: old[f] for f in ("equipment", "equipment_id")}})
                    del rules[k]
                elif day is not None and (not old or old["day_no"] != day):
                    r = {"equipment": k[0], "equipment_id": old["equipment_id"] if old else _new_id(k), "day_no": day, "inverter_no": k[1]}
                    db.execute(text("""INSERT INTO solar91_pm.monthly_rules(plant_id,equipment,equipment_id,day_no,inverter_no)
                        VALUES(CAST(:pid AS uuid),:equipment,:equipment_id,:day_no,:inverter_no)
                        ON CONFLICT(plant_id,equipment,equipment_id) DO UPDATE SET day_no=EXCLUDED.day_no"""), {"pid": pid, **r})
                    rules[k] = r
        inserted = {}
        for k, row, target, equipment_id, detail in ops:
            if row is None:
                db.add(PMTrackingActivity(plant_id=plant.id, equipment=k[0], equipment_id=equipment_id, scheduled_on=target))
                inserted[detail["month"]] = inserted.get(detail["month"], 0) + 1
            elif target is None:
                db.delete(row)
            else:
                row.scheduled_on = target
                row.updated_at = datetime.now(timezone.utc)
        db.flush()
        if result["rule_changes"]:
            _sync_legacy_marker(db, plant, rules, user)
        # Actual ledger count, not a hardcoded 33-plant or 556-activity target.
        if ops:
            touched = sorted({detail["month"] for *_, detail in ops})
            db.execute(text("""UPDATE solar91_pm.generated_months g SET activity_count=(
                SELECT count(*) FROM public.pm_tracking_activities a WHERE a.scheduled_on>=g.month_start
                AND a.scheduled_on<(g.month_start+interval '1 month')::date), inserted_count=g.inserted_count+:added
                WHERE g.month_start=CAST(:month AS date)"""), [{"month": m+"-01", "added": inserted.get(m, 0)} for m in touched])
        db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="PM schedule: "+payload.mode,
            module="Preventive Maintenance", entity_type="pm_schedule", entity_id=pid,
            before_state={"scope": payload.scope}, after_state={"changes": result["changes"], "rule_changes": result["rule_changes"], "refused": result["refused"]},
            metadata_json={"month": payload.month, "months": result["months"]}))
        db.commit()
    except IntegrityError:
        db.rollback(); _fail("Schedule collision detected; no changes saved. Preview again.")
    except DBAPIError:
        db.rollback(); _fail("Database rejected the schedule or is busy; no changes saved. Verify recurring schema and retry.", 503)
    except HTTPException:
        db.rollback(); raise
    # Cache failure must not report a committed transaction as a failed save.
    try:
        from app.scheduled.washing_cycles import invalidate_overview_cache
        from app.issues.router import invalidate_pulse_cache
        invalidate_overview_cache(); invalidate_pulse_cache()
    except Exception:
        import logging
        logging.getLogger(__name__).warning("PM schedule committed; cache invalidation failed")
    return result
