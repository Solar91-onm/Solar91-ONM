/**
 * format.js — Shared formatting utilities.
 * Must load before overview.js and plants.js.
 */
(function (global) {
  "use strict";

  var numberFmt = new Intl.NumberFormat("en-IN");
  var dateFmt   = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

  function escape(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function formatNumber(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    return numberFmt.format(v);
  }
  function formatDate(iso) {
    if (!iso) return "N/A";
    try { return dateFmt.format(new Date(iso)); } catch (_) { return iso; }
  }
  function relativeTime(iso) {
    if (!iso) return "—";
    var diffMs = Date.now() - new Date(iso).getTime();
    var mins = Math.max(1, Math.round(diffMs / 60000));
    if (mins < 60) return mins + " min ago";
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + " h ago";
    var days = Math.round(hrs / 24);
    return days === 1 ? "yesterday" : days + " days ago";
  }

  /**
   * Spreadsheet formula-injection guard (OWASP). Text starting with = + - @ or a
   * control character is prefixed with an apostrophe, so a spreadsheet shows it
   * instead of running it. A plain number such as -5 stays numeric.
   */
  function csvText(value) {
    var s = String(value === null || value === undefined ? "" : value);
    return /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s.trim()) ? "'" + s : s;
  }

  global.Solar91PortalFormat = {
    csvText: csvText, escape: escape, formatNumber: formatNumber, formatDate: formatDate, relativeTime: relativeTime };
}(window));
