/**
 * Asset & Warranty — inventory is intentionally not inferred from PM setup.
 * The current portal has no authorized inventory source or warranty mapping.
 */
(function (global) {
  "use strict";

  var data = global.Solar91PortalData;
  var format = global.Solar91PortalFormat;
  var activeCloseDialog = null;

  function escape(value) {
    return format.escape(value == null ? "" : String(value));
  }

  function render(host, options) {
    if (!host) return;
    if (activeCloseDialog) activeCloseDialog();
    options = options || {};
    host.innerHTML = '<div class="ep-aw">' +
      '<header class="ep-aw__header">' +
        '<div><p class="ep-aw__eyebrow">PLANT OPERATIONS</p>' +
          '<h2>Asset &amp; Warranty</h2>' +
          '<p class="ep-aw__intro">Review registered equipment and warranty information for each plant.</p></div>' +
        // Set up is per plant: the sheet records the equipment AT a plant, so it belongs on the
        // plant page and not on the portfolio-wide Views tab, where there is no plant to set up.
        (options.plantCode && global.Solar91RegisterIO
          ? '<div class="ep-aw__actions">' +
              global.Solar91RegisterIO.controls("warranty", { canImport: true }) +
            '</div>'
          : "") +
      '</header>' +
      '<div class="ep-aw__metrics" aria-label="Asset and warranty availability">' +
        '<article class="ep-aw__metric"><span>Registered units</span><strong>Not available</strong></article>' +
        '<article class="ep-aw__metric"><span>Warranty rules</span><strong>Not configured</strong></article>' +
        '<article class="ep-aw__metric"><span>Warranty status</span><strong>Not available</strong></article>' +
      '</div>' +
      '<section class="ep-panel ep-aw__panel">' +
        '<div class="ep-panel__head"><div class="ep-panel__title">Plant asset records</div>' +
          '<div class="ep-panel__tools">' +
            (options.plantCode ? "" : '<label class="ep-aw__search"><span class="ep-sr-only">Search plants</span>' +
              '<input type="search" data-aw-search placeholder="Search plants" autocomplete="off"></label>') +
          '</div></div>' +
        '<div class="ep-aw__table-wrap"><table class="ep-aw__table">' +
          '<thead><tr><th>Plant</th><th>Location</th><th>Inventory</th><th>Warranty</th><th><span class="ep-sr-only">Actions</span></th></tr></thead>' +
          '<tbody data-aw-rows><tr><td colspan="5" class="ep-aw__loading">Loading plant records…</td></tr></tbody>' +
        '</table></div>' +
      '</section>' +
      '<div data-aw-dialog></div>' +
    '</div>';

    var root = host.querySelector(".ep-aw");
    var rows = root.querySelector("[data-aw-rows]");
    var search = root.querySelector("[data-aw-search]");
    var plants = [];

    function renderRows() {
      var term = search ? search.value.trim().toLowerCase() : "";
      var visible = plants.filter(function (plant) {
        return !term || [
          plant.displayName, plant.plantName, plant.displayCode, plant.siteCode, plant.location
        ].some(function (value) {
          return String(value || "").toLowerCase().indexOf(term) !== -1;
        });
      });

      if (!visible.length) {
        rows.innerHTML = '<tr><td colspan="5" class="ep-aw__empty">' +
          (plants.length ? "No plants match this search." : "No plants are available in your authorized scope.") +
          '</td></tr>';
        return;
      }

      rows.innerHTML = visible.map(function (plant) {
        return '<tr>' +
          '<td><strong>' + escape(plant.displayName || plant.plantName || "Unnamed plant") +
            '</strong><span class="ep-aw__code">' + escape(plant.displayCode || plant.siteCode || "") + '</span></td>' +
          '<td>' + escape(plant.location || plant.district || "Not available") + '</td>' +
          '<td><span class="ep-aw__state">No inventory records</span></td>' +
          '<td><span class="ep-aw__state">Not configured</span></td>' +
          '<td class="ep-aw__action"><button type="button" class="ep-aw__view" data-aw-view="' +
            escape(plant.siteCode) + '">View units</button></td>' +
        '</tr>';
      }).join("");
    }

    function closeDialog() {
      var dialogHost = root.querySelector("[data-aw-dialog]");
      if (dialogHost) dialogHost.innerHTML = "";
      document.removeEventListener("keydown", onDialogKeydown);
      if (activeCloseDialog === closeDialog) activeCloseDialog = null;
    }

    function onDialogKeydown(event) {
      if (event.key === "Escape") closeDialog();
    }

    function openDialog(plant) {
      var dialogHost = root.querySelector("[data-aw-dialog]");
      var name = plant.displayName || plant.plantName || "Plant";
      dialogHost.innerHTML = '<div class="ep-aw__backdrop" data-aw-dismiss>' +
        '<section class="ep-aw__dialog" role="dialog" aria-modal="true" aria-labelledby="aw-dialog-title">' +
          '<button type="button" class="ep-aw__close" data-aw-close aria-label="Close">&times;</button>' +
          '<p class="ep-aw__eyebrow">UNIT DETAILS</p>' +
          '<h2 id="aw-dialog-title">' + escape(name) + '</h2>' +
          '<p class="ep-aw__code">' + escape(plant.displayCode || plant.siteCode || "") + '</p>' +
          '<div class="ep-aw__notice"><strong>No unit records are available</strong>' +
            '<p>Inventory has not been configured for this plant. Unit counts and warranty status cannot be shown until inventory records and warranty rules are available.</p>' +
          '</div>' +
        '</section>' +
      '</div>';
      dialogHost.querySelector(".ep-aw__close").focus();
      activeCloseDialog = closeDialog;
      document.addEventListener("keydown", onDialogKeydown);
    }

    if (search) search.addEventListener("input", renderRows);
    root.addEventListener("click", function (event) {
      // The shared Import / Export control handles its own clicks.
      if (global.Solar91RegisterIO && global.Solar91RegisterIO.handleClick(event, {
        siteCode: options.plantCode || "",
        onImported: function () { render(host, options); }
      })) return;
      var button = event.target.closest("[data-aw-view]");
      if (button) {
        var plant = plants.find(function (item) { return item.siteCode === button.getAttribute("data-aw-view"); });
        if (plant) openDialog(plant);
        return;
      }
      if (event.target.closest("[data-aw-close]") || event.target.matches(".ep-aw__backdrop")) closeDialog();
    });

    data.listPlants().then(function (result) {
      if (!Array.isArray(result)) throw new Error("Plant records could not be loaded.");
      plants = options.plantCode ?
        result.filter(function (plant) { return plant.siteCode === options.plantCode; }) : result;
      renderRows();
    }).catch(function (error) {
      rows.innerHTML = '<tr><td colspan="5" class="ep-aw__error">Unable to load plant records. Please try again.</td></tr>';
      console.error("Asset & Warranty plant records failed to load:", error);
    });
  }

  global.Solar91PortalAssetWarranty = { render: render };
}(window));
