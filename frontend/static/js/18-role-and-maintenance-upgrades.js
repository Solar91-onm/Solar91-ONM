"use strict";
/* ================================================================
   REV08 — INTERNAL ROLE SET + SITE ENGINEER MODULE LOCK + PHOTO EVIDENCE
   External Client / Asset Owner and Vendor test roles were removed.
   Site Engineer can see only the plant dashboard, Site Issues and Preventive Maintenance.
   ================================================================ */
(function(){
  var INTERNAL_ROLES=["O&M Head","Assignee","Administration","Site Engineer"];

  function sanitizePrototypeRole(){
    var r=S._roleLabel||S.currentRole||"O&M Head";
    if(INTERNAL_ROLES.indexOf(r)<0){
      S._roleLabel="O&M Head";
      S.currentRole="O&M Head";
      S.currentUser=(typeof OM_HEAD!=="undefined"?OM_HEAD:"Arun Agarwal");
      S._readOnly=false;
      S._sePlant=null;
      S._seName=null;
      try{saveK("currentRole",S.currentRole);saveK("currentUser",S.currentUser);saveK("roleLabel",S._roleLabel);saveK("readOnly",false)}catch(e){}
    }
  }

  function enforceSiteEngineerModules(){
    if(rev05Role()!=="Site Engineer")return;
    var allowed=["Plants dashboard","My Plant","Site Issues","Preventive Maintenance","Washing","Photo Intelligence","Operations Calendar"];
    document.querySelectorAll(".side-link").forEach(function(a){
      var sp=a.querySelector("span"),txt=(sp?sp.textContent:a.textContent||"").trim();
      a.style.display=allowed.some(function(x){return txt===x||txt.indexOf(x)===0})?"":"none";
    });
    document.querySelectorAll(".mnav > div").forEach(function(d){
      var txt=(d.textContent||"").replace(/\d+/g,"").trim();
      if(txt==="More"){d.style.display="";return}
      var map={Home:"Plants dashboard",Dashboard:"Plants dashboard","Plants table":"Plants","My Plant":"My Plant",Plants:"Plants",Issues:"Site Issues",Preventive:"Preventive Maintenance",Planned:"Preventive Maintenance",Work:"Work / Assignments",Reports:"Reports",Photos:"Photo Intelligence"};
      var lab=map[txt]||txt;
      d.style.display=allowed.some(function(x){return lab===x||lab.indexOf(x)===0})?"":"none";
    });
    if(S.view==="performance"||S.view==="reports"||S.view==="work"||S.view==="plants"||S.view==="data"||S.view==="settings"){
      S.view="dashboard";
    }
    if(S.view==="om-module"&&["handover","services","analytics"].indexOf(S.omTab)>=0){
      S.omTab="issues";
    }
  }

  sanitizePrototypeRole();
  var prevRender=render;
  render=function(){
    sanitizePrototypeRole();
    prevRender.apply(this,arguments);
    try{enforceSiteEngineerModules()}catch(e){console.warn("[REV07 Site Engineer modules]",e)}
    setTimeout(function(){try{enforceSiteEngineerModules()}catch(e){}},80);
  };
})();


