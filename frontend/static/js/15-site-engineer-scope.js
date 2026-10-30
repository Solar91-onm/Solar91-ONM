"use strict";
/* ================================================================
   SITE ENGINEER v1 — single-plant scoping
   · Site Engineer is a LOCAL role — one plant, not portfolio-wide
   · Prompts for both name and plant when switching
   · Locks plant scope on every render
   · Hides fleet-wide pages
   · O&M Head + Assignee (O&M team) unchanged
   Load after ROLE PICKER blocks, before init();
   ================================================================ */
(function(){
  if(window._ccSiteEngineer) return;
  window._ccSiteEngineer = true;

  function xesc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}

  function isSiteEngineer(){ return S._roleLabel === "Site Engineer"; }
  function sePlant(){ return S._sePlant || ""; }
  function seName(){  return S._seName  || S.currentUser || ""; }
  function plantByName(n){
    return (S.plants||[]).find(function(p){return p.name === n})
        || (S.plants||[]).find(function(p){return String(p.name).toLowerCase() === String(n).toLowerCase()});
  }

  /* ----------------------------------------------------------------
     1 · Override ccSwitchRole for the "Site Engineer" case
     Prompts for BOTH name and plant, sets everything, then bails
     (never touches the label-tweak wrapper — cleaner)
     ---------------------------------------------------------------- */
  var prevSwitch = window.ccSwitchRole;
  window.ccSwitchRole = function(label){
    if(label !== "Site Engineer"){
      return prevSwitch.apply(this, arguments);
    }

    var pool   = (typeof TEAM_POOL !== "undefined" ? TEAM_POOL : []);
    var plants = (S.plants||[]).map(function(p){return p.name});
    if(!plants.length){
      if(typeof toast === "function") toast("No plants on file yet — cannot assign a Site Engineer.");
      return;
    }

    var rememberedName  = (S._pickByRole && S._pickByRole["Site Engineer"]) || S.currentUser || pool[0] || "";
    var rememberedPlant = sePlant() || plants[0];

    var pickName = prompt("Viewing as Site Engineer — who?\n" + pool.join(", "), rememberedName);
    if(pickName === null) return;
    var name = (pickName || pool[0] || "Engineer").trim();

    var pickPlant = prompt(
      "Which plant does " + name + " work at?\nPaste or type one of:\n" + plants.join("\n"),
      rememberedPlant
    );
    if(pickPlant === null) return;
    var matched = plantByName((pickPlant || plants[0]).trim());
    if(!matched){
      if(typeof toast === "function") toast('Plant "' + pickPlant + '" not found.');
      return;
    }

    /* commit */
    S._roleLabel = "Site Engineer";
    S._readOnly  = false;
    S.currentRole = "Site Engineer";
    S.currentUser = name;
    S._seName  = name;
    S._sePlant = matched.name;
    S._pickByRole = S._pickByRole || {};
    S._pickByRole["Site Engineer"] = name;

    /* scope everything to their plant */
    S.issF       = (typeof blankIssF === "function") ? blankIssF({plant: matched.name}) : {plant: matched.name};
    S.schedScope = matched.name;
    S.washPlant  = matched.name;
    S.dashPlant  = matched.name;
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
              name + " · " + matched.name + " · single-plant view",
              "i", null);
    }
  };

  /* restore persisted state on boot */
  try{
    S._sePlant = (typeof loadK === "function") ? loadK("sePlant", null) : null;
    S._seName  = (typeof loadK === "function") ? loadK("seName",  null) : null;
  }catch(e){}

  /* ----------------------------------------------------------------
     2 · Plant scope is locked — any attempt to change it is rejected
     ---------------------------------------------------------------- */
  var origSetPlantScope = window.setPlantScope;
  if(typeof origSetPlantScope === "function"){
    window.setPlantScope = function(v){
      if(isSiteEngineer() && sePlant() && v !== sePlant()){
        if(typeof toast === "function") toast("Site Engineer is scoped to " + sePlant() + " — cannot change plant.");
        render();
        return;
      }
      return origSetPlantScope.apply(this, arguments);
    };
  }

  /* ----------------------------------------------------------------
     3 · Enforce BEFORE orig render (fix the data model)
        Enforce AFTER render (fix the DOM: sidebar, banner, selector)
     ---------------------------------------------------------------- */
  function enforceBefore(){
    if(!isSiteEngineer()) return;
    var p = sePlant();
    if(!p) return;

    /* Force every scope field back to their plant */
    if(!S.issF) S.issF = (typeof blankIssF === "function") ? blankIssF() : {};
    if(S.issF.plant !== p) S.issF.plant = p;
    if(S.dashPlant !== p)  S.dashPlant = p;
    if(S.schedScope !== p) S.schedScope = p;
    if(S.washPlant !== p)  S.washPlant = p;

    /* Bounce off fleet-wide pages */
    if(["work","data","settings"].indexOf(S.view) >= 0){
      S.view = "dashboard";
    }
    if(S.view === "om-module" && S.omTab === "handover"){
      S.omTab = "issues";
    }
    /* Redirect plant list view to their plant detail page */
    if(S.view === "plants"){
      var mine = plantByName(p);
      if(mine){ S.view = "plant"; S.plantId = mine.id; }
    }
    /* If they landed on a plant detail page that isn't theirs, swap it */
    if(S.view === "plant"){
      var mine2 = plantByName(p);
      var cur = (S.plants||[]).find(function(x){return x.id === S.plantId});
      if(mine2 && (!cur || cur.id !== mine2.id)) S.plantId = mine2.id;
    }
  }

  function enforceAfter(){
    if(!isSiteEngineer()) return;
    var p = sePlant();
    if(!p) return;

    /* Hide fleet-wide sidebar links */
    var hide = [
      "Work / Assignments",
      "Data / Imports",
      "Settings",
      "Project Handover",
      "Extra Services"
    ];
    document.querySelectorAll(".side-link").forEach(function(a){
      var txt = (a.textContent || "").trim();
      var off = hide.some(function(h){ return txt.indexOf(h) === 0 });
      a.style.display = off ? "none" : "";
    });

    /* Rename the "Plants" link to "My Plant" and re-point it */
    document.querySelectorAll(".side-link").forEach(function(a){
      var span = a.querySelector("span");
      if(!span) return;
      if(span.textContent === "Plants" || span.textContent === "My Plant"){
        span.textContent = "My Plant";
        a.setAttribute("onclick","");
        a.onclick = function(e){
          e.preventDefault();
          var p2 = plantByName(sePlant());
          if(p2 && typeof openPlantPage === "function") openPlantPage(p2.id);
        };
      }
    });

    /* Hide "+ Add Plant" / "New plant" / "+ Add Column" everywhere */
    document.querySelectorAll(".btn").forEach(function(btn){
      var t = (btn.textContent || "").trim();
      if(/^Add Plant$/i.test(t)
       || /^New plant \(commissioning\)$/i.test(t)
       || /^Add Column$/i.test(t)){
        btn.style.display = "none";
      }
    });

    /* Replace the topbar plant selector with a locked pill */
    var scopeSel = document.querySelector('.topbar select.inp[onchange*="setPlantScope"]');
    if(scopeSel && !scopeSel.getAttribute("data-se-locked")){
      scopeSel.setAttribute("data-se-locked","1");
      scopeSel.disabled = true;
      scopeSel.style.opacity = "0.85";
      scopeSel.style.cursor  = "not-allowed";
      scopeSel.innerHTML = '<option selected>' + xesc(p) + '</option>';
      scopeSel.setAttribute("title", "Site Engineer — locked to " + p);
    }

    /* Info banner at top of every page */
    var content = document.querySelector(".content > div");
    if(content && !content.querySelector("#se-banner")){
      var b = document.createElement("div");
      b.id = "se-banner";
      b.className = "bn-info banner";
      b.style.marginBottom = "6px";
      b.innerHTML = "🏠 <b>Site Engineer view</b> — " + xesc(seName()) +
                    " · scoped to <b>" + xesc(p) + "</b> · fleet-wide pages are hidden";
      content.insertBefore(b, content.firstChild);
    }
  }

  /* ----------------------------------------------------------------
     4 · render hook — before/after pattern (no re-render loop)
     ---------------------------------------------------------------- */
  var orig = render;
  render = function(){
    try{ enforceBefore(); }catch(e){ console.warn("[SITE ENGINEER] before", e); }
    orig.apply(this, arguments);
    try{ enforceAfter(); }catch(e){ console.warn("[SITE ENGINEER] after", e); }
    setTimeout(function(){ try{ enforceAfter(); }catch(e){} }, 40);
  };

  console.log("[SITE ENGINEER v1] loaded — single-plant scoping, fleet pages hidden");
})();

