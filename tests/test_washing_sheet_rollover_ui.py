"""Record module cleaning: one ordinary entry per plant/date and explicit same-day cycle starts.

Between-cycle re-cleaning uses the Extra Cleaning action rather than splitting an ordinary entry
into the next cycle on the same date by default. A separate action allows the next cycle to start
on the confirmed completion date. Cycle 3's same-day post-completion work remains extra cleaning.

The sheet's own functions decide all of this, so these load `assets/js/operations-calendar.js`
in node with the browser globals stubbed and its one export line swapped for the internals under
test -- the same harness `test_portal_frontend.py` uses. Nothing is asserted on source text
except where a test says so.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CALENDAR = ROOT / "assets" / "js" / "operations-calendar.js"

# The module is an IIFE that exports only `render`; this swaps that one line for the internals the
# sheet's behaviour lives in. If any of them is renamed, node fails loudly here rather than silently
# testing nothing.
EXPORTS = ("recordRows", "planDay", "rollOverNote", "rowTableCount", "nextCycleNo",
           "sameDayNextCycleCandidate",
           "parseTableList", "formatTableList")
EXPORT_LINE = "  global.Solar91PortalCalendar = { render: render };"


def _run(body: str, payload: dict, role: str = "O&M Head"):
    """Evaluate the calendar module in node with `body` run against its internals as `I`."""
    source = CALENDAR.read_text(encoding="utf-8")
    assert source.count(EXPORT_LINE) == 1, "the calendar module's export line moved"
    script = """
      global.window = global;
      global.document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
      global.Solar91PortalFormat = { escape: (s) => String(s == null ? '' : s) };
      global.Solar91PortalAPI = { request: () => Promise.resolve({}), can: () => true,
                                  currentUser: () => ({ role: %s }) };
      const fs = require('fs');
      // parseTableList / formatTableList now live in the module the Module Cleaning board shares
      // with this page (assets/js/extra-cleaning.js); the calendar reads them off the global.
      eval(fs.readFileSync('./assets/js/extra-cleaning.js', 'utf8'));
      let src = fs.readFileSync('./assets/js/operations-calendar.js', 'utf8');
      src = src.replace(%s, '  global.__i = { %s };');
      eval(src);
      const I = global.__i;
      const one = JSON.parse(process.argv[1]);
      %s
    """ % (json.dumps(role), json.dumps(EXPORT_LINE), ", ".join(EXPORTS), body)
    run = subprocess.run(
        ["node", "-e", script, json.dumps(payload)],
        # node writes UTF-8; without this Windows decodes it with the console codepage and the
        # "·" and "–" in the sheet's messages come back as mojibake.
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=30,
    )
    assert run.returncode == 0, run.stderr or run.stdout
    return json.loads(run.stdout)


@pytest.fixture(scope="module")
def plan_day():
    """Plan one unsaved day against a set of tables the cycle has already taken."""

    def call(*cases):
        return _run("""
          const out = one.map(function (c) {
            const state = { recordCycle: c.cycle, recordDrafts: {},
                            washingPlant: { cycles: [], table_count: c.total } };
            for (let n = 1; n <= c.lastCycle; n += 1) state.washingPlant.cycles.push({ cycle_no: n });
            const used = {};
            (c.cleaned || []).forEach((n) => { used[n] = true; });
            const plan = I.planDay(state, { list: c.typed, reason: c.reason || "" }, used, c.total);
            return { numbers: plan.numbers, nextNumbers: plan.nextNumbers, error: plan.error,
                     full: plan.full, zero: plan.zero, count: I.rowTableCount(plan),
                     note: I.rollOverNote(state, plan) };
          });
          process.stdout.write(JSON.stringify(out));
        """, list(cases))

    return call


@pytest.fixture(scope="module")
def record_rows():
    """Build the sheet's day grid for one cycle tab and report one entry per row."""

    def call(cycle_no, reports, *, today, month, total=35, cycles=3, role="O&M Head", drafts=None):
        payload = {"cycle": cycle_no, "reports": reports, "today": today, "month": month,
                   "total": total, "cycles": cycles, "drafts": drafts or {}}
        return _run("""
          const state = {
            recordCycle: one.cycle, month: one.month, washingDataToday: one.today,
            recordDrafts: one.drafts, washingReports: one.reports,
            washingPlant: { table_count: one.total, cycles: [] }
          };
          for (let n = 1; n <= one.cycles; n += 1) {
            state.washingPlant.cycles.push({ cycle_no: n, start_date: one.month + "-01",
                                             due_date: one.month + "-28" });
          }
          const rows = I.recordRows(state);
          process.stdout.write(JSON.stringify({
            rows: rows.map((row) => ({
              date: row.date, saved: !!row.report,
              cycleNo: row.report ? row.report.cycle_no : null,
              tables: row.report ? row.report.tables_cleaned : null,
              numbers: row.report ? null : row.numbers,
              nextNumbers: row.report ? null : row.nextNumbers,
              full: row.report ? null : !!row.full,
              afterCycles: row.report ? null : !!row.afterCycles,
              error: row.report ? "" : row.error, note: row.report ? "" : row.note
            })),
            cleanedTables: rows.cleanedTables, openTables: rows.openTables
          }));
        """, payload, role=role)

    return call


