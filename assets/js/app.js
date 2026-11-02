/**
 * app.js — Boots the Solar91 O&M portal behind the sign-in gate.
 *
 * The access panel is unchanged: frontend/static/js/auth-gate.js owns Clerk
 * loading, the e-mail-code sign-in screen, token refresh and apiFetch. This
 * file only decides what happens *after* a valid session exists, which is the
 * part the redesign replaced.
 *
 * Boot order (same contract the previous bundle used):
 *   ensureClerkReady() → no Clerk session ? showClerkSignIn()
 *                      → GET /api/auth/session → role gate → render portal
 */
(function (global) {
  "use strict";

  var booted = false;

  function setText(selector, value) {
    var el = document.querySelector(selector);
    if (el) el.textContent = value;
  }

  function stampUpdated() {
    setText("[data-last-updated]", "Updated " + new Intl.DateTimeFormat("en-IN", {
      hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short"
    }).format(new Date()));
  }

  /** Render the portal for a signed-in user whose role has been granted access. */
  function renderPortal(user) {
    if (booted) return;
    booted = true;

    setText("[data-user-name]", user.name || user.email || "Solar91 User");
    setText("[data-user-role]", user.role || "Viewer");
    var avatar = document.querySelector(".ep-avatar");
    if (avatar) avatar.textContent = (user.name || user.email || "S").trim().charAt(0).toUpperCase();

    stampUpdated();

    global.Solar91PortalNav.wire();
    global.Solar91PortalNav.applyRoleVisibility(user.role || "Viewer");
    global.Solar91PortalNav.loadPlants();
    global.Solar91PortalOverview.init();

    // "Open →" in the portfolio comparison table jumps to that plant in the sidebar.
    document.addEventListener("click", function (ev) {
      var openBtn = ev.target.closest("[data-open-plant]");
      if (openBtn) {
        global.Solar91PortalNav.selectPlant(openBtn.getAttribute("data-open-plant"));
      }
    });
  }

  /**
   * startSolar91App — the name auth-gate.js calls after a successful sign-in.
   * Kept identical in shape to the previous implementation so the access panel,
   * the pending-access states and the sign-out path behave exactly as before.
   */
  global.startSolar91App = async function startSolar91App() {
    try {
      var ready = await ensureClerkReady();
      if (!ready) return;
      if (!global.Clerk.session) { showClerkSignIn(); return; }

      var session = await apiFetch("/api/auth/session");
      var user = session.user || {};
      if (global.Solar91PortalAPI) global.Solar91PortalAPI.setSession(session);
      AUTH_IDENTITY.name = user.name || user.email || "Solar91 User";
      AUTH_IDENTITY.role = user.role || "Viewer";
      AUTH_IDENTITY.userId = user.id || null;
      AUTH_IDENTITY.email = user.email || null;

      if (AUTH_IDENTITY.role === "Viewer") {
        authSetupCard(
          "Access pending",
          "Your Clerk sign-in is valid, but a Solar91 O&amp;M Head must assign your operational role " +
          "before business data is shown." +
          '<button onclick="clerkSignOut()" style="margin-left:12px;padding:8px 12px">Sign out</button>'
        );
        return;
      }

      renderPortal({ name: AUTH_IDENTITY.name, email: AUTH_IDENTITY.email, role: AUTH_IDENTITY.role });
    } catch (e) {
      var message = String((e && e.message) || e);
      console.error("Solar91 startup", e);
      if (message.includes("Authentication required")) { showClerkSignIn(); return; }
      if (/not registered for Solar91/i.test(message)) {
        try { await global.Clerk.signOut(); } catch (_) {}
        showClerkSignIn("This email is not registered. Ask your O&M Head to add you, then try again.");
        return;
      }
      authSetupCard("Solar91 could not start", esc(message));
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { global.startSolar91App(); });
  } else {
    global.startSolar91App();
  }
}(window));
