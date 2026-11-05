/**
 * data-adapter.js
 * ─────────────────────────────────────────────────────────────────────
 * The one place that knows where the portal reads data from.
 *
 * Every figure comes from the Solar91 database through the read-only,
 * role-scoped portal API (app/portal/router.py):
 *
 *   GET /api/portal/plants                     plant records
 *   GET /api/portal/overview                   plants + profiles + totals (one call)
 *   GET /api/portal/plants/:code               one plant, profile, activity
 *   GET /api/portal/activity?site_code=        recent real events
 *   GET /api/portal/calendar?kind=&month=      dated PM / washing records
 *
 * The server decides scope. Missing data arrives as null and stays null so the
 * UI shows "Not available" instead of a misleading zero.
 *
 * UI modules (overview.js, plants-table.js, plant-details.js, …) depend only on
 * this module's public API, which is unchanged from Phase 1.
 */
(function (global) {
  "use strict";

  function api() {
    if (!global.Solar91PortalAPI) throw new Error("Portal API client is not loaded.");
    return global.Solar91PortalAPI;
  }

  // Business rules mirrored from the owning backend modules (documentation only;
  // the server applies them when it counts).
  const BUSINESS_RULES = {
    issue: {
      openStates: ["Open", "Assigned", "Acknowledged", "In Progress",
                   "Pending Vendor", "Pending Parts/Vendor"],
      closedStates: ["Resolved", "Closed"],
      severities: ["Critical", "Medium"],
      severityAliases: { High: "Critical", Low: "Medium" }
    },
    pm: {
      openStates: ["Scheduled", "In Progress"],
      closedStates: ["Completed"],
      cancelledStates: ["Cancelled"],
      overdueRule: "(planned_due_on or due_on) < today AND status not in {Completed, Cancelled}"
    },
    washing: {
      cyclesPerMonth: 3,
      windows: ["day 1 – 10", "day 11 – 20", "day 21 – month end"],
      excusedNote: "Days with 0 tables cleaned are excused only when the remark matches a configured reason",
      defaultComplianceThresholdPercent: 85
    }
  };

  const HEALTH_THRESHOLDS = Object.freeze({
    criticalIfOpenCriticalIssuesAtLeast: 1,
    attentionIfOpenIssuesAtLeast: 2,
    attentionIfPmComplianceBelow: 80,
    attentionIfWashingComplianceBelow: 80
  });

  function classifyCondition(profile) {
    if (!profile || profile.condition === "unknown") return "unknown";
    if ((profile.criticalIssues || 0) >= HEALTH_THRESHOLDS.criticalIfOpenCriticalIssuesAtLeast) return "critical";
    if ((profile.openIssues || 0) >= HEALTH_THRESHOLDS.attentionIfOpenIssuesAtLeast) return "attention";
    const pmPct = profile.pm && profile.pm.compliancePercent;
    const wshPct = profile.washing && profile.washing.compliancePercent;
    if (pmPct !== null && pmPct !== undefined && pmPct < HEALTH_THRESHOLDS.attentionIfPmComplianceBelow) return "attention";
    if (wshPct !== null && wshPct !== undefined && wshPct < HEALTH_THRESHOLDS.attentionIfWashingComplianceBelow) return "attention";
    return "healthy";
  }

  // ── Caches (one portfolio load serves Overview, Details and calendars) ──
  const PORTFOLIO_TTL_MS = 60 * 1000;
  let portfolioPromise = null;
  let portfolioLoadedAt = 0;
  const calendarCache = new Map();   // "kind:month" → Promise<entries[]>

  // The Overview range and trend endpoints are re-requested every time a filter
  // or the Range selector changes, and operators flip between the same few
  // combinations constantly ("This month" → "This week" → back). Keeping the
  // recent answers means the second visit to a combination costs no request at
  // all, and two rapid changes to the same combination share one in-flight
  // promise instead of racing. Bounded, so a long session cannot grow it
  // without limit, and TTL'd to the same minute as the portfolio so a new
  // record still shows up promptly.
  const RANGE_CACHE_MAX = 24;
  const rangeCache = new Map();   // request key → { at, promise }

  function cached(key, load) {
    const hit = rangeCache.get(key);
    if (hit && Date.now() - hit.at <= PORTFOLIO_TTL_MS) {
      // Refresh insertion order so the entries in active use are evicted last.
      rangeCache.delete(key);
      rangeCache.set(key, hit);
      return hit.promise;
    }
    const entry = { at: Date.now(), promise: null };
    entry.promise = load().catch(function (error) {
      // A failure must never be cached: the next attempt has to reach the API.
      if (rangeCache.get(key) === entry) rangeCache.delete(key);
      throw error;
    });
    rangeCache.set(key, entry);
    while (rangeCache.size > RANGE_CACHE_MAX) {
      rangeCache.delete(rangeCache.keys().next().value);
    }
    return entry.promise;
  }

  function normalizeRow(row) {
    const plant = api().normalizePlant(row.plant);
    const profile = Object.assign({}, row.profile);
    profile.derivedCondition = profile.derivedCondition || classifyCondition(profile);
    return { plant: plant, profile: profile };
  }

  /** Plants + profiles + totals in a single request. Cached briefly. */
  function fetchPortfolio(force) {
    const stale = Date.now() - portfolioLoadedAt > PORTFOLIO_TTL_MS;
    if (!portfolioPromise || force || stale) {
      portfolioLoadedAt = Date.now();
      portfolioPromise = api().request("/api/portal/overview").then(function (body) {
        const rows = (body.rows || []).map(normalizeRow);
        return {
          rows: rows,
          totals: body.totals || aggregatePortfolio(rows),
          asOf: body.asOf || null,
          businessDate: body.businessDate || null,
          scope: body.scope || "portfolio"
        };
      }).catch(function (error) {
        portfolioPromise = null;
        throw error;
      });
    }
    return portfolioPromise;
  }

  function fetchPortfolioRange(startDate, endDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate)) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(endDate))) {
      return Promise.reject(new Error("Overview date range requires valid start and end dates."));
    }
    return cached("range:" + startDate + ":" + endDate, function () {
      return api().request(
        "/api/portal/overview/range?start_date=" + encodeURIComponent(startDate) +
        "&end_date=" + encodeURIComponent(endDate)
      ).then(function (body) {
        return {
          rows: (body.rows || []).map(normalizeRow),
          totals: body.totals || {},
          startDate: body.startDate,
          endDate: body.endDate
        };
      });
    });
  }

  function fetchPortfolioTrend(startDate, endDate, siteCodes) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate)) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(endDate))) {
      return Promise.reject(new Error("Overview trend requires a valid date range."));
    }
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate
    });
    // Sorted so that the same set of plants selected in a different order is
    // one cache entry, not two.
    const codes = (Array.isArray(siteCodes) ? siteCodes : siteCodes ? [siteCodes] : [])
      .slice().sort();
    codes.forEach(function (siteCode) { params.append("site_code", siteCode); });
    const query = params.toString();
    return cached("trend:" + query, function () {
      return api().request("/api/portal/overview/trend?" + query);
    });
  }

  function listPlants() {
    return api().plants();
  }

  function getPlant(siteCode) {
    return listPlants().then(function (plants) {
      return plants.find(function (p) { return p.siteCode === siteCode; }) || null;
    });
  }

  /** One plant's full record, profile and recent activity. */
  function fetchPlantDetails(siteCode) {
    return api().request("/api/portal/plants/" + encodeURIComponent(siteCode)).then(function (body) {
      const row = normalizeRow({ plant: body.plant, profile: body.profile });
      return {
        plant: row.plant,
        profile: row.profile,
        activity: body.activity || [],
        issueTotal: body.issueTotal || 0,
        pmCancelled: body.pmCancelled || 0
      };
    });
  }

  function fetchOperationalProfile(plant) {
    return fetchPortfolio().then(function (portfolio) {
      const row = portfolio.rows.find(function (r) { return r.plant.siteCode === plant.siteCode; });
      if (row) return row.profile;
      return api().request("/api/portal/plants/" + encodeURIComponent(plant.siteCode) + "/operational")
        .then(function (profile) {
          profile.derivedCondition = profile.derivedCondition || classifyCondition(profile);
          return profile;
        });
    });
  }

  function fetchActivity(plant, _profile, limit) {
    const qs = "?limit=" + (limit || 10) + (plant ? "&site_code=" + encodeURIComponent(plant.siteCode) : "");
    return api().request("/api/portal/activity" + qs).then(function (body) {
      return body.activity || [];
    });
  }

  /**
   * Dated PM / Washing records for a month. The whole visible portfolio is read
   * once per (kind, month) and filtered per plant here, so a calendar that asks
   * for every plant costs one request, not one per plant.
   */
  function fetchCalendarActivities(plant, _profile, kind, month) {
    if (!/^(pm|washing)$/.test(kind) || !/^\d{4}-\d{2}$/.test(String(month))) {
      return Promise.reject(new Error("Calendar activity requires a supported activity type and YYYY-MM month."));
    }
    const key = kind + ":" + month;
    if (!calendarCache.has(key)) {
      calendarCache.set(key, api().request(
        "/api/portal/calendar?kind=" + kind + "&month=" + encodeURIComponent(month)
      ).then(function (body) {
        return body.entries || [];
      }).catch(function (error) {
        calendarCache.delete(key);
        throw error;
      }));
      // Calendars should reflect new records within a minute.
      setTimeout(function () { calendarCache.delete(key); }, PORTFOLIO_TTL_MS);
    }
    return calendarCache.get(key).then(function (entries) {
      if (!plant) return entries.slice();
      return entries.filter(function (e) { return e.plantSiteCode === plant.siteCode; });
    });
  }

  /** Recompute totals for a filtered set of rows (Overview filters use this). */
  function aggregatePortfolio(rows) {
    const totals = {
      totalPlants: rows.length,
      healthyPlants: 0, attentionPlants: 0, criticalPlants: 0, unknownPlants: 0,
      openIssues: 0, closedIssues: 0, criticalIssues: 0, mediumIssues: 0,
      unsolvedIssues: 0, inProgressIssues: 0,
      plantsWithOpenIssues: 0,
      pmCompleted: 0, pmPending: 0, pmOverdue: 0,
      washingCompleted: 0, washingPending: 0, washingOverdue: 0,
      dcCapacityMw: 0, acCapacityMw: 0
    };
    rows.forEach(function (row) {
      const plant = row.plant, profile = row.profile;
      const cond = profile.derivedCondition;
      if (cond === "healthy") totals.healthyPlants += 1;
      else if (cond === "attention") totals.attentionPlants += 1;
      else if (cond === "critical") totals.criticalPlants += 1;
      else totals.unknownPlants += 1;

      ["openIssues", "closedIssues", "criticalIssues", "mediumIssues", "unsolvedIssues", "inProgressIssues"].forEach(function (k) {
        if (typeof profile[k] === "number") totals[k] += profile[k];
      });
      if ((profile.openIssues || 0) > 0) totals.plantsWithOpenIssues += 1;

      if (profile.pm) {
        totals.pmCompleted += profile.pm.completed || 0;
        totals.pmPending   += profile.pm.pending || 0;
        totals.pmOverdue   += profile.pm.overdue || 0;
      }
      if (profile.washing) {
        totals.washingCompleted += profile.washing.completed || 0;
        totals.washingPending   += profile.washing.pending || 0;
        totals.washingOverdue   += profile.washing.overdue || 0;
      }
      if (plant.dcCapacityKw) totals.dcCapacityMw += plant.dcCapacityKw / 1000;
      if (plant.acCapacityKw) totals.acCapacityMw += plant.acCapacityKw / 1000;
    });

    const pmTotal = totals.pmCompleted + totals.pmPending + totals.pmOverdue;
    totals.pmCompliancePercent = pmTotal === 0 ? null : Math.round((totals.pmCompleted / pmTotal) * 100);
    const wshTotal = totals.washingCompleted + totals.washingPending + totals.washingOverdue;
    totals.washingCompliancePercent = wshTotal === 0 ? null : Math.round((totals.washingCompleted / wshTotal) * 100);
    totals.dcCapacityMw = Math.round(totals.dcCapacityMw * 100) / 100;
    totals.acCapacityMw = Math.round(totals.acCapacityMw * 100) / 100;
    return totals;
  }

  /** Drop caches after a write so the next read is fresh. */
  function invalidate() {
    portfolioPromise = null;
    calendarCache.clear();
    rangeCache.clear();
  }

  global.Solar91PortalData = {
    BUSINESS_RULES,
    HEALTH_THRESHOLDS,
    listPlants,
    getPlant,
    fetchPlantDetails,
    fetchOperationalProfile,
    fetchActivity,
    fetchCalendarActivities,
    fetchPortfolio,
    fetchPortfolioRange,
    fetchPortfolioTrend,
    aggregatePortfolio,
    classifyCondition,
    invalidate
  };
}(window));