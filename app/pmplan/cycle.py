"""Monthly Preventive Maintenance cycle: the order, area and days each work category takes at a plant.

A cycle is CYCLE_DAYS (30) days from its start date, the same length as the Monthly recurrence
(FREQ_DAYS["Monthly"]), so every unit comes back on the same cycle day next month.

Each plant plans its own cycle. `pm_cycle_plans.phases` holds the plant's stored plan and
`resolve_cycle()` turns it into the same list-of-dicts this module's CYCLE is, which the
planning functions below take as their `cycle` argument. Passing no cycle uses the built-in
CYCLE described here, which is what callers without a plant in hand (the side templates, the
unscoped /cycle endpoint) want. A plant with no stored plan is PAUSED: it generates no new
cycles at all, which the router enforces before it ever reaches these functions.

`step_days` is the spacing between consecutive working days WITHIN a phase: 1 = consecutive,
2 = alternate days. So a phase's calendar SPAN is not its working-day count -- N working days
with step S occupy (N - 1) * S + 1 calendar days (`_span`). Every end-date calculation uses the
span, because using the day count would silently overlap the next phase.

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
               Switchyard                       remaining days

The two "remaining days" phases share what is left of the 30 days after the fixed phases (4 days -> 2 each).

Phases never overlap at a plant (chained_window): a phase starts on its own cycle day or the day after the
previous phase's work ends there, whichever is later. If the inverters at a plant run Nov 5-11 in a cycle that
starts Nov 1, ACCB moves to Nov 12-13 and every later phase, through the GSS side, moves with them.
Used only by Preventive Maintenance planning (Add PM task, Assign to plants, Excel/CSV upload).

NOT_IN_PM types (MCCB) are not maintained under PM at all: no new PM jobs, templates or unit counts for them.
Work orders created before the change are kept as they are.
"""
from __future__ import annotations

from calendar import monthrange
from datetime import date, timedelta
from typing import Any

# A plan is AUTHORED against 30 days, so a stored plan is month-length independent: `plan_problem`
# bounds start_day and days by CYCLE_DAYS whatever month it will run in. A cycle RUNS from the first
# day of a calendar month to that month's real last day (28, 29, 30 or 31), so the authoring limit
# and the running window are two different things:
#
#   * a 31-day month has a spare day at the end. Nothing is scheduled there and nothing is invented
#     for it.
#   * a month SHORTER than the plan's highest start day loses days -- day 29 and 30 do not exist in
#     February. `effective_start_day` clamps such a phase to the month's last day and the ordinary
#     chaining rule then resolves the collision it causes. The phase is never dropped and never
#     moved to another month; work pushed beyond the month end is reported as `past_cycle_days`.
CYCLE_DAYS = 30
MISC = "Miscellaneous"
# Categories whose phase length follows the plant's unit count (pm_unit_config:
# total_units / units_per_day) rather than a number stored in the cycle plan. The loader SQL writes
# a null `days` for these; a value stored on such a phase is ignored rather than trusted.
UNIT_DERIVED = ("Inverter",)
_UNIT_DERIVED_FOLDED = {t.casefold() for t in UNIT_DERIVED}
# One PM job per plant whatever the unit count: ACCB-1 and ACCB-2 are maintained together, a plant has one
# Aux. Transformer and one ACDB (separate jobs), and the Miscellaneous job covers the small items
# (Street Light, ERT, ...) in one visit.
ONE_JOB_TYPES = ("ACCB Panel", "Aux. Transformer", "ACDB", MISC)
# Removed from Preventive Maintenance (still an issue category elsewhere)
NOT_IN_PM = ("MCCB",)

# (area, phase name, work categories, days; None = share the remaining days)
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
    ("GSS side", "Switchyard", ("Switchyard",), None),
]


def _span(phase: dict[str, Any]) -> int:
    """Calendar days a phase occupies: N working days spaced `step_days` apart."""
    return (phase["days"] - 1) * (phase.get("step_days") or 1) + 1


def month_days(cycle_start: date) -> int:
    """Days in the calendar month the cycle runs in -- its real length, not CYCLE_DAYS."""
    return monthrange(cycle_start.year, cycle_start.month)[1]


def cycle_end(cycle_start: date) -> date:
    """Last day of the cycle: the last day of its calendar month."""
    return cycle_start.replace(day=month_days(cycle_start))


