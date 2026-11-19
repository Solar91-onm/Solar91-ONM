/**
 * inverter-health.js — one parameterised equipment-health panel used by both Inverters and Strings.
 *
 * Originally the Dashboard's Inverter Health drill-down only. Generalised so a single implementation
 * drives any equipment type: the vertical, labels, icon, history key and DOM mount point all come
 * from a `typeConfig` object; nothing is hardcoded to inverters. Both the Inverters and Strings tiles
 * instantiate this module with their own typeConfig and get fully independent panels.
 *
 * Overview.js hands over its live state through create(typeConfig, ctx) — nothing is copied — so the
 * panel and the tile always read the same figures. S() is the Dashboard's current state (replaced on
 * every reload, so it is read through a getter, never kept).
 *
 * typeConfig shape:
 *   { vertical, label, unitLabel, icon, historyKey, mountAttr, destination, type }
 *   - vertical:    API query param value ("Inverter" / "String")
 *   - label:       User-visible name ("Inverter" / "String")
 *   - unitLabel:   Column heading for the unit cell ("Inverter" / "String")
 *   - icon:        SVG string for the page header chip
 *   - historyKey:  history.state key for Back-button handling
 *   - mountAttr:   data-attribute on the host element (e.g. "data-inverter-health")
 *   - destination: data-overview-destination value ("inverters" / "strings")
 *   - type:        lowercase type key for panel singleton map ("inverter" / "string")
 *
 * ctx shape:
 *   { state, filters, equipmentCache, fmt, isEquipmentType, calculateTotals, reloadTile }
 */
