"""Monthly Preventive Maintenance cycle: the order, area and days each equipment type takes at a plant.

A cycle is CYCLE_DAYS (30) days from its start date, the same length as the Monthly recurrence
(FREQ_DAYS["Monthly"]), so every unit comes back on the same cycle day next month.

  Plant side   Inverter (all units)            7 days
               ACCB Panel (ACCB-1, -2)         2 days; ACCB-1 + ACCB-2 count as one job
               VCB Panel                       2 days
               Transformer (IDT)               2 days
               Aux. Transformer + ACDB         2 days, shared; two separate jobs, each a single unit per plant
               4 Pole                          2 days
               Earthing (earth pit)            2 days
               Miscellaneous                   3 days  (the Miscellaneous job - Street Light, ERT, ... - counts as
                                                        one job; every type not named in this table is here too)
               Transmission line               remaining days
  GSS side     VCB - GSS side                  2 days
               4 Pole - GSS side               2 days
               Transmission line - GSS side    remaining days

The two "remaining days" phases share what is left of the 30 days after the fixed phases (4 days -> 2 each).

Phases never overlap at a plant (chained_window): a phase starts on its own cycle day or the day after the
previous phase's work ends there, whichever is later. If the inverters at a plant run Nov 5-11 in a cycle that
starts Nov 1, ACCB moves to Nov 12-13 and every later phase, through the GSS side, moves with them.
Used only by Preventive Maintenance planning (Add PM task, Assign to plants, Excel/CSV upload).

NOT_IN_PM types (MCCB) are not maintained under PM at all: no new PM jobs, templates or unit counts for them.
Work orders created before the change are kept as they are.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

CYCLE_DAYS = 30
MISC = "Miscellaneous"
# One PM job per plant whatever the unit count: ACCB-1 and ACCB-2 are maintained together, a plant has one
# Aux. Transformer and one ACDB (separate jobs), and the Miscellaneous job covers the small items
# (Street Light, ERT, ...) in one visit.
ONE_JOB_TYPES = ("ACCB Panel", "Aux. Transformer", "ACDB", MISC)
# Removed from Preventive Maintenance (still an equipment / issue type elsewhere)
NOT_IN_PM = ("MCCB",)

# (area, phase name, equipment types, days; None = share the remaining days)
_PHASES: list[tuple[str, str, tuple[str, ...], int | None]] = [
    ("Plant side", "Inverter", ("Inverter",), 7),
    ("Plant side", "ACCB", ("ACCB Panel",), 2),
    ("Plant side", "VCB", ("VCB Panel",), 2),
    ("Plant side", "IDT Transformer", ("Transformer",), 2),
    ("Plant side", "Aux. Transformer + ACDB", ("Aux. Transformer", "ACDB"), 2),
    ("Plant side", "4 Pole", ("4 Pole",), 2),
    ("Plant side", "Earth pit", ("Earthing",), 2),
    ("Plant side", MISC, (MISC,), 3),
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
_INDEX = {id(p): i for i, p in enumerate(CYCLE)}
NAMED_TYPES = [t for p in CYCLE for t in p["equipment_types"]]


def phase_for(equipment_type: str) -> dict[str, Any]:
    """The phase an equipment type is maintained in; types not named in the cycle go to Miscellaneous."""
    return _BY_TYPE.get((equipment_type or "").strip().casefold(), _MISC_PHASE)


def one_job(equipment_type: str) -> bool:
    """True when the equipment is planned as a single PM job per plant (ONE_JOB_TYPES)."""
    return (equipment_type or "").strip().casefold() in {t.casefold() for t in ONE_JOB_TYPES}


def in_pm(equipment_type: str) -> bool:
    """False for equipment removed from Preventive Maintenance (NOT_IN_PM)."""
    return (equipment_type or "").strip().casefold() not in {t.casefold() for t in NOT_IN_PM}


def phase_index(equipment_type: str) -> int:
    """Position of the equipment's phase in the cycle (0 = Inverter)."""
    return _INDEX[id(phase_for(equipment_type))]


def window(equipment_type: str, cycle_start: date) -> dict[str, Any]:
    """Dates of this equipment's phase in the cycle that starts on `cycle_start`."""
    p = phase_for(equipment_type)
    start = cycle_start + timedelta(days=p["start_day"] - 1)
    return {**p, "cycle_start": cycle_start, "start": start, "end": start + timedelta(days=p["days"] - 1)}


def chained_window(equipment_type: str, cycle_start: date, booked: dict[int, date] | None = None) -> dict[str, Any]:
    """window(), moved so the phase starts after the work already booked for earlier phases at one plant.

    `booked` maps a phase index to the last due date already planned for that phase at the plant. A phase with
    nothing booked keeps its standard length, so a delay early in the cycle carries through to the GSS side.
    `moved_days` is how far the phase moved from its standard cycle day."""
    booked = booked or {}
    target = phase_index(equipment_type)
    prev_end: date | None = None
    for i, p in enumerate(CYCLE):
        nominal = cycle_start + timedelta(days=p["start_day"] - 1)
        start = max(nominal, prev_end + timedelta(days=1)) if prev_end else nominal
        end = start + timedelta(days=p["days"] - 1)
        if i == target:
            return {**p, "cycle_start": cycle_start, "start": start, "end": end, "moved_days": (start - nominal).days}
        prev_end = max(end, booked[i]) if i in booked else end
    raise AssertionError("phase_index always points into CYCLE")


def window_out(w: dict[str, Any]) -> dict[str, Any]:
    cycle_end = w["cycle_start"] + timedelta(days=CYCLE_DAYS - 1)
    return {"area": w["area"], "phase": w["phase"], "start_day": w["start_day"], "end_day": w["end_day"],
            "days": w["days"], "cycle_start": w["cycle_start"].isoformat(), "start": w["start"].isoformat(),
            "end": w["end"].isoformat(), "moved_days": w.get("moved_days", 0),
            "past_cycle_days": max(0, (w["end"] - cycle_end).days)}
