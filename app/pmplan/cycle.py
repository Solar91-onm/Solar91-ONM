"""Monthly Preventive Maintenance cycle: the order, area and days each equipment type takes at a plant.

A cycle is CYCLE_DAYS (30) days from its start date, the same length as the Monthly recurrence
(FREQ_DAYS["Monthly"]), so every unit comes back on the same cycle day next month.

  Plant side   Inverter (all units)            7 days
               ACCB Panel (ACCB-1, -2) + MCCB  2 days, done together
               VCB Panel                       2 days
               Transformer (IDT)               2 days
               Aux. Transformer                2 days
               4 Pole                          2 days
               Earthing (earth pit)            2 days
               Miscellaneous                   3 days  (every type not named in this table)
               Transmission line               remaining days
  GSS side     VCB - GSS side                  2 days
               4 Pole - GSS side               2 days
               Transmission line - GSS side    remaining days

The two "remaining days" phases share what is left of the 30 days after the fixed phases (4 days -> 2 each).
Used only by Preventive Maintenance planning (Add PM task, Assign to plants, Excel/CSV upload).
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

CYCLE_DAYS = 30
MISC = "Miscellaneous"

# (area, phase name, equipment types, days; None = share the remaining days)
_PHASES: list[tuple[str, str, tuple[str, ...], int | None]] = [
    ("Plant side", "Inverter", ("Inverter",), 7),
    ("Plant side", "ACCB + MCCB", ("ACCB Panel", "MCCB"), 2),
    ("Plant side", "VCB", ("VCB Panel",), 2),
    ("Plant side", "IDT Transformer", ("Transformer",), 2),
    ("Plant side", "Aux. Transformer", ("Aux. Transformer",), 2),
    ("Plant side", "4 Pole", ("4 Pole",), 2),
    ("Plant side", "Earth pit", ("Earthing",), 2),
    ("Plant side", MISC, (), 3),
    ("Plant side", "Transmission line", ("Transmission line",), None),
    ("GSS side", "VCB", ("VCB - GSS side",), 2),
    ("GSS side", "4 Pole", ("4 Pole - GSS side",), 2),
    ("GSS side", "Transmission line", ("Transmission line - GSS side",), None),
]


def _build() -> list[dict[str, Any]]:
    fixed = sum(d for *_, d in _PHASES if d)
    flex = [i for i, (*_, d) in enumerate(_PHASES) if d is None]
    left = max(len(flex), CYCLE_DAYS - fixed)
    share = {i: left // len(flex) + (1 if k < left % len(flex) else 0) for k, i in enumerate(flex)}
    out, day = [], 1
    for i, (area, name, types, days) in enumerate(_PHASES):
        n = days or share[i]
        out.append({"area": area, "phase": name, "equipment_types": list(types), "start_day": day,
                    "end_day": day + n - 1, "days": n})
        day += n
    return out


CYCLE = _build()
_BY_TYPE = {t.casefold(): p for p in CYCLE for t in p["equipment_types"]}
_MISC_PHASE = next(p for p in CYCLE if p["phase"] == MISC)


def phase_for(equipment_type: str) -> dict[str, Any]:
    """The phase an equipment type is maintained in; types not named in the cycle go to Miscellaneous."""
    return _BY_TYPE.get((equipment_type or "").strip().casefold(), _MISC_PHASE)


def window(equipment_type: str, cycle_start: date) -> dict[str, Any]:
    """Dates of this equipment's phase in the cycle that starts on `cycle_start`."""
    p = phase_for(equipment_type)
    start = cycle_start + timedelta(days=p["start_day"] - 1)
    return {**p, "cycle_start": cycle_start, "start": start, "end": start + timedelta(days=p["days"] - 1)}


def window_out(w: dict[str, Any]) -> dict[str, Any]:
    return {"area": w["area"], "phase": w["phase"], "start_day": w["start_day"], "end_day": w["end_day"],
            "days": w["days"], "cycle_start": w["cycle_start"].isoformat(), "start": w["start"].isoformat(),
            "end": w["end"].isoformat()}
