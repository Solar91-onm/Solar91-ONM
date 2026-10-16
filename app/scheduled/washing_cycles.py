from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
import uuid
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.models import AuditLog, Notification, Plant, User, UserEquipmentTypeAssignment, WashingConfig, WashingDailyReport, WashingHistory, WashingTable
from app.core.security import WASHING_TYPE, assignee_has_type, user_scoped_plant_ids
from app.notifications.service import notify_users, users_with_role
from app.scheduled.schemas import (
    WashingCycleDateRequest,
    WashingDailyReportRequest,
    WashingReportReviewRequest,
    WashingReportUpdateRequest,
    WashingSetupRequest,
)

MONTHLY_CYCLE_TARGET = 3
MAX_BACKDATE_DAYS = 45  # how far back a Site Engineer may enter a missed report
OVERVIEW_REPORT_DAYS = 90  # the overview sends reports from the last 90 days (plus every report still awaiting review)
OVERVIEW_CACHE_SECONDS = 20
OVERVIEW_SEND_REPORT_DAYS = 35  # reports sent to the browser by default (this month + a little); ?report_days=90 sends the full window
_OVERVIEW_CACHE: dict[tuple, tuple[float, dict]] = {}
_OVERVIEW_VERSION = 0


def invalidate_overview_cache() -> None:
    """Called after every write request, so a user always sees their own change straight away."""
    global _OVERVIEW_VERSION
    _OVERVIEW_VERSION += 1
    _OVERVIEW_CACHE.clear()


def _month_key(value: date) -> str:
    return value.strftime("%Y-%m")


def _daily_table_target(table_count: int, value: date, overrides: dict | None = None) -> int:
    """Tables due on `value`. Default cycles are days 1-10, 11-20 and 21-month end; when the O&M team moved a
    cycle's start or deadline (`overrides`), the day's share is spread over that cycle's own window instead."""
    if overrides and (overrides.get(_month_key(value)) or {}):
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
    for key, raw in ((overrides or {}).get(_month_key(value)) or {}).items():
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
    for key, raw in ((overrides or {}).get(_month_key(value)) or {}).items():
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
    """O&M team = O&M Head, or any active Assignee holding the Modules cleaning scope (several Assignees allowed).
    They may manage portfolio setup, compliance and ranking across plants. Daily report review is
    restricted separately to the configured Assignee for that plant or an O&M Head.
    Site Engineers are never managers: they only report the tables they cleaned on their own plant."""
    if user.role == "O&M Head":
        return True
    return user.role == "Assignee" and bool(user.is_active) and assignee_has_type(db, user, WASHING_TYPE)


def _can_review_washing(user: User, config: WashingConfig | None) -> bool:
    """Only the O&M Head or the configured, active washing assignee can approve this plant.

    Other Assignees with Modules cleaning scope retain portfolio visibility but cannot
    approve a report on a plant that was assigned to a different person.
    """
    return bool(user.is_active and (
        user.role == "O&M Head" or
        (user.role == "Assignee" and config is not None and config.assigned_user_id == user.id)
    ))


def _can_add_washing_evidence(user: User, report: WashingDailyReport, config: WashingConfig | None) -> bool:
    """Before/after photos may be added while a report is Pending by its submitter (Site Engineer) or by the
    O&M Head / this plant's configured washing Assignee, who also confirm the report."""
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
        if assignee.is_active and assignee_has_type(db, assignee, WASHING_TYPE):
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


