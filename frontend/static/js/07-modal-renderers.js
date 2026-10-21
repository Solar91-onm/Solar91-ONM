"use strict";
/* ================================================================
   MODALS
   ================================================================ */
/* Registered equipment a ticket points at (by id, then by code/name at the same plant). */
function s91IssueEquipment(t){
 const rows=S.equipment||[],ref=String(t&&t.equip||"").trim().toLowerCase();
 let e=t&&t.equipmentId?rows.find(x=>String(x.id)===String(t.equipmentId)):null;
 if(!e&&ref&&ref!=="—"){const p=plantRec(t.plant);e=rows.find(x=>(!p||String(x.plant_id)===String(p.dbId))&&[x.equipment_code,x.equipment_name].some(v=>String(v||"").trim().toLowerCase()===ref))}
 return e||null;
}
function s91IssueEquipmentLabel(t){
 const e=s91IssueEquipment(t);
 if(e)return [e.equipment_name,e.equipment_code].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(" · ");
 const ref=String(t&&t.equip||"").trim();return ref&&ref!=="—"?ref:"Not specified";
}
/* Raise-issue wizard: one ticket covers every affected unit of one equipment type at one plant
   (four tripped inverters = one ticket listing INV-01…INV-04, not four tickets). */
function s91TkPlantName(){const sel=document.getElementById("tk-plant");return (AUTH_IDENTITY.role==="Site Engineer"&&S._sePlant)||(sel?sel.value:"")||((S.plants||[])[0]||{}).name||""}
function s91TkUnitRows(plantName,vertical){
 const plant=(S.plants||[]).find(p=>p.name===plantName);
 const rows=(S.equipment||[]).filter(e=>plant&&String(e.plant_id)===String(plant.dbId)&&String(e.status||"active").toLowerCase()!=="inactive");
 const same=rows.filter(e=>!vertical||String(e.equipment_type||"").toLowerCase()===String(vertical).toLowerCase());
 return same.slice().sort((a,b)=>String(a.equipment_code||a.equipment_name).localeCompare(String(b.equipment_code||b.equipment_name),undefined,{numeric:true}));
}
function s91TkPicked(){if(!(S._tkUnits instanceof Set))S._tkUnits=new Set();return S._tkUnits}
function s91TkSelectedUnits(){const ids=s91TkPicked();return (S.equipment||[]).filter(e=>ids.has(String(e.id)))}
function s91TkOpenSameType(plantName,vertical){
 return (S.issues||[]).filter(t=>t.plant===plantName&&String(t.vertical||"").toLowerCase()===String(vertical||"").toLowerCase()&&!["Resolved","Closed"].includes(t.status));
}
function s91TkUnitsHtml(plantName,vertical){
 const list=s91TkUnitRows(plantName,vertical),picked=s91TkPicked(),n=list.filter(e=>picked.has(String(e.id))).length;
 const open=s91TkOpenSameType(plantName,vertical);
 let h='';
 if(open.length)h+='<div class="tk-dupe"><b>'+open.length+' open '+esc(vertical)+' ticket'+(open.length>1?'s':'')+' already at this plant</b>'+
  open.slice(0,3).map(t=>'<button type="button" onclick="closeModal();openIssue(\''+esc(t.id)+'\')">'+esc(t.id)+' · '+esc(t.status)+(t.equip&&t.equip!=="—"?' · '+esc(String(t.equip).slice(0,40)):'')+' — open it</button>').join("")+
  '<small>If it is the same fault, add a message on that ticket instead of raising a new one.</small></div>';
 if(!list.length)return h+'<div class="tk-units-empty">No registered '+esc(vertical)+' units at this plant. Type the reference below.</div>';
 h+='<div class="tk-units-head"><span><b>'+n+'</b> of '+list.length+' unit'+(list.length>1?'s':'')+' selected</span>'+
  '<button type="button" class="btn g sm" onclick="s91TkUnitsAll('+(n===list.length?'false':'true')+')">'+(n===list.length?'Clear':'Select all')+'</button></div>'+
  '<div class="tk-units">'+list.map(e=>{const id=String(e.id),on=picked.has(id);
   return '<button type="button" class="tk-unit'+(on?' on':'')+'" aria-pressed="'+on+'" title="'+esc([e.equipment_name,e.serial_number?"S/N "+e.serial_number:""].filter(Boolean).join(" · "))+'" onclick="s91TkUnitToggle(\''+esc(id)+'\')">'+(on?'✓ ':'')+esc(e.equipment_code||e.equipment_name)+'</button>'}).join("")+'</div>';
 return h;
}
function s91TkEquipRefresh(){
 const box=document.getElementById("tk-units-box");if(!box)return;
 const plant=s91TkPlantName(),vert=(document.getElementById("tk-vert")||{}).value||"";
 const valid=new Set(s91TkUnitRows(plant,vert).map(e=>String(e.id)));
 s91TkPicked().forEach(id=>{if(!valid.has(id))s91TkPicked().delete(id)});
 box.innerHTML=s91TkUnitsHtml(plant,vert);s91TkSyncFields();
}
function s91TkSyncFields(){
 const units=s91TkSelectedUnits(),set=(k,v)=>{const el=document.getElementById(k);if(el)el.value=v==null?"":v};
 const ref=document.getElementById("tk-equip");
 if(ref&&(units.length||ref.dataset.auto==="1")){ref.value=units.map(e=>e.equipment_code||e.equipment_name).join(", ");ref.dataset.auto=units.length?"1":"0"}
 if(units.length===1){const e=units[0];set("tk-serial",e.serial_number||"");set("tk-maker",e.maker||"");set("tk-supplier",e.supplier||"")}
}
function s91TkUnitToggle(id){const p=s91TkPicked();if(p.has(id))p.delete(id);else p.add(id);s91TkEquipRefresh()}
function s91TkUnitsAll(on){const p=s91TkPicked();s91TkUnitRows(s91TkPlantName(),(document.getElementById("tk-vert")||{}).value||"").forEach(e=>{if(on)p.add(String(e.id));else p.delete(String(e.id))});s91TkEquipRefresh()}
function modal(title,sub,body,foot,wide){
 return '<div class="overlay" onclick="if(event.target===this)closeModal()"><div class="modal '+(wide?"wide":"")+'">'+
  '<div class="modal-h"><div><h3 style="font-size:16px;font-weight:600;margin:0">'+title+'</h3>'+(sub?'<p style="font-size:12px;color:var(--muted-foreground);margin:4px 0 0">'+sub+'</p>':'')+'</div>'+
  '<button class="btn" style="border:none;color:var(--muted-foreground)" onclick="closeModal()">'+I.x(18)+'</button></div>'+
  '<div class="modal-b">'+body+'</div>'+(foot?'<div class="modal-f">'+foot+'</div>':'')+'</div></div>';
}
function issueWorkflowHtml(ticket){
 const states=["Open","Acknowledged","In Progress","Pending Vendor","Resolved","Closed"];
 const index=ticket.status==="Assigned"?0:states.indexOf(ticket.status);
 return '<div class="issue-workflow" aria-label="Ticket workflow">'+states.map((state,i)=>{
  const active=i===index,done=i<index,label=state==="Pending Vendor"?"Pending Parts/Vendor":state;
  return '<div class="issue-workflow-step '+(active?"active":"")+(done?" done":"")+'"><span>'+(done?"✓":i+1)+'</span><b>'+label+'</b></div>';
 }).join("")+'</div>';
}
function issueActivityHtml(ticket){
 const activity=ticket.activity||[];
 if(ticket.activityError)return '<div class="issue-activity-empty">'+esc(ticket.activityError)+'</div>';
 if(!ticket.activityLoaded)return '<div class="issue-activity-empty">Loading ticket updates…</div>';
 if(!activity.length)return '<div class="issue-activity-empty">No updates yet. Keep ticket discussion and status history here.</div>';
 return '<div class="issue-activity-list">'+activity.slice().reverse().map(item=>{
  const action=item.action||"",metadata=item.metadata||{};
  const title=action==="issue.message"?"Message":action==="issue.status_changed"?"Status changed":
   action==="issue.progress"?"Work progress":action==="issue.created"?"Ticket created":
   action==="issue.reopened"?"Ticket reopened":action==="issue.closed"?"Ticket verified and closed":
   action==="issue.reassigned"?"Ticket reassigned":action==="issue.assigned"?"Ticket assigned":
   action==="issue.evidence_uploaded"?"Evidence uploaded":action.replace(/^issue\./,"").replaceAll("_"," ");
  const status=item.status_to?'<div class="issue-activity-status">'+esc(item.status_from||"—")+' → '+esc(item.status_to==="Pending Vendor"?"Pending Parts/Vendor":item.status_to)+'</div>':"";
  const photos=(Array.isArray(metadata.evidence_ids)?metadata.evidence_ids:[]).map((id,i)=>'<button type="button" class="btn o sm" onclick="openIssueEvidence(\''+esc(ticket.id)+'\',\''+esc(id)+'\')">View photo '+(i+1)+'</button>').join("");
  return '<article class="issue-activity-item"><span class="issue-activity-dot"></span><div class="issue-activity-content"><div class="issue-activity-heading"><b>'+esc(title)+'</b><span>'+fmtDT(item.at)+'</span></div><div class="issue-activity-by">'+esc(item.actor||"System")+'</div>'+
   (item.note?'<div class="issue-activity-note">'+esc(item.note)+'</div>':"")+status+(photos?'<div class="row wrap" style="gap:6px;margin-top:7px">'+photos+'</div>':"")+
   (action==="issue.progress"?'<div class="issue-activity-by">Parts: '+esc(metadata.parts||"—")+' · '+esc(metadata.hours||0)+' hrs</div>':"")+
   '</div></article>';
 }).join("")+'</div>';
}
function renderModal(){
 const m=S.modal,ctx=S.modalCtx||{};
 if(!m)return"";
 /* --- plantLocation (LOCATION PREVIEW / MAP RENDERING) --- */
 if(m==="plantLocation"){
  const plant=(S.plants||[]).find(z=>z.id===ctx.id);
  if(!plant)return modal("Plant location","",emptyState("Plant not found",""),'<button class="btn o" onclick="closeModal()">Close</button>');
  return modal("📍 Plant Location","Registered geographic point · click outside to close",locationPreviewHtml(plant),'<button class="btn o" onclick="closeModal()">Close</button>');
 }
 /* --- addPlant / editPlant (PLANT REGISTER — add & edit) --- */
 if(m==="addPlant")return modal("+ Add Plant","For a plant that's already commissioned but not fully in the system yet — fill in what you know now, add the rest later via Edit.",
  plantFormHtml(null),
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="saveAddPlant()">Save Plant</button>');
 if(m==="editPlant"){
  const plant=(S.plants||[]).find(z=>z.id===ctx.id);
  if(!plant)return modal("Edit plant","",emptyState("Plant not found",""),'<button class="btn o" onclick="closeModal()">Close</button>');
  return modal("Edit "+esc(plant.name||plant.id),"Site Code "+esc(plant.id),
   plantFormHtml(plant),
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="saveEditPlant(\''+esc(plant.id)+'\')">Save Changes</button>');
 }
 /* --- addPlantColumn (PLANT REGISTRY — user-defined columns) --- */
 if(m==="addPlantColumn")return modal("+ Add Column","Adds a new column to every plant in the Plant Registry. Enter a value per plant afterwards directly in the table.",
  '<div class="field"><span class="lbl">Column name *</span><input id="apc-name" class="inp" placeholder="e.g. Land Owner, Meter Serial No." onkeydown="if(event.key===&quot;Enter&quot;){event.preventDefault();addPlantColumn()}"/></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="addPlantColumn()">Add Column</button>');
 /* --- commission --- */
 if(m==="commission")return modal("Commission a new project — Step 1.1","Progressive commissioning creates the Handover entry only after final confirmation",
  '<div class="wiz-commission" data-step="1"><div class="pill pillsm b-info" style="margin-bottom:12px">Step 1 of 3 · Project</div><div class="field"><span class="lbl">Project name *</span><input id="cm-name" class="inp" placeholder="Required"/></div><div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Location</span><input id="cm-location" class="inp" placeholder="City, state"/></div><div class="field" style="flex:1"><span class="lbl">Project type</span><select id="cm-type" class="inp"><option>Ground-mounted solar</option><option>Rooftop solar</option><option>Floating solar</option></select></div></div><div class="row" style="justify-content:flex-end"><button class="btn p" onclick="wizardGo(&quot;commission&quot;,2)">Next</button></div></div>'+
  '<div class="wiz-commission" data-step="2" style="display:none"><div class="pill pillsm b-info" style="margin-bottom:12px">Step 2 of 3 · Capacity & parties</div><div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">AC capacity (kW)</span><input id="cm-cap" class="inp" type="number" step="0.01" placeholder="Blank = not specified"/></div><div class="field" style="flex:1"><span class="lbl">DC capacity (kWp)</span><input id="cm-dc" class="inp" type="number" step="0.01"/></div></div><div class="field"><span class="lbl">EPC contractor</span><input id="cm-epc" class="inp"/></div><div class="field"><span class="lbl">Client / asset owner</span><input id="cm-client" class="inp"/></div><div class="row between"><button class="btn o" onclick="wizardGo(&quot;commission&quot;,1)">Back</button><button class="btn p" onclick="wizardGo(&quot;commission&quot;,3)">Next</button></div></div>'+
  '<div class="wiz-commission" data-step="3" style="display:none"><div class="pill pillsm b-info" style="margin-bottom:12px">Step 3 of 3 · Site references</div><div class="field"><span class="lbl">GPS coordinates</span><input id="cm-gps" class="inp" placeholder="26.2389, 73.0243"/></div><div class="field"><span class="lbl">Plant layout / as-built reference</span><input id="cm-layout" class="inp" placeholder="SLD / layout / as-built reference"/></div><div class="bn-info banner">On submit: status becomes Commissioned, a Handover ID is generated, status is Pending Checklist Assignment and the O&M Head receives the workflow notification.</div><div class="row"><button class="btn o" onclick="wizardGo(&quot;commission&quot;,2)">Back</button></div></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button data-wiz-final="commission" style="display:none" class="btn p" onclick="commission()">Create handover entry</button>');
 /* --- addItem --- */
 if(m==="addItem")return modal("Add custom checklist item — Step 1.2","Customize the checklist with items specific to this project (unique equipment, site conditions)",
  '<div class="field"><span class="lbl">Category</span><select id="ai-cat" class="inp">'+CATEGORIES.map(c=>'<option>'+c+'</option>').join("")+'</select></div>'+
  '<div class="field"><span class="lbl">Item title</span><input id="ai-title" class="inp" placeholder="e.g. Robotised washing system commissioning check"/></div>'+
  '<div class="row" style="gap:12px"><div style="flex:1" class="field"><span class="lbl">Priority</span><select id="ai-prio" class="inp"><option>Critical</option><option selected>High</option><option>Normal</option></select></div>'+
  '<div style="flex:1" class="field"><span class="lbl">Assignee</span><select id="ai-who" class="inp">'+ASSIGNEE_NAMES.map(n=>'<option>'+n+'</option>').join("")+'</select></div></div>'+
  '<div class="field"><span class="lbl">Due date</span><input id="ai-due" class="inp" type="date" value="'+addDays(TODAY,5)+'"/></div>'+
  '<div class="field"><span class="lbl">Instructions / notes for assignee</span><textarea id="ai-instructions" class="txt" rows="2" placeholder="Work instructions, safety precautions, or acceptance criteria…"></textarea></div>'+
  '<div style="font-size:12.5px;color:var(--muted-foreground)">Attachment requirement follows priority: Critical items require photo/document proof before review submission. Assignee is notified on assignment.</div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="addItem()">Add &amp; assign item</button>');
 /* --- evidence --- */
 if(m==="evidence")return modal("Upload evidence — Step 1.3","Photos, scanned documents, meter readings, signed forms — attached directly against the checklist item",
  '<div class="field"><span class="lbl">Number of files being attached</span><input id="ev-count" class="inp" type="number" min="1" value="1"/></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="addEvidence()">Attach files</button>');
 /* --- reject --- */
 if(m==="reject")return modal("Reject & send for rework — Step 1.3","The item goes back to the assignee with comments; the execute → submit → verify cycle repeats until accepted",
  '<div class="field"><span class="lbl">Rejection reason / comments</span><textarea id="rj-reason" class="txt" rows="3" placeholder="e.g. Photo doesn\u2019t show relay panel clearly — reshoot required."></textarea></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn d" onclick="rejectItem()">Reject item</button>');
 /* --- na --- */
 if(m==="na")return modal("Mark as N/A — Step 1.4","Items not applicable to this site may be closed as N/A — justification is mandatory and recorded on the handover summary & certificate",
  '<div class="field"><span class="lbl">Justification (required)</span><textarea id="na-just" class="txt" rows="3" placeholder="e.g. No tracker system at this site — fixed-tilt structure."></textarea></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="naItem()">Mark N/A</button>');
 /* --- approval --- */
 if(m==="approval"){
  const h=S.handovers.find(x=>x.id===ctx.hid);const prog=hoProg(h);
  const openItems=h.items.filter(i=>!counted(i));
  const closedItems=h.items.filter(i=>i.status==="completed");
  const files=h.items.reduce((s,i)=>s+i.evidence,0);
  if(openItems.length){
   const bySt={};openItems.forEach(i=>{const k=ITEM_ST[i.status];bySt[k]=(bySt[k]||0)+1});
   return modal("Final approval — gate locked (Step 1.4)","Final approval unlocks only when every checklist item is Completed (or N/A with justification)",
    '<div class="row wrap" style="gap:8px;margin-bottom:12px">'+Object.entries(bySt).map(e=>badge(e[0]+" · "+e[1])).join("")+'</div>'+
    '<div style="border:1px solid var(--border);border-radius:10px;max-height:220px;overflow-y:auto">'+openItems.slice(0,10).map(it=>'<div class="row between" style="padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px;gap:10px"><span>'+esc(it.title)+'</span>'+badge(ITEM_ST[it.status])+'</div>').join("")+
    (openItems.length>10?'<div style="padding:8px 12px;font-size:12.5px;color:var(--muted-foreground)">+ '+(openItems.length-10)+' more open items</div>':'')+'</div>'+
    '<div style="font-size:12.5px;color:var(--muted-foreground);margin-top:12px">Progress: '+prog.done+'/'+prog.total+' — '+prog.pct+'%</div>',
    '<button class="btn o" onclick="closeModal()">Close</button>');
  }
  return modal("Final approval — consolidated summary (Step 1.4)",esc(h.name)+" · "+h.handoverId+" · all documents, photos and sign-offs reviewed",
   '<div class="row wrap" style="gap:8px;margin-bottom:10px">'+CATEGORIES.map(c=>{const its=h.items.filter(i=>i.category===c);return its.length?badge(c.split(" ")[0]+" "+its.filter(counted).length+"/"+its.length):""}).join("")+'</div>'+
   '<div style="font-size:12.5px;color:var(--muted-foreground);margin-bottom:12px">📦 '+files+' evidence files attached across items · '+h.items.filter(i=>i.status==="na").length+' N/A with justification · Commissioned '+h.commissioned+'</div>'+
   '<div class="field"><span class="lbl">Approval remarks / conditions (optional)</span><textarea id="fa-remarks" class="txt" rows="2" placeholder="e.g. Approved — washing system warranty to be tracked separately."></textarea></div>'+
   '<details style="border:1px solid var(--border);border-radius:10px;padding:12px"><summary style="font-size:12.5px;font-weight:600;cursor:pointer">Reject / reopen specific items instead (sends back to Step 1.3)</summary>'+
   '<div style="margin-top:10px;max-height:140px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">'+closedItems.map(it=>'<label class="row" style="gap:8px;font-size:12px;font-weight:400"><input type="checkbox" name="fa-reopen" value="'+it.id+'"/> '+esc(it.title)+' <span style="color:var(--muted-foreground)">('+esc(it.assignee.split(" (")[0])+')</span></label>').join("")+'</div>'+
   '<div class="field" style="margin-top:10px"><span class="lbl">Reason for reopening</span><input id="fa-reason" class="inp" placeholder="Gap found during final approval review…"/></div>'+
   '<button class="btn d sm" onclick="reopenItems()">Reopen selected items</button></details>'+
   '<div style="border-top:1px solid var(--border);padding-top:14px;margin-top:12px"><div class="field"><span class="lbl">E-signature — type "'+OM_HEAD+'" to confirm approval (timestamp + approver identity recorded for audit)</span>'+
   '<input id="fa-sign" class="inp" placeholder="Type full name" oninput="var b=document.getElementById(\'fa-go\');if(b)b.disabled=this.value.trim()!==\''+OM_HEAD+'\'"/></div></div>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" id="fa-go" disabled onclick="approveHandover()">'+I.fsig(14)+'Approve &amp; transition to Regular O&amp;M</button>',true);
 }
 /* --- certificate --- */
 if(m==="certificate"){
  const h=S.handovers.find(x=>x.id===ctx.hid);const prog=hoProg(h);
  return modal("Handover Completion Certificate",(h.certificate?h.certificate.no:"HCC-"+h.handoverId)+" · auto-generated PDF summary of checklist, dates, approvers — stored in the project document repository",
   '<div style="display:flex;flex-direction:column">'+
   [["Project",h.name+" · "+h.handoverId],["Capacity",capLabel(h.capacity)],["EPC / Client",h.epc+" · "+h.client],["Commissioned",h.commissioned],
    ["Checklist result",prog.done+"/"+prog.total+" closed ("+h.items.filter(i=>i.status==="na").length+" N/A justified) · "+h.items.reduce((s,i)=>s+i.evidence,0)+" evidence files"]]
    .map(r=>'<div class="row between" style="gap:16px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px"><span style="color:var(--muted-foreground)">'+r[0]+'</span><span style="font-weight:500;text-align:right">'+esc(r[1])+'</span></div>').join("")+
   CATEGORIES.map(c=>{const its=h.items.filter(i=>i.category===c);return its.length?'<div class="row between" style="padding:7px 0;border-bottom:1px solid var(--border);font-size:12.5px"><span style="color:var(--muted-foreground)">'+c+'</span><span>'+its.filter(counted).length+'/'+its.length+' closed</span></div>':""}).join("")+
   (h.approval&&h.approval.remarks?'<div style="padding:8px 0;font-size:12.5px"><b>Remarks/conditions:</b> '+esc(h.approval.remarks)+'</div>':'')+
   '<div class="row between" style="gap:24px;margin-top:22px"><div style="flex:1;border-top:2px solid var(--foreground);padding-top:6px;font-size:12.5px;color:var(--muted-foreground)">'+(h.approval?esc(h.approval.approver):"—")+'<br>Approver · e-signature confirmed</div>'+
   '<div style="flex:1;border-top:2px solid var(--foreground);padding-top:6px;font-size:12.5px;color:var(--muted-foreground)">'+(h.certificate?h.certificate.at:(h.approval?h.approval.signedAt:"—"))+'<br>Approval timestamp (audit record)</div></div></div>',
   '<button class="btn o" onclick="window.print()">Print / save as PDF</button><button class="btn p" onclick="closeModal()">Close</button>',true);
 }
 if(m==="taskDetail"){
  const t=S.tasks.find(x=>x.id===ctx.id);if(!t)return"";
  const subs=TSUB[t.type]||[];
  return modal(esc(typeof pmDisplayTaskName==="function"?pmDisplayTaskName(t):t.name),esc(t.plant)+" · "+esc(t.type||"Equipment")+" · "+t.freq+" · starts "+fmtD(t.start)+" · due "+fmtD(t.due),
   '<div class="row wrap" style="gap:8px;margin-bottom:14px">'+badge(t.status==="Completed"?"Completed":taskOD(t)>0?"Overdue":t.status)+badge(t.safety!=="—"?t.safety:"No PTW/LOTO")+(t.linkedIssue?badge("Linked: "+t.linkedIssue):"")+'</div>'+
   '<div class="kgrid" style="grid-template-columns:repeat(3,1fr);gap:12px;font-size:12.5px;margin-bottom:14px"><div><div class="k">Start date</div><b>'+fmtD(t.start)+'</b></div><div><div class="k">Due date</div><b>'+fmtD(t.due)+'</b></div><div><div class="k">Assignee</div><b>'+esc(t.assignee)+'</b></div><div><div class="k">SOP</div><b>'+esc(t.sop)+'</b></div><div><div class="k">Duration</div><b>'+esc(t.duration)+'</b></div><div><div class="k">Tools / spares</div><b>'+esc(t.tools)+'</b></div><div><div class="k">Equipment category</div><b>'+esc(t.type||"—")+'</b></div></div>'+
   '<div style="font-size:12.5px;font-weight:600;margin-bottom:6px">Execution checklist</div><div class="col" style="gap:5px;margin-bottom:12px">'+(subs.length?subs.map(s=>'<div class="row" style="gap:8px;font-size:12px"><span class="dot" style="width:8px;height:8px;background:'+(t.completion&&Array.isArray(t.completion.sub)&&t.completion.sub.includes(s)?"var(--success)":"var(--status-slate)")+'"></span>'+esc(s)+'</div>').join(""):'<span class="muted">No sub-steps configured.</span>')+'</div>'+
   (t.completion?'<div class="bn-info banner" style="margin-bottom:10px"><b>Completion evidence</b> — '+fmtD(t.completion.date)+' · '+scheduledEvidenceCount(t)+' photo(s) · '+esc(t.completion.readings)+' · '+esc(t.completion.remarks)+' · parts '+esc(t.completion.parts||'—')+(t.completion.anomaly?' · anomaly flagged':'')+'</div>':'<div class="bn-warn banner" style="margin-bottom:10px">No completion submitted yet. Upload one Before photo before work and one After photo when the work is complete.</div>')+
   scheduledEvidenceSection(t,false)+
   '<div style="font-size:12.5px;font-weight:600;margin:12px 0 6px">Activity</div><div class="col">'+(t.log&&t.log.length?t.log.map(l=>'<div class="row" style="gap:8px;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--border);font-size:12px"><span class="history-dot"></span><div>'+esc(typeof pmDisplayTaskActivity==="function"?pmDisplayTaskActivity(l.text):l.text)+'<div class="muted" style="font-size:12px">'+esc(l.actor)+' · '+esc(s91LogAt(l.at))+'</div></div></div>').join(""):'<span class="muted" style="font-size:12px">No activity recorded.</span>')+'</div>',
   '<div class="row" style="gap:7px;justify-content:flex-end;flex-wrap:wrap">'+(t.status==="Scheduled"?'<button class="btn o sm" onclick="closeModal();startTask(\''+t.id+'\')">Start</button>':"")+(t.status==="In Progress"?'<button class="btn p sm" onclick="closeModal();openModal(\'complete\',{id:\''+t.id+'\'})">Complete</button>':"")+(scheduledAdmin()?'<button class="btn g sm" onclick="closeModal();openModal(\'reassignTask\',{id:\''+t.id+'\'})">Reassign</button>':"")+'<button class="btn o sm" onclick="closeModal()">Close</button></div>',true);
 }
 /* --- newTask --- */
 if(m==="newTask"){const first=(S.schedScope!=="all"?S.schedScope:(S.plants[0]?S.plants[0].name:""));return modal("Build maintenance task — recurrence builder","Progressive task setup · recurrence remains anchored to the first due date",
  '<div class="wiz-task" data-step="1"><div class="pill pillsm b-info" style="margin-bottom:12px">Step 1 of 3 · Plant & maintenance category</div><div class="field"><span class="lbl">Plant</span><select id="nt-plant" class="inp">'+S.plants.map(p=>'<option'+(first===p.name?' selected':'')+'>'+esc(p.name)+'</option>').join("")+'</select></div><div class="field"><span class="lbl">Task name</span><input id="nt-name" class="inp" placeholder="e.g. Preventive maintenance task"/></div><div class="field"><span class="lbl">Maintenance category</span><select id="nt-type" class="inp">'+TASK_TYPES.map(t=>'<option>'+t.name+'</option>').join("")+'</select></div><div class="row" style="justify-content:flex-end"><button class="btn p" onclick="wizardGo(&quot;task&quot;,2)">Next</button></div></div>'+
  '<div class="wiz-task" data-step="2" style="display:none"><div class="pill pillsm b-info" style="margin-bottom:12px">Step 2 of 3 · Safety</div><div class="field"><span class="lbl">Safety precautions</span><select id="nt-safety" class="inp"><option>—</option><option>PTW required</option><option>LOTO required</option><option>PTW + LOTO required</option></select></div><div class="field"><span class="lbl">SOP reference</span><input id="nt-sop" class="inp" placeholder="SOP reference"/></div><div class="row between"><button class="btn o" onclick="wizardGo(&quot;task&quot;,1)">Back</button><button class="btn p" onclick="wizardGo(&quot;task&quot;,3)">Next</button></div></div>'+
  '<div class="wiz-task" data-step="3" style="display:none"><div class="pill pillsm b-info" style="margin-bottom:12px">Step 3 of 3 · Schedule & assignment</div><div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Frequency</span><select id="nt-freq" class="inp">'+Object.keys(FREQ_MAP).map(f=>'<option'+(f==="Monthly"?' selected':'')+'>'+f+'</option>').join("")+'</select></div><div class="field" style="flex:1"><span class="lbl">First due date</span><input id="nt-start" class="inp" type="date" value="'+addDays(TODAY,3)+'"/></div></div><div class="field"><span class="lbl">Assignee</span><select id="nt-who" class="inp">'+TEAM_POOL.map(n=>'<option>'+n+'</option>').join("")+'</select></div><div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Estimated duration</span><input id="nt-dur" class="inp" value="4 hrs"/></div><div class="field" style="flex:1"><span class="lbl">Required tools / spares</span><input id="nt-tools" class="inp" placeholder="Torque wrench, IR camera…"/></div></div><div class="row"><button class="btn o" onclick="wizardGo(&quot;task&quot;,2)">Back</button></div></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button data-wiz-final="task" style="display:none" class="btn p" onclick="createTask()">Create task</button>');}
 /* --- importCSV --- */
 if(m==="importCSV")return modal("Upload pre-built schedule","Excel/CSV template with columns: task, plant, type, frequency, assignee, start_date. PM work is assigned by plant and category, not to an individual unit.",
  '<div style="border:1px dashed var(--border);border-radius:10px;padding:24px;text-align:center;background:var(--surface-subtle)">'+I.ftext(26)+
  '<div style="font-weight:600;font-size:13px;margin-top:6px">Choose maintenance_schedule.xlsx or .csv</div><input id="csv-file" class="inp" type="file" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" style="margin-top:12px"/><div style="font-size:12.5px;color:var(--muted-foreground);margin-top:3px">Only rows in the selected file are imported. Duplicate work is not generated from hidden sample data.</div></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="importCSV()">Import schedule</button>');
 /* --- complete --- */
 if(m==="complete"){
  const t=S.tasks.find(x=>x.id===ctx.id);const subs=TSUB[t.type]||["Sub-step 1"];
  return modal("Submit completion — "+esc(t.name),"2.1.3 Execution & completion tracking · Scheduled vs Actual dates compute the delay automatically",
   '<div class="field"><span class="lbl">Checklist of sub-steps followed</span><div class="col" style="gap:5px">'+subs.map(s=>'<label class="row" style="gap:8px;font-size:12.5px;font-weight:400"><input type="checkbox" name="ct-sub" value="'+esc(s)+'" checked/> '+esc(s)+'</label>').join("")+'</div></div>'+
   '<div class="field"><span class="lbl">Readings / measurements captured (e.g. insulation resistance, oil test result)</span><input id="ct-readings" class="inp" placeholder="e.g. IR 1.4 GΩ · BDV 58 kV"/></div>'+
   scheduledEvidenceSection(t,false)+
   '<div class="bn-info banner" style="margin:0 0 12px"><b>Evidence required for completion:</b> exactly two proof slots are used — <b>Before</b> and <b>After</b>. Upload one photo in each slot. Uploading a new photo to the same slot replaces the previous one. No WhatsApp hand-off is required.</div>'+
   '<div class="field"><span class="lbl">Actual completion date</span><input id="ct-date" class="inp" type="date" value="'+TODAY+'"/></div>'+
   '<div class="row" style="gap:12px"><div class="field" style="flex:2"><span class="lbl">Spare part used (optional)</span><select id="ct-part" class="inp"><option value="">— No part used —</option>'+S.inventory.map(x=>'<option value="'+x.id+'">'+esc(x.item)+' · '+x.qty+' '+esc(x.unit)+'</option>').join("")+'</select></div><div class="field" style="flex:0 0 100px"><span class="lbl">Qty</span><input id="ct-qty" class="inp" type="number" min="1" value="1"/></div></div>'+
   '<div class="field"><span class="lbl">Remarks and any anomalies found</span><textarea id="ct-rem" class="txt" rows="2" placeholder="e.g. Fan bearing noise on INV-03 — monitoring."></textarea></div>'+
   '<label class="row" style="gap:8px;font-size:12.5px;font-weight:500"><input type="checkbox" id="ct-anom"/> ⚡ Problem found — convert directly into an Issue ticket on submit (auto-linked, one click)</label>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="completeTask()">Submit completion</button>');
 }
 /* --- reassignTask --- */
 if(m==="reassignTask"){const t=S.tasks.find(x=>x.id===ctx.id);
  return modal("Reassign / delegate","Currently assigned to "+esc(t.assignee)+" · due "+fmtD(t.due)+" — the change is logged",
   '<div class="field"><span class="lbl">New assignee</span><select id="rt-name" class="inp">'+TEAM_POOL.filter(n=>n!==t.assignee).map(n=>'<option>'+n+'</option>').join("")+'</select></div>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="reassignTask()">Reassign</button>');}
 /* --- bulkWash --- */
 if(m==="bulkWash"){const meta=S.washMeta[S.washPlant]||{team:["—"]};const crew=meta.team||[],team=crew.length?crew:["—"];const invs=[...new Set(S.washing.filter(t=>t.plant===S.washPlant).map(t=>t.inv))];
  return modal("Bulk entry — inverter washed today","Mark multiple tables as washed in one action — per-table date-stamped records are still stored",
   '<div class="row" style="gap:12px"><div style="flex:1" class="field"><span class="lbl">Inverter</span><select id="bw-inv" class="inp">'+invs.map(i=>'<option value="'+i+'">INV-'+pad2(i)+' — all tables</option>').join("")+'</select></div>'+
   '<div style="flex:1" class="field"><span class="lbl">Logged by</span><select id="bw-by" class="inp">'+team.map(n=>'<option>'+esc(n)+'</option>').join("")+'</select></div></div>'+
   '<div style="font-size:12.5px;color:var(--muted-foreground)">Date stamp: '+fmtDate(TODAY)+' · tables already washed today are skipped.</div>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="bulkWash()">Log all tables washed</button>');}
 if(m==="washLog"){const t=S.washing.find(x=>x.id===ctx.id);if(!t)return modal("Log wash","This table is no longer in the washing register.",'<div class="bn-info banner">Refresh the register and try again.</div>','<button class="btn o" onclick="closeModal()">Close</button>');const crew=((S.washMeta[t.plant]||{}).team||[]);const team=crew.length?crew:["—"];
  return modal("Log table washed today — "+t.tableId,esc(t.plant)+" · one dated record will be attached to this table",
   '<div class="field"><span class="lbl">Completed by</span><select id="wl-by" class="inp">'+team.map(n=>'<option>'+esc(n)+'</option>').join("")+'</select></div>'+
   '<div style="font-size:12.5px;color:var(--muted-foreground)">Date stamp: '+fmtDate(TODAY)+' · the selected crew member is used in person-wise productivity and the audit history.</div>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="saveWashTableLog()">Log wash</button>');}
    /* --- exception --- */
 if(m==="exception"){const t=S.washing.find(x=>x.id===ctx.id);
  if(!t)return modal("Log exception","This table is no longer in the washing register.",'<div class="bn-info banner">Refresh the register and try again.</div>','<button class="btn o" onclick="closeModal()">Close</button>');
  const crew=((S.washMeta[t.plant]||{}).team||[]),team=crew.length?crew:["—"];
  return modal("Log exception — "+t.tableId+"","Scheduled but not washed due to rain or another valid reason? Log it as an exception rather than leaving it blank/undone.",
   '<div class="field"><span class="lbl">Reason code</span><select id="ex-reason" class="inp">'+EXC_REASONS.map(r=>'<option>'+r+'</option>').join("")+'</select></div>'+
   '<div class="field"><span class="lbl">Logged by</span><select id="ex-by" class="inp">'+team.map(n=>'<option>'+esc(n)+'</option>').join("")+'</select></div>'+
   '<div class="field"><span class="lbl">Notes (free text, especially for \u2018Other\u2019)</span><input id="ex-notes" class="inp" placeholder="Details…"/></div>'+
   '<div style="font-size:12.5px;color:var(--muted-foreground)">Exceptions are recorded distinctly from "missed/pending" so they don\u2019t count negatively against team efficiency metrics, but remain visible for transparency. Rain skips are auto-flagged <b>"Pending — Rescheduled"</b> with the next available date suggested.</div>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="logException()">Log exception</button>');}
 /* --- washHistory --- */
 if(m==="washHistory"){const t=S.washing.find(x=>x.id===ctx.id);if(!t)return modal("Cleaning history","This table is no longer in the washing register.",'<div class="bn-info banner">Refresh the register and try again.</div>','<button class="btn o" onclick="closeModal()">Close</button>');const d=daysSince(t);
  return modal("Cleaning history — "+t.tableId+"",esc(t.plant)+" · full timeline of wash dates, skip/exception dates, and days-since-last-wash counter",
   '<div class="row" style="gap:10px;margin-bottom:12px;align-items:center">'+badge(d<10?"On track":d<=15?"Attention":"Overdue")+'<b style="font-size:13px">Days since last wash: '+(d===999?"never":d)+'</b></div>'+
   '<div class="col">'+t.history.slice().reverse().map(hh=>'<div class="row" style="gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border)"><span class="history-dot" style="background:'+(hh.type==="wash"?"var(--success)":"var(--info)")+'"></span>'+
    '<div style="font-size:12.5px"><b>'+(hh.type==="wash"?"Washed":"Exception — "+esc(hh.reason||"Other"))+'</b><div style="font-size:12.5px;color:var(--muted-foreground)">'+fmtDate(hh.date)+' · by '+esc(hh.by||"Unknown")+'</div>'+
    (hh.notes?'<div style="margin-top:4px;font-size:12.5px">'+esc(hh.notes)+'</div>':"")+
    (hh.type==="exception"&&(hh.rescheduledTo||(hh.reason==="Rain"&&t.rescheduledTo&&hh.date===TODAY))?'<div style="margin-top:4px;font-size:12.5px;color:var(--warning-strong)">Rescheduled to '+fmtDate(hh.rescheduledTo||t.rescheduledTo)+'</div>':"")+'</div></div>').join("")+'</div>',
   '<button class="btn o" onclick="closeModal()">Close</button>');}
 /* --- washScheduleImport --- */
 if(m==="washScheduleImport")return modal("Upload washing schedule","Excel/CSV columns: plant, table_id, inverter, secondary_inverter (optional), frequency_days, next_due, crew (optional)",
  '<div style="border:1px dashed var(--border);border-radius:10px;padding:22px;text-align:center;background:var(--surface-subtle)">'+I.ftext(26)+
  '<div style="font-weight:600;font-size:13px;margin-top:6px">Choose washing_schedule.xlsx or .csv</div><input id="wash-schedule-file" class="inp" type="file" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" style="margin-top:12px"/>'+
  '<div style="font-size:12.5px;color:var(--muted-foreground);margin-top:5px">Rows can create/update table mappings. A table may include a secondary inverter when it is physically split between two inverters.</div></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="importWashSchedule()">Import washing schedule</button>');
 /* --- washSetup --- */
 if(m==="washSetup"){const opt=n=>'<option value="">—</option>'+SITE_ENG_POOL.map(x=>'<option'+(x===n?' selected':'')+'>'+esc(x)+'</option>').join("");
  return modal("Set up washing — "+esc(S.washPlant),"Inverter → table mapping, wash frequency and crew",
   '<div class="row" style="gap:12px"><div style="flex:1" class="field"><span class="lbl">Inverters</span><input id="ws-inv" class="inp" type="number" min="1" max="60" value="6"/></div><div style="flex:1" class="field"><span class="lbl">Tables per inverter</span><input id="ws-tpi" class="inp" type="number" min="1" max="30" value="4"/></div><div style="flex:1" class="field"><span class="lbl">Wash every (days)</span><input id="ws-freq" class="inp" type="number" min="1" value="12"/></div></div>'+
   '<div class="row" style="gap:12px"><div style="flex:1" class="field"><span class="lbl">Crew member 1</span><select id="ws-t1" class="inp">'+opt("")+'</select></div><div style="flex:1" class="field"><span class="lbl">Crew member 2</span><select id="ws-t2" class="inp">'+opt("")+'</select></div></div>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="saveWashSetup()">Create tables</button>');}
 /* --- plantDetail (Excel DGR data) --- */
 if(m==="plantDetail"){const p=S.plants.find(z=>z.id===ctx.id);if(!p)return"";
  const x=XL_BY[p.id],hasX=!!(x&&x.latest),mt=xlPlantMtd(p.id),sm="font-size:12.5px;color:var(--muted-foreground)";
  const kv=(k,v,s)=>'<div class="metric" style="flex:1;min-width:130px;padding:10px 12px"><div style="font-size:12px;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.04em">'+k+'</div><div style="font-size:17px;font-weight:700;margin-top:2px">'+v+'</div>'+(s?'<div style="'+sm+'">'+s+'</div>':'')+'</div>';
  const openI=openTk(S.issues).filter(t=>t.plant===p.name).length,openT=S.tasks.filter(t=>t.plant===p.name&&t.status!=="Completed").length,wt=S.washing.filter(t=>t.plant===p.name),wOk=wt.filter(t=>daysSince(t)<=((S.washMeta[p.name]||{}).freq||14)).length;
  let body='<div class="row wrap" style="gap:10px;margin-bottom:12px">'+
   kv("DC capacity (kWp)",plantDcKw(p)!=null?kWStrPlain(plantDcKw(p)):capStr(p.capacity),"Plant registry")+
   kv("AC capacity (kW)",plantAcKw(p)!=null?kWStrPlain(plantAcKw(p)):"—","Plant registry")+
   kv("Latest day",xlNum(p.generation)?p.generation.toFixed(1)+" mWh":"—",p.genDate?xlFmtDY(p.genDate):"no data")+
   kv("MTD vs PV Syst",mt&&mt.pct!=null?mt.pct+"%":"—",mt?(mt.gen/1000).toFixed(1)+" mWh"+(mt.tgt?" of "+(mt.tgt/1000).toFixed(1):" · no target"):"")+
   kv("Yield (latest)",hasX&&x.latest.generationPerkW!=null?x.latest.generationPerkW.toFixed(2)+" kWh/kWp":"—",hasX&&x.latest.cufPct!=null?"CUF "+x.latest.cufPct.toFixed(1)+"%":"")+
   kv("Lifetime",hasX&&x.lifetimeGenerationkWh!=null?(x.lifetimeGenerationkWh/1e6).toFixed(2)+" GWh":"—",hasX&&x.firstReportedDate?"since "+xlFmtDY(x.firstReportedDate):"")+'</div>';
  if(hasX){const dl=xlDaily([p],30).filter(r=>r.rep>0),like=dl.some(r=>r.cmp>0),tr=dl.map(r=>({day:xlFmtD(r.date),generation:+(r.all/1000).toFixed(1),target:like?+(r.ct/1000).toFixed(1):null}));
   body+='<div style="'+sm+';margin:4px 0">Daily generation — last '+tr.length+' reported days (mWh)</div>'+areaChart(tr)+'<div style="margin-top:10px">'+dashBarChart(monthSeries([p],12))+'</div>';
   }
  body+='<div class="row wrap" style="gap:18px;margin:4px 0 12px;font-size:12px"><span><span class="muted">Site code</span> <b>'+esc(p.id)+'</b></span><span><span class="muted">Project company</span> <b>'+esc((x&&x.projectCompany)||"—")+'</b></span><span><span class="muted">Commissioned</span> <b>'+(x&&x.commissionedOn?xlFmtDY(x.commissionedOn):"—")+'</b></span><span><span class="muted">DC / AC</span> <b>'+kWStr(x&&x.capacitykW)+' / '+kWStr(x&&x.acCapacitykW)+' kW</b></span></div>';
   body+='<div class="row wrap" style="gap:10px;margin-top:12px">'+kv("Open issues",openI)+kv("Open tasks",openT)+kv("Washing compliance",wt.length?Math.round(100*wOk/wt.length)+"%":"Not set up",wt.length+" tables")+'</div>';
  if(x&&x.notes&&x.notes.length)body+='<div class="bn-info banner" style="margin-top:12px"><b>Data notes from the workbook</b><ul style="margin:6px 0 0 16px;padding:0">'+x.notes.map(n=>'<li style="margin:2px 0">'+esc(n)+'</li>').join("")+'</ul></div>';
  return modal(esc(p.name),esc(p.id)+" · plant detail",body,'<button class="btn o" onclick="closeModal();setPlantScope(\''+esc(p.name)+'\')">Scope dashboard to this plant</button><button class="btn p" onclick="closeModal()">Close</button>',true);}
 /* --- washFreq --- */
 if(m==="washFreq"){const f=(S.washMeta[S.washPlant]||{}).freq||12;
  return modal("Washing schedule / frequency","Pre-planned schedule for "+esc(S.washPlant)+" — drives each table's due date and the compliance calculation",
   '<div class="field"><span class="lbl">Wash every (days) — '+esc(S.washPlant)+'</span><input id="wf-days" class="inp" type="number" min="1" value="'+f+'"/></div>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="saveWashFreq()">Save schedule</button>');}
 /* --- newTicket --- */
 /* three-step progress shown at the top of each wizard step (static per step, so no extra wiring is needed) */
 const tkSteps=n=>'<ol class="tk-steps" aria-label="Step '+n+' of 3">'+["Plant","Classification","Priority & details"].map((l,i)=>'<li class="'+(i+1<n?"done":i+1===n?"on":"")+'"'+(i+1===n?' aria-current="step"':'')+'><i>'+(i+1<n?"✓":i+1)+'</i><span>'+l+'</span></li>').join("")+'</ol>';
 if(m==="newTicket"){return modal("Raise issue ticket","Step-by-step issue capture · Ticket ID and timestamp are generated only when you submit",
  '<div class="wiz-ticket" data-step="1">'+tkSteps(1)+'<div class="field"><span class="lbl">Plant code</span><select id="tk-plant" class="inp" onchange="s91TkEquipRefresh()">'+S.plants.map((p,i)=>'<option value="'+esc(p.name)+'"'+(i===0?' selected':'')+'>'+esc(p.id||p.name)+'</option>').join("")+'</select></div><div class="tk-guide"><b>What you will add</b><ol><li><span>Equipment</span> type and the affected units</li><li><span>Priority</span> and expected time to close</li><li><span>Details</span> a short description and photos</li></ol><small>Open tickets for the same equipment at this plant are shown before you raise a duplicate.</small></div><div class="row" style="justify-content:flex-end"><button class="btn p" onclick="wizardGo(&quot;ticket&quot;,2)">Next</button></div></div>'+
  '<div class="wiz-ticket" data-step="2" style="display:none">'+tkSteps(2)+'<div class="field"><span class="lbl">Issue vertical / category</span><select id="tk-vert" class="inp" onchange="updIssueAssignees();s91TkEquipRefresh()">'+VERTICALS.map(v=>'<option>'+v+'</option>').join("")+'</select></div><div class="field"><span class="lbl">Affected units — pick every unit with this fault (one ticket)</span><div id="tk-units-box">'+s91TkUnitsHtml(s91TkPlantName(),VERTICALS[0])+'</div></div><div class="field"><span class="lbl">Equipment / component reference</span><input id="tk-equip" class="inp" maxlength="255" placeholder="Filled from the units above, or type e.g. transformer, pump" oninput="this.dataset.auto=0"/></div><details class="tk-more"><summary>Serial number, supplier, maker (optional)</summary><div class="field"><span class="lbl">Serial number</span><input id="tk-serial" class="inp" placeholder="Issue or equipment serial number"/></div><div class="field"><span class="lbl">Supplier</span><input id="tk-supplier" class="inp" placeholder="Supplier / vendor name"/></div><div class="field"><span class="lbl">Maker / manufacturer (if known)</span><input id="tk-maker" class="inp" placeholder="e.g. Sungrow, Waaree"/></div></details><div class="field"><span class="lbl">Occurrence date</span><input id="tk-occurred" class="inp" type="date" value="'+TODAY+'"/></div><div class="row between"><button class="btn o" onclick="wizardGo(&quot;ticket&quot;,1)">Back</button><button class="btn p" onclick="wizardGo(&quot;ticket&quot;,3)">Next</button></div></div>'+
  '<div class="wiz-ticket" data-step="3" style="display:none">'+tkSteps(3)+'<div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Severity / Priority</span><select id="tk-sev" class="inp" onchange="updEtc()"><option>Critical</option><option selected>Medium</option></select></div><div class="field" style="flex:1"><span class="lbl">Expected Time to Close (ETC)</span><input id="tk-etc" class="inp" type="datetime-local" value="'+addHoursISO(stampISO(),etcHrs("Medium"))+'"/></div></div><div class="field"><span class="lbl">Issue details</span><textarea id="tk-desc" class="txt" rows="3" placeholder="Describe the actual issue observed"></textarea></div><div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Evidence photos (up to 10)</span><input id="tk-photos" class="inp" type="file" accept="image/jpeg,image/png,image/webp" multiple onchange="showIssuePhotoSelection(this)"/><small id="tk-photo-count" class="muted">No photos selected</small></div><div class="field" style="flex:1"><span class="lbl">Assign to Assignee (optional)</span><select id="tk-assignee" class="inp">'+issueAssigneeOptions()+'</select></div></div><div class="row"><button class="btn o" onclick="wizardGo(&quot;ticket&quot;,2)">Back</button></div></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button data-wiz-final="ticket" style="display:none" class="btn p" onclick="createTicket()">Create ticket</button>');}
 /* --- editTicket --- */
 if(m==="editTicket"){const t=S.issues.find(x=>x.id===ctx.id);return modal("Edit ticket details",t.id+" · corrections only",
  '<div class="field"><span class="lbl">Severity</span><select id="edit-tk-sev" class="inp">'+sevOpts(t.severity)+'</select></div><div class="field"><span class="lbl">Description</span><textarea id="edit-tk-desc" class="txt" rows="4">'+esc(t.desc)+'</textarea></div>'+'<div class="field"><span class="lbl">Reason for correction</span><input id="edit-tk-reason" class="inp" maxlength="500" placeholder="What was entered incorrectly?" required></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="saveTicketEdit(\''+t.id+'\')">Save changes</button>');}
 /* --- ticket --- */
 if(m==="ticket"){const t=S.issues.find(x=>x.id===ctx.id);const role=AUTH_IDENTITY.role,isHead=role==="O&M Head",canWorkflow=isHead||role==="Assignee",canMessage=canWorkflow||role==="Site Engineer",sla=slaState(t),plant=plantRec(t.plant),siteLabel=plant?plant.id+" · "+plant.name:t.plant,canUploadPhotos=canMessage,evidence=t.evidence||[],progress=t.progress||[];
  let acts="";
  const b=(l,fn,cls)=>'<button class="btn sm '+(cls||"p")+'" onclick="'+fn+'">'+l+'</button>';
  if(isHead&&t.status==="Open")acts+=b("Assign","openModal('assign',{id:'"+t.id+"'})");
  if(canWorkflow&&t.status==="Assigned")acts+=b("Acknowledge","ackTicket('"+t.id+"')")+(isHead?b("Reassign","openModal('assign',{id:'"+t.id+"'})","o"):"");
  if(canWorkflow&&t.status==="Open"&&t.assignee)acts+=b("Acknowledge","ackTicket('"+t.id+"')","o");
  if(canWorkflow&&t.status==="Acknowledged")acts+=b("Start work","startTicket('"+t.id+"')")+(isHead?b("Reassign","openModal('assign',{id:'"+t.id+"'})","o"):"");
  if(canWorkflow&&t.status==="In Progress")acts+=b("Add progress","openModal('progress',{id:'"+t.id+"'})","o")+b("Pending parts/vendor","pendingTicket('"+t.id+"')","o")+b("Submit resolution","openModal('resolve',{id:'"+t.id+"'})");
  if(canWorkflow&&t.status==="Pending Vendor")acts+=b("Resume work","resumeTicket('"+t.id+"')","o")+b("Submit resolution","openModal('resolve',{id:'"+t.id+"'})");
  if(isHead&&t.status==="Resolved")acts+=b(I.check(13)+"Verify & close","openModal('verify',{id:'"+t.id+"'})","o")+b("Reopen","openModal('reopen',{id:'"+t.id+"'})","d");
  if(isHead&&t.status==="Closed")acts+=b("Reopen (recurred)","openModal('reopen',{id:'"+t.id+"'})","d");
  if(isHead)acts+=b("Edit details","openModal('editTicket',{id:'"+t.id+"'})","o");
  if(isHead&&t.dbId)acts+=b("Move to Deleted","s91ConfirmDeleteIssue('"+esc(t.id)+"')","d");
  acts+='<button class="btn o sm" onclick="closeModal()">Close</button>';
  const eqRec=s91IssueEquipment(t),eqLabel=s91IssueEquipmentLabel(t);
  return modal(t.id+" — "+t.vertical+(t.sub?" · "+t.sub:""),esc(siteLabel)+" · "+esc(eqLabel),
   issueWorkflowHtml(t)+'<div class="row wrap" style="gap:8px;margin:10px 0 12px">'+badge(t.status==="Pending Vendor"?"Pending Parts/Vendor":t.status)+badge(issueLevel(t))+
   (sla==="breach"?badge("Overdue"):"")+(sla==="nearing"?badge("Nearing ETC"):"")+(t.vendor?badge("Pending Vendor"):"")+'</div>'+
   '<div class="kgrid" style="grid-template-columns:repeat(3,1fr);gap:12px;font-size:12.5px;margin-bottom:12px">'+
   '<div><div class="k" style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--muted-foreground)">Issue ID</div>'+esc(t.id)+'</div>'+
   '<div><div class="k" style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--muted-foreground)">Plant code / site</div>'+esc(siteLabel)+'</div>'+
   '<div><div class="k" style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--muted-foreground)">Supplier</div>'+esc(t.supplier||"—")+'</div>'+
   '<div><div class="k" style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--muted-foreground)">Equipment</div>'+esc(eqLabel)+(eqRec&&eqRec.equipment_type?'<div class="muted" style="font-size:12.5px">'+esc(eqRec.equipment_type)+'</div>':'')+'</div>'+
   '<div><div class="k" style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--muted-foreground)">Serial number</div>'+esc(t.serialNumber||(eqRec&&eqRec.serial_number)||"—")+'</div>'+
   '<div><div class="k" style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--muted-foreground)">Maker</div>'+esc(t.maker||(eqRec&&eqRec.maker)||"—")+'</div>'+
   '<div><div class="k" style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--muted-foreground)">Issue type</div>'+esc(t.vertical)+'</div>'+
   '<div><div class="k" style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--muted-foreground)">Occurrence</div>'+fmtDT(t.occurred||t.created)+'</div>'+
   '<div><div style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--muted-foreground)">Created</div>'+fmtDT(t.created)+'</div>'+
   '<div><div style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--muted-foreground)">Age</div>'+esc(ageBucket(t))+'</div>'+
   '<div><div style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--muted-foreground)">ETC</div>'+fmtDT(t.etc)+'</div>'+
   '<div><div style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--muted-foreground)">Assignee</div>'+(t.assignee?esc(t.assignee):'<span style="color:var(--danger);font-weight:600">Unassigned</span>')+'</div>'+
   '<div><div style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--muted-foreground)">Priority</div>'+esc(t.severity)+'</div></div>'+
   '<div style="font-size:12.5px;margin-bottom:10px"><b>Description:</b> '+esc(t.desc)+'</div>'+
   (t.vendor?'<div class="bn-warn banner" style="margin-bottom:10px"><b>Vendor-Dependent</b> — '+esc(t.vendor.name)+' · '+esc(t.vendor.contact)+' · expected vendor response: '+esc(t.vendor.expected)+' (tracked separately)</div>':'')+
   '<div style="font-size:12.5px;color:var(--muted-foreground);margin:10px 0">📎 '+evidence.length+' of 10 evidence photos'+
    (evidence.length?'<div class="row wrap" style="gap:6px;margin-top:7px">'+evidence.map((e,i)=>'<button type="button" class="btn o sm" onclick="openIssueEvidence(\''+esc(t.id)+'\',\''+esc(e.id)+'\')">Photo '+(i+1)+(e.name?' · '+esc(e.name):"")+'</button>').join("")+'</div>':"")+
    (canUploadPhotos&&evidence.length<10&&t.dbId?'<label class="btn o sm" style="position:relative;overflow:hidden;margin-top:8px">Add photos<input type="file" accept="image/jpeg,image/png,image/webp" multiple style="position:absolute;inset:0;opacity:0;cursor:pointer" onchange="uploadMoreIssuePhotos(\''+esc(t.id)+'\',this)"/></label>':"")+'</div>'+
   (progress.length?'<div style="font-size:12.5px;font-weight:600;margin-bottom:6px">Work log — spare parts and time spent</div><div class="col">'+progress.map(p=>'<div class="row" style="gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border)"><span class="history-dot"></span>'+
    '<div style="font-size:12px">'+esc(p.note)+'<div style="font-size:12.5px;color:var(--muted-foreground)">Parts: '+esc(p.parts)+' · '+p.hrs+' hrs · '+fmtDT(p.at)+'</div></div></div>').join("")+'</div>':'')+
   (t.closure?'<div style="border:1px solid var(--success);background:var(--success-soft);border-radius:10px;padding:12px;font-size:12px;margin-top:10px"><b>Closure details</b>'+
    '<div style="margin-top:6px"><b>Root cause:</b> '+esc(t.closure.rootCause)+'</div><div><b>Corrective action taken:</b> '+esc(t.closure.corrective)+'</div>'+
    '<div style="margin-top:4px">📎 '+t.closure.photos+' photo(s) of fix · actual time-to-close <b>'+t.closure.resolutionHrs+' hrs</b> · resolved '+fmtDT(t.closure.closedAt)+'</div>'+
    ((t.closure.evidenceIds||[]).map((id,i)=>'<button type="button" class="btn o sm" style="margin:6px 5px 0 0" onclick="openIssueEvidence(\''+esc(t.id)+'\',\''+esc(id)+'\')">View fix photo '+(i+1)+'</button>').join(""))+
    (t.closure.verifiedBy?'<div style="margin-top:4px"><b>Verified by:</b> '+esc(t.closure.verifiedBy)+' (secondary reviewer)</div>':'')+'</div>':'')+
   '<section class="issue-updates"><div class="issue-updates-heading"><div><h4>Ticket updates</h4><p>Messages, photos and status changes are saved to this ticket.</p></div><button type="button" class="btn o sm" onclick="refreshIssueActivity(\''+esc(t.id)+'\')">Refresh</button></div>'+
    issueActivityHtml(t)+
    (canMessage&&t.dbId?'<div class="issue-message-form"><label class="lbl" for="issue-message">Message to the ticket team</label><textarea id="issue-message" class="txt" rows="3" maxlength="4000" placeholder="Share an update, question, or site observation…"></textarea><div class="issue-message-actions"><label class="btn o sm" style="position:relative;overflow:hidden">Attach photos<input id="issue-message-photos" type="file" accept="image/jpeg,image/png,image/webp" multiple style="position:absolute;inset:0;opacity:0;cursor:pointer" onchange="showIssueMessagePhotoSelection(this)"/></label><small id="issue-message-photo-count" class="muted">Photos optional · '+Math.max(0,10-evidence.length)+' remaining</small><button type="button" class="btn p sm" onclick="sendIssueMessage(\''+esc(t.id)+'\')">Send update</button></div></div>':'')+
   '</section>',
   '<div class="row" style="gap:8px;flex-wrap:wrap;justify-content:flex-end">'+acts+'</div>');}
 /* --- assign --- */
 if(m==="assign"){const t=S.issues.find(x=>x.id===ctx.id);
  return modal("Assign & triage — "+t.id+"","Assign to a specific team member (or vendor/OEM support for warranty issues) responsible for resolution",
   '<div class="field"><span class="lbl">Assign to</span><select id="at-who" class="inp" onchange="var v=document.getElementById(\'at-vf\');if(v)v.style.display=this.value===\'__vendor\'?\'grid\':\'none\'">'+
   TEAM_POOL.map(n=>'<option>'+n+'</option>').join("")+'<option value="__vendor">— Vendor / OEM support (warranty / specialist) —</option></select></div>'+
   '<div id="at-vf" style="display:none;border:1px dashed var(--warning);border-radius:10px;padding:12px;gap:10px" class="col">'+
   '<div class="field"><span class="lbl">Internal owner (tracks the ticket)</span><select id="at-owner" class="inp">'+TEAM_POOL.map(n=>'<option>'+n+'</option>').join("")+'</select></div>'+
   '<div class="field"><span class="lbl">Vendor name</span><input id="at-vn" class="inp" placeholder="e.g. VoltEdge OEM"/></div>'+
   '<div class="field"><span class="lbl">Vendor contact</span><input id="at-vc" class="inp" placeholder="Phone / email"/></div>'+
   '<div class="field"><span class="lbl">Expected vendor response time</span><input id="at-vr" class="inp" placeholder="e.g. 48h engineer mobilisation"/></div>'+
   '<div style="font-size:12.5px;color:var(--muted-foreground)">Ticket is tagged <b>Vendor-Dependent</b>; vendor response time is tracked separately.</div></div>'+
   (t.severity==="Critical"?'<div style="font-size:12px;font-weight:600;color:var(--danger)">☎ Critical severity — assignee gets an immediate call/SMS alert in addition to the app notification.</div>':''),
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="assignTicket()">Assign &amp; notify</button>');}
    /* --- progress --- */
 if(m==="progress")return modal("Add progress note","Assignee updates progress notes, actual inventory parts used, and time spent",
  '<div class="field"><span class="lbl">Progress note</span><textarea id="pg-note" class="txt" rows="3" placeholder="What was done / found?"></textarea></div>'+
  '<div class="row" style="gap:12px"><div style="flex:2" class="field"><span class="lbl">Spare part from inventory</span><select id="pg-part" class="inp"><option value="">— No part used —</option>'+S.inventory.map(x=>'<option value="'+x.id+'">'+esc(x.item)+' · '+x.qty+' '+esc(x.unit)+' · '+esc(x.plant)+'</option>').join("")+'</select></div>'+
  '<div style="flex:0 0 100px" class="field"><span class="lbl">Qty</span><input id="pg-qty" class="inp" type="number" min="1" value="1"/></div><div style="flex:1" class="field"><span class="lbl">Time spent (hrs)</span><input id="pg-hrs" class="inp" type="number" min="0" step="0.5" value="1"/></div></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="addProgress()">Save note</button>');
 /* --- resolve --- */
 if(m==="resolve"){const t=S.issues.find(x=>x.id===ctx.id);const spent=(t.progress||[]).reduce((s,p)=>s+(p.hrs||0),0);
  return modal("Submit resolution — "+t.id+"","On resolution, submit closure details: root cause, corrective action taken, photo evidence of fix, and actual time-to-close",
   '<div class="field"><span class="lbl">Root cause *</span><textarea id="rs-root" class="txt" rows="2" placeholder="What caused the issue?"></textarea></div>'+
   '<div class="field"><span class="lbl">Corrective action taken *</span><textarea id="rs-act" class="txt" rows="2" placeholder="What was done to fix it?"></textarea></div>'+
   '<div class="field"><span class="lbl">Photo evidence of the fix *</span><input id="rs-photos" class="inp" type="file" accept="image/jpeg,image/png,image/webp" multiple onchange="showResolutionPhotoSelection(this)"/><small id="rs-photo-count" class="muted">Attach at least one fix photo · '+Math.max(0,10-(t.evidence||[]).length)+' remaining</small></div>'+
   '<div style="font-size:12.5px;color:var(--muted-foreground)">Actual time-to-close is calculated and stored from ticket creation through resolution. Time already logged in work updates: '+spent+' hrs. An O&amp;M Head must verify and formally close this ticket, or reopen it if the issue recurs.</div>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="resolveTicket()">Submit for review</button>');}
 /* --- verify --- */
 if(m==="verify"){const t=S.issues.find(x=>x.id===ctx.id);const met=t.closure&&new Date(t.closure.closedAt)<=new Date(t.etc);
  return modal("Secondary review — "+t.id,"Verify the fix and formally close the ticket — or reopen it if the issue recurs",
   '<div style="font-size:13px;margin-bottom:12px">Actual time-to-close: <b>'+t.closure.resolutionHrs+' hrs</b> vs committed ETC '+fmtDT(t.etc)+' → '+(met?'<b style="color:var(--success)">ETC met ✓</b>':'<b style="color:var(--danger)">ETC missed ✗</b>')+'</div>'+
   '<div class="field"><span class="lbl">Verification remarks (optional)</span><input id="vf-rem" class="inp" placeholder="e.g. Fix verified on site — closed."/></div>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="verifyTicket()">'+I.check(13)+'Verify &amp; close</button>');}
 /* --- reopen --- */
 if(m==="reopen")return modal("Reopen ticket","Send the ticket back to Open — e.g. the issue recurred. Recurrence feeds chronic-problem detection.",
  '<div class="field"><span class="lbl">Reason</span><input id="ro-reason" class="inp" placeholder="e.g. Fault reappeared after 48 hrs…"/></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn d" onclick="reopenTicket()">Reopen ticket</button>');
 /* --- create inventory/vendor/document/SLA --- */
 if(m==="newInventory")return modal("Add stock item","Create an inventory record; low-stock state is derived from quantity vs minimum.",
  '<div class="field"><span class="lbl">Item name</span><input id="ni-item" class="inp" placeholder="e.g. 15A gPV fuse"/></div><div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Category</span><input id="ni-cat" class="inp" placeholder="Fuse / Module / Connector"/></div><div class="field" style="flex:1"><span class="lbl">Plant</span><select id="ni-plant" class="inp">'+S.plants.map(p=>'<option>'+esc(p.name)+'</option>').join("")+'</select></div></div><div class="field"><span class="lbl">Store / warehouse</span><input id="ni-store" class="inp" placeholder="Main store"/></div><div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Quantity</span><input id="ni-qty" class="inp" type="number" min="0" value="0"/></div><div class="field" style="flex:1"><span class="lbl">Minimum</span><input id="ni-min" class="inp" type="number" min="0" value="0"/></div><div class="field" style="flex:1"><span class="lbl">Unit</span><input id="ni-unit" class="inp" value="pcs"/></div></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="createInventory()">Add item</button>');
 if(m==="newVendor")return modal("Add vendor","Performance is not entered manually; on-time rate is derived from actual vendor-linked ticket data.",
  '<div class="field"><span class="lbl">Vendor name</span><input id="nv-name" class="inp"/></div><div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Type</span><select id="nv-type" class="inp"><option>OEM service partner</option><option>Washing contractor</option><option>Security agency</option><option>Other</option></select></div><div class="field" style="flex:1"><span class="lbl">Scope</span><input id="nv-scope" class="inp" placeholder="Plants / services covered"/></div></div><div class="field"><span class="lbl">SLA / service commitment</span><input id="nv-sla" class="inp" placeholder="e.g. 48h mobilisation"/></div><div class="field"><span class="lbl">Contract end</span><input id="nv-end" class="inp" type="date"/></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="createVendor()">Add vendor</button>');
 if(m==="newDocument")return modal("Add document","Store a document record with optional expiry; reminders are derived from the actual expiry date.",
  '<div class="field"><span class="lbl">Document name</span><input id="nd-name" class="inp"/></div><div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Type</span><input id="nd-type" class="inp" placeholder="Warranty / Certificate / Manual"/></div><div class="field" style="flex:1"><span class="lbl">Plant</span><select id="nd-plant" class="inp"><option>Portfolio</option>'+S.plants.map(p=>'<option>'+esc(p.name)+'</option>').join("")+'</select></div></div><div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Owner</span><input id="nd-owner" class="inp" value="'+OM_HEAD+'"/></div><div class="field" style="flex:1"><span class="lbl">Expiry date (optional)</span><input id="nd-exp" class="inp" type="date"/></div></div><div class="field"><span class="lbl">File</span><input id="nd-file" class="inp" type="file"/><span class="muted" style="font-size:12px">Document metadata is persisted in Supabase PostgreSQL. Binary document-file storage is not enabled for this module in the current production build.</span></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="createDocument()">Add document</button>');
 if(m==="newSLA")return modal("Add SLA contract","Targets are configuration only; breach status is derived from actual tickets/washing and Operations date.",
  '<div class="field"><span class="lbl">Contract name</span><input id="ns-name" class="inp" placeholder="O&M SLA"/></div><div class="field"><span class="lbl">Plant scope</span><select id="ns-plant" class="inp"><option>All Plants</option>'+S.plants.map(p=>'<option>'+esc(p.name)+'</option>').join("")+'</select></div><div class="row" style="gap:8px"><div class="field" style="flex:1"><span class="lbl">Critical (hrs)</span><input id="ns-c" type="number" class="inp" value="24"/></div><div class="field" style="flex:1"><span class="lbl">Medium</span><input id="ns-m" type="number" class="inp" value="120"/></div><div class="field" style="flex:1"><span class="lbl">Low</span><input id="ns-l" type="number" class="inp" value="240"/></div></div><div class="field"><span class="lbl">Washing frequency (days, optional)</span><input id="ns-w" type="number" min="0" class="inp" placeholder="e.g. 12"/></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="createSLA()">Save SLA</button>');
 /* --- incident --- */
 if(m==="incident")return modal("Report safety incident / near-miss","Separate register from equipment Issues — feeds the monthly compliance pack",
  '<div class="row" style="gap:12px"><div style="flex:2" class="field"><span class="lbl">Plant</span><select id="in-plant" class="inp">'+S.plants.map(p=>'<option>'+esc(p.name)+'</option>').join("")+'</select></div>'+
  '<div style="flex:1" class="field"><span class="lbl">Type</span><select id="in-type" class="inp"><option>Near Miss</option><option>Incident</option><option>First-aid case</option></select></div>'+
  '<div style="flex:1" class="field"><span class="lbl">Severity</span><select id="in-sev" class="inp"><option>Low</option><option>Medium</option><option>High</option></select></div></div>'+
  '<div class="field"><span class="lbl">Description</span><textarea id="in-desc" class="txt" rows="3" placeholder="What happened, who was involved, immediate state…"></textarea></div>',
  '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="reportIncident()">Log report</button>');
 /* --- issReport --- */
 if(m==="issReport"){
  const pm={};S.issues.forEach(t=>{if(!t.assignee)return;if(!pm[t.assignee])pm[t.assignee]={open:0,overdue:0,sh:0,n:0};
   if(t.status!=="Closed"&&t.status!=="Resolved"){pm[t.assignee].open++;if(slaState(t)==="breach")pm[t.assignee].overdue++;}
   if(t.closure&&t.closure.resolutionHrs){pm[t.assignee].sh+=t.closure.resolutionHrs;pm[t.assignee].n++;}});
  const rows=Object.entries(pm).map(e=>({name:e[0],...e[1],avg:e[1].n?e[1].sh/e[1].n:0})).sort((a,b)=>b.open-a.open);
  return modal("Issues — Person-wise performance report","Exportable report · generated "+stampLong(),
   '<table><thead><tr><th>Team member</th><th>Open</th><th>Overdue</th><th>Avg resolution</th></tr></thead><tbody>'+
   rows.map(r=>'<tr><td>'+esc(r.name)+'</td><td>'+r.open+'</td><td>'+r.overdue+'</td><td>'+(r.n?(r.avg>=48?(r.avg/24).toFixed(1)+" d":r.avg.toFixed(1)+" h"):"—")+'</td></tr>').join("")+'</tbody></table>',
   '<button class="btn o" onclick="window.print()">Print / save PDF</button><button class="btn p" onclick="closeModal()">Close</button>',true);
 }
 return"";
}
(function(){
 const style=document.createElement("style");
 style.textContent=
  ".issue-workflow{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px;margin:4px 0 14px}"+
  ".issue-workflow-step{min-width:0;display:flex;align-items:center;gap:6px;color:var(--muted-foreground);font-size:12px}"+
  ".issue-workflow-step span{width:20px;height:20px;flex:0 0 20px;border-radius:50%;display:grid;place-items:center;background:var(--surface-subtle);border:1px solid var(--border);font-size:12px}"+
  ".issue-workflow-step b{font-weight:550;line-height:1.2}.issue-workflow-step.done span{color:var(--success);border-color:var(--success)}"+
  ".issue-workflow-step.active{color:var(--foreground)}.issue-workflow-step.active span{background:var(--primary);border-color:var(--primary);color:#fff}"+
  ".issue-updates{margin-top:18px;padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--surface-subtle)}"+
  ".issue-updates-heading,.issue-message-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}"+
  ".issue-updates-heading h4{font-size:14px;margin:0}.issue-updates-heading p{font-size:12.5px;color:var(--muted-foreground);margin:3px 0 0}"+
  ".issue-activity-list{display:grid;gap:0;margin:12px 0}.issue-activity-item{display:grid;grid-template-columns:12px minmax(0,1fr);gap:10px;padding:9px 0;border-bottom:1px solid var(--border)}"+
  ".issue-activity-dot{width:8px;height:8px;margin:5px 0 0 2px;border-radius:50%;background:var(--primary)}.issue-activity-heading{display:flex;justify-content:space-between;gap:10px;font-size:12px}.issue-activity-heading span,.issue-activity-by{font-size:12px;color:var(--muted-foreground)}"+
  ".issue-activity-note{font-size:12px;white-space:pre-wrap;margin-top:5px}.issue-activity-status{font-size:12.5px;font-weight:650;margin-top:5px}.issue-activity-empty{font-size:12px;color:var(--muted-foreground);padding:14px 0}"+
  ".issue-message-form{border-top:1px solid var(--border);padding-top:12px}.issue-message-form .txt{margin:6px 0 8px}.issue-message-actions{justify-content:flex-start}.issue-message-actions small{flex:1}"+
  "@media(max-width:650px){.issue-workflow{grid-template-columns:repeat(3,minmax(0,1fr));row-gap:10px}.issue-workflow-step{font-size:11px}.issue-activity-heading{flex-direction:column;gap:2px}}";
 document.head.appendChild(style);
})();
