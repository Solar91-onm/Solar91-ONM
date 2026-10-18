"use strict";
/* Site Issues — Ticket desk.
   Replaces the long ticket drawer with one screen-sized view: the facts on the left and the ticket
   conversation on the right. The conversation is the workflow: Site Engineers post updates and report
   work done, the Assignee confirms and moves the ticket forward (Acknowledge → Start → Resolve), and the
   O&M Head can read everything and verify/close. Messages and status changes are the ticket's issue_history
   rows on the server, so the whole thread stays in the database; closing the ticket locks the conversation.
   Permissions are unchanged: every button calls the existing server endpoints, which enforce role and scope. */
(function(){
 if(typeof renderModal!=="function")return;
 const role=()=>(typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role)||"Viewer";
 const me=()=>(typeof AUTH_IDENTITY!=="undefined"&&(AUTH_IDENTITY.name||""))||"";
 const isHead=()=>role()==="O&M Head";
 const issue=id=>(S.issues||[]).find(x=>x.id===id);
 const q=s=>String(s==null?"":s).replace(/\\/g,"\\\\").replace(/'/g,"\\'");
 const PRI={Critical:"#DC4C3E",High:"#DC4C3E",Medium:"#3B82F6",Low:"#94A3B8"};
 const STEPS=[["Open","Open"],["Acknowledged","Acknowledged"],["In Progress","In progress"],["Pending Vendor","Waiting parts"],["Resolved","Resolved"],["Closed","Closed"]];
 const INTENT={work_done:["Work done","✓"],question:["Question","?"],blocked:["Blocked","!"],confirm:["Confirmed","✓"]};
 const drafts=()=>{if(!S._idkDraft)S._idkDraft={};return S._idkDraft};

 function mineAssigned(t){
  const uid=typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.userId;
  if(t.assignedTo&&uid)return String(t.assignedTo)===String(uid);
  return !!t.assignee&&String(t.assignee).trim().toLowerCase()===me().trim().toLowerCase();
 }
 const canWork=t=>isHead()||(role()==="Assignee"&&mineAssigned(t));
 const canMessage=()=>["O&M Head","Assignee","Site Engineer"].includes(role());
 const stepIndex=s=>{const i=STEPS.findIndex(x=>x[0]===s);return s==="Assigned"?0:i<0?0:i};
 const timeOf=v=>{try{const d=new Date(v);return isNaN(d)?"":d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}catch(e){return ""}};
 const dayOf=v=>{try{const d=new Date(v);if(isNaN(d))return "";const k=d.toISOString().slice(0,10);return k===TODAY?"Today":k===addDays(TODAY,-1)?"Yesterday":d.toLocaleDateString([],{day:"numeric",month:"short",year:"numeric"})}catch(e){return ""}};
 const ini=n=>typeof ccIni==="function"?ccIni(n||"?"):String(n||"?").slice(0,2).toUpperCase();

 /* ---------------- conversation ---------------- */
 function lastStatusChangeAt(acts){let at="";acts.forEach(a=>{if(a.status_to)at=a.at||at});return at}
 function eventText(a){
  const who=esc(a.actor||"System"),note=a.note?' — '+esc(String(a.note).slice(0,240)):"";
  switch(a.action){
   case "issue.created":return "Ticket raised by "+who;
   case "issue.assigned":return "Assigned"+(a.metadata&&a.metadata.to_assignee?" to <b>"+esc(a.metadata.to_assignee)+"</b>":"")+" by "+who;
   case "issue.reassigned":return "Reassigned"+(a.metadata&&a.metadata.to_assignee?" to <b>"+esc(a.metadata.to_assignee)+"</b>":"")+" by "+who;
   case "issue.status_changed":return "<b>"+esc(a.status_to==="Pending Vendor"?"Waiting for parts / vendor":a.status_to||"Status changed")+"</b> · "+who+note;
   case "issue.closed":case "issue.closed_directly":return "<b>Closed</b> by "+who+note;
   case "issue.reopened":return "<b>Reopened</b> by "+who+note;
   case "issue.reset":return "Reset to Open by "+who;
   case "issue.etc_changed":return "Deadline changed by "+who+note;
   case "issue.dates_changed":return "Dates changed by "+who+note;
   case "issue.edited":return "Details corrected by "+who+note;
   case "issue.evidence_uploaded":return who+" added photos";
   case "issue.deleted":return "Moved to Deleted by "+who+note;
   case "issue.restored":return "Restored by "+who+note;
   default:
    if(/^issue\.step_/.test(a.action))return "Work step "+esc(a.action.replace("issue.step_","").replace(/_/g," "))+" · "+who+note;
    if(a.status_to)return "<b>"+esc(a.status_to)+"</b> · "+who+note;
    return esc(String(a.action||"").replace(/^issue\./,"").replace(/_/g," "))+" · "+who+note;
  }
 }
 function photoStrip(t,ids){
  const ev=(t.evidence||[]).filter(e=>(ids||[]).includes(e.id));
  if(!ev.length)return "";
  return '<div class="idk-ph">'+ev.map(e=>'<button type="button" title="'+esc(e.name||"Photo")+'" onclick="openIssueEvidence(\''+q(t.id)+'\',\''+q(e.id)+'\')"><img alt="" loading="lazy" src="'+esc(e.url)+'" onerror="this.replaceWith(document.createTextNode(\'📷\'))"/></button>').join("")+'</div>';
 }
 function threadHtml(t){
  if(!t.dbId)return '<div class="idk-empty">Conversation is available once this ticket is saved on the server.</div>';
  if(!t.activityLoaded&&(t.activityLoading||!t.activityError))return '<div class="idk-empty"><span class="idk-spin"></span> Loading conversation…</div>';
  if(t.activityError&&!(t.activity||[]).length)return '<div class="idk-empty idk-err">'+esc(t.activityError)+' <button type="button" class="btn o sm" onclick="refreshIssueActivity(\''+q(t.id)+'\',true)">Retry</button></div>';
  const acts=(t.activity||[]).slice().sort((a,b)=>String(a.at).localeCompare(String(b.at)));
  if(!acts.length)return '<div class="idk-empty">No messages yet. Start the conversation below.</div>';
  let h="",day="";const mine=me().trim().toLowerCase();
  acts.forEach(a=>{
   const d=dayOf(a.at);if(d&&d!==day){day=d;h+='<div class="idk-day"><span>'+esc(d)+'</span></div>'}
   if(a.action==="issue.message"){
    const own=String(a.actor||"").trim().toLowerCase()===mine,m=a.metadata||{},it=INTENT[m.intent];
    h+='<div class="idk-msg'+(own?" own":"")+(it?" it-"+m.intent:"")+'">'+(own?"":'<span class="idk-av" title="'+esc(a.actor||"")+'">'+esc(ini(a.actor))+'</span>')+
     '<div class="idk-bub"><div class="idk-meta"><b>'+esc(own?"You":(a.actor||"Someone"))+'</b>'+(m.role?'<span>'+esc(m.role)+'</span>':'')+(it?'<em>'+it[1]+' '+esc(it[0])+'</em>':'')+'<time>'+esc(timeOf(a.at))+'</time></div>'+
     (a.note&&a.note!=="Shared photo update"?'<p>'+esc(a.note)+'</p>':'')+photoStrip(t,m.evidence_ids)+'</div></div>';
   }else if(a.action==="issue.progress"){
    const m=a.metadata||{};
    h+='<div class="idk-log"><div class="idk-meta"><b>'+esc(a.actor||"")+'</b><span>Work log</span><time>'+esc(timeOf(a.at))+'</time></div><p>'+esc(a.note||"Work update")+'</p>'+
     '<small>'+[a.day_status&&a.day_status!=="Worked"?esc(a.day_status):"",m.hours?esc(m.hours)+" h":"",m.parts&&m.parts!=="—"?"Parts: "+esc(m.parts):"",a.next_step?"Next: "+esc(a.next_step):""].filter(Boolean).join(" · ")+'</small></div>';
   }else if(a.action==="issue.evidence_uploaded"){
    const ids=(a.metadata||{}).evidence_ids||[];
    h+='<div class="idk-ev"><span>'+eventText(a)+' · '+esc(timeOf(a.at))+'</span>'+photoStrip(t,ids)+'</div>';
   }else{
    h+='<div class="idk-ev'+(a.status_to?" st":"")+'"><span>'+eventText(a)+' · '+esc(timeOf(a.at))+'</span></div>';
   }
  });
  return h;
 }

 /* ---------------- next step + actions (the workflow, from the conversation) ---------------- */
 function nextStep(t){
  const who=t.assignee?esc(t.assignee):"the Assignee",acts=t.activity||[];
  const since=lastStatusChangeAt(acts);
  const done=acts.filter(a=>a.action==="issue.message"&&(a.metadata||{}).intent==="work_done"&&String(a.at)>=String(since)).pop();
  const b=(l,fn,cls)=>'<button type="button" class="btn sm '+(cls||"p")+'" onclick="'+fn+'">'+l+'</button>';
  const id=q(t.id),work=canWork(t);let text="",btns="";
  if(t.status==="Closed"){text="Closed by the O&M Head. The conversation is read-only; the full history is kept.";if(isHead())btns=b("Reopen","openModal('reopen',{id:'"+id+"'})","o")}
  else if(t.status==="Open"&&!t.assignee){text="Needs an owner. The O&M Head assigns an Assignee.";if(isHead())btns=b("Assign owner","openModal('assign',{id:'"+id+"'})")}
  else if(t.status==="Open"||t.status==="Assigned"){text="Waiting for <b>"+who+"</b> to acknowledge.";if(work)btns=b("Acknowledge","idkAct('"+id+"','ack')")}
  else if(t.status==="Acknowledged"){text="<b>"+who+"</b> acknowledged. Work starts next.";if(work)btns=b("Start work","idkAct('"+id+"','start')")}
  else if(t.status==="In Progress"){
   text=done?"<b>"+esc(done.actor||"Site engineer")+"</b> reported the work is done. "+(work?"Check it and submit the resolution.":"Waiting for "+who+" to confirm."):"Work in progress. Site Engineers post updates here; <b>"+who+"</b> confirms.";
   if(work)btns=b(done?"Confirm & resolve":"Submit resolution","openModal('resolve',{id:'"+id+"'})")+b("Log work","openModal('progress',{id:'"+id+"'})","o")+b("Waiting for parts","idkAct('"+id+"','pending')","o");
  }
  else if(t.status==="Pending Vendor"){text="On hold, waiting for parts or the vendor.";if(work)btns=b("Resume work","idkAct('"+id+"','resume')")+b("Submit resolution","openModal('resolve',{id:'"+id+"'})","o")}
  else if(t.status==="Resolved"){text="Fix submitted. Waiting for the O&M Head to verify and close.";if(isHead())btns=b("Verify & close","openModal('verify',{id:'"+id+"'})")+b("Reopen","openModal('reopen',{id:'"+id+"'})","o")}
  return '<div class="idk-next'+(done&&t.status==="In Progress"?" hot":"")+'"><span class="idk-next-t">'+text+'</span>'+(btns?'<span class="idk-next-a">'+btns+'</span>':'')+'</div>';
 }
 function composerHtml(t){
  if(t.status==="Closed")return "";
  if(!canMessage()||!t.dbId)return '<div class="idk-ro">You can read this conversation. Only the O&M Head, the Assignee and Site Engineers can post.</div>';
  const r=role(),chips=r==="Site Engineer"?[["update","Update"],["work_done","✓ Work done"],["question","Need help"],["blocked","Blocked"]]:r==="Assignee"?[["update","Update"],["confirm","✓ Confirm work"],["question","Question"]]:[["update","Update"],["question","Question"]];
  const cur=(S._idkIntent||{})[t.id]||"update",remaining=Math.max(0,10-(t.evidence||[]).length);
  return '<div class="idk-comp"><div class="idk-chips" role="radiogroup" aria-label="Message type">'+chips.map(([k,l])=>'<button type="button" role="radio" aria-checked="'+(cur===k)+'" class="'+(cur===k?"on":"")+'" onclick="idkIntent(\''+q(t.id)+'\',\''+k+'\')">'+esc(l)+'</button>').join("")+'</div>'+
   '<div class="idk-in"><label class="idk-att" title="Attach photos ('+remaining+' left)"><span>📎</span><input id="idk-photos" type="file" accept="image/jpeg,image/png,image/webp" multiple '+(remaining?"":"disabled ")+'onchange="idkPhotos(this)"/></label>'+
   '<textarea id="idk-msg" rows="1" maxlength="4000" placeholder="'+esc(cur==="work_done"?"What was done? e.g. Replaced fuse on INV-02, unit back online":"Write an update…")+'" oninput="idkDraft(\''+q(t.id)+'\',this)" onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();idkSend(\''+q(t.id)+'\')}">'+esc(drafts()[t.id]||"")+'</textarea>'+
   '<button type="button" class="btn p idk-send" id="idk-send" onclick="idkSend(\''+q(t.id)+'\')" aria-label="Send">Send</button></div><small id="idk-photo-note" class="idk-note">Enter to send · Shift+Enter for a new line</small></div>';
 }

 /* ---------------- left column ---------------- */
 function factsHtml(t){
  const p=typeof plantRec==="function"?plantRec(t.plant):null,sla=slaState(t),units=Array.isArray(t.units)&&t.units.length?t.units.map(u=>u.code||u.name):(t.equip&&t.equip!=="—"?String(t.equip).split(/\s*,\s*/):[]);
  const acts=t.activity||[],logs=acts.filter(a=>a.action==="issue.progress"),hours=logs.reduce((s,a)=>s+Number((a.metadata||{}).hours||0),0);
  const daysWorked=new Set(logs.map(a=>a.work_date||String(a.at||"").slice(0,10))).size;
  const kv=(k,v)=>'<div class="idk-kv"><span>'+k+'</span><b>'+v+'</b></div>';
  let h='<div class="idk-facts">'+
   kv("Plant",esc(p?p.id+" · "+p.name:t.plant||"—"))+
   kv("Owner",t.assignee?'<span class="idk-who"><i>'+esc(ini(t.assignee))+'</i>'+esc(t.assignee)+'</span>':'<span class="idk-un">Unassigned</span>')+
   kv("Due",t.etc?esc(fmtDT(t.etc))+(sla==="breach"?' <em class="idk-od">Overdue</em>':''):"—")+
   kv("Age",esc(issueAgeDays(t)+" day"+(issueAgeDays(t)===1?"":"s")))+'</div>';
  if(units.length)h+='<div class="idk-sec"><h4>'+(units.length>1?units.length+" units affected":"Unit")+'</h4><div class="idk-units">'+units.map(u=>'<span>'+esc(u)+'</span>').join("")+'</div></div>';
  h+='<div class="idk-sec"><h4>What happened</h4><p class="idk-desc">'+esc(t.desc||"—")+'</p></div>';
  const ev=t.evidence||[];
  h+='<div class="idk-sec"><h4>Photos <small>'+ev.length+'/10</small></h4>'+(ev.length?'<div class="idk-ph big">'+ev.map(e=>'<button type="button" title="'+esc(e.name||"Photo")+'" onclick="openIssueEvidence(\''+q(t.id)+'\',\''+q(e.id)+'\')"><img alt="" loading="lazy" src="'+esc(e.url)+'" onerror="this.replaceWith(document.createTextNode(\'📷\'))"/></button>').join("")+'</div>':'<p class="idk-muted">No photos yet.</p>')+
   (canMessage()&&t.dbId&&ev.length<10&&t.status!=="Closed"?'<label class="btn o sm idk-add">+ Add photos<input type="file" accept="image/jpeg,image/png,image/webp" multiple onchange="uploadMoreIssuePhotos(\''+q(t.id)+'\',this)"/></label>':'')+'</div>';
  h+='<div class="idk-stats"><div><b>'+(t.status==="Closed"&&t.closure&&t.closure.daysOpen?esc(t.closure.daysOpen):Math.max(1,issueAgeDays(t)+1))+'</b><small>days open</small></div><div><b>'+daysWorked+'</b><small>days worked</small></div><div><b>'+(Math.round(hours*10)/10)+'</b><small>hours logged</small></div></div>';
  const more=[["Issue type",t.vertical+(t.sub?" · "+t.sub:"")],["Priority",t.severity],["Occurred",fmtDT(t.occurred||t.created)],["Raised",fmtDT(t.created)],["Maker",t.maker],["Supplier",t.supplier],["Serial number",t.serialNumber]].filter(x=>x[1]&&x[1]!=="—");
  h+='<details class="idk-more"><summary>More details</summary>'+more.map(x=>kv(x[0],esc(x[1]))).join("")+
   (t.vendor?'<div class="idk-vendor"><b>Vendor:</b> '+esc(t.vendor.name)+' · '+esc(t.vendor.contact||"")+' · expected '+esc(t.vendor.expected||"—")+'</div>':'')+
   (t.closure&&(t.closure.rootCause||t.closure.root_cause)?'<div class="idk-closure"><b>Root cause:</b> '+esc(t.closure.rootCause||t.closure.root_cause)+'<br><b>Fix:</b> '+esc(t.closure.corrective||t.closure.corrective_action||"—")+'</div>':'')+
   (typeof m26IssStepsHtml==="function"?m26IssStepsHtml(t):"")+'</details>';
  return h;
 }
 function moreMenu(t){
  const id=q(t.id),items=[];
  const it=(l,fn,cls)=>items.push('<button type="button" class="'+(cls||"")+'" onclick="this.closest(\'details\').open=false;'+fn+'">'+l+'</button>');
  if(isHead()){
   if(t.status!=="Closed"&&t.assignee)it("Reassign","openModal('assign',{id:'"+id+"'})");
   it("Edit details","openModal('editTicket',{id:'"+id+"'})");
   if(t.status!=="Closed"&&typeof ticketDatesOpen==="function")it("Change dates","ticketDatesOpen('"+id+"')");
   if(t.status!=="Closed"&&t.assignee&&typeof ccRequestUpdate==="function")it("Ask owner for an update","ccRequestUpdate('"+id+"')");
   if(t.status!=="Closed"&&t.status!=="Resolved"&&typeof ccCloseDialog==="function")it("Close without resolution…","ccCloseDialog('"+id+"')");
   if((t.status!=="Open"||t.assignee)&&typeof m26ResetIssue==="function")it("Reset to Open","m26ResetIssue('"+id+"')","warn");
   if(t.dbId&&typeof s91ConfirmDeleteIssue==="function")it("Move to Deleted","s91ConfirmDeleteIssue('"+id+"')","danger");
  }else if(role()==="Assignee"&&mineAssigned(t)&&t.status!=="Closed"&&typeof ticketDatesOpen==="function")it("Change dates","ticketDatesOpen('"+id+"')");
  const pr=typeof plantRec==="function"?plantRec(t.plant):null;
  if(pr&&typeof openPlantPage==="function")it("Open plant page","closeModal();openPlantPage('"+q(pr.id)+"')");
  if(!items.length)return "";
  return '<details class="idk-menu"><summary aria-label="More actions" title="More actions">⋯</summary><div>'+items.join("")+'</div></details>';
 }
 function deskHtml(t){
  const pri=t.severity==="High"?"Critical":t.severity,si=stepIndex(t.status),p=typeof plantRec==="function"?plantRec(t.plant):null;
  const steps='<ol class="idk-steps">'+STEPS.map((s,i)=>{if(i===3&&t.status!=="Pending Vendor")return "";const st=i<si?"done":i===si?"now":"";return '<li class="'+st+'"><i>'+(i<si?"✓":"")+'</i>'+esc(s[1])+'</li>'}).join("")+'</ol>';
  const n=(t.activity||[]).filter(a=>a.action==="issue.message").length;
  return '<div class="idk-ov" onclick="if(event.target===this)closeModal()"><div class="idk" role="dialog" aria-modal="true" aria-label="Ticket '+esc(t.id)+'">'+
   '<header class="idk-h"><div class="idk-title"><span class="idk-pri" style="--c:'+(PRI[pri]||"#94A3B8")+'"><i></i>'+esc(pri)+'</span><h2>'+esc(t.id)+' <span>· '+esc(t.vertical||"Issue")+'</span></h2><p>'+esc(p?p.id+" · "+p.name:t.plant||"")+'</p></div>'+
   '<div class="idk-h-a">'+badge(t.status==="Pending Vendor"?"Pending Parts/Vendor":t.status)+moreMenu(t)+'<button type="button" class="idk-x" onclick="closeModal()" aria-label="Close">×</button></div></header>'+
   steps+
   '<div class="idk-body"><aside class="idk-side">'+factsHtml(t)+'</aside>'+
   '<section class="idk-chat" aria-label="Ticket conversation"><div class="idk-chat-h"><b>Conversation</b><span>'+n+' message'+(n===1?"":"s")+' · saved to this ticket</span><button type="button" class="btn g sm" onclick="refreshIssueActivity(\''+q(t.id)+'\',true)" title="Refresh">↻</button></div>'+
   '<div class="idk-thread" id="idk-thread" onscroll="idkScroll(this)">'+threadHtml(t)+'</div>'+nextStep(t)+composerHtml(t)+'</section></div></div></div>';
 }

 /* ---------------- actions ---------------- */
 window.idkDraft=function(id,el){drafts()[id]=el.value;el.style.height="auto";el.style.height=Math.min(140,el.scrollHeight)+"px"};
 window.idkIntent=function(id,k){S._idkIntent=Object.assign({},S._idkIntent,{[id]:k});render();const m=document.getElementById("idk-msg");if(m)m.focus()};
 window.idkScroll=function(el){S._idkStick=el.scrollHeight-el.scrollTop-el.clientHeight<60};
 window.idkPhotos=function(input){
  const t=issue((S.modalCtx||{}).id),files=Array.from(input.files||[]),left=Math.max(0,10-((t&&t.evidence)||[]).length),note=document.getElementById("idk-photo-note");
  if(files.length>left){input.value="";toast("This ticket can have no more than 10 photos ("+left+" left).");return}
  if(note)note.textContent=files.length?files.length+" photo"+(files.length===1?"":"s")+" attached — press Send":"Enter to send · Shift+Enter for a new line";
 };
 let sending=false;
 async function postMessage(t,message,intent,input){
  let saved=[];
  if(input&&input.files&&input.files.length){saved=await uploadIssuePhotos(t,input);t.evidence=(t.evidence||[]).concat(saved);t.photos=t.evidence.length;input.value=""}
  const row=await apiFetch("/api/issues/"+encodeURIComponent(t.dbId)+"/comments",{method:"POST",body:{message,evidence_ids:saved.map(x=>x.id),intent}});
  t.activity=(t.activity||[]).concat([row]);t.activityLoaded=true;return row;
 }
 window.idkSend=async function(id){
  const t=issue(id);if(!t||!t.dbId||sending)return;
  const box=document.getElementById("idk-msg"),input=document.getElementById("idk-photos"),message=((box&&box.value)||"").trim();
  const intent=(S._idkIntent||{})[id]||"update";
  if(!message&&!(input&&input.files&&input.files.length)){toast(intent==="work_done"?"Describe the work that was done.":"Write a message or attach a photo.");if(box)box.focus();return}
  sending=true;const btn=document.getElementById("idk-send");if(btn){btn.disabled=true;btn.textContent="Sending…"}
  try{
   await postMessage(t,message,intent,input);
   drafts()[id]="";S._idkIntent=Object.assign({},S._idkIntent,{[id]:"update"});S._idkStick=true;
   render();toast(intent==="work_done"?"Work reported — the Assignee will confirm.":"Message saved to the ticket.");
  }catch(e){toast(e.message||"Could not send the message. It was not saved.");if(btn){btn.disabled=false;btn.textContent="Send"}}
  finally{sending=false}
 };
 /* Workflow steps from the conversation: a typed message is saved first, then the step is taken. */
 window.idkAct=async function(id,step){
  const t=issue(id);if(!t||sending)return;
  const box=document.getElementById("idk-msg"),message=((box&&box.value)||"").trim();
  sending=true;
  try{
   if(message&&(step==="ack"||step==="start")){await postMessage(t,message,"confirm",document.getElementById("idk-photos"));drafts()[id]=""}
   let row=null;
   if(step==="ack")row=await postIssue(id,"/acknowledge");
   else if(step==="start")row=await postIssue(id,"/start");
   else if(step==="pending")row=await postIssue(id,"/status",{status:"Pending Vendor",note:message||"Waiting for spare parts / vendor."});
   else if(step==="resume")row=await postIssue(id,"/status",{status:"In Progress",note:message||"Resumed — parts/vendor received."});
   if(row){if(step==="pending"||step==="resume")drafts()[id]="";S._idkStick=true;render();toast(id+" is now "+(row.status==="Pending Vendor"?"waiting for parts / vendor":row.status)+".")}
  }catch(e){toast(e.message||"Could not update the ticket.")}
  finally{sending=false}
 };

 /* ---------------- hook into the modal renderer ---------------- */
 const base=window.renderModal||renderModal;
 const wrapped=function(){
  if(S.modal==="ticket"){
   const t=issue((S.modalCtx||{}).id);
   if(!t){S.modal=null;return ""}
   if(t.dbId&&!t.activityLoaded&&!t.activityLoading&&!t.activityError&&typeof refreshIssueActivity==="function")setTimeout(()=>refreshIssueActivity(t.id,false),0);
   if(typeof m26RefreshIssueSteps==="function"&&!t._stepsLoaded&&!t._stepsLoading&&t.dbId){t._stepsLoading=true;m26RefreshIssueSteps(t.id).then(ok=>{t._stepsLoading=false;if(ok&&S.modal==="ticket")render()}).catch(()=>{t._stepsLoading=false})}
   requestAnimationFrame(()=>{const th=document.getElementById("idk-thread");if(th&&S._idkStick!==false)th.scrollTop=th.scrollHeight;const m=document.getElementById("idk-msg");if(m&&m.value){m.style.height="auto";m.style.height=Math.min(140,m.scrollHeight)+"px"}});
   return deskHtml(t);
  }
  if(S.modal==="newTicket"&&S._tkFresh!==true){S._tkUnits=new Set();S._tkFresh=true}
  if(S.modal!=="newTicket")S._tkFresh=false;
  return base.apply(this,arguments);
 };
 try{renderModal=wrapped}catch(e){}
 window.renderModal=wrapped;

 /* Live conversation: while a ticket is open and the tab is visible, pick up new messages every 15 s. */
 setInterval(async()=>{
  if(S.modal!=="ticket"||document.visibilityState!=="visible"||sending)return;
  const t=issue((S.modalCtx||{}).id);if(!t||!t.dbId||t.activityLoading)return;
  const before=(t.activity||[]).length,last=((t.activity||[]).slice(-1)[0]||{}).id;
  try{
   const rows=await apiFetch("/api/issues/"+encodeURIComponent(t.dbId)+"/activity");
   if(S.modal!=="ticket"||(S.modalCtx||{}).id!==t.id)return;
   if(rows.length!==before||((rows.slice(-1)[0]||{}).id!==last)){t.activity=rows;t.activityLoaded=true;render()}
  }catch(e){/* keep the thread on screen; the Refresh button reports errors */}
 },15000);
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&S.modal==="ticket"&&!document.querySelector(".cc-lbox")){const m=document.querySelector(".idk-menu[open]");if(m){m.open=false;return}closeModal()}});
})();
