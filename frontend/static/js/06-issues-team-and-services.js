"use strict";
/* ---------------- 2.3 ISSUES ---------------- */
function engineerLoad(){const names=[...new Set(SITE_ENG_POOL)]; /* Site Engineers only — O&M team assignees are not listed here */
 return names.map(n=>{const rows=(S.issues||[]).filter(t=>t.assignee===n);const open=openTk(rows);return{name:n,assigned:open.length,critical:open.filter(t=>t.severity==="Critical").length,overdue:open.filter(isOverdueIssue).length,progress:open.filter(t=>t.status==="In Progress").length,resolved:rows.filter(t=>t.status==="Resolved"||t.status==="Closed").length,rows}}).sort((a,b)=>b.assigned-a.assigned||b.critical-a.critical)}


function reportRowsForHub(kind){
 const open=openTk(S.issues||[]);
 if(kind==="daily"||kind==="weekly"||kind==="monthly"){const n=kind==="daily"?1:kind==="weekly"?7:30,from=addDays(TODAY,1-n);
  const raised=(S.issues||[]).filter(t=>issueDay(t)>=from);const closed=(S.issues||[]).filter(t=>t.closure&&String(t.closure.closedAt||"").slice(0,10)>=from);
  return{title:kind[0].toUpperCase()+kind.slice(1)+" O&M summary",cols:["Metric","Value"],rows:[["Period",from+" → "+TODAY],["Issues raised",raised.length],["Resolved / closed",closed.length],["Still open",open.length],["Overdue",open.filter(isOverdueIssue).length],["Unassigned",open.filter(t=>!t.assignee).length],["Critical open",open.filter(isCriticalIssue).length]]};}
 if(kind==="open")return{title:"Open issues",cols:["Issue","Plant","Priority","Status","Assignee","Age"],rows:open.map(t=>[t.id,t.plant,t.severity,t.status,t.assignee||"Unassigned",ageBucket(t)])};
 if(kind==="overdue")return{title:"Overdue issues",cols:["Issue","Plant","Priority","Assignee","Age"],rows:open.filter(isOverdueIssue).map(t=>[t.id,t.plant,t.severity,t.assignee||"Unassigned",ageBucket(t)])};
 if(kind==="work")return{title:"Engineer workload",cols:["Engineer","Assigned","Critical","Overdue","In progress","Resolved"],rows:engineerLoad().map(r=>[r.name,r.assigned,r.critical,r.overdue,r.progress,r.resolved])};
 if(kind==="plants")return{title:"Plant issue summary",cols:["Plant","Site","Open","Critical","Engineer","Health"],rows:S.plants.map(p=>{const oi=open.filter(t=>t.plant===p.name);return[p.name,p.id,oi.length,oi.filter(isCriticalIssue).length,plantEngineer(p)||"—",plantHealth(p)]})};
 const mk={};(S.issues||[]).forEach(t=>{const k=(t.equip||"—")+" / "+(t.maker||"unspecified");mk[k]=(mk[k]||0)+1});
 return{title:"Equipment / maker issue summary",cols:["Equipment / maker","Issues"],rows:Object.entries(mk).sort((a,b)=>b[1]-a[1])};
}
function renderReportsHub(){
 const kind=S.reportKind||"daily",rep=reportRowsForHub(kind);
 const tabs=[["daily","Daily O&M"],["weekly","Weekly O&M"],["monthly","Monthly O&M"],["open","Open issues"],["overdue","Overdue"],["work","Engineer workload"],["plants","Plant issues"],["equip","Equipment / maker"]];
 let h='<div class="ops-page ops-reports"><div class="ops-page-head"><div><div class="kpi-label">SOLAR OPERATIONS · REPORTING</div><h1>Reports</h1><p>Operational summaries and registers built from the current application data.</p></div><button class="btn o sm" onclick="window.print()">Print / PDF</button></div>';
 h+='<div class="ops-report-tabs" role="group" aria-label="Report type">'+tabs.map(([id,l])=>'<button type="button" class="pill sev-pill'+(kind===id?" active":"")+'" aria-pressed="'+(kind===id)+'" onclick="S.reportKind=\''+id+'\';render()">'+l+'</button>').join("")+'</div>';
 if(rep.sum&&rep.sum.length)h+='<div class="ops-report-metrics">'+rep.sum.map(([label,value])=>'<div class="ops-report-metric"><span>'+esc(String(label))+'</span><b>'+esc(String(value))+'</b></div>').join("")+'</div>';
 h+='<div class="panel no-stick ops-report-table" style="padding:0"><div class="ops-section-head"><div><div class="kpi-label">SELECTED REPORT</div><h2>'+esc(rep.title)+'</h2></div><span>'+rep.rows.length+' rows</span></div>';
 if(!rep.rows.length)h+=emptyState("Nothing to report","No matching records in the live dataset.");
 else h+='<div class="ops-table-scroll"><table class="dense"><thead><tr>'+rep.cols.map(c=>'<th>'+esc(c)+'</th>').join("")+'</tr></thead><tbody>'+rep.rows.map(r=>'<tr>'+r.map(c=>'<td>'+esc(String(c))+'</td>').join("")+'</tr>').join("")+'</tbody></table></div>';
 h+='</div></div>';
 return h;
}

/* ---------- TEAM & ACCESS (O&M Head assigns roles · Assignees get EQUIPMENT across plants · Site Engineers get ONE plant) ---------- */
const TA_ROLES=["O&M Head","Assignee","Administration","Site Engineer","Viewer"];
const TA_ROLE_HELP={"O&M Head":"Full administration, all plants","Assignee":"O&M team — owns chosen equipment types (e.g. Inverter) across ALL plants","Administration":"Read-only Command Center and reports","Site Engineer":"Exactly ONE plant, own-plant workflow","Viewer":"Pending — no access until a role is assigned"};
const TA_ROLE_CLS={"O&M Head":"om-head","Assignee":"assignee","Administration":"ceo-cto","Site Engineer":"site-engineer","Viewer":"viewer"};
const TA={users:null,loading:false,error:null,draft:{},open:{},q:{},selOnly:{},filter:"all",saving:{},formOpen:false,nw:{name:"",email:"",role:"Assignee",plant:"",equipment_types:[]}};

async function taLoad(force){
 if(AUTH_IDENTITY.role!=="O&M Head")return;
 if(TA.loading)return;
 if(!force&&(TA.users||TA.error))return;
 TA.loading=true;TA.error=null;
 try{TA.users=await apiFetch("/api/users");TA.draft={};}catch(e){TA.error=e.message||"Could not load users"}
 TA.loading=false;render();
}

/* ---- lookups ---- */
function taRoleCls(r){return "ta-role-"+(TA_ROLE_CLS[r]||"viewer")}
function taUser(id){return (TA.users||[]).find(x=>x.id===id)}
function taPlants(){
 const ps=S.plants||[];
 if(TA._pl&&TA._plSrc===ps&&TA._plLen===ps.length)return TA._pl;
 TA._pl=ps.filter(p=>p.dbId).slice().sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 TA._plSrc=ps;TA._plLen=ps.length;TA._plIdx={};TA._pl.forEach((p,i)=>TA._plIdx[p.dbId]=i);
 return TA._pl;
}
/* each plant gets a stable colour (pc0…pc7) so the same plant looks the same everywhere in this panel */
function taPlantCls(plantDbId){taPlants();const i=TA._plIdx[plantDbId];return i==null?"pcx":"pc"+(i%8)}
function taEquipment(){
 taPlants();
 return (S.equipment||[]).filter(e=>String(e.status||"").toLowerCase()!=="inactive").slice().sort((a,b)=>{
  const ia=TA._plIdx[a.plant_id],ib=TA._plIdx[b.plant_id];
  return (ia==null?999:ia)-(ib==null?999:ib)||String(a.equipment_code||a.equipment_name).localeCompare(String(b.equipment_code||b.equipment_name),undefined,{numeric:true});
 });
}
function taEqStatus(e){
 const s=String(e.status||"active").toLowerCase();
 return /fault|fail|down|break|trip|alarm|offline/.test(s)?"bad":/maint|service|warn|degrad|repair/.test(s)?"warn":s==="active"?"ok":"off";
}
function taSummaryText(types){return types.length?types.length+" equipment type"+(types.length===1?"":"s")+" · all plants":"No equipment type selected"}

