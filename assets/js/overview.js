/**
 * overview.js
 * ─────────────────────────────────────────────────────────────────────
 * The portfolio-wide Overview tab.
 *
 * Three summary tiles — PM compliance, Washing compliance, Open site issues —
 * and directly below them a multi-line trend chart of the same three measures
 * over time, one line per measure.
 *
 * ONE date control drives all four. The Range selector in the filter bar is
 * the single source of truth: `applyRange` records the dates on `state` and
 * then refreshes both the tiles and the chart from them. The chart has no
 * dates of its own, so the two can never disagree.
 *
 * The plant / project / district filters narrow the tiles and chart to the
 * selected plants, while each filter keeps its full set of available options.
 */
(function (global) {
  "use strict";

  const data = global.Solar91PortalData;
  const fmt = global.Solar91PortalFormat;
  let activityCache = null;
  let rangeRequest = 0;
  let rangeKey = "";
  let trendRequest = 0;
  let trendTimer = null;

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

  /**
   * The one date control. Records the range on `state`, then refreshes the
   * tiles and the chart from it. Everything that changes the dates goes
   * through here, so the two halves of the tab always agree.
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
    loadTrend(startDate, endDate);
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

  function populateFilterOptions(allRows) {
    // Searchable plant filter combobox
    const plantCombo = document.querySelector("[data-plant-filter-combo]");
    const plantInput = document.querySelector("[data-plant-filter-input]");
    const plantPanel = document.querySelector("[data-plant-filter-panel]");
    const companySel = document.querySelector("[data-filter=\"company\"]");
    const districtSel = document.querySelector("[data-filter=\"district\"]");

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
        reloadTrendForFilters();
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
        if (filterName === "plant" || filterName === "district" || filterName === "company") {
          reloadTrendForFilters();
        }
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

    // The chart used to carry its own title, description and From / To / Apply, which could
    // disagree with the Range selector above. The Range selector drives the chart now, so that
    // header has been deleted from the page rather than hidden here: hiding it from JavaScript
    // meant a hard refresh painted it first and left it on screen until the overview finished
    // loading — or for good, if the load failed.
    // The status line stays in the markup because trendStatus() writes to it, but the range
    // status above the tiles is what the operator reads, so it is not shown.
    const trendStatusEl = document.querySelector(".ep-overview-trend__status");
    if (trendStatusEl) trendStatusEl.style.display = "none";

    if (dateToggle) dateToggle.addEventListener("change", () => {
      const isRange = dateToggle.checked;
      if (quickView) quickView.style.display = isRange ? "none" : "";
      if (rangeView) rangeView.style.display = isRange ? "" : "none";
      if (isRange && fromDate && toDate) applyRange(fromDate.value, toDate.value);
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

    // A wide, shallow viewBox. The SVG is width:100% with a preserved aspect
    // ratio, so the rendered height is containerWidth * height / width — a wider
    // box means a shorter chart. Tuned so the three tiles and the chart fit on
    // one laptop screen without scrolling.
    // 1100 keeps the scale factor near 1:1 at laptop widths, so the 11px axis
    // labels stay readable; a much wider box shrinks all the text with it.
    const width = 1100;
    const height = 220;
    const left = 46;
    const right = 44;
    const top = 14;
    const bottom = 34;
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

    // Each measure is drawn as a trend line rather than a group of bars: over a
    // long range the eye follows the direction of travel, which bars two or
    // three pixels wide cannot show. Buckets keep their centres, so the x
    // labels still sit under the points they name.
    const pointX = (index) => left + index * bucketWidth + bucketWidth / 2;
    const pointY = (item, value) => {
      const scaled = item.axis === "percent"
        ? Math.max(0, Math.min(100, Number(value))) / 100
        : Math.max(0, Number(value)) / issueAxisMax;
      return top + plotHeight - scaled * plotHeight;
    };
    // Dots would crowd into a solid band on a long range, so they appear only
    // when the buckets are few enough to read individually.
    const showDots = trend.labels.length <= 40;
    const dot = (cls, x, y) => '<circle class="ep-overview-trend__dot ep-overview-trend__dot--' +
      cls + '" cx="' + x + '" cy="' + y + '" r="2.5"></circle>';
    const lines = series.map((item) => {
      const cls = colors[item.key] || "issues";
      // A missing value is a gap in the data, not a zero, so the line breaks
      // and resumes instead of diving to the axis and back.
      const segments = [];
      let run = [];
      item.values.forEach((value, index) => {
        if (value === null || value === undefined) {
          if (run.length) segments.push(run);
          run = [];
          return;
        }
        run.push([pointX(index), pointY(item, value)]);
      });
      if (run.length) segments.push(run);
      return segments.map((points) => {
        // A lone point between two gaps has no line to draw, so it is always
        // marked — otherwise that bucket would render as nothing at all.
        if (points.length === 1) return dot(cls, points[0][0], points[0][1]);
        const path = '<polyline class="ep-overview-trend__line ep-overview-trend__line--' + cls +
          '" points="' + points.map((point) => point[0] + "," + point[1]).join(" ") + '"></polyline>';
        return path + (showDots ? points.map((point) => dot(cls, point[0], point[1])).join("") : "");
      }).join("");
    }).join("");

    // Ten ticks spread evenly across whatever range is shown, always including the
    // first and last bucket, so a month and a year are read the same way. Picking
    // the positions (rather than stepping by a divisor) keeps the count steady
    // instead of landing on 6 for one range and 16 for the next.
    const TICK_TARGET = 10;
    const lastIndex = trend.labels.length - 1;
    const tickCount = Math.min(TICK_TARGET, trend.labels.length);
    const xIndices = tickCount <= 1
      ? [0]
      : Array.from(new Set(Array.from({ length: tickCount }, (_, position) =>
          Math.round(position * lastIndex / (tickCount - 1)))));
    const xLabels = xIndices.map((index) => '<text class="ep-overview-trend__x-label" x="' +
      (left + index * bucketWidth + bucketWidth / 2) +
      '" y="' + (height - 12) + '" text-anchor="' + (index === 0 ? "start" : index === trend.labels.length - 1 ? "end" : "middle") +
      '">' + fmt.escape(trend.labels[index]) + '</text>').join("");

    // Every bar used to carry its own tooltip. A line has no comparable area to
    // hover, so one transparent target per bucket spans the plot height and
    // reports all three measures for that date together — easier to compare.
    const hovers = trend.labels.map((label, index) => {
      const readout = series.map((item) => {
        const value = item.values[index];
        return item.label + ": " + (value === null || value === undefined
          ? "no data"
          : value + (item.axis === "percent" ? "%" : ""));
      }).join("\n");
      return '<rect class="ep-overview-trend__hover" x="' + (left + index * bucketWidth) +
        '" y="' + top + '" width="' + bucketWidth + '" height="' + plotHeight +
        '"><title>' + fmt.escape(label + "\n" + readout) + '</title></rect>';
    }).join("");

    const legend = series.map((item) => {
      const cls = colors[item.key] || "health";
      return '<span class="ep-overview-trend__legend-item"><i class="ep-overview-trend__legend-mark ep-overview-trend__legend-mark--' +
        cls + '"></i>' + fmt.escape(item.label) + '</span>';
    }).join("");
    // min-height:0 overrides the stylesheet's 220px floor, which would otherwise
    // keep the chart taller than the viewBox needs.
    host.innerHTML = '<svg class="ep-overview-trend__svg" style="min-height:0" viewBox="0 0 ' + width + " " + height +
      '" role="img" aria-label="Washing compliance, PM compliance and active site issues from ' +
      fmt.escape(trend.startDate) + " to " + fmt.escape(trend.endDate) +
      '. Left axis: compliance percentage. Right axis: active issue count.">' + grid + lines + xLabels +
      '<text class="ep-overview-trend__axis-label" x="' + left + '" y="12">Compliance (%)</text>' +
      '<text class="ep-overview-trend__axis-label" x="' + (width - right) + '" y="12" text-anchor="end">Active issues</text>' +
      hovers + '</svg><div class="ep-overview-trend__legend">' +
      legend + '</div>';
  }

  /**
   * Redraw the chart for the range already in state — used when a filter changes.
   *
   * Coalesced: narrowing by plant, then district, then company used to fire a
   * request per change, and only the last one's answer was ever drawn. One
   * short delay collapses a burst of filter changes into a single request.
   */
  function reloadTrendForFilters() {
    if (!state || !state.rangeStart || !state.rangeEnd) return;
    if (trendTimer) clearTimeout(trendTimer);
    trendTimer = setTimeout(function () {
      trendTimer = null;
      if (!state || !state.rangeStart || !state.rangeEnd) return;
      loadTrend(state.rangeStart, state.rangeEnd);
    }, 150);
  }

  /**
   * Draw the chart for an explicit range. The dates always come from
   * `applyRange` (the Range selector), never from controls of its own.
   */
  function loadTrend(startDate, endDate) {
    if (!state) return;
    // The Range selector draws immediately; drop any filter reload still
    // waiting out its delay so it cannot fire a second, identical request.
    if (trendTimer) { clearTimeout(trendTimer); trendTimer = null; }
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
        title: "Washing Compliance",
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
        title: "Open Site Issues",
        destination: "health",
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
    const metrics = document.querySelector("[data-overview-metrics]");
    function openMetricDestination(card) {
      if (!state || !state.rangeStart || !state.rangeEnd) return;
      const destination = card.getAttribute("data-overview-destination");
      const dateRange = { startDate: state.rangeStart, endDate: state.rangeEnd };
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