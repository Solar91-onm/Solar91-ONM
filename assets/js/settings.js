/**
 * UI-only settings preview for the standalone portal.
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
  var people = [
    { name: "Arun Demo", email: "arun.demo@example.com", role: "O&M Head", scope: "All plants · all equipment", note: "Full administration, all plants", status: "Demo", signedIn: true, isYou: true },
    { name: "Babita Demo", email: "babita.demo@example.com", role: "Assignee", scope: "Inverter · all plants", note: "O&M team — assigned equipment only", status: "Demo", signedIn: false },
    { name: "Dhaval Demo", email: "dhaval.demo@example.com", role: "Administration", scope: "All plants · all equipment", note: "Read-only portfolio view", status: "Demo", signedIn: false },
    { name: "Himanshu Demo", email: "himanshu.demo@example.com", role: "O&M Head", scope: "All plants · all equipment", note: "Full administration, all plants", status: "Demo", signedIn: false },
    { name: "Kush Demo", email: "kush.demo@example.com", role: "Assignee", scope: "Modules cleaning · selected plants", note: "Washing jobs for assigned plants", status: "Demo", signedIn: false },
    { name: "Neha Demo", email: "neha.demo@example.com", role: "Site Engineer", scope: "One assigned plant", note: "Site operations for assigned plant", status: "Demo", signedIn: true }
  ];
  var filters = { search: "", role: "all" };
  var statusMessage = "";
  var activeHost = null;
  var wiredHost = null;

  function escape(value) {
    return global.Solar91PortalFormat.escape(value);
  }

  function scopeDescription(person) {
    if (person.role === "O&M Head") return "Full administration, all plants";
    if (person.role === "Administration") return "Read-only portfolio view";
    if (person.role === "Site Engineer") return "Site operations for assigned plant";
    if (person.role === "Assignee") return "O&M team — assigned equipment only";
    return "Read-only access";
  }

  function scopeForRole(role) {
    if (role === "O&M Head" || role === "Administration") return "All plants · all equipment";
    if (role === "Site Engineer") return "One assigned plant";
    if (role === "Assignee") return "Inverter · all plants";
    return "Portfolio · read only";
  }

  function filteredPeople() {
    var term = filters.search.trim().toLowerCase();
    return people.filter(function (person) {
      if (filters.role !== "all" && person.role !== filters.role) return false;
      if (!term) return true;
      return (person.name + " " + person.email + " " + person.role).toLowerCase().indexOf(term) !== -1;
    });
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
          roleClasses[role] + '"><i></i>' + escape(role) + "</span>";
      }).join("") + "</div>";
  }

  function renderRow(person, index) {
    var initials = person.name.split(/\s+/).map(function (part) {
      return part.charAt(0);
    }).join("").slice(0, 2).toUpperCase();
    var scopeClass = roleClasses[person.role] || "viewer";
    return '<article class="ep-settings__person ep-settings__person--' + scopeClass + '" data-person-index="' + index + '">' +
      '<div class="ep-settings__person-cell">' +
        '<span class="ep-settings__avatar" aria-hidden="true">' + escape(initials) + '</span>' +
        '<div class="ep-settings__identity"><strong>' + escape(person.name) +
          (person.isYou ? ' <span class="ep-settings__you">You</span>' : "") +
          (!person.signedIn ? ' <span class="ep-settings__not-signed">Demo invite</span>' : "") +
          '</strong><span>' + escape(person.email) + '</span>' +
          '<button type="button" class="ep-settings__edit-link" data-settings-action="edit" data-index="' + index + '">Edit details</button>' +
        '</div>' +
      '</div>' +
      '<div class="ep-settings__role-cell"><label class="ep-settings__sr-only" for="settings-role-' + index + '">Role for ' + escape(person.name) + '</label>' +
        '<select id="settings-role-' + index + '" class="ep-settings__role-select ep-settings__role-select--' + scopeClass + '" data-settings-action="role" data-index="' + index + '">' +
          renderRoleOptions(person.role) +
        '</select><span>' + escape(scopeDescription(person)) + '</span>' +
      '</div>' +
      '<div class="ep-settings__scope ep-settings__scope--' + scopeClass + '">' +
        '<strong>' + escape(person.scope) + '</strong><span>' + escape(person.note) + '</span>' +
      '</div>' +
      '<div class="ep-settings__access-cell">' +
        '<button type="button" class="ep-settings__remove' + (person.removed ? " is-removed" : "") +
          '" data-settings-action="toggle-access" data-index="' + index + '">' +
          (person.removed ? "Restore access (demo)" : "Remove access") + "</button>" +
      '</div>' +
      '<div class="ep-settings__status"><span class="ep-settings__status-pill' +
        (person.removed ? " is-removed" : "") + '"><i></i>' +
        (person.removed ? "Removed (demo)" : person.status) + "</span></div>" +
    "</article>";
  }

  function render() {
    if (!activeHost) return;
    var list = filteredPeople();
    activeHost.innerHTML = '<div class="ep-settings">' +
      '<header class="ep-settings__page-head"><div><h1>Settings</h1>' +
        '<p>Manage team access, operational roles, issue workflow and notification rules.</p></div>' +
        '<span class="ep-settings__access-badge"><i></i>Access controls</span></header>' +
      '<section class="ep-settings__panel" aria-labelledby="settings-team-title">' +
        '<div class="ep-settings__panel-intro"><h2 id="settings-team-title">Team &amp; access</h2>' +
          '<p>New people can be invited and assigned a role. Assignees are scoped to their assigned plants; Site Engineers are limited to exactly one plant. Role and access changes shown here are for demo preview only and are not saved or applied.</p></div>' +
        renderRoleChips() +
        '<div class="ep-settings__toolbar">' +
          '<label class="ep-settings__sr-only" for="settings-search">Search name or email</label>' +
          '<input id="settings-search" type="search" placeholder="Search name or email" value="' + escape(filters.search) + '" data-settings-filter="search" />' +
          '<label class="ep-settings__sr-only" for="settings-role-filter">Filter by role</label>' +
          '<select id="settings-role-filter" data-settings-filter="role"><option value="all"' + (filters.role === "all" ? " selected" : "") + '>All people (' + people.length + ')</option>' +
            renderRoleOptions(filters.role === "all" ? "" : filters.role) + '</select>' +
          '<button type="button" class="ep-settings__button" data-settings-action="refresh">Refresh</button>' +
          '<button type="button" class="ep-settings__button ep-settings__button--primary" data-settings-action="add">+ Add person</button>' +
          '<button type="button" class="ep-settings__button" data-settings-action="import">Import from Excel</button>' +
        '</div>' +
        (statusMessage ? '<p class="ep-settings__message" role="status">' + escape(statusMessage) + '</p>' : "") +
        '<div class="ep-settings__table" role="table" aria-label="Demo team access">' +
          '<div class="ep-settings__table-head" role="row">' +
            '<span role="columnheader">Person</span><span role="columnheader">Role</span>' +
            '<span role="columnheader">Scope · Equipment type / plant</span>' +
            '<span role="columnheader">Access</span><span role="columnheader">Status</span>' +
          '</div>' +
          (list.length
            ? list.map(function (person) { return renderRow(person, people.indexOf(person)); }).join("")
            : '<p class="ep-settings__empty">No demo people match this search.</p>') +
        '</div>' +
        '<p class="ep-settings__footnote">Demo preview only. No invitations, permissions or database settings are changed.</p>' +
      '</section>' +
      (activeHost.querySelector("[data-settings-modal]") ? activeHost.querySelector("[data-settings-modal]").outerHTML : "") +
    "</div>";
  }

  function modalHTML() {
    return '<div class="ep-settings__modal" data-settings-modal>' +
      '<button class="ep-settings__backdrop" type="button" data-settings-action="close" aria-label="Close dialog"></button>' +
      '<section class="ep-settings__dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">' +
        '<header><div><p>Demo preview</p><h2 id="settings-dialog-title">Add a person</h2></div>' +
          '<button type="button" class="ep-settings__icon-close" data-settings-action="close" aria-label="Close">×</button></header>' +
        '<form data-settings-form>' +
          '<label>Name<input name="name" required autocomplete="name" /></label>' +
          '<label>Email<input name="email" type="email" required autocomplete="email" /></label>' +
          '<label>Role<select name="role">' + renderRoleOptions("Viewer") + '</select></label>' +
          '<p>Adding a person here only changes this temporary demo preview.</p>' +
          '<footer><button type="button" class="ep-settings__button" data-settings-action="close">Cancel</button>' +
            '<button type="submit" class="ep-settings__button ep-settings__button--primary">Add demo person</button></footer>' +
        '</form>' +
      '</section>' +
    '</div>';
  }

  function closeModal() {
    if (!activeHost) return;
    var modal = activeHost.querySelector("[data-settings-modal]");
    if (modal) modal.remove();
  }

  function wire(host) {
    if (wiredHost === host) return;
    wiredHost = host;
    host.addEventListener("input", function (event) {
      if (event.target.dataset.settingsFilter === "search") {
        var position = event.target.selectionStart;
        filters.search = event.target.value;
        render();
        var input = host.querySelector('[data-settings-filter="search"]');
        if (input) {
          input.focus();
          input.setSelectionRange(position, position);
        }
      }
    });
    host.addEventListener("change", function (event) {
      var index = Number(event.target.dataset.index);
      if (event.target.dataset.settingsFilter === "role") {
        filters.role = event.target.value;
        statusMessage = "Role filter updated. Demo access has not been changed.";
        render();
      } else if (event.target.dataset.settingsAction === "role" && people[index]) {
        people[index].role = event.target.value;
        people[index].scope = scopeForRole(event.target.value);
        people[index].note = scopeDescription(people[index]);
        people[index].status = "Unsaved demo";
        statusMessage = "Role updated in this demo preview only.";
        render();
      }
    });
    host.addEventListener("click", function (event) {
      var button = event.target.closest("[data-settings-action]");
      if (!button) return;
      var action = button.dataset.settingsAction;
      var index = Number(button.dataset.index);
      if (action === "refresh") {
        filters.search = "";
        filters.role = "all";
        statusMessage = "Demo list refreshed. No backend request was made.";
        render();
      } else if (action === "add") {
        var wrapper = document.createElement("div");
        wrapper.innerHTML = modalHTML();
        activeHost.appendChild(wrapper.firstElementChild);
        activeHost.querySelector('[name="name"]').focus();
      } else if (action === "close") {
        closeModal();
      } else if (action === "import") {
        statusMessage = "Excel import will be connected after database setup.";
        render();
      } else if (action === "toggle-access" && people[index]) {
        people[index].removed = !people[index].removed;
        people[index].status = people[index].removed ? "Removed (demo)" : "Unsaved demo";
        statusMessage = "Demo access status changed locally only.";
        render();
      } else if (action === "edit" && people[index]) {
        statusMessage = "Editing " + people[index].name + " is not connected in this demo.";
        render();
      }
    });
    host.addEventListener("submit", function (event) {
      if (!event.target.matches("[data-settings-form]")) return;
      event.preventDefault();
      var values = new FormData(event.target);
      var name = String(values.get("name") || "").trim();
      var email = String(values.get("email") || "").trim();
      var role = String(values.get("role") || "Viewer");
      if (!name || !email || ROLES.indexOf(role) === -1) return;
      people.unshift({
        name: name,
        email: email,
        role: role,
        scope: scopeForRole(role),
        note: scopeDescription({ role: role }),
        status: "Unsaved demo",
        signedIn: false
      });
      filters.search = "";
      filters.role = "all";
      statusMessage = "Demo person added to this page only. Nothing was saved or invited.";
      closeModal();
      render();
    });
    host.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && host.querySelector("[data-settings-modal]")) closeModal();
    });
  }

  function renderPage(host) {
    if (!host) throw new Error("Settings host element is missing.");
    activeHost = host;
    wire(host);
    render();
    // The category list is live and persisted, unlike the team preview above.
    var categories = host.querySelector("[data-categories-host]");
    if (!categories) {
      categories = document.createElement("div");
      categories.setAttribute("data-categories-host", "");
      (host.querySelector(".ep-settings") || host).appendChild(categories);
    }
    if (global.Solar91PortalCategories) global.Solar91PortalCategories.render(categories);
  }

  global.Solar91PortalSettings = { render: renderPage };
}(window));