/* ================================================================
   SITE ENGINEER v2 — single-plant scoping (replaces v1)
   · Prompts for name + plant when switching
   · Bootstrap: if role is already "Site Engineer" but no plant set,
     prompts immediately instead of showing everything
   · HIDES the Plants module entirely (not renamed)
   · Locks the plant filter chip so it can't be cleared
   · Hides fleet-wide pages and buttons
   · O&M Head + Assignee (O&M team) untouched
   ================================================================ */
(function(){
  if(window._ccSiteEngineerV2) return;
  window._ccSiteEngineerV2 = true;

  function xesc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}

  function isSiteEngineer(){ return S._roleLabel === "Site Engineer"; }
  function sePlant(){ return S._sePlant || ""; }
  function seName(){  return S._seName  || S.currentUser || ""; }
  function plantByName(n){
    return (S.plants||[]).find(function(p){return p.name === n})
        || (S.plants||[]).find(function(p){return String(p.name).toLowerCase() === String(n).toLowerCase()});
  }

  /* ----------------------------------------------------------------
     Helper: commit Site Engineer selection
     ---------------------------------------------------------------- */
  function commitSiteEngineer(name, plant){
    S._roleLabel  = "Site Engineer";
    S._readOnly   = false;
    S.currentRole = "Site Engineer";
    S.currentUser = name;
    S._seName     = name;
    S._sePlant    = plant;
    S._pickByRole = S._pickByRole || {};
    S._pickByRole["Site Engineer"] = name;

    /* scope everything to their plant */
    S.issF       = (typeof blankIssF === "function") ? blankIssF({plant: plant}) : {plant: plant};
    S.schedScope = plant;
    S.washPlant  = plant;
    S.dashPlant  = plant;
    S.tablePages = S.tablePages || {};
    S.tablePages.issues    = 1;
    S.tablePages.plants    = 1;
    S.tablePages.scheduled = 1;
    S.tablePages.washing   = 1;

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
  }

  /* ----------------------------------------------------------------
     Helper: fall back to O&M Head (used on cancel / bad input)
     ---------------------------------------------------------------- */
  function fallbackToHead(reason){
    S._roleLabel  = "O&M Head";
    S._readOnly   = false;
    S.currentRole = "O&M Head";
    S.currentUser = (typeof OM_HEAD !== "undefined" ? OM_HEAD : "Arun Agarwal");
    S._sePlant = null;
    S._seName  = null;
    if(S.issF) S.issF.plant = "all";
    S.dashPlant = "all"; S.schedScope = "all";
    try{
      if(typeof saveK === "function"){
        saveK("roleLabel", S._roleLabel);
        saveK("currentRole", S.currentRole);
        saveK("currentUser", S.currentUser);
        saveK("sePlant", null);
      }
    }catch(e){}
    if(reason && typeof toast === "function") toast(reason);
    render();
  }

  /* ----------------------------------------------------------------
     1 · Override ccSwitchRole for "Site Engineer"
     ---------------------------------------------------------------- */
  var prevSwitch = window.ccSwitchRole;
  window.ccSwitchRole = function(label){
    if(label !== "Site Engineer"){
      return prevSwitch.apply(this, arguments);
    }

    var pool   = (typeof TEAM_POOL !== "undefined" ? TEAM_POOL : []);
    var plants = (S.plants||[]).map(function(p){return p.name});
    if(!plants.length){
      if(typeof toast === "function") toast("No plants on file yet — cannot assign a Site Engineer.");
      return;
    }

    var rememberedName  = (S._pickByRole && S._pickByRole["Site Engineer"]) || S.currentUser || pool[0] || "";
    var rememberedPlant = sePlant() || plants[0];

    var pickName = prompt("Viewing as Site Engineer — who?\n" + pool.join(", "), rememberedName);
    if(pickName === null){ fallbackToHead(); return; }
    var name = (pickName || pool[0] || "Engineer").trim();

    var pickPlant = prompt(
      "Which plant does " + name + " work at?\nType or paste one of:\n\n" + plants.join("\n"),
      rememberedPlant
    );
    if(pickPlant === null){ fallbackToHead(); return; }
    var matched = plantByName((pickPlant || plants[0]).trim());
    if(!matched){
      fallbackToHead('Plant "' + pickPlant + '" not found — reverted to O&M Head.');
      return;
    }

    commitSiteEngineer(name, matched.name);
    render();

    if(typeof ccPopup === "function"){
      ccPopup("Viewing as: Site Engineer",
              name + " · " + matched.name + " · single-plant view",
              "i", null);
    }
  };

  /* ----------------------------------------------------------------
     2 · Bootstrap: if already Site Engineer with no plant, force prompt
     ---------------------------------------------------------------- */
  function bootstrapSE(){
    if(!isSiteEngineer()) return;
    if(sePlant()) return;
    var plants = (S.plants||[]).map(function(p){return p.name});
    if(!plants.length) return;

    /* If we already showed the prompt this session, don't loop */
    if(S._sePrompted) return;
    S._sePrompted = true;

    var remembered = seName() || (typeof OM_HEAD !== "undefined" ? OM_HEAD : "");
    var pickName = prompt(
      "Site Engineer session detected but no plant is set.\n\nWho are you?\n" +
      ((typeof TEAM_POOL !== "undefined") ? TEAM_POOL.join(", ") : ""),
      remembered
    );
    if(pickName === null){ fallbackToHead(); return; }
    var name = (pickName || remembered || "Engineer").trim();

    var pickPlant = prompt(
      "Which plant does " + name + " work at?\nType or paste one of:\n\n" + plants.join("\n"),
      plants[0]
    );
    if(pickPlant === null){ fallbackToHead(); return; }
    var matched = plantByName((pickPlant || plants[0]).trim());
    if(!matched){
      fallbackToHead('Plant "' + pickPlant + '" not found — reverted to O&M Head.');
      return;
    }
    commitSiteEngineer(name, matched.name);
    render();
    if(typeof ccPopup === "function"){
      ccPopup("Site Engineer plant set", name + " · " + matched.name, "i", null);
    }
  }

  /* ----------------------------------------------------------------
     3 · enforceBefore — fix the data model BEFORE the render pass
     ---------------------------------------------------------------- */
  function enforceBefore(){
    if(!isSiteEngineer()) return;
    var p = sePlant();
    if(!p) return;

    if(!S.issF) S.issF = (typeof blankIssF === "function") ? blankIssF() : {};
    if(S.issF.plant !== p) S.issF.plant = p;
    if(S.dashPlant !== p)  S.dashPlant = p;
    if(S.schedScope !== p) S.schedScope = p;
    if(S.washPlant !== p)  S.washPlant = p;

    /* Bounce off fleet-wide views */
    if(["work","data","settings"].indexOf(S.view) >= 0){
      S.view = "dashboard";
    }
    if(S.view === "om-module" && S.omTab === "handover"){
      S.omTab = "issues";
    }
    /* Redirect plants list → their plant detail page */
    if(S.view === "plants"){
      var mine = plantByName(p);
      if(mine){ S.view = "plant"; S.plantId = mine.id; }
    }
    /* If on plant detail, force it to their plant */
    if(S.view === "plant"){
      var mine2 = plantByName(p);
      var cur = (S.plants||[]).find(function(x){return x.id === S.plantId});
      if(mine2 && (!cur || cur.id !== mine2.id)) S.plantId = mine2.id;
    }
  }

  /* ----------------------------------------------------------------
     4 · enforceAfter — fix the DOM AFTER the render pass
     ---------------------------------------------------------------- */
  var HIDE_LINKS = [
    "Plants",              /* hide the Plants module entirely */
    "Work / Assignments",
    "Data / Imports",
    "Settings",
    "Project Handover",
    "Extra Services"
  ];

  function enforceAfter(){
    if(!isSiteEngineer()) return;
    var p = sePlant();
    if(!p) return;

    /* Sidebar: hide fleet-wide links */
    document.querySelectorAll(".side-link").forEach(function(a){
      var span = a.querySelector("span");
      var txt = span ? (span.textContent || "").trim() : "";
      var off = HIDE_LINKS.some(function(h){
        return txt === h || txt.indexOf(h) === 0;
      });
      a.style.display = off ? "none" : "";
    });

    /* Plants module entry buttons on dashboard if any */
    document.querySelectorAll(".btn").forEach(function(btn){
      var t = (btn.textContent || "").trim();
      if(/^Add Plant$/i.test(t)
       || /^New plant \(commissioning\)$/i.test(t)
       || /^Add Column$/i.test(t)){
        btn.style.display = "none";
      }
    });

    /* Hide dashboard "New plant" button in the hero if present */
    document.querySelectorAll(".cc-hero-actions .btn").forEach(function(btn){
      var t = (btn.textContent || "").trim();
      if(/New plant/i.test(t)) btn.style.display = "none";
    });

    /* Lock the topbar plant selector */
    var scopeSel = document.querySelector('.topbar select.inp[onchange*="setPlantScope"]');
    if(scopeSel && !scopeSel.getAttribute("data-se-locked")){
      scopeSel.setAttribute("data-se-locked","1");
      scopeSel.disabled = true;
      scopeSel.style.opacity = "0.9";
      scopeSel.style.cursor  = "not-allowed";
      scopeSel.innerHTML = '<option selected>' + xesc(p) + '</option>';
      scopeSel.setAttribute("title", "Site Engineer — locked to " + p);
    }

    /* Kill the plant filter chip's × so they can't clear it */
    document.querySelectorAll('.panel [data-ccfx="plant"]').forEach(function(btn){
      btn.style.display = "none";
    });

    /* Info banner at top of every page */
    var content = document.querySelector(".content > div");
    if(content && !content.querySelector("#se-banner")){
      var b = document.createElement("div");
      b.id = "se-banner";
      b.className = "bn-info banner";
      b.style.marginBottom = "6px";
      b.innerHTML = "🏠 <b>Site Engineer view</b> — " + xesc(seName()) +
                    " · scoped to <b>" + xesc(p) + "</b> · fleet-wide pages are hidden";
      content.insertBefore(b, content.firstChild);
    }
  }

  /* ----------------------------------------------------------------
     5 · Filter hook — last line of defence
        If any code path tries to load all issues (e.g. Clear All button,
        some notification drill-in), we re-clamp plant back to their own
        before filterIssues runs.
     ---------------------------------------------------------------- */
  var origFilterIssues = window.filterIssues;
  if(typeof origFilterIssues === "function"){
    window.filterIssues = function(list, f){
      if(isSiteEngineer() && sePlant()){
        f = f || S.issF || {};
        if(!f.plant || f.plant === "all") f.plant = sePlant();
      }
      return origFilterIssues.apply(this, arguments);
    };
  }

  /* ----------------------------------------------------------------
     6 · Render hook — before + after, no re-render loop
     ---------------------------------------------------------------- */
  var orig = render;
  render = function(){
    try{ enforceBefore(); }catch(e){ console.warn("[SITE ENGINEER] before", e); }
    orig.apply(this, arguments);
    try{ enforceAfter(); }catch(e){ console.warn("[SITE ENGINEER] after", e); }
    setTimeout(function(){ try{ enforceAfter(); }catch(e){} }, 40);
  };

  /* ----------------------------------------------------------------
     7 · Boot: restore + bootstrap
     ---------------------------------------------------------------- */
  try{
    S._sePlant = (typeof loadK === "function") ? loadK("sePlant", null) : null;
    S._seName  = (typeof loadK === "function") ? loadK("seName",  null) : null;
    var savedLabel = (typeof loadK === "function") ? loadK("roleLabel", null) : null;
    if(savedLabel === "Site Engineer") S._roleLabel = "Site Engineer";
  }catch(e){}

  /* Give the plants list a moment to load, then force the prompt if needed */
  setTimeout(bootstrapSE, 700);

  console.log("[SITE ENGINEER v2] loaded — single-plant scoping, Plants hidden, bootstrap prompt armed");
})();


