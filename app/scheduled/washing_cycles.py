from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
import json
import re
import uuid
from typing import NamedTuple
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.timeutil import BUSINESS_TZ, business_today
from app.core.config import get_settings
from app.core.models import AppSetting, AuditLog, Notification, Plant, User, UserPlantAssignment, WashingConfig, WashingDailyReport, WashingHistory, WashingTable
from app.core.security import user_scoped_plant_ids
from app.notifications.service import notify_users, users_with_role
from app.scheduled.schemas import (
    WashingCycleDateRequest,
    WashingDailyReportRequest,
    WashingReportReviewRequest,
    WashingReportUpdateRequest,
    WashingBulkConfirmRequest,
    WashingSetupRequest,
    WashingSheetRequest,
)

MONTHLY_CYCLE_TARGET = 3
MAX_BACKDATE_DAYS = 45  # how far back a Site Engineer may enter a missed report
PHOTO_REQUIRED_DAYS = 3  # days entered within 3 days of the work need before/after photos; older back-filled days do not
OVERVIEW_REPORT_DAYS = 90  # the overview sends reports from the last 90 days (plus every report still awaiting review)
OVERVIEW_CACHE_SECONDS = 20
OVERVIEW_SEND_REPORT_DAYS = 35  # reports sent to the browser by default (this month + a little); ?report_days=90 sends the full window
_OVERVIEW_CACHE: dict[tuple, tuple[float, dict]] = {}
_OVERVIEW_VERSION = 0

# The scalar report columns the overview's figures are computed from (cycles, compliance, excused days, daily status,
# productivity, pending reviews). When the report list itself is not wanted (Overview, plant details, the plant tab),
# reports are read as plain rows of just these columns: no ORM objects and no photo evidence. Cleaned table codes are
# required for cycle grading and are the only JSON report field selected in summary mode.
_SUMMARY_REPORT_COLUMNS = (
    WashingDailyReport.id, WashingDailyReport.plant_id, WashingDailyReport.cycle_month, WashingDailyReport.cycle_no,
    WashingDailyReport.report_date, WashingDailyReport.job_status, WashingDailyReport.tables_cleaned,
    WashingDailyReport.cleaned_table_codes,
    WashingDailyReport.remarks, WashingDailyReport.exception_reason, WashingDailyReport.reported_by,
    WashingDailyReport.review_status, WashingDailyReport.cycle_completed, WashingDailyReport.is_extra,
    WashingDailyReport.created_at,
)


def invalidate_overview_cache() -> None:
    """Called after every write request, so a user always sees their own change straight away."""
    global _OVERVIEW_VERSION
    _OVERVIEW_VERSION += 1
    _OVERVIEW_CACHE.clear()


def _month_key(value: date) -> str:
    return value.strftime("%Y-%m")


# ───────────── days excused from the compliance score ─────────────
# A day with 0 tables cleaned is left out of the compliance target only when its remark names one of these reasons
# (whole words, any case: "Heavy rain since morning" matches "Rain"). Any other 0 day counts as 0 tables cleaned.
# The O&M Head manages the list through the API; it is stored in app_settings and these defaults apply until then.
EXCUSED_REASONS_SETTING = "washing_excused_reasons"
DEFAULT_EXCUSED_REASONS = ("Work not started", "Rain", "Water shortage")
MAX_EXCUSED_REASONS = 50
MAX_EXCUSED_REASON_LENGTH = 80


def _normalise_reason(text: object) -> str:
    return " ".join(str(text or "").split()).casefold()


def excused_reasons(db: Session) -> list[str]:
    row = db.get(AppSetting, EXCUSED_REASONS_SETTING)
    value = row.setting_value if row is not None else None
    if not isinstance(value, list):
        return list(DEFAULT_EXCUSED_REASONS)
    return [str(reason) for reason in value if _normalise_reason(reason)]


def _reason_patterns(reasons: list[str]) -> list[re.Pattern]:
    return [
        re.compile(r"(?<!\w)" + r"\s+".join(re.escape(word) for word in _normalise_reason(reason).split()) + r"(?!\w)")
        for reason in reasons if _normalise_reason(reason)
    ]


def _is_excused(report: WashingDailyReport, patterns: list[re.Pattern]) -> bool:
    """A 0-table day, awaiting confirmation or confirmed, whose remark (or an older entry's specific not-done
    reason, e.g. "Rain") names an excused reason. A rejected report never excuses its day."""
    if report.review_status == "Rejected" or report.job_status != "Not done" or report.tables_cleaned:
        return False
    text = _normalise_reason(report.remarks)
    if report.exception_reason and report.exception_reason != "Other":
        text += " " + _normalise_reason(report.exception_reason)
    return any(pattern.search(text) for pattern in patterns)


def _excused_dates(reports, patterns: list[re.Pattern]) -> set[date]:
    """Days left out of the compliance target: an excused 0 day, unless tables were also reported cleaned that day."""
    worked = {report.report_date for report in reports if report.review_status != "Rejected" and report.tables_cleaned}
    return {report.report_date for report in reports if _is_excused(report, patterns)} - worked


def _clean_reason(text: object) -> str:
    reason = " ".join(str(text or "").split())
    if not reason:
        raise HTTPException(422, "A reason cannot be empty")
    if len(reason) > MAX_EXCUSED_REASON_LENGTH:
        raise HTTPException(422, f"A reason must be {MAX_EXCUSED_REASON_LENGTH} characters or fewer")
    return reason


def save_excused_reasons(db: Session, user: User, reasons: list[str], action: str = "Changed") -> dict:
    """O&M Head only: replace the list of reasons that excuse a 0-table day from the compliance score."""
    if user.role != "O&M Head":
        raise HTTPException(403, "Only the O&M Head can change the reasons that excuse a washing day from compliance")
    cleaned: list[str] = []
    for reason in reasons:
        reason = _clean_reason(reason)
        if _normalise_reason(reason) not in {_normalise_reason(r) for r in cleaned}:
            cleaned.append(reason)
    if len(cleaned) > MAX_EXCUSED_REASONS:
        raise HTTPException(422, f"Keep the list to {MAX_EXCUSED_REASONS} reasons or fewer")
    row = db.get(AppSetting, EXCUSED_REASONS_SETTING, with_for_update=True)
    before = excused_reasons(db)
    if row is None:
        db.add(AppSetting(setting_key=EXCUSED_REASONS_SETTING, setting_value=cleaned, updated_by=user.id))
    else:
        row.setting_value = cleaned
        row.updated_by = user.id
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name,
        action=f"{action} washing compliance excused reasons", module="Washing",
        entity_type="setting", entity_id=EXCUSED_REASONS_SETTING,
        metadata_json={"from": before, "to": cleaned},
    ))
    db.commit()
    return {"reasons": cleaned, "defaults": list(DEFAULT_EXCUSED_REASONS)}


def add_excused_reason(db: Session, user: User, reason: str) -> dict:
    if user.role != "O&M Head":
        raise HTTPException(403, "Only the O&M Head can change the reasons that excuse a washing day from compliance")
    return save_excused_reasons(db, user, excused_reasons(db) + [_clean_reason(reason)], action="Added to")


def remove_excused_reason(db: Session, user: User, reason: str) -> dict:
    if user.role != "O&M Head":
        raise HTTPException(403, "Only the O&M Head can change the reasons that excuse a washing day from compliance")
    current = excused_reasons(db)
    kept = [r for r in current if _normalise_reason(r) != _normalise_reason(reason)]
    if len(kept) == len(current):
        raise HTTPException(404, "That reason is not in the list")
    return save_excused_reasons(db, user, kept, action="Removed from")


def list_excused_reasons(db: Session, user: User) -> dict:
    """The O&M team (O&M Head and washing Assignees) can read the list; only the O&M Head changes it."""
    if not _is_washing_manager(db, user):
        raise HTTPException(403, "Only the O&M team can see the washing compliance reasons")
    return {"reasons": excused_reasons(db), "defaults": list(DEFAULT_EXCUSED_REASONS), "can_edit": user.role == "O&M Head"}


PATTERN_KEY = "pattern"   # cycle_overrides["pattern"] = {"from": "YYYY-MM", "days": {"s1": 1, "1": 10, ...}}


def _month_overrides(value: date, overrides: dict | None) -> dict:
    """The cycle dates that apply to `value`'s month: the plant's repeating pattern (day numbers, clamped to the
    month's length, from the month it was set) overlaid by any dates saved for that specific month."""
    overrides = overrides or {}
    merged: dict = {}
    pattern = overrides.get(PATTERN_KEY)
    if isinstance(pattern, dict) and (not pattern.get("from") or _month_key(value) >= str(pattern["from"])):
        last = monthrange(value.year, value.month)[1]
        for key, day in (pattern.get("days") or {}).items():
            try:
                merged[str(key)] = date(value.year, value.month, min(max(1, int(day)), last)).isoformat()
            except (TypeError, ValueError):
                continue
    specific = overrides.get(_month_key(value))
    if isinstance(specific, dict):
        merged.update(specific)
    return merged


