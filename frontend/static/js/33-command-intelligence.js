"use strict";
/* Solar91 operational experience: read-only answers, genuine filtered drill-downs,
   and report previews. All operational changes continue through existing authenticated APIs. */
(function(){
 const esc91 = v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const hasAppState=()=>typeof S!=='undefined';
 const role=()=>hasAppState()?(S._roleLabel||S.currentRole||''):'', siteName=()=>role()==='Site Engineer'?S._sePlant||null:null;
 const reportRole=()=>role()!=='Site Engineer';
 const assistantHistoryPrefix='s91-assistant-history-v1:';
 const assistantPositionPrefix='s91-assistant-position-v1:';
 const assistantHistoryLimit=200;
 const assistantRetentionMs=10*24*60*60*1000;
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
 function positionAssistantPanel(root){
  const panel=root.querySelector('.s91-assistant-panel');if(!panel)return;
  panel.style.maxHeight='';
  const bounds=root.getBoundingClientRect(),panelWidth=panel.offsetWidth,panelHeight=panel.offsetHeight,gap=18,margin=8;
  panel.classList.toggle('s91-assistant-panel-left',bounds.right-panelWidth<margin);
  const aboveSpace=bounds.top-gap,belowSpace=window.innerHeight-bounds.bottom-gap;
  const below=aboveSpace<panelHeight&&belowSpace>aboveSpace;
  const available=Math.max(0,below?belowSpace:aboveSpace);
  panel.classList.toggle('s91-assistant-panel-below',below);
  panel.style.maxHeight=Math.min(panelHeight,available)+'px';
 }
 function syncAssistantUser(){
  const userId=assistantUserId();
  if(userId!==assistant.userId){
   assistant.userId=userId;assistant.log=[];assistant.position=null;
   assistant.lastQuery='';assistant.busy=false;assistant.historyLoaded=false;
  }
  if(!userId||!document.querySelector('#app .shell')){
   assistant.log=[];assistant.position=null;assistant.historyLoaded=false;return;
  }
  if(!assistant.historyLoaded){
   try{localStorage.removeItem('s91-assistant-history-v1')}catch{}
   assistant.log=loadAssistantHistory();assistant.position=loadAssistantPosition();assistant.historyLoaded=true;
  }
 }
 // Chat history is browser-local. Prune before loading and every time it is saved
 // so expired text never enters the visible log or a later assistant request.
 function loadAssistantHistory(){
  try{
   const key=assistantScopedKey(assistantHistoryPrefix);if(!key)return[];
   const raw=localStorage.getItem(key);if(!raw)return[];
   const parsed=JSON.parse(raw);if(!Array.isArray(parsed))return[];
   return pruneAssistantHistory(parsed);
  }catch{return[]}
 }
 function pruneAssistantHistory(log,now=Date.now()){
  const cutoff=now-assistantRetentionMs;
  return (Array.isArray(log)?log:[]).map(entry=>({who:entry?.who==='user'?'user':'bot',text:String(entry?.text||'').trim(),action:Array.isArray(entry?.action)?entry.action.slice(0,2).map(String):null,
   records:Array.isArray(entry?.records)?entry.records.slice(0,8).map(r=>({module:String(r?.module||''),id:String(r?.id||''),title:String(r?.title||'').slice(0,180),plant:String(r?.plant||'').slice(0,160),site_code:String(r?.site_code||'').slice(0,80),status:String(r?.status||'').slice(0,80),assignee:String(r?.assignee||'').slice(0,120),reporter:String(r?.reporter||'').slice(0,120),due:String(r?.due||'').slice(0,30)})):[],
   summary:entry?.summary&&typeof entry.summary==='object'?{label:String(entry.summary.label||'Result').slice(0,100),value:entry.summary.value}:null,
   breakdown:Array.isArray(entry?.breakdown)?entry.breakdown.slice(0,8).map(b=>({label:String(b?.label||'').slice(0,100),value:b?.value})):[],
   source:String(entry?.source||'').slice(0,300),narration:String(entry?.narration||'').slice(0,1200),limited:!!entry?.limited,when:Number(entry?.when)}))
   .filter(entry=>entry.text&&!(entry.who==='bot'&&/^Live search unavailable/i.test(entry.text))&&Number.isFinite(entry.when)&&entry.when>=cutoff&&entry.when<=now+5*60*1000)
   .slice(-assistantHistoryLimit);
 }
 function pruneStoredAssistantHistories(now=Date.now()){
  try{
   const keys=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key&&key.startsWith(assistantHistoryPrefix))keys.push(key)}
   keys.forEach(key=>{try{const raw=JSON.parse(localStorage.getItem(key)||'[]');const rows=pruneAssistantHistory(raw,now);if(rows.length)localStorage.setItem(key,JSON.stringify(rows));else localStorage.removeItem(key)}catch{localStorage.removeItem(key)}});
  }catch{}
 }
 function saveAssistantHistory(log){
  try{
   const key=assistantScopedKey(assistantHistoryPrefix);if(!key)return;
   if(!Array.isArray(log)||!log.length){localStorage.removeItem(key);return}
   const next=pruneAssistantHistory(log);
   if(!next.length){localStorage.removeItem(key);return}
   localStorage.setItem(key, JSON.stringify(next));
  }catch{}
 }
 pruneStoredAssistantHistories();
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
 const assistant={open:false,log:[],lastQuery:'',busy:false,userId:'',position:null,dragged:false,historyLoaded:false};
 const allowedAssistantRoles=['O&M Head','Assignee','Administration','Site Engineer'];
 function assistantRoot(){let root=document.getElementById('s91-assistant-root');if(!root){root=document.createElement('div');root.id='s91-assistant-root';document.body.append(root)}return root}
 function drawAssistant(){syncAssistantUser();const root=assistantRoot();root.hidden=!document.querySelector('#app .shell');
  const visible=hasAppState()&&allowedAssistantRoles.includes(role());
  const suggestions=role()==='Site Engineer'?['My pending work','Overdue issues','Washing pending review','Tables cleaned today']:
   role()==='Assignee'?['My assigned work','Overdue PM tasks','Open issues','Washing pending review']:
   role()==='O&M Head'?['How many open issues?','Overdue issues','Overdue PM tasks','Washing pending review']:
   ['How many open issues?','Overdue issues','Overdue PM tasks','Which issues are open?'];
  root.innerHTML=visible?'<button class="s91-assistant-launch" data-s91-assist="toggle" aria-label="'+(assistant.open?'Close':'Open')+' operations answers" title="Drag to move · click to open"><span aria-hidden="true">⌕</span> Ask Solar91</button>'+(assistant.open?'<section class="s91-assistant-panel" role="region" aria-label="Solar91 operations answers"><header><div><span class="s91-eyebrow">LIVE SEARCH · OPTIONAL AI REASONING</span><h2>Ask Solar91</h2><small>Grounded in records your role can access · clickable sources</small></div><button type="button" data-s91-assist="close" aria-label="Close assistant">×</button></header><div class="s91-assistant-conversation" aria-live="polite"><div class="s91-assistant-msg bot">Ask about site problems, maintenance, panel washing, equipment IDs or due dates. I can show matching saved records and take you to the right register.</div>'+assistant.log.map(x=>'<div class="s91-assistant-msg '+x.who+'">'+esc91(x.text).replace(/\n/g,'<br>')+(x.summary&&x.summary.value!=null?'<div class="s91-assistant-summary"><b>'+esc91(x.summary.label||'Result')+'</b><strong>'+esc91(x.summary.value)+'</strong></div>':'')+(x.breakdown?.length?'<ul class="s91-assistant-breakdown">'+x.breakdown.map(b=>'<li><span>'+esc91(b.label)+'</span><b>'+esc91(b.value)+'</b></li>').join('')+'</ul>':'')+(x.narration?'<small class="s91-assistant-source"><b>AI context:</b> '+esc91(x.narration)+'</small>':'')+(x.source?'<small class="s91-assistant-source">Source: '+esc91(x.source)+(x.limited?' · first matching records shown':'')+'</small>':'')+(x.action?'<button type="button" data-s91-assist-go="'+x.action.join(':')+'">Open filtered register ↗</button>':'')+(x.records?.length?'<div class="s91-assistant-sources"><b>Supporting records</b>'+x.records.slice(0,8).map(r=>'<button type="button" data-s91-record-kind="'+esc91(r.module)+'" data-s91-record-id="'+esc91(r.id)+'" data-s91-record-plant="'+esc91(r.plant||'')+'"><span>'+esc91((r.module||'').toUpperCase())+' · '+esc91(r.id)+'</span><strong>'+esc91(r.title||r.equipment||'View record')+'</strong><small>'+esc91(r.plant)+(r.site_code?' · '+esc91(r.site_code):'')+(r.status?' · '+esc91(r.status):'')+(r.assignee?' · '+esc91(r.assignee):'')+(r.reporter?' · Reported by '+esc91(r.reporter):'')+(r.due?' · '+esc91(r.due):'')+'</small></button>').join('')+'</div>':'')+'</div>').join('')+'</div><div class="s91-assistant-suggestions">'+suggestions.map(q=>'<button type="button" data-s91-question="'+q+'">'+q+'</button>').join('')+'</div><form id="s91-assistant-form"><input id="s91-assistant-query" maxlength="300" aria-label="Ask an operations question" placeholder="Ask about any plant, issue, equipment, or module…" autocomplete="off"><button type="submit">Search</button></form><p class="s91-assistant-disclaimer">Read-only answers. Data questions use authorized live records; changes are always made in the actual module.</p></section>':''):'';
  applyAssistantPosition(root);
  positionAssistantPanel(root);
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
   positionAssistantPanel(root);
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
  assistant.busy=true;assistant.log.push({who:'user',text:str,when:Date.now()});
  assistant.log.push({who:'bot',text:'Checking permitted live records…',when:Date.now()});
  assistant.log=assistant.log.slice(-assistantHistoryLimit);saveAssistantHistory(assistant.log);drawAssistant();
  const position=assistant.log.length-1;
  try{
   const result=await apiFetch('/api/field/ask',{method:'POST',body:JSON.stringify({question:expanded})});
   if(!allowedAssistantRoles.includes(role())||assistantUserId()!==requestUserId||assistant.userId!==requestUserId)return;
   assistant.lastQuery=expanded;
   const recordAction=/\b(issue|ticket|fault)\b/i.test(expanded)?['issues',/overdue|late/i.test(expanded)?'overdue':'open']:
    /\b(pm|maintenance|task)\b/i.test(expanded)?['pm',/overdue|late/i.test(expanded)?'overdue':'due']:
    /\b(wash|clean|table)\b/i.test(expanded)?['washing',/pending|review|confirm/i.test(expanded)?'review':'late']:null;
   assistant.log[position]={who:'bot',text:result.answer||'No matching saved record was found.',records:result.records||[],
     summary:result.summary||null,breakdown:result.breakdown||[],source:result.source||'',narration:result.narration||'',limited:!!result.limited||(result.records||[]).length>8,
     action:recordAction,when:Date.now()};
   saveAssistantHistory(assistant.log);
  }catch(error){
   if(assistantUserId()!==requestUserId||assistant.userId!==requestUserId)return;
   assistant.log[position]={who:'bot',text:'Live operational data could not be retrieved ('+(error.message||'connection error')+'). No current result is available. Please retry when the connection is restored.',when:Date.now()};
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
 if(!signedIn&&(assistant.open||assistant.log.length||assistant.historyLoaded)){assistant.open=false;assistant.log=[];assistant.position=null;assistant.busy=false;assistant.historyLoaded=false;drawAssistant()}
  else if(root.hidden===signedIn){root.hidden=!signedIn;if(signedIn)drawAssistant()}
 }).observe(app,{childList:true,subtree:false});
 drawAssistant();
})();
