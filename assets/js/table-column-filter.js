/**
 * Searchable column filters shared by portal tables.
 */
(function (global) {
  "use strict";

  var fmt = global.Solar91PortalFormat;

  function escape(value) {
    return fmt && fmt.escape ? fmt.escape(value) : String(value == null ? "" : value);
  }

  function scopedAttribute(name, scope) {
    return name && scope !== undefined
      ? " " + name + '="' + escape(scope) + '"'
      : "";
  }

  function optionHTML(value, label, active, key, attributes, classes, scope, all) {
    var selected = active === value;
    return '<button type="button" class="' + classes.option + '" ' +
      attributes.optionKey + '="' + escape(key) + '" ' +
      attributes.optionValue + '="' + escape(value) + '"' +
      scopedAttribute(attributes.scope, scope) +
      ' aria-pressed="' + (selected ? "true" : "false") + '">' + escape(label) + "</button>";
  }

  function headerHTML(header, options) {
    var classes = options.classes;
    var attributes = options.attributes;
    var key = options.key;
    var scope = options.scope;
    var menuId = options.menuId;
    var active = options.active || "";
    var values = options.values || [];
    var allValue = "";
    var optionsHTML = values.map(function (value) {
      var text = String(value == null ? "" : value);
      var matches = options.caseInsensitive
        ? String(active).toLowerCase() === text.toLowerCase()
        : String(active) === text;
      return optionHTML(text, text, matches, key, attributes, classes, scope, false);
    }).join("");
    var clearHTML = optionHTML(allValue, "All " + options.label, !active, key,
      attributes, classes, scope, true);
    var toggle = '<button type="button" class="' + classes.toggle +
      (active ? " is-filtered" : "") + '" ' + attributes.toggleKey + '="' + escape(key) + '"' +
      scopedAttribute(attributes.scope, scope) + ' aria-label="Filter by ' + escape(options.label) +
      '" aria-controls="' + escape(menuId) + '" aria-expanded="false" title="Filter by ' +
      escape(options.label) + '">' +
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"></path></svg></button>';
    var searchAttribute = attributes.search + (options.searchHasKey ? '="' + escape(key) + '"' : "");
    var menu = '<div id="' + escape(menuId) + '" class="' + classes.menu +
      '" popover="auto" ' + attributes.menuKey + '="' + escape(key) + '"' +
      scopedAttribute(attributes.scope, scope) + '>' +
      '<input class="' + classes.search + '" type="search" ' + searchAttribute +
      ' placeholder="Search options..." aria-label="Search ' + escape(options.label) + ' options" />' +
      '<div class="' + classes.options + '">' + clearHTML + optionsHTML + '</div>' +
      '<div class="' + classes.empty + '" ' + attributes.empty + ' hidden>No matching options</div></div>';

    header = header.replace(/^<th(?=\s|>)/, function (opening) {
      return opening.replace(/\sclass="([^"]*)"/, function (match, value) {
        return ' class="' + value + " " + classes.header + '"';
      }).replace(/^<th(?=\s|>)/, function (th) {
        return /\sclass="/.test(opening) ? th : th + ' class="' + classes.header + '"';
      });
    });
    var openEnd = header.indexOf(">") + 1;
    var closeStart = header.lastIndexOf("</th>");
    return header.slice(0, openEnd) + '<div class="' + classes.content + '">' +
      header.slice(openEnd, closeStart) + toggle + menu + "</div>" + header.slice(closeStart);
  }

  function position(toggle, menu) {
    var toggleRect = toggle.getBoundingClientRect();
    var menuRect = menu.getBoundingClientRect();
    var left = Math.max(8, Math.min(toggleRect.left, global.innerWidth - menuRect.width - 8));
    var top = toggleRect.bottom + 4;
    if (top + menuRect.height > global.innerHeight - 8) {
      top = Math.max(8, toggleRect.top - menuRect.height - 4);
    }
    menu.style.left = Math.round(left) + "px";
    menu.style.top = Math.round(top) + "px";
  }

  function filterOptions(menu, term, options) {
    var needle = String(term || "").trim().toLowerCase();
    var attributes = options.attributes;
    var classes = options.classes;
    var visibleCount = 0;
    Array.prototype.forEach.call(menu.querySelectorAll("[" + attributes.optionKey + "]"), function (option) {
      var value = option.getAttribute(attributes.optionValue) || "";
      var matches = !needle || (!value && options.keepAllOptionVisible) ||
        option.textContent.trim().toLowerCase().indexOf(needle) !== -1;
      option.hidden = !matches;
      if (matches && (!options.keepAllOptionVisible || value)) visibleCount += 1;
    });
    var empty = menu.querySelector("." + classes.empty);
    if (empty) {
      empty.hidden = options.keepAllOptionVisible
        ? !needle || visibleCount > 0
        : visibleCount > 0;
    }
  }

  function findMatch(container, selector, keyAttribute, key, scopeAttribute, scope) {
    var nodes = container.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i].getAttribute(keyAttribute) !== key) continue;
      if (scopeAttribute && nodes[i].getAttribute(scopeAttribute) !== scope) continue;
      return nodes[i];
    }
    return null;
  }

  function wire(container, options) {
    var attributes = options.attributes;
    var classes = options.classes;
    var menuSelector = "[" + attributes.menuKey + "]";
    Array.prototype.forEach.call(container.querySelectorAll(menuSelector), function (menu) {
      var key = menu.getAttribute(attributes.menuKey);
      var scope = attributes.scope ? menu.getAttribute(attributes.scope) : undefined;
      var toggle = findMatch(container, "[" + attributes.toggleKey + "]", attributes.toggleKey,
        key, attributes.scope, scope);
      var search = menu.querySelector("." + classes.search);

      menu.addEventListener("toggle", function () {
        var isOpen = menu.matches(":popover-open");
        if (toggle) toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
        if (isOpen && search) {
          search.value = "";
          filterOptions(menu, "", options);
          if (options.focusSearchOnOpen) search.focus();
        }
      });

      if (toggle) {
        toggle.addEventListener("click", function (event) {
          event.stopPropagation();
          if (menu.matches(":popover-open")) {
            menu.hidePopover();
            toggle.setAttribute("aria-expanded", "false");
          } else {
            menu.showPopover();
            position(toggle, menu);
            toggle.setAttribute("aria-expanded", "true");
            if (search && options.focusSearchOnOpen) {
              search.value = "";
              filterOptions(menu, "", options);
              search.focus();
            }
          }
        });
      }

      if (search) {
        search.addEventListener("input", function (event) {
          event.stopPropagation();
          filterOptions(menu, search.value, options);
        });
      }

      Array.prototype.forEach.call(menu.querySelectorAll("[" + attributes.optionKey + "]"), function (option) {
        option.addEventListener("click", function (event) {
          event.stopPropagation();
          if (menu.matches(":popover-open")) menu.hidePopover();
          if (toggle) toggle.setAttribute("aria-expanded", "false");
          options.onSelect(
            option.getAttribute(attributes.optionKey),
            attributes.scope ? option.getAttribute(attributes.scope) : undefined,
            option.getAttribute(attributes.optionValue) || ""
          );
        });
      });
    });
  }

  global.Solar91PortalColumnFilter = {
    headerHTML: headerHTML,
    wire: wire
  };
}(window));