def _daily_table_target(table_count: int, value: date, overrides: dict | None = None) -> int:
    """Tables due on `value`. Default cycles are days 1-10, 11-20 and 21-month end; when the O&M team moved a
    cycle's start or deadline (`overrides`), the day's share is spread over that cycle's own window instead."""
    if overrides and _month_overrides(value, overrides):
        window = next(((a, b) for a, b in _cycle_windows(value, overrides) if a <= value <= b), None)
        if window is None:
            return 0
        start, end = window
        duration = (end - start).days + 1
        day_index = (value - start).days + 1
        before = (table_count * (day_index - 1) + duration - 1) // duration
        through = (table_count * day_index + duration - 1) // duration
        return through - before
    days_in_month = monthrange(value.year, value.month)[1]
    cycle_no = min(MONTHLY_CYCLE_TARGET, (value.day - 1) // 10 + 1)
    start_day = 1 + (cycle_no - 1) * 10
    duration = min(10, days_in_month - start_day + 1)
    day_index = min(duration, value.day - start_day + 1)
    before = (table_count * (day_index - 1) + duration - 1) // duration
    through = (table_count * day_index + duration - 1) // duration
    return through - before


def _default_due_dates(value: date) -> list[date]:
    last = monthrange(value.year, value.month)[1]
    return [date(value.year, value.month, 10), date(value.year, value.month, 20), date(value.year, value.month, last)]


def _cycle_due_dates(value: date, overrides: dict | None = None) -> list[date]:
    """Each month has 3 cycles, due by the 10th, the 20th and the last day of the month.

    The O&M Head can move any single deadline (stored per plant in washing_config.cycle_overrides)."""
    dates = _default_due_dates(value)
    for key, raw in _month_overrides(value, overrides).items():
        try:
            index = int(key) - 1
            if 0 <= index < MONTHLY_CYCLE_TARGET:
                dates[index] = date.fromisoformat(str(raw))
        except (TypeError, ValueError):
            continue
    return dates


def _default_start_dates(value: date) -> list[date]:
    return [date(value.year, value.month, 1), date(value.year, value.month, 11), date(value.year, value.month, 21)]


def _cycle_start_dates(value: date, overrides: dict | None = None) -> list[date]:
    """Each cycle's start date. Overrides are stored beside the deadlines under the keys "s1", "s2", "s3"."""
    dates = _default_start_dates(value)
    for key, raw in _month_overrides(value, overrides).items():
        try:
            if str(key).startswith("s"):
                index = int(str(key)[1:]) - 1
                if 0 <= index < MONTHLY_CYCLE_TARGET:
                    dates[index] = date.fromisoformat(str(raw))
        except (TypeError, ValueError):
            continue
    return dates


def _cycle_windows(value: date, overrides: dict | None = None) -> list[tuple[date, date]]:
    return list(zip(_cycle_start_dates(value, overrides), _cycle_due_dates(value, overrides)))


def _current_window(value: date, overrides: dict | None = None) -> tuple[int, date, date]:
    """The cycle whose planned window contains `value`: cycle 1 = days 1-10, 2 = 11-20, 3 = 21-month end, or the
    dates the O&M team set. Between moved windows it is the latest window that has started (before the first: 1)."""
    windows = _cycle_windows(value, overrides)
    for n, (start, end) in enumerate(windows, 1):
        if start <= value <= end:
            return n, start, end
    started = [n for n, (start, _end) in enumerate(windows, 1) if start <= value]
    n = started[-1] if started else 1
    return n, windows[n - 1][0], windows[n - 1][1]


def _cycle_compliance(table_count: int, today: date, overrides: dict | None, ledger: dict[int, dict],
                      excused_dates: set[date], window: tuple[int, date, date] | None = None) -> dict:
    """Compliance of one cycle (the one whose window contains `today` unless `window` is given): the confirmed tables
    counted in that cycle, including tables carried over from the previous one (_cycle_ledger), against the tables
    due from the window's start up to today (each day's share of the plant's count, excused days left out).
    A plant still finishing the previous cycle shows low compliance for the current one."""
    n, start, end = window or _current_window(today, overrides)
    upto = min(today, end)
    due = 0
    day = start
    while day <= upto:
        if day not in excused_dates:
            due += _daily_table_target(table_count, day, overrides)
        day += timedelta(days=1)
    due = min(due, table_count)
    done = ledger.get(n, {}).get("confirmed", 0)
    return {"cycle_no": n, "start": start.isoformat(), "end": end.isoformat(), "due": due, "done": done,
            "pending": ledger.get(n, {}).get("pending", 0),
        "percent": min(100, round(100 * done / due, 1)) if due else 0.0}


def _cycle_grade(cycle_no: int, reports: list, table_count: int, threshold_percent: int,
                 fast_window_days: int, start: date, due: date, today: date) -> dict:
    """Grade distinct cleaned tables against the configured cycle threshold and its due-date window."""
    eligible = [
        report for report in reports
        if report.cycle_no == cycle_no and str(report.review_status or "").lower() != "rejected"
    ]
    codes_by_day: dict[date, set[str]] = {}
    all_codes: set[str] = set()
    for report in eligible:
        for raw_code in report.cleaned_table_codes or []:
            code = str(raw_code).strip()
            if code:
                codes_by_day.setdefault(report.report_date, set()).add(code)
                all_codes.add(code)

    required = max(1, (table_count * max(1, min(100, threshold_percent)) + 99) // 100)
    accumulated: set[str] = set()
    days_to_target = None
    for report_day in sorted(codes_by_day):
        accumulated.update(codes_by_day[report_day])
        if len(accumulated) >= required:
            days_to_target = max(0, (report_day - start).days)
            break

    cycle_window_days = max(0, (due - start).days)
    if today < start:
        # A cycle that has not started is never graded or scored (e.g. Cycle 3 on the 17th).
        grade = "upcoming"
    elif days_to_target is not None:
        grade = (
            "on_target" if days_to_target <= fast_window_days
            else "on_time" if days_to_target <= cycle_window_days
            else "overdue"
        )
    else:
        grade = "missed" if today >= due else "running"

    return {
        "cycle_no": cycle_no,
        "start_date": start.isoformat(),
        "due_date": due.isoformat(),
        "grade": grade,
        "compliance_percent": 100 if grade in ("on_target", "on_time") else
            0 if grade in ("overdue", "missed") else None,
        "days_to_target": days_to_target,
        "coverage_count": len(all_codes),
        "coverage_percent": round(100 * len(all_codes) / table_count) if table_count else 0,
        "required_tables": required,
        "report_count": len(eligible),
        "due": today >= due,
    }


def _cycle_grade_summary(grades: list[dict]) -> dict:
    """Summarize one plant's cycle grades. Upcoming cycles are left out entirely; the compliance
    figure is the average of the started cycles' scores (see _cycle_work_scores)."""
    counts = {grade: sum(1 for item in grades if item["grade"] == grade)
              for grade in ("on_target", "on_time", "overdue", "missed", "running", "upcoming")}
    due = counts["on_target"] + counts["on_time"] + counts["overdue"] + counts["missed"]
    compliant = counts["on_target"] + counts["on_time"]
    scored = [item for item in grades
              if item["grade"] != "upcoming" and isinstance(item.get("tables_due"), int)]
    tables_due = sum(item["tables_due"] for item in scored)
    tables_done = sum(min(item.get("tables_done") or 0, item["tables_due"]) for item in scored)
    return {
        **counts,
        "due": due,
        "compliant": compliant,
        "not_started": sum(
            1 for item in grades if item["grade"] == "missed" and item["report_count"] == 0
        ),
        "compliance_percent": round(100 * tables_done / tables_due, 1) if tables_due else 0.0,
    }


def _post_cycle_three_extra_ids(reports) -> set[int]:
    """IDs of confirmed extra entries recorded after all three cycles were completed.

    Explicit re-cleaning between cycles remains a calendar record only. Additional cleaning
    after the final cycle is the only marked extra work that contributes to monthly compliance.
    """
    by_month: dict[str, list] = {}
    for report in reports:
        if report.review_status == "Confirmed":
            by_month.setdefault(report.cycle_month, []).append(report)

    eligible: set[int] = set()
    for month_reports in by_month.values():
        completed_cycles: set[int] = set()
        ordered = sorted(
            month_reports,
            key=lambda report: (
                report.report_date,
                str(getattr(report, "created_at", "") or ""),
            ),
        )
        for report in ordered:
            if getattr(report, "is_extra", False):
                if len(completed_cycles) >= MONTHLY_CYCLE_TARGET:
                    eligible.add(id(report))
            elif report.cycle_completed:
                completed_cycles.add(int(report.cycle_no))
    return eligible


def cleaning_activity_metrics(completed: float, planned: int, overdue: int = 0,
                              *, allow_extra: bool = False) -> dict[str, int | float]:
    """Cleaning compliance = completed / planned x 100, to one decimal place.

    Overdue is a subset of pending, never a second item in the denominator, and no planned
    activities gives 0% rather than a division by zero.

    The score is capped at 100% except for ONE plant with `allow_extra`: confirmed extra cleaning
    is work beyond the planned cycle progress, so its own score may read above 100%. Across several
    plants the score is always capped, so one plant's extra work cannot paper over another plant's shortfall.
    """
    def tidy(value: float) -> int | float:
        """Whole counts stay ints; only genuine part-cycles are fractional."""
        value = round(float(value), 1)
        return int(value) if float(value).is_integer() else value

    planned = max(0, int(planned or 0))
    # The percentage keeps full precision; only the displayed count is tidied, so the figure
    # cannot drift from the browser's own aggregate of the same numbers.
    exact = max(0.0, float(completed or 0))
    if not allow_extra:
        exact = min(exact, planned)
    completed = tidy(exact)
    pending = tidy(max(0.0, planned - completed))
    overdue = min(pending, max(0, int(overdue or 0)))
    return {
        "planned": planned,
        "completed": completed,
        "pending": pending,
        "overdue": overdue,
        "compliance_percent": round(100 * exact / planned, 1) if planned else 0.0,
    }


def _cycle_work_scores(reports, table_count: int, today: date, overrides: dict | None,
                       excused_dates: set[date]) -> dict:
    """Keep the monthly rate time-based, but score cycle progress by its assigned cycle number.

    Dates determine how much work is due for the monthly rate; they do not start Cycle 2 or Cycle 3.
    A cycle becomes active only after the previous cycle reaches the configured table count.
    """
    start_dates = _cycle_start_dates(today, overrides)
    due_dates = _cycle_due_dates(today, overrides)
    first_day = min(today.replace(day=1), start_dates[0])
    this_month = _month_key(today)
    post_cycle_three_extras = _post_cycle_three_extra_ids(reports)
    month_done = 0
    for report in reports:
        if report.review_status != "Confirmed" or not report.tables_cleaned:
            continue
        if getattr(report, "is_extra", False) and id(report) not in post_cycle_three_extras:
            continue
        if not first_day <= report.report_date <= today:
            continue
        month_done += int(report.tables_cleaned)

    month_due = 0
    for n in range(1, MONTHLY_CYCLE_TARGET + 1):
        start, due_date = start_dates[n - 1], due_dates[n - 1]
        if start <= today:
            month_due += _cycle_compliance(table_count, today, overrides, {}, excused_dates,
                                           window=(n, start, due_date))["due"]

    month = _month_key(today)
    active_reports = [report for report in reports if report.cycle_month == month and
                      report.report_date <= today and report.review_status in ("Pending", "Confirmed")]
    highest_report_cycle = max((report.cycle_no for report in active_reports), default=0)
    highest_completed_cycle = max(
        (report.cycle_no for report in active_reports
         if report.cycle_completed and report.review_status == "Confirmed"),
        default=0,
    )
    active_cycle = min(MONTHLY_CYCLE_TARGET, max(1, highest_report_cycle, highest_completed_cycle + 1))
    ledger = _cycle_ledger(active_reports, table_count)
    cycles = {}
    for n in range(1, MONTHLY_CYCLE_TARGET + 1):
        started = n <= active_cycle
        done = min(ledger[n]["confirmed"], table_count) if table_count else 0
        due = table_count if started else 0
        score = round(100 * done / due, 1) if due else None
        cycles[n] = {"tables_done": done, "tables_due": due, "score": score, "started": started}
    return {
        "cycles": cycles,
        "month": {
            "tables_done": month_done,
            "tables_due": month_due,
            "percent": round(100 * min(month_done, month_due) / month_due, 1) if month_due else 0.0,
        },
    }


def _overdue_info(completed_cycles: int, today: date, due_dates: list[date] | None = None) -> dict:
    """How late the plant is against the month's fixed cycle deadlines.

    Cycle k is overdue once its deadline has passed without k confirmed cycles. Late plants are grouped
    into a 1 / 3 / 7 day matrix: 1d = 1-2 days late, 3d = 3-6 days late, 7d = 7 or more days late.
    """
    due_dates = due_dates or _cycle_due_dates(today)
    elapsed = sum(1 for due in due_dates if due < today)
    if completed_cycles >= elapsed:
        return {"overdue_days": 0, "overdue_bucket": "on_track", "overdue_cycle": None, "next_due": due_dates[min(completed_cycles, 2)].isoformat()}
    due = due_dates[completed_cycles]
    days = (today - due).days
    bucket = "1d" if days < 3 else "3d" if days < 7 else "7d"
    return {"overdue_days": days, "overdue_bucket": bucket, "overdue_cycle": completed_cycles + 1, "next_due": due.isoformat()}


def _plant_for_id(db: Session, plant_id: UUID) -> Plant:
    plant = db.get(Plant, plant_id)
    if not plant:
        raise HTTPException(404, "Plant not found")
    return plant


def _is_washing_manager(db: Session, user: User) -> bool:
    """O&M team = O&M Head, or any active Assignee (several Assignees allowed).

    They may manage portfolio setup, compliance and ranking across plants. Daily report review is
    restricted separately to the configured Assignee for that plant or an O&M Head.
    Site Engineers are never managers: they only report the tables they cleaned on their own plant.

    Washing used to be gated on the "Modules cleaning" equipment type; with the asset
    register removed, any active Assignee is part of the O&M washing team and the
    per-plant checks below still apply.
    """
    if user.role == "O&M Head":
        return True
    return user.role == "Assignee" and bool(user.is_active)


def _can_review_washing(user: User, config: WashingConfig | None) -> bool:
    """Only the O&M Head or the configured, active washing assignee can approve this plant.

    Other Assignees retain portfolio visibility but cannot approve a report on a plant
    that was assigned to a different person.
    """
    return bool(user.is_active and (
        user.role == "O&M Head" or
        (user.role == "Assignee" and config is not None and config.assigned_user_id == user.id)
    ))


def _can_add_washing_evidence(user: User, report: WashingDailyReport, config: WashingConfig | None) -> bool:
    """Before/after photos may be added while a report is Pending by its submitter (Site Engineer) or by the
    O&M Head / this plant's configured washing Assignee, who also confirm the report."""
    if report.review_status == "Confirmed":
        # An O&M entry is confirmed the moment it is saved (no second review), so its author may still attach
        # the before/after photos for it. Reports confirmed by someone else stay frozen as reviewed.
        return bool(user.is_active and report.reported_by_id == user.id and report.reviewed_by_id == user.id)
    if report.review_status != "Pending":
        return False
    return report.reported_by_id == user.id or _can_review_washing(user, config)


def _can_access_plant(db: Session, user: User, plant_id: UUID, config: WashingConfig | None) -> bool:
    if _is_washing_manager(db, user):
        return True
    if user.role == "Site Engineer":
        return plant_id in (user_scoped_plant_ids(db, user) or set())
    return False


def _require_plant_access(db: Session, user: User, plant: Plant, config: WashingConfig | None) -> None:
    if not _can_access_plant(db, user, plant.id, config):
        raise HTTPException(403, "Washing is outside your assigned plant scope")


def _wash_recipients(db: Session, config: WashingConfig, extra_user_ids: list[UUID] | None = None, managers_only: bool = False) -> list[User]:
    """Every O&M manager (O&M Head + all washing Assignees) is notified. With managers_only the submitter / extra users
    are left out, which is used for performance alerts that Site Engineers must never receive."""
    users = users_with_role(db, {"O&M Head"})
    for assignee in users_with_role(db, {"Assignee"}):
        if assignee.is_active:
            users.append(assignee)
    if managers_only:
        return users
    for user_id in extra_user_ids or []:
        user = db.get(User, user_id)
        if user and user.is_active:
            users.append(user)
    return users


def _notify_wash(
    db: Session,
    plant: Plant,
    config: WashingConfig,
    *,
    event_type: str,
    title: str,
    message: str,
    dedupe_key: str,
    extra_user_ids: list[UUID] | None = None,
    managers_only: bool = False,
) -> None:
    notify_users(
        db,
        _wash_recipients(db, config, extra_user_ids, managers_only),
        event_type=event_type,
        title=title,
        message=f"{plant.site_code} · {plant.plant_name} · {message}",
        target_type="washing",
        target_id=str(plant.id),
        dedupe_key=dedupe_key,
    )


def _is_backfilled(report: WashingDailyReport) -> bool:
    """A day entered PHOTO_REQUIRED_DAYS or more after it happened (a back-filled sheet row). Before/after photos
    are rarely available for those, so confirming one does not require them; the reviewer sees it flagged."""
    created = report.created_at or datetime.now(timezone.utc)
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return (created.astimezone(BUSINESS_TZ).date() - report.report_date).days >= PHOTO_REQUIRED_DAYS


def _photos_required(report: WashingDailyReport, total_tables: int) -> bool:
    # Extra cleaning is never required work, and blocking its confirmation on before/after photos
    # would leave it Pending and uncounted -- which is the very thing that stopped it being recorded
    # at all. The photo slots stay open on it, so evidence can still be attached.
    if getattr(report, "is_extra", False):
        return False
    return report.job_status == "Done" and report.tables_cleaned < total_tables and not _is_backfilled(report)


def _missing_photo_kinds(report: WashingDailyReport, total_tables: int) -> list[str]:
    """Photo kinds still needed before this report can be confirmed (empty when none are required)."""
    if not _photos_required(report, total_tables):
        return []
    kinds = {str(entry.get("kind", "")).lower() for entry in (report.evidence or []) if isinstance(entry, dict)}
    return [kind for kind in ("before", "after") if kind not in kinds]


def _report_out(report: WashingDailyReport, plant: Plant, viewer: User, config: WashingConfig, manager: bool = False, total_tables: int | None = None) -> dict:
    can_review = report.review_status == "Pending" and report.reported_by_id != viewer.id and _can_review_washing(viewer, config)
    table_total = total_tables if total_tables is not None else int(config.tables_per_cycle or 0)
    backfilled = _is_backfilled(report)
    return {
        "id": str(report.id),
        "plant_id": str(plant.id),
        "plant": plant.plant_name,
        "site_code": plant.site_code,
        "cycle_month": report.cycle_month,
        "cycle_no": report.cycle_no,
        "report_date": report.report_date.isoformat(),
        "job_status": report.job_status,
        "tables_cleaned": report.tables_cleaned,
        "cleaned_table_codes": report.cleaned_table_codes or [],
        # Extra cleaning is tagged to the cycle it happened during (cycle_no above) but is not
        # part of that cycle's progress, so the register and calendar can say "Extra — during
        # Cycle 1" without the reader mistaking it for cycle work.
        "is_extra": bool(report.is_extra),
        "remarks": report.remarks,
        "exception_reason": report.exception_reason,
        "evidence": [
            {**{key: value for key, value in entry.items() if key != "storage_path"},
             "url": f"/api/scheduled/washing/daily-reports/{report.id}/evidence/{entry.get('id')}?size=thumb",
             "original_url": f"/api/scheduled/washing/daily-reports/{report.id}/evidence/{entry.get('id')}?size=original"}
            for entry in (report.evidence or [])
        ],
        "reported_by_id": str(report.reported_by_id) if report.reported_by_id else None,
        "reported_by": report.reported_by,
        "review_status": report.review_status,
        "reviewed_by": report.reviewed_by,
        "reviewed_at": report.reviewed_at.isoformat() if report.reviewed_at else None,
        "review_note": report.review_note,
        "cycle_completed": report.cycle_completed,
        "can_review": can_review,
        "can_add_evidence": _can_add_washing_evidence(viewer, report, config),
        "can_edit": manager or (
            not report.is_extra and report.reported_by_id == viewer.id
            and report.review_status in ("Pending", "Rejected")
        ),
        "can_delete": manager or (
            not report.is_extra and report.reported_by_id == viewer.id
            and report.review_status in ("Pending", "Rejected")
        ),
        "has_before": any(e.get("kind") == "before" for e in (report.evidence or []) if isinstance(e, dict)),
        "has_after": any(e.get("kind") == "after" for e in (report.evidence or []) if isinstance(e, dict)),
        "backfilled": backfilled,
        "photos_required": report.job_status == "Done" and not backfilled and (not table_total or report.tables_cleaned < table_total),
    }


def _set_table_count(db: Session, plant: Plant, table_count: int) -> int:
    tables = list(db.scalars(
        select(WashingTable).where(WashingTable.plant_id == plant.id).order_by(WashingTable.table_code)
    ))
    if len(tables) > table_count:
        has_reports = db.scalar(
            select(WashingDailyReport.id).where(WashingDailyReport.plant_id == plant.id).limit(1)
        )
        if has_reports:
            raise HTTPException(409, f"Cannot reduce the table count for {plant.plant_name} after daily washing reports have been recorded")
        excess = tables[table_count:]
        excess_ids = [table.id for table in excess]
        has_history = db.scalar(
            select(WashingHistory.id).where(WashingHistory.washing_table_id.in_(excess_ids)).limit(1)
        ) if excess_ids else None
        if has_history:
            raise HTTPException(409, f"Cannot reduce the table count for {plant.plant_name} while removed tables have washing history")
        for table in excess:
            db.delete(table)
        tables = tables[:table_count]

    existing_codes = {str(table.table_code or "").casefold() for table in tables}
    next_number = 1
    while len(tables) < table_count:
        code = f"Table {next_number:03d}"
        next_number += 1
        if code.casefold() in existing_codes:
            continue
        existing_codes.add(code.casefold())
        table = WashingTable(
            legacy_id="TBL-" + uuid.uuid4().hex[:10].upper(),
            plant_id=plant.id,
            table_code=code,
            legacy_payload={"plant": plant.plant_name, "tableId": code},
        )
        db.add(table)
        tables.append(table)
    return len(tables)


def _ensure_washing_assignee(db: Session, user: User, assignee: User, plant_id: UUID | None = None) -> None:
    """The washing assignee must be an active Assignee scoped to the plant.

    Washing scope used to be the "Modules cleaning" equipment type across every
    plant. It is now the plant assignment, so setting someone up for a plant's
    washing grants them that plant if they do not have it yet.
    """
    if not assignee.is_active or assignee.role != "Assignee":
        raise HTTPException(422, "Choose an active Assignee")
    if plant_id is None:
        return
    already = db.scalar(select(UserPlantAssignment.plant_id).where(
        UserPlantAssignment.user_id == assignee.id, UserPlantAssignment.plant_id == plant_id,
    ))
    if already is None:
        db.add(UserPlantAssignment(user_id=assignee.id, plant_id=plant_id, assignment_role="Assignee"))
        plant = db.get(Plant, plant_id)
        db.add(AuditLog(
            user_id=user.id,
            actor_name=user.display_name,
            action="Plant scope added while setting up plant washing",
            module="Washing",
            entity_type="user",
            entity_id=str(assignee.id),
            metadata_json={"plant": plant.site_code if plant else str(plant_id), "assignee": assignee.display_name},
        ))


def setup_plant(db: Session, user: User, payload: WashingSetupRequest) -> dict:
    if not _is_washing_manager(db, user):
        raise HTTPException(403, "Only the O&M team (O&M Head or a washing Assignee) can set up plant washing")
    plant = _plant_for_id(db, payload.plant_id)
    assignee = db.get(User, payload.assignee_user_id)
    if not assignee:
        raise HTTPException(422, "Choose an active Assignee")
    _ensure_washing_assignee(db, user, assignee, plant.id)

    config = db.scalar(select(WashingConfig).where(WashingConfig.plant_id == plant.id).with_for_update())
    if not config:
        config = WashingConfig(plant_id=plant.id, team=[], frequency_days=14)
    config.assigned_user_id = assignee.id
    config.compliance_threshold_percent = payload.compliance_threshold_percent
    config.fast_window_days = payload.fast_window_days
    db.add(config)
    config.tables_per_cycle = payload.table_count
    table_count = payload.table_count

    db.add(AuditLog(
        user_id=user.id,
        actor_name=user.display_name,
        action="Configured washing cycles",
        module="Washing",
        entity_type="plant",
        entity_id=plant.site_code,
        metadata_json={"table_count": payload.table_count, "assignee": assignee.display_name},
    ))
    db.commit()
    return {
        "plant_id": str(plant.id),
        "plant": plant.plant_name,
        "site_code": plant.site_code,
        "table_count": table_count,
        "assignee_user_id": str(assignee.id),
        "assignee_name": assignee.display_name,
        "compliance_threshold_percent": config.compliance_threshold_percent,
        "fast_window_days": config.fast_window_days,
    }


def list_assignees(db: Session, user: User) -> list[dict]:
    """Every active user with the Assignee role (from the database), with whether they already hold the washing scope."""
    if not _is_washing_manager(db, user):
        raise HTTPException(403, "Only the O&M team can assign plant washing")
    users = db.execute(
        select(User.id, User.display_name).where(User.role == "Assignee", User.is_active.is_(True)).order_by(User.display_name)
    ).all()
    scoped = set(db.scalars(select(UserPlantAssignment.user_id)))
    return [{"id": str(user_id), "name": name, "has_washing_scope": user_id in scoped} for user_id, name in users]


def _overview_as_of(month: str | None) -> date | None:
    """`month` (YYYY-MM) chosen on the Washing page: an earlier month is shown as it stood on its last day; the current
    month (or none) is shown as of today. Later months have nothing to show yet."""
    if not month:
        return None
    first = _parse_month(month)
    current = business_today().replace(day=1)
    if first > current:
        raise HTTPException(422, "Washing can be shown up to the current month")
    return None if first == current else first.replace(day=monthrange(first.year, first.month)[1])


def get_overview(db: Session, user: User, include_tables: bool = False, report_days: int = OVERVIEW_SEND_REPORT_DAYS,
                 month: str | None = None, include_reports: bool = True, plant_ids: set[UUID] | None = None,
                 summary: bool = False) -> dict:
    """Washing overview for the caller's scope.

    ``include_reports=False`` leaves out the ``reports`` list (and reads reports as light rows, see
    _SUMMARY_REPORT_COLUMNS); every plant figure is unchanged. ``plant_ids`` computes only those plants (still within
    the caller's scope); portfolio totals then cover just those plants.

    ``summary=True`` leaves out the per-plant lists — the day-by-day status, the cycle rows and the productivity
    breakdown — which together are about three quarters of the response and are read only by the plant calendar.
    Every figure a caller still receives is computed exactly as before, from the same ledger. The Overview tiles and
    the Module Cleaning board use it because they read scalars only.
    """
    report_days = max(1, min(int(report_days), OVERVIEW_REPORT_DAYS))
    as_of = _overview_as_of(month)
    ttl = 0 if get_settings().app_env == "test" else OVERVIEW_CACHE_SECONDS
    if ttl <= 0:
        return _build_overview(db, user, include_tables, report_days, as_of, include_reports, plant_ids, summary)
    key = (str(user.id), user.role, include_tables, report_days, business_today().isoformat(), as_of,
           include_reports, tuple(sorted(str(p) for p in plant_ids)) if plant_ids is not None else None, summary)
    hit = _OVERVIEW_CACHE.get(key)
    if hit and datetime.now(timezone.utc).timestamp() - hit[0] < ttl:
        return hit[1]
    version = _OVERVIEW_VERSION
    result = _build_overview(db, user, include_tables, report_days, as_of, include_reports, plant_ids, summary)
    if version == _OVERVIEW_VERSION:  # no write happened while this was being built
        if len(_OVERVIEW_CACHE) > 50:
            _OVERVIEW_CACHE.clear()
        _OVERVIEW_CACHE[key] = (datetime.now(timezone.utc).timestamp(), result)
    return result


def _build_overview(db: Session, user: User, include_tables: bool = False, report_days: int = OVERVIEW_SEND_REPORT_DAYS,
                    as_of: date | None = None, include_reports: bool = True, plant_ids: set[UUID] | None = None,
                    summary: bool = False) -> dict:
    """Washing overview as of today, or as of `as_of` (the last day of an earlier month chosen on the page): reports
    after that day are left out, so cycles, compliance, deadlines and the day-by-day status read as they stood then."""
    manager = _is_washing_manager(db, user)
    allowed_plant_ids = user_scoped_plant_ids(db, user) or set() if user.role == "Site Engineer" else set()

    configured_plants = select(WashingConfig.plant_id)
    table_count_columns = [
        WashingTable.plant_id.label("plant_id"),
        func.count(WashingTable.id).label("table_count"),
    ]
    if summary:
        recorded_code = func.coalesce(WashingTable.table_code, WashingTable.legacy_id)
        code_aggregate = (
            func.json_group_array(recorded_code)
            if db.get_bind().dialect.name == "sqlite"
            else func.array_agg(recorded_code)
        )
        table_count_columns.append(code_aggregate.label("table_codes"))
    table_counts_query = select(*table_count_columns).where(WashingTable.plant_id.in_(configured_plants))
    latest_reports_query = (
        select(
            WashingDailyReport.plant_id.label("plant_id"),
            func.max(WashingDailyReport.report_date).label("last_report_date"),
        )
        .where(WashingDailyReport.plant_id.in_(configured_plants))
    )
    if as_of is not None:
        latest_reports_query = latest_reports_query.where(WashingDailyReport.report_date <= as_of)
    if user.role == "Site Engineer":
        table_counts_query = table_counts_query.where(WashingTable.plant_id.in_(allowed_plant_ids))
        latest_reports_query = latest_reports_query.where(WashingDailyReport.plant_id.in_(allowed_plant_ids))
    if plant_ids is not None:
        table_counts_query = table_counts_query.where(WashingTable.plant_id.in_(plant_ids))
    table_counts_subquery = table_counts_query.group_by(WashingTable.plant_id).subquery()
    latest_reports_subquery = latest_reports_query.group_by(WashingDailyReport.plant_id).subquery()

    plant_columns = [
        Plant,
        WashingConfig,
        User.display_name,
        func.coalesce(WashingConfig.tables_per_cycle, table_counts_subquery.c.table_count, 0),
        latest_reports_subquery.c.last_report_date,
    ]
    if summary:
        plant_columns.append(table_counts_subquery.c.table_codes)
    plant_stmt = (
        select(*plant_columns)
        .outerjoin(WashingConfig, WashingConfig.plant_id == Plant.id)
        .outerjoin(User, User.id == WashingConfig.assigned_user_id)
        .outerjoin(table_counts_subquery, table_counts_subquery.c.plant_id == Plant.id)
        .outerjoin(latest_reports_subquery, latest_reports_subquery.c.plant_id == Plant.id)
    )
    if user.role == "Site Engineer":
        plant_stmt = plant_stmt.where(Plant.id.in_(allowed_plant_ids)).order_by(Plant.plant_name)
    elif manager:
        plant_stmt = plant_stmt.order_by(Plant.plant_name)
    plant_config_rows = db.execute(plant_stmt).all() if manager or user.role == "Site Engineer" else []

    visible_configs = []
    table_counts: dict[UUID, int] = {}
    last_report_by_plant: dict[UUID, date] = {}
    assignee_names: dict[UUID, str] = {}
    pool: list[Plant] = []
    table_ranges: dict[UUID, str | None] = {}
    for row in plant_config_rows:
        plant, config, assignee_name, table_count, last_report = row[:5]
        pool.append(plant)
        if config is None or not (manager or (user.role == "Site Engineer" and plant.id in allowed_plant_ids)):
            continue
        if plant_ids is not None and plant.id not in plant_ids:
            continue
        visible_configs.append((plant, config))
        table_counts[plant.id] = int(table_count or 0)
        if summary:
            registered_codes = row[5]
            if isinstance(registered_codes, str):
                registered_codes = json.loads(registered_codes)
            table_range = format_table_codes(registered_codes or [])
            table_ranges[plant.id] = table_range or None
        if last_report:
            last_report_by_plant[plant.id] = last_report
        if config.assigned_user_id and assignee_name:
            assignee_names[config.assigned_user_id] = assignee_name

    visible_ids = [plant.id for plant, _config in visible_configs]
    light = not include_reports and not include_tables
    codes_by_plant: dict[UUID, list[str]] = {}
    reports_by_plant: dict[UUID, list[WashingDailyReport]] = {}
    if visible_ids:
        if include_tables:
            for plant_id, code, legacy_id in db.execute(
                select(WashingTable.plant_id, WashingTable.table_code, WashingTable.legacy_id)
                .where(WashingTable.plant_id.in_(visible_ids))
                .order_by(WashingTable.plant_id, WashingTable.table_code)
            ).all():
                codes_by_plant.setdefault(plant_id, []).append(code or legacy_id)
        report_cutoff = (as_of or business_today()) - timedelta(days=OVERVIEW_REPORT_DAYS)
        report_stmt = (select(*_SUMMARY_REPORT_COLUMNS) if light else select(WashingDailyReport)).where(
            WashingDailyReport.plant_id.in_(visible_ids),
            or_(WashingDailyReport.report_date >= report_cutoff, WashingDailyReport.review_status == "Pending"),
        )
        if as_of is not None:
            report_stmt = report_stmt.where(WashingDailyReport.report_date >= report_cutoff, WashingDailyReport.report_date <= as_of)
        if light:
            # Every per-plant figure reads only this month's reports (cycles, ledger, daily status, delays,
            # exceptions), the last 7 days (productivity), the days from each cycle's start (excused days; a saved
            # start date can fall in the previous month) and reports awaiting review. Read just those instead of
            # the whole 90-day window; the figures are identical (tests/test_performance_paths.py).
            as_of_day = as_of or business_today()
            earliest = min([as_of_day.replace(day=1), as_of_day - timedelta(days=7)] +
                           [min(_cycle_start_dates(as_of_day, config.cycle_overrides)) for _plant, config in visible_configs])
            report_stmt = report_stmt.where(or_(
                WashingDailyReport.report_date >= earliest,
                WashingDailyReport.cycle_month == _month_key(as_of_day),
                WashingDailyReport.review_status == "Pending",
            ))
        ordered = report_stmt.order_by(WashingDailyReport.plant_id, WashingDailyReport.report_date.desc(),
                                       WashingDailyReport.created_at.desc())
        for report in (db.execute(ordered) if light else db.scalars(ordered)):
            reports_by_plant.setdefault(report.plant_id, []).append(report)
    visible: list[tuple[Plant, WashingConfig, int, list[WashingDailyReport]]] = []
    for plant, config in visible_configs:
        table_count = table_counts.get(plant.id, 0)
        if table_count:
            visible.append((plant, config, table_count, reports_by_plant.get(plant.id, [])))

    today = as_of or business_today()
    month = _month_key(today)
    start_month = today.replace(day=1)
    first_chart_month = start_month.replace(day=1)
    for _ in range(11):
        first_chart_month = (first_chart_month.replace(day=1) - timedelta(days=1)).replace(day=1)
    month_keys = []
    cursor = first_chart_month
    for _ in range(12):
        month_keys.append(_month_key(cursor))
        cursor = (cursor.replace(day=monthrange(cursor.year, cursor.month)[1]) + timedelta(days=1)).replace(day=1)

    send_cutoff = today - timedelta(days=report_days)
    plant_rows = []
    reports_out = []
    pending_reviews = 0
    monthly_out = []
    cycle_events_all: list[dict] = []
    patterns = _reason_patterns(excused_reasons(db))
    for plant, config, table_count, reports in visible:
        completed_by_month: dict[str, set[int]] = {}
        for report in reports:
            if report.cycle_completed and report.review_status == "Confirmed":
                completed_by_month.setdefault(report.cycle_month, set()).add(report.cycle_no)
        cycles_this_month = len(completed_by_month.get(month, set()))
        month_reports = [r for r in reports if r.cycle_month == month]
        cleaned_reports = [
            report for report in month_reports
            if report.tables_cleaned > 0 and report.review_status in ("Pending", "Confirmed")
        ]
        cleaning_dates = sorted({report.report_date.isoformat() for report in cleaned_reports})
        cleaned_cycles = sorted({report.cycle_no for report in cleaned_reports})
        cycle_table_data = []
        if summary:
            cycle_table_data_map: dict[int, dict] = {}
            for report in sorted(month_reports, key=lambda item: (item.report_date, str(item.created_at or ""))):
                if report.review_status not in ("Pending", "Confirmed"):
                    continue
                cycle_no = int(report.cycle_no or 1)
                entry = cycle_table_data_map.setdefault(cycle_no, {
                    "cycle_no": cycle_no, "tables_cleaned": 0,
                    "job_status": "Not done", "ranges": [],
                })
                if report.job_status == "Done" and report.tables_cleaned:
                    entry["tables_cleaned"] += int(report.tables_cleaned)
                    entry["job_status"] = "Done"
                    table_range = format_table_codes(report.cleaned_table_codes or [], preserve_order=True)
                    if table_range:
                        entry["ranges"].append(table_range)
            for entry in sorted(cycle_table_data_map.values(), key=lambda item: item["cycle_no"]):
                entry["table_range"] = " · ".join(entry.pop("ranges")) or None
                cycle_table_data.append(entry)
        closed_cycles = _closed_incomplete(month_reports, table_count)
        highest_report_cycle = max(
            (report.cycle_no for report in month_reports if report.review_status in ("Pending", "Confirmed")),
            default=0,
        )
        highest_completed_cycle = max(completed_by_month.get(month, set()), default=0)
        current_cycle = min(MONTHLY_CYCLE_TARGET, max(
            1, highest_report_cycle, highest_completed_cycle + 1,
            max(closed_cycles, default=0) + 1,
        ))
        ledger = _cycle_ledger(month_reports, table_count)   # with carried-over tables
        cleaned_confirmed = ledger[current_cycle]["confirmed"]
        cleaned_pending = ledger[current_cycle]["pending"]
        table_codes: list[str] = []
        table_health: list[dict] = []
        if include_tables:  # nothing in the portal reads these two lists; opt in with ?include_tables=true
            table_codes = codes_by_plant.get(plant.id, [])
            last_wash: dict[str, date] = {}
            for report in reports:
                if report.review_status != "Confirmed":
                    continue
                for table_code in report.cleaned_table_codes or []:
                    if table_code not in last_wash:
                        last_wash[table_code] = report.report_date
            for table_code in table_codes:
                last = last_wash.get(table_code)
                days_since = (today - last).days if last else None
                table_health.append({
                    "table_code": table_code,
                    "last_washed": last.isoformat() if last else None,
                    "days_since_last_wash": days_since,
                    "indicator": "green" if days_since is not None and days_since < 10 else
                        "amber" if days_since is not None and days_since <= 15 else "red",
                })
        today_cleaned = sum(
            report.tables_cleaned for report in reports
            if report.report_date == today and report.review_status == "Confirmed"
        )
        excused_dates = _excused_dates(reports, patterns)
        productivity: dict[str, int] = {}
        daily_productivity: list[dict] = []
        week_start = today - timedelta(days=6)
        for report in (() if summary else reports):
            if report.review_status == "Confirmed" and report.tables_cleaned and report.report_date >= week_start:
                productivity[report.reported_by] = productivity.get(report.reported_by, 0) + report.tables_cleaned
                daily_productivity.append({
                    "date": report.report_date.isoformat(),
                    "person": report.reported_by,
                    "tables": report.tables_cleaned,
                })
        completed_dates: dict[int, date] = {}
        for report in sorted(reports, key=lambda item: item.report_date):
            if report.cycle_month == month and report.cycle_completed and report.review_status == "Confirmed":
                completed_dates.setdefault(report.cycle_no, report.report_date)
        start_dates = _cycle_start_dates(today, config.cycle_overrides)
        due_by_today = sum(1 for start in start_dates if start <= today)
        completed_due = sum(
            1 for cycle_no in completed_dates if start_dates[cycle_no - 1] <= today
        )
        due_dates = _cycle_due_dates(today, config.cycle_overrides)
        # Monthly compliance is measured against the whole month's plan, not against the cycles
        # due so far. A shifting denominator made the same finished work score differently as the
        # month went on (150% on the 17th, 133% on the 21st, with nothing changed).
        planned_cycles = MONTHLY_CYCLE_TARGET if table_count > 0 else 0
        # Every cycle completed this month counts, including one finished ahead of its window.
        completed_cycles_month = len(completed_dates)
        overdue_cycles = sum(
            1 for cycle_no, due_date in enumerate(due_dates, 1)
            if table_count > 0 and start_dates[cycle_no - 1] <= today and due_date < today
            and cycle_no not in completed_dates
        )
        # Washing done after all three cycles were complete (recorded on cycle 3) counts towards
        # the month as the fraction of a whole extra wash it represents.
        extra_tables = (
            max(0, ledger[MONTHLY_CYCLE_TARGET]["confirmed"] - table_count)
            if len(completed_dates) >= MONTHLY_CYCLE_TARGET and table_count else 0
        )
        # Mid-cycle re-cleaning is a calendar record only. Only extra cleaning after all three
        # cycles are confirmed contributes to compliance.
        post_cycle_three_extras = _post_cycle_three_extra_ids(month_reports)
        extra_tables += sum(
            report.tables_cleaned for report in reports
            if report.cycle_month == month and report.review_status == "Confirmed"
            and id(report) in post_cycle_three_extras
        )
        extra_cycles = extra_tables / table_count if table_count else 0
        # The counts stay whole activities: 2 of 3 cycles done reads as 2, not 2.4.
        activities = cleaning_activity_metrics(completed_cycles_month + extra_cycles, planned_cycles,
                                               overdue_cycles, allow_extra=True)
        # Monthly compliance is the WORK done this month: confirmed tables cleaned on this month's
        # dates (whichever month a catch-up day is tagged to) against the tables due so far -- each
        # started cycle's due, the open one on pace up to today. Only extra cleaning after all
        # three cycles are confirmed raises the plant's score (_cycle_work_scores).
        work = _cycle_work_scores(reports, table_count, today, config.cycle_overrides, excused_dates)
        month_confirmed_tables = work["month"]["tables_done"]
        monthly_tables_due = work["month"]["tables_due"]
        # Cycles achieved, counting the one in hand by how much of it is cleaned: a plant halfway
        # through cycle 1 has achieved 0.5 of the month's 3, not 0. Without this a plant cleaning
        # every day reads 0% until the moment a cycle closes, which hides all the work in flight.
        cycle_progress = round(month_confirmed_tables / table_count, 3) if table_count else 0
        monthly_compliance = cleaning_activity_metrics(
            cycle_progress, planned_cycles, overdue_cycles, allow_extra=True,
        )["compliance_percent"]
        today_target = _daily_table_target(table_count, today, config.cycle_overrides)
        compliance = _cycle_compliance(table_count, today, config.cycle_overrides, ledger, excused_dates)
        cycle_grades = []
        for cycle_no in range(1, MONTHLY_CYCLE_TARGET + 1):
            cycle_work = work["cycles"][cycle_no]
            cycle_reports = [report for report in month_reports if report.cycle_no == cycle_no and
                             report.review_status in ("Pending", "Confirmed")]
            actual_start = min((report.report_date for report in cycle_reports if report.tables_cleaned), default=None)
            if actual_start is None and cycle_no > 1:
                previous_done = completed_dates.get(cycle_no - 1)
                actual_start = previous_done + timedelta(days=1) if previous_done else None
            start_date = actual_start or (start_dates[cycle_no - 1] if cycle_work["started"] else None)
            grade = _cycle_grade(
                cycle_no, month_reports, table_count, config.compliance_threshold_percent,
                config.fast_window_days, start_date or start_dates[cycle_no - 1], due_dates[cycle_no - 1], today,
            )
            # Cycle scores follow completed-table progression; the monthly score remains date-based.
            if not cycle_work["started"]:
                grade.update({"grade": "upcoming", "start_date": None, "days_to_target": None, "due": False})
            elif grade["grade"] == "upcoming":
                grade.update({"grade": "running", "start_date": start_date.isoformat() if start_date else None})
            grade.update({
                "compliance_percent": cycle_work["score"],
                "tables_done": cycle_work["tables_done"],
                "tables_due": cycle_work["tables_due"],
            })
            cycle_grades.append(grade)
        delays = [
            max(0, (completed_on - due_dates[min(cycle_no - 1, 2)]).days)
            for cycle_no, completed_on in completed_dates.items()
        ]
        overdue = _overdue_info(cycles_this_month, today, due_dates)
        if not config.active:
            overdue.update({"overdue_days": 0, "overdue_bucket": "on_track", "overdue_cycle": None})
        # A late cycle's delay is "excused" when its excused days (rain, water shortage, ...: see excused_reasons)
        # are at least as many as the days it is late. The window runs from the cycle's start (or the day after the
        # previous cycle was completed, if later) to today.
        late_cycle = overdue.get("overdue_cycle")
        excused_in_late_cycle = 0
        if late_cycle:
            window_start = start_dates[late_cycle - 1]
            previous_done = completed_dates.get(late_cycle - 1)
            if previous_done and previous_done >= window_start:
                window_start = previous_done + timedelta(days=1)
            excused_in_late_cycle = sum(1 for day in excused_dates if window_start <= day <= today)
        day_reports: dict[date, list[WashingDailyReport]] = {}
        for report in reports:
            if report.report_date.year == today.year and report.report_date.month == today.month:
                day_reports.setdefault(report.report_date, []).append(report)
        daily_status = []
        for offset in (() if summary else range(today.day)):
            day = today.replace(day=1) + timedelta(days=offset)
            day_rows = day_reports.get(day, [])
            confirmed_n = sum(r.tables_cleaned for r in day_rows if r.review_status == "Confirmed")
            pending_n = sum(r.tables_cleaned for r in day_rows if r.review_status == "Pending")
            exception = next((r.exception_reason for r in day_rows if r.exception_reason and r.review_status != "Rejected"), None)
            if any(r.review_status == "Pending" for r in day_rows):
                day_status = "Awaiting review"
            elif confirmed_n:
                day_status = "Confirmed"
            elif exception:
                day_status = "Exception"
            elif day_rows:
                day_status = "Rejected"
            elif day < today:
                day_status = "No report"
            else:
                day_status = "Not reported yet"
            daily_status.append({
                "date": day.isoformat(),
                "target": _daily_table_target(table_count, day, config.cycle_overrides),
                "confirmed": confirmed_n,
                "pending": pending_n,
                "status": day_status,
                "exception": exception,
                "reported_by": ", ".join(sorted({r.reported_by for r in day_rows if r.reported_by})),
                "report_ids": [str(r.id) for r in day_rows],
            })
        cycle_rows = []
        for cycle_no in (() if summary else range(1, MONTHLY_CYCLE_TARGET + 1)):
            cycle_reports = [r for r in reports if r.cycle_month == month and r.cycle_no == cycle_no and r.review_status in ("Pending", "Confirmed")]
            done_on = completed_dates.get(cycle_no)
            started_on = min((r.report_date for r in cycle_reports if r.tables_cleaned), default=None) or min((r.report_date for r in cycle_reports), default=None)
            state = ("Completed" if done_on else "Missed" if cycle_no in closed_cycles else
                     ("In progress" if cycle_no == current_cycle and cycles_this_month < MONTHLY_CYCLE_TARGET else "Upcoming"))
            due = due_dates[cycle_no - 1]
            planned_start = start_dates[cycle_no - 1]
            cycle_rows.append({
                "cycle_no": cycle_no,
                "start_date": planned_start.isoformat(),
                "default_start_date": _default_start_dates(today)[cycle_no - 1].isoformat(),
                "start_overridden": planned_start != _default_start_dates(today)[cycle_no - 1],
                "state": state,
                "due_date": due.isoformat(),
                "default_due_date": _default_due_dates(today)[cycle_no - 1].isoformat(),
                "due_overridden": due != _default_due_dates(today)[cycle_no - 1],
                "started_on": started_on.isoformat() if started_on else None,
                "completed_on": done_on.isoformat() if done_on else None,
                "confirmed": ledger[cycle_no]["confirmed"],
                "pending": ledger[cycle_no]["pending"],
                "carried_in": ledger[cycle_no]["carried_in"],
                "late_days": max(0, (done_on - due).days) if done_on else (max(0, (today - due).days) if state != "Upcoming" else 0),
            })
        for report in (reports if not light else ()):   # cycle events need the whole window; summary leaves them out
            if report.cycle_completed and report.review_status == "Confirmed":
                cycle_events_all.append({
                    "plant_id": str(plant.id), "plant": plant.plant_name, "site_code": plant.site_code,
                    "cycle_month": report.cycle_month, "cycle_no": report.cycle_no,
                    "completed_on": report.report_date.isoformat(),
                    "next_cycle": report.cycle_no + 1 if report.cycle_no < MONTHLY_CYCLE_TARGET else None,
                })
        plant_rows.append({
            **overdue,
            **({} if summary else {"cycles": cycle_rows, "daily_status": daily_status}),
            "last_report_date": last_report_by_plant[plant.id].isoformat() if last_report_by_plant.get(plant.id) else None,
            "plant_id": str(plant.id),
            "plant": plant.plant_name,
            "site_code": plant.site_code,
            "table_count": table_count,
            **({"table_range": table_ranges.get(plant.id)} if summary else {}),
            "active": config.active,
            "notes": config.notes,
            "district": plant.district,
            "location": plant.location,
            "assignee_user_id": str(config.assigned_user_id) if config.assigned_user_id else None,
            "assignee_name": assignee_names.get(config.assigned_user_id),
            "cycles_this_month": cycles_this_month,
            "cleaning_dates": cleaning_dates,
            "cleaned_cycles": cleaned_cycles,
            "monthly_target": MONTHLY_CYCLE_TARGET,
            "current_cycle": current_cycle,
            "confirmed_tables_cleaned": cleaned_confirmed,
            "pending_tables_cleaned": cleaned_pending,
            "cycle_remaining": max(0, table_count - cleaned_confirmed - cleaned_pending),
            "today_report": next((r.job_status for r in reports if r.report_date == today), None),
            "tables_due_today": today_target,
            "tables_washed_today": today_cleaned,
            "tables_pending_today": 0 if today in excused_dates else max(0, today_target - today_cleaned),
            "today_excused": today in excused_dates,
            "daily_compliance_percent": 100 if today in excused_dates else (
                min(100, round(100 * today_cleaned / today_target)) if today_target else 100
            ),
            "monthly_compliance_percent": monthly_compliance,
            "monthly_activities_planned": activities["planned"],
            "monthly_cycle_progress": cycle_progress,
            "monthly_activities_completed": activities["completed"],
            "monthly_activities_pending": activities["pending"],
            "monthly_activities_overdue": activities["overdue"],
            "monthly_tables_confirmed": month_confirmed_tables,
            "monthly_tables_due": monthly_tables_due,
            "monthly_cycles_due": due_by_today,
            "monthly_cycles_completed_due": completed_due,
            "cycle_compliance": compliance,
            "cycle_compliance_percent": compliance["percent"],
            "cycle_grades": cycle_grades,
            "cycle_grade_summary": _cycle_grade_summary(cycle_grades),
            **({"cycle_table_data": cycle_table_data} if summary else {}),
            "average_delay_days": round(sum(delays) / len(delays), 1) if delays else 0,
            "exceptions_this_month": sum(1 for report in reports if report.cycle_month == month and report.exception_reason),
            **({} if summary else {
                "productivity": [{"person": person, "tables": count} for person, count in sorted(productivity.items())],
                "daily_productivity": sorted(daily_productivity, key=lambda row: (row["date"], row["person"])),
            }),
            "compliance_threshold_percent": config.compliance_threshold_percent,
            "fast_window_days": config.fast_window_days,
            "excused_days_late_cycle": excused_in_late_cycle,
            "delay_excused": bool(late_cycle) and excused_in_late_cycle >= overdue["overdue_days"],
        })
        if include_tables:
            plant_rows[-1]["table_codes"] = table_codes
            plant_rows[-1]["table_health"] = table_health
        # Every report still feeds the figures above; only recent ones (and any awaiting review) are sent to the browser.
        for report in reports:
            if report.report_date >= send_cutoff or report.review_status == "Pending":
                if report.review_status == "Pending":
                    pending_reviews += 1
                if include_reports:
                    reports_out.append(_report_out(report, plant, user, config, manager, table_count))

    completed_rows = db.execute(
        select(
            WashingDailyReport.plant_id,
            WashingDailyReport.cycle_month,
            func.count(func.distinct(WashingDailyReport.cycle_no)),
        )
        .where(
            WashingDailyReport.plant_id.in_([plant.id for plant, _config, _tables, _reports in visible]),
            WashingDailyReport.cycle_month.in_(month_keys),
            WashingDailyReport.cycle_completed.is_(True),
            WashingDailyReport.review_status == "Confirmed",
        )
        .group_by(WashingDailyReport.plant_id, WashingDailyReport.cycle_month)
    ).all() if visible and not light else []   # the 12-month chart is not part of the summary: one round trip less
    completed_lookup = {(plant_id, month): count for plant_id, month, count in completed_rows}
    for plant, _config, _tables, _reports in (visible if not light else ()):
        for key in month_keys:
            monthly_out.append({
                "plant_id": str(plant.id),
                "plant": plant.plant_name,
                "month": key,
                "cycles": completed_lookup.get((plant.id, key), 0),
            })
    result = {
        "today": today.isoformat(),
        "actual_today": business_today().isoformat(),
        "month": month,
        "past_month": as_of is not None,
        "viewer_user_id": str(user.id),
        "monthly_target": MONTHLY_CYCLE_TARGET,
        "plants": plant_rows,
        "reports": reports_out,
        "reports_included": include_reports,
        "monthly": monthly_out,
        "portfolio": {
            "tables_due_today": sum(row["tables_due_today"] for row in plant_rows),
            "tables_washed_today": sum(row["tables_washed_today"] for row in plant_rows),
            "tables_pending_today": sum(row["tables_pending_today"] for row in plant_rows),
            "monthly_compliance_percent": cleaning_activity_metrics(
                # Each plant counts at most its own plan, so one plant's extra cleaning cannot
                # hide another's shortfall. A single plant in view keeps its surplus.
                sum(row["monthly_cycle_progress"] if len(plant_rows) == 1
                    else min(row["monthly_cycle_progress"], row["monthly_activities_planned"])
                    for row in plant_rows),
                sum(row["monthly_activities_planned"] for row in plant_rows),
                sum(row["monthly_activities_overdue"] for row in plant_rows),
                # Above 100% only when the portfolio in view IS a single plant.
                allow_extra=len(plant_rows) == 1,
            )["compliance_percent"],
            "monthly_activities_planned": sum(row["monthly_activities_planned"] for row in plant_rows),
            "monthly_activities_completed": sum(row["monthly_activities_completed"] for row in plant_rows),
            "monthly_activities_pending": sum(row["monthly_activities_pending"] for row in plant_rows),
            "monthly_activities_overdue": sum(row["monthly_activities_overdue"] for row in plant_rows),
            "cycle_compliance": _portfolio_compliance(plant_rows),
            "average_delay_days": round(
                sum(row["average_delay_days"] for row in plant_rows) / len(plant_rows), 1
            ) if plant_rows else 0,
        },
    }
    configured_ids = {plant.id for plant, _config, _tables, _reports in visible}
    matrix = {"on_track": 0, "1d": 0, "3d": 0, "7d": 0}
    for row in plant_rows:
        if row["active"]:
            matrix[row["overdue_bucket"]] += 1
    result["unconfigured"] = [
        {"plant_id": str(p.id), "plant": p.plant_name, "site_code": p.site_code}
        for p in pool if p.id not in configured_ids
    ]
    result["overdue_matrix"] = matrix
    result["cycle_events"] = sorted(cycle_events_all, key=lambda e: e["completed_on"], reverse=True)[:30]
    result["portfolio"].update({
        "cycles_completed_month": sum(row["cycles_this_month"] for row in plant_rows),
        "cycles_target_month": MONTHLY_CYCLE_TARGET * sum(1 for row in plant_rows if row["active"]),
        "plants_overdue": sum(matrix[key] for key in ("1d", "3d", "7d")),
        "plants_below_threshold": sum(1 for row in plant_rows if row["active"] and row["cycle_compliance_percent"] < row["compliance_threshold_percent"]),
        "not_set_up": len(result["unconfigured"]),
        "pending_reviews": pending_reviews,
    })
    if not manager:
        # Compliance / delay / ranking figures are O&M performance metrics; field users never receive them.
        hidden = ("cycle_compliance", "cycle_compliance_percent", "monthly_compliance_percent", "daily_compliance_percent",
                  "monthly_activities_planned", "monthly_activities_completed", "monthly_activities_pending",
                  "monthly_cycle_progress",
                  "monthly_activities_overdue",
                  "monthly_tables_confirmed", "monthly_tables_due", "monthly_cycles_due", "monthly_cycles_completed_due",
                  "average_delay_days",
                  "compliance_threshold_percent", "overdue_days", "overdue_bucket", "overdue_cycle", "productivity",
                  "daily_productivity", "exceptions_this_month", "tables_due_today", "tables_pending_today",
                  "excused_days_late_cycle", "delay_excused")
        for row in result["plants"]:
            for key in hidden:
                row.pop(key, None)
            for cycle in row.get("cycles", []):
                cycle.pop("late_days", None)
            # The cycle work scores are the same compliance metric per cycle, so they follow the rule above.
            for grade in row.get("cycle_grades", []):
                for key in ("compliance_percent", "tables_done", "tables_due"):
                    grade.pop(key, None)
            if isinstance(row.get("cycle_grade_summary"), dict):
                row["cycle_grade_summary"].pop("compliance_percent", None)
            for day in row.get("daily_status", []):
                day.pop("target", None)
        result["overdue_matrix"] = {"on_track": 0, "1d": 0, "3d": 0, "7d": 0}
        for key in ("cycle_compliance", "plants_overdue", "plants_below_threshold", "tables_due_today"):
            result["portfolio"].pop(key, None)
    return result


def _portfolio_compliance(plant_rows: list[dict]) -> dict:
    """All active plants' current cycles together: tables done / tables due by today. A plant ahead of its target
    counts only up to it, so it cannot hide another plant that is behind."""
    rows = [row["cycle_compliance"] for row in plant_rows if row.get("active", True)]
    due = sum(c["due"] for c in rows)
    done = sum(min(c["done"], c["due"]) for c in rows)
    cycles = {(c["cycle_no"], c["start"], c["end"]) for c in rows}
    one = next(iter(cycles)) if len(cycles) == 1 else None
    return {"done": done, "due": due, "percent": min(100, round(100 * done / due)) if due else 100,
            "cycle_no": one[0] if one else None, "start": one[1] if one else None, "end": one[2] if one else None,
            "plants": len(rows)}


def _plant_table_count(db: Session, plant_id: UUID, config: WashingConfig | None = None) -> int:
    """Tables a plant washes in one cycle. This is only the target the compliance ratio is measured against.
    Uses the plant's tables_per_cycle number; falls back to counting registered tables for older setups."""
    if config is None:
        config = db.get(WashingConfig, plant_id)
    if config is not None and config.tables_per_cycle:
        return int(config.tables_per_cycle)
    return db.scalar(select(func.count(WashingTable.id)).where(WashingTable.plant_id == plant_id)) or 0


def _month_wash_summary(reports, table_count: int) -> dict:
    """How much washing a plant did in one month, for records and the monthly sheet.

    `times_washed` counts confirmed unmarked cleaning (tables ÷ tables per cycle), including work
    after the third cycle. `extra_times` separately counts confirmed mid-cycle re-cleaning and that
    post-cycle surplus for recordkeeping; only the post-cycle surplus contributes to compliance."""
    active = [r for r in reports if r.review_status in ("Pending", "Confirmed")]
    confirmed = [r for r in active if r.review_status == "Confirmed"]
    # Entries marked extra stay separate in this activity summary; compliance uses only those
    # recorded after all three cycles are complete.
    marked_extra = [r for r in confirmed if getattr(r, "is_extra", False)]
    confirmed = [r for r in confirmed if not getattr(r, "is_extra", False)]
    completed_on = {r.cycle_no: r.report_date for r in sorted(confirmed, key=lambda r: r.report_date) if r.cycle_completed}
    cycles_completed = len(completed_on)
    confirmed_tables = sum(r.tables_cleaned for r in confirmed)
    last_cycle_tables = _cycle_ledger(confirmed, table_count)[MONTHLY_CYCLE_TARGET]["confirmed"]   # with tables carried in
    all_cycles_done = cycles_completed >= MONTHLY_CYCLE_TARGET
    extra_tables = max(0, last_cycle_tables - table_count) if all_cycles_done and table_count else 0
    extra_tables += sum(r.tables_cleaned for r in marked_extra)
    return {
        "tables_per_cycle": table_count,
        "cycles_completed": min(cycles_completed, MONTHLY_CYCLE_TARGET),
        "cycle_completed_on": {n: completed_on[n].isoformat() for n in sorted(completed_on)},
        "confirmed_tables": confirmed_tables,
        "pending_tables": sum(r.tables_cleaned for r in active if r.review_status == "Pending"),
        "times_washed": round(confirmed_tables / table_count, 1) if table_count else 0,
        "extra_tables": extra_tables,
        "extra_times": round(extra_tables / table_count, 1) if table_count else 0,
        "days_worked": len({r.report_date for r in active if r.job_status == "Done"}),
        "days_not_done": len({r.report_date for r in active if r.job_status != "Done"}),
    }


OM_ENTRY_NOTE = "Entered by O&M"


def _entered_by_om(report) -> bool:
    """A day the O&M Head or a washing Assignee entered themselves (in the sheet, as a single day or by upload): it is
    saved confirmed by its own author with the O&M note. A Site Engineer's day confirmed by O&M is not one."""
    return bool(
        report.review_status == "Confirmed" and report.reported_by_id is not None
        and report.reviewed_by_id == report.reported_by_id and report.review_note == OM_ENTRY_NOTE
    )


class _SeqEntry(NamedTuple):
    """One saved day as `_cycle_sequence` reads it.

    The extra flag is a NAMED field, never a positional slot: callers already pass a 4th
    positional element meaning "entered by O&M" (the CSV daily import does), which the sequence
    ignores. Reading the flag by name keeps every positional caller behaving exactly as before.
    """
    tables: int
    counts: bool
    numbers: frozenset = frozenset()
    is_extra: bool = False


def _sequence_entry(report) -> _SeqEntry:
    numbers = frozenset(n for n in (_code_number(code) for code in (report.cleaned_table_codes or [])) if n is not None)
    return _SeqEntry(report.tables_cleaned, report.review_status in ("Pending", "Confirmed"), numbers,
                     bool(getattr(report, "is_extra", False)))


def _cycle_sequence(entries, total_tables: int) -> list[tuple[int, bool]]:
    """Cycle of each day of one plant-month, in date order: (cycle_no, extra) per entry of `entries`, which are
    (tables_cleaned, counts) or (tables_cleaned, counts, table_numbers) in date order (counts = awaiting confirmation
    or confirmed; rejected days fill nothing).

    A cycle completes only after all configured tables have been cleaned. When table numbers are
    recorded, distinct tables count toward completion; count-only legacy reports use tables_cleaned.
    The day that completes a cycle belongs to it; count-only excess carries forward and later days go
    to the next cycle. Editing or back-filling reassigns later days by the same rule. After Cycle 3 is
    full, further days stay on Cycle 3 as extra washing (`extra`). A table cannot be counted twice in
    an incomplete cycle; `_assert_distinct_tables` rejects that report.

    An entry may also be MARKED extra (`is_extra`, migration 048) for re-cleaning done while a cycle
    is still running. That cannot be derived from counts, so it is stored. A marked entry is reported
    against the cycle that was running when it happened, but contributes nothing to cycle progress:
    it does not add to the accumulated count, consume table numbers, or complete a cycle. That keeps
    repeated tables legal (via `_assert_distinct_tables`, which skips `extra`) without letting rework
    stand in for required work."""
    out: list[tuple[int, bool]] = []
    cycle, counted, used = 1, 0, set()
    for entry in entries:
        tables, counts = entry[0], entry[1]
        numbers = entry[2] if len(entry) > 2 else ()
        # By name, never by position: a plain tuple's 4th slot means "entered by O&M" elsewhere.
        marked_extra = bool(getattr(entry, "is_extra", False))
        # After Cycle 3 is full, further work is extra too — that stays derived, as it always was.
        derived_extra = cycle == MONTHLY_CYCLE_TARGET and total_tables > 0 and counted >= total_tables
        out.append((cycle, marked_extra or derived_extra))
        if marked_extra:
            # Tagged to the running cycle, but it moves nothing.
            continue
        new_numbers = set(numbers) - used
        cleaned = (len(numbers) if derived_extra else len(new_numbers)) if numbers else (tables or 0)
        if counts:
            counted += cleaned
            used.update(numbers)
            if total_tables > 0 and counted >= total_tables and cycle < MONTHLY_CYCLE_TARGET:
                cycle, counted = cycle + 1, counted - total_tables
                used = set()
    return out


def _plan_legacy_rollover_splits(rows, total_tables: int) -> list[dict]:
    """Find unambiguous legacy reports that mixed cycle-completing tables with repeats.

    The repair is conservative: it only splits a fully numbered report when its new tables
    exactly finish the running cycle, all earlier counted work has table numbers, and no
    other report shares that date. A simulated post-split pass also rejects a split if it
    would create a duplicate in the destination cycle.
    """
    excluded: set[str] = set()
    while True:
        cycle, counted, used = 1, 0, set()
        can_identify_tables = True
        parts: list[dict] = []
        candidates: dict[str, dict] = {}

        def append_part(row, codes, *, is_extra=False, split_id=None):
            numbers = [_code_number(code) for code in codes]
            numbers = [number for number in numbers if number is not None]
            parts.append({
                "row": row,
                "codes": list(codes),
                "numbers": numbers,
                "counts": row.review_status in ("Pending", "Confirmed"),
                "is_extra": bool(is_extra),
                "split_id": split_id,
            })

        def advance(numbers, tables, counts, is_extra):
            nonlocal cycle, counted, used
            if is_extra:
                return
            derived_extra = cycle == MONTHLY_CYCLE_TARGET and total_tables > 0 and counted >= total_tables
            new_numbers = set(numbers) - used
            cleaned = (len(numbers) if derived_extra else len(new_numbers)) if numbers else (tables or 0)
            if counts:
                counted += cleaned
                used.update(numbers)
                if total_tables > 0 and counted >= total_tables and cycle < MONTHLY_CYCLE_TARGET:
                    cycle, counted, used = cycle + 1, counted - total_tables, set()

        for index, row in enumerate(rows):
            codes = list(row.cleaned_table_codes or [])
            raw_numbers = [_code_number(code) for code in codes]
            valid_codes = bool(codes) and all(
                number is not None and 1 <= number <= total_tables for number in raw_numbers
            ) and len(set(raw_numbers)) == len(raw_numbers)
            active = row.review_status in ("Pending", "Confirmed")
            derived_extra = cycle == MONTHLY_CYCLE_TARGET and total_tables > 0 and counted >= total_tables
            row_id = str(row.id)
            followers_same_day = any(
                later.report_date == row.report_date for later in rows[index + 1:]
            )
            repeated = [
                code for code, number in zip(codes, raw_numbers)
                if number is not None and number in used
            ]
            fresh = [
                code for code, number in zip(codes, raw_numbers)
                if number is not None and number not in used
            ]
            remaining = total_tables - counted
            eligible = (
                row_id not in excluded
                and active
                and not row.is_extra
                and not derived_extra
                and can_identify_tables
                and valid_codes
                and row.tables_cleaned == len(codes)
                and bool(repeated)
                and len(fresh) == remaining
                and not followers_same_day
            )
            if eligible:
                spill_extra = cycle == MONTHLY_CYCLE_TARGET
                append_part(row, fresh, split_id=row_id)
                advance([_code_number(code) for code in fresh], len(fresh), active, False)
                append_part(row, repeated, is_extra=spill_extra, split_id=row_id)
                advance([_code_number(code) for code in repeated], len(repeated), active, spill_extra)
                candidates[row_id] = {
                    "row": row,
                    "first_codes": fresh,
                    "next_codes": repeated,
                    "next_is_extra": spill_extra,
                }
                continue

            append_part(row, codes, is_extra=bool(row.is_extra), split_id=None)
            numbers = [number for number in raw_numbers if number is not None]
            advance(numbers, row.tables_cleaned, active, bool(row.is_extra))
            if active and row.tables_cleaned and not valid_codes:
                can_identify_tables = False

        sequence = _cycle_sequence([
            _SeqEntry(
                len(part["numbers"]) if part["numbers"] else int(part["row"].tables_cleaned or 0),
                part["counts"],
                frozenset(part["numbers"]),
                part["is_extra"],
            )
            for part in parts
        ], total_tables)
        seen: dict[tuple[int, int], dict] = {}
        conflicting_splits: set[str] = set()
        for part, (cycle_no, extra) in zip(parts, sequence):
            if extra or not part["counts"]:
                continue
            for number in part["numbers"]:
                key = (cycle_no, number)
                previous = seen.get(key)
                if previous is not None:
                    if previous["split_id"]:
                        conflicting_splits.add(previous["split_id"])
                    if part["split_id"]:
                        conflicting_splits.add(part["split_id"])
                else:
                    seen[key] = part
        new_exclusions = conflicting_splits - excluded
        if not new_exclusions:
            return list(candidates.values())
        excluded.update(new_exclusions)


def _split_legacy_rollover_reports(
    db: Session, plant: Plant, month: str, total_tables: int, user: User | None,
) -> tuple[list[dict], set[UUID]]:
    rows = list(db.scalars(select(WashingDailyReport).where(
        WashingDailyReport.plant_id == plant.id, WashingDailyReport.cycle_month == month,
    ).order_by(WashingDailyReport.report_date, WashingDailyReport.created_at, WashingDailyReport.id)))
    planned = _plan_legacy_rollover_splits(rows, total_tables)
    splits, touched = [], set()
    for candidate in planned:
        report = candidate["row"]
        before_codes = list(report.cleaned_table_codes or [])
        before_count = report.tables_cleaned
        report.cleaned_table_codes = candidate["first_codes"]
        report.tables_cleaned = len(candidate["first_codes"])
        report.cycle_completed = False
        created_at = report.created_at or datetime.now(timezone.utc)
        split_report = WashingDailyReport(
            plant_id=report.plant_id,
            cycle_month=report.cycle_month,
            cycle_no=report.cycle_no,
            report_date=report.report_date,
            job_status=report.job_status,
            tables_cleaned=len(candidate["next_codes"]),
            cleaned_table_codes=candidate["next_codes"],
            remarks=report.remarks,
            exception_reason=report.exception_reason,
            evidence=[],
            reported_by_id=report.reported_by_id,
            reported_by=report.reported_by,
            review_status=report.review_status,
            reviewed_by_id=report.reviewed_by_id,
            reviewed_by=report.reviewed_by,
            reviewed_at=report.reviewed_at,
            review_note=report.review_note,
            cycle_completed=False,
            is_extra=candidate["next_is_extra"],
            created_at=created_at + timedelta(microseconds=1),
        )
        db.add(split_report)
        db.flush()
        touched.update((report.id, split_report.id))
        metadata = {
            "plant": plant.site_code,
            "month": month,
            "report_date": report.report_date.isoformat(),
            "source_report_id": str(report.id),
            "split_report_id": str(split_report.id),
            "first_entry_tables": candidate["first_codes"],
            "next_cycle_tables": candidate["next_codes"],
            "next_entry_is_extra": candidate["next_is_extra"],
            "evidence_kept_on_report_id": str(report.id),
        }
        db.add(AuditLog(
            user_id=user.id if user else None,
            actor_name=user.display_name if user else "Solar91 (automatic)",
            action="Split legacy module cleaning rollover",
            module="Washing",
            entity_type="washing_daily_report",
            entity_id=str(report.id),
            before_state={"tables_cleaned": before_count, "cleaned_table_codes": before_codes},
            after_state={
                "source_report_id": str(report.id),
                "source_tables_cleaned": report.tables_cleaned,
                "source_table_codes": candidate["first_codes"],
                "split_report_id": str(split_report.id),
                "split_tables_cleaned": split_report.tables_cleaned,
                "split_table_codes": candidate["next_codes"],
            },
            metadata_json=metadata,
        ))
        splits.append({
            "report_id": str(report.id),
            "split_report_id": str(split_report.id),
            "report_date": report.report_date.isoformat(),
            "first_entry_tables": candidate["first_codes"],
            "next_cycle_tables": candidate["next_codes"],
            "next_entry_is_extra": candidate["next_is_extra"],
        })
    return splits, touched


def _report_table_count(report) -> int:
    """Count distinct recorded table numbers, or the saved count for count-only reports."""
    numbers = {_code_number(code) for code in (report.cleaned_table_codes or [])}
    numbers.discard(None)
    return len(numbers) if numbers else int(report.tables_cleaned or 0)


def _completing_rows(by_cycle, total_tables: int) -> list:
    """`by_cycle[n - 1]`: cycle n's confirmed days in date order. Returns the day each cycle was completed on (None while
    it is open), counting the tables carried over from the cycle before (_cycle_sequence)."""
    out, carry = [], 0
    for n, rows in enumerate(by_cycle, 1):
        running, done, seen = carry, None, set()
        for row in rows:
            # Saved days carry `cleaned_table_codes`; the CSV import plans days as `_Planned`, which
            # has already parsed them into `numbers`. Accept either, or the upload crashes here.
            numbers = set(getattr(row, "numbers", None) or ())
            if not numbers:
                numbers = {_code_number(code) for code in (getattr(row, "cleaned_table_codes", None) or [])}
            numbers.discard(None)
            if numbers:
                running += len(numbers - seen)
                seen.update(numbers)
            else:
                running += row.tables_cleaned or 0
            if done is None and total_tables > 0 and running >= total_tables:
                done = row
        out.append(done)
        carry = running - total_tables if done is not None and n < MONTHLY_CYCLE_TARGET else 0
    return out


def _cycle_ledger(reports, total_tables: int) -> dict[int, dict]:
    """Tables counted towards each cycle of one plant-month, with the tables carried over between cycles: cycles 1
    and 2 count up to the plant's table count and pass the rest on; cycle 3 keeps everything (above the count it is
    extra washing). `confirmed` / `pending` are what each cycle shows; `carried_in` / `carried_out` explain them.

    Entries MARKED extra (`is_extra`, migration 048) are re-cleaning, not cycle progress, so they are
    left out entirely. Skipping them here is what keeps that true for every figure built on this
    ledger: the cycle tables in `month_cycles`, the overview, `_closed_incomplete` and
    `_cycle_work_scores`. Without it an extra entry naming a table the cycle had not reached yet
    counted towards it, so re-cleaning could stand in for work still owed."""
    reports = [r for r in reports if not getattr(r, "is_extra", False)]

    def walk(statuses: tuple[str, ...]) -> dict[int, tuple[int, int, int]]:
        carry, out = 0, {}
        for n in range(1, MONTHLY_CYCLE_TARGET + 1):
            seen: set[int] = set()
            cleaned = 0
            for report in sorted(
                (r for r in reports if r.cycle_no == n and r.review_status in statuses),
                key=lambda r: (r.report_date, str(getattr(r, "created_at", "") or "")),
            ):
                numbers = {_code_number(code) for code in (report.cleaned_table_codes or [])}
                numbers.discard(None)
                if numbers:
                    cleaned += len(numbers - seen)
                    seen.update(numbers)
                else:
                    cleaned += int(report.tables_cleaned or 0)
            total = carry + cleaned
            over = total - total_tables if n < MONTHLY_CYCLE_TARGET and total_tables > 0 and total >= total_tables else 0
            out[n] = (carry, total - over, over)
            carry = over
        return out
    recorded, confirmed = walk(("Pending", "Confirmed")), walk(("Confirmed",))
    return {n: {"confirmed": confirmed[n][1], "pending": max(0, recorded[n][1] - confirmed[n][1]),
                "carried_in": recorded[n][0], "carried_out": recorded[n][2]} for n in recorded}


def _closed_incomplete(reports, total_tables: int) -> set[int]:
    """Return cycles with later-cycle work but fewer than the configured distinct tables."""
    active = [r for r in reports if r.review_status in ("Pending", "Confirmed")]
    highest = max((r.cycle_no for r in active), default=0)
    if total_tables <= 0 or highest < 2:
        return set()
    ledger = _cycle_ledger(active, total_tables)
    return {n for n in range(1, highest) if ledger[n]["confirmed"] + ledger[n]["pending"] < total_tables}


def _completed_cycles(db: Session, plant_id: UUID, month: str) -> set[int]:
    return set(db.scalars(select(WashingDailyReport.cycle_no).where(
        WashingDailyReport.plant_id == plant_id, WashingDailyReport.cycle_month == month,
        WashingDailyReport.cycle_completed.is_(True), WashingDailyReport.review_status == "Confirmed",
    )))


def _resequence_month(db: Session, plant_id: UUID, month: str, total_tables: int) -> list[dict]:
    """Re-number one plant-month's days by table-completion order and refresh each cycle's completion.
    Returns the days that moved to another cycle (for the audit log)."""
    rows = list(db.scalars(select(WashingDailyReport).where(
        WashingDailyReport.plant_id == plant_id, WashingDailyReport.cycle_month == month,
    ).order_by(WashingDailyReport.report_date, WashingDailyReport.created_at)))
    sequence = _cycle_sequence([_sequence_entry(row) for row in rows], total_tables)
    moved = []
    for row, (cycle_no, _extra) in zip(rows, sequence):
        if row.cycle_no != cycle_no:
            moved.append({"report_date": row.report_date.isoformat(), "from": row.cycle_no, "to": cycle_no})
            row.cycle_no = cycle_no
    for row in rows:
        row.cycle_completed = False
    # Extra entries are tagged to a cycle but are not part of its work, so they are left out
    # here: one must never be the row that completes a cycle.
    confirmed = [[row for row in rows
                  if row.cycle_no == n and row.review_status == "Confirmed" and not row.is_extra]
                 for n in range(1, MONTHLY_CYCLE_TARGET + 1)]
    for row in _completing_rows(confirmed, total_tables):
        if row is not None:
            row.cycle_completed = True
    db.flush()
    return moved


def _audit_moves(db: Session, user: User | None, plant: Plant, month: str, moved: list[dict], reason: str) -> None:
    if moved:
        db.add(AuditLog(
            user_id=user.id if user else None, actor_name=user.display_name if user else "Solar91 (automatic)",
            action="Recounted washing cycles", module="Washing",
            entity_type="plant", entity_id=plant.site_code, metadata_json={"month": month, "reason": reason, "moved": moved},
        ))


# Bump when the cycle counting rule changes. This version also splits unambiguous legacy rollover reports once.
CYCLE_RULE_SETTING = "washing_cycle_rule"
CYCLE_RULE_VERSION = "distinct-table-completion-3-rollover-split"


def recount_all_months(db: Session) -> dict:
    """Bring every saved plant-month in line with the current cycle rule (_cycle_sequence) once after a deploy, so
    plant cycles, the monthly sheet, reports and compliance figures follow it without anyone pressing Recount.
    One plant at a time under its washing lock (the same lock every report save takes); idempotent, so a second
    worker doing the same at the same time changes nothing. Each move is in the audit log. No notifications."""
    marker = db.get(AppSetting, CYCLE_RULE_SETTING)
    if marker is not None and marker.setting_value == CYCLE_RULE_VERSION:
        return {"skipped": True}
    plants = moved_days = months = split_reports = 0
    for plant_id in list(db.scalars(select(WashingConfig.plant_id).order_by(WashingConfig.plant_id))):
        config = db.scalar(select(WashingConfig).where(WashingConfig.plant_id == plant_id).with_for_update())
        plant = db.get(Plant, plant_id)
        if config is None or plant is None:
            db.rollback()
            continue
        total = _plant_table_count(db, plant_id, config)
        for month in sorted(set(db.scalars(select(WashingDailyReport.cycle_month).where(WashingDailyReport.plant_id == plant_id)))):
            splits, _touched = _split_legacy_rollover_reports(db, plant, month, total, None)
            moved = _resequence_month(db, plant_id, month, total)
            _audit_moves(db, None, plant, month, moved, f"cycle rule {CYCLE_RULE_VERSION}")
            split_reports += len(splits)
            moved_days += len(moved)
            months += 1
        db.commit()            # one plant per transaction: report saves for other plants never wait long
        plants += 1
    marker = db.get(AppSetting, CYCLE_RULE_SETTING)
    if marker is None:
        db.add(AppSetting(setting_key=CYCLE_RULE_SETTING, setting_value=CYCLE_RULE_VERSION))
    else:
        marker.setting_value = CYCLE_RULE_VERSION
    db.commit()
    invalidate_overview_cache()
    return {"plants": plants, "months": months, "moved_days": moved_days, "split_reports": split_reports}


def _ordered_codes(db: Session, plant_id: UUID) -> list[str]:
    return [table.table_code or table.legacy_id for table in db.scalars(
        select(WashingTable).where(WashingTable.plant_id == plant_id).order_by(WashingTable.table_code, WashingTable.legacy_id)
    )]


def _validate_report_date(user: User, manager: bool, value: date) -> None:
    today = business_today()
    if value > today:
        raise HTTPException(422, "The report date cannot be in the future")
    if not manager and (today - value).days > MAX_BACKDATE_DAYS:
        raise HTTPException(422, f"A report can be entered for the last {MAX_BACKDATE_DAYS} days only; ask the O&M Head for older dates")


def _locked_report_plant(db: Session, user: User, plant_id: UUID) -> tuple[Plant, WashingConfig, bool, int]:
    """Who may submit washing reports; locks the config so concurrent submissions serialize per plant."""
    manager = _is_washing_manager(db, user)
    if user.role != "Site Engineer" and not manager:
        raise HTTPException(403, "Only a Site Engineer can submit a daily washing report; the O&M team reviews it")
    plant = _plant_for_id(db, plant_id)
    config = db.scalar(select(WashingConfig).where(WashingConfig.plant_id == plant.id).with_for_update())
    if not config:
        raise HTTPException(409, "Washing has not been set up for this plant")
    _require_plant_access(db, user, plant, config)
    total_tables = _plant_table_count(db, plant.id, config)
    if total_tables < 1:
        raise HTTPException(409, "Washing has not been set up for this plant")
    return plant, config, manager, total_tables


def _add_report(
    db: Session, user: User, plant: Plant, manager: bool, total_tables: int, *,
    report_date: date, job_status: str, tables_cleaned: int, exception_reason: str | None,
    remarks: str | None, cleaned_codes: list[str] | None = None, is_extra: bool = False,
    created_at: datetime | None = None,
) -> tuple[WashingDailyReport, bool]:
    """Create one daily report (no commit, no notification). Returns the report and whether it completed a cycle.

    `created_at` orders entries that share a date. Every reader of a plant-month (_resequence_month,
    _cycle_ledger, _assert_distinct_tables, month_cycles, day_activity) sorts by (report_date,
    created_at). A Cycle 3 completion and its same-day extra-cleaning entry must remain in submitted
    order; callers pass distinct timestamps for sheet entries, while single reports use the database
    default."""
    _validate_report_date(user, manager, report_date)
    month = _month_key(report_date)
    # Counts remain compatible with older clients; the current daily sheet can also persist numbered tables.
    report = WashingDailyReport(
        plant_id=plant.id,
        cycle_month=month,
        cycle_no=1,  # the real cycle is set by _resequence_month below, from the day's place in the month
        report_date=report_date,
        job_status=job_status,
        tables_cleaned=tables_cleaned,
        cleaned_table_codes=list(cleaned_codes or []),
        remarks=(remarks or "").strip() or None,
        exception_reason=exception_reason,
        is_extra=is_extra,
        reported_by_id=user.id,
        reported_by=user.display_name,
    )
    if created_at is not None:
        report.created_at = created_at
    if manager and user.role != "Site Engineer":
        # An O&M entry (e.g. back-filling an older date) is the O&M team's own record, so it needs no second review.
        report.review_status = "Confirmed"
        report.reviewed_by_id = user.id
        report.reviewed_by = user.display_name
        report.reviewed_at = datetime.now(timezone.utc)
        report.review_note = OM_ENTRY_NOTE
    db.add(report)
    db.flush()
    # a back-filled day takes its place by date; the days after it move to the right cycle
    moved = [m for m in _resequence_month(db, plant.id, month, total_tables) if m["report_date"] != report_date.isoformat()]
    _audit_moves(db, user, plant, month, moved, f"{report_date.isoformat()} added")
    cycle_completed = bool(report.cycle_completed)
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name, action="Submitted daily washing report",
        module="Washing", entity_type="washing_daily_report", entity_id=str(report.id),
        metadata_json={"plant": plant.site_code, "cycle_month": month, "cycle_no": report.cycle_no, "report_date": report_date.isoformat(), "job_status": report.job_status, "tables_cleaned": report.tables_cleaned, "exception_reason": report.exception_reason, "cycle_completed": cycle_completed},
    ))
    return report, cycle_completed


