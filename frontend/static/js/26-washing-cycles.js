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
  return modal("Set up plant washing","Set the plant table count and the Assignee responsible for this site.",
   '<div class="pm-form"><div class="field"><span class="lbl">Plant</span><select id="wc-plant" class="inp" onchange="washSetupPlantChanged()">'+plants.map(p=>'<option value="'+h(plantIdOf(p))+'"'+(plantIdOf(p)===draft.plantId?" selected":"")+'>'+h(typeof pmPlantLabelText==="function"?pmPlantLabelText(p.name):p.name)+'</option>').join("")+'</select></div>'+
   '<div class="kgrid" style="grid-template-columns:1fr 1fr;gap:12px"><div class="field"><span class="lbl">Number of tables</span><input id="wc-tables" class="inp" type="number" min="1" max="5000" value="'+h(draft.tables)+'" placeholder="e.g. 120" oninput="washSetupDraftChanged()"/></div><div class="field"><span class="lbl">Washing Assignee</span><select id="wc-assignee" class="inp" onchange="washSetupDraftChanged()">'+options+'</select></div></div>'+
   '<div class="field"><span class="lbl">Alert when weekly compliance falls below (%)</span><input id="wc-threshold" class="inp" type="number" min="1" max="100" value="'+h(draft.threshold)+'" oninput="washSetupDraftChanged()"/></div>'+hint+'</div>',
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
 window.washClearFilters=function(){const ui=S._washUi;Object.assign(ui,{q:"",bucket:"all",show:"all",assignee:"all",region:"all",sort:"late",page:1});S.washF=Object.assign({},ui);const el=document.getElementById("wc-register");if(el)el.innerHTML=registerHtml();render()};
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
   S.washCyclePlant=f.plantId;S.modal=null;S.washSetupDraft=null;
   try{await loadOverview()}catch(e){}
   render();toast("Plant washing setup saved.");
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
  const canReport=isField(),id=h(p.plant_id);
  return '<div class="wc-ex"><div class="wc-ex-cycles">'+cy+'</div><div class="wc-actions"><button class="btn o sm" onclick="openWashingPlantDetails(\''+id+'\')">Day-by-day &amp; photos</button>'+(canReport?'<button class="btn p sm" onclick="openWashingDailyReport(\''+id+'\')">Report today</button>':'')+(isTeam()?'<button class="btn g sm" onclick="openWashingSetup(\''+id+'\')">Edit setup</button>':'')+'</div></div>';
 }
 function filtered(){
  const ui=S._washUi=S._washUi||{q:"",bucket:"all",show:"all",assignee:"all",region:"all",sort:"late",page:1,pageSize:12,selected:[]};
  const f=S.washF=Object.assign({q:"",bucket:"all",show:"all"},ui),q=(f.q||"").trim().toLowerCase(),head=isTeam();
  const hit=p=>!q||(p.plant+" "+p.site_code).toLowerCase().includes(q);
  const configured=(data().plants||[]).filter(p=>hit(p)&&(f.bucket==="all"||p.overdue_bucket===f.bucket)&&
   (f.show==="all"||(f.show==="review"&&p.pending_tables_cleaned>0)||(f.show==="done"&&p.cycles_this_month>=p.monthly_target)||(f.show==="attention"&&head&&p.active&&(p.overdue_bucket!=="on_track"||p.weekly_compliance_percent<p.compliance_threshold_percent))||(f.show==="late"&&p.overdue_bucket!=="on_track")||(f.show==="below"&&p.active&&p.weekly_compliance_percent<p.compliance_threshold_percent)||(f.show==="notreported"&&p.today_report==null)||(f.show==="mine"&&p.assignee_user_id===S._currentUserId))&&
   (f.assignee==="all"||(f.assignee==="unassigned"?!p.assignee_user_id:p.assignee===p.assignee_user_id))&&
   (f.region==="all"||f.region===(p.district||p.location||"")));
  const un=(data().unconfigured||[]).filter(hit).map(p=>Object.assign({not_setup:true},p)).filter(p=>(f.show==="all"||f.show==="notsetup")&&(f.bucket==="all"||f.bucket==="on_track")&&(f.assignee==="all"||f.assignee==="unassigned")&&f.region==="all");
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
   const todayCell=todayChip(p),status=p.overdue_bucket==="on_track"?chip("On track","ok"):chip(p.overdue_days+" d late",TONE[p.overdue_bucket]||"warn");
   const confirmedPercent=current?Math.min(100,100*confirmed/(p.table_count||1)):100,pendingPercent=current?Math.min(100-confirmedPercent,100*pending/(p.table_count||1)):0,progress='<div class="wc-plant-progress"><div class="wc-bar"><i class="wc-bar-ok" style="width:'+confirmedPercent+'%"></i><i class="wc-bar-pend" style="width:'+pendingPercent+'%"></i></div><small>'+(current?confirmed+' confirmed'+(pending?' · '+pending+' pending':'')+' · '+remaining+' left':'All monthly cycles complete')+'</small></div>';
   const currentNo=current?current.cycle_no:null;
   const action=head?'<button class="btn o sm" onclick="event.stopPropagation();openWashingSetup(\''+h(p.plant_id)+'\')">Edit</button>':isField()?'<button class="btn p sm" onclick="event.stopPropagation();openWashingDailyReport(\''+h(p.plant_id)+'\')">Report</button>':'<button class="btn o sm" onclick="event.stopPropagation();openWashingPlantDetails(\''+h(p.plant_id)+'\')">View</button>';
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
  const el=document.getElementById("wc-register");if(el)el.innerHTML=registerHtml();
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

 window.renderWashing=function(){
  if(!S._washCycles&&!S._washCycleError){loadOverview().catch(()=>{});return '<div class="wc-card wc-empty">Loading plant washing…</div>'}
  if(S._washCycleError&&!S._washCycles)return '<div class="wc-card"><div class="bn-warn banner">Washing data could not be loaded: '+h(detailOf(S._washCycleError))+'</div><button class="btn o" onclick="S._washCycleError=null;S._washCycles=null;render()">Retry</button></div>';
  const d=data(),pf=d.portfolio||{},head=isTeam(),ui=S._washUi=S._washUi||{q:"",bucket:"all",show:"all",assignee:"all",region:"all",sort:"late",page:1,pageSize:12,selected:[]},f=S.washF=Object.assign({},ui),n=(d.plants||[]).length;
  const wk=pf.weekly_compliance_percent,thr=((d.plants||[])[0]&&d.plants[0].compliance_threshold_percent)||85;
  const intro=head?'Every plant needs <b>3 full washing cycles a month</b> (all tables washed each time — due by the 10th, 20th and month-end). Site engineers only report how many tables they cleaned; when the plant\'s table count is complete and confirmed, the next cycle starts automatically. Compliance and ranking below are for the O&amp;M team only.':'Report how many tables you cleaned today. When all tables of the plant are cleaned and confirmed, the next cycle starts automatically. Three cycles are completed every month.';
  const plants=d.plants||[],unconfigured=d.unconfigured||[],allN=plants.length+unconfigured.length;
  S._currentUserId=d.viewer_user_id||S._currentUserId;
  const quickViews=[["all","All plants",allN],["review","Waiting for confirmation",plants.filter(p=>p.pending_tables_cleaned>0).length],["below","Below weekly target",plants.filter(p=>p.active&&p.weekly_compliance_percent<p.compliance_threshold_percent).length],["notsetup","Not set up",unconfigured.length],["notreported","Not reported today",plants.filter(p=>p.today_report==null).length],["mine","Mine",plants.filter(p=>p.assignee_user_id===S._currentUserId).length]];
  const quick='<div class="wc-quickviews">'+quickViews.map(x=>'<button class="wc-quick'+(f.show===x[0]?" on":"")+'" onclick="washFilter(\'show\',\''+x[0]+'\')">'+x[1]+' <b>'+x[2]+'</b></button>').join("")+'</div>';
  const buckets='<div class="wc-bucket-tiles"><button class="wc-cell t-ok'+(f.bucket==="all"?" on":"")+'" onclick="washFilter(\'bucket\',\'all\')"><b>'+allN+'</b><span>All plants</span></button>'+BUCKETS.map(b=>'<button class="wc-cell t-'+b[3]+(f.bucket===b[0]?" on":"")+'" onclick="washFilter(\'bucket\',\''+b[0]+'\')"><b>'+(d.overdue_matrix[b[0]]||0)+'</b><span>'+b[1]+'</span></button>').join("")+'</div>';
  const assignees=Array.from(new Set(plants.map(p=>p.assignee_name).filter(Boolean))).sort((a,b)=>a.localeCompare(b));
  const regions=Array.from(new Set(plants.map(p=>p.district||p.location).filter(Boolean))).sort((a,b)=>a.localeCompare(b));
  const filters='<div class="wc-toolbar"><input class="inp wc-search" placeholder="Search plant or site code" value="'+h(f.q)+'" oninput="washFilter(\'q\',this.value)"/><select class="sel" onchange="washFilter(\'assignee\',this.value)"><option value="all">All Assignees</option><option value="unassigned"'+(f.assignee==="unassigned"?" selected":"")+'>Unassigned</option>'+assignees.map(a=>'<option value="'+h((plants.find(p=>p.assignee_name===a)||{}).assignee_user_id)+'"'+(f.assignee===(plants.find(p=>p.assignee_name===a)||{}).assignee_user_id?" selected":"")+'>'+h(a)+'</option>').join("")+'</select>'+
   (regions.length?'<select class="sel" onchange="washFilter(\'region\',this.value)"><option value="all">All regions</option>'+regions.map(r=>'<option value="'+h(r)+'"'+(f.region===r?" selected":"")+'>'+h(r)+'</option>').join("")+'</select>':'')+
   '<select class="sel" onchange="washFilter(\'sort\',this.value)">'+[["late","Most late first"],["name","Plant name"],["compliance","Weekly compliance"],["progress","Cycle progress"]].map(o=>'<option value="'+o[0]+'"'+(f.sort===o[0]?" selected":"")+'>'+o[1]+'</option>').join("")+'</select>'+
   (f.q||f.bucket!=="all"||f.show!=="all"||f.assignee!=="all"||f.region!=="all"||f.sort!=="late"?'<button class="btn g sm" onclick="washClearFilters()">Clear filters</button>':'')+'</div>';
  const kpis='<div class="wc-kpi"><div class="kpi-label">Plants set up</div><b>'+n+'</b><small>'+(pf.not_set_up?pf.not_set_up+' not set up yet':'all visible plants configured')+'</small></div>'+
   '<div class="wc-kpi"><div class="kpi-label">Cycles this month</div><b>'+(pf.cycles_completed_month||0)+' / '+(pf.cycles_target_month||0)+'</b><small>confirmed complete</small></div>'+
   '<div class="wc-kpi"><div class="kpi-label">Tables cleaned today</div><b>'+(pf.tables_washed_today||0)+'</b><small>confirmed today</small></div>'+
   '<div class="wc-kpi '+((pf.pending_reviews||0)?'warn':'')+'"><div class="kpi-label">Awaiting confirmation</div><b>'+(pf.pending_reviews||0)+'</b><small>daily reports to review</small></div>'+
   (head?'<div class="wc-kpi '+(wk>=thr?'ok':wk>=thr-15?'warn':'crit')+'"><div class="kpi-label">Weekly compliance</div><b>'+(wk==null?"—":wk+"%")+'</b><small>target '+thr+'% · '+plural(pf.plants_below_threshold||0,"plant")+' below</small></div><div class="wc-kpi '+((pf.plants_overdue||0)?'crit':'ok')+'"><div class="kpi-label">Plants behind deadline</div><b>'+(pf.plants_overdue||0)+'</b><small>past a cycle deadline</small></div>':'');
  return '<div class="wc-page"><div class="wc-head"><div><div class="kpi-label">SOLAR OPERATIONS · MODULE CLEANING</div><h1>Plant washing</h1><p>'+allN+' plants · '+(pf.plants_overdue||0)+' late · '+intro+'</p></div>'+(head?'<div class="row wrap"><button class="btn o" onclick="washImportExport()">Export Excel</button><button class="btn o" onclick="washImportOpen()">Upload Excel</button><button class="btn p" onclick="openWashingSetup()">Set up a plant</button></div>':'')+'</div>'+
   quick+buckets+
   '<div class="wc-kpis">'+kpis+'</div>'+
   '<div class="wc-two">'+(head?'<div class="wc-card"><h2>Behind-deadline matrix</h2><p class="sub">O&amp;M view: how late each plant is against the month\'s cycle deadlines. Click a box to filter the register.</p>'+matrixHtml(f.bucket,true)+'</div>':'')+'<div class="wc-card"><h2>Cycle updates'+(head?' &amp; confirmations':'')+'</h2><p class="sub">Cycles that were completed and the next cycle that started.</p>'+feedHtml()+'</div></div>'+
   '<div class="wc-card"><h2>Washing register</h2><p class="sub">Filter plants, check cycle progress, and open a plant for more detail.</p>'+filters+'<div id="wc-register">'+registerHtml()+'</div></div>'+
   (head?'<div class="wc-card"><h2>Assignee performance ranking</h2><p class="sub">Ranked by weekly compliance, then average delay. Visible to the O&amp;M team only — compliance target is '+thr+'%.</p>'+rankingHtml()+'</div>':'')+'</div>';
 };

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
 window.openWashingPlantDetails=function(id){S.washDetailsPlant=id;S.washReportPlant=id;S.washDayFocus=null;S.washEditReport=null;S.washShowAllReports=false;S.washReportDraft={status:"Done",tables:"",exception:"",remarks:"",date:""};S.modal="washingPlantDetails";S.modalCtx={};render()};
 window.washShowAllReports=async function(){S.washShowAllReports=true;S._washReportDays=90;render();try{await loadOverview()}catch(e){toast(detailOf(e,"Could not load older reports."))}};
 window.washFocusDay=function(d){S.washDayFocus=S.washDayFocus===d?null:d;render()};
 /* Site Engineer: pick any day in the last 45 days, enter the cleaned count and add before/after photos. The O&M Head / the plant's Assignee confirm it. */
 window.washReportForDay=function(day){
  if(!isField()||!day)return;
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
   (r.job_status==="Done"?'<div class="wc-ba">'+col("Before",by("before"))+col("After",by("after"))+'</div>'+(other.length?'<div style="margin-top:8px"><h5 style="margin:0 0 6px;font-size:11px;text-transform:uppercase;color:var(--muted-foreground)">Other photos</h5><div class="wc-thumbs">'+other.map(e=>thumb(r,e)).join("")+'</div></div>':''):'')+
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
 function detailsModal(){
  const p=rowOf(S.washDetailsPlant);if(!p)return "";const head=isTeam();
  const reports=(data().reports||[]).filter(r=>r.plant_id===p.plant_id),focus=S.washDayFocus;
  const shown=(focus?reports.filter(r=>r.report_date===focus):reports).slice(0,focus||S.washShowAllReports?200:12);
  const photoCount=day=>reports.filter(r=>r.report_date===day).reduce((n,r)=>n+(r.evidence||[]).length,0),canDayReport=isField();
  const days=(p.daily_status||[]).slice().reverse().map(d=>'<tr class="wc-day'+(focus===d.date?" focus":"")+'" onclick="washFocusDay(\''+d.date+'\')"><td><b>'+fmt(d.date)+'</b></td>'+(head?'<td>'+d.target+'</td>':'')+'<td>'+d.confirmed+'</td><td>'+(d.pending||"—")+'</td><td>'+chip(d.status,dtone(d.status))+(d.exception?' <small>'+h(d.exception)+'</small>':'')+'</td><td>'+h(d.reported_by||"—")+'</td><td>'+(photoCount(d.date)||"—")+'</td>'+(canDayReport?'<td>'+(d.date<=todayIso()&&d.date>=isoDaysAgo(45)?'<button class="btn o sm" onclick="event.stopPropagation();washReportForDay(\''+d.date+'\')">Report / photos</button>':'')+'</td>':'')+'</tr>').join("");
  const mk=(data().today||"").slice(0,7),mkLast=mk?new Date(Number(mk.slice(0,4)),Number(mk.slice(5,7)),0).getDate():31;
  const dateBox=(c,kind)=>{const isS=kind==="start",val=isS?c.start_date:c.due_date,def=isS?c.default_start_date:c.default_due_date,over=isS?c.start_overridden:c.due_overridden,id=(isS?"wc-cs-":"wc-cd-")+c.cycle_no;
   return '<div class="wc-cydate"><label>'+(isS?"Start date":"Deadline")+' <input type="date" id="'+id+'" value="'+h(val)+'" min="'+mk+'-01" max="'+mk+'-'+String(mkLast).padStart(2,"0")+'"/></label><button class="btn o sm" onclick="washSaveCycleDate(\''+h(p.plant_id)+'\','+c.cycle_no+',\''+kind+'\')">Save</button>'+(over?'<button class="btn g sm" onclick="washResetCycleDate(\''+h(p.plant_id)+'\','+c.cycle_no+',\''+kind+'\')">Reset to '+fmt(def)+'</button>':'')+'</div>'};
  const cycDate=c=>head?dateBox(c,"start")+dateBox(c,"due"):'';
  const cyc=(p.cycles||[]).map(c=>{const pct=p.table_count?Math.min(100,Math.round(100*(c.state==="Completed"?p.table_count:c.confirmed)/p.table_count)):0;
   return '<div class="wc-cy'+(c.state==="In progress"?" cur":"")+'"><h4>Cycle '+c.cycle_no+' '+chip(c.state,c.state==="Completed"?"ok":c.state==="In progress"?"info":"mute")+'</h4><div class="wc-bar"><i class="wc-bar-ok" style="width:'+pct+'%"></i>'+(c.state==="In progress"?'<i class="wc-bar-pend" style="width:'+Math.min(100-pct,Math.round(100*c.pending/(p.table_count||1)))+'%"></i>':'')+'</div><p>'+(c.state==="Completed"?'Completed '+fmt(c.completed_on)+(head?(c.late_days?' — '+c.late_days+' day(s) after the deadline':' — on time'):''):c.state==="In progress"?c.confirmed+' of '+p.table_count+' tables confirmed'+(c.pending?' · '+c.pending+' awaiting confirmation':'')+(head&&c.late_days?' · <b>'+c.late_days+' day(s) overdue</b>':''):'Starts after cycle '+(c.cycle_no-1)+' is confirmed')+'<br>'+(c.start_date?'Starts '+fmt(c.start_date)+(c.start_overridden?' <small>(changed)</small>':'')+' · ':'')+'Due '+fmt(c.due_date)+(c.due_overridden?' <small>(changed by O&amp;M)</small>':'')+'</p>'+cycDate(c)+'</div>'}).join("");
  const wk=p.weekly_compliance_percent,thr=p.compliance_threshold_percent;
  const canReport=isField();
  const allReports=reports.length>shown.length&&!focus;
  return modal(h(p.plant)+' <small style="font-weight:500;color:var(--muted-foreground)">'+h(p.site_code)+'</small>',plural(p.table_count,"table")+' · washing Assignee: '+h(p.assignee_name||"not set"),
   '<div class="wc-ov"><div class="wc-ov-top">'+(head?(p.overdue_bucket==="on_track"?chip("On track — next deadline "+fmt(p.next_due),"ok"):chip(p.overdue_days+" day(s) late — cycle "+p.overdue_cycle+" was due "+fmt(p.next_due),TONE[p.overdue_bucket]))+chip("Weekly compliance "+wk+"% (target "+thr+"%)",wk>=thr?"ok":wk>=thr-15?"warn":"crit"):"")+chip(p.cycles_this_month+" of "+p.monthly_target+" cycles done this month","info")+chip(plural(p.cycle_remaining,"table")+" left in cycle "+p.current_cycle,"mute")+'</div>'+
   (canReport?inlineReport(p):'')+'<div class="wc-cycles">'+cyc+'</div>'+
   '<div class="wc-sec"><h3>Day-by-day status — this month</h3><p class="sub">What was cleaned each day, and whether the O&amp;M team confirmed it. Click a day to see its photos'+(canDayReport?', or use Report / photos to enter that day\'s cleaned count and upload before &amp; after photos':'')+'.</p><div class="wc-days-wrap"><table class="wc-days"><thead><tr><th>Date</th>'+(head?'<th>Target</th>':'')+'<th>Confirmed</th><th>Awaiting</th><th>Status</th><th>Reported by</th><th>Photos</th>'+(canDayReport?'<th></th>':'')+'</tr></thead><tbody>'+days+'</tbody></table></div></div>'+
   '<div class="wc-sec"><div class="row between wrap"><div><h3>Before &amp; after photos and confirmation</h3><p class="sub">'+(focus?'Showing '+fmt(focus):'Latest reports')+' · the O&amp;M team confirms each report after checking the photos.</p></div>'+(focus?'<button class="btn g sm" onclick="washFocusDay(\''+focus+'\')">Show all</button>':'')+'</div>'+(shown.length?shown.map(reportCard).join(""):'<div class="wc-empty">No reports for this selection.</div>')+(allReports?'<div style="margin-top:10px"><button class="btn o sm" onclick="washShowAllReports()">Show all '+reports.length+' reports (older dates)</button></div>':'')+'</div></div>',
   '<button class="btn o" onclick="closeModal()">Close</button>'+"",true)+(setTimeout(hydrate,40),"");
 }


 const REASONS=["Rain","Water shortage","Equipment breakdown","Access restriction","Safety stand-down","Other"];
 const isoDaysAgo=n=>{const d=new Date();d.setDate(d.getDate()-n);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")};
 const todayIso=()=>data().today||isoDaysAgo(0);
 /* the report form shown inside the plant overlay: a site engineer can finish the whole job here without leaving it */
 function inlineReport(p){
  const d=S.washReportDraft||(S.washReportDraft={status:"Done",tables:"",exception:"",remarks:"",date:""}),nd=d.status==="Not done";
  const left=Math.max(0,p.table_count-p.confirmed_tables_cleaned-p.pending_tables_cleaned),date=d.date||todayIso();
  const hint=isField()?"Report the actual number cleaned on this date; daily amounts may vary. O&M reviews the report and photos.":'<b>Cycle '+p.current_cycle+'</b> · '+p.confirmed_tables_cleaned+' of '+p.table_count+' tables confirmed'+(p.pending_tables_cleaned?' (+'+p.pending_tables_cleaned+' awaiting confirmation)':'')+' · <b>'+left+' left</b>. Missed a day? Pick that date.';
  return '<div class="wc-sec wc-inline-report"><h3>Report washing</h3><p class="sub">'+hint+' Add before and after photos for O&amp;M review.</p>'+
   '<div class="wc-form"><div class="row2"><div class="field"><span class="lbl">Date cleaned</span><input id="wc-date" class="inp" type="date" value="'+h(date)+'" min="'+h(isoDaysAgo(45))+'" max="'+h(todayIso())+'" onchange="washReportDraftChanged()"/></div>'+
   '<div class="field"><span class="lbl">Job status</span><select id="wc-status" class="inp" onchange="washReportDraftChanged()"><option'+(nd?"":" selected")+'>Done</option><option'+(nd?" selected":"")+'>Not done</option></select></div></div>'+
   '<div class="row2"><div class="field" id="wc-count-field" style="display:'+(nd?"none":"block")+'"><span class="lbl">Tables cleaned today</span><input id="wc-tables" class="inp" type="number" min="1" max="'+p.table_count+'" value="'+h(d.tables)+'" placeholder="Enter actual count" oninput="washReportDraftChanged()"/>'+(isField()?'<small>No fixed daily target applies.</small>':'')+'</div>'+
   '<div class="field" id="wc-exception-field" style="display:'+(nd?"block":"none")+'"><span class="lbl">Reason work was not done</span><select id="wc-exception" class="inp" onchange="washReportDraftChanged()"><option value="">Choose reason</option>'+REASONS.map(x=>'<option'+(d.exception===x?" selected":"")+'>'+x+'</option>').join("")+'</select></div></div>'+
   '<div id="wc-photo-fields" class="row2" style="display:'+(nd?"none":"grid")+'"><div class="field"><span class="lbl">Before cleaning photos (up to 5)</span><input id="wc-before" class="inp" type="file" accept="image/jpeg,image/png,image/webp" multiple onchange="washPhotoSelection(\'before\',this)"/><small id="wc-before-selected" class="wc-photo-selection">Select before-cleaning photos</small></div><div class="field"><span class="lbl">After cleaning photos (up to 5)</span><input id="wc-after" class="inp" type="file" accept="image/jpeg,image/png,image/webp" multiple onchange="washPhotoSelection(\'after\',this)"/><small id="wc-after-selected" class="wc-photo-selection">Select after-cleaning photos</small></div></div>'+
   '<div class="field"><span class="lbl">Remarks</span><textarea id="wc-remarks" class="inp" rows="2" maxlength="4000" placeholder="What happened?" oninput="washReportDraftChanged()">'+h(d.remarks)+'</textarea></div>'+
   '<div class="wc-confirm"><button class="btn p" onclick="submitWashingDailyReport()">Submit for O&amp;M confirmation</button></div></div></div>';
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
   '<div class="field"><span class="lbl">Date cleaned</span><input id="wc-date" class="inp" type="date" value="'+h(d.date||todayIso())+'" min="'+h(isoDaysAgo(45))+'" max="'+h(todayIso())+'" onchange="washReportDraftChanged()"/></div><div class="row2"><div class="field"><span class="lbl">Job status</span><select id="wc-status" class="inp" onchange="washReportDraftChanged()"><option'+(nd?"":" selected")+'>Done</option><option'+(nd?" selected":"")+'>Not done</option></select></div>'+
   '<div class="field" id="wc-count-field" style="display:'+(nd?"none":"block")+'"><span class="lbl">Tables cleaned today</span><input id="wc-tables" class="inp" type="number" min="1" max="'+p.table_count+'" value="'+h(d.tables)+'" placeholder="Enter actual count" oninput="washReportDraftChanged()"/>'+(isField()?'<small>Only report what was actually cleaned today; no fixed daily target applies.</small>':'')+'</div></div>'+
   '<div class="field" id="wc-exception-field" style="display:'+(nd?"block":"none")+'"><span class="lbl">Reason work was not done</span><select id="wc-exception" class="inp" onchange="washReportDraftChanged()"><option value="">Choose reason</option>'+["Rain","Water shortage","Equipment breakdown","Access restriction","Safety stand-down","Other"].map(x=>'<option'+(d.exception===x?" selected":"")+'>'+x+'</option>').join("")+'</select></div>'+
   '<div id="wc-photo-fields" class="row2" style="display:'+(nd?"none":"grid")+'"><div class="field"><span class="lbl">Before cleaning photos (up to 5)</span><input id="wc-before" class="inp" type="file" accept="image/jpeg,image/png,image/webp" multiple onchange="washPhotoSelection(\'before\',this)"/><small id="wc-before-selected" class="wc-photo-selection">Select before-cleaning photos</small></div><div class="field"><span class="lbl">After cleaning photos (up to 5)</span><input id="wc-after" class="inp" type="file" accept="image/jpeg,image/png,image/webp" multiple onchange="washPhotoSelection(\'after\',this)"/><small id="wc-after-selected" class="wc-photo-selection">Select after-cleaning photos</small></div></div>'+
   '<div class="field"><span class="lbl">Remarks</span><textarea id="wc-remarks" class="inp" rows="3" maxlength="4000" placeholder="What happened today?" oninput="washReportDraftChanged()">'+h(d.remarks)+'</textarea></div></div>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="submitWashingDailyReport()">Submit for O&amp;M confirmation</button>',true);
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
  if(!nd&&(!fb.length||!fa.length)){toast("Add at least one before photo and one after photo so the O&M team can verify the report.");return}
  let saved=null;
  S._washReportSubmitting=true;
  try{
   saved=await apiFetch("/api/scheduled/washing/daily-reports",{method:"POST",body:{plant_id:p.plant_id,job_status:nd?"Not done":"Done",tables_cleaned:nd?0:count,cleaned_table_codes:[],exception_reason:nd?d.exception:null,remarks:(d.remarks||"").trim()||null,report_date:when}});
   await upload(saved.id,fb,"before");await upload(saved.id,fa,"after");
   const inOverlay=S.modal==="washingPlantDetails";
   if(!inOverlay)S.modal=null;
   S.washReportDraft={status:"Done",tables:"",exception:"",remarks:"",date:""};await loadOverview();render();toast("Washing report submitted for O&M confirmation.");
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