def _case(typed, *, cleaned=(), cycle=1, last_cycle=3, total=35, reason=""):
    return {"typed": typed, "cleaned": list(cleaned), "cycle": cycle,
            "lastCycle": last_cycle, "total": total, "reason": reason}


def test_a_mid_cycle_repeat_cannot_roll_into_the_next_cycle_on_the_same_date(plan_day):
    """Between-cycle re-cleaning must use the separate Extra Cleaning action."""
    done = range(26, 36)                                       # 26-35 cleaned earlier in cycle 1
    plan, = plan_day(_case("1-25, 26-35", cleaned=done))

    assert plan["error"] == (
        "Table 26 is already cleaned in this cycle. "
        "Use + Extra cleaning to record re-cleaning (a calendar record only)."
    )
    assert plan["numbers"] == [] and plan["nextNumbers"] == []


def test_cycle_three_still_splits_same_day_post_completion_work_as_extra(plan_day):
    """After Cycle 3 completes, same-day repeated tables remain extra cleaning."""
    done = range(26, 36)
    first, scattered = plan_day(
        _case("26-35, 1-25", cleaned=done, cycle=3),
        _case("26-30, 1-25, 31-35", cleaned=done, cycle=3),
    )
    assert first["numbers"] == list(range(1, 26)) and first["nextNumbers"] == list(range(26, 36))
    assert scattered["numbers"] == list(range(1, 26))
    assert scattered["nextNumbers"] == list(range(26, 31)) + list(range(31, 36))


def test_descending_and_mixed_ranges_keep_the_order_they_were_entered(plan_day):
    plan, = plan_day(_case("25-1, 35-26", cleaned=range(26, 36), cycle=3))
    assert plan["numbers"] == list(range(25, 0, -1))
    assert plan["nextNumbers"] == list(range(35, 25, -1))


def test_mid_cycle_repeats_are_refused_and_directed_to_extra_cleaning(plan_day):
    plan, = plan_day(_case("1-20, 26-35", cleaned=range(26, 36)))

    assert plan["numbers"] == [] and plan["nextNumbers"] == []
    assert "Table 26 is already cleaned in this cycle." in plan["error"]
    assert "Use + Extra cleaning" in plan["error"]
    assert not plan["note"]


def test_the_last_cycle_calls_the_roll_over_cleaning_that_counts(plan_day):
    """Cycle 3 has no next cycle: the same split happens, and the surplus is ordinary cleaning.

    Changed deliberately (O&M Head's instruction): the surplus used to be saved as marked extra,
    which no longer counts towards the month. Cleaning done once the cycles are complete is
    ordinary work, so the roll-over says so and is saved without the extra flag."""
    split, refused = plan_day(
        _case("1-25, 26-35", cleaned=range(26, 36), cycle=3),
        _case("1-20, 26-35", cleaned=range(26, 36), cycle=3),
    )
    assert split["nextNumbers"] == list(range(26, 36))
    assert "are recorded as cleaning after the three cycles and count towards the month" in split["note"]
    assert "Use + Extra cleaning" in refused["error"]


