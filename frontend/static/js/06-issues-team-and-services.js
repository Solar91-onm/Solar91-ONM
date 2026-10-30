"use strict";
/* ---------------- 2.3 ISSUES ---------------- */
/* Workload of the people who own work: every active Assignee (issues and PM jobs are assigned to the Assignee role),
   plus any other name that still appears as an owner on older records. */
function engineerLoad(){
 const names=new Set(TEAM_POOL);
 (S.issues||[]).forEach(t=>{if(t.assignee)names.add(t.assignee)});
 return [...names].map(n=>{const rows=(S.issues||[]).filter(t=>t.assignee===n);const open=openTk(rows);const tasks=(S.tasks||[]).filter(t=>t.assignee===n&&t.status!=="Completed"&&t.status!=="Cancelled");
  return{name:n,assigned:open.length,critical:open.filter(t=>t.severity==="Critical").length,overdue:open.filter(isOverdueIssue).length,progress:open.filter(t=>t.status==="In Progress").length,resolved:rows.filter(t=>t.status==="Resolved"||t.status==="Closed").length,tasks:tasks.length,tasksLate:tasks.filter(t=>typeof taskOD==="function"&&taskOD(t)>0).length,rows}})
  .sort((a,b)=>b.assigned-a.assigned||b.critical-a.critical||b.tasks-a.tasks||a.name.localeCompare(b.name))}


function reportRowsForHub(kind){
 const open=openTk(S.issues||[]);
 if(kind==="daily"||kind==="weekly"||kind==="monthly"){const n=kind==="daily"?1:kind==="weekly"?7:30,from=addDays(TODAY,1-n);
  const raised=(S.issues||[]).filter(t=>issueDay(t)>=from);const closed=(S.issues||[]).filter(t=>t.closure&&String(t.closure.closedAt||"").slice(0,10)>=from);
  return{title:kind[0].toUpperCase()+kind.slice(1)+" O&M summary",cols:["Metric","Value"],rows:[["Period",from+" → "+TODAY],["Issues raised",raised.length],["Resolved / closed",closed.length],["Still open",open.length],["Overdue",open.filter(isOverdueIssue).length],["Unassigned",open.filter(t=>!t.assignee).length],["Critical open",open.filter(isCriticalIssue).length]]};}
 if(kind==="open")return{title:"Open issues",cols:["Issue","Plant","Priority","Status","Assignee","Age"],rows:open.map(t=>[t.id,t.plant,t.severity,t.status,t.assignee||"Unassigned",ageBucket(t)])};
 if(kind==="overdue")return{title:"Overdue issues",cols:["Issue","Plant","Priority","Assignee","Age"],rows:open.filter(isOverdueIssue).map(t=>[t.id,t.plant,t.severity,t.assignee||"Unassigned",ageBucket(t)])};
 if(kind==="work")return{title:"Assignee workload",cols:["Assignee","Assigned","Critical","Overdue","In progress","Resolved"],rows:engineerLoad().map(r=>[r.name,r.assigned,r.critical,r.overdue,r.progress,r.resolved])};
 if(kind==="plants")return{title:"Plant issue summary",cols:["Plant","Site","Open","Critical","Engineer","Health"],rows:S.plants.map(p=>{const oi=open.filter(t=>t.plant===p.name);return[p.name,p.id,oi.length,oi.filter(isCriticalIssue).length,plantEngineer(p)||"—",plantHealth(p)]})};
 const mk={};(S.issues||[]).forEach(t=>{const k=(t.equip||"—")+" / "+(t.maker||"unspecified");mk[k]=(mk[k]||0)+1});
 return{title:"Equipment / maker issue summary",cols:["Equipment / maker","Issues"],rows:Object.entries(mk).sort((a,b)=>b[1]-a[1])};
}

/* ---------- TEAM & ACCESS (O&M Head assigns roles · Assignees get EQUIPMENT across plants · Site Engineers get ONE plant) ---------- */
const TA_ROLES=["O&M Head","Assignee","Administration","Site Engineer","Viewer"];
const TA_ROLE_HELP={"O&M Head":"Full administration, all plants","Assignee":"O&M team — owns chosen equipment types (e.g. Inverter) across ALL plants","Administration":"Read-only Command Center and reports","Site Engineer":"Exactly ONE plant, own-plant workflow","Viewer":"Pending — no access until a role is assigned"};
const TA_ROLE_CLS={"O&M Head":"om-head","Assignee":"assignee","Administration":"ceo-cto","Site Engineer":"site-engineer","Viewer":"viewer"};
/* TA_PAGE bounds how many people are drawn at once: every row carries dropdowns, so drawing hundreds made each redraw slow. */
const TA_PAGE=50;
const TA={users:null,loading:false,error:null,draft:{},open:{},q:{},selOnly:{},filter:"all",search:"",limit:TA_PAGE,edit:{},saving:{},formOpen:false,nw:{name:"",email:"",role:"Assignee",plant:"",equipment_types:[]}};

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
/* plant <option> list built once per plant list (not once per Site Engineer row); `sel` marks the chosen plant */
function taPlantOptions(sel){
 const plants=taPlants();
 if(TA._plOptsSrc!==plants){TA._plOptsSrc=plants;TA._plOpts=plants.map(p=>'<option value="'+esc(p.dbId)+'">'+esc(p.id+" · "+p.name)+'</option>').join("")}
 if(!sel)return TA._plOpts;
 const tag='<option value="'+esc(sel)+'">';
 return TA._plOpts.replace(tag,tag.slice(0,-1)+' selected>');
}
function taFillPlants(el){
 if(el.dataset.full)return;
 const v=el.value;el.dataset.full="1";
 el.innerHTML='<option value="">— select ONE plant —</option>'+taPlantOptions(v);el.value=v;
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
function taSummaryText(types){const wash=types.includes("Modules cleaning"),eq=types.length-(wash?1:0);return types.length?(eq?eq+" equipment type"+(eq===1?"":"s"):"")+(wash?(eq?" + ":"")+"washing":"")+" · all plants":"No equipment type selected"}

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
  const r=await apiFetch("/api/users/"+encodeURIComponent(id)+"/access",{method:"PUT",body:{role:d.role,plant_ids,equipment_types}});
  toast((u.name||u.email||"User")+" is now "+d.role+(plant_ids.length?" · 1 plant":"")+(d.role==="Assignee"?" · "+equipment_types.length+" equipment type"+(equipment_types.length===1?"":"s")+" across all plants":""));
  /* the reply is the saved row: update this one person instead of reloading everyone (which also dropped other rows' unsaved edits) */
  const pl=taPlants();
  taMerge(id,{role:r.role,active:r.active,equipment_types:(r.equipment_types||[]).slice().sort(),
   plants:(r.plant_ids||[]).map(pid=>{const p=pl.find(x=>x.dbId===pid);return {plant_id:pid,site_code:p?p.id:"",plant_name:p?p.name:""}})});
  delete TA.draft[id];TA.saving[id]=false;render();
 }catch(e){TA.saving[id]=false;toast("Not saved — "+e.message);taRefreshRow(id)}
}
function taMerge(id,patch){
 const i=(TA.users||[]).findIndex(x=>x.id===id);
 if(i>=0)TA.users[i]=Object.assign({},TA.users[i],patch);
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
 try{const r=await apiFetch("/api/users/"+encodeURIComponent(id)+"/active",{method:"PATCH",body:{is_active:on}});toast((on?"Activated ":"Deactivated ")+(u.name||u.email));taMerge(id,{active:r.active});render()}
 catch(e){toast("Not changed — "+e.message)}
}

