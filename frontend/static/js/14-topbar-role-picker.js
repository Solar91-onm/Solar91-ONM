"use strict";
/* ================================================================
   TOPBAR NARROW FIX — protects search width, shrinks selects
   Load after SEARCH FIX, before init().
   ================================================================ */
(function(){
  if(window._ccTopbarFix) return;
  window._ccTopbarFix = true;

  var st = document.createElement("style");
  st.textContent = [
    /* Search wrapper: never collapses below 240px */
    ".topbar > div:nth-child(2){"+
      "flex:1 1 auto!important;"+
      "min-width:240px!important;"+
      "max-width:520px!important"+
    "}",
    ".topbar > div:nth-child(2) > .inp{"+
      "min-width:0!important;width:100%!important"+
    "}",

    /* Plant scope select — narrower */
    '.topbar select.inp[onchange*="setPlantScope"]{'+
      "width:140px!important;min-width:120px!important;"+
      "font-size:12.5px!important;padding:0 10px!important"+
    "}",

    /* Operations date — much shorter (you asked for this) */
    '.topbar input[type="date"]{'+
      "width:118px!important;min-width:112px!important;"+
      "font-size:12px!important;padding:0 8px!important"+
    "}",

    /* LIVE pill — trim the padding */
    ".topbar .live-pill{padding:0 9px!important;font-size:10.5px!important}",

    /* Role switcher — a bit tighter */
    "#cc-role-switch{"+
      "width:150px!important;min-width:130px!important;"+
      "font-size:12px!important;padding:0 10px!important"+
    "}",

    /* Right cluster: allow it to shrink naturally */
    ".topbar > div:last-child{"+
      "flex-shrink:0!important;gap:8px!important"+
    "}",

    /* Below 1180px: let the topbar scroll horizontally instead of crushing the search */
    "@media(max-width:1180px){"+
      ".topbar{overflow-x:auto!important;overflow-y:visible!important;"+
        "-webkit-overflow-scrolling:touch;scrollbar-width:thin}"+
      ".topbar::-webkit-scrollbar{height:5px}"+
      ".topbar::-webkit-scrollbar-thumb{background:#c9d2cd;border-radius:6px}"+
      ".topbar > div:first-child{min-width:120px!important}"+
      ".topbar > div:nth-child(2){flex:0 0 260px!important;max-width:260px!important}"+
    "}",

    /* On real mobile (<900px) hide the long date + live pill; search stays useful */
    "@media(max-width:900px){"+
      ".topbar > div:nth-child(2){flex:1 1 auto!important;min-width:0!important;max-width:none!important}"+
      ".topbar select.inp[onchange*=\"setPlantScope\"]{width:110px!important;min-width:100px!important}"+
    "}",

    /* Dropdown: match the input width, never wrap per-character */
    ".cc-search-drop{"+
      "min-width:280px!important;"+
      "white-space:normal!important"+
    "}",
    ".cc-search-drop .cc-sd-item b,"+
    ".cc-search-drop .cc-sd-item span{"+
      "white-space:nowrap!important;"+
      "overflow:hidden!important;"+
      "text-overflow:ellipsis!important"+
    "}"
  ].join("");
  document.head.appendChild(st);

  /* Force a real width on the input element itself, in case any upstream
     CSS with higher specificity is squeezing it. Runs on every render. */
  function enforce(){
    var topbar = document.querySelector(".topbar");
    if(!topbar) return;
    var inputs = topbar.querySelectorAll("input.inp");
    for(var i=0;i<inputs.length;i++){
      var el = inputs[i];
      if(el.getAttribute("data-cc-search") === "1" || /^Search/i.test(el.placeholder || "")){
        var w = el.parentNode.getBoundingClientRect().width;
        if(w > 0 && w < 220){
          el.parentNode.style.minWidth = "240px";
          el.parentNode.style.flex = "1 1 240px";
          el.style.width = "100%";
        }
        break;
      }
    }
    /* shorten date + scope every render in case they're re-created */
    var d = topbar.querySelector('input[type="date"]');
    if(d){ d.style.width = "118px"; d.style.minWidth = "112px"; }
    var s = topbar.querySelector('select.inp[onchange*="setPlantScope"]');
    if(s){ s.style.width = "140px"; s.style.minWidth = "120px"; }
    var r = document.getElementById("cc-role-switch");
    if(r){ r.style.width = "150px"; r.style.minWidth = "130px"; }
  }

  var orig = render;
  render = function(){
    orig.apply(this, arguments);
    try{ enforce(); }catch(e){}
    setTimeout(function(){ try{ enforce(); }catch(e){} }, 60);
  };

  setTimeout(enforce, 400);

  console.log("[TOPBAR NARROW FIX] loaded — search guarded, date + scope trimmed");
})();


