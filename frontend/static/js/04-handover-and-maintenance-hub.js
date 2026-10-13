"use strict";
/* ---------------- 1. HANDOVER ---------------- */
const HO_STAGES=["Commissioned","Checklist Assigned","In Execution","Pending Review","Ready for Approval","Approved","Active O&M"];
function hoStage(h){
 if(h.status==="active_om")return 7;
 if(h.status==="pending_approval")return 5;
 if(!h.items.length)return 1;
 const pr=hoProg(h);
 if(pr.total&&pr.done===pr.total)return 5;
 if(h.items.some(i=>i.status==="submitted"))return 4;
 if(h.items.some(i=>["in_progress","rejected"].includes(i.status)||counted(i)))return 3;
 return 2;
}
function pipelineStepper(){
 const st=S.handovers.map(h=>({h,s:hoStage(h)}));
 return '<div class="panel"><div class="row between wrap" style="margin-bottom:16px"><div><h2 style="font-size:15px;font-weight:600">Handover pipeline</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 0">Commissioned → Active O&amp;M · controlled transition of Steps 1.1–1.5</p></div>'+
  '<button class="btn p" onclick="openModal(\'commission\')">'+I.plus(13)+' New Handover</button></div>'+
  '<div class="pipeline">'+HO_STAGES.map((name,i)=>{const n=i+1;const here=st.filter(x=>x.s===n);const reached=st.some(x=>x.s>=n);
   return '<div class="pstage '+(here.length?"current":reached?"done":"")+'"><div class="cir">'+(here.length?n:reached?'✓':n)+'</div>'+
   '<div style="font-size:10.5px;font-weight:600;margin-top:7px;line-height:1.25">'+name+'</div>'+
   '<div style="font-size:9.5px;color:var(--muted-foreground);margin-top:2px;line-height:1.3">'+(here.length?here.map(x=>esc(x.h.handoverId)).join("<br>"):"—")+'</div></div>';}).join("")+'</div></div>';
}
function projectProgressCards(){
 const act=S.handovers.filter(h=>h.status!=="active_om").slice(0,3);
 if(!act.length)return "";
 return '<div class="kgrid" style="grid-template-columns:repeat(3,1fr)">'+act.map(h=>{const pr=hoProg(h);const od=h.items.filter(i=>i.mandatory&&itemOD(i)>0&&!counted(i)).length;
  return '<div class="panel sec-card" data-act="handover" data-id="'+esc(h.id)+'"><div class="row between" style="align-items:flex-start;gap:8px"><div><div style="font-size:13.5px;font-weight:700">'+esc(h.name)+'</div><div style="font-size:11px;color:var(--muted-foreground);margin-top:2px">'+esc(h.handoverId)+' · '+capLabel(h.capacity)+' · '+esc(unspecified(h.epc))+'</div></div>'+badge(HO_ST[h.status]||"In Progress")+'</div>'+
  '<div style="margin-top:12px"><div class="row between" style="font-size:11px;margin-bottom:4px"><span class="muted">Checklist completion</span><b>'+pr.done+'/'+pr.total+' · '+pr.pct+'%</b></div><div class="prog"><div style="width:'+pr.pct+'%;background:'+(pr.pct===100?"var(--success)":"var(--primary)")+'"></div></div></div>'+
  (od?'<div style="font-size:11px;color:var(--danger);font-weight:600;margin-top:9px">'+od+' critical item(s) overdue — escalated</div>':'<div style="font-size:11px;color:var(--muted-foreground);margin-top:9px">No critical overdue items</div>')+'</div>';}).join("")+'</div>';
}
function projectOverviewPanel(p){
 const prog=hoProg(p);
 const groups=CATEGORIES.map(c=>({name:c,items:p.items.filter(i=>i.category===c)})).filter(g=>g.items.length);
 const color=prog.pct===100?"var(--success)":prog.pct>=50?"var(--primary)":"var(--warning)";
 const canApprove=prog.total>0&&prog.done===prog.total&&p.status!=="active_om";
 return '<div class="panel"><div class="row between wrap" style="margin-bottom:6px;gap:8px"><div><h2 style="font-size:15px;font-weight:600">'+esc(p.name)+' — progress overview</h2><p style="font-size:12px;color:var(--muted-foreground);margin-top:3px">'+esc(p.handoverId)+' · '+esc(p.client)+' · commissioned '+esc(p.commissioned)+'</p></div>'+
  '<div class="row" style="gap:8px;flex-wrap:wrap">'+(p.status==="active_om"&&p.certificate?'<button class="btn o sm" onclick="openModal(\'certificate\',{hid:\''+p.id+'\'})">'+I.fcheck(13)+' Certificate</button>':'')+
  (prog.total?'<button class="btn o sm" onclick="document.getElementById(\'handover-detail\')?.scrollIntoView({behavior:\'smooth\'})">View Full Checklist</button>':'')+
  (canApprove?'<button class="btn p sm" onclick="openModal(\'approval\',{hid:\''+p.id+'\'})">'+I.fsig(13)+' Submit for Approval</button>':'')+'</div></div>'+
  '<div class="kgrid" style="grid-template-columns:190px minmax(0,1fr);align-items:center;gap:22px;margin-top:10px">'+
  '<div style="display:grid;place-items:center"><div class="ring" style="width:132px;height:132px;--ri:16px;background:conic-gradient('+color+' '+prog.pct+'%,#E9EEEB 0)"><b style="font-size:26px">'+prog.pct+'%</b></div><div style="font-size:11px;color:var(--muted-foreground);margin-top:9px;text-align:center">'+prog.done+'/'+prog.total+' items closed</div></div>'+
  '<div class="col" style="gap:9px;min-width:0"><div style="font-size:12.5px;font-weight:700">Category Breakdown</div>'+
  (groups.length?groups.map(g=>{const d=g.items.filter(counted).length;const pct=Math.round(d/g.items.length*100);
   return '<div><div class="row between" style="font-size:11.5px;margin-bottom:3px"><span>'+esc(g.name)+'</span><b>'+d+'/'+g.items.length+'</b></div><div class="hbar"><i style="width:'+pct+'%;background:'+(pct===100?"var(--success)":"var(--primary)")+'"></i></div></div>';}).join(""):'<div class="muted" style="font-size:12px">Checklist not assigned yet — apply the standard template below (Step 1.2).</div>')+'</div></div></div>';
}
function renderHandover(){
 const p=S.handovers.find(h=>h.id===S.hoOpen)||S.handovers[0];
 if(!p)return '<div class="panel" style="text-align:center;padding:40px"><h2 style="font-size:15px;font-weight:600">No handover projects yet</h2><p style="font-size:12px;color:var(--muted-foreground);margin:6px 0 14px">Commissioned projects appear here for checklist tracking and approval.</p><button class="btn p" onclick="openModal(\'commission\')">+ Commission project (1.1)</button></div>';
 const hf=S.hoF;
 const hoAssignees=[...new Set(S.handovers.flatMap(h=>h.items.map(i=>i.assignee)))].sort();
 const hoViewStatus=h=>h.items.length?(hoProg(h).pct===100?"Completed":HO_ST[h.status]||"In Progress"):"Empty";
 const hoStatuses=[...new Set(S.handovers.map(hoViewStatus))].sort();
 const visibleHandovers=S.handovers.filter(h=>(hf.status==="all"||hoViewStatus(h)===hf.status)&&(hf.assignee==="all"||h.items.some(i=>i.assignee===hf.assignee))&&(!hf.q||[h.handoverId,h.name,h.client,h.epc,...h.items.map(i=>i.title),...h.items.map(i=>i.category)].join(" ").toLowerCase().includes(hf.q.toLowerCase())));
 const handoverRows=pageRows("handover",visibleHandovers,LIST_SIZE);
 const prog=hoProg(p);
 const canApprove=prog.total>0&&prog.done===prog.total&&p.status!=="active_om";
 const groups=CATEGORIES.map(c=>({name:c,hint:CAT_HINT[c],items:p.items.filter(i=>i.category===c)})).filter(g=>g.items.length);
 const naCount=p.items.filter(i=>i.status==="na").length;
 let h='<div style="display:flex;flex-direction:column;gap:16px">'+pipelineStepper()+projectProgressCards()+projectOverviewPanel(p)+statusCircleCards("Handover status",visibleHandovers.map(x=>({status:hoViewStatus(x)})));
 h+='<div class="panel"><div class="row between wrap" style="margin-bottom:10px"><div><h2 style="font-size:15px;font-weight:600">Handover filters</h2><p style="font-size:12px;color:var(--muted-foreground);margin-top:3px">Find projects and checklist bottlenecks before opening the detailed record.</p></div><span class="pill pillsm" style="color:var(--info);background:var(--info-soft)">'+visibleHandovers.length+' of '+S.handovers.length+' projects</span></div><div class="row wrap" style="align-items:end;gap:8px">'+
  '<div class="field" style="min-width:160px;flex:1"><span class="lbl">Handover status</span><select class="inp" onchange="S.hoF.status=this.value;render()"><option value="all">All statuses</option>'+hoStatuses.map(x=>'<option '+(hf.status===x?"selected":"")+'>'+esc(x)+'</option>').join("")+'</select></div>'+
  '<div class="field" style="min-width:160px;flex:1"><span class="lbl">Checklist assignee</span><select class="inp" onchange="S.hoF.assignee=this.value;render()"><option value="all">All assignees</option>'+hoAssignees.map(x=>'<option '+(hf.assignee===x?"selected":"")+'>'+esc(x)+'</option>').join("")+'</select></div>'+
  '<div class="field" style="min-width:240px;flex:2"><span class="lbl">Search project or checklist item</span><input class="inp" value="'+esc(hf.q)+'" placeholder="e.g. relay, documentation" oninput="S.hoF.q=this.value;renderSoon()"/></div>'+
  '<button class="btn o sm" onclick="S.hoF={status:\'all\',assignee:\'all\',q:\'\'};render()">Clear filters</button></div></div>';
 h+='<div id="section-results" class="panel" style="padding:0"><div style="padding:16px 20px 0"><div class="row between wrap"><div><h2 style="font-size:15px;font-weight:600">Handover register</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 12px">One record per commissioned project — select to work its checklist</p></div><button class="btn p" onclick="openModal(\'commission\')">+ Commission a project</button></div></div>';
 h+='<table><thead><tr><th>Handover ID</th><th>Project</th><th>Commissioned</th><th>EPC</th><th>Checklist</th><th>Escalations</th><th>Status</th><th></th></tr></thead><tbody>';
 handoverRows.forEach(x=>{const pr=hoProg(x);const escN=x.items.filter(i=>i.mandatory&&itemOD(i)>0).length;
  h+='<tr class="click'+(S.flashId===x.id?' flash-new':'')+'" data-rid="'+esc(x.id)+'" data-act="handover" data-id="'+esc(x.id)+'" style="'+(S.hoOpen===x.id?"background:var(--secondary)":"")+'">'+
  '<td style="font-weight:600">'+esc(x.handoverId)+'</td><td><div style="font-weight:600">'+esc(x.name)+'</div><div style="font-size:11px;color:var(--muted-foreground)">'+capLabel(x.capacity)+' · '+esc(unspecified(x.client))+'</div></td>'+
  '<td>'+x.commissioned+'</td><td>'+esc(x.epc)+'</td>'+
  '<td style="min-width:140px">'+(pr.total?'<div style="font-size:11px;margin-bottom:4px"><b>'+pr.done+'/'+pr.total+'</b> · '+pr.pct+'%</div><div class="prog"><div style="width:'+pr.pct+'%;background:'+(pr.pct===100?"var(--success)":"var(--primary)")+'"></div></div>':'<span style="color:var(--muted-foreground)">Not assigned</span>')+'</td>'+
  '<td style="color:'+(escN?"var(--danger)":"var(--muted-foreground)")+';font-weight:'+(escN?600:400)+'">'+(escN||"—")+'</td>'+
  '<td>'+badge(HO_ST[x.status]||"In Progress")+'</td><td style="color:var(--muted-foreground)">'+I.chev(14)+'</td></tr>';});
 h+='</tbody></table>'+tablePager("handover",visibleHandovers.length,LIST_SIZE)+'</div>';
 h+='<div class="kgrid" style="grid-template-columns:2fr 1fr;align-items:start"><div class="col" style="gap:16px">';
 h+='<div class="panel" id="handover-detail"><div class="row between wrap" style="margin-bottom:12px"><div><h2 style="font-size:15px;font-weight:600">'+esc(p.name)+' — '+esc(p.handoverId)+' · '+esc(p.id)+'</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 0">'+(p.location?esc(p.location)+' · ':'')+(p.projectType?esc(p.projectType)+' · ':'')+capLabel(p.capacity)+' · Commissioned '+p.commissioned+' · '+esc(unspecified(p.epc))+' · '+esc(unspecified(p.client))+'</p>'+(p.gps||p.dcCapacity||p.assetLayout?'<p style="font-size:11px;color:var(--muted-foreground);margin:3px 0 0">GPS: '+esc(unspecified(p.gps))+' · DC CAPACITY (kWp) (kWp): '+esc(unspecified(p.dcCapacity))+' · '+esc(unspecified(p.assetLayout))+'</p>':'')+'</div>'+badge(HO_ST[p.status]||"In Progress")+'</div>';
 if(p.status==="active_om"){h+='<div class="bn-ok banner" style="margin-bottom:14px"><b style="color:var(--success)">Active — Regular O&amp;M (Step 1.5).</b> On approval, status changed automatically and Preventive Maintenance, Washing and Issues were provisioned — this plant is live in tabs 2.1–2.3.'+(p.approval&&p.approval.remarks?'<div style="margin-top:6px;color:var(--muted-foreground)"><b>Approval remarks:</b> '+esc(p.approval.remarks)+'</div>':'')+'</div>';}
 if(!p.items.length){
  h+='<div style="border:1px dashed var(--border);border-radius:10px;padding:20px;text-align:center"><div style="font-weight:600;font-size:13px">Checklist not assigned — Step 1.2</div>'+
   '<p style="font-size:12px;color:var(--muted-foreground);margin:6px 0 12px">Apply the standard checklist template (configurable per project type / capacity band) or customize with project-specific items. Assignees get due dates, priority, instructions &amp; attachment requirements, and are notified on assignment.</p>'+
   '<div class="row" style="justify-content:center;flex-wrap:wrap"><button class="btn p" onclick="applyTemplate(\''+p.id+'\')">Apply standard template — '+CHECKLIST.length+' items · 6 categories</button>'+
   '<button class="btn o" onclick="openModal(\'addItem\',{hid:\''+p.id+'\'})">+ Add custom item</button></div></div>';
 }else{
  groups.forEach(g=>{const done=g.items.filter(counted).length;const pct=Math.round(done/g.items.length*100);
  h+='<div style="border:1px solid var(--border);border-radius:10px;overflow-x:auto;margin-bottom:14px">';
   h+='<div class="row between wrap" style="padding:10px 14px;background:var(--surface-subtle)"><div><div style="font-weight:600;font-size:13px">'+g.name+'</div><div style="font-size:11px;color:var(--muted-foreground)">'+g.hint+'</div></div>'+
    '<div style="min-width:130px"><div style="font-size:11px;margin-bottom:4px;text-align:right"><b>'+done+'/'+g.items.length+'</b> · '+pct+'%</div><div class="prog"><div style="width:'+pct+'%;background:'+(pct===100?"var(--success)":"var(--primary)")+'"></div></div></div></div>';
   h+='<table><thead><tr><th>Item</th><th>Assignee</th><th>Due</th><th>Evidence</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
   g.items.forEach(it=>{
    const od=itemOD(it);
    let flag="";
    if(od>0)flag=it.mandatory?'<div class="flag" style="color:var(--danger)">🚨 Overdue '+od+'d — escalated '+(od>=3?"to O&M Director":"to O&M Head")+'</div>':'<div class="flag" style="color:var(--warning-strong)">Overdue '+od+'d — reminder sent</div>';
    const ro=p.status==="active_om";
    let acts="";
    if(ro)acts='<span style="font-size:11px;color:var(--muted-foreground)">Read-only (audit archive)</span>';
    else{
     const b=(l,fn,cls)=>'<button class="btn sm '+(cls||"o")+'" onclick="'+fn+'">'+l+'</button>';
     const id=p.id,iid=it.id;
     if(it.status==="not_started")acts+=b("Start","startItem('"+id+"','"+iid+"')");
     if(["not_started","in_progress","rejected"].includes(it.status))acts+=' <button class="btn o sm" onclick="openModal(\'evidence\',{hid:\''+id+'\',iid:\''+iid+'\'})">+ Evidence</button>';
     if(["in_progress","rejected"].includes(it.status))acts+=' <button class="btn p sm" onclick="submitItem(\''+id+'\',\''+iid+'\')">'+I.send(12)+'Submit</button>';
     if(it.status==="submitted")acts+=' <button class="btn o sm" onclick="verifyItem(\''+id+'\',\''+iid+'\')">'+I.check(12)+'Verify</button> <button class="btn d sm" onclick="openModal(\'reject\',{hid:\''+id+'\',iid:\''+iid+'\'})">'+I.xcirc(12)+'Reject</button>';
     if(!["completed","na"].includes(it.status))acts+=' <button class="btn g sm" onclick="openModal(\'na\',{hid:\''+id+'\',iid:\''+iid+'\'})">N/A</button>';
    }
    h+='<tr><td style="min-width:220px"><div style="font-weight:500">'+esc(it.title)+' '+badge(it.priority)+' '+(it.mandatory?'<span style="font-size:10px;font-weight:700;color:var(--primary)">PROOF MANDATORY</span>':'')+'</div>'+
     (it.instructions?'<div style="font-size:11px;color:var(--muted-foreground);margin-top:3px"><b>Instructions:</b> '+esc(it.instructions)+'</div>':'')+
     (it.reworkNote?'<div style="font-size:11px;color:var(--danger);margin-top:3px"><b>Rework:</b> '+esc(it.reworkNote)+'</div>':'')+
     (it.naJustification?'<div style="font-size:11px;color:var(--muted-foreground);margin-top:3px"><b>N/A:</b> '+esc(it.naJustification)+'</div>':'')+flag+'</td>'+
     '<td class="nowrap">'+esc(it.assignee)+'</td><td class="nowrap">'+it.due+'</td><td class="nowrap"><b>'+it.evidence+'</b> file(s)</td>'+
     '<td>'+badge(ITEM_ST[it.status]||"Not Started")+'</td><td class="nowrap"><div class="row" style="gap:5px;flex-wrap:wrap">'+acts+'</div></td></tr>';});
   h+='</tbody></table>';
   if(p.status!=="active_om")h+='<div style="padding:8px 14px"><button class="btn g sm" onclick="openModal(\'addItem\',{hid:\''+p.id+'\'})">+ Add custom item to '+g.name+'</button></div>';
   h+='</div>';});
 }
 h+='</div>'; /* close panel of groups */
 h+='<div class="panel"><div class="row between" style="margin-bottom:14px"><div><h2 style="font-size:15px;font-weight:600">Activity &amp; audit trail</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 0">Mirrors the immutable 3.12 audit log</p></div></div><div class="col">';
 (p.log||[]).forEach(l=>{h+='<div class="row" style="gap:10px;align-items:flex-start;padding-bottom:8px;border-bottom:1px solid var(--border)"><span class="history-dot"></span><div style="font-size:12.5px">'+esc(l.text)+'<div style="font-size:11px;color:var(--muted-foreground)">'+esc(l.actor)+' · '+l.at+'</div></div></div>';});
 h+='</div></div></div>'; /* close left col */
 /* right rail */
 h+='<div class="panel"><div class="row between" style="margin-bottom:8px"><div><h2 style="font-size:15px;font-weight:600">Completion (Step 1.3)</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 0">Running % — reviewers verify as items come in</p></div></div>';
 h+='<div style="font-size:30px;font-weight:700;margin:2px 0 8px">'+prog.pct+'%</div><div class="prog"><div style="width:'+prog.pct+'%;background:'+(prog.pct===100?"var(--success)":"var(--primary)")+'"></div></div>';
 h+='<div style="font-size:11.5px;color:var(--muted-foreground);margin:8px 0 12px">'+prog.done+'/'+prog.total+' items closed ('+naCount+' N/A justified)</div>';
 h+='<div class="col" style="gap:6px;font-size:12.5px">'+
  '<div class="row between"><span class="muted">Awaiting review</span><b>'+p.items.filter(i=>i.status==="submitted").length+'</b></div>'+
  '<div class="row between"><span class="muted">Rejected / rework</span><b>'+p.items.filter(i=>i.status==="rejected").length+'</b></div>'+
  '<div class="row between"><span class="muted">Critical overdue</span><b style="color:'+(p.items.some(i=>i.mandatory&&itemOD(i)>0)?"var(--danger)":"inherit")+'">'+p.items.filter(i=>i.mandatory&&itemOD(i)>0).length+'</b></div>'+
  '<div class="row between"><span class="muted">Evidence files</span><b>'+p.items.reduce((s,i)=>s+i.evidence,0)+'</b></div></div>';
 h+='<div class="col" style="gap:8px;margin-top:14px">';
 if(p.status==="active_om"&&p.certificate)h+='<button class="btn o" onclick="openModal(\'certificate\',{hid:\''+p.id+'\'})">'+I.fcheck(14)+'View completion certificate</button>';
 else{
  h+='<button class="btn p" '+(canApprove?"":"disabled")+' onclick="openModal(\'approval\',{hid:\''+p.id+'\'})">'+I.fsig(14)+'Initiate final approval</button>';
  h+=canApprove?'<div style="font-size:11px;font-weight:600;color:var(--success)">System prompt: all items closed — final approval due (Step 1.4)</div>':'<div style="font-size:11px;color:var(--muted-foreground)">Gate unlocks when every item is Completed, or N/A with justification.</div>';
 }
 h+='</div></div></div></div>';
 return h;
}
