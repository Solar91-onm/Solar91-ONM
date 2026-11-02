/**
 * Portfolio and plant-scoped PM / Washing calendars.
 *
 * Every entry is a saved record read through the role-scoped portal API:
 * PM entries are om_tasks rows on their due date, washing entries are
 * washing_daily_reports rows. A plant's Washing page additionally loads the
 * full cycle summary from the washing module. All views are read-only;
 * scheduling and reporting stay in their own workflows.
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
        modalSearch: "",
        liveWashing: false,
        washingPlant: null,
        washingNotConfigured: false,
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
      return [event.title, event.status, event.plantName, event.plantSiteCode]
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

  function renderCalendarGrid(state, events) {
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
          ? ' title="' + escape(displayDate(date) + (tooltip ? " · " + tooltip : "")) +
            '" aria-label="' + escape(displayDate(date) + ", " + dayEvents.length +
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
    return '<div class="ep-calendar__grid" role="grid" aria-label="' + escape(displayMonth(state.month)) + '">' +
      weekdays + days + "</div>";
  }

  function renderEventCards(events, context) {
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
      var fields = [
        ["Plant", event.plantName || (context.plantCode ? "Selected plant" : "Plant not provided")],
        ["Site code", event.plantSiteCode],
        ["Activity", typeLabel],
        ["Date", displayDate(event.date)],
        ["Status", event.status],
        [context.type === "washing" ? "Cycle" : "Schedule", cycle],
        ["Reference", event.reference || ""],
        ["Assigned to", event.assignee || event.reportedBy || ""],
        ["Tables cleaned", event.tablesCleaned == null ? "" : event.tablesCleaned],
        ["Completed on", event.completedOn ? displayDate(event.completedOn) : ""],
        ["Exception", event.exceptionReason || ""],
        ["Remarks", event.remarks || ""]
      ].filter(function (field) { return field[1] !== "" && field[1] !== null && field[1] !== undefined; });
      return '<article class="ep-calendar__detail">' +
        '<div class="ep-calendar__detail-banner"><strong>' + escape(event.title) +
          '</strong><span>' + escape(cycle) + '</span></div>' +
        '<div class="ep-calendar__detail-chips"><span>' + escape(typeLabel) +
          '</span><span>' + escape(event.status) + '</span></div>' +
        '<dl class="ep-calendar__detail-fields">' +
          fields.map(function (field) {
            return "<div><dt>" + escape(field[0]) + "</dt><dd>" + escape(field[1]) + "</dd></div>";
          }).join("") +
        '</dl><p class="ep-calendar__detail-note">' +
          "Saved record, shown read-only. Changes are made in the Preventive Maintenance and Washing workflows." +
        '</p>' +
      '</article>';
    }).join("") + "</div>";
  }

  function modalEvents(state, context) {
    var term = state.modalSearch.trim().toLowerCase();
    return state.events.filter(function (event) {
      if (event.date !== state.modalDate) return false;
      if (state.modalPlant && event.plantSiteCode !== state.modalPlant) return false;
      if (state.modalStatus !== "all" && event.status !== state.modalStatus) return false;
      if (!term) return true;
      return [event.title, event.status, event.plantName, event.plantSiteCode]
        .join(" ").toLowerCase().indexOf(term) !== -1;
    });
  }

  function renderModal(state, context) {
    if (!state.modalDate) return "";
    var events = modalEvents(state, context);
    var typeLabel = context.type === "pm" ? "Preventive Maintenance" : "Washing";
    var filters = !context.plantCode
      ? '<div class="ep-calendar__modal-filters">' +
          '<label><span>Search this date</span><input type="search" data-calendar-filter="modal-search" value="' +
            escape(state.modalSearch) + '" placeholder="Plant, activity or status" /></label>' +
          '<label><span>Plant</span><select data-calendar-filter="modal-plant">' +
            renderPlantOptions(state.plants, state.modalPlant, "All plants") +
          '</select></label>' +
          '<label><span>Status</span><select data-calendar-filter="modal-status">' +
            renderStatusOptions(state.events, state.modalStatus) +
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
        renderEventCards(events, context) +
        '</div><footer class="ep-calendar__drawer-footer"><span>' +
          "Saved records · Read only" + '</span>' +
          '<button type="button" class="ep-calendar__close-button" data-calendar-action="close-modal">Close</button></footer>' +
      '</section>' +
    '</div>';
  }

  function renderCycleSummary(state) {
    if (!state.liveWashing) return "";
    var plant = state.washingPlant;
    if (!plant) {
      if (!state.washingNotConfigured) return "";
      return '<section class="ep-wash-cycle-card ep-wash-cycle-card--empty" aria-label="Washing cycle status">' +
        '<strong>Washing is not set up for this plant.</strong>' +
        '<span>There is no configured table count or cycle progress to show.</span></section>';
    }

    var cycles = plant.cycles || [];
    var current = cycles.find(function (cycle) { return cycle.state === "In progress"; }) ||
      cycles.find(function (cycle) { return cycle.state === "Upcoming"; }) ||
      cycles.find(function (cycle) { return cycle.state === "Missed"; });
    var total = Number(plant.table_count) || 0;
    var confirmed = current ? Number(current.confirmed) || 0 : total;
    var pending = current ? Number(current.pending) || 0 : 0;
    var percent = total ? Math.min(100, Math.round(100 * confirmed / total)) : 0;
    var today = state.events.filter(function (event) {
      return event.kind === "report" && event.date === state.washingDataToday;
    });
    var todayCount = today.reduce(function (sum, event) {
      return sum + (Number(event.tablesCleaned) || 0);
    }, 0);
    var todayText = today.length
      ? todayCount + " table" + (todayCount === 1 ? "" : "s") + " reported today"
      : "No report today";
    var status = pending > 0
      ? pending + " awaiting confirmation"
      : plant.overdue_bucket && plant.overdue_bucket !== "on_track"
        ? (Number(plant.overdue_days) || 0) + " d late"
        : plant.cycles_this_month >= plant.monthly_target
          ? "Month complete"
          : "On track";
    var progress = current
      ? confirmed + (pending ? " +" + pending + " awaiting" : "") + " of " + total + " tables"
      : total + " tables · all cycles done";
    var pills = cycles.map(function (cycle) {
      var stateClass = cycle.state === "Completed" ? "is-done" :
        cycle.state === "In progress" || cycle.state === "Missed" ? "is-current" : "is-next";
      return '<span class="ep-wash-cycle-card__pill ' + stateClass + '"' +
        ' title="' + escape("Cycle " + cycle.cycle_no + ": " + cycle.state + " · due " + displayDate(cycle.due_date)) + '">' +
        (cycle.state === "Completed" ? "✓" : escape(cycle.cycle_no)) + '</span>';
    }).join("");
    var progressAngle = Math.round(percent * 3.6);

    return '<section class="ep-wash-cycle-card" aria-label="Current washing cycle status">' +
      '<div class="ep-wash-cycle-card__head"><strong>' + escape(plant.plant) + '</strong>' +
        '<span>' + escape(plant.site_code) + '</span></div>' +
      '<div class="ep-wash-cycle-card__body"><div class="ep-wash-cycle-card__ring" style="--ep-wash-angle:' +
        progressAngle + 'deg"><span><b>' + percent + '%</b><small>' +
          escape(current ? "Cycle " + current.cycle_no : "Complete") + '</small></span></div>' +
        '<div class="ep-wash-cycle-card__details"><div class="ep-wash-cycle-card__pills">' + pills + '</div>' +
          '<span>' + escape(progress) + '</span><span>' + escape(todayText) + '</span></div></div>' +
      '<div class="ep-wash-cycle-card__foot"><span class="ep-wash-cycle-card__status">' + escape(status) + '</span>' +
        '<span>' + escape(plant.assignee_name || "No Assignee") + '</span></div></section>';
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
    if (state.loading) {
      content = '<div class="ep-calendar__message" role="status">' +
        "Loading saved records…" + '</div>';
    } else if (state.error) {
      content = '<div class="ep-calendar__message ep-calendar__message--error" role="alert">' +
        '<p>Calendar could not be loaded: ' + escape(state.error) + '</p>' +
        '<button type="button" data-calendar-action="retry">Try again</button></div>';
    } else {
      content = renderCalendarGrid(state, events);
    }
    host.innerHTML = '<div class="ep-calendar">' +
      '<header class="ep-calendar__head"><div><p class="ep-calendar__eyebrow">' +
        (context.plantCode ? "Plant view" : "Views") + '</p><h1>' + escape(typeLabel) +
        '</h1><p class="ep-calendar__subtitle">' + escape(subtitle) +
        (state.liveWashing
          ? " Cycle progress and dates come from saved washing records. Hover a date for its reports and deadline."
          : " Entries are saved records on their scheduled date.") + '</p></div>' +
        '<span class="ep-calendar__count">' + escape(statusCounts) + '</span></header>' +
      renderToolbar(state, context) +
      renderCycleSummary(state) +
      '<div class="ep-calendar__monthbar">' +
        '<div class="ep-calendar__month-nav"><button type="button" data-calendar-action="previous" aria-label="Previous month">‹</button>' +
          '<h2>' + escape(displayMonth(state.month)) + '</h2>' +
          '<button type="button" data-calendar-action="next" aria-label="Next month">›</button>' +
        '</div><button type="button" class="ep-calendar__today" data-calendar-action="today">Today</button>' +
      '</div>' +
      content +
      '<p class="ep-calendar__disclaimer">Entries are live, role-scoped, read-only records. Scheduling and reporting happen in their own workflows.</p>' +
      renderModal(state, context) +
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
        state.washingPlant = cyclesData
          ? (overview.plants || []).find(function (plant) {
            return String(plant.plant_id) === selected.dbId;
          }) || {
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

  function loadEvents(host, state, context) {
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

  function wire(host) {
    if (host.dataset.calendarWired === "true") return;
    host.dataset.calendarWired = "true";

    host.addEventListener("click", function (event) {
      if (!active || active.host !== host) return;
      var action = event.target.closest("[data-calendar-action]");
      if (!action) return;
      var state = active.state;
      var context = active.context;

      if (action.dataset.calendarAction === "previous" || action.dataset.calendarAction === "next") {
        var parts = monthParts(state.month);
        var shift = action.dataset.calendarAction === "previous" ? -1 : 1;
        state.month = monthKey(new Date(parts.year, parts.month - 1 + shift, 1));
        state.modalDate = "";
        loadEvents(host, state, context);
      } else if (action.dataset.calendarAction === "today") {
        state.month = monthKey(new Date());
        state.modalDate = "";
        loadEvents(host, state, context);
      } else if (action.dataset.calendarAction === "open-date") {
        state.modalDate = action.dataset.date;
        state.modalPlant = "";
        state.modalStatus = "all";
        state.modalSearch = "";
        renderView(host, state, context);
        var closeButton = host.querySelector(".ep-calendar__close");
        if (closeButton) closeButton.focus();
      } else if (action.dataset.calendarAction === "close-modal") {
        state.modalDate = "";
        renderView(host, state, context);
      } else if (action.dataset.calendarAction === "retry") {
        loadEvents(host, state, context);
      }
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
      }
    });

    host.addEventListener("change", function (event) {
      if (!active || active.host !== host) return;
      var filter = event.target.dataset.calendarFilter;
      if (filter === "plant") active.state.plantFilter = event.target.value;
      else if (filter === "status") active.state.statusFilter = event.target.value;
      else if (filter === "modal-plant") active.state.modalPlant = event.target.value;
      else if (filter === "modal-status") active.state.modalStatus = event.target.value;
      else return;
      renderView(host, active.state, active.context);
    });

    host.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && active && active.host === host && active.state.modalDate) {
        active.state.modalDate = "";
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
