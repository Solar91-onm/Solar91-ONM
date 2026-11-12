"""Read-only portfolio aggregation for the portal frontend.

Why this module exists
----------------------
The portal's Overview and Plants pages need, for every plant in their respective
role scope, the same handful of operational figures: open/closed/critical issue
counts, Preventive Maintenance completion and Washing cycle compliance. Asking
for those one plant at a time is 38 round trips for a 38-plant portfolio, so
every figure here is produced by a **single grouped query across all visible
plants** and then joined in memory.

Business rules are not re-invented. They are imported or mirrored from the
modules that own them, and the source is named at each definition:

* issue open/closed state sets and severity storage — ``app/issues``
* PM status set and the overdue rule                 — ``app/scheduled/router.py``
* washing cycles, target and compliance              — ``app/scheduled/washing_cycles.py``

Missing data stays ``None``. The portal shows "Not available" for a plant with
no records rather than a zero, because a zero reads as "nothing is wrong".
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
import logging
from typing import Any
from uuid import UUID

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session, aliased

from app.core.models import (
    Issue,
    OMTask,
    Plant,
    PlantResponsibility,
    User,
    UserPlantAssignment,
    WashingConfig,
    WashingDailyReport,
    WashingTable,
)
from app.core.security import user_scoped_plant_ids, visible_custom_fields
from app.core.timeutil import BUSINESS_TZ, business_today

# ── Business rules (mirrored from the owning modules) ────────────────────────

# app/issues/service.py — every state that is not Resolved/Closed is open work.
ISSUE_OPEN_STATES = (
    "Open", "Assigned", "Acknowledged", "In Progress", "Pending Vendor", "Pending Parts/Vendor",
)
ISSUE_CLOSED_STATES = ("Resolved", "Closed")
# The same three groups the Site Issues screen shows: Unsolved, In Progress, Solved.
ISSUE_UNSOLVED_STATES = ("Open", "Assigned", "Acknowledged")
ISSUE_IN_PROGRESS_STATES = ("In Progress", "Pending Vendor", "Pending Parts/Vendor")

# app/issues/schemas.py :: SEVERITY_STORED_AS — two levels, each with a legacy alias.
SEVERITY_CRITICAL = ("Critical", "High")
SEVERITY_MEDIUM = ("Medium", "Low")

# app/scheduled/router.py — the PM status set and what counts as still-open work.
PM_OPEN_STATES = ("Scheduled", "In Progress")
PM_DONE_STATES = ("Completed",)
PM_CLOSED_STATES = ("Completed", "Cancelled")

# Presentation thresholds for the health chip. The portal never overrides a
# record's own state; these only classify the aggregate for the summary tiles.
HEALTH_THRESHOLDS = {
    "critical_if_open_critical_issues_at_least": 1,
    "attention_if_open_issues_at_least": 2,
    "attention_if_pm_compliance_below": 80,
    "attention_if_washing_compliance_below": 80,
}

ACTIVITY_WINDOW_DAYS = 45


# ── Scope ───────────────────────────────────────────────────────────────────

def _visible_plants_stmt(db: Session, user: User):
    """The scoped plant SELECT, or None when the user may see no plant at all."""
    allowed = user_scoped_plant_ids(db, user)
    stmt = select(Plant).order_by(Plant.plant_name)
    if allowed is not None:
        if not allowed:
            return None
        stmt = stmt.where(Plant.id.in_(allowed))
    return stmt


def visible_plants(db: Session, user: User) -> list[Plant]:
    """Plants this user may see, ordered by name. Server-side scope only."""
    stmt = _visible_plants_stmt(db, user)
    return [] if stmt is None else list(db.scalars(stmt))


def overview_plants(db: Session, user: User) -> list[Plant]:
    """Overview is portfolio-wide except for Site Engineers, who remain plant-scoped."""
    if user.role not in {"O&M Head", "Assignee", "Administration"}:
        return visible_plants(db, user)
    return list(db.scalars(select(Plant).order_by(Plant.plant_name)))


def _plants_with_people(db: Session, stmt) -> list[tuple[Plant, list[str], str, dict[str, str]]]:
    """Plants from ``stmt`` with their Site Engineers, washing assignee and PM / Health assignees, in **one** query.

    This used to be three statements (plants, then engineers, then washing assignees). Every
    statement costs a full round trip to Supabase, which is the dominant cost of these routes,
    so the two people lookups are outer-joined onto the plant select and folded here instead.

    A plant repeats once per ``user_plant_assignments`` row, which is a handful at most;
    ``washing_config.plant_id`` is that table's primary key, and ``plant_responsibilities`` is
    keyed by (plant, area) and joined once per area, so neither multiplies the result. Name handling is identical to the per-metric helpers this replaces: only active
    Site Engineers count, and the names are sorted.
    """
    engineer = aliased(User)
    washer = aliased(User)
    pm_row, health_row = aliased(PlantResponsibility), aliased(PlantResponsibility)
    pm_user, health_user = aliased(User), aliased(User)
    rows = db.execute(
        stmt.outerjoin(UserPlantAssignment, UserPlantAssignment.plant_id == Plant.id)
        .outerjoin(
            engineer,
            and_(
                engineer.id == UserPlantAssignment.user_id,
                engineer.is_active.is_(True),
                engineer.role == "Site Engineer",
            ),
        )
        .outerjoin(WashingConfig, WashingConfig.plant_id == Plant.id)
        .outerjoin(washer, washer.id == WashingConfig.assigned_user_id)
        .outerjoin(pm_row, and_(pm_row.plant_id == Plant.id, pm_row.area == "pm"))
        .outerjoin(pm_user, pm_user.id == pm_row.assigned_user_id)
        .outerjoin(health_row, and_(health_row.plant_id == Plant.id, health_row.area == "health"))
        .outerjoin(health_user, health_user.id == health_row.assigned_user_id)
        .add_columns(engineer.display_name, washer.display_name, pm_user.display_name, health_user.display_name)
    ).all()

    order: list[Plant] = []
    seen: set[UUID] = set()
    engineers: dict[UUID, list[str]] = {}
    washers: dict[UUID, str] = {}
    responsible: dict[UUID, dict[str, str]] = {}
    for plant, engineer_name, washer_name, pm_name, health_name in rows:
        if plant.id not in seen:
            seen.add(plant.id)
            order.append(plant)
        if engineer_name:
            engineers.setdefault(plant.id, []).append(engineer_name)
        if washer_name:
            washers[plant.id] = washer_name
        if pm_name:
            responsible.setdefault(plant.id, {})["pm"] = pm_name
        if health_name:
            responsible.setdefault(plant.id, {})["health"] = health_name
    for names in engineers.values():
        names.sort()
    return [(plant, engineers.get(plant.id, []), washers.get(plant.id, ""), responsible.get(plant.id, {}))
            for plant in order]


def visible_plants_with_people(db: Session, user: User) -> list[tuple[Plant, list[str], str, dict[str, str]]]:
    """``visible_plants`` plus each plant's Site Engineers and washing assignee, in one query."""
    stmt = _visible_plants_stmt(db, user)
    return [] if stmt is None else _plants_with_people(db, stmt)