/* ---- drafts ---- */
function taDraft(u){
 if(!TA.draft[u.id])TA.draft[u.id]={role:u.role,plant_ids:(u.plants||[]).map(p=>p.plant_id),equipment_types:(u.equipment_types||[]).slice()};
 return TA.draft[u.id];
}
function taEqIds(key){return key==="new"?TA.nw.equipment_types:taDraft(taUser(key)||{id:key}).equipment_types}
function taDirty(u){
 const d=TA.draft[u.id];if(!d)return false;
 const orig=(u.plants||[]).map(p=>p.plant_id).sort().join(",");
 const origEq=(u.equipment_types||[]).slice().sort().join(",");
 const now=d.role==="Site Engineer"?d.plant_ids.slice().sort().join(","):"";
 const origEff=u.role==="Site Engineer"?orig:"";
 const nowEq=d.role==="Assignee"?d.equipment_types.slice().sort().join(","):"";
 const origEqEff=u.role==="Assignee"?origEq:"";
 return d.role!==u.role||now!==origEff||nowEq!==origEqEff;
}

/* ---- in-place refresh helpers (avoid a full render(): keeps scroll position + no panel re-animation) ---- */
function taRefreshUser(id){
 const u=taUser(id),el=document.getElementById("ta-u-"+id);
 if(!u||!el){render();return}
 el.outerHTML=taUserBody(u);
}
function taRefreshRow(id){
 const u=taUser(id),el=document.getElementById("ta-row-"+id);
 if(!u||!el){render();return}
 el.outerHTML=taSummaryRow(u);
}
function taAfterEq(key){
 if(key==="new"){const f=document.getElementById("ta-new-form");if(f)f.outerHTML=taAddForm();}
 else taRefreshRow(key);
}

/* ---- role / scope actions ---- */
function taSetRole(id,role){
 const u=taUser(id);if(!u)return;
 const d=taDraft(u);d.role=role;
 if(role!=="Site Engineer")d.plant_ids=[];
 if(role!=="Assignee")d.equipment_types=[];
 if(role==="Site Engineer"&&d.plant_ids.length>1)d.plant_ids=d.plant_ids.slice(0,1);
 taRefreshUser(id);
}
function taSetOnePlant(id,pid){
 const u=taUser(id);if(!u)return;
 taDraft(u).plant_ids=pid?[pid]:[];taRefreshRow(id);
}
function taToggleEq(key,type,on){
 const ids=taEqIds(key),set=new Set(ids);on?set.add(type):set.delete(type);
 ids.length=0;set.forEach(x=>ids.push(x));
 taAfterEq(key);
}
function taPickType(key,type){if(type)taToggleEq(key,type,true)}
function taAllTypes(key){const ids=taEqIds(key);ids.length=0;VERTICALS.forEach(t=>ids.push(t));taAfterEq(key)}
function taClearEq(key){const ids=taEqIds(key);ids.length=0;taAfterEq(key)}
function taReset(id){delete TA.draft[id];taRefreshUser(id)}

async function taSave(id){
 const u=taUser(id);if(!u||TA.saving[id])return;
 const d=taDraft(u);
 const plant_ids=d.role==="Site Engineer"?d.plant_ids:[];
 const equipment_types=d.role==="Assignee"?d.equipment_types:[];
 if(d.role==="Site Engineer"&&plant_ids.length!==1){toast("A Site Engineer needs exactly one plant.");return}
 if(d.role==="Assignee"&&equipment_types.length===0&&!confirm("This Assignee has no equipment type assigned and will see no operational data. Save anyway?"))return;
 if(u.is_self&&d.role!=="O&M Head"){toast("You cannot remove your own O&M Head access.");return}
 TA.saving[id]=true;taRefreshRow(id);
 try{
  await apiFetch("/api/users/"+encodeURIComponent(id)+"/access",{method:"PUT",body:{role:d.role,plant_ids,equipment_types}});
  toast((u.name||u.email||"User")+" is now "+d.role+(plant_ids.length?" · 1 plant":"")+(d.role==="Assignee"?" · "+equipment_types.length+" equipment type"+(equipment_types.length===1?"":"s")+" across all plants":""));
  delete TA.draft[id];TA.saving[id]=false;await taLoad(true);
 }catch(e){TA.saving[id]=false;toast("Not saved — "+e.message);taRefreshRow(id)}
}
async function taResendInvite(id){
 const u=taUser(id);if(!u)return;
 try{const r=await apiFetch("/api/users/"+encodeURIComponent(id)+"/resend-invite",{method:"POST"});
  toast(r.email_sent?"Invite email sent to "+u.email:"Email not sent — "+(r.email_note||"unknown reason"))}
 catch(e){toast("Not sent — "+e.message)}
}
async function taToggleActive(id,on){
 const u=taUser(id);if(!u)return;
 if(!on&&!confirm("Deactivate "+(u.name||u.email)+"? They will be locked out immediately."))return;
 try{await apiFetch("/api/users/"+encodeURIComponent(id)+"/active",{method:"PATCH",body:{is_active:on}});toast((on?"Activated ":"Deactivated ")+(u.name||u.email));await taLoad(true)}
 catch(e){toast("Not changed — "+e.message)}
}

/* ---- equipment TYPE selector (shared by the user rows and the Add-person form) ---- */
function taTypeSelect(key){
 const have=new Set(taEqIds(key));
 return '<select class="inp ta-eq-select" aria-label="Select equipment type" onchange="taPickType(\''+esc(key)+'\',this.value)"><option value="">＋ Select equipment type…</option>'
  +VERTICALS.filter(t=>!have.has(t)).map(t=>'<option value="'+esc(t)+'">'+esc(t)+'</option>').join("")+'</select>';
}
function taTypeChips(key){
 const ids=taEqIds(key);
 return ids.map(t=>'<span class="ta-chip pc0" title="All '+esc(t)+' across all plants"><i></i>'+esc(t)+' · all plants<button type="button" class="ta-x" aria-label="Remove '+esc(t)+'" onclick="taToggleEq(\''+esc(key)+'\',\''+esc(t)+'\',false)">×</button></span>').join("");
}
function taTypeBox(key){
 const ids=taEqIds(key),n=ids.length;
 const tools='<div class="ta-add-row">'+taTypeSelect(key)+'<button type="button" class="btn o sm" onclick="taAllTypes(\''+esc(key)+'\')">All types</button>'+(n?'<button type="button" class="btn o sm" onclick="taClearEq(\''+esc(key)+'\')">Clear</button>':'')+'</div>';
 if(!n)return '<div class="ta-box warn"><div class="ta-box-top"><b>No equipment type assigned</b></div>'+tools+'<span>No operational access until an equipment type is assigned</span></div>';
 return '<div class="ta-box"><div class="ta-box-top"><b>'+esc(taSummaryText(ids))+'</b></div><div class="ta-chips">'+taTypeChips(key)+'</div>'+tools+'</div>';
}

