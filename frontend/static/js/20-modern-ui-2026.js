/* ================================================================
   Solar91 O&M — 2026 UI layer (presentation only)
   Wraps existing renderers to add markup. No API calls, no data writes,
   no changes to permissions or business logic.
   ================================================================ */


/* ---------------- Donut card helper (SVG, no libraries) ---------------- */
function m26Donut(title,sub,parts,centerVal,centerLbl,onclick){
 const tot=parts.reduce((a,x)=>a+x.v,0),R=44,C=2*Math.PI*R;let off=0,arcs="";
 if(tot>0)parts.filter(x=>x.v>0).forEach(x=>{const len=x.v/tot*C;arcs+='<circle cx="60" cy="60" r="'+R+'" fill="none" stroke="'+x.c+'" stroke-width="15" stroke-dasharray="'+Math.max(0,len-2).toFixed(1)+' '+(C-Math.max(0,len-2)).toFixed(1)+'" stroke-dashoffset="'+(-off).toFixed(1)+'" transform="rotate(-90 60 60)"/>';off+=len});
 return '<div class="m26-dn" '+(onclick?'onclick="'+onclick+'" style="cursor:pointer" role="button" tabindex="0"':'')+'><div class="m26-dn-h"><b>'+esc(title)+'</b>'+(sub?'<span>'+esc(sub)+'</span>':'')+'</div><div class="m26-dn-b"><svg viewBox="0 0 120 120" width="112" height="112" role="img" aria-label="'+esc(title)+'"><circle cx="60" cy="60" r="'+R+'" fill="none" stroke="#EEF1EF" stroke-width="15"/>'+arcs
  +'<text x="60" y="58" text-anchor="middle" font-size="22" font-weight="700" fill="#16201A">'+esc(String(centerVal))+'</text><text x="60" y="74" text-anchor="middle" font-size="9.5" fill="#4F5B55">'+esc(centerLbl||"")+'</text></svg>'
  +'<div class="m26-dn-l">'+parts.map(x=>'<div><i style="background:'+x.c+'"></i>'+esc(x.l)+'<b>'+x.v+'</b></div>').join("")+'</div></div></div>';
}

/* ---------------- Site Issues: List / Board toggle ---------------- */
function m26IssView(mode){S.issView=mode==="board"?"board":"list";render()}

function m26Board(){
 const f=Object.assign(blankIssF(),S.issF||{});
 const list=filterIssues(S.issues,f);
 const lanes=[["Open","#3B82F6"],["Assigned","#6675D9"],["In Progress","#0F9F8C"],["Resolved","#16A34A"]];
 const bucket=t=>{const b=statusBucket(t);return b==="Closed"?"Resolved":b};
 const CAP=8;
 let h='<div class="m26-board">';
 lanes.forEach(([name,color])=>{
  const items=list.filter(t=>bucket(t)===name).sort((a,b)=>(SEV_RANK[a.severity]??9)-(SEV_RANK[b.severity]??9)||issueAgeDays(b)-issueAgeDays(a));
  h+='<div class="m26-lane" style="--lc:'+color+'"><div class="m26-lane-h"><i></i>'+esc(name)+'<b>'+items.length+'</b></div>';
  if(!items.length)h+='<div class="m26-empty">Nothing here</div>';
  items.slice(0,CAP).forEach(t=>{
   const p=plantRec(t.plant),age=issueAgeDays(t),late=slaState(t)==="breach";
   const title=t.title||t.summary||t.description||t.desc||t.vertical||t.id;
   h+='<div class="m26-card sev-'+esc(issueLevel(t))+'" data-rid="'+esc(t.id)+'" data-act="issue" data-id="'+esc(t.id)+'" tabindex="0">'
    +'<div class="t">'+esc(String(title).slice(0,70))+'</div>'
    +'<div class="s">'+esc(t.id)+' · '+esc(p?p.id:t.plant)+(t.equip?' · '+esc(t.equip):'')+'</div>'
    +'<div class="f">'+badge(issueLevel(t))+(late?badge("Overdue"):"")+'<span class="age">'+age+'d</span>'
    +(t.assignee?'<span class="m26-av" title="'+esc(t.assignee)+'">'+esc(ccIni(t.assignee))+'</span>':'<span class="oi-unassigned">Unassigned</span>')
    +'</div></div>';
  });
  if(items.length>CAP)h+='<div class="m26-more">+'+(items.length-CAP)+' more · switch to List to see all</div>';
  h+='</div>';
 });
 return h+'</div>';
}

if(typeof renderIssues==="function"){
 const m26OrigIssues=renderIssues;
 renderIssues=function(){
  const h=m26OrigIssues.apply(this,arguments);
  const i=h.indexOf('<div id="section-results"');
  if(i<0)return '<div class="m26 m26-issues">'+h+'</div>';
  const mode=S.issView==="board"?"board":"list";
  let dn="";try{const L=filterIssues(S.issues,Object.assign(blankIssF(),S.issF||{}));const cnt=f=>L.filter(f).length,bk=t=>statusBucket(t);
   dn='<div class="m26-dnrow">'+m26Donut("Priority mix","select a bar below to filter",ISSUE_LEVELS.map(k=>({l:k,v:cnt(t=>issueLevel(t)===k),c:SEV_COLOR[k]})),L.length,"issues")
   +m26Donut("Workflow status","current distribution",[{l:"Open",v:cnt(t=>bk(t)==="Open"),c:"#3B82F6"},{l:"Assigned",v:cnt(t=>bk(t)==="Assigned"),c:"#6675D9"},{l:"In progress",v:cnt(t=>bk(t)==="In Progress"),c:"#0F9F8C"},{l:"Resolved",v:cnt(t=>bk(t)==="Resolved"||bk(t)==="Closed"),c:"#16A34A"}],cnt(t=>bk(t)!=="Resolved"&&bk(t)!=="Closed"),"open")
   +m26Donut("Ownership","who is on it",[{l:"Assigned",v:cnt(t=>!!t.assignee),c:"#16A34A"},{l:"Unassigned",v:cnt(t=>!t.assignee),c:"#DC4C3E"}],cnt(t=>!t.assignee),"unassigned")+'</div>'}catch(e){dn=""}
  const bar='<div class="m26-bar"><div class="m26-seg" role="group" aria-label="Issue view">'
   +'<button type="button" class="'+(mode==="list"?"on":"")+'" onclick="m26IssView(\'list\')">☰ List</button>'
   +'<button type="button" class="'+(mode==="board"?"on":"")+'" onclick="m26IssView(\'board\')">▦ Board</button></div>'
   +'<span class="m26-note">'+(mode==="board"?"Grouped by workflow status · most urgent first":"Sorted by your selected order")+'</span></div>';
  return '<div class="m26 m26-issues">'+h.slice(0,i)+bar+(mode==="board"?m26Board():h.slice(i))+'</div>';
 };
}

/* ---------------- Preventive Maintenance: week planner ---------------- */


/* ---------------- Washing: table map ---------------- */
function m26WashMap(){
 const rows=(S.washing||[]).filter(t=>t.plant===S.washPlant);
 if(!rows.length)return "";
 const cls=t=>washedToday(t)?"dn":excToday(t)?"ex":daysSince(t)===999?"nv":wColor(t)==="red"?"od":wColor(t)==="amber"?"mid":"ok";
 const cnt={dn:0,ok:0,mid:0,od:0,ex:0,nv:0};rows.forEach(t=>cnt[cls(t)]++);
 const sorted=rows.slice().sort((a,b)=>String(a.tableId).localeCompare(String(b.tableId),undefined,{numeric:true}));
 return '<div class="panel" style="margin-bottom:14px"><div class="m26-pl-head"><h2>Table map · '+esc(S.washPlant)+'</h2><span class="m26-note" style="margin-left:auto;font-size:12px;color:var(--muted-foreground)">'+rows.length+' tables · '+cnt.od+' overdue</span></div>'
  +'<div class="m26-washgrid"><div><div class="m26-map">'+sorted.map(t=>{const c=cls(t),d=daysSince(t);
    return '<div class="m26-tb '+c+'" title="'+esc(t.tableId+" · "+(d===999?"never washed":d+" days since last wash"))+'">'+esc(String(t.tableId).replace(/^.*?(\d+)$/,"$1").slice(-3))+'</div>';}).join("")+'</div>'
  +'<div class="m26-legend"><span><i style="background:#16A34A"></i>Washed today</span><span><i style="background:#CBEBD7"></i>Fresh</span><span><i style="background:#FAD9A0"></i>Due soon</span><span><i style="background:#DC4C3E"></i>Overdue</span><span><i style="background:#fff;border:1.5px dashed #94A3B8"></i>Exception</span><span><i style="background:#F1F4F2"></i>Never washed</span></div></div>'
  +m26Donut("Wash status","this plant",[{l:"Washed today",v:cnt.dn,c:"#16A34A"},{l:"Fresh",v:cnt.ok,c:"#CBEBD7"},{l:"Due soon",v:cnt.mid,c:"#FAD9A0"},{l:"Overdue",v:cnt.od,c:"#DC4C3E"},{l:"Exception / never",v:cnt.ex+cnt.nv,c:"#94A3B8"}],rows.length?Math.round((cnt.dn+cnt.ok)/rows.length*100)+"%":"—","compliant")+'</div></div>';
}

/* Washing: open on a plant that is already set up and show its data; ask for a new setup only when the person
   explicitly picks a plant that has no washing tables yet. */
function m26WashPlants(){const have=new Set((S.washing||[]).map(t=>t.plant));return (S.plants||[]).map(p=>p.name).filter(n=>have.has(n))}
function m26WashPick(name){s91SyncScope(name);S.washPlant=name;S.m26WashSetup=m26WashPlants().indexOf(name)<0;persist();render()}
function m26WashBar(done){
 const plants=S.plants||[];if(plants.length<2)return "";
 return '<div class="m26-washbar"><div><div class="k">Plant</div><select class="inp" onchange="m26WashPick(this.value)">'
  +plants.map(p=>{const ok=done.indexOf(p.name)>=0;return '<option value="'+esc(p.name)+'"'+(p.name===S.washPlant?' selected':'')+'>'+(ok?'✓ ':'○ ')+esc(p.name)+(ok?'':'  — not set up yet')+'</option>'}).join("")+'</select></div>'
  +'<div class="m26-note">'+done.length+' of '+plants.length+' plants have washing set up. Pick a plant marked ○ to set it up.</div></div>';
}
if(typeof renderWashing==="function"){
 const m26OrigWashing=renderWashing;
 renderWashing=function(){
  const done=m26WashPlants();
  if(done.length&&done.indexOf(S.washPlant)<0&&!S.m26WashSetup)S.washPlant=done[0];
  if(done.indexOf(S.washPlant)>=0)S.m26WashSetup=false;
  const showing=done.indexOf(S.washPlant)>=0;
  let map="";if(showing){try{map=m26WashMap()}catch(e){map=""}}
  return m26WashBar(done)+map+m26OrigWashing.apply(this,arguments);
 };
}

if(typeof renderScheduledHub==="function"){
 const m26OrigHub=renderScheduledHub;
 renderScheduledHub=function(){return '<div class="m26 m26-pm">'+m26OrigHub.apply(this,arguments)+'</div>'};
}

/* ---------------- Command Center: action hub (reads existing data only) ---------------- */
function m26Nav(kind,arg){
 if(kind==="issue")openIssue(arg);

 else if(kind==="pm"){
   goScheduledOM("maintenance");
   setTimeout(()=>{
     const el=document.getElementById("section-results");
     if(el) el.scrollIntoView({behavior:"smooth",block:"start"});
   },80);
 }

 else if(kind==="wash"){
   if(arg)S.washPlant=arg;
   goScheduledOM("washing");
 }

 else if(kind==="issues"){
   goTab("issues");
   setTimeout(()=>{
     const el=document.getElementById("section-results");
     if(el) el.scrollIntoView({behavior:"smooth",block:"start"});
   },80);
 }

 else if(kind==="plants"){
   S.view="plants";
   persist();
   render();
 }

 else if(kind==="plant")openPlantPage(arg);
}

/* ETC countdown shared by the issue register, triage queue and Command Center */
function etcInfo(t){
 if(!t||t.status==="Closed"||t.status==="Resolved"||!t.etc)return null;
 const left=hrsBetween(NOW_ISO,t.etc);if(!Number.isFinite(left))return null;
 const a=Math.abs(left),txt=a<1?"<1h":a<48?Math.round(a)+"h":Math.round(a/24)+"d";
 return left<0?{cls:"bad",txt:"ETC breached "+txt+" ago"}:{cls:left<=4?"warn":"ok",txt:"ETC in "+txt};
}
function etcLabel(t){const e=etcInfo(t);return e?'<div class="oi-etc '+e.cls+'">'+esc(e.txt)+'</div>':""}
function m26Need(f){S.m26Need=f;render()}
const m26Js=v=>esc(JSON.stringify(v==null?"":v));

