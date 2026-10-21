"""Daily washing upload: record the tables cleaned per plant per day from one spreadsheet.

One row is one plant on one day: Site code, Date, then either Tables cleaned or a Not done reason, and optional
Remarks. Rows follow the same rules as the plant cycle sheet (``create_sheet_reports``): entries by the O&M Head
or a washing Assignee are saved as confirmed; a Site Engineer's entries (own plant, last 45 days) wait for review
with one notification per plant; a day that already has a pending or confirmed report is never added again; and
every row is checked before anything is saved (all or nothing).

The downloadable sheet for a month is pre-filled with one row per plant and day, so people only type numbers.
Days already saved show their values; uploading them again unchanged is harmless ("Already saved").
"""
from __future__ import annotations

import io
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any, get_args
from uuid import UUID

from fastapi import HTTPException
from openpyxl import Workbook
from openpyxl.styles import Font
from openpyxl.worksheet.datavalidation import DataValidation
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.models import AuditLog, Plant, User, WashingConfig, WashingDailyReport
from app.core.security import user_scoped_plant_ids
from app.core.spreadsheet import cell_text, map_columns, neutralise_formulas, parse_sheet_date, read_upload_rows
from app.core.timeutil import business_today
from app.plants.codes import normalize_site_code, plant_code_index
from app.scheduled.schemas import WashingSheetEntry
from app.scheduled.washing_cycles import (
    MAX_BACKDATE_DAYS,
    _completing_row,
    _day_label,
    _is_washing_manager,
    _month_key,
    _notify_wash,
    _open_cycle_no,
    _plant_table_count,
    _refresh_cycle_completion,
)

MAX_DAILY_BYTES = 2 * 1024 * 1024
MAX_DAILY_ROWS = 3000
MAX_HISTORY_DAYS = 730  # the cycle sheet shows months up to two years back; older days could not be reviewed there
MAX_TABLES = 5000
SHEET = "Daily washing"
HEADERS = ("Site code", "Plant name", "Date", "Tables cleaned", "Not done reason", "Remarks", "Saved in portal")
NOT_DONE_REASONS: tuple[str, ...] = get_args(get_args(WashingSheetEntry.model_fields["exception_reason"].annotation)[0])
ALIASES = {
    "site_code": {"Site code", "Plant code", "Site", "Code", "Site id"},
    "date": {"Date", "Report date", "Washing date", "Cleaning date", "Work date", "Day"},
    "tables": {"Tables cleaned", "Tables washed", "Tables", "Cleaned tables", "No of tables cleaned", "Number of tables cleaned"},
    "reason": {"Not done reason", "Reason", "Reason not done", "Not done", "Exception reason", "Exception"},
    "remarks": {"Remarks", "Remark", "Notes", "Note", "Comments", "Comment"},
}


def _require_reporter(db: Session, user: User) -> bool:
    """Returns whether the user is on the O&M team (entries saved as confirmed)."""
    manager = _is_washing_manager(db, user)
    if user.role != "Site Engineer" and not manager:
        raise HTTPException(403, "Only a Site Engineer or the O&M team can upload daily washing")
    return manager


def _allowed_plants(db: Session, user: User, manager: bool) -> set[UUID] | None:
    return None if manager else (user_scoped_plant_ids(db, user) or set())


def _describe(job_status: str, tables: int, reason: str | None) -> str:
    return f"{tables} table{'s' if tables != 1 else ''}" if job_status == "Done" else f"Not done — {reason}"


# ───────────────────────── template ─────────────────────────
def _template_month(month: str | None) -> tuple[date, date]:
    today = business_today()
    if not month:
        first = today.replace(day=1)
    else:
        try:
            first = date(int(month[:4]), int(month[5:7]), 1)
            if len(month) != 7 or month[4] != "-":
                raise ValueError
        except (TypeError, ValueError):
            raise HTTPException(422, "Month must look like 2026-10")
    last = first.replace(day=monthrange(first.year, first.month)[1])
    if first > today:
        raise HTTPException(422, "Choose the current month or an earlier one")
    if (today - last).days > MAX_HISTORY_DAYS:
        raise HTTPException(422, "Choose a month within the last two years")
    return first, min(last, today)


