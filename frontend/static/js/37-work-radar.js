"use strict";
/* Work Radar: a small, interactive, role-scoped action layer; never alters server data.
   Existing Issues, PM, and Washing modules remain the editing source of truth. */
(function(){
 if(window.s91WorkRadarInstalled)return;window.s91WorkRadarInstalled=true;
 const roles=new Set(['O&M Head','Assignee','Site Engineer','Administration']);
 const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 const currentRole=()=>window.AUTH_IDENTITY?.role||(typeof S!=='undefined'?(S._roleLabel||S.currentRole):'');
 const radar={data:null,loadedAt:0,bucket:'overdue',kind:'all',equipment:'all',search:'',showLegacy:false,error:''};
 const today=()=>{const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const v=Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${v.year}-${v.month}-${v.day}`;};
 const days=(date,base)=>date?Math.round((Date.parse(date+'T12:00:00Z')-Date.parse(base+'T12:00:00Z'))/86400000):null;
 const root=()=>document.getElementById('s91-work-radar');
 const records=()=>{
  const data=radar.data||{},base=today();
  return [
   ...(data.issues||[]).map(x=>({kind:'issues',id:x.ticket||x.id,plant:x.plant,title:x.description,detail:x.status,priority:x.severity,assignee:x.assignee,equipment:x.equipment||'Site equipment',due:x.due,offset:days(x.due,base)})),
   ...(data.tasks||[]).map(x=>({kind:'pm',id:x.id,plant:x.plant,title:x.name,detail:x.status,priority:'',assignee:x.assignee,equipment:x.equipment||'Equipment not specified',due:x.due,offset:days(x.due,base)})),
   ...(data.washing||[]).map(x=>({kind:'washing',id:x.table||x.id,plant:x.plant,title:'Panel washing · '+(x.table||x.id),detail:x.status,priority:'',assignee:'',equipment:'Solar panel tables',due:x.due,offset:days(x.due,base)}))
  ];
 };
 function bucket(row,mode){return mode==='overdue'?row.offset!==null&&row.offset<0:mode==='today'?row.offset===0:mode==='week'?row.offset!==null&&row.offset>0&&row.offset<=7:true;}
 function selected(){const q=radar.search.toLocaleLowerCase();return records().filter(row=>bucket(row,radar.bucket)&&(radar.kind==='all'||row.kind===radar.kind)&&(radar.equipment==='all'||row.equipment===radar.equipment)&&(!q||[row.id,row.title,row.plant,row.equipment,row.assignee].some(v=>String(v||'').toLocaleLowerCase().includes(q)))).sort((a,b)=>(a.offset===null?9999:a.offset)-(b.offset===null?9999:b.offset)||a.kind.localeCompare(b.kind));}
 const kindName={issues:'Site issues',pm:'Preventive maintenance',washing:'Panel washing'};
 const glyph={issues:'!',pm:'↻',washing:'◉'};
 function renderBoard(){
  const data=radar.data;if(!data)return '<div class="s91-radar-load"><span class="s91-radar-loader"></span><strong>Getting your live work priorities…</strong><span>Reading site issues, PM and washing for your access scope.</span></div>';
  const rows=records(), visible=selected(), counts={overdue:rows.filter(r=>bucket(r,'overdue')).length,today:rows.filter(r=>bucket(r,'today')).length,week:rows.filter(r=>bucket(r,'week')).length,all:rows.length};
  const kinds=['issues','pm','washing'],types=[...new Set(rows.map(r=>r.equipment).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  const byKind=Object.fromEntries(kinds.map(k=>[k,rows.filter(r=>r.kind===k).length]));
  const values=kinds.map(k=>byKind[k]),total=values.reduce((a,b)=>a+b,0)||1;
  const ring='conic-gradient(#207c52 0 '+(100*values[0]/total)+'%,#e0a03b '+(100*values[0]/total)+'% '+(100*(values[0]+values[1])/total)+'%,#4a8cc9 '+(100*(values[0]+values[1])/total)+'% 100%)';
  const periodLabel={overdue:'Overdue work',today:'Due today',week:'Next 7 days',all:'All active work'};
  const bucketCard=(key,label,caption,icon)=>'<button type="button" data-radar-bucket="'+key+'" class="s91-radar-tile s91-radar-'+key+(radar.bucket===key?' is-active':'')+'" aria-pressed="'+(radar.bucket===key)+'"><span class="s91-radar-tile-top"><span>'+icon+'</span><span>Explore ↗</span></span><strong>'+counts[key]+'</strong><b>'+label+'</b><small>'+caption+'</small></button>';
  const chips=['all',...kinds].map(k=>'<button type="button" data-radar-kind="'+k+'" aria-pressed="'+(radar.kind===k)+'" class="'+(radar.kind===k?'active':'')+'">'+(k==='all'?'All work':kindName[k])+' <b>'+(k==='all'?rows.length:byKind[k])+'</b></button>').join('');
  const list=visible.slice(0,35).map(row=>{
   const date=row.offset===null?'No due date':row.offset<0?(-row.offset)+'d overdue':row.offset===0?'Today':row.offset+'d away';
   const badge=row.offset!==null&&row.offset<0?'late':row.offset===0?'today':'upcoming';
   return '<article class="s91-radar-job"><div class="s91-radar-kind '+row.kind+'" aria-hidden="true">'+glyph[row.kind]+'</div><div class="s91-radar-job-main"><small>'+esc(kindName[row.kind])+' · '+esc(row.plant||'Assigned location')+'</small><b>'+esc(row.title)+'</b><span>'+esc(row.equipment)+' · '+esc(row.id)+' · '+esc(row.assignee||row.detail||'')+'</span></div><div class="s91-radar-job-action"><span class="s91-radar-due '+badge+'">'+esc(date)+'</span><button type="button" data-radar-open="'+esc(row.kind)+'" data-radar-id="'+esc(row.id)+'" data-radar-plant="'+esc(row.plant)+'">Open work ↗</button></div></article>';
  }).join('');
  const clipped=!!data.limited;
  return '<div class="s91-radar-top"><div><span class="s91-radar-eyebrow">SOLAR91 / LIVE OPERATIONS</span><h2>Work Radar <span>Make the next action obvious.</span></h2><p>'+(data.scope==='one-plant'?'Your assigned plant':data.scope==='assigned-types'?'Your assigned equipment types':'Portfolio operations')+' · Records available to '+esc(data.role)+'. Select any metric to filter the live worklist.</p></div><div class="s91-radar-top-actions"><span class="s91-radar-live"><i></i> Server-scoped data</span><button type="button" data-radar-refresh>↻ Refresh</button></div></div>'+ 
   '<div class="s91-radar-tiles">'+bucketCard('overdue','Overdue','Past the due date','!')+bucketCard('today','Due today','Needs action before close','◷')+bucketCard('week','Next 7 days','Prepare the team','↗')+bucketCard('all','Active work','Issues · PM · washing','▦')+'</div>'+ 
   '<div class="s91-radar-dashboard"><div class="s91-radar-chart"><div class="s91-radar-chart-header"><strong>Work by activity</strong><small>Click a segment to filter</small></div><div class="s91-radar-chart-body"><div class="s91-radar-donut" style="--radar-ring:'+ring+'"><div><b>'+rows.length+'</b><small>records</small></div></div><div class="s91-radar-legend">'+kinds.map((k,i)=>'<button type="button" data-radar-kind="'+k+'" class="'+(radar.kind===k?'active':'')+'"><i class="'+k+'"></i><span>'+kindName[k]+'</span><b>'+values[i]+'</b></button>').join('')+'</div></div></div><div class="s91-radar-equipment"><div class="s91-radar-chart-header"><strong>Equipment focus</strong><small>Applies to all three activities</small></div><div class="s91-radar-equiplist"><button type="button" data-radar-equip="all" class="'+(radar.equipment==='all'?'active':'')+'">All equipment</button>'+types.slice(0,16).map(t=>'<button type="button" data-radar-equip="'+esc(t)+'" class="'+(radar.equipment===t?'active':'')+'">'+esc(t)+'</button>').join('')+'</div><p>Washing is linked to solar panel tables; it is not mapped to an unrelated inverter or transformer.</p></div></div>'+ 
   '<div class="s91-radar-register" id="s91-radar-register"><div class="s91-radar-register-title"><div><span class="s91-radar-eyebrow">ACTIONABLE REGISTER</span><h3>'+periodLabel[radar.bucket]+' <small>· '+visible.length+' shown</small></h3></div><div class="s91-radar-register-actions"><button type="button" data-radar-clear>Clear filters</button><button type="button" data-radar-legacy> '+(radar.showLegacy?'Hide':'Show')+' detailed Field Desk</button></div></div><div class="s91-radar-filters"><div class="s91-radar-tabs">'+chips+'</div><label class="s91-radar-query"><span>Search</span><input type="search" data-radar-query placeholder="Plant, work order, equipment, person…" value="'+esc(radar.search)+'" autocomplete="off"></label></div><div class="s91-radar-worklist">'+(list||'<div class="s91-radar-zero"><b>No records in this selection</b><span>Choose another period or activity to see available work.</span><button type="button" data-radar-clear>Show all active work</button></div>')+'</div>'+(visible.length>35?'<p class="s91-radar-foot">Showing 35 of '+visible.length+' matching records. Use the full module register for more.</p>':'')+(clipped?'<p class="s91-radar-foot">Overview limited to the latest returned records; totals describe the scoped worklist, not the entire portfolio. Use each module for the complete register.</p>':'')+'</div>';
 }
 function paint(){const box=root();if(!box)return;const input=box.querySelector('[data-radar-query]');const focus=!!input&&document.activeElement===input;const start=focus?input.selectionStart:null;box.innerHTML=radar.error&&!radar.data?'<div class="s91-radar-load"><strong>Work Radar unavailable</strong><span>'+esc(radar.error)+'</span><button type="button" data-radar-refresh>Retry</button></div>':renderBoard();const previous=document.getElementById('s91-field-desk');if(previous)previous.hidden=!radar.showLegacy;if(focus){const next=box.querySelector('[data-radar-query]');if(next){next.focus({preventScroll:true});try{next.setSelectionRange(start,start)}catch(_){}}}}
 function assign(data){if(!data||!Array.isArray(data.issues)||!Array.isArray(data.tasks))return;if(data.role!==currentRole())return;radar.data=data;radar.error='';radar.loadedAt=Date.now();paint()}
 document.addEventListener('s91:field-overview',e=>assign(e.detail));
 async function refresh(){if(!roles.has(currentRole()))return;const button=root()?.querySelector('[data-radar-refresh]');if(button)button.disabled=true;try{assign(await apiFetch('/api/field/overview?limit=50'));}catch(e){radar.error=e.message||'Unable to retrieve field work';paint()}finally{if(button)button.disabled=false}}
 const oldDashboard=window.renderDashboard;
 if(typeof oldDashboard==='function')window.renderDashboard=function(){const html=oldDashboard.apply(this,arguments);if(!roles.has(currentRole()))return html;queueMicrotask(()=>{if(window.s91FieldOverviewData)assign(window.s91FieldOverviewData);else if(!radar.data)setTimeout(()=>{if(!radar.data&&root())refresh()},850);else paint()});return '<section id="s91-work-radar" class="s91-work-radar" aria-label="Interactive operations work radar">'+(radar.data?renderBoard():'<div class="s91-radar-load"><strong>Getting your live work priorities…</strong></div>')+'</section>'+html;};
 window.s91JumpToTicket=function(id){if(typeof S==='undefined')return;S.issF=typeof blankIssF==='function'?blankIssF({q:String(id)}):Object.assign(S.issF||{},{q:String(id)});if(S.tablePages)S.tablePages.issues=1;if(typeof goTab==='function')goTab('issues')};
 window.s91RadarFocus=function(bucketValue,kindValue){radar.bucket=bucketValue||'all';radar.kind=kindValue||'all';radar.equipment='all';if(typeof goView==='function')goView('dashboard');setTimeout(()=>{paint();root()?.scrollIntoView({behavior:'smooth',block:'start'})},100)};
 document.addEventListener('click',e=>{
  const t=e.target.closest('[data-radar-bucket],[data-radar-kind],[data-radar-equip],[data-radar-clear],[data-radar-open],[data-radar-legacy],[data-radar-refresh]');if(!t)return;
  if(t.hasAttribute('data-radar-refresh')){refresh();return}
  if(t.hasAttribute('data-radar-legacy')){radar.showLegacy=!radar.showLegacy;paint();return}
  if(t.hasAttribute('data-radar-clear')){radar.bucket='all';radar.kind='all';radar.equipment='all';radar.search='';paint();return}
  if(t.hasAttribute('data-radar-bucket'))radar.bucket=t.dataset.radarBucket;
  if(t.hasAttribute('data-radar-kind'))radar.kind=t.dataset.radarKind;
  if(t.hasAttribute('data-radar-equip'))radar.equipment=t.dataset.radarEquip;
  if(t.hasAttribute('data-radar-open')){
   const k=t.dataset.radarOpen,id=t.dataset.radarId;
   if(k==='issues'&&typeof window.s91JumpToTicket==='function'){window.s91JumpToTicket(id);return}
   if(k==='pm'){if(typeof S!=='undefined'){if(S.pmLive){S.pmLive.query=id;S.pmLive.status='all';S.pmLive.page=1}if(S.schedF)S.schedF.q=id;}if(typeof goScheduledOM==='function')goScheduledOM('maintenance');return}
   if(k==='washing'){if(typeof S!=='undefined'){S._washUi=S._washUi||{};S._washUi.q=t.dataset.radarPlant||'';S._washUi.page=1;}if(typeof washOpenRegister==='function')washOpenRegister();else if(typeof goScheduledOM==='function')goScheduledOM('washing');return}
  }
  paint();
  if(t.hasAttribute('data-radar-bucket')||t.hasAttribute('data-radar-kind')||t.hasAttribute('data-radar-equip'))document.getElementById('s91-radar-register')?.scrollIntoView({behavior:'smooth',block:'nearest'});
 });
 document.addEventListener('input',e=>{if(e.target.matches('[data-radar-query]')){radar.search=e.target.value;paint()}});
})();
