"use strict";
/* Plants · dashboard. One screen, read at a glance: four status tiles, a colour map of every plant and the work
   that needs attention, for ALL plants or ONE plant. Read-only: it uses the loaded Site Issues and Preventive
   Maintenance records plus the washing overview (GET /api/scheduled/washing/overview, loaded once and cached).
   Every tile, chip and row opens the matching module filtered to the selected plant; nothing here writes to the server. */
(function(){
 if(window.s91PlantPulse)return;
 const h=v=>typeof esc==="function"?esc(v==null?"":String(v)):String(v==null?"":v);
 const pct=(n,t)=>t?Math.round(100*n/t):0;
 const st=()=>{const f=S.plPulse=S.plPulse||{};if(f.plant===undefined)f.plant="all";return f};

 /* ---------- data for the selected scope ---------- */
 function scopeData(sp){
  const f=st(),names=new Set(sp.map(p=>p.name));
  if(f.plant!=="all"&&!names.has(f.plant))f.plant="all";
  const pick=f.plant==="all"?names:new Set([f.plant]);
  const issues=(S.issues||[]).filter(t=>pick.has(t.plant));
  const tasks=(S.tasks||[]).filter(t=>pick.has(t.plant)&&t.status!=="Cancelled");
  const open=openTk(issues),overdueIssues=open.filter(isOverdueIssue),critical=open.filter(isCriticalIssue);
  const pmOverdue=tasks.filter(t=>t.status!=="Completed"&&taskOD(t)>0);
  const pmDueSoon=tasks.filter(t=>t.status!=="Completed"&&taskOD(t)===0&&t.due&&dayDiff(TODAY,t.due)>=0&&dayDiff(TODAY,t.due)<=7);
  const wc=S._washCycles,washRows=wc?(wc.plants||[]).filter(p=>pick.has(p.plant)):[];
  const thr=(washRows[0]&&washRows[0].compliance_threshold_percent)||85;
  let washPct=null;
  if(wc&&washRows.length){
   /* current cycle: tables done / due by today; a plant ahead counts only up to its due (as on the server) */
   const ccs=washRows.map(p=>p.cycle_compliance).filter(Boolean),due=ccs.reduce((a,c)=>a+c.due,0),done=ccs.reduce((a,c)=>a+Math.min(c.done,c.due),0);
   washPct=ccs.length?(due?Math.min(100,Math.round(100*done/due)):100):null;
  }
  const cyclesDone=washRows.reduce((a,p)=>a+(p.cycles_this_month||0),0),cyclesTarget=washRows.reduce((a,p)=>a+(p.monthly_target||3),0);
  const washLate=washRows.filter(p=>p.overdue_bucket&&p.overdue_bucket!=="on_track").length;
  const tablesToday=f.plant==="all"&&wc&&wc.portfolio?(wc.portfolio.tables_washed_today||0):washRows.reduce((a,p)=>{const d=(p.daily_status||[]).find(x=>x.date===TODAY);return a+(d?(d.confirmed||0):0)},0);
  return{f,pick,issues,tasks,open,overdueIssues,critical,pmOverdue,pmDueSoon,wc,washRows,thr,washPct,cyclesDone,cyclesTarget,washLate,tablesToday,
   notSetUp:wc?(wc.unconfigured||[]).filter(p=>pick.has(p.plant)).length:0};
 }
 /* health of every plant from one pass over the open issues; worst first */
 function plantStates(sp){
  const by=new Map();
  openTk(S.issues||[]).forEach(t=>{if(!t.plant)return;const a=by.get(t.plant);if(a)a.push(t);else by.set(t.plant,[t])});
  const rank={Critical:0,Warning:1,Healthy:2};
  return sp.map(p=>{const oi=by.get(p.name)||[];return{p,health:plantHealthOf(p,oi),open:oi.length}})
   .sort((a,b)=>rank[a.health]-rank[b.health]||b.open-a.open||String(a.p.id).localeCompare(String(b.p.id),undefined,{numeric:true}));
 }
 const toneOf=(v,low,high)=>typeof v!=="number"?"none":v>=high?"ok":v>=low?"warn":"bad";

 function tile(o){
  return '<button type="button" class="pd-tile pd-'+o.tone+'" '+o.click+' title="'+h(o.tip)+'"><span class="pd-lab"><i aria-hidden="true"></i>'+h(o.label)+'</span><b>'+o.value+'</b><small>'+o.sub+'</small>'+(o.bar||"")+'</button>';
 }
 /* desktop: fill the screen below whatever sits above the dashboard (alert banners), so it never needs a page scroll */
 function fit(){
  const el=document.getElementById("plant-pulse");if(!el)return;
  if(innerWidth<=900||innerHeight<=620){el.style.height="";return}
  el.style.height=Math.max(460,Math.floor(innerHeight-(el.getBoundingClientRect().top+scrollY)-16))+"px";
 }
 let fitTimer=0;
 addEventListener("resize",()=>{clearTimeout(fitTimer);fitTimer=setTimeout(fit,120)});
 function row(key,label,n,tone){
  return '<button type="button" class="pd-row'+(n?"":" zero")+'" onclick="s91PulseGo(\''+key+'\')"><i class="pd-dot pd-'+tone+'" aria-hidden="true"></i><span>'+h(label)+'</span><b>'+n+'</b></button>';
 }

 /* ---------- main ---------- */
 window.s91PlantPulse=function(sp){
  try{
   if(!S._washCycles&&!S._washCycleError&&typeof window.washCyclesEnsureLoaded==="function"){
    window.washCyclesEnsureLoaded();
    const pending=S._washCycleLoading;
    if(pending&&!S._pulseWashWait){S._pulseWashWait=true;const done=()=>{S._pulseWashWait=false;if(S.view==="plants")render()};pending.then(done,done)}
   }
   requestAnimationFrame(fit);
   const d=scopeData(sp||[]),f=d.f,isAll=f.plant==="all";
   const states=plantStates(sp||[]),scoped=isAll?states:states.filter(x=>x.p.name===f.plant);
   const healthy=scoped.filter(x=>x.health==="Healthy").length,crit=scoped.filter(x=>x.health==="Critical").length,warn=scoped.length-healthy-crit;
   const pmPct=d.tasks.length?pct(d.tasks.length-d.pmOverdue.length,d.tasks.length):null;

   const plantOpts='<option value="all">All plants ('+sp.length+')</option>'+sp.slice().sort((a,b)=>String(a.name).localeCompare(String(b.name))).map(p=>'<option value="'+h(p.name)+'"'+(f.plant===p.name?" selected":"")+'>'+h((p.id?displayCode(p.id)+" · ":"")+p.name)+'</option>').join("");
   const capSet=isAll?sp:sp.filter(p=>p.name===f.plant);
   const cap=(label,field,unit,getKw)=>{const missing=capSet.filter(p=>getKw(p)==null).length,kw=totalPlantCapacitykW(capSet,field);
    return '<span class="pd-cap" title="'+h(label+" capacity"+(missing?" · "+missing+" plant"+(missing===1?"":"s")+" without a value":""))+'"><em>'+label+'</em>'+(missing===capSet.length?"—":s91Mw(kw)+" "+unit)+'</span>'};
   const today=new Date(TODAY+"T00:00:00").toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short",year:"numeric"});

   /* plant health: the share bar is healthy / warning / critical; the words stay Healthy or Unhealthy */
   const one=!isAll&&scoped[0];
   const healthTile=one?tile({tone:one.health==="Healthy"?"ok":one.health==="Critical"?"bad":"warn",label:"Plant health",value:one.health==="Healthy"?"Healthy":"Unhealthy",
     sub:one.open?one.open+" open issue"+(one.open===1?"":"s"):"No open issues",click:'data-act="plant" data-id="'+h(one.p.id)+'"',tip:"Open this plant"})
    :tile({tone:scoped.length&&healthy===scoped.length?"ok":crit?"bad":"warn",label:"Healthy plants",value:healthy+'<em>/ '+scoped.length+'</em>',
     sub:(scoped.length-healthy)+" unhealthy",click:'onclick="s91PulseGo(\'unhealthy\')"',tip:"Open the plants table filtered to unhealthy plants",
     bar:'<span class="pd-bar" aria-hidden="true"><i class="pd-ok" style="flex:'+healthy+'"></i><i class="pd-warn" style="flex:'+warn+'"></i><i class="pd-bad" style="flex:'+crit+'"></i></span>'});
   const issueTile=tile({tone:d.critical.length||d.overdueIssues.length?"bad":d.open.length?"warn":"ok",label:"Open site issues",value:String(d.open.length),
    sub:d.critical.length+" critical · "+d.overdueIssues.length+" past ETC",click:'onclick="s91PulseGo(\'issues\')"',tip:"Open the open site issues"});
   const pmTile=tile({tone:toneOf(pmPct,70,90),label:"PM on schedule",value:pmPct==null?"—":pmPct+"%",
    sub:d.tasks.length?d.pmOverdue.length+" overdue of "+d.tasks.length:"No PM work orders",click:'onclick="s91PulseGo(\'pm\')"',tip:"Preventive Maintenance work orders not past their due date"});
   const washTile=tile({tone:toneOf(d.washPct,Math.max(0,d.thr-15),d.thr),label:"Washing compliance",value:typeof d.washPct==="number"?d.washPct+"%":"—",
    sub:S._washCycleError&&!d.wc?"Not available for your role":!d.wc?"Loading…":d.washRows.length?d.cyclesDone+" / "+d.cyclesTarget+" cycles this month":"Washing not set up",
    click:'onclick="s91PulseGo(\'wash\')"',tip:"Current cycle: tables done vs due by today, against the "+d.thr+"% target"});

   const chips=states.map(x=>{const tone=x.health==="Healthy"?"ok":x.health==="Critical"?"bad":"warn";
    return '<button type="button" class="pd-chip pd-'+tone+(!isAll&&x.p.name===f.plant?" sel":"")+'" data-act="plant" data-id="'+h(x.p.id)+'" title="'+h(x.p.name+" · "+(x.health==="Healthy"?"Healthy":"Unhealthy")+" · "+(x.open?x.open+" open":"no open issues"))+'"><b>'+h(displayCode(x.p.id))+'</b>'+(x.open?'<small>'+x.open+'</small>':'')+'</button>'}).join("");
   const allHealthy=states.filter(x=>x.health==="Healthy").length;

   const attention=[["issCrit","Critical issues",d.critical.length,"bad"],["issOver","Issues past ETC",d.overdueIssues.length,"bad"],["pmOver","PM overdue",d.pmOverdue.length,"warn"],["pmSoon","PM due this week",d.pmDueSoon.length,"sun"],["washLate","Plants behind on washing",d.washLate,"info"]];
   const pmToday=d.tasks.filter(t=>t.status!=="Completed"&&t.due===TODAY).length,raisedToday=d.issues.filter(t=>issueCreatedDay(t)===TODAY).length;

   return '<section class="pd" id="plant-pulse" aria-label="Plants dashboard">'+
    '<header class="pd-top"><div><h1>Plants dashboard</h1><p>'+h(today)+' · '+h(isAll?"All "+sp.length+" plants":f.plant)+'<span class="pd-caps">'+cap("DC","capacitykW","MWp",plantDcKw)+cap("AC","acCapacitykW","MW",plantAcKw)+'</span></p></div>'+
     '<label class="pd-scope'+(isAll?"":" on")+'"><span>Show</span><select aria-label="Choose all plants or one plant" onchange="s91PulsePlant(this.value)">'+plantOpts+'</select></label></header>'+
    '<div class="pd-tiles">'+healthTile+issueTile+pmTile+washTile+'</div>'+
    '<div class="pd-main">'+
     '<article class="pd-card pd-map"><header><h2>Plant status</h2><span class="pd-legend"><span><i class="pd-dot pd-ok"></i>Healthy '+allHealthy+'</span><span><i class="pd-dot pd-bad"></i>Unhealthy '+(states.length-allHealthy)+'</span><span class="pd-hint">number = open issues · click a plant to open it</span></span></header>'+
      (states.length?'<div class="pd-grid">'+chips+'</div>':'<div class="pd-empty">No plants in your scope.</div>')+'</article>'+
     '<article class="pd-card pd-attn"><h3>Today</h3><div class="pd-today">'+
      [["pmToday","PM due",pmToday],["issToday","Issues raised",raisedToday],["wash","Tables cleaned",d.wc?d.tablesToday:"—"]].map(x=>'<button type="button" onclick="s91PulseGo(\''+x[0]+'\')"><b>'+x[2]+'</b><span>'+x[1]+'</span></button>').join("")+'</div>'+
      '<header><h2>Needs attention</h2></header>'+
      (attention.some(a=>a[2])?"":'<div class="pd-clear">All clear — nothing waiting.</div>')+
      '<div class="pd-rows">'+attention.map(a=>row(a[0],a[1],a[2],a[3])).join("")+'</div>'+
     '</article></div></section>';
  }catch(error){
   console.error("[Plants dashboard]",error);
   return '<div class="bn-warn banner">The plants dashboard could not be drawn: '+h(error.message)+'. The plants table is unaffected.</div>';
  }
 };

 window.s91PulsePlant=function(v){st().plant=v||"all";render()};
 window.s91PulseGo=function(key){
  const f=st(),plant=f.plant;
  const d=scopeData(typeof dashScope==="function"?dashScope():(S.plants||[]));
  if(key==="unhealthy"){S.plF=Object.assign(S.plF||{},{health:"Unhealthy"});S.tablePages.plants=1;goView("plants","table");return}
  if(key==="issues"||key==="issOpen"){drillIssues({plant,chip:"Open",queue:"",q:"",from:"",to:""});return}
  if(key==="issCrit"){drillIssues({plant,chip:"Open",queue:"critical",q:"",from:"",to:""});return}
  if(key==="issOver"){drillIssues({plant,chip:"Overdue",queue:"",q:"",from:"",to:""});return}
  if(key==="issToday"){drillIssues({plant,chip:"all",queue:"",q:"",from:TODAY,to:TODAY});return}
  if(key==="pmToday"){
   S.pmLive=Object.assign(S.pmLive||{},{plant,day:TODAY,dayFrom:addDays(TODAY,-2),dayEquip:"all",plantOpen:false,view:"schedule",calMonth:TODAY.slice(0,7)});
   S._glanceScroll="pm-day-planner";goScheduledOM("maintenance");return;
  }
  if(key==="pm"||key==="pmOver"||key==="pmSoon"){
   const status=key==="pmSoon"?"Due soon":key==="pmOver"?"Overdue":d.pmOverdue.length?"Overdue":"all";
   S.pmLive=Object.assign(S.pmLive||{},{plant,status,week:"all",age:"all",equipment:"all",query:"",page:1,plantOpen:false,view:"register"});
   S._glanceScroll="pm-unit-register";goScheduledOM("maintenance");return;
  }
  if(key==="wash"||key==="washLate"){
   const ui=S._washUi=S._washUi||{q:"",bucket:"all",show:"all",assignee:"all",region:"all",sort:"late",page:1,pageSize:12,selected:[]};
   const wc=S._washCycles||{},row=plant==="all"?null:(wc.plants||[]).concat(wc.unconfigured||[]).find(p=>p.plant===plant);
   Object.assign(ui,{plant:row?row.plant_id:"all",state:key==="washLate"?"late":"all",show:"all",bucket:"all",cyc:"all",page:1});
   S.washF=Object.assign({},ui);S._glanceScroll="wc-results";goScheduledOM("washing");return;
  }
 };
})();
