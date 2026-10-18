"use strict";

(function(){
 const COLORS={Done:"#16A34A",Upcoming:"#3B82F6","Due soon":"#D97706",Overdue:"#DC4C3E"};
 const ALERTS=[
  ["pm_due_soon","Due in 3 days"],["pm_due_today","Due today"],["pm_late_1d","1 day late"],
  ["pm_late_3d","3 days late"],["pm_critical_7d","7 days late (critical)"],
  ["pm_promise_missed","Site promise missed"],["pm_no_followup","No follow-up on late job"],
  ["pm_weekly_summary","Weekly late-job summary"],["pm_daily_plan","Morning plan: today's plants & equipment"]
 ];
 const state=()=>{const f=S.pmLive||(S.pmLive={}),defaults={plant:"all",plantQuery:"",plantOpen:false,plantTab:"late",equipment:"all",week:"all",age:"all",status:"all",query:"",page:1,covShow:"all",covOpen:[],day:TODAY,dayFrom:addDays(TODAY,-2),dayEquip:"all"};Object.keys(defaults).forEach(key=>{if(f[key]===undefined)f[key]=defaults[key]});return f};
 const repaint=()=>window.render();
 const escape=typeof esc==="function"?esc:value=>String(value==null?"":value);
 const scopeTasks=()=>{
  const f=state(),role=S._roleLabel||S.currentRole||"";
  let tasks=S.tasks||[];
  if(role==="Site Engineer"&&S._sePlant)tasks=tasks.filter(t=>t.plant===S._sePlant);
  if(f.plant!=="all")tasks=tasks.filter(t=>t.plant===f.plant);
  return tasks;
 };
 const dueOffset=task=>{
  if(!task.due)return null;
  return Math.round((new Date(task.due+"T00:00:00")-new Date(TODAY+"T00:00:00"))/86400000);
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
 const plantFor=name=>(S.plants||[]).find(plant=>plant.name===name);
 const currentScopeTasks=()=>scopeTasks().filter(task=>task.status!=="Cancelled");
 const filteredTasks=()=>{
  const f=state();let rows=scopeTasks();
  if(f.status!=="Cancelled")rows=rows.filter(task=>task.status!=="Cancelled");
  if(f.equipment!=="all")rows=rows.filter(task=>task.type===f.equipment);
  if(f.status!=="all")rows=rows.filter(task=>taskStatus(task)===f.status);
  if(f.week!=="all")rows=rows.filter(task=>task.due&&Math.floor((dueOffset(task)||0)/7)===f.week);
  if(f.age!=="all")rows=rows.filter(task=>taskStatus(task)==="Overdue"&&daysLate(task)>=f.age[0]&&daysLate(task)<=f.age[1]);
  if(f.query){const q=f.query.toLowerCase();rows=rows.filter(task=>[task.id,task.name,task.type,task.equip,task.assignee,task.plant].join(" ").toLowerCase().includes(q))}
  return rows.sort((a,b)=>String(a.due||"").localeCompare(String(b.due||"")));
 };
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
 const scopedPlants=()=>{
  const f=state(),role=S._roleLabel||S.currentRole||"";
  return(S.plants||[]).filter(p=>(role!=="Site Engineer"||!S._sePlant||p.name===S._sePlant)&&(f.plant==="all"||p.name===f.plant));
 };
 function coverageData(){
  const cfg=S._pmCfg||{configs:[],register:[]},plants=scopedPlants();
  const rows=new Map();
  const put=(plant,type)=>{
   if(!plant||!type)return null;
   const key=plant.name+"\u0000"+type;
   if(!rows.has(key))rows.set(key,{plant:plant.name,plantId:plant.id,type,units:null,source:"Not configured",daily:null,tasks:[],critical:0,faulty:0});
   return rows.get(key);
  };
  const plantOf=id=>plants.find(p=>String(p.dbId||p.id)===String(id));
  (cfg.configs||[]).forEach(c=>{
   const row=put(plantOf(c.plant_id),c.equipment_type);
   if(row){row.units=Number(c.total_units)||null;row.daily=Number(c.units_per_day)||null;row.source="Configured units"}
  });
  (cfg.register||[]).forEach(c=>{
   const row=put(plantOf(c.plant_id),c.equipment_type);
   if(row&&Number(c.units)>0){row.units=Number(c.units);row.source="Equipment register"}
   if(row){row.critical=Number(c.critical)||0;row.faulty=Number(c.faulty)||0}
  });
  currentScopeTasks().forEach(t=>{const row=put(plants.find(p=>p.name===t.plant),t.type);if(row)row.tasks.push(t)});
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
   return Object.assign(row,{maintained:Math.min(maintained,row.units||maintained),overdue,planned:row.units?Math.min(planned,row.units):planned,workOrders:all.length,label});
  }).sort((a,b)=>a.plant.localeCompare(b.plant)||a.type.localeCompare(b.type));
 }
 /* Equipment coverage: ONE row per equipment type across the selected plants. The per-plant breakdown opens
    as a dropdown under the row, so an "All plants" inverter job no longer fills the table with a row per plant. */
 const COV_RANK={late:0,missing:1,stray:2,scheduled:3,unknown:4,done:5};
 function coverageGroups(){
  const map=new Map();
  coverageData().forEach(r=>{if(!map.has(r.type))map.set(r.type,{type:r.type,rows:[]});map.get(r.type).rows.push(r)});
  return[...map.values()].map(g=>{
   const rs=g.rows,sum=k=>rs.reduce((n,r)=>n+(Number(r[k])||0),0);
   g.units=rs.some(r=>r.units!==null)?sum("units"):null;
   g.critical=sum("critical");g.faulty=sum("faulty");g.planned=sum("planned");g.maintained=sum("maintained");g.overdue=sum("overdue");
   g.equipped=rs.filter(r=>r.units!==null&&r.units>0);
   g.late=rs.filter(r=>r.label==="Overdue");
   g.missing=rs.filter(r=>r.units&&!r.workOrders);
   g.stray=rs.filter(r=>r.units===null&&r.workOrders);
   g.status=g.late.length?"late":g.missing.length?"missing":g.stray.length?"stray":(g.units&&g.maintained>=g.units)?"done":g.planned?"scheduled":"unknown";
   g.rows=rs.slice().sort((a,b)=>(COV_RANK[rowState(a)]-COV_RANK[rowState(b)])||a.plant.localeCompare(b.plant));
   return g;
  }).sort((a,b)=>(COV_RANK[a.status]-COV_RANK[b.status])||(b.critical-a.critical)||a.type.localeCompare(b.type));
 }
 function rowState(r){return r.units===null?(r.workOrders?"stray":"unknown"):r.label==="Not planned"?"missing":r.label==="Overdue"?"late":r.label==="Maintained"?"done":"scheduled"}
 const STATE_LABEL={late:"Overdue",missing:"No PM job",stray:"Not in register",scheduled:"Scheduled",unknown:"Set unit count",done:"Maintained"};
 function miniBar(done,late,total){const t=Math.max(1,total);return'<div class="pml-unit-bar" role="img" aria-label="'+done+' of '+total+' units done, '+late+' overdue"><i class="done" style="width:'+Math.min(100,100*done/t)+'%"></i><i class="overdue" style="width:'+Math.min(100,100*late/t)+'%"></i></div>'}
 function coverageHtml(){
  const f=state(),all=f.plant==="all",open=new Set(f.covOpen||[]);
  let groups=coverageGroups().filter(g=>f.equipment==="all"||g.type===f.equipment);
  const head='<div class="pml-coverage-head"><div><h3>Equipment coverage</h3><p>One row per equipment type'+(all?' across all plants':'')+'. Open a row (▸) to see each plant. Counts are <b>units</b>.</p></div>'+
   '<div class="pmx-tools"><label class="pml-inline-select">Show<select data-pmx-show aria-label="Which equipment to show"><option value="all"'+(f.covShow==="all"?" selected":"")+'>All equipment</option><option value="attention"'+(f.covShow==="attention"?" selected":"")+'>Needs attention</option><option value="critical"'+(f.covShow==="critical"?" selected":"")+'>Has critical / faulty units</option><option value="missing"'+(f.covShow==="missing"?" selected":"")+'>Without a PM job somewhere</option></select></label><button type="button" class="btn o sm" data-pml-action="refresh-units">Refresh</button></div></div>';
  if(!unitLoaded)return'<article class="pml-card pml-coverage pml-eqx">'+head+'<div class="pml-empty">Loading registered equipment and unit counts…</div></article>';
  if(unitError)return'<article class="pml-card pml-coverage pml-eqx">'+head+'<div class="pml-empty">'+escape(unitError)+'</div></article>';
  const totalUnits=groups.reduce((n,g)=>n+(g.units||0),0),critical=groups.reduce((n,g)=>n+g.critical,0),faulty=groups.reduce((n,g)=>n+g.faulty,0);
  const lateTypes=groups.filter(g=>g.late.length).length,missingPlants=groups.reduce((n,g)=>n+g.missing.length,0);
  const summary='<div class="pml-coverage-metrics"><span><b>'+totalUnits.toLocaleString("en-IN")+'</b>Registered units · '+groups.length+' equipment types</span><span class="'+(critical||faulty?"crit":"")+'"><b>'+critical+'</b>Critical units'+(faulty?' · '+faulty+' in fault':'')+'</span><span class="'+(lateTypes?"late":"")+'"><b>'+lateTypes+'</b>Equipment types with overdue work</span><span class="'+(missingPlants?"warn":"")+'"><b>'+missingPlants+'</b>Plant · equipment pairs without a PM job</span></div>';
  if(f.covShow==="attention")groups=groups.filter(g=>g.late.length||g.missing.length||g.stray.length);
  else if(f.covShow==="critical")groups=groups.filter(g=>g.critical||g.faulty);
  else if(f.covShow==="missing")groups=groups.filter(g=>g.missing.length);
  const chips=g=>[g.late.length?'<span class="pmx-chip late">'+g.late.length+' plant'+(g.late.length>1?'s':'')+' overdue</span>':'',g.missing.length?'<span class="pmx-chip warn">'+g.missing.length+' plant'+(g.missing.length>1?'s':'')+' without a PM job</span>':'',g.stray.length?'<span class="pmx-chip gray" title="A PM job exists but the equipment register has none of this type there">'+g.stray.length+' plant'+(g.stray.length>1?'s':'')+' not in register</span>':''].join("")||'<span class="pmx-chip ok">On track</span>';
  const critCell=(c,fl)=>(c?'<span class="pmx-crit">'+c+' high</span>':'<span class="pmx-muted">—</span>')+(fl?'<span class="pmx-fault">'+fl+' fault</span>':'');
  const body=groups.map(g=>{
   const isOpen=open.has(g.type)||groups.length===1;
   let h='<tr class="pmx-row'+(isOpen?" open":"")+' st-'+g.status+'" data-pmx-type="'+escape(g.type)+'" title="'+(isOpen?"Hide":"Show")+' plants"><td><span class="pmx-chev">›</span><b>'+escape(g.type)+'</b><small>'+(g.equipped.length?'registered at '+g.equipped.length+' plant'+(g.equipped.length>1?'s':''):'not in the register yet')+'</small></td>'+
    '<td><b>'+(g.units===null?'—':g.units.toLocaleString("en-IN"))+'</b></td><td>'+critCell(g.critical,g.faulty)+'</td>'+
    '<td>'+miniBar(g.maintained,g.overdue,Math.max(g.planned,g.units||0))+'<small>'+g.maintained+' done · '+g.overdue+' overdue · '+g.planned+' planned</small></td>'+
    '<td class="pmx-chips">'+chips(g)+'</td><td><button type="button" class="btn o sm" data-pml-coverage="'+escape(g.type)+'">View jobs</button></td></tr>';
   if(isOpen)h+=g.rows.map(r=>{const st=rowState(r);
    return'<tr class="pmx-sub st-'+st+'"><td><button type="button" class="pml-link" data-pml-plant="'+escape(r.plant)+'">'+escape(r.plant)+'</button><small>'+escape(r.plantId||"")+'</small></td><td>'+(r.units===null?'<span class="pmx-muted">—</span>':r.units)+'</td><td>'+critCell(r.critical,r.faulty)+'</td>'+
     '<td>'+miniBar(r.maintained,r.overdue,Math.max(r.planned,r.units||0))+'<small>'+r.maintained+' done · '+r.overdue+' overdue · '+r.planned+' planned</small></td>'+
     '<td><span class="pml-cov-status '+({late:"late",missing:"missing",stray:"unknown",unknown:"unknown",done:"done",scheduled:"scheduled"}[st])+'">'+STATE_LABEL[st]+'</span></td><td>'+(r.workOrders?'<button type="button" class="btn g sm" data-pmx-jobs="'+escape(r.plant)+'|'+escape(r.type)+'">Jobs</button>':'')+'</td></tr>'}).join("");
   return h;
  }).join("");
  const table='<div class="pml-coverage-scroll"><table class="pml-coverage-table pmx-table"><thead><tr><th>Equipment</th><th>Units</th><th>Critical</th><th>PM progress</th><th>Needs attention</th><th></th></tr></thead><tbody>'+(body||'<tr><td colspan="6"><div class="pml-empty">No equipment types match “'+escape({attention:"Needs attention",critical:"Has critical / faulty units",missing:"Without a PM job"}[f.covShow]||"this filter")+'”.</div></td></tr>')+'</tbody></table></div>';
  const foot='<div class="pml-coverage-foot">Critical = equipment marked High criticality in the equipment register. “Not in register” means a PM job exists at a plant whose register has none of that equipment.</div>';
  return'<article class="pml-card pml-coverage pml-eqx">'+head+summary+(groups.length||f.covShow!=="all"?table:'<div class="pml-empty">No registered equipment or PM work orders for this plant / equipment filter.</div>')+foot+'</article>';
 }

 /* Day planner: pick a day, see every plant and the equipment being maintained that day. */
 const onDay=(t,d)=>{if(!t.due)return false;const start=t.start&&t.start<=t.due?t.start:t.due;return start<=d&&d<=t.due};
 const WD=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
 function dayPlannerHtml(){
  const f=state(),tasks=currentScopeTasks().filter(t=>f.equipment==="all"||t.type===f.equipment),day=f.day||TODAY,from=f.dayFrom||addDays(TODAY,-2);
  const days=Array.from({length:14},(_,i)=>addDays(from,i));
  const strip=days.map(d=>{
   const list=tasks.filter(t=>onDay(t,d)),units=list.reduce((n,t)=>n+quantity(t),0),plants=new Set(list.map(t=>t.plant)).size;
   const openList=list.filter(t=>taskStatus(t)!=="Done"),late=d<TODAY&&openList.length,done=list.length&&!openList.length,dt=new Date(d+"T00:00:00");
   return'<button type="button" class="pmd-chip'+(d===day?" on":"")+(list.length?" has":"")+(late?" late":"")+(done?" done":"")+(d===TODAY?" today":"")+'" data-pmd-day="'+d+'" aria-pressed="'+(d===day)+'" title="'+escape(displayDate(d))+': '+units+' unit(s) at '+plants+' plant(s)"><small>'+WD[dt.getDay()]+'</small><b>'+dt.getDate()+'</b><span>'+(units?units+' unit'+(units===1?'':'s'):'—')+'</span><i>'+(plants?plants+' plant'+(plants===1?'':'s'):'')+'</i></button>';
  }).join("");
  const dayTasks=tasks.filter(t=>onDay(t,day));
  const types=[...new Set(dayTasks.map(t=>t.type||"Equipment"))].sort();
  const eq=f.dayEquip!=="all"&&types.includes(f.dayEquip)?f.dayEquip:"all";
  const shown=dayTasks.filter(t=>eq==="all"||(t.type||"Equipment")===eq);
  const plants=[...new Set(shown.map(t=>t.plant))].sort((a,b)=>{const la=shown.filter(t=>t.plant===a&&taskStatus(t)==="Overdue").length,lb=shown.filter(t=>t.plant===b&&taskStatus(t)==="Overdue").length;return lb-la||String(a).localeCompare(String(b))});
  const units=shown.reduce((n,t)=>n+quantity(t),0),people=new Set(shown.map(t=>t.assignee||"Unassigned"));
  const carried=day===TODAY?tasks.filter(t=>taskStatus(t)==="Overdue"&&!onDay(t,day)):[];
  const dt=new Date(day+"T00:00:00");
  const cards=plants.map(pn=>{
   const pt=shown.filter(t=>t.plant===pn),pr=plantFor(pn),pu=pt.reduce((n,t)=>n+quantity(t),0);
   const lines=workGroups(pt).map(g=>{const c=countsOf(g.tasks),todo=g.tasks.length-(c.Done||0);
    return'<div class="pmd-line"><span class="pmd-type">'+escape(g.type||"Equipment")+' <b>×'+g.total+'</b></span><span class="pmd-what">'+escape(g.name)+'<small>'+escape(g.freq||"")+' · '+escape(g.assignees.join(", "))+'</small></span>'+
     '<span class="pmd-state">'+(c.Done?'<em class="ok">'+c.Done+' done</em>':'')+(c.Overdue?'<em class="late">'+c.Overdue+' overdue</em>':'')+(todo-(c.Overdue||0)>0?'<em>'+(todo-(c.Overdue||0))+' to do</em>':'')+'</span><button type="button" class="btn o sm" data-pml-group="'+groupToken(g)+'">Open</button></div>'}).join("");
   return'<div class="pmd-plant"><div class="pmd-plant-h"><button type="button" class="pml-link" data-pml-plant="'+escape(pn)+'"><b>'+escape(pr&&pr.id?pr.id+" · ":"")+escape(pn)+'</b></button><span>'+pu+' unit'+(pu===1?'':'s')+' · '+pt.length+' work order'+(pt.length===1?'':'s')+'</span></div>'+lines+'</div>';
  }).join("");
  return'<article class="pml-card pml-day"><div class="pmd-head"><div><h3>Maintenance by day</h3><p>Pick a day to see which plants and equipment are being maintained. Each morning the team gets this list as a notification.</p></div>'+
   '<div class="pmd-nav"><button type="button" class="btn o sm" data-pmd-shift="-7" aria-label="Previous week">‹</button><button type="button" class="btn o sm" data-pmd-today>Today</button><button type="button" class="btn o sm" data-pmd-shift="7" aria-label="Next week">›</button><button type="button" class="btn g sm" data-pml-action="alerts" title="Morning plan notification settings">🔔 Alerts</button></div></div>'+
   '<div class="pmd-strip" role="group" aria-label="Choose a day">'+strip+'</div>'+
   '<div class="pmd-sel"><div class="pmd-sel-h"><div><b>'+escape(WD[dt.getDay()]+", "+displayDate(day))+(day===TODAY?' · Today':'')+'</b><small>'+(shown.length?plants.length+' plant'+(plants.length===1?'':'s')+' · '+units+' unit'+(units===1?'':'s')+' · '+people.size+' '+(people.size===1?'person':'people'):'Nothing scheduled')+'</small></div>'+
   (types.length>1?'<div class="pmd-eq">'+['all'].concat(types).map(k=>{const n=k==="all"?dayTasks.reduce((a,t)=>a+quantity(t),0):dayTasks.filter(t=>(t.type||"Equipment")===k).reduce((a,t)=>a+quantity(t),0);return'<button type="button" class="'+(eq===k?"on":"")+'" data-pmd-equip="'+escape(k)+'">'+escape(k==="all"?"All equipment":k)+' <b>'+n+'</b></button>'}).join("")+'</div>':'')+'</div>'+
   (carried.length?'<button type="button" class="pmd-carried" data-pmd-overdue>⚠ '+carried.length+' overdue work order'+(carried.length===1?'':'s')+' from earlier days still open — show them</button>':'')+
   (cards?'<div class="pmd-grid">'+cards+'</div>':'<div class="pml-empty">No preventive maintenance is scheduled on this day'+(f.equipment!=="all"?' for '+escape(f.equipment):'')+'.</div>')+'</div></article>';
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
 const coverageUnit=(plant,type)=>coverageData().find(r=>r.plant===plant&&r.type===type);
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
   '<div class="pml-card"><h3>Task records <small>· '+group.tasks.length+'</small></h3><p>Open a work record to complete checks, upload evidence or review history. Unit identifiers are not displayed in the main register.</p>'+group.tasks.slice().sort((a,b)=>String(a.due||"").localeCompare(String(b.due||""))).map(t=>'<div class="pml-task-row"><div><b>Start '+escape(displayDate(t.start))+' · Due '+escape(displayDate(t.due))+'</b><small>'+escape(t.assignee||"Unassigned")+' · '+escape(taskStatus(t))+'</small></div>'+(["O&M Head","Assignee"].includes(S._roleLabel||S.currentRole)&&!["Completed","Cancelled"].includes(t.status)?'<button type="button" class="btn o sm" data-pml-edit="'+escape(t.id)+'">Edit dates</button>':"")+'<button type="button" class="btn o sm" data-pml-open="'+escape(t.id)+'">Open task</button></div>').join('')+'</div></div><div class="pml-drawer-footer"><button type="button" class="btn o" data-pml-close>Close</button></div></div>';
  drawer.onclick=event=>{if(event.target===drawer||event.target.closest('[data-pml-close]'))closeDrawer(drawer)};
  document.body.append(drawer);
 }
 function plantDetailsHtml(){
  const f=state();if(f.plant==="all")return"";
  const rows=workGroups(currentScopeTasks()),overdue=rows.filter(g=>g.overdue),next=rows.filter(g=>g.status==="Due soon"||g.status==="Upcoming"),done=rows.filter(g=>g.status==="Done");
  const coverage=coverageData().filter(r=>r.plant===f.plant),missing=coverage.filter(r=>r.label==="Not planned"),mostLate=Math.max(0,...currentScopeTasks().map(daysLate));
  const view=f.plantTab==="next"?next:f.plantTab==="done"?done:overdue;
  return'<article class="pml-card pml-plant-focus"><div class="pml-focus-top"><div><small class="pml-focus-eyebrow">PLANT WORKFORCE & EQUIPMENT HEALTH</small><h3>'+escape(f.plant)+'</h3><p>Equipment counts are combined by category and activity; no separate inverter number rows.</p></div><div class="pml-focus-metrics"><span><b>'+overdue.length+'</b>Overdue groups</span><span><b>'+mostLate+'d</b>Longest late</span><span><b>'+missing.length+'</b>Unplanned types</span><span><b>'+done.length+'</b>Completed groups</span></div></div><div class="pml-focus-tabs">'+[["late","Not maintained",overdue.length],["next","Coming up",next.length],["done","Done",done.length]].map(tab=>'<button type="button" class="'+(f.plantTab===tab[0]?"active":"")+'" data-pml-planttab="'+tab[0]+'">'+tab[1]+' <b>'+tab[2]+'</b></button>').join('')+'</div>'+
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

 function render(){
  loadUnitCoverage(false);
  const f=state(),tasks=currentScopeTasks(),selected=filteredTasks(),visibleGroups=workGroups(selected),allGroups=workGroups(tasks),counts=countsOf(tasks);
  const overdue=tasks.filter(task=>taskStatus(task)==="Overdue"),dueSoon=tasks.filter(task=>taskStatus(task)==="Due soon"),done=tasks.filter(task=>taskStatus(task)==="Done");
  const onTime=done.filter(task=>task.completion&&Number(task.completion.delay||task.delayDays||0)<=0);
  const onTimePercent=done.length?percent(onTime.length,done.length):0;
  const configuredTypes=unitLoaded&&!unitError?coverageData().map(row=>row.type):[];
  const equipmentTypes=[...new Set(tasks.map(task=>task.type).concat(configuredTypes).filter(Boolean))].sort();
  const plantRows=(S.plants||[]).map(plant=>{
   const jobs=tasks.filter(task=>task.plant===plant.name),late=jobs.filter(task=>taskStatus(task)==="Overdue");
   return{plant,jobs,overdue:late.length,oldest:Math.max(0,...late.map(daysLate))};
  }).filter(row=>row.jobs.length).sort((a,b)=>b.overdue-a.overdue||b.oldest-a.oldest);
  const ageBands=[[1,2,"1–2 days"],[3,6,"3–6 days"],[7,13,"1–2 weeks"],[14,99999,"2+ weeks"]];
  const ageCounts=ageBands.map(band=>overdue.filter(task=>daysLate(task)>=band[0]&&daysLate(task)<=band[1]).length);
  const weekRows=Array.from({length:9},(_,i)=>i-3).map(week=>{
   const jobs=tasks.filter(task=>task.due&&Math.floor((dueOffset(task)||0)/7)===week);
   return{week,jobs,counts:countsOf(jobs)};
  }),weekMax=Math.max(1,...weekRows.map(row=>row.jobs.length));
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
   scopedPlants().filter(plant=>(plant.name+" "+plant.id).toLowerCase().includes(f.plantQuery.toLowerCase())).map(plant=>'<button type="button" data-pml-plant="'+escape(plant.name)+'">'+escape(plant.id||"")+' '+escape(plant.name)+'<small>'+tasks.filter(task=>task.plant===plant.name&&taskStatus(task)==="Overdue").length+' overdue</small></button>').join("")+'</div></div>':"";
  const alertsButton='<button type="button" class="btn o sm" data-pml-action="alerts">Alerts</button>';
  const uploadButton=["O&M Head","Administration"].includes(role)&&typeof pmImportPick==="function"?'<button type="button" class="btn o sm" onclick="pmImportPick()">Import CSV / Excel</button><button type="button" class="btn o sm" onclick="pmDownloadCsvTemplate()">CSV template</button>':"";
  const unitsButton=canCreate&&typeof pmOpenUnitCfg==="function"?'<button type="button" class="btn o sm" onclick="pmOpenUnitCfg()">Unit counts</button>':"";
  const addButton=canCreate?'<button type="button" class="btn p sm" onclick="openProblemScheduledTask()">+ Add job</button>':"";
  const overview='<section class="pml">'+
   '<div class="pml-toolbar"><div class="pml-brand"><span class="pml-mark">PM</span><div><b>Preventive Maintenance</b><small>Equipment units and PM work orders · '+escape(role)+'</small></div></div>'+
   '<div class="pml-picker"><button type="button" class="pml-picker-btn" data-pml-action="toggle-plants">'+escape(plantLabel)+' <span>▾</span></button>'+plantPicker+'</div><span class="pml-grow"></span>'+
   '<div class="pml-actions"><button class="btn o sm" type="button" onclick="exportScheduledOMCompliance()">Export compliance</button>'+alertsButton+unitsButton+uploadButton+addButton+'</div></div>'+
   '<div class="pml-heading"><div><div class="pml-eyebrow">PLANNED FIELD WORK · UNIT COUNTS, NOT EQUIPMENT NUMBERS</div><h2>'+escape(f.plant==="all"?"Portfolio overview":f.plant)+'</h2><p><b>'+overdue.length+' overdue work records</b> · '+dueSoon.length+' due this week · '+allGroups.length+' equipment/activity rows across '+tasks.length+' task records. View unit coverage below.</p></div><div class="pml-health">'+stacked(tasks)+'<small>Work order status</small></div></div>'+
   '<div class="pml-stat-row">'+filterButton("Overdue","Overdue",overdue.length,COLORS.Overdue)+filterButton("Due soon","Due this week",dueSoon.length,COLORS["Due soon"])+filterButton("Upcoming","Upcoming",counts.Upcoming||0,COLORS.Upcoming)+filterButton("Done","Completed · "+onTimePercent+"% on time",done.length,COLORS.Done)+'</div>'+
   '<div class="pml-grid">'+
    '<article class="pml-card"><h3>Where the jobs stand</h3><p>Select a status to filter the work list.</p><div class="pml-donut-body">'+donut+'<div>'+statuses.map(key=>'<button type="button" class="'+(f.status===key?"active":"")+'" data-pml-status="'+key+'"><i style="background:'+COLORS[key]+'"></i>'+key+'<b>'+(counts[key]||0)+'</b></button>').join("")+'</div></div></article>'+
    '<article class="pml-card"><h3>Jobs by due week</h3><p>Past and upcoming work, grouped by due date.</p><div class="pml-weeks">'+weekRows.map(row=>'<button type="button" class="'+(f.week===row.week?"active ":"")+(row.week===0?"current":"")+'" data-pml-week="'+row.week+'"><b>'+row.jobs.length+'</b><span class="pml-week-bars">'+statuses.map(key=>row.counts[key]?'<i style="height:'+Math.max(3,row.counts[key]/weekMax*72)+'px;background:'+COLORS[key]+'"></i>':"").join("")+'</span><small>'+escape(weekName(row.week))+'</small></button>').join("")+'</div></article>'+
    '<article class="pml-card"><h3>How late are overdue jobs?</h3><p>Open overdue work grouped by days past due.</p>'+ageBands.map((band,i)=>'<button type="button" class="pml-age'+(f.age&&f.age[0]===band[0]?" active":"")+'" data-pml-age="'+i+'"><span>'+band[2]+'</span><i><b style="width:'+percent(ageCounts[i],Math.max(1,...ageCounts))+'%"></b></i><strong>'+ageCounts[i]+'</strong></button>').join("")+'<small class="pml-footnote">Tasks become critical after 7 days late.</small></article>'+
    '<article class="pml-card"><h3>By equipment</h3><p>Select a category to filter the work list.</p>'+equipmentTypes.map(type=>{const rows=tasks.filter(task=>task.type===type),late=rows.filter(task=>taskStatus(task)==="Overdue").length;return'<button type="button" class="pml-equipment'+(f.equipment===type?" active":"")+'" data-pml-equipment="'+escape(type)+'"><b>'+escape(type)+'</b>'+stacked(rows)+'<small>'+(rows.length?late+' overdue · '+rows.length+' job'+(rows.length===1?'':'s'):'No PM job scheduled')+'</small></button>'}).join("")+(equipmentTypes.length?"":'<div class="pml-empty">No equipment work orders in this scope.</div>')+'</article>'+
    (f.plant==="all"?'<article class="pml-card pml-plants"><h3>Plants needing attention</h3><p>Plants ordered by overdue preventive work.</p>'+plantRows.slice(0,5).map((row,i)=>'<button type="button" class="pml-plant-row" data-pml-plant="'+escape(row.plant.name)+'"><i>'+(i+1)+'</i><span><b>'+escape(row.plant.name)+'</b><small>'+escape(row.plant.id||"")+'</small></span>'+stacked(row.jobs)+'<strong class="'+(row.overdue?"late":"")+'">'+row.overdue+' overdue<small>'+(row.oldest?row.oldest+' days oldest':"on schedule")+'</small></strong></button>').join("")+(plantRows.length?"":'<div class="pml-empty">No plants have scheduled PM tasks yet.</div>')+'</article>':"")+
   '</div>'+plantDetailsHtml()+coverageHtml()+dayPlannerHtml()+
   '<article class="pml-card pml-register" id="pm-unit-register"><div class="pml-register-head"><div><h3>Plant equipment maintenance register</h3><p>One row per equipment category, maintenance activity and cycle. Unit quantities are combined; open a row for work details.</p></div><span>'+visibleGroups.length+' equipment/activity rows · '+selected.length+' underlying tasks</span></div>'+
   '<div class="pml-filters"><label class="pml-inline-select">Plant<select aria-label="Choose plant for preventive maintenance" data-pml-select="plant"><option value="all">All plants ('+scopedPlants().length+')</option>'+scopedPlants().map(p=>'<option value="'+escape(p.name)+'"'+(f.plant===p.name?' selected':'')+'>'+escape(p.id||'')+' · '+escape(p.name)+'</option>').join('')+'</select></label><input type="search" placeholder="Search equipment, plant, task, person…" value="'+escape(f.query)+'" data-pml-input="query"><select aria-label="Filter by status" data-pml-select="status"><option value="all">All statuses</option>'+["Overdue","Due soon","Upcoming","Done","Cancelled"].map(key=>'<option value="'+key+'"'+(f.status===key?" selected":"")+'>'+key+'</option>').join("")+'</select><select aria-label="Filter by equipment" data-pml-select="equipment"><option value="all">All equipment</option>'+equipmentTypes.map(key=>'<option value="'+escape(key)+'"'+(f.equipment===key?" selected":"")+'>'+escape(key)+'</option>').join("")+'</select>'+
   (f.status!=="all"||f.week!=="all"||f.age!=="all"||f.equipment!=="all"||f.plant!=="all"?'<button class="btn o sm" type="button" data-pml-action="clear">Clear filters</button>':"")+'</div>'+
   '<div class="pml-table-wrap"><table class="pml-table pml-consolidated-table"><thead><tr><th>Equipment / maintenance work</th><th>Plant</th><th>Units</th><th>Unit progress</th><th>Assignee</th><th>Start date</th><th>Due window</th><th>Status</th><th>Action</th></tr></thead><tbody>'+
   (visibleGroups.length?visibleGroups.slice((f.page-1)*10,f.page*10).map(group=>{
    const unitInventory=coverageUnit(group.plant,group.type),inventoryTotal=unitInventory&&unitInventory.units,fullGroup=allGroups.find(g=>g.key===group.key)||group,displayUnits=inventoryTotal==null?fullGroup.total:inventoryTotal;
    const term=groupToken(group),dates=displayDate(group.firstDue)+(group.lastDue&&group.lastDue!==group.firstDue?' – '+displayDate(group.lastDue):''),starts=displayDate(group.firstStart)+(group.lastStart&&group.lastStart!==group.firstStart?' – '+displayDate(group.lastStart):'');
    const note=group.assignees.length===1?group.assignees[0]:group.assignees.length+' team members';
    return'<tr data-pml-group="'+term+'"><td><b>'+escape(group.type||'Equipment')+' × '+fullGroup.total+'</b><small>'+escape(group.name)+' · '+escape(group.freq||'—')+'</small></td><td>'+escape((plantFor(group.plant)||{}).id||'')+'<small>'+escape(group.plant||'Unassigned')+'</small></td><td><b>'+fullGroup.total+'</b><small>'+(inventoryTotal==null?'in this job':inventoryTotal===fullGroup.total?'all registered units':'of '+inventoryTotal+' registered')+'</small></td><td>'+progressBar(fullGroup)+'<small>'+fullGroup.completed+' done · '+fullGroup.overdue+' overdue</small></td><td>'+escape(note)+'</td><td>'+starts+'</td><td>'+dates+'</td><td><span class="pml-badge '+group.status.toLowerCase().replace(/ /g,'-')+'">'+escape(group.status)+'</span></td><td><button class="btn o sm" type="button" data-pml-group="'+term+'">View units</button></td></tr>';
   }).join(''):'<tr><td colspan="9"><div class="pml-empty">No equipment work matches this selection. Choose another plant, clear a filter, or add a PM job.</div></td></tr>')+
   '</tbody></table></div><div class="pml-pager"><span>'+visibleGroups.length+' equipment/activity rows · '+selected.length+' task records (unit-level history preserved)</span><div><button class="btn o sm" type="button" data-pml-page="-1" '+(f.page<=1?"disabled":"")+'>Previous</button> Page '+f.page+' of '+Math.max(1,Math.ceil(visibleGroups.length/10))+' <button class="btn o sm" type="button" data-pml-page="1" '+(f.page>=Math.ceil(visibleGroups.length/10)?"disabled":"")+'>Next</button></div></div></article></section>';
  return overview;
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
   const target=event.target.closest("[data-pml-action],[data-pml-status],[data-pml-week],[data-pml-age],[data-pml-equipment],[data-pml-plant],[data-pml-open],[data-pml-edit],[data-pml-page],[data-pml-coverage],[data-pml-group],[data-pml-planttab]");
   if(!target)return;
   const f=state();
   if(target.dataset.pmlAction==="refresh-units"){loadUnitCoverage(true)}
   else if(target.dataset.pmlAction==="toggle-plants"){f.plantOpen=!f.plantOpen;repaint()}
   else if(target.dataset.pmlAction==="clear"){Object.assign(f,{equipment:"all",week:"all",age:"all",status:"all",query:"",page:1});repaint()}
   else if(target.dataset.pmlAction==="alerts")openAlerts();
   else if(target.dataset.pmlStatus!==undefined){f.status=f.status===target.dataset.pmlStatus?"all":target.dataset.pmlStatus;f.page=1;repaint()}
   else if(target.dataset.pmlWeek!==undefined){const week=Number(target.dataset.pmlWeek);f.week=f.week===week?"all":week;f.page=1;repaint()}
   else if(target.dataset.pmlAge!==undefined){const ranges=[[1,2],[3,6],[7,13],[14,99999]],range=ranges[Number(target.dataset.pmlAge)];f.age=f.age&&f.age[0]===range[0]?"all":range;f.status=f.age==="all"?"all":"Overdue";f.page=1;repaint()}
   else if(target.dataset.pmlEquipment!==undefined){f.equipment=f.equipment===target.dataset.pmlEquipment?"all":target.dataset.pmlEquipment;f.page=1;repaint()}
   else if(target.dataset.pmlPlant!==undefined){f.plant=target.dataset.pmlPlant;f.plantOpen=false;f.plantQuery="";f.page=1;repaint()}
   else if(target.dataset.pmlCoverage!==undefined){f.equipment=f.equipment===target.dataset.pmlCoverage?"all":target.dataset.pmlCoverage;f.page=1;repaint();const list=document.querySelector(".pml-register");if(list)list.scrollIntoView({behavior:"smooth",block:"start"})}
   else if(target.dataset.pmlPlanttab!==undefined){f.plantTab=target.dataset.pmlPlanttab;repaint()}
   else if(target.dataset.pmlGroup!==undefined){event.stopPropagation();openGroup(target.dataset.pmlGroup)}
   else if(target.dataset.pmlEdit!==undefined){event.stopPropagation();const overlay=target.closest(".pml-unit-drawer");if(overlay)overlay.remove();if(typeof pmEditOpen==="function")pmEditOpen(target.dataset.pmlEdit)}
   else if(target.dataset.pmlOpen!==undefined){event.stopPropagation();const overlay=target.closest(".pml-unit-drawer");if(overlay)overlay.remove();openModal("taskDetail",{id:target.dataset.pmlOpen})}
   else if(target.dataset.pmlPage!==undefined){const pages=Math.max(1,Math.ceil(workGroups(filteredTasks()).length/10));f.page=Math.max(1,Math.min(pages,f.page+Number(target.dataset.pmlPage)));repaint()}
  });
  document.addEventListener("input",event=>{
   const field=event.target.dataset&&event.target.dataset.pmlInput;if(!field)return;
   const f=state();if(field==="query"){f.query=event.target.value;f.page=1;repaint();const input=document.querySelector('[data-pml-input="query"]');if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length)}}
   else if(field==="plant-search"){f.plantQuery=event.target.value;const start=event.target.selectionStart;repaint();const input=document.getElementById("pml-plant-search");if(input){input.focus();input.setSelectionRange(start,start)}}
  });
  document.addEventListener("change",event=>{
   const key=event.target.dataset&&event.target.dataset.pmlSelect;if(!key)return;
   const f=state();f[key]=event.target.value;f.page=1;if(key==="plant"){f.plantOpen=false;f.plantQuery="";}repaint();
  });
 }

 if(!window._pmDayEvents){
  window._pmDayEvents=true;
  document.addEventListener("click",event=>{
   const t=event.target.closest("[data-pmd-day],[data-pmd-shift],[data-pmd-today],[data-pmd-equip],[data-pmx-type],[data-pmd-overdue],[data-pmx-jobs]");
   if(!t||event.target.closest("[data-pml-coverage],[data-pml-plant]"))return;
   const f=state();
   if(t.dataset.pmdDay!==undefined){f.day=t.dataset.pmdDay;f.dayEquip="all"}
   else if(t.dataset.pmdShift!==undefined){f.dayFrom=addDays(f.dayFrom||addDays(TODAY,-2),Number(t.dataset.pmdShift));const last=addDays(f.dayFrom,13);if(f.day<f.dayFrom||f.day>last)f.day=f.dayFrom<=TODAY&&TODAY<=last?TODAY:f.dayFrom}
   else if(t.dataset.pmdToday!==undefined){f.day=TODAY;f.dayFrom=addDays(TODAY,-2)}
   else if(t.dataset.pmdEquip!==undefined){f.dayEquip=t.dataset.pmdEquip}
   else if(t.dataset.pmxType!==undefined){const set=new Set(f.covOpen||[]),k=t.dataset.pmxType;if(set.has(k))set.delete(k);else set.add(k);f.covOpen=[...set]}
   else if(t.dataset.pmdOverdue!==undefined){f.status="Overdue";f.page=1;repaint();const list=document.querySelector(".pml-register");if(list)list.scrollIntoView({behavior:"smooth",block:"start"});return}
   else if(t.dataset.pmxJobs!==undefined){const [plant,type]=t.dataset.pmxJobs.split("|");f.equipment=type;f.plant=plant;f.page=1;repaint();const list=document.querySelector(".pml-register");if(list)list.scrollIntoView({behavior:"smooth",block:"start"});return}
   repaint();
  });
  document.addEventListener("change",event=>{if(event.target.matches&&event.target.matches("[data-pmx-show]")){state().covShow=event.target.value;repaint()}});
  /* "Today's PM plan" notification opens the day planner on that date. */
  const baseAction=window.actionNotification;
  if(typeof baseAction==="function")window.actionNotification=function(id){
   const ev=(S.events||[]).find(e=>e.id===id);
   if(ev&&ev.targetType==="pm_day"&&/^\d{4}-\d{2}-\d{2}$/.test(String(ev.targetId||""))){
    if(typeof markEventRead==="function")markEventRead(id);S.notifOpen=false;
    const f=state();f.day=ev.targetId;f.dayFrom=addDays(ev.targetId,-2);f.dayEquip="all";goTab("scheduled");
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