/* ---- scope cell (colour coded by role; chips coloured by plant) ---- */
function taScopeCell(u,d){
 const id=esc(u.id);
 if(d.role==="O&M Head")return '<div class="ta-box"><b>All plants · all equipment</b><span>Full administration</span></div>';
 if(d.role==="Administration")return '<div class="ta-box"><b>All plants · all equipment</b><span>Read-only portfolio view</span></div>';
 if(d.role==="Viewer")return '<div class="ta-box"><b>No access yet</b><span>Choose a role to grant access</span></div>';
 const plants=taPlants();
 if(d.role==="Site Engineer"){
  const cur=plants.find(p=>p.dbId===d.plant_ids[0]);
  return '<div class="ta-box'+(cur?"":" warn")+'"><select class="inp" style="min-width:230px;font-size:12px" onchange="taSetOnePlant(\''+id+'\',this.value)"><option value="">— select ONE plant —</option>'+plants.map(p=>'<option value="'+esc(p.dbId)+'"'+(d.plant_ids[0]===p.dbId?" selected":"")+'>'+esc(p.id+" · "+p.name)+'</option>').join("")+'</select>'
   +(cur?'<span class="ta-chip '+taPlantCls(cur.dbId)+'"><i></i>'+esc(cur.id+" · "+cur.name)+'</span>':'<span>A Site Engineer must have exactly one plant</span>')+'</div>';
 }
 /* Assignee → equipment types across all plants */
 return taTypeBox(u.id);
}

/* ---- one person = one <tbody> holding a summary row + a (hidden until opened) equipment-picker row ---- */
function taSummaryRow(u){
 const d=taDraft(u),dirty=taDirty(u),busy=!!TA.saving[u.id],id=esc(u.id);
 const ini=String(u.name||u.email||"?").trim().split(/[\s@._-]+/).filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase()||"?";
 return '<tr class="ta-row '+taRoleCls(d.role)+(dirty?" dirty":"")+(u.active?"":" off")+'" id="ta-row-'+id+'">'
  +'<td><div class="ta-person"><span class="ta-av">'+esc(ini)+'</span><div><div class="ta-name">'+esc(u.name||"—")+(u.is_self?' <span class="badge b-info">You</span>':"")+(u.invited?' <span class="badge b-warning">Not Signed In Yet</span> ':"")+'</div><div class="ta-mail">'+esc(u.email||"")+'</div></div></div></td>'
  +'<td><select class="inp ta-role-select" '+(busy?"disabled ":"")+'onchange="taSetRole(\''+id+'\',this.value)">'+TA_ROLES.map(r=>'<option value="'+esc(r)+'"'+(d.role===r?" selected":"")+'>'+esc(r)+'</option>').join("")+'</select><div class="ta-help">'+esc(TA_ROLE_HELP[d.role]||"")+'</div></td>'
  +'<td>'+taScopeCell(u,d)+'</td>'
  +'<td><button '+(u.is_self?"disabled ":"")+'onclick="taToggleActive(\''+id+'\','+(!u.active)+')" class="ta-switch'+(u.active?" on":"")+'" title="'+(u.active?"Active — click to deactivate":"Inactive — click to activate")+'"><span></span></button></td>'
  +'<td class="nowrap">'+(dirty?'<div class="ta-save"><span class="ta-pill warn">Unsaved changes</span><div><button class="btn p sm" '+(busy?"disabled ":"")+'onclick="taSave(\''+id+'\')">'+(busy?"Saving…":"Save")+'</button> <button class="btn o sm" '+(busy?"disabled ":"")+'onclick="taReset(\''+id+'\')">Cancel</button></div></div>':'<span class="ta-pill ok">Saved</span>')+'</td></tr>';
}
function taUserBody(u){
 return '<tbody id="ta-u-'+esc(u.id)+'">'+taSummaryRow(u)+'</tbody>';
}

/* ---- Add person ---- */
function taToggleForm(){TA.formOpen=!TA.formOpen;render()}
function taNewRole(role){
 TA.nw.role=role;if(role!=="Assignee")TA.nw.equipment_types=[];if(role!=="Site Engineer")TA.nw.plant="";
 const f=document.getElementById("ta-new-form");if(f)f.outerHTML=taAddForm();
}
function taNewScope(){
 const r=TA.nw.role,plants=taPlants();
 if(r==="Assignee")return '<div class="ta-form-scope"><div class="ta-form-label">Equipment types this person is responsible for <span>— covers every plant</span></div>'+taTypeBox("new")+'</div>';
 if(r==="Site Engineer")return '<div class="ta-form-scope"><div class="ta-form-label">Plant <span>— exactly one</span></div><select class="inp" style="min-width:260px" onchange="TA.nw.plant=this.value"><option value="">— select ONE plant —</option>'+plants.map(p=>'<option value="'+esc(p.dbId)+'"'+(TA.nw.plant===p.dbId?" selected":"")+'>'+esc(p.id+" · "+p.name)+'</option>').join("")+'</select></div>';
 return '<div class="ta-form-scope"><div class="ta-box" style="display:inline-flex"><b>All plants (portfolio)</b><span>'+(r==="O&M Head"?"Full administration":"Read-only portfolio view")+'</span></div></div>';
}
function taAddForm(){
 if(!TA.formOpen)return '<div id="ta-new-form" hidden></div>';
 return '<div id="ta-new-form" class="ta-form '+taRoleCls(TA.nw.role)+'"><div class="ta-form-row">'
  +'<div><div class="lbl">Name</div><input class="inp" style="width:170px" placeholder="Full name" value="'+esc(TA.nw.name)+'" oninput="TA.nw.name=this.value"></div>'
  +'<div><div class="lbl">Email (they must sign in with this)</div><input class="inp" style="width:240px" placeholder="name@company.com" value="'+esc(TA.nw.email)+'" oninput="TA.nw.email=this.value"></div>'
  +'<div><div class="lbl">Role</div><select class="inp ta-role-select" style="width:160px" onchange="taNewRole(this.value)">'+TA_ROLES.filter(r=>r!=="Viewer").map(r=>'<option'+(TA.nw.role===r?" selected":"")+'>'+esc(r)+'</option>').join("")+'</select></div>'
  +'<button class="btn p sm" onclick="taAddPerson()">Add person</button><button class="btn o sm" onclick="taToggleForm()">Cancel</button></div>'
  +taNewScope()
  +'<div class="ta-form-note">Assignees need one or more equipment types (for example Inverter) — they then own that equipment in every plant. Site Engineers need exactly one plant. Administration and O&amp;M Head see all plants.</div></div>';
}
async function taAddPerson(){
 const n=TA.nw,email=String(n.email||"").trim(),name=String(n.name||"").trim(),role=n.role;
 if(!email){toast("Enter the person's email.");return}
 const plant=taPlants().find(p=>p.dbId===n.plant);
 if(role==="Site Engineer"&&!plant){toast("Select the one plant for this Site Engineer.");return}
 if(role==="Assignee"&&!n.equipment_types.length){toast("Pick at least one equipment type for this Assignee.");return}
 try{
  const r=await apiFetch("/api/users/invite",{method:"POST",body:{name,email,role,plants:role==="Site Engineer"?[plant.id]:[],equipment:role==="Assignee"?n.equipment_types.slice():[]}});
  toast((r.status==="created"?"Added ":"Updated ")+(r.name||r.email)+" as "+r.role+(r.email_sent?" — invite email sent to "+r.email:r.invited?" — email NOT sent ("+(r.email_note||"unknown reason")+"). Tell them to sign in with "+r.email:""));
  TA.nw={name:"",email:"",role:"Assignee",plant:"",equipment_types:[]};
  TA.formOpen=false;await taLoad(true);
 }catch(e){toast("Not saved — "+e.message)}
}
async function taImportFile(inp){
 const f=inp.files&&inp.files[0];if(!f)return;
 const fd=new FormData();fd.append("file",f);
 try{
  const r=await apiFetch("/api/users/import",{method:"POST",body:fd});
  toast("Import done — "+r.created+" added, "+r.updated+" updated"+(r.errors.length?", "+r.errors.length+" skipped":""));
  if(r.errors.length)alert("These rows were skipped:\n\n"+r.errors.slice(0,30).map(e=>"Row "+e.row+" ("+(e.email||"?")+"): "+e.error).join("\n"));
  inp.value="";await taLoad(true);
 }catch(e){inp.value="";toast("Import failed — "+e.message)}
}