(function(){
 const css=document.createElement("style");css.textContent=
  '.sched-photo-card{border:1px solid #bfe5cc;background:linear-gradient(135deg,#fff,#f3fff7);border-radius:13px;padding:13px;margin:10px 0 12px;box-shadow:0 4px 14px rgba(12,94,42,.05)}'+
  '.sched-photo-card.compact{padding:10px}.sched-photo-title{font-size:12.5px;font-weight:800;color:var(--foreground);display:flex;align-items:center;gap:7px;flex-wrap:wrap}.sched-photo-sub{font-size:12px;color:var(--muted-foreground);margin-top:3px}.sched-photo-proof{font-size:12px;font-weight:700;color:var(--primary);white-space:nowrap}'+
  '.sched-photo-grid{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.sched-photo-thumb{width:92px;padding:0;border:1px solid var(--border);border-radius:9px;background:#fff;overflow:hidden;cursor:pointer;text-align:left;box-shadow:0 2px 8px rgba(16,24,20,.05)}.sched-photo-thumb:hover{border-color:var(--primary);transform:translateY(-1px)}.sched-photo-thumb img{width:92px;height:66px;display:block;object-fit:cover}.sched-photo-thumb span{display:block;padding:5px 6px;font-size:11px;font-weight:700;color:var(--muted-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sched-photo-more{display:grid;place-items:center;min-width:64px;height:66px;border:1px dashed var(--border);border-radius:9px;color:var(--muted-foreground);font-size:12px;font-weight:700;margin-top:0}'+
  '.sched-photo-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.sched-photo-upload{position:relative;overflow:hidden;cursor:pointer}.sched-photo-upload input{position:absolute;inset:0;opacity:0;cursor:pointer;font-size:0}.sched-photo-empty{font-size:12.5px;color:var(--muted-foreground);padding:12px 0 2px}.sched-photo-readonly{font-size:12.5px;color:var(--muted-foreground);margin-top:8px}.active-sched-thumb .sched-photo-grid{margin-top:4px}.active-sched-thumb .sched-photo-thumb{width:36px}.active-sched-thumb .sched-photo-thumb img{width:36px;height:30px}.active-sched-thumb .sched-photo-thumb span{display:none}.active-sched-thumb .sched-photo-more{height:30px;min-width:34px}'+
  '@media(max-width:700px){.sched-photo-thumb{width:78px}.sched-photo-thumb img{width:78px;height:58px}.sched-photo-proof{white-space:normal;width:100%}.sched-photo-actions .btn{flex:1;justify-content:center;min-width:120px}}';
 document.head.appendChild(css);
})();

/* ================================================================
   REV12 — PROBLEM-BASED SCHEDULED O&M TASK CREATOR
   Inspired by the Site Issues Vertical -> Problem flow.
   Creator roles: O&M Head and Assignee / O&M Team.
   Site Engineer is explicitly execution-only and cannot create tasks.
   ================================================================ */
