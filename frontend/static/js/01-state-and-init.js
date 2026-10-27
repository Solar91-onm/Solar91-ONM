"use strict";
/* ---------- state ---------- */
const S={modal:null,modalCtx:null,notifOpen:false,collapsed:false,
 issMode:"summary",issF:{plant:"all",sev:"all",vert:"all",from:"",to:"",assignee:"all",status:"all",sort:"etc",q:"",site:"all",project:"all",equip:"all",aging:"all",chip:"all",maker:"all",bucket:"all",health:"all"},trendDays:10,workWho:null,reportKind:"daily",schedPeriod:"month",
 schedF:{assignee:"all",status:"all",freq:"all",from:"",to:"",sort:"due",q:""},washF:{assignee:"all",status:"all",sort:"days",q:""},hoF:{status:"all",assignee:"all",q:""},tablePages:{scheduled:1,washing:1,issues:1,handover:1,plants:1},dashPlant:"all",plantId:null,chartPick:null,quickSearch:""};
const SCADA_CONFIG={provider:"Solar91 SCADA",apiVersion:"v1",schemaVersion:"solar91.telemetry.v1",baseUrl:"",telemetryPath:"/telemetry",siteIdField:"siteId",pollIntervalMs:30000};
const SCADA_DEFAULT={mode:"demo",connected:false,lastSync:null,lastError:null,source:"seed-data",schemaVersion:"solar91.telemetry.v1"};
function normalizeScadaTelemetry(payload){
 const rows=Array.isArray(payload)?payload:(payload&&Array.isArray(payload.sites)?payload.sites:(payload&&Array.isArray(payload.data)?payload.data:[]));
 return rows.map(row=>({siteId:row.siteId||row.id||row.plantId||null,name:row.name||row.siteName||row.plant||null,generation:Number(row.generation??row.generationmWh??row.energymWh??0),availability:Number(row.availability??0),pr:Number(row.pr??row.performanceRatio??0),alarms:Number(row.alarms??row.alarmCount??0),status:row.status||"Healthy",at:row.at||row.timestamp||new Date().toISOString()})).filter(row=>row.siteId||row.name);
}
function scadaIngest(payload){
 const telemetry=normalizeScadaTelemetry(payload);const byKey={};telemetry.forEach(row=>{byKey[row.siteId||row.name]=row});
 S.plants=S.plants.map(plant=>{const row=byKey[plant.id]||byKey[plant.name];return row?{...plant,generation:row.generation||plant.generation,availability:row.availability||plant.availability,pr:row.pr||plant.pr,alarms:row.alarms,status:row.status,scadaAt:row.at}:plant});
 S.scada={...(S.scada||SCADA_DEFAULT),mode:"live",connected:true,lastSync:new Date().toISOString(),lastError:null,source:SCADA_CONFIG.provider,records:telemetry.length};
 persist();render();return telemetry;
}
function scadaConfigure(patch){Object.assign(SCADA_CONFIG,patch||{});saveK("scadaConfig",SCADA_CONFIG);return {...SCADA_CONFIG}}
async function syncScada(){
 try{const result=await apiFetch("/api/scada/sync",{method:"POST"});return{ok:true,records:scadaIngest(result.rows||[]).length}}catch(error){S.scada={...(S.scada||SCADA_DEFAULT),connected:false,lastError:error.message};persist();render();return{ok:false,reason:error.message}}
}
function scadaUiState(){const sc=S.scada||SCADA_DEFAULT;return{live:!!sc.connected,label:sc.connected?"SCADA live":"SCADA adapter ready",detail:sc.lastSync?"Last sync "+new Date(sc.lastSync).toLocaleTimeString():"SCADA integration endpoint available"}}
window.Solar91SCADA={config:SCADA_CONFIG,configure:scadaConfigure,normalize:normalizeScadaTelemetry,ingest:scadaIngest,sync:syncScada};
/* "Assign to" lists everywhere are people with the Assignee role only — never the O&M Head, Administration or a
   Site Engineer. The list comes from the database (/api/issues/assignees = every active Assignee). */
