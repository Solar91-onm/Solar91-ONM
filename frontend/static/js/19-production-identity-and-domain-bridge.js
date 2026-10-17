"use strict";
/* ================================================================
   PRODUCTION IDENTITY + ACCESS ENFORCEMENT
   Role comes only from the verified Clerk identity -> Solar91 users table.
   No browser role selector is an authority mechanism.
   ================================================================ */
(function(){
 function role(){return AUTH_IDENTITY.role||"Viewer"}
 function stripRolePicker(){
  const sel=document.getElementById('cc-role-switch');if(sel){const w=sel.parentElement;if(w)w.remove();else sel.remove()}
  document.querySelectorAll('.cc-proto-role-badge,#standalone-proto-pill').forEach(x=>x.remove());
 }
 function modulesFor(r){return {
  'O&M Head':['Command Center','Plants','Site Issues','Preventive Maintenance','Washing','Work / Assignments','Performance','Reports','Data / Imports','Settings','Project Handover','Extra Services'],
  'Assignee':['Command Center','Plants','Site Issues','Preventive Maintenance','Washing','Work / Assignments','Project Handover','Extra Services'],
  'Administration':['Command Center','Reports'],
  'Site Engineer':['Command Center','My Plant','Site Issues','Preventive Maintenance','Washing','Notifications','My Profile']
 }[r]||[]}
 function enforce(){
  if(AUTH_IDENTITY.role){S.currentRole=AUTH_IDENTITY.role;S._roleLabel=AUTH_IDENTITY.role}
  if(AUTH_IDENTITY.name)S.currentUser=AUTH_IDENTITY.name;
  stripRolePicker();
  const r=role(),allowed=modulesFor(r);
  if(r==='Site Engineer'&&(!S._sePlant)&&S.plants&&S.plants.length===1)S._sePlant=S.plants[0].name;
  document.querySelectorAll('.side-link').forEach(a=>{const sp=a.querySelector('span'),txt=(sp?sp.textContent:a.textContent||'').trim();a.style.display=allowed.indexOf(txt)>=0?'':'none'});
  if(r==='Site Engineer'){
   const p=S._sePlant||(S.plants&&S.plants[0]&&S.plants[0].name)||'';
   if(p){S.dashPlant=p;S.schedScope=p;S.washPlant=p;S.issF=S.issF||{};S.issF.plant=p}
   if(S.view!=='dashboard'&&S.view!=='om-module')S.view='dashboard';
   if(S.view==='om-module'&&['issues','scheduled','washing'].indexOf(S.omTab)<0)S.omTab='issues';
   const creator=document.getElementById('rev12-problem-task-card');if(creator)creator.remove();
  }
  if(r==='Administration')S._readOnly=true;
 }
 window.ccSwitchRole=function(){toast('Your role is managed by the Solar91 administrator.');};
 const priorRender=render;render=function(){enforce();const out=priorRender.apply(this,arguments);enforce();setTimeout(enforce,30);return out};
 const priorGoView=window.goView;window.goView=function(v){
  const r=role(),map={'dashboard':'Command Center','plants':'Plants','work':'Work / Assignments','performance':'Performance','reports':'Reports','data':'Data / Imports','settings':'Settings'};
  if(map[v]&&modulesFor(r).indexOf(map[v])<0){toast('This module is not available for your role.');S.view='dashboard';render();return}
  return priorGoView.apply(this,arguments);
 };
 const priorGoTab=window.goTab;window.goTab=function(t){const r=role(),map={'issues':'Site Issues','scheduled':'Preventive Maintenance','washing':'Preventive Maintenance','handover':'Project Handover','services':'Extra Services'};if(map[t]&&modulesFor(r).indexOf(map[t])<0){toast('This module is not available for your role.');S.view='dashboard';render();return}return priorGoTab.apply(this,arguments)};
})();