/* ================================================================
   ROLE PICKER v2 — O&M Head · Assignee · Administration · Site Engineer
   Overrides the OPS WORKFLOW v1/v3 role list without touching them.
   Load LAST, right before init();
   ================================================================ */
(function(){
  if(window._ccRolePicker2) return;
  window._ccRolePicker2 = true;

  function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}

  /* Labels shown in the dropdown, in order */
  var LABELS = ["O&M Head","Assignee","Administration","Site Engineer"];

  /* Label → behaviour map
       role     : internal role string v1's isHead/isEngineer helpers look at
       readOnly : Administration sees everything but can't mutate
       pickUser : prompt for a person before switching (field roles)
  */
  var MAP = {
    "O&M Head":      { role:"O&M Head",      readOnly:false, pickUser:false },
    "Assignee":      { role:"Assignee",      readOnly:false, pickUser:true  },
    "Administration": { role:"Administration", readOnly:true,  pickUser:false },
    "Site Engineer": { role:"Site Engineer", readOnly:false, pickUser:true  }
  };

  function currentLabel(){
    if(S._roleLabel && LABELS.indexOf(S._roleLabel) >= 0) return S._roleLabel;
    var r = S.currentRole || "O&M Head";
    if(/Site Engineer|Technician/.test(r)) return "Site Engineer";
    return "O&M Head";
  }

  /* ---- rebuild the dropdown options ---- */
  function rebuildSelect(){
    var sel = document.getElementById("cc-role-switch");
    if(!sel) return;
    var want = currentLabel();
    var sig = "cc-role-picker-v2:" + want;
    if(sel.getAttribute("data-cc-sig") === sig) return;
    sel.setAttribute("data-cc-sig", sig);
    sel.innerHTML = LABELS.map(function(l){
      return '<option value="'+esc(l)+'"'+(l===want?' selected':'')+'>'+esc(l)+'</option>';
    }).join("");
  }

  /* ---- switch handler ---- */
  window.ccSwitchRole = function(label){
    var m = MAP[label];
    if(!m) return;

    var prevLabel = currentLabel();
    S._roleLabel = label;
    S._readOnly  = !!m.readOnly;

    if(label !== prevLabel || m.pickUser){
      if(m.pickUser){
        var pool = (typeof TEAM_POOL !== "undefined" ? TEAM_POOL : []);
        var remembered = (S._pickByRole && S._pickByRole[label]) || S.currentUser || pool[0] || "";
        var pick = prompt(
          "Viewing as " + label + " — who?\n" + pool.join(", "),
          remembered
        );
        if(pick === null){ S._roleLabel = prevLabel; rebuildSelect(); return; }
        var who = (pick || pool[0] || "Engineer").trim();
        S._pickByRole = S._pickByRole || {};
        S._pickByRole[label] = who;
        S.currentUser = who;
        S.issF = (typeof blankIssF === "function")
          ? blankIssF({assignee: who})
          : Object.assign({}, S.issF||{}, {assignee: who});
        S.tablePages = S.tablePages || {};
        S.tablePages.issues = 1;
      } else {
        S.currentUser = (typeof OM_HEAD !== "undefined" ? OM_HEAD : "Arun Agarwal");
        /* clear engineer scope filter when leaving a field role */
        if(S.issF && S.issF.assignee && S.issF.assignee !== "all"){
          S.issF.assignee = "all";
        }
      }
      S.currentRole = m.role;
    }

    if(typeof saveK === "function"){
      saveK("currentRole", S.currentRole);
      saveK("currentUser", S.currentUser);
      saveK("roleLabel",   S._roleLabel);
      saveK("readOnly",    S._readOnly);
    }
    if(typeof persist === "function") persist();
    render();

    if(typeof ccPopup === "function"){
      var sub = S.currentUser + (m.readOnly ? " · read-only executive view" : "");
      ccPopup("Viewing as: " + label, sub, "i", null);
    }
  };

  /* ---- restore persisted label on boot ---- */
  try{
    var saved = (typeof loadK === "function") ? loadK("roleLabel", null) : null;
    if(saved && LABELS.indexOf(saved) >= 0){
      S._roleLabel  = saved;
      S._readOnly   = !!MAP[saved].readOnly;
      S.currentRole = MAP[saved].role;
    } else {
      S._roleLabel  = currentLabel();
      S._readOnly   = false;
    }
  }catch(e){ S._roleLabel = "O&M Head"; S._readOnly = false; }

  /* ---- read-only gate for Administration ---- */
  function verb(name){
    return name.replace(/([A-Z])/g," $1").trim().toLowerCase();
  }
  function gate(fnName){
    var orig = window[fnName];
    if(typeof orig !== "function") return;
    window[fnName] = function(){
      if(S._readOnly){
        if(typeof toast === "function") toast("Read-only view — Administration cannot " + verb(fnName) + ".");
        return;
      }
      return orig.apply(this, arguments);
    };
  }
  ["createTicket","createTask","assignTicket","resolveTicket","verifyTicket","reopenTicket",
   "ackTicket","startTicket","pendingTicket","resumeTicket","addProgress","washTable","bulkWash",
   "logException","ccDirectClose","ccBatchClose","ccBatchAssign","ccRequestUpdate","ccMarkSeen",
   "omHeadMoveTicket","approveHandover","saveEditPlant","saveAddPlant","completeTask",
   "reassignTask","startItem","submitItem","verifyItem","rejectItem","naItem",
   "approvePTW","closePTW","reportIncident","createInventory","createVendor","createDocument",
   "createSLA","renewDoc","reorder","approveESR","changeESR","verifyESR","bumpESR",
   "maybeHandoverReady","reopenItems"]
   .forEach(gate);

  /* ---- render hook (outermost — runs after OPS WORKFLOW's own pass) ---- */
  var orig = render;
  render = function(){
    orig.apply(this, arguments);
    try{ rebuildSelect(); }catch(e){ console.warn("[ROLE PICKER]", e); }
    setTimeout(function(){ try{ rebuildSelect(); }catch(e){} }, 50);
  };

  /* boot pass */
  setTimeout(rebuildSelect, 300);

  console.log("[ROLE PICKER v2] loaded — O&M Head · Assignee · Administration · Site Engineer");
})();