def _report_out(report: WashingDailyReport, plant: Plant, viewer: User, config: WashingConfig, manager: bool = False) -> dict:
    can_review = report.review_status == "Pending" and report.reported_by_id != viewer.id and _can_review_washing(viewer, config)
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
        "remarks": report.remarks,
        "exception_reason": report.exception_reason,
        "evidence": [
            {**{key: value for key, value in entry.items() if key != "storage_path"},
             "url": f"/api/scheduled/washing/daily-reports/{report.id}/evidence/{entry.get('id')}"}
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
        "can_edit": manager or (report.reported_by_id == viewer.id and report.review_status in ("Pending", "Rejected")),
        "can_delete": manager or (report.reported_by_id == viewer.id and report.review_status in ("Pending", "Rejected")),
        "has_before": any(e.get("kind") == "before" for e in (report.evidence or []) if isinstance(e, dict)),
        "has_after": any(e.get("kind") == "after" for e in (report.evidence or []) if isinstance(e, dict)),
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


def _ensure_washing_assignee(db: Session, user: User, assignee: User) -> None:
    if not assignee.is_active or assignee.role != "Assignee":
        raise HTTPException(422, "Choose an active Assignee")
    if not assignee_has_type(db, assignee, WASHING_TYPE):
        db.add(UserEquipmentTypeAssignment(user_id=assignee.id, equipment_type=WASHING_TYPE))
        db.add(AuditLog(
            user_id=user.id,
            actor_name=user.display_name,
            action="Equipment scope added while setting up plant washing",
            module="Washing",
            entity_type="user",
            entity_id=str(assignee.id),
            metadata_json={"equipment_type": WASHING_TYPE, "assignee": assignee.display_name},
        ))


def setup_plant(db: Session, user: User, payload: WashingSetupRequest) -> dict:
    if not _is_washing_manager(db, user):
        raise HTTPException(403, "Only the O&M team (O&M Head or a washing Assignee) can set up plant washing")
    plant = _plant_for_id(db, payload.plant_id)
    assignee = db.get(User, payload.assignee_user_id)
    if not assignee:
        raise HTTPException(422, "Choose an active Assignee")
    _ensure_washing_assignee(db, user, assignee)

    config = db.scalar(select(WashingConfig).where(WashingConfig.plant_id == plant.id).with_for_update())
    if not config:
        config = WashingConfig(plant_id=plant.id, team=[], frequency_days=14)
    config.assigned_user_id = assignee.id
    config.compliance_threshold_percent = payload.compliance_threshold_percent
    db.add(config)
    table_count = _set_table_count(db, plant, payload.table_count)

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
    }


def list_assignees(db: Session, user: User) -> list[dict]:
    """Every active user with the Assignee role (from the database), with whether they already hold the washing scope."""
    if not _is_washing_manager(db, user):
        raise HTTPException(403, "Only the O&M team can assign plant washing")
    users = db.execute(
        select(User.id, User.display_name).where(User.role == "Assignee", User.is_active.is_(True)).order_by(User.display_name)
    ).all()
    scoped = set(db.scalars(
        select(UserEquipmentTypeAssignment.user_id).where(func.lower(UserEquipmentTypeAssignment.equipment_type) == WASHING_TYPE.casefold())
    ))
    return [{"id": str(user_id), "name": name, "has_washing_scope": user_id in scoped} for user_id, name in users]


def get_overview(db: Session, user: User, include_tables: bool = False, report_days: int = OVERVIEW_SEND_REPORT_DAYS) -> dict:
    report_days = max(1, min(int(report_days), OVERVIEW_REPORT_DAYS))
    ttl = 0 if get_settings().app_env == "test" else OVERVIEW_CACHE_SECONDS
    if ttl <= 0:
        return _build_overview(db, user, include_tables, report_days)
    key = (str(user.id), user.role, include_tables, report_days, date.today().isoformat())
    hit = _OVERVIEW_CACHE.get(key)
    if hit and datetime.now(timezone.utc).timestamp() - hit[0] < ttl:
        return hit[1]
    version = _OVERVIEW_VERSION
    result = _build_overview(db, user, include_tables, report_days)
    if version == _OVERVIEW_VERSION:  # no write happened while this was being built
        if len(_OVERVIEW_CACHE) > 50:
            _OVERVIEW_CACHE.clear()
        _OVERVIEW_CACHE[key] = (datetime.now(timezone.utc).timestamp(), result)
    return result


