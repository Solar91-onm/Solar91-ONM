/**
 * extra-cleaning.js
 * ─────────────────────────────────────────────────────────────────────
 * The ONE implementation of extra cleaning: how an entry is labelled, the three
 * actions an O&M Head or an Assignee may take on it, and the form that records one.
 *
 * Two screens show these entries — a plant's Module Cleaning calendar
 * (operations-calendar.js) and the portfolio's Module Cleaning board
 * (washing-board.js) — and both call in here. Wording, the two-step delete
 * confirm, the disabled states while saving and the role gate therefore cannot
 * drift apart between the two pages; a second copy of any of it is how this
 * codebase once ended up with two module-cleaning compliance formulas that
 * disagreed.
 *
 * The permission rule is the SERVER's, not this module's: the loader that guards a
 * daily report refuses any change to an entry with `is_extra` unless the caller is
 * the O&M Head or an active Assignee (app/scheduled/washing_cycles.py, 403
 * "Only the O&M Head or a washing Assignee can edit or remove extra cleaning").
 * `canManage()` below only decides what is worth drawing — a Site Engineer who
 * calls the API directly is still refused by the server.
 *
 * Endpoints: PATCH and DELETE /api/scheduled/washing/daily-reports/{id} for an
 * existing entry and POST /api/scheduled/washing/daily-reports/sheet for a new
 * one. Nothing here adds an endpoint of its own.
 *
 * Two kinds of entry exist and they do not mean the same thing:
 *   · `is_extra`   — re-cleaning done while a cycle was still running. A calendar
 *                    record only: it never counts towards cycle progress or
 *                    compliance. Shown in purple.
 *   · `post_cycle` — ordinary cleaning recorded once all three cycles were
 *                    complete. The month IS credited for it. Shown in blue.
 * Only the first kind is editable here; the second is what "Count as cleaning
 * (not extra)" turns the first into.
 *
 * REVIEW. Anyone who may record a day may record extra cleaning, a Site Engineer included, but an
 * entry they submit is saved `Pending` and counts for nothing until it is confirmed. Who may
 * confirm is again the server's rule, not this module's: the O&M Head or the plant's CONFIGURED,
 * active Assignee, and never the person who submitted it (`_can_review_washing` and the four-eyes
 * check in app/scheduled/washing_cycles.py). `can_review` on a report is that answer already
 * computed for this viewer, so the buttons below follow it rather than re-deciding anything.
 */
