"use strict";
/* ================================================================
   SITE ENGINEER v3 — STRICT SCOPE LOCK
   Reinforces v1/v2. Guarantees, for the Site Engineer role only:
     1. Only their plant is visible anywhere
     2. Site Issues → their plant's tickets only
     3. Command Center → scoped to their plant
   Fleet administration stays hidden, but Preventive Maintenance is available for execution
   within the engineer's assigned plant (including Washing).
   Load AFTER SITE ENGINEER v2, BEFORE init();
   ================================================================ */
(function(){
  if(window._ccSiteScopeLock) return;
  window._ccSiteScopeLock = true;

  function xesc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}

  function isSE(){ return S._roleLabel === "Site Engineer"; }
  function seP(){  return S._sePlant || ""; }

  /* ----------------------------------------------------------------
     1 · HIDE list — everything a Site Engineer shouldn't reach
     ---------------------------------------------------------------- */
  var EXTRA_HIDE = [
    "Plants",
    "Work / Assignments",
    "Performance",
    "Reports",
    "Data / Imports",
    "Settings",
    "Project Handover",
    "Extra Services"
  ];

  /* ----------------------------------------------------------------
     2 · Force data model BEFORE the render pass
     ---------------------------------------------------------------- */
  function enforceData(){
    if(!isSE()) return;
    var p = seP(); if(!p) return;

    if(!S.issF) S.issF = (typeof blankIssF==="function") ? blankIssF() : {};
    S.issF.plant   = p;
    S.issF.site    = "all";
    S.issF.project = "all";

    S.dashPlant   = p;
    S.schedScope  = p;
    S.washPlant   = p;
    S.plF         = Object.assign({}, S.plF||{}, { site: p });

    /* Redirect any fleet-wide view */
    if(["work","performance","reports","data","settings"].indexOf(S.view) >= 0){
      S.view = "dashboard";
    }
    if(S.view === "plants"){
      var mine = (S.plants||[]).find(function(x){ return x.name === p; });
      if(mine){ S.view = "plant"; S.plantId = mine.id; }
    }
    if(S.view === "om-module" && ["handover","services","analytics"].indexOf(S.omTab) >= 0){
      S.omTab = "issues";
    }
    if(S.view === "plant"){
      var mine2 = (S.plants||[]).find(function(x){ return x.name === p; });
      var cur = (S.plants||[]).find(function(x){ return x.id === S.plantId; });
      if(mine2 && (!cur || cur.id !== mine2.id)) S.plantId = mine2.id;
    }
  }

  /* ----------------------------------------------------------------
     3 · Intercept filterIssues — hard-clamp to their plant
          This catches Clear All, notification drills, chart clicks, etc.
     ---------------------------------------------------------------- */
  var origFI = window.filterIssues;
  if(typeof origFI === "function"){
    window.filterIssues = function(list, f){
      if(isSE() && seP()){
        var mine = seP();
        var forced = Object.assign({}, f||S.issF||{}, { plant:mine, site:"all", project:"all" });
        var out = origFI.call(this, list, forced);
        return (out||[]).filter(function(t){ return t.plant === mine; });
      }
      return origFI.apply(this, arguments);
    };
  }

  /* ----------------------------------------------------------------
     4 · Intercept setPlantScope — reject any change
     ---------------------------------------------------------------- */
  var origSPS = window.setPlantScope;
  if(typeof origSPS === "function"){
    window.setPlantScope = function(v){
      if(isSE() && seP() && v !== seP()){
        if(typeof toast==="function") toast("Site Engineer is scoped to " + seP() + ".");
        return;
      }
      return origSPS.apply(this, arguments);
    };
  }

  /* ----------------------------------------------------------------
     5 · Intercept drillIssues — clamp instead of widen
     ---------------------------------------------------------------- */
  var origDrill = window.drillIssues;
  if(typeof origDrill === "function"){
    window.drillIssues = function(patch){
      if(isSE() && seP()){
        patch = Object.assign({}, patch||{}, { plant:seP(), site:"all", project:"all" });
      }
      return origDrill.apply(this, arguments);
    };
  }

  /* ----------------------------------------------------------------
     6 · Intercept openPlantPage — reject other plants
     ---------------------------------------------------------------- */
  var origOpenPlant = window.openPlantPage;
  if(typeof origOpenPlant === "function"){
    window.openPlantPage = function(id){
      if(isSE() && seP()){
        var mine = (S.plants||[]).find(function(p){ return p.name === seP(); });
        if(mine && id !== mine.id){
          if(typeof toast==="function") toast("Site Engineer is scoped to " + seP() + ".");
          id = mine.id;
        }
      }
      return origOpenPlant.apply(this, arguments);
    };
  }

  /* ----------------------------------------------------------------
     7 · Intercept openIssue — reject issues on other plants
     ---------------------------------------------------------------- */
  var origOpenIssue = window.openIssue;
  if(typeof origOpenIssue === "function"){
    window.openIssue = function(id){
      if(isSE() && seP()){
        var t = (S.issues||[]).find(function(x){ return x.id === id; });
        if(t && t.plant !== seP()){
          if(typeof toast==="function") toast("That ticket belongs to " + t.plant + " — outside your scope.");
          return;
        }
      }
      return origOpenIssue.apply(this, arguments);
    };
  }

  /* ----------------------------------------------------------------
     8 · Intercept clearAll buttons AND notification drill for non-plant
     ---------------------------------------------------------------- */
  var origNotif = window.actionNotification;
  if(typeof origNotif === "function"){
    window.actionNotification = function(id){
      if(isSE() && seP()){
        if(id === "xl-nr" || id === "xl-low") return;   /* fleet-wide Excel alerts */
      }
      return origNotif.apply(this, arguments);
    };
  }

  /* ----------------------------------------------------------------
     9 · DOM pass AFTER render
     ---------------------------------------------------------------- */
  function enforceDom(){
    if(!isSE()) return;
    var p = seP(); if(!p) return;
    var minePlant = (S.plants||[]).find(function(x){ return x.name === p; });

    /* (a) hide extra fleet-wide sidebar links */
    document.querySelectorAll(".side-link").forEach(function(a){
      var span = a.querySelector("span");
      var txt = span ? (span.textContent||"").trim() : "";
      var off = EXTRA_HIDE.some(function(h){ return txt === h || txt.indexOf(h) === 0; });
      if(off) a.style.display = "none";
    });

    /* (b) lock the topbar plant scope selector */
    var scopeSel = document.querySelector('.topbar select.inp[onchange*="setPlantScope"]');
    if(scopeSel && !scopeSel.getAttribute("data-se3")){
      scopeSel.setAttribute("data-se3","1");
      scopeSel.disabled = true;
      scopeSel.style.opacity = "0.9";
      scopeSel.style.cursor  = "not-allowed";
      scopeSel.innerHTML = '<option>' + xesc(p) + '</option>';
      scopeSel.title = "Locked to " + p;
    }

    /* (c) kill the plant/site/project filter chips */
    document.querySelectorAll('[data-ccfx="plant"],[data-ccfx="site"],[data-ccfx="project"]').forEach(function(b){
      b.style.display = "none";
    });

    /* (d) lock any plant dropdown in filter panels */
    document.querySelectorAll(".content .filter-panel select, .content .panel select").forEach(function(sel){
      var oc = sel.getAttribute("onchange") || "";
      if(oc.indexOf("S.issF.plant") < 0 && oc.indexOf("S.plF") < 0 && oc.indexOf("setPlantScope") < 0 && oc.indexOf("S.schedScope") < 0 && oc.indexOf("S.washPlant") < 0) return;
      if(sel.getAttribute("data-se3-locked")) return;
      sel.setAttribute("data-se3-locked","1");
      sel.disabled = true;
      sel.style.opacity = "0.85";
      /* collapse to just their plant */
      var kept = [];
      Array.prototype.forEach.call(sel.options, function(o){
        if(o.value === "all" || o.value === p || (o.textContent||"").trim() === p){
          kept.push({ v:o.value, t:o.textContent, s:(o.value === p || (o.textContent||"").trim() === p) });
        }
      });
      if(!kept.some(function(k){return k.s;})){
        kept = [{ v:p, t:p, s:true }];
      } else {
        kept = kept.filter(function(k){ return k.v !== "all"; });
      }
      sel.innerHTML = "";
      kept.forEach(function(k){
        var o = document.createElement("option");
        o.value = k.v; o.textContent = k.t; if(k.s) o.selected = true;
        sel.appendChild(o);
      });
    });

    /* (e) override Clear All / Clear filters so plant is preserved */
    document.querySelectorAll(".content button").forEach(function(btn){
      var t = (btn.textContent || "").trim();
      if(t === "Clear all" || t === "Clear filters"){
        if(btn.getAttribute("data-se3-clear")) return;
        btn.setAttribute("data-se3-clear","1");
        btn.onclick = function(e){
          e.preventDefault();
          S.tablePages = S.tablePages || {};
          if(S.omTab==="scheduled"){S.schedF={assignee:"all",status:"all",freq:"all",from:"",to:"",sort:"due",q:""};S.schedScope=p;S.tablePages.scheduled=1;}
          else if(S.omTab==="washing"){S.washF={assignee:"all",status:"all",sort:"days",q:""};S.washPlant=p;S.tablePages.washing=1;}
          else{S.issF = Object.assign({}, S.issF||{}, { plant:p, site:"all", project:"all" });S.tablePages.issues = 1;}
          if(typeof persist==="function") persist();
          if(typeof render==="function") render();
          if(typeof toast==="function") toast("Filters cleared — plant scope locked to " + p + ".");
        };
      }
    });

    /* (f) "Issues by plant" chart — hide all bars except their own */
    document.querySelectorAll('.viz-bar[data-act="barPlant"]').forEach(function(b){
      var id = b.getAttribute("data-id");
      if(minePlant && id !== minePlant.id) b.style.display = "none";
    });

    /* (g) any issue-row table — hide rows from other plants */
    document.querySelectorAll('tr[data-act="issue"][data-id], tr[data-rid]').forEach(function(tr){
      var id = tr.getAttribute("data-id") || tr.getAttribute("data-rid");
      var t = (S.issues||[]).find(function(x){ return x.id === id; });
      if(t && t.plant !== p) tr.style.display = "none";
    });

    /* (h) mobile nav — hide Plants / Work / Reports tiles */
    document.querySelectorAll(".mnav > div").forEach(function(d){
      var txt = (d.textContent||"").trim();
      if(/^Plants$/.test(txt) || /^Reports$/.test(txt) || /^Work$/.test(txt)){
        d.style.display = "none";
      }
    });

    /* (i) topbar search — hide it so nobody can look up other plants */
    var tbSearch = document.querySelector(".topbar > div:nth-child(2)");
    if(tbSearch) tbSearch.style.visibility = "hidden";
  }

  /* ----------------------------------------------------------------
     10 · Render hook — before + after + two settle passes
     ---------------------------------------------------------------- */
  var orig = render;
  render = function(){
    try{ enforceData(); }catch(e){ console.warn("[SE v3] data", e); }
    orig.apply(this, arguments);
    try{ enforceDom(); }catch(e){ console.warn("[SE v3] dom", e); }
    setTimeout(function(){ try{ enforceDom(); }catch(e){} }, 40);
    setTimeout(function(){ try{ enforceDom(); }catch(e){} }, 160);
  };

  /* one boot-time pass */
  setTimeout(function(){ try{ enforceDom(); }catch(e){} }, 600);

  console.log("[SITE ENGINEER v3] loaded — strict single-plant scope, all fleet views hidden");
})();