/* ---- panel ---- */
function teamAccessPanel(){
 if(AUTH_IDENTITY.role!=="O&M Head")return "";
 taLoad(false);
 const legend='<div class="ta-legend">'+TA_ROLES.map(r=>'<span class="ta-pill '+taRoleCls(r)+'">'+esc(r)+'</span>').join("")+'</div>';
 const head='<div style="padding:14px 16px 0"><h2 style="font-size:15px;font-weight:700">Team &amp; access</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 10px">New people sign in with Supabase Auth and wait here as <b>Viewer</b>. Choose their role, then Save. <b>Assignees</b> are given equipment types (e.g. Inverter) — every issue, schedule and washing job of that type, in all plants, goes to them. <b>Site Engineers</b> are tied to exactly one plant. Changes apply on their next screen load.</p>'+legend+'</div>';
 const wrap=b=>'<div class="panel no-stick ta-panel" style="padding:0">'+head+b+'</div>';
 if(TA.error)return wrap('<div style="padding:0 16px 16px"><div class="bn-warn banner">Could not load users: '+esc(TA.error)+'</div><button class="btn o sm" onclick="TA.error=null;taLoad(true)">Retry</button></div>');
 if(!TA.users)return wrap('<div style="padding:0 16px 16px;font-size:12px;color:var(--muted-foreground)">Loading team…</div>');
 const pending=TA.users.filter(u=>u.role==="Viewer"&&u.active).length;
 let rows=TA.users.slice().sort((a,b)=>(a.role==="Viewer"?0:1)-(b.role==="Viewer"?0:1)||String(a.name).localeCompare(String(b.name)));
 if(TA.filter==="pending")rows=rows.filter(u=>u.role==="Viewer");
 else if(TA.filter!=="all")rows=rows.filter(u=>u.role===TA.filter);
 const filt='<select class="inp" style="width:170px;font-size:12px" onchange="TA.filter=this.value;render()"><option value="all"'+(TA.filter==="all"?" selected":"")+'>All people ('+TA.users.length+')</option><option value="pending"'+(TA.filter==="pending"?" selected":"")+'>Pending ('+pending+')</option>'+TA_ROLES.filter(r=>r!=="Viewer").map(r=>'<option value="'+esc(r)+'"'+(TA.filter===r?" selected":"")+'>'+esc(r)+'</option>').join("")+'</select>';
 let h='<div style="padding:0 16px 10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">'+filt+(pending?'<span class="badge b-warning">'+pending+' waiting for a role</span>':'')+'<button class="btn o sm" onclick="taLoad(true)">Refresh</button><button class="btn p sm" onclick="taToggleForm()">+ Add person</button><button class="btn o sm" title="Columns: Name, Email, Role, Plants (Site Engineer) or Equipment types e.g. Inverter|Module (Assignee)" onclick="document.getElementById(\'ta-file\').click()">Import from Excel</button><input type="file" id="ta-file" accept=".xlsx,.xlsm,.csv" style="display:none" onchange="taImportFile(this)"></div>'+taAddForm();
 h+='<div class="ta-table-wrap" style="overflow:auto"><table class="dense ta-table"><thead><tr><th>Person</th><th>Role</th><th>Scope · equipment type / plant</th><th>Active</th><th>Status</th></tr></thead>';
 if(!rows.length)h+='<tbody><tr><td colspan="5" style="color:var(--muted-foreground);padding:14px">No people match this filter.</td></tr></tbody>';
 rows.forEach(u=>{h+=taUserBody(u)});
 h+='</table></div>';
 return wrap(h);
}


function renderSettings(){
 const matrix=(typeof REV05_PERMISSION_MATRIX!=="undefined"?REV05_PERMISSION_MATRIX:[]);
 return '<div class="ops-page ops-settings"><div class="ops-page-head"><div><div class="kpi-label">SOLAR OPERATIONS · ADMINISTRATION</div><h1>Settings</h1><p>Manage team access, operational roles, issue workflow and notification rules.</p></div><span class="ops-page-status"><i></i>Access controls</span></div>'+
  teamAccessPanel()+
  '<div class="panel ops-settings-panel"><div class="ops-section-head"><div><div class="kpi-label">ISSUE LIFECYCLE</div><h2>Issue workflow</h2></div><span class="ops-page-status"><i></i>Closed</span></div>'+wfStrip("Closed")+'<p class="ops-helper">OPEN → ASSIGNED → ACKNOWLEDGED → IN PROGRESS → RESOLVED → CLOSED</p></div>'+
  '<div class="panel no-stick ops-settings-panel ops-settings-table" style="padding:0"><div class="ops-section-head"><div><div class="kpi-label">ACCESS MODEL</div><h2>Role &amp; module permissions</h2><p>Server-managed permissions. Site Engineers are restricted to one assigned plant.</p></div></div><div class="ops-table-scroll"><table class="dense" style="min-width:1050px"><thead><tr><th>Role</th><th>Command Center</th><th>Plants</th><th>Site Issues</th><th>Preventive Maintenance</th><th>Work</th><th>Performance / Reports</th><th>Handover</th><th>Extra Services</th><th>Scope</th></tr></thead><tbody>'+matrix.map(r=>'<tr><td style="font-weight:700">'+esc(r.role)+'</td>'+r.modules.map(x=>'<td>'+esc(x)+'</td>').join("")+'<td>'+badge(r.scope)+'</td></tr>').join("")+'</tbody></table></div></div>'+
  '<div class="panel no-stick ops-settings-panel ops-settings-table" style="padding:0"><div class="ops-section-head"><div><div class="kpi-label">ALERTING</div><h2>Notification rules</h2></div><span class="ops-section-count">'+(S.rules||[]).filter(r=>r.on).length+' active</span></div><div class="ops-table-scroll"><table class="dense"><thead><tr><th>Event</th><th>Channel</th><th>To</th><th>On</th></tr></thead><tbody>'+(S.rules||[]).map(r=>'<tr><td>'+esc(r.event)+'</td><td>'+esc(r.channel)+'</td><td>'+esc(r.to)+'</td><td>'+(r.on?"On":"Off")+'</td></tr>').join("")+'</tbody></table></div></div></div>';
}

