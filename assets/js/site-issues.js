/**
 * Site issue register for the portfolio and plant Health pages.
 *
 * Every ticket is read from and written to the authenticated, role-scoped issue API.
 * Categories and their sub-problems come from /api/categories (Settings -> Categories),
 * which replaced the hard-coded list and the per-asset equipment register.
 */
(function (global) {
  "use strict";

  var data = global.Solar91PortalData;
  var format = global.Solar91PortalFormat;
  var STATUSES = ["Unhealthy", "In Progress", "Pending Closure", "Solved"];
  // Categories and their sub-problems come from /api/categories (Settings -> Categories).
  // Empty until that list is filled; nothing here is hard-coded any more.
  var CATEGORIES = [];
  var categoriesPromise = null;
  var searchTimer = null;

  function categoryNames() {
    return CATEGORIES.map(function (c) { return c.name; });
  }

  function subProblemsFor(name) {
    var row = CATEGORIES.filter(function (c) { return c.name === name; })[0];
    return (row && row.sub_problems) || [];
  }

  function loadCategories() {
    if (categoriesPromise) return categoriesPromise;
    categoriesPromise = global.Solar91PortalAPI.request("/api/categories").then(function (body) {
      CATEGORIES = body.categories || [];
      return CATEGORIES;
    }).catch(function (error) {
      categoriesPromise = null;
      throw error;
    });
    return categoriesPromise;
  }
  function isStringEquipment(equipment) {
    var lower = String(equipment || "").trim().toLowerCase();
    return lower === "string";
  }

  function hasEquipmentRunningStatus(equipment) {
    var lower = String(equipment || "").trim().toLowerCase();
    return lower === "inverter" || lower === "string";
  }

  // Per-session caches of unit counts keyed by site code, loaded lazily in the wizard.
  var unitConfigCache = {};
  var stringUnitConfigCache = {};
  var unitConfigLoading = {};

  function unitCacheFor(equipment) {
    return isStringEquipment(equipment) ? stringUnitConfigCache : unitConfigCache;
  }

  function unitConfigKey(siteCode, equipment) {
    return String(siteCode || "") + "|" + (isStringEquipment(equipment) ? "string" : "inverter");
  }

  function unitConfigIsLoading(siteCode, equipment) {
    return !!unitConfigLoading[unitConfigKey(siteCode, equipment)];
  }

  function loadUnitConfigFor(siteCode, equipment) {
    var cache = unitCacheFor(equipment);
    if (cache[siteCode] !== undefined) return Promise.resolve(cache[siteCode]);
    var key = unitConfigKey(siteCode, equipment);
    if (!unitConfigLoading[key]) {
      var plant = state.plants.find(function (item) { return item.siteCode === siteCode; });
      if (!plant || !plant.dbId) return Promise.reject(new Error("The selected plant is not available in your authorized plant list."));
      var url = "/api/issues/equipment-units?plant_id=" + encodeURIComponent(plant.dbId) +
        "&vertical=" + encodeURIComponent(isStringEquipment(equipment) ? "String" : "Inverter");
      unitConfigLoading[key] = global.Solar91PortalAPI.request(url).then(function (body) {
        var totalUnits = Number(body && body.total_units);
        if (!Number.isInteger(totalUnits) || totalUnits < 0) {
          throw new Error("The equipment unit count response was invalid.");
        }
        cache[siteCode] = totalUnits;
        return totalUnits;
      }).catch(function (error) {
        delete unitConfigLoading[key];
        throw error;
      });
    }
    return unitConfigLoading[key];
  }

  function requestUnitConfigForDraft(siteCode, equipment) {
    state.unitConfigError = "";
    return loadUnitConfigFor(siteCode, equipment).then(function () {
      if (!state.draft || state.modalMode !== "create" ||
          state.draft.plantCode !== siteCode || state.draft.equipment !== equipment) return;
      state.unitConfigError = "";
      renderWizardView();
    }).catch(function (error) {
      if (!state.draft || state.modalMode !== "create" ||
          state.draft.plantCode !== siteCode || state.draft.equipment !== equipment) return;
      state.unitConfigError = (error && error.message) || "Please retry.";
      renderWizardView();
    });
  }

  function configuredUnitCount(siteCode, equipment) {
    var count = unitCacheFor(equipment)[siteCode];
    return count === undefined ? 0 : count;
  }

  function issueEquipmentDetails(draft) {
    var tracked = hasEquipmentRunningStatus(draft.equipment);
    var isBreakdown = tracked && draft.equipmentRunning === false;
    var configuredUnits = configuredUnitCount(draft.plantCode, draft.equipment);
    var units = parseInt(draft.unitCount, 10);
    var serial = (draft.serialNo || "").trim() || null;
    var unitCount = isNaN(units) ? null : units;
    if (isBreakdown && configuredUnits > 0) {
      var prefix = isStringEquipment(draft.equipment) ? "String " : "Unit ";
      serial = (draft.selectedUnits || []).map(function (number) { return prefix + number; }).join(", ") || null;
      unitCount = (draft.selectedUnits || []).length;
    } else if (isBreakdown) {
      unitCount = 1;
    }
    return {
      serial_no: serial,
      unit_count: unitCount,
      equipment_running: tracked && draft.equipmentRunning !== null ? draft.equipmentRunning : undefined
    };
  }

  var pendingEquipment = null;
  var state = {
    rows: [],
    plants: [],
    loaded: false,
    loadedAt: 0,
    loading: false,
    error: "",
    search: "",
    plantFilter: "",
    // The register opens on the actionable work — Open + In Progress. Resolved / Closed
    // tickets stay out of the default view but remain reachable through the status filter.
    statusFilter: "Active",
    equipmentFilter: "",
    sort: "recent",
    columnSort: { key: "", dir: "asc" },
    issueDateStart: "",
    issueDateEnd: "",
    issueDatePeriod: "month",
    issueMonth: "",
    issueDateRangeMode: false,
    issueDateDraftStart: "",
    issueDateDraftEnd: "",
    issueDateError: "",
    columnFilters: {},
    categoryLoading: false,
    categoryError: "",
    assigneesLoaded: false,
    assigneesLoading: false,
    assigneesError: "",
    isAssignee: false,
    issueOwnerView: "mine",
    currentUserId: "",
    unitConfigError: "",
    modalId: "",
    modalMode: "",
    editDraft: null,
    wizardStep: 1,
    draft: null,
    requestId: 0,
    // Issues are read from the server for the scope on screen (one plant, or every plant) a page at a time, newest
    // first. `scope` is the plant code the rows were loaded for ("" = all plants); `hasMore` = the last page was full.
    scope: null,
    pageSize: 200,
    nextOffset: 0,
    hasMore: false,
    loadingMore: false,
    moreError: "",
    liveMode: false,
    canRaise: false,
    // The Head can correct original classification/remarks; Assignees can use
    // permitted operational edits on their own open tickets.
    canEdit: false,
    // Assigning and resetting to Open need issues.manage, so they are the Head's alone.
    isHead: false,
    assignees: [],
    submitError: "",
    closeError: "",
    closeDraft: null,
    closureRejectRemark: "",
    submitNotice: "",
    submitting: false,
    // Photos for the ticket on screen, read from /api/photos (thumbnails only; the original
    // is fetched by the viewer on an explicit click). Keyed by ticket number.
    issuePhotos: {},
    photoBusy: {},
    photoError: "",
    selectedIssuePlantCode: "",
    // A ticket whose photos failed to upload. The ticket itself is already saved, so the retry
    // re-sends the same files under the SAME submission id: the server treats a repeat as the
    // one submission it is, and never stores a second copy.
    pendingPhotos: null
  };
  var active = null;
  var wiredHost = null;

  // Raise issue takes at most four photos. Each is downscaled in the browser (2048 px, WebP)
  // before it leaves the phone, so a field upload costs a fraction of a camera original and the
  // bucket is not filled by full-resolution JPEGs.
  var MAX_ISSUE_PHOTOS = 4;

  function photoEvidence() {
    return global.Solar91PhotoEvidence || null;
  }

  function escape(value) {
    return format.escape(value);
  }

  function plantLabel(plant) {
    return plant.displayName || plant.plantName;
  }

  function invalidateOverviewData() {
    if (data && typeof data.invalidate === "function") data.invalidate(true);
  }

  function localDate(date) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") +
      "-" + String(date.getDate()).padStart(2, "0");
  }

  function datePeriodRange(period, today) {
    var date = new Date(today + "T00:00:00");
    if (period === "all") return { start: "", end: "" };
    if (period === "today") return { start: today, end: today };
    if (period === "yesterday") {
      date.setDate(date.getDate() - 1);
      var yesterday = localDate(date);
      return { start: yesterday, end: yesterday };
    }
    if (period === "week") {
      date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      return { start: localDate(date), end: today };
    }
    return { start: today.slice(0, 8) + "01", end: today };
  }

  function monthPeriodRange(month, today) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))) return { start: "", end: "" };
    var parts = month.split("-").map(Number);
    var lastDay = new Date(parts[0], parts[1], 0).getDate();
    var start = month + "-01";
    var end = month + "-" + String(lastDay).padStart(2, "0");
    if (month === today.slice(0, 7) && today < end) end = today;
    return { start: start, end: end };
  }

  function elapsedDays(date, today) {
    function dayNumber(value) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
      var parts = value.split("-").map(Number);
      var timestamp = Date.UTC(parts[0], parts[1] - 1, parts[2]);
      var parsed = new Date(timestamp);
      return parsed.getUTCFullYear() === parts[0] &&
        parsed.getUTCMonth() === parts[1] - 1 &&
        parsed.getUTCDate() === parts[2]
        ? timestamp / 86400000
        : null;
    }
    var issueDay = dayNumber(date);
    var todayDay = dayNumber(today);
    return issueDay === null || todayDay === null ? null : todayDay - issueDay;
  }

  function mapApiIssue(issue, plantsById) {
    var plant = plantsById[String(issue.plant_id)];
    return {
      id: issue.ticket_no,
      dbId: String(issue.id),
      plantId: String(issue.plant_id || ""),
      plantCode: plant ? plant.siteCode : "",
      plantName: plant ? plantLabel(plant) : "Plant unavailable",
      equipment: issue.vertical || "Other",
      subpart: issue.subcategory || "",
      assignedTo: issue.assigned_to ? String(issue.assigned_to) : "",
      serialNo: issue.serial_no || "",
      supplierMaker: issue.supplier_maker || "",
      unitCount: issue.unit_count == null ? "" : String(issue.unit_count),
      occurredAt: String(issue.occurred_at || "").slice(0, 10),
      dueAt: issue.etc_at || "",
      problem: issue.description,
      sourceTask: issue.source_task || "",
      status: issue.status,
      assignee: issue.assignee_text || "",
      reportedAt: String(issue.created_at || "").slice(0, 10),
      reportedAtSort: String(issue.created_at || ""),
      reportedBy: "",
      evidenceFiles: [],
      photoCount: Number(issue.photo_count || 0),
      notes: "",
      severity: issue.severity,
      closure: issue.closure || {},
      live: true
    };
  }

  function matchesOwnerView(issue) {
    return !state.isAssignee || state.issueOwnerView === "all" ||
      (issue.assignedTo && issue.assignedTo === state.currentUserId);
  }

  function canEditIssue(issue) {
    return !state.liveMode || state.isHead || (state.isAssignee && issue.status !== "Closed" &&
      (issue.assignedTo ? issue.assignedTo === state.currentUserId : canCloseIssue(issue)));
  }

  function rowsFor(context, ignoreStatus) {
    var rows = state.rows.filter(function (issue) {
      if (!matchesOwnerView(issue)) return false;
      if (context.plantCode && issue.plantCode !== context.plantCode) return false;
      if ((state.issueDateStart || state.issueDateEnd) &&
          (!issue.occurredAt ||
            (state.issueDateStart && issue.occurredAt < state.issueDateStart) ||
            (state.issueDateEnd && issue.occurredAt > state.issueDateEnd))) return false;
      if (state.plantFilter && issue.plantCode !== state.plantFilter) return false;
      if (state.equipmentFilter &&
          String(issue.equipment || "").toLowerCase() !== state.equipmentFilter.toLowerCase()) return false;
      if (state.canEdit && Object.keys(state.columnFilters).some(function (key) {
        var term = String(state.columnFilters[key] || "").trim().toLowerCase();
        if (!term) return false;
        return issueColumnValue(issue, key).toLowerCase().indexOf(term) === -1;
      })) return false;
      if (!ignoreStatus && state.statusFilter !== "All" &&
          (state.statusFilter === "Active"
            ? statusGroup(issue.status) === "Solved"
            : state.statusFilter === "Pending Closure"
              ? issue.status !== "Pending Closure"
              : statusGroup(issue.status) !== state.statusFilter)) return false;
      var term = state.search.trim().toLowerCase();
      if (!term) return true;
      return [
        issue.id, issue.plantCode, issue.plantName, issue.equipment,
        issue.supplierMaker, issue.serialNo, issue.problem, issue.status, issue.assignee
      ].join(" ").toLowerCase().indexOf(term) !== -1;
    });
    rows = rows.sort(function (a, b) {
      var aReportedAt = a.reportedAtSort || a.reportedAt;
      var bReportedAt = b.reportedAtSort || b.reportedAt;
      var dateOrder = state.sort === "oldest"
        ? aReportedAt.localeCompare(bReportedAt)
        : bReportedAt.localeCompare(aReportedAt);
      return dateOrder || STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.id.localeCompare(b.id);
    });
    // A column heading, once clicked, orders the register instead of the date.
    return state.columnSort.key
      ? global.Solar91PortalSort.apply(rows, state.columnSort, COLUMNS)
      : rows;
  }

  function countByStatus(rows, status) {
    return rows.filter(function (issue) {
      return status === "Pending Closure"
        ? issue.status === status
        : statusGroup(issue.status) === status;
    }).length;
  }

  function statusGroup(status) {
    if (["Solved", "Resolved", "Closed"].indexOf(status) !== -1) return "Solved";
    if (["In Progress", "Pending Vendor", "Pending Parts/Vendor", "Pending Closure"].indexOf(status) !== -1) return "In Progress";
    return "Unhealthy";
  }

  function statusTone(status) {
    if (["Solved", "Resolved", "Closed"].indexOf(status) !== -1) return "solved";
    if (["In Progress", "Pending Vendor", "Pending Parts/Vendor", "Pending Closure"].indexOf(status) !== -1) return "progress";
    return "unhealthy";
  }

  function statusLabel(status) {
    if (!state.liveMode) return status;
    return status === "Unhealthy" ? "Open" : status === "Solved" ? "Resolved / Closed" : status;
  }

  function plantOptions() {
    var options = '<option value="">All plants</option>';
    return options + state.plants.map(function (plant) {
      return '<option value="' + escape(plant.siteCode) + '"' +
        (state.plantFilter === plant.siteCode ? " selected" : "") + ">" +
        escape(plantLabel(plant)) + " · " + escape(plant.displayCode) + "</option>";
    }).join("");
  }

  function renderHeader(context) {
    // Export is offered to everyone who can see the register; import follows the
    // same permission as raising a ticket, because that is what each row becomes.
    var sheets = global.Solar91RegisterIO
      ? global.Solar91RegisterIO.controls("issues", { canImport: state.canRaise })
      : "";
    var raise = state.canRaise
      ? '<button class="ep-issues__button ep-issues__button--primary" type="button" data-issue-action="raise">+ Raise issue</button>'
      : "";
    var equipmentChip = state.equipmentFilter
      ? '<button type="button" class="ep-issues__equip-chip" data-issue-action="clear-equipment" ' +
        'title="Show every equipment category again">' + escape(state.equipmentFilter) +
        ' only <span aria-hidden="true">x</span></button>'
      : "";
    var ownerView = state.isAssignee
      ? '<label class="ep-issues__date-month"><span>Responsibility</span><select class="ep-issues__date-period" data-issue-owner-view aria-label="Issue responsibility">' +
        '<option value="mine"' + (state.issueOwnerView === "mine" ? " selected" : "") + '>My Issues</option>' +
        '<option value="all"' + (state.issueOwnerView === "all" ? " selected" : "") + '>All Issues</option></select></label>'
      : "";
    return '<div class="ep-issues__portfolio-actions">' + ownerView + equipmentChip +
      '<div class="ep-issues__date-filter" role="group" aria-label="Filter issues by occurrence date">' +
        '<span class="ep-issues__date-label">Range</span>' +
        '<label class="ep-toggle" title="Toggle custom date range">' +
          '<input type="checkbox" data-issue-date-mode' + (state.issueDateRangeMode ? " checked" : "") +
            ' aria-label="Toggle custom date range" />' +
          '<span class="ep-toggle__track"><span class="ep-toggle__thumb"></span></span>' +
        '</label>' +
        '<div class="ep-issues__date-quick"' + (state.issueDateRangeMode ? ' hidden' : "") + '>' +
          '<select class="ep-issues__date-period" data-issue-date-period aria-label="Issue date period">' +
            '<option value="all"' + (state.issueDatePeriod === "all" ? " selected" : "") + '>All time</option>' +
            '<option value="today"' + (state.issueDatePeriod === "today" ? " selected" : "") + '>Today</option>' +
            '<option value="yesterday"' + (state.issueDatePeriod === "yesterday" ? " selected" : "") + '>Yesterday</option>' +
            '<option value="week"' + (state.issueDatePeriod === "week" ? " selected" : "") + '>This week</option>' +
            '<option value="month"' + (state.issueDatePeriod === "month" ? " selected" : "") + '>Selected month</option>' +
          '</select>' +
        '</div>' +
        '<label class="ep-issues__date-month"><span>Month</span><input type="month" data-issue-month value="' +
          escape(state.issueMonth) + '" max="' + escape(localDate(new Date()).slice(0, 7)) +
          '" aria-label="Filter issues by month of occurrence" /></label>' +
        '<div class="ep-issues__date-custom"' + (!state.issueDateRangeMode ? ' hidden' : "") + '>' +
          '<label><span>From</span><input type="date" data-issue-date-start value="' +
            escape(state.issueDateDraftStart) + '" aria-label="Issue date from" /></label>' +
          '<span class="ep-issues__date-separator" aria-hidden="true">–</span>' +
          '<label><span>To</span><input type="date" data-issue-date-end value="' +
            escape(state.issueDateDraftEnd) + '" aria-label="Issue date to" /></label>' +
          '<button type="button" class="ep-issues__button ep-issues__button--small" data-issue-date-clear>Clear</button>' +
        '</div>' +
        (state.issueDateError
          ? '<span class="ep-issues__date-error" role="alert">' + escape(state.issueDateError) + '</span>'
          : "") +
      '</div>' + raise + sheets + '</div>';
  }

  function renderFilters(context, unfilteredRows) {
    var isPlant = !!context.plantCode;
    return '<section class="ep-issues__filters" aria-label="Issue filters">' +
      '<div class="ep-issues__filter-row">' +
        '<label class="ep-issues__search"><span class="ep-issues__sr-only">Search issues</span>' +
          '<span aria-hidden="true">⌕</span><input type="search" data-issue-filter="search" value="' +
          escape(state.search) + '" placeholder="Search issues, plants, equipment…" /></label>' +
        (isPlant
          ? (context.plantDetailsMerged ? "" : '<span class="ep-issues__scope">' + escape(context.plantCode) + '</span>')
          : '<label class="ep-issues__select"><span class="ep-issues__sr-only">Filter by plant</span><select data-issue-filter="plant">' +
            plantOptions() + '</select></label>') +
        '<label class="ep-issues__select"><span class="ep-issues__sr-only">Sort issues</span><select data-issue-filter="sort">' +
          '<option value="recent">Recently reported</option><option value="oldest">Oldest first</option></select></label>' +
      '</div><div class="ep-issues__status-filters" aria-label="Filter by issue status">' +
        '<button type="button" data-issue-status="Active" class="' + (state.statusFilter === "Active" ? "is-active" : "") + '">' +
          'Open + in progress <b>' + unfilteredRows.filter(function (issue) {
            return statusGroup(issue.status) !== "Solved";
          }).length + '</b></button>' +
        '<button type="button" data-issue-status="All" class="' + (state.statusFilter === "All" ? "is-active" : "") + '">All <b>' +
          unfilteredRows.length + '</b></button>' +
        STATUSES.map(function (status) {
          return '<button type="button" data-issue-status="' + escape(status) + '"' +
            (state.statusFilter === status ? ' class="is-active"' : "") + ">" +
            '<i class="ep-issues__dot ep-issues__dot--' + statusTone(status) + '"></i>' +
            escape(statusLabel(status)) + ' <b>' + countByStatus(unfilteredRows, status) + '</b></button>';
        }).join("") +
      '</div></section>';
  }

  // Keep the issue ID beside the row action so plant and issue details lead the register.
  // Status orders by how urgent the group is, not alphabetically.
  var COLUMNS = [
    { key: "plant", label: "Plant", sort: function (i) { return i.plantCode; } },
    { key: "equipment", label: "Equipment", sort: function (i) { return i.equipment; } },
    { key: "subpart", label: "Sub-problem", sort: function (i) { return i.subpart; } },
    { key: "problem", label: "Issue Description", sort: function (i) { return i.problem; } },
    { key: "maker", label: "Maker / Supplier", sort: function (i) { return i.supplierMaker; } },
    { key: "occurred", label: "Occurred on", sort: function (i) { return i.occurredAt; } },
    { key: "etc", label: "Est. completion", sort: function (i) { return i.dueAt; } },
    { key: "assignee", label: "Assigned to", sort: function (i) { return i.assignee; } },
    { key: "status", label: "Status",
      sort: function (i) { return ["Unhealthy", "In Progress", "Solved"].indexOf(statusGroup(i.status)); } },
    { key: "id", label: "Issue ID", sort: function (i) { return i.id; } },
    { key: "action", label: "Action" }
  ];

  function issueColumnValue(issue, key) {
    var values = {
      plant: issue.plantCode + " " + issue.plantName,
      equipment: issue.equipment,
      subpart: issue.subpart,
      maker: issue.supplierMaker,
      problem: issue.problem,
      assignee: issue.assignee,
      status: issue.status
    };
    return String(values[key] || "").trim();
  }

  function issueColumnOptions(key) {
    var values = {};
    state.rows.forEach(function (issue) {
      var value = issueColumnValue(issue, key);
      if (value) values[value] = true;
    });
    return Object.keys(values).sort(function (a, b) { return a.localeCompare(b); });
  }

  var FILTERABLE_ISSUE_COLUMNS = ["plant", "equipment", "subpart", "maker", "problem", "assignee", "status"];

  function issueColumnHeader(column) {
    var header = global.Solar91PortalSort.thHTML(column, state.columnSort, "data-issue-sort");
    if (!state.canEdit || FILTERABLE_ISSUE_COLUMNS.indexOf(column.key) === -1) return header;

    var activeFilter = String(state.columnFilters[column.key] || "");
    return global.Solar91PortalColumnFilter.headerHTML(header, {
      key: column.key,
      label: column.label,
      values: issueColumnOptions(column.key),
      active: activeFilter,
      menuId: "ep-issue-filter-menu-" + column.key,
      attributes: {
        toggleKey: "data-issue-column-filter-toggle",
        menuKey: "data-issue-column-filter-menu",
        optionKey: "data-issue-column-filter-option",
        optionValue: "data-issue-column-filter-value",
        search: "data-issue-column-filter-search",
        empty: "data-issue-column-filter-empty"
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

  function wireColumnFilterMenus(host) {
    global.Solar91PortalColumnFilter.wire(host, {
      attributes: {
        toggleKey: "data-issue-column-filter-toggle",
        menuKey: "data-issue-column-filter-menu",
        optionKey: "data-issue-column-filter-option",
        optionValue: "data-issue-column-filter-value",
        search: "data-issue-column-filter-search",
        empty: "data-issue-column-filter-empty"
      },
      classes: {
        menu: "ep-issues__column-filter-menu",
        search: "ep-issues__column-filter-search",
        empty: "ep-issues__column-filter-empty"
      },
      focusSearchOnOpen: false,
      keepAllOptionVisible: false,
      onSelect: function (key, _scope, value) {
        state.columnFilters[key] = value;
        renderView();
      }
    });
  }

  function refreshCompactCells(container) {
    if (!container || !global.getComputedStyle) return;
    var cells = Array.prototype.slice.call(container.querySelectorAll("[data-compact-cell]"));
    cells.forEach(function (cell) {
      var content = cell.querySelector("[data-compact-content]");
      if (content) content.classList.remove("is-collapsed");
    });
    cells.forEach(function (cell) {
      var content = cell.querySelector("[data-compact-content]");
      var button = cell.querySelector("[data-compact-cell-toggle]");
      if (!content || !button) return;
      var lineHeight = parseFloat(global.getComputedStyle(content).lineHeight);
      var hasMore = lineHeight > 0 && content.scrollHeight > lineHeight * 2 + 1;
      var expanded = hasMore && button.getAttribute("aria-expanded") === "true";
      button.hidden = !hasMore;
      content.classList.toggle("is-collapsed", !expanded);
      button.textContent = expanded ? "Less" : "More";
      button.setAttribute("aria-expanded", String(expanded));
    });
  }

  document.addEventListener("portal:info-health-panel-opened", function (event) {
    if (event.detail && event.detail.section === "health" && active &&
        !active.context.plantCode && active.host.isConnected) {
      refreshCompactCells(active.host);
    }
  });

  function occurrenceDateCell(value) {
    if (!value) return '<span class="ep-issues__unassigned">Not recorded</span>';
    var days = elapsedDays(value, localDate(new Date()));
    var age = days === null
      ? ""
      : '<small class="ep-issues__date-age">(' +
        (days < 0 ? "in " + Math.abs(days) : days) + " " +
        (Math.abs(days) === 1 ? "day" : "days") + ')</small>';
    return escape(formatIssueDate(value)) + age;
  }

  /** The ETC is stored as a timestamp; the register shows the date, with the time as its title. */
  function etcCell(value) {
    if (!value) return '<span class="ep-issues__unassigned">Not set</span>';
    var text = String(value).replace("T", " ").replace("Z", "");
    return '<span title="' + escape(text) + '">' + escape(formatIssueDate(text.slice(0, 10))) + "</span>";
  }

  function renderTable(rows) {
    if (!rows.length) {
      return '<div class="ep-issues__empty"><strong>No issues found</strong>' +
        '<button type="button" class="ep-issues__button" data-issue-action="clear">Clear filters</button></div>';
    }
    var headers = COLUMNS.map(function (c) { return c.label; });
    var groups = [], groupsByCode = Object.create(null);
    rows.forEach(function (issue) {
      var code = issue.plantCode || "";
      var group = groupsByCode[code];
      if (!group) {
        group = groupsByCode[code] = { siteCode: code, plantName: issue.plantName || code, issues: [] };
        groups.push(group);
      }
      group.issues.push(issue);
    });
    return '<div class="ep-issues__table-wrap"><table class="ep-issues__table"><thead><tr>' +
      COLUMNS.map(issueColumnHeader).join("") +
      '</tr></thead><tbody>' + groups.filter(function (group) {
        return !state.selectedIssuePlantCode || group.siteCode === state.selectedIssuePlantCode;
      }).map(function (group) {
        return group.issues.map(function (issue) {
          return renderIssueRow(issue, headers);
        }).join("");
      }).join("") + '</tbody></table></div>';
  }

  function pmSourceBadge(issue) {
    return issue.sourceTask ? '<span class="ep-issues__pm-source">From Preventive Maintenance</span>' : '';
  }

  function renderIssueRow(issue, labels) {
    var selectedPlant = state.selectedIssuePlantCode === issue.plantCode;
    return '<tr class="ep-issues__row">' +
          '<td data-label="' + labels[0] + '"><button type="button" class="ep-issues__plant-code-filter' +
            (selectedPlant ? ' is-selected' : '') + '" data-issue-plant-toggle="' + escape(issue.plantCode) +
            '" aria-pressed="' + String(selectedPlant) + '" aria-label="' +
            (selectedPlant ? "Show issues for all plants" : "Show only issues for " + escape(issue.plantName)) +
            '"><strong>' + escape(issue.plantCode) + '</strong><small>' + escape(issue.plantName) +
            '</small></button></td>' +
          '<td data-label="' + labels[1] + '"><strong>' + escape(issue.equipment) + '</strong>' + pmSourceBadge(issue) + '</td>' +
          '<td data-label="' + labels[2] + '">' + (issue.subpart
            ? escape(issue.subpart)
            : '<span class="ep-issues__unassigned">Not recorded</span>') + '</td>' +
          '<td data-label="' + labels[3] + '" class="ep-issues__problem"><div class="ep-compact-cell" data-compact-cell>' +
            '<div class="ep-compact-cell__content is-collapsed" data-compact-content>' + escape(issue.problem) + '</div>' +
            '<button type="button" class="ep-compact-cell__toggle" data-compact-cell-toggle ' +
              'aria-expanded="false" hidden>More</button></div></td>' +
          '<td data-label="' + labels[4] + '">' + (issue.supplierMaker
            ? '<strong>' + escape(issue.supplierMaker) + '</strong>' +
              (issue.serialNo ? "<small>S/N " + escape(issue.serialNo) + "</small>" : "")
            : '<span class="ep-issues__unassigned">Not recorded</span>') + '</td>' +
          '<td data-label="' + labels[5] + '" class="ep-issues__date">' +
            occurrenceDateCell(issue.occurredAt) + '</td>' +
          '<td data-label="' + labels[6] + '" class="ep-issues__date">' + etcCell(issue.dueAt) + '</td>' +
          '<td data-label="' + labels[7] + '">' + (issue.assignee
            ? '<span class="ep-issues__assignee"><i>' + escape(issue.assignee.split(/\s+/).map(function (part) { return part[0]; }).join("").slice(0, 2)) +
              '</i>' + escape(issue.assignee) + '</span>'
            : '<span class="ep-issues__unassigned">Unassigned</span>') + '</td>' +
          '<td data-label="' + labels[8] + '"><span class="ep-issues__status ep-issues__status--' +
            statusTone(issue.status) + '"><i></i>' + escape(issue.status) + '</span></td>' +
          '<td data-label="' + labels[9] + '"><button type="button" class="ep-issues__ticket-link" data-issue-open="' +
            escape(issue.id) + '">' + escape(issue.id) + '</button></td>' +
          '<td data-label="' + labels[10] + '">' + (!canEditIssue(issue)
            ? '<span aria-label="Manage this saved ticket in Solar91 O&M">Saved</span>'
            // A tick icon rather than an "Edit" button: the column shrinks to the icon's width
            // and gives its space back to the description. The label stays for screen readers.
            : '<button type="button" class="ep-issues__edit-tick" data-issue-edit="' +
              escape(issue.id) + '" title="Edit ' + escape(issue.id) +
              '" aria-label="Edit ' + escape(issue.id) + '">' +
              '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
              'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
              '<path d="m5 13 4 4L19 7"></path></svg></button>') + '</td>' +
        '</tr>';
  }

  // The workflow is a state machine (app/issues/service.py :: transition), so a
  // ticket can only move to an adjacent status — Open cannot jump to In Progress.
  // Offering anything else just earns a 409, so the dropdown lists exactly what
  // the current status allows.
  //
  // Resolved is offered only through its resolution form; Closed is handled by
  // the explicit logged close action below. "Assigned" is not a transition —
  // that happens by choosing an assignee.
  var STATUS_FLOW = {
    "Open": ["Acknowledged"],
    "Assigned": ["Acknowledged"],
    "Acknowledged": ["In Progress"],
    "In Progress": ["Pending Vendor"],
    "Pending Vendor": ["In Progress"],
    "Pending Parts/Vendor": ["In Progress"]
  };

  // Resolving is only legal from In Progress or Pending Vendor, so a ticket
  // further back is walked through the stages in between first. Every step is a
  // real transition, so the ticket's history reads correctly afterwards.
  var STEPS_BEFORE_RESOLVE = {
    "Open": ["Acknowledged", "In Progress"],
    "Assigned": ["Acknowledged", "In Progress"],
    "Acknowledged": ["In Progress"],
    "In Progress": [],
    "Pending Vendor": [],
    "Pending Parts/Vendor": []
  };

  /** The statuses this form may offer for a ticket, current one first. */
  function statusChoicesFor(status) {
    var choices = [status].concat(STATUS_FLOW[status] || []);
    if (STEPS_BEFORE_RESOLVE[status] !== undefined) choices.push("Resolved");
    // Sending a ticket back to Open is a reset, which only the O&M Head may do.
    if (state.isHead && status !== "Open") choices.push("Open");
    return choices.filter(function (value, index) { return choices.indexOf(value) === index; });
  }

  function canCloseIssue(issue) {
    var api = global.Solar91PortalAPI;
    var user = api && api.currentUser ? api.currentUser() : null;
    if (!user || (user.role !== "O&M Head" && user.role !== "Assignee") || issue.status === "Closed") return false;
    if (user.role === "O&M Head") return true;
    if (issue.assignedTo && String(issue.assignedTo) === String(user.id)) return true;
    if (issue.assignedTo || !issue.assignee) return false;
    var identities = [user.display_name, user.displayName, user.name, user.email].filter(Boolean).map(function (value) {
      return String(value).trim().toLowerCase();
    });
    var entries = String(issue.assignee).toLowerCase().split(/[,;\/&|]+/).map(function (value) {
      return value.trim();
    });
    return identities.some(function (identity) {
      return identity && (entries.indexOf(identity) !== -1 || identity.indexOf("@") !== -1 && issue.assignee.toLowerCase().indexOf(identity) !== -1);
    });
  }

  function eligibleAssignees(siteCode) {
    return state.assignees.filter(function (person) {
      return state.isHead || !siteCode || (person.plants || []).indexOf(siteCode) !== -1;
    });
  }

  function assigneeOptions(siteCode, selectedId) {
    return eligibleAssignees(siteCode).map(function (person) {
      return '<option value="' + escape(person.id) + '"' +
        (String(selectedId || "") === String(person.id) ? " selected" : "") + ">" +
        escape(person.name) + "</option>";
    }).join("");
  }

  /** Today as YYYY-MM-DD, so a fix cannot be dated in the future. */
  function todayISO() {
    var now = new Date();
    return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") +
      "-" + String(now.getDate()).padStart(2, "0");
  }

  /** The edit form: the stored details of one ticket, corrected in place. */
  function renderEditForm(issue) {
    if (!issue || !canEditIssue(issue)) return '<p class="ep-issues__empty">This ticket is not editable by you.</p>';
    var draft = state.editDraft && state.editDraft.id === issue.dbId ? state.editDraft : {};
    var value = function (name, fallback) {
      return draft[name] === undefined ? (fallback || "") : draft[name];
    };
    var field = function (name, label, value, attrs) {
      return '<label class="ep-issues__wizard-field">' + escape(label) +
        '<input name="' + name + '" value="' + escape(value || "") + '" ' + (attrs || "") + ' /></label>';
    };
    var equipment = value("equipment", issue.equipment);
    var subpart = value("subpart", issue.subpart);
    var status = value("status", issue.status);
    var protectedOwner = ["Closed", "Resolved", "Pending Closure"].indexOf(issue.status) !== -1;
    var routing = value("assignmentMode", protectedOwner ? "retain" : "on_change");
    // Compact layout: short fields share rows, help text only where it changes what the user
    // does, and Save / Cancel stay pinned at the bottom so the form is never scrolled to save.
    // The ticket ID is in the drawer title and the plant in its subtitle, so no info box repeats them.
    return '<form class="ep-issues__wizard ep-issues__edit" data-issue-form data-issue-edit-form="' + escape(issue.dbId) + '">' +
      '<div class="ep-issues__wizard-fields ep-issues__wizard-fields--two">' +
        '<label class="ep-issues__wizard-field">Equipment / category' +
          (state.isHead ? '<select name="equipment">' + renderEquipmentOptions(equipment) + '</select>' : '<span class="ep-issues__readonly">' + escape(equipment) + '</span>') + '</label>' +
        '<label class="ep-issues__wizard-field">Sub-problem' +
          (state.isHead ? '<select name="subpart" title="The fault for this category, the same list the Raise issue form offers">' +
          renderSubpartOptions(subpart, equipment) + '</select>' : '<span class="ep-issues__readonly">' + escape(subpart || 'Not recorded') + '</span>') + '</label>' +
      '</div>' +
      (state.isHead && state.categoryLoading
        ? '<p class="ep-issues__category-note" role="status">Loading configured categories…</p>'
        : state.isHead && state.categoryError
          ? '<p class="ep-issues__category-note ep-issues__category-error" role="alert">Could not load configured categories. The ticket’s existing category is preserved. ' +
            '<button type="button" class="ep-issues__button ep-issues__button--small" data-issue-action="retry-edit-categories">Retry</button></p>'
          : state.isHead && !CATEGORIES.length
            ? '<p class="ep-issues__category-note">No categories were returned by Settings → Categories. The ticket’s existing category is preserved.</p>'
            : "") +
      '<div class="ep-issues__wizard-fields ep-issues__wizard-fields--three">' +
        field("supplierMaker", "Maker / Supplier", value("supplierMaker", issue.supplierMaker), 'maxlength="160"') +
        field("serialNo", "Serial number", value("serialNo", issue.serialNo), 'maxlength="120"') +
        field("unitCount", "Units", value("unitCount", issue.unitCount), 'type="number" min="1" max="100000"') +
      '</div>' +
      // No severity field. Raise issue does not ask for one either (every ticket is
      // filed as Medium), so the register does not offer a way to diverge from that.
      // Where a ticket stands is its Status, not its severity.
      // Assigning is the O&M Head's call: /assign and /reassign both require
      // issues.manage, so an Assignee sees who holds the ticket but cannot move it.
      '<div class="ep-issues__wizard-fields ep-issues__wizard-fields--two">' +
      (state.isHead && !protectedOwner
        ? '<div class="ep-issues__wizard-field"><label class="ep-issues__wizard-field">Assignment (current: ' + escape(issue.assignee || "Unassigned") + ')' +
            '<select name="assignmentMode">' +
              [["on_change", "Automatic when equipment changes"], ["auto", "Reapply automatic routing"], ["retain", "Retain current Assignee"], ["manual", "Choose Assignee manually"]].map(function (choice) {
                return '<option value="' + choice[0] + '"' + (routing === choice[0] ? ' selected' : '') + '>' + choice[1] + '</option>';
              }).join("") + '</select></label>' +
            '<label class="ep-issues__wizard-field" data-edit-manual-owner' + (routing === "manual" ? "" : " hidden") + '>New Assignee' +
              '<select name="assignedTo"><option value="">Select active Assignee</option>' +
              assigneeOptions(issue.plantCode, value("assignedTo", issue.assignedTo)) + '</select>' +
              (state.assigneesLoading ? '<small>Loading assignees…</small>' : '') +
              (state.assigneesError ? '<small role="alert">' + escape(state.assigneesError) + ' <button type="button" data-issue-action="retry-assignees">Retry</button></small>' : '') + '</label></div>'
        : '<div class="ep-issues__wizard-field">Assigned to' +
            '<span class="ep-issues__readonly">' + escape(issue.assignee || "Unassigned") + '</span></div>') +
      '<label class="ep-issues__wizard-field">Status' +
        '<select name="status">' +
          statusChoicesFor(issue.status).map(function (choice) {
            return '<option value="' + escape(choice) + '"' +
              (status === choice ? " selected" : "") + ">" + escape(choice) +
              (choice === issue.status ? " (no change)" : "") + "</option>";
          }).join("") +
        '</select></label>' +
      '</div>' +
      '<label class="ep-issues__wizard-field">Issue details' +
        (state.isHead ? '<textarea name="problem" rows="3" maxlength="4000">' + escape(value("problem", issue.problem)) + '</textarea><small>Clear the text to remove the remark. Original text is retained in history.</small>' : '<span class="ep-issues__readonly">' + escape(issue.problem || 'No remark recorded.') + '</span>') + '</label>' +
      // Shown only when Resolved is chosen; date and closing remark are optional.
      '<fieldset class="ep-issues__wizard-field ep-issues__edit-resolution" data-issue-resolution' +
        (status === "Resolved" ? "" : " hidden") + '>' +
        '<legend>Resolution</legend>' +
        '<small>Resolved walks the ticket through the stages in between, so its history still reads correctly.</small>' +
        '<div class="ep-issues__wizard-fields ep-issues__wizard-fields--two">' +
          '<label class="ep-issues__wizard-field">Fixed on' +
            '<input name="fixedOn" type="date" value="' + escape(value("fixedOn", "")) + '" max="' + escape(todayISO()) + '" /></label>' +
          '<label class="ep-issues__wizard-field">Closing remark' +
            '<input name="resolutionRemark" value="' + escape(value("resolutionRemark", "")) + '" maxlength="4000" /></label>' +
        '</div>' +
        '<label class="ep-issues__wizard-field">Fix photos (optional, up to 10)' +
          '<input name="resolutionEvidence" type="file" accept="image/jpeg,image/png,image/webp" multiple /></label>' +
      '</fieldset>' +
      '<p class="ep-issues__wizard-error" data-issue-edit-error' +
        (state.submitError ? '' : ' hidden') + '>' + escape(state.submitError) + '</p>' +
      '<div class="ep-issues__wizard-actions ep-issues__edit-actions">' +
        '<button type="button" class="ep-issues__button" data-issue-action="close">Cancel</button>' +
        '<button type="submit" class="ep-issues__button ep-issues__button--primary"' +
          (state.submitting ? " disabled" : "") + '>' +
          (state.submitting ? "Saving…" : "Save changes") + '</button>' +
      '</div></form>';
  }

  function formatIssueDate(value) {
    if (!value) return "—";
    var parts = value.split("-");
    return parts.length === 3 ? parts[2] + "-" + parts[1] + "-" + parts[0].slice(2) : value;
  }

  function issueDetailsPreferenceKey() {
    var user = global.Solar91PortalAPI && global.Solar91PortalAPI.currentUser
      ? global.Solar91PortalAPI.currentUser() : null;
    return "solar91IssueDetailsExpanded:" + String(user && (user.id || user.email) || "anonymous");
  }

  function issueDetailsExpanded() {
    try {
      return global.localStorage.getItem(issueDetailsPreferenceKey()) === "true";
    } catch (error) {
      return false;
    }
  }

  function canConfirmClosure() {
    var user = global.Solar91PortalAPI && global.Solar91PortalAPI.currentUser
      ? global.Solar91PortalAPI.currentUser() : null;
    return !!user && user.role === "O&M Head";
  }

  function renderClosePanel() {
    var draft = state.closeDraft || { remark: "", resolved: "" };
    return '<form class="ep-issues__close-flow" data-issue-close-form>' +
      '<label>Remark <span aria-hidden="true">*</span>' +
        '<textarea name="remark" rows="3" maxlength="2000" required>' + escape(draft.remark) + '</textarea>' +
        '<small>Required · up to 2,000 characters.</small></label>' +
      '<label>Is the issue resolved? <span aria-hidden="true">*</span>' +
        '<select name="resolved" required><option value="">Choose Yes or No</option>' +
          '<option value="yes"' + (draft.resolved === "yes" ? " selected" : "") + '>Yes</option>' +
          '<option value="no"' + (draft.resolved === "no" ? " selected" : "") + '>No</option></select></label>' +
      '<p class="ep-issues__inline-error" data-issue-close-error role="alert"' +
        (state.closeError ? '' : ' hidden') + '>' + escape(state.closeError) + '</p>' +
      '<div class="ep-issues__drawer-actions">' +
        '<button type="button" class="ep-issues__button" data-issue-action="cancel-close">Cancel</button>' +
        '<button type="submit" class="ep-issues__button ep-issues__button--primary"' +
          (state.submitting ? " disabled" : "") + '>' +
          (state.submitting ? "Saving…" : "Continue") + '</button>' +
      '</div></form>';
  }

  function renderDetails(issue, closeMode) {
    var status = statusTone(issue.status);
    var request = issue.closure && issue.closure.closure_request || {};
    var pendingClosure = issue.status === "Pending Closure";
    var actions = "";
    if (pendingClosure && canConfirmClosure()) {
      actions = '<div class="ep-issues__drawer-actions">' +
        '<button type="button" class="ep-issues__button ep-issues__button--primary"' +
          ' data-issue-action="confirm-closure"' + (state.submitting ? " disabled" : "") +
          '>Confirm closure</button></div>' +
        '<div class="ep-issues__reject-remark"><label>Remark for sending back' +
          '<input type="text" maxlength="1000" data-closure-reject-remark value="' +
            escape(state.closureRejectRemark) + '" /></label>' +
          '<button type="button" class="ep-issues__button" data-issue-action="reject-closure"' +
            (state.submitting ? " disabled" : "") + '>Send back to In Progress</button></div>';
    } else if (pendingClosure) {
      actions = '<p class="ep-issues__drawer-note">Awaiting O&amp;M Head confirmation.</p>';
    } else if (canCloseIssue(issue)) {
      actions = '<div class="ep-issues__drawer-actions"><button type="button" ' +
        'class="ep-issues__button ep-issues__button--primary" data-issue-action="start-close"' +
        '>Close issue</button></div>';
    }
    return '<div class="ep-issues__drawer-content">' +
      '<div class="ep-issues__drawer-summary">' +
        '<div class="ep-issues__drawer-equipment">' + escape(issue.equipment) + '</div>' + pmSourceBadge(issue) +
        '<span class="ep-issues__status ep-issues__status--' + status + '">' +
          '<i></i>' + escape(issue.status) + '</span>' +
        '<p><strong>' + escape(issue.plantCode) + '</strong> · ' + escape(issue.plantName) + '</p>' +
        '<p class="ep-issues__drawer-description">' + escape(issue.problem || "No description recorded.") + '</p>' +
      '</div>' +
      (pendingClosure
        ? '<section class="ep-issues__closure-request"><h3>Closure requested by ' +
          escape(request.requested_by || "Assignee") + '</h3><p>' + escape(request.remark || "No remark recorded.") + '</p></section>'
        : "") +
      (pendingClosure && state.closeError
        ? '<p class="ep-issues__inline-error" role="alert">' + escape(state.closeError) + '</p>' : "") +
      (closeMode ? renderClosePanel() : actions) +
      (!closeMode && !pendingClosure
        ? '<details class="ep-issues__full-details" data-issue-full-details' +
          (issueDetailsExpanded() ? " open" : "") + '><summary>Edit full details</summary>' +
          '<dl class="ep-issues__fields">' +
            field("Category", issue.equipment) +
            field("Sub-problem", issue.subpart) +
            field("Serial number", issue.serialNo) +
            field("Maker / Supplier", issue.supplierMaker) +
            field("Number of units", issue.unitCount) +
            field("Occurrence date", issue.occurredAt ? formatIssueDate(issue.occurredAt) : "") +
            field("Expected time to close", issue.dueAt ? issue.dueAt.replace("T", " ") : "") +
            field("Reported", formatIssueDate(issue.reportedAt)) +
            field("Assigned to", issue.assignee || "Unassigned") +
            field("Severity", issue.severity) +
            field("Issue details", issue.problem) +
            field("Notes", issue.notes) +
          '</dl>' + renderIssuePhotos(issue) +
          (canEditIssue(issue) ? '<button type="button" class="ep-issues__button" data-issue-action="edit-current">Edit full details</button>' : "") +
        '</details>' : "") +
      (state.submitNotice ? '<p class="ep-issues__demo-note" role="status">' + escape(state.submitNotice) + '</p>' : "") +
      '</div>';
  }

  function field(label, value) {
    return "<div><dt>" + escape(label) + "</dt><dd>" + escape(value || "—") + "</dd></div>";
  }

  function createDraft(context) {
    return {
      plantCode: context.plantCode || state.plantFilter || "",
      equipment: "",
      subpart: "",
      serialNo: "",
      supplierMaker: "",
      unitCount: "",
      // Inverter-specific: null = not asked, true = Running, false = Breakdown.
      equipmentRunning: null,
      // Chosen unit numbers when Breakdown (array of 1-based integers); empty = not yet chosen.
      selectedUnits: [],
      occurredAt: localDate(new Date()),
      dueAt: "",
      problem: "",
      assignee: "",
      evidenceFiles: []
    };
  }

  function renderStepper() {
    var steps = ["Plant", "Classification", "Priority & details"];
    return '<ol class="ep-issues__stepper" aria-label="Issue capture steps">' +
      steps.map(function (step, index) {
        var number = index + 1;
        var className = number === state.wizardStep ? "is-current" : number < state.wizardStep ? "is-done" : "";
        return '<li class="' + className + '">' +
          '<span class="ep-issues__step-number">' + (number < state.wizardStep ? "✓" : number) + '</span>' +
          '<span>' + step + '</span>' +
          (number < steps.length ? '<i aria-hidden="true"></i>' : "") +
        '</li>';
      }).join("") + '</ol>';
  }

  function draftPlantName() {
    var plant = state.plants.find(function (item) { return item.siteCode === state.draft.plantCode; });
    return plant ? plantLabel(plant) + " · " + plant.displayCode : "";
  }

  function renderWizardPlant(context, draft) {
    if (context.plantCode) {
      return '<input type="hidden" name="plantCode" value="' + escape(context.plantCode) + '" />' +
        '<div class="ep-issues__readonly">' + escape(draftPlantName() || context.plantCode) + '</div>';
    }
    return '<select name="plantCode" required><option value="">Select plant</option>' +
      state.plants.map(function (plant) {
        return '<option value="' + escape(plant.siteCode) + '"' +
          (draft.plantCode === plant.siteCode ? " selected" : "") + ">" +
          escape(plantLabel(plant)) + " · " + escape(plant.displayCode) + "</option>";
      }).join("") + "</select>";
  }

  function renderEquipmentOptions(selected) {
    if (!CATEGORIES.length) {
      if (selected) {
        return '<option value="' + escape(selected) + '" selected>' + escape(selected) + ' (existing category)</option>';
      }
      return '<option value="">' + (state.categoryLoading ? "Loading categories…" :
        state.categoryError ? "Could not load categories" : "No categories configured yet") + '</option>';
    }
    var configured = categoryNames();
    var existing = selected && configured.indexOf(selected) === -1
      ? '<option value="' + escape(selected) + '" selected>Existing: ' + escape(selected) + '</option>'
      : "";
    return '<option value="">Select category</option>' + existing + categoryNames().map(function (name) {
      return '<option value="' + escape(name) + '"' +
        (selected === name ? " selected" : "") + ">" + escape(name) + "</option>";
    }).join("");
  }

  function renderSubpartOptions(selected, category) {
    // The sub-problems configured for the chosen category.
    var options = subProblemsFor(category);
    var existing = selected && options.indexOf(selected) === -1
      ? '<option value="' + escape(selected) + '" selected>Existing: ' + escape(selected) + '</option>'
      : "";
    if (!options.length) {
      return (existing || "") + '<option value="">(none recorded for this category)</option>';
    }
    return '<option value="">(none)</option>' + existing + options.map(function (item) {
      return '<option value="' + escape(item) + '"' +
        ((selected || "") === item ? " selected" : "") + ">" + escape(item) + "</option>";
    }).join("");
  }

  function renderWizardStepOne(context, draft) {
    return '<div class="ep-issues__wizard-step"><label class="ep-issues__wizard-field">Plant code' +
      renderWizardPlant(context, draft) + '</label>' +
      '<div class="ep-issues__wizard-actions"><span></span>' +
        '<button type="button" class="ep-issues__button ep-issues__button--primary" data-wizard-action="next">Next</button>' +
      '</div></div>';
  }

  function renderInverterRunningBlock(draft) {
    if (!hasEquipmentRunningStatus(draft.equipment)) return "";
    var equipLabel = String(draft.equipment || "Inverter").trim();
    var unitLabel = isStringEquipment(draft.equipment) ? "String" : "Unit";
    var unitPlural = isStringEquipment(draft.equipment) ? "strings" : "inverters";
    var isRunning = draft.equipmentRunning === true;
    var isBreakdown = draft.equipmentRunning === false;
    var totalUnits = configuredUnitCount(draft.plantCode, draft.equipment);
    var configPending = unitCacheFor(draft.equipment)[draft.plantCode] === undefined &&
      unitConfigIsLoading(draft.plantCode, draft.equipment);
    var unitSelectHtml = "";
    if (isBreakdown) {
      if (state.unitConfigError) {
        unitSelectHtml = '<p class="ep-issues__inline-error" role="alert">' +
          equipLabel + ' unit configuration could not be loaded: ' + escape(state.unitConfigError) +
          ' <button type="button" class="ep-issues__button ep-issues__button--small" ' +
            'data-issue-action="retry-unit-config">Retry</button></p>';
      } else if (configPending) {
        unitSelectHtml = '<p class="ep-issues__category-note" role="status">Loading ' + equipLabel.toLowerCase() + ' unit configuration…</p>';
      } else if (totalUnits > 0) {
        var options = "";
        for (var i = 1; i <= totalUnits; i++) {
          var sel = draft.selectedUnits.indexOf(i) !== -1 ? " selected" : "";
          options += '<option value="' + i + '"' + sel + '>' + unitLabel + ' ' + i + '</option>';
        }
        unitSelectHtml =
          '<label class="ep-issues__wizard-field ep-issues__wizard-field--required">' +
          'Which ' + unitPlural + ' are down? (select one or more)' +
          '<select name="breakdownUnits" multiple required size="' + Math.min(totalUnits, 6) + '">' +
          options + '</select>' +
          '<small>Hold Ctrl / ⌘ to select multiple. ' + totalUnits + ' ' + unitPlural + ' available for this plant.</small>' +
          '<small class="ep-issues__inline-error" data-breakdown-unit-error role="alert" hidden></small></label>';
      } else {
        unitSelectHtml =
          '<label class="ep-issues__wizard-field ep-issues__wizard-field--required">' +
          'Serial number of broken ' + equipLabel.toLowerCase() + ' (required for Breakdown)' +
          '<input name="serialNo" type="text" maxlength="120" required value="' + escape(draft.serialNo || "") +
          '" placeholder="Enter the affected equipment serial number" />' +
          '<small>No unit count is available for this plant; enter the serial number instead.</small>' +
          '<small class="ep-issues__inline-error" data-breakdown-serial-error role="alert" hidden></small></label>';
      }
    }
    return '<fieldset class="ep-issues__wizard-fieldset">' +
      '<legend class="ep-issues__wizard-field-label">Is the ' + equipLabel.toLowerCase() + ' running? <span class="ep-issues__required" aria-hidden="true">*</span></legend>' +
      '<div class="ep-issues__wizard-radio-row">' +
        '<label><input type="radio" name="equipmentRunning" value="running"' + (isRunning ? " checked" : "") + ' required /> Running</label>' +
        '<label><input type="radio" name="equipmentRunning" value="breakdown"' + (isBreakdown ? " checked" : "") + ' required /> Breakdown</label>' +
      '</div>' +
      '<small class="ep-issues__inline-error" data-breakdown-running-error role="alert" hidden></small>' +
      (isBreakdown ? unitSelectHtml : "") +
      '</fieldset>';
  }

  function renderWizardStepTwo(draft) {
    var hasRunningStatus = hasEquipmentRunningStatus(draft.equipment);
    var isBreakdown = hasRunningStatus && draft.equipmentRunning === false;
    // For other categories the serial/unitCount fields remain optional as before.
    // For Breakdown with unit config, serial is hidden (units are chosen via multi-select).
    // For Breakdown without unit config, serial is rendered inside renderInverterRunningBlock.
    var showLegacySerial = !isBreakdown;
    return '<div class="ep-issues__wizard-step"><label class="ep-issues__wizard-field">Issue vertical / category' +
      '<select name="equipment" required>' + renderEquipmentOptions(draft.equipment) + '</select>' +
      (CATEGORIES.length ? '' : '<small>Add them in Settings → Categories first.</small>') + '</label>' +
      '<label class="ep-issues__wizard-field">Sub-problem (optional)' +
        '<select name="subpart">' + renderSubpartOptions(draft.subpart, draft.equipment) + '</select>' +
        '<small>The fault for this category; describe the full problem separately in Issue details.</small>' +
      '</label>' +
      renderInverterRunningBlock(draft) +
      '<div class="ep-issues__wizard-fields ep-issues__wizard-fields--two">' +
        (showLegacySerial
          ? '<label class="ep-issues__wizard-field">Serial number of equipment' + (isBreakdown ? ' <span class="ep-issues__required" aria-hidden="true">*</span>(required)' : ' (optional)') +
            '<input name="serialNo" type="text" maxlength="120"' + (isBreakdown ? ' required' : '') + ' value="' + escape(draft.serialNo || "") +
            '" placeholder="e.g. INV-2023-004517" /></label>'
          : '<span></span>') +
        '<label class="ep-issues__wizard-field">Supplier / Maker (optional)' +
          '<input name="supplierMaker" type="text" maxlength="160" value="' + escape(draft.supplierMaker || "") +
          '" placeholder="Who made or supplied it" /></label>' +
      '</div>' +
      (isBreakdown ? '' :
        '<label class="ep-issues__wizard-field">Number of units (optional)' +
          '<input name="unitCount" type="number" min="1" max="100000" step="1" value="' +
          escape(draft.unitCount || "") + '" placeholder="How many units are affected" />' +
          '<small>How many units of this equipment the fault covers. Leave blank if it is not counted.</small>' +
        '</label>') +
      '<p class="ep-issues__wizard-error" data-wizard-step2-error role="alert" hidden></p>' +
      '<div class="ep-issues__wizard-actions"><button type="button" class="ep-issues__button" data-wizard-action="back">Back</button>' +
        '<button type="button" class="ep-issues__button ep-issues__button--primary" data-wizard-action="next">Next</button></div>' +
      '</div>';
  }

  function renderWizardStepThree(draft) {
    var assignees = assigneeOptions(draft.plantCode, draft.assignee);
    var assignmentField = state.isAssignee
      ? '<div class="ep-issues__wizard-field">Assigned to' +
          '<span class="ep-issues__readonly">Automatic by plant and equipment (you if no eligible owner)</span></div>'
      : '<label class="ep-issues__wizard-field">Assign to assignee (optional)' +
          '<select name="assignee"><option value="">Automatic by plant and equipment</option>' +
            (state.assigneesLoading ? '<option value="" disabled>Loading assignees…</option>' : "") +
            (state.liveMode ? assignees : ASSIGNEES.map(function (person) {
              return '<option value="' + escape(person) + '"' +
                (draft.assignee === person ? " selected" : "") + ">" + escape(person) + "</option>";
            }).join("")) + '</select>' +
          (state.assigneesError
            ? '<small class="ep-issues__inline-error" role="alert">Could not load assignees: ' +
              escape(state.assigneesError) +
              ' <button type="button" class="ep-issues__button ep-issues__button--small" data-issue-action="retry-assignees">Retry</button></small>'
            : "") + '</label>';
    return '<div class="ep-issues__wizard-step">' +
      '<div class="ep-issues__wizard-fields ep-issues__wizard-fields--two">' +
        '<label class="ep-issues__wizard-field">Expected time to close (optional)' +
          '<input name="dueAt" type="datetime-local" value="' + escape(draft.dueAt) + '" />' +
          '<small>Leave blank to use the configured deadline.</small></label>' +
        '<label class="ep-issues__wizard-field">Occurrence date<input name="occurredAt" type="date" required value="' +
          escape(draft.occurredAt) + '" /></label>' +
      '</div>' +
      '<label class="ep-issues__wizard-field">Issue details<textarea name="problem" required rows="4" maxlength="4000" placeholder="Describe the full problem observed">' +
        escape(draft.problem) + '</textarea>' +
        '<small>Include what happened and relevant symptoms; the subpart / fault area is selected separately.</small>' +
        '<small class="ep-issues__inline-error" data-breakdown-remark-error role="alert" hidden></small>' +
      '</label>' +
      '<div class="ep-issues__wizard-fields ep-issues__wizard-fields--evidence">' +
        '<div class="ep-issues__wizard-field">Evidence photos (up to ' + MAX_ISSUE_PHOTOS + ')' +
          '<span class="ep-field-camera-actions"><label class="ep-field-camera">Take photo<input name="evidence" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" aria-label="Take issue photo" /></label><label class="ep-field-camera">Choose photos<input name="evidence" type="file" accept="image/jpeg,image/png,image/webp" multiple aria-label="Choose issue photos" /></label></span>' +
          '<small>' + (draft.evidenceFiles.length
            ? draft.evidenceFiles.length + " photo" + (draft.evidenceFiles.length === 1 ? "" : "s") + " selected"
            : "No photos selected") + '</small><button type="button" class="ep-issues__button" data-issue-clear-draft-photos>Clear selected photos</button></div>' +
        assignmentField +
      '</div>' +
      '<p class="ep-issues__wizard-error" data-wizard-error role="alert"' +
        (state.submitError ? "" : " hidden") + '>' + escape(state.submitError) + '</p>' +
      '<div class="ep-issues__wizard-actions"><button type="button" class="ep-issues__button" data-wizard-action="back">Back</button>' +
        '<button type="submit" class="ep-issues__button ep-issues__button--primary"' +
          (state.submitting ? " disabled" : "") + '>' + (state.submitting ? "Saving…" : "Create ticket") + '</button></div>' +
      '</div>';
  }

  function renderRaiseWizard(context) {
    if (state.categoryError) {
      return '<div class="ep-issues__message ep-issues__message--error" role="alert">' +
        "Issue categories could not be loaded: " + escape(state.categoryError) +
        '<button type="button" class="ep-issues__button" data-issue-action="retry-categories">Try again</button>' +
        "</div>";
    }
    if (!state.draft) state.draft = createDraft(context);
    var stepContent = state.wizardStep === 1
      ? renderWizardStepOne(context, state.draft)
      : state.wizardStep === 2
        ? renderWizardStepTwo(state.draft)
        : renderWizardStepThree(state.draft);
    return '<form class="ep-issues__wizard" data-issue-form data-issue-wizard novalidate>' +
      renderStepper() + stepContent +
      '</form>';
  }

  function renderDrawer(context) {
    if (!state.modalMode) return "";
    var issue = state.rows.find(function (row) { return row.id === state.modalId; }) || null;
    var isForm = state.modalMode === "create" || state.modalMode === "edit";
    var isWizard = state.modalMode === "create";
    var title = isWizard ? "Raise issue ticket" :
      state.modalMode === "edit" ? "Edit " + ((issue && issue.id) || "issue") :
        state.modalMode === "close" ? "Close issue" : (issue && issue.id) || "Issue details";
    var ticketSubtitle = issue
      ? escape(issue.plantCode + (issue.plantName ? " · " + issue.plantName : ""))
      : "Saved Solar91 O&M ticket";
    return '<div class="ep-issues__overlay" data-issue-overlay>' +
      '<button type="button" class="ep-issues__backdrop" data-issue-action="close" aria-label="Close issue details"></button>' +
      '<aside class="ep-issues__drawer" role="dialog" aria-modal="true" aria-labelledby="issue-drawer-title">' +
        '<header class="ep-issues__drawer-head"><div>' +
          (isWizard ? "" : '<p>' + ticketSubtitle + '</p>') +
          '<h2 id="issue-drawer-title">' + escape(title) + '</h2></div>' +
          '<button type="button" class="ep-issues__drawer-x" data-issue-action="close" aria-label="Close">×</button></header>' +
        (isWizard
          ? '<div class="ep-issues__drawer-content">' + renderRaiseWizard(context) + '</div>'
          : isForm
          ? '<div class="ep-issues__drawer-content">' + renderEditForm(issue) + '</div>'
          : renderDetails(issue || {
          id: "Issue unavailable", plantCode: "", plantName: "", equipment: "", status: "Unhealthy",
          problem: "", reportedAt: "", reportedBy: "", assignee: "", notes: ""
        }, state.modalMode === "close")) +
      (isWizard ? '<footer class="ep-issues__drawer-footer"><button type="button" class="ep-issues__button" data-issue-action="close">Cancel</button></footer>' : "") +
      '</aside></div>';
  }

  function render(host, context) {
    if (!host) throw new Error("Site issues host element is missing.");
    context = context || {};
    var resetOwnerView = context.resetOwnerView && state.isAssignee && state.issueOwnerView !== "mine";
    if (resetOwnerView) {
      state.issueOwnerView = "mine";
      state.rows = [];
      state.modalId = "";
      state.modalMode = "";
      state.editDraft = null;
      state.columnFilters = {};
    }
    var previousScope = active ? active.context.plantCode || "" : null;
    var nextScope = context.plantCode || "";
    var previousRange = active
      ? (active.context.startDate || "") + ":" + (active.context.endDate || "")
      : null;
    var nextRange = (context.startDate || "") + ":" + (context.endDate || "");
    if (!active || previousScope !== nextScope || previousRange !== nextRange) {
      if (context.startDate || context.endDate) {
        state.issueMonth = context.startDate ? context.startDate.slice(0, 7) : "";
        state.issueDateStart = context.startDate || "";
        state.issueDateEnd = context.endDate || "";
        state.issueDateRangeMode = true;
      } else {
        state.issueMonth = localDate(new Date()).slice(0, 7);
        var defaultRange = monthPeriodRange(state.issueMonth, localDate(new Date()));
        state.issueDateStart = defaultRange.start;
        state.issueDateEnd = defaultRange.end;
        state.issueDatePeriod = "month";
        state.issueDateRangeMode = false;
      }
      state.issueDateDraftStart = state.issueDateStart;
      state.issueDateDraftEnd = state.issueDateEnd;
      state.issueDateError = "";
    }
    if (active && previousScope !== nextScope) {
      state.modalId = "";
      state.modalMode = "";
      state.draft = null;
      state.editDraft = null;
      state.wizardStep = 1;
      state.plantFilter = "";
      state.search = "";
      state.columnFilters = {};
      state.statusFilter = "Active";
      state.issuePhotos = {};
      state.photoBusy = {};
      state.photoError = "";
      state.selectedIssuePlantCode = "";
    }
    // Opened from the Overview's Inverters tile: that preset survives this render and
    // is shown as a removable chip, then cleared.
    if (pendingEquipment !== null) {
      state.equipmentFilter = pendingEquipment;
      pendingEquipment = null;
    }
    active = { host: host, context: context };
    wire(host);
    // Re-entering Health after more than 30 seconds refreshes a personal register,
    // so ownership transfers are not hidden indefinitely. Quick returns use the cached
    // rows; no polling and no extra request on the first visit.
    var refreshPersonal = context.resetOwnerView && state.isAssignee && state.loaded &&
      !state.loading && !state.submitting && !state.modalMode && Date.now() - state.loadedAt > 30000;
    if (resetOwnerView || refreshPersonal || ((state.loaded || state.loading) && state.scope !== nextScope)) {
      load();
    } else if (state.loaded) {
      renderView();
    } else if (state.loading) {
      renderView();
    } else {
      load();
    }
  }

  function renderView() {
    if (global.Solar91Perf && global.Solar91Perf.enabled) {
      return global.Solar91Perf.time("render issues", renderIssuesView);
    }
    renderIssuesView();
  }

  function renderDrawerOnly() {
    if (!active) return;
    var host = active.host;
    var oldOverlay = host.querySelector("[data-issue-overlay]");
    if (!state.modalMode) {
      if (oldOverlay) {
        oldOverlay.remove();
        var raiseButton = host.querySelector('[data-issue-action="raise"]');
        if (raiseButton) raiseButton.focus();
      }
      return;
    }

    var focused = global.document && global.document.activeElement;
    var restoreFocus = oldOverlay && focused && oldOverlay.contains(focused);
    var focusName = restoreFocus && focused.getAttribute ? focused.getAttribute("name") : null;
    var focusValue = restoreFocus && focused.getAttribute ? focused.getAttribute("value") : null;
    var focusAction = restoreFocus && focused.getAttribute
      ? focused.getAttribute("data-wizard-action") || focused.getAttribute("data-issue-action")
      : null;
    var content = oldOverlay && oldOverlay.querySelector(".ep-issues__drawer-content");
    var scrollTop = content ? content.scrollTop : 0;
    var markup = renderDrawer(active.context);
    if (oldOverlay) {
      oldOverlay.outerHTML = markup;
    } else {
      var root = host.querySelector(".ep-issues");
      if (!root) return renderView();
      root.insertAdjacentHTML("beforeend", markup);
    }

    var overlay = host.querySelector("[data-issue-overlay]");
    if (!overlay) return;
    var nextContent = overlay.querySelector(".ep-issues__drawer-content");
    if (nextContent) nextContent.scrollTop = scrollTop;
    if (!restoreFocus) {
      if (!oldOverlay) {
        var firstField = overlay.querySelector('select[name="plantCode"]') ||
          overlay.querySelector('[data-wizard-action="next"]') || overlay.querySelector("button");
        if (firstField) firstField.focus();
      }
      return;
    }
    var candidates = focusName ? overlay.querySelectorAll("[name]") : [];
    for (var index = 0; index < candidates.length; index++) {
      if (candidates[index].getAttribute("name") === focusName &&
          (focusValue === null || candidates[index].getAttribute("value") === focusValue)) {
        candidates[index].focus();
        return;
      }
    }
    if (focusAction) {
      var actions = overlay.querySelectorAll("[data-wizard-action], [data-issue-action]");
      for (var actionIndex = 0; actionIndex < actions.length; actionIndex++) {
        if (actions[actionIndex].getAttribute("data-wizard-action") === focusAction ||
            actions[actionIndex].getAttribute("data-issue-action") === focusAction) {
          actions[actionIndex].focus();
          return;
        }
      }
    }
  }

  function renderWizardView() {
    if (state.modalMode === "create") renderDrawerOnly();
    else renderView();
  }

  function renderIssuesView() {
    if (!active) return;
    var host = active.host;
    var context = active.context;
    var openCount = state.rows.filter(function (issue) {
      return matchesOwnerView(issue) && (!context.plantCode || issue.plantCode === context.plantCode) &&
        statusGroup(issue.status) !== "Solved";
    }).length;
    var rows = rowsFor(context);
    var unfilteredRows = rowsFor(context, true);
    var issueHeading = state.statusFilter === "Active" ? "Open Issues:"
      : state.statusFilter === "All" ? "Issues:" : escape(state.statusFilter) + " Issues:";
    var content = "";
    if (state.loading) {
      content = '<div class="ep-issues__message" role="status">' +
          "Loading saved issue tickets…" + '</div>';
    } else if (state.error) {
      content = '<div class="ep-issues__message ep-issues__message--error" role="alert">' +
          escape(state.error) +
          (global.Solar91PortalAPI && global.Solar91PortalAPI.isPortalRoute()
            ? ' <a href="/auth/login">Sign in to Solar91</a>' : "") +
          '<button type="button" data-issue-action="retry">Try again</button></div>';
    } else {
      content = '<section class="ep-issues__results"><div class="ep-issues__section-head">' +
            '<h2>' + issueHeading + ' <span>' + rows.length + '</span></h2>' +
            '<span>' + (state.statusFilter === "All" ? "All statuses"
              : state.statusFilter === "Active" ? "Open + in progress"
              : escape(state.statusFilter)) +
            (state.issueDateStart || state.issueDateEnd
              ? " · Occurred " + escape(state.issueDateStart || "any date") +
                " to " + escape(state.issueDateEnd || "any date")
              : "") +
            (state.liveMode && state.hasMore ? " · newest " + state.rows.length + " loaded" : "") + '</span></div>' +
          renderTable(rows) +
          (state.liveMode && state.hasMore
            ? '<div class="ep-issues__more"><span>Showing the ' + state.rows.length + ' newest issues' +
              (context.plantCode ? " for this plant" : "") + ' matching the date range. Other filters apply to loaded issues.</span>' +
              (state.moreError ? '<span class="ep-issues__more-error" role="alert">' + escape(state.moreError) + '</span>' : "") +
              '<button type="button" class="ep-issues__button" data-issue-action="more"' + (state.loadingMore ? " disabled" : "") + '>' +
              (state.loadingMore ? "Loading…" : "Load older issues") + '</button></div>'
            : "") +
          '</section>';
    }
    // On the merged plant page the range toggle, month picker, Raise issue, Export and Import sit
    // IN the "Health · N open" header rather than on a line of their own below it. The Views tab's
    // standalone Health page keeps the controls above its own body, as before.
    var headerControls = renderHeader(context);
    var issuesMarkup = '<div class="ep-issues">' +
      (context.plantDetailsMerged ? "" : headerControls) +
      '<div class="ep-issues__body">' +
        renderFilters(context, unfilteredRows) +
        content +
      '</div>' +
      renderDrawer(context) +
    '</div>';
    host.innerHTML = context.plantDetailsMerged
    ? '<section class="ep-pd__health-card"><header class="ep-pd__health-head">' +
        '<h2>Health</h2><span class="ep-pd__open-count">' + openCount + ' open</span>' +
        headerControls +
      '</header>' + issuesMarkup + '</section>'
    : issuesMarkup;
    refreshCompactCells(host);
    wireColumnFilterMenus(host);
    var fullDetails = host.querySelector("[data-issue-full-details]");
    if (fullDetails) {
      fullDetails.addEventListener("toggle", function () {
        try {
          global.localStorage.setItem(issueDetailsPreferenceKey(), fullDetails.open ? "true" : "false");
        } catch (error) {}
        if (fullDetails.open) loadIssuePhotos(state.modalId);
      });
      if (fullDetails.open) loadIssuePhotos(state.modalId);
    }
    // Thumbnails load as they come into view, never all at once with the page.
    if (photoEvidence()) photoEvidence().watch(host);
    var sort = host.querySelector('[data-issue-filter="sort"]');
    if (sort) sort.value = state.sort || "recent";
  }

  function load() {
    state.loading = true;
    state.error = "";
    state.scope = active ? (active.context.plantCode || "") : "";
    state.hasMore = false;
    state.nextOffset = 0;
    state.loadingMore = false;
    var requestId = ++state.requestId;
    state.liveMode = true;
    state.submitError = "";
    state.submitNotice = "";
    renderView();
    loadLiveIssues(requestId);
  }

  function loadCategoriesForWizard(host) {
    state.categoryLoading = true;
    state.categoryError = "";
    renderWizardView();
    loadCategories().then(function () {
      if (!active || active.host !== host || state.modalMode !== "create") return;
      state.categoryLoading = false;
      renderWizardView();
    }).catch(function (error) {
      if (!active || active.host !== host || state.modalMode !== "create") return;
      state.categoryLoading = false;
      state.categoryError = error.message || "Please try again.";
      renderWizardView();
    });
  }

  function loadAssigneesForDrawer(host) {
    if (state.assigneesLoaded || state.assigneesLoading) return;
    state.assigneesLoading = true;
    state.assigneesError = "";
    renderDrawerOnly();
    global.Solar91PortalAPI.request("/api/issues/assignees").then(function (rows) {
      state.assignees = Array.isArray(rows) ? rows : [];
      state.assigneesLoaded = true;
    }).catch(function (error) {
      state.assigneesError = (error && error.message) || "Please retry.";
    }).then(function () {
      state.assigneesLoading = false;
      if (active && active.host === host && state.modalMode) renderDrawerOnly();
    });
  }

  function loadCategoriesForEdit(host, issueId) {
    if (state.categoryLoading) return;
    state.categoryLoading = true;
    state.categoryError = "";
    renderDrawerOnly();
    loadCategories().then(function () {
      if (!active || active.host !== host || state.modalMode !== "edit" || state.modalId !== issueId) return;
      state.categoryLoading = false;
      renderDrawerOnly();
    }).catch(function (error) {
      if (!active || active.host !== host || state.modalMode !== "edit" || state.modalId !== issueId) return;
      state.categoryLoading = false;
      state.categoryError = error.message || "Configured categories could not be loaded.";
      renderDrawerOnly();
    });
  }

  function issuesUrl(offset) {
    var url = "/api/issues?limit=" + state.pageSize + "&offset=" + offset +
      (state.scope ? "&site_code=" + encodeURIComponent(state.scope) : "");
    if (state.isAssignee && state.issueOwnerView === "mine") url += "&mine=true";
    if (state.issueDateStart) {
      url += "&occurred_from=" + encodeURIComponent(state.issueDateStart + "T00:00:00Z");
    }
    if (state.issueDateEnd) {
      url += "&occurred_to=" + encodeURIComponent(state.issueDateEnd + "T23:59:59.999999Z");
    }
    return url;
  }

  // Next page of the same scope. Rows already shown are kept; an issue that moved between pages (a new one was raised
  // meanwhile) is not shown twice.
  function loadMoreIssues() {
    if (state.loadingMore || !state.hasMore) return;
    var requestId = state.requestId;
    state.loadingMore = true;
    state.moreError = "";
    renderView();
    global.Solar91PortalAPI.request(issuesUrl(state.nextOffset)).then(function (issues) {
      if (requestId !== state.requestId) return;
      var plantsById = {};
      state.plants.forEach(function (plant) { plantsById[plant.dbId] = plant; });
      var seen = {};
      state.rows.forEach(function (row) { seen[row.id] = true; });
      issues.forEach(function (issue) {
        var row = mapApiIssue(issue, plantsById);
        if (!seen[row.id]) state.rows.push(row);
      });
      state.nextOffset += issues.length;
      state.hasMore = issues.length >= state.pageSize;
      state.loadingMore = false;
      renderView();
    }).catch(function (error) {
      if (requestId !== state.requestId) return;
      state.loadingMore = false;
      state.moreError = "Older issues could not be loaded: " + (error.message || "please retry.");
      renderView();
    });
  }

  function loadLiveIssues(requestId) {
    var api = global.Solar91PortalAPI;
    api.session().then(function (session) {
      var role = session.user && session.user.role;
      if (requestId !== state.requestId) return null;
      var userId = String(session.user && session.user.id || "");
      if (state.currentUserId !== userId) state.issueOwnerView = "mine";
      state.currentUserId = userId;
      state.isAssignee = role === "Assignee";
      var requests = [
        api.plants(),
        api.request(issuesUrl(0))
      ];
      return Promise.all(requests).then(function (result) {
        return { role: role, plants: result[0], issues: result[1] };
      });
    }).then(function (result) {
      if (!result || requestId !== state.requestId) return;
      state.plants = result.plants;
      var plantsById = {};
      state.plants.forEach(function (plant) { plantsById[plant.dbId] = plant; });
      var linked = state.modalMode && state.rows.find(function (row) { return row.id === state.modalId; });
      state.rows = result.issues.map(function (issue) { return mapApiIssue(issue, plantsById); });
      if (linked && !state.rows.some(function (row) { return row.dbId === linked.dbId; })) state.rows.unshift(linked);
      state.nextOffset = result.issues.length;
      state.hasMore = result.issues.length >= state.pageSize;
      state.canRaise = ["O&M Head", "Assignee", "Site Engineer"].indexOf(result.role) !== -1 &&
        state.plants.length > 0;
      state.canEdit = ["O&M Head", "Assignee"].indexOf(result.role) !== -1;
      state.isHead = result.role === "O&M Head";
      state.isAssignee = result.role === "Assignee";
      state.liveMode = true;
      state.loaded = true;
      state.loadedAt = Date.now();
      state.loading = false;
      renderView();
    }).catch(function (error) {
      if (requestId !== state.requestId) return;
      state.loading = false;
      state.error = error.message || "Could not load saved issue tickets.";
      renderView();
    });
  }

  function wire(host) {
    if (wiredHost === host) return;
    wiredHost = host;
    host.addEventListener("input", function (event) {
      if (event.target.matches('[data-issue-close-form] [name="remark"]')) {
        state.closeDraft = state.closeDraft || { remark: "", resolved: "" };
        state.closeDraft.remark = event.target.value;
      }
      if (event.target.matches("[data-closure-reject-remark]")) {
        state.closureRejectRemark = event.target.value;
        state.closeError = "";
      }
      if (!active || active.host !== host) return;
      var editForm = event.target.closest("[data-issue-edit-form]");
      if (editForm) {
        syncIssueEditDraft(editForm);
        if (state.submitError) {
          state.submitError = "";
          var editError = editForm.querySelector("[data-issue-edit-error]");
          if (editError) editError.hidden = true;
        }
      }
      // (The unit-config Retry used to be handled here, in the *input* handler, where `action`
      // does not exist: every keystroke in the register threw, so the search box and the custom
      // date range below never ran. It is a button, so it now lives in the click handler.)
      if (event.target.matches("[data-issue-date-start]")) {
        state.issueDateDraftStart = event.target.value;
        state.issueDateError = "";
        return;
      }
      if (event.target.matches("[data-issue-date-end]")) {
        state.issueDateDraftEnd = event.target.value;
        state.issueDateError = "";
        return;
      }
      if (event.target.dataset.issueFilter === "search") {
        var pos = event.target.selectionStart;
        state.search = event.target.value;
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          searchTimer = null;
          if (!active || active.host !== host) return;
          renderView();
          var search = host.querySelector('[data-issue-filter="search"]');
          if (search) {
            search.focus();
            if (typeof search.setSelectionRange === "function") search.setSelectionRange(pos, pos);
          }
        }, 120);
      }
    });
    host.addEventListener("change", function (event) {
      if (event.target.matches('[data-issue-close-form] [name="resolved"]')) {
        state.closeDraft = state.closeDraft || { remark: "", resolved: "" };
        state.closeDraft.resolved = event.target.value;
      }
      if (!active || active.host !== host) return;
      if (event.target.matches("[data-issue-photo-file]")) {
        var picked = Array.prototype.slice.call(event.target.files || []);
        var ticket = event.target.dataset.issuePhotoFile;
        event.target.value = "";
        addIssuePhotos(ticket, picked);
        return;
      }
      var issueEditForm = event.target.closest("[data-issue-edit-form]");
      if (issueEditForm) syncIssueEditDraft(issueEditForm);
      if (event.target.matches("[data-issue-owner-view]")) {
        if (!state.isAssignee || state.submitting) return;
        state.issueOwnerView = event.target.value === "all" ? "all" : "mine";
        state.rows = [];
        state.modalId = "";
        state.modalMode = "";
        state.editDraft = null;
        state.columnFilters = {};
        load();
        return;
      }
      if (event.target.name === "assignmentMode" && state.modalMode === "edit") {
        var ownerField = issueEditForm && issueEditForm.querySelector("[data-edit-manual-owner]");
        if (ownerField) ownerField.hidden = event.target.value !== "manual";
        return;
      }
      if (event.target.matches("[data-issue-date-mode]")) {
        state.issueDateRangeMode = event.target.checked;
        state.issueDateError = "";
        renderView();
        return;
      }
      if (event.target.matches("[data-issue-date-period]")) {
        state.issueDatePeriod = event.target.value;
        var today = localDate(new Date());
        if (state.issueDatePeriod === "month" && !state.issueMonth) {
          state.issueMonth = today.slice(0, 7);
        }
        var range = state.issueDatePeriod === "month"
          ? monthPeriodRange(state.issueMonth, today)
          : datePeriodRange(state.issueDatePeriod, today);
        state.issueDateStart = range.start;
        state.issueDateEnd = range.end;
        state.issueDateDraftStart = range.start;
        state.issueDateDraftEnd = range.end;
        state.issueDateError = "";
        load();
        return;
      }
      if (event.target.matches("[data-issue-month]")) {
        var month = event.target.value;
        var today = localDate(new Date());
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > today.slice(0, 7)) {
          state.issueDateError = "Choose a month no later than the current month.";
          renderView();
          return;
        }
        state.issueMonth = month;
        state.issueDatePeriod = "month";
        state.issueDateRangeMode = false;
        var monthRange = monthPeriodRange(month, today);
        state.issueDateStart = monthRange.start;
        state.issueDateEnd = monthRange.end;
        state.issueDateDraftStart = monthRange.start;
        state.issueDateDraftEnd = monthRange.end;
        state.issueDateError = "";
        load();
        return;
      }
      if (event.target.matches("[data-issue-date-start]") ||
          event.target.matches("[data-issue-date-end]")) {
        if (event.target.matches("[data-issue-date-start]")) {
          state.issueDateDraftStart = event.target.value;
        } else {
          state.issueDateDraftEnd = event.target.value;
        }
        var dateStart = state.issueDateDraftStart;
        var dateEnd = state.issueDateDraftEnd;
        if (dateStart && dateEnd && dateStart > dateEnd) {
          state.issueDateError = "The start date must be on or before the end date.";
          renderView();
          return;
        }
        state.issueDateStart = dateStart;
        state.issueDateEnd = dateEnd;
        state.issueMonth = dateStart && dateEnd && dateStart.slice(0, 7) === dateEnd.slice(0, 7)
          ? dateStart.slice(0, 7) : "";
        state.issueDateError = "";
        load();
        return;
      }
      // Edit form: the resolution fields only apply when the ticket is being
      // resolved, so they appear with that choice and hide again otherwise.
      if (event.target.name === "status" && state.modalMode === "edit") {
        var statusForm = event.target.closest("[data-issue-edit-form]");
        var resolution = statusForm && statusForm.querySelector("[data-issue-resolution]");
        if (resolution) resolution.hidden = event.target.value !== "Resolved";
        return;
      }
      // Edit form: a new Equipment changes which sub-problems apply, so refill
      // that list in place rather than redrawing and losing what is typed.
      if (event.target.name === "equipment" && state.modalMode === "edit") {
        var editForm = event.target.closest("[data-issue-edit-form]");
        var subpartSelect = editForm && editForm.querySelector('[name="subpart"]');
        if (subpartSelect) {
          subpartSelect.innerHTML = renderSubpartOptions("", event.target.value);
          if (state.editDraft) state.editDraft.subpart = "";
        }
        return;
      }
      if (event.target.name === "plantCode" && state.modalMode === "create" && state.draft) {
        var plantWizard = host.querySelector("[data-issue-wizard]");
        if (plantWizard) syncWizardDraft(plantWizard);
        state.draft.selectedUnits = [];
        state.draft.serialNo = "";
        state.draft.unitCount = "";
        state.unitConfigError = "";
        var currentAssignee = state.assignees.find(function (person) {
          return String(person.id) === String(state.draft.assignee);
        });
        if (currentAssignee && !state.isHead &&
            (currentAssignee.plants || []).indexOf(state.draft.plantCode) === -1) {
          state.draft.assignee = "";
        }
        if (hasEquipmentRunningStatus(state.draft.equipment) && state.draft.plantCode) {
          requestUnitConfigForDraft(state.draft.plantCode, state.draft.equipment);
        }
        renderWizardView();
        if (state.wizardStep === 3 && direction === "next" && !state.isAssignee) {
          loadAssigneesForDrawer(host);
        }
        return;
      }
      if (event.target.name === "equipment" && state.modalMode === "create" && state.draft) {
        var currentWizard = host.querySelector("[data-issue-wizard]");
        if (currentWizard) syncWizardDraft(currentWizard);
        state.draft.equipment = event.target.value;
        state.draft.subpart = "";
        state.draft.equipmentRunning = null;
        state.draft.selectedUnits = [];
        state.draft.serialNo = "";
        state.draft.unitCount = "";
        state.unitConfigError = "";
        if (hasEquipmentRunningStatus(state.draft.equipment) && state.draft.plantCode) {
          requestUnitConfigForDraft(state.draft.plantCode, state.draft.equipment);
        }
        renderWizardView();
        return;
      }
      if (event.target.name === "equipmentRunning" && state.modalMode === "create" && state.draft) {
        var runWizard = host.querySelector("[data-issue-wizard]");
        if (runWizard) syncWizardDraft(runWizard);
        renderWizardView();
        return;
      }
      if (event.target.name === "evidence" && state.modalMode === "create" && state.draft) {
        var picked = Array.prototype.slice.call(event.target.files || []);
        if (!picked.length) return;
        var files = state.draft.evidenceFiles.concat(picked);
        var error = host.querySelector("[data-wizard-error]");
        var supportedTypes = ["image/jpeg", "image/png", "image/webp"];
        if (files.length > MAX_ISSUE_PHOTOS || files.some(function (file) { return supportedTypes.indexOf(file.type) === -1; })) {
          if (error) {
            error.textContent = files.length > MAX_ISSUE_PHOTOS
              ? "Select no more than " + MAX_ISSUE_PHOTOS + " photos."
              : "Evidence photos must be JPEG, PNG or WebP.";
            error.hidden = false;
          }
          event.target.value = "";
          return;
        }
        state.draft.evidenceFiles = files;
        renderWizardView();
        return;
      }
      var filter = event.target.dataset.issueFilter;
      if (filter === "plant") state.plantFilter = event.target.value;
      else if (filter === "sort") state.sort = event.target.value;
      else return;
      renderView();
    });
    host.addEventListener("click", function (event) {
      if (!active || active.host !== host) return;
      if (event.target.closest("[data-issue-clear-draft-photos]") && state.draft) { state.draft.evidenceFiles = []; renderWizardView(); return; }
      var compactToggle = event.target.closest("[data-compact-cell-toggle]");
      if (compactToggle) {
        var cell = compactToggle.closest("[data-compact-cell]");
        var content = cell && cell.querySelector("[data-compact-content]");
        if (!content) return;
        var expanded = compactToggle.getAttribute("aria-expanded") !== "true";
        content.classList.toggle("is-collapsed", !expanded);
        compactToggle.setAttribute("aria-expanded", String(expanded));
        compactToggle.textContent = expanded ? "Less" : "More";
        return;
      }
      var plantToggle = event.target.closest("[data-issue-plant-toggle]");
      if (plantToggle) {
        var plantCode = plantToggle.getAttribute("data-issue-plant-toggle");
        state.selectedIssuePlantCode = state.selectedIssuePlantCode === plantCode ? "" : plantCode;
        renderView();
        return;
      }
      if (event.target.closest("[data-issue-date-clear]")) {
        state.issueDateStart = "";
        state.issueDateEnd = "";
        state.issueDateDraftStart = "";
        state.issueDateDraftEnd = "";
        state.issueDatePeriod = "all";
        state.issueMonth = "";
        state.issueDateRangeMode = false;
        state.issueDateError = "";
        load();
        return;
      }
      var wizardAction = event.target.closest("[data-wizard-action]");
      if (wizardAction && state.modalMode === "create" && state.draft) {
        var currentForm = host.querySelector("[data-issue-wizard]");
        if (currentForm) syncWizardDraft(currentForm);
        var direction = wizardAction.dataset.wizardAction;
        if (direction === "back") {
          state.wizardStep = Math.max(1, state.wizardStep - 1);
        } else if (direction === "next") {
          if (state.wizardStep === 2 && hasEquipmentRunningStatus(state.draft.equipment)) {
            var equipmentLabel = isStringEquipment(state.draft.equipment) ? "string" : "inverter";
            var runningError = host.querySelector("[data-breakdown-running-error]");
            var unitError = host.querySelector("[data-breakdown-unit-error]");
            var serialError = host.querySelector("[data-breakdown-serial-error]");
            if (runningError) runningError.hidden = true;
            if (unitError) unitError.hidden = true;
            if (serialError) serialError.hidden = true;
            if (state.draft.equipmentRunning === null) {
              if (runningError) {
                runningError.textContent = "Choose whether the " + equipmentLabel + " is Running or in Breakdown.";
                runningError.hidden = false;
              }
              return;
            }
            if (state.draft.equipmentRunning === false) {
              var cache = unitCacheFor(state.draft.equipment);
              var configuredUnits = cache[state.draft.plantCode];
              if (configuredUnits === undefined) {
                var configError = host.querySelector("[data-wizard-step2-error]") || host.querySelector("[data-wizard-error]");
                if (configError) {
                  configError.textContent = state.unitConfigError
                    ? "Retry loading this plant's " + equipmentLabel + " unit count."
                    : "Wait for this plant's " + equipmentLabel + " unit count to finish loading.";
                  configError.hidden = false;
                }
                return;
              }
              if (configuredUnits > 0 && !state.draft.selectedUnits.length) {
                if (unitError) {
                  unitError.textContent = "Select at least one " + equipmentLabel + ".";
                  unitError.hidden = false;
                }
                return;
              }
              if (configuredUnits === 0 && !(state.draft.serialNo || "").trim()) {
                if (serialError) {
                  serialError.textContent = "Enter the serial number of the broken " + equipmentLabel + ".";
                  serialError.hidden = false;
                }
                return;
              }
            }
          }
          if (currentForm && !currentForm.reportValidity()) return;
          if (state.wizardStep === 1) {
            var selectedPlant = state.plants.some(function (plant) {
              return plant.siteCode === state.draft.plantCode;
            });
            if (!selectedPlant) {
              var plantError = host.querySelector("[data-wizard-error]");
              if (plantError) {
                plantError.textContent = "Select a plant to continue.";
                plantError.hidden = false;
              }
              return;
            }
          }
          if (state.wizardStep === 2 && !categoryNames().includes(state.draft.equipment)) {
            var equipmentError = host.querySelector("[data-wizard-step2-error]") || host.querySelector("[data-wizard-error]");
            if (equipmentError) {
              equipmentError.textContent = "Select an equipment category to continue.";
              equipmentError.hidden = false;
            }
            return;
          }
          state.wizardStep = Math.min(3, state.wizardStep + 1);
        }
        renderWizardView();
        return;
      }
      var status = event.target.closest("[data-issue-status]");
      if (status) {
        state.statusFilter = status.dataset.issueStatus;
        renderView();
        return;
      }
      var edit = event.target.closest("[data-issue-edit]");
      if (edit) {
        var selectedIssue = state.rows.find(function (row) { return row.id === edit.dataset.issueEdit; });
        if (!selectedIssue || !canEditIssue(selectedIssue)) return;
        state.modalId = edit.dataset.issueEdit;
        state.modalMode = "edit";
        state.editDraft = null;
        state.submitError = "";
        state.categoryError = "";
        state.categoryLoading = false;
        renderDrawerOnly();
        if (state.isHead) {
          loadCategoriesForEdit(host, state.modalId);
          loadAssigneesForDrawer(host);
        }
        return;
      }
      var open = event.target.closest("[data-issue-open]");
      if (open) {
        state.submitNotice = "";
        state.closeError = "";
        state.closeDraft = null;
        state.closureRejectRemark = "";
        state.modalId = open.dataset.issueOpen;
        state.modalMode = "details";
        state.editDraft = null;
        state.photoError = "";
        renderView();
        return;
      }
      var photoOpen = event.target.closest("[data-issue-photo-open]");
      if (photoOpen) {
        // The one place an original is fetched, and only because someone asked for it.
        var wanted = (state.issuePhotos[state.modalId] || []).find(function (photo) {
          return photo.id === photoOpen.dataset.issuePhotoOpen;
        });
        if (wanted && photoEvidence()) photoEvidence().open(wanted);
        return;
      }
      var photoRemove = event.target.closest("[data-issue-photo-remove]");
      if (photoRemove) {
        removeIssuePhoto(state.modalId, photoRemove.dataset.issuePhotoRemove);
        return;
      }
      // The shared Import / Export control handles its own clicks.
      if (global.Solar91RegisterIO && global.Solar91RegisterIO.handleClick(event, {
        siteCode: (active.context && active.context.plantCode) || "",
        onImported: function () { state.loaded = false; renderView(); }
      })) return;
      var sortButton = event.target.closest("[data-issue-sort]");
      if (sortButton) {
        global.Solar91PortalSort.next(state.columnSort, sortButton.getAttribute("data-issue-sort"));
        renderView();
        return;
      }
      var actionButton = event.target.closest("[data-issue-action]");
      if (!actionButton) return;
      var action = actionButton.dataset.issueAction;
      if (action === "start-close") {
        state.modalMode = "close";
        state.closeError = "";
        state.closeDraft = { remark: "", resolved: "" };
        renderView();
        return;
      }
      if (action === "cancel-close") {
        state.modalMode = "details";
        state.closeError = "";
        state.closeDraft = null;
        renderView();
        return;
      }
      if (action === "confirm-closure") {
        transitionPendingClosure("Closed");
        return;
      }
      if (action === "reject-closure") {
        transitionPendingClosure("In Progress");
        return;
      }
      if (action === "retry-photos") {
        retryIssuePhotos();
        return;
      }
      if (action === "retry-edit-categories") {
        if (state.modalMode === "edit") loadCategoriesForEdit(host, state.modalId);
        return;
      }
      if (action === "retry-assignees") {
        if (state.modalMode === "create" || state.modalMode === "edit") loadAssigneesForDrawer(host);
        return;
      }
      if (action === "retry-unit-config") {
        if (state.modalMode !== "create" || !state.draft) return;
        requestUnitConfigForDraft(state.draft.plantCode, state.draft.equipment);
        renderWizardView();
        return;
      }
      if (action === "more") {
        loadMoreIssues();
        return;
      }
      if (action === "raise") {
        if (!state.liveMode || !state.canRaise) return;
        state.submitError = "";
        state.submitNotice = "";
        state.categoryError = "";
        state.categoryLoading = false;
        state.modalId = "";
        state.modalMode = "create";
        state.wizardStep = 1;
        state.draft = createDraft(active.context);
        loadCategoriesForWizard(host);
        return;
      } else if (action === "retry-categories") {
        if (state.modalMode !== "create" || state.categoryLoading) return;
        loadCategoriesForWizard(host);
        return;
      } else if (action === "clear-equipment") {
        state.equipmentFilter = "";
        renderView();
        return;
      } else if (action === "clear") {
        state.search = "";
        state.plantFilter = "";
        state.equipmentFilter = "";
        state.columnFilters = {};
        state.statusFilter = "Active";
        state.issueDatePeriod = "all";
        state.issueMonth = "";
        state.issueDateRangeMode = false;
        var allDates = datePeriodRange("all", localDate(new Date()));
        state.issueDateStart = allDates.start;
        state.issueDateEnd = allDates.end;
        state.issueDateDraftStart = allDates.start;
        state.issueDateDraftEnd = allDates.end;
        state.issueDateError = "";
        load();
        return;
      } else if (action === "close") {
        if (state.submitting) return;
        var wasCreating = state.modalMode === "create";
        state.modalId = "";
        state.modalMode = "";
        state.submitNotice = "";
        state.draft = null;
        state.editDraft = null;
        state.wizardStep = 1;
        state.categoryLoading = false;
        state.categoryError = "";
        if (wasCreating) {
          renderDrawerOnly();
          return;
        }
      } else if (action === "retry") {
        state.loaded = false;
        load();
        return;
      } else if (action === "edit-current") {
        var currentIssue = state.rows.find(function (row) { return row.id === state.modalId; });
        if (!currentIssue || !canEditIssue(currentIssue)) return;
        state.modalMode = "edit";
        state.editDraft = null;
        renderDrawerOnly();
        if (state.isHead) {
          loadCategoriesForEdit(host, state.modalId);
          loadAssigneesForDrawer(host);
        }
        return;
      } else if (action === "progress" || action === "solve") {
        var current = state.rows.find(function (row) { return row.id === state.modalId; });
        if (current) current.status = action === "progress" ? "In Progress" : "Solved";
      }
      renderView();
    });
    host.addEventListener("submit", function (event) {
      if (!event.target.matches("[data-issue-form], [data-issue-close-form]") || !active) return;
      event.preventDefault();
      if (state.submitting) return;
      var form = event.target;
      if (form.hasAttribute("data-issue-close-form")) {
        if (!form.reportValidity()) return;
        var closeRemark = (form.elements.remark.value || "").trim();
        if (!closeRemark) {
          var closeError = form.querySelector("[data-issue-close-error]");
          if (closeError) {
            closeError.textContent = "Add a remark before continuing.";
            closeError.hidden = false;
          }
          form.elements.remark.focus();
          return;
        }
        submitIssueCloseFlow(form);
        return;
      }
      if (form.hasAttribute("data-issue-wizard")) {
        syncWizardDraft(form);
        if (state.wizardStep !== 3) return;
        var breakdown = hasEquipmentRunningStatus(state.draft.equipment) && state.draft.equipmentRunning === false;
        if (breakdown && !state.draft.problem.trim()) {
          var remarkError = form.querySelector("[data-breakdown-remark-error]");
          if (remarkError) {
            remarkError.textContent = "Add a remark for this Breakdown.";
            remarkError.hidden = false;
          }
          var problemField = form.elements.problem;
          if (problemField) problemField.focus();
          return;
        }
        if (!form.reportValidity()) return;
        if (!state.liveMode) {
          var previewError = form.querySelector("[data-wizard-error]");
          if (previewError) {
            previewError.textContent = "This preview cannot save tickets. Open /portal on the signed-in Solar91 O&M app.";
            previewError.hidden = false;
          }
          return;
        }
        var plant = state.plants.find(function (item) { return item.siteCode === state.draft.plantCode; });
        var problem = state.draft.problem.trim();
        var validationMessage = "";
        if (!plant) validationMessage = "Select a plant in step 1.";
        else if (!categoryNames().includes(state.draft.equipment)) validationMessage = "Select a category in step 2.";
        else if (!problem) validationMessage = "Add issue details before submitting.";
        if (validationMessage) {
          var wizardError = form.querySelector("[data-wizard-error]");
          if (wizardError) {
            wizardError.textContent = validationMessage;
            wizardError.hidden = false;
          }
          return;
        }
        submitLiveIssue(form);
        return;
      }
      if (form.hasAttribute("data-issue-edit-form")) {
        if (!form.reportValidity()) return;
        saveIssueEdit(form);
        return;
      }
      // Nothing else writes locally: tickets are created through submitLiveIssue
      // above, edited through saveIssueEdit, and the rest of the workflow
      // (progress, resolution, closing) stays in the main O&M app.
    });
    host.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && active && active.host === host && state.modalMode) {
        if (state.submitting) return;
        state.modalMode = "";
        state.modalId = "";
        state.draft = null;
        state.editDraft = null;
        state.wizardStep = 1;
        renderDrawerOnly();
      }
    });
  }

  function syncWizardDraft(form) {
    if (!state.draft || !form) return;
    var values = new FormData(form);
    ["plantCode", "equipment", "subpart", "serialNo", "supplierMaker", "unitCount",
      "occurredAt", "dueAt", "problem", "assignee"].forEach(function (name) {
      if (values.has(name)) state.draft[name] = String(values.get(name) || "");
    });
    // Inverter-specific fields.
    if (values.has("equipmentRunning")) {
      var runningVal = values.get("equipmentRunning");
      state.draft.equipmentRunning = runningVal === "running" ? true : runningVal === "breakdown" ? false : null;
    }
    // Multi-select unit checkboxes — getAll returns all selected options.
    if (form.elements.breakdownUnits) {
      state.draft.selectedUnits = values.getAll("breakdownUnits").map(Number).filter(Boolean);
    }
  }

  function applyCloseWorkflowResult(updated, successMessage) {
    var plantsById = {};
    state.plants.forEach(function (plant) { plantsById[plant.dbId] = plant; });
    var saved = mapApiIssue(updated, plantsById);
    var index = state.rows.findIndex(function (row) { return row.dbId === saved.dbId; });
    if (index !== -1) state.rows.splice(index, 1, saved);
    state.submitting = false;
    state.closeError = "";
    state.closeDraft = null;
    state.closureRejectRemark = "";
    state.modalMode = "details";
    state.modalId = saved.id;
    state.submitNotice = successMessage;
    renderView();
    invalidateOverviewData();
    var overview = global.Solar91PortalOverview;
    if (overview && overview.refreshInverterHealth) overview.refreshInverterHealth();
    if (overview && overview.refreshStringHealth) overview.refreshStringHealth();
  }

  function submitIssueCloseFlow(form) {
    var issue = state.rows.find(function (row) { return row.id === state.modalId; });
    if (!issue) {
      state.closeError = "This ticket is no longer in the list. Close and reopen the register.";
      renderView();
      return;
    }
    if (!state.liveMode) {
      state.closeError = "This preview cannot save changes. Open the signed-in Solar91 O&M app.";
      renderView();
      return;
    }
    var remark = String(form.elements.remark.value || "").trim();
    var resolved = form.elements.resolved.value === "yes";
    state.closeDraft = { remark: remark, resolved: resolved ? "yes" : "no" };
    state.submitting = true;
    state.closeError = "";
    renderView();
    global.Solar91PortalAPI.request("/api/issues/" + encodeURIComponent(issue.dbId) + "/close", {
      method: "POST",
      body: { remark: remark, resolved: resolved }
    }).then(function (updated) {
      var message = updated.status === "Pending Closure"
        ? "Closure request sent to the O&M Head."
        : updated.status === "Closed" ? "Issue closed." : "Issue marked Resolved.";
      applyCloseWorkflowResult(updated, message);
    }).catch(function (error) {
      state.submitting = false;
      state.closeError = error.message || "Could not close this issue.";
      renderView();
    });
  }

  function transitionPendingClosure(nextStatus) {
    var issue = state.rows.find(function (row) { return row.id === state.modalId; });
    if (!issue) {
      state.closeError = "This ticket is no longer in the list. Close and reopen the register.";
      renderView();
      return;
    }
    var note = nextStatus === "In Progress" ? state.closureRejectRemark.trim() : null;
    if (nextStatus === "In Progress" && !note) {
      state.closeError = "Add a remark before sending this issue back.";
      renderView();
      var remark = active.host.querySelector("[data-closure-reject-remark]");
      if (remark) remark.focus();
      return;
    }
    state.submitting = true;
    state.closeError = "";
    renderView();
    global.Solar91PortalAPI.request("/api/issues/" + encodeURIComponent(issue.dbId) + "/status", {
      method: "POST",
      body: { status: nextStatus, note: note }
    }).then(function (updated) {
      applyCloseWorkflowResult(updated, nextStatus === "Closed"
        ? "Closure confirmed." : "Issue sent back to In Progress.");
    }).catch(function (error) {
      state.submitting = false;
      state.closeError = error.message || "Could not update the closure request.";
      renderView();
    });
  }


  function syncIssueEditDraft(form) {
    if (!form) return;
    var draft = { id: form.dataset.issueEditForm };
    ["equipment", "subpart", "supplierMaker", "serialNo", "unitCount", "assignedTo", "assignmentMode", "status",
      "fixedOn", "resolutionRemark", "problem", "closeNote"]
      .forEach(function (name) {
        var control = form.elements[name];
        if (control) draft[name] = control.value;
      });
    state.editDraft = draft;
  }


  // ── Ticket photos ────────────────────────────────────────────────────────
  //
  // Evidence goes through the shared /api/photos pipeline rather than raw bytes:
  // each photo is downscaled in the browser (2048 px, WebP) before it is sent, stored
  // as WebP with a 480 px thumbnail, and its full-resolution original is purged after
  // the retention window while the thumbnail and the record remain. A list only ever
  // loads thumbnails, and only as they are scrolled to.

  function submissionIdFor() {
    var evidence = photoEvidence();
    return evidence ? evidence.submissionId() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
  }

  /**
   * Send a ticket's photos. The submission id makes this safe to repeat: the server
   * answers a repeat with the photos already saved instead of storing them twice, so a
   * retry after a dropped connection cannot double the storage bill.
   */
  function uploadIssuePhotos(issue, files, submissionId) {
    var evidence = photoEvidence();
    if (!evidence) {
      state.submitNotice = "Ticket saved. The photo uploader is still loading — open the ticket to add photos.";
      return Promise.resolve(null);
    }
    state.pendingPhotos = null;
    state.photoBusy[issue.id] = true;
    return evidence.upload({
      plantId: issue.plantId,
      category: "issue",
      linkType: "issue",
      linkId: issue.id,
      submissionId: submissionId,
      files: files
    }).then(function (result) {
      state.photoBusy[issue.id] = false;
      state.issuePhotos[issue.id] = (result && result.records) || [];
      // photo_count is kept by the server across linked photos and legacy evidence alike.
      // Take its number, and never guess one from this submission: a retry answers with the
      // photos of that submission only, which is not the ticket's total.
      if (result && typeof result.issue_photo_count === "number") {
        issue.photoCount = result.issue_photo_count;
      }
      if (result && result.storage_warning && isStorageAdministrator()) {
        state.submitNotice = result.storage_warning;
      }
      return result;
    }).catch(function (error) {
      state.photoBusy[issue.id] = false;
      // The ticket stays. Keep the same submission id so the retry is the same submission.
      state.pendingPhotos = {
        ticket: issue.id, plantId: issue.plantId,
        files: files, submissionId: submissionId
      };
      state.submitNotice = "Ticket " + issue.id + " was saved, but its photos did not upload: " +
        (error.message || "the upload failed") + " You can retry the photos.";
      return null;
    });
  }

  function retryIssuePhotos() {
    var pending = state.pendingPhotos;
    if (!pending) return;
    var issue = state.rows.find(function (row) { return row.id === pending.ticket; });
    if (!issue) {
      state.pendingPhotos = null;
      state.submitNotice = "That ticket is no longer in the list. Reopen the register and add its photos there.";
      renderView();
      return;
    }
    state.submitNotice = "Retrying the photo upload…";
    renderView();
    uploadIssuePhotos(issue, pending.files, pending.submissionId).then(function (result) {
      if (result) state.submitNotice = "Photos uploaded for " + issue.id + ".";
      renderView();
    });
  }

  function isStorageAdministrator() {
    var user = global.Solar91PortalAPI && global.Solar91PortalAPI.currentUser
      ? global.Solar91PortalAPI.currentUser() : null;
    return !!user && ["O&M Head", "Administration"].indexOf(user.role) !== -1;
  }

  /** The ticket's photos, thumbnails only. Loaded once per ticket opened. */
  function loadIssuePhotos(ticket) {
    if (!ticket || state.issuePhotos[ticket] || state.photoBusy[ticket]) return;
    if (!state.liveMode) return;
    state.photoBusy[ticket] = true;
    global.Solar91PortalAPI.request(
      "/api/photos?link=issue&link_id=" + encodeURIComponent(ticket) + "&window=all&meta=false&limit=" + MAX_ISSUE_PHOTOS
    ).then(function (result) {
      state.photoBusy[ticket] = false;
      state.issuePhotos[ticket] = (result && result.items) || [];
      renderView();
    }).catch(function (error) {
      state.photoBusy[ticket] = false;
      state.issuePhotos[ticket] = [];
      state.photoError = error.message || "The ticket's photos could not be loaded.";
      renderView();
    });
  }

  function addIssuePhotos(ticket, files) {
    var issue = state.rows.find(function (row) { return row.id === ticket; });
    if (!issue || !files.length) return;
    var already = (state.issuePhotos[ticket] || []).length;
    if (already + files.length > MAX_ISSUE_PHOTOS) {
      state.photoError = "A ticket carries at most " + MAX_ISSUE_PHOTOS + " photos; " +
        already + " are already attached.";
      renderView();
      return;
    }
    state.photoError = "";
    renderView();
    uploadIssuePhotos(issue, files, submissionIdFor()).then(function () {
      delete state.issuePhotos[ticket];
      loadIssuePhotos(ticket);
      renderView();
    });
  }

  function removeIssuePhoto(ticket, photoId) {
    if (!global.confirm("Remove this photo from " + ticket + "?")) return;
    state.photoBusy[ticket] = true;
    renderView();
    global.Solar91PortalAPI.request("/api/photos/" + encodeURIComponent(photoId), { method: "DELETE" })
      .then(function (result) {
        state.photoBusy[ticket] = false;
        state.issuePhotos[ticket] = (state.issuePhotos[ticket] || []).filter(function (photo) {
          return photo.id !== photoId;
        });
        var issue = state.rows.find(function (row) { return row.id === ticket; });
        if (issue && result && typeof result.issue_photo_count === "number") {
          issue.photoCount = result.issue_photo_count;
        }
        renderView();
      }).catch(function (error) {
        state.photoBusy[ticket] = false;
        state.photoError = error.message || "The photo could not be removed.";
        renderView();
      });
  }

  /** Thumbnails for the open ticket: lazy, with their own width/height so nothing shifts. */
  function renderIssuePhotos(issue) {
    var photos = state.issuePhotos[issue.id];
    var busy = state.photoBusy[issue.id];
    var canChange = canEditIssue(issue) && state.liveMode;
    var body;
    if (busy && !photos) {
      body = '<p class="ep-issues__photo-status" role="status">Loading photos…</p>';
    } else if (photos && photos.length) {
      body = '<div class="ep-issues__photo-grid">' + photos.map(function (photo) {
        return '<figure class="ep-issues__photo">' +
          '<button type="button" class="ep-issues__photo-open" data-issue-photo-open="' +
            escape(photo.id) + '" aria-label="Open photo ' + escape(photo.fileName || "") + '">' +
            '<img data-photo-src="' + escape(photo.thumbnailUrl) + '" loading="lazy" width="' +
              Math.max(1, Number(photo.width) || 480) + '" height="' +
              Math.max(1, Number(photo.height) || 360) + '" alt="Evidence photo" />' +
          '</button>' +
          (canChange
            ? '<button type="button" class="ep-issues__photo-remove" data-issue-photo-remove="' +
              escape(photo.id) + '" aria-label="Remove this photo">Remove</button>'
            : "") +
        '</figure>';
      }).join("") + '</div>';
    } else {
      body = '<p class="ep-issues__photo-status">No photos attached.</p>';
    }
    var room = MAX_ISSUE_PHOTOS - ((photos || []).length);
    return '<section class="ep-issues__photos"><h4>Evidence photos</h4>' + body +
      (state.photoError ? '<p class="ep-issues__photo-error" role="alert">' + escape(state.photoError) + '</p>' : "") +
      (canChange && room > 0
        ? '<label class="ep-issues__photo-add">+ Add photo' +
          '<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple' +
          ' data-issue-photo-file="' + escape(issue.id) + '" /></label>'
        : "") +
      (state.pendingPhotos && state.pendingPhotos.ticket === issue.id
        ? '<button type="button" class="ep-issues__button" data-issue-action="retry-photos">Retry photo upload</button>'
        : "") +
    '</section>';
  }

  function toUtcTimestamp(value, defaultTime) {
    if (!value) return null;
    var local = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value + "T" + (defaultTime || "09:00") + ":00+05:30"
      : value + (value.length === 16 ? ":00" : "") + "+05:30";
    var date = new Date(local);
    return isNaN(date.getTime()) ? null : date.toISOString();
  }

  /**
   * Save a correction to a stored ticket: PATCH /api/issues/{id}.
   *
   * Only the fields that actually changed are sent, so an edit never overwrites
   * something another person changed in the meantime. The API allows this for the
   * O&M Head on any ticket, and an Assignee on an open ticket of theirs.
   */
  function saveIssueEdit(form) {
    var api = global.Solar91PortalAPI;
    var issue = state.rows.find(function (row) { return row.dbId === form.dataset.issueEditForm; });

    function fail(message) {
      state.submitError = message;
      renderView();
    }
    if (state.submitting) return;
    if (!issue) return fail("This ticket is no longer in the list. Close and reopen the register.");
    if (!canEditIssue(issue)) return fail("You cannot edit this ticket.");
    if (!state.liveMode) return fail("This preview cannot save changes. Open the signed-in Solar91 O&M app.");

    syncIssueEditDraft(form);
    state.submitError = "";
    var read = function (name) { return (form.elements[name] && form.elements[name].value || "").trim(); };
    var units = parseInt(read("unitCount"), 10);
    var next = {
      vertical: state.isHead ? read("equipment") : issue.equipment,
      subcategory: state.isHead ? (read("subpart") || null) : (issue.subpart || null),
      supplier_maker: read("supplierMaker") || null,
      serial_no: read("serialNo") || null,
      unit_count: isNaN(units) ? null : units,
      description: state.isHead ? read("problem") : issue.problem
    };
    var before = {
      vertical: issue.equipment,
      subcategory: issue.subpart || null,
      supplier_maker: issue.supplierMaker || null,
      serial_no: issue.serialNo || null,
      unit_count: issue.unitCount === "" ? null : parseInt(issue.unitCount, 10),
      description: issue.problem
    };
    if (next.vertical !== before.vertical && !categoryNames().includes(next.vertical)) {
      return fail("Choose a configured category before changing the ticket category.");
    }
    var payload = {};
    Object.keys(next).forEach(function (key) {
      if (next[key] !== before[key]) payload[key] = next[key];
    });
    var base = "/api/issues/" + encodeURIComponent(issue.dbId);
    var nextStatus = read("status");
    var mode = read("assignmentMode");
    var ownerProtected = ["Closed", "Resolved", "Pending Closure"].indexOf(issue.status) !== -1;
    if (state.isHead) {
      if (ownerProtected && payload.vertical !== undefined) payload.assignment_mode = "retain";
      else if (mode === "manual") {
        if (!state.assigneesLoaded || !read("assignedTo")) return fail("Choose an active Assignee after the list loads.");
        payload.assignment_mode = "manual";
        payload.assigned_to = read("assignedTo");
      } else if (mode === "auto" || (mode === "on_change" && payload.vertical !== undefined)) {
        payload.assignment_mode = "auto";
      } else if (mode === "retain" && payload.vertical !== undefined) payload.assignment_mode = "retain";
    }
    if (Object.keys(payload).length && nextStatus && nextStatus !== issue.status) {
      return fail("Save the detail corrections first, then change the workflow status separately.");
    }
    var steps = [];
    if (Object.keys(payload).length) {
      steps.push(function () { return api.request(base, { method: "PATCH", body: payload }); });
    }
    if (nextStatus === "Resolved" && issue.status !== "Resolved") {
      var photoInput = form.elements.resolutionEvidence;
      var photos = photoInput && photoInput.files ? Array.prototype.slice.call(photoInput.files) : [];

      // Walk the stages in between first, so the transition the API expects is legal.
      (STEPS_BEFORE_RESOLVE[issue.status] || []).forEach(function (stage) {
        steps.push(function () {
          return api.request(base + "/status", { method: "POST", body: { status: stage } });
        });
      });
      steps.push(function () {
        // The resolve call needs the evidence ids this endpoint returns, so these photos still
        // post as files. They are downscaled first all the same: a fix photo costs the bucket
        // the same 2048px WebP as any other, not a 5 MB camera original.
        var evidence = photoEvidence();
        var ready = !photos.length
          ? Promise.resolve([])
          : (evidence ? evidence.prepare(photos)
            : Promise.resolve(photos.map(function (file) { return { blob: file, name: file.name }; })));
        return ready.then(function (prepared) {
          if (!prepared.length) return [];
          var files = new FormData();
          prepared.forEach(function (item) { files.append("files", item.blob, item.name); });
          return api.request(base + "/evidence", { method: "POST", body: files });
        }).then(function (uploaded) {
          return api.request(base + "/resolve", {
            method: "POST",
            body: {
              evidence_ids: (uploaded || []).map(function (entry) { return entry.id; }),
              fixed_on: read("fixedOn") || null,
              remark: read("resolutionRemark") || null,
            }
          });
        });
      });
    } else if (nextStatus && nextStatus !== issue.status) {
      steps.push(function () {
        return nextStatus === "Open"
          ? api.request(base + "/reset", { method: "POST", body: {} })
          : api.request(base + "/status", { method: "POST", body: { status: nextStatus } });
      });
    }
    if (!steps.length) {
      state.modalMode = "details";
      state.modalId = issue.id;
      state.editDraft = null;
      state.submitError = "";
      renderView();
      return;
    }

    state.submitting = true;
    renderView();
    steps.reduce(function (chain, step) {
      return chain.then(function (previous) {
        return step().then(function (result) { return result || previous; });
      });
    }, Promise.resolve(null))
      .then(function (updated) {
        var plantsById = {};
        state.plants.forEach(function (item) { plantsById[item.dbId] = item; });
        var saved = mapApiIssue(updated, plantsById);
        var index = state.rows.findIndex(function (row) { return row.dbId === saved.dbId; });
        if (index !== -1) state.rows.splice(index, 1, saved);
        state.submitting = false;
        state.submitError = "";
        state.editDraft = null;
        state.modalMode = "details";
        state.modalId = saved.id;
        state.submitNotice = saved.id + " updated.";
        renderView();
        invalidateOverviewData();
      })
      .catch(function (error) {
        state.submitting = false;
        renderView();
        fail(error.message || "Could not save these changes.");
      });
  }

  function submitLiveIssue(form) {
    var api = global.Solar91PortalAPI;
    var draft = state.draft;
    var plant = state.plants.find(function (item) { return item.siteCode === draft.plantCode; });
    if (!plant || !plant.dbId) {
      state.submitError = "The selected plant is not available in your authorized plant list.";
      renderWizardView();
      return;
    }

    state.submitting = true;
    state.submitError = "";
    renderWizardView();
    var equipmentDetails = issueEquipmentDetails(draft);
    var isBreakdown = hasEquipmentRunningStatus(draft.equipment) && draft.equipmentRunning === false;
    var payload = {
      plant_id: plant.dbId,
      vertical: draft.equipment,
      subcategory: draft.subpart || null,
      serial_no: equipmentDetails.serial_no,
      supplier_maker: (draft.supplierMaker || "").trim() || null,
      unit_count: equipmentDetails.unit_count,
      description: draft.problem.trim(),
      // Tickets raised here all carry the same priority, so the form no longer asks for one.
      // Medium is what the deadline defaults and notifications are keyed to.
      severity: "Medium",
      assigned_to: draft.assignee || null,
      occurred_at: toUtcTimestamp(draft.occurredAt, "09:00"),
      etc_at: draft.dueAt ? toUtcTimestamp(draft.dueAt) : null,
      photo_count: 0,
      equipment_running: equipmentDetails.equipment_running
    };

    api.request("/api/issues", { method: "POST", body: payload }).then(function (issue) {
      var plantsById = {};
      state.plants.forEach(function (item) { plantsById[item.dbId] = item; });
      var saved = mapApiIssue(issue, plantsById);
      var existing = state.rows.find(function (row) { return row.dbId === saved.dbId; });
      if (existing) state.rows.splice(state.rows.indexOf(existing), 1);
      state.rows.unshift(saved);
      invalidateOverviewData();
      if (isBreakdown) {
        var overview = global.Solar91PortalOverview;
        var eqLower = String(draft.equipment || "").trim().toLowerCase();
        if (eqLower === "string") {
          if (overview && overview.refreshStringHealth) overview.refreshStringHealth();
        } else {
          if (overview && overview.refreshInverterHealth) overview.refreshInverterHealth();
        }
      }
      if (!draft.evidenceFiles.length) return null;
      // The ticket is already saved. Photos go up separately, through the shared /api/photos
      // pipeline: downscaled in the browser, stored as WebP with a 480 px thumbnail, and
      // linked to the ticket by its number. If this fails the ticket still stands.
      return uploadIssuePhotos(saved, draft.evidenceFiles, submissionIdFor());
    }).then(function () {
      state.submitting = false;
      var saved = state.rows[0];
      state.modalMode = "details";
      state.modalId = saved.id;
      state.draft = null;
      state.wizardStep = 1;
      state.statusFilter = "Active";
      state.search = "";
      renderView();
      if (global.Solar91PortalToast && saved) {
        global.Solar91PortalToast.success(
          "Ticket " + saved.id + " created",
          saved.assignee
            ? "Assigned to " + saved.assignee + "."
            : "Not assigned yet: the O&M Head has been notified."
        );
      }
      // A new ticket notifies other people; refresh this user's own badge too.
      if (global.Solar91PortalNotifications) global.Solar91PortalNotifications.refresh();
    }).catch(function (error) {
      state.submitting = false;
      state.submitError = error.message || "Could not save this issue ticket.";
      if (global.Solar91PortalToast) {
        global.Solar91PortalToast.error("Ticket not saved", state.submitError);
      }
      renderWizardView();
    });
  }

  /**
   * Open the register showing one equipment category only. Set just before the page is
   * rendered (the Overview's Inverters tile does this), because `render` resets the
   * filters when the scope changes.
   */
  function presetEquipment(equipment) { pendingEquipment = equipment || ""; }

  function openTicket(ticketNo, siteCode, mode) {
    if (!active || !ticketNo) return;
    state.submitNotice = "";
    var opened = active;
    var url = "/api/issues/by-ticket/" + encodeURIComponent(ticketNo);
    Promise.all([
      global.Solar91PortalAPI.request(url),
      global.Solar91PortalAPI.plants()
    ]).then(function (result) {
      if (active !== opened || !opened.host.isConnected) return;
      var issue = result[0];
      state.plants = result[1];
      var plantsById = {};
      state.plants.forEach(function (plant) { plantsById[plant.dbId] = plant; });
      var mapped = mapApiIssue(issue, plantsById);
      state.rows = state.rows.filter(function (row) { return row.dbId !== mapped.dbId; });
      state.rows.unshift(mapped);
      state.modalId = mapped.id;
      state.modalMode = mode === "edit" && canEditIssue(mapped) ? "edit" : "details";
      state.editDraft = null;
      state.submitError = "";
      state.categoryError = "";
      state.categoryLoading = false;
      renderView();
      if (state.modalMode === "edit" && state.isHead) {
        loadCategoriesForEdit(active.host, state.modalId);
        loadAssigneesForDrawer(active.host);
      }
    }).catch(function (error) {
      if (active !== opened) return;
      state.submitNotice = "Could not open ticket " + ticketNo + ": " + (error.message || "please retry.");
      renderView();
    });
  }

  // A PM submission can create Site Issues while this page is not mounted.
  // Drop only this register's snapshot; the next navigation fetches it once.
  function invalidate() {
    state.loaded = false;
    state.loading = false;
    state.loadingMore = false;
    state.requestId += 1;
  }

  global.Solar91PortalIssues = {
    render: render,
    invalidate: invalidate,
    presetEquipment: presetEquipment,
    openTicket: openTicket
  };
}(window));