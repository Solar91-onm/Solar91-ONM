
(function (global) {
  "use strict";

  var data = global.Solar91PortalData;
  var fmt = global.Solar91PortalFormat;

  var allRows = [];            // [{ plant, profile }]
  var loadPromise = null;
  var loaded = false;
  var searchTimer = null;
  var activeContainer = null;
  var mode = { kind: "all", siteCode: null, merged: false };
  var detailSection = "details";
  var ui = { search: "", spv: "__all", district: "__all", sort: { key: "code", dir: "asc" }, columnFilters: {} };
  var DETAIL_SECTIONS = ["details", "design-mdl", "liasoning", "bom"];
  var FILTERABLE_COLUMNS = ["code", "district", "discom", "engineer", "supervisor", "assignee", "pmAssignee", "healthAssignee", "location"];
  var DETAIL_SECTION_LABELS = {
    details: "Details",
    "design-mdl": "Design/MDL",
    liasoning: "Liasoning",
    bom: "BOM"
  };

  // ─── Field helpers ───────────────────────────────────────────────────
  // Only ever read the number out of the shortened "Project N" form. The raw
  // projectCompany string contains "Solar91", so a loose \d+ match on it would
  // silently render 91 for every plant.
  function spvNumber(plant) {
    var m = String(plant.projectCompanyShort || "").match(/^(?:SPV|Project)\s+(\d+)$/i);
    return m ? m[1] : "—";
  }

  function two(n) {
    n = String(n);
    return n.length < 2 ? "0" + n : n;
  }

  // dd-mm-yy keeps the COD column compact.
  function formatCOD(iso) {
    var m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? m[3] + "-" + m[2] + "-" + m[1].slice(2) : (iso || "—");
  }

  function activityParts(profile) {
    if (!profile || !profile.lastReportAt) return null;
    var d = new Date(profile.lastReportAt);
    if (isNaN(d.getTime())) return null;
    return {
      date: two(d.getDate()) + "/" + two(d.getMonth() + 1) + "/" + String(d.getFullYear()).slice(2)
    };
  }

  function lastActivity(profile) {
    var a = activityParts(profile);
    return a ? a.date : "—";
  }

  function numText(v) {
    return (v === null || v === undefined || v === "") ? "—" : fmt.formatNumber(v);
  }

  function dash(title) {
    return '<span class="ep-pt__dash"' + (title ? ' title="' + title + '"' : "") + ">—</span>";
  }

  // ─── Filtering + sorting ─────────────────────────────────────────────
  function engineerContacts(plant) {
    var contacts = Array.isArray(plant && plant.siteEngineerContacts) ? plant.siteEngineerContacts : [];
    if (contacts.length) {
      return contacts.map(function (contact) {
        return {
          name: (contact && contact.name) || "",
          mobile: (contact && contact.mobile) || ""
        };
      }).filter(function (contact) { return contact.name || contact.mobile; });
    }
    var names = Array.isArray(plant && plant.siteEngineers) ? plant.siteEngineers : [];
    return names.map(function (name) { return { name: name || "", mobile: "" }; }).filter(function (contact) { return contact.name; });
  }

  function engineerCell(plant) {
    var contacts = engineerContacts(plant);
    if (!contacts.length) return dash("No Site Engineer assigned");
    var lines = [];
    contacts.forEach(function (contact) {
      var name = (contact.name || "").trim();
      var mobile = (contact.mobile || "").trim();
      if (name) lines.push('<span class="ep-pt__eng-name">' + fmt.escape(name) + "</span>");
      if (mobile) lines.push('<span class="ep-pt__eng-no">' + fmt.escape(mobile) + "</span>");
    });
    return '<div class="ep-pt__engcell ep-compact-cell" data-compact-cell>' +
      '<div class="ep-compact-cell__content ep-pt__engcell-lines is-collapsed" data-compact-content>' +
        lines.join("") +
      '</div><button type="button" class="ep-compact-cell__toggle" data-compact-cell-toggle ' +
        'aria-expanded="false" hidden>More</button></div>';
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
    if (event.detail && event.detail.section === "info" && activeContainer && activeContainer.isConnected) {
      refreshCompactCells(activeContainer);
    }
  });

  function visibleRows() {
    if (mode.kind === "single") {
      return allRows.filter(function (r) { return r.plant.siteCode === mode.siteCode; });
    }

    var term = ui.search.trim().toLowerCase();
    var rows = allRows.filter(function (r) {
      var p = r.plant;
      if (term) {
        var engineerText = engineerContacts(p).map(function (contact) {
          return [contact.name, contact.mobile].filter(Boolean).join(" ");
        }).join(" ");
        var hay = [
          p.siteCode, p.displayCode, p.plantName, p.displayName || "",
          p.projectCompany || "", p.district || "", p.discom || "",
          engineerText, p.supervisor || "", p.washingAssignee || "", p.location || ""
        ].join(" ").toLowerCase();
        if (hay.indexOf(term) === -1) return false;
      }
      if (ui.spv !== "__all" && (p.projectCompany || "") !== ui.spv) return false;
      if (ui.district !== "__all" && (p.district || "") !== ui.district) return false;
      if (canUseColumnFilters() && FILTERABLE_COLUMNS.some(function (key) {
        var term = String(ui.columnFilters[key] || "").trim().toLowerCase();
        if (!term) return false;
        var column = COLUMNS.find(function (item) { return item.key === key; });
        var value = column && column.sort ? column.sort(r) : "";
        return String(value || "").trim().toLowerCase() !== term;
      })) return false;
      return true;
    });

    return global.Solar91PortalSort.apply(rows, ui.sort, COLUMNS);
  }

  // ─── Columns (fixed order, both views) ───────────────────────────────
  // `sort` reads the value the column is ordered by; a column without one
  // (Edit) is not sortable.
  var COLUMNS = [
    { key: "code",      label: "Plant Code",
      sort: function (r) { return r.plant.siteCode; } },
    { key: "spv",       label: "SPV", align: "num",
      sort: function (r) { var n = spvNumber(r.plant); return n === "—" ? null : Number(n); } },
    { key: "ac",        label: "AC (KW)",       align: "num",
      sort: function (r) { return r.plant.acCapacityKw; } },
    { key: "dc",        label: "DC (KWP)",      align: "num",
      sort: function (r) { return r.plant.dcCapacityKw; } },
    { key: "district",  label: "District",
      sort: function (r) { return r.plant.district; } },
    { key: "discom",    label: "Discom",
      sort: function (r) { return r.plant.discom; } },
    { key: "engineer",  label: "Site Engineer",
      sort: function (r) {
        var contacts = engineerContacts(r.plant);
        return contacts.map(function (contact) { return contact.name; }).join(", ") || r.plant.assignedEngineer;
      } },
    { key: "supervisor", label: "Supervisor",
      sort: function (r) { return r.plant.supervisor; } },
    { key: "assignee",  label: "Cleaning Assignee",
      sort: function (r) { return r.plant.washingAssignee; } },
    { key: "pmAssignee",     label: "PM Assignee",
      sort: function (r) { return r.plant.pmAssignee; } },
    { key: "healthAssignee", label: "Health Assignee",
      sort: function (r) { return r.plant.healthAssignee; } },
    { key: "cod",       label: "COD",           align: "num",
      sort: function (r) { return r.plant.commissionedOn; } },
    { key: "location",  label: "Location",
      sort: function (r) { return r.plant.location || r.plant.mapsUrl; } },
    { key: "cctv",      label: "CCTV",
      sort: function (r) { return cctvUrl(r.plant); } },
    { key: "activity",  label: "Last Activity",
      sort: function (r) { return r.profile && r.profile.lastReportAt; } },
    { key: "edit",      label: "Edit",          align: "num" }
  ];

  function canEdit() {
    return canCreatePlant();
  }

  function canCreatePlant() {
    var user = global.Solar91PortalAPI && global.Solar91PortalAPI.currentUser();
    return !!(user && ["O&M Head", "Assignee"].indexOf(user.role) !== -1);
  }

  function canUseColumnFilters() {
    var user = global.Solar91PortalAPI && global.Solar91PortalAPI.currentUser();
    return !!(user && ["O&M Head", "Assignee"].indexOf(user.role) !== -1);
  }

  function editButton(siteCode) {
    return canEdit()
      ? '<button class="ep-pt__edit" type="button" data-edit-plant="' + fmt.escape(siteCode) + '">' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>' +
          "Edit</button>"
      : "";
  }

  function columnFilterOptions(key) {
    var column = COLUMNS.find(function (item) { return item.key === key; });
    var values = Object.create(null);
    if (!column || !column.sort) return [];
    allRows.forEach(function (entry) {
      var value = String(column.sort(entry) || "").trim();
      if (value) values["$" + value.toLowerCase()] = value;
    });
    return Object.keys(values).map(function (valueKey) { return values[valueKey]; })
      .sort(function (a, b) { return a.localeCompare(b); });
  }

  function columnHeaderHTML(column) {
    var header = global.Solar91PortalSort.thHTML(column, ui.sort, "data-pt-sort");
    if (!canUseColumnFilters() || FILTERABLE_COLUMNS.indexOf(column.key) === -1) return header;

    var activeFilter = String(ui.columnFilters[column.key] || "");
    return global.Solar91PortalColumnFilter.headerHTML(header, {
      key: column.key,
      label: column.label,
      values: columnFilterOptions(column.key),
      active: activeFilter,
      menuId: "ep-pt-filter-menu-" + column.key,
      caseInsensitive: true,
      attributes: {
        toggleKey: "data-pt-column-filter-toggle",
        menuKey: "data-pt-column-filter-menu",
        optionKey: "data-pt-column-filter-option",
        optionValue: "data-pt-column-filter-value",
        search: "data-pt-column-filter-search",
        empty: "data-pt-column-filter-empty"
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
      focusSearchOnOpen: true,
      keepAllOptionVisible: false
    });
  }

  function wireColumnFilterMenus(container) {
    global.Solar91PortalColumnFilter.wire(container, {
      attributes: {
        toggleKey: "data-pt-column-filter-toggle",
        menuKey: "data-pt-column-filter-menu",
        optionKey: "data-pt-column-filter-option",
        optionValue: "data-pt-column-filter-value",
        search: "data-pt-column-filter-search",
        empty: "data-pt-column-filter-empty"
      },
      classes: {
        menu: "ep-issues__column-filter-menu",
        search: "ep-issues__column-filter-search",
        empty: "ep-issues__column-filter-empty"
      },
      focusSearchOnOpen: true,
      keepAllOptionVisible: false,
      onSelect: function (key, _scope, value) {
        ui.columnFilters[key] = value;
        render(container);
      }
    });
  }

  function cctvUrl(plant) {
    var value = plant.customFields && plant.customFields.cctv_url;
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      var url = new URL(value.trim());
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  function rowHTML(entry) {
    var p = entry.plant;
    // In the portfolio view the code cell is the way into that plant's own page.
    var codeInner = '<span class="ep-pt__code">' + fmt.escape(p.siteCode) + "</span>" +
      '<span class="ep-pt__name">' + fmt.escape(p.displayName || p.plantName) + "</span>";
    var codeCell = mode.kind === "single"
      ? '<td class="ep-pt__codecell">' + codeInner + "</td>"
      : '<td class="ep-pt__codecell"><button type="button" class="ep-plantlink" data-open-plant="' +
        fmt.escape(p.siteCode) + '" title="Open ' + fmt.escape(p.displayName || p.plantName) +
        ' in the Plants tab">' + codeInner + "</button></td>";
    var locationCell = "<td>" + (p.mapsUrl
        ? '<a class="ep-pt__loc" href="' + fmt.escape(p.mapsUrl) + '" target="_blank" rel="noopener" aria-label="View plant location" title="' +
            fmt.escape(p.location || p.district || "View plant location") + '">' +
            "View</a>"
        : dash()) + "</td>";
    var cameraUrl = cctvUrl(p);
    var cctvCell = "<td>" + (cameraUrl
        ? '<a class="ep-pt__loc" href="' + fmt.escape(cameraUrl) + '" target="_blank" rel="noopener" aria-label="Open CCTV feed for ' +
            fmt.escape(p.displayName || p.plantName) + '" title="Open CCTV feed">View</a>'
        : '<span class="ep-pt__cctv-placeholder">Add link</span>') + "</td>";
    var editCell = mode.merged
      ? dash("Plant editing is available above the table")
      : (canEdit() ? editButton(p.siteCode) : dash("Your role cannot edit plant records"));
    return "" +
      "<tr>" +
        codeCell +
        '<td class="num"><span class="ep-pt__spv">' + fmt.escape(spvNumber(p)) + "</span></td>" +
        '<td class="num mono">' + numText(p.acCapacityKw) + "</td>" +
        '<td class="num mono">' + numText(p.dcCapacityKw) + "</td>" +
        "<td>" + (p.district ? fmt.escape(p.district) : dash()) + "</td>" +
        "<td>" + (p.discom ? fmt.escape(p.discom) : dash()) + "</td>" +
        "<td>" + engineerCell(p) + "</td>" +
        "<td>" + (p.supervisor ? fmt.escape(p.supervisor) : dash("No supervisor assigned")) + "</td>" +
        "<td>" + (p.washingAssignee ? fmt.escape(p.washingAssignee) : dash("Module Cleaning not set up")) + "</td>" +
        "<td>" + (p.pmAssignee ? fmt.escape(p.pmAssignee) : dash("No Preventive Maintenance Assignee")) + "</td>" +
        "<td>" + (p.healthAssignee ? fmt.escape(p.healthAssignee) : dash("No Health Assignee")) + "</td>" +
        '<td class="num mono">' + fmt.escape(formatCOD(p.commissionedOn)) + "</td>" +
        locationCell +
        cctvCell +
        '<td class="mono">' + fmt.escape(lastActivity(entry.profile)) + "</td>" +
        '<td class="num">' + editCell + "</td>" +
      "</tr>";
  }

  // ─── Toolbar ─────────────────────────────────────────────────────────
  function toolbarHTML() {
    var spvs = [];
    var seenSpv = {};
    allRows.forEach(function (r) {
      var full = r.plant.projectCompany || "";
      if (full && !seenSpv[full]) { seenSpv[full] = 1; spvs.push(full); }
    });
    spvs.sort(function (a, b) {
      return parseInt((a.match(/\d+/) || ["0"])[0], 10) - parseInt((b.match(/\d+/) || ["0"])[0], 10);
    });

    var districts = [];
    var seenDist = {};
    allRows.forEach(function (r) {
      var d = r.plant.district || "";
      if (d && !seenDist[d]) { seenDist[d] = 1; districts.push(d); }
    });
    districts.sort();

    function opts(list, selected, labeller) {
      return list.map(function (v) {
        return '<option value="' + fmt.escape(v) + '"' + (selected === v ? " selected" : "") + ">" +
               fmt.escape(labeller ? labeller(v) : v) + "</option>";
      }).join("");
    }

    return "" +
      '<div class="ep-pt__toolbar">' +
        '<div class="ep-pt__search">' +
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>' +
          '<input type="text" placeholder="Search plant code, name, project, district..." data-pt-search value="' + fmt.escape(ui.search) + '" autocomplete="off" />' +
        "</div>" +
        '<select class="ep-pt__select" data-pt-filter="spv" aria-label="Filter by SPV or project">' +
          '<option value="__all">All SPV</option>' +
          opts(spvs, ui.spv, function (v) {
            var row = allRows.find(function (r) { return r.plant.projectCompany === v; });
            return (row && row.plant.projectCompanyShort) || v;
          }) +
        "</select>" +
        '<select class="ep-pt__select" data-pt-filter="district" aria-label="Filter by district">' +
          '<option value="__all">All districts</option>' +
          opts(districts, ui.district) +
        "</select>" +
        // The API separately allows O&M Heads and Assignees to create and edit plant records.
        (canCreatePlant() && mode.kind === "all"
          ? '<button class="ep-pt__add" type="button" data-pt-add>+ Add New Plant</button>'
          : "") +
      "</div>";
  }

  // ─── Render ──────────────────────────────────────────────────────────
  function render(container) {
    if (!container) return;
    if (global.Solar91Perf && global.Solar91Perf.enabled) {
      return global.Solar91Perf.time("render plants table", function () { renderTable(container); });
    }
    renderTable(container);
  }

  function detailsCollapseKey(siteCode) {
    var user = global.Solar91PortalAPI && global.Solar91PortalAPI.currentUser();
    var userKey = user && (user.id || user.email) || "unknown";
    return "solar91.plantDetailsCollapsed.v1." + encodeURIComponent(userKey) + "." +
      encodeURIComponent(siteCode);
  }

  function plantDetailsCollapsed(siteCode) {
    try { return global.localStorage.getItem(detailsCollapseKey(siteCode)) === "true"; }
    catch (error) { return false; }
  }

  function renderTable(container) {
    var rows = visibleRows();
    var single = mode.kind === "single";
    var plant = single && rows[0] ? rows[0].plant : null;
    var merged = single && mode.merged && detailSection === "details";
    var collapsed = merged && plant ? plantDetailsCollapsed(plant.siteCode) : false;

    var title = single
      ? (plant ? fmt.escape(plant.displayName || plant.plantName) + " · " +
        fmt.escape(DETAIL_SECTION_LABELS[detailSection]) : "Plant Details")
      : (detailSection === "details" ? "Plants table" : fmt.escape(DETAIL_SECTION_LABELS[detailSection]));

    var subtitle = single
      ? (plant ? fmt.escape(plant.siteCode) + " · " + fmt.escape(plant.district || "") : "")
      : allRows.length + " plants";

    var countLine = single
      ? "This plant"
      : (rows.length === allRows.length
          ? "All " + allRows.length + " plants"
          : rows.length + " of " + allRows.length + " plants");

    var pageHeader = !single && detailSection === "details"
      ? ""
      : (merged
        ? '<div class="ep-pt__head"><h1 class="ep-pt__title">' +
          (plant ? fmt.escape(plant.displayName || plant.plantName) : "Plant Details") +
          '</h1><p class="ep-pt__sub">' +
          (plant ? fmt.escape(plant.siteCode) + " · " + fmt.escape(plant.district || "—") +
            " · " + fmt.escape(plant.discom || "—") : "") +
          "</p></div>"
        : '<div class="ep-pt__head">' +
          '<h1 class="ep-pt__title">' + title + "</h1>" +
          '<p class="ep-pt__sub">' + subtitle + "</p>" +
        "</div>");

    var table = '<div class="ep-pt__table-wrap">' +
      '<div class="ep-pt__scroll" data-pt-scroll tabindex="0" role="region" aria-label="' +
        (single ? "Plant details" : "Plant details table; scroll vertically to see more plants") + '">' +
        '<table class="ep-pt__table">' +
        "<thead><tr>" +
          (single
            ? COLUMNS.map(function (c) {
                return "<th" + (c.align === "num" ? ' class="num"' : "") + ">" + c.label + "</th>";
              }).join("")
            : COLUMNS.map(columnHeaderHTML).join("")) +
        "</tr></thead>" +
        "<tbody>" +
          (rows.length
            ? rows.map(rowHTML).join("")
            : '<tr><td colspan="' + COLUMNS.length + '" class="ep-pt__empty">' +
                (single
                  ? "This plant was not found, or it is outside your assigned scope."
                  : "No plants match these filters.") +
              "</td></tr>") +
        "</tbody>" +
        "</table>" +
      "</div>" +
    "</div>";

    var card;
    if (detailSection === "details" && merged) {
      card = '<section class="ep-pt__card ep-pd__details-card">' +
        '<header class="ep-pd__details-head">' +
          '<button type="button" class="ep-pd__details-toggle" data-plant-details-toggle aria-expanded="' +
            !collapsed + '"><span>Plant details</span>' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></button>' +
          '<span class="ep-pd__record-count">1 record</span><span class="ep-pt__spacer"></span>' +
          (plant ? editButton(plant.siteCode) : "") +
        '</header><div class="ep-pd__details-body"' + (collapsed ? " hidden" : "") + ">" +
          table +
        "</div></section>";
    } else if (detailSection === "details") {
      card = '<div class="ep-pt__card">' +
        (single ? "" : toolbarHTML()) +
        (single ? "" :
          '<div class="ep-pt__meta">' +
            '<span class="ep-pt__count">' + countLine + "</span>" +
            '<span class="ep-pt__spacer"></span>' +
            '<button class="ep-pt__export" type="button" data-pt-export="csv">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m7 10 5 5 5-5"></path><path d="M12 15V3"></path></svg>CSV' +
            "</button>" +
            '<button class="ep-pt__export" type="button" data-pt-export="excel">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="m7 10 5 5 5-5"></path><path d="M12 15V3"></path></svg>Excel' +
            "</button>" +
          "</div>") +
        table +
      "</div>";
    } else {
      card = '<section class="ep-pt__detail-empty" data-detail-section="' +
        detailSection + '" aria-label="' + fmt.escape(DETAIL_SECTION_LABELS[detailSection]) + '"></section>';
    }

    container.innerHTML = '<div class="ep-pt' + (merged ? " ep-pt--merged" : "") + '">' +
      pageHeader + card + "</div>";

    wire(container);
  }

  // ─── Edit (persists through PATCH /api/plants/:id) ───────────────────
  function openEditor(container, siteCode) {
    var entry = allRows.filter(function (r) { return r.plant.siteCode === siteCode; })[0];
    if (!entry || !global.Solar91PortalPlantEditor) return;
    global.Solar91PortalPlantEditor.open(entry.plant, function () {
      loadPromise = null;          // the saved row must be re-read, not patched in memory
      loaded = false;
      show(container, {
        siteCode: mode.kind === "single" ? mode.siteCode : null,
        section: detailSection,
        merged: mode.merged
      });
    });
  }

  // ─── Export ──────────────────────────────────────────────────────────
  function exportRows() {
    var header = COLUMNS.filter(function (c) { return c.key !== "edit"; })
                        .map(function (c) { return c.label; });
    var body = visibleRows().map(function (entry) {
      var p = entry.plant;
      var engineerText = engineerContacts(p).map(function (contact) {
        return [contact.name, contact.mobile ? "(" + contact.mobile + ")" : ""].filter(Boolean).join(" ");
      }).join("; ") || p.assignedEngineer || "";
      return [
        p.siteCode + " " + (p.displayName || p.plantName),
        spvNumber(p),
        p.acCapacityKw === null || p.acCapacityKw === undefined ? "" : p.acCapacityKw,
        p.dcCapacityKw === null || p.dcCapacityKw === undefined ? "" : p.dcCapacityKw,
        p.district || "",
        p.discom || "",
        engineerText,
        p.supervisor || "",
        p.washingAssignee || "",
        p.pmAssignee || "",
        p.healthAssignee || "",
        formatCOD(p.commissionedOn),
        p.location || p.mapsUrl || "",
        cctvUrl(p),
        lastActivity(entry.profile)
      ];
    });
    return [header].concat(body);
  }

  function download(filename, mime, text) {
    var blob = new Blob(["﻿" + text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function exportCSV() {
    var csv = exportRows().map(function (row) {
      return row.map(function (cell) {
        // Neutralise spreadsheet formulas before quoting (a plant name can start with "=").
        var s = fmt.csvText(cell);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(",");
    }).join("\r\n");
    download("solar91-plants.csv", "text/csv;charset=utf-8;", csv);
  }

  function exportExcel() {
    var rows = exportRows().map(function (row, i) {
      var tag = i === 0 ? "th" : "td";
      return "<tr>" + row.map(function (cell) {
        return "<" + tag + ">" + fmt.escape(fmt.csvText(cell)) + "</" + tag + ">";
      }).join("") + "</tr>";
    }).join("");
    download("solar91-plants.xls", "application/vnd.ms-excel;charset=utf-8;",
      '<html><head><meta charset="utf-8"></head><body><table border="1">' + rows + "</table></body></html>");
  }

  // ─── Wiring ──────────────────────────────────────────────────────────
  function wire(container) {
    wireColumnFilterMenus(container);
    refreshCompactCells(container);

    container.querySelectorAll("[data-plant-details-toggle]").forEach(function (button) {
      button.addEventListener("click", function () {
        var body = container.querySelector(".ep-pd__details-body");
        if (!body) return;
        var expanded = body.hidden;
        body.hidden = !expanded;
        button.setAttribute("aria-expanded", String(expanded));
        var plant = mode.siteCode;
        try {
          global.localStorage.setItem(detailsCollapseKey(plant), String(!expanded));
        } catch (error) {}
      });
    });

    container.querySelectorAll("[data-compact-cell-toggle]").forEach(function (button) {
      button.addEventListener("click", function () {
        var cell = button.closest("[data-compact-cell]");
        var content = cell && cell.querySelector("[data-compact-content]");
        if (!content) return;
        var expanded = button.getAttribute("aria-expanded") !== "true";
        content.classList.toggle("is-collapsed", !expanded);
        button.setAttribute("aria-expanded", String(expanded));
        button.textContent = expanded ? "Less" : "More";
      });
    });

    // Hover to expand/collapse compact cells (More/Less)
    container.querySelectorAll("[data-compact-cell]").forEach(function (cell) {
      var toggle = cell.querySelector("[data-compact-cell-toggle]");
      if (!toggle) return;
      cell.addEventListener("mouseenter", function () {
        if (toggle.hidden) return; // nothing to expand
        var content = cell.querySelector("[data-compact-content]");
        if (!content) return;
        content.classList.remove("is-collapsed");
        toggle.setAttribute("aria-expanded", "true");
        toggle.textContent = "Less";
      });
      cell.addEventListener("mouseleave", function () {
        if (toggle.hidden) return;
        var content = cell.querySelector("[data-compact-content]");
        if (!content) return;
        content.classList.add("is-collapsed");
        toggle.setAttribute("aria-expanded", "false");
        toggle.textContent = "More";
      });
    });

    var search = container.querySelector("[data-pt-search]");
    if (search) {
      search.addEventListener("input", function () {
        ui.search = search.value;
        var pos = search.selectionStart;
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          searchTimer = null;
          if (!container.isConnected) return;
          render(container);
          var again = container.querySelector("[data-pt-search]");
          if (again) {
            again.focus();
            try { again.setSelectionRange(pos, pos); } catch (_) {}
          }
        }, 120);
      });
    }

    container.querySelectorAll("[data-pt-filter]").forEach(function (sel) {
      sel.addEventListener("change", function () {
        ui[sel.getAttribute("data-pt-filter")] = sel.value;
        render(container);
      });
    });

    global.Solar91PortalSort.wire(container, ui.sort, function () { render(container); }, "data-pt-sort");

    var addButton = container.querySelector("[data-pt-add]");
    if (addButton && global.Solar91PortalPlantEditor) {
      addButton.addEventListener("click", function () {
        global.Solar91PortalPlantEditor.create(function () {
          loadPromise = null;        // the new plant is re-read, not patched into memory
          loaded = false;
          show(container, { siteCode: null, section: detailSection, merged: mode.merged });
        });
      });
    }

    container.querySelectorAll("[data-pt-export]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.getAttribute("data-pt-export") === "csv") exportCSV();
        else exportExcel();
      });
    });

    // Edit buttons must not also trigger the row's open-plant click.
    container.querySelectorAll("[data-edit-plant]").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        openEditor(container, btn.getAttribute("data-edit-plant"));
      });
    });

  }

  // ─── Public entry point ──────────────────────────────────────────────
  function ensureLoaded() {
    if (!loadPromise) {
      loadPromise = data.fetchPortfolio().then(function (portfolio) {
        allRows = portfolio.rows;
        loaded = true;
        return allRows;
      });
    }
    return loadPromise;
  }

  function show(container, opts) {
    if (!container) return;
    activeContainer = container;
    detailSection = opts && DETAIL_SECTIONS.indexOf(opts.section) !== -1
      ? opts.section : "details";
    mode = {
      kind: (opts && opts.siteCode) ? "single" : "all",
      siteCode: opts ? opts.siteCode : null,
      merged: !!(opts && opts.merged)
    };
    // BOM is its own page (parts inventory); it reads /api/bom, not the plant catalogue.
    if (detailSection === "bom" && global.Solar91PortalBom) {
      global.Solar91PortalBom.show(container, { siteCode: mode.siteCode });
      return;
    }
    // Design/MDL: the design folder link and drawing index, read from the plant's custom_fields.
    if (detailSection === "design-mdl" && global.Solar91PortalDesign) {
      global.Solar91PortalDesign.show(container, { siteCode: mode.siteCode });
      return;
    }
    // Liasoning: LOA, PPA, tariff and the land-lease / commissioning document links.
    if (detailSection === "liasoning" && global.Solar91PortalLiasoning) {
      global.Solar91PortalLiasoning.show(container, { siteCode: mode.siteCode });
      return;
    }
    if (loaded) {
      render(container);
      return;
    }
    container.innerHTML = '<div class="ep-pt__loading">Loading plants…</div>';
    ensureLoaded().then(function () {
      render(container);
    }).catch(function (err) {
      container.innerHTML = '<div class="ep-pt__error">Could not load the plant catalogue. ' +
                            fmt.escape(err && err.message ? err.message : "") + "</div>";
    });
  }

  global.Solar91PortalPlantsTable = { show: show };
}(window));