def overview_plants_with_people(db: Session, user: User) -> list[tuple[Plant, list[str], str, dict[str, str]]]:
    """``overview_plants`` plus each plant's Site Engineers and washing assignee, in one query."""
    if user.role not in {"O&M Head", "Assignee", "Administration"}:
        return visible_plants_with_people(db, user)
    return _plants_with_people(db, select(Plant).order_by(Plant.plant_name))


def _plant_ids(plants: list[Plant]) -> list[UUID]:
    return [plant.id for plant in plants]


# ── Per-metric grouped queries ──────────────────────────────────────────────

def _issue_counts(db: Session, plant_ids: list[UUID]) -> dict[UUID, dict[str, int]]:
    """Issue counts per plant in one grouped query."""
    if not plant_ids:
        return {}
    is_open = Issue.status.in_(ISSUE_OPEN_STATES)
    rows = db.execute(
        select(
            Issue.plant_id,
            func.count().label("total"),
            func.sum(case((is_open, 1), else_=0)).label("open"),
            func.sum(case((Issue.status.in_(ISSUE_CLOSED_STATES), 1), else_=0)).label("closed"),
            func.sum(case((is_open & Issue.severity.in_(SEVERITY_CRITICAL), 1), else_=0)).label("critical"),
            func.sum(case((is_open & Issue.severity.in_(SEVERITY_MEDIUM), 1), else_=0)).label("medium"),
            func.sum(case((Issue.status.in_(ISSUE_UNSOLVED_STATES), 1), else_=0)).label("unsolved"),
            func.sum(case((Issue.status.in_(ISSUE_IN_PROGRESS_STATES), 1), else_=0)).label("in_progress"),
        )
        .where(Issue.plant_id.in_(plant_ids))
        .group_by(Issue.plant_id)
    ).all()
    return {
        row.plant_id: {
            "total": int(row.total or 0),
            "openIssues": int(row.open or 0),
            "closedIssues": int(row.closed or 0),
            "criticalIssues": int(row.critical or 0),
            "mediumIssues": int(row.medium or 0),
            "unsolvedIssues": int(row.unsolved or 0),
            "inProgressIssues": int(row.in_progress or 0),
        }
        for row in rows
    }


def _pm_counts(db: Session, plant_ids: list[UUID], today: date) -> dict[UUID, dict[str, int]]:
    """Preventive Maintenance counts per plant.

    Overdue mirrors app/scheduled/router.py: the planned date wins when a unit
    has been rolled, and a Completed or Cancelled job is never overdue.
    """
    if not plant_ids:
        return {}
    due = func.coalesce(OMTask.planned_due_on, OMTask.due_on)
    still_open = OMTask.status.in_(PM_OPEN_STATES)
    rows = db.execute(
        select(
            OMTask.plant_id,
            func.count().label("total"),
            func.sum(case((OMTask.status.in_(PM_DONE_STATES), 1), else_=0)).label("completed"),
            func.sum(case((still_open & (due >= today), 1), else_=0)).label("pending"),
            func.sum(case((still_open & (due < today), 1), else_=0)).label("overdue"),
            func.sum(case((still_open & due.is_(None), 1), else_=0)).label("undated"),
            func.sum(case((OMTask.status == "Cancelled", 1), else_=0)).label("cancelled"),
        )
        .where(OMTask.plant_id.in_(plant_ids))
        .group_by(OMTask.plant_id)
    ).all()
    out: dict[UUID, dict[str, int]] = {}
    for row in rows:
        completed = int(row.completed or 0)
        pending = int(row.pending or 0) + int(row.undated or 0)
        overdue = int(row.overdue or 0)
        out[row.plant_id] = {
            "completed": completed,
            "pending": pending,
            "overdue": overdue,
            "cancelled": int(row.cancelled or 0),
            # app/scheduled: compliance divides by live work, never by plan size.
            "compliancePercent": _percent(completed, completed + pending + overdue),
        }
    return out


logger = logging.getLogger("solar91.portal")


def _washing_rows(db: Session, user: User, plant_ids: list[UUID] | None = None) -> dict[str, dict[str, Any]] | None:
    """Live washing figures per plant, straight from the module that owns them.

    Reads the overview without its report list (the figures are identical; see washing_cycles._SUMMARY_REPORT_COLUMNS).
    ``plant_ids`` limits the work to those plants (plant details). Returns None when washing could not be read, so the
    caller can say "unavailable" instead of showing zeros that look like real data.
    """
    from app.scheduled.washing_cycles import get_overview

    try:
        overview = get_overview(db, user, include_reports=False,
                                plant_ids=set(plant_ids) if plant_ids is not None else None)
    except Exception as error:  # washing must not take the Overview down, but the failure must be visible
        # PostgreSQL aborts the whole transaction after a failed statement; roll back (this request is read-only)
        # so the remaining Overview queries can still run.
        db.rollback()
        logger.warning("washing_overview_unavailable error=%s", type(error).__name__)
        return None
    return {row["plant_id"]: row for row in overview.get("plants", [])}


