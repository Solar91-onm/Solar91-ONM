/**
 * Site issue register for the portfolio and plant Health pages.
 *
 * Every ticket is read from and written to the authenticated, role-scoped issue API.
 * Categories and their sub-problems come from /api/categories (Settings -> Categories),
 * which replaced the hard-coded list and the per-asset equipment register.
 */
(function (global) {
  "use strict";

  var data = global.Solar91PortalData;
  var format = global.Solar91PortalFormat;
  var STATUSES = ["Unhealthy", "In Progress", "Solved"];
  // Categories and their sub-problems come from /api/categories (Settings -> Categories).
  // Empty until that list is filled; nothing here is hard-coded any more.
  var CATEGORIES = [];

  function categoryNames() {
    return CATEGORIES.map(function (c) { return c.name; });
  }

  function subProblemsFor(name) {
    var row = CATEGORIES.filter(function (c) { return c.name === name; })[0];
    return (row && row.sub_problems) || [];
  }

  function loadCategories() {
    return global.Solar91PortalAPI.request("/api/categories").then(function (body) {
      CATEGORIES = body.categories || [];
      return CATEGORIES;
    }).catch(function () {
      CATEGORIES = [];
      return CATEGORIES;
    });
  }
  /**
   * Quick templates are derived from the configured categories and their
   * sub-problems: one button per category + sub-problem pair, so the list grows
   * with yours instead of being hard-coded.
   */
  function templates() {
    var out = [];
    CATEGORIES.forEach(function (category) {
      (category.sub_problems || []).slice(0, 3).forEach(function (sub) {
        out.push({ label: category.name + " · " + sub, equipment: category.name, subpart: sub, problem: sub });
      });
    });
    return out.slice(0, 8);
  }
  var state = {
    rows: [],
    plants: [],
    loaded: false,
    loading: false,
    error: "",
    search: "",
    plantFilter: "",
    statusFilter: "All",
    sort: "recent",
    modalId: "",
    modalMode: "",
    wizardStep: 1,
    draft: null,
    requestId: 0,
    liveMode: false,
    canRaise: false,
    assignees: [],
    submitError: "",
    submitNotice: "",
    submitting: false
  };
  var active = null;
  var wiredHost = null;

  function escape(value) {
    return format.escape(value);
  }

  function plantLabel(plant) {
    return plant.displayName || plant.plantName;
  }

  function mapApiIssue(issue, plantsById) {
    var plant = plantsById[String(issue.plant_id)];
    return {
      id: issue.ticket_no,
      dbId: String(issue.id),
      plantId: String(issue.plant_id || ""),
      plantCode: plant ? plant.siteCode : "",
      plantName: plant ? plantLabel(plant) : "Plant unavailable",
      equipment: issue.vertical || "Other",
      subpart: issue.subcategory || "",
      serialNo: issue.serial_no || "",
      supplierMaker: issue.supplier_maker || "",
      unitCount: issue.unit_count == null ? "" : String(issue.unit_count),
      occurredAt: issue.occurred_at || "",
      dueAt: issue.etc_at || "",
      problem: issue.description,
      status: issue.status,
      assignee: issue.assignee_text || "",
      reportedAt: String(issue.created_at || "").slice(0, 10),
      reportedBy: "",
      evidenceFiles: [],
      photoCount: Number(issue.photo_count || 0),
      notes: "",
      severity: issue.severity,
      live: true
    };
  }

  function rowsFor(context, ignoreStatus) {
    var rows = state.rows.filter(function (issue) {
      if (context.plantCode && issue.plantCode !== context.plantCode) return false;
      if (state.plantFilter && issue.plantCode !== state.plantFilter) return false;
      if (!ignoreStatus && state.statusFilter !== "All" && statusGroup(issue.status) !== state.statusFilter) return false;
      var term = state.search.trim().toLowerCase();
      if (!term) return true;
      return [
        issue.id, issue.plantCode, issue.plantName, issue.equipment,
        issue.supplierMaker, issue.serialNo, issue.problem, issue.status, issue.assignee
      ].join(" ").toLowerCase().indexOf(term) !== -1;
    });
    return rows.sort(function (a, b) {
      var dateOrder = state.sort === "oldest"
        ? a.reportedAt.localeCompare(b.reportedAt)
        : b.reportedAt.localeCompare(a.reportedAt);
      return dateOrder || STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.id.localeCompare(b.id);
    });
  }

  function countByStatus(rows, status) {
    return rows.filter(function (issue) { return statusGroup(issue.status) === status; }).length;
  }

  function statusGroup(status) {
    if (["Solved", "Resolved", "Closed"].indexOf(status) !== -1) return "Solved";
    if (["In Progress", "Pending Vendor", "Pending Parts/Vendor"].indexOf(status) !== -1) return "In Progress";
    return "Unhealthy";
  }

  function statusTone(status) {
    if (["Solved", "Resolved", "Closed"].indexOf(status) !== -1) return "solved";
    if (["In Progress", "Pending Vendor", "Pending Parts/Vendor"].indexOf(status) !== -1) return "progress";
    return "unhealthy";
  }

  function statusLabel(status) {
    if (!state.liveMode) return status;
    return status === "Unhealthy" ? "Open" : status === "Solved" ? "Resolved / Closed" : status;
  }

  function plantOptions() {
    var options = '<option value="">All plants</option>';
    return options + state.plants.map(function (plant) {
      return '<option value="' + escape(plant.siteCode) + '"' +
        (state.plantFilter === plant.siteCode ? " selected" : "") + ">" +
        escape(plantLabel(plant)) + " · " + escape(plant.displayCode) + "</option>";
    }).join("");
  }

  function renderHeader(context) {
    // Export is offered to everyone who can see the register; import follows the
    // same permission as raising a ticket, because that is what each row becomes.
    var sheets = global.Solar91RegisterIO
      ? global.Solar91RegisterIO.controls("issues", { canImport: state.canRaise })
      : "";
    var raise = state.canRaise
      ? '<button class="ep-issues__button ep-issues__button--primary" type="button" data-issue-action="raise">+ Raise issue</button>'
      : "";
    if (!sheets && !raise) return "";
    return '<div class="ep-issues__portfolio-actions">' + raise + sheets + '</div>';
  }

  function renderFilters(context, unfilteredRows) {
    var isPlant = !!context.plantCode;
    return '<section class="ep-issues__filters" aria-label="Issue filters">' +
      '<div class="ep-issues__filter-row">' +
        '<label class="ep-issues__search"><span class="ep-issues__sr-only">Search issues</span>' +
          '<span aria-hidden="true">⌕</span><input type="search" data-issue-filter="search" value="' +
          escape(state.search) + '" placeholder="Search issues, plants, equipment…" /></label>' +
        (isPlant
          ? '<span class="ep-issues__scope">' + escape(context.plantCode) + '</span>'
          : '<label class="ep-issues__select"><span class="ep-issues__sr-only">Filter by plant</span><select data-issue-filter="plant">' +
            plantOptions() + '</select></label>') +
        '<label class="ep-issues__select"><span class="ep-issues__sr-only">Sort issues</span><select data-issue-filter="sort">' +
          '<option value="recent">Recently reported</option><option value="oldest">Oldest first</option></select></label>' +
      '</div><div class="ep-issues__status-filters" aria-label="Filter by issue status">' +
        '<button type="button" data-issue-status="All" class="' + (state.statusFilter === "All" ? "is-active" : "") + '">All <b>' +
          unfilteredRows.length + '</b></button>' +
        STATUSES.map(function (status) {
          return '<button type="button" data-issue-status="' + escape(status) + '"' +
            (state.statusFilter === status ? ' class="is-active"' : "") + ">" +
            '<i class="ep-issues__dot ep-issues__dot--' + statusTone(status) + '"></i>' +
            escape(statusLabel(status)) + ' <b>' + countByStatus(unfilteredRows, status) + '</b></button>';
        }).join("") +
      '</div></section>';
  }

  function renderTable(rows) {
    if (!rows.length) {
      return '<div class="ep-issues__empty"><strong>No issues found</strong>' +
        '<button type="button" class="ep-issues__button" data-issue-action="clear">Clear filters</button></div>';
    }
    var headers = ["Issue ID", "Equipment", "Maker / Supplier", "Problem", "Plant", "Assigned to", "Status", "Action"];
    return '<div class="ep-issues__table-wrap"><table class="ep-issues__table"><thead><tr>' +
      headers.map(function (header) { return "<th>" + header + "</th>"; }).join("") +
      '</tr></thead><tbody>' + rows.map(function (issue) {
        var labels = headers;
        return '<tr>' +
          '<td data-label="' + labels[0] + '"><button type="button" class="ep-issues__ticket-link" data-issue-open="' +
            escape(issue.id) + '">' + escape(issue.id) + '</button></td>' +
          '<td data-label="' + labels[1] + '"><strong>' + escape(issue.equipment) + '</strong>' +
            (issue.subpart ? "<small>" + escape(issue.subpart) + "</small>" : "") + '</td>' +
          '<td data-label="' + labels[2] + '">' + (issue.supplierMaker
            ? '<strong>' + escape(issue.supplierMaker) + '</strong>' +
              (issue.serialNo ? "<small>S/N " + escape(issue.serialNo) + "</small>" : "")
            : '<span class="ep-issues__unassigned">Not recorded</span>') + '</td>' +
          '<td data-label="' + labels[3] + '" class="ep-issues__problem">' + escape(issue.problem) + '</td>' +
          '<td data-label="' + labels[4] + '"><strong>' + escape(issue.plantCode) + '</strong><small>' + escape(issue.plantName) + '</small></td>' +
          '<td data-label="' + labels[5] + '">' + (issue.assignee
            ? '<span class="ep-issues__assignee"><i>' + escape(issue.assignee.split(/\s+/).map(function (part) { return part[0]; }).join("").slice(0, 2)) +
              '</i>' + escape(issue.assignee) + '</span>'
            : '<span class="ep-issues__unassigned">Unassigned</span>') + '</td>' +
          '<td data-label="' + labels[6] + '"><span class="ep-issues__status ep-issues__status--' +
            statusTone(issue.status) + '"><i></i>' + escape(issue.status) + '</span></td>' +
          '<td data-label="' + labels[7] + '">' + (state.liveMode
            ? '<span aria-label="Manage this saved ticket in Solar91 O&M">Saved</span>'
            : '<button type="button" class="ep-issues__button ep-issues__button--small" data-issue-edit="' +
              escape(issue.id) + '">Edit</button>') + '</td>' +
        '</tr>';
      }).join("") + '</tbody></table></div>';
  }

  function formatIssueDate(value) {
    if (!value) return "—";
    var parts = value.split("-");
    return parts.length === 3 ? parts[2] + "-" + parts[1] + "-" + parts[0].slice(2) : value;
  }

  function renderDetails(issue) {
    return '<div class="ep-issues__drawer-content">' +
      '<div class="ep-issues__drawer-status ep-issues__drawer-status--' + statusTone(issue.status) + '">' +
        '<strong>' + escape(issue.equipment) + '</strong><span>' + escape(issue.id) + " · " +
          escape(formatIssueDate(issue.reportedAt)) + '</span></div>' +
      '<span class="ep-issues__status ep-issues__status--' + statusTone(issue.status) + '">' +
        '<i></i>' + escape(issue.status) + '</span>' +
      '<dl class="ep-issues__fields">' +
        field("Plant", issue.plantName) +
        field("Site code", issue.plantCode) +
        field("Category", issue.equipment) +
        field("Subpart / fault area", issue.subpart) +
        field("Supplier / Maker", issue.supplierMaker) +
        field("Serial number", issue.serialNo) +
        field("Number of units", issue.unitCount) +
        field("Occurrence date", issue.occurredAt ? formatIssueDate(issue.occurredAt) : "") +
        field("Expected time to close", issue.dueAt ? issue.dueAt.replace("T", " ") : "") +
        field("Reported", formatIssueDate(issue.reportedAt)) +
        field("Reported by", issue.reportedBy) +
        field("Assigned to", issue.assignee || "Unassigned") +
        field("Severity", issue.severity) +
        field("Status", issue.status) +
        field("Issue details", issue.problem) +
        field("Evidence photos", issue.evidenceFiles && issue.evidenceFiles.length
          ? issue.evidenceFiles.length + " selected: " + issue.evidenceFiles.map(function (file) {
            return typeof file === "string" ? file : file.name;
          }).join(", ")
          : (issue.photoCount ? issue.photoCount + " uploaded" : "")) +
        field("Notes", issue.notes) +
      '</dl><p class="ep-issues__demo-note">' +
        "Saved to Solar91 O&M. Use the main O&M app for ticket updates and workflow actions." +
        (state.submitNotice ? " " + escape(state.submitNotice) : "") + '</p>' +
      '</div><footer class="ep-issues__drawer-footer">' +
      '</footer>';
  }

  function field(label, value) {
    return "<div><dt>" + escape(label) + "</dt><dd>" + escape(value || "—") + "</dd></div>";
  }

  function localDate(date) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" +
      String(date.getDate()).padStart(2, "0");
  }

  function createDraft(context) {
    return {
      plantCode: context.plantCode || state.plantFilter || "",
      equipment: "",
      subpart: "",
      serialNo: "",
      supplierMaker: "",
      unitCount: "",
      occurredAt: localDate(new Date()),
      dueAt: "",
      problem: "",
      assignee: "",
      evidenceFiles: []
    };
  }

  function renderStepper() {
    var steps = ["Plant", "Classification", "Priority & details"];
    return '<ol class="ep-issues__stepper" aria-label="Issue capture steps">' +
      steps.map(function (step, index) {
        var number = index + 1;
        var className = number === state.wizardStep ? "is-current" : number < state.wizardStep ? "is-done" : "";
        return '<li class="' + className + '">' +
          '<span class="ep-issues__step-number">' + (number < state.wizardStep ? "✓" : number) + '</span>' +
          '<span>' + step + '</span>' +
          (number < steps.length ? '<i aria-hidden="true"></i>' : "") +
        '</li>';
      }).join("") + '</ol>';
  }

  function draftPlantName() {
    var plant = state.plants.find(function (item) { return item.siteCode === state.draft.plantCode; });
    return plant ? plantLabel(plant) + " · " + plant.displayCode : "";
  }

  function renderWizardPlant(context, draft) {
    if (context.plantCode) {
      return '<input type="hidden" name="plantCode" value="' + escape(context.plantCode) + '" />' +
        '<div class="ep-issues__readonly">' + escape(draftPlantName() || context.plantCode) + '</div>';
    }
    return '<select name="plantCode" required><option value="">Select plant</option>' +
      state.plants.map(function (plant) {
        return '<option value="' + escape(plant.siteCode) + '"' +
          (draft.plantCode === plant.siteCode ? " selected" : "") + ">" +
          escape(plantLabel(plant)) + " · " + escape(plant.displayCode) + "</option>";
      }).join("") + "</select>";
  }

  function renderEquipmentOptions(selected) {
    if (!CATEGORIES.length) {
      return '<option value="">No categories configured yet</option>';
    }
    return '<option value="">Select category</option>' + categoryNames().map(function (name) {
      return '<option value="' + escape(name) + '"' +
        (selected === name ? " selected" : "") + ">" + escape(name) + "</option>";
    }).join("");
  }

  function renderSubpartOptions(selected, category) {
    // The sub-problems configured for the chosen category.
    var options = subProblemsFor(category);
    if (!options.length) {
      return '<option value="">(none recorded for this category)</option>';
    }
    return '<option value="">(none)</option>' + options.map(function (item) {
      return '<option value="' + escape(item) + '"' +
        ((selected || "") === item ? " selected" : "") + ">" + escape(item) + "</option>";
    }).join("");
  }

  function renderWizardStepOne(context, draft) {
    return '<div class="ep-issues__wizard-step"><label class="ep-issues__wizard-field">Plant code' +
      renderWizardPlant(context, draft) + '</label>' +
      '<div class="ep-issues__wizard-info"><strong>What you will add</strong>' +
        '<span>Issue category and fault area</span><span>Issue priority and details</span>' +
        '<span>Optional evidence photos and assignee</span>' +
      '</div><div class="ep-issues__wizard-actions"><span></span>' +
        '<button type="button" class="ep-issues__button ep-issues__button--primary" data-wizard-action="next">Next</button>' +
      '</div></div>';
  }

  function renderWizardStepTwo(draft) {
    return '<div class="ep-issues__wizard-step"><label class="ep-issues__wizard-field">Issue vertical / category' +
      '<select name="equipment" required>' + renderEquipmentOptions(draft.equipment) + '</select>' +
      (CATEGORIES.length ? '' : '<small>Add them in Settings → Categories first.</small>') + '</label>' +
      '<label class="ep-issues__wizard-field">Sub-problem (optional)' +
        '<select name="subpart">' + renderSubpartOptions(draft.subpart, draft.equipment) + '</select>' +
        '<small>The fault for this category; describe the full problem separately in Issue details.</small>' +
      '</label>' +
      '<div class="ep-issues__wizard-fields ep-issues__wizard-fields--two">' +
        '<label class="ep-issues__wizard-field">Serial number of equipment (optional)' +
          '<input name="serialNo" type="text" maxlength="120" value="' + escape(draft.serialNo || "") +
          '" placeholder="e.g. INV-2023-004517" /></label>' +
        '<label class="ep-issues__wizard-field">Supplier / Maker (optional)' +
          '<input name="supplierMaker" type="text" maxlength="160" value="' + escape(draft.supplierMaker || "") +
          '" placeholder="Who made or supplied it" /></label>' +
      '</div>' +
      '<label class="ep-issues__wizard-field">Number of units (optional)' +
        '<input name="unitCount" type="number" min="1" max="100000" step="1" value="' +
        escape(draft.unitCount || "") + '" placeholder="How many units are affected" />' +
        '<small>How many units of this equipment the fault covers. Leave blank if it is not counted.</small>' +
      '</label>' +
      (templates().length
        ? '<div class="ep-issues__template-area"><strong>Quick templates — 1 click fills category, sub-problem and description</strong>' +
          '<div>' + templates().map(function (template, index) {
            return '<button type="button" data-issue-template="' + index + '">' + escape(template.label) + '</button>';
          }).join("") + '</div></div>'
        : "") +
      '<div class="ep-issues__wizard-actions"><button type="button" class="ep-issues__button" data-wizard-action="back">Back</button>' +
        '<button type="button" class="ep-issues__button ep-issues__button--primary" data-wizard-action="next">Next</button></div>' +
      '</div>';
  }

  function renderWizardStepThree(draft) {
    return '<div class="ep-issues__wizard-step">' +
      '<div class="ep-issues__wizard-fields ep-issues__wizard-fields--two">' +
        '<label class="ep-issues__wizard-field">Expected time to close (optional)' +
          '<input name="dueAt" type="datetime-local" value="' + escape(draft.dueAt) + '" />' +
          '<small>Leave blank to use the configured deadline.</small></label>' +
        '<label class="ep-issues__wizard-field">Occurrence date<input name="occurredAt" type="date" required value="' +
          escape(draft.occurredAt) + '" /></label>' +
      '</div>' +
      '<label class="ep-issues__wizard-field">Issue details<textarea name="problem" required rows="4" placeholder="Describe the full problem observed">' +
        escape(draft.problem) + '</textarea>' +
        '<small>Include what happened and relevant symptoms; the subpart / fault area is selected separately.</small>' +
      '</label>' +
      '<div class="ep-issues__wizard-fields ep-issues__wizard-fields--evidence">' +
        '<label class="ep-issues__wizard-field">Evidence photos (up to 10)' +
          '<input name="evidence" type="file" accept="image/jpeg,image/png,image/webp" multiple />' +
          '<small>' + (draft.evidenceFiles.length
            ? draft.evidenceFiles.length + " photo" + (draft.evidenceFiles.length === 1 ? "" : "s") + " selected"
            : "No photos selected") + '</small></label>' +
        '<label class="ep-issues__wizard-field">Assign to assignee (optional)' +
          '<select name="assignee"><option value="">Leave unassigned</option>' +
            (state.liveMode ? state.assignees.map(function (person) {
              return '<option value="' + escape(person.id) + '"' +
                (draft.assignee === person.id ? " selected" : "") + ">" + escape(person.name) + "</option>";
            }).join("") : ASSIGNEES.map(function (person) {
              return '<option value="' + escape(person) + '"' +
                (draft.assignee === person ? " selected" : "") + ">" + escape(person) + "</option>";
            }).join("")) + '</select></label>' +
      '</div>' +
      '<p class="ep-issues__wizard-error" data-wizard-error role="alert"' +
        (state.submitError ? "" : " hidden") + '>' + escape(state.submitError) + '</p>' +
      '<div class="ep-issues__wizard-actions"><button type="button" class="ep-issues__button" data-wizard-action="back">Back</button>' +
        '<button type="submit" class="ep-issues__button ep-issues__button--primary"' +
          (state.submitting ? " disabled" : "") + '>' + (state.submitting ? "Saving…" : "Create ticket") + '</button></div>' +
      '</div>';
  }

  function renderRaiseWizard(context) {
    if (!state.draft) state.draft = createDraft(context);
    var stepContent = state.wizardStep === 1
      ? renderWizardStepOne(context, state.draft)
      : state.wizardStep === 2
        ? renderWizardStepTwo(state.draft)
        : renderWizardStepThree(state.draft);
    return '<form class="ep-issues__wizard" data-issue-form data-issue-wizard novalidate>' +
      renderStepper() + stepContent +
        '<p class="ep-issues__wizard-demo-note">' +
          "This ticket will be saved against the selected plant." +
        '</p>' +
      '</form>';
  }

  function renderDrawer(context) {
    if (!state.modalMode) return "";
    var issue = state.rows.find(function (row) { return row.id === state.modalId; }) || null;
    var isForm = state.modalMode === "create" || state.modalMode === "edit";
    var isWizard = state.modalMode === "create";
    var title = isWizard ? "Raise issue ticket" :
      state.modalMode === "edit" ? "Edit issue" : "Issue details";
    return '<div class="ep-issues__overlay" data-issue-overlay>' +
      '<button type="button" class="ep-issues__backdrop" data-issue-action="close" aria-label="Close issue details"></button>' +
      '<aside class="ep-issues__drawer" role="dialog" aria-modal="true" aria-labelledby="issue-drawer-title">' +
        '<header class="ep-issues__drawer-head"><div><p>' +
          (isWizard ? "Step-by-step issue capture · Ticket ID and timestamp are generated only when you submit" :
            "Saved Solar91 O&M ticket") +
          '</p>' +
          '<h2 id="issue-drawer-title">' + title + '</h2></div>' +
          '<button type="button" class="ep-issues__drawer-x" data-issue-action="close" aria-label="Close">×</button></header>' +
        (isWizard
          ? '<div class="ep-issues__drawer-content">' + renderRaiseWizard(context) + '</div>'
          : isForm ? '<div class="ep-issues__drawer-content"></div>' : renderDetails(issue || {
          id: "Issue unavailable", plantCode: "", plantName: "", equipment: "", status: "Unhealthy",
          problem: "", reportedAt: "", reportedBy: "", assignee: "", notes: ""
        })) +
      (isWizard ? '<footer class="ep-issues__drawer-footer"><button type="button" class="ep-issues__button" data-issue-action="close">Cancel</button></footer>' : "") +
      '</aside></div>';
  }

  function render(host, context) {
    if (!host) throw new Error("Site issues host element is missing.");
    context = context || {};
    var previousScope = active ? active.context.plantCode || "" : null;
    var nextScope = context.plantCode || "";
    if (active && previousScope !== nextScope) {
      state.modalId = "";
      state.modalMode = "";
      state.draft = null;
      state.wizardStep = 1;
      state.plantFilter = "";
      state.search = "";
      state.statusFilter = "All";
    }
    active = { host: host, context: context };
    wire(host);
    if (state.loaded) {
      renderView();
    } else if (state.loading) {
      renderView();
    } else {
      load();
    }
  }

  function renderView() {
    if (!active) return;
    var host = active.host;
    var context = active.context;
    var rows = rowsFor(context);
    var unfilteredRows = rowsFor(context, true);
    var content = "";
    if (state.loading) {
      content = '<div class="ep-issues__message" role="status">' +
          "Loading saved issue tickets…" + '</div>';
    } else if (state.error) {
      content = '<div class="ep-issues__message ep-issues__message--error" role="alert">' +
          escape(state.error) +
          (global.Solar91PortalAPI && global.Solar91PortalAPI.isPortalRoute()
            ? ' <a href="/auth/login">Sign in to Solar91</a>' : "") +
          '<button type="button" data-issue-action="retry">Try again</button></div>';
    } else {
      content = '<section class="ep-issues__results"><div class="ep-issues__section-head">' +
            '<h2>Issues <span>' + rows.length + '</span></h2>' +
            '<span>' + (state.statusFilter === "All" ? "All statuses" : escape(state.statusFilter)) +
            (state.liveMode && state.rows.length >= 200 ? " · latest 200" : "") + '</span></div>' +
          renderTable(rows) + '</section>';
    }
    host.innerHTML = '<div class="ep-issues">' +
      renderHeader(context) +
      '<div class="ep-issues__body">' +
        renderFilters(context, unfilteredRows) +
        content +
      '</div>' +
      renderDrawer(context) +
    '</div>';
    var sort = host.querySelector('[data-issue-filter="sort"]');
    if (sort) sort.value = state.sort || "recent";
  }

  function load() {
    state.loading = true;
    state.error = "";
    var requestId = ++state.requestId;
    state.liveMode = true;
    state.submitError = "";
    state.submitNotice = "";
    renderView();
    loadCategories().then(function () {
      if (requestId !== state.requestId) return;
      loadLiveIssues(requestId);
    });
  }

  function loadLiveIssues(requestId) {
    var api = global.Solar91PortalAPI;
    api.session().then(function (session) {
      var role = session.user && session.user.role;
      var canRaise = ["O&M Head", "Assignee", "Site Engineer"].indexOf(role) !== -1;
      var requests = [
        api.plants(),
        api.request("/api/issues?limit=200"),
        canRaise ? api.request("/api/issues/assignees") : Promise.resolve([])
      ];
      return Promise.all(requests).then(function (result) {
        return { role: role, plants: result[0], issues: result[1], assignees: result[2] };
      });
    }).then(function (result) {
      if (requestId !== state.requestId) return;
      state.plants = result.plants;
      var plantsById = {};
      state.plants.forEach(function (plant) { plantsById[plant.dbId] = plant; });
      state.rows = result.issues.map(function (issue) { return mapApiIssue(issue, plantsById); });
      state.assignees = result.assignees || [];
      state.canRaise = ["O&M Head", "Assignee", "Site Engineer"].indexOf(result.role) !== -1 &&
        state.plants.length > 0;
      state.liveMode = true;
      state.loaded = true;
      state.loading = false;
      renderView();
    }).catch(function (error) {
      if (requestId !== state.requestId) return;
      state.loading = false;
      state.error = error.message || "Could not load saved issue tickets.";
      renderView();
    });
  }

  function wire(host) {
    if (wiredHost === host) return;
    wiredHost = host;
    host.addEventListener("input", function (event) {
      if (!active || active.host !== host) return;
      if (event.target.dataset.issueFilter === "search") {
        var pos = event.target.selectionStart;
        state.search = event.target.value;
        renderView();
        var search = host.querySelector('[data-issue-filter="search"]');
        if (search) {
          search.focus();
          if (typeof search.setSelectionRange === "function") search.setSelectionRange(pos, pos);
        }
      }
    });
    host.addEventListener("change", function (event) {
      if (!active || active.host !== host) return;
      if (event.target.name === "equipment" && state.modalMode === "create" && state.draft) {
        var currentWizard = host.querySelector("[data-issue-wizard]");
        if (currentWizard) syncWizardDraft(currentWizard);
        state.draft.equipment = event.target.value;
        state.draft.subpart = "";
        renderView();
        return;
      }
      if (event.target.name === "evidence" && state.modalMode === "create" && state.draft) {
        var files = Array.prototype.slice.call(event.target.files || []);
        var error = host.querySelector("[data-wizard-error]");
        var supportedTypes = ["image/jpeg", "image/png", "image/webp"];
        if (files.length > 10 || files.some(function (file) { return supportedTypes.indexOf(file.type) === -1; })) {
          if (error) {
            error.textContent = files.length > 10
              ? "Select no more than 10 photos."
              : "Evidence photos must be JPEG, PNG or WebP.";
            error.hidden = false;
          }
          event.target.value = "";
          return;
        }
        state.draft.evidenceFiles = files;
        renderView();
        return;
      }
      var filter = event.target.dataset.issueFilter;
      if (filter === "plant") state.plantFilter = event.target.value;
      else if (filter === "sort") state.sort = event.target.value;
      else return;
      renderView();
    });
    host.addEventListener("click", function (event) {
      if (!active || active.host !== host) return;
      var templateButton = event.target.closest("[data-issue-template]");
      if (templateButton && state.modalMode === "create" && state.draft) {
        var template = templates()[Number(templateButton.dataset.issueTemplate)];
        var wizardForm = host.querySelector("[data-issue-wizard]");
        if (wizardForm) syncWizardDraft(wizardForm);
        if (template) {
          state.draft.equipment = template.equipment;
          state.draft.subpart = template.subpart || "";
          state.draft.problem = template.problem;
          state.wizardStep = 2;
          renderView();
        }
        return;
      }
      var wizardAction = event.target.closest("[data-wizard-action]");
      if (wizardAction && state.modalMode === "create" && state.draft) {
        var currentForm = host.querySelector("[data-issue-wizard]");
        if (currentForm) syncWizardDraft(currentForm);
        var direction = wizardAction.dataset.wizardAction;
        if (direction === "back") {
          state.wizardStep = Math.max(1, state.wizardStep - 1);
        } else if (direction === "next") {
          if (currentForm && !currentForm.reportValidity()) return;
          if (state.wizardStep === 1) {
            var selectedPlant = state.plants.some(function (plant) {
              return plant.siteCode === state.draft.plantCode;
            });
            if (!selectedPlant) {
              var plantError = host.querySelector("[data-wizard-error]");
              if (plantError) {
                plantError.textContent = "Select a plant to continue.";
                plantError.hidden = false;
              }
              return;
            }
          }
          if (state.wizardStep === 2 && !categoryNames().includes(state.draft.equipment)) {
            var equipmentError = host.querySelector("[data-wizard-error]");
            if (equipmentError) {
              equipmentError.textContent = "Select an equipment category to continue.";
              equipmentError.hidden = false;
            }
            return;
          }
          state.wizardStep = Math.min(3, state.wizardStep + 1);
        }
        renderView();
        return;
      }
      var status = event.target.closest("[data-issue-status]");
      if (status) {
        state.statusFilter = status.dataset.issueStatus;
        renderView();
        return;
      }
      var edit = event.target.closest("[data-issue-edit]");
      if (edit) {
        state.modalId = edit.dataset.issueEdit;
        state.modalMode = "edit";
        renderView();
        return;
      }
      var open = event.target.closest("[data-issue-open]");
      if (open) {
        state.submitNotice = "";
        state.modalId = open.dataset.issueOpen;
        state.modalMode = "details";
        renderView();
        return;
      }
      // The shared Import / Export control handles its own clicks.
      if (global.Solar91RegisterIO && global.Solar91RegisterIO.handleClick(event, {
        siteCode: (active.context && active.context.plantCode) || "",
        onImported: function () { state.loaded = false; renderView(); }
      })) return;
      var actionButton = event.target.closest("[data-issue-action]");
      if (!actionButton) return;
      var action = actionButton.dataset.issueAction;
      if (action === "raise") {
        if (!state.liveMode || !state.canRaise) return;
        state.submitError = "";
        state.submitNotice = "";
        state.modalId = "";
        state.modalMode = "create";
        state.wizardStep = 1;
        state.draft = createDraft(active.context);
      } else if (action === "clear") {
        state.search = "";
        state.plantFilter = "";
        state.statusFilter = "All";
      } else if (action === "close") {
        if (state.submitting) return;
        state.modalId = "";
        state.modalMode = "";
        state.submitNotice = "";
        state.draft = null;
        state.wizardStep = 1;
      } else if (action === "retry") {
        state.loaded = false;
        load();
        return;
      } else if (action === "edit-current") {
        state.modalMode = "edit";
      } else if (action === "progress" || action === "solve") {
        var current = state.rows.find(function (row) { return row.id === state.modalId; });
        if (current) current.status = action === "progress" ? "In Progress" : "Solved";
      }
      renderView();
    });
    host.addEventListener("submit", function (event) {
      if (!event.target.matches("[data-issue-form]") || !active) return;
      event.preventDefault();
      if (state.submitting) return;
      var form = event.target;
      if (form.hasAttribute("data-issue-wizard")) {
        if (state.wizardStep !== 3 || !form.reportValidity()) return;
        syncWizardDraft(form);
        if (!state.liveMode) {
          var previewError = form.querySelector("[data-wizard-error]");
          if (previewError) {
            previewError.textContent = "This preview cannot save tickets. Open /portal on the signed-in Solar91 O&M app.";
            previewError.hidden = false;
          }
          return;
        }
        var plant = state.plants.find(function (item) { return item.siteCode === state.draft.plantCode; });
        var problem = state.draft.problem.trim();
        var validationMessage = "";
        if (!plant) validationMessage = "Select a plant in step 1.";
        else if (!categoryNames().includes(state.draft.equipment)) validationMessage = "Select a category in step 2.";
        else if (!problem) validationMessage = "Add issue details before submitting.";
        if (validationMessage) {
          var wizardError = form.querySelector("[data-wizard-error]");
          if (wizardError) {
            wizardError.textContent = validationMessage;
            wizardError.hidden = false;
          }
          return;
        }
        submitLiveIssue(form);
        return;
      }
      // There is no local write path: every ticket is created through submitLiveIssue
      // above, and edits/workflow actions stay in the main O&M app.
    });
    host.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && active && active.host === host && state.modalMode) {
        if (state.submitting) return;
        state.modalMode = "";
        state.modalId = "";
        state.draft = null;
        state.wizardStep = 1;
        renderView();
      }
    });
  }

  function syncWizardDraft(form) {
    if (!state.draft || !form) return;
    var values = new FormData(form);
    ["plantCode", "equipment", "subpart", "serialNo", "supplierMaker", "unitCount",
      "occurredAt", "dueAt", "problem", "assignee"].forEach(function (name) {
      if (values.has(name)) state.draft[name] = String(values.get(name) || "");
    });
  }

  function toUtcTimestamp(value, defaultTime) {
    if (!value) return null;
    var local = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value + "T" + (defaultTime || "09:00") + ":00+05:30"
      : value + (value.length === 16 ? ":00" : "") + "+05:30";
    var date = new Date(local);
    return isNaN(date.getTime()) ? null : date.toISOString();
  }

  function submitLiveIssue(form) {
    var api = global.Solar91PortalAPI;
    var draft = state.draft;
    var plant = state.plants.find(function (item) { return item.siteCode === draft.plantCode; });
    if (!plant || !plant.dbId) {
      state.submitError = "The selected plant is not available in your authorized plant list.";
      renderView();
      return;
    }

    state.submitting = true;
    state.submitError = "";
    renderView();
    var units = parseInt(draft.unitCount, 10);
    var payload = {
      plant_id: plant.dbId,
      vertical: draft.equipment,
      subcategory: draft.subpart || null,
      serial_no: (draft.serialNo || "").trim() || null,
      supplier_maker: (draft.supplierMaker || "").trim() || null,
      unit_count: isNaN(units) ? null : units,
      description: draft.problem.trim(),
      // Tickets raised here all carry the same priority, so the form no longer asks for one.
      // Medium is what the deadline defaults and notifications are keyed to.
      severity: "Medium",
      assigned_to: draft.assignee || null,
      occurred_at: toUtcTimestamp(draft.occurredAt, "09:00"),
      etc_at: draft.dueAt ? toUtcTimestamp(draft.dueAt) : null,
      photo_count: 0
    };

    api.request("/api/issues", { method: "POST", body: payload }).then(function (issue) {
      var plantsById = {};
      state.plants.forEach(function (item) { plantsById[item.dbId] = item; });
      var saved = mapApiIssue(issue, plantsById);
      var existing = state.rows.find(function (row) { return row.dbId === saved.dbId; });
      if (existing) state.rows.splice(state.rows.indexOf(existing), 1);
      state.rows.unshift(saved);
      if (!draft.evidenceFiles.length) return null;
      var files = new FormData();
      draft.evidenceFiles.forEach(function (file) { files.append("files", file, file.name); });
      return api.request("/api/issues/" + encodeURIComponent(issue.id) + "/evidence", {
        method: "POST",
        body: files
      }).then(function (evidence) {
        saved.photoCount = evidence.length;
      }).catch(function (error) {
        state.submitNotice = "Ticket saved, but photo upload failed: " + error.message;
      });
    }).then(function () {
      state.submitting = false;
      var saved = state.rows[0];
      state.modalMode = "details";
      state.modalId = saved.id;
      state.draft = null;
      state.wizardStep = 1;
      state.statusFilter = "All";
      state.search = "";
      renderView();
    }).catch(function (error) {
      state.submitting = false;
      state.submitError = error.message || "Could not save this issue ticket.";
      renderView();
    });
  }

  global.Solar91PortalIssues = { render: render };
}(window));
