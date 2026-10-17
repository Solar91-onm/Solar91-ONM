"use strict";
/* ================================================================
   RENDER
   ================================================================ */
let _s91RenderFrame=0;
function scheduleRender(){if(_s91RenderFrame)return;_s91RenderFrame=requestAnimationFrame(function(){_s91RenderFrame=0;render()})}
function render(){
 const _ae=document.activeElement;
 const _focus=_ae&&_ae!==document.body?{id:_ae.id||null,name:_ae.getAttribute&&_ae.getAttribute("name"),tag:_ae.tagName,type:_ae.type||null,ph:_ae.getAttribute&&_ae.getAttribute("placeholder"),value:("value" in _ae)?_ae.value:null,ss:typeof _ae.selectionStart==="number"?_ae.selectionStart:null,se:typeof _ae.selectionEnd==="number"?_ae.selectionEnd:null}:null;
 const _scroll={x:window.scrollX,y:window.scrollY,content:(document.querySelector(".content")||{}).scrollTop||0};
 const notifs=allNotifs();
 const hoBadge=S.handovers.filter(h=>h.status==="pending_approval"||h.items.some(i=>i.mandatory&&itemOD(i)>0&&!counted(i))).length;
 const scBadge=S.tasks.filter(t=>taskOD(t)>0).length;
 const waBadge=(typeof washDueCount==="function")?washDueCount():S.washing.filter(t=>wDue(t,((S.washMeta||{})[t.plant]||{freq:14}).freq)&&!washedToday(t)&&!excToday(t)).length;
 const isBadge=openTk(S.issues).length;
 const plant=S.plants.find(p=>p.id===S.plantId);
 const CRUMB={dashboard:["Command Center","Portfolio operations"],plants:["Command Center","Plants"],plant:["Plants",plant?plant.name:"Plant detail"],work:["Command Center","Work / Assignments"],performance:["Command Center","Performance"],reports:["Command Center","Reports"],data:["Command Center","Data / Imports"],settings:["Command Center","Settings"],handover:["Operations","Project Handover"],scheduled:["Planned Maintenance","Preventive Maintenance"],washing:["Planned Maintenance","Washing"],issues:["Command Center","Site Issues"],services:["Operations","Extra Services"],analytics:["Command Center","Analytics"]};
 const crumb=S.view==="dashboard"?CRUMB.dashboard:S.view==="plants"?CRUMB.plants:S.view==="plant"?CRUMB.plant:S.view==="work"?CRUMB.work:S.view==="performance"?CRUMB.performance:S.view==="reports"?CRUMB.reports:S.view==="data"?CRUMB.data:S.view==="settings"?CRUMB.settings:(CRUMB[S.omTab]||CRUMB.services);
 let body;
 try{body=S.view==="dashboard"?renderDashboard():S.view==="plants"?renderPlants():S.view==="plant"?renderPlantPage():S.view==="work"?renderWork():S.view==="performance"?renderPerformance():S.view==="reports"?renderReportsHub():S.view==="data"?renderDataHub():S.view==="settings"?renderSettings():S.omTab==="handover"?renderHandover():(S.omTab==="scheduled"||S.omTab==="washing")?renderScheduledHub():S.omTab==="issues"?renderIssues():S.omTab==="analytics"?renderAnalytics():renderServices()}catch(renderErr){
  console.error("Solar91 module render failed",S.view,S.omTab,renderErr);
  body='<div class="panel" style="padding:24px;border:1px solid #F5C2C0;background:#FFF7F6;border-radius:14px"><h2 style="margin:0 0 8px">This section could not be displayed</h2><p style="color:#4F5B55;margin:0 0 12px">One of the saved records has missing or unexpected data. You can still use the menu to open other sections.</p><pre style="white-space:pre-wrap;font-size:12px;margin:0 0 12px">'+esc(String(renderErr&&renderErr.message||renderErr))+'</pre><button class="btn o" onclick="render()">Try again</button></div>';
 };
 document.getElementById("app").innerHTML=
  '<div class="shell">'+sidebar({hoBadge,scBadge,waBadge,isBadge})+
  mobileNav({hoBadge,scBadge,waBadge,isBadge})+'<div class="main">'+topbar(crumb,notifs)+
  '<div class="content"><div class="portal-page-stack" style="max-width:1440px;margin:0 auto;display:flex;flex-direction:column;gap:18px">'+body+'</div></div></div></div>'+
  (function(){try{return renderModal()}catch(e){console.error("Solar91 modal render failed",e);S.modal=null;return ""}})()+(S.toastMsg?'<div class="toast">'+esc(S.toastMsg)+'</div>':"");
 document.querySelectorAll(".panel").forEach(panel=>{const heading=panel.querySelector("h2");if(heading&&(/filters/i.test(heading.textContent)||heading.textContent==="Ticket register")){panel.classList.add("filter-panel");}});
 if(_focus){let n=_focus.id?document.getElementById(_focus.id):null;if(!n&&_focus.name)n=document.querySelector('[name="'+CSS.escape(_focus.name)+'"]');if(!n&&_focus.ph)n=[...document.querySelectorAll("input,select,textarea,button")].find(x=>x.getAttribute("placeholder")===_focus.ph);if(n){try{n.focus({preventScroll:true})}catch(e){try{n.focus()}catch(e2){}}if(_focus.ss!==null&&typeof n.setSelectionRange==="function"){try{n.setSelectionRange(Math.min(_focus.ss,String(n.value||"").length),Math.min(_focus.se==null?_focus.ss:_focus.se,String(n.value||"").length))}catch(e){}}}}
 try{window.scrollTo(_scroll.x,_scroll.y);const c=document.querySelector(".content");if(c)c.scrollTop=_scroll.content}catch(e){}
}
S.toastMsg=null;
function mobileNav(b){const raw=S.view==="dashboard"?"dashboard":(S.view==="plants"||S.view==="plant")?"plants":S.view==="work"?"work":S.omTab;const act=(raw==="scheduled"||raw==="washing")?"scheduled":raw;
 const it=(id,l,ic,fn,n)=>'<div class="'+(act===id?"active":"")+'" onclick="'+fn+'">'+ic+'<span>'+l+'</span>'+(n?'<span class="side-badge">'+Math.min(n,99)+'</span>':'')+'</div>';
 const isSE=(S._roleLabel||S.currentRole)==="Site Engineer";
 if(isSE){return '<nav class="mnav">'+it("dashboard","My Plant",I.dash(18),"goView('dashboard')")+it("issues","Issues",I.alert(18),"goTab('issues')",b.isBadge)+it("scheduled","Preventive",I.clipc(18),"goScheduledOM('maintenance')",(b.scBadge||0)+(b.waBadge||0))+it("washing","Washing",I.clipc(18),"goScheduledOM('washing')",b.waBadge)+'</nav>';}
 return '<nav class="mnav">'+it("dashboard","Home",I.dash(18),"goView('dashboard')")+it("plants","Plants",I.sun(18),"goView('plants')")+it("issues","Issues",I.alert(18),"goTab('issues')",b.isBadge)+it("scheduled","Preventive",I.clipc(18),"goScheduledOM('maintenance')",(b.scBadge||0)+(b.waBadge||0))+it("work","Work",I.clipc(18),"goView('work')")+it("reports","Reports",I.gauge(18),"goView('reports')")+'</nav>'}