/* Washing on the dashboard follows the cycle model used on the Washing page (3 cycles a month per plant). */
function m26WashSummary(){
 if(typeof washCyclesEnsureLoaded==="function")washCyclesEnsureLoaded();
 const d=S._washCycles;
 if(d&&Array.isArray(d.plants)){
  const rows=d.plants.filter(p=>p.active!==false);
  const late=rows.filter(p=>p.overdue_bucket&&p.overdue_bucket!=="on_track").sort((a,b)=>(b.overdue_days||0)-(a.overdue_days||0));
  const below=rows.filter(p=>typeof p.cycle_compliance_percent==="number"&&p.cycle_compliance_percent<(p.compliance_threshold_percent||WASH_TH));
  /* compliance for the cycle whose window contains today, as tables done / due by today (O&M Head and Assignees only) */
  const cc=d.portfolio&&d.portfolio.cycle_compliance||null;
  const byName={};rows.forEach(p=>{byName[p.plant]=p});
  const done=rows.filter(p=>p.cycles_this_month>=p.monthly_target).length,ok=rows.length-late.length;
  return{cycle:true,rows,late,below,byName,ok,done,cc,pct:rows.length?Math.round(100*ok/rows.length):null};
 }
 return{cycle:false,rows:[],late:[],below:[],byName:{},ok:0,done:0,pct:null};
}
const fmtCcDay=iso=>{const d=new Date(iso+"T00:00:00");return isNaN(d)?iso:d.toLocaleDateString("en-GB",{day:"numeric",month:"short"})};
function m26OpenWash(plantId){goScheduledOM("washing");if(plantId&&typeof openWashingPlantDetails==="function")setTimeout(()=>openWashingPlantDetails(plantId),60)}
function m26Hub(){
 const plants=S.plants||[],issues=S.issues||[],open=openTk(issues);
 const crit=open.filter(t=>normalizeIssueSeverity(t.severity)==="Critical"),od=open.filter(isOverdueIssue),un=open.filter(t=>!t.assignee);
 const hc={Healthy:0,Warning:0,Critical:0};plants.forEach(p=>{const k=plantHealth(p);if(hc[k]!=null)hc[k]++});
 const mw=totalPlantCapacitykW(plants,"capacitykW")/1000,acMw=totalPlantCapacitykW(plants,"acCapacitykW")/1000;
 const tasks=S.tasks||[],tDone=tasks.filter(t=>t.status==="Completed").length,tOd=tasks.filter(t=>taskOD(t)>0);
 const pmPct=tDone+tOd.length?Math.round(tDone/(tDone+tOd.length)*100):null;
 const dueWk=tasks.filter(t=>t.status!=="Completed"&&t.due&&t.due>=TODAY&&t.due<=addDays(TODAY,6)).length;
 const wash=S.washing||[],wByPlant={};
 wash.forEach(t=>{const w=wByPlant[t.plant]||(wByPlant[t.plant]={n:0,ok:0,red:0}),fq=((S.washMeta||{})[t.plant]||{freq:14}).freq;w.n++;if(daysSince(t)<=fq)w.ok++;if(wColor(t)==="red")w.red++});
 const wOk=wash.filter(t=>daysSince(t)<=(((S.washMeta||{})[t.plant]||{freq:14}).freq)).length,wRed=wash.filter(t=>wColor(t)==="red").length;
 const wPct=wash.length?Math.round(wOk/wash.length*100):null;
 const tel=plants.filter(p=>Number.isFinite(p.generation)&&p.generation>0),hasTel=tel.length>0;
 const gen=tel.reduce((a,p)=>a+p.generation,0);
 const avg=k=>{const v=plants.map(p=>p[k]).filter(x=>Number.isFinite(x)&&x>0);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null};
 const av=avg("availability"),prv=avg("pr"),fmtN=n=>n>=100?Math.round(n).toLocaleString():n.toFixed(1);
 const now=new Date(),hr=now.getHours()+now.getMinutes()/60,frac=Math.min(1,Math.max(0,(hr-6)/12.5));
 const ang=Math.PI*(1-frac),sx=150+120*Math.cos(ang),sy=130-120*Math.sin(ang);
 const greet=hr<12?"Good morning":hr<17?"Good afternoon":"Good evening";
 const who=(S.currentUser||"").split(" ")[0];
 /* ---- layout (Oct 2026): layered hero with live KPIs, then work lanes. Same figures and links as before. ---- */
 const ws=m26WashSummary();
 const washRedN=ws.cycle?ws.late.length:(typeof washLinked==="function"?washLinked():wash).filter(t=>wColor(t)==="red"&&!washedToday(t)&&!excToday(t)).length;
 const critUn=crit.filter(t=>!t.assignee).length;
 const sevN=k=>open.filter(t=>normalizeIssueSeverity(t.severity)===k).length,med=sevN("Medium");
 const mwTxt=v=>v>0?(v>=10?Math.round(v):v.toFixed(2))+" MW":"—";
 const nav=on=>on?' onclick="'+on+'" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();'+on.replace(/"/g,"&quot;")+'}" role="button" tabindex="0"':'';
 /* segmented bar: parts [{v,c,l}] */
 const seg=(parts)=>{const t=parts.reduce((a,p)=>a+p.v,0);return '<div class="cx-seg" aria-hidden="true">'+(t?parts.filter(p=>p.v).map(p=>'<i style="flex:'+p.v+';background:'+p.c+'" title="'+esc(p.l)+': '+p.v+'"></i>').join(""):'<i style="flex:1;background:var(--cx-line)"></i>')+'</div>'};
 const ring=(pct,c)=>{const v=pct==null?0:Math.max(0,Math.min(100,pct)),r=22,C=2*Math.PI*r;return '<svg class="cx-ring" viewBox="0 0 54 54" aria-hidden="true"><circle cx="27" cy="27" r="'+r+'" fill="none" stroke="var(--cx-ring-bg)" stroke-width="6"/><circle cx="27" cy="27" r="'+r+'" fill="none" stroke="'+c+'" stroke-width="6" stroke-linecap="round" stroke-dasharray="'+(C*v/100).toFixed(1)+' '+C.toFixed(1)+'" transform="rotate(-90 27 27)"/></svg>'};
 const healthPct=plants.length?Math.round(100*hc.Healthy/plants.length):null;

 let h='<div class="cc26 cx">';
 /* ---- hero ---- */
 const pulse=[];
 if(crit.length)pulse.push('<b>'+crit.length+' critical</b> issue'+(crit.length===1?'':'s')+' open');
 if(od.length)pulse.push('<b>'+od.length+' overdue</b>');
 if(un.length)pulse.push('<b>'+un.length+'</b> without an owner');
 if(tOd.length)pulse.push('<b>'+tOd.length+'</b> maintenance task'+(tOd.length===1?'':'s')+' late');
 if(washRedN)pulse.push('<b>'+washRedN+'</b> '+(ws.cycle?'plant'+(washRedN===1?'':'s')+' behind on washing':'tables past their wash cycle'));
 const pri=[
  [critUn,"critical unassigned","bad","m26Nav('issues')"],
  [od.length,"overdue issues","bad","m26Nav('issues')"],
  [un.length-critUn,"waiting for an owner","warn","m26Nav('issues')"],
  [tOd.length,"late maintenance tasks","warn","m26Nav('pm')"],
  [washRedN,ws.cycle?"plants behind a washing deadline":"tables past wash cycle","info","m26Nav('wash')"]
 ].filter(x=>x[0]>0);
 const sun='<svg class="cx-sun" viewBox="0 0 120 64" aria-label="Daylight progress"><path d="M8,58 A52,52 0 0 1 112,58" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="5" stroke-linecap="round"/>'+(frac>0?'<path d="M8,58 A52,52 0 0 1 '+(60+52*Math.cos(ang)).toFixed(1)+','+(58-52*Math.sin(ang)).toFixed(1)+'" fill="none" stroke="#F5B821" stroke-width="5" stroke-linecap="round"/><circle cx="'+(60+52*Math.cos(ang)).toFixed(1)+'" cy="'+(58-52*Math.sin(ang)).toFixed(1)+'" r="6" fill="#FCD34D" stroke="#0B4F2C" stroke-width="2"/>':'')+'</svg>';
 h+='<section class="cx-hero"><div class="cx-hero-main"><div class="cx-date">'+sun+'<span>'+now.toLocaleDateString(undefined,{weekday:"long",day:"numeric",month:"long"})+'</span></div>'
  +'<h1>'+greet+(who?', '+esc(who):'')+'</h1>'
  +'<p class="cx-pulse">'+(pulse.length?pulse.join(' · ')+'.':'Everything is on track across '+plants.length+' plant'+(plants.length===1?'':'s')+'.')+'</p>'
  +'<div class="cx-prio">'+(pri.length?pri.map(x=>'<button type="button" class="cx-pp '+x[2]+'" onclick="'+x[3]+'"><b>'+x[0]+'</b> '+x[1]+'</button>').join(""):'<span class="cx-pp ok">✓ All clear — nothing urgent today</span>')+'</div>'
  +'<div class="cx-cap"><span><small>Plants</small><b>'+plants.length+'</b></span><span><small>DC capacity</small><b>'+mwTxt(mw)+'</b></span><span><small>AC capacity</small><b>'+mwTxt(acMw)+'</b></span>'
  +(hasTel?'<span><small>Generation (latest)</small><b>'+fmtN(gen)+' mWh</b></span>':'')+(hasTel&&prv!=null?'<span><small>Performance ratio</small><b>'+prv.toFixed(1)+'%</b></span>':'')+(hasTel&&av!=null?'<span><small>Availability</small><b>'+av.toFixed(1)+'%</b></span>':'')+'</div></div>';
 const kpi=(cls,label,val,sub,visual,on)=>'<div class="cx-kpi '+cls+'"'+nav(on)+'><div class="cx-kpi-top"><span>'+label+'</span>'+(on?'<em aria-hidden="true">→</em>':'')+'</div><div class="cx-kpi-v">'+val+'</div>'+visual+'<div class="cx-kpi-s">'+sub+'</div></div>';
 h+='<div class="cx-kpis">'
  +kpi("k-health","Plant health",'<b>'+hc.Healthy+'</b><small>/ '+plants.length+' healthy</small>',(hc.Warning+hc.Critical)?(hc.Critical?hc.Critical+' critical · ':'')+hc.Warning+' warning':'No plant needs attention',seg([{v:hc.Healthy,c:"#34D399",l:"Healthy"},{v:hc.Warning,c:"#FBBF24",l:"Warning"},{v:hc.Critical,c:"#F87171",l:"Critical"}]),"m26Nav('plants')")
  +kpi("k-issues","Open issues",'<b>'+open.length+'</b><small>'+crit.length+' critical</small>',od.length+' overdue · '+un.length+' unassigned',seg([{v:crit.length,c:"#F87171",l:"Critical"},{v:med,c:"#60A5FA",l:"Medium"}]),"m26Nav('issues')")
  +kpi("k-pm","Maintenance on time",'<b>'+(pmPct==null?'—':pmPct+'%')+'</b>',dueWk+' due this week'+(tOd.length?' · '+tOd.length+' late':''),'<div class="cx-bar"><i style="width:'+(pmPct||0)+'%;background:#34D399"></i></div>',"m26Nav('pm')")
  +(ws.cycle&&ws.cc&&ws.cc.due?kpi("k-wash","Washing compliance"+(ws.cc.cycle_no?" · cycle "+ws.cc.cycle_no:""),'<b>'+ws.cc.percent+'%</b><small>current cycle</small>',(ws.cc.start?fmtCcDay(ws.cc.start)+'–'+fmtCcDay(ws.cc.end)+' · ':'')+(ws.below.length?ws.below.length+' plant'+(ws.below.length===1?'':'s')+' below target':'all plants on target')+(ws.late.length?' · '+ws.late.length+' behind deadline':''),'<div class="cx-bar"><i style="width:'+(ws.cc.percent||0)+'%;background:#38BDF8"></i></div>',"m26Nav('wash')")
   :kpi("k-wash","Washing on track",'<b>'+(ws.cycle?(ws.pct==null?'—':ws.pct+'%'):(wPct==null?'—':wPct+'%'))+'</b>',ws.cycle?(ws.late.length?ws.late.length+' behind deadline':'all plants on track')+' · '+ws.done+' month done':wRed+' tables overdue','<div class="cx-bar"><i style="width:'+((ws.cycle?ws.pct:wPct)||0)+'%;background:#38BDF8"></i></div>',"m26Nav('wash')"))
  +'</div></section>';

 /* ---- operations overview donut cards: issue, maintenance and panel-washing breakdowns with drill-downs ---- */
 if(typeof ccOpsOverviewPanel==="function")h+=ccOpsOverviewPanel(plants,open,blankIssF());

 /* ---- needs you now + plants needing attention ---- */
 const items=[],f=S.m26Need||"all";
 open.slice().sort((a,b)=>(SEV_RANK[a.severity]??9)-(SEV_RANK[b.severity]??9)||issueAgeDays(b)-issueAgeDays(a))
  .filter(t=>t.severity==="Critical"||isOverdueIssue(t)||!t.assignee).slice(0,5).forEach(t=>{
   const p=plantRec(t.plant),tag=t.severity==="Critical"?"Critical":isOverdueIssue(t)?"Overdue":"Unassigned",e=etcInfo(t);
   items.push({g:"issues",cls:t.severity==="Critical"?"bad":"warn",ico:t.assignee?"⚠":"⚑",kind:"Issue",
    title:(t.vertical||"Issue")+(t.desc?" — "+t.desc:""),meta:[t.id,p?p.id:t.plant,issueAgeDays(t)+"d old"].concat(t.equip&&t.equip!=="—"?[t.equip]:[]),
    tags:[[tag,t.severity==="Critical"||tag==="Overdue"?"bad":"warn"]].concat(t.assignee?[[t.assignee,"mute"]]:[]).concat(e?[[e.txt,e.cls==="bad"?"bad":e.cls==="warn"?"warn":"mute"]]:[]),
    btn:t.assignee||AUTH_IDENTITY.role!=="O&M Head"?"":'<button class="bt p" onclick="m26Nav(\'issue\','+m26Js(t.id)+')">Assign</button>',
    open:'<button class="bt'+(t.assignee?' p':'')+'" onclick="m26Nav(\'issue\','+m26Js(t.id)+')">Open</button>'});});
 const resolved=issues.filter(t=>t.status==="Resolved").length;
 if(resolved)items.push({g:"issues",cls:"ok",ico:"✓",kind:"Issue",title:resolved+" resolved issue"+(resolved===1?"":"s")+" awaiting closure",meta:["Review evidence and close"],tags:[],btn:"",open:'<button class="bt p" onclick="m26Nav(\'issues\')">Review</button>'});
 tOd.sort((a,b)=>taskOD(b)-taskOD(a)).slice(0,2).forEach(t=>items.push({g:"pm",cls:"warn",ico:"🛠",kind:"Maintenance",title:t.name,meta:[plantRec(t.plant)?plantRec(t.plant).id:t.plant],tags:[[taskOD(t)+" days late","warn"]],btn:"",open:'<button class="bt p" onclick="m26Nav(\'pm\')">Open</button>'}));
 if(ws.cycle)ws.late.slice(0,3).forEach(w=>items.push({g:"wash",cls:w.overdue_bucket==="7d"?"bad":"warn",ico:"💧",kind:"Washing",title:"Washing cycle "+(w.overdue_cycle||w.current_cycle)+" is "+w.overdue_days+" day"+(w.overdue_days===1?"":"s")+" late",meta:[w.site_code,w.plant],tags:[[w.assignee_name||"no Assignee",w.assignee_name?"mute":"warn"]],btn:"",open:'<button class="bt p" onclick="m26OpenWash('+m26Js(w.plant_id)+')">Open</button>'}));
 else Object.entries(wByPlant).filter(([,w])=>w.red>0).sort((a,b)=>b[1].red-a[1].red).slice(0,2).forEach(([pn,w])=>items.push({g:"wash",cls:"info",ico:"💧",kind:"Washing",title:w.red+" table"+(w.red===1?"":"s")+" past wash cycle",meta:[plantRec(pn)?plantRec(pn).id:pn],tags:[],btn:"",open:'<button class="bt p" onclick="m26Nav(\'wash\','+m26Js(pn)+')">Plan wash</button>'}));
 const shown=items.filter(i=>f==="all"||i.g===f),cnt=g=>items.filter(i=>i.g===g).length;
 const chip=(id,l,n)=>'<button type="button" class="cx-chip'+(f===id?" on":"")+'" aria-pressed="'+(f===id)+'" onclick="m26Need(\''+id+'\')">'+l+(n!=null?' <span>'+n+'</span>':'')+'</button>';
 h+='<div class="cx-grid"><section class="cx-card cx-need"><header><div><h2>Needs you now</h2><p>Highest priority first</p></div><span class="cx-count">'+items.length+'</span></header>'
  +'<div class="cx-chips">'+chip("all","All",items.length)+chip("issues","Issues",cnt("issues"))+chip("pm","Maintenance",cnt("pm"))+chip("wash","Washing",cnt("wash"))+'</div>'
  +(shown.length?'<div class="cx-list">'+shown.map(i=>'<div class="cx-it '+i.cls+'"><div class="ic">'+i.ico+'</div><div class="tx"><div class="t">'+esc(String(i.title).slice(0,90))+'</div><div class="m"><span class="k">'+esc(i.kind)+'</span>'+i.meta.map(x=>'<span>'+esc(x)+'</span>').join("")+i.tags.map(x=>'<em class="'+x[1]+'">'+esc(x[0])+'</em>').join("")+'</div></div><div class="ac">'+i.btn+i.open+'</div></div>').join("")+'</div>':'<div class="cx-clear">✓ All clear. Nothing needs attention right now.</div>')+'</section>';

 {const rows=plants.map(p=>{
   const oi=open.filter(t=>t.plant===p.name),c=oi.filter(t=>t.severity==="Critical").length,b=oi.filter(isOverdueIssue).length,u=oi.filter(t=>!t.assignee).length;
   const cw=ws.byName[p.name],w=wByPlant[p.name],wp=ws.cycle?(cw&&typeof cw.cycle_compliance_percent==="number"?cw.cycle_compliance_percent:null):(w&&w.n?Math.round(100*w.ok/w.n):null),pm=tOd.filter(t=>t.plant===p.name).length;
   return{p,n:oi.length,c,b,u,wp,pm,score:c*5+b*3+u*2+pm*2+(wp!=null&&wp<WASH_TH?2:0)};
  }).filter(r=>r.score>0).sort((a,b)=>b.score-a.score).slice(0,8),top=Math.max(1,...rows.map(r=>r.score));
  const tag=(v,l,cls)=>v?'<em class="'+cls+'">'+v+' '+l+'</em>':'';
  h+='<section class="cx-card cx-plants"><header><div><h2>Plants needing attention</h2><p>Worst first · click a plant</p></div><button type="button" class="cx-link" onclick="m26Nav(\'plants\')">All plants →</button></header>'
   +(rows.length?'<div class="cx-plist">'+rows.map(r=>{const tone=r.c||r.b?"bad":"warn";return '<div class="cx-prow '+tone+'"'+nav("m26Nav('plant',"+m26Js(r.p.id).replace(/&quot;/g,"'")+")")+'><div class="nm"><b>'+esc(r.p.name)+'</b><small>'+esc(r.p.id)+' · '+r.n+' open</small></div><div class="tags">'+tag(r.c,"critical","bad")+tag(r.b,"overdue","bad")+tag(r.u,"no owner","warn")+tag(r.pm,"PM late","warn")+(r.wp!=null?'<em class="'+(r.wp>=WASH_TH?"ok":"bad")+'">wash '+r.wp+'%</em>':'')+'</div><div class="sc"><i style="width:'+Math.round(r.score/top*100)+'%"></i></div></div>'}).join("")+'</div>'
    :'<div class="cx-clear">✓ All plants are running clean.</div>')+'</section></div>';}

 /* ---- team workload + generation ---- */
 const load={};open.forEach(t=>{const k=t.assignee||"Unassigned";load[k]=(load[k]||0)+1});
 const lrows=Object.entries(load).sort((a,b)=>b[1]-a[1]).slice(0,6),lmax=Math.max(1,...lrows.map(x=>x[1]));
 h+='<div class="cx-grid'+(hasTel?'':' one')+'"><section class="cx-card cx-team"><header><div><h2>Team workload</h2><p>Open issues per person</p></div></header>'
  +(lrows.length?lrows.map(([n,c])=>'<div class="cc26-wl"><span class="av'+(n==="Unassigned"?' un':'')+'">'+(n==="Unassigned"?"⚑":esc(ccIni(n)))+'</span><div class="b"><div>'+esc(n)+'</div><div class="bar"><i style="width:'+Math.round(c/lmax*100)+'%;background:'+(n==="Unassigned"?"#DC4C3E":c/lmax>.7?"#D97706":"#16A34A")+'"></i></div></div><b>'+c+'</b></div>').join(""):'<div class="cx-clear">No open issues.</div>')+'</section>';
 if(hasTel){const mx=Math.max(...tel.map(p=>p.generation));
  h+='<section class="cx-card"><header><div><h2>Generation by plant</h2><p>mWh · latest telemetry</p></div></header><div class="cc26-gen">'
   +tel.slice().sort((a,b)=>b.generation-a.generation).slice(0,8).map(p=>'<div class="gc"><span class="v">'+fmtN(p.generation)+'</span><i style="height:'+Math.max(6,Math.round(p.generation/mx*110))+'px"></i><span class="n" title="'+esc(p.name)+'">'+esc(p.id)+'</span></div>').join("")+'</div></section>';}
 h+='</div></div>';
 return h;
}

if(typeof renderDashboard==="function"){
 const m26OrigDash=renderDashboard;
 renderDashboard=function(){
  const base=m26OrigDash.apply(this,arguments);
  const role=((typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role)||S._roleLabel||S.currentRole||"O&M Head");
  if(role==="Site Engineer")return base;
  let hub="";try{hub=m26Hub()}catch(e){hub=""}
  return hub?'<div class="m26">'+hub+'</div>':base;
 };
}


/* ---------------- Settings · Team & access: any email address is allowed ---------------- */
if(typeof taAddForm==="function"){
 const m26OrigAddForm=taAddForm;
 taAddForm=function(){
  let h=m26OrigAddForm.apply(this,arguments);
  h=h.replace('placeholder="name@company.com"','placeholder="Any email, e.g. name@gmail.com" type="email" autocomplete="off" autocapitalize="off" spellcheck="false"');
  h=h.replace('Email (they must sign in with this)','Email — personal or company, any provider');
  h=h.replace('<div class="ta-form-note">','<div class="ta-form-note"><b>Email:</b> any address works (Gmail, Outlook, Yahoo or a company address). Type the exact address the person will sign in with. Capital letters do not matter. ');
  return h;
 };
}


/* ---------------- Settings · Team & access: clear Remove / Restore, hide removed people ---------------- */
if(typeof taSummaryRow==="function"){
 const m26OrigSummary=taSummaryRow;
 taSummaryRow=function(u){
  const h=m26OrigSummary.apply(this,arguments),id=esc(u.id);
  const cell=u.active
   ?'<td><button class="btn o sm" '+(u.is_self?'disabled title="You cannot remove your own access" ':'title="They are signed out and can no longer use the portal. History is kept and you can restore them any time." ')+'onclick="taToggleActive(\''+id+'\',false)" style="color:#B3372B;border-color:#F3C9C4">Remove access</button></td>'
   :'<td><span class="ta-pill off" style="margin-right:6px">Removed</span><button class="btn p sm" onclick="taToggleActive(\''+id+'\',true)">Restore</button></td>';
  return h.replace(/<td><button [^>]*class="ta-switch[^"]*"[^>]*><span><\/span><\/button><\/td>/,cell);
 };
}
if(typeof taUserBody==="function"){
 const m26OrigBody=taUserBody;
 taUserBody=function(u){return (!u.active&&!TA.showRemoved)?"":m26OrigBody.apply(this,arguments)};
}
if(typeof teamAccessPanel==="function"){
 const m26OrigTeam=teamAccessPanel;
 teamAccessPanel=function(){
  let h=m26OrigTeam.apply(this,arguments);
  if(!h)return h;
  const gone=(TA.users||[]).filter(u=>!u.active).length;
  h=h.replace("<th>Active</th>","<th>Access</th>");
  h=h.replace("Changes apply on their next screen load.","Changes apply on their next screen load. <b>To change an Assignee's equipment types later</b>, pick from the dropdown in their row and press <b>Save</b>; you can do this any time. <b>Remove access</b> signs someone out but keeps their history, and you can restore them whenever you like.");
  if(gone)h=h.replace('<button class="btn o sm" onclick="taLoad(true)">Refresh</button>','<button class="btn o sm" onclick="taLoad(true)">Refresh</button><label style="font-size:12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" '+(TA.showRemoved?"checked ":"")+'onchange="TA.showRemoved=this.checked;render()"> Show removed ('+gone+')</label>');
  return h;
 };
}


/* ================================================================
   Site Issues + Preventive Maintenance register enhancements.
   All domain writes use their dedicated APIs.
   ================================================================ */
function m26Head(){const r=(typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role)||S.currentRole||"";return r==="O&M Head"||r==="Regional O&M Head"}
function m26Refocus(id){setTimeout(()=>{const e=document.getElementById(id);if(e)e.focus()},40)}

/* ---- Preventive Maintenance task steps ---- */
function m26TaskSteps(t){return Array.isArray(t.steps)?t.steps.slice():((typeof TSUB!=="undefined"&&TSUB[t.type])||[]).slice()}
function m26PatchTask(id,patch){S.tasks=S.tasks.map(t=>t.id===id?Object.assign({},t,typeof patch==="function"?patch(t):patch):t)}
async function m26SaveTaskApi(id,body,message){
 try{
  const result=await apiFetch("/api/scheduled/tasks/"+encodeURIComponent(id)+"/schedule",{method:"PATCH",body});
  const index=S.tasks.findIndex(t=>t.id===id);
  if(index>=0)S.tasks[index]=Object.assign({},S.tasks[index],result.task);
  render();toast(message);return true;
 }catch(e){toast(e.message||"Could not save the Preventive Maintenance task.");return false}
}
async function m26StepAdd(id){
 const el=document.getElementById("m26-step-new"),v=(el&&el.value||"").trim(),t=S.tasks.find(x=>x.id===id);
 if(!t)return;if(!v){toast("Type the step first.");return}
 if(v.length>160){toast("Keep a step under 160 characters.");return}
 const steps=m26TaskSteps(t);
 if(steps.some(x=>x.toLowerCase()===v.toLowerCase())){toast("That step is already in the list.");return}
 steps.push(v);
 if(await m26SaveTaskApi(id,{steps},"Step added."))m26Refocus("m26-step-new");
}
async function m26StepRemove(id,i){
 const t=S.tasks.find(x=>x.id===id);if(!t)return;
 const steps=m26TaskSteps(t),gone=steps.splice(i,1)[0];if(gone==null)return;
 await m26SaveTaskApi(id,{steps},"Step removed.");
}
async function m26StepsRestore(id){
 if(!confirm("Restore the standard checklist for this task type? Your added and removed steps will be undone."))return;
 await m26SaveTaskApi(id,{steps:null},"Standard steps restored.");
}
function m26TaskStepsHtml(t){
 const head=m26Head(),can=head&&t.status!=="Completed",steps=m26TaskSteps(t),custom=Array.isArray(t.steps),id=m26Js(t.id);
 const done=s=>t.completion&&t.completion.sub&&t.completion.sub.indexOf(s)>=0;
 return '<div class="m26-steps"><div class="m26-steps-h"><b>Execution checklist</b><span>'+steps.length+' step'+(steps.length===1?'':'s')+(custom?' · customised':'')+'</span>'
  +(can&&custom?'<a onclick="m26StepsRestore('+id+')">Restore standard steps</a>':'')+'</div>'
  +(steps.length?steps.map((s,i)=>'<div class="m26-step"><i class="'+(done(s)?'ok':'')+'"></i><span>'+esc(s)+'</span>'+(can?'<button type="button" title="Remove this step" aria-label="Remove step" onclick="m26StepRemove('+id+','+i+')">✕</button>':'')+'</div>').join(""):'<div class="m26-steps-empty">No steps yet.'+(can?' Add the first one below.':'')+'</div>')
  +(can?'<div class="m26-step-add"><input id="m26-step-new" class="inp" maxlength="160" placeholder="Add a step, e.g. Photograph the nameplate" onkeydown="if(event.key===\'Enter\')m26StepAdd('+id+')"><button type="button" class="btn p sm" onclick="m26StepAdd('+id+')">+ Add step</button></div>':'')
  +'</div>';
}

/* ---- Preventive Maintenance: edit + reset ---- */
function m26EditTask(id){S.modal="m26EditTask";S.modalCtx={id};render()}
function m26EditTaskModal(id){
 const t=S.tasks.find(x=>x.id===id);if(!t)return "";
 const fld=(l,k,v,ty,extra)=>'<div class="field"><span class="lbl">'+l+'</span><input id="m26t-'+k+'" class="inp" type="'+(ty||"text")+'" value="'+esc(v||"")+'" '+(extra||"")+'/></div>';
 const eq=(typeof equipmentOptions==="function"?equipmentOptions(t.plant):[]);
 const safety=[...new Set((S.tasks||[]).map(x=>x.safety).filter(x=>x&&x!=="—"))];
 const body='<div class="bn-info banner" style="margin-bottom:12px">Changes apply to this task. To change who does it, use <b>Reassign</b>. Steps are edited in the checklist on the task page.</div>'
  +fld("Task name","name",t.name)
  +'<div class="row" style="gap:12px"><div style="flex:1">'+fld("Equipment / asset","equip",t.equip,"text",'list="m26t-eqlist"')+'<datalist id="m26t-eqlist">'+eq.map(x=>'<option value="'+esc(x)+'">').join("")+'</datalist></div>'
  +'<div class="field" style="flex:1"><span class="lbl">Frequency</span><select id="m26t-freq" class="inp">'+Object.keys(FREQ_MAP).map(k=>'<option'+(k===t.freq?' selected':'')+'>'+k+'</option>').join("")+'</select></div></div>'
  +'<div class="row" style="gap:12px"><div style="flex:1">'+fld("Next due date","due",t.due,"date")+'</div><div style="flex:1">'+fld("Duration","duration",t.duration)+'</div></div>'
  +fld("Tools / spares","tools",t.tools)+fld("SOP reference","sop",t.sop)
  +fld("Safety precautions","safety",t.safety,"text",'list="m26t-safelist"')+'<datalist id="m26t-safelist">'+safety.map(x=>'<option value="'+esc(x)+'">').join("")+'</datalist>';
 return modal("Edit task — "+esc(t.name),esc(t.plant)+" · "+esc(t.id),body,'<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="m26SaveTask('+m26Js(id)+')">Save changes</button>',true);
}
async function m26SaveTask(id){
 const t=S.tasks.find(x=>x.id===id);if(!t)return;
 const g=k=>{const e=document.getElementById("m26t-"+k);return e?String(e.value).trim():""};
 const name=g("name"),due=g("due");
 if(!name){toast("Task name cannot be empty.");return}
 if(!/^\d{4}-\d{2}-\d{2}$/.test(due)){toast("Pick a valid due date.");return}
 const next={name,equipment_ref:g("equip"),frequency:g("freq")||t.freq,due_on:due,duration:g("duration"),tools:g("tools"),sop:g("sop"),safety:g("safety")};
 const changed=next.name!==t.name||next.equipment_ref!==(t.equip||"")||next.frequency!==t.freq||next.due_on!==t.due||
  next.duration!==(t.duration||"")||next.tools!==(t.tools||"")||next.sop!==(t.sop||"")||next.safety!==(t.safety||"");
 if(!changed){closeModal();toast("Nothing changed.");return}
 if(t.due&&due>t.due&&t.due<TODAY){
  const reason=prompt("A reason is required to move an overdue task later:");
  if(!reason||!reason.trim()){toast("The due date was not changed; enter a reason to move an overdue task later.");return}
  next.reason=reason.trim();
 }
 if(await m26SaveTaskApi(id,next,"Task updated.")){S.modal="taskDetail";S.modalCtx={id};render()}
}
async function m26ResetTask(id){
 const t=S.tasks.find(x=>x.id===id);if(!t||t.status==="Scheduled")return;
 const msg=t.status==="Completed"?"Reset this COMPLETED task back to Scheduled? The completion details are cleared (photos stay on file). A follow-up task may already exist.":"Reset this task back to Scheduled?";
 if(!confirm(msg))return;
 try{
  const result=await apiFetch("/api/scheduled/tasks/"+encodeURIComponent(id)+"/reset",{method:"POST"});
  m26PatchTask(id,result.task);render();toast("Task reset to Scheduled.");
 }catch(e){toast(e.message||"Could not reset the Preventive Maintenance task.")}
}
function m26DecorateTask(h,id){
 const t=S.tasks.find(x=>x.id===id);if(!t)return h;
 const a=h.indexOf('Execution checklist</div>');
 if(a>=0){
  const start=h.lastIndexOf('<div',a);
  const cands=[h.indexOf('<div class="bn-info banner" style="margin-bottom:10px"><b>Completion evidence',a),h.indexOf('<div class="bn-warn banner" style="margin-bottom:10px">No completion submitted',a)].filter(i=>i>0);
  if(cands.length)h=h.slice(0,start)+m26TaskStepsHtml(t)+h.slice(Math.min.apply(null,cands));
 }
 if(m26Head()){
  const btn=(t.status!=="Completed"?'<button class="btn o sm" onclick="m26EditTask('+m26Js(id)+')">Edit task</button>':'')+(t.status!=="Scheduled"?'<button class="btn o sm" style="color:#B3372B;border-color:#F3C9C4" onclick="m26ResetTask('+m26Js(id)+')">Reset</button>':'');
  const k=h.lastIndexOf('<button class="btn o sm" onclick="closeModal()">Close</button>');
  if(k>=0)h=h.slice(0,k)+btn+h.slice(k);
 }
 return h;
}

/* ---- Site Issues: steps + reset ---- */
function m26IssSteps(t){return Array.isArray(t.steps)?t.steps.slice():[]}
function m26PatchIssue(id,patch){S.issues=S.issues.map(t=>t.id===id?Object.assign({},t,typeof patch==="function"?patch(t):patch):t)}
function m26IssueDbId(t){return t&&(t.dbId||t._dbId)||""}
async function m26RefreshIssueSteps(id){
 const issue=S.issues.find(x=>x.id===id),dbId=m26IssueDbId(issue);if(!issue||!dbId)return;
 try{
  const rows=await apiFetch("/api/issues/"+encodeURIComponent(dbId)+"/steps");
  m26PatchIssue(id,{steps:rows.map(row=>({id:row.id,t:row.title,done:row.done})),_stepsLoaded:true});
  return true;
 }catch(e){toast(e.message||"Could not load issue work steps.")}
 return false;
}
async function m26IssStepAdd(id){
 const el=document.getElementById("m26-istep-new"),v=(el&&el.value||"").trim(),t=S.issues.find(x=>x.id===id);
 if(!t)return;if(!v){toast("Type the step first.");return}
 if(v.length>160){toast("Keep a step under 160 characters.");return}
 const steps=m26IssSteps(t);
 if(steps.some(x=>x.t.toLowerCase()===v.toLowerCase())){toast("That step is already in the list.");return}
 const dbId=m26IssueDbId(t);if(!dbId){toast("This issue is not available from the server yet.");return}
 try{
  await apiFetch("/api/issues/"+encodeURIComponent(dbId)+"/steps",{method:"POST",body:{title:v}});
  await m26RefreshIssueSteps(id);render();toast("Step added.");m26Refocus("m26-istep-new");
 }catch(e){toast(e.message||"Could not add the issue work step.")}
}
async function m26IssStepToggle(id,i){
 const t=S.issues.find(x=>x.id===id);if(!t)return;const steps=m26IssSteps(t);if(!steps[i])return;
 const dbId=m26IssueDbId(t),step=steps[i];if(!dbId||!step.id){toast("This issue step needs to be refreshed before editing.");return}
 try{
  await apiFetch("/api/issues/"+encodeURIComponent(dbId)+"/steps/"+encodeURIComponent(step.id),{method:"PATCH",body:{done:!step.done}});
  await m26RefreshIssueSteps(id);render();
 }catch(e){toast(e.message||"Could not update the issue work step.")}
}
async function m26IssStepRemove(id,i){
 const t=S.issues.find(x=>x.id===id);if(!t)return;
 const steps=m26IssSteps(t),gone=steps.splice(i,1)[0];if(!gone)return;
 const dbId=m26IssueDbId(t);if(!dbId||!gone.id){toast("This issue step needs to be refreshed before removing it.");return}
 try{
  await apiFetch("/api/issues/"+encodeURIComponent(dbId)+"/steps/"+encodeURIComponent(gone.id),{method:"DELETE"});
  await m26RefreshIssueSteps(id);render();toast("Step removed.");
 }catch(e){toast(e.message||"Could not remove the issue work step.")}
}
function m26IssStepsHtml(t){
 const can=m26Head(),steps=m26IssSteps(t),id=m26Js(t.id),done=steps.filter(s=>s.done).length;
 if(!can&&!steps.length)return "";
 return '<div class="m26-steps"><div class="m26-steps-h"><b>Work steps</b><span>'+(steps.length?done+' of '+steps.length+' done':'none yet')+'</span></div>'
  +(steps.length?steps.map((s,i)=>'<div class="m26-step"><input type="checkbox" '+(s.done?'checked ':'')+(can?'':'disabled ')+'onchange="m26IssStepToggle('+id+','+i+')" aria-label="Mark step done"><span'+(s.done?' class="done"':'')+'>'+esc(s.t)+'</span>'+(can?'<button type="button" title="Remove this step" aria-label="Remove step" onclick="m26IssStepRemove('+id+','+i+')">✕</button>':'')+'</div>').join(""):'<div class="m26-steps-empty">No steps yet. Add the steps needed to fix this issue.</div>')
  +(can?'<div class="m26-step-add"><input id="m26-istep-new" class="inp" maxlength="160" placeholder="Add a step, e.g. Isolate the string and check fuses" onkeydown="if(event.key===\'Enter\')m26IssStepAdd('+id+')"><button type="button" class="btn p sm" onclick="m26IssStepAdd('+id+')">+ Add step</button></div>':'')+'</div>';
}
async function m26ResetIssue(id){
 const t=S.issues.find(x=>x.id===id);if(!t)return;
 if(!confirm("Reset "+id+" to Open? The owner, vendor hold and closure details are cleared. History and notes are kept."))return;
 const dbId=m26IssueDbId(t);if(!dbId){toast("This issue is not available from the server yet.");return}
 try{
  const row=await apiFetch("/api/issues/"+encodeURIComponent(dbId)+"/reset",{method:"POST"});
  if(window.applyIssueRow)window.applyIssueRow(row,t);
  render();toast("Ticket reset to Open.");
 }catch(e){toast(e.message||"Could not reset the issue.")}
}
function m26DecorateTicket(h,id){
 const t=S.issues.find(x=>x.id===id);if(!t)return h;
 if(!t._stepsLoaded&&!t._stepsLoading){
  t._stepsLoading=true;
  m26RefreshIssueSteps(id).then(loaded=>{const current=S.issues.find(x=>x.id===id);if(current)current._stepsLoading=false;if(loaded&&S.modal==="ticket"&&S.modalCtx&&S.modalCtx.id===id)render()});
 }
 const steps=m26IssStepsHtml(t);
 if(steps){const k=h.indexOf('<div style="font-size:12.5px;color:var(--muted-foreground);margin-bottom:10px">📎');if(k>=0)h=h.slice(0,k)+steps+h.slice(k)}
 if(m26Head()&&(t.status!=="Open"||t.assignee)){
  const k=h.lastIndexOf('<button class="btn o sm" onclick="closeModal()">Close</button>');
  if(k>=0)h=h.slice(0,k)+'<button class="btn sm o" style="color:#B3372B;border-color:#F3C9C4" onclick="m26ResetIssue('+m26Js(id)+')">Reset to Open</button>'+h.slice(k);
 }
 return h;
}

/* ---- modal hook ---- */
if(typeof renderModal==="function"){
 const m26OrigModal=renderModal;
 renderModal=function(){
  const m=S.modal,ctx=S.modalCtx||{};
  if(m==="m26EditTask")return m26EditTaskModal(ctx.id);
  let out;
  if(m==="complete"){
   const t=(S.tasks||[]).find(x=>x.id===ctx.id);
   if(t&&Array.isArray(t.steps)&&typeof TSUB!=="undefined"){
    const had=Object.prototype.hasOwnProperty.call(TSUB,t.type),old=TSUB[t.type];
    TSUB[t.type]=t.steps;
    try{out=m26OrigModal.apply(this,arguments)}finally{if(had)TSUB[t.type]=old;else delete TSUB[t.type]}
    return out;
   }
  }
  out=m26OrigModal.apply(this,arguments);
  try{
   if(m==="taskDetail")out=m26DecorateTask(out,ctx.id);
   else if(m==="ticket")out=m26DecorateTicket(out,ctx.id);
  }catch(e){}
  return out;
 };
}


/* ================================================================
   EQUIPMENT REGISTER v2
   Additive register upgrades: richer asset data, per-item in-charge,
   paged server reads, detail drawer, bulk/import/export and retirement.
   Existing type ownership and role scoping remain unchanged.
   ================================================================ */
const M26_EQ_CODES={"Inverter":["INV","Inverter"],"Module":["MOD","Module"],"Transformer":["TR","Transformer"],"Aux. Transformer":["ATR","Aux. Transformer"],"VCB Panel":["VCB","VCB Panel"],"VCB-Kiosk":["VCBK","VCB Kiosk"],"ACCB Panel":["ACCB","ACCB Panel"],"Switchyard - Plant side":["SYP","Switchyard - Plant side"],"Switchyard - GSS side":["SYG","Switchyard - GSS side"],"Transmission line":["TL","Transmission line"],"RMS":["RMS","RMS"],"WMS":["WMS","WMS"],"CCTV":["CCTV","CCTV"],"Boundary wall":["BW","Boundary wall"],"String":["STR","String"],"Earthing":["EP","Earthing"],"LA":["LA","Lightning arrester"],"Other":["EQ","Equipment"]};
function m26EqDefaults(t){return M26_EQ_CODES[t]||[String(t||"").replace(/[^A-Za-z]/g,"").slice(0,3).toUpperCase()||"EQ",t||"Equipment"]}
const M26_STATUS=[["active","Active"],["maintenance","Under maintenance"],["fault","Fault"],["inactive","Retired / inactive"]];
const M26_EQ_STORE="equipmentRegisterFilters";
function m26EqSaved(){try{return (typeof loadK==="function"?loadK(M26_EQ_STORE,{}):{})||{}}catch(e){return {}}}
const M26R=Object.assign({q:"",plant:"",type:"",status:"",maker:"",discom:"",inCharge:"",warranty:"",noInCharge:false,makerMissing:false,serialMissing:false,advanced:false,page:1,pageSize:50,items:null,total:0,loading:false,sel:null,busy:false,loaded:false,detail:null,detailTab:"overview",importFile:null,importPreview:null},m26EqSaved());
M26R.items=null;M26R.loading=false;M26R.busy=false;M26R.detail=null;M26R.importFile=null;M26R.importPreview=null;
function m26EqPersist(){try{if(typeof saveK==="function")saveK(M26_EQ_STORE,{q:M26R.q,plant:M26R.plant,type:M26R.type,status:M26R.status,maker:M26R.maker,discom:M26R.discom,inCharge:M26R.inCharge,warranty:M26R.warranty,noInCharge:!!M26R.noInCharge,makerMissing:!!M26R.makerMissing,serialMissing:!!M26R.serialMissing,advanced:!!M26R.advanced,page:M26R.page,pageSize:M26R.pageSize})}catch(e){}}
function m26EqCan(){return (typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role==="O&M Head")}
function m26EqPlantOf(e){return (S.plants||[]).find(p=>String(p.dbId)===String(e.plant_id))}
function m26EqStat(e){const x=String(e.status||"active").toLowerCase();return x==="active"?["Active","#16A34A","#E7F6EC"]:x==="maintenance"?["Maintenance","#92600E","#FDF3E3"]:x==="fault"?["Fault","#9B2C20","#FCEAE8"]:["Retired","#475569","#EEF1EF"]}
function m26EqOwners(e){if(Array.isArray(e.type_owners)&&e.type_owners.length)return e.type_owners.map(n=>({name:n}));const t=String(e.equipment_type||"Other").toLowerCase();return (TA.users||[]).filter(u=>u.active!==false&&u.role==="Assignee"&&(u.equipment_types||[]).some(x=>String(x).toLowerCase()===t))}
function m26EqOwnerNames(e){return m26EqOwners(e).map(u=>u.name).filter(Boolean)}
function m26EqInChargePeople(){const m=new Map();(TA.users||[]).filter(u=>u.active!==false).forEach(u=>m.set(String(u.id),u.name));(S.equipment||[]).forEach(e=>{if(e.in_charge_user_id&&e.in_charge_name)m.set(String(e.in_charge_user_id),e.in_charge_name)});return [...m].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name))}
function m26EqWarranty(e){if(!e.warranty_end)return ["Missing","#64748B","#F1F5F9"];const end=new Date(e.warranty_end+"T00:00:00"),now=new Date(),d=Math.ceil((end-now)/86400000);if(d<0)return ["Expired","#9B2C20","#FCEAE8"];if(d<90)return [d+"d left","#92600E","#FDF3E3"];return ["OK","#0C6B38","#E7F6EC"]}
function m26EqQuery(page){const q=new URLSearchParams();if(M26R.q)q.set("q",M26R.q);if(M26R.plant)q.set("plant_id",M26R.plant);if(M26R.type)q.set("equipment_type",M26R.type);if(M26R.status)q.set("status",M26R.status);if(M26R.maker)q.set("maker",M26R.maker);if(M26R.discom)q.set("discom",M26R.discom);if(M26R.inCharge)q.set("in_charge_user_id",M26R.inCharge);if(M26R.warranty)q.set("warranty",M26R.warranty);if(M26R.noInCharge)q.set("no_in_charge","true");if(M26R.makerMissing)q.set("maker_missing","true");if(M26R.serialMissing)q.set("serial_missing","true");q.set("offset",String((Math.max(1,page||M26R.page)-1)*M26R.pageSize));q.set("limit",String(M26R.pageSize));return q}
let m26EqLoadController=null;
async function m26EqLoadPage(reset){
 if(reset)M26R.page=1;
 if(m26EqLoadController)m26EqLoadController.abort();
 const controller=new AbortController();m26EqLoadController=controller;
 M26R.loading=true;m26EqPersist();if(S.view==="equipment")render();
 try{
  const data=await apiFetch("/api/equipment/page?"+m26EqQuery().toString(),{signal:controller.signal});
  if(controller.signal.aborted)return;
  M26R.items=data.items||[];M26R.total=Number(data.total||0);M26R.loading=false;m26EqPersist();if(S.view==="equipment")render();
 }catch(e){
  if(controller.signal.aborted)return;
  M26R.loading=false;toast("Equipment could not load — "+(e.message||"try again"));if(S.view==="equipment")render();
 }finally{
  if(m26EqLoadController===controller)m26EqLoadController=null;
 }
}
function m26GoEq(){S.view="equipment";S.omTab="equipment";S.modal=null;if(m26EqCan()&&!M26R.loaded&&typeof taLoad==="function"){M26R.loaded=true;taLoad(true)}render();m26EqLoadPage(false)}
function m26GoEqPlant(pid){M26R.plant=String(pid||"");M26R.page=1;m26EqPersist();m26GoEq()}
function m26EqFilter(k,v){M26R[k]=v;M26R.page=1;m26EqPersist();m26EqLoadPage(true)}
let m26EqSearchTimer=null;
function m26EqSearch(v){M26R.q=v;clearTimeout(m26EqSearchTimer);m26EqSearchTimer=setTimeout(()=>{M26R.page=1;m26EqPersist();m26EqLoadPage(true)},300)}
function m26EqReset(){Object.assign(M26R,{q:"",plant:"",type:"",status:"",maker:"",discom:"",inCharge:"",warranty:"",noInCharge:false,makerMissing:false,serialMissing:false,page:1});m26EqPersist();m26EqLoadPage(true)}
function m26EqPage(p){M26R.page=Math.max(1,p);m26EqPersist();m26EqLoadPage(false)}
function m26EqPageSize(v){M26R.pageSize=Math.max(10,Math.min(200,parseInt(v,10)||50));M26R.page=1;m26EqPersist();m26EqLoadPage(true)}
function m26Count(list,fn){const m={};list.forEach(x=>{const k=fn(x);m[k]=(m[k]||0)+1});return Object.entries(m).sort((a,b)=>b[1]-a[1])}
function m26Palette(i){return ["#16A34A","#3B82F6","#D97706","#6675D9","#0F9F8C","#DC4C3E","#94A3B8"][i%7]}
function m26Pie(entries,max){const top=entries.slice(0,max-1),rest=entries.slice(max-1).reduce((a,x)=>a+x[1],0);return top.map((x,i)=>({l:x[0],v:x[1],c:m26Palette(i)})).concat(rest?[{l:"Others",v:rest,c:"#CBD5D0"}]:[])}
function m26EqCompleteness(kind){M26R.page=1;M26R.noInCharge=false;M26R.makerMissing=false;M26R.serialMissing=false;M26R.warranty="";M26R.q="";if(kind==="maker")M26R.makerMissing=true;else if(kind==="incharge")M26R.noInCharge=true;else if(kind==="warranty")M26R.warranty="missing";else if(kind==="serial")M26R.serialMissing=true;m26EqPersist();m26EqLoadPage(true)}
function m26EqPager(){const pages=Math.max(1,Math.ceil(M26R.total/M26R.pageSize));if(M26R.page>pages)M26R.page=pages;return '<div class="table-pager"><span>Showing '+(M26R.total?((M26R.page-1)*M26R.pageSize+1):0)+'–'+Math.min(M26R.page*M26R.pageSize,M26R.total)+' of '+M26R.total+'</span><div class="row" style="gap:5px"><select class="inp" style="width:auto" onchange="m26EqPageSize(this.value)"><option'+(M26R.pageSize===25?' selected':'')+'>25</option><option'+(M26R.pageSize===50?' selected':'')+'>50</option><option'+(M26R.pageSize===100?' selected':'')+'>100</option></select><button class="btn o sm" '+(M26R.page<=1?'disabled':'')+' onclick="m26EqPage('+(M26R.page-1)+')">Previous</button><span class="pager-page">Page '+M26R.page+' / '+pages+'</span><button class="btn o sm" '+(M26R.page>=pages?'disabled':'')+' onclick="m26EqPage('+(M26R.page+1)+')">Next</button></div></div>'}
function m26EqPrimaryOwner(e){return e.in_charge_name?'<b>'+esc(e.in_charge_name)+'</b><div class="m26-owner-note">Per-item in charge</div>':(m26EqOwnerNames(e).length?'<span>'+esc(m26EqOwnerNames(e).join(", "))+'</span><div class="m26-owner-note">Type owner fallback</div>':'<span class="oi-unassigned">No in-charge</span>')}

