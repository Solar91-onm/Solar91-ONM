"""Preventive Maintenance planning: templates, quick add, and Excel plan import.

One code path builds tasks (`_plan_tasks` + `_create_tasks`) for all three entry points:
  * POST /api/pm-plan/tasks                 - "Add PM task" form (optionally saves a template)
  * POST /api/pm-plan/templates/{id}/apply  - run a saved template on chosen plants
  * POST /api/pm-plan/import                - Excel plan (dry_run first, then commit)

A task is created per plant, and per equipment unit when `per_unit` is on. Units come from the
Equipment Register (a row with quantity N counts as N units); if the register has none, the
sheet's "No. of units" is used; otherwise one task per plant.
"""
from __future__ import annotations

import io
import csv
import uuid
from datetime import date, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from openpyxl import load_workbook
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.timeutil import business_today, log_stamp
from app.core.database import get_db
from app.core.models import AuditLog, Equipment, OMTask, NotificationPreference, PMScopeConfig, PMTemplate, PMUnitConfig, Plant, User
from app.core.security import equipment_scope_matches, get_current_user, require_csrf, user_scoped_plant_ids
from app.plants.codes import find_plant_by_code
from app.pmplan.alerts import PM_ALERT_EVENTS, PM_TEAM_RECIPIENT_MODES, default_pm_preferences, get_pm_preferences
from app.pmplan.units import distribute, next_cycle_id, run_daily  # noqa: F401  (next_cycle_id re-exported for the scheduled router)
from app.scheduled.schemas import ALLOWED_ASSETS, ALLOWED_FREQUENCIES

router = APIRouter(prefix="/api/pm-plan", tags=["Preventive Maintenance plan"])

SAFETY_OPTIONS = ["—", "PTW required", "LOTO required", "PTW + LOTO required"]
PLANNER_ROLES = {"O&M Head"}          # templates, apply, Excel import
CREATOR_ROLES = {"O&M Head", "Assignee"}  # quick add (Assignee: own equipment types only)
TEMPLATE_WRITERS = {"O&M Head"}
MAX_TASKS_PER_CALL = 2000
_ASSET_BY_LOWER = {a.casefold(): a for a in ALLOWED_ASSETS}
_FREQ_BY_LOWER = {f.casefold(): f for f in ALLOWED_FREQUENCIES}
_SAFETY_BY_LOWER = {s.casefold(): s for s in SAFETY_OPTIONS}


class PMAlertEventPreference(BaseModel):
    enabled: bool
    in_app: bool
    email: bool


class PMAlertPreferencesIn(BaseModel):
    plant_id: uuid.UUID | None = None
    events: dict[str, PMAlertEventPreference] = Field(default_factory=dict)
    team_who: Literal["assignee_only", "assignee_and_head", "whole_team"] | None = None