def test_an_ordinary_day_is_unchanged(plan_day):
    """Nothing repeated: one entry, no roll-over, no note -- exactly as before."""
    plain, empty, not_done, bad = plan_day(
        _case("1-10"),
        _case(""),
        _case("", reason="Rain"),
        _case("1-10, 9"),
    )
    assert plain["numbers"] == list(range(1, 11)) and plain["nextNumbers"] == []
    assert plain["count"] == 10 and not plain["note"] and not plain["error"]
    assert empty["numbers"] == [] and not empty["error"] and not empty["note"]
    assert not_done["zero"] is True and not_done["numbers"] == []
    assert bad["error"] == "Table 9 is listed twice."


def test_a_full_cycle_still_blocks_the_row(plan_day):
    """When every table is already cleaned there is nothing left to complete, so the row is closed
    rather than rolling the whole day over."""
    plan, = plan_day(_case("1-5", cleaned=range(1, 36)))
    assert plan["full"] is True
    assert plan["numbers"] == [] and plan["nextNumbers"] == []


def test_same_day_next_cycle_uses_a_separate_explicit_entry():
    """Same-day rollover is explicitly marked; Cycle 3's surplus is saved as ordinary cleaning."""
    calendar = CALENDAR.read_text(encoding="utf-8")
    save = calendar[calendar.index("if (row.error) { invalidRange = true; return; }"):]
    save = save[:save.index("if (invalidRange")]
    assert "is_extra: false" in save, "the surplus is ordinary work the month is credited for"
    assert "same_day_next_cycle: !!row.sameDayNextCycle" in save
    assert 'data-calendar-action="open-same-day-next-cycle"' in calendar
    assert "Use + Extra cleaning to record re-cleaning (a calendar record only)." in calendar
    assert "If the same day finishes this cycle and the next round" not in calendar
    assert "regularReportByDate[date] && !(isSameDayNextCycle && date === state.recordSameDayDate)" in calendar
    # Saved reports are replaced by id: a date can now hold more than one entry.
    assert "savedIds.indexOf(item.id) === -1" in calendar
    assert not re.search(r"return item\.report_date !== report\.report_date;", calendar), \
        "replacing a date's reports wholesale deletes the other cycle's entry for that date"
    # A saved extra-cleaning entry sits beside the entry that completed the cycle on the same date,
    # so the sheet must not let it read as that cycle's progress.
    assert 'if (row.report.is_extra === true) numbers += " (extra cleaning)";' in calendar


def test_same_day_candidate_requires_confirmation_and_an_unstarted_next_cycle():
    candidate = _run("""
      const state = {
        washingPlant: { cycles: [{ cycle_no: 1 }, { cycle_no: 2 }, { cycle_no: 3 }] },
        washingReports: one
      };
      process.stdout.write(JSON.stringify(I.sameDayNextCycleCandidate(state)));
    """, [_saved("2026-11-19", 1, range(1, 4), completed=True)])
    assert candidate == {"date": "2026-11-19", "previousCycle": 1, "nextCycle": 2}

    pending = _run("""
      const state = {
        washingPlant: { cycles: [{ cycle_no: 1 }, { cycle_no: 2 }, { cycle_no: 3 }] },
        washingReports: one
      };
      process.stdout.write(JSON.stringify(I.sameDayNextCycleCandidate(state)));
    """, [_saved("2026-11-19", 1, range(1, 4), completed=True, status="Pending")])
    assert pending is None

    started = _run("""
      const state = {
        washingPlant: { cycles: [{ cycle_no: 1 }, { cycle_no: 2 }, { cycle_no: 3 }] },
        washingReports: one
      };
      process.stdout.write(JSON.stringify(I.sameDayNextCycleCandidate(state)));
    """, [
        _saved("2026-11-19", 1, range(1, 4), completed=True),
        _saved("2026-11-20", 2, [1]),
    ])
    assert started is None

    too_old = _run("""
      const state = {
        month: "2026-11", washingDataToday: "2026-11-20",
        washingPlant: { cycles: [{ cycle_no: 1 }, { cycle_no: 2 }, { cycle_no: 3 }] },
        washingReports: one
      };
      process.stdout.write(JSON.stringify(I.sameDayNextCycleCandidate(state)));
    """, [_saved("2026-10-01", 1, range(1, 4), completed=True)], role="Site Engineer")
    assert too_old is None