def create_daily_report(db: Session, user: User, payload: WashingDailyReportRequest) -> dict:
    plant, config, manager, total_tables = _locked_report_plant(db, user, payload.plant_id)
    if payload.job_status == "Done" and payload.tables_cleaned == 0:
        raise HTTPException(422, "Enter at least one cleaned table for a Done report")
    report_date = payload.report_date or business_today()
    report, _cycle_completed = _add_report(
        db, user, plant, manager, total_tables,
        report_date=report_date, job_status=payload.job_status,
        tables_cleaned=payload.tables_cleaned, exception_reason=payload.exception_reason,
        remarks=payload.remarks, cleaned_codes=payload.cleaned_table_codes,
        is_extra=payload.is_extra,
    )
    _assert_distinct_tables(db, plant.id, [report.cycle_month], total_tables, {report.id})
    cycle_no = report.cycle_no
    if report.review_status != "Confirmed":
        _notify_wash(
            db, plant, config,
            event_type="washing_daily_report",
            title=f"{'Washing exception' if report.exception_reason else 'Washing status awaiting review'} — Cycle {cycle_no}",
            message=(
                f"Not done — {report.exception_reason}. {report.remarks or 'No additional remarks.'} Review required."
                if report.exception_reason else
                f"Done; {report.tables_cleaned} of {total_tables} tables reported clean. Review required."
            ),
            dedupe_key=f"washing-report:{report.id}",
            extra_user_ids=[user.id],
        )
    db.commit()
    return _report_out(report, plant, user, config, manager, total_tables)


