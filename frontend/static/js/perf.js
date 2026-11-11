/* Solar91 opt-in browser performance monitor.
 *
 * Off by default and close to free while off. Turn it on for one page load with ?s91_perf=1 (or the older
 * ?s91_latency=1), or for later actions with Solar91Perf.enable() in DevTools. Solar91Perf.report() prints the
 * summary; Solar91Perf.reset() clears it. Solar91Latency is the same object (the name the docs used earlier).
 *
 * Privacy: samples hold only the API *family* (method + path with ids, plant codes and query string removed),
 * timings, status and sizes. No URL, query string, request or response body, token, user or record data is kept,
 * and nothing is sent anywhere: the report exists only in this tab's memory (at most 500 samples).
 */
(function (global) {
  "use strict";

  var MAX_SAMPLES = 500;
  var enabled = false;
  var samples = [];          // API requests
  var renders = [];          // named UI timings (render, navigation)
  var marks = {};            // milestones since navigation start (startup)

  try {
    var params = new URLSearchParams(global.location.search);
    enabled = params.get("s91_perf") === "1" || params.get("s91_latency") === "1";
  } catch (e) { enabled = false; }

  function now() { return global.performance && performance.now ? performance.now() : Date.now(); }

  // "/api/portal/plants/ABC01?x=1" -> "/api/portal/plants/{code}"; uuids and numbers -> {id}.
  function family(method, url) {
    var path = String(url || "").replace(/^https?:\/\/[^/]+/, "").split("?")[0].split("#")[0];
    path = path
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/{id}")
      .replace(/\/\d+(?=\/|$)/g, "/{id}")
      .replace(/^(\/api\/portal\/plants)\/[^/]+/, "$1/{code}")
      .replace(/^(\/api\/scheduled\/washing\/plants)\/[^/]+/, "$1/{id}");
    return String(method || "GET").toUpperCase() + " " + path;
  }

  // Server-Timing: "app;dur=12, db;dur=3;desc=\"4 queries\", conn;dur=0;desc=..., pool;dur=0;desc=\"1/7 in use\", total;dur=15"
  function parseServerTiming(header) {
    var out = {};
    String(header || "").split(",").forEach(function (part) {
      var m = /^\s*([a-z]+);dur=([0-9.]+)(?:;desc="([^"]*)")?/i.exec(part);
      if (!m) return;
      out[m[1] + "_ms"] = Number(m[2]);
      if (m[1] === "db" && m[3]) {
        var q = /(\d+)\s+quer/.exec(m[3]);
        if (q) out.db_queries = Number(q[1]);
      }
    });
    return out;
  }

  function push(list, item) {
    list.push(item);
    if (list.length > MAX_SAMPLES) list.shift();
  }

  function pct(values, p) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p / 100) - 1));
    return Math.round(sorted[index] * 10) / 10;
  }

  var Perf = {
    get enabled() { return enabled; },
    enable: function () { enabled = true; return "Solar91Perf enabled. Use the portal, then run Solar91Perf.report()."; },
    disable: function () { enabled = false; },
    reset: function () { samples = []; renders = []; marks = {}; },

    /** Called by apiFetch for every request while enabled. `info` never contains the URL itself. */
    recordRequest: function (method, url, info) {
      if (!enabled) return;
      var server = parseServerTiming(info.serverTiming);
      push(samples, {
        family: family(method, url),
        status: info.status,
        client_ms: info.clientMs,          // apiFetch start -> parsed JSON (includes token wait, retries, parse)
        network_ms: info.networkMs,        // fetch start -> response text received
        parse_ms: info.parseMs,
        bytes: info.bytes,                 // decoded response text length
        transfer_bytes: info.transferBytes, // Content-Length (compressed size) when the server sends it
        shared: !!info.shared,             // joined an identical request already in flight (no extra network)
        server_total_ms: server.total_ms, server_app_ms: server.app_ms, server_db_ms: server.db_ms,
        server_conn_ms: server.conn_ms, server_pool_wait_ms: server.pool_ms, db_queries: server.db_queries
      });
    },

    /** Time a synchronous piece of UI work (rendering a table, switching a page). Returns fn's result. */
    time: function (label, fn) {
      if (!enabled) return fn();
      var started = now();
      try { return fn(); } finally { push(renders, { label: label, ms: now() - started }); }
    },

    /** Record a milestone (ms since the page started loading), e.g. "overview_usable". First one wins. */
    mark: function (name) {
      if (!enabled || marks[name] !== undefined) return;
      marks[name] = Math.round(now());
    },

    report: function () {
      var groups = {};
      samples.forEach(function (s) { (groups[s.family] = groups[s.family] || []).push(s); });
      var rows = Object.keys(groups).sort().map(function (name) {
        var g = groups[name];
        var pick = function (key) { return g.map(function (s) { return s[key]; }).filter(function (v) { return typeof v === "number"; }); };
        return {
          api: name, requests: g.length,
          shared_inflight: g.filter(function (s) { return s.shared; }).length,
          errors: g.filter(function (s) { return s.status >= 400 || !s.status; }).length,
          client_p50_ms: pct(pick("client_ms"), 50), client_p95_ms: pct(pick("client_ms"), 95),
          server_total_p50_ms: pct(pick("server_total_ms"), 50), server_db_p50_ms: pct(pick("server_db_ms"), 50),
          db_queries_p50: pct(pick("db_queries"), 50), pool_wait_p95_ms: pct(pick("server_pool_wait_ms"), 95),
          parse_p50_ms: pct(pick("parse_ms"), 50),
          kb_p50: pct(pick("bytes").map(function (b) { return b / 1024; }), 50),
          transfer_kb_p50: pct(pick("transfer_bytes").map(function (b) { return b / 1024; }), 50)
        };
      });
      var ui = {};
      renders.forEach(function (r) { (ui[r.label] = ui[r.label] || []).push(r.ms); });
      var uiRows = Object.keys(ui).sort().map(function (label) {
        return { ui: label, count: ui[label].length, p50_ms: pct(ui[label], 50), p95_ms: pct(ui[label], 95) };
      });
      if (global.console) {
        console.log("Solar91Perf: " + samples.length + " API samples, " + renders.length + " UI timings" +
          (enabled ? "" : " (monitor is off: Solar91Perf.enable())"));
        if (Object.keys(marks).length) console.table(marks);
        if (rows.length) console.table(rows);
        if (uiRows.length) console.table(uiRows);
        console.log("Correlate slow requests with the X-Request-ID / Rndr-Id response headers in the Network tab and " +
          "the server's slow_or_failed_request log lines.");
      }
      return { milestones: Object.assign({}, marks), api: rows, ui: uiRows };
    }
  };

  global.Solar91Perf = Perf;
  global.Solar91Latency = Perf;   // name used by docs/SCALABILITY_AUDIT.md
}(window));
