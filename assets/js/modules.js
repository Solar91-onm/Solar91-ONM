
(function (global) {
  "use strict";

  /** What each page needs, including the modules those modules call into. */
  var NEEDS = {
    "plants-table": ["table-sort", "table-column-filter", "plant-details"],
    security: [],
    liasoning: ["table-sort"],
    bom: ["table-sort"],
    "site-issues": ["table-sort", "table-column-filter", "register-io", "photo-evidence"],
    requirements: ["table-sort", "table-column-filter"],
    "inverter-health": ["table-sort", "table-column-filter"],
    // Both Module Cleaning screens drive extra cleaning through the one shared module, so the
    // wording, the two-step delete confirm and the role gate cannot drift apart.
    "operations-calendar": ["register-io", "photo-evidence", "extra-cleaning"],
    "washing-board": ["table-sort", "table-column-filter", "extra-cleaning"],
    // A plant's PM page renders its cycle plan as a section of itself, so pm-overview consumes
    // pm-cycle-plans as a component (mountTracker) rather than as a second panel on the page.
    // The portfolio's registers use the SHARED click-to-sort headings and searchable column
    // filters, not copies of them.
    "pm-overview": ["pm-cycle-plans", "table-sort", "table-column-filter"],
    settings: ["categories"]
  };

  var urls = {};
  var pending = {};
  var failed = {};

  try {
    var block = document.getElementById("s91-modules");
    if (block) urls = JSON.parse(block.textContent || "{}");
  } catch (error) {
    urls = {};
  }

  function isLoaded(name) {
    return !!(pending[name] && pending[name].done);
  }

  /** Fetch one module's script once. A failed load is not cached, so a retry can succeed. */
  function script(name) {
    if (pending[name]) return pending[name];
    var url = urls[name];
    if (!url) return Promise.reject(new Error("Unknown portal module: " + name));
    var promise = new Promise(function (resolve, reject) {
      var element = document.createElement("script");
      element.src = url;
      element.async = false;
      element.onload = function () { promise.done = true; resolve(name); };
      element.onerror = function () {
        pending[name] = null;
        failed[name] = true;
        reject(new Error("This part of the portal could not be loaded. Check your connection and try again."));
      };
      document.head.appendChild(element);
    });
    pending[name] = promise;
    return promise;
  }

  /**
   * Load one module or several, with whatever they depend on, and resolve once every one has run.
   * Already-loaded modules resolve immediately, so calling this before each render is cheap.
   */
  function load(names) {
    var wanted = [].concat(names);
    var all = [];
    wanted.forEach(function (name) {
      (NEEDS[name] || []).forEach(function (dependency) {
        if (all.indexOf(dependency) === -1) all.push(dependency);
      });
      if (all.indexOf(name) === -1) all.push(name);
    });
    if (all.every(isLoaded)) return Promise.resolve(all);     // nothing to fetch: stay synchronous-ish
    return Promise.all(all.map(script));
  }

  /**
   * Warm the browser cache with every page module once the first screen is usable, so opening
   * another page does not wait for its script to download. <link rel="prefetch"> only downloads
   * (at idle priority); nothing runs until load() asks for it. The URLs are content-hashed and
   * served as immutable, so each one is fetched once per release. Skipped on Data Saver / 2G.
   */
  var prefetched = false;
  function prefetchAll() {
    if (prefetched) return;
    prefetched = true;
    var connection = global.navigator && global.navigator.connection;
    if (connection && (connection.saveData || /(^|-)2g$/.test(String(connection.effectiveType || "")))) return;
    Object.keys(urls).forEach(function (name) {
      if (pending[name]) return;
      var link = document.createElement("link");
      link.rel = "prefetch";
      link.as = "script";
      link.href = urls[name];
      document.head.appendChild(link);
    });
  }

  // A best-effort optimisation: where the browser APIs it needs are missing it simply does not
  // run, and it can never stop load() from working.
  function prefetchWhenIdle() {
    if (typeof global.addEventListener !== "function" || typeof global.setTimeout !== "function") return;
    var start = function () {
      if (typeof global.requestIdleCallback === "function") global.requestIdleCallback(prefetchAll, { timeout: 4000 });
      else global.setTimeout(prefetchAll, 1500);
    };
    if (document.readyState === "complete") start();
    else global.addEventListener("load", start, { once: true });
  }
  prefetchWhenIdle();

  global.Solar91Modules = {
    load: load,
    isLoaded: isLoaded,
    prefetchAll: prefetchAll,
    known: function () { return Object.keys(urls); },
    failedOnce: function (name) { return !!failed[name]; }
  };
}(window));