def _build_overview(db: Session, user: User, include_tables: bool = False, report_days: int = OVERVIEW_SEND_REPORT_DAYS) -> dict:
    manager = _is_washing_manager(db, user)
    configs = list(db.scalars(select(WashingConfig)))
    configured_ids = [config.plant_id for config in configs]
    plants_by_id = {
        plant.id: plant for plant in db.scalars(select(Plant).where(Plant.id.in_(configured_ids)))
    } if configured_ids else {}
    allowed_plant_ids = user_scoped_plant_ids(db, user) or set() if user.role == "Site Engineer" else set()
    visible_configs = [
        (plants_by_id[config.plant_id], config)
        for config in configs
        if config.plant_id in plants_by_id
        and (manager or (user.role == "Site Engineer" and config.plant_id in allowed_plant_ids))
    ]
    visible_ids = [plant.id for plant, _config in visible_configs]
    table_counts: dict[UUID, int] = {}
    codes_by_plant: dict[UUID, list[str]] = {}
    reports_by_plant: dict[UUID, list[WashingDailyReport]] = {}
    last_report_by_plant: dict[UUID, date] = {}
    if visible_ids:
        # Only a count per plant (thousands of table rows are no longer loaded on every call).
        table_counts = {
            plant_id: count for plant_id, count in db.execute(
                select(WashingTable.plant_id, func.count(WashingTable.id))
                .where(WashingTable.plant_id.in_(visible_ids)).group_by(WashingTable.plant_id)
            ).all()
        }
        if include_tables:
            for plant_id, code, legacy_id in db.execute(
                select(WashingTable.plant_id, WashingTable.table_code, WashingTable.legacy_id)
                .where(WashingTable.plant_id.in_(visible_ids))
                .order_by(WashingTable.plant_id, WashingTable.table_code)
            ).all():
                codes_by_plant.setdefault(plant_id, []).append(code or legacy_id)
        report_cutoff = date.today() - timedelta(days=OVERVIEW_REPORT_DAYS)
        for report in db.scalars(
            select(WashingDailyReport).where(
                WashingDailyReport.plant_id.in_(visible_ids),
                or_(WashingDailyReport.report_date >= report_cutoff, WashingDailyReport.review_status == "Pending"),
            )
            .order_by(WashingDailyReport.plant_id, WashingDailyReport.report_date.desc(), WashingDailyReport.created_at.desc())
        ):
            reports_by_plant.setdefault(report.plant_id, []).append(report)
        last_report_by_plant = {
            plant_id: last for plant_id, last in db.execute(
                select(WashingDailyReport.plant_id, func.max(WashingDailyReport.report_date))
                .where(WashingDailyReport.plant_id.in_(visible_ids)).group_by(WashingDailyReport.plant_id)
            ).all()
        }
    assignee_ids = {config.assigned_user_id for _plant, config in visible_configs if config.assigned_user_id}
    assignee_names = {
        assignee.id: assignee.display_name
        for assignee in db.scalars(select(User).where(User.id.in_(assignee_ids)))
    } if assignee_ids else {}
    visible: list[tuple[Plant, WashingConfig, int, list[WashingDailyReport]]] = []
    for plant, config in visible_configs:
        table_count = table_counts.get(plant.id, 0)
        if table_count:
            visible.append((plant, config, table_count, reports_by_plant.get(plant.id, [])))

    today = date.today()
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
    monthly_out = []
    cycle_events_all: list[dict] = []
    for plant, config, table_count, reports in visible:
        completed_by_month: dict[str, set[int]] = {}
        for report in reports:
            if report.cycle_completed and report.review_status == "Confirmed":
                completed_by_month.setdefault(report.cycle_month, set()).add(report.cycle_no)
        cycles_this_month = len(completed_by_month.get(month, set()))
        current_cycle = min(MONTHLY_CYCLE_TARGET, cycles_this_month + 1)
        current_reports = [
            report for report in reports
            if report.cycle_month == month and report.cycle_no == current_cycle
        ]
        cleaned_confirmed = sum(
            report.tables_cleaned for report in current_reports if report.review_status == "Confirmed"
        )
        cleaned_pending = sum(
            report.tables_cleaned for report in current_reports if report.review_status == "Pending"
        )
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
        excused_dates = {
            report.report_date for report in reports
            if report.exception_reason and report.review_status == "Confirmed"
        }
        productivity: dict[str, int] = {}
        daily_productivity: list[dict] = []
        week_start = today - timedelta(days=6)
        for report in reports:
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
        due_by_today = min(MONTHLY_CYCLE_TARGET, (today.day - 1) // 10 + 1)
        completed_due = sum(1 for cycle_no in completed_dates if cycle_no <= due_by_today)
        today_target = _daily_table_target(table_count, today, config.cycle_overrides)
        weekly_due = sum(
            _daily_table_target(table_count, week_start + timedelta(days=offset), config.cycle_overrides)
            for offset in range(7)
            if week_start + timedelta(days=offset) <= today
            and week_start + timedelta(days=offset) not in excused_dates
        )
        weekly_washed = sum(
            report.tables_cleaned for report in reports
            if week_start <= report.report_date <= today and report.review_status == "Confirmed"
        )
        due_dates = _cycle_due_dates(today, config.cycle_overrides)
        start_dates = _cycle_start_dates(today, config.cycle_overrides)
        delays = [
            max(0, (completed_on - due_dates[min(cycle_no - 1, 2)]).days)
            for cycle_no, completed_on in completed_dates.items()
        ]
        overdue = _overdue_info(cycles_this_month, today, due_dates)
        if not config.active:
            overdue.update({"overdue_days": 0, "overdue_bucket": "on_track", "overdue_cycle": None})
        day_reports: dict[date, list[WashingDailyReport]] = {}
        for report in reports:
            if report.report_date.year == today.year and report.report_date.month == today.month:
                day_reports.setdefault(report.report_date, []).append(report)
        daily_status = []
        for offset in range(today.day):
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
        for cycle_no in range(1, MONTHLY_CYCLE_TARGET + 1):
            cycle_reports = [r for r in reports if r.cycle_month == month and r.cycle_no == cycle_no and r.review_status in ("Pending", "Confirmed")]
            done_on = completed_dates.get(cycle_no)
            started_on = min((r.report_date for r in cycle_reports), default=None)
            state = "Completed" if done_on else ("In progress" if cycle_no == current_cycle and cycles_this_month < MONTHLY_CYCLE_TARGET else "Upcoming")
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
                "confirmed": sum(r.tables_cleaned for r in cycle_reports if r.review_status == "Confirmed"),
                "pending": sum(r.tables_cleaned for r in cycle_reports if r.review_status == "Pending"),
                "late_days": max(0, (done_on - due).days) if done_on else (max(0, (today - due).days) if state != "Upcoming" else 0),
            })
        for report in reports:
            if report.cycle_completed and report.review_status == "Confirmed":
                cycle_events_all.append({
                    "plant_id": str(plant.id), "plant": plant.plant_name, "site_code": plant.site_code,
                    "cycle_month": report.cycle_month, "cycle_no": report.cycle_no,
                    "completed_on": report.report_date.isoformat(),
                    "next_cycle": report.cycle_no + 1 if report.cycle_no < MONTHLY_CYCLE_TARGET else None,
                })
        plant_rows.append({
            **overdue,
            "cycles": cycle_rows,
            "daily_status": daily_status,
            "last_report_date": last_report_by_plant[plant.id].isoformat() if last_report_by_plant.get(plant.id) else None,
            "plant_id": str(plant.id),
            "plant": plant.plant_name,
            "site_code": plant.site_code,
            "table_count": table_count,
            "active": config.active,
            "notes": config.notes,
            "district": plant.district,
            "location": plant.location,
            "assignee_user_id": str(config.assigned_user_id) if config.assigned_user_id else None,
            "assignee_name": assignee_names.get(config.assigned_user_id),
            "cycles_this_month": cycles_this_month,
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
            "monthly_compliance_percent": round(100 * completed_due / due_by_today) if due_by_today else 100,
            "weekly_compliance_percent": min(100, round(100 * weekly_washed / weekly_due)) if weekly_due else 100,
            "average_delay_days": round(sum(delays) / len(delays), 1) if delays else 0,
            "exceptions_this_month": sum(1 for report in reports if report.cycle_month == month and report.exception_reason),
            "productivity": [{"person": person, "tables": count} for person, count in sorted(productivity.items())],
            "daily_productivity": sorted(daily_productivity, key=lambda row: (row["date"], row["person"])),
            "compliance_threshold_percent": config.compliance_threshold_percent,
        })
        if include_tables:
            plant_rows[-1]["table_codes"] = table_codes
            plant_rows[-1]["table_health"] = table_health
        # Every report still feeds the figures above; only recent ones (and any awaiting review) are sent to the browser.
        for report in reports:
            if report.report_date >= send_cutoff or report.review_status == "Pending":
                reports_out.append(_report_out(report, plant, user, config, manager))

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
    ).all() if visible else []
    completed_lookup = {(plant_id, month): count for plant_id, month, count in completed_rows}
    for plant, _config, _tables, _reports in visible:
        for key in month_keys:
            monthly_out.append({
                "plant_id": str(plant.id),
                "plant": plant.plant_name,
                "month": key,
                "cycles": completed_lookup.get((plant.id, key), 0),
            })
    result = {
        "today": today.isoformat(),
        "viewer_user_id": str(user.id),
        "monthly_target": MONTHLY_CYCLE_TARGET,
        "plants": plant_rows,
        "reports": reports_out,
        "monthly": monthly_out,
        "portfolio": {
            "tables_due_today": sum(row["tables_due_today"] for row in plant_rows),
            "tables_washed_today": sum(row["tables_washed_today"] for row in plant_rows),
            "tables_pending_today": sum(row["tables_pending_today"] for row in plant_rows),
            "monthly_compliance_percent": round(
                sum(row["monthly_compliance_percent"] for row in plant_rows) / len(plant_rows)
            ) if plant_rows else 100,
            "weekly_compliance_percent": round(
                sum(row["weekly_compliance_percent"] for row in plant_rows) / len(plant_rows)
            ) if plant_rows else 100,
            "average_delay_days": round(
                sum(row["average_delay_days"] for row in plant_rows) / len(plant_rows), 1
            ) if plant_rows else 0,
        },
    }
    configured_ids = {plant.id for plant, _config, _tables, _reports in visible}
    if manager:
        pool = list(db.scalars(select(Plant).order_by(Plant.plant_name)))
    elif user.role == "Site Engineer":
        scoped = user_scoped_plant_ids(db, user) or set()
        pool = list(db.scalars(select(Plant).where(Plant.id.in_(scoped)).order_by(Plant.plant_name))) if scoped else []
    else:
        pool = []
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
        "plants_below_threshold": sum(1 for row in plant_rows if row["active"] and row["weekly_compliance_percent"] < row["compliance_threshold_percent"]),
        "not_set_up": len(result["unconfigured"]),
        "pending_reviews": sum(1 for report in reports_out if report["review_status"] == "Pending"),
    })
    if not manager:
        # Compliance / delay / ranking figures are O&M performance metrics; field users never receive them.
        hidden = ("weekly_compliance_percent", "monthly_compliance_percent", "daily_compliance_percent", "average_delay_days",
                  "compliance_threshold_percent", "overdue_days", "overdue_bucket", "overdue_cycle", "productivity",
                  "daily_productivity", "exceptions_this_month", "tables_due_today", "tables_pending_today")
        for row in result["plants"]:
            for key in hidden:
                row.pop(key, None)
            for cycle in row.get("cycles", []):
                cycle.pop("late_days", None)
            for day in row.get("daily_status", []):
                day.pop("target", None)
        result["overdue_matrix"] = {"on_track": 0, "1d": 0, "3d": 0, "7d": 0}
        for key in ("weekly_compliance_percent", "plants_overdue", "plants_below_threshold", "tables_due_today"):
            result["portfolio"].pop(key, None)
    return result