function renderEquipmentRegister(){
 const all=S.equipment||[],rows=M26R.items===null?all:(M26R.items||[]),can=m26EqCan(),plants=S.plants||[];
 const act=all.filter(e=>String(e.status||"active")==="active").length,warn=all.filter(e=>e.status==="maintenance").length,bad=all.filter(e=>e.status==="fault").length,off=all.filter(e=>e.status==="inactive").length;
 const types=[...new Set(all.map(e=>e.equipment_type||"Other").concat(["Modules cleaning"]))].sort(),makers=[...new Set(all.map(e=>e.maker).filter(Boolean))].sort(),discoms=[...new Set(all.map(e=>e.discom||(m26EqPlantOf(e)||{}).discom).filter(Boolean))].sort(),people=m26EqInChargePeople();
 const missing={maker:all.filter(e=>!e.maker).length,serial:all.filter(e=>!e.serial_number).length,incharge:all.filter(e=>!e.in_charge_user_id).length,warranty:all.filter(e=>!e.warranty_start||!e.warranty_end).length};
 const owned=can?types.filter(t=>(TA.users||[]).some(u=>u.role==="Assignee"&&u.active!==false&&(u.equipment_types||[]).some(x=>String(x).toLowerCase()===t.toLowerCase()))).length:null;
 let h='<div class="m26 m26-eqreg"><div class="oi-header" style="display:flex;align-items:flex-end;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><div style="font-size:12.5px;letter-spacing:.08em;color:#0c5e2a;font-weight:700">ASSET REGISTER</div><h1>Equipment register</h1><p style="color:var(--muted-foreground);font-size:13px;margin:4px 0 0">Asset identity, ownership, warranty and service history. Type-based access stays unchanged.</p></div>'+
  (can?'<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn o" onclick="m26EqImportOpen()">Import Excel / CSV</button><button class="btn o" onclick="m26EqExport()">Export Excel</button><button class="btn o" onclick="m26EqOpen(\'bulk\')">+ Add many</button><button class="btn p" onclick="m26EqOpen(\'add\')">+ Add equipment</button></div>':'<button class="btn o" onclick="m26EqExport()">Export Excel</button>')+'</div>';
 h+='<div class="m26-dnrow" style="margin-top:14px">'+m26Donut("Status","all registered equipment",[{l:"Active",v:act,c:"#16A34A"},{l:"Maintenance",v:warn,c:"#D97706"},{l:"Fault",v:bad,c:"#DC4C3E"},{l:"Retired",v:off,c:"#94A3B8"}],all.length,"items")+m26Donut("By type","top equipment types",m26Pie(m26Count(all,e=>e.equipment_type||"Other"),6),types.length,"types")+m26Donut("By plant","where it is installed",m26Pie(m26Count(all,e=>{const p=m26EqPlantOf(e);return p?p.id:"Unknown"}),6),new Set(all.map(e=>e.plant_id)).size,"plants")+m26Donut("Details filled in","maker recorded",[{l:"Maker known",v:all.length-missing.maker,c:"#16A34A"},{l:"Maker missing",v:missing.maker,c:"#DC4C3E"}],all.length?Math.round((all.length-missing.maker)/all.length*100)+"%":"—","complete")+'</div>';
 h+='<div class="panel m26-completeness"><div><b>Data completeness</b><span>Fix the records most likely to block service and warranty follow-up.</span></div><div class="m26-complete-actions"><button class="btn g sm" onclick="m26EqCompleteness(\'maker\')">Maker missing · '+missing.maker+'</button><button class="btn g sm" onclick="m26EqCompleteness(\'serial\')">Serial missing · '+missing.serial+'</button><button class="btn g sm" onclick="m26EqCompleteness(\'incharge\')">No in-charge · '+missing.incharge+'</button><button class="btn g sm" onclick="m26EqCompleteness(\'warranty\')">Warranty dates missing · '+missing.warranty+'</button></div></div>';
 if(can&&types.length)h+='<div class="m26-own"><div class="m26-own-h"><b>Who owns what</b><span>'+owned+' of '+types.length+' equipment types have an assigned person</span></div><div class="m26-own-grid">'+types.map(t=>{const own=m26EqOwners({equipment_type:t}),n=all.filter(e=>(e.equipment_type||"Other")===t).length;return '<div class="m26-own-c'+(own.length?'':' none')+'"><div class="t"><b>'+esc(t==="Modules cleaning"?"Washing (Modules cleaning)":t)+'</b><span>'+n+'</span></div><div class="o">'+(own.length?own.map(u=>'<span class="av" title="'+esc(u.name)+'">'+esc(ccIni(u.name))+'</span>').join("")+'<em>'+esc(own.map(u=>u.name.split(" ")[0]).join(", "))+'</em>':'<em>No one assigned</em>')+'</div><a onclick="m26EqAssignType('+m26Js(t)+')">'+(own.length?'Change':'+ Assign')+'</a></div>'}).join("")+'</div></div>';
 const advCount=[M26R.maker,M26R.discom,M26R.inCharge,M26R.warranty,M26R.noInCharge,M26R.makerMissing].filter(Boolean).length;
 h+='<div class="panel oi-filter-panel" style="margin-top:14px;padding:12px 14px"><div class="row wrap" style="gap:8px;align-items:center"><input class="inp" style="max-width:280px" placeholder="Search code, name, maker, model, serial…" value="'+esc(M26R.q)+'" oninput="m26EqSearch(this.value)" id="m26-eqq"><select class="inp" style="width:auto" onchange="m26EqFilter(\'plant\',this.value)"><option value="">All plants</option>'+plants.map(p=>'<option value="'+esc(p.dbId)+'"'+(M26R.plant===String(p.dbId)?' selected':'')+'>'+esc(p.id+' · '+p.name)+'</option>').join("")+'</select><select class="inp" style="width:auto" onchange="m26EqFilter(\'type\',this.value)"><option value="">All types</option>'+types.map(t=>'<option'+(M26R.type===t?' selected':'')+'>'+esc(t)+'</option>').join("")+'</select><select class="inp" style="width:auto" onchange="m26EqFilter(\'status\',this.value)"><option value="">All statuses</option>'+M26_STATUS.map(s=>'<option value="'+s[0]+'"'+(M26R.status===s[0]?' selected':'')+'>'+s[1]+'</option>').join("")+'</select><button class="btn o sm" onclick="M26R.advanced=!M26R.advanced;m26EqPersist();render()">'+(M26R.advanced?'Hide advanced':'Advanced filters')+(advCount?' ('+advCount+')':'')+'</button><button class="btn g sm" onclick="m26EqReset()">Reset</button><span style="margin-left:auto;font-size:12px;color:var(--muted-foreground)">'+(M26R.loading?'Loading…':M26R.total+' items')+'</span></div>';
 if(M26R.advanced)h+='<div class="row wrap m26-advanced" style="gap:8px;margin-top:10px"><select class="inp" style="width:auto" onchange="m26EqFilter(\'maker\',this.value)"><option value="">All makers</option>'+makers.map(t=>'<option'+(M26R.maker===t?' selected':'')+'>'+esc(t)+'</option>').join("")+'</select><select class="inp" style="width:auto" onchange="m26EqFilter(\'discom\',this.value)"><option value="">All DISCOMs</option>'+discoms.map(t=>'<option'+(M26R.discom===t?' selected':'')+'>'+esc(t)+'</option>').join("")+'</select><select class="inp" style="width:auto" onchange="m26EqFilter(\'inCharge\',this.value)"><option value="">Any in-charge</option>'+people.map(u=>'<option value="'+esc(u.id)+'"'+(M26R.inCharge===u.id?' selected':'')+'>'+esc(u.name)+'</option>').join("")+'</select><select class="inp" style="width:auto" onchange="m26EqFilter(\'warranty\',this.value)"><option value="">Any warranty</option><option value="expiring"'+(M26R.warranty==='expiring'?' selected':'')+'>Expiring &lt;90 days</option><option value="expired"'+(M26R.warranty==='expired'?' selected':'')+'>Expired</option><option value="missing"'+(M26R.warranty==='missing'?' selected':'')+'>Missing</option></select><label class="m26-check"><input type="checkbox" '+(M26R.noInCharge?'checked':'')+' onchange="m26EqFilter(\'noInCharge\',this.checked)"> No in-charge</label><label class="m26-check"><input type="checkbox" '+(M26R.makerMissing?'checked':'')+' onchange="m26EqFilter(\'makerMissing\',this.checked)"> Maker missing</label></div>';
 h+='</div>';
 h+='<div class="panel" style="margin-top:14px;padding:0"><div class="m26-table-wrap"><table class="dense m26-eq-table" style="width:100%"><thead><tr><th>Equipment</th><th>Type</th><th>DISCOM</th><th>Maker · Model</th><th>Serial no.</th><th>Plant</th><th>Status</th><th>In charge</th><th>Type owners</th><th>Warranty</th><th>Next service</th><th></th></tr></thead><tbody>';
 if(M26R.loading&&!rows.length)h+=Array.from({length:6},()=>'<tr class="m26-skeleton-row"><td colspan="12"><span></span></td></tr>').join("");
 else if(!rows.length)h+='<tr><td colspan="12" style="text-align:center;padding:30px;color:var(--muted-foreground)">'+(all.length?'No equipment matches these filters.':'No equipment registered yet.'+(can?' Use <b>+ Add equipment</b> to register the first item.':''))+'</td></tr>';
 rows.forEach(e=>{const p=m26EqPlantOf(e),st=m26EqStat(e),owners=m26EqOwnerNames(e),w=m26EqWarranty(e),id=m26Js(e.id);h+='<tr class="oi-issue-row m26-eq-row" onclick="m26EqDetail('+id+')"><td><b>'+esc(e.equipment_code||e.equipment_name)+'</b>'+(e.equipment_code?'<div style="font-size:12.5px;color:var(--muted-foreground)">'+esc(e.equipment_name)+'</div>':'')+'</td><td>'+esc(e.equipment_type||"Other")+'</td><td>'+esc(e.discom||(p&&p.discom)||"—")+'</td><td>'+(e.maker?esc(e.maker):'<span class="oi-unassigned">Maker missing</span>')+(e.model?'<div style="font-size:12.5px;color:var(--muted-foreground)">'+esc(e.model)+'</div>':'')+'</td><td>'+esc(e.serial_number||"—")+'</td><td>'+(p?esc(p.id)+'<div style="font-size:12.5px;color:var(--muted-foreground)">'+esc(p.name)+'</div>':'—')+'</td><td><span class="m26-badge" style="background:'+st[2]+';color:'+st[1]+'">'+st[0]+'</span></td><td>'+m26EqPrimaryOwner(e)+'</td><td>'+(owners.length?esc(owners.join(", ")):'<span class="oi-unassigned">None</span>')+'</td><td><span class="m26-badge" style="background:'+w[2]+';color:'+w[1]+'">'+w[0]+'</span></td><td>'+esc(e.next_service_due||"—")+'</td><td onclick="event.stopPropagation()">'+(can?'<details class="m26-rowmenu"><summary aria-label="Equipment actions">…</summary><div><button onclick="m26EqOpen(\'edit\','+id+')">Edit</button><button onclick="m26EqMoveOpen('+id+')">Move plant</button><button onclick="m26EqRetire('+id+')">Retire</button><button class="danger" onclick="m26EqRemove('+id+')">Delete permanently</button></div></details>':'<button class="btn g sm" onclick="m26EqDetail('+id+')">View</button>')+'</td></tr>'});
 h+='</tbody></table></div>'+m26EqPager()+'</div></div>';return h;
}

