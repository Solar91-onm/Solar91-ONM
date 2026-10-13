"""Unit-level Preventive Maintenance scheduling.

Rules (agreed workflow):
  * A plant + equipment type has N units and a daily capacity (units that can be maintained per day).
  * Units are numbered 1..N and scheduled on consecutive calendar days, `capacity` units per day,
    starting at the first due date (e.g. 10 inverters at 2/day = 5 days: 1-2, 3-4, 5-6, 7-8, 9-10).
  * Each unit then recurs on its own due date by the task frequency (completing unit 3 creates next
    month's unit 3), so the day pattern repeats every period.
  * A unit not done by its day is "missed": the daily job stores the miss on the task (missed_days,
    rolled_count, log), moves it to the front of today's capacity, shifts later units of the same
    cycle back, and notifies higher roles using the escalation matrix (1 day assignee, 3 days
    supervisor, 7 days O&M Head).
  * The same job sends the advance (3 days before) and due-date reminders from workflow 2.1.2.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.models import OMTask, PMUnitConfig

ADVANCE_DAYS = 3
# Kept as a compatibility constant for clients/tests that still inspect legacy rules.
ESCALATION = [(7, "critical"), (3, "site_engineer"), (1, "assignee_and_head")]
OPEN_STATUSES = {"Scheduled", "In Progress"}


def distribute(unit_nos: list[int], per_day: int | None, start: date) -> list[tuple[int, int, date]]:
    """Return (unit_no, cycle_day, due_date) for each unit. per_day None/0 = all units on the first day."""
    cap = per_day if per_day and per_day > 0 else max(1, len(unit_nos))
    out = []
    for i, n in enumerate(sorted(unit_nos)):
        day = i // cap + 1
        out.append((n, day, start + timedelta(days=day - 1)))
    return out


def day_plan(rows: list[tuple[int, date]]) -> list[dict[str, Any]]:
    """[(unit_no, due)] -> [{'date','units':[...]}] ordered by date (used by dashboards/tests)."""
    by: dict[date, list[int]] = {}
    for n, d in rows:
        by.setdefault(d, []).append(n)
    return [{"date": d.isoformat(), "units": sorted(u)} for d, u in sorted(by.items())]


def next_cycle_id(cycle_id: str | None) -> str | None:
    """'ab12cd34' -> 'ab12cd34.1' -> 'ab12cd34.2' (units of one period share an id)."""
    if not cycle_id:
        return None
    base, _, gen = cycle_id.partition(".")
    return f"{base}.{int(gen or 0) + 1}"


def _stamp(text: str) -> dict[str, str]:
    return {"at": datetime.now().isoformat(), "text": text, "actor": "System"}


def roll_missed_units(db: Session, today: date) -> int:
    """Move missed units forward (front of today's capacity) and record the miss. Returns units rolled."""
    rows = list(db.scalars(select(OMTask).where(
        OMTask.unit_no.is_not(None), OMTask.cycle_id.is_not(None), OMTask.status.in_(OPEN_STATUSES))))
    groups: dict[str, list[OMTask]] = {}
    for t in rows:
        groups.setdefault(t.cycle_id, []).append(t)
    rolled = 0
    for cycle_id, tasks in groups.items():
        movable = [t for t in tasks if t.status == "Scheduled"]
        missed = [t for t in movable if t.due_on and t.due_on < today]
        if not missed:
            continue
        sample = tasks[0]
        cfg = db.scalar(select(PMUnitConfig).where(
            PMUnitConfig.plant_id == sample.plant_id, PMUnitConfig.equipment_type == sample.task_type))
        if cfg:
            per_day = cfg.units_per_day
        else:                                   # no configuration: use the largest day of the original plan
            sizes: dict[date, int] = {}
            for t in tasks:
                d = t.planned_due_on or t.due_on
                sizes[d] = sizes.get(d, 0) + 1
            per_day = max(sizes.values()) if sizes else 1
        per_day = max(1, per_day)
        start = min((t.planned_due_on or t.due_on) for t in tasks if (t.planned_due_on or t.due_on))
        rest = [t for t in movable if t not in missed]
        missed.sort(key=lambda t: ((t.planned_due_on or t.due_on), t.unit_no))
        rest.sort(key=lambda t: (t.due_on, t.unit_no))
        day, used = today, 0
        for t in missed + rest:
            is_missed = t in missed
            if not is_missed and t.due_on > day:       # never pull a later unit earlier
                day, used = t.due_on, 0
            old_due = t.due_on
            if t.planned_due_on is None:
                t.planned_due_on = old_due
            if is_missed:
                t.missed_days = max(0, (today - t.planned_due_on).days)
                t.rolled_count = (t.rolled_count or 0) + 1
                t.log = [_stamp(f"Missed {old_due.isoformat()} — rolled to {day.isoformat()} "
                                f"({t.missed_days} day(s) behind plan)"), *(t.log or [])]
                rolled += 1
            if t.due_on != day:
                t.due_on = day
                t.cycle_day = (day - start).days + 1
            used += 1
            if used >= per_day:
                day, used = day + timedelta(days=1), 0
    return rolled


def _alert_groups(
    rows: list[OMTask],
) -> list[tuple[OMTask, list[OMTask], date | None, str]]:
    """Build alert units; legacy per-unit rows share one alert per plant/type/cycle."""
    groups: dict[tuple[object, str, str], list[OMTask]] = {}
    result: list[tuple[OMTask, list[OMTask], date | None, str]] = []
    for task in rows:
        if task.unit_no is not None and task.cycle_id:
            key = (task.plant_id, (task.task_type or "").casefold(), task.cycle_id)
            groups.setdefault(key, []).append(task)
        else:
            due = task.planned_due_on or task.due_on
            result.append((task, [task], due, str(task.id)))
    for (plant_id, equipment_type, cycle_id), members in groups.items():
        members.sort(key=lambda item: (item.unit_no or 0, item.id))
        due_dates = [member.planned_due_on or member.due_on for member in members]
        due = max((value for value in due_dates if value is not None), default=None)
        anchor = members[0]
        group_key = f"legacy:{plant_id}:{equipment_type}:{cycle_id}"
        result.append((anchor, members, due, group_key))
    result.sort(key=lambda item: (item[2] or date.max, item[0].work_order_no))
    return result


def send_reminders_and_escalations(db: Session, today: date, now: datetime | None = None) -> dict[str, int]:
    from app.pmplan.alerts import send_pm_alerts

    return send_pm_alerts(db, today, now)


def run_daily(db: Session, today: date | None = None, now: datetime | None = None) -> dict[str, Any]:
    """Idempotent: safe to run many times a day (rolling only acts on units due before today; notifications dedupe)."""
    today = today or date.today()
    rolled = roll_missed_units(db, today)
    sent = send_reminders_and_escalations(db, today, now)
    db.commit()
    return {"date": today.isoformat(), "rolled": rolled, **sent}
