"use strict";
/* Plant washing: tables cleaned per day roll up into cycles (3 per month, due 10th / 20th / month-end),
   weekly compliance target, overdue 1/3/7 matrix, plant overlay with before/after photos and O&M confirmation. */
(function(){
 const role=()=>S._roleLabel||S.currentRole||"O&M Head";
 /* O&M team = O&M Head + every Assignee (same washing powers). Site Engineers are field users: they only report counts. */
 const isTeam=()=>role()==="O&M Head"||role()==="Assignee";
 const isField=()=>role()==="Site Engineer";
 const h=v=>typeof esc==="function"?esc(v==null?"":String(v)):String(v==null?"":v);
 const plantOptions=()=>((S.plants||[]).filter(p=>role()!=="Site Engineer"||!S._sePlant||p.name===S._sePlant));
 const plural=(n,w)=>n+" "+w+(n===1?"":"s");
 const fmt=iso=>{if(!iso)return "—";const d=new Date(iso+"T00:00:00");return isNaN(d)?iso:d.toLocaleDateString("en-GB",{day:"2-digit",month:"short"})};
 const EMPTY={plants:[],reports:[],unconfigured:[],cycle_events:[],portfolio:{},overdue_matrix:{on_track:0,"1d":0,"3d":0,"7d":0},monthly:[]};
 const data=()=>S._washCycles||EMPTY;
 const rowOf=id=>(data().plants||[]).find(p=>p.plant_id===id);
 const plantIdOf=p=>String(p.dbId||p.id);
 const setupDefaults=plantId=>{const row=rowOf(String(plantId));return{plantId:String(plantId),tables:row?String(row.table_count):"",assignee:row&&row.assignee_user_id?row.assignee_user_id:"",threshold:String(row?row.compliance_threshold_percent:85)}};
 /* red/critical tones are for the O&M team only; field users never see them */
 const dtone=st=>{const t=DAYTONE[st]||"mute";return isTeam()||t!=="crit"?t:"mute"};
 const todayOf=p=>((p.daily_status||[]).slice(-1)[0]||{}).date||"";
 const lastAct=p=>[p.last_report_date].concat((p.cycles||[]).map(c=>c.completed_on)).filter(Boolean).sort().pop()||"";
 const ago=(iso,ref)=>{if(!iso)return "No report yet";const n=Math.round((new Date((ref||iso)+"T00:00:00")-new Date(iso+"T00:00:00"))/864e5);return n<=0?"Today":n===1?"Yesterday":n+" days ago"};
 const chip=(t,tone)=>'<span class="wc-chip wc-'+tone+'">'+h(t)+'</span>';
 const BUCKETS=[["on_track","On track","No cycle past its deadline","ok"],["1d","1+ day late","1–2 days past deadline","warn"],["3d","3+ days late","3–6 days past deadline","hot"],["7d","7+ days late","7 or more days","crit"]];
 const TONE={on_track:"ok","1d":"warn","3d":"hot","7d":"crit"};
 const DAYTONE={"Confirmed":"ok","Awaiting review":"info","Exception":"warn","Rejected":"crit","No report":"crit","Not reported yet":"mute"};
 const onWashing=()=>S.view==="dashboard"||(S.view==="om-module"&&S.omTab==="washing");

 async function loadOverview(){
  if(S._washCycleLoading)return S._washCycleLoading;
  S._washCycleLoading=apiFetch("/api/scheduled/washing/overview"+(S._washReportDays?"?report_days="+S._washReportDays:"")).then(d=>{S._washCycles=d;S._washCycleError=null;S._washCycleLoading=null;if(onWashing())render();return d}).catch(e=>{S._washCycleLoading=null;S._washCycleError=e;if(onWashing())render();throw e});
  return S._washCycleLoading;
 }
 window.washCyclesEnsureLoaded=function(){if(!S._washCycles&&!S._washCycleLoading&&!S._washCycleError)loadOverview().catch(()=>{})};
 window.washHasData=()=>!!(S._washCycles&&((S._washCycles.plants||[]).length));
 window.washDueCount=()=>{const m=data().overdue_matrix||{};return (m["1d"]||0)+(m["3d"]||0)+(m["7d"]||0)};
 window.washCompliancePct=()=>{const p=data().portfolio||{};return typeof p.weekly_compliance_percent==="number"?p.weekly_compliance_percent:100};

 function plantSetupModal(){
  const plants=plantOptions();
  if(!plants.length)return modal("Set up plant washing","No plants are available to set up.","<p class=\"muted\">Add a plant first, then come back here.</p>",'<button class="btn o" onclick="closeModal()">Close</button>');
  let draft=S.washSetupDraft;
  if(!draft||!plants.some(p=>plantIdOf(p)===draft.plantId)){
   const wanted=plants.find(p=>p.dbId===S.washSetupPlant||p.id===S.washSetupPlant||p.name===S.washSetupPlant)||plants[0];
   draft=S.washSetupDraft=setupDefaults(plantIdOf(wanted));
  }
  const assignees=S._washAssignees||[];
  const options='<option value="">Select an Assignee</option>'+assignees.map(a=>'<option value="'+h(a.id)+'"'+(a.id===draft.assignee?" selected":"")+'>'+h(a.name)+(a.has_washing_scope?"":" (will be given Tables cleaning)")+'</option>').join("");
  const hint=assignees.length?"":'<div class="bn-warn banner" style="margin-top:10px">No active user has the Assignee role yet. In <b>Settings → Team access</b>, set a user\'s role to Assignee, then reopen this form.</div>';
  const nextSteps='<div class="wc-flow-note"><b>What happens after setup</b><ol><li>Assign a Site Engineer to this plant in <b>Settings → Team access</b>.</li><li>The Site Engineer submits daily cleaned-table counts with before and after photos.</li><li>Open <b>Cycle &amp; reports</b> to edit a report, add missing photos, and confirm it.</li></ol><small>A cycle completes when all registered tables are confirmed. The next cycle starts automatically.</small></div>';
  return modal("Set up plant washing","Set the plant table count and the Assignee responsible for this site.",
   '<div class="pm-form"><div class="field"><span class="lbl">Plant</span><select id="wc-plant" class="inp" onchange="washSetupPlantChanged()">'+plants.map(p=>'<option value="'+h(plantIdOf(p))+'"'+(plantIdOf(p)===draft.plantId?" selected":"")+'>'+h(typeof pmPlantLabelText==="function"?pmPlantLabelText(p.name):p.name)+'</option>').join("")+'</select></div>'+
   '<div class="kgrid" style="grid-template-columns:1fr 1fr;gap:12px"><div class="field"><span class="lbl">Number of tables</span><input id="wc-tables" class="inp" type="number" min="1" max="5000" value="'+h(draft.tables)+'" placeholder="e.g. 120" oninput="washSetupDraftChanged()"/></div><div class="field"><span class="lbl">Washing Assignee</span><select id="wc-assignee" class="inp" onchange="washSetupDraftChanged()">'+options+'</select></div></div>'+
   '<div class="field"><span class="lbl">Alert when weekly compliance falls below (%)</span><input id="wc-threshold" class="inp" type="number" min="1" max="100" value="'+h(draft.threshold)+'" oninput="washSetupDraftChanged()"/></div>'+hint+nextSteps+'</div>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="saveWashingSetup()">Save plant setup</button>',true);
 }

 function readSetupForm(){
  const val=id=>{const e=document.getElementById(id);return e?e.value:null};
  return{plantId:val("wc-plant"),tables:val("wc-tables"),assignee:val("wc-assignee"),threshold:val("wc-threshold")};
 }
 window.washSetupDraftChanged=function(){
  const f=readSetupForm();if(f.plantId===null)return;
  S.washSetupDraft=Object.assign({},S.washSetupDraft||{},f);
 };
 window.washClearFilters=function(){const ui=S._washUi;Object.assign(ui,{plant:"all",q:"",bucket:"all",show:"all",state:"all",cyc:"all",assignee:"all",region:"all",sort:"late",page:1});S.washF=Object.assign({},ui);const el=document.getElementById("wc-register");if(el)el.innerHTML=registerHtml();render()};
 window.washSetupPlantChanged=function(){
  const f=readSetupForm();if(!f.plantId)return;
  /* switching plant loads that plant's saved values; nothing typed for the previous plant is carried over */
  S.washSetupDraft=setupDefaults(f.plantId);S.washSetupPlant=f.plantId;
  render();
 };

 window.openWashingSetup=async function(plant){
  if(!isTeam()){toast("Only the O&M team (O&M Head or Assignee) can set up plant washing.");return}
  try{
   S._washAssignees=await apiFetch("/api/scheduled/washing/assignees");
   if(!S._washCycles){try{await loadOverview()}catch(e){}}
   S.washSetupPlant=plant||"";S.washSetupDraft=null;
   S.modal="washingCycleSetup";S.modalCtx={};render();
  }catch(error){toast(detailOf(error,"Unable to load washing Assignees."))}
 };

 function detailOf(error,fallback){
  const d=error&&error.data&&error.data.detail;
  if(typeof d==="string")return d;
  if(Array.isArray(d))return d.map(x=>(x.msg||"")).filter(Boolean).join("; ")||fallback;
  return(error&&error.message)||fallback;
 }

 window.saveWashingSetup=async function(){
  const f=readSetupForm();
  const count=Number(f.tables),complianceThreshold=Number(f.threshold);
  if(!f.plantId){toast("Select a plant.");return}
  if(!Number.isInteger(count)||count<1||count>5000){toast("Enter the number of tables (1 to 5000).");return}
  if(!f.assignee){toast("Select the washing Assignee.");return}
  if(!Number.isInteger(complianceThreshold)||complianceThreshold<1||complianceThreshold>100){toast("The alert threshold must be between 1 and 100.");return}
  try{
   await apiFetch("/api/scheduled/washing/setup",{method:"POST",body:{plant_id:f.plantId,table_count:count,assignee_user_id:f.assignee,compliance_threshold_percent:complianceThreshold}});
   S.washCyclePlant=f.plantId;S.washSetupDraft=null;
   try{await loadOverview()}catch(e){}
   if(rowOf(f.plantId)){openWashingPlantDetails(f.plantId);toast("Setup saved. Cycle & reports is open.")}
   else{S.modal=null;render();toast("Setup saved. Open Cycle & reports when the plant list refreshes.")}
  }catch(error){toast(detailOf(error,"Unable to save plant washing setup."))}
 };

 /* ---------- register ---------- */
 function bar(p){const t=p.table_count||1,c=Math.min(100,100*p.confirmed_tables_cleaned/t),q=Math.min(100-c,100*p.pending_tables_cleaned/t);return '<div class="wc-bar"><i class="wc-bar-ok" style="width:'+c+'%"></i><i class="wc-bar-pend" style="width:'+q+'%"></i></div>'}
 function dots(p){return '<div class="wc-dots">'+(p.cycles||[]).map(c=>'<span class="wc-dot wc-dot-'+h(c.state)+'" title="Cycle '+c.cycle_no+' · '+h(c.state)+' · due '+fmt(c.due_date)+'">'+c.cycle_no+'</span>').join("")+'</div>'}
 function weekly(p){const v=p.weekly_compliance_percent,t=p.compliance_threshold_percent;return chip(v+"%",v>=t?"ok":v>=t-15?"warn":"crit")}
 function todayChip(p){const d=(p.daily_status||[]).slice(-1)[0];return d?chip(d.status+(isTeam()&&d.target?" · "+d.target+" due":""),dtone(d.status)):chip("—","mute")}
 /* ---- compact register: one row per plant, Cycle 1/2/3 for the month, latest update on top ---- */
 function cycleCell(p,c){
  if(!c)return chip("—","mute");
  if(c.state==="Completed")return '<div class="wc-cyc"><span class="wc-cyc-ok">✓ '+fmt(c.completed_on)+'</span>'+(isTeam()&&c.late_days?'<small class="wc-late">+'+c.late_days+'d late</small>':'')+'</div>';
  if(c.state==="In progress"){const n=(c.confirmed||0)+(c.pending||0),pct=Math.min(100,Math.round(100*n/(p.table_count||1)));return '<div class="wc-cyc"><span class="wc-cyc-run">'+n+' / '+p.table_count+'</span><div class="wc-bar wc-bar-sm"><i class="wc-bar-ok" style="width:'+pct+'%"></i></div></div>'}
  return '<div class="wc-cyc"><span class="wc-cyc-next">Not started</span></div>';
 }
 function updateText(p){
  const ev=(p.cycles||[]).filter(c=>c.completed_on).sort((a,b)=>b.completed_on.localeCompare(a.completed_on))[0],t=todayOf(p);
  if(ev&&(ev.completed_on===lastAct(p))){const nx=ev.cycle_no<(p.monthly_target||3);return '<b>Cycle '+ev.cycle_no+' completed</b>'+(nx?'<small>Cycle '+(ev.cycle_no+1)+' started</small>':'<small>All cycles done this month</small>')+'<small>'+ago(ev.completed_on,t)+'</small>'}
  return p.last_report_date?'<b>'+ago(p.last_report_date,t)+'</b><small>'+(p.pending_tables_cleaned?p.pending_tables_cleaned+' awaiting confirmation':'Cycle '+p.current_cycle+' in progress')+'</small>':'<span class="wc-cycle-label">No report yet</span>';
 }
 function strip(p){
  const ds=(p.daily_status||[]).slice(-7);
  return '<div class="wc-strip">'+ds.map(d=>{const n=(d.confirmed||0)+(d.pending||0),cls=d.confirmed?"ok":d.pending?"pend":d.exception?"exc":(d.status==="No report"&&isTeam())?"miss":"none";
   return '<span class="wc-sd wc-sd-'+cls+'" title="'+fmt(d.date)+' · '+(n?n+' tables cleaned'+(d.pending&&!d.confirmed?' (awaiting confirmation)':''):(d.exception||d.status))+'">'+(n||(d.exception?"E":"·"))+'</span>'}).join("")+'</div>';
 }
 function expandHtml(p){
  const cy=(p.cycles||[]).map(c=>'<div class="wc-ex-cy"><b>Cycle '+c.cycle_no+'</b> '+chip(c.state,c.state==="Completed"?"ok":c.state==="In progress"?"info":"mute")+'<small>'+(c.state==="Completed"?'Started '+fmt(c.started_on)+' · completed '+fmt(c.completed_on)+(isTeam()?(c.late_days?' · '+c.late_days+' day(s) after deadline':' · on time'):''):c.state==="In progress"?'Started '+fmt(c.started_on)+' · '+(c.confirmed||0)+' confirmed'+(c.pending?' + '+c.pending+' awaiting':'')+' of '+p.table_count+' tables':'Starts automatically when cycle '+(c.cycle_no-1)+' is complete')+(isTeam()?' · deadline '+fmt(c.due_date):'')+'</small></div>').join("");
  const canReport=isField()||isTeam(),id=h(p.plant_id);
  return '<div class="wc-ex"><div class="wc-ex-cycles">'+cy+'</div><div class="wc-actions"><button class="btn o sm" onclick="openWashingPlantDetails(\''+id+'\')">Cycle &amp; reports</button>'+(canReport?'<button class="btn p sm" onclick="openWashingDailyReport(\''+id+'\')">'+(isField()?'Report today':'Record cleaning')+'</button>':'')+(isTeam()?'<button class="btn g sm" onclick="openWashingSetup(\''+id+'\')">Edit setup</button>':'')+'</div></div>';
 }
 function filtered(){
  const ui=S._washUi=S._washUi||{q:"",bucket:"all",show:"all",assignee:"all",region:"all",sort:"late",page:1,pageSize:12,selected:[]};
  const f=S.washF=Object.assign({q:"",bucket:"all",show:"all"},ui),q=(f.q||"").trim().toLowerCase(),head=isTeam();
  const hit=p=>(!q||(p.plant+" "+p.site_code).toLowerCase().includes(q))&&(!f.plant||f.plant==="all"||p.plant_id===f.plant);
  /* glance filters: state = the plant's tile colour (donut slice), cyc = "<cycle no>:<state>" (cycle progress bar) */
  const stOk=p=>!f.state||f.state==="all"||(f.state==="late"?tileState(p).indexOf("late-")===0:tileState(p)===f.state);
  const cycOk=p=>{if(!f.cyc||f.cyc==="all")return true;const parts=String(f.cyc).split(":");return (p.cycles||[]).some(c=>String(c.cycle_no)===parts[0]&&(parts[1]==="Not started"?c.state!=="Completed"&&c.state!=="In progress":c.state===parts[1]))};
  const configured=(data().plants||[]).filter(p=>hit(p)&&stOk(p)&&cycOk(p)&&(f.bucket==="all"||p.overdue_bucket===f.bucket)&&
   (f.show==="all"||(f.show==="review"&&p.pending_tables_cleaned>0)||(f.show==="mine"&&p.assignee_user_id===S._currentUserId)||(f.show==="done"&&p.cycles_this_month>=p.monthly_target)||(f.show==="attention"&&head&&p.active&&(p.overdue_bucket!=="on_track"||p.weekly_compliance_percent<p.compliance_threshold_percent))||(f.show==="late"&&p.overdue_bucket!=="on_track")||(f.show==="below"&&p.active&&p.weekly_compliance_percent<p.compliance_threshold_percent)||(f.show==="notreported"&&p.today_report==null)||(f.show==="mine"&&p.assignee_user_id===S._currentUserId))&&
   (f.assignee==="all"||(f.assignee==="unassigned"?!p.assignee_user_id:f.assignee===p.assignee_user_id))&&
   (f.region==="all"||f.region===(p.district||p.location||"")));
  const un=(data().unconfigured||[]).filter(hit).map(p=>Object.assign({not_setup:true},p)).filter(p=>(!f.state||f.state==="all"||f.state==="unset")&&(!f.cyc||f.cyc==="all")&&(f.show==="all"||f.show==="notsetup")&&f.bucket==="all"&&(f.assignee==="all"||f.assignee==="unassigned")&&f.region==="all");
  let rows=f.show==="notsetup"?[]:configured;
  if(f.sort==="name")rows.sort((a,b)=>a.plant.localeCompare(b.plant));
  else if(f.sort==="compliance")rows.sort((a,b)=>(b.weekly_compliance_percent||0)-(a.weekly_compliance_percent||0)||a.plant.localeCompare(b.plant));
  else if(f.sort==="progress")rows.sort((a,b)=>(b.confirmed_tables_cleaned/(b.table_count||1))-(a.confirmed_tables_cleaned/(a.table_count||1))||a.plant.localeCompare(b.plant));
  else rows.sort((a,b)=>(b.overdue_days||0)-(a.overdue_days||0)||lastAct(b).localeCompare(lastAct(a))||a.plant.localeCompare(b.plant));
  un.sort((a,b)=>a.plant.localeCompare(b.plant));
  return{rows,un,list:rows.concat(un)};
 }
 function registerHtml(){
  const{list}=filtered(),head=isTeam(),ui=S._washUi,open=S.washOpen=S.washOpen||{};
  const pages=Math.max(1,Math.ceil(list.length/ui.pageSize));ui.page=Math.min(Math.max(1,ui.page),pages);
  const pageRows=list.slice((ui.page-1)*ui.pageSize,ui.page*ui.pageSize),selected=new Set(ui.selected);
  const body=pageRows.map(p=>{
   const checkbox=head?'<input type="checkbox" aria-label="Select '+h(p.plant)+'" value="'+h(p.plant_id)+'" '+(selected.has(p.plant_id)?"checked":"")+' onclick="event.stopPropagation();washSelectPlant(this.value,this.checked)"/>':'';
   if(p.not_setup)return '<tr class="wc-unset"><td>'+checkbox+'</td><td class="wc-plant"><div><b>'+h(p.plant)+'</b><small>'+h(p.site_code)+' · Plant washing not configured</small></div></td><td colspan="'+(head?6:5)+'">'+chip("Not set up","mute")+'</td><td>'+(head?'<button class="btn o sm" onclick="event.stopPropagation();openWashingSetup(\''+h(p.plant_id)+'\')">Set up plant</button>':'—')+'</td></tr>';
   const isOpen=!!open[p.plant_id],current=(p.cycles||[]).find(c=>c.state==="In progress")||(p.cycles||[]).find(c=>c.state==="Upcoming"),confirmed=current?current.confirmed||0:0,pending=current?current.pending||0:0,remaining=Math.max(0,(p.table_count||0)-confirmed-pending),t=todayOf(p),fresh=lastAct(p)===t&&t;
   /* Site Engineers do not receive lateness figures; they see the next deadline instead */
   const todayCell=todayChip(p),status=!p.overdue_bucket?(p.next_due?chip("Due "+fmt(p.next_due),"mute"):chip("—","mute")):p.overdue_bucket==="on_track"?chip("On track","ok"):chip(p.overdue_days+" d late",TONE[p.overdue_bucket]||"warn");
   const confirmedPercent=current?Math.min(100,100*confirmed/(p.table_count||1)):100,pendingPercent=current?Math.min(100-confirmedPercent,100*pending/(p.table_count||1)):0,progress='<div class="wc-plant-progress"><div class="wc-bar"><i class="wc-bar-ok" style="width:'+confirmedPercent+'%"></i><i class="wc-bar-pend" style="width:'+pendingPercent+'%"></i></div><small>'+(current?confirmed+' confirmed'+(pending?' · '+pending+' pending':'')+' · '+remaining+' left':'All monthly cycles complete')+'</small></div>';
   const currentNo=current?current.cycle_no:null;
   const action=head?'<div class="wc-row-actions"><button class="btn p sm" onclick="event.stopPropagation();openWashingPlantDetails(\''+h(p.plant_id)+'\')">Cycle &amp; reports</button><button class="btn o sm" onclick="event.stopPropagation();openWashingSetup(\''+h(p.plant_id)+'\')">Edit setup</button></div>':isField()?'<button class="btn p sm" onclick="event.stopPropagation();openWashingDailyReport(\''+h(p.plant_id)+'\')">Report today</button>':'<button class="btn o sm" onclick="event.stopPropagation();openWashingPlantDetails(\''+h(p.plant_id)+'\')">View</button>';
   return '<tr class="wc-row'+(isOpen?" open":"")+'" onclick="openWashingPlantDetails(\''+h(p.plant_id)+'\')"><td>'+checkbox+'</td><td class="wc-plant"><div><b>'+(fresh?'<i class="wc-live" title="Updated today"></i>':'')+h(p.plant)+'</b><small>'+h(p.site_code)+' · '+plural(p.table_count,"table")+'</small></div></td>'+
    '<td>'+progress+'</td><td><div class="wc-cycle-summary">'+dots(p)+'</div><small class="wc-cycle-label">'+(currentNo?'Cycle '+currentNo+' · ':'')+p.cycles_this_month+' of '+p.monthly_target+' this month</small></td>'+
    '<td>'+todayCell+'<small class="wc-upd">'+updateText(p)+'</small></td>'+(head?'<td>'+weekly(p)+'</td>':'')+'<td>'+status+'</td><td>'+(!p.assignee_user_id&&head?chip("Unassigned","crit"):h(p.assignee_name||"—"))+'</td><td>'+action+'</td></tr>'+
    (isOpen?'<tr class="wc-exrow"><td colspan="'+(head?9:8)+'">'+expandHtml(p)+'</td></tr>':'');
  }).join("");
  const pageCount=Math.max(1,Math.ceil(list.length/ui.pageSize)),start=list.length?(ui.page-1)*ui.pageSize+1:0,end=Math.min(list.length,ui.page*ui.pageSize);
  const ids=pageRows.filter(p=>!p.not_setup).map(p=>p.plant_id),allChecked=ids.length>0&&ids.every(id=>selected.has(id));
  const pager='<div class="wc-pager"><span>'+start+'–'+end+' of '+list.length+' plants</span><label>Rows <select class="sel" onchange="washFilter(\'pageSize\',this.value)">'+[12,25,50].map(n=>'<option value="'+n+'"'+(Number(ui.pageSize)===n?" selected":"")+'>'+n+'</option>').join("")+'</select></label><button class="btn o sm" '+(ui.page<=1?"disabled":"")+' onclick="washPage(-1)">Previous</button><span>Page '+ui.page+' of '+pageCount+'</span><button class="btn o sm" '+(ui.page>=pageCount?"disabled":"")+' onclick="washPage(1)">Next</button></div>';
  const selectAll=head&&selected.size?'<div class="wc-select-all">Selected '+selected.size+' plant(s). <button class="btn g sm" onclick="washSelectAllMatching()">Select all '+list.length+' matching</button><button class="btn g sm" onclick="washClearSelection()">Clear selection</button></div>':"";
  const bulk=head&&selected.size?'<div class="wc-bulk-bar"><b>'+selected.size+' selected</b><button class="btn o sm" onclick="washImportExportSelected()">Export selected</button><button class="btn g sm" onclick="washClearSelection()">Clear selection</button></div>':"";
  const columns=head?9:8;
  return selectAll+bulk+'<div class="wc-table-wrap"><table class="wc-table wc-compact wc-portfolio-table"><thead><tr><th>'+(head?'<input type="checkbox" aria-label="Select plants on this page" '+(allChecked?"checked":"")+' onclick="washSelectPage(this.checked)"/>':'')+'</th><th>Plant</th><th>Current cycle progress</th><th>Monthly cycles</th><th>Today / latest report</th>'+(head?'<th>Weekly compliance</th>':'')+'<th>Deadline</th><th>Assignee</th><th></th></tr></thead><tbody>'+(body||'<tr><td colspan="'+columns+'" class="wc-empty">No plants match. Clear a filter to see more.</td></tr>')+'</tbody></table></div>'+pager;
 }
 /* ---- day-by-day: All plants (totals per day) or a single plant ---- */
 function dayRows(sel){
  const by={};
  (data().plants||[]).filter(p=>sel==="all"||p.plant_id===sel).forEach(p=>(p.daily_status||[]).forEach(d=>{
   const r=by[d.date]=by[d.date]||{date:d.date,confirmed:0,pending:0,target:0,reported:0,exc:0,n:0,plants:[]};
   r.confirmed+=d.confirmed||0;r.pending+=d.pending||0;r.target+=d.target||0;r.n++;
   if(d.confirmed||d.pending)r.reported++;else if(d.exception)r.exc++;
   r.plants.push({id:p.plant_id,plant:p.plant,code:p.site_code,confirmed:d.confirmed||0,pending:d.pending||0,status:d.status,exception:d.exception,by:d.reported_by,target:d.target||0});
  }));
  return Object.values(by).sort((a,b)=>b.date.localeCompare(a.date));
 }
 function dayInner(){
  const plants=(data().plants||[]).slice().sort((a,b)=>a.plant.localeCompare(b.plant));
  let sel=S.washDayPlant||"all";if(sel!=="all"&&!plants.some(p=>p.plant_id===sel))sel=S.washDayPlant="all";
  const single=sel!=="all",team=isTeam(),rows=dayRows(sel),open=S.washDayOpen=S.washDayOpen||{},pl=single?rowOf(sel):null;
  const tot=rows.reduce((a,r)=>({c:a.c+r.confirmed,p:a.p+r.pending,t:a.t+r.target}),{c:0,p:0,t:0}),max=Math.max(1,...rows.map(r=>r.confirmed+r.pending));
  const todayRow=rows[0],reports=data().reports||[];
  const photos=date=>reports.filter(r=>r.plant_id===sel&&r.report_date===date).reduce((n,r)=>n+(r.evidence||[]).length,0);
  const head='<div class="wc-day-top"><div class="field" style="min-width:240px"><span class="lbl">Show</span><select class="sel" onchange="washDaySelect(this.value)"><option value="all"'+(single?"":" selected")+'>All plants ('+plants.length+')</option>'+plants.map(p=>'<option value="'+h(p.plant_id)+'"'+(p.plant_id===sel?" selected":"")+'>'+h(p.plant)+' · '+h(p.site_code)+'</option>').join("")+'</select></div>'+
   '<div class="wc-day-sum">'+chip(tot.c+" tables cleaned this month","ok")+(tot.p?chip(tot.p+" awaiting confirmation","info"):"")+(todayRow?chip("Today: "+(todayRow.confirmed+todayRow.pending)+" tables","mute"):"")+
   (single&&pl?chip(pl.cycles_this_month+" of "+pl.monthly_target+" cycles done","info")+(team&&pl.weekly_compliance_percent!=null?chip("Weekly compliance "+pl.weekly_compliance_percent+"%",pl.weekly_compliance_percent>=pl.compliance_threshold_percent?"ok":pl.weekly_compliance_percent>=pl.compliance_threshold_percent-15?"warn":"crit"):"")+(pl.assignee_name?chip("Assignee: "+pl.assignee_name,"mute"):""):chip(rows.length?(rows[0].plants.length+" plants"):"0 plants","mute"))+'</div></div>';
  const th='<th>Date</th><th>Tables cleaned</th><th>Awaiting confirmation</th>'+(team?'<th>Target</th><th>vs target</th>':'')+(single?'<th>Status</th><th>Reported by</th><th>Photos</th>':'<th>Plants reported</th>');
  const body=rows.map(r=>{
   const n=r.confirmed+r.pending,pct=r.target?Math.min(100,Math.round(100*r.confirmed/r.target)):null,bar='<div class="wc-bar wc-bar-sm"><i class="wc-bar-ok" style="width:'+Math.round(100*r.confirmed/max)+'%"></i><i class="wc-bar-pend" style="width:'+Math.round(100*r.pending/max)+'%"></i></div>';
   const one=r.plants[0];
   const tail=single?'<td>'+chip(one.status,dtone(one.status))+(one.exception?' <small>'+h(one.exception)+'</small>':'')+'</td><td>'+h(one.by||"—")+'</td><td>'+(photos(r.date)||"—")+'</td>':'<td><b>'+r.reported+'</b> of '+r.n+(r.exc?' <small>· '+r.exc+' exception'+(r.exc===1?"":"s")+'</small>':'')+'</td>';
   const main='<tr class="wc-dayrow'+(!single?" wc-click":"")+'" '+(!single?'onclick="washDayToggle(\''+r.date+'\')"':'')+'><td><b>'+(!single?'<span class="wc-caret">'+(open[r.date]?"▾":"▸")+'</span> ':'')+fmt(r.date)+'</b></td><td><b>'+r.confirmed+'</b>'+bar+'</td><td>'+(r.pending||"—")+'</td>'+(team?'<td>'+r.target+'</td><td>'+(pct==null?"—":chip(pct+"%",pct>=100?"ok":pct>=70?"warn":"crit"))+'</td>':'')+tail+'</tr>';
   let sub="";
   if(!single&&open[r.date]){
    const act=r.plants.filter(x=>x.confirmed||x.pending||x.exception).sort((a,b)=>(b.confirmed+b.pending)-(a.confirmed+a.pending));
    const list=act.map(x=>'<span><b>'+h(x.plant)+'</b> '+(x.confirmed+x.pending?(x.confirmed+x.pending)+' tables'+(x.pending&&!x.confirmed?' (awaiting)':''):h(x.exception))+'</span>').join("");
    sub='<tr class="wc-exrow"><td colspan="'+(team?6:4)+'"><div class="wc-daysub">'+(list||'<span class="wc-cycle-label">No plant reported this day.</span>')+'</div></td></tr>';
   }
   return main+sub;
  }).join("");
  return '<h2>Day-by-day cleaning</h2><p class="sub">Tables cleaned per day this month. Choose <b>All plants</b> for the combined total, or one plant to track it on its own.</p>'+head+'<div class="wc-table-wrap"><table class="wc-table wc-compact" style="min-width:560px"><thead><tr>'+th+'</tr></thead><tbody>'+(body||'<tr><td colspan="7" class="wc-empty">No days to show yet.</td></tr>')+'</tbody></table></div>';
 }
 function dayCardHtml(){return '<div class="wc-card" id="wc-days-card">'+dayInner()+'</div>'}
 window.washDaySelect=function(v){S.washDayPlant=v;S.washDayOpen={};const e=document.getElementById("wc-days-card");if(e)e.innerHTML=dayInner()};
 window.washDayToggle=function(d){const o=S.washDayOpen=S.washDayOpen||{};o[d]=!o[d];const e=document.getElementById("wc-days-card");if(e)e.innerHTML=dayInner()};
 window.washToggleRow=function(id){const o=S.washOpen=S.washOpen||{};o[id]=!o[id];const e=document.getElementById("wc-register");if(e)e.innerHTML=registerHtml()};
 window.washFilter=function(k,v){
  const ui=S._washUi=S._washUi||{q:"",bucket:"all",show:"all",assignee:"all",region:"all",sort:"late",page:1,pageSize:12,selected:[]};
  const input=k==="q"?document.querySelector("#wc-register .wc-search"):null,start=input&&input.selectionStart,end=input&&input.selectionEnd;
  ui[k]=k==="pageSize"?Number(v):v;if(k!=="page")ui.page=1;
  S.washF=Object.assign({},ui);
  if(k!=="q"&&k!=="pageSize"){render();return}
  const el=document.getElementById("wc-register");if(el)el.innerHTML=resultsHtml();
  if(input&&document.querySelector("#wc-register .wc-search")){const next=document.querySelector("#wc-register .wc-search");next.focus();next.setSelectionRange(start,end)}
 };
 window.washPage=function(delta){const ui=S._washUi;if(!ui)return;ui.page=Math.max(1,ui.page+delta);const el=document.getElementById("wc-register");if(el)el.innerHTML=registerHtml()};
 window.washSelectPlant=function(id,checked){if(!isTeam())return;const ui=S._washUi=S._washUi||{selected:[]},set=new Set(ui.selected||[]);if(checked)set.add(id);else set.delete(id);ui.selected=Array.from(set);const el=document.getElementById("wc-register");if(el)el.innerHTML=registerHtml()};
 window.washSelectPage=function(checked){if(!isTeam())return;const ui=S._washUi,ids=filtered().list.slice((ui.page-1)*ui.pageSize,ui.page*ui.pageSize).map(p=>p.plant_id),set=new Set(ui.selected||[]);ids.forEach(id=>checked?set.add(id):set.delete(id));ui.selected=Array.from(set);const el=document.getElementById("wc-register");if(el)el.innerHTML=registerHtml()};
 window.washSelectAllMatching=function(){if(!isTeam())return;const ui=S._washUi;ui.selected=filtered().list.map(p=>p.plant_id);const el=document.getElementById("wc-register");if(el)el.innerHTML=registerHtml()};
 window.washClearSelection=function(){if(!isTeam())return;S._washUi.selected=[];const el=document.getElementById("wc-register");if(el)el.innerHTML=registerHtml()};

 /* ---- O&M-only: assignee ranking (efficiency) ---- */
 function rankingHtml(){
  const by={};
  (data().plants||[]).forEach(p=>{if(!p.assignee_name)return;const r=by[p.assignee_name]=by[p.assignee_name]||{name:p.assignee_name,plants:0,done:0,target:0,wk:0,delay:0,ex:0,t7:0,thr:0};
   r.plants++;r.done+=p.cycles_this_month||0;r.target+=p.monthly_target||3;r.wk+=p.weekly_compliance_percent||0;r.delay+=p.average_delay_days||0;r.ex+=p.exceptions_this_month||0;r.thr+=p.compliance_threshold_percent||85;r.t7+=(p.productivity||[]).reduce((n,x)=>n+x.tables,0)});
  const list=Object.values(by).map(r=>({name:r.name,plants:r.plants,done:r.done,target:r.target,wk:Math.round(r.wk/r.plants),thr:Math.round(r.thr/r.plants),delay:Math.round(10*r.delay/r.plants)/10,ex:r.ex,t7:r.t7})).sort((a,b)=>b.wk-a.wk||a.delay-b.delay||b.done-a.done);
  if(!list.length)return '<div class="wc-empty">No plant has an Assignee yet.</div>';
  return '<div class="wc-table-wrap"><table class="wc-table wc-compact" style="min-width:640px"><thead><tr><th>Rank</th><th>Assignee</th><th>Plants</th><th>Cycles this month</th><th>Weekly compliance</th><th>Avg delay</th><th>Tables cleaned (7 d)</th><th>Exceptions</th></tr></thead><tbody>'+list.map((r,i)=>'<tr><td><b>#'+(i+1)+'</b></td><td><b>'+h(r.name)+'</b></td><td>'+r.plants+'</td><td>'+r.done+' / '+r.target+'</td><td>'+chip(r.wk+"%",r.wk>=r.thr?"ok":r.wk>=r.thr-15?"warn":"crit")+'</td><td>'+r.delay+' d</td><td>'+r.t7+'</td><td>'+r.ex+'</td></tr>').join("")+'</tbody></table></div>';
 }

 function matrixHtml(active,clickable){
  const m=data().overdue_matrix||{};
  return '<div class="wc-matrix">'+BUCKETS.map(b=>'<button class="wc-cell t-'+b[3]+(active===b[0]?" on":"")+'" '+(clickable?'onclick="washFilter(\'bucket\',\''+(active===b[0]?"all":b[0])+'\')"':'onclick="washOpenRegister(\''+b[0]+'\')"')+'><b>'+(m[b[0]]||0)+'</b><span>'+b[1]+'</span><small>'+b[2]+'</small></button>').join("")+'</div>';
 }
 window.washOpenRegister=function(bucket){const ui=S._washUi=S._washUi||{q:"",bucket:"all",show:"all",assignee:"all",region:"all",sort:"late",page:1,pageSize:12,selected:[]};ui.bucket=bucket||"all";ui.page=1;S.washF=Object.assign({},ui);S.view="om-module";S.omTab="washing";render()};

 function feedHtml(){
  const ev=(data().cycle_events||[]).slice(0,6).map(e=>'<div class="wc-feed-item"><span class="wc-feed-ico">✓</span><div><b>'+h(e.plant)+'</b> · Cycle '+e.cycle_no+' completed'+(e.next_cycle?' — <b>Cycle '+e.next_cycle+' has started</b>':' — all monthly cycles done')+'<time>'+fmt(e.completed_on)+' · '+h(e.site_code)+'</time></div></div>').join("");
  const rev=(data().reports||[]).filter(r=>r.can_review).slice(0,4).map(r=>'<div class="wc-feed-item"><span class="wc-feed-ico rev">!</span><div><b>'+h(r.plant)+'</b> · '+r.tables_cleaned+' table(s) on '+fmt(r.report_date)+' waiting for your confirmation<time><a href="#" onclick="openWashingPlantDetails(\''+h(r.plant_id)+'\');return false">Review photos &amp; confirm</a></time></div></div>').join("");
  return '<div class="wc-feed">'+(rev+ev||'<div class="wc-empty">No cycle completed yet this month.</div>')+'</div>';
 }

 /* ---- plant wall: one tile per plant, colour = how the plant stands today ---- */
 function tileState(p){
  if(p.not_setup)return "unset";
  if(p.overdue_bucket&&p.overdue_bucket!=="on_track")return "late-"+p.overdue_bucket;
  if(p.pending_tables_cleaned>0)return "review";
  if(p.cycles_this_month>=p.monthly_target)return "done";
  return "ok";
 }
 function ring(conf,pend,total,label){
  const R=22,C=2*Math.PI*R,t=Math.max(1,total),a=Math.min(1,conf/t),b=Math.min(1-a,pend/t);
  return '<svg class="wx-ring" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="'+R+'" class="trk"/>'+
   (a?'<circle cx="28" cy="28" r="'+R+'" class="ok" stroke-dasharray="'+(a*C).toFixed(1)+' '+C.toFixed(1)+'" transform="rotate(-90 28 28)"/>':'')+
   (b?'<circle cx="28" cy="28" r="'+R+'" class="pend" stroke-dasharray="'+(b*C).toFixed(1)+' '+C.toFixed(1)+'" stroke-dashoffset="'+(-a*C).toFixed(1)+'" transform="rotate(-90 28 28)"/>':'')+
   '<text x="28" y="27" text-anchor="middle" class="big">'+Math.round(100*(a))+'%</text><text x="28" y="38" text-anchor="middle" class="sm">'+h(label)+'</text></svg>';
 }
 function tileHtml(p){
  const st=tileState(p),id=h(p.plant_id),head=isTeam();
  if(p.not_setup)return '<div class="wx-tile st-unset"><div class="wx-tile-h"><b>'+h(p.plant)+'</b><span>'+h(p.site_code)+'</span></div><p class="wx-unset">Washing not set up yet</p>'+(head?'<button class="btn o sm" onclick="openWashingSetup(\''+id+'\')">Set up plant</button>':'')+'</div>';
  const cur=(p.cycles||[]).find(c=>c.state==="In progress")||(p.cycles||[]).find(c=>c.state==="Upcoming");
  const conf=cur?cur.confirmed||0:p.table_count,pend=cur?cur.pending||0:0,label=cur?"Cycle "+cur.cycle_no:"Done";
  const pills=(p.cycles||[]).map(c=>'<i class="cy-'+(c.state==="Completed"?"done":c.state==="In progress"?"now":"next")+'" title="Cycle '+c.cycle_no+': '+h(c.state)+(head?' · due '+fmt(c.due_date):'')+'">'+(c.state==="Completed"?"✓":c.cycle_no)+'</i>').join("");
  const badge=st.startsWith("late")?chip(p.overdue_days+" d late",TONE[p.overdue_bucket]||"warn"):st==="review"?chip(p.pending_tables_cleaned+" to confirm","info"):st==="done"?chip("Month done","ok"):chip("On track","ok");
  const today=todayOf(p)===todayIso()?((p.daily_status||[]).slice(-1)[0]||{}):null;
  const todayText=today&&(today.confirmed||today.pending)?(today.confirmed+today.pending)+" tables today":"No report today";
  return '<button type="button" class="wx-tile st-'+st+'" onclick="openWashingPlantDetails(\''+id+'\')" title="Open '+h(p.plant)+'"><div class="wx-tile-h"><b>'+h(p.plant)+'</b><span>'+h(p.site_code)+'</span></div>'+
   '<div class="wx-tile-m">'+ring(conf,pend,p.table_count,label)+'<div class="wx-tile-k"><div class="wx-pills">'+pills+'</div><small>'+(cur?conf+(pend?" + "+pend:"")+" of "+p.table_count+" tables":p.table_count+" tables · all cycles done")+'</small><small class="wx-today'+(today&&(today.confirmed||today.pending)?" on":"")+'">'+todayText+'</small></div></div>'+
   '<div class="wx-tile-f">'+badge+'<span class="wx-who">'+h(p.assignee_name||"No Assignee")+'</span></div></button>';
 }
 function wallHtml(){
  const{list}=filtered();
  if(!list.length)return '<div class="wc-empty">No plants match. <button class="btn g sm" onclick="washClearFilters()">Clear filters</button></div>';
  return '<div class="wx-wall">'+list.map(tileHtml).join("")+'</div>';
 }
 function resultsHtml(){return S._washUi&&S._washUi.view==="table"?registerHtml():wallHtml()}
 window.washSetView=function(v){S._washUi.view=v;render()};

 /* Glance clicks: toggle a filter, repaint, then land on the plant list. */
 window.washGlance=function(k,v){
  const ui=S._washUi=S._washUi||{q:"",bucket:"all",show:"all",assignee:"all",region:"all",sort:"late",page:1,pageSize:12,selected:[]};
  const next=String(ui[k]||"all")===String(v)?"all":v;
  if(next!=="all")S._glanceScroll="wc-results";
  washFilter(k,next);
 };
 if(!window._wxGlanceEvents){
  window._wxGlanceEvents=true;
  document.addEventListener("click",e=>{
   const t=e.target&&e.target.closest?e.target.closest("[data-wx-state],[data-wx-cyc]"):null;if(!t)return;
   e.preventDefault();
   if(t.dataset.wxState!==undefined)washGlance("state",t.dataset.wxState);
   else washGlance("cyc",t.dataset.wxCyc);
  });
 }
 function washFocusBar(f){
  const G=window.s91Glance;if(!G)return "";
  const STATE={ok:"On track",review:"Awaiting confirmation","late-1d":"1–2 days late","late-3d":"3–6 days late","late-7d":"7+ days late",late:"Behind deadline",done:"Month done",unset:"Not set up"};
  const SHOW={attention:"Needs attention",review:"Awaiting review",notreported:"Not reported today",notsetup:"Not set up",mine:"Mine",late:"Late",below:"Below compliance target",done:"Month done"};
  const BUCKET={"1d":"1–2 days late","3d":"3–6 days late","7d":"7+ days late",on_track:"On track"};
  const chips=[];
  if(f.state&&f.state!=="all")chips.push({label:"Status: "+(STATE[f.state]||f.state),color:WX_STATE_COLOR[f.state]||"#0F5C2E",attr:'onclick="washFilter(\'state\',\'all\')"'});
  if(f.cyc&&f.cyc!=="all"){const parts=String(f.cyc).split(":");chips.push({label:"Cycle "+parts[0]+": "+parts[1],color:"#0891B2",attr:'onclick="washFilter(\'cyc\',\'all\')"'})}
  if(f.show&&f.show!=="all")chips.push({label:"View: "+(SHOW[f.show]||f.show),color:"#2563EB",attr:'onclick="washFilter(\'show\',\'all\')"'});
  if(f.bucket&&f.bucket!=="all")chips.push({label:"Late: "+(BUCKET[f.bucket]||f.bucket),color:"#EA580C",attr:'onclick="washFilter(\'bucket\',\'all\')"'});
  return G.focusBar(chips,'onclick="washClearFilters()"');
 }
 const WX_STATE_COLOR={ok:"#16A34A",review:"#2563EB","late-1d":"#D97706","late-3d":"#EA580C","late-7d":"#DC2626",late:"#D97706",done:"#0E9F6E",unset:"#94A3B8"};
 window.renderWashing=function(){
  if(!S._washCycles&&!S._washCycleError){loadOverview().catch(()=>{});return '<div class="wc-card wc-empty">Loading plant washing…</div>'}
  if(S._washCycleError&&!S._washCycles)return '<div class="wc-card"><div class="bn-warn banner">Washing data could not be loaded: '+h(detailOf(S._washCycleError))+'</div><button class="btn o" onclick="S._washCycleError=null;S._washCycles=null;render()">Retry</button></div>';
  const d=data(),pf=d.portfolio||{},head=isTeam(),field=isField();
  const ui=S._washUi=S._washUi||{q:"",bucket:"all",show:"all",assignee:"all",region:"all",sort:"late",page:1,pageSize:12,selected:[]};
  if(ui.plant===undefined)ui.plant="all";if(!ui.view)ui.view="tiles";
  const f=S.washF=Object.assign({},ui);
  const plants=d.plants||[],unconfigured=d.unconfigured||[],allN=plants.length+unconfigured.length,m=d.overdue_matrix||{};
  S._currentUserId=d.viewer_user_id||S._currentUserId;
  const wk=pf.weekly_compliance_percent,thr=(plants[0]&&plants[0].compliance_threshold_percent)||85;
  const done=pf.cycles_completed_month||0,target=pf.cycles_target_month||0,late=(m["1d"]||0)+(m["3d"]||0)+(m["7d"]||0);
  const howTo=head?"Every plant needs 3 full washing cycles a month (all tables each time), due by the 10th, 20th and month-end — the dates can be changed per plant. Site Engineers report the tables cleaned each day; once all tables are confirmed the next cycle starts automatically.":"Report how many tables you cleaned each day with before and after photos. When all tables are cleaned and confirmed, the next cycle starts automatically.";
  const header='<div class="wx-head"><div class="wx-title"><span class="wx-ico" aria-hidden="true">💧</span><div><h1>Plant washing</h1><p>'+allN+' plant'+(allN===1?'':'s')+' · 3 cycles a month <span class="wx-info" tabindex="0" title="'+h(howTo)+'">ⓘ How it works</span></p></div></div>'+
   (head?'<div class="wx-actions"><button class="btn o sm" onclick="washImportExport()">Export Excel</button><button class="btn o sm" onclick="washImportOpen()">Upload Excel</button><button class="btn p sm" onclick="openWashingSetup()">+ Set up a plant</button></div>':'')+'</div>';
  const cyPct=target?Math.round(100*done/target):0;
  /* ---- "At a glance" overview: donut, cycle bars and KPI cards filter the plant list and scroll to it ---- */
  const G=window.s91Glance;
  const stCount={ok:0,review:0,"late-1d":0,"late-3d":0,"late-7d":0,done:0,unset:unconfigured.length};
  plants.forEach(p=>{const k=tileState(p);stCount[k]=(stCount[k]||0)+1});
  const lateN=stCount["late-1d"]+stCount["late-3d"]+stCount["late-7d"];
  const slices=head?[
   {key:"ok",label:"On track",n:stCount.ok,color:WX_STATE_COLOR.ok},
   {key:"review",label:"Awaiting confirmation",n:stCount.review,color:WX_STATE_COLOR.review},
   {key:"late-1d",label:"1–2 days late",n:stCount["late-1d"],color:WX_STATE_COLOR["late-1d"]},
   {key:"late-3d",label:"3–6 days late",n:stCount["late-3d"],color:WX_STATE_COLOR["late-3d"]},
   {key:"late-7d",label:"7+ days late",n:stCount["late-7d"],color:WX_STATE_COLOR["late-7d"]},
   {key:"done",label:"Month done",n:stCount.done,color:WX_STATE_COLOR.done},
   {key:"unset",label:"Not set up",n:stCount.unset,color:WX_STATE_COLOR.unset}]
  :[{key:"ok",label:"On track",n:stCount.ok,color:WX_STATE_COLOR.ok},
   {key:"review",label:"Awaiting confirmation",n:stCount.review,color:WX_STATE_COLOR.review},
   {key:"late",label:"Behind schedule",n:lateN,color:WX_STATE_COLOR.late},
   {key:"done",label:"Month done",n:stCount.done,color:WX_STATE_COLOR.done}];
  const wkTone=wk==null?"var(--info)":wk>=thr?"var(--success)":wk>=thr-15?"var(--warning)":"var(--danger)";
  const scoreColor=wk==null?"#7dd3fc":wk>=thr?"#4ADE80":wk>=thr-15?"#FBBF24":"#F87171";
  const kt=(label,value,note,color,attr,on,pct)=>kpiTile(label,value,note,color,attr,{on:!!on,pct});
  const kpis='<div class="gx-kpis">'+
   kt("Cycles this month",done+' <em class="gx-of">/ '+target+'</em>',cyPct+"% of monthly cycles complete","var(--success)",'onclick="washGlance(\'state\',\'done\')"',f.state==="done",cyPct)+
   (head?kt("Weekly compliance",wk==null?"—":wk+"%","target "+thr+"% · "+plural(pf.plants_below_threshold||0,"plant")+" below",wkTone,'onclick="washGlance(\'show\',\'below\')"',f.show==="below",wk==null?undefined:wk):'')+
   (head?kt("Behind deadline",late,late?plural(late,"plant")+" past a cycle deadline":"every plant on track",late?"var(--danger)":"var(--success)",'onclick="washGlance(\'state\',\'late\')"',f.state==="late",allN?Math.round(100*late/allN):0):'')+
   kt("Awaiting confirmation",pf.pending_reviews||0,"daily report"+((pf.pending_reviews||0)===1?"":"s")+" to review","var(--info)",'onclick="washGlance(\'show\',\'review\')"',f.show==="review")+
   kt("Tables cleaned today",pf.tables_washed_today||0,"confirmed today","#0891B2","")+'</div>';
  const heroLine=head
   ?(late?'<b class="gx-hot">'+plural(late,"plant")+' behind a cycle deadline</b>':'<b>Every plant on track</b>')+' · '+(pf.pending_reviews||0)+' report'+((pf.pending_reviews||0)===1?'':'s')+' awaiting confirmation · '+(pf.tables_washed_today||0)+' tables cleaned today'
   :'<b>'+done+' of '+target+' cycles complete</b> · '+(pf.pending_reviews||0)+' report'+((pf.pending_reviews||0)===1?'':'s')+' awaiting confirmation';
  const hero='<div class="gx-hero gx-hero-wash"><div class="gx-hero-copy"><span class="gx-eyebrow">PLANT WASHING · AT A GLANCE</span><h2>'+(f.plant!=="all"?h((plants.concat(unconfigured).find(p=>p.plant_id===f.plant)||{}).plant||"Selected plant"):"Portfolio washing")+'</h2><p>'+heroLine+'</p>'+
   (head&&late?'<button type="button" class="gx-hero-cta" onclick="washGlance(\'state\',\'late\')">Show late plants →</button>':'')+'</div>'+
   '<div class="gx-hero-score">'+(G?G.scoreRing(head?(wk==null?0:wk):cyPct,scoreColor):'')+'<div><b>'+(head?(wk==null?"—":wk+"%"):cyPct+"%")+'</b><small>'+(head?"weekly compliance":"cycles complete")+'</small><span>'+(head?"target "+thr+"% · "+done+" / "+target+" cycles":done+" / "+target+" cycles this month")+'</span></div></div></div>';
  const donutCard=G?G.donut({title:"Where the plants stand",sub:"Click a slice to list those plants",noun:"plants",attr:"data-wx-state",active:f.state,slices}):'';
  const maxCycles=Math.max(3,...plants.map(p=>p.monthly_target||3));
  const cycRows=[];for(let n=1;n<=maxCycles;n++){const c={n,done:0,run:0,wait:0,due:""};plants.forEach(p=>{const cy=(p.cycles||[]).find(x=>Number(x.cycle_no)===n);if(!cy)return;if(cy.state==="Completed")c.done++;else if(cy.state==="In progress")c.run++;else c.wait++;if(head&&cy.due_date&&(!c.due||cy.due_date<c.due))c.due=cy.due_date});cycRows.push(c)}
  const cycSeg=(n,state,count,cls,label)=>count?'<button type="button" class="gx-seg '+cls+(f.cyc===n+":"+state?" on":"")+'" style="flex:'+count+'" data-wx-cyc="'+n+':'+state+'" title="Cycle '+n+' · '+label+': '+plural(count,"plant")+' · click to list">'+count+'</button>':'';
  const cycleCard='<article class="gx-card"><header><h3>Cycle progress this month</h3><p>Plants per cycle · click a segment to list those plants</p></header><div class="gx-cycles">'+cycRows.map(c=>{const tot=c.done+c.run+c.wait;return '<div class="gx-cycle"><div class="gx-cycle-h"><b>Cycle '+c.n+'</b><small>'+(c.due?'first deadline '+fmt(c.due)+' · ':'')+c.done+' / '+tot+' done</small></div><div class="gx-segbar">'+(tot?cycSeg(c.n,"Completed",c.done,"done","Completed")+cycSeg(c.n,"In progress",c.run,"run","In progress")+cycSeg(c.n,"Not started",c.wait,"wait","Not started"):'<span class="gx-seg-empty">No plants set up</span>')+'</div></div>'}).join("")+'</div><div class="gx-mini-legend"><span><i style="background:#16A34A"></i>Completed</span><span><i style="background:#2563EB"></i>In progress</span><span><i style="background:#CBD5E1"></i>Not started</span></div></article>';
  const lowest=plants.filter(p=>p.active!==false&&typeof p.weekly_compliance_percent==="number").sort((x,y)=>x.weekly_compliance_percent-y.weekly_compliance_percent||x.plant.localeCompare(y.plant)).slice(0,6);
  const compCard=head?'<article class="gx-card"><header><h3>Lowest weekly compliance</h3><p>Plants furthest below target · click a plant to open its cycles and reports</p></header>'+(lowest.length?'<div class="gx-hbars gx-comp">'+lowest.map(p=>{const v=p.weekly_compliance_percent,t=p.compliance_threshold_percent||thr,c=v>=t?"#16A34A":v>=t-15?"#D97706":"#DC2626";return '<button type="button" class="gx-hbar" style="--c:'+c+'" onclick="openWashingPlantDetails(\''+h(p.plant_id)+'\')" title="'+h(p.plant)+': '+v+'% (target '+t+'%)"><span>'+h(p.plant)+'</span><i><b style="width:'+Math.max(v?4:0,Math.min(100,v))+'%"></b><u style="left:'+Math.min(100,t)+'%"></u></i><strong>'+v+'%</strong></button>'}).join("")+'</div>':'<div class="gx-allclear"><span>✓</span><b>No compliance data yet</b><small>Compliance appears once daily reports are confirmed.</small></div>')+'</article>':'';
  const stats='<div class="gx-glance gx-wash">'+hero+kpis+'<div class="gx-grid '+(head?'gx-grid-3':'gx-grid-2')+'">'+donutCard+cycleCard+compCard+'</div></div>';
  const counts={all:allN,attention:plants.filter(p=>p.active&&(p.overdue_bucket!=="on_track"||p.weekly_compliance_percent<p.compliance_threshold_percent)).length,review:plants.filter(p=>p.pending_tables_cleaned>0).length,notreported:plants.filter(p=>p.today_report==null).length,notsetup:unconfigured.length,mine:plants.filter(p=>p.assignee_user_id===S._currentUserId).length};
  const views=head?[["all","All"],["attention","Needs attention"],["review","Awaiting review"],["notreported","Not reported today"],["notsetup","Not set up"]].concat(role()==="Assignee"?[["mine","Mine"]]:[]):[["all","All"],["review","Awaiting review"],["notreported","Not reported today"]];
  const plantOpts=plants.map(p=>[p.plant_id,p.site_code+" · "+p.plant]).concat(unconfigured.map(p=>[p.plant_id,p.site_code+" · "+p.plant+"  — not set up"])).sort((a,b)=>a[1].localeCompare(b[1]));
  const assignees=Array.from(new Map(plants.filter(p=>p.assignee_user_id).map(p=>[p.assignee_user_id,p.assignee_name])).entries()).sort((a,b)=>String(a[1]).localeCompare(String(b[1])));
  const active=f.plant!=="all"||f.show!=="all"||f.bucket!=="all"||(f.state&&f.state!=="all")||(f.cyc&&f.cyc!=="all")||f.assignee!=="all"||f.region!=="all"||f.sort!=="late"||f.q;
  const bar=(allN>1||head)?'<div class="wx-bar">'+
   '<label class="wx-plant"><span>⌕</span><select data-pp aria-label="Choose a plant" onchange="washFilter(\'plant\',this.value)"><option value="all">All plants ('+allN+')</option>'+plantOpts.map(o=>'<option value="'+h(o[0])+'"'+(f.plant===o[0]?' selected':'')+'>'+h(o[1])+'</option>').join("")+'</select></label>'+
   '<div class="wx-seg" role="tablist" aria-label="Quick views">'+views.map(v=>'<button type="button" role="tab" aria-selected="'+(f.show===v[0])+'" class="'+(f.show===v[0]?'on':'')+'" onclick="washFilter(\'show\',\''+v[0]+'\')">'+v[1]+' <b>'+counts[v[0]]+'</b></button>').join("")+'</div>'+
   '<span class="wx-grow"></span>'+
   (head&&assignees.length?'<select class="wx-mini" aria-label="Filter by Assignee" onchange="washFilter(\'assignee\',this.value)"><option value="all">Any Assignee</option><option value="unassigned"'+(f.assignee==="unassigned"?' selected':'')+'>No Assignee</option>'+assignees.map(a=>'<option value="'+h(a[0])+'"'+(f.assignee===a[0]?' selected':'')+'>'+h(a[1])+'</option>').join("")+'</select>':'')+
   (active?'<button type="button" class="wx-clear" onclick="washClearFilters()">Clear</button>':'')+'</div>':'';
  const legend='<div class="wx-legend"><span><i class="st-ok"></i>On track</span><span><i class="st-review"></i>Waiting for confirmation</span><span><i class="st-late-1d"></i>1–2 d late</span><span><i class="st-late-3d"></i>3–6 d late</span><span><i class="st-late-7d"></i>7+ d late</span><span><i class="st-done"></i>Month done</span>'+(head?'<span><i class="st-unset"></i>Not set up</span>':'')+'</div>';
  const shown=filtered().list.length;
  const tools='<div class="wx-rtools"><select class="wx-mini" aria-label="Sort plants" onchange="washFilter(\'sort\',this.value)">'+[["late","Most late first"],["name","Name A–Z"],["compliance","Best compliance"],["progress","Most progress"]].map(o=>'<option value="'+o[0]+'"'+(f.sort===o[0]?' selected':'')+'>'+o[1]+'</option>').join("")+'</select>'+
   '<div class="wx-view" role="group" aria-label="Layout"><button type="button" class="'+(ui.view!=="table"?'on':'')+'" onclick="washSetView(\'tiles\')" title="Plant tiles" aria-label="Plant tiles">▦</button><button type="button" class="'+(ui.view==="table"?'on':'')+'" onclick="washSetView(\'table\')" title="Table" aria-label="Table">☰</button></div></div>';
  const results='<div class="wc-card wx-results" id="wc-results"><div class="wx-results-h"><h2>'+(f.plant!=="all"?"Plant":"Plants")+' <span>'+shown+' of '+allN+'</span></h2>'+(ui.view!=="table"?legend:'<span class="wx-grow"></span>')+tools+'</div>'+washFocusBar(f)+'<div id="wc-register">'+resultsHtml()+'</div></div>';
  const lower='<div class="wc-two">'+'<div class="wc-card"><h2>Cycle updates'+(head?' &amp; confirmations':'')+'</h2><p class="sub">Reports waiting for confirmation, cycles completed and the next cycle that started.</p>'+feedHtml()+'</div>'+
   (head?'<div class="wc-card"><h2>Assignee performance</h2><p class="sub">Ranked by weekly compliance, then average delay. O&amp;M team only.</p>'+rankingHtml()+'</div>':'')+'</div>';
  return '<div class="wc-page wx-page">'+header+stats+bar+results+lower+'</div>';
 };

 /* The washing tab gets a compact switcher instead of the full Preventive Maintenance banner. */
 if(typeof renderScheduledHub==="function"&&!window._wxHub){
  window._wxHub=true;
  const baseHub=renderScheduledHub;
  renderScheduledHub=function(){
   const onWash=S.omTab==="washing";
   const taskODN=(S.tasks||[]).filter(t=>typeof taskOD==="function"&&taskOD(t)>0).length,washODN=washDueCount();
   return '<div class="m26 m26-pm"><div class="pm-hub wx-hub"><div class="wx-switch" role="tablist" aria-label="Planned work"><button type="button" role="tab" aria-selected="'+(!onWash)+'"'+(onWash?'':' class="on"')+' onclick="goScheduledOM(&quot;maintenance&quot;)">🛠 Preventive Maintenance <span>'+taskODN+' overdue</span></button><button type="button" role="tab" aria-selected="'+onWash+'"'+(onWash?' class="on"':'')+' onclick="goScheduledOM(&quot;washing&quot;)">💧 Washing <span>'+washODN+' due</span></button></div>'+(onWash?renderWashing():renderScheduled())+'</div></div>';
  };
 }

 /* ---------- photos ---------- */
 const thumbs=new Map();
 function thumb(rep,ev){const c=thumbs.get(ev.url);return '<button class="wc-thumb" title="'+h(ev.name||"photo")+'" onclick="openWashingEvidence(\''+h(rep.id)+'\',\''+h(ev.id)+'\')"><img alt="" '+(c?'src="'+c+'"':'data-wc-src="'+h(ev.url)+'" class="wc-pending-img"')+'/></button>'}
 async function hydrate(){
  for(const img of Array.from(document.querySelectorAll("img[data-wc-src]"))){
   const url=img.getAttribute("data-wc-src");
   try{let o=thumbs.get(url);if(!o){const r=await authenticatedFetch(url);if(!r.ok)continue;o=URL.createObjectURL(await r.blob());thumbs.set(url,o)}img.src=o;img.removeAttribute("data-wc-src");img.classList.remove("wc-pending-img")}catch(e){}
  }
 }
 window.openWashingEvidence=async function(reportId,evidenceId){
  try{
   const r=await authenticatedFetch("/api/scheduled/washing/daily-reports/"+encodeURIComponent(reportId)+"/evidence/"+encodeURIComponent(evidenceId));
   if(!r.ok)throw new Error("Could not load photo (HTTP "+r.status+").");
   const url=URL.createObjectURL(await r.blob()),img=new Image();img.src=url;img.style.cssText="max-width:90vw;max-height:85vh;object-fit:contain";
   const box=document.createElement("div");box.style.cssText="position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center;padding:20px;cursor:zoom-out";
   box.append(img);box.onclick=()=>{URL.revokeObjectURL(url);box.remove()};document.body.append(box);
  }catch(e){toast(detailOf(e))}
 };

 /* ---------- plant overlay ---------- */
 window.openWashingPlantDetails=function(id){S.washTab=null;S.washMonth=(data().today||"").slice(0,7);S.washDetailsPlant=id;S.washReportPlant=id;S.washDayFocus=null;S.washEditReport=null;S.washShowAllReports=false;S.washReportDraft={status:"Done",tables:"",exception:"",remarks:"",date:""};S.modal="washingPlantDetails";S.modalCtx={};render()};
 window.washShowAllReports=async function(){S.washShowAllReports=true;S._washReportDays=90;render();try{await loadOverview()}catch(e){toast(detailOf(e,"Could not load older reports."))}};
 window.washFocusDay=function(d){S.washDayFocus=S.washDayFocus===d?null:d;render()};
 /* Site Engineer: pick any day in the last 45 days, enter the cleaned count and add before/after photos. The O&M Head / the plant's Assignee confirm it. */
 window.washReportForDay=function(day){
  if(!(isField()||isTeam())||!day)return;
  const d=S.washReportDraft||{status:"Done",tables:"",exception:"",remarks:"",date:""};d.date=day;S.washReportDraft=d;S.washDayFocus=day;render();
  setTimeout(function(){const el=document.getElementById("wc-date");if(el&&el.scrollIntoView)el.scrollIntoView({block:"center",behavior:"smooth"})},60);
 };
 function reportCard(r){
  const ev=r.evidence||[],by=k=>ev.filter(e=>e.kind===k),other=ev.filter(e=>e.kind!=="before"&&e.kind!=="after");
  const col=(title,list)=>'<div><h5>'+title+'</h5><div class="wc-thumbs">'+(list.length?list.map(e=>thumb(r,e)).join(""):'<div class="wc-nophoto">No '+title.toLowerCase()+' photo</div>')+'</div></div>';
  const tone=r.review_status==="Confirmed"?"ok":r.review_status==="Rejected"?"crit":"info";
  const upload=r.can_add_evidence?'<div class="wc-confirm"><label class="btn o sm">+ Before photos<input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onchange="uploadAdditionalWashingEvidence(\''+h(r.id)+'\',this,\'before\')"/></label><label class="btn o sm">+ After photos<input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onchange="uploadAdditionalWashingEvidence(\''+h(r.id)+'\',this,\'after\')"/></label></div>':'';
  const review=r.can_review?'<div class="wc-confirm"><input id="wc-review-'+h(r.id)+'" class="inp" placeholder="O&M note (required to reject)"/><button class="btn o sm" onclick="reviewWashingReport(\''+h(r.id)+'\',\'Reject\')">Reject</button><button class="btn p sm" onclick="reviewWashingReport(\''+h(r.id)+'\',\'Confirm\')">Confirm cleaning</button></div>':'';
  const manage=(r.can_edit||r.can_delete)?'<div class="wc-confirm">'+(r.can_edit?'<button class="btn o sm" onclick="washEditReportOpen(\''+h(r.id)+'\')">Edit this report</button>':'')+(r.can_delete?'<button class="btn g sm" onclick="washDeleteReport(\''+h(r.id)+'\')">Delete</button>':'')+'</div>':'';
  const editor=S.washEditReport===r.id?reportEditor(r):'';
  return '<div class="wc-rep"><div class="wc-rep-h"><div><b>'+fmt(r.report_date)+' · Cycle '+r.cycle_no+' · '+(r.job_status==="Done"?plural(r.tables_cleaned,"table")+" cleaned":"Not done — "+h(r.exception_reason))+'</b><small>Reported by '+h(r.reported_by||"—")+(r.remarks?' · “'+h(r.remarks)+'”':'')+'</small></div><div>'+chip(r.review_status==="Pending"?"Awaiting O&M confirmation":r.review_status,tone)+(r.cycle_completed?' '+chip("Cycle completed","ok"):'')+'</div></div>'+
   (r.job_status==="Done"?'<div class="wc-ba">'+col("Before",by("before"))+col("After",by("after"))+'</div>'+(other.length?'<div style="margin-top:8px"><h5 style="margin:0 0 6px;font-size:12.5px;text-transform:uppercase;color:var(--muted-foreground)">Other photos</h5><div class="wc-thumbs">'+other.map(e=>thumb(r,e)).join("")+'</div></div>':''):'')+
   (r.reviewed_by?'<div class="wc-cycle-label" style="margin-top:8px">'+h(r.review_status)+' by <b>'+h(r.reviewed_by)+'</b>'+(r.reviewed_at?' on '+fmt(r.reviewed_at.slice(0,10)):'')+(r.review_note?' — '+h(r.review_note):'')+'</div>':'')+upload+review+manage+editor+'</div>';
 }
 function reportEditor(r){
  const nd=r.job_status!=="Done",min=isTeam()?"":' min="'+h(isoDaysAgo(45))+'"';
  return '<div class="wc-edit"><h5>Edit report</h5><div class="row2"><div class="field"><span class="lbl">Date</span><input id="wc-ed-date" class="inp" type="date" value="'+h(r.report_date)+'"'+min+' max="'+h(data().today||"")+'"/></div>'+
   '<div class="field"><span class="lbl">Job status</span><select id="wc-ed-status" class="inp" onchange="washEditToggle()"><option'+(nd?"":" selected")+'>Done</option><option'+(nd?" selected":"")+'>Not done</option></select></div></div>'+
   '<div class="row2"><div class="field" id="wc-ed-count-f" style="display:'+(nd?"none":"block")+'"><span class="lbl">Tables cleaned</span><input id="wc-ed-tables" class="inp" type="number" min="1" value="'+h(r.tables_cleaned)+'"/></div>'+
   '<div class="field" id="wc-ed-reason-f" style="display:'+(nd?"block":"none")+'"><span class="lbl">Reason not done</span><select id="wc-ed-reason" class="inp"><option value="">Choose reason</option>'+REASONS.map(x=>'<option'+(r.exception_reason===x?" selected":"")+'>'+x+'</option>').join("")+'</select></div></div>'+
   '<div class="field"><span class="lbl">Remarks</span><textarea id="wc-ed-remarks" class="inp" rows="2" maxlength="4000">'+h(r.remarks||"")+'</textarea></div>'+
   '<div class="wc-confirm"><button class="btn o sm" onclick="washEditReportClose()">Cancel</button><button class="btn p sm" onclick="washEditReportSave(\''+h(r.id)+'\')">Save changes</button></div></div>';
 }
 /* ---- cycles for any month (past months included); O&M can set every cycle's start and deadline ---- */
 const monthName=m=>{const d=new Date(m+"-01T00:00:00");return isNaN(d)?m:d.toLocaleDateString("en-GB",{month:"long",year:"numeric"})};
 const shiftMonth=(m,n)=>{const d=new Date(Number(m.slice(0,4)),Number(m.slice(5,7))-1+n,1);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")};
 const monthCache=()=>S._washMonthCache=S._washMonthCache||{};
 function loadMonth(plantId,month,force){
  const key=plantId+"|"+month,c=monthCache();
  if(!force&&c[key])return;
  c[key]={loading:true};
  apiFetch("/api/scheduled/washing/plants/"+encodeURIComponent(plantId)+"/cycles?month="+encodeURIComponent(month))
   .then(r=>{c[key]=r}).catch(e=>{c[key]={error:detailOf(e,"Could not load this month.")}})
   .finally(()=>{if(S.modal==="washingPlantDetails"&&S.washDetailsPlant===plantId)render()});
 }
 function monthCyclesHtml(p){
  const thisMonth=(data().today||"").slice(0,7),month=S.washMonth||thisMonth,key=p.plant_id+"|"+month,mc=monthCache()[key];
  if(!mc)loadMonth(p.plant_id,month);
  const nav='<div class="wx-mnav"><button type="button" class="btn o sm" data-wmonth="-1" onclick="washMonthShift(-1)" aria-label="Previous month">‹</button><b>'+h(monthName(month))+'</b><button type="button" class="btn o sm" data-wmonth="1" onclick="washMonthShift(1)" aria-label="Next month">›</button>'+(month!==thisMonth?'<button type="button" class="btn g sm" onclick="washMonthShift(0)">This month</button>':'<span class="wx-now">Current month</span>')+'</div>';
  if(!mc||mc.loading)return nav+'<div class="wc-empty">Loading '+h(monthName(month))+'…</div>';
  if(mc.error)return nav+'<div class="bn-warn banner">'+h(mc.error)+'</div>';
  const edit=mc.can_edit,past=month<thisMonth,total=mc.table_count||p.table_count||1;
  const cards=mc.cycles.map(c=>{
   const pct=Math.min(100,Math.round(100*(c.state==="Completed"?total:c.confirmed)/total)),pp=Math.min(100-pct,Math.round(100*c.pending/total));
   const tone=c.state==="Completed"?"ok":c.state==="In progress"?"info":c.state==="Missed"?"crit":"mute";
   const info=c.state==="Completed"?'Completed '+fmt(c.completed_on)+(c.late_days?' · '+c.late_days+' d after deadline':' · on time'):c.state==="In progress"?c.confirmed+' of '+total+' tables confirmed'+(c.pending?' · '+c.pending+' awaiting':'')+(c.late_days?' · '+c.late_days+' d overdue':''):c.state==="Missed"?'No washing recorded':'Not started';
   const dates=edit?'<div class="wx-dates"><label>Start<input type="date" id="wx-s-'+c.cycle_no+'" value="'+h(c.start_date)+'" min="'+h(mc.first_day)+'" max="'+h(mc.last_day)+'"/></label><span>→</span><label>Deadline<input type="date" id="wx-d-'+c.cycle_no+'" value="'+h(c.due_date)+'" min="'+h(mc.first_day)+'" max="'+h(mc.last_day)+'"/></label></div>':'<div class="wx-dates ro">'+fmt(c.start_date)+' → '+fmt(c.due_date)+'</div>';
   return '<div class="wx-cy t-'+tone+'"><div class="wx-cy-h"><b>Cycle '+c.cycle_no+'</b>'+chip(c.state,tone)+'</div><div class="wc-bar"><i class="wc-bar-ok" style="width:'+pct+'%"></i><i class="wc-bar-pend" style="width:'+pp+'%"></i></div><p>'+info+'</p>'+dates+'</div>';
  }).join("");
  const pat=mc.pattern?'<div class="wx-pattern">🔁 Repeating every month since '+h(monthName(mc.pattern.from))+': '+mc.pattern.cycles.map(c=>c.start_day+'–'+c.due_day).join(" · ")+'</div>':'';
  const save=edit?'<div class="wx-save"><label class="wx-check"><input type="checkbox" id="wx-repeat"'+(mc.pattern&&mc.pattern.from===month?' checked':'')+'/> Use these dates every month from '+h(monthName(month))+' on</label><span class="wx-grow"></span><button type="button" class="btn g sm" onclick="washMonthDefaults()">Standard dates</button><button type="button" class="btn p sm" id="wx-save-btn" onclick="washSaveMonth(\''+h(p.plant_id)+'\')">Save dates</button></div>':'';
  const pastNote=past&&(isTeam()||isField())?'<div class="wx-past"><div><b>Washing done in '+h(monthName(month))+' but not recorded?</b><span>'+(isTeam()?'Record it on the date it was done — it counts towards that month\'s cycles.':'You can report dates from the last 45 days.')+'</span></div><button type="button" class="btn o sm" onclick="washRecordPast(\''+h(mc.first_day)+'\',\''+h(mc.last_day)+'\')">Record a past date</button></div>':'';
  return nav+'<p class="sub">'+(edit?'Any day of '+h(monthName(month))+' can be used. Each cycle must start on or before its deadline, and in order (cycle 1 → 2 → 3).':'Planned washing windows for '+h(monthName(month))+'.')+'</p><div class="wx-cys">'+cards+'</div>'+pat+save+pastNote;
 }
 window.washMonthShift=function(n){const thisMonth=(data().today||"").slice(0,7);S.washMonth=n===0?thisMonth:shiftMonth(S.washMonth||thisMonth,n);render()};
 window.washMonthDefaults=function(){
  const month=S.washMonth||(data().today||"").slice(0,7),mc=monthCache()[S.washDetailsPlant+"|"+month];if(!mc||!mc.cycles)return;
  mc.cycles.forEach(c=>{const a=document.getElementById("wx-s-"+c.cycle_no),b=document.getElementById("wx-d-"+c.cycle_no);if(a)a.value=c.default_start_date;if(b)b.value=c.default_due_date});
  toast("Standard dates filled in (1–10, 11–20, 21–month end). Press Save dates to keep them.");
 };
 let savingMonth=false;
 window.washSaveMonth=async function(plantId){
  if(savingMonth)return;
  const month=S.washMonth||(data().today||"").slice(0,7),cycles=[];
  for(const n of [1,2,3]){const a=(document.getElementById("wx-s-"+n)||{}).value,b=(document.getElementById("wx-d-"+n)||{}).value;if(!a||!b){toast("Fill in the start date and deadline for cycle "+n+".");return}cycles.push({cycle_no:n,start_date:a,due_date:b})}
  const repeat=!!(document.getElementById("wx-repeat")||{}).checked,btn=document.getElementById("wx-save-btn");
  savingMonth=true;if(btn){btn.disabled=true;btn.textContent="Saving…"}
  try{
   const r=await apiFetch("/api/scheduled/washing/plants/"+encodeURIComponent(plantId)+"/cycle-schedule",{method:"PUT",body:{month,cycles,apply_to_future:repeat}});
   const c=monthCache();Object.keys(c).forEach(k=>{if(k.startsWith(plantId+"|"))delete c[k]});c[plantId+"|"+month]=r;
   await loadOverview();render();toast("Cycle dates saved for "+monthName(month)+(repeat?" and every month after it.":"."));
  }catch(e){toast(detailOf(e,"Could not save the cycle dates."))}
  finally{savingMonth=false;const b=document.getElementById("wx-save-btn");if(b){b.disabled=false;b.textContent="Save dates"}}
 };
 window.washRecordPast=function(first,last){
  const d=S.washReportDraft||(S.washReportDraft={status:"Done",tables:"",exception:"",remarks:"",date:""});
  const min=isField()?isoDaysAgo(45):first;d.date=last<todayIso()?last:todayIso();if(d.date<min)d.date=min;
  S.washTab="record";render();
 };
 window.washTab=function(t){S.washTab=t;render()};
 function detailsModal(){
  const p=rowOf(S.washDetailsPlant);if(!p)return "";const head=isTeam();
  const reports=(data().reports||[]).filter(r=>r.plant_id===p.plant_id),focus=S.washDayFocus;
  const pending=reports.filter(r=>r.can_review),recent=focus?reports.filter(r=>r.report_date===focus):reports;
  const shown=focus?recent.slice(0,200):S.washShowAllReports?reports.slice(0,200):pending.concat(reports.filter(r=>!r.can_review).slice(0,Math.max(0,12-pending.length)));
  const photoCount=day=>reports.filter(r=>r.report_date===day).reduce((n,r)=>n+(r.evidence||[]).length,0),canDayReport=isField()||isTeam();
  const days=(p.daily_status||[]).slice().reverse().map(d=>'<tr class="wc-day'+(focus===d.date?" focus":"")+'" onclick="washFocusDay(\''+d.date+'\');washTab(\'reports\')"><td><b>'+fmt(d.date)+'</b></td>'+(head?'<td>'+d.target+'</td>':'')+'<td>'+d.confirmed+'</td><td>'+(d.pending||"—")+'</td><td>'+chip(d.status,dtone(d.status))+(d.exception?' <small>'+h(d.exception)+'</small>':'')+'</td><td>'+h(d.reported_by||"—")+'</td><td>'+(photoCount(d.date)||"—")+'</td>'+(canDayReport?'<td>'+(d.date<=todayIso()&&(head||d.date>=isoDaysAgo(45))?'<button class="btn o sm" onclick="event.stopPropagation();washReportForDay(\''+d.date+'\');washTab(\'record\')">Report / photos</button>':'')+'</td>':'')+'</tr>').join("");
  const wk=p.weekly_compliance_percent,thr=p.compliance_threshold_percent;
  const canReport=isField()||isTeam();
  const allReports=reports.length>shown.length&&!focus;
  const reviewGuidance=head?(pending.length?'<div class="wc-flow-note"><b>'+pending.length+' daily report'+(pending.length===1?'':'s')+' waiting for your review</b><p>Check the before and after photos, then confirm. The cycle completes automatically once all registered tables are confirmed.</p></div>':''):'';
  const reportSection='<div class="row between wrap"><p class="sub" style="margin:0 0 10px">'+(focus?'Showing '+fmt(focus):'Latest reports')+' · edit a report, add missing photos, or confirm it.</p>'+(focus?'<button class="btn g sm" onclick="washFocusDay(\''+focus+'\')">Show all</button>':'')+'</div>'+(shown.length?shown.map(reportCard).join(""):'<div class="wc-empty">No reports for this selection.</div>')+(allReports?'<div style="margin-top:10px"><button class="btn o sm" onclick="washShowAllReports()">Show all '+reports.length+' reports (older dates)</button></div>':'');
  const daySection='<p class="sub">What was cleaned each day this month, and whether it was confirmed. Click a day to see its reports and photos.</p><div class="wc-days-wrap"><table class="wc-days"><thead><tr><th>Date</th>'+(head?'<th>Target</th>':'')+'<th>Confirmed</th><th>Awaiting</th><th>Status</th><th>Reported by</th><th>Photos</th>'+(canDayReport?'<th></th>':'')+'</tr></thead><tbody>'+days+'</tbody></table></div>';
  const tabs=[["cycles","📅 Cycles & dates"]].concat(canReport?[["record",isField()?"✍ Report washing":"✍ Record washing"]]:[]).concat([["reports","📷 Reports & photos"+(pending.length?' <b class="wx-tabn">'+pending.length+'</b>':'')],["days","📊 Day by day"]]);
  const tab=tabs.some(t=>t[0]===S.washTab)?S.washTab:(head&&pending.length?"reports":isField()?"record":"cycles");
  const cur=(p.cycles||[]).find(c=>c.state==="In progress")||(p.cycles||[]).find(c=>c.state==="Upcoming");
  const conf=cur?cur.confirmed||0:p.table_count,pend=cur?cur.pending||0:0;
  const top='<div class="wx-ov-top">'+ring(conf,pend,p.table_count,cur?"Cycle "+cur.cycle_no:"Done")+'<div class="wx-ov-k"><b>'+(cur?conf+(pend?' <em>+'+pend+' awaiting</em>':'')+' of '+p.table_count+' tables · cycle '+cur.cycle_no:'All 3 cycles done this month')+'</b><div class="wx-ov-chips">'+
   (head?(p.overdue_bucket==="on_track"?chip("On track · next deadline "+fmt(p.next_due),"ok"):chip(p.overdue_days+" d late · cycle "+p.overdue_cycle+" was due "+fmt(p.next_due),TONE[p.overdue_bucket]))+chip("Weekly "+wk+"% (target "+thr+"%)",wk>=thr?"ok":wk>=thr-15?"warn":"crit"):'')+chip(p.cycles_this_month+" of "+p.monthly_target+" cycles this month","info")+'</div></div>'+
   (head?'<button class="btn g sm" onclick="openWashingSetup(\''+h(p.plant_id)+'\')">Edit setup</button>':'')+'</div>';
  const body=tab==="cycles"?monthCyclesHtml(p):tab==="record"?inlineReport(p):tab==="reports"?reviewGuidance+reportSection:daySection;
  return modal(h(p.plant)+' <small style="font-weight:500;color:var(--muted-foreground)">'+h(p.site_code)+'</small>',plural(p.table_count,"table")+' · washing Assignee: '+h(p.assignee_name||"not set"),
   '<div class="wc-ov wx-ov">'+top+'<div class="wx-tabs" role="tablist">'+tabs.map(t=>'<button type="button" role="tab" aria-selected="'+(t[0]===tab)+'" data-wtab="'+t[0]+'" class="'+(t[0]===tab?'on':'')+'" onclick="washTab(\''+t[0]+'\')">'+t[1]+'</button>').join("")+'</div><div class="wx-tabbody">'+body+'</div></div>',
   '<button class="btn o" onclick="closeModal()">Close</button>',true)+(setTimeout(hydrate,40),"");
 }


 const REASONS=["Rain","Water shortage","Equipment breakdown","Access restriction","Safety stand-down","Other"];
 const isoDaysAgo=n=>{const d=new Date();d.setDate(d.getDate()-n);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")};
 const todayIso=()=>data().today||isoDaysAgo(0);
 /* the report form shown inside the plant overlay: a site engineer can finish the whole job here without leaving it */
 function inlineReport(p){
  const d=S.washReportDraft||(S.washReportDraft={status:"Done",tables:"",exception:"",remarks:"",date:""}),nd=d.status==="Not done";
  const left=Math.max(0,p.table_count-p.confirmed_tables_cleaned-p.pending_tables_cleaned),date=d.date||todayIso();
  const hint=isField()?"Report the actual number cleaned on this date; daily amounts may vary. O&M reviews the report and photos.":'<b>Cycle '+p.current_cycle+'</b> · '+p.confirmed_tables_cleaned+' of '+p.table_count+' tables confirmed'+(p.pending_tables_cleaned?' (+'+p.pending_tables_cleaned+' awaiting confirmation)':'')+' · <b>'+left+' left</b>. Missed a day or a past month? Pick that date.';
  const team=!isField();
  return '<div class="wc-sec wc-inline-report"><h3>'+(team?'Record washing (O&amp;M entry)':'Report washing')+'</h3><p class="sub">'+hint+(team?' An O&amp;M entry is saved as confirmed. Before and after photos are recommended.':' Add before and after photos for O&amp;M review.')+'</p>'+
   '<div class="wc-form"><div class="row2"><div class="field"><span class="lbl">Date cleaned</span><input id="wc-date" class="inp" type="date" value="'+h(date)+'" min="'+h(isField()?isoDaysAgo(45):isoDaysAgo(730))+'" max="'+h(todayIso())+'" onchange="washReportDraftChanged()"/>'+(team?'<small>Past dates are allowed — they count towards that month\'s cycles.</small>':'')+'</div>'+
   '<div class="field"><span class="lbl">Job status</span><select id="wc-status" class="inp" onchange="washReportDraftChanged()"><option'+(nd?"":" selected")+'>Done</option><option'+(nd?" selected":"")+'>Not done</option></select></div></div>'+
   '<div class="row2"><div class="field" id="wc-count-field" style="display:'+(nd?"none":"block")+'"><span class="lbl">Tables cleaned today</span><input id="wc-tables" class="inp" type="number" min="1" max="'+p.table_count+'" value="'+h(d.tables)+'" placeholder="Enter actual count" oninput="washReportDraftChanged()"/>'+(isField()?'<small>No fixed daily target applies.</small>':'')+'</div>'+
   '<div class="field" id="wc-exception-field" style="display:'+(nd?"block":"none")+'"><span class="lbl">Reason work was not done</span><select id="wc-exception" class="inp" onchange="washReportDraftChanged()"><option value="">Choose reason</option>'+REASONS.map(x=>'<option'+(d.exception===x?" selected":"")+'>'+x+'</option>').join("")+'</select></div></div>'+
   '<div id="wc-photo-fields" class="row2" style="display:'+(nd?"none":"grid")+'"><div class="field"><span class="lbl">Before cleaning photos (up to 5)</span><input id="wc-before" class="inp" type="file" accept="image/jpeg,image/png,image/webp" multiple onchange="washPhotoSelection(\'before\',this)"/><small id="wc-before-selected" class="wc-photo-selection">Select before-cleaning photos</small></div><div class="field"><span class="lbl">After cleaning photos (up to 5)</span><input id="wc-after" class="inp" type="file" accept="image/jpeg,image/png,image/webp" multiple onchange="washPhotoSelection(\'after\',this)"/><small id="wc-after-selected" class="wc-photo-selection">Select after-cleaning photos</small></div></div>'+
   '<div class="field"><span class="lbl">Remarks</span><textarea id="wc-remarks" class="inp" rows="2" maxlength="4000" placeholder="What happened?" oninput="washReportDraftChanged()">'+h(d.remarks)+'</textarea></div>'+
   '<div class="wc-confirm"><button class="btn p" onclick="submitWashingDailyReport()">'+(team?'Save confirmed record':'Submit for O&amp;M confirmation')+'</button></div></div></div>';
 }
 /* ---------- O&M: move a cycle deadline ---------- */
 async function changeCycleDate(plantId,cycleNo,value,kind){
  const month=(data().today||"").slice(0,7),isS=kind==="start",body={month,cycle_no:cycleNo,field:isS?"start":"due"};
  if(isS)body.start_date=value||null;else body.due_date=value||null;
  const what=isS?"start date":"deadline";
  try{await apiFetch("/api/scheduled/washing/plants/"+encodeURIComponent(plantId)+"/cycle-date",{method:"PATCH",body});await loadOverview();render();toast(value?"Cycle "+what+" updated.":"Cycle "+what+" reset to the default.")}catch(e){toast(detailOf(e,"Could not change the cycle date."))}
 }
 window.washSaveCycleDate=function(plantId,cycleNo,kind){const el=document.getElementById((kind==="start"?"wc-cs-":"wc-cd-")+cycleNo);if(!el||!el.value){toast("Pick a date first.");return}changeCycleDate(plantId,cycleNo,el.value,kind)};
 window.washResetCycleDate=function(plantId,cycleNo,kind){changeCycleDate(plantId,cycleNo,null,kind)};
 /* ---------- edit / delete a report (O&M: any report; Site Engineer: own, until confirmed) ---------- */
 window.washEditReportOpen=function(id){S.washEditReport=id;render()};
 window.washEditReportClose=function(){S.washEditReport=null;render()};
 window.washEditToggle=function(){const st=(document.getElementById("wc-ed-status")||{}).value==="Not done",a=document.getElementById("wc-ed-count-f"),b=document.getElementById("wc-ed-reason-f");if(a)a.style.display=st?"none":"block";if(b)b.style.display=st?"block":"none"};
 window.washEditReportSave=async function(id){
  const v=k=>{const e=document.getElementById("wc-ed-"+k);return e?e.value:""},status=v("status"),body={report_date:v("date")||undefined,job_status:status,remarks:v("remarks")};
  if(status==="Done"){const n=Number(v("tables"));if(!Number.isInteger(n)||n<1){toast("Enter how many tables were cleaned.");return}body.tables_cleaned=n}
  else{if(!v("reason")){toast("Choose the reason the work was not done.");return}body.exception_reason=v("reason")}
  try{await apiFetch("/api/scheduled/washing/daily-reports/"+encodeURIComponent(id),{method:"PATCH",body});S.washEditReport=null;await loadOverview();render();toast("Report updated.")}catch(e){toast(detailOf(e,"Could not update the report."))}
 };
 window.washDeleteReport=async function(id){
  if(!confirm("Delete this washing report and its photos? This cannot be undone."))return;
  try{await apiFetch("/api/scheduled/washing/daily-reports/"+encodeURIComponent(id),{method:"DELETE"});S.washEditReport=null;await loadOverview();render();toast("Report deleted.")}catch(e){toast(detailOf(e,"Could not delete the report."))}
 };
 /* ---------- daily report (count + before/after photos) ---------- */
 window.openWashingDailyReport=function(id){S.washReportPlant=id;S.washReportDraft={status:"Done",tables:"",exception:"",remarks:"",date:""};S.modal="washingDailyReport";S.modalCtx={};render()};
 window.washReportDraftChanged=function(){
  const v=id=>{const e=document.getElementById(id);return e?e.value:undefined},d=S.washReportDraft||{};
  const n={status:v("wc-status"),tables:v("wc-tables"),exception:v("wc-exception"),remarks:v("wc-remarks"),date:v("wc-date")};
  Object.keys(n).forEach(k=>{if(n[k]!==undefined)d[k]=n[k]});S.washReportDraft=d;
  const nd=d.status==="Not done",a=document.getElementById("wc-exception-field"),b=document.getElementById("wc-count-field"),c=document.getElementById("wc-photo-fields");
  if(a)a.style.display=nd?"block":"none";if(b)b.style.display=nd?"none":"block";if(c)c.style.display=nd?"none":"grid";
 };
 function reportModal(){
  const p=rowOf(S.washReportPlant);if(!p)return "";
  const d=S.washReportDraft||{status:"Done",tables:"",exception:"",remarks:""},left=Math.max(0,p.table_count-p.confirmed_tables_cleaned-p.pending_tables_cleaned),nd=d.status==="Not done";
  const fieldHint=isField()?"Report the actual number cleaned on this date; daily amounts may vary. The O&M team reviews the report and photos.":'<b>Cycle '+p.current_cycle+'</b> · '+p.confirmed_tables_cleaned+' of '+p.table_count+' tables confirmed'+(p.pending_tables_cleaned?' (+'+p.pending_tables_cleaned+' awaiting confirmation)':'')+' · <b>'+left+' left to report</b>. When all tables are confirmed, the next cycle starts automatically.';
  return modal("Report today's washing",h(p.site_code)+" · "+h(p.plant),
   '<div class="wc-form"><div class="wc-hint">'+fieldHint+'</div>'+
   '<div class="field"><span class="lbl">Date cleaned</span><input id="wc-date" class="inp" type="date" value="'+h(d.date||todayIso())+'" min="'+h(isField()?isoDaysAgo(45):isoDaysAgo(730))+'" max="'+h(todayIso())+'" onchange="washReportDraftChanged()"/></div><div class="row2"><div class="field"><span class="lbl">Job status</span><select id="wc-status" class="inp" onchange="washReportDraftChanged()"><option'+(nd?"":" selected")+'>Done</option><option'+(nd?" selected":"")+'>Not done</option></select></div>'+
   '<div class="field" id="wc-count-field" style="display:'+(nd?"none":"block")+'"><span class="lbl">Tables cleaned today</span><input id="wc-tables" class="inp" type="number" min="1" max="'+p.table_count+'" value="'+h(d.tables)+'" placeholder="Enter actual count" oninput="washReportDraftChanged()"/>'+(isField()?'<small>Only report what was actually cleaned today; no fixed daily target applies.</small>':'')+'</div></div>'+
   '<div class="field" id="wc-exception-field" style="display:'+(nd?"block":"none")+'"><span class="lbl">Reason work was not done</span><select id="wc-exception" class="inp" onchange="washReportDraftChanged()"><option value="">Choose reason</option>'+["Rain","Water shortage","Equipment breakdown","Access restriction","Safety stand-down","Other"].map(x=>'<option'+(d.exception===x?" selected":"")+'>'+x+'</option>').join("")+'</select></div>'+
   '<div id="wc-photo-fields" class="row2" style="display:'+(nd?"none":"grid")+'"><div class="field"><span class="lbl">Before cleaning photos (up to 5)</span><input id="wc-before" class="inp" type="file" accept="image/jpeg,image/png,image/webp" multiple onchange="washPhotoSelection(\'before\',this)"/><small id="wc-before-selected" class="wc-photo-selection">Select before-cleaning photos</small></div><div class="field"><span class="lbl">After cleaning photos (up to 5)</span><input id="wc-after" class="inp" type="file" accept="image/jpeg,image/png,image/webp" multiple onchange="washPhotoSelection(\'after\',this)"/><small id="wc-after-selected" class="wc-photo-selection">Select after-cleaning photos</small></div></div>'+
   '<div class="field"><span class="lbl">Remarks</span><textarea id="wc-remarks" class="inp" rows="3" maxlength="4000" placeholder="What happened today?" oninput="washReportDraftChanged()">'+h(d.remarks)+'</textarea></div></div>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="submitWashingDailyReport()">'+(isField()?'Submit for O&amp;M confirmation':'Save confirmed record')+'</button>',true);
 }
 async function upload(reportId,files,kind){
  if(!files.length)return;const body=new FormData();files.forEach(f=>body.append("files",f,f.name));body.append("kind",kind);
  await apiFetch("/api/scheduled/washing/daily-reports/"+encodeURIComponent(reportId)+"/evidence",{method:"POST",body});
 }
 window.washPhotoSelection=function(kind,input){
  const output=document.getElementById("wc-"+kind+"-selected"),files=Array.from(input&&input.files||[]);
  if(output)output.textContent=files.length?files.length+" photo"+(files.length===1?"":"s")+" selected: "+files.slice(0,2).map(file=>file.name).join(", ")+(files.length>2?" and "+(files.length-2)+" more":""):"Select "+kind+"-cleaning photos";
 };
 window.submitWashingDailyReport=async function(){
  if(S._washReportSubmitting)return;
  washReportDraftChanged();
  const p=rowOf(S.washReportPlant||S.washDetailsPlant),d=S.washReportDraft||{};if(!p){toast("Select a configured plant.");return}
  const nd=d.status==="Not done",count=Number(d.tables),left=p.table_count-p.confirmed_tables_cleaned-p.pending_tables_cleaned,when=d.date||todayIso(),sameMonth=when.slice(0,7)===todayIso().slice(0,7);
  if(when>todayIso()){toast("The date cannot be in the future.");return}
  const fb=Array.from((document.getElementById("wc-before")||{}).files||[]),fa=Array.from((document.getElementById("wc-after")||{}).files||[]);
  if(!nd&&(!Number.isInteger(count)||count<1)){toast("Enter how many tables you cleaned today.");return}
  if(!nd&&sameMonth&&count>left){toast("Only "+left+" table(s) are left in this cycle.");return}
  if(nd&&!d.exception){toast("Choose the reason the work was not done.");return}
  if(fb.length>5||fa.length>5){toast("Choose no more than 5 before and 5 after photos.");return}
  if(!nd&&isField()&&(!fb.length||!fa.length)){toast("Add at least one before photo and one after photo so the O&M team can verify the report.");return}
  let saved=null;
  S._washReportSubmitting=true;
  try{
   saved=await apiFetch("/api/scheduled/washing/daily-reports",{method:"POST",body:{plant_id:p.plant_id,job_status:nd?"Not done":"Done",tables_cleaned:nd?0:count,cleaned_table_codes:[],exception_reason:nd?d.exception:null,remarks:(d.remarks||"").trim()||null,report_date:when}});
   await upload(saved.id,fb,"before");await upload(saved.id,fa,"after");
   const inOverlay=S.modal==="washingPlantDetails";
   if(!inOverlay)S.modal=null;
   S.washReportDraft={status:"Done",tables:"",exception:"",remarks:"",date:""};await loadOverview();render();toast(isField()?"Washing report submitted for O&M confirmation.":"Washing record saved and confirmed"+(!nd&&(!fb.length||!fa.length)?". Add before/after photos from the report card when you have them.":"."));
  }catch(e){
   if(saved){S.washDetailsPlant=p.plant_id;S.washReportPlant=p.plant_id;S.modal="washingPlantDetails";S.modalCtx={};S.washReportDraft={status:"Done",tables:"",exception:"",remarks:"",date:""};await loadOverview().catch(()=>{});render();toast("Report saved, but photo upload failed. Retry the missing photo from this report card. "+detailOf(e));return}
   toast(detailOf(e));
  }finally{
   S._washReportSubmitting=false;
  }
 };
 window.uploadAdditionalWashingEvidence=async function(reportId,input,kind){
  const files=Array.from(input&&input.files||[]);if(!files.length)return;
  try{await upload(reportId,files,kind||"other");await loadOverview();render();toast("Photos uploaded.")}catch(e){input.value="";toast(detailOf(e))}
 };
 window.reviewWashingReport=async function(id,decision){
  const rep=(data().reports||[]).find(r=>r.id===id),note=((document.getElementById("wc-review-"+id)||{}).value||"").trim();
  if(decision==="Reject"&&!note){toast("Add a note explaining the rejection.");return}
  if(decision==="Confirm"&&rep&&rep.job_status==="Done"&&(!rep.has_before||!rep.has_after)){toast("Upload at least one before and one after photo before confirming this report.");return}
  try{await apiFetch("/api/scheduled/washing/daily-reports/"+encodeURIComponent(id)+"/review",{method:"POST",body:{decision,remarks:note}});await loadOverview();render();toast(decision==="Confirm"?"Cleaning confirmed.":"Report rejected.")}catch(e){toast(detailOf(e))}
 };

 /* ---------- Command Center panel ---------- */
 function ccPanel(){
  if(!isTeam())return "";
  if(!S._washCycles){washCyclesEnsureLoaded();return ""}
  const d=data();if(!(d.plants||[]).length&&!(d.unconfigured||[]).length)return "";
  const pf=d.portfolio||{},late=(d.plants||[]).filter(p=>p.overdue_bucket!=="on_track").sort((a,b)=>b.overdue_days-a.overdue_days).slice(0,5);
  return '<div class="wc-card wc-cc"><div class="row between wrap"><div><h2>Plant washing</h2><p class="sub">'+(pf.cycles_completed_month||0)+' of '+(pf.cycles_target_month||0)+' monthly cycles complete · weekly compliance '+(pf.weekly_compliance_percent==null?"—":pf.weekly_compliance_percent+"%")+' · '+plural(pf.pending_reviews||0,"report")+' awaiting confirmation</p></div><button class="btn o sm" onclick="washOpenRegister()">Open washing register</button></div>'+matrixHtml(null,false)+
   (late.length?'<div class="wc-cc-list">'+late.map(p=>'<div class="wc-cc-row" onclick="S.view=\'om-module\';S.omTab=\'washing\';openWashingPlantDetails(\''+h(p.plant_id)+'\')"><span><b>'+h(p.plant)+'</b> · Cycle '+p.overdue_cycle+' due '+fmt(p.next_due)+'</span>'+chip(p.overdue_days+"d late",TONE[p.overdue_bucket])+'</div>').join("")+'</div>':'<div class="wc-empty" style="padding:8px">No plant is behind its cycle deadline.</div>')+'</div>';
 }
 if(typeof renderDashboard==="function"){const base=renderDashboard;renderDashboard=function(){return base.apply(this,arguments)+ccPanel()}}

 window.saveWashSetup=function(){toast("Use “Set up a plant” on the Washing page.")};
 const oldRenderModal=renderModal;
 renderModal=function(){
  if(S.modal==="washingCycleSetup")return plantSetupModal();
  if(S.modal==="washingDailyReport")return reportModal();
  if(S.modal==="washingPlantDetails")return detailsModal();
  return oldRenderModal.apply(this,arguments);
 };
})();