def _refresh_cycle_completion(db: Session, plant_id: UUID, month: str, cycle_no: int, total_tables: int) -> bool:
    """A cycle is complete once confirmed tables reach the plant's table count. The report on which the running
    total first reaches that count carries the completion flag (its date is the cycle's completion date)."""
    rows = list(db.scalars(select(WashingDailyReport).where(
        WashingDailyReport.plant_id == plant_id,
        WashingDailyReport.cycle_month == month,
        WashingDailyReport.cycle_no == cycle_no,
        WashingDailyReport.review_status == "Confirmed",
    ).order_by(WashingDailyReport.report_date, WashingDailyReport.created_at)))
    for row in rows:
        row.cycle_completed = False
    done = False
    running = 0
    for row in rows:
        running += row.tables_cleaned
        if total_tables > 0 and running >= total_tables:
            row.cycle_completed = True
            done = True
            break
    db.flush()
    return done


def _ordered_codes(db: Session, plant_id: UUID) -> list[str]:
    return [table.table_code or table.legacy_id for table in db.scalars(
        select(WashingTable).where(WashingTable.plant_id == plant_id).order_by(WashingTable.table_code, WashingTable.legacy_id)
    )]


def _validate_report_date(user: User, manager: bool, value: date) -> None:
    today = date.today()
    if value > today:
        raise HTTPException(422, "The report date cannot be in the future")
    if not manager and (today - value).days > MAX_BACKDATE_DAYS:
        raise HTTPException(422, f"A report can be entered for the last {MAX_BACKDATE_DAYS} days only; ask the O&M Head for older dates")