(function (global) {
  "use strict";

  /** The action names both screens put in their own data-attribute. */
  var ACTIONS = {
    openForm: "open-extra",
    closeForm: "close-extra",
    save: "save-extra",
    edit: "edit-extra",
    convert: "convert-extra",
    requestDelete: "request-extra-delete",
    cancelDelete: "cancel-extra-delete",
    confirmDelete: "confirm-extra-delete",
    // Review: a Site Engineer's entry is saved awaiting review and counts for nothing until the
    // O&M Head or the plant's own Assignee confirms it.
    confirmReview: "confirm-extra-review",
    requestReject: "request-extra-reject",
    cancelReject: "cancel-extra-reject",
    confirmReject: "confirm-extra-reject"
  };

  var ACTION_NAMES = Object.keys(ACTIONS).map(function (key) { return ACTIONS[key]; });

  var REPORTS_URL = "/api/scheduled/washing/daily-reports";

  /** How far back a Site Engineer may record, as the API allows (MAX_BACKDATE_DAYS). */
  var BACKDATE_DAYS = 44;

  function api() {
    return global.Solar91PortalAPI;
  }

  function escape(value) {
    return global.Solar91PortalFormat.escape(value);
  }

  function pad2(value) {
    return String(value).length < 2 ? "0" + String(value) : String(value);
  }

  /** dd-mm-yy, the short form both screens print. */
  function shortDate(iso) {
    var parts = String(iso || "").split("-");
    if (parts.length !== 3) return String(iso || "");
    return pad2(parts[2]) + "-" + pad2(parts[1]) + "-" + parts[0].slice(-2);
  }

  function currentUser() {
    var client = api();
    return client && typeof client.currentUser === "function" ? client.currentUser() : null;
  }

  /** Who the server lets change extra cleaning: the O&M Head, or any active Assignee. */
  function canManage() {
    var user = currentUser();
    return !!(user && (user.role === "O&M Head" || user.role === "Assignee"));
  }

  /** Who may record a day at all. A Site Engineer may record one; only a manager may change it. */
  function canRecord() {
    var user = currentUser();
    return !!(user && ["O&M Head", "Assignee", "Site Engineer"].indexOf(user.role) !== -1);
  }

  // Both shapes reach these: a saved report from the API (snake_case) and a calendar event the
  // page built from one (camelCase). Reading both keeps one implementation for both screens.

  /** Re-cleaning recorded during a running cycle (migration 048): work done, but not cycle progress. */
  function isExtra(entry) {
    if (!entry) return false;
    return entry.isExtra === true || entry.is_extra === true;
  }

  /** Ordinary cleaning recorded once all three cycles were complete: the month IS credited for it.
   *  The stored `is_extra` flag is what separates the two, so a marked entry is never this. */
  function isPostCycle(entry) {
    if (!entry) return false;
    var after = entry.isPostCycle === true || entry.post_cycle === true;
    return after && !isExtra(entry);
  }

  function cycleNumberOf(entry) {
    if (!entry) return 0;
    var value = entry.cycleNo === undefined || entry.cycleNo === null ? entry.cycle_no : entry.cycleNo;
    return Number(value) || 0;
  }

  /**
   * How an entry is named wherever it is shown. Extra cleaning belongs to no cycle's progress, so
   * naming the cycle plainly would read as if it did; the two screens must say the same thing.
   */
  function cycleLabel(entry) {
    var cycleNo = cycleNumberOf(entry);
    if (!cycleNo) return "";
    if (isExtra(entry)) return "During cycle " + cycleNo;
    if (isPostCycle(entry)) return "After cycle " + cycleNo;
    return "Cycle " + cycleNo;
  }

  /** "extra" (purple) or "after-cycles" (blue), the suffix both screens' class names carry. */
  function tone(entry) {
    return isExtra(entry) ? "extra" : isPostCycle(entry) ? "after-cycles" : "";
  }

  /** The badge an entry wears. Both screens use the same two rules from calendar.css. */
  function badgeHTML(entry, words) {
    if (isExtra(entry)) {
      return '<span class="ep-calendar__extra-badge">' + escape(words || "Extra") + '</span>';
    }
    if (isPostCycle(entry)) {
      return '<span class="ep-calendar__after-badge">After cycles</span>';
    }
    return "";
  }

  // ── Table numbers ───────────────────────────────────────────────────────────

  /** "1, 2, 4, 7-8, 13" or "100-91" (either direction) -> ordered unique numbers, or an error message. */
  function parseTableList(text, total) {
    var cleaned = String(text || "").replace(/\s*([-–—])\s*/g, "$1");
    var parts = cleaned.split(/[,;\s]+/).filter(Boolean);
    var numbers = [];
    var seen = {};
    for (var i = 0; i < parts.length; i += 1) {
      var match = parts[i].match(/^(\d+)(?:[-–—](\d+))?$/);
      if (!match) return { numbers: [], error: "“" + parts[i] + "” is not a table number or range." };
      var from = Number(match[1]);
      var to = match[2] === undefined ? from : Number(match[2]);
      if (from < 1 || to < 1 || from > total || to > total) {
        return { numbers: [], error: "Table numbers must be between 1 and " + total + "." };
      }
      var step = from <= to ? 1 : -1;
      for (var number = from; ; number += step) {
        if (seen[number]) return { numbers: [], error: "Table " + number + " is listed twice." };
        seen[number] = true;
        numbers.push(number);
        if (number === to) break;
      }
    }
    return { numbers: numbers, error: "" };
  }

  /** Compresses consecutive numbers without changing the order in which the user entered them. */
  function formatTableList(numbers) {
    var ordered = numbers || [];
    var parts = [];
    for (var i = 0; i < ordered.length;) {
      var j = i;
      var step = j + 1 < ordered.length && Math.abs(ordered[j + 1] - ordered[j]) === 1
        ? ordered[j + 1] - ordered[j] : 0;
      while (step && j + 1 < ordered.length && ordered[j + 1] - ordered[j] === step) j += 1;
      parts.push(j > i ? ordered[i] + "–" + ordered[j] : String(ordered[i]));
      i = j + 1;
    }
    return parts.join(", ");
  }

  function tableNumber(code) {
    var match = String(code || "").match(/(?:Table\s*)?(\d+)$/i);
    return match ? Number(match[1]) : null;
  }

  function tableNumbersOf(report) {
    return ((report && report.cleaned_table_codes) || []).map(tableNumber)
      .filter(function (number) { return number !== null; });
  }

  /** The tables an entry covers, as typed. Repeats are the point here, so a table already cleaned
   *  in the running cycle is accepted; only the plant's own table numbers are enforced, exactly as
   *  the API enforces them. */
  function planTables(state, total) {
    var text = String(state.extraList || "").trim();
    if (!state.extraDate) return { numbers: [], error: "" };
    if (!text) return { numbers: [], error: "" };
    return parseTableList(text, total);
  }

  /** The earliest date this viewer may record: the O&M team back to the month, a Site Engineer 45 days. */
  function earliestDate(month, today) {
    if (canManage()) return String(month || "") + "-01";
    var first = new Date(String(today) + "T12:00:00");
    if (isNaN(first.getTime())) return "";
    first.setDate(first.getDate() - BACKDATE_DAYS);
    return first.getFullYear() + "-" + pad2(first.getMonth() + 1) + "-" + pad2(first.getDate());
  }

  // ── The three actions on one entry ──────────────────────────────────────────

  /** A fresh set of the fields the markup and the handlers below read. Hosts keep one per screen. */
  function actionState() {
    return {
      extraConverting: false,
      extraConvertError: "",
      extraDeleteConfirmId: "",
      extraDeleting: false,
      extraDeleteError: "",
      extraReviewing: "",
      extraReviewError: "",
      extraRejectConfirmId: ""
    };
  }

  /** True when THIS viewer may decide on this entry: the server already worked that out. */
  function canReview(entry) {
    return !!entry && entry.can_review === true && entry.review_status === "Pending";
  }

  /** True while an entry is waiting for that decision, whoever is looking at it. */
  function awaitingReview(entry) {
    return !!entry && entry.review_status === "Pending";
  }

  /**
   * Edit · Count as cleaning (not extra) · Remove, or the two-step remove confirm once Remove has
   * been pressed. `entry` is a saved extra report (or the calendar event standing for one) and must
   * already have been checked for `canEdit`; `attr` is the data-attribute the host listens on.
   */
  function actionsHTML(entry, state, opts) {
    var attr = (opts && opts.attr) || "data-calendar-action";
    var reportId = entry.reportId || entry.id;
    var canDelete = entry.canDelete === true || entry.can_delete === true;
    if (state.extraDeleteConfirmId === reportId) {
      return '<p class="ep-calendar__extra-delete-warning" role="alert">Remove this extra cleaning record? This cannot be undone.</p>' +
        '<div class="ep-calendar__extra-detail-actions">' +
          '<button type="button" class="ep-calendar__close-button" ' + attr + '="' + ACTIONS.cancelDelete + '"' +
            (state.extraDeleting ? " disabled" : "") + '>Keep entry</button>' +
          '<button type="button" class="ep-calendar__setup-submit ep-calendar__setup-submit--danger" ' +
            attr + '="' + ACTIONS.confirmDelete + '" data-report-id="' + escape(reportId) + '"' +
            (state.extraDeleting ? " disabled" : "") + '>' +
            (state.extraDeleting ? "Removing…" : "Remove extra cleaning") + '</button>' +
        '</div>' +
        (state.extraDeleteError ? '<p class="ep-calendar__setup-error" role="alert">' +
          escape(state.extraDeleteError) + '</p>' : "");
    }
    return '<div class="ep-calendar__extra-detail-actions">' +
      '<button type="button" class="ep-calendar__setup-submit" ' + attr + '="' + ACTIONS.edit +
        '" data-report-id="' + escape(reportId) + '">Edit extra cleaning</button>' +
      // Work done after the three cycles are complete belongs on the sheet as an ordinary day.
      // Entries saved as extra before the sheet accepted those days are put right here instead
      // of being left out of the month's score.
      '<button type="button" class="ep-calendar__setup-submit" ' + attr + '="' + ACTIONS.convert + '" ' +
        'data-report-id="' + escape(reportId) + '"' + (state.extraConverting ? " disabled" : "") + '>' +
        (state.extraConverting ? "Counting…" : "Count as cleaning (not extra)") + '</button>' +
      (canDelete
        ? '<button type="button" class="ep-calendar__setup-submit ep-calendar__setup-submit--danger" ' +
          attr + '="' + ACTIONS.requestDelete + '" data-report-id="' + escape(reportId) +
          '">Remove extra cleaning</button>'
        : "") +
      '</div>' +
      (state.extraConvertError ? '<p class="ep-calendar__setup-error" role="alert">' +
        escape(state.extraConvertError) + '</p>' : "");
  }

  /**
   * Confirm / Reject, for an entry that is waiting on a decision and a viewer the server says may
   * make it. Rejecting cannot be taken back -- the endpoint refuses a second decision -- so it
   * asks once more and offers the reason that goes back to whoever recorded the entry.
   */
  function reviewHTML(entry, state, opts) {
    if (!canReview(entry)) return "";
    var attr = (opts && opts.attr) || "data-calendar-action";
    var reportId = entry.reportId || entry.id;
    var busy = state.extraReviewing === reportId;
    var error = state.extraReviewError && (state.extraRejectConfirmId === reportId ||
        state.extraReviewing === reportId || !state.extraRejectConfirmId)
      ? '<p class="ep-calendar__setup-error" role="alert">' + escape(state.extraReviewError) + '</p>'
      : "";
    if (state.extraRejectConfirmId === reportId) {
      return '<p class="ep-calendar__extra-delete-warning" role="alert">Reject this entry? It stops ' +
        'counting, and only the O&amp;M Head or the Assignee can change it afterwards.</p>' +
        '<div class="ep-calendar__extra-detail-actions">' +
          '<label class="ep-calendar__extra-review-reason"><span>Reason (optional)</span>' +
            '<input type="text" data-extra-review-note maxlength="4000" ' +
              'placeholder="e.g. tables were not actually cleaned"' +
              (busy ? " disabled" : "") + ' /></label>' +
          '<button type="button" class="ep-calendar__close-button" ' + attr + '="' +
            ACTIONS.cancelReject + '"' + (busy ? " disabled" : "") + '>Keep awaiting review</button>' +
          '<button type="button" class="ep-calendar__setup-submit ep-calendar__setup-submit--danger" ' +
            attr + '="' + ACTIONS.confirmReject + '" data-report-id="' + escape(reportId) + '"' +
            (busy ? " disabled" : "") + '>' + (busy ? "Rejecting…" : "Reject entry") + '</button>' +
        '</div>' + error;
    }
    return '<div class="ep-calendar__extra-detail-actions">' +
      '<button type="button" class="ep-calendar__setup-submit" ' + attr + '="' +
        ACTIONS.confirmReview + '" data-report-id="' + escape(reportId) + '"' +
        (busy ? " disabled" : "") + '>' + (busy ? "Confirming…" : "Confirm entry") + '</button>' +
      '<button type="button" class="ep-calendar__close-button" ' + attr + '="' +
        ACTIONS.requestReject + '" data-report-id="' + escape(reportId) + '"' +
        (busy ? " disabled" : "") + '>Reject entry</button>' +
    '</div>' + error;
  }

  function invalidateCaches() {
    var store = global.Solar91PortalData;
    if (store && typeof store.invalidate === "function") store.invalidate(true);
  }

  function alive(ctx) {
    return !ctx.alive || ctx.alive() !== false;
  }

  /** The saved extra entry this action names, or null when it is not one the viewer may change. */
  function target(reportId, ctx, needDelete) {
    var report = ctx.find ? ctx.find(reportId) : null;
    if (!report || !isExtra(report)) return null;
    if (needDelete) return report.can_delete === true ? report : null;
    return report.can_edit === true ? report : null;
  }

  /**
   * "Count as cleaning (not extra)": the entry becomes an ordinary counted day. It moves tables
   * INTO a cycle's progress and can complete that cycle, so the host reloads from the server
   * afterwards rather than patching a figure locally — cycle state is the server's answer.
   */
  function convert(reportId, state, ctx) {
    if (state.extraConverting || !canManage()) return;
    if (!target(reportId, ctx)) return;
    state.extraConverting = true;
    state.extraConvertError = "";
    ctx.render();
    api().request(REPORTS_URL + "/" + encodeURIComponent(reportId), {
      method: "PATCH",
      body: { is_extra: false }
    }).then(function () {
      if (!alive(ctx)) return;
      invalidateCaches();
      state.extraConverting = false;
      ctx.reload(false);
    }).catch(function (error) {
      if (!alive(ctx)) return;
      state.extraConverting = false;
      state.extraConvertError = (error && error.message) || "The entry could not be changed.";
      ctx.render();
    });
  }

  function requestDelete(reportId, state, ctx) {
    if (!canManage()) return;
    var report = target(reportId, ctx, true);
    if (!report) return;
    state.extraDeleteConfirmId = report.id;
    state.extraDeleteError = "";
    ctx.render();
  }

  function cancelDelete(state, ctx) {
    if (state.extraDeleting) return;
    state.extraDeleteConfirmId = "";
    state.extraDeleteError = "";
    ctx.render();
  }

  function confirmDelete(reportId, state, ctx) {
    if (state.extraDeleting || !canManage()) return;
    if (!target(reportId, ctx, true)) return;
    if (state.extraDeleteConfirmId !== reportId) return;   // only ever from the second step
    state.extraDeleting = true;
    state.extraDeleteError = "";
    ctx.render();
    api().request(REPORTS_URL + "/" + encodeURIComponent(reportId), { method: "DELETE" })
      .then(function () {
        if (!alive(ctx)) return;
        invalidateCaches();
        if (ctx.prune) ctx.prune(reportId);
        state.extraDeleteConfirmId = "";
        state.extraDeleting = false;
        state.extraDeleteError = "";
        ctx.render();
        ctx.reload(true);
      }).catch(function (error) {
        if (!alive(ctx)) return;
        state.extraDeleting = false;
        state.extraDeleteError = "Extra cleaning was not removed. " +
          (error && error.message ? error.message : "Please retry.");
        ctx.render();
      });
  }

  /** The entry this decision names, or null when this viewer may not make it. */
  function reviewTarget(reportId, ctx) {
    var report = ctx.find ? ctx.find(reportId) : null;
    return canReview(report) ? report : null;
  }

  /**
   * Send the decision. A confirmation can complete a cycle -- the server re-sequences the month
   * behind it -- so the host re-reads afterwards rather than patching a figure locally. The
   * server's own refusals come straight back: it declines a confirmation without the required
   * cleaning photos, and it refuses a decision from whoever submitted the entry.
   */
  function review(reportId, decision, state, ctx) {
    if (state.extraReviewing || !canManage()) return;
    if (!reviewTarget(reportId, ctx)) return;
    var note = decision === "Reject" && ctx.reviewNote ? ctx.reviewNote() : "";
    state.extraReviewing = reportId;
    state.extraReviewError = "";
    ctx.render();
    api().request(REPORTS_URL + "/" + encodeURIComponent(reportId) + "/review", {
      method: "POST",
      body: { decision: decision, remarks: (note || "").trim() || null }
    }).then(function () {
      if (!alive(ctx)) return;
      invalidateCaches();
      state.extraReviewing = "";
      state.extraRejectConfirmId = "";
      state.extraReviewError = "";
      ctx.reload(false);
    }).catch(function (error) {
      if (!alive(ctx)) return;
      state.extraReviewing = "";
      state.extraReviewError = (decision === "Confirm"
        ? "The entry was not confirmed. " : "The entry was not rejected. ") +
        (error && error.message ? error.message : "Please retry.");
      ctx.render();
    });
  }

  function requestReject(reportId, state, ctx) {
    if (state.extraReviewing || !canManage()) return;
    var report = reviewTarget(reportId, ctx);
    if (!report) return;
    state.extraRejectConfirmId = report.id;
    state.extraReviewError = "";
    ctx.render();
  }

  function cancelReject(state, ctx) {
    if (state.extraReviewing) return;
    state.extraRejectConfirmId = "";
    state.extraReviewError = "";
    ctx.render();
  }

  // ── The form that records or edits one entry ────────────────────────────────

  /** Open the form for a new entry, scoped to the plant the host is showing. */
  function openForm(state, ctx) {
    if (!canRecord() || ctx.ready === false) return;
    state.extraOpen = true;
    state.extraEditId = "";
    state.extraDate = ctx.today || "";
    state.extraList = "";
    state.extraRemarks = "";
    state.extraError = "";
    if (ctx.plants) state.extraPlantCode = ctx.plantCode || "";
    ctx.render();
    if (ctx.focus) ctx.focus(ctx.plants && !state.extraPlantCode ? "[data-extra-plant]" : "[data-extra-list]");
  }

  /** Open the form on a saved entry. Only a manager may change one, as the server insists. */
  function openEdit(reportId, state, ctx) {
    if (!canManage() || ctx.ready === false) return;
    var report = target(reportId, ctx);
    if (!report) return;
    state.extraOpen = true;
    state.extraEditId = report.id;
    state.extraDate = report.report_date || "";
    state.extraList = formatTableList(tableNumbersOf(report));
    state.extraRemarks = report.remarks || "";
    state.extraError = "";
    if (ctx.plants) state.extraPlantCode = report.site_code || ctx.plantCode || "";
    if (ctx.openedEdit) ctx.openedEdit(report);
    ctx.render();
    if (ctx.focus) ctx.focus("[data-extra-date]");
  }

  function closeForm(state, ctx) {
    if (state.extraSaving) return;
    state.extraOpen = false;
    state.extraEditId = "";
    state.extraDeleteConfirmId = "";
    state.extraDeleteError = "";
    state.extraError = "";
    ctx.render();
  }

  /** Read the form inputs back into state, so a re-render never loses what was typed. */
  function syncForm(host, state, ctx) {
    var form = host.querySelector("[" + ((ctx && ctx.formAttr) || "data-calendar-extra-form") + "]");
    if (!form) return;
    var date = form.querySelector("[data-extra-date]");
    var list = form.querySelector("[data-extra-list]");
    var remarks = form.querySelector("[data-extra-remarks]");
    var plant = form.querySelector("[data-extra-plant]");
    if (date) state.extraDate = date.value;
    if (list) state.extraList = list.value;
    if (remarks) state.extraRemarks = remarks.value;
    if (plant) state.extraPlantCode = plant.value;
  }

  /**
   * Update the preview, the range error and the save button in place, WITHOUT re-rendering: a
   * redraw on every keystroke would replace the field the user is typing in and lose the caret.
   */
  function refreshPreview(host, state, ctx) {
    syncForm(host, state, ctx);
    state.extraError = "";
    var total = Number(ctx.tableCount) || 0;
    var plan = planTables(state, total);
    var preview = host.querySelector("[data-extra-preview]");
    if (preview) {
      preview.textContent = plan.numbers.length
        ? plan.numbers.length + " table" + (plan.numbers.length === 1 ? "" : "s") +
          ": " + formatTableList(plan.numbers)
        : "Tables 1 to " + total;
    }
    var planError = host.querySelector("[data-extra-plan-error]");
    if (planError) {
      planError.textContent = plan.error;
      planError.hidden = !plan.error;
    }
    var save = host.querySelector('[' + ((ctx && ctx.attr) || "data-calendar-action") + '="' + ACTIONS.save + '"]');
    if (save) save.disabled = state.extraSaving || !state.extraDate || !!plan.error || !plan.numbers.length;
    var saveError = host.querySelector("[data-extra-error]");
    if (saveError) {
      saveError.textContent = "";
      saveError.hidden = true;
    }
  }

  /**
   * The dialog. `ctx.plants` is for a screen that is not already inside one plant: the form then
   * asks which plant before anything else, and shows nothing more until one is chosen.
   */
  function formHTML(state, ctx) {
    if (!state.extraOpen) return "";
    var attr = ctx.attr || "data-calendar-action";
    var total = Number(ctx.tableCount) || 0;
    var plan = planTables(state, total);
    var disabled = state.extraSaving ? " disabled" : "";
    var manager = canManage();
    var editing = !!state.extraEditId;
    var chooser = "";
    if (ctx.plants) {
      chooser = '<label><span>Plant</span><select data-extra-plant' +
        (editing || state.extraSaving ? " disabled" : "") + ' aria-label="Plant">' +
        '<option value="">Choose a plant</option>' +
        ctx.plants.map(function (plant) {
          return '<option value="' + escape(plant.code) + '"' +
            (state.extraPlantCode === plant.code ? " selected" : "") + '>' +
            escape(plant.name) + " · " + escape(plant.code) + '</option>';
        }).join("") + '</select></label>';
    }
    var needsPlant = !ctx.plantId;
    var ready = !needsPlant && !!state.extraDate && !plan.error && plan.numbers.length > 0;
    return '<div class="ep-calendar__modal ep-calendar__extra-modal" ' +
      (ctx.modalAttr || "data-calendar-extra-modal") + '>' +
      '<button class="ep-calendar__backdrop" type="button" ' + attr + '="' + ACTIONS.closeForm +
        '" aria-label="Close extra cleaning"></button>' +
      '<section class="ep-calendar__dialog ep-calendar__extra-dialog" role="dialog" aria-modal="true" aria-labelledby="washing-extra-title">' +
        '<header class="ep-calendar__dialog-head"><div>' +
          '<h2 id="washing-extra-title">' + (editing ? "Edit extra cleaning" : "Extra cleaning") + '</h2>' +
          '<p>' + escape(needsPlant ? "Choose a plant" : ctx.plantName) +
            (needsPlant ? "" : " · " + escape(total) + ' tables per cycle') + '</p>' +
        '</div><button type="button" class="ep-calendar__close" ' + attr + '="' + ACTIONS.closeForm +
          '" aria-label="Close">×</button></header>' +
        '<div class="ep-calendar__extra-body">' +
          '<p class="ep-calendar__extra-lead">Record tables cleaned again during a running cycle — dust, fog or anything else. ' +
            'Before all three cycles are complete, this is a calendar entry only and does <strong>not</strong> count towards ' +
            'cycle progress or plant compliance. Extra cleaning after all three cycles are complete increases monthly compliance.</p>' +
          (manager
            ? ""
            : '<p class="ep-calendar__extra-lead">Your entry is saved as awaiting review; the O&amp;M Head or the plant’s ' +
              'Cleaning Assignee confirms it.</p>') +
          '<form class="ep-calendar__extra-form" ' + (ctx.formAttr || "data-calendar-extra-form") + '>' +
            chooser +
            (needsPlant
              ? ""
              : '<label><span>Date cleaned</span>' +
                '<input type="date" data-extra-date value="' + escape(state.extraDate) + '" min="' +
                  escape(ctx.minDate || "") + '" max="' +
                  escape(ctx.today || "") + '" required' + disabled + ' /></label>' +
                '<label><span>Table numbers</span>' +
                  '<input type="text" data-extra-list placeholder="e.g. 26-35, 40 or 100-91" value="' +
                    escape(state.extraList) + '" autocomplete="off"' + disabled + ' />' +
                  '<small data-extra-preview>' + (plan.numbers.length
                      ? escape(plan.numbers.length + " table" + (plan.numbers.length === 1 ? "" : "s") +
                        ": " + formatTableList(plan.numbers))
                      : escape("Tables 1 to " + total)) + '</small></label>' +
                '<label><span>Reason / remarks</span>' +
                  '<input type="text" data-extra-remarks maxlength="4000" placeholder="e.g. heavy dust after harvest" value="' +
                    escape(state.extraRemarks) + '"' + disabled + ' /></label>') +
          '</form>' +
          (needsPlant
            ? '<p class="ep-calendar__extra-lead">Choose the plant this extra cleaning belongs to.</p>'
            : "") +
          '<p class="ep-calendar__setup-error" data-extra-plan-error role="alert"' +
            (plan.error ? "" : " hidden") + '>' + escape(plan.error) + '</p>' +
          '<p class="ep-calendar__setup-error" data-extra-error role="alert"' +
            (state.extraError ? "" : " hidden") + '>' + escape(state.extraError) + '</p>' +
        '</div>' +
        '<footer class="ep-calendar__record-footer">' +
          '<button type="button" class="ep-calendar__close-button" ' + attr + '="' + ACTIONS.closeForm +
            '"' + disabled + '>Cancel</button>' +
          '<button type="button" class="ep-calendar__setup-submit" ' + attr + '="' + ACTIONS.save + '"' +
            (ready && !state.extraSaving ? "" : " disabled") + '>' +
            (state.extraSaving ? "Saving…" : editing ? "Save changes" : "Save extra cleaning") + '</button></footer>' +
      '</section>' +
    '</div>';
  }

  /** Save a new entry, or the edit of one. Validation, wording and both requests live here only. */
  function save(state, ctx) {
    var editing = !!state.extraEditId;
    if (state.extraSaving || (editing ? !canManage() : !canRecord()) || ctx.ready === false) return;
    if (ctx.sync) ctx.sync();
    if (!ctx.plantId) {
      state.extraError = "Choose the plant this extra cleaning belongs to.";
      ctx.render();
      return;
    }
    var plan = planTables(state, Number(ctx.tableCount) || 0);
    if (!state.extraDate || plan.error || !plan.numbers.length) {
      state.extraError = plan.error ||
        "Choose the date and type the table numbers that were cleaned again.";
      ctx.render();
      return;
    }
    state.extraSaving = true;
    state.extraError = "";
    ctx.render();
    var request = editing
      ? api().request(REPORTS_URL + "/" + encodeURIComponent(state.extraEditId), {
        method: "PATCH",
        body: {
          report_date: state.extraDate,
          table_numbers: plan.numbers,
          remarks: state.extraRemarks || ""
        }
      })
      : api().request(REPORTS_URL + "/sheet", {
        method: "POST",
        body: {
          plant_id: ctx.plantId,
          entries: [{
            report_date: state.extraDate,
            job_status: "Done",
            tables_cleaned: plan.numbers.length,
            table_numbers: plan.numbers,
            remarks: state.extraRemarks || null,
            is_extra: true
          }]
        }
      });
    var savedDate = state.extraDate;
    request.then(function (result) {
      if (!alive(ctx)) return;
      invalidateCaches();
      var saved = editing ? result : (Array.isArray(result.reports) ? result.reports : [])[0];
      state.extraSaving = false;
      state.extraOpen = false;
      state.extraEditId = "";
      var notice = (editing ? "Extra cleaning updated: " : "Extra cleaning saved: ") +
        plan.numbers.length + " table" + (plan.numbers.length === 1 ? "" : "s") +
        " on " + shortDate(savedDate) +
        (saved && saved.review_status === "Pending" ? ", awaiting review." : ".");
      ctx.saved(saved, notice, editing);
    }).catch(function (error) {
      if (!alive(ctx)) return;
      state.extraSaving = false;
      state.extraError = (editing ? "Extra cleaning was not updated. " : "Extra cleaning was not saved. ") +
        (error && error.message ? error.message : "Please retry.");
      ctx.render();
    });
  }

  function isAction(name) {
    return ACTION_NAMES.indexOf(String(name)) !== -1;
  }

  /** One entry point for every screen: map a clicked action name onto the behaviour above. */
  function act(name, reportId, state, ctx) {
    if (name === ACTIONS.openForm) openForm(state, ctx);
    else if (name === ACTIONS.closeForm) closeForm(state, ctx);
    else if (name === ACTIONS.save) save(state, ctx);
    else if (name === ACTIONS.edit) openEdit(reportId, state, ctx);
    else if (name === ACTIONS.convert) convert(reportId, state, ctx);
    else if (name === ACTIONS.requestDelete) requestDelete(reportId, state, ctx);
    else if (name === ACTIONS.cancelDelete) cancelDelete(state, ctx);
    else if (name === ACTIONS.confirmDelete) confirmDelete(reportId, state, ctx);
    else if (name === ACTIONS.confirmReview) review(reportId, "Confirm", state, ctx);
    else if (name === ACTIONS.requestReject) requestReject(reportId, state, ctx);
    else if (name === ACTIONS.cancelReject) cancelReject(state, ctx);
    else if (name === ACTIONS.confirmReject) review(reportId, "Reject", state, ctx);
    else return false;
    return true;
  }

  global.Solar91ExtraCleaning = {
    ACTIONS: ACTIONS,
    isAction: isAction,
    act: act,
    canManage: canManage,
    canRecord: canRecord,
    isExtra: isExtra,
    isPostCycle: isPostCycle,
    cycleLabel: cycleLabel,
    tone: tone,
    badgeHTML: badgeHTML,
    actionState: actionState,
    actionsHTML: actionsHTML,
    canReview: canReview,
    awaitingReview: awaitingReview,
    reviewHTML: reviewHTML,
    formHTML: formHTML,
    syncForm: syncForm,
    refreshPreview: refreshPreview,
    planTables: planTables,
    parseTableList: parseTableList,
    formatTableList: formatTableList,
    tableNumber: tableNumber,
    tableNumbersOf: tableNumbersOf,
    earliestDate: earliestDate,
    shortDate: shortDate
  };
}(window));
