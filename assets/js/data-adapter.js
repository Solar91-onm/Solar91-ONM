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
                   "Pending Vendor", "Pending Parts/Vendor", "Pending Closure"],
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
  const periodCache = new Map();

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
          dataVersion: body.dataVersion || null,
          businessDate: body.businessDate || null,
          scope: body.scope || "portfolio",
          warnings: body.warnings || []
        };
      }).catch(function (error) {
        portfolioPromise = null;
        throw error;
      });
    }
    return portfolioPromise;
  }

  /**
   * The portfolio for one of the Range selector's named periods (today / yesterday / week /
   * month / all), resolved against the business date by the server.
   *
   * The Overview used to read the whole portfolio first, purely to learn today's business date,
   * and then read it again for the chosen period — two responses of the same size on every
   * sign-in. This is the one request it now opens on; the answer carries the business date and
   * the dates the period resolved to.
   */
  function fetchPortfolioPeriod(period, force) {
    const key = "period:" + period;
    if (force) periodCache.delete(key);
    if (!periodCache.has(key)) {
      periodCache.set(key, api().request("/api/portal/overview/range?period=" + encodeURIComponent(period))
        .then(normalizeRangeBody)
        .catch(function (error) {
          periodCache.delete(key);
          throw error;
        }));
      setTimeout(function () { periodCache.delete(key); }, PORTFOLIO_TTL_MS);
    }
    return periodCache.get(key);
  }

  function normalizeRangeBody(body) {
    return {
      rows: (body.rows || []).map(normalizeRow),
      totals: body.totals || {},
      startDate: body.startDate,
      endDate: body.endDate,
      asOf: body.asOf || null,
      dataVersion: body.dataVersion || null,
      businessDate: body.businessDate || null,
      scope: body.scope || "portfolio",
      warnings: body.warnings || []
    };
  }

  function fetchPortfolioRange(startDate, endDate, siteCode) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate)) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(String(endDate))) {
      return Promise.reject(new Error("Overview date range requires valid start and end dates."));
    }
    var scope = siteCode ? ":plant:" + siteCode : "";
    return cached("range:" + startDate + ":" + endDate + scope, function () {
      return api().request(
        "/api/portal/overview/range?start_date=" + encodeURIComponent(startDate) +
        "&end_date=" + encodeURIComponent(endDate) +
        (siteCode ? "&site_code=" + encodeURIComponent(siteCode) : "")
      ).then(function (body) {
        return {
          rows: (body.rows || []).map(normalizeRow),
          totals: body.totals || {},
          startDate: body.startDate,
          endDate: body.endDate,
          asOf: body.asOf || null,
          dataVersion: body.dataVersion || null
        };
      });
    });
  }

  function fetchOverviewVersion() {
    return api().request("/api/portal/overview?version_only=true").then(function (body) {
      if (!body || typeof body.dataVersion !== "string") {
        throw new Error("The Overview change check returned an invalid version.");
      }
      return body.dataVersion;
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
   * One month of dated PM / Washing records: every visible plant (siteCode omitted) or one plant.
   * Resolves to { entries, truncated, limit, months }. `truncated` = the month holds more entries
   * than the server sends at once; the calendar says so instead of showing a partial month as
   * complete. Cached for a minute per (kind, month, plant); a failed read is never cached.
   *
   * `options.includeMonths` asks the same endpoint for its PM month index as well — which months
   * hold PM work at all — so the PM portfolio can open on a month that has something in it and
   * bound its month picker without a second round trip. It is opt-in because the operations
   * calendar does not need it. A page fetched WITH the index also seeds the plain cache entry, so
   * the calendar reuses it rather than asking for the same month again.
   */
  function fetchCalendarMonth(kind, month, siteCode, options) {
    if (!/^(pm|washing)$/.test(kind) || !/^\d{4}-\d{2}$/.test(String(month))) {
      return Promise.reject(new Error("Calendar activity requires a supported activity type and YYYY-MM month."));
    }
    const withMonths = !!(options && options.includeMonths) && kind === "pm";
    const plainKey = kind + ":" + month + ":" + (siteCode || "*");
    const key = withMonths ? plainKey + ":+months" : plainKey;
    if (!calendarCache.has(key)) {
      const request = api().request(
        "/api/portal/calendar?kind=" + kind + "&month=" + encodeURIComponent(month) +
        (siteCode ? "&site_code=" + encodeURIComponent(siteCode) : "") +
        (withMonths ? "&include_months=1" : "")
      ).then(function (body) {
        return {
          entries: body.entries || [], truncated: !!body.truncated, limit: body.limit || null,
          months: Array.isArray(body.months) ? body.months : null
        };
      }).catch(function (error) {
        calendarCache.delete(key);
        if (withMonths && calendarCache.get(plainKey) === request) calendarCache.delete(plainKey);
        throw error;
      });
      calendarCache.set(key, request);
      if (withMonths && !calendarCache.has(plainKey)) calendarCache.set(plainKey, request);
      // Calendars should reflect new records within a minute.
      setTimeout(function () {
        calendarCache.delete(key);
        if (withMonths && calendarCache.get(plainKey) === request) calendarCache.delete(plainKey);
      }, PORTFOLIO_TTL_MS);
    }
    return calendarCache.get(key);
  }

  /**
   * Dated PM / Washing records for a month, as an array. With a plant, only that plant's records are
   * requested (a portfolio month already in the cache is reused when it is complete), so a plant's
   * calendar never depends on how busy the rest of the portfolio is.
   */
  function fetchCalendarActivities(plant, _profile, kind, month) {
    if (!plant) {
      return fetchCalendarMonth(kind, month).then(function (page) { return page.entries.slice(); });
    }
    const whole = calendarCache.get(kind + ":" + month + ":*");
    const fromWhole = whole ? whole.then(function (page) {
      return page.truncated ? null : page.entries.filter(function (e) { return e.plantSiteCode === plant.siteCode; });
    }, function () { return null; }) : Promise.resolve(null);
    return fromWhole.then(function (entries) {
      return entries || fetchCalendarMonth(kind, month, plant.siteCode).then(function (page) { return page.entries.slice(); });
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
      washingCycleCompliancePercentByCycle: { "1": null, "2": null, "3": null },
      dcCapacityMw: 0, acCapacityMw: 0
    };
    // One plant keeps any surplus from extra cleaning, so its own score can pass 100%. Across
    // plants each counts at most its own plan, so one plant's extra cannot hide another's gap.
    const single = rows.length === 1;
    const washingWork = { done: 0, completed: 0, due: 0, pending: 0, overdue: 0, plants: 0 };
    const cycleWork = {
      "1": { done: 0, due: 0, plants: 0 }, "2": { done: 0, due: 0, plants: 0 }, "3": { done: 0, due: 0, plants: 0 }
    };
    function addWork(target, done, due) {
      done = Math.max(0, Number(done) || 0);
      due = Math.max(0, Number(due) || 0);
      target.done += Math.min(done, due);
      target.due += due;
      target.plants += 1;
    }
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
        const completed = Math.max(0, Number(profile.washing.completed) || 0);
        const pending = Math.max(0, Number(profile.washing.pending) || 0);
        const overdue = Math.min(pending, Math.max(0, Number(profile.washing.overdue) || 0));
        totals.washingCompleted += completed;
        totals.washingPending += pending;
        totals.washingOverdue += overdue;
        // Cycles achieved, counting a part-finished cycle by how much of it is cleaned, so the
        // score moves with the work instead of jumping only when a cycle closes. Planned is the
        // month's own plan, not completed + pending, which would grow with any extra cleaning.
        const activities = profile.washing.monthlyActivities || {};
        const planned = Math.max(0, Number(activities.planned) || 0);
        const progress = typeof profile.washing.monthlyCycleProgress === "number"
          ? Math.max(0, profile.washing.monthlyCycleProgress)
          : completed;
        washingWork.done += single ? progress : Math.min(progress, planned);
        washingWork.completed += completed;   // whole finished activities, for the legend
        washingWork.pending += pending;
        washingWork.overdue += overdue;
        washingWork.due += planned || (completed + pending);
        if (planned > 0) washingWork.plants += 1;
        (profile.washing.cycleGrades || []).forEach(function (grade) {
          const cycle = cycleWork[String(grade.cycleNo)];
          // Upcoming cycles carry no score and are never counted.
          if (!cycle || typeof grade.compliancePercent !== "number" || typeof grade.tablesDue !== "number") return;
          addWork(cycle, grade.tablesDone, grade.tablesDue);
        });
      }
      if (plant.dcCapacityKw) totals.dcCapacityMw += plant.dcCapacityKw / 1000;
      if (plant.acCapacityKw) totals.acCapacityMw += plant.acCapacityKw / 1000;
    });

    const pmTotal = totals.pmCompleted + totals.pmPending + totals.pmOverdue;
    totals.pmCompliancePercent = pmTotal === 0 ? null : Math.round((totals.pmCompleted / pmTotal) * 100);
    // A period with no planned cleaning activity is 0%; the dashboard labels the empty schedule.
    function workPercent(work) {
      if (!work.plants) return null;
      return work.due ? Math.round(1000 * work.done / work.due) / 10 : 0;
    }
    totals.washingCompliancePercent = washingWork.plants
      ? (washingWork.due ? Math.round(1000 * washingWork.done / washingWork.due) / 10 : 0)
      : null;
    totals.washingWork = washingWork;
    totals.washingCycleWork = cycleWork;
    Object.keys(cycleWork).forEach(function (cycleNo) {
      totals.washingCycleCompliancePercentByCycle[cycleNo] = workPercent(cycleWork[cycleNo]);
    });
    totals.dcCapacityMw = Math.round(totals.dcCapacityMw * 100) / 100;
    totals.acCapacityMw = Math.round(totals.acCapacityMw * 100) / 100;
    return totals;
  }

  /** Drop caches after a write so the next read is fresh. */
  function invalidate(notifyDashboard) {
    portfolioPromise = null;
    calendarCache.clear();
    rangeCache.clear();
    periodCache.clear();
    if (notifyDashboard && global.document && typeof global.CustomEvent === "function") {
      global.document.dispatchEvent(new global.CustomEvent("portal:data-invalidated"));
    }
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
    fetchCalendarMonth,
    fetchPortfolio,
    fetchPortfolioRange,
    fetchPortfolioPeriod,
    fetchPortfolioTrend,
    fetchOverviewVersion,
    aggregatePortfolio,
    classifyCondition,
    invalidate
  };
}(window));