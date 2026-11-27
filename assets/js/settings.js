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
  var retention = { loaded: false, saving: false, days: null, settings: null, purgeDays: null, preview: null };
  // Equipment responsibility: who answers for one equipment category on every plant.
  // The matrix below and a person's own dialog write the same rows through the same API.
  var equipment = {
    loading: false, loaded: false, error: "", message: "",
    categories: [], holders: [], byUser: {}, search: "", saving: "",
    history: [], historyOpen: false, historyLoading: false
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
          (storageLoading ? " disabled" : "") + '>Run retention sweep</button></div></header>' +
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
          '<span>Older originals are deleted automatically each day. Thumbnails and photo records stay.</span></label>' +
        '<div class="ep-settings__retention-controls">' +
          '<input id="settings-retention-days" type="number" inputmode="numeric" min="' + info.min_days +
            '" max="' + info.max_days + '" step="1" value="' + escape(days) + '" data-settings-retention-days />' +
          '<span class="ep-settings__retention-unit">days</span>' +
          '<button type="button" class="ep-settings__button ep-settings__button--primary"' +
            (retention.saving ? " disabled" : "") + ' data-settings-action="save-retention">' +
            (retention.saving ? "Saving…" : "Save window") + "</button>" +
        "</div>" +
      "</div>" +
      '<p class="ep-settings__retention-note">In force: <strong>' + escape(info.days) + ' days</strong> · ' +
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
    var list = filteredUsers();
    activeHost.innerHTML = '<div class="ep-settings">' +
      '<header class="ep-settings__page-head"><div><h1>Login access</h1>' +
        '<p>Manage Clerk sign-in invitations, account status, roles, and equipment responsibility.</p></div>' +
        '<span class="ep-settings__access-badge"><i></i>Clerk sign-in</span></header>' +
      '<section class="ep-settings__panel" aria-labelledby="settings-team-title">' +
        '<div class="ep-settings__panel-intro"><h2 id="settings-team-title">Team &amp; access</h2>' +
          '<p>Assignees and O&amp;M Heads can work across all plants and equipment. Equipment responsibility routes work automatically; Site Engineers remain assigned to one plant.</p></div>' +
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
      (activeHost.querySelector("[data-settings-modal]") ? activeHost.querySelector("[data-settings-modal]").outerHTML : "") +
    "</div>";
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
      if (retention.days == null) retention.days = info.days;
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
    if (!Number.isFinite(days) || days < info.min_days || days > info.max_days) {
      storageError = "Keep originals for " + info.min_days + "-" + info.max_days + " days.";
      render();
      return;
    }
    retention.saving = true;
    storageError = "";
    storageMessage = "";
    render();
    api().request("/api/photos/retention", { method: "PUT", body: { days: days } })
      .then(function (saved) {
        retention.saving = false;
        retention.settings = saved;
        retention.days = saved.days;
        retention.preview = null;
        storageMessage = "Originals are now kept for " + saved.days + " days. Nothing was deleted by this change.";
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
    if (!Number.isFinite(days) || days < info.min_purge_days || days > info.max_days) {
      storageError = "Choose between " + info.min_purge_days + " and " + info.max_days + " days.";
      render();
      return;
    }
    retention.purgeDays = days;
    storageLoading = true;
    storageError = "";
    storageMessage = "";
    render();
    api().request("/api/photos/retention/purge", {
      method: "POST", body: { older_than_days: days, dry_run: true }
    }).then(function (result) {
      storageLoading = false;
      retention.preview = result;
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
    if (!preview || !preview.photos || days == null) return;
    if (!global.confirm("Delete " + preview.photos + " full-size original(s) older than " + days +
        " days? Thumbnails and photo records are kept, and this cannot be undone.")) return;
    storageLoading = true;
    storageError = "";
    storageMessage = "";
    retention.preview = null;
    render();
    api().request("/api/photos/retention/purge", { method: "POST", body: { older_than_days: days } })
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
          escape(holder.name || "Unnamed") + " · " + escape(holder.role) + "</option>";
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

  function renderEquipmentPanel(canManage) {
    if (!canManage) return "";
    var rows = equipment.categories.filter(matchesCategorySearch);
    var configured = equipment.categories.filter(function (c) { return !!c.primary; }).length;
    return '<section class="ep-settings__panel ep-eqr" aria-labelledby="settings-equipment-title">' +
      '<div class="ep-settings__panel-intro"><h2 id="settings-equipment-title">Equipment responsibility</h2>' +
        '<p>Who answers for one equipment category across every plant. A new site issue for that ' +
        'equipment is assigned to its primary Assignee automatically, wherever the plant is. Saving a primary also assigns matching open, unassigned issues; existing owners are preserved. The ' +
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
      '<p class="ep-settings__footnote">Responsibility is portfolio-wide: management does not assign plants ' +
        'one by one for it. A category with nobody configured leaves new tickets unassigned and notifies the ' +
        'O&amp;M Head — a ticket is never discarded.</p>' +
    "</section>";
  }

  function loadEquipment(force) {
    if (!api().can("users.manage")) return Promise.resolve();
    if (equipment.loading) return Promise.resolve();
    if (equipment.loaded && !force) return Promise.resolve();
    equipment.loading = true;
    equipment.error = "";
    render();
    return api().request("/api/equipment-responsibilities").then(function (body) {
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
    var rows = equipment.categories.map(function (category) {
      var entry = (category.entries || []).find(function (item) { return item.user_id === person.id; });
      var value = entry && entry.active ? entry.position : "";
      return '<li class="ep-eqr__pick" data-eqr-pick="' + escape(category.label.toLowerCase()) + '">' +
        "<span><strong>" + escape(category.label) + "</strong><small>" +
          escape(category.area || "Plant side") +
          (category.primary && category.primary.user_id !== person.id
            ? " · primary: " + escape(category.primary.user_name || "") : "") + "</small></span>" +
        '<select name="eqr:' + escape(category.key) + '" aria-label="' + escape(category.label) + '">' +
          '<option value=""' + (value ? "" : " selected") + ">None</option>" +
          '<option value="primary"' + (value === "primary" ? " selected" : "") + ">Primary</option>" +
          '<option value="backup"' + (value === "backup" ? " selected" : "") + ">Backup</option>" +
        "</select></li>";
    }).join("");
    return '<p class="ep-eqr__modal-intro">' + escape(person.name || person.email) +
        " answers for the equipment selected here on <strong>every plant</strong>. This routes new tickets" +
        " and notifications; it grants no approval or override authority, and currently holds " + mine.length +
        " categor" + (mine.length === 1 ? "y" : "ies") + ".</p>" +
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
      : (isProfile ? "Edit person details" : "Change role");
    var plantsRequired = role === "Site Engineer";
    var fields;
    if (mode === "equipment") {
      fields = equipmentModalHTML(person);
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
    var plantsPromise = mode === "profile" ? Promise.resolve([]) : api().plants();
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
      if (event.target.dataset.settingsFilter === "role") {
        filters.role = event.target.value;
        render();
      } else if (event.target.matches("[data-settings-role]")) {
        updatePlantField(event.target.form);
      }
    });
    host.addEventListener("click", function (event) {
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
        var window_days = retention.settings ? retention.settings.days : null;
        if (!global.confirm("Delete full-size originals older than " +
            (window_days ? window_days + " days" : "the retention window") +
            "? Thumbnails and photo records are kept, and this cannot be undone.")) return;
        storageLoading = true;
        storageError = "";
        storageMessage = "";
        render();
        api().request("/api/photos/retention/purge", { method: "POST" }).then(function (result) {
          storageMessage = "Purged " + Number(result.photos || 0) + " original(s); " +
            formatBytes(result.bytes_reclaimed) + " reclaimed.";
          return loadStorageUsage(true);
        }).catch(function (error) {
          storageLoading = false;
          storageError = error.message || "The retention sweep failed.";
          render();
        });
      } else if (action === "refresh-equipment") {
        equipment.message = "";
        loadEquipment(true);
      } else if (action === "toggle-equipment-history") {
        equipment.historyOpen = !equipment.historyOpen;
        if (equipment.historyOpen) loadEquipmentHistory();
        else render();
      } else if (action === "save-equipment") {
        saveCategory(button.dataset.equipmentKey, host);
      } else if (action === "edit-equipment" && person) {
        loadEquipment(false).then(function () { openModal("equipment", person); });
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
    activeHost = host;
    wire(host);
    statusMessage = "";
    loadUsers();
    loadStorageUsage(false);
    loadRetention();
    loadEquipment(true);
  }

  global.Solar91PortalSettings = { render: renderPage };
}(window));
