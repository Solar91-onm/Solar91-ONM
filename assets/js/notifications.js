/**
 * notifications.js — the portal's notification centre: the top-bar bell, its panel, and the
 * bottom-right toasts.
 *
 * One shared poller for the whole portal. No page starts its own interval: every module that
 * wants the badge refreshed calls `Solar91PortalNotifications.refresh()`, and the poller itself
 * only runs while the tab is visible, backs off on failure, and never has two requests in
 * flight. The unread badge comes from one cheap `/api/notifications/summary` call; the list
 * itself is fetched when the panel is opened and paginated with a keyset cursor.
 *
 * Toasts are a controlled queue: at most three on screen, identical messages collapse instead of
 * stacking, a success disappears on its own and a failure stays until it is dismissed. A toast
 * only ever reports what the server has already confirmed — the modules call it after a
 * successful response, never before.
 */
(function (global) {
  "use strict";

  const api = () => global.Solar91PortalAPI;
  const nav = () => global.Solar91PortalNav;
  const esc = value => global.Solar91PortalFormat
    ? global.Solar91PortalFormat.escape(value == null ? "" : value)
    : String(value == null ? "" : value).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── Toasts ────────────────────────────────────────────────────────────────

  const TOAST_MAX = 3;
  const TOAST_MS = { success: 4500, info: 5000, alert: 10000, error: 0, critical: 0 };
  let toastHost = null;
  const live = new Map();          // key -> { node, timer }
  const waiting = [];              // queued while three are already on screen

  function host() {
    if (toastHost && toastHost.isConnected) return toastHost;
    toastHost = document.createElement("div");
    toastHost.className = "ep-toasts";
    toastHost.setAttribute("role", "region");
    toastHost.setAttribute("aria-label", "Notifications");
    document.body.appendChild(toastHost);
    return toastHost;
  }

  function dismissToast(key) {
    const entry = live.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    live.delete(key);
    entry.node.classList.add("is-leaving");
    setTimeout(() => { entry.node.remove(); pump(); }, 160);
  }

  function pump() {
    while (live.size < TOAST_MAX && waiting.length) paint(waiting.shift());
  }

  function paint(toast) {
    const key = toast.key;
    const existing = live.get(key);
    if (existing) {                                   // same message again: don't stack it
      if (existing.timer) clearTimeout(existing.timer);
      const ms = TOAST_MS[toast.tone] != null ? TOAST_MS[toast.tone] : TOAST_MS.info;
      existing.timer = ms ? setTimeout(() => dismissToast(key), ms) : null;
      existing.node.classList.remove("is-repeat");
      void existing.node.offsetWidth;
      existing.node.classList.add("is-repeat");
      return;
    }
    const node = document.createElement("div");
    node.className = "ep-toast ep-toast--" + (toast.tone || "info");
    node.setAttribute("role", toast.tone === "error" || toast.tone === "critical" ? "alert" : "status");
    node.innerHTML =
      '<div class="ep-toast__body">' +
        '<strong class="ep-toast__title">' + esc(toast.title) + "</strong>" +
        (toast.message ? '<span class="ep-toast__text">' + esc(toast.message) + "</span>" : "") +
      "</div>" +
      '<div class="ep-toast__actions">' +
        (toast.action ? '<button type="button" class="ep-toast__view" data-toast-action>' +
          esc(toast.action.label || "View") + "</button>" : "") +
        '<button type="button" class="ep-toast__close" data-toast-close aria-label="Dismiss">&times;</button>' +
      "</div>";
    host().appendChild(node);
    const ms = TOAST_MS[toast.tone] != null ? TOAST_MS[toast.tone] : TOAST_MS.info;
    const entry = { node: node, timer: ms ? setTimeout(() => dismissToast(key), ms) : null };
    live.set(key, entry);
    node.addEventListener("click", ev => {
      if (ev.target.closest("[data-toast-close]")) { dismissToast(key); return; }
      if (ev.target.closest("[data-toast-action]") && toast.action && typeof toast.action.run === "function") {
        dismissToast(key);
        toast.action.run();
      }
    });
  }

  /** Show one toast. `tone`: success | info | alert | error | critical. */
  function toast(options) {
    const opts = typeof options === "string" ? { title: options } : (options || {});
    if (!opts.title) return;
    const item = {
      key: opts.key || ((opts.tone || "info") + "|" + opts.title + "|" + (opts.message || "")),
      title: opts.title,
      message: opts.message || "",
      tone: opts.tone || "info",
      action: opts.action || null
    };
    if (live.has(item.key) || live.size < TOAST_MAX) paint(item);
    else {
      const queued = waiting.findIndex(t => t.key === item.key);
      if (queued !== -1) waiting[queued] = item;        // deduplicated in the queue too
      else {
        waiting.push(item);
        while (waiting.length > 12) waiting.shift();
      }
    }
  }

  global.Solar91PortalToast = {
    show: toast,
    success: (title, message) => toast({ title: title, message: message, tone: "success" }),
    info: (title, message) => toast({ title: title, message: message, tone: "info" }),
    alert: (title, message, action) => toast({ title: title, message: message, tone: "alert", action: action }),
    error: (title, message) => toast({ title: title, message: message, tone: "error" }),
    dismissAll: () => { Array.from(live.keys()).forEach(dismissToast); waiting.length = 0; }
  };

  // ── The bell and its panel ────────────────────────────────────────────────

  const state = {
    ready: false,
    open: false,
    filter: "all",            // all | unread | actions
    unread: 0,
    actions: [],
    items: [],
    nextBefore: null,
    nextBeforeId: null,
    hasMore: false,
    loading: false,
    error: "",
    inflight: null,
    listToken: 0,
    backoff: 60000,
    announced: new Set(),     // notification ids already toasted in this tab
    timer: null
  };

  const BASE_INTERVAL = 60000;
  const MAX_INTERVAL = 600000;

  function el(selector) { return document.querySelector(selector); }

  function restoreAnnounced() {
    try {
      const saved = JSON.parse(sessionStorage.getItem("solar91Portal.toastedNotifications") || "[]");
      if (Array.isArray(saved)) saved.slice(-200).forEach(id => state.announced.add(id));
    } catch (_) { /* a private window simply re-announces once */ }
  }

  function rememberAnnounced() {
    try {
      sessionStorage.setItem("solar91Portal.toastedNotifications",
        JSON.stringify(Array.from(state.announced).slice(-200)));
    } catch (_) { /* nothing to do: the badge is still correct */ }
  }

  function when(value) {
    if (!value) return "";
    const then = new Date(value);
    if (isNaN(then.getTime())) return "";
    const seconds = Math.round((Date.now() - then.getTime()) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
    if (seconds < 86400) return Math.floor(seconds / 3600) + " h ago";
    if (seconds < 604800) return Math.floor(seconds / 86400) + " d ago";
    return new Intl.DateTimeFormat("en-IN", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata"
    }).format(then);
  }

  const CATEGORY_LABEL = {
    issue: "Site issue", pm: "Preventive Maintenance", washing: "Module Cleaning",
    task: "Work order", access: "Access", general: "Portal"
  };

  function badge() {
    const button = el("[data-notification-toggle]");
    const count = el("[data-notification-count]");
    if (!button || !count) return;
    const unread = state.unread;
    count.textContent = unread > 99 ? "99+" : String(unread);
    count.hidden = !unread;
    const actions = state.actions.reduce((sum, a) => sum + (a.count || 0), 0);
    button.setAttribute("aria-label", unread
      ? unread + " unread notification" + (unread === 1 ? "" : "s")
      : "Notifications");
    button.classList.toggle("has-unread", !!unread);
    button.classList.toggle("has-actions", !!actions);
  }

  function itemHTML(item) {
    const link = item.link || {};
    const where = [link.plant_name, link.site_code].filter(Boolean).join(" · ");
    return '<li class="ep-note ep-note--' + esc(item.tone || "blue") +
      (item.read ? "" : " is-unread") + '" data-note-id="' + esc(item.id) + '">' +
      '<button type="button" class="ep-note__main" data-note-open="' + esc(item.id) + '">' +
        '<span class="ep-note__head">' +
          '<span class="ep-note__cat">' + esc(CATEGORY_LABEL[item.category] || "Portal") + "</span>" +
          (item.priority && item.priority !== "normal"
            ? '<span class="ep-note__priority">' + esc(item.priority) + "</span>" : "") +
          '<span class="ep-note__time">' + esc(when(item.created_at)) + "</span>" +
        "</span>" +
        '<strong class="ep-note__title">' + esc(item.title) + "</strong>" +
        (item.message ? '<span class="ep-note__text">' + esc(item.message) + "</span>" : "") +
        (where ? '<span class="ep-note__where">' + esc(where) + "</span>" : "") +
      "</button>" +
      (item.read ? "" : '<button type="button" class="ep-note__read" data-note-read="' +
        esc(item.id) + '" title="Mark as read" aria-label="Mark as read">Mark read</button>') +
      "</li>";
  }

  function actionsHTML() {
    if (!state.actions.length) {
      return '<div class="ep-note-empty"><strong>Nothing is waiting for you</strong>' +
        "<p>Approvals, permission requests and overdue work appear here until they are resolved.</p></div>";
    }
    return '<ul class="ep-note-list">' + state.actions.map(action =>
      '<li class="ep-note ep-note--' + esc(action.tone || "amber") + ' is-action">' +
        '<button type="button" class="ep-note__main" data-action-open="' + esc(action.page || "") +
          '" data-action-plant="' + esc(action.site_code || "") + '">' +
          '<span class="ep-note__head"><span class="ep-note__cat">Action required</span></span>' +
          '<strong class="ep-note__title">' + esc(action.label) + "</strong>" +
          '<span class="ep-note__text">' + esc(action.count) + " item" + (action.count === 1 ? "" : "s") +
          " · stays until resolved</span>" +
        "</button></li>").join("") + "</ul>";
  }

  function listHTML() {
    if (state.filter === "actions") return actionsHTML();
    if (state.loading && !state.items.length) {
      return '<div class="ep-note-empty" role="status">Loading notifications…</div>';
    }
    if (state.error && !state.items.length) {
      return '<div class="ep-note-empty" role="alert"><strong>Notifications unavailable</strong><p>' +
        esc(state.error) + '</p><button type="button" class="ep-note-retry" data-note-retry>Try again</button></div>';
    }
    if (!state.items.length) {
      return '<div class="ep-note-empty"><strong>' +
        (state.filter === "unread" ? "Nothing unread" : "No notifications yet") +
        "</strong><p>Assignments, approvals and alerts for your plants appear here.</p></div>";
    }
    return '<ul class="ep-note-list">' + state.items.map(itemHTML).join("") + "</ul>" +
      (state.hasMore ? '<button type="button" class="ep-note-more" data-note-more>' +
        (state.loading ? "Loading…" : "Show older") + "</button>" : "");
  }

  function render() {
    badge();
    const panel = el("[data-notification-panel]");
    if (!panel) return;
    panel.hidden = !state.open;
    const toggle = el("[data-notification-toggle]");
    if (toggle) toggle.setAttribute("aria-expanded", String(state.open));
    if (!state.open) { panel.innerHTML = ""; return; }
    const actionCount = state.actions.reduce((sum, a) => sum + (a.count || 0), 0);
    panel.innerHTML =
      '<div class="ep-note-head">' +
        "<strong>Notifications</strong>" +
        '<button type="button" class="ep-note-allread" data-note-read-all' +
          (state.unread ? "" : " disabled") + ">Mark all as read</button>" +
      "</div>" +
      '<div class="ep-note-tabs" role="tablist">' +
        ['<button type="button" role="tab" data-note-filter="all" aria-selected="' +
          (state.filter === "all") + '">All</button>',
         '<button type="button" role="tab" data-note-filter="unread" aria-selected="' +
          (state.filter === "unread") + '">Unread' + (state.unread ? " (" + state.unread + ")" : "") + "</button>",
         '<button type="button" role="tab" data-note-filter="actions" aria-selected="' +
          (state.filter === "actions") + '">Action required' + (actionCount ? " (" + actionCount + ")" : "") +
          "</button>"].join("") +
      "</div>" +
      '<div class="ep-note-body">' + listHTML() + "</div>" +
      '<p class="ep-note-foot">Marking a notification as read does not resolve the work it refers to.</p>';
  }

  // ── Requests ──────────────────────────────────────────────────────────────

  function summary() {
    if (state.inflight) return state.inflight;                 // one request at a time
    state.inflight = api().request("/api/notifications/summary").then(body => {
      state.inflight = null;
      state.error = "";
      state.backoff = BASE_INTERVAL;
      const before = state.unread;
      state.unread = Number(body.unread_count) || 0;
      state.actions = Array.isArray(body.actions) ? body.actions : [];
      badge();
      if (state.open) render();
      if (state.unread > before) announce();
      return body;
    }).catch(error => {
      state.inflight = null;
      state.error = (error && error.message) || "Notifications could not be loaded.";
      state.backoff = Math.min(MAX_INTERVAL, (state.backoff || BASE_INTERVAL) * 2);
      if (state.open && state.filter !== "actions" && !state.items.length) render();
      throw error;
    });
    return state.inflight;
  }

  /** Something new arrived: toast the important ones, once each. */
  function announce() {
    api().request("/api/notifications?unread=true&limit=5").then(body => {
      const fresh = (body.notifications || []).filter(item =>
        !state.announced.has(item.id) && (item.priority === "high" || item.priority === "critical"));
      fresh.reverse().forEach(item => {
        state.announced.add(item.id);
        toast({
          key: "note:" + item.id,
          title: item.title,
          message: item.message || "",
          tone: item.priority === "critical" ? "critical" : "alert",
          action: { label: "View", run: () => openItem(item, true) }
        });
      });
      (body.notifications || []).forEach(item => state.announced.add(item.id));
      rememberAnnounced();
      if (state.open && state.filter !== "actions") loadList(true);
    }).catch(() => { /* the badge is already right; a missed toast is not an error */ });
  }

  function loadList(reset) {
    if (state.filter === "actions") { render(); return Promise.resolve(); }
    const token = ++state.listToken;
    state.loading = true;
    if (reset) { state.items = []; state.nextBefore = null; state.nextBeforeId = null; state.hasMore = false; }
    render();
    // The cursor is the last row's timestamp AND its id: notifications written together
    // share a timestamp, and the id is what keeps the next page from repeating one.
    const query = "/api/notifications?limit=20" + (state.filter === "unread" ? "&unread=true" : "") +
      (!reset && state.nextBefore ? "&before=" + encodeURIComponent(state.nextBefore) +
        (state.nextBeforeId ? "&before_id=" + encodeURIComponent(state.nextBeforeId) : "") : "");
    return api().request(query).then(body => {
      if (token !== state.listToken) return;
      state.loading = false;
      state.error = "";
      state.items = reset ? (body.notifications || []) : state.items.concat(body.notifications || []);
      state.unread = Number(body.unread_count) || 0;
      state.hasMore = !!body.has_more;
      state.nextBefore = body.next_before || null;
      state.nextBeforeId = body.next_before_id || null;
      state.items.forEach(item => state.announced.add(item.id));
      rememberAnnounced();
      render();
    }).catch(error => {
      if (token !== state.listToken) return;
      state.loading = false;
      state.error = (error && error.message) || "Notifications could not be loaded.";
      render();
    });
  }

  function markRead(id) {
    const item = state.items.find(row => row.id === id);
    if (!item || item.read) return;
    item.read = true;                                   // optimistic; rolled back on failure
    state.unread = Math.max(0, state.unread - 1);
    render();
    api().request("/api/notifications/" + encodeURIComponent(id) + "/read", { method: "POST", body: {} })
      .then(body => {
        if (body && typeof body.unread_count === "number") state.unread = body.unread_count;
        if (state.filter === "unread") loadList(true);
        else render();
      })
      .catch(error => {
        item.read = false;
        state.unread += 1;
        render();
        global.Solar91PortalToast.error("Could not mark that as read",
          (error && error.message) || "Check your connection and try again.");
      });
  }

  function markAllRead() {
    if (!state.unread) return;
    const previous = state.items.map(item => item.read);
    state.items.forEach(item => { item.read = true; });
    const had = state.unread;
    state.unread = 0;
    render();
    api().request("/api/notifications/read-all", { method: "POST", body: {} })
      .then(() => { loadList(true); summary().catch(() => {}); })
      .catch(error => {
        state.items.forEach((item, index) => { item.read = previous[index]; });
        state.unread = had;
        render();
        global.Solar91PortalToast.error("Could not mark all as read",
          (error && error.message) || "Check your connection and try again.");
      });
  }

  // ── Opening what a notification is about ──────────────────────────────────

  function plantRecord(siteCode) {
    if (!siteCode) return Promise.resolve(null);
    return api().plants().then(plants =>
      plants.find(plant => plant.siteCode === siteCode) || null).catch(() => null);
  }

  function openItem(item, fromToast) {
    const link = item.link || {};
    const close = () => { if (!fromToast) setOpen(false); };
    if (!item.read && !fromToast) markRead(item.id);
    const page = link.page || (item.target_type === "issue" ? "health" : null);
    if (!page || page === "settings") { close(); return; }
    if (!link.site_code) {
      close();
      if (nav()) nav().selectView(page === "pm" ? "pm" : page === "washing" ? "washing" : "health");
      return;
    }
    plantRecord(link.site_code).then(plant => {
      close();
      if (!plant) {
        global.Solar91PortalToast.info("That plant is not in your access",
          "Ask the O&M Head if you need access to " + (link.site_code || "it") + ".");
        return;
      }
      if (page === "pm") {
        nav().selectPlantPage(plant.siteCode, "pm", null, plant, {
          pmParent: "overview", pmCalendar: true,
          pmCalendarMonth: link.month || null, pmCalendarEventId: link.activity_id || null
        });
      } else {
        nav().selectPlantPage(plant.siteCode, page === "washing" ? "washing" : "health", null, plant);
      }
    });
  }

  function openAction(page, siteCode) {
    setOpen(false);
    if (!nav()) return;
    if (siteCode) {
      plantRecord(siteCode).then(plant => {
        if (plant) nav().selectPlantPage(plant.siteCode, page, null, plant);
        else nav().selectView(page);
      });
      return;
    }
    nav().selectView(page === "pm" ? "pm" : page === "washing" ? "washing" : "health");
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  function setOpen(open) {
    state.open = open;
    render();
    if (open) {
      if (state.filter === "actions") summary().catch(() => {});
      else { loadList(true); summary().catch(() => {}); }
    }
  }

  function schedule() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (!state.ready || document.visibilityState !== "visible") return;
    const slow = global.navigator && global.navigator.connection &&
      (global.navigator.connection.saveData ||
        /(^|-)[23]g$/.test(String(global.navigator.connection.effectiveType || "")));
    const wait = Math.max(state.backoff || BASE_INTERVAL, slow ? 180000 : BASE_INTERVAL);
    state.timer = setTimeout(() => {
      if (global.navigator && global.navigator.onLine === false) { schedule(); return; }
      summary().catch(() => {}).then(schedule);
    }, wait + Math.random() * 5000);
  }

  function wire() {
    const root = el("[data-notification-centre]");
    if (!root) return false;
    root.addEventListener("click", ev => {
      const toggle = ev.target.closest("[data-notification-toggle]");
      if (toggle) { ev.stopPropagation(); setOpen(!state.open); return; }
      const filter = ev.target.closest("[data-note-filter]");
      if (filter) {
        state.filter = filter.getAttribute("data-note-filter");
        if (state.filter === "actions") { render(); summary().catch(() => {}); }
        else loadList(true);
        return;
      }
      if (ev.target.closest("[data-note-read-all]")) { markAllRead(); return; }
      if (ev.target.closest("[data-note-retry]")) { loadList(true); summary().catch(() => {}); return; }
      if (ev.target.closest("[data-note-more]")) { loadList(false); return; }
      const read = ev.target.closest("[data-note-read]");
      if (read) { markRead(read.getAttribute("data-note-read")); return; }
      const open = ev.target.closest("[data-note-open]");
      if (open) {
        const item = state.items.find(row => row.id === open.getAttribute("data-note-open"));
        if (item) openItem(item, false);
        return;
      }
      const action = ev.target.closest("[data-action-open]");
      if (action) {
        openAction(action.getAttribute("data-action-open") || "pm",
          action.getAttribute("data-action-plant") || "");
      }
    });
    document.addEventListener("click", ev => {
      if (state.open && !root.contains(ev.target)) setOpen(false);
    });
    document.addEventListener("keydown", ev => {
      if (ev.key === "Escape" && state.open) {
        setOpen(false);
        const toggle = el("[data-notification-toggle]");
        if (toggle) toggle.focus();
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { summary().catch(() => {}); schedule(); }
      else if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    });
    global.addEventListener("online", () => { summary().catch(() => {}); schedule(); });
    global.addEventListener("offline", () => {
      global.Solar91PortalToast.show({
        key: "offline", tone: "error", title: "No internet connection",
        message: "Nothing is lost: notifications and saved work reappear once you are back online."
      });
    });
    // A confirmed write anywhere in the portal can have produced a notification.
    document.addEventListener("portal:data-invalidated", () => { summary().catch(() => {}); });
    return true;
  }

  function init() {
    if (state.ready) { summary().catch(() => {}); return; }
    if (!wire()) return;
    state.ready = true;
    restoreAnnounced();
    summary().catch(() => {}).then(schedule);
  }

  global.Solar91PortalNotifications = {
    init: init,
    refresh: () => { if (state.ready) summary().catch(() => {}); },
    unreadCount: () => state.unread,
    actionsRequired: () => state.actions.slice(),
    open: () => setOpen(true)
  };
}(window));
