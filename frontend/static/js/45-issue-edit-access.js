"use strict";
/* Site Issues — editing, dates and closing for the O&M Head and the ticket's Assignee, plus the O&M Head's
   default Critical / Medium deadlines.
   The server enforces every rule (app/issues/router.py): the O&M Head on any ticket, an Assignee only on a ticket
   assigned to them (and never on a closed one); Site Engineers cannot edit or close. This file only shows the
   controls to the people the server accepts, sends one request per save and shows the server's answer. */
(function(){
 const role=()=>(typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role)||"Viewer";
 const isHead=()=>role()==="O&M Head";
 const issue=id=>(S.issues||[]).find(x=>x.id===id);
 const text=v=>typeof esc==="function"?esc(v==null?"":String(v)):String(v==null?"":v);
 const q=s=>String(s==null?"":s).replace(/\\/g,"\\\\").replace(/'/g,"\\'");
 const val=id=>{const e=document.getElementById(id);return e?String(e.value||""):""};
 const errText=(e,fallback)=>(e&&e.message)||fallback;
 function mine(t){
  if(!t)return false;
  const uid=typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.userId;
  if(t.assignedTo&&uid)return String(t.assignedTo)===String(uid);
  const me=String((typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.name)||S.currentUser||"").trim().toLowerCase();
  return !!t.assignee&&!!me&&String(t.assignee).trim().toLowerCase()===me;
 }
 const canEdit=t=>!!t&&!!t.dbId&&(isHead()||(role()==="Assignee"&&mine(t)&&t.status!=="Closed"));
 const canClose=t=>!!t&&!!t.dbId&&t.status!=="Closed"&&(isHead()||(role()==="Assignee"&&mine(t)));
 window.s91CanEditIssue=canEdit;
 window.s91CanCloseIssue=canClose;

 /* ---------- default deadlines (hours after a ticket is raised) ---------- */
 let deadlineInfo=null,deadlineLoading=false;
 function applyDeadlines(info){
  if(!info||!info.hours)return;
  deadlineInfo=info;
  ["Critical","Medium"].forEach(k=>{const n=Number(info.hours[k]);if(Number.isFinite(n)&&n>0&&typeof ETC_HRS==="object")ETC_HRS[k]=n});
 }
 async function loadDeadlines(){
  if(deadlineLoading)return deadlineInfo;
  deadlineLoading=true;
  try{applyDeadlines(await apiFetch("/api/issues/deadlines"))}catch(e){/* the built-in defaults stay in use */}
  finally{deadlineLoading=false}
  return deadlineInfo;
 }
 /* load once the signed-in session has its data (no request before sign-in) */
 let tries=0;
 const waitForSession=setInterval(()=>{
  tries++;
  const ready=typeof S!=="undefined"&&S&&typeof S._serverRevision==="number"&&typeof apiFetch==="function"&&role()!=="Viewer";
  if(ready){clearInterval(waitForSession);loadDeadlines()}
  else if(tries>240)clearInterval(waitForSession);
 },1000);

 const span=h=>{h=Number(h)||0;return h%24===0?(h/24)+" day"+(h===24?"":"s"):h+" hour"+(h===1?"":"s")};
 window.s91DeadlineText=()=>"Critical "+span(ETC_HRS.Critical)+" · Medium "+span(ETC_HRS.Medium);

 function overlay(id,title,sub,body,foot){
  const old=document.getElementById(id);if(old)old.remove();
  const o=document.createElement("div");o.id=id;o.className="overlay";o.style.zIndex="300";
  o.innerHTML='<div class="modal" role="dialog" aria-modal="true" aria-labelledby="'+id+'-t" style="max-width:520px"><div class="modal-h"><div><h3 id="'+id+'-t" style="font-size:16px;font-weight:600;margin:0">'+title+'</h3>'+(sub?'<p style="font-size:12px;color:var(--muted-foreground);margin:4px 0 0">'+sub+'</p>':'')+'</div>'+
   '<button type="button" class="btn" style="border:none;color:var(--muted-foreground)" data-s91-x aria-label="Close">✕</button></div><div class="modal-b">'+body+'</div><div class="modal-f">'+foot+'</div></div>';
  o.addEventListener("click",e=>{if(e.target===o||e.target.closest("[data-s91-x]"))o.remove()});
  document.body.appendChild(o);
  return o;
 }
 const unitPick=(name,hours)=>{const days=hours%24===0;return '<div class="row" style="gap:8px"><input class="inp" style="flex:1" type="number" min="1" step="1" id="dl-'+name+'-n" value="'+(days?hours/24:hours)+'" aria-label="'+name+' deadline"/><select class="inp" style="width:110px" id="dl-'+name+'-u" aria-label="'+name+' unit"><option value="d"'+(days?" selected":"")+'>days</option><option value="h"'+(days?"":" selected")+'>hours</option></select></div>'};
 window.s91OpenIssueDeadlines=async function(){
  if(!isHead()){toast("Only the O&M Head can change the default deadlines.");return}
  const info=await loadDeadlines()||{hours:{Critical:ETC_HRS.Critical,Medium:ETC_HRS.Medium},defaults:{Critical:48,Medium:96}};
  const h=info.hours,d=info.defaults||{Critical:48,Medium:96};
  const o=overlay("s91-deadlines","Ticket deadlines","How long a new ticket has before it is overdue, counted from when it is raised",
   '<div class="field"><span class="lbl"><b style="color:'+(SEV_COLOR.Critical||"#DC4C3E")+'">●</b> Critical tickets</span>'+unitPick("crit",h.Critical)+'</div>'+
   '<div class="field"><span class="lbl"><b style="color:'+(SEV_COLOR.Medium||"#3B82F6")+'">●</b> Medium tickets</span>'+unitPick("med",h.Medium)+'</div>'+
   '<p class="muted" style="font-size:12.5px;margin:6px 0 0">Applies to tickets raised from now on (form, Excel upload and Field Desk). Standard: Critical '+span(d.Critical)+', Medium '+span(d.Medium)+'.</p>'+
   '<label style="display:flex;gap:8px;align-items:flex-start;margin:12px 0 0;padding:10px 12px;border-radius:10px;background:var(--muted);font-size:12.5px;cursor:pointer"><input type="checkbox" id="dl-apply" style="margin-top:2px"/><span><b>Also move open tickets that still have the old default</b><br><span class="muted" id="dl-preview">Checking open tickets…</span></span></label>'+
   '<p id="dl-warn" class="muted" style="font-size:12.5px;color:var(--warning);margin:6px 0 0" role="status" aria-live="polite"></p>',
   '<button type="button" class="btn g" style="margin-right:auto" id="dl-reset">Use standard</button><button type="button" class="btn o" data-s91-x>Cancel</button><button type="button" class="btn p" id="dl-save">Save deadlines</button>');
  const hours=k=>{const n=Number(val("dl-"+k+"-n"));return Number.isFinite(n)&&n>0?Math.round(n*(val("dl-"+k+"-u")==="d"?24:1)):NaN};
  /* how many open tickets would move: a dry run on the server, refreshed shortly after each change */
  let previewTimer=null,previewSeq=0;
  const preview=()=>{
   clearTimeout(previewTimer);
   previewTimer=setTimeout(async()=>{
    const c=hours("crit"),m=hours("med"),box=o.querySelector("#dl-preview"),seq=++previewSeq;if(!box)return;
    if(!Number.isFinite(c)||!Number.isFinite(m)){box.textContent="Enter both durations to see which tickets would move.";return}
    try{
     const r=await apiFetch("/api/issues/deadlines",{method:"PUT",body:{critical_hours:c,medium_hours:m,dry_run:true,apply_to_open:true}});
     if(seq!==previewSeq)return;
     const t=(r.preview||{}).open_tickets||{moved:0,by_severity:{},kept_changed_by_hand:0,kept_own_target:0},kept=t.kept_changed_by_hand+t.kept_own_target;
     box.textContent=(t.moved?t.moved+" open ticket"+(t.moved===1?"":"s")+" would get the new deadline (Critical "+(t.by_severity.Critical||0)+", Medium "+(t.by_severity.Medium||0)+"), counted from when each was raised.":"No open ticket would move.")+
      (kept?" "+kept+" keep their own deadline (changed by hand or given a target date).":"");
    }catch(err){if(seq===previewSeq)box.textContent="Could not check open tickets: "+errText(err,"server unavailable")}
   },350);
  };
  const warn=()=>{const c=hours("crit"),m=hours("med"),w=o.querySelector("#dl-warn");if(w)w.textContent=c>m?"Note: Critical tickets would get more time than Medium ones.":"";preview()};
  o.addEventListener("input",warn);o.addEventListener("change",e=>{if(e.target.id!=="dl-apply")warn()});
  preview();
  o.querySelector("#dl-reset").onclick=()=>{[["crit",d.Critical],["med",d.Medium]].forEach(([k,v])=>{const days=v%24===0;document.getElementById("dl-"+k+"-n").value=days?v/24:v;document.getElementById("dl-"+k+"-u").value=days?"d":"h"});warn()};
  o.querySelector("#dl-save").onclick=async e=>{
   const btn=e.currentTarget,c=hours("crit"),m=hours("med");
   if(!Number.isFinite(c)||!Number.isFinite(m)){toast("Enter a whole number of hours or days for both priorities.");return}
   if(c>2160||m>2160){toast("A deadline can be at most 90 days.");return}
   const apply=!!(o.querySelector("#dl-apply")||{}).checked;
   if(apply&&!confirm("Move open tickets that still have the old default deadline? Each change is logged on the ticket."))return;
   btn.disabled=true;btn.textContent="Saving…";
   try{
    const r=await apiFetch("/api/issues/deadlines",{method:"PUT",body:{critical_hours:c,medium_hours:m,apply_to_open:apply}});
    applyDeadlines(r);
    const moved=r.open_tickets?r.open_tickets.moved:0;
    o.remove();toast("Deadlines saved — new tickets: "+window.s91DeadlineText()+(apply?" · "+moved+" open ticket"+(moved===1?"":"s")+" moved":"")+".");
    /* moved tickets show their new deadline on the next live refresh; ask for it once the dialog is gone */
    if(moved&&window.s91LiveRefresh)setTimeout(()=>window.s91LiveRefresh.tick(),7000);
    if(typeof render==="function")render();
   }catch(err){btn.disabled=false;btn.textContent="Save deadlines";toast(errText(err,"Could not save the deadlines."))}
  };
 };

 /* ---------- one edit dialog for details and dates ---------- */
 const pad=n=>String(n).padStart(2,"0");
 function localInput(value){const d=new Date(value);if(!value||isNaN(d.getTime()))return "";return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())+"T"+pad(d.getHours())+":"+pad(d.getMinutes())}
 function localDay(value){const d=new Date(value);if(!value||isNaN(d.getTime()))return String(value||"").slice(0,10);return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())}
 function editModal(){
  const t=issue((S.modalCtx||{}).id);
  if(!t){S.modal=null;return ""}
  if(!canEdit(t)){S.modal=null;toast(t.status==="Closed"?"A closed ticket can only be edited by the O&M Head.":"Only the O&M Head or this ticket's Assignee can edit it.");return ""}
  const verts=typeof VERTICALS!=="undefined"?VERTICALS:[t.vertical];
  const subs=["(none)"].concat((typeof SUBCATS!=="undefined"&&SUBCATS[t.vertical])||[]);
  const scopeNote=isHead()?"":'<p class="muted" style="font-size:12px;margin:0 0 10px">You can edit this ticket because it is assigned to you. Equipment changes must stay within your equipment types.</p>';
  const body='<div id="cc-edit-extra" hidden></div>'+scopeNote+
   '<div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Priority</span><select id="edit-tk-sev" class="inp">'+sevOpts(t.severity)+'</select></div>'+
   '<div class="field" style="flex:1"><span class="lbl">Issue type</span><select id="edit-tk-vert" class="inp">'+verts.map(v=>'<option'+(v===t.vertical?" selected":"")+'>'+text(v)+'</option>').join("")+'</select></div></div>'+
   '<div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Sub-category</span><select id="edit-tk-sub" class="inp">'+subs.map(s=>'<option'+((t.sub||"(none)")===s?" selected":"")+'>'+text(s)+'</option>').join("")+'</select></div>'+
   '<div class="field" style="flex:1"><span class="lbl">Equipment</span><input id="edit-tk-equip" class="inp" value="'+text(t.equip&&t.equip!=="—"?t.equip:"")+'" placeholder="e.g. INV-03"/></div></div>'+
   '<div class="field"><span class="lbl">Description</span><textarea id="edit-tk-desc" class="txt" rows="3">'+text(t.desc)+'</textarea></div>'+
   '<div class="field"><span class="lbl">Maker / manufacturer</span><input id="edit-tk-maker" class="inp" value="'+text(t.maker||"")+'" placeholder="e.g. Sungrow"/></div>'+
   (t.status!=="Closed"?'<div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Start date</span><input id="edit-tk-occurred" class="inp" type="date" value="'+text(localDay(t.occurred||t.created))+'"/></div>'+
   '<div class="field" style="flex:1"><span class="lbl">Deadline</span><input id="edit-tk-etc" class="inp" type="datetime-local" value="'+text(localInput(t.etc))+'"/></div></div>'+
   '<p id="edit-tk-etc-note" class="muted" style="font-size:12px;margin:-4px 0 8px" role="status" aria-live="polite"></p>':'')+
   '<div class="field"><span class="lbl">Reason for the change *</span><input id="edit-tk-reason" class="inp" maxlength="500" placeholder="e.g. Wrong priority entered / spare arrives Friday"/></div>'+
   '<p class="muted" style="font-size:12px;margin:4px 0 0">Saved on the ticket history with who changed what and why.</p>';
  return modal("Edit ticket",text(t.id)+" · "+text(t.plant||"")+" · "+text(t.status),body,
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" id="edit-tk-save" onclick="saveTicketEdit(\''+q(t.id)+'\')">Save changes</button>');
 }
 /* changing the priority moves an untouched deadline to that priority's default, so the change is visible before saving */
 document.addEventListener("change",e=>{
  if(S.modal!=="editTicket")return;
  const t=issue((S.modalCtx||{}).id);if(!t)return;
  if(e.target.id==="edit-tk-etc"){e.target.dataset.touched="1";return}
  if(e.target.id==="edit-tk-vert"){
   const s=document.getElementById("edit-tk-sub");
   if(s&&typeof SUBCATS!=="undefined"){const list=["(none)"].concat(SUBCATS[e.target.value]||[]);s.innerHTML=list.map(x=>'<option>'+text(x)+'</option>').join("");s.value="(none)"}
   return;
  }
  if(e.target.id!=="edit-tk-sev")return;
  const etc=document.getElementById("edit-tk-etc"),note=document.getElementById("edit-tk-etc-note");
  if(!etc||etc.dataset.touched)return;
  const sev=e.target.value,from=t.created||t.occurred||NOW_ISO;
  if(normalizeIssueSeverity(sev)===normalizeIssueSeverity(t.severity)){etc.value=localInput(t.etc);if(note)note.textContent="";return}
  const d=new Date(from);if(isNaN(d.getTime()))return;
  d.setHours(d.getHours()+etcHrs(sev));
  etc.value=localInput(d.toISOString());
  if(note)note.textContent="Deadline moved to the "+sev+" default ("+span(etcHrs(sev))+" after the ticket was raised). You can still change it.";
 });

 let saving=false;
 window.saveTicketEdit=async function(id){
  const t=issue(id);
  if(!canEdit(t)){toast(t&&!t.dbId?"This issue needs a fresh reload before it can be edited.":"Only the O&M Head or this ticket's Assignee can edit it.");return}
  if(saving)return;
  const body={},reason=val("edit-tk-reason").trim();
  if(reason.length<3){toast("Enter a short reason for the change.");return}
  const sev=val("edit-tk-sev"),desc=val("edit-tk-desc").trim(),maker=val("edit-tk-maker").trim(),eq=val("edit-tk-equip").trim(),vert=val("edit-tk-vert"),sub=val("edit-tk-sub");
  if(!desc){toast("The description cannot be empty.");return}
  if(sev&&normalizeIssueSeverity(sev)!==normalizeIssueSeverity(t.severity))body.severity=sev;
  if(desc!==(t.desc||""))body.description=desc;
  if(maker!==(t.maker||""))body.maker=maker;
  if(eq&&eq!==(t.equip||""))body.equipment_ref=eq;
  if(vert&&vert!==t.vertical)body.vertical=vert;
  const sv=(sub==="(none)"||!sub)?null:sub;if(document.getElementById("edit-tk-sub")&&sv!==(t.sub||null))body.subcategory=sv;
  const start=val("edit-tk-occurred"),etc=val("edit-tk-etc");
  if(/^\d{4}-\d{2}-\d{2}$/.test(start)&&start!==localDay(t.occurred||t.created))body.occurred_at=new Date(start+"T09:00").toISOString();
  if(etc&&etc!==localInput(t.etc)){const d=new Date(etc);if(isNaN(d.getTime())){toast("Enter a valid deadline.");return}body.etc_at=d.toISOString()}
  if(body.occurred_at||body.etc_at){
   const s=new Date(body.occurred_at||t.occurred||t.created),e=new Date(body.etc_at||t.etc);
   if(!isNaN(s.getTime())&&!isNaN(e.getTime())&&e<s){toast("The deadline cannot be before the start date.");return}
  }
  if(!Object.keys(body).length){S.modal=null;render();toast("Nothing was changed.");return}
  body.change_reason=reason;
  saving=true;const btn=document.getElementById("edit-tk-save");if(btn){btn.disabled=true;btn.textContent="Saving…"}
  try{
   const row=await apiFetch("/api/issues/"+encodeURIComponent(t.dbId),{method:"PATCH",body});
   if(typeof applyIssueRow==="function")applyIssueRow(row,t);
   if(typeof refreshIssueActivity==="function")refreshIssueActivity(id,false);
   S.modal=null;render();toast("Ticket "+id+" updated and logged.");
  }catch(e){
   if(btn){btn.disabled=false;btn.textContent="Save changes"}
   toast(errText(e,"Could not update the ticket."));
  }finally{saving=false}
 };

 /* ---------- close: verify a resolved ticket, or close directly with a reason ---------- */
 window.ccCloseDialog=function(id){
  const t=issue(id);if(!t)return;
  if(!canClose(t)){toast("Only the O&M Head or this ticket's Assignee can close it.");return}
  const resolved=t.status==="Resolved";
  const o=overlay("cc-close-ovl",(resolved?"Verify & close ":"Close ")+text(t.id)+"?",text(t.plant||"")+" · "+text(t.status)+(resolved?" · the fix was submitted":" · closes without the Resolve step"),
   '<div class="field" style="margin:0"><span class="lbl">'+(resolved?"Remarks (optional)":"Why is this ticket being closed? *")+'</span><textarea id="dc-rem" class="txt" rows="3" maxlength="2000" placeholder="'+(resolved?"e.g. Fix checked on site":"e.g. Duplicate of another ticket / fixed on call / not reproducible")+'"></textarea></div>'+
   '<p class="muted" style="font-size:12.5px;margin:10px 0 0">Recorded in the ticket history with your name. The O&amp;M Head can reopen it.</p>',
   '<button type="button" class="btn o" data-s91-x>Cancel</button><button type="button" class="btn p" id="dc-go">'+(resolved?"Verify &amp; close":"Close ticket")+'</button>');
  setTimeout(()=>{const a=document.getElementById("dc-rem");if(a)a.focus()},0);
  o.querySelector("#dc-go").onclick=()=>window.ccDirectClose(id);
 };
 window.ccDirectClose=async function(id){
  const t=issue(id);if(!t||t.status==="Closed")return;
  if(!canClose(t)){toast("Only the O&M Head or this ticket's Assignee can close it.");return}
  const resolved=t.status==="Resolved",remarks=val("dc-rem").trim(),btn=document.getElementById("dc-go");
  if(!resolved&&!remarks){toast("Enter the reason for closing this ticket.");return}
  if(btn&&btn.disabled)return;
  if(btn){btn.disabled=true;btn.textContent="Closing…"}
  const row=await postIssue(id,"/close",resolved?{note:remarks||"Verified and closed",closure:{}}:{note:remarks,direct:true,closure:{}});
  if(row){const o=document.getElementById("cc-close-ovl");if(o)o.remove();if(S.modal==="verify")S.modal=null;render();toast("Ticket "+id+" closed and logged.")}
  else if(btn){btn.disabled=false;btn.textContent=resolved?"Verify & close":"Close ticket"}
 };

 /* ---------- register the edit dialog ---------- */
 if(typeof renderModal==="function"){
  const base=renderModal;
  const wrapped=function(){if(S.modal==="editTicket")return editModal();return base.apply(this,arguments)};
  try{renderModal=wrapped}catch(e){}
  window.renderModal=wrapped;
 }
})();
