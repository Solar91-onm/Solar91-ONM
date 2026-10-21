from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
import uuid
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.timeutil import BUSINESS_TZ, business_today
from app.core.config import get_settings
from app.core.models import AuditLog, Notification, Plant, User, UserEquipmentTypeAssignment, WashingConfig, WashingDailyReport, WashingHistory, WashingTable
from app.core.security import WASHING_TYPE, assignee_has_type, user_scoped_plant_ids
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


def invalidate_overview_cache() -> None:
    """Called after every write request, so a user always sees their own change straight away."""
    global _OVERVIEW_VERSION
    _OVERVIEW_VERSION += 1
    _OVERVIEW_CACHE.clear()


def _month_key(value: date) -> str:
    return value.strftime("%Y-%m")


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


def _is_backfilled(report: WashingDailyReport) -> bool:
    """A day entered PHOTO_REQUIRED_DAYS or more after it happened (a back-filled sheet row). Before/after photos
    are rarely available for those, so confirming one does not require them; the reviewer sees it flagged."""
    created = report.created_at or datetime.now(timezone.utc)
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return (created.astimezone(BUSINESS_TZ).date() - report.report_date).days >= PHOTO_REQUIRED_DAYS


def _photos_required(report: WashingDailyReport, total_tables: int) -> bool:
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
    key = (str(user.id), user.role, include_tables, report_days, business_today().isoformat())
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
    allowed_plant_ids = user_scoped_plant_ids(db, user) or set() if user.role == "Site Engineer" else set()

    configured_plants = select(WashingConfig.plant_id)
    table_counts_query = (
        select(WashingTable.plant_id.label("plant_id"), func.count(WashingTable.id).label("table_count"))
        .where(WashingTable.plant_id.in_(configured_plants))
    )
    latest_reports_query = (
        select(
            WashingDailyReport.plant_id.label("plant_id"),
            func.max(WashingDailyReport.report_date).label("last_report_date"),
        )
        .where(WashingDailyReport.plant_id.in_(configured_plants))
    )
    if user.role == "Site Engineer":
        table_counts_query = table_counts_query.where(WashingTable.plant_id.in_(allowed_plant_ids))
        latest_reports_query = latest_reports_query.where(WashingDailyReport.plant_id.in_(allowed_plant_ids))
    table_counts_subquery = table_counts_query.group_by(WashingTable.plant_id).subquery()
    latest_reports_subquery = latest_reports_query.group_by(WashingDailyReport.plant_id).subquery()

    plant_stmt = (
        select(
            Plant,
            WashingConfig,
            User.display_name,
            func.coalesce(WashingConfig.tables_per_cycle, table_counts_subquery.c.table_count, 0),
            latest_reports_subquery.c.last_report_date,
        )
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
    for plant, config, assignee_name, table_count, last_report in plant_config_rows:
        pool.append(plant)
        if config is None or not (manager or (user.role == "Site Engineer" and plant.id in allowed_plant_ids)):
            continue
        visible_configs.append((plant, config))
        table_counts[plant.id] = int(table_count or 0)
        if last_report:
            last_report_by_plant[plant.id] = last_report
        if config.assigned_user_id and assignee_name:
            assignee_names[config.assigned_user_id] = assignee_name

    visible_ids = [plant.id for plant, _config in visible_configs]
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
        report_cutoff = business_today() - timedelta(days=OVERVIEW_REPORT_DAYS)
        for report in db.scalars(
            select(WashingDailyReport).where(
                WashingDailyReport.plant_id.in_(visible_ids),
                or_(WashingDailyReport.report_date >= report_cutoff, WashingDailyReport.review_status == "Pending"),
            )
            .order_by(WashingDailyReport.plant_id, WashingDailyReport.report_date.desc(), WashingDailyReport.created_at.desc())
        ):
            reports_by_plant.setdefault(report.plant_id, []).append(report)
    visible: list[tuple[Plant, WashingConfig, int, list[WashingDailyReport]]] = []
    for plant, config in visible_configs:
        table_count = table_counts.get(plant.id, 0)
        if table_count:
            visible.append((plant, config, table_count, reports_by_plant.get(plant.id, [])))

    today = business_today()
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


def _plant_table_count(db: Session, plant_id: UUID, config: WashingConfig | None = None) -> int:
    """Tables a plant washes in one cycle. This is only the target the compliance ratio is measured against.
    Uses the plant's tables_per_cycle number; falls back to counting registered tables for older setups."""
    if config is None:
        config = db.get(WashingConfig, plant_id)
    if config is not None and config.tables_per_cycle:
        return int(config.tables_per_cycle)
    return db.scalar(select(func.count(WashingTable.id)).where(WashingTable.plant_id == plant_id)) or 0


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
    completing = _completing_row(rows, total_tables)
    if completing is not None:
        completing.cycle_completed = True
    db.flush()
    return completing is not None


def _completing_row(rows, total_tables: int):
    """The report on which a cycle's running confirmed total first reaches the plant's table count (None while the
    cycle is still open). `rows` are the cycle's confirmed reports ordered by report date, then entry time."""
    running = 0
    for row in rows:
        running += row.tables_cleaned
        if total_tables > 0 and running >= total_tables:
            return row
    return None


def _month_wash_summary(reports, table_count: int) -> dict:
    """How much washing a plant did in one month, for records and the monthly sheet.

    `times_washed` counts full washes of every table (confirmed tables ÷ tables per cycle), so robot cleaning that
    goes past the three cycles shows e.g. 4.5. `extra_times` is the part done after all three cycles were complete
    (that work is recorded on cycle 3); it is a count for the record, never an extra cycle."""
    active = [r for r in reports if r.review_status in ("Pending", "Confirmed")]
    confirmed = [r for r in active if r.review_status == "Confirmed"]
    completed_on = {r.cycle_no: r.report_date for r in sorted(confirmed, key=lambda r: r.report_date) if r.cycle_completed}
    cycles_completed = len(completed_on)
    confirmed_tables = sum(r.tables_cleaned for r in confirmed)
    last_cycle_tables = sum(r.tables_cleaned for r in confirmed if r.cycle_no == MONTHLY_CYCLE_TARGET)
    extra_tables = max(0, last_cycle_tables - table_count) if cycles_completed >= MONTHLY_CYCLE_TARGET and table_count else 0
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


def _open_cycle_no(done: set[int]) -> int:
    """The cycle new work counts towards: the one after the highest completed cycle. Once all three are complete
    (e.g. robot cleaning finished the month early) further washing is still recorded, as extra work on the last cycle;
    it never re-opens or adds a cycle."""
    return min(max(done, default=0) + 1, MONTHLY_CYCLE_TARGET)


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


def _next_open_cycle(db: Session, plant_id: UUID, month: str, exclude_report_id: UUID | None = None) -> int:
    stmt = select(WashingDailyReport.cycle_no).where(
        WashingDailyReport.plant_id == plant_id,
        WashingDailyReport.cycle_month == month,
        WashingDailyReport.cycle_completed.is_(True),
        WashingDailyReport.review_status == "Confirmed",
    )
    if exclude_report_id:
        stmt = stmt.where(WashingDailyReport.id != exclude_report_id)
    return _open_cycle_no(set(db.scalars(stmt)))


def _cycle_for_new_work(db: Session, plant_id: UUID, month: str, total_tables: int) -> int:
    """The cycle a newly entered day counts towards. A cycle is full once it is confirmed complete OR the tables
    recorded on it (confirmed + awaiting confirmation) reach the plant's table count, so the next cycle starts the
    moment the count is reached: no separate save, and a Site Engineer need not wait for the O&M review to go on.
    The day that reaches the count stays whole in that cycle (one report per date); later days go to the next one."""
    recorded: dict[int, int] = {}
    full: set[int] = set()
    for cycle_no, tables, completed, status in db.execute(select(
        WashingDailyReport.cycle_no, WashingDailyReport.tables_cleaned, WashingDailyReport.cycle_completed, WashingDailyReport.review_status,
    ).where(
        WashingDailyReport.plant_id == plant_id,
        WashingDailyReport.cycle_month == month,
        WashingDailyReport.review_status.in_(["Pending", "Confirmed"]),
    )):
        recorded[cycle_no] = recorded.get(cycle_no, 0) + (tables or 0)
        if completed and status == "Confirmed":
            full.add(cycle_no)
    full |= {n for n, tables in recorded.items() if total_tables > 0 and tables >= total_tables}
    return _open_cycle_no(full)


def _locked_report_plant(db: Session, user: User, plant_id: UUID) -> tuple[Plant, WashingConfig, bool, int]:
    """Who may submit daily washing reports for a plant; locks the plant's washing config so concurrent
    submissions for the same plant run one after another (no duplicate days, correct cycle numbers)."""
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
    remarks: str | None, cleaned_codes: list[str] | None = None,
) -> tuple[WashingDailyReport, bool]:
    """Create one daily report (no commit, no notification). Returns the report and whether it completed a cycle."""
    _validate_report_date(user, manager, report_date)
    month = _month_key(report_date)
    cycle_no = _cycle_for_new_work(db, plant.id, month, total_tables)
    # Teams only report HOW MANY tables they cleaned that day. The plant's number is a target, never a limit,
    # so nothing is rejected for being above or below it and no individual tables are tracked.
    report = WashingDailyReport(
        plant_id=plant.id,
        cycle_month=month,
        cycle_no=cycle_no,
        report_date=report_date,
        job_status=job_status,
        tables_cleaned=tables_cleaned,
        cleaned_table_codes=list(cleaned_codes or []),
        remarks=(remarks or "").strip() or None,
        exception_reason=exception_reason,
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
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name, action="Submitted daily washing report",
        module="Washing", entity_type="washing_daily_report", entity_id=str(report.id),
        metadata_json={"plant": plant.site_code, "cycle_month": month, "cycle_no": cycle_no, "report_date": report_date.isoformat(), "job_status": report.job_status, "tables_cleaned": report.tables_cleaned, "exception_reason": report.exception_reason, "cycle_completed": cycle_completed},
    ))
    return report, cycle_completed


