/**
 * modules.js — loads a portal page's JavaScript the first time that page is opened.
 *
 * The portal used to ship every module on every page load: ~520 KB of script, of which the
 * Overview needs about a quarter. The heavy pages (the operations calendar, the site-issues
 * register, BOM) were parsed and executed by every user on every visit, whether or not they
 * ever opened those pages.
 *
 * Here, only the shell — sign-in, the API client, navigation and the Overview — is loaded with
 * the page. Everything else is fetched on first use and then kept, so opening a page costs one
 * script fetch and returning to it costs nothing.
 *
 * URLs come from the `s91-modules` block in the page, which the server content-hashes like every
 * other asset URL (app/core/assets.py). A module therefore keeps its immutable cache entry across
 * navigations and is re-fetched only when its file actually changes.
 */
(function (global) {
  "use strict";

  /** What each page needs, including the modules those modules call into. */
  var NEEDS = {
    "plants-table": ["table-sort", "plant-details"],
    liasoning: ["table-sort"],
    bom: ["table-sort"],
    "site-issues": ["table-sort", "register-io"],
    "operations-calendar": ["register-io"],
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

  global.Solar91Modules = {
    load: load,
    isLoaded: isLoaded,
    known: function () { return Object.keys(urls); },
    failedOnce: function (name) { return !!failed[name]; }
  };
}(window));