/* ---- correct a person's name / email (email only before their first sign-in) ---- */
function taEditStart(id){
 const u=taUser(id);if(!u)return;
 TA.edit[id]={name:u.name||"",email:u.email||""};taRefreshRow(id);
 setTimeout(()=>{const e=document.getElementById("ta-en-"+id);if(e){e.focus();e.select()}},0);
}
function taEditCancel(id){delete TA.edit[id];taRefreshRow(id)}
function taEditKey(e,id){if(e.key==="Enter"){e.preventDefault();taSaveProfile(id)}else if(e.key==="Escape")taEditCancel(id)}
async function taSaveProfile(id){
 const u=taUser(id),ed=TA.edit[id],key="profile:"+id;
 if(!u||!ed||TA.saving[key])return;
 const name=String(ed.name||"").replace(/\s+/g," ").trim(),email=String(ed.email||"").trim();
 const nameChanged=name!==(u.name||""),emailChanged=!!u.invited&&email!==(u.email||"");
 if(!name){toast("Name cannot be empty.");return}
 if(emailChanged&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){toast("Enter a valid email address.");return}
 if(!nameChanged&&!emailChanged){taEditCancel(id);toast("Nothing changed.");return}
 const body={expected_name:u.name||"",expected_email:u.email||""};
 if(nameChanged)body.name=name;
 if(emailChanged)body.email=email;
 TA.saving[key]=true;taRefreshRow(id);
 try{
  const r=await apiFetch("/api/users/"+encodeURIComponent(id)+"/profile",{method:"PATCH",body});
  taMerge(id,{name:r.name,email:r.email,invited:r.invited,active:r.active,role:r.role});
  delete TA.edit[id];TA.saving[key]=false;
  if(nameChanged)taRenameLocal(id,u.name,r.name);
  render();
  toast("Saved "+r.name+(nameChanged&&r.renamed_assignments?" — name updated on "+r.renamed_assignments+" assigned ticket"+(r.renamed_assignments===1?"":"s")+"/task"+(r.renamed_assignments===1?"":"s"):"")
   +(emailChanged?(r.email_sent?" — new invite sent to "+r.email:" — invite email NOT sent ("+(r.email_note||"unknown reason")+"). Tell them to sign in with "+r.email):""));
 }catch(e){
  TA.saving[key]=false;toast("Not saved — "+e.message);
  if(e.status===409&&/changed by someone else/i.test(e.message)){delete TA.edit[id];taLoad(true)}else taRefreshRow(id);
 }
}
/* The server renamed the person's tickets/tasks; mirror that in memory so open lists show the new name without a reload. */
function taRenameLocal(id,oldName,newName){
 const was=String(oldName||"").trim().toLowerCase(),fix=t=>String(t||"").trim().toLowerCase()===was;
 (S.issues||[]).forEach(t=>{if(t.assignedTo===id&&fix(t.assignee))t.assignee=newName});
 (S.tasks||[]).forEach(t=>{if(t.assigneeUserId===id&&fix(t.assignee))t.assignee=newName});
 if(typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.userId===id)AUTH_IDENTITY.name=newName;
 if(typeof refreshTeamPool==="function")refreshTeamPool().catch(()=>{});
}

/* ---- equipment TYPE selector (shared by the user rows and the Add-person form) ----
   Washing is given to an Assignee like any equipment type: "Modules cleaning" shows as "Washing (module cleaning)" and is listed first. */
const TA_WASHING_TYPE="Modules cleaning";
function taTypeLabel(t){return t===TA_WASHING_TYPE?"💧 Washing (module cleaning)":t}
function taTypeSelect(key){
 const have=new Set(taEqIds(key)),list=VERTICALS.filter(t=>!have.has(t));
 const wash=list.includes(TA_WASHING_TYPE)?'<optgroup label="Washing"><option value="'+esc(TA_WASHING_TYPE)+'">'+esc(taTypeLabel(TA_WASHING_TYPE))+'</option></optgroup>':'';
 return '<select class="inp ta-eq-select" aria-label="Select equipment type or washing" onchange="taPickType(\''+esc(key)+'\',this.value)"><option value="">＋ Select equipment type or washing…</option>'
  +wash+'<optgroup label="Equipment">'+list.filter(t=>t!==TA_WASHING_TYPE).map(t=>'<option value="'+esc(t)+'">'+esc(t)+'</option>').join("")+'</optgroup></select>';
}
function taTypeChips(key){
 const ids=taEqIds(key);
 return ids.map(t=>'<span class="ta-chip '+(t===TA_WASHING_TYPE?"pc-wash":"pc0")+'" title="'+(t===TA_WASHING_TYPE?"Plant washing at every plant":"All "+esc(t)+" across all plants")+'"><i></i>'+esc(taTypeLabel(t))+' · all plants<button type="button" class="ta-x" aria-label="Remove '+esc(t)+'" onclick="taToggleEq(\''+esc(key)+'\',\''+esc(t)+'\',false)">×</button></span>').join("");
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
  /* only the chosen plant is drawn; the full list is filled in when the dropdown is opened (taFillPlants) */
  return '<div class="ta-box'+(cur?"":" warn")+'"><select class="inp" style="min-width:230px;font-size:12px" aria-label="Plant for this Site Engineer" onfocus="taFillPlants(this)" onpointerdown="taFillPlants(this)" onchange="taSetOnePlant(\''+id+'\',this.value)"><option value="">— select ONE plant —</option>'+(cur?'<option value="'+esc(cur.dbId)+'" selected>'+esc(cur.id+" · "+cur.name)+'</option>':'')+'</select>'
   +(cur?'<span class="ta-chip '+taPlantCls(cur.dbId)+'"><i></i>'+esc(cur.id+" · "+cur.name)+'</span>':'<span>A Site Engineer must have exactly one plant</span>')+'</div>';
 }
 /* Assignee → equipment types across all plants */
 return taTypeBox(u.id);
}