function m26EqOpen(mode,id){S.modal="m26Eq";S.modalCtx={mode,id};if(m26EqCan()&&typeof taLoad==="function"&&!M26R.loaded){M26R.loaded=true;taLoad(true)}render()}
function m26EqField(l,k,v,x){return '<div class="field"><span class="lbl">'+l+'</span><input id="m26eq-'+k+'" class="inp" value="'+esc(v==null?"":v)+'" '+(x||"")+'/></div>'}
function m26EqForm(mode,id){
 const e=mode==="edit"?(S.equipment||[]).find(x=>x.id===id)||((M26R.items||[]).find(x=>x.id===id)):null,plants=S.plants||[],tdef=m26EqDefaults(e?e.equipment_type:"Inverter"),people=m26EqInChargePeople();
 const typeSel='<div class="field"><span class="lbl">Equipment type *</span><select id="m26eq-type" class="inp" onchange="m26EqTypePick(this.value)">'+(typeof VERTICALS!=="undefined"?VERTICALS:[]).map(t=>'<option'+((e?e.equipment_type:"Inverter")===t?' selected':'')+'>'+esc(t)+'</option>').join("")+'</select></div>';
 const plantSel='<div class="field"><span class="lbl">Plant *</span><select id="m26eq-plant" class="inp">'+plants.map(p=>'<option value="'+esc(p.dbId)+'"'+(e&&String(e.plant_id)===String(p.dbId)?' selected':'')+'>'+esc(p.id+' · '+p.name)+'</option>').join("")+'</select></div>';
 const stat='<div class="field"><span class="lbl">Status</span><select id="m26eq-status" class="inp">'+M26_STATUS.map(s=>'<option value="'+s[0]+'"'+((e?String(e.status||"active").toLowerCase():"active")===s[0]?' selected':'')+'>'+s[1]+'</option>').join("")+'</select></div>';
 const incharge='<div class="field"><span class="lbl">Person in charge</span><select id="m26eq-incharge" class="inp"><option value="">Use type owner</option>'+people.map(u=>'<option value="'+esc(u.id)+'"'+(e&&String(e.in_charge_user_id||"")===String(u.id)?' selected':'')+'>'+esc(u.name)+'</option>').join("")+'</select></div>';
 let b='<div class="bn-info banner" style="margin-bottom:12px">'+(mode==="bulk"?'Creates all numbered items in one transaction. If any code conflicts, nothing is created.':'Per-item in-charge overrides the type owner for display and notifications; type ownership still controls Assignee visibility.')+'</div>'+plantSel+typeSel+m26EqField(mode==="bulk"?"Name prefix *":"Name *","name",e?e.equipment_name:tdef[1])+m26EqField(mode==="bulk"?"Code prefix":"Code / tag","code",e?e.equipment_code:tdef[0])+'<div class="m26-form-grid">'+m26EqField(mode==="edit"?"Maker":"Maker *","maker",e?e.maker:"",'placeholder="Required, e.g. Sungrow, Huawei, ABB"')+m26EqField("Model","model",e?e.model:"")+m26EqField("Serial number","serial",e?e.serial_number:"")+(mode==="bulk"?m26EqField("How many *","count",5,'type="number" min="1" max="500"'):'')+(mode==="bulk"?m26EqField("Start number","start",1,'type="number" min="0"'):'')+m26EqField("DISCOM","discom",e?e.discom:"")+m26EqField("Feeder / GSS","feeder",e?e.feeder_or_gss:"")+m26EqField("Rating","rating",e?e.rating:"")+m26EqField("Capacity (kW)","capacity",e?e.capacity_kw:"",'type="number" step="0.001" inputmode="decimal"')+m26EqField("Quantity","quantity",e?e.quantity||1:'1','type="number" min="1" inputmode="numeric"')+m26EqField("Location in plant","location",e?e.location_in_plant:"")+m26EqField("Manufacture year","year",e?e.manufacture_year:"",'type="number" min="1900" max="2200" inputmode="numeric"')+m26EqField("Commissioned on","commissioned",e?e.commissioned_on:"",'type="date"')+m26EqField("Warranty start","wstart",e?e.warranty_start:"",'type="date"')+m26EqField("Warranty end","wend",e?e.warranty_end:"",'type="date"')+m26EqField("AMC vendor","amcvendor",e?e.amc_vendor:"")+m26EqField("AMC end","amcend",e?e.amc_end:"",'type="date"')+m26EqField("Supplier","supplier",e?e.supplier:"")+m26EqField("Purchase order no.","po",e?e.purchase_order_no:"")+m26EqField("Last service","lastservice",e?e.last_service_on:"",'type="date"')+m26EqField("Next service due","nextservice",e?e.next_service_due:"",'type="date"')+'</div>'+incharge+'<div class="field"><span class="lbl">Criticality</span><select id="m26eq-criticality" class="inp"><option value="">Not set</option>'+["High","Medium","Low"].map(v=>'<option'+(e&&e.criticality===v?' selected':'')+'>'+v+'</option>').join("")+'</select></div>'+stat+'<div class="field"><span class="lbl">Notes</span><textarea id="m26eq-notes" class="inp" rows="3">'+esc(e&&e.notes||"")+'</textarea></div>';
 const title=mode==="bulk"?"Add many equipment items":mode==="edit"?"Edit equipment":"Add equipment";return modal(title,mode==="edit"?esc(e&&(e.equipment_code||e.equipment_name)||""):"Equipment register",b,'<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" id="m26eq-save" onclick="m26EqSave('+m26Js(mode)+','+m26Js(id||"")+')">'+(mode==="edit"?"Save changes":mode==="bulk"?"Add items":"Add equipment")+'</button>',true);
}
function m26EqTypePick(t){const d=m26EqDefaults(t),n=document.getElementById("m26eq-name"),c=document.getElementById("m26eq-code");if(n&&(!n.value||Object.values(M26_EQ_CODES).some(x=>x[1]===n.value)))n.value=d[1];if(c&&(!c.value||Object.values(M26_EQ_CODES).some(x=>x[0]===c.value)))c.value=d[0]}
function m26EqPayload(){const g=k=>{const e=document.getElementById("m26eq-"+k);return e?String(e.value).trim():""};return {g,base:{plant_id:g("plant"),equipment_code:g("code")||null,equipment_name:g("name"),equipment_type:g("type")||null,maker:g("maker")||null,model:g("model")||null,serial_number:g("serial")||null,status:g("status")||"active",discom:g("discom")||null,feeder_or_gss:g("feeder")||null,rating:g("rating")||null,capacity_kw:g("capacity")?Number(g("capacity")):null,quantity:Math.max(1,parseInt(g("quantity"),10)||1),location_in_plant:g("location")||null,manufacture_year:g("year")?parseInt(g("year"),10):null,commissioned_on:g("commissioned")||null,warranty_start:g("wstart")||null,warranty_end:g("wend")||null,amc_vendor:g("amcvendor")||null,amc_end:g("amcend")||null,supplier:g("supplier")||null,purchase_order_no:g("po")||null,criticality:g("criticality")||null,notes:g("notes")||null,in_charge_user_id:g("incharge")||null,last_service_on:g("lastservice")||null,next_service_due:g("nextservice")||null}}}
async function m26EqSave(mode,id){const x=m26EqPayload(),g=x.g,base=x.base;if(!base.plant_id){toast("Choose the plant.");return}if(!base.equipment_name){toast("Enter a name.");return}if(mode!=="edit"&&!String(base.maker||"").trim()){toast("Enter the maker (manufacturer) of this equipment.");const mk=document.getElementById("m26eq-maker");if(mk)mk.focus();return}if(M26R.busy)return;M26R.busy=true;const btn=document.getElementById("m26eq-save");if(btn){btn.disabled=true;btn.textContent="Saving…"}try{if(mode==="edit"){const r=await apiFetch("/api/equipment/"+encodeURIComponent(id),{method:"PATCH",body:base});S.equipment=(S.equipment||[]).map(v=>v.id===id?Object.assign({},v,r):v);toast("Equipment updated.")}else if(mode==="bulk"){const n=Math.max(1,Math.min(500,parseInt(g("count"),10)||1)),st=Math.max(0,parseInt(g("start"),10)||1),prefix=base.equipment_code,name=base.equipment_name;const items=[];for(let i=0;i<n;i++){const num=String(st+i).padStart(2,"0");items.push(Object.assign({},base,{equipment_code:prefix?prefix+"-"+num:null,equipment_name:name+" "+num,serial_number:null}))}const made=await apiFetch("/api/equipment/bulk",{method:"POST",body:{items}});S.equipment=(S.equipment||[]).concat(made||[]);toast((made||[]).length+" equipment items added.")}else{const r=await apiFetch("/api/equipment",{method:"POST",body:base});S.equipment=(S.equipment||[]).concat([r]);toast("Equipment added.")}M26R.busy=false;closeModal();await m26EqLoadPage(false)}catch(e){M26R.busy=false;if(btn){btn.disabled=false;btn.textContent="Try again"}toast("Not saved — "+(e.message||"error"))}}
function m26EqMoveOpen(id){const e=(S.equipment||[]).find(x=>x.id===id)||((M26R.items||[]).find(x=>x.id===id));if(!e)return;S.modal="m26EqMove";S.modalCtx={id};render()}
function m26EqMoveModal(id){const e=(S.equipment||[]).find(x=>x.id===id)||((M26R.items||[]).find(x=>x.id===id));const b='<div class="banner bn-info">Move keeps the same equipment record, linked maintenance/issues and assignment history.</div><div class="field"><span class="lbl">Destination plant</span><select id="m26eq-move-plant" class="inp">'+(S.plants||[]).filter(p=>String(p.dbId)!==String(e&&e.plant_id)).map(p=>'<option value="'+esc(p.dbId)+'">'+esc(p.id+' · '+p.name)+'</option>').join("")+'</select></div>';return modal("Move equipment",esc(e&&(e.equipment_code||e.equipment_name)||""),b,'<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="m26EqMoveGo('+m26Js(id)+')">Move</button>',false)}
async function m26EqMoveGo(id){const el=document.getElementById("m26eq-move-plant"),plant_id=el&&el.value;if(!plant_id)return;try{const r=await apiFetch("/api/equipment/"+encodeURIComponent(id)+"/move",{method:"POST",body:{plant_id}});S.equipment=(S.equipment||[]).map(x=>x.id===id?Object.assign({},x,r):x);closeModal();toast("Equipment moved. History retained.");m26EqLoadPage(false)}catch(e){toast("Move failed — "+(e.message||"error"))}}
async function m26EqRetire(id){const e=(S.equipment||[]).find(x=>x.id===id)||((M26R.items||[]).find(x=>x.id===id));if(!e||!confirm("Retire "+(e.equipment_code||e.equipment_name)+"? The record and linked history stay available."))return;try{const r=await apiFetch("/api/equipment/"+encodeURIComponent(id)+"/retire",{method:"POST"});S.equipment=(S.equipment||[]).map(x=>x.id===id?Object.assign({},x,r):x);toast("Equipment retired.");m26EqLoadPage(false)}catch(err){toast("Not retired — "+(err.message||"error"))}}
async function m26EqRemove(id){const e=(S.equipment||[]).find(x=>x.id===id)||((M26R.items||[]).find(x=>x.id===id));if(!e)return;const answer=prompt('Permanent delete cannot be undone. Type DELETE to permanently delete '+(e.equipment_code||e.equipment_name)+'.');if(answer!=="DELETE"){if(answer!==null)toast("Permanent delete cancelled.");return}try{await apiFetch("/api/equipment/"+encodeURIComponent(id),{method:"DELETE"});S.equipment=(S.equipment||[]).filter(x=>x.id!==id);toast("Equipment permanently deleted.");m26EqLoadPage(false)}catch(err){toast("Not deleted — "+(err.message||"error"))}}

