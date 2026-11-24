"""Extra cleaning is managed from the Module Cleaning board, not only from a plant's calendar.

An entry recorded by mistake used to be fixable only by opening that plant's cleaning calendar and
finding the day. The board now lists the month's entries and offers the same three actions on each
one -- edit, "Count as cleaning (not extra)" and remove.

There is exactly ONE implementation of all of it: assets/js/extra-cleaning.js. Both screens call
in, so these tests check the shared module's behaviour once and then check that neither page has
grown a copy of the wording, the confirm flow, the role rule or the endpoints. The server-side
permission is unchanged and covered by
tests/test_washing_extra_mid_cycle.py::test_site_engineer_cannot_edit_or_remove_extra_cleaning.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
BOARD = ROOT / "assets" / "js" / "washing-board.js"
CALENDAR = ROOT / "assets" / "js" / "operations-calendar.js"
EXTRAS = ROOT / "assets" / "js" / "extra-cleaning.js"
BOARD_CSS = ROOT / "assets" / "css" / "washing-board.css"
CALENDAR_CSS = ROOT / "assets" / "css" / "calendar.css"

PURPLE = "#6b2f8f"      # re-cleaning during a cycle: never counted
BLUE = "#1366b0"        # cleaning after all three cycles: counted

BOARD_EXPORT = "  global.Solar91PortalWashingBoard = { show: show };"


def _node(script: str, *args: str) -> str:
    run = subprocess.run(
        ["node", "-e", script, *args],
        # node writes UTF-8; Windows would otherwise decode it with the console codepage and the
        # "·" and "–" in these labels would come back as mojibake.
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=30,
    )
    assert run.returncode == 0, run.stderr or run.stdout
    return run.stdout


# ── the shared module ───────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def shared():
    """Call into assets/js/extra-cleaning.js with the browser globals stubbed."""

    def call(body: str, payload=None, role: str = "Assignee"):
        script = """
          global.window = global;
          global.Solar91PortalFormat = { escape: (s) => String(s == null ? '' : s) };
          global.Solar91PortalAPI = { request: () => Promise.resolve({}), can: () => true,
                                      currentUser: () => ({ role: %s }) };
          eval(require('fs').readFileSync('./assets/js/extra-cleaning.js', 'utf8'));
          const ec = global.Solar91ExtraCleaning;
          const one = JSON.parse(process.argv[1]);
          %s
        """ % (json.dumps(role), body)
        return json.loads(_node(script, json.dumps(payload)))

    return call


def _entry(**over):
    entry = {
        "id": "r1", "site_code": "ABH01", "plant": "Abhaypur", "cycle_month": "2026-11",
        "cycle_no": 2, "report_date": "2026-11-09", "tables_cleaned": 4,
        "cleaned_table_codes": ["Table 001", "Table 002", "Table 003", "Table 004"],
        "remarks": "fog", "reported_by": "Nikhil Sharma", "review_status": "Confirmed",
        "is_extra": True, "post_cycle": False, "can_edit": True, "can_delete": True,
    }
    entry.update(over)
    return entry


def test_the_two_kinds_of_entry_keep_their_own_label_and_colour(shared):
    """During-cycle re-cleaning and after-the-cycles cleaning are not the same thing."""
    out = shared("""
      process.stdout.write(JSON.stringify(one.map(function (entry) {
        return { label: ec.cycleLabel(entry), tone: ec.tone(entry), badge: ec.badgeHTML(entry),
                 extra: ec.isExtra(entry), after: ec.isPostCycle(entry) };
      })));
    """, [
        _entry(),
        _entry(is_extra=False, post_cycle=True, cycle_no=3),
        _entry(is_extra=False, post_cycle=False, cycle_no=1),
        # The stored flag is what separates them: a marked entry is re-cleaning wherever it falls.
        _entry(is_extra=True, post_cycle=True, cycle_no=3),
    ])

    during, after, ordinary, marked = out
    assert during["label"] == "During cycle 2" and during["tone"] == "extra"
    assert "ep-calendar__extra-badge" in during["badge"] and ">Extra<" in during["badge"]
    assert after["label"] == "After cycle 3" and after["tone"] == "after-cycles"
    assert "ep-calendar__after-badge" in after["badge"]
    assert ordinary["label"] == "Cycle 1" and ordinary["tone"] == "" and ordinary["badge"] == ""
    assert marked["label"] == "During cycle 3" and marked["after"] is False


def test_both_screens_draw_the_identical_three_actions(shared):
    """Only the data-attribute each page listens on differs; wording and order do not."""
    out = shared("""
      const state = ec.actionState();
      const calendar = ec.actionsHTML({ reportId: 'r1', canEdit: true, canDelete: true }, state,
                                      { attr: 'data-calendar-action' });
      const board = ec.actionsHTML(one, state, { attr: 'data-wb-extra-action' });
      state.extraDeleteConfirmId = 'r1';
      const confirming = ec.actionsHTML(one, state, { attr: 'data-wb-extra-action' });
      state.extraDeleteConfirmId = '';
      state.extraConverting = true;
      const converting = ec.actionsHTML(one, state, { attr: 'data-wb-extra-action' });
      const noDelete = ec.actionsHTML(Object.assign({}, one, { can_delete: false }),
                                      ec.actionState(), { attr: 'data-wb-extra-action' });
      process.stdout.write(JSON.stringify({ calendar: calendar, board: board,
        confirming: confirming, converting: converting, noDelete: noDelete }));
    """, _entry())

    normalised = out["calendar"].replace("data-calendar-action", "@")
    assert normalised == out["board"].replace("data-wb-extra-action", "@"), (
        "the two screens would show different markup"
    )
    for piece in ("Edit extra cleaning", "Count as cleaning (not extra)", "Remove extra cleaning"):
        assert piece in out["board"], piece
    # "Count as cleaning" is the action that matters most here, so it is not hidden behind Remove.
    assert out["board"].index("Count as cleaning (not extra)") < out["board"].index("Remove extra cleaning")

    # Removing asks twice, with the same warning the calendar has always used.
    assert "Remove this extra cleaning record? This cannot be undone." in out["confirming"]
    assert 'data-wb-extra-action="cancel-extra-delete"' in out["confirming"]
    assert 'data-wb-extra-action="confirm-extra-delete"' in out["confirming"]
    assert "Keep entry" in out["confirming"]
    assert "Edit extra cleaning" not in out["confirming"], "the first step is replaced, not added to"

    # Saving disables the button it belongs to rather than leaving it clickable twice.
    assert "Counting…" in out["converting"] and " disabled" in out["converting"]
    assert "Remove extra cleaning" not in out["noDelete"]


def test_the_form_asks_which_plant_only_when_none_is_in_scope(shared):
    out = shared("""
      const open = { extraOpen: true, extraEditId: '', extraPlantCode: '', extraDate: '',
                     extraList: '', extraRemarks: '', extraSaving: false, extraError: '' };
      const hooks = { attr: 'data-wb-extra-action', formAttr: 'data-wb-extra-form',
                      modalAttr: 'data-wb-extra-modal', today: '2026-11-24',
                      minDate: '2026-11-01', plants: [{ code: 'ABH01', name: 'Abhaypur' }] };
      const asking = ec.formHTML(open, hooks);
      const scoped = ec.formHTML(Object.assign({}, open, { extraPlantCode: 'ABH01' }),
        Object.assign({}, hooks, { plantCode: 'ABH01', plantId: 'uuid-1',
                                   plantName: 'Abhaypur', tableCount: 40 }));
      // A plant's own calendar is already inside one plant and offers no chooser.
      const calendar = ec.formHTML(open, { attr: 'data-calendar-action', plantId: 'uuid-1',
        plantName: 'Abhaypur', tableCount: 40, today: '2026-11-24', minDate: '2026-11-01' });
      process.stdout.write(JSON.stringify({ asking: asking, scoped: scoped, calendar: calendar }));
    """)

    assert "data-extra-plant" in out["asking"]
    assert "Choose the plant this extra cleaning belongs to" in out["asking"]
    assert "data-extra-list" not in out["asking"], "nothing else is asked before the plant"
    assert 'data-wb-extra-action="save-extra"' in out["asking"] and " disabled" in out["asking"]

    assert "data-extra-plant" in out["scoped"] and 'value="ABH01" selected' in out["scoped"]
    assert "data-extra-list" in out["scoped"] and "40 tables per cycle" in out["scoped"]

    assert "data-extra-plant" not in out["calendar"]
    assert "data-calendar-extra-form" in out["calendar"]


def test_the_three_actions_use_the_existing_endpoints_and_then_re_read(shared):
    """Converting moves tables INTO a cycle's progress and can complete it, so neither screen
    patches a figure locally: both ask the server again."""
    out = shared("""
      const calls = [];
      const events = [];
      global.Solar91PortalAPI.request = function (url, opts) {
        calls.push((opts && opts.method || 'GET') + ' ' + url + ' ' + JSON.stringify(opts && opts.body || null));
        return Promise.resolve({});
      };
      const state = ec.actionState();
      const ctx = { find: () => one, render: () => events.push('render'),
                    reload: (keep) => events.push('reload:' + keep),
                    prune: (id) => events.push('prune:' + id),
                    saved: () => {}, alive: () => true };
      ec.act('convert-extra', 'r1', state, ctx);
      ec.act('request-extra-delete', 'r1', state, ctx);
      const asked = state.extraDeleteConfirmId;
      ec.act('confirm-extra-delete', 'r1', state, ctx);
      setTimeout(function () {
        process.stdout.write(JSON.stringify({ calls: calls, events: events, asked: asked }));
      }, 0);
    """, _entry())

    assert out["calls"] == [
        'PATCH /api/scheduled/washing/daily-reports/r1 {"is_extra":false}',
        "DELETE /api/scheduled/washing/daily-reports/r1 null",
    ]
    assert out["asked"] == "r1", "Remove asks before it removes"
    assert "reload:false" in out["events"], "converting re-reads the page's figures"
    assert "prune:r1" in out["events"] and "reload:true" in out["events"]


def test_the_shared_module_owns_the_only_requests_and_the_only_role_rule():
    shared = EXTRAS.read_text(encoding="utf-8")

    # PATCH and DELETE on the existing daily-reports resource; no endpoint of its own.
    assert '"/api/scheduled/washing/daily-reports"' in shared
    assert '{ is_extra: false }' in shared
    assert 'method: "DELETE"' in shared and 'method: "PATCH"' in shared
    # The rule is the server's; this only decides what is worth drawing.
    assert shared.count('user.role === "O&M Head" || user.role === "Assignee"') == 1
    assert "app/scheduled/washing_cycles.py" in shared


# ── the board ───────────────────────────────────────────────────────────────


def _code(path: Path) -> str:
    """The file's code with its comments stripped, so prose about an action is not mistaken for one."""
    source = re.sub(r"/\*.*?\*/", "", path.read_text(encoding="utf-8"), flags=re.S)
    lines = source.splitlines()
    return chr(10).join(line for line in lines if not line.strip().startswith("//"))


