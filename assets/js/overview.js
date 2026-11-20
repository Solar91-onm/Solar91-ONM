
(function (global) {
  "use strict";

  const data = global.Solar91PortalData;
  const fmt = global.Solar91PortalFormat;
  let activityCache = null;
  let rangeRequest = 0;
  let rangeKey = "";
  // Inverters: how many are installed (the saved per-plant unit configuration) and how many
  // have an open site issue against them. Both are read once; the filters narrow them here.
  let inverters = { units: [], issues: [], loaded: false, unitsRestricted: false };
  let strings   = { units: [], issues: [], loaded: false, unitsRestricted: false };

  let state = null;      // { allRows, rows, totals, sort }
  let searchTerm = "";
  const filters = { plant: "__all", health: "__all", company: "__all", district: "__all" };
  // The district dropdown merges values that differ only by case or spacing, so compare them the same way.
  function districtKey(value) { return String(value || "").trim().toLocaleLowerCase(); }
  function districtMatches(plant) {
    return filters.district === "__all" || districtKey(plant.district) === districtKey(filters.district);
  }

  function applyFilters(rows) {
    return rows.filter(({ plant, profile }) => {
      if (filters.plant !== "__all" && plant.siteCode !== filters.plant) return false;
      if (filters.health !== "__all" && profile.derivedCondition !== filters.health) return false;
      if (filters.company !== "__all" && (plant.projectCompany || "") !== filters.company) return false;
      if (!districtMatches(plant)) return false;
      return true;
    });
  }

  function dateValue(value) {
    const parts = String(value || "").split("-").map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function dateString(value) {
    return value.getFullYear() + "-" + String(value.getMonth() + 1).padStart(2, "0") +
      "-" + String(value.getDate()).padStart(2, "0");
  }

  function shiftDate(value, days) {
    const shifted = dateValue(value);
    if (!shifted) return "";
    shifted.setDate(shifted.getDate() + days);
    return dateString(shifted);
  }

  function rangeStatus(message, isError) {
    const status = document.querySelector("[data-overview-range-status]");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("is-error", !!isError);
  }

  /**
   * The one date control. Records the range on `state`, then refreshes the
   * tiles from it.
   */
  function applyRange(startDate, endDate) {
    if (!state) return;
    if (!startDate || !endDate || startDate > endDate) {
      rangeKey = "";
      rangeStatus("Choose a start date on or before the end date.", true);
      return;
    }
    if (endDate > state.businessDate) {
      rangeKey = "";
      rangeStatus("The end date cannot be in the future.", true);
      return;
    }
    state.rangeStart = startDate;
    state.rangeEnd = endDate;
    loadRange(startDate, endDate);
  }

  function loadRange(startDate, endDate) {
    if (!state) return;
    const requestId = ++rangeRequest;
    const key = startDate + ":" + endDate;
    if (key === rangeKey) {
      return;
    }
    rangeKey = key;
    rangeStatus("Loading operational results for " + startDate + " to " + endDate + "…", false);
    data.fetchPortfolioRange(startDate, endDate).then((portfolio) => {
      if (!state || requestId !== rangeRequest) return;
      state.periodRows = portfolio.rows;
      const filtered = applyFilters(state.periodRows);
      state.rows = filtered;
      state.totals = data.aggregatePortfolio(filtered);
      state.dataVersion = portfolio.dataVersion || state.dataVersion;
      lastLoadedAt = Date.now();
      rangeStatus("Showing results from " + startDate + " to " + endDate + ".", false);
      render();
    }).catch((error) => {
      if (requestId !== rangeRequest) return;
      rangeKey = "";
      rangeStatus("Could not load results for this date range: " + error.message, true);
    });
  }

  function loadQuickPeriod(period) {
    if (!state) return;
    const today = state.businessDate;
    const todayDate = dateValue(today);
    if (!todayDate) {
      rangeStatus("The business date is unavailable; reload the page and try again.", true);
      return;
    }
    let startDate = today;
    if (period === "yesterday") {
      startDate = shiftDate(today, -1);
    } else if (period === "week") {
      startDate = shiftDate(today, -((todayDate.getDay() + 6) % 7));
    } else if (period === "month") {
      startDate = today.slice(0, 8) + "01";
    } else if (period === "all") {
      startDate = shiftDate(today, -3650);
    }
    applyRange(startDate, period === "yesterday" ? shiftDate(today, -1) : today);
  }

  function recomputeAndRender() {
    const filtered = applyFilters(state.periodRows || state.allRows);
    state.rows = filtered;
    state.totals = data.aggregatePortfolio(filtered);
    render();
  }

  const DEFAULT_PERIOD = "month";

  /**
   * Fill the filter dropdowns and wire the controls. Only the first load does this: a later
   * refresh used to append the same options again and add a second listener to every control.
   */
  function populateFilterOptions(allRows, wireControls) {
    if (!wireControls) return;
    // Searchable plant filter combobox
    const plantCombo = document.querySelector("[data-plant-filter-combo]");
    const plantInput = document.querySelector("[data-plant-filter-input]");
    const plantPanel = document.querySelector("[data-plant-filter-panel]");
    const companySel = document.querySelector("[data-filter=\"company\"]");
    const districtSel = document.querySelector("[data-filter=\"district\"]");

    // Picking a plant narrows SPV and district to that plant; "All plants" (or clearing the
    // plant box) puts both back to their defaults.
    function syncLocationFilters(plant) {
      let company = "__all";
      let district = "__all";
      if (plant) {
        if (companySel && plant.projectCompany &&
            Array.from(companySel.options).some((o) => o.value === plant.projectCompany)) {
          company = plant.projectCompany;
        }
        const option = districtSel && plant.district
          ? Array.from(districtSel.options).find((o) => o.value !== "__all" && districtKey(o.value) === districtKey(plant.district))
          : null;
        if (option) district = option.value;
      }
      filters.company = company;
      filters.district = district;
      if (companySel) companySel.value = company;
      if (districtSel) districtSel.value = district;
    }

    function selectPlantFilter(code) {
      const row = code === "__all" ? null : allRows.find(({ plant }) => plant.siteCode === code);
      filters.plant = row ? code : "__all";
      syncLocationFilters(row ? row.plant : null);
      recomputeAndRender();
    }

    if (plantInput && plantPanel) {
      function renderPlantOptions(term) {
        const t = (term || "").trim().toLowerCase();
        const matched = allRows.filter(({ plant }) => {
          if (!t) return true;
          return (plant.displayName || plant.plantName).toLowerCase().indexOf(t) !== -1 ||
                 plant.displayCode.toLowerCase().indexOf(t) !== -1 ||
                 plant.siteCode.toLowerCase().indexOf(t) !== -1;
        });
        let html = `<div class="ep-filter-combo__opt ep-filter-combo__opt--all${filters.plant === "__all" ? " is-active" : ""}" data-plant-opt="__all">All plants</div>`;
        html += matched.map(({ plant }) =>
          `<div class="ep-filter-combo__opt${filters.plant === plant.siteCode ? " is-active" : ""}" data-plant-opt="${plant.siteCode}">` +
            `<span>${fmt.escape(plant.displayName || plant.plantName)}</span>` +
            `<span class="ep-filter-combo__opt-code">${plant.displayCode}</span>` +
          `</div>`
        ).join("");
        if (matched.length === 0) html += `<div class="ep-filter-combo__empty">No plants found</div>`;
        plantPanel.innerHTML = html;
      }
      renderPlantOptions("");

      plantCombo.addEventListener("click", (ev) => {
        if (!ev.target.closest(".ep-filter-combo__panel")) {
          plantCombo.classList.add("is-open");
          renderPlantOptions(plantInput.value);
          plantInput.focus();
        }
      });
      plantInput.addEventListener("input", () => {
        plantCombo.classList.add("is-open");
        renderPlantOptions(plantInput.value);
        // Backspacing the plant name away means "All plants" again.
        if (!plantInput.value.trim() && filters.plant !== "__all") selectPlantFilter("__all");
      });
      plantPanel.addEventListener("click", (ev) => {
        const opt = ev.target.closest("[data-plant-opt]");
        if (!opt) return;
        const code = opt.getAttribute("data-plant-opt");
        if (code === "__all") {
          plantInput.value = "";
          plantInput.placeholder = "All plants";
        } else {
          const row = allRows.find(({ plant }) => plant.siteCode === code);
          plantInput.value = row ? (row.plant.displayName || row.plant.plantName) : code;
          plantInput.placeholder = "All plants";
        }
        plantCombo.classList.remove("is-open");
        selectPlantFilter(code);
      });
      document.addEventListener("click", (ev) => {
        if (!plantCombo.contains(ev.target)) plantCombo.classList.remove("is-open");
      });
    }

    const companies = new Map();
    const districtsByKey = new Map();
    allRows.forEach(({ plant }) => {
      const company = plant.projectCompany || "";
      if (company && !companies.has(company)) {
        companies.set(company, plant.projectCompanyShort || company);
      }
      const district = (plant.district || "").trim();
      const districtKey = district.toLocaleLowerCase();
      if (district && !districtsByKey.has(districtKey)) districtsByKey.set(districtKey, district);
    });
    if (companySel) {
      Array.from(companies, ([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
        .forEach((company) => {
          const option = document.createElement("option");
          option.value = company.value;
          option.textContent = company.label;
          companySel.appendChild(option);
        });
    }
    if (districtSel) {
      Array.from(districtsByKey.values())
        .sort((a, b) => a.localeCompare(b))
        .forEach((district) => {
          const option = document.createElement("option");
          option.value = district;
          option.textContent = district;
          districtSel.appendChild(option);
        });
    }

    document.querySelectorAll("[data-filter]").forEach((sel) => {
      sel.addEventListener("change", (ev) => {
        const filterName = sel.getAttribute("data-filter");
        if (filterName === "date") {
          loadQuickPeriod(ev.target.value);
          return;
        }
        filters[filterName] = ev.target.value;
        recomputeAndRender();
      });
    });

    const fromDate = document.querySelector("[data-date-from]");
    const toDate = document.querySelector("[data-date-to]");
    const dateToggle = document.querySelector("[data-date-toggle] input");
    const quickView = document.querySelector("[data-date-quick-view]");
    const rangeView = document.querySelector("[data-date-range-view]");
    const today = state.businessDate;
    const firstOfMonth = today.slice(0, 8) + "01";
    if (fromDate && toDate) {
      fromDate.max = today;
      toDate.max = today;
      fromDate.value = firstOfMonth;
      toDate.value = today;
      [fromDate, toDate].forEach((input) => {
        input.addEventListener("change", () => applyRange(fromDate.value, toDate.value));
      });
    }

    if (dateToggle) dateToggle.addEventListener("change", () => {
      const isRange = dateToggle.checked;
      if (quickView) quickView.style.display = isRange ? "none" : "";
      if (rangeView) rangeView.style.display = isRange ? "" : "none";
      if (isRange && fromDate && toDate) applyRange(fromDate.value, toDate.value);
      else loadQuickPeriod(document.querySelector('[data-filter="date"]').value);
    });
    // The period on screen has just been loaded; reading it again here would be the same
    // request twice on every sign-in.
  }

  // ─── Inverters ───────────────────────────────────────────────────────
  const INVERTER = "inverter";
  const STRING = "string";

  function isInverter(name) { return String(name || "").trim().toLowerCase() === INVERTER; }
  function isString(name)   { return String(name || "").trim().toLowerCase() === STRING; }

  function calculateInverterTotals(codes, unitRows, issueRows) {
    let total = 0;
    let plantsWithUnits = 0;
    (unitRows || []).forEach((row) => {
      if (!isInverter(row.equipment_type) || (row.site_code && !codes.has(row.site_code))) return;
      total += Number(row.total_units) || 0;
      plantsWithUnits += 1;
    });
    let down = 0;
    let tickets = 0;
    let affected = 0;
    (issueRows || []).forEach((row) => {
      if (row.site_code && !codes.has(row.site_code)) return;
      tickets += Number(row.open) || 0;
      down += Number(row.units) || 0;
      affected += 1;
    });
    if (total) down = Math.min(down, total);
    const running = total ? total - down : null;
    return {
      total: total, down: down, running: running,
      runningPercent: total ? Math.round(running / total * 100) : null,
      tickets: tickets, plants: affected, configured: plantsWithUnits > 0
    };
  }

  function calculateStringTotals(codes, unitRows, issueRows) {
    let total = 0;
    let plantsWithUnits = 0;
    (unitRows || []).forEach((row) => {
      if (!isString(row.equipment_type) || (row.site_code && !codes.has(row.site_code))) return;
      total += Number(row.total_units) || 0;
      plantsWithUnits += 1;
    });
    let down = 0;
    let tickets = 0;
    let affected = 0;
    (issueRows || []).forEach((row) => {
      if (row.site_code && !codes.has(row.site_code)) return;
      tickets += Number(row.open) || 0;
      down += Number(row.units) || 0;
      affected += 1;
    });
    if (total) down = Math.min(down, total);
    const running = total ? total - down : null;
    return {
      total: total, down: down, running: running,
      runningPercent: total ? Math.round(running / total * 100) : null,
      tickets: tickets, plants: affected, configured: plantsWithUnits > 0
    };
  }

  function stringUnitRows(codes, unitRows, allowTableFallback) {
    const rows = (unitRows || []).slice();
    if (!allowTableFallback || !state) return rows;

    const configured = new Set(rows.filter((row) =>
      isString(row.equipment_type) && codes.has(row.site_code)
    ).map((row) => row.site_code));
    state.allRows.forEach(({ plant, profile }) => {
      if (!plant || !codes.has(plant.siteCode) || configured.has(plant.siteCode)) return;
      const tableCount = Number(profile && profile.washing && profile.washing.tableCount);
      if (!Number.isSafeInteger(tableCount) || tableCount < 1) return;
      rows.push({
        site_code: plant.siteCode,
        equipment_type: "String",
        total_units: tableCount,
        units_per_day: tableCount,
        maker: null,
        capacity_kw: null,
        inferred_from_table_count: true
      });
    });
    return rows;
  }

  /**
   * The inverter figures for whatever the filters currently select.
   *
   * `total` is the number of inverters configured for those plants (PM unit configuration —
   * the only stored count of units). `down` comes from the server's own per-plant count of open
   * inverter tickets and the units they name, so the tile reads counts rather than the ticket
   * list. A plant with no configured units contributes nothing to `total`, so the tile says
   * "not configured" rather than showing a total that is really a guess.
   */
  function inverterTotals() {
    const codes = new Set(state ? state.rows.map(({ plant }) => plant.siteCode) : []);
    const totals = calculateInverterTotals(codes, inverters.units, inverters.issues);
    totals.restricted = inverters.unitsRestricted;
    return totals;
  }

  // ─── Equipment Health drill-down panels (Inverters + Strings) ────────
  // Both panels are instances of one parameterised Solar91EquipmentHealth module, loaded lazily
  // from inverter-health.js on first open (about 45 KB). The tile figures stay here; the panels
  // read them through the ctx.state getter and ctx.equipmentCache reference.
  const INVERTER_HISTORY_KEY = "solar91InverterHealthOpen";
  const STRING_HISTORY_KEY   = "solar91StringHealthOpen";
  let inverterPanel = null;
  let stringPanel   = null;

  const INVERTER_PANEL_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M13 7l-4 6h3l-1 4 4-6h-3l1-4z"></path></svg>`;
  const STRING_PANEL_ICON   = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="4" height="4" rx=".5"></rect><rect x="10" y="5" width="4" height="4" rx=".5"></rect><rect x="18" y="5" width="4" height="4" rx=".5"></rect><rect x="2" y="15" width="4" height="4" rx=".5"></rect><rect x="10" y="15" width="4" height="4" rx=".5"></rect><rect x="18" y="15" width="4" height="4" rx=".5"></rect><path d="M4 9v6M12 9v6M20 9v6"></path></svg>`;

  function loadEquipmentHealthModule() {
    if (global.Solar91EquipmentHealth) return Promise.resolve();
    if (global.Solar91Modules) return global.Solar91Modules.load("inverter-health");
    return Promise.reject(new Error("The Equipment Health panel is unavailable."));
  }

  function inverterHealthPanel() {
    if (inverterPanel) return Promise.resolve(inverterPanel);
    return loadEquipmentHealthModule().then(() => {
      inverterPanel = global.Solar91EquipmentHealth.create(
        { vertical: "Inverter", label: "Inverter", unitLabel: "Inverter",
          icon: INVERTER_PANEL_ICON, historyKey: INVERTER_HISTORY_KEY,
          mountAttr: "data-inverter-health", destination: "inverters", type: "inverter" },
        { state: () => state, filters, equipmentCache: inverters, fmt,
          isEquipmentType: isInverter, calculateTotals: calculateInverterTotals,
          reloadTile: () => { return loadInverters(true); } }
      );
      return inverterPanel;
    });
  }

  function stringHealthPanel() {
    if (stringPanel) return Promise.resolve(stringPanel);
    return loadEquipmentHealthModule().then(() => {
      stringPanel = global.Solar91EquipmentHealth.create(
        { vertical: "String", label: "String", unitLabel: "String",
          icon: STRING_PANEL_ICON, historyKey: STRING_HISTORY_KEY,
          mountAttr: "data-string-health", destination: "strings", type: "string" },
        { state: () => state, filters, equipmentCache: strings, fmt,
          isEquipmentType: isString, calculateTotals: calculateStringTotals,
          getUnitRows: stringUnitRows,
          reloadTile: () => { return loadStrings(true); } }
      );
      return stringPanel;
    });
  }

  function openInverterHealth(fromHistory) {
    if (!state) return;
    inverterHealthPanel().then((ih) => ih.open(fromHistory)).catch((error) => {
      overviewNotice("Inverter Health could not be opened: " +
        fmt.escape((error && error.message) || "please retry.") +
        ' <button type="button" data-overview-retry>Retry</button>', "error");
    });
  }

  function openStringHealth(fromHistory) {
    if (!state) return;
    stringHealthPanel().then((sh) => sh.open(fromHistory)).catch((error) => {
      overviewNotice("String Health could not be opened: " +
        fmt.escape((error && error.message) || "please retry.") +
        ' <button type="button" data-overview-retry>Retry</button>', "error");
    });
  }

  function wireInverterHealth() {
    global.addEventListener("popstate", (event) => {
      if (!inverterPanel && event.state && event.state[INVERTER_HISTORY_KEY]) openInverterHealth(true);
    });
  }

  function wireStringHealth() {
    global.addEventListener("popstate", (event) => {
      if (!stringPanel && event.state && event.state[STRING_HISTORY_KEY]) openStringHealth(true);
    });
  }

  function stringTotals() {
    const codes = new Set(state ? state.rows.map(({ plant }) => plant.siteCode) : []);
    const unitRows = stringUnitRows(codes, strings.units, !strings.unitsRestricted);
    const totals = calculateStringTotals(codes, unitRows, strings.issues);
    totals.restricted = strings.unitsRestricted;
    return totals;
  }

  /** One request each, both optional: the tile degrades to what the role may read. */
  function loadInverters(force) {
    const api = global.Solar91PortalAPI;
    if (!api || (inverters.loaded && !force)) return Promise.resolve();
    if (force) {
      inverters.units = [];
      inverters.issues = [];
      inverters.unitsRestricted = false;
    }
    inverters.loaded = true;
    const unitsRequest = api.request("/api/pm-plan/unit-config").then((body) => {
      inverters.units = (body && body.configs) || [];
    }).catch(() => {
      inverters.unitsRestricted = true;
    });
    // Counts per plant, not the tickets themselves: the tile needs how many units are affected.
    const summaryRequest = api.request("/api/issues/equipment-summary?vertical=Inverter").then((body) => {
      inverters.issues = (body && body.plants) || [];
    }).catch(() => {});
    return Promise.all([unitsRequest, summaryRequest]).then(() => {
      render();
      publishPlantAlerts();
    });
  }

  /**
   * Light the sidebar for plants with an inverter problem. It reuses the per-plant counts the
   * tile already holds, so the sidebar adds no request of its own, and it is republished after
   * every refresh so a raised or resolved ticket lights or clears the plant straight away.
   */
  function publishPlantAlerts() {
    const nav = global.Solar91PortalNav;
    if (!nav || !nav.setPlantAlerts) return;
    const alerts = {};
    (inverters.issues || []).forEach((row) => {
      const down = Number(row.units) || 0;
      if (!row.site_code || down <= 0) return;
      alerts[row.site_code] = { down: down };
    });
    nav.setPlantAlerts(alerts);
  }

  /** One request each for strings, both optional. */
  function loadStrings(force) {
    const api = global.Solar91PortalAPI;
    if (!api || (strings.loaded && !force)) return Promise.resolve();
    if (force) {
      strings.units = [];
      strings.issues = [];
      strings.unitsRestricted = false;
    }
    strings.loaded = true;
    const unitsRequest = api.request("/api/pm-plan/unit-config").then((body) => {
      strings.units = (body && body.configs) || [];
    }).catch(() => {
      strings.unitsRestricted = true;
    });
    const summaryRequest = api.request("/api/issues/equipment-summary?vertical=String").then((body) => {
      strings.issues = (body && body.plants) || [];
    }).catch(() => {});
    return Promise.all([unitsRequest, summaryRequest]).then(() => { render(); });
  }

  // ─── Rendering helpers ───────────────────────────────────────────────
  function conditionChip(cond) {
    const map = {
      healthy:   { cls: "ep-chip--healthy",   label: "Healthy" },
      attention: { cls: "ep-chip--attention", label: "Attention Required" },
      critical:  { cls: "ep-chip--critical",  label: "Critical" },
      unknown:   { cls: "ep-chip--grey",      label: "Not Available" }
    };
    const def = map[cond] || map.unknown;
    return `<span class="ep-chip ${def.cls}"><span class="ep-chip__dot"></span>${def.label}</span>`;
  }

  function complianceCell(pct, decimals) {
    if (pct === null || pct === undefined) {
      return `<span class="ep-bar"><span class="ep-bar__value ep-bar__value--grey">N/A</span></span>`;
    }
    const colour = pct >= 85 ? "green" : pct >= 70 ? "amber" : "red";
    const label = decimals ? Number(pct).toFixed(decimals) : pct + "";
    return (
      `<span class="ep-bar">` +
        `<span class="ep-bar__track"><span class="ep-bar__fill ep-bar__fill--${colour}" style="width:${Math.min(100, pct)}%"></span></span>` +
        `<span class="ep-bar__value">${label}%</span>` +
      `</span>`
    );
  }

  function plantCell(plant) {
    return (
      `<div class="ep-plant-cell">` +
        `<span class="ep-plant-cell__name">${fmt.escape(plant.displayName || plant.plantName)}</span>` +
        `<span class="ep-plant-cell__code">${plant.displayCode}</span>` +
      `</div>`
    );
  }

  function numCell(value) {
    if (value === null || value === undefined) return `<span class="ep-text-faint">—</span>`;
    return fmt.formatNumber(value);
  }

  // ─── Header strip + big metric cards + count strip ──────────────────
  function renderTiles(totals) {
    // Header strip — title + capacity chips
    const headline = document.querySelector("[data-portfolio-headline]");
    if (headline) headline.textContent = "· " + totals.totalPlants + " plants";
    const dc = document.querySelector("[data-cap-dc]");
    const ac = document.querySelector("[data-cap-ac]");
    if (dc) dc.textContent = totals.dcCapacityMw ? totals.dcCapacityMw.toFixed(2) + " MWp" : "—";
    if (ac) ac.textContent = totals.acCapacityMw ? totals.acCapacityMw.toFixed(2) + " MW"  : "—";

    // Three big neutral metric cards: PM, Washing, Issues. Status is signalled
    // only by a 6px dot in the pill — number stays in primary text colour.
    const pmPct   = totals.pmCompliancePercent;
    const wshPct = Number(totals.washingCompliancePercent) || 0;
    const washingWork = totals.washingWork || { done: 0, due: 0, pending: 0, overdue: 0, plants: 0 };
    const washingHasPlan = washingWork.due > 0;
    // How many plants have finished each cycle. Cycles run in sequence -- a plant only starts
    // cycle n+1 once cycle n is complete -- so a plant with k cycles completed has finished
    // cycles 1..k. The fractional part is extra washing, not a finished cycle, hence the floor.
    const washingRows = (state && state.rows) || [];
    const washingPlants = washingRows.filter(({ profile }) =>
      ((profile || {}).washing || {}).monthlyActivities).length;
    const washingCycleDone = [1, 2, 3].map((n) => washingRows.filter(({ profile }) => {
      const activities = ((profile || {}).washing || {}).monthlyActivities;
      return activities && Math.floor(Number(activities.completed) || 0) >= n;
    }).length);
    const openIss = totals.openIssues;

    function pill(label, pct, overdueCount) {
      if (pct === null || pct === undefined) return { dot: "", tag: "N/A" };
      if (overdueCount > 0 || pct < 70) return { dot: "red",   tag: "Unhealthy" };
      if (pct < 85) return { dot: "amber", tag: "In Progress" };
      return { dot: "green", tag: "Healthy" };
    }
    function issuePill(critical, open) {
      if (critical > 0) return { dot: "red",   tag: "Unhealthy" };
      if (open > 4)     return { dot: "amber", tag: "In Progress" };
      if (open === 0)   return { dot: "green", tag: "Healthy" };
      return { dot: "green", tag: "Healthy" };
    }

    const inv = inverterTotals();
    const inverterPill = !inv.total && !inv.tickets
      ? { dot: "", tag: "N/A" }
      : inv.down > 0
        ? { dot: "red", tag: "Attention" }
        : { dot: "green", tag: "All running" };

    const str = stringTotals();
    const stringPill = !str.total && !str.tickets
      ? { dot: "", tag: "N/A" }
      : str.down > 0
        ? { dot: "red", tag: "Attention" }
        : { dot: "green", tag: "All working" };

    const pmP  = pill("PM", pmPct, totals.pmOverdue);
    const wshP = washingHasPlan ? pill("Module Cleaning", wshPct, totals.washingOverdue)
      : { dot: "", tag: "N/A" };
    const isP  = issuePill(totals.criticalIssues, openIss);

    const ICON_PM = `<svg class="ep-metric__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M16 2v4M8 2v4M3 10h18"></path><path d="m9 16 2 2 4-4"></path></svg>`;
    const ICON_WASH = `<svg class="ep-metric__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"></path><path d="M6 8h12l-1.5 12h-9L6 8z"></path><path d="M4.22 10.22A8 8 0 0 0 12 22a8 8 0 0 0 7.78-11.78"></path></svg>`;
    const ICON_INVERTER = `<svg class="ep-metric__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M13 7l-4 6h3l-1 4 4-6h-3l1-4z"></path></svg>`;
    const ICON_STRING = `<svg class="ep-metric__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="4" height="4" rx=".5"></rect><rect x="10" y="5" width="4" height="4" rx=".5"></rect><rect x="18" y="5" width="4" height="4" rx=".5"></rect><rect x="2" y="15" width="4" height="4" rx=".5"></rect><rect x="10" y="15" width="4" height="4" rx=".5"></rect><rect x="18" y="15" width="4" height="4" rx=".5"></rect><path d="M4 9v6M12 9v6M20 9v6"></path></svg>`;
    const ICON_ISSUES = `<svg class="ep-metric__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
    const CHEVRON = `<svg class="ep-metric__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>`;

    // The tile's own state, used for the icon chip, the headline figure and the meter. The
    // thresholds are the pills' above: this only names the colour they already decided.
    const toneOfPill = (pill) => pill.dot === "red" ? "red" : pill.dot === "amber" ? "amber"
      : pill.dot === "green" ? "accent" : "neutral";
    const pmScheduled = totals.pmCompleted + totals.pmPending + totals.pmOverdue;
    const pmEmpty = pmPct === null || pmScheduled === 0;
    const issueUnsolved = totals.unsolvedIssues;
    const clamp = (value) => Math.max(0, Math.min(100, Number(value) || 0));

    const cards = [
      {
        title: "Preventive Maintenance",
        destination: "pm",
        icon: ICON_PM,
        tone: pmEmpty ? "neutral" : toneOfPill(pmP),
        // Nothing scheduled is not 0% — a bare dash there reads as a broken tile.
        empty: pmEmpty ? "No activities this month" : "",
        figure: pmEmpty ? null : { value: String(pmPct), unit: "%", caption: "of activities completed" },
        meter: pmEmpty ? [] : [
          { width: clamp(pmPct), tone: "accent" },
          { width: 100 - clamp(pmPct), tone: "short" }
        ],
        legend: [
          { dot: pmEmpty ? "" : "green", label: "Completed", value: fmt.formatNumber(totals.pmCompleted) },
          { dot: "", label: "Pending", value: fmt.formatNumber(totals.pmPending) },
          { dot: totals.pmOverdue > 0 ? "red" : "", label: "Overdue", value: fmt.formatNumber(totals.pmOverdue), bad: totals.pmOverdue > 0 }
        ]
      },
      {
        title: "Module Cleaning Compliance",
        destination: "washing",
        icon: ICON_WASH,
        tone: washingHasPlan ? toneOfPill(wshP) : "neutral",
        figure: {
          value: wshPct.toFixed(1), unit: "%",
          caption: washingHasPlan
            ? "of " + fmt.formatNumber(washingWork.due) + " planned cleaning activities"
            : "No cleaning activities scheduled"
        },
        subline: washingPlants
          ? "Completed — Cycle 1: " + fmt.formatNumber(washingCycleDone[0]) +
            " · Cycle 2: " + fmt.formatNumber(washingCycleDone[1]) +
            " · Cycle 3: " + fmt.formatNumber(washingCycleDone[2]) +
            " of " + fmt.formatNumber(washingPlants) + (washingPlants === 1 ? " plant" : " plants")
          : washingWork.plants
          ? (washingWork.plants === 1 && state && state.rows.length === 1
            ? state.rows[0].plant.plantName || state.rows[0].plant.siteCode
            : "Across " + fmt.formatNumber(washingWork.plants) + " plants")
          : "",
        meter: washingHasPlan ? [
          { width: clamp(wshPct), tone: "accent" },
          { width: 100 - clamp(wshPct), tone: "short" }
        ] : [],
        legend: [
          { dot: washingWork.completed ? "green" : "", label: "Completed",
            value: fmt.formatNumber(typeof washingWork.completed === "number" ? washingWork.completed : washingWork.done) },
          { dot: "", label: "Pending", value: fmt.formatNumber(washingWork.pending) },
          { dot: washingWork.overdue > 0 ? "red" : "", label: "Overdue",
            value: fmt.formatNumber(washingWork.overdue), bad: washingWork.overdue > 0 }
        ]
      },
      {
        title: "Inverters",
        destination: "inverters",
        icon: ICON_INVERTER,
        tone: toneOfPill(inverterPill),
        empty: inv.total || inv.tickets ? "" : (inv.restricted
          ? "Unit counts are not available to your role"
          : "No inverter units configured"),
        // Counts, not a percentage: 375 of 376 rounded to "100%" and read as nothing being down,
        // while one inverter was actually off. The raw pair cannot hide a single failed unit.
        figure: inv.total
          ? {
            value: fmt.formatNumber(inv.running) + "/" + fmt.formatNumber(inv.total),
            unit: "", caption: "inverters running out of total"
          }
          : (inv.tickets ? { value: fmt.formatNumber(inv.tickets), unit: "", caption: "open inverter issues" } : null),
        meter: inv.total ? [{ width: clamp(inv.runningPercent), tone: "accent" }] : [],
        legend: inv.total
          ? [
            { dot: "green", label: "Total inverters", value: fmt.formatNumber(inv.total) },
            { dot: inv.down > 0 ? "red" : "", label: "Not running", value: fmt.formatNumber(inv.down), bad: inv.down > 0 },
            { dot: inv.tickets > 0 ? "red" : "", label: "Open tickets", value: fmt.formatNumber(inv.tickets), bad: inv.tickets > 0 }
          ]
          : [
            { dot: inv.tickets > 0 ? "red" : "", label: "Open tickets", value: fmt.formatNumber(inv.tickets), bad: inv.tickets > 0 },
            { dot: "", label: "Plants affected", value: fmt.formatNumber(inv.plants) },
            { dot: "", label: "Units configured", value: fmt.formatNumber(inv.total) }
          ]
      },
      {
        title: "Strings",
        destination: "strings",
        icon: ICON_STRING,
        tone: toneOfPill(stringPill),
        empty: str.total || str.tickets ? "" : (str.restricted
          ? "Unit counts are not available to your role"
          : "No string units configured"),
        figure: str.total
          ? { value: fmt.formatNumber(str.running) + "/" + fmt.formatNumber(str.total),
              unit: "", caption: "strings working out of total" }
          : (str.down ? { value: fmt.formatNumber(str.down), unit: "", caption: "strings not working" }
            : (str.tickets ? { value: fmt.formatNumber(str.tickets), unit: "", caption: "open string issues" } : null)),
        meter: str.total ? [{ width: clamp(str.runningPercent), tone: "accent" }] : [],
        legend: str.total
          ? [
            { dot: "green", label: "Total strings", value: fmt.formatNumber(str.total) },
            { dot: str.down > 0 ? "red" : "", label: "Not working", value: fmt.formatNumber(str.down), bad: str.down > 0 },
            { dot: str.tickets > 0 ? "red" : "", label: "Open tickets", value: fmt.formatNumber(str.tickets), bad: str.tickets > 0 }
          ]
          : [
            { dot: str.down > 0 ? "red" : "", label: "Not working", value: fmt.formatNumber(str.down), bad: str.down > 0 },
            { dot: str.tickets > 0 ? "red" : "", label: "Open tickets", value: fmt.formatNumber(str.tickets), bad: str.tickets > 0 },
            { dot: "", label: "Plants affected", value: fmt.formatNumber(str.plants) },
            { dot: "", label: "Total strings", value: fmt.formatNumber(str.total) }
          ]
      },
      {
        title: "Open Site Issues",
        destination: "health",
        icon: ICON_ISSUES,
        tone: toneOfPill(isP),
        empty: "",
        figure: { value: fmt.formatNumber(openIss), unit: "", caption: "open across the portfolio" },
        // Stacked within the open work only: still unsolved against what is in progress.
        // Closed tickets are not shown here — the Dashboard surfaces open + in-progress only.
        meter: openIss ? [
          { width: clamp(100 * issueUnsolved / openIss), tone: "red" },
          { width: clamp(100 * totals.inProgressIssues / openIss), tone: "accent" }
        ] : [],
        legend: [
          { dot: issueUnsolved > 0 ? "red" : "", label: "Unsolved", value: fmt.formatNumber(issueUnsolved), bad: issueUnsolved > 0 },
          { dot: "", label: "In progress", value: fmt.formatNumber(totals.inProgressIssues) }
        ]
      }
    ];

    const meterHTML = (segments) =>
      `<span class="ep-meter" aria-hidden="true">${segments.map((segment) =>
        `<span class="ep-meter__seg ep-meter__seg--${segment.tone}" style="width:${clamp(segment.width)}%"></span>`).join("")}</span>`;

    // A real <button>: clickable and reachable by keyboard without a role/tabindex of our own.
    document.querySelector("[data-overview-metrics]").innerHTML = cards.map((c) => {
      const button = `
      <button type="button" class="ep-metric ep-metric--${c.tone}" data-overview-destination="${c.destination}"
        aria-label="${fmt.escape(c.title + (c.figure ? ": " + c.figure.value + c.figure.unit + " " + c.figure.caption : ", " + c.empty))}">
        <span class="ep-metric__head">
          <span class="ep-metric__chip">${c.icon || ""}</span>
          <span class="ep-metric__title">${fmt.escape(c.title)}</span>
          ${CHEVRON}
        </span>
        ${c.figure
          ? `<span class="ep-metric__figure"><span class="ep-metric__value">${fmt.escape(c.figure.value)}</span>` +
            `${c.figure.unit ? `<span class="ep-metric__unit">${fmt.escape(c.figure.unit)}</span>` : ""}` +
            `<span class="ep-metric__caption">${fmt.escape(c.figure.caption)}</span></span>`
          : `<span class="ep-metric__figure"><span class="ep-metric__empty">${fmt.escape(c.empty)}</span></span>`}
        ${c.subline ? `<span class="ep-metric__subline">${fmt.escape(c.subline)}</span>` : ""}
        ${meterHTML(c.meter)}
        <span class="ep-metric__legend">
          ${c.legend.map((item) => `<span class="ep-metric__stat">
            <span class="ep-hint-light${item.dot ? " ep-hint-light--" + item.dot : ""}"></span>
            <span class="ep-metric__stat-label">${fmt.escape(item.label)}</span>
            <b class="ep-metric__stat-value${item.bad ? " is-bad" : ""}">${item.value}</b>
          </span>`).join("")}
        </span>
      </button>`;
      return button;
    }).join("");
  }

  // ─── Plant Health ────────────────────────────────────────────────────
  function renderHealth({ rows, totals }) {
    document.querySelector("[data-health-summary]").innerHTML = `
      <div class="ep-kv">
        <div class="ep-kv__item"><span class="ep-kv__k">Total Open Issues</span><span class="ep-kv__v">${fmt.formatNumber(totals.openIssues)}</span></div>
        <div class="ep-kv__item"><span class="ep-kv__k">Total Closed Issues</span><span class="ep-kv__v">${fmt.formatNumber(totals.closedIssues)}</span></div>
        <div class="ep-kv__item"><span class="ep-kv__k">Critical Issues</span><span class="ep-kv__v">${fmt.formatNumber(totals.criticalIssues)}</span></div>
        <div class="ep-kv__item"><span class="ep-kv__k">Medium Issues</span><span class="ep-kv__v">${fmt.formatNumber(totals.mediumIssues)}</span></div>
        <div class="ep-kv__item"><span class="ep-kv__k">Plants with Open Issues</span><span class="ep-kv__v">${fmt.formatNumber(totals.plantsWithOpenIssues)}</span></div>
        <div class="ep-kv__item"><span class="ep-kv__k">Plants in Healthy State</span><span class="ep-kv__v">${fmt.formatNumber(totals.healthyPlants)}</span></div>
      </div>
    `;

    const body = rows.map(({ plant, profile }, i) => `
      <tr>
        <td class="num"><span class="ep-row-num">${i + 1}</span></td>
        <td>${plantCell(plant)}</td>
        <td>${conditionChip(profile.derivedCondition)}</td>
        <td class="num">${numCell(profile.openIssues)}</td>
        <td class="num">${numCell(profile.closedIssues)}</td>
        <td class="num">${numCell(profile.criticalIssues)}</td>
      </tr>
    `).join("");

    document.querySelector("[data-health-table-body]").innerHTML =
      body || `<tr><td colspan="6" class="ep-empty">No plants to show.</td></tr>`;
  }

  // ─── PM compliance ───────────────────────────────────────────────────
  function renderPMCompliance({ rows, totals }) {
    document.querySelector("[data-pm-summary]").innerHTML = `
      <div class="ep-kv">
        <div class="ep-kv__item"><span class="ep-kv__k">Portfolio PM Compliance</span><span class="ep-kv__v">${totals.pmCompliancePercent === null ? "N/A" : totals.pmCompliancePercent + "%"}</span></div>
        <div class="ep-kv__item"><span class="ep-kv__k">Completed</span><span class="ep-kv__v">${fmt.formatNumber(totals.pmCompleted)}</span></div>
        <div class="ep-kv__item"><span class="ep-kv__k">Pending</span><span class="ep-kv__v">${fmt.formatNumber(totals.pmPending)}</span></div>
        <div class="ep-kv__item"><span class="ep-kv__k">Overdue</span><span class="ep-kv__v">${fmt.formatNumber(totals.pmOverdue)}</span></div>
      </div>
    `;

    const sorted = rows.slice().sort((a, b) => {
      const av = (a.profile.pm && a.profile.pm.compliancePercent);
      const bv = (b.profile.pm && b.profile.pm.compliancePercent);
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return av - bv;
    });

    document.querySelector("[data-pm-table-body]").innerHTML = sorted.map(({ plant, profile }, i) => {
      const pm = profile.pm || {};
      return `
        <tr>
          <td class="num"><span class="ep-row-num">${i + 1}</span></td>
          <td>${plantCell(plant)}</td>
          <td class="num">${numCell(pm.completed)}</td>
          <td class="num">${numCell(pm.pending)}</td>
          <td class="num">${numCell(pm.overdue)}</td>
          <td>${complianceCell(pm.compliancePercent)}</td>
        </tr>
      `;
    }).join("");
  }

  // ─── Washing compliance ──────────────────────────────────────────────
  function renderWashingCompliance({ rows, totals }) {
    document.querySelector("[data-washing-summary]").innerHTML = `
      <div class="ep-kv">
        <div class="ep-kv__item"><span class="ep-kv__k">Portfolio Cleaning Compliance</span><span class="ep-kv__v">${Number(totals.washingCompliancePercent || 0).toFixed(1)}%</span></div>
        <div class="ep-kv__item"><span class="ep-kv__k">Completed Activities</span><span class="ep-kv__v">${fmt.formatNumber(totals.washingCompleted)}</span></div>
        <div class="ep-kv__item"><span class="ep-kv__k">Pending Activities</span><span class="ep-kv__v">${fmt.formatNumber(totals.washingPending)}</span></div>
        <div class="ep-kv__item"><span class="ep-kv__k">Overdue Activities</span><span class="ep-kv__v">${fmt.formatNumber(totals.washingOverdue)}</span></div>
        ${totals.washingWork && !totals.washingWork.due
          ? '<div class="ep-kv__item"><span class="ep-kv__k">Schedule</span><span class="ep-kv__v">No cleaning activities scheduled</span></div>'
          : ""}
      </div>
    `;

    const sorted = rows.slice().sort((a, b) => {
      const av = (a.profile.washing && a.profile.washing.compliancePercent);
      const bv = (b.profile.washing && b.profile.washing.compliancePercent);
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return av - bv;
    });

    document.querySelector("[data-washing-table-body]").innerHTML = sorted.map(({ plant, profile }, i) => {
      const w = profile.washing || {};
      return `
        <tr>
          <td class="num"><span class="ep-row-num">${i + 1}</span></td>
          <td>${plantCell(plant)}</td>
          <td class="num">${numCell(w.completed)}</td>
          <td class="num">${numCell(w.pending)}</td>
          <td class="num">${numCell(w.overdue)}</td>
          <td>${complianceCell(w.compliancePercent, 1)}</td>
        </tr>
      `;
    }).join("");
  }

  // ─── Plant-wise operational comparison ───────────────────────────────
  function renderComparison() {
    const term = searchTerm.trim().toLowerCase();
    const rows = state.rows.filter(({ plant }) => {
      if (!term) return true;
      return plant.plantName.toLowerCase().includes(term) ||
             plant.displayCode.toLowerCase().includes(term) ||
             plant.siteCode.toLowerCase().includes(term);
    });

    const sort = state.sort;
    const sorted = rows.slice().sort((a, b) => {
      const dir = sort.dir === "asc" ? 1 : -1;
      const value = (row) => {
        const p = row.profile;
        switch (sort.column) {
          case "name":     return row.plant.plantName.toLowerCase();
          case "health":   return ["critical", "attention", "healthy", "unknown"].indexOf(p.derivedCondition);
          case "open":     return p.openIssues === null ? Infinity * dir : p.openIssues;
          case "closed":   return p.closedIssues === null ? Infinity * dir : p.closedIssues;
          case "pm":       return (p.pm && p.pm.compliancePercent) === null ? Infinity * dir : p.pm.compliancePercent;
          case "washing":  return (p.washing && p.washing.compliancePercent) === null ? Infinity * dir : p.washing.compliancePercent;
          default:         return 0;
        }
      };
      const av = value(a), bv = value(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      return 0;
    });

    document.querySelector("[data-comparison-body]").innerHTML = sorted.map(({ plant, profile }, i) => `
      <tr>
        <td class="num"><span class="ep-row-num">${i + 1}</span></td>
        <td>${plantCell(plant)}</td>
        <td>${conditionChip(profile.derivedCondition)}</td>
        <td class="num">${numCell(profile.openIssues)}</td>
        <td class="num">${numCell(profile.closedIssues)}</td>
        <td>${complianceCell(profile.pm && profile.pm.compliancePercent)}</td>
        <td>${complianceCell(profile.washing && profile.washing.compliancePercent, 1)}</td>
        <td class="num">
          <button class="ep-link-btn" data-open-plant="${plant.siteCode}">Open →</button>
        </td>
      </tr>
    `).join("") || `<tr><td colspan="8" class="ep-empty">No plants match this search.</td></tr>`;

    // Sort indicator state on the headers.
    document.querySelectorAll("[data-comparison-sort]").forEach((th) => {
      th.setAttribute("data-dir", th.getAttribute("data-comparison-sort") === sort.column ? sort.dir : "");
    });
  }

  // ─── Critical Issues panel ───────────────────────────────────────────
  function renderCritical({ rows }) {
    const flagged = rows
      .filter(({ profile }) => (profile.criticalIssues || 0) > 0 || profile.derivedCondition === "critical")
      .sort((a, b) => (b.profile.criticalIssues || 0) - (a.profile.criticalIssues || 0));

    const body = flagged.map(({ plant, profile }, i) => `
      <tr>
        <td class="num"><span class="ep-row-num">${i + 1}</span></td>
        <td>${plantCell(plant)}</td>
        <td class="num">${numCell(profile.openIssues)}</td>
        <td class="num">${numCell(profile.criticalIssues)}</td>
        <td class="num">${numCell(profile.mediumIssues)}</td>
        <td>${conditionChip(profile.derivedCondition)}</td>
      </tr>
    `).join("");

    document.querySelector("[data-critical-body]").innerHTML = body ||
      `<tr><td colspan="6" class="ep-empty"><div class="ep-empty__title">No plants require urgent attention.</div>Every plant is below the critical threshold.</td></tr>`;
  }

  // ─── Recent activity ─────────────────────────────────────────────────
  function renderActivity({ rows }) {
    const host = document.querySelector("[data-activity-body]");
    if (!host) return;
    const codes = new Set(rows.map(({ plant }) => plant.siteCode));
    const draw = (items) => {
      const slice = items
        .filter((item) => !item.plantSiteCode || codes.has(item.plantSiteCode))
        .slice(0, 12);
      host.innerHTML = slice.map((item) => `
      <div class="ep-activity__row">
        <div>
          <div class="ep-activity__title">${fmt.escape(item.title)}</div>
          <div class="ep-activity__sub">${fmt.escape(item.plantName || "")} · <span class="ep-plant-cell__code">${fmt.escape(item.plantSiteCode || "")}</span></div>
        </div>
        <div class="ep-activity__meta">
          <div>${fmt.relativeTime(item.at)}</div>
          <div><span class="ep-chip ep-chip--grey">${fmt.escape(item.status)}</span></div>
        </div>
      </div>
    `).join("") || `<div class="ep-empty">No recent activity to show.</div>`;
    };
    if (activityCache) { draw(activityCache); return; }
    host.innerHTML = `<div class="ep-empty">Loading recent activity…</div>`;
    data.fetchActivity(null, null, 40).then((items) => {
      activityCache = items;
      draw(items);
    }).catch((error) => {
      host.innerHTML = `<div class="ep-empty">Recent activity could not be loaded: ${fmt.escape(error.message)}</div>`;
    });
  }

  // ─── Public entry point ──────────────────────────────────────────────
  let rendered = false;
  function render() {
    if (!state) return;
    if (global.Solar91Perf && global.Solar91Perf.enabled) {
      global.Solar91Perf.time("render overview tiles", () => renderTiles(state.totals));
    } else {
      renderTiles(state.totals);
    }
    rendered = true;
  }

  function wireInteractions() {
    const metrics = document.querySelector("[data-overview-metrics]");
    function openMetricDestination(card) {
      if (!state || !state.rangeStart || !state.rangeEnd) return;
      const destination = card.getAttribute("data-overview-destination");
      const dateRange = { startDate: state.rangeStart, endDate: state.rangeEnd };
      if (destination === "inverters") {
        openInverterHealth();
        return;
      }
      if (destination === "strings") {
        openStringHealth();
        return;
      }
      if (destination === "washing") {
        global.Solar91WashingBoardPrefill = {
          plant: filters.plant,
          cycle: "all"
        };
        global.Solar91PortalNav.selectView(destination, dateRange);
        return;
      }
      if (filters.plant !== "__all") {
        const row = state.allRows.find(({ plant }) => plant.siteCode === filters.plant);
        if (row) global.Solar91PortalNav.selectPlantPage(filters.plant, destination, dateRange, row.plant);
      } else {
        global.Solar91PortalNav.selectView(destination, dateRange);
      }
    }
    if (metrics) {
      metrics.addEventListener("click", (ev) => {
        const card = ev.target.closest("[data-overview-destination]");
        if (card) openMetricDestination(card);
      });
      metrics.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        const card = ev.target.closest("[data-overview-destination]");
        // A <button> already fires a click for Enter and Space; handling the key here as well
        // would open the destination twice.
        if (!card || card.tagName === "BUTTON") return;
        ev.preventDefault();
        openMetricDestination(card);
      });
    }

    document.addEventListener("click", (ev) => {
      // Comparison column header sort.
      const sortHeader = ev.target.closest("[data-comparison-sort]");
      if (sortHeader && state) {
        const col = sortHeader.getAttribute("data-comparison-sort");
        if (state.sort.column === col) {
          state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
        } else {
          state.sort = { column: col, dir: "asc" };
        }
        renderComparison();
      }
    });

    const search = document.querySelector("[data-comparison-search]");
    if (search) {
      search.addEventListener("input", (ev) => {
        searchTerm = ev.target.value || "";
        renderComparison();
      });
      const clear = document.querySelector("[data-comparison-search-clear]");
      if (clear) clear.addEventListener("click", () => { search.value = ""; searchTerm = ""; renderComparison(); search.focus(); });
    }
  }

  // ─── Loading, failure and refresh ────────────────────────────────────
  const REFRESH_AFTER_MS = 60 * 1000;   // same freshness window as the data caches (data-adapter.js)
  let lastLoadedAt = 0;
  let loadingPortfolio = false;
  let refreshingPortfolio = false;
  let portfolioRefreshId = 0;
  let pollTimer = null;
  let pollInFlight = false;
  let pollBackoffMs = REFRESH_AFTER_MS;
  let localRefreshPending = false;

  function overviewNotice(html, kind) {
    const metrics = document.querySelector("[data-overview-metrics]");
    if (!metrics || !metrics.parentNode) return;
    let notice = document.querySelector("[data-overview-notice]");
    if (!html) { if (notice) notice.remove(); return; }
    if (!notice) {
      notice = document.createElement("div");
      notice.setAttribute("data-overview-notice", "");
      metrics.parentNode.insertBefore(notice, metrics);
    }
    notice.className = "ep-overview-notice" + (kind === "error" ? " is-error" : "");
    notice.setAttribute("role", kind === "error" ? "alert" : "status");
    notice.innerHTML = html;
  }

  function stampDataTime(asOf) {
    const el = document.querySelector("[data-last-updated]");
    const when = asOf ? new Date(asOf) : new Date();
    if (!el || isNaN(when.getTime())) return;
    el.textContent = "Updated " + new Intl.DateTimeFormat("en-IN", {
      hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short"
    }).format(when);
    el.title = "When these figures were read from the database";
  }

  function showWarnings(warnings) {
    if ((warnings || []).indexOf("washing_unavailable") !== -1) {
      overviewNotice("Module cleaning figures could not be read just now, so they show as not available. " +
        '<button type="button" data-overview-retry>Retry</button>', "warning");
    } else {
      overviewNotice("");
    }
  }

  /** Read the portfolio. `refresh` = data already on screen is being brought up to date (filters and period kept). */
  function loadPortfolio(refresh) {
    if (loadingPortfolio) return;
    loadingPortfolio = true;
    if (refresh) data.invalidate();
    // One request opens the page. It carries the plants (for the filters), the business date
    // (for the date controls) and the figures for the period the Range selector starts on, so
    // the whole portfolio no longer has to be read first just to learn today's date.
    const period = (document.querySelector('[data-filter="date"]') || {}).value || DEFAULT_PERIOD;
    data.fetchPortfolioPeriod(period, !!refresh).then((portfolio) => {
      loadingPortfolio = false;
      lastLoadedAt = Date.now();
      const first = !state;
      if (first) {
        state = {
          allRows: portfolio.rows,
          periodRows: portfolio.rows,
          rows: portfolio.rows,
          totals: portfolio.totals,
          businessDate: portfolio.businessDate,
          dataVersion: portfolio.dataVersion,
          sort: { column: "health", dir: "asc" }
        };
      } else {
        state.allRows = portfolio.rows;
        state.periodRows = portfolio.rows;
        state.businessDate = portfolio.businessDate || state.businessDate;
        state.dataVersion = portfolio.dataVersion || state.dataVersion;
        activityCache = null;
      }
      // The dates this period resolved to, recorded so the Range selector agrees with the
      // figures on screen and does not read the same period again.
      state.rangeStart = portfolio.startDate;
      state.rangeEnd = portfolio.endDate;
      rangeKey = portfolio.startDate + ":" + portfolio.endDate;
      populateFilterOptions(portfolio.rows, first);
      rangeStatus("Showing results from " + portfolio.startDate + " to " + portfolio.endDate + ".", false);
      recomputeAndRender();
      stampDataTime(portfolio.asOf);
      showWarnings(portfolio.warnings);
      updatePortfolioPoller(REFRESH_AFTER_MS);
      if (localRefreshPending && overviewIsShowing() && document.visibilityState === "visible" &&
          !userIsBusy()) {
        localRefreshPending = false;
        refreshPortfolioInPlace(false);
      }
      if (global.Solar91Perf) global.Solar91Perf.mark("overview_usable");
    }).catch((error) => {
      loadingPortfolio = false;
      const message = "The Overview could not be loaded: " + fmt.escape((error && error.message) || "please retry.") +
        ' <button type="button" data-overview-retry>Retry</button>';
      if (!state) {
        const metrics = document.querySelector("[data-overview-metrics]");
        if (metrics) metrics.innerHTML = "";
      }
      overviewNotice(message, "error");
    });
  }

  function refreshPortfolioInPlace(background, version) {
    if (!state || !state.rangeStart || !state.rangeEnd) {
      localRefreshPending = true;
      return Promise.resolve();
    }
    if (refreshingPortfolio) {
      if (!background) localRefreshPending = true;
      return Promise.resolve();
    }
    const startDate = state.rangeStart;
    const endDate = state.rangeEnd;
    const requestId = ++portfolioRefreshId;
    refreshingPortfolio = true;
    data.invalidate();
    let updated = false;
    return data.fetchPortfolioRange(startDate, endDate).then((portfolio) => {
      if (requestId !== portfolioRefreshId || !overviewIsShowing() ||
          state.rangeStart !== startDate || state.rangeEnd !== endDate) return;
      state.allRows = portfolio.rows;
      state.periodRows = portfolio.rows;
      state.businessDate = portfolio.businessDate || state.businessDate;
      state.dataVersion = portfolio.dataVersion || version || state.dataVersion;
      state.rows = applyFilters(state.periodRows);
      state.totals = data.aggregatePortfolio(state.rows);
      activityCache = null;
      lastLoadedAt = Date.now();
      render();
      stampDataTime(portfolio.asOf);
      showWarnings(portfolio.warnings);
      updated = true;
    }).catch((error) => {
      if (!background && requestId === portfolioRefreshId) {
        overviewNotice("The Dashboard could not be refreshed after the update. " +
          '<button type="button" data-overview-retry>Retry</button>', "warning");
        if (global.console && global.console.warn) {
          global.console.warn("Dashboard refresh after a local update failed.", error);
        }
      }
      if (global.console && global.console.warn && background) {
        global.console.warn("Background Dashboard refresh failed; keeping the current figures.", error);
      }
    }).then(() => {
      if (requestId === portfolioRefreshId) refreshingPortfolio = false;
      if (overviewIsShowing() && document.visibilityState === "visible") {
        updatePortfolioPoller(REFRESH_AFTER_MS);
      }
      if (localRefreshPending && document.visibilityState === "visible" &&
          overviewIsShowing() && !userIsBusy()) {
        localRefreshPending = false;
        refreshPortfolioInPlace(false);
      }
      return updated;
    });
  }

  // Something open or being typed into must never be replaced under the user.
  function userIsBusy() {
    const focused = document.activeElement;
    if (focused && focused.matches && focused.matches("input, textarea, select, [contenteditable='true']")) return true;
    return !!document.querySelector(".ep-pd__overlay, [role='dialog'][aria-modal='true'], .ep-issues__drawer");
  }

  function overviewIsShowing() {
    const metrics = document.querySelector("[data-overview-metrics]");
    return !!(metrics && metrics.offsetParent !== null);
  }

  function stopPortfolioPoller() {
    if (pollTimer !== null) global.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePortfolioPoll(delay) {
    stopPortfolioPoller();
    if (!state || document.visibilityState !== "visible" || !overviewIsShowing()) return;
    pollTimer = global.setTimeout(checkPortfolioVersion, delay);
  }

  function checkPortfolioVersion() {
    pollTimer = null;
    if (!state || document.visibilityState !== "visible" || !overviewIsShowing() || pollInFlight) return;
    pollInFlight = true;
    data.fetchOverviewVersion().then((version) => {
      pollInFlight = false;
      if (!state || document.visibilityState !== "visible" || !overviewIsShowing()) return;
      if (version !== state.dataVersion && !userIsBusy()) {
        return refreshPortfolioInPlace(true, version).then((updated) => {
          pollBackoffMs = updated ? REFRESH_AFTER_MS : Math.min(5 * 60 * 1000, pollBackoffMs * 2);
          schedulePortfolioPoll(pollBackoffMs);
        });
      }
      pollBackoffMs = REFRESH_AFTER_MS;
      schedulePortfolioPoll(REFRESH_AFTER_MS);
    }).catch(() => {
      pollInFlight = false;
      if (!state || document.visibilityState !== "visible" || !overviewIsShowing()) return;
      pollBackoffMs = Math.min(5 * 60 * 1000, pollBackoffMs * 2);
      schedulePortfolioPoll(pollBackoffMs);
    });
  }

  function updatePortfolioPoller(delay) {
    if (!overviewIsShowing() || document.visibilityState !== "visible") {
      stopPortfolioPoller();
      return;
    }
    schedulePortfolioPoll(delay);
  }

  function wireVisibilityRefresh() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") {
        stopPortfolioPoller();
        return;
      }
      if (!overviewIsShowing()) return;
      if (localRefreshPending && !userIsBusy()) {
        localRefreshPending = false;
        refreshPortfolioInPlace(false);
      } else {
        checkPortfolioVersion();
      }
    });
    document.addEventListener("portal:route-changed", () => {
      if (!overviewIsShowing()) {
        stopPortfolioPoller();
        return;
      }
      if (localRefreshPending && !userIsBusy()) {
        localRefreshPending = false;
        refreshPortfolioInPlace(false);
      } else {
        checkPortfolioVersion();
      }
    });
    document.addEventListener("portal:data-invalidated", () => {
      localRefreshPending = true;
      if (document.visibilityState === "visible" && overviewIsShowing() && !userIsBusy()) {
        localRefreshPending = false;
        refreshPortfolioInPlace(false);
      }
    });
    document.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-overview-retry]")) loadPortfolio(true);
    });
    global.addEventListener("pagehide", stopPortfolioPoller);
  }

  function init() {
    wireInteractions();
    wireInverterHealth();
    wireStringHealth();
    wireVisibilityRefresh();
    loadPortfolio(false);
    loadInverters();
    loadStrings();
  }

  global.Solar91PortalOverview = {
    init,
    rerender: render,
    get isRendered() { return rendered; },
    // Called by site-issues.js after a Breakdown ticket is saved, so the inverter tile and
    // drill-down reflect the new ticket without a full page reload.
    refreshInverterHealth() {
      inverters.loaded = false;
      return loadInverters(true).then(() => {
        if (inverterPanel && inverterPanel.isOpen()) inverterPanel.reload();
      });
    },
    refreshStringHealth() {
      strings.loaded = false;
      return loadStrings(true).then(() => {
        if (stringPanel && stringPanel.isOpen()) stringPanel.reload();
      });
    }
  };
}(window));