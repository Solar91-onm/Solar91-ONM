"use strict";

(function(){
 const COLORS={Done:"#16A34A",Upcoming:"#3B82F6","Due soon":"#D97706",Overdue:"#DC4C3E"};
 const ALERTS=[
  ["pm_due_soon","Due in 3 days"],["pm_due_today","Due today"],["pm_late_1d","1 day late"],
  ["pm_late_3d","3 days late"],["pm_critical_7d","7 days late (critical)"],
  ["pm_promise_missed","Site promise missed"],["pm_no_followup","No follow-up on late job"],
  ["pm_weekly_summary","Weekly late-job summary"],["pm_daily_plan","Morning plan: today's plants & equipment"]
 ];
 const state=()=>{const f=S.pmLive||(S.pmLive={}),defaults={plant:"all",plantQuery:"",plantOpen:false,plantTab:"late",equipment:"all",week:"all",age:"all",status:"all",query:"",page:1,covShow:"all",covOpen:[],covCollapsed:true,day:TODAY,dayFrom:addDays(TODAY,-2),dayEquip:"all",dayQuery:"",dayStatus:"all",dayAll:false,focus:"all",person:"all",sort:"due",leadAll:false,view:"overview",calMonth:TODAY.slice(0,7),mxQuery:"",mxShow:"all",mxSort:"late",mxAll:false};Object.keys(defaults).forEach(key=>{if(f[key]===undefined)f[key]=defaults[key]});return f};
 const repaint=()=>window.render();
 const escape=typeof esc==="function"?esc:value=>String(value==null?"":value);
 /* One page render reads the same derived data many times (coverage per register row, plant lookups per task).
    With ~2,000 work orders across 100 plants that repetition made every click and keystroke cost ~300 ms, so each
    render computes it once. The memo lives only for one render: clicks outside a render always see fresh data. */
 let memo=null;
 const once=(name,fn)=>{if(!memo)return fn();if(!memo.has(name))memo.set(name,fn());return memo.get(name)};
 const scopeTasks=()=>once("scope",()=>{
  const f=state(),role=S._roleLabel||S.currentRole||"";
  let tasks=S.tasks||[];
  if(role==="Site Engineer"&&S._sePlant)tasks=tasks.filter(t=>t.plant===S._sePlant);
  if(f.plant!=="all")tasks=tasks.filter(t=>t.plant===f.plant);
  return tasks;
 });
 /* calendar day number of an ISO date; the same few hundred dates repeat across thousands of work orders */
 const DAY_NO=new Map();
 const dayNo=iso=>{let n=DAY_NO.get(iso);if(n===undefined){const p=String(iso).slice(0,10).split("-").map(Number);n=Math.round(Date.UTC(p[0],(p[1]||1)-1,p[2]||1)/86400000);if(DAY_NO.size>5000)DAY_NO.clear();DAY_NO.set(iso,n)}return n};
 const dueOffset=task=>{
  if(!task.due)return null;
  return dayNo(task.due)-dayNo(TODAY);
 };
 const taskStatus=task=>{
  if(task.status==="Completed")return"Done";
  if(task.status==="Cancelled")return"Cancelled";
  const days=dueOffset(task);
  if(days!==null&&days<0)return"Overdue";
  if(days!==null&&days<=7)return"Due soon";
  return"Upcoming";
 };
 const daysLate=task=>Math.max(0,-(dueOffset(task)||0));
 const quantity=task=>Number(task.unitNo)?1:Number(task.quantity||task.totalUnits||1);
 const countsOf=tasks=>tasks.reduce((counts,task)=>{
  const key=taskStatus(task);counts[key]=(counts[key]||0)+1;return counts;
 },{});
 const plantMap=()=>once("plantMap",()=>new Map((S.plants||[]).map(plant=>[plant.name,plant])));
 const plantFor=name=>plantMap().get(name);
 const currentScopeTasks=()=>once("current",()=>scopeTasks().filter(task=>task.status!=="Cancelled"));
 const filteredTasks=()=>{
  const f=state();let rows=scopeTasks();
  if(f.status!=="Cancelled")rows=rows.filter(task=>task.status!=="Cancelled");
  if(f.equipment!=="all")rows=rows.filter(task=>task.type===f.equipment);
  if(f.status!=="all")rows=rows.filter(task=>taskStatus(task)===f.status);
  if(f.week!=="all")rows=rows.filter(task=>task.due&&Math.floor((dueOffset(task)||0)/7)===f.week);
  if(f.age!=="all")rows=rows.filter(task=>taskStatus(task)==="Overdue"&&daysLate(task)>=f.age[0]&&daysLate(task)<=f.age[1]);
  if(f.focus==="today")rows=rows.filter(task=>isOpen(task)&&onDay(task,TODAY));
  else if(f.focus==="unassigned")rows=rows.filter(task=>isOpen(task)&&unassigned(task));
  if(f.person!=="all")rows=rows.filter(task=>f.person==="__none"?unassigned(task):task.assignee===f.person);
  if(f.query){const q=f.query.toLowerCase();rows=rows.filter(task=>[task.id,task.name,task.type,task.equip,task.assignee,task.plant,(plantFor(task.plant)||{}).id].join(" ").toLowerCase().includes(q))}
  return rows.sort((a,b)=>String(a.due||"").localeCompare(String(b.due||"")));
 };
 const isOpen=task=>task.status!=="Completed"&&task.status!=="Cancelled";
 const unassigned=task=>{const who=String(task.assignee||"").trim();return!who||who==="Unassigned"||who==="—"};
 /* reassignment (PATCH /api/scheduled/tasks/{id}/assignee) needs tasks.manage, which only the O&M Head holds */
 const canAssign=()=>(S._roleLabel||S.currentRole||"")==="O&M Head";
 const PAGE=15;
 // Read-only plant equipment totals. The equipment register and PM unit configuration
 // define unit quantities; work orders alone must never be treated as the inventory.
 let unitRequest=null,unitLoaded=false,unitError=null;
 function loadUnitCoverage(force){
  if(force){unitLoaded=false;unitRequest=null;unitError=null}
  if(unitLoaded||unitRequest||!(S.view==="om-module"&&S.omTab==="scheduled"))return;
  const role=S._roleLabel||S.currentRole||"";
  if(!["O&M Head","Administration","Assignee"].includes(role)){
   unitLoaded=true;unitError="Unit inventory is visible to authorised PM planners and assignees.";return;
  }
  unitRequest=apiFetch("/api/pm-plan/unit-config").then(data=>{
   S._pmCfg=data;unitLoaded=true;unitError=null;
  }).catch(error=>{
   unitLoaded=true;unitError=error.message||"Unit configuration could not be loaded.";
  }).finally(()=>{
   unitRequest=null;
   if(S.view==="om-module"&&S.omTab==="scheduled")repaint();
  });
 }
 const scopedPlants=()=>once("plants",()=>{
  const f=state(),role=S._roleLabel||S.currentRole||"";
  return(S.plants||[]).filter(p=>(role!=="Site Engineer"||!S._sePlant||p.name===S._sePlant)&&(f.plant==="all"||p.name===f.plant));
 });
 function coverageData(){return once("coverage",buildCoverageData)}
 /* ACCB-1 + ACCB-2, Aux. Transformer, ACDB and the Miscellaneous items are one PM job per plant (app/pmplan/cycle.py ONE_JOB_TYPES) */
 const ONE_JOB=typeof PM_ONE_JOB_TYPES!=="undefined"?PM_ONE_JOB_TYPES:[];
 const pmUnits=(type,n)=>n>0&&ONE_JOB.indexOf(type)>=0?1:n;
 function buildCoverageData(){
  const cfg=S._pmCfg||{configs:[],register:[]},plants=scopedPlants();
  const rows=new Map(),byName=new Map(plants.map(p=>[p.name,p])),byId=new Map(plants.map(p=>[String(p.dbId||p.id),p]));
  const put=(plant,type)=>{
   if(!plant||!type)return null;
   const key=plant.name+"\u0000"+type;
   if(!rows.has(key))rows.set(key,{plant:plant.name,plantId:plant.id,type,units:null,source:"Not configured",daily:null,tasks:[],critical:0,faulty:0});
   return rows.get(key);
  };
  const plantOf=id=>byId.get(String(id));
  (cfg.configs||[]).forEach(c=>{
   const row=put(plantOf(c.plant_id),c.equipment_type);
   if(row){row.units=pmUnits(row.type,Number(c.total_units))||null;row.daily=Number(c.units_per_day)||null;row.source="Configured units"}
  });
  (cfg.register||[]).forEach(c=>{
   const row=put(plantOf(c.plant_id),c.equipment_type);
   if(row&&Number(c.units)>0){row.units=pmUnits(row.type,Number(c.units));row.source="Equipment register"}
   if(row){row.critical=Number(c.critical)||0;row.faulty=Number(c.faulty)||0}
  });
  currentScopeTasks().forEach(t=>{const row=put(byName.get(t.plant),t.type);if(row)row.tasks.push(t)});
  return[...rows.values()].map(row=>{
   const all=row.tasks.filter(t=>t.status!=="Cancelled");
   const latestByUnit=new Map();
   all.forEach(t=>{if(Number(t.unitNo)>0){
    const key=String(t.unitNo),old=latestByUnit.get(key);
    if(!old||String(t.cycleId||"")+String(t.plannedDue||t.due||"")>String(old.cycleId||"")+String(old.plannedDue||old.due||""))latestByUnit.set(key,t);
   }});
   const perUnit=latestByUnit.size>0;
   const effective=perUnit?[...latestByUnit.values()]:all;
   const maintained=perUnit?effective.filter(t=>taskStatus(t)==="Done").length:effective.filter(t=>taskStatus(t)==="Done").reduce((n,t)=>n+quantity(t),0);
   const overdue=perUnit?effective.filter(t=>taskStatus(t)==="Overdue").length:effective.filter(t=>taskStatus(t)==="Overdue").reduce((n,t)=>n+quantity(t),0);
   const planned=perUnit?effective.length:effective.reduce((n,t)=>n+quantity(t),0);
   const label=!all.length?"Not planned":overdue?"Overdue":maintained&&(!row.units||maintained>=row.units)?"Maintained":"Scheduled";
   /* units named on the PM jobs themselves ("No. of units" on upload); shown only as a labelled fallback, never as inventory */
   const jobUnits=perUnit?Math.max(latestByUnit.size,...effective.map(t=>Number(t.totalUnits)||0)):planned;
   return Object.assign(row,{maintained:Math.min(maintained,row.units||maintained),overdue,planned:row.units?Math.min(planned,row.units):planned,workOrders:all.length,label,jobUnits});
  }).sort((a,b)=>a.plant.localeCompare(b.plant)||a.type.localeCompare(b.type));
 }
 /* Equipment coverage: ONE row per equipment type across the selected plants. The per-plant breakdown opens
    as a dropdown under the row, so an "All plants" inverter job no longer fills the table with a row per plant. */
 const COV_RANK={late:0,missing:1,stray:2,scheduled:3,unknown:4,done:5};
 function coverageGroups(){
  const map=new Map(),data=coverageData(),hasInventory=data.some(r=>r.units!==null);
  data.forEach(r=>{if(!map.has(r.type))map.set(r.type,{type:r.type,rows:[]});map.get(r.type).rows.push(r)});
  return[...map.values()].map(g=>{
   const rs=g.rows,sum=k=>rs.reduce((n,r)=>n+(Number(r[k])||0),0);
   g.units=rs.some(r=>r.units!==null)?sum("units"):null;g.jobUnits=sum("jobUnits");g.hasInventory=hasInventory;
   g.critical=sum("critical");g.faulty=sum("faulty");g.planned=sum("planned");g.maintained=sum("maintained");g.overdue=sum("overdue");
   g.equipped=rs.filter(r=>r.units!==null&&r.units>0);
   g.late=rs.filter(r=>r.label==="Overdue");
   g.missing=rs.filter(r=>r.units&&!r.workOrders);
   /* with no register / unit counts anywhere, "not in register" is true of every plant and says nothing: one notice covers it */
   g.stray=hasInventory?rs.filter(r=>r.units===null&&r.workOrders):[];
   g.status=g.late.length?"late":g.missing.length?"missing":g.stray.length?"stray":(g.units&&g.maintained>=g.units)?"done":g.planned?"scheduled":"unknown";
   g.rows=rs.slice().sort((a,b)=>(COV_RANK[rowState(a,hasInventory)]-COV_RANK[rowState(b,hasInventory)])||a.plant.localeCompare(b.plant));
   return g;
  }).sort((a,b)=>(COV_RANK[a.status]-COV_RANK[b.status])||(b.critical-a.critical)||a.type.localeCompare(b.type));
 }
 function rowState(r,hasInventory){if(r.units===null&&r.workOrders&&hasInventory===false)return r.overdue?"late":r.planned&&r.maintained>=r.planned?"done":"scheduled";return r.units===null?(r.workOrders?"stray":"unknown"):r.label==="Not planned"?"missing":r.label==="Overdue"?"late":r.label==="Maintained"?"done":"scheduled"}
 const STATE_LABEL={late:"Overdue",missing:"No PM job",stray:"Not in register",scheduled:"Scheduled",unknown:"Set unit count",done:"Maintained"};
 function miniBar(done,late,total){const t=Math.max(1,total);return'<div class="pml-unit-bar" role="img" aria-label="'+done+' of '+total+' units done, '+late+' overdue"><i class="done" style="width:'+Math.min(100,100*done/t)+'%"></i><i class="overdue" style="width:'+Math.min(100,100*late/t)+'%"></i></div>'}
 function coverageHtml(inView){
  const f=state(),all=f.plant==="all",open=new Set(f.covOpen||[]),collapsed=!inView&&f.covCollapsed!==false;
  let groups=coverageGroups().filter(g=>f.equipment==="all"||g.type===f.equipment);
  const toggle='<button type="button" class="btn o sm pmc-toggle" data-pmc-cov aria-expanded="'+(!collapsed)+'">'+(collapsed?'Show equipment table ▾':'Hide table ▴')+'</button>';
  const head='<div class="pml-coverage-head"><div><h3>Equipment coverage</h3><p>One row per equipment type'+(all?' across all plants':'')+'. Open a row (▸) to see each plant. Counts are <b>units</b>.</p></div>'+
   '<div class="pmx-tools">'+(collapsed?'':'<label class="pml-inline-select">Show<select data-pmx-show aria-label="Which equipment to show"><option value="all"'+(f.covShow==="all"?" selected":"")+'>All equipment</option><option value="attention"'+(f.covShow==="attention"?" selected":"")+'>Needs attention</option><option value="critical"'+(f.covShow==="critical"?" selected":"")+'>Has critical / faulty units</option><option value="missing"'+(f.covShow==="missing"?" selected":"")+'>Without a PM job somewhere</option></select></label><button type="button" class="btn o sm" data-pml-action="refresh-units">Refresh</button>')+(inView?'':toggle)+'</div></div>';
  if(!unitLoaded)return'<article class="pml-card pml-coverage pml-eqx">'+head+'<div class="pml-empty">Loading registered equipment and unit counts…</div></article>';
  if(unitError)return'<article class="pml-card pml-coverage pml-eqx">'+head+'<div class="pml-empty">'+escape(unitError)+'</div></article>';
  const hasInventory=groups.some(g=>g.hasInventory);
  const totalUnits=groups.reduce((n,g)=>n+(hasInventory?(g.units||0):g.jobUnits),0),critical=groups.reduce((n,g)=>n+g.critical,0),faulty=groups.reduce((n,g)=>n+g.faulty,0);
  const lateTypes=groups.filter(g=>g.late.length).length,missingPlants=groups.reduce((n,g)=>n+g.missing.length,0);
  const summary='<div class="pml-coverage-metrics"><span><b>'+totalUnits.toLocaleString("en-IN")+'</b>'+(hasInventory?'Registered units':'Units in PM jobs')+' · '+groups.length+' equipment types</span><span class="'+(critical||faulty?"crit":"")+'"><b>'+critical+'</b>Critical units'+(faulty?' · '+faulty+' in fault':'')+'</span><span class="'+(lateTypes?"late":"")+'"><b>'+lateTypes+'</b>Equipment types with overdue work</span><span class="'+(missingPlants?"warn":"")+'"><b>'+missingPlants+'</b>Plant · equipment pairs without a PM job</span></div>';
  const notice=!hasInventory&&groups.length?'<div class="pmc-notice"><span><b>No equipment register or saved unit counts yet.</b> Unit totals here come from the PM jobs themselves. Save each plant’s counts once so coverage can also show equipment that has no PM job.</span>'+(typeof pmOpenUnitCfg==="function"&&["O&M Head","Assignee","Administration"].includes(S._roleLabel||S.currentRole||"")?'<button type="button" class="btn o sm" onclick="pmOpenUnitCfg()">Unit counts</button>':'')+'</div>':'';
  if(collapsed)return'<article class="pml-card pml-coverage pml-eqx is-collapsed">'+head+summary+notice+'</article>';
  if(f.covShow==="attention")groups=groups.filter(g=>g.late.length||g.missing.length||g.stray.length);
  else if(f.covShow==="critical")groups=groups.filter(g=>g.critical||g.faulty);
  else if(f.covShow==="missing")groups=groups.filter(g=>g.missing.length);
  const chips=g=>[g.late.length?'<span class="pmx-chip late">'+g.late.length+' plant'+(g.late.length>1?'s':'')+' overdue</span>':'',g.missing.length?'<span class="pmx-chip warn">'+g.missing.length+' plant'+(g.missing.length>1?'s':'')+' without a PM job</span>':'',g.stray.length?'<span class="pmx-chip gray" title="A PM job exists but the equipment register has none of this type there">'+g.stray.length+' plant'+(g.stray.length>1?'s':'')+' not in register</span>':''].join("")||'<span class="pmx-chip ok">On track</span>';
  const critCell=(c,fl)=>(c?'<span class="pmx-crit">'+c+' high</span>':'<span class="pmx-muted">—</span>')+(fl?'<span class="pmx-fault">'+fl+' fault</span>':'');
  const unitsCell=(units,jobUnits)=>units!==null&&units!==undefined?'<b>'+Number(units).toLocaleString("en-IN")+'</b>':jobUnits?'<b>'+Number(jobUnits).toLocaleString("en-IN")+'</b><small>in PM jobs</small>':'<span class="pmx-muted">—</span>';
  const body=groups.map(g=>{
   const isOpenRow=open.has(g.type)||groups.length===1;
   let h='<tr class="pmx-row'+(isOpenRow?" open":"")+' st-'+g.status+'" data-pmx-type="'+escape(g.type)+'" title="'+(isOpenRow?"Hide":"Show")+' plants"><td><span class="pmx-chev">›</span><b>'+escape(g.type)+'</b><small>'+(g.equipped.length?'registered at '+g.equipped.length+' plant'+(g.equipped.length>1?'s':''):hasInventory?'not in the register yet':g.rows.length+' plant'+(g.rows.length===1?'':'s')+' with PM jobs')+'</small></td>'+
    '<td>'+unitsCell(g.units,g.jobUnits)+'</td><td>'+critCell(g.critical,g.faulty)+'</td>'+
    '<td>'+miniBar(g.maintained,g.overdue,Math.max(g.planned,g.units||0))+'<small>'+g.maintained+' done · '+g.overdue+' overdue · '+g.planned+' planned</small></td>'+
    '<td class="pmx-chips">'+chips(g)+'</td><td><button type="button" class="btn o sm" data-pml-coverage="'+escape(g.type)+'">View jobs</button></td></tr>';
   if(isOpenRow)h+=g.rows.map(r=>{const st=rowState(r,hasInventory);
    return'<tr class="pmx-sub st-'+st+'"><td><button type="button" class="pml-link" data-pml-plant="'+escape(r.plant)+'">'+escape(r.plant)+'</button><small>'+escape(r.plantId||"")+'</small></td><td>'+unitsCell(r.units,r.jobUnits)+'</td><td>'+critCell(r.critical,r.faulty)+'</td>'+
     '<td>'+miniBar(r.maintained,r.overdue,Math.max(r.planned,r.units||0))+'<small>'+r.maintained+' done · '+r.overdue+' overdue · '+r.planned+' planned</small></td>'+
     '<td><span class="pml-cov-status '+({late:"late",missing:"missing",stray:"unknown",unknown:"unknown",done:"done",scheduled:"scheduled"}[st])+'">'+STATE_LABEL[st]+'</span></td><td>'+(r.workOrders?'<button type="button" class="btn g sm" data-pmx-jobs="'+escape(r.plant)+'|'+escape(r.type)+'">Jobs</button>':'')+'</td></tr>'}).join("");
   return h;
  }).join("");
  const table='<div class="pml-coverage-scroll"><table class="pml-coverage-table pmx-table"><thead><tr><th>Equipment</th><th>Units</th><th>Critical</th><th>PM progress</th><th>Needs attention</th><th></th></tr></thead><tbody>'+(body||'<tr><td colspan="6"><div class="pml-empty">No equipment types match “'+escape({attention:"Needs attention",critical:"Has critical / faulty units",missing:"Without a PM job"}[f.covShow]||"this filter")+'”.</div></td></tr>')+'</tbody></table></div>';
  const foot='<div class="pml-coverage-foot">Critical = equipment marked High criticality in the equipment register.'+(hasInventory?' “Not in register” means a PM job exists at a plant whose register has none of that equipment.':'')+'</div>';
  return'<article class="pml-card pml-coverage pml-eqx">'+head+summary+notice+(groups.length||f.covShow!=="all"?table:'<div class="pml-empty">No registered equipment or PM work orders for this plant / equipment filter.</div>')+foot+'</article>';
 }

 /* Day planner: pick a day, see every plant and the equipment being maintained that day. */
 const onDay=(t,d)=>{if(!t.due)return false;const start=t.start&&t.start<=t.due?t.start:t.due;return start<=d&&d<=t.due};
 const WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
 function dayPlannerHtml(){
  const f=state(),tasks=currentScopeTasks().filter(t=>f.equipment==="all"||t.type===f.equipment),day=f.day||TODAY,from=f.dayFrom||addDays(TODAY,-2);
  const days=Array.from({length:14},(_,i)=>addDays(from,i)).map(d=>{const list=tasks.filter(t=>onDay(t,d));return{d,list,units:list.reduce((n,t)=>n+quantity(t),0),plants:new Set(list.map(t=>t.plant)).size}});
  const maxUnits=Math.max(1,...days.map(x=>x.units));
  const strip=days.map(({d,list,units,plants})=>{
   const openList=list.filter(t=>taskStatus(t)!=="Done"),late=d<TODAY&&openList.length,done=list.length&&!openList.length,dt=new Date(d+"T00:00:00");
   return'<button type="button" class="pmd-chip'+(d===day?" on":"")+(list.length?" has":"")+(late?" late":"")+(done?" done":"")+(d===TODAY?" today":"")+'" data-pmd-day="'+d+'" aria-pressed="'+(d===day)+'" title="'+escape(displayDate(d))+': '+units+' unit(s) at '+plants+' plant(s)"><small>'+WD[dt.getDay()]+'</small><b>'+dt.getDate()+'</b><span>'+(units?units+' unit'+(units===1?'':'s'):'—')+'</span><i>'+(plants?plants+' plant'+(plants===1?'':'s'):'')+'</i><em class="pmd-load" aria-hidden="true"><i style="width:'+(units?Math.max(6,Math.round(100*units/maxUnits)):0)+'%"></i></em></button>';
  }).join("");
  const dayTasks=tasks.filter(t=>onDay(t,day));
  const types=[...new Set(dayTasks.map(t=>t.type||"Equipment"))].sort();
  const eq=f.dayEquip!=="all"&&types.includes(f.dayEquip)?f.dayEquip:"all";
  const shown=dayTasks.filter(t=>eq==="all"||(t.type||"Equipment")===eq);
  const units=shown.reduce((n,t)=>n+quantity(t),0),people=new Set(shown.map(t=>t.assignee||"Unassigned")),plantN=new Set(shown.map(t=>t.plant)).size;
  const carried=day===TODAY?tasks.filter(t=>taskStatus(t)==="Overdue"&&!onDay(t,day)):[];
  const dt=new Date(day+"T00:00:00");
  /* one compact row per plant + equipment + activity for this day; the long task text sits on one truncated line */
  const stateOf=g=>g.overdue?"late":g.completed>=g.total?"done":g.lastDue===day?"due":g.completed?"progress":"planned";
  const LABEL={late:"Overdue",done:"Done",due:day===TODAY?"Due today":"Due this day",progress:"In progress",planned:"Planned"},RANK={late:0,due:1,progress:2,planned:3,done:4};
  const groups=workGroups(shown).map(g=>Object.assign(g,{dayState:stateOf(g)}));
  const tally={all:groups.length,todo:groups.filter(g=>g.dayState!=="done").length,late:groups.filter(g=>g.dayState==="late").length,done:groups.filter(g=>g.dayState==="done").length};
  const q=String(f.dayQuery||"").trim().toLowerCase(),want=["all","todo","late","done"].includes(f.dayStatus)?f.dayStatus:"all";
  const rows=groups.filter(g=>(want==="all"||(want==="todo"?g.dayState!=="done":g.dayState===want))&&(!q||[g.plant,(plantFor(g.plant)||{}).id,g.type,g.name,g.assignees.join(" ")].join(" ").toLowerCase().includes(q)))
   .sort((a,b)=>RANK[a.dayState]-RANK[b.dayState]||String(a.plant).localeCompare(String(b.plant))||String(a.type).localeCompare(String(b.type)));
  const LIMIT=12,visible=f.dayAll?rows:rows.slice(0,LIMIT);
  const nextDay=groups.length?"":tasks.map(t=>{if(!t.due||t.due<=day)return"";const first=t.start&&t.start<=t.due?t.start:t.due;return first>day?first:addDays(day,1)}).filter(Boolean).sort()[0]||"";
  const who=g=>{const named=g.assignees.filter(a=>a!=="Unassigned");return(named.length?escape(named.length>2?named.length+" people":named.join(", ")):"")+(g.tasks.some(t=>isOpen(t)&&unassigned(t))?'<span class="pmc-unassigned">'+(named.length?'some unassigned':'Unassigned')+'</span>':"")};
  const body=visible.map(g=>{const pr=plantFor(g.plant)||{},token=groupToken(g),needsWho=canAssign()&&g.tasks.some(t=>isOpen(t)&&unassigned(t));
   return'<tr class="pmd-row st-'+g.dayState+'" data-pml-group="'+token+'"><td class="pmd-c-plant"><button type="button" class="pml-link" data-pml-plant="'+escape(g.plant)+'"><b>'+escape(pr.id||g.plant)+'</b></button><small>'+escape(g.plant)+'</small></td>'+
    '<td class="pmd-c-eq"><span class="pmd-type">'+escape(g.type||"Equipment")+' <b>×'+g.total+'</b></span><small class="pmd-task" title="'+escape(g.name)+'">'+escape(g.name)+'</small></td>'+
    '<td class="pmd-c-prog">'+progressBar(g)+'<small>'+g.completed+'/'+g.total+' done'+(g.overdue?' · <b class="late">'+g.overdue+' overdue</b>':'')+'</small></td>'+
    '<td class="pmd-c-who">'+who(g)+'</td><td><span class="pmd-pill st-'+g.dayState+'">'+LABEL[g.dayState]+'</span></td>'+
    '<td class="pmd-c-act">'+(needsWho?'<button type="button" class="btn o sm" data-pmc-assign="'+token+'">Assign</button>':'')+'<button type="button" class="btn o sm" data-pml-group="'+token+'">Open</button></td></tr>'}).join("");
  const seg=[["all","All"],["todo","To do"],["late","Overdue"],["done","Done"]].map(([k,l])=>'<button type="button" class="'+(want===k?"on":"")+(k==="late"&&tally.late?" hot":"")+'" data-pmd-status="'+k+'" aria-pressed="'+(want===k)+'">'+l+' <b>'+tally[k]+'</b></button>').join("");
  const list=groups.length?'<div class="pmd-tools"><input type="search" class="pmd-search" placeholder="Find plant, code, equipment or person…" value="'+escape(f.dayQuery||"")+'" data-pml-input="day-query" aria-label="Search this day\'s plan"><div class="pmd-seg" role="group" aria-label="Filter by progress">'+seg+'</div></div>'+
   (rows.length?'<div class="pmd-table-wrap"><table class="pmd-table"><thead><tr><th>Plant</th><th>Equipment &amp; work</th><th>Progress</th><th>Assignee</th><th>Status</th><th></th></tr></thead><tbody>'+body+'</tbody></table></div>'+
    (rows.length>LIMIT?'<div class="pmd-more"><span>Showing '+visible.length+' of '+rows.length+'</span><button type="button" class="btn o sm" data-pmd-all>'+(f.dayAll?'Show fewer':'Show all '+rows.length)+'</button></div>':'')
    :'<div class="pml-empty">Nothing on this day matches '+(q?'“'+escape(f.dayQuery)+'”':'this filter')+'.</div>')
   :'<div class="pml-empty">No preventive maintenance is scheduled on this day'+(f.equipment!=="all"?' for '+escape(f.equipment):'')+'.'+(nextDay?' <button type="button" class="btn o sm" data-pmd-jump="'+nextDay+'">Next planned day: '+escape(WD[new Date(nextDay+"T00:00:00").getDay()]+", "+displayDate(nextDay))+' →</button>':'')+'</div>';
  return'<article id="pm-day-planner" class="pml-card pml-day"><div class="pmd-head"><div><h3>Maintenance by day</h3><p>Pick a day to see which plants and equipment are being maintained. Each morning the team gets this list as a notification.</p></div>'+
   '<div class="pmd-nav"><button type="button" class="btn o sm" data-pmd-shift="-7" aria-label="Previous week">‹</button><button type="button" class="btn o sm" data-pmd-today>Today</button><button type="button" class="btn o sm" data-pmd-shift="7" aria-label="Next week">›</button><button type="button" class="btn g sm" data-pml-action="alerts" title="Morning plan notification settings">🔔 Alerts</button></div></div>'+
   '<div class="pmd-strip" role="group" aria-label="Choose a day">'+strip+'</div>'+
   '<div class="pmd-sel"><div class="pmd-sel-h"><div><b>'+escape(WD[dt.getDay()]+", "+displayDate(day))+(day===TODAY?' · Today':'')+'</b><small>'+(shown.length?plantN+' plant'+(plantN===1?'':'s')+' · '+units+' unit'+(units===1?'':'s')+' · '+people.size+' '+(people.size===1?'person':'people'):'Nothing scheduled')+'</small></div>'+
   (types.length>1?'<div class="pmd-eq">'+['all'].concat(types).map(k=>{const n=k==="all"?dayTasks.reduce((a,t)=>a+quantity(t),0):dayTasks.filter(t=>(t.type||"Equipment")===k).reduce((a,t)=>a+quantity(t),0);return'<button type="button" class="'+(eq===k?"on":"")+'" data-pmd-equip="'+escape(k)+'">'+escape(k==="all"?"All equipment":k)+' <b>'+n+'</b></button>'}).join("")+'</div>':'')+'</div>'+
   (carried.length?'<button type="button" class="pmd-carried" data-pmd-overdue>⚠ '+carried.length+' overdue work order'+(carried.length===1?'':'s')+' from earlier days still open — show them</button>':'')+
   list+'</div></article>';
 }

 // Aggregate unit-level work orders only for presentation. Individual server-backed
 // records and their IDs remain unchanged for completion, evidence and audit trails.
 const cleanTaskName=task=>typeof pmDisplayTaskName==="function"?pmDisplayTaskName(task):String(task.name||"Preventive maintenance");
 function workGroups(tasks){
  const grouped=new Map();
  tasks.forEach(task=>{
   const name=cleanTaskName(task),cycle=task.cycleId||task.cycle_id||"";
   // The cycle groups a multi-day unit schedule. Independent legacy jobs keep their
   // original dates to avoid merging different months' maintenance into one record.
   const period=cycle||(!Number(task.unitNo)?String(task.due||"").slice(0,7):"unknown-cycle");
   const key=JSON.stringify([task.plant||"",task.type||"",name,task.freq||"",period]);
   if(!grouped.has(key))grouped.set(key,{key,plant:task.plant,type:task.type,name,freq:task.freq,tasks:[],period});
   grouped.get(key).tasks.push(task);
  });
  return[...grouped.values()].map(group=>{
   const rows=group.tasks,units=new Set(rows.filter(t=>Number(t.unitNo)>0).map(t=>Number(t.unitNo)));
   group.total=units.size?units.size:rows.reduce((sum,t)=>sum+quantity(t),0);
   group.stats=countsOf(rows);
   group.completed=units.size?new Set(rows.filter(t=>taskStatus(t)==="Done"&&Number(t.unitNo)>0).map(t=>Number(t.unitNo))).size:rows.filter(t=>taskStatus(t)==="Done").reduce((sum,t)=>sum+quantity(t),0);
   group.overdue=units.size?new Set(rows.filter(t=>taskStatus(t)==="Overdue"&&Number(t.unitNo)>0).map(t=>Number(t.unitNo))).size:rows.filter(t=>taskStatus(t)==="Overdue").reduce((sum,t)=>sum+quantity(t),0);
   group.firstDue=rows.reduce((min,t)=>!min||String(t.due||"")<min?String(t.due||""):min,"");
   group.lastDue=rows.reduce((max,t)=>String(t.due||"")>max?String(t.due||""):max,"");
   const starts=rows.map(t=>String(t.start||"")).filter(Boolean).sort();
   group.firstStart=starts[0]||"";
   group.lastStart=starts[starts.length-1]||"";
   group.assignees=[...new Set(rows.map(t=>t.assignee||"Unassigned"))];
   group.status=rows.every(t=>taskStatus(t)==="Cancelled")?"Cancelled":group.overdue?"Overdue":group.completed>=group.total?"Done":rows.some(t=>taskStatus(t)==="Due soon")?"Due soon":"Upcoming";
   return group;
  }).sort((a,b)=>a.firstDue.localeCompare(b.firstDue)||a.plant.localeCompare(b.plant)||a.type.localeCompare(b.type));
 }
 function progressBar(group){const total=Math.max(1,group.total);return'<div class="pml-unit-bar" role="img" aria-label="'+group.completed+' of '+group.total+' units completed, '+group.overdue+' overdue"><i class="done" style="width:'+Math.min(100,100*group.completed/total)+'%"></i><i class="overdue" style="width:'+Math.min(100,100*group.overdue/total)+'%"></i></div>'}
 const coverageUnit=(plant,type)=>once("coverageIndex",()=>new Map(coverageData().map(r=>[r.plant+"\u0000"+r.type,r]))).get(plant+"\u0000"+type);
 const groupToken=group=>encodeURIComponent(group.key);
 const groupByToken=token=>workGroups(scopeTasks()).find(g=>groupToken(g)===token);
 function openGroup(token){
  const group=groupByToken(token);if(!group)return;
  const inventory=coverageUnit(group.plant,group.type),configured=inventory&&inventory.units;
  const dates=new Map();group.tasks.forEach(t=>{const key=String(t.due||"Unscheduled")+"|"+taskStatus(t);const item=dates.get(key)||{date:t.due,status:taskStatus(t),units:0};item.units+=quantity(t);dates.set(key,item)});
  const daily=[...dates.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const drawer=document.createElement("div");drawer.className="pml-overlay pml-unit-drawer";
  drawer.innerHTML='<div class="pml-drawer"><header><div><b>'+escape(group.type||"Equipment")+' · '+escape(group.name)+'</b><small>'+escape(group.plant)+' · '+escape(group.freq||"Recurring")+' · '+group.total+' units in selected cycle</small></div><button aria-label="Close" data-pml-close type="button">×</button></header><div class="pml-drawer-body">'+
   '<div class="pml-card"><div class="pml-unit-metrics"><span><b>'+escape(configured===null||configured===undefined?"—":configured)+'</b><small>Registered units</small></span><span><b>'+group.total+'</b><small>Scheduled units</small></span><span><b>'+group.completed+'</b><small>Completed</small></span><span><b>'+group.overdue+'</b><small>Overdue</small></span></div>'+progressBar(group)+'<p class="pml-unit-caption">'+group.completed+' completed · '+group.overdue+' overdue · '+(group.total-group.completed-group.overdue)+' remaining in this cycle</p></div>'+
   '<div class="pml-card"><h3>Workload by day</h3><p>Combined quantities, without separate inverter/panel rows.</p>'+daily.map(row=>'<div class="pml-daily-line"><strong>'+escape(row.date?displayDate(row.date):"No date")+'</strong><span>'+row.units+' unit'+(row.units===1?'':'s')+'</span><span class="pml-badge '+row.status.toLowerCase().replace(/ /g,'-')+'">'+escape(row.status)+'</span></div>').join('')+'</div>'+
   '<div class="pml-card"><h3>Task records <small>· '+group.tasks.length+'</small></h3><p>Open a work record to complete checks, upload evidence or review history. Unit identifiers are not displayed in the main register.</p>'+group.tasks.slice().sort((a,b)=>String(a.due||"").localeCompare(String(b.due||""))).map(t=>'<div class="pml-task-row"><div><b>Start '+escape(displayDate(t.start))+' · Due '+escape(displayDate(t.due))+'</b><small>'+escape(t.assignee||"Unassigned")+' · '+escape(taskStatus(t))+'</small></div>'+(["O&M Head","Assignee"].includes(S._roleLabel||S.currentRole)&&!["Completed","Cancelled"].includes(t.status)?'<button type="button" class="btn o sm" data-pml-edit="'+escape(t.id)+'">Edit dates</button>':"")+'<button type="button" class="btn o sm" data-pml-open="'+escape(t.id)+'">Open task</button></div>').join('')+'</div></div><div class="pml-drawer-footer">'+(canAssign()&&group.tasks.some(t=>isOpen(t)&&unassigned(t))?'<button type="button" class="btn p" data-pmc-assign="'+token+'">Assign</button>':'')+'<button type="button" class="btn o" data-pml-close>Close</button></div></div>';
  drawer.onclick=event=>{if(event.target===drawer||event.target.closest('[data-pml-close]'))closeDrawer(drawer)};
  document.body.append(drawer);
 }
 /* Assign one plant's equipment group (e.g. Inverter × 15 at one plant) to a person. Each work order is saved through the
    existing per-task reassignment API, so the server keeps checking role and equipment scope and logs every change. */
 function openAssign(token){
  const group=groupByToken(token);if(!group)return;
  if(!canAssign()){toast("Only the O&M Head can assign PM work.");return}
  const open=group.tasks.filter(isOpen);
  if(!open.length){toast("Every work order in this group is already completed.");return}
  const people=(typeof TEAM_POOL!=="undefined"&&Array.isArray(TEAM_POOL)?TEAM_POOL:[]).filter(Boolean);
  const current=[...new Set(open.map(t=>unassigned(t)?"Unassigned":t.assignee))];
  const pr=plantFor(group.plant)||{};
  const drawer=document.createElement("div");drawer.className="pml-overlay pmc-assign";
  drawer.innerHTML='<div class="pml-drawer"><header><div><b>Assign '+escape(group.type||"equipment")+' × '+group.total+'</b><small>'+escape((pr.id?pr.id+" · ":"")+group.plant)+' · '+escape(group.name)+'</small></div><button type="button" aria-label="Close" data-pml-close>×</button></header>'+
   '<form class="pml-drawer-body" data-pmc-assign-form><div class="pml-card"><p><b>'+open.length+'</b> open work order'+(open.length===1?'':'s')+' · now: '+escape(current.join(", "))+'</p>'+
   (people.length?'<label>Assignee<select name="who" required>'+people.map(name=>'<option'+(current.length===1&&current[0]===name?' selected':'')+'>'+escape(name)+'</option>').join("")+'</select></label>':'<p class="pml-empty">No team member has the Assignee role yet. Add one under Team, then assign this work.</p>')+
   '<p class="pmc-note">Every work order is updated and logged separately. The server only accepts an Assignee whose equipment types include '+escape(group.type||"this equipment")+'.</p><p class="pmc-progress" role="status" aria-live="polite"></p></div>'+
   '<div class="pml-drawer-footer"><button type="button" class="btn o" data-pml-close>Cancel</button><button type="submit" class="btn p"'+(people.length?'':' disabled')+'>Assign '+open.length+' work order'+(open.length===1?'':'s')+'</button></div></form></div>';
  drawer.onclick=event=>{if(event.target===drawer||event.target.closest("[data-pml-close]"))closeDrawer(drawer)};
  drawer.querySelector("form").onsubmit=async event=>{
   event.preventDefault();
   const form=event.currentTarget,who=String(new FormData(form).get("who")||"").trim(),button=form.querySelector('button[type="submit"]'),status=form.querySelector(".pmc-progress");
   if(!who||button.disabled)return;
   button.disabled=true;form.querySelectorAll("select,[data-pml-close]").forEach(el=>{el.disabled=true});
   let saved=0,failure=null;
   for(const task of open){
    if(task.assignee===who){saved++;continue}
    status.textContent="Saving "+(saved+1)+" of "+open.length+"…";
    try{
     const row=await apiFetch("/api/scheduled/tasks/"+encodeURIComponent(task.id)+"/assignee",{method:"PATCH",body:{assignee:who}});
     const index=(S.tasks||[]).findIndex(x=>x.id===task.id);if(index>=0)S.tasks[index]=Object.assign({},S.tasks[index],row);
     saved++;
    }catch(error){failure=error;break}
   }
   if(failure){
    status.textContent="Saved "+saved+" of "+open.length+". Stopped: "+(failure.message||"the server rejected the change")+". The rest keep their current assignee.";
    form.querySelectorAll("[data-pml-close]").forEach(el=>{el.disabled=false});
    toast(saved?"Assigned "+saved+" of "+open.length+" — see the message in the dialog.":(failure.message||"Could not assign this work."));
    repaint();
    return;
   }
   closeDrawer(drawer);repaint();
   toast(open.length+" work order"+(open.length===1?"":"s")+" assigned to "+who+" and logged.");
  };
  document.body.append(drawer);
 }
 function plantDetailsHtml(){
  const f=state();if(f.plant==="all")return"";
  const rows=workGroups(currentScopeTasks()),overdue=rows.filter(g=>g.overdue),next=rows.filter(g=>g.status==="Due soon"||g.status==="Upcoming"),done=rows.filter(g=>g.status==="Done");
  const coverage=coverageData().filter(r=>r.plant===f.plant),missing=coverage.filter(r=>r.label==="Not planned"),mostLate=Math.max(0,...currentScopeTasks().map(daysLate));
  const view=f.plantTab==="next"?next:f.plantTab==="done"?done:overdue;
  return'<article class="pml-card pml-plant-focus" id="pm-plant-focus"><div class="pml-focus-top"><div><small class="pml-focus-eyebrow">PLANT WORKFORCE & EQUIPMENT HEALTH</small><h3>'+escape(f.plant)+'</h3><p>Equipment counts are combined by category and activity; no separate inverter number rows.</p></div><div class="pml-focus-metrics"><span><b>'+overdue.length+'</b>Overdue groups</span><span><b>'+mostLate+'d</b>Longest late</span><span><b>'+missing.length+'</b>Unplanned types</span><span><b>'+done.length+'</b>Completed groups</span></div></div><div class="pml-focus-tabs">'+[["late","Not maintained",overdue.length],["next","Coming up",next.length],["done","Done",done.length]].map(tab=>'<button type="button" class="'+(f.plantTab===tab[0]?"active":"")+'" data-pml-planttab="'+tab[0]+'">'+tab[1]+' <b>'+tab[2]+'</b></button>').join('')+'</div>'+
   '<div class="pml-focus-list">'+(view.length?view.slice(0,7).map(g=>'<div class="pml-focus-row"><div><b>'+escape(g.type)+' × '+g.total+'</b><small>'+escape(g.name)+' · '+escape(g.freq||"Recurring")+'</small></div><div>'+progressBar(g)+'<small>'+g.completed+' completed · '+g.overdue+' overdue</small></div><button class="btn o sm" type="button" data-pml-group="'+groupToken(g)+'">View work</button></div>').join(''):'<div class="pml-empty">No equipment groups in this category.</div>')+'</div>'+
   (missing.length?'<div class="pml-focus-warning"><b>'+missing.length+' equipment type(s) need a PM job:</b> '+escape(missing.map(x=>x.type).slice(0,8).join(', '))+(missing.length>8?'…':'')+'</div>':'')+'</article>';
 }
 const percent=(count,total)=>Math.round(100*count/Math.max(1,total));
 const stacked=tasks=>{
  const counts=countsOf(tasks),total=tasks.length||1;
  return'<span class="pml-stack">'+["Done","Upcoming","Due soon","Overdue"].map(key=>counts[key]?'<i title="'+escape(key)+": "+counts[key]+'" style="width:'+percent(counts[key],total)+'%;background:'+COLORS[key]+'"></i>':"").join("")+'</span>';
 };
 const displayDate=value=>value&&typeof fmtD==="function"?fmtD(value):value||"—";
 const jsArg=value=>escape(JSON.stringify(value));
 const filterButton=(key,title,count,color)=>'<button type="button" class="pml-stat'+(state().status===key?" active":"")+'" style="--pml-accent:'+color+'" data-pml-status="'+escape(key)+'"><b>'+count+'</b><span>'+title+'</span></button>';
 const weekName=week=>week===-1?"Last week":week===0?"This week":week<0?Math.abs(week)+" weeks ago":"In "+week+" week"+(week===1?"":"s");

 const VIEWS=[["overview","Overview","What needs attention now"],["schedule","Calendar","Upcoming work, day by day"],["plants","Plants","Every plant against every equipment type"],["coverage","Coverage","Registered units and their PM jobs"],["register","Work register","Search, filter, assign and edit work"]];
 function tabsHtml(view,badges){
  return'<nav class="pmv-tabs" role="tablist" aria-label="Preventive maintenance views">'+VIEWS.map(([key,label,hint])=>{const b=badges[key];
   return'<button type="button" role="tab" aria-selected="'+(view===key)+'" class="pmv-tab'+(view===key?' on':'')+'" data-pmv-view="'+key+'" title="'+escape(hint)+'"><span>'+label+'</span>'+(b&&b.n?'<b class="'+(b.tone||'')+'">'+Number(b.n).toLocaleString("en-IN")+(b.label?' '+b.label:'')+'</b>':'')+'</button>'}).join('')+'</nav>';
 }
 /* "+ Add job" with the chosen day as the start date (the form keeps its own plant / equipment prefill) */
 function addJobOn(day){
  if(typeof openProblemScheduledTask!=="function")return;
  Promise.resolve(openProblemScheduledTask()).then(()=>{
   const set=()=>{const el=document.getElementById("pq-due");if(!el)return false;el.value=day;el.dispatchEvent(new Event("input",{bubbles:true}));return true};
   if(!set())setTimeout(set,60);
  });
 }
 const shortDay=d=>{const dt=new Date(d+"T00:00:00");return WD[dt.getDay()]+" "+dt.getDate()};
 /* Upcoming 7 days: what is planned each day, in one line per day */
 function upcomingHtml(tasks,canCreate){
  const days=Array.from({length:7},(_,i)=>addDays(TODAY,i)),first=days[0],last=days[6];
  const stat=new Map(days.map(d=>[d,{units:0,open:0,done:0,plants:new Set(),types:new Map()}]));
  tasks.forEach(t=>{
   if(!t.due||t.due<first)return;const s0=t.start&&t.start<=t.due?t.start:t.due;if(s0>last)return;
   const st=taskStatus(t),q=quantity(t);
   for(let d=s0<first?first:s0,guard=0;d<=t.due&&d<=last&&guard<8;d=addDays(d,1),guard++){
    const c=stat.get(d);if(!c)continue;c.units+=q;c.plants.add(t.plant);if(st==="Done")c.done+=q;else c.open+=q;
    const type=t.type||"Equipment";c.types.set(type,(c.types.get(type)||0)+q);
   }
  });
  const carried=tasks.filter(t=>taskStatus(t)==="Overdue").length,max=Math.max(1,...days.map(d=>stat.get(d).units));
  const rows=days.map(d=>{const c=stat.get(d),types=[...c.types.entries()].sort((a,b)=>b[1]-a[1]),pct=c.units?Math.round(100*c.done/c.units):0;
   return'<button type="button" class="pmu-row'+(d===TODAY?' today':'')+(c.units?'':' empty')+'" data-pmup-day="'+d+'" title="Open '+escape(displayDate(d))+' in the calendar">'+
    '<span class="pmu-date"><small>'+(d===TODAY?'Today':d===addDays(TODAY,1)?'Tmrw':WD[new Date(d+"T00:00:00").getDay()])+'</small><b>'+new Date(d+"T00:00:00").getDate()+'</b></span>'+
    '<span class="pmu-main">'+(c.units?'<b>'+c.units.toLocaleString("en-IN")+' unit'+(c.units===1?'':'s')+' · '+c.plants.size+' plant'+(c.plants.size===1?'':'s')+'</b><small>'+types.slice(0,3).map(([k,n])=>escape(k)+' ×'+n).join(' · ')+(types.length>3?' · +'+(types.length-3)+' more':'')+'</small>':'<b class="pmu-none">Nothing planned</b>')+'</span>'+
    '<span class="pmu-load" aria-hidden="true"><i style="width:'+(c.units?Math.max(6,Math.round(100*c.units/max)):0)+'%"></i></span>'+
    '<span class="pmu-pct">'+(c.units?(pct===100?'<em class="ok">✓ done</em>':pct+'% done'):'')+'</span></button>'}).join('');
  return'<article class="gx-card pmu-card"><header class="pmu-head"><div><h3>Upcoming 7 days</h3><p>Units planned each day · click a day for the full list</p></div><div class="pmu-actions">'+
   (canCreate?'<button type="button" class="btn o sm" data-pm-addon="'+addDays(TODAY,1)+'">+ Plan job</button>':'')+'<button type="button" class="btn g sm" data-pmv-view="schedule">Calendar →</button></div></header>'+
   (carried?'<button type="button" class="pmu-carried" data-pml-status="Overdue">⚠ '+carried+' overdue work order'+(carried===1?'':'s')+' from earlier days are still open</button>':'')+
   '<div class="pmu-list">'+rows+'</div></article>';
 }
 /* Month calendar: workload per day as a heat map; overdue days are marked; pick a day for its work list */
 function calendarHtml(tasks,canCreate){
  const f=state(),month=/^\d{4}-\d{2}$/.test(f.calMonth||"")?f.calMonth:TODAY.slice(0,7),first=month+"-01";
  const lead=(new Date(first+"T00:00:00").getDay()+6)%7,gridStart=addDays(first,-lead),cells=Array.from({length:42},(_,i)=>addDays(gridStart,i)),gridEnd=cells[41];
  const stat=new Map(cells.map(d=>[d,{units:0,done:0,late:0,plants:new Set()}]));
  tasks.forEach(t=>{
   if(!t.due||t.due<gridStart)return;const s0=t.start&&t.start<=t.due?t.start:t.due;if(s0>gridEnd)return;
   const st=taskStatus(t),q=quantity(t);
   for(let d=s0<gridStart?gridStart:s0,guard=0;d<=t.due&&d<=gridEnd&&guard<43;d=addDays(d,1),guard++){const c=stat.get(d);if(!c)continue;c.units+=q;c.plants.add(t.plant);if(st==="Done")c.done+=q}
   if(st==="Overdue"){const c=stat.get(t.due);if(c)c.late+=1}
  });
  const max=Math.max(1,...cells.map(d=>stat.get(d).units)),day=f.day||TODAY,title=new Date(first+"T00:00:00").toLocaleDateString("en-GB",{month:"long",year:"numeric"});
  const monthUnits=cells.filter(d=>d.slice(0,7)===month).reduce((n,d)=>n+stat.get(d).units,0),monthLate=cells.filter(d=>d.slice(0,7)===month).reduce((n,d)=>n+stat.get(d).late,0);
  const grid=cells.map(d=>{const c=stat.get(d),lv=c.units?Math.max(.12,c.units/max):0,pct=c.units?Math.round(100*c.done/c.units):0;
   return'<button type="button" class="pmcal-cell'+(d.slice(0,7)!==month?' out':'')+(d===TODAY?' today':'')+(d===day?' on':'')+(c.units?' has':'')+(c.late?' late':'')+'" style="--lv:'+lv.toFixed(2)+'" data-pmcal-day="'+d+'" aria-pressed="'+(d===day)+'" title="'+escape(displayDate(d))+': '+c.units+' unit(s) at '+c.plants.size+' plant(s)'+(c.late?' · '+c.late+' overdue':'')+(c.units?' · '+pct+'% done':'')+'">'+
    '<span class="pmcal-n">'+new Date(d+"T00:00:00").getDate()+'</span>'+(c.late?'<em>'+c.late+' late</em>':'')+
    (c.units?'<b>'+c.units.toLocaleString("en-IN")+'</b><small>'+c.plants.size+' plant'+(c.plants.size===1?'':'s')+'</small><i class="pmcal-done" style="width:'+pct+'%"></i>':'')+'</button>'}).join('');
  return'<article class="pml-card pmcal" id="pm-calendar"><div class="pmcal-head"><div><h3>'+escape(title)+'</h3><p>'+monthUnits.toLocaleString("en-IN")+' units planned this month'+(monthLate?' · <b class="late">'+monthLate+' overdue</b>':'')+'. Darker = more work that day. Pick a day to see its plants and equipment below.</p></div>'+
   '<div class="pmcal-nav"><button type="button" class="btn o sm" data-pmcal-shift="-1" aria-label="Previous month">‹</button><button type="button" class="btn o sm" data-pmcal-today>Today</button><button type="button" class="btn o sm" data-pmcal-shift="1" aria-label="Next month">›</button>'+
   (canCreate?'<button type="button" class="btn p sm" data-pm-addon="'+escape(day<TODAY?TODAY:day)+'">+ Plan job on '+escape(shortDay(day<TODAY?TODAY:day))+'</button>':'')+'</div></div>'+
   '<div class="pmcal-grid" role="grid" aria-label="'+escape(title)+'">'+["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(w=>'<span class="pmcal-wd" role="columnheader">'+w+'</span>').join('')+grid+'</div>'+
   (S.tasksHistoryFrom&&gridStart<S.tasksHistoryFrom?'<p class="pmcal-note">Finished work before '+escape(displayDate(S.tasksHistoryFrom))+' is not loaded on this page; open work is. <b>More → Export compliance</b> has the full history.</p>':'')+
   '<div class="pmcal-legend"><span><i class="lv1"></i>Light day</span><span><i class="lv3"></i>Busy day</span><span><i class="late"></i>Overdue work due that day</span><span><i class="done"></i>Share done</span></div></article>';
 }
 /* Plants × equipment: one row per plant, one cell per equipment type, coloured by the most urgent state */
 const TYPE_ORDER=["Inverter","ACCB Panel","VCB Panel","Transformer","Aux. Transformer","ACDB","4 Pole","Earthing","Miscellaneous","Transmission line","VCB - GSS side","4 Pole - GSS side","Transmission line - GSS side"];
 const typeRank=t=>{const i=TYPE_ORDER.indexOf(t);return i<0?TYPE_ORDER.length:i};
 function matrixHtml(tasks){
  const f=state(),types=[...new Set(tasks.map(t=>t.type).filter(Boolean))].sort((a,b)=>typeRank(a)-typeRank(b)||a.localeCompare(b));
  const rows=new Map(scopedPlants().map(p=>[p.name,{plant:p,cells:new Map(),late:0,soon:0,open:0,done:0,oldest:0}]));
  tasks.forEach(t=>{
   const row=rows.get(t.plant);if(!row||!t.type)return;
   let c=row.cells.get(t.type);if(!c)row.cells.set(t.type,c={late:0,soon:0,open:0,done:0,oldest:0});
   const st=taskStatus(t);
   if(st==="Done"){c.done++;row.done++;return}
   c.open++;row.open++;
   if(st==="Overdue"){c.late++;row.late++;const l=daysLate(t);if(l>c.oldest)c.oldest=l;if(l>row.oldest)row.oldest=l}
   else if(st==="Due soon"){c.soon++;row.soon++}
  });
  const all=[...rows.values()];
  const tally={late:all.filter(r=>r.late).length,soon:all.filter(r=>!r.late&&r.soon).length,ok:all.filter(r=>!r.late&&!r.soon&&(r.open||r.done)).length,none:all.filter(r=>!r.open&&!r.done).length};
  const q=String(f.mxQuery||"").trim().toLowerCase();
  let list=all.filter(r=>(!q||(r.plant.name+" "+(r.plant.id||"")).toLowerCase().includes(q))&&
   (f.mxShow==="late"?r.late:f.mxShow==="soon"?!r.late&&r.soon:f.mxShow==="ok"?!r.late&&!r.soon&&(r.open||r.done):f.mxShow==="none"?!r.open&&!r.done:true));
  const code=r=>String(r.plant.id||r.plant.name);
  list.sort(f.mxSort==="name"?(a,b)=>code(a).localeCompare(code(b)):f.mxSort==="open"?(a,b)=>b.open-a.open||code(a).localeCompare(code(b)):(a,b)=>b.late-a.late||b.oldest-a.oldest||b.soon-a.soon||code(a).localeCompare(code(b)));
  const LIMIT=30,shown=f.mxAll?list:list.slice(0,LIMIT);
  const cell=(r,type)=>{const c=r.cells.get(type);
   if(!c)return'<td class="pmm-c none"><span title="'+escape(r.plant.name+' · '+type+': no PM job')+'"></span></td>';
   const cls=c.late?"late":c.soon?"soon":c.open?"open":"done",label=c.late?c.late:c.soon?c.soon:c.open?c.open:"✓";
   return'<td class="pmm-c '+cls+'"><button type="button" data-pmm-cell="'+escape(r.plant.name)+'|'+escape(type)+'" title="'+escape(r.plant.name+' · '+type+': '+c.late+' overdue'+(c.oldest?' (oldest '+c.oldest+' d)':'')+' · '+c.soon+' due this week · '+c.open+' open · '+c.done+' done — open in the register')+'">'+label+'</button></td>'};
  const chip=(key,label,n,tone)=>'<button type="button" class="pmm-chip '+tone+(f.mxShow===key?' on':'')+'" data-pmm-show="'+key+'" aria-pressed="'+(f.mxShow===key)+'"><b>'+n+'</b>'+label+'</button>';
  const body=shown.map(r=>{const total=r.open+r.done,pct=total?Math.round(100*r.done/total):0;
   return'<tr class="'+(r.late?'late':'')+'"><th scope="row"><button type="button" class="pml-link" data-pmm-plant="'+escape(r.plant.name)+'" title="Focus this plant"><b>'+escape(r.plant.id||"")+'</b><small>'+escape(r.plant.name)+'</small></button></th>'+
    types.map(type=>cell(r,type)).join('')+
    '<td class="pmm-sum">'+(total?'<span class="pmm-bar"><i style="width:'+pct+'%"></i></span><small>'+(r.late?'<b class="late">'+r.late+' late</b> · '+r.oldest+' d':r.soon?'<b class="soon">'+r.soon+' this week</b>':pct+'% done')+'</small>':'<small class="pmx-muted">No PM jobs</small>')+'</td></tr>'}).join('');
  return'<article class="pml-card pmm" id="pm-matrix"><div class="pmm-head"><div><h3>Plants × equipment</h3><p>Every plant against every equipment type. The number is the work orders in that state; click a cell to open those jobs in the register.</p></div></div>'+
   '<div class="pmm-chips" role="group" aria-label="Filter plants">'+chip("late","with overdue work",tally.late,"late")+chip("soon","due this week",tally.soon,"soon")+chip("ok","on track",tally.ok,"ok")+chip("none","without PM jobs",tally.none,"none")+'</div>'+
   '<div class="pmm-tools"><input type="search" class="pmm-search" placeholder="Find plant name or code…" value="'+escape(f.mxQuery||"")+'" data-pml-input="mx-query" aria-label="Find a plant">'+
   '<select aria-label="Sort plants" data-pml-select="mxSort">'+[["late","Sort: most overdue"],["name","Sort: plant code"],["open","Sort: most open work"]].map(([k,l])=>'<option value="'+k+'"'+(f.mxSort===k?' selected':'')+'>'+l+'</option>').join('')+'</select>'+
   '<span class="pmm-count">'+list.length+' of '+all.length+' plants</span></div>'+
   (types.length&&list.length?'<div class="pmm-scroll"><table class="pmm-table"><thead><tr><th scope="col" class="pmm-ph">Plant</th>'+types.map(type=>'<th scope="col" class="pmm-th"><span title="'+escape(type)+'">'+escape(type)+'</span></th>').join('')+'<th scope="col" class="pmm-ph">Progress</th></tr></thead><tbody>'+body+'</tbody></table></div>'+
    (list.length>LIMIT?'<div class="pmd-more"><span>Showing '+shown.length+' of '+list.length+' plants</span><button type="button" class="btn o sm" data-pmm-all>'+(f.mxAll?'Show fewer':'Show all '+list.length)+'</button></div>':'')
    :'<div class="pml-empty">'+(types.length?'No plant matches this search or filter.':'No PM work orders in this scope yet. Use + Add job or Upload plan.')+'</div>')+
   '<div class="pmcal-legend"><span><i class="late"></i>Overdue</span><span><i class="soon"></i>Due this week</span><span><i class="open"></i>Planned</span><span><i class="done"></i>All done</span><span><i class="none"></i>No PM job</span></div></article>';
 }

 function render(){
  memo=new Map();
  try{return renderPage()}finally{memo=null}
 }
 function renderPage(){
  loadUnitCoverage(false);
  const f=state(),tasks=currentScopeTasks(),selected=filteredTasks(),visibleGroups=workGroups(selected),allGroups=workGroups(tasks),counts=countsOf(tasks);
  const overdue=tasks.filter(task=>taskStatus(task)==="Overdue"),dueSoon=tasks.filter(task=>taskStatus(task)==="Due soon"),done=tasks.filter(task=>taskStatus(task)==="Done");
  const onTime=done.filter(task=>task.completion&&Number(task.completion.delay||task.delayDays||0)<=0);
  const onTimePercent=done.length?percent(onTime.length,done.length):0;
  const configuredTypes=unitLoaded&&!unitError?coverageData().map(row=>row.type):[];
  const equipmentTypes=[...new Set(tasks.map(task=>task.type).concat(configuredTypes).filter(Boolean))].sort();
  const todayOpen=tasks.filter(task=>isOpen(task)&&onDay(task,TODAY)),noOwner=tasks.filter(task=>isOpen(task)&&unassigned(task));
  const plantsOf=list=>new Set(list.map(task=>task.plant).filter(Boolean)).size;
  const byPlant=new Map();tasks.forEach(task=>{let list=byPlant.get(task.plant);if(!list)byPlant.set(task.plant,list=[]);list.push(task)});
  const plantRows=(S.plants||[]).map(plant=>{
   const jobs=byPlant.get(plant.name)||[],late=jobs.filter(task=>taskStatus(task)==="Overdue");
   const next=jobs.filter(task=>isOpen(task)&&task.due&&task.due>=TODAY).map(task=>task.due).sort()[0]||"";
   return{plant,jobs,overdue:late.length,oldest:Math.max(0,...late.map(daysLate)),soon:jobs.filter(task=>taskStatus(task)==="Due soon").length,noOwner:jobs.filter(task=>isOpen(task)&&unassigned(task)).length,next};
  }).filter(row=>row.jobs.length).sort((a,b)=>b.overdue-a.overdue||b.oldest-a.oldest||b.soon-a.soon||String(a.next||"9").localeCompare(String(b.next||"9"))||a.plant.name.localeCompare(b.plant.name));
  const ageBands=[[1,2,"1–2 days"],[3,6,"3–6 days"],[7,13,"1–2 weeks"],[14,99999,"2+ weeks"]];
  const ageCounts=ageBands.map(band=>overdue.filter(task=>daysLate(task)>=band[0]&&daysLate(task)<=band[1]).length);
  const weekRows=Array.from({length:9},(_,i)=>i-3).map(week=>{
   const jobs=tasks.filter(task=>task.due&&Math.floor((dueOffset(task)||0)/7)===week);
   return{week,jobs,counts:countsOf(jobs)};
  }),weekMax=Math.max(1,...weekRows.map(row=>row.jobs.length));
  const lateOf=group=>Math.max(0,...group.tasks.filter(isOpen).map(daysLate));
  if(f.sort==="late")visibleGroups.sort((a,b)=>b.overdue-a.overdue||lateOf(b)-lateOf(a)||a.firstDue.localeCompare(b.firstDue));
  else if(f.sort==="plant")visibleGroups.sort((a,b)=>String(a.plant).localeCompare(String(b.plant))||a.firstDue.localeCompare(b.firstDue));
  else if(f.sort==="equipment")visibleGroups.sort((a,b)=>String(a.type).localeCompare(String(b.type))||String(a.plant).localeCompare(String(b.plant)));
  const pages=Math.max(1,Math.ceil(visibleGroups.length/PAGE));if(f.page>pages)f.page=pages;
  const peopleList=[...new Set(tasks.map(task=>task.assignee).filter(name=>name&&!unassigned({assignee:name})))].sort();
  const statuses=["Done","Upcoming","Due soon","Overdue"],total=tasks.length||1,circumference=2*Math.PI*47;
  let offset=0;
  const donut='<svg viewBox="0 0 120 120" role="img" aria-label="Preventive maintenance task status"><circle cx="60" cy="60" r="47" fill="none" stroke="var(--pml-sub)" stroke-width="15"/>'+statuses.map(key=>{
   const n=counts[key]||0,length=n/total*circumference;
   const circle=n?'<circle cx="60" cy="60" r="47" fill="none" stroke="'+COLORS[key]+'" stroke-width="15" stroke-dasharray="'+Math.max(0,length-2)+' '+circumference+'" stroke-dashoffset="'+(-offset)+'" transform="rotate(-90 60 60)"><title>'+escape(key)+': '+n+'</title></circle>':"";
   offset+=length;return circle;
  }).join("")+'<text x="60" y="56" text-anchor="middle">'+tasks.length+'</text><text x="60" y="72" text-anchor="middle">work orders</text></svg>';
  const selectedPlant=plantFor(f.plant),plantLabel=f.plant==="all"?"All plants ("+scopedPlants().length+")":(selectedPlant&&selectedPlant.id?selectedPlant.id+" · ":"")+f.plant;
  const role=S._roleLabel||S.currentRole||"",canCreate=["O&M Head","Assignee","Administration"].includes(role);
  const plantPicker=f.plantOpen?'<div class="pml-picker-menu"><input id="pml-plant-search" placeholder="Search plants…" value="'+escape(f.plantQuery)+'" data-pml-input="plant-search"><div><button type="button" data-pml-plant="all">All plants <small>'+tasks.length+' active jobs</small></button>'+
   scopedPlants().filter(plant=>(plant.name+" "+plant.id).toLowerCase().includes(f.plantQuery.toLowerCase())).map(plant=>'<button type="button" data-pml-plant="'+escape(plant.name)+'">'+escape(plant.id||"")+' '+escape(plant.name)+'<small>'+(byPlant.get(plant.name)||[]).filter(task=>taskStatus(task)==="Overdue").length+' overdue</small></button>').join("")+'</div></div>':"";
  const item=(attrs,title,note)=>'<button type="button" role="menuitem" '+attrs+'><b>'+title+'</b>'+(note?'<small>'+note+'</small>':'')+'</button>';
  const link=(href,title,note)=>'<a role="menuitem" href="'+href+'" download><b>'+title+'</b><small>'+note+'</small></a>';
  /* the PM plan import is O&M Head only on the server (PLANNER_ROLES); Administration is read-only */
  const uploadButton=role==="O&M Head"&&typeof pmImportPick==="function"?'<details class="pmc-menu"><summary class="btn o sm">Upload plan <span aria-hidden="true">▾</span></summary><div class="pmc-menu-list" role="menu">'+
   item('onclick="pmImportPick()"',"Upload Excel / CSV plan","Checked first (dry run), then you confirm")+'<span class="pmc-menu-label">Templates</span>'+
   link("/static/templates/PM_Plant_Side_Template.xlsx","Plant side Excel","Inverter, ACCB, VCB, IDT, Aux. Transformer + ACDB, 4 Pole, Earthing, Miscellaneous, Transmission line")+
   link("/static/templates/PM_GSS_Side_Template.xlsx","GSS side Excel","VCB, 4 Pole and Transmission line on the GSS side")+
   link("/static/templates/PM_Task_Plan_Template.xlsx","General plan Excel","Any equipment, each row with its own start date")+
   item('onclick="pmDownloadCsvTemplate()"',"CSV template","Header row for a CSV upload")+'</div></details>':"";
  const moreMenu='<details class="pmc-menu pmc-menu-end"><summary class="btn o sm">More <span aria-hidden="true">▾</span></summary><div class="pmc-menu-list" role="menu">'+
   (canCreate&&typeof pmOpenUnitCfg==="function"?item('onclick="pmOpenUnitCfg()"',"Unit counts","How many of each equipment every plant has"):'')+
   item('data-pml-action="alerts"',"Alerts","Which PM events notify you, in-app or by email")+
   item('onclick="exportScheduledOMCompliance()"',"Export compliance","Excel report of PM work")+item('onclick="window.print()"',"Print / PDF","")+'</div></details>';
  const addButton=canCreate?'<button type="button" class="btn p sm" onclick="openProblemScheduledTask()">+ Add job</button>':"";
  /* ---- "At a glance" overview: every card, slice, column and bar filters the register and scrolls to it ---- */
  const G=window.s91Glance;
  const upcomingN=counts.Upcoming||0,scopePlantN=new Set(tasks.map(t=>t.plant).filter(Boolean)).size;
  const onSchedule=tasks.length?percent(tasks.length-overdue.length,tasks.length):100;
  const scoreColor=onSchedule>=90?"#4ADE80":onSchedule>=70?"#FBBF24":"#F87171";
  const kp=(key,label,n,note,color)=>kpiTile(label,n,note,color,'data-pml-status="'+escape(key)+'"',{on:f.status===key,pct:percent(n,tasks.length)});
  const shortWeek=w=>w===0?"Now":w===1?"Next":w===-1?"Last":(w>0?"+":"−")+Math.abs(w)+"w";
  const AGE_TONE=["#F59E0B","#F97316","#EA580C","#DC2626"];
  const ageIdx=f.age==="all"?-1:ageBands.findIndex(band=>band[0]===f.age[0]);
  const ageMax=Math.max(1,...ageCounts);
  const eqRows=equipmentTypes.map(type=>{const rows=tasks.filter(task=>task.type===type),late=rows.filter(task=>taskStatus(task)==="Overdue").length,doneN=rows.filter(task=>taskStatus(task)==="Done").length;return{type,rows,late,doneN}}).sort((x,y)=>y.late-x.late||y.rows.length-x.rows.length||x.type.localeCompare(y.type));
  const miniRing=(value,color)=>{const R=15,C=2*Math.PI*R,v=Math.max(0,Math.min(100,value));return'<svg class="gx-mini-ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="'+R+'" class="t"/><circle cx="20" cy="20" r="'+R+'" class="v" stroke="'+color+'" stroke-dasharray="'+(v/100*C).toFixed(1)+' '+C.toFixed(1)+'" transform="rotate(-90 20 20)"/><text x="20" y="23.5" text-anchor="middle">'+Math.round(v)+'%</text></svg>'};
  const heroHtml='<div class="gx-hero gx-hero-pm"><div class="gx-hero-copy"><span class="gx-eyebrow">PREVENTIVE MAINTENANCE · AT A GLANCE</span><span class="gx-info" tabindex="0" title="Planned vs. unplanned: use this module for recurring work and washing. If execution reveals a fault, convert the completed task into a linked O&amp;M Issue.">ⓘ Planned vs. unplanned</span><h2>'+escape(f.plant==="all"?"Portfolio overview":f.plant)+'</h2><p>'+(overdue.length?'<b class="gx-hot">'+overdue.length+' work order'+(overdue.length===1?'':'s')+' overdue</b>':'<b>Nothing overdue</b>')+' · '+dueSoon.length+' due this week · '+tasks.length+' active records'+(f.plant==="all"?' across '+scopePlantN+' plant'+(scopePlantN===1?'':'s'):'')+'</p>'+
   '<div class="pmc-hero-actions">'+
    (overdue.length?'<button type="button" class="pmc-pill hot" data-pml-status="Overdue"><b>'+overdue.length+'</b> overdue at '+plantsOf(overdue)+' plant'+(plantsOf(overdue)===1?'':'s')+' · oldest '+Math.max(0,...overdue.map(daysLate))+' d <span>Show →</span></button>':'')+
    (todayOpen.length?'<button type="button" class="pmc-pill" data-pml-focus="today"><b>'+todayOpen.reduce((n,task)=>n+quantity(task),0)+'</b> units on today’s plan · '+plantsOf(todayOpen)+' plant'+(plantsOf(todayOpen)===1?'':'s')+' <span>Show →</span></button>':'')+
    (noOwner.length?'<button type="button" class="pmc-pill warn" data-pml-focus="unassigned"><b>'+noOwner.length+'</b> open work order'+(noOwner.length===1?'':'s')+' with no assignee <span>'+(canAssign()?'Assign →':'Show →')+'</span></button>':'')+
    (!overdue.length&&!noOwner.length?'<span class="pmc-pill ok">✓ Nothing late and every open job has an owner</span>':'')+'</div></div>'+
   '<div class="gx-hero-score">'+(G?G.scoreRing(onSchedule,scoreColor):'')+'<div><b>'+onSchedule+'%</b><small>on schedule</small><span>'+done.length+' completed · '+onTimePercent+'% on time</span></div></div></div>';
  const kf=(key,label,n,note,color)=>kpiTile(label,n,note,color,'data-pml-focus="'+key+'"',{on:f.focus===key,pct:percent(n,tasks.length)});
  const kpiHtml='<div class="gx-kpis pmc-kpis">'+
   kp("Overdue","Overdue",overdue.length,overdue.length?"past due date · act now":"nothing past due","var(--danger)")+
   kf("today","Due today",todayOpen.length,todayOpen.length?"open on today’s plan · "+plantsOf(todayOpen)+" plant"+(plantsOf(todayOpen)===1?"":"s"):"nothing planned today","var(--primary)")+
   kp("Due soon","Due this week",dueSoon.length,"due in the next 7 days","var(--warning)")+
   kf("unassigned","Unassigned",noOwner.length,noOwner.length?"open work with no owner":"every open job has an owner","var(--status-violet)")+
   kp("Done","Completed",done.length,(S.tasksHistoryFrom?"since "+displayDate(S.tasksHistoryFrom)+" · ":"")+onTimePercent+"% on time · "+upcomingN+" upcoming","var(--success)")+'</div>';
  const donutHtml=G?G.donut({title:"Where the jobs stand",sub:"Click a slice to list those work orders",noun:"work orders",attr:"data-pml-status",active:f.status,slices:[{key:"Overdue",label:"Overdue",n:overdue.length,color:COLORS.Overdue},{key:"Due soon",label:"Due this week",n:dueSoon.length,color:COLORS["Due soon"]},{key:"Upcoming",label:"Upcoming",n:upcomingN,color:COLORS.Upcoming},{key:"Done",label:"Completed",n:done.length,color:COLORS.Done}]}):'';
  const weeksHtml='<article class="gx-card"><header><h3>Jobs by due week</h3><p>Three weeks back to five ahead · click a week</p></header><div class="gx-cols">'+weekRows.map(row=>'<button type="button" class="gx-col'+(f.week===row.week?' on':'')+(row.week===0?' now':'')+(row.week<0?' past':'')+'" data-pml-week="'+row.week+'" title="'+escape(weekName(row.week))+': '+row.jobs.length+' job'+(row.jobs.length===1?'':'s')+(row.counts.Overdue?' · '+row.counts.Overdue+' overdue':'')+'"><b>'+row.jobs.length+'</b><span class="gx-col-bar">'+["Done","Upcoming","Due soon","Overdue"].map(key=>row.counts[key]?'<i style="height:'+Math.max(4,Math.round(row.counts[key]/weekMax*108))+'px;background:'+COLORS[key]+'"></i>':'').join('')+'</span><small>'+shortWeek(row.week)+'</small></button>').join('')+'</div><div class="gx-mini-legend">'+["Overdue","Due soon","Upcoming","Done"].map(key=>'<span><i style="background:'+COLORS[key]+'"></i>'+(key==="Due soon"?"Due this week":key==="Done"?"Completed":key)+'</span>').join('')+'</div></article>';
  const ageHtml='<article class="gx-card"><header><h3>How late is overdue work?</h3><p>Days past due · work turns critical after 7 days</p></header>'+(overdue.length?'<div class="gx-hbars">'+ageBands.map((band,i)=>'<button type="button" class="gx-hbar'+(ageIdx===i?' on':'')+(ageIdx>=0&&ageIdx!==i?' dim':'')+'" style="--c:'+AGE_TONE[i]+'" data-pml-age="'+i+'"><span>'+band[2]+'</span><i><b style="width:'+Math.max(ageCounts[i]?6:0,percent(ageCounts[i],ageMax))+'%"></b></i><strong>'+ageCounts[i]+'</strong></button>').join('')+'</div>':'<div class="gx-allclear"><span>✓</span><b>No overdue work</b><small>Every open job in this scope is within its due date.</small></div>')+'</article>';
  const eqHtml='<article class="gx-card gx-eq-card"><header><h3>By equipment</h3><p>Completion ring and overdue count · click to filter</p></header>'+(eqRows.length?'<div class="gx-eq-grid">'+eqRows.map(r=>'<button type="button" class="gx-eq'+(f.equipment===r.type?' on':'')+(r.late?' late':'')+'" data-pml-equipment="'+escape(r.type)+'">'+miniRing(percent(r.doneN,r.rows.length),r.late?COLORS.Overdue:COLORS.Done)+'<span class="gx-eq-copy"><b>'+escape(r.type)+'</b><small>'+(r.rows.length?r.rows.length+' job'+(r.rows.length===1?'':'s'):'No PM job scheduled')+'</small></span>'+(r.late?'<em>'+r.late+' late</em>':'<em class="ok">on track</em>')+'</button>').join('')+'</div>':'<div class="pml-empty">No equipment work orders in this scope.</div>')+'</article>';
  const leadShown=f.leadAll?plantRows:plantRows.slice(0,6);
  const leadRight=row=>row.overdue?row.overdue+' overdue<small>'+row.oldest+' d oldest</small>':row.soon?'<span class="soon">'+row.soon+' due this week</span><small>'+(row.next?'next '+escape(displayDate(row.next)):'')+'</small>':'On track<small>'+(row.next?'next due '+escape(displayDate(row.next)):'no open work')+'</small>';
  const leaderHtml=f.plant==="all"?'<article class="gx-card gx-leader'+(f.leadAll?' pmc-lead-all':'')+'"><header><h3>Plants needing attention</h3><p>Overdue first, then work due this week · click a plant to focus it</p></header><div class="pmc-lead-list">'+(plantRows.length?leadShown.map((row,i)=>'<button type="button" class="gx-lead-row'+(row.overdue?' late':'')+'" data-pml-plant="'+escape(row.plant.name)+'"><i>'+(i+1)+'</i><span class="gx-lead-name"><b>'+escape(row.plant.name)+'</b><small>'+escape(row.plant.id||"")+' · '+row.jobs.length+' job'+(row.jobs.length===1?'':'s')+(row.noOwner?' · <em class="pmc-noowner">'+row.noOwner+' unassigned</em>':'')+'</small></span>'+stacked(row.jobs)+'<strong>'+leadRight(row)+'</strong></button>').join(''):'<div class="pml-empty">No plants have scheduled PM tasks yet.</div>')+'</div>'+
   (plantRows.length>6?'<button type="button" class="pmc-lead-more" data-pmc-leadall>'+(f.leadAll?'Show top 6':'Show all '+plantRows.length+' plants')+'</button>':'')+'</article>':'';
  const glanceHtml='<div class="gx-glance">'+heroHtml+kpiHtml+'</div>';
  const focusChips=[];
  if(f.status!=="all")focusChips.push({label:"Status: "+(f.status==="Due soon"?"Due this week":f.status==="Done"?"Completed":f.status),color:COLORS[f.status]||"#64748B",attr:'data-pml-status="'+escape(f.status)+'"'});
  if(f.week!=="all")focusChips.push({label:"Due: "+weekName(f.week),color:"#0F5C2E",attr:'data-pml-week="'+f.week+'"'});
  if(ageIdx>=0)focusChips.push({label:"Late: "+ageBands[ageIdx][2],color:AGE_TONE[ageIdx],attr:'data-pml-age="'+ageIdx+'"'});
  if(f.equipment!=="all")focusChips.push({label:"Equipment: "+f.equipment,color:"#3B82F6",attr:'data-pml-equipment="'+escape(f.equipment)+'"'});
  if(f.focus!=="all")focusChips.push({label:f.focus==="today"?"On today’s plan":"No assignee",color:f.focus==="today"?"#0F5C2E":"#8B5CF6",attr:'data-pml-focus="'+escape(f.focus)+'"'});
  if(f.person!=="all")focusChips.push({label:"Assignee: "+(f.person==="__none"?"Unassigned":f.person),color:"#475569",attr:'data-pml-select-clear="person"'});
  const focusBarHtml=G?G.focusBar(focusChips,'data-pml-action="clear"'):'';
  const toolbarHtml=
   '<div class="pml-toolbar"><div class="pml-brand"><span class="pml-mark">PM</span><div><b>Preventive Maintenance</b><small>Equipment units and PM work orders · '+escape(role)+'</small></div></div>'+
   '<div class="pml-picker"><button type="button" class="pml-picker-btn" data-pml-action="toggle-plants">'+escape(plantLabel)+' <span>▾</span></button>'+plantPicker+'</div><span class="pml-grow"></span>'+
   '<div class="pml-actions">'+uploadButton+moreMenu+addButton+'</div></div>';
  const registerHtml='<article class="pml-card pml-register" id="pm-unit-register"><div class="pml-register-head"><div><h3>Plant equipment maintenance register</h3><p>One row per equipment category, maintenance activity and cycle. Unit quantities are combined; open a row for work details.</p></div><span>'+visibleGroups.length+' equipment/activity rows · '+selected.length+' underlying tasks</span></div>'+
   focusBarHtml+'<div class="pml-filters"><label class="pml-inline-select">Plant<select aria-label="Choose plant for preventive maintenance" data-pml-select="plant"><option value="all">All plants ('+scopedPlants().length+')</option>'+scopedPlants().map(p=>'<option value="'+escape(p.name)+'"'+(f.plant===p.name?' selected':'')+'>'+escape(p.id||'')+' · '+escape(p.name)+'</option>').join('')+'</select></label><input type="search" placeholder="Search equipment, plant, task, person…" value="'+escape(f.query)+'" data-pml-input="query"><select aria-label="Filter by status" data-pml-select="status"><option value="all">All statuses</option>'+["Overdue","Due soon","Upcoming","Done","Cancelled"].map(key=>'<option value="'+key+'"'+(f.status===key?" selected":"")+'>'+key+'</option>').join("")+'</select><select aria-label="Filter by equipment" data-pml-select="equipment"><option value="all">All equipment</option>'+equipmentTypes.map(key=>'<option value="'+escape(key)+'"'+(f.equipment===key?" selected":"")+'>'+escape(key)+'</option>').join("")+'</select>'+
   '<select aria-label="Filter by assignee" data-pml-select="person"><option value="all">All people</option><option value="__none"'+(f.person==="__none"?" selected":"")+'>Unassigned</option>'+peopleList.map(name=>'<option value="'+escape(name)+'"'+(f.person===name?" selected":"")+'>'+escape(name)+'</option>').join("")+'</select>'+
   '<select aria-label="Sort rows" data-pml-select="sort">'+[["due","Sort: due date"],["late","Sort: most overdue"],["plant","Sort: plant"],["equipment","Sort: equipment"]].map(([k,l])=>'<option value="'+k+'"'+(f.sort===k?" selected":"")+'>'+l+'</option>').join("")+'</select>'+
   (f.status!=="all"||f.week!=="all"||f.age!=="all"||f.equipment!=="all"||f.plant!=="all"||f.focus!=="all"||f.person!=="all"||f.query?'<button class="btn o sm" type="button" data-pml-action="clear">Clear filters</button>':"")+'</div>'+
   '<div class="pml-table-wrap"><table class="pml-table pml-consolidated-table"><thead><tr><th>Equipment / maintenance work</th><th>Plant</th><th>Unit progress</th><th>Assignee</th><th>Due window</th><th>Status</th><th>Action</th></tr></thead><tbody>'+
   (visibleGroups.length?visibleGroups.slice((f.page-1)*PAGE,f.page*PAGE).map(group=>{
    const unitInventory=coverageUnit(group.plant,group.type),inventoryTotal=unitInventory&&unitInventory.units,fullGroup=allGroups.find(g=>g.key===group.key)||group,displayUnits=inventoryTotal==null?fullGroup.total:inventoryTotal;
    const term=groupToken(group),dates=displayDate(group.firstDue)+(group.lastDue&&group.lastDue!==group.firstDue?' – '+displayDate(group.lastDue):''),starts=displayDate(group.firstStart)+(group.lastStart&&group.lastStart!==group.firstStart?' – '+displayDate(group.lastStart):'');
    const named=group.assignees.filter(name=>name!=="Unassigned"),openNoOwner=group.tasks.some(task=>isOpen(task)&&unassigned(task));
    const note=(named.length?'<span class="pmc-who">'+escape(named.length===1?named[0]:named.length+' team members')+'</span>':'')+(openNoOwner?'<span class="pmc-unassigned">'+(named.length?'some unassigned':'Unassigned')+'</span>':'');
    const late=lateOf(group),until=group.lastDue?dueOffset({due:group.lastDue}):null;
    const when=group.status==="Done"?'':late?'<em class="pmc-when late">'+late+' d late</em>':until===0?'<em class="pmc-when soon">due today</em>':until!==null&&until>0&&until<=7?'<em class="pmc-when soon">in '+until+' d</em>':'';
    const rowTone=group.status==="Overdue"?' pmc-late':group.status==="Due soon"?' pmc-soon':group.status==="Done"?' pmc-done':'';
    return'<tr class="pmc-row'+rowTone+'" data-pml-group="'+term+'"><td><b>'+escape(group.type||'Equipment')+' × '+fullGroup.total+'</b><small class="pmc-task" title="'+escape(group.name)+'">'+escape(group.name)+' · '+escape(group.freq||'—')+'</small></td><td><b>'+escape((plantFor(group.plant)||{}).id||'')+'</b><small>'+escape(group.plant||'Unassigned')+'</small></td><td>'+progressBar(fullGroup)+'<small>'+fullGroup.completed+'/'+fullGroup.total+' done · '+fullGroup.overdue+' overdue'+(inventoryTotal==null||inventoryTotal===fullGroup.total?'':' · of '+inventoryTotal+' registered')+'</small></td><td>'+(note||'<span class="pmx-muted">—</span>')+'</td><td class="pmc-dates"><b>'+dates+'</b><small>start '+starts+'</small>'+when+'</td><td><span class="pml-badge '+group.status.toLowerCase().replace(/ /g,'-')+'">'+escape(group.status)+'</span></td><td class="pmc-act">'+(canAssign()&&openNoOwner?'<button class="btn o sm" type="button" data-pmc-assign="'+term+'">Assign</button>':'')+'<button class="btn o sm" type="button" data-pml-group="'+term+'">View units</button></td></tr>';
   }).join(''):'<tr><td colspan="7"><div class="pml-empty">No equipment work matches this selection. Choose another plant, clear a filter, or add a PM job.</div></td></tr>')+
   '</tbody></table></div><div class="pml-pager"><span>'+visibleGroups.length+' equipment/activity rows · '+selected.length+' task records (unit-level history preserved)</span><div><button class="btn o sm" type="button" data-pml-page="-1" '+(f.page<=1?"disabled":"")+'>Previous</button> Page '+f.page+' of '+pages+' <button class="btn o sm" type="button" data-pml-page="1" '+(f.page>=pages?"disabled":"")+'>Next</button></div></div></article>';
  /* ---- one question per view: Overview · Calendar · Plants · Coverage · Work register ---- */
  const view=VIEWS.some(v=>v[0]===f.view)?f.view:"overview";
  const lateTodayPlants=plantRows.filter(row=>row.overdue).length;
  const badges={schedule:todayOpen.length?{n:todayOpen.length,tone:"",label:"today"}:null,plants:lateTodayPlants?{n:lateTodayPlants,tone:"hot",label:"late"}:null,register:{n:visibleGroups.length,tone:"",label:"rows"}};
  let body;
  if(view==="schedule")body=calendarHtml(tasks,canCreate)+dayPlannerHtml();
  else if(view==="plants")body=matrixHtml(tasks);
  else if(view==="coverage")body=coverageHtml(true);
  else if(view==="register")body=registerHtml;
  else body=plantDetailsHtml()+'<div class="gx-glance pmv-charts"><div class="gx-grid gx-grid-3">'+donutHtml+weeksHtml+ageHtml+'</div>'+
   '<div class="gx-grid gx-grid-2">'+upcomingHtml(tasks,canCreate)+(leaderHtml||eqHtml)+'</div>'+(leaderHtml?'<div class="gx-grid gx-grid-1">'+eqHtml+'</div>':'')+'</div>';
  /* the large hero is the Overview's headline; the other views keep the clickable KPI row so work stays above the fold */
  return'<section class="pml pmv">'+toolbarHtml+(view==="overview"?glanceHtml:'<div class="gx-glance pmv-compact">'+kpiHtml+'</div>')+tabsHtml(view,badges)+'<div class="pmv-body" role="tabpanel" aria-label="'+escape((VIEWS.find(v=>v[0]===view)||VIEWS[0])[1])+'">'+body+'</div></section>';
 }

 const refreshTasks=()=>apiFetch("/api/scheduled/tasks").then(rows=>{S.tasks=rows;repaint()});
 function closeDrawer(drawer){if(drawer&&drawer.parentNode)drawer.remove()}
 async function openFollowUps(id){
  const task=(S.tasks||[]).find(row=>row.id===id);if(!task)return;
  const dbId=task.db_id||task.dbId;if(!dbId){toast("This PM job has not synced to the server.");return}
  let rows;
  try{rows=await apiFetch("/api/scheduled/tasks/"+encodeURIComponent(id)+"/followups")}
  catch(error){toast(error.message||"Follow-ups are unavailable for your role.");return}
  const drawer=document.createElement("div");drawer.className="pml-overlay";
  const history=(rows||[]).map(row=>'<div class="pml-history"><b>'+escape(row.how)+' · '+escape(row.outcome)+'</b><small>'+escape(row.by_name||"")+' · '+escape(fmtDT(row.at))+(row.promised_on?" · promised "+escape(displayDate(row.promised_on)):"")+'</small>'+(row.note?'<p>'+escape(row.note)+'</p>':"")+'</div>').join("")||'<p class="pml-empty">No site follow-ups recorded yet.</p>';
  drawer.innerHTML='<div class="pml-drawer"><header><div><b>Site follow-ups</b><small>'+escape(task.id)+' · '+escape(task.plant||"")+'</small></div><button type="button" aria-label="Close" data-pml-close>×</button></header><div class="pml-drawer-body"><div class="pml-card"><h3>Contact history</h3>'+history+'</div><form class="pml-card" data-pml-follow-form><h3>Log a site contact</h3><label>Contact method<select name="how"><option>Called</option><option>Messaged</option><option>Visited</option></select></label><label>Outcome<select name="outcome"><option>Will finish by the promised date</option><option>Blocked: waiting for shutdown</option><option>Blocked: waiting for parts</option><option>Blocked: no access</option><option>Could not reach anyone</option></select></label><label>Promised completion date<input name="promised_on" type="date" min="'+TODAY+'"></label><label>Next follow-up date<input name="next_follow_up_on" type="date" min="'+TODAY+'"></label><label>Spoke to<input name="spoke_to" maxlength="255" placeholder="Optional"></label><label>Note<textarea name="note" maxlength="4000" rows="3" placeholder="Optional context"></textarea></label><button class="btn p" type="submit">Save follow-up</button></form></div></div>';
  drawer.onclick=event=>{if(event.target===drawer||event.target.closest("[data-pml-close]"))closeDrawer(drawer)};
  drawer.querySelector("form").onsubmit=async event=>{
   event.preventDefault();const form=event.currentTarget,values=new FormData(form),outcome=String(values.get("outcome")||"");
   const body={how:values.get("how"),outcome,promised_on:values.get("promised_on")||null,next_follow_up_on:values.get("next_follow_up_on")||null,spoke_to:values.get("spoke_to")||null,note:values.get("note")||null};
   if(outcome==="Will finish by the promised date"&&!body.promised_on){toast("Enter the promised completion date.");return}
   const button=form.querySelector("button[type=submit]");button.disabled=true;
   try{await apiFetch("/api/scheduled/tasks/"+encodeURIComponent(id)+"/followups",{method:"POST",body});await refreshTasks();closeDrawer(drawer);toast("Site follow-up saved.")}
   catch(error){button.disabled=false;toast(error.message||"Could not save the follow-up.")}
  };
  document.body.append(drawer);
 }
 async function openAlerts(){
  let data;
  try{data=await apiFetch("/api/pm-plan/alert-preferences")}
  catch(error){toast(error.message||"Could not load PM alert settings.");return}
  const preferences=data.preferences||data.defaults||{},events=preferences.events||{},isHead=(S._roleLabel||S.currentRole)==="O&M Head";
  const drawer=document.createElement("div");drawer.className="pml-overlay";
  drawer.innerHTML='<div class="pml-drawer"><header><div><b>Preventive Maintenance alerts</b><small>Choose which PM events notify you and how.</small></div><button type="button" aria-label="Close" data-pml-close>×</button></header><form class="pml-drawer-body" data-pml-alert-form><div class="pml-card"><p>Alert events are based on live due dates and saved site follow-ups.</p>'+
   ALERTS.map(([key,label])=>{const choice=events[key]||{enabled:true,in_app:true,email:false};return'<div class="pml-alert-row"><b>'+escape(label)+'</b>'+["enabled","in_app","email"].map(field=>'<label><input type="checkbox" data-event="'+key+'" data-field="'+field+'" '+(choice[field]?"checked":"")+'> '+({enabled:"On",in_app:"In-app",email:"Email"}[field])+'</label>').join("")+'</div>'}).join("")+
   (isHead?'<label class="pml-team-mode">Team recipients<select name="team_who"><option value="">System default</option><option value="assignee_only">Assignee only</option><option value="assignee_and_head">Assignee and O&amp;M Head</option><option value="whole_team">Whole O&amp;M team</option></select></label>':"")+'</div><div class="pml-drawer-footer"><button class="btn o" type="button" data-pml-close>Cancel</button><button class="btn p" type="submit">Save settings</button></div></form></div>';
  if(isHead){const select=drawer.querySelector('[name="team_who"]');if(select)select.value=preferences.team_who||""}
  drawer.onclick=event=>{if(event.target===drawer||event.target.closest("[data-pml-close]"))closeDrawer(drawer)};
  drawer.querySelector("form").onsubmit=async event=>{
   event.preventDefault();const form=event.currentTarget,body={events:{}};
   form.querySelectorAll("[data-event]").forEach(input=>{const key=input.dataset.event;body.events[key]=body.events[key]||{};body.events[key][input.dataset.field]=input.checked});
   const select=form.querySelector('[name="team_who"]');if(select)body.team_who=select.value||null;
   const button=form.querySelector('button[type="submit"]');button.disabled=true;
   try{await apiFetch("/api/pm-plan/alert-preferences",{method:"PUT",body});closeDrawer(drawer);toast("PM alert settings saved.")}
   catch(error){button.disabled=false;toast(error.message||"Could not save PM alert settings.")}
  };
  document.body.append(drawer);
 }

 if(!window._pmLiveEvents){
  window._pmLiveEvents=true;
  document.addEventListener("click",event=>{
   const target=event.target.closest("[data-pml-action],[data-pml-status],[data-pml-week],[data-pml-age],[data-pml-equipment],[data-pml-plant],[data-pml-open],[data-pml-edit],[data-pml-page],[data-pml-coverage],[data-pmc-assign],[data-pml-group],[data-pml-planttab],[data-pml-focus],[data-pml-select-clear],[data-pmc-cov],[data-pmc-leadall]");
   if(!target)return;
   const f=state();
   /* chart, KPI and chip filters land on the matching register rows (chips inside the register do not jump) */
   const glanceTo=(on,id)=>{if(on&&!target.closest("#pm-unit-register")){S._glanceScroll=id||"pm-unit-register";f.view=id==="pm-plant-focus"?"overview":"register"}};
   if(target.dataset.pmlAction==="refresh-units"){loadUnitCoverage(true)}
   else if(target.dataset.pmlAction==="toggle-plants"){f.plantOpen=!f.plantOpen;repaint()}
   else if(target.dataset.pmlAction==="clear"){Object.assign(f,{equipment:"all",week:"all",age:"all",status:"all",query:"",focus:"all",person:"all",page:1});repaint()}
   else if(target.dataset.pmlAction==="alerts")openAlerts();
   else if(target.dataset.pmlStatus!==undefined){f.status=f.status===target.dataset.pmlStatus?"all":target.dataset.pmlStatus;f.page=1;glanceTo(f.status!=="all");repaint()}
   else if(target.dataset.pmlWeek!==undefined){const week=Number(target.dataset.pmlWeek);f.week=f.week===week?"all":week;f.page=1;glanceTo(f.week!=="all");repaint()}
   else if(target.dataset.pmlAge!==undefined){const ranges=[[1,2],[3,6],[7,13],[14,99999]],range=ranges[Number(target.dataset.pmlAge)];f.age=f.age&&f.age[0]===range[0]?"all":range;f.status=f.age==="all"?"all":"Overdue";f.page=1;glanceTo(f.age!=="all");repaint()}
   else if(target.dataset.pmlEquipment!==undefined){f.equipment=f.equipment===target.dataset.pmlEquipment?"all":target.dataset.pmlEquipment;f.page=1;glanceTo(f.equipment!=="all");repaint()}
   else if(target.dataset.pmlPlant!==undefined){f.plant=target.dataset.pmlPlant;f.plantOpen=false;f.plantQuery="";f.page=1;if(target.closest(".gx-leader"))glanceTo(true,"pm-plant-focus");repaint()}
   else if(target.dataset.pmlCoverage!==undefined){f.equipment=f.equipment===target.dataset.pmlCoverage?"all":target.dataset.pmlCoverage;f.page=1;f.view="register";repaint();const list=document.querySelector(".pml-register");if(list)list.scrollIntoView({behavior:"smooth",block:"start"})}
   else if(target.dataset.pmlPlanttab!==undefined){f.plantTab=target.dataset.pmlPlanttab;repaint()}
   else if(target.dataset.pmlFocus!==undefined){f.focus=f.focus===target.dataset.pmlFocus?"all":target.dataset.pmlFocus;f.page=1;glanceTo(f.focus!=="all");repaint()}
   else if(target.dataset.pmlSelectClear!==undefined){f[target.dataset.pmlSelectClear]="all";f.page=1;repaint()}
   else if(target.dataset.pmcCov!==undefined){f.covCollapsed=f.covCollapsed===false;repaint()}
   else if(target.dataset.pmcLeadall!==undefined){f.leadAll=!f.leadAll;repaint()}
   else if(target.dataset.pmcAssign!==undefined){event.stopPropagation();const overlay=target.closest(".pml-unit-drawer");if(overlay)overlay.remove();openAssign(target.dataset.pmcAssign)}
   else if(target.dataset.pmlGroup!==undefined){event.stopPropagation();openGroup(target.dataset.pmlGroup)}
   else if(target.dataset.pmlEdit!==undefined){event.stopPropagation();const overlay=target.closest(".pml-unit-drawer");if(overlay)overlay.remove();if(typeof pmEditOpen==="function")pmEditOpen(target.dataset.pmlEdit)}
   else if(target.dataset.pmlOpen!==undefined){event.stopPropagation();const overlay=target.closest(".pml-unit-drawer");if(overlay)overlay.remove();openModal("taskDetail",{id:target.dataset.pmlOpen})}
   else if(target.dataset.pmlPage!==undefined){const pages=Math.max(1,Math.ceil(workGroups(filteredTasks()).length/PAGE));f.page=Math.max(1,Math.min(pages,f.page+Number(target.dataset.pmlPage)));repaint()}
  });
  document.addEventListener("click",event=>{
   const inMenu=event.target.closest(".pmc-menu");
   document.querySelectorAll(".pmc-menu[open]").forEach(menu=>{if(menu!==inMenu||event.target.closest(".pmc-menu-list [role=menuitem]"))menu.removeAttribute("open")});
  });
  document.addEventListener("keydown",event=>{if(event.key==="Escape")document.querySelectorAll(".pmc-menu[open]").forEach(menu=>menu.removeAttribute("open"))});
  let typingTimer=null;
  document.addEventListener("input",event=>{
   const field=event.target.dataset&&event.target.dataset.pmlInput;if(!field)return;
   const f=state(),value=event.target.value;
   if(field==="query"){f.query=value;f.page=1}
   else if(field==="day-query"){f.dayQuery=value;f.dayAll=false}
   else if(field==="plant-search")f.plantQuery=value;
   else if(field==="mx-query"){f.mxQuery=value;f.mxAll=false}
   else return;
   clearTimeout(typingTimer);
   typingTimer=setTimeout(()=>{
    const selector='[data-pml-input="'+field+'"]',was=document.querySelector(selector),hadFocus=was&&document.activeElement===was,start=was?was.selectionStart:null;
    repaint();
    const input=document.querySelector(selector);
    if(input&&hadFocus){input.focus();try{input.setSelectionRange(start,start)}catch(e){}}
   },150);
  });
  document.addEventListener("change",event=>{
   const key=event.target.dataset&&event.target.dataset.pmlSelect;if(!key)return;
   const f=state();f[key]=event.target.value;f.page=1;if(key==="plant"){f.plantOpen=false;f.plantQuery="";}repaint();
  });
 }

 if(!window._pmDayEvents){
  window._pmDayEvents=true;
  document.addEventListener("click",event=>{
   const t=event.target.closest("[data-pmd-day],[data-pmd-shift],[data-pmd-today],[data-pmd-equip],[data-pmx-type],[data-pmd-overdue],[data-pmx-jobs],[data-pmd-status],[data-pmd-all],[data-pmd-jump]");
   if(!t||event.target.closest("[data-pml-coverage],[data-pml-plant]"))return;
   const f=state();
   if(t.dataset.pmdDay!==undefined){f.day=t.dataset.pmdDay;f.dayEquip="all";f.dayAll=false}
   else if(t.dataset.pmdStatus!==undefined){f.dayStatus=t.dataset.pmdStatus;f.dayAll=false}
   else if(t.dataset.pmdAll!==undefined){f.dayAll=!f.dayAll}
   else if(t.dataset.pmdJump!==undefined){f.day=t.dataset.pmdJump;f.dayEquip="all";f.dayAll=false;if(f.day<f.dayFrom||f.day>addDays(f.dayFrom,13))f.dayFrom=addDays(f.day,-2)}
   else if(t.dataset.pmdShift!==undefined){f.dayFrom=addDays(f.dayFrom||addDays(TODAY,-2),Number(t.dataset.pmdShift));const last=addDays(f.dayFrom,13);if(f.day<f.dayFrom||f.day>last)f.day=f.dayFrom<=TODAY&&TODAY<=last?TODAY:f.dayFrom}
   else if(t.dataset.pmdToday!==undefined){f.day=TODAY;f.dayFrom=addDays(TODAY,-2)}
   else if(t.dataset.pmdEquip!==undefined){f.dayEquip=t.dataset.pmdEquip}
   else if(t.dataset.pmxType!==undefined){const set=new Set(f.covOpen||[]),k=t.dataset.pmxType;if(set.has(k))set.delete(k);else set.add(k);f.covOpen=[...set]}
   else if(t.dataset.pmdOverdue!==undefined){f.status="Overdue";f.page=1;f.view="register";repaint();const list=document.querySelector(".pml-register");if(list)list.scrollIntoView({behavior:"smooth",block:"start"});return}
   else if(t.dataset.pmxJobs!==undefined){const [plant,type]=t.dataset.pmxJobs.split("|");f.equipment=type;f.plant=plant;f.page=1;f.view="register";repaint();const list=document.querySelector(".pml-register");if(list)list.scrollIntoView({behavior:"smooth",block:"start"});return}
   repaint();
  });
  document.addEventListener("change",event=>{if(event.target.matches&&event.target.matches("[data-pmx-show]")){state().covShow=event.target.value;repaint()}});
  document.addEventListener("click",event=>{
   const t=event.target.closest("[data-pmv-view],[data-pmcal-day],[data-pmcal-shift],[data-pmcal-today],[data-pmup-day],[data-pmm-cell],[data-pmm-plant],[data-pmm-all],[data-pmm-show],[data-pm-addon]");
   if(!t)return;
   const f=state();
   const pickDay=d=>{f.day=d;f.dayEquip="all";f.dayAll=false;if(d<f.dayFrom||d>addDays(f.dayFrom,13))f.dayFrom=addDays(d,-2)};
   if(t.dataset.pmvView!==undefined){f.view=t.dataset.pmvView;if(f.view==="schedule"&&f.calMonth!==String(f.day||TODAY).slice(0,7))f.calMonth=String(f.day||TODAY).slice(0,7)}
   else if(t.dataset.pmcalDay!==undefined){pickDay(t.dataset.pmcalDay);if(t.dataset.pmcalDay.slice(0,7)!==f.calMonth)f.calMonth=t.dataset.pmcalDay.slice(0,7)}
   else if(t.dataset.pmcalShift!==undefined){const [y,m]=String(f.calMonth||TODAY.slice(0,7)).split("-").map(Number),d=new Date(Date.UTC(y,m-1+Number(t.dataset.pmcalShift),1));f.calMonth=d.toISOString().slice(0,7)}
   else if(t.dataset.pmcalToday!==undefined){f.calMonth=TODAY.slice(0,7);pickDay(TODAY)}
   else if(t.dataset.pmupDay!==undefined){f.view="schedule";pickDay(t.dataset.pmupDay);f.calMonth=t.dataset.pmupDay.slice(0,7);S._glanceScroll="pm-day-planner"}
   else if(t.dataset.pmmCell!==undefined){const [plant,type]=t.dataset.pmmCell.split("|");Object.assign(f,{plant,equipment:type,status:"all",week:"all",age:"all",focus:"all",person:"all",query:"",page:1,view:"register"})}
   else if(t.dataset.pmmPlant!==undefined){f.plant=t.dataset.pmmPlant;f.page=1;f.view="overview"}
   else if(t.dataset.pmmAll!==undefined)f.mxAll=!f.mxAll;
   else if(t.dataset.pmmShow!==undefined){f.mxShow=f.mxShow===t.dataset.pmmShow?"all":t.dataset.pmmShow;f.mxAll=false}
   else if(t.dataset.pmAddon!==undefined){addJobOn(t.dataset.pmAddon);return}
   repaint();
  });
  /* "Today's PM plan" notification opens the day planner on that date. */
  const baseAction=window.actionNotification;
  if(typeof baseAction==="function")window.actionNotification=function(id){
   const ev=(S.events||[]).find(e=>e.id===id);
   if(ev&&ev.targetType==="pm_day"&&/^\d{4}-\d{2}-\d{2}$/.test(String(ev.targetId||""))){
    if(typeof markEventRead==="function")markEventRead(id);S.notifOpen=false;
    const f=state();f.day=ev.targetId;f.dayFrom=addDays(ev.targetId,-2);f.dayEquip="all";f.view="schedule";goTab("scheduled");
    setTimeout(()=>{const box=document.querySelector(".pml-day");if(box)box.scrollIntoView({behavior:"smooth",block:"start"})},60);
    return;
   }
   return baseAction.apply(this,arguments);
  };
 }

 const originalScheduled=renderScheduled;
 renderScheduled=function(){
  if(S.omTab==="washing")return originalScheduled.apply(this,arguments);
  return render();
 };

 const originalModal=renderModal;
 async function loadIssueTimeline(id){
  const issue=(S.issues||[]).find(row=>row.id===id),dbId=issue&&(issue.dbId||issue._dbId);
  if(!issue||!dbId||issue._timelineLoaded||issue._timelineLoading||issue._timelineFailed)return;
  issue._timelineLoading=true;
  try{
   const data=await apiFetch("/api/issues/"+encodeURIComponent(dbId)+"/activity?include_days=true");
   issue._timelineDays=data&&data.days||[];issue._timelineEvents=data&&data.activity||[];issue._timelineLoaded=true;
  }catch(error){issue._timelineFailed=true;toast(error.message||"Could not load dated ticket history.")}
  finally{issue._timelineLoading=false;if(S.modal==="ticket"&&S.modalCtx&&S.modalCtx.id===id)repaint()}
 }
 function timelineHtml(issue){
  const days=issue._timelineDays||[],events=issue._timelineEvents||[],closure=issue.closure||{};
  const fixed=closure.fixed_on||closure.fixedOn,created=issue.created||issue.created_at;
  const worked=days.filter(day=>String(day.summary||"").startsWith("Worked"));
  const elapsed=created?Math.max(1,Math.floor((new Date((fixed||TODAY)+"T00:00:00")-new Date(String(created).slice(0,10)+"T00:00:00"))/86400000)+1):"—";
  const metrics=[
   ["Calendar days open",closure.days_open||closure.daysOpen||elapsed],
   ["Days worked",closure.days_worked||closure.daysWorked||worked.length],
   ["Hours logged",closure.hours_total||closure.hoursTotal||closure.actualTimeToCloseHours||closure.resolutionHrs||worked.reduce((sum,day)=>sum+Number(day.hours||0),0)]
  ];
  const etc=events.filter(entry=>entry.action==="issue.etc_changed").slice().reverse();
  const recent=days.slice(-30).reverse(),older=Math.max(0,days.length-recent.length);
  return'<section class="si-ticket-timeline"><div class="si-ticket-timeline-head"><div><h4>Dated work history</h4><p>Progress, waiting status, daily hours and the next expected step.</p></div><span>'+days.length+' calendar days</span><button type="button" class="btn o sm" data-si-timeline-refresh="'+escape(issue.id)+'">Refresh</button></div>'+
   '<div class="si-ticket-metrics">'+metrics.map(row=>'<div><b>'+escape(row[1])+'</b><small>'+row[0]+'</small></div>').join("")+'</div>'+
   (etc.length?'<div class="si-etc-history"><b>ETC change history</b>'+etc.map(entry=>'<div><strong>'+escape(entry.metadata&&entry.metadata.old_etc?fmtDT(entry.metadata.old_etc):"No prior target")+' → '+escape(entry.metadata&&entry.metadata.new_etc?fmtDT(entry.metadata.new_etc):"—")+'</strong><small>'+escape(entry.actor||"")+' · '+escape(fmtDT(entry.at))+' · '+escape(entry.note||"Reason not recorded")+'</small></div>').join("")+'</div>':"")+
   '<div class="si-day-list">'+(older?'<details><summary>'+older+' earlier days are included in the totals</summary></details>':"")+
   (recent.map(day=>'<article class="si-day-entry"><div class="si-day-date"><b>'+escape(fmtDate(day.date))+'</b><small>Day '+escape(day.day_no)+(day.round_no>1?' · reopen '+escape(day.round_no):"")+'</small></div><div class="si-day-content"><span class="si-day-status">'+escape(day.day_status||day.summary||"No update")+(Number(day.hours||0)>0?' · '+escape(day.hours)+' hrs':"")+'</span>'+
    (day.entries||[]).map(entry=>'<p>'+escape(entry.action==="issue.progress"?"Work update":entry.action.replace(/^issue\\./,"").replace(/_/g," "))+' · '+escape(entry.actor||"")+(entry.note?' — '+escape(entry.note):"")+'</p>').join("")+
    (day.entries||[]).filter(entry=>entry.next_step||entry.next_expected_on||entry.review_state).map(entry=>'<small>'+(entry.next_step?'Next: '+escape(entry.next_step):"")+(entry.next_expected_on?' · expected '+escape(fmtDate(entry.next_expected_on)):"")+(entry.review_state?' · review '+escape(entry.review_state):"")+(entry.review_note?' · '+escape(entry.review_note):"")+'</small>').join("")+'</div></article>').join("")||'<div class="pml-empty">No dated work updates have been recorded.</div>')+'</div></section>';
 }
 renderModal=function(){
  let html=originalModal.apply(this,arguments);const context=S.modalCtx||{};
  if(S.modal==="ticket"&&html){
   const issue=(S.issues||[]).find(row=>row.id===context.id);
   if(issue){
    if(!issue._timelineLoaded&&!issue._timelineLoading&&!issue._timelineFailed)loadIssueTimeline(context.id);
    const marker='<section class="issue-updates">',index=html.indexOf(marker);
    if(index>=0)html=html.slice(0,index)+timelineHtml(issue)+html.slice(index);
   }
  }else if(S.modal==="taskDetail"&&html){
   const task=(S.tasks||[]).find(row=>row.id===context.id);
   if(task&&["O&M Head","Assignee"].includes(S._roleLabel||S.currentRole)){
    const marker='<button class="btn o sm" onclick="closeModal()">Close</button>',index=html.lastIndexOf(marker);
    if(index>=0)html=html.slice(0,index)+'<button type="button" class="btn p sm" data-pml-follow="'+escape(task.id)+'">Log site follow-up</button>'+html.slice(index);
   }
  }
  return html;
 };
 window.m26ReloadIssueTimeline=function(id){
  const issue=(S.issues||[]).find(row=>row.id===id);if(!issue)return;
  issue._timelineFailed=false;issue._timelineLoaded=false;loadIssueTimeline(id);
 };
 document.addEventListener("click",event=>{
  const refresh=event.target.closest("[data-si-timeline-refresh]"),follow=event.target.closest("[data-pml-follow]");
  if(refresh){const id=refresh.dataset.siTimelineRefresh,issue=(S.issues||[]).find(row=>row.id===id);if(issue){issue._timelineFailed=false;issue._timelineLoaded=false;loadIssueTimeline(id)}}
  if(follow){const id=follow.dataset.pmlFollow;closeModal();openFollowUps(id)}
 });
})();