def _next_open_cycle(db: Session, plant_id: UUID, month: str, exclude_report_id: UUID | None = None) -> int:
    stmt = select(WashingDailyReport.cycle_no).where(
        WashingDailyReport.plant_id == plant_id,
        WashingDailyReport.cycle_month == month,
        WashingDailyReport.cycle_completed.is_(True),
        WashingDailyReport.review_status == "Confirmed",
    )
    if exclude_report_id:
        stmt = stmt.where(WashingDailyReport.id != exclude_report_id)
    done = set(db.scalars(stmt))
    if len(done) >= MONTHLY_CYCLE_TARGET:
        raise HTTPException(409, "All three washing cycles for that month are complete")
    return max(done, default=0) + 1


def create_daily_report(db: Session, user: User, payload: WashingDailyReportRequest) -> dict:
    manager = _is_washing_manager(db, user)
    if user.role != "Site Engineer" and not manager:
        raise HTTPException(403, "Only a Site Engineer can submit a daily washing report; the O&M team reviews it")
    plant = _plant_for_id(db, payload.plant_id)
    config = db.scalar(select(WashingConfig).where(WashingConfig.plant_id == plant.id).with_for_update())
    if not config:
        raise HTTPException(409, "Washing has not been set up for this plant")
    _require_plant_access(db, user, plant, config)
    total_tables = db.scalar(select(func.count(WashingTable.id)).where(WashingTable.plant_id == plant.id)) or 0
    if total_tables < 1:
        raise HTTPException(409, "Washing has not been set up for this plant")
    if payload.tables_cleaned > total_tables:
        raise HTTPException(422, "Tables cleaned cannot exceed the plant's registered table count")
    if payload.job_status == "Done" and payload.tables_cleaned == 0:
        raise HTTPException(422, "Enter at least one cleaned table for a Done report")
    ordered_codes = _ordered_codes(db, plant.id)
    if not set(payload.cleaned_table_codes).issubset(set(ordered_codes)):
        raise HTTPException(422, "A selected table is not registered to this plant")
    report_date = payload.report_date or date.today()
    _validate_report_date(user, manager, report_date)
    month = _month_key(report_date)
    cycle_no = _next_open_cycle(db, plant.id, month)
    current_rows = list(db.scalars(select(WashingDailyReport).where(
        WashingDailyReport.plant_id == plant.id,
        WashingDailyReport.cycle_month == month,
        WashingDailyReport.cycle_no == cycle_no,
        WashingDailyReport.review_status.in_(["Pending", "Confirmed"]),
    )))
    reserved = sum(row.tables_cleaned for row in current_rows)
    prior_codes = {code for row in current_rows for code in (row.cleaned_table_codes or [])}
    if prior_codes.intersection(payload.cleaned_table_codes):
        raise HTTPException(409, "A table can only be reported once in the same washing cycle")
    if reserved + payload.tables_cleaned > total_tables:
        raise HTTPException(409, f"Only {max(0, total_tables - reserved)} table(s) remain to be reported in cycle {cycle_no}")
    cleaned_codes = list(payload.cleaned_table_codes)
    if payload.job_status == "Done" and not cleaned_codes:
        # The site engineer reports HOW MANY tables were cleaned; the next free tables of this cycle are assigned in order.
        free = [code for code in ordered_codes if code not in prior_codes]
        cleaned_codes = free[:payload.tables_cleaned]

    report = WashingDailyReport(
        plant_id=plant.id,
        cycle_month=month,
        cycle_no=cycle_no,
        report_date=report_date,
        job_status=payload.job_status,
        tables_cleaned=payload.tables_cleaned,
        cleaned_table_codes=cleaned_codes,
        remarks=(payload.remarks or "").strip() or None,
        exception_reason=payload.exception_reason,
        reported_by_id=user.id,
        reported_by=user.display_name,
    )
    if manager and user.role != "Site Engineer":
        # An O&M entry (e.g. back-filling an older date) is the O&M team's own record, so it needs no second review.
        report.review_status = "Confirmed"
        report.reviewed_by_id = user.id
        report.reviewed_by = user.display_name
        report.reviewed_at = datetime.now(timezone.utc)
        report.review_note = "Entered by O&M"
    db.add(report)
    db.flush()
    cycle_completed = False
    if report.review_status == "Confirmed":
        cycle_completed = _refresh_cycle_completion(db, plant.id, month, cycle_no, total_tables)
    else:
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
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name, action="Submitted daily washing report",
        module="Washing", entity_type="washing_daily_report", entity_id=str(report.id),
        metadata_json={"plant": plant.site_code, "cycle_month": month, "cycle_no": cycle_no, "report_date": report_date.isoformat(), "job_status": report.job_status, "tables_cleaned": report.tables_cleaned, "exception_reason": report.exception_reason, "cycle_completed": cycle_completed},
    ))
    db.commit()
    return _report_out(report, plant, user, config, manager)