def test_the_board_calls_the_shared_module_instead_of_carrying_a_copy():
    board = _code(BOARD)
    calendar = _code(CALENDAR)
    modules = (ROOT / "assets" / "js" / "modules.js").read_text(encoding="utf-8")

    assert '"washing-board": ["table-sort", "table-column-filter", "extra-cleaning"]' in modules
    assert '"extra-cleaning": "/assets/js/extra-cleaning.js"' in (
        (ROOT / "frontend" / "templates" / "index.html").read_text(encoding="utf-8")
    )

    for page, name in ((board, "washing-board.js"), (calendar, "operations-calendar.js")):
        assert "extras().act(" in page, name
        # No second confirm flow, no second wording, no second role check, no second request.
        assert "This cannot be undone" not in page, name
        assert "Count as cleaning (not extra)" not in page, name
        assert "Remove extra cleaning" not in page, name
        assert "{ is_extra: false }" not in page, name
        assert 'user.role === "O&M Head"' not in page, name
    assert "extras().formHTML" in board and "extras().formHTML" in calendar
    assert ".actionsHTML(" in board, "the board draws the actions through the shared module"


def test_the_board_reads_the_entries_from_the_overview_only_when_they_are_asked_for():
    board = BOARD.read_text(encoding="utf-8")

    assert '"/api/scheduled/washing/overview?month="' in board
    assert 'var wantEntries = ui.entryStatus === "extra";' in board
    assert '"&include_reports=true&report_days=" + monthSpanDays(month)' in board
    assert '"&include_reports=false"' in board
    assert ">Extra cleaning</option>" in board

    # Every change re-reads the overview rather than patching a number: converting an entry can
    # complete a cycle, and cycle state is the server's answer.
    reload_at = board.index("scope.reload = function ()")
    assert "show(container, st.selectedMonth)" in board[reload_at:reload_at + 200]
    saved_at = board.index("scope.saved = function (")
    assert "show(container, st.selectedMonth)" in board[saved_at:saved_at + 300]