def daily_template_bytes(db: Session, user: User, month: str | None = None, plant_ids: list[str] | None = None) -> tuple[bytes, str]:
    """A month's sheet with one row per set-up plant and day (up to today). Saved days show their values."""
    manager = _require_reporter(db, user)
    first, end = _template_month(month)
    month_key = _month_key(first)
    stmt = select(Plant, WashingConfig).join(WashingConfig, WashingConfig.plant_id == Plant.id).order_by(Plant.site_code)
    found = [(plant, config) for plant, config in db.execute(stmt).all()]
    allowed = _allowed_plants(db, user, manager)
    if allowed is not None:
        found = [(plant, config) for plant, config in found if plant.id in allowed]
    if plant_ids is not None:
        requested: set[UUID] = set()
        for value in plant_ids:
            try:
                requested.add(UUID(value))
            except ValueError as exc:
                raise HTTPException(422, f"Invalid plant id: {value}") from exc
        found = [(plant, config) for plant, config in found if plant.id in requested]
    else:
        found = [(plant, config) for plant, config in found if config.active]
    found = [(plant, config) for plant, config in found if _plant_table_count(db, plant.id, config) > 0]
    days = (end - first).days + 1
    if len(found) * days > MAX_DAILY_ROWS:
        raise HTTPException(422, f"That would be more than {MAX_DAILY_ROWS} rows; choose fewer plants")

    saved: dict[tuple[UUID, date], WashingDailyReport] = {}
    if found:
        for report in db.scalars(select(WashingDailyReport).where(
            WashingDailyReport.plant_id.in_([plant.id for plant, _config in found]),
            WashingDailyReport.cycle_month == month_key,
        ).order_by(WashingDailyReport.created_at)):
            key = (report.plant_id, report.report_date)
            current = saved.get(key)
            # a pending or confirmed report wins over an older rejected one for the same day
            if current is None or report.review_status != "Rejected" or current.review_status == "Rejected":
                saved[key] = report

    workbook = Workbook()
    guide = workbook.active
    guide.title = "How to fill"
    for text in (
        "One row is one plant on one day. Site code and Date are already filled in for you.",
        "Type the number of tables cleaned that day in 'Tables cleaned'.",
        "If no washing was done, leave 'Tables cleaned' empty and pick the 'Not done reason' instead.",
        "Leave a row completely empty if you have nothing to report for that day; empty rows are skipped.",
        "Rows marked in 'Saved in portal' are already recorded. Change those days in the portal, not in this file.",
        f"Dates may be typed as DD-MM-YYYY. Site Engineers can enter the last {MAX_BACKDATE_DAYS} days for their own plant.",
        "Entries by the O&M Head or a washing Assignee are saved as confirmed; a Site Engineer's entries wait for review.",
        "You can also add your own rows (any plant and date) with the same columns.",
    ):
        guide.append([text])
    guide.column_dimensions["A"].width = 110

    sheet = workbook.create_sheet(SHEET)
    sheet.append(HEADERS)
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    sheet.freeze_panes = "A2"
    for plant, _config in found:
        for offset in range(days):
            day = date.fromordinal(first.toordinal() + offset)
            report = saved.get((plant.id, day))
            if report is not None and report.review_status != "Rejected":
                done = report.job_status == "Done"
                status = "Confirmed" if report.review_status == "Confirmed" else "Pending review"
                sheet.append([plant.site_code, plant.plant_name, day, report.tables_cleaned if done else None,
                              None if done else report.exception_reason, report.remarks, status])
            else:
                sheet.append([plant.site_code, plant.plant_name, day, None, None, None,
                              "Rejected — enter again" if report is not None else None])
            sheet.cell(sheet.max_row, 3).number_format = "DD-MM-YYYY"
    sheet.auto_filter.ref = f"A1:G{max(1, sheet.max_row)}"
    for index, width in enumerate((14, 32, 14, 16, 22, 40, 20), start=1):
        sheet.column_dimensions[sheet.cell(1, index).column_letter].width = width
    last_row = max(sheet.max_row, 2) + 200
    tables = DataValidation(type="whole", operator="between", formula1="0", formula2=str(MAX_TABLES), allow_blank=True,
                            showErrorMessage=True, error="Type a whole number of tables")
    reasons = DataValidation(type="list", formula1='"' + ",".join(NOT_DONE_REASONS) + '"', allow_blank=True)
    for validation in (tables, reasons):
        sheet.add_data_validation(validation)
    tables.add(f"D2:D{last_row}")
    reasons.add(f"E2:E{last_row}")
    workbook.active = 1
    neutralise_formulas(workbook)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue(), f"Daily_Washing_{month_key}.xlsx"