function m26EqAssignType(t){S.modal="m26EqAssign";S.modalCtx={type:t};if(!TA.users&&typeof taLoad==="function")taLoad(true);render()}
function m26EqAssignModal(t){const own=m26EqOwners({equipment_type:t}),n=(S.equipment||[]).filter(e=>(e.equipment_type||"Other")===t).length,cands=(TA.users||[]).filter(u=>u.active!==false&&u.role==="Assignee"&&!own.some(o=>o.id===u.id));const b='<div class="bn-info banner" style="margin-bottom:12px">Equipment visibility remains assigned <b>by type</b>. Per-item in-charge affects responsibility display and notifications, not Assignee scope.</div><div class="lbl" style="margin-bottom:6px">Currently assigned</div>'+(own.length?own.map(u=>'<div class="m26-step"><span class="av">'+esc(ccIni(u.name))+'</span><span>'+esc(u.name)+'</span><button type="button" onclick="m26EqUnassign('+m26Js(u.id)+','+m26Js(t)+')">Remove</button></div>').join(""):'<div class="m26-steps-empty">No one is assigned to this type yet.</div>')+'<div class="lbl" style="margin:14px 0 6px">Assign to</div>'+(cands.length?'<div class="m26-step-add"><select id="m26eq-who" class="inp">'+cands.map(u=>'<option value="'+esc(u.id)+'">'+esc(u.name+' — '+u.email)+'</option>').join("")+'</select><button class="btn p sm" onclick="m26EqAssignGo('+m26Js(t)+')">Assign</button></div>':'<div class="m26-steps-empty">Every Assignee already has this type.</div>');return modal("Assign "+esc(t),n+' registered items',b,'<button class="btn o" onclick="closeModal()">Done</button>',false)}
async function m26EqAccess(uid,types){const u=(TA.users||[]).find(x=>x.id===uid);if(!u)throw new Error("Person not found");await apiFetch("/api/users/"+encodeURIComponent(uid)+"/access",{method:"PUT",body:{role:"Assignee",plant_ids:[],equipment_ids:[],equipment_types:types}});await taLoad(true)}
async function m26EqAssignGo(t){const uid=(document.getElementById("m26eq-who")||{}).value,u=(TA.users||[]).find(x=>x.id===uid);if(!u)return;try{await m26EqAccess(uid,[...new Set((u.equipment_types||[]).concat([t]))]);toast(u.name+" now owns all "+t+" equipment.");render()}catch(e){toast("Not saved — "+(e.message||"error"))}}
async function m26EqUnassign(uid,t){const u=(TA.users||[]).find(x=>x.id===uid);if(!u||!confirm("Remove "+t+" from "+u.name+"? They will no longer see this equipment type."))return;try{await m26EqAccess(uid,(u.equipment_types||[]).filter(x=>String(x).toLowerCase()!==String(t).toLowerCase()));toast(t+" removed from "+u.name+".");render()}catch(e){toast("Not saved — "+(e.message||"error"))}}

