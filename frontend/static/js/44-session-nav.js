"use strict";
/* Session navigation helpers (loaded last). Nothing here is sent to the server or kept after the tab closes.

   1. ← / → arrows in the top bar walk back and forward through the screens visited in this tab. They use the
      browser history, so they agree with the browser and phone Back buttons.
   2. Opening a dialog adds one history step: Back (arrow, browser or phone) closes the dialog first.
   3. Form drafts: what is typed in a dialog, and the wizard step it is on, is kept in memory. Leaving the form
      (Cancel, ✕, Escape, Back) and opening it again brings it back at the same step, with a "Start fresh" option.
      Pressing the dialog's main button (Create / Save …) and the dialog then closing means it was submitted:
      that draft is discarded, so a submitted form never comes back. */
(function(){
 if(typeof render!=="function"||typeof S==="undefined")return;
 const NAV={i:0,max:0,skipPop:0,fromHistory:false};
 const drafts=new Map();          // dialog key -> {values:{id:value|bool}, steps:{prefix:step}}
 let open=null;                   // {key,name} of the dialog on screen
 let submitting=null;             // dialog key whose main button was pressed last
 let baseline={};                 // field values when the dialog opened (defaults are not "typed")
 let restoring=false;

 /* ---------- history bookkeeping ---------- */
 const st=()=>history.state&&history.state.s91?history.state:null;
 function stamp(extra,replace){
  const state=Object.assign({s91:1,i:NAV.i},extra||{});
  try{history[replace?"replaceState":"pushState"](state,"",location.hash||"#")}catch(e){}
 }
 (function init(){const s=st();if(s){NAV.i=s.i||0;NAV.max=NAV.i}else stamp({},true)})();
 if(typeof s91SetRoute==="function"){
  /* same rules as the original (21-washing-portfolio.js) plus a step number, so the arrows know where they are */
  s91SetRoute=function(route,replace){
   if(typeof _s91RouteApplying!=="undefined"&&_s91RouteApplying)return;
   const h="#"+route;if(location.hash===h)return;
   if(replace){try{history.replaceState({s91:1,i:NAV.i},"",h)}catch(e){}return}
   NAV.i+=1;NAV.max=NAV.i;try{history.pushState({s91:1,i:NAV.i},"",h)}catch(e){}
   paintArrows();
  };
 }
 window.s91NavBack=function(){if(NAV.i>0)history.back()};
 window.s91NavForward=function(){if(NAV.i<NAV.max)history.forward()};

 /* ---------- dialog keys and drafts ---------- */
 function keyOf(name,ctx){
  let c="";try{c=JSON.stringify(ctx||{},(k,v)=>v instanceof Set?Array.from(v):(typeof v==="function"?undefined:v))}catch(e){c=""}
  return name+"|"+c;
 }
 const root=()=>document.querySelector(".overlay .modal");
 function fields(box){
  return Array.from(box.querySelectorAll("input[id],select[id],textarea[id]")).filter(el=>
   !el.disabled&&!el.closest("[data-no-draft]")&&!/^(file|password|hidden|button|submit)$/i.test(el.type||""));
 }
 const valueOf=el=>(el.type==="checkbox"||el.type==="radio")?el.checked:el.value;
 function snapshot(){const box=root(),out={};if(box)fields(box).forEach(el=>{out[el.id]=valueOf(el)});return out}
 function capture(){
  const box=root();if(!open||!box||restoring)return;
  const values=snapshot(),prev=drafts.get(open.key),steps=(prev&&prev.steps)||{};
  const typed=Object.keys(values).some(id=>id in baseline?values[id]!==baseline[id]:!!values[id]);
  if(typed||Object.values(steps).some(n=>n>1))drafts.set(open.key,{values,steps});else drafts.delete(open.key);
 }
 function setField(el,v){
  if(el.type==="checkbox"||el.type==="radio"){if(el.checked===!!v)return false;el.checked=!!v}
  else{if(el.value===v)return false;if(el.tagName==="SELECT"&&!Array.from(el.options).some(o=>o.value===v))return false;el.value=v}
  return true;
 }
 function restore(key){
  const d=drafts.get(key);if(!d)return;
  restoring=true;try{restoreInto(d)}finally{restoring=false}
  addBar(key);
 }
 function restoreInto(d){
  /* several passes: a dropdown change can rebuild later fields (e.g. plant → equipment list) */
  for(let pass=0;pass<3;pass++){
   const box=root();if(!box)return;let changed=false;
   Object.keys(d.values||{}).forEach(id=>{
    const el=document.getElementById(id);if(!el||!box.contains(el))return;
    if(setField(el,d.values[id])){changed=true;
     try{el.dispatchEvent(new Event(el.tagName==="SELECT"||el.type==="checkbox"||el.type==="radio"?"change":"input",{bubbles:true}))}catch(e){}}
   });
   if(!changed)break;
  }
  Object.entries(d.steps||{}).forEach(([prefix,step])=>{if(step>1&&typeof wizardGo==="function")try{wizardGo(prefix,step,true)}catch(e){}});
 }
 function addBar(key){
  const body=root()&&root().querySelector(".modal-b");
  if(body&&!body.querySelector(".s91-draft-bar")){
   const bar=document.createElement("div");bar.className="s91-draft-bar";bar.setAttribute("role","status");
   bar.innerHTML='<span>↺ Restored what you entered earlier in this session.</span><button type="button" class="btn g sm">Start fresh</button>';
   bar.querySelector("button").addEventListener("click",()=>{drafts.delete(key);const n=S.modal,c=S.modalCtx;S.modal=null;render();S.modal=n;S.modalCtx=c;open=null;freshOpen=true;render()});
   body.insertBefore(bar,body.firstChild);
  }
 }
 let freshOpen=false;

 /* typing keeps the draft; the main button marks "submitting"; any other click or key in the dialog un-marks it */
 ["input","change"].forEach(type=>document.addEventListener(type,e=>{
  if(!open||!e.target||!e.target.closest||!e.target.closest(".overlay .modal"))return;
  submitting=null;capture();
 },true));
 document.addEventListener("click",e=>{
  const t=e.target&&e.target.closest?e.target:null;if(!open||!t||!t.closest(".overlay .modal"))return;
  if(t.closest(".modal-f .btn.p,[data-wiz-final]")){capture();submitting=open.key}
  else if(t.closest("button"))submitting=null;
 },true);
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&open){capture();submitting=null}},true);

 if(typeof wizardGo==="function"){
  const original=wizardGo;
  wizardGo=function(prefix,step){
   const r=original.apply(this,arguments);
   if(open&&!restoring){const d=drafts.get(open.key)||{values:snapshot(),steps:{}};d.steps=Object.assign({},d.steps,{[prefix]:step});drafts.set(open.key,d);capture()}
   return r;
  };
 }

 /* ---------- follow the dialog on every render ---------- */
 function afterRender(){
  const name=S.modal||null,key=name?keyOf(name,S.modalCtx):null;
  if(open&&open.key!==key){                                       // the dialog closed or changed
   if(submitting===open.key)drafts.delete(open.key);              // submitted: never bring it back
   submitting=null;
   const s=st();
   if(!name&&s&&s.modal&&!NAV.fromHistory){NAV.skipPop+=1;history.back()}   // drop the dialog's history step
   open=null;
  }
  if(name&&!open){                                                // a dialog opened
   open={key,name};
   if(!NAV.fromHistory){
    let ctx=null;try{ctx=JSON.parse(JSON.stringify(S.modalCtx||{}))}catch(e){ctx=null}
    const s=st();
    if(s&&s.modal){stamp({modal:name,ctx},true)}else{NAV.i+=1;NAV.max=NAV.i;stamp({modal:name,ctx},false)}
   }
   baseline=snapshot();
   if(freshOpen)freshOpen=false;else restore(key);
  }else if(name&&open&&!restoring)capture();                       // same dialog redrawn: the screen is the truth
  NAV.fromHistory=false;
  paintArrows();
 }
 const previous=window.render;
 window.render=function(){const r=previous.apply(this,arguments);try{afterRender()}catch(e){console.warn("[session nav]",e)}return r};
 try{render=window.render}catch(e){}

 window.addEventListener("popstate",()=>{
  if(NAV.skipPop>0){NAV.skipPop-=1;const s=st();NAV.i=s?s.i||0:0;paintArrows();return}
  const s=st(),from=NAV.i;
  NAV.i=s?s.i||0:0;NAV.max=Math.max(NAV.max,from,NAV.i);
  if(open){capture();submitting=null}                              // leaving by Back keeps the draft
  NAV.fromHistory=true;
  if(s&&s.modal&&s.ctx!==null){S.modal=s.modal;S.modalCtx=s.ctx||{}}
  else if(S.modal){S.modal=null;S.modalCtx=null}
  render();
 });

 /* ---------- the arrows ---------- */
 const PHONE=window.matchMedia?window.matchMedia("(max-width:900px)"):{matches:false};
 let navEl=null;
 function buildNav(){
  const nav=document.createElement("div");nav.className="s91-nav";nav.setAttribute("role","group");nav.setAttribute("aria-label","Go back or forward");
  nav.innerHTML='<button type="button" class="s91-nav-b" data-dir="back" title="Back (previous screen or step)" aria-label="Back">←</button>'+
                '<button type="button" class="s91-nav-b" data-dir="fwd" title="Forward" aria-label="Forward">→</button>';
  nav.addEventListener("click",e=>{const b=e.target.closest("button");if(!b||b.disabled)return;b.dataset.dir==="back"?s91NavBack():s91NavForward()});
  return nav;
 }
 function paintArrows(){
  navEl=navEl||buildNav();
  if(PHONE.matches){
   /* phones: the title cell is too narrow, so the arrows float above the bottom menu (outside the blurred top bar) */
   navEl.classList.add("float");if(navEl.parentNode!==document.body)document.body.appendChild(navEl);
  }else{
   /* the arrows sit inside the title cell (the top bar is a grid that places its children by position) */
   navEl.classList.remove("float");
   const title=document.querySelector(".topbar > div:first-child");if(!title)return;
   if(!title.classList.contains("s91-titlecell")){
    const crumb=document.createElement("div");crumb.className="s91-crumb";
    while(title.firstChild)crumb.appendChild(title.firstChild);
    title.classList.add("s91-titlecell");title.appendChild(crumb);
   }
   if(navEl.parentNode!==title)title.insertBefore(navEl,title.firstChild);
  }
  const [back,fwd]=navEl.querySelectorAll("button");
  back.disabled=NAV.i<=0;fwd.disabled=NAV.i>=NAV.max;
  navEl.hidden=back.disabled&&fwd.disabled&&PHONE.matches;        // no empty floating pill on a fresh phone session
 }
 try{PHONE.addEventListener("change",paintArrows)}catch(e){}
 window.s91SessionNav={state:()=>({i:NAV.i,max:NAV.max,open:open&&open.name,drafts:Array.from(drafts.keys())})};
 paintArrows();
})();