@pytest.fixture(scope="module")
def board_internals():
    """Evaluate assets/js/washing-board.js in node with its one export line swapped."""
    source = BOARD.read_text(encoding="utf-8")
    assert source.count(BOARD_EXPORT) == 1, "the board module's export line moved"

    def call(body: str, payload=None, role: str = "Assignee"):
        script = """
          global.window = global;
          global.localStorage = { getItem: () => null, setItem: () => {} };
          global.Solar91PortalFormat = { escape: (s) => String(s == null ? '' : s) };
          global.Solar91PortalAPI = { request: () => Promise.resolve({}), can: () => true,
                                      currentUser: () => ({ role: %s }) };
          global.Solar91PortalSort = { apply: (rows) => rows };
          global.Solar91PortalColumnFilter = { headerHTML: () => '', wire: () => {} };
          const fs = require('fs');
          eval(fs.readFileSync('./assets/js/extra-cleaning.js', 'utf8'));
          let src = fs.readFileSync('./assets/js/washing-board.js', 'utf8');
          src = src.replace(%s,
            '  global.__b = { st, ui, extraEntriesInScope, visibleRows, baseRows, monthSpanDays, extraEntryHTML, extraPanelHTML };');
          eval(src);
          const B = global.__b;
          const one = JSON.parse(process.argv[1]);
          %s
        """ % (json.dumps(role), json.dumps(BOARD_EXPORT), body)
        return json.loads(_node(script, json.dumps(payload)))

    return call


