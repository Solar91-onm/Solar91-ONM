/* Maintenance scope library: PV Area / Plant Side / GSS Side / Miscellaneous (filter only; PM creation lists all equipment). */
function pmPlantLabelText(name){const p=typeof plantRec==="function"?plantRec(name):null;return p?(p.id?String(p.id)+" · ":"")+String(p.name||name).replace(/\s+/g," ").trim():String(name||"—")}
function pmPlantLabelHtml(name){const p=typeof plantRec==="function"?plantRec(name):null;if(!p)return esc(name||"—");return (p.id?'<span class="pm-plant-code">'+esc(p.id)+'</span>':"")+'<span class="pm-plant-name">'+esc(p.name||name)+'</span>'}
function scopeCardHtml(x,i,counts,palette,sf){const n=counts[x.name]||0;return '<button type="button" class="sched-scope-card pm-scope-card '+(sf.asset===x.name?'active':'')+'" aria-pressed="'+(sf.asset===x.name)+'" onclick="S.schedF.asset=\''+esc(x.name).replace(/&#39;/g,"\\'")+'\';S.tablePages.scheduled=1;render()"><span class="pm-scope-icon" style="--pm-scope-color:'+palette[i%palette.length]+'">'+esc(x.name.charAt(0))+'</span><span class="sched-scope-name">'+esc(x.name)+'</span><span class="pm-scope-count"><b>'+n+'</b><i><span style="width:'+Math.round(n*100/Math.max(1,...Object.values(counts)))+'%"></span></i></span></button>'}
function scopeLibraryHtml(counts,palette,sf){
 const named=[].concat.apply([],SCOPE_SECTIONS.filter(s=>s.types).map(s=>s.types));
 return SCOPE_SECTIONS.map(s=>{
  const list=TASK_TYPES.map((x,i)=>({x,i})).filter(o=>pmTypeVisible(o.x.name)&&(s.types?s.types.indexOf(o.x.name)>=0:named.indexOf(o.x.name)<0));
  if(!list.length)return "";
  const total=list.reduce((a,o)=>a+(counts[o.x.name]||0),0);
  return '<div class="pm-scope-section" style="margin-top:14px"><div class="row between" style="margin-bottom:8px"><h3 style="font-size:12.5px;font-weight:700;letter-spacing:.2px">'+esc(s.title)+'</h3><span class="pill pillsm b-info">'+list.length+' equipment · '+total+' tasks</span></div><div class="sched-scope-grid">'+list.map(o=>scopeCardHtml(o.x,o.i,counts,palette,sf)).join("")+'</div></div>';
 }).join("");
}
"use strict";
/* ---------------- PLANNED / SCHEDULED O&M HUB ---------------- */
function goScheduledOM(part){
 S.view="om-module";S.omTab=part==="washing"?"washing":"scheduled";persistView();render();
}
function pmDisplayTaskName(task){
 /* Units (inverter 01, 02 ...) are quantities, not separate tasks: drop the trailing unit label so they group into one row. */
 let name=String(task&&task.name||"Unnamed task");
 if(task&&task.unitNo)name=name.replace(/\s+—\s+[^—]+$/,"");
 const ty=String(task&&task.type||"").trim();
 if(ty)name=name.replace(new RegExp("\\s+[—–-]\\s+"+ty.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\s*[#_-]?\\s*\\d+\\s*$","i"),"");
 return name.replace(/\s+[—–-]\s+(?:unit|no\.?)\s*#?\d+(?:\s+of\s+\d+)?$/i,"");
}
function pmDisplayTaskActivity(text){
 return String(text||"").replace(/\s*[—-]\s*unit\s+\d+\s+of\s+\d+,\s*day\s+\d+/ig,"");
}
async function exportScheduledOMCompliance(){
 try{await ensureXlsxLoaded()}catch(error){console.error("Could not load Excel export library",error);toast("Excel support could not load. Check your connection and retry.");return}
 const taskRows=(S.tasks||[]).map(t=>({
  "Work Order":t.id,"Plant":t.plant,"Task":pmDisplayTaskName(t),"Maintenance Type":t.type||"","Equipment":t.type||"","Frequency":t.freq||"",
  "Scheduled Date":t.due||"","Actual Completion":t.completion&&t.completion.date||"","Delay (days)":t.completion&&Number.isFinite(Number(t.completion.delay))?Number(t.completion.delay):"",
  "Assignee":t.assignee||"","Status":t.status||"","Readings / Measurements":t.completion&&t.completion.readings||"","Evidence Files":t.completion&&t.completion.photos||0,
  "Remarks / Anomalies":t.completion&&t.completion.remarks||"","Problem Found":t.completion&&t.completion.anomaly?"Yes":"No","Linked Issue":t.linkedIssue||""
 }));
 const washRows=(S.washing||[]).map(t=>{const meta=(S.washMeta||{})[t.plant]||{freq:14};const lw=lastWash(t);const ex=(t.history||[]).filter(h=>h.type==="exception").slice(-1)[0];return{
  "Plant":t.plant,"Table ID":t.tableId,"Primary Inverter":t.inv?"INV-"+pad2(t.inv):"","Secondary Inverter":t.invSecondary?"INV-"+pad2(t.invSecondary):"",
  "Frequency (days)":meta.freq||14,"Last Wash":lw||"","Days Since Last Wash":daysSince(t)===999?"Never":daysSince(t),"Next Due":t.rescheduledTo||t.nextDue||(lw?addDays(lw,meta.freq||14):""),
  "Status":washedToday(t)?"Washed today":excToday(t)?"Exception":wDue(t,meta.freq||14)?"Overdue":"Scheduled","Last Exception":ex?(ex.date+" · "+(ex.reason||"")):""
 }});
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(taskRows),"Preventive Maintenance");XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(washRows),"Washing");
 XLSX.writeFile(wb,"Solar91_Preventive_Maintenance_Compliance_"+(S.opsDate||TODAY)+".xlsx");
}
function renderScheduledHub(){
 const sub=S.omTab==="washing"?"washing":"maintenance";
 const taskODN=(S.tasks||[]).filter(t=>taskOD(t)>0).length;
 const washODN=(typeof washDueCount==="function")?washDueCount():0;
 return '<div class="pm-hub">'+
  '<div class="pm-page-header"><div><div class="kpi-label">SOLAR OPERATIONS · PLANNED WORK</div><h1>Preventive Maintenance</h1><p>Plan recurring field work, monitor completion, and keep each plant ready for reliable generation.</p></div>'+
  '<div class="pm-page-actions"><button class="btn o sm" onclick="exportScheduledOMCompliance()">'+I.dl(13)+' Export compliance</button><button class="btn o sm" onclick="window.print()">Print / PDF</button></div></div>'+
  '<div class="bn-info banner pm-guidance"><b>Planned vs. unplanned:</b> use this module for recurring work and washing. If execution reveals a fault, convert the completed task into a linked O&amp;M Issue.</div>'+
  '<div class="tabs pm-tabs"><div class="tab '+(sub==="maintenance"?"active":"")+'" onclick="goScheduledOM(&quot;maintenance&quot;)">Preventive Maintenance <span class="tabcount">'+taskODN+' overdue</span></div><div class="tab '+(sub==="washing"?"active":"")+'" onclick="goScheduledOM(&quot;washing&quot;)">Washing <span class="tabcount">'+washODN+' due</span></div></div>'+
  (sub==="washing"?renderWashing():renderScheduled())+'</div>';
}

function pmGroupTasksByEquipment(tasks){
 const groups=new Map();
 tasks.forEach(t=>{
  const equipment=t.type||"Equipment",name=pmDisplayTaskName(t),key=JSON.stringify([equipment,name]);
  if(!groups.has(key))groups.set(key,{key,equipment,name,tasks:[]});
  groups.get(key).tasks.push(t);
 });
 return [...groups.values()].sort((a,b)=>a.equipment.localeCompare(b.equipment)||a.name.localeCompare(b.name));
}
function pmGroupPlantKey(t){return t.plant||"__unassigned__"}
function pmGroupPlantName(value){return value==="__unassigned__"?"Plant not assigned":value}
const PM_ALL_PLANTS="__all_plants__";
function pmGroupOpenTasks(tasks){return tasks.filter(t=>t.status!=="Completed"&&t.status!=="Cancelled")}
/* Units (e.g. inverters) a plant has for this job: the plan's total when known, else one per open work order. */
function pmPlantUnits(tasks){const open=pmGroupOpenTasks(tasks).slice().sort((a,b)=>(a.due||"").localeCompare(b.due||"")),f=open.find(t=>t.totalUnits);return f?f.totalUnits:(open.length||tasks.filter(t=>t.status!=="Cancelled").length)}
function pmExpandGroupsAcrossPlants(groups,tasks){
 const allGroups=new Map(pmGroupTasksByEquipment(tasks).map(group=>[group.key,group.tasks]));
 return groups.map(group=>Object.assign({},group,{tasks:allGroups.get(group.key)||group.tasks}));
}
function pmGroupTaskActions(t,role,canAdmin){
 const id=esc(JSON.stringify(String(t.id||""))),canExecute=role==="O&M Head"||role==="Assignee"||(role==="Site Engineer"&&(!S._sePlant||t.plant===S._sePlant));
 let actions='<div class="action-rail">';
 if((role==="O&M Head"||role==="Assignee")&&t.status==="Scheduled")actions+='<button class="btn o sm" onclick="pmUnitPlanOpen('+id+')">Edit daily workload</button>';
 if((role==="O&M Head"||role==="Assignee")&&t.status!=="Completed"&&t.status!=="Cancelled")actions+='<button class="btn o sm" onclick="pmEditOpen('+id+')">Edit schedule</button>';
 if(canExecute&&t.status==="Scheduled")actions+='<button class="btn o sm" onclick="startTask('+id+')">Start</button>';
 if(canExecute&&t.status==="In Progress")actions+='<button class="btn p sm" onclick="openModal(\'complete\',{id:'+id+'})">Complete</button>';
 if(canAdmin)actions+='<button class="btn g sm" onclick="openModal(\'reassignTask\',{id:'+id+'})">Reassign</button>';
 if(canExecute&&t.completion&&t.completion.anomaly&&!t.linkedIssue)actions+='<button class="btn d sm" onclick="convertToIssue('+id+')">⚡ Convert to Issue</button>';
 if(!canExecute&&!canAdmin)actions+='<span class="muted" style="font-size:12.5px">View only</span>';
 return actions+'</div>';
}
function pmGroupedRegister(groups,kind,role,canAdmin){
 S._pmGroupRows=S._pmGroupRows||{};S._pmGroupRows[kind]=groups;
 S.pmGroupPlants=S.pmGroupPlants||{};S.pmExpandedGroups=S.pmExpandedGroups||{};
 if(!groups.length)return '<tr><td colspan="5" class="muted" style="padding:18px;text-align:center">'+(kind==="overdue"?"No overdue work orders for the selected scope.":"No scheduled work orders match the current filters.")+'</td></tr>';
 return groups.map((group,index)=>{
  const plants=[...new Set(group.tasks.map(pmGroupPlantKey))].sort((a,b)=>pmGroupPlantName(a).localeCompare(pmGroupPlantName(b)));
  const selected=S.pmGroupPlants[group.key],scope=S.schedScope;
  const plant=selected===PM_ALL_PLANTS?PM_ALL_PLANTS:plants.includes(selected)?selected:plants.includes(scope)?scope:PM_ALL_PLANTS;
  S.pmGroupPlants[group.key]=plant;
  const allPlants=plant===PM_ALL_PLANTS;
  const tasks=(allPlants?pmGroupOpenTasks(group.tasks):group.tasks.filter(t=>pmGroupPlantKey(t)===plant)).sort((a,b)=>(a.due||"").localeCompare(b.due||"")||String(a.id).localeCompare(String(b.id)));
  const open=pmGroupOpenTasks(tasks),overdue=open.filter(t=>taskOD(t)>0);
  const expandedKey=kind+":"+group.key,expanded=!!S.pmExpandedGroups[expandedKey];
  const unitsByPlant={};plants.forEach(p=>{unitsByPlant[p]=pmPlantUnits(group.tasks.filter(t=>pmGroupPlantKey(t)===p))});
  const unitsAll=plants.reduce((a,p)=>a+unitsByPlant[p],0),plural=(n,w)=>n+" "+w+(n===1?"":"s");
  const statOf=p=>{const o=pmGroupOpenTasks(group.tasks.filter(t=>pmGroupPlantKey(t)===p));return{open:o.length,od:o.filter(t=>taskOD(t)>0).length}};
  const stats={};plants.forEach(p=>{stats[p]=statOf(p)});const odAll=plants.reduce((a,p)=>a+stats[p].od,0);
  const tag=n=>n?" · ⚠ "+n+" overdue":" · on track";
  const options='<option value="'+PM_ALL_PLANTS+'"'+(allPlants?" selected":"")+'>All plants · '+plural(plants.length,"plant")+' · '+plural(unitsAll,"unit")+tag(odAll)+'</option>'+plants.map(p=>'<option value="'+esc(p)+'"'+(p===plant?" selected":"")+'>'+esc(pmGroupPlantName(p))+' · '+plural(unitsByPlant[p],"unit")+tag(stats[p].od)+'</option>').join("");
  const oldest=overdue[0],tier=oldest?escTier(oldest):0,nextDue=open.find(t=>taskOD(t)===0);
  const overdueCell=overdue.length?'<span class="pill pillsm b-danger">'+overdue.length+' overdue</span><small class="pm-group-meta">Oldest due '+fmtD(oldest.due)+' · '+taskOD(oldest)+' day'+(taskOD(oldest)===1?"":"s")+' late'+(tier?' · '+ESC_M[tier-1].a:"")+'</small>':'<span class="pill pillsm b-success">On track</span>'+(nextDue?'<small class="pm-group-meta">Next due '+fmtD(nextDue.due)+'</small>':"");
  let html='<tr class="pm-group-row"><td><div class="pm-group-equipment">'+esc(group.equipment)+'</div><div class="pm-group-task">'+esc(group.name)+'</div>'+(overdue.length?'<span class="pm-group-alert">'+overdue.length+' past due date</span>':"")+'</td>'+
   '<td><select class="sel pm-group-plant" aria-label="Select plant for '+esc(group.equipment+" "+group.name)+'" onchange="pmWorkOrderPlant(\''+kind+'\','+index+',this.value)">'+options+'</select></td>'+
   '<td><b>'+open.length+'</b> open<small class="pm-group-meta">'+(allPlants?plural(tasks.length,"work order")+' · '+plural(unitsAll,"unit")+' across '+plural(plants.length,"plant"):plural(tasks.length,"work order")+' · '+plural(unitsByPlant[plant]||0,"unit")+' at this plant')+'</small></td><td>'+overdueCell+'</td>'+
   '<td><button class="btn o sm" type="button" aria-expanded="'+expanded+'" onclick="pmWorkOrderToggle(\''+kind+'\','+index+')">'+(expanded?"Hide":"View")+' work orders</button></td></tr>';
  if(!expanded)return html;
  const detailRows=tasks.map(t=>{
   const od=taskOD(t),status=t.status==="Completed"?"Completed":t.status==="Cancelled"?"Cancelled":t.status==="In Progress"?"In Progress":od?"Overdue":"Scheduled";
    const late=od>0&&t.status!=="Cancelled"?'<small class="pm-group-late">'+od+' day'+(od===1?"":"s")+' overdue</small>':"";
    return '<tr class="click" onclick="if(!event.target.closest(\'button\'))openModal(\'taskDetail\',{id:'+esc(JSON.stringify(String(t.id||""))) +'})"><td><b>'+esc(t.id)+'</b><div class="pm-group-meta">'+esc(group.equipment)+'</div></td>'+(allPlants?'<td class="pm-plant-label">'+pmPlantLabelHtml(t.plant)+'</td>':'')+'<td>'+esc(t.freq||"—")+'</td><td>'+fmtD(t.due)+late+'</td><td>'+esc(t.assignee||"Unassigned")+'</td><td>'+badge(status)+'</td><td>'+pmGroupTaskActions(t,role,canAdmin)+'</td></tr>';
  }).join("");
  return html+'<tr class="pm-group-detail"><td colspan="5"><div class="pm-group-detail-scroll"><table><thead><tr><th>Work order</th>'+(allPlants?'<th>Plant</th>':'')+'<th>Frequency</th><th>Due</th><th>Assignee</th><th>Status</th><th>Actions</th></tr></thead><tbody>'+detailRows+'</tbody></table></div></td></tr>';
 }).join("");
}
window.pmWorkOrderPlant=function(kind,index,value){
 const group=((S._pmGroupRows||{})[kind]||[])[index];
 if(!group||(value!==PM_ALL_PLANTS&&!group.tasks.some(t=>pmGroupPlantKey(t)===value)))return;
 S.pmGroupPlants=S.pmGroupPlants||{};S.pmGroupPlants[group.key]=value;render();
};
window.pmWorkOrderToggle=function(kind,index){
 const group=((S._pmGroupRows||{})[kind]||[])[index];if(!group)return;
 const key=kind+":"+group.key;S.pmExpandedGroups=S.pmExpandedGroups||{};S.pmExpandedGroups[key]=!S.pmExpandedGroups[key];render();
};

/* ---------------- 2.1 SCHEDULED ---------------- */
function renderScheduled(){
 const sf=S.schedF||{}; if(!sf.asset)sf.asset="all";
 const role=(S._roleLabel||S.currentRole||"O&M Head");
 if(!S.schedScope)S.schedScope="all";
 let allPlantBase=S.tasks;
 if(role==="Site Engineer"&&S._sePlant)allPlantBase=allPlantBase.filter(t=>t.plant===S._sePlant);
 if(role==="Vendor (limited)")allPlantBase=[];
 let base=S.schedScope==="all"?allPlantBase:allPlantBase.filter(t=>t.plant===S.schedScope);
 const taskViewStatus=t=>t.status==="Completed"||t.status==="Cancelled"?t.status:taskOD(t)>0?"Overdue":t.status;
 const matchesFilters=t=>(t.status!=="Cancelled"||sf.status==="Cancelled")&&(sf.assignee==="all"||!sf.assignee||t.assignee===sf.assignee)&&(sf.status==="all"||!sf.status||taskViewStatus(t)===sf.status)&&(sf.freq==="all"||!sf.freq||t.freq===sf.freq)&&(sf.asset==="all"||t.type===sf.asset)&&(!sf.dashEquip||sf.dashEquip==="all"||ccDashboardEquipmentMatches(t,sf.dashEquip))&&(!sf.queue||(sf.queue==="overdue"?taskOD(t)>0:sf.queue==="due7"?taskOD(t)===0&&dayDiff(TODAY,t.due)>=0&&dayDiff(TODAY,t.due)<=7:sf.queue==="upcoming"?taskOD(t)===0&&!(dayDiff(TODAY,t.due)>=0&&dayDiff(TODAY,t.due)<=7):true))&&(!sf.from||t.due>=sf.from)&&(!sf.to||t.due<=sf.to)&&(!sf.q||[t.name,t.type,t.equip,t.assignee,t.plant].join(" ").toLowerCase().includes(sf.q.toLowerCase()));
 const filtered=base.filter(matchesFilters);
 S._pmAllPlantRegisterTasks=allPlantBase.filter(matchesFilters).slice().sort((a,b)=>sf.sort==="name"?a.name.localeCompare(b.name):sf.sort==="status"?taskViewStatus(a).localeCompare(taskViewStatus(b)):a.due.localeCompare(b.due));
 const schedPeople=[...new Set(base.map(t=>t.assignee))].sort(),schedStatuses=[...new Set(base.map(taskViewStatus))].sort(),schedFreqs=[...new Set(base.map(t=>t.freq))].sort();
 const scoped=filtered.slice().sort((a,b)=>sf.sort==="name"?a.name.localeCompare(b.name):sf.sort==="status"?taskViewStatus(a).localeCompare(taskViewStatus(b)):a.due.localeCompare(b.due));S._pmRegisterTasks=scoped;
 const tableSize=LIST_SIZE,tableRows=pageRows("scheduled",scoped,tableSize);
 const overdue=scoped.filter(t=>t.status!=="Cancelled"&&taskOD(t)>0),done=scoped.filter(t=>t.status==="Completed"),inProgress=scoped.filter(t=>t.status==="In Progress"),scheduled=scoped.filter(t=>t.status==="Scheduled"&&taskOD(t)===0);
 const buckets={"0–3 days":overdue.filter(t=>taskOD(t)<3).length,"3–7 days":overdue.filter(t=>taskOD(t)>=3&&taskOD(t)<=7).length,">7 days":overdue.filter(t=>taskOD(t)>7).length};
 const up7=scoped.filter(t=>t.status!=="Completed"&&dayDiff(TODAY,t.due)>0&&dayDiff(TODAY,t.due)<=7).length,up30=scoped.filter(t=>t.status!=="Completed"&&dayDiff(TODAY,t.due)>0&&dayDiff(TODAY,t.due)<=30).length;
 const period=S.schedPeriod||"month",periodStart=schedPeriodStart(period),periodDone=done.filter(t=>t.completion&&t.completion.date>=periodStart&&t.completion.date<=TODAY),onTime=periodDone.filter(t=>t.completion&&t.completion.delay<=0).length,adh=periodDone.length?Math.round(100*onTime/periodDone.length):0;
 const donePct=scoped.length?Math.round(done.length/scoped.length*100):0,odPct=scoped.length?Math.round(overdue.length/scoped.length*100):0;
 const people={};scoped.filter(t=>t.status!=="Completed").forEach(t=>people[t.assignee]=(people[t.assignee]||0)+1);const wl=Object.entries(people).sort((a,b)=>b[1]-a[1]),wmx=Math.max(1,...wl.map(x=>x[1]));
 const counts={};scoped.forEach(t=>counts[t.type]=(counts[t.type]||0)+1);
 const openTypeCounts={};base.filter(t=>t.status!=="Completed"&&t.status!=="Cancelled").forEach(t=>openTypeCounts[t.type||"Uncategorized"]=(openTypeCounts[t.type||"Uncategorized"]||0)+1);
 const palette=["#0c5e2a","#3B82F6","#D97706","#8B5CF6","#0F9F8C","#F97316","#6675D9","#94A3B8","#16A34A","#DC4C3E"];
 const statusCounts={};scoped.forEach(t=>{const label=taskViewStatus(t);statusCounts[label]=(statusCounts[label]||0)+1});
 const statusColors={"Scheduled":"#6675D9","In Progress":"#3B82F6","Overdue":"#DC4C3E","Completed":"#16A34A"};
 const statusLabels=["Scheduled","In Progress","Overdue","Completed",...Object.keys(statusCounts).filter(x=>!["Scheduled","In Progress","Overdue","Completed"].includes(x))];
 const statusSlices=statusLabels.filter(label=>statusCounts[label]>0).map(label=>({label,n:statusCounts[label],color:statusColors[label]||"#94A3B8"}));
 const assetRows=Object.entries(counts).sort((a,b)=>b[1]-a[1]),assetMax=Math.max(1,...assetRows.map(x=>x[1]));
 const openAssetRows=Object.entries(openTypeCounts).sort((a,b)=>b[1]-a[1]),openAssetMax=Math.max(1,...openAssetRows.map(x=>x[1]));
 const plantOptions=(S.plants||[]).filter(p=>role!=="Site Engineer"||!S._sePlant||p.name===S._sePlant);
 const plantScopeOptions='<option value="all" '+(S.schedScope==="all"?"selected":"")+'>All plants</option>'+plantOptions.map(p=>'<option value="'+esc(p.name)+'" '+(S.schedScope===p.name?"selected":"")+'>'+esc(pmPlantLabelText(p.name))+'</option>').join("");
 const categoryOptions=['<option value="all">All categories</option>',...([...new Set(allPlantBase.map(t=>t.type).filter(Boolean))].sort().map(type=>'<option value="'+esc(type)+'" '+(sf.asset===type?"selected":"")+'>'+esc(type)+'</option>'))].join("");
 const freqOrder=["Daily","Weekly","Monthly","Quarterly","Half-yearly","Annual"],freqSlices=freqOrder.map((f,i)=>({label:f,n:scoped.filter(t=>t.freq===f).length,color:palette[(i+2)%palette.length]})).filter(x=>x.n>0);
 const upcoming=scoped.filter(t=>t.status!=="Completed"&&t.due&&t.due>=TODAY).sort((a,b)=>a.due.localeCompare(b.due)).slice(0,5);
 let hm="";for(let d=1;d<=30;d++){const iso=TODAY.slice(0,7)+"-"+pad2(d),ds=scoped.filter(t=>t.completion&&t.completion.date===iso),due=scoped.filter(t=>t.due===iso&&t.status!=="Completed");let c="var(--muted)",ttl=iso+" · no recorded task activity";if(ds.length){const late=ds.filter(t=>t.completion.delay>0).length;c=late?"var(--warning)":"var(--success)";ttl=iso+" · "+ds.length+" completed"+(late?" ("+late+" late)":" on time")}else if(due.length&&iso<=TODAY){c="var(--danger)";ttl=iso+" · "+due.length+" due / not completed"}hm+='<div title="'+ttl+'" style="background:'+c+';opacity:'+(iso>TODAY?0.5:1)+'"></div>';}
 const canAdmin=role==="O&M Head",canReadOnly=["Administration","Client / Asset Owner","Vendor (limited)"].includes(role);
 let h='<div class="pm-monitor">'+
 '<div class="panel solar-card-glow pm-monitor-hero"><div class="pm-monitor-hero-copy"><div><div class="kpi-label">MAINTENANCE PERFORMANCE</div><h2>Work orders at a glance</h2><p>Live completion, due-date and team workload indicators for the selected portfolio.</p></div><div class="pm-monitor-context"><span class="pill pillsm b-info">'+esc(role)+'</span><span class="pill pillsm b-muted">'+(S.schedScope==="all"?"All plants":esc(S.schedScope))+'</span><span class="pm-task-count">'+scoped.length+' visible work orders</span></div></div></div>'+
 '<div class="pm-period-row"><div class="pm-period-switch" role="group" aria-label="Tracking window"><span>TRACKING WINDOW</span>'+[["month","This month"],["quarter","This quarter"],["ytd","YTD"]].map(x=>'<button type="button" class="'+(period===x[0]?"active":"")+'" aria-pressed="'+(period===x[0])+'" onclick="S.schedPeriod=\''+x[0]+'\';render()">'+x[1]+'</button>').join("")+'</div><div class="pm-period-note">Scheduled date vs actual completion · delay and recurrence calculated automatically</div></div>'+
 



 
 
'<div class="kgrid pm-analysis-grid" style="grid-template-columns:1fr;align-items:stretch"><div class="panel pm-category-panel"><div class="pm-section-heading"><div><h2>Open work by equipment category</h2><p>Open work-order totals across the selected plant scope</p></div><span>'+openAssetRows.length+' categories · '+Object.values(openTypeCounts).reduce((a,b)=>a+b,0)+' open work orders</span></div>'+(openAssetRows.length?'<div class="pm-asset-bars">'+openAssetRows.map(x=>'<button type="button" class="pm-asset-row" title="'+esc(x[0]+": "+x[1]+" open work orders")+'" onclick="S.schedF.asset=\''+esc(x[0]).replace(/&#39;/g,"\\'")+'\';S.tablePages.scheduled=1;render()"><span class="pm-asset-label">'+esc(x[0])+'</span><span class="pm-bar-track"><i style="width:'+Math.max(3,Math.round(x[1]*100/openAssetMax))+'%;background:#25804a"></i></span><b>'+x[1]+'</b></button>').join("")+'</div>':emptyState("No open work orders","There is no active PM work in the selected plant scope."))+'</div></div>'+
 
 '<div class="kgrid pm-action-grid" style="grid-template-columns:1fr;align-items:stretch">'+
 '<div class="panel pm-upcoming-panel"><div class="pm-section-heading"><div><h2>Upcoming maintenance</h2><p>Nearest scheduled work in the current scope</p></div><span>Next '+up7+' in 7 days</span></div>'+(upcoming.length?'<div class="pm-upcoming-list">'+upcoming.map(t=>{const d=dayDiff(TODAY,t.due),when=d<=0?"Today":d===1?"Tomorrow":fmtD(t.due);return '<div class="pm-upcoming-item"><span class="pm-upcoming-date">'+esc(when)+'</span><span class="pm-upcoming-marker"></span><span class="pm-upcoming-copy"><b>'+esc(pmDisplayTaskName(t))+'</b><small>'+pmPlantLabelHtml(t.plant)+' · '+esc(t.assignee||"Unassigned")+'</small></span></div>'}).join("")+'</div>':emptyState("No upcoming maintenance","No future scheduled work is available in this selected scope."))+'</div></div>';
 h+='<div id="section-results" class="panel" style="padding:0"><div style="padding:16px 20px 0"><div class="row between wrap"><div><h2 style="font-size:15px;font-weight:600">Preventive Maintenance work orders</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">Recurring maintenance · planned vs actual · readings / measurements · photo evidence · anomaly → linked Site Issue</p></div><span class="pill pillsm b-info">'+scoped.length+' visible</span></div></div>';
 h+='<div class="row wrap" style="gap:8px;padding:0 20px 12px"><input class="inp" style="flex:1;min-width:190px" placeholder="Search equipment, task, plant or assignee" value="'+esc(sf.q||"")+'" onchange="S.schedF.q=this.value;S.tablePages.scheduled=1;render()"/><select class="sel" aria-label="Filter equipment category" onchange="S.schedF.asset=this.value;S.tablePages.scheduled=1;render()"><option value="all">All categories</option>'+[...new Set(base.map(t=>t.type).filter(Boolean))].sort().map(x=>'<option value="'+esc(x)+'" '+(sf.asset===x?'selected':'')+'>'+esc(x)+'</option>').join("")+'</select><select class="sel" aria-label="Filter status" onchange="S.schedF.status=this.value;S.tablePages.scheduled=1;render()"><option value="all">All active statuses</option>'+[...new Set(base.map(taskViewStatus))].sort().map(x=>'<option value="'+esc(x)+'" '+(sf.status===x?'selected':'')+'>'+esc(x)+'</option>').join("")+'</select><select class="sel" aria-label="Filter frequency" onchange="S.schedF.freq=this.value;S.tablePages.scheduled=1;render()"><option value="all">All frequencies</option>'+[...new Set(base.map(t=>t.freq).filter(Boolean))].sort().map(x=>'<option value="'+esc(x)+'" '+(sf.freq===x?'selected':'')+'>'+esc(x)+'</option>').join("")+'</select></div>';
 if(sf.queue){const queueLabel=sf.queue==="overdue"?"Overdue":sf.queue==="due7"?"Due in 7 days":"Upcoming";h+='<div class="cc-drill-filter"><span>Command Center filter: <b>'+queueLabel+'</b>'+(sf.dashEquip&&sf.dashEquip!=="all"?' · '+esc(equipmentFilterLabel(sf.dashEquip)):"")+'</span><button class="btn o sm" onclick="delete S.schedF.queue;delete S.schedF.dashEquip;S.tablePages.scheduled=1;render()">Clear drill-down</button></div>'}
 h+='<table><thead><tr><th>Equipment / task</th><th>Plant code · full name</th><th>Freq</th><th>Due</th><th>Assignee</th><th>Status</th><th>Delay</th><th>Actions</th></tr></thead><tbody>';
 tableRows.forEach(t=>{const od=taskOD(t),tier=escTier(t),canExecute=role==="O&M Head"||role==="Assignee"||(role==="Site Engineer"&&(!S._sePlant||t.plant===S._sePlant));let acts='<div class="action-rail">';if((role==="O&M Head"||role==="Assignee")&&t.status==="Scheduled")acts+='<button class="btn o sm" onclick="pmUnitPlanOpen(\''+t.id+'\')">Edit daily workload</button>';if(role==="Assignee"&&t.status!=="Completed"&&t.status!=="Cancelled")acts+='<button class="btn o sm" onclick="pmEditOpen(\''+t.id+'\')">Edit dates</button>';if(canExecute&&t.status==="Scheduled")acts+='<button class="btn o sm" onclick="startTask(\''+t.id+'\')">Start</button>';if(canExecute&&t.status==="In Progress")acts+='<button class="btn p sm" onclick="openModal(\'complete\',{id:\''+t.id+'\'})">Complete</button>';if(canAdmin)acts+='<button class="btn g sm" onclick="openModal(\'reassignTask\',{id:\''+t.id+'\'})">Reassign</button>';if(canExecute&&t.completion&&t.completion.anomaly&&!t.linkedIssue)acts+='<button class="btn d sm" onclick="convertToIssue(\''+t.id+'\')">⚡ Convert to Issue</button>';if(!canExecute&&!canAdmin)acts+='<span class="muted" style="font-size:12.5px">View only</span>';acts+='</div>';h+='<tr class="click'+(S.flashId===t.id?' flash-new':'')+'" data-rid="'+t.id+'" onclick="if(!event.target.closest(\'button\'))openModal(\'taskDetail\',{id:\''+t.id+'\'})"><td style="min-width:230px"><div class="pm-task-equipment">'+esc(t.type||"Equipment not specified")+'</div><div class="pm-task-name">'+esc(pmDisplayTaskName(t))+'</div><div class="pm-task-general">Daily workload · '+badge(t.type||"Equipment")+'</div>'+(t.completion?'<div class="pm-task-detail">Done '+fmtD(t.completion.date)+' · '+esc(t.completion.readings)+' · 📷 '+scheduledEvidenceCount(t)+' · '+esc(t.completion.remarks)+'</div>':'')+(scheduledEvidenceCount(t)?'<div class="active-sched-thumb" style="margin-top:5px">'+scheduledEvidenceThumbs(t,3)+'</div>':'')+(t.linkedIssue?'<div style="margin-top:3px">'+badge("Linked: "+t.linkedIssue)+'</div>':'')+'</td><td class="pm-plant-label">'+pmPlantLabelHtml(t.plant)+'</td><td>'+t.freq+'</td><td class="nowrap">'+fmtD(t.due)+(od>0&&!t.completion?'<div class="flag" style="color:var(--danger)">'+ESC_M[tier-1].a+'</div>':'')+'</td><td class="nowrap">'+esc(t.assignee)+'</td><td>'+badge(t.status==="Completed"?"Completed":t.status==="Cancelled"?"Cancelled":t.status==="In Progress"?"In Progress":od?"Overdue":"Scheduled")+(t.completion&&t.completion.anomaly?'<div style="margin-top:3px">'+badge("Critical")+'</div>':'')+'</td><td>'+(t.completion?badge(t.completion.delay>0?"+"+t.completion.delay+"d late":"On track"):"—")+'</td><td>'+acts+'</td></tr>';});
 h+='</tbody></table>'+tablePager("scheduled",scoped.length,tableSize)+'</div></div>';
 return h;
}





const pmOriginalScheduledRegister=renderScheduled;
renderScheduled=function(){
 const originalHtml=pmOriginalScheduledRegister.apply(this,arguments);
 const tasks=S._pmRegisterTasks||[],groups=pmGroupTasksByEquipment(tasks);
 const html=originalHtml.replace(
  "Recurring maintenance · planned vs actual · readings / measurements · photo evidence · anomaly → linked Site Issue",
  "One compact row per equipment/task. Choose a plant to review and edit its individual work orders."
 ).replace('<span class="pill pillsm b-info">'+tasks.length+' visible</span>','<span class="pill pillsm b-info">'+groups.length+' equipment tasks · '+tasks.length+' work orders</span>');
 const marker='<table><thead><tr><th>Equipment / task</th><th>Plant code · full name</th>';
 const start=html.indexOf(marker);
 if(start<0){console.error("[PM register] Could not find the work-order table to compact.");return html}
 const pager=html.indexOf('<div class="table-pager">',start);
 const pagerClose=pager<0?-1:html.indexOf("</div></div>",pager);
 const panelClose=pagerClose<0?-1:html.indexOf("</div></div>",pagerClose+("</div></div>".length));
 if(pagerClose<0||panelClose<0){console.error("[PM register] Could not locate the work-order table boundaries.");return html}
 const allPlantTasks=S._pmAllPlantRegisterTasks||tasks;
 const allPlantGroups=pmExpandGroupsAcrossPlants(groups,allPlantTasks);
 const overdue=pmExpandGroupsAcrossPlants(pmGroupTasksByEquipment(tasks.filter(t=>t.status!=="Cancelled"&&taskOD(t)>0)),allPlantTasks.filter(t=>t.status!=="Cancelled"&&taskOD(t)>0));
 const pageGroups=pageRows("scheduledGroups",allPlantGroups,LIST_SIZE);
 const role=S._roleLabel||S.currentRole||"O&M Head",canAdmin=role==="O&M Head";
 const register='<div class="pm-group-table-scroll"><table class="pm-group-table"><thead><tr><th>Equipment / task</th><th>Plant</th><th>Open work</th><th>Due-date alert</th><th></th></tr></thead><tbody>'+pmGroupedRegister(pageGroups,"work",role,canAdmin)+'</tbody></table></div>'+tablePager("scheduledGroups",groups.length,LIST_SIZE);
 const overduePanel='<div class="panel pm-overdue-register"><div class="row between wrap"><div><h2>Overdue preventive work</h2><p>Uncompleted work orders past their scheduled due date. Select a plant to review and act on its overdue equipment/tasks.</p></div><span class="pill pillsm b-danger">'+tasks.filter(t=>t.status!=="Cancelled"&&taskOD(t)>0).length+' overdue</span></div><div class="pm-group-table-scroll"><table class="pm-group-table"><thead><tr><th>Equipment / task</th><th>Plant</th><th>Past-due work</th><th>Oldest due</th><th></th></tr></thead><tbody>'+pmGroupedRegister(overdue,"overdue",role,canAdmin)+'</tbody></table></div></div>';
 return html.slice(0,start)+register+html.slice(pagerClose+("</div></div>".length),panelClose+("</div></div>".length))+overduePanel+html.slice(panelClose+("</div></div>".length));
};

/* ---------------- 2.2 WASHING ---------------- */
