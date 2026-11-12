/**
 * design.js
 * ---------------------------------------------------------------------
 * Design/MDL: each plant's design drawings ("site execution") folder and an index of the
 * standard drawings showing which are present and which are not.
 *
 *   Plant -> Details -> Design/MDL    the folder link + the full drawing index (Key + Miscellaneous)
 *   Views -> Details -> Design/MDL    one row per plant: folder, present count, the Key drawings, Misc count
 *
 * Stored on the plant record, no extra table:
 *   custom_fields.design_link  = folder URL (string)
 *   custom_fields.design_index = { "<drawingId>": true }   (absent or false = not added)
 * Both are read tolerantly; a plant with neither still renders the full page with "Not added".
 * Roles holding plants.manage can tick drawings on the plant page; that writes through the
 * existing PATCH /api/plants/:id, merged over the freshly read custom_fields so cctv_url and
 * other keys survive. The API enforces the permission; the UI only hides the button.
 */
(function (global) {
  "use strict";

  var data = global.Solar91PortalData;
  var fmt = global.Solar91PortalFormat;

  // The drawing register. Edit here to add, rename or reorder drawings; ids are the stored keys.
  var REGISTER = [
    { id: "ga", label: "GA Layout", section: "key" },
    { id: "sld", label: "Plant SLD", section: "key" },
    { id: "dc_layout", label: "DC Cable Layout", section: "key" },
    { id: "dc_sld", label: "DC SLD", section: "key" },
    { id: "inv_group", label: "Inverter Grouping Layout", section: "key" },
    { id: "piling", label: "MMS / Piling Layout", section: "key" },
    { id: "earthing", label: "Earthing Layout", section: "key" },
    { id: "ac_trench", label: "AC Cable Trench", section: "key" },
    { id: "switchyard", label: "Switchyard Layout", section: "key" },
    { id: "tl_route", label: "TL Final Route", section: "key" },
    { id: "land", label: "Land", section: "misc" },
    { id: "boundary", label: "Boundary Wall", section: "misc" },
    { id: "fencing", label: "Chain-Link Fencing", section: "misc" },
    { id: "gate", label: "Main Gate", section: "misc" },
    { id: "dc_trench", label: "DC Cable Trench", section: "misc" },
    { id: "dc_string", label: "DC String Report", section: "misc" },
    { id: "piling_coord", label: "Piling Coordinates", section: "misc" },
    { id: "structure", label: "Structure Assembly", section: "misc" },
    { id: "inv_stand", label: "Inverter Stand", section: "misc" },
    { id: "aux_sld", label: "Aux-Supply SLD", section: "misc" },
    { id: "tx_foundation", label: "Transformer Foundation", section: "misc" },
    { id: "vcb_foundation", label: "VCB Foundation", section: "misc" },
    { id: "accb_foundation", label: "ACCB Foundation", section: "misc" },
    { id: "four_pole", label: "33KV Four-Pole", section: "misc" },
    { id: "gss_bay", label: "GSS Bay", section: "misc" },
    { id: "earthing_equip", label: "Earthing Equipment Layout", section: "misc" },
    { id: "earthing_trench", label: "Earthing Trench", section: "misc" },
    { id: "rs485", label: "RS485 Cable Layout", section: "misc" },
    { id: "periphery_light", label: "Periphery Light", section: "misc" },
    { id: "drainage", label: "Water Drainage", section: "misc" },
    { id: "drainage_contour", label: "Water Drainage w/ Contour", section: "misc" },
    { id: "water_pipe", label: "Water Pipe Line", section: "misc" }
  ];
  var KEY = REGISTER.filter(function (d) { return d.section === "key"; });
  var MISC = REGISTER.filter(function (d) { return d.section === "misc"; });

  var mode = { kind: "all", siteCode: null };
  var ui = { search: "", spv: "__all", district: "__all" };
  var st = { rows: [], editing: false, saving: false, draft: null };
  var token = 0, searchTimer = null;

  function api() { return global.Solar91PortalAPI; }
  function canEdit() { return !!(api() && api().can("plants.manage")); }
  // Only these roles may open the site-execution folder. The server also leaves the link
  // out of plant records for everyone else (app/core/security.py DESIGN_LINK_ROLES).
  var FOLDER_ROLES = ["O&M Head", "Assignee", "Administration"];
  function canOpenFolder() {
    var user = api() && api().currentUser();
    return !!(user && FOLDER_ROLES.indexOf(user.role) !== -1);
  }
  var RESTRICTED_NOTE = "Only O&M Head, Assignee and Administration can open this folder";
  function single() { return mode.kind === "single"; }

  // --- Stored values (read tolerantly) --------------------------------------
  function custom(plant) {
    var c = plant && plant.customFields;
    return c && typeof c === "object" && !Array.isArray(c) ? c : {};
  }

  // Only real web links become clickable; anything else (javascript:, junk) stays plain text.
  function designLink(plant) {
    if (!canOpenFolder()) return "";
    var value = custom(plant).design_link;
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      var url = new URL(value.trim());
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch (e) { return ""; }
  }

  function isYes(v) { return v === true || v === 1 || /^(true|yes|y|1)$/i.test(String(v == null ? "" : v).trim()); }

  // The stored index as a plain object; a list of ids is accepted too.
  function rawIndex(plant) {
    var raw = custom(plant).design_index, out = {};
    if (Array.isArray(raw)) raw.forEach(function (id) { if (typeof id === "string") out[id] = true; });
    else if (raw && typeof raw === "object") Object.keys(raw).forEach(function (k) { out[k] = raw[k]; });
    return out;
  }

  function present(plant) {
    var raw = rawIndex(plant), has = {};
    REGISTER.forEach(function (d) { has[d.id] = isYes(raw[d.id]); });
    return has;
  }

  function countIn(list, has) { return list.filter(function (d) { return has[d.id]; }).length; }

  // --- Rendering --------------------------------------------------------------
  function tick(on, compact) {
    return on
      ? '<span class="ep-dsn__tick is-present" title="Present">✓' + (compact ? "" : " Present") + "</span>"
      : '<span class="ep-dsn__tick is-absent" title="Not added">' + (compact ? "" : "✕ ") + "Not added</span>";
  }

  function codeLink(plant, big) {
    var href = designLink(plant);
    var cls = big ? "ep-dsn__code" : "ep-pt__code ep-dsn__codelink";
    return href
      ? '<a class="' + cls + '" href="' + fmt.escape(href) + '" target="_blank" rel="noopener noreferrer" title="Open the design folder in a new tab">' +
          fmt.escape(plant.siteCode) + (big ? " ↗" : "") + "</a>"
      : '<span class="' + cls + ' is-plain">' + fmt.escape(plant.siteCode) + "</span>";
  }

  function headHTML(title, sub) {
    return '<div class="ep-pt__head"><h1 class="ep-pt__title">' + title + '</h1><p class="ep-pt__sub">' + sub + "</p></div>";
  }

  function sectionRows(label, list, has, editing, cls) {
    return '<tr class="ep-dsn__section ep-dsn__section--' + cls + '"><th colspan="2" scope="colgroup">' + label +
        '<span class="ep-dsn__section-count">' + countIn(list, has) + "/" + list.length + "</span></th></tr>" +
      list.map(function (d) {
        var status = editing
          ? '<label class="ep-dsn__check"><input type="checkbox" data-dsn-check="' + d.id + '"' + (has[d.id] ? " checked" : "") +
              ' aria-label="' + fmt.escape(d.label) + ' added" /><span>Added</span></label>'
          : tick(has[d.id]);
        return '<tr class="ep-dsn__row ep-dsn__row--' + cls + '"><td class="ep-dsn__drawing">' + fmt.escape(d.label) + '</td><td class="num">' + status + "</td></tr>";
      }).join("");
  }

  function renderSingle(container) {
    var row = st.rows.filter(function (r) { return r.plant.siteCode === mode.siteCode; })[0];
    if (!row) {
      container.innerHTML = '<div class="ep-pt ep-dsn">' + headHTML("Design/MDL", "") +
        '<div class="ep-pt__card"><div class="ep-pt__empty">This plant was not found, or it is outside your assigned scope.</div></div></div>';
      return;
    }
    var p = row.plant, editor = canEdit(), editing = editor && st.editing;
    var count = countIn(REGISTER, present(p));
    var has = editing && st.draft ? st.draft : present(p);   // a failed save keeps the operator's ticks
    var controls = !editor ? "" : (editing
      ? '<button class="ep-pt__export" type="button" data-dsn-cancel' + (st.saving ? " disabled" : "") + ">Cancel</button>" +
        '<button class="ep-pd__btn ep-pd__btn--primary" type="button" data-dsn-save' + (st.saving ? " disabled" : "") + ">" + (st.saving ? "Saving…" : "Save") + "</button>"
      : '<button class="ep-pt__export" type="button" data-dsn-edit>Edit</button>');

    container.innerHTML = '<div class="ep-pt ep-dsn">' +
      headHTML(fmt.escape(p.displayName || p.plantName) + " · Design/MDL", fmt.escape(p.siteCode) + " · " + fmt.escape(p.district || "")) +
      '<div class="ep-pt__card ep-dsn__folder">' +
        '<div class="ep-dsn__folder-main"><span class="ep-dsn__eyebrow">Design / site-execution folder</span>' + codeLink(p, true) +
          (designLink(p) ? "" : '<span class="ep-dsn__nolink">' + (canOpenFolder() ? "Link not added yet" : fmt.escape(RESTRICTED_NOTE)) + "</span>") + "</div>" +
        '<div class="ep-dsn__counter"><strong>' + count + "</strong>/" + REGISTER.length + " present</div></div>" +
      '<div class="ep-pt__card">' +
        '<div class="ep-pt__meta"><span class="ep-pt__count">Drawing index</span><span class="ep-pt__spacer"></span>' +
          '<span class="ep-ma__status" data-dsn-status role="status" aria-live="polite"></span>' + controls + "</div>" +
        '<div class="ep-pt__table-wrap"><div class="ep-pt__scroll" tabindex="0" role="region" aria-label="Design drawing index">' +
          '<table class="ep-pt__table ep-dsn__table is-single' + (editing ? " is-editing" : "") + '"><thead><tr><th>Drawing</th><th class="num">Status</th></tr></thead><tbody>' +
            sectionRows("Key drawings", KEY, has, editing, "key") + sectionRows("Miscellaneous", MISC, has, editing, "misc") +
          "</tbody></table></div></div></div></div>";
  }

  function visibleRows() {
    var term = ui.search.trim().toLowerCase();
    return st.rows.filter(function (r) {
      var p = r.plant;
      if (term && [p.siteCode, p.displayName || "", p.plantName || "", p.projectCompany || "", p.district || ""].join(" ").toLowerCase().indexOf(term) === -1) return false;
      if (ui.spv !== "__all" && (p.projectCompany || "") !== ui.spv) return false;
      if (ui.district !== "__all" && (p.district || "") !== ui.district) return false;
      return true;
    }).sort(function (a, b) { return a.plant.siteCode.localeCompare(b.plant.siteCode); });
  }

  function opts(list, selected, label) {
    return list.map(function (v) {
      return '<option value="' + fmt.escape(v) + '"' + (selected === v ? " selected" : "") + ">" + fmt.escape(label ? label(v) : v) + "</option>";
    }).join("");
  }

  function distinct(key) {
    var out = [], seen = {};
    st.rows.forEach(function (r) { var v = r.plant[key] || ""; if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
    return out;
  }

  function toolbarHTML() {
    var spvs = distinct("projectCompany").sort(function (a, b) {
      return parseInt((a.match(/\d+/) || ["0"])[0], 10) - parseInt((b.match(/\d+/) || ["0"])[0], 10);
    });
    return '<div class="ep-pt__toolbar"><div class="ep-pt__search"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>' +
        '<input type="text" placeholder="Search plant code, name, project, district..." data-dsn-search value="' + fmt.escape(ui.search) + '" autocomplete="off" /></div>' +
      '<select class="ep-pt__select" data-dsn-filter="spv" aria-label="Filter by SPV or project"><option value="__all">All SPV</option>' +
        opts(spvs, ui.spv, function (v) {
          var row = st.rows.filter(function (r) { return r.plant.projectCompany === v; })[0];
          return (row && row.plant.projectCompanyShort) || v;
        }) + "</select>" +
      '<select class="ep-pt__select" data-dsn-filter="district" aria-label="Filter by district"><option value="__all">All districts</option>' +
        opts(distinct("district").sort(), ui.district) + "</select></div>";
  }

  function portfolioRowHTML(r) {
    var p = r.plant, has = present(p), href = designLink(p);
    return "<tr>" +
      '<td class="ep-pt__codecell ep-dsn__sticky">' + codeLink(p, false) + '<span class="ep-pt__name">' + fmt.escape(p.displayName || p.plantName) + "</span></td>" +
      "<td>" + (href ? '<a class="ep-pt__loc" href="' + fmt.escape(href) + '" target="_blank" rel="noopener noreferrer" title="Open the design folder in a new tab">Open ↗</a>'
        : '<span class="ep-pt__cctv-placeholder"' + (canOpenFolder() ? ">Not set" : ' title="' + fmt.escape(RESTRICTED_NOTE) + '">Restricted') + "</span>") + "</td>" +
      '<td class="num mono">' + countIn(REGISTER, has) + "/" + REGISTER.length + "</td>" +
      KEY.map(function (d) { return '<td class="num">' + tick(has[d.id], true) + "</td>"; }).join("") +
      '<td class="num mono">' + countIn(MISC, has) + "/" + MISC.length + "</td></tr>";
  }

  function renderPortfolio(container) {
    var rows = visibleRows(), cols = 4 + KEY.length;
    var count = rows.length === st.rows.length ? "All " + st.rows.length + " plants" : rows.length + " of " + st.rows.length + " plants";
    container.innerHTML = '<div class="ep-pt ep-dsn">' + headHTML("Design/MDL", st.rows.length + " plants") +
      '<div class="ep-pt__card">' + toolbarHTML() +
        '<div class="ep-pt__meta"><span class="ep-pt__count">' + count + '</span><span class="ep-pt__spacer"></span>' +
          '<button class="ep-pt__export" type="button" data-dsn-export>CSV</button></div>' +
        '<div class="ep-pt__table-wrap"><div class="ep-pt__scroll" tabindex="0" role="region" aria-label="Design drawings by plant">' +
          '<table class="ep-pt__table ep-dsn__table is-portfolio"><thead><tr>' +
            '<th class="ep-dsn__sticky">Plant Code</th><th>Folder</th><th class="num">Present</th>' +
            KEY.map(function (d) { return '<th class="num ep-dsn__keyhead">' + fmt.escape(d.label) + "</th>"; }).join("") +
            '<th class="num">Misc</th></tr></thead><tbody>' +
            (rows.length ? rows.map(portfolioRowHTML).join("")
              : '<tr><td colspan="' + cols + '" class="ep-pt__empty">' + (st.rows.length ? "No plants match these filters." : "No plants to show.") + "</td></tr>") +
          "</tbody></table></div></div></div></div>";
  }

  function render(container) {
    var focusSearch = document.activeElement && document.activeElement.hasAttribute && document.activeElement.hasAttribute("data-dsn-search");
    var pos = focusSearch ? document.activeElement.selectionStart : 0;
    if (single()) renderSingle(container); else renderPortfolio(container);
    wire(container);
    if (focusSearch) {
      var again = container.querySelector("[data-dsn-search]");
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
    }
  }

  // --- Save (PATCH /api/plants/:id with the merged custom_fields) --------------
  function setStatus(container, text, isError) {
    var el = container.querySelector("[data-dsn-status]");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function save(container) {
    var row = st.rows.filter(function (r) { return r.plant.siteCode === mode.siteCode; })[0];
    if (st.saving || !row) return;                         // no double submissions
    var picked = {};
    container.querySelectorAll("[data-dsn-check]").forEach(function (cb) { picked[cb.getAttribute("data-dsn-check")] = cb.checked; });
    st.draft = picked;
    st.saving = true;
    render(container);
    var saved = false;
    // Merge over the latest stored custom_fields (not this page's copy) so a key changed elsewhere is not lost.
    api().plants(true).then(function (list) {
      var fresh = (list || []).filter(function (p) { return p.dbId === row.plant.dbId; })[0] || row.plant;
      var merged = Object.assign({}, custom(fresh));
      var index = rawIndex(fresh);                         // ids outside the register are kept as stored
      REGISTER.forEach(function (d) { if (picked[d.id]) index[d.id] = true; else delete index[d.id]; });
      merged.design_index = index;
      return api().request("/api/plants/" + encodeURIComponent(row.plant.dbId), { method: "PATCH", body: { custom_fields: merged } });
    }).then(function () {
      saved = true;
      data.invalidate();
      api().plants(true).catch(function () {});
      return data.fetchPortfolio(true);
    }).then(function (portfolio) {
      st.rows = portfolio.rows || [];
      st.saving = false; st.editing = false; st.draft = null;
      if (container.isConnected) { render(container); setStatus(container, "Saved."); }
    }).catch(function (err) {
      st.saving = false;
      if (saved) { st.editing = false; st.draft = null; }
      if (!container.isConnected) return;
      render(container);
      setStatus(container, saved ? "Saved, but the page could not refresh. Reload to see it." :
        "Not saved. " + (err && err.message ? err.message : "Please retry."), !saved);
    });
  }

  // --- Export -----------------------------------------------------------------
  function exportCSV() {
    var header = ["Plant Code", "Plant Name", "Folder Link", "Present"].concat(KEY.map(function (d) { return d.label; })).concat(["Misc Present"]);
    var body = visibleRows().map(function (r) {
      var p = r.plant, has = present(p);
      return [p.siteCode, p.displayName || p.plantName, designLink(p), countIn(REGISTER, has) + "/" + REGISTER.length]
        .concat(KEY.map(function (d) { return has[d.id] ? "Present" : "Not added"; }))
        .concat([countIn(MISC, has) + "/" + MISC.length]);
    });
    var csv = [header].concat(body).map(function (row) {
      return row.map(function (c) { var s = fmt.csvText(c); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",");
    }).join("\r\n");
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "solar91-design-mdl.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  // --- Wiring -----------------------------------------------------------------
  function wire(container) {
    var search = container.querySelector("[data-dsn-search]");
    if (search) search.addEventListener("input", function () {
      ui.search = search.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { searchTimer = null; if (container.isConnected) render(container); }, 120);
    });
    container.querySelectorAll("[data-dsn-filter]").forEach(function (sel) {
      sel.addEventListener("change", function () { ui[sel.getAttribute("data-dsn-filter")] = sel.value; render(container); });
    });
    var exp = container.querySelector("[data-dsn-export]");
    if (exp) exp.addEventListener("click", exportCSV);
    var edit = container.querySelector("[data-dsn-edit]");
    if (edit) edit.addEventListener("click", function () { st.editing = true; st.draft = null; render(container); });
    var cancel = container.querySelector("[data-dsn-cancel]");
    if (cancel) cancel.addEventListener("click", function () { if (!st.saving) { st.editing = false; st.draft = null; render(container); } });
    var saveBtn = container.querySelector("[data-dsn-save]");
    if (saveBtn) saveBtn.addEventListener("click", function () { save(container); });
  }

  // --- Public entry point -----------------------------------------------------
  function show(container, opts) {
    if (!container) return;
    var mine = ++token;
    mode = { kind: (opts && opts.siteCode) ? "single" : "all", siteCode: opts ? opts.siteCode : null };
    ui = { search: "", spv: "__all", district: "__all" };
    st = { rows: st.rows, editing: false, saving: false, draft: null };
    container.innerHTML = '<div class="ep-pt__loading">Loading Design/MDL…</div>';
    return data.fetchPortfolio().then(function (portfolio) {
      if (mine !== token) return;                          // a newer page replaced this one
      st.rows = portfolio.rows || [];
      if (container.isConnected) render(container);
    }).catch(function (err) {
      if (mine !== token) return;
      container.innerHTML = '<div class="ep-pt__error">Could not load Design/MDL. ' + fmt.escape(err && err.message ? err.message : "") + "</div>";
    });
  }

  global.Solar91PortalDesign = { show: show, REGISTER: REGISTER };
}(window));
