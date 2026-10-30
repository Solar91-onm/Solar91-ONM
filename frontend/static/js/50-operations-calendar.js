"use strict";
/* Solar91 Operations Calendar. The API is authoritative for every plant and record.
   No duplicate plant selector, record store, editing workflow or persistent details pane. */
(function(){
 const KINDS={issue:"Site Issues",washing:"Washing",pm:"Preventive Maintenance"};
 // Day cells show one chip per activity type; each type keeps one colour everywhere in the calendar.
 const SHORT={issue:["Site issue","Site issues"],washing:["Washing","Washing"],pm:["PM","PM"]};
 const h=v=>String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
 const parse=s=>{const a=String(s||"").split("-").map(Number);return new Date(a[0],a[1]-1,a[2],12)};
 const add=(s,n)=>{const d=parse(s);d.setDate(d.getDate()+n);return iso(d)};
 const first=s=>s.slice(0,7)+"-01";
 const monday=s=>add(s,-((parse(s).getDay()+6)%7));
 const fmt=(s,opts)=>s?parse(s).toLocaleDateString("en-IN",opts||{day:"numeric",month:"short",year:"numeric"}):"—";
 const today=()=>typeof s91BusinessDate==="function"?s91BusinessDate():iso(new Date());
 const init=today();
 const C={date:init,view:"month",selected:init,filters:{from:"",to:"",type:"",equipment:"",subpart:"",engineer:"",assignee:"",severity:"",status:"",q:""},events:[],days:{},dayCache:new Map(),loadedKey:"",pendingKey:"",error:"",hasMore:false,loadingMore:false,requestNo:0,detailNo:0,scope:"",options:{},overlay:null,photos:[],typing:null};
 window.S91OperationsCalendar=C;
 const active=()=>typeof S!=="undefined"&&S.view==="om-module"&&S.omTab==="calendar";
 const scope=()=>{
   if((S._roleLabel||S.currentRole)==="Site Engineer")return (S.plants||[]).find(p=>p.name===S._sePlant||p.id===S._sePlant)||null;
   return (S.plants||[]).find(p=>p.name===S.dashPlant||p.id===S.dashPlant)||null;
 };
 const viewDates=()=>{
   if(C.view==="day")return [C.date,C.date];
   if(C.view==="week"){const a=monday(C.date);return [a,add(a,6)];}
   const a=first(C.date),d=parse(a),last=iso(new Date(d.getFullYear(),d.getMonth()+1,0,12));
   return [add(a,-d.getDay()),add(last,6-parse(last).getDay())];
 };
 const query=()=>{
   const [baseStart,baseEnd]=viewDates(),f=C.filters,p=scope();
   const start=f.from&&f.from>baseStart?f.from:baseStart,end=f.to&&f.to<baseEnd?f.to:baseEnd;
   const q=new URLSearchParams({start,end,limit:"1500"});
   if(p)q.set("plant_id",p.dbId||p.db_id||p.id);
   [["activity_type",f.type],["equipment",f.equipment],["subpart",f.subpart],["engineer",f.engineer],["assignee",f.assignee],["severity",f.severity],["status",f.status],["q",f.q]].forEach(([k,v])=>{if(v)q.set(k,v)});
   return start>end?null:q.toString();
 };
 // A day's records for the popup: same filters, one date. Month and week grids only load per-day counts.
 const listQuery=day=>{const q=new URLSearchParams(query()||"");q.set("start",day);q.set("end",day);return q.toString()};
 const DAY_CACHE_MS=60000,DAY_CACHE_MAX=60;
 const cached=key=>{const hit=C.dayCache.get(key);if(hit&&Date.now()-hit.at<DAY_CACHE_MS)return hit;if(hit)C.dayCache.delete(key);return null};
 const remember=(key,data)=>{C.dayCache.delete(key);C.dayCache.set(key,{at:Date.now(),events:data.events||[],hasMore:!!data.has_more});
   while(C.dayCache.size>DAY_CACHE_MAX)C.dayCache.delete(C.dayCache.keys().next().value)};
 const findEvent=key=>C.events.find(e=>e.key===key)||[...C.dayCache.values()].reduce((hit,c)=>hit||c.events.find(e=>e.key===key),null);
 const dayCounts=day=>C.days[day]||{};
 const countTotal=c=>(c.issue||0)+(c.pm||0)+(c.washing||0);
 const opts=(field,label)=>{
   const f=C.filters, values=new Set((C.options[field]||[]).filter(Boolean));if(field==="status"){["Overdue","Missed","Upcoming","In progress","Completed","Pending","Confirmed","Open","Resolved","In Progress","Scheduled"].forEach(v=>values.add(v))}if(f[field])values.add(f[field]);
   return '<label class="oc-field"><span>'+label+'</span><select data-oc-filter="'+field+'" aria-label="'+label+'"><option value="">All</option>'+[...values].sort((a,b)=>a.localeCompare(b)).map(x=>'<option value="'+h(x)+'"'+(f[field]===x?' selected':'')+'>'+h(x)+'</option>').join('')+'</select></label>';
 };
 const FACETS=["equipment","subpart","engineer","assignee","status","severity"];
 function mergeOptions(lists){
   for(const f of FACETS){const out=new Set(C.options[f]||[]);for(const v of lists[f]||[])if(v)out.add(v);C.options[f]=[...out].sort((a,b)=>a.localeCompare(b)).slice(0,150)}
 }
 function facets(events){const lists={};for(const f of FACETS)lists[f]=events.map(e=>e[f]);mergeOptions(lists)}
 const typeFilter=()=>'<label class="oc-field"><span>Activity</span><select data-oc-filter="type"><option value="">All activities</option>'+Object.entries(KINDS).map(([id,label])=>'<option value="'+id+'"'+(C.filters.type===id?' selected':'')+'>'+h(label)+'</option>').join('')+'</select></label>';
 const ICON={
   prev:'<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
   next:'<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
   caret:'<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
   search:'<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
   filter:'<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
   photo:'<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="1.7" fill="currentColor"/><path d="M4 17l5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
 };
 // Colour shows the activity type; each record's status is written on the record itself.
 const legends=()=>Object.entries(KINDS).map(([kind,name])=>'<span><i class="oc-key oc-k-'+kind+'"></i>'+h(name)+'</span>').join('')+'<span><i class="oc-key oc-done"></i>Resolved / completed that day</span><span class="oc-legend-note">Open issues and overdue work repeat on each day until solved</span>';
 // Plant filter drives the portal's shared plant scope (setPlantScope), so every module stays on the same plant.
 const plantPicker=()=>{
   const locked=(S._roleLabel||S.currentRole)==="Site Engineer",cur=scope(),code=v=>typeof displayCode==="function"?displayCode(v):String(v||"");
   const list=[...(S.plants||[])].sort((a,b)=>String(a.id||"").localeCompare(String(b.id||""),undefined,{numeric:true}));
   return '<label class="oc-plant"><span class="oc-plant-label">Plant</span><select data-oc-plant aria-label="Filter by plant"'+(locked?' disabled':'')+'><option value="all"'+(cur?'':' selected')+'>All authorised plants</option>'+list.map(p=>'<option value="'+h(p.name)+'"'+(cur&&cur.name===p.name?' selected':'')+'>'+h((code(p.id)||p.site_code||'—')+' · '+p.name)+'</option>').join('')+'</select></label>';
 };
 function renderOperationsCalendar(){
   if(!C.scope||C.scope!==String((scope()||{}).dbId||S.dashPlant||"all")){
     C.scope=String((scope()||{}).dbId||S.dashPlant||"all");C.loadedKey="";C.options={};C.days={};C.dayCache.clear();hideOverlay();
   }
   const q=query();
   const qkey=q||"empty";
   if(qkey!==C.loadedKey&&qkey!==C.pendingKey){C.pendingKey=qkey;queueMicrotask(()=>refresh());}
   const [start,end]=viewDates(),loading=!!C.pendingKey&&C.pendingKey!==C.loadedKey;
   const now=today(),headline=C.view==="month"?fmt(C.date,{month:"long",year:"numeric"}):C.view==="week"?fmt(start)+" – "+fmt(end):fmt(C.date,{weekday:"long",day:"numeric",month:"long",year:"numeric"});
   const filterCount=Object.values(C.filters).filter(Boolean).length,total=C.view==="day"?C.events.length:Object.values(C.days).reduce((n,c)=>n+countTotal(c),0);
   return '<section id="oc" class="oc" aria-label="Operations Calendar">'+
      '<header class="oc-head"><div><h1>Operations Calendar</h1><p>View and inspect site issues, preventive maintenance and washing activities across your plants.</p></div><span class="oc-scope">'+h(scope()?scope().name:"All authorised plants")+'</span></header>'+
      '<div class="oc-controls"><div class="oc-nav"><div class="oc-step"><button type="button" data-oc="prev" aria-label="Previous period">'+ICON.prev+'</button><button type="button" data-oc="today">Today</button><button type="button" data-oc="next" aria-label="Next period">'+ICON.next+'</button></div><strong>'+h(headline)+'</strong></div><div class="oc-views" role="group" aria-label="Calendar view">'+['month','week','day'].map(v=>'<button type="button" class="'+(C.view===v?'selected':'')+'" data-oc-view="'+v+'" aria-pressed="'+(C.view===v)+'">'+v[0].toUpperCase()+v.slice(1)+'</button>').join('')+'</div></div>'+
      '<div class="oc-filter-top"><label class="oc-search"><span aria-hidden="true">'+ICON.search+'</span><input type="search" id="oc-search" aria-label="Search activities" placeholder="Search issues, equipment, people…" value="'+h(C.filters.q)+'" maxlength="160" data-oc-search enterkeyhint="search"></label>'+plantPicker()+'<button type="button" class="oc-toggle'+(filterCount?' on':'')+'" data-oc="toggleFilters" aria-expanded="'+!!C.filtersOpen+'">'+ICON.filter+'<span>Filters</span>'+(filterCount?'<b>'+filterCount+'</b>':'')+'</button><div class="oc-presets">'+[['thisMonth','This month'],['thisWeek','This week'],['next30','Next 30 days'],['clear','Reset']].map(([id,t])=>'<button type="button" data-oc-preset="'+id+'">'+t+'</button>').join('')+'</div></div>'+
      (C.filtersOpen?'<div class="oc-filters">'+typeFilter()+opts("equipment","Equipment")+opts("subpart","Subpart")+opts("engineer","Site engineer")+opts("assignee","Assignee")+opts("severity","Severity")+opts("status","Status")+'<label class="oc-field"><span>From</span><input type="date" data-oc-filter="from" value="'+h(C.filters.from)+'"></label><label class="oc-field"><span>To</span><input type="date" data-oc-filter="to" value="'+h(C.filters.to)+'"></label><button type="button" data-oc="clearFilters">Clear filters</button></div>':'')+
      '<div class="oc-legend" aria-label="Event colour key">'+legends()+'</div>'+
      '<div class="oc-status" role="status" aria-live="polite">'+(loading?'Loading activities…':C.error?'<span class="oc-error">'+h(C.error)+' <button data-oc="retry">Retry</button></span>':C.hasMore?C.events.length+' activities loaded; more records available. <button type="button" data-oc="loadMore">'+(C.loadingMore?'Loading…':'Load more')+'</button>':total?total+' activities in the selected period.':'No matching activities in this period.')+'</div>'+
      (C.view==="day"?dayView(C.date):calendarGrid(start,end,now))+'</section>';
 }
 function badge(e){let label=e.kind==="issue"?"ISS":e.kind==="pm"?"PM":"WASH";return '<b class="oc-category">'+label+'</b>'}
 const cardTitle=e=>e.kind==="issue"?(e.severity?e.severity+' · ':'')+(e.equipment||e.title):e.kind==="pm"?e.equipment+(e.unit?' '+e.unit:'')+': '+e.title:e.title+(Number.isFinite(e.tables_cleaned)?' · '+e.tables_cleaned:'');
 // Open issues and overdue PM / washing repeat on every day from their date (e.date) to e.until; solved work ends
 // on e.until, where it shows green. Older API rows without `until` behave as single-day records.
 const lastDay=e=>e.until||e.date;
 const activeOn=(e,day)=>e.date<=day&&day<=lastDay(e);
 const doneOn=(e,day)=>!!e.done&&day===lastDay(e);
 const daysBetween=(a,b)=>Math.round((parse(b)-parse(a))/864e5);
 const DONE_WORD={issue:"Resolved",pm:"Completed",washing:"Completed"};
 function dayState(e,day){
   if(!day)return null;
   if(doneOn(e,day))return {cls:"ok",text:DONE_WORD[e.kind],tip:DONE_WORD[e.kind]+" on "+fmt(day)};
   if(day>e.date){const n=daysBetween(e.date,day),since=fmt(e.date);
     return e.kind==="issue"?{cls:"late",text:"Open "+n+"d",tip:"Open since "+since}:{cls:"late",text:"Overdue "+n+"d",tip:"Due "+since+", not completed"}}
   return null;
 }
 function card(e,compact,day){
   const title=cardTitle(e),st=dayState(e,day);
   return '<button type="button" class="oc-event oc-k-'+h(e.kind)+(st&&st.cls==="ok"?' is-done':'')+'" data-oc-event="'+h(e.key)+'" title="'+h(e.reference+' · '+title+' · '+e.status+(st?' · '+st.tip:''))+'">'+badge(e)+'<span>'+h(title||e.title||e.reference)+'</span>'+(compact?'':'<small>'+h(e.plant)+(e.status?' · '+h(e.status):'')+'</small>')+(st?'<em class="oc-state '+st.cls+'">'+h(st.text)+'</em>':'')+'</button>';
 }
 const haystack=(e,day)=>{const st=dayState(e,day);return [e.reference,cardTitle(e),e.plant,e.site_code,e.status,e.severity,e.assignee,e.equipment,e.subpart,st&&st.text,st&&st.cls==="late"?(e.kind==="issue"?"open":"overdue"):""].filter(Boolean).join(' ').toLowerCase()};
 // Within a type: outstanding work first (oldest first), work solved that day last.
 const byKind=(entries,day)=>Object.keys(KINDS).map(kind=>[kind,entries.filter(e=>e.kind===kind).sort((a,b)=>(doneOn(a,day)-doneOn(b,day))||a.date.localeCompare(b.date))]);
 const localSearch=label=>'<label class="oc-search oc-local"><span aria-hidden="true">'+ICON.search+'</span><input type="search" data-oc-local aria-label="'+h(label)+'" placeholder="Search plant, reference, status…" maxlength="120" enterkeyhint="search"></label>';
 // One dropdown per activity type; the count updates as the local search narrows the rows.
 function kindSection(kind,list,open,listClass,day){
   const solved=list.filter(e=>doneOn(e,day)).length;
   return '<details class="oc-sec oc-k-'+kind+'" data-oc-sec'+(open&&list.length?' open':'')+'><summary><i class="oc-key"></i><b>'+h(KINDS[kind])+'</b>'+(solved?'<em class="oc-done-n" title="'+solved+' '+h(DONE_WORD[kind].toLowerCase())+' on this day">✓ '+solved+'</em>':'')+'<span class="oc-n" data-oc-n>'+list.length+'</span>'+ICON.caret+'</summary><div class="'+listClass+'">'+
     (list.length?list.map(e=>eventRow(e,day)).join('')+'<p class="oc-empty oc-nomatch" hidden>No matching entries.</p>':'<p class="oc-empty">No '+h(KINDS[kind].toLowerCase())+' for this date.</p>')+'</div></details>';
 }
 function localFilter(input){
   const box=input.closest('[data-oc-list]');if(!box)return;
   const q=input.value.trim().toLowerCase();
   box.querySelectorAll('[data-oc-sec]').forEach(sec=>{
     const rows=sec.querySelectorAll('[data-oc-text]');let shown=0;
     rows.forEach(r=>{const ok=!q||r.dataset.ocText.includes(q);r.hidden=!ok;if(ok)shown++});
     const n=sec.querySelector('[data-oc-n]');if(n)n.textContent=q?shown+' / '+rows.length:String(rows.length);
     const none=sec.querySelector('.oc-nomatch');if(none)none.hidden=!(q&&rows.length&&!shown);
     if(q&&shown)sec.open=true;
   });
 }
 function calendarGrid(start,end,now){
   const days=[];for(let day=start;day<=end;day=add(day,1))days.push(day);
   const headers=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(w=>'<div class="oc-weekday">'+w+'</div>').join('');
   return '<div class="oc-scroll"><div class="oc-grid oc-'+C.view+'">'+headers+days.map(day=>{
     const counts=dayCounts(day),n=countTotal(counts),outside=C.view==="month"&&day.slice(0,7)!==C.date.slice(0,7),groups=Object.keys(KINDS).filter(k=>counts[k]).map(k=>[k,counts[k]]);
     return '<div class="oc-cell'+(outside?' outside':'')+(day===now?' current':'')+(day===C.selected?' picked':'')+'" data-oc-day="'+day+'" tabindex="0" role="button" aria-label="View '+fmt(day)+' activities"><div class="oc-day-head"><button type="button" data-oc-summary="'+day+'" aria-label="View activities for '+fmt(day)+'">'+(C.view==="week"?fmt(day,{weekday:"short",day:"numeric",month:"short"}):Number(day.slice(8)))+'</button>'+(n?'<span class="oc-count">'+n+'</span>':'')+'</div><div class="oc-cards">'+groups.map(([kind,count])=>{const label=SHORT[kind][count===1?0:1],solved=counts[kind+"_done"]||0;
         return '<button type="button" class="oc-group oc-k-'+kind+'" data-oc-group="'+kind+'" data-oc-group-day="'+day+'" aria-haspopup="dialog" title="'+h(count+' '+KINDS[kind].toLowerCase()+' on '+fmt(day)+(solved?' · '+solved+' '+DONE_WORD[kind].toLowerCase()+' that day':''))+'">'+(solved?'<em class="oc-done-n">✓'+solved+'</em>':'')+'<b>'+count+'</b><span>'+h(label)+'</span>'+ICON.caret+'</button>'}).join('')+'</div>'+
       // Phone month grid: one coloured dot per activity type; tapping the day opens its summary sheet.
       (groups.length?'<div class="oc-dots" aria-hidden="true">'+groups.map(([kind])=>'<i class="oc-k-'+kind+'"></i>').join('')+'</div>':'')+'</div>';
   }).join('')+'</div></div>';
 }
 function dayView(day){const entries=C.events.filter(e=>activeOn(e,day));
   return '<div class="oc-day-view" data-oc-list><div class="oc-day-title">'+h(fmt(day,{weekday:"long",day:"numeric",month:"long",year:"numeric"}))+'<span>'+entries.length+' activities</span></div>'+localSearch('Search this date')+
     byKind(entries,day).map(([kind,list])=>kindSection(kind,list,true,'oc-day-list',day)).join('')+'</div>';
 }
 async function refresh(){
   if(!active())return;
   const q=query(),key=q||"empty",token=++C.requestNo;
   C.pendingKey=key;C.error="";
   if(!q){C.events=[];C.days={};C.loadedKey=key;C.pendingKey="";render();return}
   const daily=C.view==="day";
   try{
     if(daily){
       const data=cached(q)||await apiFetch("/api/operations-calendar?"+q).then(d=>{remember(q,d);return cached(q)});
       if(token!==C.requestNo||!active()||key!==(query()||"empty"))return;
       C.events=data.events.slice();C.hasMore=data.hasMore;C.days={};facets(C.events);
     }else{
       // Month and week: counts per day only; a day's records load when it is opened.
       const sq=new URLSearchParams(q);sq.delete("limit");
       const data=await apiFetch("/api/operations-calendar/summary?"+sq);
       if(token!==C.requestNo||!active()||key!==(query()||"empty"))return;
       C.days=data.days||{};C.events=[];C.hasMore=false;C.dayCache.clear();mergeOptions(data.facets||{});
     }
     C.loadedKey=key;C.pendingKey="";render();
   }catch(error){if(token!==C.requestNo||!active())return;C.events=[];C.days={};C.pendingKey="";C.loadedKey=key;C.error=error.message||"Calendar could not load";render()}
 }
 async function loadMore(){
   if(!active()||!C.hasMore||C.loadingMore)return;
   const current=query();if(!current)return;
   const token=++C.requestNo, offset=C.events.length;
   C.loadingMore=true;render();
   try{
     const q=new URLSearchParams(current);q.set("offset",String(offset));
     const data=await apiFetch('/api/operations-calendar?'+q);
     if(token!==C.requestNo||!active()||current!==query())return;
     const known=new Set(C.events.map(e=>e.key));
     for(const record of data.events||[])if(!known.has(record.key)){C.events.push(record);known.add(record.key)}
     C.events.sort((a,b)=>a.date.localeCompare(b.date)||a.kind.localeCompare(b.kind)||a.key.localeCompare(b.key));
     C.hasMore=!!data.has_more;facets(C.events);
   }catch(error){if(token===C.requestNo)C.error=error.message||"Cannot load more records"}
   finally{if(token===C.requestNo){C.loadingMore=false;render()}}
 }
 function update(){C.loadedKey="";C.pendingKey="";C.error="";C.hasMore=false;C.loadingMore=false;C.requestNo++;hideOverlay();render()}
 function setFilter(field,value){C.filters[field]=value||"";update()}
 function move(dir){
   if(C.view==="day")C.date=add(C.date,dir);
   else if(C.view==="week")C.date=add(C.date,dir*7);
   else {const d=parse(first(C.date));d.setMonth(d.getMonth()+dir);C.date=iso(d)}
   C.selected=C.date;update();
 }
 function preset(which){
   const t=today(),m=first(t);
   if(which==="clear"){C.filters={from:"",to:"",type:"",equipment:"",subpart:"",engineer:"",assignee:"",severity:"",status:"",q:""}}
   else if(which==="thisWeek"){C.filters.from=monday(t);C.filters.to=add(C.filters.from,6);C.date=t;C.view="week"}
   else if(which==="thisMonth"){C.filters.from=m;C.filters.to=iso(new Date(parse(m).getFullYear(),parse(m).getMonth()+1,0,12));C.date=t;C.view="month"}
   else if(which==="next30"){C.filters.from=t;C.filters.to=add(t,29);C.date=t;C.view="month"}
   update();
 }
 function hideOverlay(){
   if(C.overlay){C.overlay.remove();C.overlay=null}if(C.scrim){C.scrim.remove();C.scrim=null}for(const url of C.photos){try{URL.revokeObjectURL(url)}catch(_){}}C.photos=[];C.detailNo++;
 }
 function place(pop,anchor){
   const r=(anchor&&anchor.isConnected?anchor.getBoundingClientRect():{left:innerWidth/2-15,right:innerWidth/2+15,top:innerHeight/2,bottom:innerHeight/2,width:30});
   const w=pop.offsetWidth,hg=pop.offsetHeight,pad=10;
   let left=r.right+12;
   if(left+w>innerWidth-pad)left=r.left-w-12;
   if(left<pad)left=Math.min(innerWidth-w-pad,Math.max(pad,r.left));
   let top=r.top-16;if(top+hg>innerHeight-pad)top=innerHeight-hg-pad;if(top<pad)top=pad;
   Object.assign(pop.style,{left:Math.max(pad,left)+"px",top:Math.max(pad,top)+"px"});
 }
 function popover(anchor,title,inner,cls){
   hideOverlay();
   // Shown only on phones (CSS), where the popup becomes a bottom sheet; tapping it closes the sheet.
   const scrim=document.createElement('div');scrim.className="oc-scrim";document.body.appendChild(scrim);C.scrim=scrim;
   const el=document.createElement('div');el.className="oc-pop"+(cls?" "+cls:"");el.role="dialog";el.setAttribute("aria-label",title);
   el.innerHTML='<div class="oc-pop-head"><b>'+h(title)+'</b><button type="button" class="oc-close" aria-label="Close popup" data-oc="close">×</button></div><div class="oc-pop-body">'+inner+'</div>';
   document.body.appendChild(el);C.overlay=el;place(el,anchor);el.querySelector('.oc-close').focus({preventScroll:true});return el;
 }
 function eventRow(e,day){return '<div class="oc-summary-row" data-oc-text="'+h(haystack(e,day))+'">'+card(e,false,day)+'</div>'}
 function summary(day,anchor,openKind){
   C.selected=day;
   document.querySelectorAll("#oc .oc-cell.picked").forEach(el=>el.classList.remove("picked"));
   const picked=document.querySelector("#oc [data-oc-day=\""+day+"\"]");if(picked)picked.classList.add("picked");
   const n=countTotal(dayCounts(day)),key=listQuery(day),hit=cached(key);
   const content=(rows,more)=>{const all=rows.filter(e=>activeOn(e,day));return '<div data-oc-list><p class="oc-pop-sub">'+fmt(day,{weekday:"long",day:"numeric",month:"long",year:"numeric"})+' · '+all.length+(all.length===1?' activity':' activities')+'</p>'+
     (all.length?localSearch('Search entries on this date')+byKind(all,day).map(([kind,list])=>kindSection(kind,list,kind===openKind,'oc-sec-list',day)).join(''):'<p class="oc-empty">No activities recorded for this date.</p>')+
     (more?'<p class="oc-pop-note">Showing the first '+all.length+'. Open the day view to load the rest.</p>':'')+'</div>'+
     '<div class="oc-pop-foot"><button data-oc-dayview="'+day+'">View all activities</button></div>'};
   if(!n||hit){const all=hit?hit.events:[];popover(anchor,'Daily summary',content(all,hit&&hit.hasMore),all.length?'oc-pop-tall':'');return}
   const pop=popover(anchor,'Daily summary','<p class="oc-loading">Loading '+n+' activities…</p>','oc-pop-tall'),token=C.detailNo;
   apiFetch('/api/operations-calendar?'+key).then(data=>{
     remember(key,data);
     if(C.detailNo!==token||C.overlay!==pop)return;
     pop.querySelector('.oc-pop-body').innerHTML=content(data.events||[],!!data.has_more);
   }).catch(error=>{
     if(C.detailNo!==token||C.overlay!==pop)return;
     pop.querySelector('.oc-pop-body').innerHTML='<p class="oc-error">Could not load activities: '+h(error.message||error)+'</p><div class="oc-pop-foot"><button type="button" data-oc-retry-day="'+day+'">Retry</button></div>';
   });
 }
 const row=(label,value)=>value!=null&&value!==""?'<div class="oc-detail-row"><dt>'+h(label)+'</dt><dd>'+h(value)+'</dd></div>':'';
 // Readable dates: timestamps in business time (IST), date-only values stay date-only.
 const when=s=>{
   if(typeof s!=="string")return s;
   if(/^\d{4}-\d{2}-\d{2}$/.test(s))return fmt(s);
   const d=/^\d{4}-\d{2}-\d{2}T/.test(s)?new Date(s):null;
   return d&&!isNaN(d)?d.toLocaleString("en-IN",{day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit",timeZone:"Asia/Kolkata"}):s;
 };
 const DATE_FIELDS=new Set(['Reported at','Due / ETC','Planned due date','Current due date','Start date','Completed on','Cycle start','Scheduled deadline','Completion date','Report date']);
 function detailMarkup(e){
   const line=(name,val)=>row(name,DATE_FIELDS.has(name)?when(val):val);
   let html='<div class="oc-detail-hero oc-k-'+h(e.kind)+'"><b>'+h(e.title)+'</b><span>'+h(e.reference||e.id)+'</span></div>'+
     '<div class="oc-badges"><span>'+h(KINDS[e.kind])+'</span><span>'+h(e.status||"Status unavailable")+'</span>'+(e.kind==="issue"&&e.severity?'<span>'+h(e.severity)+'</span>':'')+'</div>';
   html+='<dl>'+line('Plant',e.plant)+line('Site code',e.site_code)+line('Equipment',e.equipment)+line('Equipment subpart',e.kind==="issue"?e.subpart:null);
   if(e.kind==="issue")html+=line('Issue',e.description)+line('Remarks',e.remarks)+line('Reporter',e.reporter)+line('Site engineer',e.engineer)+line('Assignee',e.assignee)+line('Reported at',e.occurred_at)+line('Due / ETC',e.due_date)+line('Impact',e.impact);
   if(e.kind==="pm")html+=line('Equipment unit',e.unit)+line('Equipment reference',e.subpart)+line('Task',e.title)+line('Planned due date',e.planned_due)+line('Current due date',e.date)+line('Start date',e.start)+line('Completed on',e.completed_on)+line('Frequency',e.frequency)+line('Assignee',e.assignee)+line('Remarks',e.remarks)+line('Checklist',Array.isArray(e.steps)?e.steps.length+' checklist item(s)':null);
   if(e.kind==="washing"){
     if(e.source==="cycle")html+=line('Cycle',e.reference)+line('Cycle start',e.start_date)+line('Scheduled deadline',e.date)+line('Cycle state',e.status)+line('Reports submitted',e.reports)+line('Confirmed tables',e.confirmed)+line('Pending tables',e.pending)+line('Completion date',e.completed_on)+line('Cycle target',e.target_count)+line('Washing assignee',e.assignee)+line('Setup notes',e.remarks);
     else html+=line('Cycle',e.reference)+line('Report date',e.date)+line('Job status',e.job_status)+line('Tables cleaned',e.tables_cleaned)+line('Target tables / cycle',e.target_count)+line('Reported by',e.reported_by)+line('Reviewed by',e.reviewed_by)+line('Review note',e.review_note)+line('Remarks',e.remarks)+line('Exception',e.exception_reason);
   }
   html+='</dl>';
   if(e.evidence&&e.evidence.length)html+='<h3>Evidence</h3><div class="oc-evidence">'+e.evidence.map(x=>'<button type="button" data-oc-photo="'+h(x.url)+'" data-oc-photo-name="'+h(x.name)+'" aria-label="Show '+h(x.name)+'"><span class="oc-photo-placeholder">'+ICON.photo+'</span><small>'+h(x.name)+'</small></button>').join('')+'</div>';
   return html+'<div class="oc-pop-foot"><button type="button" class="primary" data-oc-full="'+h(e.key)+'">View full details</button>'+(e.can_edit?'<button type="button" data-oc-full="'+h(e.key)+'">Edit in module</button>':'')+'<button type="button" data-oc="close">Close</button></div>';
 }
 async function detail(key,anchor){
   const event=findEvent(key);if(!event)return;
   const pop=popover(anchor,KINDS[event.kind]||"Activity",'<p class="oc-loading">Loading record details…</p>');
   const token=C.detailNo;
   try{
     const url=event.source==='cycle'?'/api/operations-calendar/washing-cycle/'+event.id.split(':').map(encodeURIComponent).join('/'):'/api/operations-calendar/'+event.kind+'/'+encodeURIComponent(event.id);
     const e=await apiFetch(url);
     if(C.detailNo!==token||C.overlay!==pop)return;
     const body=pop.querySelector('.oc-pop-body');body.innerHTML=detailMarkup(e);place(pop,anchor);
     // Never fetch private evidence during initial calendar load. Fetch just as the popup becomes visible.
   }catch(error){if(C.detailNo!==token||C.overlay!==pop)return;pop.querySelector('.oc-pop-body').textContent='Could not load record: '+error.message;place(pop,anchor)}
 }
 // Private evidence is shown inside the popup: a blob opened in a new tab is unreliable in the installed app,
 // and window.open with noopener always returns null.
 async function photo(path,btn){
   if(!path.startsWith('/api/')||!C.overlay||btn.getAttribute('aria-busy')==='true')return;
   const pop=C.overlay,token=C.detailNo,name=btn.dataset.ocPhotoName||'Evidence photo';
   btn.setAttribute('aria-busy','true');
   try{
     const response=typeof authenticatedFetch==='function'?await authenticatedFetch(path):null;
     if(!response||!response.ok)throw Error('Photo access unavailable');
     const blob=await response.blob();
     if(token!==C.detailNo||C.overlay!==pop)return;
     const url=URL.createObjectURL(blob);C.photos.push(url);
     let fig=pop.querySelector('.oc-photo-view');
     if(!fig){fig=document.createElement('figure');fig.className='oc-photo-view';pop.querySelector('.oc-evidence').after(fig)}
     fig.innerHTML='<img alt="'+h(name)+'" src="'+url+'"><figcaption>'+h(name)+'</figcaption>';
     pop.querySelectorAll('[data-oc-photo]').forEach(b=>b.classList.toggle('selected',b===btn));
     fig.scrollIntoView({block:'nearest',behavior:'smooth'});
   }catch(error){toast('Photo unavailable: '+(error.message||error))}
   finally{btn.removeAttribute('aria-busy')}
 }
 async function full(key){
   const event=findEvent(key);if(!event)return;
   hideOverlay();
   if(event.kind==='issue'){
     let t=(S.issues||[]).find(x=>x.dbId===event.id||x.id===event.reference);
     if(!t){try{const res=await apiFetch('/api/state/collections?keys=issues');S.issues=res.state.issues||[];t=S.issues.find(x=>x.dbId===event.id||x.id===event.reference)}catch(_){}}
     if(t&&typeof openIssue==='function'){openIssue(t.id);return}
     S.issF.q=event.reference;goTab('issues');return;
   }
   if(event.kind==='pm'){
     let t=(S.tasks||[]).find(x=>x.id===event.reference);
     // Older finished work orders are outside the loaded history window: fetch just this one, not the full history.
     if(!t){try{const rows=await apiFetch('/api/scheduled/tasks?work_order='+encodeURIComponent(event.reference));t=rows.find(x=>x.id===event.reference);if(t)S.tasks=(S.tasks||[]).concat([t])}catch(_){}}
     S.schedF.q=event.reference;goTab('scheduled');if(t&&typeof openModal==='function')openModal('taskDetail',{id:t.id});return;
   }
   if(event.kind==='washing'){
     goTab('washing');if(typeof washCyclesReload==='function')try{await washCyclesReload()}catch(_){}
     if(typeof openWashingPlantDetails==='function')openWashingPlantDetails(event.plant_id);
   }
 }
 document.addEventListener('click',e=>{
   if(C.overlay&&e.target.closest&&e.target.closest('.oc-pop')){
     const eventInSummary=e.target.closest('[data-oc-event]');if(eventInSummary){e.stopPropagation();detail(eventInSummary.dataset.ocEvent,eventInSummary);return}
     const b=e.target.closest('[data-oc]');if(b&&b.dataset.oc==='close'){hideOverlay();return}
     const retry=e.target.closest('[data-oc-retry-day]');if(retry){summary(retry.dataset.ocRetryDay,document.querySelector('#oc [data-oc-day="'+retry.dataset.ocRetryDay+'"]'));return}
     const view=e.target.closest('[data-oc-dayview]');if(view){C.date=view.dataset.ocDayview;C.view='day';hideOverlay();update();return}
     const fullEl=e.target.closest('[data-oc-full]');if(fullEl){full(fullEl.dataset.ocFull);return}
     const photoEl=e.target.closest('[data-oc-photo]');if(photoEl){photo(photoEl.dataset.ocPhoto,photoEl);return}
     return;
   }
   const root=e.target.closest&&e.target.closest('#oc');
   if(!root){if(C.overlay)hideOverlay();return}
   const ev=e.target.closest('[data-oc-event]');if(ev){e.stopPropagation();detail(ev.dataset.ocEvent,ev);return}
   const grp=e.target.closest('[data-oc-group]');if(grp){e.stopPropagation();summary(grp.dataset.ocGroupDay,grp,grp.dataset.ocGroup);return}
   const sum=e.target.closest('[data-oc-summary]');if(sum){e.stopPropagation();summary(sum.dataset.ocSummary,sum);return}
   const day=e.target.closest('[data-oc-day]');if(day){summary(day.dataset.ocDay,day);return}
   const view=e.target.closest('[data-oc-view]');if(view){C.view=view.dataset.ocView;update();return}
   const btn=e.target.closest('[data-oc]');if(btn){
     const a=btn.dataset.oc;if(a==='prev')move(-1);else if(a==='next')move(1);
     else if(a==='today'){C.date=today();C.selected=C.date;update()}
     else if(a==='toggleFilters'){C.filtersOpen=!C.filtersOpen;render()}
     else if(a==='clearFilters')preset('clear');else if(a==='loadMore')loadMore();else if(a==='retry'){C.loadedKey="";refresh()}
     return;
   }
   const pr=e.target.closest('[data-oc-preset]');if(pr)preset(pr.dataset.ocPreset);
 });
 document.addEventListener('change',e=>{
   const plant=e.target.closest&&e.target.closest('#oc [data-oc-plant]');if(plant){if(typeof setPlantScope==='function')setPlantScope(plant.value);return}
   const el=e.target.closest&&e.target.closest('#oc [data-oc-filter]');if(el)setFilter(el.dataset.ocFilter,el.value);
 });
 document.addEventListener('input',e=>{
   const local=e.target.closest&&e.target.closest('[data-oc-local]');if(local){localFilter(local);return}
   const el=e.target.closest&&e.target.closest('#oc [data-oc-search]');if(!el)return;
   C.filters.q=el.value;clearTimeout(C.typing);C.typing=setTimeout(()=>update(),320);
 });
 document.addEventListener('keydown',e=>{
   if(e.key==='Escape'&&C.overlay){e.stopPropagation();hideOverlay();return}
   if((e.key==='Enter'||e.key===' ')&&e.target.matches&&e.target.matches('#oc [data-oc-day]')){e.preventDefault();summary(e.target.dataset.ocDay,e.target)}
 });
 // Phone browsers fire resize when the address bar hides on scroll; only a real width change closes the popup.
 let lastWidth=innerWidth;
 window.addEventListener('resize',()=>{if(C.overlay&&Math.abs(innerWidth-lastWidth)>40)hideOverlay();lastWidth=innerWidth});
 window.renderOperationsCalendar=renderOperationsCalendar;
})();
