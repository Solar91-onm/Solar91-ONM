/**
 * overview.js
 * ─────────────────────────────────────────────────────────────────────
 * The portfolio-wide Overview tab.
 *
 * Keeps the DOM thin: four summary tiles up top, then full-width tables for
 * PM compliance, Washing compliance, a combined operational comparison, and
 * a compact Critical Issues panel. Nothing re-renders unless the data really
 * changes, so repeated tab switches are cheap.
 */
(function (global) {
  "use strict";

  const data = global.Solar91PortalData;
  const fmt = global.Solar91PortalFormat;
  let activityCache = null;
  let rangeRequest = 0;
  let rangeKey = "";
  let trendRequest = 0;

  let state = null;      // { allRows, rows, totals, sort }
  let searchTerm = "";
  const filters = { plant: "__all", health: "__all", company: "__all", district: "__all" };

  function applyFilters(rows) {
    return rows.filter(({ plant, profile }) => {
      if (filters.plant !== "__all" && plant.siteCode !== filters.plant) return false;
      if (filters.health !== "__all" && profile.derivedCondition !== filters.health) return false;
      if (filters.company !== "__all" && (plant.projectCompany || "") !== filters.company) return false;
      if (filters.district !== "__all" && (plant.district || "") !== filters.district) return false;
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

  function loadRange(startDate, endDate) {
    if (!state) return;
    const requestId = ++rangeRequest;
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
    const key = startDate + ":" + endDate;
    if (key === rangeKey) {
      rangeRequest -= 1;
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
    loadRange(startDate, period === "yesterday" ? shiftDate(today, -1) : today);
  }

  function recomputeAndRender() {
    const filtered = applyFilters(state.periodRows || state.allRows);
    state.rows = filtered;
    state.totals = data.aggregatePortfolio(filtered);
    render();
  }

  function populateFilterOptions(allRows) {
    // Searchable plant filter combobox
    const plantCombo = document.querySelector("[data-plant-filter-combo]");
    const plantInput = document.querySelector("[data-plant-filter-input]");
    const plantPanel = document.querySelector("[data-plant-filter-panel]");
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
      plantInput.addEventListener("input", () => { plantCombo.classList.add("is-open"); renderPlantOptions(plantInput.value); });
      plantPanel.addEventListener("click", (ev) => {
        const opt = ev.target.closest("[data-plant-opt]");
        if (!opt) return;
        const code = opt.getAttribute("data-plant-opt");
        filters.plant = code;
        if (code === "__all") {
          plantInput.value = "";
          plantInput.placeholder = "All plants";
        } else {
          const row = allRows.find(({ plant }) => plant.siteCode === code);
          plantInput.value = row ? (row.plant.displayName || row.plant.plantName) : code;
          plantInput.placeholder = "All plants";
        }
        plantCombo.classList.remove("is-open");
        recomputeAndRender();
        loadTrendFromControls();
      });
      document.addEventListener("click", (ev) => {
        if (!plantCombo.contains(ev.target)) plantCombo.classList.remove("is-open");
      });
    }
    const companySel = document.querySelector("[data-filter=\"company\"]");
    if (companySel && companySel.options.length <= 1) {
      const seen = new Map();
      allRows.forEach(({ plant }) => {
        const full = plant.projectCompany || "";
        if (full && !seen.has(full)) seen.set(full, plant.projectCompanyShort || full);
      });
      Array.from(seen.entries())
        .sort((a, b) => {
          const na = parseInt((a[1].match(/\d+/) || [0])[0]) || 0;
          const nb = parseInt((b[1].match(/\d+/) || [0])[0]) || 0;
          return na - nb;
        })
        .forEach(([fullName, shortName]) => {
          const opt = document.createElement("option");
          opt.value = fullName;
          opt.textContent = shortName;
          companySel.appendChild(opt);
        });
    }
    const districtSel = document.querySelector("[data-filter=\"district\"]");
    if (districtSel && districtSel.options.length <= 1) {
      const districtsByKey = new Map();
      allRows.forEach(({ plant }) => {
        const district = (plant.district || "").trim();
        const key = district.toLocaleLowerCase();
        if (district && !districtsByKey.has(key)) districtsByKey.set(key, district);
      });
      const districts = Array.from(districtsByKey.values())
        .sort((a, b) => a.localeCompare(b));
      districts.forEach((district) => {
        const opt = document.createElement("option");
        opt.value = district;
        opt.textContent = district;
        districtSel.appendChild(opt);
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
        if (filterName === "district" || filterName === "company") loadTrendFromControls();
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
        input.addEventListener("change", () => loadRange(fromDate.value, toDate.value));
      });
    }
    const trendFrom = document.querySelector("[data-trend-from]");
    const trendTo = document.querySelector("[data-trend-to]");
    const trendApply = document.querySelector("[data-trend-apply]");
    if (trendFrom && trendTo) {
      trendFrom.max = today;
      trendTo.max = today;
      trendFrom.value = firstOfMonth;
      trendTo.value = today;
      [trendFrom, trendTo].forEach((input) => {
        input.addEventListener("change", loadTrendFromControls);
      });
      if (trendApply) trendApply.addEventListener("click", loadTrendFromControls);
      loadTrendFromControls();
    }
    if (dateToggle) dateToggle.addEventListener("change", () => {
      const isRange = dateToggle.checked;
      if (quickView) quickView.style.display = isRange ? "none" : "";
      if (rangeView) rangeView.style.display = isRange ? "" : "none";
      if (isRange && fromDate && toDate) loadRange(fromDate.value, toDate.value);
      else loadQuickPeriod(document.querySelector('[data-filter="date"]').value);
    });
    loadQuickPeriod(document.querySelector('[data-filter="date"]').value);
  }

  function trendStatus(message, isError) {
    const status = document.querySelector("[data-overview-trend-status]");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("is-error", !!isError);
  }

  function renderTrendChart(trend) {
    const host = document.querySelector("[data-overview-trend-chart]");
    if (!host) return;
    const series = trend.series || [];
    if (!trend.labels.length || !series.length) {
      host.innerHTML = '<p class="ep-overview-trend__empty">No trend data is available for this range.</p>';
      return;
    }

    const width = 920;
    const height = 300;
    const left = 52;
    const right = 48;
    const top = 18;
    const bottom = 42;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const issueSeries = series.find((item) => item.axis === "count");
    const issueMax = Math.max(0, ...(issueSeries ? issueSeries.values : []));
    const issueStep = Math.max(1, Math.ceil(issueMax / 4));
    const issueAxisMax = issueStep * 4;
    const bucketWidth = plotWidth / trend.labels.length;
    const colors = { washing: "washing", pm: "pm", issues: "issues" };
    const grid = [0, 25, 50, 75, 100].map((value, index) => {
      const y = top + plotHeight - value * plotHeight / 100;
      const issueValue = index * issueStep;
      return '<g><line class="ep-overview-trend__grid" x1="' + left + '" y1="' + y +
        '" x2="' + (width - right) + '" y2="' + y + '"></line><text class="ep-overview-trend__axis" x="' +
        (left - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + value + '%</text>' +
        '<text class="ep-overview-trend__axis" x="' + (width - right + 8) + '" y="' + (y + 4) +
        '" text-anchor="start">' + issueValue + '</text></g>';
    }).join("");
    const barWidth = Math.max(2, Math.min(18, bucketWidth * 0.22));
    const barGap = Math.max(1, Math.min(5, bucketWidth * 0.045));
    const groupWidth = barWidth * series.length + barGap * (series.length - 1);
    const bars = series.map((item, seriesIndex) => {
      const cls = colors[item.key] || "issues";
      return item.values.map((value, bucketIndex) => {
        if (value === null || value === undefined) return "";
        const scaled = item.axis === "percent"
          ? Math.max(0, Math.min(100, Number(value))) / 100
          : Math.max(0, Number(value)) / issueAxisMax;
        const barHeight = scaled * plotHeight;
        const x = left + bucketIndex * bucketWidth + (bucketWidth - groupWidth) / 2 +
          seriesIndex * (barWidth + barGap);
        const y = top + plotHeight - barHeight;
        return '<rect class="ep-overview-trend__bar ep-overview-trend__bar--' + cls +
          '" x="' + x + '" y="' + y + '" width="' + barWidth + '" height="' + Math.max(barHeight, 0.8) +
          '" rx="1"><title>' + fmt.escape(trend.labels[bucketIndex] + ": " + item.label + " " +
            value + (item.axis === "percent" ? "%" : "")) + '</title></rect>';
      }).join("");
    }).join("");
    const labelStep = Math.max(1, Math.ceil(trend.labels.length / 6));
    const xIndices = trend.labels.map((_, index) => index)
      .filter((index) => index % labelStep === 0 || index === trend.labels.length - 1);
    const xLabels = xIndices.map((index) => '<text class="ep-overview-trend__x-label" x="' +
      (left + index * bucketWidth + bucketWidth / 2) +
      '" y="' + (height - 12) + '" text-anchor="' + (index === 0 ? "start" : index === trend.labels.length - 1 ? "end" : "middle") +
      '">' + fmt.escape(trend.labels[index]) + '</text>').join("");
    const legend = series.map((item) => {
      const cls = colors[item.key] || "health";
      return '<span class="ep-overview-trend__legend-item"><i class="ep-overview-trend__legend-mark ep-overview-trend__legend-mark--' +
        cls + '"></i>' + fmt.escape(item.label) + '</span>';
    }).join("");
    host.innerHTML = '<svg class="ep-overview-trend__svg" viewBox="0 0 ' + width + " " + height +
      '" role="img" aria-label="Washing compliance, PM compliance and active site issues from ' +
      fmt.escape(trend.startDate) + " to " + fmt.escape(trend.endDate) +
      '. Left axis: compliance percentage. Right axis: active issue count.">' + grid + bars + xLabels +
      '<text class="ep-overview-trend__axis-label" x="' + left + '" y="12">Compliance (%)</text>' +
      '<text class="ep-overview-trend__axis-label" x="' + (width - right) + '" y="12" text-anchor="end">Active issues</text>' +
      '</svg><div class="ep-overview-trend__legend">' +
      legend + '</div>';
  }

  function loadTrendFromControls() {
    if (!state) return;
    const startDate = document.querySelector("[data-trend-from]")?.value;
    const endDate = document.querySelector("[data-trend-to]")?.value;
    if (!startDate || !endDate || startDate > endDate) {
      trendRequest += 1;
      trendStatus("Choose a start date on or before the end date.", true);
      return;
    }
    if (endDate > state.businessDate) {
      trendRequest += 1;
      trendStatus("The trend end date cannot be in the future.", true);
      return;
    }
    const requestId = ++trendRequest;
    const trendRows = state.allRows.filter(({ plant }) => {
      if (filters.plant !== "__all" && plant.siteCode !== filters.plant) return false;
      if (filters.company !== "__all" && (plant.projectCompany || "") !== filters.company) return false;
      if (filters.district !== "__all" && (plant.district || "") !== filters.district) return false;
      return true;
    });
    if (!trendRows.length) {
      trendStatus("No plants match the selected filters.", false);
      renderTrendChart({ labels: [], series: [] });
      return;
    }
    const siteCodes = trendRows.length === state.allRows.length &&
      filters.plant === "__all" && filters.company === "__all" && filters.district === "__all"
      ? []
      : trendRows.map(({ plant }) => plant.siteCode);
    trendStatus("Loading trend…", false);
    data.fetchPortfolioTrend(startDate, endDate, siteCodes).then((trend) => {
      if (!state || requestId !== trendRequest) return;
      renderTrendChart(trend);
      const plantName = filters.plant !== "__all"
        ? (trendRows[0].plant.displayName || filters.plant)
        : trendRows.length === state.allRows.length ? "all plants" : trendRows.length + " filtered plants";
      trendStatus("Showing washing compliance, PM compliance and active site issues for " + plantName +
        " · " + trend.startDate + " to " + trend.endDate + ".", false);
    }).catch((error) => {
      if (requestId !== trendRequest) return;
      trendStatus("Could not load trend: " + error.message, true);
      const host = document.querySelector("[data-overview-trend-chart]");
      if (host) host.innerHTML = '<p class="ep-overview-trend__empty">Trend could not be loaded.</p>';
    });
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

    const pmP  = pill("PM", pmPct, totals.pmOverdue);
    const wshP = pill("Washing", wshPct, totals.washingOverdue);
    const isP  = issuePill(totals.criticalIssues, openIss);

    const ICON_PM = `<svg class="ep-metric__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M16 2v4M8 2v4M3 10h18"></path><path d="m9 16 2 2 4-4"></path></svg>`;
    const ICON_WASH = `<svg class="ep-metric__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"></path><path d="M6 8h12l-1.5 12h-9L6 8z"></path><path d="M4.22 10.22A8 8 0 0 0 12 22a8 8 0 0 0 7.78-11.78"></path></svg>`;
    const ICON_ISSUES = `<svg class="ep-metric__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

    const cards = [
      {
        title: "PM Compliance",
        icon: ICON_PM,
        value: pmPct === null ? "—" : pmPct + "%",
        pill: pmP,
        hints: [
          { strong: true,  dot: "green", text: `${fmt.formatNumber(totals.pmCompleted)} completed activities` },
          { strong: false, dot: totals.pmOverdue > 0 ? "red" : "amber", text: `${fmt.formatNumber(totals.pmPending)} pending · ${fmt.formatNumber(totals.pmOverdue)} overdue` }
        ]
      },
      {
        title: "Washing Compliance",
        icon: ICON_WASH,
        value: wshPct === null ? "—" : wshPct + "%",
        pill: wshP,
        hints: [
          { strong: true,  dot: "green", text: `${fmt.formatNumber(totals.washingCompleted)} cycles done` },
          { strong: false, dot: totals.washingOverdue > 0 ? "red" : "amber", text: `${fmt.formatNumber(totals.washingPending)} pending · ${fmt.formatNumber(totals.washingOverdue)} overdue` }
        ]
      },
      {
        title: "Open Site Issues",
        icon: ICON_ISSUES,
        value: fmt.formatNumber(openIss),
        pill: isP,
        hints: [
          { strong: true,  dot: totals.criticalIssues > 0 ? "red" : "green", text: `${fmt.formatNumber(totals.criticalIssues)} critical · ${fmt.formatNumber(totals.mediumIssues)} medium` },
          { strong: false, text: `${fmt.formatNumber(totals.closedIssues)} closed to date · ${fmt.formatNumber(totals.plantsWithOpenIssues)} plants affected` }
        ]
      }
    ];

    document.querySelector("[data-overview-metrics]").innerHTML = cards.map((c) => `
      <div class="ep-metric">
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
        <div class="ep-kv__item"><span class="ep-kv__k">Portfolio Washing Compliance</span><span class="ep-kv__v">${totals.washingCompliancePercent === null ? "N/A" : totals.washingCompliancePercent + "%"}</span></div>
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
    renderTiles(state.totals);
    rendered = true;
  }

  function wireInteractions() {
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

  function init() {
    wireInteractions();
    data.fetchPortfolio().then((portfolio) => {
      state = {
        allRows: portfolio.rows,
        periodRows: portfolio.rows,
        rows: portfolio.rows,
        totals: portfolio.totals,
        businessDate: portfolio.businessDate,
        sort: { column: "health", dir: "asc" }
      };
      populateFilterOptions(portfolio.rows);
      render();
    });
  }

  global.Solar91PortalOverview = {
    init,
    rerender: render,
    get isRendered() { return rendered; }
  };
}(window));