function sidebar(b){
 let act=S.view==="dashboard"?"dashboard":S.view==="plants"||S.view==="plant"?"plants":["work","performance","reports","data","settings"].includes(S.view)?S.view:((S.omTab==="scheduled"||S.omTab==="washing")?"scheduled":S.omTab);
 const link=(id,label,icon,fn,badgeN)=>'<div class="side-link '+(act===id?"active":"")+'" onclick="'+fn+'">'+icon+'<span>'+label+'</span>'+(badgeN?'<span class="side-badge">'+Math.min(badgeN,99)+'</span>':'')+'</div>';
 const isSE=(S._roleLabel||S.currentRole)==="Site Engineer";
 let links='';
 if(isSE){
  links='<div class="side-label">Field Operations</div>'+
   link("dashboard","My Plant",I.dash(16),"goView('dashboard')")+
   link("issues","Site Issues",I.alert(16),"goTab('issues')",b.isBadge)+
   link("scheduled","Preventive Maintenance",I.clipc(16),"goScheduledOM('maintenance')",(b.scBadge||0)+(b.waBadge||0))+
   link("washing","Washing",I.clipc(16),"goScheduledOM('washing')",b.waBadge);
 }else{
  links='<div class="side-label">Command Center</div>'+
   link("dashboard","Command Center",I.dash(16),"goView('dashboard')")+
   link("plants","Plants",I.sun(16),"goView('plants')")+
   link("issues","Site Issues",I.alert(16),"goTab('issues')",b.isBadge)+
   link("scheduled","Preventive Maintenance",I.clipc(16),"goScheduledOM('maintenance')",(b.scBadge||0)+(b.waBadge||0))+
   link("work","Work / Assignments",I.clipc(16),"goView('work')")+
   link("performance","Performance",I.gauge(16),"goView('performance')")+
   link("reports","Reports",I.gauge(16),"goView('reports')")+
   link("data","Data / Imports",I.boxes(16),"goView('data')")+
   link("settings","Settings",I.gear(16),"goView('settings')")+
   '<div class="side-label">Operations</div>'+
   link("handover","Project Handover",I.fcheck(16),"goTab('handover')",b.hoBadge)+
   link("services","Extra Services",I.boxes(16),"goTab('services')");
 }
 const displayName=S.currentUser||OM_HEAD;
 const displayRole=S._roleLabel||S.currentRole||"O&amp;M Head";
 const initials=String(displayName).split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase()||"S9";
 return '<aside class="sidebar">'+
 '<div class="side-brand"><div class="side-mark" style="background:none;border-radius:0;width:44px;height:44px"><span style="display:grid;place-items:center;width:44px;height:44px;background:#fff;border-radius:12px"><img src="/static/brand/solar91-emblem.png" width="34" height="34" alt="" style="display:block"></span></div><div class="side-title"><b style="display:flex;align-items:baseline;gap:0;font-size:15px;letter-spacing:.01em">SOLAR<span style="color:#ffa400;margin-left:6px">91<sup style="font-size:10.5px;font-weight:700;vertical-align:super;margin-left:1px;color:#ffa400">™</sup></span></b><span>O&amp;M Command Center</span></div></div>'+
  '<button type="button" class="s91-side-ask" onclick="window.s91AssistantOpen&&window.s91AssistantOpen()" aria-label="Ask Solar91 about operations"><span>✦</span><b>Ask Solar91</b><small>Find work &amp; site records</small></button>'+
  '<div class="side-scroll">'+links+'</div>'+
  '<div class="side-user"><div class="av">'+esc(initials)+'</div><div><div class="nm">'+esc(displayName)+'</div><div class="rl">'+esc(displayRole)+'</div></div></div></aside>';
}
function topbar(crumb,notifs){
 const sc=scadaUiState(),allResults=quickSearchResults();
 const authName=S.currentUser||OM_HEAD,authRole=S.currentRole||"Viewer";
 const authInitials=String(authName).split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase()||"S9";
 const isSE=(S._roleLabel||S.currentRole)==="Site Engineer";
 const sePlant=isSE?(S._sePlant||""):"";
 const results=(isSE&&sePlant)?allResults.filter(function(r){
   if(r.type==="plant") return r.id===sePlant || r.title===sePlant;
   if(r.type==="issue"){ var t=(S.issues||[]).find(function(x){return x.id===r.id}); return !t || t.plant===sePlant; }
   if(r.type==="task"){ var t2=(S.tasks||[]).find(function(x){return x.id===r.id}); return !t2 || t2.plant===sePlant; }
   if(r.type==="handover") return false;
   return true;
 }).slice(0,10):allResults;
 const scopePlant=isSE&&sePlant?sePlant:(S.view==="dashboard"?(S.dashPlant||"all"):S.omTab==="washing"&&S.view!=="dashboard"?S.washPlant:S.omTab==="scheduled"&&S.schedScope!=="all"?S.schedScope:S.omTab==="issues"&&S.issF.plant!=="all"?S.issF.plant:"all");
 const plantSelector=isSE&&sePlant
   ? '<select class="inp" style="width:168px" onchange="setPlantScope(this.value)" disabled title="Site Engineer — locked to '+esc(sePlant)+'"><option selected>'+esc(sePlant)+'</option></select>'
   : '<select class="inp" style="width:168px" onchange="setPlantScope(this.value)"><option value="all" '+(scopePlant==="all"?"selected":"")+'>All Plants</option>'+S.plants.map(p=>'<option '+(scopePlant===p.name?"selected":"")+'>'+esc(p.name)+'</option>').join("")+'</select>';
 return '<div class="topbar">'+
  '<div style="min-width:148px"><div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted-foreground)">'+esc(crumb[0])+'</div><div style="font-size:15px;font-weight:700;white-space:nowrap">'+esc(crumb[1])+'</div></div>'+
  '<div style="position:relative;flex:1;max-width:360px;display:flex;align-items:center">'+
  '<span style="position:absolute;left:11px;color:var(--muted-foreground)">'+I.search(15)+'</span>'+
  '<input class="inp" value="'+esc(S.quickSearch)+'" oninput="S.quickSearch=this.value;renderSoon()" style="padding-left:32px;background:var(--surface-subtle)" placeholder="Search plant, site, project, issue, maker, engineer…"/>'+
  (results.length?'<div class="search-results">'+results.map(r=>'<div class="search-result" data-act="search" data-type="'+esc(r.type)+'" data-id="'+esc(r.id)+'"><b>'+esc(r.title)+'</b><span>'+esc(r.meta)+'</span></div>').join("")+'</div>':'')+'</div>'+
  '<div style="margin-left:auto;display:flex;align-items:center;gap:10px">'+
  plantSelector+
  '<input class="inp" type="date" style="width:146px" value="'+TODAY+'" title="Operations date" onchange="setOpsDate(this.value)"/>'+
  '<span class="pill pillsm live-pill" title="'+esc(sc.detail)+'"><span class="dot live-dot" style="width:6px;height:6px;background:'+(sc.live?"var(--success)":"var(--primary)")+'"></span>'+(sc.live?"SCADA LIVE":"LIVE")+'</span>'+
  '<div style="position:relative"><button class="icon-btn" onclick="S.notifOpen=!S.notifOpen;render()">'+I.bell(18)+
  ((notifs.filter(n=>!n.event||!n.read).length)?'<span class="bell-count">'+Math.min(notifs.filter(n=>!n.event||!n.read).length,9)+'</span>':'')+'</button>'+
  (S.notifOpen?'<div class="notif-pop">'+
   '<div style="padding:12px 14px;border-bottom:1px solid var(--border);font-size:13px;font-weight:600">Notification engine (3.8) — handover · scheduled · washing · issues · spares · documents <button class="btn g sm" style="float:right" onclick="markAllEventsRead()">Mark events read</button></div>'+
   '<div style="max-height:340px;overflow-y:auto">'+(notifs.length?notifs.map(n=>'<div style="padding:11px 14px;border-bottom:1px solid var(--border);font-size:12px"><div class="row between" style="align-items:flex-start;gap:8px"><div><div style="font-weight:500">'+esc(n.title)+'</div><div style="color:var(--muted-foreground);font-size:12.5px;margin-top:2px">'+esc(n.meta)+'</div></div><button class="btn g sm" data-act="notif" data-id="'+esc(n.id)+'">Open</button></div></div>').join(""):'<div style="padding:20px;text-align:center;color:var(--muted-foreground);font-size:12px">All caught up.</div>')+'</div></div>':'')+
  '</div>'+
  '<div class="row" style="gap:8px;margin-left:2px;cursor:pointer" onclick="clerkSignOut()" title="Sign out"><div class="tb-av">'+esc(authInitials)+'</div><div style="line-height:1.2"><div style="font-size:12px;font-weight:600;white-space:nowrap">'+esc(authName)+'</div><div style="font-size:12px;color:var(--muted-foreground)">'+esc(authRole)+'</div></div></div>'+
  '</div></div>';
}
function setPlantScope(v){
 const isSE=(S._roleLabel||S.currentRole)==="Site Engineer";
 const locked=isSE?(S._sePlant||""):"";
 if(isSE&&locked&&v!==locked){
  toast("Site Engineer is scoped to "+locked+".");
  v=locked;
 }
 S.dashPlant=v;
 if(v==="all"){S.schedScope="all";S.issF.plant="all";}
 else{S.schedScope=v;S.issF.plant=v;S.washPlant=v;}
 persist();render();toast(v==="all"?"Scope cleared — showing all plants":"Scoped to "+v);
}
/* ---------- dashboard visualization helpers ---------- */
function dashScope(){
 const isSE=(S._roleLabel||S.currentRole)==="Site Engineer";
 if(isSE&&S._sePlant){
  const mine=S.plants.filter(p=>p.name===S._sePlant||p.id===S._sePlant);
  if(mine.length)return mine;
 }
 if(S.dashPlant&&S.dashPlant!=="all"){const f=S.plants.filter(p=>p.name===S.dashPlant);if(f.length)return f}
 return S.plants
}
function dashBarChart(hs){
 if(!hs.hours.length)return '<div style="padding:28px 0;text-align:center;font-size:12px;color:var(--muted-foreground)">No monthly generation data available</div>';
 const w=940,h=250,left=38,right=14,top=16,bottom=30,n=hs.hours.length;
 const max=Math.max(1,...hs.gen,...(hs.cons||[]),...(hs.exp||[]),...(hs.tgt||[]))*1.15;
 const gw=(w-left-right)/n, ks=[["cons",-1],["gen",0],["exp",1]].filter(([k])=>hs[k]), bw=ks.length===1?Math.min(24,gw*0.5):Math.min(11,gw*0.2), y=v=>h-bottom-(v/max)*(h-top-bottom);
 const col={cons:"#F59E0B",gen:"#22C55E",exp:"#3B82F6"},nm={cons:"Consumption",gen:"Generation",exp:"Export"};
 let bars="",grid="";[.25,.5,.75,1].forEach(f=>{const yy=y(max*f).toFixed(1);grid+='<line x1="'+left+'" x2="'+(w-right)+'" y1="'+yy+'" y2="'+yy+'" stroke="#E4E9E6" stroke-dasharray="3 4"/><text x="'+(left-5)+'" y="'+(+yy+3)+'" text-anchor="end" font-size="8.5" fill="#4F5B55">'+Math.round(max*f)+'</text>'});
 hs.hours.forEach((hb,i)=>{const gx=left+i*gw+gw/2;
  ks.forEach(([k,off])=>{const v=Math.max(0,hs[k][i]),bx=gx+off*(bw+2)-bw/2,by=y(v);
   bars+='<rect x="'+bx.toFixed(1)+'" y="'+by.toFixed(1)+'" width="'+bw+'" height="'+((h-bottom)-by).toFixed(1)+'" rx="2.5" fill="'+col[k]+'"/>';});});
 const line=hs.tgt?hs.hours.map((hb,i)=>(left+i*gw+gw/2).toFixed(1)+","+y(hs.tgt[i]).toFixed(1)).join(" "):"";
 const dots=hs.tgt?hs.hours.map((hb,i)=>'<circle cx="'+(left+i*gw+gw/2).toFixed(1)+'" cy="'+y(hs.tgt[i]).toFixed(1)+'" r="2.2" fill="#111814"/>').join(""):"";
 const labels=hs.hours.map((hb,i)=>'<text x="'+(left+i*gw+gw/2).toFixed(1)+'" y="'+(h-9)+'" text-anchor="middle" font-size="8.5" fill="#4F5B55">'+hb+'</text>').join("");
 const hits=hs.hours.map((hb,i)=>'<rect class="hit chart-hit" data-act="chart" data-id="'+esc(hb)+'" x="'+(left+i*gw).toFixed(1)+'" y="0" width="'+gw.toFixed(1)+'" height="'+h+'" data-tip="'+esc(hb+"\nGeneration: "+hs.gen[i]+" mWh"+(hs.tgt?"\nPV Syst target: "+hs.tgt[i]+" mWh\nAchievement: "+(hs.tgt[i]?Math.round(hs.gen[i]/hs.tgt[i]*100):0)+"%":"")+"\nClick to open plants")+'"/>').join("");
 const legend=ks.map(([k])=>'<i class="dot" style="width:7px;height:7px;background:'+col[k]+'"></i> '+nm[k]).concat(hs.tgt?['<i class="dot" style="width:7px;height:7px;background:#111814"></i> PV Syst target']:[]).join(" &nbsp;");
 return '<div class="line-chart-wrap"><div class="row between wrap" style="font-size:12.5px;color:var(--muted-foreground);margin-bottom:5px"><span>'+(hs.title||"")+'</span><span>'+legend+'</span></div>'+
  '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'+grid+bars+(hs.tgt?'<polyline points="'+line+'" fill="none" stroke="#111814" stroke-width="1.6"/>':'')+dots+labels+hits+'</svg></div>';
}
function ring(pct,color,size,cls){
 const na=pct==null||isNaN(pct),p=na?0:Math.max(0,Math.min(100,Math.round(pct)));size=size||74;
 return '<div class="ring '+(cls||"")+'" style="width:'+size+'px;height:'+size+'px;background:conic-gradient('+color+' '+p+'%,#E9EEEB 0)"><b style="font-size:'+Math.round(size/4.4)+'px">'+(na?"—":p+"%")+'</b></div>';
}
function donutKPI(label,pct,value,color,note,act){
 return '<div class="panel ring-card'+(act?' kpi-click':'')+'" '+(act||'')+'><div class="row" style="gap:14px;align-items:center">'+ring(pct,color)+
  '<div style="min-width:0"><div class="kpi-label">'+label+'</div><div class="kpi-value">'+value+'</div><div class="kpi-note">'+note+'</div></div></div></div>';
}
function statCard(label,value,color,note){
 return '<div class="panel ring-card"><div class="kpi-label">'+label+'</div><div class="kpi-value" style="color:'+color+'">'+value+'</div><div class="kpi-note" style="margin-top:6px">'+note+'</div></div>';
}

 
/* Renders <thead> + <tbody> from PLANT_TABLE_COLUMNS — reorder/hide/add a
   column by editing that config array; nothing here needs to change. */
