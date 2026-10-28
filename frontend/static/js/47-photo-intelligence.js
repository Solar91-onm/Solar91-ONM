"use strict";
/* O&M Photo Intelligence · page (#/photos). Summary cards, filters, gallery, detail view and the phone submission
   composer. All data comes through window.S91PhotoService (46-photo-service.js), which is a DEMO adapter for now:
   sample records plus photos added in this tab, never uploaded or saved. The page says so wherever it matters. */
(function(){
 if(window.renderPhotoIntelligence)return;
 const L=window.S91PhotoLogic,svc=()=>window.S91PhotoService;
 const P=window.S91PhotoUI={q:Object.assign({},L.DEFAULT_QUERY),limit:L.PAGE_SIZE,result:null,plants:null,loading:false,error:null,
  key:null,seq:0,showFilters:false,fresh:new Set(),draft:null};
 const role=()=>S._roleLabel||S.currentRole||"O&M Head";
 const sePlant=()=>role()==="Site Engineer"?(S._sePlant||""):"";
 const readOnly=()=>role()==="Administration"||(typeof rev05ReadOnly==="function"&&rev05ReadOnly());
 /* the demo narrows a Site Engineer to their plant; the real API will enforce plant access on the server */
 const viewer=()=>sePlant()?{plants:[sePlant()]}:null;
 const blankDraft=()=>({files:[],plant:"",category:"",description:"",tags:[],otherTags:"",issueId:"",errors:[],progress:null,busy:false,qualityAck:false});
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
   '<circle cx="'+(250-off)+'" cy="52" r="20" fill="hsl(44,90%,72%)"/><rect x="204" y="204" width="104" height="24" rx="12" fill="rgba(255,255,255,.85)"/><text x="256" y="220" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="#33443c">SAMPLE PHOTO</text></svg>';
  const url="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg);thumbs.set(k,url);return url;
 }
 const imgOf=r=>r.previewUrl||placeholder(r.category,r.variant||0);
 const altOf=r=>r.source==="session"?"Photo added in this tab: "+(r.fileName||"image"):"Sample placeholder for a "+L.catLabel(r.category)+" photo at "+r.plant;
 const ago=iso=>{const m=Math.max(0,Math.round((Date.now()-Date.parse(iso))/6e4));return m<1?"just now":m<60?m+" min ago":m<1440?Math.round(m/60)+" h ago":Math.round(m/1440)+" d ago"};
 const fmtSize=b=>b>=1048576?(b/1048576).toFixed(1)+" MB":Math.max(1,Math.round(b/1024))+" KB";

 /* ---------- data ---------- */
 function queryKey(){return JSON.stringify([P.q,P.limit,sePlant(),(S.plants||[]).length])}
 function refresh(force){
  const key=queryKey();if(!force&&key===P.key)return;P.key=key;
  const seq=++P.seq,q=Object.assign({},P.q,{offset:0,limit:P.limit});P.loading=true;P.error=null;
  Promise.all([svc().listPhotos(q,viewer()),P.plants&&!force?Promise.resolve(P.plants):svc().getPlants(viewer())]).then(([res,plants])=>{
   if(seq!==P.seq)return;P.result=res;P.plants=plants;P.loading=false;if(S.view==="photos")render();
  }).catch(err=>{if(seq!==P.seq)return;P.loading=false;P.error=(err&&err.message)||"Photos could not load.";if(S.view==="photos")render()});
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
   sel("issue","Related issue",[["all","Any"],["linked","Linked to an issue"],["unlinked","Not linked"]].concat(f.issues.map(x=>[x.id,x.id+" · "+x.status])))+
   sel("status","Processing",[["all","Any status"]].concat(L.STATUSES.map(s=>[s.id,s.label])))+
   sel("sort","Sort",[["newest","Newest first"],["oldest","Oldest first"]])+
   '<button type="button" class="btn o sm phx-reset" onclick="s91PhotoReset()"'+(active||P.q.window!=="30d"||P.q.sort!=="newest"?"":" disabled")+'>Reset filters</button></div>';
 }
 function cardsHtml(res){
  const s=res?res.summary:null,win=L.WINDOWS.find(w=>w.id===P.q.window).label.toLowerCase(),v=n=>s?n:"—";
  const card=(label,n,note,act,on)=>act?'<button type="button" class="phx-kpi'+(on?" on":"")+'" onclick="'+act+'" aria-pressed="'+!!on+'"><span>'+label+'</span><b>'+n+'</b><small>'+note+'</small></button>'
   :'<div class="phx-kpi"><span>'+label+'</span><b>'+n+'</b><small>'+note+'</small></div>';
  return '<div class="phx-kpis">'+card("Photos",v(s&&s.inWindow),esc(win)+" · matching filters")+card("Received today",v(s&&s.today),"since midnight")+
   card("Awaiting processing",v(s&&s.awaiting),P.q.status==="queued"?"showing these · tap to clear":"tap to show","s91PhotoSet('status','"+(P.q.status==="queued"?"all":"queued")+"')",P.q.status==="queued")+
   card("Not linked to an issue",v(s&&s.unlinked),P.q.issue==="unlinked"?"showing these · tap to clear":"tap to show","s91PhotoSet('issue','"+(P.q.issue==="unlinked"?"all":"unlinked")+"')",P.q.issue==="unlinked")+'</div>';
 }
 function cardHtml(r){
  const st='<em class="phx-st st-'+r.status+'">'+esc(L.statusLabel(r.status))+'</em>';
  return '<article class="phx-card'+(P.fresh.has(r.id)?" fresh":"")+'" role="button" tabindex="0" aria-label="'+esc(L.catLabel(r.category)+" photo at "+r.plant+", "+ago(r.uploadedAt))+'" onclick="s91PhotoOpen(\''+esc(r.id)+'\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();s91PhotoOpen(\''+esc(r.id)+'\')}">'+
   '<div class="phx-thumb"><img src="'+esc(imgOf(r))+'" alt="'+esc(altOf(r))+'" loading="lazy" decoding="async" onerror="this.parentNode.classList.add(\'noimg\')"/>'+st+(r.source==="session"?'<i class="phx-mine">Added in this tab</i>':'')+'</div>'+
   '<div class="phx-body"><div class="phx-row"><b title="'+esc(r.plant)+'">'+esc(r.plant)+'</b><span class="phx-cat c-'+r.category+'">'+esc(L.catLabel(r.category))+'</span></div>'+
   '<small>'+esc(fmtDT(r.uploadedAt))+' · '+esc(r.uploader)+'</small>'+
   '<p>'+(r.description?esc(r.description):'<span class="phx-muted">No description · AI caption arrives in a later phase</span>')+'</p>'+
   ((r.tags||[]).length?'<div class="phx-tags">'+r.tags.map(t=>'<span>#'+esc(t)+'</span>').join("")+'</div>':'')+
   (r.issue?'<div class="phx-issue">'+esc(r.issue.id)+' · '+esc(r.issue.status)+'</div>':'')+'</div></article>';
 }
 window.renderPhotoIntelligence=function(){
  refresh(false);
  const res=P.result,ro=readOnly(),items=res?res.items:[];
  const pick=ro?'':'<div class="phx-actions">'+
   '<label class="btn p phx-pick">'+ic.cam+' Take photo<input class="phx-file" type="file" accept="image/*" capture="environment" onchange="s91PhotoPick(this)"/></label>'+
   '<label class="btn o phx-pick">'+ic.img+' Choose photos<input class="phx-file" type="file" accept="image/*" multiple onchange="s91PhotoPick(this)"/></label></div>';
  let grid;
  if(P.error&&!res)grid='<div class="phx-state err" role="alert"><b>Photos could not load</b><span>'+esc(P.error)+'</span><button type="button" class="btn o sm" onclick="s91PhotoRetry()">Try again</button></div>';
  else if(!res)grid='<div class="phx-grid" aria-busy="true">'+'<div class="phx-card sk"><div class="phx-thumb"></div><div class="phx-body"><i></i><i></i><i></i></div></div>'.repeat(8)+'</div>';
  else if(!items.length)grid='<div class="phx-state"><b>No photos match these filters</b><span>Try a longer time window or clear a filter.</span><button type="button" class="btn o sm" onclick="s91PhotoReset()">Reset filters</button></div>';
  else grid='<div class="phx-grid">'+items.map(cardHtml).join("")+'</div>'+(res.total>items.length?'<div class="phx-more"><button type="button" class="btn o" onclick="s91PhotoMore()">Load more <span>('+(res.total-items.length)+' more)</span></button></div>':'');
  return '<section class="phx" aria-labelledby="phx-title">'+
   '<header class="phx-head"><div><h1 id="phx-title">O&amp;M Photo Intelligence</h1><p>'+(sePlant()?esc(sePlant())+' · ':'All authorised plants · ')+'photos are kept for '+L.RETENTION_DAYS+' days · <button type="button" class="phx-link" onclick="window.s91AppSettings&&s91AppSettings()">Camera &amp; notifications</button></p></div>'+pick+'</header>'+
   '<div class="phx-demo" role="note"><b>Demo mode</b><span>Sample photos and numbers. Photos you add stay in this browser tab only: they are <strong>not uploaded or saved</strong> and disappear when the page reloads.</span>'+
    (res&&res.sessionCount?'<button type="button" class="btn g sm" onclick="s91PhotoClearSession()">Remove my '+res.sessionCount+' demo photo'+(res.sessionCount===1?"":"s")+'</button>':'')+'</div>'+
   cardsHtml(res)+
   '<div class="phx-panel">'+filtersHtml(res)+
    '<div class="phx-meta" aria-live="polite">'+(res?'<span><b>'+res.total+'</b> photo'+(res.total===1?"":"s")+' match'+(res.total===1?"es":"")+(res.total>items.length?' · showing '+items.length:'')+'</span>':'<span>Loading photos…</span>')+(P.loading&&res?'<span class="phx-muted">Updating…</span>':'')+'</div>'+
    grid+'</div></section>';
 };

 /* ---------- filter actions ---------- */
 window.s91PhotoSet=function(k,v,soon){P.q[k]=v;P.limit=L.PAGE_SIZE;if(soon&&typeof renderSoon==="function")renderSoon();else render()};
 window.s91PhotoReset=function(){P.q=Object.assign({},L.DEFAULT_QUERY);P.limit=L.PAGE_SIZE;render()};
 window.s91PhotoMore=function(){P.limit+=L.PAGE_SIZE;render()};

 /* ---------- detail ---------- */
 window.s91PhotoOpen=function(id){
  svc().getPhotoDetails(id).then(r=>{if(!r){toast("That photo is no longer available.");return}S.modal="photoDetail";S.modalCtx={record:r};render()});
 };
 function detailModal(){
  const r=(S.modalCtx||{}).record;if(!r)return "";
  const row=(k,v)=>'<div><dt>'+k+'</dt><dd>'+v+'</dd></div>';
  const expires=Math.max(0,Math.ceil((Date.parse(r.expiresAt)-Date.now())/864e5));
  const body='<div class="phx-detail"><div class="phx-big'+(r.previewUrl?"":" ph")+'"><img src="'+esc(imgOf(r))+'" alt="'+esc(altOf(r))+'" decoding="async" onerror="this.parentNode.classList.add(\'noimg\')"/></div>'+
   '<div class="phx-info"><div class="phx-demo sm" role="note"><b>Demo</b><span>'+(r.source==="session"?'Added in this tab · not uploaded or saved':'Sample record · not a real site photo')+'</span></div>'+
   '<h4>Description</h4><p>'+(r.description?esc(r.description):'<span class="phx-muted">No description added.</span>')+'</p>'+
   '<h4>AI caption</h4><p class="phx-muted">Not available yet. Automatic captions and tags come in a later phase.</p>'+
   ((r.tags||[]).length?'<div class="phx-tags">'+r.tags.map(t=>'<span>#'+esc(t)+'</span>').join("")+'</div>':'')+
   '<dl class="phx-dl">'+row("Plant",esc(r.plant))+row("Category",esc(L.catLabel(r.category)))+row("Uploaded",esc(fmtDT(r.uploadedAt))+' <span class="phx-muted">('+ago(r.uploadedAt)+')</span>')+row("Uploaded by",esc(r.uploader))+
    row("Equipment ID",r.equipmentId?esc(r.equipmentId):'<span class="phx-muted">—</span>')+row("Related issue",r.issue?esc(r.issue.id+" · "+r.issue.status):'<span class="phx-muted">Not linked</span>')+
    row("Processing",'<em class="phx-st inline st-'+r.status+'">'+esc(L.statusLabel(r.status))+'</em>')+row("Expires",esc(fmtDT(r.expiresAt))+' <span class="phx-muted">(in '+expires+' day'+(expires===1?"":"s")+')</span>')+
    (r.fileName?row("File",esc(r.fileName)+' · '+fmtSize(r.fileSize||0)):'')+
    (r.quality?row("Photo check",r.quality.dark?'<span class="phx-warnword">Too dark</span>':r.quality.blurry?'<span class="phx-warnword">May be blurry</span>':'Clear'):'')+row("Record",esc(r.id))+'</dl></div></div>';
  return modal(esc(L.catLabel(r.category))+' photo',esc(r.plant),body,'<button class="btn o" onclick="closeModal()">Close</button>',true);
 }

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
  if(k==="plant"){P.draft.issueId="";render()} /* the issue list belongs to the plant */
 };
 window.s91PhotoTag=function(t){const d=P.draft,i=d.tags.indexOf(t);if(i>=0)d.tags.splice(i,1);else d.tags.push(t);render()};
 window.s91PhotoDiscard=function(){if(P.draft.busy)return;discardDraft();S.modal=null;S.modalCtx=null;render()};
 function setProgress(p){
  P.draft.progress=p;const bar=document.getElementById("phx-progress");
  if(bar){bar.setAttribute("aria-valuenow",String(p));const i=bar.querySelector("i");if(i)i.style.width=p+"%";const t=document.getElementById("phx-progress-text");if(t)t.textContent="Simulating upload… "+p+"%"}
 }
 window.s91PhotoSubmit=async function(){
  const d=P.draft;if(d.busy||readOnly())return;
  const plant=sePlant()||d.plant;
  if(!d.files.length){toast("Add at least one photo.");return}
  if(!plant){toast("Choose the plant.");return}
  if(!d.category){toast("Choose a category.");return}
  const weak=flagged(d);
  if(weak.length&&!d.qualityAck){d.qualityAck=true;render();toast(weak.length+" photo"+(weak.length===1?" looks":"s look")+" too dark or blurry. Retake, or tap Submit anyway.");return}
  d.busy=true;d.progress=0;render();
  try{
   const linked=d.issueId?plantIssues(plant).find(t=>t.id===d.issueId):null;
   const res=await svc().createSubmission({files:d.files.map(f=>({name:f.name,size:f.size,type:f.type,previewUrl:f.url,quality:f.quality})),plant,category:d.category,description:d.description,
    tags:d.tags.concat(String(d.otherTags||"").split(",")),issue:linked?{id:linked.id,status:linked.status}:null,uploader:(S.currentUser||"You")+" (you)"},setProgress);
   P.fresh=new Set(res.records.map(r=>r.id));
   P.draft=blankDraft(); /* the preview URLs now belong to the demo gallery records */
   S.modal=null;S.modalCtx=null;
   P.q=Object.assign({},L.DEFAULT_QUERY);P.limit=L.PAGE_SIZE;P.key=null;
   render();
   toast(res.records.length+" photo"+(res.records.length===1?"":"s")+" added to the demo gallery · not uploaded or saved");
  }catch(err){d.busy=false;d.progress=null;render();toast((err&&err.message)||"The demo submission failed.")}
 };
 window.s91PhotoClearSession=function(){svc().clearSession().forEach(revoke);P.fresh=new Set();P.key=null;render();toast("Your demo photos were removed from this tab.")};
 function composeModal(){
  const d=P.draft,se=sePlant(),plants=P.plants||[],n=d.files.length,weak=flagged(d);
  const opts=(list,val,ph)=>'<option value="">'+ph+'</option>'+list.map(([v,l])=>'<option value="'+esc(v)+'"'+(val===v?" selected":"")+'>'+esc(l)+'</option>').join("");
  const body='<div class="phx-compose">'+
   '<div class="phx-demo sm" role="note"><b>Demo</b><span>Nothing is uploaded or saved. Submitted photos appear in this tab’s gallery until the page reloads.</span></div>'+
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
    '<label class="phx-field wide"><span>Link to site issue <i>optional</i></span><select class="inp" id="phx-c-issue" onchange="s91PhotoDraft(\'issueId\',this.value)"'+(d.busy||!(se||d.plant)?" disabled":"")+'>'+
      opts(plantIssues(se||d.plant).map(t=>[t.id,t.id+" · "+(t.equip&&t.equip!=="—"?t.equip:t.vertical||"Issue")+" · "+t.status]),d.issueId,(se||d.plant)?(plantIssues(se||d.plant).length?"Not linked":"No open issues at this plant"):"Choose the plant first")+'</select></label>'+
    '<label class="phx-field wide"><span>Remark <i>optional</i></span><textarea class="inp" id="phx-c-desc" rows="3" maxlength="'+L.MAX_DESCRIPTION+'" placeholder="What does the photo show? e.g. INV-03 filter after cleaning" oninput="s91PhotoDraft(\'description\',this.value)"'+(d.busy?" disabled":"")+'>'+esc(d.description)+'</textarea><small id="phx-desc-count">'+d.description.length+' / '+L.MAX_DESCRIPTION+'</small></label>'+
    '<div class="phx-field wide"><span id="phx-tags-lab">Tags <i>optional</i></span><div class="phx-chips" role="group" aria-labelledby="phx-tags-lab">'+
      L.QUICK_TAGS.map(t=>'<button type="button" class="phx-chip'+(d.tags.includes(t)?" on":"")+'" aria-pressed="'+d.tags.includes(t)+'" onclick="s91PhotoTag(\''+t+'\')"'+(d.busy?" disabled":"")+'>#'+t+'</button>').join("")+'</div>'+
      '<input class="inp" id="phx-c-tags" value="'+esc(d.otherTags)+'" placeholder="Other tags, comma separated" aria-label="Other tags, comma separated" oninput="s91PhotoDraft(\'otherTags\',this.value)"'+(d.busy?" disabled":"")+'/></div></div>'+
   (d.busy?'<div class="phx-progress" id="phx-progress" role="progressbar" aria-label="Simulated upload" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+(d.progress||0)+'"><i style="width:'+(d.progress||0)+'%"></i></div><p class="phx-ptext" id="phx-progress-text" aria-live="polite">Simulating upload… '+(d.progress||0)+'%</p>':'')+
   '</div>';
  const foot='<button class="btn o" onclick="s91PhotoDiscard()"'+(d.busy?" disabled":"")+'>Cancel</button><button class="btn p" onclick="s91PhotoSubmit()"'+(d.busy||!n?" disabled":"")+'>'+(d.busy?"Submitting…":(weak.length&&d.qualityAck?"Submit anyway":"Submit to demo gallery")+(n?" ("+n+")":""))+'</button>';
  return modal("Add site photos","Demo mode · not uploaded or saved",body,foot,true);
 }

 /* ---------- inside a Site Issue ticket (Issue Desk): a link to the photos linked to that issue ----------
    Tickets keep their own real photo upload (POST /api/issues/{id}/evidence); this only links across. */
 window.s91PhotoForIssue=function(id){P.q=Object.assign({},L.DEFAULT_QUERY,{issue:id});P.limit=L.PAGE_SIZE;S.modal=null;S.modalCtx=null;goView("photos")};
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
 if(typeof render==="function"){const prev=render;render=function(){prev.apply(this,arguments);try{ticketHook()}catch(e){console.warn("[Photo Intelligence] ticket hook",e)}}}

 /* ---------- wiring: modals, closing, page unload ---------- */
 if(typeof renderModal==="function"){const prev=renderModal;renderModal=function(){if(S.modal==="photoCompose")return composeModal();if(S.modal==="photoDetail")return detailModal();return prev.apply(this,arguments)}}
 /* closing the composer (X, overlay, Esc) discards the selection and frees its previews; never mid-submission */
 if(typeof closeModal==="function"){const prev=closeModal;closeModal=function(){if(S.modal==="photoCompose"){if(P.draft.busy)return;discardDraft()}return prev.apply(this,arguments)}}
 addEventListener("pagehide",e=>{if(e.persisted)return;(P.draft.files||[]).forEach(f=>revoke(f.url));svc().sessionUrls().forEach(revoke)});
})();
