
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

  const inverterHealth = {
    open: false, loading: false, units: [], summary: null, tickets: [],
    unitsRestricted: false, unitsError: "", summaryError: "", ticketsError: "",
    canEdit: false, plantFilter: "", search: "", severity: "", status: "",
    plantSearch: "", onlyIssues: false,   // the per-plant table's own toolbar
    saveMessage: "", saveError: false, navigationError: "",
    expanded: [],  // site codes whose open inverter tickets are unfolded under the plant row
    plantSort: { key: "", dir: "" }   // empty: the default order (worst running % first)
  };

  // The per-plant health table, laid out like the Health register: sortable headings, short and
  // numeric columns centred. `sort` reads the value ordered by -- the number, not the HTML.
  // Five columns on screen, not eight: maker and capacity share the Inverter cell, running and
  // total share the Running cell. The CSV below still exports every field separately.
  const INVERTER_PLANT_COLUMNS = [
    { key: "plant", label: "Plant", sort: (row) => row.plant.siteCode },
    { key: "inverter", label: "Inverter", sort: (row) => (row.config && row.config.maker) || "" },
    { key: "running", label: "Running", align: "num", sort: (row) => row.running },
    { key: "issuedesc", label: "Issue description", sort: (row) => row.issueDesc || "" },
    { key: "percent", label: "Health", align: "num", sort: (row) => row.percent },
    { key: "tickets", label: "Tickets", align: "num", sort: (row) => row.tickets }
  ];
  const INVERTER_PLANT_COLUMN_COUNT = INVERTER_PLANT_COLUMNS.length;
  const ICON_INVERTER_LARGE = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M13 7l-4 6h3l-1 4 4-6h-3l1-4z"></path></svg>`;
  const INVERTER_HISTORY_KEY = "solar91InverterHealthOpen";
  const OPEN_INVERTER_STATUSES = [
    "Open", "Assigned", "Acknowledged", "In Progress", "Pending Vendor", "Pending Parts/Vendor", "Pending Closure"
  ];

  function inverterPlantScope() {
    return state ? state.rows.map(({ plant }) => plant) : [];
  }

  function inverterScopeLabel() {
    const parts = [];
    const selected = filters.plant !== "__all" && state
      ? state.allRows.find(({ plant }) => plant.siteCode === filters.plant) : null;
    if (selected) {
      parts.push(selected.plant.displayName || selected.plant.plantName);
      if (filters.health !== "__all") {
        const labels = { healthy: "Healthy", attention: "Attention required", critical: "Critical", unknown: "Not available" };
        parts.push("Health: " + (labels[filters.health] || filters.health));
      }
    } else {
      parts.push("All plants");
      if (filters.company !== "__all") parts.push("SPV: " + filters.company);
      if (filters.district !== "__all") parts.push("District: " + filters.district);
      if (filters.health !== "__all") {
        const labels = { healthy: "Healthy", attention: "Attention required", critical: "Critical", unknown: "Not available" };
        parts.push("Health: " + (labels[filters.health] || filters.health));
      }
    }
    return parts.join(" · ");
  }

  function inverterDetailsPlant(issue) {
    const match = state && state.allRows.find(({ plant }) =>
      String(plant.id || plant.dbId || "") === String(issue.plant_id || ""));
    if (match) return match.plant;
    return null;
  }

  function inverterHealthTotals() {
    const plants = inverterPlantScope();
    const codes = new Set(plants.map((plant) => plant.siteCode));
    const configs = new Map();
    inverterHealth.units.forEach((config) => {
      if (!isInverter(config.equipment_type) || !codes.has(config.site_code)) return;
      configs.set(config.site_code, config);
    });
    const plantCounts = new Map();
    (inverterHealth.summary && inverterHealth.summary.plants || []).forEach((row) => {
      if (!row.site_code || codes.has(row.site_code)) plantCounts.set(row.site_code, row);
    });
    const ticketCounts = new Map();
    inverterHealth.tickets.forEach((ticket) => {
      const plant = inverterDetailsPlant(ticket);
      const code = plant ? plant.siteCode : "";
      if (!code || !codes.has(code)) return;
      const count = ticketCounts.get(code) || { open: 0, units: 0 };
      count.open += 1;
      // Only count units toward "down" when equipment_running is explicitly false (Breakdown).
      // Running (true) or unset (null) tickets are open but do NOT reduce the running count.
      if (ticket.equipment_running === false) {
        count.units += ticket.unit_count == null ? 1 : Number(ticket.unit_count) || 0;
      }
      ticketCounts.set(code, count);
    });

    const issueRows = inverterHealth.summary
      ? Array.from(plantCounts.entries()).map(([site_code, row]) => Object.assign({ site_code }, row))
      : Array.from(ticketCounts.entries()).map(([site_code, row]) => Object.assign({ site_code }, row));
    const counts = calculateInverterTotals(codes, inverterHealth.units, issueRows);
    return Object.assign({}, counts, { affected: counts.plants, configs, plantCounts, ticketCounts });
  }

  function inverterHealthUrl() {
    const codes = inverterPlantScope().map((plant) => plant.siteCode);
    let url = "/api/issues?vertical=Inverter&status=open&limit=200";
    if (codes.length === 1) url += "&site_code=" + encodeURIComponent(codes[0]);
    return url;
  }

  function loadInverterHealth() {
    const api = global.Solar91PortalAPI;
    if (!api) {
      inverterHealth.ticketsError = "Solar91 sign-in is not ready. Reload the page and try again.";
      inverterHealth.loading = false;
      renderInverterHealth();
      return;
    }
    inverterHealth.loading = true;
    inverterHealth.unitsError = "";
    inverterHealth.summaryError = "";
    inverterHealth.ticketsError = "";
    renderInverterHealth();
    const scopeCodes = new Set(inverterPlantScope().map((plant) => plant.siteCode));
    // The tile already holds the unit configuration and the per-plant ticket counts, and this
    // drill-down is opened from that tile. Reuse them rather than asking for the same two
    // answers again: the figures must match the tile anyway, and a refetch could only make
    // them disagree. Only the ticket list below is genuinely new.
    const unitRequest = inverters.loaded && (inverters.units.length || inverters.unitsRestricted)
      ? Promise.resolve().then(() => {
        inverterHealth.units = inverters.units.filter((row) =>
          isInverter(row.equipment_type) && scopeCodes.has(row.site_code));
        inverterHealth.unitsRestricted = inverters.unitsRestricted;
      })
      : api.request("/api/pm-plan/unit-config").then((body) => {
        inverters.units = (body && body.configs) || [];
        inverters.loaded = true;
        inverterHealth.units = inverters.units.filter((row) =>
          isInverter(row.equipment_type) && scopeCodes.has(row.site_code));
        inverterHealth.unitsRestricted = false;
      }).catch((error) => {
        inverterHealth.units = [];
        inverterHealth.unitsRestricted = error && error.status === 403;
        inverterHealth.unitsError = inverterHealth.unitsRestricted
          ? "" : "Inverter unit counts could not be loaded: " + ((error && error.message) || "please retry.");
      });
    const summaryRequest = inverters.loaded && inverters.issues.length
      ? Promise.resolve().then(() => { inverterHealth.summary = { plants: inverters.issues }; })
      : api.request("/api/issues/equipment-summary?vertical=Inverter").then((body) => {
        inverters.issues = (body && body.plants) || [];
        inverterHealth.summary = body || { plants: [] };
      }).catch((error) => {
        inverterHealth.summary = null;
        inverterHealth.summaryError = "Inverter ticket totals could not be loaded: " +
          ((error && error.message) || "showing the tickets returned below.");
      });
    const ticketRequest = api.request(inverterHealthUrl()).then((rows) => {
      inverterHealth.tickets = Array.isArray(rows) ? rows : [];
    }).catch((error) => {
      inverterHealth.tickets = [];
      inverterHealth.ticketsError = "Open inverter tickets could not be loaded: " +
        ((error && error.message) || "please retry.");
    });
    const roleRequest = api.session().then((session) => {
      const role = session && session.user && session.user.role;
      inverterHealth.canEdit = role === "O&M Head" || role === "Assignee";
    }).catch(() => { inverterHealth.canEdit = false; });
    Promise.all([unitRequest, summaryRequest, ticketRequest, roleRequest]).then(() => {
      inverterHealth.loading = false;
      renderInverterHealth();
    });
  }

  function inverterSeverityChip(severity) {
    const value = String(severity || "Low");
    const cls = value.toLowerCase() === "critical" ? "ep-chip--critical"
      : value.toLowerCase() === "high" ? "ep-chip--attention"
        : value.toLowerCase() === "medium" ? "ep-chip--grey" : "ep-chip--healthy";
    return `<span class="ep-chip ${cls}">${fmt.escape(value)}</span>`;
  }

  function inverterPercentCell(percent) {
    if (percent === null) return `<span class="ep-text-faint">—</span>`;
    const tone = percent >= 85 ? "green" : percent >= 70 ? "amber" : "red";
    return `<span class="ep-bar"><span class="ep-bar__track"><span class="ep-bar__fill ep-bar__fill--${tone}" style="width:${percent}%"></span></span><span class="ep-bar__value">${percent}%</span></span>`;
  }

  // One plant's down inverters, unfolded under its row: unit, sub-problem, description -- the
  // Health register's own facts -- plus the ticket and, for the roles that may, its Edit. One
  // full-width row, so the table (and its CSV) keeps one line per plant.
  function inverterDownRows(siteCode, tickets) {
    const items = tickets.map((ticket) => `<li class="ep-ih__down">
      <span class="ep-ih__down-unit">${fmt.escape(ticket.serial_no || "Unit not recorded")}</span>
      <span class="ep-ih__down-sub">${fmt.escape(ticket.subcategory || "—")}</span>
      <span class="ep-ih__description" title="${fmt.escape(ticket.description || "")}">${fmt.escape(ticket.description || "—")}</span>
      ${inverterSeverityChip(ticket.severity)}
      <span class="ep-ih__ticket-actions"><button type="button" class="ep-ih__ticket" data-ih-ticket="${fmt.escape(ticket.ticket_no || "")}" data-ih-site="${fmt.escape(siteCode)}">${fmt.escape(ticket.ticket_no || "Open ticket")}</button>
        ${inverterHealth.canEdit ? `<button type="button" class="ep-ih__button" data-ih-edit="${fmt.escape(ticket.ticket_no || "")}" data-ih-site="${fmt.escape(siteCode)}">Edit</button>` : ""}</span>
    </li>`).join("");
    return `<tr class="ep-ih__down-row"><td colspan="${INVERTER_PLANT_COLUMN_COUNT}"><ul class="ep-ih__down-list">${items}</ul></td></tr>`;
  }

  // The open inverter tickets of every plant in scope, grouped in ONE pass -- a plant missing
  // from the map has none, and so cannot be unfolded. Built once per render, not once per row.
  function inverterTicketsByPlant() {
    const byPlant = new Map();
    scopedInverterTickets().forEach((ticket) => {
      if (ticket.equipment_running !== false) return;
      const plant = inverterDetailsPlant(ticket);
      if (!plant) return;
      const list = byPlant.get(plant.siteCode);
      if (list) list.push(ticket);
      else byPlant.set(plant.siteCode, [ticket]);
    });
    return byPlant;
  }

  // A recorded fact (maker, capacity). Absent reads as a muted dash, never "undefined"/"NaN".
  function inverterFactCell(value) {
    return value === null || value === undefined || value === ""
      ? `<span class="ep-text-faint">—</span>` : fmt.escape(String(value));
  }

  function inverterPlantRows(totals) {
    // Build a lookup from site code → breakdown ticket descriptions for the Issue description column.
    const descByPlant = new Map();
    inverterHealth.tickets.forEach((ticket) => {
      if (ticket.equipment_running !== false) return;  // only Breakdown tickets
      const plant = inverterDetailsPlant(ticket);
      const code = plant ? plant.siteCode : "";
      if (!code) return;
      const list = descByPlant.get(code) || [];
      if (ticket.description) list.push(ticket.description);
      descByPlant.set(code, list);
    });
    return inverterPlantScope().map((plant) => {
      const config = totals.configs.get(plant.siteCode);
      const count = totals.plantCounts.get(plant.siteCode) || totals.ticketCounts.get(plant.siteCode) || { open: 0, units: 0 };
      const total = config ? Number(config.total_units) || 0 : null;
      const down = total === null ? null : Math.min(Number(count.units) || 0, total);
      const running = total === null ? null : total - down;
      const percent = total ? Math.round(running / total * 100) : null;
      const descList = descByPlant.get(plant.siteCode) || [];
      return { plant, config, total, down, running, percent, tickets: Number(count.open) || 0, issueDesc: descList };
    }).sort((a, b) => {
      if (a.percent === null && b.percent !== null) return 1;
      if (b.percent === null && a.percent !== null) return -1;
      return (a.percent === null ? 0 : a.percent - b.percent) ||
        a.plant.siteCode.localeCompare(b.plant.siteCode);
    });
  }

  // Sortable headings when table-sort is loaded, plain ones (still aligned) until it is.
  function inverterPlantHeader() {
    const Sort = global.Solar91PortalSort;
    if (Sort) return Sort.headerHTML(INVERTER_PLANT_COLUMNS, inverterHealth.plantSort, "data-ih-sort");
    return INVERTER_PLANT_COLUMNS.map((column) =>
      `<th${column.align === "num" ? ' class="num"' : ""}>${fmt.escape(column.label)}</th>`).join("");
  }

  // The toolbar above the per-plant table: free text over plant name, site code and maker, and
  // "only plants with issues" — a plant with a down inverter or an open ticket.
  function filteredInverterPlantRows(rows) {
    const query = inverterHealth.plantSearch.trim().toLowerCase();
    return rows.filter((row) => {
      if (inverterHealth.onlyIssues && !(row.tickets > 0 || (row.down || 0) > 0)) return false;
      if (!query) return true;
      return [row.plant.displayName || row.plant.plantName, row.plant.siteCode,
        row.plant.displayCode, (row.config && row.config.maker) || ""]
        .join(" ").toLowerCase().indexOf(query) !== -1;
    });
  }

  // Per-plant rows in the chosen order; with no column chosen, the default (worst running % first).
  // The table and its CSV both read this, so the export always matches the screen.
  function sortedInverterPlantRows() {
    const rows = filteredInverterPlantRows(inverterPlantRows(inverterHealthTotals()));
    const Sort = global.Solar91PortalSort;
    if (!Sort || !inverterHealth.plantSort.key) return rows;
    return Sort.apply(rows, inverterHealth.plantSort, INVERTER_PLANT_COLUMNS);
  }

  /**
   * Fleet composition by inverter make, from the unit configuration already loaded — no request
   * of its own. Units add up to the same total the hero band states.
   */
  function inverterFleetMakes(totals) {
    const byMake = new Map();
    totals.configs.forEach((config) => {
      const units = Number(config.total_units) || 0;
      if (!units) return;
      const make = String(config.maker || "").trim() || "Make not recorded";
      const entry = byMake.get(make) || { make, units: 0, plants: 0, kw: 0 };
      entry.units += units;
      entry.plants += 1;
      entry.kw += (Number(config.capacity_kw) || 0) * units;
      byMake.set(make, entry);
    });
    return Array.from(byMake.values())
      .sort((a, b) => b.units - a.units || a.make.localeCompare(b.make));
  }

  function scopedInverterTickets() {
    const scopeCodes = new Set(inverterPlantScope().map((plant) => plant.siteCode));
    return inverterHealth.tickets.filter((ticket) => {
      const plant = inverterDetailsPlant(ticket);
      return !!plant && scopeCodes.has(plant.siteCode);
    });
  }

  function filteredInverterTickets() {
    const query = inverterHealth.search.trim().toLowerCase();
    return scopedInverterTickets().filter((ticket) => {
      const plant = inverterDetailsPlant(ticket);
      const code = plant ? plant.siteCode : "";
      if (inverterHealth.plantFilter && code !== inverterHealth.plantFilter) return false;
      if (inverterHealth.severity && ticket.severity !== inverterHealth.severity) return false;
      if (inverterHealth.status && ticket.status !== inverterHealth.status) return false;
      if (!query) return true;
      return [ticket.ticket_no, ticket.serial_no, ticket.subcategory, ticket.description,
        ticket.status, ticket.severity, ticket.assignee_text, code]
        .join(" ").toLowerCase().indexOf(query) !== -1;
    });
  }

  function renderInverterHealth() {
    const host = document.querySelector("[data-inverter-health]");
    if (!host || !inverterHealth.open) return;
    const totals = inverterHealthTotals();
    const plants = sortedInverterPlantRows();
    const filteredTickets = filteredInverterTickets();
    const scope = inverterHealth.plantFilter
      ? plants.find((row) => row.plant.siteCode === inverterHealth.plantFilter)
      : null;
    const hasCounts = !inverterHealth.unitsRestricted && !inverterHealth.unitsError;
    const runningPercent = totals.runningPercent;
    const severityCounts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    scopedInverterTickets().forEach((ticket) => {
      const severity = Object.keys(severityCounts).find((key) => key.toLowerCase() === String(ticket.severity || "").toLowerCase());
      if (severity) severityCounts[severity] += 1;
    });
    const donut = hasCounts && totals.total > 0
      ? `<span class="ep-ih__donut" style="--ep-ih-running:${runningPercent}%" role="img" aria-label="${runningPercent}% running"><strong>${runningPercent}%</strong><span>Running</span></span>`
      : "";
    const reason = inverterHealth.unitsRestricted
      ? "Inverter counts are visible to the O&M Head and Assignees."
      : inverterHealth.unitsError
        ? fmt.escape(inverterHealth.unitsError)
        : !totals.total ? "No inverter units are configured for the plants in this scope." : "";
    const openByPlant = inverterTicketsByPlant();
    const plantTable = plants.map((row) => {
      const isConfigured = !!row.config;
      const code = row.plant.siteCode;
      const open = openByPlant.get(code) || [];
      const isOpen = inverterHealth.expanded.indexOf(code) !== -1;
      // Only a plant that actually has a down inverter can be unfolded; the rest read as a count.
      const ticketCell = open.length
        ? `<button type="button" class="ep-ih__unfold${isOpen ? " is-open" : ""}" data-ih-unfold="${fmt.escape(code)}"
            aria-expanded="${isOpen}" title="${isOpen ? "Hide" : "Show"} the open inverter tickets for this plant"
            >${fmt.formatNumber(row.tickets)}<span aria-hidden="true">${isOpen ? "▾" : "▸"}</span></button>`
        : fmt.formatNumber(row.tickets);
      // Issue description column: most recent breakdown ticket description + "+N more" overflow.
      const descList = row.issueDesc || [];
      const issueDescCell = descList.length === 0
        ? `<td><span class="ep-text-faint ep-ih__issuedesc">No issues</span></td>`
        : (() => {
            const first = descList[0];
            const more = descList.length > 1 ? ` <span class="ep-ih__issuedesc-more">+${descList.length - 1} more</span>` : "";
            const full = descList.join("\n");
            return `<td><span class="ep-ih__issuedesc" title="${fmt.escape(full)}">${fmt.escape(first)}${more}</span></td>`;
          })();
      // A plant with no unit configuration says so once, across the three cells that would
      // otherwise repeat it.
      const configuredCells = `
        <td><span class="ep-ih__stack"><span class="ep-ih__stack-main">${inverterFactCell(row.config && row.config.maker)}</span>
          <span class="ep-ih__stack-sub">${fmt.escape(fmt.decimalText(row.config && row.config.capacity_kw) || "—")} kW</span></span></td>
        <td class="num"><span class="ep-ih__ratio">${row.down ? `<span class="ep-hint-light ep-hint-light--red" aria-hidden="true"></span>` : ""}<b>${fmt.formatNumber(row.running)}</b><span>/ ${fmt.formatNumber(row.total)}</span></span></td>
        ${issueDescCell}
        <td class="num">${inverterPercentCell(row.percent)}</td>`;
      const main = `<tr data-ih-plant-row="${fmt.escape(code)}" tabindex="0" role="button" aria-label="Filter tickets to ${fmt.escape(row.plant.displayName || row.plant.plantName)}">
        <td><div class="ep-plant-cell"><span class="ep-plant-cell__name">${fmt.escape(row.plant.displayName || row.plant.plantName)}</span><span class="ep-plant-cell__code">${fmt.escape(row.plant.displayCode || row.plant.siteCode)}</span></div></td>
        ${isConfigured ? configuredCells : `<td class="ep-ih__unset" colspan="4">Not configured</td>`}
        <td class="num${row.tickets > 0 ? " ep-ih__tickets-open" : ""}">${ticketCell}</td>
      </tr>`;
      return main + (isOpen && open.length ? inverterDownRows(code, open) : "");
    }).join("");
    const fleet = inverterFleetMakes(totals);
    const fleetUnits = fleet.reduce((sum, item) => sum + item.units, 0);
    const fleetKw = fleet.reduce((sum, item) => sum + item.kw, 0);
    const fleetBar = fleetUnits
      ? `<span class="ep-ih__fleet-bar" aria-hidden="true">${fleet.map((item, index) =>
        `<span class="ep-ih__fleet-seg ep-ih__fleet-seg--${(index % 4) + 1}" style="width:${(100 * item.units / fleetUnits).toFixed(2)}%"></span>`).join("")}</span>
        <ul class="ep-ih__fleet-legend">${fleet.map((item, index) =>
          `<li><span class="ep-ih__fleet-dot ep-ih__fleet-seg--${(index % 4) + 1}" aria-hidden="true"></span>
            <b>${fmt.escape(item.make)}</b>
            <span>${fmt.formatNumber(item.units)} units · ${fmt.formatNumber(item.plants)} plants · ${fmt.formatNumber(Math.round(item.kw))} kW</span></li>`).join("")}</ul>`
      : "";
    const severityTotal = Object.keys(severityCounts)
      .reduce((sum, key) => sum + severityCounts[key], 0);
    // Four chips all reading 0 say nothing; one tick says the same thing in one glance.
    const severityBlock = severityTotal
      ? `<span class="ep-ih__severity-chips">${Object.keys(severityCounts).filter((severity) => severityCounts[severity] > 0)
        .map((severity) => `<span>${inverterSeverityChip(severity)} <b>${fmt.formatNumber(severityCounts[severity])}</b></span>`).join("")}</span>`
      : `<span class="ep-ih__all-clear">✓ All clear</span>`;
    const ticketRows = filteredTickets.map((ticket) => {
      const plant = inverterDetailsPlant(ticket);
      const plantName = plant ? (plant.displayName || plant.plantName) : "Plant unavailable";
      const code = plant ? plant.siteCode : "";
      const occurred = ticket.occurred_at ? String(ticket.occurred_at).slice(0, 10) : "—";
      const etc = ticket.etc_at ? String(ticket.etc_at).slice(0, 10) : "—";
      return `<tr>
        <td><div class="ep-plant-cell"><span class="ep-plant-cell__name">${fmt.escape(plantName)}</span><span class="ep-plant-cell__code">${fmt.escape(code)}</span></div></td>
        <td>${fmt.escape(ticket.serial_no || "Unit not recorded")}</td>
        <td>${fmt.formatNumber(ticket.unit_count == null ? 1 : Number(ticket.unit_count) || 0)}</td>
        <td>${fmt.escape(ticket.subcategory || "—")}</td>
        <td><span class="ep-ih__description" title="${fmt.escape(ticket.description || "")}">${fmt.escape(ticket.description || "—")}</span></td>
        <td>${inverterSeverityChip(ticket.severity)}</td>
        <td><span class="ep-chip ep-chip--grey">${fmt.escape(ticket.status || "—")}</span></td>
        <td>${fmt.escape(occurred)}</td><td>${fmt.escape(etc)}</td>
        <td>${fmt.escape(ticket.assignee_text || "—")}</td>
        <td><span class="ep-ih__ticket-actions"><button type="button" class="ep-ih__ticket" data-ih-ticket="${fmt.escape(ticket.ticket_no || "")}" data-ih-site="${fmt.escape(code)}">${fmt.escape(ticket.ticket_no || "Open ticket")}</button>
          ${inverterHealth.canEdit ? `<button type="button" class="ep-ih__button" data-ih-edit="${fmt.escape(ticket.ticket_no || "")}" data-ih-site="${fmt.escape(code)}">Edit</button>` : ""}</span></td>
      </tr>`;
    }).join("");
    // One unit-configuration cell: the stored value when there is one, a blank the O&M Head or an
    // Assignee can fill when there is not, and read-only for every other role.
    const settingsCell = (plant, config, attr, attrs, value, blank) => !config && !inverterHealth.canEdit ? blank
      : `<input ${attrs} data-ih-${attr}="${fmt.escape(plant.siteCode)}" value="${fmt.escape(value)}"${inverterHealth.canEdit ? "" : " readonly"}>`;
    const COUNT_ATTRS = `type="number" min="1" max="500" required`;
    const settingsRows = plants.map(({ plant, config }) =>
      `<tr><td>${fmt.escape(plant.displayName || plant.plantName)}</td>
        <td>${settingsCell(plant, config, "total", COUNT_ATTRS, config ? config.total_units : 1,
          `<span class="ep-text-faint">Not configured</span>`)}</td>
        <td>${settingsCell(plant, config, "units-day", COUNT_ATTRS, config ? config.units_per_day : 1, "—")}</td>
        <td>${settingsCell(plant, config, "maker", `type="text" maxlength="120" placeholder="Maker"`,
          (config && config.maker) || "", "—")}</td>
        <td>${settingsCell(plant, config, "capacity", `type="number" step="0.01" min="0.01" placeholder="kW"`,
          fmt.decimalText(config && config.capacity_kw), "—")}</td>
        <td>${inverterHealth.canEdit
          ? `<button type="button" class="ep-ih__button" data-ih-save="${fmt.escape(plant.siteCode)}">${config ? "Save" : "Add"}</button>`
          : ""}</td></tr>`
    ).join("");

    host.innerHTML = `<section class="ep-ih" aria-labelledby="ep-ih-title">
      <header class="ep-ih__header"><div class="ep-ih__header-main">
          <span class="ep-ih__header-chip" aria-hidden="true">${ICON_INVERTER_LARGE}</span>
          <div><h1 id="ep-ih-title">Inverter Health</h1><p>${fmt.escape(inverterScopeLabel())}</p></div>
        </div>
        <button type="button" class="ep-ih__close" data-ih-close aria-label="Close Inverter Health">×</button></header>
      <div class="ep-ih__content">
        ${inverterHealth.loading ? `<p class="ep-ih__notice" role="status">Loading inverter health…</p>` : ""}
        ${inverterHealth.summaryError ? `<p class="ep-ih__notice" role="status">${fmt.escape(inverterHealth.summaryError)}</p>` : ""}
        ${inverterHealth.ticketsError ? `<p class="ep-ih__notice ep-ih__notice--error" role="alert">${fmt.escape(inverterHealth.ticketsError)}</p>` : ""}
        ${inverterHealth.navigationError ? `<p class="ep-ih__notice ep-ih__notice--error" role="alert">${fmt.escape(inverterHealth.navigationError)}</p>` : ""}
        ${inverterHealth.unitsError && !inverterHealth.unitsRestricted ? `<p class="ep-ih__notice" role="status">${fmt.escape(inverterHealth.unitsError)}</p>` : ""}
        <section class="ep-panel ep-ih__hero" aria-label="Inverter summary">
          <div class="ep-ih__hero-lead">
            ${donut}
            <div class="ep-ih__hero-text">
              <strong>${hasCounts && totals.total
                ? fmt.formatNumber(totals.running) + " of " + fmt.formatNumber(totals.total) + " inverters running"
                : fmt.formatNumber(totals.tickets) + " open inverter tickets"}</strong>
              <span>${fmt.escape(inverterScopeLabel())}</span>
            </div>
          </div>
          <div class="ep-ih__kpis">
            <div class="ep-ih__kpi">
              <span class="ep-ih__kpi-label">Not running</span>
              <strong class="${totals.down > 0 ? "ep-ih__red" : "ep-ih__muted"}">${hasCounts ? fmt.formatNumber(totals.down) : "—"}</strong>
              <small>${fmt.formatNumber(totals.affected)} plants affected</small>
            </div>
            <div class="ep-ih__kpi">
              <span class="ep-ih__kpi-label">Open tickets</span>
              <strong class="${totals.tickets > 0 ? "" : "ep-ih__muted"}">${fmt.formatNumber(totals.tickets)}</strong>
              <small>${severityBlock}</small>
            </div>
            <div class="ep-ih__kpi">
              <span class="ep-ih__kpi-label">Fleet capacity</span>
              <strong>${fleetKw ? (fleetKw / 1000).toFixed(2) : "—"}<em> MW</em></strong>
              <small>${fmt.formatNumber(fleet.length)} make${fleet.length === 1 ? "" : "s"} in service</small>
            </div>
          </div>
        </section>
        ${reason ? `<p class="ep-ih__reason">${reason}</p>` : ""}
        ${fleetBar ? `<section class="ep-panel ep-ih__fleet"><div class="ep-panel__head"><span class="ep-panel__title">Fleet composition</span>
          <span class="ep-panel__subtitle">${fmt.formatNumber(fleetUnits)} configured inverters</span></div>
          <div class="ep-ih__fleet-body">${fleetBar}</div></section>` : ""}
        <section class="ep-panel"><div class="ep-panel__head"><span class="ep-panel__title">Per-plant health</span></div>
          <div class="ep-ih__toolbar">
            <input type="search" placeholder="Search plant, code or make" aria-label="Search plants" data-ih-plant-search value="${fmt.escape(inverterHealth.plantSearch)}">
            <label class="ep-ih__check"><input type="checkbox" data-ih-only-issues${inverterHealth.onlyIssues ? " checked" : ""}> Only plants with issues</label>
            <button type="button" class="ep-ih__button ep-ih__toolbar-end" data-ih-export-plants>Export CSV</button>
          </div>
          <div class="ep-table-wrap"><table class="ep-table ep-ih__plant-table"><thead><tr>${inverterPlantHeader()}</tr></thead>
            <tbody>${plantTable || `<tr><td colspan="${INVERTER_PLANT_COLUMN_COUNT}"><div class="ep-ih__empty"><strong>No plants to show</strong><span>${
              inverterHealth.plantSearch || inverterHealth.onlyIssues
                ? "No plant in this scope matches the filters above."
                : "No plants in this Dashboard scope."}</span></div></td></tr>`}</tbody></table></div></section>
        <section class="ep-panel"><div class="ep-panel__head"><span class="ep-panel__title">Open inverter tickets${scope ? " · " + fmt.escape(scope.plant.displayName || scope.plant.plantName) : ""}</span>
          ${inverterHealth.plantFilter ? `<button type="button" class="ep-ih__button" data-ih-clear-plant>All plants</button>` : ""}
          <button type="button" class="ep-ih__button" data-ih-export>Export CSV</button></div>
          <div class="ep-ih__toolbar"><input type="search" placeholder="Search tickets" aria-label="Search inverter tickets" data-ih-search value="${fmt.escape(inverterHealth.search)}">
            <select aria-label="Filter by severity" data-ih-severity><option value="">All severities</option>${["Critical","High","Medium","Low"].map((item) => `<option${inverterHealth.severity === item ? " selected" : ""}>${item}</option>`).join("")}</select>
            <select aria-label="Filter by status" data-ih-status><option value="">All statuses</option>${OPEN_INVERTER_STATUSES.map((item) => `<option${inverterHealth.status === item ? " selected" : ""}>${item}</option>`).join("")}</select>
          </div>
          <div class="ep-table-wrap"><table class="ep-table ep-ih__tickets"><thead><tr><th>Plant</th><th>Inverter</th><th>Units</th><th>Sub-problem</th><th>Issue description</th><th>Severity</th><th>Status</th><th>Reported</th><th>ETC</th><th>Assignee</th><th>Ticket</th></tr></thead>
            <tbody>${ticketRows || `<tr><td colspan="11"><div class="ep-ih__empty">${inverterHealth.ticketsError
              ? `<strong>Tickets unavailable</strong><span>Open inverter tickets could not be loaded.</span>`
              : inverterHealth.loading
                ? `<strong>Loading open inverter tickets…</strong>`
                : `<strong>✓ All inverters running</strong><span>No open inverter tickets in this scope.</span>`}</div></td></tr>`}</tbody></table></div>
        </section>
        ${inverterHealth.unitsRestricted || inverterHealth.unitsError ? "" : `<details class="ep-panel ep-ih__settings" ${host.querySelector(".ep-ih__settings[open]") ? "open" : ""}><summary>Inverter unit configuration</summary>
          <div class="ep-table-wrap"><table class="ep-table"><thead><tr><th>Plant</th><th>Total units</th><th>Units/day</th><th>Maker</th><th>Capacity (kW)</th><th></th></tr></thead><tbody>${settingsRows}</tbody></table></div>
          ${!inverterHealth.canEdit ? `<p class="ep-ih__reason">Unit configuration is read-only for your role.</p>` : ""}
          <p class="ep-ih__save-status${inverterHealth.saveError ? " is-error" : ""}" data-ih-save-status aria-live="polite">${fmt.escape(inverterHealth.saveMessage)}</p>
        </details>`}
      </div>
    </section>`;
  }

  function closeInverterHealth(restoreHistory) {
    const host = document.querySelector("[data-inverter-health]");
    inverterHealth.open = false;
    if (host) host.hidden = true;
    const current = global.history.state;
    if (current && current[INVERTER_HISTORY_KEY]) {
      if (restoreHistory !== false) global.history.back();
      else {
        const next = Object.assign({}, current);
        delete next[INVERTER_HISTORY_KEY];
        global.history.replaceState(next, "");
      }
    }
    const tile = document.querySelector('[data-overview-destination="inverters"]');
    if (tile && restoreHistory !== false) tile.focus();
  }

  function openInverterHealth(fromHistory) {
    if (!state) return;
    if (!fromHistory) {
      const current = global.history.state;
      if (!current || !current[INVERTER_HISTORY_KEY]) {
        const next = current && typeof current === "object" ? Object.assign({}, current) : {};
        next[INVERTER_HISTORY_KEY] = true;
        global.history.pushState(next, "");
      }
    }
    inverterHealth.open = true;
    if (!fromHistory) {
      inverterHealth.plantFilter = "";
      inverterHealth.search = "";
      inverterHealth.severity = "";
      inverterHealth.status = "";
      inverterHealth.expanded = [];
      inverterHealth.plantSort = { key: "", dir: "" };
    }
    inverterHealth.navigationError = "";
    const host = document.querySelector("[data-inverter-health]");
    if (host) host.hidden = false;
    // The sortable headings need the shared table-sort module, which the Dashboard shell does not
    // ship. Fetch it on first open; until it lands the headings are plain but correct.
    if (!global.Solar91PortalSort && global.Solar91Modules) {
      global.Solar91Modules.load("table-sort").then(renderInverterHealth).catch(() => {});
    }
    loadInverterHealth();
    const close = host && host.querySelector("[data-ih-close]");
    if (close) close.focus({ preventScroll: true });
  }

  function downloadCsv(name, columns, values) {
    const csvCell = (value) => {
      let text = String(value == null ? "" : value);
      if (/^[\t\r ]*[=+\-@]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    const csv = [columns].concat(values).map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    global.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // The per-plant health table, exported with the same columns in the same order as on screen.
  function exportInverterPlantCsv() {
    const columns = ["Plant", "Site code", "Total inverters", "Maker", "Capacity (kW)",
      "Running", "Not running", "Issue description", "Running %", "Open tickets"];
    const values = sortedInverterPlantRows().map((row) => {
      const descList = row.issueDesc || [];
      const descText = descList.length ? descList.join("; ") : "";
      return [
        row.plant.displayName || row.plant.plantName, row.plant.siteCode,
        row.config ? row.total : "Not configured",
        (row.config && row.config.maker) || "",
        fmt.decimalText(row.config && row.config.capacity_kw),
        row.config ? row.running : "Not configured",
        row.config ? row.down : "Not configured",
        descText,
        row.percent === null ? "" : row.percent + "%",
        row.tickets];
    });
    downloadCsv("inverter-health-plants.csv", columns, values);
  }

  function exportInverterCsv() {
    const rows = filteredInverterTickets();
    const columns = ["Plant", "Site code", "Inverter", "Units", "Sub-problem", "Issue description",
      "Severity", "Status", "Reported", "ETC", "Assignee", "Ticket"];
    const values = rows.map((ticket) => {
      const plant = inverterDetailsPlant(ticket);
      return [plant ? (plant.displayName || plant.plantName) : "Plant unavailable", plant ? plant.siteCode : "",
        ticket.serial_no || "Unit not recorded", ticket.unit_count == null ? 1 : ticket.unit_count,
        ticket.subcategory || "", ticket.description || "", ticket.severity || "", ticket.status || "",
        ticket.occurred_at || "", ticket.etc_at || "", ticket.assignee_text || "", ticket.ticket_no || ""];
    });
    downloadCsv("inverter-health.csv", columns, values);
  }

  function saveInverterConfig(siteCode, button) {
    const host = document.querySelector("[data-inverter-health]");
    const totalInput = Array.from(host.querySelectorAll("[data-ih-total]"))
      .find((input) => input.dataset.ihTotal === siteCode);
    const perDayInput = Array.from(host.querySelectorAll("[data-ih-units-day]"))
      .find((input) => input.dataset.ihUnitsDay === siteCode);
    const makerInput = Array.from(host.querySelectorAll("[data-ih-maker]"))
      .find((input) => input.dataset.ihMaker === siteCode);
    const capacityInput = Array.from(host.querySelectorAll("[data-ih-capacity]"))
      .find((input) => input.dataset.ihCapacity === siteCode);
    const status = host.querySelector("[data-ih-save-status]");
    const total = Number(totalInput && totalInput.value);
    const perDay = Number(perDayInput && perDayInput.value);
    const fail = (message) => {
      inverterHealth.saveMessage = message;
      inverterHealth.saveError = true;
      status.textContent = message;
      status.classList.add("is-error");
    };
    if (!Number.isInteger(total) || total < 1 || total > 500 ||
        !Number.isInteger(perDay) || perDay < 1 || perDay > 500) {
      fail("Total units and units/day must each be between 1 and 500.");
      return;
    }
    // Both new fields are optional: blank clears what is stored, a rating must be positive.
    const maker = ((makerInput && makerInput.value) || "").trim().slice(0, 120) || null;
    const capacityText = ((capacityInput && capacityInput.value) || "").trim();
    const capacity = capacityText === "" ? null : Number(capacityText);
    if (capacity !== null && (!isFinite(capacity) || capacity <= 0)) {
      fail("Capacity (kW) must be a positive number, or left blank.");
      return;
    }
    button.disabled = true;
    inverterHealth.saveMessage = "Saving…";
    inverterHealth.saveError = false;
    status.textContent = inverterHealth.saveMessage;
    global.Solar91PortalAPI.request("/api/pm-plan/unit-config", {
      method: "PUT",
      body: { plant: siteCode, equipment_type: "Inverter", total_units: total, units_per_day: perDay,
        maker: maker, capacity_kw: capacity }
    }).then(() => {
      inverterHealth.saveMessage = "Configuration saved.";
      inverterHealth.saveError = false;
      inverters.loaded = false;
      loadInverters();
      loadInverterHealth();
    }).catch((error) => {
      inverterHealth.saveMessage = "Could not save configuration: " + ((error && error.message) || "please retry.");
      inverterHealth.saveError = true;
      status.textContent = inverterHealth.saveMessage;
      status.classList.add("is-error");
      button.disabled = false;
    });
  }

  function wireInverterHealth() {
    const host = document.querySelector("[data-inverter-health]");
    if (!host || host.dataset.wired) return;
    host.dataset.wired = "true";
    host.addEventListener("click", (event) => {
      const close = event.target.closest("[data-ih-close]");
      if (close) { closeInverterHealth(); return; }
      const sortBy = event.target.closest("[data-ih-sort]");
      if (sortBy) {
        const Sort = global.Solar91PortalSort;
        if (Sort) {
          Sort.next(inverterHealth.plantSort, sortBy.getAttribute("data-ih-sort"));
          renderInverterHealth();
          const again = host.querySelector('[data-ih-sort="' + inverterHealth.plantSort.key + '"]');
          if (again) again.focus();
        }
        return;
      }
      const unfold = event.target.closest("[data-ih-unfold]");
      if (unfold) {
        const code = unfold.dataset.ihUnfold;
        const at = inverterHealth.expanded.indexOf(code);
        if (at === -1) inverterHealth.expanded.push(code);
        else inverterHealth.expanded.splice(at, 1);
        renderInverterHealth();
        const again = Array.from(host.querySelectorAll("[data-ih-unfold]"))
          .find((button) => button.dataset.ihUnfold === code);
        if (again) again.focus();
        return;
      }
      const plant = event.target.closest("[data-ih-plant-row]");
      if (plant) { inverterHealth.plantFilter = plant.dataset.ihPlantRow; renderInverterHealth(); return; }
      if (event.target.closest("[data-ih-clear-plant]")) { inverterHealth.plantFilter = ""; renderInverterHealth(); return; }
      if (event.target.closest("[data-ih-export-plants]")) { exportInverterPlantCsv(); return; }
      if (event.target.closest("[data-ih-export]")) { exportInverterCsv(); return; }
      const save = event.target.closest("[data-ih-save]");
      if (save) { saveInverterConfig(save.dataset.ihSave, save); return; }
      const ticket = event.target.closest("[data-ih-ticket], [data-ih-edit]");
      if (ticket) {
        const code = ticket.dataset.ihSite;
        const mode = ticket.matches("[data-ih-edit]") ? "edit" : "details";
        const row = state && state.allRows.find(({ plant }) => plant.siteCode === code);
        const dateRange = state && { startDate: state.rangeStart, endDate: state.rangeEnd };
        const openTicketInHealth = () => {
          if (!global.Solar91PortalIssues) throw new Error("The Health issue register is unavailable.");
          closeInverterHealth(false);
          if (row) global.Solar91PortalNav.selectPlantPage(code, "health", dateRange, row.plant);
          else global.Solar91PortalNav.selectView("health", dateRange);
          global.Solar91PortalIssues.openTicket(ticket.dataset.ihTicket || ticket.dataset.ihEdit, code, mode);
        };
        const reportNavigationError = (error) => {
          inverterHealth.navigationError = "Could not open the Health issue register: " +
            ((error && error.message) || "please retry.");
          renderInverterHealth();
        };
        if (global.Solar91Modules) {
          global.Solar91Modules.load("site-issues").then(openTicketInHealth).catch(reportNavigationError);
        } else {
          try { openTicketInHealth(); } catch (error) { reportNavigationError(error); }
        }
      }
    });
    host.addEventListener("input", (event) => {
      // Both search boxes re-render the panel, so the caret has to be put back where it was.
      const selector = event.target.matches("[data-ih-search]") ? "[data-ih-search]"
        : event.target.matches("[data-ih-plant-search]") ? "[data-ih-plant-search]" : "";
      if (!selector) return;
      if (selector === "[data-ih-search]") inverterHealth.search = event.target.value;
      else inverterHealth.plantSearch = event.target.value;
      renderInverterHealth();
      const input = host.querySelector(selector);
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    });
    host.addEventListener("change", (event) => {
      if (event.target.matches("[data-ih-severity]")) inverterHealth.severity = event.target.value;
      else if (event.target.matches("[data-ih-status]")) inverterHealth.status = event.target.value;
      else if (event.target.matches("[data-ih-only-issues]")) inverterHealth.onlyIssues = event.target.checked;
      else return;
      renderInverterHealth();
    });
    host.addEventListener("keydown", (event) => {
      if (event.target.matches("[data-ih-plant-row]") && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        inverterHealth.plantFilter = event.target.dataset.ihPlantRow;
        renderInverterHealth();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && inverterHealth.open) closeInverterHealth();
    });
    document.addEventListener("click", (event) => {
      const route = event.target.closest(".ep-sidebar [data-nav], .ep-sidebar .ep-nav-plant__toggle");
      if (route && inverterHealth.open) closeInverterHealth(false);
    }, true);
    global.addEventListener("popstate", (event) => {
      const isOpen = !!(event.state && event.state[INVERTER_HISTORY_KEY]);
      if (isOpen && !inverterHealth.open) openInverterHealth(true);
      else if (!isOpen && inverterHealth.open) closeInverterHealth(true);
    });
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

  function complianceCell(pct) {
    if (pct === null || pct === undefined) {
      return `<span class="ep-bar"><span class="ep-bar__value ep-bar__value--grey">N/A</span></span>`;
    }
    const colour = pct >= 85 ? "green" : pct >= 70 ? "amber" : "red";
    // Module cleaning can pass 100% (extra washing after all three cycles): the figure is shown in
    // full, while the bar itself stops at a full track.
    return (
      `<span class="ep-bar">` +
        `<span class="ep-bar__track"><span class="ep-bar__fill ep-bar__fill--${colour}" style="width:${Math.min(100, pct)}%"></span></span>` +
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
    const CHEVRON = `<svg class="ep-metric__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>`;

    // The tile's own state, used for the icon chip, the headline figure and the meter. The
    // thresholds are the pills' above: this only names the colour they already decided.
    const toneOfPill = (pill) => pill.dot === "red" ? "red" : pill.dot === "amber" ? "amber"
      : pill.dot === "green" ? "accent" : "neutral";
    const pmScheduled = totals.pmCompleted + totals.pmPending + totals.pmOverdue;
    const pmEmpty = pmPct === null || pmScheduled === 0;
    const issueClosed = totals.closedIssues;
    const issueUnsolved = totals.unsolvedIssues;
    const issueSpan = issueUnsolved + issueClosed;
    const clamp = (value) => Math.max(0, Math.min(100, Number(value) || 0));

    const cards = [
      {
        title: "PM Compliance",
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
        tone: wshPct === null ? "neutral" : toneOfPill(wshP),
        empty: wshPct === null ? "No cleaning scheduled" : "",
        figure: wshPct === null ? null : { value: String(wshPct), unit: "%", caption: "of cycles complete" },
        meter: wshPct === null ? [] : [
          { width: clamp(wshPct), tone: "accent" },
          { width: 100 - clamp(wshPct), tone: "short" }
        ],
        legend: [
          { dot: wshPct === null ? "" : "green", label: "Cycles done", value: fmt.formatNumber(totals.washingCompleted) },
          { dot: "", label: "Pending", value: fmt.formatNumber(totals.washingPending) },
          { dot: totals.washingOverdue > 0 ? "red" : "", label: "Overdue", value: fmt.formatNumber(totals.washingOverdue), bad: totals.washingOverdue > 0 }
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
        figure: inv.total
          ? { value: String(inv.runningPercent), unit: "%", caption: "of inverters running" }
          : (inv.tickets ? { value: fmt.formatNumber(inv.tickets), unit: "", caption: "open inverter issues" } : null),
        meter: inv.total ? [{ width: clamp(inv.runningPercent), tone: "accent" }] : [],
        legend: inv.total
          ? [
            { dot: "green", label: "Running", value: fmt.formatNumber(inv.running) },
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
        title: "Open Site Issues",
        destination: "health",
        icon: ICON_ISSUES,
        tone: toneOfPill(isP),
        empty: "",
        figure: { value: fmt.formatNumber(openIss), unit: "", caption: "open across the portfolio" },
        // Stacked: what is still unsolved against what has been closed to date.
        meter: issueSpan ? [
          { width: clamp(100 * issueUnsolved / issueSpan), tone: "red" },
          { width: clamp(100 * issueClosed / issueSpan), tone: "accent" }
        ] : [],
        legend: [
          { dot: issueUnsolved > 0 ? "red" : "", label: "Unsolved", value: fmt.formatNumber(issueUnsolved), bad: issueUnsolved > 0 },
          { dot: "", label: "In progress", value: fmt.formatNumber(totals.inProgressIssues) },
          { dot: issueClosed > 0 ? "green" : "", label: "Closed to date", value: fmt.formatNumber(issueClosed) }
        ]
      }
    ];

    const meterHTML = (segments) =>
      `<span class="ep-meter" aria-hidden="true">${segments.map((segment) =>
        `<span class="ep-meter__seg ep-meter__seg--${segment.tone}" style="width:${clamp(segment.width)}%"></span>`).join("")}</span>`;

    // A real <button>: clickable and reachable by keyboard without a role/tabindex of our own.
    document.querySelector("[data-overview-metrics]").innerHTML = cards.map((c) => `
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
        ${meterHTML(c.meter)}
        <span class="ep-metric__legend">
          ${c.legend.map((item) => `<span class="ep-metric__stat">
            <span class="ep-hint-light${item.dot ? " ep-hint-light--" + item.dot : ""}"></span>
            <span class="ep-metric__stat-label">${fmt.escape(item.label)}</span>
            <b class="ep-metric__stat-value${item.bad ? " is-bad" : ""}">${item.value}</b>
          </span>`).join("")}
        </span>
      </button>
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
      if (destination === "inverters") {
        openInverterHealth();
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
    wireInverterHealth();
    wireVisibilityRefresh();
    loadPortfolio(false);
    loadInverters();
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
        if (inverterHealth.open) loadInverterHealth();
      });
    }
  };
}(window));