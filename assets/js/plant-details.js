/**
 * plant-details.js — the plant record editor
 * ─────────────────────────────────────────────────────────────────────
 * Plants → <plant> → Details shows that plant's stored record as a single
 * table row (plants-table.js, single mode). This file holds the editor that
 * row's "Edit" button opens, shared with the portfolio table.
 *
 * It writes through the existing PATCH /api/plants/:id (permission
 * plants.manage) and sends only the fields that changed, so a stale form
 * cannot overwrite someone else's edit.
 */
(function (global) {
  "use strict";

  var data = global.Solar91PortalData;
  var fmt = global.Solar91PortalFormat;
  var esc = function (v) { return fmt.escape(v === null || v === undefined ? "" : String(v)); };

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

  global.Solar91PortalPlantEditor = PlantEditor;
}(window));
