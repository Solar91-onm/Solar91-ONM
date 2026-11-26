"""PM plan workbook downloads: a blank upload template, and the current PM register.

The upload side already exists (``POST /api/pm-plan/import``); this is the other half, so a planner can
pull the plan down, correct it and send it back. Column order matches what ``_read_plan`` accepts, and
both sheets are run through ``neutralise_formulas`` so a cell beginning ``=``, ``+``, ``-`` or ``@`` is
never executed when the file is opened.
"""
from __future__ import annotations

import io

from fastapi import HTTPException
from openpyxl import Workbook
from openpyxl.styles import Font
from openpyxl.worksheet.datavalidation import DataValidation
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.models import OMTask, Plant, User
from app.core.security import has_portfolio_scope, user_scoped_plant_ids
from app.core.spreadsheet import neutralise_formulas
from app.plants.codes import normalize_site_code
from app.scheduled.schemas import ALLOWED_ASSETS, ALLOWED_FREQUENCIES

SHEET = "PM Tasks"
TEMPLATE_HEADERS = ("Equipment type", "Task", "How / steps", "Frequency", "Plants", "No. of units",
                    "Units per day", "Start date", "Assignees", "Safety", "Time (hours)",
                    "Readings / checks", "Remarks")
EXPORT_HEADERS = ("Work order", "Site code", "Plant name", "Equipment type", "Task", "Frequency",
                  "Status", "Start date", "Planned due", "Due date", "Completed on", "Assignee",
                  "Unit", "Of units", "Duration", "Problem found")
MAX_TEMPLATE_ROWS = 500
MAX_EXPORT_ROWS = 20000


def _scoped_plants(db: Session, user: User) -> set | None:
    return None if has_portfolio_scope(user) else (user_scoped_plant_ids(db, user) or set())