function visiblePlantColumns(){
 const base=PLANT_TABLE_COLUMNS.filter(c=>c.visible),custom=customPlantColumnDefs();
 if(!custom.length)return base;
 const ai=base.findIndex(c=>c.key==="actions");
 return ai<0?base.concat(custom):base.slice(0,ai).concat(custom,base.slice(ai));
}
function plantTableHead(){return '<tr>'+visiblePlantColumns().map(c=>'<th>'+esc(c.label)+'</th>').join("")+'</tr>'}
function plantTableBody(rows){
 const cols=visiblePlantColumns();
 return rows.map(p=>'<tr class="click" data-act="plant" data-id="'+esc(p.id)+'">'+
   cols.map(c=>'<td>'+c.render(p)+'</td>').join("")+'</tr>').join("");
}

function exportPlantRegistryRows(){
 const pl=plantListRows(dashScope()); /* same filtered/sorted set the table currently shows, unpaginated */
 const customCols=S.customPlantColumns||[];
 return pl.map(p=>{
  const oi=openTk(S.issues||[]).filter(t=>t.plant===p.name),crit=oi.filter(t=>t.severity==="Critical").length;
  const row={
   "Plant Name":plantDisplayName(p.name||""),
   "Plant Code":displayCode(p.id),
   "COD":p.cod||"",
   "SPV / Project":plantProject(p)||"",
   "AC CAPACITY (kW)":plantAcKw(p)!=null?kWStrPlain(plantAcKw(p)):"",
   "DC CAPACITY (kWp)":plantDcKw(p)!=null?kWStrPlain(plantDcKw(p)):"",
   "Latitude":p.geo?p.geo.lat:"",
   "Longitude":p.geo?p.geo.lng:"",
   "District":p.district||(p.geo&&p.geo.city)||p.location||"",
   "DISCOM":p.discom||"",
   "JEN/AEN Office":"",
   "Status":plantHealth(p),
   "Open Issues":oi.length,
   "Critical":crit,
   "Engineer":plantEngineer(p)||"",
   "Last Activity":plantLastActivity(p)?fmtDT(plantLastActivity(p)):""
  };
  customCols.forEach(c=>{row[c.label]=(S.plantCustomValues&&S.plantCustomValues[p.id]&&S.plantCustomValues[p.id][c.key]!=null)?S.plantCustomValues[p.id][c.key]:""});
  return row;
 });
}
function csvCell(v){const s=s91CsvText(v);return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}
function downloadBlob(blob,filename){
 const url=URL.createObjectURL(blob),a=document.createElement("a");
 a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportPlantRegistryCSV(){
 const rows=exportPlantRegistryRows();
 if(!rows.length){toast("No plants match the current filters to export.");return}
 const headers=Object.keys(rows[0]);
 const lines=[headers.map(csvCell).join(",")].concat(rows.map(r=>headers.map(h=>csvCell(r[h])).join(",")));
 downloadBlob(new Blob(["\uFEFF"+lines.join("\r\n")],{type:"text/csv;charset=utf-8;"}),"Plant_Registry_"+(S.opsDate||TODAY)+".csv");
 toast("Plant Registry exported — "+rows.length+" plant(s) (CSV).");
}
async function exportPlantRegistryExcel(){
 const rows=exportPlantRegistryRows();
 if(!rows.length){toast("No plants match the current filters to export.");return}
 try{await ensureXlsxLoaded()}catch(error){console.error("Could not load Excel export library",error);toast("Excel support could not load. Check your connection and retry, or export as CSV.");return}
 const ws=XLSX.utils.json_to_sheet(rows),wb=XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(wb,ws,"Plant Registry");
 XLSX.writeFile(wb,"Plant_Registry_"+(S.opsDate||TODAY)+".xlsx");
 toast("Plant Registry exported — "+rows.length+" plant(s) (Excel).");
}
/* Compact "Plant Data" import panel — Excel/CSV in, match report out.
   See PLANT MATCHING CONFIGURATION / FIELD MAPPING above for the logic. */
function plantImportPanel(){
 const rpt=r=>r?('<div style="font-size:12.5px;margin-top:6px;line-height:1.6"><b>'+esc(r.file)+'</b> · '+r.total+' record(s) processed<br>✓ '+r.matched+' matched'+(r.unmatched&&r.unmatched.length?'<br>⚠ '+r.unmatched.length+' unmatched: '+esc(r.unmatched.slice(0,5).join(", "))+(r.unmatched.length>5?" +"+(r.unmatched.length-5)+" more":""):"")+((r.invalid&&r.invalid.length)?'<br>⚠ '+r.invalid.length+' invalid coordinate(s)':"")+((r.duplicate&&r.duplicate.length)?'<br>⚠ '+r.duplicate.length+' duplicate/ambiguous — needs review':"")+'</div>'):"";
 return '<div class="panel">'+dbStatusBanner()+'<h2 style="font-size:15px;font-weight:700">Plant Data</h2><p style="font-size:12px;color:var(--muted-foreground);margin:4px 0 12px">Upload the Plant Information workbook and the plant coordinates file. Rows are matched by site code and enrich the existing plant register — nothing is duplicated or replaced.</p>'+
  '<div class="row wrap" style="gap:18px;align-items:flex-start">'+
  '<div style="min-width:220px;flex:1"><span class="lbl">Import Plant Excel</span><input type="file" class="inp" accept=".xlsx,.xls,.xlsm,.csv" onchange="pickPlantExcel(this)"/>'+rpt(S.plantImportReport)+(S.plantImportReport&&S.plantImportReport.warnings&&S.plantImportReport.warnings.length?'<div style="font-size:12.5px;color:var(--warning-strong);margin-top:4px">'+S.plantImportReport.warnings.map(esc).join(" ")+'</div>':"")+'</div>'+
  '<div style="min-width:220px;flex:1"><span class="lbl">Import Location Excel</span><input type="file" class="inp" accept=".xlsx,.xls,.csv" onchange="pickLocationFile(this)"/>'+rpt(S.locationImportReport)+'</div>'+
  '</div></div>';
}
/* Small, honest connection status for the Supabase master-data layer — never
   hides a failure and never claims a save happened when it didn't. */
function dbStatusBanner(){
 const n=(S.plants||[]).length;
 return '<div class="bn-info banner" style="margin-bottom:12px;border-color:var(--success)">🗄️ <b>Database:</b> FastAPI → Supabase PostgreSQL is the source of truth ('+n+' plant'+(n===1?"":"s")+' loaded).</div>';
}
function renderPlants(){
 const sp=dashScope();
 const pl=plantListRows(sp),size=12,plPage=Math.min(S.tablePages.plants||1,Math.max(1,Math.ceil(pl.length/size)));S.tablePages.plants=plPage;const plRows=pl.slice((plPage-1)*size,plPage*size);
 const unspecifiedN=sp.filter(p=>plantDcKw(p)==null).length;
 const totalDckW=totalPlantCapacitykW(sp,"capacitykW");
 const totalAckW=totalPlantCapacitykW(sp,"acCapacitykW");
 const health={Healthy:0,Warning:0,Critical:0};sp.forEach(p=>{health[plantHealth(p)]++});
 const healthSlices=[{label:"Healthy",id:"Healthy",n:health.Healthy,color:"#16A34A",act:"plantHealth"},{label:"Warning",id:"Warning",n:health.Warning,color:"#D97706",act:"plantHealth"},{label:"Critical",id:"Critical",n:health.Critical,color:"#DC4C3E",act:"plantHealth"}];
 const open=openTk(S.issues||[]);
 const plantBars=sp.map(p=>({label:p.name||p.id,id:p.id,n:open.filter(t=>t.plant===p.name).length})).filter(x=>x.n).sort((a,b)=>b.n-a.n).slice(0,8);
 return '<div class="row between wrap" style="align-items:flex-end;gap:10px"><div><h1 style="font-size:20px;font-weight:800">Plants</h1><p style="font-size:12.5px;color:var(--muted-foreground);margin:4px 0 0">'+sp.length+' plant'+(sp.length===1?"":"s")+' · health from live issues · click a row for plant detail</p></div><div class="row wrap" style="gap:8px">'+(unspecifiedN?'<span class="pill pillsm" style="background:var(--warning-soft);color:var(--warning-strong)">'+unspecifiedN+' capacity not specified</span>':'')+'<button class="btn p sm" onclick="openModal(\'addPlant\')">'+I.plus(13)+' Add Plant</button><button class="btn o sm" onclick="openModal(\'commission\')">'+I.plus(13)+' New plant (commissioning)</button><button class="btn o sm" onclick="openModal(\'addPlantColumn\')">'+I.plus(13)+' Add Column</button></div></div>'+
  '<div class="kpis8">'+kpiTile("Total",sp.length,"register","var(--foreground)","")+kpiTile("Healthy",health.Healthy,"no open issues","var(--success)",'data-act="plantHealth" data-id="Healthy"')+kpiTile("Warning",health.Warning,"open issues","var(--warning)",'data-act="plantHealth" data-id="Warning"')+kpiTile("Critical",health.Critical,"needs attention","var(--danger)",'data-act="plantHealth" data-id="Critical"')+kpiTile("Total DC capacity",s91Mw(totalDckW)+" MWp",(unspecifiedN?unspecifiedN+" plant"+(unspecifiedN===1?"":"s")+" without DC value":"all plants"),"var(--info)","")+kpiTile("Total AC capacity",s91Mw(totalAckW)+" MW",sp.filter(p=>plantAcKw(p)==null).length+" without AC value","var(--info)","")+'</div>'+
  '<div class="kgrid" style="grid-template-columns:1fr 1fr;align-items:stretch"><div class="panel">'+vizDonut("Plant health",healthSlices,{center:"plants",note:"Derived from open / critical / overdue issues",empty:"No plants"})+'</div><div class="panel"><h2 style="font-size:14px;font-weight:700">Open issues by plant</h2><p style="font-size:12.5px;color:var(--muted-foreground);margin:3px 0 10px">Click a bar to open the plant</p>'+rankBars(plantBars,"barPlant","#D97706")+'</div></div>'+
  plantImportPanel()+
  '<div id="plant-register-anchor" class="panel no-stick" style="padding:0"><div class="row between wrap" style="padding:16px 20px 0;align-items:flex-end;gap:10px"><div><h2 style="font-size:15px;font-weight:600">Plant register</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Search, filter and page. Blank capacity stays Not specified.</p></div><div class="row wrap" style="gap:8px"><button class="btn o sm" onclick="exportPlantRegistryCSV()">'+I.dl(13)+' Export CSV ('+pl.length+')</button><button class="btn o sm" onclick="exportPlantRegistryExcel()">'+I.dl(13)+' Export Excel ('+pl.length+')</button></div></div>'+
  plantListBar()+'<div style="overflow-x:auto"><table class="dense"><thead>'+plantTableHead()+'</thead><tbody>'+
  (plRows.length?plantTableBody(plRows):'<tr><td colspan="'+visiblePlantColumns().length+'">'+emptyState("No plants match your filters","Clear filters or search a different site / project.")+'</td></tr>')+'</tbody></table></div>'+tablePager("plants",pl.length,size)+'</div>';
}
function renderPlantPage(){
 const p=S.plants.find(z=>z.id===S.plantId)||S.plants[0];
 if(!p)return '<div class="panel" style="text-align:center;padding:40px"><h2>No plant selected</h2><button class="btn p" data-act="go" data-id="plants">Open plants</button></div>';
 const x=XL_BY[p.id],sm="font-size:12.5px;color:var(--muted-foreground)",eng=plantEngineer(p),hth=plantHealth(p);
 const kv=(k,v,s)=>'<div class="metric" style="flex:1;min-width:120px;padding:10px 12px"><div style="font-size:12px;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.04em">'+k+'</div><div style="font-size:17px;font-weight:700;margin-top:2px">'+v+'</div>'+(s?'<div style="'+sm+'">'+s+'</div>':'')+'</div>';
 const plantIssues=S.issues.filter(t=>t.plant===p.name);
 const openI=openTk(plantIssues),crit=openI.filter(t=>t.severity==="Critical"),od=openI.filter(isOverdueIssue),res=plantIssues.filter(t=>t.status==="Resolved"||t.status==="Closed");
 const eqMap={};plantIssues.forEach(t=>{const k=t.equip||"—";if(!eqMap[k])eqMap[k]={n:0,maker:t.maker||""};eqMap[k].n++});
 const eqRows=Object.entries(eqMap).sort((a,b)=>b[1].n-a[1].n);
 const eqBars=eqRows.map(e=>({label:e[0]+(e[1].maker?" · "+e[1].maker:""),id:e[0],n:e[1].n}));
 const stCols={Open:"#DC4C3E",Assigned:"#3B82F6","In Progress":"#0F9F8C",Resolved:"#16A34A",Closed:"#94A3B8"};
 const stCounts=["Open","Assigned","In Progress","Resolved","Closed"].map(b=>({label:b,id:b,n:plantIssues.filter(t=>statusBucket(t)===b).length,color:stCols[b],act:"issuesPlantStatus"}));
 const act=[].concat(plantIssues.flatMap(t=>(t.progress||[]).map(pr=>({at:pr.at,text:t.id+" · "+pr.note,id:t.id}))),(S.audit||[]).filter(a=>String(a.text||"").includes(p.name)||String(a.text||"").includes(p.id)).map(a=>({at:a.at,text:a.text,id:null}))).sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,10);
 let h='<div class="row between wrap" style="gap:10px;align-items:flex-end"><div><button class="btn g sm" data-act="go" data-id="plants">← Plants</button><div style="font-size:12.5px;color:var(--muted-foreground);margin-top:8px">Portfolio → '+esc(plantProject(p)||"Project")+' → Plant</div><h1 style="font-size:20px;font-weight:800;margin-top:4px">'+(p.name?esc(p.name):'<span style="color:var(--danger)">Name missing</span>')+'</h1><p style="font-size:12.5px;color:var(--muted-foreground);margin:4px 0 0">'+esc(p.id)+' · '+(plantProject(p)||"Project not specified")+' · '+(x&&x.projectCompany?esc(x.projectCompany):"Location not specified")+'</p></div><div class="row wrap" style="gap:8px">'+badge(hth)+(eng?'<button class="btn o sm" data-act="workWho" data-id="'+esc(eng)+'">'+esc(eng)+'</button>':'')+'<button class="btn p sm" data-act="newIssuePlant" data-id="'+esc(p.name)+'">'+I.plus(13)+' Raise issue</button></div></div>';
 h+='<div class="kpis8">'+kpiTile("Open",openI.length,"live tickets","var(--info)",'data-act="issuesPlant" data-id="'+esc(p.name)+'"')+kpiTile("Critical",crit.length,"priority","var(--danger)","")+kpiTile("Overdue",od.length,"past ETC","var(--danger)","")+kpiTile("Resolved",res.length,"closed loop","var(--success)","")+kpiTile("Equipment",eqRows.length,"with issues","var(--foreground)","")+kpiTile("DC capacity",plantDcKw(p)!=null?kWStr(plantDcKw(p))+" kWp":"Not specified",plantDcKw(p)!=null?s91Mw(plantDcKw(p))+" MWp":"add it with Edit plant","var(--foreground)","")+kpiTile("AC capacity",plantAcKw(p)!=null?kWStr(plantAcKw(p))+" kW":"Not specified",plantAcKw(p)!=null?s91Mw(plantAcKw(p))+" MW":"add it with Edit plant","var(--info)","")+kpiTile("Health",hth,"from issues","var(--"+(hth==="Critical"?"danger":hth==="Warning"?"warning":"success")+")","")+kpiTile("Engineer",eng||"—","site owner","var(--info)","")+'</div>';
 h+='<div class="kgrid" style="grid-template-columns:1fr 1fr;align-items:stretch"><div class="panel">'+vizDonut("Issue status",stCounts,{center:"issues",note:"This plant only",empty:"No issues for this plant"})+'</div><div class="panel"><h2 style="font-size:14px;font-weight:700">Equipment / maker</h2><p style="font-size:12.5px;color:var(--muted-foreground);margin:3px 0 10px">Issue count on recorded equipment</p>'+rankBars(eqBars,"barEquip","#3B82F6")+'</div></div>';
 const plantEquipment=(S.equipment||[]).filter(e=>String(e.plant_id)===String(p.dbId));
 h+='<div class="panel"><div class="row between wrap" style="gap:10px"><div><h2 style="font-size:14px;font-weight:700">Equipment at this plant</h2><p style="font-size:12.5px;color:var(--muted-foreground);margin-top:3px">'+plantEquipment.length+' registered item'+(plantEquipment.length===1?'':'s')+' · ownership, warranty and service dates</p></div><button class="btn o sm" onclick="m26GoEqPlant('+JSON.stringify(String(p.dbId||''))+')">Open equipment register</button></div></div>';
 h+='<div class="panel"><div class="row between wrap" style="margin-bottom:8px"><h2 style="font-size:15px;font-weight:700">Issue trend</h2></div>'+issueSpark(issueTrendRows(S.trendDays||14,plantIssues))+'</div>';
 h+='<div class="kgrid" style="grid-template-columns:1.5fr .7fr;align-items:start"><div class="panel no-stick" style="padding:0"><div style="padding:16px 16px 0"><div class="row between"><h2 style="font-size:15px;font-weight:600">Plant issues</h2><button class="btn g sm" data-act="issuesPlant" data-id="'+esc(p.name)+'">Full register</button></div></div>';
 if(plantIssues.length){h+='<div style="overflow-x:auto"><table class="dense"><thead><tr><th>Issue</th><th>Equipment</th><th>Priority</th><th>Age</th><th>Assignee</th><th>Status</th></tr></thead><tbody>'+
  plantIssues.slice(0,12).map(t=>'<tr class="click" data-act="issue" data-id="'+esc(t.id)+'"><td><b>'+esc(t.id)+'</b><div style="font-size:12px;color:var(--muted-foreground)">'+esc(t.vertical)+'</div></td><td>'+esc(t.equip||"—")+'</td><td>'+badge(t.severity)+'</td><td>'+esc(ageBucket(t))+'</td><td>'+(t.assignee?esc(t.assignee):'<span style="color:var(--danger)">Unassigned</span>')+'</td><td>'+badge(t.status)+'</td></tr>').join("")+'</tbody></table></div>';}
 else h+=emptyState("No issues for this plant","Raise an issue from this screen.");
 h+='</div><div class="col" style="gap:12px"><div class="panel"><h2 style="font-size:14px;font-weight:700">Recent activity</h2>'+(act.length?act.map(a=>'<div class="'+(a.id?"click":"")+'" '+(a.id?'data-act="issue" data-id="'+esc(a.id)+'"':'')+' style="padding:7px 0;border-bottom:1px solid var(--border);font-size:12px">'+esc(a.text)+'<div style="font-size:12px;color:var(--muted-foreground)">'+esc(a.at||"")+'</div></div>').join(""):emptyState("No activity yet","Assignments and status changes will appear here."))+'</div></div></div>';
 return h;
}
function statusColor(status){const s=String(status||"").toLowerCase();if(/critical|breach|overdue|expired|rejected|open/.test(s))return"var(--danger)";if(/pending|attention|warning|vendor|exception/.test(s))return"var(--warning)";if(/progress|review|assigned|acknowledged/.test(s))return"var(--info)";if(/completed|healthy|active|resolved|closed|approved|washed|available|compliant|scheduled|synced/.test(s))return"var(--success)";return"var(--status-slate)"}
function statusCircleCards(title,records){
 const counts={};records.forEach(r=>{const k=r.status||"No status";counts[k]=(counts[k]||0)+1});const total=records.length;
 const cards=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,4);
 return '<div class="panel performance-panel"><div class="performance-toolbar"><div><h2 style="font-size:15px;font-weight:600">'+title+'</h2><p style="font-size:12px;color:var(--muted-foreground);margin-top:3px">Live record counts by current status.</p></div><span class="pill pillsm" style="background:var(--secondary);color:var(--primary)">'+total+' total</span></div><div class="status-overview">'+(cards.length?cards.map(c=>{const pct=total?Math.round(c[1]/total*100):0,color=statusColor(c[0]);return '<div class="status-circle-card"><div class="status-circle-top"><span>'+esc(c[0])+'</span><span class="dot" style="width:7px;height:7px;background:'+color+'"></span></div><div class="status-circle-value"><div class="status-ring" style="background:conic-gradient('+color+' '+pct+'%,var(--muted) 0)"><i>'+pct+'%</i></div><div><b>'+c[1]+'</b><br><span>records</span></div></div></div>'}).join(""):'<div class="muted" style="font-size:12px;padding:8px">No records in this view.</div>')+'</div></div>';
}
