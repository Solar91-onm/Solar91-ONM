/**
 * bom.js
 * ---------------------------------------------------------------------
 * Bill of Materials: the parts inventory of the solar plants. One row per part line:
 *
 *   Item Name | Maker/Supplier | Quantity | Specs | T.R. | W.C. | Item Serial No. | Invoice
 *
 *   Views -> Details -> BOM    every plant's lines (search, plant, SPV and maker filters), a Plant column
 *   Plant -> Details -> BOM    that plant's lines only
 *
 * Same look as the Details and Movable Assets tables (ep-pt__ classes). Data comes from GET /api/bom,
 * filtered and paged on the server. Roles holding plants.manage can add, edit and remove lines
 * (POST/PUT/DELETE /api/bom); the API enforces every permission and refuses a stale save (409),
 * the UI only hides buttons.
 */
(function (global) {
  "use strict";

  var data = global.Solar91PortalData;
  var fmt = global.Solar91PortalFormat;

  var PAGE = 200;
  var EXPORT_CAP = 5000;
  var COLS = [
    { key: "itemName", label: "Item Name" },
    { key: "makerSupplier", label: "Maker/Supplier" },
    { key: "quantity", label: "Quantity", num: true },
    { key: "specs", label: "Specs" },
    { key: "testReport", label: "T.R." },
    { key: "warrantyCert", label: "W.C." },
    { key: "serialNo", label: "Item Serial No." },
    { key: "invoice", label: "Invoice" }
  ];

  var mode = { kind: "all", siteCode: null };
  var ui = { search: "", plant: "__all", spv: "__all", maker: "__all" };
  var st = { items: [], total: 0, makers: [], plants: [], loading: false, error: "", more: false };
  var token = 0, searchTimer = null, busy = false;

  function api() { return global.Solar91PortalAPI; }
  function canEdit() { return !!(api() && api().can("plants.manage")); }
  function single() { return mode.kind === "single"; }

  // --- Data -----------------------------------------------------------
  function query(offset, limit) {
    var q = ["limit=" + limit, "offset=" + offset];
    if (single()) q.push("site_code=" + encodeURIComponent(mode.siteCode));
    else {
      if (ui.plant !== "__all") q.push("site_code=" + encodeURIComponent(ui.plant));
      if (ui.spv !== "__all") q.push("spv=" + encodeURIComponent(ui.spv));
    }
    if (ui.maker !== "__all") q.push("maker=" + encodeURIComponent(ui.maker));
    if (ui.search.trim()) q.push("q=" + encodeURIComponent(ui.search.trim()));
    return "/api/bom?" + q.join("&");
  }

  function plantName(siteCode) {
    var row = st.plants.filter(function (r) { return r.plant.siteCode === siteCode; })[0];
    return row ? (row.plant.displayName || row.plant.plantName) : "";
  }

  // Fetch the first page (reset) or the next one (append). A newer request makes older replies ignored.
  function load(container, append) {
    var mine = ++token;
    st.loading = true; st.error = "";
    if (container.isConnected) render(container, true);
    return api().request(query(append ? st.items.length : 0, PAGE)).then(function (res) {
      if (mine !== token) return;
      st.items = append ? st.items.concat(res.items || []) : (res.items || []);
      st.total = res.total || 0;
      st.makers = res.makers || [];
      st.loading = false;
      st.more = st.items.length < st.total;
    }).catch(function (err) {
      if (mine !== token) return;
      st.loading = false;
      st.error = (err && err.message) ? err.message : "Please retry.";
    }).then(function () { if (mine === token && container.isConnected) render(container, true); });
  }

  // --- Rendering ------------------------------------------------------
  function opts(list, selected, label) {
    return list.map(function (v) {
      return '<option value="' + fmt.escape(v) + '"' + (selected === v ? " selected" : "") + ">" + fmt.escape(label ? label(v) : v) + "</option>";
    }).join("");
  }

  function filtersActive() {
    return !!(ui.search.trim() || ui.plant !== "__all" || ui.spv !== "__all" || ui.maker !== "__all");
  }

  function toolbarHTML() {
    var spvs = [], seen = {};
    st.plants.forEach(function (r) {
      var s = r.plant.projectCompany || "";
      if (s && !seen[s]) { seen[s] = 1; spvs.push(s); }
    });
    spvs.sort(function (a, b) {
      return parseInt((a.match(/\d+/) || ["0"])[0], 10) - parseInt((b.match(/\d+/) || ["0"])[0], 10);
    });
    var plants = st.plants.filter(function (r) { return ui.spv === "__all" || r.plant.projectCompany === ui.spv; })
      .sort(function (a, b) { return a.plant.siteCode.localeCompare(b.plant.siteCode); });
    var search = '<div class="ep-pt__search"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>' +
      '<input type="text" placeholder="Search item, maker, specs, serial, invoice..." data-bom-search value="' + fmt.escape(ui.search) + '" autocomplete="off" /></div>';
    var maker = '<select class="ep-pt__select" data-bom-filter="maker" aria-label="Filter by maker or supplier"><option value="__all">All makers</option>' +
      opts(st.makers, ui.maker) + "</select>";
    var clear = filtersActive() ? '<button type="button" class="ep-pt__export" data-bom-clear>Clear filters</button>' : "";
    if (single()) return '<div class="ep-pt__toolbar">' + search + maker + clear + "</div>";
    return '<div class="ep-pt__toolbar">' + search +
      '<select class="ep-pt__select" data-bom-filter="spv" aria-label="Filter by SPV or project"><option value="__all">All SPV</option>' +
        opts(spvs, ui.spv, function (v) {
          var row = st.plants.filter(function (r) { return r.plant.projectCompany === v; })[0];
          return (row && row.plant.projectCompanyShort) || v;
        }) + "</select>" +
      '<select class="ep-pt__select" data-bom-filter="plant" aria-label="Filter by plant"><option value="__all">All plants</option>' +
        opts(plants.map(function (r) { return r.plant.siteCode; }), ui.plant, function (c) { return c + " · " + plantName(c); }) + "</select>" +
      maker + clear + "</div>";
  }

  var EDIT_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';

  // Only real web links become clickable; anything else (javascript:, data:, junk) is shown as plain text.
  function safeUrl(value) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      var url = new URL(value.trim());
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch (e) { return ""; }
  }

  // Invoice cell: the invoice number (or "View invoice") as a link that opens the stored URL in a new tab.
  function invoiceCell(item) {
    var href = safeUrl(item.invoiceUrl);
    if (href) return '<td><a class="ep-pt__loc ep-bom__invoice" href="' + fmt.escape(href) + '" target="_blank" rel="noopener noreferrer" title="Open invoice in a new tab">' +
      fmt.escape(item.invoice || "View invoice") + " ↗</a></td>";
    return cell(item.invoice);
  }

  // Every column gets the same share of the frame, so the table is evenly spaced, symmetrical and never scrolls sideways.
  function colgroupHTML(editor) {
    var n = COLS.length + (single() ? 0 : 1) + (editor ? 1 : 0);
    return "<colgroup>" + new Array(n + 1).join('<col style="width:' + (100 / n).toFixed(3) + '%">') + "</colgroup>";
  }

  function cell(value, cls) {
    var has = value !== null && value !== undefined && value !== "";
    return "<td" + (cls ? ' class="' + cls + '"' : "") + ">" + (has ? fmt.escape(String(value)) : '<span class="ep-pt__dash">—</span>') + "</td>";
  }

  function rowHTML(item, editor) {
    return "<tr>" +
      '<td class="ep-bom__item">' + fmt.escape(item.itemName) + "</td>" +
      cell(item.makerSupplier) +
      '<td class="num mono">' + (item.quantity === null ? '<span class="ep-pt__dash">—</span>' : fmt.formatNumber(item.quantity)) + "</td>" +
      cell(item.specs, "ep-bom__specs") + cell(item.testReport) + cell(item.warrantyCert) +
      cell(item.serialNo, "mono") + invoiceCell(item) +
      (single() ? "" : '<td><span class="ep-pt__code">' + fmt.escape(item.siteCode) + '</span><span class="ep-pt__name">' + fmt.escape(plantName(item.siteCode)) + "</span></td>") +
      (editor ? '<td class="num ep-bom__actions"><button class="ep-pt__edit" type="button" data-bom-edit="' + fmt.escape(item.id) + '" aria-label="Edit ' +
        fmt.escape(item.itemName) + '">' + EDIT_ICON + 'Edit</button><button class="ep-bom__del" type="button" data-bom-del="' + fmt.escape(item.id) +
        '" aria-label="Remove ' + fmt.escape(item.itemName) + '" title="Remove this line">&times;</button></td>' : "") +
      "</tr>";
  }

  function render(container, keepScroll) {
    var old = keepScroll ? container.querySelector(".ep-bom__scroll") : null;
    var keepTop = old ? old.scrollTop : 0, keepLeft = old ? old.scrollLeft : 0;
    var focusSearch = document.activeElement && document.activeElement.hasAttribute && document.activeElement.hasAttribute("data-bom-search");
    var pos = focusSearch ? document.activeElement.selectionStart : 0;
    var editor = canEdit();
    var plant = single() ? st.plants.filter(function (r) { return r.plant.siteCode === mode.siteCode; })[0] : null;
    plant = plant ? plant.plant : null;
    var colCount = COLS.length + (single() ? 0 : 1) + (editor ? 1 : 0);

    var head = COLS.map(function (c) { return "<th>" + c.label + "</th>"; }).join("") +
      (single() ? "" : "<th>Plant</th>") + (editor ? "<th>Edit</th>" : "");
    var body;
    if (st.error) body = '<tr><td colspan="' + colCount + '" class="ep-pt__empty is-error">Could not load BOM lines. ' + fmt.escape(st.error) + "</td></tr>";
    else if (st.loading && !st.items.length) body = '<tr><td colspan="' + colCount + '" class="ep-pt__empty">Loading BOM…</td></tr>';
    else if (!st.items.length) body = '<tr><td colspan="' + colCount + '" class="ep-pt__empty">' +
      (filtersActive() ? "No BOM lines match these filters." :
        (editor ? 'No BOM lines yet. Use "+ Add item" to list the first part.' : "No BOM lines have been added yet.")) + "</td></tr>";
    else body = st.items.map(function (i) { return rowHTML(i, editor); }).join("");

    var count = st.loading && !st.items.length ? "" :
      (st.items.length < st.total ? "Showing " + st.items.length + " of " + st.total + " lines" :
        st.total + (st.total === 1 ? " line" : " lines"));

    container.innerHTML = '<div class="ep-pt ep-bom">' +
      '<div class="ep-pt__head">' + (single() && plant ? '<h1 class="ep-pt__title">' + fmt.escape(plant.displayName || plant.plantName) + " · BOM</h1>" : (single() ? "" : '<h1 class="ep-pt__title">BOM</h1>')) +
        '<p class="ep-pt__sub">' + (single() ? (plant ? fmt.escape(plant.siteCode) + " · " + fmt.escape(plant.district || "") : "") : st.plants.length + " plants") + "</p></div>" +
      '<div class="ep-pt__card">' + toolbarHTML() +
        '<div class="ep-pt__meta"><span class="ep-pt__count">' + count + "</span><span class=\"ep-pt__spacer\"></span>" +
          '<span class="ep-ma__status" data-bom-status role="status" aria-live="polite"></span>' +
          (editor ? '<button class="ep-pt__export" type="button" data-bom-add>+ Add item</button>' : "") +
          '<button class="ep-pt__export" type="button" data-bom-export="csv">CSV</button>' +
          '<button class="ep-pt__export" type="button" data-bom-export="excel">Excel</button></div>' +
        '<div class="ep-pt__table-wrap"><div class="ep-pt__scroll ep-bom__scroll" tabindex="0" role="region" aria-label="BOM table">' +
          '<table class="ep-pt__table ep-bom__table' + (single() ? " is-single" : "") + (editor ? " has-actions" : "") + '">' + colgroupHTML(editor) + "<thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table></div></div>" +
        (st.more && !st.error ? '<div class="ep-bom__more"><button type="button" class="ep-pt__export" data-bom-more' + (st.loading ? " disabled" : "") + ">" +
          (st.loading ? "Loading…" : "Load more (" + (st.total - st.items.length) + " left)") + "</button></div>" : "") +
      "</div></div>";
    wire(container);
    var scroller = container.querySelector(".ep-bom__scroll");
    if (scroller && keepScroll) { scroller.scrollTop = keepTop; scroller.scrollLeft = keepLeft; }
    if (focusSearch) {
      var again = container.querySelector("[data-bom-search]");
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
    }
  }

  // --- Actions --------------------------------------------------------
  function setStatus(container, text, isError) {
    var el = container.querySelector("[data-bom-status]");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function findItem(id) { return st.items.filter(function (i) { return i.id === id; })[0]; }

  // One dialog for add and edit. `item` is null when adding.
  function openEditor(container, item, trigger) {
    var siteCode = item ? item.siteCode : null;
    var plantField = "";
    if (!item) {
      if (single()) siteCode = mode.siteCode;
      else plantField = '<label class="ep-pd__field ep-bom__wide"><span>Plant</span><select data-bom-field="site_code" required><option value="">Select a plant…</option>' +
        opts(st.plants.map(function (r) { return r.plant.siteCode; }).sort(), ui.plant !== "__all" ? ui.plant : "",
          function (c) { return c + " · " + plantName(c); }) + "</select></label>";
    }
    function f(key, label, max, value, extra) {
      return '<label class="ep-pd__field' + (extra || "") + '"><span>' + label + '</span><input type="text" maxlength="' + max + '" data-bom-field="' + key + '" value="' +
        fmt.escape(value == null ? "" : String(value)) + '" autocomplete="off" /></label>';
    }
    var v = item || {};
    var overlay = document.createElement("div");
    overlay.className = "ep-pd__overlay";
    overlay.innerHTML = '<form class="ep-pd__modal ep-bom__modal" role="dialog" aria-modal="true" aria-labelledby="bom-edit-title" novalidate>' +
      '<header class="ep-pd__modal-head"><div><h2 id="bom-edit-title">' + (item ? "Edit BOM item" : "Add BOM item") + "</h2>" +
        '<p class="ep-pd__mono">' + fmt.escape(siteCode ? siteCode + " · " + plantName(siteCode) : "Choose the plant this part belongs to") + "</p></div>" +
        '<button class="ep-pd__x" type="button" data-bom-close aria-label="Close">×</button></header>' +
      '<div class="ep-bom__modal-body">' + plantField +
        f("item_name", "Item Name *", 200, v.itemName, " ep-bom__wide") + f("maker_supplier", "Maker/Supplier", 160, v.makerSupplier) +
        '<label class="ep-pd__field"><span>Quantity</span><input type="number" min="0" max="1000000" step="1" inputmode="numeric" data-bom-field="quantity" value="' +
          (v.quantity == null ? "" : v.quantity) + '" /></label>' +
        '<label class="ep-pd__field ep-bom__wide"><span>Specs</span><textarea rows="3" maxlength="2000" data-bom-field="specs">' + fmt.escape(v.specs || "") + "</textarea></label>" +
        f("test_report", "T.R.", 200, v.testReport) + f("warranty_cert", "W.C.", 200, v.warrantyCert) +
        f("serial_no", "Item Serial No.", 120, v.serialNo) + f("invoice", "Invoice", 200, v.invoice) +
        '<label class="ep-pd__field ep-bom__wide"><span>Invoice link (web address that opens the invoice)</span><input type="url" maxlength="1000" placeholder="https://..." data-bom-field="invoice_url" value="' +
          fmt.escape(v.invoiceUrl || "") + '" autocomplete="off" /></label></div>' +
      '<p class="ep-pd__form-error" role="alert"></p>' +
      '<footer class="ep-pd__modal-foot"><button class="ep-pd__btn" type="button" data-bom-close>Cancel</button>' +
        '<button class="ep-pd__btn ep-pd__btn--primary" type="submit">' + (item ? "Save changes" : "Add item") + "</button></footer></form>";
    document.body.appendChild(overlay);

    var form = overlay.querySelector("form"), errorEl = overlay.querySelector(".ep-pd__form-error"), saving = false;
    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
      if (trigger && trigger.isConnected) trigger.focus();
    }
    function onKey(ev) { if (ev.key === "Escape" && !saving) close(); }
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", function (ev) {
      if (!saving && (ev.target === overlay || ev.target.closest("[data-bom-close]"))) close();
    });
    function val(key) { var el = form.querySelector('[data-bom-field="' + key + '"]'); return el ? el.value.trim() : ""; }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (saving) return;                                  // no double submissions
      errorEl.textContent = "";
      var code = siteCode || val("site_code");
      if (!code) { errorEl.textContent = "Choose a plant."; return; }
      if (!val("item_name")) { errorEl.textContent = "Item Name is required."; return; }
      var qty = val("quantity");
      if (qty !== "" && (!/^\d+$/.test(qty) || Number(qty) > 1000000)) { errorEl.textContent = "Quantity must be a whole number from 0 to 1,000,000."; return; }
      var link = val("invoice_url");
      if (link && !safeUrl(link)) { errorEl.textContent = "Invoice link must start with http:// or https://"; return; }
      var body = { invoice_url: link, item_name: val("item_name"), maker_supplier: val("maker_supplier"), quantity: qty === "" ? null : Number(qty),
        specs: val("specs"), test_report: val("test_report"), warranty_cert: val("warranty_cert"), serial_no: val("serial_no"), invoice: val("invoice") };
      if (item) body.version = item.version; else body.site_code = code;
      saving = true;
      var submit = form.querySelector('[type="submit"]');
      submit.disabled = true; submit.textContent = "Saving…";
      api().request(item ? "/api/bom/" + encodeURIComponent(item.id) : "/api/bom", {
        method: item ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      }).then(function () {
        saving = false; close();
        // Re-read from the server so the table shows exactly what was stored, in its sorted place.
        return load(container, false).then(function () { setStatus(container, item ? "Saved." : "Item added."); });
      }).catch(function (err) {
        saving = false; submit.disabled = false; submit.textContent = item ? "Save changes" : "Add item";
        errorEl.textContent = "Not saved. " + (err && err.message ? err.message : "Please retry.");
      });
    });
    var first = form.querySelector("[data-bom-field]");
    if (first) first.focus();
  }

  function removeItem(container, id) {
    var item = findItem(id);
    if (busy || !item) return;
    if (!global.confirm('Remove "' + item.itemName + '" (' + item.siteCode + ") from the BOM?")) return;
    busy = true;
    api().request("/api/bom/" + encodeURIComponent(id) + "?version=" + item.version, { method: "DELETE" })
      .then(function () { return load(container, false); })
      .then(function () { setStatus(container, "Line removed."); })
      .catch(function (err) { setStatus(container, "Could not remove: " + (err && err.message ? err.message : "try again"), true); })
      .then(function () { busy = false; });
  }

  // --- Export (every line matching the filters, up to the cap) ----------
  function fetchAll() {
    var all = [];
    function next() {
      return api().request(query(all.length, 500)).then(function (res) {
        all = all.concat(res.items || []);
        return all.length < (res.total || 0) && all.length < EXPORT_CAP && (res.items || []).length ? next() : { items: all, total: res.total || 0 };
      });
    }
    return next();
  }

  function download(filename, mime, text) {
    var blob = new Blob(["﻿" + text], { type: mime });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function exportFile(container, kind) {
    if (busy) return;
    busy = true; setStatus(container, "Preparing export…");
    fetchAll().then(function (res) {
      var rows = [COLS.map(function (c) { return c.label; }).concat(["Invoice Link", "Plant Code"])].concat(res.items.map(function (i) {
        return COLS.map(function (c) { return i[c.key] == null ? "" : i[c.key]; }).concat([i.invoiceUrl || "", i.siteCode]);
      }));
      if (kind === "csv") {
        download("solar91-bom.csv", "text/csv;charset=utf-8;", rows.map(function (row) {
          return row.map(function (c) { var s = fmt.csvText(c); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",");
        }).join("\r\n"));
      } else {
        download("solar91-bom.xls", "application/vnd.ms-excel;charset=utf-8;",
          '<html><head><meta charset="utf-8"></head><body><table border="1">' + rows.map(function (row, i) {
            var tag = i === 0 ? "th" : "td";
            return "<tr>" + row.map(function (c) { return "<" + tag + ">" + fmt.escape(fmt.csvText(c)) + "</" + tag + ">"; }).join("") + "</tr>";
          }).join("") + "</table></body></html>");
      }
      setStatus(container, res.items.length < res.total ? "Exported the first " + res.items.length + " of " + res.total + " lines." : "Exported " + res.items.length + " lines.");
    }).catch(function (err) { setStatus(container, "Export failed: " + (err && err.message ? err.message : "try again"), true); })
      .then(function () { busy = false; });
  }

  // --- Wiring ---------------------------------------------------------
  function wire(container) {
    var search = container.querySelector("[data-bom-search]");
    if (search) search.addEventListener("input", function () {
      ui.search = search.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { searchTimer = null; if (container.isConnected) load(container, false); }, 250);
    });
    container.querySelectorAll("[data-bom-filter]").forEach(function (sel) {
      sel.addEventListener("change", function () {
        var key = sel.getAttribute("data-bom-filter");
        ui[key] = sel.value;
        if (key === "spv") ui.plant = "__all";             // a plant outside the chosen SPV would match nothing
        load(container, false);
      });
    });
    var clear = container.querySelector("[data-bom-clear]");
    if (clear) clear.addEventListener("click", function () { ui = { search: "", plant: "__all", spv: "__all", maker: "__all" }; load(container, false); });
    var more = container.querySelector("[data-bom-more]");
    if (more) more.addEventListener("click", function () { if (!st.loading) load(container, true); });
    var add = container.querySelector("[data-bom-add]");
    if (add) add.addEventListener("click", function () { openEditor(container, null, add); });
    container.querySelectorAll("[data-bom-edit]").forEach(function (btn) {
      btn.addEventListener("click", function () { var it = findItem(btn.getAttribute("data-bom-edit")); if (it) openEditor(container, it, btn); });
    });
    container.querySelectorAll("[data-bom-del]").forEach(function (btn) {
      btn.addEventListener("click", function () { removeItem(container, btn.getAttribute("data-bom-del")); });
    });
    container.querySelectorAll("[data-bom-export]").forEach(function (btn) {
      btn.addEventListener("click", function () { exportFile(container, btn.getAttribute("data-bom-export")); });
    });
  }

  // --- Public entry point ---------------------------------------------
  function show(container, opts) {
    if (!container) return;
    mode = { kind: (opts && opts.siteCode) ? "single" : "all", siteCode: opts ? opts.siteCode : null };
    ui = { search: "", plant: "__all", spv: "__all", maker: "__all" };
    st = { items: [], total: 0, makers: [], plants: st.plants, loading: true, error: "", more: false };
    container.innerHTML = '<div class="ep-pt__loading">Loading BOM…</div>';
    data.fetchPortfolio().then(function (portfolio) {
      st.plants = portfolio.rows || [];
      if (container.isConnected) return load(container, false);
    }).catch(function (err) {
      container.innerHTML = '<div class="ep-pt__error">Could not load the BOM. ' + fmt.escape(err && err.message ? err.message : "") + "</div>";
    });
  }

  global.Solar91PortalBom = { show: show };
}(window));