def _load_report_for_change(db: Session, user: User, report_id: UUID):
    report = db.scalar(select(WashingDailyReport).where(WashingDailyReport.id == report_id).with_for_update())
    if not report:
        raise HTTPException(404, "Daily washing report not found")
    plant = _plant_for_id(db, report.plant_id)
    config = db.scalar(select(WashingConfig).where(WashingConfig.plant_id == plant.id).with_for_update())
    if not config:
        raise HTTPException(409, "Washing has not been set up for this plant")
    manager = _is_washing_manager(db, user)
    owner = report.reported_by_id == user.id and report.review_status in ("Pending", "Rejected")
    if not manager and not owner:
        raise HTTPException(403, "Only the O&M team can change a report after it has been reviewed; a Site Engineer can change their own report until it is confirmed")
    if not manager:
        _require_plant_access(db, user, plant, config)
    return report, plant, config, manager


def update_daily_report(db: Session, user: User, report_id: UUID, payload: WashingReportUpdateRequest) -> dict:
    report, plant, config, manager = _load_report_for_change(db, user, report_id)
    total_tables = db.scalar(select(func.count(WashingTable.id)).where(WashingTable.plant_id == plant.id)) or 0
    before = {"report_date": report.report_date.isoformat(), "tables_cleaned": report.tables_cleaned, "job_status": report.job_status,
              "exception_reason": report.exception_reason, "remarks": report.remarks, "cycle_no": report.cycle_no, "cycle_month": report.cycle_month}
    old_month, old_cycle = report.cycle_month, report.cycle_no

    new_date = payload.report_date or report.report_date
    _validate_report_date(user, manager, new_date)
    status = payload.job_status or report.job_status
    if status == "Done":
        tables = payload.tables_cleaned if payload.tables_cleaned is not None else report.tables_cleaned
        if tables < 1:
            raise HTTPException(422, "Enter at least one cleaned table for a Done report")
        if tables > total_tables:
            raise HTTPException(422, "Tables cleaned cannot exceed the plant's registered table count")
        reason = None
    else:
        tables = 0
        reason = payload.exception_reason or report.exception_reason
        if not reason:
            raise HTTPException(422, "Choose the reason the work was not done")

    new_month = _month_key(new_date)
    cycle_no = report.cycle_no
    if new_month != report.cycle_month:
        cycle_no = _next_open_cycle(db, plant.id, new_month, exclude_report_id=report.id)
    others = list(db.scalars(select(WashingDailyReport).where(
        WashingDailyReport.plant_id == plant.id,
        WashingDailyReport.cycle_month == new_month,
        WashingDailyReport.cycle_no == cycle_no,
        WashingDailyReport.review_status.in_(["Pending", "Confirmed"]),
        WashingDailyReport.id != report.id,
    )))
    if sum(row.tables_cleaned for row in others) + tables > total_tables:
        raise HTTPException(409, f"Only {max(0, total_tables - sum(row.tables_cleaned for row in others))} table(s) remain in cycle {cycle_no}")
    used = {code for row in others for code in (row.cleaned_table_codes or [])}
    codes = [code for code in _ordered_codes(db, plant.id) if code not in used][:tables] if status == "Done" else []

    report.report_date = new_date
    report.cycle_month = new_month
    report.cycle_no = cycle_no
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
    for month, cyc in {(old_month, old_cycle), (new_month, cycle_no)}:
        _refresh_cycle_completion(db, plant.id, month, cyc, total_tables)
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name, action="Edited daily washing report",
        module="Washing", entity_type="washing_daily_report", entity_id=str(report.id),
        metadata_json={"plant": plant.site_code, "before": before, "after": {"report_date": new_date.isoformat(), "tables_cleaned": tables, "job_status": status, "exception_reason": reason, "cycle_no": cycle_no, "cycle_month": new_month}},
    ))
    db.commit()
    return _report_out(report, plant, user, config, manager)


