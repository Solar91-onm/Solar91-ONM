/**
 * plant-details.js — Plants → <plant> → Details
 * ─────────────────────────────────────────────────────────────────────
 * The full record for one plant, read from the database through
 * GET /api/portal/plants/:code:
 *
 *   • identity & ownership  — code, name, SPV, status, COD, plant age
 *   • capacity              — DC (kWp), AC (kW), DC/AC ratio
 *   • location              — district, DISCOM, location text, coordinates, map
 *   • people                — Site Engineers (assignments), washing assignee
 *   • operations            — issues, Preventive Maintenance, Washing
 *   • recent activity       — real issue / PM events
 *   • additional fields     — any custom_fields stored on the plant
 *
 * Editing writes through the existing PATCH /api/plants/:id (permission
 * plants.manage). The editor is shared with the portfolio table.
 */
(function (global) {
  "use strict";

  var data = global.Solar91PortalData;
  var fmt = global.Solar91PortalFormat;
  var esc = function (v) { return fmt.escape(v === null || v === undefined ? "" : String(v)); };

  var activeRequest = 0;

  // ─── Small formatters ────────────────────────────────────────────────
  function na(text) {
    return '<span class="ep-pd__na">' + esc(text || "Not available") + "</span>";
  }

  function num(value, digits) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n.toLocaleString("en-IN", { maximumFractionDigits: digits === undefined ? 2 : digits });
  }

  function dateText(iso) {
    if (!iso) return null;
    var d = new Date(String(iso).length === 10 ? iso + "T00:00:00" : iso);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  }

  function plantAge(iso) {
    if (!iso) return null;
    var start = new Date(iso + "T00:00:00");
    if (isNaN(start.getTime())) return null;
    var now = new Date();
    if (start > now) return "Commissioning on " + dateText(iso);
    var months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
    if (now.getDate() < start.getDate()) months -= 1;
    if (months < 1) return "Commissioned this month";
    var years = Math.floor(months / 12), rem = months % 12;
    return (years ? years + (years === 1 ? " year" : " years") : "") +
           (years && rem ? " " : "") +
           (rem ? rem + (rem === 1 ? " month" : " months") : "") + " in operation";
  }

  function conditionChip(condition) {
    var map = {
      healthy: ["ep-chip--healthy", "Healthy"],
      attention: ["ep-chip--attention", "Needs attention"],
      critical: ["ep-chip--critical", "Critical"],
      unknown: ["ep-chip--grey", "No data yet"]
    };
    var c = map[condition] || map.unknown;
    return '<span class="ep-chip ' + c[0] + '">' + c[1] + "</span>";
  }

  function statusChip(status) {
    var s = String(status || "active").toLowerCase();
    var cls = s === "active" ? "ep-chip--healthy" : (s === "inactive" || s === "decommissioned") ? "ep-chip--grey" : "ep-chip--attention";
    return '<span class="ep-chip ' + cls + '">' + esc(status ? status.charAt(0).toUpperCase() + status.slice(1) : "Active") + "</span>";
  }

  function pctTone(pct, threshold) {
    if (pct === null || pct === undefined) return "grey";
    var limit = threshold || 80;
    if (pct >= limit) return "good";
    if (pct >= limit - 20) return "warn";
    return "bad";
  }

  function row(label, valueHtml) {
    return '<div class="ep-pd__row"><dt>' + esc(label) + "</dt><dd>" + valueHtml + "</dd></div>";
  }

  function val(value, suffix) {
    return value === null || value === undefined || value === "" ? na() : esc(value) + (suffix || "");
  }

  // ─── Sections ────────────────────────────────────────────────────────
  function headerHTML(p, profile) {
    var canEdit = global.Solar91PortalAPI && global.Solar91PortalAPI.can("plants.manage");
    return '' +
      '<header class="ep-pd__head">' +
        '<div class="ep-pd__title-wrap">' +
          '<p class="ep-pd__eyebrow">Plant details</p>' +
          '<h1 class="ep-pd__title">' + esc(p.displayName || p.plantName) + "</h1>" +
          '<div class="ep-pd__chips">' +
            '<span class="ep-pd__code">' + esc(p.siteCode) + "</span>" +
            statusChip(p.status) +
            conditionChip(profile.derivedCondition) +
          "</div>" +
        "</div>" +
        '<div class="ep-pd__actions">' +
          (p.mapsUrl
            ? '<a class="ep-pd__btn" href="' + esc(p.mapsUrl) + '" target="_blank" rel="noopener">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg>' +
                "Open map</a>"
            : "") +
          (canEdit
            ? '<button class="ep-pd__btn ep-pd__btn--primary" type="button" data-pd-edit>' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>' +
                "Edit details</button>"
            : "") +
        "</div>" +
      "</header>";
  }

  function tilesHTML(p, profile) {
    var ratio = p.dcCapacityKw && p.acCapacityKw ? (p.dcCapacityKw / p.acCapacityKw) : null;
    var pm = profile.pm || {}, wash = profile.washing || {};
    var tiles = [
      {
        label: "DC capacity",
        value: p.dcCapacityKw !== null ? num(p.dcCapacityKw / 1000, 2) + " MWp" : null,
        sub: p.dcCapacityKw !== null ? num(p.dcCapacityKw) + " kWp" : "Add it with Edit details"
      },
      {
        label: "AC capacity",
        value: p.acCapacityKw !== null ? num(p.acCapacityKw / 1000, 2) + " MW" : null,
        sub: ratio ? "DC/AC ratio " + ratio.toFixed(2) : (p.acCapacityKw !== null ? num(p.acCapacityKw) + " kW" : "Add it with Edit details")
      },
      {
        label: "Open issues",
        value: profile.openIssues === null ? null : num(profile.openIssues, 0),
        sub: profile.openIssues === null ? "No issue records" : num(profile.criticalIssues, 0) + " critical · " + num(profile.mediumIssues, 0) + " medium",
        tone: (profile.criticalIssues || 0) > 0 ? "bad" : (profile.openIssues || 0) > 1 ? "warn" : "good",
        go: "health"
      },
      {
        label: "PM compliance",
        value: pm.compliancePercent === null || pm.compliancePercent === undefined ? null : pm.compliancePercent + "%",
        sub: pm.completed === null || pm.completed === undefined ? "No PM jobs yet" : num(pm.overdue, 0) + " overdue · " + num(pm.pending, 0) + " pending",
        tone: pctTone(pm.compliancePercent),
        go: "pm"
      },
      {
        label: "Washing this month",
        value: wash.completed === null || wash.completed === undefined ? null : wash.completed + " / " + (wash.monthlyTarget || 3) + " cycles",
        sub: wash.compliancePercent === null || wash.compliancePercent === undefined
          ? "Washing not set up"
          : "Cycle compliance " + wash.compliancePercent + "%" + (wash.overdueDays ? " · " + wash.overdueDays + "d late" : ""),
        tone: pctTone(wash.compliancePercent, wash.thresholdPercent),
        go: "washing"
      }
    ];
    return '<div class="ep-pd__tiles">' + tiles.map(function (t) {
      var tag = t.go ? "button" : "div";
      return "<" + tag + ' class="ep-pd__tile' + (t.tone ? " ep-pd__tile--" + t.tone : "") + '"' +
        (t.go ? ' type="button" data-pd-go="' + t.go + '"' : "") + ">" +
        '<span class="ep-pd__tile-label">' + esc(t.label) + "</span>" +
        '<span class="ep-pd__tile-value">' + (t.value === null || t.value === undefined ? na("—") : esc(t.value)) + "</span>" +
        '<span class="ep-pd__tile-sub">' + esc(t.sub) + "</span>" +
      "</" + tag + ">";
    }).join("") + "</div>";
  }

  function recordHTML(p) {
    var coords = p.latitude !== null && p.longitude !== null
      ? esc(p.latitude.toFixed(5) + ", " + p.longitude.toFixed(5))
      : na();
    var engineers = p.siteEngineers && p.siteEngineers.length
      ? p.siteEngineers.map(esc).join(", ")
      : (p.assignedEngineer ? esc(p.assignedEngineer) + ' <span class="ep-pd__hint">(recorded on plant)</span>' : na("Not assigned"));

    return '' +
      '<section class="ep-pd__card">' +
        '<h2 class="ep-pd__card-title">Identity &amp; ownership</h2>' +
        '<dl class="ep-pd__list">' +
          row("Plant code", '<span class="ep-pd__mono">' + esc(p.siteCode) + "</span>") +
          row("Plant name", val(p.plantName)) +
          row("SPV / project company", p.projectCompany
            ? esc(p.projectCompany) + (p.projectCompanyShort && p.projectCompanyShort !== p.projectCompany ? ' <span class="ep-pd__hint">(' + esc(p.projectCompanyShort) + ")</span>" : "")
            : na()) +
          row("Status", statusChip(p.status)) +
          row("Commercial operation (COD)", p.commissionedOn ? esc(dateText(p.commissionedOn)) : na("Not commissioned yet")) +
          row("Plant age", plantAge(p.commissionedOn) ? esc(plantAge(p.commissionedOn)) : na()) +
        "</dl>" +
      "</section>" +

      '<section class="ep-pd__card">' +
        '<h2 class="ep-pd__card-title">Capacity</h2>' +
        '<dl class="ep-pd__list">' +
          row("DC capacity", p.dcCapacityKw !== null ? esc(num(p.dcCapacityKw)) + " kWp" : na()) +
          row("AC capacity", p.acCapacityKw !== null ? esc(num(p.acCapacityKw)) + " kW" : na()) +
          row("DC / AC ratio", p.dcCapacityKw && p.acCapacityKw ? esc((p.dcCapacityKw / p.acCapacityKw).toFixed(2)) : na()) +
        "</dl>" +
      "</section>" +

      '<section class="ep-pd__card">' +
        '<h2 class="ep-pd__card-title">Location &amp; grid</h2>' +
        '<dl class="ep-pd__list">' +
          row("District", val(p.district)) +
          row("DISCOM", val(p.discom)) +
          row("Location", val(p.location)) +
          row("Coordinates", coords) +
        "</dl>" +
      "</section>" +

      '<section class="ep-pd__card">' +
        '<h2 class="ep-pd__card-title">People</h2>' +
        '<dl class="ep-pd__list">' +
          row("Site Engineer", engineers) +
          row("Washing assignee", p.washingAssignee ? esc(p.washingAssignee) : na("Not set up")) +
        "</dl>" +
        '<p class="ep-pd__foot">Site Engineer access is assigned in Settings → Team access.</p>' +
      "</section>";
  }

  function operationsHTML(profile, extra) {
    var pm = profile.pm || {}, wash = profile.washing || {};
    function n(v) { return v === null || v === undefined ? na("—") : esc(num(v, 0)); }
    function bar(pct, threshold) {
      if (pct === null || pct === undefined) return na();
      return '<span class="ep-pd__bar ep-pd__bar--' + pctTone(pct, threshold) + '"><i style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></span>' +
             '<b class="ep-pd__pct">' + esc(pct) + "%</b>";
    }
    return '' +
      '<section class="ep-pd__card ep-pd__card--wide">' +
        '<h2 class="ep-pd__card-title">Operations</h2>' +
        '<div class="ep-pd__ops">' +
          '<div class="ep-pd__op">' +
            '<h3>Site issues</h3>' +
            '<dl class="ep-pd__list">' +
              row("Open", n(profile.openIssues)) +
              row("Critical (open)", n(profile.criticalIssues)) +
              row("Medium (open)", n(profile.mediumIssues)) +
              row("Resolved / closed", n(profile.closedIssues)) +
              row("All tickets", n(extra.issueTotal)) +
            "</dl>" +
            '<button class="ep-pd__link" type="button" data-pd-go="health">Open Health →</button>' +
          "</div>" +
          '<div class="ep-pd__op">' +
            '<h3>Preventive maintenance</h3>' +
            '<dl class="ep-pd__list">' +
              row("Completed", n(pm.completed)) +
              row("Pending", n(pm.pending)) +
              row("Overdue", n(pm.overdue)) +
              row("Cancelled", n(extra.pmCancelled)) +
              row("Compliance", bar(pm.compliancePercent)) +
            "</dl>" +
            '<button class="ep-pd__link" type="button" data-pd-go="pm">Open PM calendar →</button>' +
          "</div>" +
          '<div class="ep-pd__op">' +
            '<h3>Washing</h3>' +
            '<dl class="ep-pd__list">' +
              row("Cycles this month", wash.completed === null || wash.completed === undefined ? na("Not set up") : esc(wash.completed + " of " + (wash.monthlyTarget || 3))) +
              row("Current cycle", wash.currentCycle ? esc("Cycle " + wash.currentCycle) : na("—")) +
              row("Tables", n(wash.tableCount)) +
              row("Cycle compliance", bar(wash.compliancePercent, wash.thresholdPercent)) +
              row("Delay", wash.overdueDays ? esc(wash.overdueDays + " days late") : (wash.completed === null || wash.completed === undefined ? na("—") : "On track")) +
              row("Last report", wash.lastReportDate ? esc(dateText(wash.lastReportDate)) : na("—")) +
            "</dl>" +
            '<button class="ep-pd__link" type="button" data-pd-go="washing">Open Washing →</button>' +
          "</div>" +
        "</div>" +
        (profile.note ? '<p class="ep-pd__foot">' + esc(profile.note) + "</p>" : "") +
      "</section>";
  }

  function activityHTML(items) {
    var list = (items || []).map(function (item) {
      var tone = item.kind === "issue.opened"
        ? (item.severity === "Critical" ? "ep-chip--critical" : "ep-chip--attention")
        : item.kind === "pm.scheduled" ? "ep-chip--grey" : "ep-chip--healthy";
      return '<li class="ep-pd__act">' +
        '<div><div class="ep-pd__act-title">' + esc(item.title) + "</div>" +
        '<div class="ep-pd__act-sub">' + esc(item.category || "") + "</div></div>" +
        '<div class="ep-pd__act-meta"><span class="ep-chip ' + tone + '">' + esc(item.status) + "</span>" +
        "<small>" + esc(fmt.relativeTime(item.at)) + "</small></div>" +
      "</li>";
    }).join("");
    return '' +
      '<section class="ep-pd__card ep-pd__card--wide">' +
        '<h2 class="ep-pd__card-title">Recent activity</h2>' +
        (list ? '<ul class="ep-pd__acts">' + list + "</ul>" : '<p class="ep-pd__empty">No recent issue or maintenance activity for this plant.</p>') +
      "</section>";
  }

  function customHTML(p) {
    var keys = Object.keys(p.customFields || {}).filter(function (k) {
      var v = p.customFields[k];
      return v !== null && v !== undefined && v !== "" && typeof v !== "object";
    });
    if (!keys.length) return "";
    return '' +
      '<section class="ep-pd__card ep-pd__card--wide">' +
        '<h2 class="ep-pd__card-title">Additional fields</h2>' +
        '<dl class="ep-pd__list ep-pd__list--grid">' +
          keys.sort().map(function (k) { return row(k.replace(/_/g, " "), esc(p.customFields[k])); }).join("") +
        "</dl>" +
      "</section>";
  }

  // ─── Render ──────────────────────────────────────────────────────────
  function render(container, opts) {
    if (!container || !opts || !opts.siteCode) return;
    var requestId = ++activeRequest;
    container.innerHTML = '<div class="ep-pd"><div class="ep-pd__loading">Loading plant details…</div></div>';

    data.fetchPlantDetails(opts.siteCode).then(function (result) {
      if (requestId !== activeRequest) return;
      var p = result.plant, profile = result.profile;
      container.innerHTML = '' +
        '<div class="ep-pd">' +
          headerHTML(p, profile) +
          tilesHTML(p, profile) +
          '<div class="ep-pd__grid">' +
            recordHTML(p) +
            operationsHTML(profile, result) +
            customHTML(p) +
            activityHTML(result.activity) +
          "</div>" +
        "</div>";

      container.querySelectorAll("[data-pd-go]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          global.Solar91PortalNav.selectPlantPage(p.siteCode, btn.getAttribute("data-pd-go"));
        });
      });
      var edit = container.querySelector("[data-pd-edit]");
      if (edit) {
        edit.addEventListener("click", function () {
          PlantEditor.open(p, function () { render(container, opts); });
        });
      }
    }).catch(function (error) {
      if (requestId !== activeRequest) return;
      container.innerHTML = '<div class="ep-pd"><div class="ep-pd__error">' +
        (error && error.status === 404
          ? "This plant was not found, or it is outside your assigned scope."
          : "Plant details could not be loaded. " + esc(error && error.message)) +
        ' <button class="ep-pd__btn" type="button" data-pd-retry>Retry</button></div></div>';
      var retry = container.querySelector("[data-pd-retry]");
      if (retry) retry.addEventListener("click", function () { render(container, opts); });
    });
  }

  // ─── Plant editor (PATCH /api/plants/:id) ────────────────────────────
  var EDIT_FIELDS = [
    { key: "plant_name",      from: "plantName",      label: "Plant name",            type: "text", required: true },
    { key: "project_company", from: "projectCompany", label: "SPV / project company", type: "text" },
    { key: "status",          from: "status",         label: "Status",                type: "select",
      options: ["active", "commissioning", "inactive", "decommissioned"] },
    { key: "commissioned_on", from: "commissionedOn", label: "COD",                   type: "date" },
    { key: "dc_capacity_kw",  from: "dcCapacityKw",   label: "DC capacity (kWp)",     type: "number" },
    { key: "ac_capacity_kw",  from: "acCapacityKw",   label: "AC capacity (kW)",      type: "number" },
    { key: "district",        from: "district",       label: "District",              type: "text" },
    { key: "discom",          from: "discom",         label: "DISCOM",                type: "text" },
    { key: "location",        from: "location",       label: "Location",              type: "text" },
    { key: "latitude",        from: "latitude",       label: "Latitude",              type: "number", step: "any" },
    { key: "longitude",       from: "longitude",      label: "Longitude",             type: "number", step: "any" }
  ];

  var PlantEditor = {
    open: function (plant, onSaved) {
      var overlay = document.createElement("div");
      overlay.className = "ep-pd__overlay";
      overlay.innerHTML = '' +
        '<form class="ep-pd__modal" role="dialog" aria-modal="true" aria-labelledby="pd-edit-title" novalidate>' +
          '<header class="ep-pd__modal-head"><div>' +
            '<h2 id="pd-edit-title">Edit ' + esc(plant.displayName || plant.plantName) + "</h2>" +
            '<p class="ep-pd__mono">' + esc(plant.siteCode) + "</p></div>" +
            '<button class="ep-pd__x" type="button" data-pd-close aria-label="Close">×</button>' +
          "</header>" +
          '<div class="ep-pd__modal-body">' +
            EDIT_FIELDS.map(function (f) {
              var v = plant[f.from];
              var value = v === null || v === undefined ? "" : String(v);
              var input = f.type === "select"
                ? '<select name="' + f.key + '">' + f.options.map(function (o) {
                    return '<option value="' + o + '"' + (value.toLowerCase() === o ? " selected" : "") + ">" +
                           o.charAt(0).toUpperCase() + o.slice(1) + "</option>";
                  }).join("") +
                  (value && f.options.indexOf(value.toLowerCase()) === -1 ? '<option value="' + esc(value) + '" selected>' + esc(value) + "</option>" : "") +
                  "</select>"
                : '<input name="' + f.key + '" type="' + f.type + '"' + (f.step ? ' step="' + f.step + '"' : "") +
                  (f.required ? " required" : "") + ' value="' + esc(value) + '"/>';
              return '<label class="ep-pd__field"><span>' + esc(f.label) + "</span>" + input + "</label>";
            }).join("") +
          "</div>" +
          '<p class="ep-pd__form-error" role="alert"></p>' +
          '<footer class="ep-pd__modal-foot">' +
            '<button class="ep-pd__btn" type="button" data-pd-close>Cancel</button>' +
            '<button class="ep-pd__btn ep-pd__btn--primary" type="submit">Save changes</button>' +
          "</footer>" +
        "</form>";
      document.body.appendChild(overlay);

      var form = overlay.querySelector("form");
      var errorEl = overlay.querySelector(".ep-pd__form-error");
      var saving = false;

      function close() {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        document.removeEventListener("keydown", onKey);
      }
      function onKey(ev) { if (ev.key === "Escape" && !saving) close(); }
      document.addEventListener("keydown", onKey);
      overlay.addEventListener("click", function (ev) {
        if (saving) return;
        if (ev.target === overlay || ev.target.closest("[data-pd-close]")) close();
      });

      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        if (saving) return;  // no double submissions
        errorEl.textContent = "";

        // Send only fields that changed, so a stale form cannot overwrite someone else's edit of another field.
        var payload = {};
        EDIT_FIELDS.forEach(function (f) {
          var raw = form.elements[f.key].value.trim();
          var before = plant[f.from];
          var next;
          if (f.type === "number") {
            if (raw === "") next = null;
            else {
              next = Number(raw);
              if (!Number.isFinite(next)) { errorEl.textContent = f.label + " must be a number."; payload = null; return; }
            }
          } else {
            next = raw === "" ? null : raw;
          }
          var prev = before === "" || before === undefined ? null : before;
          if (payload && String(next) !== String(prev)) payload[f.key] = next;
        });
        if (!payload) return;
        if (payload.plant_name === null) { errorEl.textContent = "Plant name is required."; return; }
        if (payload.latitude !== undefined && payload.latitude !== null && Math.abs(payload.latitude) > 90) {
          errorEl.textContent = "Latitude must be between -90 and 90."; return;
        }
        if (payload.longitude !== undefined && payload.longitude !== null && Math.abs(payload.longitude) > 180) {
          errorEl.textContent = "Longitude must be between -180 and 180."; return;
        }
        if (!Object.keys(payload).length) { close(); return; }

        saving = true;
        var submit = form.querySelector('[type="submit"]');
        submit.disabled = true;
        submit.textContent = "Saving…";
        global.Solar91PortalAPI.request("/api/plants/" + encodeURIComponent(plant.dbId), {
          method: "PATCH",
          body: payload
        }).then(function () {
          data.invalidate();
          global.Solar91PortalAPI.plants(true);
          saving = false;
          close();
          if (typeof onSaved === "function") onSaved();
        }).catch(function (error) {
          saving = false;
          submit.disabled = false;
          submit.textContent = "Save changes";
          errorEl.textContent = "Not saved. " + (error && error.message ? error.message : "Please retry.");
        });
      });

      var first = form.querySelector("input, select");
      if (first) first.focus();
    }
  };

  global.Solar91PortalPlantDetails = { render: render };
  global.Solar91PortalPlantEditor = PlantEditor;
}(window));