async function m26EqDetail(id,tab){M26R.detailTab=tab||M26R.detailTab||"overview";S.modal="m26EqDetail";S.modalCtx={id};if(!M26R.detail||M26R.detail.id!==id){M26R.detail={id,loading:true};render();try{const data=await apiFetch("/api/equipment/"+encodeURIComponent(id)+"/detail");M26R.detail={id,loading:false,data};render()}catch(e){M26R.detail={id,loading:false,error:e.message};render()}}else render()}
function m26EqDetailTab(t){M26R.detailTab=t;render()}
function m26EqKV(label,value){return '<div class="m26-kv"><span>'+label+'</span><b>'+esc(value==null||value===""?'—':String(value))+'</b></div>'}
function m26EqDetailModal(id){const d=M26R.detail&&M26R.detail.id===id?M26R.detail:null;if(!d||d.loading)return '<div class="m26-drawer"><div class="m26-drawer-head"><b>Equipment details</b><button class="btn g sm" onclick="closeModal()">Close</button></div><div class="m26-drawer-body"><div class="m26-loading">Loading equipment history…</div></div></div>';if(d.error)return '<div class="m26-drawer"><div class="m26-drawer-head"><b>Equipment details</b><button class="btn g sm" onclick="closeModal()">Close</button></div><div class="m26-drawer-body"><div class="banner bn-danger">'+esc(d.error)+'</div></div></div>';const x=d.data,e=x.equipment,w=m26EqWarranty(e),tab=M26R.detailTab||"overview",owners=e.type_owners||[];let body='';if(tab==="overview")body='<div class="m26-detail-grid">'+[m26EqKV("Code",e.equipment_code),m26EqKV("Name",e.equipment_name),m26EqKV("Type",e.equipment_type),m26EqKV("DISCOM",e.discom),m26EqKV("Feeder / GSS",e.feeder_or_gss),m26EqKV("Maker",e.maker),m26EqKV("Model",e.model),m26EqKV("Serial",e.serial_number),m26EqKV("Rating",e.rating),m26EqKV("Capacity kW",e.capacity_kw),m26EqKV("Quantity",e.quantity),m26EqKV("Location",e.location_in_plant),m26EqKV("Manufacture year",e.manufacture_year),m26EqKV("Commissioned",e.commissioned_on),m26EqKV("Person in charge",e.in_charge_name||"Not assigned"),m26EqKV("Type owners",owners.join(", ")||"None"),m26EqKV("Warranty start",e.warranty_start),m26EqKV("Warranty end",e.warranty_end),m26EqKV("AMC vendor",e.amc_vendor),m26EqKV("AMC end",e.amc_end),m26EqKV("Supplier",e.supplier),m26EqKV("PO no.",e.purchase_order_no),m26EqKV("Criticality",e.criticality),m26EqKV("Last service",e.last_service_on),m26EqKV("Next service",e.next_service_due)].join("")+'</div><div style="margin-top:12px"><span class="m26-badge" style="background:'+w[2]+';color:'+w[1]+'">Warranty · '+w[0]+'</span></div><div class="panel" style="margin-top:12px"><b>Notes</b><p>'+esc(e.notes||"No notes recorded.")+'</p></div>';else if(tab==="history")body=(x.assignment_history||[]).length?'<div class="m26-timeline">'+x.assignment_history.map(a=>'<div><b>'+esc(a.action)+'</b><span>'+esc((a.at||"").replace("T"," ").slice(0,16))+' · '+esc(a.by||"System")+'</span></div>').join("")+'</div>':'<div class="m26-empty">No plant moves or in-charge changes yet.</div>';else if(tab==="maintenance")body=(x.maintenance||[]).length?'<table class="dense"><thead><tr><th>Task</th><th>Status</th><th>Due</th></tr></thead><tbody>'+x.maintenance.map(t=>'<tr><td><b>'+esc(t.id)+'</b><div>'+esc(t.name)+'</div></td><td>'+esc(t.status)+'</td><td>'+esc(t.due_on||"—")+'</td></tr>').join("")+'</tbody></table>':'<div class="m26-empty">No linked Preventive Maintenance tasks.</div>';else if(tab==="issues")body='<div class="m26-metrics"><b>'+Number((x.issue_metrics||{}).open_count||0)+'</b><span>open issues</span><b>'+((x.issue_metrics||{}).mttr_hours==null?'—':x.issue_metrics.mttr_hours+' h')+'</b><span>MTTR</span><b>'+((x.issue_metrics||{}).mtbf_hours==null?'—':x.issue_metrics.mtbf_hours+' h')+'</b><span>MTBF</span></div>'+((x.issues||[]).length?'<table class="dense"><thead><tr><th>Ticket</th><th>Severity</th><th>Status</th></tr></thead><tbody>'+x.issues.map(i=>'<tr><td>'+esc(i.ticket_no)+'</td><td>'+esc(i.severity)+'</td><td>'+esc(i.status)+'</td></tr>').join("")+'</tbody></table>':'<div class="m26-empty">No linked Site Issues.</div>');else if(tab==="documents")body=(m26EqCan()?'<div class="panel"><div class="row wrap" style="gap:8px"><select id="m26eq-doc-kind" class="inp" style="width:auto"><option value="datasheet">Datasheet</option><option value="warranty_certificate">Warranty certificate</option><option value="test_report">Test report</option></select><input id="m26eq-doc-file" class="inp" type="file" accept=".pdf,.xlsx,image/jpeg,image/png,image/webp"><button class="btn p sm" onclick="m26EqUploadDoc('+m26Js(id)+')">Upload</button></div></div>':'')+((x.documents||[]).length?'<div class="m26-docs">'+x.documents.map(doc=>'<div><span><b>'+esc(doc.name)+'</b><em>'+esc(doc.kind.replaceAll("_"," "))+' · '+Math.round((doc.size||0)/1024)+' KB</em></span><button class="btn o sm" onclick="m26EqDownloadDoc('+m26Js(id)+','+m26Js(doc.id)+','+m26Js(doc.name)+')">Open</button>'+(m26EqCan()?'<button class="btn g sm" onclick="m26EqDeleteDoc('+m26Js(id)+','+m26Js(doc.id)+')">Remove</button>':'')+'</div>').join("")+'</div>':'<div class="m26-empty">No documents uploaded.</div>');return '<div class="m26-drawer"><div class="m26-drawer-head"><div><span>Equipment register</span><b>'+esc(e.equipment_code||e.equipment_name)+'</b></div><button class="btn g sm" onclick="closeModal()">Close</button></div><div class="m26-drawer-tabs">'+[["overview","Overview"],["history","Assignment history"],["maintenance","Maintenance"],["issues","Issues"],["documents","Documents"]].map(t=>'<button class="'+(tab===t[0]?'active':'')+'" onclick="m26EqDetailTab('+m26Js(t[0])+')">'+t[1]+'</button>').join("")+'</div><div class="m26-drawer-body">'+body+'</div></div>'}
async function m26EqUploadDoc(id){const f=document.getElementById("m26eq-doc-file"),kind=(document.getElementById("m26eq-doc-kind")||{}).value;if(!f||!f.files||!f.files[0]){toast("Choose a document first.");return}const fd=new FormData();fd.append("kind",kind);fd.append("file",f.files[0]);try{await apiFetch("/api/equipment/"+encodeURIComponent(id)+"/documents",{method:"POST",body:fd});M26R.detail=null;toast("Document uploaded.");m26EqDetail(id,"documents")}catch(e){toast("Upload failed — "+(e.message||"error"))}}
async function m26RawFetch(url,opts){const r=await authenticatedFetch(url,opts);if(!r.ok){let j=null;try{j=await r.json()}catch(e){}throw new Error(typeof s91ApiErrorMessage==="function"?s91ApiErrorMessage(r.status,j):"HTTP "+r.status)}return r}
async function m26EqDownloadDoc(id,docId,name){try{const r=await m26RawFetch("/api/equipment/"+encodeURIComponent(id)+"/documents/"+encodeURIComponent(docId));const b=await r.blob(),u=URL.createObjectURL(b),a=document.createElement("a");a.href=u;a.download=name||"equipment-document";a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}catch(e){toast("Document could not open — "+e.message)}}
async function m26EqDeleteDoc(id,docId){if(!confirm("Remove this document? The equipment record stays unchanged."))return;try{await apiFetch("/api/equipment/"+encodeURIComponent(id)+"/documents/"+encodeURIComponent(docId),{method:"DELETE"});M26R.detail=null;toast("Document removed.");m26EqDetail(id,"documents")}catch(e){toast("Not removed — "+e.message)}}

