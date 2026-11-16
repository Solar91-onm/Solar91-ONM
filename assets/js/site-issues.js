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
  var STATUSES = ["Unhealthy", "In Progress", "Solved"];
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
  /**
   * Quick templates are derived from the configured categories and their
   * sub-problems: one button per category + sub-problem pair, so the list grows
   * with yours instead of being hard-coded.
   */
  function templates() {
    var out = [];
    CATEGORIES.forEach(function (category) {
      (category.sub_problems || []).slice(0, 3).forEach(function (sub) {
        out.push({ label: category.name + " · " + sub, equipment: category.name, subpart: sub, problem: sub });
      });
    });
    return out.slice(0, 8);
  }
  var pendingEquipment = null;
  var state = {
    rows: [],
    plants: [],
    loaded: false,
    loading: false,
    error: "",
    search: "",
    plantFilter: "",
    statusFilter: "All",
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
    hasMore: false,
    loadingMore: false,
    moreError: "",
    liveMode: false,
    canRaise: false,
    // Correcting a stored ticket: the O&M Head on any ticket, an Assignee on an
    // open ticket of theirs — the same pair PATCH /api/issues/{id} allows.
    canEdit: false,
    // Assigning and resetting to Open need issues.manage, so they are the Head's alone.
    isHead: false,
    assignees: [],
    submitError: "",
    submitNotice: "",
    submitting: false,
    // Photos for the ticket on screen, read from /api/photos (thumbnails only; the original
    // is fetched by the viewer on an explicit click). Keyed by ticket number.
    issuePhotos: {},
    photoBusy: {},
    photoError: "",
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
      status: issue.status,
      assignee: issue.assignee_text || "",
      reportedAt: String(issue.created_at || "").slice(0, 10),
      reportedBy: "",
      evidenceFiles: [],
      photoCount: Number(issue.photo_count || 0),
      notes: "",
      severity: issue.severity,
      live: true
    };
  }

  function rowsFor(context, ignoreStatus) {
    var rows = state.rows.filter(function (issue) {
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
      if (!ignoreStatus && state.statusFilter !== "All" && statusGroup(issue.status) !== state.statusFilter) return false;
      var term = state.search.trim().toLowerCase();
      if (!term) return true;
      return [
        issue.id, issue.plantCode, issue.plantName, issue.equipment,
        issue.supplierMaker, issue.serialNo, issue.problem, issue.status, issue.assignee
      ].join(" ").toLowerCase().indexOf(term) !== -1;
    });
    rows = rows.sort(function (a, b) {
      var dateOrder = state.sort === "oldest"
        ? a.reportedAt.localeCompare(b.reportedAt)
        : b.reportedAt.localeCompare(a.reportedAt);
      return dateOrder || STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.id.localeCompare(b.id);
    });
    // A column heading, once clicked, orders the register instead of the date.
    return state.columnSort.key
      ? global.Solar91PortalSort.apply(rows, state.columnSort, COLUMNS)
      : rows;
  }

  function countByStatus(rows, status) {
    return rows.filter(function (issue) { return statusGroup(issue.status) === status; }).length;
  }

  function statusGroup(status) {
    if (["Solved", "Resolved", "Closed"].indexOf(status) !== -1) return "Solved";
    if (["In Progress", "Pending Vendor", "Pending Parts/Vendor"].indexOf(status) !== -1) return "In Progress";
    return "Unhealthy";
  }

  function statusTone(status) {
    if (["Solved", "Resolved", "Closed"].indexOf(status) !== -1) return "solved";
    if (["In Progress", "Pending Vendor", "Pending Parts/Vendor"].indexOf(status) !== -1) return "progress";
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
    return '<div class="ep-issues__portfolio-actions">' + equipmentChip +
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

  function filterColumnOptions(menu, term) {
    var normalizedTerm = String(term || "").trim().toLowerCase();
    var visibleCount = 0;
    Array.prototype.forEach.call(menu.querySelectorAll("[data-issue-column-filter-option]"), function (option) {
      var visible = !normalizedTerm ||
        option.textContent.trim().toLowerCase().indexOf(normalizedTerm) !== -1;
      option.hidden = !visible;
      if (visible) visibleCount += 1;
    });
    var empty = menu.querySelector("[data-issue-column-filter-empty]");
    if (empty) empty.hidden = visibleCount > 0;
  }

  function positionColumnFilter(toggle, menu) {
    var toggleRect = toggle.getBoundingClientRect();
    var menuRect = menu.getBoundingClientRect();
    var left = Math.max(8, Math.min(toggleRect.left, global.innerWidth - menuRect.width - 8));
    var top = toggleRect.bottom + 4;
    if (top + menuRect.height > global.innerHeight - 8) {
      top = Math.max(8, toggleRect.top - menuRect.height - 4);
    }
    menu.style.left = Math.round(left) + "px";
    menu.style.top = Math.round(top) + "px";
  }

  var FILTERABLE_ISSUE_COLUMNS = ["plant", "equipment", "subpart", "maker", "problem", "assignee", "status"];

  function issueColumnHeader(column) {
    var header = global.Solar91PortalSort.thHTML(column, state.columnSort, "data-issue-sort");
    if (!state.canEdit || FILTERABLE_ISSUE_COLUMNS.indexOf(column.key) === -1) return header;

    var menuId = "ep-issue-filter-menu-" + column.key;
    var activeFilter = String(state.columnFilters[column.key] || "");
    var options = issueColumnOptions(column.key).map(function (value) {
      return '<button type="button" class="ep-issues__column-filter-option" data-issue-column-filter-option="' +
        column.key + '" data-issue-column-filter-value="' + escape(value) + '" aria-pressed="' +
        (activeFilter === value ? "true" : "false") + '">' + escape(value) + "</button>";
    }).join("");
    var filter = '<button type="button" class="ep-issues__filter-toggle' +
      (activeFilter ? " is-filtered" : "") + '" data-issue-column-filter-toggle="' + column.key +
      '" aria-label="Filter by ' + escape(column.label) + '" aria-controls="' + menuId +
      '" aria-expanded="false" title="Filter by ' + escape(column.label) + '">' +
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"></path></svg></button>' +
      '<div id="' + menuId + '" class="ep-issues__column-filter-menu" popover="auto" data-issue-column-filter-menu="' +
      column.key + '">' +
      '<input class="ep-issues__column-filter-search" type="search" data-issue-column-filter-search="' +
      column.key + '" placeholder="Search options..." aria-label="Search ' + escape(column.label) + ' options" />' +
      '<div class="ep-issues__column-filter-options">' +
      '<button type="button" class="ep-issues__column-filter-option" data-issue-column-filter-option="' +
      column.key + '" data-issue-column-filter-value="" aria-pressed="' +
      (activeFilter ? "false" : "true") + '">All ' + escape(column.label) + "</button>" +
      options + '</div><div class="ep-issues__column-filter-empty" data-issue-column-filter-empty hidden>' +
      "No matching options</div></div>";
    header = header.replace("<th", '<th class="ep-issues__th-filtered"');
    var openEnd = header.indexOf(">") + 1;
    var closeStart = header.lastIndexOf("</th>");
    return header.slice(0, openEnd) + '<div class="ep-issues__th-content">' +
      header.slice(openEnd, closeStart) + filter + "</div>" + header.slice(closeStart);
  }

  function wireColumnFilterMenus(host) {
    Array.prototype.forEach.call(host.querySelectorAll("[data-issue-column-filter-menu]"), function (menu) {
      var key = menu.getAttribute("data-issue-column-filter-menu");
      var toggle = host.querySelector('[data-issue-column-filter-toggle="' + key + '"]');
      menu.addEventListener("toggle", function () {
        var isOpen = menu.matches(":popover-open");
        if (toggle) toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
        if (isOpen) {
          var search = menu.querySelector("[data-issue-column-filter-search]");
          if (search) {
            search.value = "";
            filterColumnOptions(menu, "");
          }
        }
      });
    });
  }

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
    return '<div class="ep-issues__table-wrap"><table class="ep-issues__table"><thead><tr>' +
      COLUMNS.map(issueColumnHeader).join("") +
      '</tr></thead><tbody>' + rows.map(function (issue) {
        var labels = headers;
        return '<tr class="ep-issues__plant-row" data-issue-plant="' + escape(issue.plantCode) +
          '" tabindex="0" aria-label="Open Health for ' + escape(issue.plantName || issue.plantCode) + '">' +
          '<td data-label="' + labels[0] + '"><button type="button" class="ep-plantlink" data-open-plant="' +
            escape(issue.plantCode) + '" data-open-plant-page="health" title="Open Health for ' +
            escape(issue.plantName || issue.plantCode) + '"><strong>' + escape(issue.plantCode) + '</strong><small>' +
            escape(issue.plantName) + '</small></button></td>' +
          '<td data-label="' + labels[1] + '"><strong>' + escape(issue.equipment) + '</strong></td>' +
          '<td data-label="' + labels[2] + '">' + (issue.subpart
            ? escape(issue.subpart)
            : '<span class="ep-issues__unassigned">Not recorded</span>') + '</td>' +
          '<td data-label="' + labels[3] + '" class="ep-issues__problem">' + escape(issue.problem) + '</td>' +
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
          '<td data-label="' + labels[10] + '">' + (state.liveMode && !state.canEdit
            ? '<span aria-label="Manage this saved ticket in Solar91 O&M">Saved</span>'
            : '<button type="button" class="ep-issues__button ep-issues__button--small" data-issue-edit="' +
              escape(issue.id) + '">Edit</button>') + '</td>' +
        '</tr>';
      }).join("") + '</tbody></table></div>';
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

  function renderCloseAction(issue, closeNote) {
    if (!state.canEdit || !canCloseIssue(issue)) return "";
    var resolved = issue.status === "Resolved";
    return '<fieldset class="ep-issues__wizard-field ep-issues__close-action">' +
      '<legend>' + (resolved ? "Verify and close" : "Close directly") + '</legend>' +
      '<label class="ep-issues__wizard-field">Closure note' +
        '<textarea name="closeNote" rows="2" maxlength="4000"' +
          (resolved ? "" : " required") + '>' + escape(closeNote || "") + '</textarea>' +
        '<small>' + (resolved
          ? "Confirm that the resolved ticket can be closed."
          : "A reason is required. This closes the ticket without the resolution workflow; unsaved form edits are not included.") + '</small></label>' +
      '<button type="button" class="ep-issues__button ep-issues__button--primary" data-issue-action="close-ticket" data-direct-close="' +
        (resolved ? "false" : "true") + '"' + (state.submitting ? " disabled" : "") + '>' +
        (resolved ? "Verify & close ticket" : "Close ticket") + '</button>' +
    '</fieldset>';
  }

  /** Today as YYYY-MM-DD, so a fix cannot be dated in the future. */
  function todayISO() {
    var now = new Date();
    return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") +
      "-" + String(now.getDate()).padStart(2, "0");
  }

  /** The edit form: the stored details of one ticket, corrected in place. */
  function renderEditForm(issue) {
    if (!issue) return '<p class="ep-issues__empty">This ticket is no longer in the list.</p>';
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
    return '<form class="ep-issues__wizard" data-issue-form data-issue-edit-form="' + escape(issue.dbId) + '">' +
      '<p class="ep-issues__wizard-info"><strong>' + escape(issue.id) + '</strong> · ' +
        escape(issue.plantCode) + ' ' + escape(issue.plantName) + '</p>' +
      '<label class="ep-issues__wizard-field">Equipment / category' +
        '<select name="equipment">' + renderEquipmentOptions(equipment) + '</select></label>' +
      (state.categoryLoading
        ? '<p class="ep-issues__category-note" role="status">Loading configured categories…</p>'
        : state.categoryError
          ? '<p class="ep-issues__category-note ep-issues__category-error" role="alert">Could not load configured categories. The ticket’s existing category is preserved. ' +
            '<button type="button" class="ep-issues__button ep-issues__button--small" data-issue-action="retry-edit-categories">Retry</button></p>'
          : !CATEGORIES.length
            ? '<p class="ep-issues__category-note">No categories were returned by Settings → Categories. The ticket’s existing category is preserved.</p>'
            : "") +
      '<label class="ep-issues__wizard-field">Sub-problem' +
        '<select name="subpart">' + renderSubpartOptions(subpart, equipment) + '</select>' +
        '<small>The fault for this category, the same list the Raise issue form offers.</small></label>' +
      field("supplierMaker", "Maker / Supplier", value("supplierMaker", issue.supplierMaker), 'maxlength="160"') +
      field("serialNo", "Serial number", value("serialNo", issue.serialNo), 'maxlength="120"') +
      field("unitCount", "Units", value("unitCount", issue.unitCount), 'type="number" min="1" max="100000"') +
      // No severity field. Raise issue does not ask for one either (every ticket is
      // filed as Medium), so the register does not offer a way to diverge from that.
      // Where a ticket stands is its Status, not its severity.
      // Assigning is the O&M Head's call: /assign and /reassign both require
      // issues.manage, so an Assignee sees who holds the ticket but cannot move it.
      (state.isHead
        ? '<label class="ep-issues__wizard-field">Assigned to' +
            '<select name="assignedTo">' +
              '<option value="">Unassigned</option>' +
              state.assignees.map(function (person) {
                return '<option value="' + escape(person.id) + '"' +
                  (value("assignedTo", issue.assignedTo) === String(person.id) ? " selected" : "") + ">" +
                  escape(person.name) + "</option>";
              }).join("") +
            '</select></label>'
        : '<p class="ep-issues__wizard-info">Assigned to <strong>' +
            escape(issue.assignee || "nobody") + '</strong> · only the O&amp;M Head can change this.</p>') +
      '<label class="ep-issues__wizard-field">Status' +
        '<select name="status">' +
          statusChoicesFor(issue.status).map(function (choice) {
            return '<option value="' + escape(choice) + '"' +
              (status === choice ? " selected" : "") + ">" + escape(choice) +
              (choice === issue.status ? " (no change)" : "") + "</option>";
          }).join("") +
        '</select>' +
        '<small>A ticket moves one step at a time; choosing Resolved walks it ' +
          'through the stages in between, so its history still reads correctly.</small></label>' +
      // Shown only when Resolved is chosen. These are what the API stores as the
      // resolution, and it will not accept the transition without them.
      '<fieldset class="ep-issues__wizard-field" data-issue-resolution' +
        (status === "Resolved" ? "" : " hidden") + '>' +
        '<legend>Resolution</legend>' +
        '<label class="ep-issues__wizard-field">Root cause' +
          '<textarea name="rootCause" rows="2" maxlength="4000">' + escape(value("rootCause", "")) + '</textarea></label>' +
        '<label class="ep-issues__wizard-field">Corrective action' +
          '<textarea name="correctiveAction" rows="2" maxlength="4000">' + escape(value("correctiveAction", "")) + '</textarea></label>' +
        '<label class="ep-issues__wizard-field">Fixed on' +
          '<input name="fixedOn" type="date" value="' + escape(value("fixedOn", "")) + '" max="' + escape(todayISO()) + '" /></label>' +
        '<label class="ep-issues__wizard-field">Closing remark' +
          '<input name="resolutionRemark" value="' + escape(value("resolutionRemark", "")) + '" maxlength="4000" /></label>' +
        '<label class="ep-issues__wizard-field">Fix photos' +
          '<input name="resolutionEvidence" type="file" accept="image/jpeg,image/png,image/webp" multiple />' +
          '<small>At least one photo of the completed fix is required, up to 10.</small></label>' +
      '</fieldset>' +
      '<label class="ep-issues__wizard-field">Issue details' +
        '<textarea name="problem" required rows="4" maxlength="4000">' + escape(value("problem", issue.problem)) + '</textarea></label>' +
      '<label class="ep-issues__wizard-field">Reason for the change' +
        '<input name="changeReason" value="' + escape(value("changeReason", "")) + '" maxlength="500" placeholder="Why the ticket is being corrected (optional)" /></label>' +
      renderCloseAction(issue, value("closeNote", "")) +
      '<p class="ep-issues__wizard-error" data-issue-edit-error' +
        (state.submitError ? '' : ' hidden') + '>' + escape(state.submitError) + '</p>' +
      '<div class="ep-issues__wizard-actions">' +
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

  function renderDetails(issue) {
    return '<div class="ep-issues__drawer-content">' +
      '<div class="ep-issues__drawer-status ep-issues__drawer-status--' + statusTone(issue.status) + '">' +
        '<strong>' + escape(issue.equipment) + '</strong><span>' + escape(issue.id) + " · " +
          escape(formatIssueDate(issue.reportedAt)) + '</span></div>' +
      '<span class="ep-issues__status ep-issues__status--' + statusTone(issue.status) + '">' +
        '<i></i>' + escape(issue.status) + '</span>' +
      '<dl class="ep-issues__fields">' +
        field("Plant", issue.plantName) +
        field("Site code", issue.plantCode) +
        field("Category", issue.equipment) +
        field("Subpart / fault area", issue.subpart) +
        field("Supplier / Maker", issue.supplierMaker) +
        field("Serial number", issue.serialNo) +
        field("Number of units", issue.unitCount) +
        field("Occurrence date", issue.occurredAt ? formatIssueDate(issue.occurredAt) : "") +
        field("Expected time to close", issue.dueAt ? issue.dueAt.replace("T", " ") : "") +
        field("Reported", formatIssueDate(issue.reportedAt)) +
        field("Reported by", issue.reportedBy) +
        field("Assigned to", issue.assignee || "Unassigned") +
        // Severity is not shown: every ticket is filed as Medium, so it carried no
        // information. Status is what says where a ticket stands.
        field("Status", issue.status) +
        field("Issue details", issue.problem) +
        field("Notes", issue.notes) +
      '</dl>' + renderIssuePhotos(issue) + '<p class="ep-issues__demo-note">' +
        "Saved to Solar91 O&M. Use the main O&M app for ticket updates and workflow actions." +
        (state.submitNotice ? " " + escape(state.submitNotice) : "") + '</p>' +
      '</div><footer class="ep-issues__drawer-footer">' +
      '</footer>';
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
      '<div class="ep-issues__wizard-info"><strong>What you will add</strong>' +
        '<span>Issue category and fault area</span><span>Issue priority and details</span>' +
        '<span>Optional evidence photos and assignee</span>' +
      '</div><div class="ep-issues__wizard-actions"><span></span>' +
        '<button type="button" class="ep-issues__button ep-issues__button--primary" data-wizard-action="next">Next</button>' +
      '</div></div>';
  }

  function renderWizardStepTwo(draft) {
    return '<div class="ep-issues__wizard-step"><label class="ep-issues__wizard-field">Issue vertical / category' +
      '<select name="equipment" required>' + renderEquipmentOptions(draft.equipment) + '</select>' +
      (CATEGORIES.length ? '' : '<small>Add them in Settings → Categories first.</small>') + '</label>' +
      '<label class="ep-issues__wizard-field">Sub-problem (optional)' +
        '<select name="subpart">' + renderSubpartOptions(draft.subpart, draft.equipment) + '</select>' +
        '<small>The fault for this category; describe the full problem separately in Issue details.</small>' +
      '</label>' +
      '<div class="ep-issues__wizard-fields ep-issues__wizard-fields--two">' +
        '<label class="ep-issues__wizard-field">Serial number of equipment (optional)' +
          '<input name="serialNo" type="text" maxlength="120" value="' + escape(draft.serialNo || "") +
          '" placeholder="e.g. INV-2023-004517" /></label>' +
        '<label class="ep-issues__wizard-field">Supplier / Maker (optional)' +
          '<input name="supplierMaker" type="text" maxlength="160" value="' + escape(draft.supplierMaker || "") +
          '" placeholder="Who made or supplied it" /></label>' +
      '</div>' +
      '<label class="ep-issues__wizard-field">Number of units (optional)' +
        '<input name="unitCount" type="number" min="1" max="100000" step="1" value="' +
        escape(draft.unitCount || "") + '" placeholder="How many units are affected" />' +
        '<small>How many units of this equipment the fault covers. Leave blank if it is not counted.</small>' +
      '</label>' +
      (templates().length
        ? '<div class="ep-issues__template-area"><strong>Quick templates — 1 click fills category, sub-problem and description</strong>' +
          '<div>' + templates().map(function (template, index) {
            return '<button type="button" data-issue-template="' + index + '">' + escape(template.label) + '</button>';
          }).join("") + '</div></div>'
        : "") +
      '<div class="ep-issues__wizard-actions"><button type="button" class="ep-issues__button" data-wizard-action="back">Back</button>' +
        '<button type="button" class="ep-issues__button ep-issues__button--primary" data-wizard-action="next">Next</button></div>' +
      '</div>';
  }

  function renderWizardStepThree(draft) {
    return '<div class="ep-issues__wizard-step">' +
      '<div class="ep-issues__wizard-fields ep-issues__wizard-fields--two">' +
        '<label class="ep-issues__wizard-field">Expected time to close (optional)' +
          '<input name="dueAt" type="datetime-local" value="' + escape(draft.dueAt) + '" />' +
          '<small>Leave blank to use the configured deadline.</small></label>' +
        '<label class="ep-issues__wizard-field">Occurrence date<input name="occurredAt" type="date" required value="' +
          escape(draft.occurredAt) + '" /></label>' +
      '</div>' +
      '<label class="ep-issues__wizard-field">Issue details<textarea name="problem" required rows="4" placeholder="Describe the full problem observed">' +
        escape(draft.problem) + '</textarea>' +
        '<small>Include what happened and relevant symptoms; the subpart / fault area is selected separately.</small>' +
      '</label>' +
      '<div class="ep-issues__wizard-fields ep-issues__wizard-fields--evidence">' +
        '<label class="ep-issues__wizard-field">Evidence photos (up to ' + MAX_ISSUE_PHOTOS + ')' +
          '<input name="evidence" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple />' +
          '<small>' + (draft.evidenceFiles.length
            ? draft.evidenceFiles.length + " photo" + (draft.evidenceFiles.length === 1 ? "" : "s") + " selected"
            : "No photos selected") + '</small></label>' +
        '<label class="ep-issues__wizard-field">Assign to assignee (optional)' +
          '<select name="assignee"><option value="">Leave unassigned</option>' +
            (state.liveMode ? state.assignees.map(function (person) {
              return '<option value="' + escape(person.id) + '"' +
                (draft.assignee === person.id ? " selected" : "") + ">" + escape(person.name) + "</option>";
            }).join("") : ASSIGNEES.map(function (person) {
              return '<option value="' + escape(person) + '"' +
                (draft.assignee === person ? " selected" : "") + ">" + escape(person) + "</option>";
            }).join("")) + '</select></label>' +
      '</div>' +
      '<p class="ep-issues__wizard-error" data-wizard-error role="alert"' +
        (state.submitError ? "" : " hidden") + '>' + escape(state.submitError) + '</p>' +
      '<div class="ep-issues__wizard-actions"><button type="button" class="ep-issues__button" data-wizard-action="back">Back</button>' +
        '<button type="submit" class="ep-issues__button ep-issues__button--primary"' +
          (state.submitting ? " disabled" : "") + '>' + (state.submitting ? "Saving…" : "Create ticket") + '</button></div>' +
      '</div>';
  }

  function renderRaiseWizard(context) {
    if (state.categoryLoading) {
      return '<div class="ep-issues__message" role="status">Loading issue categories…</div>';
    }
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
        '<p class="ep-issues__wizard-demo-note">' +
          "This ticket will be saved against the selected plant." +
        '</p>' +
      '</form>';
  }

  function renderDrawer(context) {
    if (!state.modalMode) return "";
    var issue = state.rows.find(function (row) { return row.id === state.modalId; }) || null;
    var isForm = state.modalMode === "create" || state.modalMode === "edit";
    var isWizard = state.modalMode === "create";
    var title = isWizard ? "Raise issue ticket" :
      state.modalMode === "edit" ? "Edit issue" : "Issue details";
    return '<div class="ep-issues__overlay" data-issue-overlay>' +
      '<button type="button" class="ep-issues__backdrop" data-issue-action="close" aria-label="Close issue details"></button>' +
      '<aside class="ep-issues__drawer" role="dialog" aria-modal="true" aria-labelledby="issue-drawer-title">' +
        '<header class="ep-issues__drawer-head"><div><p>' +
          (isWizard ? "Step-by-step issue capture · Ticket ID and timestamp are generated only when you submit" :
            "Saved Solar91 O&M ticket") +
          '</p>' +
          '<h2 id="issue-drawer-title">' + title + '</h2></div>' +
          '<button type="button" class="ep-issues__drawer-x" data-issue-action="close" aria-label="Close">×</button></header>' +
        (isWizard
          ? '<div class="ep-issues__drawer-content">' + renderRaiseWizard(context) + '</div>'
          : isForm
          ? '<div class="ep-issues__drawer-content">' + renderEditForm(issue) + '</div>'
          : renderDetails(issue || {
          id: "Issue unavailable", plantCode: "", plantName: "", equipment: "", status: "Unhealthy",
          problem: "", reportedAt: "", reportedBy: "", assignee: "", notes: ""
        })) +
      (isWizard ? '<footer class="ep-issues__drawer-footer"><button type="button" class="ep-issues__button" data-issue-action="close">Cancel</button></footer>' : "") +
      '</aside></div>';
  }

  function render(host, context) {
    if (!host) throw new Error("Site issues host element is missing.");
    context = context || {};
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
      state.statusFilter = "All";
      state.issuePhotos = {};
      state.photoBusy = {};
      state.photoError = "";
    }
    // Opened from the Overview's Inverters tile: that preset survives this render and
    // is shown as a removable chip, then cleared.
    if (pendingEquipment !== null) {
      state.equipmentFilter = pendingEquipment;
      pendingEquipment = null;
    }
    active = { host: host, context: context };
    wire(host);
    if ((state.loaded || state.loading) && state.scope !== nextScope) {
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

  function renderIssuesView() {
    if (!active) return;
    var host = active.host;
    var context = active.context;
    var openCount = state.rows.filter(function (issue) {
      return (!context.plantCode || issue.plantCode === context.plantCode) &&
        statusGroup(issue.status) !== "Solved";
    }).length;
    var rows = rowsFor(context);
    var unfilteredRows = rowsFor(context, true);
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
            '<h2>Issues <span>' + rows.length + '</span></h2>' +
            '<span>' + (state.statusFilter === "All" ? "All statuses" : escape(state.statusFilter)) +
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
    var issuesMarkup = '<div class="ep-issues">' +
      renderHeader(context) +
      '<div class="ep-issues__body">' +
        renderFilters(context, unfilteredRows) +
        content +
      '</div>' +
      renderDrawer(context) +
    '</div>';
    host.innerHTML = context.plantDetailsMerged
    ? '<section class="ep-pd__health-card"><header class="ep-pd__health-head">' +
        '<h2>Health</h2><span class="ep-pd__open-count">' + openCount + ' open</span>' +
      '</header>' + issuesMarkup + '</section>'
    : issuesMarkup;
    wireColumnFilterMenus(host);
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
    renderView();
    loadCategories().then(function () {
      if (!active || active.host !== host || state.modalMode !== "create") return;
      state.categoryLoading = false;
      renderView();
    }).catch(function (error) {
      if (!active || active.host !== host || state.modalMode !== "create") return;
      state.categoryLoading = false;
      state.categoryError = error.message || "Please try again.";
      renderView();
    });
  }

  function loadCategoriesForEdit(host, issueId) {
    if (state.categoryLoading) return;
    state.categoryLoading = true;
    state.categoryError = "";
    renderView();
    loadCategories().then(function () {
      if (!active || active.host !== host || state.modalMode !== "edit" || state.modalId !== issueId) return;
      state.categoryLoading = false;
      renderView();
    }).catch(function (error) {
      if (!active || active.host !== host || state.modalMode !== "edit" || state.modalId !== issueId) return;
      state.categoryLoading = false;
      state.categoryError = error.message || "Configured categories could not be loaded.";
      renderView();
    });
  }

  function issuesUrl(offset) {
    var url = "/api/issues?limit=" + state.pageSize + "&offset=" + offset +
      (state.scope ? "&site_code=" + encodeURIComponent(state.scope) : "");
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
    global.Solar91PortalAPI.request(issuesUrl(state.rows.length)).then(function (issues) {
      if (requestId !== state.requestId) return;
      var plantsById = {};
      state.plants.forEach(function (plant) { plantsById[plant.dbId] = plant; });
      var seen = {};
      state.rows.forEach(function (row) { seen[row.id] = true; });
      issues.forEach(function (issue) {
        var row = mapApiIssue(issue, plantsById);
        if (!seen[row.id]) state.rows.push(row);
      });
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
      var canRaise = ["O&M Head", "Assignee", "Site Engineer"].indexOf(role) !== -1;
      var requests = [
        api.plants(),
        api.request(issuesUrl(0)),
        canRaise ? api.request("/api/issues/assignees") : Promise.resolve([])
      ];
      return Promise.all(requests).then(function (result) {
        return { role: role, plants: result[0], issues: result[1], assignees: result[2] };
      });
    }).then(function (result) {
      if (requestId !== state.requestId) return;
      state.plants = result.plants;
      var plantsById = {};
      state.plants.forEach(function (plant) { plantsById[plant.dbId] = plant; });
      state.rows = result.issues.map(function (issue) { return mapApiIssue(issue, plantsById); });
      state.hasMore = result.issues.length >= state.pageSize;
      state.assignees = result.assignees || [];
      state.canRaise = ["O&M Head", "Assignee", "Site Engineer"].indexOf(result.role) !== -1 &&
        state.plants.length > 0;
      state.canEdit = ["O&M Head", "Assignee"].indexOf(result.role) !== -1;
      state.isHead = result.role === "O&M Head";
      state.liveMode = true;
      state.loaded = true;
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
      if (event.target.matches("[data-issue-column-filter-search]")) {
        filterColumnOptions(event.target.closest("[data-issue-column-filter-menu]"), event.target.value);
        return;
      }
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
      if (event.target.name === "equipment" && state.modalMode === "create" && state.draft) {
        var currentWizard = host.querySelector("[data-issue-wizard]");
        if (currentWizard) syncWizardDraft(currentWizard);
        state.draft.equipment = event.target.value;
        state.draft.subpart = "";
        renderView();
        return;
      }
      if (event.target.name === "evidence" && state.modalMode === "create" && state.draft) {
        var files = Array.prototype.slice.call(event.target.files || []);
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
        renderView();
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
      var plantRow = event.target.closest("[data-issue-plant]");
      if (plantRow && !event.target.closest("button, a, input, select, textarea")) {
        if (plantRow.dataset.issuePlant) {
          global.Solar91PortalNav.selectPlantPage(plantRow.dataset.issuePlant, "health");
        }
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
      var templateButton = event.target.closest("[data-issue-template]");
      if (templateButton && state.modalMode === "create" && state.draft) {
        var template = templates()[Number(templateButton.dataset.issueTemplate)];
        var wizardForm = host.querySelector("[data-issue-wizard]");
        if (wizardForm) syncWizardDraft(wizardForm);
        if (template) {
          state.draft.equipment = template.equipment;
          state.draft.subpart = template.subpart || "";
          state.draft.problem = template.problem;
          state.wizardStep = 2;
          renderView();
        }
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
            var equipmentError = host.querySelector("[data-wizard-error]");
            if (equipmentError) {
              equipmentError.textContent = "Select an equipment category to continue.";
              equipmentError.hidden = false;
            }
            return;
          }
          state.wizardStep = Math.min(3, state.wizardStep + 1);
        }
        renderView();
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
        state.modalId = edit.dataset.issueEdit;
        state.modalMode = "edit";
        state.editDraft = null;
        state.submitError = "";
        state.categoryError = "";
        state.categoryLoading = false;
        renderView();
        loadCategoriesForEdit(host, state.modalId);
        return;
      }
      var open = event.target.closest("[data-issue-open]");
      if (open) {
        state.submitNotice = "";
        state.modalId = open.dataset.issueOpen;
        state.modalMode = "details";
        state.editDraft = null;
        state.photoError = "";
        renderView();
        loadIssuePhotos(state.modalId);   // thumbnails for this ticket only, never for the list
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
      var filterToggle = event.target.closest("[data-issue-column-filter-toggle]");
      if (filterToggle && state.canEdit) {
        var filterKey = filterToggle.getAttribute("data-issue-column-filter-toggle");
        var filterMenu = host.querySelector('[data-issue-column-filter-menu="' + filterKey + '"]');
        if (!filterMenu) return;
        if (filterMenu.matches(":popover-open")) {
          filterMenu.hidePopover();
        } else {
          filterMenu.showPopover();
          positionColumnFilter(filterToggle, filterMenu);
        }
        return;
      }
      var filterOption = event.target.closest("[data-issue-column-filter-option]");
      if (filterOption && state.canEdit) {
        var optionKey = filterOption.getAttribute("data-issue-column-filter-option");
        var optionMenu = filterOption.closest("[data-issue-column-filter-menu]");
        if (optionMenu && optionMenu.matches(":popover-open")) optionMenu.hidePopover();
        state.columnFilters[optionKey] = filterOption.getAttribute("data-issue-column-filter-value") || "";
        renderView();
        return;
      }
      var sortButton = event.target.closest("[data-issue-sort]");
      if (sortButton) {
        global.Solar91PortalSort.next(state.columnSort, sortButton.getAttribute("data-issue-sort"));
        renderView();
        return;
      }
      var actionButton = event.target.closest("[data-issue-action]");
      if (!actionButton) return;
      var action = actionButton.dataset.issueAction;
      if (action === "close-ticket") {
        closeIssueFromEdit(actionButton);
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
        state.statusFilter = "All";
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
        state.modalId = "";
        state.modalMode = "";
        state.submitNotice = "";
        state.draft = null;
        state.editDraft = null;
        state.wizardStep = 1;
        state.categoryLoading = false;
        state.categoryError = "";
      } else if (action === "retry") {
        state.loaded = false;
        load();
        return;
      } else if (action === "edit-current") {
        state.modalMode = "edit";
        state.editDraft = null;
      } else if (action === "progress" || action === "solve") {
        var current = state.rows.find(function (row) { return row.id === state.modalId; });
        if (current) current.status = action === "progress" ? "In Progress" : "Solved";
      }
      renderView();
    });
    host.addEventListener("keydown", function (event) {
      if (!active || active.host !== host ||
          !event.target.matches("[data-issue-plant]") ||
          (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      if (event.target.dataset.issuePlant) {
        global.Solar91PortalNav.selectPlantPage(event.target.dataset.issuePlant, "health");
      }
    });
    host.addEventListener("submit", function (event) {
      if (!event.target.matches("[data-issue-form]") || !active) return;
      event.preventDefault();
      if (state.submitting) return;
      var form = event.target;
      if (form.hasAttribute("data-issue-wizard")) {
        if (state.wizardStep !== 3 || !form.reportValidity()) return;
        syncWizardDraft(form);
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
        renderView();
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
  }

  function closeIssueFromEdit(button) {
    var form = button.closest("[data-issue-edit-form]");
    if (!form) return;
    syncIssueEditDraft(form);
    var issue = state.rows.find(function (row) { return row.dbId === form.dataset.issueEditForm; });
    var direct = button.dataset.directClose === "true";
    var note = form && form.elements.closeNote ? form.elements.closeNote.value.trim() : "";
    if (!issue) {
      state.submitError = "This ticket is no longer in the list. Close and reopen the register.";
      renderView();
      return;
    }
    if (direct && !note) {
      state.submitError = "Add a reason before closing this ticket directly.";
      renderView();
      return;
    }
    if (!global.confirm("Close " + issue.id + (direct
      ? " directly? The reason will be recorded in ticket history."
      : " as verified?"))) return;

    state.submitting = true;
    state.submitError = "";
    renderView();
    global.Solar91PortalAPI.request("/api/issues/" + encodeURIComponent(issue.dbId) + "/close", {
      method: "POST",
      body: { note: note || null, direct: direct, closure: {} }
    }).then(function (updated) {
      var plantsById = {};
      state.plants.forEach(function (plant) { plantsById[plant.dbId] = plant; });
      var saved = mapApiIssue(updated, plantsById);
      var index = state.rows.findIndex(function (row) { return row.dbId === saved.dbId; });
      if (index !== -1) state.rows.splice(index, 1, saved);
      state.submitting = false;
      state.editDraft = null;
      state.modalMode = "details";
      state.modalId = saved.id;
      state.submitNotice = saved.id + " closed.";
      renderView();
    }).catch(function (error) {
      state.submitting = false;
      state.submitError = error.message || "Could not close this ticket.";
      renderView();
    });
  }

  function syncIssueEditDraft(form) {
    if (!form) return;
    var draft = { id: form.dataset.issueEditForm };
    ["equipment", "subpart", "supplierMaker", "serialNo", "unitCount", "assignedTo", "status",
      "rootCause", "correctiveAction", "fixedOn", "resolutionRemark", "problem", "changeReason", "closeNote"]
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
    var canChange = state.canEdit && state.liveMode;
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
    if (!issue) return fail("This ticket is no longer in the list. Close and reopen the register.");
    if (!state.liveMode) return fail("This preview cannot save changes. Open the signed-in Solar91 O&M app.");

    syncIssueEditDraft(form);
    state.submitError = "";
    var read = function (name) { return (form.elements[name] && form.elements[name].value || "").trim(); };
    var units = parseInt(read("unitCount"), 10);
    var next = {
      vertical: read("equipment"),
      subcategory: read("subpart") || null,
      supplier_maker: read("supplierMaker") || null,
      serial_no: read("serialNo") || null,
      unit_count: isNaN(units) ? null : units,
      description: read("problem")
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
    // No early return on an empty payload: status and assignee are saved through
    // their own endpoints below, so changing only one of those is still a change.
    // The "nothing to do" check is the steps list further down.
    var reason = read("changeReason");
    if (reason) payload.change_reason = reason;

    // Assignment and status are not part of PATCH; each has its own endpoint,
    // so they are applied in turn after the details and only when they changed.
    var base = "/api/issues/" + encodeURIComponent(issue.dbId);
    var nextAssignee = state.isHead ? read("assignedTo") : (issue.assignedTo || "");
    var nextStatus = read("status");
    var steps = [];
    if (Object.keys(payload).length) {
      steps.push(function () { return api.request(base, { method: "PATCH", body: payload }); });
    }
    if (nextAssignee !== (issue.assignedTo || "")) {
      steps.push(function () {
        if (!nextAssignee) {
          // Clearing an assignment is a reassignment to nobody.
          return api.request(base + "/reassign", { method: "POST", body: { assigned_to: null, note: reason || null } });
        }
        return api.request(base + (issue.assignedTo ? "/reassign" : "/assign"),
          { method: "POST", body: { assigned_to: nextAssignee, note: reason || null } });
      });
    }
    if (nextStatus === "Resolved" && issue.status !== "Resolved") {
      var rootCause = read("rootCause");
      var correctiveAction = read("correctiveAction");
      var photoInput = form.elements.resolutionEvidence;
      var photos = photoInput && photoInput.files ? Array.prototype.slice.call(photoInput.files) : [];
      if (!rootCause) return fail("Add the root cause before resolving this ticket.");
      if (!correctiveAction) return fail("Add the corrective action before resolving this ticket.");
      if (!photos.length) return fail("Attach at least one photo of the completed fix.");

      // Walk the stages in between first, so the transition the API expects is legal.
      (STEPS_BEFORE_RESOLVE[issue.status] || []).forEach(function (stage) {
        steps.push(function () {
          return api.request(base + "/status", { method: "POST", body: { status: stage, note: reason || null } });
        });
      });
      steps.push(function () {
        // The resolve call needs the evidence ids this endpoint returns, so these photos still
        // post as files. They are downscaled first all the same: a fix photo costs the bucket
        // the same 2048px WebP as any other, not a 5 MB camera original.
        var evidence = photoEvidence();
        var ready = evidence ? evidence.prepare(photos)
          : Promise.resolve(photos.map(function (file) { return { blob: file, name: file.name }; }));
        return ready.then(function (prepared) {
          var files = new FormData();
          prepared.forEach(function (item) { files.append("files", item.blob, item.name); });
          return api.request(base + "/evidence", { method: "POST", body: files });
        }).then(function (uploaded) {
          return api.request(base + "/resolve", {
            method: "POST",
            body: {
              root_cause: rootCause,
              corrective_action: correctiveAction,
              evidence_ids: uploaded.map(function (entry) { return entry.id; }),
              fixed_on: read("fixedOn") || null,
              remark: read("resolutionRemark") || null,
              note: reason || null
            }
          });
        });
      });
    } else if (nextStatus && nextStatus !== issue.status) {
      steps.push(function () {
        return nextStatus === "Open"
          ? api.request(base + "/reset", { method: "POST", body: {} })
          : api.request(base + "/status", { method: "POST", body: { status: nextStatus, note: reason || null } });
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
      renderView();
      return;
    }

    state.submitting = true;
    state.submitError = "";
    renderView();
    var units = parseInt(draft.unitCount, 10);
    var payload = {
      plant_id: plant.dbId,
      vertical: draft.equipment,
      subcategory: draft.subpart || null,
      serial_no: (draft.serialNo || "").trim() || null,
      supplier_maker: (draft.supplierMaker || "").trim() || null,
      unit_count: isNaN(units) ? null : units,
      description: draft.problem.trim(),
      // Tickets raised here all carry the same priority, so the form no longer asks for one.
      // Medium is what the deadline defaults and notifications are keyed to.
      severity: "Medium",
      assigned_to: draft.assignee || null,
      occurred_at: toUtcTimestamp(draft.occurredAt, "09:00"),
      etc_at: draft.dueAt ? toUtcTimestamp(draft.dueAt) : null,
      photo_count: 0
    };

    api.request("/api/issues", { method: "POST", body: payload }).then(function (issue) {
      var plantsById = {};
      state.plants.forEach(function (item) { plantsById[item.dbId] = item; });
      var saved = mapApiIssue(issue, plantsById);
      var existing = state.rows.find(function (row) { return row.dbId === saved.dbId; });
      if (existing) state.rows.splice(state.rows.indexOf(existing), 1);
      state.rows.unshift(saved);
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
      state.statusFilter = "All";
      state.search = "";
      renderView();
    }).catch(function (error) {
      state.submitting = false;
      state.submitError = error.message || "Could not save this issue ticket.";
      renderView();
    });
  }

  /**
   * Open the register showing one equipment category only. Set just before the page is
   * rendered (the Overview's Inverters tile does this), because `render` resets the
   * filters when the scope changes.
   */
  function presetEquipment(equipment) { pendingEquipment = equipment || ""; }

  function openTicket(ticketNo, siteCode) {
    if (!active || !ticketNo) return;
    state.submitNotice = "";
    var url = "/api/issues?vertical=Inverter&status=open&limit=200";
    var scopedCode = siteCode || (active.context && active.context.plantCode) || "";
    if (scopedCode) url += "&site_code=" + encodeURIComponent(scopedCode);
    Promise.all([
      global.Solar91PortalAPI.request(url),
      global.Solar91PortalAPI.plants()
    ]).then(function (result) {
      var issues = result[0];
      state.plants = result[1];
      var issue = issues.find(function (row) { return row.ticket_no === ticketNo; });
      if (!issue) throw new Error("The ticket is not in the latest 200 open inverter issues for this plant.");
      var plantsById = {};
      state.plants.forEach(function (plant) { plantsById[plant.dbId] = plant; });
      var mapped = mapApiIssue(issue, plantsById);
      if (!state.rows.some(function (row) { return row.dbId === mapped.dbId; })) state.rows.unshift(mapped);
      state.modalId = mapped.id;
      state.modalMode = "details";
      renderView();
    }).catch(function (error) {
      state.submitNotice = "Could not open ticket " + ticketNo + ": " + (error.message || "please retry.");
      renderView();
    });
  }

  global.Solar91PortalIssues = {
    render: render,
    presetEquipment: presetEquipment,
    openTicket: openTicket
  };
}(window));