/* ================================================================
   REV07 — CONSOLIDATED ROLE ACCESS + SCHEDULED O&M UI
   Source rules are preserved; the one deliberate change is that a Site
   Engineer can now execute Preventive Maintenance / Washing for the assigned plant.
   ================================================================ */
var REV05_PERMISSION_MATRIX=[
 {role:"O&M Head",modules:["Full","Full","Full","Full","Full","Full","Full","Full"],scope:"Portfolio"},
 {role:"Assignee",modules:["View","View","Assigned · edit","Assigned · execute","Assigned","Hidden","Assigned items","Field tools / docs"],scope:"Assigned work"},
 {role:"Administration",modules:["Command Center","Hidden","Hidden","Reports","Hidden","Hidden","Hidden","Hidden"],scope:"Portfolio read-only"},
 {role:"Site Engineer",modules:["Plant view","Hidden","Plant · edit","Plant · execute","Hidden","Hidden","Hidden","Hidden"],scope:"Single plant"}
];
function rev05Role(){return S._roleLabel||S.currentRole||"O&M Head"}
function rev05ReadOnly(){return rev05Role()==="Administration"}
function rev05AllowedModules(){
 const m={
  "O&M Head":["Command Center","Plants","Site Issues","Preventive Maintenance","Washing","Work / Assignments","Performance","Reports","Data / Imports","Settings","Project Handover","Extra Services"],
  "Assignee":["Command Center","Plants","Site Issues","Preventive Maintenance","Washing","Work / Assignments","Project Handover","Extra Services"],
  "Administration":["Command Center","Reports"],
  "Site Engineer":["Command Center","Site Issues","Preventive Maintenance","Washing"]
 };
 return m[rev05Role()]||m["O&M Head"];
}
function rev05RebuildRolePicker(){
 const sel=document.getElementById("cc-role-switch");if(!sel)return;
 if(!sel.parentElement.querySelector(".cc-proto-role-badge")){
  const b=document.createElement("span");
  b.className="cc-proto-role-badge";
  b.textContent="Managed";
  b.style.cssText="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--primary);background:var(--secondary);border:1px solid #bfe5cc;border-radius:999px;padding:4px 7px;white-space:nowrap";
  sel.parentElement.appendChild(b);
 }
 const labels=["O&M Head","Assignee","Administration","Site Engineer"],want=rev05Role();
 sel.innerHTML=labels.map(l=>'<option value="'+esc(l)+'"'+(l===want?' selected':'')+'>'+esc(l)+'</option>').join("");
 sel.title="O&M Head — full portfolio and team access\nAssignee — assigned O&M work\nAdministration — read-only Command Center and Reports\nSite Engineer — single-plant Command Center + Site Issues + Preventive Maintenance only";
}
(function(){
 const baseSwitch=window.ccSwitchRole;
 window.ccSwitchRole=function(label){
  if(["O&M Head","Assignee","Administration","Site Engineer"].indexOf(label)<0){
   if(typeof toast==="function")toast("This role is not available in this application.");
   return;
  }
  if(typeof baseSwitch==="function")return baseSwitch.apply(this,arguments);
 };
})();
function rev05ApplyPermissions(){
 const role=rev05Role(),allowed=rev05AllowedModules();
 document.querySelectorAll(".side-link").forEach(a=>{const sp=a.querySelector("span"),txt=(sp?sp.textContent:a.textContent||"").trim();a.style.display=allowed.some(x=>txt===x||txt.indexOf(x)===0)?"":"none"});
 /* Bottom bar: ignore badge counts in the label ("Issues76") and map the short mobile names; "More" lists only role-allowed modules. */
 document.querySelectorAll(".mnav > div").forEach(d=>{const txt=(d.textContent||"").replace(/\d+/g,"").trim(),map={Home:"Command Center","My Plant":"Command Center",Plants:"Plants",Issues:"Site Issues",Preventive:"Preventive Maintenance",Planned:"Preventive Maintenance",Work:"Work / Assignments",Reports:"Reports"};if(txt==="More"){d.style.display="";return}const lab=map[txt]||txt;d.style.display=allowed.some(x=>lab===x||lab.indexOf(x)===0)?"":"none"});
 if(rev05ReadOnly()){
  const mutate=/create|save|delete|remove|assign|reassign|approve|reject|startTask|completeTask|convertToIssue|washTable|bulkWash|logException|import|updateWash|toggleRule|syncQueue|renewDoc|reorder|bumpESR|verifyESR|changeESR|closePTW|reportIncident|omHeadMoveTicket/i;
  document.querySelectorAll(".content button,.modal button").forEach(b=>{const oc=b.getAttribute("onclick")||"",tx=(b.textContent||"").trim();if(mutate.test(oc)||/^(Add|Build|Upload|Create|Start|Complete|Reassign|Approve|Reject|Close ticket|Log |Record renewal|Run now|Sync now|\+ Add)/i.test(tx)){b.style.display="none"}});
  document.querySelectorAll(".content form input,.content form textarea,.content form select,.modal input,.modal textarea,.modal select").forEach(el=>{if(el.closest(".topbar"))return;el.disabled=true;el.style.opacity=".8"});
 }
 if(role==="Assignee"){
  S.schedF=S.schedF||{};S.schedF.assignee=S.currentUser||"all";
 }
 rev05RebuildRolePicker();
}
(function(){
 const oldRender=render;
 render=function(){if(rev05Role()==="Administration"&&S.view!=="dashboard"&&S.view!=="reports")S.view="dashboard";oldRender.apply(this,arguments);try{rev05ApplyPermissions()}catch(e){console.warn("[REV07 permissions]",e)}setTimeout(()=>{try{rev05ApplyPermissions()}catch(e){}},60);setTimeout(()=>{try{rev05ApplyPermissions()}catch(e){}},180)};
})();
(function(){
 const css=document.createElement("style");css.textContent=
  '.sched-donut-grid .panel{min-height:270px}'+
  '.sched-scope-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}'+
  '.sched-scope-card{border:1px solid var(--border);background:var(--card);border-radius:11px;padding:10px 11px;display:grid;grid-template-columns:10px minmax(0,1fr) auto;align-items:center;gap:8px;text-align:left;font:inherit;color:var(--foreground);cursor:pointer;transition:.16s ease}'+
  '.sched-scope-card:hover{border-color:var(--primary);transform:translateY(-1px);box-shadow:var(--shadow-panel)}'+
  '.sched-scope-card.active{border-color:var(--primary);background:var(--secondary);box-shadow:0 0 0 2px rgba(12,94,42,.08)}'+
  '.sched-scope-dot{width:8px;height:8px;border-radius:999px}.sched-scope-name{font-size:12.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis}.sched-scope-card b{font-size:12.5px;color:var(--muted-foreground)}'+
  '@media(max-width:1100px){.sched-scope-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.sched-donut-grid{grid-template-columns:1fr 1fr!important}}'+
  '@media(max-width:700px){.sched-scope-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.sched-donut-grid{grid-template-columns:1fr!important}}';document.head.appendChild(css);
})();
/* Enforce read-only roles at function level as well as in the UI. */
(function(){
 function blockReadonly(name){const fn=window[name];if(typeof fn!=="function")return;window[name]=function(){if(rev05ReadOnly()){toast(rev05Role()+" is read-only for this role.");return}return fn.apply(this,arguments)}}
 ["createTicket","assignTicket","resolveTicket","verifyTicket","reopenTicket","ackTicket","startTicket","pendingTicket","resumeTicket","addProgress","ccDirectClose","ccBatchClose","ccBatchAssign","ccRequestUpdate","ccMarkSeen","approveHandover","saveEditPlant","saveAddPlant","approvePTW","closePTW","reportIncident","createInventory","createVendor","createDocument","createSLA","renewDoc","reorder","approveESR","changeESR","verifyESR","bumpESR"].forEach(blockReadonly);
 function headOnly(name){const fn=window[name];if(typeof fn!=="function")return;window[name]=function(){if(rev05Role()!=="O&M Head"){toast("Only O&M Head can manage the preventive-maintenance schedule.");return}return fn.apply(this,arguments)}}
 ["createTask","reassignTask","saveWashSetup","updateWashSchedule","importCSV","importWashSchedule"].forEach(headOnly);
 const st=window.startTask;if(typeof st==="function")window.startTask=function(id){const t=(S.tasks||[]).find(x=>x.id===id),r=rev05Role();if(r==="Assignee"&&t&&t.assignee!==S.currentUser){toast("This scheduled task is assigned to "+t.assignee+".");return}if(r==="Site Engineer"&&t&&S._sePlant&&t.plant!==S._sePlant){toast("This task is outside your assigned plant.");return}if(rev05ReadOnly()){toast(r+" is read-only.");return}return st.apply(this,arguments)};
 const ct=window.completeTask;if(typeof ct==="function")window.completeTask=function(){const t=(S.tasks||[]).find(x=>x.id===(S.modalCtx||{}).id),r=rev05Role();if(r==="Assignee"&&t&&t.assignee!==S.currentUser){toast("This scheduled task is assigned to "+t.assignee+".");return}if(r==="Site Engineer"&&t&&S._sePlant&&t.plant!==S._sePlant){toast("This task is outside your assigned plant.");return}if(rev05ReadOnly()){toast(r+" is read-only.");return}return ct.apply(this,arguments)};
 ["washTable","bulkWash","logException"].forEach(name=>{const fn=window[name];if(typeof fn!=="function")return;window[name]=function(){const r=rev05Role();if(rev05ReadOnly()){toast(r+" is read-only.");return}if(r==="Site Engineer"&&S._sePlant&&S.washPlant!==S._sePlant){toast("Washing is locked to "+S._sePlant+".");return}return fn.apply(this,arguments)}});
})();