def _last_activity(db: Session, plant_ids: list[UUID]) -> dict[UUID, datetime]:
    """Most recent operational write per plant (issue update or PM completion)."""
    if not plant_ids:
        return {}
    latest: dict[UUID, datetime] = {}
    issue_rows = db.execute(
        select(Issue.plant_id, func.max(Issue.updated_at))
        .where(Issue.plant_id.in_(plant_ids))
        .group_by(Issue.plant_id)
    ).all()
    for plant_id, at in issue_rows:
        if at:
            latest[plant_id] = at
    task_rows = db.execute(
        select(OMTask.plant_id, func.max(OMTask.updated_at))
        .where(OMTask.plant_id.in_(plant_ids))
        .group_by(OMTask.plant_id)
    ).all()
    for plant_id, at in task_rows:
        if at and (plant_id not in latest or at > latest[plant_id]):
            latest[plant_id] = at
    return latest


def _percent(part: int, whole: int) -> int | None:
    """Rounded percentage, or None when there is nothing to measure."""
    if not whole:
        return None
    return round(100 * part / whole)


# ── Profiles ────────────────────────────────────────────────────────────────

def classify_condition(profile: dict[str, Any]) -> str:
    """healthy | attention | critical | unknown — for the health chip only."""
    if profile.get("condition") == "unknown":
        return "unknown"
    t = HEALTH_THRESHOLDS
    if (profile.get("criticalIssues") or 0) >= t["critical_if_open_critical_issues_at_least"]:
        return "critical"
    if (profile.get("openIssues") or 0) >= t["attention_if_open_issues_at_least"]:
        return "attention"
    pm_pct = (profile.get("pm") or {}).get("compliancePercent")
    wash_pct = (profile.get("washing") or {}).get("compliancePercent")
    if pm_pct is not None and pm_pct < t["attention_if_pm_compliance_below"]:
        return "attention"
    if wash_pct is not None and wash_pct < t["attention_if_washing_compliance_below"]:
        return "attention"
    return "healthy"


_EMPTY_BLOCK = {"completed": None, "pending": None, "overdue": None, "compliancePercent": None}


def build_profile(
    plant: Plant,
    issues: dict[str, int] | None,
    pm: dict[str, int] | None,
    washing: dict[str, Any] | None,
    last_at: datetime | None,
) -> dict[str, Any]:
    """One plant's operational profile. No record ⇒ None, never 0."""
    has_any = bool(issues or pm or washing)
    if not has_any:
        return {
            "siteCode": plant.site_code,
            "condition": "unknown",
            "derivedCondition": "unknown",
            "openIssues": None, "closedIssues": None,
            "criticalIssues": None, "mediumIssues": None,
            "unsolvedIssues": None, "inProgressIssues": None,
            "pm": dict(_EMPTY_BLOCK),
            "washing": dict(_EMPTY_BLOCK),
            "lastReportAt": None,
            "source": "database",
            "note": (
                "Not yet commissioned — no operational records"
                if plant.status and plant.status.lower() != "active"
                else "No operational records for this plant yet"
            ),
        }

    washing_block = dict(_EMPTY_BLOCK)
    if washing:
        if "cycles_this_month" not in washing:
            completed = int(washing.get("completed") or 0)
            pending = int(washing.get("pending") or 0)
            overdue = int(washing.get("overdue") or 0)
            target = completed + pending + overdue
            washing_block = {
                "completed": completed,
                "pending": pending,
                "overdue": overdue,
                "compliancePercent": _percent(completed, target),
                "currentCycle": None,
                "monthlyTarget": target,
                "overdueDays": None,
                "overdueBucket": None,
                "tableCount": None,
                "assignee": washing.get("assignee_name") or "",
                "thresholdPercent": None,
                "lastReportDate": None,
                "active": True,
            }
        else:
            completed = int(washing.get("cycles_this_month") or 0)
            target = int(washing.get("monthly_target") or 3)
            overdue_days = int(washing.get("overdue_days") or 0)
            washing_block = {
                "completed": completed,
                "pending": max(0, target - completed),
                "overdue": 1 if overdue_days > 0 else 0,
                # _cycle_compliance in app/scheduled/washing_cycles.py is authoritative.
                "compliancePercent": washing.get("cycle_compliance_percent"),
                "currentCycle": washing.get("current_cycle"),
                "monthlyTarget": target,
                "overdueDays": overdue_days,
                "overdueBucket": washing.get("overdue_bucket"),
                "tableCount": washing.get("table_count"),
                "assignee": washing.get("assignee_name") or "",
                "thresholdPercent": washing.get("compliance_threshold_percent"),
                "lastReportDate": washing.get("last_report_date"),
                "active": bool(washing.get("active", True)),
            }

    profile = {
        "siteCode": plant.site_code,
        "condition": "known",
        "openIssues": (issues or {}).get("openIssues", 0),
        "closedIssues": (issues or {}).get("closedIssues", 0),
        "criticalIssues": (issues or {}).get("criticalIssues", 0),
        "mediumIssues": (issues or {}).get("mediumIssues", 0),
        "unsolvedIssues": (issues or {}).get("unsolvedIssues", 0),
        "inProgressIssues": (issues or {}).get("inProgressIssues", 0),
        "pm": {
            "completed": (pm or {}).get("completed", 0),
            "pending": (pm or {}).get("pending", 0),
            "overdue": (pm or {}).get("overdue", 0),
            "compliancePercent": (pm or {}).get("compliancePercent"),
        } if pm else dict(_EMPTY_BLOCK),
        "washing": washing_block,
        "lastReportAt": last_at.isoformat() if last_at else None,
        "source": "database",
    }
    profile["derivedCondition"] = classify_condition(profile)
    return profile


