"""The PM dashboard opens a plant's calendar directly, and the register is equipment-wise.

Driven through the real module in Node against a minimal DOM, the way the other frontend
behaviour in this suite is tested:

  All plants (Matrix or Cards) -> a plant -> THAT plant's PM calendar, same month, with
  "Back to all plants"; coming back restores the search, filters, layout and scroll position.

The plant page's Monthly activity register is one row per equipment category, counted from the
plant's own assigned activities, collapsed until asked to expand — not one row per inverter.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
TRACKING = ASSETS / "js" / "pm-tracking.js"
NAVIGATION = ASSETS / "js" / "navigation.js"
CSS = ASSETS / "css" / "pm-tracking.css"

HARNESS = r"""
    const assert = (cond, msg) => { if (!cond) { throw new Error(msg); } };
    global.window = global;
    const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    global.Solar91PortalFormat = { escape: esc };
    const docHandlers = {};
    global.document = {
      addEventListener: (t, f) => { docHandlers[t] = f; },
      visibilityState: 'visible',
      createElement: () => ({ click() {}, setAttribute() {}, set href(v) {}, set download(v) {} }),
      activeElement: null,
      contains: () => false
    };
    const scrolls = [];
    global.addEventListener = () => {};
    global.scrollTo = (x, y) => scrolls.push([x, y]);
    global.scrollY = 0;
    global.matchMedia = () => ({ matches: false });

    const navCalls = [];
    let routeState = { activeView: 'view-sub', selectedViewPage: 'pm', pmCalendarOpen: false };
    global.Solar91PortalNav = {
      getState: () => routeState,
      selectPlantPage: (code, page, range, record, opts) => {
        navCalls.push({ kind: 'plant-page', code, page, opts: opts || {} });
        routeState = { activeView: 'plant-sub', selectedPlant: code, selectedSubPage: page,
                       pmCalendarOpen: !!(opts && opts.pmCalendar) };
      },
      selectView: view => { navCalls.push({ kind: 'view', view }); },
      openPMCalendar: (month, id) => { navCalls.push({ kind: 'open-calendar', month, id }); },
      closePMCalendar: () => { navCalls.push({ kind: 'close-calendar' }); }
    };

    const CATEGORIES = ['Inverter', 'ACCB', 'IDT Transformer', 'VCB', '4 Pole + ACDB + Aux. TX',
                        'Transmission line', 'GSS visit', 'Earth pit', 'Miscellaneous'];
    const PLANTS = [
      { id: 'p1', site_code: 'ABH01', name: 'Abhaneri', district: 'Dausa', supervisor: 'S One', configured: true },
      { id: 'p2', site_code: 'ALN01', name: 'Alaniyawas', district: 'Ajmer', supervisor: 'S Two', configured: true }
    ];
    function activity(over) {
      return Object.assign({
        id: 'a' + Math.random().toString(36).slice(2), plant_id: 'p1', equipment: 'Inverter',
        equipment_id: 'INV-01', date: '2026-11-04', status: 'Scheduled', permission: 'None',
        label: 'Scheduled', late: false, blocker: null, checks: ['Check one', 'Check two'],
        checklist: [], submitted_name: null, inspected_on: null,
        can_submit: false, can_review: false, can_request: false, can_grant: false
      }, over || {});
    }
    // Four inverters: one approved, one submitted, one overdue, one locked. Plus one ACCB.
    const PLANT_ACTIVITIES = [
      activity({ id: 'inv1', equipment_id: 'INV-01', date: '2026-11-02', status: 'Approved',
                 label: 'Approved', reviewed_name: 'Head', submitted_name: 'Engineer',
                 inspected_on: '2026-11-02' }),
      activity({ id: 'inv2', equipment_id: 'INV-02', date: '2026-11-04', status: 'Pending approval',
                 label: 'Pending approval', submitted_name: 'Engineer', inspected_on: '2026-11-04',
                 can_review: true }),
      activity({ id: 'inv3', equipment_id: 'INV-03', date: '2026-11-06', label: 'Overdue', late: true,
                 can_submit: true }),
      activity({ id: 'inv4', equipment_id: 'INV-04', date: '2026-11-08', label: 'Locked',
                 blocker: { id: 'inv3', equipment_id: 'INV-03', date: '2026-11-06' }, can_request: true }),
      activity({ id: 'accb1', equipment: 'ACCB', equipment_id: 'ACCB-01', date: '2026-11-10',
                 label: 'Scheduled' })
    ];
    const BODY = {
      month: '2026-11', as_of: '2026-11-25T06:00:00Z', today: '2026-11-25', role: 'O&M Head',
      categories: CATEGORIES, covered: CATEGORIES, plants: PLANTS, legacy: [], legacy_truncated: false
    };
    const urls = [];
    global.Solar91PortalAPI = {
      request: url => {
        urls.push(url);
        const scoped = url.indexOf('site_code=') !== -1;
        return Promise.resolve(Object.assign({}, BODY, {
          plants: scoped ? [PLANTS[0]] : PLANTS,
          activities: scoped ? PLANT_ACTIVITIES
            : PLANT_ACTIVITIES.map(a => ({ id: a.id, plant_id: a.plant_id, equipment: a.equipment,
                equipment_id: a.equipment_id, date: a.date, status: a.status, permission: a.permission,
                label: a.label, late: a.late, blocker: a.blocker }))
        }));
      }
    };
    require('./assets/js/pm-tracking.js');

    function makeHost() {
      const el = { isConnected: true, offsetParent: {}, html: '', handlers: {} };
      Object.defineProperty(el, 'innerHTML', { get: () => el.html, set: v => { el.html = v; } });
      el.addEventListener = (type, fn) => { el.handlers[type] = fn; };
      el.querySelector = sel => (sel === '.s91pm' && el.html.indexOf('s91pm') !== -1 ? {} : null);
      el.querySelectorAll = () => [];
      return el;
    }
    function fire(host, type, attrs) {
      const node = { dataset: attrs, getAttribute: key => attrs[key],
                     closest: sel => (sel === '[data-pmx]' ? node : null) };
      host.handlers[type]({ target: { closest: sel => (sel === '[data-pmx]' ? node : null) },
                            stopPropagation() {} });
    }
    // Only the Monthly activity register, so the page's other panels (Sequence control names
    // the first unresolved unit) cannot be mistaken for an expanded group.
    const register = host => {
      const at = host.html.indexOf('Monthly activity register');
      assert(at !== -1, 'the register is missing');
      return host.html.slice(at, host.html.indexOf('Existing schedule'));
    };
    const tick = () => new Promise(r => setTimeout(r, 0));
    const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
