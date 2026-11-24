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
  var sortableRegisterColumns = [0, 1, 3, 5];
  var filterText = "";
  var filterSiteCode = "";
  var wiredContainer = null;
  // The person currently being moved: which plant they sit on, whether they are an engineer or a
  // guard, and their index in that plant's array. Null when no move is being set up.
  var moving = null;
  var movePending = false;

  function canEdit() {
    // Editing the register is gated the same as moving a person between plants: the O&M Head and
    // Assignees. The server enforces it too (the security-contacts write, not plants.manage), and
    // scopes an Assignee to their assigned plants.
    var user = api && api.currentUser ? api.currentUser() : null;
    var role = user && user.role;
    return role === "O&M Head" || role === "Assignee";
  }

  // Moving a person between plants is a two-plant write, gated the same way the Inverter Health
  // unit-config save is: the O&M Head and Assignees. Every other role reads the register.
  function canMove() {
    var user = api && api.currentUser ? api.currentUser() : null;
    var role = user && user.role;
    return role === "O&M Head" || role === "Assignee";
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

  /**
   * The person's position in the register as it is STORED, which is what the move endpoint indexes.
   * Returns null when this plant has no stored array of that kind -- a plant still carrying only the
   * legacy single `security_guard` entry, for instance. Such a person has no stored index to move,
   * so the control is not offered rather than sending an index the server would reject.
   */
  function storedContacts(siteCode, kind) {
    var plant = plants.find(function (item) { return item.siteCode === siteCode; });
    var fields = (plant && plant.customFields) || {};
    var contacts = fields.security_contacts;
    if (!contacts || typeof contacts !== "object") return null;
    var rows = kind === "engineer" ? contacts.site_engineers : contacts.guards;
    return Array.isArray(rows) ? rows : null;
  }

  function isMoving(siteCode, kind, index) {
    return !!moving && moving.siteCode === siteCode && moving.kind === kind && moving.index === index;
  }

  /**
   * The move control for one person: a "Move" button, and once chosen, the destination plant, a
   * confirm naming the person and both site codes, and a Cancel. No drag and drop: a drag over a
   * 42-row table is a mis-drop waiting to happen, and the confirm is what makes a mis-click obvious.
   */
  function canMovePerson(siteCode, kind, index) {
    // Only site engineers move between plants. Guards are posted to one site and change over on
    // their own cycle, so a Move control on a guard row is a mis-click waiting to happen; guards
    // are edited in place instead (see guardMode).
    if (kind !== "engineer" || !canMove()) return false;
    var stored = storedContacts(siteCode, kind);
    return !!stored && index < stored.length;
  }

  /**
   * Which kind the editor is currently editing. Site engineers are the day-to-day change, so the
   * register opens on them; guards change rarely (about monthly) and are opened deliberately with
   * the "Change guards" button, with their saved name, number and shift filled in ready to edit.
   */
  var guardMode = false;

  function editingKind(kind) {
    return guardMode ? kind === "guard" : kind === "engineer";
  }

  /** The "Move" control itself, beside the person's name. */
  function moveButton(contact, kind, index, siteCode) {
    if (!canMovePerson(siteCode, kind, index) || isMoving(siteCode, kind, index)) return "";
    var label = kind === "engineer" ? "site engineer" : "guard";
    // An unsaved edit on this plant would make the stored index and the row on screen disagree,
    // so the move waits until the edits are saved rather than moving the wrong person.
    if (dirty[siteCode]) {
      return '<span class="ep-security__move-blocked" title="Save this plant’s edits first">Save first</span>';
    }
    return '<button type="button" class="ep-security__move-open" data-security-move-start="' + kind +
      '" data-security-index="' + index + '" data-security-site="' + fmt.escape(siteCode) +
      '"' + (saving || movePending ? " disabled" : "") + ' aria-label="Move ' +
      (fmt.escape(contact.name) || label) + " to another plant" + '">Move</button>';
  }

  function movePanel(contact, kind, index, siteCode) {
    if (!canMovePerson(siteCode, kind, index) || !isMoving(siteCode, kind, index)) return "";
    var label = kind === "engineer" ? "site engineer" : "guard";
    var targetHasDrafts = !!(moving.target && dirty[moving.target]);
    var options = plants.filter(function (plant) {
      return plant.siteCode !== siteCode;
    }).map(function (plant) {
      return '<option value="' + fmt.escape(plant.siteCode) + '"' +
        (moving.target === plant.siteCode ? " selected" : "") + ">" +
        fmt.escape(plant.siteCode + " · " + (plant.displayName || plant.plantName)) + "</option>";
    }).join("");
    var target = moving.target || "";
    return '<div class="ep-security__move" data-security-move-panel>' +
      '<label><span class="ep-security__move-label">Move ' + (fmt.escape(contact.name) || label) +
        ' from ' + fmt.escape(siteCode) + ' to</span>' +
        '<select data-security-move-target' + (movePending ? " disabled" : "") + '>' +
        '<option value="">Select plant</option>' + options + "</select></label>" +
      '<p class="ep-security__move-confirm">' + (target
        ? targetHasDrafts
          ? "Save changes for " + fmt.escape(target) + " before moving a person there."
          : "Move <strong>" + (fmt.escape(contact.name) || label) + "</strong> from <strong>" +
            fmt.escape(siteCode) + "</strong> to <strong>" + fmt.escape(target) + "</strong>?"
        : "Choose the plant this " + label + " now works at.") + "</p>" +
      '<div class="ep-security__move-actions">' +
        '<button type="button" class="ep-security__move-confirm-btn" data-security-move-confirm' +
          (movePending || !target || targetHasDrafts ? " disabled" : "") + ">" +
          (movePending ? "Moving…" : "Move") + "</button>" +
        '<button type="button" class="ep-security__move-cancel" data-security-move-cancel' +
          (movePending ? " disabled" : "") + ">Cancel</button>" +
      "</div></div>";
  }

  function contactCell(contacts, kind, field, editingRow, siteCode) {
    if (!contacts.length) return '<span class="ep-pt__dash">—</span>';
    return '<div class="ep-security__stack">' + contacts.map(function (contact, index) {
      if (editingRow && canEdit() && editingKind(kind) && field === "name") {
        return '<div class="ep-security__name-entry">' +
          '<input class="ep-security__input" type="text" maxlength="160" autocomplete="off" data-security-contact-name="' +
          kind + '" data-security-index="' + index + '" value="' + fmt.escape(contact.name) +
          '" aria-label="' + (kind === "engineer" ? "Site engineer" : "Guard") + " name " +
          (index + 1) + " for " + fmt.escape(siteCode) + '"' +
          (saving ? " disabled" : "") + '><button class="ep-security__remove" type="button" data-security-remove="' +
          kind + '" data-security-index="' + index + '" data-security-site="' + fmt.escape(siteCode) +
          '" aria-label="Remove ' + (kind === "engineer" ? "site engineer " : "guard ") +
          (index + 1) + " for " + fmt.escape(siteCode) + '"' +
          (saving ? " disabled" : "") + '>×</button>' +
          moveButton(contact, kind, index, siteCode) + '</div>' +
          movePanel(contact, kind, index, siteCode);
      }
      if (editingRow && canEdit() && editingKind(kind) && field === "mobile") {
        return '<input class="ep-security__input ep-security__input--mobile" type="tel" inputmode="numeric" maxlength="10" autocomplete="off" data-security-contact-mobile="' +
          kind + '" data-security-index="' + index + '" value="' + fmt.escape(contact.mobile) +
          '" aria-label="' + (kind === "engineer" ? "Site engineer" : "Guard") + " mobile number " +
          (index + 1) + " for " + fmt.escape(siteCode) + '"' +
          (saving ? " disabled" : "") + ">";
      }
      if (editingRow && canEdit() && editingKind(kind) && field === "shift") {
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
        (editingRow && field === "name"
          ? moveButton(contact, kind, index, siteCode) + movePanel(contact, kind, index, siteCode)
          : "") +
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
    // Only the kind being edited can be added to, so the row offers one button, not two.
    var siteControls = editingRow && canEdit()
      ? '<div class="ep-security__site-actions">' +
        (guardMode
          ? '<button type="button" data-security-add="guard" data-security-site="' +
            fmt.escape(plant.siteCode) + '"' + (saving ? " disabled" : "") +
            ' aria-label="Add guard for ' + fmt.escape(plant.siteCode) + '">+ Guard</button>'
          : '<button type="button" data-security-add="engineer" data-security-site="' +
            fmt.escape(plant.siteCode) + '"' + (saving ? " disabled" : "") +
            ' aria-label="Add site engineer for ' + fmt.escape(plant.siteCode) + '">+ Engineer</button>') +
        "</div>"
      : "";
    var engineerNames = contacts.engineers.map(function (contact) { return contact.name; }).join(" ");
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
      '<td data-security-sort-value="' + fmt.escape(guardNames) + '" data-label="Security Guard">' +
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

  function registerHeadings(counts) {
    return [
      "Site Code (" + plants.length + ")",
      "Site Engineer (" + counts.engineers + ")",
      "Site Engineer No.",
      "Security Guard (" + counts.guards + ")",
      "Mobile No.",
      "Guard Shift"
    ];
  }

  function tableHTML(editingRows, counts) {
    var headings = [
      "Site Code", "Site Engineer", "Site Engineer No.",
      "Security Guard", "Mobile No.", "Guard Shift"
    ];
    if (!editingRows) headings = registerHeadings(counts);
    return '<div class="ep-pt__table-wrap"><div class="ep-pt__scroll ep-security__scroll" data-security-table="' +
      (editingRows ? "editor" : "register") + '" tabindex="0" role="region" aria-label="Site security contact table">' +
      '<table class="ep-pt__table ep-security__table"><thead><tr>' +
        headings.map(function (label, index) {
          return headerHTML(label, index, editingRows);
        }).join("") +
      "</tr></thead><tbody>" +
        (plants.length
          ? plants.map(function (plant) { return rowHTML(plant, editingRows); }).join("")
          : '<tr><td colspan="6" class="ep-pt__empty">No plants are available in your account scope.</td></tr>') +
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
        '<header class="ep-security__modal-head"><div><h2 id="ep-security-editor-title">' +
          (!canEdit() ? "Move Security Contacts"
            : guardMode ? "Edit Security Guards" : "Edit Security Register") + '</h2>' +
          '<p>' + (!canEdit()
            ? "Move a site engineer to another plant in your assigned scope."
            : guardMode
              ? "Change each guard’s name, mobile number and duty shift. Guards stay at their own site."
              : "Add, edit or move site engineers. Guards are changed from the button above.") + '</p></div>' +
          '<div class="ep-security__head-actions">' +
          (canEdit()
            ? '<button type="button" class="ep-security__guard-toggle' + (guardMode ? " is-on" : "") +
              '" data-security-guard-mode="' + (guardMode ? "off" : "on") + '"' +
              (saving ? " disabled" : "") + '>' +
              (guardMode ? "Edit site engineers" : "Change guards") + "</button>"
            : "") +
          '<button type="button" class="ep-security__close" data-security-close aria-label="Close editor"' +
          (saving ? " disabled" : "") + '>×</button></div></header>' +
        '<div class="ep-security__notice' + (noticeIsError ? " is-error" : "") +
          '" role="' + (noticeIsError ? "alert" : "status") + '"' + (notice ? "" : " hidden") + ">" +
          fmt.escape(notice) + "</div>" +
        '<div class="ep-security__filters"><label><span>Search contacts or site code</span>' +
          '<input type="search" data-security-search value="' + fmt.escape(filterText) +
          '" placeholder="Search..."' + (saving ? " disabled" : "") + '></label>' +
          '<label><span>Filter by site</span><select data-security-site-filter' +
          (saving ? " disabled" : "") + ">" + siteOptions + "</select></label></div>" +
        tableHTML(true) +
        '<footer class="ep-security__modal-foot">' +
          '<button type="button" class="ep-security__cancel" data-security-close' +
          (saving ? " disabled" : "") + '>Cancel</button>' +
          (canEdit() ? '<button type="button" class="ep-pt__edit ep-security__save" data-security-save' +
          (saving || !Object.keys(dirty).length ? " disabled" : "") + '>' +
          (saving ? "Saving..." : "Save changes") + "</button>" : "") + "</footer>" +
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

  /**
   * How many PEOPLE are on the register, not how many plants have someone. A person listed at two
   * plants counts twice, which is the honest reading of a register kept per plant. Counted from the
   * same lists used to render the columns and rows, so their totals cannot disagree.
   */
  function registerCounts() {
    var engineers = 0;
    var guards = 0;
    plants.forEach(function (plant) {
      var contacts = contactsFor(plant);
      engineers += contacts.engineers.length;
      guards += contacts.guards.length;
    });
    return { engineers: engineers, guards: guards };
  }

  function render(container) {
    if (!container) return;
    var openScroller = container.querySelector('[data-security-table="editor"]');
    var keepScrollTop = openScroller ? openScroller.scrollTop : 0;
    var editable = canEdit();
    var counts = registerCounts();
    container.innerHTML = "" +
      '<div class="ep-pt">' +
        '<div class="ep-pt__head"><h1 class="ep-pt__title">Site Engineer and Security</h1>' +
          (editable || canMove() ? '<button type="button" class="ep-pt__edit ep-security__open" data-security-open-edit' +
            '>Edit register</button>' : "") +
        "</div>" +
        '<div class="ep-security__register-filter"><label><span>Search by plant code, site engineer, or security name</span>' +
          '<input type="search" data-security-register-search value="' + fmt.escape(registerSearch) +
          '" placeholder="Plant code, site engineer, security name..." autocomplete="off"></label></div>' +
        '<div class="ep-pt__card">' +
          '<div class="ep-security__notice' + (noticeIsError ? " is-error" : "") +
            '" role="' + (noticeIsError ? "alert" : "status") + '"' +
            (!editing && notice ? "" : " hidden") + ">" + fmt.escape(notice) + "</div>" +
          tableHTML(false, counts) +
        "</div>" +
        (editing ? editorHTML() : "") +
      "</div>";
    applyRegisterFilters(container);
    applyRegisterSort(container);
    if (editing) applyEditorFilters(container);
    if (keepScrollTop) {
      var scroller = container.querySelector('[data-security-table="editor"]');
      if (scroller) scroller.scrollTop = keepScrollTop;
    }
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

  /** The editor's own rows. The read-only register marks its rows the same way and renders first,
   *  so an unscoped lookup finds the wrong row - one with no inputs in it. */
  function editorRows(container) {
    var table = container.querySelector('[data-security-table="editor"]');
    return table ? table.querySelectorAll("[data-security-row]") : [];
  }

  function editorRow(container, siteCode) {
    return Array.prototype.find.call(editorRows(container), function (row) {
      return row.getAttribute("data-security-row") === siteCode;
    }) || null;
  }

  function syncDrafts(container) {
    if (!drafts) return;
    Array.prototype.forEach.call(editorRows(container), function (row) {
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
          // A narrow write: only this plant's security register. The server merges it into the
          // plant's custom_fields, so no other field is touched and it needs no plants.manage.
          return api.request("/api/plants/" + encodeURIComponent(latest.dbId) + "/security-contacts", {
            method: "PATCH",
            body: payload.contacts
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

  /**
   * Replace one plant's row in both tables, in place: no re-render of the page, so the editor keeps
   * its scroll position and the register behind it stays where it was.
   */
  function refreshRow(container, siteCode) {
    var plant = plants.find(function (item) { return item.siteCode === siteCode; });
    if (!plant) return;
    Array.prototype.forEach.call(
      container.querySelectorAll("[data-security-row]"),
      function (row) {
        if (row.getAttribute("data-security-row") !== siteCode) return;
        var isEditor = !!row.closest('[data-security-table="editor"]');
        var replacement = document.createElement("tbody");
        replacement.innerHTML = rowHTML(plant, isEditor);
        var fresh = replacement.firstElementChild;
        if (fresh) row.parentNode.replaceChild(fresh, row);
      }
    );
    applyRegisterFilters(container);
    if (editing) applyEditorFilters(container);
  }

  function updateRegisterHeadings(container) {
    var counts = registerCounts();
    var headings = registerHeadings(counts);
    var cells = container.querySelectorAll('[data-security-table="register"] thead th');
    headings.forEach(function (label, index) {
      var cell = cells[index];
      if (!cell) return;
      var sort = cell.querySelector("[data-security-sort]");
      var text = sort && sort.querySelector("span");
      if (text) {
        text.textContent = label;
        var direction = cell.getAttribute("aria-sort") === "ascending" ? "descending" : "ascending";
        sort.setAttribute("aria-label", "Sort by " + label + " " + direction);
      } else {
        cell.textContent = label;
      }
    });
  }

  function showNotice(container, message, isError) {
    notice = message;
    noticeIsError = !!isError;
    // The editor's own strip when it is open, the register's otherwise: the last one in the DOM is
    // the editor's, because the overlay is appended after the card.
    var strips = container.querySelectorAll(".ep-security__notice");
    var strip = strips.length ? strips[strips.length - 1] : null;
    if (!strip) {
      render(container);
      return;
    }
    strip.textContent = message;
    strip.classList.toggle("is-error", !!isError);
    strip.setAttribute("role", isError ? "alert" : "status");
    strip.hidden = !message;
  }

  /** Apply one plant's custom_fields as the API returned them. */
  function applyPlantFields(siteCode, fields) {
    var plant = plants.find(function (item) { return item.siteCode === siteCode; });
    if (!plant) return;
    plant.customFields = fields && typeof fields === "object" ? fields : {};
    if (drafts) drafts[siteCode] = copyContacts(contactsFor(plant));
  }

  /**
   * One two-plant write. The endpoint moves the person inside a single transaction, so there is no
   * state in which they are on neither plant; on failure the table is left exactly as it was and
   * the reason goes to the notice strip.
   */
  function confirmMove(container) {
    if (!moving || !moving.target || movePending) return;
    var request = {
      from_site_code: moving.siteCode,
      to_site_code: moving.target,
      kind: moving.kind,
      index: moving.index
    };
    movePending = true;
    refreshRow(container, request.from_site_code);
    showNotice(container, "Moving…", false);
    api.request("/api/plants/security/move", { method: "POST", body: request }).then(function (result) {
      var from = (result && result.from_plant) || {};
      var to = (result && result.to_plant) || {};
      applyPlantFields(request.from_site_code, from.custom_fields);
      applyPlantFields(request.to_site_code, to.custom_fields);
      var person = (result && result.person) || {};
      moving = null;
      movePending = false;
      // The source row loses the person and the destination row gains them; nothing else moves.
      refreshRow(container, request.from_site_code);
      refreshRow(container, request.to_site_code);
      updateRegisterHeadings(container);
      showNotice(container, (person.name || "The person") + " moved from " + request.from_site_code +
        " to " + request.to_site_code + ".", false);
      // The move is stored; the cached plant list the rest of the portal reads must not stay stale.
      api.plants(true).catch(function (error) {
        showNotice(container, (person.name || "The person") + " moved, but other portal views could not refresh: " +
          ((error && error.message) || "please reload the page."), true);
      });
    }).catch(function (error) {
      movePending = false;
      refreshRow(container, request.from_site_code);
      showNotice(container, "Could not move this person from " + request.from_site_code + " to " +
        request.to_site_code + ": " + ((error && error.message) || "please try again."), true);
    });
  }

  function openEditor(container) {
    editing = true;
    guardMode = false;   // always opens on site engineers; guards are opened deliberately
    drafts = Object.create(null);
    plants.forEach(function (plant) {
      drafts[plant.siteCode] = copyContacts(contactsFor(plant));
    });
    dirty = Object.create(null);
    moving = null;
    movePending = false;
    filterText = "";
    filterSiteCode = "";
    notice = "";
    noticeIsError = false;
    render(container);
    var search = container.querySelector("[data-security-search]");
    if (search) search.focus();
  }

  function closeEditor(container) {
    if (saving || movePending) return;
    editing = false;
    guardMode = false;
    drafts = null;
    dirty = Object.create(null);
    moving = null;
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
      if (event.target.matches("[data-security-move-target]")) {
        if (moving) moving.target = event.target.value;
        var panelRow = event.target.closest("[data-security-row]");
        if (panelRow) refreshRow(container, panelRow.getAttribute("data-security-row"));
        var again = container.querySelector("[data-security-move-target]");
        if (again) again.focus();
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
      // Switch between editing site engineers and editing guards. Unsaved edits are kept: the
      // drafts hold both kinds, so nothing typed is lost by looking at the other one.
      var guardToggle = event.target.closest("[data-security-guard-mode]");
      if (guardToggle) {
        syncDrafts(container);
        guardMode = guardToggle.getAttribute("data-security-guard-mode") === "on";
        moving = null;
        notice = "";
        noticeIsError = false;
        render(container);
        return;
      }
      if (event.target.matches("[data-security-overlay]")) {
        closeEditor(container);
        return;
      }
      var moveStart = event.target.closest("[data-security-move-start]");
      if (moveStart) {
        var startSite = moveStart.getAttribute("data-security-site");
        var previous = moving ? moving.siteCode : "";
        moving = {
          siteCode: startSite,
          kind: moveStart.getAttribute("data-security-move-start"),
          index: Number(moveStart.getAttribute("data-security-index")),
          target: ""
        };
        if (previous && previous !== startSite) refreshRow(container, previous);
        refreshRow(container, startSite);
        var select = container.querySelector("[data-security-move-target]");
        if (select) select.focus();
        return;
      }
      if (event.target.closest("[data-security-move-cancel]")) {
        if (movePending || !moving) return;
        var cancelled = moving.siteCode;
        moving = null;
        refreshRow(container, cancelled);
        return;
      }
      if (event.target.closest("[data-security-move-confirm]")) {
        confirmMove(container);
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
        // Put the cursor in the box that was just added, and bring it into view: the editor scrolls,
        // and on a long register a new empty row can otherwise appear well off screen.
        var targetRow = editorRow(container, addSite);
        var nameInput = targetRow && targetRow.querySelector('[data-security-contact-name="' +
          addKind + '"][data-security-index="' + (addList.length - 1) + '"]');
        if (nameInput) {
          if (nameInput.scrollIntoView) nameInput.scrollIntoView({ block: "nearest" });
          nameInput.focus();
        }
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
