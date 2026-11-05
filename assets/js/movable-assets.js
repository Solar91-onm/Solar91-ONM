/**
 * movable-assets.js
 * ---------------------------------------------------------------------
 * Movable Assets: one row per plant, one column per part, each cell the number
 * of units of that part the plant holds.
 *
 *   Views -> Movable Assets   every plant's row (search, SPV, district, part filters)
 *   Plant -> Movable Assets   that plant's single row
 *
 * Same look as the Details table (it reuses the ep-pt__ classes). Data comes from
 * GET /api/movable-assets; roles holding plants.manage can edit a cell, add a part
 * column or remove one. The API enforces every permission; the UI only hides buttons.
 */
(function (global) {
  "use strict";

  var data = global.Solar91PortalData;
  var fmt = global.Solar91PortalFormat;

  var state = { rows: [], parts: [], units: {} };   // units[siteCode][part] = number
  var mode = { kind: "all", siteCode: null };
  var ui = { search: "", spv: "__all", district: "__all", part: "__all", sort: "name" };
  var searchTimer = null;
  var busy = false;

  function api() { return global.Solar91PortalAPI; }
  function canEdit() { return !!(api() && api().can("plants.manage")); }

  // --- Data -----------------------------------------------------------
  function load() {
    var url = "/api/movable-assets" +
      (mode.kind === "single" ? "?site_code=" + encodeURIComponent(mode.siteCode) : "");
    return Promise.all([data.fetchPortfolio(), api().request(url)]).then(function (res) {
      state.rows = res[0].rows || [];
      state.parts = (res[1] && res[1].parts) || [];
      state.units = {};
      ((res[1] && res[1].records) || []).forEach(function (r) {
        (state.units[r.siteCode] = state.units[r.siteCode] || {})[r.part] = r.units;
      });
    });
  }

  function unitsOf(siteCode, part) {
    var byPlant = state.units[siteCode];
    return byPlant && typeof byPlant[part] === "number" ? byPlant[part] : null;
  }

  function total(siteCode, parts) {
    return parts.reduce(function (sum, part) { return sum + (unitsOf(siteCode, part) || 0); }, 0);
  }

  function shownParts() {
    return ui.part !== "__all" && state.parts.indexOf(ui.part) !== -1 ? [ui.part] : state.parts;
  }

  function visibleRows() {
    if (mode.kind === "single") {
      return state.rows.filter(function (r) { return r.plant.siteCode === mode.siteCode; });
    }
    var term = ui.search.trim().toLowerCase();
    var parts = shownParts();
    var rows = state.rows.filter(function (r) {
      var p = r.plant;
      if (term && [p.siteCode, p.displayCode, p.plantName, p.displayName || "", p.projectCompany || "",
                   p.district || ""].join(" ").toLowerCase().indexOf(term) === -1) return false;
      if (ui.spv !== "__all" && (p.projectCompany || "") !== ui.spv) return false;
      if (ui.district !== "__all" && (p.district || "") !== ui.district) return false;
      return true;
    });
    rows.sort(function (a, b) {
      if (ui.sort === "code") return a.plant.siteCode.localeCompare(b.plant.siteCode);
      if (ui.sort === "total") return total(b.plant.siteCode, parts) - total(a.plant.siteCode, parts);
      return (a.plant.displayName || a.plant.plantName).localeCompare(b.plant.displayName || b.plant.plantName);
    });
    return rows;
  }

  // --- Rendering ------------------------------------------------------
  function opts(list, selected, label) {
    return list.map(function (v) {
      return '<option value="' + fmt.escape(v) + '"' + (selected === v ? " selected" : "") + ">" +
        fmt.escape(label ? label(v) : v) + "</option>";
    }).join("");
  }

  function toolbarHTML() {
    var spvs = [], seenSpv = {}, districts = [], seenDist = {};
    state.rows.forEach(function (r) {
      var s = r.plant.projectCompany || "", d = r.plant.district || "";
      if (s && !seenSpv[s]) { seenSpv[s] = 1; spvs.push(s); }
      if (d && !seenDist[d]) { seenDist[d] = 1; districts.push(d); }
    });
    spvs.sort(function (a, b) {
      return parseInt((a.match(/\d+/) || ["0"])[0], 10) - parseInt((b.match(/\d+/) || ["0"])[0], 10);
    });
    districts.sort();
    return '<div class="ep-pt__toolbar">' +
      '<div class="ep-pt__search">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>' +
        '<input type="text" placeholder="Search plant code, name, project, district..." data-ma-search value="' +
          fmt.escape(ui.search) + '" autocomplete="off" /></div>' +
      '<select class="ep-pt__select" data-ma-filter="spv" aria-label="Filter by SPV or project">' +
        '<option value="__all">All SPV</option>' +
        opts(spvs, ui.spv, function (v) {
          var row = state.rows.find(function (r) { return r.plant.projectCompany === v; });
          return (row && row.plant.projectCompanyShort) || v;
        }) + "</select>" +
      '<select class="ep-pt__select" data-ma-filter="district" aria-label="Filter by district">' +
        '<option value="__all">All districts</option>' + opts(districts, ui.district) + "</select>" +
      '<select class="ep-pt__select" data-ma-filter="part" aria-label="Show one part">' +
        '<option value="__all">All parts</option>' + opts(state.parts, ui.part) + "</select>" +
      '<select class="ep-pt__select" data-ma-filter="sort" aria-label="Sort rows">' +
        '<option value="name"' + (ui.sort === "name" ? " selected" : "") + ">Sort: name</option>" +
        '<option value="code"' + (ui.sort === "code" ? " selected" : "") + ">Sort: plant code</option>" +
        '<option value="total"' + (ui.sort === "total" ? " selected" : "") + ">Sort: total units</option>" +
      "</select></div>";
  }

  function cellHTML(siteCode, part, index) {
    var value = unitsOf(siteCode, part);
    if (canEdit()) {
      return '<td class="num"><input class="ep-ma__cell" type="number" min="0" max="1000000" step="1" inputmode="numeric"' +
        ' data-ma-cell data-site="' + fmt.escape(siteCode) + '" data-part="' + index + '"' +
        ' value="' + (value === null ? "" : value) + '" placeholder="—"' +
        ' aria-label="Units of ' + fmt.escape(part) + " at " + fmt.escape(siteCode) + '"></td>';
    }
    return '<td class="num mono">' + (value === null ? '<span class="ep-pt__dash">—</span>' : fmt.formatNumber(value)) + "</td>";
  }

  function render(container) {
    var rows = visibleRows();
    var single = mode.kind === "single";
    var parts = shownParts();
    var plant = single && rows[0] ? rows[0].plant : null;
    var editor = canEdit();
    var colCount = parts.length + 2;

    var head = '<th>Plant Code</th>' + parts.map(function (part) {
      return '<th class="num"><span class="ep-ma__part">' + fmt.escape(part) + "</span>" +
        (editor ? '<button type="button" class="ep-ma__remove" data-ma-remove="' +
          state.parts.indexOf(part) + '" aria-label="Remove part ' + fmt.escape(part) + '" title="Remove this part">&times;</button>' : "") +
        "</th>";
    }).join("") + '<th class="num">Total</th>';

    var body = rows.map(function (entry) {
      var p = entry.plant;
      return "<tr>" +
        '<td class="ep-pt__codecell"><span class="ep-pt__code">' + fmt.escape(p.siteCode) + "</span>" +
          '<span class="ep-pt__name">' + fmt.escape(p.displayName || p.plantName) + "</span></td>" +
        parts.map(function (part) { return cellHTML(p.siteCode, part, state.parts.indexOf(part)); }).join("") +
        '<td class="num mono" data-ma-total="' + fmt.escape(p.siteCode) + '">' + fmt.formatNumber(total(p.siteCode, parts)) + "</td>" +
      "</tr>";
    }).join("");

    var empty = !parts.length
      ? (editor ? 'No parts yet. Use "Add part" to create the first column.' : "No movable assets have been added yet.")
      : (single ? "This plant was not found, or it is outside your assigned scope." : "No plants match these filters.");

    container.innerHTML = '<div class="ep-pt">' +
      '<div class="ep-pt__head"><h1 class="ep-pt__title">' +
        (single ? (plant ? fmt.escape(plant.displayName || plant.plantName) + " · Movable Assets" : "Movable Assets") : "Movable Assets") +
        "</h1>" +
        '<p class="ep-pt__sub">' + (single ? (plant ? fmt.escape(plant.siteCode) + " · " + fmt.escape(plant.district || "") : "")
          : state.rows.length + " plants · " + state.parts.length + " parts") + "</p></div>" +
      '<div class="ep-pt__card">' + (single ? "" : toolbarHTML()) +
        '<div class="ep-pt__meta"><span class="ep-pt__count">' +
          (single ? "This plant" : (rows.length === state.rows.length ? "All " + state.rows.length + " plants"
            : rows.length + " of " + state.rows.length + " plants")) + "</span>" +
          '<span class="ep-pt__spacer"></span>' +
          '<span class="ep-ma__status" data-ma-status role="status" aria-live="polite"></span>' +
          (editor ? '<button class="ep-pt__export" type="button" data-ma-add>+ Add part</button>' : "") +
          (single ? "" : '<button class="ep-pt__export" type="button" data-ma-export="csv">CSV</button>' +
            '<button class="ep-pt__export" type="button" data-ma-export="excel">Excel</button>') +
        "</div>" +
        '<div class="ep-pt__table-wrap"><div class="ep-pt__scroll" tabindex="0" role="region" aria-label="Movable assets table">' +
          '<table class="ep-pt__table"><thead><tr>' + head + "</tr></thead><tbody>" +
          (rows.length && parts.length ? body
            : '<tr><td colspan="' + colCount + '" class="ep-pt__empty">' + empty + "</td></tr>") +
          "</tbody></table></div></div></div></div>";
    wire(container);
  }

  // --- Actions --------------------------------------------------------
  function setStatus(container, text, isError) {
    var el = container.querySelector("[data-ma-status]");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function reload(container) {
    return load().then(function () { if (container.isConnected) render(container); });
  }

  function saveCell(container, input) {
    var site = input.getAttribute("data-site");
    var part = state.parts[Number(input.getAttribute("data-part"))];
    var raw = input.value.trim();
    var previous = unitsOf(site, part);
    if (raw === "" || !/^\d+$/.test(raw) || Number(raw) > 1000000) {
      input.value = previous === null ? "" : previous;
      setStatus(container, "Enter a whole number from 0 to 1,000,000.", true);
      return;
    }
    var units = Number(raw);
    if (units === previous) return;
    input.disabled = true;
    setStatus(container, "Saving…");
    api().request("/api/movable-assets", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site_code: site, part: part, units: units })
    }).then(function () {
      (state.units[site] = state.units[site] || {})[part] = units;
      var cell = container.querySelector('[data-ma-total="' + site + '"]');
      if (cell) cell.textContent = fmt.formatNumber(total(site, shownParts()));
      setStatus(container, "Saved.");
    }).catch(function (err) {
      input.value = previous === null ? "" : previous;
      setStatus(container, "Could not save: " + (err && err.message ? err.message : "try again"), true);
    }).then(function () { input.disabled = false; });
  }

  function addPart(container) {
    if (busy) return;
    var name = global.prompt("Part name (for example: Ladder, Multimeter, Laptop):");
    if (name === null) return;
    name = name.replace(/\s+/g, " ").trim();
    if (!name) return;
    busy = true;
    setStatus(container, "Adding…");
    api().request("/api/movable-assets/parts", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ part: name })
    }).then(function () { return reload(container); })
      .then(function () { setStatus(container, "Part added. Enter the units for each plant."); })
      .catch(function (err) { setStatus(container, "Could not add: " + (err && err.message ? err.message : "try again"), true); })
      .then(function () { busy = false; });
  }

  function removePart(container, index) {
    var part = state.parts[index];
    if (busy || !part) return;
    if (!global.confirm('Remove the part "' + part + '" and its unit counts for every plant you can access?')) return;
    busy = true;
    api().request("/api/movable-assets/parts?part=" + encodeURIComponent(part), { method: "DELETE" })
      .then(function () { if (ui.part === part) ui.part = "__all"; return reload(container); })
      .catch(function (err) { setStatus(container, "Could not remove: " + (err && err.message ? err.message : "try again"), true); })
      .then(function () { busy = false; });
  }

  // --- Export ---------------------------------------------------------
  function exportRows() {
    var parts = shownParts();
    var rows = visibleRows().map(function (entry) {
      var p = entry.plant;
      return [p.siteCode, p.displayName || p.plantName].concat(parts.map(function (part) {
        var v = unitsOf(p.siteCode, part); return v === null ? "" : v;
      }), [total(p.siteCode, parts)]);
    });
    return [["Plant Code", "Plant Name"].concat(parts, ["Total"])].concat(rows);
  }

  function download(filename, mime, text) {
    var blob = new Blob(["﻿" + text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function exportFile(kind) {
    var table = exportRows();
    if (kind === "csv") {
      download("solar91-movable-assets.csv", "text/csv;charset=utf-8;", table.map(function (row) {
        return row.map(function (cell) {
          var s = fmt.csvText(cell);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }).join(",");
      }).join("\r\n"));
      return;
    }
    download("solar91-movable-assets.xls", "application/vnd.ms-excel;charset=utf-8;",
      '<html><head><meta charset="utf-8"></head><body><table border="1">' + table.map(function (row, i) {
        var tag = i === 0 ? "th" : "td";
        return "<tr>" + row.map(function (c) { return "<" + tag + ">" + fmt.escape(fmt.csvText(c)) + "</" + tag + ">"; }).join("") + "</tr>";
      }).join("") + "</table></body></html>");
  }

  // --- Wiring ---------------------------------------------------------
  function wire(container) {
    var search = container.querySelector("[data-ma-search]");
    if (search) search.addEventListener("input", function () {
      ui.search = search.value;
      var pos = search.selectionStart;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        searchTimer = null;
        if (!container.isConnected) return;
        render(container);
        var again = container.querySelector("[data-ma-search]");
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
      }, 120);
    });
    container.querySelectorAll("[data-ma-filter]").forEach(function (sel) {
      sel.addEventListener("change", function () { ui[sel.getAttribute("data-ma-filter")] = sel.value; render(container); });
    });
    container.querySelectorAll("[data-ma-export]").forEach(function (btn) {
      btn.addEventListener("click", function () { exportFile(btn.getAttribute("data-ma-export")); });
    });
    container.querySelectorAll("[data-ma-cell]").forEach(function (input) {
      input.addEventListener("change", function () { saveCell(container, input); });
      input.addEventListener("keydown", function (ev) { if (ev.key === "Enter") input.blur(); });
    });
    var add = container.querySelector("[data-ma-add]");
    if (add) add.addEventListener("click", function () { addPart(container); });
    container.querySelectorAll("[data-ma-remove]").forEach(function (btn) {
      btn.addEventListener("click", function () { removePart(container, Number(btn.getAttribute("data-ma-remove"))); });
    });
  }

  // --- Public entry point ---------------------------------------------
  function show(container, opts) {
    if (!container) return;
    mode = { kind: (opts && opts.siteCode) ? "single" : "all", siteCode: opts ? opts.siteCode : null };
    container.innerHTML = '<div class="ep-pt__loading">Loading movable assets…</div>';
    load().then(function () {
      if (container.isConnected) render(container);
    }).catch(function (err) {
      container.innerHTML = '<div class="ep-pt__error">Could not load movable assets. ' +
        fmt.escape(err && err.message ? err.message : "") + "</div>";
    });
  }

  global.Solar91PortalMovableAssets = { show: show };
}(window));
