/**
 * table-sort.js
 * ─────────────────────────────────────────────────────────────────────
 * Click-to-sort column headings, shared by every table in the portal.
 *
 * A table gives its columns a `sort` reader (row → comparable value) and keeps
 * one `{ key, dir }` object. `headerHTML` draws the headings with the Excel-style
 * arrow pair, `apply` sorts the rows, and `wire` turns a click on a heading into
 * the next direction plus a redraw.
 *
 * Blanks always sink to the bottom, ascending or descending, so "—" never pushes
 * the rows an operator is looking for off the first screen.
 */
(function (global) {
  "use strict";

  var fmt = global.Solar91PortalFormat;

  var ARROWS =
    '<span class="ep-sort__arrows" aria-hidden="true">' +
      '<svg class="ep-sort__up" width="8" height="5" viewBox="0 0 8 5"><path d="M4 0 8 5H0z"></path></svg>' +
      '<svg class="ep-sort__down" width="8" height="5" viewBox="0 0 8 5"><path d="M4 5 0 0h8z"></path></svg>' +
    "</span>";

  function escape(value) {
    return fmt && fmt.escape ? fmt.escape(value) : String(value === null || value === undefined ? "" : value);
  }

  /** Empty, null and "—" all count as "no value" and sort last in both directions. */
  function isBlank(value) {
    return value === null || value === undefined || value === "" || value === "—";
  }

  function compare(a, b) {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }

  /**
   * One sortable heading. `column` is { key, label, align, sort }; a column with
   * no `sort` reader (an Edit button column, say) is drawn as a plain heading.
   */
  function thHTML(column, sortState, attribute) {
    var cls = column.align === "num" ? ' class="num"' : "";
    if (!column.sort) return "<th" + cls + ">" + escape(column.label) + "</th>";
    var active = sortState && sortState.key === column.key;
    var dir = active ? sortState.dir : "";
    var next = active && sortState.dir === "asc" ? "descending" : "ascending";
    return "<th" + cls + ' aria-sort="' + (active ? (dir === "asc" ? "ascending" : "descending") : "none") + '">' +
      '<button type="button" class="ep-sort' + (active ? " is-active" : "") + '" ' +
        attribute + '="' + escape(column.key) + '" data-dir="' + dir + '" ' +
        'title="Sort by ' + escape(column.label) + '" ' +
        'aria-label="Sort by ' + escape(column.label) + ", " + next + '">' +
        '<span class="ep-sort__label">' + escape(column.label) + "</span>" + ARROWS +
      "</button></th>";
  }

  function headerHTML(columns, sortState, attribute) {
    var attr = attribute || "data-sort-key";
    return columns.map(function (column) { return thHTML(column, sortState, attr); }).join("");
  }

  /** Clicking the sorted column flips it; any other column starts ascending. */
  function next(sortState, key) {
    if (sortState.key === key) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
    else { sortState.key = key; sortState.dir = "asc"; }
    return sortState;
  }

  /**
   * Sort a copy of `rows`. `valueOf(row, key)` reads the cell value; a column
   * whose `sort` reader is on the column list is read through that instead.
   */
  function apply(rows, sortState, columns) {
    if (!sortState || !sortState.key) return rows.slice();
    var column = (columns || []).filter(function (c) { return c.key === sortState.key; })[0];
    if (!column || !column.sort) return rows.slice();
    var dir = sortState.dir === "desc" ? -1 : 1;
    return rows.map(function (row, index) { return { row: row, index: index }; }).sort(function (a, b) {
      var av = column.sort(a.row), bv = column.sort(b.row);
      var aBlank = isBlank(av), bBlank = isBlank(bv);
      if (aBlank && bBlank) return a.index - b.index;
      if (aBlank) return 1;                       // blanks last, whichever way the column points
      if (bBlank) return -1;
      var result = compare(av, bv);
      return result !== 0 ? result * dir : a.index - b.index;   // stable within equal values
    }).map(function (item) { return item.row; });
  }

  /** Turn a click on a sortable heading into the next direction, then redraw. */
  function wire(container, sortState, redraw, attribute) {
    var attr = attribute || "data-sort-key";
    container.querySelectorAll("[" + attr + "]").forEach(function (button) {
      button.addEventListener("click", function () {
        next(sortState, button.getAttribute(attr));
        redraw();
      });
    });
  }

  global.Solar91PortalSort = {
    headerHTML: headerHTML,
    thHTML: thHTML,
    next: next,
    apply: apply,
    wire: wire,
    compare: compare
  };
}(window));
