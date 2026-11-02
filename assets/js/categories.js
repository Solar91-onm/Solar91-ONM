/**
 * categories.js — Settings → Categories.
 *
 * The work-category list: the equipment categories, the sub-problems that can be
 * reported for each, how many a plant typically has, and your own identifier.
 *
 * This replaced the per-asset equipment register and the hard-coded list that used
 * to live in app/core/security.py. The table ships EMPTY; anything added here is
 * saved to the database immediately and every category dropdown picks it up.
 *
 * Writes go through /api/categories (an O&M Head or an Assignee may edit; everyone
 * else sees a read-only list). The same rows can be inserted in Supabase directly —
 * see database/migrations/033_work_categories.sql.
 */
(function (global) {
  "use strict";

  var fmt = global.Solar91PortalFormat;
  var esc = function (v) { return fmt.escape(v === null || v === undefined ? "" : String(v)); };

  var state = { rows: [], canEdit: false, loading: true, error: "", notice: "", editing: null, busy: false };
  var host = null;

  function api() { return global.Solar91PortalAPI; }

  function load() {
    state.loading = true;
    render();
    return api().request("/api/categories?include_inactive=true").then(function (body) {
      state.rows = body.categories || [];
      state.canEdit = !!body.can_edit;
      state.loading = false;
      state.error = "";
      render();
    }).catch(function (error) {
      state.loading = false;
      state.error = error && error.message ? error.message : "The category list could not be loaded.";
      render();
    });
  }

  function rowHTML(row) {
    var subs = row.sub_problems || [];
    return '' +
      '<tr' + (row.active ? '' : ' class="is-inactive"') + '>' +
        '<td><strong>' + esc(row.name) + '</strong>' +
          (row.code ? ' <span class="ep-cat__code">' + esc(row.code) + '</span>' : '') +
          (row.active ? '' : ' <span class="ep-chip ep-chip--grey">Inactive</span>') + '</td>' +
        '<td>' + (subs.length
          ? subs.slice(0, 4).map(function (s) { return '<span class="ep-cat__sub">' + esc(s) + '</span>'; }).join('') +
            (subs.length > 4 ? ' <small>+' + (subs.length - 4) + ' more</small>' : '')
          : '<span class="ep-cat__none">None yet</span>') + '</td>' +
        '<td class="num">' + (row.default_units === null || row.default_units === undefined ? '—' : esc(row.default_units)) + '</td>' +
        '<td>' + (row.area ? esc(row.area) : '—') + '</td>' +
        '<td class="num">' + (row.in_use ? esc(row.in_use) + ' records' : '—') + '</td>' +
        '<td class="num">' + (state.canEdit
          ? '<button type="button" class="ep-cat__btn" data-cat-edit="' + esc(row.id) + '">Edit</button>' +
            '<button type="button" class="ep-cat__btn ep-cat__btn--quiet" data-cat-delete="' + esc(row.id) + '">' +
            (row.in_use ? 'Deactivate' : 'Remove') + '</button>'
          : '') + '</td>' +
      '</tr>';
  }

  function formHTML(row) {
    var editing = !!row;
    return '' +
      '<form class="ep-cat__form" data-cat-form>' +
        '<h3>' + (editing ? 'Edit ' + esc(row.name) : 'Add a category') + '</h3>' +
        '<div class="ep-cat__grid">' +
          '<label>Category<input name="name" required maxlength="120" value="' + esc(row ? row.name : '') + '" placeholder="Inverter" /></label>' +
          '<label>Your ID (optional)<input name="code" maxlength="60" value="' + esc(row ? row.code : '') + '" placeholder="INV" /></label>' +
          '<label>Units per plant (optional)<input name="default_units" type="number" min="0" value="' + esc(row && row.default_units !== null ? row.default_units : '') + '" placeholder="8" /></label>' +
          '<label>Area<select name="area">' +
            ['', 'Plant side', 'GSS side'].map(function (option) {
              var selected = row && (row.area || '') === option ? ' selected' : '';
              return '<option value="' + esc(option) + '"' + selected + '>' + (option || 'Not set') + '</option>';
            }).join('') +
          '</select></label>' +
        '</div>' +
        '<label class="ep-cat__wide">Sub-problems, one per line' +
          '<textarea name="sub_problems" rows="5" placeholder="Fan failure&#10;IGBT fault&#10;Communication loss">' +
          esc((row && (row.sub_problems || []).join('\n')) || '') + '</textarea></label>' +
        '<p class="ep-cat__hint">These are offered as the fault when a ticket is raised for this category.</p>' +
        '<p class="ep-cat__error" role="alert"></p>' +
        '<footer>' +
          (editing ? '<button type="button" class="ep-cat__btn" data-cat-cancel>Cancel</button>' : '') +
          '<button type="submit" class="ep-cat__btn ep-cat__btn--primary">' +
            (editing ? 'Save changes' : 'Add category') + '</button>' +
        '</footer>' +
      '</form>';
  }

  function render() {
    if (!host) return;
    if (state.loading) {
      host.innerHTML = '<div class="ep-cat"><p class="ep-cat__loading">Loading categories…</p></div>';
      return;
    }
    var rows = state.rows;
    host.innerHTML = '' +
      '<section class="ep-cat" aria-labelledby="categories-title">' +
        '<header class="ep-cat__head">' +
          '<div><h2 id="categories-title">Categories</h2>' +
            '<p>The equipment categories work is raised and planned against, their sub-problems, ' +
            'and how many of each a plant has. Preventive Maintenance and Site Issues use this list.</p></div>' +
          '<span class="ep-cat__count">' + rows.length + ' configured</span>' +
        '</header>' +
        (state.error ? '<p class="ep-cat__error">' + esc(state.error) + '</p>' : '') +
        (state.notice ? '<p class="ep-cat__notice" role="status">' + esc(state.notice) + '</p>' : '') +
        (rows.length
          ? '<div class="ep-cat__table-wrap"><table class="ep-cat__table">' +
              '<thead><tr><th>Category</th><th>Sub-problems</th><th class="num">Units</th>' +
              '<th>Area</th><th class="num">In use</th><th class="num"></th></tr></thead>' +
              '<tbody>' + rows.map(rowHTML).join('') + '</tbody></table></div>'
          : '<div class="ep-cat__empty"><strong>No categories yet.</strong>' +
            '<span>Add your first one below, or insert them in Supabase. Until one exists, ' +
            'a new PM plan or issue cannot pick a category.</span></div>') +
        (state.canEdit
          ? formHTML(state.editing ? rows.filter(function (r) { return r.id === state.editing; })[0] : null)
          : '<p class="ep-cat__hint">Your role can view this list. An O&amp;M Head or Assignee can change it.</p>') +
      '</section>';
    wire();
  }

  function wire() {
    host.querySelectorAll('[data-cat-edit]').forEach(function (button) {
      button.addEventListener('click', function () {
        state.editing = button.getAttribute('data-cat-edit');
        state.notice = '';
        render();
      });
    });
    var cancel = host.querySelector('[data-cat-cancel]');
    if (cancel) cancel.addEventListener('click', function () { state.editing = null; render(); });

    host.querySelectorAll('[data-cat-delete]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (state.busy) return;
        state.busy = true;
        api().request('/api/categories/' + encodeURIComponent(button.getAttribute('data-cat-delete')), { method: 'DELETE' })
          .then(function () {
            state.busy = false;
            state.notice = 'Category removed. Records that already use it keep their text.';
            state.editing = null;
            load();
          }).catch(function (error) {
            state.busy = false;
            state.error = error.message || 'Could not remove that category.';
            render();
          });
      });
    });

    var form = host.querySelector('[data-cat-form]');
    if (!form) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (state.busy) return;
      var errorEl = form.querySelector('.ep-cat__error');
      errorEl.textContent = '';
      var units = form.elements.default_units.value.trim();
      var payload = {
        name: form.elements.name.value.trim(),
        code: form.elements.code.value.trim() || null,
        area: form.elements.area.value || null,
        default_units: units === '' ? null : Number(units),
        sub_problems: form.elements.sub_problems.value.split('\n')
          .map(function (line) { return line.trim(); })
          .filter(Boolean)
      };
      if (!payload.name) { errorEl.textContent = 'A category name is required.'; return; }
      if (payload.default_units !== null && !Number.isFinite(payload.default_units)) {
        errorEl.textContent = 'Units per plant must be a number.'; return;
      }
      state.busy = true;
      var submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      var request = state.editing
        ? api().request('/api/categories/' + encodeURIComponent(state.editing), { method: 'PATCH', body: payload })
        : api().request('/api/categories', { method: 'POST', body: payload });
      request.then(function () {
        state.busy = false;
        state.notice = state.editing ? 'Category updated.' : 'Category added.';
        state.editing = null;
        load();
      }).catch(function (error) {
        state.busy = false;
        submit.disabled = false;
        errorEl.textContent = error.message || 'Could not save that category.';
      });
    });
  }

  global.Solar91PortalCategories = {
    render: function (element) {
      host = element;
      state.editing = null;
      state.notice = '';
      return load();
    }
  };
}(window));