async function refreshTeamPool(){
 const seNames=new Set();
 if(AUTH_IDENTITY.role==="Site Engineer"&&AUTH_IDENTITY.name)seNames.add(AUTH_IDENTITY.name);
 const isHead=AUTH_IDENTITY.role==="O&M Head";
 const canLoadAssignees=["O&M Head","Assignee","Site Engineer"].includes(AUTH_IDENTITY.role);
 const usersPromise=isHead?apiFetch("/api/users").catch(error=>{console.error("Could not load team users",error);return []}):Promise.resolve([]);
 const assigneesPromise=canLoadAssignees?apiFetch("/api/issues/assignees").catch(error=>{console.error("Could not load issue assignees",error);toast("Assignee list could not be loaded. Refresh before assigning a new issue. "+error.message);return null}):Promise.resolve(null);
 const [users,assignees]=await Promise.all([usersPromise,assigneesPromise]);
 const names=new Set();
 (assignees||[]).forEach(a=>{if(a&&a.name)names.add(a.name)});
 const seByPlant={};
 (users||[]).forEach(u=>{if(u.active&&u.name&&u.role==="Assignee")names.add(u.name);if(isHead&&u.active&&u.name&&u.role==="Site Engineer"){seNames.add(u.name);(u.plants||[]).forEach(pl=>{(seByPlant[pl.plant_id]=seByPlant[pl.plant_id]||[]).push(u.name)})}});
 if(isHead)window.SITE_ENG_BY_PLANT=seByPlant;
 if(!assignees&&!(users||[]).length&&AUTH_IDENTITY.role==="Assignee"&&AUTH_IDENTITY.name)names.add(AUTH_IDENTITY.name);
 SITE_ENG_POOL.length=0;[...seNames].sort().forEach(n=>SITE_ENG_POOL.push(n));
 const list=[...names].sort((a,b)=>a.localeCompare(b));
 [TEAM_POOL,ASSIGNEE_NAMES,ASSIGNEES].forEach(a=>{a.length=0;list.forEach(n=>a.push(n))});
 if(assignees){ISSUE_ASSIGNEES.length=0;assignees.forEach(a=>ISSUE_ASSIGNEES.push(a))}
}
async function init(){
 try{
  const boot=await apiFetch("/api/bootstrap");
  if(boot.user){
   AUTH_IDENTITY.name=boot.user.name||boot.user.email||"Solar91 User";
   AUTH_IDENTITY.role=boot.user.role||"Viewer";
   AUTH_IDENTITY.userId=boot.user.id||null;
   AUTH_IDENTITY.externalId=boot.user.external_id||null;
   AUTH_IDENTITY.email=boot.user.email||null;
  }

  if(AUTH_IDENTITY.role==="Viewer"){
   authSetupCard("Waiting for access","Your Solar91 account ("+esc(AUTH_IDENTITY.email||AUTH_IDENTITY.name||"")+") is created. The O&amp;M Head needs to assign your role and plants before you can use the portal. Once they do, reload this page.<div style=\"margin-top:16px;display:flex;gap:8px\"><button onclick=\"location.reload()\" style=\"padding:9px 14px;border-radius:9px;border:1px solid #E4E9E6;background:#fff;cursor:pointer\">Check again</button><button onclick=\"clerkSignOut()\" style=\"padding:9px 14px;border-radius:9px;border:0;background:#16A34A;color:#fff;cursor:pointer\">Sign out</button></div>");
   return;
  }


  if(boot.pending_access && ["Site Engineer","Assignee"].includes(AUTH_IDENTITY.role)){
   const detail=AUTH_IDENTITY.role==="Assignee"
    ?"Your Solar91 Assignee role is active, but no equipment is assigned yet. Ask an authorized O&M Head to assign your equipment."
    :"Your Solar91 Site Engineer role is active, but no plant assignment is configured yet. Ask an authorized O&M Head to assign exactly one plant.";
   authSetupCard("Access pending — no "+(AUTH_IDENTITY.role==="Assignee"?"equipment":"plant")+" assigned",detail);
   return;
  }
  Object.assign(S,boot.state||{});S._serverRevision=boot.revision||0;S._collectionRevisions=boot.collection_revisions||{};["view","omTab","extSub","hoOpen","plantId","washPlant","schedScope"].forEach(k=>{S[k]=loadK(k,S[k])});if(!S.schedScope)S.schedScope="all";
  if(AUTH_IDENTITY.role==="Site Engineer"){
   const sp=boot.scope&&boot.scope.plant;
   if(sp){
    S._sePlant=sp.plant_name;S._sePlantCode=sp.site_code;S.plantId=null;S.dashPlant=sp.plant_name;S.schedScope=sp.plant_name;S.washPlant=sp.plant_name;
    S.issF=Object.assign(blankIssF(),S.issF||{},{plant:sp.plant_name});
   }
  }
  seq=Math.max(1000,Number(S._seq||0)||0);
  Object.assign(SCADA_CONFIG,S.scadaConfig||{});
  S.plants=S.plants||[];S.handovers=S.handovers||[];S.tasks=S.tasks||[];S.washing=S.washing||[];S.washMeta=S.washMeta||{};S.issues=S.issues||[];S.inventory=S.inventory||[];S.movements=S.movements||[];S.ptw=S.ptw||[];S.incidents=S.incidents||[];S.docs=S.docs||[];S.vendors=S.vendors||[];S.rules=S.rules||[];S.sla=S.sla||[];S.audit=S.audit||[];S.offlineQueue=S.offlineQueue||[];S.serviceRequests=S.serviceRequests||[];S.events=S.events||[];S.equipment=S.equipment||[];
  S.customPlantColumns=S.customPlantColumns||[];S.plantCustomValues=S.plantCustomValues||{};S.plantEnrich=S.plantEnrich||{};
  if(!S.view||!["dashboard","plants","plant","work","performance","reports","data","settings","equipment","om-module"].includes(S.view))S.view="dashboard";
  s91NormalizeRows();
  S.opsDate=s91ValidDate(S.opsDate)?S.opsDate:s91BusinessDate();S._opsDateOverride=false;TODAY=S.opsDate;NOW_ISO=new Date().toISOString();
  S.issF=Object.assign(blankIssF(),S.issF||{});["from","to"].forEach(k=>{const v=S.issF[k];if(v&&!s91ValidDate(v))S.issF[k]=""});S.scada={...SCADA_DEFAULT,...(S.scada||{})};
  S.issues=S.issues.map(t=>{const severity=normalizeIssueSeverity(t.severity),etc=t.etc&&!isNaN(new Date(t.etc).getTime())?t.etc:addHoursISO(t.created||stampISO(),etcHrs(severity));return Object.assign({},t,{severity,vertical:VERT_MIGRATE[t.vertical]||t.vertical,etc})});
  S.handovers=S.handovers.map(h=>({...h,location:h.location||"",projectType:h.projectType||"",items:(h.items||[]).map(i=>({...i,instructions:i.instructions||""}))}));
  setLastServerState(stateSnapshot());
  if(typeof s91ApplyRoute==="function")s91ApplyRoute(true);
  bindUi();render();
  // The Overview does not depend on team-picker options. Load them in parallel with
  // first paint so a slow users/assignees endpoint cannot hold the whole portal open.
  void refreshTeamPool();
  if(typeof s91SyncRoute==="function")s91SyncRoute(true);
  if(S.view==="equipment"&&typeof m26EqLoadPage==="function")m26EqLoadPage(false);
 }catch(e){
  if(String(e.message).includes("Authentication required"))return;
  console.error(e);document.getElementById("app").innerHTML='<div style="max-width:720px;margin:80px auto;padding:24px;font-family:Inter,system-ui;border:1px solid #E4E9E6;border-radius:14px;background:#fff"><h2>Solar91 could not load</h2><p style="color:#4F5B55">The FastAPI backend or database is unavailable. Production data is not falling back to browser storage.</p><pre style="white-space:pre-wrap">'+esc(e.message)+'</pre><button onclick="location.reload()" style="padding:9px 14px">Retry</button></div>';
 }
}
/* typing in search boxes: update state now, repaint once the person pauses (keeps typing smooth) */
let _renderT=null;function renderSoon(){clearTimeout(_renderT);_renderT=setTimeout(()=>{_renderT=null;render()},180)}
function persist(){
 ["view","omTab","extSub","hoOpen","plantId","washPlant","schedScope"].forEach(k=>{if(S[k]!==undefined)saveK(k,S[k])});
 S._seq=seq;scheduleSync();
}

