"use strict";
/* Site Issues & washing workflow hardening (loaded last, so it replaces the older browser-only handlers).

   Rules enforced here:
   - Every ticket change (assign, acknowledge, close, edit...) goes to the server; nothing is changed only on screen.
   - Assignees are real users with the Assignee role, taken from the database (/api/issues/assignees).
   - Only the O&M Head can assign, edit, close or move a ticket's stage; Assignees advance only their own tickets.
   - Dialogs keep what the person chose/typed when the page redraws in the background. */
(function(){
 const role=()=>(typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role)||"Viewer";
 const isHead=()=>role()==="O&M Head";
 const norm=v=>String(v||"").trim().toLowerCase();
 const text=v=>typeof esc==="function"?esc(v==null?"":String(v)):String(v==null?"":v);
 const issue=id=>(S.issues||[]).find(x=>x.id===id);
 const people=()=>Array.isArray(ISSUE_ASSIGNEES)?ISSUE_ASSIGNEES:[];
 const handles=(a,type)=>(a.equipment_types||[]).some(t=>norm(t)===norm(type));
 const headOnly=what=>{if(isHead())return true;toast("Only the O&M Head can "+what+".");return false};
 const field=id=>{const e=document.getElementById(id);return e?e.value:""};

 /* ---- Assignee drop-down: every active Assignee from the database; matching category first ---- */
 window.assigneeOptionsHtml=function(category,selected){
  const list=people().slice().sort((a,b)=>(handles(b,category)-handles(a,category))||String(a.name).localeCompare(String(b.name)));
  if(!list.length)return '<option value="" disabled>No user has the Assignee role yet — set roles in Settings → Team access</option>';
  return list.map(a=>{
   const fits=!category||handles(a,category);
   const label=a.name+(fits?"":(isHead()?" — category will be added to their scope":" — not assigned to this category"));
   return '<option value="'+text(a.id)+'"'+(selected===a.id?" selected":"")+((!fits&&!isHead())?" disabled":"")+'>'+text(label)+'</option>';
  }).join("");
 };
 window.issueAssigneeOptions=function(){
  const category=field("tk-vert")||((typeof VERTICALS!=="undefined"&&VERTICALS[0])||"");
  return '<option value="">Leave unassigned</option>'+assigneeOptionsHtml(category);
 };
 window.updIssueAssignees=function(){
  const sel=document.getElementById("tk-assignee");if(!sel)return;
  const prev=sel.value;sel.innerHTML=issueAssigneeOptions();
  if(prev&&Array.from(sel.options).some(o=>o.value===prev&&!o.disabled))sel.value=prev;
 };

 /* ---- Assign / reassign dialog ---- */
 function assignModal(){
  const ctx=S.modalCtx||{},t=issue(ctx.id);
  if(!t){S.modal=null;return ""}
  const who=ctx.who!==undefined?ctx.who:(t.assignedTo||"");
  const vendor=who==="__vendor";
  return modal("Assign & triage — "+t.id,"Choose the Assignee (a user with the Assignee role) responsible for resolution, or vendor/OEM support with an internal owner",
   '<div class="field"><span class="lbl">Assign to</span><select id="at-who" class="inp" onchange="atStore()"><option value="">Select an Assignee</option>'+assigneeOptionsHtml(t.vertical||"",who)+'<option value="__vendor"'+(vendor?" selected":"")+'>Vendor / OEM support (warranty / specialist)</option></select></div>'+
   '<div id="at-vf" style="display:'+(vendor?"grid":"none")+';border:1px dashed var(--warning);border-radius:10px;padding:12px;gap:10px" class="col">'+
   '<div class="field"><span class="lbl">Internal owner (tracks the ticket)</span><select id="at-owner" class="inp" onchange="atStore()"><option value="">Select an Assignee</option>'+assigneeOptionsHtml(t.vertical||"",ctx.owner||"")+'</select></div>'+
   '<div class="field"><span class="lbl">Vendor name</span><input id="at-vn" class="inp" placeholder="e.g. VoltEdge OEM" value="'+text(ctx.vn||"")+'" oninput="atStore()"/></div>'+
   '<div class="field"><span class="lbl">Vendor contact</span><input id="at-vc" class="inp" placeholder="Phone / email" value="'+text(ctx.vc||"")+'" oninput="atStore()"/></div>'+
   '<div class="field"><span class="lbl">Expected vendor response time</span><input id="at-vr" class="inp" placeholder="e.g. 48h engineer mobilisation" value="'+text(ctx.vr||"")+'" oninput="atStore()"/></div>'+
   '<div style="font-size:12.5px;color:var(--muted-foreground)">Ticket is tagged <b>Vendor-Dependent</b>; vendor response time is tracked separately.</div></div>'+
   (t.severity==="Critical"?'<div style="font-size:12px;font-weight:600;color:var(--danger)">Critical severity — the assignee is alerted immediately in addition to the app notification.</div>':""),
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="assignTicket()">Assign &amp; notify</button>');
 }
 window.atStore=function(){
  /* only read fields that are on screen; never overwrite a stored choice with an empty value */
  const next={};
  [["who","at-who"],["owner","at-owner"],["vn","at-vn"],["vc","at-vc"],["vr","at-vr"]].forEach(function(p){const e=document.getElementById(p[1]);if(e)next[p[0]]=e.value});
  S.modalCtx=Object.assign({},S.modalCtx,next);
  const box=document.getElementById("at-vf");
  if(box)box.style.display=(S.modalCtx.who==="__vendor")?"grid":"none";
 };
 window.assignTicket=async function(){
  if(!headOnly("assign tickets"))return;
  atStore();
  const ctx=S.modalCtx||{},t=issue(ctx.id);if(!t)return;
  let assigneeId=ctx.who,vendor=null;
  if(ctx.who==="__vendor"){
   assigneeId=ctx.owner;
   if(!(ctx.vn||"").trim()){toast("Enter the vendor name.");return}
   vendor={name:ctx.vn.trim(),contact:(ctx.vc||"—").trim()||"—",expected:(ctx.vr||"—").trim()||"—"};
  }
  if(!assigneeId){toast("Choose an Assignee.");return}
  const person=people().find(a=>a.id===assigneeId);
  const row=await postIssue(ctx.id,t.assignee?"/reassign":"/assign",{assigned_to:assigneeId,assignee_text:person?person.name:null,vendor,note:"Assignment changed from Solar91 Command Center"});
  if(row){S.modal=null;render();toast("Ticket assigned"+(person?" to "+person.name:"")+" and the Assignee was notified.")}
 };
 window.oiQuickAssign=async function(id){
  if(!headOnly("assign issues"))return;
  const who=field("oi-qa-"+id);
  if(!who){toast("Choose who to assign "+id+" to.");return}
  const t=issue(id);if(!t)return;
  const person=people().find(a=>a.id===who)||people().find(a=>norm(a.name)===norm(who));
  if(!person){toast("Choose an Assignee from the list.");return}
  const row=await postIssue(id,t.assignee?"/reassign":"/assign",{assigned_to:person.id,assignee_text:person.name,note:"Assigned from the triage queue"});
  if(row){render();toast(id+" assigned to "+person.name+" — notified.")}
 };

 /* ---- Bulk assign / bulk close ----
    Bulk assignment is ONE server request (POST /api/issues/bulk-assign, one transaction) instead of one per ticket. */
 const ASSIGNABLE=["Open","Assigned","Acknowledged"];
 function bulkAssignModal(){
  const ctx=S.modalCtx||{},tickets=(ctx.ids||[]).map(issue).filter(Boolean);
  const ok=tickets.filter(t=>ASSIGNABLE.includes(t.status)),un=ok.filter(t=>!t.assignee),taken=ok.filter(t=>t.assignee);
  const blocked=tickets.length-ok.length,send=ctx.reassign?ok.length:un.length;
  const types={};ok.forEach(t=>{const k=t.vertical||"Other";types[k]=(types[k]||0)+1});
  const typeList=Object.entries(types).sort((a,b)=>b[1]-a[1]);
  const person=people().find(a=>a.id===ctx.who);
  const missing=person?typeList.map(x=>x[0]).filter(k=>!handles(person,k)):[];
  const busy=!!ctx.busy;
  const body=(ctx.scope?'<div class="bn-info banner" style="margin-bottom:12px"><b>Tickets in view:</b> '+esc(ctx.scope)+'</div>':'')
   +'<div class="ba-sum"><div><b>'+un.length+'</b><span>unassigned</span></div><div><b>'+taken.length+'</b><span>already have someone</span></div>'+(blocked?'<div><b>'+blocked+'</b><span>work started / finished — skipped</span></div>':'')+'</div>'
   +(typeList.length?'<div class="ba-types">'+typeList.slice(0,8).map(([k,n])=>'<span class="ba-chip">'+esc(k)+' · '+n+'</span>').join("")+(typeList.length>8?'<span class="ba-chip">+'+(typeList.length-8)+' more</span>':'')+'</div>':'')
   +'<div class="field" style="margin-top:12px"><span class="lbl">Assign to</span><select id="ba-who" class="inp" '+(busy?'disabled ':'')+'onchange="S.modalCtx=Object.assign({},S.modalCtx,{who:this.value});render()"><option value="">Select an Assignee</option>'+assigneeOptionsHtml(typeList.length===1?typeList[0][0]:"",ctx.who||"")+'</select></div>'
   +(missing.length?'<div class="bn-warn banner" style="margin-top:10px">'+esc(person.name)+' does not cover <b>'+missing.map(esc).join(", ")+'</b> yet. Assigning gives them that equipment type at every plant, as with single assignment.</div>':'')
   +(taken.length?'<label class="ba-re"><input type="checkbox" '+(ctx.reassign?'checked ':'')+(busy?'disabled ':'')+'onchange="S.modalCtx=Object.assign({},S.modalCtx,{reassign:this.checked});render()"> Also reassign the '+taken.length+' ticket'+(taken.length===1?'':'s')+' that already have someone</label>':'');
  return modal("Assign tickets in bulk",send+" ticket"+(send===1?"":"s")+" will be assigned · the Assignee gets one notification",body,
   '<button class="btn o" '+(busy?'disabled ':'')+'onclick="closeModal()">Cancel</button><button class="btn p" '+(busy||!send?'disabled ':'')+(busy?'aria-busy="true" ':'')+'onclick="bulkAssignGo()">'+(busy?'Assigning…':'Assign '+send+' ticket'+(send===1?'':'s'))+'</button>');
 }
 window.ccBatchAssign=function(){
  if(!headOnly("assign tickets"))return;
  const set=S.ccBatch||new Set();if(!set.size)return;
  S.modal="bulkAssign";S.modalCtx={ids:Array.from(set),scope:set.size+" selected ticket"+(set.size===1?"":"s")};render();
 };
 window.bulkAssignGo=async function(){
  const ctx=S.modalCtx||{};if(ctx.busy)return;
  const person=people().find(a=>a.id===(field("ba-who")||ctx.who));
  if(!person){toast("Choose an Assignee.");return}
  const tickets=(ctx.ids||[]).map(issue).filter(t=>t&&ASSIGNABLE.includes(t.status)&&(ctx.reassign||!t.assignee));
  const ids=tickets.map(t=>t.dbId).filter(Boolean),stale=tickets.filter(t=>!t.dbId).map(t=>t.id);
  if(!ids.length){toast(stale.length?"Reload the page before assigning these tickets.":"Nothing to assign.");return}
  S.modalCtx=Object.assign({},ctx,{busy:true,who:person.id});render();
  let assigned=[],skipped=[];
  try{
   for(let i=0;i<ids.length;i+=500){
    const r=await apiFetch("/api/issues/bulk-assign",{method:"POST",body:{issue_ids:ids.slice(i,i+500),assigned_to:person.id,reassign:!!ctx.reassign}});
    assigned=assigned.concat(r.assigned||[]);skipped=skipped.concat(r.skipped||[]);
   }
  }catch(e){
   /* earlier batches (if any) were saved; show them and report the failure */
   assigned.forEach(row=>applyIssueRow(row,(S.issues||[]).find(x=>x.id===row.ticket_no)));
   S.modalCtx=Object.assign({},S.modalCtx,{busy:false});render();
   toast((assigned.length?assigned.length+" assigned, then it stopped: ":"Not assigned — ")+(e.message||"error"));return;
  }
  assigned.forEach(row=>applyIssueRow(row,(S.issues||[]).find(x=>x.id===row.ticket_no)));
  S.ccBatch=new Set();S.modal=null;S.modalCtx=null;render();
  const skip=skipped.concat(stale.map(id=>({ticket_no:id,reason:"reload needed"})));
  toast(assigned.length+" ticket"+(assigned.length===1?"":"s")+" assigned to "+person.name+(skip.length?" · "+skip.length+" not changed: "+skip.slice(0,4).map(x=>(x.ticket_no||"?")+" ("+x.reason+")").join(", ")+(skip.length>4?" …":""):""));
 };
 window.ccBatchClose=async function(){
  if(!headOnly("close tickets"))return;
  const set=S.ccBatch||new Set();if(!set.size)return;
  const reason=(prompt("Close "+set.size+" ticket(s). Verified tickets are closed normally; others are closed directly and need a reason:")||"").trim();
  if(!reason){toast("A reason is required to close tickets.");return}
  let ok=0;const failed=[];
  for(const id of Array.from(set)){
   const t=issue(id);if(!t||t.status==="Closed")continue;
   const row=await postIssue(id,"/close",{note:reason,direct:t.status!=="Resolved",closure:{}});
   if(row)ok++;else failed.push(id);
  }
  S.ccBatch=new Set();render();
  toast(ok+" ticket(s) closed"+(failed.length?" · not closed: "+failed.join(", "):""));
 };

 /* ---- Close directly / edit / move stage (O&M Head only) ---- */
 window.ccCloseDialog=(function(orig){return function(id){if(!headOnly("close tickets"))return;return orig.apply(this,arguments)}})(window.ccCloseDialog||function(){});
 window.ccDirectClose=async function(id){
  if(!headOnly("close a ticket directly"))return;
  const t=issue(id);if(!t||t.status==="Closed")return;
  const remarks=field("dc-rem").trim();
  if(!remarks){toast("Enter the reason for closing this ticket directly.");return}
  const row=await postIssue(id,"/close",{note:remarks,direct:true,closure:{}});
  if(row){S.modal=null;render();toast("Ticket "+id+" closed directly and audited.")}
 };
 window.saveTicketEdit=async function(id){
  if(!headOnly("edit tickets"))return;
  const t=issue(id);if(!t||!t.dbId){toast("This issue needs a fresh server reload before it can be edited.");return}
  const body={},set=(k,v)=>{if(v!==undefined&&v!==null)body[k]=v};
  const sev=field("edit-tk-sev"),desc=field("edit-tk-desc").trim(),maker=field("edit-tk-maker").trim(),oc=field("edit-tk-occurred"),eq=field("edit-tk-equip").trim(),vert=field("edit-tk-vert"),sub=field("edit-tk-sub");
  const correctionReason=field("edit-tk-reason").trim();
  if(document.getElementById("edit-tk-reason")&&correctionReason.length<5){toast("Enter a short correction reason.");return}
  if(correctionReason)set("change_reason",correctionReason);
  if(sev&&sev!==t.severity)set("severity",sev);
  if(document.getElementById("edit-tk-desc")){if(!desc){toast("The description cannot be empty.");return}if(desc!==t.desc)set("description",desc)}
  if(document.getElementById("edit-tk-maker")&&maker!==(t.maker||""))set("maker",maker);
  if(/^\d{4}-\d{2}-\d{2}$/.test(oc))set("occurred_at",oc+"T09:00:00");
  if(eq&&eq!==(t.equip||""))set("equipment_ref",eq);
  if(vert&&vert!==t.vertical)set("vertical",vert);
  if(document.getElementById("edit-tk-sub")){const sv=(sub==="(none)"||sub==="")?null:sub;if(sv!==(t.sub||null))set("subcategory",sv)}
  if(Object.keys(body).every(k=>k==="change_reason")){S.modal=null;render();toast("No field changes to save.");return}
  try{
   const row=await apiFetch("/api/issues/"+encodeURIComponent(t.dbId),{method:"PATCH",body});
   applyIssueRow(row,t);S.modal=null;render();toast("Ticket "+id+" updated.");
  }catch(e){toast(e.message||"Could not update the ticket.")}
 };
 /* the clickable stage strip: map each click to the real workflow step instead of rewriting the status on screen */
 window.omHeadMoveTicket=function(id,next){
  if(!headOnly("change ticket stage"))return;
  const t=issue(id);if(!t||t.status===next)return;
  if(next==="Assigned"){openModal("assign",{id});return}
  if(next==="Acknowledged"){if(["Assigned","Open"].includes(t.status)&&t.assignee)ackTicket(id);else toast("Assign the ticket to an Assignee first.");return}
  if(next==="In Progress"){if(t.status==="Acknowledged")startTicket(id);else if(t.status==="Pending Vendor")resumeTicket(id);else toast("Acknowledge the ticket first.");return}
  if(next==="Resolved"){if(["In Progress","Pending Vendor"].includes(t.status))openModal("resolve",{id});else toast("Work must be in progress before it can be resolved.");return}
  if(next==="Closed"){if(t.status==="Resolved")openModal("verify",{id});else if(typeof ccCloseDialog==="function")ccCloseDialog(id);return}
  toast("Use the ticket buttons to move this ticket forward.");
 };


 /* ---- Change a ticket's start date and deadline: O&M Head, or the Assignee the ticket is assigned to (never a Site Engineer) ---- */
 const myId=()=>(typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.userId)||null;
 const canChangeDates=t=>{if(!t||!t.dbId||t.status==="Closed")return false;if(isHead())return true;return role()==="Assignee"&&!!t.assignedTo&&String(t.assignedTo)===String(myId())};
 const isoDay=v=>{if(!v)return "";const d=new Date(v);if(isNaN(d.getTime()))return String(v).slice(0,10);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")};
 window.ticketDatesOpen=function(id){const t=issue(id);if(!canChangeDates(t)){toast("Only the O&M Head or the assigned Assignee can change a ticket's dates.");return}S.modal="ticketDates";S.modalCtx={id};render()};
 function ticketDatesModal(){
  const t=issue((S.modalCtx||{}).id);if(!t){S.modal=null;return ""}
  return modal("Change start date / deadline",text(t.id)+" · "+text(t.plant||"")+" · "+text(t.vertical||""),
   '<div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Start date</span><input id="td-start" class="inp" type="date" value="'+text(isoDay(t.occurred||t.created))+'"/></div>'+
   '<div class="field" style="flex:1"><span class="lbl">Deadline (ETC)</span><input id="td-etc" class="inp" type="date" value="'+text(isoDay(t.etc))+'"/></div></div>'+
   '<div class="field"><span class="lbl">Reason *</span><input id="td-reason" class="inp" maxlength="500" placeholder="e.g. Spare part arrives later"/></div>'+
   '<div class="muted" style="font-size:12.5px;margin-top:8px">Logged on the ticket history with who changed it and why. Site Engineers cannot change ticket dates.</div>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="ticketDatesSave(\''+text(t.id)+'\')">Save dates</button>');
 }
 window.ticketDatesSave=async function(id){
  const t=issue(id);if(!canChangeDates(t)){toast("You cannot change this ticket's dates.");return}
  const start=field("td-start"),etc=field("td-etc"),reason=field("td-reason").trim(),body={};
  if(reason.length<3){toast("Enter the reason for the date change.");return}
  if(start&&start!==isoDay(t.occurred||t.created))body.occurred_at=start+"T09:00:00";
  if(etc&&etc!==isoDay(t.etc))body.etc_at=etc+"T18:00:00";
  if(start&&etc&&etc<start){toast("The deadline cannot be before the start date.");return}
  if(!Object.keys(body).length){S.modal=null;render();toast("No date changes to save.");return}
  body.reason=reason;
  try{const row=await apiFetch("/api/issues/"+encodeURIComponent(t.dbId)+"/dates",{method:"PATCH",body});applyIssueRow(row,t);S.modal=null;render();toast("Ticket "+id+" dates updated.")}
  catch(e){toast((e&&e.data&&typeof e.data.detail==="string"&&e.data.detail)||e.message||"Could not change the dates.")}
 };
 /* add the button to the ticket drawer for the people allowed to use it */
 new MutationObserver(function(){
  if(S.modal!=="ticket"||!S.modalCtx)return;
  const t=issue(S.modalCtx.id),foot=document.querySelector(".modal .modal-f");
  if(!t||!foot||document.getElementById("td-open-btn")||!canChangeDates(t))return;
  const b=document.createElement("button");b.id="td-open-btn";b.className="btn o sm";b.textContent="Change dates";
  b.addEventListener("click",function(e){e.stopPropagation();ticketDatesOpen(t.id)});
  foot.insertBefore(b,foot.firstChild);
 }).observe(document.body,{childList:true,subtree:true});
 /* ---- show the right dialogs ---- */
 const baseRenderModal=window.renderModal||(typeof renderModal==="function"?renderModal:null);
 if(baseRenderModal){
  const wrapped=function(){
   if(S.modal==="assign")return assignModal();
   if(S.modal==="bulkAssign")return bulkAssignModal();
   if(S.modal==="ticketDates")return ticketDatesModal();
   return baseRenderModal.apply(this,arguments);
  };
  try{renderModal=wrapped}catch(e){}
  window.renderModal=wrapped;
 }

 /* the older "Close Ticket" button injected into the ticket drawer is for the O&M Head only */
 new MutationObserver(function(){
  if(isHead())return;
  const b=document.getElementById("cc-close-btn");if(b)b.remove();
 }).observe(document.body,{childList:true,subtree:true});
})();