async function startSolar91App(){
 try{
  const ready=await ensureClerkReady();if(!ready)return;
  if(!window.Clerk.session){showClerkSignIn();return;}
  const session=await apiFetch('/api/auth/session');
  AUTH_IDENTITY.name=session.user.name||session.user.email||'Solar91 User';
  AUTH_IDENTITY.role=session.user.role||'Viewer';
  if(AUTH_IDENTITY.role==='Viewer'){
   authSetupCard('Access pending','Your Clerk sign-in is valid, but a Solar91 O&M Head must assign your operational role before business data is shown.<button onclick="clerkSignOut()" style="margin-left:12px;padding:8px 12px">Sign out</button>');return;
  }
  S.currentUser=AUTH_IDENTITY.name;S.currentRole=AUTH_IDENTITY.role;S._roleLabel=AUTH_IDENTITY.role;S._readOnly=AUTH_IDENTITY.role==='Administration';
  await init();
 }catch(e){console.error('Solar91 startup',e);if(String(e.message||e).includes('Authentication required')){showClerkSignIn();return}if(/not registered for Solar91/i.test(String(e.message||e))){try{await window.Clerk.signOut()}catch(_){}showClerkSignIn('This email is not registered. Ask your O&M Head to add you, then try again.');return}authSetupCard('Solar91 could not start',esc(e.message||String(e)))}
}

/* ================================================================
   SOLAR91 PRODUCTION BRIDGE — authenticated domain operations
   ================================================================ */
