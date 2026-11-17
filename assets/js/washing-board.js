/**
 * washing-board.js
 * ─────────────────────────────────────────────────────────────────────
 * Module Cleaning at a glance: one card per plant, the whole portfolio on
 * one board.
 *
 * It is the page the Overview's Module Cleaning tile opens, and the page
 * Views → Module Cleaning shows. Each card carries the plant, the cycle it is
 * on, how much of that cycle is cleaned, and how far behind the plant is. The
 * card opens that plant's Module Cleaning calendar.
 *
 * Everything is read in one request — GET /api/scheduled/washing/overview —
 * the same figures the calendar reads for a single plant, so the board and the
 * calendar can never disagree. `overdue_bucket` is the server's own lateness
 * grouping (on_track / 1d / 3d / 7d) and drives the colour, so "behind" means
 * the same thing here as everywhere else in the portal.
 */
(function (global) {
  "use strict";

  var fmt = global.Solar91PortalFormat;
  var token = 0;
  var st = {
    rows: [], summary: {}, month: "", selectedMonth: "", today: "", loading: false, error: "",
    dayActivity: null, dayActivityDate: "", dayActivityLoading: false, dayActivityError: ""
  };
  var ui = {
    search: "", status: "__all", plant: "__all", cycle: "__all", date: "__all",
    entryStatus: "__all", sort: "plant", complianceCycle: "all", compliancePeriod: "week"
  };
  var dayActivityToken = 0;

  function api() { return global.Solar91PortalAPI; }
  function escape(value) { return fmt.escape(value === null || value === undefined ? "" : String(value)); }

  function pad2(value) { return String(value).length < 2 ? "0" + value : String(value); }

  function monthKey(date) { return date.getFullYear() + "-" + pad2(date.getMonth() + 1); }

  /** dd-mm-yy, the short form the cards use. */
  function shortDate(iso) {
    var m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? m[3] + "-" + m[2] + "-" + m[1].slice(2) : "";
  }

  // ─── What a card says ────────────────────────────────────────────────
  // The server's lateness bucket, in the three words an operator reads.
  var STATUS = {
    on_track: { key: "ontrack", label: "On track" },
    "1d": { key: "behind", label: "Behind" },
    "3d": { key: "behind", label: "Behind" },
    "7d": { key: "late", label: "Really behind" }
  };

  function statusOf(row) {
    if (!row.table_count) return { key: "unset", label: "Not set up" };
    if (Number(row.cycles_this_month) >= Number(row.monthly_target || 3)) {
      return { key: "done", label: "All cycles done" };
    }
    return STATUS[row.overdue_bucket] || STATUS.on_track;
  }

  /** The cycle the plant is working on, and how much of it is cleaned. */
  function cycleOf(row) {
    var total = Number(row.table_count) || 0;
    var confirmed = Math.max(0, Number(row.confirmed_tables_cleaned) || 0);
    var pending = Math.max(0, Number(row.pending_tables_cleaned) || 0);
    var number = Number(row.current_cycle) || 1;
    return {
      number: number,
      total: total,
      confirmed: Math.min(confirmed, total || confirmed),
      pending: pending,
      percent: total ? Math.min(100, Math.round(confirmed * 100 / total)) : 0,
      done: Number(row.cycles_this_month) || 0
    };
  }

  function cleanedLine(cycle) {
    if (!cycle.total) return "Module Cleaning is not set up";
    if (!cycle.confirmed && !cycle.pending) return "No tables cleaned";
    if (cycle.pending) {
      return cycle.confirmed + " confirmed · " + cycle.pending + " awaiting confirmation";
    }
    return cycle.confirmed + " of " + cycle.total + " tables cleaned";
  }

  function plantOptions() {
    return st.rows.slice().sort(function (a, b) {
      return String(a.plant || a.site_code).localeCompare(String(b.plant || b.site_code));
    }).map(function (row) {
      return '<option value="' + escape(row.site_code) + '"' +
        (ui.plant === row.site_code ? " selected" : "") + '>' +
        escape(row.plant || row.site_code) + " · " + escape(row.site_code) + "</option>";
    }).join("");
  }

  function cycleOptions() {
    var target = st.rows.reduce(function (max, row) {
      return Math.max(max, Number(row.monthly_target) || 3);
    }, 0);
    var options = [];
    for (var cycle = 1; cycle <= target; cycle += 1) {
      options.push('<option value="' + cycle + '"' +
        (ui.cycle === String(cycle) ? " selected" : "") + ">Cycle " + cycle + "</option>");
    }
    return options.join("");
  }

  function dateOptions() {
    var monthKeySelected = st.month || st.selectedMonth;
    var match = String(monthKeySelected).match(/^(\d{4})-(\d{2})$/);
    if (!match) return "";
    var year = Number(match[1]);
    var month = Number(match[2]);
    var lastDay = new Date(year, month, 0).getDate();
    if (st.today.slice(0, 7) === monthKeySelected) {
      lastDay = Math.min(lastDay, Number(st.today.slice(8, 10)) || lastDay);
    }
    var dates = [];
    for (var day = 1; day <= lastDay; day += 1) {
      dates.push(monthKeySelected + "-" + pad2(day));
    }
    return dates.map(function (date) {
      return '<option value="' + escape(date) + '"' +
        (ui.date === date ? " selected" : "") + ">" + escape(shortDate(date)) + "</option>";
    }).join("");
  }

  function entryStatusMatches(status, selection) {
    if (selection === "__all") return true;
    if (selection === "missing") return status === "not_reported";
    return selection === "recorded" &&
      ["confirmed", "awaiting", "not_done", "rejected"].indexOf(status) !== -1;
  }

  function dayStatus(row) {
    if (!st.dayActivity || st.dayActivity.date !== ui.date) return "";
    return st.dayActivity.byCode["$" + row.site_code] || "";
  }

  function clearDayActivity() {
    dayActivityToken += 1;
    st.dayActivity = null;
    st.dayActivityDate = "";
    st.dayActivityLoading = false;
    st.dayActivityError = "";
  }

  function gradeFor(row, selection) {
    var cycleNo = selection === "all" ? (Number(row.current_cycle) || 1) : Number(selection);
    return (row.cycle_grades || []).find(function (item) {
      return Number(item.cycle_no) === cycleNo;
    }) || null;
  }

  // ─── Work scores (the same figures the Dashboard tile reads) ─────────
  // A cycle's score is the tables cleaned in its dates against the tables due so far; it is not
  // capped, so catch-up work and extra washing read above 100%. Colours use the Dashboard's
  // thresholds (85 / 70) so both pages colour a score alike.
  var GRADE_LABEL = {
    on_target: "On target", on_time: "On time", running: "In progress",
    overdue: "Late", missed: "Missed", upcoming: "Not started"
  };

  function toneOf(score) {
    if (typeof score !== "number" || !isFinite(score)) return "none";
    return score >= 85 ? "good" : score >= 70 ? "warn" : "bad";
  }

  function scoreOf(grade) {
    return grade && typeof grade.compliance_percent === "number" ? grade.compliance_percent : null;
  }

  // Score = tables cleaned / tables due so far, exactly as the Dashboard tile computes it
  // (data-adapter.js aggregatePortfolio): one plant uncapped; several, each plant's cleaned tables
  // counted up to its own due so one plant's extra washing cannot hide another's shortfall.
  function workScore(parts) {
    var single = parts.length === 1;
    var done = 0;
    var due = 0;
    parts.forEach(function (part) {
      var partDone = Math.max(0, Number(part.done) || 0);
      var partDue = Math.max(0, Number(part.due) || 0);
      done += single ? partDone : Math.min(partDone, partDue);
      due += partDue;
    });
    return {
      score: !parts.length ? null : due ? Math.round(100 * done / due) : 100,
      done: done,
      due: due
    };
  }

  /** The visible plants' month so far. */
  function monthScore(rows) {
    return workScore(rows.filter(function (row) {
      return typeof row.monthly_compliance_percent === "number" && typeof row.monthly_tables_due === "number";
    }).map(function (row) {
      return { done: row.monthly_tables_confirmed, due: row.monthly_tables_due };
    }));
  }

  /** Cycle 1-3 across the visible plants; a cycle no plant has started is not scored. */
  function cycleScores(rows) {
    var out = [];
    for (var n = 1; n <= 3; n += 1) {
      var parts = [];
      var started = false;
      var start = "";
      rows.forEach(function (row) {
        var grade = gradeFor(row, String(n));
        if (!grade) return;
        start = start || grade.start_date || "";
        if (grade.grade === "upcoming") return;
        started = true;
        if (scoreOf(grade) !== null && typeof grade.tables_due === "number") {
          parts.push({ done: grade.tables_done, due: grade.tables_due });
        }
      });
      var work = workScore(parts);
      out.push({ n: n, started: started, start: start, score: work.score, done: work.done, due: work.due });
    }
    return out;
  }

  // ─── Card ────────────────────────────────────────────────────────────
  var RING = 2 * Math.PI * 22;        // r=22 in the ring's viewBox

  function ringHTML(cycle, status) {
    var filled = RING * Math.min(100, cycle.percent) / 100;
    return '<svg class="ep-wb__ring" viewBox="0 0 52 52" aria-hidden="true">' +
      '<circle class="ep-wb__ring-track" cx="26" cy="26" r="22"></circle>' +
      '<circle class="ep-wb__ring-fill ep-wb__ring-fill--' + status.key + '" cx="26" cy="26" r="22" ' +
        'stroke-dasharray="' + filled.toFixed(1) + " " + (RING - filled).toFixed(1) + '"></circle>' +
      "</svg>" +
      '<span class="ep-wb__ring-text"><strong>' + cycle.percent + '%</strong><small>Cycle ' + cycle.number + "</small></span>";
  }

  /** One small bar per cycle: its work score (or its grade, for roles that do not see scores). */
  function barHTML(label, score, grade, focus, title) {
    var upcoming = !grade || grade === "upcoming";
    var tone = upcoming ? "none"
      : score !== null ? toneOf(score)
      : grade === "on_target" || grade === "on_time" ? "good"
      : grade === "running" ? "warn" : "bad";
    var width = upcoming ? 0 : score !== null ? Math.max(0, Math.min(100, score))
      : grade === "running" ? 50 : 100;
    var value = upcoming ? "—" : score !== null ? score + "%" : (GRADE_LABEL[grade] || "");
    return '<span class="ep-wb__cbar ep-wb__cbar--' + tone + (focus ? " is-focus" : "") +
      (score !== null && score > 100 ? " is-over" : "") + '" title="' + escape(title) + '">' +
      '<span class="ep-wb__cbar-n">' + escape(label) + "</span>" +
      '<span class="ep-wb__cbar-track"><i style="width:' + width + '%"></i></span>' +
      '<span class="ep-wb__cbar-v">' + escape(value) + "</span></span>";
  }

  /** Cycle 1 · 2 · 3 for one plant: each cycle's score as a bar, the focused cycle outlined. */
  function pipsHTML(row, target) {
    var bars = [];
    for (var number = 1; number <= target; number += 1) {
      var grade = gradeFor(row, String(number));
      var score = scoreOf(grade);
      var name = grade ? grade.grade : "";
      var title = "Cycle " + number + ": " + (GRADE_LABEL[name] || "No grade") +
        (score !== null ? " · " + score + "%" : "") +
        (grade && typeof grade.tables_due === "number" && name !== "upcoming"
          ? " · " + (grade.tables_done || 0) + " of " + grade.tables_due + " tables due so far" : "");
      bars.push(barHTML("C" + number, score, name, ui.complianceCycle === String(number), title));
    }
    return '<span class="ep-wb__pips" aria-label="Cycle scores">' + bars.join("") + "</span>";
  }

  /** The cycle the date is in (the latest one that has started), with its work score. Null for
   *  roles that do not receive scores; the card then shows the cycle's tables as before. */
  function currentWork(row) {
    var grades = (row.cycle_grades || []).filter(function (item) {
      return item.grade !== "upcoming" && scoreOf(item) !== null;
    });
    if (!grades.length) return null;
    var grade = grades.reduce(function (latest, item) {
      return Number(item.cycle_no) > Number(latest.cycle_no) ? item : latest;
    });
    return {
      number: Number(grade.cycle_no),
      percent: scoreOf(grade),
      done: Number(grade.tables_done) || 0,
      due: Number(grade.tables_due) || 0
    };
  }

  function cardHTML(row) {
    // The ring shows the current cycle's work score, the same number as that cycle's bar, so a
    // card never shows two different percentages for one cycle.
    var work = currentWork(row);
    var cycle = work ? { number: work.number, percent: work.percent } : cycleOf(row);
    var ringTone = work ? { good: "ontrack", warn: "behind", bad: "late", none: "unset" }[toneOf(work.percent)] : null;
    var status = statusOf(row);
    var target = Number(row.monthly_target) || 3;
    var name = row.plant || row.site_code;
    var month = typeof row.monthly_compliance_percent === "number" ? row.monthly_compliance_percent : null;
    var lastUpdated = shortDate(row.last_report_date);
    var late = Number(row.overdue_days) || 0;
    var statusForDate = ui.date === "__all" ? "" : dayStatus(row);
    var entryNote = statusForDate === "not_reported"
      ? '<span class="ep-wb__entry-note">No entry · ' + escape(shortDate(ui.date)) + "</span>"
      : ["confirmed", "awaiting", "not_done", "rejected"].indexOf(statusForDate) !== -1
        ? '<span class="ep-wb__entry-note ep-wb__entry-note--recorded">Entry submitted · ' +
          escape(shortDate(ui.date)) + "</span>"
        : statusForDate === "paused"
          ? '<span class="ep-wb__entry-note ep-wb__entry-note--paused">Inactive · ' +
            escape(shortDate(ui.date)) + "</span>"
          : "";
    return '<button type="button" class="ep-wb__card ep-wb__card--' + status.key +
      '" data-wb-plant="' + escape(row.site_code) + '" aria-label="Open the Module Cleaning calendar for ' +
      escape(name) + '">' +
      '<span class="ep-wb__head">' +
        '<span class="ep-wb__name">' + escape(name) + "</span>" +
        (month !== null
          ? '<span class="ep-wb__month-score ep-wb__month-score--' + toneOf(month) +
            '" title="Month so far: ' + escape(row.monthly_tables_confirmed) + " of " +
            escape(row.monthly_tables_due) + ' tables due">' + escape(month) + "%</span>"
          : "") +
        '<span class="ep-wb__code">' + escape(row.site_code) + "</span>" +
      "</span>" +
      '<span class="ep-wb__body">' +
        '<span class="ep-wb__gauge">' + ringHTML(cycle, ringTone ? { key: ringTone } : status) + "</span>" +
        '<span class="ep-wb__facts">' +
          '<span class="ep-wb__tables">' + escape(work
            ? "Cycle " + work.number + ": " + work.done + " of " + work.due + " tables due so far"
            : cleanedLine(cycleOf(row))) + "</span>" +
          pipsHTML(row, target) +
        "</span>" +
      "</span>" +
      '<span class="ep-wb__foot">' +
        entryNote +
        '<span class="ep-wb__pill ep-wb__pill--' + status.key + '">' + escape(status.label) +
          (late > 0 ? " · " + late + "d" : "") + "</span>" +
        '<span class="ep-wb__date">' +
          (lastUpdated
            ? '<span class="ep-wb__date-label">Last Updated :</span>' + escape(lastUpdated)
            : "No records yet") + "</span>" +
        '<span class="ep-wb__assignee">' + escape(row.assignee_name || "Unassigned") + "</span>" +
      "</span>" +
      "</button>";
  }

  // ─── Page ────────────────────────────────────────────────────────────
  function visibleRows() {
    var term = ui.search.trim().toLowerCase();
    var rows = st.rows.filter(function (row) {
      if (ui.status !== "__all" && statusOf(row).key !== ui.status) return false;
      if (ui.plant !== "__all" && row.site_code !== ui.plant) return false;
      if (ui.cycle !== "__all" &&
          (row.cleaned_cycles || []).indexOf(Number(ui.cycle)) === -1) return false;
      if (ui.entryStatus !== "__all" &&
          !entryStatusMatches(dayStatus(row), ui.entryStatus)) return false;
      if (!term) return true;
      return [row.plant, row.site_code, row.district, row.assignee_name]
        .join(" ").toLowerCase().indexOf(term) !== -1;
    });
    if (ui.sort !== "plant") {
      // By the focused scope's work score (the month, or the chosen cycle). Plants without a
      // score (not set up, a cycle not started, a role that does not see scores) sort last.
      var scoreFor = function (row) {
        var value = ui.complianceCycle === "all" ? row.monthly_compliance_percent
          : scoreOf(gradeFor(row, ui.complianceCycle));
        return typeof value === "number" ? value : null;
      };
      rows.sort(function (a, b) {
        var left = scoreFor(a);
        var right = scoreFor(b);
        if (left === null && right !== null) return 1;
        if (right === null && left !== null) return -1;
        var direction = ui.sort === "compliance-low" ? 1 : -1;
        if (left !== right) return (left - right) * direction;
        return String(a.site_code).localeCompare(String(b.site_code), undefined, { numeric: true });
      });
    }
    return rows;
  }

  /** The summary band: month donut · Cycle 1-3 bars · plant status chips, in one row. */
  function complianceHTML(rows) {
    var month = monthScore(rows);
    var hasScore = typeof month.score === "number" && isFinite(month.score);
    var fill = hasScore ? Math.max(0, Math.min(100, month.score)) : 0;
    var tone = hasScore ? toneOf(month.score) : "none";
    var colour = tone === "good" ? "var(--ep-accent)" : tone === "warn" ? "var(--ep-amber)" : "var(--ep-red)";
    var style = hasScore
      ? "background:conic-gradient(" + colour + " 0 " + fill + "%,var(--ep-border-soft) " + fill + "% 100%)"
      : "background:conic-gradient(var(--ep-border-soft) 0 100%)";
    var help = !rows.length ? "No plants in this view."
      : !hasScore ? "Scores are shown to the O&M team."
      : rows.length === 1 ? "This plant, month so far"
      : rows.length + " plants · each counted up to its own due";
    var cycles = cycleScores(rows).map(function (cycle) {
      var title = cycle.started
        ? "Cycle " + cycle.n + ": " + cycle.done + " of " + cycle.due + " tables due so far"
        : "Cycle " + cycle.n + " has not started" + (cycle.start ? " (starts " + shortDate(cycle.start) + ")" : "");
      return '<button type="button" class="ep-wb__scope' +
        (ui.complianceCycle === String(cycle.n) ? " is-on" : "") + '" data-wb-scope="' + cycle.n + '">' +
        barHTML("Cycle " + cycle.n, cycle.started ? cycle.score : null,
          cycle.started ? (cycle.score === null ? "running" : "scored") : "upcoming",
          false, title) + "</button>";
    }).join("");
    // A compact card on the right: the donut, the figures it is made of on one line below it,
    // then the three cycle bars (click one to focus it).
    return '<aside class="ep-wb__compliance" aria-label="Module Cleaning compliance">' +
      '<h2>Compliance <button type="button" class="ep-wb__scope-all' +
        (ui.complianceCycle === "all" ? " is-on" : "") + '" data-wb-scope="all">Month</button></h2>' +
      '<div class="ep-wb__donut" style="' + style + '">' +
        '<span class="ep-wb__donut-label"><strong>' + (hasScore ? escape(month.score) + "%" : "N/A") +
        "</strong><small>month so far</small></span></div>" +
      '<div class="ep-wb__compliance-legend">' +
        '<span><i class="ep-wb__key ep-wb__key--target"></i>Cleaned <b>' +
          (hasScore ? escape(month.done) : "—") + "</b></span>" +
        '<span><i class="ep-wb__key ep-wb__key--ontime"></i>Due so far <b>' +
          (hasScore ? escape(month.due) : "—") + "</b></span>" +
      "</div>" +
      '<p class="ep-wb__compliance-note">' + escape(help) + "</p>" +
      '<div class="ep-wb__sum-cycles">' + cycles + "</div>" +
      "</aside>";
  }

  function countsHTML() {
    var tally = { ontrack: 0, behind: 0, late: 0, done: 0, unset: 0 };
    st.rows.forEach(function (row) { tally[statusOf(row).key] += 1; });
    return [
      { key: "__all", label: "All plants", n: st.rows.length },
      { key: "ontrack", label: "On track", n: tally.ontrack },
      { key: "behind", label: "Behind", n: tally.behind },
      { key: "late", label: "Really behind", n: tally.late },
      { key: "done", label: "All cycles done", n: tally.done }
    ].map(function (item) {
      return '<button type="button" class="ep-wb__tally ep-wb__tally--' +
        (item.key === "__all" ? "all" : item.key) + (ui.status === item.key ? " is-on" : "") +
        '" data-wb-status="' + item.key + '"><strong>' + item.n + "</strong>" + item.label + "</button>";
    }).join("");
  }

  function render(container) {
    var rows = visibleRows();
    container.innerHTML = '<div class="ep-pt ep-wb">' +
      // Two columns above the cards: on the left the title, the status chips, month + search and
      // the filters; on the right the compliance card. The cards start right below both.
      '<div class="ep-wb__upper"><div class="ep-wb__lead">' +
      '<div class="ep-wb__title"><h1 class="ep-pt__title">Module Cleaning</h1>' +
        '<p class="ep-pt__sub">' + st.rows.length + " plants · " + escape(st.month) +
        " · open a plant for its cleaning calendar</p></div>" +
      '<div class="ep-wb__tallies">' + countsHTML() + "</div>" +
      '<div class="ep-wb__tools"><label class="ep-wb__month"><span>Month</span>' +
        '<input type="month" data-wb-month value="' + escape(st.selectedMonth) +
        '" max="' + escape(monthKey(new Date())) + '" aria-label="Select Module Cleaning month" /></label>' +
        '<div class="ep-pt__search ep-wb__search">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>' +
        '<input type="text" placeholder="Search plant, code, district, assignee..." data-wb-search value="' +
        escape(ui.search) + '" autocomplete="off" /></div></div>' +
      '<div class="ep-wb__filters" aria-label="Filter Module Cleaning plants">' +
        // The first four options name themselves ("All plants", "All cycles", ...), so their labels
        // are for screen readers only and the whole filter row fits on one line.
        '<label><span class="ep-wb__sr-only">Plant</span><select data-wb-filter="plant" aria-label="Filter by plant">' +
          '<option value="__all">All plants</option>' + plantOptions() + '</select></label>' +
        '<label><span class="ep-wb__sr-only">Cycle</span><select data-wb-filter="cycle" aria-label="Filter by cleaning cycle">' +
          '<option value="__all">All cycles</option>' + cycleOptions() + '</select></label>' +
        '<label><span class="ep-wb__sr-only">Cleaning date</span><select data-wb-filter="date" aria-label="Filter by cleaning date" title="Cleaning date">' +
          '<option value="__all">All dates</option>' + dateOptions() + '</select></label>' +
        '<label><span class="ep-wb__sr-only">Entry status</span><select data-wb-filter="entryStatus" aria-label="Filter by entry status" title="Entry status (choose a date first)"' +
          (ui.date === "__all" ? " disabled" : "") + '>' +
          '<option value="__all">All statuses</option>' +
          '<option value="recorded"' + (ui.entryStatus === "recorded" ? " selected" : "") +
            '>Entry submitted</option>' +
          '<option value="missing"' + (ui.entryStatus === "missing" ? " selected" : "") +
            '>No entry</option></select></label>' +
        '<label><span>Sort</span><select data-wb-filter="sort" aria-label="Sort Module Cleaning plants">' +
          '<option value="plant"' + (ui.sort === "plant" ? " selected" : "") + '>Plant name</option>' +
          '<option value="compliance-high"' + (ui.sort === "compliance-high" ? " selected" : "") + '>Compliance: high to low</option>' +
          '<option value="compliance-low"' + (ui.sort === "compliance-low" ? " selected" : "") + '>Compliance: low to high</option>' +
        '</select></label>' +
      '</div></div>' +
      complianceHTML(rows) + "</div>" +
      (st.loading
        ? '<div class="ep-pt__loading" role="status">Loading Module Cleaning…</div>'
        : st.error
          ? '<div class="ep-pt__error" role="alert">Module Cleaning could not be loaded. ' +
            escape(st.error) + ' <button type="button" data-wb-retry>Try again</button></div>'
          : st.dayActivityLoading
            ? '<div class="ep-pt__loading" role="status">Checking entries for ' +
              escape(shortDate(ui.date)) + '…</div>'
            : st.dayActivityError
              ? '<div class="ep-pt__error" role="alert">Entry status could not be loaded. ' +
                escape(st.dayActivityError) + ' <button type="button" data-wb-retry-day>Try again</button></div>'
          : rows.length
        ? '<div class="ep-wb__grid">' + rows.map(cardHTML).join("") + "</div>"
        : '<div class="ep-pt__empty-card">' +
          (ui.entryStatus === "missing"
            ? "No plants are missing an entry for " + escape(shortDate(ui.date)) + "."
            : ui.entryStatus === "recorded"
              ? "No plants have an entry for " + escape(shortDate(ui.date)) + "."
              : "No plants match this search.") + '</div>') +
      "</div>";
    wire(container);
  }

  function wire(container) {
    var month = container.querySelector("[data-wb-month]");
    if (month) {
      month.addEventListener("change", function () {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month.value)) return;
        st.selectedMonth = month.value;
        ui.date = "__all";
        ui.entryStatus = "__all";
        clearDayActivity();
        show(container, st.selectedMonth);
      });
    }
    var retry = container.querySelector("[data-wb-retry]");
    if (retry) retry.addEventListener("click", function () { show(container, st.selectedMonth); });
    var retryDay = container.querySelector("[data-wb-retry-day]");
    if (retryDay) retryDay.addEventListener("click", function () { loadDayActivity(container); });
    var search = container.querySelector("[data-wb-search]");
    if (search) {
      search.addEventListener("input", function () {
        var pos = search.selectionStart;
        ui.search = search.value;
        render(container);
        var again = container.querySelector("[data-wb-search]");
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
      });
    }
    container.querySelectorAll("[data-wb-filter]").forEach(function (select) {
      select.addEventListener("change", function () {
        var filter = select.getAttribute("data-wb-filter");
        ui[filter] = select.value;
        if (filter === "date" && ui.date === "__all") ui.entryStatus = "__all";
        if (filter === "date" || filter === "entryStatus") {
          if (ui.date !== "__all") {
            loadDayActivity(container);
            return;
          }
          clearDayActivity();
        }
        render(container);
      });
    });
    // Focus the month or one cycle: it sorts the plants and outlines that cycle on every card.
    container.querySelectorAll("[data-wb-scope]").forEach(function (button) {
      button.addEventListener("click", function () {
        var scope = button.getAttribute("data-wb-scope");
        ui.complianceCycle = ui.complianceCycle === scope ? "all" : scope;
        render(container);
      });
    });
    container.querySelectorAll("[data-wb-status]").forEach(function (button) {
      button.addEventListener("click", function () {
        ui.status = button.getAttribute("data-wb-status");
        render(container);
      });
    });
    container.querySelectorAll("[data-wb-plant]").forEach(function (card) {
      card.addEventListener("click", function () {
        // Straight into that plant's own Module Cleaning calendar.
        global.Solar91PortalNav.selectPlantPage(card.getAttribute("data-wb-plant"), "washing");
      });
    });
  }

  function loadDayActivity(container) {
    var date = ui.date;
    if (date === "__all") {
      clearDayActivity();
      render(container);
      return;
    }
    if (st.dayActivity && st.dayActivity.date === date) {
      render(container);
      return;
    }
    if (st.dayActivityLoading && st.dayActivityDate === date) return;
    var client = api();
    if (!client || typeof client.request !== "function") {
      st.dayActivityError = "The portal API client is not available.";
      st.dayActivityLoading = false;
      render(container);
      return;
    }
    var mine = ++dayActivityToken;
    st.dayActivity = null;
    st.dayActivityDate = date;
    st.dayActivityLoading = true;
    st.dayActivityError = "";
    render(container);
    client.request("/api/scheduled/washing/day-activity?day=" + encodeURIComponent(date))
      .then(function (body) {
        if (mine !== dayActivityToken || ui.date !== date) return;
        if (!body || !Array.isArray(body.plants)) {
          throw new Error("The daily entry status response was incomplete.");
        }
        var byCode = Object.create(null);
        body.plants.forEach(function (plant) {
          if (plant.site_code) byCode["$" + plant.site_code] = plant.status;
        });
        var missing = st.rows.some(function (row) {
          return !Object.prototype.hasOwnProperty.call(byCode, "$" + row.site_code);
        });
        if (missing) throw new Error("The daily entry status did not include every visible plant.");
        st.dayActivity = { date: date, byCode: byCode };
        st.dayActivityLoading = false;
        if (container.isConnected) render(container);
      })
      .catch(function (error) {
        if (mine !== dayActivityToken || ui.date !== date) return;
        st.dayActivityLoading = false;
        st.dayActivityError = error.message || "Please retry.";
        if (container.isConnected) render(container);
      });
  }

  function show(container, selectedMonth) {
    if (!container) return;
    var mine = ++token;
    var prefill = global.Solar91WashingBoardPrefill;
    if (prefill) {
      ui.plant = prefill.plant || "__all";
      ui.complianceCycle = ["all", "1", "2", "3"].indexOf(String(prefill.cycle)) !== -1
        ? String(prefill.cycle) : "all";
      global.Solar91WashingBoardPrefill = null;
    }
    clearDayActivity();
    var month = selectedMonth || st.selectedMonth || monthKey(new Date());
    st.selectedMonth = month;
    st.month = month;
    st.loading = true;
    st.error = "";
    render(container);
    // summary=true: the cards read scalars only, so the per-plant day, cycle and productivity
    // lists — about three quarters of the response — are not asked for.
    return api().request("/api/scheduled/washing/overview?month=" + encodeURIComponent(month) +
      "&include_reports=false&summary=true").then(function (body) {
      if (mine !== token) return;                       // a newer page replaced this one
      st.rows = (body.plants || []).slice().sort(function (a, b) {
        return String(a.site_code).localeCompare(String(b.site_code), undefined, { numeric: true });
      });
      st.summary = body.summary || {};
      st.month = body.month || month;
      st.today = body.today || "";
      st.loading = false;
      if (container.isConnected) {
        if (ui.date !== "__all") loadDayActivity(container);
        else render(container);
      }
    }).catch(function (error) {
      if (mine !== token) return;
      st.loading = false;
      st.error = (error && error.message) ? error.message : "Please retry.";
      if (container.isConnected) render(container);
    });
  }

  global.Solar91PortalWashingBoard = { show: show };
}(window));
