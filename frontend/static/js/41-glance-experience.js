"use strict";
/* Solar91 "at a glance" layer, loaded last.
   - s91Glance.donut(): focus-mode donut card used by Preventive Maintenance and Washing. The active slice keeps
     its colour, the others fade, and the centre shows the selected count. A zero-count focus draws a dashed ring.
   - s91Glance.focusBar(): "Filtered view" chip strip shown above a register while a chart/KPI filter is active.
   - S._glanceScroll: a module sets it before render(); after the repaint the page scrolls to that element and
     pulses it, so a click on a chart lands on the matching rows.
   - s91NotifPanel(): the notification centre opened from the topbar bell.
   Everything here is presentation only: it reads loaded state and never writes to the server. */
(function(){
 if(window.s91Glance)return;
 const h=v=>typeof esc==="function"?esc(v==null?"":String(v)):String(v==null?"":v);
 const pct=(n,t)=>t?Math.round(100*n/t):0;

 /* ---------- focus-mode donut ---------- */
 function donut(o){
  const slices=o.slices||[],total=slices.reduce((a,s)=>a+(Number(s.n)||0),0);
  const focus=o.active&&o.active!=="all"?slices.find(s=>String(s.key)===String(o.active))||null:null;
  const R=60,W=16,C=2*Math.PI*R,noun=h(o.noun||"records"),attr=o.attr;
  const drawn=slices.filter(s=>s.n).length;
  let acc=0,arcs="";
  if(focus&&!focus.n){
   arcs='<circle class="gx-none" cx="80" cy="80" r="'+R+'" stroke="'+focus.color+'" stroke-width="'+W+'" stroke-dasharray="1.5 9"/>';
  }else if(total){
   slices.forEach(s=>{
    if(!s.n)return;
    const full=s.n/total*C,len=Math.max(full-(drawn>1?3.5:0),2.5);
    arcs+='<circle class="gx-arc'+(focus===s?" on":"")+(focus&&focus!==s?" dim":"")+'" cx="80" cy="80" r="'+R+'" stroke="'+s.color+'" stroke-width="'+(focus===s?W+4:W)+'" stroke-dasharray="'+len.toFixed(2)+' '+(C-len).toFixed(2)+'" stroke-dashoffset="'+(-acc).toFixed(2)+'" '+attr+'="'+h(s.key)+'"><title>'+h(s.label)+': '+s.n+' ('+pct(s.n,total)+'%) · click to filter</title></circle>';
    acc+=full;
   });
  }
  const hole=focus
   ?'<b style="color:'+focus.color+'">'+(focus.n||0)+'</b><span>'+h(focus.label)+'</span><small>'+(!focus.n?"none of "+total:focus.n===total?"all "+total:pct(focus.n,total)+"% of "+total)+'</small>'
   :'<b>'+total+'</b><span>'+noun+'</span>'+(o.centerNote?'<small>'+h(o.centerNote)+'</small>':'');
  const legend=slices.map(s=>'<button type="button" class="gx-leg'+(focus===s?" on":"")+(focus&&focus!==s?" dim":"")+'" style="--c:'+s.color+'" '+attr+'="'+h(s.key)+'" aria-pressed="'+(focus===s)+'"><i></i><span>'+h(s.label)+'</span><b>'+(s.n||0)+'</b><em>'+pct(s.n||0,total)+'%</em></button>').join("");
  const sub=focus?'Showing <b style="color:'+focus.color+'">'+h(focus.label)+'</b> · click it again to show all':h(o.sub||"Click a slice to filter the list below");
  return '<article class="gx-card gx-donut-card'+(focus?" is-focus":"")+'"'+(focus?' style="--gx-focus:'+focus.color+'"':'')+'><header><h3>'+h(o.title)+'</h3><p>'+sub+'</p></header>'+
   '<div class="gx-donut"><div class="gx-ring"><svg viewBox="0 0 160 160" aria-hidden="true"><g transform="rotate(-90 80 80)"><circle class="gx-track" cx="80" cy="80" r="'+R+'" stroke-width="'+W+'"/>'+arcs+'</g></svg><div class="gx-hole">'+hole+'</div></div><div class="gx-legend">'+legend+'</div></div></article>';
 }

 /* ---------- active filter strip ---------- */
 function focusBar(chips,clearAttr){
  if(!chips||!chips.length)return "";
  return '<div class="gx-focusbar" role="status"><span class="gx-focus-label"><i aria-hidden="true"></i>Filtered view</span>'+
   chips.map(c=>'<button type="button" class="gx-chip" style="--c:'+(c.color||"var(--primary)")+'" '+c.attr+' title="Remove this filter"><span>'+h(c.label)+'</span><b aria-hidden="true">×</b></button>').join("")+
   (clearAttr?'<button type="button" class="gx-clear" '+clearAttr+'>Clear all</button>':'')+'</div>';
 }

 /* ---------- small score ring (hero) ---------- */
 function scoreRing(value,color){
  const R=26,C=2*Math.PI*R,v=Math.max(0,Math.min(100,Number(value)||0));
  return '<svg class="gx-score" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="'+R+'" class="t"/><circle cx="32" cy="32" r="'+R+'" class="v" stroke="'+(color||"#fff")+'" stroke-dasharray="'+(v/100*C).toFixed(1)+' '+C.toFixed(1)+'" transform="rotate(-90 32 32)"/></svg>';
 }

 window.s91Glance={donut,focusBar,scoreRing,pct};
 window.s91GlanceScroll=function(id){S._glanceScroll=id};

 /* ---------- scroll to the filtered rows after a repaint ---------- */
 function landOn(id){
  const el=document.getElementById(id);if(!el)return;
  el.scrollIntoView({behavior:"smooth",block:"start"});
  el.classList.remove("gx-flash");void el.offsetWidth;el.classList.add("gx-flash");
  setTimeout(()=>el.classList.remove("gx-flash"),1700);
 }
 if(typeof render==="function"&&!window._gxRender){
  window._gxRender=true;
  const baseRender=render;
  render=function(){
   const out=baseRender.apply(this,arguments);
   const id=S._glanceScroll;
   if(id){S._glanceScroll=null;setTimeout(()=>landOn(id),90)}
   return out;
  };
 }

 /* ---------- keyboard: Enter / Space on card-like buttons ---------- */
 document.addEventListener("keydown",e=>{
  if(e.key!=="Enter"&&e.key!==" ")return;
  const el=e.target;
  if(!el||!el.matches||!el.matches('[role="button"][tabindex]'))return;
  e.preventDefault();el.click();
 });

 /* ---------- notification centre ---------- */
 const KIND=[
  [/critical/i,"crit","Critical",'<path d="M12 8v5m0 3h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'],
  [/overdue|past etc|late/i,"late","Overdue",'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  [/nearing/i,"soon","Due soon",'<circle cx="12" cy="12" r="9"/><path d="M12 7v5h4"/>'],
  [/unassigned/i,"assign","Unassigned",'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
  [/wash/i,"wash","Washing",'<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'],
  [/stock|spare/i,"stock","Spares",'<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>'],
  [/document|expir/i,"doc","Documents",'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'],
  [/handover/i,"ho","Handover",'<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'],
  [/plant|pv syst|reporting/i,"plant","Generation",'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>']
 ];
 const OTHER=[null,"info","Update",'<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'];
 function kindOf(n){
  const text=String(n.title||"")+" "+String(n.meta||"");
  for(const k of KIND)if(k[0].test(text))return k;
  return OTHER;
 }
 const ICON=p=>'<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>';
 window.s91NotifPanel=function(notifs){
  const list=notifs||[],unread=list.filter(n=>!n.event||!n.read).length;
  const groups={};list.forEach(n=>{const k=kindOf(n)[1];groups[k]=(groups[k]||0)+1});
  const tabs=[["all","All",list.length],["crit","Critical",groups.crit||0],["late","Overdue",(groups.late||0)+(groups.soon||0)],["assign","Unassigned",groups.assign||0]].filter(t=>t[0]==="all"||t[2]);
  const tab=tabs.some(t=>t[0]===S.notifTab)?S.notifTab:"all";
  const shown=list.filter(n=>{const k=kindOf(n)[1];return tab==="all"||k===tab||(tab==="late"&&k==="soon")});
  const item=n=>{const k=kindOf(n),isNew=!n.event||!n.read,meta=String(n.meta||"").replace(/^●\s*/,"");
   return '<button type="button" class="nx-item nx-'+k[1]+(isNew?" new":"")+'" data-act="notif" data-id="'+h(n.id)+'"><span class="nx-ico">'+ICON(k[3])+'</span><span class="nx-body"><span class="nx-kind">'+k[2]+(isNew?'<i class="nx-dot" aria-label="unread"></i>':'')+'</span><b>'+h(n.title)+'</b><small>'+h(meta)+'</small></span><span class="nx-open" aria-hidden="true">›</span></button>'};
  return '<div class="nx-pop" role="dialog" aria-label="Notifications"><div class="nx-head"><span class="nx-head-ico">'+ICON(OTHER[3])+'</span><div><b>Notifications</b><small>'+(unread?unread+" need your attention":"You are all caught up")+'</small></div>'+
   (list.some(n=>n.event&&!n.read)?'<button type="button" class="nx-mark" onclick="event.stopPropagation();markAllEventsRead()">Mark all read</button>':'')+'</div>'+
   (list.length?'<div class="nx-tabs" role="tablist">'+tabs.map(t=>'<button type="button" role="tab" aria-selected="'+(tab===t[0])+'" class="'+(tab===t[0]?"on":"")+'" onclick="event.stopPropagation();S.notifTab=\''+t[0]+'\';render()">'+t[1]+' <b>'+t[2]+'</b></button>').join("")+'</div>':'')+
   '<div class="nx-list">'+(shown.length?shown.slice(0,60).map(item).join(""):'<div class="nx-empty"><span>'+ICON('<path d="M20 6 9 17l-5-5"/>')+'</span><b>All caught up</b><small>New alerts for issues, maintenance, washing and spares appear here.</small></div>')+'</div>'+
   (shown.length>60?'<div class="nx-foot">Showing the latest 60 of '+shown.length+'</div>':'')+'</div>';
 };
 /* close the notification centre on an outside click or Escape */
 document.addEventListener("click",e=>{
  if(!S.notifOpen)return;
  const t=e.target;
  if(!t||!t.closest||t.closest(".nx-pop")||t.closest(".nx-bell"))return;
  S.notifOpen=false;render();
 });
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&S.notifOpen){S.notifOpen=false;render()}});

 /* ---------- instant feedback on save buttons ----------
    When a click on a form's primary button starts an API request, the button shows a spinner at once and ignores
    further clicks until every request settles, so a slow network can never create duplicate submissions. */
 let inflight=0;
 const settle=()=>{if(inflight>0)return;document.querySelectorAll(".gx-busy").forEach(b=>{b.classList.remove("gx-busy");b.removeAttribute("aria-busy")})};
 if(typeof apiFetch==="function"&&!window._gxFetchCount){
  window._gxFetchCount=true;
  const baseFetch=apiFetch;
  apiFetch=function(){
   inflight++;
   let result;
   try{result=baseFetch.apply(this,arguments)}catch(error){inflight--;settle();throw error}
   return Promise.resolve(result).finally(()=>{inflight--;settle()});
  };
 }
 const SAVE_BUTTONS=".overlay .modal-f .btn.p,.overlay [data-wiz-final],.pml-drawer-footer .btn.p,.pml-drawer form .btn.p";
 document.addEventListener("click",e=>{
  const b=e.target&&e.target.closest?e.target.closest(SAVE_BUTTONS):null;if(!b)return;
  if(b.classList.contains("gx-busy")){e.preventDefault();e.stopPropagation();return}
  const before=inflight,mark=()=>{if(inflight>before&&b.isConnected&&!b.classList.contains("gx-busy")){b.classList.add("gx-busy");b.setAttribute("aria-busy","true")}};
  setTimeout(mark,0);setTimeout(mark,160);
 },true);

 /* ---------- every toast() becomes a notification card ----------
    Same message text as before; the tone only colours the card. Failures are red so they are never
    mistaken for a success. Falls back to the plain toast if the card renderer is unavailable. */
 if(typeof toast==="function"&&!window._gxToast){
  window._gxToast=true;
  const plainToast=toast;
  const FAIL=/could not|couldn['’]t|unable|failed|error|denied|unavailable|not saved|rejected|offline/i;
  const WARN=/required|invalid|must |missing|select |choose |enter |only |not available|cannot|can['’]t|not allowed|no [a-z]+ (?:match|found|selected|to export)/i;
  const GOOD=/saved|created|updated|assigned|completed|confirmed|uploaded|exported|deleted|restored|recorded|added|imported|cleared|downloaded|submitted|approved|resolved|closed|started|scoped|sent\b|done\b/i;
  toast=function(m){
   const text=String(m==null?"":m).trim();
   if(!text)return;
   if(typeof ccPopup!=="function"){plainToast(m);return}
   try{
    const tone=FAIL.test(text)?"d":WARN.test(text)?"w":GOOD.test(text)?"s":"i";
    const cut=text.indexOf(" — ");
    if(cut>2&&cut<90)ccPopup(text.slice(0,cut).trim(),text.slice(cut+3).trim(),tone,null);
    else ccPopup(text,"",tone,null);
   }catch(error){plainToast(m)}
  };
 }
})();