def plant_out(
    plant: Plant, engineers: list[str], washing_assignee: str, user: User,
    responsible: dict[str, str] | None = None,
) -> dict[str, Any]:
    """A plant record as the portal reads it: stored columns, nothing invented.

    ``user`` is required so the Design/MDL folder link is only sent to roles allowed to open it.
    """
    return {
        "id": str(plant.id),
        "site_code": plant.site_code,
        "display_code": plant.site_code,
        "plant_name": plant.plant_name,
        "project_company": plant.project_company,
        "district": plant.district,
        "discom": plant.discom,
        "location": plant.location,
        "latitude": float(plant.latitude) if plant.latitude is not None else None,
        "longitude": float(plant.longitude) if plant.longitude is not None else None,
        "dc_capacity_kw": float(plant.dc_capacity_kw) if plant.dc_capacity_kw is not None else None,
        "ac_capacity_kw": float(plant.ac_capacity_kw) if plant.ac_capacity_kw is not None else None,
        "commissioned_on": plant.commissioned_on.isoformat() if plant.commissioned_on else None,
        "status": plant.status,
        "assigned_engineer": plant.assigned_engineer,
        "site_engineers": engineers,
        "washing_assignee": washing_assignee,
        "pm_assignee": (responsible or {}).get("pm", ""),
        "health_assignee": (responsible or {}).get("health", ""),
        "custom_fields": visible_custom_fields(plant.custom_fields, user),
        "created_at": plant.created_at.isoformat() if getattr(plant, "created_at", None) else None,
        "updated_at": plant.updated_at.isoformat() if getattr(plant, "updated_at", None) else None,
    }


def site_engineers_by_plant(db: Session, plant_ids: list[UUID]) -> dict[UUID, list[str]]:
    """Assigned Site Engineers per plant, from the assignment table (not free text)."""
    if not plant_ids:
        return {}
    rows = db.execute(
        select(UserPlantAssignment.plant_id, User.display_name)
        .join(User, User.id == UserPlantAssignment.user_id)
        .where(
            UserPlantAssignment.plant_id.in_(plant_ids),
            User.is_active.is_(True),
            User.role == "Site Engineer",
        )
    ).all()
    out: dict[UUID, list[str]] = {}
    for plant_id, name in rows:
        if name:
            out.setdefault(plant_id, []).append(name)
    for names in out.values():
        names.sort()
    return out


def responsibilities_by_plant(db: Session, plant_ids: list[UUID]) -> dict[UUID, dict[str, str]]:
    """Responsible Preventive Maintenance / Health Assignee names per plant: {plant_id: {"pm": name, "health": name}}."""
    if not plant_ids:
        return {}
    rows = db.execute(
        select(PlantResponsibility.plant_id, PlantResponsibility.area, User.display_name)
        .join(User, User.id == PlantResponsibility.assigned_user_id)
        .where(PlantResponsibility.plant_id.in_(plant_ids))
    ).all()
    out: dict[UUID, dict[str, str]] = {}
    for plant_id, area, name in rows:
        if name:
            out.setdefault(plant_id, {})[area] = name
    return out


def washing_assignees_by_plant(db: Session, plant_ids: list[UUID]) -> dict[UUID, str]:
    if not plant_ids:
        return {}
    rows = db.execute(
        select(WashingConfig.plant_id, User.display_name)
        .join(User, User.id == WashingConfig.assigned_user_id)
        .where(WashingConfig.plant_id.in_(plant_ids))
    ).all()
    return {plant_id: name or "" for plant_id, name in rows}


# ── Portfolio ───────────────────────────────────────────────────────────────

def portfolio(db: Session, user: User) -> dict[str, Any]:
    """Every visible plant with its profile, plus portfolio totals.

    Bounded cost: four grouped queries plus the washing overview, regardless of
    how many plants the user can see.
    """
    people = overview_plants_with_people(db, user)
    ids = _plant_ids([plant for plant, *_rest in people])
    today = business_today()

    issues = _issue_counts(db, ids)
    pm = _pm_counts(db, ids, today)
    washing_rows = _washing_rows(db, user)
    washing = washing_rows or {}
    last_at = _last_activity(db, ids)

    rows = []
    for plant, engineers, washer, responsible in people:
        profile = build_profile(
            plant,
            issues.get(plant.id),
            pm.get(plant.id),
            washing.get(str(plant.id)),
            last_at.get(plant.id),
        )
        rows.append({
            "plant": plant_out(plant, engineers, washer, user, responsible),
            "profile": profile,
        })

    return {
        "rows": rows,
        "totals": aggregate(rows),
        "asOf": datetime.now(timezone.utc).isoformat(),
        "businessDate": today.isoformat(),
        "scope": "assigned" if user.role == "Site Engineer" else "portfolio",
        # A section that could not be read is named here; its figures are absent (shown as "Not available").
        "warnings": ["washing_unavailable"] if washing_rows is None else [],
    }


