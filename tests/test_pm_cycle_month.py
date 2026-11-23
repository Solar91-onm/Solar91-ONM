"""A PM cycle is a calendar MONTH: the 1st to the month's real last day.

Changed deliberately from a rolling 30 days (`cycle_start + 29`). The trackers the team works from
are month sheets, so a cycle that drifted off the month boundary could not be read against them.

Consequences, handled rather than papered over:

  * a 31-day month has a spare day at the end -- nothing is scheduled there and nothing is invented;
  * a month shorter than the plan's highest start day loses days. Three of the loaded plans schedule
    work on day 29 or 30, which February does not have. Such a phase is CLAMPED to the month's last
    day and the ordinary chaining rule resolves the collision; it is never dropped and never moved to
    another month, and work pushed beyond the month end is reported as `past_cycle_days`;
  * authoring still bounds start_day/days by CYCLE_DAYS (30), so a stored plan stays month-length
    independent. Clamping happens at generation, not at save.
"""
from __future__ import annotations

from datetime import date

from app.pmplan.cycle import (CYCLE_DAYS, chained_window, cycle_end, effective_start_day, month_days,
                              plan_problem, resolve_cycle, window_out)

LATE_PLAN = [
    {"phase": "Earth pit", "area": "Plant side", "categories": ["Earthing"],
     "start_day": 29, "days": 1, "step_days": 1},
    {"phase": "Miscellaneous", "area": "Plant side", "categories": ["Miscellaneous"],
     "start_day": 30, "days": 1, "step_days": 1},
]


def _run(category, start, plan=None):
    cycle = resolve_cycle(plan) if plan else None
    return window_out(chained_window(category, start, None, cycle))


# ── the cycle is the month ──────────────────────────────────────────────────


def test_a_cycle_ends_on_the_months_real_last_day():
    assert cycle_end(date(2026, 12, 1)) == date(2026, 12, 31)
    assert cycle_end(date(2027, 2, 1)) == date(2027, 2, 28)
    assert cycle_end(date(2028, 2, 1)) == date(2028, 2, 29), "a leap February has 29"
    assert cycle_end(date(2026, 11, 1)) == date(2026, 11, 30)


def test_the_window_reports_the_months_length_not_thirty():
    december = _run("Inverter", date(2026, 12, 1))
    assert (december["cycle_start"], december["cycle_end"]) == ("2026-12-01", "2026-12-31")
    assert december["cycle_length"] == 31

    february = _run("Inverter", date(2027, 2, 1))
    assert february["cycle_end"] == "2027-02-28" and february["cycle_length"] == 28


def test_a_long_months_spare_day_holds_nothing():
    """December has 31 days for a 30-day plan. The spare day is simply empty."""
    last_planned = max(
        date.fromisoformat(_run(category, date(2026, 12, 1))["end"])
        for category in ("Inverter", "Miscellaneous", "Switchyard", "Transmission line")
    )
    assert last_planned <= date(2026, 12, 31)
    assert month_days(date(2026, 12, 1)) == 31


# ── a short month clamps, chains and reports ────────────────────────────────


def test_a_day_beyond_the_months_length_clamps_to_its_last_day():
    earthing = _run("Earthing", date(2026, 2, 1), LATE_PLAN)

    assert earthing["start"] == "2026-02-28", "day 29 does not exist in February"
    assert earthing["clamped_from"] == 29, "the page can say the day was moved by the month"
    assert earthing["past_cycle_days"] == 0


def test_the_clamped_collision_is_resolved_by_chaining_not_by_dropping_the_phase():
    """Two phases clamped onto the 28th: the second chains to the day after and says it overflowed."""
    misc = _run("Miscellaneous", date(2026, 2, 1), LATE_PLAN)

    assert misc["clamped_from"] == 30
    assert misc["start"] == "2026-03-01", "pushed by the phase before it, exactly as an overrun is"
    assert misc["past_cycle_days"] == 1, "work past the month end is surfaced, not hidden"
    assert misc["phase"] == "Miscellaneous", "the phase still exists"


def test_the_same_plan_runs_on_its_authored_days_in_a_long_month():
    earthing = _run("Earthing", date(2026, 12, 1), LATE_PLAN)
    misc = _run("Miscellaneous", date(2026, 12, 1), LATE_PLAN)

    assert (earthing["start"], earthing["clamped_from"]) == ("2026-12-29", None)
    assert (misc["start"], misc["clamped_from"]) == ("2026-12-30", None)
    assert misc["past_cycle_days"] == 0


def test_effective_start_day_is_the_clamp_in_isolation():
    phase = {"start_day": 30, "days": 1, "step_days": 1}
    assert effective_start_day(phase, date(2026, 12, 1)) == 30
    assert effective_start_day(phase, date(2026, 2, 1)) == 28
    assert effective_start_day(phase, date(2028, 2, 1)) == 29


# ── authoring is still month-length independent ─────────────────────────────


def test_authoring_still_allows_day_30_whatever_month_it_will_run_in():
    """Clamping belongs to generation. A plan stored for day 30 is valid and stays as typed."""
    assert plan_problem(LATE_PLAN) is None
    assert CYCLE_DAYS == 30
    assert [p["start_day"] for p in resolve_cycle(LATE_PLAN)] == [29, 30]


def test_authoring_still_refuses_a_day_past_the_thirty_day_limit():
    beyond = [{"phase": "Late", "area": "Plant side", "categories": ["Earthing"],
               "start_day": 31, "days": 1, "step_days": 1}]
    problem = plan_problem(beyond)
    assert problem and "Late" in problem and "between 1 and 30" in problem


# ── generation runs from the 1st, whatever date it is asked for ─────────────


def test_generation_lays_the_plan_out_from_the_first_of_the_month(client, db):
    """December 2026 is the first cycle under the loaded plans. Day 16 means the 16th.

    The caller may ask with any date in the month; `_fit_to_cycle` anchors the layout to the 1st, so
    a mid-month request does not slide every phase by the day it was asked on.
    """
    from datetime import date as _date

    from app.core.models import OMTask
    from tests.conftest import login_user
    from tests.test_pm_cycle_plans import _body, _phase, _plant, _store_plan

    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    _store_plan(db, plant, [_phase("4 Pole + ACDB + Aux. TX", ["4 Pole", "ACDB", "Aux. Transformer"], 16, 1)])

    asked_mid_month = _date(2026, 12, 9).isoformat()
    res = client.post("/api/pm-plan/tasks", json=_body(
        equipment_type="4 Pole", task_name="4 Pole PM", start_date=asked_mid_month))
    assert res.status_code == 200, res.text

    task = db.query(OMTask).filter(OMTask.task_type == "4 Pole").one()
    assert task.start_on == _date(2026, 12, 16), "day 16 of the plan is the 16th of December"
    assert task.due_on == _date(2026, 12, 16)
