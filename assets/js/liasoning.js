/**
 * liasoning.js
 * ---------------------------------------------------------------------
 * Liasoning: per-plant contract and document record, laid out like the Details page.
 *
 *   Plants -> <plant> -> Details -> Liasoning    one row, this plant
 *   Views  -> Details -> Liasoning               one row per plant (search, SPV and district filters, CSV)
 *
 * Columns: Site Code | LOA | PPA | Tariff | Registered Land Lease | Commissioning Documents (+ Edit).
 *   LOA and PPA are dates, Tariff is a number (the Rs/Unit unit is in the column heading, not the cell);
 *   the last two are links to a folder or document held outside the portal.
 *
 * Stored on the plant record, no extra table:
 *   custom_fields.liasoning = { loa_date, ppa_date, tariff, land_lease_url, commissioning_docs_url }
 * Roles holding plants.manage get an Edit button; that writes through the existing PATCH
 * /api/plants/:id, merged over the freshly read custom_fields so design_link, cctv_url and other
 * keys survive. The API enforces the permission and, for roles that may not open document links
 * (everyone except O&M Head, Assignee and Administration), leaves this record out of the plant data.
 */
(function (global) {
  "use strict";

  var data = global.Solar91PortalData;
  var fmt = global.Solar91PortalFormat;

  var COLUMNS = [
    { key: "code", label: "Site Code" },
    { key: "loa", label: "LOA", align: "num" },
    { key: "ppa", label: "PPA", align: "num" },
    { key: "tariff", label: "Tariff (Rs/Unit)", align: "num" },
    { key: "land", label: "Registered Land Lease", align: "num" },
    { key: "commissioning", label: "Commissioning Documents", align: "num" }
  ];
  var VIEWER_ROLES = ["O&M Head", "Assignee", "Administration"];
  var MAX_TARIFF = 1000;

  var mode = { kind: "all", siteCode: null };
  var ui = { search: "", spv: "__all", district: "__all" };
  var st = { rows: [] };
  var token = 0, searchTimer = null;

  function api() { return global.Solar91PortalAPI; }
  function canEdit() { return !!(api() && api().can("plants.manage")); }
  function canOpenLinks() {
    var user = api() && api().currentUser();
    return !!(user && VIEWER_ROLES.indexOf(user.role) !== -1);
  }
  function single() { return mode.kind === "single"; }

  // --- Stored values (read tolerantly) --------------------------------------
  function record(plant) {
    var c = plant && plant.customFields;
    var r = c && typeof c === "object" && !Array.isArray(c) ? c.liasoning : null;
    return r && typeof r === "object" && !Array.isArray(r) ? r : {};
  }

  function isoDate(value) {
    var m = String(value == null ? "" : value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return "";
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m[0] : "";
  }
  function showDate(value) {
    var iso = isoDate(value);
    return iso ? iso.slice(8) + "-" + iso.slice(5, 7) + "-" + iso.slice(0, 4) : "";
  }
  function tariffOf(plant) {
    var raw = record(plant).tariff;
    if (raw === null || raw === undefined || raw === "") return null;
    var n = Number(raw);
    return isFinite(n) && n >= 0 ? n : null;
  }
  function showTariff(n) { return n === null ? "" : String(Math.round(n * 1000) / 1000); }

  // Only real web links become clickable; anything else (javascript:, junk) is ignored.
  function linkOf(plant, key) {
    if (!canOpenLinks()) return "";
    return webLink(record(plant)[key]);
  }
  function webLink(value) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      var url = new URL(value.trim());
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch (e) { return ""; }
  }

  // --- Rendering --------------------------------------------------------------
  function placeholder(text) { return '<span class="ep-pt__dash">' + (text || "—") + "</span>"; }

  function linkCell(plant, key, label) {
    var href = linkOf(plant, key);
    if (href) {
      return '<a class="ep-pt__loc" href="' + fmt.escape(href) + '" target="_blank" rel="noopener noreferrer" title="Open ' +
        fmt.escape(label) + ' in a new tab">Open ↗</a>';
    }
    return '<span class="ep-pt__cctv-placeholder">' + (canOpenLinks() ? "Not added" : "Restricted") + "</span>";
  }

  var EDIT_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';

  function rowHTML(entry, editor) {
    var p = entry.plant, r = record(p), tariff = tariffOf(p);
    return "<tr>" +
      '<td class="ep-pt__codecell"><span class="ep-pt__code">' + fmt.escape(p.siteCode) + '</span><span class="ep-pt__name">' +
        fmt.escape(p.displayName || p.plantName) + "</span></td>" +
      '<td class="num mono">' + (isoDate(r.loa_date) ? fmt.escape(showDate(r.loa_date)) : placeholder()) + "</td>" +
      '<td class="num mono">' + (isoDate(r.ppa_date) ? fmt.escape(showDate(r.ppa_date)) : placeholder()) + "</td>" +
      '<td class="num mono">' + (tariff === null ? placeholder() : fmt.escape(showTariff(tariff))) + "</td>" +
      '<td class="num">' + linkCell(p, "land_lease_url", "the registered land lease") + "</td>" +
      '<td class="num">' + linkCell(p, "commissioning_docs_url", "the commissioning documents") + "</td>" +
      (editor ? '<td class="num"><button class="ep-pt__edit" type="button" data-lia-edit="' + fmt.escape(p.siteCode) +
        '" aria-label="Edit Liasoning of ' + fmt.escape(p.siteCode) + '">' + EDIT_ICON + "Edit</button></td>" : "") +
      "</tr>";
  }

  function visibleRows() {
    if (single()) return st.rows.filter(function (r) { return r.plant.siteCode === mode.siteCode; });
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
        '<input type="text" placeholder="Search plant code, name, project, district..." data-lia-search value="' + fmt.escape(ui.search) + '" autocomplete="off" /></div>' +
      '<select class="ep-pt__select" data-lia-filter="spv" aria-label="Filter by SPV or project"><option value="__all">All SPV</option>' +
        opts(spvs, ui.spv, function (v) {
          var row = st.rows.filter(function (r) { return r.plant.projectCompany === v; })[0];
          return (row && row.plant.projectCompanyShort) || v;
        }) + "</select>" +
      '<select class="ep-pt__select" data-lia-filter="district" aria-label="Filter by district"><option value="__all">All districts</option>' +
        opts(distinct("district").sort(), ui.district) + "</select></div>";
  }

  function render(container) {
    var focusSearch = document.activeElement && document.activeElement.hasAttribute && document.activeElement.hasAttribute("data-lia-search");
    var pos = focusSearch ? document.activeElement.selectionStart : 0;
    var rows = visibleRows(), one = single(), editor = canEdit();
    var plant = one && rows[0] ? rows[0].plant : null;
    var cols = COLUMNS.length + (editor ? 1 : 0);
    var title = one ? (plant ? fmt.escape(plant.displayName || plant.plantName) + " · Liasoning" : "Liasoning") : "Liasoning";
    var sub = one ? (plant ? fmt.escape(plant.siteCode) + " · " + fmt.escape(plant.district || "") : "") : st.rows.length + " plants";
    var count = one ? "This plant" : (rows.length === st.rows.length ? "All " + st.rows.length + " plants" : rows.length + " of " + st.rows.length + " plants");

    container.innerHTML = '<div class="ep-pt ep-lia"><div class="ep-pt__head"><h1 class="ep-pt__title">' + title + '</h1><p class="ep-pt__sub">' + sub + "</p></div>" +
      '<div class="ep-pt__card">' + (one ? "" : toolbarHTML()) +
        '<div class="ep-pt__meta"><span class="ep-pt__count">' + count + '</span><span class="ep-pt__spacer"></span>' +
          '<span class="ep-ma__status" data-lia-status role="status" aria-live="polite"></span>' +
          (one ? "" : '<button class="ep-pt__export" type="button" data-lia-export>CSV</button>') + "</div>" +
        '<div class="ep-pt__table-wrap"><div class="ep-pt__scroll" tabindex="0" role="region" aria-label="Liasoning by plant">' +
          '<table class="ep-pt__table ep-lia__table' + (editor ? " has-edit" : "") + '"><thead><tr>' +
            COLUMNS.map(function (c) { return "<th" + (c.align === "num" ? ' class="num"' : "") + ">" + c.label + "</th>"; }).join("") +
            (editor ? '<th class="num">Edit</th>' : "") + "</tr></thead><tbody>" +
            (rows.length ? rows.map(function (r) { return rowHTML(r, editor); }).join("")
              : '<tr><td colspan="' + cols + '" class="ep-pt__empty">' +
                (one ? "This plant was not found, or it is outside your assigned scope." : (st.rows.length ? "No plants match these filters." : "No plants to show.")) + "</td></tr>") +
          "</tbody></table></div></div></div></div>";
    wire(container);
    if (focusSearch) {
      var again = container.querySelector("[data-lia-search]");
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
    }
  }

  function setStatus(container, text, isError) {
    var el = container.querySelector("[data-lia-status]");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  // --- Edit dialog (PATCH /api/plants/:id with the merged custom_fields) ------
  var FIELDS = [
    { key: "loa_date", label: "LOA date", type: "date" },
    { key: "ppa_date", label: "PPA date", type: "date" },
    { key: "tariff", label: "Tariff (Rs/Unit)", type: "number", step: "0.001", min: "0", max: String(MAX_TARIFF) },
    { key: "land_lease_url", label: "Registered Land Lease link", type: "url", full: true, placeholder: "https://…" },
    { key: "commissioning_docs_url", label: "Commissioning Documents link", type: "url", full: true, placeholder: "https://…" }
  ];

  function openEditor(container, siteCode) {
    var entry = st.rows.filter(function (r) { return r.plant.siteCode === siteCode; })[0];
    if (!entry || document.querySelector(".ep-lia__overlay")) return;
    var plant = entry.plant, r = record(plant), saving = false;
    var overlay = document.createElement("div");
    overlay.className = "ep-pd__overlay ep-lia__overlay";
    overlay.innerHTML = '<form class="ep-pd__modal" role="dialog" aria-modal="true" aria-labelledby="lia-edit-title" novalidate>' +
      '<header class="ep-pd__modal-head"><div><h2 id="lia-edit-title">Liasoning · ' + fmt.escape(plant.displayName || plant.plantName) + "</h2>" +
        '<p class="ep-pd__mono">' + fmt.escape(plant.siteCode) + '</p></div><button class="ep-pd__x" type="button" data-lia-close aria-label="Close">×</button></header>' +
      '<div class="ep-pd__modal-body">' + FIELDS.map(function (f) {
        var value = f.type === "date" ? isoDate(r[f.key]) : (r[f.key] == null ? "" : String(r[f.key]));
        return '<label class="ep-pd__field' + (f.full ? " ep-lia__full" : "") + '"><span>' + fmt.escape(f.label) + '</span><input name="' + f.key + '" type="' + f.type + '"' +
          (f.step ? ' step="' + f.step + '"' : "") + (f.min ? ' min="' + f.min + '"' : "") + (f.max ? ' max="' + f.max + '"' : "") +
          (f.placeholder ? ' placeholder="' + fmt.escape(f.placeholder) + '"' : "") + ' value="' + fmt.escape(value) + '" autocomplete="off" /></label>';
      }).join("") + "</div>" +
      '<p class="ep-pd__form-error" data-lia-error role="alert"></p>' +
      '<footer class="ep-pd__modal-foot"><button class="ep-pd__btn" type="button" data-lia-close>Cancel</button>' +
        '<button class="ep-pd__btn ep-pd__btn--primary" type="submit">Save changes</button></footer></form>';
    document.body.appendChild(overlay);
    var form = overlay.querySelector("form"), errorEl = overlay.querySelector("[data-lia-error]");
    var submit = form.querySelector('[type="submit"]');
    function close() { if (!saving) overlay.remove(); }
    overlay.addEventListener("click", function (ev) { if (ev.target === overlay) close(); });
    overlay.querySelectorAll("[data-lia-close]").forEach(function (b) { b.addEventListener("click", close); });
    overlay.addEventListener("keydown", function (ev) { if (ev.key === "Escape") close(); });

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (saving) return;                                   // no double submissions
      var next = {}, bad = "";
      FIELDS.forEach(function (f) {
        var raw = String(form.elements[f.key].value || "").trim();
        if (!raw) return;                                   // blank clears the value
        if (f.type === "date") { if (!isoDate(raw)) bad = bad || f.label + " is not a valid date."; else next[f.key] = raw; }
        else if (f.type === "number") {
          var n = Number(raw);
          if (!isFinite(n) || n < 0 || n > MAX_TARIFF) bad = bad || "Tariff must be a number between 0 and " + MAX_TARIFF + ".";
          else next[f.key] = Math.round(n * 1000) / 1000;
        } else { var link = webLink(raw); if (!link) bad = bad || f.label + " must start with http:// or https://."; else next[f.key] = link; }
      });
      if (bad) { errorEl.textContent = bad; return; }
      saving = true; submit.disabled = true; submit.textContent = "Saving…"; errorEl.textContent = "";
      var saved = false;
      // Merge over the latest stored custom_fields (not this page's copy) so a key changed elsewhere is not lost.
      api().plants(true).then(function (list) {
        var fresh = (list || []).filter(function (p) { return p.dbId === plant.dbId; })[0] || plant;
        var merged = Object.assign({}, fresh.customFields || {});
        merged.liasoning = next;
        return api().request("/api/plants/" + encodeURIComponent(plant.dbId), { method: "PATCH", body: { custom_fields: merged } });
      }).then(function () {
        saved = true;
        data.invalidate();
        api().plants(true).catch(function () {});
        return data.fetchPortfolio(true);
      }).then(function (portfolio) {
        st.rows = portfolio.rows || [];
        saving = false; overlay.remove();
        if (container.isConnected) { render(container); setStatus(container, "Saved."); }
      }).catch(function (err) {
        saving = false;
        if (saved) {                                        // the save itself worked; only the refresh failed
          overlay.remove();
          if (container.isConnected) setStatus(container, "Saved, but the page could not refresh. Reload to see it.", true);
          return;
        }
        submit.disabled = false; submit.textContent = "Save changes";
        errorEl.textContent = "Not saved. " + (err && err.message ? err.message : "Please retry.");
      });
    });
    var first = form.querySelector("input");
    if (first) first.focus();
  }

  // --- Export -----------------------------------------------------------------
  function exportCSV() {
    var canLinks = canOpenLinks();
    var header = ["Site Code", "Plant Name", "LOA", "PPA", "Tariff (Rs/Unit)", "Registered Land Lease", "Commissioning Documents"];
    var body = visibleRows().map(function (e) {
      var p = e.plant, r = record(p), t = tariffOf(p);
      return [p.siteCode, p.displayName || p.plantName, showDate(r.loa_date), showDate(r.ppa_date), t === null ? "" : t,
        canLinks ? linkOf(p, "land_lease_url") : "", canLinks ? linkOf(p, "commissioning_docs_url") : ""];
    });
    var csv = [header].concat(body).map(function (row) {
      return row.map(function (c) { var s = fmt.csvText(c); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",");
    }).join("\r\n");
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "solar91-liasoning.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  // --- Wiring -----------------------------------------------------------------
  function wire(container) {
    var search = container.querySelector("[data-lia-search]");
    if (search) search.addEventListener("input", function () {
      ui.search = search.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { searchTimer = null; if (container.isConnected) render(container); }, 120);
    });
    container.querySelectorAll("[data-lia-filter]").forEach(function (sel) {
      sel.addEventListener("change", function () { ui[sel.getAttribute("data-lia-filter")] = sel.value; render(container); });
    });
    var exp = container.querySelector("[data-lia-export]");
    if (exp) exp.addEventListener("click", exportCSV);
    container.querySelectorAll("[data-lia-edit]").forEach(function (btn) {
      btn.addEventListener("click", function () { openEditor(container, btn.getAttribute("data-lia-edit")); });
    });
  }

  // --- Public entry point -----------------------------------------------------
  function show(container, opts) {
    if (!container) return;
    var mine = ++token;
    mode = { kind: (opts && opts.siteCode) ? "single" : "all", siteCode: opts ? opts.siteCode : null };
    ui = { search: "", spv: "__all", district: "__all" };
    container.innerHTML = '<div class="ep-pt__loading">Loading Liasoning…</div>';
    return data.fetchPortfolio().then(function (portfolio) {
      if (mine !== token) return;                           // a newer page replaced this one
      st.rows = portfolio.rows || [];
      if (container.isConnected) render(container);
    }).catch(function (err) {
      if (mine !== token) return;
      container.innerHTML = '<div class="ep-pt__error">Could not load Liasoning. ' + fmt.escape(err && err.message ? err.message : "") + "</div>";
    });
  }

  global.Solar91PortalLiasoning = { show: show, COLUMNS: COLUMNS };
}(window));