def portfolio_for_range(db: Session, user: User, start: date, end: date) -> dict[str, Any]:
    """Portfolio metrics for records due/reported in an inclusive business-date range."""
    plants = overview_plants(db, user)
    plant_ids = _plant_ids(plants)
    if not plant_ids:
        return {"rows": [], "totals": aggregate([]), "startDate": start.isoformat(), "endDate": end.isoformat()}

    start_at = datetime.combine(start, time.min, tzinfo=BUSINESS_TZ)
    end_at = datetime.combine(end + timedelta(days=1), time.min, tzinfo=BUSINESS_TZ)
    is_open_issue = Issue.status.in_(ISSUE_OPEN_STATES)
    issue_rows = db.execute(
        select(
            Issue.plant_id,
            func.count().label("total"),
            func.sum(case((is_open_issue, 1), else_=0)).label("open"),
            func.sum(case((Issue.status.in_(ISSUE_CLOSED_STATES), 1), else_=0)).label("closed"),
            func.sum(case((is_open_issue & Issue.severity.in_(SEVERITY_CRITICAL), 1), else_=0)).label("critical"),
            func.sum(case((is_open_issue & Issue.severity.in_(SEVERITY_MEDIUM), 1), else_=0)).label("medium"),
            func.sum(case((Issue.status.in_(ISSUE_UNSOLVED_STATES), 1), else_=0)).label("unsolved"),
            func.sum(case((Issue.status.in_(ISSUE_IN_PROGRESS_STATES), 1), else_=0)).label("in_progress"),
        )
        .where(
            Issue.plant_id.in_(plant_ids),
            Issue.deleted_at.is_(None),
            Issue.occurred_at >= start_at,
            Issue.occurred_at < end_at,
        )
        .group_by(Issue.plant_id)
    ).all()
    issue_counts = {
        row.plant_id: {
            "total": int(row.total or 0),
            "openIssues": int(row.open or 0),
            "closedIssues": int(row.closed or 0),
            "criticalIssues": int(row.critical or 0),
            "mediumIssues": int(row.medium or 0),
            "unsolvedIssues": int(row.unsolved or 0),
            "inProgressIssues": int(row.in_progress or 0),
        }
        for row in issue_rows
    }

    due = func.coalesce(OMTask.planned_due_on, OMTask.due_on)
    task_rows = db.execute(
        select(
            OMTask.plant_id,
            func.sum(case((OMTask.status.in_(PM_DONE_STATES), 1), else_=0)).label("completed"),
            func.sum(case((OMTask.status.in_(PM_OPEN_STATES) & (due >= end), 1), else_=0)).label("pending"),
            func.sum(case((OMTask.status.in_(PM_OPEN_STATES) & (due < end), 1), else_=0)).label("overdue"),
        )
        .where(OMTask.plant_id.in_(plant_ids), due >= start, due <= end)
        .group_by(OMTask.plant_id)
    ).all()
    pm_counts = {
        row.plant_id: {
            "completed": int(row.completed or 0),
            "pending": int(row.pending or 0),
            "overdue": int(row.overdue or 0),
            "compliancePercent": _percent(
                int(row.completed or 0),
                int(row.completed or 0) + int(row.pending or 0) + int(row.overdue or 0),
            ),
        }
        for row in task_rows
    }

    washing_counts: dict[UUID, dict[str, int]] = {}
    if user.role in {"O&M Head", "Assignee", "Site Engineer"}:
        from app.scheduled.washing_cycles import _cycle_due_dates

        config_rows = db.execute(
            select(WashingConfig, Plant)
            .join(Plant, Plant.id == WashingConfig.plant_id)
            .where(WashingConfig.plant_id.in_(plant_ids))
        ).all()
        configs = {plant.id: config for config, plant in config_rows}
        table_counts: dict[UUID, int] = {}
        if configs:
            for plant_id, table_count in db.execute(
                select(WashingTable.plant_id, func.count(WashingTable.id))
                .where(WashingTable.plant_id.in_(list(configs)))
                .group_by(WashingTable.plant_id)
            ).all():
                table_counts[plant_id] = int(table_count or 0)

        first_month = start.strftime("%Y-%m")
        last_month = end.strftime("%Y-%m")
        completed_cycles = {}
        if configs:
            completion_rows = db.execute(
                select(
                    WashingDailyReport.plant_id,
                    WashingDailyReport.cycle_month,
                    WashingDailyReport.cycle_no,
                    func.min(WashingDailyReport.report_date),
                )
                .where(
                    WashingDailyReport.plant_id.in_(list(configs)),
                    WashingDailyReport.cycle_month >= first_month,
                    WashingDailyReport.cycle_month <= last_month,
                    WashingDailyReport.report_date <= end,
                    WashingDailyReport.cycle_completed.is_(True),
                    WashingDailyReport.review_status == "Confirmed",
                )
                .group_by(
                    WashingDailyReport.plant_id,
                    WashingDailyReport.cycle_month,
                    WashingDailyReport.cycle_no,
                )
            ).all()
            completed_cycles = {
                (plant_id, cycle_month, cycle_no): completed_on
                for plant_id, cycle_month, cycle_no, completed_on in completion_rows
            }

        cursor = start.replace(day=1)
        while cursor <= end:
            month_key = cursor.strftime("%Y-%m")
            for plant_id, config in configs.items():
                if not (config.tables_per_cycle or table_counts.get(plant_id, 0)):
                    continue
                counts = washing_counts.setdefault(plant_id, {"completed": 0, "pending": 0, "overdue": 0})
                for cycle_no, due_date in enumerate(_cycle_due_dates(cursor, config.cycle_overrides), 1):
                    if not start <= due_date <= end:
                        continue
                    if completed_cycles.get((plant_id, month_key, cycle_no)):
                        counts["completed"] += 1
                    elif due_date < end:
                        counts["overdue"] += 1
                    else:
                        counts["pending"] += 1
            cursor = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)

    engineers = site_engineers_by_plant(db, plant_ids)
    washers = washing_assignees_by_plant(db, plant_ids)
    responsible = responsibilities_by_plant(db, plant_ids)
    rows = []
    for plant in plants:
        profile = build_profile(
            plant,
            issue_counts.get(plant.id, {"openIssues": 0, "closedIssues": 0, "criticalIssues": 0, "mediumIssues": 0,
                                        "unsolvedIssues": 0, "inProgressIssues": 0}),
            pm_counts.get(plant.id),
            washing_counts.get(plant.id),
            None,
        )
        rows.append({
            "plant": plant_out(plant, engineers.get(plant.id, []), washers.get(plant.id, ""), user, responsible.get(plant.id)),
            "profile": profile,
        })
    return {
        "rows": rows,
        "totals": aggregate(rows),
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
    }


def _trend_buckets(start: date, end: date) -> tuple[str, list[date]]:
    days = (end - start).days + 1
    if days <= 31:
        return "day", [start + timedelta(days=offset) for offset in range(days)]
    if days <= 366:
        count = (days + 6) // 7
        return "week", [start + timedelta(days=offset * 7) for offset in range(count)]
    buckets = []
    current = start.replace(day=1)
    while current <= end:
        buckets.append(current)
        current = (current.replace(day=28) + timedelta(days=4)).replace(day=1)
    return "month", buckets


def _trend_bucket_index(day: date, start: date, bucket: str) -> int:
    if bucket == "day":
        return (day - start).days
    if bucket == "week":
        return (day - start).days // 7
    return (day.year - start.year) * 12 + day.month - start.month


def _trend_day_expression(db: Session, column):
    if db.bind and db.bind.dialect.name == "postgresql":
        return func.date(column.op("AT TIME ZONE")("Asia/Kolkata"))
    return func.date(column)