# ───────────────────────── schemas ─────────────────────────
class Check(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    unit: str | None = Field(default=None, max_length=40)
    min: float | None = None
    max: float | None = None


class TemplateIn(BaseModel):
    equipment_type: str
    task_name: str = Field(min_length=2, max_length=255)
    steps: str | None = None
    frequency: str = "Monthly"
    safety: str = "—"
    est_hours: float | None = Field(default=None, ge=0, le=999)
    tools: str | None = None
    checks: list[Check] = Field(default_factory=list)
    units_per_day: int | None = Field(default=None, ge=1, le=500)   # default daily capacity; the plant configuration wins

    @field_validator("equipment_type")
    @classmethod
    def _type(cls, v: str) -> str:
        key = (v or "").strip().casefold()
        if key not in _ASSET_BY_LOWER:
            raise ValueError("Unsupported equipment type")
        return _ASSET_BY_LOWER[key]

    @field_validator("frequency")
    @classmethod
    def _freq(cls, v: str) -> str:
        key = (v or "").strip().casefold()
        if key not in _FREQ_BY_LOWER:
            raise ValueError("Unsupported frequency")
        return _FREQ_BY_LOWER[key]

    @field_validator("safety")
    @classmethod
    def _safety(cls, v: str) -> str:
        key = (v or "—").strip().casefold() or "—"
        if key in {"-", "none", "n/a"}:
            key = "—"
        if key not in _SAFETY_BY_LOWER:
            raise ValueError("Unsupported safety option")
        return _SAFETY_BY_LOWER[key]


class ApplyIn(BaseModel):
    plants: list[str] = Field(min_length=1)          # site codes, names, ids, or "All plants"
    start_date: date
    assignees: list[str] = Field(default_factory=list)
    per_unit: bool = True
    units: int | None = Field(default=None, ge=1, le=500)   # legacy alias of total_units (fallback when the register is empty)
    total_units: int | None = Field(default=None, ge=1, le=500)       # Number of Units (overrides the plant configuration)
    units_per_day: int | None = Field(default=None, ge=1, le=500)     # max units maintained per day (overrides it too)
    unit_numbers: list[int] | None = None                              # subset of units to maintain this cycle
    save_unit_config: bool = False                                     # O&M Head: store total/per-day as the plant default
    dry_run: bool = False


class QuickTaskIn(TemplateIn, ApplyIn):
    save_template: bool = False


# ───────────────────────── helpers ─────────────────────────
def _require(user: User, roles: set[str], message: str) -> None:
    if user.role not in roles:
        raise HTTPException(403, message)


def _template_out(t: PMTemplate) -> dict[str, Any]:
    return {
        "id": str(t.id), "equipment_type": t.equipment_type, "task_name": t.task_name, "steps": t.steps,
        "frequency": t.frequency, "safety": t.safety or "—",
        "est_hours": float(t.est_hours) if t.est_hours is not None else None,
        "tools": t.tools, "checks": list(t.checks or []), "units_per_day": t.units_per_day,
    }


def _tpl_dict(data: TemplateIn) -> dict[str, Any]:
    return {
        "equipment_type": data.equipment_type, "task_name": data.task_name.strip(), "steps": (data.steps or "").strip() or None,
        "frequency": data.frequency, "safety": data.safety, "est_hours": data.est_hours,
        "tools": (data.tools or "").strip() or None, "checks": [c.model_dump() for c in data.checks],
        "units_per_day": data.units_per_day,
    }


def _resolve_plants(db: Session, values: list[str]) -> list[Plant]:
    vals = [v.strip() for v in values if v and v.strip()]
    if any(v.casefold() in {"all", "all plants"} for v in vals):
        return [p for p in db.scalars(select(Plant).order_by(Plant.site_code)) if (p.status or "").casefold() != "inactive"]
    found: dict[Any, Plant] = {}
    missing: list[str] = []
    for v in vals:
        plant = None
        try:
            plant = db.get(Plant, uuid.UUID(v))
        except Exception:
            plant = None
        if plant is None:
            plant = find_plant_by_code(db, v)
        if plant is None:
            plant = db.scalar(select(Plant).where(func.lower(Plant.plant_name) == v.casefold()))
        if plant is None:
            missing.append(v)
        else:
            found[plant.id] = plant
    if missing:
        raise HTTPException(422, f"Plant not found: {', '.join(missing)}")
    return list(found.values())


def _register_refs(db: Session, plant: Plant, equipment_type: str) -> list[str]:
    rows = db.scalars(select(Equipment).where(
        Equipment.plant_id == plant.id, func.lower(Equipment.equipment_type) == equipment_type.casefold(),
        Equipment.status != "inactive").order_by(Equipment.equipment_code, Equipment.equipment_name))
    refs: list[str] = []
    for eq in rows:
        base = eq.equipment_code or eq.equipment_name
        n = eq.quantity or 1
        refs.extend([base] if n <= 1 else [f"{base}-{i:02d}" for i in range(1, n + 1)])
    return refs


def _plant_config(db: Session, plant: Plant, equipment_type: str) -> PMUnitConfig | None:
    return db.scalar(select(PMUnitConfig).where(
        PMUnitConfig.plant_id == plant.id, func.lower(PMUnitConfig.equipment_type) == equipment_type.casefold()))


def _units_for(db: Session, plant: Plant, tpl: dict[str, Any], per_unit: bool, units_hint: int | None,
               plan: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Units to schedule for one plant: [{ref, unit_no, total, day}].

    Total units: request override > plant configuration > Equipment Register > legacy hint.
    Units per day: request override > plant configuration > template default > everything on day 1.
    """
    plan = plan or {}
    etype = tpl["equipment_type"]
    if not per_unit:
        return [{"ref": None, "unit_no": None, "total": None, "day": None}]
    cfg = _plant_config(db, plant, etype)
    refs = _register_refs(db, plant, etype)
    total = plan.get("total_units") or (cfg.total_units if cfg else None) or len(refs) or units_hint or 0
    if total <= 1 and not refs and not (cfg or plan.get("total_units")):
        return [{"ref": None, "unit_no": None, "total": None, "day": None}]     # nothing known: one task, as before
    total = max(1, total)
    per_day = plan.get("units_per_day") or (cfg.units_per_day if cfg else None) or tpl.get("units_per_day")
    nums = plan.get("unit_numbers") or list(range(1, total + 1))
    bad = [n for n in nums if n < 1 or n > total]
    if bad:
        raise HTTPException(422, f"Unit number(s) {sorted(set(bad))} are outside 1–{total} for {plant.plant_name}")
    nums = sorted(set(nums))
    if per_day and per_day > total:
        raise HTTPException(422, f"Units per day ({per_day}) cannot exceed the number of units ({total}) for {plant.plant_name}")

    return [{"ref": None, "unit_no": n, "total": total, "day": d, "offset": d - 1}
            for n, d, _ in distribute(nums, per_day, date(2000, 1, 1))]


def _checks_text(checks: list[dict[str, Any]]) -> str:
    lines = []
    for c in checks or []:
        limits = []
        if c.get("min") is not None:
            limits.append(f"min {c['min']:g}")
        if c.get("max") is not None:
            limits.append(f"max {c['max']:g}")
        extra = ", ".join(x for x in [c.get("unit") or "", *limits] if x)
        lines.append(f"• {c['name']}" + (f" ({extra})" if extra else ""))
    return "\n".join(lines)


def _find_user(db: Session, cache: dict[str, User | None], name: str) -> User | None:
    key = name.strip().casefold()
    if key not in cache:
        cache[key] = db.scalar(select(User).where(
            User.is_active.is_(True), (func.lower(User.display_name) == key) | (func.lower(User.email) == key)))
    return cache[key]


def _plan_tasks(db: Session, user: User, plants: list[Plant], tpl: dict[str, Any], assignees: list[str],
                per_unit: bool, units_hint: int | None, seen: set[tuple[Any, str, int | None]],
                users_cache: dict[str, User | None], plan: dict[str, Any] | None = None) -> tuple[list[dict[str, Any]], int]:
    """Work out which tasks to create. Writes nothing. Returns (items, skipped_existing)."""
    assignees = [a.strip() for a in assignees if a and a.strip()]
    people = [(a, _find_user(db, users_cache, a)) for a in assignees]
    base_name = tpl["task_name"]
    open_units: set[tuple[Any, int]] = set()
    open_without_units: set[Any] = set()
    for row in db.execute(select(OMTask.plant_id, OMTask.task_name, OMTask.unit_no).where(
            OMTask.task_name.like(base_name + "%"), OMTask.status.not_in(["Completed", "Cancelled"]))):
        if row.task_name == base_name or row.task_name.startswith(base_name + " — "):
            if row.unit_no is None:
                open_without_units.add(row.plant_id)
            else:
                open_units.add((row.plant_id, row.unit_no))
    items: list[dict[str, Any]] = []
    skipped = 0
    n = 0
    for plant_idx, plant in enumerate(plants):
        # One assignee looks after every unit of the equipment at a plant; several assignees share plants.
        who, who_user = people[plant_idx % len(people)] if people else (None, None)
        cycle_id = uuid.uuid4().hex[:8]
        if user.role == "Assignee" and not equipment_scope_matches(db, user, plant.id, None, None, tpl["equipment_type"]):
            raise HTTPException(403, f"{tpl['equipment_type']} is outside your assigned equipment types")
        for p_name, p_user in people:
            if p_user and p_user.role == "Assignee" and not equipment_scope_matches(
                    db, p_user, plant.id, None, None, tpl["equipment_type"]):
                raise HTTPException(422, f"{p_name} is not assigned to {tpl['equipment_type']}")
        for u in _units_for(db, plant, tpl, per_unit, units_hint, plan):
            ref = u["ref"]
            name = base_name
            unit_no = u["unit_no"]
            key = (plant.id, name, unit_no)
            if plant.id in open_without_units or (unit_no is not None and (plant.id, unit_no) in open_units) or key in seen:
                skipped += 1
                continue
            seen.add(key)
            n += 1
            items.append({"plant": plant, "name": name, "ref": ref, "assignee": who, "assignee_user": who_user,
                          "unit_no": u["unit_no"], "total_units": u["total"], "day": u["day"], "cycle_id": cycle_id if u["unit_no"] else None})
            if len(items) > MAX_TASKS_PER_CALL:
                raise HTTPException(422, f"Too many tasks in one go (limit {MAX_TASKS_PER_CALL}). Pick fewer plants.")
    return items, skipped


def _create_tasks(db: Session, user: User, tpl: dict[str, Any], items: list[dict[str, Any]], start: date,
                  template_id: str | None) -> None:
    hours = tpl.get("est_hours")
    sop = (tpl.get("steps") or "").strip()
    checks = tpl.get("checks") or []
    if checks:
        sop = (sop + "\n\n" if sop else "") + "Readings to record:\n" + _checks_text(checks)
    first_by_user: dict[Any, str] = {}
    counts: dict[Any, int] = {}
    quantity_by_plant: dict[Any, int | None] = {}
    for it in items:
        due = start + timedelta(days=(it.get("day") or 1) - 1)
        wo = "WO-" + uuid.uuid4().hex[:10].upper()
        who_user: User | None = it["assignee_user"]
        if it["plant"].id not in quantity_by_plant:
            quantity_by_plant[it["plant"].id] = db.scalar(select(func.sum(Equipment.quantity)).where(
                Equipment.plant_id == it["plant"].id,
                func.lower(Equipment.equipment_type) == tpl["equipment_type"].casefold(),
                Equipment.status != "inactive",
            ))
        registered_quantity = quantity_by_plant[it["plant"].id]
        db.add(OMTask(
            work_order_no=wo, plant_id=it["plant"].id, task_name=it["name"], task_type=tpl["equipment_type"],
            equipment_ref=it["ref"], frequency=tpl["frequency"], due_on=due, start_on=start, assignee_text=it["assignee"],
            quantity=it.get("total_units") if it.get("unit_no") is not None else registered_quantity,
            unit_no=it.get("unit_no"), total_units=it.get("total_units"), cycle_id=it.get("cycle_id"),
            cycle_day=it.get("day"), planned_due_on=due if it.get("unit_no") else None,
            assignee_user_id=who_user.id if who_user else None, status="Scheduled", sop=sop or None,
            safety=tpl.get("safety") or "—", tools=tpl.get("tools"),
            duration=f"{hours:g} hrs" if hours else "2 hrs", completion=None, evidence=[],
            problem_source="PM template",
            log=[{"at": log_stamp(),
                  "text": "Created from PM plan" + (f" — {it['day']} day workload" if it.get("unit_no") else ""),
                  "actor": user.display_name}],
            legacy_payload={"template_id": template_id, "checks": checks}, created_by=user.id))
        if who_user:
            first_by_user.setdefault(who_user.id, wo)
            counts[who_user.id] = counts.get(who_user.id, 0) + 1
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Created PM tasks from plan", module="Scheduled O&M",
                    metadata_json={"equipment_type": tpl["equipment_type"], "task": tpl["task_name"], "count": len(items)}))
    db.flush()
    try:
        from app.notifications.service import create_notification
        batch = uuid.uuid4().hex[:8]
        for uid, n in counts.items():
            create_notification(db, user_id=uid, event_type="task_assigned",
                                title=f"{n} PM task(s) assigned — {tpl['task_name']}",
                                message=f"{tpl['equipment_type']} · first due {start.isoformat()}",
                                target_type="task", target_id=first_by_user[uid], dedupe_key=f"pm-plan:{batch}:{uid}")
    except Exception:  # notifications must never block planning
        pass


def _summary(items: list[dict[str, Any]], skipped: int, dry_run: bool, db: Session | None = None,
             tpl: dict[str, Any] | None = None) -> dict[str, Any]:
    days: dict[Any, set[int]] = {}
    for i in items:
        if i.get("day"):
            days.setdefault(i["plant"].id, set()).add(i["day"])
    legacy = 0     # open tasks for this job created before unit scheduling: left untouched, but flagged
    if db is not None and tpl is not None and items:
        legacy = db.scalar(select(func.count(OMTask.id)).where(
            OMTask.plant_id.in_({i["plant"].id for i in items}), OMTask.task_type == tpl["equipment_type"],
            OMTask.task_name.like(tpl["task_name"] + "%"), OMTask.status != "Completed", OMTask.unit_no.is_(None))) or 0
    return {
        "dry_run": dry_run, "count": len(items), "skipped": skipped,
        "plants": len({i["plant"].id for i in items}),
        "days": max((len(v) for v in days.values()), default=0),
        "open_without_units": legacy,
        "sample": [{"plant": i["plant"].site_code, "name": i["name"], "assignee": i["assignee"],
                    "unit_no": i.get("unit_no"), "day": i.get("day")} for i in items[:8]],
    }


def _upsert_template(db: Session, user: User, tpl: dict[str, Any]) -> PMTemplate:
    row = db.scalar(select(PMTemplate).where(
        func.lower(PMTemplate.equipment_type) == tpl["equipment_type"].casefold(),
        func.lower(PMTemplate.task_name) == tpl["task_name"].casefold()))
    if row is None:
        row = PMTemplate(equipment_type=tpl["equipment_type"], task_name=tpl["task_name"], created_by=user.id)
        db.add(row)
    row.steps, row.frequency, row.safety = tpl["steps"], tpl["frequency"], tpl["safety"]
    row.est_hours, row.tools, row.checks = tpl["est_hours"], tpl["tools"], tpl["checks"]
    row.units_per_day = tpl.get("units_per_day")
    db.flush()
    return row


def _plan_of(payload: ApplyIn) -> dict[str, Any]:
    return {"total_units": payload.total_units, "units_per_day": payload.units_per_day,
            "unit_numbers": payload.unit_numbers}


def _save_config(db: Session, user: User, plant: Plant, etype: str, total: int | None, per_day: int | None) -> PMUnitConfig | None:
    if not total or not per_day:
        return None
    if per_day > total:
        raise HTTPException(422, "Units per day cannot exceed the number of units")
    row = _plant_config(db, plant, etype)
    if row is None:
        row = PMUnitConfig(plant_id=plant.id, equipment_type=etype, total_units=total, units_per_day=per_day)
        db.add(row)
    row.total_units, row.units_per_day, row.updated_by = total, per_day, user.id
    db.flush()
    return row


# ───────────────────────── templates ─────────────────────────
@router.get("/templates")
def list_templates(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    _require(user, CREATOR_ROLES, "PM templates are available to the O&M Head and Assignees")
    rows = db.scalars(select(PMTemplate).order_by(PMTemplate.equipment_type, PMTemplate.task_name))
    return [_template_out(t) for t in rows]


@router.post("/templates", status_code=201, dependencies=[Depends(require_csrf)])
def create_template(payload: TemplateIn, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    _require(user, TEMPLATE_WRITERS, "Only the O&M Head can manage PM templates")
    tpl = _tpl_dict(payload)
    exists = db.scalar(select(PMTemplate.id).where(
        func.lower(PMTemplate.equipment_type) == tpl["equipment_type"].casefold(),
        func.lower(PMTemplate.task_name) == tpl["task_name"].casefold()))
    if exists:
        raise HTTPException(409, "A template with this equipment type and task name already exists")
    row = _upsert_template(db, user, tpl)
    db.commit()
    return _template_out(row)


@router.put("/templates/{template_id}", dependencies=[Depends(require_csrf)])
def update_template(template_id: uuid.UUID, payload: TemplateIn, db: Annotated[Session, Depends(get_db)],
                    user: Annotated[User, Depends(get_current_user)]):
    _require(user, TEMPLATE_WRITERS, "Only the O&M Head can manage PM templates")
    row = db.get(PMTemplate, template_id)
    if not row:
        raise HTTPException(404, "Template not found")
    tpl = _tpl_dict(payload)
    row.equipment_type, row.task_name = tpl["equipment_type"], tpl["task_name"]
    row.steps, row.frequency, row.safety = tpl["steps"], tpl["frequency"], tpl["safety"]
    row.est_hours, row.tools, row.checks = tpl["est_hours"], tpl["tools"], tpl["checks"]
    row.units_per_day = tpl.get("units_per_day")
    db.commit()
    return _template_out(row)


@router.delete("/templates/{template_id}", status_code=204, dependencies=[Depends(require_csrf)])
def delete_template(template_id: uuid.UUID, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    _require(user, TEMPLATE_WRITERS, "Only the O&M Head can manage PM templates")
    row = db.get(PMTemplate, template_id)
    if not row:
        raise HTTPException(404, "Template not found")
    db.delete(row)  # tasks already created keep their own copy of the steps/readings
    db.commit()


@router.post("/templates/{template_id}/apply", dependencies=[Depends(require_csrf)])
def apply_template(template_id: uuid.UUID, payload: ApplyIn, db: Annotated[Session, Depends(get_db)],
                   user: Annotated[User, Depends(get_current_user)]):
    _require(user, PLANNER_ROLES, "Only the O&M Head can bulk-create PM tasks")
    row = db.get(PMTemplate, template_id)
    if not row:
        raise HTTPException(404, "Template not found")
    tpl = {k: v for k, v in _template_out(row).items() if k != "id"}
    plants = _resolve_plants(db, payload.plants)
    items, skipped = _plan_tasks(db, user, plants, tpl, payload.assignees, payload.per_unit, payload.units, set(), {}, _plan_of(payload))
    if not payload.dry_run and items:
        _create_tasks(db, user, tpl, items, payload.start_date, str(row.id))
        db.commit()
    return _summary(items, skipped, payload.dry_run, db, tpl)


# ───────────────────────── quick add ("Add PM task") ─────────────────────────
@router.post("/tasks", dependencies=[Depends(require_csrf)])
def quick_add(payload: QuickTaskIn, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    _require(user, CREATOR_ROLES, "Only the O&M Head and Assignees can add PM tasks")
    if payload.save_template:
        _require(user, TEMPLATE_WRITERS, "Only the O&M Head can save PM templates")
    tpl = _tpl_dict(payload)
    plants = _resolve_plants(db, payload.plants)
    if payload.save_unit_config:
        _require(user, TEMPLATE_WRITERS, "Only the O&M Head can save plant unit configuration")
    items, skipped = _plan_tasks(db, user, plants, tpl, payload.assignees, payload.per_unit, payload.units, set(), {}, _plan_of(payload))
    if not payload.dry_run and items:
        tid = str(_upsert_template(db, user, tpl).id) if payload.save_template else None
        _create_tasks(db, user, tpl, items, payload.start_date, tid)
        if payload.save_unit_config:
            for plant in plants:
                _save_config(db, user, plant, tpl["equipment_type"], payload.total_units, payload.units_per_day or tpl.get("units_per_day"))
        db.commit()
    return _summary(items, skipped, payload.dry_run, db, tpl)


# ───────────────────────── maintenance scope library (editable by the O&M Head) ─────────────────────────
SCOPE_KEYS = ("pv", "plant", "gss")      # everything else is Miscellaneous


class ScopeIn(BaseModel):
    sections: dict[str, list[str]]
    hidden: list[str] = Field(default_factory=list)

    @field_validator("sections")
    @classmethod
    def _sections(cls, v: dict[str, list[str]]) -> dict[str, list[str]]:
        if set(v) - set(SCOPE_KEYS):
            raise ValueError("Sections must be pv, plant or gss (Miscellaneous is everything else)")
        return {k: list(v.get(k, [])) for k in SCOPE_KEYS}


def _scope_clean(payload: ScopeIn) -> dict[str, Any]:
    seen: set[str] = set()
    sections: dict[str, list[str]] = {}
    for key in SCOPE_KEYS:
        out = []
        for name in payload.sections.get(key, []):
            canon = _ASSET_BY_LOWER.get((name or "").strip().casefold())
            if not canon:
                raise HTTPException(422, f"Unknown equipment type: {name}")
            if canon in seen:
                raise HTTPException(422, f"{canon} is listed in more than one section")
            seen.add(canon); out.append(canon)
        sections[key] = out
    hidden = []
    for name in payload.hidden:
        canon = _ASSET_BY_LOWER.get((name or "").strip().casefold())
        if not canon:
            raise HTTPException(422, f"Unknown equipment type: {name}")
        if canon in seen:
            raise HTTPException(422, f"{canon} cannot be both in a section and hidden")
        if canon not in hidden:
            hidden.append(canon)
    return {"sections": sections, "hidden": hidden}


@router.get("/scope")
def get_scope(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    _require(user, TEMPLATE_WRITERS, "Only the O&M Head can view the maintenance scope")
    row = db.scalar(select(PMScopeConfig))
    return {"customised": bool(row and row.config), **(row.config if row and row.config else {})}


@router.put("/scope", dependencies=[Depends(require_csrf)])
def save_scope(payload: ScopeIn, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    _require(user, TEMPLATE_WRITERS, "Only the O&M Head can edit the maintenance scope")
    cfg = _scope_clean(payload)
    row = db.scalar(select(PMScopeConfig))
    if row is None:
        row = PMScopeConfig(config=cfg, updated_by=user.id)
        db.add(row)
    row.config, row.updated_by = cfg, user.id
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Edited maintenance scope library", module="Scheduled O&M",
                    metadata_json={"hidden": cfg["hidden"], "sections": {k: len(v) for k, v in cfg["sections"].items()}}))
    db.commit()
    return {"customised": True, **cfg}


@router.delete("/scope", status_code=204, dependencies=[Depends(require_csrf)])
def reset_scope(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    _require(user, TEMPLATE_WRITERS, "Only the O&M Head can edit the maintenance scope")
    row = db.scalar(select(PMScopeConfig))
    if row:
        db.delete(row); db.commit()


# ───────────────────────── plant unit configuration ─────────────────────────
class UnitConfigIn(BaseModel):
    plant: str
    equipment_type: str
    total_units: int = Field(ge=1, le=500)
    units_per_day: int = Field(ge=1, le=500)

    @field_validator("equipment_type")
    @classmethod
    def _type(cls, v: str) -> str:
        key = (v or "").strip().casefold()
        if key not in _ASSET_BY_LOWER:
            raise ValueError("Unsupported equipment type")
        return _ASSET_BY_LOWER[key]


def _config_out(c: PMUnitConfig, plant: Plant | None) -> dict[str, Any]:
    cap = max(1, c.units_per_day)
    return {"id": str(c.id), "plant_id": str(c.plant_id), "plant": plant.plant_name if plant else "",
            "site_code": plant.site_code if plant else "", "equipment_type": c.equipment_type,
            "total_units": c.total_units, "units_per_day": c.units_per_day, "days": -(-c.total_units // cap)}


@router.get("/unit-config")
def list_unit_config(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    _require(user, CREATOR_ROLES, "Unit configuration is available to the O&M Head and Assignees")
    plants = {p.id: p for p in db.scalars(select(Plant))}
    allowed = user_scoped_plant_ids(db, user)
    def visible(pid: Any, equipment_type: str) -> bool:
        if allowed is not None and pid not in allowed:
            return False
        return user.role != "Assignee" or equipment_scope_matches(db, user, pid, None, None, equipment_type)
    configs = [_config_out(c, plants.get(c.plant_id)) for c in db.scalars(select(PMUnitConfig))
               if visible(c.plant_id, c.equipment_type)]
    register = [{"plant_id": str(pid), "equipment_type": et, "units": int(n or 0)} for pid, et, n in db.execute(
        select(Equipment.plant_id, Equipment.equipment_type, func.sum(Equipment.quantity))
        .where(Equipment.status != "inactive").group_by(Equipment.plant_id, Equipment.equipment_type))
        if et and visible(pid, et)]
    return {"configs": sorted(configs, key=lambda c: (c["plant"], c["equipment_type"])), "register": register}


@router.put("/unit-config", dependencies=[Depends(require_csrf)])
def save_unit_config(payload: UnitConfigIn, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    _require(user, {"O&M Head", "Assignee"}, "Only the O&M Head or an Assignee can edit plant unit configuration")
    plant = _resolve_plants(db, [payload.plant])[0]
    if user.role == "Assignee" and not equipment_scope_matches(db, user, plant.id, None, None, payload.equipment_type):
        raise HTTPException(403, f"{payload.equipment_type} is outside your assigned equipment types")
    row = _save_config(db, user, plant, payload.equipment_type, payload.total_units, payload.units_per_day)
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Saved PM unit configuration", module="Scheduled O&M",
                    metadata_json={"plant": plant.plant_name, "equipment_type": payload.equipment_type,
                                   "total_units": payload.total_units, "units_per_day": payload.units_per_day}))
    db.commit()
    return _config_out(row, plant)


@router.delete("/unit-config/{config_id}", status_code=204, dependencies=[Depends(require_csrf)])
def delete_unit_config(config_id: uuid.UUID, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    _require(user, {"O&M Head", "Assignee"}, "Only the O&M Head or an Assignee can edit plant unit configuration")
    row = db.get(PMUnitConfig, config_id)
    if not row:
        raise HTTPException(404, "Configuration not found")
    if user.role == "Assignee" and not equipment_scope_matches(db, user, row.plant_id, None, None, row.equipment_type):
        raise HTTPException(403, f"{row.equipment_type} is outside your assigned equipment types")
    db.delete(row)      # tasks already scheduled keep their unit numbers
    db.commit()


def _check_pm_alert_preference_scope(
    db: Session,
    user: User,
    plant_id: uuid.UUID | None,
    team_rule: bool = False,
) -> None:
    if user.role not in {"O&M Head", "Assignee"}:
        raise HTTPException(403, "Your role cannot access PM alert settings")
    if team_rule and user.role != "O&M Head":
        raise HTTPException(403, "Only the O&M Head can change team alert settings")
    if plant_id is None:
        return
    if not db.get(Plant, plant_id):
        raise HTTPException(404, "Plant not found")
    allowed = user_scoped_plant_ids(db, user)
    if allowed is not None and plant_id not in allowed:
        raise HTTPException(403, "This plant is outside your PM alert settings scope")


@router.get("/alert-preferences")
def get_alert_preferences(
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
    plant_id: uuid.UUID | None = None,
):
    _check_pm_alert_preference_scope(db, user, plant_id)
    return {
        "module": "pm",
        "plant_id": str(plant_id) if plant_id else None,
        "defaults": default_pm_preferences(),
        "preferences": get_pm_preferences(db, user.id, plant_id),
    }


@router.put("/alert-preferences", dependencies=[Depends(require_csrf)])
def save_alert_preferences(
    payload: PMAlertPreferencesIn,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    _check_pm_alert_preference_scope(
        db, user, payload.plant_id, team_rule="team_who" in payload.model_fields_set,
    )
    unknown_events = set(payload.events) - set(PM_ALERT_EVENTS)
    if unknown_events:
        raise HTTPException(422, f"Unknown PM alert event: {sorted(unknown_events)[0]}")
    criteria = [
        NotificationPreference.user_id == user.id,
        NotificationPreference.module == "pm",
    ]
    criteria.append(
        NotificationPreference.plant_id.is_(None)
        if payload.plant_id is None
        else NotificationPreference.plant_id == payload.plant_id
    )
    row = db.scalar(select(NotificationPreference).where(*criteria))
    if row is None:
        row = NotificationPreference(
            user_id=user.id, module="pm", plant_id=payload.plant_id, preferences={},
        )
        db.add(row)
    saved = dict(row.preferences or {})
    events = dict(saved.get("events") or {})
    for event, choice in payload.events.items():
        events[event] = choice.model_dump()
    saved["events"] = events
    if "team_who" in payload.model_fields_set:
        if payload.team_who is not None and payload.team_who not in PM_TEAM_RECIPIENT_MODES:
            raise HTTPException(422, "Choose a valid PM team recipient mode")
        saved["team_who"] = payload.team_who
    row.preferences = saved
    db.commit()
    return {
        "module": "pm",
        "plant_id": str(payload.plant_id) if payload.plant_id else None,
        "defaults": default_pm_preferences(),
        "preferences": get_pm_preferences(db, user.id, payload.plant_id),
    }


@router.post("/run-daily", dependencies=[Depends(require_csrf)])
def run_daily_now(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    """Roll missed units, send due reminders and escalations. Also runs automatically once a day."""
    _require(user, PLANNER_ROLES, "Only the O&M Head can run the daily PM job")
    return run_daily(db)


# ───────────────────────── Excel plan import ─────────────────────────
def _header_key(text: Any) -> str | None:
    h = str(text or "").strip().casefold()
    if not h:
        return None
    if "equipment" in h:
        return "type"
    if "plant" in h:
        return "plants"
    if "per day" in h or "per-day" in h or "/day" in h or "daily capacity" in h:
        return "perday"
    if "unit" in h or "no. of" in h or "count" in h or "quantity" in h:
        return "units"
    if "how" in h or "step" in h:
        return "steps"
    if "task" in h:
        return "task"
    if "freq" in h:
        return "frequency"
    if "start" in h or "first due" in h:
        return "start"
    if "assignee" in h:
        return "assignees"
    if "safety" in h:
        return "safety"
    if "time" in h or "hour" in h:
        return "hours"
    if "reading" in h or "parameter" in h or "check" in h:
        return "checks"
    return None


def _parse_date(value: Any) -> date | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    for fmt in ("%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            pass
    raise ValueError(f"Start date '{text}' is not DD-MM-YYYY or YYYY-MM-DD")


def _parse_checks(text: Any) -> list[dict[str, Any]]:
    """'Heatsink temp | C | | 75 ; Insulation | MOhm | 1' -> [{name, unit, min, max}]."""
    out: list[dict[str, Any]] = []
    for part in str(text or "").replace("\n", ";").split(";"):
        if not part.strip():
            continue
        cells = [c.strip() for c in part.split("|")] + ["", "", ""]
        name, unit, lo, hi = cells[0], cells[1], cells[2], cells[3]
        try:
            out.append({"name": name, "unit": unit or None, "min": float(lo) if lo else None, "max": float(hi) if hi else None})
        except ValueError:
            raise ValueError(f"Reading '{name}': min/max must be numbers") from None
    return out


def _read_plan(content: bytes) -> list[dict[str, Any]]:
    wb = load_workbook(io.BytesIO(content), data_only=True, read_only=True)
    ws = wb["PM Tasks"] if "PM Tasks" in wb.sheetnames else wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        raise HTTPException(422, "The sheet is empty")
    cols: dict[str, int] = {}
    for idx, head in enumerate(rows[0]):
        key = _header_key(head)
        if key and key not in cols:
            cols[key] = idx
    if "type" not in cols or "task" not in cols:
        raise HTTPException(422, "Could not find 'Equipment type' and 'Task' columns in row 1 of the PM Tasks sheet")
    out = []
    for n, raw in enumerate(rows[1:], start=2):
        cell = {k: (raw[i] if i < len(raw) else None) for k, i in cols.items()}
        if all(v in (None, "") for v in cell.values()):
            continue
        if str(cell.get("task") or "").strip().upper().startswith("EXAMPLE"):
            continue
        cell["row"] = n
        out.append(cell)
    return out


def _read_csv_plan(content: bytes) -> list[dict[str, Any]]:
    """Read RFC-4180 CSV with the same column names and validation as the Excel importer."""
    try:
        source = io.StringIO(content.decode("utf-8-sig"), newline="")
        rows = csv.reader(source, strict=True)
        headers = next(rows, None)
        if not headers:
            raise HTTPException(422, "The CSV file is empty")
        cols: dict[str, int] = {}
        for idx, name in enumerate(headers):
            key = _header_key(name)
            if key and key not in cols:
                cols[key] = idx
        if "type" not in cols or "task" not in cols:
            raise HTTPException(422, "CSV needs 'Equipment type' and 'Task' header columns")
        result = []
        for n, raw in enumerate(rows, start=2):
            if n > 5001:
                raise HTTPException(413, "Limit the CSV to 5000 data rows")
            cell = {k: (raw[i] if i < len(raw) else None) for k, i in cols.items()}
            if all(v in (None, "") for v in cell.values()):
                continue
            if str(cell.get("task") or "").strip().upper().startswith("EXAMPLE"):
                continue
            cell["row"] = n
            result.append(cell)
        return result
    except UnicodeDecodeError:
        raise HTTPException(422, "CSV must be UTF-8 encoded") from None
    except csv.Error:
        raise HTTPException(422, "Could not parse the CSV file; check quoting and delimiters") from None


def _clean_row(cell: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    errors: list[str] = []
    raw_type = cell.get("type")
    if isinstance(raw_type, (int, float)):
        errors.append(f"Equipment type is the number {raw_type:g}. Type the equipment here (e.g. Inverter, pick from the dropdown) and put the count "
                      f"in the 'No. of units' column (or set it under Unit configuration)")
        raw_type = None
    equipment_type = _ASSET_BY_LOWER.get(str(raw_type or "").strip().casefold())
    if raw_type is not None and not equipment_type:
        errors.append(f"Unknown equipment type '{raw_type}'")
    if raw_type is None and not errors:
        errors.append("Equipment type is empty")
    task = str(cell.get("task") or "").strip()
    if len(task) < 2:
        errors.append("Task is empty")
    freq = _FREQ_BY_LOWER.get(str(cell.get("frequency") or "Monthly").strip().casefold())
    if not freq:
        errors.append(f"Unknown frequency '{cell.get('frequency')}'")
    safety_key = str(cell.get("safety") or "—").strip().casefold()
    safety_key = "—" if safety_key in {"", "-", "none", "n/a"} else safety_key
    safety = _SAFETY_BY_LOWER.get(safety_key)
    if not safety:
        errors.append(f"Unknown safety option '{cell.get('safety')}'")
    hours = None
    if cell.get("hours") not in (None, ""):
        try:
            hours = float(cell["hours"])
        except (TypeError, ValueError):
            errors.append("Est. time must be a number")
    units = None
    if cell.get("units") not in (None, ""):
        try:
            units = int(float(cell["units"]))
            if units < 1:
                raise ValueError
        except (TypeError, ValueError):
            errors.append("No. of units must be a whole number")
    per_day = None
    if cell.get("perday") not in (None, ""):
        try:
            per_day = int(float(cell["perday"]))
            if per_day < 1:
                raise ValueError
        except (TypeError, ValueError):
            errors.append("Units per day must be a whole number")
        if per_day and units and per_day > units:
            errors.append("Units per day cannot exceed No. of units")
    start = None
    try:
        start = _parse_date(cell.get("start"))
    except ValueError as exc:
        errors.append(str(exc))
    checks: list[dict[str, Any]] = []
    try:
        checks = _parse_checks(cell.get("checks"))
    except ValueError as exc:
        errors.append(str(exc))
    if errors:
        return None, errors
    tpl = {"equipment_type": equipment_type, "task_name": task, "steps": str(cell.get("steps") or "").strip() or None,
           "frequency": freq, "safety": safety, "est_hours": hours, "tools": None, "checks": checks,
           "units_per_day": per_day}
    return tpl, []


@router.post("/import", dependencies=[Depends(require_csrf)])
async def import_plan(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
                      file: UploadFile = File(...), dry_run: bool = True):
    _require(user, PLANNER_ROLES, "Only the O&M Head can import a PM plan")
    if not (file.filename or "").lower().endswith((".xlsx", ".xlsm", ".csv")):
        raise HTTPException(422, "Upload an .xlsx, .xlsm, or .csv file")
    content = await file.read()
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(413, "File is larger than 5 MB")
    try:
        cells = _read_csv_plan(content) if (file.filename or "").lower().endswith(".csv") else _read_plan(content)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(422, "Could not read the PM plan file") from None
    if not cells:
        raise HTTPException(422, "No task rows found (rows starting with EXAMPLE are ignored)")

    problems: list[dict[str, Any]] = []
    plan: list[tuple[dict[str, Any], dict[str, Any], list[Plant], list[dict[str, Any]], date]] = []
    seen: set[tuple[Any, str, int | None]] = set()
    users_cache: dict[str, User | None] = {}
    templates_only = skipped = 0
    default_start = business_today() + timedelta(days=3)
    for cell in cells:
        tpl, errs = _clean_row(cell)
        plant_text = str(cell.get("plants") or "").strip()
        plants: list[Plant] = []
        items: list[dict[str, Any]] = []
        start = default_start
        if tpl and plant_text:
            try:
                plants = _resolve_plants(db, [p for p in plant_text.split(",")])
                units_hint = None
                if cell.get("units") not in (None, ""):
                    units_hint = int(float(cell["units"]))
                assignees = [a for a in str(cell.get("assignees") or "").split(",")]
                items, skip = _plan_tasks(db, user, plants, tpl, assignees, True, units_hint, seen, users_cache,
                                          {"total_units": units_hint, "units_per_day": tpl.get("units_per_day")})
                skipped += skip
                start = _parse_date(cell.get("start")) or default_start
            except HTTPException as exc:
                errs.append(str(exc.detail))
        elif tpl:
            templates_only += 1
        if errs:
            problems.append({"row": cell["row"], "errors": errs})
        elif tpl:
            plan.append((cell, tpl, plants, items, start))
    if problems:
        raise HTTPException(422, {"message": f"{len(problems)} row(s) need fixing — nothing was imported", "problems": problems[:50]})

    total = sum(len(p[3]) for p in plan)
    if total > MAX_TASKS_PER_CALL:
        raise HTTPException(422, f"This file would create {total} tasks (limit {MAX_TASKS_PER_CALL}). Split it into smaller files.")
    result = {"dry_run": dry_run, "rows": len(plan), "templates": len(plan), "tasks": total, "skipped": skipped,
              "template_only_rows": templates_only}
    if dry_run:
        return result
    for cell, tpl, plants, items, start in plan:
        row = _upsert_template(db, user, tpl)
        if items:
            _create_tasks(db, user, tpl, items, start, str(row.id))
    db.commit()
    return result
