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

  /** The Sunday of the week holding `date` (the grid's first column), as YYYY-MM-DD. */
  function weekStartOf(date) {
    var start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay());
    return start.getFullYear() + "-" + pad2(start.getMonth() + 1) + "-" + pad2(start.getDate());
  }

  function dateFromKey(key) {
    var parts = String(key).split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function shiftDays(key, days) {
    var moved = dateFromKey(key);
    moved.setDate(moved.getDate() + days);
    return weekStartOf(moved);
  }

  /** "9 – 15 Nov 2026", the heading a one-week grid carries instead of a month name. */
  function displayWeek(startKey) {
    var start = dateFromKey(startKey);
    var end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    var sameMonth = start.getMonth() === end.getMonth();
    var month = function (date) {
      return new Intl.DateTimeFormat("en-IN", { month: "short" }).format(date);
    };
    return start.getDate() + (sameMonth ? "" : " " + month(start)) + " – " +
      end.getDate() + " " + month(end) + " " + end.getFullYear();
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

  function focusPMEvent(state, eventId) {
    var index = state.events.findIndex(function (event) {
      return String(event.id) === String(eventId);
    });
    if (index < 0) return false;
    state.modalDate = state.events[index].date;
    state.modalPlant = state.events[index].plantSiteCode || "";
    state.modalStatus = "all";
    state.modalEquipment = "";
    state.modalSearch = "";
    state.detailEventIndex = index;
    return true;
  }

  function getState(context) {
    var key = contextKey(context);
    if (!states[key]) {
      var initialMonth = typeof context.initialMonth === "string" &&
        /^\d{4}-\d{2}$/.test(context.initialMonth) ? context.initialMonth : "";
      states[key] = {
        month: initialMonth || (context.startDate
          ? context.startDate.slice(0, 7)
          : monthKey(new Date())),
        span: "month",
        weekStart: weekStartOf(initialMonth
          ? dateFromKey(initialMonth + "-01")
          : context.startDate ? dateFromKey(context.startDate) : new Date()),
        rangeStart: context.startDate || "",
        rangeEnd: context.endDate || "",
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
        pendingEventId: null,
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
        washingSummary: null,
        // Daily summary -> Filter by status -> Not recorded: who washed on that date, and who did not.
        dayFilter: null,        // the API's answer, tagged with the date it is for
        dayFilterLoading: false,
        dayFilterError: "",
        recordOpen: false,
        recordCycle: 1,
        recordSameDayDate: "",
        recordSameDayCycle: 0,
        recordDrafts: {},
        recordPhotos: {},
        recordPhotosLoaded: {},
        recordPhotoLoading: {},
        recordPhotoBusy: {},
        recordPhotoErrors: {},
        recordPendingPhotos: {},
        recordPhotoOpenId: "",
        recordEdit: null,
        recordSaving: false,
        recordError: "",
        recordNotice: "",
        // Extra cleaning: re-cleaning during a running cycle (dust, fog), recorded from the record
        // sheet's header. It is work done on its date, never progress of the cycle it happened in.
        extraOpen: false,
        extraEditId: "",
        extraDeleteConfirmId: "",
        extraDeleting: false,
        extraDeleteError: "",
        extraDate: "",
        extraList: "",
        extraRemarks: "",
        extraSaving: false,
        extraError: "",
        tooltips: {}
      };
    }
    return states[key];
  }

  function plantLabel(plant) {
    return plant.displayName || plant.plantName;
  }

  function statusClass(status) {
    if (status === "Completed" || status === "Confirmed") return "ep-calendar__event--complete";
    if (status === "Really behind" || status === "Overdue" || status === "Rejected") {
      return "ep-calendar__event--overdue";
    }
    if (status === "Behind") return "ep-calendar__event--behind";
    if (status === "Awaiting confirmation" || status === "Pending") {
      return "ep-calendar__event--awaiting";
    }
    if (status === "Scheduled") return "ep-calendar__event--scheduled";
    return "ep-calendar__event--pending";
  }

  function isWashingCycleComplete(event, context) {
    if (context.type !== "washing") return false;
    if (event.cycleCompleted === true) return true;
    return event.kind === "washing.done" && event.status === "Confirmed";
  }

  function eventChipTitle(event, context) {
    var title = String(event.title || "");
    if (context.type !== "washing" || !event.cycleNo) return title;
    return (event.isExtra
      ? "Extra · During cycle " + event.cycleNo
      : "Cycle " + event.cycleNo) + " · " + title;
  }

  function cycleCompletionTitle(event) {
    var cycle = event.cycleNo;
    if (!cycle) {
      var source = String(event.reference || event.title || "");
      var match = source.match(/cycle\s+(\d+)/i);
      if (match) cycle = match[1];
    }
    return (cycle ? "Cycle " + cycle : "Cycle") + " completed";
  }

  function washingTablesLabel(event, context) {
    if (context.type !== "washing" || event.tablesCleaned === null ||
        event.tablesCleaned === undefined) return "";
    var count = Number(event.tablesCleaned);
    if (!isFinite(count) || count <= 0) return "";
    var tables = String(event.tablesList || "").trim();
    return tables
      ? "Tables: " + tables
      : "Table numbers not recorded";
  }

  function eventCellDescription(event, context) {
    var title = eventChipTitle(event, context);
    var tables = washingTablesLabel(event, context);
    var description = tables ? title + " · " + tables : title;
    return isWashingCycleComplete(event, context)
      ? description + " · " + cycleCompletionTitle(event)
      : description;
  }

  function renderCalendarEventChip(event, context) {
    var tables = washingTablesLabel(event, context);
    var cycleComplete = isWashingCycleComplete(event, context);
    var deadline = event.kind === "deadline";
    var title = eventChipTitle(event, context);
    var reportChip = '<span class="ep-calendar__event ' + statusClass(event.status) +
      (deadline ? " ep-calendar__event--deadline" : "") +
      // Extra cleaning gets its own colour: it is work done, but it is not cycle progress, so it
      // must not read like a confirmed cycle day. A date carrying both an ordinary and an extra
      // entry renders both chips, because each saved report becomes its own event.
      (event.isExtra ? " ep-calendar__event--extra" : "") +
      (tables ? " ep-calendar__event--washing-detail" : "") +
      '" title="' + escape(eventCellDescription(event, context)) + '">' +
      (tables
        ? '<span class="ep-calendar__event-title">' + escape(title) + "</span>" +
          '<span class="ep-calendar__event-tables">' + escape(tables) + "</span>"
        : escape(title)) +
      "</span>";
    if (!cycleComplete) return reportChip;
    return reportChip + '<span class="ep-calendar__event ep-calendar__event--cycle-complete" title="' +
      escape(cycleCompletionTitle(event)) + '">' + escape(cycleCompletionTitle(event)) + "</span>";
  }

  function visibleEvents(state) {
    var term = state.search.trim().toLowerCase();
    return state.events.filter(function (event) {
      if (state.rangeStart && event.date < state.rangeStart) return false;
      if (state.rangeEnd && event.date > state.rangeEnd) return false;
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

  // A plant with no entry has no event to carry a status, so "Not recorded" cannot come from the
  // events list the way every other status does. It is offered explicitly and answered by
  // /api/scheduled/washing/day-activity, which reports every visible plant for a date including
  // the ones that reported nothing.
  var NOT_RECORDED = "__not_recorded";

  function renderStatusOptions(events, selected, options) {
    var statuses = [];
    events.forEach(function (event) {
      if (statuses.indexOf(event.status) === -1) statuses.push(event.status);
    });
    if (selected !== "all" && statuses.indexOf(selected) === -1) statuses.push(selected);
    statuses = statuses.filter(function (status) { return status !== NOT_RECORDED; });
    statuses.sort();
    return '<option value="all">All statuses</option>' +
      statuses.map(function (status) {
        return '<option value="' + escape(status) + '"' +
          (status === selected ? " selected" : "") + ">" +
          escape(status) + "</option>";
      }).join("") +
      (options && options.offerNotRecorded
        ? '<option value="' + NOT_RECORDED + '"' +
          (selected === NOT_RECORDED ? " selected" : "") + ">Not recorded</option>"
        : "");
  }

  function equipmentLabel(event, context) {
    return event.equipmentType || (context.type === "washing" ? "Module Cleaning" : "Preventive maintenance");
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

  var DAY_STATUS_LABEL = {
    confirmed: "Recorded", awaiting: "Awaiting review", not_done: "Not done",
    rejected: "Rejected", not_reported: "Not recorded", upcoming: "Upcoming", paused: "Paused"
  };

  /**
   * The plants with nothing recorded for the summary's date.
   *
   * "Not done, with a reason" is a report; it is kept out of this list, which is only the plants
   * that said nothing at all, because those are the ones that still need chasing. A plant whose
   * washing is paused is left out for the same reason: nothing is expected of it.
   */
  function renderNotRecorded(state) {
    if (state.dayFilterLoading) {
      return '<p class="ep-calendar__empty">Checking which plants have not recorded…</p>';
    }
    if (state.dayFilterError) {
      return '<p class="ep-calendar__message ep-calendar__message--error" role="alert">' +
        escape(state.dayFilterError) + '</p>';
    }
    var all = (state.dayFilter && state.dayFilter.plants) || [];
    var missing = all.filter(function (row) { return row.status === "not_reported"; });
    if (!all.length) {
      return '<p class="ep-calendar__empty">No module cleaning plants are visible for this date.</p>';
    }
    if (!missing.length) {
      return '<p class="ep-calendar__empty">Every plant has recorded module cleaning for this date.</p>';
    }
    return '<section class="ep-calendar__pm-summary-group ep-calendar__portfolio-summary-group">' +
      '<header><span><i aria-hidden="true"></i><strong>Not recorded</strong></span>' +
        '<span class="ep-calendar__pm-summary-count">' + missing.length + '</span></header>' +
      '<div class="ep-calendar__pm-summary-list">' +
        missing.map(function (row) {
          return '<div class="ep-calendar__pm-summary-item ep-calendar__pm-summary-item--static">' +
            '<span class="ep-calendar__pm-summary-badge ep-calendar__pm-summary-badge--washing">CLEAN</span>' +
            '<strong>' + escape(row.plant) + '</strong>' +
            '<span class="ep-calendar__pm-summary-meta">' + escape(row.site_code) +
              ' · No cleaning details entered</span>' +
            '<span class="ep-calendar__day-chip ep-calendar__day-chip--not_reported">Not recorded</span>' +
          '</div>';
        }).join("") +
      '</div>' +
    '</section>';
  }

  /**
   * Which plants recorded washing on the summary's date, and which did not.
   *
   * Loaded only when the Not recorded filter is chosen, and keyed on the date it was asked for, so
   * clicking through several dates cannot leave an earlier answer on screen.
   */
  function loadDayActivity(host, state, context) {
    var wanted = state.modalDate;
    if (!wanted) return;
    if (state.dayFilter && state.dayFilter.day === wanted) return;   // already have this date
    var api = global.Solar91PortalAPI;
    if (!api) {
      state.dayFilterError = "The portal API client is not loaded.";
      renderView(host, state, context);
      return;
    }
    state.dayFilterLoading = true;
    state.dayFilterError = "";
    renderView(host, state, context);
    api.request("/api/scheduled/washing/day-activity?day=" + encodeURIComponent(wanted))
      .then(function (body) {
        if (state.modalDate !== wanted) return;   // a different date was opened meanwhile
        body.day = wanted;
        state.dayFilter = body;
        state.dayFilterLoading = false;
        renderView(host, state, context);
      })
      .catch(function (error) {
        if (state.modalDate !== wanted) return;
        state.dayFilterLoading = false;
        state.dayFilterError = error.message || "Module Cleaning for this date could not be loaded.";
        renderView(host, state, context);
      });
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
    var hasCleaning = reportsOnDate.some(function (report) {
      return report.jobStatus === "Done";
    });
    if (reportsOnDate.length && !hasCleaning) {
      var reasons = [];
      reportsOnDate.forEach(function (report) {
        var reason = (report.remarks || "").trim() || (report.exceptionReason || "").trim();
        if (reason && reasons.indexOf(reason) === -1) reasons.push(reason);
      });
      return reasons.length
        ? '<div class="ep-calendar__wash-reason">' + escape(reasons.join(" · ")) + '</div>'
        : "";
    }
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
      var overtaken = recorded < tableCount && reportsThroughDate.some(function (report) {
        return Number(report.cycleNo) > cycleNumber &&
          (report.reviewStatus === "Pending" || report.reviewStatus === "Confirmed");
      });
      var status = !tableCount
        ? "Unavailable"
        : cycle.state === "Upcoming"
          ? "Upcoming"
        : confirmed >= tableCount
          ? "Completed"
          : overtaken
            ? "Incomplete"
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
    if (!selected) selected = cycleProgress.find(function (item) {
      return item.cycle.state === "In progress" || item.cycle.state === "Missed";
    }) || null;
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
    var statusClass = selected && (selected.status === "Overdue" || selected.status === "Incomplete") ? " is-overdue" :
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
    if (state.liveWashing && state.washingPlant) return;
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
    tooltip.classList.toggle(
      "ep-calendar__wash-hover-card--reason",
      isWashing && content.indexOf("ep-calendar__wash-reason") !== -1
    );
    tooltip.hidden = false;
    positionWashingTooltip(host, day);
  }

  function hideWashingTooltip(host) {
    var tooltip = host.querySelector("[data-calendar-hover-card]");
    if (!tooltip) return;
    tooltip.hidden = true;
    tooltip.dataset.date = "";
  }

  function renderCalendarGrid(state, events, hoverEnabled, hoverId, context) {
    var parts = monthParts(state.month);
    var firstDay = new Date(parts.year, parts.month - 1, 1).getDay();
    var daysInMonth = new Date(parts.year, parts.month, 0).getDate();
    var week = state.span === "week";
    // In week view the seven cells start at the shown week's Sunday, which may fall in the
    // month before; `dayNumber` stays an offset from the 1st, so a day outside the month is
    // drawn the same way the month grid draws its leading and trailing cells.
    var cells = week ? 7 : Math.ceil((firstDay + daysInMonth) / 7) * 7;
    var offset = week
      ? firstDay + Math.round((dateFromKey(state.weekStart) - new Date(parts.year, parts.month - 1, 1)) / 86400000)
      : 0;
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
      var dayNumber = index + offset - firstDay + 1;
      var inMonth = dayNumber > 0 && dayNumber <= daysInMonth;
      var date = inMonth
        ? state.month + "-" + pad2(dayNumber)
        : "";
      var dayEvents = date ? (eventsByDate[date] || []) : [];
      var isToday = date === monthKey(new Date()) + "-" + pad2(new Date().getDate());
      var tooltip = date
        ? (state.tooltips[date] || (dayEvents.length
          ? dayEvents.map(function (event) { return eventCellDescription(event, context); }).join("; ")
          : "No module cleaning report or cycle deadline recorded for this date."))
        : "";
              var plainDay = !!(state.liveWashing && state.washingPlant);   // Module Cleaning plant calendar
      
      var classes = "ep-calendar__day";
      if (!inMonth) classes += " ep-calendar__day--outside";
      if (isToday) classes += " ep-calendar__day--today";
      days += '<button type="button" class="' + classes + '"' +
        (inMonth ? (plainDay ? "" : ' data-calendar-action="open-date"') + ' data-date="' + date + '"' : " disabled") +
        (inMonth
        ? (hoverEnabled ? ' aria-describedby="' + hoverId + '"' : "") +
          ' aria-label="' + escape(displayDate(date) + ", " + dayEvents.length +
            " saved records" +
            (tooltip ? ". " + tooltip : "")) + '"'
        : ' aria-hidden="true"') +
        '><span class="ep-calendar__day-number">' + (inMonth ? dayNumber : "") + "</span>" +
        (dayEvents.length
          ? '<span class="ep-calendar__day-events">' + (plainDay ? dayEvents : dayEvents.slice(0, 2)).map(function (event) {
              return renderCalendarEventChip(event, context);
            }).join("") +
            (!plainDay && dayEvents.length > 2
              ? '<span class="ep-calendar__more">+' + (dayEvents.length - 2) + " more</span>"
              : "") +
            "</span>"
          : '<span class="ep-calendar__day-empty"></span>') +
      "</button>";
    }
    return '<div class="ep-calendar__grid ep-calendar__grid--weeks-' + (cells / 7) +
      (week ? " ep-calendar__grid--week" : "") +
      '" role="grid" aria-label="' + escape(week ? displayWeek(state.weekStart) : displayMonth(state.month)) + '">' +
      weekdays + days + "</div>";
  }

  function renderEventCards(events, context, state) {
    if (!events.length) {
      return '<p class="ep-calendar__empty">' +
        "No saved records match this date and filter." + '</p>';
    }
    return '<div class="ep-calendar__event-list">' + events.map(function (event) {
      var typeLabel = context.type === "pm" ? "Preventive maintenance" : "Module Cleaning";
      var activityDay = Number(event.date.slice(8, 10));
      var cycleNumber = event.cycleNo || (activityDay <= 10 ? 1 : (activityDay <= 20 ? 2 : 3));
      var cycle = context.type === "washing"
        ? "Cycle " + cycleNumber + " · " + event.date.slice(0, 7)
        : "Scheduled activity · " + event.date.slice(0, 7);
      var eventIndex = state.events.indexOf(event);
      // Opening the day must not turn extra cleaning back into an ordinary confirmed day: it carries
      // the same purple as its grid chip and says which cycle it happened DURING, never "Cycle 3" as
      // though it were that cycle's work.
      return '<button type="button" class="ep-calendar__event-card' +
        (event.isExtra ? " ep-calendar__event-card--extra" : "") +
        '" data-calendar-event-index="' + eventIndex + '">' +
        '<span class="ep-calendar__event-card-top"><strong>' + escape(equipmentLabel(event, context)) +
          '</strong>' + (event.isExtra ? '<span class="ep-calendar__extra-badge">Extra</span>' : "") +
          '<span class="' + statusClass(event.status) + '">' + escape(event.status) + '</span></span>' +
        '<span class="ep-calendar__event-card-title">' + escape(event.title) + '</span>' +
        '<span class="ep-calendar__event-card-meta">' +
          escape(event.plantName || (context.plantCode ? "Selected plant" : "Plant not provided")) +
          (event.plantSiteCode ? " · " + escape(event.plantSiteCode) : "") +
          " · " + escape(event.isExtra ? "During cycle " + cycleNumber : cycle) + '</span>' +
        (event.isExtra
          ? '<span class="ep-calendar__event-card-extra-note">Re-cleaning · does not count towards this cycle</span>'
          : "") +
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
    var title = context.type === "pm" ? "Preventive Maintenance" : "Module Cleaning";
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
          var cycle = event.cycleNo
            ? (event.isExtra ? "During cycle " + event.cycleNo : "Cycle " + event.cycleNo) : "";
          var meta = [
            event.plantName,
            event.plantSiteCode,
            unit || cycle,
            event.reference,
            event.title
          ].filter(Boolean).join(" · ");
          return '<button type="button" class="ep-calendar__pm-summary-item' +
            (event.isExtra ? " ep-calendar__pm-summary-item--extra" : "") +
            '" data-calendar-event-index="' + eventIndex + '">' +
            '<span class="ep-calendar__pm-summary-badge' +
              (event.isExtra ? " ep-calendar__pm-summary-badge--extra"
                : context.type === "washing" ? " ep-calendar__pm-summary-badge--washing" : "") + '">' +
              (event.isExtra ? "EXTRA" : context.type === "pm" ? "PM" : "CLEAN") + '</span>' +
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
      ["Activity", context.type === "pm" ? "Preventive maintenance" : "Module Cleaning"],
      ["Equipment", equipmentLabel(event, context)],
      ["Reference", event.reference],
      ["Date", displayDate(event.date)],
      ["Status", event.status],
      ["Assigned to", event.assignee || event.reportedBy],
      ["Unit", event.unitNo && event.totalUnits ? event.unitNo + " of " + event.totalUnits : ""],
      ["Frequency", event.frequency],
      ["Completed on", event.completedOn ? displayDate(event.completedOn) : ""],
      // Extra cleaning belongs to no cycle's progress; naming the cycle plainly would read as if
      // it did. The banner below carries the full explanation.
      ["Cycle", event.cycleNo ? (event.isExtra ? "During cycle " + event.cycleNo : "Cycle " + event.cycleNo) : ""],
      ["Tables cleaned", event.tablesCleaned],
      ["Which tables", event.tablesList],
      ["Exception", event.exceptionReason],
      ["Remarks", event.remarks]
    ].filter(function (field) {
      return field[1] !== "" && field[1] !== null && field[1] !== undefined;
    });
    var extraActions = "";
    if (event.isExtra && event.reportId && event.canEdit) {
      if (state.extraDeleteConfirmId === event.reportId) {
        extraActions = '<p class="ep-calendar__extra-delete-warning" role="alert">Remove this extra cleaning record? This cannot be undone.</p>' +
          '<div class="ep-calendar__extra-detail-actions">' +
            '<button type="button" class="ep-calendar__close-button" data-calendar-action="cancel-extra-delete"' +
              (state.extraDeleting ? " disabled" : "") + '>Keep entry</button>' +
            '<button type="button" class="ep-calendar__setup-submit ep-calendar__setup-submit--danger" ' +
              'data-calendar-action="confirm-extra-delete" data-report-id="' + escape(event.reportId) + '"' +
              (state.extraDeleting ? " disabled" : "") + '>' +
              (state.extraDeleting ? "Removing\u2026" : "Remove extra cleaning") + '</button>' +
          '</div>' +
          (state.extraDeleteError ? '<p class="ep-calendar__setup-error" role="alert">' +
            escape(state.extraDeleteError) + '</p>' : "");
      } else {
        extraActions = '<div class="ep-calendar__extra-detail-actions">' +
          '<button type="button" class="ep-calendar__setup-submit" data-calendar-action="edit-extra" data-report-id="' +
            escape(event.reportId) + '">Edit extra cleaning</button>' +
          (event.canDelete
            ? '<button type="button" class="ep-calendar__setup-submit ep-calendar__setup-submit--danger" ' +
              'data-calendar-action="request-extra-delete" data-report-id="' + escape(event.reportId) +
              '">Remove extra cleaning</button>'
            : "") +
          '</div>';
      }
    } else {
      extraActions = '<p class="ep-calendar__detail-note">Saved record, shown read-only.</p>';
    }
    return '<div class="ep-calendar__modal ep-calendar__event-detail-modal' +
      (event.isExtra ? " ep-calendar__event-detail-modal--extra" : "") + '" data-calendar-event-detail>' +
      '<button class="ep-calendar__backdrop" type="button" data-calendar-action="close-event-detail" aria-label="Close activity details"></button>' +
      '<section class="ep-calendar__dialog ep-calendar__event-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="calendar-event-detail-title">' +
        '<header class="ep-calendar__dialog-head"><div>' +
          '<h2 id="calendar-event-detail-title">' + escape(context.type === "pm" ? "Preventive Maintenance activity" : "Module Cleaning activity") + '</h2>' +
        '</div><button type="button" class="ep-calendar__close" data-calendar-action="close-event-detail" aria-label="Close">×</button></header>' +
        '<div class="ep-calendar__event-detail-body">' +
          '<button type="button" class="ep-calendar__close-button" data-calendar-action="close-event-detail">‹ Back to the day</button>' +
          '<div class="ep-calendar__detail">' +
            '<div class="ep-calendar__detail-banner"><strong>' + escape(event.title) +
              '</strong><span>' + escape(event.reference || displayDate(event.date)) + '</span></div>' +
            '<div class="ep-calendar__detail-chips"><span>' + escape(equipmentLabel(event, context)) +
              '</span>' + (event.isExtra ? '<span class="ep-calendar__extra-badge">Extra cleaning</span>' : "") +
              '<span>' + escape(event.status) + '</span></div>' +
            (event.isExtra
              ? '<p class="ep-calendar__detail-extra-note">Extra cleaning recorded before all three cycles are ' +
                'complete is a calendar entry only; it does not count towards cycle progress or plant compliance. ' +
                'Only extra cleaning after all three cycles are complete increases monthly compliance.</p>'
              : "") +
            '<dl class="ep-calendar__detail-fields">' +
              fields.map(function (field) {
                var value = field[0] === "Plant" && event.plantSiteCode
                  ? '<button type="button" class="ep-plantlink" data-open-plant="' +
                    escape(event.plantSiteCode) + '" data-open-plant-page="' + context.type +
                    '" title="Open this plant\'s ' +
                    escape(context.type === "pm" ? "Preventive Maintenance" : "Module Cleaning") +
                    ' page">' + escape(field[1]) + '</button>'
                  : escape(field[1]);
                return "<div><dt>" + escape(field[0]) + "</dt><dd>" + value + "</dd></div>";
              }).join("") +
            '</dl>' +
            extraActions +
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
    var typeLabel = context.type === "pm" ? "Preventive Maintenance" : "Module Cleaning";
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
                renderStatusOptions(availableEvents, state.modalStatus,
                                    { offerNotRecorded: context.type === "washing" }) +
              '</select></label>' +
            '</div>' +
            (state.modalStatus === NOT_RECORDED
              ? renderNotRecorded(state)
              : renderPortfolioSummaryEvents(events, context, state)) +
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
      numberOfUnits: "",
      unitName: "",
      supervisor: "",
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
          (type === "text" ? ' maxlength="255"' : "") +
          (key === "unitName" ? ' placeholder="e.g. INV-1, INV-2"' : "") +
          (key === "supervisor" ? ' placeholder="Name (optional)"' : "") +
          (key === "numberOfUnits" ? ' min="1" step="1" inputmode="numeric"' : "") +
          ' /></label>';
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
          field("numberOfUnits", "Number of units", "number", true) +
          field("unitName", "Unit name(s) (optional)", "text", false) +
          field("supervisor", "Supervisor", "text", false) +
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
                  '<p>' + escape([item.part, item.numberOfUnits && "Number of units: " + item.numberOfUnits,
                    item.unitName && "Unit name(s): " + item.unitName]
                      .filter(Boolean).join(" · ") || "No part specified") + '</p>' +
                    (item.supervisor ? '<p>Supervisor: ' + escape(item.supervisor) + '</p>' : "") +
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

  function sameDayNextCycleCandidate(state) {
    var cycleCount = (state.washingPlant && state.washingPlant.cycles || []).length || 3;
    var reports = state.washingReports || [];
    var completions = reports.filter(function (report) {
      return report.review_status === "Confirmed" && report.cycle_completed &&
        Number(report.cycle_no) > 0 && Number(report.cycle_no) < cycleCount;
    }).sort(function (a, b) {
      return Number(b.cycle_no) - Number(a.cycle_no) ||
        (a.report_date < b.report_date ? 1 : a.report_date > b.report_date ? -1 : 0);
    });
    for (var i = 0; i < completions.length; i += 1) {
      var completion = completions[i];
      var previousCycle = Number(completion.cycle_no);
      var nextCycle = previousCycle + 1;
      if (!canManageWashing() && completion.report_date < earliestRecordDate(state)) continue;
      var nextWorkExists = reports.some(function (report) {
        return !isExtraReport(report) &&
          report.job_status === "Done" &&
          (report.review_status === "Pending" || report.review_status === "Confirmed") &&
          Number(report.cycle_no) > previousCycle &&
          report.report_date >= completion.report_date;
      });
      if (!nextWorkExists) {
        return {
          date: completion.report_date,
          previousCycle: previousCycle,
          nextCycle: nextCycle
        };
      }
    }
    return null;
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
    // Cycles 1 and 2 hand the month over to the next cycle on the day they fill, so their
    // grid stops there. The last cycle has nothing to hand over to: the backend keeps any
    // later day on it as extra washing (_cycle_sequence in app/scheduled/washing_cycles.py).
    // Closing its grid on the completion date hid that work — plants that washed again after
    // all three cycles were done had days with no row to show them on, and no row to record
    // the next one. The last cycle therefore stays open to today or the end of the month.
    var cycleCount = (state.washingPlant.cycles || []).length || 3;
    var isLastCycle = Number(cycle.cycle_no) >= cycleCount;
    if (completedOn && completedOn < lastDate && !isLastCycle) lastDate = completedOn;
    // Later-cycle reports start only after the previous cycle reaches the full table count.
    var activeReports = (state.washingReports || []).filter(function (report) {
      return report.review_status === "Pending" || report.review_status === "Confirmed";
    });
    var regularReportByDate = {};
    activeReports.forEach(function (report) {
      if (!isExtraReport(report)) regularReportByDate[report.report_date] = true;
    });
    var nextFirst = activeReports.filter(function (report) {
      return Number(report.cycle_no) > Number(cycle.cycle_no);
    }).reduce(function (first, report) {
      return !first || report.report_date < first ? report.report_date : first;
    }, "");
    if (nextFirst && !isLastCycle) {
      var dayBefore = new Date(nextFirst + "T12:00:00");
      dayBefore.setDate(dayBefore.getDate() - 1);
      var closedOn = dayBefore.getFullYear() + "-" + pad2(dayBefore.getMonth() + 1) + "-" + pad2(dayBefore.getDate());
      if (closedOn < lastDate) lastDate = closedOn;
    }
    var ownReports = activeReports.filter(function (report) {
      return Number(report.cycle_no) === Number(cycle.cycle_no);
    });
    var ownFirst = ownReports.reduce(function (first, report) {
      return !first || report.report_date < first ? report.report_date : first;
    }, "");
    var ownLast = ownReports.reduce(function (last, report) {
      return !last || report.report_date > last ? report.report_date : last;
    }, "");
    if (Number(cycle.cycle_no) > 1) {
      var previousCompletion = (state.washingReports || []).filter(function (report) {
        return Number(report.cycle_no) === Number(cycle.cycle_no) - 1 &&
          report.review_status === "Confirmed" && report.cycle_completed;
      }).reduce(function (latest, report) {
        return !latest || report.report_date > latest ? report.report_date : latest;
      }, "");
      if (previousCompletion) {
        // Include the previous cycle's completion date, but do not offer it as a new ordinary
        // entry when that date already has a report in another cycle.
        startDate = previousCompletion;
      }
    }
    if (ownFirst && ownFirst < startDate) startDate = ownFirst;
    // A cycle's own saved days always have a row, whatever the clamps above decided.
    if (ownLast && ownLast > lastDate) lastDate = ownLast;
    if (!canManageWashing()) {
      var firstAllowed = new Date(today + "T12:00:00");
      firstAllowed.setDate(firstAllowed.getDate() - 44);
      var allowedDate = firstAllowed.getFullYear() + "-" + pad2(firstAllowed.getMonth() + 1) +
        "-" + pad2(firstAllowed.getDate());
      if (startDate < allowedDate) startDate = allowedDate;
    }
    var isSameDayNextCycle = state.recordSameDayDate &&
      Number(state.recordCycle) === Number(state.recordSameDayCycle);
    if (startDate > lastDate && !isSameDayNextCycle) return [];

    var dates = dateRange(startDate, lastDate);
    if (isSameDayNextCycle && dates.indexOf(state.recordSameDayDate) === -1) {
      dates.push(state.recordSameDayDate);
      dates.sort();
    }
    // Saved days of the SELECTED cycle only, by date, keeping the order the API sent them in
    // (report_date, created_at). A date can have regular and extra entries, and historical data may
    // include entries from multiple cycles, so keep every saved report on its own row.
    var savedByDate = {};
    (state.washingReports || []).forEach(function (report) {
      if (report.review_status === "Rejected") return;
      if (Number(report.cycle_no) !== Number(cycle.cycle_no)) return;
      (savedByDate[report.report_date] = savedByDate[report.report_date] || []).push(report);
    });
    var total = Number(state.washingPlant.table_count) || 0;
    // Tables this cycle has already taken. EVERY saved day of the cycle counts, whatever its date:
    // the server checks a table against the whole cycle (`_assert_distinct_tables`), not against the
    // days before the one being filled. Seeding only the days above each row left a back-filled date
    // blind to work saved later in the cycle, so the sheet accepted the entry and the save bounced
    // with "Table 1 is already recorded in cycle 3 on 16 Nov" — an error the row could have shown
    // before anyone pressed Save. Legacy count-only days take the lowest free tables, so they are
    // marked once each, in date order, and never re-marked during the walk below.
    //
    // Extra cleaning is tagged to the cycle it happened during but is NOT its progress, so it
    // reserves nothing: the backend leaves it out of the cycle ledger and the sheet agrees. Counting
    // it would mark a table the cycle had not reached as done, with no way left to record it as the
    // cycle work still owed.
    var used = {};
    var savedUsed = {};
    (state.washingReports || []).filter(function (report) {
      return Number(report.cycle_no) === Number(cycle.cycle_no) &&
        report.review_status !== "Rejected" && !isExtraReport(report);
    }).slice().sort(function (a, b) {
      return a.report_date < b.report_date ? -1 : a.report_date > b.report_date ? 1 : 0;
    }).forEach(function (report) {
      markUsed(used, total, report);
      markUsed(savedUsed, total, report);
    });
    var rows = [];
    dates.forEach(function (date) {
      var saved = savedByDate[date] || [];
      if (saved.length) {
        saved.forEach(function (report) {
          rows.push({ date: date, report: report, numbers: tableNumbersOf(report) });
        });
        return;
      }
      if (regularReportByDate[date] && !(isSameDayNextCycle && date === state.recordSameDayDate)) return;
      var draft = state.recordDrafts[date] || {};
      var plan = planDay(state, draft, used, total);
      plan.numbers.forEach(function (number) { used[number] = true; });
      rows.push({
        date: date, report: null, draft: draft, numbers: plan.numbers,
        nextNumbers: plan.nextNumbers || [],
        error: plan.error, full: plan.full, zero: plan.zero,
        note: rollOverNote(state, plan),
        sameDayNextCycle: !!(isSameDayNextCycle && date === state.recordSameDayDate)
      });
    });
    rows.cleanedTables = [];
    rows.openTables = [];
    for (var n = 1; n <= total; n += 1) (savedUsed[n] ? rows.cleanedTables : rows.openTables).push(n);
    return rows;
  }

  /** Re-cleaning recorded during a running cycle (migration 048): work done, but not cycle progress. */
  function isExtraReport(report) {
    return !!report && report.is_extra === true;
  }

  function tableNumbersOf(report) {
    return (report.cleaned_table_codes || []).map(tableNumber).filter(function (number) { return number !== null; });
  }

  /** Reports saved before table numbers were stored only have a count: they used the lowest free tables. */
  function markUsed(used, total, report) {
    var numbers = tableNumbersOf(report);
    if (numbers.length) {
      numbers.forEach(function (number) { used[number] = true; });
      return;
    }
    var left = report.job_status === "Done" ? Number(report.tables_cleaned) || 0 : 0;
    for (var n = 1; n <= total && left > 0; n += 1) {
      if (!used[n]) { used[n] = true; left -= 1; }
    }
  }

  /** "1, 2, 4, 7-8, 13" or "100-91" (either direction) -> ordered unique numbers, or an error message. */
  function parseTableList(text, total) {
    var cleaned = String(text || "").replace(/\s*([-\u2013\u2014])\s*/g, "$1");
    var parts = cleaned.split(/[,;\s]+/).filter(Boolean);
    var numbers = [];
    var seen = {};
    for (var i = 0; i < parts.length; i += 1) {
      var match = parts[i].match(/^(\d+)(?:[-\u2013\u2014](\d+))?$/);
      if (!match) return { numbers: [], error: "\u201c" + parts[i] + "\u201d is not a table number or range." };
      var from = Number(match[1]);
      var to = match[2] === undefined ? from : Number(match[2]);
      if (from < 1 || to < 1 || from > total || to > total) {
        return { numbers: [], error: "Table numbers must be between 1 and " + total + "." };
      }
      var step = from <= to ? 1 : -1;
      for (var number = from; ; number += step) {
        if (seen[number]) return { numbers: [], error: "Table " + number + " is listed twice." };
        seen[number] = true;
        numbers.push(number);
        if (number === to) break;
      }
    }
    return { numbers: numbers, error: "" };
  }

  /** Compresses consecutive numbers without changing the order in which the user entered them. */
  function formatTableList(numbers) {
    var ordered = numbers || [];
    var parts = [];
    for (var i = 0; i < ordered.length;) {
      var j = i;
      var step = j + 1 < ordered.length && Math.abs(ordered[j + 1] - ordered[j]) === 1
        ? ordered[j + 1] - ordered[j] : 0;
      while (step && j + 1 < ordered.length && ordered[j + 1] - ordered[j] === step) j += 1;
      parts.push(j > i ? ordered[i] + "\u2013" + ordered[j] : String(ordered[i]));
      i = j + 1;
    }
    return parts.join(", ");
  }

  /** The cycle after the selected one, or 0 when the selected cycle is the month's last. */
  function nextCycleNo(state) {
    var cycleNo = Number(state.recordCycle) || 1;
    var lastCycle = (state.washingPlant && state.washingPlant.cycles || []).length || 3;
    return cycleNo >= lastCycle ? 0 : cycleNo + 1;
  }

  /** What the sheet tells the user about Cycle 3 completing before more work that same day. */
  function rollOverNote(state, plan) {
    var rolled = plan && plan.nextNumbers || [];
    if (!rolled.length) return "";
    var cycleNo = Number(state.recordCycle) || 1;
    var next = nextCycleNo(state);
    return plan.numbers.length + " table" + (plan.numbers.length === 1 ? "" : "s") +
      " complete cycle " + cycleNo + " · " + rolled.length + " table" +
      (rolled.length === 1 ? "" : "s") + " (" + formatTableList(rolled) + ") " +
      (next ? "start cycle " + next : "count as extra washing") + " on this same date.";
  }

  /** Total tables in the regular entry and any same-day extra cleaning after Cycle 3. */
  function rowTableCount(row) {
    return (row.numbers || []).length + ((row.nextNumbers || []).length);
  }

  /** The cycle sheet permits one regular entry per plant/date. After Cycle 3 completes, same-day
   *  work is extra cleaning; between cycles, use the separate Extra Cleaning action. */
  function planDay(state, draft, used, total) {
    var free = [];
    for (var n = 1; n <= total; n += 1) if (!used[n]) free.push(n);
    var plan = { numbers: [], nextNumbers: [], error: "", full: free.length === 0, zero: !!draft.reason };
    if (plan.zero || plan.full) return plan;
    var text = String(draft.list || "").trim();
    if (!text) return plan;
    var parsed = parseTableList(text, total);
    if (parsed.error) { plan.error = parsed.error; return plan; }
    var taken = parsed.numbers.filter(function (number) { return used[number]; });
    var next = nextCycleNo(state);
    if (!taken.length) {
      plan.numbers = parsed.numbers;
      return plan;
    }
    var fresh = parsed.numbers.filter(function (number) { return !used[number]; });
    if (!next && fresh.length === free.length) {
      plan.numbers = fresh;                 // the entered order is kept inside each part
      plan.nextNumbers = taken;
      return plan;
    }
    plan.error = "Table " + taken[0] + " is already cleaned in this cycle. Use + Extra cleaning to record additional cleaning.";
    return plan;
  }

  /** An unsaved day is ready to save with valid tables, or as a zero-tables day. */
  function rowEntered(row) {
    return !row.report && !row.error && !row.full && (row.zero || row.numbers.length > 0);
  }

  function tableNumber(code) {
    var match = String(code || "").match(/(?:Table\s*)?(\d+)$/i);
    return match ? Number(match[1]) : null;
  }

  var NOT_DONE_REASONS = ["Rain", "Water shortage", "Machine breakdown", "Access restriction", "Safety stand-down", "Other"];

  /** Inline editor for one saved day. Confirmed days stay confirmed: the server keeps the review, audits the change and
   *  moves the following days' table numbers and cycles to match. */
  function renderRecordEditRow(state, row, dateLabel) {
    var edit = state.recordEdit;
    var disabled = edit.saving ? " disabled" : "";
    var done = edit.status === "Done";
    return '<div class="ep-calendar__record-row ep-calendar__record-row--editing" data-record-edit-row="' + escape(edit.id) + '">' +
      '<label><span class="ep-calendar__record-mobile-label">Day</span><strong>' + escape(dateLabel) + '</strong></label>' +
      '<select data-record-edit-status aria-label="Status for ' + escape(dateLabel) + '"' + disabled + '>' +
        '<option value="Done"' + (done ? " selected" : "") + '>Done</option>' +
        '<option value="Not done"' + (done ? "" : " selected") + '>Not done</option></select>' +
      (done
        ? '<div class="ep-calendar__record-range">' +
            '<input type="text" data-record-edit-list placeholder="e.g. 1-5, 9, 12 or 100-91" value="' + escape(edit.list) +
            '" aria-label="Table numbers cleaned on ' + escape(dateLabel) + '"' + disabled + ' />' +
            (edit.legacy
              ? '<input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" data-record-edit-count value="' + escape(edit.count) +
                '" aria-label="Tables cleaned on ' + escape(dateLabel) + ' (no numbers saved)"' + disabled + ' />'
              : "") + '</div>'
        : '<select data-record-edit-reason aria-label="Reason for ' + escape(dateLabel) + '"' + disabled + '>' +
            '<option value="">Reason\u2026</option>' + NOT_DONE_REASONS.map(function (reason) {
              return '<option value="' + escape(reason) + '"' + (edit.reason === reason ? " selected" : "") + '>' + escape(reason) + '</option>';
            }).join("") + '</select>') +
      '<input type="text" data-record-edit-remarks maxlength="4000" placeholder="Remarks" value="' + escape(edit.remarks) +
        '" aria-label="Remarks for ' + escape(dateLabel) + '"' + disabled + ' />' +
      '<div class="ep-calendar__record-edit-actions">' +
        '<button type="button" class="ep-calendar__close-button" data-record-edit-cancel' + disabled + '>Cancel</button>' +
        '<button type="button" class="ep-calendar__setup-submit" data-record-edit-save' + disabled + '>' +
          (edit.saving ? "Saving\u2026" : "Save changes") + '</button></div>' +
      (edit.error ? '<span class="ep-calendar__record-error" role="alert">' + escape(edit.error) + '</span>' : "") +
    '</div>';
  }

  function recordPhotoKey(reportId, phase, slot) {
    return reportId + "|" + phase + "|" + slot;
  }

  function clearDraftRecordPhotos(state) {
    Object.keys(state.recordPendingPhotos).forEach(function (key) {
      if (key.indexOf("draft:") === 0) delete state.recordPendingPhotos[key];
    });
    if (state.recordPhotoOpenId.indexOf("draft:") === 0) state.recordPhotoOpenId = "";
  }

  function renderRecordPhotoSlot(state, report, phase, slot) {
    var photos = state.recordPhotos[report.id] || [];
    var photo = photos.find(function (item) {
      return item.phase === phase && Number(item.slot) === slot;
    });
    var key = recordPhotoKey(report.id, phase, slot);
    var busy = state.recordPhotoBusy[key];
    var error = state.recordPhotoErrors[key] || "";
    var pending = state.recordPendingPhotos[key];
    var retryAction = error && pending
      ? '<button type="button" class="ep-calendar__photo-remove" data-record-photo-retry="' +
        escape(report.id) + '" data-phase="' + phase + '" data-slot="' + slot + '">Retry upload</button>' +
        '<button type="button" class="ep-calendar__photo-remove" data-record-photo-discard="' +
        escape(report.id) + '" data-phase="' + phase + '" data-slot="' + slot + '">Discard</button>'
      : "";
    if (busy) {
      return '<div class="ep-calendar__photo-slot is-busy" role="status">Uploading…</div>';
    }
    if (photo) {
      var isPdf = photo.contentType === "application/pdf";
      return '<div class="ep-calendar__photo-slot is-filled">' +
        '<button type="button" class="ep-calendar__photo-preview" data-washing-photo-open="' +
          escape(photo.id) + '" data-washing-report="' + escape(report.id) + '" aria-label="Open ' +
          escape(phase) + (isPdf ? " PDF" : " photo") + ' slot ' + slot + '">' +
          '<img data-photo-src="' + escape(photo.thumbnailUrl) + '" loading="lazy" width="' +
            Math.max(1, Number(photo.width) || 480) + '" height="' +
            Math.max(1, Number(photo.height) || 360) + '" alt="' + escape(phase) +
            (isPdf ? " PDF file" : " photo") + ' ' + slot + '" />' +
        '</button>' +
        (isPdf ? '<small class="ep-calendar__photo-file">PDF · ' + escape(photo.fileName || "evidence.pdf") + '</small>' : "") +
        (report.can_add_evidence
            ? '<div class="ep-calendar__photo-actions"><label class="ep-calendar__photo-replace">Replace<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" data-washing-photo-file data-report-id="' +
              escape(report.id) + '" data-phase="' + phase + '" data-slot="' + slot + '" /></label>' +
              '<button type="button" class="ep-calendar__photo-remove" data-washing-photo-remove="' +
            escape(photo.id) + '" data-washing-report="' + escape(report.id) + '" aria-label="Remove ' +
              escape(phase) + ' photo slot ' + slot + '">Remove</button>' + retryAction + '</div>'
          : "") +
        (error ? '<small class="ep-calendar__photo-error" role="alert">' + escape(error) + '</small>' : "") +
      '</div>';
    }
    return '<div class="ep-calendar__photo-slot">' +
      (report.can_add_evidence
        ? '<label class="ep-calendar__photo-add">+ Add file<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" data-washing-photo-file data-report-id="' +
          escape(report.id) + '" data-phase="' + phase + '" data-slot="' + slot + '" /></label>'
        : '<span class="ep-calendar__photo-empty">Not added</span>') +
      retryAction +
      (error ? '<small class="ep-calendar__photo-error" role="alert">' + escape(error) + '</small>' : "") +
    '</div>';
  }

  function renderDraftRecordPhotos(state, row) {
    var draftId = "draft:" + row.date;
    var opened = state.recordPhotoOpenId === draftId;
    return '<details class="ep-calendar__record-photos" data-record-draft-photos="' + escape(row.date) + '"' +
      (opened ? " open" : "") + '><summary>Evidence · images or PDFs up to 10 MB upload when this entry is saved</summary>' +
      '<div class="ep-calendar__photo-rows">' +
        ["before", "after"].map(function (phase) {
          return '<div class="ep-calendar__photo-row"><strong>' +
            (phase === "before" ? "Before" : "After") + '</strong><div>' +
            [1, 2].map(function (slot) {
              var key = recordPhotoKey(draftId, phase, slot);
              var file = state.recordPendingPhotos[key];
              return '<div class="ep-calendar__photo-slot">' +
                (file
                  ? '<span class="ep-calendar__photo-file" title="' + escape(file.name) + '">' +
                    escape(file.name) + '</span><button type="button" class="ep-calendar__photo-remove" data-record-draft-photo-remove="' +
                    escape(row.date) + '" data-phase="' + phase + '" data-slot="' + slot + '">Remove</button>'
                  : '<label class="ep-calendar__photo-add">+ Add ' + (phase === "before" ? "before" : "after") +
                    ' file<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" ' +
                    'data-record-draft-photo data-date="' + escape(row.date) + '" data-phase="' + phase +
                    '" data-slot="' + slot + '" /></label>') +
              '</div>';
            }).join("") +
          '</div></div>';
        }).join("") +
      '</div></details>';
  }

  function renderRecordPhotoContent(state, report) {
    var opened = state.recordPhotoOpenId === report.id;
    var loading = state.recordPhotoLoading[report.id];
    var loaded = state.recordPhotosLoaded[report.id];
    var error = state.recordPhotoErrors[report.id];
    return !opened ? "" : loading
        ? '<p class="ep-calendar__photo-message" role="status">Loading photo slots…</p>'
        : error
          ? '<p class="ep-calendar__photo-error" role="alert">' + escape(error) +
            ' <button type="button" data-washing-photo-retry="' + escape(report.id) + '">Retry</button></p>'
          : loaded
            ? '<div class="ep-calendar__photo-rows">' +
                ["before", "after"].map(function (phase) {
                  return '<div class="ep-calendar__photo-row"><strong>' +
                    (phase === "before" ? "Before" : "After") + '</strong><div>' +
                    renderRecordPhotoSlot(state, report, phase, 1) +
                    renderRecordPhotoSlot(state, report, phase, 2) +
                    '</div></div>';
                }).join("") +
              '</div>'
            : '<p class="ep-calendar__photo-message">Open to load this day’s photos.</p>';
  }

  function renderRecordPhotos(state, report) {
    var opened = state.recordPhotoOpenId === report.id;
    return '<details class="ep-calendar__record-photos" data-record-photos="' + escape(report.id) + '"' +
      (opened ? " open" : "") + '><summary>Photos</summary>' +
      '<div data-record-photo-content="' + escape(report.id) + '">' +
        renderRecordPhotoContent(state, report) +
      '</div>' +
    '</details>';
  }

  function updateRecordPhotoContent(host, state, reportId) {
    var details = Array.prototype.find.call(host.querySelectorAll("[data-record-photos]"), function (item) {
      return item.dataset.recordPhotos === reportId;
    });
    var container = details && details.querySelector("[data-record-photo-content]");
    var report = (state.washingReports || []).find(function (item) {
      return String(item.id) === reportId;
    });
    if (container && report) {
      container.innerHTML = renderRecordPhotoContent(state, report);
      if (global.Solar91PhotoEvidence) global.Solar91PhotoEvidence.watch(container);
    }
  }

  function loadRecordPhotos(host, state, reportId, retry) {
    if (!retry && state.recordPhotosLoaded[reportId]) {
      updateRecordPhotoContent(host, state, reportId);
      return;
    }
    if (!retry && state.recordPhotoLoading[reportId]) {
      updateRecordPhotoContent(host, state, reportId);
      return;
    }
    state.recordPhotoLoading[reportId] = true;
    delete state.recordPhotoErrors[reportId];
    updateRecordPhotoContent(host, state, reportId);
    global.Solar91PortalAPI.request(
      "/api/photos?link=washing&link_id=" + encodeURIComponent(reportId) +
      "&phase_slots=true&window=all&limit=4&meta=false"
    ).then(function (result) {
      if (!active || active.host !== host || active.state !== state) return;
      state.recordPhotos[reportId] = result.items || [];
      state.recordPhotosLoaded[reportId] = true;
      state.recordPhotoLoading[reportId] = false;
      updateRecordPhotoContent(host, state, reportId);
    }).catch(function (error) {
      if (!active || active.host !== host || active.state !== state) return;
      state.recordPhotoLoading[reportId] = false;
      state.recordPhotoErrors[reportId] = error.message || "Photo slots could not be loaded.";
      updateRecordPhotoContent(host, state, reportId);
    });
  }

  function uploadRecordPhoto(host, state, input) {
    var reportId = input.dataset.reportId;
    var phase = input.dataset.phase;
    var slot = Number(input.dataset.slot);
    var file = input.files && input.files[0];
    if (!file || !global.Solar91PhotoEvidence) return;
    var key = recordPhotoKey(reportId, phase, slot);
    if (state.recordPhotoBusy[key]) return;
    state.recordPendingPhotos[key] = file;
    var report = (state.washingReports || []).find(function (item) {
      return String(item.id) === String(reportId);
    });
    if (report) uploadRecordPhotoFile(host, state, report, phase, slot, file);
  }

  function uploadRecordPhotoFile(host, state, report, phase, slot, file) {
    if (!file || !global.Solar91PhotoEvidence || !report || !report.id) return Promise.resolve(false);
    var reportId = String(report.id);
    var key = recordPhotoKey(reportId, phase, slot);
    if (state.recordPhotoBusy[key]) return Promise.resolve(false);
    state.recordPhotoBusy[key] = true;
    delete state.recordPhotoErrors[key];
    state.recordPhotoOpenId = reportId;
    updateRecordPhotoContent(host, state, reportId);
    return global.Solar91PhotoEvidence.upload({
      plantId: state.washingPlant.plant_id,
      category: "washing",
      linkType: "washing",
      linkId: reportId,
      phase: phase,
      slot: slot,
      files: [file],
      submissionId: global.Solar91PhotoEvidence.submissionId()
    }).then(function (result) {
      if (!active || active.host !== host || active.state !== state) return false;
      var photo = result.records && result.records[0];
      state.recordPhotos[reportId] = (state.recordPhotos[reportId] || []).filter(function (item) {
        return !(item.phase === phase && Number(item.slot) === slot);
      });
      if (photo) state.recordPhotos[reportId].push(photo);
      state.recordPhotosLoaded[reportId] = true;
      state.recordPhotoBusy[key] = false;
      delete state.recordPendingPhotos[key];
      delete state.recordPhotoErrors[key];
      if (result.storage_warning && isStorageAdministrator()) state.recordNotice = result.storage_warning;
      updateRecordPhotoContent(host, state, reportId);
      return true;
    }).catch(function (error) {
      if (!active || active.host !== host || active.state !== state) return false;
      state.recordPhotoBusy[key] = false;
      state.recordPhotoErrors[key] = error.message || "Photo upload failed. The cleaning report is still saved.";
      updateRecordPhotoContent(host, state, reportId);
      return false;
    });
  }

  function isStorageAdministrator() {
    var user = global.Solar91PortalAPI.currentUser();
    return !!user && ["O&M Head", "Administration"].indexOf(user.role) !== -1;
  }

  function renderRecordModal(state) {
    if (!state.recordOpen || !state.washingPlant) return "";
    var cycles = state.washingPlant.cycles || [];
    var cycle = recordCycle(state);
    var rows = recordRows(state);
    var summary = state.washingSummary || {};
    var extraTables = Number(summary.extra_tables) || 0;
    var rolloverCandidate = !state.recordSameDayDate && canRecordWashing()
      ? sameDayNextCycleCandidate(state)
      : null;
    var days = rows.map(function (row) {
      var dateLabel = new Intl.DateTimeFormat("en-IN", {
        weekday: "short", day: "2-digit", month: "short"
      }).format(new Date(row.date + "T12:00:00"));
      if (row.report) {
        var numbers = row.numbers && row.numbers.length ? formatTableList(row.numbers) : "\u2014";
        // Extra cleaning is not cycle progress, so keep its label visible beside the table numbers.
        if (row.report.is_extra === true) numbers += " (extra cleaning)";
        var edit = state.recordEdit;
        if (edit && edit.id === row.report.id) return renderRecordEditRow(state, row, dateLabel);
        return '<div class="ep-calendar__record-row ep-calendar__record-row--saved">' +
          '<span>' + escape(dateLabel) + '</span><strong>' +
          (row.report.job_status === "Done" ? Number(row.report.tables_cleaned || 0) : "Not done") +
          '</strong><span>' + escape(numbers) + '</span>' +
          '<span class="ep-calendar__record-remark-cell"><span>' +
          escape(row.report.remarks || row.report.exception_reason || row.report.review_status) + '</span>' +
          (row.report.can_edit && !state.recordSaving
            ? '<button type="button" class="ep-calendar__record-edit" data-record-edit="' + escape(row.report.id) +
              '" aria-label="Edit ' + escape(dateLabel) + '">Edit</button>'
            : "") + '</span>' + renderRecordPhotos(state, row.report) + '</div>';
      }
      var reason = row.draft.reason || "";
      var zero = row.zero;
      var off = row.full || state.recordSaving ? " disabled" : "";
      var count = rowTableCount(row);
      // Tables are always entered as the numbers cleaned that day: there is no "from start" or
      // "from end" shortcut, so no mode picker either.
      var inputs = '<input type="text" data-record-list placeholder="e.g. 1-5, 9, 12" value="' + escape(row.draft.list || "") +
        '" aria-label="Table numbers for ' + escape(dateLabel) + '"' + (zero ? " disabled" : off) + ' />';
      // A day with nothing cleaned is a "Not done" day with its reason, not a 0 count: the reason is
      // what the compliance score and the month's records read.
      var notDone = '<select data-record-notdone class="ep-calendar__record-notdone"' + off +
        ' aria-label="Not done reason for ' + escape(dateLabel) + '">' +
        '<option value="">Tables cleaned</option>' +
        '<optgroup label="Not done">' + NOT_DONE_REASONS.map(function (item) {
          return '<option value="' + escape(item) + '"' + (reason === item ? " selected" : "") + '>' + escape(item) + '</option>';
        }).join("") + '</optgroup></select>';
      if (row.sameDayNextCycle) {
        notDone = '<span class="ep-calendar__record-cycle-start">Next cycle starts</span>';
      }
      return '<div class="ep-calendar__record-row" data-record-date="' + row.date + '">' +
        '<label><span class="ep-calendar__record-mobile-label">Day</span><strong>' + escape(dateLabel) + '</strong></label>' +
        '<span class="ep-calendar__record-count" data-record-count>' +
          (zero ? "Not done" : (count ? count : '<span aria-label="Not entered">\u2014</span>')) + '</span>' +
        '<div class="ep-calendar__record-range">' + inputs + notDone + '</div>' +
        '<input type="text" data-record-remarks maxlength="4000" placeholder="Remarks" value="' +
          escape(row.draft.remarks || "") + '" aria-label="Remarks for ' + escape(dateLabel) + '"' + off + ' />' +
        '<span class="ep-calendar__record-error" data-record-error' + (row.error ? "" : " hidden") + '>' +
          escape(row.error) + '</span>' +
        '<span class="ep-calendar__record-note" data-record-note' + (row.note ? "" : " hidden") + '>' +
          escape(row.note || "") + '</span>' +
        '</div>' + (rowEntered(row) ? renderDraftRecordPhotos(state, row) : "");
    }).join("");

    return '<div class="ep-calendar__modal ep-calendar__record-modal" data-calendar-record-modal>' +
      '<button class="ep-calendar__backdrop" type="button" data-calendar-action="close-record" aria-label="Close record module cleaning"></button>' +
      '<section class="ep-calendar__dialog" role="dialog" aria-modal="true" aria-labelledby="washing-record-title">' +
        '<header class="ep-calendar__dialog-head"><div><h2 id="washing-record-title">' +
          escape(state.washingPlant.plant) + '</h2><p>' + escape(state.washingPlant.site_code) + " · " +
          escape(state.washingPlant.table_count) + " tables · " +
          escape(state.washingPlant.assignee_name || "No Assignee") + '</p></div>' +
          '<div class="ep-calendar__dialog-head-actions">' +
            (rolloverCandidate
              ? '<button type="button" class="ep-calendar__extra-open" data-calendar-action="open-same-day-next-cycle">' +
                'Start Cycle ' + rolloverCandidate.nextCycle + ' on ' +
                escape(displayDate(rolloverCandidate.date)) + '</button>'
              : state.recordSameDayDate
                ? '<button type="button" class="ep-calendar__extra-open" data-calendar-action="cancel-same-day-next-cycle">' +
                  'Cancel same-day entry</button>'
                : "") +
            (canRecordWashing()
              ? '<button type="button" class="ep-calendar__extra-open" data-calendar-action="open-extra">' +
                '+ Extra cleaning</button>'
              : "") +
            '<button type="button" class="ep-calendar__close" data-calendar-action="close-record" aria-label="Close">×</button>' +
          '</div></header>' +
        '<div class="ep-calendar__record-progress"><strong>Cycle ' + Number(state.recordCycle) + '</strong>' +
          '<span>' + escape(cycle ? cycle.confirmed : 0) + " of " + escape(state.washingPlant.table_count) +
          " tables · due " + (cycle && cycle.due_date ? escape(displayDate(cycle.due_date)) : "—") +
          (extraTables ? " · " + escape(extraTables) + " extra table" + (extraTables === 1 ? "" : "s") +
            " cleaned this month" : "") + '</span>' +
          '<i><span style="width:' + (cycle && state.washingPlant.table_count
            ? Math.min(100, Math.round(100 * Number(cycle.confirmed || 0) / Number(state.washingPlant.table_count)))
            : 0) + '%"></span></i></div>' +
        '<nav class="ep-calendar__record-tabs" aria-label="Module Cleaning cycle">' +
          cycles.map(function (item) {
            return '<button type="button" data-record-cycle="' + item.cycle_no + '"' +
              (item.state === "Upcoming" ? " disabled" : "") +
              (Number(item.cycle_no) === Number(state.recordCycle) ? ' aria-current="true"' : "") + '>' +
              'Cycle ' + item.cycle_no + '</button>';
          }).join("") +
        '</nav>' +
        '<div class="ep-calendar__record-body">' +
          (state.recordError ? '<p class="ep-calendar__record-error" role="alert">' + escape(state.recordError) + '</p>' : "") +
          (state.recordNotice ? '<p class="ep-calendar__record-notice" role="status">' + escape(state.recordNotice) + '</p>' : "") +
          '<p class="ep-calendar__record-tables"><strong>Cleaned this cycle:</strong> ' +
            escape(rows.cleanedTables && rows.cleanedTables.length ? formatTableList(rows.cleanedTables) : "none yet") +
            '<br><strong>Not cleaned yet:</strong> ' +
            escape(rows.openTables && rows.openTables.length ? formatTableList(rows.openTables) : "none") + '</p>' +
          (rows.length
            ? '<div class="ep-calendar__record-table"><div class="ep-calendar__record-head"><span>Day</span><span>Tables</span><span>Table numbers</span><span>Remarks</span></div>' +
              days + '</div>'
            : '<p class="ep-calendar__empty">No reportable days for this cycle yet.</p>') +
          '<p class="ep-calendar__record-help">Type the tables cleaned that day as numbers or ranges, e.g. 1, 2, 4, 7-8, 13 or 100-91. Each table counts once per cycle. The next cycle starts only after all configured tables are cleaned. Use + Extra cleaning for re-cleaning between cycles; it stays on the calendar and does not increase compliance. Only extra cleaning after all three cycles are complete increases compliance. When nothing was cleaned, choose the not-done reason for that day and add the details in Remarks.' +
            (canManageWashing() ? " Apart from that, tables already cleaned in an incomplete cycle cannot be selected again." : "") + '</p>' +
        '</div>' +
        '<footer class="ep-calendar__record-footer"><button type="button" class="ep-calendar__close-button" data-calendar-action="close-record"' +
          (state.recordSaving ? " disabled" : "") + '>Cancel</button>' +
          '<button type="button" class="ep-calendar__setup-submit" data-calendar-action="save-record"' +
            (state.recordSaving || !rows.some(rowEntered) ? " disabled" : "") + '>' +
            (state.recordSaving ? "Saving…" : "Save") + '</button></footer>' +
      '</section>' +
    '</div>';
  }

  /** How far back this user may record, as the API allows: the O&M team back to the sheet's range,
   *  a Site Engineer the last 45 days (MAX_BACKDATE_DAYS in app/scheduled/washing_cycles.py). */
  function earliestRecordDate(state) {
    var today = state.washingDataToday || new Date().toISOString().slice(0, 10);
    if (canManageWashing()) return state.month + "-01";
    var first = new Date(today + "T12:00:00");
    first.setDate(first.getDate() - 44);
    return first.getFullYear() + "-" + pad2(first.getMonth() + 1) + "-" + pad2(first.getDate());
  }

  /** The tables an extra-cleaning entry covers, or why it cannot be saved yet. Repeats are the point
   *  here, so a table already cleaned in the running cycle is accepted; only the plant's own table
   *  numbers are enforced, exactly as the API enforces them. */
  function planExtra(state, total) {
    var text = String(state.extraList || "").trim();
    if (!state.extraDate) return { numbers: [], error: "" };
    if (!text) return { numbers: [], error: "" };
    var parsed = parseTableList(text, total);
    return { numbers: parsed.numbers, error: parsed.error };
  }

  function renderExtraModal(state) {
    if (!state.extraOpen || !state.washingPlant) return "";
    var total = Number(state.washingPlant.table_count) || 0;
    var plan = planExtra(state, total);
    var disabled = state.extraSaving ? " disabled" : "";
    var manager = canManageWashing();
    var editing = !!state.extraEditId;
    var ready = !!state.extraDate && !plan.error && plan.numbers.length > 0;
    return '<div class="ep-calendar__modal ep-calendar__extra-modal" data-calendar-extra-modal>' +
      '<button class="ep-calendar__backdrop" type="button" data-calendar-action="close-extra" aria-label="Close extra cleaning"></button>' +
      '<section class="ep-calendar__dialog ep-calendar__extra-dialog" role="dialog" aria-modal="true" aria-labelledby="washing-extra-title">' +
        '<header class="ep-calendar__dialog-head"><div>' +
          '<h2 id="washing-extra-title">' + (editing ? "Edit extra cleaning" : "Extra cleaning") + '</h2>' +
          '<p>' + escape(state.washingPlant.plant) + " \u00b7 " + escape(total) + ' tables per cycle</p>' +
        '</div><button type="button" class="ep-calendar__close" data-calendar-action="close-extra" aria-label="Close">\u00d7</button></header>' +
        '<div class="ep-calendar__extra-body">' +
          '<p class="ep-calendar__extra-lead">Record tables cleaned again during a running cycle \u2014 dust, fog or anything else. ' +
            'Before all three cycles are complete, this is a calendar entry only and does <strong>not</strong> count towards ' +
            'cycle progress or plant compliance. Extra cleaning after all three cycles are complete increases monthly compliance.</p>' +
          (manager
            ? ""
            : '<p class="ep-calendar__extra-lead">Your entry is saved as awaiting review; the O&amp;M Head or the plant\u2019s ' +
              'Cleaning Assignee confirms it.</p>') +
          '<form class="ep-calendar__extra-form" data-calendar-extra-form>' +
            '<label><span>Date cleaned</span>' +
              '<input type="date" data-extra-date value="' + escape(state.extraDate) + '" min="' +
                escape(earliestRecordDate(state)) + '" max="' +
                escape(state.washingDataToday || "") + '" required' + disabled + ' /></label>' +
            '<label><span>Table numbers</span>' +
              '<input type="text" data-extra-list placeholder="e.g. 26-35, 40 or 100-91" value="' +
                escape(state.extraList) + '" autocomplete="off"' + disabled + ' />' +
              '<small data-extra-preview>' + (plan.numbers.length
                  ? escape(plan.numbers.length + " table" + (plan.numbers.length === 1 ? "" : "s") +
                    ": " + formatTableList(plan.numbers))
                  : escape("Tables 1 to " + total)) + '</small></label>' +
            '<label><span>Reason / remarks</span>' +
              '<input type="text" data-extra-remarks maxlength="4000" placeholder="e.g. heavy dust after harvest" value="' +
                escape(state.extraRemarks) + '"' + disabled + ' /></label>' +
          '</form>' +
          '<p class="ep-calendar__setup-error" data-extra-plan-error role="alert"' +
            (plan.error ? "" : " hidden") + '>' + escape(plan.error) + '</p>' +
          '<p class="ep-calendar__setup-error" data-extra-error role="alert"' +
            (state.extraError ? "" : " hidden") + '>' + escape(state.extraError) + '</p>' +
        '</div>' +
        '<footer class="ep-calendar__record-footer">' +
          '<button type="button" class="ep-calendar__close-button" data-calendar-action="close-extra"' + disabled + '>Cancel</button>' +
          '<button type="button" class="ep-calendar__setup-submit" data-calendar-action="save-extra"' +
            (ready && !state.extraSaving ? "" : " disabled") + '>' +
            (state.extraSaving ? "Saving\u2026" : editing ? "Save changes" : "Save extra cleaning") + '</button></footer>' +
      '</section>' +
    '</div>';
  }

  function renderSetupModal(state) {
    if (!state.setupOpen) return "";
    var setup = state.washingSetup || {};
    var assignees = state.setupAssignees || [];
    var noAssignees = state.setupAssigneesLoaded && !assignees.length;
    return '<div class="ep-calendar__modal ep-calendar__setup-modal" data-calendar-setup-modal>' +
      '<button class="ep-calendar__backdrop" type="button" data-calendar-action="close-setup" aria-label="Close module cleaning setup"></button>' +
      '<section class="ep-calendar__dialog" role="dialog" aria-modal="true" aria-labelledby="washing-setup-title">' +
        '<header class="ep-calendar__dialog-head"><div>' +
          '<h2 id="washing-setup-title">Set up module cleaning</h2>' +
          '<p>' + escape(setup.plantName || "Selected plant") + " · " + escape(setup.siteCode || "") + '</p>' +
        '</div><button type="button" class="ep-calendar__close" data-calendar-action="close-setup" aria-label="Close">×</button></header>' +
        (state.setupLoading
          ? '<p class="ep-calendar__setup-message" role="status">Loading active Assignees…</p>'
          : '<form class="ep-calendar__setup-form" data-calendar-setup-form>' +
              '<label><span>Tables in each cycle</span>' +
                '<input type="number" name="table_count" min="1" max="5000" step="1" required value="' +
                  escape(setup.tableCount || "") + '"' + (state.setupSaving ? " disabled" : "") + ' /></label>' +
              '<label><span>Module Cleaning Assignee</span><select name="assignee_user_id" required' +
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
    var typeLabel = context.type === "pm" ? "Preventive Maintenance" : "Module Cleaning";
    var plant = context.plantCode && state.plants.find(function (item) {
      return item.siteCode === context.plantCode;
    });
    var headerEyebrow = context.type === "washing" && context.plantCode
      ? '<p class="ep-calendar__eyebrow ep-calendar__eyebrow--plant">' +
        '<span class="ep-calendar__plant-name">' +
          escape(plant && (plant.plantName || plant.displayName) || context.plantCode) + '</span>' +
        '<span class="ep-calendar__plant-code">' + escape(context.plantCode) + '</span></p>'
      : '<p class="ep-calendar__eyebrow">' + (context.plantCode ? "Plant view" : "Views") + '</p>';
    var subtitle = "";
    if (context.type !== "washing") {
      subtitle = context.plantCode
        ? "Plant calendar for " + (plant ? plantLabel(plant) : context.plantCode) + "."
        : "Portfolio calendar across all plants.";
      if (state.rangeStart && state.rangeEnd) {
        subtitle += " Showing records from " + state.rangeStart + " through " + state.rangeEnd + ".";
      }
    }
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
      content = renderCalendarGrid(state, events, hoverEnabled, hoverId, context);
    }
    var showSetupButton = state.liveWashing && state.washingSetup &&
      context.plantCode && canManageWashing();
    var showRecordButton = state.liveWashing && state.washingPlant &&
      context.plantCode && canRecordWashing();
    var showPMSetupButton = context.type === "pm" && canManagePMSetup();
    // The record modal body scrolls on its own. A full re-render (save, not-done change, an
    // error, a cycle switch) rebuilds host.innerHTML and would reset that scroll to the top,
    // throwing the user back up the day list after every entry. Keep the position across the swap.
    var recordBodyBefore = host.querySelector(".ep-calendar__record-body");
    var recordScrollTop = recordBodyBefore ? recordBodyBefore.scrollTop : null;
    var subtitleMarkup = context.type === "washing" ? "" :
      '<p class="ep-calendar__subtitle">' + escape(subtitle) +
        " Entries are saved records on their scheduled date.</p>";
    host.innerHTML = '<div class="ep-calendar">' +
      '<header class="ep-calendar__head"><div>' + headerEyebrow +
        '<h1>' + escape(typeLabel) + '</h1>' + subtitleMarkup + '</div>' +
        '<div class="ep-calendar__head-actions">' +
        (context.fromPmOverview
          ? '<button type="button" class="ep-calendar__setup-button" data-calendar-action="return-to-pm-overview">Back to Preventive Maintenance</button>'
          : "") +
        '<span class="ep-calendar__count">' + escape(statusCounts) + '</span>' +
          (showRecordButton
            ? '<button type="button" class="ep-calendar__setup-button" data-calendar-action="open-record">Record module cleaning</button>'
            : "") +
          (showSetupButton
            ? '<button type="button" class="ep-calendar__setup-button" data-calendar-action="open-setup">Set up module cleaning</button>'
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
        '<div class="ep-calendar__month-nav"><button type="button" data-calendar-action="previous" aria-label="' +
          (state.span === "week" ? "Previous week" : "Previous month") + '">‹</button>' +
          '<h2>' + escape(state.span === "week" ? displayWeek(state.weekStart) : displayMonth(state.month)) + '</h2>' +
          '<button type="button" data-calendar-action="next" aria-label="' +
          (state.span === "week" ? "Next week" : "Next month") + '">›</button>' +
        '</div>' +
        // The month is the default for Module Cleaning; the Week button remains available.
        '<div class="ep-calendar__span" role="group" aria-label="Dates shown">' +
          '<button type="button" data-calendar-action="span-week"' +
            (state.span === "week" ? ' class="is-on" aria-pressed="true"' : ' aria-pressed="false"') + ">Week</button>" +
          '<button type="button" data-calendar-action="span-month"' +
            (state.span === "week" ? ' aria-pressed="false"' : ' class="is-on" aria-pressed="true"') + ">Month</button>" +
        "</div>" +
        '<button type="button" class="ep-calendar__today" data-calendar-action="today">Today</button>' +
      '</div>' +
      (state.truncated
        ? '<p class="ep-calendar__truncated" role="status">This month has more than ' + state.truncated +
          ' entries; only the first ' + state.truncated + ' are shown. Open a single plant to see all of its entries.</p>'
        : "") +
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
      renderExtraModal(state) +
    '</div>';
    if (recordScrollTop !== null) {
      var recordBodyAfter = host.querySelector(".ep-calendar__record-body");
      if (recordBodyAfter) recordBodyAfter.scrollTop = recordScrollTop;
    }
    if (global.Solar91PhotoEvidence) global.Solar91PhotoEvidence.watch(host);
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
        // Only this plant's figures are read here (the plant's reports come from /cycles), so ask for one plant
        // without the report list instead of the whole portfolio's overview.
        api.request("/api/scheduled/washing/overview?month=" + queryMonth +
          "&plant_id=" + encodeURIComponent(selected.dbId) + "&include_reports=false"),
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
          complianceThreshold: overviewPlant && overviewPlant.compliance_threshold_percent || 85,
          fastWindowDays: overviewPlant && overviewPlant.fast_window_days || 7
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
        state.washingSummary = cyclesData.summary || null;
        state.washingPlant.cycles_this_month = (cyclesData.cycles || []).filter(function (cycle) {
          return cycle.state === "Completed";
        }).length;
        var events = [];
        (cyclesData.reports || []).forEach(function (report) {
          var status = report.review_status === "Pending"
            ? "Awaiting confirmation"
            : report.review_status === "Rejected"
              ? "Rejected"
              : report.job_status === "Done" ? "Completed" : "Not done";
          events.push({
            date: report.report_date,
            title: report.is_extra === true
              ? Number(report.tables_cleaned || 0) + " tables re-cleaned (extra)"
              : report.job_status === "Done"
                ? Number(report.tables_cleaned || 0) + " tables cleaned"
                : "No module cleaning reported",
            status: status,
            isExtra: report.is_extra === true,
            reportId: report.id,
            canEdit: report.can_edit === true,
            canDelete: report.can_delete === true,
            plantSiteCode: selected.siteCode,
            plantName: selected.plantName,
            cycleNo: report.cycle_no,
            cycleCompleted: report.review_status === "Confirmed" && report.cycle_completed === true,
            tablesCleaned: report.tables_cleaned,
            tablesList: formatTableList(tableNumbersOf(report)),
            reviewStatus: report.review_status,
            jobStatus: report.job_status,
            reportedBy: report.reported_by,
            remarks: report.remarks,
            exceptionReason: report.exception_reason,
            source: "Saved daily report",
            kind: "report"
          });
        });
        events.sort(function (a, b) {
          return a.date.localeCompare(b.date) || a.title.localeCompare(b.title);
        });
        state.events = events.filter(function (event) {
          return (!state.rangeStart || event.date >= state.rangeStart) &&
            (!state.rangeEnd || event.date <= state.rangeEnd);
        });
        state.tooltips = {};
        events.forEach(function (event) {
          var reportsForDate = events.filter(function (item) { return item.date === event.date; });
          var noCleaning = reportsForDate.length && reportsForDate.every(function (item) {
            return item.jobStatus !== "Done";
          });
          var detail = noCleaning
            ? (event.remarks || "").trim() || (event.exceptionReason || "").trim()
            : eventCellDescription(event, context) + " · " + event.status;
          if (!detail) {
            if (noCleaning && !state.tooltips[event.date]) state.tooltips[event.date] = [];
            return;
          }
          if (noCleaning) {
            if (!state.tooltips[event.date]) state.tooltips[event.date] = [];
            if (state.tooltips[event.date].indexOf(detail) === -1) state.tooltips[event.date].push(detail);
            return;
          }
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
      state.error = error.message || "Could not load saved module cleaning cycle data.";
      if (active && active.host === host && active.state === state) renderView(host, state, context);
    });
  }

  function loadEvents(host, state, context, keepRecord) {
    state.loading = true;
    state.loaded = false;
    state.error = "";
    state.events = [];
    state.truncated = 0;
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
    state.extraOpen = false;
    state.extraEditId = "";
    state.extraDeleteConfirmId = "";
    state.extraDeleting = false;
    state.extraDeleteError = "";
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
      state.recordEdit = null;
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
      // One request for the month: the plant's own records on a plant tab, every visible plant otherwise.
      return data.fetchCalendarMonth(context.type, state.month, context.plantCode || "");
    }).then(function (page) {
      if (requestId !== state.requestId) return;
      state.truncated = page.truncated ? (page.limit || page.entries.length) : 0;
      state.events = page.entries.filter(function (event) {
        return !(context.type === "washing" && event.source === "cycle") &&
          (!state.rangeStart || event.date >= state.rangeStart) &&
          (!state.rangeEnd || event.date <= state.rangeEnd);
      }).sort(function (a, b) {
        return a.date.localeCompare(b.date) ||
          a.plantName.localeCompare(b.plantName) ||
          a.title.localeCompare(b.title);
      });
      if (state.pendingEventId) {
        var pendingEventId = state.pendingEventId;
        state.pendingEventId = null;
        if (!focusPMEvent(state, pendingEventId)) {
          state.error = "The selected PM task is no longer available in this calendar.";
        }
      }
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

  function syncRecordEdit(host, state) {
    var edit = state.recordEdit;
    var form = edit && host.querySelector("[data-record-edit-row]");
    if (!form) return;
    var value = function (selector) { var node = form.querySelector(selector); return node ? node.value : null; };
    edit.status = value("[data-record-edit-status]") || edit.status;
    var list = value("[data-record-edit-list]"); if (list !== null) edit.list = list;
    var count = value("[data-record-edit-count]"); if (count !== null) edit.count = count;
    var reason = value("[data-record-edit-reason]"); if (reason !== null) edit.reason = reason;
    var remarks = value("[data-record-edit-remarks]"); if (remarks !== null) edit.remarks = remarks;
  }

  function recordEditBody(state) {
    var edit = state.recordEdit;
    var total = Number(state.washingPlant.table_count) || 0;
    var body = { job_status: edit.status, remarks: edit.remarks || "" };
    if (edit.status === "Done") {
      if (String(edit.list || "").trim()) {
        var parsed = parseTableList(edit.list, total);
        if (parsed.error) return { error: parsed.error };
        body.table_numbers = parsed.numbers;
      } else if (edit.legacy) {
        var count = Number(edit.count);
        if (edit.count === "" || !Number.isInteger(count) || count < 1 || count > 5000) {
          return { error: "Enter the table numbers cleaned, or how many tables were cleaned." };
        }
        body.tables_cleaned = count;
      } else {
        return { error: "Enter the tables cleaned that day, e.g. 1-10, 100-91 or 1, 2, 4, 7-8, 13." };
      }
    } else {
      if (!edit.reason) return { error: "Choose the reason the work was not done." };
      body.exception_reason = edit.reason;
    }
    return { body: body };
  }

  /** Read the extra-cleaning form back into state, so a re-render never loses what was typed. */
  function syncExtraForm(host, state) {
    var form = host.querySelector("[data-calendar-extra-form]");
    if (!form) return;
    var date = form.querySelector("[data-extra-date]");
    var list = form.querySelector("[data-extra-list]");
    var remarks = form.querySelector("[data-extra-remarks]");
    if (date) state.extraDate = date.value;
    if (list) state.extraList = list.value;
    if (remarks) state.extraRemarks = remarks.value;
  }

  function refreshExtraPreview(host, state) {
    syncExtraForm(host, state);
    state.extraError = "";
    var total = Number(state.washingPlant && state.washingPlant.table_count) || 0;
    var plan = planExtra(state, total);
    var preview = host.querySelector("[data-extra-preview]");
    if (preview) {
      preview.textContent = plan.numbers.length
        ? plan.numbers.length + " table" + (plan.numbers.length === 1 ? "" : "s") +
          ": " + formatTableList(plan.numbers)
        : "Tables 1 to " + total;
    }
    var planError = host.querySelector("[data-extra-plan-error]");
    if (planError) {
      planError.textContent = plan.error;
      planError.hidden = !plan.error;
    }
    var save = host.querySelector('[data-calendar-action="save-extra"]');
    if (save) save.disabled = state.extraSaving || !state.extraDate || !!plan.error || !plan.numbers.length;
    var saveError = host.querySelector("[data-extra-error]");
    if (saveError) {
      saveError.textContent = "";
      saveError.hidden = true;
    }
  }

  function syncRecordRangeInputs(host, state) {
    host.querySelectorAll("[data-record-date]").forEach(function (row) {
      var date = row.dataset.recordDate;
      var listInput = row.querySelector("[data-record-list]");
      var remarksInput = row.querySelector("[data-record-remarks]");
      var reasonInput = row.querySelector("[data-record-notdone]");
      var reason = reasonInput ? reasonInput.value : "";
      state.recordDrafts[date] = {
        list: reason || !listInput ? "" : listInput.value,
        reason: reason,
        remarks: remarksInput ? remarksInput.value : ""
      };
    });
    var rows = recordRows(state);
    rows.forEach(function (item) {
      if (item.report) return;
      var row = host.querySelector('[data-record-date="' + item.date + '"]');
      if (!row) return;
      row.querySelector("[data-record-count]").textContent = item.zero ? "Not done" : (rowTableCount(item) || "\u2014");
      var error = row.querySelector("[data-record-error]");
      if (error) {
        error.hidden = !item.error;
        error.textContent = item.error;
      }
      var note = row.querySelector("[data-record-note]");
      if (note) {
        note.hidden = !item.note;
        note.textContent = item.note || "";
      }
      var listInput = row.querySelector("[data-record-list]");
      if (listInput) {
        listInput.disabled = item.full || item.zero || state.recordSaving;
        if (item.zero) listInput.value = "";
      }
    });
    var summary = host.querySelector(".ep-calendar__record-tables");
    if (summary) {
      summary.innerHTML = "<strong>Cleaned this cycle:</strong> " +
        escape(rows.cleanedTables.length ? formatTableList(rows.cleanedTables) : "none yet") +
        "<br><strong>Not cleaned yet:</strong> " +
        escape(rows.openTables.length ? formatTableList(rows.openTables) : "none");
    }
    var save = host.querySelector('[data-calendar-action="save-record"]');
    if (save) save.disabled = state.recordSaving || !rows.some(rowEntered);
  }

  function wire(host) {
    if (host.dataset.calendarWired === "true") return;
    host.dataset.calendarWired = "true";

    host.addEventListener("click", function (event) {
      if (!active || active.host !== host) return;
      var photoOpen = event.target.closest("[data-washing-photo-open]");
      if (photoOpen) {
        var photoList = active.state.recordPhotos[photoOpen.dataset.washingReport] || [];
        var selectedPhoto = photoList.find(function (item) {
          return item.id === photoOpen.dataset.washingPhotoOpen;
        });
        if (selectedPhoto && global.Solar91PhotoEvidence) global.Solar91PhotoEvidence.open(selectedPhoto);
        return;
      }
      var photoRetry = event.target.closest("[data-washing-photo-retry]");
      if (photoRetry) {
        loadRecordPhotos(host, active.state, photoRetry.dataset.washingPhotoRetry, true);
        return;
      }
      var retryRecordPhoto = event.target.closest("[data-record-photo-retry]");
      if (retryRecordPhoto) {
        var retryState = active.state;
        var retryReport = (retryState.washingReports || []).find(function (item) {
          return String(item.id) === retryRecordPhoto.dataset.recordPhotoRetry;
        });
        var retryPhase = retryRecordPhoto.dataset.phase;
        var retrySlot = Number(retryRecordPhoto.dataset.slot);
        var retryKey = recordPhotoKey(retryRecordPhoto.dataset.recordPhotoRetry, retryPhase, retrySlot);
        if (retryReport) uploadRecordPhotoFile(host, retryState, retryReport, retryPhase, retrySlot,
          retryState.recordPendingPhotos[retryKey]);
        return;
      }
      var discardRecordPhoto = event.target.closest("[data-record-photo-discard]");
      if (discardRecordPhoto) {
        var discardState = active.state;
        var discardKey = recordPhotoKey(discardRecordPhoto.dataset.recordPhotoDiscard,
          discardRecordPhoto.dataset.phase, Number(discardRecordPhoto.dataset.slot));
        delete discardState.recordPendingPhotos[discardKey];
        delete discardState.recordPhotoErrors[discardKey];
        updateRecordPhotoContent(host, discardState, discardRecordPhoto.dataset.recordPhotoDiscard);
        return;
      }
      var removeDraftPhoto = event.target.closest("[data-record-draft-photo-remove]");
      if (removeDraftPhoto) {
        var removeDate = removeDraftPhoto.dataset.recordDraftPhotoRemove;
        delete active.state.recordPendingPhotos[recordPhotoKey(
          "draft:" + removeDate, removeDraftPhoto.dataset.phase, Number(removeDraftPhoto.dataset.slot)
        )];
        renderView(host, active.state, active.context);
        return;
      }
      var photoRemove = event.target.closest("[data-washing-photo-remove]");
      if (photoRemove) {
        var photoState = active.state;
        var reportId = photoRemove.dataset.washingReport;
        var photoId = photoRemove.dataset.washingPhotoRemove;
        var removable = (photoState.recordPhotos[reportId] || []).find(function (item) {
          return item.id === photoId;
        });
        if (!removable) return;
        var removeKey = recordPhotoKey(reportId, removable.phase, removable.slot);
        if (photoState.recordPhotoBusy[removeKey]) return;
        photoState.recordPhotoBusy[removeKey] = true;
        delete photoState.recordPhotoErrors[removeKey];
        renderView(host, photoState, active.context);
        global.Solar91PortalAPI.request("/api/photos/" + encodeURIComponent(photoId), { method: "DELETE" })
          .then(function (result) {
            if (!active || active.host !== host || active.state !== photoState) return;
            photoState.recordPhotos[reportId] = (photoState.recordPhotos[reportId] || []).filter(function (item) {
              return item.id !== photoId;
            });
            photoState.recordPhotoBusy[removeKey] = false;
            if (result.cleanup_warning) photoState.recordPhotoErrors[removeKey] = result.cleanup_warning;
            renderView(host, photoState, active.context);
          }).catch(function (error) {
            if (!active || active.host !== host || active.state !== photoState) return;
            photoState.recordPhotoBusy[removeKey] = false;
            photoState.recordPhotoErrors[removeKey] = error.message || "Photo could not be removed.";
            renderView(host, photoState, active.context);
          });
        return;
      }
      var cycleTab = event.target.closest("[data-record-cycle]");
      if (cycleTab && active.state.recordOpen) {
        active.state.recordCycle = Number(cycleTab.dataset.recordCycle);
        active.state.recordSameDayDate = "";
        active.state.recordSameDayCycle = 0;
        active.state.recordDrafts = {};
        active.state.recordEdit = null;
        active.state.recordError = "";
        renderView(host, active.state, active.context);
        return;
      }
      var editButton = event.target.closest("[data-record-edit]");
      if (editButton && active.state.recordOpen && !active.state.recordSaving) {
        var editState = active.state;
        var editRow = recordRows(editState).filter(function (item) {
          return item.report && item.report.id === editButton.dataset.recordEdit;
        })[0];
        if (!editRow) return;
        syncRecordRangeInputs(host, editState);
        var saved = editRow.report;
        editState.recordEdit = {
          id: saved.id,
          status: saved.job_status,
          list: formatTableList(editRow.numbers || []),
          legacy: saved.job_status === "Done" && !(editRow.numbers || []).length && Number(saved.tables_cleaned) > 0,
          count: saved.job_status === "Done" ? String(saved.tables_cleaned || "") : "",
          reason: saved.exception_reason || "",
          remarks: saved.remarks || "",
          saving: false,
          error: ""
        };
        editState.recordError = "";
        editState.recordNotice = "";
        renderView(host, editState, active.context);
        return;
      }
      if (event.target.closest("[data-record-edit-cancel]") && active.state.recordEdit &&
          !active.state.recordEdit.saving) {
        active.state.recordEdit = null;
        renderView(host, active.state, active.context);
        return;
      }
      if (event.target.closest("[data-record-edit-save]") && active.state.recordEdit) {
        var saveState = active.state;
        var pending = saveState.recordEdit;
        if (pending.saving) return;
        syncRecordEdit(host, saveState);
        var built = recordEditBody(saveState);
        if (built.error) {
          pending.error = built.error;
          renderView(host, saveState, active.context);
          return;
        }
        pending.saving = true;
        pending.error = "";
        renderView(host, saveState, active.context);
        global.Solar91PortalAPI.request("/api/scheduled/washing/daily-reports/" + encodeURIComponent(pending.id), {
          method: "PATCH",
          body: built.body
        }).then(function () {
          if (!active || active.host !== host || active.state !== saveState) return;
          if (data && data.invalidate) data.invalidate(true);
          saveState.recordEdit = null;
          saveState.recordNotice = "Day updated.";
          loadEvents(host, saveState, active.context, true);
        }).catch(function (error) {
          if (!active || active.host !== host || active.state !== saveState || !saveState.recordEdit) return;
          saveState.recordEdit.saving = false;
          saveState.recordEdit.error = "Not saved. " + (error && error.message ? error.message : "Please retry.");
          renderView(host, saveState, active.context);
        });
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

      if (action.dataset.calendarAction === "return-to-pm-overview") {
        if (global.Solar91PortalNav) global.Solar91PortalNav.closePMCalendar();
      } else if (action.dataset.calendarAction === "previous" || action.dataset.calendarAction === "next") {
        var shift = action.dataset.calendarAction === "previous" ? -1 : 1;
        if (state.span === "week") {
          state.weekStart = shiftDays(state.weekStart, shift * 7);
          // A week that starts in the previous month is read from that month's records.
          state.month = state.weekStart.slice(0, 7);
        } else {
          var parts = monthParts(state.month);
          state.month = monthKey(new Date(parts.year, parts.month - 1 + shift, 1));
          state.weekStart = weekStartOf(new Date(monthParts(state.month).year, monthParts(state.month).month - 1, 1));
        }
        state.modalDate = "";
        state.detailEventIndex = null;
        loadEvents(host, state, context);
      } else if (action.dataset.calendarAction === "today") {
        state.month = monthKey(new Date());
        state.weekStart = weekStartOf(new Date());
        state.modalDate = "";
        state.detailEventIndex = null;
        loadEvents(host, state, context);
      } else if (action.dataset.calendarAction === "span-week" ||
                 action.dataset.calendarAction === "span-month") {
        state.span = action.dataset.calendarAction === "span-week" ? "week" : "month";
        if (state.span === "week" && state.weekStart.slice(0, 7) !== state.month) {
          // Switching to Week lands on the first week of the month being read.
          state.weekStart = weekStartOf(new Date(monthParts(state.month).year, monthParts(state.month).month - 1, 1));
        }
        state.modalDate = "";
        state.detailEventIndex = null;
        renderView(host, state, context);
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
        clearDraftRecordPhotos(state);
        var cycles = state.washingPlant.cycles || [];
        var selectedCycle = cycles.find(function (cycle) { return cycle.state === "In progress"; }) ||
          cycles.find(function (cycle) { return cycle.state === "Upcoming"; }) ||
          cycles.find(function (cycle) { return cycle.state === "Missed"; }) || cycles[0];
        state.recordCycle = selectedCycle ? Number(selectedCycle.cycle_no) : 1;
        state.recordOpen = true;
        state.recordSameDayDate = "";
        state.recordSameDayCycle = 0;
        state.recordEdit = null;
        state.recordDrafts = {};
        state.recordError = "";
        state.recordNotice = "";
        renderView(host, state, context);
      } else if (action.dataset.calendarAction === "open-same-day-next-cycle") {
        var sameDayCandidate = sameDayNextCycleCandidate(state);
        if (!canRecordWashing() || !state.recordOpen || !sameDayCandidate) return;
        state.recordCycle = sameDayCandidate.nextCycle;
        state.recordSameDayDate = sameDayCandidate.date;
        state.recordSameDayCycle = sameDayCandidate.nextCycle;
        state.recordDrafts = {};
        state.recordEdit = null;
        state.recordError = "";
        state.recordNotice = "";
        renderView(host, state, context);
        var sameDayTableInput = host.querySelector('[data-record-date="' +
          state.recordSameDayDate + '"] [data-record-list]');
        if (sameDayTableInput) sameDayTableInput.focus();
      } else if (action.dataset.calendarAction === "cancel-same-day-next-cycle") {
        if (state.recordSaving) return;
        state.recordSameDayDate = "";
        state.recordSameDayCycle = 0;
        state.recordDrafts = {};
        state.recordError = "";
        renderView(host, state, context);
      } else if (action.dataset.calendarAction === "open-extra") {
        if (!canRecordWashing() || !state.washingPlant) return;
        state.extraOpen = true;
        state.extraEditId = "";
        state.extraDate = state.washingDataToday || "";
        state.extraList = "";
        state.extraRemarks = "";
        state.extraError = "";
        renderView(host, state, context);
        var extraList = host.querySelector("[data-extra-list]");
        if (extraList) extraList.focus();
      } else if (action.dataset.calendarAction === "edit-extra") {
        if (!canManageWashing() || !state.washingPlant || !state.washingSetup) return;
        var savedExtra = (state.washingReports || []).find(function (report) {
          return report.id === action.dataset.reportId && report.is_extra === true && report.can_edit === true;
        });
        if (!savedExtra) return;
        state.extraOpen = true;
        state.extraEditId = savedExtra.id;
        state.extraDate = savedExtra.report_date || "";
        state.extraList = formatTableList(tableNumbersOf(savedExtra));
        state.extraRemarks = savedExtra.remarks || "";
        state.extraError = "";
        state.detailEventIndex = null;
        renderView(host, state, context);
        var editExtraDate = host.querySelector("[data-extra-date]");
        if (editExtraDate) editExtraDate.focus();
      } else if (action.dataset.calendarAction === "request-extra-delete") {
        if (!canManageWashing()) return;
        var deletableExtra = (state.washingReports || []).find(function (report) {
          return report.id === action.dataset.reportId && report.is_extra === true && report.can_delete === true;
        });
        if (!deletableExtra) return;
        state.extraDeleteConfirmId = deletableExtra.id;
        state.extraDeleteError = "";
        renderView(host, state, context);
      } else if (action.dataset.calendarAction === "cancel-extra-delete") {
        if (state.extraDeleting) return;
        state.extraDeleteConfirmId = "";
        state.extraDeleteError = "";
        renderView(host, state, context);
      } else if (action.dataset.calendarAction === "confirm-extra-delete") {
        if (state.extraDeleting || !canManageWashing()) return;
        var deleteId = action.dataset.reportId;
        var deletableRecord = (state.washingReports || []).find(function (report) {
          return report.id === deleteId && report.is_extra === true && report.can_delete === true;
        });
        if (!deletableRecord || state.extraDeleteConfirmId !== deleteId) return;
        state.extraDeleting = true;
        state.extraDeleteError = "";
        renderView(host, state, context);
        global.Solar91PortalAPI.request(
          "/api/scheduled/washing/daily-reports/" + encodeURIComponent(deleteId),
          { method: "DELETE" }
        ).then(function () {
          if (!active || active.host !== host || active.state !== state) return;
          if (data && data.invalidate) data.invalidate(true);
          state.washingReports = (state.washingReports || []).filter(function (report) {
            return report.id !== deleteId;
          });
          state.events = (state.events || []).filter(function (event) {
            return event.reportId !== deleteId;
          });
          state.detailEventIndex = null;
          state.extraDeleteConfirmId = "";
          state.extraDeleting = false;
          state.extraDeleteError = "";
          renderView(host, state, active.context);
          loadEvents(host, state, active.context, true);
        }).catch(function (error) {
          if (!active || active.host !== host || active.state !== state) return;
          state.extraDeleting = false;
          state.extraDeleteError = "Extra cleaning was not removed. " +
            (error && error.message ? error.message : "Please retry.");
          renderView(host, state, active.context);
        });
      } else if (action.dataset.calendarAction === "close-extra") {
        if (state.extraSaving) return;
        state.extraOpen = false;
        state.extraEditId = "";
        state.extraDeleteConfirmId = "";
        state.extraDeleteError = "";
        state.extraError = "";
        renderView(host, state, context);
      } else if (action.dataset.calendarAction === "save-extra") {
        var editingExtra = !!state.extraEditId;
        if (state.extraSaving || (editingExtra ? !canManageWashing() : !canRecordWashing()) || !state.washingSetup) return;
        syncExtraForm(host, state);
        var extraTotal = Number(state.washingPlant && state.washingPlant.table_count) || 0;
        var extraPlan = planExtra(state, extraTotal);
        if (!state.extraDate || extraPlan.error || !extraPlan.numbers.length) {
          state.extraError = extraPlan.error ||
            "Choose the date and type the table numbers that were cleaned again.";
          renderView(host, state, context);
          return;
        }
        state.extraSaving = true;
        state.extraError = "";
        renderView(host, state, context);
        var extraRequest = editingExtra
          ? global.Solar91PortalAPI.request(
            "/api/scheduled/washing/daily-reports/" + encodeURIComponent(state.extraEditId), {
              method: "PATCH",
              body: {
                report_date: state.extraDate,
                table_numbers: extraPlan.numbers,
                remarks: state.extraRemarks || ""
              }
            })
          : global.Solar91PortalAPI.request("/api/scheduled/washing/daily-reports/sheet", {
            method: "POST",
            body: {
              plant_id: state.washingSetup.plantId,
              entries: [{
                report_date: state.extraDate,
                job_status: "Done",
                tables_cleaned: extraPlan.numbers.length,
                table_numbers: extraPlan.numbers,
                remarks: state.extraRemarks || null,
                is_extra: true
              }]
            }
          });
        extraRequest.then(function (result) {
          if (!active || active.host !== host || active.state !== state) return;
          if (data && data.invalidate) data.invalidate(true);
          var saved = editingExtra ? result : (Array.isArray(result.reports) ? result.reports : [])[0];
          state.extraSaving = false;
          state.extraOpen = false;
          state.extraEditId = "";
          if (saved) {
            state.washingReports = (state.washingReports || []).filter(function (item) {
              return item.id !== saved.id;
            });
            state.washingReports.push(saved);
            if (!editingExtra) {
              state.recordPhotos[saved.id] = [];
              state.recordPhotosLoaded[saved.id] = true;
            }
          }
          state.recordNotice = (editingExtra ? "Extra cleaning updated: " : "Extra cleaning saved: ") +
            extraPlan.numbers.length + " table" + (extraPlan.numbers.length === 1 ? "" : "s") +
            " on " + displayDate(state.extraDate) +
            (saved && saved.review_status === "Pending" ? ", awaiting review." : ".");
          renderView(host, state, active.context);
          loadEvents(host, state, active.context, true);
        }).catch(function (error) {
          if (!active || active.host !== host || active.state !== state) return;
          state.extraSaving = false;
          state.extraError = (editingExtra ? "Extra cleaning was not updated. " : "Extra cleaning was not saved. ") +
            (error && error.message ? error.message : "Please retry.");
          renderView(host, state, active.context);
        });
      } else if (action.dataset.calendarAction === "close-record") {
        if (state.recordSaving || (state.recordEdit && state.recordEdit.saving)) return;
        clearDraftRecordPhotos(state);
        state.recordOpen = false;
        state.recordSameDayDate = "";
        state.recordSameDayCycle = 0;
        state.recordEdit = null;
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
          if (row.report) return;
          if (row.zero) {
            if (row.sameDayNextCycle) { invalidRange = true; return; }
            // A day with nothing cleaned is saved as not done with the reason chosen for it, and the
            // details go in Remarks. It never takes a table number.
            entries.push({
              report_date: row.date,
              job_status: "Not done",
              exception_reason: row.draft.reason,
              tables_cleaned: 0,
              remarks: row.draft.remarks || null
            });
            return;
          }
          if (row.error) { invalidRange = true; return; }
          if (!row.numbers.length) return;
          entries.push({
            report_date: row.date,
            job_status: "Done",
            tables_cleaned: row.numbers.length,
            table_numbers: row.numbers,
            remarks: row.draft.remarks || null,
            same_day_next_cycle: !!row.sameDayNextCycle
          });
          // Once Cycle 3 is complete, any further tables cleaned that day are extra cleaning.
          if (row.nextNumbers && row.nextNumbers.length) {
            entries.push({
              report_date: row.date,
              job_status: "Done",
              tables_cleaned: row.nextNumbers.length,
              table_numbers: row.nextNumbers,
              remarks: row.draft.remarks || null,
              // In the month's last cycle there is no next cycle to open, so the re-cleaned tables are
              // the month's extra cleaning and are marked as such (migration 048) to be counted that
              // way. Below the last cycle they are the next cycle's real work and carry no flag.
              is_extra: !nextCycleNo(state)
            });
          }
        });
        if (invalidRange || !entries.length) {
          state.recordError = invalidRange
            ? "Check the days marked in red: a table can be cleaned only once per cycle, and each number must be a table of this plant."
            : "Enter the tables cleaned, or choose a not-done reason, for at least one day.";
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
          if (data && data.invalidate) data.invalidate(true);
          state.recordSaving = false;
          state.recordDrafts = {};
          state.recordSameDayDate = "";
          state.recordSameDayCycle = 0;
          var reports = Array.isArray(result.reports) ? result.reports : [];
          // Replace by id, not by date. A date can now hold more than one entry -- the day a cycle
          // fills and the next round starts carries one entry per cycle -- and dropping every entry
          // of the date deleted the one saved a moment earlier from the sheet.
          var savedIds = reports.map(function (report) { return report.id; });
          state.washingReports = (state.washingReports || []).filter(function (item) {
            return savedIds.indexOf(item.id) === -1;
          });
          reports.forEach(function (report) {
            state.washingReports.push(report);
            state.recordPhotos[report.id] = [];
            state.recordPhotosLoaded[report.id] = true;
          });
          var uploads = [];
          reports.forEach(function (report) {
            ["before", "after"].forEach(function (phase) {
              [1, 2].forEach(function (slot) {
                var draftKey = recordPhotoKey("draft:" + report.report_date, phase, slot);
                var file = state.recordPendingPhotos[draftKey];
                if (!file) return;
                var key = recordPhotoKey(String(report.id), phase, slot);
                delete state.recordPendingPhotos[draftKey];
                state.recordPendingPhotos[key] = file;
                uploads.push({ report: report, phase: phase, slot: slot, file: file });
              });
            });
          });
          state.recordPhotoOpenId = uploads.length ? String(uploads[0].report.id) : "";
          state.recordNotice = "Saved " + result.saved + " module cleaning day" +
            (result.saved === 1 ? "" : "s") + (uploads.length ? ". Uploading selected photos…" : ".");
          if (!reports.length && Object.keys(state.recordPendingPhotos).some(function (key) {
            return key.indexOf("draft:") === 0;
          })) {
            state.recordNotice = "The cleaning record was saved, but photo slots could not be matched to the saved days. Refresh the record and add the photos again.";
          }
          renderView(host, state, active.context);
          var failed = 0;
          uploads.reduce(function (chain, item) {
            return chain.then(function () {
              if (!active || active.host !== host || active.state !== state) return false;
              return uploadRecordPhotoFile(host, state, item.report, item.phase, item.slot, item.file)
                .then(function (ok) { if (!ok) failed += 1; });
            });
          }, Promise.resolve()).then(function () {
            if (!active || active.host !== host || active.state !== state) return;
            state.recordNotice = "Saved " + result.saved + " module cleaning day" +
              (result.saved === 1 ? "" : "s") + ".";
            if (uploads.length) {
              state.recordNotice += failed
                ? " " + failed + " photo upload(s) failed; open Photos on those days to retry."
                : " Photos uploaded.";
            }
            renderView(host, state, active.context);
            loadEvents(host, state, active.context, true);
          });
        }).catch(function (error) {
          if (!active || active.host !== host || active.state !== state) return;
          state.recordSaving = false;
          state.recordError = "Module Cleaning was not saved. " +
            (error && error.message ? error.message : "Please retry.");
          renderView(host, state, active.context);
        });
      }
    });

    host.addEventListener("toggle", function (event) {
      if (!active || active.host !== host) return;
      if (event.target.matches("[data-record-draft-photos]")) {
        active.state.recordPhotoOpenId = event.target.open
          ? "draft:" + event.target.dataset.recordDraftPhotos : "";
        return;
      }
      if (!event.target.matches("[data-record-photos]")) return;
      if (!event.target.open) {
        if (active.state.recordPhotoOpenId === event.target.dataset.recordPhotos) {
          active.state.recordPhotoOpenId = "";
        }
        return;
      }
      var reportId = event.target.dataset.recordPhotos;
      active.state.recordPhotoOpenId = reportId;
      loadRecordPhotos(host, active.state, reportId, false);
    }, true);

    host.addEventListener("change", function (event) {
      if (!active || active.host !== host || !active.state.recordOpen) return;
      if (event.target.matches("[data-record-draft-photo]")) {
        var draftState = active.state;
        var draftDate = event.target.dataset.date;
        var draftPhase = event.target.dataset.phase;
        var draftSlot = Number(event.target.dataset.slot);
        var draftFile = event.target.files && event.target.files[0];
        if (!draftFile) return;
        syncRecordRangeInputs(host, draftState);
        var draftRow = recordRows(draftState).find(function (item) {
          return item.date === draftDate && !item.report;
        });
        if (!draftRow || !rowEntered(draftRow)) return;
        draftState.recordPendingPhotos[recordPhotoKey("draft:" + draftDate, draftPhase, draftSlot)] = draftFile;
        draftState.recordPhotoOpenId = "draft:" + draftDate;
        renderView(host, draftState, active.context);
        return;
      }
      if (event.target.matches("[data-washing-photo-file]")) {
        uploadRecordPhoto(host, active.state, event.target);
        return;
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
          compliance_threshold_percent: setup.complianceThreshold || 85,
          fast_window_days: setup.fastWindowDays || 7
        }
      }).then(function () {
        if (!active || active.host !== host || active.state !== state) return;
        if (data && data.invalidate) data.invalidate(true);
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
      } else if (event.target.matches("[data-record-list], [data-record-remarks]") &&
                 active.state.recordOpen) {
        syncRecordRangeInputs(host, active.state);
      } else if (event.target.matches("[data-extra-list], [data-extra-remarks], [data-extra-date]") &&
                 active.state.extraOpen) {
        refreshExtraPreview(host, active.state);
      }
    });

    host.addEventListener("change", function (event) {
      if (!active || active.host !== host) return;
      if (active.state.extraOpen &&
          event.target.matches("[data-extra-date], [data-extra-list], [data-extra-remarks]")) {
        refreshExtraPreview(host, active.state);
        return;
      }
      var filter = event.target.dataset.calendarFilter;
      if (filter === "plant") active.state.plantFilter = event.target.value;
      else if (filter === "status") active.state.statusFilter = event.target.value;

      else if (filter === "modal-plant") active.state.modalPlant = event.target.value;
      else if (filter === "modal-equipment") active.state.modalEquipment = event.target.value;
      else if (filter === "modal-status") {
        active.state.modalStatus = event.target.value;
        // Not recorded is an absence, so it needs the server's list of every visible plant.
        if (event.target.value === NOT_RECORDED) {
          loadDayActivity(host, active.state, active.context);
          return;
        }
      }
      else {
        // PM setup cascade: a new Equipment changes which Parts are offered, and
        // a new Part changes which Maintenance tasks are offered. Clear the
        // choices below the one that changed, then redraw so the lists match.
        var field = event.target.dataset.pmSetupField;
        if ((field === "equipment" || field === "part") && active.state.pmSetupOpen) {
          syncPMSetupForm(host, active.state);
          var item = active.state.pmSetupItems[Number(event.target.dataset.pmSetupIndex)];
          if (item) {
            if (field === "equipment") { item.part = ""; item.unitName = ""; }
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

    host.addEventListener("change", function (event) {
      if (!active || active.host !== host || !active.state.recordOpen) return;
      if (!event.target.matches("[data-record-notdone]")) return;
      // Marking a day not done clears the tables typed for it, and clearing the reason opens them again.
      syncRecordRangeInputs(host, active.state);
      active.state.recordError = "";
      renderView(host, active.state, active.context);
    });

    host.addEventListener("change", function (event) {
      if (!active || active.host !== host || !active.state.recordEdit) return;
      if (!event.target.matches("[data-record-edit-status]")) return;
      syncRecordEdit(host, active.state);
      active.state.recordEdit.error = "";
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
          active.state.recordSameDayDate = "";
          active.state.recordSameDayCycle = 0;
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
      throw new Error("Calendar requires a PM or Module Cleaning context.");
    }
    var key = contextKey(context);
    if (active && active.state !== states[key]) active.state.modalDate = "";
    wire(host);
    var state = getState(context);
    var initialMonth = typeof context.initialMonth === "string" &&
      /^\d{4}-\d{2}$/.test(context.initialMonth) ? context.initialMonth : "";
    if (initialMonth && state.month !== initialMonth) {
      state.month = initialMonth;
      state.weekStart = weekStartOf(dateFromKey(initialMonth + "-01"));
      state.loaded = false;
    }
    var rangeStart = context.startDate || "";
    var rangeEnd = context.endDate || "";
    if (state.rangeStart !== rangeStart || state.rangeEnd !== rangeEnd) {
      state.rangeStart = rangeStart;
      state.rangeEnd = rangeEnd;
      if (rangeStart) state.month = rangeStart.slice(0, 7);
      state.loaded = false;
    }
    if (context.eventId) {
      if (state.loaded && !focusPMEvent(state, context.eventId)) {
        state.loaded = false;
        state.pendingEventId = context.eventId;
      } else if (!state.loaded) {
        state.pendingEventId = context.eventId;
      }
    } else {
      state.pendingEventId = null;
      state.modalDate = "";
      state.detailEventIndex = null;
    }
    active = { host: host, state: state, context: context };
    if (state.loaded) {
      renderView(host, state, context);
    } else {
      loadEvents(host, state, context);
    }
  }

  global.Solar91PortalCalendar = { render: render };
}(window));