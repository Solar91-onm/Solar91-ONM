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
    // "auto" = the cycle in progress, so the card opens on the cycle being worked on rather than
    // on month-to-date totals. "all" is the Month view; "1"/"2"/"3" pin one cycle.
    entryStatus: "__all", sort: "plant", complianceCycle: "auto", compliancePeriod: "week",
    view: "cards", tableSort: { key: "", dir: "" }, columnFilters: {}
  };
  var dayActivityToken = 0;
  var viewPreferenceUser = null;

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
      '<span class="ep-wb__ring-text"><strong>' +
        (percent === null ? "—" : Number(percent).toFixed(1) + "%") +
        "</strong><small>" + escape(label) + "</small></span>";
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
    if (ui.sort !== "plant") sortByCompliance(rows, ui.sort);
    return rows;
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
        '<button type="button" class="ep-wb__view-toggle" data-wb-view-toggle aria-pressed="' +
          (ui.view === "table" ? "true" : "false") + '" aria-label="Switch to ' +
          (ui.view === "table" ? "cards" : "table") + ' view" title="Switch to ' +
          (ui.view === "table" ? "cards" : "table") + ' view">' +
          (ui.view === "table" ? "Table" : "Cards") + "</button>" +
      '</div></div></div>' +
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
              : "No plants match this search.") + '</div>') +
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
        if (filter === "sort") ui.tableSort = { key: "", dir: "" };
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