def _trend_day(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def _add_trend_value(values: list[int], day_value: Any, start: date, bucket: str, amount: int) -> None:
    day = _trend_day(day_value)
    index = _trend_bucket_index(day, start, bucket)
    if 0 <= index < len(values):
        values[index] += amount


def portfolio_trend(
    db: Session,
    plant_ids: list[UUID],
    start: date,
    end: date,
) -> dict[str, Any]:
    """Return date buckets for PM/washing compliance and the issues still active at the end of each bucket."""
    bucket, dates = _trend_buckets(start, end)
    pm_expected = [0] * len(dates)
    pm_on_time = [0] * len(dates)
    washing_expected = [0] * len(dates)
    washing_on_time = [0] * len(dates)
    active_issues = [0] * len(dates)
    solved_issues = [0] * len(dates)
    if plant_ids:
        due_day = func.coalesce(OMTask.planned_due_on, OMTask.due_on)
        pm_rows = db.execute(
            select(
                due_day.label("event_day"),
                func.count().label("expected"),
                func.sum(case((
                    (OMTask.status == "Completed") &
                    OMTask.actual_completed_on.is_not(None) &
                    (OMTask.actual_completed_on <= due_day),
                    1,
                ), else_=0)).label("on_time"),
            )
            .where(
                OMTask.plant_id.in_(plant_ids),
                OMTask.status != "Cancelled",
                due_day >= start,
                due_day <= end,
            )
            .group_by(due_day)
        ).all()
        for row in pm_rows:
            index = _trend_bucket_index(_trend_day(row.event_day), start, bucket)
            if 0 <= index < len(dates):
                pm_expected[index] += int(row.expected or 0)
                pm_on_time[index] += int(row.on_time or 0)

        from app.scheduled.washing_cycles import _cycle_due_dates

        config_rows = db.execute(
            select(WashingConfig, Plant)
            .join(Plant, Plant.id == WashingConfig.plant_id)
            .where(WashingConfig.plant_id.in_(plant_ids))
        ).all()
        configs = {plant.id: config for config, plant in config_rows}
        table_counts: dict[UUID, int] = {}
        if configs:
            for plant_id, count in db.execute(
                select(WashingTable.plant_id, func.count(WashingTable.id))
                .where(WashingTable.plant_id.in_(list(configs)))
                .group_by(WashingTable.plant_id)
            ).all():
                table_counts[plant_id] = int(count or 0)

        cycle_completions: dict[tuple[UUID, str, int], date] = {}
        if configs:
            completion_rows = db.execute(
                select(
                    WashingDailyReport.plant_id,
                    WashingDailyReport.cycle_month,
                    WashingDailyReport.cycle_no,
                    func.min(WashingDailyReport.report_date).label("completed_on"),
                )
                .where(
                    WashingDailyReport.plant_id.in_(list(configs)),
                    WashingDailyReport.cycle_month >= start.strftime("%Y-%m"),
                    WashingDailyReport.cycle_month <= end.strftime("%Y-%m"),
                    WashingDailyReport.report_date <= end,
                    WashingDailyReport.cycle_completed.is_(True),
                    WashingDailyReport.review_status == "Confirmed",
                )
                .group_by(
                    WashingDailyReport.plant_id,
                    WashingDailyReport.cycle_month,
                    WashingDailyReport.cycle_no,
                )
            ).all()
            cycle_completions = {
                (row.plant_id, row.cycle_month, row.cycle_no): row.completed_on
                for row in completion_rows
            }

        month_cursor = start.replace(day=1)
        while month_cursor <= end:
            month_key = month_cursor.strftime("%Y-%m")
            for plant_id, config in configs.items():
                if not (config.tables_per_cycle or table_counts.get(plant_id, 0)):
                    continue
                for cycle_no, due_date in enumerate(_cycle_due_dates(month_cursor, config.cycle_overrides), 1):
                    if not start <= due_date <= end:
                        continue
                    index = _trend_bucket_index(due_date, start, bucket)
                    if 0 <= index < len(dates):
                        washing_expected[index] += 1
                        completed_on = cycle_completions.get((plant_id, month_key, cycle_no))
                        if completed_on and completed_on <= due_date:
                            washing_on_time[index] += 1
            month_cursor = (month_cursor.replace(day=28) + timedelta(days=4)).replace(day=1)

        # Active issues is a running level, not a count of new tickets: an issue is active from the
        # day it occurred until it is Resolved/Closed, so it keeps showing on every later bucket
        # (including today) until then. Same scope as the Open Site Issues tile: issues that
        # occurred inside the range, so the last bucket equals that tile when the range ends today.
        issue_day = _trend_day_expression(db, Issue.occurred_at)
        start_at = datetime.combine(start, time.min, tzinfo=BUSINESS_TZ)
        end_at = datetime.combine(end + timedelta(days=1), time.min, tzinfo=BUSINESS_TZ)
        in_scope = (
            Issue.plant_id.in_(plant_ids),
            Issue.deleted_at.is_(None),
            Issue.occurred_at >= start_at,
            Issue.occurred_at < end_at,
        )
        raised_rows = db.execute(
            select(issue_day.label("event_day"), func.count().label("count"))
            .where(*in_scope).group_by(issue_day)
        ).all()
        # Resolved on the day the fix was recorded; older rows without one fall back to the
        # day the ticket was last updated. A resolution after the range end is outside the
        # buckets, so the issue still counts as active at the end date.
        solved_day = func.coalesce(Issue.fixed_on, Issue.closed_on, _trend_day_expression(db, Issue.updated_at))
        solved_rows = db.execute(
            select(solved_day.label("event_day"), func.count().label("count"))
            .where(*in_scope, Issue.status.in_(ISSUE_CLOSED_STATES)).group_by(solved_day)
        ).all()
        raised = [0] * len(dates)
        solved = [0] * len(dates)
        for row in raised_rows:
            _add_trend_value(raised, row.event_day, start, bucket, int(row.count or 0))
        for row in solved_rows:
            _add_trend_value(solved, row.event_day, start, bucket, int(row.count or 0))
        raised_so_far = solved_so_far = 0
        for index in range(len(dates)):
            raised_so_far += raised[index]
            solved_so_far += solved[index]
            active_issues[index] = max(0, raised_so_far - solved_so_far)
            solved_issues[index] = solved_so_far      # running total: the "solved so far" line

    def compliance(numerator: list[int], denominator: list[int]) -> list[int | None]:
        """Compliance so far, bucket by bucket: on-time to date over expected to date.

        Per-bucket compliance cannot be drawn as a trend. Washing has three cycle due dates in a
        month and PM only as many as there are tasks due, so on a daily range almost every bucket
        expects nothing and the series was mostly null — three dots, not a line. Running it
        cumulatively gives a reading on every bucket from the first expectation to the end of the
        range, and the last bucket is the compliance for the whole range, which is the figure the
        tiles above the chart already show.

        Buckets before anything was due stay null: nothing was expected yet, so 0% would be a
        verdict the data does not support.
        """
        values: list[int | None] = []
        complete_so_far = expected_so_far = 0
        for complete, expected in zip(numerator, denominator):
            complete_so_far += complete
            expected_so_far += expected
            values.append(round(100 * complete_so_far / expected_so_far) if expected_so_far else None)
        return values

    labels = [
        item.strftime("%d %b") if bucket != "month" else item.strftime("%b %Y")
        for item in dates
    ]
    return {
        "bucket": bucket,
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
        "labels": labels,
        "series": [
            {
                "key": "washing",
                "label": "Module Cleaning compliance",
                "axis": "percent",
                "values": compliance(washing_on_time, washing_expected),
            },
            {
                "key": "pm",
                "label": "PM compliance",
                "axis": "percent",
                "values": compliance(pm_on_time, pm_expected),
            },
            {
                "key": "issues",
                "label": "Active site issues",
                "axis": "count",
                "values": active_issues,
            },
            {
                "key": "solved",
                "label": "Solved site issues",
                "axis": "count",
                "values": solved_issues,
            },
        ],
    }


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Portfolio totals. A plant with no records counts as unknown, not as zero."""
    totals = {
        "totalPlants": len(rows),
        "healthyPlants": 0, "attentionPlants": 0, "criticalPlants": 0, "unknownPlants": 0,
        "openIssues": 0, "closedIssues": 0, "criticalIssues": 0, "mediumIssues": 0,
        "unsolvedIssues": 0, "inProgressIssues": 0,
        "plantsWithOpenIssues": 0,
        "pmCompleted": 0, "pmPending": 0, "pmOverdue": 0,
        "washingCompleted": 0, "washingPending": 0, "washingOverdue": 0,
        "dcCapacityMw": 0.0, "acCapacityMw": 0.0,
        "commissionedPlants": 0,
    }
    for row in rows:
        plant, profile = row["plant"], row["profile"]
        condition = profile.get("derivedCondition") or "unknown"
        totals[{
            "healthy": "healthyPlants", "attention": "attentionPlants",
            "critical": "criticalPlants",
        }.get(condition, "unknownPlants")] += 1

        for key in ("openIssues", "closedIssues", "criticalIssues", "mediumIssues", "unsolvedIssues", "inProgressIssues"):
            value = profile.get(key)
            if isinstance(value, int):
                totals[key] += value
        if (profile.get("openIssues") or 0) > 0:
            totals["plantsWithOpenIssues"] += 1

        for block, prefix in (("pm", "pm"), ("washing", "washing")):
            data = profile.get(block) or {}
            for field, suffix in (("completed", "Completed"), ("pending", "Pending"), ("overdue", "Overdue")):
                value = data.get(field)
                if isinstance(value, int):
                    totals[prefix + suffix] += value

        if plant.get("dc_capacity_kw"):
            totals["dcCapacityMw"] += plant["dc_capacity_kw"] / 1000
        if plant.get("ac_capacity_kw"):
            totals["acCapacityMw"] += plant["ac_capacity_kw"] / 1000
        if plant.get("commissioned_on"):
            totals["commissionedPlants"] += 1

    pm_total = totals["pmCompleted"] + totals["pmPending"] + totals["pmOverdue"]
    totals["pmCompliancePercent"] = _percent(totals["pmCompleted"], pm_total)
    wash_total = totals["washingCompleted"] + totals["washingPending"] + totals["washingOverdue"]
    totals["washingCompliancePercent"] = _percent(totals["washingCompleted"], wash_total)
    totals["dcCapacityMw"] = round(totals["dcCapacityMw"], 2)
    totals["acCapacityMw"] = round(totals["acCapacityMw"], 2)
    return totals


# ── Activity feed ───────────────────────────────────────────────────────────

def activity(db: Session, user: User, plant_ids: list[UUID], limit: int = 25) -> list[dict[str, Any]]:
    """Recent real events: issue opens/closes and PM completions. Bounded."""
    if not plant_ids:
        return []
    limit = max(1, min(int(limit), 100))
    since = business_today() - timedelta(days=ACTIVITY_WINDOW_DAYS)
    codes, names = _plant_labels(db, plant_ids)

    events: list[dict[str, Any]] = []

    issue_rows = db.execute(
        select(Issue.plant_id, Issue.ticket_no, Issue.status, Issue.severity,
               Issue.description, Issue.updated_at, Issue.vertical)
        .where(Issue.plant_id.in_(plant_ids), Issue.updated_at.is_not(None))
        .order_by(Issue.updated_at.desc())
        .limit(limit * 2)
    ).all()
    for row in issue_rows:
        closed = row.status in ISSUE_CLOSED_STATES
        events.append({
            "kind": "issue.closed" if closed else "issue.opened",
            "title": f"{row.ticket_no} — {(row.description or '').strip()[:90] or 'Site issue'}",
            "status": row.status,
            "severity": "Critical" if row.severity in SEVERITY_CRITICAL else "Medium",
            "category": row.vertical or "",
            "at": row.updated_at.isoformat() if row.updated_at else None,
            "plantSiteCode": codes.get(row.plant_id),
            "plantName": names.get(row.plant_id),
            "source": "database",
        })

    task_rows = db.execute(
        select(OMTask.plant_id, OMTask.work_order_no, OMTask.task_name, OMTask.status,
               OMTask.actual_completed_on, OMTask.updated_at)
        .where(
            OMTask.plant_id.in_(plant_ids),
            or_(OMTask.actual_completed_on >= since, OMTask.status.in_(PM_OPEN_STATES)),
        )
        .order_by(OMTask.updated_at.desc())
        .limit(limit * 2)
    ).all()
    for row in task_rows:
        events.append({
            "kind": "pm.completed" if row.status == "Completed" else "pm.scheduled",
            "title": f"{row.work_order_no} — {row.task_name}",
            "status": row.status,
            "severity": None,
            "category": "Preventive Maintenance",
            "at": row.updated_at.isoformat() if row.updated_at else None,
            "plantSiteCode": codes.get(row.plant_id),
            "plantName": names.get(row.plant_id),
            "source": "database",
        })

    events = [e for e in events if e["at"]]
    events.sort(key=lambda e: e["at"], reverse=True)
    return events[:limit]


# ── Calendar ────────────────────────────────────────────────────────────────

CALENDAR_LIMIT = 4000


def _plant_labels(db: Session, plant_ids: list[UUID]) -> tuple[dict[UUID, str], dict[UUID, str]]:
    """Site code and name per plant in one round trip (was two separate queries)."""
    codes: dict[UUID, str] = {}
    names: dict[UUID, str] = {}
    for plant_id, site_code, plant_name in db.execute(
        select(Plant.id, Plant.site_code, Plant.plant_name).where(Plant.id.in_(plant_ids))
    ).all():
        codes[plant_id] = site_code
        names[plant_id] = plant_name
    return codes, names


def calendar_page(db: Session, user: User, kind: str, month: str, plant_ids: list[UUID],
                  limit: int = CALENDAR_LIMIT) -> dict[str, Any]:
    """``calendar`` plus whether the month held more than ``limit`` entries, so a capped month is never shown as
    complete. One extra row is read to tell."""
    entries = calendar(db, user, kind, month, plant_ids, limit=limit + 1)
    return {"entries": entries[:limit], "truncated": len(entries) > limit, "limit": limit}


def calendar(db: Session, user: User, kind: str, month: str, plant_ids: list[UUID],
             limit: int = CALENDAR_LIMIT) -> list[dict[str, Any]]:
    """Dated PM or Washing entries for one month — real records only, at most ``limit`` (earliest first)."""
    if kind not in {"pm", "washing"}:
        raise ValueError("Calendar activity requires kind=pm or kind=washing")
    try:
        year_s, month_s = month.split("-")
        year, month_no = int(year_s), int(month_s)
        first = date(year, month_no, 1)
    except (ValueError, AttributeError):
        raise ValueError("Calendar activity requires a YYYY-MM month")
    last = date(year + (month_no == 12), (month_no % 12) + 1, 1) - timedelta(days=1)
    if not plant_ids:
        return []

    codes, names = _plant_labels(db, plant_ids)
    today = business_today()

    if kind == "pm":
        due = func.coalesce(OMTask.planned_due_on, OMTask.due_on)
        rows = db.execute(
            select(OMTask.id, OMTask.plant_id, OMTask.work_order_no, OMTask.task_name,
                   OMTask.task_type, OMTask.frequency, OMTask.status, due.label("due_on"), OMTask.actual_completed_on,
                   OMTask.assignee_text, OMTask.unit_no, OMTask.total_units)
            .where(OMTask.plant_id.in_(plant_ids), due >= first, due <= last)
            .order_by(due, OMTask.id)
            .limit(limit)
        ).all()
        out = []
        for row in rows:
            overdue = (
                row.due_on and row.due_on < today and row.status not in PM_CLOSED_STATES
            )
            status = "Overdue" if overdue else row.status
            out.append({
                "id": str(row.id),
                "kind": "pm.overdue" if overdue else ("pm.completed" if row.status == "Completed" else "pm.scheduled"),
                "title": row.task_name + (f" · unit {row.unit_no}/{row.total_units}" if row.unit_no and row.total_units else ""),
                "reference": row.work_order_no,
                "equipmentType": row.task_type or "",
                "frequency": row.frequency or "",
                "unitNo": row.unit_no,
                "totalUnits": row.total_units,
                "status": status,
                "assignee": row.assignee_text or "",
                "date": row.due_on.isoformat(),
                "completedOn": row.actual_completed_on.isoformat() if row.actual_completed_on else None,
                "plantSiteCode": codes.get(row.plant_id),
                "plantName": names.get(row.plant_id),
                "source": "database",
            })
        return out

    from app.core.models import WashingDailyReport
    from app.scheduled.washing_cycles import format_table_codes

    rows = db.execute(
        select(WashingDailyReport.id, WashingDailyReport.plant_id, WashingDailyReport.report_date,
               WashingDailyReport.job_status, WashingDailyReport.cycle_no, WashingDailyReport.tables_cleaned,
               WashingDailyReport.review_status, WashingDailyReport.reported_by,
               WashingDailyReport.exception_reason, WashingDailyReport.cycle_completed,
               WashingDailyReport.cleaned_table_codes)
        .where(
            WashingDailyReport.plant_id.in_(plant_ids),
            WashingDailyReport.report_date >= first,
            WashingDailyReport.report_date <= last,
        )
        .order_by(WashingDailyReport.report_date, WashingDailyReport.id)
        .limit(limit)
    ).all()
    return [
        {
            "id": str(row.id),
            "kind": "washing.excused" if row.exception_reason else (
                "washing.done" if row.cycle_completed else "washing.reported"
            ),
            "title": f"Cycle {row.cycle_no} · {row.tables_cleaned} tables cleaned",
            "reference": f"Cycle {row.cycle_no}",
            "status": row.review_status or row.job_status,
            "assignee": row.reported_by or "",
            "date": row.report_date.isoformat(),
            "exceptionReason": row.exception_reason,
            "tablesCleaned": row.tables_cleaned,
            "tablesList": format_table_codes(row.cleaned_table_codes),
            "plantSiteCode": codes.get(row.plant_id),
            "plantName": names.get(row.plant_id),
            "source": "database",
        }
        for row in rows
    ]