def template_bytes(db: Session, user: User) -> bytes:
    """A blank PM plan workbook: headers, guidance, and drop-downs built from live configuration."""
    allowed = _scoped_plants(db, user)
    plants = [p for p in db.scalars(select(Plant).order_by(Plant.site_code))
              if allowed is None or p.id in allowed]
    assets = sorted(ALLOWED_ASSETS)
    frequencies = sorted(ALLOWED_FREQUENCIES)

    workbook = Workbook()
    guide = workbook.active
    guide.title = "How to fill"
    for text in (
        "One row is one PM task for one equipment type. Fill the 'PM Tasks' sheet; drop-down lists are on 'Lists'.",
        "Required: Equipment type and Task. A row whose Task starts with EXAMPLE is ignored.",
        "Plants: one or more site codes separated by commas. Blank means the task is saved as a template only.",
        "Frequency must be one of Daily, Weekly, Monthly, Quarterly, Half-yearly or Annual.",
        "No. of units is how many of that equipment exist at the plant; Units per day is how many are done per day.",
        "Start date (DD-MM-YYYY) is the first due date. Blank starts three days from today.",
        "Upload is checked first and reports every problem before anything is saved.",
    ):
        guide.append([text])
    guide.column_dimensions["A"].width = 112

    sheet = workbook.create_sheet(SHEET)
    sheet.append(TEMPLATE_HEADERS)
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    sheet.freeze_panes = "A2"
    for index, width in enumerate((26, 34, 40, 16, 28, 13, 13, 14, 26, 30, 13, 30, 40), start=1):
        sheet.column_dimensions[sheet.cell(1, index).column_letter].width = width
    for row in range(2, MAX_TEMPLATE_ROWS + 2):
        sheet[f"H{row}"].number_format = "DD-MM-YYYY"

    lists = workbook.create_sheet("Lists")
    lists.append(["Equipment types", "Frequencies", "Site codes", "Plant names"])
    for row, value in enumerate(assets, start=2):
        lists.cell(row, 1, value)
    for row, value in enumerate(frequencies, start=2):
        lists.cell(row, 2, value)
    for row, plant in enumerate(plants[:MAX_TEMPLATE_ROWS], start=2):
        lists.cell(row, 3, plant.site_code)
        lists.cell(row, 4, plant.plant_name)
    lists.sheet_state = "hidden"

    last = MAX_TEMPLATE_ROWS + 1
    for validation, cells in (
        (DataValidation(type="list", formula1=f"'Lists'!$A$2:$A${max(2, len(assets) + 1)}", allow_blank=True), f"A2:A{last}"),
        (DataValidation(type="list", formula1=f"'Lists'!$B$2:$B${max(2, len(frequencies) + 1)}", allow_blank=True), f"D2:D{last}"),
        (DataValidation(type="whole", operator="between", formula1="1", formula2="5000", allow_blank=True), f"F2:F{last}"),
        (DataValidation(type="whole", operator="between", formula1="1", formula2="5000", allow_blank=True), f"G2:G{last}"),
    ):
        sheet.add_data_validation(validation)
        validation.add(cells)
    workbook.active = 1
    neutralise_formulas(workbook)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def export_bytes(db: Session, user: User, *, site_code: str | None = None) -> bytes:
    """The current PM work orders in the caller's plant scope, newest due first."""
    allowed = _scoped_plants(db, user)
    plants = {plant.id: plant for plant in db.scalars(select(Plant))}
    statement = select(OMTask)
    if allowed is not None:
        if not allowed:
            statement = statement.where(False)
        else:
            statement = statement.where(OMTask.plant_id.in_(allowed))
    if site_code:
        wanted = normalize_site_code(site_code)
        match = next((p for p in plants.values() if normalize_site_code(p.site_code) == wanted), None)
        if match is None:
            raise HTTPException(404, "No plant matches that site code")
        if allowed is not None and match.id not in allowed:
            raise HTTPException(403, "That plant is outside your scope")
        statement = statement.where(OMTask.plant_id == match.id)
    # Bounded: a register download must not become an unbounded table read.
    rows = list(db.scalars(statement.order_by(OMTask.due_on.desc()).limit(MAX_EXPORT_ROWS)))

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = SHEET
    sheet.append(EXPORT_HEADERS)
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = f"A1:{sheet.cell(1, len(EXPORT_HEADERS)).column_letter}1"
    for task in rows:
        plant = plants.get(task.plant_id)
        sheet.append([
            task.work_order_no,
            plant.site_code if plant else None,
            plant.plant_name if plant else None,
            task.task_type,
            task.task_name,
            task.frequency,
            task.status,
            task.start_on,
            task.planned_due_on,
            task.due_on,
            task.actual_completed_on,
            task.assignee_text,
            task.unit_no,
            task.total_units,
            task.duration,
            "Yes" if task.problem_found else "No",
        ])
    for index, width in enumerate((22, 14, 30, 24, 34, 14, 16, 14, 14, 14, 15, 24, 8, 10, 14, 14), start=1):
        sheet.column_dimensions[sheet.cell(1, index).column_letter].width = width
    for column in ("H", "I", "J", "K"):
        for row in range(2, len(rows) + 2):
            sheet[f"{column}{row}"].number_format = "DD-MM-YYYY"
    neutralise_formulas(workbook)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def export_tracking_summary_bytes(db, user, month: str) -> bytes:
    """Two-sheet XLSX: plant-level PM summary + equipment matrix for one month.

    Sheet 1 — Plant Summary: S.No | Site code | WOC Month | Scheduled | Completed | Overdue |
              Completion% | Status  (paused plants show dashes, neutral fill, excluded from totals)
    Sheet 2 — Equipment Matrix: plants as rows, each equipment category as a column, cell shows the
              label for that equipment in the month (Scheduled / Locked / In Progress / Approved /
              Overdue / Returned / Paused / dash).  Row header = Site code.

    Calls neutralise_formulas() before saving.
    """
    import re as _re
    from openpyxl import Workbook as _WB
    from openpyxl.styles import PatternFill as _PF, Font as _Font, Alignment as _Align
    from app.pmplan.tracking import CATEGORIES, _bounds, _rows, _blocker, _out
    from app.core.models import PMCyclePlan
    from app.core.timeutil import business_today
    from sqlalchemy import select as _select, or_ as _or

    # ----- scope + data -----------------------------------------------
    allowed = None if has_portfolio_scope(user) else (user_scoped_plant_ids(db, user) or set())
    q = _select(Plant).where(
        _or(Plant.status.is_(None), ~Plant.status.ilike("inactive"))
    ).order_by(Plant.plant_name, Plant.site_code)
    if allowed is not None:
        q = q.where(Plant.id.in_(allowed))
    plants_list = list(db.scalars(q))
    ids = [p.id for p in plants_list]

    configured = {r.plant_id for r in db.scalars(
        _select(PMCyclePlan).where(PMCyclePlan.plant_id.in_(ids))
    )} if ids else set()

    woc_months: dict = {}
    for plan in db.scalars(_select(PMCyclePlan).where(PMCyclePlan.plant_id.in_(ids))):
        marker = _re.search(r"\[PM_TRACKING_START=(\d{4}-\d{2})", plan.notes or "")
        if marker:
            woc_months[plan.plant_id] = marker.group(1)

    first, last = _bounds(month)
    rows = _rows(db, ids, first, last, summary=True)
    today = business_today()

    first_open: dict = {}
    for row in rows:
        if row.status != "Approved":
            first_open.setdefault(row.plant_id, row)

    act_by_plant: dict = {}
    for row in rows:
        blocker = _blocker(row, first_open.get(row.plant_id))
        out = _out(row, blocker, user, today, summary=True)
        act_by_plant.setdefault(row.plant_id, []).append(out)

    # ----- fills -------------------------------------------------------
    _FILL_GREEN = _PF(fill_type="solid", fgColor="C6EFCE")
    _FILL_WHITE = _PF(fill_type="solid", fgColor="FFFFFF")
    _FILL_GREY  = _PF(fill_type="solid", fgColor="E0E0E0")
    _FILL_RED   = _PF(fill_type="solid", fgColor="FF9999")
    _EQ_FILL = {
        "Approved":         _PF(fill_type="solid", fgColor="C6EFCE"),
        "Pending approval": _PF(fill_type="solid", fgColor="BDD7EE"),
        "In Progress":      _PF(fill_type="solid", fgColor="FFEB9C"),
        "Overdue":          _PF(fill_type="solid", fgColor="FF9999"),
        "Returned":         _PF(fill_type="solid", fgColor="FFD966"),
        "Locked":           _PF(fill_type="solid", fgColor="E0E0E0"),
        "Scheduled":        _PF(fill_type="solid", fgColor="FFFFFF"),
    }

    def _plant_summary(plant_id):
        acts = act_by_plant.get(plant_id, [])
        if not acts:
            return {"scheduled": 0, "completed": 0, "overdue": 0, "pct": 0, "status": "No activities"}
        scheduled = len(acts)
        completed = sum(1 for a in acts if a["status"] == "Approved")
        overdue   = sum(1 for a in acts if a["label"] == "Overdue")
        pct = round(100 * completed / scheduled) if scheduled else 0
        if completed == scheduled:
            status = "All done"
        elif overdue:
            status = "Overdue"
        else:
            status = "In progress"
        return {"scheduled": scheduled, "completed": completed, "overdue": overdue, "pct": pct, "status": status}

    def _row_fill_summary(sm):
        if sm["status"] == "All done":
            return _FILL_GREEN
        if sm["overdue"]:
            return _FILL_RED
        return _FILL_WHITE

    def _eq_label_for(plant_id, equipment):
        acts = [a for a in act_by_plant.get(plant_id, []) if a["equipment"] == equipment]
        if not acts:
            return None
        order = ["Overdue", "Returned", "Pending approval", "In Progress", "Locked", "Scheduled", "Approved"]
        for target in order:
            if any(a["label"] == target for a in acts):
                return target
        return acts[0]["status"]

    # ----- workbook ---------------------------------------------------
    workbook = _WB()

    # Sheet 1: Plant Summary
    s1 = workbook.active
    s1.title = "Plant Summary"
    hdrs1 = ("S.No", "Site code", "WOC Month", "Scheduled", "Completed", "Overdue", "Completion%", "Status")
    s1.append(hdrs1)
    for cell in s1[1]:
        cell.font = _Font(bold=True)
        cell.alignment = _Align(horizontal="center")
    s1.freeze_panes = "A2"
    s1.auto_filter.ref = f"A1:{s1.cell(1, len(hdrs1)).column_letter}1"

    for sno, plant in enumerate(plants_list, start=1):
        pid = plant.id
        paused = pid not in configured
        woc = woc_months.get(pid, month)
        if paused:
            row_data = [sno, plant.site_code, woc, "—", "—", "—", "—", "Paused"]
            fill = _FILL_GREY
        else:
            sm = _plant_summary(pid)
            row_data = [sno, plant.site_code, woc,
                        sm["scheduled"], sm["completed"], sm["overdue"],
                        sm["pct"], sm["status"]]
            fill = _row_fill_summary(sm)
        s1.append(row_data)
        ri = s1.max_row
        for ci in range(1, len(hdrs1) + 1):
            cell = s1.cell(ri, ci)
            cell.fill = fill
            cell.alignment = _Align(horizontal="center")

    for idx, width in enumerate((6, 14, 12, 12, 12, 10, 14, 16), start=1):
        s1.column_dimensions[s1.cell(1, idx).column_letter].width = width

    # Sheet 2: Equipment Matrix
    s2 = workbook.create_sheet("Equipment Matrix")
    eq_cols = CATEGORIES
    hdrs2 = ["Site code"] + list(eq_cols)
    s2.append(hdrs2)
    for cell in s2[1]:
        cell.font = _Font(bold=True)
        cell.alignment = _Align(horizontal="center")
    s2.freeze_panes = "B2"

    for plant in plants_list:
        pid = plant.id
        paused = pid not in configured
        row_data = [plant.site_code]
        for eq in eq_cols:
            if paused:
                row_data.append("Paused")
            else:
                label = _eq_label_for(pid, eq)
                row_data.append(label if label is not None else "—")
        s2.append(row_data)
        ri = s2.max_row
        s2.cell(ri, 1).alignment = _Align(horizontal="left")
        for ci, eq in enumerate(eq_cols, start=2):
            cell = s2.cell(ri, ci)
            label = cell.value
            if paused or label == "Paused":
                cell.fill = _FILL_GREY
            else:
                cell.fill = _EQ_FILL.get(label, _FILL_WHITE)
            cell.alignment = _Align(horizontal="center")

    s2.column_dimensions["A"].width = 14
    for ci in range(2, len(eq_cols) + 2):
        s2.column_dimensions[s2.cell(1, ci).column_letter].width = 16

    neutralise_formulas(workbook)
    buf = io.BytesIO()
    workbook.save(buf)
    return buf.getvalue()