def _day_label(value: date) -> str:
    return f"{value.day} {value.strftime('%b')}"


def _assert_single_sheet_report_date(db: Session, plant_id: UUID, report_date: date) -> None:
    query = select(WashingDailyReport.id).where(
        WashingDailyReport.plant_id == plant_id,
        WashingDailyReport.report_date == report_date,
        WashingDailyReport.is_extra.is_(False),
        WashingDailyReport.review_status.in_(("Pending", "Confirmed")),
    )
    if db.scalar(query.limit(1)) is not None:
        raise HTTPException(
            409,
            f"A module cleaning entry already exists for {_day_label(report_date)}. "
            "Edit that entry or use Extra Cleaning for additional cleaning on that date.",
        )


def _assert_same_day_next_cycle_allowed(db: Session, plant_id: UUID, report_date: date) -> None:
    """Only allow a same-day rollover immediately after a confirmed cycle completion."""
    rows = list(db.scalars(
        select(WashingDailyReport).where(
            WashingDailyReport.plant_id == plant_id,
            WashingDailyReport.cycle_month == _month_key(report_date),
            WashingDailyReport.report_date == report_date,
            WashingDailyReport.review_status.in_(("Pending", "Confirmed")),
        ).order_by(WashingDailyReport.created_at)
    ))
    completions = [
        row for row in rows
        if not row.is_extra and row.review_status == "Confirmed" and
        row.cycle_completed and row.cycle_no < MONTHLY_CYCLE_TARGET
    ]
    regular_rows = [row for row in rows if not row.is_extra]
    if len(completions) != 1 or len(regular_rows) != 1:
        raise HTTPException(409, "A next-cycle entry is allowed only on the date a confirmed cycle was completed.")
    previous_cycle = max(row.cycle_no for row in completions)
    if any(
        not row.is_extra and row.cycle_no != previous_cycle
        for row in rows
    ):
        raise HTTPException(409, "A next-cycle entry already exists for that date.")
    if db.scalar(select(WashingDailyReport.id).where(
        WashingDailyReport.plant_id == plant_id,
        WashingDailyReport.cycle_month == _month_key(report_date),
        WashingDailyReport.cycle_no > previous_cycle,
        WashingDailyReport.report_date > report_date,
        WashingDailyReport.job_status == "Done",
        WashingDailyReport.review_status.in_(("Pending", "Confirmed")),
        WashingDailyReport.is_extra.is_(False),
    ).limit(1)) is not None:
        raise HTTPException(409, "The next cycle has already started on a later date.")


