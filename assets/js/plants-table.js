/**
 * plants-table.js
 * ─────────────────────────────────────────────────────────────────────
 * The portfolio plant grid (Views → Details): every plant the signed-in user
 * may see, in one sortable, searchable, exportable table.
 *
 * Every column is read from the database through the portal API. Site Engineers
 * come from the plant assignment table and the washing assignee from the washing
 * configuration, so the people columns reflect real access, not free text.
 *
 * "Edit" writes through PATCH /api/plants/:id and is only offered to roles that
 * hold plants.manage. The same table, in single mode, is one plant's Details
 * page: that plant's row and nothing else. The editor lives in plant-details.js.
 */
(function (global) {
  "use strict";

  var data = global.Solar91PortalData;
  var fmt = global.Solar91PortalFormat;

  var allRows = [];            // [{ plant, profile }]
  var loadPromise = null;
  var loaded = false;
  var searchTimer = null;
  var mode = { kind: "all", siteCode: null };
  var detailSection = "details";
  var ui = { search: "", spv: "__all", district: "__all", sort: "name" };
  var DETAIL_SECTIONS = ["details", "design-mdl", "purchase", "liasoning", "bom"];
  var DETAIL_SECTION_LABELS = {
    details: "Details",
    "design-mdl": "Design/MDL",
    purchase: "Purchase",
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
  function visibleRows() {
    if (mode.kind === "single") {
      return allRows.filter(function (r) { return r.plant.siteCode === mode.siteCode; });
    }

    var term = ui.search.trim().toLowerCase();
    var rows = allRows.filter(function (r) {
      var p = r.plant;
      if (term) {
        var hay = [
          p.siteCode, p.displayCode, p.plantName, p.displayName || "",
          p.projectCompany || "", p.district || "", p.discom || "",
          (p.siteEngineers || []).join(" "), p.washingAssignee || "", p.location || ""
        ].join(" ").toLowerCase();
        if (hay.indexOf(term) === -1) return false;
      }
      if (ui.spv !== "__all" && (p.projectCompany || "") !== ui.spv) return false;
      if (ui.district !== "__all" && (p.district || "") !== ui.district) return false;
      return true;
    });

    rows.sort(function (a, b) {
      switch (ui.sort) {
        case "code":      return a.plant.siteCode.localeCompare(b.plant.siteCode);
        case "ac":        return (b.plant.acCapacityKw || 0) - (a.plant.acCapacityKw || 0);
        case "dc":        return (b.plant.dcCapacityKw || 0) - (a.plant.dcCapacityKw || 0);
        case "cod":       return String(b.plant.commissionedOn || "").localeCompare(String(a.plant.commissionedOn || ""));
        default:          return (a.plant.displayName || a.plant.plantName)
                                   .localeCompare(b.plant.displayName || b.plant.plantName);
      }
    });
    return rows;
  }

  // ─── Columns (fixed order, both views) ───────────────────────────────
  var COLUMNS = [
    { key: "code",      label: "Plant Code" },
    { key: "spv",       label: "SPV", align: "num" },
    { key: "ac",        label: "AC (KW)",       align: "num" },
    { key: "dc",        label: "DC (KWP)",      align: "num" },
    { key: "district",  label: "District" },
    { key: "discom",    label: "Discom" },
    { key: "engineer",  label: "Site Engineer" },
    { key: "assignee",  label: "Assignee" },
    { key: "cod",       label: "COD",           align: "num" },
    { key: "location",  label: "Location" },
    { key: "cctv",      label: "CCTV" },
    { key: "activity",  label: "Last Activity" },
    { key: "edit",      label: "Edit",          align: "num" }
  ];

  function canEdit() {
    return !!(global.Solar91PortalAPI && global.Solar91PortalAPI.can("plants.manage"));
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
    return "" +
      "<tr>" +
        '<td class="ep-pt__codecell">' +
          '<span class="ep-pt__code">' + fmt.escape(p.siteCode) + "</span>" +
          '<span class="ep-pt__name">' + fmt.escape(p.displayName || p.plantName) + "</span>" +
        "</td>" +
        '<td class="num"><span class="ep-pt__spv">' + fmt.escape(spvNumber(p)) + "</span></td>" +
        '<td class="num mono">' + numText(p.acCapacityKw) + "</td>" +
        '<td class="num mono">' + numText(p.dcCapacityKw) + "</td>" +
        "<td>" + (p.district ? fmt.escape(p.district) : dash()) + "</td>" +
        "<td>" + (p.discom ? fmt.escape(p.discom) : dash()) + "</td>" +
        "<td>" + ((p.siteEngineers && p.siteEngineers.length)
            ? fmt.escape(p.siteEngineers.join(", "))
            : (p.assignedEngineer ? fmt.escape(p.assignedEngineer) : dash("No Site Engineer assigned"))) + "</td>" +
        "<td>" + (p.washingAssignee ? fmt.escape(p.washingAssignee) : dash("Module Cleaning not set up")) + "</td>" +
        '<td class="num mono">' + fmt.escape(formatCOD(p.commissionedOn)) + "</td>" +
        locationCell +
        cctvCell +
        '<td class="mono">' + fmt.escape(lastActivity(entry.profile)) + "</td>" +
        '<td class="num">' +
          (canEdit()
            ? '<button class="ep-pt__edit" type="button" data-edit-plant="' + p.siteCode + '">' +
                '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>' +
                "Edit</button>"
            : dash("Your role cannot edit plant records")) +
        "</td>" +
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
        '<select class="ep-pt__select" data-pt-filter="sort" aria-label="Sort rows">' +
          '<option value="name"' +      (ui.sort === "name"      ? " selected" : "") + ">Sort: name</option>" +
          '<option value="code"' +      (ui.sort === "code"      ? " selected" : "") + ">Sort: plant code</option>" +
          '<option value="ac"' +        (ui.sort === "ac"        ? " selected" : "") + ">Sort: AC capacity</option>" +
          '<option value="dc"' +        (ui.sort === "dc"        ? " selected" : "") + ">Sort: DC capacity</option>" +
          '<option value="cod"' +       (ui.sort === "cod"       ? " selected" : "") + ">Sort: COD (newest)</option>" +
        "</select>" +
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

  function renderTable(container) {
    var rows = visibleRows();
    var single = mode.kind === "single";
    var plant = single && rows[0] ? rows[0].plant : null;

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

    container.innerHTML = "" +
      '<div class="ep-pt">' +
        '<div class="ep-pt__head">' +
          '<h1 class="ep-pt__title">' + title + "</h1>" +
          '<p class="ep-pt__sub">' + subtitle + "</p>" +
        "</div>" +

        (detailSection === "details"
          ? '<div class="ep-pt__card">' +
          // One plant has nothing to search, filter or sort.
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

          '<div class="ep-pt__table-wrap">' +
            '<div class="ep-pt__scroll" data-pt-scroll tabindex="0" role="region" aria-label="' +
              (single ? "Plant details" : "Plant details table; scroll vertically to see more plants") + '">' +
              '<table class="ep-pt__table">' +
              "<thead><tr>" +
                COLUMNS.map(function (c) {
                  var cls = c.align === "num" ? ' class="num"' : "";
                  return "<th" + cls + ">" + c.label + "</th>";
                }).join("") +
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
          "</div>" +
        "</div>"
          : '<section class="ep-pt__detail-empty" data-detail-section="' +
            detailSection + '" aria-label="' + fmt.escape(DETAIL_SECTION_LABELS[detailSection]) + '"></section>') +
      "</div>";

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
        section: detailSection
      });
    });
  }

  // ─── Export ──────────────────────────────────────────────────────────
  function exportRows() {
    var header = COLUMNS.filter(function (c) { return c.key !== "edit"; })
                        .map(function (c) { return c.label; });
    var body = visibleRows().map(function (entry) {
      var p = entry.plant;
      return [
        p.siteCode + " " + (p.displayName || p.plantName),
        spvNumber(p),
        p.acCapacityKw === null || p.acCapacityKw === undefined ? "" : p.acCapacityKw,
        p.dcCapacityKw === null || p.dcCapacityKw === undefined ? "" : p.dcCapacityKw,
        p.district || "",
        p.discom || "",
        (p.siteEngineers || []).join("; ") || p.assignedEngineer || "",
        p.washingAssignee || "",
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
    detailSection = opts && DETAIL_SECTIONS.indexOf(opts.section) !== -1
      ? opts.section : "details";
    mode = {
      kind: (opts && opts.siteCode) ? "single" : "all",
      siteCode: opts ? opts.siteCode : null
    };
    // BOM is its own page (parts inventory); it reads /api/bom, not the plant catalogue.
    if (detailSection === "bom" && global.Solar91PortalBom) {
      global.Solar91PortalBom.show(container, { siteCode: mode.siteCode });
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