/* ---------- derived logic ---------- */
const counted=it=>it.status==="completed"||it.status==="na";
function hoProg(p){if(!p.items.length)return{done:0,total:0,pct:0};const done=p.items.filter(counted).length;return{done,total:p.items.length,pct:Math.round(done/p.items.length*100)}}
function itemOD(it){if(counted(it))return 0;const d=dayDiff(it.due,TODAY);return d>0?d:0}
function taskOD(t){if(t.status==="Completed")return 0;const d=dayDiff(t.due,TODAY);return d>0?d:0}
function escTier(t){const d=taskOD(t);return d>=7?3:d>=3?2:d>=1?1:0}
function escLabel(t){const k=escTier(t);return k?ESC_M[k-1].a:null}
const lastWash=t=>{for(let i=t.history.length-1;i>=0;i--){if(t.history[i].type==="wash")return t.history[i].date}return null};
const washedToday=t=>t.history.some(h=>h.type==="wash"&&h.date===TODAY);
const excToday=t=>t.history.find(h=>h.type==="exception"&&h.date===TODAY)||null;
const daysSince=t=>{const d=lastWash(t);return d?dayDiff(d,TODAY):999};
const wColor=t=>{const d=daysSince(t);return d<10?"green":d<=15?"amber":"red"};
const wDue=(t,f)=>{if(t.nextDue){const d=dayDiff(t.nextDue,TODAY);return d>=0}return daysSince(t)>=f};
function scheduledAdmin(){return ["O&M Head","Regional O&M Head"].includes(S.currentRole||"")}
function schedPeriodStart(kind){
 const y=parseInt(TODAY.slice(0,4)),m=parseInt(TODAY.slice(5,7));
 if(kind==="ytd")return y+"-01-01";
 if(kind==="quarter"){const q=Math.floor((m-1)/3)*3+1;return y+"-"+pad2(q)+"-01"}
 return TODAY.slice(0,7)+"-01";
}
function washAverageDelay(rows,frequencyDays){
 const delays=[];
 (rows||[]).forEach(t=>{const ds=(t.history||[]).filter(h=>h.type==="wash"&&h.date).map(h=>h.date).sort();for(let i=1;i<ds.length;i++){const due=addDays(ds[i-1],frequencyDays||14);delays.push(Math.max(0,dayDiff(due,ds[i])))}});
 return delays.length?Math.round((delays.reduce((a,b)=>a+b,0)/delays.length)*10)/10:0;
}
function setTablePage(name,page){S.tablePages[name]=Math.max(1,page);render()}
function tablePager(name,total,size){const pages=Math.max(1,Math.ceil(total/size)),page=Math.min(S.tablePages[name]||1,pages);if(page!==S.tablePages[name])S.tablePages[name]=page;return '<div class="table-pager"><span>Showing '+(total?((page-1)*size+1):0)+'–'+Math.min(page*size,total)+' of '+total+'</span><div class="row" style="gap:5px"><button class="btn o sm" '+(page<=1?"disabled":"")+' onclick="setTablePage(\''+name+'\','+(page-1)+')">Previous</button><span class="pager-page">Page '+page+' / '+pages+'</span><button class="btn o sm" '+(page>=pages?"disabled":"")+' onclick="setTablePage(\''+name+'\','+(page+1)+')">Next</button></div></div>'}
/* ---- list helpers: clamp page, jump to a newly created record, unique ticket ids ---- */
function pageRows(key,arr,size){const rv=S.reveal;
 if(rv&&rv.kind===key){const ix=rv.id?arr.findIndex(x=>x.id===rv.id):-1;if(ix>=0)S.tablePages[key]=Math.floor(ix/size)+1;S.reveal=null}
 const pages=Math.max(1,Math.ceil(arr.length/size)),pg=Math.min(Math.max(1,S.tablePages[key]||1),pages);S.tablePages[key]=pg;
 return arr.slice((pg-1)*size,pg*size)}