function m26EqImportOpen(){M26R.importFile=null;M26R.importPreview=null;S.modal="m26EqImport";render()}
function m26EqImportModal(){const p=M26R.importPreview;let b='<div class="banner bn-info">Download the template, fill it, then preview validation before committing. Import is atomic: a duplicate code stops the whole batch.</div><div class="row wrap" style="gap:8px;margin:12px 0"><button class="btn o sm" onclick="m26EqTemplate()">Download template</button><input class="inp" type="file" accept=".xlsx,.csv" onchange="m26EqImportPick(this)"></div>';if(p)b+='<div class="m26-import-summary"><b>'+p.valid+' valid</b><span>'+p.invalid+' invalid · '+p.total+' rows</span></div><div class="m26-import-preview"><table class="dense"><thead><tr><th>Row</th><th>Plant</th><th>Code</th><th>Name</th><th>Result</th></tr></thead><tbody>'+(p.rows||[]).slice(0,120).map(r=>'<tr><td>'+r.row+'</td><td>'+esc(r.plant||"")+'</td><td>'+esc(r.equipment_code||"")+'</td><td>'+esc(r.equipment_name||"")+'</td><td>'+(r.valid?'<span class="badge b-success">Valid</span>':'<span class="badge b-danger">'+esc((r.errors||[]).join("; "))+'</span>')+'</td></tr>').join("")+'</tbody></table></div>';return modal("Import equipment","Excel / CSV",b,'<button class="btn o" onclick="closeModal()">Cancel</button>'+(p&&p.invalid===0&&p.valid>0?'<button class="btn p" onclick="m26EqImportCommit()">Import '+p.valid+' rows</button>':''),true)}
async function m26EqImportPick(input){const file=input&&input.files&&input.files[0];if(!file)return;M26R.importFile=file;const fd=new FormData();fd.append("file",file);fd.append("dry_run","true");try{const p=await apiFetch("/api/equipment/import",{method:"POST",body:fd});M26R.importPreview=p;render()}catch(e){toast("Import preview failed — "+e.message)}}
async function m26EqImportCommit(){if(!M26R.importFile)return;const fd=new FormData();fd.append("file",M26R.importFile);fd.append("dry_run","false");try{const r=await apiFetch("/api/equipment/import",{method:"POST",body:fd});S.equipment=(S.equipment||[]).concat(r.created||[]);closeModal();toast((r.created||[]).length+" equipment rows imported.");m26EqLoadPage(true)}catch(e){toast("Import stopped — "+e.message)}}
async function m26EqDownload(url,name){try{const r=await m26RawFetch(url);const b=await r.blob(),u=URL.createObjectURL(b),a=document.createElement("a");a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}catch(e){toast("Download failed — "+e.message)}}
function m26EqTemplate(){m26EqDownload("/api/equipment/import/template.xlsx","equipment-register-template.xlsx")}
function m26EqExport(){const q=m26EqQuery(1);q.delete("offset");q.delete("limit");m26EqDownload("/api/equipment/export.xlsx?"+q.toString(),"equipment-register.xlsx")}