/* ---- one person = one <tbody> holding a summary row + a (hidden until opened) equipment-picker row ---- */
function taPersonCell(u,ini){
 const id=esc(u.id),ed=TA.edit[u.id];
 if(!ed)return '<td><div class="ta-person"><span class="ta-av">'+esc(ini)+'</span><div><div class="ta-name">'+esc(u.name||"—")+(u.is_self?' <span class="badge b-info">You</span>':"")+(u.invited?' <span class="badge b-warning">Not Signed In Yet</span> ':"")+'</div><div class="ta-mail">'+esc(u.email||"")+'</div>'
  +'<button type="button" class="ta-edit-link" title="Correct this person\'s name'+(u.invited?' or email':'')+'" onclick="taEditStart(\''+id+'\')">✎ Edit details</button></div></div></td>';
 const busy=!!TA.saving["profile:"+u.id];
 return '<td><div class="ta-edit">'
  +'<label class="lbl" for="ta-en-'+id+'">Name</label><input id="ta-en-'+id+'" class="inp" maxlength="255" autocomplete="off" value="'+esc(ed.name)+'" oninput="TA.edit[\''+id+'\'].name=this.value" onkeydown="taEditKey(event,\''+id+'\')"'+(busy?' disabled':'')+'>'
  +'<label class="lbl" for="ta-ee-'+id+'">Email</label><input id="ta-ee-'+id+'" class="inp" type="email" maxlength="240" autocomplete="off" autocapitalize="off" spellcheck="false" value="'+esc(ed.email)+'"'
  +(u.invited&&!busy?' oninput="TA.edit[\''+id+'\'].email=this.value" onkeydown="taEditKey(event,\''+id+'\')"':' disabled')+'>'
  +'<div class="ta-help">'+(u.invited?'Not signed in yet. Fixing the email sends a fresh invite to the new address.':'Email is locked: they sign in with this verified address.')+'</div>'
  +'<div class="ta-edit-actions"><button type="button" class="btn p sm" '+(busy?'disabled aria-busy="true" ':'')+'onclick="taSaveProfile(\''+id+'\')">'+(busy?'Saving…':'Save')+'</button><button type="button" class="btn o sm" '+(busy?'disabled ':'')+'onclick="taEditCancel(\''+id+'\')">Cancel</button></div></div></td>';
}
function taSummaryRow(u){
 const d=taDraft(u),dirty=taDirty(u),busy=!!TA.saving[u.id],id=esc(u.id);
 const ini=String(u.name||u.email||"?").trim().split(/[\s@._-]+/).filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase()||"?";
 return '<tr class="ta-row '+taRoleCls(d.role)+(dirty?" dirty":"")+(u.active?"":" off")+'" id="ta-row-'+id+'">'
  +taPersonCell(u,ini)
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
 const r=TA.nw.role;
 if(r==="Assignee")return '<div class="ta-form-scope"><div class="ta-form-label">Equipment types this person is responsible for <span>— covers every plant</span></div>'+taTypeBox("new")+'</div>';
 if(r==="Site Engineer")return '<div class="ta-form-scope"><div class="ta-form-label">Plant <span>— exactly one</span></div><select class="inp" style="min-width:260px" onchange="TA.nw.plant=this.value"><option value="">— select ONE plant —</option>'+taPlantOptions(TA.nw.plant)+'</select></div>';
 return '<div class="ta-form-scope"><div class="ta-box" style="display:inline-flex"><b>All plants (portfolio)</b><span>'+(r==="O&M Head"?"Full administration":"Read-only portfolio view")+'</span></div></div>';
}
function taAddForm(){
 if(!TA.formOpen)return '<div id="ta-new-form" hidden></div>';
 return '<div id="ta-new-form" class="ta-form '+taRoleCls(TA.nw.role)+'"><div class="ta-form-row">'
  +'<div><div class="lbl">Name</div><input class="inp" style="width:170px" placeholder="Full name" value="'+esc(TA.nw.name)+'" oninput="TA.nw.name=this.value"></div>'
  +'<div><div class="lbl">Email (they must sign in with this)</div><input class="inp" style="width:240px" placeholder="name@company.com" value="'+esc(TA.nw.email)+'" oninput="TA.nw.email=this.value"></div>'
  +'<div><div class="lbl">Role</div><select class="inp ta-role-select" style="width:160px" onchange="taNewRole(this.value)">'+TA_ROLES.filter(r=>r!=="Viewer").map(r=>'<option'+(TA.nw.role===r?" selected":"")+'>'+esc(r)+'</option>').join("")+'</select></div>'
  +'<button class="btn p sm" '+(TA.adding?'disabled aria-busy="true"':'')+' onclick="taAddPerson()">'+(TA.adding?'<span class="gx-spin" aria-hidden="true"></span> Adding…':'Add person')+'</button><button class="btn o sm" onclick="taToggleForm()">Cancel</button></div>'
  +taNewScope()
  +'<div class="ta-form-note">Assignees need one or more equipment types (for example Inverter) — they then own that equipment in every plant. Site Engineers need exactly one plant. Administration and O&amp;M Head see all plants.</div></div>';
}
async function taAddPerson(){
 if(TA.adding)return;
 const n=TA.nw,email=String(n.email||"").trim(),name=String(n.name||"").trim(),role=n.role;
 if(!email){toast("Enter the person's email.");return}
 const plant=taPlants().find(p=>p.dbId===n.plant);
 if(role==="Site Engineer"&&!plant){toast("Select the one plant for this Site Engineer.");return}
 if(role==="Assignee"&&!n.equipment_types.length){toast("Pick at least one equipment type for this Assignee.");return}
 try{
  TA.adding=true;render();
  const r=await apiFetch("/api/users/invite",{method:"POST",body:{name,email,role,plants:role==="Site Engineer"?[plant.id]:[],equipment:role==="Assignee"?n.equipment_types.slice():[]}});
  toast((r.status==="created"?"Added ":"Updated ")+(r.name||r.email)+" as "+r.role+(r.email_sent?" — invite email sent to "+r.email:r.invited?" — email NOT sent ("+(r.email_note||"unknown reason")+"). Tell them to sign in with "+r.email:""));
  /* show the saved person straight away from the server reply; the full list (with scope details) reloads in the background */
  const shown=Object.assign({plants:role==="Site Engineer"&&plant?[{plant_id:plant.dbId,site_code:plant.id,plant_name:plant.name}]:[],equipment:[],equipment_types:role==="Assignee"?n.equipment_types.slice().sort():[],created_at:new Date().toISOString(),is_self:false},r);
  if(Array.isArray(TA.users)){const i=TA.users.findIndex(u=>u.id===r.id);if(i>=0)TA.users[i]=Object.assign({},TA.users[i],shown);else TA.users.unshift(shown)}
  TA.nw={name:"",email:"",role:"Assignee",plant:"",equipment_types:[]};
  TA.formOpen=false;TA.adding=false;render();
  taLoad(true);
 }catch(e){TA.adding=false;render();toast("Not saved — "+e.message)}
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
 const head='<div style="padding:14px 16px 0"><h2 style="font-size:15px;font-weight:700">Team &amp; access</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 10px">New people sign in with a Clerk email code and wait here as <b>Viewer</b>. Choose their role, then Save. <b>Assignees</b> are given equipment types (e.g. Inverter) — every issue, schedule and washing job of that type, in all plants, goes to them. <b>Site Engineers</b> are tied to exactly one plant. Changes apply on their next screen load.</p>'+legend+'</div>';
 const wrap=b=>'<div class="panel no-stick ta-panel" style="padding:0">'+head+b+'</div>';
 if(TA.error)return wrap('<div style="padding:0 16px 16px"><div class="bn-warn banner">Could not load users: '+esc(TA.error)+'</div><button class="btn o sm" onclick="TA.error=null;taLoad(true)">Retry</button></div>');
 if(!TA.users)return wrap('<div style="padding:0 16px 16px;font-size:12px;color:var(--muted-foreground)">Loading team…</div>');
 const pending=TA.users.filter(u=>u.role==="Viewer"&&u.active).length;
 const filt='<select class="inp" style="width:170px;font-size:12px" aria-label="Filter people by role" onchange="TA.filter=this.value;TA.limit=TA_PAGE;taRefreshTable()"><option value="all"'+(TA.filter==="all"?" selected":"")+'>All people ('+TA.users.length+')</option><option value="pending"'+(TA.filter==="pending"?" selected":"")+'>Pending ('+pending+')</option>'+TA_ROLES.filter(r=>r!=="Viewer").map(r=>'<option value="'+esc(r)+'"'+(TA.filter===r?" selected":"")+'>'+esc(r)+'</option>').join("")+'</select>';
 const find='<input class="inp" type="search" style="width:220px;font-size:12px" placeholder="Search name or email" aria-label="Search people by name or email" autocomplete="off" value="'+esc(TA.search)+'" oninput="taSearch(this.value)">';
 let h='<div style="padding:0 16px 10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">'+find+filt+(pending?'<span class="badge b-warning">'+pending+' waiting for a role</span>':'')+'<button class="btn o sm" onclick="taLoad(true)">Refresh</button><button class="btn p sm" onclick="taToggleForm()">+ Add person</button><button class="btn o sm" title="Columns: Name, Email, Role, Plants (Site Engineer) or Equipment types e.g. Inverter|Module (Assignee)" onclick="document.getElementById(\'ta-file\').click()">Import from Excel</button><input type="file" id="ta-file" accept=".xlsx,.xlsm,.csv" style="display:none" onchange="taImportFile(this)"></div>'+taAddForm();
 h+=taTableHtml();
 return wrap(h);
}
const TA_COLLATE=new Intl.Collator(undefined,{sensitivity:"base",numeric:true});
function taRows(){
 const q=String(TA.search||"").trim().toLowerCase();
 let rows=TA.users.filter(u=>u.active||TA.showRemoved);
 if(TA.filter==="pending")rows=rows.filter(u=>u.role==="Viewer");
 else if(TA.filter!=="all")rows=rows.filter(u=>u.role===TA.filter);
 if(q)rows=rows.filter(u=>(String(u.name||"")+" "+String(u.email||"")).toLowerCase().includes(q));
 return rows.sort((a,b)=>(a.role==="Viewer"?0:1)-(b.role==="Viewer"?0:1)||TA_COLLATE.compare(String(a.name||""),String(b.name||"")));
}
/* Only the first TA.limit matching people are drawn; "Show more" adds another page. */
function taTableHtml(){
 const rows=taRows(),shown=rows.slice(0,TA.limit),left=rows.length-shown.length;
 let h='<div id="ta-table-wrap" class="ta-table-wrap" style="overflow:auto"><table class="dense ta-table"><thead><tr><th>Person</th><th>Role</th><th>Scope · equipment type / plant</th><th>Access</th><th>Status</th></tr></thead>';
 if(!rows.length)h+='<tbody><tr><td colspan="5" style="color:var(--muted-foreground);padding:14px">'+(TA.search.trim()?'No one matches “'+esc(TA.search.trim())+'”. <button class="btn o sm" onclick="taSearch(\'\',true)">Clear search</button>':'No people match this filter.')+'</td></tr></tbody>';
 shown.forEach(u=>{h+=taUserBody(u)});
 h+='</table>';
 if(left>0)h+='<div class="ta-more"><span>Showing '+shown.length+' of '+rows.length+' people</span><button class="btn o sm" onclick="taShowMore()">Show '+Math.min(TA_PAGE,left)+' more</button></div>';
 return h+'</div>';
}
function taRefreshTable(){const el=document.getElementById("ta-table-wrap");if(el)el.outerHTML=taTableHtml();else render()}
function taSearch(v,clearBox){
 TA.search=String(v||"");TA.limit=TA_PAGE;taRefreshTable();
 if(clearBox){const box=document.querySelector('.ta-panel input[type="search"]');if(box){box.value="";box.focus()}}
}
function taShowMore(){TA.limit+=TA_PAGE;taRefreshTable()}


