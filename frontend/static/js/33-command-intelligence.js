"use strict";
/* Solar91 operational experience: read-only answers, genuine filtered drill-downs,
   and report previews. All operational changes continue through existing authenticated APIs. */
(function(){
 const esc91 = v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const hasAppState=()=>typeof S!=='undefined';
 const role=()=>hasAppState()?(S._roleLabel||S.currentRole||''):'', siteName=()=>role()==='Site Engineer'?S._sePlant||null:null;
 const authorized=(rows)=>{const site=siteName();return site?(rows||[]).filter(x=>x.plant===site):(rows||[])};
 const reportRole=()=>role()!=='Site Engineer';
 const assistantHistoryPrefix='s91-assistant-history-v1:';
 const assistantPositionPrefix='s91-assistant-position-v1:';
 const assistantHistoryLimit=40;
 const assistantUserId=()=>typeof AUTH_IDENTITY!=='undefined'&&AUTH_IDENTITY.userId?String(AUTH_IDENTITY.userId):'';
 const assistantScopedKey=prefix=>{const userId=assistantUserId();return userId?prefix+encodeURIComponent(userId):''};
 function loadAssistantPosition(){
  try{
   const key=assistantScopedKey(assistantPositionPrefix);if(!key)return null;
   const value=JSON.parse(localStorage.getItem(key)||'null');
   if(!value||!Number.isFinite(value.left)||!Number.isFinite(value.top))return null;
   return{left:value.left,top:value.top};
  }catch{return null}
 }
 function saveAssistantPosition(position){
  try{const key=assistantScopedKey(assistantPositionPrefix);if(key)localStorage.setItem(key,JSON.stringify(position))}catch{}
 }
 function clampAssistantPosition(left,top,root){
  const margin=8,maxLeft=Math.max(margin,window.innerWidth-root.offsetWidth-margin);
  const maxTop=Math.max(margin,window.innerHeight-root.offsetHeight-margin);
  return{left:Math.min(maxLeft,Math.max(margin,left)),top:Math.min(maxTop,Math.max(margin,top))};
 }
 function applyAssistantPosition(root){
  if(!assistant.position){root.style.left='';root.style.top='';root.style.right='';root.style.bottom='';return}
  const position=clampAssistantPosition(assistant.position.left,assistant.position.top,root);
  assistant.position=position;
  root.style.left=position.left+'px';root.style.top=position.top+'px';
  root.style.right='auto';root.style.bottom='auto';
 }
 function syncAssistantUser(){
  const userId=assistantUserId();
  if(userId!==assistant.userId){
   assistant.userId=userId;assistant.log=[];assistant.position=null;
   assistant.more=null;assistant.lastQuery='';assistant.busy=false;assistant.historyLoaded=false;
  }
  if(!userId||!document.querySelector('#app .shell')){
   assistant.log=[];assistant.position=null;assistant.historyLoaded=false;return;
  }
  if(!assistant.historyLoaded){
   try{localStorage.removeItem('s91-assistant-history-v1')}catch{}
   assistant.log=loadAssistantHistory();assistant.position=loadAssistantPosition();assistant.historyLoaded=true;
  }
 }
 // Keep recent chat history locally; do not age-prune it to prevent older valid
 // follow-up questions from disappearing after a two-day window.
 function loadAssistantHistory(){
  try{
   const key=assistantScopedKey(assistantHistoryPrefix);if(!key)return[];
   const raw=localStorage.getItem(key);if(!raw)return[];
   const parsed=JSON.parse(raw);if(!Array.isArray(parsed))return[];
   return parsed.map(entry=>({who:entry?.who==='user'?'user':'bot',text:String(entry?.text||'').trim(),action:Array.isArray(entry?.action)?entry.action.slice(0,2).map(String):null,records:Array.isArray(entry?.records)?entry.records.slice(0,8):[],when:Number(entry?.when)||Date.now()})).filter(entry=>entry.text).slice(-assistantHistoryLimit);
  }catch{return[]}
 }
 function saveAssistantHistory(log){
  try{
   const key=assistantScopedKey(assistantHistoryPrefix);if(!key)return;
   if(!Array.isArray(log)||!log.length){localStorage.removeItem(key);return}
   const next=log.slice(-assistantHistoryLimit).map(entry=>({who:entry?.who==='user'?'user':'bot',text:String(entry?.text||'').trim(),action:Array.isArray(entry?.action)?entry.action.slice(0,2).map(String):null,records:Array.isArray(entry?.records)?entry.records.slice(0,8):[],when:Number(entry?.when)||Date.now()})).filter(entry=>entry.text);
   localStorage.setItem(key, JSON.stringify(next));
  }catch{}
 }
 function destination(selector,label){
  let tries=0;
  function go(){const node=document.querySelector(selector);if(!node&&tries++<12){setTimeout(go,90);return}
   if(!node)return;node.classList.add('s91-register-focus');
   node.scrollIntoView({behavior:'smooth',block:'start'});
   const parent=document.querySelector('.content');if(parent&&getComputedStyle(parent).overflowY!=='visible'){
    const y=node.getBoundingClientRect().top-parent.getBoundingClientRect().top+parent.scrollTop-20;
    parent.scrollTo({top:Math.max(0,y),behavior:'smooth'});
   }
   const hint=document.createElement('span');hint.className='s91-register-focus-label';hint.textContent=label+' · filtered register';
   node.prepend(hint);setTimeout(()=>{hint.remove();node.classList.remove('s91-register-focus')},5500);
  }setTimeout(go,80);
 }
 window.s91OpenQueue=function(module,queue){
  if(!hasAppState())return;
  const plant=siteName()||((S.issF||{}).plant!=='all'&&(S.issF||{}).plant)||((S.dashPlant!=='all')&&S.dashPlant)||'all';
  if(module==='issues'){
   if(queue==='critical'||queue==='overdue'||queue==='other'){
    if(typeof openDashboardIssueQueue==='function')openDashboardIssueQueue(queue);
    else {S.issF=blankIssF({plant,queue});goTab('issues')}
   } else {
    S.issF=blankIssF({plant,chip:queue==='unassigned'?'Unassigned':'Open'});
    S.tablePages.issues=1;goTab('issues');
   }
   destination('#section-results','Site Issues');return;
  }
  if(module==='pm'){
   const f=S.pmLive||(S.pmLive={});
   Object.assign(f,{plant:plant==='all'?'all':plant,status:queue==='overdue'?'Overdue':queue==='due'?'Due soon':queue==='done'?'Done':'all',age:'all',week:'all',equipment:'all',query:'',page:1});
   S.schedScope=plant;goScheduledOM('maintenance');
   destination('.pml-register','Preventive Maintenance');return;
  }
  if(module==='washing'){
   const f=S._washUi||(S._washUi={q:'',bucket:'all',show:'all',assignee:'all',region:'all',sort:'late',page:1,pageSize:12,selected:[]});
   Object.assign(f,{bucket:'all',show:queue==='review'?'review':queue==='late'?'late':'all',sort:'late',page:1});
   if(typeof washOpenRegister==='function')washOpenRegister();else goScheduledOM('washing');
   // washOpenRegister resets the bucket, but not show, so the selected queue survives.
   destination('#wc-register','Washing');return;
  }
 };
 const previewState={kind:'daily'};
 function previewMarkup(){
  const kind=previewState.kind;
  const data=typeof reportRowsForHub==='function'?reportRowsForHub(kind):null;
  const all=data?.rows||[];const cols=data?.cols||[];
  return '<div class="s91-sheet-shade" data-s91-close-report="1"><section class="s91-report-sheet" role="dialog" aria-modal="true" aria-label="Operations report preview"><header><div><span class="s91-eyebrow">SOLAR91 · OPERATIONAL INTELLIGENCE</span><h2>Operations report</h2><p>Read-only snapshot of currently loaded reports. Use Reports for full context.</p></div><button class="s91-close" data-s91-close-report="1" aria-label="Close report">×</button></header><nav aria-label="Report period" class="s91-report-segments">'+['daily','weekly','monthly','open','overdue'].map(k=>'<button data-s91-report-period="'+k+'" class="'+(kind===k?'active':'')+'">'+({daily:'Today',weekly:'7 days',monthly:'30 days',open:'Open tickets',overdue:'Overdue'}[k])+'</button>').join('')+'</nav><div class="s91-report-body"><div class="s91-report-summary"><span>SELECTED SUMMARY</span><b>'+esc91(data?.title||'Unavailable')+'</b><small>'+all.length+' row'+(all.length===1?'':'s')+' in this preview</small></div><div class="s91-report-table-wrap"><table><thead><tr>'+cols.map(c=>'<th>'+esc91(c)+'</th>').join('')+'</tr></thead><tbody>'+(all.length?all.slice(0,12).map(row=>'<tr>'+row.map(cell=>'<td>'+esc91(cell)+'</td>').join('')+'</tr>').join(''):'<tr><td colspan="'+Math.max(1,cols.length)+'">No records found in this selection</td></tr>')+'</tbody></table></div>'+(all.length>12?'<p class="s91-preview-note">First 12 rows shown · '+(all.length-12)+' additional rows in full report</p>':'')+'</div><footer><button class="s91-secondary-btn" data-s91-download-preview="1">Download CSV</button><button class="s91-secondary-btn" data-s91-excel-preview="1">Export Excel</button><button class="s91-secondary-btn" data-s91-print-preview="1">Print / PDF</button><button class="s91-secondary-btn" data-s91-open-all-reports="1">Full Reports</button><button class="s91-primary-btn" data-s91-close-report="1">Done</button></footer></section></div>';
 }
 function redrawPreview(){let root=document.getElementById('s91-report-root');if(!root){root=document.createElement('div');root.id='s91-report-root';document.body.appendChild(root)}root.innerHTML=previewMarkup();root.querySelector('.s91-close').focus({preventScroll:true})}
 window.s91OpenReportPreview=function(kind){if(!hasAppState()||!reportRole())return;previewState.kind=['daily','weekly','monthly','open','overdue'].includes(kind)?kind:'daily';redrawPreview()};
 function downloadCsv(){
  const report=typeof reportRowsForHub==='function'?reportRowsForHub(previewState.kind):null;
  if(!report)return;
  // Escape spreadsheet formulas so malicious imported text cannot execute on opening CSV.
  const safeCell=v=>{let text=String(v==null?'':v);if(/^[\s]*[=+@\-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"'};
  const csv=[report.cols,...report.rows].map(row=>row.map(safeCell).join(',')).join('\r\n');
  const file=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(file),a=document.createElement('a');
  a.href=url;a.download='solar91-'+previewState.kind+'-operations-'+(typeof TODAY==='string'?TODAY:new Date().toISOString().slice(0,10))+'.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
  if(typeof toast==='function')toast('CSV export prepared: '+report.rows.length+' rows');
 }
 async function downloadExcel(button){
  const report=typeof reportRowsForHub==='function'?reportRowsForHub(previewState.kind):null;
  if(!report)return;
  button.disabled=true;button.textContent='Preparing Excel…';
  try{
   if(typeof ensureXlsxLoaded==='function')await ensureXlsxLoaded();
   if(typeof XLSX==='undefined')throw new Error('Excel library is unavailable. Use CSV instead.');
   const safe=v=>{const s=String(v==null?'':v);return /^[\s]*[=+@\-]/.test(s)?"'"+s:s};
   const wb=XLSX.utils.book_new(),ws=XLSX.utils.aoa_to_sheet([report.cols,...report.rows].map(row=>row.map(safe)));
   XLSX.utils.book_append_sheet(wb,ws,'Operations');
   XLSX.writeFile(wb,'Solar91_'+previewState.kind+'_operations_'+(typeof TODAY==='string'?TODAY:new Date().toISOString().slice(0,10))+'.xlsx');
   if(typeof toast==='function')toast('Excel export prepared: '+report.rows.length+' rows');
  }catch(error){if(typeof toast==='function')toast('Excel export failed: '+error.message)}
  finally{button.disabled=false;button.textContent='Export Excel'}
 }
 document.addEventListener('click',e=>{
  if(e.target.matches('.s91-sheet-shade[data-s91-close-report]')||e.target.closest('button[data-s91-close-report]')){document.getElementById('s91-report-root')?.remove();return}
  const p=e.target.closest('[data-s91-report-period]');if(p){previewState.kind=p.dataset.s91ReportPeriod;redrawPreview();return}
  if(e.target.closest('[data-s91-download-preview]')){downloadCsv();return}
  const excel=e.target.closest('[data-s91-excel-preview]');if(excel){downloadExcel(excel);return}
  if(e.target.closest('[data-s91-print-preview]')){window.print();return}
  if(e.target.closest('[data-s91-open-all-reports]')){document.getElementById('s91-report-root')?.remove();if(reportRole()){S.reportKind=previewState.kind;goView('reports');destination('.ops-report-table','Reports')}return}
 });
 const assistant={open:false,log:[],more:null,lastQuery:'',busy:false,userId:'',position:null,dragged:false,historyLoaded:false};
 const allowedAssistantRoles=['O&M Head','Assignee','Administration','Site Engineer'];
 const stopWords=new Set(('a an and are at by can current do for from give how i in is it me my of on or please show tell the their them there this to what where which with about all details find information records search status data list view want overdue overdues late open critical high medium low pending awaiting completed complete done resolved closed unassigned assigned active').split(' '));
 const moduleWords={
  issues:['issue','issues','ticket','tickets','fault','faults','breakdown'],
  pm:['pm','preventive','maintenance','workorder','task','tasks'],
  washing:['wash','washing','clean','cleaning'],
  plants:['plant','plants','site','sites','portfolio'],
  equipment:['equipment','asset','assets','machine','machines'],
  inventory:['inventory','stock','spare','spares','parts'],
  handovers:['handover','handovers','commissioning'],
  incidents:['incident','incidents','safety','near miss'],
  documents:['document','documents','certificate','certificates'],
  vendors:['vendor','vendors','supplier','suppliers'],
  services:['service','services','service request','extra service'],
  ptw:['permit','ptw','loto']
 };
 function scope(){
  const roleNow=role();
  if(!allowedAssistantRoles.includes(roleNow))return null;
  const site=siteName(),plants=site?(S.plants||[]).filter(p=>p.name===site||p.id===site):(S.plants||[]);
  const plantIds=new Set(plants.flatMap(p=>[String(p.dbId||''),String(p.id||''),String(p.name||'')]));
  const scoped=rows=>(rows||[]).filter(x=>!site||plantIds.has(String(x.plant||x.plant_id||'')));
  const collections=[
   ['Plant','plants',plants],
   ['Ticket','issues',scoped(S.issues)],
   ['Preventive Maintenance','tasks',scoped(S.tasks)],
   ['Equipment','equipment',scoped(S.equipment)],
   ['Washing','washing',scoped(S.washing)],
   ['Washing','washing',((S._washCycles||{}).plants||[]).filter(p=>!site||plantIds.has(String(p.plant||p.plant_id||'')))],
   ['Washing report','washing',((S._washCycles||{}).reports||[]).filter(p=>!site||plantIds.has(String(p.plant||p.plant_id||'')))],
   ['Handover','handovers',S.handovers],
   ['Inventory','inventory',S.inventory],
   ['Stock movement','inventory',S.movements],
   ['Incident','incidents',S.incidents],
   ['Document','documents',S.docs],
   ['Vendor','vendors',S.vendors],
   ['Service request','services',S.serviceRequests],
   ['Permit','ptw',S.ptw],
   ['Rule','settings',S.rules],
   ['SLA','settings',S.sla]
  ];
  const visible=roleNow==='O&M Head'?new Set(collections.map(x=>x[1])):
   roleNow==='Administration'?new Set(['plants','issues','tasks','washing','equipment']):new Set(['plants','issues','tasks','equipment','washing']);
  const records=[];
  for(const [label,module,rows] of collections){
   if(!visible.has(module))continue;
   for(const row of rows||[]){
    if(!row||typeof row!=='object')continue;
    const plant=row.plant||row.plant_name||(plants.find(p=>String(p.dbId||p.id)===String(row.plant_id))||{}).name||'';
    if(site&&plant&&!plantIds.has(String(plant)))continue;
    const id=row.id||row.work_order_no||row.ticket_no||row.equipment_code||row.name||row.equipment_name||'';
    records.push({label,module,id:String(id),plant:String(plant),row});
   }
  }
  return{plants,records,role:roleNow};
 }
 function searchableText(value,depth){
  if(depth>4||value==null)return'';
  if(typeof value==='string'||typeof value==='number'||typeof value==='boolean')return String(value);
  if(Array.isArray(value))return value.slice(0,30).map(v=>searchableText(v,depth+1)).join(' ');
  if(typeof value==='object')return Object.entries(value).filter(([key])=>!/photo|image|base64|binary|token|secret|password|signed.?url/i.test(key)).map(([key,v])=>key+' '+searchableText(v,depth+1)).join(' ');
  return'';
 }
 function cleanQuery(value){
  return String(value||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}_-]+/gu,' ').trim().split(/\s+/).filter(x=>x.length>1&&!stopWords.has(x));
 }
 function moduleForQuery(q){
  const normalized=q.toLowerCase();
  const keys=Object.keys(moduleWords).filter(key=>key!=='plants');
  const match=keys.find(key=>moduleWords[key].some(word=>new RegExp('(^|\\W)'+word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(\\W|$)','i').test(normalized)));
  return match||(/plant|plants|site|sites|portfolio/.test(normalized)?'plants':'');
 }
 function resultSummary(item,terms){
  const r=item.row,plant=item.plant||r.plant_name||'',state=r.status||r.review_status||r.state||'';
  const name=r.name||r.task_name||r.equipment_name||r.equipment_type||r.description||r.desc||r.item||r.title||'';
  const identifier=item.module==='equipment'&&r.equipment_code?r.equipment_code:item.id;
  const matched=terms.filter(term=>item.search.includes(term)).slice(0,4);
  return item.label+' '+identifier+(name&&name!==identifier?' · '+String(name).slice(0,90):'')+
   (plant?' · '+plant:'')+(state?' · '+state:'')+(matched.length?' · matched: '+matched.join(', '):'');
 }
 function searchPage(q,data,found,start,intro){
  const page=found.results.slice(start,start+20);
  assistant.more=start+page.length<found.count?{query:q,offset:start+page.length,total:found.count}:null;
  const heading=intro||('Records '+(start+1)+'–'+(start+page.length)+' of '+found.count+':');
  return heading+(page.length?'\n'+page.map(item=>resultSummary(item,found.terms)).join('\n'):'');
 }
 function searchRecords(q,data){
  const terms=cleanQuery(q),module=moduleForQuery(q),specificWords=new Set();
  for(const p of data.plants||[]){
   for(const value of [p.name,p.id])for(const token of cleanQuery(value))specificWords.add(token);
  }
  for(const item of data.records){
   if(item.module==='equipment')for(const value of [item.row.equipment_code,item.row.equipment_name,item.row.equipment_type,item.row.maker,item.row.model,item.row.serial_number])for(const token of cleanQuery(value))specificWords.add(token);
  }
  const scopedModule=module==='pm'?'tasks':module==='issues'?'issues':module==='equipment'?['equipment','issues','tasks']:module==='plants'?'plants':module;
  const directEntity=terms.some(t=>specificWords.has(t)||/\d/.test(t));
  const normalized=terms.filter(t=>!Object.values(moduleWords).flat().includes(t));
  const candidates=data.records.map(item=>{
   item.search=(item.plant+' '+searchableText(item.row,0)).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
   if(module&&!(Array.isArray(scopedModule)?scopedModule.includes(item.module):item.module===scopedModule))return null;
   const row=item.row,status=String(row.status||row.review_status||'').toLowerCase();
   if(/\b(overdue|late)\b/.test(q)){
    const overdue=item.module==='issues'?typeof isOverdueIssue==='function'&&isOverdueIssue(row):
     item.module==='tasks'?typeof taskOD==='function'&&taskOD(row)>0:
     item.module==='washing'?Number(row.overdue_days||0)>0||/overdue|late/i.test(searchableText(row,0)):false;
    if(!overdue)return null;
   }
   if(/\b(open|active)\b/.test(q)&&item.module==='issues'&&['closed','resolved'].includes(status))return null;
   if(/\b(open|active)\b/.test(q)&&item.module==='tasks'&&['completed','cancelled'].includes(status))return null;
   if(/\bcritical\b/.test(q)&&item.module==='issues'&&String(row.severity||'').toLowerCase()!=='critical')return null;
   if(/\bunassigned\b/.test(q)&&item.module==='issues'&&row.assignee)return null;
   if(/\b(pending|awaiting)\b/.test(q)&&item.module==='washing'&&!/pending/i.test(status))return null;
   const hits=normalized.filter(t=>item.search.includes(t)).length;
   if(normalized.length&&hits===0)return null;
   if(directEntity&&normalized.length>1&&hits<normalized.length)return null;
   const score=hits*10+(normalized.length&&hits===normalized.length?20:0)+(item.id&&q.toLowerCase().includes(item.id.toLowerCase())?100:0);
   return{item,score};
  }).filter(Boolean).sort((a,b)=>b.score-a.score||a.item.label.localeCompare(b.item.label));
  return{terms,results:candidates.map(x=>x.item),count:candidates.length};
 }
 function answer(text){
  const q=String(text||'').trim().toLowerCase().replace(/\s+/g,' '),data=scope();
  if(!data)return{msg:'Ask Solar91 is available to approved Solar91 operations roles, including site engineers.',action:null};
  const {issues,tasks}= {issues:(S.issues||[]).filter(x=>data.records.some(r=>r.module==='issues'&&r.row===x)),tasks:(S.tasks||[]).filter(x=>data.records.some(r=>r.module==='tasks'&&r.row===x))};
  const oi=issues.filter(t=>!['Closed','Resolved'].includes(t.status)),openPm=tasks.filter(t=>!['Completed','Cancelled'].includes(t.status)),lateIssues=oi.filter(t=>typeof isOverdueIssue==='function'&&isOverdueIssue(t)),pmLate=openPm.filter(t=>typeof taskOD==='function'&&taskOD(t)>0);
  const washPending=((S._washCycles||{}).reports||[]).filter(r=>r.review_status==='Pending'&&(!siteName()||data.records.some(x=>x.module==='washing'&&x.row===r))).length,washLate=((S._washCycles||{}).plants||[]).filter(p=>Number(p.overdue_days||0)>0&&(!siteName()||data.records.some(x=>x.module==='washing'&&x.row===p))).length;
  const displayPlant=siteName()?' for your assigned plant':' across records visible to your role';
  const matchedPlant=data.plants.some(p=>cleanQuery([p.name,p.id].join(' ')).some(t=>cleanQuery(q).includes(t)));
  const structured=/how many|count|total|number of|^open (issues|tickets)|^critical tickets|^pm overdue|^washing pending|^how many plants/.test(q);
  let msg='',action=null;
  if(/help|what can|example|question/.test(q)){msg='Ask for a count or search any plant, site code, equipment ID/name, ticket, PM job, date, assignee, status, or operational record visible to your role. Try “overdue PM at Bhadla”, “INV-01”, or “parts for inverter”.'}
  else if(structured&&!matchedPlant&&!/\b[A-Z]{2,}[-_]?\d+\b/i.test(text)){
   if(/wash|clean|confirm|review/.test(q)){msg=washPending+' washing report(s) awaiting review and '+washLate+' washing plant(s) overdue'+displayPlant+'.';action=['washing','review']}
   else if(/preventive|\bpm\b|maintenance|work order|task/.test(q)){msg=openPm.length+' active preventive work orders, including '+pmLate.length+' overdue'+displayPlant+'.';action=['pm','overdue']}
   else if(/issue|ticket|fault|breakdown|critical|unassigned|resolved/.test(q)){msg=oi.length+' open tickets, including '+oi.filter(t=>t.severity==='Critical').length+' critical and '+lateIssues.length+' overdue'+displayPlant+'.';action=['issues','open']}
   else if(/plant|site|portfolio/.test(q)){msg=data.plants.length+' plants are visible to your role'+(siteName()?' (your assigned plant).':'.')}
   else msg='I can search the records visible to your role. Include a plant, equipment name/ID, ticket, PM job, or another detail to narrow the results.';
   const found=searchRecords(q,data);
   if(found.count)msg=searchPage(q,data,found,0,msg);
  }else{
   const found=searchRecords(q,data),shown=found.results.slice(0,20);
   if(found.count){msg=searchPage(q,data,found,0,'Found '+found.count+' matching record'+(found.count===1?'':'s')+' in modules visible to your role'+(shown.length<found.count?' (showing the best '+shown.length+'; use Show more for the rest)':'')+':')}
   else msg='No matching records found in the data currently loaded for your role. Try a shorter term, plant/site code, equipment ID, ticket number, or ask for help.';
  }
  return{msg,action};
 }
 function assistantRoot(){let root=document.getElementById('s91-assistant-root');if(!root){root=document.createElement('div');root.id='s91-assistant-root';document.body.append(root)}return root}
 function drawAssistant(){syncAssistantUser();const root=assistantRoot();root.hidden=!document.querySelector('#app .shell');
  const visible=hasAppState()&&allowedAssistantRoles.includes(role());
  root.innerHTML=visible?'<button class="s91-assistant-launch" data-s91-assist="toggle" aria-label="'+(assistant.open?'Close':'Open')+' operations answers" title="Drag to move · click to open"><span aria-hidden="true">⌕</span> Ask Solar91</button>'+(assistant.open?'<section class="s91-assistant-panel" role="region" aria-label="Solar91 operations answers"><header><div><span class="s91-eyebrow">LIVE SEARCH · OPTIONAL AI REASONING</span><h2>Ask Solar91</h2><small>Grounded in records your role can access · clickable sources</small></div><button type="button" data-s91-assist="close" aria-label="Close assistant">×</button></header><div class="s91-assistant-conversation" aria-live="polite"><div class="s91-assistant-msg bot">Ask about site problems, maintenance, panel washing, equipment IDs or due dates. I can show matching saved records and take you to the right register.</div>'+assistant.log.map(x=>'<div class="s91-assistant-msg '+x.who+'">'+esc91(x.text).replace(/\n/g,'<br>') +(x.action?'<button type="button" data-s91-assist-go="'+x.action.join(':')+'">Open filtered register ↗</button>':'')+(x.records?.length?'<div class="s91-assistant-sources"><b>Verified saved records</b>'+x.records.slice(0,8).map(r=>'<button type="button" data-s91-record-kind="'+esc91(r.module)+'" data-s91-record-id="'+esc91(r.id)+'" data-s91-record-plant="'+esc91(r.plant||'')+'"><span>'+esc91((r.module||'').toUpperCase())+' · '+esc91(r.id)+'</span><strong>'+esc91(r.title||r.equipment||'View record')+'</strong><small>'+esc91(r.plant)+(r.due?' · Due '+esc91(r.due):'')+'</small></button>').join('')+'</div>':'')+'</div>').join('')+(assistant.more?'<button type="button" data-s91-assist-more>Show more matching records ('+(assistant.more.total-assistant.more.offset)+' remaining)</button>':'')+'</div><div class="s91-assistant-suggestions">'+(role()==='Site Engineer'?['My plant','Open issues','PM overdue','Washing pending','Inverter issues','What is due today?']:['Open issues','Critical tickets','PM overdue','Washing pending','What is due today?','Find INV-01']).map(q=>'<button type="button" data-s91-question="'+q+'">'+q+'</button>').join('')+'</div><form id="s91-assistant-form"><input id="s91-assistant-query" maxlength="300" aria-label="Ask an operations question" placeholder="Ask about any plant, issue, equipment, or module…" autocomplete="off"><button type="submit">Search</button></form><p class="s91-assistant-disclaimer">Read-only answers. AI narration requires separate administrator opt-in; changes are always made in the actual module.</p></section>':''):'';
  applyAssistantPosition(root);
  const panel=root.querySelector('.s91-assistant-panel');
  if(panel){
   const bounds=root.getBoundingClientRect(),panelWidth=panel.offsetWidth,panelHeight=panel.offsetHeight;
   panel.classList.toggle('s91-assistant-panel-left',bounds.left+panelWidth>window.innerWidth-8);
   const aboveSpace=bounds.top-18,belowSpace=window.innerHeight-bounds.bottom-18;
   const below=aboveSpace<panelHeight&&belowSpace>aboveSpace;
   panel.classList.toggle('s91-assistant-panel-below',below);
   panel.style.maxHeight=Math.max(180,Math.min(panelHeight,below?belowSpace:aboveSpace))+'px';
  }
  const launch=root.querySelector('.s91-assistant-launch');
  if(launch)launch.addEventListener('pointerdown',startAssistantDrag);
  if(assistant.open){const c=root.querySelector('.s91-assistant-conversation');if(c)c.scrollTop=c.scrollHeight}
 }
 function startAssistantDrag(event){
  if(event.button!==0&&event.pointerType==='mouse')return;
  const root=assistantRoot(),launch=event.currentTarget,userId=assistantUserId(),origin={x:event.clientX,y:event.clientY},start=root.getBoundingClientRect();
  try{launch.setPointerCapture(event.pointerId)}catch{}
  let moved=false;
  const move=moveEvent=>{
   if(moveEvent.pointerId!==event.pointerId)return;
   const dx=moveEvent.clientX-origin.x,dy=moveEvent.clientY-origin.y;
   if(!moved&&Math.hypot(dx,dy)<5)return;
   moved=true;moveEvent.preventDefault();
   const position=clampAssistantPosition(start.left+dx,start.top+dy,root);
   root.style.left=position.left+'px';root.style.top=position.top+'px';root.style.right='auto';root.style.bottom='auto';
  };
  const finish=finishEvent=>{
   if(finishEvent.pointerId!==event.pointerId)return;
   launch.removeEventListener('pointermove',move);launch.removeEventListener('pointerup',finish);launch.removeEventListener('pointercancel',finish);
   if(moved){
    if(userId&&assistantUserId()===userId){const rect=root.getBoundingClientRect();assistant.position={left:rect.left,top:rect.top};saveAssistantPosition(assistant.position)}
    assistant.dragged=true;setTimeout(()=>assistant.dragged=false,0);
   }
  };
  launch.addEventListener('pointermove',move);launch.addEventListener('pointerup',finish);launch.addEventListener('pointercancel',finish);
 }
 window.s91AssistantOpen=function(){assistant.open=true;drawAssistant();document.getElementById('s91-assistant-query')?.focus({preventScroll:true})};
 async function ask(value){
  const str=String(value||'').trim();if(!str||assistant.busy)return;
  if(!allowedAssistantRoles.includes(role())){assistant.open=false;drawAssistant();return}
  const requestUserId=assistantUserId();if(!requestUserId)return;
  const expanded=/^(and |what about |those |same |only |filter |which of them)/i.test(str)&&assistant.lastQuery?assistant.lastQuery+' '+str:str;
  const recent=assistant.log.filter(x=>x.who==='user').slice(-4).map(x=>x.text);
  assistant.more=null;assistant.busy=true;assistant.log.push({who:'user',text:str,when:Date.now()});
  assistant.log.push({who:'bot',text:'Checking permitted live records…',when:Date.now()});
  assistant.log=assistant.log.slice(-assistantHistoryLimit);saveAssistantHistory(assistant.log);drawAssistant();
  const position=assistant.log.length-1;
  try{
   const result=await apiFetch('/api/field/ask',{method:'POST',body:JSON.stringify({question:expanded,recent_questions:recent})});
   if(!allowedAssistantRoles.includes(role())||assistantUserId()!==requestUserId||assistant.userId!==requestUserId)return;
   assistant.lastQuery=expanded;
   assistant.log[position]={who:'bot',text:result.answer||'No matching saved record was found.',records:result.records||[],
     action:/\b(issue|ticket|fault)\b/i.test(expanded)?['issues','open']:/\b(pm|maintenance)\b/i.test(expanded)?['pm','overdue']:/\b(wash|clean)\b/i.test(expanded)?['washing','late']:null,when:Date.now()};
   saveAssistantHistory(assistant.log);
  }catch(error){
   if(assistantUserId()!==requestUserId||assistant.userId!==requestUserId)return;
   // Existing in-browser read-only search is a fallback, NEVER displayed as a live server result.
   const found=answer(expanded);
   assistant.log[position]={who:'bot',text:'Live search unavailable ('+(error.message||'network error')+'). Showing cached records only.\n'+found.msg,action:found.action,when:Date.now()};
   saveAssistantHistory(assistant.log);
  }finally{
   if(assistantUserId()===requestUserId&&assistant.userId===requestUserId){
    assistant.busy=false;drawAssistant();document.getElementById('s91-assistant-query')?.focus({preventScroll:true});
   }
  }
 }
 function openAssistantRecord(kind,id,plant){
  assistant.open=false;drawAssistant();
  if(kind==='issues'){if(typeof window.s91JumpToTicket==='function')window.s91JumpToTicket(id);else if(typeof goTab==='function')goTab('issues');return}
  if(kind==='pm'){if(typeof S!=='undefined'){S.pmLive=S.pmLive||{};S.pmLive.query=id;S.pmLive.status='all';if(S.schedF)S.schedF.q=id}if(typeof goScheduledOM==='function')goScheduledOM('maintenance');return}
  if(kind==='washing'){if(typeof S!=='undefined'){S._washUi=S._washUi||{};S._washUi.q=plant||''}if(typeof washOpenRegister==='function')washOpenRegister();else if(typeof goScheduledOM==='function')goScheduledOM('washing');return}
  if(kind==='plants'||kind==='equipment'){if(role()==='Site Engineer'){if(typeof window.s91RadarFocus==='function')window.s91RadarFocus('all','all');return}if(typeof S!=='undefined'){S.plF=S.plF||{};S.plF.q=plant||id;}if(typeof goView==='function')goView('plants');return}
 }

 document.addEventListener('click',e=>{
  if(assistant.dragged){assistant.dragged=false;e.preventDefault();return}
  const item=e.target.closest('[data-s91-assist]');if(item){assistant.open=item.dataset.s91Assist==='toggle'?!assistant.open:item.dataset.s91Assist!=='close';drawAssistant();return}
  const question=e.target.closest('[data-s91-question]');if(question){assistant.open=true;ask(question.dataset.s91Question);return}
  if(e.target.closest('[data-s91-assist-more]')){const more=assistant.more,data=scope();if(!more||!data)return;const found=searchRecords(more.query,data),start=more.offset;assistant.log.push({who:'bot',text:searchPage(more.query,data,found,start,'Records '+(start+1)+'–'+Math.min(start+20,found.count)+' of '+found.count+':'),when:Date.now()});assistant.log=assistant.log.slice(-assistantHistoryLimit);saveAssistantHistory(assistant.log);drawAssistant();return}
  const record=e.target.closest('[data-s91-record-kind]');if(record){openAssistantRecord(record.dataset.s91RecordKind,record.dataset.s91RecordId,record.dataset.s91RecordPlant);return}
  const go=e.target.closest('[data-s91-assist-go]');if(go){const [kind,queue]=go.dataset.s91AssistGo.split(':');assistant.open=false;drawAssistant();window.s91OpenQueue(kind,queue);return}
 });
 document.addEventListener('submit',e=>{if(e.target.id!=='s91-assistant-form')return;e.preventDefault();ask(document.getElementById('s91-assistant-query')?.value)});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.getElementById('s91-report-root'))document.getElementById('s91-report-root').remove();else if(e.key==='Escape'&&assistant.open){assistant.open=false;drawAssistant()}});
 document.addEventListener('keydown',e=>{
  if(!e.altKey||!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)||!e.target.closest('.s91-assistant-launch'))return;
  e.preventDefault();const root=assistantRoot(),rect=root.getBoundingClientRect(),step=e.shiftKey?40:12;
  const delta={ArrowUp:[0,-step],ArrowDown:[0,step],ArrowLeft:[-step,0],ArrowRight:[step,0]}[e.key];
  assistant.position=clampAssistantPosition(rect.left+delta[0],rect.top+delta[1],root);
  root.style.left=assistant.position.left+'px';root.style.top=assistant.position.top+'px';root.style.right='auto';root.style.bottom='auto';
  saveAssistantPosition(assistant.position);
 });
 // Preserve existing success/error semantics; merely make the application's toast UI more legible.
 function styleToasts(){document.querySelectorAll('body>.toast').forEach(n=>{if(n.dataset.s91Decorated)return;n.dataset.s91Decorated='1';const t=(n.textContent||'').toLowerCase();n.classList.add(/fail|error|denied|unable|could not|required|invalid/.test(t)?'s91-toast-error':/saved|sent|completed|confirmed|downloaded|uploaded|created|success/.test(t)?'s91-toast-success':'s91-toast-info')})}
 new MutationObserver(styleToasts).observe(document.body,{childList:true});
 window.addEventListener('resize',()=>{if(assistant.position)drawAssistant()});
 const app=document.getElementById('app');
 if(app)new MutationObserver(()=>{
  const signedIn=!!app.querySelector('.shell'),root=assistantRoot();
 if(!signedIn&&(assistant.open||assistant.log.length||assistant.historyLoaded)){assistant.open=false;assistant.log=[];assistant.position=null;assistant.more=null;assistant.busy=false;assistant.historyLoaded=false;drawAssistant()}
  else if(root.hidden===signedIn){root.hidden=!signedIn;if(signedIn)drawAssistant()}
 }).observe(app,{childList:true,subtree:false});
 drawAssistant();
})();
