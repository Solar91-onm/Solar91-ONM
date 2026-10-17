"use strict";

(function(){
  if(window._ccSiteAsk) return;
  window._ccSiteAsk = true;

  function xesc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;")}
  function me(){ return S.currentUser || (typeof OM_HEAD!=="undefined"?OM_HEAD:"Arun Agarwal"); }
  function role(){ return S._roleLabel || S.currentRole || "O&M Head"; }
  function canAsk(){ return !/^(Client|Vendor)/.test(role()); }
  function plantSiteEngineer(plantName){
    var p = (typeof plantRec === "function") ? plantRec(plantName) : null;
    if(!p) return "";
    return (typeof plantEngineer === "function") ? plantEngineer(p) : "";
  }

   function buildTargets(t){
    var m = me();
    var assignee = (t.assignee||"").trim();
    var site = plantSiteEngineer(t.plant);
    var out = [], seen = {};
    function push(key, name, role, primary){
      if(!name) return;
      var n = String(name).trim();
      if(!n || seen[n] || n === m) return;
      seen[n] = 1;
      out.push({key:key, name:n, role:role, primary:!!primary, isMe: n === m});
    }
    /* site engineer FIRST — this is the primary "ask" in the O&M-team workflow */
    push("siteEngineer", site, "Site engineer — " + (t.plant||""), true);
    push("assignee", assignee, "Assignee — owns this ticket", false);
    return out;
  }

   window.ccRequestUpdate = function(ticketId){
    var t = (S.issues||[]).find(function(x){return x.id===ticketId});
    if(!t) return;

    var targets = buildTargets(t);
    if(!targets.length){
      if(typeof toast==="function"){
        toast(
          t.assignee === me() && !plantSiteEngineer(t.plant)
            ? "No site engineer on file for " + t.plant + " — set one from Edit Plant."
            : "No one to ask on this ticket."
        );
      }
      return;
    }

    var old = document.getElementById("cc-upd-ovl");
    if(old) old.remove();

    var o = document.createElement("div");
    o.id = "cc-upd-ovl";
    o.className = "overlay";
    o.style.zIndex = "320";
    o.onclick = function(e){ if(e.target === o) o.remove(); };

    var rowsHtml = targets.map(function(tgt){
      /* primary (site engineer) auto-checked; secondary also checked by default
         so the O&M team can hit "Send" and both get it if they want */
      var checked = tgt.primary || true;
      return '<label class="row" style="gap:10px;font-size:13px;font-weight:500;padding:11px 4px;border-bottom:1px solid var(--border);cursor:pointer;align-items:flex-start">'+
        '<input type="checkbox" name="cc-upd-target" value="'+xesc(tgt.key)+'" data-name="'+xesc(tgt.name)+'"'+(checked?' checked':'')+' style="margin-top:3px"/>'+
        '<div style="flex:1;min-width:0">'+
          '<div style="font-weight:700'+(tgt.primary?';color:#1e40af':'')+'">'+xesc(tgt.name)+(tgt.primary?' <span style="font-size:11px;font-weight:800;letter-spacing:.06em;background:#dbeafe;color:#1e40af;padding:1px 6px;border-radius:999px;vertical-align:middle;margin-left:4px">SITE</span>':'')+'</div>'+
          '<div style="font-size:12.5px;color:var(--muted-foreground);margin-top:2px">'+xesc(tgt.role)+'</div>'+
        '</div>'+
      '</label>';
    }).join("");

    var sevBadge = (typeof badge==="function") ? badge(t.severity) : xesc(t.severity);
    var stBadge  = (typeof badge==="function") ? badge(t.status)   : xesc(t.status);
    var closeIc = (typeof I!=="undefined" && I.x) ? I.x(18) : "×";

    o.innerHTML =
      '<div class="modal" style="max-width:520px">'+
        '<div class="modal-h"><div>'+
          '<h3 style="font-size:16px;font-weight:600;margin:0">🔔 Ask for update — '+xesc(t.id)+'</h3>'+
          '<p style="font-size:12px;color:var(--muted-foreground);margin:4px 0 0">'+
            xesc(t.plant||"")+' · '+xesc(t.vertical||"")+' · '+sevBadge+' '+stBadge+
          '</p>'+
        '</div>'+
        '<button class="btn" style="border:none;color:var(--muted-foreground)" onclick="document.getElementById(\'cc-upd-ovl\').remove()">'+closeIc+'</button>'+
        '</div>'+
        '<div class="modal-b">'+
          '<div style="font-size:12.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted-foreground);margin-bottom:6px">Who should we ask?</div>'+
          rowsHtml +
          '<div class="field" style="margin-top:16px"><span class="lbl">Message (optional)</span>'+
            '<textarea id="cc-upd-msg" class="txt" rows="2" placeholder="e.g. What\'s the site status — part arrived?"></textarea>'+
          '</div>'+
          '<div style="font-size:12.5px;color:var(--muted-foreground);margin-top:10px;line-height:1.5">'+
            'They\'ll get a bell notification and a full-screen ring on their device if logged in. The flag clears automatically when they post a progress note.'+
          '</div>'+
        '</div>'+
        '<div class="modal-f">'+
          '<button class="btn o" onclick="document.getElementById(\'cc-upd-ovl\').remove()">Cancel</button>'+
          '<button class="btn p" onclick="ccRequestUpdateSubmit(\''+xesc(t.id)+'\')">Send request</button>'+
        '</div>'+
      '</div>';
    document.body.appendChild(o);
    setTimeout(function(){
      var cb = o.querySelector('input[name="cc-upd-target"]');
      if(cb) cb.focus();
    }, 40);
  };

   function injectAskSiteButtons(){
    if(!canAsk()) return;
    var rows = document.querySelectorAll('.content tr[data-act="issue"]');
    rows.forEach(function(tr){
      var id = tr.getAttribute("data-id");
      var t = (S.issues||[]).find(function(x){return x.id===id});
      if(!t) return;
      if(t.status === "Closed" || t.status === "Resolved") return;

      var tds = tr.querySelectorAll("td");
      if(!tds.length) return;
      var last = tds[tds.length-1];
      var rail = last.querySelector(".row");
      if(!rail) return;

      /* clear our own previous injection */
      rail.querySelectorAll(".cc-ask-site").forEach(function(b){ b.remove(); });

      var site = plantSiteEngineer(t.plant);
      if(!site || site === me()) return;

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn o sm cc-ask-site";
      btn.innerHTML = "🔔 Ask site";
      btn.title = "Quick ask the site engineer — " + site;
      btn.onclick = function(e){ e.stopPropagation(); quickAskSite(id, site, t.plant); };
      /* place it right before the regular Ask button */
      var regular = rail.querySelector(".cc-wf-ask");
      if(regular) rail.insertBefore(btn, regular);
      else rail.appendChild(btn);
    });
  }

  function quickAskSite(ticketId, siteName, plantName){
    var t = (S.issues||[]).find(function(x){return x.id===ticketId});
    if(!t) return;

    var note = prompt(
      "Ask " + siteName + " (" + plantName + ") for an update on " + t.id + ".\n\n" +
      "Optional message (leave blank for a generic nudge):",
      ""
    );
    if(note === null) return;

    var at = (typeof stampISO === "function") ? stampISO() : new Date().toISOString();
    t.updateRequestedAt   = at;
    t.updateRequestedBy   = me();
    t.updateRequestedFrom = [siteName];
    t.seenAt = null;
    t.seenBy = [];
    t.progress = t.progress || [];
    t.progress.unshift({
      at: at,
      note: "🔔 " + me() + " asked " + siteName + " for a site update" +
            (note ? " — " + note : " — please post status"),
      parts: "—", hrs: 0,
      kind: "update_request",
      targets: [siteName]
    });

    if(typeof audit === "function")
      audit("Issues", "Site update requested on "+t.id+" → "+siteName, me(), "—", "Update requested");

    if(typeof emitEvent === "function"){
      emitEvent(
        "update_requested",
        "Site update requested — " + t.id,
        (t.plant||"") + " · for " + siteName + (note ? " · " + note : ""),
        "issue", t.id, "siteupdreq:" + t.id + ":" + at
      );
    }

    if(typeof persist === "function") persist();
    render();

    if(typeof ccPopup === "function"){
      ccPopup("Site update requested", siteName + (note ? " · " + note : " · generic nudge sent"), "w", null);
    }
  }
 var st = document.createElement("style");
  st.textContent =
    '.cc-ask-site{background:linear-gradient(135deg,#dbeafe,#bfdbfe)!important;border-color:#93c5fd!important;color:#1e40af!important;font-weight:800!important}' +
    '.cc-ask-site:hover{background:linear-gradient(135deg,#bfdbfe,#93c5fd)!important;border-color:#60a5fa!important;color:#1e3a8a!important}';
  document.head.appendChild(st);

  /* ----------------------------------------------------------------
     4 · Render hook
     ---------------------------------------------------------------- */
  var orig = render;
  render = function(){
    orig.apply(this, arguments);
    try{
      if((S.view === "om-module" && S.omTab === "issues") || S.view === "dashboard"){
        injectAskSiteButtons();
      }
    }catch(e){ console.warn("[SITE-ASK]", e); }
  };

  console.log("[SITE-ASK] loaded — O&M team can ask site engineer (dialog + 2-tap)");
})();

