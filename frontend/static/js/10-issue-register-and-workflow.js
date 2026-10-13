"use strict";
/* ================================================================
   ISSUES PAGE — reorder: O&M Issue Register ABOVE the trend chart
   Runs after SMART PORTAL's render wrap, so the register moves
   with its SAVED VIEWS strip intact. Idempotent — safe on every render.
   ================================================================ */
(function(){
  if(window._ccReorderIssues) return;
  window._ccReorderIssues = true;

  function reorder(){
    /* only on the Site Issues tab */
    if(!(S.view==="om-module" && S.omTab==="issues")) return;

    var content = document.querySelector(".content > div");
    if(!content) return;

    var reg = document.getElementById("section-results");
    if(!reg) return;

    /* find the "O&M issue trend" panel by its heading */
    var trend = null;
    var h2s = content.querySelectorAll("h2");
    for(var i=0;i<h2s.length;i++){
      if(/o\s*&\s*m\s+issue\s+trend/i.test(h2s[i].textContent)){
        trend = h2s[i].closest(".panel");
        break;
      }
    }
    if(!trend) return;

    /* already in correct order? (reg before trend) — bail out */
    var pos = reg.compareDocumentPosition(trend);
    if(pos & Node.DOCUMENT_POSITION_FOLLOWING) return;

    /* same parent — move the SAVED VIEWS strip (if present) and then the register,
       both inserted just before the trend panel */
    var parent = trend.parentNode;
    var strip  = content.querySelector(".cc-views-strip");
    if(strip && strip.parentNode === parent){
      parent.insertBefore(strip, trend);
    }
    parent.insertBefore(reg, trend);
  }

  var orig = render;
  render = function(){
    orig.apply(this, arguments);
    try{ reorder(); }catch(e){ console.warn("[CC REORDER ISSUES]", e); }
  };

  console.log("[CC REORDER ISSUES] loaded — register now sits above trend chart");
})();




/* ================================================================
   OPERATIONS WORKFLOW — v1
   A · Request Update (Head → Engineer nudge, 1-tap)
   B · Explicit engineer-on-plant (kill the derived plantEngineer)
   C · Role switcher (Head / Engineer / Technician / Client / Vendor)
   Drop-in: wraps render(), plantEngineer(), saveEditPlant(), saveAddPlant().
   Load AFTER SMART PORTAL v1 and the reorder block.
   ================================================================ */
