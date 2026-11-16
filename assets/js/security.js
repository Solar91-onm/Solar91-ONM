/**
 * Security register: site engineers and guards are stored with their plant.
 * The server scopes plants, redacts contact details by role, and enforces writes.
 */
(function (global) {
  "use strict";

  var api = global.Solar91PortalAPI;
  var fmt = global.Solar91PortalFormat;
  var plants = [];
  var editing = false;
  var drafts = null;
  var dirty = Object.create(null);
  var saving = false;
  var notice = "";
  var noticeIsError = false;
  var registerSearch = "";
  var registerSort = { column: 0, direction: "ascending" };
  var sortableRegisterColumns = [0, 1, 3, 4, 6];
  var filterText = "";
  var filterSiteCode = "";
  var wiredContainer = null;

  function canEdit() {
    return !!(api && api.can("plants.manage"));
  }

  function blankContact() {
    return { name: "", mobile: "", shift: "day" };
  }

  function normalizeContacts(rows) {
    return Array.isArray(rows) ? rows.map(function (row) {
      row = row && typeof row === "object" ? row : {};
      return {
        name: typeof row.name === "string" ? row.name : "",
        mobile: typeof row.mobile_no === "string" ? row.mobile_no : "",
        shift: row.shift === "night" ? "night" : "day"
      };
    }) : [];
  }

  function contactsFor(plant) {
    var fields = plant.customFields || {};
    var contacts = fields.security_contacts;
    if (contacts && typeof contacts === "object") {
      return {
        engineers: normalizeContacts(contacts.site_engineers),
        guards: normalizeContacts(contacts.guards)
      };
    }
    var guard = fields.security_guard;
    return {
      engineers: [],
      guards: guard && typeof guard === "object" &&
        (guard.guard_name || guard.mobile_no)
        ? [{
          name: typeof guard.guard_name === "string" ? guard.guard_name : "",
          mobile: typeof guard.mobile_no === "string" ? guard.mobile_no : "",
          shift: "day"
        }]
        : []
    };
  }

  function copyContacts(contacts) {
    return {
      engineers: contacts.engineers.map(function (contact) {
        return { name: contact.name, mobile: contact.mobile, shift: contact.shift };
      }),
      guards: contacts.guards.map(function (contact) {
        return { name: contact.name, mobile: contact.mobile, shift: contact.shift };
      })
    };
  }

  function contactCell(contacts, kind, field, editingRow, siteCode) {
    if (!contacts.length) return '<span class="ep-pt__dash">—</span>';
    return '<div class="ep-security__stack">' + contacts.map(function (contact, index) {
      if (editingRow && field === "name") {
        return '<div class="ep-security__name-entry">' +
          '<input class="ep-security__input" type="text" maxlength="160" autocomplete="off" data-security-contact-name="' +
          kind + '" data-security-index="' + index + '" value="' + fmt.escape(contact.name) +
          '" aria-label="' + (kind === "engineer" ? "Site engineer" : "Guard") + " name " +
          (index + 1) + " for " + fmt.escape(siteCode) + '"' +
          (saving ? " disabled" : "") + '><button class="ep-security__remove" type="button" data-security-remove="' +
          kind + '" data-security-index="' + index + '" data-security-site="' + fmt.escape(siteCode) +
          '" aria-label="Remove ' + (kind === "engineer" ? "site engineer " : "guard ") +
          (index + 1) + " for " + fmt.escape(siteCode) + '"' +
          (saving ? " disabled" : "") + '>×</button></div>';
      }
      if (editingRow && field === "mobile") {
        return '<input class="ep-security__input ep-security__input--mobile" type="tel" inputmode="numeric" maxlength="10" autocomplete="off" data-security-contact-mobile="' +
          kind + '" data-security-index="' + index + '" value="' + fmt.escape(contact.mobile) +
          '" aria-label="' + (kind === "engineer" ? "Site engineer" : "Guard") + " mobile number " +
          (index + 1) + " for " + fmt.escape(siteCode) + '"' +
          (saving ? " disabled" : "") + ">";
      }
      if (editingRow && field === "shift") {
        return '<select class="ep-security__shift" data-security-contact-shift="' + kind +
          '" data-security-index="' + index + '" aria-label="' +
          (kind === "engineer" ? "Site engineer" : "Guard") + " duty shift " +
          (index + 1) + " for " + fmt.escape(siteCode) + '"' + (saving ? " disabled" : "") + ">" +
          '<option value="day"' + (contact.shift === "day" ? " selected" : "") +
          ">Day</option><option value=\"night\"" + (contact.shift === "night" ? " selected" : "") +
          ">Night</option></select>";
      }
      if (field === "shift") {
        return '<span class="ep-security__shift-label is-' + contact.shift + '">' +
          (contact.shift === "night" ? "Night" : "Day") + "</span>";
      }
      return '<div class="ep-security__entry">' +
        (contact[field] ? fmt.escape(contact[field]) : '<span class="ep-pt__dash">—</span>') +
        "</div>";
    }).join("") + "</div>";
  }

  function siteFilterText(plant, contacts) {
    return [
      plant.siteCode, plant.displayName || plant.plantName,
      contacts.engineers.map(function (contact) { return contact.name + " " + contact.mobile; }).join(" "),
      contacts.guards.map(function (contact) { return contact.name + " " + contact.mobile; }).join(" ")
    ].join(" ").toLowerCase();
  }

  function rowHTML(plant, editingRow) {
    var contacts = editingRow && drafts
      ? drafts[plant.siteCode]
      : contactsFor(plant);
    var filter = siteFilterText(plant, contacts);
    var siteControls = editingRow
      ? '<div class="ep-security__site-actions">' +
        '<button type="button" data-security-add="engineer" data-security-site="' +
        fmt.escape(plant.siteCode) + '"' + (saving ? " disabled" : "") +
        ' aria-label="Add site engineer for ' + fmt.escape(plant.siteCode) + '">+ Engineer</button>' +
        '<button type="button" data-security-add="guard" data-security-site="' +
        fmt.escape(plant.siteCode) + '"' + (saving ? " disabled" : "") +
        ' aria-label="Add guard for ' + fmt.escape(plant.siteCode) + '">+ Guard</button></div>'
      : "";
    var engineerNames = contacts.engineers.map(function (contact) { return contact.name; }).join(" ");
    var engineerShifts = contacts.engineers.map(function (contact) {
      return contact.shift === "night" ? "Night" : "Day";
    }).join(" ");
    var guardNames = contacts.guards.map(function (contact) { return contact.name; }).join(" ");
    var guardShifts = contacts.guards.map(function (contact) {
      return contact.shift === "night" ? "Night" : "Day";
    }).join(" ");
    return '<tr data-security-row="' + fmt.escape(plant.siteCode) +
      '" data-security-filter-base="' + fmt.escape((plant.siteCode + " " +
        (plant.displayName || plant.plantName)).toLowerCase()) +
      '" data-security-filter-text="' + fmt.escape(filter) + '">' +
      '<td class="ep-security__site-code" data-security-sort-value="' + fmt.escape(plant.siteCode) +
        '" data-label="Site Code"><span class="ep-pt__code">' +
        fmt.escape(plant.siteCode) + "</span>" + siteControls + "</td>" +
      '<td data-security-sort-value="' + fmt.escape(engineerNames) + '" data-label="Site Engineer">' +
        contactCell(contacts.engineers, "engineer", "name", editingRow, plant.siteCode) + "</td>" +
      '<td data-label="Site Engineer No.">' +
        contactCell(contacts.engineers, "engineer", "mobile", editingRow, plant.siteCode) + "</td>" +
      '<td data-security-sort-value="' + fmt.escape(engineerShifts) + '" data-label="Engineer Shift">' +
        contactCell(contacts.engineers, "engineer", "shift", editingRow, plant.siteCode) + "</td>" +
      '<td data-security-sort-value="' + fmt.escape(guardNames) + '" data-label="Security Name">' +
        contactCell(contacts.guards, "guard", "name", editingRow, plant.siteCode) + "</td>" +
      '<td data-label="Mobile No.">' +
        contactCell(contacts.guards, "guard", "mobile", editingRow, plant.siteCode) + "</td>" +
      '<td data-security-sort-value="' + fmt.escape(guardShifts) + '" data-label="Guard Shift">' +
        contactCell(contacts.guards, "guard", "shift", editingRow, plant.siteCode) + "</td>" +
      "</tr>";
  }

  function headerHTML(label, column, editingRows) {
    if (editingRows || sortableRegisterColumns.indexOf(column) === -1) return '<th scope="col">' + label + "</th>";
    var active = registerSort.column === column;
    var direction = active ? registerSort.direction : "none";
    var nextDirection = active && registerSort.direction === "ascending" ? "descending" : "ascending";
    return '<th scope="col" aria-sort="' + direction + '">' +
      '<button type="button" class="ep-security__sort" data-security-sort="' + column +
        '" aria-label="Sort by ' + label + " " + nextDirection + '">' +
        "<span>" + label + '</span><span class="ep-security__sort-indicator" aria-hidden="true"></span>' +
      "</button></th>";
  }

  function tableHTML(editingRows) {
    var headings = [
      "Site Code", "Site Engineer", "Site Engineer No.", "Engineer Shift",
      "Security Name", "Mobile No.", "Guard Shift"
    ];
    return '<div class="ep-pt__table-wrap"><div class="ep-pt__scroll ep-security__scroll" data-security-table="' +
      (editingRows ? "editor" : "register") + '" tabindex="0" role="region" aria-label="Site security contact table">' +
      '<table class="ep-pt__table ep-security__table"><thead><tr>' +
        headings.map(function (label, index) {
          return headerHTML(label, index, editingRows);
        }).join("") +
      "</tr></thead><tbody>" +
        (plants.length
          ? plants.map(function (plant) { return rowHTML(plant, editingRows); }).join("")
          : '<tr><td colspan="7" class="ep-pt__empty">No plants are available in your account scope.</td></tr>') +
      "</tbody></table></div></div>";
  }

  function editorHTML() {
    var siteOptions = '<option value="">All sites</option>' +
      plants.map(function (plant) {
        return '<option value="' + fmt.escape(plant.siteCode) + '"' +
          (filterSiteCode === plant.siteCode ? " selected" : "") + ">" +
          fmt.escape(plant.siteCode + " · " + (plant.displayName || plant.plantName)) + "</option>";
      }).join("");
    return '<div class="ep-security__overlay" data-security-overlay>' +
      '<section class="ep-security__modal" role="dialog" aria-modal="true" aria-labelledby="ep-security-editor-title">' +
        '<header class="ep-security__modal-head"><div><h2 id="ep-security-editor-title">Edit Security Register</h2>' +
          '<p>Manage multiple site engineers and guards, including each person’s duty shift.</p></div>' +
          '<button type="button" class="ep-security__close" data-security-close aria-label="Close editor"' +
          (saving ? " disabled" : "") + '>×</button></header>' +
        (notice ? '<div class="ep-security__notice' + (noticeIsError ? " is-error" : "") +
          '" role="' + (noticeIsError ? "alert" : "status") + '">' + fmt.escape(notice) + "</div>" : "") +
        '<div class="ep-security__filters"><label><span>Search contacts or site code</span>' +
          '<input type="search" data-security-search value="' + fmt.escape(filterText) +
          '" placeholder="Search..."' + (saving ? " disabled" : "") + '></label>' +
          '<label><span>Filter by site</span><select data-security-site-filter' +
          (saving ? " disabled" : "") + ">" + siteOptions + "</select></label></div>" +
        tableHTML(true) +
        '<footer class="ep-security__modal-foot">' +
          '<button type="button" class="ep-security__cancel" data-security-close' +
          (saving ? " disabled" : "") + '>Cancel</button>' +
          '<button type="button" class="ep-pt__edit ep-security__save" data-security-save' +
          (saving || !Object.keys(dirty).length ? " disabled" : "") + '>' +
          (saving ? "Saving..." : "Save changes") + "</button></footer>" +
      "</section></div>";
  }

  function applyEditorFilters(container) {
    var term = filterText.trim().toLowerCase();
    Array.prototype.forEach.call(container.querySelectorAll("[data-security-row]"), function (row) {
      var matchesText = !term || row.getAttribute("data-security-filter-text").indexOf(term) !== -1;
      var matchesSite = !filterSiteCode || row.getAttribute("data-security-row") === filterSiteCode;
      row.hidden = !(matchesText && matchesSite);
    });
  }

  function applyRegisterFilters(container) {
    var term = registerSearch.trim().toLowerCase();
    Array.prototype.forEach.call(
      container.querySelectorAll('[data-security-table="register"] [data-security-row]'),
      function (row) {
        row.hidden = !!term && row.getAttribute("data-security-filter-text").indexOf(term) === -1;
      }
    );
  }

  function applyRegisterSort(container) {
    var body = container.querySelector('[data-security-table="register"] tbody');
    if (!body) return;
    var rows = Array.prototype.slice.call(body.querySelectorAll("[data-security-row]"));
    rows.sort(function (a, b) {
      var left = (a.cells[registerSort.column].getAttribute("data-security-sort-value") || "").trim();
      var right = (b.cells[registerSort.column].getAttribute("data-security-sort-value") || "").trim();
      if (!left && right) return 1;
      if (left && !right) return -1;
      var result = left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
      return registerSort.direction === "ascending" ? result : -result;
    });
    rows.forEach(function (row) { body.appendChild(row); });
  }

  function updateRowFilterText(row) {
    var values = [row.getAttribute("data-security-filter-base") || ""];
    Array.prototype.forEach.call(row.querySelectorAll("[data-security-contact-name], [data-security-contact-mobile]"), function (input) {
      values.push(input.value);
    });
    row.setAttribute("data-security-filter-text", values.join(" ").toLowerCase());
  }

  function updateSaveButton(container) {
    var button = container.querySelector("[data-security-save]");
    if (button) button.disabled = saving || !Object.keys(dirty).length;
  }

  function render(container) {
    if (!container) return;
    var editable = canEdit();
    container.innerHTML = "" +
      '<div class="ep-pt">' +
        '<div class="ep-pt__head"><div><h1 class="ep-pt__title">Security</h1>' +
          '<p class="ep-pt__sub">' + plants.length + " plant" + (plants.length === 1 ? "" : "s") + "</p></div>" +
          (editable ? '<button type="button" class="ep-pt__edit ep-security__open" data-security-open-edit' +
            '>Edit register</button>' : "") +
        "</div>" +
        '<div class="ep-security__register-filter"><label><span>Search by plant code, site engineer, or security name</span>' +
          '<input type="search" data-security-register-search value="' + fmt.escape(registerSearch) +
          '" placeholder="Plant code, site engineer, security name..." autocomplete="off"></label></div>' +
        '<div class="ep-pt__card">' +
          (!editing && notice ? '<div class="ep-security__notice' + (noticeIsError ? " is-error" : "") +
            '" role="' + (noticeIsError ? "alert" : "status") + '">' + fmt.escape(notice) + "</div>" : "") +
          tableHTML(false) +
        "</div>" +
        (editing ? editorHTML() : "") +
      "</div>";
    applyRegisterFilters(container);
    applyRegisterSort(container);
    if (editing) applyEditorFilters(container);
    wire(container);
  }

  function readContactList(row, kind, current) {
    return current.map(function (contact, index) {
      var name = row.querySelector('[data-security-contact-name="' + kind + '"][data-security-index="' + index + '"]');
      var mobile = row.querySelector('[data-security-contact-mobile="' + kind + '"][data-security-index="' + index + '"]');
      var shift = row.querySelector('[data-security-contact-shift="' + kind + '"][data-security-index="' + index + '"]');
      return {
        name: name ? name.value.trim() : contact.name,
        mobile: mobile ? mobile.value.trim() : contact.mobile,
        shift: shift ? shift.value : contact.shift
      };
    });
  }

  function syncDrafts(container) {
    if (!drafts) return;
    Array.prototype.forEach.call(container.querySelectorAll("[data-security-row]"), function (row) {
      var siteCode = row.getAttribute("data-security-row");
      var draft = drafts[siteCode];
      if (!draft) return;
      draft.engineers = readContactList(row, "engineer", draft.engineers);
      draft.guards = readContactList(row, "guard", draft.guards);
    });
  }

  function checkedContacts(rows, label) {
    var checked = [];
    for (var index = 0; index < rows.length; index += 1) {
      var name = String(rows[index].name || "").trim();
      var mobile = String(rows[index].mobile || "").trim();
      var shift = rows[index].shift;
      if (!name && !mobile) continue;
      if (!name) return { error: label + " " + (index + 1) + " needs a name." };
      if (mobile && !/^\d{10}$/.test(mobile)) {
        return { error: label + " " + (index + 1) + " needs a 10-digit mobile number." };
      }
      if (shift !== "day" && shift !== "night") {
        return { error: label + " " + (index + 1) + " has an invalid duty shift." };
      }
      checked.push({ name: name, mobile_no: mobile, shift: shift });
    }
    return { contacts: checked };
  }

  function save(container) {
    syncDrafts(container);
    var changed = plants.filter(function (plant) { return !!dirty[plant.siteCode]; });
    if (!changed.length) return;

    var payloads = [];
    for (var index = 0; index < changed.length; index += 1) {
      var plant = changed[index];
      var draft = drafts[plant.siteCode];
      var engineers = checkedContacts(draft.engineers, "Site engineer");
      var guards = checkedContacts(draft.guards, "Guard");
      var error = engineers.error || guards.error;
      if (error) {
        notice = plant.siteCode + ": " + error;
        noticeIsError = true;
        render(container);
        return;
      }
      payloads.push({
        plant: plant,
        contacts: {
          site_engineers: engineers.contacts,
          guards: guards.contacts
        }
      });
    }

    var savedCodes = [];
    var savingSiteCode = "";
    saving = true;
    notice = "";
    noticeIsError = false;
    render(container);
    api.plants(true).then(function (latestPlants) {
      return payloads.reduce(function (request, payload) {
        return request.then(function () {
          savingSiteCode = payload.plant.siteCode;
          var latest = latestPlants.find(function (item) {
            return item.siteCode === savingSiteCode;
          });
          if (!latest) throw new Error("This site is no longer available.");
          var fields = Object.assign({}, latest.customFields || {});
          fields.security_contacts = payload.contacts;
          delete fields.security_guard;
          return api.request("/api/plants/" + encodeURIComponent(latest.dbId), {
            method: "PATCH",
            body: { custom_fields: fields }
          }).then(function () {
            savedCodes.push(savingSiteCode);
            delete dirty[savingSiteCode];
          });
        });
      }, Promise.resolve());
    }).then(function () {
      editing = false;
      drafts = null;
      dirty = Object.create(null);
      notice = "Security contacts saved.";
      noticeIsError = false;
      return api.plants(true).then(function (latestPlants) {
        plants = latestPlants.slice().sort(function (a, b) {
          return a.siteCode.localeCompare(b.siteCode);
        });
      }).catch(function (error) {
        notice = "Security contacts were saved, but the register could not refresh: " +
          ((error && error.message) || "please reload the page.");
        noticeIsError = true;
      });
    }).catch(function (error) {
      var detail = (error && error.message) || "please try again.";
      notice = "Security contacts could not be saved for " + (savingSiteCode || "the selected sites") +
        ": " + detail;
      if (savedCodes.length) {
        notice += " Changes were already saved for " + savedCodes.join(", ") + ".";
      }
      noticeIsError = true;
      return api.plants(true).then(function (latestPlants) {
        plants = latestPlants.slice().sort(function (a, b) {
          return a.siteCode.localeCompare(b.siteCode);
        });
      }).catch(function (refreshError) {
        notice += " The register could not refresh: " +
          ((refreshError && refreshError.message) || "please reload the page.");
      });
    }).then(function () {
      saving = false;
      render(container);
    });
  }

  function openEditor(container) {
    editing = true;
    drafts = Object.create(null);
    plants.forEach(function (plant) {
      drafts[plant.siteCode] = copyContacts(contactsFor(plant));
    });
    dirty = Object.create(null);
    filterText = "";
    filterSiteCode = "";
    notice = "";
    noticeIsError = false;
    render(container);
    var search = container.querySelector("[data-security-search]");
    if (search) search.focus();
  }

  function closeEditor(container) {
    if (saving) return;
    editing = false;
    drafts = null;
    dirty = Object.create(null);
    filterText = "";
    filterSiteCode = "";
    notice = "";
    noticeIsError = false;
    render(container);
    var button = container.querySelector("[data-security-open-edit]");
    if (button) button.focus();
  }

  function wire(container) {
    if (wiredContainer === container) return;
    wiredContainer = container;
    container.addEventListener("input", function (event) {
      if (event.target.matches("[data-security-register-search]")) {
        registerSearch = event.target.value;
        applyRegisterFilters(container);
        return;
      }
      if (event.target.matches("[data-security-search]")) {
        filterText = event.target.value;
        applyEditorFilters(container);
        return;
      }
      var field = event.target.closest("[data-security-contact-name], [data-security-contact-mobile]");
      if (field) {
        var row = field.closest("[data-security-row]");
        if (row) {
          dirty[row.getAttribute("data-security-row")] = true;
          updateRowFilterText(row);
          applyEditorFilters(container);
        }
        updateSaveButton(container);
      }
    });
    container.addEventListener("change", function (event) {
      if (event.target.matches("[data-security-site-filter]")) {
        filterSiteCode = event.target.value;
        applyEditorFilters(container);
        return;
      }
      var shift = event.target.closest("[data-security-contact-shift]");
      if (shift) {
        var row = shift.closest("[data-security-row]");
        if (row) dirty[row.getAttribute("data-security-row")] = true;
        updateSaveButton(container);
      }
    });
    container.addEventListener("click", function (event) {
      var sort = event.target.closest("[data-security-sort]");
      if (sort) {
        var column = Number(sort.getAttribute("data-security-sort"));
        if (registerSort.column === column) {
          registerSort.direction = registerSort.direction === "ascending" ? "descending" : "ascending";
        } else {
          registerSort = { column: column, direction: "ascending" };
        }
        render(container);
        return;
      }
      var open = event.target.closest("[data-security-open-edit]");
      if (open) {
        openEditor(container);
        return;
      }
      var close = event.target.closest("[data-security-close]");
      if (close) {
        closeEditor(container);
        return;
      }
      if (event.target.matches("[data-security-overlay]")) {
        closeEditor(container);
        return;
      }
      var add = event.target.closest("[data-security-add]");
      if (add && drafts) {
        syncDrafts(container);
        var addSite = add.getAttribute("data-security-site");
        var addKind = add.getAttribute("data-security-add");
        if (!drafts[addSite]) return;
        var addList = addKind === "engineer" ? drafts[addSite].engineers : drafts[addSite].guards;
        addList.push(blankContact());
        dirty[addSite] = true;
        render(container);
        var targetRow = Array.prototype.find.call(container.querySelectorAll("[data-security-row]"), function (row) {
          return row.getAttribute("data-security-row") === addSite;
        });
        var nameInput = targetRow && targetRow.querySelector('[data-security-contact-name="' +
          addKind + '"][data-security-index="' + (addList.length - 1) + '"]');
        if (nameInput) nameInput.focus();
        return;
      }
      var remove = event.target.closest("[data-security-remove]");
      if (remove && drafts) {
        syncDrafts(container);
        var removeSite = remove.getAttribute("data-security-site");
        var removeKind = remove.getAttribute("data-security-remove");
        if (!drafts[removeSite]) return;
        var removeList = removeKind === "engineer"
          ? drafts[removeSite].engineers : drafts[removeSite].guards;
        removeList.splice(Number(remove.getAttribute("data-security-index")), 1);
        dirty[removeSite] = true;
        render(container);
        return;
      }
      if (event.target.closest("[data-security-save]")) {
        save(container);
        return;
      }
      if (event.target.closest("[data-security-retry]")) show(container);
    });
    container.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && editing) closeEditor(container);
    });
  }

  function show(container) {
    if (!container) return;
    container.innerHTML = '<div class="ep-pt__loading">Loading security contacts…</div>';
    api.plants().then(function (rows) {
      plants = rows.slice().sort(function (a, b) {
        return a.siteCode.localeCompare(b.siteCode);
      });
      render(container);
    }).catch(function (error) {
      container.innerHTML = '<div class="ep-pt__error">Could not load security contacts. ' +
        fmt.escape((error && error.message) || "Please try again.") +
        ' <button type="button" data-security-retry>Try again</button></div>';
      wire(container);
    });
  }

  global.Solar91PortalSecurity = { show: show };
}(window));