/* ================================================================
   TEAM MODEL v3 — Site Engineer fixed per plant · Assignee = O&M team
   · Adds `siteEngineer` field on each plant (single, permanent)
   · Migrates the old `assignedEngineer` value into it
   · Site Engineer picker: choose plant only; name comes from the plant
   · Assignee picker: choose O&M team member; portfolio-wide
   · Ask dialog labels: "Site engineer · resident at X"
                        "O&M team · assigned to this ticket"
   · "Ask site" button uses the fixed plant.siteEngineer field
   ================================================================ */
(function(){
  if(window._ccTeamModelV3) return;
  window._ccTeamModelV3 = true;

  function xesc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;")}
  function me(){ return S.currentUser || (typeof OM_HEAD!=="undefined"?OM_HEAD:"Arun Agarwal"); }
  function engCode(p){
    return (typeof normalizeSiteCode==="function") ? normalizeSiteCode(p.id) : String(p.id||"").toUpperCase();
  }

  /* ----------------------------------------------------------------
     1 · Field: plantEnrich[code].siteEngineer
     ---------------------------------------------------------------- */
  function plantSiteEngineer(p){
    if(!p) return "";
    var en = S.plantEnrich || {};
    var e = en[engCode(p)];
    return (e && e.siteEngineer) || "";
  }
  function setPlantSiteEngineer(plantId, name){
    var code = (typeof normalizeSiteCode==="function") ? normalizeSiteCode(plantId) : String(plantId||"").toUpperCase();
    S.plantEnrich = S.plantEnrich || {};
    S.plantEnrich[code] = Object.assign({}, S.plantEnrich[code] || {});
    if(name) S.plantEnrich[code].siteEngineer = name;
    else delete S.plantEnrich[code].siteEngineer;
  }
  window.plantSiteEngineer = plantSiteEngineer;
  window.setPlantSiteEngineer = setPlantSiteEngineer;

  /* Migrate old assignedEngineer → siteEngineer, once */
  (function migrate(){
    try{
      var en = S.plantEnrich || {};
      var touched = false;
      Object.keys(en).forEach(function(code){
        var e = en[code];
        if(e && e.assignedEngineer && !e.siteEngineer){
          e.siteEngineer = e.assignedEngineer;
          touched = true;
        }
      });
      if(touched && typeof persist === "function") persist();
    }catch(e){}
  })();

  /* ----------------------------------------------------------------
     2 · Rename the Edit-Plant dropdown + save to the new field
     ---------------------------------------------------------------- */
  var origSaveEditPlant = window.saveEditPlant;
  if(typeof origSaveEditPlant === "function"){
    window.saveEditPlant = async function(id){
      var el = document.getElementById("pf-engineer");
      var had = !!el;
      var eng = el ? (el.value||"").trim() : "";
      var rv = await origSaveEditPlant.apply(this, arguments);
      if(had){
        setPlantSiteEngineer(id, eng);
        if(typeof persist==="function") persist();
        try{ render(); }catch(e){}
      }
      return rv;
    };
  }
  var origSaveAddPlant = window.saveAddPlant;
  if(typeof origSaveAddPlant === "function"){
    window.saveAddPlant = async function(){
      var el = document.getElementById("pf-engineer");
      var codeEl = document.getElementById("pf-code");
      var had = !!el;
      var eng = el ? (el.value||"").trim() : "";
      var code = codeEl ? (codeEl.value||"").trim() : "";
      var rv = await origSaveAddPlant.apply(this, arguments);
      if(had && code){
        setPlantSiteEngineer(code, eng);
        if(typeof persist==="function") persist();
        try{ render(); }catch(e){}
      }
      return rv;
    };
  }

  function relabelEngineerField(){
    if(S.modal !== "addPlant" && S.modal !== "editPlant") return;
    var el = document.getElementById("pf-engineer");
    if(!el) return;
    var field = el.closest(".field");
    if(!field) return;
    var lbl = field.querySelector(".lbl");
    if(lbl && lbl.textContent !== "Site Engineer (resident at plant)"){
      lbl.textContent = "Site Engineer (resident at plant)";
    }
    var hint = field.querySelector("span[style*='10.5px']");
    if(hint) hint.textContent =
      "One fixed field engineer who lives at this site. Distinct from the O&M team member assigned to each ticket.";
    /* preselect from the new field */
    if(S.modal === "editPlant" && S.modalCtx && S.modalCtx.id){
      var p = (S.plants||[]).find(z=>z.id===S.modalCtx.id);
      if(p){
        var cur = plantSiteEngineer(p);
        if(cur && el.value !== cur) el.value = cur;
      }
    }
  }

  /* ----------------------------------------------------------------
     3 · Site Engineer picker — pick plant only; name comes from plant
        Assignee picker — pick O&M team member; portfolio-wide
     Override ccSwitchRole for BOTH labels; leave O&M Head/Administration
     to fall through to the existing chain.
     ---------------------------------------------------------------- */
  var prevSwitch = window.ccSwitchRole;
  window.ccSwitchRole = function(label){

    /* ---- SITE ENGINEER: plant-picker, name auto ---- */
    if(label === "Site Engineer"){
      var plants = (S.plants||[]).filter(function(p){ return plantSiteEngineer(p); });
      if(!plants.length){
        if(typeof toast==="function")
          toast("No plant has a Site Engineer set yet — go to Plants → Edit → Site Engineer (resident).");
        return;
      }
      var list = plants.map(function(p){
        return p.name + "  →  " + plantSiteEngineer(p);
      }).join("\n");
      var pick = prompt(
        "Viewing as Site Engineer — which plant?\n\n" + list,
        plants[0].name
      );
      if(pick === null) return;
      var chosen = plants.find(function(p){ return p.name === pick.trim(); })
                || plants.find(function(p){ return p.name.toLowerCase() === pick.trim().toLowerCase(); });
      if(!chosen){
        if(typeof toast==="function") toast('Plant "' + pick.trim() + '" not found.');
        return;
      }
      var seName = plantSiteEngineer(chosen);

      S._roleLabel  = "Site Engineer";
      S._readOnly   = false;
      S.currentRole = "Site Engineer";
      S.currentUser = seName;
      S._seName     = seName;
      S._sePlant    = chosen.name;
      S.issF       = (typeof blankIssF === "function") ? blankIssF({plant: chosen.name}) : {plant: chosen.name};
      S.schedScope = chosen.name;
      S.washPlant  = chosen.name;
      S.dashPlant  = chosen.name;
      S.tablePages = S.tablePages || {};
      S.tablePages.issues = S.tablePages.plants = S.tablePages.scheduled = S.tablePages.washing = 1;

      try{
        if(typeof saveK === "function"){
          saveK("currentRole", S.currentRole);
          saveK("currentUser", S.currentUser);
          saveK("roleLabel",   S._roleLabel);
          saveK("readOnly",    S._readOnly);
          saveK("sePlant",     S._sePlant);
          saveK("seName",      S._seName);
        }
        if(typeof persist === "function") persist();
      }catch(e){}
      render();
      if(typeof ccPopup === "function"){
        ccPopup("Viewing as: Site Engineer",
                seName + " · resident at " + chosen.name + " · single-plant view",
                "i", null);
      }
      return;
    }

    /* ---- ASSIGNEE: O&M team member, portfolio-wide ---- */
    if(label === "Assignee"){
      var pool = (typeof TEAM_POOL !== "undefined" ? TEAM_POOL : []);
      if(!pool.length){
        if(typeof toast==="function") toast("No O&M team members on file.");
        return;
      }
      var remembered = (S._pickByRole && S._pickByRole["Assignee"]) || "";
      var pickName = prompt(
        "Viewing as O&M team member — who?\n" + pool.join(", "),
        remembered || pool[0]
      );
      if(pickName === null) return;
      var who = (pickName || pool[0] || "Engineer").trim();

      S._roleLabel  = "Assignee";
      S._readOnly   = false;
      S.currentRole = "Assignee";
      S.currentUser = who;
      S._sePlant = null;
      S._seName  = who;
      S._pickByRole = S._pickByRole || {};
      S._pickByRole["Assignee"] = who;

      S.issF = (typeof blankIssF === "function")
        ? blankIssF({assignee: who})
        : Object.assign({}, S.issF||{}, {assignee: who});
      S.tablePages = S.tablePages || {};
      S.tablePages.issues = 1;

      try{
        if(typeof saveK === "function"){
          saveK("currentRole", S.currentRole);
          saveK("currentUser", S.currentUser);
          saveK("roleLabel",   S._roleLabel);
          saveK("readOnly",    S._readOnly);
          saveK("sePlant",     null);
        }
        if(typeof persist === "function") persist();
      }catch(e){}
      render();
      if(typeof ccPopup === "function"){
        ccPopup("Viewing as: O&M Team",
                who + " · portfolio-wide · assigned-tickets view",
                "i", null);
      }
      return;
    }

    /* O&M Head and Administration fall through to the existing chain */
    return prevSwitch.apply(this, arguments);
  };

  /* ----------------------------------------------------------------
     4 · Ask dialog — clear labels for the two distinct roles
     ---------------------------------------------------------------- */
  window.ccRequestUpdate = function(ticketId){
    var t = (S.issues||[]).find(function(x){return x.id===ticketId});
    if(!t) return;

    var p = (typeof plantRec === "function") ? plantRec(t.plant) : null;
    var siteEng = p ? plantSiteEngineer(p) : "";
    var assignee = (t.assignee||"").trim();
    var m = me();

    var targets = [];
    if(siteEng && siteEng !== m)
      targets.push({key:"siteEngineer", name:siteEng,
                    role:"Site engineer · resident at " + (t.plant||""), primary:true});
    if(assignee && assignee !== m && assignee !== siteEng)
      targets.push({key:"assignee", name:assignee,
                    role:"O&M team · assigned to this ticket", primary:false});

    if(!targets.length){
      if(typeof toast==="function"){
        toast(
          "No site engineer on this plant and no O&M team member assigned — assign or set a site engineer first."
        );
      }
      return;
    }

    var old = document.getElementById("cc-upd-ovl");
    if(old) old.remove();
    var o = document.createElement("div");
    o.id = "cc-upd-ovl";
    o.className = "overlay";
    o.style.zIndex = "320";
    o.onclick = function(e){ if(e.target === o) o.remove(); };

    var rowsHtml = targets.map(function(tgt){
      var checked = tgt.primary; /* only site engineer pre-checked */
      return '<label class="row" style="gap:10px;font-size:13px;padding:11px 4px;border-bottom:1px solid var(--border);cursor:pointer;align-items:flex-start">'+
        '<input type="checkbox" name="cc-upd-target" value="'+xesc(tgt.key)+'" data-name="'+xesc(tgt.name)+'"'+(checked?' checked':'')+' style="margin-top:3px"/>'+
        '<div style="flex:1;min-width:0">'+
          '<div style="font-weight:700">'+xesc(tgt.name)+
            (tgt.primary?' <span style="font-size:11px;font-weight:800;letter-spacing:.06em;background:#dbeafe;color:#1e40af;padding:1px 6px;border-radius:999px;vertical-align:middle;margin-left:4px">SITE</span>':'')+
          '</div>'+
          '<div style="font-size:12.5px;color:var(--muted-foreground);margin-top:2px">'+xesc(tgt.role)+'</div>'+
        '</div>'+
      '</label>';
    }).join("");

    var sevBadge = (typeof badge==="function") ? badge(t.severity) : xesc(t.severity);
    var stBadge  = (typeof badge==="function") ? badge(t.status)   : xesc(t.status);
    var closeIc = (typeof I!=="undefined" && I.x) ? I.x(18) : "×";

    o.innerHTML =
      '<div class="modal" style="max-width:520px">'+
        '<div class="modal-h"><div>'+
          '<h3 style="font-size:16px;font-weight:600;margin:0">🔔 Ask for update — '+xesc(t.id)+'</h3>'+
          '<p style="font-size:12px;color:var(--muted-foreground);margin:4px 0 0">'+
            xesc(t.plant||"")+' · '+xesc(t.vertical||"")+' · '+sevBadge+' '+stBadge+
          '</p>'+
        '</div>'+
        '<button class="btn" style="border:none;color:var(--muted-foreground)" onclick="document.getElementById(\'cc-upd-ovl\').remove()">'+closeIc+'</button>'+
        '</div>'+
        '<div class="modal-b">'+
          '<div style="font-size:12.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted-foreground);margin-bottom:6px">Who should we ask?</div>'+
          rowsHtml+
          '<div class="field" style="margin-top:16px"><span class="lbl">Message (optional)</span>'+
            '<textarea id="cc-upd-msg" class="txt" rows="2" placeholder="e.g. What\'s the site status — part arrived?"></textarea>'+
          '</div>'+
          '<div style="font-size:12.5px;color:var(--muted-foreground);margin-top:10px;line-height:1.5">'+
            'They get a bell notification and a full-screen ring if logged in. The flag clears when they post a progress note.'+
          '</div>'+
        '</div>'+
        '<div class="modal-f">'+
          '<button class="btn o" onclick="document.getElementById(\'cc-upd-ovl\').remove()">Cancel</button>'+
          '<button class="btn p" onclick="ccRequestUpdateSubmit(\''+xesc(t.id)+'\')">Send request</button>'+
        '</div>'+
      '</div>';
    document.body.appendChild(o);
  };

  /* ----------------------------------------------------------------
     5 · "Ask site" button — uses plant.siteEngineer (not derived)
     ---------------------------------------------------------------- */
  function injectAskSiteButtons(){
    var role = S._roleLabel || S.currentRole || "";
    if(/^(Client|Vendor)/.test(role)) return;
    var rows = document.querySelectorAll('.content tr[data-act="issue"]');
    rows.forEach(function(tr){
      var id = tr.getAttribute("data-id");
      var t = (S.issues||[]).find(function(x){return x.id===id});
      if(!t) return;
      if(t.status === "Closed" || t.status === "Resolved") return;
      var tds = tr.querySelectorAll("td");
      if(!tds.length) return;
      var last = tds[tds.length-1];
      var rail = last.querySelector(".row");
      if(!rail) return;
      rail.querySelectorAll(".cc-ask-site").forEach(function(b){ b.remove(); });

      var p = (typeof plantRec === "function") ? plantRec(t.plant) : null;
      var site = p ? plantSiteEngineer(p) : "";
      if(!site || site === me()) return;

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn o sm cc-ask-site";
      btn.innerHTML = "🔔 Ask site";
      btn.title = "Quick ask " + site + " (" + t.plant + ")";
      btn.onclick = function(e){
        e.stopPropagation();
        quickAskSite(id, site, t.plant);
      };
      var regular = rail.querySelector(".cc-wf-ask");
      if(regular) rail.insertBefore(btn, regular);
      else rail.appendChild(btn);
    });
  }

  function quickAskSite(ticketId, siteName, plantName){
    var t = (S.issues||[]).find(function(x){return x.id===ticketId});
    if(!t) return;
    var note = prompt(
      "Ask " + siteName + " (" + plantName + ") for an update on " + t.id + ".\n\n" +
      "Optional message (leave blank for a generic nudge):",
      ""
    );
    if(note === null) return;

    var at = (typeof stampISO === "function") ? stampISO() : new Date().toISOString();
    t.updateRequestedAt   = at;
    t.updateRequestedBy   = me();
    t.updateRequestedFrom = [siteName];
    t.seenAt = null;
    t.seenBy = [];
    t.progress = t.progress || [];
    t.progress.unshift({
      at: at,
      note: "🔔 " + me() + " asked " + siteName + " (site engineer) for an update" +
            (note ? " — " + note : " — please post status"),
      parts: "—", hrs: 0,
      kind: "update_request",
      targets: [siteName]
    });
    if(typeof audit === "function")
      audit("Issues", "Site update requested on "+t.id+" → "+siteName, me(), "—", "Update requested");
    if(typeof emitEvent === "function"){
      emitEvent("update_requested",
        "Site update requested — " + t.id,
        (t.plant||"") + " · for " + siteName + (note ? " · " + note : ""),
        "issue", t.id, "siteupdreq:" + t.id + ":" + at);
    }
    if(typeof persist === "function") persist();
    render();
    if(typeof ccPopup === "function"){
      ccPopup("Site update requested",
              siteName + (note ? " · " + note : " · generic nudge sent"),
              "w", null);
    }
  }

  /* ----------------------------------------------------------------
     6 · Style for the "Ask site" button
     ---------------------------------------------------------------- */
  var st = document.createElement("style");
  st.textContent =
    '.cc-ask-site{background:linear-gradient(135deg,#dbeafe,#bfdbfe)!important;'+
      'border-color:#93c5fd!important;color:#1e40af!important;font-weight:800!important}'+
    '.cc-ask-site:hover{background:linear-gradient(135deg,#bfdbfe,#93c5fd)!important;'+
      'border-color:#60a5fa!important;color:#1e3a8a!important}';
  document.head.appendChild(st);

  /* ----------------------------------------------------------------
     7 · Render hook (last in chain)
     ---------------------------------------------------------------- */
  var orig = render;
  render = function(){
    orig.apply(this, arguments);
    try{ relabelEngineerField(); }catch(e){ console.warn("[TEAM MODEL]", e); }
    try{
      if((S.view === "om-module" && S.omTab === "issues") || S.view === "dashboard"){
        injectAskSiteButtons();
      }
    }catch(e){ console.warn("[TEAM MODEL] ask-site", e); }
    setTimeout(function(){
      try{ relabelEngineerField(); }catch(e){}
      try{
        if((S.view === "om-module" && S.omTab === "issues") || S.view === "dashboard"){
          injectAskSiteButtons();
        }
      }catch(e){}
    }, 40);
  };

  console.log("[TEAM MODEL v3] loaded — Site Engineer fixed per plant · Assignee = O&M team");
})();