def test_same_day_next_cycle_opens_an_entry_on_the_prior_completion_date(record_rows):
    reports = [_saved("2026-11-19", 1, range(1, 36), completed=True)]
    grid = record_rows(2, reports, today=TODAY, month=MONTH, total=35)
    state = {
        "cycle": 2, "reports": reports, "today": TODAY, "month": MONTH, "total": 35, "cycles": 3,
    }
    special = _run("""
      const state = {
        recordCycle: 2, recordSameDayDate: "2026-11-19", recordSameDayCycle: 2,
        month: one.month, washingDataToday: one.today, recordDrafts: {},
        washingReports: one.reports,
        washingPlant: { table_count: one.total, cycles: [] }
      };
      for (let n = 1; n <= one.cycles; n += 1) {
        state.washingPlant.cycles.push({ cycle_no: n, start_date: one.month + "-01",
                                         due_date: one.month + "-28" });
      }
      const rows = I.recordRows(state);
      process.stdout.write(JSON.stringify(rows.map((row) => ({
        date: row.date, saved: !!row.report, sameDayNextCycle: !!row.sameDayNextCycle
      }))));
    """, state)
    assert {"date": "2026-11-19", "saved": False, "sameDayNextCycle": True} in special
    assert grid["rows"][0]["date"] == "2026-11-20", "normal cycle entry remains blocked for that date"



def _saved(date, cycle_no, numbers, *, completed=False, status="Confirmed", extra=False):
    numbers = list(numbers)
    return {"report_date": date, "cycle_no": cycle_no, "review_status": status,
            "job_status": "Done", "tables_cleaned": len(numbers), "cycle_completed": completed,
            "cleaned_table_codes": ["Table " + str(n).rjust(3, "0") for n in numbers],
            "id": date + "#" + str(cycle_no) + ("#x" if extra else ""), "is_extra": extra}


# Cycle 1 ran 10-19 Nov; on the 19th it was filled (1-25) and the next round started (26-35).
ROLLED_OVER = [
    _saved("2026-11-10", 1, range(26, 36)),
    _saved("2026-11-19", 1, range(1, 26), completed=True),
    _saved("2026-11-19", 2, range(26, 36)),
]
TODAY, MONTH = "2026-11-22", "2026-11"


def test_the_finished_cycle_still_shows_the_day_it_was_finished_on(record_rows):
    """The next cycle's first entry is on the very date cycle 1 completed, so the clamp that ends a
    cycle the day before the next one starts would have hidden the day that completed it."""
    grid = record_rows(1, ROLLED_OVER, today=TODAY, month=MONTH)

    rows = [row for row in grid["rows"] if row["saved"]]
    assert [(row["date"], row["cycleNo"], row["tables"]) for row in rows] == [
        ("2026-11-10", 1, 10), ("2026-11-19", 1, 25),
    ], "cycle 1's tab shows its own two days, and only those"
    assert grid["rows"][-1]["date"] == "2026-11-19", "the grid ends on the day the cycle filled"
    assert grid["openTables"] == [], "all 35 tables are accounted for in cycle 1"


