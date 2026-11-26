
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
    { key: "supervisor",      from: "supervisor",     label: "Supervisor (optional)", type: "text" },
    { key: "district",        from: "district",       label: "District",              type: "text" },
    { key: "discom",          from: "discom",         label: "DISCOM",                type: "text" },
    { key: "address",         from: "address",        label: "Location",              type: "text" },
    { key: "latitude",        from: "latitude",       label: "Latitude",              type: "number", step: "any" },
    { key: "longitude",       from: "longitude",      label: "Longitude",             type: "number", step: "any" }
  ];

  // ─── Add a plant (POST /api/plants) ──────────────────────────────────
  //
  // The same fields the Info table shows, in the same order. Supervisor and CCTV link are optional;
  // the written Location address is required. Other Assignees are configured on Login Access.
  var CREATE_FIELDS = [
    { key: "site_code",       label: "Plant code",            type: "text",   hint: "Unique, e.g. ABH01" },
    { key: "plant_name",      label: "Plant name",            type: "text" },
    { key: "project_company", label: "SPV / project company", type: "text" },
    { key: "ac_capacity_kw",  label: "AC capacity (kW)",      type: "number", step: "any" },
    { key: "dc_capacity_kw",  label: "DC capacity (kWp)",     type: "number", step: "any" },
    { key: "district",        label: "District",              type: "text" },
    { key: "discom",          label: "DISCOM",                type: "text" },
    { key: "assigned_engineer", label: "Site engineer",       type: "text" },
    { key: "supervisor",      label: "Supervisor",            type: "text", optional: true },
    { key: "commissioned_on", label: "COD",                   type: "date" },
    { key: "address",         label: "Location",              type: "text", hint: "Full plant address" },
    { key: "latitude",        label: "Latitude",              type: "number", step: "any" },
    { key: "longitude",       label: "Longitude",             type: "number", step: "any" },
    { key: "cctv_url",        label: "CCTV link",             type: "url",    custom: true, optional: true,
      hint: "https://…" },
    { key: "status",          label: "Status",                type: "select",
      options: ["active", "commissioning", "inactive", "decommissioned"] }
  ];

  function createFieldHTML(field) {
    var required = field.optional !== true;
    var input = field.type === "select"
      ? '<select name="' + field.key + '"' + (required ? " required" : "") + ">" + field.options.map(function (option) {
          return '<option value="' + option + '"' + (option === "active" ? " selected" : "") + ">" +
                 option.charAt(0).toUpperCase() + option.slice(1) + "</option>";
        }).join("") + "</select>"
      : '<input name="' + field.key + '" type="' + field.type + '"' +
        (field.step ? ' step="' + field.step + '"' : "") +
        (field.hint ? ' placeholder="' + esc(field.hint) + '"' : "") +
        (required ? " required" : "") + " />";
    return '<label class="ep-pd__field"><span>' + esc(field.label) +
      (required ? " *" : " (optional)") + "</span>" + input + "</label>";
  }

  function refreshPlantViews() {
    data.invalidate(true);
    return global.Solar91PortalAPI.plants(true).then(function () {
      var nav = global.Solar91PortalNav;
      return nav && typeof nav.loadPlants === "function" ? nav.loadPlants() : undefined;
    });
  }

  /**
   * Open the Add New Plant overlay. `onSaved` runs after the server has confirmed the plant,
   * never before: the table, the sidebar and every cached read are refreshed from that response.
   */
  function openCreate(onSaved) {
    var user = global.Solar91PortalAPI.currentUser();
    if (!user || ["O&M Head", "Assignee"].indexOf(user.role) === -1) return;
    var overlay = document.createElement("div");
    overlay.className = "ep-pd__overlay";
    overlay.innerHTML = '' +
      '<form class="ep-pd__modal ep-pd__modal--wide" role="dialog" aria-modal="true" ' +
        'aria-labelledby="pd-create-title" novalidate>' +
        '<header class="ep-pd__modal-head"><div>' +
          '<h2 id="pd-create-title">Add new plant</h2>' +
          '<p class="ep-pd__mono">Saved to the plant catalogue and visible across the portal</p></div>' +
          '<button class="ep-pd__x" type="button" data-pd-close aria-label="Close">×</button>' +
        "</header>" +
        '<div class="ep-pd__modal-body ep-pd__modal-body--create">' +
          CREATE_FIELDS.map(createFieldHTML).join("") +
        "</div>" +
        '<p class="ep-pd__create-note">Enter the full plant address. Supervisor and CCTV link are optional. Cleaning, PM and Health Assignees ' +
          'are assigned afterwards from Login access; Preventive Maintenance and Module Cleaning ' +
          'schedules are set up separately and are not created here.</p>' +
        '<p class="ep-pd__form-error" role="alert"></p>' +
        '<footer class="ep-pd__modal-foot">' +
          '<button class="ep-pd__btn" type="button" data-pd-close>Cancel</button>' +
          '<button class="ep-pd__btn ep-pd__btn--primary" type="submit">Add plant</button>' +
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
      if (saving) return;                       // one plant per submission, never two
      errorEl.textContent = "";
      var payload = { custom_fields: {} };
      var problem = "";
      CREATE_FIELDS.forEach(function (field) {
        if (problem) return;
        var raw = String(form.elements[field.key].value || "").trim();
        if (!raw) {
          if (field.optional) return;
          problem = field.label + " is required.";
          return;
        }
        if (field.type === "number") {
          var num = Number(raw);
          if (!Number.isFinite(num)) { problem = field.label + " must be a number."; return; }
          if (field.key === "latitude" && Math.abs(num) > 90) { problem = "Latitude must be between -90 and 90."; return; }
          if (field.key === "longitude" && Math.abs(num) > 180) { problem = "Longitude must be between -180 and 180."; return; }
          if ((field.key === "ac_capacity_kw" || field.key === "dc_capacity_kw") && num <= 0) {
            problem = field.label + " must be greater than zero."; return;
          }
          payload[field.key] = num;
          return;
        }
        if (field.type === "url" && !/^https?:\/\//i.test(raw)) {
          problem = field.label + " must start with http:// or https://"; return;
        }
        if (field.custom) payload.custom_fields[field.key] = raw;
        else payload[field.key] = raw;
      });
      if (problem) { errorEl.textContent = problem; return; }

      saving = true;
      var submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      submit.textContent = "Adding…";
      global.Solar91PortalAPI.request("/api/plants", { method: "POST", body: payload })
        .then(function (plant) {
          var refresh = refreshPlantViews();
          saving = false;
          close();
          if (typeof onSaved === "function") onSaved(plant);
          refresh.then(function () {
            if (global.Solar91PortalToast) {
              global.Solar91PortalToast.success(
                (plant && plant.site_code ? plant.site_code : "Plant") + " added",
                "It is now available across the portal.");
            }
          }).catch(function (error) {
            if (global.Solar91PortalToast) {
              global.Solar91PortalToast.error(
                "Plant added, but portal refresh failed",
                (error && error.message ? error.message : "Reload the page to refresh the plant list."));
            }
          });
        }, function (error) {
          saving = false;
          submit.disabled = false;
          submit.textContent = "Add plant";
          errorEl.textContent = "Not added. " + (error && error.message ? error.message : "Please retry.");
          if (global.Solar91PortalToast) {
            global.Solar91PortalToast.error("Plant not added",
              error && error.message ? error.message : "The plant was not saved.");
          }
        });
    });

    var first = form.querySelector("input, select");
    if (first) first.focus();
  }

  var PlantEditor = {
    create: openCreate,
    open: function (plant, onSaved) {
      var user = global.Solar91PortalAPI.currentUser();
      if (!user || ["O&M Head", "Assignee"].indexOf(user.role) === -1) return;
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
          var refresh = refreshPlantViews();
          saving = false;
          close();
          if (typeof onSaved === "function") onSaved();
          refresh.catch(function (error) {
            if (global.Solar91PortalToast) {
              global.Solar91PortalToast.error(
                "Plant saved, but portal refresh failed",
                (error && error.message ? error.message : "Reload the page to refresh plant data."));
            }
          });
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
