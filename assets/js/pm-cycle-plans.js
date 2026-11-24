/**
 * A plant's PM cycle plan, as a MONTH TRACKER (migration 049).
 *
 * This is a section of the plant's PM page, mounted by pm-overview.js. It is never a panel on the
 * all-plants page: navigation picks a screen, it does not stack two modules into one.
 *
 * The grid IS the editor. The people who change these days think in a month grid, because their
 * paper tracker is one; a form of start-day numbers would not be used. A phase sits as a chip on
 * its day and is moved by picking it and choosing a new day, by dragging it, or with the arrow keys
 * — a plan that can only be edited with a mouse is not usable on site.
 *
 * Two things are drawn together, because they differ whenever work overruns: the PLANNED day, and
 * what the engine will ACTUALLY produce once chaining is applied. The "runs" row always comes from
 * the server's preview, never from a copy of the chaining rule in this file, so the two cannot
 * drift apart.
 *
 * A plant with no plan is PAUSED: no new PM cycles are generated for it. That is a state with an
 * action, not a failure, and it is never counted as a 0% plant.
 *
 * Who may edit comes from the server (`can_edit`): the O&M Head, or the plant's own Assignee. The
 * same rule is enforced on the write endpoints — a read-only view is not what stops a write.
 */
(function (global) {
  "use strict";

  var AUTHOR_DAYS = 30;                     // a plan is authored against 30 days, whatever month it runs in
  var UNIT_DERIVED = ["inverter"];          // length follows pm_unit_config, not the plan
  var state = freshState();
  var wiredHosts = new WeakSet();
  var previewTimer = null;

  function freshState() {
    return {
      host: null, siteCode: null, month: null, entries: [],
      list: null, listError: "",
      plan: null, planLoading: false, planError: "",
      draft: null, baseVersion: null, dirty: false,
      preview: null, previewError: "", previewSeq: 0, previewBusy: false,
      saving: false, notice: "", noticeError: false, stale: false,
      editing: false, selected: null, showPhases: false
    };
  }

  function api() { return global.Solar91PortalAPI; }
  function esc(value) { return global.Solar91PortalFormat.escape(value == null ? "" : String(value)); }
  function invalidateCalendar() {
    var data = global.Solar91PortalData;
    if (data && typeof data.invalidate === "function") data.invalidate();
  }
  /** The server decides; before the plan has loaded nothing is editable. */
  function canEdit() { return !!(state.plan && state.plan.can_edit && state.editing); }
  function mayEdit() { return !!(state.plan && state.plan.can_edit); }
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

  // ─────────────────────────── the month the cycle runs in ───────────────────────────
  // A cycle is a calendar month: the 1st to the month's real last day (app/pmplan/cycle.py).
  function monthMeta(month) {
    var m = /^(\d{4})-(\d{2})$/.exec(month || "") ;
    var year = m ? Number(m[1]) : Number(businessToday().slice(0, 4));
    var mon = m ? Number(m[2]) : Number(businessToday().slice(5, 7));
    var length = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    return {
      key: (m ? month : businessToday().slice(0, 7)),
      year: year, month: mon, length: length,
      start: (m ? month : businessToday().slice(0, 7)) + "-01",
      firstWeekday: new Date(Date.UTC(year, mon - 1, 1)).getUTCDay(),   // 0 = Sunday, as the portal's calendars start
      label: new Date(Date.UTC(year, mon - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    };
  }

  function dayNumber(iso, cycleStartIso) {
    if (!iso || !cycleStartIso) return 0;
    var a = iso.split("-").map(Number), b = cycleStartIso.split("-").map(Number);
    return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86400000) + 1;
  }

  function prettyDate(iso) {
    if (!iso) return "";
    var d = iso.split("-").map(Number);
    return new Date(Date.UTC(d[0], d[1] - 1, d[2]))
      .toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }

  /** Cycle-day cells a phase works on: start, start + step, ... */
  function workDays(start, days, step) {
    var out = [];
    for (var k = 0; k < days; k += 1) out.push(start + k * Math.max(1, step || 1));
    return out;
  }

  function clonePhase(p) {
    return {
      phase: p.phase || "", area: p.area || "Plant side",
      categories: (p.categories || []).slice(),
      start_day: p.start_day == null ? 1 : Number(p.start_day),
      days: p.days == null ? null : Number(p.days),
      step_days: p.step_days == null ? 1 : Number(p.step_days)
    };
  }

  // ─────────────────────────── loading ───────────────────────────
  function loadList() {
    if (state.list) return Promise.resolve();
    return api().request("/api/pm-plan/cycle-plans").then(function (body) {
      state.list = body;
      state.listError = "";
    }).catch(function (error) {
      state.list = null;
      state.listError = error && error.status === 403 ? "" : (error && error.message) || "";
    });
  }

  function loadPlan() {
    if (previewTimer) { global.clearTimeout(previewTimer); previewTimer = null; }
    state.previewSeq += 1;                              // a preview still in flight is for the old plant
    state.previewBusy = false;
    state.planLoading = true;
    state.plan = null; state.draft = null; state.preview = null;
    state.planError = ""; state.notice = ""; state.noticeError = false; state.selected = null;
    renderAll();
    var code = state.siteCode;
    var meta = monthMeta(state.month);
    return api().request("/api/pm-plan/cycle-plans/" + encodeURIComponent(code) +
        "?cycle_start=" + meta.start).then(function (body) {
      if (!sameCode(code, state.siteCode)) return;
      state.plan = body;
      invalidateCalendar();
      state.baseVersion = body.updated_at || null;
      state.draft = { phases: (body.phases || []).map(clonePhase), notes: body.notes || "" };
      state.dirty = false;
      if (body.chained) state.preview = { resolved: body.resolved, chained: body.chained, cycle_start: meta.start };
      state.planError = "";
    }).catch(function (error) {
      if (!sameCode(code, state.siteCode)) return;
      state.plan = null;
      // A role without PM planning access simply does not see this section.
      state.planError = error && error.status === 403 ? "" : (error && error.message) || "The cycle plan could not be loaded.";
    }).then(function () {
      if (!sameCode(code, state.siteCode)) return;
      state.planLoading = false;
      renderAll();
    });
  }

  // ─────────────────────────── validation + preview (server is the source of truth) ───────────────────────────
  function localProblem(phases) {
    if (!phases.length) return "Add at least one phase.";
    var seen = {};
    var previous = 0;
    for (var i = 0; i < phases.length; i += 1) {
      var p = phases[i];
      var name = (p.phase || "").trim() || "Phase " + (i + 1);
      if (!(p.phase || "").trim()) return name + ": enter a phase name.";
      if (!p.categories.length) return name + ": choose at least one work category.";
      for (var c = 0; c < p.categories.length; c += 1) {
        var key = String(p.categories[c]).toLowerCase();
        if (seen[key]) return name + ": " + p.categories[c] + " is already planned in " + seen[key] + ".";
        seen[key] = name;
      }
      var start = Number(p.start_day);
      if (!(start >= 1) || start > AUTHOR_DAYS) return name + ": the start day must be between 1 and " + AUTHOR_DAYS + ".";
      if (start <= previous) {
        return name + ": day " + start + " must come after the previous phase's day " + previous + ".";
      }
      previous = start;
      if (!isUnitDerived(p.categories)) {
        var days = Number(p.days);
        if (!(days >= 1)) return name + ": enter the working days.";
        if (start + span(days, p.step_days) - 1 > AUTHOR_DAYS) {
          return name + ": " + days + " day(s) from day " + start + " run past day " + AUTHOR_DAYS + ".";
        }
      }
    }
    return "";
  }

  function payloadPhases() {
    return state.draft.phases.map(function (p) {
      return {
        phase: (p.phase || "").trim(), area: p.area, categories: p.categories.slice(),
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
    if (!state.draft || !state.siteCode || !mayEdit()) return;
    var problem = localProblem(state.draft.phases);
    if (problem) {
      state.previewError = problem;
      state.preview = null;
      renderGrid(); renderActions();
      return;
    }
    var seq = state.previewSeq += 1;
    var meta = monthMeta(state.month);
    state.previewBusy = true;
    renderActions();
    api().request("/api/pm-plan/cycle-plans/" + encodeURIComponent(state.siteCode) +
        "/preview?cycle_start=" + meta.start, {
      method: "POST", body: { phases: payloadPhases(), notes: state.draft.notes || null }
    }).then(function (body) {
      if (seq !== state.previewSeq) return;            // an older answer arriving late is dropped
      state.preview = { resolved: body.resolved, chained: body.chained, cycle_start: meta.start };
      state.previewError = "";
    }).catch(function (error) {
      if (seq !== state.previewSeq) return;
      state.preview = null;
      state.previewError = (error && error.message) || "The plan could not be checked.";
    }).then(function () {
      if (seq !== state.previewSeq) return;
      state.previewBusy = false;
      renderGrid(); renderActions(); renderPhases();
    });
  }

  // ─────────────────────────── rendering ───────────────────────────
  function renderAll() {
    var host = state.host;
    if (!host) return;
    if (state.planLoading) {
      host.innerHTML = '<section class="ep-pm__tracker"><p class="ep-pm__tracker-muted" role="status">Loading the cycle plan…</p></section>';
      return;
    }
    if (!state.plan) {
      // 403 for this role, or an error worth showing.
      host.innerHTML = state.planError
        ? '<section class="ep-pm__tracker"><p class="ep-pm__tracker-error" role="alert">' + esc(state.planError) +
          ' <button type="button" class="ep-pm__tracker-link" data-cp-action="retry">Try again</button></p></section>'
        : "";
      return;
    }
    var meta = monthMeta(state.month);
    var plan = state.plan;
    var paused = !state.draft.phases.length;
    host.innerHTML = '<section class="ep-pm__tracker" aria-labelledby="ep-pm-tracker-title">' +
      '<header class="ep-pm__tracker-head">' +
        '<div><h2 id="ep-pm-tracker-title">Cycle plan <span>' + esc(meta.label) + '</span></h2>' +
          '<p class="ep-pm__tracker-sub">' +
            (paused
              ? '<span class="ep-pm__tracker-pill is-paused">' + esc(plan.paused_reason || "PM paused - no cycle plan") + '</span>'
              : '<span class="ep-pm__tracker-pill is-on">' + state.draft.phases.length + ' phase' +
                (state.draft.phases.length === 1 ? "" : "s") + '</span>') +
            attribution() +
          '</p></div>' +
        '<div class="ep-pm__tracker-actions" data-cp-head-actions></div>' +
      '</header>' +
      '<div data-cp-status></div>' +
      (paused ? pausedBlock() : '<div data-cp-grid></div><div data-cp-phases></div>') +
      '<footer class="ep-pm__tracker-foot" data-cp-actions></footer>' +
    '</section>';
    renderHeadActions();
    renderStatus();
    if (!paused) { renderGrid(); renderPhases(); }
    renderActions();
  }

  function attribution() {
    var plan = state.plan;
    if (!plan || !plan.updated_at) return "";
    return '<span class="ep-pm__tracker-by">Last changed' +
      (plan.updated_by ? ' by ' + esc(plan.updated_by) : "") +
      ' on ' + esc(prettyDate(String(plan.updated_at).slice(0, 10))) + '</span>';
  }

  function pausedBlock() {
    return '<div class="ep-pm__tracker-paused">' +
      '<p>' + esc(state.plan.paused_hint ||
        "No new PM cycles are generated for this plant until a cycle plan is saved. Work orders already generated are not affected, and a paused plant is left out of PM compliance rather than counted as 0%.") + '</p>' +
      (mayEdit()
        ? '<div class="ep-pm__tracker-paused-actions">' +
            '<button type="button" class="ep-pm__tracker-button is-primary" data-cp-action="from-default">Start from the built-in cycle</button>' +
            '<button type="button" class="ep-pm__tracker-button" data-cp-action="add-phase">Add a phase</button>' +
          '</div>'
        : '<p class="ep-pm__tracker-muted">The O&amp;M Head or this plant&rsquo;s Assignee can create one.</p>') +
    '</div>';
  }

  function renderHeadActions() {
    var el = state.host && state.host.querySelector("[data-cp-head-actions]");
    if (!el) return;
    if (!mayEdit() || !state.draft.phases.length) {
      el.innerHTML = mayEdit() ? "" : '<span class="ep-pm__tracker-muted">Read only</span>';
      return;
    }
    el.innerHTML = '<button type="button" class="ep-pm__tracker-button' + (state.editing ? "" : " is-primary") +
      '" data-cp-action="toggle-edit" aria-pressed="' + state.editing + '">' +
      (state.editing ? "Stop editing" : "Edit days") + '</button>';
  }

  function renderStatus() {
    var el = state.host && state.host.querySelector("[data-cp-status]");
    if (!el) return;
    el.innerHTML = state.notice
      ? '<p class="' + (state.noticeError ? "ep-pm__tracker-error" : "ep-pm__tracker-ok") + '" role="' +
          (state.noticeError ? "alert" : "status") + '">' + esc(state.notice) +
          (state.stale ? ' <button type="button" class="ep-pm__tracker-link" data-cp-action="reload">Reload the latest plan</button>' : "") + '</p>'
      : "";
  }

  /** Work already in the register for this month, so the grid also reads as a tracker. */
  function dayWork(meta) {
    var by = {};
    (state.entries || []).forEach(function (entry) {
      if (!entry || !entry.date || entry.date.slice(0, 7) !== meta.key) return;
      var day = Number(entry.date.slice(8, 10));
      var cell = by[day] = by[day] || { done: 0, overdue: 0, open: 0 };
      if (entry.status === "Completed") cell.done += 1;
      else if (entry.status === "Overdue") cell.overdue += 1;
      else if (entry.status !== "Cancelled") cell.open += 1;
    });
    return by;
  }

  function renderGrid() {
    var el = state.host && state.host.querySelector("[data-cp-grid]");
    if (!el || !state.draft) return;
    var meta = monthMeta(state.month);
    var phases = state.draft.phases;
    var resolved = (state.preview && state.preview.resolved) || [];
    var chained = (state.preview && state.preview.chained) || [];
    var today = businessToday();

    // The plan as typed. The inverter phase's length comes from the server (pm_unit_config), so
    // until a preview has arrived its derived days are unknown and only its start day is drawn.
    var planned = phases.map(function (p, i) {
      var r = resolved[i];
      var days = isUnitDerived(p.categories) ? (r ? r.days : 1) : (Number(p.days) || 1);
      var step = Number(p.step_days) || 1;
      var start = Number(p.start_day) || 1;
      return { i: i, start: start, days: days, step: step, end: start + span(days, step) - 1,
               cells: workDays(start, days, step), derived: isUnitDerived(p.categories) };
    });
    var runs = chained.map(function (w, i) {
      var start = dayNumber(w.start, meta.start);
      return { i: i, start: start, moved: w.moved_days || 0, past: w.past_cycle_days || 0,
               clampedFrom: w.clamped_from || null, cells: workDays(start, w.days, w.step_days) };
    });

    // A working day inside another phase's span: shown the moment it happens, naming the phase.
    var clash = planned.map(function (p) {
      return p.cells.filter(function (d) {
        return planned.some(function (q) { return q.i !== p.i && d >= q.start && d <= q.end; });
      });
    });

    var work = dayWork(meta);
    var byDay = {};
    planned.forEach(function (p) {
      p.cells.forEach(function (d) { (byDay[d] = byDay[d] || []).push({ kind: "plan", p: p }); });
    });
    runs.forEach(function (r) {
      r.cells.forEach(function (d) {
        if (planned[r.i] && planned[r.i].cells.indexOf(d) !== -1) return;   // runs where it is planned
        (byDay[d] = byDay[d] || []).push({ kind: "run", p: r });
      });
    });

    var cells = "";
    for (var blank = 0; blank < meta.firstWeekday; blank += 1) {
      cells += '<div class="ep-pm__tracker-cell is-blank" aria-hidden="true"></div>';
    }
    for (var day = 1; day <= meta.length; day += 1) {
      var iso = meta.key + "-" + (day < 10 ? "0" + day : String(day));
      var items = byDay[day] || [];
      var w = work[day];
      var isToday = iso === today;
      var chips = items.map(function (item) {
        var p = phases[item.p.i];
        var name = (p && p.phase) || "Phase " + (item.p.i + 1);
        var clashing = item.kind === "plan" && clash[item.p.i].indexOf(day) !== -1;
        var moved = item.kind === "run";
        return '<button type="button" class="ep-pm__tracker-chip' +
          (moved ? " is-run" : "") + (clashing ? " is-clash" : "") +
          (item.p.derived ? " is-derived" : "") +
          (state.selected === item.p.i ? " is-selected" : "") + '"' +
          ' data-cp-chip="' + item.p.i + '"' +
          (canEdit() && item.kind === "plan" ? ' draggable="true"' : "") +
          ' title="' + esc(name + (p ? " · " + p.categories.join(", ") : "") +
            (moved ? " · pushed here by chaining" : " · planned") +
            (item.p.derived ? " · length from the plant's unit count" : "")) + '">' +
          '<span>' + esc(name) + '</span>' +
          (moved ? '<small>runs</small>' : item.p.derived ? '<small>units</small>' : "") +
        '</button>';
      }).join("");
      cells += '<div class="ep-pm__tracker-cell' + (isToday ? " is-today" : "") +
        (canEdit() && state.selected !== null ? " is-drop" : "") + '">' +
        '<button type="button" class="ep-pm__tracker-day" data-cp-day="' + day + '"' +
          (canEdit() && state.selected !== null
            ? ' aria-label="Move the selected phase to day ' + day + '"'
            : ' aria-label="Day ' + day + '" aria-disabled="' + (!canEdit()) + '"') + '>' +
          '<span class="ep-pm__tracker-daynum">' + day + '</span>' +
          (w ? '<span class="ep-pm__tracker-dots">' +
            (w.done ? '<i class="is-done" title="' + w.done + ' completed"></i>' : "") +
            (w.overdue ? '<i class="is-overdue" title="' + w.overdue + ' overdue"></i>' : "") +
            (w.open ? '<i class="is-open" title="' + w.open + ' scheduled"></i>' : "") + '</span>' : "") +
        '</button>' +
        '<div class="ep-pm__tracker-chips">' + chips + '</div>' +
      '</div>';
    }

    var weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(function (d) {
      return '<div class="ep-pm__tracker-weekday">' + d + '</div>';
    }).join("");

    el.innerHTML =
      '<div class="ep-pm__tracker-grid" role="group" aria-label="Cycle plan for ' + esc(meta.label) + '">' +
        weekdays + cells +
      '</div>' +
      moveBar(phases) +
      '<div class="ep-pm__tracker-legend">' +
        '<span><i class="is-plan"></i>Planned day</span>' +
        '<span><i class="is-run"></i>Where chaining will actually run it</span>' +
        '<span><i class="is-clash"></i>Overlap</span>' +
        '<span><i class="is-derived"></i>Length from unit count</span>' +
        '<span><i class="is-done"></i>Done</span><span><i class="is-open"></i>Due</span><span><i class="is-overdue"></i>Overdue</span>' +
      '</div>' +
      '<div class="ep-pm__tracker-messages" aria-live="polite">' + messages(phases, planned, runs, clash, meta) + '</div>';
  }

  /** Touch and keyboard path for moving the selected phase: no plan may need a mouse. */
  function moveBar(phases) {
    if (!canEdit() || state.selected === null) {
      return canEdit()
        ? '<p class="ep-pm__tracker-hint">Pick a phase chip, then choose its new day — or drag it. ' +
          'Arrow keys move a selected phase a day at a time.</p>'
        : "";
    }
    var p = phases[state.selected];
    if (!p) return "";
    return '<div class="ep-pm__tracker-move" role="group" aria-label="Move ' + esc(p.phase) + '">' +
      '<strong>' + esc(p.phase || "Phase " + (state.selected + 1)) + '</strong>' +
      '<span>day ' + esc(p.start_day) + '</span>' +
      '<button type="button" class="ep-pm__tracker-button" data-cp-nudge="-1" aria-label="A day earlier">− day</button>' +
      '<button type="button" class="ep-pm__tracker-button" data-cp-nudge="1" aria-label="A day later">+ day</button>' +
      '<label>Day<select data-cp-set-day aria-label="Set the day for ' + esc(p.phase) + '">' +
        Array.apply(null, { length: AUTHOR_DAYS }).map(function (_, k) {
          return '<option value="' + (k + 1) + '"' + (Number(p.start_day) === k + 1 ? " selected" : "") + '>' + (k + 1) + '</option>';
        }).join("") +
      '</select></label>' +
      '<button type="button" class="ep-pm__tracker-link" data-cp-action="deselect">Done</button>' +
    '</div>';
  }

  function messages(phases, planned, runs, clash, meta) {
    var out = [];
    if (state.previewError) out.push('<p class="ep-pm__tracker-error" role="alert">' + esc(state.previewError) + '</p>');
    clash.forEach(function (days, i) {
      if (!days.length) return;
      out.push('<p class="ep-pm__tracker-warn"><strong>' + esc(phases[i].phase) + '</strong> overlaps another phase on day ' +
        days[0] + '. Chaining will push the later phase back.</p>');
    });
    runs.forEach(function (r) {
      var p = phases[r.i];
      if (!p) return;
      if (r.clampedFrom) {
        out.push('<p class="ep-pm__tracker-warn"><strong>' + esc(p.phase) + '</strong> is planned for day ' +
          r.clampedFrom + ', which ' + esc(meta.label) + ' does not have, so it runs on day ' + r.start + '.</p>');
      } else if (r.moved) {
        out.push('<p class="ep-pm__tracker-warn"><strong>' + esc(p.phase) + '</strong> is planned for day ' +
          esc(p.start_day) + ' but will start on day ' + r.start + ' (' + r.moved + ' day' +
          (r.moved === 1 ? "" : "s") + ' later), after the phase before it ends.</p>');
      }
      if (r.past) {
        out.push('<p class="ep-pm__tracker-error"><strong>' + esc(p.phase) + '</strong> runs ' + r.past +
          ' day' + (r.past === 1 ? "" : "s") + ' past the end of ' + esc(meta.label) + '.</p>');
      }
    });
    if (!out.length && runs.length) {
      out.push('<p class="ep-pm__tracker-ok">Every phase runs on the day it is planned.</p>');
    }
    out.push('<p class="ep-pm__tracker-muted">A change takes effect from the <strong>next cycle</strong>. ' +
      'Work already generated is never rewritten.</p>');
    return out.join("");
  }

  /** Categories, length and spacing: the parts of a phase a day grid cannot express. */
  function renderPhases() {
    var el = state.host && state.host.querySelector("[data-cp-phases]");
    if (!el || !state.draft) return;
    var editable = canEdit();
    var off = editable ? "" : " disabled";
    var used = {};
    state.draft.phases.forEach(function (p) { p.categories.forEach(function (c) { used[c] = true; }); });
    var options = ((state.list && state.list.categories) || []).filter(function (c) { return !used[c]; });
    var resolved = (state.preview && state.preview.resolved) || [];

    el.innerHTML = '<details class="ep-pm__tracker-details"' + (state.showPhases ? " open" : "") + ' data-cp-details>' +
      '<summary>Phase detail — work categories, length and spacing</summary>' +
      '<div class="ep-pm__tracker-rows">' + state.draft.phases.map(function (p, i) {
        var derived = isUnitDerived(p.categories);
        var r = resolved[i];
        return '<div class="ep-pm__tracker-row" data-cp-index="' + i + '">' +
          '<label class="ep-pm__tracker-f-name"><span>Phase</span>' +
            '<input type="text" maxlength="120" data-cp-field="phase" value="' + esc(p.phase) + '"' + off + ' /></label>' +
          '<label class="ep-pm__tracker-f-area"><span>Area</span><select data-cp-field="area"' + off + '>' +
            ["Plant side", "GSS side"].map(function (a) {
              return '<option' + (p.area === a ? " selected" : "") + '>' + a + '</option>';
            }).join("") + '</select></label>' +
          '<div class="ep-pm__tracker-f-cats"><span>Work categories (one visit)</span>' +
            '<div class="ep-pm__tracker-cats">' +
              p.categories.map(function (c, ci) {
                return '<span class="ep-pm__tracker-cat">' + esc(c) + (editable
                  ? '<button type="button" data-cp-remove-cat="' + ci + '" aria-label="Remove ' + esc(c) + '">×</button>' : "") + '</span>';
              }).join("") +
              (editable && options.length
                ? '<select data-cp-add-cat aria-label="Add a work category"><option value="">+ Add</option>' +
                  options.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join("") + '</select>'
                : "") +
            '</div></div>' +
          '<label class="ep-pm__tracker-f-num"><span>Start day</span>' +
            '<input type="number" min="1" max="' + AUTHOR_DAYS + '" inputmode="numeric" data-cp-field="start_day" value="' +
              esc(p.start_day) + '"' + off + ' /></label>' +
          '<label class="ep-pm__tracker-f-num"><span>Working days</span>' + (derived
            ? '<input type="text" disabled value="' + (r ? esc(r.days) + " (unit count)" : "") +
              '" placeholder="From unit count" />'
            : '<input type="number" min="1" max="' + AUTHOR_DAYS + '" inputmode="numeric" data-cp-field="days" value="' +
              esc(p.days == null ? "" : p.days) + '"' + off + ' />') + '</label>' +
          '<label class="ep-pm__tracker-f-num"><span>Days apart</span>' +
            '<input type="number" min="1" max="' + AUTHOR_DAYS + '" inputmode="numeric" data-cp-field="step_days" value="' +
              esc(p.step_days) + '"' + off + ' title="1 = consecutive days, 2 = every other day" /></label>' +
          (editable ? '<button type="button" class="ep-pm__tracker-remove" data-cp-remove-phase>Remove</button>' : "") +
        '</div>';
      }).join("") + '</div>' +
      (editable ? '<button type="button" class="ep-pm__tracker-button" data-cp-action="add-phase">+ Add phase</button>' : "") +
      '<label class="ep-pm__tracker-notes"><span>Notes (source tracker, exceptions)</span>' +
        '<textarea data-cp-notes maxlength="2000" rows="2"' + off + '>' + esc(state.draft.notes) + '</textarea></label>' +
    '</details>';
  }

  function renderActions() {
    var el = state.host && state.host.querySelector("[data-cp-actions]");
    if (!el || !state.plan) return;
    if (!mayEdit()) {
      el.innerHTML = '<p class="ep-pm__tracker-muted">Only the O&amp;M Head or this plant&rsquo;s Assignee can change the days.</p>';
      return;
    }
    if (!state.editing) {
      el.innerHTML = state.draft.phases.length
        ? '<p class="ep-pm__tracker-muted">Choose <strong>Edit days</strong> to move a phase.</p>' : "";
      return;
    }
    var hasPhases = state.draft.phases.length;
    var blocked = state.saving || !state.dirty || !hasPhases || !!state.previewError || state.previewBusy;
    el.innerHTML =
      (state.plan.configured
        ? '<button type="button" class="ep-pm__tracker-button is-danger" data-cp-action="remove"' +
          (state.saving ? " disabled" : "") + '>Remove plan (pause PM)</button>'
        : "<span></span>") +
      '<div class="ep-pm__tracker-foot-right">' +
        (state.dirty ? '<button type="button" class="ep-pm__tracker-button" data-cp-action="discard"' +
          (state.saving ? " disabled" : "") + '>Discard changes</button>' : "") +
        '<button type="button" class="ep-pm__tracker-button is-primary" data-cp-action="save"' +
          (blocked ? " disabled" : "") + '>' +
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
    renderGrid();
    if (structural) renderPhases();
    renderActions();
    schedulePreview();
  }

  /** Phases are stored in day order; moving one re-sorts rather than refusing the move. */
  function setStartDay(index, day) {
    var p = state.draft.phases[index];
    if (!p) return;
    var next = Math.min(AUTHOR_DAYS, Math.max(1, Number(day) || 1));
    if (next === Number(p.start_day)) return;
    p.start_day = next;
    state.draft.phases.sort(function (a, b) { return Number(a.start_day) - Number(b.start_day); });
    state.selected = state.draft.phases.indexOf(p);
    changed(true);
  }

  function confirmDiscard() {
    return !state.dirty || global.confirm("Discard your unsaved changes to this plant's cycle plan?");
  }

  function nextStart() {
    var phases = state.draft.phases;
    if (!phases.length) return 1;
    var p = phases[phases.length - 1];
    var days = isUnitDerived(p.categories) ? 1 : Number(p.days) || 1;
    return Math.min(AUTHOR_DAYS, (Number(p.start_day) || 1) + span(days, p.step_days));
  }

  function save() {
    if (state.saving || !state.dirty) return;
    var problem = localProblem(state.draft.phases);
    if (problem) { state.previewError = problem; renderGrid(); renderActions(); return; }
    state.saving = true;
    renderActions();
    var code = state.siteCode;
    var meta = monthMeta(state.month);
    api().request("/api/pm-plan/cycle-plans/" + encodeURIComponent(code) + "?cycle_start=" + meta.start, {
      method: "PUT",
      body: { phases: payloadPhases(), notes: (state.draft.notes || "").trim() || null,
              expected_updated_at: state.baseVersion }
    }).then(function (body) {
      if (!sameCode(code, state.siteCode)) return;
      state.plan = body;
      state.baseVersion = body.updated_at || null;
      state.draft = { phases: (body.phases || []).map(clonePhase), notes: body.notes || "" };
      state.preview = body.chained ? { resolved: body.resolved, chained: body.chained, cycle_start: meta.start } : null;
      state.dirty = false;
      state.notice = "Saved. The new plan applies from the next cycle; work already generated is unchanged.";
      state.noticeError = false;
    }).catch(function (error) {
      state.notice = (error && error.message) || "The plan could not be saved. Nothing was changed.";
      state.noticeError = true;
      state.stale = !!(error && error.status === 409);
    }).then(function () {
      state.saving = false;
      if (sameCode(code, state.siteCode)) renderAll();
    });
  }

  function remove() {
    var plan = state.plan;
    if (!plan || !plan.configured) return;
    if (!global.confirm("Remove the cycle plan for " + plan.plant.plant + "?\n\nPM for this plant will be paused: no new cycles " +
        "will be generated. Work orders already generated are not affected.")) return;
    state.saving = true;
    renderActions();
    api().request("/api/pm-plan/cycle-plans/" + encodeURIComponent(state.siteCode), { method: "DELETE" })
      .then(function () {
        invalidateCalendar();
        state.list = null;                     // the portfolio counts are stale now
        return loadPlan();
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

  // ─────────────────────────── events (delegated once per host) ───────────────────────────
  function wire(host) {
    if (wiredHosts.has(host)) return;
    wiredHosts.add(host);

    host.addEventListener("click", function (event) {
      var target = event.target.closest("button");
      if (!target || !host.contains(target)) return;
      var action = target.getAttribute("data-cp-action");

      if (action === "retry") { loadPlan(); return; }
      if (action === "reload") { loadPlan(); return; }
      if (action === "toggle-edit") {
        if (state.editing && !confirmDiscard()) return;
        if (state.editing && state.dirty) {
          state.draft = { phases: (state.plan.phases || []).map(clonePhase), notes: state.plan.notes || "" };
          state.dirty = false; state.previewError = "";
        }
        state.editing = !state.editing;
        state.selected = null;
        renderAll();
        return;
      }
      if (target.hasAttribute("data-cp-chip")) {
        if (!canEdit()) return;
        var chip = Number(target.getAttribute("data-cp-chip"));
        state.selected = state.selected === chip ? null : chip;
        renderGrid();
        var again = host.querySelector('[data-cp-chip="' + chip + '"]');
        if (again && state.selected !== null) again.focus();
        return;
      }
      if (target.hasAttribute("data-cp-day")) {
        if (!canEdit() || state.selected === null) return;
        setStartDay(state.selected, Number(target.getAttribute("data-cp-day")));
        return;
      }
      if (target.hasAttribute("data-cp-nudge")) {
        if (!canEdit() || state.selected === null) return;
        var p = state.draft.phases[state.selected];
        setStartDay(state.selected, Number(p.start_day) + Number(target.getAttribute("data-cp-nudge")));
        return;
      }
      if (action === "deselect") { state.selected = null; renderGrid(); return; }
      if (!mayEdit() || !state.draft) return;

      if (action === "from-default") {
        state.draft.phases = (((state.list || {}).default_phases) || []).map(clonePhase);
        if (!state.draft.phases.length) {
          state.notice = "The built-in cycle is unavailable. Add phases one by one.";
          state.noticeError = true;
          renderStatus();
          return;
        }
        state.editing = true;
        state.showPhases = true;
        state.notice = "Built-in cycle loaded. Move each phase to the day this plant's tracker uses, then save.";
        state.noticeError = false;
        renderAll(); changed(true);
        return;
      }
      if (action === "add-phase") {
        var wasEmpty = !state.draft.phases.length;
        state.draft.phases.push({ phase: "", area: "Plant side", categories: [], start_day: nextStart(), days: 1, step_days: 1 });
        state.editing = true;
        state.showPhases = true;
        if (wasEmpty) { renderAll(); changed(true); return; }
        changed(true);
        var inputs = host.querySelectorAll('[data-cp-field="phase"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
        return;
      }
      if (action === "save") { save(); return; }
      if (action === "discard") {
        state.draft = { phases: (state.plan.phases || []).map(clonePhase), notes: state.plan.notes || "" };
        state.dirty = false; state.previewError = ""; state.selected = null;
        state.preview = state.plan.chained
          ? { resolved: state.plan.resolved, chained: state.plan.chained, cycle_start: monthMeta(state.month).start } : null;
        renderAll();
        return;
      }
      if (action === "remove") { remove(); return; }

      var row = target.closest("[data-cp-index]");
      if (!row || !canEdit()) return;
      var i = Number(row.getAttribute("data-cp-index"));
      if (target.hasAttribute("data-cp-remove-cat")) {
        state.draft.phases[i].categories.splice(Number(target.getAttribute("data-cp-remove-cat")), 1);
        changed(true);
        return;
      }
      if (target.hasAttribute("data-cp-remove-phase")) {
        state.draft.phases.splice(i, 1);
        state.selected = null;
        if (!state.draft.phases.length) { state.dirty = true; renderAll(); return; }
        changed(true);
      }
    });

    // Arrow keys move a selected phase a day at a time: the same move as dragging.
    host.addEventListener("keydown", function (event) {
      var chip = event.target.closest && event.target.closest("[data-cp-chip]");
      if (!chip || !canEdit()) return;
      var index = Number(chip.getAttribute("data-cp-chip"));
      var step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      state.selected = index;
      setStartDay(index, Number(state.draft.phases[index].start_day) + step);
      var moved = host.querySelector('[data-cp-chip="' + state.selected + '"]');
      if (moved) moved.focus();
    });

    host.addEventListener("dragstart", function (event) {
      var chip = event.target.closest && event.target.closest("[data-cp-chip]");
      if (!chip || !canEdit()) return;
      state.selected = Number(chip.getAttribute("data-cp-chip"));
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        try { event.dataTransfer.setData("text/plain", String(state.selected)); } catch (_) {}
      }
      renderGrid();
    });

    host.addEventListener("dragover", function (event) {
      if (!canEdit() || state.selected === null) return;
      var cell = event.target.closest && event.target.closest("[data-cp-day]");
      if (!cell) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });

    host.addEventListener("drop", function (event) {
      if (!canEdit() || state.selected === null) return;
      var cell = event.target.closest && event.target.closest("[data-cp-day]");
      if (!cell) return;
      event.preventDefault();
      setStartDay(state.selected, Number(cell.getAttribute("data-cp-day")));
    });

    host.addEventListener("input", function (event) {
      var t = event.target;
      if (!canEdit() || !state.draft) return;
      if (t.hasAttribute("data-cp-notes")) { state.draft.notes = t.value; changed(false); return; }
      var field = t.getAttribute("data-cp-field");
      var row = t.closest("[data-cp-index]");
      if (!field || !row || field === "area") return;
      var p = state.draft.phases[Number(row.getAttribute("data-cp-index"))];
      if (!p) return;
      p[field] = field === "phase" ? t.value : (t.value === "" ? null : parseInt(t.value, 10));
      changed(false);
      if (field !== "phase") renderGrid();      // the typed plan redraws at once; "runs" follows the preview
    });

    host.addEventListener("change", function (event) {
      var t = event.target;
      if (!canEdit() || !state.draft) return;
      if (t.hasAttribute("data-cp-set-day") && state.selected !== null) {
        setStartDay(state.selected, Number(t.value));
        return;
      }
      var row = t.closest("[data-cp-index]");
      if (!row) return;
      var p = state.draft.phases[Number(row.getAttribute("data-cp-index"))];
      if (!p) return;
      if (t.hasAttribute("data-cp-add-cat") && t.value) {
        p.categories.push(t.value);
        if (!(p.phase || "").trim()) p.phase = t.value;
        changed(true);
        return;
      }
      if (t.getAttribute("data-cp-field") === "area") { p.area = t.value; changed(false); }
    });

    host.addEventListener("toggle", function (event) {
      if (event.target && event.target.hasAttribute("data-cp-details")) state.showPhases = event.target.open;
    }, true);
  }

  /**
   * Mount the tracker inside a plant's PM page.
   *
   * `siteCode` (required) is the plant; `month` is the cycle's month ("YYYY-MM"); `entries` are that
   * plant's PM work orders, so the grid also reads as a tracker; `list` is a cycle-plan listing the
   * caller already fetched (categories and the built-in phases), so the page does not ask twice.
   */
  function show(host, options) {
    if (!host) return;
    var siteCode = (options && options.siteCode) || null;
    if (!siteCode) { host.innerHTML = ""; return; }
    var month = (options && options.month) || businessToday().slice(0, 7);
    var changedPlant = !sameCode(siteCode, state.siteCode) || month !== state.month;

    if (state.host !== host) {
      // pm-overview re-renders its page, so the host element is new each time: keep the draft when
      // it is the same plant and month, and start clean when it is not.
      var keep = !changedPlant && state.dirty ? state : null;
      state = keep || freshState();
      state.host = host;
    }
    state.entries = (options && options.entries) || [];
    if (options && options.list) state.list = options.list;

    wire(host);
    if (changedPlant) {
      state.siteCode = siteCode;
      state.month = month;
      loadList().then(loadPlan);
      return;
    }
    state.siteCode = siteCode;
    state.month = month;
    if (!state.plan && !state.planLoading) { loadList().then(loadPlan); return; }
    renderAll();
  }

  global.Solar91PortalPMCyclePlans = { show: show };
}(window));