function renderSettings(){
 const matrix=(typeof REV05_PERMISSION_MATRIX!=="undefined"?REV05_PERMISSION_MATRIX:[]);
 return '<div class="ops-page ops-settings"><div class="ops-page-head"><div><div class="kpi-label">SOLAR OPERATIONS · ADMINISTRATION</div><h1>Settings</h1><p>Manage team access, operational roles, issue workflow and notification rules.</p></div><span class="ops-page-status"><i></i>Access controls</span></div>'+
  teamAccessPanel()+
  '<div class="panel ops-settings-panel"><div class="ops-section-head"><div><div class="kpi-label">ISSUE LIFECYCLE</div><h2>Issue workflow</h2></div><span class="ops-page-status"><i></i>Closed</span></div>'+wfStrip("Closed")+'<p class="ops-helper">OPEN → ASSIGNED → ACKNOWLEDGED → IN PROGRESS → RESOLVED → CLOSED</p></div>'+
  '<div class="panel no-stick ops-settings-panel ops-settings-table" style="padding:0"><div class="ops-section-head"><div><div class="kpi-label">ACCESS MODEL</div><h2>Role &amp; module permissions</h2><p>Server-managed permissions. Site Engineers are restricted to one assigned plant.</p></div></div><div class="ops-table-scroll"><table class="dense" style="min-width:1050px"><thead><tr><th>Role</th><th>Plants dashboard</th><th>Plants</th><th>Site Issues</th><th>Preventive Maintenance</th><th>Work</th><th>Performance / Reports</th><th>Handover</th><th>Extra Services</th><th>Scope</th></tr></thead><tbody>'+matrix.map(r=>'<tr><td style="font-weight:700">'+esc(r.role)+'</td>'+r.modules.map(x=>'<td>'+esc(x)+'</td>').join("")+'<td>'+badge(r.scope)+'</td></tr>').join("")+'</tbody></table></div></div>'+
  '<div class="panel no-stick ops-settings-panel ops-settings-table" style="padding:0"><div class="ops-section-head"><div><div class="kpi-label">ALERTING</div><h2>Notification rules</h2></div><span class="ops-section-count">'+(S.rules||[]).filter(r=>r.on).length+' active</span></div><div class="ops-table-scroll"><table class="dense"><thead><tr><th>Event</th><th>Channel</th><th>To</th><th>On</th></tr></thead><tbody>'+(S.rules||[]).map(r=>'<tr><td>'+esc(r.event)+'</td><td>'+esc(r.channel)+'</td><td>'+esc(r.to)+'</td><td>'+(r.on?"On":"Off")+'</td></tr>').join("")+'</tbody></table></div></div></div>';
}

