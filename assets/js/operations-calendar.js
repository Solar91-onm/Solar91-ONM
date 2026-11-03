/**
 * Portfolio and plant-scoped PM / Washing calendars.
 *
 * Every entry is a saved record read through the role-scoped portal API:
 * PM entries are om_tasks rows on their due date, washing entries are
 * washing_daily_reports rows. A plant's Washing page additionally loads the
 * full cycle summary from the washing module. Calendar entries are read-only.
 * The PM setup dialog is a front-end-only preview and does not create schedules.
 */
(function (global) {
  "use strict";

  var data = global.Solar91PortalData;
  var format = global.Solar91PortalFormat;
  var states = {};
  var active = null;
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function monthKey(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1);
  }

  function monthParts(key) {
    var parts = key.split("-").map(Number);
    return { year: parts[0], month: parts[1] };
  }

  function displayDate(key) {
    var parts = key.split("-");
    return pad2(parts[2]) + "-" + pad2(parts[1]) + "-" + parts[0].slice(-2);
  }

  function displayMonth(key) {
    var parts = monthParts(key);
    return new Intl.DateTimeFormat("en-IN", {
      month: "long",
      year: "numeric"
    }).format(new Date(parts.year, parts.month - 1, 1));
  }

  function escape(value) {
    return format.escape(value);
  }

  function contextKey(context) {
    return context.type + ":" + (context.plantCode || "portfolio");
  }

  function getState(context) {
    var key = contextKey(context);
    if (!states[key]) {
      states[key] = {
        month: monthKey(new Date()),
        plants: [],
        events: [],
        loaded: false,
        loading: false,
        error: "",
        requestId: 0,
        plantFilter: "",
        statusFilter: "all",
        search: "",
        modalDate: "",
        modalPlant: "",
        modalStatus: "all",
        modalEquipment: "",
        modalSearch: "",
        detailEventIndex: null,
        liveWashing: false,
        washingPlant: null,
        washingNotConfigured: false,
        washingSetup: null,
        setupAssignees: [],
        setupAssigneesLoaded: false,
        setupOpen: false,
        setupLoading: false,
        setupSaving: false,
        setupError: "",
        pmSetupOpen: false,
        pmSetupPreview: false,
        pmSetupPlant: "",
        pmSetupItems: [],
        washingReports: [],
        recordOpen: false,
        recordCycle: 1,
        recordDrafts: {},
        recordSaving: false,
        recordError: "",
        recordNotice: "",
        tooltips: {}
      };
    }
    return states[key];
  }

  function plantLabel(plant) {
    return plant.displayName || plant.plantName;
  }

  function statusClass(status) {
    if (status === "Completed") return "ep-calendar__event--complete";
    if (status === "Overdue") return "ep-calendar__event--overdue";
    return "ep-calendar__event--pending";
  }

  function visibleEvents(state) {
    var term = state.search.trim().toLowerCase();
    return state.events.filter(function (event) {
      if (state.plantFilter && event.plantSiteCode !== state.plantFilter) return false;
      if (state.statusFilter !== "all" && event.status !== state.statusFilter) return false;
      if (!term) return true;
      return [event.title, event.status, event.plantName, event.plantSiteCode, event.equipmentType]
        .join(" ").toLowerCase().indexOf(term) !== -1;
    });
  }

  function renderPlantOptions(plants, selected, allLabel) {
    return '<option value="">' + escape(allLabel) + '</option>' +
      plants.map(function (plant) {
        return '<option value="' + escape(plant.siteCode) + '"' +
          (plant.siteCode === selected ? " selected" : "") + ">" +
          escape(plantLabel(plant)) + " (" + escape(plant.displayCode) + ")</option>";
      }).join("");
  }

  function renderStatusOptions(events, selected) {
    var statuses = [];
    events.forEach(function (event) {
      if (statuses.indexOf(event.status) === -1) statuses.push(event.status);
    });
    if (selected !== "all" && statuses.indexOf(selected) === -1) statuses.push(selected);
    statuses.sort();
    return '<option value="all">All statuses</option>' +
      statuses.map(function (status) {
        return '<option value="' + escape(status) + '"' +
          (status === selected ? " selected" : "") + ">" +
          escape(status) + "</option>";
      }).join("");
  }

  function equipmentLabel(event, context) {
    return event.equipmentType || (context.type === "washing" ? "Panel washing" : "Preventive maintenance");
  }

  function renderEquipmentOptions(events, selected, context) {
    var labels = [];
    events.forEach(function (event) {
      var label = equipmentLabel(event, context);
      if (label && labels.indexOf(label) === -1) labels.push(label);
    });
    labels.sort();
    return '<option value="">All equipment</option>' +
      labels.map(function (label) {
        return '<option value="' + escape(label) + '"' +
          (selected === label ? " selected" : "") + ">" + escape(label) + "</option>";
      }).join("");
  }

  function renderToolbar(state, context) {
    var isPortfolio = !context.plantCode;
    return '<div class="ep-calendar__toolbar" aria-label="Calendar filters">' +
      (isPortfolio
        ? '<label class="ep-calendar__filter"><span>Plant</span><select data-calendar-filter="plant">' +
          renderPlantOptions(state.plants, state.plantFilter, "All plants") +
          '</select></label>'
        : '<span class="ep-calendar__scope">Plant calendar</span>') +
      '<label class="ep-calendar__filter ep-calendar__filter--search"><span>Search</span>' +
        '<input type="search" data-calendar-filter="search" value="' + escape(state.search) +
        '" placeholder="Search plant or activity" /></label>' +
      '<label class="ep-calendar__filter"><span>Status</span><select data-calendar-filter="status">' +
        renderStatusOptions(state.events, state.statusFilter) +
        '</select></label>' +
    '</div>';
  }

  function renderWashingHoverCard(state, date) {
    var plant = state.washingPlant;
    if (!plant) return "";

    var reportsThroughDate = state.events.filter(function (event) {
      return event.kind === "report" && event.date <= date;
    });
    var reportsOnDate = reportsThroughDate.filter(function (event) {
      return event.date === date;
    });
    var cycleDefinitions = (plant.cycles || []).slice().sort(function (a, b) {
      return Number(a.cycle_no) - Number(b.cycle_no);
    });
    var tableCount = Number(plant.table_count) || 0;
    var recordedCarry = 0;
    var confirmedCarry = 0;
    var cycleProgress = cycleDefinitions.map(function (cycle) {
      var cycleNumber = Number(cycle.cycle_no);
      var reports = reportsThroughDate.filter(function (report) {
        return Number(report.cycleNo) === cycleNumber &&
          (report.reviewStatus === "Pending" || report.reviewStatus === "Confirmed") &&
          report.jobStatus === "Done";
      });
      var confirmedTotal = confirmedCarry + reports.reduce(function (sum, report) {
        return report.reviewStatus === "Confirmed"
          ? sum + (Number(report.tablesCleaned) || 0)
          : sum;
      }, 0);
      var recordedTotal = recordedCarry + reports.reduce(function (sum, report) {
        return sum + (Number(report.tablesCleaned) || 0);
      }, 0);
      var capCarry = cycleNumber < 3 && tableCount > 0;
      var confirmed = capCarry ? Math.min(confirmedTotal, tableCount) : confirmedTotal;
      var recorded = capCarry ? Math.min(recordedTotal, tableCount) : recordedTotal;
      confirmedCarry = capCarry ? Math.max(0, confirmedTotal - tableCount) : 0;
      recordedCarry = capCarry ? Math.max(0, recordedTotal - tableCount) : 0;
      var percent = tableCount ? Math.min(100, Math.round(confirmed * 100 / tableCount)) : 0;
      var status = !tableCount
        ? "Unavailable"
        : confirmed >= tableCount
          ? "Completed"
          : recorded > confirmed
            ? "Awaiting confirmation"
            : date < cycle.start_date
              ? "Upcoming"
              : date > cycle.due_date
                ? "Overdue"
                : "On track";
      return {
        cycle: cycle,
        cycleNumber: cycleNumber,
        confirmed: confirmed,
        pending: Math.max(0, recorded - confirmed),
        percent: percent,
        status: status
      };
    });

    var selected = null;
    reportsOnDate.some(function (report) {
      selected = cycleProgress.find(function (item) {
        return item.cycleNumber === Number(report.cycleNo);
      }) || null;
      return !!selected;
    });
    if (!selected) {
      cycleProgress.forEach(function (item) {
        if (item.cycle.start_date <= date) selected = item;
      });
    }
    if (!selected) selected = cycleProgress[0] || null;

    var pills = cycleProgress.map(function (item) {
      var stateClass = item.status === "Completed" ? "is-done" :
        item === selected ? "is-current" : "";
      return '<span class="ep-wash-cycle-card__pill' +
        (stateClass ? " " + stateClass : "") + '" title="' +
        escape("Cycle " + item.cycleNumber + ": " + item.status) + '">' +
        escape(item.cycleNumber) + "</span>";
    }).join("");
    var dayStatus = reportsOnDate.some(function (report) {
      return report.reviewStatus === "Pending";
    }) ? "Awaiting confirmation" :
      reportsOnDate.some(function (report) {
        return report.reviewStatus === "Confirmed" && report.jobStatus === "Done";
      }) ? "Report confirmed today" :
        reportsOnDate.some(function (report) {
          return report.reviewStatus === "Rejected";
        }) ? "Report rejected" :
          reportsOnDate.length ? "No tables cleaned" : "No report on this date";
    var percent = selected ? selected.percent : 0;
    var assignee = plant.assignee_name || "No Assignee";
    var statusClass = selected && selected.status === "Overdue" ? " is-overdue" :
      selected && selected.status === "Awaiting confirmation" ? " is-awaiting" : "";

    return '<div class="ep-calendar__wash-tip-head"><strong>' +
        escape(plant.plant || plant.plantName ||
          (state.washingSetup && state.washingSetup.plantName) || "Selected plant") + '</strong>' +
        '<span>' + escape(plant.site_code || "") + '</span></div>' +
      '<p class="ep-calendar__wash-tip-date">' + escape(displayDate(date)) + '</p>' +
      '<div class="ep-wash-cycle-card__body ep-calendar__wash-tip-summary">' +
        '<div class="ep-wash-cycle-card__ring" style="--ep-wash-angle:' + Math.round(percent * 3.6) +
          'deg"><span><b>' + percent + '%</b><small>' +
          escape(selected ? "Cycle " + selected.cycleNumber : "No cycle") + '</small></span></div>' +
        '<div class="ep-wash-cycle-card__details">' +
          '<div class="ep-wash-cycle-card__pills">' + pills + '</div>' +
          '<span>' + (selected && tableCount
            ? selected.confirmed + " of " + tableCount + " tables"
            : "Table count unavailable") + '</span>' +
          (selected && selected.pending
            ? '<span>' + selected.pending + ' tables awaiting confirmation</span>'
            : "") +
          '<span>' + escape(dayStatus) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="ep-calendar__wash-tip-foot">' +
        '<span class="ep-wash-cycle-card__status' + statusClass + '">' +
          escape(selected ? selected.status : "Unavailable") + '</span>' +
        '<span>' + escape(assignee) + '</span>' +
      '</div>';
  }

  function renderPreventiveHoverCard(state, date) {
    var jobs = state.events.filter(function (event) {
      return event.date === date;
    });
    if (!jobs.length) return "";

    var plant = state.plants.find(function (item) {
      return item.siteCode === active.context.plantCode;
    });
    var scheduledCount = jobs.filter(function (event) {
      return event.status === "Scheduled";
    }).length;
    var assignees = [];
    jobs.forEach(function (event) {
      var name = (event.assignee || "").trim();
      if (name && assignees.indexOf(name) === -1) assignees.push(name);
    });
    var summary = scheduledCount
      ? scheduledCount + " scheduled"
      : jobs.length + (jobs.length === 1 ? " job" : " jobs");
    var jobCards = jobs.map(function (event) {
      var unit = event.unitNo && event.totalUnits
        ? "Unit " + event.unitNo + " of " + event.totalUnits
        : event.status;
      var description = [event.title, event.frequency].filter(Boolean).join(" · ");
      return '<div class="ep-calendar__pm-tip-job">' +
        '<div class="ep-calendar__pm-tip-job-head"><strong>' +
          escape(equipmentLabel(event, active.context)) + '</strong><span>' +
          escape(unit) + '</span></div>' +
        '<p>' + escape(description) + '</p>' +
      '</div>';
    }).join("");

    return '<div class="ep-calendar__pm-tip-head"><strong>' +
        escape(plant ? plantLabel(plant) : jobs[0].plantName || "Selected plant") + '</strong>' +
        '<span>' + escape(plant ? plant.displayCode : jobs[0].plantSiteCode || "") + '</span></div>' +
      '<p class="ep-calendar__pm-tip-date">' + escape(displayDate(date)) + " · " +
        jobs.length + (jobs.length === 1 ? " job" : " jobs") + '</p>' +
      '<div class="ep-calendar__pm-tip-jobs">' + jobCards + '</div>' +
      '<div class="ep-calendar__pm-tip-foot"><span>' + escape(summary) + '</span>' +
        '<span>' + escape(assignees.join(", ") || "Not assigned") + '</span></div>';
  }

  function positionWashingTooltip(host, day) {
    var tooltip = host.querySelector("[data-calendar-hover-card]");
    if (!tooltip || !day) return;
    var rect = day.getBoundingClientRect();
    var tipRect = tooltip.getBoundingClientRect();
    var gap = 10;
    var left = Math.max(8, Math.min(rect.left, global.innerWidth - tipRect.width - 8));
    var top = rect.top - tipRect.height - gap;
    if (top < 8) top = rect.bottom + gap;
    if (top + tipRect.height > global.innerHeight - 8) {
      top = Math.max(8, global.innerHeight - tipRect.height - 8);
    }
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  }

  function showCalendarHoverCard(host, state, context, day) {
    if (!day) return;
    var isWashing = state.liveWashing && state.washingPlant;
    var isPlantPM = context.type === "pm" && !!context.plantCode;
    if (!isWashing && !isPlantPM) return;
    var tooltip = host.querySelector("[data-calendar-hover-card]");
    if (!tooltip) return;
    var content = isWashing
      ? renderWashingHoverCard(state, day.dataset.date)
      : renderPreventiveHoverCard(state, day.dataset.date);
    if (!content) {
      hideWashingTooltip(host);
      return;
    }
    if (!tooltip || (tooltip.dataset.date === day.dataset.date &&
        tooltip.dataset.requestId === String(state.requestId))) return;
    tooltip.innerHTML = content;
    tooltip.dataset.hoverKind = isWashing ? "washing" : "pm";
    tooltip.dataset.date = day.dataset.date;
    tooltip.dataset.requestId = String(state.requestId);
    tooltip.hidden = false;
    positionWashingTooltip(host, day);
  }

  function hideWashingTooltip(host) {
    var tooltip = host.querySelector("[data-calendar-hover-card]");
    if (!tooltip) return;
    tooltip.hidden = true;
    tooltip.dataset.date = "";
  }

  function renderCalendarGrid(state, events, hoverEnabled, hoverId) {
    var parts = monthParts(state.month);
    var firstDay = new Date(parts.year, parts.month - 1, 1).getDay();
    var daysInMonth = new Date(parts.year, parts.month, 0).getDate();
    var cells = Math.ceil((firstDay + daysInMonth) / 7) * 7;
    var eventsByDate = {};
    events.forEach(function (event) {
      if (!eventsByDate[event.date]) eventsByDate[event.date] = [];
      eventsByDate[event.date].push(event);
    });

    var weekdays = WEEKDAYS.map(function (day) {
      return '<div class="ep-calendar__weekday" role="columnheader">' + day + "</div>";
    }).join("");
    var days = "";
    for (var index = 0; index < cells; index += 1) {
      var dayNumber = index - firstDay + 1;
      var inMonth = dayNumber > 0 && dayNumber <= daysInMonth;
      var date = inMonth
        ? state.month + "-" + pad2(dayNumber)
        : "";
      var dayEvents = date ? (eventsByDate[date] || []) : [];
      var isToday = date === monthKey(new Date()) + "-" + pad2(new Date().getDate());
      var tooltip = date
        ? (state.tooltips[date] || (dayEvents.length
          ? dayEvents.map(function (event) { return event.title; }).join("; ")
          : "No washing report or cycle deadline recorded for this date."))
        : "";
      var classes = "ep-calendar__day";
      if (!inMonth) classes += " ep-calendar__day--outside";
      if (isToday) classes += " ep-calendar__day--today";
      days += '<button type="button" class="' + classes + '"' +
        (inMonth ? ' data-calendar-action="open-date" data-date="' + date + '"' : " disabled") +
        (inMonth
        ? (hoverEnabled ? ' aria-describedby="' + hoverId + '"' : "") +
          ' aria-label="' + escape(displayDate(date) + ", " + dayEvents.length +
            " saved records" +
            (tooltip ? ". " + tooltip : "")) + '"'
        : ' aria-hidden="true"') +
        '><span class="ep-calendar__day-number">' + (inMonth ? dayNumber : "") + "</span>" +
        (dayEvents.length
          ? '<span class="ep-calendar__day-events">' + dayEvents.slice(0, 2).map(function (event) {
              return '<span class="ep-calendar__event ' + statusClass(event.status) + '">' +
                escape(event.title) + "</span>";
            }).join("") +
            (dayEvents.length > 2
              ? '<span class="ep-calendar__more">+' + (dayEvents.length - 2) + " more</span>"
              : "") +
            "</span>"
          : '<span class="ep-calendar__day-empty"></span>') +
      "</button>";
    }
    return '<div class="ep-calendar__grid ep-calendar__grid--weeks-' + (cells / 7) +
      '" role="grid" aria-label="' + escape(displayMonth(state.month)) + '">' +
      weekdays + days + "</div>";
  }

  function renderEventCards(events, context, state) {
    if (!events.length) {
      return '<p class="ep-calendar__empty">' +
        "No saved records match this date and filter." + '</p>';
    }
    return '<div class="ep-calendar__event-list">' + events.map(function (event) {
      var typeLabel = context.type === "pm" ? "Preventive maintenance" : "Panel washing";
      var activityDay = Number(event.date.slice(8, 10));
      var cycleNumber = event.cycleNo || (activityDay <= 10 ? 1 : (activityDay <= 20 ? 2 : 3));
      var cycle = context.type === "washing"
        ? "Cycle " + cycleNumber + " · " + event.date.slice(0, 7)
        : "Scheduled activity · " + event.date.slice(0, 7);
      var eventIndex = state.events.indexOf(event);
      return '<button type="button" class="ep-calendar__event-card" data-calendar-event-index="' +
        eventIndex + '">' +
        '<span class="ep-calendar__event-card-top"><strong>' + escape(equipmentLabel(event, context)) +
          '</strong><span class="' + statusClass(event.status) + '">' + escape(event.status) + '</span></span>' +
        '<span class="ep-calendar__event-card-title">' + escape(event.title) + '</span>' +
        '<span class="ep-calendar__event-card-meta">' +
          escape(event.plantName || (context.plantCode ? "Selected plant" : "Plant not provided")) +
          (event.plantSiteCode ? " · " + escape(event.plantSiteCode) : "") +
          " · " + escape(cycle) + '</span>' +
        '<span class="ep-calendar__event-card-open">View details →</span>' +
      '</button>';
    }).join("") + "</div>";
  }

  function renderPlantPMSummaryEvents(events, state) {
    if (!events.length) {
      return '<p class="ep-calendar__empty">No saved Preventive Maintenance jobs match this search.</p>';
    }
    return '<section class="ep-calendar__pm-summary-group">' +
      '<header><span><i aria-hidden="true"></i><strong>Preventive Maintenance</strong></span>' +
        '<span class="ep-calendar__pm-summary-count">' + events.length + '</span></header>' +
      '<div class="ep-calendar__pm-summary-list">' +
        events.map(function (event) {
          var eventIndex = state.events.indexOf(event);
          var unit = event.unitNo && event.totalUnits
            ? "Unit " + event.unitNo + " of " + event.totalUnits
            : "";
          var meta = [
            event.plantName,
            unit,
            event.frequency,
            event.title
          ].filter(Boolean).join(" · ");
          return '<button type="button" class="ep-calendar__pm-summary-item" data-calendar-event-index="' +
            eventIndex + '">' +
            '<span class="ep-calendar__pm-summary-badge">PM</span>' +
            '<strong>' + escape(equipmentLabel(event, { type: "pm" })) + '</strong>' +
            '<span class="ep-calendar__pm-summary-meta">' + escape(meta) + '</span>' +
            '<span class="ep-calendar__pm-summary-status">' + escape(event.status) + '</span>' +
          '</button>';
        }).join("") +
      '</div>' +
    '</section>';
  }

  function renderPortfolioSummaryEvents(events, context, state) {
    var title = context.type === "pm" ? "Preventive Maintenance" : "Washing";
    if (!events.length) {
      return '<p class="ep-calendar__empty">No saved records match these filters.</p>';
    }

    return '<section class="ep-calendar__pm-summary-group ep-calendar__portfolio-summary-group">' +
      '<header><span><i aria-hidden="true"></i><strong>' + escape(title) + '</strong></span>' +
        '<span class="ep-calendar__pm-summary-count">' + events.length + '</span></header>' +
      '<div class="ep-calendar__pm-summary-list">' +
        events.map(function (event) {
          var eventIndex = state.events.indexOf(event);
          var unit = event.unitNo && event.totalUnits
            ? "Unit " + event.unitNo + " of " + event.totalUnits
            : "";
          var cycle = event.cycleNo ? "Cycle " + event.cycleNo : "";
          var meta = [
            event.plantName,
            event.plantSiteCode,
            unit || cycle,
            event.reference,
            event.title
          ].filter(Boolean).join(" · ");
          return '<button type="button" class="ep-calendar__pm-summary-item" data-calendar-event-index="' +
            eventIndex + '">' +
            '<span class="ep-calendar__pm-summary-badge' +
              (context.type === "washing" ? " ep-calendar__pm-summary-badge--washing" : "") + '">' +
              (context.type === "pm" ? "PM" : "WASH") + '</span>' +
            '<strong>' + escape(equipmentLabel(event, context)) + '</strong>' +
            '<span class="ep-calendar__pm-summary-meta">' + escape(meta) + '</span>' +
            '<span class="ep-calendar__pm-summary-status">' + escape(event.status) + '</span>' +
          '</button>';
        }).join("") +
      '</div>' +
    '</section>';
  }

  function renderEventDetail(state, context) {
    if (!state.modalDate || state.detailEventIndex === null) return "";
    var event = state.events[Number(state.detailEventIndex)];
    if (!event || event.date !== state.modalDate) return "";
    var fields = [
      ["Plant", event.plantName || "Plant not provided"],
      ["Site code", event.plantSiteCode],
      ["Activity", context.type === "pm" ? "Preventive maintenance" : "Panel washing"],
      ["Equipment", equipmentLabel(event, context)],
      ["Reference", event.reference],
      ["Date", displayDate(event.date)],
      ["Status", event.status],
      ["Assigned to", event.assignee || event.reportedBy],
      ["Unit", event.unitNo && event.totalUnits ? event.unitNo + " of " + event.totalUnits : ""],
      ["Frequency", event.frequency],
      ["Completed on", event.completedOn ? displayDate(event.completedOn) : ""],
      ["Cycle", event.cycleNo ? "Cycle " + event.cycleNo : ""],
      ["Tables cleaned", event.tablesCleaned],
      ["Exception", event.exceptionReason],
      ["Remarks", event.remarks]
    ].filter(function (field) {
      return field[1] !== "" && field[1] !== null && field[1] !== undefined;
    });
    return '<div class="ep-calendar__modal ep-calendar__event-detail-modal" data-calendar-event-detail>' +
      '<button class="ep-calendar__backdrop" type="button" data-calendar-action="close-event-detail" aria-label="Close activity details"></button>' +
      '<section class="ep-calendar__dialog ep-calendar__event-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="calendar-event-detail-title">' +
        '<header class="ep-calendar__dialog-head"><div>' +
          '<h2 id="calendar-event-detail-title">' + escape(context.type === "pm" ? "Preventive Maintenance activity" : "Washing activity") + '</h2>' +
        '</div><button type="button" class="ep-calendar__close" data-calendar-action="close-event-detail" aria-label="Close">×</button></header>' +
        '<div class="ep-calendar__event-detail-body">' +
          '<button type="button" class="ep-calendar__close-button" data-calendar-action="close-event-detail">‹ Back to the day</button>' +
          '<div class="ep-calendar__detail">' +
            '<div class="ep-calendar__detail-banner"><strong>' + escape(event.title) +
              '</strong><span>' + escape(event.reference || displayDate(event.date)) + '</span></div>' +
            '<div class="ep-calendar__detail-chips"><span>' + escape(equipmentLabel(event, context)) +
              '</span><span>' + escape(event.status) + '</span></div>' +
            '<dl class="ep-calendar__detail-fields">' +
              fields.map(function (field) {
                return "<div><dt>" + escape(field[0]) + "</dt><dd>" + escape(field[1]) + "</dd></div>";
              }).join("") +
            '</dl><p class="ep-calendar__detail-note">Saved record, shown read-only.</p>' +
          '</div>' +
        '</div>' +
      '</section>' +
    '</div>';
  }

  function modalEvents(state, context) {
    var term = state.modalSearch.trim().toLowerCase();
    return state.events.filter(function (event) {
      if (event.date !== state.modalDate) return false;
      if (state.modalPlant && event.plantSiteCode !== state.modalPlant) return false;
      if (state.modalStatus !== "all" && event.status !== state.modalStatus) return false;
      if (state.modalEquipment && equipmentLabel(event, context) !== state.modalEquipment) return false;
      if (!term) return true;
      return [event.title, event.status, event.plantName, event.plantSiteCode,
        event.equipmentType, event.reference, event.assignee, event.reportedBy]
        .join(" ").toLowerCase().indexOf(term) !== -1;
    });
  }

  function renderModal(state, context) {
    if (!state.modalDate) return "";
    var events = modalEvents(state, context);
    var typeLabel = context.type === "pm" ? "Preventive Maintenance" : "Washing";
    if (!context.plantCode) {
      var totalActivities = state.events.filter(function (event) {
        return event.date === state.modalDate;
      }).length;
      var summaryDate = new Intl.DateTimeFormat("en-IN", {
        weekday: "long", day: "numeric", month: "long", year: "numeric"
      }).format(new Date(state.modalDate + "T12:00:00"));
      var availableEvents = state.events.filter(function (event) {
        return event.date === state.modalDate;
      });
      return '<div class="ep-calendar__modal ep-calendar__pm-summary-modal ep-calendar__portfolio-summary-modal" data-calendar-modal>' +
        '<button class="ep-calendar__backdrop" type="button" data-calendar-action="close-modal" aria-label="Close daily summary"></button>' +
        '<section class="ep-calendar__dialog" role="dialog" aria-modal="true" aria-labelledby="calendar-dialog-title">' +
          '<header class="ep-calendar__pm-summary-head"><h2 id="calendar-dialog-title">Daily summary</h2>' +
            '<button type="button" class="ep-calendar__close" data-calendar-action="close-modal" aria-label="Close">×</button></header>' +
          '<div class="ep-calendar__pm-summary-body">' +
            '<p class="ep-calendar__pm-summary-date">' + escape(summaryDate) + " · " +
              totalActivities + (totalActivities === 1 ? " activity" : " activities") + '</p>' +
            '<label class="ep-calendar__pm-summary-search"><span class="ep-sr-only">Search this date</span>' +
              '<input type="search" data-calendar-filter="modal-search" value="' +
                escape(state.modalSearch) + '" placeholder="Search plant, reference, status..." /></label>' +
            '<div class="ep-calendar__portfolio-summary-filters">' +
              '<label><span class="ep-sr-only">Filter by plant</span><select data-calendar-filter="modal-plant">' +
                renderPlantOptions(state.plants, state.modalPlant, "All plants") +
              '</select></label>' +
              '<label><span class="ep-sr-only">Filter by equipment</span><select data-calendar-filter="modal-equipment">' +
                renderEquipmentOptions(availableEvents, state.modalEquipment, context) +
              '</select></label>' +
              '<label><span class="ep-sr-only">Filter by status</span><select data-calendar-filter="modal-status">' +
                renderStatusOptions(availableEvents, state.modalStatus) +
              '</select></label>' +
            '</div>' +
            renderPortfolioSummaryEvents(events, context, state) +
          '</div>' +
        '</section>' +
      '</div>';
    }
    if (context.type === "pm" && context.plantCode) {
      var selectedPlant = state.plants.find(function (item) {
        return item.siteCode === context.plantCode;
      });
      var totalActivities = state.events.filter(function (event) {
        return event.date === state.modalDate;
      }).length;
      var summaryDate = new Intl.DateTimeFormat("en-IN", {
        weekday: "long", day: "numeric", month: "long", year: "numeric"
      }).format(new Date(state.modalDate + "T12:00:00"));
      return '<div class="ep-calendar__modal ep-calendar__pm-summary-modal" data-calendar-modal>' +
        '<button class="ep-calendar__backdrop" type="button" data-calendar-action="close-modal" aria-label="Close daily summary"></button>' +
        '<section class="ep-calendar__dialog" role="dialog" aria-modal="true" aria-labelledby="calendar-dialog-title">' +
          '<header class="ep-calendar__pm-summary-head"><h2 id="calendar-dialog-title">Daily summary</h2>' +
            '<button type="button" class="ep-calendar__close" data-calendar-action="close-modal" aria-label="Close">×</button></header>' +
          '<div class="ep-calendar__pm-summary-body">' +
            '<p class="ep-calendar__pm-summary-date">' + escape(summaryDate) + " · " +
              totalActivities + (totalActivities === 1 ? " activity" : " activities") +
              (selectedPlant ? " · " + escape(plantLabel(selectedPlant)) : "") + '</p>' +
            '<label class="ep-calendar__pm-summary-search"><span class="ep-sr-only">Search jobs for this date</span>' +
              '<input type="search" data-calendar-filter="modal-search" value="' +
                escape(state.modalSearch) + '" placeholder="Search plant, reference, status..." /></label>' +
            renderPlantPMSummaryEvents(events, state) +
          '</div>' +
        '</section>' +
      '</div>';
    }
    var filters = !context.plantCode
      ? '<div class="ep-calendar__modal-filters">' +
          '<label><span>Search this date</span><input type="search" data-calendar-filter="modal-search" value="' +
            escape(state.modalSearch) + '" placeholder="Plant, equipment, activity or status" /></label>' +
          '<label><span>Plant</span><select data-calendar-filter="modal-plant">' +
            renderPlantOptions(state.plants, state.modalPlant, "All plants") +
          '</select></label>' +
          '<label><span>Equipment</span><select data-calendar-filter="modal-equipment">' +
            renderEquipmentOptions(state.events.filter(function (event) { return event.date === state.modalDate; }),
              state.modalEquipment, context) +
          '</select></label>' +
          '<label><span>Status</span><select data-calendar-filter="modal-status">' +
            renderStatusOptions(state.events.filter(function (event) { return event.date === state.modalDate; }),
              state.modalStatus) +
          '</select></label></div>'
      : '<p class="ep-calendar__modal-scope">Showing this plant only.</p>';
    return '<div class="ep-calendar__modal ep-calendar__modal--drawer" data-calendar-modal>' +
      '<button class="ep-calendar__backdrop" type="button" data-calendar-action="close-modal" aria-label="Close date details"></button>' +
      '<section class="ep-calendar__dialog ep-calendar__drawer" role="dialog" aria-modal="true" aria-labelledby="calendar-dialog-title">' +
        '<header class="ep-calendar__dialog-head"><div>' +
          '<h2 id="calendar-dialog-title">' + escape(typeLabel) + '</h2>' +
        '</div><button type="button" class="ep-calendar__close" data-calendar-action="close-modal" aria-label="Close">×</button></header>' +
        '<div class="ep-calendar__drawer-body"><p class="ep-calendar__drawer-date">' +
          escape(displayDate(state.modalDate)) +
          (context.plantCode ? " · " + escape((state.plants.find(function (item) {
            return item.siteCode === context.plantCode;
          }) || {}).displayName || context.plantCode) : " · Portfolio") +
        '</p>' +
        filters +
        renderEventCards(events, context, state) +
        '</div><footer class="ep-calendar__drawer-footer"><span>' +
          "Saved records · Read only" + '</span>' +
          '<button type="button" class="ep-calendar__close-button" data-calendar-action="close-modal">Close</button></footer>' +
      '</section>' +
    '</div>';
  }

  function canManageWashing() {
    var user = global.Solar91PortalAPI && global.Solar91PortalAPI.currentUser();
    return !!(user && (user.role === "O&M Head" || user.role === "Assignee"));
  }

  function canRecordWashing() {
    var user = global.Solar91PortalAPI && global.Solar91PortalAPI.currentUser();
    return !!(user && ["O&M Head", "Assignee", "Site Engineer"].indexOf(user.role) !== -1);
  }

  function canManagePMSetup() {
    var user = global.Solar91PortalAPI && global.Solar91PortalAPI.currentUser();
    return !!(user && ["O&M Head", "Assignee"].indexOf(user.role) !== -1);
  }

  // ── Work categories: equipment, their parts, and each part's maintenance ──
  // Loaded once from /api/categories. Migration 035 fills the equipment and its
  // reportable faults; 036 fills pm_parts, which is what PM setup needs.
  var PM_CATEGORIES = [];

  function loadPMCategories(onReady) {
    if (PM_CATEGORIES.length) { if (onReady) onReady(); return; }
    var api = global.Solar91PortalAPI;
    if (!api) return;
    api.request("/api/categories").then(function (body) {
      PM_CATEGORIES = (body && body.categories) || [];
      if (onReady) onReady();
    }).catch(function () {
      PM_CATEGORIES = [];          // leave the fields as free text rather than blocking setup
      if (onReady) onReady();
    });
  }

  function pmCategory(name) {
    var key = String(name || "").trim().toLowerCase();
    if (!key) return null;
    return PM_CATEGORIES.filter(function (row) {
      return String(row.name || "").trim().toLowerCase() === key;
    })[0] || null;
  }

  /** Part names for one equipment. */
  // "Select everything of this kind" sentinels. The part and task pickers are
  // free-text datalist inputs, so these are ordinary values the operator can
  // type or pick; the plant <select> uses ALL_PLANTS as its option value.
  var ALL_PLANTS = "__all";
  var ALL_PARTS = "All parts";
  var ALL_TASKS = "All tasks";

  function pmPartsFor(equipment) {
    var row = pmCategory(equipment);
    return ((row && row.pm_parts) || []).map(function (entry) { return entry.part; })
      .filter(Boolean);
  }

  /** Maintenance tasks for one part; every task for the equipment when no part is chosen yet. */
  function pmTasksFor(equipment, part) {
    var row = pmCategory(equipment);
    var parts = (row && row.pm_parts) || [];
    var wanted = String(part || "").trim().toLowerCase();
    var out = [];
    parts.forEach(function (entry) {
      if (wanted && String(entry.part || "").trim().toLowerCase() !== wanted) return;
      (entry.tasks || []).forEach(function (task) {
        if (task && out.indexOf(task) === -1) out.push(task);
      });
    });
    return out;
  }

  function newPMSetupItem() {
    return {
      equipment: "",
      part: "",
      partNumber: "",
      task: "",
      startDate: "",
      frequency: "Monthly",
      remarks: ""
    };
  }

  function renderPMSetupItems(items) {
    return items.map(function (item, index) {
      var field = function (key, label, type, required) {
        return '<label><span>' + label + '</span><input type="' + type +
          '" data-pm-setup-index="' + index + '" data-pm-setup-field="' + key + '"' +
          (required ? " required" : "") + ' value="' + escape(item[key]) + '"' +
          (type === "text" ? ' maxlength="255"' : "") + ' /></label>';
      };
      // A datalist-backed input: it drops down the full list, filters as you type,
      // and still accepts anything you type that is not on the list — so an
      // equipment or part the category list does not cover yet is never a blocker.
      var picker = function (key, label, options, required, hint) {
        var listId = "pm-" + key + "-" + index;
        return '<label><span>' + label + '</span>' +
          '<input type="text" list="' + listId + '" autocomplete="off" maxlength="255"' +
            ' data-pm-setup-index="' + index + '" data-pm-setup-field="' + key + '"' +
            (required ? " required" : "") +
            ' placeholder="' + (options.length ? "Search or pick…" : "Type a value") + '"' +
            ' value="' + escape(item[key]) + '" />' +
          '<datalist id="' + listId + '">' +
            options.map(function (option) {
              return '<option value="' + escape(option) + '"></option>';
            }).join("") +
          '</datalist>' +
          (hint ? '<small class="ep-calendar__pm-setup-hint">' + escape(hint) + '</small>' : "") +
        '</label>';
      };

      var partOptions = pmPartsFor(item.equipment);
      // "All parts" means no single part narrows the task list, so pass none.
      var taskOptions = pmTasksFor(item.equipment, item.part === ALL_PARTS ? "" : item.part);
      var equipmentHint = PM_CATEGORIES.length
        ? ""
        : "No categories configured yet — type the equipment, or add the list in Settings → Categories.";
      var partHint = item.equipment && !partOptions.length && PM_CATEGORIES.length
        ? "No parts listed for this equipment yet."
        : item.part === ALL_PARTS ? "Every part of this equipment is scheduled." : "";

      return '<fieldset class="ep-calendar__pm-setup-item"><legend>PM item ' +
        (index + 1) + '</legend>' +
        '<button type="button" class="ep-calendar__pm-setup-remove" data-calendar-action="remove-pm-item" data-pm-setup-index="' +
          index + '"' + (items.length === 1 ? " disabled" : "") + '>Remove</button>' +
        '<div class="ep-calendar__pm-setup-fields">' +
          picker("equipment", "Equipment", PM_CATEGORIES.map(function (row) { return row.name; }),
                 true, equipmentHint) +
          picker("part", "Part", [ALL_PARTS].concat(partOptions), false, partHint) +
          field("partNumber", "Part number (optional)", "text", false) +
          picker("task", "Maintenance task", [ALL_TASKS].concat(taskOptions), true, "") +
          field("startDate", "First scheduled date", "date", true) +
          '<label><span>Frequency</span><select data-pm-setup-index="' + index +
            '" data-pm-setup-field="frequency">' +
            ["Daily", "Weekly", "Monthly", "Quarterly", "Half-yearly", "Annual"].map(function (frequency) {
              return '<option value="' + frequency + '"' +
                (item.frequency === frequency ? " selected" : "") + ">" + frequency + "</option>";
            }).join("") +
          '</select></label>' +
          '<label class="ep-calendar__pm-setup-remarks"><span>Remarks</span>' +
            '<textarea data-pm-setup-index="' + index + '" data-pm-setup-field="remarks" maxlength="500">' +
              escape(item.remarks) + '</textarea></label>' +
        '</div></fieldset>';
    }).join("");
  }

  function pmSetupPlantName(state, context) {
    var code = context.plantCode || state.pmSetupPlant;
    if (code === ALL_PLANTS) return "All plants (" + state.plants.length + ")";
    var plant = state.plants.find(function (item) { return item.siteCode === code; });
    return plant ? plantLabel(plant) : code;
  }

  function renderPMSetupModal(state, context) {
    if (!state.pmSetupOpen) return "";
    var plantSelector = context.plantCode
      ? '<p class="ep-calendar__pm-setup-plant">' + escape(pmSetupPlantName(state, context) || context.plantCode) + '</p>'
      : '<label class="ep-calendar__pm-setup-plant-select"><span>Plant</span><select name="plant_code" required>' +
        '<option value="">Choose a plant</option>' +
        '<option value="' + ALL_PLANTS + '"' +
          (state.pmSetupPlant === ALL_PLANTS ? " selected" : "") + ">All plants (" +
          state.plants.length + ")</option>" +
        state.plants.map(function (plant) {
          return '<option value="' + escape(plant.siteCode) + '"' +
            (plant.siteCode === state.pmSetupPlant ? " selected" : "") + ">" +
            escape(plantLabel(plant)) + " (" + escape(plant.displayCode) + ")</option>";
        }).join("") +
        '</select></label>';

    return '<div class="ep-calendar__modal ep-calendar__setup-modal ep-calendar__pm-setup-modal" data-pm-setup-modal>' +
      '<button class="ep-calendar__backdrop" type="button" data-calendar-action="close-pm-setup" aria-label="Close PM setup"></button>' +
      '<section class="ep-calendar__dialog" role="dialog" aria-modal="true" aria-labelledby="pm-setup-title">' +
        '<header class="ep-calendar__dialog-head"><div>' +
          '<h2 id="pm-setup-title" tabindex="-1">Set up PM</h2>' +
          '<p>' + (state.pmSetupPreview ? "Review the proposed schedule" : "Add equipment and maintenance details") + '</p>' +
        '</div><button type="button" class="ep-calendar__close" data-calendar-action="close-pm-setup" aria-label="Close">×</button></header>' +
        (state.pmSetupPreview
          ? '<div class="ep-calendar__pm-setup-preview">' +
              '<p class="ep-calendar__pm-setup-notice" role="status">Frontend preview only. Nothing is saved or scheduled yet.</p>' +
              '<p class="ep-calendar__pm-setup-plant">' + escape(pmSetupPlantName(state, context) || "Choose a plant") + '</p>' +
              '<div class="ep-calendar__pm-setup-preview-items">' +
                state.pmSetupItems.map(function (item) {
                  return '<article><h3>' + escape(item.equipment) + ' · ' + escape(item.task) + '</h3>' +
                    '<p>' + escape([item.part, item.partNumber && "Part no. " + item.partNumber]
                      .filter(Boolean).join(" · ") || "No part specified") + '</p>' +
                    '<p>' + escape(item.startDate) + ' · ' + escape(item.frequency) + '</p>' +
                    (item.remarks ? '<p>' + escape(item.remarks) + '</p>' : "") +
                  '</article>';
                }).join("") +
              '</div><footer class="ep-calendar__setup-actions">' +
                '<button type="button" class="ep-calendar__close-button" data-calendar-action="edit-pm-setup">Edit details</button>' +
                '<button type="button" class="ep-calendar__setup-submit" data-calendar-action="close-pm-setup">Close preview</button>' +
              '</footer></div>'
          : '<form class="ep-calendar__setup-form ep-calendar__pm-setup-form" data-pm-setup-form>' +
              plantSelector +
              '<p class="ep-calendar__pm-setup-notice" role="status">Frontend preview only. Nothing is saved or scheduled yet.</p>' +
              '<div class="ep-calendar__pm-setup-items">' + renderPMSetupItems(state.pmSetupItems) + '</div>' +
              '<button type="button" class="ep-calendar__close-button ep-calendar__pm-setup-add" data-calendar-action="add-pm-item">Add another PM item</button>' +
              '<footer class="ep-calendar__setup-actions">' +
                '<button type="button" class="ep-calendar__close-button" data-calendar-action="close-pm-setup">Cancel</button>' +
                '<button type="submit" class="ep-calendar__setup-submit">Preview setup</button>' +
              '</footer></form>') +
      '</section>' +
    '</div>';
  }

  function syncPMSetupForm(host, state) {
    var form = host.querySelector("[data-pm-setup-form]");
    if (!form) return;
    var plant = form.querySelector('[name="plant_code"]');
    if (plant) state.pmSetupPlant = plant.value;
    form.querySelectorAll("[data-pm-setup-index][data-pm-setup-field]").forEach(function (input) {
      var index = Number(input.dataset.pmSetupIndex);
      var field = input.dataset.pmSetupField;
      if (state.pmSetupItems[index] && Object.prototype.hasOwnProperty.call(state.pmSetupItems[index], field)) {
        state.pmSetupItems[index][field] = input.value;
      }
    });
  }

  function dateRange(start, end) {
    var dates = [];
    var current = new Date(start + "T12:00:00");
    var last = new Date(end + "T12:00:00");
    while (current <= last && dates.length < 62) {
      dates.push(current.getFullYear() + "-" + pad2(current.getMonth() + 1) + "-" + pad2(current.getDate()));
      current.setDate(current.getDate() + 1);
    }
    return dates;
  }

  function recordCycle(state) {
    var cycles = state.washingPlant && state.washingPlant.cycles || [];
    return cycles.find(function (cycle) { return Number(cycle.cycle_no) === Number(state.recordCycle); });
  }

  function cycleStartTable(state, cycle, date, carry) {
    var reports = (state.washingReports || []).filter(function (report) {
      return Number(report.cycle_no) === Number(cycle.cycle_no) &&
        report.report_date < date && report.review_status !== "Rejected";
    });
    var used = reports.reduce(function (sum, report) {
      return sum + (Number(report.tables_cleaned) || 0);
    }, 0);
    return Math.max(1, (carry || 0) + used + 1);
  }

  function recordRows(state) {
    var cycle = recordCycle(state);
    if (!cycle || !state.washingPlant) return [];
    var today = state.washingDataToday || new Date().toISOString().slice(0, 10);
    var parts = monthParts(state.month);
    var lastDay = new Date(parts.year, parts.month, 0).getDate();
    var monthLast = state.month + "-" + pad2(lastDay);
    var lastDate = today < monthLast ? today : monthLast;
    var monthStart = state.month + "-01";
    var startDate = cycle.start_date > monthStart ? cycle.start_date : monthStart;
    var cycleReports = (state.washingReports || []).filter(function (report) {
      return Number(report.cycle_no) === Number(cycle.cycle_no) &&
        report.review_status === "Confirmed" && report.cycle_completed;
    });
    var completedOn = cycleReports.reduce(function (latest, report) {
      return !latest || report.report_date > latest ? report.report_date : latest;
    }, "");
    if (completedOn && completedOn < lastDate) lastDate = completedOn;
    if (Number(cycle.cycle_no) > 1) {
      var previousCompletion = (state.washingReports || []).filter(function (report) {
        return Number(report.cycle_no) === Number(cycle.cycle_no) - 1 &&
          report.review_status === "Confirmed" && report.cycle_completed;
      }).reduce(function (latest, report) {
        return !latest || report.report_date > latest ? report.report_date : latest;
      }, "");
      if (previousCompletion) {
        var nextDay = new Date(previousCompletion + "T12:00:00");
        nextDay.setDate(nextDay.getDate() + 1);
        var afterPrevious = nextDay.getFullYear() + "-" + pad2(nextDay.getMonth() + 1) +
          "-" + pad2(nextDay.getDate());
        startDate = afterPrevious;
      }
    }
    if (!canManageWashing()) {
      var firstAllowed = new Date(today + "T12:00:00");
      firstAllowed.setDate(firstAllowed.getDate() - 44);
      var allowedDate = firstAllowed.getFullYear() + "-" + pad2(firstAllowed.getMonth() + 1) +
        "-" + pad2(firstAllowed.getDate());
      if (startDate < allowedDate) startDate = allowedDate;
    }
    if (startDate > lastDate) return [];

    var dates = dateRange(startDate, lastDate);
    var reportsByDate = {};
    (state.washingReports || []).forEach(function (report) {
      reportsByDate[report.report_date] = report;
    });
    var total = Number(state.washingPlant.table_count) || 0;
    var next = cycleStartTable(state, cycle, startDate, 0);
    return dates.map(function (date) {
      var report = reportsByDate[date];
      if (report && report.review_status !== "Rejected") {
        var savedCodes = report.cleaned_table_codes || [];
        var start = savedCodes.length ? tableNumber(savedCodes[0]) : null;
        var end = savedCodes.length ? tableNumber(savedCodes[savedCodes.length - 1]) : null;
        next = end ? (end >= total ? total + 1 : end + 1) : next + (Number(report.tables_cleaned) || 0);
        return { date: date, report: report, start: start, end: end };
      }

      var draft = state.recordDrafts[date] || {};
      var start = next;
      var end = draft.end === undefined || draft.end === "" ? "" : Number(draft.end);
      if (end && end >= start && end <= total) {
        next = end >= total ? total + 1 : end + 1;
      }
      return { date: date, report: null, start: start, end: end, draft: draft };
    });
  }

  function tableNumber(code) {
    var match = String(code || "").match(/(?:Table\s*)?(\d+)$/i);
    return match ? Number(match[1]) : null;
  }

  function renderRecordModal(state) {
    if (!state.recordOpen || !state.washingPlant) return "";
    var cycles = state.washingPlant.cycles || [];
    var cycle = recordCycle(state);
    var rows = recordRows(state);
    var days = rows.map(function (row) {
      var dateLabel = new Intl.DateTimeFormat("en-IN", {
        weekday: "short", day: "2-digit", month: "short"
      }).format(new Date(row.date + "T12:00:00"));
      if (row.report) {
        var codes = row.report.cleaned_table_codes || [];
        var numberStart = codes.length ? tableNumber(codes[0]) : null;
        var numberEnd = codes.length ? tableNumber(codes[codes.length - 1]) : null;
        var numbers = numberStart && numberEnd
          ? numberStart + " – " + numberEnd
          : "—";
        return '<div class="ep-calendar__record-row ep-calendar__record-row--saved">' +
          '<span>' + escape(dateLabel) + '</span><strong>' +
          (row.report.job_status === "Done" ? Number(row.report.tables_cleaned || 0) : "Not done") +
          '</strong><span>' + escape(numbers) + '</span><span>' +
          escape(row.report.remarks || row.report.exception_reason || row.report.review_status) + '</span></div>';
      }
      var count = Number(row.end) >= row.start ? Number(row.end) - row.start + 1 : 0;
      var overLimit = Number(row.end) > Number(state.washingPlant.table_count);
      var unavailable = row.start > Number(state.washingPlant.table_count);
      return '<div class="ep-calendar__record-row" data-record-date="' + row.date + '">' +
        '<label><span class="ep-calendar__record-mobile-label">Day</span><strong>' + escape(dateLabel) + '</strong></label>' +
        '<span class="ep-calendar__record-count" data-record-count>' +
          (count ? count : '<span aria-label="Not entered">—</span>') + '</span>' +
        '<div class="ep-calendar__record-range"><span data-record-start>' + (unavailable ? "—" : row.start) +
          '</span><span>–</span><input type="number" min="' + row.start + '" max="' +
          state.washingPlant.table_count + '" step="1" data-record-end value="' + (row.end || "") +
          '" aria-label="Last table number for ' + escape(dateLabel) + '"' +
          (unavailable || state.recordSaving ? " disabled" : "") + ' /></div>' +
        '<input type="text" data-record-remarks maxlength="4000" placeholder="Remarks" value="' +
          escape(row.draft.remarks || "") + '" aria-label="Remarks for ' + escape(dateLabel) + '"' +
          (unavailable || state.recordSaving ? " disabled" : "") + ' />' +
        '<span class="ep-calendar__record-error" data-record-error' +
          (overLimit ? "" : " hidden") + '>Use a number up to ' +
          state.washingPlant.table_count + '.</span>' +
      '</div>';
    }).join("");

    return '<div class="ep-calendar__modal ep-calendar__record-modal" data-calendar-record-modal>' +
      '<button class="ep-calendar__backdrop" type="button" data-calendar-action="close-record" aria-label="Close record washing"></button>' +
      '<section class="ep-calendar__dialog" role="dialog" aria-modal="true" aria-labelledby="washing-record-title">' +
        '<header class="ep-calendar__dialog-head"><div><h2 id="washing-record-title">' +
          escape(state.washingPlant.plant) + '</h2><p>' + escape(state.washingPlant.site_code) + " · " +
          escape(state.washingPlant.table_count) + " tables · " +
          escape(state.washingPlant.assignee_name || "No Assignee") + '</p></div>' +
          '<button type="button" class="ep-calendar__close" data-calendar-action="close-record" aria-label="Close">×</button></header>' +
        '<div class="ep-calendar__record-progress"><strong>Cycle ' + Number(state.recordCycle) + '</strong>' +
          '<span>' + escape(cycle ? cycle.confirmed : 0) + " of " + escape(state.washingPlant.table_count) +
          " tables · due " + (cycle && cycle.due_date ? escape(displayDate(cycle.due_date)) : "—") + '</span>' +
          '<i><span style="width:' + (cycle && state.washingPlant.table_count
            ? Math.min(100, Math.round(100 * Number(cycle.confirmed || 0) / Number(state.washingPlant.table_count)))
            : 0) + '%"></span></i></div>' +
        '<nav class="ep-calendar__record-tabs" aria-label="Washing cycle">' +
          cycles.map(function (item) {
            return '<button type="button" data-record-cycle="' + item.cycle_no + '"' +
              (Number(item.cycle_no) === Number(state.recordCycle) ? ' aria-current="true"' : "") + '>' +
              'Cycle ' + item.cycle_no + '</button>';
          }).join("") +
        '</nav>' +
        '<div class="ep-calendar__record-body">' +
          (state.recordError ? '<p class="ep-calendar__record-error" role="alert">' + escape(state.recordError) + '</p>' : "") +
          (state.recordNotice ? '<p class="ep-calendar__record-notice" role="status">' + escape(state.recordNotice) + '</p>' : "") +
          (rows.length
            ? '<div class="ep-calendar__record-table"><div class="ep-calendar__record-head"><span>Day</span><span>Tables</span><span>Table numbers</span><span>Remarks</span></div>' +
              days + '</div>'
            : '<p class="ep-calendar__empty">No reportable days for this cycle yet.</p>') +
          '<p class="ep-calendar__record-help">Enter the last table number cleaned. The next day starts from the next table number.</p>' +
        '</div>' +
        '<footer class="ep-calendar__record-footer"><button type="button" class="ep-calendar__close-button" data-calendar-action="close-record"' +
          (state.recordSaving ? " disabled" : "") + '>Cancel</button>' +
          '<button type="button" class="ep-calendar__setup-submit" data-calendar-action="save-record"' +
            (state.recordSaving || !rows.some(function (row) { return !row.report && row.end; }) ? " disabled" : "") + '>' +
            (state.recordSaving ? "Saving…" : "Save") + '</button></footer>' +
      '</section>' +
    '</div>';
  }

  function renderSetupModal(state) {
    if (!state.setupOpen) return "";
    var setup = state.washingSetup || {};
    var assignees = state.setupAssignees || [];
    var noAssignees = state.setupAssigneesLoaded && !assignees.length;
    return '<div class="ep-calendar__modal ep-calendar__setup-modal" data-calendar-setup-modal>' +
      '<button class="ep-calendar__backdrop" type="button" data-calendar-action="close-setup" aria-label="Close washing setup"></button>' +
      '<section class="ep-calendar__dialog" role="dialog" aria-modal="true" aria-labelledby="washing-setup-title">' +
        '<header class="ep-calendar__dialog-head"><div>' +
          '<h2 id="washing-setup-title">Set up washing</h2>' +
          '<p>' + escape(setup.plantName || "Selected plant") + " · " + escape(setup.siteCode || "") + '</p>' +
        '</div><button type="button" class="ep-calendar__close" data-calendar-action="close-setup" aria-label="Close">×</button></header>' +
        (state.setupLoading
          ? '<p class="ep-calendar__setup-message" role="status">Loading active Assignees…</p>'
          : '<form class="ep-calendar__setup-form" data-calendar-setup-form>' +
              '<label><span>Tables in each cycle</span>' +
                '<input type="number" name="table_count" min="1" max="5000" step="1" required value="' +
                  escape(setup.tableCount || "") + '"' + (state.setupSaving ? " disabled" : "") + ' /></label>' +
              '<label><span>Washing Assignee</span><select name="assignee_user_id" required' +
                (state.setupSaving || noAssignees ? " disabled" : "") + '>' +
                '<option value="">Choose an Assignee</option>' +
                assignees.map(function (assignee) {
                  return '<option value="' + escape(assignee.id) + '"' +
                    (assignee.id === setup.assigneeUserId ? " selected" : "") + ">" +
                    escape(assignee.name) + "</option>";
                }).join("") +
              '</select></label>' +
              (noAssignees
                ? '<p class="ep-calendar__setup-message" role="alert">No active Assignees are available. Add an Assignee in Team access first.</p>'
                : "") +
              (state.setupError
                ? '<p class="ep-calendar__setup-error" role="alert">' + escape(state.setupError) + '</p>'
                : "") +
              '<footer class="ep-calendar__setup-actions">' +
                '<button type="button" class="ep-calendar__close-button" data-calendar-action="close-setup"' +
                  (state.setupSaving ? " disabled" : "") + '>Cancel</button>' +
                '<button type="submit" class="ep-calendar__setup-submit"' +
                  (state.setupSaving || noAssignees ? " disabled" : "") + '>' +
                  (state.setupSaving ? "Saving…" : "Save setup") + '</button>' +
              '</footer>' +
            '</form>') +
      '</section>' +
    '</div>';
  }

  function renderView(host, state, context) {
    var typeLabel = context.type === "pm" ? "Preventive Maintenance" : "Washing";
    var plant = context.plantCode && state.plants.find(function (item) {
      return item.siteCode === context.plantCode;
    });
    var subtitle = context.plantCode
      ? "Plant calendar for " + (plant ? plantLabel(plant) : context.plantCode) + "."
      : "Portfolio calendar across all plants.";
    var events = visibleEvents(state);
    var statusCounts = events.length + (events.length === 1
      ? " saved record"
      : " saved records");
    var content = "";
    var hoverEnabled = !!(context.plantCode && (
      context.type === "pm" || (state.liveWashing && state.washingPlant)
    ));
    var hoverId = context.type === "pm"
      ? "calendar-pm-hover-card"
      : "calendar-washing-hover-card";
    if (state.loading) {
      content = '<div class="ep-calendar__message" role="status">' +
        "Loading saved records…" + '</div>';
    } else if (state.error) {
      content = '<div class="ep-calendar__message ep-calendar__message--error" role="alert">' +
        '<p>Calendar could not be loaded: ' + escape(state.error) + '</p>' +
        '<button type="button" data-calendar-action="retry">Try again</button></div>';
    } else {
      content = renderCalendarGrid(state, events, hoverEnabled, hoverId);
    }
    var showSetupButton = state.liveWashing && state.washingSetup &&
      context.plantCode && canManageWashing();
    var showRecordButton = state.liveWashing && state.washingPlant &&
      context.plantCode && canRecordWashing();
    var showPMSetupButton = context.type === "pm" && canManagePMSetup();
    host.innerHTML = '<div class="ep-calendar">' +
      '<header class="ep-calendar__head"><div><p class="ep-calendar__eyebrow">' +
        (context.plantCode ? "Plant view" : "Views") + '</p><h1>' + escape(typeLabel) +
        '</h1><p class="ep-calendar__subtitle">' + escape(subtitle) +
        (state.liveWashing
          ? " Cycle progress and dates come from saved washing records. Hover a date for its reports and deadline."
          : " Entries are saved records on their scheduled date.") + '</p></div>' +
        '<div class="ep-calendar__head-actions"><span class="ep-calendar__count">' + escape(statusCounts) + '</span>' +
          (showRecordButton
            ? '<button type="button" class="ep-calendar__setup-button" data-calendar-action="open-record">Record washing</button>'
            : "") +
          (showSetupButton
            ? '<button type="button" class="ep-calendar__setup-button" data-calendar-action="open-setup">Set up washing</button>'
            : "") +
          (showPMSetupButton
            ? '<button type="button" class="ep-calendar__setup-button" data-calendar-action="open-pm-setup">Set up PM</button>'
            : "") +
          // Import / Export of the PM plan sits beside Set up PM, on the PM calendar only.
          (context.type === "pm" && global.Solar91RegisterIO
            ? global.Solar91RegisterIO.controls("pm", { canImport: canManagePMSetup() })
            : "") +
        '</div></header>' +
        renderToolbar(state, context) +
        '<div class="ep-calendar__monthbar">' +
        '<div class="ep-calendar__month-nav"><button type="button" data-calendar-action="previous" aria-label="Previous month">‹</button>' +
          '<h2>' + escape(displayMonth(state.month)) + '</h2>' +
          '<button type="button" data-calendar-action="next" aria-label="Next month">›</button>' +
        '</div><button type="button" class="ep-calendar__today" data-calendar-action="today">Today</button>' +
      '</div>' +
      content +
      (hoverEnabled
        ? '<div class="ep-calendar__wash-hover-card' +
          (context.type === "pm" ? ' ep-calendar__pm-hover-card' : "") +
          '" id="' + hoverId + '" ' +
          'data-calendar-hover-card role="tooltip" hidden></div>'
        : '') +
      '<p class="ep-calendar__disclaimer">' +
        (state.liveWashing
          ? "Entries are live and role-scoped. Record daily table ranges from the plant calendar."
          : "Entries are live, role-scoped, read-only records. Scheduling and reporting happen in their own workflows.") +
      '</p>' +
      renderModal(state, context) +
      renderEventDetail(state, context) +
      renderPMSetupModal(state, context) +
      renderSetupModal(state) +
      renderRecordModal(state) +
    '</div>';
  }

  function loadLiveWashing(host, state, context, requestId) {
    var api = global.Solar91PortalAPI;
    return api.plants().then(function (portalPlants) {
      var rows = portalPlants.map(function (p) {
        return { id: p.dbId, site_code: p.siteCode, plant_name: p.plantName, project_company: p.projectCompany };
      });
      state.plants = rows.map(function (plant) {
        return {
          id: String(plant.id),
          dbId: String(plant.id),
          siteCode: plant.site_code,
          displayCode: plant.site_code,
          plantName: plant.plant_name,
          displayName: plant.plant_name
        };
      });
      var selected = state.plants.find(function (plant) { return plant.siteCode === context.plantCode; });
      if (!selected) throw new Error("This plant is not in your authorized plant list.");
      var queryMonth = encodeURIComponent(state.month);
      var cyclesUrl = "/api/scheduled/washing/plants/" + encodeURIComponent(selected.dbId) +
        "/cycles?month=" + queryMonth;
      return Promise.all([
        api.request("/api/scheduled/washing/overview?month=" + queryMonth),
        api.request(cyclesUrl).catch(function (error) {
          if (error.status === 409 && /not been set up/i.test(error.message)) return null;
          throw error;
        })
      ]).then(function (results) {
        if (requestId !== state.requestId) return;
        var overview = results[0];
        var cyclesData = results[1];
        state.liveWashing = true;
        state.washingNotConfigured = !cyclesData;
        state.washingDataToday = cyclesData ? cyclesData.today : overview.today;
        var overviewPlant = (overview.plants || []).find(function (plant) {
          return String(plant.plant_id) === selected.dbId;
        });
        state.washingSetup = {
          plantId: selected.dbId,
          plantName: selected.plantName,
          siteCode: selected.siteCode,
          tableCount: cyclesData ? cyclesData.table_count : (overviewPlant && overviewPlant.table_count) || "",
          assigneeUserId: overviewPlant && overviewPlant.assignee_user_id || "",
          complianceThreshold: overviewPlant && overviewPlant.compliance_threshold_percent || 85
        };
        state.washingPlant = cyclesData
          ? overviewPlant || {
            plant_id: selected.dbId,
            plant: selected.plantName,
            site_code: selected.siteCode,
            table_count: cyclesData.table_count,
            cycles_this_month: cyclesData.summary && cyclesData.summary.cycles_completed || 0,
            monthly_target: 3,
            assignee_name: ""
          }
          : null;

        if (!cyclesData) {
          state.washingReports = [];
          state.events = [];
          state.tooltips = {};
          state.loading = false;
          state.loaded = true;
          state.error = "";
          if (active && active.host === host && active.state === state) renderView(host, state, context);
          return;
        }

        state.washingPlant.cycles = cyclesData.cycles || [];
        state.washingPlant.table_count = cyclesData.table_count;
        state.washingReports = cyclesData.reports || [];
        if (state.recordOpen && state.recordCycle) {
          var selectedCycleData = state.washingPlant.cycles.find(function (cycle) {
            return Number(cycle.cycle_no) === Number(state.recordCycle);
          });
          var inProgressCycle = state.washingPlant.cycles.find(function (cycle) {
            return cycle.state === "In progress";
          });
          if (selectedCycleData && selectedCycleData.state === "Completed" && inProgressCycle) {
            state.recordCycle = Number(inProgressCycle.cycle_no);
          }
        }
        state.washingPlant.monthly_target = 3;
        state.washingPlant.cycles_this_month = (cyclesData.cycles || []).filter(function (cycle) {
          return cycle.state === "Completed";
        }).length;
        var events = [];
        (cyclesData.cycles || []).forEach(function (cycle) {
          if (!cycle.due_date) return;
          events.push({
            date: cycle.due_date,
            title: "Cycle " + cycle.cycle_no + " deadline",
            status: cycle.state === "Completed"
              ? "Completed"
              : cycle.due_date < cyclesData.today ? "Overdue" : "Scheduled",
            plantSiteCode: selected.siteCode,
            plantName: selected.plantName,
            cycleNo: cycle.cycle_no,
            source: "Saved cycle schedule",
            kind: "deadline"
          });
        });
        (cyclesData.reports || []).forEach(function (report) {
          var status = report.review_status === "Pending"
            ? "Awaiting confirmation"
            : report.review_status === "Rejected"
              ? "Rejected"
              : report.job_status === "Done" ? "Completed" : "Not done";
          events.push({
            date: report.report_date,
            title: report.job_status === "Done"
              ? Number(report.tables_cleaned || 0) + " tables washed"
              : "No washing reported",
            status: status,
            plantSiteCode: selected.siteCode,
            plantName: selected.plantName,
            cycleNo: report.cycle_no,
            tablesCleaned: report.tables_cleaned,
            reviewStatus: report.review_status,
            jobStatus: report.job_status,
            reportedBy: report.reported_by,
            remarks: report.remarks,
            source: "Saved daily report",
            kind: "report"
          });
        });
        events.sort(function (a, b) {
          return a.date.localeCompare(b.date) || a.title.localeCompare(b.title);
        });
        state.events = events;
        state.tooltips = {};
        events.forEach(function (event) {
          var detail = event.title + " · Cycle " + event.cycleNo + " · " + event.status;
          if (event.reportedBy) detail += " · " + event.reportedBy;
          if (!state.tooltips[event.date]) state.tooltips[event.date] = [];
          state.tooltips[event.date].push(detail);
        });
        Object.keys(state.tooltips).forEach(function (day) {
          state.tooltips[day] = state.tooltips[day].join("; ");
        });
        state.loading = false;
        state.loaded = true;
        state.error = "";
        if (active && active.host === host && active.state === state) renderView(host, state, context);
      });
    }).catch(function (error) {
      if (requestId !== state.requestId) return;
      state.loading = false;
      state.error = error.message || "Could not load saved washing cycle data.";
      if (active && active.host === host && active.state === state) renderView(host, state, context);
    });
  }

  function loadEvents(host, state, context, keepRecord) {
    state.loading = true;
    state.loaded = false;
    state.error = "";
    state.events = [];
    state.liveWashing = !!(
      context.type === "washing" &&
      context.plantCode &&
      global.Solar91PortalAPI &&
      global.Solar91PortalAPI.isPortalRoute()
    );
    state.washingPlant = null;
    state.washingNotConfigured = false;
    state.washingReports = [];
    state.washingSetup = null;
    state.setupOpen = false;
    state.setupLoading = false;
    state.setupSaving = false;
    state.setupError = "";
    if (!keepRecord) {
      state.recordOpen = false;
      state.recordSaving = false;
      state.recordError = "";
      state.recordNotice = "";
      state.recordDrafts = {};
    }
    state.washingDataToday = "";
    state.tooltips = {};
    state.requestId += 1;
    var requestId = state.requestId;
    renderView(host, state, context);

    if (state.liveWashing) {
      loadLiveWashing(host, state, context, requestId);
      return;
    }

    data.fetchPortfolio().then(function (portfolio) {
      state.plants = portfolio.rows.map(function (row) { return row.plant; });
      var rows = context.plantCode
        ? portfolio.rows.filter(function (row) { return row.plant.siteCode === context.plantCode; })
        : portfolio.rows;
      if (context.plantCode && !rows.length) {
        throw new Error("The selected plant is not in the portal catalogue.");
      }
      return Promise.all(rows.map(function (row) {
        return data.fetchCalendarActivities(row.plant, row.profile, context.type, state.month);
      }));
    }).then(function (eventGroups) {
      if (requestId !== state.requestId) return;
      state.events = eventGroups.reduce(function (all, group) {
        return all.concat(group);
      }, []).sort(function (a, b) {
        return a.date.localeCompare(b.date) ||
          a.plantName.localeCompare(b.plantName) ||
          a.title.localeCompare(b.title);
      });
      state.loading = false;
      state.loaded = true;
      if (active && active.host === host && active.state === state) renderView(host, state, context);
    }).catch(function (error) {
      if (requestId !== state.requestId) return;
      state.loading = false;
      state.error = error.message || "Unknown data error.";
      if (active && active.host === host && active.state === state) renderView(host, state, context);
    });
  }

  function refreshKeepingFocus(host, state, context, selector) {
    var oldInput = host.querySelector(selector);
    var position = oldInput && typeof oldInput.selectionStart === "number"
      ? oldInput.selectionStart
      : null;
    renderView(host, state, context);
    var newInput = host.querySelector(selector);
    if (newInput) {
      newInput.focus();
      if (position !== null && typeof newInput.setSelectionRange === "function") {
        newInput.setSelectionRange(position, position);
      }
    }
  }

  function syncRecordRangeInputs(host, state) {
    host.querySelectorAll("[data-record-date]").forEach(function (row) {
      var endInput = row.querySelector("[data-record-end]");
      var remarksInput = row.querySelector("[data-record-remarks]");
      state.recordDrafts[row.dataset.recordDate] = {
        end: endInput ? endInput.value : "",
        remarks: remarksInput ? remarksInput.value : ""
      };
    });
    var rows = recordRows(state);
    rows.forEach(function (item) {
      if (item.report) return;
      var row = host.querySelector('[data-record-date="' + item.date + '"]');
      if (!row) return;
      var endInput = row.querySelector("[data-record-end]");
      var count = Number(item.end) >= item.start ? Number(item.end) - item.start + 1 : 0;
      var overLimit = Number(item.end) > Number(state.washingPlant.table_count);
      var unavailable = item.start > Number(state.washingPlant.table_count);
      row.querySelector("[data-record-start]").textContent = unavailable ? "—" : item.start;
      row.querySelector("[data-record-count]").textContent = count || "—";
      var error = row.querySelector("[data-record-error]");
      if (error) {
        error.hidden = !overLimit;
        if (overLimit) error.textContent = "Use a number up to " + state.washingPlant.table_count + ".";
      }
      if (endInput) {
        endInput.min = item.start;
        endInput.disabled = unavailable || state.recordSaving;
      }
    });
    var save = host.querySelector('[data-calendar-action="save-record"]');
    if (save) {
      save.disabled = state.recordSaving || !rows.some(function (row) {
        return !row.report && Number(row.end) >= row.start &&
          Number(row.end) <= Number(state.washingPlant.table_count);
      });
    }
  }

  function wire(host) {
    if (host.dataset.calendarWired === "true") return;
    host.dataset.calendarWired = "true";

    host.addEventListener("click", function (event) {
      if (!active || active.host !== host) return;
      var cycleTab = event.target.closest("[data-record-cycle]");
      if (cycleTab && active.state.recordOpen) {
        active.state.recordCycle = Number(cycleTab.dataset.recordCycle);
        active.state.recordDrafts = {};
        active.state.recordError = "";
        renderView(host, active.state, active.context);
        return;
      }
      var eventCard = event.target.closest("[data-calendar-event-index]");
      if (eventCard && active.state.modalDate) {
        active.state.detailEventIndex = Number(eventCard.dataset.calendarEventIndex);
        renderView(host, active.state, active.context);
        var detailClose = host.querySelector('[data-calendar-event-detail] .ep-calendar__close');
        if (detailClose) detailClose.focus();
        return;
      }
      // The shared Import / Export control handles its own clicks.
      if (global.Solar91RegisterIO && global.Solar91RegisterIO.handleClick(event, {
        siteCode: (active.context && active.context.plantCode) || "",
        onImported: function () { loadEvents(host, active.state, active.context); }
      })) return;
      var action = event.target.closest("[data-calendar-action]");
      if (!action) return;
      var state = active.state;
      var context = active.context;

      if (action.dataset.calendarAction === "previous" || action.dataset.calendarAction === "next") {
        var parts = monthParts(state.month);
        var shift = action.dataset.calendarAction === "previous" ? -1 : 1;
        state.month = monthKey(new Date(parts.year, parts.month - 1 + shift, 1));
        state.modalDate = "";
        state.detailEventIndex = null;
        loadEvents(host, state, context);
      } else if (action.dataset.calendarAction === "today") {
        state.month = monthKey(new Date());
        state.modalDate = "";
        state.detailEventIndex = null;
        loadEvents(host, state, context);
      } else if (action.dataset.calendarAction === "open-date") {
        state.modalDate = action.dataset.date;
        state.modalPlant = "";
        state.modalStatus = "all";
        state.modalEquipment = "";
        state.modalSearch = "";
        state.detailEventIndex = null;
        renderView(host, state, context);
        var closeButton = host.querySelector(".ep-calendar__close");
        if (closeButton) closeButton.focus();
      } else if (action.dataset.calendarAction === "close-event-detail") {
        state.detailEventIndex = null;
        renderView(host, state, context);
        var summaryClose = host.querySelector('[data-calendar-modal] .ep-calendar__close');
        if (summaryClose) summaryClose.focus();
      } else if (action.dataset.calendarAction === "close-modal") {
        state.detailEventIndex = null;
        state.modalDate = "";
        renderView(host, state, context);
      } else if (action.dataset.calendarAction === "retry") {
        loadEvents(host, state, context);
      } else if (action.dataset.calendarAction === "open-pm-setup") {
        if (!canManagePMSetup()) return;
        state.pmSetupOpen = true;
        state.pmSetupPreview = false;
        state.pmSetupPlant = context.plantCode || "";
        state.pmSetupItems = [newPMSetupItem()];
        renderView(host, state, context);
        // Equipment, parts and tasks come from the category list; fetch it the
        // first time the dialog is opened and redraw once it lands.
        loadPMCategories(function () {
          if (state.pmSetupOpen && !state.pmSetupPreview) {
            syncPMSetupForm(host, state);
            renderView(host, state, context);
          }
        });
        var firstEquipment = host.querySelector('[data-pm-setup-field="equipment"]');
        if (firstEquipment) firstEquipment.focus();
      } else if (action.dataset.calendarAction === "close-pm-setup") {
        state.pmSetupOpen = false;
        state.pmSetupPreview = false;
        renderView(host, state, context);
      } else if (action.dataset.calendarAction === "edit-pm-setup") {
        state.pmSetupPreview = false;
        renderView(host, state, context);
      } else if (action.dataset.calendarAction === "add-pm-item") {
        syncPMSetupForm(host, state);
        state.pmSetupItems.push(newPMSetupItem());
        renderView(host, state, context);
        var newEquipment = host.querySelector('[data-pm-setup-index="' +
          (state.pmSetupItems.length - 1) + '"][data-pm-setup-field="equipment"]');
        if (newEquipment) newEquipment.focus();
      } else if (action.dataset.calendarAction === "remove-pm-item") {
        syncPMSetupForm(host, state);
        state.pmSetupItems.splice(Number(action.dataset.pmSetupIndex), 1);
        renderView(host, state, context);
      } else if (action.dataset.calendarAction === "open-setup") {
        if (!canManageWashing() || !state.washingSetup) return;
        state.setupOpen = true;
        state.setupLoading = true;
        state.setupError = "";
        renderView(host, state, context);
        global.Solar91PortalAPI.request("/api/scheduled/washing/assignees").then(function (assignees) {
          if (!active || active.host !== host || active.state !== state || !state.setupOpen) return;
          state.setupAssignees = assignees;
          state.setupAssigneesLoaded = true;
          state.setupLoading = false;
          renderView(host, state, context);
          var countInput = host.querySelector('[data-calendar-setup-form] [name="table_count"]');
          if (countInput) countInput.focus();
        }).catch(function (error) {
          if (!active || active.host !== host || active.state !== state || !state.setupOpen) return;
          state.setupLoading = false;
          state.setupError = "Could not load active Assignees. " +
            (error && error.message ? error.message : "Please retry.");
          renderView(host, state, context);
        });
      } else if (action.dataset.calendarAction === "close-setup") {
        if (state.setupSaving) return;
        state.setupOpen = false;
        state.setupError = "";
        renderView(host, state, context);
      } else if (action.dataset.calendarAction === "open-record") {
        if (!canRecordWashing() || !state.washingPlant) return;
        var cycles = state.washingPlant.cycles || [];
        var selectedCycle = cycles.find(function (cycle) { return cycle.state === "In progress"; }) ||
          cycles.find(function (cycle) { return cycle.state === "Upcoming"; }) ||
          cycles.find(function (cycle) { return cycle.state === "Missed"; }) || cycles[0];
        state.recordCycle = selectedCycle ? Number(selectedCycle.cycle_no) : 1;
        state.recordOpen = true;
        state.recordDrafts = {};
        state.recordError = "";
        state.recordNotice = "";
        renderView(host, state, context);
      } else if (action.dataset.calendarAction === "close-record") {
        if (state.recordSaving) return;
        state.recordOpen = false;
        state.recordError = "";
        state.recordNotice = "";
        renderView(host, state, context);
      } else if (action.dataset.calendarAction === "save-record") {
        if (state.recordSaving || !canRecordWashing() || !state.washingSetup) return;
        syncRecordRangeInputs(host, state);
        var rows = recordRows(state);
        var entries = [];
        var invalidRange = false;
        rows.forEach(function (row) {
          if (row.report || row.end === "" || row.end === null || row.end === undefined) return;
          var end = Number(row.end);
          if (!Number.isInteger(end) || end < row.start ||
              end > Number(state.washingPlant.table_count)) {
            invalidRange = true;
            return;
          }
          entries.push({
            report_date: row.date,
            job_status: "Done",
            table_start: row.start,
            table_end: end,
            tables_cleaned: end - row.start + 1,
            remarks: row.draft.remarks || null
          });
        });
        if (invalidRange || !entries.length) {
          state.recordError = invalidRange
            ? "Check each table range. The last table must be at least the first and no greater than the plant's table count."
            : "Enter a last table number for at least one day.";
          renderView(host, state, context);
          return;
        }
        state.recordSaving = true;
        state.recordError = "";
        renderView(host, state, context);
        global.Solar91PortalAPI.request("/api/scheduled/washing/daily-reports/sheet", {
          method: "POST",
          body: { plant_id: state.washingSetup.plantId, entries: entries }
        }).then(function (result) {
          if (!active || active.host !== host || active.state !== state) return;
          state.recordSaving = false;
          state.recordDrafts = {};
          state.recordNotice = "Saved " + result.saved + " washing day" +
            (result.saved === 1 ? "" : "s") + ".";
          loadEvents(host, state, active.context, true);
        }).catch(function (error) {
          if (!active || active.host !== host || active.state !== state) return;
          state.recordSaving = false;
          state.recordError = "Washing was not saved. " +
            (error && error.message ? error.message : "Please retry.");
          renderView(host, state, active.context);
        });
      }
    });

    host.addEventListener("submit", function (event) {
      var pmForm = event.target.closest("[data-pm-setup-form]");
      if (pmForm && active && active.host === host) {
        event.preventDefault();
        syncPMSetupForm(host, active.state);
        active.state.pmSetupPreview = true;
        renderView(host, active.state, active.context);
        var previewTitle = host.querySelector("#pm-setup-title");
        if (previewTitle) previewTitle.focus();
        return;
      }
      var form = event.target.closest("[data-calendar-setup-form]");
      if (!form || !active || active.host !== host) return;
      event.preventDefault();
      var state = active.state;
      var setup = state.washingSetup;
      if (state.setupSaving || !setup || !canManageWashing()) return;
      var count = Number(form.elements.table_count.value);
      var assigneeId = form.elements.assignee_user_id.value;
      if (!Number.isInteger(count) || count < 1 || count > 5000) {
        state.setupError = "Enter a table count between 1 and 5000.";
        renderView(host, state, active.context);
        return;
      }
      if (!assigneeId) {
        state.setupError = "Choose an active Assignee.";
        renderView(host, state, active.context);
        return;
      }
      state.setupSaving = true;
      state.setupError = "";
      renderView(host, state, active.context);
      global.Solar91PortalAPI.request("/api/scheduled/washing/setup", {
        method: "POST",
        body: {
          plant_id: setup.plantId,
          table_count: count,
          assignee_user_id: assigneeId,
          compliance_threshold_percent: setup.complianceThreshold || 85
        }
      }).then(function () {
        if (!active || active.host !== host || active.state !== state) return;
        state.setupOpen = false;
        state.setupSaving = false;
        loadEvents(host, state, active.context);
      }).catch(function (error) {
        if (!active || active.host !== host || active.state !== state) return;
        state.setupSaving = false;
        state.setupError = "Setup was not saved. " +
          (error && error.message ? error.message : "Please retry.");
        renderView(host, state, active.context);
      });
    });

    host.addEventListener("pointerover", function (event) {
      if (!active || active.host !== host) return;
      var day = event.target.closest(".ep-calendar__day[data-date]");
      if (day) showCalendarHoverCard(host, active.state, active.context, day);
    });

    host.addEventListener("pointerout", function (event) {
      if (!active || active.host !== host) return;
      var tooltip = event.target.closest("[data-calendar-hover-card]");
      var day = event.target.closest(".ep-calendar__day[data-date]");
      var related = event.relatedTarget;
      var relatedElement = related && typeof related.closest === "function" ? related : null;
      if (relatedElement && (
        (day && day.contains(relatedElement)) ||
        (tooltip && tooltip.contains(relatedElement)) ||
        relatedElement.closest(".ep-calendar__day[data-date]") ||
        relatedElement.closest("[data-calendar-hover-card]")
      )) return;
      hideWashingTooltip(host);
    });

    host.addEventListener("focusin", function (event) {
      if (!active || active.host !== host) return;
      var day = event.target.closest(".ep-calendar__day[data-date]");
      if (day) showCalendarHoverCard(host, active.state, active.context, day);
    });

    host.addEventListener("focusout", function (event) {
      var related = event.relatedTarget;
      if (related && typeof related.closest === "function" &&
          related.closest(".ep-calendar__day[data-date]")) return;
      hideWashingTooltip(host);
    });

    host.addEventListener("input", function (event) {
      if (!active || active.host !== host) return;
      var filter = event.target.dataset.calendarFilter;
      if (filter === "search") {
        active.state.search = event.target.value;
        refreshKeepingFocus(host, active.state, active.context, '[data-calendar-filter="search"]');
      } else if (filter === "modal-search") {
        active.state.modalSearch = event.target.value;
        refreshKeepingFocus(host, active.state, active.context, '[data-calendar-filter="modal-search"]');
      } else if (event.target.matches("[data-record-end], [data-record-remarks]") &&
                 active.state.recordOpen) {
        syncRecordRangeInputs(host, active.state);
      }
    });

    host.addEventListener("change", function (event) {
      if (!active || active.host !== host) return;
      var filter = event.target.dataset.calendarFilter;
      if (filter === "plant") active.state.plantFilter = event.target.value;
      else if (filter === "status") active.state.statusFilter = event.target.value;
      else if (filter === "modal-plant") active.state.modalPlant = event.target.value;
      else if (filter === "modal-equipment") active.state.modalEquipment = event.target.value;
      else if (filter === "modal-status") active.state.modalStatus = event.target.value;
      else {
        // PM setup cascade: a new Equipment changes which Parts are offered, and
        // a new Part changes which Maintenance tasks are offered. Clear the
        // choices below the one that changed, then redraw so the lists match.
        var field = event.target.dataset.pmSetupField;
        if ((field === "equipment" || field === "part") && active.state.pmSetupOpen) {
          syncPMSetupForm(host, active.state);
          var item = active.state.pmSetupItems[Number(event.target.dataset.pmSetupIndex)];
          if (item) {
            if (field === "equipment") { item.part = ""; item.partNumber = ""; }
            item.task = "";
          }
          refreshKeepingFocus(host, active.state, active.context,
            '[data-pm-setup-index="' + event.target.dataset.pmSetupIndex +
            '"][data-pm-setup-field="' + field + '"]');
        }
        return;
      }
      if (filter.indexOf("modal-") === 0) active.state.detailEventIndex = null;
      renderView(host, active.state, active.context);
    });

    host.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && active && active.host === host &&
          (active.state.detailEventIndex !== null || active.state.modalDate ||
            active.state.setupOpen || active.state.recordOpen || active.state.pmSetupOpen)) {
        if (active.state.setupSaving || active.state.recordSaving) return;
        if (active.state.detailEventIndex !== null) {
          active.state.detailEventIndex = null;
        } else {
          active.state.modalDate = "";
          active.state.setupOpen = false;
          active.state.recordOpen = false;
          active.state.pmSetupOpen = false;
          active.state.pmSetupPreview = false;
        }
        renderView(host, active.state, active.context);
      }
    });
  }

  function render(host, context) {
    if (!host) throw new Error("Calendar host element is missing.");
    if (!context || (context.type !== "pm" && context.type !== "washing")) {
      throw new Error("Calendar requires a PM or Washing context.");
    }
    var key = contextKey(context);
    if (active && active.state !== states[key]) active.state.modalDate = "";
    wire(host);
    var state = getState(context);
    active = { host: host, state: state, context: context };
    if (state.loaded) {
      renderView(host, state, context);
    } else {
      loadEvents(host, state, context);
    }
  }

  global.Solar91PortalCalendar = { render: render };
}(window));