/* ---------------- 3. EXTRA SERVICES ---------------- */
const EXT_TABS=[["requests","Requests"],["inventory","3.2 Inventory"],["performance","3.3/3.4 Performance"],["safety","3.5 Safety"],["documents","3.6 Documents"],["vendors","3.7 Vendors"],["rules","3.8 Notifications"],["roles","3.9 Roles"],["reports","3.10 Reports"],["mobile","3.11 Mobile"],["audit","3.12 Audit"],["contracts","3.13 SLA"],["weather","3.14 Weather"]];
function serviceStatusRecords(sub){
 if(sub==="requests")return S.serviceRequests.map(x=>({status:x.status}));
 if(sub==="inventory")return S.inventory.map(x=>({status:x.qty<x.min?"Critical":"Available"}));
 if(sub==="performance")return S.plants.map(x=>({status:x.status}));
 if(sub==="safety")return S.ptw.map(x=>({status:x.status}));
 if(sub==="documents")return S.docs.map(x=>({status:!x.expires?"Available":dayDiff(TODAY,x.expires)<=30?"Due soon":"Compliant"}));
 if(sub==="vendors")return S.vendors.map(x=>{const v=vendorStats(x);return{status:v.onTime==null?"Available":v.onTime>=85?"On track":"Attention"}});
 if(sub==="mobile")return S.offlineQueue.map(x=>({status:x.status}));
 if(sub==="contracts")return S.sla.map(x=>({status:x.breach?"Breach":"Compliant"}));
 return [{status:"Active"}];
}
function renderServices(){
 const sub=S.extSub;
 let h='<div style="display:flex;flex-direction:column;gap:16px"><div class="tabs">'+EXT_TABS.map(t=>'<div class="tab '+(sub===t[0]?"active":"")+'" onclick="S.extSub=\''+t[0]+'\';render()">'+t[1]+'</div>').join("")+'</div>'+statusCircleCards("Extra Services status",serviceStatusRecords(sub));
 if(sub==="requests"){
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><h2 style="font-size:15px;font-weight:600">Extra service requests</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Estimate → approval → vendor assignment → execution → verification, with full history</p></div>';
  const lcR=listCtl("esr",S.serviceRequests,{facet:r=>r.status,facetLabel:"Status",text:r=>[r.id,r.project,r.category,r.provider,r.owner,r.status].join(" "),ph:"Search request, project or vendor"});h+=lcR.bar;
  h+='<table><thead><tr><th>Request</th><th>Project · category</th><th>Priority</th><th>Vendor / owner</th><th>Estimate</th><th>Progress</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
  lcR.rows.forEach(r=>{h+='<tr><td><div style="font-weight:600">'+r.id+'</div><div style="font-size:11px;color:var(--muted-foreground)">target '+fmtD(r.target)+'</div></td>'+
   '<td><div>'+esc(r.project)+'</div><div style="font-size:11px;color:var(--muted-foreground)">'+r.category+'</div></td><td>'+badge(r.priority)+'</td>'+
   '<td><div>'+esc(r.provider)+'</div><div style="font-size:11px;color:var(--muted-foreground)">owner '+esc(r.owner)+'</div></td><td>'+money(r.estimate)+'</td>'+
   '<td style="min-width:110px"><div style="font-size:11px;margin-bottom:4px">'+r.progress+'%</div><div class="prog"><div style="width:'+r.progress+'%;background:'+(r.progress===100?"var(--success)":"var(--primary)")+'"></div></div></td><td>'+badge(r.status)+'</td><td><div class="row" style="gap:5px;flex-wrap:wrap">';
   if(r.status==="Approval Pending")h+='<button class="btn p sm" onclick="approveESR(\''+r.id+'\')">'+I.check(12)+'Approve</button><button class="btn d sm" onclick="changeESR(\''+r.id+'\')">Changes</button>';
   if(["In Progress","Assigned"].includes(r.status)&&r.progress<100)h+='<button class="btn o sm" onclick="bumpESR(\''+r.id+'\')">+25%</button>';
   if(["In Progress","Assigned"].includes(r.status)&&r.progress>=100)h+='<button class="btn o sm" onclick="verifyESR(\''+r.id+'\')">'+I.bcheck(12)+'Verify</button>';
   h+='</div></td></tr>';});
  h+='</tbody></table>'+lcR.pager+'</div>';
 }
 if(sub==="inventory"){
  const low=S.inventory.filter(s=>s.qty<s.min);
  if(low.length)h+='<div class="bn-danger banner"><b>Low-stock alerts ('+low.length+')</b> — reorder workflow below. Auto-deduction is live: spare parts used against Issue tickets / Preventive Maintenance tasks decrement stock automatically (see movements log).</div>';
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><div class="row between wrap"><div><h2 style="font-size:15px;font-weight:600">Spares &amp; inventory per project / warehouse (3.2)</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Inverters, fuses, connectors, modules — with minimum levels and reorder</p></div><button class="btn p sm" onclick="openModal(&quot;newInventory&quot;)">+ Add stock item</button></div></div>';
  const lcS=listCtl("inv",S.inventory,{facet:s=>s.qty<s.min?"Low stock":"In stock",facetLabel:"Stock",text:s=>[s.item,s.cat,s.plant,s.store].join(" "),ph:"Search item, category or plant"});h+=lcS.bar;
  h+='<table><thead><tr><th>Item</th><th>Category</th><th>Plant / store</th><th>Stock</th><th>Min</th><th>Status</th><th>Action</th></tr></thead><tbody>';
  lcS.rows.forEach(s=>{const isLow=s.qty<s.min;
   h+='<tr><td style="font-weight:500">'+esc(s.item)+'</td><td>'+s.cat+'</td><td><div>'+esc(s.plant)+'</div><div style="font-size:11px;color:var(--muted-foreground)">'+s.store+'</div></td>'+
   '<td><b>'+s.qty+'</b> '+s.unit+'</td><td>'+s.min+'</td><td>'+(isLow?badge("Critical"):badge("Available"))+(s.onOrder?'<div style="margin-top:3px">'+badge("Ordered")+'</div>':'')+'</td>'+
   '<td>'+(isLow?'<button class="btn o sm" onclick="reorder(\''+s.id+'\')">'+(s.onOrder?"Receive reorder":"Raise reorder")+'</button>':"—")+'</td></tr>';});
  h+='</tbody></table>'+lcS.pager+'</div>';
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><h2 style="font-size:15px;font-weight:600">Stock movements</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Auto-deducted when spares are used against Issue tickets or Preventive Maintenance tasks</p></div>';
  const lcM=listCtl("mov",S.movements,{text:m=>[m.item,m.ref,m.by,m.note].join(" "),ph:"Search item, record or note"});h+=lcM.bar;
  h+='<table><thead><tr><th>When</th><th>Item</th><th>Qty</th><th>Linked record</th><th>By</th><th>Note</th></tr></thead><tbody>';
  lcM.rows.forEach(m=>{h+='<tr><td class="nowrap">'+m.at+'</td><td>'+esc(m.item)+'</td><td><b style="color:'+(m.qty<0?"var(--danger)":"var(--success)")+'">'+(m.qty>0?"+":"")+m.qty+'</b></td><td>'+esc(m.ref)+'</td><td>'+esc(m.by)+'</td><td style="font-size:11.5px;color:var(--muted-foreground)">'+esc(m.note)+'</td></tr>';});
  h+='</tbody></table>'+lcM.pager+'</div>';
 }
 if(sub==="performance"){
  h+='<div class="bn-info banner"><b>Performance data (3.3)</b> — The Excel DGR provides generation, capacity and PV Syst targets. PR, availability and alarm feeds are not in the workbook, so they show — until SCADA is connected. MTD vs PV Syst covers '+xlFmtD(XL_LAST.slice(0,7)+"-01")+' – '+xlFmtDY(XL_LAST)+'.</div>';
  const lcQ=listCtl("perf",S.plants,{size:8,facet:p=>{const m=xlPlantMtd(p.id);return m&&m.pct!=null?(m.pct>=100?"≥ 100% of PV Syst":m.pct>=90?"90 – 99%":"< 90%"):"No PV Syst target"},facetLabel:"MTD vs PV Syst",text:p=>p.name+" "+p.id,ph:"Search plant or site code",pad:"0 0 12px"});h+='<div class="panel">'+lcQ.bar+'<div class="kgrid" style="grid-template-columns:repeat(4,1fr)">'+lcQ.rows.map(p=>{const m=xlPlantMtd(p.id);return '<div class="metric"><div style="font-size:12px;font-weight:600">'+esc(p.name)+'</div><div style="font-size:11px;color:var(--muted-foreground);margin:2px 0 8px">'+capStr(p.capacity)+' · '+esc(p.id)+'</div>'+
   '<div class="col" style="gap:4px;font-size:12px"><div class="row between"><span class="muted">PR</span><b>'+xlPct(p.pr)+'</b></div>'+
   '<div class="row between"><span class="muted">Availability</span><b>'+xlPct(p.availability)+'</b></div><div class="row between"><span class="muted">Alarms</span><b>'+(p.alarms||"—")+'</b></div><div class="row between"><span class="muted">MTD vs PV Syst</span><b>'+(m&&m.pct!=null?m.pct+"%":"—")+'</b></div></div></div>'}).join("")+'</div>'+lcQ.pager+'</div>';
  const totPM=EQUIP_MTB.reduce((s,e)=>s+e.pm,0),totCM=EQUIP_MTB.reduce((s,e)=>s+e.cm,0);
  const ratio=(totPM+totCM)?Math.round(100*totPM/(totPM+totCM)):null;
  h+='<div class="panel"><h2 style="font-size:15px;font-weight:600">3.4 Preventive vs corrective analytics</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Ratio of planned (Preventive Maintenance) vs unplanned (Issues) work — a key O&amp;M health indicator — plus MTBF / MTTR by equipment type</p>';
  h+='<div class="kgrid" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px">'+
   '<div class="metric"><div class="k">PM : CM ratio</div><div class="v" style="color:'+(ratio!=null&&ratio>=70?"var(--success)":"var(--warning-strong)")+'">'+(ratio==null?'—':ratio+':'+(100-ratio))+'</div><div class="s">target ≥ 70:30</div></div>'+
   '<div class="metric"><div class="k">PM hours (30d)</div><div class="v">'+totPM+'</div><div class="s">scheduled O&amp;M effort</div></div>'+
   '<div class="metric"><div class="k">CM hours (30d)</div><div class="v">'+totCM+'</div><div class="s">issue-driven effort</div></div></div>';
  h+='<table><thead><tr><th>Equipment type</th><th>MTBF</th><th>MTTR</th><th>Failures (90d)</th><th>PM hrs</th><th>CM hrs</th><th>CM share</th></tr></thead><tbody>';
  EQUIP_MTB.forEach(e=>{const cm=Math.round(100*e.cm/(e.pm+e.cm));
   h+='<tr><td style="font-weight:500">'+e.type+'</td><td><b>'+(e.mtbf>=1000?(e.mtbf/24).toFixed(0)+" d":e.mtbf+" h")+'</b></td><td><b>'+(e.mttr>=48?(e.mttr/24).toFixed(1)+" d":e.mttr+" h")+'</b></td><td>'+e.fl+'</td><td>'+e.pm+'</td><td>'+e.cm+'</td>'+
   '<td style="min-width:130px"><div class="prog"><div style="width:'+cm+'%;background:'+(cm>50?"var(--danger)":cm>35?"var(--warning)":"var(--success)")+'"></div></div><div style="font-size:10.5px;color:var(--muted-foreground);margin-top:3px">'+cm+'% CM</div></td></tr>';});
  h+='</tbody></table></div>';
 }
 if(sub==="safety"){
  const pend=S.ptw.filter(p=>p.status==="Pending Approval");
  if(pend.length)h+='<div class="bn-warn banner"><b>'+pend.length+' PTW request(s) awaiting digital sign-off</b> — high-risk tasks (electrical, height work) stay blocked until approved. LOTO tracked per permit.</div>';
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><div class="row between wrap"><div><h2 style="font-size:15px;font-weight:600">Permit to Work / LOTO register (3.5)</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Digital sign-off before high-risk tasks; links to PTW flags on Preventive Maintenance tasks</p></div>'+
   '<button class="btn p sm" onclick="openModal(\'incident\')">+ Report incident / near-miss</button></div></div>';
  const lcP=listCtl("ptw",S.ptw,{facet:p=>p.status,facetLabel:"Status",text:p=>[p.id,p.task,p.plant,p.type,p.hazard,p.requestedBy].join(" "),ph:"Search permit, task or plant"});h+=lcP.bar;
  h+='<table><thead><tr><th>PTW</th><th>Task</th><th>Type / hazard</th><th>LOTO</th><th>Validity</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
  lcP.rows.forEach(p=>{h+='<tr><td style="font-weight:600">'+p.id+'</td><td><div style="font-weight:500">'+esc(p.task)+'</div><div style="font-size:11px;color:var(--muted-foreground)">'+esc(p.plant)+' · by '+esc(p.requestedBy)+'</div></td>'+
   '<td>'+p.type+'<div style="font-size:11px;color:var(--muted-foreground)">'+esc(p.hazard)+'</div></td><td>'+(p.loto?badge("Critical"):"—")+'</td>'+
   '<td style="font-size:11.5px" class="nowrap">'+fmtDT(p.validFrom)+'<br>→ '+fmtDT(p.validTo)+'</td><td>'+badge(p.status)+'</td><td><div class="row" style="gap:5px;flex-wrap:wrap">';
   if(p.status==="Pending Approval")h+='<button class="btn o sm" onclick="approvePTW(\''+p.id+'\',true)">'+I.fsig(12)+'Approve</button><button class="btn d sm" onclick="approvePTW(\''+p.id+'\',false)">Reject</button>';
   if(p.status==="Approved")h+='<button class="btn g sm" onclick="closePTW(\''+p.id+'\')">Close permit</button>';
   h+='</div></td></tr>';});
  h+='</tbody></table>'+lcP.pager+'</div>';
  h+='<div class="kgrid" style="grid-template-columns:1fr 1fr;align-items:start">';
  h+='<div class="panel"><h2 style="font-size:15px;font-weight:600">Safety incidents &amp; near-misses</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 10px">Separate register from equipment Issues</p>';
  const lcI=listCtl("inc",S.incidents,{size:3,facet:x=>x.severity,facetLabel:"Severity",text:x=>[x.id,x.type,x.desc,x.plant,x.by].join(" "),ph:"Search incident",pad:"0 0 10px"});h+=lcI.bar;
  lcI.rows.forEach(i=>{h+='<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px"><div class="row between wrap" style="gap:6px"><b style="font-size:12.5px">'+i.id+' · '+i.type+'</b>'+badge(i.severity)+'</div>'+
   '<div style="font-size:12px;margin-top:4px">'+esc(i.desc)+'</div><div style="font-size:11px;color:var(--muted-foreground);margin-top:4px">'+esc(i.plant)+' · '+i.at+' · by '+esc(i.by)+'</div>'+
   '<div style="font-size:11.5px;margin-top:4px;color:var(--success)"><b>Corrective:</b> '+esc(i.action)+'</div></div>';});
  h+=lcI.pager+'</div>';
  h+='<div class="panel"><h2 style="font-size:15px;font-weight:600">Statutory compliance watchlist</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 10px">Fire safety, electrical certificates, insurance — renewal reminders via 3.8</p>';
  const expSoon=S.docs.filter(d=>d.expires&&dayDiff(TODAY,d.expires)<=30);
  h+=expSoon.length?expSoon.map(d=>'<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--border);font-size:12.5px;gap:8px"><div><div>'+esc(d.name)+'</div><div style="font-size:11px;color:var(--muted-foreground)">'+esc(d.plant)+'</div></div>'+badge(dayDiff(TODAY,d.expires)+"d left")+'</div>').join(""):'<div style="font-size:12px;color:var(--muted-foreground)">Nothing inside 30 days.</div>';
  h+='<div style="font-size:12px;color:var(--muted-foreground);margin-top:10px">Quarterly audit checklist (fire safety, electrical certificates, PTW compliance) exports in the Monthly compliance pack (3.10).</div></div></div>';
 }
 if(sub==="documents"){
  const sorted=S.docs.slice().sort((a,b)=>(a.expires||"9999")<(b.expires||"9999")?-1:1);
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><div class="row between wrap"><div><h2 style="font-size:15px;font-weight:600">Central document repository (3.6)</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">O&amp;M manuals, warranties, as-builts, compliance certificates — with expiry tracking and automated renewal reminders. Handover Completion Certificates (1.4) land here automatically.</p></div><button class="btn p sm" onclick="openModal(&quot;newDocument&quot;)">+ Add document</button></div></div>';
  const lcD=listCtl("doc",sorted,{facet:d=>d.type,facetLabel:"Type",text:d=>[d.name,d.type,d.plant,d.owner].join(" "),ph:"Search document, plant or owner"});h+=lcD.bar;
  h+='<table><thead><tr><th>Document</th><th>Type</th><th>Plant</th><th>Owner</th><th>Expires</th><th>Countdown</th><th>Action</th></tr></thead><tbody>';
  lcD.rows.forEach(d=>{const dd=d.expires?dayDiff(TODAY,d.expires):null;
   h+='<tr><td style="font-weight:500">'+esc(d.name)+'</td><td>'+d.type+'</td><td>'+esc(d.plant)+'</td><td>'+esc(d.owner)+'</td><td>'+(d.expires?fmtDate(d.expires):"—")+'</td>'+
   '<td>'+(dd===null?badge("—"):dd<0?badge("Expired"):dd<=30?badge(dd+" days"):badge("OK"))+'</td>'+
   '<td>'+(d.expires?'<button class="btn g sm" onclick="renewDoc(\''+d.id+'\')">Record renewal</button>':"—")+'</td></tr>';});
  h+='</tbody></table>'+lcD.pager+'</div>';
 }
 if(sub==="vendors"){
  h+='<div class="panel"><div class="row between wrap"><div><h2 style="font-size:15px;font-weight:600">Vendor &amp; contractor management (3.7)</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Third-party vendors — washing contractors, security agencies, OEM service partners — with SLAs, contracts and performance ratings. Feeds Vendor-Dependent tagging on Issues (2.3.2).</p></div><button class="btn p sm" onclick="openModal(&quot;newVendor&quot;)">+ Add vendor</button></div>';
  const lcV=listCtl("ven",S.vendors,{size:4,facet:v=>v.type,facetLabel:"Type",text:v=>[v.name,v.type,v.scope].join(" "),ph:"Search vendor or scope",pad:"0 0 12px"});h+=lcV.bar;
  h+='<div class="kgrid" style="grid-template-columns:repeat(2,1fr)">';
  lcV.rows.forEach(v=>{const vs=vendorStats(v),on=vs.onTime;h+='<div class="metric"><div class="row between wrap" style="gap:6px"><div><div style="font-weight:700;font-size:13.5px">'+esc(v.name)+'</div><div style="font-size:11px;color:var(--muted-foreground)">'+v.type+' · '+esc(v.scope)+'</div></div></div>'+
   '<div class="col" style="gap:4px;margin-top:10px;font-size:12px"><div class="row between"><span class="muted">SLA</span><b>'+esc(v.sla||"—")+'</b></div>'+
   '<div class="row between"><span class="muted">Contract end</span><b>'+(v.contractEnd?fmtDate(v.contractEnd):"—")+'</b></div><div class="row between"><span class="muted">Vendor tickets</span><b>'+vs.jobs+'</b></div>'+
   '<div class="row between"><span class="muted">On-time (closed tickets)</span><b style="color:'+(on==null?"var(--muted-foreground)":on>=85?"var(--success)":"var(--danger)")+'">'+(on==null?"—":on+"%")+'</b></div>'+
   '<div class="prog"><div style="width:'+(on==null?0:on)+'%;background:'+(on!=null&&on>=85?"var(--success)":"var(--danger)")+'"></div></div></div>'+
   (on!=null&&on<85?'<div style="font-size:11px;color:var(--warning-strong);font-weight:600;margin-top:8px">⚠ Derived from actual vendor-linked ticket ETC performance</div>':'')+'</div>';});
  h+='</div>'+lcV.pager+'</div>';
 }
 if(sub==="rules"){
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><h2 style="font-size:15px;font-weight:600">Notification &amp; escalation engine (3.8)</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Configurable rules across all modules — channel (app/SMS/email/call), recipients by role, escalation tiers by time elapsed. Powers every alert in the bell. The live alerts you see in the bell (SLA breaches, task escalations, washing compliance, low stock, document expiry) are generated by these rules.</p></div>';
  h+='<table><thead><tr><th></th><th>Event</th><th>Channel</th><th>Recipients</th><th>Escalation tiers</th></tr></thead><tbody>';
  S.rules.forEach(r=>{h+='<tr><td><button onclick="toggleRule(\''+r.id+'\')" style="width:34px;height:19px;border-radius:999px;background:'+(r.on?"var(--success)":"var(--input)")+';border:none;cursor:pointer;position:relative"><span style="position:absolute;top:2px;left:'+(r.on?17:2)+'px;width:15px;height:15px;border-radius:999px;background:#fff;transition:.15s"></span></button></td>'+
   '<td style="font-weight:500">'+esc(r.event)+'</td><td>'+r.channel+'</td><td>'+esc(r.to)+'</td><td style="font-size:11.5px;color:var(--muted-foreground)">'+esc(r.tiers)+'</td></tr>';});
  h+='</tbody></table></div>';
 }
 if(sub==="roles"){
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><h2 style="font-size:15px;font-weight:600">Roles &amp; permissions (3.9)</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Role-based access control with configurable approval hierarchies per project or client contract. Current login: '+OM_HEAD+' — O&amp;M Head (portfolio scope).</p></div>';
  h+='<table><thead><tr><th>Role</th><th>Handover</th><th>Preventive Maintenance</th><th>Washing</th><th>Issues</th><th>Documents</th><th>Scope</th></tr></thead><tbody>';
  ROLES.forEach(r=>{h+='<tr><td style="font-weight:600" class="nowrap">'+r.role+'</td><td>'+r.handover+'</td><td>'+r.sched+'</td><td>'+r.washing+'</td><td>'+r.issues+'</td><td>'+r.docs+'</td><td>'+badge(r.scope)+'</td></tr>';});
  h+='</tbody></table></div>';
 }
 if(sub==="reports"){
  h+='<div class="panel"><h2 style="font-size:15px;font-weight:600">Reporting suite (3.10)</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Scheduled auto-reports emailed to stakeholders; client-facing templates match O&amp;M contract SLAs (useful for billing / penalty clauses)</p><div class="col" style="gap:10px">';
  [["Daily operations snapshot","Daily 18:00","O&M Head, regional heads","Generation, PR, open issues, wash progress"],
   ["Weekly client report — per plant","Weekly Mon 08:00","Client / asset owners","Wash compliance, PM adherence, issue summary with SLA status"],
   ["Monthly O&M compliance pack","Monthly 1st","All clients","Scheduled compliance, washing, incidents, PR vs target"],
   ["Handover status digest","Weekly Fri 16:00","O&M Head","Pending handovers, blocked items, escalations"]].forEach(r=>{
   h+='<div class="row between wrap" style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;gap:10px"><div><div style="font-weight:600;font-size:13px">'+r[0]+'</div><div style="font-size:11px;color:var(--muted-foreground)">'+r[1]+' → '+r[2]+' · '+r[3]+'</div></div>'+
    '<button class="btn o sm" onclick="toast(\''+esc(r[0])+' — generated &amp; emailed to '+esc(r[2])+'.\')">Run now</button></div>';});
  h+='</div></div>';
 }
 if(sub==="mobile"){
  h+='<div class="bn-info banner"><b>Offline-capable field app (3.11)</b> — technicians log washing, complete Preventive Maintenance work and raise/update Site Issues in low-connectivity plant areas; everything syncs once back online.</div>';
  h+='<div class="kgrid" style="grid-template-columns:1fr 1fr;align-items:start">';
  h+='<div class="panel"><div class="row between" style="margin-bottom:10px"><h2 style="font-size:15px;font-weight:600">Sync queue — today</h2><button class="btn p sm" onclick="syncQueue()">Sync now</button></div>';
  S.offlineQueue.forEach(q=>{h+='<div class="row" style="gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--border)"><span class="dot" style="background:'+(q.status==="Queued"?"var(--warning)":"var(--success)")+';margin-top:5px"></span>'+
   '<div style="flex:1;font-size:12.5px">'+esc(q.action)+'<div style="font-size:11px;color:var(--muted-foreground);margin-top:2px">'+esc(q.user)+' · '+q.at+' · '+badge(q.status)+'</div></div></div>';});
  h+='</div><div class="panel"><h2 style="font-size:15px;font-weight:600">Field capabilities</h2><div class="col" style="gap:9px;font-size:12.5px;margin-top:8px">'+
   '<div>🪣 <b>Washing:</b> per-table &amp; bulk entry with date stamps; rain exceptions with reason codes</div>'+
   '<div>🔧 <b>Preventive Maintenance:</b> start tasks, submit completion with sub-steps, readings &amp; photos</div>'+
   '<div>🐞 <b>Issues:</b> raise tickets on the go with photos, severity &amp; ETC; add progress from the field</div>'+
   '<div>🦺 <b>Safety:</b> PTW sign-off requests and near-miss reporting from site</div>'+
   '<div>🌦️ <b>Weather:</b> rain warnings pushed to washing crews (3.14)</div></div></div></div>';
 }
 if(sub==="audit"){
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><h2 style="font-size:15px;font-weight:600">Immutable audit trail (3.12)</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Every status change, assignment, approval and edit across Handover, Preventive Maintenance, Washing and Issues — with user, timestamp, and before/after values — for accountability and dispute resolution.</p></div>';
  h+='<table><thead><tr><th>When</th><th>Module</th><th>Event</th><th>User</th><th>Before → After</th></tr></thead><tbody>';
  S.audit.forEach(a=>{const moduleName=a.module==="Scheduled O&M"?"Preventive Maintenance":a.module;h+='<tr><td class="nowrap">'+a.at+'</td><td>'+badge("Internal")+' '+esc(moduleName)+'</td><td>'+esc(a.text)+'</td><td>'+esc(a.user)+'</td><td style="font-size:11.5px;color:var(--muted-foreground)">'+esc(a.before)+' → <b>'+esc(a.after)+'</b></td></tr>';});
  h+='</tbody></table></div>';
 }
 if(sub==="contracts"){
  const breaches=S.sla.filter(c=>slaLive(c).breach);
  if(breaches.length)h+='<div class="bn-danger banner"><b>Contract breach watch ('+breaches.length+')</b> — '+breaches.map(s=>esc(s.project)+" · "+esc(s.name||s.term||"SLA")).join(" · ")+'. Compliance is tracked against the actual contract, not just internal targets.</div>';
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><div class="row between wrap"><div><h2 style="font-size:15px;font-weight:600">SLA &amp; contract management (3.13)</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">O&amp;M contract terms mapped to actual ticket ETC and washing records using the selected Operations date.</p></div><button class="btn p sm" onclick="openModal(&quot;newSLA&quot;)">+ Add SLA contract</button></div></div>';
  h+='<table><thead><tr><th>Plant</th><th>Contract</th><th>Resolution targets</th><th>Washing</th><th>Live status</th><th>Actual ticket compliance</th></tr></thead><tbody>';
  S.sla.forEach(c=>{const live=slaLive(c);h+='<tr><td>'+esc(c.project)+'</td><td style="font-weight:500">'+esc(c.name||"O&M SLA")+'</td><td style="font-size:11.5px">Critical '+(c.critical||24)+'h · Medium '+(c.medium||120)+'h · Low '+(c.low||240)+'h</td><td>'+(c.washDays?esc(c.washDays)+" days":"—")+'</td>'+
   '<td>'+(live.breach?badge("Breached"):badge("Compliant"))+'<div class="muted" style="font-size:10.5px;margin-top:3px">'+live.issueBreaches+' ticket · '+live.washBreaches+' wash breach(es)</div></td>'+
   '<td style="min-width:120px">'+(live.metPct==null?'—':'<div style="font-size:11px;margin-bottom:4px"><b>'+live.metPct+'%</b></div><div class="prog"><div style="width:'+live.metPct+'%;background:'+(live.metPct>=90?"var(--success)":live.metPct>=75?"var(--warning)":"var(--danger)")+'"></div></div>')+'</td></tr>';});
  h+='</tbody></table></div>';
 }
 if(sub==="weather"){
  h+='<div class="panel"><h2 style="font-size:15px;font-weight:600">Weather integration (3.14)</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Local weather (rain, forecast) pulled automatically to pre-flag washing exceptions and help plan Preventive Maintenance around weather windows</p>';
  h+='<div class="kgrid" style="grid-template-columns:repeat(2,1fr)">';
  if(!WEATHER.length)h+='<div style="grid-column:1/-1;font-size:12px;color:var(--muted-foreground);padding:8px">No weather feed connected — connect a forecast provider to pre-flag washing exceptions.</div>';
  WEATHER.forEach(w=>{const rd=w.f.findIndex(r=>r>=60);
   h+='<div class="metric"><div class="row between" style="align-items:center"><div style="font-weight:700;font-size:13.5px">'+esc(w.plant)+'</div><span style="font-size:11px;color:var(--muted-foreground)">Today: '+w.today+'</span></div>';
   h+='<div class="row" style="gap:5px;margin-top:10px">'+w.f.map((r,i)=>'<div style="flex:1;text-align:center;border:1px solid var(--border);border-radius:8px;padding:6px 2px;background:'+(r>=60?"var(--info-soft)":r>=30?"var(--warning-soft)":"var(--card)")+'"><div style="font-size:10px;color:var(--muted-foreground)">D+'+(i+1)+'</div><div style="font-size:11px;font-weight:600;color:'+(r>=60?"var(--info)":r>=30?"var(--warning-strong)":"var(--muted-foreground)")+'">'+r+'%</div></div>').join("")+'</div>';
   h+=rd>-1?'<div style="font-size:11.5px;margin-top:8px;color:var(--info);font-weight:600">🌧 Rain likely D+'+(rd+1)+' ('+w.f[rd]+'%) — washing crews pre-warned; rain exceptions will auto-suggest reschedule instead of counting as misses.</div>':'<div style="font-size:11.5px;margin-top:8px;color:var(--success);font-weight:600">Clear window — good week to clear red-zone washing backlog.</div>';
   h+='</div>';});
  h+='</div></div>';
 }
 return h+'</div>';
}
