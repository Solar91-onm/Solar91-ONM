(function (global) {
  "use strict";

  var data = global.Solar91PortalData;
  var state = {
    host: null,
    siteCode: null,
    // Cycle-plan state per plant (migration 049). A plant with no plan is PAUSED: it generates no
    // new PM cycles, and it is never shown as failing or as 0%. Fetched once per visit and handed
    // to the tracker on a plant's page so it does not ask for the same listing twice.
    cyclePlans: null,
    // "all" | "planned" | "paused". This is the index page for every plant's PM, so it opens on
    // "all"; a two-way paused toggle left no way to ask for the planned plants and, once on, read
    // as though the portfolio had emptied.
    planFilter: "all",
    plant: null,
    parent: "overview",
    month: "",
    rows: [],
    entries: [],
    loading: false,
    calendarLoading: false,
    error: "",
    calendarError: "",
    truncated: false,
    limit: null,
    requestId: 0,
    // The portfolio opens on the register TABLE unless this person has chosen Cards before. The
    // table is the denser, scannable view and the one an O&M Head reads a 42-plant portfolio in.
    layout: "table",
    layoutUser: null,
    // Which months hold PM work at all, from the calendar endpoint's own index. Used to open on a
    // month that has something in it and to bound the month picker.
    months: null,
    // Set once the landing month has been settled (or the person has picked one), so the page never
    // argues with a chosen month.
    monthSettled: false,
    // The bottom register: "all" | "upcoming" | "overdue" | "completed", plus its own sort and the
    // shared searchable column filters.
    activityFilter: "all",
    activitySort: { key: "due", dir: "asc" },
    activityColumnFilters: {},
    registerSort: { key: "", dir: "asc" },
    filters: {
      query: "",
      plant: "",
      equipment: "",
      status: "all",
      sort: "urgency",
      dateFrom: "",
      dateTo: ""
    }
  };
  var wiredHosts = new WeakSet();

  /**
   * PM STATUS BANDS — the ONE place these thresholds live.
   *
   * Change a number here and every status pill, completion bar and band colour on the PM pages
   * follows it. 85% is the compliance threshold the portal already uses elsewhere
   * (Solar91PortalData.BUSINESS_RULES.washing.defaultComplianceThresholdPercent); the two are kept
   * the same deliberately.
   *
   *   Completed    all of this month's due work done, nothing overdue
   *   On Track     no overdue work and completion at or above 85%, or exactly one overdue item
   *   Attention    two or three overdue items, or completion below 85%
   *   Overdue      four or more overdue items, or completion below 70%
   *   Not Started  the plant has a cycle plan but no work generated for this month yet
   *   Paused       the plant has no cycle plan at all
   */
  var PM_STATUS_RULES = Object.freeze({
    onTrackCompletionPercent: 85,   // at or above this: On Track
    overdueCompletionPercent: 70,   // below this: Overdue, however few items are late
    onTrackOverdueItems: 1,         // one late item is still On Track
    attentionOverdueItems: 3        // two or three: Attention Required. Four or more: Overdue
  });

  /** Worst first. A paused plant is never given a place in this order. */
  var PM_STATUS_ORDER = ["Overdue", "Attention Required", "On Track", "Completed", "Not Started"];

  /** How far ahead the month picker always reaches, whatever has been generated. PM is forward-looking
   *  work: a cycle plan takes effect from the next cycle, so the month it first runs in must be
   *  selectable. Widened further when work exists beyond it — see monthMax(). */
  var MONTH_HORIZON_AHEAD = 12;

  function escape(value) {
    return global.Solar91PortalFormat.escape(value == null ? "" : String(value));
  }

  function number(value) {
    return new Intl.NumberFormat("en-IN").format(Number(value) || 0);
  }

  function businessToday() {
    var parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    var values = {};
    parts.forEach(function (part) {
      if (part.type !== "literal") values[part.type] = part.value;
    });
    return values.year + "-" + values.month + "-" + values.day;
  }

  function monthBounds(month) {
    var parts = month.split("-");
    var year = Number(parts[0]);
    var monthNo = Number(parts[1]);
    var lastDay = new Date(year, monthNo, 0).getDate();
    return {
      start: month + "-01",
      end: month + "-" + String(lastDay).padStart(2, "0")
    };
  }

  /** `month` shifted by `delta` months, as YYYY-MM. */
  function addMonths(month, delta) {
    var year = Number(month.slice(0, 4));
    var mon = Number(month.slice(5, 7)) + delta;
    year += Math.floor((mon - 1) / 12);
    mon = ((mon - 1) % 12) + 1;
    return year + "-" + (mon < 10 ? "0" + mon : String(mon));
  }

  /** The months that hold PM work, earliest first, from the calendar endpoint's own index. */
  function workMonths() {
    return (state.months || []).filter(function (item) {
      return item && /^\d{4}-\d{2}$/.test(item.month) && Number(item.count) > 0;
    }).map(function (item) { return item.month; }).sort();
  }

  /**
   * The furthest month the picker allows: a fixed horizon ahead of the business month, widened to
   * the furthest month that actually has work so a plan loaded for a later year is still reachable.
   * Capping the picker at the present month hid the loaded December plans entirely and made the
   * whole page read as empty.
   */
  function monthMax() {
    var horizon = addMonths(businessToday().slice(0, 7), MONTH_HORIZON_AHEAD);
    var months = workMonths();
    var furthest = months.length ? months[months.length - 1] : "";
    return furthest > horizon ? furthest : horizon;
  }

  /** True when the month index has arrived and says no month in range holds any PM work. */
  function noWorkAnywhere() {
    return !!state.months && !workMonths().length;
  }

  /** The month in the index nearest to `month`, preferring the future on a tie: PM looks forward. */
  function nearestWorkMonth(month) {
    var months = workMonths();
    if (!months.length) return "";
    if (months.indexOf(month) !== -1) return month;
    var best = "";
    var bestDistance = Infinity;
    months.forEach(function (candidate) {
      var distance = Math.abs(monthIndex(candidate) - monthIndex(month));
      var ahead = candidate > month;
      if (distance < bestDistance || (distance === bestDistance && ahead && best < month)) {
        best = candidate;
        bestDistance = distance;
      }
    });
    return best;
  }

  function monthIndex(month) {
    return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
  }

  /** True when the selected month has not started yet: nothing is measurable in it. */
  function futureMonth(month) {
    return monthBounds(month || state.month).start > businessToday();
  }

  /** True when the From/To filters are narrower than the whole selected month. */
  function narrowedDates() {
    var bounds = monthBounds(state.month);
    return !!((state.filters.dateFrom && state.filters.dateFrom > bounds.start) ||
              (state.filters.dateTo && state.filters.dateTo < bounds.end));
  }

  /**
   * Rows for a month that has not started yet.
   *
   * Compliance is measured against work that was due, so a future month has nothing to measure and
   * the portfolio API refuses a future range outright ("End date cannot be in the future"). The
   * register is still "PM status by plant", so every plant in scope is listed with its planned or
   * paused state and whatever is already scheduled; the figures read "—" rather than 0%.
   */
  function plannedRows() {
    var list = state.cyclePlans;
    if (!list || !list.plans) return [];
    return list.plans.map(function (p) {
      return {
        plant: { siteCode: p.site_code, plantName: p.plant, displayName: p.plant, status: "active" },
        profile: { pm: { compliancePercent: null, completed: null, pending: null, overdue: null } }
      };
    });
  }

  /** True when something is narrowing the plant register, so a way out can be offered. */
  function filtersNarrowing() {
    return !!(state.filters.query.trim() || state.filters.plant || state.filters.equipment ||
              (state.filters.status && state.filters.status !== "all") ||
              state.planFilter !== "all" || narrowedDates());
  }

  /** Put every filter back to "everything in this month", the state the page opens in. */
  function clearFilters() {
    var bounds = monthBounds(state.month);
    state.filters.query = "";
    state.filters.plant = "";
    state.filters.equipment = "";
    state.filters.status = "all";
    state.filters.dateFrom = bounds.start;
    state.filters.dateTo = bounds.end;
    state.planFilter = "all";
  }

  function periodRange(month) {
    var bounds = monthBounds(month);
    var today = businessToday();
    return {
      start: bounds.start,
      end: bounds.end > today ? today : bounds.end
    };
  }

  function monthLabel(month) {
    var parts = month.split("-");
    return new Intl.DateTimeFormat("en-IN", {
      month: "long",
      year: "numeric"
    }).format(new Date(Number(parts[0]), Number(parts[1]) - 1, 1));
  }

  function dateLabel(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric"
    }).format(new Date(value.slice(0, 10) + "T12:00:00"));
  }

  /** "21 Nov" - the compact form the side panels use. The year is added only when it is not the
   *  business year, and the cell's <time datetime> always carries the full date. */
  function shortDate(value) {
    if (!value) return "—";
    var parts = { day: "numeric", month: "short" };
    if (value.slice(0, 4) !== businessToday().slice(0, 4)) parts.year = "numeric";
    return new Intl.DateTimeFormat("en-IN", parts).format(new Date(value.slice(0, 10) + "T12:00:00"));
  }

  function withTimeout(promise, requestName) {
    return new Promise(function (resolve, reject) {
      var timer = global.setTimeout(function () {
        reject(new Error(requestName + " timed out. Check your connection and retry."));
      }, 20000);
      promise.then(function (value) {
        global.clearTimeout(timer);
        resolve(value);
      }, function (error) {
        global.clearTimeout(timer);
        reject(error);
      });
    });
  }

  function retryMessage(message, action) {
    return '<div class="ep-pm__error" role="alert">' + escape(message) +
      '<button type="button" data-pm-retry="' + action + '">Retry</button></div>';
  }

  function plantName(plant) {
    return plant && (plant.displayName || plant.plantName || plant.siteCode) || "Plant";
  }

  function activePlant(plant) {
    return !plant.status || String(plant.status).toLowerCase() === "active";
  }

  /** This plant's cycle-plan state, or null while the listing has not arrived (or is forbidden). */
  function planState(siteCode) {
    var list = state.cyclePlans;
    if (!list || !list.plans) return null;
    var key = String(siteCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return list.plans.find(function (p) {
      return String(p.site_code || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === key;
    }) || null;
  }

  function isPaused(siteCode) {
    var plan = planState(siteCode);
    return !!(plan && plan.paused);
  }

  /**
   * "13 of 42 plants planned", with a three-way filter over the register below it.
   *
   * All / Planned / Paused, defaulting to All: the O&M Head opens this page to see every plant's
   * PM, and asking for the planned ones is as ordinary a question as asking for the paused ones.
   */
  function plannedLine() {
    var list = state.cyclePlans;
    if (!list || !list.plans || !list.total) return "";
    var choices = [
      ["all", "All " + number(list.total)],
      ["planned", "Planned " + number(list.configured)],
      ["paused", "Paused " + number(list.paused)]
    ];
    return '<p class="ep-pm__plan-line">' +
      '<strong>' + number(list.configured) + ' of ' + number(list.total) + ' plants planned</strong>' +
      ' · <span class="ep-pm__plan-filter" role="group" aria-label="Show plants by cycle plan">' +
        choices.map(function (choice) {
          return '<button type="button" data-pm-plan-filter="' + choice[0] + '" aria-pressed="' +
            (state.planFilter === choice[0]) + '">' + escape(choice[1]) + '</button>';
        }).join("") +
      '</span>' +
      (state.planFilter === "paused"
        ? ' <span class="ep-pm__plan-note">Showing paused plants only. A paused plant generates no new PM cycles and is left out of PM compliance, never counted as 0%.</span>'
        : state.planFilter === "planned"
          ? ' <span class="ep-pm__plan-note">Showing plants with a cycle plan. Open a plant to see its tracker.</span>'
          : "") +
    '</p>';
  }

  /** The paused state, in the same muted treatment the portal uses for "not configured". */
  function pausedTag(siteCode) {
    var plan = planState(siteCode);
    if (!plan || !plan.paused) return "";
    return '<span class="ep-pm__paused-tag">' +
      escape((state.cyclePlans && state.cyclePlans.paused_reason) || "PM paused - no cycle plan") + '</span>';
  }

  function pmBlock(row) {
    return row && row.profile && row.profile.pm || {};
  }

  /** The portal's own PM open-status set, not a second list of status strings. */
  function pmOpenStates() {
    var rules = data && data.BUSINESS_RULES && data.BUSINESS_RULES.pm;
    return (rules && rules.openStates) || ["Scheduled", "In Progress"];
  }

  /** True while a work order is still open. The server already reports an open, past-due record as
   *  "Overdue", so that counts as open too. */
  function openStatus(status) {
    return status === "Overdue" || pmOpenStates().indexOf(status) !== -1;
  }

  /**
   * How one work order reads in the registers: "upcoming", "overdue", "completed" or "cancelled".
   * Upcoming and Overdue are derived from the due date against the business date; the status itself
   * only says whether the work is still open.
   */
  function activityState(entry) {
    if (!openStatus(entry.status)) {
      return entry.status === "Completed" ? "completed" : "cancelled";
    }
    return entry.date < businessToday() ? "overdue" : "upcoming";
  }

  var ACTIVITY_LABELS = { upcoming: "Upcoming", overdue: "Overdue", completed: "Completed", cancelled: "Cancelled" };

  function activityLabel(entry) {
    return ACTIVITY_LABELS[activityState(entry)] || entry.status || "—";
  }

  /** "Inverter-1" — the equipment type with its unit number, as the register shows it. */
  function equipmentLabel(entry) {
    var type = entry.equipmentType || "";
    if (!type) return entry.unitNo ? "Unit-" + entry.unitNo : "Unspecified";
    return entry.unitNo ? type + "-" + entry.unitNo : type;
  }

  function frequencyLabel(entry) {
    return entry.frequency || "Unspecified";
  }

  function assigneeLabel(entry) {
    return entry.assignee || "Unassigned";
  }

  function plantLabel(entry) {
    var name = entryPlantName(entry);
    return entry.plantSiteCode && entry.plantSiteCode !== name ? name + " · " + entry.plantSiteCode : name;
  }

  /** task_name on its own. `title` carries the unit suffix for the calendar's own tooltips. */
  function taskLabel(entry) {
    return entry.taskName || entry.title || "PM task";
  }

  function entryPlantName(entry) {
    return entry.plantName || entry.plantSiteCode || "Plant";
  }

  /** The four chip counts. Cancelled work is excluded, so upcoming + overdue + completed = all. */
  function activityCounts(entries) {
    var counts = { all: 0, upcoming: 0, overdue: 0, completed: 0 };
    entries.forEach(function (entry) {
      var kind = activityState(entry);
      if (kind === "cancelled") return;
      counts.all += 1;
      counts[kind] += 1;
    });
    return counts;
  }

  function countValue(value) {
    return value == null ? 0 : Number(value) || 0;
  }

  /**
   * One plant's PM status for the selected month. Thresholds live in PM_STATUS_RULES and nowhere
   * else. Paused ("no cycle plan") and Not Started ("planned, nothing generated yet") are different
   * states and are never collapsed into one.
   */
  function statusFor(row, entries) {
    if (isPaused(row.plant.siteCode)) return "Paused";
    var scheduled = entries.filter(function (entry) { return entry.status !== "Cancelled"; });
    if (!scheduled.length) return "Not Started";
    var pm = pmBlock(row);
    var percent = pm.compliancePercent == null ? null : Number(pm.compliancePercent);
    var overdue = scheduled.filter(function (entry) { return activityState(entry) === "overdue"; }).length;
    if (overdue > PM_STATUS_RULES.attentionOverdueItems) return "Overdue";
    if (percent != null && percent < PM_STATUS_RULES.overdueCompletionPercent) return "Overdue";
    if (overdue > PM_STATUS_RULES.onTrackOverdueItems) return "Attention Required";
    if (percent != null && percent < PM_STATUS_RULES.onTrackCompletionPercent) return "Attention Required";
    var completed = scheduled.filter(function (entry) { return activityState(entry) === "completed"; }).length;
    var openAndDue = scheduled.filter(function (entry) {
      return activityState(entry) !== "completed" && entry.date <= businessToday();
    }).length;
    // "All of this month's due work done" — not a month whose work is simply all still ahead.
    if (completed && !overdue && !openAndDue) return "Completed";
    return "On Track";
  }

  /** The band a status paints in: the completion bar and the tile stripes share it. */
  function statusBand(status) {
    if (status === "Overdue") return "bad";
    if (status === "Attention Required") return "warn";
    if (status === "Paused" || status === "Not Started") return "muted";
    return "good";
  }

  function complianceBand(percent) {
    if (percent == null) return "muted";
    if (percent < PM_STATUS_RULES.overdueCompletionPercent) return "bad";
    if (percent < PM_STATUS_RULES.onTrackCompletionPercent) return "warn";
    return "good";
  }

  function statusClass(status) {
    return status.toLowerCase().replace(/\s+/g, "-");
  }

  function statusBadge(status) {
    return '<span class="ep-pm__status ep-pm__status--' + escape(statusClass(status)) + '">' +
      escape(status) + '</span>';
  }

  function openEntries(entries) {
    return entries.filter(function (entry) {
      return entry.status !== "Completed" && entry.status !== "Cancelled";
    });
  }

  /**
   * This month's work orders for one plant.
   *
   * Indexed by plant once per response rather than scanned per plant: with 42 plants and a capped
   * month of 4,000 records, the plain scan was 168,000 comparisons for every keystroke in the
   * register's search box. A copy is returned so a caller can sort it in place.
   */
  var entriesIndex = { source: null, byPlant: null };

  function entriesForPlant(siteCode) {
    if (entriesIndex.source !== state.entries) {
      var byPlant = Object.create(null);
      state.entries.forEach(function (entry) {
        var key = entry.plantSiteCode;
        if (!byPlant[key]) byPlant[key] = [];
        byPlant[key].push(entry);
      });
      entriesIndex = { source: state.entries, byPlant: byPlant };
    }
    return (entriesIndex.byPlant[siteCode] || []).slice();
  }

  function entriesInDateFilter(entries) {
    return entries.filter(function (entry) {
      return (!state.filters.dateFrom || entry.date >= state.filters.dateFrom) &&
        (!state.filters.dateTo || entry.date <= state.filters.dateTo);
    });
  }

  function categoryName(entry) {
    return entry.equipmentType || "Unspecified equipment";
  }

  function plantOptions(rows, selected) {
    return '<option value="">All active plants</option>' + rows.map(function (row) {
      return '<option value="' + escape(row.plant.siteCode) + '"' +
        (row.plant.siteCode === selected ? " selected" : "") + '>' +
        escape(plantName(row.plant)) + " · " + escape(row.plant.siteCode) + '</option>';
    }).join("");
  }

  function rowEntries(row) {
    return entriesInDateFilter(entriesForPlant(row.plant.siteCode));
  }

  /** Every plant this page is about: active plants, narrowed by the header's plant scope selector.
   *  The All / Planned / Paused chips narrow the plant register only, not the whole page. */
  function scopedRows() {
    return state.rows.filter(function (row) {
      if (!state.siteCode && !activePlant(row.plant)) return false;
      if (state.filters.plant && row.plant.siteCode !== state.filters.plant) return false;
      return true;
    });
  }

  /** The period's PM work orders for the plants in scope. Cancelled work is excluded everywhere, so
   *  the chip counts always add up to the All count. */
  function activityRows() {
    return monthEntries(scopedRows()).filter(function (entry) { return entry.status !== "Cancelled"; });
  }

  /** True when every plant in scope is paused, so the page can say so rather than show empty tiles. */
  function allScopePaused() {
    var rows = scopedRows();
    return !!rows.length && !!state.cyclePlans && rows.every(function (row) {
      return isPaused(row.plant.siteCode);
    });
  }

  function filteredRows() {
    var query = state.filters.query.trim().toLowerCase();
    var rows = state.rows.filter(function (row) {
      var plant = row.plant;
      if (!state.siteCode && !activePlant(plant)) return false;
      if (state.planFilter === "paused" && !isPaused(plant.siteCode)) return false;
      if (state.planFilter === "planned" && isPaused(plant.siteCode)) return false;
      if (state.filters.plant && plant.siteCode !== state.filters.plant) return false;
      var entries = rowEntries(row);
      if (state.filters.equipment &&
          !entries.some(function (entry) { return categoryName(entry) === state.filters.equipment; })) {
        return false;
      }
      if (state.filters.status !== "all" &&
          statusFor(row, entriesForPlant(plant.siteCode)) !== state.filters.status) return false;
      // "PM status by plant": a plant with no work orders in the period is still a plant. The date
      // filters are pre-filled with the whole month, so dropping those plants hid the ENTIRE
      // portfolio in any month where PM had not been generated yet. Only an explicit narrowing
      // inside the month filters plants out.
      if (narrowedDates() && !entries.length) return false;
      if (query) {
        var text = [
          plantName(plant), plant.siteCode, plant.location,
          entries.map(function (entry) {
            return [entry.title, entry.reference, entry.equipmentType, entry.assignee].join(" ");
          }).join(" ")
        ].join(" ").toLowerCase();
        if (text.indexOf(query) === -1) return false;
      }
      return true;
    });

    rows.sort(function (a, b) {
      // A paused plant has no cycle plan, so it has no performance to rank. It always sits after the
      // planned plants and is never shown as the worst in the portfolio.
      var aPaused = isPaused(a.plant.siteCode);
      var bPaused = isPaused(b.plant.siteCode);
      if (aPaused !== bPaused) return aPaused ? 1 : -1;
      if (state.filters.sort === "name") {
        return plantName(a.plant).localeCompare(plantName(b.plant));
      }
      if (state.filters.sort === "compliance") {
        var aPct = pmBlock(a).compliancePercent;
        var bPct = pmBlock(b).compliancePercent;
        return (aPct == null ? 101 : Number(aPct)) - (bPct == null ? 101 : Number(bPct));
      }
      if (state.filters.sort === "overdue") {
        return countValue(pmBlock(b).overdue) - countValue(pmBlock(a).overdue) ||
          plantName(a.plant).localeCompare(plantName(b.plant));
      }
      return countValue(pmBlock(b).overdue) - countValue(pmBlock(a).overdue) ||
        (pmBlock(a).compliancePercent == null ? 101 : Number(pmBlock(a).compliancePercent)) -
        (pmBlock(b).compliancePercent == null ? 101 : Number(pmBlock(b).compliancePercent)) ||
        plantName(a.plant).localeCompare(plantName(b.plant));
    });
    return rows;
  }

  function aggregate(rows) {
    if (data && typeof data.aggregatePortfolio === "function") {
      // aggregatePortfolio returns the totals object itself (the Dashboard uses it the same way).
      return data.aggregatePortfolio(rows);
    }
    return rows.reduce(function (total, row) {
      var pm = pmBlock(row);
      total.pmCompleted += countValue(pm.completed);
      total.pmPending += countValue(pm.pending);
      total.pmOverdue += countValue(pm.overdue);
      return total;
    }, { pmCompleted: 0, pmPending: 0, pmOverdue: 0, pmCompliancePercent: null });
  }

  function monthEntries(rows) {
    var codes = Object.create(null);
    rows.forEach(function (row) { codes[row.plant.siteCode] = true; });
    return state.entries.filter(function (entry) {
      return codes[entry.plantSiteCode] === true &&
        (!state.filters.dateFrom || entry.date >= state.filters.dateFrom) &&
        (!state.filters.dateTo || entry.date <= state.filters.dateTo);
    });
  }

  var METRIC_ICONS = {
    compliance: '<circle cx="12" cy="12" r="9"></circle><path d="m8 12.5 2.6 2.6L16 9.6"></path>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"></rect>' +
      '<path d="M8 3v3M16 3v3M3.5 10h17"></path>',
    done: '<path d="M4 12.8l4.8 4.8L20 6.4"></path>',
    alert: '<path d="M12 4.2 2.8 20h18.4L12 4.2Z"></path><path d="M12 10v4.4M12 17.2v.6"></path>'
  };

  function metricIcon(name) {
    return '<span class="ep-pm__metric-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      (METRIC_ICONS[name] || "") + '</svg></span>';
  }

  function metric(label, value, note, modifier, icon, footer) {
    return '<article class="ep-pm__metric' + (modifier ? " ep-pm__metric--" + modifier : "") + '">' +
      (icon ? metricIcon(icon) : "") +
      '<span class="ep-pm__metric-body">' +
        '<span class="ep-pm__metric-label">' + escape(label) + '</span>' +
        '<strong class="ep-pm__metric-value">' + escape(value) + '</strong>' +
        '<span class="ep-pm__metric-note">' + escape(note) + '</span>' +
        (footer || "") +
      '</span></article>';
  }

  /**
   * The four portfolio tiles.
   *
   * Compliance is the portal's established "due work completed to date" figure from the range API,
   * with PAUSED PLANTS LEFT OUT OF THE DENOMINATOR: a plant with no cycle plan has not failed, and
   * counting it as zero is the bug the Module Cleaning tile had. The other three count this
   * period's own PM records, so they agree with the registers below them.
   */
  function summaryMetrics(rows) {
    var planned = rows.filter(function (row) { return !isPaused(row.plant.siteCode); });
    var totals = aggregate(planned);
    var entries = activityRows();
    var counts = activityCounts(entries);
    var compliance = totals.pmCompliancePercent == null
      ? null : Math.round(Number(totals.pmCompliancePercent));
    var completedPlants = {};
    entries.forEach(function (entry) {
      if (activityState(entry) === "completed") completedPlants[entry.plantSiteCode] = true;
    });
    var plantCount = Object.keys(completedPlants).length;
    var loading = state.calendarLoading ? "Loading…" : "";
    return '<div class="ep-pm__metrics">' +
      metric("PM compliance", compliance == null ? "—" : compliance + "%",
        compliance == null ? "No due work to measure yet" : "Due work completed to date",
        "green", "compliance",
        '<span class="ep-pm__progress ep-pm__metric-bar"><span class="is-' +
          escape(complianceBand(compliance)) + '" style="width:' +
          (compliance == null ? 0 : Math.max(0, Math.min(100, compliance))) + '%"></span></span>') +
      metric("Scheduled activities", loading || number(counts.all),
        loading ? "Reading this period’s schedule"
          : number(counts.completed) + " of " + number(counts.all) + " activities",
        "blue", "calendar") +
      metric("Completed", loading || number(counts.completed),
        loading ? "Reading this period’s schedule"
          : "Across " + number(plantCount) + (plantCount === 1 ? " plant" : " plants"),
        "green", "done") +
      metric("Overdue", loading || number(counts.overdue), "Needs attention", "red", "alert") +
    '</div>';
  }

  // -- Left panel: plant-wise PM status --------------------------------------

  /**
   * One register row. Completed / Scheduled and Overdue count THIS PERIOD'S generated work, so they
   * match the activity register below. PM completion is the plant's own compliance figure - the
   * share of work that was DUE and got done - which is why the two can differ in a month with work
   * still ahead of it. A paused plant reports none of them: its counts are unknown, not zero.
   */
  function registerItem(row) {
    var code = row.plant.siteCode;
    var paused = isPaused(code);
    var pm = pmBlock(row);
    var entries = entriesInDateFilter(entriesForPlant(code)).filter(function (entry) {
      return entry.status !== "Cancelled";
    });
    var next = entries.filter(function (entry) {
      return activityState(entry) !== "completed";
    }).sort(function (a, b) { return a.date.localeCompare(b.date); })[0] || null;
    return {
      row: row,
      plant: row.plant,
      paused: paused,
      counts: activityCounts(entries),
      completion: paused || pm.compliancePercent == null ? null : Math.round(Number(pm.compliancePercent)),
      next: next,
      status: statusFor(row, entriesForPlant(code))
    };
  }

  var REGISTER_COLUMNS = [
    { key: "plant", label: "Plant", sort: function (item) { return plantName(item.plant); } },
    { key: "completion", label: "PM completion", align: "num",
      sort: function (item) { return item.completion; } },
    { key: "progress", label: "Completed / Scheduled", align: "num",
      sort: function (item) { return item.paused ? null : item.counts.completed; } },
    { key: "overdue", label: "Overdue", align: "num",
      sort: function (item) { return item.paused ? null : item.counts.overdue; } },
    { key: "next", label: "Next due", sort: function (item) { return item.next ? item.next.date : null; } },
    { key: "status", label: "Status",
      sort: function (item) { return item.paused ? null : PM_STATUS_ORDER.indexOf(item.status); } },
    { key: "open", label: "" }
  ];

  /** The register's own order: the urgency order filteredRows() applies, until a column is clicked.
   *  A paused plant's figures are blank, and table-sort sinks blanks either way, so Paused never
   *  rises to the top of a "worst first" sort. */
  function registerItems(rows) {
    var items = rows.map(registerItem);
    var sorter = global.Solar91PortalSort;
    if (sorter && state.registerSort.key) return sorter.apply(items, state.registerSort, REGISTER_COLUMNS);
    return items;
  }

  function completionCell(item) {
    if (item.completion == null) {
      return '<span class="ep-pm__completion"><span class="ep-pm__progress"><span class="is-muted" ' +
        'style="width:0%"></span></span><b>—</b></span>';
    }
    return '<span class="ep-pm__completion"><span class="ep-pm__progress"><span class="is-' +
      escape(statusBand(item.status)) + '" style="width:' +
      Math.max(0, Math.min(100, item.completion)) + '%"></span></span><b>' +
      item.completion + '%</b></span>';
  }

  function registerHeader() {
    var sorter = global.Solar91PortalSort;
    if (sorter) return sorter.headerHTML(REGISTER_COLUMNS, state.registerSort, "data-pm-register-sort");
    return REGISTER_COLUMNS.map(function (column) {
      return '<th' + (column.align === "num" ? ' class="num"' : "") + '>' + escape(column.label) + '</th>';
    }).join("");
  }

  function registerTable(rows) {
    var items = registerItems(rows);
    return '<div class="ep-pm__table-wrap"><table class="ep-pm__table ep-pm__register-table">' +
      '<thead><tr>' + registerHeader() + '</tr></thead><tbody>' +
      (items.length ? items.map(function (item) {
        return '<tr><td><strong>' + escape(plantName(item.plant)) + '</strong><small>' +
          escape(item.plant.siteCode) + '</small></td>' +
          '<td class="num">' + completionCell(item) + '</td>' +
          '<td class="num">' + (item.paused ? "—"
            : number(item.counts.completed) + ' / ' + number(item.counts.all)) + '</td>' +
          '<td class="num">' + (item.paused ? "—" : number(item.counts.overdue)) + '</td>' +
          '<td>' + (item.next ? escape(dateLabel(item.next.date)) : "—") + '</td>' +
          '<td>' + statusBadge(item.status) + '</td>' +
          '<td class="ep-pm__row-open"><button type="button" class="ep-pm__chevron" ' +
            'data-pm-open-plant="' + escape(item.plant.siteCode) + '" title="Open this plant’s PM page" ' +
            'aria-label="Open ' + escape(plantName(item.plant)) + ' PM page">' +
            '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" ' +
            'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="m6 3.5 5 4.5-5 4.5"></path></svg></button></td></tr>';
      }).join("") : '<tr><td colspan="' + REGISTER_COLUMNS.length + '" class="ep-pm__empty-cell">' +
        'No plants match these filters. ' +
        '<button type="button" class="ep-pm__clear-filters" data-pm-clear-filters>Clear filters</button>' +
        '</td></tr>') +
      '</tbody></table></div>';
  }

  // -- Right panel: upcoming maintenance -------------------------------------

  /** The next handful of due or overdue work orders across the plants in scope, soonest first. */
  function upcomingRows(limit) {
    return activityRows().filter(function (entry) {
      return activityState(entry) !== "completed";
    }).sort(function (a, b) {
      return a.date.localeCompare(b.date) || taskLabel(a).localeCompare(taskLabel(b));
    }).slice(0, limit || 6);
  }

  function upcomingPanel() {
    if (state.calendarLoading) {
      return '<p class="ep-pm__empty-copy" role="status">Loading scheduled PM work…</p>';
    }
    if (state.calendarError) {
      return '<p class="ep-pm__empty-copy">Scheduled PM work is unavailable. Use Retry above to try again.</p>';
    }
    var items = upcomingRows(6);
    if (!items.length) {
      return '<p class="ep-pm__empty-copy">No PM work is due or overdue in ' +
        escape(monthLabel(state.month)) + '.</p>';
    }
    return '<div class="ep-pm__table-wrap"><table class="ep-pm__table ep-pm__upcoming-table">' +
      '<thead><tr><th>Date</th><th>Task</th><th>Plant</th><th>Status</th></tr></thead>' +
      '<tbody>' + items.map(function (entry) {
        return '<tr><td><time datetime="' + escape(entry.date) + '">' + escape(shortDate(entry.date)) +
          '</time></td><td><button type="button" class="ep-pm__task-open" data-pm-open-event="' +
          escape(entry.id) + '" data-pm-event-date="' + escape(entry.date) + '">' +
          escape(taskLabel(entry)) + '</button></td><td>' + escape(entryPlantName(entry)) +
          '</td><td>' + statusBadge(activityLabel(entry)) + '</td></tr>';
      }).join("") + '</tbody></table></div>';
  }

  function plantCard(row) {
    var plant = row.plant;
    var item = registerItem(row);
    var entries = entriesForPlant(plant.siteCode).filter(function (entry) {
      return entry.status !== "Cancelled";
    });
    var displayEntries = entriesInDateFilter(entries);
    var pm = pmBlock(row);
    var status = statusFor(row, entries);
    var next = openEntries(entries).filter(function (entry) {
      return entry.date >= businessToday();
    }).sort(function (a, b) { return a.date.localeCompare(b.date); })[0];
    var recent = entries.filter(function (entry) {
      return entry.status === "Completed" && entry.completedOn;
    }).sort(function (a, b) { return b.completedOn.localeCompare(a.completedOn); })[0];
    var categories = {};
    displayEntries.forEach(function (entry) {
      var name = categoryName(entry);
      categories[name] = (categories[name] || 0) + 1;
    });
    var topCategories = Object.keys(categories).sort(function (a, b) {
      return categories[b] - categories[a] || a.localeCompare(b);
    }).slice(0, 4);
    var nextDue = state.calendarLoading ? "Loading schedule…" :
      state.calendarError ? "Schedule unavailable" : next ? dateLabel(next.date) : "No upcoming PM this month";
    var cardPaused = isPaused(plant.siteCode);
    return '<article class="ep-pm__plant-card' + (cardPaused ? " is-paused" : "") + '">' +
      '<div class="ep-pm__plant-card-head"><div><p>' + escape(plant.siteCode) + '</p>' +
        '<h3>' + escape(plantName(plant)) + '</h3>' + pausedTag(plant.siteCode) + '</div>' +
        (cardPaused ? '<span class="ep-pm__paused-badge">Paused</span>' : statusBadge(status)) + '</div>' +
      '<div class="ep-pm__plant-card-stats"><div><span>Compliance</span><strong>' +
        (cardPaused || pm.compliancePercent == null ? "—" : Math.round(Number(pm.compliancePercent)) + "%") +
        '</strong></div><div><span>Completed</span><strong>' +
        (cardPaused ? "\u2014" : number(item.counts.completed) + " / " + number(item.counts.all)) +
        '</strong></div><div><span>Overdue</span><strong>' +
        (cardPaused ? "\u2014" : number(item.counts.overdue)) + '</strong></div></div>' +
      '<div class="ep-pm__plant-card-meta"><span>Next due</span><strong>' +
        escape(nextDue) +
        '</strong><span>Last completed</span><strong>' +
        (recent ? escape(dateLabel(recent.completedOn)) : "No completed PM this month") + '</strong></div>' +
      '<div class="ep-pm__plant-categories">' +
        (state.calendarLoading
          ? '<span>Loading schedule…</span>'
          : state.calendarError
            ? '<span>Schedule unavailable</span>'
            : topCategories.length
          ? topCategories.map(function (name) {
            return '<span>' + escape(name) + ' <b>' + number(categories[name]) + '</b></span>';
          }).join("")
          : '<span>No equipment categories this month</span>') +
        (Object.keys(categories).length > 4
          ? '<span class="ep-pm__more-categories">+' + (Object.keys(categories).length - 4) + ' more on plant page</span>'
          : "") +
      '</div>' +
      '<button class="ep-pm__open-plant" type="button" data-pm-open-plant="' +
        escape(plant.siteCode) + '">Open plant PM <span aria-hidden="true">→</span></button>' +
    '</article>';
  }

  // -- Bottom register: all scheduled PM activities --------------------------

  var ACTIVITY_CHIPS = [
    ["all", "All"], ["upcoming", "Upcoming"], ["overdue", "Overdue"], ["completed", "Completed"]
  ];

  /** Worst first, so an ascending Status sort puts the late work at the top. */
  var ACTIVITY_STATE_ORDER = ["overdue", "upcoming", "completed"];

  var COLUMN_FILTER_ATTRIBUTES = {
    toggleKey: "data-pm-col-toggle",
    menuKey: "data-pm-col-menu",
    optionKey: "data-pm-col-option",
    optionValue: "data-pm-col-value",
    search: "data-pm-col-search",
    empty: "data-pm-col-empty"
  };

  var COLUMN_FILTER_CLASSES = {
    header: "ep-pm__th-filtered",
    content: "ep-pm__th-content",
    toggle: "ep-pm__filter-toggle",
    menu: "ep-pm__column-filter-menu",
    search: "ep-pm__column-filter-search",
    options: "ep-pm__column-filter-options",
    option: "ep-pm__column-filter-option",
    empty: "ep-pm__column-filter-empty"
  };

  /**
   * The activity register's columns. `value` is the one reading used for the column filter, the CSV
   * export and (unless `cell` overrides it) the cell itself, so the three can never disagree.
   */
  var ACTIVITY_COLUMNS = [
    { key: "due", label: "Due date", filter: false,
      sort: function (entry) { return entry.date; },
      value: function (entry) { return dateLabel(entry.date); } },
    { key: "plant", label: "Plant", sort: plantLabel, value: plantLabel,
      cell: function (entry) {
        return '<strong>' + escape(entryPlantName(entry)) + '</strong><small>' +
          escape(entry.plantSiteCode || "") + '</small>';
      } },
    { key: "task", label: "Maintenance task", sort: taskLabel, value: taskLabel,
      cell: function (entry) {
        return '<button type="button" class="ep-pm__task-open" data-pm-open-event="' +
          escape(entry.id) + '" data-pm-event-date="' + escape(entry.date) + '">' +
          escape(taskLabel(entry)) + '</button><small>' +
          escape(entry.reference || "No work order reference") + '</small>';
      } },
    { key: "equipment", label: "Equipment / Unit", sort: equipmentLabel, value: equipmentLabel },
    { key: "frequency", label: "Frequency", sort: frequencyLabel, value: frequencyLabel },
    { key: "assignee", label: "Assigned to", sort: assigneeLabel, value: assigneeLabel },
    { key: "status", label: "Status", value: activityLabel,
      sort: function (entry) { return ACTIVITY_STATE_ORDER.indexOf(activityState(entry)); },
      cell: function (entry) { return statusBadge(activityLabel(entry)); } }
  ];

  function activityColumn(key) {
    return ACTIVITY_COLUMNS.filter(function (column) { return column.key === key; })[0] || null;
  }

  /** Every column filter that is set must match. */
  function matchesColumnFilters(entry) {
    return Object.keys(state.activityColumnFilters).every(function (key) {
      var column = activityColumn(key);
      var wanted = state.activityColumnFilters[key];
      return !wanted || !column || column.value(entry) === wanted;
    });
  }

  /** The set the chip counts are taken from, so they always add up to the All count. */
  function activityFiltered() {
    return activityRows().filter(matchesColumnFilters);
  }

  /** What the register actually lists: the chip and the column filters, in the chosen sort order. */
  function activityVisible() {
    var rows = activityFiltered();
    if (state.activityFilter !== "all") {
      rows = rows.filter(function (entry) { return activityState(entry) === state.activityFilter; });
    }
    var sorter = global.Solar91PortalSort;
    if (sorter) return sorter.apply(rows, state.activitySort, ACTIVITY_COLUMNS);
    return rows.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
  }

  /** The options one column offers, read off the whole period so they do not vanish as you filter. */
  function activityOptions(column, source) {
    var seen = Object.create(null);
    (source || activityRows()).forEach(function (entry) {
      var value = column.value(entry);
      if (value) seen[value] = true;
    });
    return Object.keys(seen).sort(function (a, b) { return String(a).localeCompare(String(b)); });
  }

  /** Sortable headings, with the SHARED searchable filter control on the filterable ones. */
  function activityHeader() {
    var sorter = global.Solar91PortalSort;
    var columnFilter = global.Solar91PortalColumnFilter;
    return ACTIVITY_COLUMNS.map(function (column) {
      var header = sorter
        ? sorter.thHTML(column, state.activitySort, "data-pm-activity-sort")
        : '<th>' + escape(column.label) + '</th>';
      if (column.filter === false || !columnFilter) return header;
      return columnFilter.headerHTML(header, {
        key: column.key,
        label: column.label,
        values: activityOptions(column),
        active: state.activityColumnFilters[column.key] || "",
        menuId: "ep-pm-col-" + column.key,
        attributes: COLUMN_FILTER_ATTRIBUTES,
        classes: COLUMN_FILTER_CLASSES,
        focusSearchOnOpen: true,
        keepAllOptionVisible: true
      });
    }).join("");
  }

  function activityChips(counts) {
    return '<div class="ep-pm__chips" role="group" aria-label="Filter PM activities">' +
      ACTIVITY_CHIPS.map(function (chip) {
        return '<button type="button" class="ep-pm__chip" data-pm-activity-filter="' +
          escape(chip[0]) + '" aria-pressed="' + (state.activityFilter === chip[0]) + '">' +
          escape(chip[1]) + ' <b>' + number(counts[chip[0]]) + '</b></button>';
      }).join("") + '</div>';
  }

  function activityBody(rows) {
    var span = ACTIVITY_COLUMNS.length;
    if (state.calendarLoading) {
      return '<tr><td colspan="' + span + '" class="ep-pm__empty-cell">Loading scheduled PM work…</td></tr>';
    }
    if (state.calendarError) {
      return '<tr><td colspan="' + span + '" class="ep-pm__empty-cell">Scheduled PM work is ' +
        'unavailable. Use Retry above.</td></tr>';
    }
    if (!rows.length) {
      return '<tr><td colspan="' + span + '" class="ep-pm__empty-cell">' +
        (state.activityFilter === "all" && !Object.keys(state.activityColumnFilters).length
          ? 'No PM activities fall in ' + escape(monthLabel(state.month)) + '.'
          : 'No PM activities match these filters. ' +
            '<button type="button" class="ep-pm__clear-filters" data-pm-clear-activities>' +
            'Clear activity filters</button>') +
        '</td></tr>';
    }
    return rows.map(function (entry) {
      return '<tr class="ep-pm__task-row">' + ACTIVITY_COLUMNS.map(function (column) {
        return '<td>' + (column.cell ? column.cell(entry) : escape(column.value(entry))) + '</td>';
      }).join("") + '</tr>';
    }).join("");
  }

  function activitySection() {
    var counts = activityCounts(activityFiltered());
    var rows = activityVisible();
    return '<section class="ep-pm__board" data-pm-activities>' +
      '<div class="ep-pm__board-head"><div><p class="ep-pm__eyebrow">Work orders</p>' +
        '<h2>All scheduled PM activities</h2></div><span>' + number(rows.length) + ' shown</span></div>' +
      activityChips(counts) +
      '<div class="ep-pm__table-wrap"><table class="ep-pm__table ep-pm__activity-table">' +
        '<thead><tr>' + activityHeader() + '</tr></thead><tbody>' + activityBody(rows) +
        '</tbody></table></div></section>';
  }

  // -- Export ----------------------------------------------------------------

  function download(filename, mime, text) {
    var blob = new global.Blob(["﻿" + text], { type: mime });
    var url = global.URL.createObjectURL(blob);
    var link = global.document.createElement("a");
    link.href = url;
    link.download = filename;
    global.document.body.appendChild(link);
    link.click();
    global.document.body.removeChild(link);
    global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 0);
  }

  /** The period and the scope, so a downloaded file says what it holds. */
  function exportName() {
    var scope = state.filters.plant ? state.filters.plant : "all-plants";
    return "Solar91_PM_" + state.month + "_" + scope + "_" + state.activityFilter + ".csv";
  }

  /** The activity register exactly as it stands on screen: same filters, same sort, same columns. */
  function exportActivities() {
    var fmt = global.Solar91PortalFormat;
    var guard = fmt && typeof fmt.csvText === "function"
      ? fmt.csvText
      : function (value) { return String(value == null ? "" : value); };
    var table = [ACTIVITY_COLUMNS.map(function (column) { return column.label; })].concat(
      activityVisible().map(function (entry) {
        return ACTIVITY_COLUMNS.map(function (column) { return column.value(entry); });
      }));
    var csv = table.map(function (row) {
      return row.map(function (cell) {
        var text = guard(cell);
        return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
      }).join(",");
    }).join("\r\n");
    download(exportName(), "text/csv;charset=utf-8;", csv);
  }

  // -- Register panel and the page itself ------------------------------------

  /** With no stored choice the portfolio opens on Table. */
  function layoutPreferenceKey() {
    var client = global.Solar91PortalAPI;
    var user = client && typeof client.currentUser === "function" ? client.currentUser() : null;
    var userKey = user && (user.id || user.email) || "unknown";
    return "solar91.pmPortfolioLayout.v1." + encodeURIComponent(userKey);
  }

  function loadLayoutPreference() {
    var key = layoutPreferenceKey();
    if (state.layoutUser === key) return;
    state.layoutUser = key;
    state.layout = "table";
    try {
      if (global.localStorage.getItem(key) === "cards") state.layout = "cards";
    } catch (error) {}
  }

  function saveLayoutPreference() {
    try { global.localStorage.setItem(layoutPreferenceKey(), state.layout); } catch (error) {}
  }

  function registerBody(rows) {
    if (!rows.length) {
      return '<p class="ep-pm__empty">' +
        (filtersNarrowing()
          ? 'No active plants match these filters. ' +
            '<button type="button" class="ep-pm__clear-filters" data-pm-clear-filters>Clear filters</button>'
          : 'No active plants to show for this month.') + '</p>';
    }
    return state.layout === "cards"
      ? '<div class="ep-pm__plants-grid">' + rows.map(plantCard).join("") + '</div>'
      : registerTable(rows);
  }

  /** The badge counts the rows this panel is actually listing - never the whole portfolio. */
  function registerPanel(rows) {
    return '<article class="ep-pm__panel ep-pm__panel--wide"><header><div>' +
      '<p class="ep-pm__eyebrow">Plant register</p><h2>Plant-wise PM status</h2></div>' +
      '<div class="ep-pm__panel-actions"><span>' + number(rows.length) +
        (rows.length === 1 ? ' plant' : ' plants') + '</span>' +
        '<div class="ep-pm__layout-toggle" role="group" aria-label="Plant layout">' +
          '<button type="button" data-pm-layout="table" aria-pressed="' +
            (state.layout === "table") + '">Table</button>' +
          '<button type="button" data-pm-layout="cards" aria-pressed="' +
            (state.layout === "cards") + '">Cards</button></div></div></header>' +
      '<div class="ep-pm__panel-filters"><label class="ep-pm__search">' +
        '<span class="ep-pm__sr-only">Search plants and PM tasks</span>' +
        '<input type="search" data-pm-filter="query" value="' + escape(state.filters.query) +
        '" placeholder="Search plant, equipment, task or assignee" /></label>' +
        (filtersNarrowing()
          ? '<button type="button" class="ep-pm__clear-filters" data-pm-clear-filters>Clear filters</button>'
          : "") +
      '</div><div class="ep-pm__board-content">' + registerBody(rows) + '</div></article>';
  }

  function upcomingPanelCard() {
    return '<article class="ep-pm__panel"><header><div><p class="ep-pm__eyebrow">Next up</p>' +
      '<h2>Upcoming maintenance</h2></div>' +
      '<button type="button" class="ep-pm__view-all" data-pm-view-all>View all</button></header>' +
      upcomingPanel() + '</article>';
  }

  // -- Empty states: on day one most of this page is empty -------------------

  /**
   * No month in range holds any PM work.
   *
   * Said as a NOTICE above the page, not instead of it. Replacing the whole page here used to
   * discard the plant register this page had already built — including the planned / paused state
   * of every plant, which is the one thing that is knowable before any work exists — and it removed
   * every control, so the empty state was also a dead end: the PM calendar, where work is actually
   * generated, could not be reached from it.
   *
   * It names the real next step too. A cycle plan alone generates nothing: it sets out a plant's
   * phases, and the work orders are created from them by the PM calendar's Upload plan.
   */
  function emptyPortfolio() {
    var planned = state.cyclePlans && state.cyclePlans.configured;
    return '<p class="ep-pm__notice" role="status">No PM work orders exist for any plant in your ' +
      'scope, in any month. ' +
      (planned
        ? number(planned) + ' plant' + (planned === 1 ? ' has a cycle plan, which sets out its phases'
            : 's have a cycle plan, which sets out their phases') + ' — the work orders themselves ' +
          'are generated from those plans. '
        : '') +
      'Use <b>Upload plan</b> on the PM calendar, with the cycle start set to the month you are ' +
      'planning. <button type="button" class="ep-pm__inline-button" data-pm-calendar>Open PM calendar</button></p>';
  }

  function scopeNotice() {
    if (!allScopePaused()) return "";
    return '<p class="ep-pm__notice ep-pm__notice--muted" role="status">No plants in this scope have ' +
      'a cycle plan, so none of them generates PM work. Open a plant and set up its cycle plan to ' +
      'start its schedule.</p>';
  }

  function periodNotice() {
    if (state.calendarLoading || state.calendarError || activityRows().length) return "";
    var nearest = nearestWorkMonth(state.month);
    return '<p class="ep-pm__notice" role="status">No PM activities fall in ' +
      escape(monthLabel(state.month)) + '. Use the period selector above to choose another month.' +
      (nearest && nearest !== state.month
        ? ' <button type="button" class="ep-pm__inline-button" data-pm-goto-month="' +
          escape(nearest) + '">Go to ' + escape(monthLabel(nearest)) + '</button>'
        : "") + '</p>';
  }

  function portfolioContent() {
    var rows = filteredRows();
    return '<div class="ep-pm">' +
      '<header class="ep-pm__header"><div><p class="ep-pm__eyebrow">Portfolio view</p>' +
        '<h1>Preventive Maintenance</h1>' +
        '<p>Track scheduled work, overdue activities and upcoming maintenance across all plants.</p>' +
        plannedLine() + '</div>' +
        '<div class="ep-pm__header-actions">' +
          '<label>Period<input type="month" data-pm-month value="' + escape(state.month) +
            '" max="' + monthMax() + '" /></label>' +
          '<label>Plants<select data-pm-filter="plant">' +
            plantOptions(state.rows.filter(function (row) { return activePlant(row.plant); }),
              state.filters.plant) + '</select></label>' +
          '<button type="button" class="ep-pm__primary-button" data-pm-export>Export</button>' +
        '</div></header>' +
      (state.truncated
        ? '<p class="ep-pm__notice" role="status">The server returned the first ' + number(state.limit) +
          ' records for this month. Open a plant to view its own records.</p>' : "") +
      (futureMonth()
        ? '<p class="ep-pm__notice" role="status">' + escape(monthLabel(state.month)) +
          ' has not started yet, so there is nothing due to measure: compliance and completion read ' +
          '— until the month begins. Plants below show their cycle plan state and whatever PM is ' +
          'already scheduled.</p>'
        : "") +
      (state.error ? retryMessage(state.error, "all") : "") +
      (state.calendarError ? retryMessage(state.calendarError, "calendar") : "") +
      (state.loading
        ? '<div class="ep-pm__loading" role="status">Loading PM overview…</div>'
        // "PM status by plant" holds whether or not any work has been generated: the register is
        // the plants, and a plant with no work is still a plant with a plan state. Only the
        // period-specific notice is swapped out when there is no work anywhere, since "choose
        // another month" is no help when no month has any.
        : (noWorkAnywhere() ? emptyPortfolio() : scopeNotice() + periodNotice()) +
          summaryMetrics(rows) +
          '<section class="ep-pm__insights">' + registerPanel(rows) + upcomingPanelCard() +
          '</section>' + activitySection()) +
      '<p class="ep-pm__footnote">Compliance and due counts use the portal’s existing PM rules. ' +
        'Cancelled work is excluded, and a paused plant is never counted as zero.</p>' +
    '</div>';
  }

  // ── A plant's own PM page ───────────────────────────────────────────────────
  //
  // Its sections and the portfolio's are the same components reading the same records: the stat
  // tiles, the status pills, the register table and the shared sort / column-filter controls. What
  // differs is the scope (one plant) and that this page also carries the plant's cycle-plan
  // tracker, which is where its schedule is actually planned.

  /** This plant's work orders for the period, cancelled work excluded. */
  function plantEntries(siteCode) {
    return entriesInDateFilter(entriesForPlant(siteCode)).filter(function (entry) {
      return entry.status !== "Cancelled";
    });
  }

  // ── PM compliance, as a ring meter ─────────────────────────────────────────
  //
  // A single ratio against a limit, so it is a meter rather than a two-slice pie: the fill carries
  // the band (good / warning / critical) and the unfilled track is a lighter step of that same hue,
  // so the state reads across the whole ring rather than from the arc alone. The figure sits in the
  // middle and is the one hero number on the page.

  var METER_TRACK = { good: "#D7EDD9", warn: "#F6E3C8", bad: "#F5D6D3", muted: "#EEF0EE" };
  var METER_FILL = { good: "#009710", warn: "#B4610A", bad: "#B42318", muted: "#C3C2B7" };

  function complianceRing(percent) {
    var band = complianceBand(percent);
    var value = percent == null ? 0 : Math.max(0, Math.min(100, percent));
    var sweep = Math.round(value * 3.6);
    return '<span class="ep-pm__ring" role="img" aria-label="PM compliance ' +
      (percent == null ? "not measurable yet" : value + " percent") + '" style="--ring-fill:' +
      METER_FILL[band] + ';--ring-track:' + METER_TRACK[band] + ';--ring-sweep:' + sweep + 'deg">' +
      '<span class="ep-pm__ring-value">' + (percent == null ? "—" : value + "%") + '</span></span>';
  }

  function plantMetrics(row, entries) {
    var pm = pmBlock(row);
    var paused = isPaused(row.plant.siteCode);
    var counts = activityCounts(entries);
    var percent = paused || pm.compliancePercent == null ? null : Math.round(Number(pm.compliancePercent));
    var open = counts.upcoming + counts.overdue;
    var next = entries.filter(function (entry) {
      return activityState(entry) !== "completed";
    }).sort(function (a, b) { return a.date.localeCompare(b.date); })[0];
    var loading = state.calendarLoading ? "Loading…" : "";
    return '<div class="ep-pm__metrics ep-pm__metrics--plant">' +
      '<article class="ep-pm__metric ep-pm__metric--ring">' + complianceRing(percent) +
        '<span class="ep-pm__metric-body"><span class="ep-pm__metric-label">PM compliance</span>' +
        '<span class="ep-pm__metric-note">' +
          (paused ? "PM paused — no cycle plan"
            : percent == null ? "No due work to measure yet" : "Due work completed to date") +
        '</span></span></article>' +
      metric("Scheduled", loading || (paused ? "—"
        : number(counts.completed) + " / " + number(counts.all)),
        loading ? "Reading this period’s schedule"
          : paused ? "No cycle plan" : number(open) + " still open",
        "blue", "calendar") +
      metric("Overdue", loading || (paused ? "—" : number(counts.overdue)),
        paused ? "No cycle plan" : counts.overdue ? "Needs attention" : "Nothing past due",
        "red", "alert") +
      metric("Next due", loading || (next ? dateLabel(next.date) : "—"),
        loading ? "Checking the schedule"
          : next ? taskLabel(next) : "No open work in this period",
        "green", "done") +
    '</div>';
  }

  // ── Maintenance workload ───────────────────────────────────────────────────
  //
  // One stacked column per day of the selected period. The three segments are the portal's STATUS
  // colours, which are near-indistinguishable to a red-green colourblind reader on hue alone, so
  // they never carry the distinction by themselves: the stacking order is fixed (completed at the
  // bottom, then open, then overdue at the top), a legend names them, a 2px surface gap separates
  // them, and every column's tooltip and accessible name give the three counts in words.

  function workloadPanel(entries) {
    var period = monthBounds(state.month);
    var days = Number(period.end.slice(-2));
    var daily = {};
    entries.forEach(function (entry) {
      var day = Number(entry.date.slice(-2));
      if (!daily[day]) daily[day] = { completed: 0, open: 0, overdue: 0 };
      var kind = activityState(entry);
      if (kind === "completed") daily[day].completed += 1;
      else if (kind === "overdue") daily[day].overdue += 1;
      else daily[day].open += 1;
    });
    var peak = 1;
    Object.keys(daily).forEach(function (day) {
      peak = Math.max(peak, daily[day].completed + daily[day].open + daily[day].overdue);
    });
    var body;
    if (state.calendarLoading) {
      body = '<p class="ep-pm__empty-copy" role="status">Loading scheduled PM work…</p>';
    } else if (state.calendarError) {
      body = '<p class="ep-pm__empty-copy">Scheduled PM work is unavailable. Use Retry above.</p>';
    } else if (!entries.length) {
      body = '<p class="ep-pm__empty-copy">No PM work is scheduled in ' +
        escape(monthLabel(state.month)) + '.</p>';
    } else {
      body = '<div class="ep-pm__workload">' +
        '<div class="ep-pm__workload-legend"><span><i class="is-completed"></i>Completed</span>' +
          '<span><i class="is-open"></i>Open</span><span><i class="is-overdue"></i>Overdue</span>' +
          '<span class="ep-pm__workload-peak">Peak ' + number(peak) +
          (peak === 1 ? ' work order' : ' work orders') + ' a day</span></div>' +
        '<div class="ep-pm__day-bars" role="list">' +
          Array.from({ length: days }, function (_, index) {
            var day = index + 1;
            var counts = daily[day] || { completed: 0, open: 0, overdue: 0 };
            var total = counts.completed + counts.open + counts.overdue;
            var label = dateLabel(state.month + "-" + (day < 10 ? "0" + day : String(day))) + ": " +
              (total
                ? number(counts.completed) + " completed, " + number(counts.open) + " open, " +
                  number(counts.overdue) + " overdue"
                : "nothing scheduled");
            return '<div class="ep-pm__day-bar" role="listitem" title="' + escape(label) +
              '" aria-label="' + escape(label) + '"><div class="ep-pm__bar-track" style="height:' +
              (total ? Math.max(6, Math.round(100 * total / peak)) : 0) + '%">' +
              ["completed", "open", "overdue"].map(function (kind) {
                return counts[kind]
                  ? '<span class="is-' + kind + '" style="flex:' + counts[kind] + '"></span>'
                  : "";
              }).join("") +
              '</div><small>' + (day % 5 === 1 || day === days ? day : "") + '</small></div>';
          }).join("") +
        '</div></div>';
    }
    return '<section class="ep-pm__panel"><header><div><p class="ep-pm__eyebrow">Workload</p>' +
      '<h2>Maintenance workload — ' + escape(monthLabel(state.month)) + '</h2></div>' +
      '<span>' + (state.calendarLoading ? "Loading…" : number(entries.length)) +
      (entries.length === 1 ? ' work order' : ' work orders') + '</span></header>' + body + '</section>';
  }

  // ── Task breakdown ─────────────────────────────────────────────────────────
  //
  // How the period's work splits across maintenance task types. These are IDENTITIES, not states,
  // so they take a categorical ramp kept deliberately clear of the portal's reserved status
  // colours: nothing here should read as "late" or "done". Hues are assigned in fixed slot order
  // and never cycled — a seventh type folds into "Other" rather than inventing a hue no colourblind
  // reader could separate. Three of these slots sit under 3:1 against the page, so the legend
  // carries every name, count and share in text: the colour never has to be read alone.

  var BREAKDOWN_HUES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];
  var BREAKDOWN_OTHER = "#8E9A94";
  var BREAKDOWN_SLOTS = 5;

  function breakdownParts(entries) {
    var totals = {};
    entries.forEach(function (entry) {
      var name = entry.equipmentType || "Unspecified";
      if (!totals[name]) totals[name] = { name: name, total: 0, completed: 0, overdue: 0 };
      totals[name].total += 1;
      var kind = activityState(entry);
      if (kind === "completed") totals[name].completed += 1;
      if (kind === "overdue") totals[name].overdue += 1;
    });
    var parts = Object.keys(totals).map(function (name) { return totals[name]; })
      .sort(function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); });
    if (parts.length > BREAKDOWN_SLOTS + 1) {
      var tail = parts.slice(BREAKDOWN_SLOTS);
      parts = parts.slice(0, BREAKDOWN_SLOTS).concat([{
        name: "Other",
        total: tail.reduce(function (n, part) { return n + part.total; }, 0),
        completed: tail.reduce(function (n, part) { return n + part.completed; }, 0),
        overdue: tail.reduce(function (n, part) { return n + part.overdue; }, 0),
        rest: tail.length
      }]);
    }
    return parts.map(function (part, index) {
      return Object.assign({}, part, {
        hue: part.name === "Other" ? BREAKDOWN_OTHER : BREAKDOWN_HUES[index % BREAKDOWN_HUES.length]
      });
    });
  }

  function breakdownPanel(entries) {
    var body;
    if (state.calendarLoading) {
      body = '<p class="ep-pm__empty-copy" role="status">Loading scheduled PM work…</p>';
    } else if (state.calendarError) {
      body = '<p class="ep-pm__empty-copy">Scheduled PM work is unavailable.</p>';
    } else {
      var parts = breakdownParts(entries);
      var total = parts.reduce(function (n, part) { return n + part.total; }, 0);
      if (!total) {
        body = '<p class="ep-pm__empty-copy">No PM work is scheduled in ' +
          escape(monthLabel(state.month)) + '.</p>';
      } else {
        var at = 0;
        var stops = parts.map(function (part) {
          var from = at;
          at += 360 * part.total / total;
          return part.hue + " " + from.toFixed(2) + "deg " + at.toFixed(2) + "deg";
        }).join(",");
        body = '<div class="ep-pm__breakdown">' +
          '<span class="ep-pm__donut" aria-hidden="true" style="--donut-stops:' + stops + '">' +
            '<span class="ep-pm__donut-centre"><b>' + number(total) + '</b><small>Total</small></span>' +
          '</span>' +
          '<ul class="ep-pm__breakdown-legend">' + parts.map(function (part) {
            var share = Math.round(100 * part.total / total);
            return '<li><i style="background:' + part.hue + '"></i>' +
              '<span class="ep-pm__breakdown-name">' + escape(part.name) +
                (part.rest ? ' <small>(' + part.rest + ' more types)</small>' : "") + '</span>' +
              '<b>' + share + '%</b>' +
              '<small>' + number(part.completed) + ' of ' + number(part.total) + ' done' +
                (part.overdue ? ' · ' + number(part.overdue) + ' overdue' : "") + '</small></li>';
          }).join("") + '</ul></div>';
      }
    }
    return '<article class="ep-pm__panel"><header><div><p class="ep-pm__eyebrow">Equipment</p>' +
      '<h2>Task breakdown</h2></div></header>' + body + '</article>';
  }

  /** The way through to this plant's PM calendar. It lives here, not in the page header. */
  function calendarCard(entries) {
    var counts = activityCounts(entries);
    return '<article class="ep-pm__panel ep-pm__calendar-card"><header><div>' +
      '<p class="ep-pm__eyebrow">Schedule</p><h2>PM calendar</h2></div></header>' +
      '<div class="ep-pm__calendar-card-body">' +
        '<p>See every scheduled day for ' + escape(monthLabel(state.month)) +
          ', how much of each day’s work is done, and open a work order from the day it falls on.</p>' +
        '<p class="ep-pm__calendar-card-counts"><b>' + number(counts.all) + '</b> scheduled · <b>' +
          number(counts.completed) + '</b> done · <b>' + number(counts.overdue) + '</b> overdue</p>' +
        '<button type="button" class="ep-pm__calendar-button" data-pm-calendar>Open PM calendar ' +
          '<span aria-hidden="true">→</span></button>' +
      '</div></article>';
  }

  // ── Recent and upcoming ────────────────────────────────────────────────────

  /** The work either side of today: what was just done and what is next, soonest first. */
  function recentUpcomingPanel(entries) {
    var body;
    if (state.calendarLoading) {
      body = '<p class="ep-pm__empty-copy" role="status">Loading scheduled PM work…</p>';
    } else if (state.calendarError) {
      body = '<p class="ep-pm__empty-copy">Scheduled PM work is unavailable. Use Retry above.</p>';
    } else {
      var today = businessToday();
      var open = entries.filter(function (entry) { return activityState(entry) !== "completed"; })
        .sort(function (a, b) { return a.date.localeCompare(b.date); });
      var done = entries.filter(function (entry) { return activityState(entry) === "completed"; })
        .sort(function (a, b) { return b.date.localeCompare(a.date); });
      // Two most recently completed, then the next three still open (overdue first, being the
      // earliest due). Either half takes the other's room when it is short.
      var recent = done.slice(0, 2).reverse();
      var next = open.slice(0, 5 - recent.length);
      if (next.length < 3) recent = done.slice(0, 5 - next.length).reverse();
      var items = recent.concat(next);
      if (!items.length) {
        body = '<p class="ep-pm__empty-copy">No PM work is scheduled in ' +
          escape(monthLabel(state.month)) + '.</p>';
      } else {
        body = '<div class="ep-pm__table-wrap"><table class="ep-pm__table ep-pm__upcoming-table">' +
          '<thead><tr><th>Task</th><th>Equipment / Unit</th><th>Due date</th><th>Status</th></tr></thead>' +
          '<tbody>' + items.map(function (entry) {
            return '<tr' + (entry.date === today ? ' class="is-today"' : "") + '>' +
              '<td><button type="button" class="ep-pm__task-open" data-pm-open-event="' +
                escape(entry.id) + '" data-pm-event-date="' + escape(entry.date) + '">' +
                escape(taskLabel(entry)) + '</button></td>' +
              '<td>' + escape(equipmentLabel(entry)) + '</td>' +
              '<td><time datetime="' + escape(entry.date) + '">' + escape(dateLabel(entry.date)) +
                '</time></td><td>' + statusBadge(activityLabel(entry)) + '</td></tr>';
          }).join("") + '</tbody></table></div>';
      }
    }
    return '<section class="ep-pm__panel"><header><div><p class="ep-pm__eyebrow">Activity</p>' +
      '<h2>Recent / upcoming tasks</h2></div>' +
      '<button type="button" class="ep-pm__view-all" data-pm-view-all>View all</button></header>' +
      body + '</section>';
  }

  // ── This plant's work-order register ───────────────────────────────────────
  //
  // The portfolio register's columns without the Plant column, which a single plant's page already
  // answers in its title. Same shared sort headings and searchable column filters, same chips.

  function plantColumns() {
    return ACTIVITY_COLUMNS.filter(function (column) { return column.key !== "plant"; });
  }

  function plantRegisterSection(entries) {
    var columns = plantColumns();
    var filtered = entries.filter(matchesColumnFilters);
    var counts = activityCounts(filtered);
    var rows = filtered;
    if (state.activityFilter !== "all") {
      rows = rows.filter(function (entry) { return activityState(entry) === state.activityFilter; });
    }
    var sorter = global.Solar91PortalSort;
    rows = sorter
      ? sorter.apply(rows, state.activitySort, columns)
      : rows.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    var columnFilter = global.Solar91PortalColumnFilter;
    var header = columns.map(function (column) {
      var th = sorter
        ? sorter.thHTML(column, state.activitySort, "data-pm-activity-sort")
        : '<th>' + escape(column.label) + '</th>';
      if (column.filter === false || !columnFilter) return th;
      return columnFilter.headerHTML(th, {
        key: column.key,
        label: column.label,
        values: activityOptions(column, entries),
        active: state.activityColumnFilters[column.key] || "",
        menuId: "ep-pm-col-" + column.key,
        attributes: COLUMN_FILTER_ATTRIBUTES,
        classes: COLUMN_FILTER_CLASSES,
        focusSearchOnOpen: true,
        keepAllOptionVisible: true
      });
    }).join("");
    var body;
    if (state.calendarLoading) {
      body = '<tr><td colspan="' + columns.length + '" class="ep-pm__empty-cell">' +
        'Loading scheduled PM work…</td></tr>';
    } else if (state.calendarError) {
      body = '<tr><td colspan="' + columns.length + '" class="ep-pm__empty-cell">' +
        'Scheduled PM work is unavailable. Use Retry above.</td></tr>';
    } else if (!rows.length) {
      body = '<tr><td colspan="' + columns.length + '" class="ep-pm__empty-cell">' +
        (state.activityFilter === "all" && !Object.keys(state.activityColumnFilters).length
          ? 'No PM work orders fall in ' + escape(monthLabel(state.month)) + '.'
          : 'No PM work orders match these filters. ' +
            '<button type="button" class="ep-pm__clear-filters" data-pm-clear-activities>' +
            'Clear filters</button>') + '</td></tr>';
    } else {
      body = rows.map(function (entry) {
        return '<tr class="ep-pm__task-row">' + columns.map(function (column) {
          return '<td>' + (column.cell ? column.cell(entry) : escape(column.value(entry))) + '</td>';
        }).join("") + '</tr>';
      }).join("");
    }
    return '<section class="ep-pm__board" data-pm-activities>' +
      '<div class="ep-pm__board-head"><div><p class="ep-pm__eyebrow">Saved schedule</p>' +
        '<h2>PM work orders</h2></div><span>' + number(rows.length) + ' shown</span></div>' +
      activityChips(counts) +
      '<div class="ep-pm__table-wrap"><table class="ep-pm__table ep-pm__activity-table">' +
        '<thead><tr>' + header + '</tr></thead><tbody>' + body + '</tbody></table></div></section>';
  }

  function plantContent(row) {
    var plant = row.plant;
    var entries = plantEntries(plant.siteCode);
    var status = statusFor(row, entriesForPlant(plant.siteCode));
    return '<div class="ep-pm">' +
      '<div class="ep-pm__breadcrumb"><button type="button" data-pm-back>' +
        (state.parent === "overview" ? "Preventive Maintenance" : "Plants") +
        '</button><span aria-hidden="true">›</span><span>' + escape(plantName(plant)) + '</span></div>' +
      '<header class="ep-pm__plant-head"><div class="ep-pm__plant-identity">' +
        // A generic tile, not a photograph: a plant has no picture of its own in the portal, and
        // site evidence is private O&M material that does not belong in a summary header.
        '<span class="ep-pm__plant-tile" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" ' +
          'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M3.5 14.5h17l-1.6-9H5.1l-1.6 9Z"></path><path d="M12 5.5v9M4.6 10h14.8"></path>' +
          '<path d="M9 20h6M12 14.5V20"></path></svg></span>' +
        '<div><h1>' + escape(plantName(plant)) + ' — Preventive Maintenance</h1>' +
          '<p>Plant summary and upcoming tasks</p>' +
          '<p class="ep-pm__plant-meta">' + escape(plant.siteCode) +
            (plant.location ? ' · ' + escape(plant.location) : "") +
            ' · ' + escape(monthLabel(state.month)) + '</p>' +
          pausedTag(plant.siteCode) + '</div></div>' +
        '<div class="ep-pm__header-actions">' + statusBadge(status) +
          '<label>Period<input type="month" data-pm-month value="' + escape(state.month) +
            '" max="' + monthMax() + '" /></label></div></header>' +
      (state.truncated
        ? '<p class="ep-pm__notice" role="status">The server returned the first ' + number(state.limit) +
          ' records for this month. Change the month to narrow the results.</p>' : "") +
      (futureMonth()
        ? '<p class="ep-pm__notice" role="status">' + escape(monthLabel(state.month)) +
          ' has not started yet, so there is nothing due to measure: compliance and completion read ' +
          '— until the month begins. Plants below show their cycle plan state and whatever PM is ' +
          'already scheduled.</p>'
        : "") +
      (state.error ? retryMessage(state.error, "all") : "") +
      (state.calendarError ? retryMessage(state.calendarError, "calendar") : "") +
      (state.loading
        ? '<div class="ep-pm__loading" role="status">Loading PM work orders…</div>'
        : plantMetrics(row, entries) +
          workloadPanel(entries) +
          '<section class="ep-pm__plant-grid">' + breakdownPanel(entries) + calendarCard(entries) +
          '</section>' +
          recentUpcomingPanel(entries) +
          '<div data-pm-tracker-host></div>' +
          plantRegisterSection(entries)) +
      '<p class="ep-pm__footnote">PM task details open in the existing role-scoped calendar. ' +
        'No schedules are changed here.</p>' +
    '</div>';
  }

  function render() {
    if (!state.host) return;
    if (state.siteCode) {
      var row = state.rows.find(function (item) { return item.plant.siteCode === state.siteCode; });
      if (!state.loading && !row && !state.error) {
        state.error = "This plant is not available in your role-scoped portal data.";
      }
      if (row) {
        state.host.innerHTML = plantContent(row);
        mountTracker();
        wirePortfolioTables();
      } else {
        var title = plantName(state.plant);
        state.host.innerHTML = '<div class="ep-pm"><div class="ep-pm__breadcrumb"><button type="button" data-pm-back>' +
          (state.parent === "overview" ? "← Back to PM overview" : "← Back to plant details") +
          '</button><span>Preventive Maintenance</span></div><header class="ep-pm__header"><div>' +
          '<p class="ep-pm__eyebrow">' + escape(state.parent === "overview" ? "Overview · Plant" : "Plants · Plant") +
          '</p><h1>' + escape(title) + '</h1><p>' + escape(state.siteCode) +
          (state.month ? " · " + escape(monthLabel(state.month)) : "") + '</p></div></header>' +
          (state.loading
            ? '<div class="ep-pm__loading" role="status">Loading PM work orders…</div>'
            : retryMessage(state.error || "PM data is unavailable.", "all")) +
          '</div>';
      }
      return;
    }
    state.host.innerHTML = portfolioContent();
    wirePortfolioTables();
  }

  /**
   * The shared click-to-sort headings and searchable column filters attach to the elements render()
   * has just created, so they are re-wired after every draw, on the portfolio and on a plant's page
   * alike. Both are optional: without them the register still lists every row, with plain headings.
   */
  function wirePortfolioTables() {
    var host = state.host;
    if (!host || typeof host.querySelectorAll !== "function") return;
    var sorter = global.Solar91PortalSort;
    if (sorter) {
      sorter.wire(host, state.registerSort, render, "data-pm-register-sort");
      sorter.wire(host, state.activitySort, render, "data-pm-activity-sort");
    }
    var columnFilter = global.Solar91PortalColumnFilter;
    if (!columnFilter) return;
    columnFilter.wire(host, {
      attributes: COLUMN_FILTER_ATTRIBUTES,
      classes: COLUMN_FILTER_CLASSES,
      focusSearchOnOpen: true,
      keepAllOptionVisible: true,
      onSelect: function (key, _scope, value) {
        if (value) state.activityColumnFilters[key] = value;
        else delete state.activityColumnFilters[key];
        render();
      }
    });
  }

  /** The plant's cycle plan, rendered as a section of this page by the pm-cycle-plans module. */
  function mountTracker() {
    if (!state.host || !state.siteCode || !global.Solar91PortalPMCyclePlans) return;
    var host = state.host.querySelector("[data-pm-tracker-host]");
    if (!host) return;
    global.Solar91PortalPMCyclePlans.show(host, {
      siteCode: state.siteCode,
      month: state.month,
      entries: entriesForPlant(state.siteCode),
      list: state.cyclePlans
    });
  }

  function loadData() {
    if (!data || typeof data.fetchPortfolioRange !== "function" ||
        typeof data.fetchCalendarMonth !== "function") {
      state.error = "PM data services are not available.";
      state.loading = false;
      state.calendarLoading = false;
      render();
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(state.month) || state.month > monthMax()) {
      state.error = "Choose a month up to " + monthLabel(monthMax()) + ".";
      state.loading = false;
      state.calendarLoading = false;
      render();
      return;
    }
    var ahead = futureMonth(state.month);
    var period = periodRange(state.month);
    var requestId = ++state.requestId;
    state.loading = true;
    state.calendarLoading = true;
    state.rows = [];
    state.entries = [];
    state.error = "";
    state.calendarError = "";
    state.truncated = false;
    state.limit = null;
    render();

    if (ahead) {
      // A month that has not started has nothing due, so there is no compliance range to ask for.
      // The plants come from the cycle-plan listing below and the figures stay "—".
      state.loading = false;
      state.error = "";
      state.rows = plannedRows();
    } else {
      withTimeout(Promise.resolve().then(function () {
        return data.fetchPortfolioRange(period.start, period.end, state.siteCode || "");
      }), "PM summary").then(function (result) {
        if (requestId !== state.requestId) return;
        state.rows = result.rows || [];
        state.loading = false;
        state.error = "";
        render();
      }).catch(function (error) {
        if (requestId !== state.requestId) return;
        state.loading = false;
        state.error = error && error.message
          ? error.message : "PM summary could not be loaded.";
        render();
      });
    }

    // Which plants have a tracker and which are paused. One small request per visit; a role without
    // PM planning access simply gets no planned/paused line and no paused tags. The listing is not
    // month-specific, so a response that lands after the month changed is still kept.
    if (!state.cyclePlans && global.Solar91PortalAPI) {
      global.Solar91PortalAPI.request("/api/pm-plan/cycle-plans").then(function (body) {
        state.cyclePlans = body;
        if (futureMonth(state.month)) state.rows = plannedRows();
        render();
      }).catch(function () {
        state.cyclePlans = null;               // the page still works without it
      });
    }

    withTimeout(Promise.resolve().then(function () {
      // includeMonths asks the SAME endpoint for its PM month index as well, so the page can open
      // on a month that holds work and bound its picker without a second round trip.
      return data.fetchCalendarMonth("pm", state.month, state.siteCode || "",
        { includeMonths: !state.siteCode });
    }), "PM schedule").then(function (result) {
      if (requestId !== state.requestId) return;
      state.entries = result.entries || [];
      state.truncated = !!result.truncated;
      state.limit = result.limit || null;
      state.calendarLoading = false;
      state.calendarError = "";
      if (Array.isArray(result.months)) state.months = result.months;
      if (settleLandingMonth()) return;      // re-reads the month that actually has work
      render();
    }).catch(function (error) {
      if (requestId !== state.requestId) return;
      state.calendarLoading = false;
      state.calendarError = error && error.message
        ? error.message : "PM schedule could not be loaded.";
      render();
    });
  }

  /**
   * Opening PM must land on a month that has something in it.
   *
   * The current month is kept when it holds planned work; otherwise the page moves to the nearest
   * month that does, and says plainly when no month in range holds any. Runs once per visit and
   * never after the person has chosen a month themselves, so it cannot argue with a chosen month.
   * Returns true when it has started a fresh read for another month.
   */
  function settleLandingMonth() {
    if (state.monthSettled || state.siteCode) return false;
    state.monthSettled = true;
    var months = workMonths();
    if (!months.length || months.indexOf(state.month) !== -1) return false;
    var nearest = nearestWorkMonth(state.month);
    if (!nearest || nearest === state.month) return false;
    goToMonth(nearest);
    return true;
  }

  function goToMonth(month) {
    state.month = month;
    var bounds = monthBounds(month);
    state.filters.dateFrom = bounds.start;
    state.filters.dateTo = bounds.end;
    loadData();
  }

  function refreshPreservingSearch() {
    var input = state.host && state.host.querySelector('[data-pm-filter="query"]');
    var selection = input && typeof input.selectionStart === "number" ? input.selectionStart : null;
    render();
    var replacement = state.host && state.host.querySelector('[data-pm-filter="query"]');
    if (replacement) {
      replacement.focus();
      if (selection !== null && typeof replacement.setSelectionRange === "function") {
        replacement.setSelectionRange(selection, selection);
      }
    }
  }

  function wire(host) {
    if (wiredHosts.has(host)) return;
    wiredHosts.add(host);
    host.addEventListener("click", function (event) {
      var retryButton = event.target.closest("[data-pm-retry]");
      if (retryButton) {
        var retry = retryButton.getAttribute("data-pm-retry");
        if (retry === "calendar" && !state.loading) {
          state.calendarLoading = true;
          state.calendarError = "";
          state.entries = [];
          render();
          var requestId = ++state.requestId;
          withTimeout(Promise.resolve().then(function () {
            return data.fetchCalendarMonth("pm", state.month, state.siteCode || "",
              { includeMonths: !state.siteCode });
          }), "PM schedule").then(function (result) {
            if (requestId !== state.requestId) return;
            state.entries = result.entries || [];
            state.truncated = !!result.truncated;
            state.limit = result.limit || null;
            state.calendarLoading = false;
            state.calendarError = "";
            if (Array.isArray(result.months)) state.months = result.months;
            render();
          }).catch(function (error) {
            if (requestId !== state.requestId) return;
            state.calendarLoading = false;
            state.calendarError = error && error.message
              ? error.message : "PM schedule could not be loaded.";
            render();
          });
        } else {
          loadData();
        }
        return;
      }
      var plantButton = event.target.closest("[data-pm-open-plant]");
      if (plantButton) {
        var siteCode = plantButton.getAttribute("data-pm-open-plant");
        var row = state.rows.find(function (item) { return item.plant.siteCode === siteCode; });
        if (row && global.Solar91PortalNav) {
          global.Solar91PortalNav.selectPlantPage(siteCode, "pm", null, row.plant, {
            pmParent: "overview"
          });
        }
        return;
      }
      var eventButton = event.target.closest("[data-pm-open-event]");
      if (eventButton && global.Solar91PortalNav) {
        var eventDate = eventButton.getAttribute("data-pm-event-date") || "";
        global.Solar91PortalNav.openPMCalendar(eventDate.slice(0, 7), eventButton.getAttribute("data-pm-open-event"));
        return;
      }
      if (event.target.closest("[data-pm-calendar]") && global.Solar91PortalNav) {
        global.Solar91PortalNav.openPMCalendar(state.month, null);
        return;
      }
      if (event.target.closest("[data-pm-back]") && global.Solar91PortalNav) {
        if (state.parent === "overview") {
          global.Solar91PortalNav.selectView("pm");
        } else {
          global.Solar91PortalNav.selectPlantPage(state.siteCode, "details");
        }
        return;
      }
      if (event.target.closest("[data-pm-clear-filters]")) {
        clearFilters();
        render();
        return;
      }
      if (event.target.closest("[data-pm-clear-activities]")) {
        state.activityFilter = "all";
        state.activityColumnFilters = {};
        render();
        return;
      }
      if (event.target.closest("[data-pm-export]")) {
        exportActivities();
        return;
      }
      // "View all" lands on the work-order register with the Upcoming chip already applied.
      if (event.target.closest("[data-pm-view-all]")) {
        state.activityFilter = "upcoming";
        render();
        var activities = state.host.querySelector("[data-pm-activities]");
        if (activities && activities.scrollIntoView) activities.scrollIntoView({ block: "start" });
        return;
      }
      var chip = event.target.closest("[data-pm-activity-filter]");
      if (chip) {
        state.activityFilter = chip.getAttribute("data-pm-activity-filter") || "all";
        render();
        return;
      }
      var gotoMonth = event.target.closest("[data-pm-goto-month]");
      if (gotoMonth) {
        var wanted = gotoMonth.getAttribute("data-pm-goto-month") || "";
        if (/^\d{4}-\d{2}$/.test(wanted)) {
          state.monthSettled = true;
          goToMonth(wanted);
        }
        return;
      }
      // All / Planned / Paused filters the register in place; it never opens a separate page.
      var planButton = event.target.closest("[data-pm-plan-filter]");
      if (planButton) {
        state.planFilter = planButton.getAttribute("data-pm-plan-filter") || "all";
        render();
        var register = state.host.querySelector(".ep-pm__plants-grid, .ep-pm__table-wrap");
        if (register && register.scrollIntoView) register.scrollIntoView({ block: "start" });
        return;
      }
      var layoutButton = event.target.closest("[data-pm-layout]");
      if (layoutButton) {
        state.layout = layoutButton.getAttribute("data-pm-layout") === "cards" ? "cards" : "table";
        saveLayoutPreference();
        render();
      }
    });
    host.addEventListener("input", function (event) {
      var filter = event.target.getAttribute("data-pm-filter");
      if (filter === "query") {
        state.filters.query = event.target.value;
        refreshPreservingSearch();
      }
    });
    host.addEventListener("change", function (event) {
      if (event.target.matches("[data-pm-month]")) {
        if (!/^\d{4}-\d{2}$/.test(event.target.value)) return;
        state.monthSettled = true;            // a chosen month is never overridden
        goToMonth(event.target.value);
        return;
      }
      var filter = event.target.getAttribute("data-pm-filter");
      if (filter && Object.prototype.hasOwnProperty.call(state.filters, filter)) {
        state.filters[filter] = event.target.value;
        if ((filter === "dateFrom" || filter === "dateTo") &&
            state.filters.dateFrom && state.filters.dateTo &&
            state.filters.dateFrom > state.filters.dateTo) {
          state.error = "The start date must be on or before the end date.";
        } else {
          state.error = "";
        }
        render();
      }
    });
  }

  function show(host, options) {
    if (!host) throw new Error("PM overview host element is missing.");
    state.host = host;
    var nextSiteCode = options && options.siteCode || null;
    if (nextSiteCode !== state.siteCode) {
      state.filters.query = "";
      state.filters.plant = "";
      state.filters.equipment = "";
      state.filters.status = "all";
      state.filters.sort = "urgency";
      state.activityFilter = "all";
      state.activityColumnFilters = {};
      state.activitySort = { key: "due", dir: "asc" };
      state.registerSort = { key: "", dir: "asc" };
      if (state.month) {
        var currentBounds = monthBounds(state.month);
        state.filters.dateFrom = currentBounds.start;
        state.filters.dateTo = currentBounds.end;
      }
    }
    state.siteCode = nextSiteCode;
    state.plant = options && options.plant || null;
    state.parent = options && options.parent === "plants" ? "plants" : "overview";
    if (!state.month) {
      state.month = businessToday().slice(0, 7);
      var bounds = monthBounds(state.month);
      state.filters.dateFrom = bounds.start;
      state.filters.dateTo = bounds.end;
    }
    loadLayoutPreference();
    // The shared sort and column-filter controls are listed as this page's dependencies, so they are
    // normally already here; this is the fallback for a cold load that raced them.
    if ((!global.Solar91PortalSort || !global.Solar91PortalColumnFilter) && global.Solar91Modules) {
      global.Solar91Modules.load(["table-sort", "table-column-filter"]).then(render).catch(function () {});
    }
    wire(host);
    loadData();
  }

  global.Solar91PortalPMOverview = { show: show };
}(window));