def effective_start_day(phase: dict[str, Any], cycle_start: date) -> int:
    """A phase's start day inside THIS month: its planned day, clamped to the month's last day.

    A plan authored with Miscellaneous on day 30 still has to run in February. Clamping keeps the
    phase in the month on its nearest possible day; chaining then pushes whatever it collides with,
    exactly as it does for an overrun."""
    return min(int(phase["start_day"]), month_days(cycle_start))


def _build() -> list[dict[str, Any]]:
    fixed = sum(d for *_, d in _PHASES if d)
    flex = [i for i, (*_, d) in enumerate(_PHASES) if d is None]
    left = max(len(flex), CYCLE_DAYS - fixed)
    share = {i: left // len(flex) + (1 if k < left % len(flex) else 0) for k, i in enumerate(flex)}
    out, day = [], 1
    for i, (area, name, types, days) in enumerate(_PHASES):
        n = days or share[i]
        out.append({"area": area, "phase": name, "equipment_types": list(types), "start_day": day,
                    "end_day": day + n - 1, "days": n, "step_days": 1})
        day += n
    return out


CYCLE = _build()
_BY_TYPE = {t.casefold(): p for p in CYCLE for t in p["equipment_types"]}
_MISC_PHASE = next(p for p in CYCLE if p["phase"] == MISC)
_INDEX = {id(p): i for i, p in enumerate(CYCLE)}
NAMED_TYPES = [t for p in CYCLE for t in p["equipment_types"]]


def resolve_cycle(phases: list[dict[str, Any]], derived_days: dict[str, int] | None = None) -> list[dict[str, Any]]:
    """A plant's stored `pm_cycle_plans.phases` as the structure CYCLE is, ready to plan from.

    A phase holding a UNIT_DERIVED category takes its length from `derived_days` (worked out from
    pm_unit_config), and a `days` stored on it is ignored -- the plan does not get to disagree with
    the plant's unit count. With no unit count configured yet it falls back to the built-in length,
    still not the stored one. Every other phase uses its stored `days`."""
    derived_days = derived_days or {}
    out: list[dict[str, Any]] = []
    for p in phases:
        categories = [str(c) for c in (p.get("categories") or [])]
        unit_derived = [c for c in categories if c.strip().casefold() in _UNIT_DERIVED_FOLDED]
        if unit_derived:
            days = next((derived_days[c] for c in unit_derived if c in derived_days), None)
        else:
            days = p.get("days")
        if days is None:                           # no unit count configured yet: the built-in length
            days = next((q["days"] for q in CYCLE
                         if any(c in q["equipment_types"] for c in categories)), 1)
        days = max(1, int(days))
        step = max(1, int(p.get("step_days") or 1))
        start_day = int(p["start_day"])
        phase = {"area": str(p.get("area") or "Plant side"), "phase": str(p["phase"]),
                 "equipment_types": categories, "start_day": start_day, "days": days, "step_days": step}
        phase["end_day"] = start_day + _span(phase) - 1
        out.append(phase)
    return out


def phase_for(equipment_type: str, cycle: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """The phase a work category is maintained in; categories not named in the cycle go to Miscellaneous."""
    key = (equipment_type or "").strip().casefold()
    if cycle is None:
        return _BY_TYPE.get(key, _MISC_PHASE)
    for p in cycle:
        if any(key == t.strip().casefold() for t in p["equipment_types"]):
            return p
    # A plan need not name every category. Miscellaneous collects the rest, as in the built-in cycle.
    return next((p for p in cycle if p["phase"] == MISC), cycle[-1])


def one_job(equipment_type: str) -> bool:
    """True when the category is planned as a single PM job per plant (ONE_JOB_TYPES)."""
    return (equipment_type or "").strip().casefold() in {t.casefold() for t in ONE_JOB_TYPES}


def in_pm(equipment_type: str) -> bool:
    """False for categories removed from Preventive Maintenance (NOT_IN_PM)."""
    return (equipment_type or "").strip().casefold() not in {t.casefold() for t in NOT_IN_PM}


def phase_index(equipment_type: str, cycle: list[dict[str, Any]] | None = None) -> int:
    """Position of the category's phase in the cycle (0 = the first phase)."""
    if cycle is None:
        return _INDEX[id(phase_for(equipment_type))]
    target = phase_for(equipment_type, cycle)
    return next(i for i, p in enumerate(cycle) if p is target)


def window(equipment_type: str, cycle_start: date, cycle: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Dates of this category's phase in the cycle that starts on `cycle_start`."""
    p = phase_for(equipment_type, cycle)
    start = cycle_start + timedelta(days=effective_start_day(p, cycle_start) - 1)
    return {**p, "cycle_start": cycle_start, "start": start, "end": start + timedelta(days=_span(p) - 1)}


def chained_window(equipment_type: str, cycle_start: date, booked: dict[int, date] | None = None,
                   cycle: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """window(), moved so the phase starts after the work already booked for earlier phases at one plant.

    `booked` maps a phase index to the last due date already planned for that phase at the plant. A phase with
    nothing booked keeps its standard length, so a delay early in the cycle carries through to the GSS side.
    `moved_days` is how far the phase moved from its standard cycle day. `cycle` is the plant's resolved plan;
    without one the built-in CYCLE is used."""
    phases = CYCLE if cycle is None else cycle
    booked = booked or {}
    target = phase_index(equipment_type, cycle)
    prev_end: date | None = None
    for i, p in enumerate(phases):
        nominal = cycle_start + timedelta(days=effective_start_day(p, cycle_start) - 1)
        start = max(nominal, prev_end + timedelta(days=1)) if prev_end else nominal
        end = start + timedelta(days=_span(p) - 1)
        if i == target:
            return {**p, "cycle_start": cycle_start, "start": start, "end": end, "moved_days": (start - nominal).days}
        prev_end = max(end, booked[i]) if i in booked else end
    raise AssertionError("phase_index always points into the cycle")


def plan_problem(phases: list[dict[str, Any]]) -> str | None:
    """The first thing wrong with a stored cycle plan, naming the phase, or None if it is sound.

    A wrong day number is invisible until someone drives to a site on the wrong day, so these are
    checked before a plan is saved rather than when work is generated from it."""
    if not phases:
        return "A cycle plan needs at least one phase"
    seen: dict[str, str] = {}
    previous_start = 0
    for p in phases:
        name = str(p.get("phase") or "").strip()
        if not name:
            return "Every phase needs a name"
        categories = [str(c).strip() for c in (p.get("categories") or []) if str(c).strip()]
        if not categories:
            return f"{name}: choose at least one work category"
        for c in categories:
            if c.casefold() in seen:
                return f"{name}: {c} is already planned in {seen[c.casefold()]}"
            seen[c.casefold()] = name
        start_day = p.get("start_day")
        if not isinstance(start_day, int) or isinstance(start_day, bool) or not 1 <= start_day <= CYCLE_DAYS:
            return f"{name}: start day must be between 1 and {CYCLE_DAYS}"
        if start_day <= previous_start:
            return f"{name}: start day {start_day} must come after the previous phase's day {previous_start}"
        previous_start = start_day
        step = p.get("step_days", 1)
        if step is not None and (not isinstance(step, int) or isinstance(step, bool) or step < 1):
            return f"{name}: days apart must be 1 or more"
        days = p.get("days")
        if days is not None:
            if not isinstance(days, int) or isinstance(days, bool) or days < 1:
                return f"{name}: working days must be 1 or more"
            span = (days - 1) * (step or 1) + 1
            if start_day + span - 1 > CYCLE_DAYS:
                return (f"{name}: {days} day(s) {('spaced ' + str(step) + ' apart ') if (step or 1) > 1 else ''}"
                        f"from day {start_day} runs past day {CYCLE_DAYS}")
    return None


def window_out(w: dict[str, Any]) -> dict[str, Any]:
    """The window as JSON. `past_cycle_days` counts work pushed beyond the month's last day, and
    `clamped_from` names the authored day when a short month forced the phase earlier."""
    last_day = cycle_end(w["cycle_start"])
    planned_day = int(w["start_day"])
    running_day = effective_start_day(w, w["cycle_start"])
    return {"area": w["area"], "phase": w["phase"], "start_day": w["start_day"], "end_day": w["end_day"],
            "days": w["days"], "step_days": w.get("step_days", 1),
            "cycle_start": w["cycle_start"].isoformat(), "cycle_end": last_day.isoformat(),
            "cycle_length": month_days(w["cycle_start"]),
            "start": w["start"].isoformat(),
            "end": w["end"].isoformat(), "moved_days": w.get("moved_days", 0),
            "clamped_from": planned_day if running_day != planned_day else None,
            "past_cycle_days": max(0, (w["end"] - last_day).days)}
