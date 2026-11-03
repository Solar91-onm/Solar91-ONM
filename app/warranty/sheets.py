"""Asset & Warranty as a spreadsheet: a blank template, the current register, and the upload.

One row is one equipment, or one part of one equipment, at one plant, with its warranty and
certification dates. The column order is the same in all three directions, so an exported register
can be corrected and sent straight back.

`Certification file` is deliberately present and deliberately empty: the certificate itself will be
served by an API that does not exist yet. Keeping the column now means the sheet people fill in
today is the same sheet that works once that API lands, and nothing has to be re-imported.

Upload follows the pattern the other importers use: every row is validated first and nothing is
saved while any row has a problem, so a half-correct file cannot leave the register half-filled.
"""
from __future__ import annotations

import io
from datetime import date
from typing import Any

from fastapi import HTTPException
from openpyxl import Workbook
from openpyxl.styles import Font
from openpyxl.worksheet.datavalidation import DataValidation
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.models import AssetWarranty, AuditLog, Plant, User
from app.core.security import has_portfolio_scope, user_scoped_plant_ids
from app.core.spreadsheet import (cell_text, map_columns, neutralise_formulas, parse_sheet_date,
                                  read_upload_rows)
from app.plants.codes import normalize_site_code

SHEET = "Asset & Warranty"
MAX_BYTES = 2 * 1024 * 1024
MAX_ROWS = 2000
MAX_EXPORT_ROWS = 20000

HEADERS = ("Site code", "Plant name", "Equipment", "Part", "Part number", "Make", "Serial number",
           "Quantity", "Warranty start", "Warranty end", "Certification date",
           "Certification expiry", "Certification file", "Remarks")

ALIASES: dict[str, set[str]] = {
    "site_code": {"Site code", "Plant code", "Site", "Code"},
    "equipment": {"Equipment", "Equipment name", "Asset", "Item"},
    "part": {"Part", "Component", "Part name"},
    "part_number": {"Part number", "Part no", "Part no."},
    "make": {"Make", "Manufacturer", "Brand", "OEM"},
    "serial_no": {"Serial number", "Serial no", "Serial", "Serial no."},
    "quantity": {"Quantity", "Qty", "Count", "No. of units"},
    "warranty_start": {"Warranty start", "Warranty from", "Warranty start date"},
    "warranty_end": {"Warranty end", "Warranty to", "Warranty expiry", "Warranty end date"},
    "certification_date": {"Certification date", "Certified on", "Certificate date"},
    "certification_expiry": {"Certification expiry", "Certificate expiry", "Certification valid till"},
    "certification_file": {"Certification file", "Certificate file", "Certificate"},
    "remarks": {"Remarks", "Remark", "Notes", "Comments"},
}

_DATE_FIELDS = ("warranty_start", "warranty_end", "certification_date", "certification_expiry")


def _scoped_plants(db: Session, user: User) -> set | None:
    return None if has_portfolio_scope(user) else (user_scoped_plant_ids(db, user) or set())


def _visible_plants(db: Session, user: User) -> list[Plant]:
    allowed = _scoped_plants(db, user)
    return [plant for plant in db.scalars(select(Plant).order_by(Plant.site_code))
            if allowed is None or plant.id in allowed]


def _plant_for_code(db: Session, user: User, site_code: str) -> Plant:
    wanted = normalize_site_code(site_code)
    match = next((p for p in db.scalars(select(Plant))
                  if normalize_site_code(p.site_code) == wanted), None)
    if match is None:
        raise HTTPException(404, "No plant matches that site code")
    allowed = _scoped_plants(db, user)
    if allowed is not None and match.id not in allowed:
        raise HTTPException(403, "That plant is outside your scope")
    return match


def _write_sheet(sheet, rows: list[list[Any]], *, blank_rows: int = 0) -> None:
    """Header, column widths and date formats, plus `rows`.

    `blank_rows` pre-formats empty rows below the data so a template's date columns are already
    DD-MM-YYYY when someone types into them. An export passes 0: formatting rows that hold nothing
    would add thousands of empty rows to the file and to anything that reads it back.
    """
    sheet.append(list(HEADERS))
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = f"A1:{sheet.cell(1, len(HEADERS)).column_letter}1"
    for row in rows:
        sheet.append(row)
    for index, width in enumerate((14, 28, 26, 22, 18, 20, 20, 10, 16, 16, 18, 20, 28, 34), start=1):
        sheet.column_dimensions[sheet.cell(1, index).column_letter].width = width
    # Columns I to L are the four dates.
    for column in ("I", "J", "K", "L"):
        for number in range(2, max(len(rows), blank_rows) + 2):
            sheet[f"{column}{number}"].number_format = "DD-MM-YYYY"