def delete_daily_report(db: Session, user: User, report_id: UUID) -> dict:
    report, plant, config, manager = _load_report_for_change(db, user, report_id)
    total_tables = db.scalar(select(func.count(WashingTable.id)).where(WashingTable.plant_id == plant.id)) or 0
    month, cycle_no = report.cycle_month, report.cycle_no
    paths = [str(entry.get("storage_path")) for entry in (report.evidence or []) if isinstance(entry, dict) and entry.get("storage_path")]
    info = {"plant": plant.site_code, "report_date": report.report_date.isoformat(), "tables_cleaned": report.tables_cleaned, "cycle_month": month, "cycle_no": cycle_no, "review_status": report.review_status}
    db.delete(report)
    db.flush()
    _refresh_cycle_completion(db, plant.id, month, cycle_no, total_tables)
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
    start_now = _cycle_start_dates(first, {payload.month: trial})[payload.cycle_no - 1]
    due_now = _cycle_due_dates(first, {payload.month: trial})[payload.cycle_no - 1]
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
    total_tables = db.scalar(select(func.count(WashingTable.id)).where(WashingTable.plant_id == plant.id)) or 0
    if payload.decision == "Confirm" and report.job_status == "Done":
        if report.tables_cleaned < total_tables:
            evidence_kinds = {
                str(entry.get("kind", "")).lower()
                for entry in (report.evidence or [])
                if isinstance(entry, dict)
            }
            missing = {"before", "after"} - evidence_kinds
            if missing:
                ordered = [kind for kind in ("before", "after") if kind in missing]
                labels = " and ".join(ordered)
                raise HTTPException(
                    409,
                    f"Upload {labels} cleaning photo evidence before confirming this report",
                )
    if payload.decision == "Confirm":
        approved_other = db.scalar(select(func.coalesce(func.sum(WashingDailyReport.tables_cleaned), 0)).where(
            WashingDailyReport.plant_id == plant.id,
            WashingDailyReport.cycle_month == report.cycle_month,
            WashingDailyReport.cycle_no == report.cycle_no,
            WashingDailyReport.review_status == "Confirmed",
        )) or 0
        if approved_other + report.tables_cleaned > total_tables:
            raise HTTPException(409, "Confirmed cleaning count would exceed the registered table count")
        report.review_status = "Confirmed"
    else:
        report.review_status = "Rejected"
    report.reviewed_by_id = user.id
    report.reviewed_by = user.display_name
    report.reviewed_at = datetime.now(timezone.utc)
    report.review_note = (payload.remarks or "").strip() or None
    db.add(report)
    db.flush()
    cycle_completed = False
    if report.review_status == "Confirmed":
        total_confirmed = db.scalar(select(func.coalesce(func.sum(WashingDailyReport.tables_cleaned), 0)).where(
            WashingDailyReport.plant_id == plant.id,
            WashingDailyReport.cycle_month == report.cycle_month,
            WashingDailyReport.cycle_no == report.cycle_no,
            WashingDailyReport.review_status == "Confirmed",
        )) or 0
        if total_confirmed == total_tables:
            report.cycle_completed = True
            cycle_completed = True

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
    return _report_out(report, plant, user, config, True)


