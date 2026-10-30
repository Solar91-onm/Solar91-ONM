"""Read-only, permission-scoped Operations Calendar backed by existing O&M tables.

An event is a *view*, not a new row. In particular, one PM work order or
washing daily report produces exactly one event on its operational date.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import String, and_, case, cast, exists, func, or_, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.models import Equipment, Issue, OMTask, Plant, User, WashingConfig, WashingDailyReport
from app.core.security import (WASHING_TYPE, ROLE_PERMISSIONS, get_current_user,
    user_scoped_plant_ids, user_scoped_equipment_types)
from app.core.timeutil import BUSINESS_TZ, business_today
from app.scheduled.washing_cycles import _cycle_due_dates, _cycle_start_dates, month_cycles

router = APIRouter(prefix="/api/operations-calendar", tags=["Operations Calendar"])
MAX_DAYS = 93


def _allowed(db: Session, user: User, plant_id: UUID | None):
    if "issues.view" not in ROLE_PERMISSIONS.get(user.role, set()):
        raise HTTPException(403, "Operations Calendar is outside this role")
    scoped = user_scoped_plant_ids(db, user)
    if plant_id is not None:
        if scoped is not None and plant_id not in scoped:
            raise HTTPException(403, "Plant is outside your assigned scope")
        if db.get(Plant, plant_id) is None:
            raise HTTPException(404, "Plant not found")
        return {plant_id}
    return scoped


def _type_filter(column, types: set[str]):
    return func.lower(func.trim(func.coalesce(column, ""))).in_(types)


def _issue_auth(types: set[str]):
    return or_(
        _type_filter(Issue.vertical, types),
        and_(func.trim(func.coalesce(Issue.vertical, "")) == "",
             exists(select(Equipment.id).where(Equipment.id == Issue.equipment_id,
                 _type_filter(Equipment.equipment_type, types)))),
    )


def _pm_auth(types: set[str]):
    return or_(
        _type_filter(OMTask.task_type, types),
        and_(func.trim(func.coalesce(OMTask.task_type, "")) == "",
             exists(select(Equipment.id).where(
                 Equipment.plant_id == OMTask.plant_id,
                 or_(Equipment.equipment_code == OMTask.equipment_ref,
                     Equipment.equipment_name == OMTask.equipment_ref,
                     cast(Equipment.id, String) == OMTask.equipment_ref),
                 _type_filter(Equipment.equipment_type, types)))),
    )


def _issue_date(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:  # SQLite test DB drops the UTC timezone on read
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(BUSINESS_TZ).date().isoformat()


def _tone(kind: str, status: str | None, severity: str | None, when: date, job_status: str | None = None) -> str:
    st = (status or "").strip().casefold()
    if kind == "issue":
        if st in {"resolved", "closed", "completed", "fixed"}: return "done"
        sev = (severity or "").strip().casefold()
        return "critical" if sev in {"critical", "high"} else "medium" if sev == "medium" else "low" if sev == "low" else "neutral"
    if kind == "pm":
        if st == "completed": return "done"
        if st in {"cancelled", "canceled"}: return "neutral"
        if st in {"failed"}: return "critical"
        if when < business_today() and st not in {"completed", "cancelled", "canceled"}: return "overdue"
        return "scheduled"
    if st == "rejected" or (job_status or "").casefold() == "not done": return "overdue"
    if st == "confirmed" and (job_status or "").casefold() == "done": return "done"
    return "washing"


def _plant_fields(plant: Plant):
    return {"plant_id": str(plant.id), "plant": plant.plant_name, "site_code": plant.site_code}


def _event_issue(r: Issue, p: Plant, reporter: str | None = None) -> dict:
    day = _issue_date(r.occurred_at)
    return {"key": f"issue:{r.id}", "kind": "issue", "id": str(r.id), "reference": r.ticket_no,
        "date": day, **_plant_fields(p), "title": r.vertical or r.equipment_ref or "Site issue",
        "equipment": r.vertical or r.equipment_ref, "subpart": r.subcategory,
        "assignee": r.assignee_text, "engineer": p.assigned_engineer,
        "reporter": reporter, "status": r.status, "severity": r.severity,
        "tone": _tone("issue", r.status, r.severity, r.occurred_at.date() if r.occurred_at else business_today())}


def _event_pm(r: OMTask, p: Plant) -> dict:
    return {"key": f"pm:{r.id}", "kind": "pm", "id": str(r.id), "reference": r.work_order_no,
        "date": r.due_on.isoformat(), **_plant_fields(p),
        "title": r.task_name, "equipment": r.task_type or r.equipment_ref,
        "subpart": r.equipment_ref, "unit": r.unit_no,
        "assignee": r.assignee_text, "engineer": p.assigned_engineer,
        "status": r.status, "severity": None,
        "tone": _tone("pm", r.status, None, r.due_on)}


def _event_wash(r: WashingDailyReport, p: Plant) -> dict:
    return {"key": f"washing:{r.id}", "kind": "washing", "id": str(r.id),
        "reference": f"Cycle {r.cycle_no} · {r.cycle_month}",
        "date": r.report_date.isoformat(), **_plant_fields(p), "title": "Panel washing",
        "equipment": WASHING_TYPE, "subpart": None,
        "assignee": r.reported_by, "engineer": p.assigned_engineer,
        "status": r.review_status, "job_status": r.job_status, "severity": None,
        "tables_cleaned": r.tables_cleaned,
        "tone": _tone("washing", r.review_status, None, r.report_date, r.job_status)}


def _calendar_months(start: date, end: date) -> list[date]:
    """A bounded list of affected calendar months, including any crossed year boundary."""
    months = []
    cursor = start.replace(day=1)
    while cursor <= end:
        months.append(cursor)
        cursor = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
    return months


def _cycle_record(p: Plant, cfg: WashingConfig, due: date, start: date, month: str,
                  number: int, state: str, assignee: str | None, reports: int,
                  confirmed: bool) -> dict:
    label = f"Cycle {number} due"
    return {"key": f"washing-cycle:{p.id}:{month}:{number}",
        "kind": "washing", "source": "cycle", "id": f"{p.id}:{month}:{number}",
        "reference": f"Cycle {number} · {month}", "date": due.isoformat(),
        **_plant_fields(p), "title": label, "equipment": WASHING_TYPE,
        "subpart": None, "assignee": assignee, "engineer": p.assigned_engineer,
        "status": state, "severity": None, "start_date": start.isoformat(),
        "reports": reports, "cycle_no": number, "cycle_month": month,
        "tone": "done" if confirmed else "overdue" if due < business_today() else "washing"}


FACETS = ("equipment", "subpart", "engineer", "assignee", "status", "severity")


def _get_data(db, user, start, end, plant_id=None, kinds=None, equipment=None, subpart=None,
              engineer=None, assignee=None, status=None, severity=None, search=None, cap=1000, offset=0,
              summary=False):
    """Calendar events for the period, or with ``summary`` only per-day counts by kind plus filter options.

    The summary runs the same filtered, permission-scoped queries but selects just the date and filter
    columns, so a month view never builds or transfers thousands of full event rows."""
    scope = _allowed(db, user, plant_id)
    types = user_scoped_equipment_types(db, user) if user.role == "Assignee" else None
    counts: dict[str, dict[str, int]] = {}
    facets: dict[str, set[str]] = {name: set() for name in FACETS}

    def tally(kind, day, **values):
        if day is None: return
        counts.setdefault(day, {"issue": 0, "pm": 0, "washing": 0})[kind] += 1
        for name, value in values.items():
            if value: facets[name].add(value)

    def finish_summary():
        return {"days": counts, "facets": {name: sorted(v, key=str.casefold)[:150] for name, v in facets.items()}}

    if (scope is not None and not scope) or (types is not None and not types):
        return finish_summary() if summary else ([], False)
    allowed_kinds = set(kinds or ("issue", "pm", "washing"))
    # The max is enforced in SQL, never in Python after loading all history.
    take = cap + offset + 1
    result = []
    shared = [Plant.id.in_(scope)] if scope is not None else []
    if plant_id: shared.append(Plant.id == plant_id)
    if engineer: shared.append(Plant.assigned_engineer.ilike(f"%{engineer}%"))
    search_text = f"%{search}%" if search else None
    if "issue" in allowed_kinds:
        utc_from = datetime.combine(start, time.min, tzinfo=BUSINESS_TZ).astimezone(timezone.utc)
        utc_until = datetime.combine(end + timedelta(days=1), time.min, tzinfo=BUSINESS_TZ).astimezone(timezone.utc)
        query = (select(Issue, Plant).join(Plant, Plant.id == Issue.plant_id)
            .where(*shared, Issue.deleted_at.is_(None), Issue.occurred_at >= utc_from, Issue.occurred_at < utc_until))
        if types is not None: query = query.where(_issue_auth(types))
        if equipment: query = query.where(or_(Issue.vertical.ilike(f"%{equipment}%"), Issue.equipment_ref.ilike(f"%{equipment}%")))
        if subpart: query = query.where(Issue.subcategory.ilike(f"%{subpart}%"))
        if assignee: query = query.where(Issue.assignee_text.ilike(f"%{assignee}%"))
        if status: query = query.where(func.lower(Issue.status) == status.casefold())
        if severity: query = query.where(func.lower(Issue.severity) == severity.casefold())
        if search_text: query = query.where(or_(Issue.ticket_no.ilike(search_text), Issue.description.ilike(search_text), Issue.vertical.ilike(search_text), Issue.subcategory.ilike(search_text), Issue.equipment_ref.ilike(search_text), Issue.assignee_text.ilike(search_text), Plant.plant_name.ilike(search_text), Plant.site_code.ilike(search_text), Plant.assigned_engineer.ilike(search_text)))
        if summary:
            for when, vertical, ref, sub, who, st, sev, eng in db.execute(query.with_only_columns(
                    Issue.occurred_at, Issue.vertical, Issue.equipment_ref, Issue.subcategory, Issue.assignee_text,
                    Issue.status, Issue.severity, Plant.assigned_engineer)):
                tally("issue", _issue_date(when), equipment=vertical or ref, subpart=sub, assignee=who,
                      status=st, severity=sev, engineer=eng)
        else:
            result.extend(_event_issue(r, p) for r, p in db.execute(query.order_by(Issue.occurred_at, Issue.id).limit(take)))
    if "pm" in allowed_kinds:
        query = (select(OMTask, Plant).join(Plant, Plant.id == OMTask.plant_id)
            .where(*shared, OMTask.due_on >= start, OMTask.due_on <= end))
        if types is not None: query = query.where(_pm_auth(types))
        if equipment: query = query.where(or_(OMTask.task_type.ilike(f"%{equipment}%"), OMTask.equipment_ref.ilike(f"%{equipment}%")))
        if subpart: query = query.where(OMTask.equipment_ref.ilike(f"%{subpart}%"))
        if assignee: query = query.where(OMTask.assignee_text.ilike(f"%{assignee}%"))
        if status:
            if status.casefold() == "overdue":
                query = query.where(OMTask.due_on < business_today(),
                    func.lower(OMTask.status).not_in(["completed", "cancelled", "canceled"]))
            else:
                query = query.where(func.lower(OMTask.status) == status.casefold())
        if severity: query = query.where(False)  # PM has no severity column
        if search_text: query = query.where(or_(OMTask.work_order_no.ilike(search_text), OMTask.task_name.ilike(search_text), OMTask.task_type.ilike(search_text), OMTask.equipment_ref.ilike(search_text), OMTask.assignee_text.ilike(search_text), Plant.plant_name.ilike(search_text), Plant.site_code.ilike(search_text), Plant.assigned_engineer.ilike(search_text)))
        if summary:
            for due, kind_, ref, who, st, eng in db.execute(query.with_only_columns(
                    OMTask.due_on, OMTask.task_type, OMTask.equipment_ref, OMTask.assignee_text, OMTask.status,
                    Plant.assigned_engineer)):
                tally("pm", due.isoformat(), equipment=kind_ or ref, subpart=ref, assignee=who, status=st, engineer=eng)
        else:
            result.extend(_event_pm(r, p) for r, p in db.execute(query.order_by(OMTask.due_on, OMTask.id).limit(take)))
    if "washing" in allowed_kinds and user.role != "Administration" and (types is None or WASHING_TYPE.casefold() in types):
        query = (select(WashingDailyReport, Plant).join(Plant, Plant.id == WashingDailyReport.plant_id)
            .where(*shared, WashingDailyReport.report_date >= start, WashingDailyReport.report_date <= end))
        if equipment and equipment.casefold() not in WASHING_TYPE.casefold() and equipment.casefold() not in "panel washing": query = query.where(False)
        if subpart: query = query.where(False)
        if assignee: query = query.where(WashingDailyReport.reported_by.ilike(f"%{assignee}%"))
        if status: query = query.where(or_(func.lower(WashingDailyReport.review_status) == status.casefold(), func.lower(WashingDailyReport.job_status) == status.casefold()))
        if severity: query = query.where(False)
        if search_text: query = query.where(or_(WashingDailyReport.reported_by.ilike(search_text), WashingDailyReport.remarks.ilike(search_text), WashingDailyReport.job_status.ilike(search_text), Plant.plant_name.ilike(search_text), Plant.site_code.ilike(search_text), Plant.assigned_engineer.ilike(search_text)))
        if summary:
            for day, who, st, eng in db.execute(query.with_only_columns(
                    WashingDailyReport.report_date, WashingDailyReport.reported_by, WashingDailyReport.review_status,
                    Plant.assigned_engineer)):
                tally("washing", day.isoformat(), equipment=WASHING_TYPE, assignee=who, status=st, engineer=eng)
        else:
            result.extend(_event_wash(r, p) for r, p in db.execute(query.order_by(WashingDailyReport.report_date, WashingDailyReport.id).limit(take)))
        # Scheduled cycle due dates are configured independently of daily reports.
        # A cycle deadline is one activity; each actual daily report is another,
        # with a distinct key. Never synthesize a confirmed/completed report.
        if not subpart and not severity and (not equipment or equipment.casefold() in
            WASHING_TYPE.casefold() or equipment.casefold() in "panel washing cycle"):
            months = _calendar_months(start, end)
            month_keys = [m.strftime("%Y-%m") for m in months]
            cycle_query = (select(WashingConfig, Plant, User.display_name)
                .join(Plant, Plant.id == WashingConfig.plant_id)
                .outerjoin(User, User.id == WashingConfig.assigned_user_id)
                .where(*shared, WashingConfig.active.is_(True)))
            if assignee: cycle_query = cycle_query.where(User.display_name.ilike(f"%{assignee}%"))
            configs = list(db.execute(cycle_query))
            if configs:
                authorized_ids = [p.id for _, p, _ in configs]
                approved = case((and_(WashingDailyReport.cycle_completed.is_(True),
                    WashingDailyReport.review_status == "Confirmed"), 1), else_=0)
                active_report = case((WashingDailyReport.review_status.in_(["Pending", "Confirmed"]), 1), else_=0)
                completed_query = (select(WashingDailyReport.plant_id, WashingDailyReport.cycle_month,
                    WashingDailyReport.cycle_no, func.sum(approved), func.sum(active_report))
                    .where(WashingDailyReport.plant_id.in_(authorized_ids),
                        WashingDailyReport.cycle_month.in_(month_keys))
                    .group_by(WashingDailyReport.plant_id, WashingDailyReport.cycle_month,
                        WashingDailyReport.cycle_no))
                ledger = {(pid, mon, num): (bool(done), int(count or 0))
                    for pid, mon, num, done, count in db.execute(completed_query)}
                for cfg, p, display_name in configs:
                    for m in months:
                        month = m.strftime("%Y-%m")
                        starts = _cycle_start_dates(m, cfg.cycle_overrides)
                        dues = _cycle_due_dates(m, cfg.cycle_overrides)
                        for n, (begin, due) in enumerate(zip(starts, dues), 1):
                            if not start <= due <= end: continue
                            confirmed, report_count = ledger.get((p.id, month, n), (False, 0))
                            state = "Completed" if confirmed else "In progress" if report_count else (
                                "Missed" if due < business_today() else "Upcoming")
                            if status:
                                if status.casefold() == "overdue":
                                    if confirmed or due >= business_today(): continue
                                elif state.casefold() != status.casefold(): continue
                            if search_text and search.casefold() not in (f"cycle {n}").casefold() and not (
                                search.casefold() in p.plant_name.casefold() or
                                search.casefold() in (p.site_code or "").casefold() or
                                search.casefold() in (display_name or "").casefold() or
                                search.casefold() in (p.assigned_engineer or "").casefold() or
                                search.casefold() in "washing" or search.casefold() in "cycle"):
                                continue
                            if summary:
                                tally("washing", due.isoformat(), equipment=WASHING_TYPE, assignee=display_name,
                                      status=state, engineer=p.assigned_engineer)
                            else:
                                result.append(_cycle_record(p, cfg, due, begin, month, n, state,
                                    display_name, report_count, confirmed))
    if summary:
        return finish_summary()
    result.sort(key=lambda e: (e["date"], e["kind"], e["key"]))
    return result[offset:offset + cap], len(result) > offset + cap


@router.get("")
def list_calendar(start: date, end: date,
    db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
    plant_id: UUID | None = None, activity_type: str | None = None,
    equipment: str | None = Query(None, max_length=120), subpart: str | None = Query(None, max_length=160),
    engineer: str | None = Query(None, max_length=160), assignee: str | None = Query(None, max_length=160),
    status: str | None = Query(None, max_length=80), severity: str | None = Query(None, max_length=60),
    q: str | None = Query(None, max_length=160), limit: int = Query(1500, ge=1, le=2000),
    offset: int = Query(0, ge=0, le=10000)):
    if end < start or (end - start).days > MAX_DAYS:
        raise HTTPException(422, f"Date range must be 1–{MAX_DAYS + 1} days")
    if activity_type and activity_type not in {"issue", "pm", "washing"}:
        raise HTTPException(422, "Unknown activity type")
    rows, more = _get_data(db, user, start, end, plant_id,
        {activity_type} if activity_type else None, equipment, subpart,
        engineer, assignee, status, severity, q, limit, offset)
    return {"events": rows, "has_more": more, "next_offset": offset + len(rows) if more else None,
        "start": start.isoformat(), "end": end.isoformat()}


@router.get("/summary")
def calendar_summary(start: date, end: date,
    db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
    plant_id: UUID | None = None, activity_type: str | None = None,
    equipment: str | None = Query(None, max_length=120), subpart: str | None = Query(None, max_length=160),
    engineer: str | None = Query(None, max_length=160), assignee: str | None = Query(None, max_length=160),
    status: str | None = Query(None, max_length=80), severity: str | None = Query(None, max_length=60),
    q: str | None = Query(None, max_length=160)):
    """Per-day counts by activity type for month/week grids; records load per day from the list endpoint."""
    if end < start or (end - start).days > MAX_DAYS:
        raise HTTPException(422, f"Date range must be 1–{MAX_DAYS + 1} days")
    if activity_type and activity_type not in {"issue", "pm", "washing"}:
        raise HTTPException(422, "Unknown activity type")
    out = _get_data(db, user, start, end, plant_id, {activity_type} if activity_type else None, equipment,
        subpart, engineer, assignee, status, severity, q, summary=True)
    return {**out, "start": start.isoformat(), "end": end.isoformat()}


@router.get("/washing-cycle/{plant_id}/{month}/{cycle_no}")
def cycle_detail(plant_id: UUID, month: str, cycle_no: int,
                 db: Annotated[Session, Depends(get_db)],
                 user: Annotated[User, Depends(get_current_user)]):
    _allowed(db, user, plant_id)
    if user.role == "Administration" or (user.role == "Assignee" and
            WASHING_TYPE.casefold() not in user_scoped_equipment_types(db, user)):
        raise HTTPException(403, "Washing is outside your assigned scope")
    if cycle_no not in (1, 2, 3): raise HTTPException(404, "Cycle not found")
    try:
        value = date.fromisoformat(month + "-01")
        if value.strftime("%Y-%m") != month: raise ValueError
    except ValueError:
        raise HTTPException(422, "Invalid cycle month")
    cfg = db.get(WashingConfig, plant_id)
    if cfg is None or not cfg.active: raise HTTPException(404, "Cycle not configured")
    info = month_cycles(db, user, plant_id, month)
    row = info["cycles"][cycle_no - 1]
    plant = db.get(Plant, plant_id)
    assignee = db.get(User, cfg.assigned_user_id) if cfg.assigned_user_id else None
    out = _cycle_record(plant, cfg, date.fromisoformat(row["due_date"]),
        date.fromisoformat(row["start_date"]), month, cycle_no, row["state"],
        assignee.display_name if assignee else None, row["reports"],
        row["state"] == "Completed")
    out.update({"target_count": info["table_count"],
        "confirmed": row["confirmed"], "pending": row["pending"],
        "completed_on": row["completed_on"], "remarks": cfg.notes,
        "can_edit": info["can_edit"], "evidence": []})
    return out


@router.get("/{kind}/{record_id}")
def event_detail(kind: str, record_id: UUID, db: Annotated[Session, Depends(get_db)],
                 user: Annotated[User, Depends(get_current_user)]):
    if kind not in {"issue", "pm", "washing"}: raise HTTPException(404, "Event not found")
    scope = _allowed(db, user, None)
    types = user_scoped_equipment_types(db, user) if user.role == "Assignee" else None
    model = {"issue": Issue, "pm": OMTask, "washing": WashingDailyReport}[kind]
    row = db.get(model, record_id)
    if row is None or (kind == "issue" and row.deleted_at is not None): raise HTTPException(404, "Event not found")
    if scope is not None and row.plant_id not in scope: raise HTTPException(403, "Plant is outside your assigned scope")
    if kind == "washing" and (user.role == "Administration" or (types is not None and WASHING_TYPE.casefold() not in types)):
        raise HTTPException(403, "Washing is outside your assigned scope")
    if kind == "issue" and types is not None:
        if not db.scalar(select(Issue.id).where(Issue.id == record_id, _issue_auth(types))): raise HTTPException(403, "Equipment is outside your assigned scope")
    if kind == "pm" and types is not None:
        if not db.scalar(select(OMTask.id).where(OMTask.id == record_id, _pm_auth(types))): raise HTTPException(403, "Equipment is outside your assigned scope")
    plant = db.get(Plant, row.plant_id) if row.plant_id else None
    if plant is None: raise HTTPException(404, "Plant not found")
    if kind == "issue":
        reporter = db.get(User, row.created_by) if row.created_by else None
        assignee = db.get(User, row.assigned_to) if row.assigned_to else None
        out = _event_issue(row, plant, reporter.display_name if reporter else None)
        out.update({"description": row.description, "remarks": (row.legacy_payload or {}).get("remarks"),
            "equipment_ref": row.equipment_ref, "occurred_at": row.occurred_at.isoformat() if row.occurred_at else None,
            "due_date": row.etc_at.isoformat() if row.etc_at else None,
            "assignee": row.assignee_text or (assignee.display_name if assignee else None),
            "impact": row.impact,
            "evidence": [{"name": e.get("name") or e.get("filename") or "Evidence", "url":
                f"/api/issues/{row.id}/evidence/{e.get('id')}"} for e in row.evidence if e.get("id")]})
        out["can_edit"] = bool(ROLE_PERMISSIONS.get(user.role, set()) &
            {"issues.manage", "issues.progress", "issues.resolve", "issues.close"})
        return out
    if kind == "pm":
        out = _event_pm(row, plant)
        out.update({"planned_due": row.planned_due_on.isoformat() if row.planned_due_on else None,
            "start": row.start_on.isoformat() if row.start_on else None,
            "completed_on": row.actual_completed_on.isoformat() if row.actual_completed_on else None,
            "remarks": (row.completion or {}).get("notes") if isinstance(row.completion, dict) else None,
            "completion": row.completion, "steps": (row.legacy_payload or {}).get("steps"),
            "frequency": row.frequency, "quantity": row.quantity, "total_units": row.total_units,
            "can_edit": bool(ROLE_PERMISSIONS.get(user.role, set()) & {"tasks.manage", "tasks.execute"}),
            "evidence": [{"name": item.get("kind", "Evidence"), "url":
                f"/api/scheduled/tasks/{row.work_order_no}/evidence/{item.get('kind')}"}
                for item in row.evidence or [] if isinstance(item, dict) and item.get("kind") in {"before", "after"}]})
        return out
    cfg = db.get(WashingConfig, row.plant_id)
    out = _event_wash(row, plant)
    out.update({"remarks": row.remarks, "exception_reason": row.exception_reason,
        "target_count": cfg.tables_per_cycle if cfg else None,
        "reported_by": row.reported_by, "reviewed_by": row.reviewed_by,
        "review_note": row.review_note, "reviewed_at": row.reviewed_at.isoformat() if row.reviewed_at else None,
        "cycle_completed": row.cycle_completed,
        "can_edit": user.role == "O&M Head" or (row.reported_by_id == user.id and row.review_status in {"Pending", "Rejected"}),
        "evidence": [{"name": e.get("kind") or "Evidence", "url":
            f"/api/scheduled/washing/daily-reports/{row.id}/evidence/{e.get('id')}"}
            for e in row.evidence or [] if isinstance(e, dict) and e.get("id")]})
    return out