def create_sheet_reports(db: Session, user: User, payload: WashingSheetRequest) -> dict:
    """Save several days of one plant's cycle sheet in one go. All days are saved or none is.
    A Site Engineer's days wait for O&M confirmation and raise ONE review notification for the whole sheet;
    the O&M Head / a washing Assignee saves them as confirmed, like a single O&M entry."""
    plant, config, manager, total_tables = _locked_report_plant(db, user, payload.plant_id)
    # A date normally holds ONE regular module-cleaning entry. It may hold a second when the first
    # fills the running cycle and the second is the next cycle started the same afternoon: the
    # tables a cycle still needed, plus the tables re-cleaned that day, saved together. Sorting is
    # stable, so same-date entries keep their submitted order, and each row is stamped with an
    # increasing created_at below so the sequencer can tell which came first. Whether the pair is a
    # real roll-over cannot be judged here -- it depends on the cycle numbers the month resequences
    # to -- so it is checked after the rows exist, by _assert_one_regular_entry_per_cycle_date.
    # Extra cleaning is a separate entry and may always share a date with the regular report.
    entries = sorted(payload.entries, key=lambda entry: entry.report_date)
    regular_dates: dict[date, int] = {}
    for entry in entries:
        _validate_report_date(user, manager, entry.report_date)
        if entry.is_extra:
            continue
        seen_for_date = regular_dates.get(entry.report_date, 0)
        if entry.same_day_next_cycle:
            if seen_for_date:
                raise HTTPException(409, "A date can contain only one regular module cleaning entry.")
            regular_dates[entry.report_date] = seen_for_date + 1
            _assert_same_day_next_cycle_allowed(db, plant.id, entry.report_date)
            continue
        if seen_for_date >= MONTHLY_CYCLE_TARGET:
            raise HTTPException(
                409,
                f"{_day_label(entry.report_date)} cannot hold more than {MONTHLY_CYCLE_TARGET} module "
                "cleaning entries. Use Extra Cleaning for additional cleaning on that date.",
            )
        regular_dates[entry.report_date] = seen_for_date + 1
        if not seen_for_date:
            _assert_single_sheet_report_date(db, plant.id, entry.report_date)
    created: list[WashingDailyReport] = []
    # Keep same-date regular/extra entries in their submitted order for calendar display and recounts.
    stamp = datetime.now(timezone.utc)
    for index, entry in enumerate(entries):
        if entry.table_start is not None and max(entry.table_start, entry.table_end) > total_tables:
            raise HTTPException(
                422,
                f"Table number {max(entry.table_start, entry.table_end)} exceeds this plant's configured table count ({total_tables})",
            )
        if entry.table_numbers is not None:
            cleaned_codes = _numbered_codes(entry.table_numbers, total_tables)
        elif entry.table_start is not None and entry.table_end is not None:
            step = 1 if entry.table_start <= entry.table_end else -1
            cleaned_codes = [
                f"Table {number:03d}"
                for number in range(entry.table_start, entry.table_end + step, step)
            ]
        else:
            cleaned_codes = []
        report, _completed = _add_report(
            db, user, plant, manager, total_tables,
            report_date=entry.report_date, job_status=entry.job_status, tables_cleaned=entry.tables_cleaned,
            exception_reason=entry.exception_reason, remarks=entry.remarks, cleaned_codes=cleaned_codes,
            is_extra=entry.is_extra, created_at=stamp + timedelta(microseconds=index),
        )
        created.append(report)
    months = [report.cycle_month for report in created]
    touched = {report.id for report in created}
    _assert_distinct_tables(db, plant.id, months, total_tables, touched)
    _assert_one_regular_entry_per_cycle_date(db, plant.id, months, total_tables, touched)
    pending = [report for report in created if report.review_status == "Pending"]
    if pending:
        done = [report for report in pending if report.job_status == "Done"]
        not_done = len(pending) - len(done)
        cycles = sorted({report.cycle_no for report in pending})
        span = _day_label(pending[0].report_date) if len(pending) == 1 else f"{_day_label(pending[0].report_date)} – {_day_label(pending[-1].report_date)}"
        _notify_wash(
            db, plant, config,
            event_type="washing_daily_report",
            title=f"Washing sheet awaiting review — Cycle {', '.join(str(n) for n in cycles)}",
            message=(f"{user.display_name} filled {len(pending)} day{'s' if len(pending) != 1 else ''} ({span}): "
                     f"{sum(report.tables_cleaned for report in done)} tables cleaned"
                     + (f", {not_done} day{'s' if not_done != 1 else ''} not done" if not_done else "")
                     + ". Review required."),
            dedupe_key=f"washing-sheet:{pending[0].id}",
            extra_user_ids=[user.id],
        )
    db.commit()
    return {"saved": len(created), "reports": [_report_out(report, plant, user, config, manager, total_tables) for report in created]}


