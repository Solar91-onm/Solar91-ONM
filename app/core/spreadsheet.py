"""Spreadsheet export safety.

openpyxl stores any string that starts with "=" as a live formula, so a plant name, note or serial
number typed as ``=HYPERLINK(...)`` would execute when someone opens the export. Exports call
``neutralise_formulas`` just before saving: every formula cell is turned back into the plain text
the user entered. Generated workbooks never contain intended formulas (drop-down lists use data
validation objects, which are unaffected).
"""
from __future__ import annotations

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
