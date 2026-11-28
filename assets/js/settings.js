/**
 * Login access management backed by the authenticated Solar91 user APIs.
 */
(function (global) {
  "use strict";

  var ROLES = ["O&M Head", "Assignee", "Administration", "Site Engineer", "Viewer"];
  var roleClasses = {
    "O&M Head": "om",
    Assignee: "assignee",
    Administration: "admin",
    "Site Engineer": "engineer",
    Viewer: "viewer"
  };
  var users = [];
  var filters = { search: "", role: "all" };
  var statusMessage = "";
  var activeHost = null;
  var wiredHost = null;
  var loading = false;
  var storageUsage = null;
  var storageLoading = false;
  var storageError = "";
  var storageMessage = "";
  // How long full-size originals are kept, and what a one-off sweep would remove. Only the
  // originals are ever deleted: thumbnails and the photo records stay, so every gallery keeps
  // its evidence.
  var retention = { loaded: false, saving: false, days: null, settings: null, purgeDays: null, preview: null, category: "", plantId: "", automatic: false, purgeCategory: "", purgePlantId: "" };
  // Equipment responsibility: who answers for one equipment category on every plant.
  // The matrix below and a person's own dialog write the same rows through the same API.
  var equipment = {
    loading: false, loaded: false, error: "", message: "",
    categories: [], holders: [], byUser: {}, search: "", saving: "",
    history: [], historyOpen: false, historyLoading: false,
    routing: {}, plants: [], routeOpen: false, routeLoading: false, routeLoaded: false, routeSaving: false, routeError: "", routeMessage: "", routeDraft: {plants: [], keys: ["*"], primary: "", backup: "", ownersTouched: false, applyExisting: false}, routeSearch: {plant: "", key: ""}, routeLoadedAt: 0, routePromise: null
  };

  function escape(value) {
    return global.Solar91PortalFormat.escape(value);
  }

  function api() {
    return global.Solar91PortalAPI;
  }

  function roleClass(role) {
    return roleClasses[role] || "viewer";
  }

  function renderRoleOptions(selected) {
    return ROLES.map(function (role) {
      return '<option value="' + escape(role) + '"' + (selected === role ? " selected" : "") +
        ">" + escape(role) + "</option>";
    }).join("");
  }

  function renderRoleChips() {
    return '<div class="ep-settings__role-legend" aria-label="Available roles">' +
      ROLES.map(function (role) {
        return '<span class="ep-settings__role-chip ep-settings__role-chip--' +
          roleClass(role) + '"><i></i>' + escape(role) + "</span>";
      }).join("") + "</div>";
  }

  function plantScope(person) {
    if (person.role === "O&M Head" || person.role === "Administration") return "All plants";
    if (person.role === "Viewer") return "No operational access";
    if (person.role === "Assignee") return "All plants";
    var assigned = (person.plants || []).map(function (plant) {
      return plant.site_code + " · " + plant.plant_name;
    });
    return assigned.length ? assigned.join(", ") : "No plants assigned";
  }

  function plantScopeSummary(person) {
    if (person.role === "O&M Head" || person.role === "Administration") return "All plants";
    if (person.role === "Viewer") return "No operational access";
    if (person.role === "Assignee") return "Portfolio-wide";
    var count = (person.plants || []).length;
    return count ? count + (count === 1 ? " plant assigned" : " plants assigned") : "No plants assigned";
  }

  function filteredUsers() {
    var term = filters.search.trim().toLowerCase();
    return users.filter(function (person) {
      if (filters.role !== "all" && person.role !== filters.role) return false;
      if (!term) return true;
      return [person.name, person.email, person.role, plantScope(person)]
        .join(" ").toLowerCase().indexOf(term) !== -1;
    });
  }

  function renderRow(person) {
    var name = person.name || person.email || "Unnamed user";
    var initials = name.split(/\s+/).map(function (part) {
      return part.charAt(0);
    }).join("").slice(0, 2).toUpperCase();
    var role = roleClass(person.role);
    var loginStatus = person.invited ? "Invite pending" : "Clerk account linked";
    var activeStatus = person.active ? "Enabled" : "Disabled";
    var actions = '<button type="button" class="ep-settings__button ep-settings__button--small" ' +
      'data-settings-action="edit-access" data-user-id="' + escape(person.id) + '">Edit role</button>' +
      '<button type="button" class="ep-settings__button ep-settings__button--small" ' +
      'data-settings-action="edit-profile" data-user-id="' + escape(person.id) + '">Edit details</button>';
    if (person.active && (person.role === "Assignee" || person.role === "O&M Head")) {
      actions += '<button type="button" class="ep-settings__button ep-settings__button--small" ' +
        'data-settings-action="edit-equipment" data-user-id="' + escape(person.id) + '">Equipment</button>';
    }
    if (person.active && person.role === "Assignee") {
      actions += '<button type="button" class="ep-settings__button ep-settings__button--small" ' +
        'data-settings-action="edit-pm-responsibility" data-user-id="' + escape(person.id) + '">PM plants (' + (person.pm_plant_ids || []).length + ')</button>';
    }
    if (person.invited && person.active) {
      actions += '<button type="button" class="ep-settings__button ep-settings__button--small" ' +
        'data-settings-action="resend" data-user-id="' + escape(person.id) + '">Resend invite</button>';
    }
    if (!person.is_self) {
      actions += '<button type="button" class="ep-settings__remove" data-settings-action="toggle-active" ' +
        'data-user-id="' + escape(person.id) + '">' + (person.active ? "Disable login" : "Enable login") + "</button>";
    }
    return '<article class="ep-settings__person ep-settings__person--' + role + '">' +
      '<div class="ep-settings__person-cell">' +
        '<span class="ep-settings__avatar" aria-hidden="true">' + escape(initials) + '</span>' +
        '<div class="ep-settings__identity"><strong>' + escape(name) +
          (person.is_self ? ' <span class="ep-settings__you">You</span>' : "") +
          '</strong><span>' + escape(person.email || "No email address") + '</span></div>' +
      '</div>' +
      '<div class="ep-settings__role-cell"><strong class="ep-settings__role-label">' + escape(person.role) +
        '</strong><span>' + escape(plantScopeSummary(person)) + '</span></div>' +
      '<div class="ep-settings__login-status">' + escape(loginStatus) + '</div>' +
      '<div class="ep-settings__status"><span class="ep-settings__status-pill' +
        (person.active ? "" : " is-removed") + '"><i></i>' + escape(activeStatus) + '</span></div>' +
      '<div class="ep-settings__actions">' + actions + '</div>' +
    "</article>";
  }

  function formatBytes(value) {
    var bytes = Math.max(0, Number(value) || 0);
    if (bytes >= 1000000000) return (bytes / 1000000000).toFixed(2) + " GB";
    if (bytes >= 1000000) return (bytes / 1000000).toFixed(1) + " MB";
    return bytes.toLocaleString("en-IN") + " B";
  }

  function renderStorageCard(canManage) {
    if (!canManage) return "";
    var usage = storageUsage;
    var capacity = usage ? Number(usage.capacity_bytes) : 1000000000;
    var used = usage ? Number(usage.used_bytes) : 0;
    var warn = usage ? Number(usage.warn_bytes) : 800000000;
    var block = usage ? Number(usage.block_bytes) : 950000000;
    var usedPercent = Math.min(100, Math.max(0, used / capacity * 100));
    var warnPercent = Math.min(100, Math.max(0, warn / capacity * 100));
    var blockPercent = Math.min(100, Math.max(0, block / capacity * 100));
    return '<section class="ep-settings__storage" aria-labelledby="settings-photo-storage-title">' +
      '<header><div><h2 id="settings-photo-storage-title">Photo storage</h2>' +
        '<p>Private Supabase Storage usage. Thumbnails and photo records are retained after originals are purged.</p></div>' +
        '<div><button type="button" class="ep-settings__button" data-settings-action="refresh-storage"' +
          (storageLoading ? " disabled" : "") + '>Refresh</button>' +
          '<button type="button" class="ep-settings__button" data-settings-action="purge-originals"' +
          (storageLoading ? " disabled" : "") + '>Preview saved policy</button></div></header>' +
      (storageLoading && !usage
        ? '<p class="ep-settings__storage-status" role="status">Reading bucket usage…</p>'
        : storageError
          ? '<p class="ep-settings__storage-error" role="alert">' + escape(storageError) + '</p>'
          : usage && usage.configured === false
            ? '<p class="ep-settings__storage-status" role="status">Supabase Storage is not configured on this environment.</p>'
          : usage
            ? '<div class="ep-settings__storage-meter" role="meter" aria-label="Photo storage used" aria-valuemin="0" aria-valuemax="' +
              capacity + '" aria-valuenow="' + used + '">' +
                '<span class="ep-settings__storage-fill" style="width:' + usedPercent + '%"></span>' +
                '<i class="is-warn" style="left:' + warnPercent + '%" aria-hidden="true"></i>' +
                '<i class="is-block" style="left:' + blockPercent + '%" aria-hidden="true"></i>' +
              '</div><div class="ep-settings__storage-legend"><strong>' + formatBytes(used) +
                ' / 1 GB used</strong><span>Warn ' + formatBytes(warn) + '</span><span>Block ' +
                formatBytes(block) + '</span></div>'
            : '<p class="ep-settings__storage-status" role="status">Storage usage is not available yet.</p>') +
      (storageMessage ? '<p class="ep-settings__storage-status" role="status">' + escape(storageMessage) + '</p>' : "") +
      renderRetention() +
      '</section>';
  }

  function retentionScope(prefix, category, plantId, info) {
    var modules = [["", "All modules"], ["pm", "Preventive maintenance"], ["washing", "Module cleaning"],
      ["issue", "Site issues"], ["inventory", "Inventory"], ["safety", "Safety"], ["other", "Other"]];
    var plants = [["", "All plants"]].concat((info.plants || []).map(function (p) { return [p.id, p.label]; }));
    function options(items, selected) {
      return items.map(function (item) { return '<option value="' + escape(item[0]) + '"' +
        (item[0] === selected ? ' selected' : '') + '>' + escape(item[1]) + '</option>'; }).join("");
    }
    return '<div class="ep-settings__retention-controls ep-settings__retention-scope">' +
      '<label>Module<select data-retention-field="' + (prefix ? "purgeCategory" : "category") + '">' + options(modules, category) + '</select></label>' +
      '<label>Plant<select data-retention-field="' + (prefix ? "purgePlantId" : "plantId") + '">' + options(plants, plantId) + '</select></label></div>';
  }

  /** The retention window and the on-demand sweep, inside the Photo storage card. */
  function renderRetention() {
    var info = retention.settings;
    if (!info) {
      return '<div class="ep-settings__retention"><p class="ep-settings__storage-status" role="status">' +
        (retention.loaded ? "Retention settings are not available." : "Reading the retention window…") + "</p></div>";
    }
    var days = retention.days == null ? info.days : retention.days;
    var purgeDays = retention.purgeDays == null ? info.days : retention.purgeDays;
    var preview = retention.preview;
    return '<div class="ep-settings__retention">' +
      '<div class="ep-settings__retention-row">' +
        '<label for="settings-retention-days">Keep full-size originals for' +
          '<span>Applies only to the selected module and plant. Thumbnails, PDF reports and photo records stay.</span></label>' +
        '<div class="ep-settings__retention-controls">' +
          '<input id="settings-retention-days" type="number" inputmode="numeric" min="' + info.min_days +
            '" max="' + info.max_days + '" step="1" value="' + escape(days) + '" data-settings-retention-days />' +
          '<span class="ep-settings__retention-unit">days</span>' +
          '<button type="button" class="ep-settings__button ep-settings__button--primary"' +
            (retention.saving ? " disabled" : "") + ' data-settings-action="save-retention">' +
            (retention.saving ? "Saving…" : "Save window") + "</button>" +
        "</div>" +
      "</div>" +
      retentionScope("", retention.category, retention.plantId, info) +
      '<label class="ep-settings__retention-note"><input type="checkbox" data-retention-field="automatic"' +
        (retention.automatic ? ' checked' : '') + '> Enable automatic cleanup (daily while server is running)</label>' +
      '<p class="ep-settings__retention-note">In force: <strong>' + escape(info.days) + ' days</strong> · ' + (info.automatic ? "Automatic enabled" : "Automatic disabled") + " · " + escape(info.category || "All modules") + " · " + escape(((info.plants || []).find(function (p) { return p.id === info.plant_id; }) || {}).label || (info.plant_id ? "Selected plant (unavailable)" : "All plants")) + " · " +
        (info.source === "portal"
          ? "set in the portal" + (info.updated_by ? " by " + escape(info.updated_by) : "") +
            (info.updated_at ? " on " + escape(new Date(info.updated_at).toLocaleDateString("en-IN")) : "")
          : "the deployment default (" + escape(info.default_days) + " days)") + "</p>" +
      '<div class="ep-settings__retention-row">' +
        '<label for="settings-purge-days">Clear space now' +
          '<span>Deletes originals older than this many days, ahead of the standing window.</span></label>' +
        '<div class="ep-settings__retention-controls">' +
          '<input id="settings-purge-days" type="number" inputmode="numeric" min="' + info.min_purge_days +
            '" max="' + info.max_days + '" step="1" value="' + escape(purgeDays) + '" data-settings-purge-days />' +
          '<span class="ep-settings__retention-unit">days</span>' +
          '<button type="button" class="ep-settings__button"' + (storageLoading ? " disabled" : "") +
            ' data-settings-action="preview-purge">Check what this removes</button>' +
          (preview && preview.photos
            ? '<button type="button" class="ep-settings__remove" data-settings-action="purge-older">Delete ' +
              escape(preview.photos) + ' original' + (preview.photos === 1 ? "" : "s") + "</button>"
            : "") +
        "</div>" +
      "</div>" +
      retentionScope("purge", retention.purgeCategory, retention.purgePlantId, info) +
      (preview
        ? '<p class="ep-settings__retention-note" role="status">' + (preview.photos
          ? escape(preview.photos) + " original" + (preview.photos === 1 ? "" : "s") + " older than " +
            escape(preview.retention_days) + " days · " + formatBytes(preview.bytes_reclaimed) +
            " would be reclaimed. Thumbnails and photo records are kept." +
            (preview.more_remaining ? " More remain after this run." : "")
          : "Nothing is older than " + escape(preview.retention_days) + " days.") + "</p>"
        : "") +
      "</div>";
  }

  function render() {
    if (!activeHost) return;
    var canManage = api().can("users.manage");
    var existingModal = activeHost.querySelector("[data-settings-modal]");
    var list = filteredUsers();
    var pageHTML = '<div class="ep-settings">' +
      '<header class="ep-settings__page-head"><div><h1>Login access</h1>' +
        '<p>Manage Clerk sign-in invitations, account status, roles, and equipment responsibility.</p></div>' +
        '<span class="ep-settings__access-badge"><i></i>Clerk sign-in</span></header>' +
      '<section class="ep-settings__panel ep-settings__team" aria-labelledby="settings-team-title">' +
        '<div class="ep-settings__panel-intro ep-settings__team-intro"><div class="ep-settings__team-title"><div class="ep-settings__team-copy"><h2 id="settings-team-title">Team &amp; access</h2>' +
          '<p>Assignees and O&amp;M Heads can work across all plants and equipment. Equipment responsibility routes site issues; PM responsibility is assigned plant-wise. Site Engineers remain assigned to one plant.</p></div>' +
          (canManage ? '<button type="button" class="ep-settings__button ep-settings__button--primary ep-settings__routing-launch" data-settings-action="open-issue-routing" aria-haspopup="dialog">Site Issue Responsibility</button>' : '') + '</div></div>' +
        (canManage ? renderRoleChips() :
          '<p class="ep-settings__message" role="status">Your account does not have permission to manage login access.</p>') +
        (canManage ? '<div class="ep-settings__toolbar">' +
          '<label class="ep-settings__sr-only" for="settings-search">Search name, email or plant</label>' +
          '<input id="settings-search" type="search" placeholder="Search name, email or plant" value="' + escape(filters.search) + '" data-settings-filter="search" />' +
          '<label class="ep-settings__sr-only" for="settings-role-filter">Filter by role</label>' +
          '<select id="settings-role-filter" data-settings-filter="role"><option value="all"' + (filters.role === "all" ? " selected" : "") + '>All roles</option>' +
            renderRoleOptions(filters.role === "all" ? "" : filters.role) + '</select>' +
          '<button type="button" class="ep-settings__button" data-settings-action="refresh">Refresh</button>' +
          '<button type="button" class="ep-settings__button ep-settings__button--primary" data-settings-action="invite">+ Invite person</button>' +
        '</div>' : "") +
        (statusMessage ? '<p class="ep-settings__message" role="status">' + escape(statusMessage) + '</p>' : "") +
        (canManage ? (loading
          ? '<p class="ep-settings__empty" role="status">Loading real user accounts…</p>'
          : '<div class="ep-settings__table" role="table" aria-label="Login access accounts">' +
            '<div class="ep-settings__table-head" role="row">' +
              '<span role="columnheader">Person</span><span role="columnheader">Access summary</span>' +
              '<span role="columnheader">Login</span><span role="columnheader">Account</span><span role="columnheader">Actions</span>' +
            '</div>' +
            (list.length
              ? list.map(renderRow).join("")
              : '<p class="ep-settings__empty">' + (users.length ? "No accounts match this search." : "No user accounts were found.") + '</p>') +
          '</div>') : "") +
        '<p class="ep-settings__footnote">Sign-in is provided by Clerk. This page manages Solar91 invitations and database-backed access; it does not display or expose Clerk credentials.</p>' +
      '</section>' +
      renderEquipmentPanel(canManage) +
      renderStorageCard(canManage) +
    "</div>";
    // Keep the native routing dialog mounted during async refreshes and form edits.
    var routingDialog = activeHost.querySelector("[data-issue-routing-dialog]");
    var page = activeHost.querySelector(".ep-settings");
    if (routingDialog && page) page.outerHTML = pageHTML;
    else {
      activeHost.innerHTML = pageHTML;
      if (existingModal) activeHost.appendChild(existingModal);
    }
    if (canManage && equipment.routeOpen) renderRoutingDialog();
    else if (routingDialog) routingDialog.remove();
  }

  // Declared here, not inside loadUsers: renderPage and the toolbar's own buttons call it.
  function loadStorageUsage(refresh) {
    if (!api().can("users.manage")) return Promise.resolve();
    storageLoading = true;
    storageError = "";
    render();
    return api().request("/api/photos/storage-usage" + (refresh ? "?refresh=true" : "")).then(function (result) {
      storageUsage = result;
      storageLoading = false;
      storageError = "";
      render();
    }).catch(function (error) {
      storageLoading = false;
      storageError = error.message || "Photo storage usage could not be loaded.";
      render();
    });
  }

  function loadRetention() {
    if (!api().can("users.manage")) return Promise.resolve();
    return api().request("/api/photos/retention").then(function (info) {
      retention.settings = info;
      retention.loaded = true;
      if (retention.days == null) {
        retention.days = info.days;
        retention.category = info.category || "";
        retention.plantId = info.plant_id || "";
        retention.automatic = !!info.automatic;
        retention.purgeCategory = retention.category;
        retention.purgePlantId = retention.plantId;
      }
      if (retention.purgeDays == null) retention.purgeDays = info.days;
      render();
    }).catch(function (error) {
      retention.loaded = true;
      storageError = error.message || "The photo retention window could not be read.";
      render();
    });
  }

  function saveRetention(host) {
    var input = host.querySelector("[data-settings-retention-days]");
    if (!input || !retention.settings) return;
    var days = Number(input.value);
    var info = retention.settings;
    if (!Number.isInteger(days) || days < info.min_days || days > info.max_days) {
      storageError = "Keep originals for " + info.min_days + "-" + info.max_days + " days.";
      render();
      return;
    }
    if (retention.automatic && !global.confirm("Enable automatic deletion of full-size originals older than " + days + " days for the selected module and plant? Thumbnails and records stay. Originals cannot be recovered.")) return;
    retention.days = days;
    retention.saving = true;
    storageError = "";
    storageMessage = "";
    render();
    api().request("/api/photos/retention", { method: "PUT", body: { days: days, category: retention.category || null, plant_id: retention.plantId || null, automatic: retention.automatic } })
      .then(function (saved) {
        retention.saving = false;
        retention.settings = saved;
        retention.days = saved.days;
        retention.preview = null;
        storageMessage = "Originals are now kept for " + saved.days + " days for the selected scope. The policy was saved; no originals were deleted by this request.";
        if (global.Solar91PortalToast) {
          global.Solar91PortalToast.success("Retention window saved", saved.days + " days");
        }
        render();
      })
      .catch(function (error) {
        retention.saving = false;
        storageError = error.message || "The retention window could not be saved.";
        render();
      });
  }

  /** Ask the server what a sweep would remove. Nothing is deleted by this call. */
  function previewPurge(host) {
    var input = host.querySelector("[data-settings-purge-days]");
    if (!input || !retention.settings) return;
    var days = Number(input.value);
    var info = retention.settings;
    if (!Number.isInteger(days) || days < info.min_purge_days || days > info.max_days) {
      storageError = "Choose between " + info.min_purge_days + " and " + info.max_days + " days.";
      render();
      return;
    }
    retention.purgeDays = days;
    var scope = [retention.purgeCategory, retention.purgePlantId, days].join("|");
    retention.preview = null;
    storageLoading = true;
    storageError = "";
    storageMessage = "";
    render();
    api().request("/api/photos/retention/purge", {
      method: "POST", body: { older_than_days: days, category: retention.purgeCategory || null, plant_id: retention.purgePlantId || null, dry_run: true }
    }).then(function (result) {
      storageLoading = false;
      if (scope === [retention.purgeCategory, retention.purgePlantId, Number(retention.purgeDays)].join("|")) retention.preview = result;
      render();
    }).catch(function (error) {
      storageLoading = false;
      storageError = error.message || "The sweep could not be checked.";
      render();
    });
  }

  function purgeOlderThan() {
    var preview = retention.preview;
    var days = retention.purgeDays;
    if (storageLoading || !preview || !preview.photos || days == null) return;
    if (!global.confirm("Delete " + preview.photos + " full-size original(s) older than " + days +
        " days for the selected module and plant? Thumbnails, PDF reports and photo records are kept, and this cannot be undone.")) return;
    storageLoading = true;
    storageError = "";
    storageMessage = "";
    retention.preview = null;
    render();
    api().request("/api/photos/retention/purge", { method: "POST", body: { older_than_days: days, category: retention.purgeCategory || null, plant_id: retention.purgePlantId || null } })
      .then(function (result) {
        storageMessage = "Deleted " + Number(result.photos || 0) + " original(s); " +
          formatBytes(result.bytes_reclaimed) + " reclaimed." +
          (result.more_remaining ? " More remain: run it again to continue." : "");
        if (global.Solar91PortalToast) {
          global.Solar91PortalToast.success("Originals deleted", formatBytes(result.bytes_reclaimed) + " reclaimed");
        }
        return loadStorageUsage(true);
      })
      .catch(function (error) {
        storageLoading = false;
        storageError = error.message || "The sweep failed.";
        if (global.Solar91PortalToast) {
          global.Solar91PortalToast.error("Originals not deleted", storageError);
        }
        render();
      });
  }

  function loadUsers() {
    if (!api().can("users.manage")) {
      loading = false;
      render();
      return Promise.resolve();
    }

    loading = true;
    render();
    return api().request("/api/users").then(function (result) {
      users = Array.isArray(result) ? result : [];
      loading = false;
      render();
    }).catch(function (error) {
      loading = false;
      statusMessage = error.message || "Could not load login access accounts.";
      render();
    });
  }

  function selectedPlantOptions(plantList, selected, useCode) {
    return plantList.map(function (plant) {
      var value = useCode ? plant.siteCode : plant.id;
      var label = plant.siteCode + " · " + plant.plantName;
      return '<option value="' + escape(value) + '"' +
        (selected.indexOf(String(value)) !== -1 ? " selected" : "") + ">" + escape(label) + "</option>";
    }).join("");
  }

  function holderOptions(selected, skip) {
    return '<option value="">Not configured</option>' + equipment.holders
      .filter(function (holder) { return holder.id !== skip; })
      .map(function (holder) {
        return '<option value="' + escape(holder.id) + '"' +
          (String(selected || "") === holder.id ? " selected" : "") + ">" +
          escape(holder.name || "Unnamed") + " · " + escape(holder.role === "O&M Head" ? "O&M Head (notifications only)" : holder.role) + "</option>";
      }).join("");
  }

  function matchesCategorySearch(category) {
    var term = equipment.search.trim().toLowerCase();
    if (!term) return true;
    return [category.label, category.area,
            category.primary && category.primary.user_name,
            category.backup && category.backup.user_name]
      .filter(Boolean).join(" ").toLowerCase().indexOf(term) !== -1;
  }

  function equipmentRow(category) {
    var primaryId = category.primary ? category.primary.user_id : "";
    var backupId = category.backup ? category.backup.user_id : "";
    var configured = !!category.primary;
    return '<div class="ep-eqr__row' + (configured ? " is-configured" : "") +
      '" role="row" data-eqr-row="' + escape(category.key) + '">' +
      '<div role="cell"><strong>' + escape(category.label) + "</strong>" +
        '<span class="ep-eqr__area">' + escape(category.area || "Plant side") + "</span></div>" +
      '<div role="cell"><select data-eqr-primary="' + escape(category.key) + '" aria-label="Primary responsible for ' +
        escape(category.label) + '">' + holderOptions(primaryId, backupId) + "</select></div>" +
      '<div role="cell"><select data-eqr-backup="' + escape(category.key) + '" aria-label="Backup responsible for ' +
        escape(category.label) + '">' + holderOptions(backupId, primaryId) + "</select></div>" +
      '<div role="cell"><span class="ep-eqr__coverage">All plants</span></div>' +
      '<div role="cell"><label class="ep-eqr__active"><input type="checkbox" data-eqr-active="' +
        escape(category.key) + '"' + (configured && category.primary.active === false ? "" : " checked") +
        ' />Active</label>' +
        '<span class="ep-eqr__status' + (configured ? " is-on" : "") + '">' +
        escape(category.status || (configured ? "Active" : "Not configured")) + "</span></div>" +
      '<div role="cell"><button type="button" class="ep-settings__button ep-settings__button--small" ' +
        'data-settings-action="save-equipment" data-equipment-key="' + escape(category.key) + '"' +
        (equipment.saving === category.key ? " disabled" : "") + ">" +
        (equipment.saving === category.key ? "Saving…" : "Save") + "</button></div>" +
    "</div>";
  }

  function routingOwnerOptions(selected) {
    return '<option value="">Not configured</option>' + equipment.holders.filter(function (h) { return h.role === "Assignee"; }).map(function (h) {
      return '<option value="' + escape(h.id) + '"' + (h.id === selected ? ' selected' : '') + '>' + escape(h.name || "Unnamed") + '</option>';
    }).join("") + (selected && !equipment.holders.some(function (h) { return h.id === selected && h.role === "Assignee"; }) ? '<option value="' + escape(selected) + '" selected>Inactive / ineligible owner</option>' : '');
  }

  /** The rule identities a draft writes: every selected plant × every selected equipment, or the default. */
  function routeCombos(d) {
    if (d.plants[0] === "*") return ["*:*"];
    var out = [];
    d.plants.forEach(function (plant) { d.keys.forEach(function (key) { out.push(plant + ":" + key); }); });
    return out;
  }

  /** The owners shared by every selected rule; blank (and mixed) when they disagree. */
  function routeOwners(combos) {
    var first = null, mixed = false;
    combos.forEach(function (identity) {
      var rule = equipment.routing[identity] || {};
      var owners = (rule.primary_user_id || "") + "|" + (rule.backup_user_id || "");
      if (first === null) first = owners; else if (owners !== first) mixed = true;
    });
    var parts = mixed || first === null ? ["", ""] : first.split("|");
    return {primary: parts[0], backup: parts[1], mixed: mixed};
  }

  function routePlantLabel(id) {
    if (id === "*") return "Portfolio default (unmatched issues)";
    var plant = equipment.plants.find(function (p) { return p.id === id; });
    return plant ? plant.site_code + " · " + plant.plant_name + (plant.active ? "" : " (inactive)") : "Removed plant";
  }

  function routePlantCode(id) {
    var plant = equipment.plants.find(function (p) { return p.id === id; });
    return plant ? plant.site_code : "Removed plant";
  }

  function routeEquipmentLabel(key) {
    if (key === "*") return "All equipment";
    var match = equipment.categories.find(function (c) { return c.key === key; });
    return match ? match.label : "Removed equipment: " + key;
  }

  function routePickedSummary(values, label, short, noun, none) {
    if (!values.length) return none;
    if (values.length === 1) return label(values[0]);
    return values.length + " " + noun + ": " + values.slice(0, 3).map(short).join(", ") +
      (values.length > 3 ? " +" + (values.length - 3) : "");
  }

  function routeMatches(text, term) { return !term || text.toLowerCase().indexOf(term) !== -1; }

  /** Everything one person answers for, read from the saved rules: portfolio categories,
   *  plant + equipment rules, plant-wide rules and the portfolio default. */
  function routeCoverage(userId) {
    var cover = {portfolio: [], byKey: {}, plantWide: [], isDefault: "", rules: 0};
    if (!userId) return cover;
    equipment.categories.forEach(function (c) {
      var entry = (c.entries || []).find(function (e) { return e.user_id === userId && e.active !== false; });
      if (entry) cover.portfolio.push({label: c.label, position: entry.position});
    });
    Object.keys(equipment.routing).forEach(function (identity) {
      var rule = equipment.routing[identity];
      var position = rule.primary_user_id === userId ? "primary" : rule.backup_user_id === userId ? "backup" : "";
      if (!position) return;
      cover.rules += 1;
      var parts = identity.split(":");
      if (parts[0] === "*") { cover.isDefault = position; return; }
      var item = {plant: parts[0], position: position};
      if (parts[1] === "*") cover.plantWide.push(item);
      else (cover.byKey[parts[1]] = cover.byKey[parts[1]] || []).push(item);
    });
    var byCode = function (a, b) { return routePlantCode(a.plant).localeCompare(routePlantCode(b.plant)); };
    cover.plantWide.sort(byCode);
    Object.keys(cover.byKey).forEach(function (key) { cover.byKey[key].sort(byCode); });
    return cover;
  }

  function coverBackup(position) { return position === "backup" ? ' <small class="ep-cover__backup">(backup)</small>' : ""; }
  function coverPlant(item) { return escape(routePlantCode(item.plant)) + coverBackup(item.position); }

  /** The first `limit` items; "+N more" reveals the rest on hover (mouse) or click (touch, keyboard). */
  function coverList(items, limit, separator) {
    var rest = items.slice(limit);
    return '<span class="ep-cover__list" data-cover-list>' + items.slice(0, limit).join(separator) +
      (rest.length ? '<span class="ep-cover__rest" hidden>' + separator + rest.join(separator) + '</span>' +
        '<button type="button" class="ep-cover__more" data-cover-more data-cover-count="' + rest.length +
        '" aria-expanded="false">+' + rest.length + ' more</button>' : "") + "</span>";
  }

  function coverLine(label, value) {
    return '<span class="ep-cover__line"><b>' + escape(label) + ':</b> ' + value + "</span>";
  }

  /** The routing dialog's read-out for the person picked as primary or backup. */
  function coverageHTML(userId, slot) {
    if (!userId) return '<div class="ep-cover ep-cover--empty"></div>';
    var person = equipment.holders.find(function (h) { return h.id === userId; });
    var name = person ? person.name || "Unnamed" : "This person";
    var c = routeCoverage(userId);
    var lines = [];
    if (c.isDefault) lines.push(coverLine("Portfolio default", "unmatched issues" + coverBackup(c.isDefault)));
    if (c.portfolio.length) lines.push(coverLine("All plants", coverList(c.portfolio.map(function (p) { return escape(p.label) + coverBackup(p.position); }), 3, ", ")));
    if (c.plantWide.length) lines.push(coverLine("All equipment at", coverList(c.plantWide.map(coverPlant), 4, ", ")));
    Object.keys(c.byKey).sort(function (a, b) { return routeEquipmentLabel(a).localeCompare(routeEquipmentLabel(b)); }).forEach(function (key) {
      lines.push(coverLine(routeEquipmentLabel(key), coverList(c.byKey[key].map(coverPlant), 4, ", ")));
    });
    return '<div class="ep-cover" data-cover="' + slot + '"><p class="ep-cover__title"><strong>' + escape(name) + "</strong> " +
      (lines.length ? "already covers" + (c.rules ? " · " + c.rules + " routing rule" + (c.rules === 1 ? "" : "s") : "") : "has no site issue responsibility yet") + "</p>" +
      (lines.length ? coverList(lines, 4, "") : "") + "</div>";
  }

  // A dropdown-shaped checklist. The first option ("default" / "All equipment") excludes the rest.
  function routingPicker(name, label, summary, options) {
    var term = equipment.routeSearch[name].trim().toLowerCase();
    return '<div class="ep-issue-routing__field"><span class="ep-issue-routing__label">' + escape(label) + '</span>' +
      '<details class="ep-issue-routing__picker" data-routing-picker="' + name + '">' +
      '<summary class="ep-issue-routing__picker-button">' + escape(summary) + '</summary>' +
      '<div class="ep-issue-routing__picker-panel" role="group" aria-label="' + escape(label) + '">' +
      '<input type="search" class="ep-issue-routing__picker-search" data-routing-search="' + name + '" value="' +
        escape(equipment.routeSearch[name]) + '" placeholder="Search" aria-label="Search ' + escape(label.toLowerCase()) + '" autocomplete="off">' +
      '<div class="ep-issue-routing__picker-actions">' +
        '<button type="button" class="ep-settings__button ep-settings__button--small" data-settings-action="routing-select-all" data-picker="' + name + '">Select all</button>' +
        '<button type="button" class="ep-settings__button ep-settings__button--small" data-settings-action="routing-clear" data-picker="' + name + '">Clear</button></div>' +
      '<div class="ep-issue-routing__picker-list">' + options.map(function (o) {
        return '<label class="ep-issue-routing__option' + (o.lead ? ' is-lead' : '') + '" data-routing-option="' + escape(o.text.toLowerCase()) + '"' +
          (!o.lead && !routeMatches(o.text, term) ? ' hidden' : '') + '><input type="checkbox" data-routing-' + name + '="' + escape(o.value) + '"' +
          (o.checked ? ' checked' : '') + '> ' + escape(o.text) + '</label>';
      }).join("") + '</div></div></details></div>';
  }

  function renderIssueRouting() {
    if (equipment.loading || equipment.routeLoading) return '<div class="ep-issue-routing"><p role="status">Loading assignment rules…</p></div>';
    if (!equipment.loaded || !equipment.routeLoaded) return '<div class="ep-issue-routing"><p role="alert">' + escape(equipment.error || equipment.routeError || 'Assignment rules not loaded.') + '</p><button type="button" class="ep-settings__button" data-settings-action="reload-issue-routing">Retry</button></div>';
    var d = equipment.routeDraft;
    var plants = equipment.plants;
    var isDefault = d.plants[0] === "*";
    var ready = d.plants.length > 0 && (isDefault || d.keys.length > 0);
    var combos = ready ? routeCombos(d) : [];
    var existing = combos.filter(function (identity) { return !!equipment.routing[identity]; }).length;
    var allKeys = Object.keys(equipment.routing).sort();
    var keys = d.plants.length ? allKeys.filter(function (identity) { return d.plants.indexOf(identity.split(":")[0]) !== -1; }) : allKeys.slice(0, 50);
    var ownerLabel = function (id) {
      var match = equipment.holders.find(function (h) { return h.id === id; });
      return match ? match.name : (id ? "Inactive / ineligible" : "Not configured");
    };
    var plantOptions = [{value: "*", text: routePlantLabel("*"), checked: isDefault, lead: true}]
      .concat(plants.filter(function (p) { return p.active || d.plants.indexOf(p.id) !== -1; })
        .map(function (p) { return {value: p.id, text: routePlantLabel(p.id), checked: d.plants.indexOf(p.id) !== -1}; }))
      .concat(d.plants.filter(function (id) { return id !== "*" && !plants.some(function (p) { return p.id === id; }); })
        .map(function (id) { return {value: id, text: "Removed plant", checked: true}; }));
    var keyOptions = [{value: "*", text: "All equipment (plant-wide rule)", checked: d.keys[0] === "*", lead: true}]
      .concat(equipment.categories.map(function (c) { return {value: c.key, text: c.label, checked: d.keys.indexOf(c.key) !== -1}; }))
      .concat(d.keys.filter(function (k) { return k !== "*" && !equipment.categories.some(function (c) { return c.key === k; }); })
        .map(function (k) { return {value: k, text: routeEquipmentLabel(k), checked: true}; }));
    var plantPicker = routingPicker("plant", "Plant or default",
      isDefault ? routePlantLabel("*") : routePickedSummary(d.plants, routePlantLabel, routePlantCode, "plants", "Choose scope"), plantOptions);
    var keyPicker = isDefault
      ? '<div class="ep-issue-routing__field"><span class="ep-issue-routing__label">Equipment</span><div class="ep-issue-routing__picker-button is-disabled" aria-disabled="true">All equipment</div></div>'
      : routingPicker("key", "Equipment", routePickedSummary(d.keys, routeEquipmentLabel, routeEquipmentLabel, "equipment", "Choose equipment"), keyOptions);
    var scope = "";
    if (combos.length > 1) {
      scope = combos.length + " rules will be saved (" + d.plants.length + " plant" + (d.plants.length === 1 ? "" : "s") + " × " +
        d.keys.length + " equipment)" + (existing ? "; " + existing + " already exist and will be replaced" : "") + ".";
    }
    if (combos.length && !d.ownersTouched && routeOwners(combos).mixed) scope += (scope ? " " : "") + "The selected rules have different owners; choose the owners to apply to all of them.";
    return '<div class="ep-issue-routing"><h3>Plant exceptions and portfolio default</h3>' +
      '<p>Plant + equipment overrides take priority, then plant-wide rules, then portfolio equipment owners, then the default. Each rule tries its eligible primary before backup. PM responsibility is separate.</p>' +
      '<fieldset class="ep-issue-routing__editor"' + (equipment.routeSaving ? ' disabled' : '') + '><div class="ep-issue-routing__fields">' +
      plantPicker + keyPicker +
      '<label>Primary Assignee<select data-routing-field="primary">' + routingOwnerOptions(d.primary) + '</select></label>' +
      '<label>Backup Assignee<select data-routing-field="backup">' + routingOwnerOptions(d.backup) + '</select></label>' +
      (d.primary || d.backup ? coverageHTML(d.primary, "primary") + coverageHTML(d.backup, "backup") : "") + '</div>' +
      (scope ?'<p class="ep-issue-routing__scope" role="status">' + escape(scope) + '</p>' : "") +
      (equipment.routeError ? '<p class="ep-settings__form-error" role="alert">' + escape(equipment.routeError) + '</p>' : "") +
      (equipment.routeMessage ? '<p class="ep-settings__message" role="status">' + escape(equipment.routeMessage) + '</p>' : "") +
      '<div class="ep-issue-routing__actions"><label><input type="checkbox" data-routing-field="applyExisting"' + (d.applyExisting ? ' checked' : '') + '> Also assign matching open, unassigned issues</label>' +
      '<button type="button" class="ep-settings__button ep-settings__button--primary" data-settings-action="save-issue-routing"' + (equipment.routeSaving || !ready ? ' disabled' : '') + '>' + (equipment.routeSaving ? 'Saving…' : combos.length > 1 ? 'Save ' + combos.length + ' rules' : 'Save rule') + '</button>' +
      '<button type="button" class="ep-settings__button" data-settings-action="remove-issue-routing"' + (equipment.routeSaving || !existing ? ' disabled' : '') + '>' + (existing > 1 ? 'Remove ' + existing + ' rules' : 'Remove rule') + '</button></div></fieldset>' +
      '<p class="ep-settings__footnote">Existing assigned issues are never transferred by these rules. If no eligible owner is configured, the existing unassigned escalation / Assignee self-assignment remains in place.</p>' +
      '<p class="ep-settings__footnote">' + keys.length + ' rule(s) shown of ' + allKeys.length + ' saved. Choose plants or the default to see their rules.' + '</p>' +
      (keys.length ? '<div class="ep-issue-routing__list">' + keys.map(function (identity) {
        var parts = identity.split(":"), rule = equipment.routing[identity];
        var plant = plants.find(function (p) { return p.id === parts[0]; });
        return '<div class="ep-issue-routing__item' + (combos.indexOf(identity) !== -1 ? ' is-selected' : '') + '"><div><strong>' + escape(plant ? plant.site_code : (parts[0] === "*" ? "Portfolio default" : "Removed plant")) + ' · ' + escape(routeEquipmentLabel(parts[1])) + '</strong><small>Primary: ' + escape(ownerLabel(rule.primary_user_id)) + ' · Backup: ' + escape(ownerLabel(rule.backup_user_id)) + '</small></div><button type="button" class="ep-settings__button" data-settings-action="edit-issue-routing" data-rule-key="' + escape(identity) + '">Edit</button></div>';
      }).join("") + '</div>' : '<p class="ep-settings__empty">No plant exceptions or default configured.</p>') + '</div>';
  }

  function renderRoutingDialog() {
    if (!activeHost || !equipment.routeOpen || !api().can("users.manage")) return;
    var dialog = activeHost.querySelector("[data-issue-routing-dialog]");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "ep-settings__routing-dialog";
      dialog.setAttribute("data-issue-routing-dialog", "");
      dialog.setAttribute("aria-labelledby", "settings-routing-title");
      dialog.innerHTML = '<header class="ep-settings__routing-head"><div><h2 id="settings-routing-title">Site Issue Responsibility</h2><p>Automatic assignment · Primary and backup owners</p></div><button type="button" class="ep-settings__icon-close" data-settings-action="close-issue-routing" aria-label="Close site issue responsibility">×</button></header>' +
        '<div class="ep-settings__routing-body"><div class="ep-settings__routing-links"><button type="button" class="ep-settings__button" data-settings-action="view-portfolio-equipment">Portfolio equipment responsibility</button><span>Plant exceptions &amp; default</span></div><div data-routing-content></div></div>';
      dialog.addEventListener("cancel", function (event) {
        event.preventDefault();
        // Escape closes an open checklist first, then the dialog.
        var picker = dialog.querySelector("[data-routing-picker][open]");
        if (picker) { picker.open = false; picker.querySelector("summary").focus(); return; }
        closeIssueRouting();
      });
      activeHost.appendChild(dialog);
    }
    var body = dialog.querySelector(".ep-settings__routing-body");
    var content = dialog.querySelector("[data-routing-content]");
    var html = renderIssueRouting();
    if (content._routingHTML !== html) {
      var scroll = body.scrollTop;
      var focused = document.activeElement;
      var focusAttr = null, focusValue = null;
      if (content.contains(focused)) {
        ["data-routing-field", "data-routing-plant", "data-routing-key", "data-routing-search"].some(function (attr) {
          if (!focused.hasAttribute(attr)) return false;
          focusAttr = attr; focusValue = focused.getAttribute(attr);
          return true;
        });
      }
      var openPicker = content.querySelector("[data-routing-picker][open]");
      var openName = openPicker && openPicker.getAttribute("data-routing-picker");
      var listScroll = openPicker ? openPicker.querySelector(".ep-issue-routing__picker-list").scrollTop : 0;
      content.innerHTML = html;
      content._routingHTML = html;
      var reopened = openName && content.querySelector('[data-routing-picker="' + openName + '"]');
      if (reopened) {
        reopened.open = true;
        reopened.querySelector(".ep-issue-routing__picker-list").scrollTop = listScroll;
      }
      if (focusAttr) {
        var quoted = global.CSS && global.CSS.escape ? global.CSS.escape(focusValue) : focusValue;
        var next = content.querySelector("[" + focusAttr + '="' + quoted + '"]');
        if (next && !next.disabled) next.focus({preventScroll: true});
      }
      body.scrollTop = scroll;
    }
    if (!dialog.open) dialog.showModal();
  }

  function openIssueRouting() {
    if (!api().can("users.manage") || equipment.routeOpen) return;
    equipment.routeOpen = true;
    equipment.routeMessage = "";
    // The header shortcut is usable even while the initial catalogue is loading.
    if (!equipment.loaded && !equipment.loading) loadEquipment(false);
    loadIssueRouting(true);
    renderRoutingDialog();
  }

  function closeIssueRouting() {
    equipment.routeOpen = false;
    if (!activeHost) return;
    var dialog = activeHost.querySelector("[data-issue-routing-dialog]");
    if (dialog) { dialog.close(); dialog.remove(); }
    var launch = activeHost.querySelector('[data-settings-action="open-issue-routing"]');
    if (launch) launch.focus({preventScroll: true});
  }

  /** A fresh draft for these plants/equipment. Owners the user has already picked survive a
   *  scope change; otherwise they are read from the saved rules (blank when those disagree). */
  function routeDraftFor(plants, keys, keepOwners) {
    var d = equipment.routeDraft;
    var next = {plants: plants, keys: plants[0] === "*" ? ["*"] : keys, primary: d.primary, backup: d.backup,
                ownersTouched: !!keepOwners && d.ownersTouched, applyExisting: !!keepOwners && d.applyExisting};
    if (!next.ownersTouched) {
      var owners = routeOwners(next.plants.length && next.keys.length ? routeCombos(next) : []);
      next.primary = owners.primary; next.backup = owners.backup;
    }
    return next;
  }

  function selectIssueRouting(plants, keys, keepOwners) {
    if (equipment.routeSaving) return;
    equipment.routeDraft = routeDraftFor(plants, keys, keepOwners);
    renderRoutingDialog();
  }

  /** Checking the lead option ("*") clears the others; checking any other clears the lead. */
  function toggleRoutePick(list, value, on) {
    if (!on) return list.filter(function (item) { return item !== value; });
    if (value === "*") return ["*"];
    return list.filter(function (item) { return item !== "*" && item !== value; }).concat([value]);
  }

  function saveIssueRouting(remove) {
    var d = equipment.routeDraft;
    var isDefault = d.plants[0] === "*";
    if (!d.plants.length || (!isDefault && !d.keys.length) || equipment.routeSaving) return;
    var combos = routeCombos(d);
    var existing = combos.filter(function (identity) { return !!equipment.routing[identity]; }).length;
    if (remove && !existing) return;
    if (!remove && !d.primary && !d.backup) { equipment.routeError = "Choose at least one Assignee, or remove the rule."; renderRoutingDialog(); return; }
    if (!remove && d.primary && d.primary === d.backup) { equipment.routeError = "Primary and backup must be different people."; renderRoutingDialog(); return; }
    if (remove && !global.confirm(existing > 1
        ? "Remove these " + existing + " responsibility rules? Existing assigned issues will not change."
        : "Remove this responsibility rule? Existing assigned issues will not change.")) return;
    if (!remove && combos.length > 1 && !global.confirm("Save this rule for " + combos.length + " plant/equipment combinations? Existing rules for those combinations will be replaced.")) return;
    if (!remove && d.applyExisting && !global.confirm("Assign matching open issues that currently have no owner?")) return;
    equipment.routeSaving = true; equipment.routeError = ""; equipment.routeMessage = ""; renderRoutingDialog();
    api().request("/api/equipment-responsibilities/issue-routing", {method: "PUT", body: {
      plant_ids: isDefault ? [] : d.plants, equipment_keys: isDefault ? ["*"] : d.keys,
      primary_user_id: remove ? null : d.primary || null, backup_user_id: remove ? null : d.backup || null,
      apply_existing: !remove && d.applyExisting
    }}).then(function (result) {
      equipment.routeSaving = false; equipment.routing = result.rules || {}; equipment.routeLoadedAt = Date.now();
      var count = remove ? existing : combos.length;
      equipment.routeMessage = (count > 1 ? count + (remove ? " rules removed. " : " rules saved. ") : remove ? "Rule removed. " : "Rule saved. ") +
        (result.issues_auto_assigned || 0) + " existing issues assigned.";
      selectIssueRouting(d.plants, d.keys);
    }).catch(function (error) { equipment.routeSaving = false; equipment.routeError = error.message || "Could not save the rule."; renderRoutingDialog(); });
  }

  function renderEquipmentPanel(canManage) {
    if (!canManage) return "";
    var rows = equipment.categories.filter(matchesCategorySearch);
    var configured = equipment.categories.filter(function (c) { return !!c.primary; }).length;
    return '<section class="ep-settings__panel ep-eqr" aria-labelledby="settings-equipment-title">' +
      '<div class="ep-settings__panel-intro"><h2 id="settings-equipment-title">Equipment responsibility</h2>' +
        '<p>Who answers for one equipment category across every plant. A new site issue for that ' +
        'equipment follows plant exceptions first, then the portfolio owner and backup. Saving an owner also assigns matching open, unassigned issues; existing owners are preserved. The ' +
        'same people are notified about its Preventive Maintenance. Every Assignee may edit schedules for all equipment and plants. Approval authority ' +
        'and sequence overrides are unchanged by this: they stay with the role and the plant ' +
        'assignments above. ' + configured + ' of ' + equipment.categories.length +
        ' categories configured.</p></div>' +
      '<div class="ep-settings__toolbar">' +
        '<label class="ep-settings__sr-only" for="settings-equipment-search">Search equipment categories</label>' +
        '<input id="settings-equipment-search" type="search" placeholder="Search equipment or person" value="' +
          escape(equipment.search) + '" data-settings-filter="equipment-search" />' +
        '<button type="button" class="ep-settings__button" data-settings-action="refresh-equipment">Refresh</button>' +
        '<button type="button" class="ep-settings__button" data-settings-action="toggle-equipment-history">' +
          (equipment.historyOpen ? "Hide change history" : "Change history") + "</button>" +
        '<button type="button" class="ep-settings__button" data-settings-action="toggle-issue-routing" aria-haspopup="dialog">Manage site issue plant exceptions and default</button>' +
      "</div>" +
      (equipment.message ? '<p class="ep-settings__message" role="status">' + escape(equipment.message) + "</p>" : "") +
      (equipment.error ? '<p class="ep-settings__form-error" role="alert">' + escape(equipment.error) + "</p>" : "") +
      (equipment.loading && !equipment.loaded
        ? '<p class="ep-settings__empty" role="status">Loading equipment responsibilities…</p>'
        : '<div class="ep-eqr__table" role="table" aria-label="Equipment responsibility matrix">' +
          '<div class="ep-eqr__head" role="row"><span role="columnheader">Equipment category</span>' +
            '<span role="columnheader">Primary Assignee</span><span role="columnheader">Backup Assignee</span>' +
            '<span role="columnheader">Coverage</span><span role="columnheader">Responsibility</span>' +
            '<span role="columnheader">Edit</span></div>' +
          (rows.length ? rows.map(equipmentRow).join("")
            : '<p class="ep-settings__empty">No equipment category matches this search.</p>') +
        "</div>") +
      (equipment.historyOpen
        ? '<div class="ep-eqr__history">' + (equipment.historyLoading
          ? '<p class="ep-settings__empty" role="status">Loading change history…</p>'
          : equipment.history.length
            ? "<ul>" + equipment.history.map(function (entry) {
                return "<li><strong>" + escape(entry.equipment_label || entry.equipment_key) + "</strong> · " +
                  escape(entry.action) + (entry.user_name ? " · " + escape(entry.user_name) : "") +
                  "<span>" + escape(entry.actor || "Unknown") + " · " +
                  escape(entry.created_at ? new Date(entry.created_at).toLocaleString("en-IN") : "") +
                  "</span></li>";
              }).join("") + "</ul>"
            : '<p class="ep-settings__empty">No responsibility change has been recorded yet.</p>') + "</div>"
        : "") +
    "</section>";
  }

  function loadEquipment(force) {
    if (!api().can("users.manage")) return Promise.resolve();
    if (equipment.loading) return Promise.resolve();
    if (equipment.loaded && !force) return Promise.resolve();
    equipment.loading = true;
    equipment.error = "";
    render();
    return api().request("/api/equipment-responsibilities?include_routing=false").then(function (body) {
      equipment.categories = Array.isArray(body.categories) ? body.categories : [];
      equipment.holders = Array.isArray(body.holders) ? body.holders : [];
      equipment.byUser = body.by_user || {};
      equipment.loading = false;
      equipment.loaded = true;
      render();
    }).catch(function (error) {
      equipment.loading = false;
      equipment.error = error.message || "Equipment responsibilities could not be loaded.";
      render();
    });
  }

  function loadIssueRouting(force) {
    if (!api().can("users.manage") || equipment.routeSaving) return Promise.resolve();
    // A caller arriving mid-load waits for that load instead of seeing the rules missing.
    if (equipment.routeLoading) return equipment.routePromise || Promise.resolve();
    if (equipment.routeLoaded && !force) return Promise.resolve();
    equipment.routeLoading = true; equipment.routeError = "";
    renderRoutingDialog();
    equipment.routePromise = api().request("/api/equipment-responsibilities/issue-routing").then(function (body) {
      equipment.routing = body.issue_routing || {};
      equipment.plants = Array.isArray(body.plants) ? body.plants : [];
      equipment.routeLoaded = true;
      equipment.routeLoadedAt = Date.now();
      // Refresh the selected rule as well, so reopening cannot resave an old owner.
      equipment.routeDraft = routeDraftFor(equipment.routeDraft.plants, equipment.routeDraft.keys, false);
    }).catch(function (error) {
      equipment.routeLoaded = false;
      equipment.routeError = error.message || "Assignment rules could not be loaded.";
    }).finally(function () { equipment.routeLoading = false; renderRoutingDialog(); });
    return equipment.routePromise;
  }

  function loadEquipmentHistory() {
    equipment.historyLoading = true;
    render();
    return api().request("/api/equipment-responsibilities/history?limit=40").then(function (body) {
      equipment.history = Array.isArray(body.entries) ? body.entries : [];
      equipment.historyLoading = false;
      render();
    }).catch(function (error) {
      equipment.historyLoading = false;
      equipment.error = error.message || "The change history could not be loaded.";
      render();
    });
  }

  function saveCategory(key, host) {
    var row = host.querySelector('[data-eqr-row="' + key + '"]');
    if (!row) return;
    var primary = row.querySelector("[data-eqr-primary]").value || null;
    var backup = row.querySelector("[data-eqr-backup]").value || null;
    var active = row.querySelector("[data-eqr-active]").checked;
    if (primary && backup && primary === backup) {
      equipment.error = "The backup must be a different person from the primary.";
      render();
      return;
    }
    equipment.saving = key;
    equipment.error = "";
    equipment.message = "";
    render();
    api().request("/api/equipment-responsibilities/category/" + encodeURIComponent(key), {
      method: "PUT",
      body: { primary_user_id: primary, backup_user_id: backup, active: active }
    }).then(function (result) {
      equipment.saving = "";
      equipment.message = "Equipment responsibility saved across all plants. " + (result.issues_auto_assigned || 0) + " existing open issues assigned.";
      if (global.Solar91PortalToast) {
        global.Solar91PortalToast.success("Equipment responsibility saved");
      }
      return loadEquipment(true);
    }).catch(function (error) {
      equipment.saving = "";
      equipment.error = error.message || "The responsibility could not be saved.";
      render();
    });
  }

  function equipmentModalHTML(person) {
    var mine = equipment.byUser[person.id] || [];
    var cover = equipment.routeLoaded ? routeCoverage(person.id) : null;
    var rows = equipment.categories.map(function (category) {
      var entry = (category.entries || []).find(function (item) { return item.user_id === person.id; });
      var value = entry && entry.active ? entry.position : "";
      var plantRules = cover ? cover.byKey[category.key] || [] : [];
      // Plant codes are searchable too, so "PDA01" finds every equipment held there.
      var searchText = [category.label].concat(plantRules.map(function (item) { return routePlantCode(item.plant); })).join(" ").toLowerCase();
      return '<li class="ep-eqr__pick" data-eqr-pick="' + escape(searchText) + '">' +
        "<span><strong>" + escape(category.label) + "</strong><small>" +
          escape(category.area || "Plant side") +
          (category.primary && category.primary.user_id !== person.id
            ? " · primary: " + escape(category.primary.user_name || "") : "") + "</small>" +
          (plantRules.length ? '<small class="ep-cover__row">Plants: ' + coverList(plantRules.map(coverPlant), 3, ", ") + "</small>" : "") +
        "</span>" +
        '<select name="eqr:' + escape(category.key) + '" aria-label="' + escape(category.label) + '">' +
          '<option value=""' + (value ? "" : " selected") + ">None</option>" +
          '<option value="primary"' + (value === "primary" ? " selected" : "") + ">Primary</option>" +
          '<option value="backup"' + (value === "backup" ? " selected" : "") + ">Backup</option>" +
        "</select></li>";
    }).join("");
    var summary = "";
    if (!cover) {
      summary = '<p class="ep-cover ep-cover--modal ep-cover--note" role="status">Plant rules could not be loaded; only all-plant responsibility is shown.</p>';
    } else if (cover.rules) {
      var lines = [];
      if (cover.isDefault) lines.push(coverLine("Portfolio default", "unmatched issues" + coverBackup(cover.isDefault)));
      if (cover.plantWide.length) lines.push(coverLine("All equipment at", coverList(cover.plantWide.map(coverPlant), 4, ", ")));
      summary = '<div class="ep-cover ep-cover--modal"><p class="ep-cover__title">Named in <strong>' + cover.rules +
        " site issue routing rule" + (cover.rules === 1 ? "" : "s") + "</strong>; plant rules are listed under each equipment below. Edit them in Site Issue Responsibility.</p>" +
        (lines.length ? coverList(lines, 2, "") : "") + "</div>";
    }
    return '<p class="ep-eqr__modal-intro">' + escape(person.name || person.email) +
        " answers for the equipment selected here on <strong>every plant</strong>. This routes new tickets" +
        " and notifications; it grants no approval or override authority, and currently holds " + mine.length +
        " categor" + (mine.length === 1 ? "y" : "ies") + ".</p>" + summary +
      '<div class="ep-eqr__modal-tools">' +
        '<input type="search" placeholder="Search equipment" data-eqr-search aria-label="Search equipment categories" />' +
        '<button type="button" class="ep-settings__button ep-settings__button--small" data-eqr-bulk="primary">Select all as primary</button>' +
        '<button type="button" class="ep-settings__button ep-settings__button--small" data-eqr-bulk="none">Clear all</button>' +
      "</div>" +
      '<ul class="ep-eqr__picks">' + rows + "</ul>";
  }

  function modalHTML(mode, person, plantList) {
    var isProfile = mode === "profile";
    var role = person ? person.role : "Viewer";
    var selectedIds = person ? (person.plants || []).map(function (plant) { return String(plant.plant_id); }) : [];
    var selectedCodes = person ? (person.plants || []).map(function (plant) { return String(plant.site_code); }) : [];
    var title = mode === "invite" ? "Invite a person"
      : mode === "equipment" ? "Equipment responsibility"
      : mode === "pm-responsibility" ? "PM plant responsibility"
      : (isProfile ? "Edit person details" : "Change role");
    var plantsRequired = role === "Site Engineer";
    var fields;
    if (mode === "equipment") {
      fields = equipmentModalHTML(person);
    } else if (mode === "pm-responsibility") {
      var owned = person.pm_plant_ids || [];
      var owners = {};
      users.forEach(function (u) { (u.pm_plant_ids || []).forEach(function (id) { owners[id] = u; }); });
      fields = '<p>Choose the plants for which ' + escape(person.name) + ' owns all PM equipment. Selecting a plant transfers responsibility from its current owner; clearing it releases responsibility. Portfolio editing access is unchanged.</p>' +
        '<div class="ep-eqr__picks ep-pm-plant-picks">' + plantList.filter(function (p) {
          return String(p.status || "active").toLowerCase() !== "inactive";
        }).map(function (p) {
          var owner = owners[p.id];
          return '<label class="ep-eqr__pick"><span><strong>' + escape(p.siteCode + " · " + p.plantName) + '</strong><small>' +
            escape(owner ? owner.name + (owner.active ? "" : " (disabled)") : "Unassigned") + '</small></span>' +
            '<input type="checkbox" name="pm_plants" value="' + escape(p.id) + '"' +
            (owned.indexOf(p.id) >= 0 ? ' checked' : '') + ' /></label>';
        }).join("") + '</div>';
    } else if (isProfile) {
      var isInvited = person.invited;
      fields = '<label>Name<input name="name" required maxlength="255" value="' + escape(person.name || "") + '" /></label>' +
        '<label>Email<input name="email" type="email" maxlength="240" value="' + escape(person.email || "") + '"' +
          (isInvited ? "" : " disabled") + ' /></label>' +
        '<p>' + (isInvited ? "Updating an invited email address resends the Clerk sign-in invitation." :
          "This email is verified by Clerk and cannot be changed here.") + '</p>';
    } else {
      fields = (mode === "invite"
        ? '<label>Name<input name="name" required maxlength="255" autocomplete="name" /></label>' +
          '<label>Email<input name="email" type="email" required maxlength="240" autocomplete="email" /></label>'
        : "") +
        '<label>Role<select name="role" data-settings-role>' + renderRoleOptions(role) + '</select></label>' +
        '<label class="ep-settings__plant-field' + (plantsRequired ? "" : " is-hidden") + '" data-plant-field>' +
          'Assigned plants<select name="plants" multiple size="7" data-settings-plants' + (plantsRequired ? " required" : "") +
          '>' + selectedPlantOptions(plantList, mode === "invite" ? selectedCodes : selectedIds, mode === "invite") +
          '</select></label>' +
        '<p data-plant-help>' + (role === "Site Engineer" ? "Select exactly one plant." :
          role === "Assignee" ? "All plants and equipment are available. Equipment responsibility is used for automatic assignment." :
          "Portfolio roles have access to all plants.") + '</p>';
    }
    return '<div class="ep-settings__modal" data-settings-modal>' +
      '<button class="ep-settings__backdrop" type="button" data-settings-action="close" aria-label="Close dialog"></button>' +
      '<section class="ep-settings__dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">' +
        '<header><div><p>Login access</p><h2 id="settings-dialog-title">' + escape(title) + '</h2></div>' +
          '<button type="button" class="ep-settings__icon-close" data-settings-action="close" aria-label="Close">×</button></header>' +
        '<form data-settings-form data-mode="' + escape(mode) + '"' +
          (person ? ' data-user-id="' + escape(person.id) + '" data-expected-name="' + escape(person.name || "") +
            '" data-expected-email="' + escape(person.email || "") + '"' : "") + '>' +
          fields +
          '<footer><button type="button" class="ep-settings__button" data-settings-action="close">Cancel</button>' +
            '<button type="submit" class="ep-settings__button ep-settings__button--primary">' +
              (mode === "invite" ? "Send invitation" : "Save changes") + '</button></footer>' +
        '</form>' +
      '</section>' +
    '</div>';
  }

  function closeModal() {
    if (!activeHost) return;
    var modal = activeHost.querySelector("[data-settings-modal]");
    if (modal) modal.remove();
  }

  function openModal(mode, person) {
    statusMessage = "";
    var plantsPromise = mode === "profile" ? Promise.resolve([]) : api().plants(mode === "pm-responsibility");
    plantsPromise.then(function (plantList) {
      if (!activeHost) return;
      var wrapper = document.createElement("div");
      wrapper.innerHTML = modalHTML(mode, person, plantList);
      var modal = wrapper.firstElementChild;
      activeHost.appendChild(modal);
      var first = modal.querySelector('input:not([disabled]), select');
      if (first) first.focus();
    }).catch(function (error) {
      statusMessage = error.message || "Could not load plants for access settings.";
      render();
    });
  }

  function updatePlantField(form) {
    var roleSelect = form.querySelector("[data-settings-role]");
    var plantField = form.querySelector("[data-plant-field]");
    var plantSelect = form.querySelector("[data-settings-plants]");
    var help = form.querySelector("[data-plant-help]");
    if (!roleSelect || !plantField || !plantSelect) return;
    var role = roleSelect.value;
    var needsPlants = role === "Site Engineer";
    plantField.classList.toggle("is-hidden", !needsPlants);
    plantSelect.required = needsPlants;
    if (help) {
      help.textContent = role === "Site Engineer" ? "Select exactly one plant." :
        role === "Assignee" ? "All plants and equipment are available. Equipment responsibility is used for automatic assignment." :
        "Portfolio roles have access to all plants.";
    }
  }

  function wire(host) {
    if (wiredHost === host) return;
    wiredHost = host;
    host.addEventListener("input", function (event) {
      if (event.target.dataset.settingsFilter === "equipment-search") {
        var where = event.target.selectionStart;
        equipment.search = event.target.value;
        render();
        var box = host.querySelector('[data-settings-filter="equipment-search"]');
        if (box) { box.focus(); try { box.setSelectionRange(where, where); } catch (_) {} }
        return;
      }
      var routingSearch = event.target.getAttribute("data-routing-search");
      if (routingSearch) {
        // Filters in place: re-rendering would steal the caret and close the checklist.
        equipment.routeSearch[routingSearch] = event.target.value;
        var needle = event.target.value.trim().toLowerCase();
        var picker = event.target.closest("[data-routing-picker]");
        Array.prototype.forEach.call(picker.querySelectorAll("[data-routing-option]"), function (item) {
          item.hidden = !item.classList.contains("is-lead") && !routeMatches(item.getAttribute("data-routing-option"), needle);
        });
        return;
      }
      if (event.target.hasAttribute("data-eqr-search")) {
        var term = event.target.value.trim().toLowerCase();
        Array.prototype.forEach.call(host.querySelectorAll("[data-eqr-pick]"), function (item) {
          item.hidden = !!term && item.getAttribute("data-eqr-pick").indexOf(term) === -1;
        });
        return;
      }
      if (event.target.dataset.settingsFilter !== "search") return;
      var position = event.target.selectionStart;
      filters.search = event.target.value;
      render();
      var input = host.querySelector('[data-settings-filter="search"]');
      if (input) {
        input.focus();
        input.setSelectionRange(position, position);
      }
    });
    host.addEventListener("change", function (event) {
      var pickedPlant = event.target.getAttribute("data-routing-plant");
      var pickedKey = event.target.getAttribute("data-routing-key");
      if (pickedPlant !== null || pickedKey !== null) {
        var current = equipment.routeDraft;
        selectIssueRouting(
          pickedPlant !== null ? toggleRoutePick(current.plants, pickedPlant, event.target.checked) : current.plants,
          pickedKey !== null ? toggleRoutePick(current.keys, pickedKey, event.target.checked) : current.keys,
          true);
        return;
      }
      var routingField = event.target.dataset.routingField;
      if (routingField) {
        var draft = equipment.routeDraft;
        draft[routingField] = routingField === "applyExisting" ? event.target.checked : event.target.value;
        if (routingField === "primary" || routingField === "backup") {
          draft.ownersTouched = true;
          renderRoutingDialog();
        }
        return;
      }
      if (event.target.hasAttribute("data-settings-retention-days")) retention.days = event.target.value;
      if (event.target.hasAttribute("data-settings-purge-days")) {
        retention.purgeDays = event.target.value;
        retention.preview = null;
        var stale = host.querySelector('[data-settings-action="purge-older"]');
        if (stale) stale.disabled = true;
        return;
      }
      var field = event.target.dataset.retentionField;
      if (field) {
        retention[field] = field === "automatic" ? event.target.checked : event.target.value;
        retention.preview = null;
        render();
        return;
      }
      if (event.target.dataset.settingsFilter === "role") {
        filters.role = event.target.value;
        render();
      } else if (event.target.matches("[data-settings-role]")) {
        updatePlantField(event.target.form);
      }
    });
    // "+N more" opens on hover and stays open while the pointer is inside that list (the revealed
    // items push the button away). Mouse only: a tap's synthetic hover would open then shut it.
    var coverHover = new Set();
    function setCover(list, open) {
      var rest = list.querySelector(":scope > .ep-cover__rest"), more = list.querySelector(":scope > .ep-cover__more");
      if (!open) { list.removeAttribute("data-cover-hover"); coverHover.delete(list); }
      if (!rest || !more) return;
      rest.hidden = !open;
      more.setAttribute("aria-expanded", String(open));
      more.textContent = open ? "Less" : "+" + more.getAttribute("data-cover-count") + " more";
    }
    host.addEventListener("pointerover", function (event) {
      if (event.pointerType !== "mouse") return;
      var more = event.target.closest("[data-cover-more]");
      if (!more || more.getAttribute("aria-expanded") === "true") return;
      var list = more.closest("[data-cover-list]");
      list.setAttribute("data-cover-hover", "");
      coverHover.add(list);
      setCover(list, true);
    });
    host.addEventListener("pointerout", function (event) {
      if (event.pointerType !== "mouse" || !coverHover.size) return;
      coverHover.forEach(function (list) {
        if (!event.relatedTarget || !list.contains(event.relatedTarget)) setCover(list, false);
      });
    });
    host.addEventListener("click", function (event) {
      // A checklist closes when anything outside it is clicked, including the other checklist.
      Array.prototype.forEach.call(host.querySelectorAll("[data-routing-picker][open]"), function (picker) {
        if (!picker.contains(event.target)) picker.open = false;
      });
      var coverMore = event.target.closest("[data-cover-more]");
      if (coverMore) {
        // A click is deliberate: it toggles and no longer closes when the pointer leaves.
        var coverListEl = coverMore.closest("[data-cover-list]");
        var opening = coverMore.getAttribute("aria-expanded") !== "true";
        setCover(coverListEl, false);
        if (opening) setCover(coverListEl, true);
        return;
      }
      var button = event.target.closest("[data-settings-action]");
      if (!button) return;
      var action = button.dataset.settingsAction;
      var person = users.find(function (item) { return item.id === button.dataset.userId; });
      if (action === "refresh") {
        statusMessage = "";
        loadUsers();
      } else if (action === "refresh-storage") {
        storageMessage = "";
        loadStorageUsage(true);
      } else if (action === "save-retention") {
        saveRetention(host);
      } else if (action === "preview-purge") {
        previewPurge(host);
      } else if (action === "purge-older") {
        purgeOlderThan();
      } else if (action === "purge-originals") {
        if (!retention.settings || storageLoading) return;
        retention.purgeDays = retention.settings.days;
        retention.purgeCategory = retention.settings.category || "";
        retention.purgePlantId = retention.settings.plant_id || "";
        retention.preview = null;
        render();
        previewPurge(host);
      } else if (action === "refresh-equipment") {
        equipment.message = "";
        loadEquipment(true);
        if (equipment.routeOpen) loadIssueRouting(true);
      } else if (action === "toggle-issue-routing" || action === "open-issue-routing") {
        openIssueRouting();
      } else if (action === "close-issue-routing") {
        closeIssueRouting();
      } else if (action === "view-portfolio-equipment") {
        closeIssueRouting();
        var portfolio = host.querySelector("#settings-equipment-title");
        if (portfolio) {
          portfolio.setAttribute("tabindex", "-1");
          portfolio.focus({preventScroll: true});
          portfolio.scrollIntoView({block: "start"});
        }
      } else if (action === "reload-issue-routing") {
        if (!equipment.loaded) loadEquipment(false);
        loadIssueRouting(true);
      } else if (action === "toggle-equipment-history") {
        equipment.historyOpen = !equipment.historyOpen;
        if (equipment.historyOpen) loadEquipmentHistory();
        else render();
      } else if (action === "save-issue-routing") {
        saveIssueRouting(false);
      } else if (action === "remove-issue-routing") {
        saveIssueRouting(true);
      } else if (action === "routing-select-all" || action === "routing-clear") {
        var which = button.dataset.picker, chosen = equipment.routeDraft;
        var term = equipment.routeSearch[which].trim().toLowerCase();
        var all = action === "routing-clear" ? [] : which === "plant"
          ? equipment.plants.filter(function (p) { return p.active && routeMatches(routePlantLabel(p.id), term); }).map(function (p) { return p.id; })
          : equipment.categories.filter(function (c) { return routeMatches(c.label, term); }).map(function (c) { return c.key; });
        selectIssueRouting(which === "plant" ? all : chosen.plants, which === "key" ? all : chosen.keys, true);
      } else if (action === "edit-issue-routing") {
        var identity = button.dataset.ruleKey.split(":");
        selectIssueRouting([identity[0]], [identity[1]]);
        var field = host.querySelector('[data-routing-picker="plant"] summary');
        if (field) field.focus();
      } else if (action === "save-equipment") {
        saveCategory(button.dataset.equipmentKey, host);
      } else if (action === "edit-equipment" && person) {
        // Plant rules are only fetched on this explicit open, and reused for a minute.
        var routesStale = !equipment.routeLoaded || Date.now() - (equipment.routeLoadedAt || 0) > 60000;
        Promise.all([loadEquipment(false), loadIssueRouting(routesStale)]).then(function () { openModal("equipment", person); });
      } else if (action === "edit-pm-responsibility" && person && person.active && person.role === "Assignee") {
        openModal("pm-responsibility", person);
      } else if (action === "invite") {
        openModal("invite");
      } else if (action === "edit-access" && person) {
        openModal("access", person);
      } else if (action === "edit-profile" && person) {
        openModal("profile", person);
      } else if (action === "close") {
        closeModal();
      } else if (action === "resend" && person) {
        button.disabled = true;
        api().request("/api/users/" + encodeURIComponent(person.id) + "/resend-invite", { method: "POST" })
          .then(function (result) {
            statusMessage = result.email_sent ? "Invitation resent to " + person.email + "." :
              (result.email_note || "The invitation could not be sent.");
            render();
          }).catch(function (error) {
            statusMessage = error.message || "Could not resend the invitation.";
            render();
          });
      } else if (action === "toggle-active" && person) {
        var nextActive = !person.active;
        if (!global.confirm((nextActive ? "Enable" : "Disable") + " login access for " +
            (person.name || person.email) + "?")) return;
        button.disabled = true;
        api().request("/api/users/" + encodeURIComponent(person.id) + "/active", {
          method: "PATCH",
          body: { is_active: nextActive }
        }).then(function () {
          statusMessage = nextActive ? "Login access enabled." : "Login access disabled.";
          return loadUsers();
        }).catch(function (error) {
          statusMessage = error.message || "Could not update login access.";
          render();
        });
      }
    });
    host.addEventListener("click", function (event) {
      var bulk = event.target.closest("[data-eqr-bulk]");
      if (!bulk) return;
      var value = bulk.getAttribute("data-eqr-bulk") === "primary" ? "primary" : "";
      Array.prototype.forEach.call(host.querySelectorAll("[data-eqr-pick]"), function (item) {
        if (item.hidden) return;
        var select = item.querySelector("select");
        if (select) select.value = value;
      });
    });
    host.addEventListener("submit", function (event) {
      var form = event.target;
      if (!form.matches("[data-settings-form]")) return;
      event.preventDefault();
      var submit = form.querySelector('[type="submit"]');
      if (submit.disabled) return;
      submit.disabled = true;
      var values = new FormData(form);
      var mode = form.dataset.mode;
      var request;
      if (mode === "invite") {
        var inviteRole = String(values.get("role") || "Viewer");
        var invitePlantSelect = form.querySelector("[data-settings-plants]");
        var invitePlants = inviteRole === "Site Engineer" && invitePlantSelect
          ? Array.from(invitePlantSelect.selectedOptions).map(function (option) { return option.value; })
          : [];
        request = api().request("/api/users/invite", {
          method: "POST",
          body: {
            name: String(values.get("name") || "").trim(),
            email: String(values.get("email") || "").trim(),
            role: inviteRole,
            plants: invitePlants
          }
        }).then(function (result) {
          statusMessage = result.email_sent
            ? "Invitation sent to " + result.email + "."
            : "Account saved for " + result.email + ". " + (result.email_note || "Invitation email was not sent.");
        });
      } else if (mode === "equipment") {
        var items = [];
        Array.prototype.forEach.call(form.querySelectorAll("[data-eqr-pick] select"), function (select) {
          if (!select.value) return;
          items.push({
            equipment_key: select.name.slice(4),
            position: select.value,
            active: true
          });
        });
        request = api().request("/api/equipment-responsibilities/user/" +
          encodeURIComponent(form.dataset.userId), { method: "PUT", body: { items: items } })
          .then(function (result) {
            statusMessage = "Equipment responsibility saved for every plant. " + (result.issues_auto_assigned || 0) + " existing open issues assigned.";
            equipment.message = "";
            return loadEquipment(true);
          });
      } else if (mode === "pm-responsibility") {
        var pmIds = values.getAll("pm_plants");
        var transfers = users.filter(function (u) { return u.id !== form.dataset.userId; }).reduce(function (n, u) {
          return n + (u.pm_plant_ids || []).filter(function (id) { return pmIds.indexOf(id) >= 0; }).length;
        }, 0);
        if (transfers && !global.confirm("Transfer PM responsibility for " + transfers + " plant(s) from their current Assignee(s)?")) {
          submit.disabled = false; return;
        }
        request = api().request("/api/users/" + encodeURIComponent(form.dataset.userId) + "/pm-responsibility", {
          method: "PUT", body: { plant_ids: pmIds }
        }).then(function () {
          statusMessage = "PM responsibility saved for " + pmIds.length + " plants.";
          if (global.Solar91PortalData && global.Solar91PortalData.invalidate) global.Solar91PortalData.invalidate(true);
          else document.dispatchEvent(new CustomEvent("portal:data-invalidated"));
          return api().plants(true).catch(function () {});
        });
      } else if (mode === "access") {
        var role = String(values.get("role") || "");
        var plantSelect = form.querySelector("[data-settings-plants]");
        var plantIds = role === "Site Engineer" && plantSelect
          ? Array.from(plantSelect.selectedOptions).map(function (option) { return option.value; })
          : [];
        request = api().request("/api/users/" + encodeURIComponent(form.dataset.userId) + "/access", {
          method: "PUT",
          body: { role: role, plant_ids: plantIds }
        }).then(function () {
          statusMessage = role === "Assignee"
            ? "Role saved. Equipment responsibility continues to control automatic assignment."
            : "Role and plant access saved.";
        });
      } else {
        var profile = {
          name: String(values.get("name") || "").trim(),
          expected_name: form.dataset.expectedName,
          expected_email: form.dataset.expectedEmail
        };
        if (!form.querySelector('[name="email"]').disabled) {
          profile.email = String(values.get("email") || "").trim();
        }
        request = api().request("/api/users/" + encodeURIComponent(form.dataset.userId) + "/profile", {
          method: "PATCH",
          body: profile
        }).then(function (result) {
          statusMessage = result.email_sent
            ? "Person details saved and invitation sent to " + result.email + "."
            : "Person details saved.";
        });
      }
      request.then(function () {
        closeModal();
        return loadUsers();
      }).catch(function (error) {
        submit.disabled = false;
        var errorEl = form.querySelector("[data-form-error]");
        if (!errorEl) {
          errorEl = document.createElement("p");
          errorEl.className = "ep-settings__form-error";
          errorEl.setAttribute("role", "alert");
          errorEl.setAttribute("data-form-error", "");
          form.insertBefore(errorEl, form.querySelector("footer"));
        }
        errorEl.textContent = error.message || "Could not save login access changes.";
      });
    });
    host.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && host.querySelector("[data-settings-modal]")) closeModal();
    });
  }

  function renderPage(host) {
    if (!host) throw new Error("Settings host element is missing.");
    if (activeHost && equipment.routeOpen) closeIssueRouting();
    activeHost = host;
    wire(host);
    statusMessage = "";
    equipment.routeOpen = false;
    loadUsers();
    loadStorageUsage(false);
    loadRetention();
    loadEquipment(true);
  }

  global.Solar91PortalSettings = { render: renderPage };
}(window));