/* after creating a record: clear filters / search / page so it cannot be hidden, then scroll to + highlight it */
function revealNew(kind,id){
 if(kind==="issues"){S.issF={plant:"all",sev:"all",vert:"all",from:"",to:"",assignee:"all",status:"all",sort:S.issF.sort||"etc",q:""};S.issMode="summary"}
 else if(kind==="scheduled"){S.schedF={assignee:"all",status:"all",freq:"all",from:"",to:"",sort:S.schedF.sort||"due",q:""};S.schedScope="all"}
 else if(kind==="handover"){S.hoF={status:"all",assignee:"all",q:""}}
 else if(kind==="washing"){S.washF={assignee:"all",status:"all",sort:S.washF.sort||"days",q:""}}
 else if(kind==="inc"){S.lf=S.lf||{};S.lf.inc={q:"",f:"all"}}
 S.tablePages[kind]=1;S.reveal={kind,id};
 const here=S.view==="om-module"&&S.omTab===kind;
 if(here&&id){S.flashId=id;setTimeout(()=>{const el=document.querySelector('[data-rid="'+id+'"]');if(el)el.scrollIntoView({block:"center",behavior:"smooth"})},80);setTimeout(()=>{if(S.flashId===id)S.flashId=null},4500)}}
function newTicketId(){let n=0;
 S.issues.forEach(t=>{const m=String(t.id).match(/^ISS-(\d+)$/);if(m)n=Math.max(n,+m[1])});
 let id;do{n++;id="ISS-"+String(n).padStart(4,"0")}while(S.issues.some(t=>t.id===id));return id}
