"""Record module cleaning: one day that finishes a cycle and starts the next round.

A site engineer often cleans the tables a cycle still needs and then carries straight on into the
next round the same afternoon. Those later tables are already cleaned in the running cycle, so they
cannot be added to it -- but they are real work on that date and the billing reads it. The sheet
therefore splits such a day into two entries for the SAME date: the tables that complete this cycle,
and the repeats, which the backend numbers as the next cycle (or, in the month's last cycle, as
extra cleaning).

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
              error: row.report ? "" : row.error, note: row.report ? "" : row.note
            })),
            cleanedTables: rows.cleanedTables, openTables: rows.openTables
          }));
        """, payload, role=role)

    return call


def _case(typed, *, cleaned=(), cycle=1, last_cycle=3, total=35, reason=""):
    return {"typed": typed, "cleaned": list(cleaned), "cycle": cycle,
            "lastCycle": last_cycle, "total": total, "reason": reason}


def test_a_day_that_fills_the_cycle_splits_the_repeats_into_the_next_round(plan_day):
    """The case from the field: 1-25 were all that cycle 1 still needed, and 26-35 were cleaned
    again the same afternoon. Both parts are kept, in the order they were entered."""
    done = range(26, 36)                                       # 26-35 cleaned earlier in cycle 1
    plan, = plan_day(_case("1-25, 26-35", cleaned=done))

    assert not plan["error"]
    assert plan["numbers"] == list(range(1, 26))
    assert plan["nextNumbers"] == list(range(26, 36))
    assert plan["count"] == 35, "the day's count is everything cleaned, both parts"
    assert plan["note"] == ("25 tables complete cycle 1 · 10 tables (26–35) "
                            "start cycle 2 on this same date.")


def test_the_repeats_may_be_typed_first_or_scattered(plan_day):
    """Operators do not type tidily. The split is by what the cycle still needs, not by position."""
    done = range(26, 36)
    first, scattered = plan_day(
        _case("26-35, 1-25", cleaned=done),
        _case("26-30, 1-25, 31-35", cleaned=done),
    )
    assert first["numbers"] == list(range(1, 26)) and first["nextNumbers"] == list(range(26, 36))
    assert scattered["numbers"] == list(range(1, 26))
    assert scattered["nextNumbers"] == list(range(26, 31)) + list(range(31, 36))


def test_descending_and_mixed_ranges_keep_the_order_they_were_entered(plan_day):
    plan, = plan_day(_case("25-1, 35-26", cleaned=range(26, 36)))
    assert plan["numbers"] == list(range(25, 0, -1))
    assert plan["nextNumbers"] == list(range(35, 25, -1))


def test_a_repeat_that_does_not_finish_the_cycle_is_still_refused(plan_day):
    """Only the day the cycle actually closes may roll over, so a mistyped table cannot open the
    next cycle silently. The message says exactly what is still missing."""
    plan, = plan_day(_case("1-20, 26-35", cleaned=range(26, 36)))

    assert plan["numbers"] == [] and plan["nextNumbers"] == []
    assert "Table 26 is already cleaned in this cycle." in plan["error"]
    assert "Add the 25 tables still open (1–25) to finish cycle 1 on this date" in plan["error"]
    assert "saved as cycle 2 on the same date" in plan["error"]
    assert not plan["note"]


def test_the_last_cycle_calls_the_roll_over_extra_washing(plan_day):
    """Cycle 3 has no next cycle: the same split happens, described and saved as extra cleaning."""
    split, refused = plan_day(
        _case("1-25, 26-35", cleaned=range(26, 36), cycle=3),
        _case("1-20, 26-35", cleaned=range(26, 36), cycle=3),
    )
    assert split["nextNumbers"] == list(range(26, 36))
    assert "count as extra washing on this same date." in split["note"]
    assert "saved as extra washing on the same date" in refused["error"]


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


def test_the_sheet_sends_the_roll_over_as_a_second_entry_for_the_same_date():
    """The save path must send both parts, the completing one first (the backend keeps that order),
    and must not drop one of a date's entries from the sheet afterwards."""
    calendar = CALENDAR.read_text(encoding="utf-8")
    save = calendar[calendar.index("if (row.error) { invalidRange = true; return; }"):]
    save = save[:save.index("if (invalidRange")]
    assert save.index("table_numbers: row.numbers") < save.index("table_numbers: row.nextNumbers"), \
        "the entry that completes the cycle must be sent before the roll-over"
    assert "is_extra: !nextCycleNo(state)" in save, "only the last cycle's roll-over is extra cleaning"
    # Saved reports are replaced by id: a date can now hold more than one entry.
    assert "savedIds.indexOf(item.id) === -1" in calendar
    assert not re.search(r"return item\.report_date !== report\.report_date;", calendar), \
        "replacing a date's reports wholesale deletes the other cycle's entry for that date"
    # A saved extra-cleaning entry sits beside the entry that completed the cycle on the same date,
    # so the sheet must not let it read as that cycle's progress.
    assert 'if (row.report.is_extra === true) numbers += " (extra cleaning)";' in calendar



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


def test_the_next_cycle_can_be_recorded_on_the_completion_date_afterwards(record_rows):
    """Cycle 1 filled on the 19th and nothing else is saved yet: the 19th is still offered on cycle
    2's tab, so work done that afternoon can be added after the fact."""
    done = [_saved("2026-11-10", 1, range(26, 36)),
            _saved("2026-11-19", 1, range(1, 26), completed=True)]

    grid = record_rows(2, done, today=TODAY, month=MONTH)

    assert [row["date"] for row in grid["rows"]][0] == "2026-11-19"
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
