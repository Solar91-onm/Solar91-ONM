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
    var assigned = (person.plants || []).map(function (plant) {
      return plant.site_code + " · " + plant.plant_name;
    });
    return assigned.length ? assigned.join(", ") : "No plants assigned";
  }

  function plantScopeSummary(person) {
    if (person.role === "O&M Head" || person.role === "Administration") return "All plants";
    if (person.role === "Viewer") return "No operational access";
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
      'data-settings-action="edit-access" data-user-id="' + escape(person.id) + '">Access &amp; scope</button>' +
      '<button type="button" class="ep-settings__button ep-settings__button--small" ' +
      'data-settings-action="edit-profile" data-user-id="' + escape(person.id) + '">Edit details</button>';
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

  function render() {
    if (!activeHost) return;
    var canManage = api().can("users.manage");
    var list = filteredUsers();
    activeHost.innerHTML = '<div class="ep-settings">' +
      '<header class="ep-settings__page-head"><div><h1>Login access</h1>' +
        '<p>Manage Clerk sign-in invitations, account status, roles and plant assignments.</p></div>' +
        '<span class="ep-settings__access-badge"><i></i>Clerk sign-in</span></header>' +
      '<section class="ep-settings__panel" aria-labelledby="settings-team-title">' +
        '<div class="ep-settings__panel-intro"><h2 id="settings-team-title">Team &amp; access</h2>' +
          '<p>Names and login details are loaded from the authenticated Solar91 user directory. Role and plant changes are saved to the database. Assignees need one or more plants; Site Engineers need exactly one.</p></div>' +
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
      (activeHost.querySelector("[data-settings-modal]") ? activeHost.querySelector("[data-settings-modal]").outerHTML : "") +
    "</div>";
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

  function modalHTML(mode, person, plantList) {
    var isProfile = mode === "profile";
    var role = person ? person.role : "Viewer";
    var selectedIds = person ? (person.plants || []).map(function (plant) { return String(plant.plant_id); }) : [];
    var selectedCodes = person ? (person.plants || []).map(function (plant) { return String(plant.site_code); }) : [];
    var selectedWashingIds = person ? (person.washing_plant_ids || []).map(String) : [];
    var title = mode === "invite" ? "Invite a person" : (isProfile ? "Edit person details" : "Change role and plant scope");
    var plantsRequired = role === "Assignee" || role === "Site Engineer";
    var fields;
    if (isProfile) {
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
          role === "Assignee" ? "Select one or more plants." : "Portfolio roles have access to all plants.") + '</p>' +
        '<label class="ep-settings__plant-field' + (role === "Assignee" ? "" : " is-hidden") + '" data-washing-field>' +
          'Equipment scope · Module Cleaning<select name="washing_plants" multiple size="5" data-settings-washing-plants>' +
          selectedPlantOptions(plantList, selectedWashingIds, false) + '</select></label>' +
        '<p class="ep-settings__washing-help' + (role === "Assignee" ? "" : " is-hidden") +
          '" data-washing-help>Assign Module Cleaning responsibility for plants with Module Cleaning set up. Selected plants are also included in the person’s plant access.</p>';
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
    var needsPlants = role === "Assignee" || role === "Site Engineer";
    var washingField = form.querySelector("[data-washing-field]");
    var washingHelp = form.querySelector("[data-washing-help]");
    plantField.classList.toggle("is-hidden", !needsPlants);
    plantSelect.required = needsPlants;
    if (washingField) washingField.classList.toggle("is-hidden", role !== "Assignee");
    if (washingHelp) washingHelp.classList.toggle("is-hidden", role !== "Assignee");
    if (help) {
      help.textContent = role === "Site Engineer" ? "Select exactly one plant." :
        role === "Assignee" ? "Select one or more plants." : "Portfolio roles have access to all plants.";
    }
  }

  function wire(host) {
    if (wiredHost === host) return;
    wiredHost = host;
    host.addEventListener("input", function (event) {
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
        var invitePlants = Array.from(form.querySelector("[data-settings-plants]").selectedOptions)
          .map(function (option) { return option.value; });
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
      } else if (mode === "access") {
        var role = String(values.get("role") || "");
        var plantSelect = form.querySelector("[data-settings-plants]");
        var plantIds = role === "Assignee" || role === "Site Engineer"
          ? Array.from(plantSelect.selectedOptions).map(function (option) { return option.value; })
          : [];
        var washingSelect = form.querySelector("[data-settings-washing-plants]");
        var washingPlantIds = role === "Assignee" && washingSelect
          ? Array.from(washingSelect.selectedOptions).map(function (option) { return option.value; })
          : [];
        request = api().request("/api/users/" + encodeURIComponent(form.dataset.userId) + "/access", {
          method: "PUT",
          body: { role: role, plant_ids: plantIds, washing_plant_ids: washingPlantIds }
        }).then(function () {
          statusMessage = "Role, plant access, and Module Cleaning scope saved.";
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
  }

  global.Solar91PortalSettings = { render: renderPage };
}(window));
