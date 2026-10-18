"use strict";
/* Searchable plant picker.
   Any <select> whose options are plants (Site Issues, Preventive Maintenance, Washing, raise-issue wizard, Team access,
   the top bar…) opens a small search box instead of a long native list: type part of a plant name or site code,
   use ↑ ↓ Enter, or click. The original <select> stays in the page and receives the normal "change" event, so every
   existing handler keeps working. A select can opt in with data-pp, or opt out with data-pp="off". */
(function(){
 const SKIP=new Set(["","all","__all","__vendor","none","unassigned"]);
 const norm=v=>String(v==null?"":v).trim().toLowerCase();
 let plantKeys=null,plantRev=null;
 function keys(){
  const list=(typeof S!=="undefined"&&S.plants)||[];
  if(plantKeys&&plantRev===list)return plantKeys;
  plantKeys=new Set();plantRev=list;
  list.forEach(p=>[p.name,p.id,p.dbId,p.site_code,(p.id||"")+" · "+(p.name||""),(p.id||"")+" "+(p.name||"")].forEach(k=>{if(k)plantKeys.add(norm(k))}));
  return plantKeys;
 }
 function isPlantSelect(sel){
  if(sel.multiple||sel.disabled||sel.dataset.pp==="off")return false;
  if(sel.dataset.pp!==undefined)return true;
  const opts=[...sel.options].filter(o=>!SKIP.has(norm(o.value)));
  if(opts.length<6)return false;
  const k=keys();if(!k.size)return false;
  const hits=opts.filter(o=>k.has(norm(o.value))||k.has(norm(o.textContent.replace(/^[✓○]\s*/,"").split("  —")[0]))).length;
  return hits/opts.length>=0.7;
 }
 let pop=null,current=null,active=0,items=[];
 function close(){if(pop){pop.remove();pop=null}if(current){current.classList.remove("pp-open");current=null}}
 function place(){
  if(!pop||!current)return;
  const r=current.getBoundingClientRect(),w=Math.min(window.innerWidth-16,Math.max(r.width,300));
  let left=Math.min(Math.max(8,r.left),window.innerWidth-w-8),top=r.bottom+4;
  const h=Math.min(380,window.innerHeight-24);
  if(top+h>window.innerHeight-8&&r.top>h)top=Math.max(8,r.top-4-Math.min(h,pop.offsetHeight||h));
  Object.assign(pop.style,{left:left+"px",top:top+"px",width:w+"px"});
 }
 function paint(q){
  const term=norm(q);
  items=[...current.options].filter(o=>!o.disabled&&(!term||norm(o.textContent).includes(term)||norm(o.value).includes(term)));
  active=Math.max(0,items.findIndex(o=>o.value===current.value));if(term)active=0;
  const list=pop.querySelector(".pp-list");
  list.innerHTML=items.length?items.map((o,i)=>'<button type="button" role="option" class="pp-item'+(i===active?" on":"")+(o.value===current.value?" sel":"")+'" data-i="'+i+'">'+mark(o.textContent,term)+'</button>').join(""):'<div class="pp-empty">No plant matches “'+esc(q)+'”</div>';
  pop.querySelector(".pp-count").textContent=items.length+" of "+current.options.length;
 }
 function esc(v){return typeof window.esc==="function"?window.esc(v):String(v).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
 function mark(text,term){
  const t=String(text);if(!term)return esc(t);
  const i=t.toLowerCase().indexOf(term);if(i<0)return esc(t);
  return esc(t.slice(0,i))+"<mark>"+esc(t.slice(i,i+term.length))+"</mark>"+esc(t.slice(i+term.length));
 }
 function choose(i){
  const o=items[i],sel=current;if(!o||!sel)return;
  close();
  if(sel.value!==o.value){sel.value=o.value;sel.dispatchEvent(new Event("input",{bubbles:true}));sel.dispatchEvent(new Event("change",{bubbles:true}))}
  try{sel.focus({preventScroll:true})}catch(e){}
 }
 function move(d){
  if(!items.length)return;active=(active+d+items.length)%items.length;
  pop.querySelectorAll(".pp-item").forEach((b,i)=>b.classList.toggle("on",i===active));
  const b=pop.querySelector('.pp-item[data-i="'+active+'"]');if(b)b.scrollIntoView({block:"nearest"});
 }
 function open(sel){
  close();current=sel;sel.classList.add("pp-open");
  pop=document.createElement("div");pop.className="pp-pop";pop.setAttribute("role","dialog");pop.setAttribute("aria-label","Search plants");
  pop.innerHTML='<div class="pp-head"><span class="pp-ico">⌕</span><input class="pp-q" type="search" placeholder="Search plant name or site code…" aria-label="Search plants" autocomplete="off"/><span class="pp-count"></span></div><div class="pp-list" role="listbox"></div>';
  document.body.appendChild(pop);
  const input=pop.querySelector(".pp-q");
  input.addEventListener("input",()=>paint(input.value));
  input.addEventListener("keydown",e=>{
   if(e.key==="ArrowDown"){e.preventDefault();move(1)}else if(e.key==="ArrowUp"){e.preventDefault();move(-1)}
   else if(e.key==="Enter"){e.preventDefault();choose(active)}else if(e.key==="Escape"){e.preventDefault();const s=current;close();if(s)s.focus()}
   else if(e.key==="Tab")close();
  });
  pop.addEventListener("mousedown",e=>{const b=e.target.closest(".pp-item");if(b){e.preventDefault();choose(Number(b.dataset.i))}});
  paint("");place();
  const on=pop.querySelector(".pp-item.on");if(on)on.scrollIntoView({block:"nearest"});
  setTimeout(()=>input.focus(),0);
 }
 function enhance(root){
  (root||document).querySelectorAll("select:not([data-pp-on])").forEach(sel=>{
   if(!isPlantSelect(sel))return;
   sel.dataset.ppOn="1";sel.classList.add("pp-select");
   if(!sel.title)sel.title="Click and type to search plants";
  });
 }
 document.addEventListener("mousedown",e=>{
  const sel=e.target.closest&&e.target.closest("select[data-pp-on]");
  if(sel&&!sel.disabled){e.preventDefault();if(current===sel){close();return}open(sel);return}
  if(pop&&!pop.contains(e.target))close();
 },true);
 document.addEventListener("keydown",e=>{
  const sel=e.target;
  if(!(sel&&sel.matches&&sel.matches("select[data-pp-on]")))return;
  if(e.key==="Enter"||e.key===" "||(e.key==="ArrowDown"&&e.altKey)||(e.key.length===1&&/\S/.test(e.key))){
   e.preventDefault();open(sel);
   if(e.key.length===1&&e.key!==" "&&pop){const q=pop.querySelector(".pp-q");q.value=e.key;paint(e.key)}
  }
 },true);
 window.addEventListener("resize",()=>{if(pop)place()});
 document.addEventListener("scroll",e=>{if(pop&&!pop.contains(e.target)){if(current&&document.body.contains(current))place();else close()}},true);
 let queued=false;
 new MutationObserver(()=>{
  if(current&&!document.body.contains(current))close();
  if(queued)return;queued=true;
  requestAnimationFrame(()=>{queued=false;try{enhance(document)}catch(err){console.warn("[plant picker]",err)}});
 }).observe(document.documentElement,{childList:true,subtree:true});
 window.s91EnhancePlantSelects=enhance;
})();
