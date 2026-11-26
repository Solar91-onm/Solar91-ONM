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
 *
 * Extra cleaning is managed from here as well as from a plant's calendar: the entry-status filter
 * has an "Extra cleaning" option that lists the month's re-cleaning (purple) and the days recorded
 * after all three cycles were complete (blue), and an entry can be edited, counted as ordinary
 * cleaning or removed without leaving this page. None of that behaviour lives here -- the labels,
 * the three actions and the form all come from assets/js/extra-cleaning.js, which the plant
 * calendar calls too, so the two screens can never offer different wording or different rules.
 */
(function (global) {
  "use strict";

  var fmt = global.Solar91PortalFormat;
  var token = 0;
  var st = {
    rows: [], summary: {}, month: "", selectedMonth: "", today: "", loading: false, error: "",
    dayActivity: null, dayActivityDate: "", dayActivityLoading: false, dayActivityError: "",
    // The month's extra-cleaning entries, read only while the filter that shows them is on.
    // null = not asked for. extraNotice is what the form says after a save.
    extraEntries: null, extraNotice: ""
  };
  // The state assets/js/extra-cleaning.js keeps for its form and for the three per-entry actions.
  // The field names are the ones the plant calendar uses, because the same module reads them.
  var xc = {
    extraOpen: false, extraEditId: "", extraPlantCode: "", extraDate: "", extraList: "",
    extraRemarks: "", extraSaving: false, extraError: "",
    extraConverting: false, extraConvertError: "",
    extraDeleteConfirmId: "", extraDeleting: false, extraDeleteError: "",
    // Confirm / Reject on an entry that is still awaiting review.
    extraReviewing: "", extraReviewError: "", extraRejectConfirmId: ""
  };
  var ui = {
    search: "", status: "__all", plant: "__all", cycle: "__all", date: "__all",
    // "auto" = the cycle in progress, so the card opens on the cycle being worked on rather than
    // on month-to-date totals. "all" is the Month view; "1"/"2"/"3" pin one cycle.
    entryStatus: "__all", sort: "plant", complianceCycle: "auto", compliancePeriod: "week",
    view: "cards", tableSort: { key: "", dir: "" }, columnFilters: {}
  };
  var dayActivityToken = 0;
  var viewPreferenceUser = null;

  function api() { return global.Solar91PortalAPI; }
  /** Extra cleaning: labels, the three actions and the form, shared with the plant calendar. */
  function extras() { return global.Solar91ExtraCleaning; }
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
    "7d": { key: "late", label: "Late" }
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

  /**
   * The plant's name without its trailing site number ("ABHANERI 01" -> "ABHANERI"). The site
   * code chip beside it is what separates ALN01 from ALN02, so the number is not repeated here.
   */
  function plantLabel(row) {
    var name = String(row.plant || "").trim();
    return name.replace(/\s+\d{1,}$/, "").trim() || name || row.site_code;
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

  // ─── Extra cleaning ──────────────────────────────────────────────────
  // Two kinds of entry, and they do not mean the same thing. Marked extra (`is_extra`) is
  // re-cleaning done while a cycle was still running: a record that never counts, purple on the
  // plant calendar. A day recorded once all three cycles were complete (`post_cycle`) is ordinary
  // work the month IS credited for, blue there. Both are listed here, with the calendar's own
  // labels and colours, so moving between the two screens teaches nothing new.

  function isExtraEntry(report) {
    return report.is_extra === true || report.post_cycle === true;
  }

  /** How many days of reports the selected month needs, so the read stays as small as it can be.
   *  The server sends reports newer than (as-of − report_days); as-of is today for this month and
   *  the month's last day for an earlier one, so the month's own span is exactly enough. */
  function monthSpanDays(month) {
    var parts = String(month || "").match(/^(\d{4})-(\d{2})$/);
    if (!parts) return 35;
    var lastDay = new Date(Number(parts[1]), Number(parts[2]), 0).getDate();
    var day = st.today && st.today.slice(0, 7) === month
      ? Number(st.today.slice(8, 10)) || lastDay : lastDay;
    return Math.max(1, Math.min(90, day));
  }

  /** The entries the filters already on the page leave in scope: plant, cycle, date and month. */
  function extraEntriesInScope() {
    var month = st.month || st.selectedMonth;
    var codes = Object.create(null);
    baseRows().forEach(function (row) { codes["$" + row.site_code] = true; });
    return (st.extraEntries || []).filter(function (entry) {
      if (codes["$" + entry.site_code] !== true) return false;
      if (month && entry.cycle_month !== month) return false;
      if (ui.cycle !== "__all" && Number(entry.cycle_no) !== Number(ui.cycle)) return false;
      if (ui.date !== "__all" && entry.report_date !== ui.date) return false;
      return true;
    }).sort(function (a, b) {
      if (a.report_date !== b.report_date) return a.report_date < b.report_date ? 1 : -1;
      return String(a.site_code).localeCompare(String(b.site_code), undefined, { numeric: true });
    });
  }

  /** The plants the form may record against: every configured plant in the caller's scope. */
  function extraPlants() {
    return st.rows.filter(function (row) { return Number(row.table_count) > 0; })
      .map(function (row) {
        return { code: row.site_code, name: row.plant || row.site_code };
      });
  }

  /**
   * Which plant the shared form is working on, and the hooks this page's markup uses. The form is
   * pre-scoped to the plant currently filtered; with no single plant in scope it asks which plant
   * before it shows anything else, which is what `plants` is for.
   */
  function extraScope() {
    var chosen = xc.extraOpen && xc.extraPlantCode
      ? xc.extraPlantCode : (ui.plant !== "__all" ? ui.plant : "");
    var row = chosen ? st.rows.find(function (item) { return item.site_code === chosen; }) : null;
    return {
      attr: "data-wb-extra-action",
      formAttr: "data-wb-extra-form",
      modalAttr: "data-wb-extra-modal",
      plants: extraPlants(),
      plantCode: ui.plant !== "__all" ? ui.plant : "",
      plantId: row ? row.plant_id : "",
      plantName: row ? (row.plant || row.site_code) : "",
      tableCount: row ? Number(row.table_count) || 0 : 0,
      today: st.today || "",
      minDate: extras().earliestDate(st.month || st.selectedMonth, st.today || "")
    };
  }

  /**
   * What assets/js/extra-cleaning.js needs to drive THIS page. Editing, converting or removing an
   * entry changes cycle progress and compliance, so the board re-reads the overview rather than
   * patching a figure locally: cycle state is the server's answer, never the browser's.
   */
  function extraContext(container) {
    var mine = token;
    var scope = extraScope();
    scope.ready = !st.loading && !!st.rows.length;
    scope.find = function (reportId) {
      return (st.extraEntries || []).find(function (entry) { return entry.id === reportId; });
    };
    scope.alive = function () { return mine === token && container.isConnected; };
    scope.render = function () { render(container); };
    scope.focus = function (selector) {
      var field = container.querySelector(selector);
      if (field) field.focus();
    };
    scope.sync = function () { extras().syncForm(container, xc, extraScope()); };
    scope.reviewNote = function () {
      var field = container.querySelector("[data-extra-review-note]");
      return field ? field.value : "";
    };
    scope.prune = function (reportId) {
      st.extraEntries = (st.extraEntries || []).filter(function (entry) {
        return entry.id !== reportId;
      });
    };
    scope.reload = function () { show(container, st.selectedMonth); };
    scope.saved = function (saved, notice) {
      // show() clears the notice, so it is set again for the reload it belongs to; the next visit
      // to this page starts without it.
      show(container, st.selectedMonth);
      st.extraNotice = notice;
      render(container);
    };
    return scope;
  }

  function dayStatus(row) {
    if (!st.dayActivity || st.dayActivity.date !== ui.date) return "";
    var entry = st.dayActivity.byCode["$" + row.site_code];
    return entry && entry.status || "";
  }

  function clearDayActivity() {
    dayActivityToken += 1;
    st.dayActivity = null;
    st.dayActivityDate = "";
    st.dayActivityLoading = false;
    st.dayActivityError = "";
  }

  function rowsWithUnconfiguredPlants(body) {
    var rows = (body.plants || []).slice();
    var seen = Object.create(null);
    rows.forEach(function (row) { seen["$" + row.site_code] = true; });
    (body.unconfigured || []).forEach(function (plant) {
      if (!plant || !plant.site_code || seen["$" + plant.site_code]) return;
      seen["$" + plant.site_code] = true;
      rows.push(Object.assign({ table_count: 0 }, plant));
    });
    return rows.sort(function (a, b) {
      return String(a.site_code).localeCompare(String(b.site_code), undefined, { numeric: true });
    });
  }

  function gradeFor(row, selection) {
    var cycleNo = selection === "all" ? (Number(row.current_cycle) || 1) : Number(selection);
    return (row.cycle_grades || []).find(function (item) {
      return Number(item.cycle_no) === cycleNo;
    }) || null;
  }

  // ─── Work scores (the same figures the Dashboard tile reads) ─────────
  // A cycle's score is tables cleaned against the full table count; it is not capped, so extra
  // washing can read above 100%. Colours use the Dashboard's
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
    return grade && typeof grade.compliance_percent === "number"
      ? Math.min(100, Math.max(0, grade.compliance_percent)) : null;
  }

  // Each plant contributes no more completed work than its own planned count.
  // `allowExtra`: a single plant that cleaned beyond its planned cycles keeps the surplus, so its
  // score reads above 100%. Across plants every plant counts at most its own plan, so one plant's
  // extra work can never hide another's shortfall. Mirrors cleaning_activity_metrics on the server.
  function workScore(parts, allowExtra) {
    var done = 0;
    var due = 0;
    parts.forEach(function (part) {
      var partDone = Math.max(0, Number(part.done) || 0);
      var partDue = Math.max(0, Number(part.due) || 0);
      done += allowExtra ? partDone : Math.min(partDone, partDue);
      due += partDue;
    });
    return {
      score: due ? Math.round(1000 * done / due) / 10 : 0,
      done: done,
      due: due
    };
  }

  /**
   * The cycle being worked on now: the latest one any plant on screen has started. Cycles run in
   * sequence -- a plant only enters cycle n+1 once cycle n is complete -- so this is the furthest
   * the selected plants have reached, not whatever the calendar says.
   */
  function currentCycleNo(cycles) {
    var current = 0;
    cycles.forEach(function (cycle) { if (cycle.started) current = cycle.n; });
    return current || 1;
  }

  /** What the compliance sort measures: "all" or the focused cycle number. */
  function scopeCycle(rows) {
    if (ui.complianceCycle !== "auto") return ui.complianceCycle;
    return String(currentCycleNo(cycleScores(rows || st.rows)));
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
      // `plants` is how many of the plants on screen have actually reached this cycle, which is
      // what the caption must count -- not every plant in the filter.
      out.push({ n: n, started: started, start: start, plants: parts.length,
        score: started ? work.score : null, done: work.done, due: work.due });
    }
    return out;
  }

  // ─── Card ────────────────────────────────────────────────────────────
  var RING = 2 * Math.PI * 22;        // r=22 in the ring's viewBox

  function ringHTML(percent, label, status) {
    var filled = percent === null ? 0 : RING * Math.min(100, Math.max(0, percent)) / 100;
    return '<svg class="ep-wb__ring" viewBox="0 0 52 52" aria-hidden="true">' +
      '<circle class="ep-wb__ring-track" cx="26" cy="26" r="22"></circle>' +
      '<circle class="ep-wb__ring-fill ep-wb__ring-fill--' + status.key + '" cx="26" cy="26" r="22" ' +
        'stroke-dasharray="' + filled.toFixed(1) + " " + (RING - filled).toFixed(1) + '"></circle>' +
      "</svg>" +
      // The number alone fills the ring. What it measures is said once, above the card's figures,
      // so printing "Compliance" inside the circle only squeezed the percentage; it stays for
      // screen readers, which would otherwise be read a bare number.
      '<span class="ep-wb__ring-text"><strong>' +
        (percent === null ? "—" : Number(percent).toFixed(1) + "%") +
        '</strong><span class="ep-wb__sr-only">' + escape(label) + "</span></span>";
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
    // A cycle that has not started says so, rather than showing a bare dash that reads as 0%.
    var value = upcoming ? "Upcoming" : score !== null ? Number(score).toFixed(1) + "%" : (GRADE_LABEL[grade] || "");
    return '<span class="ep-wb__cbar ep-wb__cbar--' + tone + (focus ? " is-focus" : "") +
      (score !== null && score > 100 ? " is-over" : "") + '" title="' + escape(title) + '">' +
      '<span class="ep-wb__cbar-n">' + escape(label) + "</span>" +
      '<span class="ep-wb__cbar-track"><i style="width:' + width + '%"></i></span>' +
      '<span class="ep-wb__cbar-v">' + escape(value) + "</span></span>";
  }

  /** Numbered cycle markers make complete, active and upcoming cycles scannable at a glance. */
  function pipsHTML(row, target) {
    var bars = [];
    for (var number = 1; number <= target; number += 1) {
      var grade = gradeFor(row, String(number));
      var score = scoreOf(grade);
      var state = grade ? grade.grade : "";
      var title = "Cycle " + number + ": " + (GRADE_LABEL[state] || "No grade") +
        (score !== null ? " · " + Number(score).toFixed(1) + "%" : "") +
        (grade && typeof grade.tables_due === "number" && state !== "upcoming"
          ? " · " + (grade.tables_done || 0) + " of " + grade.tables_due + " tables" : "");
      bars.push(barHTML("C" + number, score, state, ui.complianceCycle === String(number), title));
    }
    return '<span class="ep-wb__pips" aria-label="Cycle progress">' + bars.join("") + "</span>";
  }

  /** Latest cycle in the completion-based sequence, or null for roles that do not see scores. */
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
      percent: Math.min(100, Math.max(0, scoreOf(grade))),
      done: Math.min(Number(grade.tables_done) || 0, Number(grade.tables_due) || 0),
      due: Number(grade.tables_due) || 0
    };
  }

  function monthlyCompliance(row) {
    if (!(Number(row.table_count) > 0) ||
        typeof row.monthly_compliance_percent !== "number" ||
        !isFinite(row.monthly_compliance_percent)) return null;
    return Math.max(0, row.monthly_compliance_percent);
  }

  function monthlyComplianceValue(row) {
    var value = monthlyCompliance(row);
    if (value === null) return Number(row.table_count) > 0 ? "Not available" : "Not configured";
    return Number(value).toFixed(1) + "%";
  }

  function sortByCompliance(rows, direction) {
    return rows.sort(function (a, b) {
      var left = monthlyCompliance(a);
      var right = monthlyCompliance(b);
      if (left === null && right !== null) return 1;
      if (right === null && left !== null) return -1;
      if (left !== right) return (left - right) * (direction === "compliance-low" ? 1 : -1);
      return String(a.site_code).localeCompare(String(b.site_code), undefined, { numeric: true });
    });
  }

  function cleaningTableRecord(row) {
    if (!(Number(row.table_count) > 0)) return null;
    if (ui.date !== "__all") {
      var day = st.dayActivity && st.dayActivity.date === ui.date
        ? st.dayActivity.byCode["$" + row.site_code] : null;
      var dayEntries = day && day.table_data_by_cycle || [];
      if (ui.cycle !== "__all") {
        return dayEntries.find(function (entry) {
          return Number(entry.cycle_no) === Number(ui.cycle);
        }) || null;
      }
      if (dayEntries.length === 1) return dayEntries[0];
      if (dayEntries.length > 1) return {
        job_status: dayEntries.some(function (entry) { return entry.job_status === "Done"; }) ? "Done" : "Not done",
        tables_cleaned: dayEntries.reduce(function (sum, entry) { return sum + (Number(entry.tables_cleaned) || 0); }, 0),
        table_range: dayEntries.map(function (entry) { return entry.table_range; }).filter(Boolean).join(" · ")
      };
      return null;
    }
    var cycleNo = ui.cycle === "__all" ? Number(row.current_cycle) || 1 : Number(ui.cycle);
    return (row.cycle_table_data || []).find(function (entry) {
      return Number(entry.cycle_no) === cycleNo;
    }) || null;
  }

  function cleanedTablesValue(row) {
    if (!(Number(row.table_count) > 0)) return "Not configured";
    var entry = cleaningTableRecord(row);
    if (!entry) return "No entry";
    if (entry.job_status !== "Done") return "Not done";
    return Number(entry.tables_cleaned) > 0 ? String(entry.tables_cleaned) : "No tables cleaned";
  }

  function cleanedRangeValue(row) {
    if (!(Number(row.table_count) > 0)) return "Not configured";
    var entry = cleaningTableRecord(row);
    if (!entry) return "No entry";
    if (entry.job_status !== "Done") return "No tables cleaned";
    return entry.table_range || "Range not recorded";
  }

  var TABLE_COLUMNS = [
    { key: "plant", label: "Plant code",
      sort: function (row) { return row.site_code; },
      value: function (row) { return row.site_code || "Not configured"; } },
    { key: "range", label: "Table range",
      sort: function (row) { return cleanedRangeValue(row); },
      value: cleanedRangeValue },
    { key: "count", label: "Tables cleaned", align: "num",
      sort: function (row) {
        var entry = cleaningTableRecord(row);
        return entry && entry.job_status === "Done" ? Number(entry.tables_cleaned) : null;
      },
      value: cleanedTablesValue },
    { key: "cycle", label: "Running cycle",
      sort: function (row) { return Number(row.table_count) > 0 ? Number(row.current_cycle) || 1 : null; },
      value: function (row) { return Number(row.table_count) > 0 ? "Cycle " + (Number(row.current_cycle) || 1) : "Not configured"; } },
    { key: "progress", label: "Compliance (%)", align: "num",
      sort: monthlyCompliance,
      value: monthlyComplianceValue }
  ];

  function viewPreferenceKey() {
    var client = api();
    var user = client && typeof client.currentUser === "function" ? client.currentUser() : null;
    var userKey = user && (user.id || user.email) || "unknown";
    return "solar91.washingBoardView.v1." + encodeURIComponent(userKey);
  }

  function loadViewPreference() {
    var key = viewPreferenceKey();
    if (viewPreferenceUser === key) return;
    viewPreferenceUser = key;
    ui.view = "cards";
    try {
      if (global.localStorage.getItem(key) === "table") ui.view = "table";
    } catch (error) {}
  }

  function saveViewPreference() {
    try {
      global.localStorage.setItem(viewPreferenceKey(), ui.view);
    } catch (error) {}
  }

  function tableFilterOptions(rows, column) {
    var values = Object.create(null);
    rows.forEach(function (row) {
      var value = String(column.value(row) == null ? "" : column.value(row)).trim();
      if (value) values["$" + value] = true;
    });
    return Object.keys(values).map(function (key) { return key.slice(1); })
      .sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
  }

  function filteredTableRows(rows) {
    var filtered = rows.filter(function (row) {
      return Object.keys(ui.columnFilters).every(function (key) {
        var wanted = ui.columnFilters[key];
        if (!wanted) return true;
        var column = TABLE_COLUMNS.find(function (item) { return item.key === key; });
        return !column || String(column.value(row)) === wanted;
      });
    });
    return global.Solar91PortalSort.apply(filtered, ui.tableSort, TABLE_COLUMNS);
  }

  function tableColumnHeader(column, rows) {
    var header = global.Solar91PortalSort.thHTML(column, ui.tableSort, "data-wb-sort");
    var active = String(ui.columnFilters[column.key] || "");
    return global.Solar91PortalColumnFilter.headerHTML(header, {
      key: column.key,
      label: column.label,
      values: tableFilterOptions(rows, column),
      active: active,
      menuId: "ep-wb-filter-menu-" + column.key,
      attributes: {
        toggleKey: "data-wb-column-filter-toggle",
        menuKey: "data-wb-column-filter-menu",
        optionKey: "data-wb-column-filter-option",
        optionValue: "data-wb-column-filter-value",
        search: "data-wb-column-filter-search",
        empty: "data-wb-column-filter-empty"
      },
      classes: {
        header: "ep-issues__th-filtered",
        content: "ep-issues__th-content",
        toggle: "ep-issues__filter-toggle",
        menu: "ep-issues__column-filter-menu",
        search: "ep-issues__column-filter-search",
        options: "ep-issues__column-filter-options",
        option: "ep-issues__column-filter-option",
        empty: "ep-issues__column-filter-empty"
      },
      searchHasKey: true,
      focusSearchOnOpen: false,
      keepAllOptionVisible: false
    });
  }

  function tableHTML(rows) {
    var visible = filteredTableRows(rows);
    if (!visible.length) {
      return '<div class="ep-pt__empty-card">No plants match these column filters.</div>';
    }
    return '<div class="ep-issues__table-wrap"><table class="ep-issues__table ep-wb__table"><thead><tr>' +
      TABLE_COLUMNS.map(function (column) { return tableColumnHeader(column, rows); }).join("") +
      '</tr></thead><tbody>' + visible.map(function (row) {
        var cycleLabel = TABLE_COLUMNS[3].value(row);
        return '<tr class="ep-issues__plant-row" data-wb-plant="' + escape(row.site_code) +
          '" tabindex="0" role="button" aria-label="Open the Module Cleaning calendar for ' +
          escape(plantLabel(row)) + '">' +
          '<td data-label="Plant code"><strong>' + escape(row.site_code) + "</strong></td>" +
          '<td data-label="Table range">' + escape(cleanedRangeValue(row)) + "</td>" +
          '<td data-label="Tables cleaned" class="num">' +
            escape(cleanedTablesValue(row)) + "</td>" +
          '<td data-label="Running cycle">' + escape(cycleLabel) + "</td>" +
          '<td data-label="Compliance (%)" class="num">' +
            escape(monthlyComplianceValue(row)) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  function cardHTML(row) {
    var work = currentWork(row);
    var cycle = work ? { number: work.number, percent: work.percent } : cycleOf(row);
    var compliance = monthlyCompliance(row);
    var ringTone = { good: "ontrack", warn: "behind", bad: "late", none: "unset" }[toneOf(compliance)];
    var status = statusOf(row);
    var target = Number(row.monthly_target) || 3;
    var name = plantLabel(row);
    var lastUpdated = shortDate(row.last_report_date);
    var late = Number(row.overdue_days) || 0;
    var statusForDate = ui.date === "__all" ? "" : dayStatus(row);
    var cycleTables = work ? work.done + " of " + work.due + " tables" :
      cycle.total ? cycle.confirmed + " of " + cycle.total + " tables" : "Table count not set";
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
        '<span class="ep-wb__code">' + escape(row.site_code) + "</span>" +
      "</span>" +
      '<span class="ep-wb__date">' + (lastUpdated
        ? '<span class="ep-wb__date-label">Last Update :</span>' + escape(lastUpdated)
        : "No records yet") + "</span>" +
      '<span class="ep-wb__body">' +
          '<span class="ep-wb__gauge">' + ringHTML(compliance, "Compliance", { key: ringTone }) + "</span>" +
        '<span class="ep-wb__facts">' +
          '<span class="ep-wb__table-count">' + escape(cycleTables) + "</span>" +
          pipsHTML(row, target) +
        "</span>" +
      "</span>" +
      '<span class="ep-wb__foot">' +
        entryNote +
        '<span class="ep-wb__pill ep-wb__pill--' + status.key + '">' + escape(status.label) +
          (late > 0 ? " · " + late + "d" : "") + "</span>" +
      "</span>" +
      "</button>";
  }

  // ─── Page ────────────────────────────────────────────────────────────
  /** Every filter except entry status, which needs this set to work out its own scope. */
  function baseRows() {
    var term = ui.search.trim().toLowerCase();
    return st.rows.filter(function (row) {
      if (ui.status !== "__all" && statusOf(row).key !== ui.status) return false;
      if (ui.plant !== "__all" && row.site_code !== ui.plant) return false;
      if (ui.cycle !== "__all" &&
          (row.cleaned_cycles || []).indexOf(Number(ui.cycle)) === -1) return false;
      if (!term) return true;
      return [row.plant, row.site_code, row.district, row.assignee_name]
        .join(" ").toLowerCase().indexOf(term) !== -1;
    });
  }

  function visibleRows() {
    var rows = baseRows();
    if (ui.entryStatus === "extra") {
      // Only the plants that have one of these entries in scope, so the cards and the list below
      // them are talking about the same plants.
      var codes = Object.create(null);
      extraEntriesInScope().forEach(function (entry) { codes["$" + entry.site_code] = true; });
      rows = rows.filter(function (row) { return codes["$" + row.site_code] === true; });
    } else if (ui.entryStatus !== "__all") {
      rows = rows.filter(function (row) {
        return entryStatusMatches(dayStatus(row), ui.entryStatus);
      });
    }
    if (ui.sort !== "plant") sortByCompliance(rows, ui.sort);
    return rows;
  }

  /**
   * One extra-cleaning entry: when it was done, which tables, the cycle it happened during or
   * after, the remark and who recorded it -- then the three actions, for a viewer the SERVER says
   * may change it (`can_edit` on a marked entry is only ever the O&M Head or an Assignee). Anyone
   * else reads the entry with no disabled buttons cluttering it.
   */
  function extraEntryHTML(entry) {
    var ec = extras();
    var tables = ec.formatTableList(ec.tableNumbersOf(entry));
    var manage = entry.is_extra === true && entry.can_edit === true;
    return '<li class="ep-wb__entry ep-wb__entry--' + ec.tone(entry) +
      (ec.awaitingReview(entry) ? " ep-wb__entry--pending" : "") + '">' +
      '<div class="ep-wb__entry-top">' +
        '<strong>' + escape(shortDate(entry.report_date)) + "</strong>" +
        ec.badgeHTML(entry) +
        // An entry that is waiting on a decision counts for nothing yet, so it says so where it
        // cannot be missed rather than only in the Review line below.
        (ec.awaitingReview(entry)
          ? '<span class="ep-wb__entry-pending">Awaiting review</span>' : "") +
        '<span class="ep-wb__entry-cycle">' + escape(ec.cycleLabel(entry)) + "</span>" +
        '<button type="button" class="ep-wb__entry-plant" data-wb-plant="' +
          escape(entry.site_code) + '" title="Open this plant’s Module Cleaning calendar">' +
          escape(entry.plant || entry.site_code) + " · " + escape(entry.site_code) + "</button>" +
      "</div>" +
      '<dl class="ep-wb__entry-facts">' +
        "<div><dt>Which tables</dt><dd>" + escape(tables || "Not recorded") + "</dd></div>" +
        "<div><dt>Tables cleaned</dt><dd>" + escape(Number(entry.tables_cleaned) || 0) + "</dd></div>" +
        "<div><dt>Remark</dt><dd>" + escape(entry.remarks || "No remark") + "</dd></div>" +
        "<div><dt>Recorded by</dt><dd>" + escape(entry.reported_by || "Not recorded") + "</dd></div>" +
        "<div><dt>Review</dt><dd>" + escape(entry.review_status || "—") + "</dd></div>" +
      "</dl>" +
      // The decision comes first: until it is made the entry counts for nothing, and the three
      // actions below are about an entry that is already standing.
      ec.reviewHTML(entry, xc, { attr: "data-wb-extra-action" }) +
      (manage ? ec.actionsHTML(entry, xc, { attr: "data-wb-extra-action" }) : "") +
    "</li>";
  }

  function extraPanelHTML() {
    if (ui.entryStatus !== "extra") return "";
    var entries = extraEntriesInScope();
    var scope = ui.plant !== "__all" ? ui.plant : st.month;
    return '<section class="ep-wb__entries" aria-label="Extra cleaning entries">' +
      '<header class="ep-wb__entries-head">' +
        "<h2>Extra cleaning</h2>" +
        "<p>" + (entries.length
          ? entries.length + (entries.length === 1 ? " entry · " : " entries · ") + escape(scope) +
            " · purple is re-cleaning during a cycle, which never counts towards compliance;" +
            " blue is cleaning after all three cycles, which does"
          : "Nothing recorded for this scope") + "</p>" +
      "</header>" +
      (entries.length
        ? '<ul class="ep-wb__entry-list">' + entries.map(extraEntryHTML).join("") + "</ul>"
        : '<div class="ep-pt__empty-card">No extra cleaning for these filters.</div>') +
    "</section>";
  }

  function countsHTML(rows) {
    var tally = { ontrack: 0, behind: 0, late: 0, done: 0, unset: 0 };
    rows.forEach(function (row) { tally[statusOf(row).key] += 1; });
    return [
      { key: "__all", label: "Visible plants", n: rows.length },
      { key: "ontrack", label: "On track", n: tally.ontrack },
      { key: "behind", label: "Behind", n: tally.behind },
      { key: "late", label: "Late", n: tally.late },
      { key: "done", label: "All cycles done", n: tally.done }
    ].map(function (item) {
      return '<button type="button" class="ep-wb__tally ep-wb__tally--' +
        (item.key === "__all" ? "all" : item.key) + (ui.status === item.key ? " is-on" : "") +
        '" data-wb-status="' + item.key + '"><strong>' + item.n + "</strong>" + item.label + "</button>";
    }).join("");
  }

  function render(container) {
    var rows = visibleRows();
    var selectedPlant = ui.plant !== "__all" ? rows.find(function (row) {
      return row.site_code === ui.plant;
    }) : null;
    var subtitle = selectedPlant
      ? escape(selectedPlant.plant || selectedPlant.site_code) + " · " +
        escape(Number(selectedPlant.table_count) || 0) + " tables · " + escape(st.month) +
        " · open this plant's cleaning calendar"
      : rows.length + (rows.length === 1 ? " plant · " : " plants · ") + escape(st.month) +
        " · open a plant for its cleaning calendar";
    container.innerHTML = '<div class="ep-pt ep-wb">' +
      // Two columns above the cards: on the left the title, the status chips, month + search and
      // the filters; on the right the compliance card. The cards start right below both.
      '<div class="ep-wb__upper"><div class="ep-wb__lead">' +
      '<div class="ep-wb__title"><h1 class="ep-pt__title">Module Cleaning</h1>' +
        '<p class="ep-pt__sub">' + subtitle + "</p></div>" +
      '<div class="ep-wb__tallies">' + countsHTML(rows) + "</div>" +
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
        // Entry submitted / No entry answer a question about one day, so they still need a date
        // chosen and are offered only then. Extra cleaning is the whole month's, so the select
        // itself is no longer disabled when no date is picked.
        '<label><span class="ep-wb__sr-only">Entry status</span><select data-wb-filter="entryStatus" aria-label="Filter by entry status" title="' +
          (ui.date === "__all"
            ? "Entry status (choose a date for the day-by-day options)"
            : "Entry status") + '">' +
          '<option value="__all">All statuses</option>' +
          '<option value="recorded"' + (ui.entryStatus === "recorded" ? " selected" : "") +
            (ui.date === "__all" ? " disabled" : "") + '>Entry submitted</option>' +
          '<option value="missing"' + (ui.entryStatus === "missing" ? " selected" : "") +
            (ui.date === "__all" ? " disabled" : "") + '>No entry</option>' +
          '<option value="extra"' + (ui.entryStatus === "extra" ? " selected" : "") +
            '>Extra cleaning</option></select></label>' +
        '<label><span>Sort</span><select data-wb-filter="sort" aria-label="Sort Module Cleaning plants">' +
          '<option value="plant"' + (ui.sort === "plant" ? " selected" : "") + '>Plant name</option>' +
          '<option value="compliance-high"' + (ui.sort === "compliance-high" ? " selected" : "") + '>Compliance: high to low</option>' +
          '<option value="compliance-low"' + (ui.sort === "compliance-low" ? " selected" : "") + '>Compliance: low to high</option>' +
        '</select></label>' +
        // The manual entry action, the same one a plant's cleaning calendar carries: this is the
        // page people are on when they notice something was recorded wrong.
        (extras().canRecord()
          ? '<button type="button" class="ep-calendar__extra-open" data-wb-extra-action="open-extra">' +
            '+ Extra cleaning</button>'
          : "") +
        '<button type="button" class="ep-wb__export-btn" data-wb-export-summary title="Export visible plants as XLSX">Export XLSX</button>' +
        '<button type="button" class="ep-wb__view-toggle" data-wb-view-toggle aria-pressed="' +
          (ui.view === "table" ? "true" : "false") + '" aria-label="Switch to ' +
          (ui.view === "table" ? "cards" : "table") + ' view" title="Switch to ' +
          (ui.view === "table" ? "cards" : "table") + ' view">' +
          (ui.view === "table" ? "Table" : "Cards") + "</button>" +
      '</div></div></div>' +
      (st.extraNotice ? '<p class="ep-wb__notice" role="status">' + escape(st.extraNotice) + '</p>' : "") +
      (st.loading || st.error ? "" : extraPanelHTML()) +
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
        ? ui.view === "table" ? tableHTML(rows)
          : '<div class="ep-wb__grid">' + rows.map(cardHTML).join("") + "</div>"
        : '<div class="ep-pt__empty-card">' +
          (ui.entryStatus === "missing"
            ? "No plants are missing an entry for " + escape(shortDate(ui.date)) + "."
            : ui.entryStatus === "recorded"
              ? "No plants have an entry for " + escape(shortDate(ui.date)) + "."
              : ui.entryStatus === "extra"
                ? "No plant has extra cleaning for these filters."
                : "No plants match this search.") + '</div>') +
      // The extra-cleaning form is the plant calendar's, rendered here against this page's scope.
      (xc.extraOpen ? extras().formHTML(xc, extraScope()) : "") +
      "</div>";
    wire(container);
  }

  function wire(container) {
    var viewToggle = container.querySelector("[data-wb-view-toggle]");
    if (viewToggle) {
      viewToggle.addEventListener("click", function () {
        var x = global.scrollX || 0;
        var y = global.scrollY || 0;
        ui.view = ui.view === "cards" ? "table" : "cards";
        saveViewPreference();
        render(container);
        if (typeof global.scrollTo === "function") global.scrollTo(x, y);
      });
    }

    global.Solar91PortalColumnFilter.wire(container, {
      attributes: {
        toggleKey: "data-wb-column-filter-toggle",
        menuKey: "data-wb-column-filter-menu",
        optionKey: "data-wb-column-filter-option",
        optionValue: "data-wb-column-filter-value",
        search: "data-wb-column-filter-search",
        empty: "data-wb-column-filter-empty"
      },
      classes: {
        menu: "ep-issues__column-filter-menu",
        search: "ep-issues__column-filter-search",
        empty: "ep-issues__column-filter-empty"
      },
      focusSearchOnOpen: false,
      keepAllOptionVisible: false,
      onSelect: function (key, _scope, value) {
        ui.columnFilters[key] = value;
        render(container);
      }
    });

    container.querySelectorAll("[data-wb-sort]").forEach(function (button) {
      button.addEventListener("click", function () {
        global.Solar91PortalSort.next(ui.tableSort, button.getAttribute("data-wb-sort"));
        render(container);
      });
    });

    var exportBtn = container.querySelector("[data-wb-export-summary]");
    if (exportBtn) {
      exportBtn.addEventListener("click", function () {
        var url = "/api/scheduled/washing/summary/export";
        if (st.selectedMonth) url += "?month=" + encodeURIComponent(st.selectedMonth);
        exportBtn.disabled = true;
        api().downloadFile(url, "Module_Cleaning_Summary.xlsx").catch(function (error) {
          global.alert(error.message || "The Module Cleaning export could not be downloaded.");
        }).then(function () {
          exportBtn.disabled = false;
        });
      });
    }

    var month = container.querySelector("[data-wb-month]");
    if (month) {
      month.addEventListener("change", function () {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month.value)) return;
        st.selectedMonth = month.value;
        ui.date = "__all";
        ui.entryStatus = "__all";
        st.extraNotice = "";
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
        st.extraNotice = "";
        if (filter === "sort") ui.tableSort = { key: "", dir: "" };
        // Clearing the date drops the two day-based answers, but not the month-wide one.
        if (filter === "date" && ui.date === "__all" && ui.entryStatus !== "extra") {
          ui.entryStatus = "__all";
        }
        if (ui.entryStatus === "extra" && !st.extraEntries) {
          // The entries are this month's daily reports; the overview answers with them, so one
          // read brings both the entries and the figures they have to agree with.
          show(container, st.selectedMonth);
          return;
        }
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
    // Every extra-cleaning button -- open the form, the three per-entry actions, cancel, save --
    // goes straight to assets/js/extra-cleaning.js. This page only says which entry was clicked.
    container.querySelectorAll("[data-wb-extra-action]").forEach(function (button) {
      button.addEventListener("click", function () {
        extras().act(button.getAttribute("data-wb-extra-action"),
          button.getAttribute("data-report-id"), xc, extraContext(container));
      });
    });

    var extraForm = container.querySelector("[data-wb-extra-form]");
    if (extraForm) {
      // The preview and the save button are refreshed in place: a redraw on every keystroke would
      // replace the field being typed in and lose the caret.
      extraForm.addEventListener("input", function (event) {
        if (!event.target.matches("[data-extra-list], [data-extra-remarks], [data-extra-date]")) return;
        extras().refreshPreview(container, xc, extraScope());
      });
      extraForm.addEventListener("change", function (event) {
        if (event.target.matches("[data-extra-plant]")) {
          // A different plant means a different table count to check the numbers against.
          extras().syncForm(container, xc, extraScope());
          render(container);
          return;
        }
        if (!event.target.matches("[data-extra-date], [data-extra-list], [data-extra-remarks]")) return;
        extras().refreshPreview(container, xc, extraScope());
      });
    }

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
    container.querySelectorAll("tr[data-wb-plant]").forEach(function (row) {
      row.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        global.Solar91PortalNav.selectPlantPage(row.getAttribute("data-wb-plant"), "washing");
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
          if (plant.site_code) byCode["$" + plant.site_code] = {
            status: plant.status,
            table_data_by_cycle: plant.table_data_by_cycle || []
          };
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
    loadViewPreference();
    var mine = ++token;
    var prefill = global.Solar91WashingBoardPrefill;
    if (prefill) {
      ui.plant = prefill.plant || "__all";
      ui.complianceCycle = ["all", "1", "2", "3"].indexOf(String(prefill.cycle)) !== -1
        ? String(prefill.cycle) : "auto";
      global.Solar91WashingBoardPrefill = null;
    }
    clearDayActivity();
    var month = selectedMonth || st.selectedMonth || monthKey(new Date());
    st.selectedMonth = month;
    st.month = month;
    st.loading = true;
    st.error = "";
    st.extraEntries = null;
    st.extraNotice = "";
    // Extra cleaning entries ARE the month's daily reports, which this same endpoint answers with.
    // They are asked for only while the filter that lists them is on, so the ordinary board keeps
    // reading scalars only, and `report_days` trims the window to the month actually on screen.
    var wantEntries = ui.entryStatus === "extra";
    var reports = wantEntries
      ? "&include_reports=true&report_days=" + monthSpanDays(month)
      : "&include_reports=false";
    render(container);
    // summary=true: the cards read scalars only, so the per-plant day, cycle and productivity
    // lists — about three quarters of the response — are not asked for.
    return api().request("/api/scheduled/washing/overview?month=" + encodeURIComponent(month) +
      reports + "&summary=true").then(function (body) {
      if (mine !== token) return;                       // a newer page replaced this one
      st.rows = rowsWithUnconfiguredPlants(body);
      st.summary = body.summary || {};
      st.month = body.month || month;
      st.today = body.today || "";
      st.extraEntries = wantEntries ? (body.reports || []).filter(isExtraEntry) : null;
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