def _row(code, **over):
    row = {"site_code": code, "plant": code + " plant", "plant_id": "uuid-" + code,
           "table_count": 40, "cleaned_cycles": [1, 2, 3], "current_cycle": 2,
           "cycles_this_month": 1, "monthly_target": 3, "overdue_bucket": "on_track",
           "monthly_compliance_percent": 60.0, "cycle_grades": []}
    row.update(over)
    return row


def test_the_entries_respect_the_plant_cycle_and_date_already_filtered(board_internals):
    out = board_internals("""
      B.st.rows = one.rows;
      B.st.month = '2026-11';
      B.st.selectedMonth = '2026-11';
      B.st.today = '2026-11-24';
      B.st.extraEntries = one.entries;
      const ids = () => B.extraEntriesInScope().map((entry) => entry.id);
      const codes = () => B.visibleRows().map((row) => row.site_code);
      B.ui.entryStatus = 'extra';
      const all = ids();
      const allPlants = codes();
      B.ui.plant = 'ABH01';
      const onePlant = ids();
      const onePlantRows = codes();
      B.ui.cycle = '2';
      const oneCycle = ids();
      B.ui.cycle = '__all';
      B.ui.date = '2026-11-09';
      const oneDate = ids();
      B.ui.date = '__all';
      B.ui.plant = '__all';
      B.ui.search = 'BEE';
      const searched = ids();
      process.stdout.write(JSON.stringify({ all, allPlants, onePlant, onePlantRows,
        oneCycle, oneDate, searched }));
    """, {
        "rows": [_row("ABH01"), _row("BEE01")],
        "entries": [
            _entry(id="a1", site_code="ABH01", cycle_no=2, report_date="2026-11-09"),
            _entry(id="a2", site_code="ABH01", cycle_no=3, report_date="2026-11-18",
                   is_extra=False, post_cycle=True),
            _entry(id="b1", site_code="BEE01", cycle_no=1, report_date="2026-11-04"),
            # another month's entry, and one for a plant outside the caller's rows
            _entry(id="old", site_code="ABH01", cycle_month="2026-10", report_date="2026-10-30"),
            _entry(id="ghost", site_code="ZZZ99"),
        ],
    })

    assert out["all"] == ["a2", "a1", "b1"], "newest first, and only this month's visible plants"
    assert out["allPlants"] == ["ABH01", "BEE01"]
    assert out["onePlant"] == ["a2", "a1"], "the plant filter narrows the entries too"
    assert out["onePlantRows"] == ["ABH01"]
    assert out["oneCycle"] == ["a1"], "the cycle filter narrows the entries too"
    assert out["oneDate"] == ["a1"]
    assert out["searched"] == ["b1"], "the search narrows which plants' entries are in scope"


