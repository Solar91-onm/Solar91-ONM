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
  if(panel.classList.contains('s91-copilot'))return;
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
   q:String(entry?.q||'').slice(0,300),error:!!entry?.error,
   records:Array.isArray(entry?.records)?entry.records.slice(0,20).map(r=>({module:String(r?.module||''),id:String(r?.id||''),ticket:String(r?.ticket||'').slice(0,80),title:String(r?.title||'').slice(0,180),plant:String(r?.plant||'').slice(0,160),site_code:String(r?.site_code||'').slice(0,80),status:String(r?.status||'').slice(0,80),assignee:String(r?.assignee||'').slice(0,120),reporter:String(r?.reporter||'').slice(0,120),due:String(r?.due||'').slice(0,30)})):[],
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
   Object.assign(f,{plant:plant==='all'?'all':plant,status:queue==='overdue'?'Overdue':queue==='due'?'Due soon':queue==='done'?'Done':'all',age:'all',week:'all',equipment:'all',query:'',page:1,view:'register'});
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
 const assistant={open:false,log:[],lastQuery:'',busy:false,userId:'',position:null,dragged:false,historyLoaded:false,focus:'all',wide:false,expandedRecs:{}};
 const allowedAssistantRoles=['O&M Head','Assignee','Administration'];  /* Site Engineers do not get the chatbot */

 /* ---------- Ask Solar91 copilot: layered, interactive answers over the same grounded /api/field/ask contract ---------- */
 const isUuid=v=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v||''));
 const MOD={issues:['Site issue','#DC4C3E','⚠'],pm:['Preventive maintenance','#16A34A','🛠'],washing:['Washing','#0891B2','💧'],plants:['Plant','#D97706','☀'],equipment:['Equipment','#7C3AED','⚙']};
 const statusTone=st=>{const s=String(st||'').toLowerCase();return /overdue|breach|critical|rejected|no report/.test(s)?'bad':/open|pending|await|exception|warn/.test(s)?'warn':/progress|assigned|acknowledged|scheduled|due/.test(s)?'info':/resolved|closed|completed|confirmed|done|on track/.test(s)?'ok':'mute'};
 const focusPlant=()=>assistant.focus&&assistant.focus!=='all'?assistant.focus:'';
 const atPlant=q=>focusPlant()?q+' at '+focusPlant():q;
 function promptGroups(){
  const r=role(),wash=r!=='Administration';
  const groups=[];
  if(r==='Site Engineer')groups.push(['My work','#0F5C2E',['My pending work']]);
  else if(r==='Assignee')groups.push(['My work','#0F5C2E',['My assigned work']]);
  groups.push(['Site issues','#DC4C3E',[atPlant('How many open issues?'),atPlant('Overdue issues'),'Open issues by status this week','Open issues by status last week']]);
  groups.push(['Preventive maintenance','#16A34A',[atPlant('Overdue PM tasks'),atPlant('Open PM tasks')]]);
  if(wash)groups.push(['Washing','#0891B2',['Washing pending review','Tables cleaned today','Tables cleaned yesterday']]);
  groups.push(['Quick searches','#7C3AED',[atPlant('Critical open issues'),atPlant('Unassigned issues'),atPlant('Inverter faults'),atPlant('Issues pending parts'),atPlant('Overdue maintenance')]]);
  return groups;
 }
 function snapshot(){
  if(!hasAppState())return[];
  const fp=focusPlant(),inScope=x=>!fp||x.plant===fp;
  const issues=(S.issues||[]).filter(inScope),open=issues.filter(t=>t.status!=='Resolved'&&t.status!=='Closed');
  const overdue=typeof isOverdueIssue==='function'?open.filter(isOverdueIssue).length:0;
  const pmLate=(S.tasks||[]).filter(t=>inScope(t)&&t.status!=='Completed'&&t.status!=='Cancelled'&&typeof taskOD==='function'&&taskOD(t)>0).length;
  const wc=S._washCycles,review=wc&&wc.portfolio&&!fp?wc.portfolio.pending_reviews:null;
  const tiles=[[open.length,'Open issues',atPlant('How many open issues?'),'#3B82F6'],[overdue,'Issues past ETC',atPlant('Overdue issues'),'#DC4C3E'],[pmLate,'PM overdue',atPlant('Overdue PM tasks'),'#F97316']];
  if(role()!=='Administration')tiles.push([review==null?'—':review,'Washing to review','Washing pending review','#0891B2']);
  return tiles;
 }
 function followups(entry){
  const q=String(entry.q||'').toLowerCase(),plants=[...new Set((entry.records||[]).map(r=>r.plant).filter(Boolean))].slice(0,2);
  const out=[],isIssue=/issue|ticket|fault/.test(q),isPm=/\bpm\b|maintenance|task/.test(q),isWash=/wash|clean|table/.test(q);
  if(isIssue){
   if(!/overdue/.test(q))out.push('Overdue issues');
   if(!/status/.test(q))out.push('Open issues by status this week');
   plants.forEach(pl=>{if(!q.includes(pl.toLowerCase()))out.push((/overdue/.test(q)?'Overdue issues at ':'Open issues at ')+pl)});
   out.push('Overdue PM tasks'+(plants[0]?' at '+plants[0]:''));
  }else if(isPm){
   if(!/overdue/.test(q))out.push('Overdue PM tasks');
   plants.forEach(pl=>{if(!q.includes(pl.toLowerCase()))out.push('Overdue PM tasks at '+pl)});
   out.push('Overdue issues'+(plants[0]?' at '+plants[0]:''));
  }else if(isWash&&role()!=='Administration'){
   ['Washing pending review','Tables cleaned today','Tables cleaned yesterday'].forEach(x=>out.push(x));
  }else out.push('How many open issues?','Overdue PM tasks',role()==='Site Engineer'?'My pending work':'Overdue issues');
  return [...new Set(out)].filter(x=>x.toLowerCase()!==q).slice(0,4);
 }
 function recordCard(r){
  const m=MOD[r.module]||['Record','#64748B','•'],ref=r.ticket||(!isUuid(r.id)?r.id:'');
  const meta=[r.plant?esc91(r.plant)+(r.site_code?' · '+esc91(r.site_code):''):'',r.assignee?'👤 '+esc91(r.assignee):'',r.reporter?'Reported by '+esc91(r.reporter):'',r.due?'📅 '+esc91(r.due):''].filter(Boolean).join('<i>·</i>');
  return '<button type="button" class="cp-rec" style="--m:'+m[1]+'" data-cp-text="'+esc91([ref,r.title,r.plant,r.site_code,r.status,r.severity,r.assignee,r.equipment].filter(Boolean).join(' ').toLowerCase())+'" data-s91-record-kind="'+esc91(r.module)+'" data-s91-record-id="'+esc91(r.id)+'" data-s91-record-ticket="'+esc91(r.ticket||'')+'" data-s91-record-plant="'+esc91(r.plant||'')+'"><span class="cp-rec-ico" aria-hidden="true">'+m[2]+'</span><span class="cp-rec-main"><span class="cp-rec-top"><em>'+m[0]+'</em>'+(ref?'<b>'+esc91(ref)+'</b>':'')+(r.status?'<span class="cp-st '+statusTone(r.status)+'">'+esc91(r.status)+'</span>':'')+(r.severity?'<span class="cp-sev '+esc91(String(r.severity).toLowerCase())+'">'+esc91(r.severity)+'</span>':'')+(r.overdue?'<span class="cp-st bad">Overdue</span>':'')+'</span><strong>'+esc91(r.title||r.equipment||'View record')+'</strong>'+(meta?'<small>'+meta+'</small>':'')+'</span><span class="cp-rec-go" aria-hidden="true">›</span></button>';
 }
 /* ---- search refinement: applied filters, one-tap facets with counts, sort and an in-result filter ---- */
 const FKIND={modules:['module',{issues:'Issues',pm:'Maintenance',washing:'Washing',plants:'Plants',equipment:'Equipment'}],severities:['severity',null],statuses:['status',{active:'Open',overdue:'Overdue',unassigned:'Unassigned',assigned:'Assigned',acknowledged:'Acknowledged','in progress':'In progress','pending vendor':'Pending parts',resolved:'Resolved',closed:'Closed',completed:'Completed',scheduled:'Scheduled'}]};
 const flabel=(kind,v)=>{const map=(FKIND[kind]||[])[1];return map&&map[v]||v};
 function describeFilters(f){
  const parts=[];
  if((f.statuses||[]).length)parts.push(f.statuses.map(v=>flabel('statuses',v).toLowerCase()).join(' & '));
  if((f.severities||[]).length)parts.push(f.severities.join('/').toLowerCase());
  parts.push((f.modules||[]).map(v=>flabel('modules',v).toLowerCase()).join(' and ')||'records');
  let t=parts.join(' ');if((f.terms||[]).length)t+=' matching “'+f.terms.join(' ')+'”';if(f.plant)t+=' at '+f.plant.name;return t;
 }
 function refineHtml(x,i){
  const f=x.filters;if(!f)return '';
  const chip=(kind,v,label)=>'<button type="button" class="cp-fchip on" data-cp-drop="'+i+'|'+kind+'|'+esc91(v)+'" title="Remove this filter">'+esc91(label)+' <b aria-hidden="true">×</b></button>';
  const applied=[].concat((f.modules||[]).map(v=>chip('modules',v,flabel('modules',v))),(f.statuses||[]).map(v=>chip('statuses',v,flabel('statuses',v))),(f.severities||[]).map(v=>chip('severities',v,v)),f.plant?[chip('plant',f.plant.site_code,f.plant.name)]:[],(f.terms||[]).map(v=>chip('terms',v,'“'+v+'”')));
  const fc=x.facets||{},add=(kind,group,label,v,n)=>'<button type="button" class="cp-fchip" data-cp-add="'+i+'|'+kind+'|'+esc91(v)+'">'+esc91(label)+' <span>'+n+'</span></button>';
  const offers=[];
  if(!(f.modules||[]).length)Object.entries(fc.module||{}).forEach(([v,n])=>offers.push(add('modules','module',flabel('modules',v),v,n)));
  Object.entries(fc.status||{}).filter(([v])=>!(f.statuses||[]).includes(v)).forEach(([v,n])=>offers.push(add('statuses','status',flabel('statuses',v),v,n)));
  if(!(f.severities||[]).length)Object.entries(fc.severity||{}).forEach(([v,n])=>offers.push(add('severities','severity',v,v,n)));
  if(!f.plant)Object.entries(fc.plant||{}).slice(0,5).forEach(([v,n])=>offers.push(add('plant','plant',v,v,n)));
  const sort=x.sort||'relevance',sorts=[['relevance','Best match'],['priority','Priority'],['due','Due date'],['recent','Recent']];
  return '<div class="cp-refine">'+
   (applied.length?'<div class="cp-fchips">'+applied.join('')+'</div>':'')+
   (offers.length&&(x.records||[]).length>1?'<div class="cp-fchips cp-offer">'+offers.slice(0,12).join('')+'</div>':'')+
   ((x.records||[]).length>1?'<div class="cp-refine-row"><label class="cp-within"><span aria-hidden="true">⌕</span><input data-cp-within="'+i+'" placeholder="Filter these results…" aria-label="Filter these results"></label><div class="cp-sort" role="group" aria-label="Sort results">'+sorts.map(([k,l])=>'<button type="button" class="'+(k===sort?'on':'')+'" aria-pressed="'+(k===sort)+'" data-cp-sort="'+i+'|'+k+'">'+l+'</button>').join('')+'</div></div>':'')+'</div>';
 }
 /* Answers open with the headline, one sentence and the top records; breakdown, refining and follow-up questions are
    folded until asked for. Which folds are open is remembered, so refining a result keeps its section open. */
 function fold(i,key,label,count,body){
  const id=i+':'+key,open=!!(assistant.folds&&assistant.folds[id]);
  return '<details class="cp-fold" data-cp-fold="'+id+'"'+(open?' open':'')+'><summary><span>'+esc91(label)+'</span>'+(count!==''&&count!=null?'<b>'+esc91(count)+'</b>':'')+'<i aria-hidden="true">›</i></summary><div class="cp-fold-body">'+body+'</div></details>';
 }
 function answerCard(x,i){
  if(x.who==='user')return '<div class="cp-q"><span>'+esc91(x.text)+'</span></div>';
  const time=Number.isFinite(x.when)?new Date(x.when).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'';
  if(/^Checking permitted live records|^Refining…/.test(x.text))return '<article class="cp-a cp-loading" aria-busy="true"><div class="cp-a-top"><span class="cp-orb sm"></span><span>Searching the records your role can access…</span></div><i class="cp-sk"></i><i class="cp-sk w70"></i><i class="cp-sk w45"></i></article>';
  if(x.error)return '<article class="cp-a cp-err"><div class="cp-a-top"><span class="cp-orb sm"></span><span>Live data unavailable · '+time+'</span></div><p class="cp-text">'+esc91(x.text)+'</p>'+(x.q?'<div class="cp-follow"><button type="button" data-s91-question="'+esc91(x.q)+'">↻ Try again</button></div>':'')+'</article>';
  if(!x.q&&!x.records?.length&&!x.summary)return '<article class="cp-a"><p class="cp-text">'+esc91(x.text).replace(/\n/g,'<br>')+'</p></article>';
  const recs=x.records||[],all=assistant.expandedRecs&&assistant.expandedRecs[i],shown=all?recs:recs.slice(0,3);
  const bd=(x.breakdown||[]).filter(b=>b&&b.label!=null),bdMax=Math.max(1,...bd.map(b=>Number(b.value)||0));
  const follows=followups(x);
  return '<article class="cp-a">'+
   '<div class="cp-a-top"><span class="cp-orb sm"></span><span class="cp-mode">'+(x.narration?'AI summary of live records':'Live records')+'</span><span class="cp-time">'+time+'</span></div>'+
   (x.summary&&x.summary.value!=null?'<div class="cp-hero"><strong>'+esc91(x.summary.value)+'</strong><span>'+esc91(x.summary.label||'Result')+'</span></div>':'')+
   '<p class="cp-text">'+esc91(x.text).replace(/\n/g,'<br>')+'</p>'+
   (x.narration?'<div class="cp-ai"><b>✦ AI context</b><p>'+esc91(x.narration)+'</p></div>':'')+
   (bd.length?fold(i,'bd','Breakdown',bd.length,'<div class="cp-bars">'+bd.map(b=>{const v=Number(b.value)||0;return '<div class="cp-bar"><span>'+esc91(b.label)+'</span><i><b style="width:'+Math.max(v?6:0,Math.round(100*v/bdMax))+'%"></b></i><strong>'+esc91(b.value)+'</strong></div>'}).join('')+'</div>'):'')+
   (x.filters&&(recs.length>1||(x.filters.statuses||[]).length||(x.filters.modules||[]).length)?fold(i,'rf','Refine results','',refineHtml(x,i)):'')+
   (recs.length?'<div class="cp-layer"><div class="cp-layer-h">Supporting records <b>'+recs.length+(x.limited?'+':'')+'</b></div><div class="cp-recs">'+recs.map((r,k)=>k<shown.length?recordCard(r):recordCard(r).replace('class="cp-rec"','class="cp-rec cp-extra"')).join('')+'</div>'+(recs.length>3?'<button type="button" class="cp-more" data-cp-more="'+i+'">'+(all?'Show fewer':'Show all '+recs.length+' records')+'</button>':'')+'</div>':'')+
   '<div class="cp-actions">'+(x.action?'<button type="button" class="cp-primary" data-s91-assist-go="'+x.action.join(':')+'">Open filtered register ↗</button>':'')+'<button type="button" data-cp-copy="'+i+'">Copy answer</button></div>'+
   (follows.length?fold(i,'gd','Go deeper',follows.length,'<div class="cp-follow">'+follows.map(f=>'<button type="button" data-s91-question="'+esc91(f)+'">'+esc91(f)+'</button>').join('')+'</div>'):'')+
   (x.source?'<small class="cp-src">'+esc91(x.source)+(x.limited?' · more records exist; open the register for the full list':'')+'</small>':'')+
   '</article>';
 }
 const TOPIC_ICON={'My work':'👤','Site issues':'⚠','Preventive maintenance':'🛠','Washing':'💧','Quick searches':'⌕','Recent':'↺'};
 /* Home: greeting, the live counts, then one tile per topic. Only the tapped topic's questions are shown. */
 function homeHtml(){
  const name=(typeof AUTH_IDENTITY!=='undefined'&&AUTH_IDENTITY.name?String(AUTH_IDENTITY.name).split(/\s+/)[0]:'');
  const hr=new Date().getHours(),greet=hr<12?'Good morning':hr<17?'Good afternoon':'Good evening';
  const recent=[...new Set(assistant.log.filter(x=>x.who==='user').map(x=>x.text).reverse())].slice(0,5);
  const topics=promptGroups().concat(recent.length?[['Recent','#64748B',recent]]:[]);
  const open=topics.find(t=>t[0]===assistant.topic);
  return '<div class="cp-home"><div class="cp-hello"><span class="cp-orb lg" aria-hidden="true"></span><div><b>'+greet+(name?', '+esc91(name):'')+'</b><span>What would you like to know?</span></div></div>'+
   '<div class="cp-snap-h">Right now'+(focusPlant()?' at '+esc91(focusPlant()):'')+'</div>'+
   '<div class="cp-snap">'+snapshot().map(t=>'<button type="button" style="--c:'+t[3]+'" data-s91-question="'+esc91(t[2])+'"><b>'+esc91(t[0])+'</b><span>'+esc91(t[1])+'</span></button>').join('')+'</div>'+
   '<div class="cp-snap-h">Pick a topic</div>'+
   '<div class="cp-topics" role="group" aria-label="Topics">'+topics.map(t=>'<button type="button" class="cp-topic'+(open===t?' on':'')+'" style="--c:'+t[1]+'" data-cp-topic="'+esc91(t[0])+'" aria-expanded="'+(open===t)+'"><span class="cp-topic-ico" aria-hidden="true">'+(TOPIC_ICON[t[0]]||'•')+'</span><b>'+esc91(t[0]==='Preventive maintenance'?'Maintenance':t[0])+'</b><small>'+t[2].length+' question'+(t[2].length===1?'':'s')+'</small></button>').join('')+'</div>'+
   (open?'<div class="cp-topic-panel" style="--c:'+open[1]+'">'+open[2].map(q=>'<button type="button" data-s91-question="'+esc91(q)+'"><span>'+esc91(q)+'</span><i aria-hidden="true">›</i></button>').join('')+'</div>'
    :'<p class="cp-pick-hint">Tap a topic to see its questions, or type your own below.</p>')+'</div>';
 }
 function copilotHtml(){
  const plants=hasAppState()?(S.plants||[]).filter(pl=>role()!=='Site Engineer'||!S._sePlant||pl.name===S._sePlant):[];
  const opts='<option value="all">All plants in my scope</option>'+plants.slice().sort((a,b)=>String(a.name).localeCompare(String(b.name))).map(pl=>'<option value="'+esc91(pl.name)+'"'+(assistant.focus===pl.name?' selected':'')+'>'+esc91((pl.id?pl.id+' · ':'')+pl.name)+'</option>').join('');
  const conv=assistant.log.length?assistant.log.map(answerCard).join(''):homeHtml();
  return '<section class="s91-assistant-panel s91-copilot'+(assistant.wide?' is-wide':'')+'" role="dialog" aria-label="Ask Solar91 operations copilot">'+
   '<header class="cp-head"><span class="cp-orb" aria-hidden="true"></span><div><h2>Ask Solar91</h2><small>Live answers from the records you can see</small></div>'+
   '<div class="cp-head-tools">'+(assistant.log.length?'<button type="button" data-cp-new title="Start a new conversation" aria-label="New conversation">✎</button>':'')+'<button type="button" data-cp-wide title="'+(assistant.wide?'Narrow':'Widen')+' panel" aria-label="'+(assistant.wide?'Narrow':'Widen')+' panel">'+(assistant.wide?'⇥':'⇤')+'</button><button type="button" data-s91-assist="close" aria-label="Close assistant">×</button></div></header>'+
   '<div class="cp-context"><label><span>Focus</span><select data-cp-plant aria-label="Focus suggestions on a plant">'+opts+'</select></label><span class="cp-badge">● Live</span></div>'+
   '<div class="s91-assistant-conversation cp-body" aria-live="polite">'+conv+'</div>'+
   '<div id="cp-suggest-slot" class="cp-suggest-slot"></div><form id="s91-assistant-form" class="cp-composer"><input id="s91-assistant-query" maxlength="300" aria-label="Ask an operations question" placeholder="Ask anything, or type a ticket / plant…" autocomplete="off"'+(assistant.busy?' disabled':'')+'><button type="submit" aria-label="Ask"'+(assistant.busy?' disabled':'')+'>'+(assistant.busy?'<span class="gx-spin" aria-hidden="true"></span>':'↑')+'</button></form>'+
   '<p class="cp-foot">Read-only · try “overdue maintenance at '+esc91((plants[0]&&plants[0].id)||'QA02')+'” or a ticket number</p></section>';
 }
 function assistantRoot(){let root=document.getElementById('s91-assistant-root');if(!root){root=document.createElement('div');root.id='s91-assistant-root';document.body.append(root)}return root}
 function drawAssistant(){syncAssistantUser();const root=assistantRoot();root.hidden=!document.querySelector('#app .shell');
  const visible=hasAppState()&&allowedAssistantRoles.includes(role());
  const suggestions=role()==='Site Engineer'?['My pending work','Overdue issues','Washing pending review','Tables cleaned today']:
   role()==='Assignee'?['My assigned work','Overdue PM tasks','Open issues','Washing pending review']:
   role()==='O&M Head'?['How many open issues?','Overdue issues','Overdue PM tasks','Washing pending review']:
   ['How many open issues?','Overdue issues','Overdue PM tasks','Which issues are open?'];
  root.innerHTML=visible?'<button class="s91-assistant-launch" data-s91-assist="toggle" aria-label="'+(assistant.open?'Close':'Open')+' Ask Solar91" title="Drag to move · click to open"><span class="cp-orb sm" aria-hidden="true"></span> Ask Solar91</button>'+(assistant.open?copilotHtml():''):'';
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
   const recordAction=/\b(issues?|tickets?|faults?)\b/i.test(expanded)?['issues',/overdue|late/i.test(expanded)?'overdue':'open']:
    /\b(pm|maintenance|tasks?)\b/i.test(expanded)?['pm',/overdue|late/i.test(expanded)?'overdue':'due']:
    /\b(wash\w*|clean\w*|tables?)\b/i.test(expanded)?['washing',/pending|review|confirm/i.test(expanded)?'review':'late']:null;
   assistant.log[position]={who:'bot',text:result.answer||'No matching saved record was found.',records:result.records||[],
     summary:result.summary||null,breakdown:result.breakdown||[],source:result.source||'',narration:result.narration||'',limited:!!result.limited||(result.records||[]).length>8,
     filters:result.filters||null,facets:result.facets||null,partial:!!result.partial,
     action:recordAction,q:expanded,when:Date.now()};
   saveAssistantHistory(assistant.log);
  }catch(error){
   if(assistantUserId()!==requestUserId||assistant.userId!==requestUserId)return;
   assistant.log[position]={who:'bot',error:true,q:expanded,text:'Live operational data could not be retrieved ('+(error.message||'connection error')+'). No current result is available. Please retry when the connection is restored.',when:Date.now()};
   saveAssistantHistory(assistant.log);
  }finally{
   if(assistantUserId()===requestUserId&&assistant.userId===requestUserId){
    assistant.busy=false;drawAssistant();document.getElementById('s91-assistant-query')?.focus({preventScroll:true});
   }
  }
 }
 async function refine(i,patch){
  const x=assistant.log[i];if(!x||!x.filters||assistant.busy)return;
  const f=JSON.parse(JSON.stringify(x.filters)),sort=patch.sort||x.sort||'relevance';
  if(patch.drop){const [kind,v]=patch.drop;if(kind==='plant')f.plant=null;else f[kind]=(f[kind]||[]).filter(y=>y!==v)}
  if(patch.add){const [kind,v]=patch.add;if(kind==='plant')f.plant={site_code:v,name:v};else if(!(f[kind]||[]).includes(v))f[kind]=(f[kind]||[]).concat([v])}
  const params=new URLSearchParams({q:(f.terms||[]).join(' '),limit:'40',sort});
  if((f.modules||[]).length)params.set('module',f.modules.join(','));
  if((f.severities||[]).length)params.set('severity',f.severities.join(','));
  if((f.statuses||[]).length)params.set('status',f.statuses.join(','));
  if(f.plant)params.set('plant',f.plant.site_code);
  const requestUserId=assistantUserId();
  assistant.busy=true;const prior=x;assistant.log[i]={who:'bot',text:'Refining…',when:Date.now()};drawAssistant();
  try{
   const r=await apiFetch('/api/field/search?'+params.toString());
   if(assistantUserId()!==requestUserId)return;
   const fl=r.filters||f,count=r.total||0;
   assistant.log[i]=Object.assign({},prior,{text:count?'Showing '+count+(r.limited?'+':'')+' '+describeFilters(fl)+'.'+(r.partial?' No record matched every word, so the closest matches are shown first.':''):'No '+describeFilters(fl)+' found in your approved scope. Remove a filter to widen the search.',
    records:r.records||[],filters:fl,facets:r.facets||{},partial:!!r.partial,limited:!!r.limited,sort,summary:{label:'Matching records',value:count},breakdown:[],narration:'',when:Date.now(),
    source:'Permission-scoped operational search · '+new Date().toLocaleString()});
   assistant.expandedRecs=Object.assign({},assistant.expandedRecs,{[i]:false});
  }catch(error){assistant.log[i]=prior;if(typeof toast==='function')toast('Could not refine the results ('+(error.message||'connection error')+').')}
  finally{assistant.busy=false;saveAssistantHistory(assistant.log);drawAssistant()}
 }
 /* instant suggestions while typing: tickets, work orders and plants already loaded for this user */
 function suggestions(text){
  const t=String(text||'').trim().toLowerCase();if(t.length<2||!hasAppState())return [];
  const out=[],hit=(...v)=>v.some(x=>String(x||'').toLowerCase().includes(t));
  (S.issues||[]).filter(x=>hit(x.id,x.desc,x.vertical,x.equip)).slice(0,4).forEach(x=>out.push({kind:'issues',id:x.dbId||x.id,ticket:x.id,plant:x.plant,label:x.id+' · '+(x.desc||x.vertical||''),sub:(x.plant||'')+(x.status?' · '+x.status:'')}));
  (S.tasks||[]).filter(x=>hit(x.id,x.name)).slice(0,2).forEach(x=>out.push({kind:'pm',id:x.id,ticket:'',plant:x.plant,label:x.id+' · '+(x.name||''),sub:x.plant||''}));
  (S.plants||[]).filter(x=>hit(x.id,x.name)).slice(0,2).forEach(x=>out.push({kind:'plant',label:(x.id?x.id+' · ':'')+x.name,sub:'Ask about this plant',q:'Open issues at '+x.name}));
  return out.slice(0,6);
 }
 function suggestHtml(text){
  const list=suggestions(text);if(!list.length)return '';
  return '<div class="cp-suggest" role="listbox" aria-label="Suggestions">'+list.map(sg=>sg.kind==='plant'
   ?'<button type="button" role="option" data-s91-question="'+esc91(sg.q)+'"><span class="cp-sg-ico">☀</span><span><b>'+esc91(sg.label)+'</b><small>'+esc91(sg.sub)+'</small></span></button>'
   :'<button type="button" role="option" data-s91-record-kind="'+sg.kind+'" data-s91-record-id="'+esc91(sg.id)+'" data-s91-record-ticket="'+esc91(sg.ticket)+'" data-s91-record-plant="'+esc91(sg.plant||'')+'"><span class="cp-sg-ico">'+(sg.kind==='issues'?'⚠':'🛠')+'</span><span><b>'+esc91(String(sg.label).slice(0,70))+'</b><small>'+esc91(sg.sub)+'</small></span></button>').join('')+'<p>Press Enter to search all records</p></div>';
 }
 function openAssistantRecord(kind,id,plant,ticket){
  assistant.open=false;drawAssistant();
  if(kind==='issues'){
   const issue=hasAppState()?(S.issues||[]).find(t=>t.id===ticket||t.dbId===id||t.id===id):null;
   if(issue&&typeof openIssue==='function'){openIssue(issue.id);return}
   if(typeof drillIssues==='function'){drillIssues({q:ticket||id,chip:'all'});return}
   if(typeof goTab==='function')goTab('issues');return}
  if(kind==='pm'){if(typeof S!=='undefined'){S.pmLive=S.pmLive||{};S.pmLive.query=id;S.pmLive.status='all';S.pmLive.view='register';if(S.schedF)S.schedF.q=id}if(typeof goScheduledOM==='function')goScheduledOM('maintenance');return}
  if(kind==='washing'){if(typeof S!=='undefined'){S._washUi=S._washUi||{};S._washUi.q=plant||''}if(typeof washOpenRegister==='function')washOpenRegister();else if(typeof goScheduledOM==='function')goScheduledOM('washing');return}
  if(kind==='plants'||kind==='equipment'){if(role()==='Site Engineer'){if(typeof window.s91RadarFocus==='function')window.s91RadarFocus('all','all');return}if(typeof S!=='undefined'){S.plF=S.plF||{};S.plF.q=plant||id;}if(typeof goView==='function')goView('plants');return}
 }

 document.addEventListener('click',e=>{
  if(assistant.dragged){assistant.dragged=false;e.preventDefault();return}
  const item=e.target.closest('[data-s91-assist]');if(item){assistant.open=item.dataset.s91Assist==='toggle'?!assistant.open:item.dataset.s91Assist!=='close';drawAssistant();return}
  const question=e.target.closest('[data-s91-question]');if(question){assistant.open=true;ask(question.dataset.s91Question);return}
  const record=e.target.closest('[data-s91-record-kind]');if(record){openAssistantRecord(record.dataset.s91RecordKind,record.dataset.s91RecordId,record.dataset.s91RecordPlant,record.dataset.s91RecordTicket);return}
  if(e.target.closest('[data-cp-new]')){assistant.log=[];assistant.expandedRecs={};assistant.lastQuery='';saveAssistantHistory([]);drawAssistant();return}
  if(e.target.closest('[data-cp-wide]')){assistant.wide=!assistant.wide;drawAssistant();return}
  const topic=e.target.closest('[data-cp-topic]');if(topic){assistant.topic=assistant.topic===topic.dataset.cpTopic?null:topic.dataset.cpTopic;drawAssistant();if(!assistant.log.length){const panel=document.querySelector('.cp-topic-panel');if(panel&&panel.scrollIntoView)panel.scrollIntoView({block:'nearest'})}return}
  const more=e.target.closest('[data-cp-more]');if(more){const i=Number(more.dataset.cpMore);assistant.expandedRecs=assistant.expandedRecs||{};assistant.expandedRecs[i]=!assistant.expandedRecs[i];const c=document.querySelector('.cp-body'),top=c?c.scrollTop:0;drawAssistant();const n=document.querySelector('.cp-body');if(n)n.scrollTop=top;return}
  const copy=e.target.closest('[data-cp-copy]');if(copy){const x=assistant.log[Number(copy.dataset.cpCopy)];if(x){const lines=[x.text].concat(x.summary&&x.summary.value!=null?[x.summary.label+': '+x.summary.value]:[]).concat((x.breakdown||[]).map(b=>'- '+b.label+': '+b.value)).concat((x.records||[]).map(r=>'- '+[r.ticket||(!isUuid(r.id)?r.id:''),r.title,r.plant,r.status].filter(Boolean).join(' · ')));try{navigator.clipboard.writeText(lines.join('\n')).then(()=>{if(typeof toast==='function')toast('Answer copied')},()=>{if(typeof toast==='function')toast('Copy is not available in this browser')})}catch(err){if(typeof toast==='function')toast('Copy is not available in this browser')}}return}
  const drop=e.target.closest('[data-cp-drop]');if(drop){const [i,kind,v]=drop.dataset.cpDrop.split('|');refine(Number(i),{drop:[kind,v]});return}
  const addf=e.target.closest('[data-cp-add]');if(addf){const [i,kind,v]=addf.dataset.cpAdd.split('|');refine(Number(i),{add:[kind,v]});return}
  const sortb=e.target.closest('[data-cp-sort]');if(sortb){const [i,k]=sortb.dataset.cpSort.split('|');refine(Number(i),{sort:k});return}
  const go=e.target.closest('[data-s91-assist-go]');if(go){const [kind,queue]=go.dataset.s91AssistGo.split(':');assistant.open=false;drawAssistant();window.s91OpenQueue(kind,queue);return}
 });
 document.addEventListener('toggle',e=>{const d=e.target;if(d&&d.dataset&&d.dataset.cpFold){assistant.folds=assistant.folds||{};assistant.folds[d.dataset.cpFold]=d.open}},true);
 document.addEventListener('input',e=>{
  const el=e.target;if(!el||!el.matches)return;
  if(el.matches('[data-cp-within]')){
   /* filter the answer's records in place (all of them, not only the first four) */
   const card=el.closest('.cp-a'),t=el.value.trim().toLowerCase();if(!card)return;let shown=0;
   card.querySelectorAll('.cp-rec').forEach(c=>{const ok=!t||(c.dataset.cpText||'').includes(t);c.hidden=!ok;c.classList.toggle('cp-force',!!t&&ok);if(ok)shown++});
   card.classList.toggle('cp-filtering',!!t);const n=card.querySelector('.cp-within-n');if(n)n.remove();
   if(t)el.closest('.cp-refine-row').insertAdjacentHTML('afterend','<small class="cp-within-n">'+shown+' of '+card.querySelectorAll('.cp-rec').length+' shown</small>');
   return;
  }
  if(el.id==='s91-assistant-query'){const box=document.getElementById('cp-suggest-slot');if(box)box.innerHTML=suggestHtml(el.value)}
 });
 document.addEventListener('focusout',e=>{if(e.target&&e.target.id==='s91-assistant-query')setTimeout(()=>{const box=document.getElementById('cp-suggest-slot');if(box&&!box.contains(document.activeElement))box.innerHTML=''},150)});
 document.addEventListener('change',e=>{if(!e.target.matches||!e.target.matches('[data-cp-plant]'))return;assistant.focus=e.target.value||'all';drawAssistant()});
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
