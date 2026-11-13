/**
 * overview.js
 * ─────────────────────────────────────────────────────────────────────
 * The portfolio-wide Overview tab.
 *
 * Three summary tiles — PM compliance, Washing compliance, Open site issues.
 *
 * The Range selector in the filter bar is the single source of truth:
 * `applyRange` records the dates on `state` and then refreshes the tiles
 * from them.
 *
 * The plant / project / district filters narrow the tiles to the selected
 * plants, while each filter keeps its full set of available options.
 */
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

  function isInverter(name) { return String(name || "").trim().toLowerCase() === INVERTER; }

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
    const scoped = (row) => !row.siteCode || codes.has(row.siteCode);
    let total = 0;
    let plantsWithUnits = 0;
    inverters.units.forEach((row) => {
      if (!isInverter(row.equipment_type) || !scoped(row)) return;
      total += Number(row.total_units) || 0;
      plantsWithUnits += 1;
    });
    let down = 0;
    let tickets = 0;
    let affected = 0;
    inverters.issues.forEach((row) => {
      if (row.site_code && !codes.has(row.site_code)) return;   // outside the filtered plants
      tickets += Number(row.open) || 0;
      down += Number(row.units) || 0;
      affected += 1;
    });
    if (total) down = Math.min(down, total);
    return {
      total: total,
      down: down,
      running: total ? total - down : null,
      tickets: tickets,
      plants: affected,
      configured: plantsWithUnits > 0,
      restricted: inverters.unitsRestricted
    };
  }

  /** One request each, both optional: the tile degrades to what the role may read. */
  function loadInverters() {
    const api = global.Solar91PortalAPI;
    if (!api || inverters.loaded) return;
    inverters.loaded = true;
    // The unit configuration is open to the O&M Head and Assignees only; other roles still
    // get the open-ticket half of the tile.
    api.request("/api/pm-plan/unit-config").then((body) => {
      inverters.units = (body && body.configs) || [];
      render();
    }).catch(() => {
      inverters.unitsRestricted = true;
      render();
    });
    // Counts per plant, not the tickets themselves: the tile needs how many units are affected.
    api.request("/api/issues/equipment-summary?vertical=Inverter").then((body) => {
      inverters.issues = (body && body.plants) || [];
      render();
    }).catch(() => {});
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

  function complianceCell(pct) {
    if (pct === null || pct === undefined) {
      return `<span class="ep-bar"><span class="ep-bar__value ep-bar__value--grey">N/A</span></span>`;
    }
    const colour = pct >= 85 ? "green" : pct >= 70 ? "amber" : "red";
    return (
      `<span class="ep-bar">` +
        `<span class="ep-bar__track"><span class="ep-bar__fill ep-bar__fill--${colour}" style="width:${pct}%"></span></span>` +
        `<span class="ep-bar__value">${pct}%</span>` +
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
    const wshPct  = totals.washingCompliancePercent;
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

    const pmP  = pill("PM", pmPct, totals.pmOverdue);
    const wshP = pill("Module Cleaning", wshPct, totals.washingOverdue);
    const isP  = issuePill(totals.criticalIssues, openIss);

    const ICON_PM = `<svg class="ep-metric__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M16 2v4M8 2v4M3 10h18"></path><path d="m9 16 2 2 4-4"></path></svg>`;
    const ICON_WASH = `<svg class="ep-metric__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"></path><path d="M6 8h12l-1.5 12h-9L6 8z"></path><path d="M4.22 10.22A8 8 0 0 0 12 22a8 8 0 0 0 7.78-11.78"></path></svg>`;
    const ICON_INVERTER = `<svg class="ep-metric__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M13 7l-4 6h3l-1 4 4-6h-3l1-4z"></path></svg>`;
    const ICON_ISSUES = `<svg class="ep-metric__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

    const cards = [
      {
        title: "PM Compliance",
        destination: "pm",
        icon: ICON_PM,
        value: pmPct === null ? "—" : pmPct + "%",
        pill: pmP,
        hints: [
          { strong: true,  dot: "green", text: `${fmt.formatNumber(totals.pmCompleted)} completed activities` },
          { strong: false, dot: totals.pmOverdue > 0 ? "red" : "amber", text: `${fmt.formatNumber(totals.pmPending)} pending · ${fmt.formatNumber(totals.pmOverdue)} overdue` }
        ]
      },
      {
        title: "Module Cleaning Compliance",
        destination: "washing",
        icon: ICON_WASH,
        value: wshPct === null ? "—" : wshPct + "%",
        pill: wshP,
        hints: [
          { strong: true,  dot: "green", text: `${fmt.formatNumber(totals.washingCompleted)} cycles done` },
          { strong: false, dot: totals.washingOverdue > 0 ? "red" : "amber", text: `${fmt.formatNumber(totals.washingPending)} pending · ${fmt.formatNumber(totals.washingOverdue)} overdue` }
        ]
      },
      {
        title: "Inverters",
        destination: "inverters",
        icon: ICON_INVERTER,
        value: inv.total
          ? fmt.formatNumber(inv.running) + " / " + fmt.formatNumber(inv.total)
          : (inv.tickets ? fmt.formatNumber(inv.tickets) : "—"),
        pill: inverterPill,
        hints: inv.total
          ? [
            { strong: true, dot: inv.down > 0 ? "red" : "green",
              text: fmt.formatNumber(inv.running) + " running · " + fmt.formatNumber(inv.down) + " not running" },
            { strong: false,
              text: fmt.formatNumber(inv.tickets) + " open inverter issues · " +
                fmt.formatNumber(inv.plants) + " plants affected" }
          ]
          : [
            { strong: true, dot: inv.tickets > 0 ? "red" : "green",
              text: fmt.formatNumber(inv.tickets) + " open inverter issues" },
            { strong: false,
              text: inv.restricted
                ? "Unit counts are not available to your role"
                : "No inverter units configured for these plants" }
          ]
      },
      {
        title: "Open Site Issues",
        destination: "health",
        icon: ICON_ISSUES,
        value: fmt.formatNumber(openIss),
        pill: isP,
        hints: [
          { strong: true,  dot: totals.unsolvedIssues > 0 ? "red" : "green", text: `${fmt.formatNumber(totals.unsolvedIssues)} unsolved · ${fmt.formatNumber(totals.inProgressIssues)} in progress` },
          { strong: false, text: `${fmt.formatNumber(totals.closedIssues)} closed to date · ${fmt.formatNumber(totals.plantsWithOpenIssues)} plants affected` }
        ]
      }
    ];

    document.querySelector("[data-overview-metrics]").innerHTML = cards.map((c) => `
      <div class="ep-metric" role="link" tabindex="0" data-overview-destination="${c.destination}" aria-label="${fmt.escape(c.title)}">
        <div class="ep-metric__head">
          <span class="ep-metric__title">${c.icon || ""}${fmt.escape(c.title)}</span>
        </div>
        <div class="ep-metric__value">${c.value}</div>
        <div class="ep-metric__hints">
          ${c.hints.map((h) => `<span class="${h.strong ? "ep-metric__hint-strong" : "ep-metric__hint"}">${h.dot ? `<span class="ep-hint-light ep-hint-light--${h.dot}"></span>` : ""}${fmt.escape(h.text)}</span>`).join("")}
        </div>
      </div>
    `).join("");
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
        <div class="ep-kv__item"><span class="ep-kv__k">Portfolio Module Cleaning Compliance</span><span class="ep-kv__v">${totals.washingCompliancePercent === null ? "N/A" : totals.washingCompliancePercent + "%"}</span></div>
        <div class="ep-kv__item"><span class="ep-kv__k">Completed Cycles</span><span class="ep-kv__v">${fmt.formatNumber(totals.washingCompleted)}</span></div>
        <div class="ep-kv__item"><span class="ep-kv__k">Pending Cycles</span><span class="ep-kv__v">${fmt.formatNumber(totals.washingPending)}</span></div>
        <div class="ep-kv__item"><span class="ep-kv__k">Overdue Cycles</span><span class="ep-kv__v">${fmt.formatNumber(totals.washingOverdue)}</span></div>
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
          <td>${complianceCell(w.compliancePercent)}</td>
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
        <td>${complianceCell(profile.washing && profile.washing.compliancePercent)}</td>
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
      // The inverter tile opens the same site-issues page, showing inverter tickets only.
      if (destination === "inverters") {
        // The register's script is fetched on first use, so the preset is set once it is there.
        const openRegister = () => {
          if (global.Solar91PortalIssues) global.Solar91PortalIssues.presetEquipment("Inverter");
          if (filters.plant !== "__all") {
            const inverterRow = state.allRows.find(({ plant }) => plant.siteCode === filters.plant);
            if (inverterRow) {
              global.Solar91PortalNav.selectPlantPage(filters.plant, "health", dateRange, inverterRow.plant);
            }
          } else {
            global.Solar91PortalNav.selectView("health", dateRange);
          }
        };
        if (global.Solar91Modules) global.Solar91Modules.load("site-issues").then(openRegister).catch(openRegister);
        else openRegister();
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
        if (!card) return;
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
          sort: { column: "health", dir: "asc" }
        };
      } else {
        state.allRows = portfolio.rows;
        state.periodRows = portfolio.rows;
        state.businessDate = portfolio.businessDate || state.businessDate;
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

  // A tab left in the background makes no requests. When it comes back after the data has gone stale, the
  // Overview (only if it is the page on screen and nothing is being edited) reads its figures again.
  function wireVisibilityRefresh() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || !state || !lastLoadedAt) return;
      if (Date.now() - lastLoadedAt < REFRESH_AFTER_MS || !overviewIsShowing() || userIsBusy()) return;
      loadPortfolio(true);
    });
    document.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-overview-retry]")) loadPortfolio(true);
    });
  }

  function init() {
    wireInteractions();
    wireVisibilityRefresh();
    loadPortfolio(false);
    loadInverters();
  }

  global.Solar91PortalOverview = {
    init,
    rerender: render,
    get isRendered() { return rendered; }
  };
}(window));