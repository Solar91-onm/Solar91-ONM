/**
 * portal-api.js — the portal's one route to the backend.
 *
 * Authentication is NOT handled here. frontend/static/js/auth-gate.js owns the
 * Clerk session, token refresh and the sign-out-on-401 path, and exposes the
 * global `apiFetch(url, opts)`. This module is a thin, cached wrapper over it so
 * UI code never has to think about tokens.
 *
 * Every read goes through the existing authenticated, role-scoped APIs; the
 * server decides which plants and records the signed-in user may see.
 */
(function (global) {
  "use strict";

  var sessionPromise = null;
  var plantsPromise = null;

  /** Authenticated JSON request. Throws an Error with .status on failure. */
  function request(url, options) {
    if (typeof global.apiFetch !== "function") {
      return Promise.reject(new Error("Solar91 sign-in is not ready. Reload the page."));
    }
    return global.apiFetch(url, options);
  }

  function session() {
    if (!sessionPromise) {
      sessionPromise = request("/api/auth/session").catch(function (error) {
        sessionPromise = null;
        throw error;
      });
    }
    return sessionPromise;
  }

  /** Every plant the signed-in user may see, with the full stored record. */
  function plants(force) {
    if (force) plantsPromise = null;
    if (!plantsPromise) {
      plantsPromise = request("/api/portal/plants").then(function (body) {
        return (body.plants || []).map(normalizePlant);
      }).catch(function (error) {
        plantsPromise = null;
        throw error;
      });
    }
    return plantsPromise;
  }

  /**
   * One plant record as the portal UI expects it. The API returns the stored
   * columns; nothing here invents a value — a missing field stays null so the
   * UI can show "Not available" instead of a misleading zero.
   */
  function normalizePlant(plant) {
    var name = plant.plant_name || "";
    return {
      id: String(plant.id),
      dbId: String(plant.id),
      siteCode: plant.site_code,
      displayCode: plant.display_code || plant.site_code,
      plantName: name,
      displayName: name.replace(/\s+\d{2,}$/, "") || name,
      sourceName: name,
      projectCompany: plant.project_company || "",
      projectCompanyShort: shortenSPV(plant.project_company || ""),
      district: plant.district || "",
      discom: plant.discom || "",
      location: plant.location || "",
      latitude: numberOrNull(plant.latitude),
      longitude: numberOrNull(plant.longitude),
      dcCapacityKw: numberOrNull(plant.dc_capacity_kw),
      acCapacityKw: numberOrNull(plant.ac_capacity_kw),
      commissionedOn: plant.commissioned_on || null,
      status: plant.status || "active",
      assignedEngineer: plant.assigned_engineer || "",
      siteEngineers: plant.site_engineers || [],
      washingAssignee: plant.washing_assignee || "",
      customFields: plant.custom_fields || {},
      mapsUrl: mapsUrl(plant)
    };
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function mapsUrl(plant) {
    if (plant.latitude !== null && plant.latitude !== undefined &&
        plant.longitude !== null && plant.longitude !== undefined) {
      return "https://www.google.com/maps/search/?api=1&query=" +
             encodeURIComponent(plant.latitude + "," + plant.longitude);
    }
    var parts = [plant.plant_name, plant.location, plant.district].filter(Boolean);
    if (!parts.length) return "";
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(parts.join(", "));
  }

  // "Solar91 Project Thirty Five Private Limited" → "SPV 35".
  var ONES = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  var TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
                sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
  var TENS = { twenty: 20, thirty: 30, fourty: 40, forty: 40, fifty: 50 };

  function shortenSPV(full) {
    var match = full.match(/Solar91\s+Project\s+(.+?)(?:\s+(?:Pvt\.?|Private|Limited|Ltd\.?)\b|$)/i);
    if (!match) return full;
    var projectNumber = match[1].trim();
    if (/^\d+$/.test(projectNumber)) return "SPV " + projectNumber;

    var total = 0;
    var words = projectNumber.toLowerCase().split(/\s+/);
    for (var i = 0; i < words.length; i += 1) {
      var word = words[i];
      if (TENS[word] !== undefined) total += TENS[word];
      else if (TEENS[word] !== undefined) total += TEENS[word];
      else if (ONES[word] !== undefined) total += ONES[word];
      else return full;
    }
    return total > 0 ? "SPV " + total : full;
  }

  /**
   * Retained for compatibility with modules that used to distinguish the static
   * preview from the authenticated route. The portal is now the application, so
   * every view is live.
   */
  function isPortalRoute() {
    return true;
  }

  /** Current user's session payload once loaded (set by app.js after sign-in). */
  var currentSession = null;
  function setSession(value) { currentSession = value; sessionPromise = Promise.resolve(value); }

  /** UI hint only — the API enforces every permission itself. */
  function can(permission) {
    var perms = (currentSession && currentSession.permissions) || [];
    return perms.indexOf(permission) !== -1;
  }

  function currentUser() {
    return (currentSession && currentSession.user) || null;
  }

  /**
   * Download a file the API returns as bytes.
   *
   * `request` parses every response as JSON, so a workbook cannot go through it. This fetches with the
   * same bearer token, honours the filename the server sets in Content-Disposition, and surfaces a
   * failed download as a readable error instead of saving an HTML or JSON error page as a .xlsx.
   */
  function downloadFile(url, fallbackName) {
    if (typeof global.clerkToken !== "function") {
      return Promise.reject(new Error("Solar91 sign-in is not ready. Reload the page."));
    }
    return global.clerkToken().then(function (token) {
      var headers = {};
      if (token) headers.Authorization = "Bearer " + token;
      return fetch(url, { headers: headers });
    }).then(function (response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          var detail = body && (body.detail || body.message);
          if (detail && typeof detail === "object") detail = detail.message;
          var error = new Error(detail || ("The download failed (HTTP " + response.status + ")."));
          error.status = response.status;
          throw error;
        });
      }
      var disposition = response.headers.get("Content-Disposition") || "";
      var match = /filename="?([^"]+)"?/.exec(disposition);
      var name = match ? match[1] : fallbackName;
      return response.blob().then(function (blob) { return { blob: blob, name: name }; });
    }).then(function (result) {
      var objectUrl = URL.createObjectURL(result.blob);
      var link = document.createElement("a");
      link.href = objectUrl;
      link.download = result.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      // Revoked on the next tick: revoking immediately cancels the download in some browsers.
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 0);
      return result.name;
    });
  }

  /** POST one spreadsheet as multipart form data. `apiFetch` already leaves a FormData body alone. */
  function uploadFile(url, file, params) {
    var form = new FormData();
    form.append("file", file);
    var query = new URLSearchParams(params || {}).toString();
    return request(url + (query ? "?" + query : ""), { method: "POST", body: form });
  }

  global.Solar91PortalAPI = {
    request: request,
    session: session,
    setSession: setSession,
    can: can,
    currentUser: currentUser,
    plants: plants,
    normalizePlant: normalizePlant,
    isPortalRoute: isPortalRoute,
    downloadFile: downloadFile,
    uploadFile: uploadFile
  };
}(window));