def check_missed_monthly_targets(db: Session, today: date | None = None) -> int:
    current = today or date.today()
    if current.day != 1:
        return 0
    previous = current.replace(day=1) - timedelta(days=1)
    month = _month_key(previous)
    notified = 0
    for config in db.scalars(select(WashingConfig).with_for_update()):
        if not config.active:
            continue
        plant = db.get(Plant, config.plant_id)
        total_tables = db.scalar(select(func.count(WashingTable.id)).where(WashingTable.plant_id == config.plant_id)) or 0
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


def check_weekly_compliance_alerts(db: Session, today: date | None = None) -> int:
    current = today or date.today()
    week_start = current - timedelta(days=6)
    week_key = f"{current.isocalendar().year}-W{current.isocalendar().week:02d}"
    notified = 0
    for config in db.scalars(select(WashingConfig).with_for_update()):
        if not config.active:
            continue
        plant = db.get(Plant, config.plant_id)
        tables = list(db.scalars(select(WashingTable).where(WashingTable.plant_id == config.plant_id)))
        if not plant or not tables:
            continue
        excused_dates = set(db.scalars(select(WashingDailyReport.report_date).where(
            WashingDailyReport.plant_id == plant.id,
            WashingDailyReport.report_date >= week_start,
            WashingDailyReport.report_date <= current,
            WashingDailyReport.review_status == "Confirmed",
            WashingDailyReport.exception_reason.is_not(None),
        )))
        expected = sum(
            _daily_table_target(len(tables), week_start + timedelta(days=offset), config.cycle_overrides)
            for offset in range(7)
            if week_start + timedelta(days=offset) <= current
            and week_start + timedelta(days=offset) not in excused_dates
        )
        confirmed = list(db.scalars(select(WashingDailyReport).where(
            WashingDailyReport.plant_id == plant.id,
            WashingDailyReport.report_date >= week_start,
            WashingDailyReport.report_date <= current,
            WashingDailyReport.review_status == "Confirmed",
            WashingDailyReport.tables_cleaned > 0,
        )))
        cleaned = sum(report.tables_cleaned for report in confirmed)
        compliance = min(100, round(100 * cleaned / expected)) if expected else 100
        if compliance >= config.compliance_threshold_percent:
            continue
        dedupe_key = f"washing-weekly-compliance:{plant.id}:{week_key}"
        if db.scalar(select(Notification.id).where(or_(Notification.dedupe_key == dedupe_key, Notification.dedupe_key.like(dedupe_key + ":%"))).limit(1)):
            continue
        _notify_wash(
            db, plant, config,
            event_type="washing_weekly_compliance_low",
            title=f"Washing compliance below target — {week_key}",
            message=f"Weekly compliance is {compliance}% against the configured {config.compliance_threshold_percent}% threshold ({cleaned} of {expected} tables reported clean).",
            dedupe_key=dedupe_key,
            managers_only=True,  # performance metric: O&M team only
        )
        notified += 1
    if notified:
        db.commit()
    else:
        db.rollback()
    return notified


def check_washing_overdue(db: Session, today: date | None = None) -> int:
    """Alert when a plant is behind the month's cycle deadlines: once at 1, 3 and 7 days late (each level only once)."""
    current = today or date.today()
    month = _month_key(current)
    notified = 0
    for config in db.scalars(select(WashingConfig).with_for_update()):
        if not config.active:
            continue
        plant = db.get(Plant, config.plant_id)
        total_tables = db.scalar(select(func.count(WashingTable.id)).where(WashingTable.plant_id == config.plant_id)) or 0
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