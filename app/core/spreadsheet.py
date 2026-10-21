"""Spreadsheet export safety and upload reading.

openpyxl stores any string that starts with "=" as a live formula, so a plant name, note or serial
number typed as ``=HYPERLINK(...)`` would execute when someone opens the export. Exports call
``neutralise_formulas`` just before saving: every formula cell is turned back into the plain text
the user entered. Generated workbooks never contain intended formulas (drop-down lists use data
validation objects, which are unaffected).

Uploads (.xlsx or UTF-8 .csv) are read with ``read_upload_rows``; ``parse_sheet_date`` accepts the
date forms people type in India (DD-MM-YYYY, DD/MM/YYYY, 21-Oct-2026) as well as real Excel dates.
"""
from __future__ import annotations

import csv
import io
import re
from datetime import date, datetime
from typing import Any

from fastapi import HTTPException
from openpyxl import load_workbook
from openpyxl.utils.datetime import from_excel
from openpyxl.workbook.workbook import Workbook


def neutralise_formulas(workbook: Workbook) -> int:
    """Store formula-looking cell values as text. Returns the number of cells changed."""
    changed = 0
    for sheet in workbook.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                if cell.data_type == "f":
                    cell.data_type = "s"
                    changed += 1
    return changed


def header_key(value: Any) -> str:
    """A column title reduced to lower-case words, so "Site Code", "site_code" and "SITE  CODE" all match."""
    return " ".join(re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).split())


def cell_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


_DATE_FORMATS = ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y", "%d-%b-%Y", "%d %b %Y", "%d-%B-%Y", "%d %B %Y",
                 "%d-%m-%y", "%d/%m/%y", "%d-%b-%y")


def parse_sheet_date(value: Any) -> date | None:
    """A date typed or stored in a spreadsheet cell. Blank gives None; anything unreadable raises ValueError.
    Day comes before month in typed dates (21/10/2026), as in India."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if 36526 <= value <= 73051:  # an Excel serial day number between 2000 and 2099
            return from_excel(value).date()
        raise ValueError(str(value))
    text = str(value).strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?", text):
        text = text[:10]
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise ValueError(text)


def read_upload_rows(
    filename: str, content: bytes, *, sheet: str, max_bytes: int, max_rows: int, row_label: str = "rows",
) -> tuple[list[str], list[tuple[int, list[Any]]]]:
    """The header keys (see ``header_key``) and the non-blank data rows, with their spreadsheet row numbers, of an
    uploaded .xlsx or UTF-8 .csv file. A workbook is read from the named sheet when it has one, else its first sheet."""
    if len(content) > max_bytes:
        raise HTTPException(413, f"The file must be {max_bytes // (1024 * 1024)} MB or smaller")
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if suffix == "csv":
        try:
            matrix: Any = csv.reader(io.StringIO(content.decode("utf-8-sig"), newline=""))
        except UnicodeDecodeError as exc:
            raise HTTPException(422, "The CSV must use UTF-8 encoding") from exc
        workbook = None
    elif suffix == "xlsx":
        try:
            workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        except Exception as exc:
            raise HTTPException(422, "The Excel file could not be opened") from exc
        source = workbook[sheet] if sheet in workbook.sheetnames else workbook.worksheets[0]
        matrix = source.iter_rows(values_only=True)
    else:
        raise HTTPException(422, "Choose an .xlsx or .csv file")
    try:
        first = next(matrix, None)
        if first is None:
            raise HTTPException(422, "The file is empty")
        headers = [header_key(value) for value in first]
        rows: list[tuple[int, list[Any]]] = []
        for number, values in enumerate(matrix, start=2):
            values = list(values)
            if not any(cell_text(value) for value in values):
                continue
            if len(rows) >= max_rows:
                raise HTTPException(422, f"The file can contain at most {max_rows} {row_label}")
            rows.append((number, values))
    except csv.Error as exc:
        raise HTTPException(422, "The CSV could not be read; check its quotes and commas") from exc
    finally:
        if workbook is not None:
            workbook.close()
    return headers, rows


def map_columns(headers: list[str], aliases: dict[str, set[str]]) -> dict[str, int]:
    """Column index of each field whose title (or one of its accepted alternatives) appears in the header row."""
    columns: dict[str, int] = {}
    for field, names in aliases.items():
        wanted = {header_key(name) for name in names}
        for index, header in enumerate(headers):
            if header in wanted:
                columns[field] = index
                break
    return columns