def _load_report_for_change(db: Session, user: User, report_id: UUID):
    report = db.scalar(select(WashingDailyReport).where(WashingDailyReport.id == report_id).with_for_update())
    if not report:
        raise HTTPException(404, "Daily washing report not found")
    plant = _plant_for_id(db, report.plant_id)
    config = db.scalar(select(WashingConfig).where(WashingConfig.plant_id == plant.id).with_for_update())
    if not config:
        raise HTTPException(409, "Washing has not been set up for this plant")
    manager = _is_washing_manager(db, user)
    if report.is_extra and not manager:
        raise HTTPException(
            403, "Only the O&M Head or a washing Assignee can edit or remove extra cleaning"
        )
    owner = report.reported_by_id == user.id and report.review_status in ("Pending", "Rejected")
    if not manager and not owner:
        raise HTTPException(403, "Only the O&M team can change a report after it has been reviewed; a Site Engineer can change their own report until it is confirmed")
    if not manager:
        _require_plant_access(db, user, plant, config)
    return report, plant, config, manager


def _code_number(code: object) -> int | None:
    match = re.search(r"(\d+)$", str(code or ""))
    return int(match.group(1)) if match else None


def format_table_codes(codes, *, preserve_order: bool = False) -> str:
    """Compress table codes for display, optionally preserving a recorded range's direction."""
    numbers = [n for n in (_code_number(code) for code in (codes or [])) if n is not None]
    if not preserve_order:
        numbers = sorted(set(numbers))
    parts, i = [], 0
    while i < len(numbers):
        j = i
        step = numbers[j + 1] - numbers[j] if j + 1 < len(numbers) and abs(numbers[j + 1] - numbers[j]) == 1 else 0
        while step and j + 1 < len(numbers) and numbers[j + 1] - numbers[j] == step:
            j += 1
        parts.append(f"{numbers[i]}–{numbers[j]}" if j > i else str(numbers[i]))
        i = j + 1
    return ", ".join(parts)


def _numbered_codes(numbers: list[int], total_tables: int) -> list[str]:
    """Codes for an explicit list of table numbers (a range from the start, from the end, or scattered tables)."""
    too_high = [number for number in numbers if number > total_tables]
    if too_high:
        raise HTTPException(422, f"Table number {max(too_high)} exceeds this plant's configured table count ({total_tables})")
    return [f"Table {number:03d}" for number in numbers]


def _assert_one_regular_entry_per_cycle_date(db: Session, plant_id: UUID, months, total_tables: int,
                                             touched: set) -> None:
    """A date holds at most one regular entry PER CYCLE.

    This is what separates a genuine same-day roll-over from a date that was simply recorded twice.
    Two entries on one date are legal only when the first fills the running cycle and the second is
    the next cycle begun that same afternoon, so they resequence to DIFFERENT cycle numbers. Two
    entries that both land in the same cycle are one day's work split in two and belong in a single
    entry, which the caller is told to edit instead.

    Checked after the rows exist, because the cycle numbers come from resequencing the whole month.
    Only days being saved or edited are refused, so existing data is never retroactively rejected."""
    for month in dict.fromkeys(months):
        rows = list(db.scalars(select(WashingDailyReport).where(
            WashingDailyReport.plant_id == plant_id, WashingDailyReport.cycle_month == month,
        ).order_by(WashingDailyReport.report_date, WashingDailyReport.created_at)))
        sequence = _cycle_sequence([_sequence_entry(row) for row in rows], total_tables)
        seen: dict[tuple[date, int], WashingDailyReport] = {}
        for row, (cycle_no, extra) in zip(rows, sequence):
            if extra or row.review_status not in ("Pending", "Confirmed"):
                continue
            key = (row.report_date, cycle_no)
            other = seen.get(key)
            if other is not None and (row.id in touched or other.id in touched):
                raise HTTPException(409, (
                    f"{_day_label(row.report_date)} already has a cycle {cycle_no} module cleaning "
                    "entry. Edit that entry, or record the tables that finish the cycle first so the "
                    "re-cleaned tables start the next one."
                ))
            seen.setdefault(key, row)


def _assert_distinct_tables(db: Session, plant_id: UUID, months, total_tables: int, touched: set) -> None:
    """A table is cleaned once per cycle. Refuses (so the caller's transaction rolls back) when a day that was just
    saved or edited lists a table that another day of the same cycle already has. Days beyond the three cycles are extra
    washing and may repeat tables; older days that already overlap are left alone unless they are being changed."""
    for month in dict.fromkeys(months):
        rows = list(db.scalars(select(WashingDailyReport).where(
            WashingDailyReport.plant_id == plant_id, WashingDailyReport.cycle_month == month,
        ).order_by(WashingDailyReport.report_date, WashingDailyReport.created_at)))
        sequence = _cycle_sequence([_sequence_entry(row) for row in rows], total_tables)
        seen: dict[tuple[int, int], WashingDailyReport] = {}
        for row, (cycle_no, extra) in zip(rows, sequence):
            if extra or row.review_status not in ("Pending", "Confirmed"):
                continue
            for code in row.cleaned_table_codes or []:
                number = _code_number(code)
                if number is None:
                    continue
                other = seen.get((cycle_no, number))
                if other is not None and (row.id in touched or other.id in touched):
                    raise HTTPException(409, (
                        f"Table {number} is already recorded in cycle {cycle_no} on {_day_label(other.report_date)}. "
                        "A table can be cleaned only once per cycle; change that day or leave the table out."
                        + (" Cycle 3 is the month's last cycle, so a re-clean cannot move on to a next cycle."
                           if cycle_no >= MONTHLY_CYCLE_TARGET and _entered_by_om(row) else "")
                    ))
                seen.setdefault((cycle_no, number), row)


