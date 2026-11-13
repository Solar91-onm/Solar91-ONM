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
  var st = { rows: [], month: "", selectedMonth: "", today: "", loading: false, error: "" };
  var ui = { search: "", status: "__all", plant: "__all", cycle: "__all", date: "__all" };

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
    var dates = {};
    st.rows.forEach(function (row) {
      (row.cleaning_dates || []).forEach(function (date) { dates[date] = true; });
    });
    return Object.keys(dates).sort().map(function (date) {
      return '<option value="' + escape(date) + '"' +
        (ui.date === date ? " selected" : "") + ">" + escape(shortDate(date)) + "</option>";
    }).join("");
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

  /** Cycle 1 · 2 · 3: done cycles filled, the one in hand outlined. */
  function pipsHTML(cycle, target) {
    var pips = [];
    for (var number = 1; number <= target; number += 1) {
      var state = number <= cycle.done ? "is-done" : number === cycle.number ? "is-current" : "";
      pips.push('<span class="ep-wb__pip ' + state + '">' + number + "</span>");
    }
    return '<span class="ep-wb__pips" aria-hidden="true">' + pips.join("") + "</span>";
  }

  function cardHTML(row) {
    var cycle = cycleOf(row);
    var status = statusOf(row);
    var target = Number(row.monthly_target) || 3;
    var name = row.plant || row.site_code;
    var late = Number(row.overdue_days) || 0;
    return '<button type="button" class="ep-wb__card ep-wb__card--' + status.key +
      '" data-wb-plant="' + escape(row.site_code) + '" aria-label="Open the Module Cleaning calendar for ' +
      escape(name) + '">' +
      '<span class="ep-wb__head">' +
        '<span class="ep-wb__name">' + escape(name) + "</span>" +
        '<span class="ep-wb__code">' + escape(row.site_code) + "</span>" +
      "</span>" +
      '<span class="ep-wb__date">' + (shortDate(row.last_report_date) || "No records yet") + "</span>" +
      '<span class="ep-wb__body">' +
        '<span class="ep-wb__gauge">' + ringHTML(cycle, status) + "</span>" +
        '<span class="ep-wb__facts">' +
          pipsHTML(cycle, target) +
          '<span class="ep-wb__tables">' + (cycle.total
            ? cycle.confirmed + " of " + cycle.total + " tables"
            : "No tables configured") + "</span>" +
          '<span class="ep-wb__note">' + escape(cleanedLine(cycle)) + "</span>" +
        "</span>" +
      "</span>" +
      '<span class="ep-wb__foot">' +
        '<span class="ep-wb__pill ep-wb__pill--' + status.key + '">' + escape(status.label) +
          (late > 0 ? " · " + late + "d" : "") + "</span>" +
        '<span class="ep-wb__assignee">' + escape(row.assignee_name || "Unassigned") + "</span>" +
      "</span>" +
      "</button>";
  }

  // ─── Page ────────────────────────────────────────────────────────────
  function visibleRows() {
    var term = ui.search.trim().toLowerCase();
    return st.rows.filter(function (row) {
      if (ui.status !== "__all" && statusOf(row).key !== ui.status) return false;
      if (ui.plant !== "__all" && row.site_code !== ui.plant) return false;
      if (ui.cycle !== "__all" &&
          (row.cleaned_cycles || []).indexOf(Number(ui.cycle)) === -1) return false;
      if (ui.date !== "__all" && (row.cleaning_dates || []).indexOf(ui.date) === -1) return false;
      if (!term) return true;
      return [row.plant, row.site_code, row.district, row.assignee_name]
        .join(" ").toLowerCase().indexOf(term) !== -1;
    });
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
      '<div class="ep-pt__head"><h1 class="ep-pt__title">Module Cleaning</h1>' +
        '<p class="ep-pt__sub">' + st.rows.length + " plants · " + escape(st.month) +
        " · open a plant for its cleaning calendar</p></div>" +
      '<div class="ep-wb__tallies">' + countsHTML() + "</div>" +
      '<div class="ep-pt__toolbar"><label class="ep-wb__month"><span>Month</span>' +
        '<input type="month" data-wb-month value="' + escape(st.selectedMonth) +
        '" max="' + escape(monthKey(new Date())) + '" aria-label="Select Module Cleaning month" /></label>' +
        '<div class="ep-pt__search">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>' +
        '<input type="text" placeholder="Search plant, code, district, assignee..." data-wb-search value="' +
        escape(ui.search) + '" autocomplete="off" /></div></div>' +
      '<div class="ep-wb__filters" aria-label="Filter Module Cleaning plants">' +
        '<label><span>Plant</span><select data-wb-filter="plant" aria-label="Filter by plant">' +
          '<option value="__all">All plants</option>' + plantOptions() + '</select></label>' +
        '<label><span>Cycle</span><select data-wb-filter="cycle" aria-label="Filter by cleaning cycle">' +
          '<option value="__all">All cycles</option>' + cycleOptions() + '</select></label>' +
        '<label><span>Cleaning date</span><select data-wb-filter="date" aria-label="Filter by cleaning date">' +
          '<option value="__all">All dates with tables cleaned</option>' + dateOptions() + '</select></label>' +
      '</div>' +
      (st.loading
        ? '<div class="ep-pt__loading" role="status">Loading Module Cleaning…</div>'
        : st.error
          ? '<div class="ep-pt__error" role="alert">Module Cleaning could not be loaded. ' +
            escape(st.error) + ' <button type="button" data-wb-retry>Try again</button></div>'
          : rows.length
        ? '<div class="ep-wb__grid">' + rows.map(cardHTML).join("") + "</div>"
        : '<div class="ep-pt__empty-card">No plants match this search.</div>') +
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
        show(container, st.selectedMonth);
      });
    }
    var retry = container.querySelector("[data-wb-retry]");
    if (retry) retry.addEventListener("click", function () { show(container, st.selectedMonth); });
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
        ui[select.getAttribute("data-wb-filter")] = select.value;
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

  function show(container, selectedMonth) {
    if (!container) return;
    var mine = ++token;
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
      st.month = body.month || month;
      st.today = body.today || "";
      st.loading = false;
      if (container.isConnected) render(container);
    }).catch(function (error) {
      if (mine !== token) return;
      st.loading = false;
      st.error = (error && error.message) ? error.message : "Please retry.";
      if (container.isConnected) render(container);
    });
  }

  global.Solar91PortalWashingBoard = { show: show };
}(window));
