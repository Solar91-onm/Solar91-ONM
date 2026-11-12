/**
 * register-io.js
 * ─────────────────────────────────────────────────────────────────────
 * The shared "Import / Export" control for a register.
 *
 * Two registers use it today — Site issues (beside Raise issue) and the PM plan
 * (beside Set up PM) — and both talk to importers the backend already had:
 *
 *   Site issues   GET  /api/issues/import/template   POST /api/issues/import
 *                 GET  /api/issues/export
 *   PM plan       GET  /api/pm-plan/import/template  POST /api/pm-plan/import
 *                 GET  /api/pm-plan/export
 *
 * Import is deliberately two steps. The first upload runs with dry_run=true, so
 * the server validates every row and saves nothing; the operator sees what would
 * happen and only then confirms. That is the importers' own contract — they
 * refuse a file outright if any row is wrong — and it is what stops a mistyped
 * spreadsheet from raising a hundred wrong tickets.
 *
 * REGISTERS below is the only per-register knowledge; everything else is shared.
 */
(function (global) {
  "use strict";

  var REGISTERS = {
    issues: {
      label: "site issues",
      templateUrl: "/api/issues/import/template",
      templateName: "Site_Issues_Template.xlsx",
      exportUrl: "/api/issues/export",
      exportName: "Site_Issues_Register.xlsx",
      importUrl: "/api/issues/import",
      summary: function (result) {
        var parts = [];
        if (result.new) parts.push(result.new + " ticket" + (result.new === 1 ? "" : "s") + " to raise");
        if (result.critical) parts.push(result.critical + " critical");
        if (result.assigned) parts.push(result.assigned + " already assigned");
        if (result.unchanged) parts.push(result.unchanged + " skipped (already open)");
        return parts;
      },
      saved: function (result) {
        return result.saved + " ticket" + (result.saved === 1 ? "" : "s") + " raised.";
      },
      canApply: function (result) { return (result.new || 0) > 0; }
    },
    pm: {
      label: "PM plan",
      templateUrl: "/api/pm-plan/import/template",
      templateName: "PM_Plan_Template.xlsx",
      exportUrl: "/api/pm-plan/export",
      exportName: "PM_Register.xlsx",
      importUrl: "/api/pm-plan/import",
      summary: function (result) {
        var parts = [];
        if (result.rows) parts.push(result.rows + " row" + (result.rows === 1 ? "" : "s") + " read");
        if (result.tasks) parts.push(result.tasks + " work order" + (result.tasks === 1 ? "" : "s") + " to create");
        if (result.template_only_rows) parts.push(result.template_only_rows + " saved as templates only");
        if (result.skipped) parts.push(result.skipped + " skipped");
        return parts;
      },
      saved: function (result) {
        return (result.tasks || 0) + " work order" + ((result.tasks || 0) === 1 ? "" : "s") + " created.";
      },
      canApply: function (result) { return (result.rows || 0) > 0; }
    }
  };

  function api() {
    if (!global.Solar91PortalAPI) throw new Error("Portal API client is not loaded.");
    return global.Solar91PortalAPI;
  }

  function escape(value) {
    return global.Solar91PortalFormat
      ? global.Solar91PortalFormat.escape(value)
      : String(value === null || value === undefined ? "" : value)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /**
   * The markup for the pair of buttons. Rendered as a string so it can be
   * concatenated into the header templates both views already build.
   */
  function controls(registerKey, options) {
    var opts = options || {};
    var cls = opts.buttonClass || "ep-sheet-io__button";
    return '<span class="ep-sheet-io" data-sheet-io="' + escape(registerKey) + '">' +
      '<button type="button" class="' + escape(cls) + '" data-sheet-action="export" ' +
        'title="Download the current register as an Excel file">Export</button>' +
      (opts.canImport === false ? "" :
        '<button type="button" class="' + escape(cls) + '" data-sheet-action="import" ' +
          'title="Upload an Excel or CSV file">Import</button>') +
      '</span>';
  }

  // ── Import dialog ────────────────────────────────────────────────────
  var dialog = null;

  function closeDialog() {
    if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
    dialog = null;
    document.removeEventListener("keydown", onKeydown);
  }

  function onKeydown(event) {
    if (event.key === "Escape") closeDialog();
  }

  function status(message, kind) {
    var el = dialog && dialog.querySelector("[data-sheet-status]");
    if (!el) return;
    el.textContent = message || "";
    el.className = "ep-sheet-io__status" + (kind ? " is-" + kind : "");
  }

  function problemList(problems) {
    if (!problems || !problems.length) return "";
    var items = problems.slice(0, 20).map(function (problem) {
      var errors = problem.errors || problem.error || [];
      if (!Array.isArray(errors)) errors = [errors];
      return "<li><strong>Row " + escape(problem.row) + "</strong> " + escape(errors.join("; ")) + "</li>";
    }).join("");
    var more = problems.length > 20
      ? "<li>…and " + (problems.length - 20) + " more</li>"
      : "";
    return '<div class="ep-sheet-io__problems"><p>Fix these rows and upload again — nothing has been saved:</p>' +
      "<ul>" + items + more + "</ul></div>";
  }

  /** Pull the row problems out of either importer's shape (body, or a 422 detail). */
  function problemsOf(error, result) {
    if (result && result.problems && result.problems.length) return result.problems;
    var detail = error && error.data && error.data.detail;
    if (detail && typeof detail === "object" && detail.problems) return detail.problems;
    return null;
  }

  function openDialog(registerKey, onDone, siteCode) {
    var register = REGISTERS[registerKey];
    if (!register) return;
    closeDialog();
    dialog = document.createElement("div");
    dialog.className = "ep-sheet-io__overlay";
    dialog.innerHTML =
      '<div class="ep-sheet-io__dialog" role="dialog" aria-modal="true" aria-labelledby="sheet-io-title">' +
        '<header class="ep-sheet-io__head">' +
          '<h2 id="sheet-io-title" tabindex="-1">Import ' + escape(register.label) + '</h2>' +
          '<button type="button" class="ep-sheet-io__close" data-sheet-action="close" aria-label="Close">&times;</button>' +
        '</header>' +
        '<div class="ep-sheet-io__body">' +
          '<p class="ep-sheet-io__hint">Upload an .xlsx, .xlsm or .csv file. The file is checked first — ' +
            'nothing is saved until you confirm.</p>' +
          '<button type="button" class="ep-sheet-io__link" data-sheet-action="template">Download the blank template</button>' +
          '<label class="ep-sheet-io__file"><span>Choose a file</span>' +
            '<input type="file" accept=".xlsx,.xlsm,.csv" data-sheet-file /></label>' +
          '<p class="ep-sheet-io__status" data-sheet-status role="status" aria-live="polite"></p>' +
          '<div data-sheet-result></div>' +
        '</div>' +
        '<footer class="ep-sheet-io__foot">' +
          '<button type="button" class="ep-sheet-io__button" data-sheet-action="close">Cancel</button>' +
          '<button type="button" class="ep-sheet-io__button ep-sheet-io__button--primary" ' +
            'data-sheet-action="apply" disabled>Upload</button>' +
        '</footer>' +
      '</div>';
    document.body.appendChild(dialog);
    document.addEventListener("keydown", onKeydown);
    var heading = dialog.querySelector("#sheet-io-title");
    if (heading) heading.focus();

    var checked = null;   // the dry-run result for the file currently chosen
    var busy = false;

    function setBusy(value) {
      busy = value;
      Array.prototype.forEach.call(dialog.querySelectorAll("button, input"), function (el) {
        if (el.getAttribute("data-sheet-action") === "close") return;
        el.disabled = value || (el.getAttribute("data-sheet-action") === "apply" && !checked);
      });
    }

    function chosenFile() {
      var input = dialog.querySelector("[data-sheet-file]");
      return input && input.files && input.files[0] ? input.files[0] : null;
    }

    function check() {
      var file = chosenFile();
      checked = null;
      dialog.querySelector("[data-sheet-result]").innerHTML = "";
      setBusy(false);
      if (!file) { status(""); return; }
      setBusy(true);
      status("Checking " + file.name + "…");
      api().uploadFile(register.importUrl, file, { dry_run: "true" }).then(function (result) {
        var problems = problemsOf(null, result);
        if (problems) {
          dialog.querySelector("[data-sheet-result]").innerHTML = problemList(problems);
          status(problems.length + " row(s) need fixing.", "error");
          setBusy(false);
          return;
        }
        if (!register.canApply(result)) {
          status("This file has nothing new to add.", "error");
          setBusy(false);
          return;
        }
        checked = result;
        var parts = register.summary(result);
        dialog.querySelector("[data-sheet-result]").innerHTML =
          '<ul class="ep-sheet-io__summary">' +
          parts.map(function (part) { return "<li>" + escape(part) + "</li>"; }).join("") + '</ul>';
        status("Checked. Review the summary, then upload.", "ok");
        setBusy(false);
      }).catch(function (error) {
        var problems = problemsOf(error, null);
        dialog.querySelector("[data-sheet-result]").innerHTML = problems ? problemList(problems) : "";
        status(problems ? problems.length + " row(s) need fixing." : (error.message || "The file could not be read."), "error");
        setBusy(false);
      });
    }

    function apply() {
      var file = chosenFile();
      if (!file || !checked || busy) return;
      setBusy(true);
      status("Uploading…");
      api().uploadFile(register.importUrl, file, { dry_run: "false" }).then(function (result) {
        status(register.saved(result), "ok");
        // A write invalidates the cached reads, or the view would redraw from stale rows.
        if (global.Solar91PortalData && global.Solar91PortalData.invalidate) global.Solar91PortalData.invalidate();
        setTimeout(function () {
          closeDialog();
          if (typeof onDone === "function") onDone(result);
        }, 900);
      }).catch(function (error) {
        var problems = problemsOf(error, null);
        dialog.querySelector("[data-sheet-result]").innerHTML = problems ? problemList(problems) : "";
        status(error.message || "The upload failed. Nothing was saved.", "error");
        checked = null;
        setBusy(false);
      });
    }

    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) { closeDialog(); return; }
      var action = event.target.getAttribute && event.target.getAttribute("data-sheet-action");
      if (action === "close") closeDialog();
      else if (action === "apply") apply();
      else if (action === "template") {
        status("Preparing the template…");
        var templateUrl = register.templateUrl +
          (siteCode ? "?site_code=" + encodeURIComponent(siteCode) : "");
        api().downloadFile(templateUrl, register.templateName).then(function () {
          status("Template downloaded.", "ok");
        }).catch(function (error) { status(error.message || "The template could not be downloaded.", "error"); });
      }
    });
    dialog.addEventListener("change", function (event) {
      if (event.target.hasAttribute && event.target.hasAttribute("data-sheet-file")) check();
    });
  }

  /**
   * Handle a click inside a mounted control. Returns true when it was one of
   * ours, so the host view can stop there.
   */
  function handleClick(event, context) {
    var button = event.target.closest && event.target.closest("[data-sheet-action]");
    if (!button) return false;
    var host = button.closest("[data-sheet-io]");
    if (!host) return false;
    var registerKey = host.getAttribute("data-sheet-io");
    var register = REGISTERS[registerKey];
    if (!register) return false;
    var action = button.getAttribute("data-sheet-action");
    var options = context || {};
    if (action === "export") {
      var url = register.exportUrl + (options.siteCode ? "?site_code=" + encodeURIComponent(options.siteCode) : "");
      button.disabled = true;
      api().downloadFile(url, register.exportName).catch(function (error) {
        global.alert(error.message || "The register could not be downloaded.");
      }).then(function () { button.disabled = false; });
      return true;
    }
    if (action === "import") {
      openDialog(registerKey, options.onImported, options.siteCode);
      return true;
    }
    return false;
  }

  global.Solar91RegisterIO = {
    controls: controls,
    handleClick: handleClick,
    registers: REGISTERS
  };
}(window));