def update_daily_report(db: Session, user: User, report_id: UUID, payload: WashingReportUpdateRequest) -> dict:
    report, plant, config, manager = _load_report_for_change(db, user, report_id)
    total_tables = _plant_table_count(db, plant.id, config)
    before = {"report_date": report.report_date.isoformat(), "tables_cleaned": report.tables_cleaned, "job_status": report.job_status,
              "exception_reason": report.exception_reason, "remarks": report.remarks, "cycle_no": report.cycle_no, "cycle_month": report.cycle_month,
              "table_codes": list(report.cleaned_table_codes or [])}
    old_month = report.cycle_month

    new_date = payload.report_date or report.report_date
    _validate_report_date(user, manager, new_date)
    status = payload.job_status or report.job_status
    codes: list[str] = []
    if status == "Done":
        if payload.table_numbers is not None:
            codes = _numbered_codes(payload.table_numbers, total_tables)
            tables = len(codes)
        elif payload.table_start is not None:
            if max(payload.table_start, payload.table_end) > total_tables:
                raise HTTPException(422, f"Table number {max(payload.table_start, payload.table_end)} exceeds this plant's configured table count ({total_tables})")
            tables = abs(payload.table_end - payload.table_start) + 1
            step = 1 if payload.table_start <= payload.table_end else -1
            codes = [
                f"Table {number:03d}"
                for number in range(payload.table_start, payload.table_end + step, step)
            ]
        else:
            tables = payload.tables_cleaned if payload.tables_cleaned is not None else report.tables_cleaned
        if tables < 1:
            raise HTTPException(422, "Enter at least one cleaned table for a Done report")
        reason = None
    else:
        tables = 0
        reason = payload.exception_reason or report.exception_reason
        if not reason:
            raise HTTPException(422, "Choose the reason the work was not done")

    new_month = _month_key(new_date)

    report.report_date = new_date
    report.cycle_month = new_month
    report.job_status = status
    report.tables_cleaned = tables
    report.cleaned_table_codes = codes
    report.exception_reason = reason
    if payload.remarks is not None:
        report.remarks = payload.remarks.strip() or None
    if not manager and report.review_status == "Rejected":
        # The engineer fixed a rejected report: send it back for review.
        report.review_status = "Pending"
        report.reviewed_by_id = None
        report.reviewed_by = None
        report.reviewed_at = None
        report.review_note = None
    report.cycle_completed = False
    db.add(report)
    db.flush()
    # The edited day and every day after it take the cycle their date order gives them: a day changed from 0 to 40
    # after cycle 2 was already full counts in cycle 3, and cycle 3 starts there.
    for month in dict.fromkeys((old_month, new_month)):
        moved = _resequence_month(db, plant.id, month, total_tables)
        _audit_moves(db, user, plant, month, moved, f"{before['report_date']} edited")
    _assert_distinct_tables(db, plant.id, (old_month, new_month), total_tables, {report.id})
    cycle_no = report.cycle_no
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name, action="Edited daily washing report",
        module="Washing", entity_type="washing_daily_report", entity_id=str(report.id),
        metadata_json={"plant": plant.site_code, "before": before, "after": {"report_date": new_date.isoformat(), "tables_cleaned": tables, "job_status": status, "exception_reason": reason, "cycle_no": cycle_no, "cycle_month": new_month}},
    ))
    db.commit()
    return _report_out(report, plant, user, config, manager, total_tables)


def delete_daily_report(db: Session, user: User, report_id: UUID) -> dict:
    report, plant, config, manager = _load_report_for_change(db, user, report_id)
    total_tables = _plant_table_count(db, plant.id, config)
    month, cycle_no = report.cycle_month, report.cycle_no
    paths = [str(entry.get("storage_path")) for entry in (report.evidence or []) if isinstance(entry, dict) and entry.get("storage_path")]
    info = {"plant": plant.site_code, "report_date": report.report_date.isoformat(), "tables_cleaned": report.tables_cleaned, "cycle_month": month, "cycle_no": cycle_no, "review_status": report.review_status}
    db.delete(report)
    db.flush()
    _audit_moves(db, user, plant, month, _resequence_month(db, plant.id, month, total_tables), f"{info['report_date']} deleted")
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name, action="Deleted daily washing report",
        module="Washing", entity_type="washing_daily_report", entity_id=str(report_id), metadata_json=info,
    ))
    db.commit()
    if paths:
        try:
            from app.storage.service import SupabaseStorage
            SupabaseStorage().remove(paths)
        except Exception:  # photos are private and unreachable once the report is gone; never fail the delete over them
            pass
    return {"deleted": True, "id": str(report_id)}


def set_cycle_date(db: Session, user: User, plant_id: UUID, payload: WashingCycleDateRequest) -> dict:
    """O&M Head or a washing Assignee moves a cycle's start date or deadline. Site Engineers cannot."""
    if not _is_washing_manager(db, user):
        raise HTTPException(403, "Only the O&M Head or the washing Assignee can change a washing cycle date")
    plant = _plant_for_id(db, plant_id)
    config = db.scalar(select(WashingConfig).where(WashingConfig.plant_id == plant.id).with_for_update())
    if not config:
        raise HTTPException(409, "Washing has not been set up for this plant")
    year, month_no = int(payload.month[:4]), int(payload.month[5:7])
    is_start = payload.field == "start"
    new_value = payload.start_date if is_start else payload.due_date
    label = "start date" if is_start else "deadline"
    if new_value and (new_value.year, new_value.month) != (year, month_no):
        raise HTTPException(422, f"A cycle {label} must fall inside {payload.month}")
    key = f"s{payload.cycle_no}" if is_start else str(payload.cycle_no)
    overrides = {m: dict(v) for m, v in (config.cycle_overrides or {}).items() if isinstance(v, dict)}
    month_map = overrides.setdefault(payload.month, {})
    previous = month_map.get(key)
    # the cycle must still start on or before its deadline once this change is applied
    trial = dict(month_map)
    if new_value is None:
        trial.pop(key, None)
    else:
        trial[key] = new_value.isoformat()
    first = date(year, month_no, 1)
    trial_all = {**overrides, payload.month: trial}
    start_now = _cycle_start_dates(first, trial_all)[payload.cycle_no - 1]
    due_now = _cycle_due_dates(first, trial_all)[payload.cycle_no - 1]
    if start_now > due_now:
        raise HTTPException(422, f"Cycle {payload.cycle_no} cannot start ({start_now.isoformat()}) after its deadline ({due_now.isoformat()})")
    if new_value is None:
        month_map.pop(key, None)
        if not month_map:
            overrides.pop(payload.month, None)
    else:
        month_map[key] = new_value.isoformat()
    config.cycle_overrides = overrides
    db.add(config)
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name,
        action="Changed washing cycle start date" if is_start else "Changed washing cycle deadline",
        module="Washing", entity_type="plant", entity_id=plant.site_code,
        metadata_json={"month": payload.month, "cycle_no": payload.cycle_no, "field": payload.field, "from": previous, "to": new_value.isoformat() if new_value else "default"},
    ))
    db.commit()
    return {
        "plant_id": str(plant.id), "month": payload.month,
        "due_dates": [d.isoformat() for d in _cycle_due_dates(first, config.cycle_overrides)],
        "start_dates": [d.isoformat() for d in _cycle_start_dates(first, config.cycle_overrides)],
    }


def _parse_month(month: str) -> date:
    try:
        first = date(int(month[:4]), int(month[5:7]), 1)
    except (TypeError, ValueError):
        raise HTTPException(422, "Month must look like 2026-10")
    today = business_today()
    if first < date(today.year - 2, today.month, 1) or first > date(today.year + 1, today.month, 1):
        raise HTTPException(422, "Choose a month within the last two years or the next twelve months")
    return first


def _pattern_out(config: WashingConfig) -> dict | None:
    pattern = (config.cycle_overrides or {}).get(PATTERN_KEY)
    if not isinstance(pattern, dict) or not pattern.get("days"):
        return None
    days = pattern["days"]
    return {"from": pattern.get("from"), "cycles": [
        {"cycle_no": n, "start_day": days.get(f"s{n}"), "due_day": days.get(str(n))} for n in range(1, MONTHLY_CYCLE_TARGET + 1)]}


# Day summary grouping, in display order: cleaned and confirmed first, plants with nothing recorded last.
DAY_STATUS_ORDER = ("confirmed", "awaiting", "not_done", "rejected", "not_reported", "upcoming", "paused")


def day_activity(db: Session, user: User, day: date, plant_id: UUID | None = None) -> dict:
    """What happened in washing on one day, for one plant or every plant the user can see.

    Cycles completed count by washing date (the same date the "Cycle updates" feed shows); confirmations count by
    when the report was confirmed, in the business time zone (O&M entries are confirmed the moment they are saved)."""
    manager = _is_washing_manager(db, user)
    if not manager and user.role != "Site Engineer":
        raise HTTPException(403, "Washing activity is available to the O&M team and Site Engineers")
    stmt = select(Plant, WashingConfig).join(WashingConfig, WashingConfig.plant_id == Plant.id).order_by(Plant.plant_name)
    if not manager:
        stmt = stmt.where(Plant.id.in_(user_scoped_plant_ids(db, user) or set()))
    if plant_id is not None:
        stmt = stmt.where(Plant.id == plant_id)
    plants = {p.id: (p, c) for p, c in db.execute(stmt).all()}
    if plant_id is not None and plant_id not in plants:
        raise HTTPException(404, "Washing plant not found")
    # tables per cycle, as the overview counts them: the configured number, else the registered tables (one query)
    counted = [pid for pid, (_p, c) in plants.items() if not c.tables_per_cycle]
    registered = dict(db.execute(select(WashingTable.plant_id, func.count(WashingTable.id))
                                 .where(WashingTable.plant_id.in_(counted)).group_by(WashingTable.plant_id)).all()) if counted else {}
    start = datetime.combine(day, datetime.min.time(), tzinfo=BUSINESS_TZ).astimezone(timezone.utc)
    end = start + timedelta(days=1)
    rows: dict[UUID, dict] = {}
    day_reports: dict[UUID, list[WashingDailyReport]] = {}
    for pid, (p, c) in plants.items():
        table_count = int(c.tables_per_cycle or registered.get(pid, 0))
        rows[pid] = {"plant_id": str(pid), "plant": p.plant_name, "site_code": p.site_code, "active": c.active,
                     "target": _daily_table_target(table_count, day, c.cycle_overrides) if manager and table_count else None,
                     "cycles_completed": [], "confirmations": 0, "tables_confirmed": 0, "reported": 0, "pending": 0,
                     "confirmed_by": []}
    if plants:
        for r in db.scalars(select(WashingDailyReport).where(
                WashingDailyReport.plant_id.in_(list(plants)),
                or_(WashingDailyReport.report_date == day,
                    (WashingDailyReport.reviewed_at >= start) & (WashingDailyReport.reviewed_at < end)))):
            row = rows[r.plant_id]
            if r.report_date == day:
                day_reports.setdefault(r.plant_id, []).append(r)
                row["reported"] += 1
                row["pending"] += r.review_status == "Pending"
                if r.cycle_completed and r.review_status == "Confirmed" and r.cycle_no not in row["cycles_completed"]:
                    row["cycles_completed"].append(r.cycle_no)
            at = r.reviewed_at
            if at is not None and at.tzinfo is None:      # SQLite returns naive UTC
                at = at.replace(tzinfo=timezone.utc)
            if r.review_status == "Confirmed" and at is not None and start <= at < end:
                row["confirmations"] += 1
                row["tables_confirmed"] += r.tables_cleaned or 0
                if r.reviewed_by and r.reviewed_by not in row["confirmed_by"]:
                    row["confirmed_by"].append(r.reviewed_by)
    today = business_today()
    patterns = _reason_patterns(excused_reasons(db))
    counts = dict.fromkeys(DAY_STATUS_ORDER, 0)
    for pid, row in rows.items():
        row["cycles_completed"].sort()
        # what was cleaned ON this day, with the same status rules as the overview's "Day by day" table
        reps = day_reports.get(pid, [])
        row["cleaned_confirmed"] = sum(r.tables_cleaned for r in reps if r.review_status == "Confirmed")
        row["cleaned_pending"] = sum(r.tables_cleaned for r in reps if r.review_status == "Pending")
        row["not_done_reason"] = next((r.exception_reason for r in reps if r.exception_reason and r.review_status != "Rejected"), None)
        row["reported_by"] = sorted({r.reported_by for r in reps if r.reported_by})
        table_data_by_cycle: dict[int, dict] = {}
        for report in sorted(reps, key=lambda item: str(item.created_at or "")):
            if report.review_status not in ("Pending", "Confirmed"):
                continue
            cycle_no = int(report.cycle_no or 1)
            entry = table_data_by_cycle.setdefault(cycle_no, {
                "cycle_no": cycle_no, "tables_cleaned": 0,
                "job_status": "Not done", "ranges": [],
            })
            if report.job_status == "Done" and report.tables_cleaned:
                entry["tables_cleaned"] += int(report.tables_cleaned)
                entry["job_status"] = "Done"
                table_range = format_table_codes(report.cleaned_table_codes or [], preserve_order=True)
                if table_range:
                    entry["ranges"].append(table_range)
        row["table_data_by_cycle"] = []
        for entry in sorted(table_data_by_cycle.values(), key=lambda item: item["cycle_no"]):
            entry["table_range"] = " · ".join(entry.pop("ranges")) or None
            row["table_data_by_cycle"].append(entry)
        if any(r.review_status == "Pending" for r in reps):
            status = "awaiting"
        elif row["cleaned_confirmed"]:
            status = "confirmed"
        elif row["not_done_reason"]:
            status = "not_done"
        elif reps:
            status = "rejected"
        elif not row["active"]:
            status = "paused"
        else:
            status = "not_reported" if day <= today else "upcoming"
        row["status"] = status
        counts[status] += 1
        excused = not row["cleaned_confirmed"] and not row["cleaned_pending"] and any(_is_excused(r, patterns) for r in reps)
        row["difference"] = (row["cleaned_confirmed"] + row["cleaned_pending"] - row["target"]
                             if row["target"] is not None and not excused else None)
    active = [row for row in rows.values() if row["cycles_completed"] or row["confirmations"] or row["reported"]]
    shown = sorted(rows.values(), key=lambda r: (DAY_STATUS_ORDER.index(r["status"]), r["plant"]))
    return {
        "date": day.isoformat(),
        "plant_id": str(plant_id) if plant_id else None,
        "totals": {
            "plants": len(rows), "plants_active": len(active), "status": counts,
            "cycles_completed": sum(len(r["cycles_completed"]) for r in rows.values()),
            "confirmations": sum(r["confirmations"] for r in rows.values()),
            "tables_confirmed": sum(r["tables_confirmed"] for r in rows.values()),
            "cleaned_confirmed": sum(r["cleaned_confirmed"] for r in rows.values()),
            "cleaned_pending": sum(r["cleaned_pending"] for r in rows.values()),
            "target": sum(r["target"] or 0 for r in rows.values()) if manager else None,
            "reported": sum(r["reported"] for r in rows.values()),
            "pending": sum(r["pending"] for r in rows.values()),
        },
        "plants": shown,
    }


def month_cycles(db: Session, user: User, plant_id: UUID, month: str) -> dict:
    """One plant's three cycles for any month (past months included): planned dates, defaults, and what was done."""
    # plant and its washing setup in one round trip (this endpoint backs the cycle sheet and is called often)
    found = db.execute(select(Plant, WashingConfig).outerjoin(WashingConfig, WashingConfig.plant_id == Plant.id)
                       .where(Plant.id == plant_id)).first()
    if found is None:
        _plant_for_id(db, plant_id)  # raises the usual "not found" error
    plant, config = found
    if not config:
        raise HTTPException(409, "Washing has not been set up for this plant")
    _require_plant_access(db, user, plant, config)
    first = _parse_month(month)
    table_count = _plant_table_count(db, plant.id, config)
    month_reports = list(db.scalars(select(WashingDailyReport).where(
        WashingDailyReport.plant_id == plant.id, WashingDailyReport.cycle_month == month,
    ).order_by(WashingDailyReport.report_date, WashingDailyReport.created_at)))
    reports = [r for r in month_reports if r.review_status in ("Pending", "Confirmed")]
    manager = _is_washing_manager(db, user)
    starts, dues = _cycle_start_dates(first, config.cycle_overrides), _cycle_due_dates(first, config.cycle_overrides)
    default_starts, default_dues = _default_start_dates(first), _default_due_dates(first)
    specific = (config.cycle_overrides or {}).get(month) or {}
    today = business_today()
    month_end = first.replace(day=monthrange(first.year, first.month)[1])
    cycles = []
    ledger = _cycle_ledger(reports, table_count)
    closed = _closed_incomplete(reports, table_count)
    highest_report_cycle = max((report.cycle_no for report in reports), default=0)
    highest_completed_cycle = max(
        (report.cycle_no for report in reports if report.cycle_completed and report.review_status == "Confirmed"),
        default=0,
    )
    active_cycle = min(MONTHLY_CYCLE_TARGET, max(1, highest_report_cycle, highest_completed_cycle + 1))
    for n in range(1, MONTHLY_CYCLE_TARGET + 1):
        rows = [r for r in reports if r.cycle_no == n]
        confirmed, pending = ledger[n]["confirmed"], ledger[n]["pending"]
        done_on = next((r.report_date for r in rows if r.cycle_completed and r.review_status == "Confirmed"), None)
        due = dues[n - 1]
        # Once the month is over nothing can still be "In progress" or "Upcoming": an incomplete
        # cycle is Missed. Cycles only advance on completion, so an empty past month never
        # advanced and every cycle read as pending. Within the current month the sequence stands.
        # Once the month is over, a cycle nobody ever worked on is Missed -- not "In progress" or
        # "Upcoming". Cycles only advance on completion, so an empty past month never advanced and
        # every cycle read as still pending. A cycle that does have work keeps its real state.
        state = ("Completed" if done_on else
                 "Missed" if n in closed or (today > month_end and not reports) else
                 "In progress" if n <= active_cycle else "Upcoming")
        cycles.append({
            "cycle_no": n, "start_date": starts[n - 1].isoformat(), "due_date": due.isoformat(),
            "default_start_date": default_starts[n - 1].isoformat(), "default_due_date": default_dues[n - 1].isoformat(),
            "start_set_for_month": f"s{n}" in specific, "due_set_for_month": str(n) in specific,
            "state": state, "confirmed": confirmed, "pending": pending, "reports": len(rows),
            "carried_in": ledger[n]["carried_in"], "carried_out": ledger[n]["carried_out"],
            # the first day with tables washed (not-done days before it are listed in the cycle but do not start it)
            "started_on": next((r.report_date for r in rows if r.tables_cleaned), rows[0].report_date).isoformat() if rows else None,
            "completed_on": done_on.isoformat() if done_on else None,
            "late_days": max(0, (done_on - due).days) if done_on else (max(0, (today - due).days) if state in ("In progress", "Missed") else 0),
        })
    last = monthrange(first.year, first.month)[1]
    return {
        "plant_id": str(plant.id), "plant": plant.plant_name, "site_code": plant.site_code, "month": month,
        "first_day": first.isoformat(), "last_day": first.replace(day=last).isoformat(), "table_count": table_count,
        "cycles": cycles, "pattern": _pattern_out(config), "can_edit": manager,
        "summary": _month_wash_summary(month_reports, table_count),
        # every report of the month (rejected ones included) so the cycle sheet can show each day on one row
        "reports": [_report_out(r, plant, user, config, manager, table_count) for r in month_reports],
        "today": today.isoformat(),
    }