def test_the_board_shows_only_plants_that_have_an_entry_in_scope(board_internals):
    out = board_internals("""
      B.st.rows = one.rows;
      B.st.month = '2026-11';
      B.st.selectedMonth = '2026-11';
      B.st.extraEntries = one.entries;
      B.ui.entryStatus = 'extra';
      const codes = B.visibleRows().map((row) => row.site_code);
      const panel = B.extraPanelHTML();
      B.ui.entryStatus = '__all';
      const everyPlant = B.visibleRows().map((row) => row.site_code);
      const noPanel = B.extraPanelHTML();
      process.stdout.write(JSON.stringify({ codes, panel, everyPlant, noPanel }));
    """, {
        "rows": [_row("ABH01"), _row("BEE01")],
        "entries": [_entry(id="a1", site_code="ABH01")],
    })

    assert out["codes"] == ["ABH01"], "a plant with no extra cleaning is not on screen"
    assert out["everyPlant"] == ["ABH01", "BEE01"], "and the other filters are untouched"
    assert out["noPanel"] == "", "the list only appears for the Extra cleaning filter"
    assert "ep-wb__entry--extra" in out["panel"]
    assert "During cycle 2" in out["panel"]


def test_an_entry_row_states_the_facts_and_hides_the_actions_from_other_roles(board_internals):
    body = """
      B.st.rows = one.rows;
      B.st.extraEntries = one.entries;
      process.stdout.write(JSON.stringify(one.entries.map(B.extraEntryHTML)));
    """
    payload = {
        "rows": [_row("ABH01")],
        "entries": [
            _entry(),
            # what a Site Engineer is served: the server already says they may not change it
            _entry(id="r2", can_edit=False, can_delete=False),
            _entry(id="r3", is_extra=False, post_cycle=True, cycle_no=3),
        ],
    }
    manager = board_internals(body, payload)

    mine, theirs, after = manager
    assert "09-11-26" in mine and "1–4" in mine and "fog" in mine
    assert "Nikhil Sharma" in mine and "During cycle 2" in mine
    assert "Edit extra cleaning" in mine and "Count as cleaning (not extra)" in mine
    assert 'data-wb-plant="ABH01"' in mine, "the row opens that plant's calendar"

    assert "Edit extra cleaning" not in theirs and "Remove extra cleaning" not in theirs
    assert " disabled" not in theirs, "no disabled buttons cluttering a read-only entry"
    assert "09-11-26" in theirs, "the entry is still fully visible"

    # Work after the three cycles counts towards the month; it is not re-cleaning to put right.
    assert "ep-wb__entry--after-cycles" in after and "After cycle 3" in after
    assert "Count as cleaning (not extra)" not in after