(function(){
  "use strict";
  const prodRole=()=>AUTH_IDENTITY.role||"Viewer";
  const issueDbId=t=>(t&&((t.dbId||t._dbId||"").toString()))||"";
  const plantRow=name=>(S.plants||[]).find(p=>p.name===name||p.id===name||p.dbId===name||p.site_code===name)||null;
  const plantDbId=name=>{const p=plantRow(name);return p&&(p.dbId||p.id)||null};
  const dateOnly=v=>v?String(v).slice(0,10):TODAY;

  function applyIssue(row,prior){
    const p=(S.plants||[]).find(x=>x.dbId===String(row.plant_id)||x.id===String(row.plant_id));
    const ui=Object.assign({},prior||{},{
      id:row.ticket_no,dbId:String(row.id),plant:p?p.name:((prior&&prior.plant)||""),
      vertical:row.vertical||((prior&&prior.vertical)||"Other"),sub:row.subcategory||null,
      equip:row.equipment_ref||"—",desc:row.description,severity:row.severity,status:row.status,
      created:row.created_at,updated:row.updated_at,occurred:row.occurred_at,etc:row.etc_at,
      assignee:row.assignee_text||null,assignedTo:row.assigned_to?String(row.assigned_to):null,
      maker:row.maker||"",supplier:row.supplier||null,serialNumber:row.serial_number||null,impact:row.impact||null,photos:Number(row.photo_count||0),evidence:row.evidence||((prior&&prior.evidence)||[]),
      vendor:row.vendor||null,closure:row.closure||((prior&&prior.closure)||null),
      sourceTask:row.source_task||((prior&&prior.sourceTask)||null),
      reopenedFrom:row.reopened_from||((prior&&prior.reopenedFrom)||null),reopenCount:Number(row.reopen_count||0)
    });
    const idx=(S.issues||[]).findIndex(x=>x.id===ui.id||issueDbId(x)===ui.dbId);
    if(idx>=0)S.issues[idx]=ui; else S.issues.unshift(ui);
    return ui;
  }
  window.applyIssueRow=applyIssue;
  function issueActionUrl(id,path){
    const t=(S.issues||[]).find(x=>x.id===id);
    const dbid=issueDbId(t);
    if(!dbid){toast("This issue needs a fresh server reload before it can be updated.");return null}
    return "/api/issues/"+encodeURIComponent(dbid)+path;
  }

  /* One submission at a time: a slow response must not let repeated clicks raise duplicate tickets. */
  let creatingTicket=false;
  window.createTicket=async function(){
    if(creatingTicket)return;
    const button=document.querySelector('[data-wiz-final="ticket"]');
    creatingTicket=true;if(button){button.disabled=true;button.dataset.label=button.textContent;button.textContent="Creating…"}
    try{await createTicketOnce()}
    finally{creatingTicket=false;if(button&&document.body.contains(button)){button.disabled=false;button.textContent=button.dataset.label||"Create ticket"}}
  };
  async function createTicketOnce(){
    const plantName=(prodRole()==="Site Engineer"?S._sePlant:((document.getElementById("tk-plant")||{}).value||"")).trim();
    const plantId=plantDbId(plantName);
    const desc=((document.getElementById("tk-desc")||{}).value||"").trim();
    if(!plantId){toast("A valid plant scope is required.");return}
    if(!desc){toast("Issue details are required.");if(typeof wizardGo==="function")wizardGo("ticket",3);return}
    const photoInput=document.getElementById("tk-photos"),photoFiles=Array.from(photoInput&&photoInput.files||[]);
    if(photoFiles.length>10){toast("Choose no more than 10 evidence photos.");return}
    const sev=(document.getElementById("tk-sev")||{}).value||"Medium";
    const equipmentRef=((document.getElementById("tk-equip")||{}).value||"").trim();
    const pickedId=((document.getElementById("tk-equip-pick")||{}).value||"");
    const registeredEquipment=(S.equipment||[]).find(e=>String(e.id)===pickedId&&String(e.plant_id)===String(plantId))||(S.equipment||[]).find(e=>
      String(e.plant_id)===String(plantId)&&String(e.status||"active").toLowerCase()!=="inactive"&&
      [e.equipment_code,e.equipment_name].filter(Boolean).some(value=>String(value).trim().toLowerCase()===equipmentRef.toLowerCase())
    );
    const body={
      plant_id:plantId,equipment_id:registeredEquipment?registeredEquipment.id:null,equipment_ref:equipmentRef||null,
      vertical:(registeredEquipment&&registeredEquipment.equipment_type)||((document.getElementById("tk-vert")||{}).value||"Other"),description:desc,severity:sev,
      assigned_to:((document.getElementById("tk-assignee")||{}).value||"")||null,
      occurred_at:(document.getElementById("tk-occurred")||{}).value?document.getElementById("tk-occurred").value+"T09:00:00":null,
      etc_at:(document.getElementById("tk-etc")||{}).value||null,
      maker:((document.getElementById("tk-maker")||{}).value||"").trim()||null,
      supplier:((document.getElementById("tk-supplier")||{}).value||"").trim()||null,
      serial_number:((document.getElementById("tk-serial")||{}).value||"").trim()||null,
      photo_count:0
    };
    try{
      const row=await apiFetch("/api/issues",{method:"POST",body});
      let ui=applyIssue(row);
      if(photoFiles.length){
        try{
          const evidence=await uploadIssuePhotos(ui,photoInput);
          ui.evidence=(ui.evidence||[]).concat(evidence);ui.photos=ui.evidence.length;
        }catch(uploadError){
          revealNew("issues",ui.id);S.modal=null;render();
          toast("Issue "+ui.id+" was created, but photo upload failed. Open the issue and retry the evidence upload. "+uploadError.message);
          return;
        }
      }
      revealNew("issues",ui.id);S.modal=null;render();
      toast("Issue "+ui.id+" created and saved.");
    }catch(e){toast(e.message||"Could not create issue.")}
  }

  async function postIssue(id,path,body){
    const url=issueActionUrl(id,path);if(!url)return null;
    const prior=(S.issues||[]).find(x=>x.id===id);
    try{
      const row=await apiFetch(url,{method:"POST",body});
      const updated=applyIssue(row,prior);
      if(typeof refreshIssueActivity==="function")await refreshIssueActivity(id,false);
      return updated;
    }catch(e){toast(e.message||"Could not update the issue.");return null}
  }
  window.postIssue=postIssue;
  window.assignTicket=async function(){
    const id=(S.modalCtx||{}).id,t=(S.issues||[]).find(x=>x.id===id);if(!t)return;
    const who=(document.getElementById("at-who")||{}).value||"";
    let assignee=who,vendor=null;
    if(who==="__vendor"){
      assignee=((document.getElementById("at-owner")||{}).value||"").trim();
      vendor={name:((document.getElementById("at-vn")||{}).value||"Vendor").trim(),
        contact:((document.getElementById("at-vc")||{}).value||"—").trim(),
        expected:((document.getElementById("at-vr")||{}).value||"—").trim()};
    }
    if(!assignee){toast("Choose an assignee.");return}
    const row=await postIssue(id,t.assignee?"/reassign":"/assign",{assignee_text:assignee,vendor,note:"Assignment changed from Solar91 Command Center"});
    if(row){S.modal=null;render();toast("Ticket assignment saved and the assignee was notified.")}
  };
  window.ackTicket=async id=>{if(await postIssue(id,"/acknowledge"))render()};
  window.startTicket=async id=>{if(await postIssue(id,"/start"))render()};
  window.pendingTicket=async id=>{if(await postIssue(id,"/status",{status:"Pending Vendor",note:"Blocked — awaiting spare parts / vendor."}))render()};
  window.resumeTicket=async id=>{if(await postIssue(id,"/status",{status:"In Progress",note:"Resumed — parts/vendor received."}))render()};
  window.addProgress=async function(){
    const id=(S.modalCtx||{}).id,t=(S.issues||[]).find(x=>x.id===id);if(!t)return;
    const note=((document.getElementById("pg-note")||{}).value||"Progress update.").trim();
    const hours=parseFloat((document.getElementById("pg-hrs")||{}).value)||0;
    const partId=(document.getElementById("pg-part")||{}).value||null;
    const quantity=parseFloat((document.getElementById("pg-qty")||{}).value)||1;
    const part=(S.inventory||[]).find(x=>x.id===partId);
    const parts=part?part.item+" x"+quantity:"—";
    const row=await postIssue(id,"/progress",{note,inventory_item_id:partId,quantity:partId?quantity:null,hours});
    if(row){const ui=S.issues.find(x=>x.id===id);ui.progress=ui.progress||[];ui.progress.unshift({at:stampISO(),note,parts,hrs:hours});S.modal=null;render();toast("Progress update saved.");}
  };
  window.resolveTicket=async function(){
    const id=(S.modalCtx||{}).id,t=(S.issues||[]).find(x=>x.id===id);if(!t)return;
    const rootCause=((document.getElementById("rs-root")||{}).value||"").trim();
    const correctiveAction=((document.getElementById("rs-act")||{}).value||"").trim();
    const photoInput=document.getElementById("rs-photos"),files=Array.from(photoInput&&photoInput.files||[]);
    if(!rootCause||!correctiveAction){toast("Root cause and corrective action are required.");return}
    if(!files.length){toast("Upload at least one photo of the completed fix.");return}
    try{
      const uploaded=await uploadIssuePhotos(t,photoInput);
      t.evidence=(t.evidence||[]).concat(uploaded);t.photos=t.evidence.length;
      if(photoInput)photoInput.value="";
      const row=await postIssue(id,"/resolve",{
        note:"Resolution submitted for secondary review",
        root_cause:rootCause,corrective_action:correctiveAction,
        evidence_ids:uploaded.map(photo=>photo.id)
      });
      if(row){const ui=S.issues.find(x=>x.id===id);ui.progress=ui.progress||[];ui.progress.unshift({at:stampISO(),note:"Resolution submitted — root cause: "+rootCause,parts:"—",hrs:0});S.modal=null;render();toast("Resolution saved — awaiting O&M Head verification.");}
      else render();
    }catch(e){toast(e.message||"Could not submit the resolution.")}
  };
  window.verifyTicket=async function(){
    const id=(S.modalCtx||{}).id,t=(S.issues||[]).find(x=>x.id===id);if(!t)return;
    const remarks=((document.getElementById("vf-rem")||{}).value||"").trim();
    const row=await postIssue(id,"/close",{note:remarks||"Verified and formally closed",closure:Object.assign({},t.closure||{},{verifiedBy:AUTH_IDENTITY.name||"O&M Head"})});
    if(row){S.modal=null;render();toast("Ticket formally closed and audited.")}
  };
  window.reopenTicket=async function(){
    const id=(S.modalCtx||{}).id;const reason=((document.getElementById("ro-reason")||{}).value||"Issue recurred — reopened.").trim();
    const row=await postIssue(id,"/reopen",{reason});if(row){S.modal=null;render();toast("Ticket reopened and audited.")}
  };

  window.reassignTask=async function(){
    const id=(S.modalCtx||{}).id,name=((document.getElementById("rt-name")||{}).value||"").trim();
    if(!id||!name){toast("Assignee is required.");return}
    try{
      const row=await apiFetch("/api/scheduled/tasks/"+encodeURIComponent(id)+"/assignee",{method:"PATCH",body:{assignee:name}});
      const idx=(S.tasks||[]).findIndex(x=>x.id===id);if(idx>=0)S.tasks[idx]=Object.assign({},S.tasks[idx],row);
      S.modal=null;render();toast("Preventive Maintenance reassignment saved and logged.");
    }catch(e){toast(e.message||"Could not reassign task.")}
  };

  window.createTask=async function(){
    const name=((document.getElementById("nt-name")||{}).value||"").trim();if(!name){toast("Task name is required.");return}
    const plantName=(prodRole()==="Site Engineer"?S._sePlant:((document.getElementById("nt-plant")||{}).value||((S.plants[0]||{}).name||"")));
    const body={plant_id:plantDbId(plantName),asset:((document.getElementById("nt-type")||{}).value||"Other"),
      problem:((document.getElementById("nt-problem")||{}).value||"Scheduled maintenance"),task_name:name,equipment_ref:null,
      frequency:((document.getElementById("nt-freq")||{}).value||"Monthly"),due_on:((document.getElementById("nt-start")||{}).value||addDays(TODAY,3)),
      assignee:((document.getElementById("nt-who")||{}).value||null),sop:((document.getElementById("nt-sop")||{}).value||"").trim()||null,
      safety:((document.getElementById("nt-safety")||{}).value||"—"),tools:((document.getElementById("nt-tools")||{}).value||"").trim()||null,
      duration:((document.getElementById("nt-dur")||{}).value||"").trim()||null};
    if(!body.plant_id){toast("A valid plant is required.");return}
    try{
      const row=await apiFetch("/api/scheduled/tasks/problem",{method:"POST",body});
      const idx=(S.tasks||[]).findIndex(x=>x.id===row.id);if(idx>=0)S.tasks[idx]=Object.assign({},S.tasks[idx],row);else S.tasks.unshift(row);
      S.modal=null;render();toast("Preventive Maintenance task created and saved.");
    }catch(e){toast(e.message||"Could not create Preventive Maintenance task.")}
  };

  async function postWash(path,id,body){
    try{
      const result=await apiFetch("/api/scheduled/washing/"+encodeURIComponent(id)+path,{method:"POST",body});
      const t=(S.washing||[]).find(x=>x.id===id);
      if(t){if(result.next_due)t.nextDue=result.next_due;if(result.rescheduled_to!==undefined)t.rescheduledTo=result.rescheduled_to;
        if(result.event){t.history=t.history||[];t.history.push(result.event);}}
      return result;
    }catch(e){toast(e.message||"Could not save washing record.");return null}
  }
  window.washTable=async function(id){
    const t=(S.washing||[]).find(x=>x.id===id);if(!t)return;
    if(typeof washedToday==="function"&&washedToday(t)){toast("Already logged as washed today.");return}
    const result=await postWash("/log",id,{});
    if(result){S.modal=null;render();toast("Wash logged and saved to Solar91.")}
  };
  window.logException=async function(){
    const id=(S.modalCtx||{}).id,reason=((document.getElementById("ex-reason")||{}).value||"Other"),
      notes=((document.getElementById("ex-notes")||{}).value||"").trim();
    if(!id)return;
    const result=await postWash("/exception",id,{date:TODAY,reason,notes});
    if(result){S.modal=null;render();toast("Washing exception saved.")}
  };

  function renderMyPlant(){
    const p=S.plants&&S.plants[0];
    if(!p)return '<div class="banner bn-info"><b>Access pending</b><div style="margin-top:4px">No plant is currently assigned to this Site Engineer account.</div></div>';
    const f=Object.assign(blankIssF(),S.issF||{});S.issF=f;
    const equipmentChoices=dashboardEquipmentOptions(p.name);
    if(f.equip!=="all"&&!equipmentChoices.some(e=>e.value===f.equip)){f.equip="all";S.issF.equip="all"}
    const issues=(S.issues||[]).filter(x=>ccDashboardEquipmentMatches(x,f.equip));
    const tasks=(S.tasks||[]).filter(x=>ccDashboardEquipmentMatches(x,f.equip));
    const equip=(S.equipment||[]).filter(e=>String(e.plant_id)===String(p.dbId||p.id));
    const activeIssues=issues.filter(x=>!["Resolved","Closed"].includes(x.status));
    const critical=activeIssues.filter(isCriticalIssue);
    const overdue=activeIssues.filter(x=>typeof isOverdueIssue==="function"&&isOverdueIssue(x));
    const today=tasks.filter(x=>dateOnly(x.due)===TODAY&&x.status!=="Completed");
    const soon=tasks.filter(x=>{const d=dayDiff(TODAY,dateOnly(x.due));return d>=0&&d<=7&&x.status!=="Completed";});
    const completed=tasks.filter(x=>x.status==="Completed"&&String(x.actualCompleted||x.due||"").slice(0,7)===TODAY.slice(0,7));
    const openMaint=tasks.filter(x=>x.status!=="Completed").length;
    const health=critical.length||overdue.length?"Warning":"Healthy";
    const statuses=["Open","Assigned","Acknowledged","In Progress","Pending Vendor","Resolved","Closed"];
    const slices=statuses.map(st=>({label:st,id:st,n:issues.filter(x=>x.status===st).length,color:"#0c5e2a",act:null})).filter(x=>x.n);
    let h='<div class="row between wrap" style="gap:12px;margin-bottom:16px"><div><div style="font-size:12.5px;color:var(--muted-foreground);font-weight:700;text-transform:uppercase;letter-spacing:.06em">My Plant</div><h1 style="font-size:24px;font-weight:800;letter-spacing:-.03em;margin-top:2px">'+esc(p.name)+'</h1><div style="font-size:12px;color:var(--muted-foreground);margin-top:3px">'+esc(p.id||"")+' · '+esc(p.project||"")+'</div></div><div class="row wrap" style="gap:7px"><span class="badge b-success">Locked scope · '+esc(p.id||"")+'</span>'+(equipmentChoices.length?'<div class="field" style="min-width:210px"><span class="lbl">Equipment</span><select class="inp" aria-label="Filter dashboard by equipment" onchange="S.issF.equip=this.value;render()"><option value="all">All equipment</option>'+equipmentChoices.map(e=>'<option value="'+esc(e.value)+'"'+(f.equip===e.value?" selected":"")+'>'+esc(e.label)+'</option>').join("")+'</select></div>':'')+'<button class="btn p" onclick="goTab(\'issues\')">Raise / View Issues</button><button class="btn o" onclick="goTab(\'scheduled\')">Preventive Maintenance</button></div></div>';
    h+='<div class="panel" style="margin-bottom:14px"><div class="row between wrap"><div><h2 style="font-size:14px;font-weight:700">Plant identity</h2><p style="font-size:12.5px;color:var(--muted-foreground);margin-top:3px">Server-scoped plant information</p></div><span class="badge '+(health==="Healthy"?"b-success":health==="Warning"?"b-warning":"b-danger")+'">'+esc(p.status||health)+'</span></div><div class="kgrid" style="grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:12px">';
    h+='<div><div class="kpi-label">Project company</div><div style="margin-top:4px;font-weight:700">'+esc(unspecified(p.project))+'</div></div><div><div class="kpi-label">DC capacity</div><div style="margin-top:4px;font-weight:700">'+esc(plantDcKw(p)!=null?(plantDcKw(p)/1000).toFixed(2)+" MW":capLabel(p.capacity))+'</div></div><div><div class="kpi-label">AC capacity</div><div style="margin-top:4px;font-weight:700">'+esc(plantAcKw(p)!=null?(plantAcKw(p)/1000).toFixed(2)+" MW":"Not specified")+'</div></div><div><div class="kpi-label">Commissioned</div><div style="margin-top:4px;font-weight:700">'+esc(p.cod?fmtDate(p.cod):"Not specified")+'</div></div>';
    h+='<div><div class="kpi-label">Location</div><div style="margin-top:4px;font-weight:700">'+esc(unspecified(p.location))+'</div></div><div><div class="kpi-label">Latitude</div><div style="margin-top:4px;font-weight:700">'+esc(p.geo&&p.geo.lat!=null?p.geo.lat:"Not specified")+'</div></div><div><div class="kpi-label">Longitude</div><div style="margin-top:4px;font-weight:700">'+esc(p.geo&&p.geo.lng!=null?p.geo.lng:"Not specified")+'</div></div><div><div class="kpi-label">Equipment count</div><div style="margin-top:4px;font-weight:700">'+equip.length+'</div></div></div></div>';
    h+='<div class="kpis8" style="grid-template-columns:repeat(6,minmax(0,1fr));margin-bottom:14px">'+kpiTile("Open issues",activeIssues.length,"this plant","var(--info)",'data-act="go" data-id="issues"')+kpiTile("Critical",critical.length,"active","var(--danger)",'data-act="go" data-id="issues"')+kpiTile("Overdue",overdue.length,"issues past ETC","var(--danger)",'data-act="go" data-id="issues"')+kpiTile("Scheduled today",today.length,"due today","var(--warning)",'data-act="go" data-id="scheduled"')+kpiTile("Due soon",soon.length,"next 7 days","var(--info)",'data-act="go" data-id="scheduled"')+kpiTile("Completed",completed.length,"this month","var(--success)",'data-act="go" data-id="scheduled"')+'</div>';
    h+='<div class="kgrid" style="grid-template-columns:1.1fr .9fr;align-items:start"><div class="panel">'+(slices.length?vizDonut("Issue status",slices,{center:String(issues.length),note:"Server-backed issue status for this plant",empty:"No issues yet"}):'<div class="empty-box"><b>No Site Issues yet</b>Issues raised at this plant will appear here.</div>')+'</div><div class="panel"><div class="row between"><div><h2 style="font-size:14px;font-weight:700">Work queue</h2><p style="font-size:12.5px;color:var(--muted-foreground);margin-top:3px">Today and next 7 days</p></div><span class="badge b-info">'+openMaint+' active</span></div><div style="margin-top:10px">'+(soon.length?soon.slice(0,7).map(x=>'<div class="row between" style="gap:8px;padding:8px 0;border-bottom:1px solid var(--border)"><div><b style="font-size:12px">'+esc(x.name)+'</b><div style="font-size:12px;color:var(--muted-foreground)">'+esc(x.id)+' · '+esc(x.equip||"—")+'</div></div><span class="badge '+(dateOnly(x.due)<TODAY?"b-danger":"b-info")+'">'+esc(fmtD(dateOnly(x.due)))+'</span></div>').join(""):'<div class="empty-box"><b>No scheduled work due soon</b>Open Preventive Maintenance to review assigned plant work.</div>')+'</div></div></div>';
    h+='<div class="panel" style="margin-top:14px"><div class="row between wrap"><div><h2 style="font-size:14px;font-weight:700">Operational scope</h2><p style="font-size:12.5px;color:var(--muted-foreground);margin-top:3px">The server supplies this user’s plant scope; plant switching is not available in Site Engineer mode.</p></div><span class="badge b-success">Site Engineer · '+esc(AUTH_IDENTITY.name||"")+'</span></div><div style="margin-top:10px;font-size:12px;line-height:1.7">Open issues, maintenance work, washing records and equipment are filtered on the server to <b>'+esc(p.id||"")+'</b>.</div></div>';
    return h;
  }
  const legacyDashboard=renderDashboard;
  renderDashboard=function(){return prodRole()==="Site Engineer"?renderMyPlant():legacyDashboard.apply(this,arguments)};
})();

startSolar91App();