def create_daily_report(db: Session, user: User, payload: WashingDailyReportRequest) -> dict:
    plant, config, manager, total_tables = _locked_report_plant(db, user, payload.plant_id)
    if payload.job_status == "Done" and payload.tables_cleaned == 0:
        raise HTTPException(422, "Enter at least one cleaned table for a Done report")
    report, _cycle_completed = _add_report(
        db, user, plant, manager, total_tables,
        report_date=payload.report_date or business_today(), job_status=payload.job_status,
        tables_cleaned=payload.tables_cleaned, exception_reason=payload.exception_reason,
        remarks=payload.remarks, cleaned_codes=payload.cleaned_table_codes,
    )
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


def create_sheet_reports(db: Session, user: User, payload: WashingSheetRequest) -> dict:
    """Save several days of one plant's cycle sheet in one go. All days are saved or none is.
    A Site Engineer's days wait for O&M confirmation and raise ONE review notification for the whole sheet;
    the O&M Head / a washing Assignee saves them as confirmed, like a single O&M entry."""
    plant, config, manager, total_tables = _locked_report_plant(db, user, payload.plant_id)
    entries = sorted(payload.entries, key=lambda entry: entry.report_date)
    dates = [entry.report_date for entry in entries]
    if len(set(dates)) != len(dates):
        raise HTTPException(422, "Each date can appear only once in a washing sheet")
    for value in dates:
        _validate_report_date(user, manager, value)
    taken = sorted(set(db.scalars(select(WashingDailyReport.report_date).where(
        WashingDailyReport.plant_id == plant.id,
        WashingDailyReport.report_date.in_(dates),
        WashingDailyReport.review_status.in_(["Pending", "Confirmed"]),
    ))))
    if taken:
        raise HTTPException(409, "Already reported for " + ", ".join(_day_label(value) for value in taken) + ". Edit those days instead of adding them again.")
    created: list[WashingDailyReport] = []
    for entry in entries:
        report, _completed = _add_report(
            db, user, plant, manager, total_tables,
            report_date=entry.report_date, job_status=entry.job_status, tables_cleaned=entry.tables_cleaned,
            exception_reason=entry.exception_reason, remarks=entry.remarks,
        )
        created.append(report)
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
    owner = report.reported_by_id == user.id and report.review_status in ("Pending", "Rejected")
    if not manager and not owner:
        raise HTTPException(403, "Only the O&M team can change a report after it has been reviewed; a Site Engineer can change their own report until it is confirmed")
    if not manager:
        _require_plant_access(db, user, plant, config)
    return report, plant, config, manager