def test_a_site_engineer_cannot_drive_the_actions_even_with_a_button_in_hand(shared):
    """`can_edit` is the server's answer and is what hides the buttons. If one were reached anyway
    -- a stale page, a crafted click -- nothing is sent, and the server's 403 is the real guard
    (tests/test_washing_extra_mid_cycle.py::test_site_engineer_cannot_edit_or_remove_extra_cleaning)."""
    out = shared("""
      const calls = [];
      global.Solar91PortalAPI.request = function (url, opts) {
        calls.push((opts && opts.method) + ' ' + url);
        return Promise.resolve({});
      };
      const state = ec.actionState();
      const ctx = { find: () => one, render: () => {}, reload: () => {}, prune: () => {},
                    saved: () => {}, alive: () => true };
      ['convert-extra', 'request-extra-delete', 'confirm-extra-delete', 'edit-extra']
        .forEach(function (name) { ec.act(name, 'r1', state, ctx); });
      process.stdout.write(JSON.stringify({ calls: calls, state: state }));
    """, _entry(), role="Site Engineer")

    assert out["calls"] == [], "a Site Engineer's click must not reach the API"
    assert out["state"]["extraDeleteConfirmId"] == ""
    assert out["state"]["extraConverting"] is False


def test_the_board_asks_the_server_for_exactly_the_month_on_screen(board_internals):
    out = board_internals("""
      B.st.today = '2026-11-09';
      process.stdout.write(JSON.stringify({
        thisMonth: B.monthSpanDays('2026-11'),
        pastMonth: B.monthSpanDays('2026-09'),
        nonsense: B.monthSpanDays('')
      }));
    """)

    assert out["thisMonth"] == 9, "this month needs only the days so far"
    assert out["pastMonth"] == 30, "an earlier month is read to its last day"
    assert out["nonsense"] == 35, "and an unreadable month falls back to the API's own default"


# ── the colours are the calendar's, not a third set ─────────────────────────


def test_the_board_rows_reuse_the_calendars_two_colours():
    board_css = BOARD_CSS.read_text(encoding="utf-8")
    calendar_css = CALENDAR_CSS.read_text(encoding="utf-8")

    extra = board_css[board_css.index(".ep-wb__entry--extra {"):]
    extra = extra[:extra.index("}")]
    after = board_css[board_css.index(".ep-wb__entry--after-cycles {"):]
    after = after[:after.index("}")]
    assert PURPLE in extra and BLUE not in extra
    assert BLUE in after and PURPLE not in after

    # the same two values the plant calendar's day cards carry
    card_extra = calendar_css[calendar_css.index(".ep-calendar__event-card--extra {"):]
    assert PURPLE in card_extra[:card_extra.index("}")]
    card_after = calendar_css[calendar_css.index(".ep-calendar__event-card--after-cycles {"):]
    assert BLUE in card_after[:card_after.index("}")]

    # the badges are literally that file's rules, reused rather than restated
    assert ".ep-wb__extra-badge" not in board_css and ".ep-wb__after-badge" not in board_css
    assert "ep-calendar__extra-badge" in EXTRAS.read_text(encoding="utf-8")
