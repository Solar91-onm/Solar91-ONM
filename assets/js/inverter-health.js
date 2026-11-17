/**
 * inverter-health.js — the Dashboard's Inverter Health drill-down, loaded on first open.
 *
 * It used to ship inside overview.js, so every sign-in downloaded ~45 KB that only someone
 * opening the Inverters tile needs. It is now a page module (assets/js/modules.js). The Dashboard
 * hands over its live state through create(ctx) -- nothing is copied -- so the panel and the
 * tile always read the same figures. S() is the Dashboard's current state (it is replaced on
 * every reload, so it is read through a getter, never kept).
 */
(function (global) {
  "use strict";

  let panel = null;

  function create(ctx) {
    const fmt = ctx.fmt;
    const filters = ctx.filters;
    const inverters = ctx.inverters;
    const isInverter = ctx.isInverter;
    const calculateInverterTotals = ctx.calculateInverterTotals;
    const loadInverters = ctx.loadInverters;
    const S = ctx.state;

    const inverterHealth = {
      open: false, loading: false, units: [], summary: null, tickets: [],
      unitsRestricted: false, unitsError: "", summaryError: "", ticketsError: "",
      canEdit: false, plantFilter: "", search: "", severity: "", status: "",
      plantSearch: "", onlyIssues: false,   // the per-plant table's own toolbar
      saveMessage: "", saveError: false, navigationError: "",
      expanded: [],  // site codes whose open inverter tickets are unfolded under the plant row
      plantSort: { key: "", dir: "" },
      plantFilters: {},    // per-column filters on the per-plant table
      ticketFilters: {}    // per-column filters on the open-ticket register   // empty: the default order (worst running % first)
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

    // The open-ticket register below. `value` is what a column filter matches and lists, so the
    // menu offers exactly the text the column shows.
    const INVERTER_TICKET_COLUMNS = [
      { key: "plant", label: "Plant", value: (t) => { const p = inverterDetailsPlant(t); return p ? (p.displayName || p.plantName) : "Plant unavailable"; } },
      { key: "inverter", label: "Inverter", value: (t) => t.serial_no || "Unit not recorded" },
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

    // Which per-plant columns can be filtered, and the text each one filters on.
    const PLANT_COLUMN_VALUE = {
      plant: (row) => row.plant.displayName || row.plant.plantName,
      inverter: (row) => (row.config && row.config.maker) || "Not configured",
      issuedesc: (row) => {
        const list = row.issueDesc || [];
        return list.length ? list[0] : "No issues";
      }
    };

    /**
     * One column heading with the Health page's filter control: a chevron that opens a popover
     * listing the values present in that column, with a search box over them. Same markup and
     * behaviour, so the two registers are filtered the same way.
     */
    function ihColumnHeader(column, scope, sortAttr, sortState) {
      const Sort = global.Solar91PortalSort;
      let header = Sort && sortAttr
        ? Sort.thHTML(column, sortState, sortAttr)
        : `<th${column.align === "num" ? ' class="num"' : ""}>${fmt.escape(column.label)}</th>`;
      const filterable = column.filter !== false &&
        (scope === "ticket" ? !!column.value : !!PLANT_COLUMN_VALUE[column.key]);
      if (!filterable) return header;

      const store = scope === "ticket" ? inverterHealth.ticketFilters : inverterHealth.plantFilters;
      const active = String(store[column.key] || "");
      const menuId = "ep-ih-filter-" + scope + "-" + column.key;
      const options = ihColumnOptions(scope, column).map((value) =>
        `<button type="button" class="ep-ih__column-filter-option" data-ih-filter-option="${column.key}"
          data-ih-filter-scope="${scope}" data-ih-filter-value="${fmt.escape(value)}"
          aria-pressed="${active === value ? "true" : "false"}">${fmt.escape(value)}</button>`).join("");
      const control = `<button type="button" class="ep-ih__filter-toggle${active ? " is-filtered" : ""}"
          data-ih-filter-toggle="${column.key}" data-ih-filter-scope="${scope}"
          aria-controls="${menuId}" aria-expanded="false"
          aria-label="Filter by ${fmt.escape(column.label)}" title="Filter by ${fmt.escape(column.label)}">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"></path></svg></button>
        <div id="${menuId}" class="ep-ih__column-filter-menu" popover="auto"
          data-ih-filter-menu="${column.key}" data-ih-filter-scope="${scope}">
          <input class="ep-ih__column-filter-search" type="search" data-ih-filter-search
            placeholder="Search options..." aria-label="Search ${fmt.escape(column.label)} options" />
          <div class="ep-ih__column-filter-options">
            <button type="button" class="ep-ih__column-filter-option" data-ih-filter-option="${column.key}"
              data-ih-filter-scope="${scope}" data-ih-filter-value=""
              aria-pressed="${active ? "false" : "true"}">All ${fmt.escape(column.label)}</button>
            ${options}
          </div>
          <div class="ep-ih__column-filter-empty" data-ih-filter-empty hidden>No matching options</div>
        </div>`;
      header = header.replace("<th", '<th class="ep-ih__th-filtered"');
      const openEnd = header.indexOf(">") + 1;
      const closeStart = header.lastIndexOf("</th>");
      return header.slice(0, openEnd) + '<div class="ep-ih__th-content">' +
        header.slice(openEnd, closeStart) + control + "</div>" + header.slice(closeStart);
    }

    /** Put the menu under the chevron, nudged inside the viewport, flipping up if it would overflow. */
    function positionIhFilter(toggle, menu) {
      const toggleRect = toggle.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(toggleRect.left, global.innerWidth - menuRect.width - 8));
      let top = toggleRect.bottom + 4;
      if (top + menuRect.height > global.innerHeight - 8) {
        top = Math.max(8, toggleRect.top - menuRect.height - 4);
      }
      menu.style.left = Math.round(left) + "px";
      menu.style.top = Math.round(top) + "px";
    }

    /** Narrow the options inside an open menu to those matching `term`. */
    function ihFilterSearch(menu, term) {
      const needle = String(term || "").trim().toLowerCase();
      let shown = 0;
      Array.prototype.forEach.call(menu.querySelectorAll("[data-ih-filter-option]"), (option) => {
        const value = option.getAttribute("data-ih-filter-value") || "";
        const match = !needle || !value || option.textContent.toLowerCase().indexOf(needle) !== -1;
        option.hidden = !match;
        if (match && value) shown += 1;
      });
      const empty = menu.querySelector("[data-ih-filter-empty]");
      if (empty) empty.hidden = !needle || shown > 0;
    }

    /** The distinct values present in one column, so the menu only offers what is there. */
    function ihColumnOptions(scope, column) {
      const seen = [];
      const add = (value) => {
        const text = String(value == null ? "" : value).trim();
        if (text && seen.indexOf(text) === -1) seen.push(text);
      };
      if (scope === "ticket") scopedInverterTickets().forEach((ticket) => add(column.value(ticket)));
      else {
        const read = PLANT_COLUMN_VALUE[column.key];
        inverterPlantRows(inverterHealthTotals()).forEach((row) => add(read(row)));
      }
      return seen.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    function ihFilterMatches(store, columns, read) {
      return Object.keys(store).every((key) => {
        const wanted = String(store[key] || "").trim();
        if (!wanted) return true;
        const column = columns.find((item) => item.key === key);
        if (!column) return true;
        return String(read(column) == null ? "" : read(column)).trim() === wanted;
      });
    }
    const ICON_INVERTER_LARGE = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M13 7l-4 6h3l-1 4 4-6h-3l1-4z"></path></svg>`;
    const INVERTER_HISTORY_KEY = "solar91InverterHealthOpen";
    const OPEN_INVERTER_STATUSES = [
      "Open", "Assigned", "Acknowledged", "In Progress", "Pending Vendor", "Pending Parts/Vendor", "Pending Closure"
    ];

    function inverterPlantScope() {
      return S() ? S().rows.map(({ plant }) => plant) : [];
    }

    function inverterScopeLabel() {
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

    function inverterDetailsPlant(issue) {
      const match = S() && S().allRows.find(({ plant }) =>
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
      return INVERTER_PLANT_COLUMNS.map((column) =>
        ihColumnHeader(column, "plant", "data-ih-sort", inverterHealth.plantSort)).join("");
    }

    // The toolbar above the per-plant table: free text over plant name, site code and maker, and
    // "only plants with issues" — a plant with a down inverter or an open ticket.
    function filteredInverterPlantRows(rows) {
      const query = inverterHealth.plantSearch.trim().toLowerCase();
      return rows.filter((row) => {
        if (inverterHealth.onlyIssues && !(row.tickets > 0 || (row.down || 0) > 0)) return false;
        if (!ihFilterMatches(inverterHealth.plantFilters, INVERTER_PLANT_COLUMNS,
            (column) => (PLANT_COLUMN_VALUE[column.key] || (() => ""))(row))) return false;
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
        if (!ihFilterMatches(inverterHealth.ticketFilters, INVERTER_TICKET_COLUMNS,
            (column) => (column.value || (() => ""))(ticket))) return false;
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
      const severityCounts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
      scopedInverterTickets().forEach((ticket) => {
        const severity = Object.keys(severityCounts).find((key) => key.toLowerCase() === String(ticket.severity || "").toLowerCase());
        if (severity) severityCounts[severity] += 1;
      });
      // No percentage ring: 375 of 376 rounds to "100%" and reads as nothing being down. The
      // headline beside it already states the running count against the total.
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
            <div class="ep-table-wrap"><table class="ep-table ep-ih__tickets"><thead><tr>${INVERTER_TICKET_COLUMNS.map((column) => ihColumnHeader(column, "ticket")).join("")}</tr></thead>
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
      if (!S()) return;
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
        // Column filter: the chevron opens the popover, an option applies and closes it.
        const filterToggle = event.target.closest("[data-ih-filter-toggle]");
        if (filterToggle) {
          const menu = host.querySelector('[data-ih-filter-menu="' + filterToggle.getAttribute("data-ih-filter-toggle") +
            '"][data-ih-filter-scope="' + filterToggle.getAttribute("data-ih-filter-scope") + '"]');
          if (menu && typeof menu.showPopover === "function") {
            if (menu.matches(":popover-open")) {
              menu.hidePopover();
              filterToggle.setAttribute("aria-expanded", "false");
            } else {
              menu.showPopover();
              // A popover is positioned against the viewport, so it opens in the top-left corner
              // until it is placed under the chevron that opened it.
              positionIhFilter(filterToggle, menu);
              filterToggle.setAttribute("aria-expanded", "true");
              const search = menu.querySelector("[data-ih-filter-search]");
              if (search) { search.value = ""; ihFilterSearch(menu, ""); search.focus(); }
            }
          }
          return;
        }
        const filterOption = event.target.closest("[data-ih-filter-option]");
        if (filterOption) {
          const key = filterOption.getAttribute("data-ih-filter-option");
          const scope = filterOption.getAttribute("data-ih-filter-scope");
          const value = filterOption.getAttribute("data-ih-filter-value") || "";
          const store = scope === "ticket" ? inverterHealth.ticketFilters : inverterHealth.plantFilters;
          if (value) store[key] = value;
          else delete store[key];
          const menu = filterOption.closest("[data-ih-filter-menu]");
          if (menu && typeof menu.hidePopover === "function") {
            try { menu.hidePopover(); } catch (error) { /* already closed */ }
          }
          const owner = host.querySelector('[data-ih-filter-toggle="' + key +
            '"][data-ih-filter-scope="' + scope + '"]');
          if (owner) owner.setAttribute("aria-expanded", "false");
          renderInverterHealth();
          return;
        }
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
          const row = S() && S().allRows.find(({ plant }) => plant.siteCode === code);
          const dateRange = S() && { startDate: S().rangeStart, endDate: S().rangeEnd };
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
        // Narrow the options inside an open filter menu without redrawing the table.
        if (event.target.matches("[data-ih-filter-search]")) {
          ihFilterSearch(event.target.closest("[data-ih-filter-menu]"), event.target.value);
          return;
        }
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

    wireInverterHealth();
    return {
      open: openInverterHealth,
      close: closeInverterHealth,
      reload: loadInverterHealth,
      isOpen: () => inverterHealth.open
    };
  }

  global.Solar91InverterHealth = {
    /** The one panel for this page, created on first use. */
    create: function (ctx) { return panel || (panel = create(ctx)); }
  };
}(window));