(function(){
  if(window._ccOpsWorkflow) return;
  window._ccOpsWorkflow = true;

  /* ---------- helpers ---------- */
  function xesc(s){
    return String(s==null?"":s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;").replace(/'/g,"&apos;");
  }
  function nowISO(){ return (typeof stampISO==="function") ? stampISO() : new Date().toISOString(); }
  function hrsAgo(iso){
    if(!iso) return NaN;
    var d = new Date(iso);
    if(isNaN(d.getTime())) return NaN;
    return (Date.now() - d) / 3600000;
  }
  function fmtAgo(iso){
    var h = hrsAgo(iso);
    if(!isFinite(h)) return "";
    if(h < 0) return "just now";
    if(h < 1/60) return "just now";
    if(h < 1) return Math.round(h*60)+"m ago";
    if(h < 24) return Math.floor(h)+"h ago";
    return Math.floor(h/24)+"d ago";
  }

  /* ---------- role model ---------- */
  var ROLES = ["O&M Head","Regional O&M Head","Site Engineer","Technician","Client / Asset Owner","Vendor (limited)"];
  function getRole(){ return S.currentRole || "O&M Head"; }
  function getUser(){ return S.currentUser || (typeof OM_HEAD!=="undefined" ? OM_HEAD : "Arun Agarwal"); }
  function isHead(){ return /^O&M Head$|^Regional/.test(getRole()); }
  function isEngineer(){ return /^Site Engineer$/.test(getRole()); }
  function isTech(){ return /^Technician$/.test(getRole()); }
  function isClient(){ return /^Client/.test(getRole()); }
  function isVendor(){ return /^Vendor/.test(getRole()); }
  function isField(){ return isEngineer() || isTech(); }

  /* restore role across reloads */
  if(typeof loadK==="function"){
    S.currentRole = loadK("currentRole", S.currentRole || "O&M Head");
    S.currentUser = loadK("currentUser", S.currentUser || (typeof OM_HEAD!=="undefined"?OM_HEAD:"Arun Agarwal"));
  }

  /* ================================================================
     B · EXPLICIT ENGINEER ON PLANT
     Stored in S.plantEnrich[code].assignedEngineer — survives Supabase
     reloads because plantEnrich is a separate persisted key.
     ================================================================ */
  function engCode(p){
    return (typeof normalizeSiteCode==="function")
      ? normalizeSiteCode(p.id)
      : String(p.id||"").toUpperCase();
  }
  function explicitEngineer(p){
    if(!p) return "";
    var en = S.plantEnrich || {};
    var entry = en[engCode(p)];
    return (entry && entry.assignedEngineer) || "";
  }
  function setExplicitEngineer(plantId, name){
    var code = (typeof normalizeSiteCode==="function")
      ? normalizeSiteCode(plantId)
      : String(plantId||"").toUpperCase();
    S.plantEnrich = S.plantEnrich || {};
    S.plantEnrich[code] = Object.assign({}, S.plantEnrich[code] || {});
    if(name) S.plantEnrich[code].assignedEngineer = name;
    else delete S.plantEnrich[code].assignedEngineer;
  }

  /* wrap plantEngineer — explicit wins, derived history is the fallback */
  var origPlantEngineer = window.plantEngineer;
  if(typeof origPlantEngineer === "function"){
    window.plantEngineer = function(p){
      var explicit = explicitEngineer(p);
      if(explicit) return explicit;
      return origPlantEngineer.apply(this, arguments);
    };
  }

  /* wrap saveAddPlant + saveEditPlant to persist the new field */
  var origSaveEditPlant = window.saveEditPlant;
  if(typeof origSaveEditPlant === "function"){
    window.saveEditPlant = async function(id){
      var engEl = document.getElementById("pf-engineer");
      var hadField = !!engEl;
      var eng = engEl ? (engEl.value||"").trim() : "";
      var rv = await origSaveEditPlant.apply(this, arguments);
      if(hadField){
        setExplicitEngineer(id, eng);
        if(typeof persist==="function") persist();
        try { render(); } catch(e){}
      }
      return rv;
    };
  }
  var origSaveAddPlant = window.saveAddPlant;
  if(typeof origSaveAddPlant === "function"){
    window.saveAddPlant = async function(){
      var engEl = document.getElementById("pf-engineer");
      var codeEl = document.getElementById("pf-code");
      var hadField = !!engEl;
      var eng = engEl ? (engEl.value||"").trim() : "";
      var code = codeEl ? (codeEl.value||"").trim() : "";
      var rv = await origSaveAddPlant.apply(this, arguments);
      if(hadField && code){
        setExplicitEngineer(code, eng);
        if(typeof persist==="function") persist();
        try { render(); } catch(e){}
      }
      return rv;
    };
  }

  /* inject the engineer dropdown into the Add/Edit plant modal */
  function injectEngineerField(){
    if(S.modal!=="addPlant" && S.modal!=="editPlant") return;
    if(document.getElementById("pf-engineer")) return;
    var ac = document.getElementById("pf-ac");
    var acField = ac ? ac.closest(".field") : null;
    var row = acField ? acField.parentNode : null;
    if(!row) return;
    var current = "";
    if(S.modal==="editPlant" && S.modalCtx && S.modalCtx.id){
      var p = (S.plants||[]).find(z=>z.id===S.modalCtx.id);
      if(p) current = explicitEngineer(p);
    }
    var opts = (typeof TEAM_POOL!=="undefined" ? TEAM_POOL : []);
    var newRow = document.createElement("div");
    newRow.className = "row";
    newRow.style.gap = "12px";
    newRow.innerHTML =
      '<div class="field" style="flex:1">'+
        '<span class="lbl">Assigned engineer (explicit)</span>'+
        '<select id="pf-engineer" class="inp">'+
          '<option value="">— derive from history —</option>'+
          opts.map(function(n){
            return '<option value="'+xesc(n)+'"'+(n===current?' selected':'')+'>'+xesc(n)+'</option>';
          }).join("")+
        '</select>'+
        '<span style="font-size:10.5px;color:var(--muted-foreground);margin-top:2px;display:block">'+
          'Takes precedence over the derived assignment (most tickets on this plant). Clear it to fall back to auto.'+
        '</span>'+
      '</div>'+
      '<div style="flex:1"></div>';
    row.parentNode.insertBefore(newRow, row.nextSibling);
  }

  /* ================================================================
     A · REQUEST UPDATE — Head → Engineer nudge
     ================================================================ */
  window.ccRequestUpdate = function(ticketId){
    var t = (S.issues||[]).find(function(x){return x.id===ticketId});
    if(!t) return;
    if(!t.assignee){
      if(typeof toast==="function") toast("Assign this ticket to an engineer first — nobody to nudge.");
      return;
    }
    var by = getUser();
    var note = prompt(
      "Update request — "+t.id+" assigned to "+t.assignee+".\n"+
      "Add an optional message (leave blank for a generic nudge):",
      ""
    ) || "";
    t.updateRequestedAt = nowISO();
    t.updateRequestedBy = by;
    t.seenAt = null;
    t.seenBy = null;
    t.progress = t.progress || [];
    t.progress.unshift({
      at: t.updateRequestedAt,
      note: "🔔 Update requested by " + by + (note ? " — " + note : " — please post status"),
      parts: "—", hrs: 0,
      kind: "update_request"
    });
    if(typeof audit==="function") audit("Issues", "Update requested on "+t.id, by, "—", "Update requested");
    if(typeof emitEvent==="function"){
      emitEvent(
        "update_requested",
        "Update requested — " + t.id,
        (t.plant||"") + " · " + t.assignee + (note ? " · " + note : ""),
        "issue", t.id, "updreq:" + t.id + ":" + t.updateRequestedAt
      );
    }
    if(typeof persist==="function") persist();
    render();
    if(typeof ccPopup==="function") ccPopup("Update requested", t.assignee + (note ? " · " + note : " · generic nudge sent"), "w", null);
  };

  window.ccMarkSeen = function(ticketId){
    var t = (S.issues||[]).find(function(x){return x.id===ticketId});
    if(!t) return;
    var by = getUser();
    t.seenAt = nowISO();
    t.seenBy = by;
    t.progress = t.progress || [];
    t.progress.unshift({
      at: t.seenAt,
      note: "👀 " + by + " acknowledged",
      parts: "—", hrs: 0,
      kind: "seen"
    });
    if(typeof persist==="function") persist();
    render();
    if(typeof toast==="function") toast("Marked seen — "+t.assignee+"'s queue is up to date.");
  };

  /* hook addProgress so posting a note clears the update-requested flag */
  var origAddProgress = window.addProgress;
  if(typeof origAddProgress === "function"){
    window.addProgress = function(){
      var ctxId = (S.modalCtx||{}).id;
      var rv = origAddProgress.apply(this, arguments);
      var t = (S.issues||[]).find(function(x){return x.id===ctxId});
      if(t && t.updateRequestedAt){
        t.updateRequestedAt = null;
        t.updateRequestedBy = null;
        if(typeof persist==="function") persist();
        try{ render(); }catch(e){}
      }
      return rv;
    };
  }

  /* ================================================================
     C · ROLE SWITCHER
     ================================================================ */
  window.ccSwitchRole = function(newRole){
    if(ROLES.indexOf(newRole) < 0) return;
    var prev = getRole();
    if(prev === newRole) return;
    S.currentRole = newRole;

    if(newRole === "O&M Head" || newRole === "Regional O&M Head" || newRole === "Client / Asset Owner"){
      S.currentUser = (typeof OM_HEAD!=="undefined" ? OM_HEAD : "Arun Agarwal");
    } else if(newRole === "Site Engineer" || newRole === "Technician"){
      var who = S.workWho || "";
      if(!who){
        var pool = (typeof TEAM_POOL!=="undefined" ? TEAM_POOL : []);
        var pick = prompt(
          "Which engineer are you viewing as?\n" + pool.join(", "),
          pool[0] || ""
        );
        who = (pick || pool[0] || "Engineer").trim();
      }
      S.currentUser = who;
      /* filter defaults — visible as a clearable chip in ACTIVE FILTERS */
      S.issF = (typeof blankIssF==="function")
        ? blankIssF({assignee: who})
        : Object.assign({}, S.issF||{}, {assignee: who});
      S.tablePages = S.tablePages||{};
      S.tablePages.issues = 1;
    } else if(newRole === "Vendor (limited)"){
      S.currentUser = "Vendor";
    }

    if(typeof saveK==="function"){
      saveK("currentRole", S.currentRole);
      saveK("currentUser", S.currentUser);
    }
    if(typeof persist==="function") persist();
    render();
    if(typeof ccPopup==="function"){
      ccPopup("Role: " + newRole,
        S.currentUser + " · permissions now " + (isHead() ? "full portfolio" : "restricted"),
        "i", null);
    }
  };

  /* action gates — wrap the mutating actions and enforce role */
  function gateHead(fnName, label){
    var orig = window[fnName];
    if(typeof orig !== "function") return;
    window[fnName] = function(){
      if(!isHead()){
        if(typeof toast==="function") toast("Only O&M Head can "+label+".");
        return;
      }
      return orig.apply(this, arguments);
    };
  }
  gateHead("omHeadMoveTicket", "change ticket stage");
  gateHead("ccDirectClose",    "close a ticket directly");
  gateHead("approveHandover",  "approve a handover");
  gateHead("ccBatchClose",     "bulk close tickets");

  /* role switcher in the topbar */
  function injectRoleSwitcher(){
    /* Legacy role-switcher compatibility code; production identity enforcement removes it. */
    var topbar = document.querySelector(".topbar");
    if(!topbar) return;
    if(topbar.querySelector("#cc-role-switch")) return;
    var anchor = topbar.querySelector(".tb-av");
    if(!anchor) return;
    var holder = anchor.closest(".row");
    if(!holder) return;
    var wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:6px;margin-right:6px";
    wrap.innerHTML =
      '<span style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted-foreground);white-space:nowrap">Test role</span>'+
      '<select id="cc-role-switch" class="inp" style="width:170px" onchange="ccSwitchRole(this.value)">'+
        ROLES.map(function(r){
          return '<option value="'+xesc(r)+'"'+(r===getRole()?' selected':'')+'>'+xesc(r)+'</option>';
        }).join("")+
      '</select>';
    holder.parentNode.insertBefore(wrap, holder);
  }

  /* ================================================================
     ROW + DRAWER INJECTIONS
     ================================================================ */

  /* flag next to the SLA badge + a small button in the Action cell */
  function injectRowWorkflow(){
    var rows = document.querySelectorAll('#section-results tr[data-act="issue"]');
    rows.forEach(function(tr){
      if(tr.getAttribute("data-cc-wf")) return;
      tr.setAttribute("data-cc-wf","1");
      var id = tr.getAttribute("data-id");
      var t = (S.issues||[]).find(function(x){return x.id===id});
      if(!t) return;
      var tds = tr.querySelectorAll("td");
      if(!tds.length) return;
      var first = tds[0];
      var last = tds[tds.length-1];

      /* 1 · flag next to the SLA badge (SMART PORTAL puts it in a flex div) */
      var slaEl = first.querySelector(".cc-sla");
      var host = slaEl && slaEl.parentNode ? slaEl.parentNode : first;
      if(t.updateRequestedAt && !t.seenAt && !host.querySelector(".cc-wf-flag")){
        var f = document.createElement("span");
        f.className = "cc-wf-flag";
        f.title = "Requested by "+(t.updateRequestedBy||"")+" at "+t.updateRequestedAt;
        f.textContent = "⏳ Update requested " + fmtAgo(t.updateRequestedAt);
        host.appendChild(f);
      } else if(t.seenAt && !host.querySelector(".cc-wf-flag")){
        var f2 = document.createElement("span");
        f2.className = "cc-wf-flag seen";
        f2.title = "Seen by "+(t.seenBy||"")+" at "+t.seenAt;
        f2.textContent = "👀 Seen " + fmtAgo(t.seenAt);
        host.appendChild(f2);
      }

      /* 2 · action button appended to the existing Action rail */
      var rail = last.querySelector(".row");
      if(!rail){
        rail = document.createElement("div");
        rail.className = "row";
        rail.style.cssText = "gap:4px;flex-wrap:wrap";
        last.appendChild(rail);
      }
      if(rail.querySelector(".cc-wf-btn")) return;

      if(isHead() && t.status!=="Closed" && t.status!=="Resolved" && t.assignee){
        var ask = document.createElement("button");
        ask.type = "button";
        ask.className = "btn o sm cc-wf-btn";
        ask.innerHTML = "🔔 Ask";
        ask.title = "Request an update from " + t.assignee;
        ask.onclick = function(e){ e.stopPropagation(); ccRequestUpdate(t.id); };
        rail.appendChild(ask);
      }
      if((isEngineer()||isTech()) && t.assignee === getUser() && !t.seenAt && t.status!=="Closed" && t.status!=="Resolved"){
        var seen = document.createElement("button");
        seen.type = "button";
        seen.className = "btn o sm cc-wf-btn";
        seen.innerHTML = "👀 Seen";
        seen.title = "Mark as seen — clears the flag for the Head";
        seen.onclick = function(e){ e.stopPropagation(); ccMarkSeen(t.id); };
        rail.appendChild(seen);
      }
    });
  }

  /* drawer footer buttons */
  function injectDrawerWorkflow(){
    if(S.modal!=="ticket") return;
    var foot = document.querySelector(".modal .modal-f");
    if(!foot) return;
    if(foot.querySelector("#cc-wf-drawer")) return;
    var id = (S.modalCtx||{}).id;
    var t = (S.issues||[]).find(function(x){return x.id===id});
    if(!t) return;
    var wrap = document.createElement("div");
    wrap.id = "cc-wf-drawer";
    wrap.style.cssText = "display:flex;gap:6px;margin-right:auto;flex-wrap:wrap;align-items:center";
    var html = "";
    if(isHead() && t.status!=="Closed" && t.status!=="Resolved" && t.assignee){
      html += '<button type="button" class="btn o sm" onclick="ccRequestUpdate(\''+xesc(t.id)+'\')">🔔 Request update</button>';
    }
    if((isEngineer()||isTech()) && t.assignee === getUser() && !t.seenAt){
      html += '<button type="button" class="btn o sm" onclick="ccMarkSeen(\''+xesc(t.id)+'\')">👀 Mark seen</button>';
    }
    if(t.updateRequestedAt && !t.seenAt){
      html += '<span class="cc-wf-flag">⏳ Update requested '+xesc(fmtAgo(t.updateRequestedAt))+' by '+xesc(t.updateRequestedBy||"")+'</span>';
    }
    wrap.innerHTML = html;
    if(html) foot.insertBefore(wrap, foot.firstChild);
  }

  /* sidebar visibility per role */
  function applyRoleVisibility(){
    var links = document.querySelectorAll(".side-link");
    var hideNonHead  = ["Settings","Data / Imports"];
    var hideField    = ["Reports","Performance"];
    var hideClient   = ["Work / Assignments","Extra Services","Data / Imports","Settings"];
    var hideVendor   = ["Work / Assignments","Preventive Maintenance","Extra Services","Data / Imports","Settings"];
    links.forEach(function(a){
      var txt = (a.textContent||"").trim();
      var hide = false;
      if(!isHead() && hideNonHead.some(function(s){return txt.indexOf(s)===0})) hide = true;
      if(isField() && hideField.some(function(s){return txt.indexOf(s)===0})) hide = true;
      if(isClient() && hideClient.some(function(s){return txt.indexOf(s)===0})) hide = true;
      if(isVendor() && hideVendor.some(function(s){return txt.indexOf(s)===0})) hide = true;
      a.style.display = hide ? "none" : "";
    });
  }

  /* ================================================================
     STYLES
     ================================================================ */
  var style = document.createElement("style");
  style.textContent = [
    '.cc-wf-btn{font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:6px;cursor:pointer;font-family:inherit;line-height:1.4}',
    '.cc-wf-btn:hover{filter:brightness(.95)}',
    '.cc-wf-flag{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:6px;background:var(--warning-soft);color:var(--warning-strong);border:1px solid #fcd34d;white-space:nowrap}',
    '.cc-wf-flag.seen{background:var(--info-soft);color:var(--info);border-color:#bfdbfe}',
    '#cc-role-switch{background:var(--surface-subtle);font-size:12px;padding:6px 8px}'
  ].join("");
  document.head.appendChild(style);

  /* ================================================================
     RENDER HOOK
     ================================================================ */
  var origRender = render;
  render = function(){
    origRender.apply(this, arguments);
    try{ ccAfterRenderOps(); }catch(e){ console.warn("[OPS WORKFLOW] post-render", e); }
  };

  function ccAfterRenderOps(){
    applyRoleVisibility();
    injectRoleSwitcher();
    if(S.view==="om-module" && S.omTab==="issues") injectRowWorkflow();
    if(S.view==="dashboard") injectRowWorkflow();
    if(S.modal==="ticket") injectDrawerWorkflow();
    if(S.modal==="addPlant" || S.modal==="editPlant") injectEngineerField();
  }

  console.log("[OPS WORKFLOW] v1 loaded · role switcher · request-update · explicit engineer · role gates");
})();


/* ================================================================
   OPS WORKFLOW — compact mode: hide row flags
   Register stays clean; the flag lives only in the ticket drawer.
   Load AFTER the OPS WORKFLOW block.
   ================================================================ */
(function(){
  if(window._ccOpsCompact) return;
  window._ccOpsCompact = true;

  var style = document.createElement("style");
  style.textContent =
    /* hide flags on register rows */
    '#section-results tr .cc-wf-flag{display:none!important}' +
    /* keep the flag visible inside the modal drawer */
    '.modal .cc-wf-flag{display:inline-flex!important}';
  document.head.appendChild(style);

  console.log("[OPS WORKFLOW] compact mode — row flags hidden, drawer flags kept");
})();



/* ================================================================
   OPS WORKFLOW — v2
   · 🔔 Ask button on EVERY open ticket (not just assigned, not just Head)
   · Dialog-driven: pick assignee, site engineer, or both
   · O&M team can ask — no assignee-only restriction
   · Row flags stay hidden; drawer flag stays visible
   Load AFTER OPS WORKFLOW v1.
   ================================================================ */
(function(){
  if(window._ccOpsV2) return;
  window._ccOpsV2 = true;

  function xesc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;")}
  function nowISO(){return (typeof stampISO==="function")?stampISO():new Date().toISOString()}
  function getUser(){return S.currentUser || (typeof OM_HEAD!=="undefined"?OM_HEAD:"Arun Agarwal")}
  function getRole(){return S.currentRole || "O&M Head"}
  function isClient(){return /^Client/.test(getRole())}
  function isVendor(){return /^Vendor/.test(getRole())}
  function canAsk(){return !isClient() && !isVendor()}

  /* ---------- dialog-driven Ask for update ---------- */
  window.ccRequestUpdate = function(ticketId){
    var t = (S.issues||[]).find(function(x){return x.id===ticketId});
    if(!t) return;

    var assignee = t.assignee || "";
    var plant = (typeof plantRec==="function") ? plantRec(t.plant) : null;
    var siteEng = (plant && typeof plantEngineer==="function") ? plantEngineer(plant) : "";

    var seenNames = {};
    var targets = [];
    function addTarget(key, name, role){
      if(!name) return;
      var n = String(name).trim();
      if(!n || seenNames[n]) return;
      seenNames[n] = 1;
      targets.push({key:key, name:n, role:role});
    }
    addTarget("assignee", assignee, "Assignee — currently owns this ticket");
    addTarget("siteEngineer", siteEng, "Site engineer — " + (plant ? plant.name : (t.plant||"")));

    if(!targets.length){
      if(typeof toast==="function") toast("No assignee and no site engineer on file — assign the ticket first.");
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
      return '<label class="row" style="gap:10px;font-size:13px;font-weight:500;padding:10px 4px;border-bottom:1px solid var(--border);cursor:pointer;align-items:flex-start">'+
        '<input type="checkbox" name="cc-upd-target" value="'+xesc(tgt.key)+'" data-name="'+xesc(tgt.name)+'" checked style="margin-top:3px"/>'+
        '<div><div style="font-weight:600">'+xesc(tgt.name)+'</div>'+
        '<div style="font-size:11px;color:var(--muted-foreground);margin-top:1px">'+xesc(tgt.role)+'</div></div>'+
      '</label>';
    }).join("");

    var sev = (typeof badge==="function") ? badge(t.severity) : xesc(t.severity);
    var st  = (typeof badge==="function") ? badge(t.status)   : xesc(t.status);
    var closeIc = (typeof I!=="undefined" && I.x) ? I.x(18) : "×";

    o.innerHTML =
      '<div class="modal" style="max-width:520px">'+
        '<div class="modal-h"><div>'+
          '<h3 style="font-size:16px;font-weight:600;margin:0">🔔 Ask for update — '+xesc(t.id)+'</h3>'+
          '<p style="font-size:12px;color:var(--muted-foreground);margin:4px 0 0">'+
            xesc(t.plant||"")+' · '+xesc(t.vertical||"")+' · '+sev+' '+st+
          '</p>'+
        '</div>'+
        '<button class="btn" style="border:none;color:var(--muted-foreground)" onclick="document.getElementById(\'cc-upd-ovl\').remove()">'+closeIc+'</button>'+
        '</div>'+
        '<div class="modal-b">'+
          '<div style="font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted-foreground);margin-bottom:6px">Who should we ask?</div>'+
          rowsHtml +
          '<div class="field" style="margin-top:16px"><span class="lbl">Message (optional)</span>'+
            '<textarea id="cc-upd-msg" class="txt" rows="2" placeholder="e.g. Client chasing — any progress on the fan replacement?"></textarea>'+
          '</div>'+
          '<div style="font-size:11.5px;color:var(--muted-foreground);margin-top:10px;line-height:1.5">'+
            'Each recipient gets a notification. The request is logged in the ticket thread and clears automatically when a progress note is posted.'+
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

  window.ccRequestUpdateSubmit = function(ticketId){
    var t = (S.issues||[]).find(function(x){return x.id===ticketId});
    var ov = document.getElementById("cc-upd-ovl");
    if(!t){ if(ov) ov.remove(); return; }

    var cbs = document.querySelectorAll('#cc-upd-ovl input[name="cc-upd-target"]:checked');
    if(!cbs.length){
      if(typeof toast==="function") toast("Pick at least one recipient.");
      return;
    }
    var targets = [];
    cbs.forEach(function(cb){ targets.push(cb.getAttribute("data-name")); });

    var msgEl = document.getElementById("cc-upd-msg");
    var msg = msgEl ? (msgEl.value||"").trim() : "";
    var by = getUser();
    var at = nowISO();

    t.updateRequestedAt = at;
    t.updateRequestedBy = by;
    t.updateRequestedFrom = targets;
    t.seenAt = null;
    t.seenBy = [];
    t.progress = t.progress || [];
    t.progress.unshift({
      at: at,
      note: "🔔 Update requested by "+by+" from "+targets.join(" + ")+(msg?" — "+msg:" — please post status"),
      parts: "—", hrs: 0,
      kind: "update_request",
      targets: targets
    });

    if(typeof audit==="function")
      audit("Issues","Update requested on "+t.id+" → "+targets.join(", "),by,"—","Update requested");

    if(typeof emitEvent==="function"){
      targets.forEach(function(name){
        emitEvent(
          "update_requested",
          "Update requested — "+t.id,
          (t.plant||"")+" · for "+name+(msg?" · "+msg:""),
          "issue", t.id, "updreq:"+t.id+":"+name+":"+at
        );
      });
    }

    if(typeof persist==="function") persist();
    if(ov) ov.remove();
    render();
    if(typeof ccPopup==="function")
      ccPopup("Update requested", targets.join(" + ")+(msg?" · "+msg:" · generic nudge sent"),"w",null);
  };

  /* ---------- multi-target aware seen ---------- */
  window.ccMarkSeen = function(ticketId){
    var t = (S.issues||[]).find(function(x){return x.id===ticketId});
    if(!t) return;
    var by = getUser();
    t.seenBy = Array.isArray(t.seenBy) ? t.seenBy : [];
    if(t.seenBy.indexOf(by) < 0) t.seenBy.push(by);
    t.seenAt = nowISO();
    t.progress = t.progress || [];
    t.progress.unshift({
      at: t.seenAt,
      note: "👀 "+by+" acknowledged the update request",
      parts: "—", hrs: 0,
      kind: "seen"
    });
    if(typeof persist==="function") persist();
    render();
    if(typeof toast==="function") toast("Marked seen — "+by);
  };

  /* ---------- row injector: Ask on every open ticket ---------- */
  function injectRowWorkflowV2(){
    var rows = document.querySelectorAll('.content tr[data-act="issue"]');
    rows.forEach(function(tr){
      var id = tr.getAttribute("data-id");
      var t = (S.issues||[]).find(function(x){return x.id===id});
      if(!t) return;
      var tds = tr.querySelectorAll("td");
      if(!tds.length) return;
      var last = tds[tds.length-1];
      var rail = last.querySelector(".row");
      if(!rail){
        rail = document.createElement("div");
        rail.className = "row";
        rail.style.cssText = "gap:4px;flex-wrap:wrap";
        last.appendChild(rail);
      }

      /* clean up v1's buttons (identified by their distinct titles) */
      rail.querySelectorAll("button").forEach(function(b){
        var ttl = b.getAttribute("title") || "";
        if(ttl.indexOf("Request an update from") === 0) b.remove();
        if(ttl.indexOf("Mark as seen") === 0) b.remove();
      });
      /* clean up v2's own previous buttons so we re-add fresh */
      rail.querySelectorAll(".cc-wf-ask, .cc-wf-seen").forEach(function(b){ b.remove(); });

      var closed = (t.status === "Closed" || t.status === "Resolved");

      /* Ask button — everyone except Client/Vendor, on every open ticket */
      if(canAsk() && !closed){
        var ask = document.createElement("button");
        ask.type = "button";
        ask.className = "btn o sm cc-wf-btn cc-wf-ask";
        ask.innerHTML = "🔔 Ask";
        ask.title = "Request an update — choose recipient";
        ask.onclick = function(e){ e.stopPropagation(); ccRequestUpdate(t.id); };
        rail.appendChild(ask);
      }

      /* Seen button — visible to anyone the request was made to */
      var me = getUser();
      var askedTo = (t.updateRequestedFrom || []).concat(t.assignee ? [t.assignee] : []);
      var iAmTarget = askedTo.indexOf(me) >= 0;
      var alreadySeen = Array.isArray(t.seenBy) ? t.seenBy.indexOf(me) >= 0 : !!t.seenAt;
      if(iAmTarget && !alreadySeen && !closed){
        var seen = document.createElement("button");
        seen.type = "button";
        seen.className = "btn o sm cc-wf-btn cc-wf-seen";
        seen.innerHTML = "👀 Seen";
        seen.title = "Acknowledge — clears the flag for the Head";
        seen.onclick = function(e){ e.stopPropagation(); ccMarkSeen(t.id); };
        rail.appendChild(seen);
      }
    });
  }

  /* ---------- drawer footer buttons ---------- */
  function injectDrawerWorkflowV2(){
    if(S.modal !== "ticket") return;
    var foot = document.querySelector(".modal .modal-f");
    if(!foot) return;
    var old = document.getElementById("cc-wf-drawer");
    if(old) old.remove();

    var id = (S.modalCtx||{}).id;
    var t = (S.issues||[]).find(function(x){return x.id===id});
    if(!t) return;

    var closed = (t.status === "Closed" || t.status === "Resolved");
    var me = getUser();
    var askedTo = (t.updateRequestedFrom || []).concat(t.assignee ? [t.assignee] : []);
    var iAmTarget = askedTo.indexOf(me) >= 0;
    var alreadySeen = Array.isArray(t.seenBy) ? t.seenBy.indexOf(me) >= 0 : !!t.seenAt;

    var html = "";
    if(canAsk() && !closed){
      html += '<button type="button" class="btn o sm" onclick="ccRequestUpdate(\''+xesc(t.id)+'\')">🔔 Ask for update</button>';
    }
    if(iAmTarget && !alreadySeen && !closed){
      html += '<button type="button" class="btn o sm" onclick="ccMarkSeen(\''+xesc(t.id)+'\')">👀 Mark seen</button>';
    }
    if(t.updateRequestedAt && !closed){
      var seenTxt = (Array.isArray(t.seenBy) && t.seenBy.length) ? (" · seen by "+t.seenBy.join(", ")) : "";
      var who = (t.updateRequestedFrom && t.updateRequestedFrom.length) ? t.updateRequestedFrom.join(" + ") : "assignee";
      html += '<span class="cc-wf-flag">⏳ Update requested from '+xesc(who)+seenTxt+'</span>';
    }
    if(!html) return;

    var wrap = document.createElement("div");
    wrap.id = "cc-wf-drawer";
    wrap.style.cssText = "display:flex;gap:6px;margin-right:auto;flex-wrap:wrap;align-items:center";
    wrap.innerHTML = html;
    foot.insertBefore(wrap, foot.firstChild);
  }

  /* ---------- styles ---------- */
  var style = document.createElement("style");
  style.textContent =
    /* hide flags on register + dashboard rows; keep them in the drawer */
    '#section-results tr .cc-wf-flag, .content tr .cc-wf-flag{display:none!important}' +
    '.modal .cc-wf-flag{display:inline-flex!important}' +
    /* Ask button — amber accent so it stands out next to grey buttons */
    '.cc-wf-ask{background:var(--warning-soft)!important;border-color:#fcd34d!important;color:var(--warning-strong)!important}' +
    '.cc-wf-ask:hover{background:#fde68a!important;border-color:var(--warning)!important}' +
    '.cc-wf-seen{background:var(--info-soft)!important;border-color:#bfdbfe!important;color:var(--info)!important}' +
    '.cc-wf-seen:hover{background:#dbeafe!important;border-color:var(--info)!important}';
  document.head.appendChild(style);

  /* ---------- render hook (runs after OPS WORKFLOW v1) ---------- */
  var origRender = render;
  render = function(){
    origRender.apply(this, arguments);
    try{
      if(S.view==="om-module" && S.omTab==="issues") injectRowWorkflowV2();
      if(S.view==="dashboard") injectRowWorkflowV2();
      if(S.modal==="ticket") injectDrawerWorkflowV2();
    }catch(e){ console.warn("[OPS WORKFLOW v2]", e); }
  };

  console.log("[OPS WORKFLOW v2] loaded — Ask on every ticket, dialog-driven multi-recipient");
})();