# ───────────────────────── upload ─────────────────────────
@dataclass
class _Planned:
    """A confirmed report (saved or about to be) used to work out cycle numbers before anything is written."""
    report_date: date
    order: tuple
    tables_cleaned: int
    cycle_no: int
    cycle_completed: bool = False


def _whole_number(text: str) -> int:
    value = float(text.replace(",", ""))
    if not value.is_integer() or not 0 <= value <= MAX_TABLES:
        raise ValueError
    return int(value)


def import_daily(db: Session, user: User, filename: str, content: bytes, *, dry_run: bool) -> dict[str, Any]:
    manager = _require_reporter(db, user)
    headers, rows = read_upload_rows(filename, content, sheet=SHEET, max_bytes=MAX_DAILY_BYTES,
                                     max_rows=MAX_DAILY_ROWS, row_label="day rows")
    columns = map_columns(headers, ALIASES)
    if "site_code" not in columns or "date" not in columns:
        raise HTTPException(422, 'The file needs a "Site code" column and a "Date" column')
    if "tables" not in columns and "reason" not in columns:
        raise HTTPException(422, 'The file needs a "Tables cleaned" column (and optionally "Not done reason")')

    allowed = _allowed_plants(db, user, manager)
    plants = plant_code_index(db.scalars(select(Plant)))
    reasons = {reason.casefold(): reason for reason in NOT_DONE_REASONS}
    today = business_today()
    records: list[dict[str, Any]] = []
    seen: dict[tuple[UUID, date], int] = {}
    blank = 0
    for number, values in rows:
        def get(field: str) -> Any:
            index = columns.get(field)
            return values[index] if index is not None and index < len(values) else None

        site_text, tables_text = cell_text(get("site_code")), cell_text(get("tables"))
        reason_text, remarks = cell_text(get("reason")), cell_text(get("remarks"))
        if not tables_text and not reason_text and not remarks:
            blank += 1  # a pre-filled day left empty
            continue
        errors: list[str] = []
        plant = None
        if not site_text:
            errors.append("Site code is required")
        else:
            plant = plants.get(normalize_site_code(site_text))
            if plant is None:
                errors.append(f"Site code {site_text} was not found")
            elif allowed is not None and plant.id not in allowed:
                errors.append(f"{plant.site_code} is outside your plant scope")
        day = None
        try:
            day = parse_sheet_date(get("date"))
            if day is None:
                errors.append("Date is required")
        except ValueError:
            errors.append(f"Date '{cell_text(get('date'))}' is not a date; use DD-MM-YYYY")
        if day is not None:
            if day > today:
                errors.append("The date cannot be in the future")
            elif not manager and (today - day).days > MAX_BACKDATE_DAYS:
                errors.append(f"A Site Engineer can enter the last {MAX_BACKDATE_DAYS} days only; ask the O&M Head for older dates")
            elif (today - day).days > MAX_HISTORY_DAYS:
                errors.append("Dates more than two years old cannot be uploaded")
        tables = 0
        if tables_text:
            try:
                tables = _whole_number(tables_text)
            except ValueError:
                errors.append(f"Tables cleaned must be a whole number from 0 to {MAX_TABLES}")
        reason = None
        if reason_text:
            reason = reasons.get(reason_text.casefold())
            if reason is None:
                errors.append("Not done reason must be one of: " + ", ".join(NOT_DONE_REASONS))
        if tables and reason_text:
            errors.append("Enter either the tables cleaned or a not-done reason, not both")
        elif not tables and not reason_text and not errors:
            errors.append("Enter the tables cleaned, or the reason washing was not done")
        if len(remarks) > 4000:
            errors.append("Remarks must be 4000 characters or fewer")
        if plant is not None and day is not None and not errors:
            key = (plant.id, day)
            if key in seen:
                errors.append(f"{plant.site_code} on {day.strftime('%d-%m-%Y')} appears more than once (also row {seen[key]})")
            else:
                seen[key] = number
        records.append({
            "row": number, "plant": plant, "site_code": plant.site_code if plant else site_text, "date": day,
            "job_status": "Done" if tables else "Not done", "tables": tables, "reason": None if tables else reason,
            "remarks": remarks or None, "errors": errors, "action": "Problem" if errors else "New", "detail": "",
        })

    candidates = [r for r in records if not r["errors"]]
    plant_ids = sorted({r["plant"].id for r in candidates}, key=str)
    configs: dict[UUID, WashingConfig] = {}
    totals: dict[UUID, int] = {}
    existing: list[WashingDailyReport] = []
    if plant_ids:
        stmt = select(WashingConfig).where(WashingConfig.plant_id.in_(plant_ids)).order_by(WashingConfig.plant_id)
        if not dry_run:
            # Same lock as a cycle sheet save (plant order avoids deadlocks): concurrent entries for these plants wait.
            stmt = stmt.with_for_update()
        configs = {config.plant_id: config for config in db.scalars(stmt)}
        totals = {plant_id: _plant_table_count(db, plant_id, config) for plant_id, config in configs.items()}
        months = sorted({_month_key(r["date"]) for r in candidates})
        existing = list(db.scalars(select(WashingDailyReport).where(
            WashingDailyReport.plant_id.in_(plant_ids),
            WashingDailyReport.cycle_month.in_(months),
            WashingDailyReport.review_status.in_(["Pending", "Confirmed"]),
        )))
    taken = {(report.plant_id, report.report_date): report for report in existing}

    for record in candidates:
        plant, day = record["plant"], record["date"]
        if totals.get(plant.id, 0) < 1:
            record["errors"].append(f"Washing has not been set up for {plant.site_code}; set it up first")
            continue
        saved = taken.get((plant.id, day))
        if saved is None:
            continue
        same = (saved.job_status == record["job_status"] and saved.tables_cleaned == record["tables"]
                and (saved.exception_reason or None) == record["reason"])
        status = "confirmed" if saved.review_status == "Confirmed" else "pending review"
        if same:
            record["action"] = "Unchanged"
            record["detail"] = f"Already saved ({status})" + ("; the remark change is ignored" if (saved.remarks or None) != record["remarks"] else "")
        else:
            record["errors"].append(
                f"Already saved for {_day_label(day)} as {_describe(saved.job_status, saved.tables_cleaned, saved.exception_reason)} "
                f"({status}). Change that day in the plant's washing sheet in the portal")

    # Work out each new day's cycle exactly as saving them one by one in date order would (see _add_report).
    new_records = sorted((r for r in candidates if not r["errors"] and r["action"] == "New"),
                         key=lambda r: (str(r["plant"].id), r["date"]))
    state: dict[tuple[UUID, str], list[_Planned]] = {}
    for report in existing:
        if report.review_status == "Confirmed":
            state.setdefault((report.plant_id, report.cycle_month), []).append(_Planned(
                report.report_date, (0, report.created_at.timestamp() if report.created_at else 0.0),
                report.tables_cleaned, report.cycle_no, bool(report.cycle_completed)))
    for sequence, record in enumerate(new_records):
        plant, day = record["plant"], record["date"]
        month = _month_key(day)
        rows_of_month = state.setdefault((plant.id, month), [])
        cycle_no = _open_cycle_no({row.cycle_no for row in rows_of_month if row.cycle_completed})
        if cycle_no is None:
            record["errors"].append(f"All three washing cycles of {day.strftime('%B %Y')} are already complete for {plant.site_code}")
            continue
        record["cycle_no"] = cycle_no
        if manager:
            planned = _Planned(day, (1, sequence), record["tables"], cycle_no)
            rows_of_month.append(planned)
            cycle_rows = sorted((row for row in rows_of_month if row.cycle_no == cycle_no), key=lambda row: (row.report_date, row.order))
            for row in cycle_rows:
                row.cycle_completed = False
            completing = _completing_row(cycle_rows, totals[plant.id])
            if completing is not None:
                completing.cycle_completed = True
            record["planned"] = planned
    for record in new_records:
        if record["errors"]:
            continue
        record["detail"] = f"{_describe(record['job_status'], record['tables'], record['reason'])} · Cycle {record['cycle_no']}"
        if record.get("planned") is not None and record["planned"].cycle_completed:
            record["detail"] += " · completes the cycle"

    for record in records:
        if record["errors"]:
            record["action"] = "Problem"
    problems = [{"row": r["row"], "errors": r["errors"]} for r in records if r["errors"]]
    to_save = [r for r in new_records if not r["errors"]]
    result: dict[str, Any] = {
        "kind": "daily",
        "new": len(to_save),
        "unchanged": sum(1 for r in records if r["action"] == "Unchanged"),
        "blank": blank,
        "problems": problems,
        "plants": len({r["plant"].id for r in to_save}),
        "tables": sum(r["tables"] for r in to_save),
        "review_status": "Confirmed" if manager else "Pending",
        "saved": 0,
        "rows": [{
            "row": r["row"], "site_code": r["site_code"], "plant": r["plant"].plant_name if r["plant"] else "",
            "date": r["date"].isoformat() if r["date"] else "", "action": r["action"], "detail": r["detail"],
            "errors": r["errors"],
        } for r in records],
    }
    if dry_run or problems or not to_save:
        db.rollback()  # releases the plant locks; nothing was written
        return result

    try:
        now = datetime.now(timezone.utc)
        created: list[tuple[dict[str, Any], WashingDailyReport]] = []
        for record in to_save:
            report = WashingDailyReport(
                plant_id=record["plant"].id, cycle_month=_month_key(record["date"]), cycle_no=record["cycle_no"],
                report_date=record["date"], job_status=record["job_status"], tables_cleaned=record["tables"],
                cleaned_table_codes=[], remarks=record["remarks"], exception_reason=record["reason"],
                reported_by_id=user.id, reported_by=user.display_name,
            )
            if manager:
                report.review_status = "Confirmed"
                report.reviewed_by_id = user.id
                report.reviewed_by = user.display_name
                report.reviewed_at = now
                report.review_note = "Entered by O&M"
            db.add(report)
            created.append((record, report))
        db.flush()
        if manager:
            for plant_id, month, cycle_no in sorted({(str(r.plant_id), r.cycle_month, r.cycle_no) for _rec, r in created}):
                _refresh_cycle_completion(db, UUID(plant_id), month, cycle_no, totals[UUID(plant_id)])
        for record, report in created:
            db.add(AuditLog(
                user_id=user.id, actor_name=user.display_name, action="Submitted daily washing report",
                module="Washing", entity_type="washing_daily_report", entity_id=str(report.id),
                metadata_json={"plant": record["plant"].site_code, "cycle_month": report.cycle_month, "cycle_no": report.cycle_no,
                               "report_date": report.report_date.isoformat(), "job_status": report.job_status,
                               "tables_cleaned": report.tables_cleaned, "exception_reason": report.exception_reason,
                               "cycle_completed": bool(report.cycle_completed), "source": "excel-upload", "row": record["row"]},
            ))
        if not manager:
            by_plant: dict[UUID, list[WashingDailyReport]] = {}
            for _record, report in created:
                by_plant.setdefault(report.plant_id, []).append(report)
            for plant_id, reports in by_plant.items():
                reports.sort(key=lambda report: report.report_date)
                plant = next(r["plant"] for r, _rep in created if r["plant"].id == plant_id)
                done = [report for report in reports if report.job_status == "Done"]
                not_done = len(reports) - len(done)
                span = _day_label(reports[0].report_date) if len(reports) == 1 else f"{_day_label(reports[0].report_date)} – {_day_label(reports[-1].report_date)}"
                _notify_wash(
                    db, plant, configs[plant_id],
                    event_type="washing_daily_report",
                    title=f"Washing sheet awaiting review — Cycle {', '.join(str(n) for n in sorted({r.cycle_no for r in reports}))}",
                    message=(f"{user.display_name} uploaded {len(reports)} day{'s' if len(reports) != 1 else ''} ({span}): "
                             f"{sum(report.tables_cleaned for report in done)} tables cleaned"
                             + (f", {not_done} day{'s' if not_done != 1 else ''} not done" if not_done else "")
                             + ". Review required."),
                    dedupe_key=f"washing-upload:{reports[0].id}",
                    extra_user_ids=[user.id],
                )
        db.add(AuditLog(
            user_id=user.id, actor_name=user.display_name, action="Uploaded daily washing", module="Washing",
            metadata_json={"saved": len(created), "unchanged": result["unchanged"], "blank": blank,
                           "plants": result["plants"], "review_status": result["review_status"]},
        ))
        db.commit()
    except Exception:
        db.rollback()
        raise
    result["saved"] = len(created)
    return result
