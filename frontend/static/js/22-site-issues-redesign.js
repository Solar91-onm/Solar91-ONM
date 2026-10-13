"use strict";
/* Site Issues — redesigned register. Reuses the existing data helpers (filterIssues, blankIssF, issueQuickActs, …). */
(function(){
 if(typeof renderIssues!=="function")return;
 const PRI={Critical:"#DC4C3E",High:"#D97706",Medium:"#3B82F6",Low:"#94A3B8"};
 const STC={Open:"#3B82F6",Assigned:"#6675D9","In Progress":"#0F9F8C",Resolved:"#16A34A",Closed:"#94A3B8"};
 const AGEC={"0–1 days":"#3B82F6","2–3 days":"#0F9F8C","4–7 days":"#D97706","8–14 days":"#EA7B24","15+ days":"#DC4C3E"};
 const AGES=Object.keys(AGEC);
 const STAT=["Open","Assigned","Acknowledged","In Progress","Pending Vendor","Resolved","Closed"];
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

 renderIssues=function(){
  const f=F(),all=S.issues||[],filtered=filterIssues(all,f),openAll=openTk(all),openF=openTk(filtered);
  const people=[...new Set(all.map(t=>t.assignee).filter(Boolean).concat(TEAM_POOL))].sort();
  const sites=[...new Set((S.plants||[]).map(p=>p.id))].sort(),projs=[...new Set((S.plants||[]).map(plantProject).filter(Boolean))].sort();
  const makers=[...new Set(all.map(t=>t.maker).filter(Boolean))].sort(),equips=[...new Set(all.map(t=>t.equip).filter(Boolean))].sort();
  const advKeys=["site","project","maker","equip","vert","aging"];
  const advCount=advKeys.filter(k=>f[k]&&f[k]!=="all").length+(f.from?1:0)+(f.to?1:0);
  const total=Math.max(1,all.length);
  const cnt={Open:openAll.length,Critical:openAll.filter(t=>t.severity==="Critical").length,Overdue:openAll.filter(isOverdueIssue).length,
   Unassigned:openAll.filter(t=>!t.assignee).length,Resolved:all.filter(t=>t.status==="Resolved"||t.status==="Closed").length,
   Aging:openAll.filter(t=>ageBucket(t)==="15+ days").length,Today:all.filter(t=>issueDay(t)===TODAY).length,Mine:all.filter(t=>t.assignee===OM_HEAD).length};

  /* ---- header ---- */
  let h='<div class="si-head"><div><div class="kpi-label">SOLAR OPERATIONS · LIVE REGISTER</div><h1>Site Issues</h1><p>Prioritize field faults, assign ownership, and track resolution across your plants.</p></div>'+
   '<div class="si-head-r"><div class="si-live"><i></i><div><b>'+openF.length+' open</b><small>'+filtered.length+' of '+all.length+' in view</small></div></div>'+
   (typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role==="O&M Head"?'<button class="btn o sm" onclick="s91OpenDeletedTickets()" title="Restore tickets removed by mistake">Deleted tickets</button>':'')+
   '<button class="btn p oi-raise-button" onclick="openModal(\'newTicket\')">'+I.plus(14)+' Raise Issue</button></div></div>';

  /* ---- LAYER 1 · search + quick views (always visible, light) ---- */
  const sel=(k,list,allLabel)=>'<select class="si-sel'+(f[k]!=="all"?" on":"")+'" aria-label="'+k+'" onchange="siSet({'+k+':this.value})"><option value="all">'+allLabel+'</option>'+list.map(([v,l])=>'<option value="'+esc(v)+'"'+(f[k]===v?" selected":"")+'>'+esc(l)+'</option>').join("")+'</select>';
  const fld=(t,x)=>'<label class="si-f"><span>'+t+'</span>'+x+'</label>';
  const chip=(id,l,n)=>'<button type="button" class="si-chip'+(f.chip===id?" on":"")+'" onclick="'+(id==="all"?"siSet({chip:\'all\',queue:undefined})":"siChip(\'"+id+"\')")+'">'+l+'<b>'+n+'</b></button>';
  const sugg=[...new Set(all.map(t=>t.id).concat((S.plants||[]).map(p=>p.name),makers,equips,people))].slice(0,200);
  const nTags=[f.q,f.chip!=="all",f.plant!=="all",f.sev!=="all",f.status!=="all",f.assignee!=="all",f.bucket!=="all",f.sla&&f.sla!=="all"].filter(Boolean).length+advCount;
  h+='<div class="si-bar"><div class="si-row">'+
   '<div class="si-search"><span class="ic">⌕</span><input id="si-q" list="si-sugg" autocomplete="off" aria-label="Search issues" value="'+esc(f.q)+'" placeholder="Search tickets, plants, makers, people…" oninput="siSearch(this)"/>'+
   (f.q?'<button type="button" title="Clear search" onclick="document.getElementById(\'si-q\').value=\'\';siSearch(document.getElementById(\'si-q\'))">×</button>':'<kbd>/</kbd>')+
   '<datalist id="si-sugg">'+sugg.map(x=>'<option value="'+esc(x)+'">').join("")+'</datalist></div>'+
   sel("plant",(S.plants||[]).map(p=>[p.name,p.name]),"All plants")+
   '<select class="si-sel" aria-label="Sort" onchange="siSet({sort:this.value})">'+[["etc","↕ Due soonest"],["severity","↕ Highest priority"],["age","↕ Oldest first"],["created","↕ Newest first"]].map(([v,l])=>'<option value="'+v+'"'+(f.sort===v?" selected":"")+'>'+l+'</option>').join("")+'</select>'+
   '<button type="button" class="si-more'+(S.issMore?" open":"")+(advCount||f.assignee!=="all"||f.status!=="all"?" on":"")+'" onclick="siMore()"><span>☰</span> Filters'+((advCount+(f.assignee!=="all"?1:0)+(f.status!=="all"?1:0))?' <em>'+(advCount+(f.assignee!=="all"?1:0)+(f.status!=="all"?1:0))+'</em>':'')+' <i class="car">'+I.chev(12)+'</i></button></div>'+
   '<div class="si-chips">'+chip("all","All",all.length)+chip("Open","Open",cnt.Open)+chip("Unassigned","Unassigned",cnt.Unassigned)+chip("Overdue","Overdue",cnt.Overdue)+chip("Today","Today",cnt.Today)+chip("Mine","My issues",cnt.Mine)+'</div>';
  /* ---- LAYER 2 · detailed filters (collapsed until asked, grouped by meaning) ---- */
  if(S.issMore)h+='<div class="si-panel">'+
   '<div class="si-grp"><div class="gh"><i>📍</i>Where</div>'+fld("Site code",sel("site",sites.map(x=>[x,x]),"All sites"))+fld("Project",sel("project",projs.map(x=>[x,x]),"All projects"))+'</div>'+
   '<div class="si-grp"><div class="gh"><i>⚙</i>What</div>'+fld("Issue type",sel("vert",VERTICALS.map(v=>[v,v]),"All types"))+(equips.length?fld("Equipment",sel("equip",equips.map(x=>[x,x]),"All equipment")):"")+(makers.length?fld("Maker",sel("maker",makers.map(x=>[x,x]),"All makers")):"")+'</div>'+
   '<div class="si-grp"><div class="gh"><i>👤</i>Who & stage</div>'+fld("Assignee",sel("assignee",[["Unassigned","Unassigned"]].concat(people.map(x=>[x,x])),"Anyone"))+fld("Status",sel("status",STAT.map(x=>[x,x]),"Any status"))+'</div>'+
   '<div class="si-grp"><div class="gh"><i>🗓</i>When</div>'+fld("Age of issue",sel("aging",AGES.map(x=>[x,x]),"Any age"))+'<div class="si-dates">'+fld("From",'<input type="date" value="'+esc(f.from)+'" onchange="siSet({from:this.value})"/>')+fld("To",'<input type="date" value="'+esc(f.to)+'" onchange="siSet({to:this.value})"/>')+'</div></div>'+
   '<div class="si-pfoot"><button type="button" class="si-clear" onclick="S.issF=blankIssF();S.tablePages.issues=1;render()">Reset all</button><button type="button" class="btn p sm" onclick="siMore()">Show '+filtered.length+' result'+(filtered.length===1?"":"s")+'</button></div></div>';
  /* active filter tags */
  const tags=[];const T=(l,reset)=>tags.push('<span class="si-tag">'+esc(l)+'<button type="button" title="Remove" onclick="siSet('+reset+')">×</button></span>');
  if(f.q)T("“"+f.q+"”","{q:\'\'}");
  if(f.chip!=="all")T(f.chip==="Mine"?"My issues":f.chip,"{chip:\'all\'}");
  if(f.sla&&f.sla!=="all")T({overdue:"Overdue",ontime:"On time",done:"Done"}[f.sla],"{sla:\'all\'}");
  [["plant","Plant"],["sev","Priority"],["status","Status"],["assignee","Assignee"],["bucket","Stage"],["site","Site"],["project","Project"],["maker","Maker"],["equip","Equipment"],["vert","Type"],["aging","Age"]].forEach(([k,l])=>{if(f[k]&&f[k]!=="all")T(l+": "+(k==="equip"&&typeof equipmentFilterLabel==="function"?equipmentFilterLabel(f[k]):f[k]),"{"+k+":\'all\'}")});
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
  const pI=SEV.map(x=>({l:x,n:openTk(pBase).filter(t=>t.severity===x).length,c:PRI[x]}));
  const sI=["Open","Assigned","In Progress","Resolved"].map(x=>({l:x,n:sBase.filter(t=>statusBucket(t)===x||(x==="Resolved"&&statusBucket(t)==="Closed")).length,c:STC[x]}));
  const dOpen=openTk(dBase),dOver=dOpen.filter(isOverdueIssue).length,dDone=dBase.length-dOpen.length;
  const dI=[{l:"On time",n:dOpen.length-dOver,c:"#16A34A",k:"ontime"},{l:"Overdue",n:dOver,c:"#DC4C3E",k:"overdue"},{l:"Done",n:dDone,c:"#94A3B8",k:"done"}];
  const open0=openTk(pBase).length;
  h+='<div class="si-dns">'+
   donut("Priority",pI,open0,"open",x=>f.sev===x.l,x=>"siToggle(\'sev\',\'"+q(x.l)+"\')")+
   donut("Status",sI,sBase.length,"issues",x=>f.bucket===x.l,x=>"siBucket(\'"+q(x.l)+"\')")+
   donut("Deadline",dI,dOpen.length?Math.round(100*(dOpen.length-dOver)/dOpen.length)+"%":"—","on time",x=>f.sla===x.k,x=>"siToggle(\'sla\',\'"+x.k+"\')")+'</div>';

  /* ---- triage queue ---- */
  if(scheduledAdmin()){
   const need=openAll.filter(t=>!t.assignee).sort((a,b)=>(SEV_RANK[a.severity]??9)-(SEV_RANK[b.severity]??9)||String(a.created).localeCompare(String(b.created)));
   if(need.length){const opts='<option value="">Assign to…</option>'+(typeof assigneeOptionsHtml==="function"?assigneeOptionsHtml():people.map(x=>'<option>'+esc(x)+'</option>').join(""));
    h+='<div class="si-tri"><h3>⚑ Needs an owner — '+need.length+' unassigned '+(need.filter(t=>t.severity==="Critical").length?'<span class="pill pillsm b-danger">'+need.filter(t=>t.severity==="Critical").length+' critical</span>':'')+'</h3>'+
     need.slice(0,4).map(t=>'<div class="si-tri-row" style="--c:'+(PRI[t.severity]||"#ccc")+'"><div class="m" data-act="issue" data-id="'+esc(t.id)+'"><b>'+esc(t.id)+'</b> '+badge(t.severity)+'<small>'+esc(t.plant||"—")+(t.equip&&t.equip!=="—"?" · "+esc(t.equip):"")+" · "+esc(t.vertical||"")+'</small></div>'+
      '<div class="a" onclick="event.stopPropagation()"><select class="sel" id="oi-qa-'+esc(t.id)+'">'+opts+'</select><button class="btn p sm" onclick="oiQuickAssign(\''+esc(t.id)+'\')">Assign</button></div></div>').join("")+
     (need.length>4?'<div style="margin-top:8px"><button class="btn g sm" onclick="siChip(\'Unassigned\')">+ '+(need.length-4)+' more — view all unassigned</button></div>':'')+'</div>'}
  }

  /* ---- results ---- */
  const sorted=filtered.slice().sort((a,b)=>f.sort==="created"?String(b.created).localeCompare(String(a.created)):f.sort==="severity"?(SEV_RANK[a.severity]??9)-(SEV_RANK[b.severity]??9):f.sort==="age"?issueAgeDays(b)-issueAgeDays(a):new Date(a.etc)-new Date(b.etc));
  const rows=pageRows("issues",sorted,LIST_SIZE),mode=S.issView==="board"?"board":"list";
  const top='<div class="si-tbl-top"><div><b>'+(hasF?"Matching issues":"All issues")+'</b> <span>· showing '+rows.length+' of '+filtered.length+'</span></div><div class="si-seg"><button type="button" class="'+(mode==="list"?"on":"")+'" onclick="m26IssView(\'list\')">☰ List</button><button type="button" class="'+(mode==="board"?"on":"")+'" onclick="m26IssView(\'board\')">▦ Board</button></div></div>';
  const th=(l,k)=>'<th class="s'+(f.sort===k?" on":"")+'" onclick="siSort(\''+k+'\')">'+l+(f.sort===k?" ↓":"")+'</th>';
  let tb='<div id="section-results" class="si-tbl">'+top;
  if(mode==="board"&&typeof m26Board==="function"){tb+='<div style="padding:0 12px 12px">'+m26Board()+'</div>'}
  else{
   tb+='<div class="si-scroll"><table class="si-t dense"><thead><tr><th>Issue</th><th>Plant / site</th><th>Equipment</th>'+th("Priority","severity")+th("Age","age")+'<th>Assignee</th>'+th("Status / due","etc")+'<th>Action</th></tr></thead><tbody>';
   if(!rows.length)tb+='<tr><td colspan="8"><div class="si-empty"><div class="ico">'+(all.length?"⌕":"✓")+'</div><b>'+(all.length?"No issues match these filters":"No issues raised yet")+'</b><p>'+(all.length?"Try removing a filter or searching with different words.":"When a fault is reported at a plant it will appear here, ranked by priority.")+'</p>'+(all.length&&hasF?'<button class="btn o sm" onclick="S.issF=blankIssF();S.tablePages.issues=1;render()">Clear all filters</button>':'<button class="btn p sm" onclick="openModal(\'newTicket\')">'+I.plus(12)+' Raise Issue</button>')+'</div></td></tr>';
   rows.forEach(t=>{const p=plantRec(t.plant),sla=slaState(t),age=issueAgeDays(t),ab=ageBucket(t),c=PRI[t.severity]||"#ccc";
    tb+='<tr class="si-r click'+(sla==="breach"?" od":"")+(S.flashId===t.id?" flash-new":"")+'" data-rid="'+esc(t.id)+'" data-act="issue" data-id="'+esc(t.id)+'">'+
     '<td style="--c:'+c+'"><div class="si-id">'+esc(t.id)+'<small>'+esc(t.vertical||"")+(t.sub?" · "+esc(t.sub):"")+'</small></div>'+(t.desc?'<div class="si-desc">'+esc(String(t.desc).slice(0,90))+'</div>':'')+'</td>'+
     '<td><div style="font-weight:600">'+esc(p?p.id:t.plant)+'</div><div class="si-sub">'+esc(p?p.name:"")+'</div></td>'+
     '<td>'+esc(t.equip||"—")+(t.maker?'<div class="si-sub">'+esc(t.maker)+'</div>':'')+'</td>'+
     '<td><span class="si-pri" style="--c:'+c+'"><i></i>'+esc(t.severity)+'</span></td>'+
     '<td class="si-age" style="--c:'+(AGEC[ab]||"#94A3B8")+'"><b>'+age+'d</b><div class="tr"><i style="width:'+Math.min(100,Math.round(age/15*100))+'%"></i></div></td>'+
     '<td>'+(t.assignee?'<span class="si-av"><i>'+esc(ccIni(t.assignee))+'</i>'+esc(t.assignee)+'</span>':'<span class="si-un">⚑ Unassigned</span>')+'</td>'+
     '<td>'+badge(t.status)+(sla==="breach"?" "+badge("Overdue"):"")+etcLabel(t)+'</td>'+
     '<td class="oi-action-cell"><div class="oi-row-actions">'+issueQuickActs(t)+'</div></td></tr>'});
   tb+='</tbody></table></div>'+tablePager("issues",filtered.length,LIST_SIZE)}
  h+=tb+'</div>';

  /* ---- trend (collapsible) ---- */
  const days=S.trendDays||10,trendEnd=f.to||TODAY,trendStart=f.from||addDays(trendEnd,-days+1);
  let trendHtml="";
  if(S.siTrend!==false){
   try{trendHtml=issueSpark(issueTrendRows(days,filterIssues(all,Object.assign({},f,{from:"",to:""})),trendStart,trendEnd));}
   catch(error){
    console.error("Solar91: issue trend failed independently of register",error);
    trendHtml='<div class="si-empty" role="alert"><b>Trend chart unavailable</b><p>Issues are still available. Change the date range or refresh to retry.</p></div>';
   }
  }
  h+='<div class="si-trend"><div class="si-trend-h"><div><h3>Issue trend</h3><span class="si-sub">Created, resolved and open backlog</span></div><div class="si-seg">'+
   [[3,"3d"],[10,"10d"],[14,"2w"],[21,"3w"],[30,"Month"]].map(([n,l])=>'<button type="button" class="'+(days===n?"on":"")+'" onclick="setTrendDays('+n+')">'+l+'</button>').join("")+
   '<button type="button" onclick="siTrend()">'+(S.siTrend===false?"Show":"Hide")+'</button></div></div>'+trendHtml+'</div>';
  return '<div class="m26 m26-issues si">'+h+'</div>';
 };
})();