/* ================================================================
   ROLE PICKER v2 — labelling clarifier
   Assignee = O&M team member. Rewrites the two strings the picker
   shows when switching, nothing else.
   ================================================================ */
(function(){
  if(window._ccRoleLabelTweak) return;
  window._ccRoleLabelTweak = true;

  /* 1 · overlay the switch handler with clearer messaging */
  var baseSwitch = window.ccSwitchRole;
  if(typeof baseSwitch === "function"){
    window.ccSwitchRole = function(label){
      var isAssignee = (label === "Assignee" || label === "Site Engineer");

      if(isAssignee){
        /* bespoke prompt — names the role properly */
        var pool = (typeof TEAM_POOL !== "undefined" ? TEAM_POOL : []);
        var remembered = (S._pickByRole && S._pickByRole[label]) || S.currentUser || pool[0] || "";
        var pick = prompt(
          (label === "Assignee"
            ? "Viewing as O&M team member — who?\n"
            : "Viewing as Site Engineer — who?\n") +
          pool.join(", "),
          remembered
        );
        if(pick === null){ return; }              /* user cancelled */
        var who = (pick || pool[0] || "Engineer").trim();

        /* now delegate to the base handler without it re-prompting */
        var origPrompt = window.prompt;
        window.prompt = function(){ return who; };
        try{ baseSwitch(label); }
        finally{ window.prompt = origPrompt; }

        /* enrich the confirmation popup */
        if(typeof ccPopup === "function"){
          ccPopup(
            label === "Assignee" ? "Viewing as: O&M Team" : "Viewing as: Site Engineer",
            who + " · field view · can raise, progress, resolve tickets",
            "i", null
          );
        }
        return;
      }

      /* O&M Head + Administration go straight through */
      baseSwitch(label);

      /* re-brand their popups with clearer wording */
      if(typeof ccPopup === "function"){
        if(label === "O&M Head"){
          ccPopup("Viewing as: O&M Head",
            (typeof OM_HEAD !== "undefined" ? OM_HEAD : "Arun Agarwal") + " · full portfolio permissions",
            "i", null);
        } else if(label === "Administration"){
          ccPopup("Viewing as: Administration",
            "Read-only executive view — dashboards & reports only",
            "i", null);
        }
      }
    };
  }

  /* 2 · tiny label under the dropdown so the meaning is obvious */
  var st = document.createElement("style");
  st.textContent =
    /* widen the role switcher slightly so "Site Engineer" doesn't clip */
    "#cc-role-switch{width:165px!important;min-width:150px!important}";
  document.head.appendChild(st);

  /* 3 · add a one-time helper row inside the picker's popup area
        (fires on every switch, so users always know what each role means) */
  function decorate(){
    var sel = document.getElementById("cc-role-switch");
    if(!sel) return;
    if(sel.getAttribute("data-cc-hint") === "1") return;
    sel.setAttribute("data-cc-hint","1");
    sel.title =
      "O&M Head — full control\n" +
      "Assignee — O&M team member (raise / progress / resolve)\n" +
      "Administration — read-only executive view\n" +
      "Site Engineer — field engineer (same as Assignee, different label)";
  }
  var orig = render;
  render = function(){
    orig.apply(this, arguments);
    setTimeout(decorate, 30);
  };
  setTimeout(decorate, 400);

  console.log("[ROLE PICKER] Assignee clarified as O&M team member");
})();


