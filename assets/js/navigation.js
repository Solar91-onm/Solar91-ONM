/**
 * navigation.js — Phase 2 sidebar navigation.
 *
 * Handles:
 *  - Overview (existing dashboard)
 *  - Plants group (expand/collapse, search, plant list, per-plant sub-nav)
 *  - Overview group (expand/collapse, portfolio-wide nav items)
 *  - Active-state highlighting and content routing
 *
 * Role-based tab visibility from Phase 1 is preserved via ROLE_TAB_VISIBILITY.
 */
(function (global) {
  "use strict";

  var data = global.Solar91PortalData;

  var PLANT_SUB_PAGES = [
    { id: "details",         label: "Details" },
    { id: "health",          label: "Health" },
    { id: "pm",              label: "Preventive Maintenance" },
    { id: "washing",         label: "Module Cleaning" },
    { id: "movable-assets",  label: "Movable Assets" }
  ];

  var VIEW_SUB_PAGES = [
    { id: "details",         label: "Details" },
    { id: "health",          label: "Health" },
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

  function restrictedPages() {
    var rule = ROLE_TAB_VISIBILITY[currentRole];
    return Array.isArray(rule) ? rule : null;
  }

  function plantPages() {
    var allowed = restrictedPages();
    return allowed ? PLANT_SUB_PAGES.filter(function (p) { return allowed.indexOf(p.id) !== -1; }) : PLANT_SUB_PAGES;
  }

  function isPlantPageAllowed(pageId) {
    var allowed = restrictedPages();
    return !allowed || allowed.indexOf(pageId) !== -1;
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
    if (details !== "details" && !DETAIL_SECTIONS.some(function (item) { return item.id === details; })) {
      details = "details";
    }
    if (snapshot.activeView === "overview" || snapshot.activeView === "settings" ||
        snapshot.activeView === "security") {
      return {
        activeView: snapshot.activeView,
        selectedPlant: null,
        selectedSubPage: null,
        selectedViewPage: null,
        selectedDetailSection: "details",
        selectedRange: null
      };
    }
    if (snapshot.activeView === "view-sub" &&
        VIEW_SUB_PAGES.some(function (item) { return item.id === snapshot.selectedViewPage; })) {
      return {
        activeView: "view-sub",
        selectedPlant: null,
        selectedSubPage: null,
        selectedViewPage: snapshot.selectedViewPage,
        selectedDetailSection: snapshot.selectedViewPage === "details" ? details : "details",
        selectedRange: snapshot.selectedRange &&
          typeof snapshot.selectedRange.startDate === "string" &&
          typeof snapshot.selectedRange.endDate === "string"
          ? { startDate: snapshot.selectedRange.startDate, endDate: snapshot.selectedRange.endDate }
          : null
      };
    }
    if (snapshot.activeView === "plant-sub" && typeof snapshot.selectedPlant === "string" &&
        snapshot.selectedPlant && PLANT_SUB_PAGES.some(function (item) { return item.id === snapshot.selectedSubPage; })) {
      return {
        activeView: "plant-sub",
        selectedPlant: snapshot.selectedPlant,
        selectedSubPage: snapshot.selectedSubPage,
        selectedViewPage: null,
        selectedDetailSection: snapshot.selectedSubPage === "details" ? details : "details",
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
      navState.detailsOpen.view = snapshot.selectedDetailSection !== "details";
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
      '" aria-expanded="' + open + '" aria-label="Show or hide Details sections" title="Show or hide sections">' + CHEVRON_SVG + '</button>';
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
        if (page.id === "details") {
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
    navState.activeView = "view-sub";
    navState.selectedViewPage = pageId;
    navState.selectedDetailSection = pageId === "details" && detailSection
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
    if (navState.activeView === "security") return ["security"];
    if (navState.activeView === "settings") return ["settings"];

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
      // The Details page hands Design/MDL, Liasoning and BOM to their own modules.
      if (section === "design-mdl") return ["plants-table", "design"];
      if (section === "liasoning") return ["plants-table", "liasoning"];
      if (section === "bom") return ["plants-table", "bom"];
      return ["plants-table"];
    }
    return [];
  }

  /** Where the page being opened draws itself, so a skeleton can stand in while its script loads. */
  function hostForState() {
    if (navState.activeView === "security") return document.querySelector("[data-security-host]");
    if (navState.activeView === "settings") return document.querySelector("[data-settings-host]");
    var plantCode = navState.activeView === "plant-sub" ? navState.selectedPlant : null;
    var pageId = navState.activeView === "plant-sub" ? navState.selectedSubPage
      : navState.activeView === "view-sub" ? navState.selectedViewPage : null;
    if (pageId === "washing" && !plantCode) return document.querySelector("[data-washing-board-host]");
    if (pageId === "washing" || pageId === "pm") return document.querySelector("[data-calendar-host]");
    if (pageId === "health") return document.querySelector("[data-issues-host]");
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
    if (navState.activeView === "security" &&
        currentRole !== "O&M Head" && currentRole !== "Administration") {
      navState.activeView = "overview";
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
  }

  function renderContentArea() {
    enforceRolePages();
    var shell = document.querySelector(".ep-shell");
    if (shell) shell.classList.toggle("is-login-access", navState.activeView === "settings");
    var overviewEl = document.querySelector('[data-tab-view="overview"]');
    var tableEl = document.querySelector('[data-tab-view="plants-table"]');
    var calendarEl = document.querySelector('[data-tab-view="calendar"]');
    var washingBoardEl = document.querySelector('[data-tab-view="washing-board"]');
    var healthEl = document.querySelector('[data-tab-view="health"]');
    var movableAssetsEl = document.querySelector('[data-tab-view="movable-assets"]');
    var detailsEl = document.querySelector('[data-tab-view="plant-details"]');
    var securityEl = document.querySelector('[data-tab-view="security"]');
    var settingsEl = document.querySelector('[data-tab-view="settings"]');
    var placeholderEl = document.querySelector('[data-tab-view="placeholder"]');
    var titleEl = document.querySelector("[data-topbar-title]");
    var phTitle = document.querySelector("[data-placeholder-title]");
    var phSubtitle = document.querySelector("[data-placeholder-subtitle]");
    var phContext = document.querySelector("[data-placeholder-context]");

    function showOnly(el) {
      [overviewEl, tableEl, calendarEl, washingBoardEl, healthEl, movableAssetsEl, detailsEl, securityEl, settingsEl, placeholderEl].forEach(function (section) {
        if (section) section.classList.toggle("is-visible", section === el);
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
    if (navState.activeView === "security") {
      showOnly(securityEl);
      if (titleEl) titleEl.textContent = "Security";
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
    } else if (isDetails && global.Solar91PortalPlantsTable) {
      // Details is one table of stored plant fields: this plant's single row
      // when a plant is selected, every plant's row portfolio-wide.
      showOnly(plantCode ? detailsEl : tableEl);
      global.Solar91PortalPlantsTable.show(
        document.querySelector(plantCode ? "[data-plant-details-host]" : "[data-plants-table-host]"),
        {
          siteCode: plantCode,
          section: navState.selectedDetailSection
        }
      );
    } else if (pageId === "health" && global.Solar91PortalIssues) {
      showOnly(healthEl);
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
      showOnly(plantCode ? detailsEl : tableEl);
    } else if (pageId === "health") {
      showOnly(healthEl);
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
      if (nav.indexOf("plant:") === 0) return; // rendered with the selected plant sub-navigation

      var isActive = false;
      if (nav.indexOf("view:") === 0) {
        var viewParts = nav.substring(5).split(":");
        isActive = navState.activeView === "view-sub" &&
          navState.selectedViewPage === viewParts[0] &&
          (viewParts[0] !== "details" ||
            (viewParts.length === 1 && navState.selectedDetailSection === "details") ||
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
    if (security) security.hidden = role !== "O&M Head" && role !== "Administration";
    if (navState.activeView === "security" && security && security.hidden) {
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
    var securityBtn = document.querySelector('[data-nav="security"]');
    if (securityBtn) securityBtn.addEventListener("click", function () {
      if (currentRole !== "O&M Head" && currentRole !== "Administration") return;
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
            navState.selectedSubPage = parts[2];
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
    getState: function () { return navState; }
  };
}(window));