def test_the_next_cycle_shows_its_entry_on_that_same_date(record_rows):
    """Cycle 2's tab carries the same date, with cycle 2's entry on it -- not cycle 1's."""
    grid = record_rows(2, ROLLED_OVER, today=TODAY, month=MONTH)

    first = grid["rows"][0]
    assert {key: first[key] for key in ("date", "saved", "cycleNo", "tables")} == \
        {"date": "2026-11-19", "saved": True, "cycleNo": 2, "tables": 10}
    assert [row["date"] for row in grid["rows"]] == [
        "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22",
    ], "the days after it are open for entry up to today"
    assert all(not row["saved"] for row in grid["rows"][1:])
    assert grid["cleanedTables"] == list(range(26, 36))
    assert grid["openTables"] == list(range(1, 26))


def test_a_regular_entry_on_another_cycle_hides_the_blank_date(record_rows):
    """A date with a regular entry elsewhere is not offered again as a blank row."""
    done = [_saved("2026-11-10", 1, range(26, 36)),
            _saved("2026-11-19", 1, range(1, 26), completed=True)]

    grid = record_rows(2, done, today=TODAY, month=MONTH)

    assert "2026-11-19" not in [row["date"] for row in grid["rows"]]
    assert [row["date"] for row in grid["rows"]][0] == "2026-11-20"
    assert all(not row["saved"] for row in grid["rows"])
    assert grid["openTables"] == list(range(1, 36)), "cycle 2 starts with every table open"


def test_a_back_filled_day_sees_tables_saved_on_a_later_date(record_rows):
    """Reported from the portal: cycle 3 had 1-46 saved on 17 Nov, and 1-46 typed again on the 16th
    was accepted by the sheet and then refused by the server ("Table 1 is already recorded in cycle
    3 on 16 Nov"). The sheet only counted the days ABOVE a row; the server checks the whole cycle.
    The row must say so itself, before anyone presses Save."""
    saved = [_saved("2026-11-17", 1, range(1, 47))]

    grid = record_rows(1, saved, today=TODAY, month=MONTH, total=352,
                       drafts={"2026-11-16": {"list": "1-46"}})

    row = next(r for r in grid["rows"] if r["date"] == "2026-11-16")
    assert "Table 1 is already cleaned in this cycle" in row["error"]
    assert row["numbers"] == [] and row["nextNumbers"] == []
    assert grid["cleanedTables"] == list(range(1, 47))


def test_a_back_filled_day_can_still_take_the_tables_the_cycle_needs(record_rows):
    """The same back-filled row accepts work the cycle has not had yet, on either side of a saved day."""
    saved = [_saved("2026-11-17", 1, range(1, 47))]

    grid = record_rows(1, saved, today=TODAY, month=MONTH, total=352,
                       drafts={"2026-11-16": {"list": "47-60"}})

    row = next(r for r in grid["rows"] if r["date"] == "2026-11-16")
    assert not row["error"] and row["numbers"] == list(range(47, 61))


def test_extra_cleaning_reserves_no_table_of_the_cycle(record_rows):
    """An extra entry is work done, not cycle progress, so the tables it names stay open for the
    cycle -- otherwise re-cleaning table 9 would leave no way to record table 9 as real cycle work."""
    reports = [_saved("2026-11-10", 1, [1, 2]), _saved("2026-11-12", 1, [9], extra=True)]

    grid = record_rows(1, reports, today=TODAY, month=MONTH, total=10,
                       drafts={"2026-11-14": {"list": "9, 10"}})

    assert grid["cleanedTables"] == [1, 2], "extra cleaning adds nothing to the cycle"
    assert 9 in grid["openTables"]
    row = next(r for r in grid["rows"] if r["date"] == "2026-11-14")
    assert not row["error"] and row["numbers"] == [9, 10]
    assert [r["cycleNo"] for r in grid["rows"] if r["saved"]] == [1, 1], "both days still show"


def test_a_rejected_entry_leaves_the_day_open_again(record_rows):
    """A rejected day is not this cycle's work: its row goes back to being enterable and its tables
    are open again, so the cycle is not reported as full on the strength of a refused entry."""
    reports = [_saved("2026-11-10", 1, range(26, 36)),
               _saved("2026-11-19", 1, range(1, 26), status="Rejected")]

    grid = record_rows(1, reports, today=TODAY, month=MONTH)

    nineteenth = [row for row in grid["rows"] if row["date"] == "2026-11-19"]
    assert nineteenth and not nineteenth[0]["saved"]
    assert grid["cleanedTables"] == list(range(26, 36)), "a rejected day reserves no tables"
    assert grid["openTables"] == list(range(1, 26))


