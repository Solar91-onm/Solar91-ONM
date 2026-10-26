"""Default ticket deadlines per priority (Critical / Medium).

A new ticket without an explicit deadline is due this many hours after it is raised. The O&M Head changes the
durations through ``PUT /api/issues/deadlines``; they are stored in ``app_settings`` and these defaults apply until
then. A change applies to tickets raised afterwards. Only when the O&M Head also asks for it (``apply_to_open``) are
open tickets that still carry the old default moved to the new one; ``dry_run`` previews how many. A ticket whose
deadline was ever changed by hand, or that was given its own target date, always keeps it.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from app.core.models import AppSetting, AuditLog, Issue, IssueETCChange, User
from app.issues.schemas import SEVERITY_STORED_AS, normalize_issue_severity

DEADLINE_SETTING = "issue_deadline_hours"
DEFAULT_DEADLINE_HOURS = {"Critical": 48, "Medium": 96}
MIN_DEADLINE_HOURS = 1
MAX_DEADLINE_HOURS = 24 * 90
# A ticket "still has the default" when its deadline is the default duration after it was raised. Tickets raised from
# the form before October 2026 were stored 5.5 h late (local time read as UTC), hence the wider upper margin.
DEFAULT_MATCH_EARLY = timedelta(hours=1)
DEFAULT_MATCH_LATE = timedelta(hours=6)
OPEN_EXCLUDED = ("Resolved", "Closed")


def deadline_hours(db: Session) -> dict[str, int]:
    row = db.get(AppSetting, DEADLINE_SETTING)
    stored = row.setting_value if row is not None and isinstance(row.setting_value, dict) else {}
    hours = dict(DEFAULT_DEADLINE_HOURS)
    for severity in hours:
        try:
            value = int(stored.get(severity))
        except (TypeError, ValueError):
            continue
        if MIN_DEADLINE_HOURS <= value <= MAX_DEADLINE_HOURS:
            hours[severity] = value
    return hours


def default_deadline(db: Session, severity: str, start: datetime | None = None) -> datetime:
    start = start or datetime.now(timezone.utc)
    hours = deadline_hours(db).get(normalize_issue_severity(severity), DEFAULT_DEADLINE_HOURS["Critical"])
    return start + timedelta(hours=hours)


def deadline_settings(db: Session) -> dict:
    row = db.get(AppSetting, DEADLINE_SETTING)
    return {
        "hours": deadline_hours(db),
        "defaults": dict(DEFAULT_DEADLINE_HOURS),
        "min_hours": MIN_DEADLINE_HOURS,
        "max_hours": MAX_DEADLINE_HOURS,
        "updated_at": row.updated_at.isoformat() if row is not None and row.updated_at else None,
    }


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _open_ticket_plan(db: Session, before: dict[str, int], wanted: dict[str, int], lock: bool) -> dict:
    """Open tickets per priority whose deadline is still the old default, and what each would move to."""
    plan = {"moves": [], "by_severity": {"Critical": 0, "Medium": 0}, "kept_changed": 0, "kept_custom": 0}
    for severity in ("Critical", "Medium"):
        if before[severity] == wanted[severity]:
            continue
        changed_by_hand = exists().where(IssueETCChange.issue_id == Issue.id)
        stmt = select(Issue, changed_by_hand.label("changed")).where(
            Issue.deleted_at.is_(None), Issue.status.notin_(OPEN_EXCLUDED),
            Issue.severity.in_(SEVERITY_STORED_AS[severity]), Issue.etc_at.is_not(None),
        )
        if lock:
            stmt = stmt.with_for_update(of=Issue)
        old = timedelta(hours=before[severity])
        for issue, changed in db.execute(stmt):
            raised, due = _utc(issue.created_at), _utc(issue.etc_at)
            if changed:
                plan["kept_changed"] += 1
            elif raised is None or not (old - DEFAULT_MATCH_EARLY <= due - raised <= old + DEFAULT_MATCH_LATE):
                plan["kept_custom"] += 1
            else:
                plan["moves"].append((issue, severity, raised + timedelta(hours=wanted[severity])))
                plan["by_severity"][severity] += 1
    return plan


def _plan_summary(plan: dict | None) -> dict | None:
    if plan is None:
        return None
    return {"moved": len(plan["moves"]), "by_severity": plan["by_severity"],
            "kept_changed_by_hand": plan["kept_changed"], "kept_own_target": plan["kept_custom"]}


def save_deadline_hours(db: Session, user: User, critical_hours: int, medium_hours: int,
                        apply_to_open: bool = False, dry_run: bool = False) -> dict:
    """O&M Head only: change the default deadline of new Critical and Medium tickets, and optionally move open
    tickets that still carry the old default. ``dry_run`` saves nothing and reports what would happen."""
    if user.role != "O&M Head":
        raise HTTPException(403, "Only the O&M Head can change the default ticket deadlines")
    wanted = {"Critical": int(critical_hours), "Medium": int(medium_hours)}
    for severity, value in wanted.items():
        if not MIN_DEADLINE_HOURS <= value <= MAX_DEADLINE_HOURS:
            raise HTTPException(422, f"The {severity} deadline must be between {MIN_DEADLINE_HOURS} hour and {MAX_DEADLINE_HOURS // 24} days")
    if dry_run:
        plan = _open_ticket_plan(db, deadline_hours(db), wanted, lock=False)
        db.rollback()
        return {**deadline_settings(db), "preview": {"hours": wanted, "open_tickets": _plan_summary(plan)}}
    row = db.get(AppSetting, DEADLINE_SETTING, with_for_update=True)
    before = deadline_hours(db)
    plan = _open_ticket_plan(db, before, wanted, lock=True) if apply_to_open else None
    if before == wanted and row is not None:
        return {**deadline_settings(db), "open_tickets": _plan_summary(plan)}
    if row is None:
        db.add(AppSetting(setting_key=DEADLINE_SETTING, setting_value=wanted, updated_by=user.id))
    else:
        row.setting_value = wanted
        row.updated_by = user.id
    if plan:
        from app.issues.service import IssueService, issue_local_today
        service = IssueService(db)
        now = datetime.now(timezone.utc)
        for issue, severity, new_etc in plan["moves"]:
            reason = f"Default {severity} deadline changed from {before[severity]} h to {wanted[severity]} h by the O&M Head"
            db.add(IssueETCChange(issue_id=issue.id, old_etc=issue.etc_at, new_etc=new_etc, reason=reason,
                                  changed_by=user.id, changed_by_name=user.display_name))
            service._history(issue, "issue.etc_changed", user, note=reason, work_date=issue_local_today(),
                             metadata={"old_etc": _utc(issue.etc_at).isoformat(), "new_etc": new_etc.isoformat(), "bulk_default_change": True})
            issue.etc_at = new_etc
            issue.updated_at = now
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name,
        action="Changed default ticket deadlines", module="Issues",
        entity_type="setting", entity_id=DEADLINE_SETTING,
        metadata_json={"from": before, "to": wanted, "open_tickets": _plan_summary(plan)},
    ))
    db.commit()
    return {**deadline_settings(db), "open_tickets": _plan_summary(plan)}