def update_daily_report(db: Session, user: User, report_id: UUID, payload: WashingReportUpdateRequest) -> dict:
    report, plant, config, manager = _load_report_for_change(db, user, report_id)
    total_tables = _plant_table_count(db, plant.id, config)
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
    codes: list[str] = []

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
    return _report_out(report, plant, user, config, manager, total_tables)


def delete_daily_report(db: Session, user: User, report_id: UUID) -> dict:
    report, plant, config, manager = _load_report_for_change(db, user, report_id)
    total_tables = _plant_table_count(db, plant.id, config)
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
    cycles = []
    for n in range(1, MONTHLY_CYCLE_TARGET + 1):
        rows = [r for r in reports if r.cycle_no == n]
        confirmed = sum(r.tables_cleaned for r in rows if r.review_status == "Confirmed")
        pending = sum(r.tables_cleaned for r in rows if r.review_status == "Pending")
        done_on = next((r.report_date for r in rows if r.cycle_completed and r.review_status == "Confirmed"), None)
        due = dues[n - 1]
        state = "Completed" if done_on else "In progress" if rows else ("Missed" if due < today else "Upcoming")
        cycles.append({
            "cycle_no": n, "start_date": starts[n - 1].isoformat(), "due_date": due.isoformat(),
            "default_start_date": default_starts[n - 1].isoformat(), "default_due_date": default_dues[n - 1].isoformat(),
            "start_set_for_month": f"s{n}" in specific, "due_set_for_month": str(n) in specific,
            "state": state, "confirmed": confirmed, "pending": pending, "reports": len(rows),
            "started_on": rows[0].report_date.isoformat() if rows else None,
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
    cycle_completed = False
    if report.review_status == "Confirmed":
        already_complete = db.scalar(select(WashingDailyReport.id).where(
            WashingDailyReport.plant_id == plant.id,
            WashingDailyReport.cycle_month == report.cycle_month,
            WashingDailyReport.cycle_no == report.cycle_no,
            WashingDailyReport.review_status == "Confirmed",
            WashingDailyReport.cycle_completed.is_(True),
            WashingDailyReport.id != report.id,
        ).limit(1)) is not None  # extra washing after the month's last cycle was already complete
        total_confirmed = db.scalar(select(func.coalesce(func.sum(WashingDailyReport.tables_cleaned), 0)).where(
            WashingDailyReport.plant_id == plant.id,
            WashingDailyReport.cycle_month == report.cycle_month,
            WashingDailyReport.cycle_no == report.cycle_no,
            WashingDailyReport.review_status == "Confirmed",
        )) or 0
        if not already_complete and total_confirmed >= total_tables:
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

    cycles = {(report.cycle_month, report.cycle_no) for report in reports}
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
    completed = sorted(key for key in cycles if _refresh_cycle_completion(db, plant.id, key[0], key[1], total_tables) and key not in already_done)

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


def check_weekly_compliance_alerts(db: Session, today: date | None = None) -> int:
    current = today or business_today()
    week_start = current - timedelta(days=6)
    week_key = f"{current.isocalendar().year}-W{current.isocalendar().week:02d}"
    notified = 0
    for config in db.scalars(select(WashingConfig).with_for_update()):
        if not config.active:
            continue
        plant = db.get(Plant, config.plant_id)
        total_tables = _plant_table_count(db, config.plant_id, config)
        if not plant or not total_tables:
            continue
        excused_dates = set(db.scalars(select(WashingDailyReport.report_date).where(
            WashingDailyReport.plant_id == plant.id,
            WashingDailyReport.report_date >= week_start,
            WashingDailyReport.report_date <= current,
            WashingDailyReport.review_status == "Confirmed",
            WashingDailyReport.exception_reason.is_not(None),
        )))
        expected = sum(
            _daily_table_target(total_tables, week_start + timedelta(days=offset), config.cycle_overrides)
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