/* ---------------- 3. EXTRA SERVICES ---------------- */
const EXT_TABS=[["requests","Requests"],["inventory","Inventory"],["safety","Safety"],["documents","Documents"],["vendors","Vendors"],["rules","Notifications"],["roles","Roles"],["mobile","Mobile"],["audit","Audit"],["contracts","SLA"],["weather","Weather"]];
function serviceStatusRecords(sub){
 if(sub==="requests")return S.serviceRequests.map(x=>({status:x.status}));
 if(sub==="inventory")return S.inventory.map(x=>({status:x.qty<x.min?"Critical":"Available"}));
 if(sub==="safety")return S.ptw.map(x=>({status:x.status}));
 if(sub==="documents")return S.docs.map(x=>({status:!x.expires?"Available":dayDiff(TODAY,x.expires)<=30?"Due soon":"Compliant"}));
 if(sub==="vendors")return S.vendors.map(x=>{const v=vendorStats(x);return{status:v.onTime==null?"Available":v.onTime>=85?"On track":"Attention"}});
 if(sub==="mobile")return S.offlineQueue.map(x=>({status:x.status}));
 if(sub==="contracts")return S.sla.map(x=>({status:x.breach?"Breach":"Compliant"}));
 return [{status:"Active"}];
}
function renderServices(){
 if(S.extSub==="performance"||S.extSub==="reports")S.extSub="requests";  // removed tabs, possibly still saved
 const sub=S.extSub;
 let h='<div style="display:flex;flex-direction:column;gap:16px"><div class="tabs">'+EXT_TABS.map(t=>'<div class="tab '+(sub===t[0]?"active":"")+'" onclick="S.extSub=\''+t[0]+'\';render()">'+t[1]+'</div>').join("")+'</div>'+statusCircleCards("Extra Services status",serviceStatusRecords(sub));
 if(sub==="requests"){
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><h2 style="font-size:15px;font-weight:600">Extra service requests</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Estimate → approval → vendor assignment → execution → verification, with full history</p></div>';
  const lcR=listCtl("esr",S.serviceRequests,{facet:r=>r.status,facetLabel:"Status",text:r=>[r.id,r.project,r.category,r.provider,r.owner,r.status].join(" "),ph:"Search request, project or vendor"});h+=lcR.bar;
  h+='<table><thead><tr><th>Request</th><th>Project · category</th><th>Priority</th><th>Vendor / owner</th><th>Estimate</th><th>Progress</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
  lcR.rows.forEach(r=>{h+='<tr><td><div style="font-weight:600">'+r.id+'</div><div style="font-size:12.5px;color:var(--muted-foreground)">target '+fmtD(r.target)+'</div></td>'+
   '<td><div>'+esc(r.project)+'</div><div style="font-size:12.5px;color:var(--muted-foreground)">'+r.category+'</div></td><td>'+badge(r.priority)+'</td>'+
   '<td><div>'+esc(r.provider)+'</div><div style="font-size:12.5px;color:var(--muted-foreground)">owner '+esc(r.owner)+'</div></td><td>'+money(r.estimate)+'</td>'+
   '<td style="min-width:110px"><div style="font-size:12.5px;margin-bottom:4px">'+r.progress+'%</div><div class="prog"><div style="width:'+r.progress+'%;background:'+(r.progress===100?"var(--success)":"var(--primary)")+'"></div></div></td><td>'+badge(r.status)+'</td><td><div class="row" style="gap:5px;flex-wrap:wrap">';
   if(r.status==="Approval Pending")h+='<button class="btn p sm" onclick="approveESR(\''+r.id+'\')">'+I.check(12)+'Approve</button><button class="btn d sm" onclick="changeESR(\''+r.id+'\')">Changes</button>';
   if(["In Progress","Assigned"].includes(r.status)&&r.progress<100)h+='<button class="btn o sm" onclick="bumpESR(\''+r.id+'\')">+25%</button>';
   if(["In Progress","Assigned"].includes(r.status)&&r.progress>=100)h+='<button class="btn o sm" onclick="verifyESR(\''+r.id+'\')">'+I.bcheck(12)+'Verify</button>';
   h+='</div></td></tr>';});
  h+='</tbody></table>'+lcR.pager+'</div>';
 }
 if(sub==="inventory"){
  const low=S.inventory.filter(s=>s.qty<s.min);
  if(low.length)h+='<div class="bn-danger banner"><b>Low-stock alerts ('+low.length+')</b> — reorder workflow below. Auto-deduction is live: spare parts used against Issue tickets / Preventive Maintenance tasks decrement stock automatically (see movements log).</div>';
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><div class="row between wrap"><div><h2 style="font-size:15px;font-weight:600">Spares &amp; inventory per project / warehouse</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Inverters, fuses, connectors, modules — with minimum levels and reorder</p></div><button class="btn p sm" onclick="openModal(&quot;newInventory&quot;)">+ Add stock item</button></div></div>';
  const lcS=listCtl("inv",S.inventory,{facet:s=>s.qty<s.min?"Low stock":"In stock",facetLabel:"Stock",text:s=>[s.item,s.cat,s.plant,s.store].join(" "),ph:"Search item, category or plant"});h+=lcS.bar;
  h+='<table><thead><tr><th>Item</th><th>Category</th><th>Plant / store</th><th>Stock</th><th>Min</th><th>Status</th><th>Action</th></tr></thead><tbody>';
  lcS.rows.forEach(s=>{const isLow=s.qty<s.min;
   h+='<tr><td style="font-weight:500">'+esc(s.item)+'</td><td>'+s.cat+'</td><td><div>'+esc(s.plant)+'</div><div style="font-size:12.5px;color:var(--muted-foreground)">'+s.store+'</div></td>'+
   '<td><b>'+s.qty+'</b> '+s.unit+'</td><td>'+s.min+'</td><td>'+(isLow?badge("Critical"):badge("Available"))+(s.onOrder?'<div style="margin-top:3px">'+badge("Ordered")+'</div>':'')+'</td>'+
   '<td>'+(isLow?'<button class="btn o sm" onclick="reorder(\''+s.id+'\')">'+(s.onOrder?"Receive reorder":"Raise reorder")+'</button>':"—")+'</td></tr>';});
  h+='</tbody></table>'+lcS.pager+'</div>';
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><h2 style="font-size:15px;font-weight:600">Stock movements</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Auto-deducted when spares are used against Issue tickets or Preventive Maintenance tasks</p></div>';
  const lcM=listCtl("mov",S.movements,{text:m=>[m.item,m.ref,m.by,m.note].join(" "),ph:"Search item, record or note"});h+=lcM.bar;
  h+='<table><thead><tr><th>When</th><th>Item</th><th>Qty</th><th>Linked record</th><th>By</th><th>Note</th></tr></thead><tbody>';
  lcM.rows.forEach(m=>{h+='<tr><td class="nowrap">'+m.at+'</td><td>'+esc(m.item)+'</td><td><b style="color:'+(m.qty<0?"var(--danger)":"var(--success)")+'">'+(m.qty>0?"+":"")+m.qty+'</b></td><td>'+esc(m.ref)+'</td><td>'+esc(m.by)+'</td><td style="font-size:12.5px;color:var(--muted-foreground)">'+esc(m.note)+'</td></tr>';});
  h+='</tbody></table>'+lcM.pager+'</div>';
 }
 if(sub==="safety"){
  const pend=S.ptw.filter(p=>p.status==="Pending Approval");
  if(pend.length)h+='<div class="bn-warn banner"><b>'+pend.length+' PTW request(s) awaiting digital sign-off</b> — high-risk tasks (electrical, height work) stay blocked until approved. LOTO tracked per permit.</div>';
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><div class="row between wrap"><div><h2 style="font-size:15px;font-weight:600">Permit to Work / LOTO register</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Digital sign-off before high-risk tasks; links to PTW flags on Preventive Maintenance tasks</p></div>'+
   '<button class="btn p sm" onclick="openModal(\'incident\')">+ Report incident / near-miss</button></div></div>';
  const lcP=listCtl("ptw",S.ptw,{facet:p=>p.status,facetLabel:"Status",text:p=>[p.id,p.task,p.plant,p.type,p.hazard,p.requestedBy].join(" "),ph:"Search permit, task or plant"});h+=lcP.bar;
  h+='<table><thead><tr><th>PTW</th><th>Task</th><th>Type / hazard</th><th>LOTO</th><th>Validity</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
  lcP.rows.forEach(p=>{h+='<tr><td style="font-weight:600">'+p.id+'</td><td><div style="font-weight:500">'+esc(p.task)+'</div><div style="font-size:12.5px;color:var(--muted-foreground)">'+esc(p.plant)+' · by '+esc(p.requestedBy)+'</div></td>'+
   '<td>'+p.type+'<div style="font-size:12.5px;color:var(--muted-foreground)">'+esc(p.hazard)+'</div></td><td>'+(p.loto?badge("Critical"):"—")+'</td>'+
   '<td style="font-size:12.5px" class="nowrap">'+fmtDT(p.validFrom)+'<br>→ '+fmtDT(p.validTo)+'</td><td>'+badge(p.status)+'</td><td><div class="row" style="gap:5px;flex-wrap:wrap">';
   if(p.status==="Pending Approval")h+='<button class="btn o sm" onclick="approvePTW(\''+p.id+'\',true)">'+I.fsig(12)+'Approve</button><button class="btn d sm" onclick="approvePTW(\''+p.id+'\',false)">Reject</button>';
   if(p.status==="Approved")h+='<button class="btn g sm" onclick="closePTW(\''+p.id+'\')">Close permit</button>';
   h+='</div></td></tr>';});
  h+='</tbody></table>'+lcP.pager+'</div>';
  h+='<div class="kgrid" style="grid-template-columns:1fr 1fr;align-items:start">';
  h+='<div class="panel"><h2 style="font-size:15px;font-weight:600">Safety incidents &amp; near-misses</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 10px">Separate register from equipment Issues</p>';
  const lcI=listCtl("inc",S.incidents,{size:3,facet:x=>x.severity,facetLabel:"Severity",text:x=>[x.id,x.type,x.desc,x.plant,x.by].join(" "),ph:"Search incident",pad:"0 0 10px"});h+=lcI.bar;
  lcI.rows.forEach(i=>{h+='<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px"><div class="row between wrap" style="gap:6px"><b style="font-size:12.5px">'+i.id+' · '+i.type+'</b>'+badge(i.severity)+'</div>'+
   '<div style="font-size:12px;margin-top:4px">'+esc(i.desc)+'</div><div style="font-size:12.5px;color:var(--muted-foreground);margin-top:4px">'+esc(i.plant)+' · '+i.at+' · by '+esc(i.by)+'</div>'+
   '<div style="font-size:12.5px;margin-top:4px;color:var(--success)"><b>Corrective:</b> '+esc(i.action)+'</div></div>';});
  h+=lcI.pager+'</div>';
  h+='<div class="panel"><h2 style="font-size:15px;font-weight:600">Statutory compliance watchlist</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 10px">Fire safety, electrical certificates, insurance — renewal reminders via 3.8</p>';
  const expSoon=S.docs.filter(d=>d.expires&&dayDiff(TODAY,d.expires)<=30);
  h+=expSoon.length?expSoon.map(d=>'<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--border);font-size:12.5px;gap:8px"><div><div>'+esc(d.name)+'</div><div style="font-size:12.5px;color:var(--muted-foreground)">'+esc(d.plant)+'</div></div>'+badge(dayDiff(TODAY,d.expires)+"d left")+'</div>').join(""):'<div style="font-size:12px;color:var(--muted-foreground)">Nothing inside 30 days.</div>';
  h+='<div style="font-size:12px;color:var(--muted-foreground);margin-top:10px">Quarterly audit checklist (fire safety, electrical certificates, PTW compliance) exports in the Monthly compliance pack.</div></div></div>';
 }
 if(sub==="documents"){
  const sorted=S.docs.slice().sort((a,b)=>(a.expires||"9999")<(b.expires||"9999")?-1:1);
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><div class="row between wrap"><div><h2 style="font-size:15px;font-weight:600">Central document repository</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">O&amp;M manuals, warranties, as-builts, compliance certificates — with expiry tracking and automated renewal reminders. Handover Completion Certificates land here automatically.</p></div><button class="btn p sm" onclick="openModal(&quot;newDocument&quot;)">+ Add document</button></div></div>';
  const lcD=listCtl("doc",sorted,{facet:d=>d.type,facetLabel:"Type",text:d=>[d.name,d.type,d.plant,d.owner].join(" "),ph:"Search document, plant or owner"});h+=lcD.bar;
  h+='<table><thead><tr><th>Document</th><th>Type</th><th>Plant</th><th>Owner</th><th>Expires</th><th>Countdown</th><th>Action</th></tr></thead><tbody>';
  lcD.rows.forEach(d=>{const dd=d.expires?dayDiff(TODAY,d.expires):null;
   h+='<tr><td style="font-weight:500">'+esc(d.name)+'</td><td>'+d.type+'</td><td>'+esc(d.plant)+'</td><td>'+esc(d.owner)+'</td><td>'+(d.expires?fmtDate(d.expires):"—")+'</td>'+
   '<td>'+(dd===null?badge("—"):dd<0?badge("Expired"):dd<=30?badge(dd+" days"):badge("OK"))+'</td>'+
   '<td>'+(d.expires?'<button class="btn g sm" onclick="renewDoc(\''+d.id+'\')">Record renewal</button>':"—")+'</td></tr>';});
  h+='</tbody></table>'+lcD.pager+'</div>';
 }
 if(sub==="vendors"){
  h+='<div class="panel"><div class="row between wrap"><div><h2 style="font-size:15px;font-weight:600">Vendor &amp; contractor management</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Third-party vendors — washing contractors, security agencies, OEM service partners — with SLAs, contracts and performance ratings. Feeds Vendor-Dependent tagging on Issues.</p></div><button class="btn p sm" onclick="openModal(&quot;newVendor&quot;)">+ Add vendor</button></div>';
  const lcV=listCtl("ven",S.vendors,{size:4,facet:v=>v.type,facetLabel:"Type",text:v=>[v.name,v.type,v.scope].join(" "),ph:"Search vendor or scope",pad:"0 0 12px"});h+=lcV.bar;
  h+='<div class="kgrid" style="grid-template-columns:repeat(2,1fr)">';
  lcV.rows.forEach(v=>{const vs=vendorStats(v),on=vs.onTime;h+='<div class="metric"><div class="row between wrap" style="gap:6px"><div><div style="font-weight:700;font-size:13.5px">'+esc(v.name)+'</div><div style="font-size:12.5px;color:var(--muted-foreground)">'+v.type+' · '+esc(v.scope)+'</div></div></div>'+
   '<div class="col" style="gap:4px;margin-top:10px;font-size:12px"><div class="row between"><span class="muted">SLA</span><b>'+esc(v.sla||"—")+'</b></div>'+
   '<div class="row between"><span class="muted">Contract end</span><b>'+(v.contractEnd?fmtDate(v.contractEnd):"—")+'</b></div><div class="row between"><span class="muted">Vendor tickets</span><b>'+vs.jobs+'</b></div>'+
   '<div class="row between"><span class="muted">On-time (closed tickets)</span><b style="color:'+(on==null?"var(--muted-foreground)":on>=85?"var(--success)":"var(--danger)")+'">'+(on==null?"—":on+"%")+'</b></div>'+
   '<div class="prog"><div style="width:'+(on==null?0:on)+'%;background:'+(on!=null&&on>=85?"var(--success)":"var(--danger)")+'"></div></div></div>'+
   (on!=null&&on<85?'<div style="font-size:12.5px;color:var(--warning-strong);font-weight:600;margin-top:8px">⚠ Derived from actual vendor-linked ticket ETC performance</div>':'')+'</div>';});
  h+='</div>'+lcV.pager+'</div>';
 }
 if(sub==="rules"){
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><h2 style="font-size:15px;font-weight:600">Notification &amp; escalation engine</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Configurable rules across all modules — channel (app/SMS/email/call), recipients by role, escalation tiers by time elapsed. Powers every alert in the bell. The live alerts you see in the bell (SLA breaches, task escalations, washing compliance, low stock, document expiry) are generated by these rules.</p></div>';
  h+='<table><thead><tr><th></th><th>Event</th><th>Channel</th><th>Recipients</th><th>Escalation tiers</th></tr></thead><tbody>';
  S.rules.forEach(r=>{h+='<tr><td><button onclick="toggleRule(\''+r.id+'\')" style="width:34px;height:19px;border-radius:999px;background:'+(r.on?"var(--success)":"var(--input)")+';border:none;cursor:pointer;position:relative"><span style="position:absolute;top:2px;left:'+(r.on?17:2)+'px;width:15px;height:15px;border-radius:999px;background:#fff;transition:.15s"></span></button></td>'+
   '<td style="font-weight:500">'+esc(r.event)+'</td><td>'+r.channel+'</td><td>'+esc(r.to)+'</td><td style="font-size:12.5px;color:var(--muted-foreground)">'+esc(r.tiers)+'</td></tr>';});
  h+='</tbody></table></div>';
 }
 if(sub==="roles"){
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><h2 style="font-size:15px;font-weight:600">Roles &amp; permissions</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Role-based access control with configurable approval hierarchies per project or client contract. Current login: '+OM_HEAD+' — O&amp;M Head (portfolio scope).</p></div>';
  h+='<table><thead><tr><th>Role</th><th>Handover</th><th>Preventive Maintenance</th><th>Washing</th><th>Issues</th><th>Documents</th><th>Scope</th></tr></thead><tbody>';
  ROLES.forEach(r=>{h+='<tr><td style="font-weight:600" class="nowrap">'+r.role+'</td><td>'+r.handover+'</td><td>'+r.sched+'</td><td>'+r.washing+'</td><td>'+r.issues+'</td><td>'+r.docs+'</td><td>'+badge(r.scope)+'</td></tr>';});
  h+='</tbody></table></div>';
 }
 if(sub==="mobile"){
  h+='<div class="bn-info banner"><b>Offline-capable field app</b> — technicians log washing, complete Preventive Maintenance work and raise/update Site Issues in low-connectivity plant areas; everything syncs once back online.</div>';
  h+='<div class="kgrid" style="grid-template-columns:1fr 1fr;align-items:start">';
  h+='<div class="panel"><div class="row between" style="margin-bottom:10px"><h2 style="font-size:15px;font-weight:600">Sync queue — today</h2><button class="btn p sm" onclick="syncQueue()">Sync now</button></div>';
  S.offlineQueue.forEach(q=>{h+='<div class="row" style="gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--border)"><span class="dot" style="background:'+(q.status==="Queued"?"var(--warning)":"var(--success)")+';margin-top:5px"></span>'+
   '<div style="flex:1;font-size:12.5px">'+esc(q.action)+'<div style="font-size:12.5px;color:var(--muted-foreground);margin-top:2px">'+esc(q.user)+' · '+q.at+' · '+badge(q.status)+'</div></div></div>';});
  h+='</div><div class="panel"><h2 style="font-size:15px;font-weight:600">Field capabilities</h2><div class="col" style="gap:9px;font-size:12.5px;margin-top:8px">'+
   '<div>🪣 <b>Washing:</b> per-table &amp; bulk entry with date stamps; rain exceptions with reason codes</div>'+
   '<div>🔧 <b>Preventive Maintenance:</b> start tasks, submit completion with sub-steps, readings &amp; photos</div>'+
   '<div>🐞 <b>Issues:</b> raise tickets on the go with photos, severity &amp; ETC; add progress from the field</div>'+
   '<div>🦺 <b>Safety:</b> PTW sign-off requests and near-miss reporting from site</div>'+
   '<div>🌦️ <b>Weather:</b> rain warnings pushed to washing crews</div></div></div></div>';
 }
 if(sub==="audit"){
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><h2 style="font-size:15px;font-weight:600">Immutable audit trail</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Every status change, assignment, approval and edit across Handover, Preventive Maintenance, Washing and Issues — with user, timestamp, and before/after values — for accountability and dispute resolution.</p></div>';
  h+='<table><thead><tr><th>When</th><th>Module</th><th>Event</th><th>User</th><th>Before → After</th></tr></thead><tbody>';
  S.audit.forEach(a=>{const moduleName=a.module==="Scheduled O&M"?"Preventive Maintenance":a.module;h+='<tr><td class="nowrap">'+a.at+'</td><td>'+badge("Internal")+' '+esc(moduleName)+'</td><td>'+esc(a.text)+'</td><td>'+esc(a.user)+'</td><td style="font-size:12.5px;color:var(--muted-foreground)">'+esc(a.before)+' → <b>'+esc(a.after)+'</b></td></tr>';});
  h+='</tbody></table></div>';
 }
 if(sub==="contracts"){
  const breaches=S.sla.filter(c=>slaLive(c).breach);
  if(breaches.length)h+='<div class="bn-danger banner"><b>Contract breach watch ('+breaches.length+')</b> — '+breaches.map(s=>esc(s.project)+" · "+esc(s.name||s.term||"SLA")).join(" · ")+'. Compliance is tracked against the actual contract, not just internal targets.</div>';
  h+='<div class="panel" style="padding:0"><div style="padding:16px 20px 0"><div class="row between wrap"><div><h2 style="font-size:15px;font-weight:600">SLA &amp; contract management</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">O&amp;M contract terms mapped to actual ticket ETC and washing records using the selected Operations date.</p></div><button class="btn p sm" onclick="openModal(&quot;newSLA&quot;)">+ Add SLA contract</button></div></div>';
  h+='<table><thead><tr><th>Plant</th><th>Contract</th><th>Resolution targets</th><th>Washing</th><th>Live status</th><th>Actual ticket compliance</th></tr></thead><tbody>';
  S.sla.forEach(c=>{const live=slaLive(c);h+='<tr><td>'+esc(c.project)+'</td><td style="font-weight:500">'+esc(c.name||"O&M SLA")+'</td><td style="font-size:12.5px">Critical '+(c.critical||24)+'h · Medium '+(c.medium||120)+'h · Low '+(c.low||240)+'h</td><td>'+(c.washDays?esc(c.washDays)+" days":"—")+'</td>'+
   '<td>'+(live.breach?badge("Breached"):badge("Compliant"))+'<div class="muted" style="font-size:12px;margin-top:3px">'+live.issueBreaches+' ticket · '+live.washBreaches+' wash breach(es)</div></td>'+
   '<td style="min-width:120px">'+(live.metPct==null?'—':'<div style="font-size:12.5px;margin-bottom:4px"><b>'+live.metPct+'%</b></div><div class="prog"><div style="width:'+live.metPct+'%;background:'+(live.metPct>=90?"var(--success)":live.metPct>=75?"var(--warning)":"var(--danger)")+'"></div></div>')+'</td></tr>';});
  h+='</tbody></table></div>';
 }
 if(sub==="weather"){
  h+='<div class="panel"><h2 style="font-size:15px;font-weight:600">Weather integration</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Local weather (rain, forecast) pulled automatically to pre-flag washing exceptions and help plan Preventive Maintenance around weather windows</p>';
  h+='<div class="kgrid" style="grid-template-columns:repeat(2,1fr)">';
  if(!WEATHER.length)h+='<div style="grid-column:1/-1;font-size:12px;color:var(--muted-foreground);padding:8px">No weather feed connected — connect a forecast provider to pre-flag washing exceptions.</div>';
  WEATHER.forEach(w=>{const rd=w.f.findIndex(r=>r>=60);
   h+='<div class="metric"><div class="row between" style="align-items:center"><div style="font-weight:700;font-size:13.5px">'+esc(w.plant)+'</div><span style="font-size:12.5px;color:var(--muted-foreground)">Today: '+w.today+'</span></div>';
   h+='<div class="row" style="gap:5px;margin-top:10px">'+w.f.map((r,i)=>'<div style="flex:1;text-align:center;border:1px solid var(--border);border-radius:8px;padding:6px 2px;background:'+(r>=60?"var(--info-soft)":r>=30?"var(--warning-soft)":"var(--card)")+'"><div style="font-size:12px;color:var(--muted-foreground)">D+'+(i+1)+'</div><div style="font-size:12.5px;font-weight:600;color:'+(r>=60?"var(--info)":r>=30?"var(--warning-strong)":"var(--muted-foreground)")+'">'+r+'%</div></div>').join("")+'</div>';
   h+=rd>-1?'<div style="font-size:12.5px;margin-top:8px;color:var(--info);font-weight:600">🌧 Rain likely D+'+(rd+1)+' ('+w.f[rd]+'%) — washing crews pre-warned; rain exceptions will auto-suggest reschedule instead of counting as misses.</div>':'<div style="font-size:12.5px;margin-top:8px;color:var(--success);font-weight:600">Clear window — good week to clear red-zone washing backlog.</div>';
   h+='</div>';});
  h+='</div></div>';
 }
 return h+'</div>';
}