def _guidance(workbook: Workbook) -> None:
    guide = workbook.active
    guide.title = "How to fill"
    for text in (
        "One row is one equipment, or one part of one equipment, at one plant.",
        "Required: Site code and Equipment. Everything else is optional and can be filled in later.",
        "Part: the component the warranty covers, e.g. 'Cooling fan'. Leave it blank for the equipment as a whole.",
        "Dates are DD-MM-YYYY. Warranty end cannot be before warranty start; the same applies to the certification dates.",
        "Certification file: leave this column EMPTY. The certificate will be fetched automatically once that service is "
        "connected; the column is here so the sheet does not have to change then.",
        "Site code, Equipment, Part and Part number together identify a row. Uploading the same file again updates "
        "those rows instead of adding duplicates.",
        "The file is checked first and every problem is reported before anything is saved.",
    ):
        guide.append([text])
    guide.column_dimensions["A"].width = 118


def template_bytes(db: Session, user: User, *, site_code: str | None = None) -> bytes:
    """A blank workbook with the columns the upload accepts, and the caller's plants to pick from."""
    plants = [_plant_for_code(db, user, site_code)] if site_code else _visible_plants(db, user)
    workbook = Workbook()
    _guidance(workbook)
    sheet = workbook.create_sheet(SHEET)
    _write_sheet(sheet, [], blank_rows=MAX_ROWS)

    lists = workbook.create_sheet("Lists")
    lists.append(["Site codes", "Plant names"])
    for number, plant in enumerate(plants[:MAX_ROWS], start=2):
        lists.cell(number, 1, plant.site_code)
        lists.cell(number, 2, plant.plant_name)
    lists.sheet_state = "hidden"
    last = MAX_ROWS + 1
    for validation, cells in (
        (DataValidation(type="list", formula1=f"'Lists'!$A$2:$A${max(2, len(plants) + 1)}", allow_blank=True), f"A2:A{last}"),
        (DataValidation(type="whole", operator="between", formula1="0", formula2="100000", allow_blank=True), f"H2:H{last}"),
    ):
        sheet.add_data_validation(validation)
        validation.add(cells)
    workbook.active = 1
    neutralise_formulas(workbook)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def export_bytes(db: Session, user: User, *, site_code: str | None = None) -> bytes:
    """The current Asset & Warranty register for the caller's scope, in the upload's column order."""
    if site_code:
        plants = {p.id: p for p in [_plant_for_code(db, user, site_code)]}
    else:
        plants = {p.id: p for p in _visible_plants(db, user)}
    statement = select(AssetWarranty).where(AssetWarranty.plant_id.in_(list(plants)) if plants else False)
    rows = list(db.scalars(
        statement.order_by(AssetWarranty.equipment, AssetWarranty.part).limit(MAX_EXPORT_ROWS)
    )) if plants else []

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = SHEET
    _write_sheet(sheet, [[
        plants[item.plant_id].site_code if item.plant_id in plants else None,
        plants[item.plant_id].plant_name if item.plant_id in plants else None,
        item.equipment, item.part, item.part_number, item.make, item.serial_no, item.quantity,
        item.warranty_start, item.warranty_end, item.certification_date, item.certification_expiry,
        item.certification_file, item.remarks,
    ] for item in rows])
    neutralise_formulas(workbook)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def import_rows(db: Session, user: User, filename: str, content: bytes, *, dry_run: bool) -> dict[str, Any]:
    """Validate every row, then save them all or none.

    A row that matches one already stored (same plant, equipment, part and part number) updates it;
    anything else is added. Nothing is deleted: removing a line from the spreadsheet does not remove
    the equipment, because a partial sheet is far more common than a genuine decommissioning.
    """
    headers, raw_rows = read_upload_rows(filename, content, sheet=SHEET, max_bytes=MAX_BYTES,
                                         max_rows=MAX_ROWS, row_label="equipment rows")
    columns = map_columns(headers, ALIASES)
    for required in ("site_code", "equipment"):
        if required not in columns:
            raise HTTPException(422, {
                "message": "Missing required column",
                "required": ["Site code", "Equipment"],
                "found": headers,
            })

    plants_by_code = {normalize_site_code(p.site_code): p for p in db.scalars(select(Plant))}
    allowed = _scoped_plants(db, user)
    existing = {
        (item.plant_id, (item.equipment or "").strip().casefold(),
         (item.part or "").strip().casefold(), (item.part_number or "").strip().casefold()): item
        for item in db.scalars(select(AssetWarranty))
    }

    problems: list[dict[str, Any]] = []
    records: list[dict[str, Any]] = []
    seen: set[tuple] = set()

    for number, values in raw_rows:
        def get(field: str) -> Any:
            index = columns.get(field)
            return values[index] if index is not None and index < len(values) else None

        errors: list[str] = []
        site_text = cell_text(get("site_code"))
        equipment = cell_text(get("equipment"))
        if not site_text:
            errors.append("Site code is required")
        if not equipment:
            errors.append("Equipment is required")
        plant = plants_by_code.get(normalize_site_code(site_text)) if site_text else None
        if site_text and plant is None:
            errors.append(f"No plant matches site code {site_text}")
        if plant is not None and allowed is not None and plant.id not in allowed:
            errors.append(f"{plant.site_code} is outside your plants")

        dates: dict[str, date | None] = {}
        for field in _DATE_FIELDS:
            try:
                dates[field] = parse_sheet_date(get(field))
            except ValueError:
                errors.append(f"{field.replace('_', ' ').capitalize()} is not a date (use DD-MM-YYYY)")
                dates[field] = None
        if dates.get("warranty_start") and dates.get("warranty_end") and dates["warranty_end"] < dates["warranty_start"]:
            errors.append("Warranty end is before warranty start")
        if (dates.get("certification_date") and dates.get("certification_expiry")
                and dates["certification_expiry"] < dates["certification_date"]):
            errors.append("Certification expiry is before the certification date")

        quantity: int | None = None
        quantity_text = cell_text(get("quantity"))
        if quantity_text:
            try:
                quantity = int(float(quantity_text))
                if quantity < 0:
                    errors.append("Quantity cannot be negative")
            except ValueError:
                errors.append("Quantity must be a whole number")

        part = cell_text(get("part")) or None
        part_number = cell_text(get("part_number")) or None
        if plant is not None and equipment:
            key = (plant.id, equipment.casefold(), (part or "").casefold(), (part_number or "").casefold())
            if key in seen:
                errors.append("The same equipment and part appears twice in this file")
            seen.add(key)
        else:
            key = None

        if cell_text(get("certification_file")):
            # Accepted and ignored rather than rejected: people will paste a file name in, and
            # failing the whole upload over a column that is not connected yet would be unkind.
            pass

        if errors:
            problems.append({"row": number, "errors": errors})
            continue
        records.append({
            "row": number, "key": key, "plant": plant, "equipment": equipment, "part": part,
            "part_number": part_number, "make": cell_text(get("make")) or None,
            "serial_no": cell_text(get("serial_no")) or None, "quantity": quantity,
            "remarks": cell_text(get("remarks")) or None, **dates,
        })

    added = sum(1 for record in records if record["key"] not in existing)
    result: dict[str, Any] = {
        "dry_run": dry_run,
        "rows": len(records),
        "new": added,
        "updated": len(records) - added,
        "problems": problems,
        "saved": 0,
    }
    if dry_run or problems or not records:
        return result

    for record in records:
        item = existing.get(record["key"])
        if item is None:
            item = AssetWarranty(plant_id=record["plant"].id, equipment=record["equipment"],
                                 part=record["part"], part_number=record["part_number"],
                                 created_by=user.id)
            db.add(item)
            existing[record["key"]] = item
        for field in ("make", "serial_no", "quantity", "remarks", *_DATE_FIELDS):
            if record[field] is not None:
                setattr(item, field, record[field])
    db.add(AuditLog(user_id=user.id, actor_name=user.display_name, action="Uploaded asset & warranty records",
                    module="Asset & Warranty",
                    metadata_json={"rows": len(records), "new": added, "updated": len(records) - added}))
    db.commit()
    result["saved"] = len(records)
    return result