function openPlant(n){return S.plants.find(p=>p.name===n)}
function audit(module,text,user,before,after){S.audit.unshift({id:uid("AUD"),at:stamp(),module,text,user,before,after})}


function markEventRead(id){const ev=(S.events||[]).find(e=>e.id===id);S.events=S.events.map(e=>e.id===id?{...e,read:true}:e);if(ev&&ev.dbId)apiFetch("/api/notifications/"+encodeURIComponent(ev.dbId)+"/read",{method:"POST"}).catch(()=>{});persist()}
function markAllEventsRead(){S.events=S.events.map(e=>({...e,read:true}));apiFetch("/api/notifications/read-all",{method:"POST"}).catch(()=>{});persist();render()}
function eventNotif(e){const title=String(e.title||"").replace(/Critical\/high/gi,"Critical").replace(/\bHigh issue\b/gi,"Critical issue");return{id:e.id,title,meta:(e.read?"":"● ")+e.meta+(e.at?" · "+e.at:""),event:true,read:e.read,targetType:e.targetType,targetId:e.targetId}}

function refreshEquipPicker(prefix){const ps=document.getElementById(prefix+"-plant"),sel=document.getElementById(prefix+"-equip-sel");if(!ps||!sel)return;const opts=equipmentOptions(ps.value);sel.innerHTML=opts.map(x=>'<option>'+x+'</option>').join("")+'<option value="__other">Other / free text</option>';toggleEquipFree(prefix)}
function toggleEquipFree(prefix){const sel=document.getElementById(prefix+"-equip-sel"),free=document.getElementById(prefix+"-equip-free");if(free)free.style.display=(!sel||sel.value==="__other")?"block":"none"}
function pickedEquip(prefix){const sel=document.getElementById(prefix+"-equip-sel"),free=document.getElementById(prefix+"-equip-free");if(sel&&sel.value!=="__other")return sel.value;const inp=free&&(free.value!==undefined?free:free.querySelector("input"));return(inp&&inp.value.trim())||"—"}
function vendorStats(v){const rows=S.issues.filter(t=>t.vendor&&t.vendor.name===v.name);const closed=rows.filter(t=>t.status==="Closed"&&t.closure&&t.closure.closedAt);const met=closed.filter(t=>new Date(t.closure.closedAt)<=new Date(t.etc)).length;return{jobs:rows.length,closed:closed.length,onTime:closed.length?Math.round(100*met/closed.length):null}}
function slaLive(c){const issues=S.issues.filter(t=>(c.project==="All Plants"||t.plant===c.project)&&t.created),hrs=t=>{const n=Number(c[String(t.severity||"").toLowerCase()]);return Number.isFinite(n)&&n>0?n:etcHrs(t.severity)},due=t=>addHoursISO(t.created,hrs(t));const closed=issues.filter(t=>t.status==="Closed"&&t.closure&&t.closure.closedAt);const met=closed.filter(t=>new Date(t.closure.closedAt)<=new Date(due(t))).length;const openBreach=issues.filter(t=>t.status!=="Closed"&&t.status!=="Resolved"&&new Date(NOW_ISO)>new Date(due(t))).length;const washRows=S.washing.filter(t=>c.project==="All Plants"||t.plant===c.project);const wf=Number(c.washDays)||0;const washBreaches=wf?washRows.filter(t=>daysSince(t)>wf).length:0;const total=closed.length;return{breach:openBreach+washBreaches>0,issueBreaches:openBreach,washBreaches,metPct:total?Math.round(100*met/total):null}}
function wizardGo(prefix,step){if(prefix==="ticket"&&step===2&&typeof s91TkEquipRefresh==="function"){if(document.getElementById("tk-units-box"))s91TkEquipRefresh()}document.querySelectorAll(".wiz-"+prefix).forEach(x=>x.style.display="none");const el=document.querySelector(".wiz-"+prefix+"[data-step='"+step+"']");if(el)el.style.display="block";document.querySelectorAll("[data-wiz-final='"+prefix+"']").forEach(x=>x.style.display=step>=3?"inline-flex":"none")}
function allNotifs(){const out=(S.events||[]).map(eventNotif);
 {const nr=S.plants.filter(p=>XL_BY[p.id]&&p.genDate&&p.genDate<XL_LAST);if(nr.length)out.push({id:"xl-nr",title:nr.length+" plant"+(nr.length===1?"":"s")+" not reporting on "+xlFmtD(XL_LAST),meta:nr.slice(0,3).map(p=>p.id+" (last "+xlFmtD(p.genDate)+")").join(", ")+(nr.length>3?" +"+(nr.length-3)+" more":"")+" · Excel DGR"});
  const lo=S.plants.map(p=>({p,m:xlPlantMtd(p.id)})).filter(z=>z.m&&z.m.pct!=null&&z.m.days>=3&&z.m.pct<90).sort((a,b)=>a.m.pct-b.m.pct);
  if(lo.length)out.push({id:"xl-low",title:lo.length+" plant"+(lo.length===1?"":"s")+" below 90% of PV Syst (MTD)",meta:"Worst: "+lo[0].p.name+" at "+lo[0].m.pct+"% · Excel DGR"});}
 S.issues.filter(t=>t.severity==="Critical"&&t.status!=="Closed"&&t.status!=="Resolved").forEach(t=>out.push({id:t.id,title:"Critical issue — "+t.id,meta:t.plant+" · "+(t.assignee||"unassigned")+" · "+ageBucket(t)}));
 S.issues.filter(t=>!t.assignee&&t.status!=="Closed"&&t.status!=="Resolved").forEach(t=>out.push({id:t.id+"u",title:"Unassigned issue — "+t.id,meta:t.plant+" · "+t.severity+" · "+t.vertical}));
 S.issues.filter(t=>slaState(t)==="breach").forEach(t=>out.push({id:t.id+"b",title:"Overdue issue — "+t.id+" past ETC",meta:t.plant+" · "+t.vertical+" · management alert"}));
 S.issues.filter(t=>slaState(t)==="nearing").forEach(t=>out.push({id:t.id+"n",title:"Nearing ETC — "+t.id+" ("+t.severity+")",meta:t.plant+" · "+(t.assignee||"unassigned")+""}));
 S.tasks.filter(t=>t.status!=="Completed"&&taskOD(t)>0).forEach(t=>out.push({id:t.id,title:t.name+" — overdue "+taskOD(t)+"d",meta:t.plant+" · "+(escLabel(t)||t.assignee)+""}));
 S.handovers.forEach(h=>h.items.filter(i=>i.mandatory&&itemOD(i)>0&&!counted(i)).forEach(i=>out.push({id:h.id+i.id,title:"Critical handover item overdue — "+i.title,meta:h.name+" · escalated per Step 1.3"})));
 S.inventory.filter(s=>s.qty<s.min).forEach(s=>out.push({id:s.id,title:"Low stock — "+s.item,meta:s.qty+"/"+s.min+" "+s.unit+" · "+s.plant+""}));
 S.docs.filter(d=>d.expires&&dayDiff(TODAY,d.expires)<=14).forEach(d=>out.push({id:d.id,title:"Document expiring — "+d.name,meta:fmtD(d.expires)+" · owner "+d.owner+""}));
 return out;}
