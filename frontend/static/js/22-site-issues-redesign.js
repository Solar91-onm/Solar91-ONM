"use strict";
/* Site Issues — redesigned register. Reuses the existing data helpers (filterIssues, blankIssF, issueQuickActs, …). */
(function(){
 if(typeof renderIssues!=="function")return;
 const PRI=Object.assign({High:SEV_COLOR.Critical,Low:SEV_COLOR.Medium},SEV_COLOR);
 const STC={Open:"#3B82F6",Assigned:"#6675D9","In Progress":"#0F9F8C",Resolved:"#16A34A",Closed:"#15803D"};
 const AGEC={"0–1 days":"#3B82F6","2–3 days":"#0F9F8C","4–7 days":"#D97706","8–14 days":"#EA7B24","15+ days":"#DC4C3E"};
 const AGES=Object.keys(AGEC);
 const STAT=["Open","Assigned","Acknowledged","In Progress","Pending Vendor","Resolved","Closed"];
 const FILTER_LABELS={plant:"Plant",site:"Site code",project:"Project",district:"District",vert:"Issue type",equip:"Equipment",maker:"Maker",assignee:"Assignee",status:"Status",aging:"Age of issue"};
 const F=()=>{const f=Object.assign(blankIssF(),S.issF||{});S.issF=f;return f};
 const q=s=>String(s).replace(/\\/g,"\\\\").replace(/'/g,"\\'");

 const goodDay=v=>s91ValidDate(v);
 window.siSet=function(patch){patch=Object.assign({},patch);["from","to"].forEach(k=>{if(k in patch&&patch[k]&&!goodDay(patch[k]))patch[k]=""});Object.assign(F(),patch);S.tablePages.issues=1;render()};
 window.siToggle=function(k,v){const f=F();siSet({[k]:f[k]===v?"all":v})};
 window.siChip=function(id){const f=F();siSet({chip:f.chip===id?"all":id,queue:undefined})};
 window.siSort=function(k){siSet({sort:k})};
 window.siBucket=function(b){const f=F();siSet({bucket:f.bucket===b?"all":b,status:"all"})};
 const _fi=filterIssues;
 filterIssues=function(list,f){f=f||S.issF||blankIssF();let l=list;
  if(f.sla&&f.sla!=="all")l=(list||[]).filter(t=>{const open=t.status!=="Closed"&&t.status!=="Resolved";return f.sla==="done"?!open:f.sla==="overdue"?open&&isOverdueIssue(t):open&&!isOverdueIssue(t)});
  return _fi(l,f)};
 window.siMore=function(){S.issMore=!S.issMore;render()};
 window.siTrend=function(){S.siTrend=!S.siTrend;render()};
 let st=null;
 window.siSearch=function(el){F().q=el.value;S.tablePages.issues=1;clearTimeout(st);
  st=setTimeout(()=>{render();const i=document.getElementById("si-q");if(i){i.focus();const n=i.value.length;try{i.setSelectionRange(n,n)}catch(e){}}},200)};
 if(!window._siKey){window._siKey=1;document.addEventListener("keydown",e=>{
  const t=e.target,typing=t&&/INPUT|TEXTAREA|SELECT/.test(t.tagName);
  if(e.key==="/"&&!typing){const i=document.getElementById("si-q");if(i){e.preventDefault();i.focus()}}
  else if(e.key==="Escape"&&t&&t.id==="si-q"&&t.value){t.value="";siSearch(t)}})}


 /* ================= grouping, plant snapshot, sites matrix, priority chart ================= */
 const GROUP_PAGE=10;
 const SEVS=ISSUE_LEVELS; /* Critical, Medium, and green Solved for resolved/closed tickets */
 let triGroups=[];
 const siOpen=()=>{if(!(S.siOpenGroups instanceof Set))S.siOpenGroups=new Set();return S.siOpenGroups};
 const isOpenT=t=>t.status!=="Closed"&&t.status!=="Resolved";
 const sevOf=issueLevel;
 function siGroups(list){
  const map=new Map();
  (list||[]).forEach(t=>{const vert=t.vertical||"Other",key=(t.plant||"")+"|"+vert;
   if(!map.has(key))map.set(key,{key,plant:t.plant||"",vert,items:[]});map.get(key).items.push(t)});
  return [...map.values()].map(g=>{g.worst=g.items.map(sevOf).sort((a,b)=>(SEV_RANK[a]??9)-(SEV_RANK[b]??9))[0]||"Medium";return g});
 }
 /* a typed reference that only repeats the equipment or subpart name (e.g. "IDT" for "IDT: Breather Required") is not a unit / part number */
 const siSameName=(t,c)=>{const n=String(c).trim().toLowerCase();return [t.vertical,t.sub,String(t.sub||"").split(":")[0]].some(x=>x&&String(x).trim().toLowerCase()===n)};
 function siUnitCodes(items){
  const out=[];items.forEach(t=>{const u=Array.isArray(t.units)&&t.units.length?t.units.map(x=>x.code||x.name):(t.equip&&t.equip!=="—"?String(t.equip).split(/\s*,\s*/).filter(c=>!siSameName(t,c)):[]);u.forEach(c=>{if(c&&!out.includes(c))out.push(c)})});
  return out;
 }
 function siUnitsCell(t){
  const codes=siUnitCodes([t]);
  if(codes.length>1)return '<div class="si-units"><b>'+codes.length+' units</b><small>'+esc(codes.slice(0,4).join(", "))+(codes.length>4?" +"+(codes.length-4):"")+'</small></div>';
  return esc(t.equip||"—")+(t.maker?'<div class="si-sub">'+esc(t.maker)+'</div>':'');
 }
 function siRow(t,cls){
  const p=plantRec(t.plant),sla=slaState(t),c=PRI[issueLevel(t)]||"#64748B";
  const prob=String(t.desc||t.sub||"No description supplied").trim();
  const id=siUnitCodes([t]).join(", ");
  const company=t.supplier||t.maker||"";
  const origin=t.supplier?(t.maker?"Supplier · Maker: "+t.maker:"Supplier"):(t.maker?"Manufacturer":"");
  const done=t.status==="Closed"||t.status==="Resolved";
  const statusTone=done?"complete":sla==="breach"?"overdue":t.status==="Pending Vendor"?"waiting":"active";
  const deadline=done?"Completed":sla==="breach"?"Overdue":sla==="nearing"?"Due soon":t.etc?"On track":"No deadline";
  return '<tr class="si-r click'+cls+(S.flashId===t.id?' flash-new':'')+'" data-rid="'+esc(t.id)+'" data-act="issue" data-id="'+esc(t.id)+'">'+
   '<td class="si-ticket" style="--c:'+c+'" title="'+esc(issueLevel(t))+' priority"><b class="si-strong">'+esc(t.id)+'</b></td>'+
   '<td><span class="si-strong si-equip">'+esc(t.vertical||"Other")+'</span></td>'+
   '<td><span class="si-cell-text">'+esc(t.sub||"—")+'</span></td>'+
   '<td><span class="si-strong si-ref" title="'+esc(id||"No unit or part number entered")+'">'+esc(id||"—")+'</span></td>'+
   '<td class="si-problem-cell"><span class="si-problem-text" title="'+esc(prob)+'">'+esc(prob)+'</span></td>'+
   '<td><b class="si-strong">'+esc(p?p.id:t.plant||"—")+'</b>'+(p&&p.name?'<small class="si-quiet" title="'+esc(p.name)+'">'+esc(p.name)+'</small>':'')+'</td>'+
   '<td><span class="si-cell-text">'+esc(company||"—")+'</span>'+(origin?'<small class="si-quiet">'+esc(origin)+'</small>':'')+'</td>'+
   '<td>'+(t.assignee?'<span class="si-av"><i>'+esc(ccIni(t.assignee))+'</i>'+esc(t.assignee)+'</span>':'<span class="si-un">Unassigned</span>')+'</td>'+
   '<td><div class="si-status si-status-'+statusTone+'"><span class="si-status-label"><i aria-hidden="true"></i>'+esc(t.status||"Open")+'</span><small>'+deadline+'</small></div></td>'+
   '<td class="oi-action-cell"><div class="oi-row-actions">'+issueQuickActs(t)+'</div></td></tr>';
 }

 const MIXC={Open:"#3B82F6",Assigned:"#6675D9",Acknowledged:"#8B5CF6","In Progress":"#0F9F8C","Pending Vendor":"#D97706",Resolved:"#16A34A",Closed:"#15803D"};
 function siStatusMix(items){
  const order=Object.keys(MIXC),cnt={};
  items.forEach(t=>{cnt[t.status]=(cnt[t.status]||0)+1});
  return '<div class="si-mix">'+order.filter(k=>cnt[k]).map(k=>'<span style="--c:'+MIXC[k]+'"><i></i>'+esc(k==="Pending Vendor"?"Pending parts":k)+' <b>'+cnt[k]+'</b></span>').join("")+'</div>';
 }
 function siGroupRow(g,open){
  const p=plantRec(g.plant),un=g.items.filter(t=>!t.assignee).length,who=[...new Set(g.items.map(t=>t.assignee).filter(Boolean))];
  const units=siUnitCodes(g.items),ids=g.items.map(t=>t.id),over=g.items.filter(t=>slaState(t)==="breach").length;
  const subparts=[...new Set(g.items.map(t=>t.sub).filter(Boolean))];
  const companies=[...new Set(g.items.map(t=>t.supplier||t.maker).filter(Boolean))];
  const allDone=g.items.every(t=>!isOpenT(t));
  return '<tr class="si-g'+(open?' open':'')+'" onclick="siGroupToggle(\''+q(g.key)+'\')" title="'+(open?'Hide':'Show')+' the '+g.items.length+' tickets">'+
   '<td class="cc-cbcell" onclick="event.stopPropagation()"><input type="checkbox" class="si-gcb" aria-label="Select all '+g.items.length+' tickets" data-ids="'+esc(ids.join(","))+'" onchange="siGroupSelect(this)"/></td>'+
   '<td class="si-ticket"><div class="si-gid"><span class="si-chev">'+(open?'▾':'▸')+'</span><b>'+g.items.length+' issues</b></div><small class="si-quiet">'+esc(ids.slice(0,2).join(' · '))+(ids.length>2?' +'+(ids.length-2):'')+'</small></td>'+
   '<td><b class="si-strong">'+esc(g.vert)+'</b></td>'+
   '<td><span class="si-cell-text">'+esc(subparts.length===1?subparts[0]:subparts.length?subparts.length+' subparts':'—')+'</span></td>'+
   '<td><span class="si-strong si-ref">'+esc(units.length===1?units[0]:units.length?units.length+' unit IDs':'—')+'</span></td>'+
   '<td><span class="si-cell-text">'+g.items.length+' reported problems</span><small class="si-quiet">Tap to expand</small></td>'+
   '<td><b class="si-strong">'+esc(p?p.id:g.plant||'—')+'</b>'+(p&&p.name?'<small class="si-quiet">'+esc(p.name)+'</small>':'')+'</td>'+
   '<td><span class="si-cell-text">'+esc(companies.length===1?companies[0]:companies.length?companies.length+' companies':'—')+'</span></td>'+
   '<td>'+(un?'<span class="si-un">'+un+' unassigned</span>':who.length===1?'<span class="si-av"><i>'+esc(ccIni(who[0]))+'</i>'+esc(who[0])+'</span>':'<span class="si-quiet">'+who.length+' assignees</span>')+'</td>'+
   '<td><div class="si-status si-status-'+(allDone?'complete':over?'overdue':'active')+'"><span class="si-status-label"><i aria-hidden="true"></i>'+esc(allDone?'All resolved':'Open issues')+'</span><small>'+(over?over+' overdue':allDone?'Completed':g.items.filter(isOpenT).length+' active')+'</small></div></td>'+
   '<td class="oi-action-cell" onclick="event.stopPropagation()"><div class="oi-row-actions"><button type="button" class="btn g sm" onclick="siGroupToggle(\''+q(g.key)+'\')">'+(open?'Hide':'Show '+g.items.length)+'</button>'+
   (scheduledAdmin()&&un?'<button type="button" class="btn o sm" onclick="siGroupBulkAssign(\''+esc(ids.join(","))+'\')">Assign all</button>':'')+'</div></td></tr>';
 }

 window.siView=function(mode){S.issView=mode;S.tablePages.issues=1;render()};
 window.siGroupToggle=function(key){const o=siOpen();if(o.has(key))o.delete(key);else o.add(key);render()};
 window.siGroupSelect=function(el){
  (el.dataset.ids||"").split(",").filter(Boolean).forEach(id=>{const cb=document.querySelector('.cc-rowcb[data-tid="'+id+'"]');if(cb)cb.checked=el.checked;if(typeof ccToggleSel==="function"){try{ccToggleSel(id,{checked:el.checked})}catch(e){}}});
 };
 /* O&M Head: assign every ticket the current filters show (plant, district, equipment, type, age…) in one go */
 const siAssignable=t=>["Open","Assigned","Acknowledged"].includes(t.status);
 function siAssignMatchingButton(filtered){
  if(!scheduledAdmin())return "";
  const list=filtered.filter(siAssignable),un=list.filter(t=>!t.assignee).length;
  if(!list.length)return "";
  return '<button type="button" class="btn p sm si-assign-all" onclick="siAssignMatching()" title="Assign the tickets shown by the current filters to one person">⚑ Assign '+(un||list.length)+(un?' unassigned':'')+' in view</button>';
 }
 window.siAssignMatching=function(){
  if(!scheduledAdmin()){toast("Only the O&M Head can assign tickets.");return}
  const list=filterIssues(S.issues||[],F()).filter(siAssignable);
  if(!list.length){toast("No ticket in view can be assigned (work has started or it is finished).");return}
  const tags=Array.from(document.querySelectorAll(".si-active .si-tag")).map(x=>x.firstChild&&x.firstChild.textContent).filter(Boolean);
  S.modal="bulkAssign";S.modalCtx={ids:list.map(t=>t.id),scope:tags.length?tags.join(" · "):"All tickets in view"};render();
 };
 window.siGroupBulkAssign=function(ids){
  if(!scheduledAdmin()){toast("Only the O&M Head can assign tickets.");return}
  const list=String(ids||"").split(",").filter(Boolean);if(!list.length)return;
  S.modal="bulkAssign";S.modalCtx={ids:list};render();
 };
 window.siGroupFocus=function(i){const g=triGroups[i];if(!g)return;siOpen().add(g.key);S.issView="list";siSet({plant:g.plant,vert:g.vert,chip:"Unassigned"});
  setTimeout(()=>{const el=document.getElementById("section-results");if(el)el.scrollIntoView({behavior:"smooth",block:"start"})},30)};
 window.siGroupAssign=async function(i){
  const g=triGroups[i];if(!g)return;
  if(!scheduledAdmin()){toast("Only the O&M Head can assign tickets.");return}
  const sel=document.getElementById("si-ga-"+i),who=sel?sel.value:"";
  if(!who){toast("Choose who to assign "+(g.items.length>1?"these "+g.items.length+" tickets":g.items[0].id)+" to.");if(sel)sel.focus();return}
  const pool=typeof ISSUE_ASSIGNEES!=="undefined"&&Array.isArray(ISSUE_ASSIGNEES)?ISSUE_ASSIGNEES:[];
  const person=pool.find(a=>a.id===who);
  if(!person){toast("Choose an Assignee from the list.");return}
  const btn=sel&&sel.nextElementSibling;if(btn){btn.disabled=true;btn.textContent="Assigning…"}
  /* one request for the whole group (server: one transaction, one notification) */
  let r;
  try{r=await apiFetch("/api/issues/bulk-assign",{method:"POST",body:{issue_ids:g.items.map(t=>t.dbId).filter(Boolean),assigned_to:person.id,reassign:true,note:"Assigned from the triage queue"}})}
  catch(e){if(btn){btn.disabled=false;btn.textContent="Assign"}toast("Not assigned — "+(e.message||"error"));return}
  (r.assigned||[]).forEach(row=>applyIssueRow(row,(S.issues||[]).find(x=>x.id===row.ticket_no)));
  const failed=(r.skipped||[]).map(x=>x.ticket_no||"?"),ok=(r.assigned||[]).length;
  render();toast(ok+" ticket"+(ok===1?"":"s")+" assigned to "+person.name+(failed.length?" · not changed: "+failed.join(", "):" — notified."));
 };
 function siPlantSnapshot(plantName,all,f){
  const p=plantRec(plantName),mine=all.filter(t=>t.plant===plantName),open=mine.filter(isOpenT);
  const groups=siGroups(mine).sort((a,b)=>b.items.filter(isOpenT).length-a.items.filter(isOpenT).length||(SEV_RANK[a.worst]??9)-(SEV_RANK[b.worst]??9));
  let h='<div class="si-plant"><div class="si-plant-h"><div><span class="kpi-label">PLANT SNAPSHOT</span><h3>'+esc(p?p.id+" · "+p.name:plantName)+'</h3></div><div class="si-plant-k"><span><b>'+open.length+'</b> open</span><span class="c"><b>'+open.filter(t=>sevOf(t)==="Critical").length+'</b> critical</span><span class="o"><b>'+open.filter(isOverdueIssue).length+'</b> overdue</span><span><b>'+groups.filter(g=>g.items.some(isOpenT)).length+'</b> equipment types affected</span></div>'+
   '<button type="button" class="btn o sm" onclick="siSet({plant:\'all\',vert:\'all\'})">All plants</button></div>';
  if(!groups.length)return h+'<div class="si-plant-empty">✓ No issues recorded at this plant.</div></div>';
  h+='<div class="si-plant-grid">'+groups.map(g=>{const o=g.items.filter(isOpenT),done=g.items.length-o.length,on=f.vert===g.vert,units=siUnitCodes(o);
   const worst=o.length?siGroups(o)[0].worst:"Medium";
   return '<button type="button" class="si-eq'+(on?" on":"")+(o.length?"":" ok")+'" style="--c:'+(o.length?PRI[worst]:"#16A34A")+'" onclick="siToggle(\'vert\',\''+q(g.vert)+'\')"><div class="si-eq-h"><b>'+esc(g.vert)+'</b><span class="si-eq-n">'+(o.length?o.length+" open":"✓ clear")+'</span></div>'+
    (o.length?siStatusMix(o):'')+
    '<small>'+(units.length?esc(units.slice(0,5).join(", "))+(units.length>5?" +"+(units.length-5):"")+' · ':'')+(o.length?'worst '+esc(worst)+' · oldest '+Math.max.apply(null,o.map(issueAgeDays))+'d':'')+(done?(o.length?' · ':'')+done+' done':'')+'</small></button>'}).join("")+'</div></div>';
  return h;
 }
 function siSitesMatrix(list){
  const plants=[...new Set(list.map(t=>t.plant).filter(Boolean))],types=[...new Set(list.map(t=>t.vertical||"Other"))];
  const typeCount=k=>list.filter(t=>(t.vertical||"Other")===k&&isOpenT(t)).length,plantCount=k=>list.filter(t=>t.plant===k&&isOpenT(t)).length;
  types.sort((a,b)=>typeCount(b)-typeCount(a)||a.localeCompare(b));
  plants.sort((a,b)=>plantCount(b)-plantCount(a)||a.localeCompare(b));
  if(!plants.length)return '<div class="si-empty"><div class="ico">✓</div><b>No issues in view</b><p>Change the filters to see plants here.</p></div>';
  const TINT={Critical:"rgba(220,76,62,.16)",Medium:"rgba(59,130,246,.14)"};
  let h='<div class="si-mx-wrap"><div class="si-mx-legend"><span>Number = open tickets · colour = worst priority</span>'+SEV.map(k=>'<span><i style="background:'+PRI[k]+'"></i>'+k+'</span>').join("")+'<span><i class="ok"></i>All done</span></div><div class="si-scroll"><table class="si-mx"><thead><tr><th class="pl">Plant</th>'+types.map(k=>'<th title="'+esc(k)+'">'+esc(k)+'</th>').join("")+'<th class="tot">Open</th></tr></thead><tbody>';
  plants.forEach(pn=>{const p=plantRec(pn);
   h+='<tr><th class="pl"><button type="button" onclick="S.issView=\'list\';siSet({plant:\''+q(pn)+'\'})"><b>'+esc(p?p.id:pn)+'</b><small>'+esc(p?p.name:"")+'</small></button></th>';
   types.forEach(k=>{const items=list.filter(t=>t.plant===pn&&(t.vertical||"Other")===k);
    if(!items.length){h+='<td class="e">·</td>';return}
    const o=items.filter(isOpenT),go="S.issView=\'list\';siSet({plant:\'"+q(pn)+"\',vert:\'"+q(k)+"\'})";
    if(!o.length){h+='<td><button type="button" class="si-cell ok" title="'+esc(k)+' at '+esc(pn)+': '+items.length+' done" onclick="'+go+'">✓</button></td>';return}
    const w=siGroups(o)[0].worst,un=o.filter(t=>!t.assignee).length,od=o.filter(isOverdueIssue).length;
    h+='<td><button type="button" class="si-cell" style="--c:'+PRI[w]+';background:'+TINT[w]+'" title="'+esc(k)+' at '+esc(pn)+': '+o.length+' open, worst '+w+(un?', '+un+' unassigned':'')+(od?', '+od+' overdue':'')+'" onclick="'+go+'"><b>'+o.length+'</b>'+(od?'<i class="od"></i>':un?'<i class="un"></i>':'')+'</button></td>'});
   h+='<td class="tot"><b>'+plantCount(pn)+'</b></td></tr>'});
  h+='</tbody><tfoot><tr><th class="pl">Open per type</th>'+types.map(k=>'<td class="tot"><b>'+typeCount(k)+'</b></td>').join("")+'<td class="tot"><b>'+list.filter(isOpenT).length+'</b></td></tr></tfoot></table></div><div class="si-mx-note"><span><i class="od"></i>overdue</span><span><i class="un"></i>unassigned</span><span>Click any cell to open those tickets</span></div></div>';
  return h;
 }
 function siPriorityChart(list,by,f){
  const scope=S.siChartScope==="all"?list:list.filter(isOpenT);
  const keyOf=t=>by==="plant"?(t.plant||"—"):(t.vertical||"Other");
  const map=new Map();scope.forEach(t=>{const k=keyOf(t);if(!map.has(k))map.set(k,{k,Critical:0,Medium:0,Solved:0,n:0});const r=map.get(k);r[sevOf(t)]++;r.n++});
  let rows=[...map.values()].sort((a,b)=>b.Critical-a.Critical||b.n-a.n||a.k.localeCompare(b.k));
  if(!rows.length)return '<div class="si-empty"><div class="ico">✓</div><b>'+(S.siChartScope==="all"?"No tickets in view":"No open tickets in view")+'</b><p>Nothing to chart for the current filters.</p></div>';
  if(rows.length>12){const rest=rows.slice(11),o={k:"Other ("+rest.length+")",Critical:0,Medium:0,Solved:0,n:0,other:true};rest.forEach(r=>{SEVS.forEach(s=>{o[s]+=r[s]});o.n+=r.n});rows=rows.slice(0,11).concat([o])}
  const max=Math.max.apply(null,rows.map(r=>r.n)),tot={Critical:0,Medium:0,Solved:0};rows.forEach(r=>SEVS.forEach(s=>{tot[s]+=r[s]}));
  const label=r=>{if(by!=="plant"||r.other)return '<b>'+esc(r.k)+'</b>';const p=plantRec(r.k);return '<b>'+esc(p?p.id:r.k)+'</b> <small>'+esc(p?p.name:"")+'</small>'};
  const filt=(r,s)=>(by==="plant"?"siSet({plant:\'"+q(r.k)+"\'":"siSet({vert:\'"+q(r.k)+"\'")+(s?",sev:\'"+s+"\'":"")+"})";
  return '<div class="si-pc"><div class="si-pc-lg">'+(S.siChartScope==="all"?SEVS:SEV).map(s=>'<span><i style="background:'+PRI[s]+'"></i>'+s+' <b>'+tot[s]+'</b></span>').join("")+'</div>'+
   rows.map(r=>'<div class="si-pc-row"><button type="button" class="si-pc-l" '+(r.other?"disabled":'onclick="'+filt(r,"")+'"')+' title="'+esc(r.k)+'">'+label(r)+'</button><div class="si-pc-bar">'+
    SEVS.filter(s=>r[s]).map(s=>'<button type="button" class="si-pc-seg" style="width:'+(r[s]/max*100).toFixed(2)+'%;--c:'+PRI[s]+'" data-tip="'+esc(r.k)+' · '+s+': '+r[s]+' of '+r.n+'" aria-label="'+esc(r.k)+' '+s+' '+r[s]+'" '+(r.other?"disabled":'onclick="'+filt(r,s)+'"')+'>'+(r[s]/max>=.07?'<span>'+r[s]+'</span>':'')+'</button>').join("")+
    '</div><b class="si-pc-n">'+r.n+'</b></div>').join("")+'</div>';
 }
 if(!window._siTip){window._siTip=1;
  document.addEventListener("mouseover",e=>{const seg=e.target&&e.target.closest?e.target.closest(".si-pc-seg"):null;let tip=document.getElementById("si-tip");
   if(!seg){if(tip)tip.style.display="none";return}
   if(!tip){tip=document.createElement("div");tip.id="si-tip";tip.className="si-tip";document.body.appendChild(tip)}
   tip.textContent=seg.dataset.tip||"";tip.style.display="block";const r=seg.getBoundingClientRect();
   tip.style.left=Math.max(8,Math.min(window.innerWidth-tip.offsetWidth-8,r.left+r.width/2-tip.offsetWidth/2))+"px";tip.style.top=Math.max(8,r.top-tip.offsetHeight-8)+"px"});
 }

 renderIssues=function(){
  const f=F(),all=S.issues||[],filtered=filterIssues(all,f),openAll=openTk(all),openF=openTk(filtered);
  const people=[...new Set(all.map(t=>t.assignee).filter(Boolean).concat(TEAM_POOL))].sort();
  const districts=[...new Set((S.plants||[]).map(p=>String(p.district||"").trim()).filter(Boolean))].sort(),sites=[...new Set((S.plants||[]).map(p=>p.id))].sort(),projs=[...new Set((S.plants||[]).map(plantProject).filter(Boolean))].sort();
  const makers=[...new Set(all.map(t=>t.maker).filter(Boolean))].sort(),equips=[...new Set(all.map(t=>t.equip).filter(Boolean))].sort();
  const advKeys=["site","project","district","maker","equip","vert","aging"];
  const advCount=advKeys.filter(k=>f[k]&&f[k]!=="all").length+(f.from?1:0)+(f.to?1:0);
  const total=Math.max(1,all.length);
  const cnt={Open:openAll.length,Critical:openAll.filter(t=>t.severity==="Critical").length,Overdue:openAll.filter(isOverdueIssue).length,
   Unassigned:openAll.filter(t=>!t.assignee).length,Resolved:all.filter(t=>t.status==="Resolved"||t.status==="Closed").length,
   Aging:openAll.filter(t=>ageBucket(t)==="15+ days").length,Today:all.filter(t=>issueDay(t)===TODAY).length,Mine:all.filter(t=>t.assignee===OM_HEAD).length};

  /* ---- header ---- */
  let h='<div class="si-head"><div><div class="kpi-label">SOLAR OPERATIONS · LIVE REGISTER</div><h1>Site Issues</h1><p>Prioritize field faults, assign ownership, and track resolution across your plants.</p></div>'+
   '<div class="si-head-r"><div class="si-live"><i></i><div><b>'+openF.length+' open</b><small>'+filtered.length+' of '+all.length+' in view</small></div></div>'+
   (typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role==="O&M Head"&&typeof s91OpenIssueDeadlines==="function"?'<button class="btn o sm" onclick="s91OpenIssueDeadlines()" title="Default deadline for new Critical and Medium tickets'+(typeof s91DeadlineText==="function"?' — now '+esc(s91DeadlineText()):'')+'">⏱ Deadlines</button>':'')+
   (typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role==="O&M Head"?'<button class="btn o sm" onclick="s91OpenDeletedTickets()" title="Restore tickets removed by mistake">Deleted tickets</button>':'')+
   (typeof AUTH_IDENTITY!=="undefined"&&["O&M Head","Assignee","Site Engineer"].includes(AUTH_IDENTITY.role)&&typeof issueUploadOpen==="function"?'<button class="btn o sm" onclick="issueUploadOpen()" title="Raise many tickets from one spreadsheet">Upload Excel</button>':'')+
   '<button class="btn p oi-raise-button" onclick="openModal(\'newTicket\')">'+I.plus(14)+' Raise Issue</button></div></div>';

  /* ---- LAYER 1 · search + quick views (always visible, light) ---- */
  const sel=(k,list,allLabel)=>'<select class="si-sel'+(f[k]!=="all"?" on":"")+'" aria-label="'+(FILTER_LABELS[k]||k)+'" onchange="siSet({'+k+':this.value})"><option value="all">'+allLabel+'</option>'+list.map(([v,l])=>'<option value="'+esc(v)+'"'+(f[k]===v?" selected":"")+'>'+esc(l)+'</option>').join("")+'</select>';
  const fld=(t,x)=>'<label class="si-f"><span>'+t+'</span>'+x+'</label>';
  const chip=(id,l,n)=>'<button type="button" class="si-chip'+(f.chip===id?" on":"")+'" onclick="'+(id==="all"?"siSet({chip:\'all\',queue:undefined})":"siChip(\'"+id+"\')")+'">'+l+'<b>'+n+'</b></button>';
  const sugg=[...new Set(all.map(t=>t.id).concat((S.plants||[]).map(p=>p.name),makers,equips,people))].slice(0,200);
  const nTags=[f.q,f.chip!=="all",f.plant!=="all",f.sev!=="all",f.status!=="all",f.assignee!=="all",f.bucket!=="all",f.sla&&f.sla!=="all"].filter(Boolean).length+advCount;
  h+='<div class="si-bar"><div class="si-row">'+
   '<div class="si-search"><span class="ic">⌕</span><input id="si-q" name="issue_search" list="si-sugg" autocomplete="off" aria-label="Search issues" value="'+esc(f.q)+'" placeholder="Search tickets, plants, makers, people…" oninput="siSearch(this)"/>'+
   (f.q?'<button type="button" title="Clear search" onclick="document.getElementById(\'si-q\').value=\'\';siSearch(document.getElementById(\'si-q\'))">×</button>':'<kbd>/</kbd>')+
   '<datalist id="si-sugg">'+sugg.map(x=>'<option value="'+esc(x)+'">').join("")+'</datalist></div>'+
   sel("plant",(S.plants||[]).map(p=>[p.name,p.name]),"All plants")+
   '<select class="si-sel" aria-label="Sort" onchange="siSet({sort:this.value})">'+[["etc","↕ Due soonest"],["severity","↕ Highest priority"],["age","↕ Oldest first"],["created","↕ Newest first"]].map(([v,l])=>'<option value="'+v+'"'+(f.sort===v?" selected":"")+'>'+l+'</option>').join("")+'</select>'+
   '<button type="button" class="si-more'+(S.issMore?" open":"")+(advCount||f.assignee!=="all"||f.status!=="all"?" on":"")+'" onclick="siMore()"><span>☰</span> Filters'+((advCount+(f.assignee!=="all"?1:0)+(f.status!=="all"?1:0))?' <em>'+(advCount+(f.assignee!=="all"?1:0)+(f.status!=="all"?1:0))+'</em>':'')+' <i class="car">'+I.chev(12)+'</i></button></div>'+
   '<div class="si-chips">'+chip("all","All",all.length)+chip("Open","Open",cnt.Open)+chip("Unassigned","Unassigned",cnt.Unassigned)+chip("Overdue","Overdue",cnt.Overdue)+chip("Today","Today",cnt.Today)+chip("Mine","My issues",cnt.Mine)+siAssignMatchingButton(filtered)+'</div>';
  /* ---- LAYER 2 · detailed filters (collapsed until asked, grouped by meaning) ---- */
  if(S.issMore)h+='<div class="si-panel">'+
   '<div class="si-grp"><div class="gh"><i>📍</i>Where</div>'+(districts.length?fld("District",sel("district",districts.map(x=>[x,x]),"All districts")):"")+fld("Site code",sel("site",sites.map(x=>[x,x]),"All sites"))+fld("Project",sel("project",projs.map(x=>[x,x]),"All projects"))+'</div>'+
   '<div class="si-grp"><div class="gh"><i>⚙</i>What</div>'+fld("Issue type",sel("vert",VERTICALS.map(v=>[v,v]),"All types"))+(equips.length?fld("Equipment",sel("equip",equips.map(x=>[x,x]),"All equipment")):"")+(makers.length?fld("Maker",sel("maker",makers.map(x=>[x,x]),"All makers")):"")+'</div>'+
   '<div class="si-grp"><div class="gh"><i>👤</i>Who & stage</div>'+fld("Assignee",sel("assignee",[["Unassigned","Unassigned"]].concat(people.map(x=>[x,x])),"Anyone"))+fld("Status",sel("status",STAT.map(x=>[x,x]),"Any status"))+'</div>'+
   '<div class="si-grp"><div class="gh"><i>🗓</i>When</div>'+fld("Age of issue",sel("aging",AGES.map(x=>[x,x]),"Any age"))+'<div class="si-dates">'+fld("From",'<input id="issue-filter-from" name="occurred_from" type="date" value="'+esc(f.from)+'" onchange="siSet({from:this.value})"/>')+fld("To",'<input id="issue-filter-to" name="occurred_to" type="date" value="'+esc(f.to)+'" onchange="siSet({to:this.value})"/>')+'</div></div>'+
   '<div class="si-pfoot"><button type="button" class="si-clear" onclick="S.issF=blankIssF();S.tablePages.issues=1;render()">Reset all</button><button type="button" class="btn p sm" onclick="siMore()">Show '+filtered.length+' result'+(filtered.length===1?"":"s")+'</button></div></div>';
  /* active filter tags */
  const tags=[];const T=(l,reset)=>tags.push('<span class="si-tag">'+esc(l)+'<button type="button" title="Remove" onclick="siSet('+reset+')">×</button></span>');
  if(f.q)T("“"+f.q+"”","{q:\'\'}");
  if(f.chip!=="all")T(f.chip==="Mine"?"My issues":f.chip,"{chip:\'all\'}");
  if(f.sla&&f.sla!=="all")T({overdue:"Overdue",ontime:"On time",done:"Done"}[f.sla],"{sla:\'all\'}");
  [["plant","Plant"],["sev","Priority"],["status","Status"],["assignee","Assignee"],["bucket","Stage"],["district","District"],["site","Site"],["project","Project"],["maker","Maker"],["equip","Equipment"],["vert","Type"],["aging","Age"]].forEach(([k,l])=>{if(f[k]&&f[k]!=="all")T(l+": "+(k==="equip"&&typeof equipmentFilterLabel==="function"?equipmentFilterLabel(f[k]):f[k]),"{"+k+":\'all\'}")});
  if(f.from)T("From "+f.from,"{from:\'\'}");if(f.to)T("To "+f.to,"{to:\'\'}");
  const hasF=tags.length>0||!!f.queue;
  h+=(hasF?'<div class="si-active"><span class="si-lbl">Showing</span>'+tags.join("")+'<button type="button" class="si-clear" onclick="S.issF=blankIssF();S.tablePages.issues=1;render()">Clear all</button></div>':'')+'</div>';

  /* ---- command-centre drill banner ---- */
  const ql={critical:"Critical open issues",overdue:"Overdue non-critical issues",other:"Other open issues"};
  if(f.queue&&ql[f.queue])h+='<div class="cc-drill-filter"><span>Command Center filter: <b>'+ql[f.queue]+'</b></span><button class="btn o sm" onclick="delete S.issF.queue;S.tablePages.issues=1;render()">Clear drill-down</button></div>';

  /* ---- donut cards = visual filters (each ignores its own filter so you can switch slices) ---- */
  const without=(k)=>filterIssues(all,Object.assign({},f,k.reduce((o,x)=>(o[x]=x==="q"?"":"all",o),{})));
  const donut=(title,items,centerN,centerL,onKey,click)=>{
   const tot=items.reduce((a,x)=>a+x.n,0),R=46,C=2*Math.PI*R,anyOn=items.some(onKey);let off=0;
   const segs=tot?items.filter(x=>x.n).map(x=>{const len=x.n/tot*C,gap=items.filter(y=>y.n).length>1?2.5:0,d=Math.max(0,len-gap);
     const el='<circle class="seg'+(onKey(x)?" on":"")+'" cx="60" cy="60" r="'+R+'" fill="none" stroke="'+x.c+'" stroke-width="14" stroke-dasharray="'+d.toFixed(2)+' '+(C-d).toFixed(2)+'" stroke-dashoffset="'+(-off).toFixed(2)+'" transform="rotate(-90 60 60)" onclick="'+click(x)+'"><title>'+esc(x.l)+': '+x.n+'</title></circle>';off+=len;return el}).join(""):"";
   return '<div class="si-dn"><h3>'+title+'</h3><div class="body"><div class="ring'+(anyOn?" has-on":"")+'"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="'+R+'" fill="none" stroke="#EEF2EF" stroke-width="14"/>'+segs+'</svg><div class="ctr"><b>'+centerN+'</b><small>'+centerL+'</small></div></div>'+
    '<div class="lg">'+items.map(x=>'<button type="button" class="'+(onKey(x)?"on":"")+'" onclick="'+click(x)+'"><i style="background:'+x.c+'"></i><span>'+esc(x.l)+'</span><b>'+x.n+'</b></button>').join("")+'</div></div></div>'};
  const pBase=without(["sev"]),sBase=without(["bucket","status"]),dBase=without(["sla","chip"]);
  const pI=ISSUE_LEVELS.map(x=>({l:x,n:pBase.filter(t=>issueLevel(t)===x).length,c:PRI[x]}));
  const sI=["Open","Assigned","In Progress","Resolved"].map(x=>({l:x,n:sBase.filter(t=>statusBucket(t)===x||(x==="Resolved"&&statusBucket(t)==="Closed")).length,c:STC[x]}));
  const dOpen=openTk(dBase),dOver=dOpen.filter(isOverdueIssue).length,dDone=dBase.length-dOpen.length;
  const dI=[{l:"On time",n:dOpen.length-dOver,c:"#3B82F6",k:"ontime"},{l:"Overdue",n:dOver,c:"#DC4C3E",k:"overdue"},{l:"Done",n:dDone,c:SEV_COLOR.Solved,k:"done"}];
  h+='<div class="si-dns">'+
   donut("Priority",pI,pBase.length,"issues",x=>f.sev===x.l,x=>"siToggle(\'sev\',\'"+q(x.l)+"\')")+
   donut("Status",sI,sBase.length,"issues",x=>f.bucket===x.l,x=>"siBucket(\'"+q(x.l)+"\')")+
   donut("Deadline",dI,dOpen.length?Math.round(100*(dOpen.length-dOver)/dOpen.length)+"%":"—","on time",x=>f.sla===x.k,x=>"siToggle(\'sla\',\'"+x.k+"\')")+'</div>';

  /* ---- plant snapshot: what is broken at this plant, by equipment type ---- */
  if(f.plant&&f.plant!=="all")h+=siPlantSnapshot(f.plant,all,f);

  /* ---- triage queue: compact, one card per plant + equipment type ---- */
  if(scheduledAdmin()){
   const need=openAll.filter(t=>!t.assignee).sort((a,b)=>(SEV_RANK[a.severity]??9)-(SEV_RANK[b.severity]??9)||String(a.created).localeCompare(String(b.created)));
   triGroups=siGroups(need);
   if(need.length){
    const crit=need.filter(t=>t.severity==="Critical").length;
    const opts=k=>'<option value="">Assign to…</option>'+(typeof assigneeOptionsHtml==="function"?assigneeOptionsHtml(k):people.map(x=>'<option>'+esc(x)+'</option>').join(""));
    h+='<div class="si-tri2"><div class="si-tri2-h"><b>⚑ Needs an owner</b><span>'+need.length+' unassigned'+(crit?' · <em>'+crit+' critical</em>':'')+'</span>'+
     (need.length>1?'<button type="button" class="si-link" onclick="siChip(\'Unassigned\')">Show in list</button>':'')+'</div><div class="si-tri2-list">'+
     triGroups.slice(0,8).map((g,i)=>{const one=g.items.length===1,t0=g.items[0],p=plantRec(g.plant);
      return '<div class="si-tc" style="--c:'+(PRI[g.worst]||"#ccc")+'"><button type="button" class="si-tc-m" title="'+esc(g.items.map(t=>t.id).join(", "))+'" onclick="'+(one?"openIssue(\'"+q(t0.id)+"\')":"siGroupFocus("+i+")")+'">'+
       '<b>'+(one?esc(t0.id):esc(g.vert)+' <i>×'+g.items.length+'</i>')+'</b><small>'+esc(p?p.id:g.plant)+' · '+(one?esc(g.vert):g.items.length+' tickets')+'</small></button>'+
       '<div class="si-tc-a"><select class="sel" id="si-ga-'+i+'" aria-label="Assignee for '+esc(g.vert)+' at '+esc(g.plant)+'">'+opts(g.vert)+'</select><button type="button" class="btn p sm" title="Assign '+(one?"this ticket":"all "+g.items.length+" tickets")+'" onclick="siGroupAssign('+i+')">'+(one?"Assign":"Assign all")+'</button></div></div>'}).join("")+
     (triGroups.length>8?'<button type="button" class="si-tc si-tc-more" onclick="siChip(\'Unassigned\')">+'+(triGroups.length-8)+' more</button>':'')+'</div></div>';
   }
  }

  /* ---- results: one row per plant + equipment type (expand to see its tickets) ---- */
  const sorted=filtered.slice().sort((a,b)=>f.sort==="created"?String(b.created).localeCompare(String(a.created)):f.sort==="severity"?(SEV_RANK[a.severity]??9)-(SEV_RANK[b.severity]??9):f.sort==="age"?issueAgeDays(b)-issueAgeDays(a):new Date(a.etc)-new Date(b.etc));
  const mode=S.issView==="board"?"board":S.issView==="sites"?"sites":"list",grouped=S.siGroup===true;
  const groups=grouped?siGroups(sorted):sorted.map(t=>({key:t.id,plant:t.plant,vert:t.vertical||"Other",items:[t],worst:t.severity}));
  const rv=S.reveal;
  if(rv&&rv.kind==="issues"&&rv.id){const gi=groups.findIndex(g=>g.items.some(t=>t.id===rv.id));if(gi>=0){S.tablePages.issues=Math.floor(gi/GROUP_PAGE)+1;if(groups[gi].items.length>1)siOpen().add(groups[gi].key)}S.reveal=null}
  const pageGroups=pageRows("issues",groups,GROUP_PAGE);
  const top='<div class="si-tbl-top"><div><b>'+(hasF?"Matching issues":"All issues")+'</b> <span>· '+filtered.length+' ticket'+(filtered.length===1?"":"s")+(grouped&&mode==="list"?' in '+groups.length+' plant · equipment group'+(groups.length===1?"":"s"):'')+'</span></div><div class="si-tbl-tools">'+
   (mode==="list"?'<label class="si-tog"><input type="checkbox"'+(grouped?" checked":"")+' onchange="S.siGroup=this.checked;S.tablePages.issues=1;render()"/> Group similar issues</label>':'')+
   '<div class="si-seg"><button type="button" class="'+(mode==="list"?"on":"")+'" onclick="siView(\'list\')">☰ List</button><button type="button" class="'+(mode==="sites"?"on":"")+'" onclick="siView(\'sites\')">▦ Sites</button><button type="button" class="'+(mode==="board"?"on":"")+'" onclick="siView(\'board\')">◫ Board</button></div></div></div>';
  const th=(l,k)=>'<th class="s'+(f.sort===k?" on":"")+'" onclick="siSort(\''+k+'\')">'+l+(f.sort===k?" ↓":"")+'</th>';
  /* the Sites matrix uses its own id so the batch-checkbox injector (which targets #section-results table) leaves it alone */
  let tb='<div id="'+(mode==="sites"?"section-results-sites":"section-results")+'" class="si-tbl">'+top;
  if(mode==="board"&&typeof m26Board==="function"){tb+='<div style="padding:0 12px 12px">'+m26Board()+'</div>'}
  else if(mode==="sites"){tb+=siSitesMatrix(filtered)}
  else{
   tb+='<div class="si-scroll" role="region" aria-label="Site issues table, scroll sideways to see all columns" tabindex="0"><table class="si-t si-register dense"><thead><tr><th class="si-h-id">Issue ID</th><th class="si-h-eq">Equipment</th><th class="si-h-sub">Subpart</th><th class="si-h-ref">Subpart / unit ID</th><th class="si-h-problem">Problem</th><th class="si-h-plant">Plant code</th><th class="si-h-company">Supplier / maker</th><th class="si-h-owner">Assigned to</th><th class="si-h-status">Status</th><th class="si-h-action">Action</th></tr></thead><tbody>';
   if(!pageGroups.length)tb+='<tr><td colspan="10"><div class="si-empty"><div class="ico">'+(all.length?"⌕":"✓")+'</div><b>'+(all.length?"No issues match these filters":"No issues raised yet")+'</b><p>'+(all.length?"Try removing a filter or searching with different words.":"When a fault is reported at a plant it will appear here, ranked by priority.")+'</p>'+(all.length&&hasF?'<button class="btn o sm" onclick="S.issF=blankIssF();S.tablePages.issues=1;render()">Clear all filters</button>':'<button class="btn p sm" onclick="openModal(\'newTicket\')">'+I.plus(12)+' Raise Issue</button>')+'</div></td></tr>';
   pageGroups.forEach(g=>{
    if(g.items.length===1){tb+=siRow(g.items[0],"");return}
    const open=siOpen().has(g.key);tb+=siGroupRow(g,open);
    if(open)g.items.forEach(t=>{tb+=siRow(t," si-child")});
   });
   tb+='</tbody></table></div>'+tablePager("issues",groups.length,GROUP_PAGE)}
  h+=tb+'</div>';

  /* ---- priority chart (by equipment or by plant) + trend ---- */
  const chartBy=S.siChartBy||"equipment";
  let chartHtml="";
  if(S.siTrend!==false){
   if(chartBy==="trend"){
    const days=S.trendDays||10,trendEnd=f.to||TODAY,trendStart=f.from||addDays(trendEnd,-days+1);
    try{chartHtml='<div class="si-seg si-seg-sub">'+[[3,"3d"],[10,"10d"],[14,"2w"],[21,"3w"],[30,"Month"]].map(([n,l])=>'<button type="button" class="'+(days===n?"on":"")+'" onclick="setTrendDays('+n+')">'+l+'</button>').join("")+'</div>'+issueSpark(issueTrendRows(days,filterIssues(all,Object.assign({},f,{from:"",to:""})),trendStart,trendEnd));}
    catch(error){console.error("Solar91: issue trend failed independently of register",error);chartHtml='<div class="si-empty" role="alert"><b>Trend chart unavailable</b><p>Issues are still available. Change the date range or refresh to retry.</p></div>'}
   }else chartHtml=siPriorityChart(filterIssues(all,Object.assign({},f,{sev:"all"})),chartBy,f);
  }
  h+='<div class="si-trend"><div class="si-trend-h"><div><h3>'+(chartBy==="trend"?"Issue trend":"Issues by priority")+'</h3><span class="si-sub">'+(chartBy==="trend"?"Created, resolved and open backlog":(S.siChartScope==="all"?"Critical, Medium and Solved tickets (all statuses)":"Critical and Medium open tickets")+" per "+(chartBy==="plant"?"plant":"equipment type")+" · click a bar to filter")+'</span></div><div class="si-trend-tools">'+
   (chartBy!=="trend"?'<div class="si-seg"><button type="button" class="'+(S.siChartScope!=="all"?"on":"")+'" onclick="S.siChartScope=\'open\';render()">Open</button><button type="button" class="'+(S.siChartScope==="all"?"on":"")+'" onclick="S.siChartScope=\'all\';render()">All</button></div>':'')+
   '<div class="si-seg">'+[["equipment","By equipment"],["plant","By plant"],["trend","Trend"]].map(([k,l])=>'<button type="button" class="'+(chartBy===k?"on":"")+'" onclick="S.siChartBy=\''+k+'\';S.siTrend=true;render()">'+l+'</button>').join("")+
   '<button type="button" onclick="siTrend()">'+(S.siTrend===false?"Show":"Hide")+'</button></div></div></div>'+chartHtml+'</div>';
  return '<div class="m26 m26-issues si">'+h+'</div>';
 };
})();
