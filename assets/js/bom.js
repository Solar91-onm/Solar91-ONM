/**
 * bom.js
 * ---------------------------------------------------------------------
 * Bill of Materials: the BOQ / parts inventory of the solar plants. One row per BOQ line:
 *
 *   (Plant) | Section | Item Description | Specs | Maker | Supplier | Quantity | Unit |
 *   T.R. | W.C. | Item Serial No. | Invoice | (Edit)
 *
 * Section is the BOQ group heading ("PV Section", "PROTECTION") and Unit the unit of measure
 * (Nos., Mtrs, kWp). Quantity is fractional (5368.23 kWp) and printed as stored, with no
 * thousands separators -- a BOQ quantity is read against the sheet, not as money. Maker and
 * Supplier are two different parties. A BOQ line may legitimately carry none of them, and
 * sub-variant lines repeat an item name: nothing here dedupes or re-sorts rows -- they render in
 * the order the API returns them (section order, BOQ line order, item name).
 *
 * The Section cell is MERGED: consecutive rows of one section share a single cell with a rowspan,
 * so the heading is read once against the whole block. The spans are recomputed from the rows on
 * every render, so filtering, searching and paging never leave a stale span behind.
 *
 *   Views -> Details -> BOM    every plant's lines (search, plant, SPV, maker, supplier and section
 *                              filters), a leading Plant column; plants never merge into each other
 *   Plant -> Details -> BOM    that plant's lines only, plus "Reorder sections" for editors
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
  var MAX_QUANTITY = 1000000;
  var MAX_SORT_ORDER = 1000000;
  // `w` is the column's share of the table width (see colgroupHTML): the columns that hold
  // long BOQ text get more of the frame than Quantity or Unit, so nothing has to scroll sideways.
  var PLANT_COL = { key: "siteCode", label: "Plant", w: 1.1 };
  var COLS = [
    { key: "section", label: "Section", w: 1.15 },
    { key: "itemName", label: "Item Description", w: 2 },
    { key: "specs", label: "Specs", w: 2 },
    { key: "maker", label: "Maker", w: 1 },
    { key: "supplier", label: "Supplier", w: 1 },
    { key: "quantity", label: "Quantity", num: true, w: 0.85 },
    { key: "unit", label: "Unit", w: 0.6 },
    { key: "testReport", label: "T.R.", w: 0.7 },
    { key: "warrantyCert", label: "W.C.", w: 0.7 },
    { key: "serialNo", label: "Item Serial No.", w: 0.95 },
    { key: "invoice", label: "Invoice", w: 0.95 }
  ];
  var BLANK_UI = { search: "", plant: "__all", spv: "__all", maker: "__all", supplier: "__all", section: "__all" };

  var mode = { kind: "all", siteCode: null };
  var ui = Object.assign({}, BLANK_UI);
  var st = { items: [], total: 0, makers: [], suppliers: [], sections: [], plants: [], loading: false, error: "", more: false };
  var token = 0, searchTimer = null, busy = false;

  function api() { return global.Solar91PortalAPI; }
  function canEdit() { return !!(api() && api().can("plants.manage")); }
  function single() { return mode.kind === "single"; }
  // Across plants the Plant column leads, so each plant's BOQ reads as its own block.
  function columns() { return single() ? COLS : [PLANT_COL].concat(COLS); }

  // --- Data -----------------------------------------------------------
  function query(offset, limit) {
    var q = ["limit=" + limit, "offset=" + offset];
    if (single()) q.push("site_code=" + encodeURIComponent(mode.siteCode));
    else {
      if (ui.plant !== "__all") q.push("site_code=" + encodeURIComponent(ui.plant));
      if (ui.spv !== "__all") q.push("spv=" + encodeURIComponent(ui.spv));
    }
    if (ui.maker !== "__all") q.push("maker=" + encodeURIComponent(ui.maker));
    if (ui.supplier !== "__all") q.push("supplier=" + encodeURIComponent(ui.supplier));
    if (ui.section !== "__all") q.push("section=" + encodeURIComponent(ui.section));
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
      st.suppliers = res.suppliers || [];
      st.sections = res.sections || [];
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
    return !!(ui.search.trim() || ui.plant !== "__all" || ui.spv !== "__all" || ui.maker !== "__all" ||
      ui.supplier !== "__all" || ui.section !== "__all");
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
      '<input type="text" placeholder="Search item, maker, supplier, specs, serial, invoice..." data-bom-search value="' + fmt.escape(ui.search) + '" autocomplete="off" /></div>';
    var maker = '<select class="ep-pt__select" data-bom-filter="maker" aria-label="Filter by maker"><option value="__all">All makers</option>' +
      opts(st.makers, ui.maker) + "</select>" +
      '<select class="ep-pt__select" data-bom-filter="supplier" aria-label="Filter by supplier"><option value="__all">All suppliers</option>' +
      opts(st.suppliers, ui.supplier) + "</select>";
    var section = '<select class="ep-pt__select" data-bom-filter="section" aria-label="Filter by BOQ section"><option value="__all">All sections</option>' +
      opts(st.sections, ui.section) + "</select>";
    var clear = filtersActive() ? '<button type="button" class="ep-pt__export" data-bom-clear>Clear filters</button>' : "";
    if (single()) return '<div class="ep-pt__toolbar">' + search + section + maker + clear + "</div>";
    return '<div class="ep-pt__toolbar">' + search +
      '<select class="ep-pt__select" data-bom-filter="spv" aria-label="Filter by SPV or project"><option value="__all">All SPV</option>' +
        opts(spvs, ui.spv, function (v) {
          var row = st.plants.filter(function (r) { return r.plant.projectCompany === v; })[0];
          return (row && row.plant.projectCompanyShort) || v;
        }) + "</select>" +
      '<select class="ep-pt__select" data-bom-filter="plant" aria-label="Filter by plant"><option value="__all">All plants</option>' +
        opts(plants.map(function (r) { return r.plant.siteCode; }), ui.plant, function (c) { return c + " · " + plantName(c); }) + "</select>" +
      section + maker + clear + "</div>";
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

  // Every column gets a share of the frame proportional to how much text it holds, so the whole
  // table fits without scrolling sideways and a 500-character spec still wraps readably.
  function colgroupHTML(editor) {
    var shares = columns().map(function (c) { return c.w || 1; });
    if (editor) shares.push(0.9);                          // Edit
    var total = shares.reduce(function (a, b) { return a + b; }, 0);
    return "<colgroup>" + shares.map(function (w) {
      return '<col style="width:' + (100 * w / total).toFixed(3) + '%">';
    }).join("") + "</colgroup>";
  }

  function cell(value, cls) {
    var has = value !== null && value !== undefined && value !== "";
    return "<td" + (cls ? ' class="' + cls + '"' : "") + ">" + (has ? fmt.escape(String(value)) : '<span class="ep-pt__dash">—</span>') + "</td>";
  }

  // A BOQ quantity is fractional and stored to three decimals. It is printed exactly as stored --
  // the raw digits, no thousands separators (5334, not "5,334": a BOQ quantity is checked against
  // the sheet, not read as money) and trailing zeros trimmed (5368.23, 7180.8, 12, never "12.000").
  // Only this cell is unformatted; every other numeric cell in the portal keeps fmt.formatNumber.
  function qtyText(value) {
    if (value === null || value === undefined || value === "") return "";
    var n = Number(value);
    return isFinite(n) ? String(n) : String(value);
  }

  function qtyCell(value) {
    var text = qtyText(value);
    return '<td class="num mono">' + (text === "" ? '<span class="ep-pt__dash">—</span>' : fmt.escape(text)) + "</td>";
  }

  /**
   * Which rows form one merged Section block, recomputed from the rows on every render.
   *
   * Consecutive rows sharing a section are one block; the Section cell is rendered once on the
   * block's first row with a rowspan over the rest, like a merged cell in a sheet. Across plants
   * the plant is part of the key, so one plant's "PV Section" never merges into the next plant's.
   * Rows with no section form their own block, shown as "—"; the API sorts those last.
   *
   * Returns a row-index -> block map, so a filtered or re-sorted table can never reuse an old span.
   */
  function sectionBlocks(items) {
    var list = [], last = null, byRow = {};
    items.forEach(function (item, i) {
      var name = (item.section === null || item.section === undefined || item.section === "") ? "" : String(item.section);
      var site = single() ? "" : String(item.siteCode || "");
      if (last && last.section === name && last.site === site) last.span += 1;
      else { last = { site: site, section: name, start: i, span: 1, label: name, alt: list.length % 2 === 1 }; list.push(last); }
    });
    list.forEach(function (block) {
      for (var i = block.start; i < block.start + block.span; i++) byRow[i] = block;
    });
    return byRow;
  }

  // The merged Section cell: written once per block, never on the rows it spans.
  function sectionCell(block) {
    return '<td class="ep-bom__section' + (block.alt ? " is-alt" : "") + '"' +
      (block.span > 1 ? ' rowspan="' + block.span + '"' : "") + ">" +
      (block.label ? fmt.escape(block.label) : '<span class="ep-pt__dash">—</span>') + "</td>";
  }

  function plantCell(item) {
    return '<td><span class="ep-pt__code">' + fmt.escape(item.siteCode) + '</span><span class="ep-pt__name">' +
      fmt.escape(plantName(item.siteCode)) + "</span></td>";
  }

  function rowHTML(item, editor, index, byRow) {
    var block = byRow[index], starts = !!block && block.start === index;
    return '<tr' + (starts ? ' class="ep-bom__block-start"' : "") + ">" +
      (single() ? "" : plantCell(item)) +
      (starts ? sectionCell(block) : "") +
      '<td class="ep-bom__item">' + fmt.escape(item.itemName) + "</td>" +
      cell(item.specs, "ep-bom__specs") +
      cell(item.maker) + cell(item.supplier) +
      qtyCell(item.quantity) + cell(item.unit) +
      cell(item.testReport) + cell(item.warrantyCert) +
      cell(item.serialNo, "mono") + invoiceCell(item) +
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
    var cols = columns();
    var colCount = cols.length + (editor ? 1 : 0);

    var head = cols.map(function (c) { return "<th>" + c.label + "</th>"; }).join("") +
      (editor ? "<th>Edit</th>" : "");
    var body;
    if (st.error) body = '<tr><td colspan="' + colCount + '" class="ep-pt__empty is-error">Could not load BOM lines. ' + fmt.escape(st.error) + "</td></tr>";
    else if (st.loading && !st.items.length) body = '<tr><td colspan="' + colCount + '" class="ep-pt__empty">Loading BOM…</td></tr>';
    else if (!st.items.length) body = '<tr><td colspan="' + colCount + '" class="ep-pt__empty">' +
      (filtersActive() ? "No BOM lines match these filters." :
        (editor ? 'No BOM lines yet. Use "+ Add item" to list the first part.' : "No BOM lines have been added yet.")) + "</td></tr>";
    else {
      // Spans are derived from the rows being rendered now, so a filter or a new page never
      // leaves a merged cell reaching over rows that are no longer there.
      var byRow = sectionBlocks(st.items);
      body = st.items.map(function (i, index) { return rowHTML(i, editor, index, byRow); }).join("");
    }

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
          // Section order belongs to one plant's BOQ, so it is offered only on that plant's page.
          (editor && single() ? '<button class="ep-pt__export" type="button" data-bom-reorder>Reorder sections</button>' : "") +
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
        f("item_name", "Item Description *", 400, v.itemName, " ep-bom__wide") + f("section", "Section (BOQ heading)", 160, v.section) +
        f("maker", "Maker", 160, v.maker) + f("supplier", "Supplier", 160, v.supplier) +
        '<label class="ep-pd__field"><span>Quantity</span><input type="number" min="0" max="1000000" step="0.001" inputmode="decimal" data-bom-field="quantity" value="' +
          (v.quantity == null ? "" : v.quantity) + '" /></label>' +
        f("unit", "Unit (Nos., Mtrs, kWp…)", 24, v.unit) +
        '<label class="ep-pd__field"><span>Sort order (BOQ line order)</span><input type="number" min="0" max="1000000" step="1" inputmode="numeric" data-bom-field="sort_order" value="' +
          (v.sortOrder == null ? "" : v.sortOrder) + '" /></label>' +
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
      if (!val("item_name")) { errorEl.textContent = "Item Description is required."; return; }
      var qty = val("quantity");
      if (qty !== "" && (!/^\d+(\.\d{1,3})?$/.test(qty) || Number(qty) > MAX_QUANTITY)) {
        errorEl.textContent = "Quantity must be a number from 0 to 1,000,000 with at most three decimals."; return;
      }
      var order = val("sort_order");
      if (order !== "" && (!/^\d+$/.test(order) || Number(order) > MAX_SORT_ORDER)) {
        errorEl.textContent = "Sort order must be a whole number from 0 to 1,000,000."; return;
      }
      var link = val("invoice_url");
      if (link && !safeUrl(link)) { errorEl.textContent = "Invoice link must start with http:// or https://"; return; }
      var body = { invoice_url: link, item_name: val("item_name"), maker: val("maker"), supplier: val("supplier"), quantity: qty === "" ? null : Number(qty),
        unit: val("unit"), section: val("section"), sort_order: order === "" ? null : Number(order),
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

  /**
   * Reorder this plant's BOQ sections (single-plant mode, editors only).
   *
   * The dialog lists the sections in the order the table is showing them -- the order the API
   * sent, which is `section_order` -- and moves them with up/down buttons. Saving PATCHes the
   * whole list; the server writes position 1..n onto every line of each section in one
   * transaction, then the table is re-read so what is on screen is what was stored.
   */
  function openReorder(container, trigger) {
    var row = st.plants.filter(function (r) { return r.plant.siteCode === mode.siteCode; })[0];
    var plantId = row ? row.plant.id : null;
    var order = (st.sections || []).slice();
    if (!plantId) { setStatus(container, "Could not identify this plant. Reload the page.", true); return; }
    if (order.length < 2) {
      setStatus(container, order.length ? "This plant has only one BOQ section." : "This plant has no BOQ sections yet.");
      return;
    }
    var overlay = document.createElement("div");
    overlay.className = "ep-pd__overlay";
    overlay.innerHTML = '<form class="ep-pd__modal ep-bom__order-modal" role="dialog" aria-modal="true" aria-labelledby="bom-order-title" novalidate>' +
      '<header class="ep-pd__modal-head"><div><h2 id="bom-order-title">Reorder sections</h2>' +
        '<p class="ep-pd__mono">' + fmt.escape(mode.siteCode) + ' &middot; the BOM table follows this order</p></div>' +
        '<button class="ep-pd__x" type="button" data-bom-order-close aria-label="Close">&times;</button></header>' +
      '<ol class="ep-bom__order" data-bom-order-list></ol>' +
      '<p class="ep-pd__form-error" role="alert"></p>' +
      '<footer class="ep-pd__modal-foot"><button class="ep-pd__btn" type="button" data-bom-order-close>Cancel</button>' +
        '<button class="ep-pd__btn ep-pd__btn--primary" type="submit">Save order</button></footer></form>';
    document.body.appendChild(overlay);

    var form = overlay.querySelector("form");
    var list = overlay.querySelector("[data-bom-order-list]");
    var errorEl = overlay.querySelector(".ep-pd__form-error");
    var saving = false;

    function paint(focusAt, focusDir) {
      list.innerHTML = order.map(function (name, i) {
        return '<li class="ep-bom__order-row"><span class="ep-bom__order-pos">' + (i + 1) + "</span>" +
          '<span class="ep-bom__order-name">' + fmt.escape(name) + "</span>" +
          '<span class="ep-bom__order-move">' +
            '<button type="button" class="ep-bom__order-btn" data-bom-move="up" data-bom-at="' + i + '"' +
              (i === 0 ? " disabled" : "") + ' aria-label="Move ' + fmt.escape(name) + ' up">&uarr;</button>' +
            '<button type="button" class="ep-bom__order-btn" data-bom-move="down" data-bom-at="' + i + '"' +
              (i === order.length - 1 ? " disabled" : "") + ' aria-label="Move ' + fmt.escape(name) + ' down">&darr;</button>' +
          "</span></li>";
      }).join("");
      list.querySelectorAll("[data-bom-move]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          if (saving) return;
          var at = Number(btn.getAttribute("data-bom-at"));
          var dir = btn.getAttribute("data-bom-move");
          var to = dir === "up" ? at - 1 : at + 1;
          if (to < 0 || to >= order.length) return;
          var moved = order[at];
          order[at] = order[to];
          order[to] = moved;
          paint(to, dir);
        });
      });
      // Keep the keyboard on the section that just moved, so it can be moved again.
      if (focusAt !== undefined) {
        var same = list.querySelector('[data-bom-move="' + focusDir + '"][data-bom-at="' + focusAt + '"]');
        var other = list.querySelector('[data-bom-move="' + (focusDir === "up" ? "down" : "up") + '"][data-bom-at="' + focusAt + '"]');
        var target = same && !same.disabled ? same : other;
        if (target && !target.disabled) target.focus();
      }
    }
    paint();

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
      if (trigger && trigger.isConnected) trigger.focus();
    }
    function onKey(ev) { if (ev.key === "Escape" && !saving) close(); }
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", function (ev) {
      if (!saving && (ev.target === overlay || ev.target.closest("[data-bom-order-close]"))) close();
    });

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (saving) return;                                  // no double submissions
      errorEl.textContent = "";
      saving = true;
      var submit = form.querySelector('[type="submit"]');
      submit.disabled = true; submit.textContent = "Saving…";
      api().request("/api/bom/sections/order", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plantId: plantId, sections: order })
      }).then(function () {
        saving = false; close();
        // Re-read: the table must show the order the server stored, not the one just clicked.
        return load(container, false).then(function () { setStatus(container, "Section order saved."); });
      }).catch(function (err) {
        saving = false; submit.disabled = false; submit.textContent = "Save order";
        errorEl.textContent = "Not saved. " + (err && err.message ? err.message : "Please retry.");
      });
    });
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
      // The table's columns, in the table's order. A merged Section cell makes sense on screen;
      // a CSV row must stand on its own, so the section name is repeated on every exported row.
      var cols = columns().concat([{ key: "invoiceUrl", label: "Invoice Link" }]);
      if (single()) cols = cols.concat([{ key: "siteCode", label: "Plant Code" }]);
      var rows = [cols.map(function (c) { return c.label; })].concat(res.items.map(function (i) {
        return cols.map(function (c) {
          if (c.key === "quantity") return qtyText(i.quantity);   // raw digits, as stored
          return i[c.key] == null ? "" : i[c.key];
        });
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
    if (clear) clear.addEventListener("click", function () { ui = Object.assign({}, BLANK_UI); load(container, false); });
    var more = container.querySelector("[data-bom-more]");
    if (more) more.addEventListener("click", function () { if (!st.loading) load(container, true); });
    var add = container.querySelector("[data-bom-add]");
    if (add) add.addEventListener("click", function () { openEditor(container, null, add); });
    var reorder = container.querySelector("[data-bom-reorder]");
    if (reorder) reorder.addEventListener("click", function () { openReorder(container, reorder); });
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
    ui = Object.assign({}, BLANK_UI);
    st = { items: [], total: 0, makers: [], suppliers: [], sections: [], plants: st.plants, loading: true, error: "", more: false };
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