"""


def _run(script: str) -> None:
    run = subprocess.run(["node", "-e", HARNESS + script], cwd=ROOT,
                         capture_output=True, text=True, timeout=40)
    assert run.returncode == 0, run.stderr or run.stdout


def test_a_plant_on_the_all_plants_dashboard_opens_its_own_calendar_in_the_same_month():
    _run(r"""
      (async () => {
        const host = makeHost();
        Solar91PMTracking.show(host, {});                       // all plants, portfolio view
        await settle();
        assert(host.html.indexOf('Preventive Maintenance') !== -1, 'portfolio did not render');
        assert(host.html.indexOf('s91pm-matrix') !== -1, 'matrix is the default layout');

        // Matrix view: the plant link carries its site code.
        assert(/data-pmx="plant" data-code="ABH01"/.test(host.html), 'matrix plant link missing');
        // Cards view: the same action on every card.
        fire(host, 'click', { pmx: 'layout', layout: 'cards' });
        assert(host.html.indexOf('s91pm-cards') !== -1, 'cards layout did not render');
        assert((host.html.match(/data-pmx="plant"/g) || []).length === 2, 'every card is a plant link');

        // A month other than today's, then open a plant.
        fire(host, 'click', { pmx: 'prev' });
        await settle();
        fire(host, 'click', { pmx: 'plant', code: 'ALN01' });
        const call = navCalls.find(c => c.kind === 'plant-page');
        assert(call, 'no navigation happened');
        assert(call.page === 'pm', 'wrong page: ' + call.page);
        assert(call.code === 'ALN01', 'wrong plant: ' + call.code);
        assert(call.opts.pmCalendar === true, 'the calendar was not opened directly');
        assert(call.opts.pmCalendarMonth === '2026-10', 'the month was not carried: ' + call.opts.pmCalendarMonth);
        assert(call.opts.pmParent === 'overview', 'the way back to all plants was lost');
        assert(scrolls.some(s => s[1] === 0), 'the calendar should open at the top of the page');
      })().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
    """)


def test_the_calendar_offers_back_to_all_plants_and_restores_the_dashboard_as_it_was():
    _run(r"""
      (async () => {
        const host = makeHost();
        Solar91PMTracking.show(host, {});
        await settle();
        // Narrow the dashboard, switch to cards, and scroll down.
        host.handlers.input({ target: { dataset: { pmxFilter: 'query' }, value: 'Alan', selectionStart: 4 } });
        host.handlers.change({ target: { dataset: { pmxFilter: 'status' }, value: 'Overdue' } });
        fire(host, 'click', { pmx: 'layout', layout: 'cards' });
        global.scrollY = 640;
        fire(host, 'click', { pmx: 'plant', code: 'ALN01' });

        // The plant's calendar: its back button names the page it returns to.
        routeState = { activeView: 'plant-sub', selectedPlant: 'ABH01', selectedSubPage: 'pm', pmCalendarOpen: true };
        const calendar = makeHost();
        Solar91PMTracking.show(calendar, { siteCode: 'ABH01', calendar: true, calendarParent: 'overview',
                                           initialMonth: '2026-11', parent: 'overview' });
        await settle();
        assert(calendar.html.indexOf('Back to all plants') !== -1, 'the Back to all plants button is missing');
        assert(calendar.html.indexOf('s91pm-cal-grid') !== -1, 'the existing calendar component was not reused');
        fire(calendar, 'click', { pmx: 'back-calendar' });
        assert(navCalls.some(c => c.kind === 'close-calendar'), 'back did not close the calendar');

        // Back on the dashboard: same search, same filter, same layout, same scroll position.
        routeState = { activeView: 'view-sub', selectedViewPage: 'pm', pmCalendarOpen: false };
        scrolls.length = 0;
        const again = makeHost();
        Solar91PMTracking.show(again, {});
        await settle();
        assert(again.html.indexOf('value="Alan"') !== -1, 'the search was not restored');
        assert(again.html.indexOf('<option value="Overdue" selected>') !== -1, 'the status filter was not restored');
        assert(again.html.indexOf('s91pm-cards') !== -1, 'the cards layout was not restored');
        assert(scrolls.some(s => s[1] === 640), 'the scroll position was not restored: ' + JSON.stringify(scrolls));

        // A later, unrelated visit opens clean rather than re-applying old filters.
        const fresh = makeHost();
        Solar91PMTracking.show(fresh, {});
        await settle();
        assert(fresh.html.indexOf('value="Alan"') === -1, 'the one-shot restore leaked into a new visit');
      })().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
    """)


def test_the_register_is_one_row_per_equipment_category_counted_from_the_records():
    _run(r"""
      (async () => {
        routeState = { activeView: 'plant-sub', selectedPlant: 'ABH01', selectedSubPage: 'pm', pmCalendarOpen: false };
        const host = makeHost();
        Solar91PMTracking.show(host, { siteCode: 'ABH01', parent: 'overview' });
        await settle();
        const html = host.html;
        assert(html.indexOf('Monthly activity register') !== -1, 'the register is missing');
        assert(html.indexOf('Equipment-wise summary') !== -1, 'the register is not equipment-wise');

        // Nine category rows, and the columns the register promises.
        const rows = html.match(/data-pmx="expand" data-cat="[^"]+"/g) || [];
        const cats = new Set(rows.map(r => r.match(/data-cat="([^"]+)"/)[1]));
        assert(cats.size === 9, 'expected nine equipment rows, got ' + cats.size);
        ['Inverter', 'ACCB', 'IDT Transformer', 'VCB', '4 Pole + ACDB + Aux. TX',
         'Transmission line', 'GSS visit', 'Earth pit', 'Miscellaneous'].forEach(c => {
          assert(cats.has(c), 'missing equipment row: ' + c);
        });
        ['Approved / Scheduled', 'Completion', 'Pending approval', 'Overdue', 'Locked',
         'Next scheduled', 'Status', 'Details'].forEach(h => {
          assert(html.indexOf('<th>' + h + '</th>') !== -1, 'missing column: ' + h);
        });

        // Counted from the activities themselves: 1 of 4 approved, 1 pending, 1 overdue, 1 locked.
        assert(html.indexOf('>1 / 4</b>') !== -1, 'inverter approved/scheduled count is wrong');
        assert(html.indexOf('<b>25%</b>') !== -1, 'completion percentage is wrong');
        assert(html.indexOf('4 activities') !== -1, 'the inverter row should count four units');
        assert(html.indexOf('No assigned activity') !== -1, 'a category with nothing scheduled should say so');

        // A submitted checklist is NOT counted as completed.
        const inverterRow = html.slice(html.indexOf('data-cat="Inverter"'));
        assert(inverterRow.indexOf('>1 / 4</b>') < inverterRow.indexOf('>0 / 1</b>'),
               'the inverter row must come first');
        assert(html.indexOf('>2 / 4<') === -1, 'a pending submission must not count as approved');

        // Collapsed by default: no unit rows until a row is expanded.
        assert(register(host).indexOf('s91pm-subtable') === -1, 'equipment groups must start collapsed');
        assert(register(host).indexOf('INV-02') === -1, 'individual units must not render until expanded');
        assert((html.match(/>View details</g) || []).length === 9, 'every row offers View details');
      })().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
    """)


def test_expanding_one_equipment_shows_its_units_and_only_that_one():
    _run(r"""
      (async () => {
        routeState = { activeView: 'plant-sub', selectedPlant: 'ABH01', selectedSubPage: 'pm', pmCalendarOpen: false };
        const host = makeHost();
        Solar91PMTracking.show(host, { siteCode: 'ABH01', parent: 'overview' });
        await settle();

        fire(host, 'click', { pmx: 'expand', cat: 'Inverter' });
        let html = register(host);
        assert(html.indexOf('s91pm-subtable') !== -1, 'the expanded group did not render');
        ['INV-01', 'INV-02', 'INV-03', 'INV-04'].forEach(unit => {
          assert(html.indexOf(unit) !== -1, 'missing unit: ' + unit);
        });
        assert(html.indexOf('ACCB-01') === -1, 'expanding one group must not expand the others');
        assert(html.indexOf('>Engineer<') !== -1, 'the engineer who inspected it is shown');
        assert(html.indexOf('Review') !== -1, 'the review action is offered on the submitted unit');
        assert(html.indexOf('Collapse all') !== -1, 'a way to collapse is offered');

        // An activity's action opens that activity in the calendar: the existing checklist UI.
        fire(host, 'click', { pmx: 'event', id: 'inv2' });
        const opened = navCalls.filter(c => c.kind === 'open-calendar').pop();
        assert(opened && opened.id === 'inv2', 'the unit did not open in the calendar');
        assert(opened.month === '2026-11', 'the calendar was opened in the wrong month');

        // Collapsing puts it back.
        fire(host, 'click', { pmx: 'expand', cat: 'Inverter' });
        assert(register(host).indexOf('INV-02') === -1, 'the group did not collapse');
        fire(host, 'click', { pmx: 'expand', cat: 'ACCB' });
        fire(host, 'click', { pmx: 'collapse-all' });
        assert(register(host).indexOf('s91pm-subtable') === -1, 'Collapse all left a group open');
      })().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
    """)


# ── routing and styling, read from the source ───────────────────────────────


def test_navigation_opens_the_calendar_without_a_second_page_or_a_reload():
    navigation = NAVIGATION.read_text(encoding="utf-8")

    # One PM module for both screens (the existing calendar component is reused).
    assert 'if (pageId === "pm") return ["pm-tracking"];' in navigation
    assert "Solar91PMTracking.show" in navigation
    # The plant route can open straight on the calendar, with its month and activity.
    assert 'var openCalendar = navState.selectedSubPage === "pm" && !!(options && options.pmCalendar);' in navigation
    assert "options.pmCalendarMonth" in navigation and "options.pmCalendarEventId" in navigation
    assert "calendarParent: navState.pmCalendarParent," in navigation
    # Which page Back returns to travels with the history entry.
    assert "pmCalendarParent: navState.pmCalendarParent" in navigation
    assert 'navState.pmCalendarParent = snapshot.pmCalendarParent === "overview" ? "overview" : "plant";' in navigation
    # Back pops the pushed entry when there is one, and otherwise closes by state.
    assert "if (pmCalendarPushed) {" in navigation
    assert 'if (navState.pmCalendarParent === "overview" && !restrictedPages()) {' in navigation
    # Role guards are untouched: a role without the PM page cannot be routed to its calendar.
    assert "enforceRolePages" in navigation
    assert "function isPlantPageAllowed(pageId)" in navigation


def test_the_individual_plant_pm_page_is_still_reachable_from_the_plants_tab():
    navigation = NAVIGATION.read_text(encoding="utf-8")
    tracking = TRACKING.read_text(encoding="utf-8")

    # The Plants tab opens the plant's PM page itself: no pmCalendar option, so no calendar.
    assert '{ id: "pm",              label: "Preventive Maintenance" }' in navigation
    assert "navState.pmCalendarOpen = openCalendar;" in navigation
    # That page still carries its own calendar button and its tracker sections.
    assert 'btn("Open PM calendar →","calendar","",true)' in tracking
    assert "Equipment-wise progress" in tracking and "Sequence control" in tracking


def test_the_register_keeps_the_filters_and_the_portals_own_design():
    tracking = TRACKING.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")

    register = tracking[tracking.index("function registerPanel("):tracking.index("function rowTable(")]
    assert "filters(s,false)" in register, "search, equipment, status and date filters are kept"
    assert "legend()" in register
    assert "stats(all)" in register, "the counts come from the plant's own activity records"
    assert "s.open.has(c)" in register, "each group's state is its own"
    # Sticky heading, the matrix's gradient tones, compact progress bars, no nested scroller.
    assert ".s91pm-reg thead th{position:sticky;top:0" in css
    assert ".s91pm-reg .s91pm-reg-row{cursor:pointer;background:linear-gradient(" in css
    assert "border-left:3px solid var(--pm-edge" in css
    assert ".s91pm-mini{display:flex" in css
    units = tracking[tracking.index("function unitRows("):tracking.index("/**\n   * Monthly activity register")]
    assert "s91pm-scroll" not in units, "the expanded units must not add a second scrolling box"
    # Phones and tablets: the register's own narrow rules, and the shared breakpoints.
    assert "@media(max-width:600px){.s91pm-reg th:first-child" in css


def test_approved_is_the_only_completion_the_register_counts():
    tracking = TRACKING.read_text(encoding="utf-8")

    assert 'approved:count(r,a=>a.status==="Approved")' in tracking
    assert 'pending:count(r,a=>a.status==="Pending approval")' in tracking
    assert "approved completion only" in tracking
    status = tracking[tracking.index("function catStatus("):tracking.index("/** The activity this equipment")]
    assert 'if(n.approved===n.total)return "Completed";' in status
    assert 'if(n.late)return "Overdue";' in status
    assert 'if(n.pending)return "Pending approval";' in status


def test_the_checklist_can_be_opened_for_a_walkthrough_but_never_records_an_entry():
    """Showing the work is not doing the work: the form opens, and saving is impossible."""
    _run(r"""
      (async () => {
        routeState = { activeView: 'plant-sub', selectedPlant: 'ABH01', selectedSubPage: 'pm', pmCalendarOpen: true };
        const host = makeHost();
        Solar91PMTracking.show(host, { siteCode: 'ABH01', calendar: true, calendarParent: 'overview',
                                       initialMonth: '2026-11', parent: 'overview' });
        await settle();

        // INV-04 is locked behind an earlier activity: this user may not record it.
        fire(host, 'click', { pmx: 'select', id: 'inv4' });
        assert(host.html.indexOf('Open checklist (preview)') !== -1, 'the checklist cannot be opened at all');

        fire(host, 'click', { pmx: 'record', id: 'inv4' });
        const html = host.html;
        assert(html.indexOf('data-pmx-preview') !== -1, 'the form did not open in preview mode');
        assert(html.indexOf('Preview only') !== -1, 'the form does not say that nothing is saved');
        assert(/type="submit" disabled/.test(html), 'the submit button must be disabled in a preview');
        assert(html.indexOf('Check one') !== -1, 'the real checklist items are shown');
        assert(html.indexOf('Close preview') !== -1, 'there is no way out of the preview');

        // Even if the disabled button is bypassed, nothing is sent.
        const before = urls.length;
        host.handlers.submit({
          preventDefault() {},
          target: { matches: sel => sel === '[data-pmx-submit-form],[data-pmx-submit-form]' ||
                                    sel === '[data-pmx-action-form],[data-pmx-submit-form]' ||
                                    sel === '[data-pmx-submit-form]',
                    querySelector: () => null, querySelectorAll: () => [] }
        });
        await settle();
        assert(urls.length === before, 'a preview must never reach the API');

        // The one the user may record still offers the real button.
        fire(host, 'click', { pmx: 'select', id: 'inv3' });
        assert(host.html.indexOf('s91pm-primary" data-pmx="record"') !== -1, 'the real Record PM button is gone');
      })().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
    """)
