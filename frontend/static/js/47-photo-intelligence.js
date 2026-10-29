"use strict";
/* Photo Intelligence: authenticated operations photos, links, smart quick tags, searchable gallery. */
(function(){
 if(window.renderPhotoIntelligence)return;
 const L=window.S91PhotoLogic,svc=()=>window.S91PhotoService;
 const P=window.S91PhotoUI={q:Object.assign({},L.DEFAULT_QUERY),result:null,plants:null,loading:false,error:null,
  key:null,seq:0,showFilters:false,links:[],linksKey:"",fresh:new Set(),draft:null,layout:(()=>{try{return localStorage.getItem("s91-photo-layout")==="list"?"list":"grid"}catch(e){return "grid"}})()};
 const role=()=>S._roleLabel||S.currentRole||"O&M Head";
 const sePlant=()=>role()==="Site Engineer"?(S._sePlant||""):"";
 const readOnly=()=>role()==="Administration"||(typeof rev05ReadOnly==="function"&&rev05ReadOnly());
 /* The backend enforces plant scope regardless of these convenient UI filters. */
 const viewer=()=>sePlant()?{plants:[sePlant()]}:null;
 /* submissionId: one id per draft, sent with every attempt, so a retried upload is saved once (server replays it) */
 const newSubmissionId=()=>{try{return crypto.randomUUID()}catch(e){return ""}};
 const blankDraft=()=>({submissionId:newSubmissionId(),files:[],plant:"",category:"",description:"",tags:[],otherTags:"",linkType:"",linkId:"",issueId:"",attachTicket:false,errors:[],progress:null,busy:false,qualityAck:false});
 /* a linked ticket that this person may add photos to, with its free photo slots (tickets hold 10, see uploadIssuePhotos) */
 function ticketSlot(id){
  const t=id&&(S.issues||[]).find(x=>x.id===id);
  if(!t||!t.dbId||typeof uploadIssuePhotos!=="function"||!["O&M Head","Assignee","Site Engineer"].includes(role())||/^closed$/i.test(t.status||""))return null;
  return{t,left:Math.max(0,10-(t.evidence||[]).length)};
 }
 /* open site issues of one plant, read from the loaded register (the demo link itself is not saved) */
 const plantIssues=plant=>plant&&typeof openTk==="function"?openTk((S.issues||[]).filter(t=>t.plant===plant)).slice(0,60):[];
 P.draft=blankDraft();

 /* ---------- icons + sample-photo placeholders (no external images) ---------- */
 const ic={
  cam:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg>',
  img:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/></svg>',
  filter:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>'
 };
 const HUE={washing:200,pm:150,equipment:28,issue:4,safety:48,handover:265,other:120};
 const thumbs=new Map();
 function placeholder(cat,variant){
  const k=cat+"|"+variant;if(thumbs.has(k))return thumbs.get(k);
  const h=HUE[cat]||120,off=variant*14,rows=[0,1,2].map(i=>{const y=118+i*34+(variant%2)*6,x=-20+off+i*18;
   return '<polygon points="'+x+','+(y+26)+' '+(x+38)+','+y+' '+(x+330)+','+y+' '+(x+300)+','+(y+26)+'" fill="#24405f" stroke="#9fb4c9" stroke-width="1.2"/>'}).join("");
  const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240"><rect width="320" height="240" fill="hsl('+h+',38%,90%)"/><rect y="104" width="320" height="136" fill="hsl('+h+',22%,80%)"/>'+rows+
   '<circle cx="'+(250-off)+'" cy="52" r="20" fill="hsl(44,90%,72%)"/></svg>'; /* samples are labelled by the page and the detail view */
  const url="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg);thumbs.set(k,url);return url;
 }
 const imgOf=r=>r.previewUrl||placeholder(r.category,r.variant||0);
 const photoAttr=r=>r.source==="server"?' data-photo-id="'+esc(r.id)+'"':"";
 const altOf=r=>"Site photo: "+(r.description||L.catLabel(r.category))+" · "+r.plant;
 const ago=iso=>{const m=Math.max(0,Math.round((Date.now()-Date.parse(iso))/6e4));return m<1?"just now":m<60?m+" min ago":m<1440?Math.round(m/60)+" h ago":Math.round(m/1440)+" d ago"};
 const fmtSize=b=>b>=1048576?(b/1048576).toFixed(1)+" MB":Math.max(1,Math.round(b/1024))+" KB";

 /* ---------- data ---------- */
 function queryKey(){return JSON.stringify([P.q,sePlant(),(S.plants||[]).length])}
 /* first page (with totals, facets and day counts) whenever the filters change; further pages are appended by loadMore */
 function refresh(force){
  const key=queryKey();if(!force&&key===P.key)return;P.key=key;
  /* a newer filter supersedes the request still on its way: cancel it instead of downloading a page nobody sees */
  if(P.abort)P.abort.abort();P.abort=typeof AbortController==="function"?new AbortController():null;
  const seq=++P.seq,q=Object.assign({},P.q,{offset:0,limit:L.PAGE_SIZE,signal:P.abort&&P.abort.signal});P.loading=true;P.error=null;
  Promise.all([svc().listPhotos(q,viewer()),P.plants&&!force?Promise.resolve(P.plants):svc().getPlants(viewer())]).then(([res,plants])=>{
   if(seq!==P.seq)return;P.result=res;P.plants=plants;P.loading=false;if(S.view==="photos")render();
  }).catch(err=>{if(seq!==P.seq)return;P.loading=false;P.error=(err&&err.message)||"Photos could not load.";if(S.view==="photos")render()});
 }
 /* the next page only (rows, no totals), appended to what is loaded: earlier pages are never fetched again */
 function loadMore(after){
  const res=P.result;if(!res||P.loading||res.items.length>=res.total)return;
  const seq=P.seq,have=new Set(res.items.map(r=>r.id));P.loading=true;
  /* the server's cursor continues exactly after the last photo shown (new uploads cannot shift the page); the demo
     service has no cursor and pages by offset */
  const at=res.next_cursor?{cursor:res.next_cursor}:{offset:res.items.length};
  svc().listPhotos(Object.assign({},P.q,at,{limit:L.PAGE_SIZE,meta:false}),viewer()).then(page=>{
   if(seq!==P.seq)return;P.loading=false;
   const add=(page.items||[]).filter(r=>!have.has(r.id)),end=page.has_more===false||(page.items||[]).length<L.PAGE_SIZE;
   /* the end of the list, even if photos were deleted meanwhile */
   P.result=Object.assign({},res,{items:res.items.concat(add),next_cursor:page.next_cursor||null,total:end?res.items.length+add.length:res.total});
   if(S.view==="photos"||S.modal==="photoDetail")render();
   if(after)after();
  }).catch(err=>{if(seq!==P.seq)return;P.loading=false;toast((err&&err.message)||"More photos could not load.");if(S.view==="photos")render()});
 }
 window.s91PhotoRetry=function(){P.key=null;refresh(true)};

 /* ---------- page ---------- */
 const sel=(k,label,opts,attrs)=>'<label class="phx-field"><span>'+esc(label)+'</span><select class="inp'+(P.q[k]!==L.DEFAULT_QUERY[k]?" on":"")+'" id="phx-f-'+k+'" onchange="s91PhotoSet(\''+k+'\',this.value)"'+(attrs||"")+'>'+
  opts.map(([v,l])=>'<option value="'+esc(v)+'"'+(String(P.q[k])===String(v)?" selected":"")+'>'+esc(l)+'</option>').join("")+'</select></label>';
 function filtersHtml(res){
  const f=(res&&res.facets)||{uploaders:[],issues:[]},plants=P.plants||[],se=sePlant();
  const active=Object.keys(L.DEFAULT_QUERY).filter(k=>k!=="sort"&&k!=="window"&&P.q[k]!==L.DEFAULT_QUERY[k]&&!(k==="plant"&&se)).length;
  const win='<div class="phx-seg" role="group" aria-label="Time window">'+L.WINDOWS.map(w=>'<button type="button" class="'+(P.q.window===w.id?"on":"")+'" aria-pressed="'+(P.q.window===w.id)+'" onclick="s91PhotoSet(\'window\',\''+w.id+'\')">'+w.label.replace("Last ","")+'</button>').join("")+'</div>';
  return '<div class="phx-bar"><label class="phx-search"><span class="sr-only">Search photos</span>'+I.search(14)+'<input class="inp" id="phx-q" type="search" value="'+esc(P.q.q)+'" placeholder="Search description, tags, equipment ID" oninput="s91PhotoSet(\'q\',this.value,true)"/></label>'+win+
   '<button type="button" class="btn o sm phx-ftoggle'+(P.showFilters?" on":"")+'" aria-expanded="'+P.showFilters+'" aria-controls="phx-filters" onclick="S91PhotoUI.showFilters=!S91PhotoUI.showFilters;render()">'+ic.filter+' Filters'+(active?' <b>'+active+'</b>':'')+'</button></div>'+
   '<div class="phx-filters'+(P.showFilters?" open":"")+'" id="phx-filters">'+
   (se?'<label class="phx-field"><span>Plant</span><select class="inp" disabled><option>'+esc(se)+'</option></select></label>'
     :sel("plant","Plant",[["all","All plants ("+plants.length+")"]].concat(plants.map(p=>[p.name,p.name]))))+
   sel("category","Category",[["all","All categories"]].concat(L.CATEGORIES.map(c=>[c.id,c.label])))+
   sel("uploader","Uploaded by",[["all","Anyone"]].concat(f.uploaders.map(u=>[u,u])))+
   sel("issue","Linked record",[["all","Any"],["linked","Linked to any record"],["unlinked","Not linked"]].concat(f.issues.map(x=>[x.id,x.id+" · "+x.status])))+
   sel("link","Record type",[["all","Any record type"],["issue","Site Issue"],["pm","Preventive Maintenance"],["washing","Washing"],["inventory","Inventory"]])+
   sel("sort","Sort",[["newest","Newest first"],["oldest","Oldest first"]])+
   '<button type="button" class="btn o sm phx-reset" onclick="s91PhotoReset()"'+(active||P.q.window!=="30d"||P.q.sort!=="newest"?"":" disabled")+'>Reset filters</button></div>';
 }
 function cardsHtml(res){
  const s=res?res.summary:null,win=L.WINDOWS.find(w=>w.id===P.q.window).label.toLowerCase(),v=n=>s?n:"—";
  const card=(label,n,note,act,on)=>act?'<button type="button" class="phx-kpi'+(on?" on":"")+'" onclick="'+act+'" aria-pressed="'+!!on+'"><span>'+label+'</span><b>'+n+'</b><small>'+note+'</small></button>'
   :'<div class="phx-kpi"><span>'+label+'</span><b>'+n+'</b><small>'+note+'</small></div>';
  return '<div class="phx-kpis">'+card("Photos",v(s&&s.inWindow),esc(win)+" · matching filters")+card("Received today",v(s&&s.today),"since midnight")+
   card("Linked to work",v(s&&(s.inWindow-s.unlinked)),P.q.issue==="linked"?"showing linked · tap to clear":"tap to show linked","s91PhotoSet('issue','"+(P.q.issue==="linked"?"all":"linked")+"')",P.q.issue==="linked")+
   card("Without a record link",v(s&&s.unlinked),P.q.issue==="unlinked"?"showing these · tap to clear":"tap to show","s91PhotoSet('issue','"+(P.q.issue==="unlinked"?"all":"unlinked")+"')",P.q.issue==="unlinked")+'</div>';
 }
 /* ---------- gallery: photos grouped by day, compact tiles (or one-line rows) for 150–200 photos a day ---------- */
 let codes=null,codesN=-1;
 function codeOf(name){const n=(S.plants||[]).length;if(!codes||codesN!==n){codes=new Map((S.plants||[]).map(p=>[p.name,p.id?(typeof displayCode==="function"?displayCode(p.id):p.id):""]));codesN=n}return codes.get(name)||""}
 const timeOf=iso=>new Date(iso).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});
 function dayLabel(k){
  const today=L.dayKey(new Date().toISOString()),yest=L.dayKey(new Date(Date.now()-864e5).toISOString());
  return k===today?"Today":k===yest?"Yesterday":new Date(k+"T00:00:00").toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"});
 }
 /* a dot only when a photo still needs attention: awaiting processing or failed */
 const dot=r=>r.status==="processed"?"":'<i class="phx-dot st-'+r.status+'" title="'+esc(L.statusLabel(r.status))+'"></i>';
 const label=r=>L.catLabel(r.category)+" photo at "+r.plant+", "+timeOf(r.uploadedAt)+(r.status!=="processed"?", "+L.statusLabel(r.status):"");
 function tileHtml(r){
  const code=codeOf(r.plant);
  return '<button type="button" class="phx-tile'+(P.fresh.has(r.id)?" fresh":"")+'" onclick="s91PhotoOpen(\''+esc(r.id)+'\')" aria-label="'+esc(label(r))+'">'+
   '<img src="'+esc(imgOf(r))+'"'+photoAttr(r)+' alt="" loading="lazy" decoding="async" onerror="this.classList.add(\'noimg\')"/>'+dot(r)+(r.source==="session"?'<i class="phx-you">You</i>':'')+
   '<span class="phx-tile-meta"><b>'+esc(code||r.plant)+'</b><small>'+timeOf(r.uploadedAt)+'</small></span></button>';
 }
 function rowHtml(r){
  const code=codeOf(r.plant);
  return '<button type="button" class="phx-li'+(P.fresh.has(r.id)?" fresh":"")+'" onclick="s91PhotoOpen(\''+esc(r.id)+'\')" aria-label="'+esc(label(r))+'">'+
   '<img src="'+esc(imgOf(r))+'"'+photoAttr(r)+' alt="" loading="lazy" decoding="async" onerror="this.classList.add(\'noimg\')"/>'+
   '<span class="phx-li-main"><b>'+esc(code?code+" · "+r.plant:r.plant)+(r.source==="session"?' <i class="phx-you in">You</i>':'')+'</b>'+
   '<small>'+esc(L.catLabel(r.category))+' · '+timeOf(r.uploadedAt)+' · '+esc(r.uploader)+'</small>'+(r.description?'<small class="phx-li-desc">'+esc(r.description)+'</small>':'')+'</span>'+
   (r.issue?'<span class="phx-issue">'+esc(r.issue.id)+'</span>':'<span></span>')+dot(r)+'</button>';
 }
 function galleryHtml(res){
  const groups=[];let cur=null;
  res.items.forEach(r=>{const k=L.dayKey(r.uploadedAt);if(!cur||cur.k!==k){cur={k,rows:[]};groups.push(cur)}cur.rows.push(r)});
  const list=P.layout==="list";
  return groups.map(g=>{const n=(res.days||{})[g.k]||g.rows.length;
   return '<section class="phx-day" aria-label="'+esc(dayLabel(g.k))+'"><h3><span>'+esc(dayLabel(g.k))+'</span><small>'+n+' photo'+(n===1?"":"s")+'</small></h3><div class="'+(list?"phx-list":"phx-tiles")+'">'+g.rows.map(list?rowHtml:tileHtml).join("")+'</div></section>'}).join("")+
   (res.total>res.items.length?'<div class="phx-more" id="phx-sentinel"><button type="button" class="btn o" onclick="s91PhotoMore()">Load more <span>('+(res.total-res.items.length)+' more)</span></button></div>'
    :'<p class="phx-end">All '+res.total+' photo'+(res.total===1?"":"s")+' shown</p>');
 }
 /* the next page loads by itself when the end of the list comes into view (the button stays as a fallback) */
 let io=null;
 function watchEnd(){
  if(io){io.disconnect();io=null}
  const s=S.view==="photos"&&document.getElementById("phx-sentinel");if(!s||!("IntersectionObserver" in window))return;
  io=new IntersectionObserver(es=>{if(es.some(e=>e.isIntersecting)&&!P.loading){io.disconnect();io=null;s91PhotoMore()}},{rootMargin:"500px 0px"});io.observe(s);
 }
 window.s91PhotoLayout=function(v){P.layout=v==="list"?"list":"grid";try{localStorage.setItem("s91-photo-layout",P.layout)}catch(e){}render()};
 window.renderPhotoIntelligence=function(){
  refresh(false);
  const res=P.result,ro=readOnly(),items=res?res.items:[];
  const pick=ro?'':'<div class="phx-actions">'+
   '<label class="btn p phx-pick">'+ic.cam+' Take photo<input class="phx-file" type="file" accept="image/*" capture="environment" onchange="s91PhotoPick(this)"/></label>'+
   '<label class="btn o phx-pick">'+ic.img+' Choose photos<input class="phx-file" type="file" accept="image/*" multiple onchange="s91PhotoPick(this)"/></label></div>';
  let grid;
  if(P.error&&!res)grid='<div class="phx-state err" role="alert"><b>Photos could not load</b><span>'+esc(P.error)+'</span><button type="button" class="btn o sm" onclick="s91PhotoRetry()">Try again</button></div>';
  else if(!res)grid='<div class="phx-day"><div class="phx-tiles" aria-busy="true">'+'<span class="phx-tile sk"></span>'.repeat(18)+'</div></div>';
  else if(!items.length)grid='<div class="phx-state"><b>No photos match these filters</b><span>Try a longer time window or clear a filter.</span><button type="button" class="btn o sm" onclick="s91PhotoReset()">Reset filters</button></div>';
  else grid=galleryHtml(res);
  return '<section class="phx" aria-labelledby="phx-title">'+
   '<header class="phx-head"><div><h1 id="phx-title">O&amp;M Photo Intelligence</h1><p>'+(sePlant()?esc(sePlant())+' · ':'All authorised plants · ')+'recent photos · older photos available under All time · <button type="button" class="phx-link" onclick="window.s91AppSettings&&s91AppSettings()">Camera &amp; notifications</button></p></div>'+pick+'</header>'+
   '<div class="phx-live-note" role="note"><b>Field photo library</b> · Photos are securely saved in the portal and remain available across devices. Choose a plant and optionally link to a site issue, PM work order, washing report or inventory item.</div>'+
   cardsHtml(res)+
   '<div class="phx-panel">'+filtersHtml(res)+
    '<div class="phx-meta"><span aria-live="polite">'+(res?'<b>'+res.total+'</b> photo'+(res.total===1?"":"s")+' match'+(res.total===1?"es":"")+(res.total>items.length?' · showing '+items.length:''):'Loading photos…')+(P.loading&&res?' <span class="phx-muted">· updating…</span>':'')+'</span>'+
     '<div class="phx-seg sm" role="group" aria-label="Layout">'+[["grid","Grid"],["list","List"]].map(([v,l])=>'<button type="button" class="'+(P.layout===v?"on":"")+'" aria-pressed="'+(P.layout===v)+'" onclick="s91PhotoLayout(\''+v+'\')">'+l+'</button>').join("")+'</div></div>'+
    grid+'</div></section>';
 };

 /* ---------- filter actions ---------- */
 /* typed search waits for a 300 ms pause, so one request goes out per search rather than one per letter */
 let typed=null;
 window.s91PhotoSet=function(k,v,soon){P.q[k]=v;clearTimeout(typed);if(soon)typed=setTimeout(render,300);else render()};
 window.s91PhotoReset=function(){P.q=Object.assign({},L.DEFAULT_QUERY);render()};
 window.s91PhotoMore=function(){loadMore()};

 /* ---------- detail ---------- */
 window.s91PhotoOpen=function(id){
  const loaded=P.result&&P.result.items.find(x=>x.id===id);
  if(loaded){S.modal="photoDetail";S.modalCtx={record:loaded};render();return}
  svc().getPhotoDetails(id).then(r=>{if(!r){toast("That photo is no longer available.");return}S.modal="photoDetail";S.modalCtx={record:r};render()});
 };
 function detailModal(){
  const r=(S.modalCtx||{}).record;if(!r)return "";
  const row=(k,v)=>'<div><dt>'+k+'</dt><dd>'+v+'</dd></div>';
  const expires=r.expiresAt?Math.max(0,Math.ceil((Date.parse(r.expiresAt)-Date.now())/864e5)):null;
  const body='<div class="phx-detail"><div class="phx-big'+(r.previewUrl?"":" ph")+'"><img src="'+esc(imgOf(r))+'"'+photoAttr(r)+' alt="'+esc(altOf(r))+'" decoding="async" onerror="this.parentNode.classList.add(\'noimg\')"/></div>'+
   '<div class="phx-info">'+
   '<h4>Description</h4><p>'+(r.description?esc(r.description):'<span class="phx-muted">No description added.</span>')+'</p>'+
   '<h4>Tags</h4><p class="phx-muted">Suggested from the selected category and your remark; no unverified AI claims.</p>'+
   ((r.tags||[]).length?'<div class="phx-tags">'+r.tags.map(t=>'<span>#'+esc(t)+'</span>').join("")+'</div>':'')+
   '<dl class="phx-dl">'+row("Plant",esc(r.plant))+row("Category",esc(L.catLabel(r.category)))+row("Uploaded",esc(fmtDT(r.uploadedAt))+' <span class="phx-muted">('+ago(r.uploadedAt)+')</span>')+row("Uploaded by",esc(r.uploader))+
    row("Equipment ID",r.equipmentId?esc(r.equipmentId):'<span class="phx-muted">—</span>')+row("Linked record",r.linkType?esc(r.linkType.toUpperCase()+" · "+r.linkId):(r.issue?esc(r.issue.id):'<span class="phx-muted">General photo · no link</span>'))+
    row("Processing",'<em class="phx-st inline st-'+r.status+'">'+esc(L.statusLabel(r.status))+'</em>')+(expires===null?"":row("Expires",esc(fmtDT(r.expiresAt))+' <span class="phx-muted">(in '+expires+' days)</span>'))+
    (r.fileName?row("File",esc(r.fileName)+' · '+fmtSize(r.fileSize||0)):'')+
    (r.quality?row("Photo check",r.quality.dark?'<span class="phx-warnword">Too dark</span>':r.quality.blurry?'<span class="phx-warnword">May be blurry</span>':'Clear'):'')+row("Record",esc(r.id))+'</dl></div></div>';
  const items=(P.result&&P.result.items)||[],i=items.findIndex(x=>x.id===r.id),more=P.result&&P.result.total>items.length;
  const nav='<button class="btn o" onclick="s91PhotoStep(-1)"'+(i>0?"":" disabled")+' aria-label="Previous photo">‹ Previous</button>'+
   '<span class="phx-pos">'+(i>=0?(i+1)+' of '+(P.result?P.result.total:items.length):'')+'</span>'+
   '<button class="btn o" onclick="s91PhotoStep(1)"'+(i>=0&&(i<items.length-1||more)?"":" disabled")+' aria-label="Next photo">Next ›</button>';
  return modal(esc(L.catLabel(r.category))+' photo',esc(r.plant),body,'<div class="phx-nav">'+nav+'</div><button class="btn p" onclick="closeModal()">Close</button>',true);
 }
 /* step through the gallery from the detail view (← → keys too); past the loaded page, the next page loads first */
 window.s91PhotoStep=function(d){
  const r=(S.modalCtx||{}).record,items=(P.result&&P.result.items)||[],i=r?items.findIndex(x=>x.id===r.id):-1;if(i<0)return;
  const j=i+d;
  if(j>=0&&j<items.length){S.modalCtx={record:items[j]};render();return}
  if(j>=items.length&&P.result.total>items.length)loadMore(()=>{const n=P.result.items[j];if(n&&S.modal==="photoDetail"){S.modalCtx={record:n};render()}})
 };
 document.addEventListener("keydown",e=>{
  if(S.modal!=="photoDetail"||e.altKey||e.ctrlKey||e.metaKey)return;
  const t=e.target;if(t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))return;
  if(e.key==="ArrowRight"){e.preventDefault();s91PhotoStep(1)}else if(e.key==="ArrowLeft"){e.preventDefault();s91PhotoStep(-1)}
 });

 /* ---------- composer (phone camera / gallery) ---------- */
 const revoke=u=>{try{if(u)URL.revokeObjectURL(u)}catch(e){}};
 function discardDraft(){(P.draft.files||[]).forEach(f=>revoke(f.url));P.draft=blankDraft()}
 /* photo check on the phone: decode a small copy, measure brightness and sharpness, then repaint the form */
 async function checkQuality(entry){
  try{
   const bmp=await createImageBitmap(entry.file),s=Math.min(1,L.QUALITY.maxSide/Math.max(bmp.width,bmp.height));
   const w=Math.max(8,Math.round(bmp.width*s)),hgt=Math.max(8,Math.round(bmp.height*s)),c=document.createElement("canvas");c.width=w;c.height=hgt;
   const ctx=c.getContext("2d",{willReadFrequently:true});ctx.drawImage(bmp,0,0,w,hgt);if(bmp.close)bmp.close();
   const px=ctx.getImageData(0,0,w,hgt).data,gray=new Uint8ClampedArray(w*hgt);
   for(let i=0,j=0;j<gray.length;i+=4,j++)gray[j]=0.299*px[i]+0.587*px[i+1]+0.114*px[i+2];
   const m=L.measureGray(gray,w,hgt);entry.quality=Object.assign({checked:true},m,L.qualityFlags(m));
  }catch(e){entry.quality={checked:false}} /* e.g. HEIC on a browser that cannot decode it: no warning either way */
  if(S.modal==="photoCompose")render();
 }
 const flagged=d=>d.files.filter(f=>f.quality&&(f.quality.dark||f.quality.blurry));
 window.s91PhotoPick=function(input){
  if(readOnly())return;
  const files=input&&input.files?Array.from(input.files):[];if(input)input.value="";if(!files.length)return;
  const d=P.draft,v=L.validateFiles(files,d.files.length);
  d.qualityAck=false;
  v.accepted.forEach(f=>{const entry={file:f,url:URL.createObjectURL(f),name:f.name||"photo",size:f.size,type:f.type,quality:null};d.files.push(entry);checkQuality(entry)});
  d.errors=v.rejected;
  if(!d.plant)d.plant=sePlant()||(P.q.plant!=="all"?P.q.plant:"");
  S.modal="photoCompose";S.modalCtx={};render();
 };
 window.s91PhotoRemove=function(i){const f=P.draft.files.splice(i,1)[0];if(f)revoke(f.url);P.draft.qualityAck=false;render()};
 window.s91PhotoDraft=function(k,v){
  P.draft[k]=v;
  if(k==="description"){const c=document.getElementById("phx-desc-count");if(c)c.textContent=String(v.length)+" / "+L.MAX_DESCRIPTION}
  if(k==="plant"){P.draft.issueId="";P.draft.linkId="";P.draft.attachTicket=false;loadLinks();render()} /* the issue list belongs to the plant */
  if(k==="linkType"){P.draft.linkId="";P.draft.issueId="";P.draft.attachTicket=false;loadLinks();render()}
  if(k==="linkId"){P.draft.issueId=P.draft.linkType==="issue"?v:"";P.draft.attachTicket=false;render()}
  if(k==="category"&&!P.draft.tags.length){const guess=L.suggestTags?L.suggestTags({category:v,description:P.draft.description}):[];P.draft.tags=guess;render()}
  if(k==="issueId"){P.draft.attachTicket=false;render()} /* shows or hides "Also attach to ticket" */
 };
 function loadLinks(){
  const d=P.draft,key=d.plant+'|'+d.linkType;P.linksKey=key;P.links=[];
  if(!d.plant||!d.linkType)return;
  svc().getLinks(d.plant,d.linkType).then(items=>{if(P.linksKey===key){P.links=items;if(S.modal==="photoCompose")render()}})
   .catch(err=>{if(P.linksKey===key){P.links=[];toast((err&&err.message)||"Linked records could not load.")}});
 }
 window.s91PhotoAutoTags=function(){
  const d=P.draft;if(!d.category||d.busy)return;
  d.tags=L.cleanTags(d.tags.concat(L.suggestTags({category:d.category,description:d.description})));
  // Do not replace the entire modal during textarea blur: that would swallow the next Save click.
  document.querySelectorAll('.phx-compose .phx-chip').forEach(ch=>{const on=d.tags.includes((ch.textContent||'').trim().replace(/^#/,''));ch.classList.toggle('on',on);ch.setAttribute('aria-pressed',String(on))});
  const note=document.getElementById('phx-auto-tags');if(note)note.textContent=d.tags.length?'Suggested: '+d.tags.map(t=>'#'+t).join('  '):'';
 };
 window.s91PhotoSuggest=function(){window.s91PhotoAutoTags()};
 window.s91PhotoTag=function(t){const d=P.draft,i=d.tags.indexOf(t);if(i>=0)d.tags.splice(i,1);else d.tags.push(t);render()};
 window.s91PhotoDiscard=function(){if(P.draft.busy)return;discardDraft();S.modal=null;S.modalCtx=null;render()};
 function setProgress(p){
  P.draft.progress=p;const bar=document.getElementById("phx-progress");
  if(bar){bar.setAttribute("aria-valuenow",String(p));const i=bar.querySelector("i");if(i)i.style.width=p+"%";const t=document.getElementById("phx-progress-text");if(t)t.textContent="Saving photos… "+p+"%"}
 }
 window.s91PhotoSubmit=async function(){
  const d=P.draft;if(d.busy||readOnly())return;
  const plant=sePlant()||d.plant;
  if(!d.files.length){toast("Add at least one photo.");return}
  if(!plant){toast("Choose the plant.");return}
  if(!d.category){toast("Choose a category.");return}
  if(d.linkType&&!d.linkId){toast("Choose a linked record or select Nothing.");return}
  const weak=flagged(d);
  if(weak.length&&!d.qualityAck){d.qualityAck=true;render();toast(weak.length+" photo"+(weak.length===1?" looks":"s look")+" too dark or blurry. Retake, or tap Submit anyway.");return}
  d.busy=true;d.progress=0;render();
  try{
   const linked=d.linkType==='issue'&&d.linkId?plantIssues(plant).find(t=>t.id===d.linkId):null;
   const slot=linked&&d.attachTicket?ticketSlot(linked.id):null,files=d.files.map(f=>f.file);
   const res=await svc().createSubmission({files:d.files.map(f=>({name:f.name,size:f.size,type:f.type,previewUrl:f.url,quality:f.quality,file:f.file})),plant,category:d.category,description:d.description,
    tags:d.tags.concat(String(d.otherTags||"").split(",")),linkType:d.linkType,linkId:d.linkId,submissionId:d.submissionId,issue:linked?{id:linked.id,status:linked.status}:null,uploader:(S.currentUser||"You")+" (you)"},setProgress);
   P.fresh=new Set(res.records.map(r=>r.id));
   d.files.forEach(f=>revoke(f.url));P.draft=blankDraft(); /* saved by server; free local previews */
   S.modal=null;S.modalCtx=null;
   P.q=Object.assign({},L.DEFAULT_QUERY);P.key=null;
   refresh(true);render();
   const n=res.records.length,word=n+" photo"+(n===1?"":"s");
   if(!slot){toast(word+" saved in Photo Intelligence");return}
   /* the person chose "Also attach to ticket": a real upload through the ticket's own photo upload */
   toast(word+" saved · attaching to "+slot.t.id+"…");
   try{
    const saved=await uploadIssuePhotos(slot.t,{files:files.slice(0,slot.left)});
    slot.t.evidence=(slot.t.evidence||[]).concat(saved);slot.t.photos=slot.t.evidence.length;render();
    toast(saved.length+" photo"+(saved.length===1?"":"s")+" saved on ticket "+slot.t.id);
   }catch(e){toast("Photo saved to gallery; ticket attachment failed: "+((e&&e.message)||"server error"))}
  }catch(err){d.busy=false;d.progress=null;render();toast((err&&err.message)||"Photo submission failed.")}
 };

 function composeModal(){
  const d=P.draft,se=sePlant(),plants=P.plants||[],n=d.files.length,weak=flagged(d);
  const opts=(list,val,ph)=>'<option value="">'+ph+'</option>'+list.map(([v,l])=>'<option value="'+esc(v)+'"'+(val===v?" selected":"")+'>'+esc(l)+'</option>').join("");
  const body='<div class="phx-compose">'+
   '<div class="phx-compose-tip">Photos are saved securely and are visible to authorised team members. Add a link only when it matches an existing record.</div>'+
   '<div class="phx-actions">'+
    '<label class="btn o sm phx-pick">'+ic.cam+' Take photo<input class="phx-file" type="file" accept="image/*" capture="environment" onchange="s91PhotoPick(this)"'+(d.busy?" disabled":"")+'/></label>'+
    '<label class="btn o sm phx-pick">'+ic.img+' Choose photos<input class="phx-file" type="file" accept="image/*" multiple onchange="s91PhotoPick(this)"'+(d.busy?" disabled":"")+'/></label>'+
    '<span class="phx-count">'+n+' of '+L.MAX_FILES+' photo'+(n===1?"":"s")+' selected</span></div>'+
   (d.errors.length?'<ul class="phx-errors" role="alert">'+d.errors.map(e=>'<li><b>'+esc(e.name||"File")+'</b> · '+esc(e.reason)+'</li>').join("")+'</ul>':'')+
   (weak.length?'<div class="phx-qwarn" role="status"><b>'+weak.length+' photo'+(weak.length===1?" may be":"s may be")+' hard to read</b><span>Too dark or blurry photos rarely settle a fault. Retake '+(weak.length===1?"it":"them")+', or submit anyway.</span></div>':'')+
   (n?'<div class="phx-previews">'+d.files.map((f,i)=>{const q=f.quality,warn=q&&q.dark?"Too dark":q&&q.blurry?"May be blurry":"";
    return '<figure'+(warn?' class="weak"':'')+'><img src="'+esc(f.url)+'" alt="Selected photo '+(i+1)+': '+esc(f.name)+(warn?" ("+warn.toLowerCase()+")":"")+'" onerror="this.parentNode.classList.add(\'noimg\')"/>'+(warn?'<span class="phx-q">⚠ '+warn+'</span>':(q&&q.checked?'<span class="phx-q ok">✓ Clear</span>':''))+'<figcaption>'+esc(f.name)+' · '+fmtSize(f.size)+'</figcaption>'+
     (d.busy?'':'<button type="button" class="phx-x" aria-label="Remove photo '+(i+1)+', '+esc(f.name)+'" onclick="s91PhotoRemove('+i+')">'+I.x(14)+'</button>')+'</figure>'}).join("")+'</div>'
     :'<div class="phx-state sm"><b>No photos selected</b><span>Take a photo or choose photos from this device.</span></div>')+
   '<div class="phx-form">'+
    '<label class="phx-field"><span>Plant <i>required</i></span>'+(se?'<select class="inp" disabled><option>'+esc(se)+'</option></select>'
      :'<select class="inp" id="phx-c-plant" onchange="s91PhotoDraft(\'plant\',this.value)"'+(d.busy?" disabled":"")+'>'+opts(plants.map(p=>[p.name,p.name]),d.plant,"Choose plant…")+'</select>')+'</label>'+
    '<label class="phx-field"><span>Category <i>required</i></span><select class="inp" id="phx-c-cat" onchange="s91PhotoDraft(\'category\',this.value)"'+(d.busy?" disabled":"")+'>'+opts(L.CATEGORIES.map(c=>[c.id,c.label]),d.category,"Choose category…")+'</select></label>'+
    '<label class="phx-field"><span>Link photos to <i>optional</i></span><select class="inp" id="phx-c-linktype" onchange="s91PhotoDraft(\'linkType\',this.value)"'+(d.busy?' disabled':'')+'>'+opts([["issue","Site Issue"],["pm","Preventive Maintenance"],["washing","Washing Report"],["inventory","Inventory Item"]],d.linkType,"Nothing · general photo")+'</select></label>'+
    (d.linkType?'<label class="phx-field"><span>Choose linked record</span><select class="inp" id="phx-c-linkid" onchange="s91PhotoDraft(\'linkId\',this.value)"'+(d.busy||!P.links.length?' disabled':'')+'>'+opts(P.links.map(x=>[x.id,x.label]),d.linkId,P.links.length?"Choose record…":"No matching records found")+'</select></label>':'')+
    '<label class="phx-field wide"><span>Remark <i>optional</i></span><textarea class="inp" id="phx-c-desc" rows="3" maxlength="'+L.MAX_DESCRIPTION+'" placeholder="What does the photo show? e.g. INV-03 filter after cleaning" oninput="s91PhotoDraft(\'description\',this.value)" onblur="s91PhotoAutoTags()"'+(d.busy?" disabled":"")+'>'+esc(d.description)+'</textarea><small id="phx-desc-count">'+d.description.length+' / '+L.MAX_DESCRIPTION+'</small></label>'+
    '<div class="phx-field wide"><span id="phx-tags-lab">Smart tags <i>optional · suggested from your remark</i> <button type="button" class="btn g sm" onclick="s91PhotoSuggest()">Suggest tags</button></span><div class="phx-chips" role="group" aria-labelledby="phx-tags-lab">'+
      L.QUICK_TAGS.map(t=>'<button type="button" class="phx-chip'+(d.tags.includes(t)?" on":"")+'" aria-pressed="'+d.tags.includes(t)+'" onclick="s91PhotoTag(\''+t+'\')"'+(d.busy?" disabled":"")+'>#'+t+'</button>').join("")+'</div>'+
      '<small id="phx-auto-tags" aria-live="polite">'+(d.tags.length?'Suggested: '+d.tags.map(t=>'#'+esc(t)).join('  '):'')+'</small>'+
      '<input class="inp" id="phx-c-tags" value="'+esc(d.otherTags)+'" placeholder="Other tags, comma separated" aria-label="Other tags, comma separated" oninput="s91PhotoDraft(\'otherTags\',this.value)"'+(d.busy?" disabled":"")+'/></div></div>'+
   (d.busy?'<div class="phx-progress" id="phx-progress" role="progressbar" aria-label="Photo upload" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+(d.progress||0)+'"><i style="width:'+(d.progress||0)+'%"></i></div><p class="phx-ptext" id="phx-progress-text" aria-live="polite">Saving photos… '+(d.progress||0)+'%</p>':'')+
   '</div>';
  const foot='<button class="btn o" onclick="s91PhotoDiscard()"'+(d.busy?" disabled":"")+'>Cancel</button><button class="btn p" onclick="s91PhotoSubmit()"'+(d.busy||!n?" disabled":"")+'>'+(d.busy?"Submitting…":(weak.length&&d.qualityAck?"Submit anyway":"Save photos")+(n?" ("+n+")":""))+'</button>';
  return modal("Add site photos","Saved in your secure O&M library",body,foot,true);
 }

 /* ---------- inside a Site Issue ticket (Issue Desk): a link to the photos linked to that issue ----------
    Tickets keep their own real photo upload (POST /api/issues/{id}/evidence); this only links across. */
 window.s91PhotoForIssue=function(id){P.q=Object.assign({},L.DEFAULT_QUERY,{issue:id});S.modal=null;S.modalCtx=null;goView("photos")};
 function ticketHook(){
  if(S.modal!=="ticket")return;
  const t=(S.issues||[]).find(x=>x.id===(S.modalCtx||{}).id);
  const sec=[...document.querySelectorAll(".idk .idk-sec")].find(x=>/^Photos/.test(((x.querySelector("h4")||{}).textContent||"").trim()));
  if(!t||!sec||sec.querySelector(".phx-ticket"))return;
  const row=document.createElement("div");row.className="phx-ticket";
  row.innerHTML='<button type="button" class="btn g sm" onclick="event.stopPropagation();s91PhotoForIssue('+esc(JSON.stringify(t.id))+')">'+ic.img+' <span data-phx-n>Photo Intelligence</span> →</button>';
  sec.appendChild(row);
  svc().listPhotos(Object.assign({},L.DEFAULT_QUERY,{issue:t.id,limit:1}),viewer()).then(res=>{const n=row.querySelector("[data-phx-n]");if(n)n.textContent=res.total+" photo"+(res.total===1?"":"s")+" in Photo Intelligence"}).catch(()=>{});
 }
 /* ---------- "From photos": pick Photo Intelligence photos for a ticket message or a PM Before / After slot ----------
    o: {plant, issueId?, max, title, onPick(files)}. Demo: only photos added in this tab have a real file to attach. */
 window.s91PhotoPicker=async function(o){
  const old=document.getElementById("phx-picker");if(old)old.remove();
  if(!(o.max>0)){toast("No photo slots left here.");return}
  let res;try{res=await svc().listPhotos(Object.assign({},L.DEFAULT_QUERY,{plant:o.plant||"all",limit:240}),viewer())}catch(e){toast("Photos could not load.");return}
  const mine=res.items.filter(r=>r.source==="server").sort((a,b)=>((b.issue&&b.issue.id===o.issueId)?1:0)-((a.issue&&a.issue.id===o.issueId)?1:0));
  const picked=new Set(),el=document.createElement("div");el.id="phx-picker";el.setAttribute("role","dialog");el.setAttribute("aria-modal","true");el.setAttribute("aria-labelledby","phx-pk-title");
  const paint=()=>{
   el.innerHTML='<div class="phx-pk"><header><div><h2 id="phx-pk-title">'+esc(o.title||"Choose photos")+'</h2><small>'+esc(o.plant||"All plants")+' · from Photo Intelligence · up to '+o.max+'</small></div><button type="button" class="btn g sm" data-pk="close" aria-label="Close">'+I.x(16)+'</button></header>'+
    (mine.length?'<div class="phx-pk-grid">'+mine.map(r=>'<button type="button" class="phx-tile'+(picked.has(r.id)?" on":"")+'" data-pk-id="'+esc(r.id)+'" aria-pressed="'+picked.has(r.id)+'" aria-label="'+esc(label(r))+'"><img src="'+esc(imgOf(r))+'"'+photoAttr(r)+' alt=""/>'+(picked.has(r.id)?'<i class="phx-pk-check">✓</i>':'')+
      '<span class="phx-tile-meta"><b>'+esc(r.issue&&r.issue.id===o.issueId?"This issue":L.catLabel(r.category))+'</b><small>'+timeOf(r.uploadedAt)+'</small></span></button>').join("")+'</div>'
     :'<div class="phx-state sm"><b>No saved photos here yet</b><span>Upload a field photo in Photo Intelligence first.</span><button type="button" class="btn o sm" data-pk="open">Open Photo Intelligence</button></div>')+
    '<p class="phx-pk-note">Shows up to 240 recent photos. Selected photos will be copied into the work record.</p>'+
    '<footer><button type="button" class="btn o" data-pk="close">Cancel</button><button type="button" class="btn p" data-pk="use"'+(picked.size?"":" disabled")+'>Attach '+(picked.size||"")+' photo'+(picked.size===1?"":"s")+'</button></footer></div>';
  };
  el.addEventListener("click",async e=>{
   const b=e.target.closest("[data-pk],[data-pk-id]");if(!b){if(e.target===el)el.remove();return}
   if(b.dataset.pkId){const id=b.dataset.pkId;if(picked.has(id))picked.delete(id);else if(picked.size<o.max)picked.add(id);else toast("Up to "+o.max+" photo"+(o.max===1?"":"s")+" here.");paint();window.s91PhotoHydrate&&s91PhotoHydrate();return}
   if(b.dataset.pk==="close"){el.remove();return}
   if(b.dataset.pk==="open"){el.remove();S.modal=null;S.modalCtx=null;goView("photos");return}
   if(b.dataset.pk==="use"){try{b.disabled=true;b.textContent="Attaching…";const files=(await Promise.all([...picked].map(id=>svc().getPhotoFile(id)))).filter(Boolean);el.remove();if(files.length)o.onPick(files)}catch(err){b.disabled=false;toast((err&&err.message)||"Could not retrieve saved photo. Try again.");paint()}}
  });
  document.addEventListener("keydown",function k(e){if(e.key==="Escape"&&document.body.contains(el)){el.remove();document.removeEventListener("keydown",k)}});
  paint();document.body.appendChild(el);window.s91PhotoHydrate&&s91PhotoHydrate();
 };
 /* Issue Desk: "From photos" beside the 📎 attach; picked photos join the message and save on Send, like attached files */
 function ticketPickHook(){
  if(S.modal!=="ticket")return;
  const t=(S.issues||[]).find(x=>x.id===(S.modalCtx||{}).id),att=document.querySelector(".idk .idk-in .idk-att");
  if(!t||!att||att.parentNode.querySelector(".phx-from"))return;
  const btn=document.createElement("button");btn.type="button";btn.className="idk-att phx-from";btn.title="Attach from Photo Intelligence";btn.setAttribute("aria-label","Attach photos from Photo Intelligence");btn.innerHTML=ic.img;
  btn.onclick=()=>{
   const inp=document.getElementById("idk-photos"),have=inp&&inp.files?inp.files.length:0,left=Math.max(0,10-(t.evidence||[]).length-have);
   s91PhotoPicker({plant:t.plant,issueId:t.id,max:left,title:"Attach photos to "+t.id,onPick:files=>{
    const input=document.getElementById("idk-photos");
    try{const dt=new DataTransfer();Array.from((input&&input.files)||[]).concat(files).forEach(f=>dt.items.add(f));input.files=dt.files;if(typeof idkPhotos==="function")idkPhotos(input);toast(files.length+" photo"+(files.length===1?"":"s")+" attached · press Send")}
    catch(e){toast("This browser cannot add photos to the message. Use the 📎 button instead.")}
   }});
  };
  att.insertAdjacentElement("afterend",btn);
 }
 /* PM work order: "From photos" beside each Before / After upload, saved through the PM evidence upload */
 function pmPickHook(){
  document.querySelectorAll(".sched-photo-actions").forEach(box=>{
   if(box.querySelector(".phx-from"))return;
   box.querySelectorAll('input[type="file"][onchange*="scheduledUploadEvidence"]').forEach(inp=>{
    const m=/scheduledUploadEvidence\(this,'(.*)','(before|after)'\)/.exec(inp.getAttribute("onchange")||"");if(!m)return;
    const taskId=m[1],kind=m[2],t=(S.tasks||[]).find(x=>x.id===taskId);if(!t)return;
    const btn=document.createElement("button");btn.type="button";btn.className="btn g sm phx-from";btn.innerHTML=ic.img+" "+(kind==="before"?"Before":"After")+" from photos";
    btn.onclick=()=>s91PhotoPicker({plant:t.plant,max:1,title:"Choose the "+kind+" photo",onPick:files=>{if(typeof scheduledUploadEvidence==="function")scheduledUploadEvidence({files:files.slice(0,1),value:""},taskId,kind)}});
    box.appendChild(btn);
   });
  });
 }
 if(typeof render==="function"){const prev=render;render=function(){prev.apply(this,arguments);
  try{ticketHook();ticketPickHook()}catch(e){console.warn("[Photo Intelligence] ticket hook",e)}
  try{pmPickHook()}catch(e){console.warn("[Photo Intelligence] PM hook",e)}
  try{watchEnd();window.s91PhotoHydrate&&s91PhotoHydrate()}catch(e){}}}

 /* ---------- wiring: modals, closing, page unload ---------- */
 if(typeof renderModal==="function"){const prev=renderModal;renderModal=function(){if(S.modal==="photoCompose")return composeModal();if(S.modal==="photoDetail")return detailModal();return prev.apply(this,arguments)}}
 /* closing the composer (X, overlay, Esc) discards the selection and frees its previews; never mid-submission */
 if(typeof closeModal==="function"){const prev=closeModal;closeModal=function(){if(S.modal==="photoCompose"){if(P.draft.busy)return;discardDraft()}return prev.apply(this,arguments)}}
 addEventListener("pagehide",e=>{if(e.persisted)return;(P.draft.files||[]).forEach(f=>revoke(f.url));svc().sessionUrls().forEach(revoke)});
})();
