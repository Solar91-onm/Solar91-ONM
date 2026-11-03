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
