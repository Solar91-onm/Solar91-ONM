
(function (global) {
  "use strict";

  var data = global.Solar91PortalData;

  var PLANT_SUB_PAGES = [
    { id: "details",         label: "Info & Health" },
    { id: "pm",              label: "Preventive Maintenance" },
    { id: "washing",         label: "Module Cleaning" },
    { id: "movable-assets",  label: "Movable Assets" }
  ];

  var VIEW_SUB_PAGES = [
    { id: "details",         label: "Info & Health" },
    { id: "pm",              label: "Preventive Maintenance" },
    { id: "washing",         label: "Module Cleaning" },
    { id: "movable-assets",  label: "Movable Assets" }
  ];

  var DETAIL_SECTIONS = [
    { id: "design-mdl", label: "Design/MDL" },
    { id: "liasoning", label: "Liasoning" },
    { id: "bom", label: "BOM" }
  ];

  // "*" = every page. A list = only those plant pages, and no portfolio-wide Overview
  // or Login access. Data scope (one plant for a Site Engineer) is enforced by the server.
  var ROLE_TAB_VISIBILITY = {
    "O&M Head":        "*",
    "Assignee":        "*",
    "Administration":  "*",
    "Site Engineer":   ["health", "pm", "washing", "movable-assets"],
    "Viewer":          "*"
  };

  var currentRole = null;

  // Who may open the Site Engineer and Security page. One list, used by the nav button's
  // visibility, its click handler and the route guard, so the three can never disagree again
  // (Assignee was shown the button but bounced back to the Dashboard by the guard).
  // The server enforces the same roles (SECURITY_CONTACT_ROLES / SECURITY_MOVE_ROLES).
  var SECURITY_PAGE_ROLES = ["O&M Head", "Assignee", "Administration"];
  var REQUIREMENTS_PAGE_ROLES = ["O&M Head", "Assignee", "Site Engineer"];

  function canOpenSecurity(role) {
    return SECURITY_PAGE_ROLES.indexOf(role) !== -1;
  }

  function canOpenRequirements(role) {
    return REQUIREMENTS_PAGE_ROLES.indexOf(role) !== -1;
  }

  function restrictedPages() {
    var rule = ROLE_TAB_VISIBILITY[currentRole];
    return Array.isArray(rule) ? rule : null;
  }

  function normalizePlantPage(pageId) {
    return pageId === "health" ? "details" : pageId;
  }

  function canShowPlantDetailSections() {
    var allowed = restrictedPages();
    return !allowed || allowed.indexOf("details") !== -1;
  }

  function plantPages() {
    var allowed = restrictedPages();
    return allowed ? PLANT_SUB_PAGES.filter(function (p) {
      return allowed.indexOf(p.id) !== -1 || (p.id === "details" && allowed.indexOf("health") !== -1);
    }) : PLANT_SUB_PAGES;
  }

  function isPlantPageAllowed(pageId) {
    var allowed = restrictedPages();
    pageId = normalizePlantPage(pageId);
    return !allowed || allowed.indexOf(pageId) !== -1 ||
      (pageId === "details" && allowed.indexOf("health") !== -1);
  }

  function defaultPlantPage() {
    return plantPages()[0].id;
  }

  // Current navigation state
  var navState = {
    activeView: "overview",      // "overview" | "plant-sub" | "view-sub" | "settings"
    selectedPlant: null,         // siteCode
    selectedSubPage: null,       // e.g. "details", "health"
    selectedViewPage: null,      // e.g. "details", "health"
    selectedDetailSection: "details",
    selectedRange: null,         // { startDate, endDate } when opened from Overview
    expandedGroups: {},          // { plants: true/false, views: true/false }
    expandedPlants: {},          // { siteCode: true } plants whose sub-menu is open (user's choice)
    detailsOpen: { plant: {}, view: false }   // Details sub-sections dropdown: per plant ({siteCode: true}) and for Views; closed until the user opens it
  };
  var HISTORY_KEY = "solar91PortalNavigation";
  var plantsLoaded = false;

  function navigationSnapshot() {
    return {
      version: 1,
      activeView: navState.activeView,
      selectedPlant: navState.selectedPlant,
      selectedSubPage: navState.selectedSubPage,
      selectedViewPage: navState.selectedViewPage,
      selectedDetailSection: navState.selectedDetailSection,
      selectedRange: navState.selectedRange ? {
        startDate: navState.selectedRange.startDate,
        endDate: navState.selectedRange.endDate
      } : null
    };
  }

  function writeNavigationHistory(replace) {
    var current = global.history.state;
    var next = current && typeof current === "object" ? Object.assign({}, current) : {};
    var previous = next[HISTORY_KEY];
    var snapshot = navigationSnapshot();
    if (!replace && previous && JSON.stringify(previous) === JSON.stringify(snapshot)) return;
    next[HISTORY_KEY] = snapshot;
    if (replace) global.history.replaceState(next, "");
    else global.history.pushState(next, "");
  }

  function validHistorySnapshot(snapshot) {
    if (!snapshot || snapshot.version !== 1) return null;
    var details = snapshot.selectedDetailSection || "details";
    var viewHealthSection = snapshot.activeView === "view-sub" &&
      (snapshot.selectedViewPage === "details" || snapshot.selectedViewPage === "health");
    if (details === "health" && !viewHealthSection) details = "details";
    if (details !== "details" && details !== "health" &&
        !DETAIL_SECTIONS.some(function (item) { return item.id === details; })) {
      details = "details";
    }
    if (snapshot.activeView === "overview" || snapshot.activeView === "settings" ||
        snapshot.activeView === "security" || snapshot.activeView === "requirements") {
      return {
        activeView: snapshot.activeView,
        selectedPlant: null,
        selectedSubPage: null,
        selectedViewPage: null,
        selectedDetailSection: "details",
        selectedRange: null
      };
    }
    var viewPage = snapshot.selectedViewPage === "health" ? "details" : snapshot.selectedViewPage;
    if (snapshot.activeView === "view-sub" &&
        (VIEW_SUB_PAGES.some(function (item) { return item.id === viewPage; }) ||
          snapshot.selectedViewPage === "health")) {
      return {
        activeView: "view-sub",
        selectedPlant: null,
        selectedSubPage: null,
        selectedViewPage: viewPage,
        selectedDetailSection: snapshot.selectedViewPage === "health"
          ? "health" : viewPage === "details" ? details : "details",
        selectedRange: snapshot.selectedRange &&
          typeof snapshot.selectedRange.startDate === "string" &&
          typeof snapshot.selectedRange.endDate === "string"
          ? { startDate: snapshot.selectedRange.startDate, endDate: snapshot.selectedRange.endDate }
          : null
      };
    }
    var plantSubPage = normalizePlantPage(snapshot.selectedSubPage);
    if (snapshot.activeView === "plant-sub" && typeof snapshot.selectedPlant === "string" &&
        snapshot.selectedPlant && PLANT_SUB_PAGES.some(function (item) { return item.id === plantSubPage; })) {
      return {
        activeView: "plant-sub",
        selectedPlant: snapshot.selectedPlant,
        selectedSubPage: plantSubPage,
        selectedViewPage: null,
        selectedDetailSection: plantSubPage === "details" ? details : "details",
        selectedRange: snapshot.selectedRange &&
          typeof snapshot.selectedRange.startDate === "string" &&
          typeof snapshot.selectedRange.endDate === "string"
          ? { startDate: snapshot.selectedRange.startDate, endDate: snapshot.selectedRange.endDate }
          : null
      };
    }
    return null;
  }

  function setNavigationState(snapshot) {
    navState.activeView = snapshot.activeView;
    navState.selectedPlant = snapshot.selectedPlant;
    navState.selectedSubPage = snapshot.selectedSubPage;
    navState.selectedViewPage = snapshot.selectedViewPage;
    navState.selectedDetailSection = snapshot.selectedDetailSection;
    navState.selectedRange = snapshot.selectedRange;
    if (snapshot.activeView === "plant-sub") {
      navState.expandedPlants[snapshot.selectedPlant] = true;
      navState.detailsOpen.plant[snapshot.selectedPlant] = snapshot.selectedDetailSection !== "details";
      setGroupExpanded("plants", true);
    } else if (snapshot.activeView === "view-sub") {
      navState.detailsOpen.view = snapshot.selectedDetailSection !== "details" &&
        snapshot.selectedDetailSection !== "health";
      setGroupExpanded("views", true);
    }
  }

  function setOverviewState() {
    navState.activeView = "overview";
    navState.selectedPlant = null;
    navState.selectedSubPage = null;
    navState.selectedViewPage = null;
    navState.selectedDetailSection = "details";
    navState.selectedRange = null;
  }

  function restoreNavigationHistory(state) {
    var snapshot = state && typeof state === "object"
      ? validHistorySnapshot(state[HISTORY_KEY]) : null;
    if (snapshot && (!plantsLoaded || snapshot.activeView !== "plant-sub" ||
        allPlants.some(function (plant) { return plant.siteCode === snapshot.selectedPlant; }))) {
      setNavigationState(snapshot);
    } else {
      setOverviewState();
    }
    renderPlantList(document.querySelector("[data-plant-search]")?.value || "");
    updateContentArea();
    updateHighlights();
    writeNavigationHistory(true);
  }

  var CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';

  function isDetailsOpen(kind, code) {
    return kind === "plant" ? !!navState.detailsOpen.plant[code] : !!navState.detailsOpen.view;
  }

  function detailsToggleHTML(kind, code) {
    var open = isDetailsOpen(kind, code);
    return '<button class="ep-nav-chevron ep-nav-details-toggle' + (open ? ' is-open' : '') + '" type="button" data-details-toggle="' + kind + '" data-details-plant="' + (code || "") +
      '" aria-expanded="' + open + '" aria-label="Show or hide ' + (kind === "view" ? "Info" : "Details") +
      ' sections" title="Show or hide sections">' + CHEVRON_SVG + '</button>';
  }

  function setDetailsOpen(kind, open, code) {
    if (kind === "plant") navState.detailsOpen.plant[code] = open; else navState.detailsOpen.view = open;
    document.querySelectorAll('[data-details-toggle="' + kind + '"]').forEach(function (btn) {
      if (kind === "plant" && btn.getAttribute("data-details-plant") !== code) return;
      btn.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", String(open));
      var sub = btn.closest(".ep-nav-details-row");
      sub = sub && sub.nextElementSibling;
      if (sub && sub.classList.contains("ep-nav-detail-sub")) sub.classList.toggle("is-open", open);
    });
  }

  var allPlants = [];            // populated from catalog
  // Plants with an open inverter problem, keyed by site code: { open, down }. Filled by
  // overview.js from the equipment summary it already reads, so the sidebar costs no request
  // of its own. A plant with no entry simply shows no light.
  var plantAlerts = {};

  // ─── Group expand / collapse ────────────────────────────────────────
  function toggleGroup(groupName) {
    navState.expandedGroups[groupName] = !navState.expandedGroups[groupName];
    var groupEl = document.querySelector('[data-nav-group="' + groupName + '"]');
    if (groupEl) groupEl.classList.toggle("is-expanded", navState.expandedGroups[groupName]);
  }

  function setGroupExpanded(groupName, expanded) {
    navState.expandedGroups[groupName] = expanded;
    var groupEl = document.querySelector('[data-nav-group="' + groupName + '"]');
    if (groupEl) groupEl.classList.toggle("is-expanded", expanded);
  }

  // ─── Plant list population ──────────────────────────────────────────
  function populatePlantList(plants) {
    allPlants = plants;
    renderPlantList("");
  }

  /**
   * The blinking red light beside a plant whose inverters need attention. It sits just before
   * the site-code chip, and its title says what it is so the dot is never the only signal.
   */
  function plantAlertHTML(siteCode) {
    var alert = plantAlerts[siteCode];
    if (!alert) return "";
    var parts = [];
    if (alert.down > 0) {
      parts.push(alert.down + (alert.down === 1 ? " inverter not running" : " inverters not running"));
    }
    if (alert.open > 0) {
      parts.push(alert.open + (alert.open === 1 ? " open inverter ticket" : " open inverter tickets"));
    }
    var label = parts.join(" · ");
    return '<span class="ep-hint-light ep-hint-light--red ep-nav-plant__alert" role="img"' +
      ' data-plant-alert="' + (alert.down > 0 ? "down" : "open") + '"' +
      ' title="' + global.Solar91PortalFormat.escape(label) + '"' +
      ' aria-label="' + global.Solar91PortalFormat.escape(label) + '"></span>';
  }

  /**
   * Record which plants have an inverter problem and repaint the list.
   * `alerts` is { siteCode: { open, down } }; anything falsy clears every light.
   */
  function setPlantAlerts(alerts) {
    plantAlerts = alerts || {};
    renderPlantList(document.querySelector("[data-plant-search]")?.value || "");
  }

  function renderPlantList(searchTerm) {
    var container = document.querySelector("[data-plant-nav-list]");
    if (!container) return;

    var term = (searchTerm || "").trim().toLowerCase();
    var filtered = allPlants.filter(function (p) {
      if (!term) return true;
      return (p.displayName || p.plantName).toLowerCase().indexOf(term) !== -1 ||
             p.displayCode.toLowerCase().indexOf(term) !== -1 ||
             p.siteCode.toLowerCase().indexOf(term) !== -1;
    });

    var fmt = global.Solar91PortalFormat;
    container.innerHTML = filtered.map(function (plant) {
      var isSelected = navState.selectedPlant === plant.siteCode;
      var isOpen = !!navState.expandedPlants[plant.siteCode];
      return '<div class="ep-nav-plant' + (isSelected ? ' is-selected' : '') + (isOpen ? ' is-open' : '') + '" data-plant-code="' + plant.siteCode + '">' +
        '<div class="ep-nav-plant__row">' +
          '<button class="ep-nav-plant__toggle" type="button">' +
            '<span class="ep-nav-plant__name">' + fmt.escape(plant.displayName || plant.plantName) + '</span>' +
            plantAlertHTML(plant.siteCode) +
            '<span class="ep-nav-plant__code">' + fmt.escape(plant.displayCode) + '</span>' +
          '</button>' +
          '<button class="ep-nav-chevron ep-nav-plant__chevron' + (isOpen ? ' is-open' : '') + '" type="button" data-plant-chevron ' +
            'aria-expanded="' + isOpen + '" aria-label="Show or hide pages of ' + fmt.escape(plant.displayName || plant.plantName) +
            '" title="Show or hide pages">' + CHEVRON_SVG + '</button>' +
        '</div>' +
        (isOpen ? renderPlantSubNav(plant.siteCode) : '') +
      '</div>';
    }).join("");

    if (filtered.length === 0) {
      container.innerHTML = '<div class="ep-nav-group__empty">No plants match this search.</div>';
    }
  }

  function renderPlantSubNav(siteCode) {
    return '<div class="ep-nav-plant__sub">' +
      plantPages().map(function (page) {
        var navId = "plant:" + siteCode + ":" + page.id;
        var isActive = navState.activeView === "plant-sub" &&
                       navState.selectedPlant === siteCode &&
                       navState.selectedSubPage === page.id &&
                       (page.id !== "details" || navState.selectedDetailSection === "details");
        var item = '<button class="ep-nav-item ep-nav-item--sub' + (isActive ? ' is-active' : '') + '" type="button" data-nav="' + navId + '">' +
          '<span class="ep-nav-item__label">' + page.label + '</span>' +
        '</button>';
        if (page.id === "details" && canShowPlantDetailSections()) {
          item = '<div class="ep-nav-details-row">' + item + detailsToggleHTML("plant", siteCode) + '</div>';
          item += '<div class="ep-nav-detail-sub' + (isDetailsOpen('plant', siteCode) ? ' is-open' : '') + '">' + DETAIL_SECTIONS.map(function (section) {
            var sectionActive = navState.activeView === "plant-sub" &&
              navState.selectedPlant === siteCode &&
              navState.selectedSubPage === "details" &&
              navState.selectedDetailSection === section.id;
            return '<button class="ep-nav-item ep-nav-item--sub ep-nav-item--detail' +
              (sectionActive ? ' is-active' : '') + '" type="button" data-nav="' +
              navId + ":" + section.id + '">' +
              '<span class="ep-nav-item__label">' + section.label + '</span></button>';
          }).join("") + '</div>';
        } else if (page.id === "details") {
          item = '<div class="ep-nav-details-row">' + item + '</div>';
        }
        return item;
      }).join("") +
    '</div>';
  }

  // ─── Plant selection ────────────────────────────────────────────────
  function selectPlant(siteCode) {
    var plant = allPlants.find(function (p) { return p.siteCode === siteCode; });
    if (!plant) return;

    navState.selectedRange = null;
    navState.selectedPlant = siteCode;
    navState.expandedPlants[siteCode] = true;
    navState.selectedSubPage = defaultPlantPage();
    navState.selectedDetailSection = "details";
    navState.activeView = "plant-sub";
    navState.selectedViewPage = null;

    writeNavigationHistory(false);
    setGroupExpanded("plants", true);
    renderPlantList(document.querySelector("[data-plant-search]")?.value || "");
    updateContentArea();
    updateHighlights();
  }

  // ─── View selection ─────────────────────────────────────────────────
  function selectView(pageId, dateRange, detailSection) {
    if (restrictedPages()) {
      // No portfolio-wide Overview for this role: open the same page for their own plant instead.
      if (allPlants.length === 1 && isPlantPageAllowed(pageId)) {
        selectPlantPage(allPlants[0].siteCode, pageId, dateRange);
      } else {
        activateOverview();
      }
      return;
    }
    if (pageId === "health") {
      pageId = "details";
      detailSection = "health";
    }
    navState.activeView = "view-sub";
    navState.selectedViewPage = pageId;
    navState.selectedDetailSection = pageId === "details" &&
      (detailSection === "health" || DETAIL_SECTIONS.some(function (item) { return item.id === detailSection; }))
      ? detailSection : "details";
    navState.selectedPlant = null;
    navState.selectedSubPage = null;
    navState.selectedRange = dateRange || null;

    writeNavigationHistory(false);
    renderPlantList(document.querySelector("[data-plant-search]")?.value || "");
    updateContentArea();
    updateHighlights();
  }

  /** Open a plant's sub-page (details, health, pm, washing) programmatically. */
  function selectPlantPage(siteCode, pageId, dateRange, plantRecord) {
    pageId = normalizePlantPage(pageId);
    var plant = allPlants.find(function (p) { return p.siteCode === siteCode; }) ||
      (plantRecord && plantRecord.siteCode === siteCode ? plantRecord : null);
    if (!plant) return;
    if (!allPlants.some(function (item) { return item.siteCode === siteCode; })) {
      allPlants.push(plant);
    }
    var page = plantPages().find(function (s) { return s.id === pageId; });
    navState.selectedPlant = siteCode;
    navState.expandedPlants[siteCode] = true;
    navState.selectedSubPage = page ? page.id : defaultPlantPage();
    navState.selectedDetailSection = "details";
    navState.activeView = "plant-sub";
    navState.selectedViewPage = null;
    navState.selectedRange = dateRange || null;
    setGroupExpanded("plants", true);
    writeNavigationHistory(false);
    renderPlantList(document.querySelector("[data-plant-search]")?.value || "");
    updateContentArea();
    updateHighlights();
  }

  /** Re-render whatever page is showing (after a save). */
  function refresh() {
    updateContentArea();
  }

  // ─── Activate Overview ──────────────────────────────────────────────
  function activateOverview() {
    setOverviewState();

    writeNavigationHistory(false);
    renderPlantList(document.querySelector("[data-plant-search]")?.value || "");
    updateContentArea();
    updateHighlights();

    document.dispatchEvent(new CustomEvent("portal:tab-activated", { detail: { tabId: "overview" } }));
  }

  // ─── Content area routing ───────────────────────────────────────────

  /**
   * The page scripts this nav state needs. Only the Overview and the shell ship with the page;
   * everything else is fetched the first time its page is opened (assets/js/modules.js).
   *
   * This mirrors the dispatch in renderContentArea below — the two must name the same module for
   * the same state, so they are kept next to each other.
   */
  function modulesForState() {
    if (navState.activeView === "overview") return [];
    if (navState.activeView === "requirements") return ["requirements"];
    if (navState.activeView === "security") return ["security"];
    if (navState.activeView === "settings") return ["settings"];

    if (navState.activeView === "plant-sub") {
      navState.selectedSubPage = normalizePlantPage(navState.selectedSubPage);
    }
    var plantCode = navState.activeView === "plant-sub" ? navState.selectedPlant : null;
    var pageId = navState.activeView === "plant-sub" ? navState.selectedSubPage
      : navState.activeView === "view-sub" ? navState.selectedViewPage : null;
    if (!pageId) return [];

    if (pageId === "washing") return plantCode ? ["operations-calendar"] : ["washing-board"];
    if (pageId === "pm") return ["operations-calendar"];
    if (pageId === "health") return ["site-issues"];
    if (pageId === "movable-assets") return ["movable-assets"];
    if (pageId === "details") {
      var section = navState.selectedDetailSection;
      if (!plantCode && section === "health") return ["site-issues"];
      // The Details page hands Design/MDL, Liasoning and BOM to their own modules.
      if (section === "design-mdl") return ["plants-table", "design"];
      if (section === "liasoning") return ["plants-table", "liasoning"];
      if (section === "bom") return ["plants-table", "bom"];
      return plantCode ? ["plants-table", "site-issues"] : ["plants-table"];
    }
    return [];
  }

  /** Where the page being opened draws itself, so a skeleton can stand in while its script loads. */
  function hostForState() {
    if (navState.activeView === "requirements") return document.querySelector("[data-requirements-host]");
    if (navState.activeView === "security") return document.querySelector("[data-security-host]");
    if (navState.activeView === "settings") return document.querySelector("[data-settings-host]");
    var plantCode = navState.activeView === "plant-sub" ? navState.selectedPlant : null;
    var pageId = navState.activeView === "plant-sub" ? navState.selectedSubPage
      : navState.activeView === "view-sub" ? navState.selectedViewPage : null;
    if (pageId === "washing" && !plantCode) return document.querySelector("[data-washing-board-host]");
    if (pageId === "washing" || pageId === "pm") return document.querySelector("[data-calendar-host]");
    if (pageId === "health") return document.querySelector("[data-issues-host]");
    if (pageId === "details" && !plantCode && navState.selectedDetailSection === "health") {
      return document.querySelector("[data-issues-host]");
    }
    if (pageId === "movable-assets") return document.querySelector("[data-movable-assets-host]");
    if (pageId === "details") {
      return document.querySelector(plantCode ? "[data-plant-details-host]" : "[data-plants-table-host]");
    }
    return null;
  }

  var SKELETON = '<div class="ep-skeleton" role="status" aria-live="polite">' +
    '<span class="ep-sr-only">Loading this page…</span>' +
    '<div class="ep-skeleton__bar ep-skeleton__bar--title"></div>' +
    '<div class="ep-skeleton__bar ep-skeleton__bar--sub"></div>' +
    '<div class="ep-skeleton__block"></div></div>';

  // With the opt-in monitor on (perf.js), each page switch's synchronous render time is recorded by page.
  function timedRender() {
    var perf = global.Solar91Perf;
    if (!perf || !perf.enabled) return renderContentArea();
    var page = navState.activeView === "plant-sub" ? "plant " + navState.selectedSubPage
      : navState.activeView === "view-sub" ? "view " + navState.selectedViewPage : navState.activeView;
    if ((page === "plant details" || page === "view details") && navState.selectedDetailSection !== "details") {
      page += ":" + navState.selectedDetailSection;
    }
    return perf.time("navigate " + page, renderContentArea);
  }

  /**
   * Open the page the nav state names, loading its script first if this is the first visit.
   *
   * A page already loaded renders in the same tick as before. A first visit shows the page's
   * frame and a skeleton immediately, then renders; if the script cannot be fetched the page says
   * so and offers a retry rather than staying blank.
   */
  function updateContentArea() {
    enforceRolePages();
    var needed = modulesForState();
    if (!global.Solar91Modules || !needed.length || needed.every(global.Solar91Modules.isLoaded)) {
      return timedRender();
    }
    var token = ++navToken;
    var host = hostForState();
    if (host && !host.childElementCount) host.innerHTML = SKELETON;
    renderContentArea();                       // the page frame and title appear at once
    if (host) host.innerHTML = SKELETON;
    return global.Solar91Modules.load(needed).then(function () {
      if (token !== navToken) return;          // the user moved on while this was loading
      timedRender();
    }).catch(function (error) {
      if (token !== navToken || !host) return;
      host.innerHTML = '<div class="ep-pt__error">' +
        (error && error.message ? error.message : "This page could not be loaded.") +
        ' <button type="button" data-nav-retry>Try again</button></div>';
    });
  }

  var navToken = 0;

  document.addEventListener("click", function (event) {
    if (event.target.closest("[data-nav-retry]")) updateContentArea();
  });

  // Last guard for restricted roles, whatever path changed navState.
  function enforceRolePages() {
    if (navState.activeView === "security" && !canOpenSecurity(currentRole)) {
      navState.activeView = "overview";
    }
    if (navState.activeView === "requirements") {
      if (!canOpenRequirements(currentRole)) setOverviewState();
      return;
    }
    if (navState.activeView === "plant-sub") {
      navState.selectedSubPage = normalizePlantPage(navState.selectedSubPage);
    }
    if (!restrictedPages()) return;
    if (navState.activeView === "view-sub" || navState.activeView === "settings" ||
        navState.activeView === "security") {
      navState.activeView = "overview";
      navState.selectedViewPage = null;
    }
    if (navState.activeView === "plant-sub" && !isPlantPageAllowed(navState.selectedSubPage)) {
      navState.selectedSubPage = defaultPlantPage();
      navState.selectedDetailSection = "details";
    }
    if (navState.activeView === "plant-sub") {
      if (navState.selectedSubPage === "details" && !canShowPlantDetailSections()) {
        navState.selectedDetailSection = "details";
      }
    }
  }

  function renderContentArea() {
    enforceRolePages();
    var shell = document.querySelector(".ep-shell");
    if (shell) shell.classList.toggle("is-login-access", navState.activeView === "settings");
    var overviewEl = document.querySelector('[data-tab-view="overview"]');
    var infoHealthEl = document.querySelector('[data-tab-view="info-health"]');
    var calendarEl = document.querySelector('[data-tab-view="calendar"]');
    var washingBoardEl = document.querySelector('[data-tab-view="washing-board"]');
    var movableAssetsEl = document.querySelector('[data-tab-view="movable-assets"]');
    var detailsEl = document.querySelector('[data-tab-view="plant-details"]');
    var requirementsEl = document.querySelector('[data-tab-view="requirements"]');
    var securityEl = document.querySelector('[data-tab-view="security"]');
    var settingsEl = document.querySelector('[data-tab-view="settings"]');
    var placeholderEl = document.querySelector('[data-tab-view="placeholder"]');
    var titleEl = document.querySelector("[data-topbar-title]");
    var phTitle = document.querySelector("[data-placeholder-title]");
    var phSubtitle = document.querySelector("[data-placeholder-subtitle]");
    var phContext = document.querySelector("[data-placeholder-context]");
    var viewSectionTabs = document.querySelector("[data-view-section-tabs]");
    var viewInfoPanel = document.querySelector('[data-view-section-panel="info"]');
    var viewHealthPanel = document.querySelector('[data-view-section-panel="health"]');

    function showOnly(el) {
      [overviewEl, infoHealthEl, calendarEl, washingBoardEl, movableAssetsEl, detailsEl, requirementsEl, securityEl, settingsEl, placeholderEl].forEach(function (section) {
        if (section) section.classList.toggle("is-visible", section === el);
      });
      document.dispatchEvent(new CustomEvent("portal:route-changed"));
    }

    function showViewInfoHealthSection(showTabs, isHealth) {
      if (viewSectionTabs) viewSectionTabs.hidden = !showTabs;
      if (viewInfoPanel) viewInfoPanel.hidden = !!isHealth;
      if (viewHealthPanel) viewHealthPanel.hidden = !isHealth;
      document.querySelectorAll("[data-view-section]").forEach(function (button) {
        var selected = button.getAttribute("data-view-section") === (isHealth ? "health" : "info");
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
      });
    }

    if (navState.activeView === "overview") {
      showOnly(overviewEl);
      if (titleEl) titleEl.textContent = "Dashboard";
      try { sessionStorage.setItem("solar91Portal.navState", JSON.stringify(navState)); } catch (_) {}
      return;
    }
    if (navState.activeView === "settings") {
      showOnly(settingsEl);
      if (titleEl) titleEl.textContent = "Login access";
      navState.selectedRange = null;
      if (global.Solar91PortalSettings) {
        global.Solar91PortalSettings.render(document.querySelector("[data-settings-host]"));
      }
      try { sessionStorage.setItem("solar91Portal.navState", JSON.stringify(navState)); } catch (_) {}
      return;
    }
    if (navState.activeView === "requirements") {
      showOnly(requirementsEl);
      if (titleEl) titleEl.textContent = "Requirements";
      if (global.Solar91PortalRequirements) {
        global.Solar91PortalRequirements.show(document.querySelector("[data-requirements-host]"));
      }
      try { sessionStorage.setItem("solar91Portal.navState", JSON.stringify(navState)); } catch (_) {}
      return;
    }
    if (navState.activeView === "security") {
      showOnly(securityEl);
      if (titleEl) titleEl.textContent = "Site Engineer and Security";
      if (global.Solar91PortalSecurity) {
        global.Solar91PortalSecurity.show(document.querySelector("[data-security-host]"));
      }
      try { sessionStorage.setItem("solar91Portal.navState", JSON.stringify(navState)); } catch (_) {}
      return;
    }

    var pageLabel = "";
    var contextText = "";
    var isDetails = false;
    var calendarType = null;
    var plantCode = null;
    var pageId = null;

    if (navState.activeView === "plant-sub" && navState.selectedPlant) {
      var plant = allPlants.find(function (p) { return p.siteCode === navState.selectedPlant; });
      var subPage = PLANT_SUB_PAGES.find(function (s) { return s.id === navState.selectedSubPage; });
      pageLabel = subPage ? subPage.label : "Details";
      if (navState.selectedSubPage === "details" && navState.selectedDetailSection !== "details") {
        var plantDetailSection = DETAIL_SECTIONS.find(function (section) {
          return section.id === navState.selectedDetailSection;
        });
        if (plantDetailSection) pageLabel = plantDetailSection.label;
      }
      pageId = navState.selectedSubPage;
      contextText = plant ? (plant.displayName || plant.plantName) + " · " + plant.displayCode : "";
      isDetails = navState.selectedSubPage === "details";
      if (navState.selectedSubPage === "pm" || navState.selectedSubPage === "washing") {
        calendarType = navState.selectedSubPage;
      }
      plantCode = navState.selectedPlant;
    } else if (navState.activeView === "view-sub") {
      var viewPage = VIEW_SUB_PAGES.find(function (s) { return s.id === navState.selectedViewPage; });
      pageLabel = viewPage ? viewPage.label : "Details";
      if (navState.selectedViewPage === "details" && navState.selectedDetailSection !== "details") {
        var viewDetailSection = DETAIL_SECTIONS.find(function (section) {
          return section.id === navState.selectedDetailSection;
        });
        if (viewDetailSection) pageLabel = viewDetailSection.label;
      }
      pageId = navState.selectedViewPage;
      contextText = "Portfolio-wide View";
      isDetails = navState.selectedViewPage === "details";
      if (navState.selectedViewPage === "pm" || navState.selectedViewPage === "washing") {
        calendarType = navState.selectedViewPage;
      }
    }

    if (titleEl) titleEl.textContent = pageLabel;

    // Module Cleaning portfolio-wide is the board of plant cards: the calendar is
    // per plant, and a card on the board is how you reach it.
    if (calendarType === "washing" && !plantCode && global.Solar91PortalWashingBoard) {
      showOnly(washingBoardEl);
      global.Solar91PortalWashingBoard.show(document.querySelector("[data-washing-board-host]"));
      try { sessionStorage.setItem("solar91Portal.navState", JSON.stringify(navState)); } catch (_) {}
      return;
    }

    if (calendarType && global.Solar91PortalCalendar) {
      showOnly(calendarEl);
      global.Solar91PortalCalendar.render(
        document.querySelector("[data-calendar-host]"),
        {
          type: calendarType,
          plantCode: plantCode,
          startDate: navState.selectedRange && navState.selectedRange.startDate,
          endDate: navState.selectedRange && navState.selectedRange.endDate
        }
      );
    } else if (isDetails) {
      // Details is one table of stored plant fields: this plant's single row
      // when a plant is selected, every plant's row portfolio-wide.
      var viewHealth = !plantCode && navState.activeView === "view-sub" &&
        navState.selectedDetailSection === "health";
      var viewSectionPicker = !plantCode && navState.activeView === "view-sub" &&
        (navState.selectedDetailSection === "details" || viewHealth);
      showOnly(plantCode ? detailsEl : infoHealthEl);
      showViewInfoHealthSection(viewSectionPicker, viewHealth);
      if (viewHealth && global.Solar91PortalIssues) {
        global.Solar91PortalIssues.render(
          document.querySelector("[data-issues-host]"),
          {
            plantCode: null,
            startDate: navState.selectedRange && navState.selectedRange.startDate,
            endDate: navState.selectedRange && navState.selectedRange.endDate
          }
        );
      } else if (!viewHealth && global.Solar91PortalPlantsTable) {
        global.Solar91PortalPlantsTable.show(
          document.querySelector(plantCode ? "[data-plant-details-host]" : "[data-plants-table-host]"),
          {
            siteCode: plantCode,
            section: navState.selectedDetailSection,
            merged: !!plantCode && navState.selectedDetailSection === "details"
          }
        );
      }
      if (plantCode && navState.selectedDetailSection === "details" && global.Solar91PortalIssues) {
        global.Solar91PortalIssues.render(
          document.querySelector("[data-plant-issues-host]"),
          {
            plantCode: plantCode,
            startDate: navState.selectedRange && navState.selectedRange.startDate,
            endDate: navState.selectedRange && navState.selectedRange.endDate,
            plantDetailsMerged: true
          }
        );
      } else if (plantCode) {
        var plantIssuesHost = document.querySelector("[data-plant-issues-host]");
        if (plantIssuesHost) plantIssuesHost.innerHTML = "";
      }
    } else if (pageId === "health" && global.Solar91PortalIssues) {
      showOnly(infoHealthEl);
      showViewInfoHealthSection(true, true);
      global.Solar91PortalIssues.render(
        document.querySelector("[data-issues-host]"),
        {
          plantCode: plantCode,
          startDate: navState.selectedRange && navState.selectedRange.startDate,
          endDate: navState.selectedRange && navState.selectedRange.endDate
        }
      );
    } else if (pageId === "movable-assets" && global.Solar91PortalMovableAssets) {
      showOnly(movableAssetsEl);
      global.Solar91PortalMovableAssets.show(
        document.querySelector("[data-movable-assets-host]"),
        { siteCode: plantCode }
      );
    } else if (calendarType) {
      showOnly(calendarEl);                      // script still loading; the skeleton is already there
    } else if (isDetails) {
      showOnly(plantCode ? detailsEl : infoHealthEl);
    } else if (pageId === "health") {
      showOnly(infoHealthEl);
      showViewInfoHealthSection(true, true);
    } else if (pageId === "movable-assets") {
      showOnly(movableAssetsEl);
    } else {
      showOnly(placeholderEl);
      if (phTitle) phTitle.textContent = pageLabel;
      if (phSubtitle) phSubtitle.textContent = "Page configuration will be added in a future phase.";
      if (phContext) phContext.textContent = contextText;
    }

    try { sessionStorage.setItem("solar91Portal.navState", JSON.stringify(navState)); } catch (_) {}
  }

  // ─── Highlight the active nav item ──────────────────────────────────
  function updateHighlights() {
    // Overview button
    var overviewBtn = document.querySelector('[data-nav="overview"]');
    if (overviewBtn) overviewBtn.classList.toggle("is-active", navState.activeView === "overview");

    // All sub nav items
    document.querySelectorAll("[data-nav]").forEach(function (btn) {
      var nav = btn.getAttribute("data-nav");
      if (nav === "overview") return; // handled above
      if (nav === "settings") {
        btn.classList.toggle("is-active", navState.activeView === "settings");
        return;
      }
      if (nav === "security") {
        btn.classList.toggle("is-active", navState.activeView === "security");
        return;
      }
      if (nav === "requirements") {
        btn.classList.toggle("is-active", navState.activeView === "requirements");
        return;
      }
      if (nav.indexOf("plant:") === 0) return; // rendered with the selected plant sub-navigation

      var isActive = false;
      if (nav.indexOf("view:") === 0) {
        var viewParts = nav.substring(5).split(":");
        isActive = navState.activeView === "view-sub" &&
          navState.selectedViewPage === viewParts[0] &&
          (viewParts[0] !== "details" ||
            (viewParts.length === 1 &&
              (navState.selectedDetailSection === "details" || navState.selectedDetailSection === "health")) ||
            (viewParts.length === 2 && navState.selectedDetailSection === viewParts[1]));
      }
      // plant sub-items are handled in renderPlantSubNav
      btn.classList.toggle("is-active", isActive);
    });

    // Plants group header highlight when a plant sub-page is active
    var plantsToggle = document.querySelector('[data-nav-group="plants"] .ep-nav-group__toggle');
    if (plantsToggle) plantsToggle.classList.toggle("has-active-child", navState.activeView === "plant-sub");

    // Overview group header highlight
    var viewsToggle = document.querySelector('[data-nav-group="views"] .ep-nav-group__toggle');
    if (viewsToggle) viewsToggle.classList.toggle("has-active-child", navState.activeView === "view-sub");
  }

  // ─── Role visibility (Phase 1 compat) ──────────────────────────────
  function applyRoleVisibility(role) {
    currentRole = role || null;
    var restricted = !!restrictedPages();
    var views = document.querySelector('[data-nav-group="views"]');
    if (views) views.hidden = restricted;
    var settings = document.querySelector(".ep-sidebar__settings");
    if (settings) settings.hidden = restricted;
    var security = document.querySelector('[data-nav="security"]');
    if (security) security.hidden = !canOpenSecurity(role);
    var requirements = document.querySelector('[data-nav="requirements"]');
    if (requirements) requirements.hidden = !canOpenRequirements(role);
    if (navState.activeView === "security" && security && security.hidden) {
      setOverviewState();
    }
    if (navState.activeView === "requirements" && requirements && requirements.hidden) {
      setOverviewState();
    }
    renderPlantList(document.querySelector("[data-plant-search]")?.value || "");
    updateContentArea();
    updateHighlights();
    writeNavigationHistory(true);
  }

  // ─── Wire all interactions ──────────────────────────────────────────
  function wire() {
    // Overview button
    var overviewBtn = document.querySelector('[data-nav="overview"]');
    if (overviewBtn) overviewBtn.addEventListener("click", activateOverview);
    var settingsBtn = document.querySelector('[data-nav="settings"]');
    if (settingsBtn) settingsBtn.addEventListener("click", function () {
      navState.activeView = "settings";
      navState.selectedPlant = null;
      navState.selectedSubPage = null;
      navState.selectedViewPage = null;
      navState.selectedRange = null;
      writeNavigationHistory(false);
      renderPlantList(document.querySelector("[data-plant-search]")?.value || "");
      updateContentArea();
      updateHighlights();
    });
    var requirementsBtn = document.querySelector('[data-nav="requirements"]');
    if (requirementsBtn) requirementsBtn.addEventListener("click", function () {
      if (!canOpenRequirements(currentRole)) return;
      navState.activeView = "requirements";
      navState.selectedPlant = null;
      navState.selectedSubPage = null;
      navState.selectedViewPage = null;
      navState.selectedRange = null;
      writeNavigationHistory(false);
      renderPlantList(document.querySelector("[data-plant-search]")?.value || "");
      updateContentArea();
      updateHighlights();
    });
    var securityBtn = document.querySelector('[data-nav="security"]');
    if (securityBtn) securityBtn.addEventListener("click", function () {
      if (!canOpenSecurity(currentRole)) return;
      navState.activeView = "security";
      navState.selectedPlant = null;
      navState.selectedSubPage = null;
      navState.selectedViewPage = null;
      navState.selectedRange = null;
      writeNavigationHistory(false);
      renderPlantList(document.querySelector("[data-plant-search]")?.value || "");
      updateContentArea();
      updateHighlights();
    });

    // Group toggles
    document.querySelectorAll(".ep-nav-group__toggle").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var group = btn.closest("[data-nav-group]");
        if (group) toggleGroup(group.getAttribute("data-nav-group"));
      });
    });

    document.querySelectorAll("[data-view-section]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (navState.activeView !== "view-sub" || navState.selectedViewPage !== "details") return;
        selectView("details", navState.selectedRange, button.getAttribute("data-view-section"));
      });
    });

    // Plant search
    var searchInput = document.querySelector("[data-plant-search]");
    if (searchInput) {
      searchInput.addEventListener("input", function () {
        renderPlantList(searchInput.value);
      });
    }

    // Delegated click for plant items and sub-nav
    var plantList = document.querySelector("[data-plant-nav-list]");
    if (plantList) {
      plantList.addEventListener("click", function (ev) {
        var pChevron = ev.target.closest("[data-plant-chevron]");
        if (pChevron) {
          var pEl = pChevron.closest("[data-plant-code]");
          if (pEl) {
            var pCode = pEl.getAttribute("data-plant-code");
            navState.expandedPlants[pCode] = !navState.expandedPlants[pCode];
            renderPlantList(searchInput ? searchInput.value : "");
          }
          return;
        }
        var dToggle = ev.target.closest("[data-details-toggle]");
        if (dToggle) {
          var dCode = dToggle.getAttribute("data-details-plant");
          setDetailsOpen("plant", !isDetailsOpen("plant", dCode), dCode);
          return;
        }
        // Sub-nav item click
        var subBtn = ev.target.closest("[data-nav]");
        if (subBtn) {
          var nav = subBtn.getAttribute("data-nav");
          var parts = nav.split(":");
          if (parts[0] === "plant" && (parts.length === 3 || parts.length === 4)) {
            navState.selectedRange = null;
            navState.selectedPlant = parts[1];
            navState.expandedPlants[parts[1]] = true;
            navState.selectedSubPage = normalizePlantPage(parts[2]);
            navState.selectedDetailSection = parts[2] === "details" && parts[3]
              ? parts[3] : "details";
            if (parts[2] === "details" && parts[3]) navState.detailsOpen.plant[parts[1]] = true;   // keep the chosen section visible
            navState.activeView = "plant-sub";
            navState.selectedViewPage = null;
            writeNavigationHistory(false);
            renderPlantList(searchInput ? searchInput.value : "");
            updateContentArea();
            updateHighlights();
            return;
          }
        }

        // Plant toggle click
        var plantToggle = ev.target.closest(".ep-nav-plant__toggle");
        if (plantToggle) {
          var plantEl = plantToggle.closest("[data-plant-code]");
          if (plantEl) {
            var code = plantEl.getAttribute("data-plant-code");
            if (navState.selectedPlant === code) {
              // Clicking same plant again — deselect and close its menu
              navState.expandedPlants[code] = false;
              navState.selectedPlant = null;
              navState.selectedSubPage = null;
              if (navState.activeView === "plant-sub") {
                setOverviewState();
                writeNavigationHistory(false);
                updateContentArea();
              }
              renderPlantList(searchInput ? searchInput.value : "");
              updateHighlights();
            } else {
              selectPlant(code);
            }
          }
        }
      });
    }

    // Overview > Details dropdown arrow (markup in index.html)
    var viewsToggle = document.querySelector('[data-details-toggle="view"]');
    if (viewsToggle) viewsToggle.addEventListener("click", function (ev) {
      ev.stopPropagation();
      setDetailsOpen("view", !isDetailsOpen("view"));
    });

    // Overview sub-nav items (static in HTML)
    document.querySelectorAll('[data-nav-group="views"] [data-nav]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        var nav = btn.getAttribute("data-nav");
        if (nav.indexOf("view:") === 0) {
          var parts = nav.substring(5).split(":");
          if (parts[0] === "details" && parts[1]) setDetailsOpen("view", true);   // keep the chosen section visible
          selectView(parts[0], null, parts[1]);
        }
      });
    });

    // Sidebar collapse toggle
    var collapseBtn = document.querySelector("[data-sidebar-toggle]");
    if (collapseBtn) {
      collapseBtn.addEventListener("click", function () {
        document.querySelector(".ep-shell").classList.toggle("is-sidebar-collapsed");
      });
    }

    document.querySelectorAll("[data-navigation-history]").forEach(function (button) {
      button.addEventListener("click", function () {
        var direction = button.getAttribute("data-navigation-history");
        if (direction === "back") global.history.back();
        else if (direction === "forward") global.history.forward();
      });
    });

    global.addEventListener("popstate", function (event) {
      restoreNavigationHistory(event.state);
    });
    var initialState = global.history.state && typeof global.history.state === "object"
      ? validHistorySnapshot(global.history.state[HISTORY_KEY]) : null;
    if (initialState) setNavigationState(initialState);
    else {
      setOverviewState();
      writeNavigationHistory(true);
    }
  }

  // Called by app.js after catalog loads
  function loadPlants() {
    data.listPlants().then(function (plants) {
      populatePlantList(plants);
      plantsLoaded = true;
      if (navState.activeView === "plant-sub" &&
          !allPlants.some(function (plant) { return plant.siteCode === navState.selectedPlant; })) {
        setOverviewState();
        updateContentArea();
        updateHighlights();
        writeNavigationHistory(true);
      }
    });
  }

  // Public "activate" for backwards compat with overview.js open-plant links
  function activate(tabId) {
    if (tabId === "overview") {
      activateOverview();
    } else if (tabId === "plants") {
      setGroupExpanded("plants", true);
    }
  }

  global.Solar91PortalNav = {
    ROLE_TAB_VISIBILITY: ROLE_TAB_VISIBILITY,
    activate: activate,
    applyRoleVisibility: applyRoleVisibility,
    wire: wire,
    loadPlants: loadPlants,
    selectPlant: selectPlant,
    selectView: selectView,
    selectPlantPage: selectPlantPage,
    refresh: refresh,
    setPlantAlerts: setPlantAlerts,
    getState: function () { return navState; }
  };
}(window));