(function(){
  const REV12_CREATOR_ROLES=["O&M Head","Assignee"];

  window.scheduledTaskCreatorAllowed=function(){
    const r=(S._roleLabel||S.currentRole||"O&M Head");
    return REV12_CREATOR_ROLES.indexOf(r)>=0;
  };

  function rev12Problems(asset){
    const a=(SUBCATS&&SUBCATS[asset])?SUBCATS[asset].slice():["Other"];
    return a.length?a:["Other"];
  }

  function rev12TaskOptions(asset,problem){
    const base=(TSUB&&TSUB[asset])?TSUB[asset].slice():[];
    const p=String(problem||"").toLowerCase();
    const words=p.split(/[^a-z0-9]+/).filter(x=>x.length>2);
    const scored=base.map(function(s){
      const l=s.toLowerCase(); let score=0;
      words.forEach(w=>{if(l.indexOf(w)>=0)score+=3});
      if(/communication|data|recording|sensor|meter/.test(p)&&/communication|data|sensor|meter|portal|network|recording|validation|reading/.test(l))score+=2;
      if(/fault|trip|breaker|relay|spring|interlock/.test(p)&&/breaker|relay|trip|mechanical|operation|interlock|protection/.test(l))score+=2;
      if(/hot|burn|heating|terminal|connector/.test(p)&&/thermal|terminal|torque|connector|cable|lug|hotspot/.test(l))score+=2;
      if(/oil|leak|bushing|dga|tap/.test(p)&&/oil|leak|bushing|breather|dga|moisture|tap/.test(l))score+=2;
      if(/earth|resistance|loose connection/.test(p)&&/earth|resistance|connection|continuity|tightening/.test(l))score+=2;
      if(/crack|damage|corrosion|foundation|settlement|collapse/.test(p)&&/crack|damage|corrosion|foundation|settlement|structure|visual|patrol/.test(l))score+=2;
      if(/vegetation|shading|fire risk|overgrowth/.test(p)&&/vegetation|shading|grass|weed|fire|clearance|removal/.test(l))score+=2;
      if(/cleaning|water shortage|missed cleaning/.test(p)&&/clean|water|schedule|table|exception/.test(l))score+=2;
      return {s,score};
    }).sort((a,b)=>b.score-a.score);
    const out=[];
    out.push("Inspect & diagnose — "+problem);
    scored.slice(0,4).forEach(x=>{if(out.indexOf(x.s)<0)out.push(x.s)});
    out.push("Preventive rectification — "+problem);
    out.push("Post-maintenance functional verification");
    return out;
  }

  window.rev12RefreshProblemTask=function(){
    const assetEl=document.getElementById("pst-asset"),problemEl=document.getElementById("pst-problem"),taskEl=document.getElementById("pst-action");
    if(!assetEl||!problemEl||!taskEl)return;
    const asset=assetEl.value;
    const old=problemEl.value;
    const probs=rev12Problems(asset);
    problemEl.innerHTML=probs.map(x=>'<option value="'+esc(x)+'"'+(x===old?' selected':'')+'>'+esc(x)+'</option>').join("");
    if(probs.indexOf(problemEl.value)<0)problemEl.value=probs[0];
    rev12RefreshTaskOptions();
  };

  window.rev12RefreshTaskOptions=function(){
    const assetEl=document.getElementById("pst-asset"),problemEl=document.getElementById("pst-problem"),taskEl=document.getElementById("pst-action"),preview=document.getElementById("pst-preview");
    if(!assetEl||!problemEl||!taskEl)return;
    const asset=assetEl.value,problem=problemEl.value;
    const opts=rev12TaskOptions(asset,problem);
    taskEl.innerHTML=opts.map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join("")+'<option value="__custom">Other / custom task</option>';
    if(preview){
      const checks=(TSUB&&TSUB[asset])?TSUB[asset]:[];
      preview.innerHTML=checks.length?checks.map(x=>'<span class="rev12-check">✓ '+esc(x)+'</span>').join(""):'<span class="muted">No standard checklist configured.</span>';
    }
    rev12ToggleCustom();
  };

  window.rev12ToggleCustom=function(){
    const a=document.getElementById("pst-action"),row=document.getElementById("pst-custom-row");
    if(row)row.style.display=(a&&a.value==="__custom")?"grid":"none";
  };

  window.openProblemScheduledTask=function(){
    if(!scheduledTaskCreatorAllowed()){
      toast("Site Engineer can execute assigned Preventive Maintenance work, but cannot create Preventive Maintenance work orders.");
      return;
    }
    S.modal="problemScheduledTask";S.modalCtx={};render();
  };

  window.createProblemScheduledTask=async function(){
 const role=(S._roleLabel||S.currentRole||"O&M Head");
 if(REV12_CREATOR_ROLES.indexOf(role)<0){toast("Site Engineer does not have permission to add Preventive Maintenance tasks.");return;}
 const plantName=document.getElementById("pst-plant")?.value||"";
 const plant=(S.plants||[]).find(p=>p.name===plantName||p.id===plantName);
 const asset=document.getElementById("pst-asset")?.value||"Other";
 const problem=document.getElementById("pst-problem")?.value||"Other";
 const actSel=document.getElementById("pst-action")?.value||"";
 const custom=document.getElementById("pst-custom")?.value.trim()||"";
 const action=actSel==="__custom"?custom:actSel;
 const equip=document.getElementById("pst-equip")?.value.trim()||"—";
 const freq=document.getElementById("pst-freq")?.value||"Monthly";
 const due=document.getElementById("pst-due")?.value||addDays(TODAY,3);
 const assignee=document.getElementById("pst-assignee")?.value||TEAM_POOL[0]||"O&M Team";
 const safety=document.getElementById("pst-safety")?.value||"—";
 const sop=document.getElementById("pst-sop")?.value.trim()||("PM-"+asset.toUpperCase().replace(/[^A-Z0-9]+/g,"-").replace(/^-|-$/g,"")+"-01");
 if(!plant){toast("Select a valid plant.");return} if(!problem){toast("Select the maintenance problem / condition.");return} if(!action){toast("Select or enter the scheduled task action.");return}
 const name=asset+" — "+problem+" — "+action;
 try{
  const t=await apiFetch('/api/scheduled/tasks/problem',{method:'POST',body:{plant_id:plant.dbId||plant.id,asset:asset,problem:problem,task_name:name,equipment_ref:equip,frequency:freq,due_on:due,assignee:assignee,sop:sop,safety:safety,tools:'Standard toolkit',duration:'4 hrs'}});
  S.tasks.unshift(t);S.schedScope=plant.name;S.schedF=S.schedF||{};S.schedF.q=t.id;S.tablePages.scheduled=1;S.modal=null;render();toast("Scheduled task created and saved to Supabase PostgreSQL.");
 }catch(e){toast(e.message||'Could not create scheduled task.');}
};

  const oldRenderModal=renderModal;
  renderModal=function(){
    if(S.modal!=="problemScheduledTask")return oldRenderModal.apply(this,arguments);
    if(!scheduledTaskCreatorAllowed()){
      setTimeout(function(){S.modal=null;render()},0);
      return "";
    }
    const first=S.schedScope&&S.schedScope!=="all"?S.schedScope:(S.plants[0]?S.plants[0].name:"");
    const asset=(TASK_TYPES[0]&&TASK_TYPES[0].name)||"Inverter";
    const problem=rev12Problems(asset)[0]||"Other";
    const opts=rev12TaskOptions(asset,problem);
    const checklist=(TSUB[asset]||[]);
    const body='<div class="rev12-problem-task-modal">'+
      '<div class="bn-info banner"><b>Problem → planned task</b> — this uses the same asset/problem language as Site Issues, but creates recurring preventive work instead of a sudden-fault ticket.</div>'+
      '<div class="kgrid" style="grid-template-columns:1fr 1fr;gap:12px">'+
       '<div class="field"><span class="lbl">Plant</span><select id="pst-plant" class="inp">'+S.plants.map(p=>'<option'+(p.name===first?' selected':'')+'>'+esc(p.name)+'</option>').join("")+'</select></div>'+
       '<div class="field"><span class="lbl">Asset / problem area</span><select id="pst-asset" class="inp" onchange="rev12RefreshProblemTask()">'+TASK_TYPES.filter(t=>typeof PM_NOT_IN_PM==="undefined"||PM_NOT_IN_PM.indexOf(t.name)<0).map(t=>'<option>'+esc(t.name)+'</option>').join("")+'</select></div>'+
      '</div>'+
      '<div class="kgrid" style="grid-template-columns:1fr 1fr;gap:12px">'+
       '<div class="field"><span class="lbl">Problem / condition</span><select id="pst-problem" class="inp" onchange="rev12RefreshTaskOptions()">'+rev12Problems(asset).map(x=>'<option>'+esc(x)+'</option>').join("")+'</select></div>'+
       '<div class="field"><span class="lbl">Scheduled task / action</span><select id="pst-action" class="inp" onchange="rev12ToggleCustom()">'+opts.map(x=>'<option>'+esc(x)+'</option>').join("")+'<option value="__custom">Other / custom task</option></select></div>'+
      '</div>'+
      '<div id="pst-custom-row" class="field" style="display:none"><span class="lbl">Custom Preventive Maintenance task</span><input id="pst-custom" class="inp" placeholder="Describe the recurring maintenance action"/></div>'+
      '<div class="field"><span class="lbl">Suggested checklist from '+esc(asset)+'</span><div id="pst-preview" class="rev12-preview">'+checklist.map(x=>'<span class="rev12-check">✓ '+esc(x)+'</span>').join("")+'</div></div>'+
      '<div class="kgrid" style="grid-template-columns:1fr 1fr;gap:12px">'+
       '<div class="field"><span class="lbl">Equipment / asset reference</span><input id="pst-equip" class="inp" placeholder="e.g. INV-03, TR-01, VCB-02"/></div>'+
       '<div class="field"><span class="lbl">Assignee</span><select id="pst-assignee" class="inp">'+TEAM_POOL.map(n=>'<option'+(n===S.currentUser?' selected':'')+'>'+esc(n)+'</option>').join("")+'</select></div>'+
       '<div class="field"><span class="lbl">Frequency</span><select id="pst-freq" class="inp">'+Object.keys(FREQ_MAP).map(f=>'<option'+(f==="Monthly"?' selected':'')+'>'+esc(f)+'</option>').join("")+'</select></div>'+
       '<div class="field"><span class="lbl">First due date</span><input id="pst-due" class="inp" type="date" value="'+addDays(TODAY,3)+'"/></div>'+
       '<div class="field"><span class="lbl">Safety requirement</span><select id="pst-safety" class="inp"><option>—</option><option>PTW required</option><option>LOTO required</option><option>PTW + LOTO required</option></select></div>'+
       '<div class="field"><span class="lbl">SOP reference</span><input id="pst-sop" class="inp" placeholder="Auto-default if blank"/></div>'+
      '</div>'+
      '<div style="font-size:12.5px;color:var(--muted-foreground);margin-top:4px">Creator: <b>'+esc(S.currentUser||OM_HEAD)+'</b> · '+esc(S._roleLabel||S.currentRole||"O&M Head")+' · Site Engineer cannot create this task.</div>'+
    '</div>';
    return modal("Add Preventive Maintenance task — by problem","Choose the same problem category used in Site Issues, then convert it into recurring planned work",body,
      '<button class="btn o" onclick="closeModal()">Cancel</button><button id="rev12-create-problem-task" class="btn p" onclick="createProblemScheduledTask()">'+I.plus(14)+'Create Preventive Maintenance task</button>',true);
  };

  const oldRenderScheduled=renderScheduled;
  renderScheduled=function(){
    let h=oldRenderScheduled.apply(this,arguments);
    if(!scheduledTaskCreatorAllowed())return h;
    const card='<div id="rev12-problem-task-card" class="panel solar-card-glow pm-plan-panel" style="border-left:4px solid var(--primary)">'+
      '<div class="row between wrap" style="gap:12px"><div><div class="kpi-label">ISSUE-INSPIRED PLANNING</div><h2 style="font-size:15px;font-weight:800;margin-top:4px">Add Preventive Maintenance from a known problem</h2><p style="font-size:12px;color:var(--muted-foreground);margin-top:4px;max-width:760px">Select the same Asset → Problem structure used in Site Issues. The system then offers preventive task options, recurrence, due date and assignee.</p></div><button id="rev12-add-problem-task" class="btn p" onclick="openProblemScheduledTask()">'+I.plus(14)+'Add task by problem</button></div>'+
      '<div class="row wrap" style="gap:6px;margin-top:10px"><span class="badge b-info">Asset</span><span>→</span><span class="badge b-warning">Problem</span><span>→</span><span class="badge b-success">Scheduled task</span><span>→</span><span class="badge b-muted">Frequency &amp; assignee</span></div></div>';
    const anchor='<div class="panel pm-setup">';
    if(h.indexOf(anchor)>=0)h=h.replace(anchor,card+anchor);else h=card+h;
    return h;
  };

  function rev12FixCreatorUi(){
    const role=(S._roleLabel||S.currentRole||"O&M Head");
    const allowed=REV12_CREATOR_ROLES.indexOf(role)>=0;
    const btn=document.getElementById("rev12-add-problem-task");if(btn)btn.style.display=allowed?"inline-flex":"none";
    if(role==="Site Engineer"){
      const c=document.getElementById("rev12-problem-task-card");if(c)c.remove();
      if(S.modal==="problemScheduledTask"){S.modal=null;setTimeout(render,0)}
    }
  }

  const oldRender=render;
  render=function(){oldRender.apply(this,arguments);try{rev12FixCreatorUi()}catch(e){console.warn("[REV12 creator UI]",e)}setTimeout(function(){try{rev12FixCreatorUi()}catch(e){}},90)};

  const st=document.createElement("style");
  st.textContent='.rev12-preview{display:flex;gap:6px;flex-wrap:wrap;border:1px solid var(--border);background:var(--surface-subtle);border-radius:10px;padding:9px}.rev12-check{font-size:12px;background:#fff;border:1px solid var(--border);border-radius:999px;padding:4px 8px;color:var(--foreground)}@media(max-width:700px){.rev12-problem-task-modal .kgrid{grid-template-columns:1fr!important}#rev12-add-problem-task{width:100%;justify-content:center}}';
  document.head.appendChild(st);
})();