def recount_month(db: Session, user: User, plant_id: UUID, month: str) -> dict:
    """O&M Head / washing Assignee: re-number a month's days by table completion (_cycle_sequence). Fixes months saved
    before days moved with their edits, e.g. a day changed to 40 tables that still counted in an already full cycle."""
    if not _is_washing_manager(db, user):
        raise HTTPException(403, "Only the O&M Head or the washing Assignee can recount washing cycles")
    plant = _plant_for_id(db, plant_id)
    config = db.scalar(select(WashingConfig).where(WashingConfig.plant_id == plant.id).with_for_update())
    if not config:
        raise HTTPException(409, "Washing has not been set up for this plant")
    _parse_month(month)
    rollover_splits, touched = _split_legacy_rollover_reports(
        db, plant, month, _plant_table_count(db, plant.id, config), user,
    )
    moved = _resequence_month(db, plant.id, month, _plant_table_count(db, plant.id, config))
    _audit_moves(db, user, plant, month, moved, "recount")
    if touched:
        _assert_distinct_tables(db, plant.id, [month], _plant_table_count(db, plant.id, config), touched)
    db.commit()
    invalidate_overview_cache()
    return {**month_cycles(db, user, plant.id, month), "moved": moved, "rollover_splits": rollover_splits}


def save_cycle_schedule(db: Session, user: User, plant_id: UUID, payload) -> dict:
    """Save all three cycles of one month at once. Any day of that month can be used (past months too).
    With apply_to_future the same days of the month become the plant's pattern from that month on."""
    if not _is_washing_manager(db, user):
        raise HTTPException(403, "Only the O&M Head or the washing Assignee can change washing cycle dates")
    plant = _plant_for_id(db, plant_id)
    config = db.scalar(select(WashingConfig).where(WashingConfig.plant_id == plant.id).with_for_update())
    if not config:
        raise HTTPException(409, "Washing has not been set up for this plant")
    first = _parse_month(payload.month)
    last = first.replace(day=monthrange(first.year, first.month)[1])
    rows = sorted(payload.cycles, key=lambda c: c.cycle_no)
    if [c.cycle_no for c in rows] != list(range(1, MONTHLY_CYCLE_TARGET + 1)):
        raise HTTPException(422, "Send all three cycles (1, 2 and 3)")
    for c in rows:
        for label, value in (("start", c.start_date), ("deadline", c.due_date)):
            if not (first <= value <= last):
                raise HTTPException(422, f"Cycle {c.cycle_no} {label} must be between {first.isoformat()} and {last.isoformat()}")
        if c.start_date > c.due_date:
            raise HTTPException(422, f"Cycle {c.cycle_no} cannot start after its deadline")
    for before, after in zip(rows, rows[1:]):
        if after.start_date < before.start_date or after.due_date < before.due_date:
            raise HTTPException(422, f"Cycle {after.cycle_no} must start and end on or after cycle {before.cycle_no}")
    overrides = {k: (dict(v) if isinstance(v, dict) else v) for k, v in (config.cycle_overrides or {}).items()}
    previous_month, previous_pattern = overrides.get(payload.month), overrides.get(PATTERN_KEY)
    month_map: dict = {}
    for c in rows:
        month_map[f"s{c.cycle_no}"] = c.start_date.isoformat()
        month_map[str(c.cycle_no)] = c.due_date.isoformat()
    overrides[payload.month] = month_map
    if payload.apply_to_future:
        overrides[PATTERN_KEY] = {"from": payload.month, "days": {**{f"s{c.cycle_no}": c.start_date.day for c in rows},
                                                                 **{str(c.cycle_no): c.due_date.day for c in rows}}}
        # later months follow the new pattern instead of older one-off dates
        for key in [k for k in overrides if k != PATTERN_KEY and k > payload.month]:
            overrides.pop(key, None)
    config.cycle_overrides = overrides
    db.add(config)
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name, action="Saved washing cycle schedule", module="Washing",
        entity_type="plant", entity_id=plant.site_code,
        metadata_json={"month": payload.month, "from": previous_month, "to": month_map, "apply_to_future": payload.apply_to_future,
                       "previous_pattern": previous_pattern},
    ))
    db.commit()
    invalidate_overview_cache()
    return month_cycles(db, user, plant.id, payload.month)


def review_daily_report(db: Session, user: User, report_id: UUID, payload: WashingReportReviewRequest) -> dict:
    report = db.scalar(select(WashingDailyReport).where(WashingDailyReport.id == report_id).with_for_update())
    if not report:
        raise HTTPException(404, "Daily washing report not found")
    plant = _plant_for_id(db, report.plant_id)
    config = db.scalar(select(WashingConfig).where(WashingConfig.plant_id == plant.id).with_for_update())
    if not _can_review_washing(user, config):
        raise HTTPException(403, "Only the O&M Head or the configured washing Assignee for this plant can review its reports")
    if report.reported_by_id == user.id:
        raise HTTPException(403, "A washing report must be confirmed by someone other than its submitter")
    if report.review_status != "Pending":
        raise HTTPException(409, "This washing report has already been reviewed")
    total_tables = _plant_table_count(db, plant.id, config)
    if payload.decision == "Confirm":
        missing = _missing_photo_kinds(report, total_tables)
        if missing:
            raise HTTPException(409, f"Upload {' and '.join(missing)} cleaning photo evidence before confirming this report")
    if payload.decision == "Confirm":
        report.review_status = "Confirmed"
    else:
        report.review_status = "Rejected"
    report.reviewed_by_id = user.id
    report.reviewed_by = user.display_name
    report.reviewed_at = datetime.now(timezone.utc)
    report.review_note = (payload.remarks or "").strip() or None
    db.add(report)
    db.flush()
    # A confirmation can complete a cycle; a rejection empties the day, so the days after it may move back a cycle.
    done_before = _completed_cycles(db, plant.id, report.cycle_month)
    moved = _resequence_month(db, plant.id, report.cycle_month, total_tables)
    _audit_moves(db, user, plant, report.cycle_month, moved, f"{report.report_date.isoformat()} {report.review_status.lower()}")
    cycle_completed = report.cycle_no in (_completed_cycles(db, plant.id, report.cycle_month) - done_before)

    db.add(report)
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name, action="Reviewed daily washing report",
        module="Washing", entity_type="washing_daily_report", entity_id=str(report.id),
        metadata_json={"decision": report.review_status, "cycle_month": report.cycle_month, "cycle_no": report.cycle_no, "cycle_completed": cycle_completed},
    ))
    _notify_wash(
        db, plant, config,
        event_type="washing_report_reviewed",
        title=f"Washing report {report.review_status.lower()} — Cycle {report.cycle_no}",
        message=f"{report.tables_cleaned} table(s) · {report.reviewed_by}" + (f" · {report.review_note}" if report.review_note else ""),
        dedupe_key=f"washing-report-reviewed:{report.id}:{report.review_status}",
        extra_user_ids=[report.reported_by_id] if report.reported_by_id else [],
    )
    db.flush()
    if cycle_completed:
        cycles_completed = len(list(db.scalars(
            select(WashingDailyReport.cycle_no).where(
                WashingDailyReport.plant_id == plant.id,
                WashingDailyReport.cycle_month == report.cycle_month,
                WashingDailyReport.cycle_completed.is_(True),
                WashingDailyReport.review_status == "Confirmed",
            ).distinct()
        )))
        _notify_wash(
            db, plant, config,
            event_type="washing_cycle_completed",
            title=f"Washing cycle completed — Cycle {report.cycle_no}",
            message=(f"All {total_tables} tables are confirmed clean. {cycles_completed} of {MONTHLY_CYCLE_TARGET} monthly cycles completed. "
                     + (f"Cycle {report.cycle_no + 1} starts now." if report.cycle_no < MONTHLY_CYCLE_TARGET else "All monthly cycles are done.")),
            dedupe_key=f"washing-cycle-completed:{plant.id}:{report.cycle_month}:{report.cycle_no}",
            extra_user_ids=[report.reported_by_id] if report.reported_by_id else [],
        )
    db.commit()
    return _report_out(report, plant, user, config, True, total_tables)


def confirm_sheet_reports(db: Session, user: User, payload: WashingBulkConfirmRequest) -> dict:
    """Confirm several pending days of one plant at once (all or nothing), with the same rules as a single
    confirmation: only the O&M Head or the plant's washing Assignee, never one's own report, photos where required.
    Sends one summary notification instead of one per day."""
    plant = _plant_for_id(db, payload.plant_id)
    ids = list(dict.fromkeys(payload.report_ids))
    # Lock order matches single review/edit (reports, then the plant's config) so concurrent requests cannot deadlock.
    reports = list(db.scalars(select(WashingDailyReport).where(
        WashingDailyReport.id.in_(ids), WashingDailyReport.plant_id == plant.id,
    ).order_by(WashingDailyReport.id).with_for_update()))
    config = db.scalar(select(WashingConfig).where(WashingConfig.plant_id == plant.id).with_for_update())
    if not _can_review_washing(user, config):
        raise HTTPException(403, "Only the O&M Head or the configured washing Assignee for this plant can review its reports")
    if len(reports) != len(ids):
        raise HTTPException(404, "Some of these washing reports were not found for this plant")
    reports.sort(key=lambda report: (report.report_date, report.created_at or datetime.min.replace(tzinfo=timezone.utc)))
    if any(report.reported_by_id == user.id for report in reports):
        raise HTTPException(403, "A washing report must be confirmed by someone other than its submitter")
    reviewed = [report for report in reports if report.review_status != "Pending"]
    if reviewed:
        raise HTTPException(409, "Already reviewed: " + ", ".join(_day_label(report.report_date) for report in reviewed) + ". Refresh and try again.")
    total_tables = _plant_table_count(db, plant.id, config)
    missing = [report for report in reports if _missing_photo_kinds(report, total_tables)]
    if missing:
        raise HTTPException(409, "Upload before and after photos first for " + ", ".join(_day_label(report.report_date) for report in missing))

    already_done = set(db.execute(select(WashingDailyReport.cycle_month, WashingDailyReport.cycle_no).where(
        WashingDailyReport.plant_id == plant.id,
        WashingDailyReport.cycle_completed.is_(True),
        WashingDailyReport.review_status == "Confirmed",
    )).tuples())
    note = (payload.remarks or "").strip() or None
    now = datetime.now(timezone.utc)
    for report in reports:
        report.review_status = "Confirmed"
        report.reviewed_by_id = user.id
        report.reviewed_by = user.display_name
        report.reviewed_at = now
        report.review_note = note
        db.add(AuditLog(
            user_id=user.id, actor_name=user.display_name, action="Reviewed daily washing report",
            module="Washing", entity_type="washing_daily_report", entity_id=str(report.id),
            metadata_json={"decision": "Confirmed", "bulk": True, "cycle_month": report.cycle_month, "cycle_no": report.cycle_no},
        ))
    db.flush()
    done_now: set[tuple[str, int]] = set()
    for month in sorted({report.cycle_month for report in reports}):
        _audit_moves(db, user, plant, month, _resequence_month(db, plant.id, month, total_tables), "days confirmed")
        done_now |= {(month, n) for n in _completed_cycles(db, plant.id, month)}
    completed = sorted(done_now - already_done)

    reporters = list(dict.fromkeys(report.reported_by_id for report in reports if report.reported_by_id))
    tables = sum(report.tables_cleaned for report in reports)
    span = _day_label(reports[0].report_date) if len(reports) == 1 else f"{_day_label(reports[0].report_date)} – {_day_label(reports[-1].report_date)}"
    _notify_wash(
        db, plant, config,
        event_type="washing_report_reviewed",
        title=f"Washing confirmed — {len(reports)} day{'s' if len(reports) != 1 else ''}",
        message=f"{span} · {tables} table(s) · {user.display_name}" + (f" · {note}" if note else ""),
        dedupe_key=f"washing-sheet-confirmed:{reports[0].id}:{len(reports)}",
        extra_user_ids=reporters,
    )
    for month, cycle_no in completed:
        done_count = len(set(db.scalars(select(WashingDailyReport.cycle_no).where(
            WashingDailyReport.plant_id == plant.id,
            WashingDailyReport.cycle_month == month,
            WashingDailyReport.cycle_completed.is_(True),
            WashingDailyReport.review_status == "Confirmed",
        ))))
        _notify_wash(
            db, plant, config,
            event_type="washing_cycle_completed",
            title=f"Washing cycle completed — Cycle {cycle_no}",
            message=(f"All {total_tables} tables are confirmed clean. {done_count} of {MONTHLY_CYCLE_TARGET} monthly cycles completed. "
                     + (f"Cycle {cycle_no + 1} starts now." if cycle_no < MONTHLY_CYCLE_TARGET else "All monthly cycles are done.")),
            dedupe_key=f"washing-cycle-completed:{plant.id}:{month}:{cycle_no}",
            extra_user_ids=reporters,
        )
    db.commit()
    return {
        "confirmed": len(reports),
        "cycles_completed": [{"cycle_month": month, "cycle_no": cycle_no} for month, cycle_no in completed],
        "reports": [_report_out(report, plant, user, config, True, total_tables) for report in reports],
    }


def check_missed_monthly_targets(db: Session, today: date | None = None) -> int:
    current = today or business_today()
    if current.day != 1:
        return 0
    previous = current.replace(day=1) - timedelta(days=1)
    month = _month_key(previous)
    notified = 0
    for config in db.scalars(select(WashingConfig).with_for_update()):
        if not config.active:
            continue
        plant = db.get(Plant, config.plant_id)
        total_tables = _plant_table_count(db, config.plant_id, config)
        if not plant or not total_tables:
            continue
        completed = len(list(db.scalars(
            select(WashingDailyReport.cycle_no).where(
                WashingDailyReport.plant_id == plant.id,
                WashingDailyReport.cycle_month == month,
                WashingDailyReport.cycle_completed.is_(True),
                WashingDailyReport.review_status == "Confirmed",
            ).distinct()
        )))
        if completed >= MONTHLY_CYCLE_TARGET:
            continue
        dedupe_key = f"washing-monthly-target:{plant.id}:{month}"
        existed = db.scalar(select(Notification.id).where(or_(Notification.dedupe_key == dedupe_key, Notification.dedupe_key.like(dedupe_key + ":%"))).limit(1))
        if existed:
            continue
        _notify_wash(
            db, plant, config,
            event_type="washing_monthly_target_missed",
            title=f"Monthly washing target missed — {month}",
            message=f"Completed {completed} of {MONTHLY_CYCLE_TARGET} required cycles for {month}; the next cycle continues normally.",
            dedupe_key=dedupe_key,
            managers_only=True,  # performance metric: O&M team only
        )
        notified += 1
    if notified:
        db.commit()
    else:
        db.rollback()
    return notified


def check_cycle_compliance_alerts(db: Session, today: date | None = None) -> int:
    """Once per cycle and plant: when a cycle's planned window has ended (day 10, 20, month end, or the dates the
    O&M team set) with compliance below the plant's target, the O&M Head and washing Assignees are told
    (_cycle_compliance; never Site Engineers). Looks back 3 days so a missed daily run still sends it."""
    current = today or business_today()
    notified = 0
    patterns = _reason_patterns(excused_reasons(db))
    for config in db.scalars(select(WashingConfig).with_for_update()):
        if not config.active:
            continue
        plant = db.get(Plant, config.plant_id)
        total_tables = _plant_table_count(db, config.plant_id, config)
        if not plant or not total_tables:
            continue
        for back in range(1, 4):
            ended = current - timedelta(days=back)
            window = next(((n, start, end) for n, (start, end) in enumerate(_cycle_windows(ended, config.cycle_overrides), 1)
                           if end == ended), None)
            if window is None:
                continue
            n, start, end = window
            month = _month_key(end)
            dedupe_key = f"washing-cycle-compliance:{plant.id}:{month}:{n}"
            if db.scalar(select(Notification.id).where(Notification.dedupe_key.like(dedupe_key + "%")).limit(1)):
                continue
            month_reports = list(db.scalars(select(WashingDailyReport).where(
                WashingDailyReport.plant_id == plant.id, WashingDailyReport.cycle_month == month)))
            compliance = _cycle_compliance(total_tables, end, config.cycle_overrides, _cycle_ledger(month_reports, total_tables),
                                           _excused_dates(month_reports, patterns), window)
            if compliance["percent"] >= config.compliance_threshold_percent:
                continue
            _notify_wash(
                db, plant, config,
                event_type="washing_cycle_compliance_low",
                title=f"Washing compliance below target — Cycle {n} ({_day_label(start)}–{_day_label(end)})",
                message=(f"Cycle {n} ended with {compliance['done']} of {compliance['due']} tables done ({compliance['percent']}%) "
                         f"against the {config.compliance_threshold_percent}% target."),
                dedupe_key=dedupe_key,
                managers_only=True,  # performance metric: O&M Head and washing Assignees only
            )
            notified += 1
    if notified:
        db.commit()
    else:
        db.rollback()
    return notified


def check_washing_overdue(db: Session, today: date | None = None) -> int:
    """Alert when a plant is behind the month's cycle deadlines: once at 1, 3 and 7 days late (each level only once)."""
    current = today or business_today()
    month = _month_key(current)
    notified = 0
    for config in db.scalars(select(WashingConfig).with_for_update()):
        if not config.active:
            continue
        plant = db.get(Plant, config.plant_id)
        total_tables = _plant_table_count(db, config.plant_id, config)
        if not plant or not total_tables:
            continue
        completed = len(set(db.scalars(
            select(WashingDailyReport.cycle_no).where(
                WashingDailyReport.plant_id == plant.id,
                WashingDailyReport.cycle_month == month,
                WashingDailyReport.cycle_completed.is_(True),
                WashingDailyReport.review_status == "Confirmed",
            )
        )))
        info = _overdue_info(completed, current, _cycle_due_dates(current, config.cycle_overrides))
        days = info["overdue_days"]
        if days < 1:
            continue
        level = 7 if days >= 7 else 3 if days >= 3 else 1
        dedupe_key = f"washing-overdue:{plant.id}:{month}:{info['overdue_cycle']}:{level}"
        recipients = _wash_recipients(db, config, managers_only=True)
        if not recipients:
            continue
        if db.scalar(select(Notification.id).where(
            Notification.dedupe_key.like(dedupe_key + ":%")
        ).limit(1)):
            continue
        _notify_wash(
            db, plant, config,
            event_type="washing_overdue",
            title=f"Washing overdue {days} day{'s' if days != 1 else ''} — Cycle {info['overdue_cycle']}",
            message=f"Cycle {info['overdue_cycle']} was due on {info['next_due']}; {completed} of {MONTHLY_CYCLE_TARGET} monthly cycles are complete.",
            dedupe_key=dedupe_key,
            managers_only=True,  # performance metric: O&M team only
        )
        notified += 1
    if notified:
        db.commit()
    else:
        db.rollback()
    return notified