/* ---- wiring: sidebar link, page, crumb, modals ---- */
if(typeof sidebar==="function"){
 const m26OrigSidebar=sidebar;
 sidebar=function(){let h=m26OrigSidebar.apply(this,arguments);if(((typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role)||S.currentRole)==="Site Engineer")return h;const on=S.view==="equipment",link='<div class="side-link '+(on?"active":"")+'" onclick="m26GoEq()">'+I.boxes(16)+'<span>Equipment Register</span></div>';let lab=h.indexOf("<span>Photo Intelligence</span>");if(lab<0)return h;const end=h.indexOf("</div>",lab)+6;return h.slice(0,end)+link+h.slice(end)};
}
if(typeof renderServices==="function"){const m26OrigServices=renderServices;renderServices=function(){return S.view==="equipment"?renderEquipmentRegister():m26OrigServices.apply(this,arguments)}}
if(typeof render==="function"){const m26OrigRender=render;render=function(){m26OrigRender.apply(this,arguments);if(S.view==="equipment"){try{document.querySelectorAll(".topbar *").forEach(el=>{if(el.children.length===0){const t=el.textContent.trim();if(t==="Extra Services")el.textContent="Equipment Register";else if(t==="Operations")el.textContent="Equipment"}})}catch(e){}}}}
if(typeof renderModal==="function"){const m26OrigModal2=renderModal;renderModal=function(){if(S.modal==="m26Eq"){const c=S.modalCtx||{};return m26EqForm(c.mode,c.id)}if(S.modal==="m26EqAssign")return m26EqAssignModal((S.modalCtx||{}).type);if(S.modal==="m26EqMove")return m26EqMoveModal((S.modalCtx||{}).id);if(S.modal==="m26EqDetail")return m26EqDetailModal((S.modalCtx||{}).id);if(S.modal==="m26EqImport")return m26EqImportModal();return m26OrigModal2.apply(this,arguments)}}

/* Mobile navigation: keep the compact primary destinations and place secondary
   modules (including Equipment Register) behind More. Site Engineer navigation
   is deliberately unchanged because that role is plant-scoped and locked. */
function m26MobileMoreOpen(){S.modal="m26MobileMore";S.modalCtx={};render()}
function m26MobileMoreGo(kind){S.modal=null;S.modalCtx=null;if(kind==="app")return window.s91AppSettings&&s91AppSettings();if(kind==="equipment")return m26GoEq();if(kind==="photos")return goView("photos");if(kind==="calendar")return goTab("calendar");if(kind==="issues"||kind==="scheduled"||kind==="washing"||kind==="handover"||kind==="services")return goTab(kind);return goView(kind)}
function m26MobileMoreModal(){
 const role=S._roleLabel||S.currentRole||"O&M Head";
 const byRole={
  "O&M Head":[["photos","Photo Intelligence","Site photos from every plant"],["settings","Settings","Application settings"]],
  "Assignee":[["photos","Photo Intelligence","Search field photos and attach evidence"]],
  "Administration":[["photos","Photo Intelligence","Site photos (view only)"]],
  "Site Engineer":[["washing","Washing","Plant-scoped washing work"]]
 };
 const items=[["calendar","Operations Calendar","Issues, maintenance & washing by date"]].concat(byRole[role]||[]).concat([["app","App & permissions","Install, camera and notifications on this device"]]);
 return modal("More","All available modules",'<div class="m26-mobile-more">'+items.map(x=>'<button class="panel" type="button" onclick="m26MobileMoreGo('+m26Js(x[0])+')"><b>'+esc(x[1])+'</b><span>'+esc(x[2])+'</span></button>').join("")+'</div>','<button class="btn o" onclick="closeModal()">Close</button>',true)
}
if(typeof mobileNav==="function"){
 const m26OrigMobileNav=mobileNav;
 mobileNav=function(b){
  const role=(S._roleLabel||S.currentRole||"O&M Head");
  if(role==="Site Engineer"){
   const it=(id,l,ic,fn,n)=>'<div class="'+(id==="more"&&S.modal==="m26MobileMore"?"active":"")+'" role="button" tabindex="0" aria-label="'+esc(l)+'" onclick="'+fn+'">'+ic+'<span>'+l+'</span>'+(n?'<span class="side-badge">'+Math.min(n,99)+'</span>':'')+'</div>';
   return '<nav class="mnav" aria-label="Mobile navigation">'+it("dashboard","My Plant",I.dash(18),"goView(\'dashboard\')")+it("issues","Issues",I.alert(18),"goTab(\'issues\')",b.isBadge)+it("scheduled","Preventive",I.clipc(18),"goScheduledOM(\'maintenance\')",(b.scBadge||0)+(b.waBadge||0))+it("photos","Photos",I.ftext(18),"goView(\'photos\')")+it("more","More",I.boxes(18),"m26MobileMoreOpen()")+'</nav>';
  }
  const raw=S.view==="dashboard"?"dashboard":(S.view==="plants"||S.view==="plant")?"plants":(S.view==="equipment"||S.view==="photos")?"more":S.omTab;
  const act=(raw==="scheduled"||raw==="washing")?"scheduled":(["work","data","settings"].includes(S.view)?"more":raw);
  const it=(id,l,ic,fn,n)=>'<div class="'+(act===id?"active":"")+'" role="button" tabindex="0" aria-label="'+esc(l)+'" onclick="'+fn+'">'+ic+'<span>'+l+'</span>'+(n?'<span class="side-badge">'+Math.min(n,99)+'</span>':'')+'</div>';
  return '<nav class="mnav" aria-label="Mobile navigation">'+it("dashboard","Home",I.dash(18),"goView(\'dashboard\')")+it("plants","Plants",I.sun(18),"goView(\'plants\')")+it("issues","Issues",I.alert(18),"goTab(\'issues\')",b.isBadge)+it("scheduled","Preventive",I.clipc(18),"goScheduledOM(\'maintenance\')",(b.scBadge||0)+(b.waBadge||0))+it("more","More",I.boxes(18),"m26MobileMoreOpen()")+'</nav>';
 }
}
/* Extend the existing modal monkey-patch rather than replacing any renderer. */
if(typeof renderModal==="function"){
 const m26ModalWithEquipment=renderModal;
 renderModal=function(){if(S.modal==="m26MobileMore")return m26MobileMoreModal();return m26ModalWithEquipment.apply(this,arguments)};
}

/* Modal/drawer keyboard safety: Esc closes; Tab remains inside the active layer. */
document.addEventListener("keydown",function(ev){
 const layer=document.querySelector(".m26-drawer, .modal");if(!layer)return;
 if(ev.key==="Escape"&&S.modal){ev.preventDefault();closeModal();return}
 if(ev.key!=="Tab")return;
 const els=[...layer.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(x=>x.offsetParent!==null);
 if(!els.length)return;const first=els[0],last=els[els.length-1];if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last.focus()}else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first.focus()}
});
