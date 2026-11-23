/**
 * PM cycle plans (migration 049): each plant's own monthly Preventive Maintenance cycle.
 *
 * A plant with no plan is PAUSED: no new PM cycles are generated for it. That is a state, not a
 * failure, so it is shown with the action to fix it, and it is never counted as a 0% plant.
 *
 * The calendar is the main element. A wrong day number is invisible until a crew drives to a site
 * on the wrong day, so the editor draws the plan as typed next to what the engine will actually run
 * once chaining is applied (a phase starts on its own day or the day after the previous phase's work
 * ends, whichever is later). The "runs" row always comes from the server's preview, never from a
 * copy of the rule in this file, so the two cannot drift apart.
 */
(function (global) {
  "use strict";

  var CYCLE_DAYS = 30;
  var UNIT_DERIVED = ["inverter"];          // length follows pm_unit_config, not the plan
  var state = freshState();
  var wiredHosts = new WeakSet();
  var previewTimer = null;

  function freshState() {
    return {
      host: null, siteCode: null, list: null, loading: false, error: "",
      open: false, filter: "all", search: "",
      selected: null, plan: null, planLoading: false, planError: "",
      draft: null, baseVersion: null, dirty: false,
      preview: null, previewError: "", previewSeq: 0, previewBusy: false,
      saving: false, notice: "", noticeError: false, stale: false
    };
  }

  function api() { return global.Solar91PortalAPI; }
  function esc(value) { return global.Solar91PortalFormat.escape(value == null ? "" : String(value)); }
  function role() {
    var user = api() && api().currentUser ? api().currentUser() : null;
    return user && user.role || "";
  }
  function canEdit() { return role() === "O&M Head"; }
  /** Who may read the plans (the server's CREATOR_ROLES). Anyone else is not asked at all. */
  function canView() { return role() === "O&M Head" || role() === "Assignee"; }
  function isUnitDerived(categories) {
    return (categories || []).some(function (c) { return UNIT_DERIVED.indexOf(String(c).trim().toLowerCase()) !== -1; });
  }
  function span(days, step) { return (Math.max(1, days) - 1) * Math.max(1, step || 1) + 1; }
  /** Site codes compared the way the server stores them (app/plants/codes.py :: normalize_site_code). */
  function codeKey(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
  function sameCode(a, b) { return !!a && !!b && codeKey(a) === codeKey(b); }

  function businessToday() {
    var parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date());
    var v = {};
    parts.forEach(function (p) { if (p.type !== "literal") v[p.type] = p.value; });
    return v.year + "-" + v.month + "-" + v.day;
  }
  function dayNumber(iso, cycleStartIso) {
    var a = iso.split("-").map(Number), b = cycleStartIso.split("-").map(Number);
    return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86400000) + 1;
  }

  // ─────────────────────────── loading ───────────────────────────
  function loadList() {
    state.loading = true;
    renderBanner();
    return api().request("/api/pm-plan/cycle-plans").then(function (body) {
      state.list = body;
      state.error = "";
    }).catch(function (error) {
      // Roles without PM planning access simply do not see this panel.
      state.list = null;
      state.error = error && error.status === 403 ? "" : (error && error.message) || "Cycle plans could not be loaded.";
    }).then(function () {
      state.loading = false;
      render();
    });
  }

  function loadPlan(siteCode) {
    if (previewTimer) { global.clearTimeout(previewTimer); previewTimer = null; }
    state.previewSeq += 1;                              // a preview still in flight is for the old plant
    state.previewBusy = false;
    state.selected = siteCode;
    state.plan = null; state.draft = null; state.preview = null;
    state.planError = ""; state.previewError = ""; state.notice = ""; state.noticeError = false;
    state.dirty = false; state.stale = false;
    state.planLoading = true;
    render();
    var cycleStart = businessToday();
    return api().request("/api/pm-plan/cycle-plans/" + encodeURIComponent(siteCode) +
      "?cycle_start=" + cycleStart).then(function (body) {
      if (state.selected !== siteCode) return;
      state.plan = body;
      state.baseVersion = body.updated_at || null;
      state.draft = {
        phases: (body.phases || []).map(clonePhase),
        notes: body.notes || ""
      };
      if (body.chained) state.preview = { resolved: body.resolved, chained: body.chained, cycle_start: cycleStart };
    }).catch(function (error) {
      if (state.selected !== siteCode) return;
      state.planError = (error && error.message) || "This plant's cycle plan could not be loaded.";
    }).then(function () {
      if (state.selected !== siteCode) return;
      state.planLoading = false;
      render();
    });
  }

  function clonePhase(p) {
    return {
      phase: p.phase || "", area: p.area || "Plant side",
      categories: (p.categories || []).slice(),
      start_day: p.start_day, days: p.days == null ? null : p.days,
      step_days: p.step_days || 1
    };
  }

  // ─────────────────────────── preview (server is the source of truth) ───────────────────────────
  function localProblem(phases) {
    if (!phases.length) return "Add at least one phase.";
    for (var i = 0; i < phases.length; i += 1) {
      var p = phases[i];
      var name = p.phase.trim() || "Phase " + (i + 1);
      if (!p.phase.trim()) return name + ": enter a phase name.";
      if (!p.categories.length) return name + ": choose at least one work category.";
      if (!(p.start_day >= 1)) return name + ": enter a start day.";
      if (!isUnitDerived(p.categories) && !(p.days >= 1)) return name + ": enter the working days.";
    }
    return "";
  }

  function payloadPhases() {
    return state.draft.phases.map(function (p) {
      return {
        phase: p.phase.trim(), area: p.area, categories: p.categories.slice(),
        start_day: Number(p.start_day),
        days: isUnitDerived(p.categories) ? null : Number(p.days),
        step_days: Number(p.step_days) || 1
      };
    });
  }

  function schedulePreview() {
    if (previewTimer) global.clearTimeout(previewTimer);
    previewTimer = global.setTimeout(runPreview, 350);
  }

  function runPreview() {
    previewTimer = null;
    if (!state.draft || !state.selected || !canEdit()) return;
    var problem = localProblem(state.draft.phases);
    if (problem) {
      state.previewError = problem;
      state.preview = null;
      renderCalendar(); renderActions();
      return;
    }
    var seq = state.previewSeq += 1;
    var cycleStart = businessToday();
    state.previewBusy = true;
    renderActions();
    api().request("/api/pm-plan/cycle-plans/" + encodeURIComponent(state.selected) + "/preview?cycle_start=" + cycleStart, {
      method: "POST", body: { phases: payloadPhases(), notes: state.draft.notes || null }
    }).then(function (body) {
      if (seq !== state.previewSeq) return;            // an older answer arriving late is dropped
      state.preview = { resolved: body.resolved, chained: body.chained, cycle_start: cycleStart };
      state.previewError = "";
    }).catch(function (error) {
      if (seq !== state.previewSeq) return;
      state.preview = null;
      state.previewError = (error && error.message) || "The plan could not be checked.";
    }).then(function () {
      if (seq !== state.previewSeq) return;
      state.previewBusy = false;
      renderCalendar(); renderActions(); renderTableHints();
    });
  }

  // ─────────────────────────── rendering ───────────────────────────
  function render() {
    if (!state.host) return;
    if (!state.list && !state.error && !state.loading) { state.host.innerHTML = ""; return; }
    state.host.innerHTML = '<section class="ep-cp" aria-labelledby="ep-cp-title">' +
      '<div data-cp-banner></div>' +
      (state.open && state.list ? editorFrame() : "") +
      '</section>';
    renderBanner();
    if (state.open && state.list) {
      renderList(); renderEditor();
    }
  }

  function renderBanner() {
    var el = state.host && state.host.querySelector("[data-cp-banner]");
    if (!el) return;
    if (state.loading && !state.list) {
      el.innerHTML = '<div class="ep-cp__banner"><p class="ep-cp__muted" role="status">Loading cycle plans…</p></div>';
      return;
    }
    if (state.error) {
      el.innerHTML = '<div class="ep-cp__banner is-error"><p role="alert">' + esc(state.error) + '</p>' +
        '<button type="button" class="ep-cp__button" data-cp-action="retry">Try again</button></div>';
      return;
    }
    var list = state.list;
    if (!list) { el.innerHTML = ""; return; }
    var here = state.siteCode && (list.plans || []).find(function (p) { return sameCode(p.site_code, state.siteCode); });
    var headline = here
      ? (here.paused
        ? '<strong class="ep-cp__pill is-paused">' + esc(list.paused_reason) + '</strong>'
        : '<strong class="ep-cp__pill is-on">Own cycle plan · ' + here.phases + ' phase' + (here.phases === 1 ? "" : "s") + '</strong>')
      : '<strong>' + list.configured + ' of ' + list.total + ' plants planned</strong>' +
        (list.paused ? ' <span class="ep-cp__pill is-paused">' + list.paused + ' PM paused</span>' : "");
    var hint = (here ? here.paused : list.paused)
      ? '<p class="ep-cp__muted">Paused plants generate no new PM cycles and are left out of PM compliance, not counted as 0%. ' +
        'Work orders already generated are not affected.</p>'
      : "";
    el.innerHTML = '<div class="ep-cp__banner' + ((here ? here.paused : list.paused) ? " is-paused" : "") + '">' +
      '<div><h2 id="ep-cp-title" class="ep-cp__title">PM cycle plans</h2><p>' + headline + '</p>' + hint + '</div>' +
      '<button type="button" class="ep-cp__button' + ((here ? here.paused : list.paused) && canEdit() ? " is-primary" : "") +
        '" data-cp-action="toggle" aria-expanded="' + state.open + '">' +
        (state.open ? "Close" : canEdit() ? (here && here.paused ? "Configure a cycle plan" : "Configure cycle plans") : "View cycle plans") +
      '</button></div>';
  }

  function editorFrame() {
    return '<div class="ep-cp__editor">' +
      '<aside class="ep-cp__plants" aria-label="Plants">' +
        '<input type="search" class="ep-cp__search" data-cp-search placeholder="Search plant code or name" value="' + esc(state.search) + '" aria-label="Search plants" />' +
        '<div class="ep-cp__filters" role="group" aria-label="Show">' +
          ["all", "paused", "configured"].map(function (f) {
            return '<button type="button" data-cp-filter="' + f + '" aria-pressed="' + (state.filter === f) + '">' +
              (f === "all" ? "All" : f === "paused" ? "Paused" : "Planned") + '</button>';
          }).join("") +
        '</div>' +
        '<ul class="ep-cp__plant-list" data-cp-plant-list></ul>' +
      '</aside>' +
      '<div class="ep-cp__detail" data-cp-detail></div>' +
    '</div>';
  }

  function renderList() {
    var el = state.host.querySelector("[data-cp-plant-list]");
    if (!el) return;
    var q = state.search.trim().toLowerCase();
    var rows = (state.list.plans || []).filter(function (p) {
      if (state.filter === "paused" && !p.paused) return false;
      if (state.filter === "configured" && p.paused) return false;
      return !q || (p.site_code + " " + p.plant).toLowerCase().indexOf(q) !== -1;
    });
    el.innerHTML = rows.length ? rows.map(function (p) {
      return '<li><button type="button" data-cp-plant="' + esc(p.site_code) + '"' +
        (sameCode(p.site_code, state.selected) ? ' aria-current="true"' : "") + '>' +
        '<span><strong>' + esc(p.site_code) + '</strong> ' + esc(p.plant) + '</span>' +
        '<span class="ep-cp__pill ' + (p.paused ? "is-paused" : "is-on") + '">' +
          (p.paused ? "Paused" : p.phases + " phase" + (p.phases === 1 ? "" : "s")) + '</span>' +
        '</button></li>';
    }).join("") : '<li class="ep-cp__muted">No plants match.</li>';
  }

  function renderEditor() {
    var el = state.host.querySelector("[data-cp-detail]");
    if (!el) return;
    if (!state.selected) {
      el.innerHTML = '<p class="ep-cp__empty">Choose a plant to see its 30-day cycle.</p>';
      return;
    }
    if (state.planLoading) { el.innerHTML = '<p class="ep-cp__muted" role="status">Loading the plan…</p>'; return; }
    if (state.planError) {
      el.innerHTML = '<p class="ep-cp__error" role="alert">' + esc(state.planError) + '</p>';
      return;
    }
    var plan = state.plan;
    var editable = canEdit();
    var empty = !state.draft.phases.length;
    el.innerHTML =
      '<header class="ep-cp__detail-head"><div><h3>' + esc(plan.plant.plant) + ' <small>' + esc(plan.plant.site_code) + '</small></h3>' +
        '<p class="ep-cp__muted">' + (plan.paused
          ? '<span class="ep-cp__pill is-paused">' + esc(plan.paused_reason) + '</span> No new PM cycles are generated for this plant until a plan is saved.'
          : "Changes take effect from the <strong>next cycle</strong>. Work already generated is never rewritten.") + '</p></div></header>' +
      '<div data-cp-status></div>' +
      (empty
        ? '<div class="ep-cp__start">' +
            '<p>' + (editable ? "This plant has no cycle plan. Start from the built-in cycle and change the days to match the plant's tracker, or add phases one by one."
                              : "This plant has no cycle plan yet. The O&M Head can configure one.") + '</p>' +
            (editable ? '<button type="button" class="ep-cp__button is-primary" data-cp-action="from-default">Start from the built-in cycle</button> ' +
                        '<button type="button" class="ep-cp__button" data-cp-action="add-phase">Add a phase</button>' : "") +
          '</div>'
        : '<div class="ep-cp__calendar" data-cp-calendar></div>' +
          '<div class="ep-cp__table" data-cp-table></div>' +
          '<label class="ep-cp__notes"><span>Notes (source tracker, exceptions)</span>' +
            '<textarea data-cp-notes maxlength="2000" rows="2"' + (editable ? "" : " disabled") + '>' + esc(state.draft.notes) + '</textarea></label>') +
      '<footer class="ep-cp__actions" data-cp-actions></footer>';
    renderStatus();
    if (!empty) { renderCalendar(); renderTable(); }
    renderActions();
  }

  function renderStatus() {
    var el = state.host && state.host.querySelector("[data-cp-status]");
    if (!el) return;
    el.innerHTML = state.notice
      ? '<p class="' + (state.noticeError ? "ep-cp__error" : "ep-cp__ok") + '" role="' + (state.noticeError ? "alert" : "status") + '">' +
          esc(state.notice) +
          (state.stale ? ' <button type="button" class="ep-cp__link" data-cp-action="reload">Reload the latest plan</button>' : "") + '</p>'
      : "";
  }

  /** Cycle-day cells a phase works on: start, start + step, ... */
  function workDays(start, days, step) {
    var out = [];
    for (var k = 0; k < days; k += 1) out.push(start + k * Math.max(1, step || 1));
    return out;
  }

  function renderCalendar() {
    var el = state.host && state.host.querySelector("[data-cp-calendar]");
    if (!el || !state.draft) return;
    var phases = state.draft.phases;
    var resolved = state.preview && state.preview.resolved || [];
    var chained = state.preview && state.preview.chained || [];
    var cycleStart = state.preview && state.preview.cycle_start;
    // The plan as typed. Inverter length comes from the server (pm_unit_config); until a preview
    // has arrived it is unknown and drawn as its start day only.
    var planned = phases.map(function (p, i) {
      var r = resolved[i];
      var days = isUnitDerived(p.categories) ? (r ? r.days : 1) : (Number(p.days) || 1);
      var step = Number(p.step_days) || 1;
      var start = Number(p.start_day) || 1;
      return { start: start, days: days, step: step, end: start + span(days, step) - 1, cells: workDays(start, days, step) };
    });
    var runs = chained.map(function (w, i) {
      var start = dayNumber(w.start, cycleStart);
      return { start: start, moved: w.moved_days || 0, cells: workDays(start, w.days, w.step_days), past: w.past_cycle_days || 0, i: i };
    });
    var last = CYCLE_DAYS;
    runs.forEach(function (r) { r.cells.forEach(function (d) { if (d > last) last = d; }); });
    // Collisions in the plan as typed: a working day inside another phase's span.
    var clash = planned.map(function (p, i) {
      return p.cells.filter(function (d) {
        return planned.some(function (q, j) { return j !== i && d >= q.start && d <= q.end; });
      });
    });

    var head = '<div class="ep-cp__cal-row ep-cp__cal-head"><span class="ep-cp__cal-label">Phase</span><span class="ep-cp__cal-kind"></span>';
    for (var d = 1; d <= last; d += 1) head += '<span class="ep-cp__cal-day' + (d > CYCLE_DAYS ? " is-over" : "") + '">' + d + '</span>';
    head += '</div>';

    var body = phases.map(function (p, i) {
      var name = esc(p.phase || "Phase " + (i + 1));
      var plan = planned[i], run = runs[i];
      var planCells = "", runCells = "";
      for (var day = 1; day <= last; day += 1) {
        var inPlan = plan.cells.indexOf(day) !== -1;
        var inSpan = day >= plan.start && day <= plan.end;
        var isClash = clash[i].indexOf(day) !== -1;
        planCells += '<span class="ep-cp__cell' + (inPlan ? " is-work" : inSpan ? " is-gap" : "") + (isClash ? " is-clash" : "") +
          (day > CYCLE_DAYS ? " is-over" : "") + '"' + (inPlan ? ' title="' + name + ' · plan day ' + day + '"' : "") + '></span>';
        var inRun = run && run.cells.indexOf(day) !== -1;
        runCells += '<span class="ep-cp__cell' + (inRun ? " is-run" + (run.moved ? " is-moved" : "") : "") +
          (day > CYCLE_DAYS ? " is-over" : "") + '"' + (inRun ? ' title="' + name + ' · runs day ' + day + '"' : "") + '></span>';
      }
      return '<div class="ep-cp__cal-phase">' +
        '<div class="ep-cp__cal-row"><span class="ep-cp__cal-label" title="' + esc(p.categories.join(", ")) + '">' + name +
          '<small>' + esc(p.categories.join(", ")) + '</small></span><span class="ep-cp__cal-kind">Plan</span>' + planCells + '</div>' +
        '<div class="ep-cp__cal-row"><span class="ep-cp__cal-label"></span><span class="ep-cp__cal-kind">Runs</span>' +
          (run ? runCells : '<span class="ep-cp__cal-pending">' + (state.previewError ? "Fix the plan to see how it runs" : "Checking…") + '</span>') + '</div>' +
      '</div>';
    }).join("");

    var moved = runs.filter(function (r) { return r.moved; });
    var past = runs.filter(function (r) { return r.past; });
    var clashing = clash.some(function (c) { return c.length; });
    var summary = [];
    if (state.previewError) summary.push('<p class="ep-cp__error" role="alert">' + esc(state.previewError) + '</p>');
    if (clashing) summary.push('<p class="ep-cp__warn">Phases overlap in the plan as typed (marked red). Chaining will push the later phase back.</p>');
    moved.forEach(function (r) {
      var p = phases[r.i];
      summary.push('<p class="ep-cp__warn"><strong>' + esc(p.phase) + '</strong> is planned for day ' + esc(p.start_day) +
        ' but will start on day ' + r.start + ' (' + r.moved + ' day' + (r.moved === 1 ? "" : "s") + ' later), after the phase before it ends.</p>');
    });
    past.forEach(function (r) {
      summary.push('<p class="ep-cp__error"><strong>' + esc(phases[r.i].phase) + '</strong> runs ' + r.past +
        ' day' + (r.past === 1 ? "" : "s") + ' past day ' + CYCLE_DAYS + ' of the cycle.</p>');
    });
    if (!summary.length && runs.length) summary.push('<p class="ep-cp__ok">Every phase runs on the day it is planned.</p>');

    el.innerHTML = '<div class="ep-cp__cal-scroll" role="figure" aria-label="30-day cycle: plan as typed and how it will run">' +
        head + body + '</div>' +
      '<div class="ep-cp__legend"><span><i class="is-work"></i>Planned working day</span><span><i class="is-gap"></i>Inside the phase, no work (days apart)</span>' +
        '<span><i class="is-run"></i>Will run</span><span><i class="is-moved"></i>Moved by chaining</span><span><i class="is-clash"></i>Overlap</span></div>' +
      '<div class="ep-cp__summary" aria-live="polite">' + summary.join("") + '</div>';
  }

  function renderTable() {
    var el = state.host && state.host.querySelector("[data-cp-table]");
    if (!el || !state.draft) return;
    var editable = canEdit();
    var off = editable ? "" : " disabled";
    var used = {};
    state.draft.phases.forEach(function (p) { p.categories.forEach(function (c) { used[c] = true; }); });
    var options = (state.list.categories || []).filter(function (c) { return !used[c]; });
    var n = state.draft.phases.length;
    el.innerHTML = '<div class="ep-cp__rows" role="list">' + state.draft.phases.map(function (p, i) {
      var derived = isUnitDerived(p.categories);
      return '<div class="ep-cp__phase" role="listitem" data-cp-index="' + i + '">' +
        '<div class="ep-cp__order">' +
          '<button type="button" data-cp-move="-1" aria-label="Move ' + esc(p.phase) + ' earlier"' + (i === 0 || !editable ? " disabled" : "") + '>↑</button>' +
          '<button type="button" data-cp-move="1" aria-label="Move ' + esc(p.phase) + ' later"' + (i === n - 1 || !editable ? " disabled" : "") + '>↓</button>' +
        '</div>' +
        '<label class="ep-cp__f-name"><span>Phase</span><input type="text" maxlength="120" data-cp-field="phase" value="' + esc(p.phase) + '"' + off + ' /></label>' +
        '<label class="ep-cp__f-area"><span>Area</span><select data-cp-field="area"' + off + '>' +
          ["Plant side", "GSS side"].map(function (a) { return '<option' + (p.area === a ? " selected" : "") + '>' + a + '</option>'; }).join("") +
        '</select></label>' +
        '<div class="ep-cp__f-cats"><span>Work categories (one visit)</span><div class="ep-cp__chips">' +
          p.categories.map(function (c, ci) {
            return '<span class="ep-cp__chip">' + esc(c) + (editable
              ? '<button type="button" data-cp-remove-cat="' + ci + '" aria-label="Remove ' + esc(c) + ' from ' + esc(p.phase) + '">×</button>' : "") + '</span>';
          }).join("") +
          (editable && options.length ? '<select data-cp-add-cat aria-label="Add a work category to ' + esc(p.phase) + '"><option value="">+ Add</option>' +
            options.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join("") + '</select>' : "") +
        '</div></div>' +
        '<label class="ep-cp__f-num"><span>Start day</span><input type="number" min="1" max="' + CYCLE_DAYS + '" inputmode="numeric" data-cp-field="start_day" value="' + esc(p.start_day) + '"' + off + ' /></label>' +
        '<label class="ep-cp__f-num"><span>Working days</span>' + (derived
          ? '<input type="text" disabled value="" data-cp-derived placeholder="From unit count" aria-describedby="ep-cp-derived-' + i + '" />' +
            '<small id="ep-cp-derived-' + i + '" data-cp-derived-note></small>'
          : '<input type="number" min="1" max="' + CYCLE_DAYS + '" inputmode="numeric" data-cp-field="days" value="' + esc(p.days == null ? "" : p.days) + '"' + off + ' />') +
        '</label>' +
        '<label class="ep-cp__f-num"><span>Days apart</span><input type="number" min="1" max="' + CYCLE_DAYS + '" inputmode="numeric" data-cp-field="step_days" value="' + esc(p.step_days) + '"' + off +
          ' title="1 = consecutive days, 2 = every other day" /></label>' +
        (editable ? '<button type="button" class="ep-cp__remove" data-cp-remove-phase aria-label="Remove phase ' + esc(p.phase) + '">Remove</button>' : "") +
      '</div>';
    }).join("") + '</div>' +
    (editable ? '<button type="button" class="ep-cp__button" data-cp-action="add-phase">+ Add phase</button>' : "");
    renderTableHints();
  }

  /** Inverter rows show the length the server worked out from the plant's unit count. */
  function renderTableHints() {
    if (!state.host) return;
    var resolved = state.preview && state.preview.resolved || [];
    Array.prototype.forEach.call(state.host.querySelectorAll("[data-cp-index]"), function (row) {
      var i = Number(row.getAttribute("data-cp-index"));
      var input = row.querySelector("[data-cp-derived]");
      var note = row.querySelector("[data-cp-derived-note]");
      if (!input) return;
      var r = resolved[i];
      input.value = r ? r.days + " (from unit count)" : "";
      if (note) note.textContent = r ? "" : "Worked out from total units ÷ units per day";
    });
  }

  function renderActions() {
    var el = state.host && state.host.querySelector("[data-cp-actions]");
    if (!el || !state.plan) return;
    if (!canEdit()) { el.innerHTML = '<p class="ep-cp__muted">Only the O&amp;M Head can change cycle plans.</p>'; return; }
    var hasPhases = state.draft && state.draft.phases.length;
    var blocked = state.saving || !state.dirty || !hasPhases || !!state.previewError || state.previewBusy;
    el.innerHTML =
      (state.plan.configured ? '<button type="button" class="ep-cp__button is-danger" data-cp-action="remove"' + (state.saving ? " disabled" : "") + '>Remove plan (pause PM)</button>' : "<span></span>") +
      '<div>' +
        (state.dirty ? '<button type="button" class="ep-cp__button" data-cp-action="discard"' + (state.saving ? " disabled" : "") + '>Discard changes</button>' : "") +
        '<button type="button" class="ep-cp__button is-primary" data-cp-action="save"' + (blocked ? " disabled" : "") + '>' +
          (state.saving ? "Saving…" : state.previewBusy && state.dirty ? "Checking…" : "Save plan") + '</button>' +
      '</div>';
  }

  // ─────────────────────────── editing ───────────────────────────
  function changed(structural) {
    state.dirty = true;
    state.notice = ""; state.noticeError = false; state.stale = false;
    // After a reorder, add or remove, the last preview's rows no longer line up with the phases.
    if (structural) state.preview = null;
    renderStatus();
    if (structural) { renderTable(); renderCalendar(); }
    renderActions();
    schedulePreview();
  }

  function confirmDiscard() {
    return !state.dirty || global.confirm("Discard your unsaved changes to " + (state.plan ? state.plan.plant.plant : "this plant") + "'s cycle plan?");
  }

  function nextStart() {
    var phases = state.draft.phases;
    if (!phases.length) return 1;
    var p = phases[phases.length - 1];
    var days = isUnitDerived(p.categories) ? 1 : Number(p.days) || 1;
    return Math.min(CYCLE_DAYS, (Number(p.start_day) || 1) + span(days, p.step_days));
  }

  function save() {
    if (state.saving || !state.dirty) return;
    var problem = localProblem(state.draft.phases);
    if (problem) { state.previewError = problem; renderCalendar(); renderActions(); return; }
    state.saving = true;
    renderActions();
    var code = state.selected;
    api().request("/api/pm-plan/cycle-plans/" + encodeURIComponent(code) + "?cycle_start=" + businessToday(), {
      method: "PUT",
      body: { phases: payloadPhases(), notes: (state.draft.notes || "").trim() || null, expected_updated_at: state.baseVersion }
    }).then(function (body) {
      if (state.selected !== code) return;
      state.plan = body;
      state.baseVersion = body.updated_at || null;
      state.draft = { phases: (body.phases || []).map(clonePhase), notes: body.notes || "" };
      state.preview = body.chained ? { resolved: body.resolved, chained: body.chained, cycle_start: businessToday() } : null;
      state.dirty = false;
      state.notice = "Saved. The new plan applies from the next cycle; work already generated is unchanged.";
      state.noticeError = false;
      return loadListQuiet();
    }).catch(function (error) {
      state.notice = (error && error.message) || "The plan could not be saved. Nothing was changed.";
      state.noticeError = true;
      state.stale = !!(error && error.status === 409);
    }).then(function () {
      state.saving = false;
      if (state.selected === code) { renderList(); renderEditor(); }
    });
  }

  function remove() {
    var plan = state.plan;
    if (!plan || !plan.configured) return;
    if (!global.confirm("Remove the cycle plan for " + plan.plant.plant + "?\n\nPM for this plant will be paused: no new cycles " +
        "will be generated. Work orders already generated are not affected.")) return;
    state.saving = true;
    renderActions();
    api().request("/api/pm-plan/cycle-plans/" + encodeURIComponent(state.selected), { method: "DELETE" }).then(function () {
      return loadListQuiet().then(function () { return loadPlan(plan.plant.site_code); });
    }).then(function () {
      state.notice = "Plan removed. PM is paused for this plant; existing work orders were left as they are.";
      state.noticeError = false;
      renderStatus();
    }).catch(function (error) {
      state.notice = (error && error.message) || "The plan could not be removed.";
      state.noticeError = true;
      renderStatus();
    }).then(function () { state.saving = false; renderActions(); });
  }

  function loadListQuiet() {
    return api().request("/api/pm-plan/cycle-plans").then(function (body) {
      state.list = body;
      renderBanner();
      renderList();
    }).catch(function () { /* the counts refresh on the next visit */ });
  }

  // ─────────────────────────── events (delegated once per host) ───────────────────────────
  function wire(host) {
    if (wiredHosts.has(host)) return;
    wiredHosts.add(host);

    host.addEventListener("click", function (event) {
      var target = event.target.closest("button");
      if (!target || !host.contains(target)) return;
      var action = target.getAttribute("data-cp-action");
      var row = target.closest("[data-cp-index]");
      var i = row ? Number(row.getAttribute("data-cp-index")) : -1;

      if (action === "retry") { loadList(); return; }
      if (action === "toggle") {
        if (state.open && !confirmDiscard()) return;
        state.open = !state.open;
        if (!state.open) { state.dirty = false; render(); return; }
        render();
        if (!state.selected && state.siteCode) loadPlan(state.siteCode);
        return;
      }
      if (target.hasAttribute("data-cp-filter")) {
        state.filter = target.getAttribute("data-cp-filter");
        Array.prototype.forEach.call(host.querySelectorAll("[data-cp-filter]"), function (b) {
          b.setAttribute("aria-pressed", String(b === target));
        });
        renderList();
        return;
      }
      if (target.hasAttribute("data-cp-plant")) {
        var code = target.getAttribute("data-cp-plant");
        if (sameCode(code, state.selected) || !confirmDiscard()) return;
        loadPlan(code);
        return;
      }
      if (action === "reload") { loadPlan(state.selected); return; }
      if (!canEdit() || !state.draft) return;

      if (action === "from-default") {
        state.draft.phases = (state.list.default_phases || []).map(clonePhase);
        state.notice = "Built-in cycle loaded. Change each phase's days to match this plant's tracker, then save.";
        state.noticeError = false;
        renderEditor(); changed(true);
        return;
      }
      if (action === "add-phase") {
        var wasEmpty = !state.draft.phases.length;
        state.draft.phases.push({ phase: "", area: "Plant side", categories: [], start_day: nextStart(), days: 1, step_days: 1 });
        if (wasEmpty) renderEditor();
        changed(true);
        var inputs = host.querySelectorAll('[data-cp-field="phase"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
        return;
      }
      if (action === "save") { save(); return; }
      if (action === "discard") {
        state.draft = { phases: (state.plan.phases || []).map(clonePhase), notes: state.plan.notes || "" };
        state.dirty = false; state.previewError = "";
        state.preview = state.plan.chained ? { resolved: state.plan.resolved, chained: state.plan.chained, cycle_start: businessToday() } : null;
        renderEditor();
        return;
      }
      if (action === "remove") { remove(); return; }
      if (i < 0) return;
      if (target.hasAttribute("data-cp-move")) {
        var to = i + Number(target.getAttribute("data-cp-move"));
        if (to < 0 || to >= state.draft.phases.length) return;
        var moved = state.draft.phases.splice(i, 1)[0];
        state.draft.phases.splice(to, 0, moved);
        changed(true);
        return;
      }
      if (target.hasAttribute("data-cp-remove-cat")) {
        state.draft.phases[i].categories.splice(Number(target.getAttribute("data-cp-remove-cat")), 1);
        changed(true);
        return;
      }
      if (target.hasAttribute("data-cp-remove-phase")) {
        state.draft.phases.splice(i, 1);
        if (!state.draft.phases.length) { state.dirty = true; renderEditor(); return; }
        changed(true);
      }
    });

    host.addEventListener("input", function (event) {
      var t = event.target;
      if (t.hasAttribute("data-cp-search")) { state.search = t.value; renderList(); return; }
      if (!canEdit() || !state.draft) return;
      if (t.hasAttribute("data-cp-notes")) { state.draft.notes = t.value; changed(false); return; }
      var field = t.getAttribute("data-cp-field");
      var row = t.closest("[data-cp-index]");
      if (!field || !row || field === "area") return;
      var p = state.draft.phases[Number(row.getAttribute("data-cp-index"))];
      if (!p) return;
      p[field] = field === "phase" ? t.value : (t.value === "" ? null : parseInt(t.value, 10));
      changed(false);
      if (field !== "phase") renderCalendar();       // the typed plan redraws at once; "runs" follows the preview
    });

    host.addEventListener("change", function (event) {
      var t = event.target;
      if (!canEdit() || !state.draft) return;
      var row = t.closest("[data-cp-index]");
      if (!row) return;
      var p = state.draft.phases[Number(row.getAttribute("data-cp-index"))];
      if (!p) return;
      if (t.hasAttribute("data-cp-add-cat") && t.value) {
        p.categories.push(t.value);
        if (!p.phase.trim()) p.phase = t.value;
        changed(true);
        return;
      }
      if (t.getAttribute("data-cp-field") === "area") { p.area = t.value; changed(false); }
    });
  }

  /** Mount on the PM page. `siteCode` is set on a plant's own PM page. */
  function show(host, options) {
    if (!host) return;
    if (!canView()) { host.innerHTML = ""; return; }
    var siteCode = options && options.siteCode || null;
    if (state.host !== host) {
      state = freshState();
      state.host = host;
    }
    if (codeKey(siteCode) !== codeKey(state.siteCode) && !state.dirty) {
      state.siteCode = siteCode;
      state.selected = null; state.plan = null; state.draft = null; state.preview = null;
    }
    wire(host);
    loadList();
  }

  global.Solar91PortalPMCyclePlans = { show: show };
}(window));
