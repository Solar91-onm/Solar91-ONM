/**
 * Requirements register: Site Engineers raise plant requests; O&M Head and Assignees
 * manage priority and completion. Authorization and plant scope are enforced by the API.
 */
(function (global) {
  "use strict";

  var api = global.Solar91PortalAPI;
  var fmt = global.Solar91PortalFormat;
  var host = null;
  var wiredHost = null;
  var state = {
    rows: [],
    plants: [],
    status: "Open",
    offset: 0,
    limit: 50,
    total: 0,
    sort: { key: "siteCode", dir: "asc" },
    columnFilters: Object.create(null),
    loading: false,
    error: "",
    notice: "",
    mutatingId: "",
    formOpen: false,
    plantsLoading: false,
    plantsError: "",
    selectedPlantId: "",
    submitting: false,
    submitError: "",
    editOpen: false,
    editRow: null,
    editDemands: [""]
  };

  var COLUMNS = [
    { key: "siteCode", label: "Plant code", sort: function (row) { return row.siteCode; } },
    { key: "description", label: "Requirements", sort: function (row) { return row.demandCount; } },
    { key: "status", label: "Status", sort: function (row) { return row.status; } },
    { key: "demandCount", label: "Points", align: "num", sort: function (row) { return row.demandCount; } },
    { key: "priority", label: "Priority", sort: function (row) { return priorityRank(row.priority); } },
    { key: "actions", label: "Actions" }
  ];

  function escape(value) {
    return fmt && fmt.escape ? fmt.escape(value) : String(value == null ? "" : value);
  }

  function canCreate() {
    return !!(api && api.can && api.can("requirements.create"));
  }

  function canManage() {
    return !!(api && api.can && api.can("requirements.manage"));
  }

  function priorityRank(value) {
    return value === "Critical" ? 3 : value === "Medium" ? 2 : value === "Low" ? 1 : null;
  }

  function columnValue(row, key) {
    return String(row[key] == null ? "" : row[key]);
  }

  function columnOptions(key) {
    var values = Object.create(null);
    state.rows.forEach(function (row) {
      var value = columnValue(row, key);
      if (value) values["$" + value] = value;
    });
    return Object.keys(values).map(function (valueKey) { return values[valueKey]; })
      .sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }); });
  }

  function columnHeader(column) {
    var header = global.Solar91PortalSort.thHTML(column, state.sort, "data-requirement-sort");
    return global.Solar91PortalColumnFilter.headerHTML(header, {
      key: column.key,
      label: column.label,
      values: columnOptions(column.key),
      active: state.columnFilters[column.key] || "",
      menuId: "ep-requirements-filter-" + column.key,
      caseInsensitive: true,
      attributes: {
        toggleKey: "data-requirement-filter-toggle",
        menuKey: "data-requirement-filter-menu",
        optionKey: "data-requirement-filter-option",
        optionValue: "data-requirement-filter-value",
        search: "data-requirement-filter-search",
        empty: "data-requirement-filter-empty"
      },
      classes: {
        header: "ep-issues__th-filtered",
        content: "ep-issues__th-content",
        toggle: "ep-issues__filter-toggle",
        menu: "ep-issues__column-filter-menu ep-requirements__filter-menu",
        search: "ep-issues__column-filter-search",
        options: "ep-issues__column-filter-options",
        option: "ep-issues__column-filter-option",
        empty: "ep-issues__column-filter-empty"
      },
      searchHasKey: true,
      focusSearchOnOpen: true,
      keepAllOptionVisible: false
    });
  }

  function filteredRows() {
    return state.rows;
  }

  function priorityCell(row) {
    if (!canManage()) {
      return '<span class="ep-requirements__priority ep-requirements__priority--' +
        escape(row.priority.toLowerCase()) + '">' + escape(row.priority) + "</span>";
    }
    return '<select class="ep-requirements__priority-select" data-requirement-priority="' +
      escape(row.id) + '" aria-label="Set priority for ' + escape(row.ticketNo) + '"' +
      (state.mutatingId === row.id + ":priority" ? " disabled" : "") + ">" +
      ["Critical", "Medium", "Low"].map(function (priority) {
        return '<option value="' + priority + '"' +
          (row.priority === priority ? " selected" : "") + ">" + priority + "</option>";
      }).join("") + "</select>";
  }

  function statusCell(row) {
    var completedMeta = row.status === "Completed" && row.completedByName
      ? '<small class="ep-requirements__status-meta">Completed by ' + escape(row.completedByName) + "</small>"
      : "";
    var badge = '<span class="ep-issues__status ep-issues__status--' +
      (row.status === "Completed" ? "solved" : "unhealthy") + '"><i></i>' +
      escape(row.status) + "</span>";
    if (!canManage()) return badge + completedMeta;
    var nextStatus = row.status === "Completed" ? "Open" : "Completed";
    return '<button type="button" class="ep-requirements__status-control" data-requirement-status="' +
      escape(row.id) + '" data-next-status="' + nextStatus + '"' +
      (state.mutatingId === row.id + ":status" ? " disabled" : "") +
      ' aria-label="' + (nextStatus === "Completed" ? "Mark " : "Reopen ") + escape(row.ticketNo) + '">' +
      badge + '<small>' + (nextStatus === "Completed" ? "Mark completed" : "Reopen") + "</small></button>" +
      completedMeta;
  }

  function requirementCell(row) {
    var description = escape(row.description).replace(/\r?\n/g, "<br>");
    return '<div class="ep-requirements__description">' +
      '<small>' + escape(row.ticketNo) + " · " + escape(row.createdByName || "Requester") +
        " · " + escape(String(row.createdAt || "").slice(0, 10)) + "</small>" +
      "<div>" + description + "</div></div>";
  }

  function renderTable(rows) {
    if (state.loading) return '<div class="ep-issues__message" role="status">Loading requirements…</div>';
    if (state.error) {
      return '<div class="ep-issues__message ep-issues__message--error" role="alert">' +
        escape(state.error) + '<button type="button" class="ep-issues__button" data-requirement-action="retry">Try again</button></div>';
    }
    if (!rows.length) {
      var hasFilters = COLUMNS.some(function (column) { return !!state.columnFilters[column.key]; });
      return '<div class="ep-issues__empty"><strong>' +
        (hasFilters ? "No requirements match these column filters" :
          state.status === "Completed" ? "No completed requirements" : "No open requirements") +
        "</strong>" + (hasFilters
          ? '<button type="button" class="ep-issues__button" data-requirement-action="clear-filters">Clear column filters</button>'
          : canCreate() && state.status === "Open"
            ? '<button type="button" class="ep-issues__button ep-issues__button--primary" data-requirement-action="open-form">Add requirement</button>'
            : "") + "</div>";
    }

    return '<div class="ep-issues__table-wrap"><table class="ep-issues__table ep-requirements__table">' +
      "<thead><tr>" + COLUMNS.map(columnHeader).join("") + "</tr></thead><tbody>" +
      rows.map(function (row) {
        return '<tr data-requirement-row="' + escape(row.id) + '">' +
          '<td data-label="Plant code"><strong class="ep-requirements__site-code">' + escape(row.siteCode) + "</strong></td>" +
          '<td data-label="Requirements">' + requirementCell(row) + "</td>" +
          '<td data-label="Status">' + statusCell(row) + "</td>" +
          '<td data-label="Points" class="num"><strong class="ep-requirements__points">' +
            escape(row.demandCount) + '</strong><small>demands</small></td>' +
          '<td data-label="Priority">' + priorityCell(row) + "</td>" +
          '<td data-label="Actions">' + (canManage()
            ? '<button type="button" class="ep-requirements__edit-button" data-requirement-edit="' +
              escape(row.id) + '" title="Edit ' + escape(row.ticketNo) +
              '" aria-label="Edit ' + escape(row.ticketNo) + '">' +
              '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
              'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>' +
              "</svg></button>"
            : '<span class="ep-requirements__unavailable">View only</span>') + "</td>" +
        "</tr>";
      }).join("") + "</tbody></table></div>";
  }

  function pageRange() {
    if (state.loading) return "Loading tickets…";
    if (state.error) return "Unavailable";
    if (!state.total) return "No tickets";
    var first = state.offset + 1;
    var last = Math.min(state.offset + state.limit, state.total);
    return "Showing " + first + "–" + last + " of " + state.total;
  }

  function renderForm() {
    if (!state.formOpen) return "";
    var isEdit = !!state.editRow;
    var demandRows = isEdit ? state.editDemands : state.editDemands;
    if (!demandRows.length) demandRows = [""];
    var plants = state.plants;
    var plantField = isEdit
      ? '<div class="ep-requirements__edit-plant"><span>Plant</span><strong>' +
        escape(state.editRow.siteCode) + "</strong></div>"
      : state.plantsLoading
        ? '<p class="ep-issues__message" role="status">Loading assigned plants…</p>'
        : state.plantsError
          ? '<p class="ep-issues__message ep-issues__message--error" role="alert">' + escape(state.plantsError) + "</p>"
          : plants.length === 0
            ? '<p class="ep-issues__message ep-issues__message--error" role="alert">No assigned plant is available for this account.</p>'
            : '<label class="ep-issues__wizard-field">Plant site code<select name="plantId" required>' +
              plants.map(function (plant) {
                var plantId = plant.dbId || plant.id;
                return '<option value="' + escape(plantId) + '"' +
                  (state.selectedPlantId === plantId ? " selected" : "") + ">" +
                  escape(plant.siteCode) + " · " + escape(plant.plantName) + "</option>";
              }).join("") + "</select></label>";

    var demandFields = '<div class="ep-requirements__demands" data-requirement-demands>' +
      demandRows.map(function (demand, index) {
        return '<div class="ep-requirements__demand-row">' +
          '<label for="requirement-demand-' + index + '">Demand ' + (index + 1) + "</label>" +
          '<div><input id="requirement-demand-' + index + '" type="text" name="demand" maxlength="1000" ' +
            'value="' + escape(demand) + '" data-requirement-demand ' +
            'placeholder="Enter demand ' + (index + 1) + '" required />' +
            (demandRows.length > 1
              ? '<button type="button" data-requirement-remove-demand="' + index +
                '" aria-label="Remove Demand ' + (index + 1) + '">×</button>'
              : "") + "</div></div>";
      }).join("") +
      '<button type="button" class="ep-requirements__add-demand" data-requirement-add-demand>' +
      '+ Add another demand</button></div>';

    var editControls = isEdit
      ? '<div class="ep-requirements__edit-controls">' +
        '<label>Priority<select name="priority">' +
          ["Critical", "Medium", "Low"].map(function (priority) {
            return '<option value="' + priority + '"' +
              (state.editRow.priority === priority ? " selected" : "") + ">" + priority + "</option>";
          }).join("") + "</select></label>" +
        '<label>Status<select name="status">' +
          ["Open", "Completed"].map(function (status) {
            return '<option value="' + status + '"' +
              (state.editRow.status === status ? " selected" : "") + ">" + status + "</option>";
          }).join("") + "</select></label></div>"
      : "";

    return '<div class="ep-issues__overlay" data-requirement-overlay>' +
      '<button type="button" class="ep-issues__backdrop" data-requirement-action="close-form" aria-label="Close requirement form"></button>' +
      '<aside class="ep-issues__drawer" role="dialog" aria-modal="true" aria-labelledby="requirement-drawer-title">' +
        '<header class="ep-issues__drawer-head"><div><p>' + (isEdit ? "Edit saved ticket" : "New site request") + "</p>" +
          '<h2 id="requirement-drawer-title">' + (isEdit ? "Edit requirement" : "Raise a requirement") + "</h2></div>" +
          '<button type="button" class="ep-issues__drawer-x" data-requirement-action="close-form" aria-label="Close">×</button></header>' +
        '<div class="ep-issues__drawer-content"><form class="ep-requirements__form" data-requirement-form>' +
          plantField +
          demandFields +
          editControls +
          '<small data-requirement-point-count>' + demandRows.filter(function (value) { return String(value).trim(); }).length +
            " demand point" + (demandRows.filter(function (value) { return String(value).trim(); }).length === 1 ? "" : "s") + "</small>" +
          (state.submitError ? '<p class="ep-issues__wizard-error" role="alert">' + escape(state.submitError) + "</p>" : "") +
          '<div class="ep-issues__wizard-actions"><button type="button" class="ep-issues__button" data-requirement-action="close-form">Cancel</button>' +
            '<button type="submit" class="ep-issues__button ep-issues__button--primary"' +
              (state.submitting || state.plantsLoading || state.plantsError || !plants.length ? " disabled" : "") + ">" +
              (state.submitting ? "Saving…" : "Create ticket") + "</button></div>" +
        "</form></div></aside></div>";
  }

  function renderView() {
    if (!host) return;
    var visibleRows = filteredRows();
    host.innerHTML = '<div class="ep-issues ep-requirements">' +
      '<section class="ep-issues__hero ep-requirements__hero"><div><p class="ep-issues__eyebrow">Site requests</p>' +
        '<h1>Requirements</h1><p>Track plant requests from submission through completion.</p></div>' +
        (canCreate() ? '<div class="ep-issues__hero-actions"><button type="button" class="ep-issues__button ep-issues__button--primary" data-requirement-action="open-form">Raise requirement</button></div>' : "") +
      "</section>" +
      '<section class="ep-panel ep-requirements__panel">' +
        '<div class="ep-requirements__toolbar"><div class="ep-requirements__tabs" role="tablist" aria-label="Requirement status">' +
          '<button type="button" data-requirement-view="Open" role="tab" aria-selected="' + (state.status === "Open") + '"' +
            (state.status === "Open" ? ' class="is-active"' : "") + ">Active</button>" +
          '<button type="button" data-requirement-view="Completed" role="tab" aria-selected="' + (state.status === "Completed") + '"' +
            (state.status === "Completed" ? ' class="is-active"' : "") + ">Completed</button>" +
        "</div>" +
        '<div class="ep-requirements__count" aria-live="polite">' + escape(pageRange()) + "</div></div>" +
        (state.notice ? '<p class="ep-requirements__notice" role="status">' + escape(state.notice) + "</p>" : "") +
        renderTable(visibleRows) +
        '<div class="ep-requirements__pagination"><button type="button" class="ep-issues__button" data-requirement-action="previous"' +
          (state.offset === 0 || state.loading ? " disabled" : "") + ">Previous</button>" +
          '<button type="button" class="ep-issues__button" data-requirement-action="next"' +
          (state.offset + state.limit >= state.total || state.loading ? " disabled" : "") + ">Next</button></div>" +
      "</section>" + renderForm() + "</div>";
    global.Solar91PortalSort.wire(host, state.sort, loadRows, "data-requirement-sort");
    global.Solar91PortalColumnFilter.wire(host, {
      attributes: {
        toggleKey: "data-requirement-filter-toggle",
        menuKey: "data-requirement-filter-menu",
        optionKey: "data-requirement-filter-option",
        optionValue: "data-requirement-filter-value",
        search: "data-requirement-filter-search",
        empty: "data-requirement-filter-empty"
      },
      classes: {
        menu: "ep-issues__column-filter-menu",
        search: "ep-issues__column-filter-search",
        empty: "ep-issues__column-filter-empty"
      },
      focusSearchOnOpen: true,
      keepAllOptionVisible: false,
      caseInsensitive: true,
      onSelect: function (key, _scope, value) {
        state.columnFilters[key] = value;
        state.offset = 0;
        loadRows();
      }
    });
  }

  function loadRows() {
    if (!host || state.loading) return;
    state.loading = true;
    state.error = "";
    renderView();
    var query = new URLSearchParams({
      status: state.status,
      sort_by: state.sort.key,
      sort_dir: state.sort.dir,
      offset: String(state.offset),
      limit: String(state.limit)
    });
    var filterNames = {
      siteCode: "filter_site_code",
      description: "filter_description",
      status: "filter_status",
      demandCount: "filter_demand_count",
      priority: "filter_priority"
    };
    Object.keys(filterNames).forEach(function (key) {
      if (state.columnFilters[key]) query.set(filterNames[key], state.columnFilters[key]);
    });
    api.request("/api/requirements?" + query.toString()).then(function (body) {
      state.rows = Array.isArray(body.items) ? body.items : [];
      state.total = Number(body.total) || 0;
      if (state.offset >= state.total && state.offset > 0) {
        state.offset = Math.max(0, Math.floor((state.total - 1) / state.limit) * state.limit);
        state.loading = false;
        global.setTimeout(loadRows, 0);
        return;
      }
    }).catch(function (error) {
      state.error = error && error.message ? error.message : "Requirements could not be loaded.";
    }).finally(function () {
      state.loading = false;
      renderView();
    });
  }

  function loadPlantsAndOpenForm() {
    state.formOpen = true;
    state.editOpen = false;
    state.editRow = null;
    state.editDemands = [""];
    state.submitError = "";
    state.plantsError = "";
    state.plantsLoading = true;
    renderView();
    api.plants().then(function (rows) {
      state.plants = Array.isArray(rows) ? rows : [];
    }).catch(function (error) {
      state.plantsError = error && error.message ? error.message : "Assigned plants could not be loaded.";
    }).finally(function () {
      state.plantsLoading = false;
      renderView();
    });
  }

  function updateTicket(id, field, value) {
    var action = field === "priority" ? "priority" : "status";
    state.mutatingId = id + ":" + action;
    state.notice = "";
    renderView();
    api.request("/api/requirements/" + encodeURIComponent(id) + "/" + action, {
      method: "PATCH",
      body: field === "priority" ? { priority: value } : { status: value }
    }).then(function () {
      state.offset = 0;
      state.notice = field === "priority" ? "Priority updated." :
        value === "Completed" ? "Requirement completed." : "Requirement reopened.";
      state.mutatingId = "";
      loadRows();
    }).catch(function (error) {
      state.mutatingId = "";
      state.notice = error && error.message ? error.message : "The requirement could not be updated.";
      renderView();
    });
  }

  function submitRequirement(form) {
    if (state.submitting) return;
    var formData = new FormData(form);
    var demands = Array.prototype.map.call(
      form.querySelectorAll("[data-requirement-demand]"),
      function (input) { return String(input.value || "").trim(); }
    ).filter(function (value) { return !!value; });
    var description = demands.join("\n");
    var plantId = String(formData.get("plantId") || "");
    if (!description) {
      state.submitError = "Enter at least one demand.";
      renderView();
      return;
    }
    if (!state.editRow && !plantId) {
      state.submitError = "Choose a plant.";
      renderView();
      return;
    }
    state.submitting = true;
    state.submitError = "";
    renderView();
    var request = state.editRow
      ? api.request("/api/requirements/" + encodeURIComponent(state.editRow.id), {
        method: "PATCH",
        body: {
          description: description,
          priority: String(formData.get("priority") || state.editRow.priority),
          status: String(formData.get("status") || state.editRow.status)
        }
      })
      : api.request("/api/requirements", {
        method: "POST",
        body: { plant_id: plantId, description: description }
      });
    var wasEdit = !!state.editRow;
    request.then(function () {
      state.formOpen = false;
      state.editOpen = false;
      state.editRow = null;
      state.editDemands = [""];
      state.submitting = false;
      state.status = "Open";
      state.offset = 0;
      state.notice = wasEdit ? "Requirement ticket updated." : "Requirement ticket created.";
      loadRows();
    }).catch(function (error) {
      state.submitting = false;
      state.submitError = error && error.message ? error.message : "The requirement could not be saved.";
      renderView();
    });
  }

  function wire(hostElement) {
    if (wiredHost === hostElement) return;
    wiredHost = hostElement;
    hostElement.addEventListener("click", function (event) {
      var button = event.target.closest("[data-requirement-action], [data-requirement-view], [data-requirement-status], [data-requirement-edit], [data-requirement-add-demand], [data-requirement-remove-demand]");
      if (!button || !hostElement.contains(button)) return;
      var action = button.getAttribute("data-requirement-action");
      if (action === "open-form") {
        loadPlantsAndOpenForm();
      } else if (action === "close-form") {
        state.formOpen = false;
        state.editOpen = false;
        state.editRow = null;
        state.editDemands = [""];
        state.submitError = "";
        renderView();
      } else if (action === "retry") {
        loadRows();
      } else if (action === "clear-filters") {
        state.columnFilters = Object.create(null);
        state.offset = 0;
        loadRows();
      } else if (action === "previous" || action === "next") {
        state.offset = Math.max(0, state.offset + (action === "next" ? state.limit : -state.limit));
        loadRows();
      } else if (button.hasAttribute("data-requirement-view")) {
        var nextStatus = button.getAttribute("data-requirement-view");
        if (state.status !== nextStatus) {
          state.status = nextStatus;
          state.offset = 0;
          state.columnFilters = Object.create(null);
          state.notice = "";
          loadRows();
        }
      } else if (button.hasAttribute("data-requirement-status")) {
        updateTicket(button.getAttribute("data-requirement-status"), "status",
          button.getAttribute("data-next-status"));
      } else if (button.hasAttribute("data-requirement-edit")) {
        var rowId = button.getAttribute("data-requirement-edit");
        var row = state.rows.find(function (item) { return item.id === rowId; });
        if (!row) return;
        state.editRow = row;
        state.editOpen = true;
        state.formOpen = true;
        state.submitError = "";
        state.editDemands = String(row.description || "").split(/\r?\n/).filter(function (value) {
          return !!value.trim();
        });
        if (!state.editDemands.length) state.editDemands = [""];
        renderView();
      } else if (button.hasAttribute("data-requirement-add-demand")) {
        state.editDemands.push("");
        renderView();
      } else if (button.hasAttribute("data-requirement-remove-demand")) {
        var removeIndex = Number(button.getAttribute("data-requirement-remove-demand"));
        if (state.editDemands.length > 1) {
          state.editDemands.splice(removeIndex, 1);
          renderView();
        }
      }
    });
    hostElement.addEventListener("change", function (event) {
      var select = event.target.closest("[data-requirement-priority]");
      if (select) updateTicket(select.getAttribute("data-requirement-priority"), "priority", select.value);
      if (event.target.name === "plantId") state.selectedPlantId = event.target.value;
    });
    hostElement.addEventListener("submit", function (event) {
      var form = event.target.closest("[data-requirement-form]");
      if (!form) return;
      event.preventDefault();
      submitRequirement(form);
    });
    hostElement.addEventListener("input", function (event) {
      var demandInput = event.target.closest("[data-requirement-demand]");
      if (demandInput) {
        var demandIndex = Array.prototype.indexOf.call(
          hostElement.querySelectorAll("[data-requirement-demand]"),
          demandInput
        );
        if (demandIndex >= 0) state.editDemands[demandIndex] = demandInput.value;
        var count = hostElement.querySelector("[data-requirement-point-count]");
        if (count) {
          var values = Array.prototype.map.call(
            hostElement.querySelectorAll("[data-requirement-demand]"),
            function (input) { return String(input.value || "").trim(); }
          ).filter(function (value) { return !!value; });
          count.textContent = values.length + " demand point" + (values.length === 1 ? "" : "s");
        }
      }
    });
    hostElement.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && state.formOpen) {
        state.formOpen = false;
        renderView();
      }
    });
  }

  function show(nextHost) {
    if (!nextHost) throw new Error("Requirements host element is missing.");
    host = nextHost;
    wire(host);
    loadRows();
  }

  global.Solar91PortalRequirements = { show: show };
}(window));