/* ================================================================
   REV13 — FINAL SITE ENGINEER HARD BOUNDARY
   Site Engineer has exactly three modules:
     1) Command Center
     2) Site Issues
     3) Preventive Maintenance (including Washing as an internal section)
   Everything is locked to the engineer's selected plant.
   This compatibility block runs late so older UI wrappers
   cannot re-introduce fleet navigation or fail silently.
   ================================================================ */
(function(){
  function seRole(){ return (S._roleLabel||S.currentRole||"")==="Site Engineer"; }
  function sePlant(){ return S._sePlant||""; }
  function findPlant(v){
    v=String(v||"").trim();
    return (S.plants||[]).find(function(p){return p.name===v||p.id===v})
      || (S.plants||[]).find(function(p){return String(p.name||"").toLowerCase()===v.toLowerCase()});
  }
  function saveSE(){
    try{
      if(typeof saveK==="function"){
        saveK("currentRole",S.currentRole);saveK("currentUser",S.currentUser);
        saveK("roleLabel",S._roleLabel);saveK("readOnly",false);
        saveK("sePlant",S._sePlant);saveK("seName",S._seName);
      }
      if(typeof persist==="function")persist();
    }catch(e){}
  }
  function commitSiteEngineer(plant){
    if(!plant)return false;
    var configured="";
    try{ if(typeof plantSiteEngineer==="function")configured=plantSiteEngineer(plant)||""; }catch(e){}
    var name=configured || S._seName || ((S.currentUser&&S.currentUser!==OM_HEAD)?S.currentUser:"") || "Site Engineer";
    if(!configured){
      var pick=prompt("Site Engineer name for "+plant.name+":",name);
      if(pick===null)return false;
      name=(pick||"Site Engineer").trim()||"Site Engineer";
    }
    S._roleLabel="Site Engineer";
    S._readOnly=false;
    S.currentRole="Site Engineer";
    S.currentUser=name;
    S._seName=name;
    S._sePlant=plant.name;
    S.dashPlant=plant.name;
    S.schedScope=plant.name;
    S.washPlant=plant.name;
    S.issF=(typeof blankIssF==="function")?blankIssF({plant:plant.name}):Object.assign({},S.issF||{},{plant:plant.name});
    S.issF.plant=plant.name;
    S.issF.site="all";S.issF.project="all";
    S.view="dashboard";
    if(["handover","services","analytics"].indexOf(S.omTab)>=0)S.omTab="issues";
    S.tablePages=S.tablePages||{};
    S.tablePages.issues=S.tablePages.scheduled=S.tablePages.washing=1;
    saveSE();
    return true;
  }
  function chooseSiteEngineer(){
    var plants=S.plants||[];
    if(!plants.length){toast("No plants are available for Site Engineer assignment.");return;}
    var remembered=findPlant(sePlant())||plants[0];
    var list=plants.map(function(p){return p.name}).join("\n");
    var pick=prompt("Viewing as Site Engineer — select ONE plant:\n\n"+list,remembered.name);
    if(pick===null)return;
    var plant=findPlant(pick)||findPlant(remembered.name);
    if(!plant){toast('Plant "'+pick+'" not found.');return;}
    if(commitSiteEngineer(plant)){
      render();
      if(typeof ccPopup==="function")ccPopup("Site Engineer view",S.currentUser+" · "+plant.name+" · Command Center + Site Issues + Preventive Maintenance only","i",null);
      else toast("Site Engineer locked to "+plant.name+".");
    }
  }

  /* Legacy role-switch compatibility hook. Production identity overrides this. */
  var previousSwitch=window.ccSwitchRole;
  window.ccSwitchRole=function(label){
    if(label==="Site Engineer"){ chooseSiteEngineer(); return; }
    if(typeof previousSwitch==="function")return previousSwitch.apply(this,arguments);
  };

  function clampSiteEngineer(){
    if(!seRole())return;
    var p=sePlant();
    if(!p){
      var first=(S.plants||[])[0];
      if(first)commitSiteEngineer(first);
      p=sePlant();
    }
    if(!p)return;

    /* hard data scope */
    S.dashPlant=p;S.schedScope=p;S.washPlant=p;
    S.issF=S.issF||{};S.issF.plant=p;S.issF.site="all";S.issF.project="all";

    /* exact route whitelist */
    if(S.view!=="dashboard"&&S.view!=="om-module"&&S.view!=="photos")S.view="dashboard";
    if(S.view==="om-module"&&["issues","scheduled","washing","calendar"].indexOf(S.omTab)<0)S.omTab="issues";

    /* exact desktop module whitelist */
    var allowed=["Plants dashboard","My Plant","Site Issues","Preventive Maintenance","Washing","Photo Intelligence","Operations Calendar"];
    document.querySelectorAll(".side-link").forEach(function(a){
      var sp=a.querySelector("span"),txt=(sp?sp.textContent:a.textContent||"").trim();
      a.style.display=allowed.indexOf(txt)>=0?"":"none";
    });
    document.querySelectorAll(".side-label").forEach(function(x){
      if((x.textContent||"").trim()!=="Field Operations")x.style.display="none";
    });

    /* exact mobile module whitelist */
    document.querySelectorAll(".mnav > div").forEach(function(d){
      var txt=(d.textContent||"").replace(/\d+/g,"").trim();
      d.style.display=(txt==="Home"||txt==="My Plant"||txt==="Issues"||txt==="Preventive"||txt==="Photos"||txt==="More")?"":"none";
    });

    /* plant control must show only own plant */
    var sel=document.querySelector('.topbar select.inp[onchange*="setPlantScope"]');
    if(sel){
      sel.disabled=true;sel.style.cursor="not-allowed";sel.style.opacity=".86";
      sel.innerHTML='<option selected>'+esc(p)+'</option>';
      sel.title="Site Engineer — locked to "+p;
    }

    /* creator/admin controls stay unavailable */
    var creator=document.getElementById("rev12-problem-task-card");if(creator)creator.remove();
    var addBtn=document.getElementById("rev12-add-problem-task");if(addBtn)addBtn.remove();
  }

  /* Direct navigation cannot bypass the module boundary. */
  var prevGoView=window.goView;
  window.goView=function(v){
    if(seRole()&&v!=="dashboard"&&v!=="photos"){ /* Photo Intelligence is plant-scoped for Site Engineers */
      toast("Site Engineer can access only the plant dashboard, Site Issues and Preventive Maintenance for "+sePlant()+".");
      S.view="dashboard";saveSE();render();return;
    }
    return prevGoView.apply(this,arguments);
  };
  var prevGoTab=window.goTab;
  window.goTab=function(t){
    if(seRole()&&["issues","scheduled","washing","calendar"].indexOf(t)<0){
      toast("This module is not available in Site Engineer view.");
      S.view="om-module";S.omTab="issues";saveSE();render();return;
    }
    if(seRole()){S.dashPlant=sePlant();S.schedScope=sePlant();S.washPlant=sePlant();S.issF=S.issF||{};S.issF.plant=sePlant();}
    return prevGoTab.apply(this,arguments);
  };
  var prevScheduled=window.goScheduledOM;
  if(typeof prevScheduled==="function")window.goScheduledOM=function(part){
    if(seRole()){S.schedScope=sePlant();S.washPlant=sePlant();}
    return prevScheduled.apply(this,arguments);
  };

  /* Render clamp runs before and after every draw. */
  var prevRender=render;
  render=function(){
    clampSiteEngineer();
    prevRender.apply(this,arguments);
    clampSiteEngineer();
    setTimeout(clampSiteEngineer,40);
  };
  setTimeout(function(){clampSiteEngineer();},200);
})();