(function (global) {
  "use strict";

  const panels = new Map();

  function create(typeConfig, ctx) {
    const fmt = ctx.fmt;
    const filters = ctx.filters;
    const equipmentCache = ctx.equipmentCache;
    const isEquipmentType = ctx.isEquipmentType;
    const calculateTotals = ctx.calculateTotals;
    const getUnitRows = ctx.getUnitRows || ((_codes, unitRows) => unitRows);
    const reloadTile = ctx.reloadTile;
    const S = ctx.state;

    const panelState = {
      open: false, loading: false, units: [], summary: null, tickets: [],
      unitsRestricted: false, unitsError: "", summaryError: "", ticketsError: "",
      canEdit: false, plantFilter: "", search: "", severity: "", status: "",
      plantSearch: "", onlyIssues: false,
      saveMessage: "", saveError: false, navigationError: "",
      expanded: [],
      plantSort: { key: "", dir: "" },
      plantFilters: {},
      ticketFilters: {}
    };

    const PLANT_COLUMNS = [
      { key: "plant", label: "Plant", sort: (row) => row.plant.siteCode },
      { key: "inverter", label: typeConfig.unitLabel, sort: (row) => (row.config && row.config.maker) || "" },
      { key: "running", label: "Running", align: "num", sort: (row) => row.running },
      { key: "issuedesc", label: "Issue description", sort: (row) => row.issueDesc || "" },
      { key: "percent", label: "Health", align: "num", sort: (row) => row.percent },
      { key: "tickets", label: "Tickets", align: "num", sort: (row) => row.tickets }
    ];
    const PLANT_COLUMN_COUNT = PLANT_COLUMNS.length;

    const TICKET_COLUMNS = [
      { key: "plant", label: "Plant", value: (t) => { const p = detailsPlant(t); return p ? (p.displayName || p.plantName) : "Plant unavailable"; } },
      { key: "inverter", label: typeConfig.unitLabel, value: (t) => t.serial_no || "Unit not recorded" },
      { key: "units", label: "Units", align: "num", filter: false },
      { key: "subpart", label: "Sub-problem", value: (t) => t.subcategory || "—" },
      { key: "problem", label: "Issue description", value: (t) => t.description || "—" },
      { key: "severity", label: "Severity", value: (t) => t.severity || "—" },
      { key: "status", label: "Status", value: (t) => t.status || "—" },
      { key: "reported", label: "Reported", filter: false },
      { key: "etc", label: "ETC", filter: false },
      { key: "assignee", label: "Assignee", value: (t) => t.assignee_text || "—" },
      { key: "ticket", label: "Ticket", filter: false }
    ];

    const PLANT_COLUMN_VALUE = {
      plant: (row) => row.plant.displayName || row.plant.plantName,
      inverter: (row) => typeConfig.type === "string"
        ? (row.total === null ? "Not configured" : fmt.formatNumber(row.total) + " strings")
        : (row.config && row.config.maker) || "Not configured",
      issuedesc: (row) => {
        const list = row.issueDesc || [];
        return list.length ? list[0] : "No issues";
      }
    };

    function columnHeader(column, scope, sortAttr, sortState) {
      const Sort = global.Solar91PortalSort;
      let header = Sort && sortAttr
        ? Sort.thHTML(column, sortState, sortAttr)
        : `<th${column.align === "num" ? ' class="num"' : ""}>${fmt.escape(column.label)}</th>`;
      const filterable = column.filter !== false &&
        (scope === "ticket" ? !!column.value : !!PLANT_COLUMN_VALUE[column.key]);
      if (!filterable) return header;

      const store = scope === "ticket" ? panelState.ticketFilters : panelState.plantFilters;
      const active = String(store[column.key] || "");
      return global.Solar91PortalColumnFilter.headerHTML(header, {
        key: column.key,
        label: column.label,
        values: columnOptions(scope, column),
        active: active,
        menuId: "ep-ih-filter-" + scope + "-" + column.key,
        scope: scope,
        attributes: {
          toggleKey: "data-ih-filter-toggle",
          menuKey: "data-ih-filter-menu",
          optionKey: "data-ih-filter-option",
          optionValue: "data-ih-filter-value",
          search: "data-ih-filter-search",
          empty: "data-ih-filter-empty",
          scope: "data-ih-filter-scope"
        },
        classes: {
          header: "ep-ih__th-filtered",
          content: "ep-ih__th-content",
          toggle: "ep-ih__filter-toggle",
          menu: "ep-ih__column-filter-menu",
          search: "ep-ih__column-filter-search",
          options: "ep-ih__column-filter-options",
          option: "ep-ih__column-filter-option",
          empty: "ep-ih__column-filter-empty"
        },
        focusSearchOnOpen: true,
        keepAllOptionVisible: true
      });
    }

    function wireColumnFilters(host) {
      global.Solar91PortalColumnFilter.wire(host, {
        attributes: {
          toggleKey: "data-ih-filter-toggle",
          menuKey: "data-ih-filter-menu",
          optionKey: "data-ih-filter-option",
          optionValue: "data-ih-filter-value",
          search: "data-ih-filter-search",
          empty: "data-ih-filter-empty",
          scope: "data-ih-filter-scope"
        },
        classes: {
          menu: "ep-ih__column-filter-menu",
          search: "ep-ih__column-filter-search",
          empty: "ep-ih__column-filter-empty"
        },
        focusSearchOnOpen: true,
        keepAllOptionVisible: true,
        onSelect: (key, scope, value) => {
          const store = scope === "ticket" ? panelState.ticketFilters : panelState.plantFilters;
          if (value) store[key] = value;
          else delete store[key];
          renderHealth();
        }
      });
    }

    function columnOptions(scope, column) {
      const seen = [];
      const add = (value) => {
        const text = String(value == null ? "" : value).trim();
        if (text && seen.indexOf(text) === -1) seen.push(text);
      };
      if (scope === "ticket") scopedTickets().forEach((ticket) => add(column.value(ticket)));
      else {
        const read = PLANT_COLUMN_VALUE[column.key];
        plantRows(healthTotals()).forEach((row) => add(read(row)));
      }
      return seen.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    function filterMatches(store, columns, read) {
      return Object.keys(store).every((key) => {
        const wanted = String(store[key] || "").trim();
        if (!wanted) return true;
        const column = columns.find((item) => item.key === key);
        if (!column) return true;
        return String(read(column) == null ? "" : read(column)).trim() === wanted;
      });
    }

    const OPEN_STATUSES = [
      "Open", "Assigned", "Acknowledged", "In Progress", "Pending Vendor", "Pending Parts/Vendor", "Pending Closure"
    ];

    function plantScope() {
      return S() ? S().rows.map(({ plant }) => plant) : [];
    }

    function scopeLabel() {
      const parts = [];
      const selected = filters.plant !== "__all" && S()
        ? S().allRows.find(({ plant }) => plant.siteCode === filters.plant) : null;
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

    function detailsPlant(issue) {
      const match = S() && S().allRows.find(({ plant }) =>
        String(plant.id || plant.dbId || "") === String(issue.plant_id || ""));
      if (match) return match.plant;
      return null;
    }

    function healthTotals() {
      const plants = plantScope();
      const codes = new Set(plants.map((plant) => plant.siteCode));
      const unitRows = getUnitRows(codes, panelState.units, !panelState.unitsRestricted);
      const configs = new Map();
      unitRows.forEach((config) => {
        if (!isEquipmentType(config.equipment_type) || !codes.has(config.site_code)) return;
        configs.set(config.site_code, config);
      });
      const plantCounts = new Map();
      (panelState.summary && panelState.summary.plants || []).forEach((row) => {
        if (!row.site_code || codes.has(row.site_code)) plantCounts.set(row.site_code, row);
      });
      const ticketCounts = new Map();
      panelState.tickets.forEach((ticket) => {
        const plant = detailsPlant(ticket);
        const code = plant ? plant.siteCode : "";
        if (!code || !codes.has(code)) return;
        const count = ticketCounts.get(code) || { open: 0, units: 0 };
        count.open += 1;
        if (ticket.equipment_running === false) {
          count.units += ticket.unit_count == null ? 1 : Number(ticket.unit_count) || 0;
        }
        ticketCounts.set(code, count);
      });

      const issueRows = panelState.summary
        ? Array.from(plantCounts.entries()).map(([site_code, row]) => Object.assign({ site_code }, row))
        : Array.from(ticketCounts.entries()).map(([site_code, row]) => Object.assign({ site_code }, row));
      const counts = calculateTotals(codes, unitRows, issueRows);
      return Object.assign({}, counts, { affected: counts.plants, configs, plantCounts, ticketCounts });
    }

    function healthUrl() {
      const codes = plantScope().map((plant) => plant.siteCode);
      let url = "/api/issues?vertical=" + typeConfig.vertical + "&status=open&limit=200";
      if (codes.length === 1) url += "&site_code=" + encodeURIComponent(codes[0]);
      return url;
    }

    function loadHealth() {
      const api = global.Solar91PortalAPI;
      if (!api) {
        panelState.ticketsError = "Solar91 sign-in is not ready. Reload the page and try again.";
        panelState.loading = false;
        renderHealth();
        return;
      }
      panelState.loading = true;
      panelState.unitsError = "";
      panelState.summaryError = "";
      panelState.ticketsError = "";
      renderHealth();
      const scopeCodes = new Set(plantScope().map((plant) => plant.siteCode));
      const unitRequest = equipmentCache.loaded && (equipmentCache.units.length || equipmentCache.unitsRestricted)
        ? Promise.resolve().then(() => {
          panelState.units = equipmentCache.units.filter((row) =>
            isEquipmentType(row.equipment_type) && scopeCodes.has(row.site_code));
          panelState.unitsRestricted = equipmentCache.unitsRestricted;
        })
        : api.request("/api/pm-plan/unit-config").then((body) => {
          equipmentCache.units = (body && body.configs) || [];
          equipmentCache.loaded = true;
          panelState.units = equipmentCache.units.filter((row) =>
            isEquipmentType(row.equipment_type) && scopeCodes.has(row.site_code));
          panelState.unitsRestricted = false;
        }).catch((error) => {
          panelState.units = [];
          panelState.unitsRestricted = error && error.status === 403;
          panelState.unitsError = panelState.unitsRestricted
            ? "" : typeConfig.label + " unit counts could not be loaded: " + ((error && error.message) || "please retry.");
        });
      const summaryRequest = equipmentCache.loaded && equipmentCache.issues.length
        ? Promise.resolve().then(() => { panelState.summary = { plants: equipmentCache.issues }; })
        : api.request("/api/issues/equipment-summary?vertical=" + typeConfig.vertical).then((body) => {
          equipmentCache.issues = (body && body.plants) || [];
          panelState.summary = body || { plants: [] };
        }).catch((error) => {
          panelState.summary = null;
          panelState.summaryError = typeConfig.label + " ticket totals could not be loaded: " +
            ((error && error.message) || "showing the tickets returned below.");
        });
      const ticketRequest = api.request(healthUrl()).then((rows) => {
        panelState.tickets = Array.isArray(rows) ? rows : [];
      }).catch((error) => {
        panelState.tickets = [];
        panelState.ticketsError = "Open " + typeConfig.label.toLowerCase() + " tickets could not be loaded: " +
          ((error && error.message) || "please retry.");
      });
      const roleRequest = api.session().then((session) => {
        const role = session && session.user && session.user.role;
        panelState.canEdit = role === "O&M Head" || role === "Assignee";
      }).catch(() => { panelState.canEdit = false; });
      Promise.all([unitRequest, summaryRequest, ticketRequest, roleRequest]).then(() => {
        panelState.loading = false;
        renderHealth();
      });
    }

    function severityChip(severity) {
      const value = String(severity || "Low");
      const cls = value.toLowerCase() === "critical" ? "ep-chip--critical"
        : value.toLowerCase() === "high" ? "ep-chip--attention"
          : value.toLowerCase() === "medium" ? "ep-chip--grey" : "ep-chip--healthy";
      return `<span class="ep-chip ${cls}">${fmt.escape(value)}</span>`;
    }

    function percentCell(percent) {
      if (percent === null) return `<span class="ep-text-faint">—</span>`;
      const tone = percent >= 85 ? "green" : percent >= 70 ? "amber" : "red";
      return `<span class="ep-bar"><span class="ep-bar__track"><span class="ep-bar__fill ep-bar__fill--${tone}" style="width:${percent}%"></span></span><span class="ep-bar__value">${percent}%</span></span>`;
    }

    function downRows(siteCode, tickets) {
      const items = tickets.map((ticket) => `<li class="ep-ih__down">
        <span class="ep-ih__down-unit">${fmt.escape(ticket.serial_no || "Unit not recorded")}</span>
        <span class="ep-ih__down-sub">${fmt.escape(ticket.subcategory || "—")}</span>
        <span class="ep-ih__description" title="${fmt.escape(ticket.description || "")}">${fmt.escape(ticket.description || "—")}</span>
        ${severityChip(ticket.severity)}
        <span class="ep-ih__ticket-actions"><button type="button" class="ep-ih__ticket" data-ih-ticket="${fmt.escape(ticket.ticket_no || "")}" data-ih-site="${fmt.escape(siteCode)}">${fmt.escape(ticket.ticket_no || "Open ticket")}</button>
          ${panelState.canEdit ? `<button type="button" class="ep-ih__button" data-ih-edit="${fmt.escape(ticket.ticket_no || "")}" data-ih-site="${fmt.escape(siteCode)}">Edit</button>` : ""}</span>
      </li>`).join("");
      return `<tr class="ep-ih__down-row"><td colspan="${PLANT_COLUMN_COUNT}"><ul class="ep-ih__down-list">${items}</ul></td></tr>`;
    }

    function ticketsByPlant() {
      const byPlant = new Map();
      scopedTickets().forEach((ticket) => {
        if (ticket.equipment_running !== false) return;
        const plant = detailsPlant(ticket);
        if (!plant) return;
        const list = byPlant.get(plant.siteCode);
        if (list) list.push(ticket);
        else byPlant.set(plant.siteCode, [ticket]);
      });
      return byPlant;
    }

    function factCell(value) {
      return value === null || value === undefined || value === ""
        ? `<span class="ep-text-faint">—</span>` : fmt.escape(String(value));
    }

    function plantRows(totals) {
      const descByPlant = new Map();
      panelState.tickets.forEach((ticket) => {
        if (ticket.equipment_running !== false) return;
        const plant = detailsPlant(ticket);
        const code = plant ? plant.siteCode : "";
        if (!code) return;
        const list = descByPlant.get(code) || [];
        if (ticket.description) list.push(ticket.description);
        descByPlant.set(code, list);
      });
      return plantScope().map((plant) => {
        const config = totals.configs.get(plant.siteCode);
        const count = totals.plantCounts.get(plant.siteCode) || totals.ticketCounts.get(plant.siteCode) || { open: 0, units: 0 };
        const total = config ? Number(config.total_units) || 0 : null;
        const down = total === null ? null : Math.min(Number(count.units) || 0, total);
        const running = total === null ? null : total - down;
        const percent = total ? Math.round(running / total * 100) : null;
        const descList = descByPlant.get(plant.siteCode) || [];
        return {
          plant, config, total, down, running, percent,
          derivedFromTableCount: !!(config && config.inferred_from_table_count),
          tickets: Number(count.open) || 0, issueDesc: descList
        };
      }).sort((a, b) => {
        if (a.percent === null && b.percent !== null) return 1;
        if (b.percent === null && a.percent !== null) return -1;
        return (a.percent === null ? 0 : a.percent - b.percent) ||
          a.plant.siteCode.localeCompare(b.plant.siteCode);
      });
    }

    function plantHeader() {
      return PLANT_COLUMNS.map((column) =>
        columnHeader(column, "plant", "data-ih-sort", panelState.plantSort)).join("");
    }

    function filteredPlantRows(rows) {
      const query = panelState.plantSearch.trim().toLowerCase();
      return rows.filter((row) => {
        if (panelState.onlyIssues && !(row.tickets > 0 || (row.down || 0) > 0)) return false;
        if (!filterMatches(panelState.plantFilters, PLANT_COLUMNS,
            (column) => (PLANT_COLUMN_VALUE[column.key] || (() => ""))(row))) return false;
        if (!query) return true;
        return [row.plant.displayName || row.plant.plantName, row.plant.siteCode,
          row.plant.displayCode, (row.config && row.config.maker) || "",
          row.total === null ? "" : String(row.total)]
          .join(" ").toLowerCase().indexOf(query) !== -1;
      });
    }

    function sortedPlantRows() {
      const rows = filteredPlantRows(plantRows(healthTotals()));
      const Sort = global.Solar91PortalSort;
      if (!Sort || !panelState.plantSort.key) return rows;
      return Sort.apply(rows, panelState.plantSort, PLANT_COLUMNS);
    }

    function fleetMakes(totals) {
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

    function scopedTickets() {
      const scopeCodes = new Set(plantScope().map((plant) => plant.siteCode));
      return panelState.tickets.filter((ticket) => {
        const plant = detailsPlant(ticket);
        return !!plant && scopeCodes.has(plant.siteCode);
      });
    }

    function filteredTickets() {
      const query = panelState.search.trim().toLowerCase();
      return scopedTickets().filter((ticket) => {
        const plant = detailsPlant(ticket);
        const code = plant ? plant.siteCode : "";
        if (panelState.plantFilter && code !== panelState.plantFilter) return false;
        if (panelState.severity && ticket.severity !== panelState.severity) return false;
        if (panelState.status && ticket.status !== panelState.status) return false;
        if (!filterMatches(panelState.ticketFilters, TICKET_COLUMNS,
            (column) => (column.value || (() => ""))(ticket))) return false;
        if (!query) return true;
        return [ticket.ticket_no, ticket.serial_no, ticket.subcategory, ticket.description,
          ticket.status, ticket.severity, ticket.assignee_text, code]
          .join(" ").toLowerCase().indexOf(query) !== -1;
      });
    }

    function getHost() {
      return document.querySelector("[" + typeConfig.mountAttr + "]");
    }

    function renderHealth() {
      const host = getHost();
      if (!host || !panelState.open) return;
      const totals = healthTotals();
      const plants = sortedPlantRows();
      const filtered = filteredTickets();
      const scope = panelState.plantFilter
        ? plants.find((row) => row.plant.siteCode === panelState.plantFilter)
        : null;
      const hasCounts = !panelState.unitsRestricted && !panelState.unitsError;
      const severityCounts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
      scopedTickets().forEach((ticket) => {
        const severity = Object.keys(severityCounts).find((key) => key.toLowerCase() === String(ticket.severity || "").toLowerCase());
        if (severity) severityCounts[severity] += 1;
      });
      const label = typeConfig.label;
      const labelLower = label.toLowerCase();
      const reason = panelState.unitsRestricted
        ? label + " counts are visible to the O&M Head and Assignees."
        : panelState.unitsError
          ? fmt.escape(panelState.unitsError)
          : !totals.total ? "No " + labelLower + " units are configured for the plants in this scope." : "";
      const openByPlant = ticketsByPlant();
      const plantTable = plants.map((row) => {
        const isConfigured = !!row.config;
        const code = row.plant.siteCode;
        const open = openByPlant.get(code) || [];
        const isOpen = panelState.expanded.indexOf(code) !== -1;
        const ticketCell = open.length
          ? `<button type="button" class="ep-ih__unfold${isOpen ? " is-open" : ""}" data-ih-unfold="${fmt.escape(code)}"
              aria-expanded="${isOpen}" title="${isOpen ? "Hide" : "Show"} the open ${labelLower} tickets for this plant"
              >${fmt.formatNumber(row.tickets)}<span aria-hidden="true">${isOpen ? "▾" : "▸"}</span></button>`
          : fmt.formatNumber(row.tickets);
        const descList = row.issueDesc || [];
        const issueDescCell = descList.length === 0
          ? `<td><span class="ep-text-faint ep-ih__issuedesc">No issues</span></td>`
          : (() => {
              const first = descList[0];
              const more = descList.length > 1 ? ` <span class="ep-ih__issuedesc-more">+${descList.length - 1} more</span>` : "";
              const full = descList.join("\n");
              return `<td><span class="ep-ih__issuedesc" title="${fmt.escape(full)}">${fmt.escape(first)}${more}</span></td>`;
            })();
        const unitCell = typeConfig.type === "string"
          ? `<td><span class="ep-ih__stack"><span class="ep-ih__stack-main">${fmt.formatNumber(row.total)} strings</span>
              <span class="ep-ih__stack-sub">${row.derivedFromTableCount
                ? "From Module Cleaning table count"
                : fmt.escape((row.config && row.config.maker) || "Make not recorded")}</span></span></td>`
          : `<td><span class="ep-ih__stack"><span class="ep-ih__stack-main">${factCell(row.config && row.config.maker)}</span>
              <span class="ep-ih__stack-sub">${fmt.escape(fmt.decimalText(row.config && row.config.capacity_kw) || "—")} kW</span></span></td>`;
        const configuredCells = `
          ${unitCell}
          <td class="num"><span class="ep-ih__ratio">${row.down ? `<span class="ep-hint-light ep-hint-light--red" aria-hidden="true"></span>` : ""}<b>${fmt.formatNumber(row.running)}</b><span>/ ${fmt.formatNumber(row.total)}</span></span></td>
          ${issueDescCell}
          <td class="num">${percentCell(row.percent)}</td>`;
        const main = `<tr data-ih-plant-row="${fmt.escape(code)}" tabindex="0" role="button" aria-label="Filter tickets to ${fmt.escape(row.plant.displayName || row.plant.plantName)}">
          <td><div class="ep-plant-cell"><span class="ep-plant-cell__name">${fmt.escape(row.plant.displayName || row.plant.plantName)}</span><span class="ep-plant-cell__code">${fmt.escape(row.plant.displayCode || row.plant.siteCode)}</span></div></td>
          ${isConfigured ? configuredCells : `<td class="ep-ih__unset" colspan="4">Not configured</td>`}
          <td class="num${row.tickets > 0 ? " ep-ih__tickets-open" : ""}">${ticketCell}</td>
        </tr>`;
        return main + (isOpen && open.length ? downRows(code, open) : "");
      }).join("");
      const fleet = fleetMakes(totals);
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
      const severityBlock = severityTotal
        ? `<span class="ep-ih__severity-chips">${Object.keys(severityCounts).filter((severity) => severityCounts[severity] > 0)
          .map((severity) => `<span>${severityChip(severity)} <b>${fmt.formatNumber(severityCounts[severity])}</b></span>`).join("")}</span>`
        : `<span class="ep-ih__all-clear">✓ All clear</span>`;
      const ticketRows = filtered.map((ticket) => {
        const plant = detailsPlant(ticket);
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
          <td>${severityChip(ticket.severity)}</td>
          <td><span class="ep-chip ep-chip--grey">${fmt.escape(ticket.status || "—")}</span></td>
          <td>${fmt.escape(occurred)}</td><td>${fmt.escape(etc)}</td>
          <td>${fmt.escape(ticket.assignee_text || "—")}</td>
          <td><span class="ep-ih__ticket-actions"><button type="button" class="ep-ih__ticket" data-ih-ticket="${fmt.escape(ticket.ticket_no || "")}" data-ih-site="${fmt.escape(code)}">${fmt.escape(ticket.ticket_no || "Open ticket")}</button>
            ${panelState.canEdit ? `<button type="button" class="ep-ih__button" data-ih-edit="${fmt.escape(ticket.ticket_no || "")}" data-ih-site="${fmt.escape(code)}">Edit</button>` : ""}</span></td>
        </tr>`;
      }).join("");
      const settingsCell = (plant, config, attr, attrs, value, blank) => !config && !panelState.canEdit ? blank
        : `<input ${attrs} data-ih-${attr}="${fmt.escape(plant.siteCode)}" value="${fmt.escape(value)}"${panelState.canEdit ? "" : " readonly"}>`;
      const COUNT_ATTRS = `type="number" min="1" max="500" required`;
      const settingsRows = plants.map(({ plant, config, derivedFromTableCount }) => {
        const savedConfig = derivedFromTableCount ? null : config;
        const totalCell = derivedFromTableCount && !panelState.canEdit
          ? `<span>${fmt.formatNumber(config.total_units)} · from Module Cleaning tables</span>`
          : settingsCell(plant, savedConfig, "total", COUNT_ATTRS,
            config ? config.total_units : 1, `<span class="ep-text-faint">Not configured</span>`);
        return `<tr><td>${fmt.escape(plant.displayName || plant.plantName)}</td>
          <td>${totalCell}</td>
          <td>${settingsCell(plant, savedConfig, "units-day", COUNT_ATTRS, config ? config.units_per_day : 1, "—")}</td>
          <td>${settingsCell(plant, savedConfig, "maker", `type="text" maxlength="120" placeholder="Maker"`,
            (config && config.maker) || "", "—")}</td>
          <td>${settingsCell(plant, savedConfig, "capacity", `type="number" step="0.01" min="0.01" placeholder="kW"`,
            fmt.decimalText(config && config.capacity_kw), "—")}</td>
          <td>${panelState.canEdit
            ? `<button type="button" class="ep-ih__button" data-ih-save="${fmt.escape(plant.siteCode)}">${savedConfig ? "Save" : "Add"}</button>`
            : ""}</td></tr>`;
      }).join("");

      host.innerHTML = `<section class="ep-ih" aria-labelledby="ep-ih-title">
        <header class="ep-ih__header"><div class="ep-ih__header-main">
            <span class="ep-ih__header-chip" aria-hidden="true">${typeConfig.icon}</span>
            <div><h1 id="ep-ih-title">${fmt.escape(label)} Health</h1><p>${fmt.escape(scopeLabel())}</p></div>
          </div>
          <button type="button" class="ep-ih__close" data-ih-close aria-label="Close ${fmt.escape(label)} Health">×</button></header>
        <div class="ep-ih__content">
          ${panelState.loading ? `<p class="ep-ih__notice" role="status">Loading ${labelLower} health…</p>` : ""}
          ${panelState.summaryError ? `<p class="ep-ih__notice" role="status">${fmt.escape(panelState.summaryError)}</p>` : ""}
          ${panelState.ticketsError ? `<p class="ep-ih__notice ep-ih__notice--error" role="alert">${fmt.escape(panelState.ticketsError)}</p>` : ""}
          ${panelState.navigationError ? `<p class="ep-ih__notice ep-ih__notice--error" role="alert">${fmt.escape(panelState.navigationError)}</p>` : ""}
          ${panelState.unitsError && !panelState.unitsRestricted ? `<p class="ep-ih__notice" role="status">${fmt.escape(panelState.unitsError)}</p>` : ""}
          <section class="ep-panel ep-ih__hero" aria-label="${fmt.escape(label)} summary">
            <div class="ep-ih__hero-lead">
              <div class="ep-ih__hero-text">
                <strong>${hasCounts && totals.total
                  ? fmt.formatNumber(totals.running) + " of " + fmt.formatNumber(totals.total) + " " + labelLower + "s running"
                  : fmt.formatNumber(totals.tickets) + " open " + labelLower + " tickets"}</strong>
                <span>${fmt.escape(scopeLabel())}</span>
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
            <span class="ep-panel__subtitle">${fmt.formatNumber(fleetUnits)} configured ${labelLower}s</span></div>
            <div class="ep-ih__fleet-body">${fleetBar}</div></section>` : ""}
          <section class="ep-panel"><div class="ep-panel__head"><span class="ep-panel__title">Per-plant health</span></div>
            <div class="ep-ih__toolbar">
              <input type="search" placeholder="${typeConfig.type === "string" ? "Search plant, code or string count" : "Search plant, code or make"}" aria-label="Search plants" data-ih-plant-search value="${fmt.escape(panelState.plantSearch)}">
              <label class="ep-ih__check"><input type="checkbox" data-ih-only-issues${panelState.onlyIssues ? " checked" : ""}> Only plants with issues</label>
              <button type="button" class="ep-ih__button ep-ih__toolbar-end" data-ih-export-plants>Export CSV</button>
            </div>
            <div class="ep-table-wrap"><table class="ep-table ep-ih__plant-table"><thead><tr>${plantHeader()}</tr></thead>
              <tbody>${plantTable || `<tr><td colspan="${PLANT_COLUMN_COUNT}"><div class="ep-ih__empty"><strong>No plants to show</strong><span>${
                panelState.plantSearch || panelState.onlyIssues
                  ? "No plant in this scope matches the filters above."
                  : "No plants in this Dashboard scope."}</span></div></td></tr>`}</tbody></table></div></section>
          <section class="ep-panel"><div class="ep-panel__head"><span class="ep-panel__title">Open ${labelLower} tickets${scope ? " · " + fmt.escape(scope.plant.displayName || scope.plant.plantName) : ""}</span>
            ${panelState.plantFilter ? `<button type="button" class="ep-ih__button" data-ih-clear-plant>All plants</button>` : ""}
            <button type="button" class="ep-ih__button" data-ih-export>Export CSV</button></div>
            <div class="ep-ih__toolbar"><input type="search" placeholder="Search tickets" aria-label="Search ${labelLower} tickets" data-ih-search value="${fmt.escape(panelState.search)}">
              <select aria-label="Filter by severity" data-ih-severity><option value="">All severities</option>${["Critical","High","Medium","Low"].map((item) => `<option${panelState.severity === item ? " selected" : ""}>${item}</option>`).join("")}</select>
              <select aria-label="Filter by status" data-ih-status><option value="">All statuses</option>${OPEN_STATUSES.map((item) => `<option${panelState.status === item ? " selected" : ""}>${item}</option>`).join("")}</select>
            </div>
            <div class="ep-table-wrap"><table class="ep-table ep-ih__tickets"><thead><tr>${TICKET_COLUMNS.map((column) => columnHeader(column, "ticket")).join("")}</tr></thead>
              <tbody>${ticketRows || `<tr><td colspan="11"><div class="ep-ih__empty">${panelState.ticketsError
                ? `<strong>Tickets unavailable</strong><span>Open ${labelLower} tickets could not be loaded.</span>`
                : panelState.loading
                  ? `<strong>Loading open ${labelLower} tickets…</strong>`
                  : `<strong>✓ All ${labelLower}s running</strong><span>No open ${labelLower} tickets in this scope.</span>`}</div></td></tr>`}</tbody></table></div>
          </section>
          ${panelState.unitsRestricted || panelState.unitsError ? "" : `<details class="ep-panel ep-ih__settings" ${host.querySelector(".ep-ih__settings[open]") ? "open" : ""}><summary>${fmt.escape(label)} unit configuration</summary>
              ${typeConfig.type === "string"
                ? `<p class="ep-ih__reason">For plants without a saved String count, the health total is derived from the Module Cleaning table count and is not saved as unit configuration.</p>`
                : ""}
            <div class="ep-table-wrap"><table class="ep-table"><thead><tr><th>Plant</th><th>Total units</th><th>Units/day</th><th>Maker</th><th>Capacity (kW)</th><th></th></tr></thead><tbody>${settingsRows}</tbody></table></div>
            ${!panelState.canEdit ? `<p class="ep-ih__reason">Unit configuration is read-only for your role.</p>` : ""}
            <p class="ep-ih__save-status${panelState.saveError ? " is-error" : ""}" data-ih-save-status aria-live="polite">${fmt.escape(panelState.saveMessage)}</p>
          </details>`}
        </div>
      </section>`;
      wireColumnFilters(host);
    }

    function closeHealth(restoreHistory) {
      const host = getHost();
      panelState.open = false;
      if (host) host.hidden = true;
      const current = global.history.state;
      if (current && current[typeConfig.historyKey]) {
        if (restoreHistory !== false) global.history.back();
        else {
          const next = Object.assign({}, current);
          delete next[typeConfig.historyKey];
          global.history.replaceState(next, "");
        }
      }
      const tile = document.querySelector('[data-overview-destination="' + typeConfig.destination + '"]');
      if (tile && restoreHistory !== false) tile.focus();
    }

    function openHealth(fromHistory) {
      if (!S()) return;
      if (!fromHistory) {
        const current = global.history.state;
        if (!current || !current[typeConfig.historyKey]) {
          const next = current && typeof current === "object" ? Object.assign({}, current) : {};
          next[typeConfig.historyKey] = true;
          global.history.pushState(next, "");
        }
      }
      panelState.open = true;
      if (!fromHistory) {
        panelState.plantFilter = "";
        panelState.search = "";
        panelState.severity = "";
        panelState.status = "";
        panelState.expanded = [];
        panelState.plantSort = { key: "", dir: "" };
      }
      panelState.navigationError = "";
      const host = getHost();
      if (host) host.hidden = false;
      if (!global.Solar91PortalSort && global.Solar91Modules) {
        global.Solar91Modules.load("table-sort").then(renderHealth).catch(() => {});
      }
      loadHealth();
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

    function exportPlantCsv() {
      const label = typeConfig.label;
      const columns = ["Plant", "Site code", "Total " + label.toLowerCase() + "s", "Maker", "Capacity (kW)",
        "Running", "Not running", "Issue description", "Running %", "Open tickets"];
      const values = sortedPlantRows().map((row) => {
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
      downloadCsv(typeConfig.type + "-health-plants.csv", columns, values);
    }

    function exportTicketCsv() {
      const rows = filteredTickets();
      const label = typeConfig.label;
      const columns = ["Plant", "Site code", label, "Units", "Sub-problem", "Issue description",
        "Severity", "Status", "Reported", "ETC", "Assignee", "Ticket"];
      const values = rows.map((ticket) => {
        const plant = detailsPlant(ticket);
        return [plant ? (plant.displayName || plant.plantName) : "Plant unavailable", plant ? plant.siteCode : "",
          ticket.serial_no || "Unit not recorded", ticket.unit_count == null ? 1 : ticket.unit_count,
          ticket.subcategory || "", ticket.description || "", ticket.severity || "", ticket.status || "",
          ticket.occurred_at || "", ticket.etc_at || "", ticket.assignee_text || "", ticket.ticket_no || ""];
      });
      downloadCsv(typeConfig.type + "-health.csv", columns, values);
    }

    function saveConfig(siteCode, button) {
      const host = getHost();
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
        panelState.saveMessage = message;
        panelState.saveError = true;
        status.textContent = message;
        status.classList.add("is-error");
      };
      if (!Number.isInteger(total) || total < 1 || total > 500 ||
          !Number.isInteger(perDay) || perDay < 1 || perDay > 500) {
        fail("Total units and units/day must each be between 1 and 500.");
        return;
      }
      const maker = ((makerInput && makerInput.value) || "").trim().slice(0, 120) || null;
      const capacityText = ((capacityInput && capacityInput.value) || "").trim();
      const capacity = capacityText === "" ? null : Number(capacityText);
      if (capacity !== null && (!isFinite(capacity) || capacity <= 0)) {
        fail("Capacity (kW) must be a positive number, or left blank.");
        return;
      }
      button.disabled = true;
      panelState.saveMessage = "Saving…";
      panelState.saveError = false;
      status.textContent = panelState.saveMessage;
      global.Solar91PortalAPI.request("/api/pm-plan/unit-config", {
        method: "PUT",
        body: { plant: siteCode, equipment_type: typeConfig.vertical, total_units: total, units_per_day: perDay,
          maker: maker, capacity_kw: capacity }
      }).then(() => {
        panelState.saveMessage = "Configuration saved.";
        panelState.saveError = false;
        equipmentCache.loaded = false;
        reloadTile();
        loadHealth();
      }).catch((error) => {
        panelState.saveMessage = "Could not save configuration: " + ((error && error.message) || "please retry.");
        panelState.saveError = true;
        status.textContent = panelState.saveMessage;
        status.classList.add("is-error");
        button.disabled = false;
      });
    }

    function wireHealth() {
      const host = getHost();
      if (!host || host.dataset.wired) return;
      host.dataset.wired = "true";
      host.addEventListener("click", (event) => {
        const close = event.target.closest("[data-ih-close]");
        if (close) { closeHealth(); return; }
        const sortBy = event.target.closest("[data-ih-sort]");
        if (sortBy) {
          const Sort = global.Solar91PortalSort;
          if (Sort) {
            Sort.next(panelState.plantSort, sortBy.getAttribute("data-ih-sort"));
            renderHealth();
            const again = host.querySelector('[data-ih-sort="' + panelState.plantSort.key + '"]');
            if (again) again.focus();
          }
          return;
        }
        const unfold = event.target.closest("[data-ih-unfold]");
        if (unfold) {
          const code = unfold.dataset.ihUnfold;
          const at = panelState.expanded.indexOf(code);
          if (at === -1) panelState.expanded.push(code);
          else panelState.expanded.splice(at, 1);
          renderHealth();
          const again = Array.from(host.querySelectorAll("[data-ih-unfold]"))
            .find((button) => button.dataset.ihUnfold === code);
          if (again) again.focus();
          return;
        }
        const plant = event.target.closest("[data-ih-plant-row]");
        if (plant) { panelState.plantFilter = plant.dataset.ihPlantRow; renderHealth(); return; }
        if (event.target.closest("[data-ih-clear-plant]")) { panelState.plantFilter = ""; renderHealth(); return; }
        if (event.target.closest("[data-ih-export-plants]")) { exportPlantCsv(); return; }
        if (event.target.closest("[data-ih-export]")) { exportTicketCsv(); return; }
        const save = event.target.closest("[data-ih-save]");
        if (save) { saveConfig(save.dataset.ihSave, save); return; }
        const ticket = event.target.closest("[data-ih-ticket], [data-ih-edit]");
        if (ticket) {
          const code = ticket.dataset.ihSite;
          const mode = ticket.matches("[data-ih-edit]") ? "edit" : "details";
          const row = S() && S().allRows.find(({ plant }) => plant.siteCode === code);
          const dateRange = S() && { startDate: S().rangeStart, endDate: S().rangeEnd };
          const openTicketInHealth = () => {
            if (!global.Solar91PortalIssues) throw new Error("The Health issue register is unavailable.");
            closeHealth(false);
            if (row) global.Solar91PortalNav.selectPlantPage(code, "health", dateRange, row.plant);
            else global.Solar91PortalNav.selectView("health", dateRange);
            global.Solar91PortalIssues.openTicket(ticket.dataset.ihTicket || ticket.dataset.ihEdit, code, mode);
          };
          const reportNavigationError = (error) => {
            panelState.navigationError = "Could not open the Health issue register: " +
              ((error && error.message) || "please retry.");
            renderHealth();
          };
          if (global.Solar91Modules) {
            global.Solar91Modules.load("site-issues").then(openTicketInHealth).catch(reportNavigationError);
          } else {
            try { openTicketInHealth(); } catch (error) { reportNavigationError(error); }
          }
        }
      });
      host.addEventListener("input", (event) => {
        const selector = event.target.matches("[data-ih-search]") ? "[data-ih-search]"
          : event.target.matches("[data-ih-plant-search]") ? "[data-ih-plant-search]" : "";
        if (!selector) return;
        if (selector === "[data-ih-search]") panelState.search = event.target.value;
        else panelState.plantSearch = event.target.value;
        renderHealth();
        const input = host.querySelector(selector);
        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
      });
      host.addEventListener("change", (event) => {
        if (event.target.matches("[data-ih-severity]")) panelState.severity = event.target.value;
        else if (event.target.matches("[data-ih-status]")) panelState.status = event.target.value;
        else if (event.target.matches("[data-ih-only-issues]")) panelState.onlyIssues = event.target.checked;
        else return;
        renderHealth();
      });
      host.addEventListener("keydown", (event) => {
        if (event.target.matches("[data-ih-plant-row]") && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          panelState.plantFilter = event.target.dataset.ihPlantRow;
          renderHealth();
        }
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && panelState.open) closeHealth();
      });
      document.addEventListener("click", (event) => {
        const route = event.target.closest(".ep-sidebar [data-nav], .ep-sidebar .ep-nav-plant__toggle");
        if (route && panelState.open) closeHealth(false);
      }, true);
      global.addEventListener("popstate", (event) => {
        const isOpen = !!(event.state && event.state[typeConfig.historyKey]);
        if (isOpen && !panelState.open) openHealth(true);
        else if (!isOpen && panelState.open) closeHealth(true);
      });
    }

    wireHealth();
    return {
      open: openHealth,
      close: closeHealth,
      reload: loadHealth,
      isOpen: () => panelState.open
    };
  }

  global.Solar91EquipmentHealth = {
    /** Create (or return the existing) panel for a given equipment type. */
    create: function (typeConfig, ctx) {
      const existing = panels.get(typeConfig.type);
      if (existing) return existing;
      const p = create(typeConfig, ctx);
      panels.set(typeConfig.type, p);
      return p;
    }
  };
}(window));