function washAlert(){
 const cyc=S._washCycles&&Array.isArray(S._washCycles.plants)?S._washCycles.plants:null;
 if(cyc){let low=null;cyc.forEach(p=>{const v=p.cycle_compliance_percent,t=p.compliance_threshold_percent||WASH_TH,c=p.cycle_compliance;if(typeof v==="number"&&c&&v<t&&(!low||v<low.pct))low={plant:p.plant,pct:v,t,c}});
  return low?{title:"Washing compliance "+low.pct+"% — "+low.plant,meta:"Cycle "+low.c.cycle_no+" · below the "+low.t+"% target"}:null}
 let worst=null;Object.keys(S.washMeta).forEach(p=>{
 const rows=S.washing.filter(t=>t.plant===p);if(!rows.length)return;
 const pct=Math.round(100-(rows.filter(t=>wColor(t)==="red").length/rows.length)*100);
 if(pct<WASH_TH&&(!worst||pct<worst.pct))worst={plant:p,pct};});
 return worst?{title:"Washing compliance "+worst.pct+"% — "+worst.plant,meta:"Below "+WASH_TH+"% weekly threshold · supervisor alerted"}:null;}
function quickSearchResults(){const q=(S.quickSearch||"").trim().toLowerCase();if(q.length<2)return[];const out=[],hit=(s)=>String(s||"").toLowerCase().includes(q),isSE=(S._roleLabel||S.currentRole)==="Site Engineer",sePlant=isSE?(S._sePlant||""):"";
 S.plants.filter(p=>(!isSE||!sePlant||p.name===sePlant||p.id===sePlant)&&hit([p.name,p.id,plantProject(p),plantEngineer(p)].join(" "))).forEach(p=>out.push({type:"plant",id:p.id,title:p.name||p.id,meta:(p.id||"")+" · "+(plantProject(p)||"no project")+(xlNum(p.capacity)?" · "+p.capacity+" mW":"")}));
 S.issues.filter(t=>(!isSE||!sePlant||t.plant===sePlant)&&(()=>{const p=plantRec(t.plant);return hit([t.id,t.plant,t.equip,t.maker,t.desc,t.assignee,t.vertical,p&&p.id,p&&plantProject(p)].join(" "))})()).forEach(t=>out.push({type:"issue",id:t.id,title:t.id+(t.equip?" · "+t.equip:""),meta:(t.plant||"")+" · "+t.status+(t.assignee?" · "+t.assignee:" · unassigned")}));
 TEAM_POOL.filter(n=>hit(n)).forEach(n=>out.push({type:"person",id:n,title:n,meta:"Engineer / assignee"}));
 S.tasks.filter(t=>(!isSE||!sePlant||t.plant===sePlant)&&hit([t.id,t.name,t.equip,t.plant].join(" "))).forEach(t=>out.push({type:"task",id:t.id,title:t.name,meta:t.plant+" · due "+fmtD(t.due)}));
 if(!isSE)S.handovers.filter(h=>hit([h.handoverId,h.name,h.client].join(" "))).forEach(h=>out.push({type:"handover",id:h.id,title:h.name,meta:h.handoverId+" · "+(HO_ST[h.status]||h.status)}));
 return out.slice(0,10);
}
function openSearchResult(type,id){const isSE=(S._roleLabel||S.currentRole)==="Site Engineer",sePlant=isSE?(S._sePlant||""):"";S.quickSearch="";if(type==="issue"){const it=(S.issues||[]).find(x=>x.id===id);if(isSE&&sePlant&&it&&it.plant!==sePlant){toast("Site Engineer can only open records for "+sePlant+".");render();return}openIssue(id);return}if(type==="person"){S.workWho=id;goView("work");return}if(type==="task"){const tk=(S.tasks||[]).find(x=>x.id===id);if(isSE&&sePlant&&tk&&tk.plant!==sePlant){toast("Site Engineer can only open records for "+sePlant+".");render();return}S.schedF.q=id;goTab("scheduled");return}if(type==="handover"){if(isSE){toast("Project Handover is not available in Site Engineer view.");render();return}S.view="om-module";S.omTab="handover";S.hoOpen=id;persist();render();return}if(type==="plant"){const pp=S.plants.find(z=>z.name===id||z.id===id);if(isSE&&sePlant&&pp&&pp.name!==sePlant&&pp.id!==sePlant){toast("Site Engineer can only open their own plant.");render();return}if(pp)openPlantPage(pp.id);else{S.dashPlant=isSE&&sePlant?sePlant:id;goView(isSE?"dashboard":"plants")}}}
function openPlantPage(id){const role=S._roleLabel||S.currentRole||"O&M Head";if(role==="Site Engineer"&&S._sePlant){const mine=(S.plants||[]).find(p=>p.name===S._sePlant||p.id===S._sePlant);if(mine&&id!==mine.id&&id!==mine.name){toast("Site Engineer can only open their own plant.");S.view="dashboard";persist();render();return}}S.view="plant";S.plantId=id;S.modal=null;persist();render()}
function openIssue(id){S.view="om-module";S.omTab="issues";S.modal="ticket";S.modalCtx={id};persist();render()}
function drillIssues(patch){S.issF=blankIssF(Object.assign({},S.issF,patch||{}));S.tablePages.issues=1;goTab("issues")}
function actionNotification(id){const ev=(S.events||[]).find(e=>e.id===id);if(ev){markEventRead(id);S.notifOpen=false;if(ev.targetType==="issue"){S.issF.q=ev.targetId;goTab("issues");return}if(ev.targetType==="task"){S.schedF.q=ev.targetId;goTab("scheduled");if(typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role==="Site Engineer"&&(S.tasks||[]).some(t=>t.id===ev.targetId))openModal("taskDetail",{id:ev.targetId});return}if(ev.targetType==="handover"){S.view="om-module";S.omTab="handover";S.hoOpen=ev.targetId;persist();render();return}}if(id==="xl-nr"||id==="xl-low"){S.plF={q:"",rep:id==="xl-nr"?"not":"all",tgt:"all",cap:"all",ach:id==="xl-low"?"lo":"all",sort:id==="xl-low"?"ach":"name"};S.tablePages.plants=1;S.dashPlant="all";S.notifOpen=false;goView("plants");return}const issue=S.issues.find(t=>id.startsWith(t.id));if(issue){openIssue(issue.id);return}const task=S.tasks.find(t=>t.id===id);if(task){S.schedF.q=task.id;goTab("scheduled");return}const stock=S.inventory.find(s=>s.id===id);if(stock){S.extSub="inventory";goTab("services");return}const doc=S.docs.find(d=>d.id===d.id);if(doc){S.extSub="documents";goTab("services");return}const handover=S.handovers.find(h=>id.startsWith(h.id));if(handover){S.view="om-module";S.omTab="handover";S.hoOpen=handover.id;persist();render();}}

