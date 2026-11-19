(function (global) {
  "use strict";

  var data = global.Solar91PortalData;
  var state = {
    host: null,
    siteCode: null,
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
    layout: "cards",
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

  function pmBlock(row) {
    return row && row.profile && row.profile.pm || {};
  }

  function countValue(value) {
    return value == null ? 0 : Number(value) || 0;
  }

  function statusFor(row, entries) {
    var pm = pmBlock(row);
    var scheduled = entries.filter(function (entry) { return entry.status !== "Cancelled"; });
    if (countValue(pm.overdue) > 0) return "Overdue";
    if (pm.compliancePercent != null && Number(pm.compliancePercent) < 80) {
      return "Attention Required";
    }
    if (!scheduled.length) return "Not Started";
    if (scheduled.every(function (entry) { return entry.status === "Completed"; })) {
      return "Completed";
    }
    return "On Track";
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

  function entriesForPlant(siteCode) {
    return state.entries.filter(function (entry) {
      return entry.plantSiteCode === siteCode;
    });
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

  function categoryOptions(entries, selected) {
    var names = [];
    entries.forEach(function (entry) {
      var name = categoryName(entry);
      if (names.indexOf(name) === -1) names.push(name);
    });
    names.sort(function (a, b) { return a.localeCompare(b); });
    return '<option value="">All equipment</option>' + names.map(function (name) {
      return '<option value="' + escape(name) + '"' +
        (name === selected ? " selected" : "") + '>' + escape(name) + '</option>';
    }).join("");
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

  function filteredRows() {
    var query = state.filters.query.trim().toLowerCase();
    var rows = state.rows.filter(function (row) {
      var plant = row.plant;
      if (!state.siteCode && !activePlant(plant)) return false;
      if (state.filters.plant && plant.siteCode !== state.filters.plant) return false;
      var entries = rowEntries(row);
      if (state.filters.equipment &&
          !entries.some(function (entry) { return categoryName(entry) === state.filters.equipment; })) {
        return false;
      }
      if (state.filters.status !== "all" &&
          statusFor(row, entriesForPlant(plant.siteCode)) !== state.filters.status) return false;
      if ((state.filters.dateFrom || state.filters.dateTo) && !entries.length) return false;
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
      return data.aggregatePortfolio(rows).totals;
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
    var codes = rows.map(function (row) { return row.plant.siteCode; });
    return state.entries.filter(function (entry) {
      return codes.indexOf(entry.plantSiteCode) !== -1 &&
        (!state.filters.dateFrom || entry.date >= state.filters.dateFrom) &&
        (!state.filters.dateTo || entry.date <= state.filters.dateTo);
    });
  }

  function metric(label, value, note, modifier) {
    return '<article class="ep-pm__metric' + (modifier ? " ep-pm__metric--" + modifier : "") + '">' +
      '<span class="ep-pm__metric-label">' + escape(label) + '</span>' +
      '<strong class="ep-pm__metric-value">' + escape(value) + '</strong>' +
      '<span class="ep-pm__metric-note">' + escape(note) + '</span></article>';
  }

  function summaryMetrics(rows) {
    var totals = aggregate(rows);
    var activities = monthEntries(rows).filter(function (entry) { return entry.status !== "Cancelled"; });
    var today = businessToday();
    var dueToday = activities.filter(function (entry) {
      return entry.date === today && entry.status !== "Completed";
    }).length;
    return '<div class="ep-pm__metrics">' +
      metric("PM compliance", totals.pmCompliancePercent == null
        ? "—" : Math.round(Number(totals.pmCompliancePercent)) + "%",
      "Due work completed to date", "green") +
      metric("Completed", number(totals.pmCompleted), "Due work completed to date", "blue") +
      metric("Overdue", number(totals.pmOverdue), "Open work past due", "red") +
      metric("Scheduled", state.calendarLoading ? "Loading…" : number(activities.length),
        "For visible plants and dates", "amber") +
      '<span class="ep-pm__due-today">' +
        (state.calendarLoading ? "Checking today’s schedule…" : number(dueToday) + " open due today") +
      '</span>' +
    '</div>';
  }

  function categorySummary(rows) {
    if (state.calendarLoading) {
      return '<p class="ep-pm__empty-copy" role="status">Loading scheduled PM work…</p>';
    }
    if (state.calendarError) {
      return '<p class="ep-pm__empty-copy">Scheduled PM work is unavailable. Use Retry above to try again.</p>';
    }
    var entries = monthEntries(rows).filter(function (entry) { return entry.status !== "Cancelled"; });
    var totals = {};
    entries.forEach(function (entry) {
      var name = categoryName(entry);
      if (!totals[name]) totals[name] = { total: 0, completed: 0, overdue: 0 };
      totals[name].total += 1;
      if (entry.status === "Completed") totals[name].completed += 1;
      if (entry.status === "Overdue") totals[name].overdue += 1;
    });
    var items = Object.keys(totals).map(function (name) {
      return { name: name, counts: totals[name] };
    }).sort(function (a, b) {
      return b.counts.total - a.counts.total || a.name.localeCompare(b.name);
    }).slice(0, 4);
    if (!items.length) {
      return '<p class="ep-pm__empty-copy">No PM work orders are scheduled for this period.</p>';
    }
    return '<div class="ep-pm__category-list">' + items.map(function (item) {
      var pct = item.counts.total ? Math.round(100 * item.counts.completed / item.counts.total) : 0;
      return '<div class="ep-pm__category">' +
        '<div class="ep-pm__category-head"><strong>' + escape(item.name) + '</strong>' +
          '<span>' + number(item.counts.completed) + ' / ' + number(item.counts.total) + '</span></div>' +
        '<div class="ep-pm__progress"><span style="width:' + pct + '%"></span></div>' +
        '<small>' + number(item.counts.overdue) + ' overdue</small></div>';
    }).join("") + '</div>';
  }

  function attentionPanel(rows) {
    var needsAttention = rows.map(function (row) {
      var plantEntries = entriesForPlant(row.plant.siteCode);
      return { row: row, entries: plantEntries, status: statusFor(row, plantEntries) };
    }).filter(function (item) {
      return item.status === "Overdue" || item.status === "Attention Required";
    }).sort(function (a, b) {
      return countValue(pmBlock(b.row).overdue) - countValue(pmBlock(a.row).overdue) ||
        plantName(a.row.plant).localeCompare(plantName(b.row.plant));
    }).slice(0, 5);
    if (!needsAttention.length) {
      return '<p class="ep-pm__empty-copy">No plants currently require PM attention.</p>';
    }
    return '<ul class="ep-pm__attention-list">' + needsAttention.map(function (item) {
      return '<li><button type="button" data-pm-open-plant="' + escape(item.row.plant.siteCode) + '">' +
        '<span><strong>' + escape(plantName(item.row.plant)) + '</strong>' +
          '<small>' + escape(item.row.plant.siteCode) + '</small></span>' +
        '<span>' + statusBadge(item.status) + '</span>' +
        '<b>' + number(pmBlock(item.row).overdue) + ' overdue</b></button></li>';
    }).join("") + '</ul>';
  }

  function plantCard(row) {
    var plant = row.plant;
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
    return '<article class="ep-pm__plant-card">' +
      '<div class="ep-pm__plant-card-head"><div><p>' + escape(plant.siteCode) + '</p>' +
        '<h3>' + escape(plantName(plant)) + '</h3></div>' + statusBadge(status) + '</div>' +
      '<div class="ep-pm__plant-card-stats"><div><span>Compliance</span><strong>' +
        (pm.compliancePercent == null ? "—" : Math.round(Number(pm.compliancePercent)) + "%") +
        '</strong></div><div><span>Completed</span><strong>' + number(pm.completed) +
        '</strong></div><div><span>Overdue</span><strong>' + number(pm.overdue) + '</strong></div></div>' +
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

  function plantTable(rows) {
    return '<div class="ep-pm__table-wrap"><table class="ep-pm__table">' +
      '<thead><tr><th>Plant</th><th>Status</th><th>Compliance</th><th>Completed</th>' +
      '<th>Overdue</th><th>Next due</th><th></th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (row) {
        var plant = row.plant;
        var entries = entriesForPlant(plant.siteCode);
        var pm = pmBlock(row);
        var next = openEntries(entries).filter(function (entry) {
          return entry.date >= businessToday();
        }).sort(function (a, b) { return a.date.localeCompare(b.date); })[0];
        return '<tr><td><strong>' + escape(plantName(plant)) + '</strong><small>' +
          escape(plant.siteCode) + '</small></td><td>' +
          statusBadge(statusFor(row, entries)) + '</td><td>' +
          (pm.compliancePercent == null ? "—" : Math.round(Number(pm.compliancePercent)) + "%") +
          '</td><td>' + number(pm.completed) + '</td><td>' + number(pm.overdue) +
          '</td><td>' + (next ? escape(dateLabel(next.date)) : "—") + '</td><td>' +
          '<button type="button" class="ep-pm__table-open" data-pm-open-plant="' +
          escape(plant.siteCode) + '">Open</button></td></tr>';
      }).join("") : '<tr><td colspan="7" class="ep-pm__empty-cell">No plants match these filters.</td></tr>') +
      '</tbody></table></div>';
  }

  function portfolioContent() {
    var rows = filteredRows();
    var period = monthBounds(state.month);
    var today = businessToday();
    var maxDate = period.end > today ? today : period.end;
    var categories = state.entries.filter(function (entry) {
      return !state.filters.dateFrom || entry.date >= state.filters.dateFrom;
    });
    return '<div class="ep-pm">' +
      '<header class="ep-pm__header"><div><p class="ep-pm__eyebrow">Portfolio view</p>' +
        '<h1>Preventive Maintenance</h1><p>Role-scoped PM work orders and compliance for active plants.</p></div>' +
        '<div class="ep-pm__header-actions"><label>Month<input type="month" data-pm-month value="' +
          escape(state.month) + '" max="' + today.slice(0, 7) + '" /></label>' +
          '<button type="button" class="ep-pm__calendar-button" data-pm-calendar>Open PM calendar</button></div></header>' +
      (state.truncated
        ? '<p class="ep-pm__notice" role="status">The server returned the first ' + number(state.limit) +
          ' records for this month. Open a plant to view its own records.</p>' : "") +
      (state.error ? retryMessage(state.error, "all") : "") +
      (state.calendarError ? retryMessage(state.calendarError, "calendar") : "") +
      (state.loading
        ? '<div class="ep-pm__loading" role="status">Loading PM overview…</div>'
        : summaryMetrics(rows) +
          '<section class="ep-pm__insights"><article class="ep-pm__panel"><header><div>' +
            '<p class="ep-pm__eyebrow">Needs attention first</p><h2>Plants to review</h2></div>' +
            '<span>' + number(rows.length) + ' plants</span></header>' + attentionPanel(rows) + '</article>' +
            '<article class="ep-pm__panel"><header><div><p class="ep-pm__eyebrow">Equipment progress</p>' +
              '<h2>Top PM categories</h2></div><span>' + escape(monthLabel(state.month)) + '</span></header>' +
              categorySummary(rows) + '</article></section>' +
          '<section class="ep-pm__board"><div class="ep-pm__board-head"><div><p class="ep-pm__eyebrow">' +
            'Plant register</p><h2>PM status by plant</h2></div><span>' + number(rows.length) +
            ' shown</span></div>' +
            '<div class="ep-pm__filters">' +
              '<label class="ep-pm__search"><span class="ep-pm__sr-only">Search plants and PM tasks</span>' +
                '<input type="search" data-pm-filter="query" value="' + escape(state.filters.query) +
                '" placeholder="Search plant, equipment, task or assignee" /></label>' +
              '<label><span>Plant</span><select data-pm-filter="plant">' +
                plantOptions(state.rows.filter(function (row) { return activePlant(row.plant); }), state.filters.plant) +
                '</select></label>' +
              '<label><span>Equipment</span><select data-pm-filter="equipment">' +
                categoryOptions(categories, state.filters.equipment) + '</select></label>' +
              '<label><span>Status</span><select data-pm-filter="status">' +
                '<option value="all">All statuses</option>' +
                ["On Track", "Attention Required", "Overdue", "Not Started", "Completed"].map(function (status) {
                  return '<option value="' + escape(status) + '"' +
                    (state.filters.status === status ? " selected" : "") + '>' + escape(status) + '</option>';
                }).join("") + '</select></label>' +
              '<label><span>Sort by</span><select data-pm-filter="sort">' +
                '<option value="urgency"' + (state.filters.sort === "urgency" ? " selected" : "") + '>Urgency</option>' +
                '<option value="overdue"' + (state.filters.sort === "overdue" ? " selected" : "") + '>Overdue</option>' +
                '<option value="compliance"' + (state.filters.sort === "compliance" ? " selected" : "") + '>Compliance</option>' +
                '<option value="name"' + (state.filters.sort === "name" ? " selected" : "") + '>Plant name</option>' +
                '</select></label>' +
              '<label class="ep-pm__date-filter"><span>From</span><input type="date" data-pm-filter="dateFrom" ' +
                'min="' + period.start + '" max="' + period.end + '" value="' +
                escape(state.filters.dateFrom) + '" /></label>' +
              '<label class="ep-pm__date-filter"><span>To</span><input type="date" data-pm-filter="dateTo" ' +
                'min="' + period.start + '" max="' + period.end + '" value="' +
                escape(state.filters.dateTo) + '" /></label>' +
              '<div class="ep-pm__layout-toggle" role="group" aria-label="Plant layout">' +
                '<button type="button" data-pm-layout="cards" aria-pressed="' +
                  (state.layout === "cards") + '">Cards</button>' +
                '<button type="button" data-pm-layout="table" aria-pressed="' +
                  (state.layout === "table") + '">Table</button></div>' +
            '</div>' +
            '<div class="ep-pm__board-content">' +
              (rows.length
                ? (state.layout === "table" ? plantTable(rows) :
                  '<div class="ep-pm__plants-grid">' + rows.map(plantCard).join("") + '</div>')
                : '<p class="ep-pm__empty">No active plants match these filters.</p>') +
            '</div></section>') +
      '<p class="ep-pm__footnote">Compliance and due counts use the portal’s existing PM rules. Cancelled work is excluded.</p>' +
    '</div>';
  }

  function dayWorkload(entries) {
    if (state.calendarLoading) return '<p class="ep-pm__empty-copy" role="status">Loading scheduled PM work…</p>';
    if (state.calendarError) return '<p class="ep-pm__empty-copy">Scheduled PM work is unavailable.</p>';
    var period = monthBounds(state.month);
    var days = Number(period.end.slice(-2));
    var daily = {};
    entries.forEach(function (entry) {
      if (entry.status === "Cancelled") return;
      var day = Number(entry.date.slice(-2));
      if (!daily[day]) daily[day] = { completed: 0, open: 0, overdue: 0 };
      if (entry.status === "Completed") daily[day].completed += 1;
      else if (entry.status === "Overdue") daily[day].overdue += 1;
      else daily[day].open += 1;
    });
    var max = 1;
    Object.keys(daily).forEach(function (day) {
      max = Math.max(max, daily[day].completed + daily[day].open + daily[day].overdue);
    });
    return '<div class="ep-pm__workload"><div class="ep-pm__workload-legend">' +
      '<span><i class="is-completed"></i>Completed</span><span><i class="is-open"></i>Open</span>' +
      '<span><i class="is-overdue"></i>Overdue</span></div><div class="ep-pm__day-bars">' +
      Array.from({ length: days }, function (_, index) {
        var day = index + 1;
        var counts = daily[day] || { completed: 0, open: 0, overdue: 0 };
        var total = counts.completed + counts.open + counts.overdue;
        var height = total ? Math.max(4, Math.round(100 * total / max)) : 0;
        var completedHeight = total ? Math.round(100 * counts.completed / total) : 0;
        var overdueHeight = total ? Math.round(100 * counts.overdue / total) : 0;
        var openHeight = total - completedHeight - overdueHeight;
        return '<div class="ep-pm__day-bar" title="' + day + ' ' + escape(monthLabel(state.month)) +
          ': ' + number(total) + ' work orders"><div class="ep-pm__bar-track" style="height:' +
          height + '%"><span class="is-completed" style="height:' + completedHeight +
          '%"></span><span class="is-open" style="height:' + openHeight +
          '%"></span><span class="is-overdue" style="height:' + overdueHeight +
          '%"></span></div><small>' + (day % 5 === 1 || day === days ? day : "") +
          '</small></div>';
      }).join("") + '</div></div>';
  }

  function plantCategories(entries) {
    if (state.calendarLoading) return '<p class="ep-pm__empty-copy" role="status">Loading scheduled PM work…</p>';
    if (state.calendarError) return '<p class="ep-pm__empty-copy">Scheduled PM work is unavailable.</p>';
    var groups = {};
    entries.filter(function (entry) { return entry.status !== "Cancelled"; }).forEach(function (entry) {
      var name = categoryName(entry);
      if (!groups[name]) groups[name] = { total: 0, completed: 0, overdue: 0 };
      groups[name].total += 1;
      if (entry.status === "Completed") groups[name].completed += 1;
      if (entry.status === "Overdue") groups[name].overdue += 1;
    });
    var names = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b); });
    if (!names.length) return '<p class="ep-pm__empty-copy">No equipment categories scheduled this month.</p>';
    return '<div class="ep-pm__detail-categories">' + names.map(function (name) {
      var item = groups[name];
      var pct = item.total ? Math.round(100 * item.completed / item.total) : 0;
      return '<article><div><strong>' + escape(name) + '</strong><span>' +
        number(item.completed) + ' / ' + number(item.total) + '</span></div>' +
        '<div class="ep-pm__progress"><span style="width:' + pct + '%"></span></div>' +
        '<small>' + number(item.overdue) + ' overdue</small></article>';
    }).join("") + '</div>';
  }

  function upcomingList(entries) {
    if (state.calendarLoading) return '<p class="ep-pm__empty-copy" role="status">Loading scheduled PM work…</p>';
    if (state.calendarError) return '<p class="ep-pm__empty-copy">Scheduled PM work is unavailable.</p>';
    var items = openEntries(entries).sort(function (a, b) {
      var aLate = a.status === "Overdue" ? 0 : 1;
      var bLate = b.status === "Overdue" ? 0 : 1;
      return aLate - bLate || a.date.localeCompare(b.date) ||
        categoryName(a).localeCompare(categoryName(b));
    }).slice(0, 6);
    if (!items.length) return '<p class="ep-pm__empty-copy">No open PM work orders in this month.</p>';
    return '<ul class="ep-pm__upcoming-list">' + items.map(function (entry) {
      return '<li><button type="button" data-pm-open-event="' + escape(entry.id) + '" data-pm-event-date="' +
        escape(entry.date) + '"><span>' + statusBadge(entry.status) +
        '<strong>' + escape(entry.title) + '</strong><small>' + escape(categoryName(entry)) +
        (entry.reference ? " · " + escape(entry.reference) : "") + '</small></span>' +
        '<time datetime="' + escape(entry.date) + '">' + escape(dateLabel(entry.date)) + '</time></button></li>';
    }).join("") + '</ul>';
  }

  function taskRows(entries) {
    if (state.calendarLoading) {
      return '<tr><td colspan="6" class="ep-pm__empty-cell">Loading scheduled PM work…</td></tr>';
    }
    if (state.calendarError) {
      return '<tr><td colspan="6" class="ep-pm__empty-cell">Scheduled PM work is unavailable. Use Retry above.</td></tr>';
    }
    if (!entries.length) {
      return '<tr><td colspan="6" class="ep-pm__empty-cell">No PM work orders match these filters.</td></tr>';
    }
    return entries.map(function (entry) {
      return '<tr class="ep-pm__task-row">' +
        '<td>' + escape(dateLabel(entry.date)) + '</td><td>' + escape(categoryName(entry)) +
        '</td><td><button type="button" class="ep-pm__task-open" data-pm-open-event="' +
          escape(entry.id) + '" data-pm-event-date="' + escape(entry.date) + '">' +
          escape(entry.title) + '</button><small>' +
          escape(entry.reference || "No work order reference") + '</small></td>' +
        '<td>' + escape(entry.frequency || "—") + '</td><td>' +
          escape(entry.assignee || "Unassigned") + '</td><td>' + statusBadge(entry.status) +
        '</td></tr>';
    }).join("");
  }

  function plantContent(row) {
    var plant = row.plant;
    var allEntries = entriesForPlant(plant.siteCode);
    var entries = allEntries.filter(function (entry) {
      return !state.filters.equipment || categoryName(entry) === state.filters.equipment;
    }).filter(function (entry) {
      return !state.filters.status || state.filters.status === "all" || entry.status === state.filters.status;
    }).filter(function (entry) {
      var query = state.filters.query.trim().toLowerCase();
      return !query || [entry.title, entry.reference, entry.equipmentType, entry.assignee, entry.status]
        .join(" ").toLowerCase().indexOf(query) !== -1;
    });
    var schedule = entriesInDateFilter(entries).sort(function (a, b) {
      var aStatus = a.status === "Overdue" ? 0 : a.status === "Completed" ? 2 : 1;
      var bStatus = b.status === "Overdue" ? 0 : b.status === "Completed" ? 2 : 1;
      return aStatus - bStatus || a.date.localeCompare(b.date) || a.title.localeCompare(b.title);
    });
    var pm = pmBlock(row);
    var open = openEntries(allEntries);
    var next = open.filter(function (entry) {
      return entry.date >= businessToday();
    }).sort(function (a, b) { return a.date.localeCompare(b.date); })[0];
    var scheduled = allEntries.filter(function (entry) { return entry.status !== "Cancelled"; });
    var status = statusFor(row, allEntries);
    var bounds = monthBounds(state.month);
    var categoryCount = {};
    scheduled.forEach(function (entry) { categoryCount[categoryName(entry)] = true; });

    return '<div class="ep-pm">' +
      '<div class="ep-pm__breadcrumb"><button type="button" data-pm-back>' +
        (state.parent === "overview" ? "← Back to PM overview" : "← Back to plant details") +
        '</button><span>Preventive Maintenance</span></div>' +
      '<header class="ep-pm__header"><div><p class="ep-pm__eyebrow">' +
        escape(state.parent === "overview" ? "Overview · Plant" : "Plants · Plant") + '</p>' +
        '<h1>' + escape(plantName(plant)) + '</h1><p>' + escape(plant.siteCode) +
        (plant.location ? " · " + escape(plant.location) : "") + ' · ' + escape(monthLabel(state.month)) +
        '</p></div><div class="ep-pm__header-actions">' + statusBadge(status) +
          '<label>Month<input type="month" data-pm-month value="' + escape(state.month) +
            '" max="' + businessToday().slice(0, 7) + '" /></label>' +
          '<button type="button" class="ep-pm__calendar-button" data-pm-calendar>Open PM calendar</button>' +
        '</div></header>' +
      (state.truncated
        ? '<p class="ep-pm__notice" role="status">The server returned the first ' + number(state.limit) +
          ' records for this month. Change the month to narrow the results.</p>' : "") +
      (state.error ? retryMessage(state.error, "all") : "") +
      (state.calendarError ? retryMessage(state.calendarError, "calendar") : "") +
      (state.loading
        ? '<div class="ep-pm__loading" role="status">Loading PM work orders…</div>'
        : '<div class="ep-pm__metrics ep-pm__metrics--plant">' +
          metric("PM compliance", pm.compliancePercent == null
            ? "—" : Math.round(Number(pm.compliancePercent)) + "%", "For selected month to date", "green") +
          metric("Scheduled", state.calendarLoading ? "Loading…" : number(scheduled.length),
            "Work orders in this month", "blue") +
          metric("Completed", number(pm.completed), "Due work completed", "green") +
          metric("Overdue", number(pm.overdue), "Open work past due", "red") +
          metric("Pending", number(pm.pending), "Scheduled or in progress", "amber") +
          metric("Next due", state.calendarLoading ? "Loading…" : next ? dateLabel(next.date) : "—",
            state.calendarLoading ? "Checking schedule" : next ? categoryName(next) : "No upcoming work this month", "blue") +
        '</div>' +
        '<section class="ep-pm__detail-grid"><article class="ep-pm__panel"><header><div>' +
          '<p class="ep-pm__eyebrow">Monthly workload</p><h2>Scheduled work by day</h2></div>' +
          '<span>' + (state.calendarLoading ? "Loading…" : number(scheduled.length)) + ' work orders</span></header>' +
          dayWorkload(allEntries) + '</article>' +
          '<article class="ep-pm__panel"><header><div><p class="ep-pm__eyebrow">Action list</p>' +
            '<h2>Upcoming and overdue</h2></div><span>' +
              (state.calendarLoading ? "Loading…" : number(open.length)) + ' open</span></header>' +
            upcomingList(allEntries) + '</article></section>' +
        '<section class="ep-pm__panel ep-pm__equipment-panel"><header><div><p class="ep-pm__eyebrow">' +
          'Equipment progress</p><h2>PM categories</h2></div><span>' +
          (state.calendarLoading ? "Loading…" : number(Object.keys(categoryCount).length)) +
          ' categories</span></header>' +
          plantCategories(allEntries) + '</section>' +
        '<section class="ep-pm__board"><div class="ep-pm__board-head"><div><p class="ep-pm__eyebrow">' +
          'Saved schedule</p><h2>PM work orders</h2></div><span>' +
          (state.calendarLoading ? "Loading…" : number(schedule.length)) + ' shown</span></div>' +
          '<div class="ep-pm__filters ep-pm__filters--detail">' +
            '<label class="ep-pm__search"><span class="ep-pm__sr-only">Search PM work orders</span>' +
              '<input type="search" data-pm-filter="query" value="' + escape(state.filters.query) +
                '" placeholder="Search task, reference or assignee" /></label>' +
            '<label><span>Equipment</span><select data-pm-filter="equipment">' +
              categoryOptions(allEntries, state.filters.equipment) + '</select></label>' +
            '<label><span>Status</span><select data-pm-filter="status">' +
              '<option value="all">All statuses</option>' +
              ["Scheduled", "In Progress", "Overdue", "Completed", "Cancelled"].map(function (statusOption) {
                return '<option value="' + escape(statusOption) + '"' +
                  (state.filters.status === statusOption ? " selected" : "") + '>' +
                  escape(statusOption) + '</option>';
              }).join("") + '</select></label>' +
            '<label class="ep-pm__date-filter"><span>From</span><input type="date" data-pm-filter="dateFrom" ' +
              'min="' + bounds.start + '" max="' + bounds.end + '" value="' +
              escape(state.filters.dateFrom) + '" /></label>' +
            '<label class="ep-pm__date-filter"><span>To</span><input type="date" data-pm-filter="dateTo" ' +
              'min="' + bounds.start + '" max="' + bounds.end + '" value="' +
              escape(state.filters.dateTo) + '" /></label>' +
          '</div><div class="ep-pm__table-wrap"><table class="ep-pm__table ep-pm__task-table">' +
            '<thead><tr><th>Due date</th><th>Equipment</th><th>Maintenance task</th>' +
              '<th>Frequency</th><th>Assignee</th><th>Status</th></tr></thead>' +
            '<tbody>' + taskRows(schedule) + '</tbody></table></div></section>') +
      '<p class="ep-pm__footnote">PM task details open in the existing role-scoped calendar. No schedules are changed here.</p>' +
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
    var currentMonth = businessToday().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(state.month) || state.month > currentMonth) {
      state.error = "Choose a valid month up to the current month.";
      state.loading = false;
      state.calendarLoading = false;
      render();
      return;
    }
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

    withTimeout(Promise.resolve().then(function () {
      return data.fetchCalendarMonth("pm", state.month, state.siteCode || "");
    }), "PM schedule").then(function (result) {
      if (requestId !== state.requestId) return;
      state.entries = result.entries || [];
      state.truncated = !!result.truncated;
      state.limit = result.limit || null;
      state.calendarLoading = false;
      state.calendarError = "";
      render();
    }).catch(function (error) {
      if (requestId !== state.requestId) return;
      state.calendarLoading = false;
      state.calendarError = error && error.message
        ? error.message : "PM schedule could not be loaded.";
      render();
    });
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
            return data.fetchCalendarMonth("pm", state.month, state.siteCode || "");
          }), "PM schedule").then(function (result) {
            if (requestId !== state.requestId) return;
            state.entries = result.entries || [];
            state.truncated = !!result.truncated;
            state.limit = result.limit || null;
            state.calendarLoading = false;
            state.calendarError = "";
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
      var layoutButton = event.target.closest("[data-pm-layout]");
      if (layoutButton) {
        state.layout = layoutButton.getAttribute("data-pm-layout") === "table" ? "table" : "cards";
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
        state.month = event.target.value;
        var bounds = monthBounds(state.month);
        state.filters.dateFrom = bounds.start;
        state.filters.dateTo = bounds.end;
        loadData();
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
    wire(host);
    loadData();
  }

  global.Solar91PortalPMOverview = { show: show };
}(window));