# ───────────── recording for the rest of the month once the three cycles are full ─────────────
#
# The O&M Head's rule: once all three cycles are complete, whatever cleaning happens for the rest
# of the month is entered on the ordinary sheet and counts. The sheet used to close every remaining
# row (`full`) because the last cycle had taken every table, which is what forced that work into
# "+ Extra cleaning" -- where, under the same instruction, it no longer counts at all.

def _month_of_three_cycles(total=4):
    """A small plant whose three cycles are complete, one full day each."""
    return [_saved("2026-11-10", 1, range(1, total + 1), completed=True),
            _saved("2026-11-12", 2, range(1, total + 1), completed=True),
            _saved("2026-11-14", 3, range(1, total + 1), completed=True)]


def test_days_after_the_three_cycles_stay_open_for_recording(record_rows):
    grid = record_rows(3, _month_of_three_cycles(), today=TODAY, month=MONTH, total=4)

    later = [row for row in grid["rows"] if not row["saved"] and row["date"] > "2026-11-14"]
    assert later, "the last cycle's grid must reach the rest of the month"
    assert all(row["full"] is False for row in later), "a completed month must still take readings"
    assert all(row["afterCycles"] is True for row in later)


def test_a_day_after_the_three_cycles_accepts_tables_already_cleaned(record_rows):
    """Every table is free again: this is a further round, not a repeat inside a running cycle."""
    grid = record_rows(3, _month_of_three_cycles(), today=TODAY, month=MONTH, total=4,
                       drafts={"2026-11-16": {"list": "1-4", "remarks": ""}})

    row = next(r for r in grid["rows"] if r["date"] == "2026-11-16")
    assert row["numbers"] == [1, 2, 3, 4] and not row["error"]
    assert not row["note"], "the first round after the cycles is unremarkable"


def test_repeating_a_table_after_the_cycles_opens_the_next_round_and_says_so(record_rows):
    """Asked for by the O&M Head: treat it as a round of its own, but still tell me."""
    grid = record_rows(3, _month_of_three_cycles(), today=TODAY, month=MONTH, total=4,
                       drafts={"2026-11-16": {"list": "1-4", "remarks": ""},
                               "2026-11-17": {"list": "1-4", "remarks": ""}})

    second = next(r for r in grid["rows"] if r["date"] == "2026-11-17")
    assert second["numbers"] == [1, 2, 3, 4], "the work is recorded, not refused"
    assert not second["error"]
    assert "already cleaned in round 1" in second["note"] and "round 2 starts here" in second["note"]


def test_a_cycle_still_running_is_unchanged(record_rows):
    """The once-per-cycle rule still holds while a cycle is being filled."""
    grid = record_rows(1, [_saved("2026-11-10", 1, [1, 2])], today=TODAY, month=MONTH, total=4,
                       drafts={"2026-11-11": {"list": "1-2", "remarks": ""}})

    row = next(r for r in grid["rows"] if r["date"] == "2026-11-11")
    assert row["afterCycles"] is False
    assert "already cleaned in this cycle" in row["error"] and row["numbers"] == []


def test_every_day_tile_opens_its_drawer():
    """The drawer is the only route to a record's details and to the extra-cleaning actions.

    The plant's Module Cleaning calendar lists its chips in full rather than "+N more"; that must
    not cost the day its open action, which is what made Edit / Remove extra cleaning unreachable
    for the O&M Head and the Assignee on exactly the page they manage washing from.
    """
    calendar = CALENDAR.read_text(encoding="utf-8")
    grid = calendar[calendar.index('days += \'<button type="button" class="\' + classes'):]
    grid = grid[:grid.index("</button>")]

    assert 'data-calendar-action="open-date" data-date="' in grid
    assert 'plainDay ? "" :' not in grid, "no view may drop the day's open action"