/* Rows inserted straight into Supabase can carry NULLs; make every text field a string so one bad row cannot break a module. */
function s91NormalizeRows(){
 const fix=(rows,keys)=>(rows||[]).filter(r=>r&&typeof r==="object").map(r=>{keys.forEach(k=>{if(r[k]==null)r[k]=""});return r});
 S.plants=fix(S.plants,["id","name","project","district","discom","location"]);
 S.tasks=fix(S.tasks,["id","plant","name","type","equip","freq","assignee","status"]);
 S.issues=fix(S.issues,["id","plant","vertical","sub","equip","desc","status"]);
 S.washing=fix(S.washing,["id","plant","inv","tableId"]).map(w=>{if(!Array.isArray(w.history))w.history=[];return w});
 S.equipment=fix(S.equipment,["equipment_code","equipment_name","equipment_type","status"]);
 S.handovers=(S.handovers||[]).filter(h=>h&&typeof h==="object").map(h=>{if(!Array.isArray(h.items))h.items=[];return h});
}
/* Saves only the screen the user is on. Unlike persist() it does NOT trigger a full-state server comparison. */
function persistView(){["view","omTab","extSub","hoOpen","plantId","washPlant","schedScope"].forEach(k=>{if(S[k]!==undefined)saveK(k,S[k])})}
