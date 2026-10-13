"use strict";
/* ================================================================
   ACTIONS
   ================================================================ */
function goView(v){
 if(S.modal){S.modal=null;S.modalCtx=null;}
 const role=S._roleLabel||S.currentRole||"O&M Head";
 if(role==="Site Engineer"&&["performance","reports","settings","data","plants","work"].includes(v)){toast("This module is not available in Site Engineer view.");S.view="dashboard";persistView();render();return}
 S.view=v;persistView();render()
}
function goTab(t){
 if(S.modal){S.modal=null;S.modalCtx=null;}
 const role=S._roleLabel||S.currentRole||"O&M Head";
 if(role==="Site Engineer"&&["handover","services","analytics"].includes(t)){toast("This module is not available in Site Engineer view.");S.view="om-module";S.omTab="issues";persistView();render();return}
 S.view="om-module";S.omTab=t;persistView();render()
}
function pickHO(id){S.hoOpen=id;persist();render();setTimeout(()=>{const detail=document.getElementById("handover-detail");if(detail)detail.scrollIntoView({behavior:"smooth",block:"start"})},0)}
function openModal(name,ctx){S.modal=name;S.modalCtx=ctx||{};render();if(name==="ticket")refreshIssueActivity(S.modalCtx.id,false)}
function closeModal(){S.modal=null;S.modalCtx=null;render()}
async function refreshIssueActivity(ticketId,showErrors){
 const t=(S.issues||[]).find(x=>x.id===ticketId);if(!t)return;
 if(!t.dbId){t.activityLoaded=true;t.activityError="Ticket updates are available after this issue is synchronized to the server.";if(S.modal==="ticket"&&(S.modalCtx||{}).id===ticketId)render();return}
 t.activityLoading=true;t.activityError=null;
 try{
  t.activity=await apiFetch("/api/issues/"+encodeURIComponent(t.dbId)+"/activity");
  t.activityLoaded=true;
 }catch(e){
  t.activityError=e.message||"Could not load ticket updates.";
  if(showErrors)toast(t.activityError);
 }
 t.activityLoading=false;
 if(S.modal==="ticket"&&(S.modalCtx||{}).id===ticketId)render();
}
function showIssueMessagePhotoSelection(input){
 const files=Array.from(input.files||[]),ticket=(S.issues||[]).find(x=>x.id===(S.modalCtx||{}).id),remaining=Math.max(0,10-((ticket&&ticket.evidence)||[]).length),label=document.getElementById("issue-message-photo-count");
 if(files.length>remaining){input.value="";if(label)label.textContent="Only "+remaining+" photo(s) remaining";toast("This ticket can have no more than 10 evidence photos.");return}
 if(label)label.textContent=files.length?files.length+" photo(s) selected · "+remaining+" remaining":"Photos optional · "+remaining+" remaining";
}
function showResolutionPhotoSelection(input){
 const files=Array.from(input.files||[]),ticket=(S.issues||[]).find(x=>x.id===(S.modalCtx||{}).id),remaining=Math.max(0,10-((ticket&&ticket.evidence)||[]).length),label=document.getElementById("rs-photo-count");
 if(files.length>remaining){input.value="";if(label)label.textContent="Only "+remaining+" photo(s) remaining";toast("This ticket can have no more than 10 evidence photos.");return}
 if(label)label.textContent=files.length?files.length+" fix photo(s) selected":"Attach at least one fix photo · "+remaining+" remaining";
}
async function sendIssueMessage(ticketId){
 const t=(S.issues||[]).find(x=>x.id===ticketId),input=document.getElementById("issue-message-photos"),message=(document.getElementById("issue-message")||{}).value.trim();
 if(!t||!t.dbId)return;
 const files=Array.from(input&&input.files||[]);
 if(!message&&!files.length){toast("Enter an update or attach a photo.");return}
 try{
  let saved=[];
  if(files.length){saved=await uploadIssuePhotos(t,input);input.value="";}
  t.evidence=(t.evidence||[]).concat(saved);t.photos=t.evidence.length;
  const update=await apiFetch("/api/issues/"+encodeURIComponent(t.dbId)+"/comments",{method:"POST",body:{message,evidence_ids:saved.map(item=>item.id)}});
  t.activity=t.activity||[];t.activity.push(update);t.activityLoaded=true;
  render();toast("Ticket update saved and shared with the issue team.");
 }catch(e){render();toast(e.message||"Could not save ticket update.")}
}
function patchHO(id,fn){S.handovers=S.handovers.map(h=>h.id===id?fn(h):h)}
function hoLog(h,text,actor){return{...h,log:[{at:stamp(),text,actor},...(h.log||[])]}}
function commission(){
 const name=(document.getElementById("cm-name").value.trim());
 if(!name){toast("Project name is required.");wizardGo("commission",1);return}
 const location=document.getElementById("cm-location").value.trim();
 const projectType=document.getElementById("cm-type").value;
 const capRaw=document.getElementById("cm-cap").value.trim();
 const cap=capRaw===""?"":(isNaN(parseFloat(capRaw))?"":capRaw);
 const epc=document.getElementById("cm-epc").value.trim();
 const gps=document.getElementById("cm-gps").value.trim();
 const dcCapacity=document.getElementById("cm-dc").value.trim();
 const assetLayout=document.getElementById("cm-layout").value.trim();
 const client=document.getElementById("cm-client").value.trim();
 const id=uid("p");
 const ho={id,handoverId:"HOV-"+String(seq).padStart(5,"0"),name,location,projectType,capacity:cap,dcCapacity,gps,assetLayout,commissioned:fmtDate(TODAY),epc,client,status:"pending_checklist",items:[],approval:null,certificate:null,
  log:[{at:stamp(),text:"Handover entry created — "+name+" · ID "+id+" / HOV-"+String(seq).padStart(5,"0")+" (same sequence); Pending Checklist Assignment (Step 1.1)",actor:"System"}]};
 S.handovers.unshift(ho);S.hoOpen=id;revealNew("handover",id);
 audit("Handover","Entry created — "+name+" ("+id+" / "+ho.handoverId+")","System","—","Pending Checklist");
 S.modal=null;persist();render();toast("Handover "+ho.handoverId+" created ("+id+").");
}
function applyTemplate(id){
 patchHO(id,h=>hoLog({...h,items:CHECKLIST.map((x,i)=>mkItem(id+"-T"+(i+1),x.c,x.t,x.m,ASSIGNEES[i%ASSIGNEES.length],addDays(TODAY,7),"not_started",0)),status:"in_progress"},
  "Standard checklist template applied — "+CHECKLIST.length+" items across 6 categories; assignees notified in-app + email/SMS with reminders scheduled",OM_HEAD));
 audit("Handover","Checklist template applied",OM_HEAD,"empty",CHECKLIST.length+" items assigned");
 persist();render();toast("Template applied — items assigned with due dates, priorities & attachment requirements (Step 1.2).");
}
function addItem(){
 const hid=S.modalCtx.hid;
 const cat=document.getElementById("ai-cat").value,title=document.getElementById("ai-title").value.trim();
 if(!title){toast("Item title is required.");return}
 const prio=document.getElementById("ai-prio").value,mand=prio==="Critical";
 const item=mkItem(uid("CUS"),cat,title,mand,document.getElementById("ai-who").value,document.getElementById("ai-due").value||addDays(TODAY,5),"not_started",0);
 item.instructions=document.getElementById("ai-instructions").value.trim()||item.instructions;
 patchHO(hid,h=>hoLog({...h,items:[...h.items,item],status:h.status==="pending_checklist"?"in_progress":h.status},"Custom item added to "+cat+' — "'+title+'" ('+item.assignee+", due "+item.due+", "+prio+")",OM_HEAD));
 S.modal=null;persist();render();toast("Custom item added & assigned (Step 1.2).");
}
function startItem(hid,iid){patchHO(hid,h=>{const it=h.items.find(i=>i.id===iid);return hoLog({...h,items:h.items.map(i=>i.id===iid?{...i,status:"in_progress"}:i)},'Started "'+it.title+'"',it.assignee)});persist();render()}
function addEvidence(){
 const{hid,iid}=S.modalCtx;const n=Math.max(1,parseInt(document.getElementById("ev-count").value)||1);
 patchHO(hid,h=>{const it=h.items.find(i=>i.id===iid);
  return hoLog({...h,items:h.items.map(i=>i.id===iid?{...i,evidence:i.evidence+n,status:i.status==="not_started"?"in_progress":i.status}:i)},"Uploaded "+n+" evidence file(s) against \""+it.title+'"',it.assignee)});
 S.modal=null;persist();render();toast("Evidence attached (Step 1.3).");
}
function maybeHandoverReady(hid){const h=S.handovers.find(x=>x.id===hid);if(h&&h.items.length&&h.items.every(counted))emitEvent("handover_ready","Handover ready for approval — "+h.name,h.handoverId,"handover",h.id,"handover_ready:"+h.id)}
function submitItem(hid,iid){
 patchHO(hid,h=>{const it=h.items.find(i=>i.id===iid);
  if(it.mandatory&&it.evidence===0){toast("Attachment requirement: upload proof before submitting for review.");return h}
  return hoLog({...h,items:h.items.map(i=>i.id===iid?{...i,status:"submitted",reworkNote:null}:i)},'Submitted "'+it.title+'" for review',it.assignee)});
 audit("Handover","Item submitted for review","","In Progress","Pending Review");const hh=S.handovers.find(x=>x.id===hid),ii=hh&&hh.items.find(x=>x.id===iid);if(ii)emitEvent("checklist_submitted","Checklist item submitted — "+ii.title,hh.name+" · "+ii.assignee,"handover",hid,"check_submit:"+hid+":"+iid+":"+ii.evidence);persist();render();
}
function verifyItem(hid,iid){
 patchHO(hid,h=>{const it=h.items.find(i=>i.id===iid);
  return hoLog({...h,items:h.items.map(i=>i.id===iid?{...i,status:"completed"}:i)},'Verified and approved "'+it.title+'" — running completion updated',OM_HEAD+" (O&M Head)")});
 audit("Handover","Item verified",OM_HEAD,"Pending Review","Completed");maybeHandoverReady(hid);persist();render();
}
function rejectItem(){
 const{hid,iid}=S.modalCtx;
 const reason=document.getElementById("rj-reason").value.trim()||"Evidence unclear — resubmission required.";
 patchHO(hid,h=>{const it=h.items.find(i=>i.id===iid);
  return hoLog({...h,items:h.items.map(i=>i.id===iid?{...i,status:"rejected",reworkNote:reason}:i)},'Rejected "'+it.title+'" with reason — sent back to assignee for rework (cycle repeats until accepted): '+reason,OM_HEAD+" (O&M Head)")});
 audit("Handover","Item rejected — sent for rework",OM_HEAD,"Pending Review","Changes Requested");
 const hh=S.handovers.find(x=>x.id===hid),ii=hh&&hh.items.find(x=>x.id===iid);if(ii)emitEvent("checklist_rejected","Checklist item rejected — "+ii.title,hh.name+" · "+reason,"handover",hid,"check_reject:"+hid+":"+iid+":"+TODAY);
 S.modal=null;persist();render();toast("Rejected — item sent back to assignee with comments.");
}
function naItem(){
 const{hid,iid}=S.modalCtx;const just=document.getElementById("na-just").value.trim();
 if(!just){toast("Justification is required to mark an item N/A (Step 1.4).");return}
 patchHO(hid,h=>{const it=h.items.find(i=>i.id===iid);
  return hoLog({...h,items:h.items.map(i=>i.id===iid?{...i,status:"na",naJustification:just}:i)},'Marked "'+it.title+'" as N/A with justification — '+just,OM_HEAD+" (O&M Head)")});
 maybeHandoverReady(hid);S.modal=null;persist();render();toast("Marked N/A with justification.");
}
function reopenItems(){
 const{hid}=S.modalCtx;
 const ids=[...document.querySelectorAll("input[name='fa-reopen']:checked")].map(c=>c.value);
 if(!ids.length){toast("Select at least one item to reopen.");return}
 const reason=document.getElementById("fa-reason").value.trim()||"Gap found during final review — resubmission required.";
 patchHO(hid,h=>hoLog({...h,items:h.items.map(i=>ids.includes(i.id)?{...i,status:"rejected",reworkNote:reason}:i)},
  "Final approval review — "+ids.length+" item(s) rejected/reopened and sent back to Step 1.3: "+reason,OM_HEAD+" (O&M Head)"));
 audit("Handover","Final approval — items reopened",OM_HEAD,"Ready for Approval","In Progress");
 S.modal=null;persist();render();toast(ids.length+" item(s) sent back for rework (Step 1.3).");
}
function approveHandover(){
 const{hid}=S.modalCtx;
 const sign=document.getElementById("fa-sign").value.trim();
 if(sign!==OM_HEAD){toast("E-signature must exactly match the approver name: "+OM_HEAD);return}
 const remarks=document.getElementById("fa-remarks").value.trim();
 const h=S.handovers.find(x=>x.id===hid);
 patchHO(hid,x=>{
  let nh=hoLog({...x,status:"active_om",approval:{approver:OM_HEAD,signedAt:stampLong(),remarks:remarks||null},certificate:{no:"HCC-"+x.handoverId,at:stampLong()}},
   'Final approval granted'+(remarks?' — remarks/conditions: "'+remarks+'"':"")+" — e-signature confirmed; approval timestamped with approver identity for audit (Step 1.4)",OM_HEAD+" (O&M Head)");
  nh=hoLog(nh,"Status changed to Active — Regular O&M; Preventive Maintenance, Washing and Issues auto-provisioned (Step 1.5)","System");
  return nh;});
 if(h&&!openPlant(h.name)){
  const capN=parseFloat(h.capacity);const cap=Number.isFinite(capN)?capN:null;
  S.plants.push({id:uid("PLT"),name:h.name,capacity:cap,status:null,generation:null,availability:null,pr:null,alarms:null,source:"handover"});
  S.washMeta[h.name]={team:[],freq:12};
  S.docs.unshift({id:uid("DOC"),plant:h.name,name:"Handover Completion Certificate — "+h.handoverId,type:"Handover Certificate",expires:null,owner:OM_HEAD});
  audit("Handover","Project provisioned into Regular O&M — "+h.name+" (Preventive Maintenance · Washing · Issues)","System","—","Active O&M");
 }
 audit("Handover","Final approval + transition",OM_HEAD,"Ready for Approval","Active O&M");
 S.modal=null;persist();render();
 toast("Handover approved — e-signature recorded, certificate generated, project transitioned to Active O&M (1.4 → 1.5).");
 setTimeout(()=>{S.modal="certificate";S.modalCtx={hid};render()},150);
}
/* --- 2.1 actions --- */
function createTask(){
 const name=document.getElementById("nt-name").value.trim();
 if(!name){toast("Task name is required.");return}
 const t={id:uid("WO"),plant:document.getElementById("nt-plant").value||S.plants[0].name,name,type:document.getElementById("nt-type").value,
  equip:pickedEquip("nt"),freq:document.getElementById("nt-freq").value,
  due:document.getElementById("nt-start").value||addDays(TODAY,3),assignee:document.getElementById("nt-who").value,status:"Scheduled",
  sop:document.getElementById("nt-sop").value.trim()||"SOP ref on file",safety:document.getElementById("nt-safety").value,
  tools:document.getElementById("nt-tools").value.trim()||"Standard toolkit",duration:document.getElementById("nt-dur").value.trim()||"4 hrs",
  completion:null,evidence:[],linkedIssue:null,
  log:[{at:stamp(),text:"Created via recurrence builder — due date auto-calculated from recurrence rule; advance notification (3 days before) + due-date reminder scheduled",actor:OM_HEAD}]};
 S.tasks.unshift(t);revealNew("scheduled",t.id);emitEvent("task_assigned","Task assigned — "+t.name,t.plant+" · "+t.assignee,"task",t.id,"task_assigned:"+t.id);S.modal=null;persist();render();
 toast("Task created — assignee notified (in-app + email) with 3-day advance + due-date reminders (2.1.2).");
}
function importCSV(){
 const f=document.getElementById("csv-file")&&document.getElementById("csv-file").files[0];if(!f){toast("Choose an Excel or CSV schedule first.");return}
 readTableFile(f,function(tab){
  if(!tab||!tab.headers||!tab.rows){toast("Could not read the selected schedule.");return}
  const H=tab.headers.map(x=>String(x||"").trim().toLowerCase());const ix=(...names)=>{for(const n of names){const i=H.indexOf(n);if(i>=0)return i}return -1};
  const gi=(row,...names)=>{const i=ix(...names);return i>=0?String(row[i]??"").trim():""};let made=0,invalid=0;
  tab.rows.forEach(row=>{const name=gi(row,"task","name","task_name");if(!name){invalid++;return}
   const freq=gi(row,"frequency","freq")||"Monthly",due=(gi(row,"start_date","due","due_date")||TODAY).slice(0,10);
   const plant=gi(row,"plant","project","site")||(S.plants[0]?S.plants[0].name:"—"),assignee=gi(row,"assignee","owner")||TEAM_POOL[0];
   const equip=gi(row,"equipment_reference","equipment","equip")||"—",type=gi(row,"type","maintenance_type")||TASK_TYPES[0].name;
   const t={id:uid("WO"),plant,name,type,equip,freq,due,assignee,status:"Scheduled",sop:"From uploaded schedule",safety:"—",tools:"—",duration:"4 hrs",completion:null,evidence:[],linkedIssue:null,log:[{at:stamp(),text:"Imported from user-selected Excel/CSV schedule",actor:OM_HEAD}]};
   S.tasks.unshift(t);emitEvent("task_assigned","Task assigned — "+t.name,t.plant+" · "+t.assignee,"task",t.id,"task_assigned:"+t.id);made++;
  });
  S.modal=null;persist();render();toast(made+" task(s) imported"+(invalid?" · "+invalid+" invalid row(s) skipped":"")+".");
 });
}
async function startTask(id){
 try{
  const row=await apiFetch('/api/scheduled/tasks/'+encodeURIComponent(id)+'/start',{method:'POST'});
  const i=(S.tasks||[]).findIndex(x=>x.id===id);if(i>=0)S.tasks[i]=Object.assign({},S.tasks[i],row);
  render();toast('Preventive Maintenance task started.');
 }catch(e){toast(e.message||'Could not start task.');}
}
/* --- Preventive Maintenance in-app photo evidence (REV09: exactly Before + After) --- */
function scheduledEvidenceList(t){
 if(!t)return[];
 if(!Array.isArray(t.evidence))t.evidence=[];
 return t.evidence;
}
function scheduledEvidenceCount(t){return scheduledEvidenceList(t).filter(e=>e.kind==="before"||e.kind==="after").length}
function scheduledEvidenceLabel(kind){return ({before:"Before",after:"After"})[kind]||"Photo"}
function scheduledCanEditEvidence(t){
 const r=(typeof rev05Role==="function"?rev05Role():(S._roleLabel||S.currentRole||"O&M Head"));
 if(r==="O&M Head")return true;
 if(r==="Assignee")return !!t&&t.assignee===S.currentUser;
 if(r==="Site Engineer")return !!t&&(!S._sePlant||t.plant===S._sePlant);
 return false;
}
function scheduledEvidenceThumbs(t,limit){
 const ev=scheduledEvidenceList(t),lim=limit||6,shown=ev.slice(0,lim);
 if(!shown.length)return '<div class="sched-photo-empty">No photo evidence uploaded yet.</div>';
 return '<div class="sched-photo-grid">'+shown.map(function(e){return '<button type="button" class="sched-photo-thumb" title="'+esc(scheduledEvidenceLabel(e.kind))+' · '+esc(e.at||'')+'" onclick="event.stopPropagation();scheduledOpenEvidence(\''+esc(t.id)+'\',\''+esc(e.id)+'\')"><img src="'+e.url+'" alt="'+esc(scheduledEvidenceLabel(e.kind))+'"/><span>'+esc(scheduledEvidenceLabel(e.kind))+'</span></button>'}).join('')+(ev.length>lim?'<div class="sched-photo-more">+'+(ev.length-lim)+' more</div>':'')+'</div>';
}
function scheduledEvidenceUploader(t){
 if(!scheduledCanEditEvidence(t))return '<div class="sched-photo-readonly">Photo evidence is read-only for this role.</div>';
 const ev=scheduledEvidenceList(t),hasBefore=ev.some(e=>e.kind==="before"),hasAfter=ev.some(e=>e.kind==="after");
 return '<div class="sched-photo-actions">'+
  '<label class="btn '+(hasBefore?'o':'p')+' sm sched-photo-upload">📷 '+(hasBefore?'Replace Before':'Upload Before')+'<input type="file" accept="image/*" capture="environment" onchange="scheduledUploadEvidence(this,\''+esc(t.id)+'\',\'before\')"/></label>'+
  '<label class="btn '+(hasAfter?'o':'p')+' sm sched-photo-upload">📷 '+(hasAfter?'Replace After':'Upload After')+'<input type="file" accept="image/*" capture="environment" onchange="scheduledUploadEvidence(this,\''+esc(t.id)+'\',\'after\')"/></label>'+
  '</div>';
}
function scheduledEvidenceSection(t,compact){
 const ev=scheduledEvidenceList(t),before=ev.some(e=>e.kind==="before"),after=ev.some(e=>e.kind==="after"),n=(before?1:0)+(after?1:0);
 return '<div class="sched-photo-card '+(compact?'compact':'')+'"><div class="row between wrap" style="gap:8px"><div><div class="sched-photo-title">📷 Before / After evidence <span class="badge '+(n===2?'b-success':'b-warning')+'">'+n+'/2</span></div><div class="sched-photo-sub">No WhatsApp required · one Before photo and one After photo stay attached to this Preventive Maintenance work order.</div></div><div class="sched-photo-proof">Before '+(before?'✓':'Missing')+' · After '+(after?'✓':'Missing')+'</div></div>'+scheduledEvidenceThumbs(t,2)+scheduledEvidenceUploader(t)+'</div>';
}
function scheduledCompressImage(file){
 return new Promise(function(resolve,reject){
  if(!file||!/^image\//i.test(file.type||'')){reject(new Error('Only image files are supported.'));return}
  if(file.size>15*1024*1024){reject(new Error('Image is larger than 15 MB.'));return}
  const fr=new FileReader();
  fr.onerror=function(){reject(new Error('Could not read '+file.name));};
  fr.onload=function(){
   const img=new Image();
   img.onerror=function(){resolve(fr.result);};
   img.onload=function(){
    try{
     const max=1200,scale=Math.min(1,max/Math.max(img.width||1,img.height||1));
     const w=Math.max(1,Math.round(img.width*scale)),h=Math.max(1,Math.round(img.height*scale));
     const c=document.createElement('canvas');c.width=w;c.height=h;
     const ctx=c.getContext('2d');ctx.drawImage(img,0,0,w,h);
     resolve(c.toDataURL('image/jpeg',0.68));
    }catch(e){resolve(fr.result)}
   };
   img.src=fr.result;
  };
  fr.readAsDataURL(file);
 });
}
/* Downscale phone photos before upload to save mobile bandwidth and Supabase Storage. */
async function compressEvidenceImage(file){
 const LIMIT=3.5*1024*1024;
 if(!file||!file.type.startsWith("image/"))return file;
 if(file.size<=LIMIT&&file.type==="image/jpeg")return file;
 try{
  const bmp=await createImageBitmap(file);
  let scale=Math.min(1,1920/Math.max(bmp.width,bmp.height));
  for(let attempt=0;attempt<5;attempt++){
   const c=document.createElement("canvas");
   c.width=Math.max(1,Math.round(bmp.width*scale));c.height=Math.max(1,Math.round(bmp.height*scale));
   c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
   for(const q of [0.82,0.7,0.6]){
    const blob=await new Promise(r=>c.toBlob(r,"image/jpeg",q));
    if(blob&&blob.size<=LIMIT)return new File([blob],(file.name||"photo").replace(/\.[^.]+$/,"")+".jpg",{type:"image/jpeg"});
   }
   scale*=0.75;
  }
 }catch(e){}
 return file;
}
async function scheduledUploadEvidence(input,taskId,kind){
 const t=(S.tasks||[]).find(x=>x.id===taskId);if(!t||!input)return;
 if(!scheduledCanEditEvidence(t)){toast('You do not have permission to add evidence to this task.');input.value='';return}
 if(kind!=="before"&&kind!=="after"){input.value='';return}
 const file=(input.files||[])[0];if(!file)return;
 const caption=prompt('Optional note for the '+scheduledEvidenceLabel(kind).toLowerCase()+' photo:','')||'';
 try{
  const upFile=await compressEvidenceImage(file);
  if(upFile.size>4*1024*1024){input.value='';toast('Photo is too large (max 4 MB). Please retake at a lower resolution.');return}
  const fd=new FormData();fd.append('file',upFile);fd.append('note',caption);
  const saved=await apiFetch('/api/scheduled/tasks/'+encodeURIComponent(taskId)+'/evidence/'+kind,{method:'POST',body:fd});
  t.evidence=scheduledEvidenceList(t).filter(e=>e.kind!==kind);
  t.evidence.push(saved);
  input.value='';render();toast(scheduledEvidenceLabel(kind)+' photo saved securely.');
 }catch(e){input.value='';toast(e&&e.message?e.message:'Could not upload photo evidence.');}
}
async function scheduledRemoveEvidence(taskId,evId){
 const t=(S.tasks||[]).find(x=>x.id===taskId);if(!t||!scheduledCanEditEvidence(t))return;
 const ev=scheduledEvidenceList(t).find(e=>e.id===evId);if(!ev)return;
 if(!confirm('Remove this '+scheduledEvidenceLabel(ev.kind)+' photo evidence from the scheduled work order?'))return;
 try{
  await apiFetch('/api/scheduled/tasks/'+encodeURIComponent(taskId)+'/evidence/'+encodeURIComponent(ev.kind),{method:'DELETE'});
  t.evidence=scheduledEvidenceList(t).filter(e=>e.id!==evId);render();toast('Photo removed.');
 }catch(e){toast(e.message||'Could not remove photo.');}
}
function scheduledOpenEvidence(taskId,evId){
 const t=(S.tasks||[]).find(x=>x.id===taskId);if(!t)return;
 const ev=scheduledEvidenceList(t),e=ev.find(x=>x.id===evId);if(!e)return;
 const idx=ev.indexOf(e),prev=idx>0?ev[idx-1]:null,next=idx<ev.length-1?ev[idx+1]:null,can=scheduledCanEditEvidence(t);
 let box=document.getElementById('sched-photo-lightbox');if(!box){box=document.createElement('div');box.id='sched-photo-lightbox';box.className='cc-lbox';document.body.appendChild(box)}
 box.onclick=function(x){if(x.target===box)box.remove()};
 box.innerHTML='<div class="cc-lbox-inner"><button class="cc-lbox-close" onclick="document.getElementById(\'sched-photo-lightbox\').remove()">×</button><img src="'+e.url+'"/><div class="cc-lbox-meta"><div><b>'+esc(t.id)+'</b> · '+esc(t.plant)+' · '+esc(t.name)+'</div><div style="margin-top:6px"><b>'+esc(scheduledEvidenceLabel(e.kind))+'</b> · '+esc(e.at||'')+' · '+esc(e.by||'')+'</div>'+(e.note?'<div style="margin-top:4px"><b>Note:</b> '+esc(e.note)+'</div>':'')+'<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">'+(prev?'<button class="btn o sm" onclick="document.getElementById(\'sched-photo-lightbox\').remove();scheduledOpenEvidence(\''+esc(t.id)+'\',\''+esc(prev.id)+'\')">← Previous</button>':'')+(next?'<button class="btn o sm" onclick="document.getElementById(\'sched-photo-lightbox\').remove();scheduledOpenEvidence(\''+esc(t.id)+'\',\''+esc(next.id)+'\')">Next →</button>':'')+(can?'<button class="btn d sm" style="margin-left:auto" onclick="document.getElementById(\'sched-photo-lightbox\').remove();scheduledRemoveEvidence(\''+esc(t.id)+'\',\''+esc(e.id)+'\')">Remove photo</button>':'')+'<span style="font-size:11px;color:#9ca3af">Photo '+(idx+1)+' of '+ev.length+'</span></div></div></div>';
}
function scheduledBackfillLegacyEvidence(){ /* production evidence is loaded from Supabase Storage metadata */ }

async function completeTask(){
 const{id}=S.modalCtx;const t=S.tasks.find(x=>x.id===id);if(!t)return;
 const subs=[...document.querySelectorAll("input[name='ct-sub']:checked")].map(c=>c.value);
 const readings=document.getElementById("ct-readings").value.trim();
 const evidence=scheduledEvidenceList(t),hasBefore=evidence.some(e=>e.kind==="before"),hasAfter=evidence.some(e=>e.kind==="after");
 if(!hasBefore||!hasAfter){toast("Upload both the Before and After photos before completing Preventive Maintenance work.");return}
 const remarks=document.getElementById("ct-rem").value.trim();
 const anomaly=document.getElementById("ct-anom").checked;
 const date=document.getElementById("ct-date").value||TODAY;
 try{
  const result=await apiFetch('/api/scheduled/tasks/'+encodeURIComponent(id)+'/complete',{method:'POST',body:{completed_on:date,readings:readings||null,remarks:remarks||null,anomaly:!!anomaly,checklist:subs}});
  S.modal=null;
  const boot=await apiFetch('/api/bootstrap');
  const ui={view:S.view,omTab:S.omTab,extSub:S.extSub,hoOpen:S.hoOpen,plantId:S.plantId,washPlant:S.washPlant,schedScope:S.schedScope,issF:S.issF,schedF:S.schedF,washF:S.washF};
  Object.assign(S,boot.state||{},ui);S._serverRevision=boot.revision||S._serverRevision;S._collectionRevisions=boot.collection_revisions||S._collectionRevisions||{};
  setLastServerState(stateSnapshot());render();
  toast(result.linked_issue?'Completed — Site Issue '+result.linked_issue+' created and linked.':'Completed — next recurrence generated server-side.');
 }catch(e){toast(e.message||'Could not complete task.');}
}
function reassignTask(){
 const{id}=S.modalCtx;const name=document.getElementById("rt-name").value;
 S.tasks=S.tasks.map(t=>t.id===id?{...t,assignee:name,log:[{at:stamp(),text:"Reassigned / delegated to "+name+" (original assignee unavailable) — change logged",actor:OM_HEAD},...t.log]}:t);
 emitEvent("task_assigned","Task assigned — "+S.tasks.find(x=>x.id===id).name,S.tasks.find(x=>x.id===id).plant+" · "+name,"task",id,"task_reassigned:"+id+":"+name+":"+TODAY);
 S.modal=null;persist();render();toast("Task reassigned — change logged (2.1.2).");
}
async function convertToIssue(id){
 const t=S.tasks.find(x=>x.id===id);if(!t||!t.completion)return;
 const plant=S.plants.find(x=>x.name===t.plant),plantId=plant&&(plant.dbId||plant.id);
 if(!plantId){toast("A valid plant is required to create a Site Issue from this task.");return}
 let issue;
 try{
  issue=await apiFetch("/api/issues",{method:"POST",body:{
   plant_id:plantId,equipment_id:t.equipmentId||null,equipment_ref:t.equip||null,
   vertical:TVERT[t.type]||"Other",description:'From PM task "'+t.name+'": '+((t.completion||{}).remarks||"Problem found during maintenance"),
   severity:"Critical",occurred_at:stampISO(),etc_at:addHoursISO(stampISO(),etcHrs("Critical")),photo_count:0
  }});
 }catch(e){toast(e.message||"Could not create a Site Issue from this task.");return}
 const uiIssue=window.applyIssueRow?window.applyIssueRow(issue):null;
 try{
  const updated=await apiFetch("/api/scheduled/tasks/"+encodeURIComponent(id)+"/link-issue",{method:"POST",body:{ticket_no:issue.ticket_no}});
  const index=S.tasks.findIndex(x=>x.id===id);if(index>=0)S.tasks[index]=Object.assign({},S.tasks[index],updated);
 }catch(e){
  if(uiIssue)revealNew("issues",uiIssue.id);
  render();toast("Site Issue "+issue.ticket_no+" was created, but the PM task could not be linked: "+e.message);return;
 }
 if(uiIssue)revealNew("issues",uiIssue.id);
 render();toast("Issue ticket "+issue.ticket_no+" created and linked to the PM task.");
}
/* --- 2.2 actions --- */
function washTable(id){
 const t=S.washing.find(x=>x.id===id);
 if(!t){toast("This washing table is no longer in the register.");return}
 if(washedToday(t)){toast("Already logged as washed today.");return}
 S.modal="washLog";S.modalCtx={id};render();
}
function saveWashTableLog(){
 const{id}=S.modalCtx||{},t=S.washing.find(x=>x.id===id);
 if(!t){toast("This washing table is no longer in the register.");return}
 if(washedToday(t)){toast("Already logged as washed today.");S.modal=null;render();return}
 const crew=(S.washMeta[t.plant]||{}).team||[],team=crew.length?crew:["—"];
 const by=(document.getElementById("wl-by")||{}).value;
 if(!by||team.indexOf(by)<0){toast("Choose who completed this wash.");return}
 const freq=((S.washMeta||{})[t.plant]||{freq:14}).freq||14;
 S.washing=S.washing.map(x=>x.id===id?{...x,history:[...x.history,{type:"wash",date:TODAY,by}],rescheduledTo:null,nextDue:addDays(TODAY,freq)}:x);
 audit("Washing","Wash logged — "+t.tableId+" ("+t.plant+")",by,"pending","washed");
 S.modal=null;persist();render();toast("Wash logged — "+t.tableId+" · compliance updated (2.2.2).");
}
function bulkWash(){
 const inv=parseInt(document.getElementById("bw-inv").value);
 const by=document.getElementById("bw-by").value;
 let n=0;
 const freq=((S.washMeta||{})[S.washPlant]||{freq:14}).freq||14;
 S.washing=S.washing.map(t=>{if(t.plant===S.washPlant&&(t.inv===inv||t.invSecondary===inv)&&!washedToday(t)){n++;return{...t,history:[...t.history,{type:"wash",date:TODAY,by}],rescheduledTo:null,nextDue:addDays(TODAY,freq)}}return t});
 audit("Washing","Bulk entry — Inverter "+inv+": "+n+" table(s) washed today",by,"pending","washed");
 S.modal=null;persist();render();
 toast("Bulk entry — INV-"+pad2(inv)+": "+n+" table(s) logged washed by "+by+"; per-table records stored (2.2.2).");
}
function logException(){
 const{id}=S.modalCtx;const t=S.washing.find(x=>x.id===id);
 const reason=document.getElementById("ex-reason").value;
 const notes=document.getElementById("ex-notes").value.trim();
 const rain=reason==="Rain";
 const crew=(S.washMeta[t.plant]||{}).team||[],team=crew.length?crew:["—"];
 const by=(document.getElementById("ex-by")||{}).value;
 if(!by||team.indexOf(by)<0){toast("Choose who logged this exception.");return}
 const rescheduledTo=rain?addDays(TODAY,2):null;
 S.washing=S.washing.map(x=>x.id===id?{...x,history:[...x.history,{type:"exception",date:TODAY,by,reason,notes,rescheduledTo}],rescheduledTo:rescheduledTo||x.rescheduledTo,nextDue:rescheduledTo||x.nextDue}:x);
 audit("Washing","Exception — "+reason+" on "+t.tableId+(rain?" (auto-rescheduled "+fmtD(rescheduledTo)+")":""),by,"Pending",rain?"Pending — Rescheduled":"Exception");
 S.modal=null;persist();render();
 toast(rain?'Rain exception — flagged "Pending — Rescheduled"; system suggests next available date (2.2.3).':"Exception logged ("+reason+") — recorded distinctly from missed/pending, visible for transparency.");
}
function saveWashFreq(){
 if(!scheduledAdmin()){toast("Only O&M Head can change the washing schedule.");return}
 const f=Math.max(1,parseInt(document.getElementById("wf-days").value)||12);
 S.washMeta[S.washPlant]={...(S.washMeta[S.washPlant]||{team:WASH_TEAM[S.washPlant]||["—"]}),freq:f};
 S.washing=S.washing.map(t=>t.plant===S.washPlant?{...t,nextDue:lastWash(t)?addDays(lastWash(t),f):(t.nextDue||null)}:t);
 S.modal=null;persist();render();toast("Washing frequency updated — every "+f+" days (pre-planned schedule, 2.2.1).");
}
function importWashSchedule(){
 if(!scheduledAdmin()){toast("Only O&M Head can import washing schedules.");return}
 const f=document.getElementById("wash-schedule-file")&&document.getElementById("wash-schedule-file").files[0];if(!f){toast("Choose an Excel or CSV washing schedule first.");return}
 readTableFile(f,function(tab){
  if(!tab||!tab.headers||!tab.rows){toast("Could not read the selected washing schedule.");return}
  const H=tab.headers.map(x=>String(x||"").trim().toLowerCase());const ix=(...names)=>{for(const n of names){const i=H.indexOf(n);if(i>=0)return i}return -1};
  const gi=(row,...names)=>{const i=ix(...names);return i>=0?String(row[i]??"").trim():""};let made=0,updated=0,invalid=0;
  tab.rows.forEach(row=>{
   const plantRaw=gi(row,"plant","project","site","site_code")||S.washPlant;const p=(S.plants||[]).find(x=>x.name===plantRaw||x.id===plantRaw);if(!p){invalid++;return}
   const tableId=gi(row,"table_id","table","table_code");const inv=parseInt(gi(row,"inverter","inv","primary_inverter").replace(/[^0-9]/g,""))||null;if(!tableId||!inv){invalid++;return}
   const sec=parseInt(gi(row,"secondary_inverter","secondary_inv","split_inverter").replace(/[^0-9]/g,""))||null;const nextDue=(gi(row,"next_due","due","scheduled_date")||"").slice(0,10)||null;
   const freq=Math.max(1,parseInt(gi(row,"frequency_days","wash_frequency_days","frequency"))||((S.washMeta[p.name]||{}).freq||14));const crew=gi(row,"crew","team","assignee");
   const cur=(S.washing||[]).find(x=>x.plant===p.name&&x.tableId===tableId);const patch={plant:p.name,inv,invSecondary:sec,tableId,nextDue,rescheduledTo:cur?cur.rescheduledTo:null,history:cur?cur.history:[]};
   if(cur){S.washing=S.washing.map(x=>x.id===cur.id?{...x,...patch}:x);updated++}else{S.washing.push({id:uid("TBL"),...patch});made++}
   const meta=S.washMeta[p.name]||{team:[],freq};const team=crew?crew.split(/[;,]/).map(x=>x.trim()).filter(Boolean):meta.team;S.washMeta[p.name]={team:team&&team.length?team:["—"],freq};
  });
  S.modal=null;persist();render();toast("Washing schedule imported — "+made+" created · "+updated+" updated"+(invalid?" · "+invalid+" invalid row(s) skipped":"")+".");
 });
}
/* --- 2.3 actions --- */
function updSub(){const v=document.getElementById("tk-vert").value;
 document.getElementById("tk-sub").innerHTML=["(none)"].concat(SUBCATS[v]||[]).map(s=>"<option>"+s+"</option>").join("")}
function updEtc(){const el=document.getElementById("tk-etc"),sev=document.getElementById("tk-sev");if(el&&sev)el.value=addHoursISO(stampISO(),etcHrs(sev.value))}

function issueAssigneeOptions(){
 const category=(document.getElementById("tk-vert")||{}).value||VERTICALS[0]||"";
 const eligible=ISSUE_ASSIGNEES.filter(a=>(a.equipment_types||[]).some(t=>String(t).trim().toLowerCase()===category.trim().toLowerCase()));
 return '<option value="">Leave unassigned</option>'+eligible.map(a=>'<option value="'+esc(a.id)+'">'+esc(a.name)+'</option>').join("")+
  (eligible.length?"":'<option disabled value="">No Assignees are scoped to this issue category</option>');
}
function updIssueAssignees(){
 const sel=document.getElementById("tk-assignee");if(!sel)return;
 const previous=sel.value;sel.innerHTML=issueAssigneeOptions();
 if(previous&&(ISSUE_ASSIGNEES.some(a=>a.id===previous&&(a.equipment_types||[]).some(t=>String(t).trim().toLowerCase()===(document.getElementById("tk-vert").value||"").trim().toLowerCase()))))sel.value=previous;
}
function showIssuePhotoSelection(input){
 const files=Array.from(input.files||[]),label=document.getElementById("tk-photo-count");
 if(files.length>10){input.value="";if(label)label.textContent="No photos selected";toast("Choose no more than 10 evidence photos.");return}
 if(label)label.textContent=files.length?files.length+" photo"+(files.length===1?"":"s")+" selected":"No photos selected";
}
async function uploadIssuePhotos(ticket,input){
 const selected=Array.from(input&&input.files||[]);if(!selected.length)return[];
 if(selected.length>10){throw new Error("An issue can have no more than 10 evidence photos.")}
 const fd=new FormData();
 for(const file of selected)fd.append("files",await compressEvidenceImage(file),file.name);
 return await apiFetch("/api/issues/"+encodeURIComponent(ticket.dbId)+"/evidence",{method:"POST",body:fd});
}
async function uploadMoreIssuePhotos(ticketId,input){
 const t=S.issues.find(x=>x.id===ticketId);if(!t||!input)return;
 const selected=Array.from(input.files||[]);if(!selected.length)return;
 try{
  if((t.photos||0)+selected.length>10)throw new Error("An issue can have no more than 10 evidence photos.");
  const saved=await uploadIssuePhotos(t,input);
  t.evidence=(t.evidence||[]).concat(saved);t.photos=t.evidence.length;
  input.value="";render();toast("Evidence photos uploaded securely.");
 }catch(e){input.value="";toast("Could not upload issue evidence. "+e.message)}
}
async function openIssueEvidence(ticketId,evidenceId){
 const t=S.issues.find(x=>x.id===ticketId),entry=(t&&t.evidence||[]).find(x=>x.id===evidenceId);
 if(!t||!entry)return;
 try{
  const url=entry.url&&entry.url.startsWith("/api/")?entry.url:"/api/issues/"+encodeURIComponent(t.dbId)+"/evidence/"+encodeURIComponent(evidenceId),response=await authenticatedFetch(url);
  if(!response.ok)throw new Error("Could not load this evidence photo (HTTP "+response.status+").");
  const objUrl=URL.createObjectURL(await response.blob()),lightbox=document.createElement("div");
  lightbox.className="cc-lbox";lightbox.innerHTML='<div class="cc-lbox-inner"><button class="cc-lbox-close" aria-label="Close">×</button><img alt="'+esc(entry.name||"Issue evidence")+'" src="'+objUrl+'"/><div class="cc-lbox-meta">'+esc(t.id)+' · '+esc(entry.name||"Evidence photo")+' · '+esc(entry.by||"")+'</div></div>';
  lightbox.onclick=e=>{if(e.target===lightbox||e.target.classList.contains("cc-lbox-close")){URL.revokeObjectURL(objUrl);lightbox.remove()}};
  document.body.appendChild(lightbox);
 }catch(e){toast(e.message||"Could not load issue evidence.")}
}

function createTicket(){
 const plantSel=document.getElementById("tk-plant");
 const plant=(plantSel&&plantSel.value||"").trim();
 if(!plant||/^all plants$/i.test(plant)||plant==="all"){
  toast("Please select a plant for this ticket.");
  wizardGo("ticket",1);
  return;
 }
 const desc=document.getElementById("tk-desc").value.trim();
 if(!desc){toast("Issue details are required.");wizardGo("ticket",3);return}
 const tk={id:newTicketId(),plant:plant,
  vertical:document.getElementById("tk-vert").value,
  sub:(document.getElementById("tk-sub").value||"").replace("(none)","")||null,
  equip:pickedEquip("tk"),
  desc:desc,
  severity:document.getElementById("tk-sev").value,created:stampISO(),etc:(function(){const v=document.getElementById("tk-etc").value;const d=new Date(v);return v&&!isNaN(d.getTime())?v:addHoursISO(stampISO(),etcHrs(document.getElementById("tk-sev").value))})(),
  photos:parseInt(document.getElementById("tk-photos").value)||0,
  impact:document.getElementById("tk-impact").value.trim()||null,
  maker:(document.getElementById("tk-maker")&&document.getElementById("tk-maker").value.trim())||"",
  occurred:(document.getElementById("tk-occurred")&&document.getElementById("tk-occurred").value)?document.getElementById("tk-occurred").value+"T09:00":stampISO(),
  assignee:null,vendor:null,status:"Open",progress:[],closure:null,sourceTask:null,reopenedFrom:null,reopenCount:0,updated:stampISO()};
 S.issues.unshift(tk);revealNew("issues",tk.id);
 emitEvent("unassigned_ticket","Unassigned issue — "+tk.id,tk.plant+" · "+tk.severity,"issue",tk.id,"unassigned:"+tk.id);
 if(tk.severity==="Critical")emitEvent("critical_ticket","Critical ticket raised — "+tk.id,tk.plant+" · "+tk.vertical,"issue",tk.id,"critical:"+tk.id);
 audit("Issues","Ticket "+tk.id+" created — "+tk.vertical+" · "+tk.severity,"System","—","Open");
 S.modal=null;persist();render();
 toast("Ticket "+tk.id+" created & timestamped."+(tk.severity==="Critical"?" Critical severity — immediate call/SMS alert issued (R1).":""));
}

function assignTicket(){
 const{id}=S.modalCtx;const t=S.issues.find(x=>x.id===id);
 const who=document.getElementById("at-who").value;
 let patch;
 if(who==="__vendor"){
  const owner=document.getElementById("at-owner").value;
  const vname=document.getElementById("at-vn").value.trim()||"Vendor";
  const vcontact=document.getElementById("at-vc").value.trim()||"—";
  const vresp=document.getElementById("at-vr").value.trim()||"—";
  patch={assignee:owner,vendor:{name:vname,contact:vcontact,expected:vresp},status:"Assigned",updated:stampISO(),
   progress:[{at:stampISO(),note:"Tagged Vendor-Dependent — "+vname+" ("+vcontact+"); expected vendor response: "+vresp+". Vendor response time tracked separately (2.3.2).",parts:"—",hrs:0},...t.progress]};
 }else{
  patch={assignee:who,status:"Assigned",updated:stampISO(),
   progress:[{at:stampISO(),note:"Assigned to "+who+(t.severity==="Critical"?" — immediate call/SMS alert issued in addition to app notification.":" — notified (push/SMS/email per severity)."),parts:"—",hrs:0},...t.progress]};
 }
 S.issues=S.issues.map(x=>x.id===id?{...x,...patch}:x);
 audit("Issues","Ticket "+id+" assigned → "+patch.assignee,OM_HEAD,t.status,"Assigned");
 emitEvent("ticket_assigned","Ticket assigned — "+id,(t.plant||"")+" · "+patch.assignee,"issue",id,"assigned:"+id+":"+patch.assignee);
 S.modal=null;persist();render();toast("Ticket assigned & assignee notified (2.3.2).");
}
function ackTicket(id){S.issues=S.issues.map(t=>t.id===id?{...t,status:"Acknowledged",updated:stampISO(),progress:[{at:stampISO(),note:"Acknowledged by assignee.",parts:"—",hrs:0},...t.progress]}:t);audit("Issues",id+" → Acknowledged","","Assigned","Acknowledged");persist();render()}
function startTicket(id){S.issues=S.issues.map(t=>t.id===id?{...t,status:"In Progress",progress:[{at:stampISO(),note:"Work started.",parts:"—",hrs:0},...t.progress]}:t);audit("Issues",id+" → In Progress",t(id).assignee||"","Acknowledged","In Progress");persist();render();
 function t(id){return S.issues.find(x=>x.id===id)}}
function pendingTicket(id){S.issues=S.issues.map(t=>t.id===id?{...t,status:"Pending Vendor",progress:[{at:stampISO(),note:"Blocked — awaiting spare parts / vendor.",parts:"—",hrs:0},...t.progress]}:t);persist();render()}
function resumeTicket(id){S.issues=S.issues.map(t=>t.id===id?{...t,status:"In Progress",progress:[{at:stampISO(),note:"Resumed — parts/vendor received.",parts:"—",hrs:0},...t.progress]}:t);persist();render()}
function addProgress(){
 const{id}=S.modalCtx;
 const note=document.getElementById("pg-note").value.trim()||"Progress update.";
 const partId=document.getElementById("pg-part").value;
 const qty=Math.max(1,parseInt(document.getElementById("pg-qty").value)||1);
 const hrs=parseFloat(document.getElementById("pg-hrs").value)||0;
 const hit=S.inventory.find(x=>x.id===partId);
 const parts=hit?hit.item+" x"+qty:"—";
 const ref=(S.issues.find(t=>t.id===id)||{}).id;
 let msg="Progress note added — time spent logged.";
 if(hit){if(hit.qty<qty){toast('Stock short for "'+hit.item+'" — available '+hit.qty+' '+hit.unit+'.');return}S.inventory=S.inventory.map(x=>x.id===hit.id?{...x,qty:x.qty-qty}:x);S.movements.unshift({id:uid("MV"),at:stamp(),item:hit.item,qty:-qty,ref,by:OM_HEAD,note:"Auto-deducted — selected spare used against issue ticket"});audit("Spares","Auto-deduct: "+hit.item+" ×"+qty+" against "+ref,OM_HEAD,hit.qty+" "+hit.unit,(hit.qty-qty)+" "+hit.unit);msg+=" Inventory auto-deducted (→ 3.2)."}
 S.issues=S.issues.map(t=>t.id===id?{...t,status:["Open","Acknowledged"].includes(t.status)?"In Progress":t.status,progress:[{at:stampISO(),note,parts,hrs},...t.progress]}:t);
 S.modal=null;persist();render();toast(msg);
}
function resolveTicket(){
 const{id}=S.modalCtx;const t=S.issues.find(x=>x.id===id);
 const spent=t.progress.reduce((s,p)=>s+(p.hrs||0),0)+(parseFloat(document.getElementById("rs-hrs").value)||0);
 const closure={rootCause:document.getElementById("rs-root").value.trim()||"—",corrective:document.getElementById("rs-act").value.trim()||"—",
  photos:parseInt(document.getElementById("rs-photos").value)||0,closedAt:stampISO(),hrs:spent,resolutionHrs:Math.round(hrsBetween(t.created,stampISO()))};
 S.issues=S.issues.map(x=>x.id===id?{...x,status:"Resolved",closure,progress:[{at:stampISO(),note:"Resolved — root cause: "+closure.rootCause+" Corrective action: "+closure.corrective+" ("+closure.photos+" photo(s) of fix). Actual time-to-close "+closure.resolutionHrs+" hrs.",parts:"—",hrs:0},...x.progress]}:x);
 audit("Issues",id+" resolved — awaiting secondary review",t.assignee,"In Progress","Resolved");
 S.modal=null;persist();render();toast("Resolution submitted — secondary reviewer (O&M Head / shift supervisor) must verify & formally close.");
}
function verifyTicket(){
 const{id}=S.modalCtx;const t=S.issues.find(x=>x.id===id);
 const remarks=document.getElementById("vf-rem").value.trim();
 const met=t.closure&&new Date(t.closure.closedAt)<=new Date(t.etc);
 S.issues=S.issues.map(x=>x.id===id?{...x,status:"Closed",closure:{...x.closure,verifiedBy:OM_HEAD},
  progress:[{at:stampISO(),note:"Verified & formally closed by secondary reviewer ("+OM_HEAD+")"+(remarks?' — "'+remarks+'"':"")+". ETC "+(met?"met":"missed")+" (actual "+x.closure.resolutionHrs+" hrs).",parts:"—",hrs:0},...x.progress]}:x);
 audit("Issues",id+" closed (verified) — ETC "+(met?"met":"missed"),OM_HEAD,"Resolved","Closed");
 emitEvent("ticket_completed","Ticket completed — "+id,t.plant+" · "+t.vertical,"issue",id,"ticket_completed:"+id);
 S.modal=null;persist();render();toast("Ticket closed (verified) — ETC "+(met?"met ✓":"missed ✗")+" (2.3.3).");
}
function reopenTicket(){
 const{id}=S.modalCtx;
 const reason=document.getElementById("ro-reason").value.trim()||"Issue recurred — reopened.";
 S.issues=S.issues.map(t=>t.id===id?{...t,status:"Open",reopenCount:(t.reopenCount||0)+1,progress:[{at:stampISO(),note:"Reopened by "+OM_HEAD+": "+reason,parts:"—",hrs:0},...t.progress]}:t);
 audit("Issues",id+" reopened — "+reason,OM_HEAD,"Closed","Open");
 S.modal=null;persist();render();toast("Ticket reopened — recurrence feeds chronic-problem detection (2.3.4).");
}
/* --- 3.x actions --- */
function approveESR(id){S.serviceRequests=S.serviceRequests.map(r=>r.id===id?{...r,status:"In Progress",approved:r.estimate,history:[stamp()+" · Approved by O&M Head",...r.history]}:r);
 audit("Extra services","Request approved — "+id,OM_HEAD,"Approval Pending","In Progress");persist();render();toast("Request approved — budget sanctioned, vendor PO issued.")}
function changeESR(id){S.serviceRequests=S.serviceRequests.map(r=>r.id===id?{...r,status:"Changes Requested",history:[stamp()+" · Changes requested by O&M Head",...r.history]}:r);
 audit("Extra services","Changes requested — "+id,OM_HEAD,"Approval Pending","Changes Requested");persist();render();toast("Changes requested — sent back to requester.")}
function bumpESR(id){S.serviceRequests=S.serviceRequests.map(r=>r.id===id?{...r,progress:Math.min(100,r.progress+25),history:[stamp()+" · Progress updated to "+Math.min(100,r.progress+25)+"%",...r.history]}:r);persist();render()}
function verifyESR(id){S.serviceRequests=S.serviceRequests.map(r=>r.id===id?{...r,status:"Completed",progress:100,history:[stamp()+" · Verified and closed by "+OM_HEAD,...r.history]}:r);
 audit("Extra services","Completion verified — "+id,OM_HEAD,"In Progress","Completed");persist();render();toast("Completion verified — closed with evidence on record.")}
function reorder(id){const s=S.inventory.find(x=>x.id===id);
 S.inventory=S.inventory.map(x=>x.id===id?{...x,qty:x.reorderTo,onOrder:false}:x);
 S.movements.unshift({id:uid("MV"),at:stamp(),item:s.item,qty:s.reorderTo-s.qty,ref:"PO received",by:OM_HEAD,note:"Reorder fulfilled to stock level"});
 audit("Spares","Reorder received — "+s.item+" topped to "+s.reorderTo+" "+s.unit,OM_HEAD,s.qty+" "+s.unit,s.reorderTo+" "+s.unit);
 persist();render();toast(s.item+" — stock topped to "+s.reorderTo+" "+s.unit+".")}
function approvePTW(id,ok){S.ptw=S.ptw.map(p=>p.id===id?{...p,status:ok?"Approved":"Rejected"}:p);
 const p=S.ptw.find(x=>x.id===id);
 audit("Safety","PTW "+p.id+(ok?" approved (digital sign-off)":" rejected")+" — "+p.task,OM_HEAD,"Pending Approval",ok?"Approved":"Rejected");
 persist();render();toast(ok?"PTW approved — digital sign-off recorded; LOTO verified (3.5).":"PTW rejected.")}
function closePTW(id){S.ptw=S.ptw.map(p=>p.id===id?{...p,status:"Closed",closedAt:stampISO()}:p);
 audit("Safety","PTW closed — work complete, LOTO removed",OM_HEAD,"Approved","Closed");persist();render();toast("Permit closed.")}
function reportIncident(){
 const desc=document.getElementById("in-desc").value.trim();if(!desc){toast("Description is required.");return}
 const inc={id:uid("INC"),plant:document.getElementById("in-plant").value,type:document.getElementById("in-type").value,
  desc:desc,by:OM_HEAD,at:stamp(),severity:document.getElementById("in-sev").value,action:"—"};
 S.incidents.unshift(inc);revealNew("inc",inc.id);
 audit("Safety",inc.type+" reported — "+inc.desc.slice(0,50),OM_HEAD,"—","Logged");
 S.modal=null;persist();render();toast("Safety report logged — kept separate from equipment Issues (3.5).");
}
function createInventory(){const item=document.getElementById("ni-item").value.trim();if(!item){toast("Item name is required.");return}const x={id:uid("INV"),item,cat:document.getElementById("ni-cat").value.trim()||"Other",plant:document.getElementById("ni-plant").value,store:document.getElementById("ni-store").value.trim()||"Main store",qty:Number(document.getElementById("ni-qty").value)||0,min:Number(document.getElementById("ni-min").value)||0,unit:document.getElementById("ni-unit").value.trim()||"pcs",reorderTo:Math.max(Number(document.getElementById("ni-min").value)||0,Number(document.getElementById("ni-qty").value)||0),onOrder:false};S.inventory.unshift(x);audit("Spares","Stock item added — "+item,OM_HEAD,"—",x.qty+" "+x.unit);S.modal=null;persist();render();toast("Inventory item added.")}
function createVendor(){const name=document.getElementById("nv-name").value.trim();if(!name){toast("Vendor name is required.");return}S.vendors.unshift({id:uid("VEN"),name,type:document.getElementById("nv-type").value,scope:document.getElementById("nv-scope").value.trim()||"—",sla:document.getElementById("nv-sla").value.trim()||"—",contractEnd:document.getElementById("nv-end").value||null});audit("Vendors","Vendor added — "+name,OM_HEAD,"—","Active");S.modal=null;persist();render();toast("Vendor added. Performance will derive from vendor-linked tickets.")}
function createDocument(){const name=document.getElementById("nd-name").value.trim();if(!name){toast("Document name is required.");return}const f=document.getElementById("nd-file").files[0];S.docs.unshift({id:uid("DOC"),name,type:document.getElementById("nd-type").value.trim()||"Other",plant:document.getElementById("nd-plant").value,owner:document.getElementById("nd-owner").value.trim()||OM_HEAD,expires:document.getElementById("nd-exp").value||null,fileName:f?f.name:null});audit("Documents","Document added — "+name,OM_HEAD,"—","Available");S.modal=null;persist();render();toast("Document record added"+(f?" — "+f.name:".")+" Expiry reminders now use this record.")}
function createSLA(){const c={id:uid("SLA"),name:document.getElementById("ns-name").value.trim()||"O&M SLA",project:document.getElementById("ns-plant").value,critical:Number(document.getElementById("ns-c").value)||24,medium:Number(document.getElementById("ns-m").value)||120,low:Number(document.getElementById("ns-l").value)||240,washDays:Number(document.getElementById("ns-w").value)||0};S.sla.unshift(c);audit("SLA","Contract configured — "+c.name,OM_HEAD,"—",c.project);S.modal=null;persist();render();toast("SLA contract saved — live status is derived from actual records.")}
function renewDoc(id){const d=S.docs.find(x=>x.id===id);
 S.docs=S.docs.map(x=>x.id===id?{...x,expires:addDays(x.expires||TODAY,365)}:x);
 audit("Documents",d.name+" renewed — new expiry +1 yr",OM_HEAD,"expiring","+1 yr");
 persist();render();toast(d.name+" — renewal recorded; reminder chain reset (3.6).")}
function toggleRule(id){S.rules=S.rules.map(r=>r.id===id?{...r,on:!r.on}:r);persist();render()}
function syncQueue(){S.offlineQueue=S.offlineQueue.map(q=>({...q,status:"Synced"}));persist();render();toast("Field sync complete — queued records pushed, conflicts none (3.11).")}

(function(){ /* inject the new styles automatically */
 const st=document.createElement("style");
 st.textContent=
  ".kpi-active{border-color:var(--primary)!important;background:linear-gradient(180deg,#F2FBF5,#fff);box-shadow:0 0 0 3px rgba(22,163,74,.12),var(--shadow-panel)}"+
  ".viz-kpi{transition:border-color .15s,box-shadow .15s,background .15s}"+
  ".viz-donut path{transition:opacity .25s}"+
  ".viz-donut svg.has-sel path:not(.sel){opacity:.3}"+
  ".viz-leg{border-radius:7px;padding:3px 7px;margin:0 -7px;transition:background .12s}"+
  ".viz-leg:hover{background:var(--surface-subtle)}"+
  ".viz-leg.on{background:var(--secondary)}"+
  ".viz-leg.on b{color:var(--secondary-foreground)}"+
  ".viz-leg .pct{font-size:10.5px;color:var(--muted-foreground);margin-left:4px}"+
  ".viz-ring-wrap svg{animation:ccFade .45s ease}"+
  "@keyframes ccFade{from{opacity:0}}"+
  ".ccbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}"+
  ".ccbar .gf-chip{background:var(--secondary);color:var(--secondary-foreground);border:1px solid #BFE5CC}"+
  ".ccbar .gf-chip:hover{border-color:var(--primary)}"+
  ".ccsep{width:1px;height:20px;background:var(--border);margin:0 3px;flex-shrink:0}";
 document.head.appendChild(st);
})();

/* CSV export rows for the report pack — array-of-arrays, one row per line.
   Distinct from reportRowsForHub() which returns {title, cols, rows} for
   the Reports hub UI. */
function reportRowsExport(kind){
 const R=[],push=(...r)=>R.push(r);
 if(kind==="daily"||kind==="pack"){
  push("DAILY OPERATIONS SNAPSHOT — generation as of "+XL_LAST+" (Excel DGR); N/A = not in workbook");push("Plant","Capacity (mW)","Generation (mWh)","Availability %","PR %","Alarms","Status");
  S.plants.forEach(p=>push(p.name,xlNA(p.capacity),xlNA(p.generation),xlNA(p.availability),xlNA(p.pr),xlNA(p.alarms),xlNA(p.status)));
  push("Open issues",openTk(S.issues).length,"Wash compliance %",washCompliancePct(),"PM on-time %",pmOnTimePct());push([]);}
 if(kind==="weekly"||kind==="pack"){
  push("WEEKLY CLIENT REPORT — PER PLANT");push("Plant","Wash compliance %","Tables in cycle","PM adherence %","Open critical");
  S.plants.forEach(p=>{const rows=S.washing.filter(t=>t.plant===p.name),freq=(S.washMeta[p.name]||{freq:14}).freq;
   const ok=rows.filter(t=>daysSince(t)<=freq).length;
   push(p.name,rows.length?Math.round(100*ok/rows.length):100,rows.length,pmOnTimePct(),openTk(S.issues).filter(t=>t.plant===p.name&&isCriticalIssue(t)).length);});push([]);}
 if(kind==="monthly"||kind==="pack"){
  push("MONTHLY O&M COMPLIANCE PACK");push("Metric","Value");
  push("Scheduled compliance %",pmOnTimePct());push("Washing compliance %",washCompliancePct());
  push("Safety incidents (register)",S.incidents.length);push("PR vs target (80%)","N/A");
  healthScores().forEach(x=>push("Health score — "+x.label,(x.pct==null?"N/A":x.pct+"% ("+x.note+")")));push([]);}
 if(kind==="handover"||kind==="pack"){
  push("HANDOVER STATUS DIGEST");push("Handover","Project","Stage","Progress %","Blocked / overdue items");
  S.handovers.filter(h=>h.status!=="active_om").forEach(h=>push(h.id,h.project,HO_STAGES[hoStage(h)-1],hoProg(h).pct,h.items.filter(i=>i.mandatory&&itemOD(i)>0&&!counted(i)).length));push([]);}
 if(kind==="pack"){
  push("MTBF / MTTR BY EQUIPMENT");push("Equipment","MTBF (h)","MTTR (h)","Failures 90d");
  EQUIP_MTB.forEach(e=>push(e.type,e.mtbf,e.mttr,e.fl));push([]);
  push("SLA COMPLIANCE");push("SLA","Adherence %");
  push("Critical Issues ("+etcHrs("Critical")+"h)",slaMetPct("Critical"));push("Medium Issues ("+etcHrs("Medium")+"h)",slaMetPct("Medium"));push("Low Issues ("+etcHrs("Low")+"h)",slaMetPct("Low"));push("Wash Frequency",washCompliancePct());push("PM On-Time",pmOnTimePct());}
 return R;
}
function downloadReport(kind){
 const name=REPORT_DEFS.find(r=>r[0]===kind);
 const rows=reportRowsExport(kind);
 const csv=rows.map(r=>(Array.isArray(r)?r:[r]).map(c=>'"'+String(c==null?"":c).replace(/"/g,'""')+'"').join(",")).join("\r\n");
 const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"});
 const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="solar91-"+kind+"-report-"+TODAY+".csv";
 document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),800);
 audit("Reports","Downloaded "+(name?name[1]:"full analytics report pack")+" (3.10)",OM_HEAD);
 toast("Report downloaded — solar91-"+kind+"-report-"+TODAY+".csv");
}

/* 2 · Which donut slice / KPI is active under the current filter */
function ccDonutOn(act,id){
 const f=S.issF||{};
 if(act==="donutHealth")return f.health===id;
 if(act==="plantHealth")return (S.plF||{}).health===id;
 if(act==="donutStatus"||act==="issuesPlantStatus")return f.bucket===id;
 if(act==="issSev")return f.sev===id;
 if(act==="issAge")return f.aging===id;
 return false;
}

(function(){ /* chip removal — attached once */
 if(window._ccfx)return;window._ccfx=true;
 document.addEventListener("click",function(e){
  const b=e.target.closest?e.target.closest("[data-ccfx]"):null;if(!b)return;
  e.stopPropagation();
  const k=b.getAttribute("data-ccfx"),f=Object.assign(blankIssF(),S.issF||{});
  if(k==="plHealth")S.plF=Object.assign(S.plF||{},{health:"all"});
  else if(k==="dashPlant"){S.dashPlant="all";S.schedScope="all"}
  else if(k==="range"){f.from="";f.to=""}
  else if(k==="q")f.q="";
  else if(k==="health")f.health="all";
  else if(k in f)f[k]="all";
  S.issF=f;S.tablePages.issues=1;persist();render();
 });
})();

(function(){
 const st=document.createElement("style");
 st.textContent=
  "body{background:radial-gradient(1100px 380px at 75% -120px,#DCEEE3 0%,#F3F6F3 55%)}"+
  ".panel{border-radius:18px;border-color:#E2EAE4}"+
  ".cc-hero{position:relative;overflow:hidden;border-radius:20px;padding:20px 26px;color:#fff;background:radial-gradient(circle at 91% 22%,rgba(255,209,102,.24),transparent 17%),linear-gradient(118deg,#082719 0%,#0E4A2B 48%,#168447 118%);box-shadow:0 16px 40px rgba(11,43,29,.28)}"+
  ".cc-hero:before{content:\"\";position:absolute;right:-80px;top:-120px;width:340px;height:340px;border-radius:50%;background:radial-gradient(circle,rgba(255,200,60,.38),rgba(255,200,60,0) 62%);pointer-events:none}"+
  ".cc-hero-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;position:relative;z-index:1}"+
  ".cc-hero-mark{width:44px;height:44px;border-radius:12px;background:rgba(255,255,255,.14);display:grid;place-items:center;color:#FFD666;flex-shrink:0}"+
  ".cc-hero-title{font-size:18px;font-weight:800;letter-spacing:-.01em}"+
  ".cc-hero-sub{font-size:11.5px;color:rgba(255,255,255,.72);margin-top:2px}"+
  ".cc-hero-pill{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;font-weight:700;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.22)}"+
  ".cc-hero-dot{width:8px;height:8px;border-radius:99px;background:#4ADE80;animation:pulse 1.8s infinite}"+
  ".cc-hero-actions{margin-left:auto;display:flex;gap:8px}"+
  ".cc-hero-actions .btn{background:#fff;color:#0B2B1D;border:none}"+
  ".cc-hero-actions .btn.o{background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.25)}"+
  ".cc-hero-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:12px;margin-top:16px;position:relative;z-index:1}"+
  ".cc-hstat{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:14px;padding:10px 14px;transition:background .15s}"+
  ".cc-hstat:hover{background:rgba(255,255,255,.16)}"+
  ".cc-hstat[data-act]{cursor:pointer}"+
  ".cc-hstat span{font-size:9.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:rgba(255,255,255,.65)}"+
  ".cc-hstat b{display:block;font-size:23px;font-weight:800;letter-spacing:-.02em;margin-top:3px}"+
  ".cc-bento{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:14px}"+
  ".cc-ops-overview{color:#fff;background:linear-gradient(118deg,#0B2B1D 0%,#0E5A32 55%,#168447 100%);border:0;box-shadow:0 12px 28px rgba(11,43,29,.18)}"+
  ".cc-ops-overview h2{font-size:15px;font-weight:800}.cc-ops-overview>div:first-child p{font-size:11.5px;color:rgba(255,255,255,.72);margin:3px 0 0}"+
  ".cc-dashboard-filters{display:flex;flex-direction:column;gap:12px;padding:14px 16px!important;background:linear-gradient(140deg,#fff 0%,#F4FBF6 100%)}"+
  ".cc-filter-heading{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:800;color:#174B2D}"+
  ".cc-filter-heading i{display:grid;width:28px;height:28px;place-items:center;border-radius:9px;background:#E3F5E9;color:#0C5E2A;font-style:normal}"+
  ".cc-filter-controls{display:grid;grid-template-columns:repeat(3,minmax(150px,1fr));gap:10px;align-items:end}"+
  ".cc-filter-controls .field{min-width:0!important}.cc-filter-controls .inp{height:42px;border-radius:11px;background:#fff;border-color:#D5E5DA;transition:border-color .16s,box-shadow .16s}.cc-filter-controls .inp:focus{border-color:#16A34A;box-shadow:0 0 0 3px rgba(22,163,74,.12)}"+
  ".cc-filter-chips{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.cc-filter-chips .ccsep{height:22px}"+
  ".cc-work-overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}"+
  ".cc-work-overview>section{--queue-accent:#16A34A;position:relative;overflow:hidden;min-width:0;padding:16px;border-radius:16px;background:linear-gradient(145deg,#fff 0%,#F8FCF9 100%);border:1px solid rgba(255,255,255,.76);box-shadow:0 10px 26px rgba(0,0,0,.12);color:#17231B}"+
  ".cc-work-overview>section:before{content:\"\";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--queue-accent)}"+
  ".cc-work-overview>section:first-child{--queue-accent:#F97316}.cc-work-overview>section:nth-child(2){--queue-accent:#16A34A}.cc-work-overview>section:nth-child(3){--queue-accent:#E8A629}"+
  ".cc-ops-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:42px}"+
  ".cc-ops-title{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#18271D}"+
  ".cc-ops-sub{font-size:11px;color:#69756F;margin-top:3px}"+
  ".cc-solar-spark{display:grid;width:34px;height:34px;place-items:center;border-radius:11px;background:#FFF4D6;color:#B87905;font-size:20px;box-shadow:inset 0 0 0 1px #F5E4B5}"+
  ".cc-ops-overview .btn.o{background:#fff;color:#14532D;border:1px solid #D8E7DD;white-space:nowrap}"+
  ".cc-ops-overview .btn.o:hover{background:#EFF9F2;border-color:#A8D4B6}"+
  ".cc-ops-content{display:grid;grid-template-columns:132px minmax(0,1fr);gap:16px;align-items:center;margin-top:15px}"+
  ".cc-ops-donut{width:124px;height:124px;border-radius:50%;display:grid;place-items:center;background:transparent;position:relative;filter:drop-shadow(0 7px 10px rgba(22,50,32,.13));transition:transform .2s ease}"+
  ".cc-work-overview>section:hover .cc-ops-donut{transform:rotate(-8deg) scale(1.035)}"+
  ".cc-ops-donut:before{content:\"\";position:absolute;z-index:0;inset:13px;border-radius:50%;background:#fff;box-shadow:inset 0 0 0 1px #E7EEE9}"+
  ".cc-ops-donut>svg,.cc-ops-empty-ring{position:absolute;inset:0;width:100%;height:100%;z-index:1}"+
  ".cc-ops-empty-ring{border-radius:50%;background:conic-gradient(#DDE7E0 0deg 360deg)}"+
  ".cc-ops-arc{cursor:pointer;transition:filter .15s,opacity .15s}.cc-ops-arc:hover{filter:brightness(1.12)}.cc-ops-arc:focus{outline:none;filter:brightness(1.18)}"+
  ".cc-ops-donut>div{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center}"+
  ".cc-ops-donut b{font-size:25px;font-weight:800;line-height:1;letter-spacing:-.04em;color:#17231B}"+
  ".cc-ops-donut span{margin-top:5px;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#78847D}"+
  ".cc-ops-legend{display:grid;gap:9px;min-width:0}"+
  ".cc-ops-legend>div,.cc-ops-legend>button{display:grid;grid-template-columns:9px minmax(0,1fr) auto;gap:8px;align-items:center;font-size:11px;color:#617067}"+
  ".cc-ops-legend>button{width:100%;padding:2px 4px;margin:-2px -4px;border:0;border-radius:7px;background:transparent;text-align:left;cursor:pointer;font:inherit}.cc-ops-legend>button:hover,.cc-ops-legend>button:focus-visible{background:#F0F7F2;outline:none}"+
  ".cc-ops-legend i{width:8px;height:8px;border-radius:50%;background:var(--legend-color);box-shadow:0 0 0 3px rgba(16,80,35,.10)}"+
  ".cc-ops-legend b{font-size:15px;color:#1C2A21;font-variant-numeric:tabular-nums}"+
  ".cc-ops-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:11px;border-top:1px solid #E7EEE9;font-size:10.5px;color:#69756F}"+
  ".cc-drill-filter{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 14px;margin:0 12px 10px;border:1px solid #CDE5D4;border-radius:10px;background:#F1FAF3;color:#28563A;font-size:12px;scroll-margin-top:82px}"+
  "#section-results{scroll-margin-top:82px}"+
  ".cc-ops-foot strong{color:#263B2D;font-size:11px}"+
  "@media(max-width:1120px){.cc-work-overview{grid-template-columns:repeat(2,minmax(0,1fr))}.cc-work-overview>section:last-child{grid-column:1/-1}.cc-work-overview>section:last-child .cc-ops-content{grid-template-columns:132px minmax(0,1fr)}}"+
  "@media(max-width:900px){.cc-filter-controls{grid-template-columns:repeat(2,minmax(0,1fr))}}"+
  "@media(max-width:640px){.cc-work-overview{grid-template-columns:1fr}.cc-ops-head{align-items:flex-start;flex-direction:column}.cc-ops-overview .btn.o{white-space:normal}.cc-ops-content{grid-template-columns:108px minmax(0,1fr);gap:13px}.cc-ops-donut{width:104px;height:104px}.cc-ops-donut:before{inset:11px}.cc-filter-controls{grid-template-columns:minmax(0,1fr)}.cc-filter-chips{gap:5px}}"+
  ".cc-bento>.sp5{grid-column:span 5}.cc-bento>.sp4{grid-column:span 4}.cc-bento>.sp3{grid-column:span 3}"+
  "@media(max-width:1050px){.cc-bento>.sp5,.cc-bento>.sp4,.cc-bento>.sp3{grid-column:span 12}}"+
  ".cc-kpi2{position:relative;overflow:hidden;display:flex;flex-direction:column;gap:8px;padding:14px 16px 16px;border-radius:16px;border:1px solid #E2EAE4;background:#fff;box-shadow:0 2px 6px rgba(16,32,24,.05),0 12px 30px rgba(16,32,24,.06);transition:transform .16s,border-color .16s,box-shadow .16s}"+
  ".cc-kpi2 .cc-wm{position:absolute;right:-10px;top:-12px;opacity:.07}"+
  ".cc-kpi2 .cc-top{display:flex;align-items:center;gap:10px}"+
  ".cc-kpi2 .cc-ico2{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;flex-shrink:0}"+
  ".cc-kpi2 .cc-lab2{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground)}"+
  ".cc-kpi2 .cc-val2{font-size:28px;font-weight:800;letter-spacing:-.02em;line-height:1}"+
  ".cc-kpi2 .cc-note2{font-size:11px;color:var(--muted-foreground)}"+
  ".cc-kpi2.kpi-click{cursor:pointer}"+
  ".cc-kpi2.kpi-click:hover{transform:translateY(-3px);border-color:var(--primary);box-shadow:0 16px 34px rgba(22,163,74,.18)}"+
  ".cc-kpi2.kpi-active{border-color:var(--primary);box-shadow:0 0 0 3px rgba(22,163,74,.15),0 14px 30px rgba(22,163,74,.14)}"+
  ".cc-kpi2 .cc-onbadge{position:absolute;top:10px;right:12px;background:var(--secondary);color:var(--secondary-foreground);font-size:8.5px;font-weight:800;letter-spacing:.06em;padding:2px 7px;border-radius:999px}"+
  ".cc-load2{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:9px;font-size:12px;cursor:pointer;margin:0 -8px;transition:background .12s}"+
  ".cc-load2:hover{background:var(--surface-subtle)}"+
  ".cc-load2 .av3{width:24px;height:24px;border-radius:99px;background:var(--secondary);border:1px solid #BFE5CC;color:var(--secondary-foreground);display:grid;place-items:center;font-size:9px;font-weight:700;flex-shrink:0}"+
  ".cc-load2 .nm3{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"+
  ".prio-stack2{display:flex;height:12px;border-radius:99px;overflow:hidden;background:var(--muted)}"+
  ".prio-stack2 i{display:block;cursor:pointer;min-width:0;transition:filter .15s}"+
  ".prio-stack2 i:hover{filter:brightness(1.18)}";
 document.head.appendChild(st);
})();

const CC_TINT={"var(--success)":"var(--success-soft)","var(--warning)":"var(--warning-soft)","var(--danger)":"var(--danger-soft)","var(--info)":"var(--info-soft)","var(--foreground)":"var(--muted)","var(--primary)":"var(--secondary)"};
const CC_PC={Critical:"#DC4C3E",Medium:"#3B82F6",Low:"#94A3B8"};
function ccIni(n){return String(n||"—").split(/\s+/).map(w=>w[0]||"").join("").slice(0,2).toUpperCase()}
function ccKpiIcon(label,size){
 const l=String(label).toLowerCase(),s=size||17;
 if(l.includes("healthy"))return I.check(s);
 if(l.includes("warning"))return I.alert(s);
 if(l.includes("critical"))return I.xcirc(s);
 if(l.includes("overdue")||l.includes("15+"))return I.hist(s);
 if(l.includes("unassigned"))return I.clipc(s);
 if(l.includes("resolved")||l.includes("persistence"))return I.bcheck(s);
 if(l.includes("open")||l.includes("assigned")||l.includes("engineer"))return I.wrench(s);
 if(l.includes("today"))return I.sun(s);
 if(l.includes("mine"))return I.clipc(s);
 if(l.includes("equipment"))return I.gear(s);
 return I.gauge(s);
}
/* NEW KPI CARD — icon tile + watermark + big number (every page) */
function kpiTile(label,value,note,color,act){
 let on=false;
 if(act){
  const a=(act.match(/data-act="([^"]*)"/)||[])[1]||"",id=(act.match(/data-id="([^"]*)"/)||[])[1]||"";
  const f=S.issF||{},pl=S.plF||{};
  if(a==="kpi"){
   if(id==="healthy")on=pl.health==="Healthy"||f.health==="Healthy";
   else if(id==="warning")on=pl.health==="Warning"||f.health==="Warning";
   else if(id==="criticalPlants")on=pl.health==="Critical"||f.health==="Critical";
   else if(id==="overdue")on=f.chip==="Overdue";
   else if(id==="unassigned")on=f.chip==="Unassigned";
   else if(id==="resolved")on=f.status==="Resolved"||f.bucket==="Resolved";
  }else if(a==="chip")on=id==="all"?f.chip==="Open":f.chip===id;
  else if(a==="plantHealth")on=pl.health===id;
 }
 const tint=CC_TINT[color]||"var(--muted)";
 return '<div class="cc-kpi2'+(act?" kpi-click":"")+(on?" kpi-active":"")+'" '+(act||"")+'>'+
  '<span class="cc-wm" style="color:'+color+'">'+ccKpiIcon(label,46)+'</span>'+
  '<div class="cc-top"><span class="cc-ico2" style="background:'+tint+';color:'+color+'">'+ccKpiIcon(label,17)+'</span><span class="cc-lab2">'+label+'</span></div>'+
  '<div class="cc-val2" style="color:'+color+'">'+value+'</div>'+
  '<div class="cc-note2">'+note+'</div>'+
  (on?'<span class="cc-onbadge">ACTIVE</span>':'')+'</div>';
}
/* BENTO SIDE CARD — priority mix + workload (real data, clickable) */
function ccSideCard(issues){
 const f=S.issF||{},P=["Critical","Medium","Low"];
 const cnt=p=>issues.filter(t=>normalizeIssueSeverity(t.severity)===p).length;
 const total=P.reduce((a,p)=>a+cnt(p),0);
 let inner="";
 if(total){
  inner='<div class="prio-stack2">'+P.filter(p=>cnt(p)>0).map(p=>'<i style="flex:'+cnt(p)+';background:'+CC_PC[p]+'" data-act="issSev" data-id="'+p+'" data-tip="'+p+' priority · '+cnt(p)+' — click to filter"></i>').join("")+'</div>'+
  '<div class="row wrap" style="gap:6px;margin-top:10px">'+P.map(p=>'<button class="pill pillsm sev-pill'+(f.sev===p?" active":"")+'" data-act="issSev" data-id="'+p+'"><span class="dot" style="width:8px;height:8px;background:'+CC_PC[p]+'"></span>'+p+' '+cnt(p)+'</button>').join("")+'</div>';
  const act=issues.filter(t=>["Open","Assigned","Acknowledged","In Progress"].includes(t.status));
  const by={};act.forEach(t=>{const a=t.assignee||"__un";by[a]=(by[a]||0)+1});
  const loads=Object.entries(by).sort((a,b)=>b[1]-a[1]).slice(0,5);
  if(loads.length)inner+='<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px"><div class="kpi-label" style="margin-bottom:4px">Open workload</div>'+
   loads.map(([a,n])=>'<div class="cc-load2" data-act="'+(a==='__un'?'ccChip':'workWho')+'" data-id="'+(a==='__un'?'Unassigned':esc(a))+'" data-tip="Click to view"><span class="av3">'+esc(ccIni(a==='__un'?'—':a))+'</span><span class="nm3">'+(a==='__un'?'<span class="badge b-danger">Unassigned</span>':esc(a))+'</span><b>'+n+'</b></div>').join("")+'</div>';
 }else inner=emptyState("No issues in filter","Priority mix and workload appear when issues exist.");
 return '<div class="panel sp3"><h2 style="font-size:14px;font-weight:700">Priority &amp; workload</h2><p style="font-size:11.5px;color:var(--muted-foreground);margin:3px 0 12px">Click anything to filter</p>'+inner+'</div>';
}
/* DARK HERO — portfolio status banner (real data) */
function ccHero(plants,open,overdue,health,mW){
 const unass=open.filter(t=>!t.assignee).length;
 const role=S._roleLabel||S.currentRole||"";
 const canRaiseIssue=["O&M Head","Assignee","Site Engineer"].includes(role);
 const actions=(canRaiseIssue?'<button class="btn sm" onclick="openModal(\'newTicket\')">'+I.plus(13)+' Raise issue</button>':"")+
  (role==="O&M Head"?'<button class="btn sm o" onclick="openModal(\'commission\')">New plant</button>':"");
 const stTxt=(health.Critical>0||overdue.length>0)?"ATTENTION":open.length?"MONITORING":"OPERATIONAL";
 const stCol=stTxt==="ATTENTION"?"#FBBF24":stTxt==="MONITORING"?"#93C5FD":"#4ADE80";
 const hs=(l,v,c,act)=>'<div class="cc-hstat"'+(act?' data-act="kpi" data-id="'+act+'" data-tip="Click to filter"':'')+'><span>'+l+'</span><b'+(c?' style="color:'+c+'"':'')+'>'+v+'</b></div>';
 return '<div class="cc-hero">'+
  '<div class="cc-hero-top">'+
  '<span class="cc-hero-mark">'+I.sun(22)+'</span>'+
  '<div><div class="cc-hero-title">SOLAR 91<sup style="font-size:9px;font-weight:700;vertical-align:super;color:#FFD666;margin-left:2px">™</sup> — Portfolio Operations</div></div>'+
  '<span class="cc-hero-pill"><span class="cc-hero-dot" style="background:'+stCol+'"></span>'+stTxt+'</span>'+
  (actions?'<div class="cc-hero-actions">'+actions+'</div>':"")+'</div>'+
  '<div class="cc-hero-stats">'+
  hs("Plants",plants.length,null,"plants")+
  hs("Capacity",mW?Math.round(mW*10)/10+" mW":"—")+
  hs("Critical plants",health.Critical,health.Critical?"#FCA5A5":null,"criticalPlants")+
  hs("Unassigned",unass,unass?"#FDE68A":null,"unassigned")+
  '</div></div>';
}

function renderDashboard(){
 const f=Object.assign(blankIssF(),S.issF||{});S.issF=f;
 const equipmentChoices=dashboardEquipmentOptions(f.plant);
 const searchablePlantNames=new Set(ccPlantSearchScope().map(p=>p.name));
 if(f.equip!=="all"&&!equipmentChoices.some(e=>e.value===f.equip)){f.equip="all";S.issF.equip="all"}
 const dashboardIssues=(S.issues||[]).filter(t=>searchablePlantNames.has(t.plant));
 const issuesBase=filterIssues(dashboardIssues,Object.assign({},f,{health:"all"}));
 const issues=filterIssues(dashboardIssues,f);
 const healthKey=f.health&&f.health!=="all"?f.health:null;
 const scopePlants=dashScope();
 const plants=scopePlants.filter(p=>{
  if(f.plant&&f.plant!=="all"&&p.name!==f.plant)return false;
  if(healthKey&&plantHealthOf(p,issuesBase)!==healthKey)return false;
  return true;
 });
 const healthSrc=healthKey?plants:scopePlants;
 const health={Healthy:0,Warning:0,Critical:0};healthSrc.forEach(p=>{health[plantHealthOf(p,issuesBase)]++});
 const mW=plants.reduce((a,p)=>a+(xlNum(p.capacity)?p.capacity:0),0);
 const open=openTk(issues),overdue=open.filter(isOverdueIssue);
 const attnRows=(function(){const openA=openTk(issues);const byP={};openA.forEach(t=>{byP[t.plant]=(byP[t.plant]||0)+1});const seen={};return openA.filter(t=>{const hot=t.severity==="Critical"||isOverdueIssue(t)||!t.assignee||(byP[t.plant]||0)>=2;if(!hot||seen[t.id])return false;seen[t.id]=1;return true}).sort((a,b)=>(SEV_RANK[a.severity]??9)-(SEV_RANK[b.severity]??9)||issueAgeDays(b)-issueAgeDays(a))})();
 const buckets=["Open","Assigned","In Progress","Resolved","Closed"];
 const healthSlices=[{label:"Healthy",id:"Healthy",n:health.Healthy,color:"#16A34A",act:"donutHealth"},{label:"Warning",id:"Warning",n:health.Warning,color:"#D97706",act:"donutHealth"},{label:"Critical",id:"Critical",n:health.Critical,color:"#DC4C3E",act:"donutHealth"}];
 const makersList=[...new Set((S.issues||[]).map(t=>t.maker).filter(Boolean))].sort();
 const active=ccFilterActive()||f.equip!=="all";
 const role=S._roleLabel||S.currentRole||"";
 const canOpenIssues=["O&M Head","Assignee","Site Engineer"].includes(role);
 const canOpenPm=["O&M Head","Assignee","Administration","Client / Asset Owner","Site Engineer"].includes(role);
 let h=ccHero(plants,open,overdue,health,mW);
 h+=ccFilterBar();
 h+='<div class="panel filter-panel cc-dashboard-filters"><div class="cc-filter-heading"><i>⌕</i><span>Filter live operations</span></div><div class="cc-filter-controls">'+
  '<div class="field"><span class="lbl">Plant</span><select class="inp" aria-label="Filter dashboard by plant" onchange="setDashboardPlantFilter(this.value)"><option value="all"'+(f.plant==="all"?" selected":"")+'>All plants</option>'+ccPlantSearchScope().map(p=>'<option value="'+esc(p.name)+'"'+(f.plant===p.name?" selected":"")+'>'+esc(p.name)+'</option>').join("")+'</select></div>'+
  '<div class="field"><span class="lbl">Equipment</span><select class="inp" aria-label="Filter dashboard by equipment" onchange="setDashboardEquipmentFilter(this.value)"><option value="all"'+(f.equip==="all"?" selected":"")+'>All equipment</option>'+equipmentChoices.map(e=>'<option value="'+esc(e.value)+'"'+(f.equip===e.value?" selected":"")+'>'+esc(e.label)+'</option>').join("")+'</select></div>'+
  (makersList.length?'<div class="field"><span class="lbl">Maker</span><select class="inp" onchange="S.issF.maker=this.value;render()"><option value="all">All makers</option>'+makersList.map(m=>'<option'+(f.maker===m?" selected":"")+'>'+esc(m)+'</option>').join("")+'</select></div>':'')+
  '</div><div class="cc-filter-chips">'+
  [["all","All"],["Critical","Critical"],["Overdue","Overdue"],["Unassigned","Unassigned"],["Today","Today"],["Mine","My issues"]].map(([id,l])=>'<button class="pill sev-pill'+(f.chip===id?" active":"")+'" data-act="ccChip" data-id="'+id+'">'+l+'</button>').join("")+
  '<span class="ccsep"></span>'+
  buckets.map(b=>'<button class="pill sev-pill'+(f.bucket===b?" active":"")+'" data-act="donutStatus" data-id="'+b+'">'+b+' '+issues.filter(t=>statusBucket(t)===b).length+'</button>').join("")+
  '<span class="ccsep"></span>'+
  healthSlices.map(s=>'<button class="pill sev-pill'+(f.health===s.id?" active":"")+'" data-act="donutHealth" data-id="'+s.id+'">'+s.label+' '+s.n+'</button>').join("")+
  '</div>'+
  (active?'<button class="btn o sm" onclick="S.issF=blankIssF();S.plF=Object.assign(S.plF||{},{health:\'all\'});S.dashPlant=\'all\';persist();render()">Clear filters</button>':'')+'</div></div>';
 const scopedPlantNames=new Set(plants.map(p=>p.name));
 const overviewIssues=open.filter(t=>scopedPlantNames.has(t.plant));
 const overviewOverdue=overviewIssues.filter(isOverdueIssue);
 const pmTasks=(S.tasks||[]).filter(t=>scopedPlantNames.has(t.plant)&&t.status!=="Completed"&&ccDashboardEquipmentMatches(t,f.equip));
 const pmOverdue=pmTasks.filter(t=>taskOD(t)>0);
 const pmDueSoon=pmTasks.filter(t=>{const d=dayDiff(TODAY,t.due);return d>=0&&d<=7});
 const pmWashDue=(S.washing||[]).filter(t=>{
  if(!scopedPlantNames.has(t.plant)||washedToday(t)||excToday(t))return false;
  if(!ccDashboardEquipmentMatches({type:"Inverter",equip:"INV-"+pad2(t.inv),plant:t.plant},f.equip))return false;
  const meta=(S.washMeta||{})[t.plant]||{freq:14};
  return wDue(t,meta.freq);
 });
 const issueCritical=overviewIssues.filter(t=>t.severity==="Critical").length;
 const issueOverdueOther=overviewOverdue.filter(t=>t.severity!=="Critical").length;
 const issueOther=Math.max(0,overviewIssues.length-issueCritical-issueOverdueOther);
 const pmLater=Math.max(0,pmTasks.length-pmOverdue.length-pmDueSoon.length);
 const issueSegments=[{label:"Critical",id:"critical",act:canOpenIssues?"ccIssueQueue":"",value:issueCritical,color:"#E85D43"},{label:"Overdue",id:"overdue",act:canOpenIssues?"ccIssueQueue":"",value:issueOverdueOther,color:"#F1A33C"},{label:"Other open",id:"other",act:canOpenIssues?"ccIssueQueue":"",value:issueOther,color:"#32A66A"}];
 const pmSegments=[{label:"Overdue",id:"overdue",act:canOpenPm?"ccPmQueue":"",value:pmOverdue.length,color:"#E85D43"},{label:"Due in 7 days",id:"due7",act:canOpenPm?"ccPmQueue":"",value:pmDueSoon.length,color:"#F1A33C"},{label:"Upcoming",id:"upcoming",act:canOpenPm?"ccPmQueue":"",value:pmLater,color:"#3987D6"}];
 const portfolioHealthSegments=[{label:"Healthy",value:health.Healthy,color:"#32A66A"},{label:"Warning",value:health.Warning,color:"#F1A33C"},{label:"Critical",value:health.Critical,color:"#E85D43"}];
 const portfolioHealthTotal=portfolioHealthSegments.reduce((sum,segment)=>sum+segment.value,0);
 const issueDonut=ccOpsDonut(overviewIssues.length,issueSegments,"OPEN");
 const pmDonut=ccOpsDonut(pmTasks.length,pmSegments,"ACTIVE");
 const portfolioHealthDonut=ccOpsDonut(portfolioHealthTotal,portfolioHealthSegments,"PLANTS");
 const operationLink=canOpenIssues?'<button class="btn o sm" onclick="goTab(\'issues\')">Open Site Issues</button>':"";
 const filteredScopeLabel=f.plant&&f.plant!=="all"?f.plant:"current plant scope";
 h+='<div class="panel cc-ops-overview"><div class="row between wrap" style="gap:10px;margin-bottom:14px"><div><h2>Operations overview</h2><p>Live issue and maintenance queues · '+esc(filteredScopeLabel)+'</p></div></div>'+
  '<div class="cc-work-overview">'+
   '<section><div class="cc-ops-head"><div><div class="cc-ops-title">Unplanned · Site Issues</div><div class="cc-ops-sub">Faults and urgent work</div></div>'+operationLink+'</div>'+
    '<div class="cc-ops-content">'+issueDonut+'<div class="cc-ops-legend">'+issueSegments.map(s=>'<'+(s.act?'button type="button" data-act="'+s.act+'" data-id="'+s.id+'"':'div')+'><i style="--legend-color:'+s.color+'"></i><span>'+s.label+'</span><b>'+s.value+'</b></'+(s.act?'button':'div')+'>').join("")+'</div></div><div class="cc-ops-foot"><span>Overdue issues</span><strong>'+overviewOverdue.length+'</strong></div></section>'+
   '<section><div class="cc-ops-head"><div><div class="cc-ops-title">Planned · Preventive Maintenance</div><div class="cc-ops-sub">Work orders and washing cycles</div></div><button class="btn o sm" onclick="goScheduledOM(\'maintenance\')">Open Preventive Maintenance</button></div>'+
    '<div class="cc-ops-content">'+pmDonut+'<div class="cc-ops-legend">'+pmSegments.map(s=>'<'+(s.act?'button type="button" data-act="'+s.act+'" data-id="'+s.id+'"':'div')+'><i style="--legend-color:'+s.color+'"></i><span>'+s.label+'</span><b>'+s.value+'</b></'+(s.act?'button':'div')+'>').join("")+'</div></div><div class="cc-ops-foot"><span>Washing due</span><strong>'+pmWashDue.length+'</strong></div></section>'+
   '<section><div class="cc-ops-head"><div><div class="cc-ops-title">Solar portfolio health</div><div class="cc-ops-sub">Plant status across this view</div></div><span class="cc-solar-spark">☀</span></div>'+
    '<div class="cc-ops-content">'+portfolioHealthDonut+'<div class="cc-ops-legend">'+portfolioHealthSegments.map(s=>'<div><i style="--legend-color:'+s.color+'"></i><span>'+s.label+'</span><b>'+s.value+'</b></div>').join("")+'</div></div><div class="cc-ops-foot"><span>Plants in view</span><strong>'+portfolioHealthTotal+'</strong></div></section>'+
  '</div></div>';
 h+='<div class="panel no-stick" style="padding:0"><div style="padding:14px 16px 0"><div class="row between wrap"><div><h2 style="font-size:15px;font-weight:700">Needs attention</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 10px">Critical and overdue issues first</p></div>'+(canOpenIssues?'<button class="btn g sm" data-act="go" data-id="issues">All issues</button>':"")+'</div></div>';
 if(!attnRows.length)h+=emptyState("No critical issues","Nothing overdue or unassigned in the current filter.");
 else{h+='<div style="overflow-x:auto"><table class="dense"><thead><tr><th>Plant</th><th>Issue</th><th>Equipment / maker</th><th>Priority</th><th>Age</th><th>Assignee</th><th>Status</th></tr></thead><tbody>'+
  attnRows.slice(0,12).map(t=>{const p=plantRec(t.plant);return '<tr class="click" data-act="issue" data-id="'+esc(t.id)+'" title="Open issue"><td><div style="font-weight:600">'+(p?esc(p.name):esc(t.plant||"—"))+'</div><div style="font-size:10.5px;color:var(--muted-foreground)">'+(p?esc(p.id):"")+'</div></td><td><div style="font-weight:600">'+esc(t.id)+'</div><div style="font-size:10.5px;color:var(--muted-foreground)">'+esc(t.vertical)+'</div></td><td>'+esc(t.equip||"—")+(t.maker?'<div style="font-size:10.5px;color:var(--muted-foreground)">'+esc(t.maker)+'</div>':'')+'</td><td>'+badge(t.severity)+'</td><td class="nowrap">'+esc(ageBucket(t))+'</td><td>'+(t.assignee?esc(t.assignee):'<span style="color:var(--danger);font-weight:600">Unassigned</span>')+'</td><td>'+badge(t.status)+(isOverdueIssue(t)?' '+badge("Overdue"):"")+'</td></tr>'}).join("")+'</tbody></table></div>';}
 h+='</div>';
 return h;
}


/* 1 · Operations date — remove the forward-only lock */
function setOpsDate(v){if(!v)return;S.opsDate=v;TODAY=v;NOW_ISO=v+"T15:00";persist();render();toast("Operations date set to "+fmtDate(v)+" — overdue / SLA calculations refreshed.")}

/* 2 · Equipment dropdown — washing setup + equipment already used on
      tickets (so it's never empty), plus friendlier label */
function equipmentOptions(plant){
 const inv=[...new Set(S.washing.filter(t=>t.plant===plant).map(t=>"INV-"+pad2(t.inv)))];
 const used=[...new Set((S.issues||[]).filter(t=>t.plant===plant&&t.equip&&t.equip!=="—").map(t=>t.equip))];
 /* Supabase equipment master data (Phase 1 schema) for this plant, once any exists — see EQUIPMENT table. */
 const p=(S.plants||[]).find(z=>z.name===plant||z.id===plant);
 const dbEq=p?(S.equipment||[]).filter(e=>String(e.plant_id)===String(p.dbId)&&e.status!=="inactive").flatMap(e=>[e.equipment_code,e.equipment_name]).filter(Boolean):[];
 return [...new Set(inv.concat(used).concat(dbEq))];
}
(function(){ /* after each render: unlock the date picker + rename the label */
 try{
  const mo=new MutationObserver(()=>{
   document.querySelectorAll('input[type=date][min]').forEach(el=>{if(el.getAttribute("min")==="2026-09-14")el.removeAttribute("min")});
   document.querySelectorAll("span.lbl").forEach(el=>{if(el.textContent==="Equipment / asset reference")el.textContent="Equipment (optional — pick or type your own)"});
  });
  mo.observe(document.getElementById("app"),{childList:true,subtree:true});
 }catch(e){}
})();

/* 3 · Site Issues — compact filters + active-filter chips + no
      status/bucket conflict. Everything else unchanged. */
/* inline assign from the triage queue — mirrors assignTicket() for a normal (non-vendor) assignment */
function oiQuickAssign(id){
 if(!scheduledAdmin()){toast("Only the O&M Head can assign issues.");return}
 const t=S.issues.find(x=>x.id===id);if(!t)return;
 const sel=document.getElementById("oi-qa-"+id),who=sel&&sel.value;
 if(!who){toast("Choose who to assign "+id+" to.");return}
 const patch={assignee:who,status:"Assigned",updated:stampISO(),progress:[{at:stampISO(),note:"Assigned to "+who+(t.severity==="Critical"?" — immediate call/SMS alert issued in addition to app notification.":" — notified (push/SMS/email per severity)."),parts:"—",hrs:0},...(t.progress||[])]};
 S.issues=S.issues.map(x=>x.id===id?{...x,...patch}:x);
 audit("Issues","Ticket "+id+" assigned → "+who,OM_HEAD,t.status,"Assigned");
 emitEvent("ticket_assigned","Ticket assigned — "+id,(t.plant||"")+" · "+who,"issue",id,"assigned:"+id+":"+who);
 persist();render();toast(id+" assigned to "+who+" — notified.");
}

function renderIssues(){
 const f=Object.assign(blankIssF(),S.issF||{});S.issF=f;
 const filtered=filterIssues(S.issues,f);
 const open=openTk(S.issues);
 const sites=[...new Set(S.plants.map(p=>p.id))].sort(),projs=[...new Set(S.plants.map(plantProject).filter(Boolean))].sort();
 const makers=[...new Set(S.issues.map(t=>t.maker).filter(Boolean))].sort();
 const equips=[...new Set(S.issues.map(t=>t.equip).filter(Boolean))].sort();
 const people=[...new Set(S.issues.map(t=>t.assignee).filter(Boolean).concat(TEAM_POOL))].sort();
 const STAT=["Open","Assigned","Acknowledged","In Progress","Pending Vendor","Resolved","Closed"];
 const AGES=["0–1 days","2–3 days","4–7 days","8–14 days","15+ days"];
 const chips=[["all","All"],["Critical","Critical"],["Overdue","Overdue"],["Unassigned","Unassigned"],["Today","Today"],["Mine","My Issues"]];
 const sel=(k,opts,w)=>'<select class="sel" style="width:'+w+'px" onchange="S.issF.'+k+'=this.value;if(\''+k+'\'===\'status\')S.issF.bucket=\'all\';S.tablePages.issues=1;render()">'+opts.map(([v,l])=>'<option value="'+esc(v)+'"'+(String(f[k])===String(v)?" selected":"")+'>'+esc(l)+'</option>').join("")+'</select>';
 const sorted=filtered.slice().sort((a,b)=>f.sort==="created"?String(b.created).localeCompare(String(a.created)):f.sort==="severity"?(SEV_RANK[a.severity]??9)-(SEV_RANK[b.severity]??9):f.sort==="age"?issueAgeDays(b)-issueAgeDays(a):new Date(a.etc)-new Date(b.etc));
 const issueRows=pageRows("issues",sorted,LIST_SIZE);
 const days=S.trendDays||10;
 const priorityColors={Critical:"#DC4C3E",Medium:"#3B82F6",Low:"#94A3B8"};
 const statusColors={Open:"#3B82F6",Assigned:"#6675D9","In Progress":"#0F9F8C",Resolved:"#16A34A",Closed:"#94A3B8"};
 const prioritySlices=SEV.map(s=>({label:s,id:s,n:filtered.filter(t=>t.severity===s).length,color:priorityColors[s],act:"issSev"})).filter(x=>x.n>0);
 const statusOrder=["Open","Assigned","In Progress","Resolved","Closed"];
 const statusSlices=[...new Set(filtered.map(statusBucket))].sort((a,b)=>statusOrder.indexOf(a)-statusOrder.indexOf(b)).map(b=>({label:b,id:b,n:filtered.filter(t=>statusBucket(t)===b).length,color:statusColors[b]||"#94A3B8",act:"donutStatus"})).filter(x=>x.n>0);
 const ageColors={"0–1 days":"#3B82F6","2–3 days":"#0F9F8C","4–7 days":"#D97706","8–14 days":"#EA7B24","15+ days":"#DC4C3E"};
 const ageRows=["0–1 days","2–3 days","4–7 days","8–14 days","15+ days"].map(label=>({label,n:openTk(filtered).filter(t=>ageBucket(t)===label).length})).filter(x=>x.n>0);
 const trendRows=issueTrendRows(days,filterIssues(S.issues,Object.assign({},f,{from:"",to:""})));
 const trendTotal=trendRows.reduce((sum,row)=>sum+row.o,0),trendAverage=trendRows.length?(trendTotal/trendRows.length).toFixed(1):"0.0",trendPeak=Math.max(0,...trendRows.map(row=>row.o));
 const advOpen=S.issMore;
 const advCount=[f.site,f.project,f.maker,f.equip,f.vert,f.aging].filter(v=>v&&v!=="all").length+(f.from?1:0)+(f.to?1:0);
 const hasActiveFilters=advCount>0||!!f.q||!!f.from||!!f.to||!!f.queue||f.chip!=="all"||f.bucket!=="all"||f.status!=="all"||f.sev!=="all"||f.assignee!=="all"||f.plant!=="all"||f.health!=="all";
 const queueLabels={critical:"Critical open issues",overdue:"Overdue non-critical issues",other:"Other open issues"};
 let h='<div class="oi-header row between wrap"><div class="oi-header-copy"><div class="kpi-label">SOLAR OPERATIONS · LIVE REGISTER</div><h1>Site Issues</h1><p>Prioritize field faults, assign ownership, and track resolution across your plants.</p></div><div class="oi-header-actions"><div class="oi-live-summary"><span class="oi-live-dot"></span><div><b>'+openTk(filtered).length+' open</b><small>'+filtered.length+' issues in view</small></div></div><button class="btn p oi-raise-button" onclick="openModal(\'newTicket\')">'+I.plus(14)+' Raise Issue</button></div></div>';
 h+='<div class="kpis8 oi-kpis">'+
  kpiTile("Open",openTk(filtered).length,"in current filter","var(--info)",'data-act="chip" data-id="all"')+
  kpiTile("Critical",openTk(filtered).filter(t=>t.severity==="Critical").length,"click chip","var(--danger)",'data-act="chip" data-id="Critical"')+
  kpiTile("Overdue",openTk(filtered).filter(isOverdueIssue).length,"past ETC","var(--danger)",'data-act="chip" data-id="Overdue"')+
  kpiTile("Unassigned",openTk(filtered).filter(t=>!t.assignee).length,"need owner","var(--warning)",'data-act="chip" data-id="Unassigned"')+
  kpiTile("Resolved",filtered.filter(t=>t.status==="Resolved"||t.status==="Closed").length,"closed loop","var(--success)","")+
  kpiTile("15+ days",filtered.filter(t=>ageBucket(t)==="15+ days"&&openTk([t]).length).length,"aging","var(--danger)","")+
  kpiTile("Today",filtered.filter(t=>issueDay(t)===TODAY).length,"occurred today","var(--foreground)",'data-act="chip" data-id="Today"')+
  kpiTile("Mine",filtered.filter(t=>t.assignee===OM_HEAD).length,OM_HEAD,"var(--info)",'data-act="chip" data-id="Mine"')+'</div>';
 h+=ccFilterBar();
 h+='<div class="panel filter-panel oi-filter-panel" style="padding:12px 14px">'+
  '<div class="oi-quick-filters"><span class="kpi-label">QUICK FILTERS</span>'+chips.map(([id,l])=>'<button class="pill sev-pill'+(f.chip===id?" active":"")+'" data-act="chip" data-id="'+id+'">'+l+'</button>').join("")+'<button class="btn o sm" onclick="S.issF=blankIssF();S.tablePages.issues=1;render()">Clear filters</button></div>'+
  '<div class="row wrap" style="gap:8px;align-items:flex-end">'+
  '<div class="field oi-search-field" style="min-width:230px;flex:2"><span class="lbl">Search issues</span><div class="oi-search"><span aria-hidden="true">⌕</span><input class="inp" aria-label="Search issues" value="'+esc(f.q)+'" placeholder="Ticket, plant, maker, description…" oninput="S.issF.q=this.value;S.tablePages.issues=1;renderSoon()"/></div></div>'+
  '<div class="field"><span class="lbl">Plant</span>'+sel("plant",[["all","All plants"]].concat(S.plants.map(p=>[p.name,p.name])))+'</div>'+
  '<div class="field"><span class="lbl">Priority</span>'+sel("sev",[["all","All priority"]].concat(SEV.map(s=>[s,s])))+'</div>'+
  '<div class="field"><span class="lbl">Status</span>'+sel("status",[["all","All statuses"]].concat(STAT.map(s=>[s,s])))+'</div>'+
  '<div class="field"><span class="lbl">Assignee</span>'+sel("assignee",[["all","All assignees"],["Unassigned","Unassigned"]].concat(people.map(s=>[s,s])))+'</div>'+
  '<button class="btn o sm" style="margin-bottom:1px" onclick="S.issMore=!S.issMore;render()">'+(advOpen?"Hide extra filters":"More filters"+(advCount?" ("+advCount+")":""))+' '+I.chev(12)+'</button>'+
  '</div>'+
  (advOpen?'<div class="row wrap" style="gap:8px;align-items:flex-end;margin-top:10px;padding-top:10px;border-top:1px dashed var(--border)">'+
  '<div class="field"><span class="lbl">Site code</span>'+sel("site",[["all","All sites"]].concat(sites.map(s=>[s,s])))+'</div>'+
  '<div class="field"><span class="lbl">Project</span>'+sel("project",[["all","All projects"]].concat(projs.map(s=>[s,s])))+'</div>'+
  (makers.length?'<div class="field"><span class="lbl">Maker</span>'+sel("maker",[["all","All makers"]].concat(makers.map(s=>[s,s])))+'</div>':'')+
  (equips.length?'<div class="field"><span class="lbl">Equipment</span>'+sel("equip",[["all","All equipment"]].concat(equips.map(s=>[s,s])))+'</div>':'')+
  '<div class="field"><span class="lbl">Issue type</span>'+sel("vert",[["all","All types"]].concat(VERTICALS.map(v=>[v,v])))+'</div>'+
  '<div class="field"><span class="lbl">Aging</span>'+sel("aging",[["all","All aging"]].concat(AGES.map(s=>[s,s])))+'</div>'+
  '<div class="field"><span class="lbl">Occurred from</span><input type="date" class="inp" style="width:145px" value="'+esc(f.from)+'" onchange="S.issF.from=this.value;S.tablePages.issues=1;render()"/></div>'+
  '<div class="field"><span class="lbl">to</span><input type="date" class="inp" style="width:145px" value="'+esc(f.to)+'" onchange="S.issF.to=this.value;S.tablePages.issues=1;render()"/></div>'+
  '</div>':'')+
  '</div>';
 /* Triage queue: urgent site-engineer issues that still need an owner (frontend only; same ticket data as the Assign dialog) */
 if(scheduledAdmin()){
  const need=openTk(S.issues).filter(t=>!t.assignee).sort((a,b)=>(SEV_RANK[a.severity]??9)-(SEV_RANK[b.severity]??9)||String(a.created).localeCompare(String(b.created)));
  if(need.length){
   const crit=need.filter(t=>t.severity==="Critical").length;
   const ago=t=>{const hrs=Math.max(0,(new Date(NOW_ISO)-new Date(t.created))/36e5);return hrs<1?"just now":hrs<24?Math.round(hrs)+"h ago":Math.round(hrs/24)+"d ago"};
   const opts='<option value="">Assign to…</option>'+(typeof assigneeOptionsHtml==="function"?assigneeOptionsHtml():people.map(x=>'<option>'+esc(x)+'</option>').join(""));
   h+='<div class="panel oi-triage"><div class="row between wrap" style="gap:8px;margin-bottom:8px"><div><div class="kpi-label">NEEDS ASSIGNMENT</div><h2 style="font-size:15px;font-weight:700">Triage queue — '+need.length+' issue'+(need.length>1?'s':'')+' waiting for an owner</h2></div>'
    +(crit?'<span class="pill pillsm b-danger">'+crit+' critical</span>':'')+'</div>'
    +need.slice(0,6).map(t=>{const sla=slaState(t),pl=plantRec(t.plant);
     return '<div class="oi-tri-row" style="border-left-color:'+(priorityColors[t.severity]||"#ccc")+'"><div class="oi-tri-main" data-act="issue" data-id="'+esc(t.id)+'" title="Open issue"><div><b>'+esc(t.id)+'</b> '+badge(t.severity)+(sla==="breach"?' '+badge("Overdue"):'')+'</div>'
      +'<div class="oi-tri-meta">'+esc(t.plant||"—")+(t.equip&&t.equip!=="—"?' · '+esc(t.equip):'')+' · '+esc(t.vertical||"")+' · raised '+ago(t)+((etcInfo(t)||{}).txt?' · <b class="oi-etc-i '+etcInfo(t).cls+'">'+esc(etcInfo(t).txt)+'</b>':'')+'</div>'
      +(t.desc?'<div class="oi-tri-desc">'+esc(String(t.desc).slice(0,110))+(String(t.desc).length>110?'…':'')+'</div>':'')+'</div>'
      +'<div class="oi-tri-assign" onclick="event.stopPropagation()"><select class="sel" id="oi-qa-'+esc(t.id)+'">'+opts+'</select><button class="btn p sm" onclick="oiQuickAssign(\''+esc(t.id)+'\')">Assign</button></div></div>'}).join("")
    +(need.length>6?'<div class="oi-tri-more"><button class="btn g sm" data-act="chip" data-id="Unassigned">+ '+(need.length-6)+' more — view all unassigned</button></div>':'')+'</div>';
  }
 }
 const oiChip=(act,id,label,n,color)=>'<button type="button" class="oi-sum-chip'+(ccDonutOn(act,id)?' on':'')+'" data-act="'+act+'" data-id="'+esc(id)+'" title="'+esc(label+": "+n+" · click to filter")+'"><i style="background:'+color+'"></i>'+esc(label)+'<b>'+n+'</b></button>';
 if(filtered.length){
  h+='<div class="panel oi-summary" style="padding:10px 14px">'
   +'<div class="oi-sum-group"><span class="kpi-label">PRIORITY</span>'+prioritySlices.map(x=>oiChip("issSev",x.id,x.label,x.n,x.color)).join("")+'</div>'
   +'<div class="oi-sum-group"><span class="kpi-label">STATUS</span>'+statusSlices.map(x=>oiChip("donutStatus",x.id,x.label,x.n,x.color)).join("")+'</div>'
   +(ageRows.length?'<div class="oi-sum-group"><span class="kpi-label">OPEN AGE</span>'+ageRows.map(x=>oiChip("issAge",x.label,x.label,x.n,ageColors[x.label])).join("")+'</div>':'')
   +'</div>';
 }
 h+='<div class="panel oi-trend-panel"><div class="oi-trend-head"><div><div class="kpi-label">HISTORICAL MONITORING</div><h2>O&amp;M issue trend</h2><p>Created, resolved and open backlog from the current issue dataset.</p></div><div class="oi-trend-period" role="group" aria-label="Trend period">'+[[3,"3d"],[10,"10d"],[14,"2w"],[21,"3w"],[30,"Month"]].map(([n,l])=>'<button type="button" class="'+(days===n?"active":"")+'" aria-pressed="'+(days===n)+'" onclick="setTrendDays('+n+')">'+l+'</button>').join("")+'</div></div><div class="oi-trend-content"><div class="oi-trend-summary"><div><span>Total created</span><b>'+trendTotal+'</b></div><div><span>Average / day</span><b>'+trendAverage+'</b></div><div><span>Peak day</span><b>'+trendPeak+'</b></div></div>'+issueSpark(trendRows)+'</div></div>';
 h+='<div id="section-results" class="panel no-stick" style="padding:0">';
 if(f.queue&&queueLabels[f.queue])h+='<div class="cc-drill-filter"><span>Command Center filter: <b>'+queueLabels[f.queue]+'</b>'+(f.equip&&f.equip!=="all"?' · '+esc(equipmentFilterLabel(f.equip)):"")+'</span><button class="btn o sm" onclick="delete S.issF.queue;S.tablePages.issues=1;render()">Clear drill-down</button></div>';
 h+='<div style="overflow-x:auto"><table class="dense"><thead><tr><th>Issue</th><th>Plant / site</th><th>Equipment / maker</th><th>Type</th><th>Priority</th><th>Age</th><th>Assignee</th><th>Status</th><th>Action</th></tr></thead><tbody>';
 if(!issueRows.length)h+='<tr><td colspan="9"><div class="oi-empty-state"><span aria-hidden="true">⌕</span><div><b>No issues found</b><p>There are no site issues matching the current filters.</p></div>'+(hasActiveFilters?'<button class="btn o sm" onclick="S.issF=blankIssF();S.tablePages.issues=1;render()">Clear filters</button>':'')+'</div></td></tr>';
 issueRows.forEach(t=>{const p=plantRec(t.plant),sla=slaState(t);
  const age=issueAgeDays(t),ageClass=age>14?"old":age>7?"aging":"fresh";
  h+='<tr class="click oi-issue-row oi-priority-'+esc(t.severity||"other").toLowerCase()+' '+(S.flashId===t.id?' flash-new':'')+'" data-rid="'+esc(t.id)+'" data-act="issue" data-id="'+esc(t.id)+'"><td class="oi-ticket-cell" style="border-left:3px solid '+(priorityColors[t.severity]||"#ccc")+'"><b>'+esc(t.id)+'</b></td>'+
  '<td><div style="font-weight:500">'+esc(p?p.id:t.plant)+'</div><div style="font-size:10.5px;color:var(--muted-foreground)">'+esc(p?p.name:"")+'</div></td>'+
  '<td>'+esc(t.equip||"—")+(t.maker?'<div style="font-size:10.5px;color:var(--muted-foreground)">'+esc(t.maker)+'</div>':'')+'</td>'+
  '<td>'+esc(t.vertical)+'</td><td class="oi-priority-cell">'+badge(t.severity)+'</td><td class="nowrap"><span class="oi-age '+ageClass+'">'+age+'d</span><small class="oi-age-bucket">'+esc(ageBucket(t))+'</small></td>'+
  '<td>'+(t.assignee?'<span class="oi-assignee"><i aria-hidden="true">'+esc(ccIni(t.assignee))+'</i><span data-act="workWho" data-id="'+esc(t.assignee)+'">'+esc(t.assignee)+'</span></span>':'<span class="oi-unassigned">Unassigned</span>')+'</td>'+
  '<td>'+badge(t.status)+(sla==="breach"?" "+badge("Overdue"):"")+etcLabel(t)+'</td><td class="oi-action-cell"><div class="oi-row-actions">'+issueQuickActs(t)+'</div></td></tr>';});
 h+='</tbody></table></div>'+tablePager("issues",filtered.length,LIST_SIZE)+'</div>';
 return h;
}

(function(){
 const st=document.createElement("style");
 st.textContent=
  ".cc-line{stroke-dasharray:1600;stroke-dashoffset:1600;animation:ccDraw 1s ease forwards}"+
  "@keyframes ccDraw{to{stroke-dashoffset:0}}"+
  ".cc-area{animation:ccFade .8s ease .35s both}"+
  "@keyframes ccFade{from{opacity:0}}"+
  ".line-chart-wrap svg{overflow:visible}"+
  ".donut-seg2{cursor:pointer;transition:opacity .22s,stroke-width .18s}"+
  ".donut-seg2:hover{stroke-width:20}"+
  "svg.has-sel2 circle.donut-seg2:not(.sel){opacity:.22}"+
  ".viz-donut svg{filter:drop-shadow(0 10px 18px rgba(16,24,20,.12))}"+
  ".viz-bar-track{background:repeating-linear-gradient(115deg,#E9EEEA 0 5px,#F1F5F2 5px 10px)}"+
  ".viz-bar-track i{border-radius:99px;transform-origin:left center;animation:ccBar .7s ease}"+
  "@keyframes ccBar{from{transform:scaleX(0)}}";
 document.head.appendChild(st);
})();

/* ── smooth-curve helper (Catmull-Rom → bezier) ── */
function ccSmooth(pts){
 if(pts.length<3)return "M "+pts.map(p=>p[0].toFixed(1)+" "+p[1].toFixed(1)).join(" L ");
 let d="M "+pts[0][0].toFixed(1)+" "+pts[0][1].toFixed(1);
 for(let i=0;i<pts.length-1;i++){
  const p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];
  d+=" C "+(p1[0]+(p2[0]-p0[0])/6).toFixed(1)+" "+(p1[1]+(p2[1]-p0[1])/6).toFixed(1)+" "+(p2[0]-(p3[0]-p1[0])/6).toFixed(1)+" "+(p2[1]-(p3[1]-p1[1])/6).toFixed(1)+" "+p2[0].toFixed(1)+" "+p2[1].toFixed(1);
 }
 return d;
}

/* ── TREND CHART v2 — smooth curves, gradient area, self-drawing lines ── */
function issueSpark(rows){
 if(!rows.length)return emptyState("No issue trend","Raise issues to see created vs resolved over time.");
 const w=720,h=180,left=30,right=10,top=14,bottom=26,n=rows.length,max=Math.max(1,...rows.flatMap(r=>[r.o,r.c,r.open||0]))*1.15;
 const x=i=>left+i*((w-left-right)/Math.max(1,n-1)),y=v=>h-bottom-(v/max)*(h-top-bottom);
 const P=k=>rows.map((r,i)=>[x(i),y(r[k]||0)]);
 const po=P("open"),openPath=ccSmooth(po);
 const area=openPath+" L "+x(n-1).toFixed(1)+" "+(h-bottom)+" L "+left+" "+(h-bottom)+" Z";
 let grid="";[0,.25,.5,.75,1].forEach(f=>{const v=Math.round(max*f),yy=y(v).toFixed(1);
  grid+='<line x1="'+left+'" x2="'+(w-right)+'" y1="'+yy+'" y2="'+yy+'" stroke="#E2E9E4" stroke-dasharray="3 4"/>'+(f>0?'<text x="'+(left-5)+'" y="'+(+yy+3)+'" text-anchor="end" font-size="8.5" fill="#8A968F">'+v+'</text>':'')});
 const labels=rows.map((r,i)=>!(i%(Math.ceil(n/8)||1))?'<text x="'+x(i).toFixed(1)+'" y="'+(h-7)+'" text-anchor="middle" font-size="8.5" fill="#8A968F">'+(n>14?r.d.slice(8):r.d.slice(5))+'</text>':"").join("");
 const dots=k=>rows.map((r,i)=>'<circle cx="'+x(i).toFixed(1)+'" cy="'+y(r[k]||0).toFixed(1)+'" r="2.6" fill="'+({o:"#DC4C3E",c:"#16A34A",open:"#3B82F6"}[k])+'" stroke="#fff" stroke-width="1.2"/>').join("");
 const hits=rows.map((r,i)=>{const bw=(w-left-right)/Math.max(1,n-1);
  return '<rect class="hit chart-hit" data-act="trendDay" data-id="'+r.d+'" x="'+(x(i)-bw/2).toFixed(1)+'" y="0" width="'+bw.toFixed(1)+'" height="'+h+'" data-tip="'+esc(r.d+"\nCreated "+r.o+"\nResolved "+r.c+"\nOpen "+(r.open||0)+"\nClick to focus this date")+'"/>'}).join("");
 return '<div class="line-chart-wrap"><svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none"><defs><linearGradient id="ccOpenFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#3B82F6" stop-opacity=".22"/><stop offset="100%" stop-color="#3B82F6" stop-opacity=".02"/></linearGradient></defs>'+grid+
  '<path class="cc-area" d="'+area+'" fill="url(#ccOpenFill)"/>'+
  '<path class="cc-line" d="'+openPath+'" fill="none" stroke="#3B82F6" stroke-width="2.2"/>'+
  '<path class="cc-line" d="'+ccSmooth(P("o"))+'" fill="none" stroke="#DC4C3E" stroke-width="2.4"/>'+
  '<path class="cc-line" d="'+ccSmooth(P("c"))+'" fill="none" stroke="#16A34A" stroke-width="2.4"/>'+
  dots("o")+dots("c")+labels+hits+'</svg>'+
  '<div class="row" style="gap:14px;justify-content:flex-end;font-size:11px;color:var(--muted-foreground);margin-top:6px"><span class="row" style="gap:5px"><span class="dot" style="width:8px;height:8px;background:#DC4C3E"></span>Created</span><span class="row" style="gap:5px"><span class="dot" style="width:8px;height:8px;background:#16A34A"></span>Resolved</span><span class="row" style="gap:5px"><span class="dot" style="width:8px;height:8px;background:#3B82F6"></span>Open backlog</span><span class="muted">click a day to focus</span></div></div>';
}

/* ── DONUT v2 — rounded segments with gaps (every view) ── */
function vizDonut(title,slices,opts){
 opts=opts||{};
 const total=slices.reduce((s,x)=>s+(x.n||0),0),cx=88,cy=88,r=64,wd=15,C=2*Math.PI*r;
 let h='<div><h2 style="font-size:14px;font-weight:700">'+title+'</h2><p style="font-size:11.5px;color:var(--muted-foreground);margin:3px 0 12px">'+(opts.note||"Click a segment to filter")+'</p>';
 if(!total)return h+emptyState(opts.empty||"No records","Nothing to chart in the current filter.")+'</div>';
 const anySel=slices.some(s=>s.n&&s.act&&ccDonutOn(s.act,s.id));
 let acc=0,circ="";
 slices.forEach(s=>{if(!s.n)return;
  const full=s.n/total*C,on=s.act&&ccDonutOn(s.act,s.id),len=Math.max(full-4,4);
  const act=s.act?' data-act="'+s.act+'" data-id="'+esc(s.id||s.label)+'"':"";
  circ+='<circle class="donut-seg2'+(on?" sel":"")+'" cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="'+s.color+'" stroke-width="'+(on?wd+3:wd)+'" stroke-linecap="round" stroke-dasharray="'+len.toFixed(2)+' '+(C-len).toFixed(2)+'" stroke-dashoffset="'+(-acc).toFixed(2)+'"'+act+' data-tip="'+esc(s.label+": "+s.n+" ("+Math.round(s.n/total*100)+"%) — click to filter")+'"/>';
  acc+=full;});
 return h+'<div class="viz-donut"><div class="viz-ring-wrap"><svg viewBox="0 0 176 176" class="'+(anySel?"has-sel2":"")+'" style="transform:rotate(-90deg)">'+circ+'</svg><div class="viz-ring-hole"><b>'+total+'</b><span>'+esc(opts.center||"total")+(ccFilterActive()?' · filtered':'')+'</span></div></div><div class="viz-legend">'+
  slices.map(s=>{const on=s.act&&ccDonutOn(s.act,s.id);
   return '<div class="viz-leg'+(on?" on":"")+'" '+(s.act?'data-act="'+s.act+'" data-id="'+esc(s.id||s.label)+'"':'')+' data-tip="'+esc(s.label+": "+s.n+(total?" ("+Math.round(s.n/total*100)+"%)":""))+'"><span class="dot" style="width:8px;height:8px;background:'+s.color+'"></span><span>'+esc(s.label)+'</span><b>'+s.n+'</b>'+(total?'<span class="pct">'+Math.round(s.n/total*100)+'%</span>':'')+'</div>'}).join("")+'</div></div></div>';
}

/* ── BARS v2 — gradient fill, striped track, grow-in animation ── */
function rankBars(rows,act,color){
 if(!rows.length)return emptyState("No breakdown","No matching records in the current filter.");
 const mx=Math.max(1,...rows.map(r=>r.n));
 const grad=(color.length===7?color+"AA":color);
 return rows.map(r=>'<div class="viz-bar" data-act="'+act+'" data-id="'+esc(r.id)+'" data-tip="'+esc(r.label+": "+r.n+' — click to filter')+'"><div class="viz-bar-lab" title="'+esc(r.label)+'">'+esc(r.label)+'</div><div class="viz-bar-track"><i style="width:'+Math.max(4,Math.round(100*r.n/mx))+'%;background:linear-gradient(90deg,'+grad+','+color+')"></i></div><b>'+r.n+'</b></div>').join("");
}

(function(){
 const st=document.createElement("style");
 st.textContent=
  ".cc-toasts{position:fixed;right:18px;bottom:18px;z-index:1500;display:flex;flex-direction:column;gap:10px;width:min(360px,calc(100vw - 36px));pointer-events:none}"+
  ".cc-toast{pointer-events:auto;position:relative;overflow:hidden;display:flex;gap:11px;align-items:flex-start;background:#fff;border:1px solid var(--border);border-radius:14px;padding:12px 14px 14px;box-shadow:0 14px 38px rgba(16,24,20,.20);animation:ccTIn .38s cubic-bezier(.21,1.02,.55,1.18);cursor:default}"+
  ".cc-toast.clk{cursor:pointer}"+
  ".cc-toast:hover{border-color:var(--primary)}"+
  ".cc-toast.out{animation:ccTOut .3s ease forwards}"+
  "@keyframes ccTIn{from{transform:translateX(115%);opacity:0}}"+
  "@keyframes ccTOut{to{transform:translateX(115%);opacity:0}}"+
  ".cc-toast .tico{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;flex-shrink:0}"+
  ".cc-toast .tc{min-width:0;flex:1;padding-right:4px}"+
  ".cc-toast .tt{font-size:12.5px;font-weight:700;line-height:1.3}"+
  ".cc-toast .tm{font-size:11.5px;color:var(--muted-foreground);margin-top:2px;line-height:1.45;word-wrap:break-word}"+
  ".cc-toast .tts{font-size:10px;color:var(--muted-foreground);margin-top:5px}"+
  ".cc-toast .tts b{color:var(--primary)}"+
  ".cc-toast .tx{border:0;background:none;color:var(--muted-foreground);cursor:pointer;font-size:15px;line-height:1;padding:2px 0 0 6px;flex-shrink:0}"+
  ".cc-toast .tx:hover{color:var(--danger)}"+
  ".cc-toast .tbar{position:absolute;left:0;bottom:0;height:3px;border-radius:0 3px 3px 0;animation:ccTBar 4.5s linear forwards}"+
  "@keyframes ccTBar{from{width:100%}to{width:0}}"+
  ".cc-toast.s{border-left:4px solid var(--success)}.cc-toast.s .tico{background:var(--success-soft);color:var(--success)}.cc-toast.s .tbar{background:var(--success)}"+
  ".cc-toast.d{border-left:4px solid var(--danger)}.cc-toast.d .tico{background:var(--danger-soft);color:var(--danger)}.cc-toast.d .tbar{background:var(--danger)}"+
  ".cc-toast.w{border-left:4px solid var(--warning)}.cc-toast.w .tico{background:var(--warning-soft);color:var(--warning-strong)}.cc-toast.w .tbar{background:var(--warning)}"+
  ".cc-toast.i{border-left:4px solid var(--info)}.cc-toast.i .tico{background:var(--info-soft);color:var(--info)}.cc-toast.i .tbar{background:var(--info)}"+
  "@media(max-width:640px){.cc-toasts{right:12px;left:12px;bottom:12px;width:auto}}";
 document.head.appendChild(st);
})();

const CC_TT=4500;
var _ccLastRich={t:0,id:""};
function ccToastBox(){let b=document.getElementById("cc-toasts");if(!b){b=document.createElement("div");b.id="cc-toasts";b.className="cc-toasts";document.body.appendChild(b);}return b;}
function ccNow(){const d=new Date();return pad2(d.getHours())+":"+pad2(d.getMinutes())}
function ccPopup(title,meta,tone,open){
   function toast(m){
  const s=String(m||"");
  const mid=(s.match(/[A-Z]{2,4}-\d{2,}/g)||[])[0];
  if(mid&&_ccLastRich.id===mid&&(Date.now()-_ccLastRich.t)<1600)return;
  const tone=/required|invalid|failed|error|short|blocked|no valid|nothing/i.test(s)?"w":"i";
  const i=s.indexOf("—");
  if(i>2)ccPopup(s.slice(0,i).trim(),s.slice(i+1).trim(),tone,null);
  else ccPopup(s,"",tone,null);
}
 const box=ccToastBox();
 while(box.children.length>=4)box.firstChild.remove();
 const el=document.createElement("div");
 el.className="cc-toast "+(tone||"i")+(open?" clk":"");
 const ic={s:I.check(16),d:I.alert(16),w:I.alert(16),i:I.bell(16)}[tone||"i"];
 el.innerHTML='<span class="tico">'+ic+'</span><div class="tc"><div class="tt">'+esc(title)+'</div>'+
  (meta?'<div class="tm">'+esc(meta)+'</div>':'')+
  '<div class="tts">'+ccNow()+(open?' · <b>click to open</b>':'')+'</div></div>'+
  '<button class="tx" title="Dismiss">×</button><span class="tbar"></span>';
 let tmr=setTimeout(kill,CC_TT);
 function kill(){clearTimeout(tmr);if(!el.parentNode)return;el.classList.add("out");setTimeout(()=>el.remove(),320)}
 el.querySelector(".tx").addEventListener("click",e=>{e.stopPropagation();kill()});
 if(open)el.addEventListener("click",()=>{kill();try{open()}catch(err){}});
 el.addEventListener("mouseenter",()=>{clearTimeout(tmr);const b=el.querySelector(".tbar");if(b)b.style.animationPlayState="paused"});
 el.addEventListener("mouseleave",()=>{const b=el.querySelector(".tbar");if(b)b.style.animationPlayState="running";tmr=setTimeout(kill,1800)});
 box.appendChild(el);
}


(function(){
 if(window._ccbr)return;window._ccbr=true;
 S._ccSeen={};
 function check(){
  if(document.hidden)return;
  const br=(S.issues||[]).filter(t=>slaState(t)==="breach");
  const fresh=br.filter(t=>!S._ccSeen[t.id]);
  br.forEach(t=>{S._ccSeen[t.id]=1});
  if(!fresh.length)return;
  fresh.slice(0,3).forEach(t=>ccPopup("Overdue — "+t.id,(t.plant||"")+" · "+t.vertical+" · past committed ETC · "+(t.assignee||"unassigned"),"d",()=>openIssue(t.id)));
  if(fresh.length>3)ccPopup("+"+(fresh.length-3)+" more overdue issues","Open Needs Attention on the Command Center","d",null);
 }
 setTimeout(check,1500);
 setInterval(check,45000);
})();


function renderWork(){
 const who=S.workWho;
 const loads=engineerLoad();
 const src=who?(S.issues||[]).filter(t=>t.assignee===who):(S.issues||[]);
 const open=openTk(src),overdue=open.filter(isOverdueIssue),resolved=src.filter(t=>t.status==="Resolved"||t.status==="Closed");
 const assigned=open.length;
 const openTasks=who?(S.tasks||[]).filter(t=>t.assignee===who&&t.status!=="Completed"):[];
 const tvs=t=>t.status==="Completed"?"Completed":taskOD(t)>0?"Overdue":t.status;
 let h='<div><h1 style="font-size:20px;font-weight:800">Work / Assignments</h1><p style="font-size:12.5px;color:var(--muted-foreground);margin:4px 0 12px">Engineer load from live issues and Preventive Maintenance work. Click a name to see only their work.</p></div>';
 if(who)h+='<div class="ccbar" style="margin-bottom:2px"><span class="kpi-label" style="flex:0 0 auto">VIEWING</span>'+
  '<span class="pill pillsm gf-chip">Engineer: <b>'+esc(who)+'</b><button type="button" onclick="S.workWho=null;render()" title="Back to all engineers" style="border:0;background:none;color:inherit;cursor:pointer;font-size:13px;padding:0 0 0 5px">×</button></span>'+
  '<button class="btn o sm" onclick="S.workWho=null;render()">← All engineers</button></div>';
 h+='<div class="kpis4">'+
  kpiTile("Assigned",assigned,who?"open issues · "+esc(who):"open owned work","var(--info)","")+
  kpiTile("Overdue",overdue.length,who?(overdue.length?"past ETC · "+esc(who):"none overdue — "+esc(who)):"past committed ETC","var(--danger)","")+
  kpiTile("Resolved",resolved.length,who?"closed by "+esc(who):"closed by engineers","var(--success)","")+
  kpiTile(who?"Open tasks":"Engineers",who?openTasks.length:loads.length,who?"preventive maintenance assigned":"in the pool","var(--foreground)","")+'</div>';
 const mix=[{label:"Active",id:"active",n:assigned,color:"#3B82F6",act:""},{label:"Overdue",id:"overdue",n:overdue.length,color:"#DC4C3E",act:""},{label:"Resolved",id:"resolved",n:resolved.length,color:"#16A34A",act:""}];
 if(!who){
  const loadBars=loads.filter(r=>r.assigned||r.overdue).map(r=>({label:r.name,id:r.name,n:r.assigned}));
  h+='<div class="kgrid" style="grid-template-columns:1.1fr .9fr;align-items:stretch"><div class="panel"><h2 style="font-size:14px;font-weight:700">Engineer workload</h2><p style="font-size:11.5px;color:var(--muted-foreground);margin:3px 0 10px">Open assigned issues · click a bar to open that engineer only</p>'+rankBars(loadBars,"workWho","#0F9F8C")+'</div><div class="panel">'+vizDonut("Overdue vs active",mix,{center:"tickets",note:"Assigned open work vs overdue vs resolved",empty:"No assigned work yet"})+'</div></div>';
 }else{
  h+='<div class="panel" style="max-width:420px">'+vizDonut("Overdue vs active",mix,{center:"tickets",note:"Only "+esc(who)+" — issues assigned to this engineer",empty:"No assigned work for this engineer"})+'</div>';
 }
 h+='<div class="panel"><div class="row between wrap" style="margin-bottom:8px"><h2 style="font-size:15px;font-weight:700">Resolution trend'+(who?" — "+esc(who):"")+'</h2></div>'+issueSpark(issueTrendRows(S.trendDays||21,src))+'</div>';
 if(!who){
  h+='<div class="panel no-stick" style="padding:0"><table class="dense"><thead><tr><th>Engineer</th><th>Assigned</th><th>Critical</th><th>Overdue</th><th>In progress</th><th>Resolved</th></tr></thead><tbody>'+
   (loads.length?loads.map(r=>'<tr class="click" data-act="workWho" data-id="'+esc(r.name)+'"><td style="font-weight:600">'+esc(r.name)+'</td><td>'+r.assigned+'</td><td>'+(r.critical?badge(String(r.critical)):"0")+'</td><td>'+(r.overdue?'<b style="color:var(--danger)">'+r.overdue+'</b>':"0")+'</td><td>'+r.progress+'</td><td>'+r.resolved+'</td></tr>').join(""):'<tr><td colspan="6">'+emptyState("No engineers with workload","Assign issues to populate this view.")+'</td></tr>')+'</tbody></table></div>';
 }else{
  /* person detail — ISSUES */
  const mode=S.workIssueMode||"open";
  let rows=src.slice();
  if(mode==="open")rows=openTk(rows);
  rows.sort((a,b)=>(SEV_RANK[a.severity]??9)-(SEV_RANK[b.severity]??9)||issueAgeDays(b)-issueAgeDays(a));
  h+='<div class="panel no-stick" style="padding:0"><div style="padding:14px 16px 0"><div class="row between wrap" style="gap:10px"><div><h2 style="font-size:15px;font-weight:700">'+esc(who)+' — issue tickets</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 10px">Reassign, open the ticket or jump to the plant from each row</p></div>'+
   '<div class="row wrap" style="gap:6px">'+[["open","Open ("+open.length+")"],["all","All ("+src.length+")"]].map(([id,l])=>'<button class="pill sev-pill'+(mode===id?" active":"")+'" onclick="S.workIssueMode=\''+id+'\';render()">'+l+'</button>').join("")+'</div></div></div>';
  if(rows.length)h+='<div style="overflow-x:auto"><table class="dense"><thead><tr><th>Issue</th><th>Plant</th><th>Priority</th><th>Status</th><th>Age</th><th>Action</th></tr></thead><tbody>'+
   rows.map(t=>{const sla=slaState(t);
    return '<tr class="click" data-act="issue" data-id="'+esc(t.id)+'"><td style="font-weight:600">'+esc(t.id)+'<div style="font-size:10.5px;color:var(--muted-foreground)">'+esc(t.vertical)+'</div></td><td>'+esc(t.plant)+'</td><td>'+badge(t.severity)+'</td><td>'+badge(t.status)+(sla==="breach"?" "+badge("Overdue"):"")+'</td><td class="nowrap" style="'+(sla==="breach"?"color:var(--danger);font-weight:700":"")+'">'+esc(ageBucket(t))+'</td><td>'+issueQuickActs(t)+'</td></tr>'}).join("")+'</tbody></table></div>';
  else h+=emptyState("No "+(mode==="open"?"open ":"")+"issues for this engineer","Switch to All, or assign work from the issue register.");
  h+='</div>';
  /* person detail — SCHEDULED TASKS */
  const tasks=(S.tasks||[]).filter(t=>t.assignee===who);
  h+='<div class="panel no-stick" style="padding:0"><div style="padding:14px 16px 0"><h2 style="font-size:15px;font-weight:700">Preventive Maintenance tasks — '+esc(who)+'</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 10px">Start, complete or reassign directly from here</p></div>';
  if(tasks.length)h+='<div style="overflow-x:auto"><table class="dense"><thead><tr><th>Task</th><th>Plant / equipment</th><th>Due</th><th>Status</th><th>Actions</th></tr></thead><tbody>'+
   tasks.map(t=>{const od=taskOD(t);
    let a='<div class="row" style="gap:4px;flex-wrap:wrap" onclick="event.stopPropagation()">';
    if(t.status==="Scheduled")a+='<button class="btn o sm" onclick="startTask(\''+t.id+'\')">Start</button>';
    if(t.status==="In Progress")a+='<button class="btn p sm" onclick="openModal(\'complete\',{id:\''+t.id+'\'})">Complete</button>';
    a+='<button class="btn g sm" onclick="openModal(\'reassignTask\',{id:\''+t.id+'\'})">Reassign</button></div>';
    return '<tr class="click" onclick="if(!event.target.closest(\'button\'))openModal(\'taskDetail\',{id:\''+t.id+'\'})"><td style="font-weight:500;min-width:180px">'+esc(t.name)+'<div style="font-size:10.5px;color:var(--muted-foreground)">'+esc(t.type)+' · '+t.freq+'</div></td>'+
    '<td><div>'+esc(t.plant)+'</div><div style="font-size:10.5px;color:var(--muted-foreground)">'+esc(t.equip)+'</div></td>'+
    '<td class="nowrap">'+fmtD(t.due)+(od>0?'<div class="flag" style="color:var(--danger)">overdue '+od+'d</div>':'')+'</td>'+
    '<td>'+badge(tvs(t))+'</td><td>'+a+'</td></tr>'}).join("")+'</tbody></table></div>';
  else h+=emptyState("No Preventive Maintenance tasks for this engineer","Tasks assigned to "+esc(who)+" appear here.");
  h+='</div>';
 }
 return h;
}

/* PERFORMANCE — clicking an engineer now filters THIS page */
function renderPerformance(){
 const who=S.perfWho||null;
 const src=who?(S.issues||[]).filter(t=>t.assignee===who):(S.issues||[]);
 const days=S.trendDays||30,open=openTk(src);
 const plants=S.plants.map(p=>({p,n:open.filter(t=>t.plant===p.name).length})).filter(x=>x.n).sort((a,b)=>b.n-a.n).slice(0,10);
 const eq={};src.forEach(t=>{const k=t.equip||"—";eq[k]=(eq[k]||0)+1});
 const mk={};src.forEach(t=>{if(t.maker)mk[t.maker]=(mk[t.maker]||0)+1});
 const loads=engineerLoad().slice(0,8);
 let h='<div class="ops-page ops-performance"><div class="ops-page-head"><div><div class="kpi-label">SOLAR OPERATIONS · LIVE METRICS</div><h1>Performance</h1><p>Explore issue resolution, plant fault frequency and team workload using live operational data.</p></div><span class="ops-page-status"><i></i>Live issue data</span></div>';
 h+='<div class="ops-performance-metrics"><div><span>Issues tracked</span><b>'+src.length+'</b></div><div><span>Open</span><b>'+open.length+'</b></div><div><span>Critical open</span><b>'+open.filter(t=>t.severity==="Critical").length+'</b></div><div><span>Overdue</span><b>'+open.filter(isOverdueIssue).length+'</b></div></div>';
 if(who)h+='<div class="ccbar" style="margin-bottom:2px"><span class="kpi-label" style="flex:0 0 auto">VIEWING</span>'+
  '<span class="pill pillsm gf-chip">Engineer: <b>'+esc(who)+'</b><button type="button" onclick="S.perfWho=null;render()" title="Clear" style="border:0;background:none;color:inherit;cursor:pointer;font-size:13px;padding:0 0 0 5px">×</button></span>'+
  '<button class="btn o sm" onclick="S.perfWho=null;render()">← All engineers</button></div>';
 h+='<div class="panel ops-performance-trend"><div class="row between wrap"><div><div class="kpi-label">RESOLUTION ACTIVITY</div><h2>Issue &amp; resolution trend'+(who?" — "+esc(who):"")+'</h2></div><div class="row wrap" style="gap:6px">'+[[10,"10d"],[14,"2w"],[21,"3w"],[30,"Month"]].map(([n,l])=>'<button class="pill sev-pill'+(days===n?" active":"")+'" onclick="setTrendDays('+n+')">'+l+'</button>').join("")+'</div></div>'+issueSpark(issueTrendRows(days,src))+'</div>';
 h+='<div class="kgrid ops-performance-grid" style="grid-template-columns:1fr 1fr 1fr"><div class="panel ops-performance-panel"><div class="ops-section-head"><div><div class="kpi-label">PLANT HEALTH SIGNAL</div><h2>Plant issue frequency</h2></div><span class="ops-section-count">'+plants.length+' plants</span></div>'+(plants.length?plants.map(x=>'<div class="kpi-click ops-rank-row" data-act="issuesPlant" data-id="'+esc(x.p.name)+'" style="margin:8px 0"><div class="row between" style="font-size:12px"><span>'+esc(x.p.name)+'</span><b>'+x.n+'</b></div><span class="ops-rank-track"><i style="width:'+Math.max(4,Math.round(x.n/Math.max(1,...plants.map(z=>z.n))*100))+'%"></i></span></div>').join(""):emptyState("No plant issue trend","Raise issues to rank plants."))+'</div>'+
  '<div class="panel ops-performance-panel"><div class="ops-section-head"><div><div class="kpi-label">ASSET SIGNAL</div><h2>Equipment frequency</h2></div><span class="ops-section-count">'+Object.keys(eq).length+' types</span></div>'+(Object.keys(eq).length?Object.entries(eq).sort((a,b)=>b[1]-a[1]).slice(0,10).map(e=>'<div class="row between ops-data-row"><span>'+esc(e[0])+'</span><b>'+e[1]+'</b></div>').join(""):emptyState("No equipment frequency","Equipment is captured on each ticket."))+'</div>'+
  '<div class="panel ops-performance-panel"><div class="ops-section-head"><div><div class="kpi-label">MANUFACTURER SIGNAL</div><h2>Manufacturer frequency</h2></div><span class="ops-section-count">'+Object.keys(mk).length+' makers</span></div>'+(Object.keys(mk).length?Object.entries(mk).sort((a,b)=>b[1]-a[1]).map(e=>'<div class="row between ops-data-row"><span>'+esc(e[0])+'</span><b>'+e[1]+'</b></div>').join(""):emptyState("No manufacturer data","Add maker when raising an issue."))+'</div></div>';
 h+='<div class="panel ops-performance-panel ops-workload-table"><div class="ops-section-head"><div><div class="kpi-label">TEAM CAPACITY</div><h2>Workload</h2><p>Click a row to view that engineer’s performance.</p></div><span class="ops-section-count">'+loads.length+' engineers</span></div>'+(1?'<div class="ops-table-scroll"><table class="dense"><thead><tr><th>Engineer</th><th>Assigned</th><th>Critical</th><th>Overdue</th></tr></thead><tbody>'+
  '<tr class="click" onclick="S.perfWho=null;render()" style="'+(who?"":"background:var(--secondary)")+'"><td style="font-weight:600">All engineers (combined)</td><td>'+openTk(S.issues).length+'</td><td>'+openTk(S.issues).filter(t=>t.severity==="Critical").length+'</td><td>'+openTk(S.issues).filter(isOverdueIssue).length+'</td></tr>'+
  loads.map(r=>'<tr class="click" onclick="S.perfWho=\''+esc(r.name)+'\';render()" style="'+(who===r.name?"background:var(--secondary)":"")+'"><td style="font-weight:600">'+esc(r.name)+'</td><td>'+r.assigned+'</td><td>'+(r.critical||0)+'</td><td>'+(r.overdue?'<b style="color:var(--danger)">'+r.overdue+'</b>':"0")+'</td></tr>').join("")+'</tbody></table></div>':emptyState("No workload trend","Assign work to engineers."))+'</div>';
 h+='<div class="bn-info banner ops-future-note"><b>Future integration</b> — generation, PR, irradiance, inverter efficiency, SCADA and financials will appear here when live telemetry is connected. They are not simulated.</div></div>';
 return h;
}

function ccParseCSV(text){
 const lines=String(text||"").split(/\r?\n/).filter(l=>l.trim());
 if(!lines.length)return{headers:[],rows:[]};
 const split=line=>{const out=[];let cur="",q=false;for(let i=0;i<line.length;i++){const c=line[i];if(q){if(c==='"'){if(line[i+1]==='"'){cur+='"';i++}else q=false}else cur+=c}else{if(c==='"')q=true;else if(c===","){out.push(cur);cur=""}else cur+=c}}out.push(cur);return out.map(x=>x.trim())};
 return{headers:split(lines[0]).map(x=>x.toLowerCase()),rows:lines.slice(1).map(split)};
}
function ccImpSpec(type){
 return{
  plants:{label:"Plants (master data)",cols:["plant","site_code","project","capacity_mW","commissioned_on"],req:[["plant","site_code"],["Plant name or site code is required"]],map:[["plant","name","plant name"],["site_code","site","site code","id"],["project","projectcompany","project company"],["capacity_mW","capacity","capacity (mW)"],["commissioned_on","commissioned","commissioned on"]]},
  issues:{label:"Issue tickets",cols:["plant","issue_type","sub","equipment","maker","severity","description","occurred","assignee","status"],req:[["plant"],["Issues must reference an existing plant name"]],map:[["plant","plant name"],["issue_type","issue type","vertical","type","category"],["sub","subcategory"],["equipment","equip"],["maker","manufacturer"],["severity","priority"],["description","details","desc","issue"],["occurred","occurreddate","occurrence date","date"],["assignee","engineer","owner"],["status"]]},
  tasks:{label:"Preventive Maintenance tasks",cols:["task","plant","type","frequency","assignee","start_date"],req:[["task","name"],["Task name is required"]],map:[["task","name"],["plant"],["type"],["frequency","freq"],["assignee"],["start_date","due","duedate"]]}
 }[type||"plants"];
}
function ccPickFile(input){
 const f=input.files&&input.files[0];if(!f)return;
 const rd=new FileReader();
 rd.onload=()=>{const p=ccParseCSV(rd.result);S.impName=f.name;S.impHeaders=p.headers;S.impRows=p.rows;render();
  toast("Loaded "+f.name+" — "+p.rows.length+" row(s). Review the preview, then press Import.");};
 rd.readAsText(f);
}
function ccTemplate(){
 const t=S.impType||"plants",spec=ccImpSpec(t);
 const csv=spec.cols.join(",")+"\r\n";
 const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}));
 a.download="solar91-"+t+"-template.csv";document.body.appendChild(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(a.href),800);toast("Blank template downloaded — "+a.download);
}
function ccDoImport(){
 const t=S.impType||"plants",rows=S.impRows||[],H=S.impHeaders||[];
 if(!rows.length){toast("Choose a CSV file first.");return}
 const spec=ccImpSpec(t);
 const ix=aliases=>{for(const al of aliases){const i=H.indexOf(al);if(i>=0)return i}return -1};
 const col={};spec.map.forEach(m=>{col[m[0]]=ix(m.slice(1))});
 for(const rq of spec.req){if(ix(rq[0].split("|"))<0&&rq[0].every(a=>H.indexOf(a)<0)){toast("Missing required column: "+rq[0][0]);return}}
 let made=0,skipped=[];
 if(t==="plants"){
  rows.forEach((r,ln)=>{
   const name=col.plant>=0?(r[col.plant]||""):"",site=col.site_code>=0?(r[col.site_code]||""):"";
   if(!name&&!site){skipped.push("row "+(ln+2)+" · no name/site");return}
   const cap=col.capacity_mW>=0?parseFloat(r[col.capacity_mW]):NaN;
   const ex=site?S.plants.find(p=>p.id===site):S.plants.find(p=>p.name===name);
   if(ex){ex.name=name||ex.name;if(Number.isFinite(cap))ex.capacity=cap;if(col.project>=0&&r[col.project])ex.project=r[col.project];made++;}
   else{S.plants.push({id:site||uid("PLT"),name:name||site,capacity:Number.isFinite(cap)?cap:null,status:null,generation:null,genDate:null,availability:null,pr:null,alarms:null,source:"handover",project:col.project>=0?(r[col.project]||""):"",location:col.project>=0?(r[col.project]||""):""});made++;}
  });
 }
 if(t==="issues"){
  if(col.plant<0){toast("Could not find a plant column — issue rows must reference an existing plant.");return}
  rows.forEach((r,ln)=>{
   const pname=col.plant>=0?(r[col.plant]||""):"";
   if(!pname){skipped.push("row "+(ln+2)+" · no plant");return}
   if(!plantRec(pname)){skipped.push("row "+(ln+2)+" · unknown plant \""+pname+"\"");return}
   const rawSev=col.severity>=0?r[col.severity]:"Medium";
   const sev=SEV.includes(rawSev)?rawSev:"Medium";
   let status=col.status>=0?r[col.status]:"Open";
   if(!["Open","Assigned","Acknowledged","In Progress","Pending Vendor","Resolved","Closed"].includes(status))status="Open";
   const oc=col.occurred>=0&&/^\d{4}-\d{2}-\d{2}$/.test(r[col.occurred]||"")?r[col.occurred]+"T09:00":stampISO();
   S.issues.unshift({id:newTicketId(),plant:pname,
    vertical:col.issue_type>=0&&r[col.issue_type]?r[col.issue_type]:"Other",
    sub:col.sub>=0?(r[col.sub]||null):null,
    equip:col.equipment>=0&&r[col.equipment]?r[col.equipment]:"—",
    desc:col.description>=0&&r[col.description]?r[col.description]:"Imported from CSV — add details",
    severity:sev,created:stampISO(),etc:addHoursISO(stampISO(),etcHrs(sev)),photos:0,impact:null,
    maker:col.maker>=0?(r[col.maker]||""):"",occurred:oc,
    assignee:col.assignee>=0&&r[col.assignee]?r[col.assignee]:null,vendor:null,status:status,
    progress:[],closure:null,sourceTask:null,reopenedFrom:null,reopenCount:0,updated:stampISO()});
   made++;
  });
 }
 if(t==="tasks"){
  if(col.task<0){toast("Could not find a task column.");return}
  rows.forEach((r,ln)=>{
   const name=r[col.task];if(!name){skipped.push("row "+(ln+2)+" · no task name");return}
   const plant=col.plant>=0&&r[col.plant]?r[col.plant]:(S.plants[0]?S.plants[0].name:"—");
   if(plant!=="—"&&!plantRec(plant)){skipped.push("row "+(ln+2)+" · unknown plant \""+plant+"\"");return}
   let freq=col.frequency>=0&&r[col.frequency]?r[col.frequency]:"Monthly";
   if(!FREQ_MAP[freq])freq="Monthly";
   S.tasks.unshift({id:uid("WO"),plant,name,type:col.type>=0&&r[col.type]?r[col.type]:(TASK_TYPES[0].name),
    equip:null,freq,
    due:col.start_date>=0&&/^\d{4}-\d{2}-\d{2}$/.test(r[col.start_date]||"")?r[col.start_date]:addDays(TODAY,3),
    assignee:col.assignee>=0&&r[col.assignee]?r[col.assignee]:TEAM_POOL[0],status:"Scheduled",
    sop:"From uploaded CSV",safety:"—",tools:"—",duration:"4 hrs",completion:null,linkedIssue:null,
    log:[{at:stamp(),text:"Imported from user-selected CSV ("+(S.impName||"file")+")",actor:OM_HEAD}]});
   made++;
  });
 }
 audit("Data imports","Imported "+made+" "+t+(skipped.length?" · "+skipped.length+" row(s) skipped":"")+" from "+(S.impName||"CSV"),OM_HEAD);
 persist();
 S.impRows=null;S.impHeaders=null;S.impName=null;
 render();
 ccPopup("Import complete — "+made+" "+(t==="plants"?"plant(s)":t==="issues"?"issue ticket(s)":"task(s)")+" imported",(skipped.length?skipped.length+" row(s) skipped — check the notification below.":"From "+(S.impName||"your CSV")+" — live in the dashboard now."),"s",t==="issues"?(()=>goTab("issues")):null);
 if(skipped.length)toast("Skipped: "+skipped.slice(0,3).join(" · ")+(skipped.length>3?" +"+(skipped.length-3)+" more":""));
}
function renderDataHub(){
 const t=S.impType||"plants",spec=ccImpSpec(t);
 const hasPrev=!!(S.impRows&&S.impRows.length);
 let matchInfo="";
 if(hasPrev){
  const H=S.impHeaders||[];
  const found=spec.map.filter(m=>m.slice(1).some(a=>H.indexOf(a)>=0));
  const missing=spec.req[0][0].filter?spec.req[0][0]:spec.req[0][0];
  matchInfo='<div style="font-size:11.5px;color:var(--muted-foreground);margin-top:8px">Matched columns: '+(found.length?found.map(m=>'<b style="color:var(--secondary-foreground)">'+esc(m[0])+'</b>').join(", "):"—")+' · rows: <b>'+S.impRows.length+'</b></div>';
 }
 return '<div class="ops-page ops-data"><div class="ops-page-head"><div><div class="kpi-label">SOLAR OPERATIONS · DATA CONTROL</div><h1>Data / Imports</h1><p>Review operational records and import validated CSV data into the live application.</p></div><span class="ops-page-status"><i></i>FastAPI → Supabase</span></div>'+
  '<div class="ops-data-metrics">'+kpiTile("Plants",S.plants.length,"live register","var(--foreground)",'data-act="go" data-id="plants"')+kpiTile("Issues",S.issues.length,"live tickets","var(--info)",'data-act="kpi" data-id="open"')+kpiTile("Handovers",S.handovers.length,"project intake","var(--foreground)","")+kpiTile("Database persistence","On","Connected source","var(--success)","")+'</div>'+
  '<div class="panel ops-import-panel"><div class="ops-section-head"><div><div class="kpi-label">CONTROLLED CSV WORKFLOW</div><h2>Import operational data</h2><p>Choose a data type, upload a CSV, review the preview, and confirm the import.</p></div><div class="ops-import-head-actions"><span class="ops-section-count">CSV</span>'+(t==="tasks"?'<a class="btn o sm" href="/static/templates/PM_Task_Plan_Template.xlsx" download>'+I.dl(13)+' Excel template</a>':'')+'<button class="btn o sm" onclick="ccTemplate()">'+I.dl(13)+' CSV template</button></div></div>'+
  '<div class="ops-import-types" role="group" aria-label="Import data type">'+(window.ccImpTypes||["plants","issues","tasks"]).map(x=>'<button type="button" class="pill sev-pill'+(t===x?" active":"")+'" aria-pressed="'+(t===x)+'" onclick="S.impType=\''+x+'\';S.impRows=null;S.impName=null;render()">'+ccImpSpec(x).label+'</button>').join("")+'</div>'+
  '<div class="field ops-file-field"><span class="lbl">Excel / CSV file <b>· expected columns: '+spec.cols.join(", ")+'</b>'+(spec.req[1]?' · required: '+esc(spec.req[1]):'')+'</span>'+
  '<input type="file" class="inp" accept=".csv,.xlsx,.xls,text/csv" onchange="ccPickFile(this)"/></div>'+
  (hasPrev?'<div style="border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-top:6px">'+
   '<div class="ops-preview-title">Preview · '+esc(S.impName||"file")+' · first 5 of '+S.impRows.length+' rows</div>'+
   '<div style="overflow-x:auto;max-height:190px"><table class="dense"><thead><tr>'+(S.impHeaders||[]).map(hh=>'<th>'+esc(hh)+'</th>').join("")+'</tr></thead><tbody>'+
   S.impRows.slice(0,5).map(rr=>'<tr>'+rr.map(cc=>'<td>'+esc(cc)+'</td>').join("")+'</tr>').join("")+'</tbody></table></div>'+matchInfo+'</div>'+
   '<div class="row wrap" style="gap:8px;margin-top:12px"><button class="btn p" onclick="ccDoImport()">'+I.check(14)+' Import '+S.impRows.length+' row(s) as '+esc(spec.label)+'</button>'+
   '<button class="btn o sm" onclick="S.impRows=null;S.impName=null;render()">Cancel</button></div>':'')+
  '</div>'+
  '<div class="panel ops-import-panel"><div class="ops-section-head"><div><div class="kpi-label">MASTER DATA</div><h2>Initial records</h2><p>The plant master is seeded in PostgreSQL at deployment; ongoing operation reads from the database.</p></div></div><div class="row wrap" style="gap:8px"><button class="btn p" onclick="openModal(\'commission\')">New plant</button><button class="btn o" onclick="openModal(\'newTicket\')">New issue</button></div></div>'+
  '<div class="bn-info banner ops-data-note"><b>Data integrity</b> — imports are persisted through FastAPI into Supabase PostgreSQL. Unknown plant references are skipped and reported; only rows in your CSV are processed.</div></div>';
}


/* chip:"Open" = every live ticket (not yet Resolved/Closed) */
function filterIssues(list,f){f=f||S.issF||blankIssF();
 const base=(list||[]).filter(t=>{
  const p=plantRec(t.plant),site=p?p.id:"",project=plantProject(p);
  if(f.plant!=="all"&&t.plant!==f.plant)return false;
  if(f.sev!=="all"&&t.severity!==f.sev)return false;
  if(f.vert!=="all"&&t.vertical!==f.vert)return false;
  if(f.assignee==="Unassigned"&&t.assignee)return false;
  if(f.assignee!=="all"&&f.assignee!=="Unassigned"&&(t.assignee||"")!==f.assignee)return false;
  if(f.status==="Closed (verified)"&&t.status!=="Closed")return false;
  else if(f.status!=="all"&&f.status!=="Closed (verified)"&&t.status!==f.status)return false;
  if(f.site!=="all"&&site!==f.site)return false;
  if(f.project!=="all"&&project!==f.project)return false;
  if(ccEquipmentCategory(f.equip)?!ccEquipmentCategoryMatches(ccEquipmentCategory(f.equip),t,t.plant):!equipmentFilterMatches(t.equip,f.equip,t.plant))return false;
  if(f.aging!=="all"&&ageBucket(t)!==f.aging)return false;
  if(f.maker!=="all"&&(t.maker||"")!==f.maker)return false;
  if(f.from&&issueDay(t)<f.from)return false;
  if(f.to&&issueDay(t)>f.to)return false;
  if(f.chip==="Critical"&&t.severity!=="Critical")return false;
  if(f.chip==="Overdue"&&!isOverdueIssue(t))return false;
  if(f.chip==="Unassigned"&&t.assignee)return false;
  if(f.chip==="Today"&&issueDay(t)!==TODAY)return false;
  if(f.chip==="Mine"&&t.assignee!==OM_HEAD)return false;
  if(f.chip==="Open"&&(t.status==="Closed"||t.status==="Resolved"))return false;
  if(f.queue==="critical"&&(t.severity!=="Critical"||!openTk([t]).length))return false;
  if(f.queue==="overdue"&&(t.severity==="Critical"||!isOverdueIssue(t)||!openTk([t]).length))return false;
  if(f.queue==="other"&&(t.severity==="Critical"||isOverdueIssue(t)||!openTk([t]).length))return false;
  if(f.bucket==="In Progress"&&!["In Progress","Acknowledged","Pending Vendor"].includes(t.status))return false;
  else if(f.bucket&&f.bucket!=="all"&&f.bucket!=="In Progress"&&t.status!==f.bucket)return false;
  if(f.q){const blob=[t.id,t.desc,t.vertical,t.sub,t.equip,t.maker,t.assignee,t.plant,site,project].join(" ").toLowerCase();if(!blob.includes(f.q.toLowerCase()))return false}
  return true;
 });
 if(!f.health||f.health==="all")return base;
 return base.filter(t=>{const p=plantRec(t.plant);return p&&plantHealthOf(p,base)===f.health});
}

/* The open-issues panel (built fresh on every render) */
function ccOpenIssuesPanel(){
 const f=Object.assign(blankIssF(),S.issF||{});
 const issues=filterIssues(S.issues,f);
 const open=openTk(issues);
 if(!open.length)return '<div class="panel" id="cc-openlist">'+emptyState("No open issues","Nothing live under the current filters — clear a filter chip to widen the view.")+'</div>';
 const rows=open.slice().sort((a,b)=>(SEV_RANK[a.severity]??9)-(SEV_RANK[b.severity]??9)||issueAgeDays(b)-issueAgeDays(a)).slice(0,8);
 return '<div class="panel no-stick" id="cc-openlist" style="padding:0">'+
  '<div style="padding:14px 16px 0" class="row between wrap"><div><h2 style="font-size:15px;font-weight:700">Open issues ('+open.length+')</h2><p style="font-size:12px;color:var(--muted-foreground);margin:3px 0 10px">Live tickets under the current dashboard filters · click a row to open the ticket</p></div>'+
  '<div class="row" style="gap:8px"><button class="btn p sm" onclick="drillIssues({chip:\'Open\'})">View all '+open.length+' in Site Issues '+I.chev(12)+'</button>'+
  '<button class="btn o sm" onclick="S.dashOpenList=false;render()" title="Hide list">✕</button></div></div>'+
  '<div style="overflow-x:auto"><table class="dense"><thead><tr><th>Issue</th><th>Plant</th><th>Equipment / maker</th><th>Priority</th><th>Age</th><th>Assignee</th><th>Status</th><th>Action</th></tr></thead><tbody>'+
  rows.map(t=>{const p=plantRec(t.plant);
   return '<tr class="click" data-act="issue" data-id="'+esc(t.id)+'">'+
   '<td style="font-weight:600">'+esc(t.id)+'<div style="font-size:10.5px;color:var(--muted-foreground)">'+esc(t.vertical)+'</div></td>'+
   '<td><div style="font-weight:500">'+esc(t.plant)+'</div><div style="font-size:10.5px;color:var(--muted-foreground)">'+(p?esc(p.id):"")+'</div></td>'+
   '<td>'+esc(t.equip||"—")+(t.maker?'<div style="font-size:10.5px;color:var(--muted-foreground)">'+esc(t.maker)+'</div>':'')+'</td>'+
   '<td>'+badge(t.severity)+'</td>'+
   '<td class="nowrap" style="'+(isOverdueIssue(t)?"color:var(--danger);font-weight:700":"")+'">'+esc(ageBucket(t))+'</td>'+
   '<td>'+(t.assignee?esc(t.assignee):'<span style="color:var(--danger);font-weight:600">Unassigned</span>')+'</td>'+
   '<td class="nowrap">'+badge(t.status)+(isOverdueIssue(t)?' '+badge("Overdue"):"")+'</td>'+
   '<td>'+issueQuickActs(t)+'</td></tr>'}).join("")+
  '</tbody></table></div>'+
  (open.length>8?'<div class="table-pager"><span>Showing 8 of '+open.length+' open issues</span><button class="btn g sm" onclick="drillIssues({chip:\'Open\'})">View all '+I.chev(12)+'</button></div>':'')+
  '</div>';
}

/* Inject the panel below the KPI row whenever it is toggled on */
(function(){
 if(window._ccol)return;window._ccol=true;
 new MutationObserver(()=>{
  if(S.view!=="dashboard"||!S.dashOpenList){const o=document.getElementById("cc-openlist");if(o)o.remove();return}
  if(document.getElementById("cc-openlist"))return;
  const anchor=document.querySelector(".content .kpis8");
  if(!anchor)return;
  const wrap=document.createElement("div");
  wrap.innerHTML=ccOpenIssuesPanel();
  anchor.insertAdjacentElement("afterend",wrap.firstChild);
  const k=document.querySelector('[data-act="kpi"][data-id="open"]');
  if(k)k.classList.add("kpi-active");
 }).observe(document.getElementById("app"),{childList:true,subtree:true});
})();

/* bindUi — same as your app, with the "open" KPI branch upgraded */
function bindUi(){
 if(window._s91ui)return;window._s91ui=true;
 document.addEventListener("click",function(e){
  const el=e.target.closest("[data-act]");if(!el)return;
  const act=el.getAttribute("data-act"),id=el.getAttribute("data-id")||"",arg=el.getAttribute("data-arg")||"",type=el.getAttribute("data-type")||"";
  if(act==="plant"){e.preventDefault();openPlantPage(id);return}
  if(act==="issue"){e.preventDefault();openIssue(id);return}
  if(act==="search"){e.preventDefault();openSearchResult(type,id);return}
  if(act==="notif"){e.preventDefault();actionNotification(id);return}
  if(act==="scope"){e.preventDefault();e.stopPropagation();setPlantScope(id);return}
  if(act==="handover"){e.preventDefault();pickHO(id);return}
  if(act==="chart"){e.preventDefault();S.chartPick=id;goView("plants");toast("Opened plants from chart · "+id);return}
  if(act==="ccIssueQueue"){e.preventDefault();openDashboardIssueQueue(id);return}
  if(act==="ccPmQueue"){e.preventDefault();openDashboardPmQueue(id);return}
  if(act==="trendDay"){e.preventDefault();const stay=S.view==="dashboard"||(S.view==="om-module"&&S.omTab==="issues");const same=(S.issF||{}).from===id&&(S.issF||{}).to===id;if(stay){stayFilter(same?{from:"",to:""}:{from:id,to:id});toast(same?"Cleared date focus":"Focused "+id);return}drillIssues({from:id,to:id,chip:"all"});toast("Filtered issues for "+id);return}
  if(act==="kpi"){e.preventDefault();const stay=S.view==="dashboard";
   if(id==="plants"){goView("plants");return}
   if(id==="healthy"||id==="warning"||id==="criticalPlants"){const h=id==="healthy"?"Healthy":id==="warning"?"Warning":"Critical";const next=((S.issF||{}).health===h)?"all":h;S.plF=Object.assign(S.plF||{},{health:next});if(stay){stayFilter({health:next});return}goView("plants");return}
   if(id==="open"){if(stay){S.dashOpenList=!S.dashOpenList;render();toast(S.dashOpenList?"Open issues listed below the KPI cards":"Open issues list hidden");return}drillIssues({chip:"Open"});return}
   if(id==="overdue"){if(stay){toggleStay("chip","Overdue");return}drillIssues({chip:"Overdue"});return}
   if(id==="unassigned"){if(stay){toggleStay("chip","Unassigned");return}drillIssues({chip:"Unassigned"});return}
   if(id==="resolved"){if(stay){toggleStay("status","Resolved");return}drillIssues({status:"Resolved",chip:"all"});return}return}
  if(act==="ccChip"){e.preventDefault();stayFilter({chip:id});return}
  if(act==="donutHealth"){e.preventDefault();const next=((S.issF||{}).health===id)?"all":id;S.plF=Object.assign(S.plF||{},{health:next});if(S.view==="dashboard"){stayFilter({health:next});return}goView("plants");return}
  if(act==="plantHealth"){e.preventDefault();S.plF=Object.assign(S.plF||{},{health:(S.plF&&S.plF.health)===id?"all":id});S.tablePages.plants=1;persist();render();return}
  if(act==="donutStatus"){e.preventDefault();if(S.view==="dashboard"||(S.view==="om-module"&&S.omTab==="issues")){toggleStay("bucket",id);return}drillIssues({bucket:id});return}
  if(act==="issSev"){e.preventDefault();toggleStay("sev",id);return}
  if(act==="issAge"){e.preventDefault();toggleStay("aging",id);return}
  if(act==="barPlant"){e.preventDefault();const p=(S.plants||[]).find(z=>z.id===id);if(S.view==="dashboard"){stayFilter({plant:p?p.name:id});S.dashPlant=p?p.name:"all";return}if(p)openPlantPage(p.id);return}
  if(act==="barMaker"){e.preventDefault();if(S.view==="dashboard"||(S.view==="om-module"&&S.omTab==="issues")){toggleStay("maker",id);return}drillIssues({maker:id});return}
  if(act==="barType"){e.preventDefault();if(S.view==="dashboard"||(S.view==="om-module"&&S.omTab==="issues")){toggleStay("vert",id);return}drillIssues({vert:id});return}
  if(act==="barEquip"){e.preventDefault();const plant=S.plants.find(z=>z.id===S.plantId);drillIssues({plant:plant?plant.name:"all",equip:id});return}
  if(act==="issuesPlantStatus"){e.preventDefault();const plant=S.plants.find(z=>z.id===S.plantId);drillIssues({plant:plant?plant.name:"all",bucket:id});return}
  if(act==="chip"){e.preventDefault();S.issF.chip=id;S.tablePages.issues=1;if(S.view==="dashboard"){render();return}goTab("issues");return}
  if(act==="workWho"){e.preventDefault();S.workWho=id;goView("work");return}
  if(act==="assignQuick"){e.preventDefault();e.stopPropagation();openModal("assign",{id:id});return}
  if(act==="go"){e.preventDefault();if(["plants","dashboard","work","performance","reports","data","settings"].includes(id))goView(id);else goTab(id);return}
  if(act==="issues"){e.preventDefault();if(id==="breach"){S.issF.status="all";S.issF.sev="all";S.issF.q="";S.issF.sort="etc";goTab("issues");return}drillIssues(id==="all"?{sev:"all",q:"",plant:S.issF.plant||"all"}:{sev:id,q:""});return}
  if(act==="vert"){e.preventDefault();drillIssues({vert:id,q:""});return}
  if(act==="issuesPlant"){e.preventDefault();drillIssues({plant:id,q:""});return}
  if(act==="newIssuePlant"){e.preventDefault();S.issF.plant=id;openModal("newTicket");setTimeout(function(){const sel=document.getElementById("tk-plant");if(sel){sel.value=id;refreshEquipPicker("tk")}},0);return}
  if(act==="plantLocation"){e.preventDefault();e.stopPropagation();openModal("plantLocation",{id:id});return}
  if(act==="editPlant"){e.preventDefault();e.stopPropagation();openModal("editPlant",{id:id});return}
 });
}


console.log("[CC PATCH] loaded OK");

function ccDirectClose(id){
 try{
  var t=(S.issues||[]).find(function(x){return x.id===id});
  if(!t||t.status==="Closed")return;
  var remEl=document.getElementById("dc-rem");
  var remarks=remEl?(remEl.value||"").trim():"";
  var prev=t.status;
  var spent=(t.progress||[]).reduce(function(s,p){return s+(p.hrs||0)},0);
  t.status="Closed";t.updated=stampISO();
  t.closure={closedAt:stampISO(),verifiedBy:OM_HEAD,directClose:true,remarks:remarks,
   rootCause:"Direct close (no resolution flow)",corrective:remarks||"Closed directly by O&M Head",
   photos:0,hrs:spent,resolutionHrs:Math.max(0,Math.round(hrsBetween(t.created,stampISO())||0))};
  t.progress=[{at:stampISO(),note:"Directly closed by O&M Head"+(remarks?" — "+remarks:" (no remarks)"),parts:"—",hrs:0}].concat(t.progress||[]);
  audit("Issues","Ticket "+id+" directly closed"+(remarks?" — "+remarks:""),OM_HEAD,prev,"Closed");
  emitEvent("ticket_completed","Ticket closed — "+id,t.plant+" · direct close","issue",id,"ticket_direct_closed:"+id+":"+stampISO());
  persist();render();
  toast("Ticket "+id+" directly closed.");
 }catch(err){console.warn("[CC PATCH] close failed",err);toast("Close failed — see console")}
}
function ccCloseDialog(id){
 var old=document.getElementById("cc-close-ovl");if(old)old.remove();
 var t=(S.issues||[]).find(function(x){return x.id===id});if(!t)return;
 var o=document.createElement("div");
 o.id="cc-close-ovl";o.className="overlay";o.style.zIndex="300";
 o.addEventListener("click",function(e){if(e.target===o)o.remove()});
 o.innerHTML='<div class="modal" style="max-width:470px">'+
  '<div class="modal-h"><div><h3 style="font-size:16px;font-weight:600;margin:0">Close ticket — '+esc(t.id)+'?</h3>'+
  '<p style="font-size:12px;color:var(--muted-foreground);margin:4px 0 0">'+esc(t.plant)+' · '+badge(t.severity)+' '+badge(t.status)+' — closes directly, skipping the Resolve step</p></div>'+
  '<button class="btn" style="border:none;color:var(--muted-foreground)" onclick="document.getElementById(\'cc-close-ovl\').remove()">'+I.x(18)+'</button></div>'+
  '<div class="modal-b"><div class="field" style="margin:0"><span class="lbl">Closure remarks — why is this ticket being closed? (optional)</span>'+
  '<textarea id="dc-rem" class="txt" rows="3" placeholder="e.g. Duplicate of another ticket / resolved on call / not reproducible…"></textarea></div>'+
  '<div style="font-size:11.5px;color:var(--muted-foreground);margin-top:10px">Recorded in ticket history as a direct close. Reopen stays available.</div></div>'+
  '<div class="modal-f"><button class="btn o" onclick="document.getElementById(\'cc-close-ovl\').remove()">Cancel</button>'+
  '<button class="btn p" onclick="ccDirectClose(\''+esc(t.id)+'\')">'+I.check(13)+' Confirm close</button></div></div>';
 document.body.appendChild(o);
}
function ccEditSubs(){
 try{
  var v=document.getElementById("edit-tk-vert"),s=document.getElementById("edit-tk-sub");
  if(!v||!s||typeof SUBCATS==="undefined")return;
  var cur=s.value;
  s.innerHTML=["(none)"].concat(SUBCATS[v.value]||[]).map(function(x){return '<option>'+esc(x)+'</option>'}).join("");
  s.value=(SUBCATS[v.value]||[]).indexOf(cur)>=0?cur:"(none)";
 }catch(err){}
}
function saveTicketEdit(id){
 try{
  var t=(S.issues||[]).find(function(x){return x.id===id});if(!t)return;
  var g=function(eid){var el=document.getElementById(eid);return el?el.value:undefined};
  var before={severity:t.severity,desc:t.desc,maker:t.maker||"",occurred:t.occurred,equip:t.equip,vertical:t.vertical,sub:t.sub};
  var changed=[];
  var sev=g("edit-tk-sev");
  if(sev!==undefined&&sev!==t.severity){t.severity=sev;if(typeof etcHrs==="function")t.etc=addHoursISO(t.created||stampISO(),etcHrs(sev));changed.push("Severity")}
  var desc=(g("edit-tk-desc")||"").trim();
  if(desc!==t.desc){t.desc=desc;changed.push("Description")}
  var mk=(g("edit-tk-maker")||"").trim();
  if(mk!==(t.maker||"")){t.maker=mk;changed.push("Maker")}
  var oc=g("edit-tk-occurred");
  if(oc&&/^\d{4}-\d{2}-\d{2}$/.test(oc)){var nv=oc+"T09:00";if(nv!==(t.occurred||"")){t.occurred=nv;changed.push("Occurrence date")}}
  var eq=(g("edit-tk-equip")||"").trim();
  if(eq&&eq!==(t.equip||"")){t.equip=eq;changed.push("Equipment")}
  var vert=g("edit-tk-vert");
  if(vert&&vert!==t.vertical){t.vertical=vert;changed.push("Issue type")}
  var subRaw=g("edit-tk-sub");
  if(subRaw!==undefined){var sv=(subRaw==="(none)"||subRaw==="")?null:subRaw;if(sv!==(t.sub||null)){t.sub=sv;changed.push("Sub-category")}}
  t.updated=stampISO();
  audit("Issues","Edited ticket "+id+(changed.length?" — "+changed.join(", ")+" changed":" — no field changes"),OM_HEAD,before,{severity:t.severity,desc:t.desc,equip:t.equip,maker:t.maker,vertical:t.vertical,sub:t.sub});
  persist();S.modal=null;render();
  toast(changed.length?"Ticket "+id+" updated — "+changed.join(", ")+" changed.":"Ticket "+id+" updated.");
 }catch(err){console.warn("[CC PATCH] edit failed",err);toast("Edit failed — see console")}
}
(function(){
 if(window._ccwf)return;window._ccwf=true;
 var app=document.getElementById("app");if(!app)return;
 new MutationObserver(function(){
  try{
   /* 1 · Close Ticket button in the ticket drawer */
   if(S.modal==="ticket"&&S.modalCtx&&S.modalCtx.id){
    var t=(S.issues||[]).find(function(x){return x.id===S.modalCtx.id});
    var foot=document.querySelector(".modal .modal-f");
    if(t&&foot&&!document.getElementById("cc-close-btn")&&t.status!=="Closed"){
     var b=document.createElement("button");
     b.id="cc-close-btn";b.className="btn sm p";b.title="Close directly (skips Resolve)";
     b.innerHTML=I.x(12)+" Close Ticket";
     b.addEventListener("click",function(e){e.stopPropagation();ccCloseDialog(t.id)});
     foot.insertBefore(b,foot.firstChild);
    }
   }
   /* 2 · Expanded edit fields */
   if(S.modal==="editTicket"&&S.modalCtx&&S.modalCtx.id&&!document.getElementById("cc-edit-extra")){
    var t2=(S.issues||[]).find(function(x){return x.id===S.modalCtx.id});
    var body=document.querySelector(".modal .modal-b");
    if(t2&&body&&typeof VERTICALS!=="undefined"){
     var w=document.createElement("div");w.id="cc-edit-extra";
     var subOpts=["(none)"].concat((typeof SUBCATS!=="undefined"&&SUBCATS[t2.vertical])||[]);
     w.innerHTML='<div class="field"><span class="lbl">Maker / manufacturer</span><input id="edit-tk-maker" class="inp" value="'+esc(t2.maker||"")+'" placeholder="e.g. Sungrow, Waaree"/></div>'+
      '<div class="field"><span class="lbl">Equipment</span><input id="edit-tk-equip" class="inp" value="'+esc(t2.equip&&t2.equip!=="—"?t2.equip:"")+'" placeholder="e.g. INV-03, Transformer TR-01"/></div>'+
      '<div class="row" style="gap:12px"><div class="field" style="flex:1"><span class="lbl">Issue type</span><select id="edit-tk-vert" class="inp" onchange="ccEditSubs()">'+VERTICALS.map(function(v){return '<option'+(v===t2.vertical?" selected":"")+'>'+esc(v)+'</option>'}).join("")+'</select></div>'+
      '<div class="field" style="flex:1"><span class="lbl">Sub-category (optional)</span><select id="edit-tk-sub" class="inp">'+subOpts.map(function(s){return '<option'+((t2.sub||"(none)")===s?" selected":"")+'>'+esc(s)+'</option>'}).join("")+'</select></div></div>'+
      '<div class="field"><span class="lbl">Occurrence date</span><input id="edit-tk-occurred" class="inp" type="date" value="'+esc(String(t2.occurred||t2.created||"").slice(0,10))+'"/></div>';
     body.appendChild(w);
    }
   }
 
   /* 4 · Equipment filter select — dashboard renders its scoped master-data filter */
   if((S.view==="dashboard"||((S.view==="om-module"||S.view==="om")&&S.omTab==="issues"))){
    var hasEquip=!!document.querySelector('select[onchange*="S.issF.equip"]');
    var hasMore=[].slice.call(document.querySelectorAll(".content .btn")).some(function(b){return /More filters/i.test(b.textContent||"")});
    var injectId="cc-equip-iss";
    if(!hasEquip&&!hasMore&&!document.getElementById(injectId)){
     var panel=document.querySelector(".content .filter-panel");
     if(panel){
      var row=panel.querySelector("div.row.wrap");
      if(row){
       var opts=Array.from(new Set((S.issues||[]).map(function(t){return t.equip}).filter(Boolean))).sort();
       var f=(S.issF||{});
       var holder=document.createElement("div");holder.id=injectId;
       holder.innerHTML='<div class="field" style="min-width:150px"><span class="lbl">Equipment</span><select class="inp" onchange="S.issF.equip=this.value;S.tablePages.issues=1;render()">'+
        '<option value="all"'+((f.equip==="all"||!f.equip)?" selected":"")+'>All equipment</option>'+
        opts.map(function(e){return '<option value="'+esc(e)+'"'+(f.equip===e?" selected":"")+'>'+esc(e)+'</option>'}).join("")+
        '</select></div>';
       row.insertBefore(holder.firstChild,row.firstChild);
      }
     }
    }
   }
   /* 5 · Search wording */
   var tb=document.querySelector(".topbar input.inp");
   if(tb&&tb.placeholder.indexOf("equipment")<0)tb.placeholder="Search tickets, plants, equipment, maker, engineer…";
   var inputs=document.querySelectorAll("input.inp");
   for(var ii=0;ii<inputs.length;ii++){var ph=inputs[ii].placeholder||"";if(/^Search ticket/i.test(ph)&&ph.indexOf("equipment")<0)inputs[ii].placeholder="Search ticket, plant, equipment, maker…";}
  }catch(err){console.warn("[CC PATCH] dom patch skipped",err)}
 }).observe(app,{childList:true,subtree:true});
})();


console.log("[CC TYPE FIX v2] loaded OK");
(function(){
 if(window._cctf2)return;window._cctf2=true;
 var last=null,restoring=false;
 function sigOf(t){
  if(!t||t.tagName!=="INPUT")return"";
  if(t.type==="date"||t.type==="file"||t.type==="number")return"";
  return String(t.getAttribute("oninput")||t.getAttribute("onchange")||"");
 }
 document.addEventListener("focusin",function(e){
  if(restoring)return;                 /* ignore focus we trigger ourselves */
  var s=sigOf(e.target);
  if(!s){last=null;return;}
  if(last&&last.sig===s)return;        /* same field — keep the tracked caret */
  last={sig:s,pos:e.target.selectionStart||0};
 },true);
 document.addEventListener("input",function(e){
  var s=sigOf(e.target);
  if(s&&last&&last.sig===s)last.pos=e.target.selectionStart||0;
 },true);
 document.addEventListener("mousedown",function(e){
  if(!sigOf(e.target))last=null;       /* clicking elsewhere stops the restore */
 },true);
 var app=document.getElementById("app");if(!app)return;
 new MutationObserver(function(){
  try{
   if(!last||restoring)return;
   var els=document.getElementsByTagName("input");
   for(var i=0;i<els.length;i++){
    var el=els[i];
    if(sigOf(el)===last.sig){
     if(document.activeElement!==el){
      restoring=true;
      el.focus();
      var p=Math.min(last.pos,el.value?el.value.length:0);
      try{el.setSelectionRange(p,p)}catch(e2){}
      restoring=false;
     }
     return;
    }
   }
  }catch(err){}
 }).observe(app,{childList:true,subtree:true});
})();


console.log("[CC MW v2] loaded OK");
(function(){
 if(window._ccmw2)return;window._ccmw2=true;
 var app=document.getElementById("app");if(!app)return;
 function fmt(n){var v=Math.round(n*100)/100;var s=v>=100?v.toFixed(1):v.toFixed(2);s=s.replace(/\.?0+$/,"");return s===""?"0":s}
 function isNum(t){return /^[\d,]+(\.\d+)?$/.test(String(t||"").trim())}
 function toNum(t){return parseFloat(String(t).replace(/,/g,""))}
 var BOX=".metric,.viz-kpi,.cc-kpi2,.cc-hstat,.status-circle-card,.ring-card";
 function fixBoxes(){
  var conts=app.querySelectorAll(BOX);
  for(var a=0;a<conts.length;a++){
   var box=conts[a];
   /* text inside the box: "2520 kW" → "2.52 MW", "(kW)" → "(MW)" */
   var w=document.createTreeWalker(box,NodeFilter.SHOW_TEXT,null),list=[];
   while(w.nextNode())list.push(w.currentNode);
   var found=false;
   for(var i=0;i<list.length;i++){
    var node=list[i],t=node.nodeValue;
    if(!t||!/\bkW\b/i.test(t))continue;
    found=true;
    var m=t.match(/(\d[\d,]*(?:\.\d+)?)\s*\/\s*(\d[\d,]*(?:\.\d+)?)\s*\bkW\b/i);
    if(m){node.nodeValue=t.replace(m[0],fmt(toNum(m[1])/1000)+" / "+fmt(toNum(m[2])/1000)+" MW");continue}
    m=t.match(/(\d[\d,]*(?:\.\d+)?)\s*\bkW\b/i);
    if(m){node.nodeValue=t.replace(m[0],fmt(toNum(m[1])/1000)+" MW");continue}
    node.nodeValue=t.replace(/\bkW\b/gi,"MW");
   }
   if(!found)continue;
   /* label said (kW) → divide the plain numeric value beside it */
   var vals=box.querySelectorAll(".v,.kpi-value,.cc-val2,.viz-ring-hole b");
   for(var v=0;v<vals.length;v++){
    var el=vals[v],t=(el.textContent||"").trim();
    if(!isNum(t))continue;
    var num=toNum(t);if(!isFinite(num))continue;
    if(el.childNodes.length===1&&el.firstChild.nodeType===3)el.firstChild.nodeValue=fmt(num/1000);
    else el.textContent=fmt(num/1000);
   }
  }
 }
 new MutationObserver(function(){try{fixBoxes()}catch(e){}}).observe(app,{childList:true,subtree:true});
 setTimeout(function(){try{fixBoxes()}catch(e){}},60);
})();

console.log("[CC LINKFIX] loaded OK");
function ccLinkPlants(){
 var n=0;
 function norm(s){return String(s==null?"":s).trim().toLowerCase()}
 function stripCap(s){return norm(s).replace(/\s*-\s*\d+(?:\.\d+)?\s*m?w\.?\s*$/,"")}
 function findPlant(raw){
  var p=(S.plants||[]).find(function(x){return String(x.name).trim()===String(raw).trim()});
  if(p)return p;
  p=(S.plants||[]).find(function(x){return norm(x.name)===norm(raw)});
  if(p)return p;
  p=(S.plants||[]).find(function(x){return stripCap(x.name)===stripCap(raw)});
  if(p)return p;
  p=(S.plants||[]).find(function(x){return norm(x.id)===norm(raw)||String(x.id).replace(/_/g,"")===String(raw).replace(/[_\s\-]/g,"")});
  return p||null;
 }
 ["issues","tasks"].forEach(function(key){
  (S[key]||[]).forEach(function(t){
   if(!t||!t.plant)return;
   var raw=String(t.plant).trim();
   if(!raw)return;
   var p=findPlant(raw);
   if(p&&p.name!==t.plant){t.plant=p.name;n++;}
  });
 });
 return n;
}
(function(){
 function run(){
  if(document.hidden)return;
  try{
   var n=ccLinkPlants();
   var orphans=(S.issues||[]).filter(function(t){return t.plant&&!(S.plants||[]).some(function(p){return p.name===t.plant})});
   if(orphans.length)console.warn("[CC LINKFIX] still unlinked: "+orphans.map(function(t){return t.id+" → '"+t.plant+"'"}).join(", "));
   if(n>0){persist();render();toast(n+" ticket/task plant link(s) repaired — plant issue counts now show.");}
  }catch(e){}
 }
 setTimeout(run,500);
 setInterval(run,8000);
})();


console.log("[CC SYNC] loaded OK");

function ccNotify(title,meta,tone,open){
 if(typeof ccPopup==="function"){ccPopup(title,meta,tone,open);return}
 toast(title+(meta?" — "+meta:""));
}
function emitEvent(type,title,meta,targetType,targetId,key){
 try{
  var k=key||type+":"+(targetId||title);
  var open=null;
  if(targetType==="issue"&&targetId)open=function(){openIssue(targetId)};
  else if(targetType==="task"&&targetId)open=function(){S.schedF.q=targetId;goTab("scheduled")};
  else if(targetType==="handover"&&targetId)open=function(){S.view="om-module";S.omTab="handover";S.hoOpen=targetId;persist();render()};
  var tone=/critical|breach|overdue|incident|rejected/i.test(type)?"d":/pending|exception|changes|reopened|edited/i.test(type)?"w":/completed|assigned|approved|resolved|ready|logged|submitted|renewed|repaired|imported/i.test(type)?"s":"i";
  ccNotify(title,meta||"",tone,open);
  if((S.events||[]).some(function(e){return e.key===k}))return;
  S.events.unshift({id:uid("EVT"),key:k,type:type,title:title,meta:meta||"",targetType:targetType||null,targetId:targetId||null,at:stampLong(),read:false});
  try{persist()}catch(e2){}
 }catch(e){console.warn("[CC SYNC] event failed",e)}
}
/* hook an existing action: run original, then notify + refresh */
function ccHook(name,after){
 try{
  var orig=window[name];
  if(typeof orig!=="function"){console.warn("[CC SYNC] not found: "+name);return}
  window[name]=function(){
   var r=orig.apply(this,arguments);
   try{after.apply(this,arguments)}catch(e){}
   setTimeout(function(){try{render()}catch(e2){}},0);
   return r;
  };
 }catch(e){console.warn("[CC SYNC] hook skip: "+name)}
}
function ccT(id){return (S.issues||[]).find(function(x){return x.id===id})||null}

/* ── Issues lifecycle ── */
ccHook("resolveTicket",function(){var t=ccT((S.modalCtx||{}).id);if(t)emitEvent("ticket_resolved","Resolution submitted — "+t.id,(t.plant||"")+" · awaiting O&M Head verification","issue",t.id,"ticket_resolved:"+t.id)});
ccHook("reopenTicket",function(){var t=ccT((S.modalCtx||{}).id);if(t)emitEvent("ticket_reopened","Ticket reopened — "+t.id,(t.plant||"")+" · recurrence feeds chronic-problem tracking","issue",t.id,"ticket_reopened:"+t.id)});
ccHook("ackTicket",function(id){var t=ccT(id);if(t)emitEvent("ticket_ack","Acknowledged — "+t.id,(t.plant||"")+" · "+(t.assignee||"unassigned"),"issue",id,"ticket_ack:"+id)});
ccHook("startTicket",function(id){var t=ccT(id);if(t)emitEvent("ticket_started","Work started — "+t.id,(t.plant||"")+" · "+(t.assignee||""),"issue",id,"ticket_started:"+id)});
ccHook("pendingTicket",function(id){var t=ccT(id);if(t)emitEvent("ticket_pending","Blocked — parts/vendor — "+t.id,(t.plant||"")+" · clock keeps running","issue",id,"ticket_pending:"+id)});
ccHook("resumeTicket",function(id){var t=ccT(id);if(t)emitEvent("ticket_resumed","Resumed — "+t.id,(t.plant||"")+" · parts/vendor received","issue",id,"ticket_resumed:"+id)});
ccHook("saveTicketEdit",function(id){var t=ccT(id);if(t)emitEvent("ticket_edited","Ticket edited — "+t.id,(t.plant||"")+" · "+(t.vertical||""),"issue",id,"ticket_edited:"+id+":"+stampISO())});
ccHook("convertToIssue",function(){var t=(S.issues||[])[0];if(t)emitEvent("issue_from_task","Issue created from PM task — "+t.id,(t.plant||"")+" · auto-linked","issue",t.id,"pm_issue:"+t.id)});

/* ── Washing ── */
ccHook("washTable",function(id){var t=(S.washing||[]).find(function(x){return x.id===id});if(t)emitEvent("wash_logged","Wash logged — "+t.tableId,(t.plant||"")+" · compliance updated",null,null,"wash:"+t.id+":"+TODAY)});
ccHook("bulkWash",function(){emitEvent("wash_logged","Bulk wash — "+S.washPlant,"Inverter tables logged washed today · per-table records stored",null,null,"washbulk:"+S.washPlant+":"+TODAY+":"+String(new Date().getMinutes()))});
ccHook("logException",function(){var t=(S.washing||[]).find(function(x){return x.id===(S.modalCtx||{}).id});if(t)emitEvent("wash_exception","Washing exception — "+t.tableId,(t.plant||"")+" · recorded, not counted as a miss",null,null,"washexc:"+t.id+":"+TODAY)});

/* ── Safety ── */
ccHook("reportIncident",function(){var i=(S.incidents||[])[0];if(i)emitEvent("incident_reported","Safety "+i.type+" — "+i.id,(i.plant||"")+" · "+i.severity+" · separate register from equipment issues",null,i.id,"incident:"+i.id)});
ccHook("approvePTW",function(id,ok){var p=(S.ptw||[]).find(function(x){return x.id===id});if(p)emitEvent(ok?"ptw_approved":"ptw_rejected","PTW "+(ok?"approved — work unblocked":"rejected")+" — "+p.id,(p.task||"")+" · "+(p.plant||""),null,id,"ptw:"+id+":"+ok)});
ccHook("closePTW",function(id){var p=(S.ptw||[]).find(function(x){return x.id===id});if(p)emitEvent("ptw_closed","PTW closed — "+p.id,(p.task||"")+" · LOTO removed",null,id,"ptwclosed:"+id)});

/* ── Extra services ── */
ccHook("approveESR",function(id){emitEvent("esr_approved","Service request approved — "+id,"Budget sanctioned · vendor PO issued",null,id,"esr:"+id)});
ccHook("verifyESR",function(id){emitEvent("esr_completed","Service request completed — "+id,"Verified & closed with evidence",null,id,"esrdone:"+id)});
ccHook("reorder",function(id){var s=(S.inventory||[]).find(function(x){return x.id===id});if(s)emitEvent("stock_reorder","Reorder received — "+s.item,"Stock topped to "+s.reorderTo+" "+s.unit,null,id,"reorder:"+id)});
ccHook("renewDoc",function(id){var d=(S.docs||[]).find(function(x){return x.id===id});if(d)emitEvent("doc_renewed","Document renewed — "+d.name,(d.plant||"")+" · +1 yr · reminder chain reset",null,id,"docrenew:"+id)});

/* ── Handover ── */
ccHook("approveHandover",function(){var h=(S.handovers||[]).find(function(x){return x.id===(S.modalCtx||{}).hid});if(h)emitEvent("handover_approved","Handover approved — "+h.name,h.handoverId+" · transitioned to Active O&M · plant + washing provisioned","handover",h.id,"ho_approved:"+h.id)});



console.log("[CC REG-FAST] loaded OK");
(function(){
 if(window._ccofr)return;window._ccofr=true;
 function scrollToRegister(){
  setTimeout(function(){
   try{
    var el=document.getElementById("section-results")||document.querySelector(".content .panel.no-stick");
    if(!el){var t=document.querySelectorAll(".content table");el=t[t.length-1]}
    if(el&&el.scrollIntoView)el.scrollIntoView({behavior:"smooth",block:"start"});
   }catch(e){}
  },90);
 }
 function onIssuesView(){return (S.view==="om-module"||S.view==="om")&&S.omTab==="issues"}
 document.addEventListener("click",function(e){
  try{
   var el=e.target&&e.target.closest?e.target.closest("[data-act]"):null;
   if(!el)return;
   var act=el.getAttribute("data-act"),id=el.getAttribute("data-id")||"";
   /* 1 · Command Center / hero / Data hub KPI boxes → register + filter */
   if(act==="kpi"&&id==="open"){
    /* Open issues → navigate to the register, apply NO filter, show NO chip */
    e.preventDefault();e.stopImmediatePropagation();
    S.issF=blankIssF();              /* clear any stale filter from a previous visit */
    S.tablePages.issues=1;
    goTab("issues");
    scrollToRegister();
    return;
}
if(act==="kpi"&&(id==="overdue"||id==="unassigned"||id==="resolved")){
    e.preventDefault();e.stopImmediatePropagation();
    var patch=id==="overdue"?{chip:"Overdue"}:id==="unassigned"?{chip:"Unassigned"}:{bucket:"Resolved"};
    drillIssues(patch);
    scrollToRegister();
    toast("Site Issues — filtered to "+id+" tickets");
    return;
}
   /* 2 · On the Site Issues page: any box / chip / donut click →
          filter applies, then scroll straight to the register */
   if(onIssuesView()){
    if(act==="chip"&&id==="all"){        /* the "Open" KPI card → open (live) tickets */
     e.preventDefault();e.stopImmediatePropagation();
     stayFilter({chip:"Open"});
     scrollToRegister();
     toast("Filtered to open (live) tickets");
     return;
    }
    if(act==="chip"||act==="ccChip"||act==="donutStatus"||act==="issSev"||act==="issAge")scrollToRegister();
   }
  }catch(err){}
 },true);
 /* 3 · Remove duplicate "Open issues" boxes on the dashboard */
 new MutationObserver(function(){
  try{
   if(S.view!=="dashboard")return;
   var boxes=document.querySelectorAll('[data-act="kpi"][data-id="open"]');
   for(var i=1;i<boxes.length;i++)boxes[i].remove();
  }catch(e){}
 }).observe(document.getElementById("app"),{childList:true,subtree:true});
})();

console.log("[CC NO-FILTERPANEL] loaded OK");
(function(){
 if(window._ccrfp)return;window._ccrfp=true;
 var app=document.getElementById("app");if(!app)return;
 new MutationObserver(function(){
  try{
   var dash=S.view==="dashboard";
   if(!dash)return;
   var panels=document.querySelectorAll(".content .filter-panel");
   for(var i=0;i<panels.length;i++)panels[i].remove();
  }catch(e){}
 }).observe(app,{childList:true,subtree:true});
})();

console.log("[CC RESVIEW] loaded OK");
(function(){
 if(window._ccres)return;window._ccres=true;
 var st=document.createElement("style");
 st.textContent=".cc-res-strip{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border:1px solid #BFE5CC;background:linear-gradient(180deg,#F2FBF5,#fff);border-left:4px solid var(--success);border-radius:14px;padding:10px 14px;font-size:12.5px;box-shadow:var(--shadow-panel)}"+
 ".cc-res-strip b{font-size:14px}"+
 ".cc-ok{color:var(--success);font-weight:800;margin-right:5px}"+
 "tr.cc-res-row td{background:rgba(22,163,74,.06)}"+
 "tr.cc-res-row:hover td{background:rgba(22,163,74,.12)}";
 document.head.appendChild(st);
 var app=document.getElementById("app");if(!app)return;
 function issView(){return (S.view==="om-module"||S.view==="om")&&S.omTab==="issues"}
 function scrollReg(){setTimeout(function(){try{var el=document.getElementById("section-results")||document.querySelector(".content .panel.no-stick");if(el&&el.scrollIntoView)el.scrollIntoView({behavior:"smooth",block:"start"})}catch(e){}},90)}
 window.ccResToggle=function(){
  try{
   if(S.ccResView){S.ccResView=false;render();toast("Resolution view off");return}
   S.issF=blankIssF({sort:((S.issF||{}).sort)||"etc"});   /* clear all filters — no active-filter chips */
   S.ccResView=true;S.tablePages.issues=1;
   if(issView())render();else goTab("issues");
   scrollReg();
   toast("Resolution view — open vs resolved, no filter applied");
  }catch(e){console.warn("[CC RESVIEW]",e)}
 };
 new MutationObserver(function(){
  try{
   if(!issView()){if(S.ccResView)S.ccResView=false;return}
   /* 1 · make every Resolved tile clickable + fix its note text */
   var tiles=[];
   var byAct=document.querySelectorAll('[data-act="kpi"][data-id="resolved"]');
   for(var i=0;i<byAct.length;i++)tiles.push(byAct[i]);
   var boxes=document.querySelectorAll(".metric,.viz-kpi,.cc-kpi2");
   for(var b=0;b<boxes.length;b++){
    var lbl=boxes[b].querySelector(".k,.kpi-label,.cc-lab2");
    if(lbl&&String(lbl.textContent||"").trim().toLowerCase()==="resolved"&&tiles.indexOf(boxes[b])<0)tiles.push(boxes[b]);
   }
   var tot=(S.issues||[]).length;
   var res=(S.issues||[]).filter(function(t){return t.status==="Resolved"||t.status==="Closed"}).length;
   for(var j=0;j<tiles.length;j++){
    var tile=tiles[j];
    tile.removeAttribute("data-act");tile.removeAttribute("data-id");   /* neutralize old handlers */
    if(tile.getAttribute("data-ccres"))continue;
    tile.setAttribute("data-ccres","1");tile.style.cursor="pointer";tile.title="Resolution view — open vs resolved";
    tile.addEventListener("click",function(e){e.stopPropagation();e.preventDefault();ccResToggle()});
    var note=tile.querySelector(".s,.kpi-note,.cc-note2");
    if(note)note.textContent=res+" of "+tot+" tickets resolved";
   }
   /* 2 · resolution view: summary strip + mark solved rows */
   if(!S.ccResView){var old=document.getElementById("cc-res-strip");if(old)old.remove();return}
   var reg=document.getElementById("section-results")||document.querySelector(".content .panel.no-stick");
   if(!reg)return;
   if(!document.getElementById("cc-res-strip")){
    var open=openTk(S.issues||[]).length;
    var closed=(S.issues||[]).filter(function(t){return t.status==="Closed"}).length;
    var strip=document.createElement("div");
    strip.id="cc-res-strip";strip.className="cc-res-strip";
    strip.innerHTML='<span class="cc-ok">✔</span><b>Resolution view</b>'+
     '<span><b>'+open+'</b> open · <b>'+(res-closed)+'</b> resolved · <b>'+closed+'</b> closed</span>'+
     '<span class="muted">solved rows are marked ✓ — no filter applied</span>'+
     '<button class="btn o sm" style="margin-left:auto" onclick="ccResToggle()">Exit view</button>';
    reg.parentNode.insertBefore(strip,reg);
   }
   var rows=reg.querySelectorAll('tr[data-act="issue"]');
   for(var r=0;r<rows.length;r++){
    var tr=rows[r],id=tr.getAttribute("data-id");
    var t=(S.issues||[]).find(function(x){return x.id===id});
    if(!t)continue;
    var solved=(t.status==="Resolved"||t.status==="Closed");
    if(solved&&!tr.getAttribute("data-ccok")){
     tr.setAttribute("data-ccok","1");tr.classList.add("cc-res-row");
     var first=tr.querySelector("td");
     if(first&&!first.querySelector(".cc-ok"))first.insertAdjacentHTML("afterbegin",'<span class="cc-ok">✓</span>');
    }else if(!solved){tr.removeAttribute("data-ccok");tr.classList.remove("cc-res-row")}
   }
  }catch(e){}
 }).observe(app,{childList:true,subtree:true});
})();


console.log("[CC RESVIEW-X] loaded OK");
(function(){
 if(window._ccresx)return;window._ccresx=true;
 var app=document.getElementById("app");if(!app)return;
 new MutationObserver(function(){
  try{
   if((S.view==="om-module"||S.view==="om")&&S.omTab==="issues")return; /* main RESVIEW block handles that view */
   if(typeof ccResToggle!=="function")return;
   var tiles=[];
   var byAct=document.querySelectorAll('[data-act="kpi"][data-id="resolved"]');
   for(var i=0;i<byAct.length;i++)tiles.push(byAct[i]);
   var boxes=document.querySelectorAll(".metric,.viz-kpi,.cc-kpi2");
   for(var b=0;b<boxes.length;b++){
    var lbl=boxes[b].querySelector(".k,.kpi-label,.cc-lab2");
    if(lbl&&String(lbl.textContent||"").trim().toLowerCase()==="resolved"&&tiles.indexOf(boxes[b])<0)tiles.push(boxes[b]);
   }
   var tot=(S.issues||[]).length;
   var res=(S.issues||[]).filter(function(t){return t.status==="Resolved"||t.status==="Closed"}).length;
   for(var j=0;j<tiles.length;j++){
    var tile=tiles[j];
    tile.removeAttribute("data-act");tile.removeAttribute("data-id");
    if(tile.getAttribute("data-ccres"))continue;
    tile.setAttribute("data-ccres","1");tile.style.cursor="pointer";tile.title="Resolution view — open vs resolved";
    tile.addEventListener("click",function(e){e.stopPropagation();e.preventDefault();ccResToggle()});
    var note=tile.querySelector(".s,.kpi-note,.cc-note2");
    if(note)note.textContent=res+" of "+tot+" tickets resolved";
   }
  }catch(e){}
 }).observe(app,{childList:true,subtree:true});
})();

console.log("[CC HEALTH-DRILL] loaded OK");
(function(){
 if(window._cchd)return;window._cchd=true;
 function scrollReg(){setTimeout(function(){try{var el=document.getElementById("section-results")||document.querySelector(".content .panel.no-stick");if(el&&el.scrollIntoView)el.scrollIntoView({behavior:"smooth",block:"start"})}catch(e){}},90)}
 /* Warning / Critical-plants KPI → issues register */
 document.addEventListener("click",function(e){
  try{
   var el=e.target&&e.target.closest?e.target.closest('[data-act="kpi"]'):null;
   if(!el)return;
   var id=el.getAttribute("data-id")||"";
   if(id!=="warning"&&id!=="criticalPlants")return;
   e.preventDefault();e.stopImmediatePropagation();
   var h=id==="warning"?"Warning":"Critical";
   drillIssues({health:h});
   scrollReg();
   toast("Site Issues — issues from "+h+" plants");
  }catch(err){}
 },true);
 /* health chip × clears BOTH copies of the filter */
 document.addEventListener("click",function(e){
  try{
   var b=e.target&&e.target.closest?e.target.closest("[data-ccfx]"):null;
   if(!b)return;
   var k=b.getAttribute("data-ccfx");
   if(k!=="health"&&k!=="plHealth")return;
   e.preventDefault();e.stopImmediatePropagation();
   var f=Object.assign(blankIssF(),S.issF||{});
   f.health="all";
   S.issF=f;
   S.plF=Object.assign({},S.plF||{},{health:"all"});
   S.tablePages.issues=1;persist();render();
  }catch(err){}
 },true);
})();


(function(){
 if(window._ccCascade)return;window._ccCascade=true;
 function uniq(a){return [...new Set(a.filter(x=>x!==undefined&&x!==null&&String(x)!==""))].sort((a,b)=>String(a).localeCompare(String(b)))}
 function activeIssueRows(ignore){
   var f=Object.assign(blankIssF(),S.issF||{});
   if(ignore)f[ignore]="all";
   return filterIssues(S.issues||[],f);
 }
 function setOptions(sel,values,current){
   var keep=current||"all";
   var html='<option value="all">All</option>';
   uniq(values).forEach(function(v){html+='<option value="'+esc(v)+'">'+esc(v)+'</option>'});
   sel.innerHTML=html;
   sel.value=values.indexOf(keep)>=0?keep:"all";
 }
 function refreshIssueCascade(){
   if(!S)return;
   if(S.modal)return;                                              /* ← key guard */
   if((S.view!=="om-module"&&S.view!=="om")||S.omTab!=="issues")return;
   var map={
    "plant":{key:"plant",get:function(r){return r.plant}},
    "type":{key:"vert",get:function(r){return r.vertical}},
    "assignee":{key:"assignee",get:function(r){return r.assignee||"Unassigned"}},
    "equipment":{key:"equip",get:function(r){return r.equip}}
   };
   document.querySelectorAll(".content .filter-panel .field").forEach(function(field){   /* ← scoped selector */
    var lab=field.querySelector(".lbl"),sel=field.querySelector("select");
    if(!lab||!sel)return;
    var name=lab.textContent.trim().toLowerCase();
    var cfg=Object.keys(map).find(k=>name.includes(k));
    if(!cfg)return;
    var filtered=activeIssueRows(cfg==="plant"?"plant":cfg==="type"?"vert":cfg);
    var values=filtered.map(map[cfg].get);
    setOptions(sel,values,(S.issF||{})[map[cfg].key]);
   });
 }
 function refreshPlantCascade(){
   if(!S||S.modal)return;                                          /* ← key guard */
   if(S.view!=="plants")return;
   var plants=S.plants||[],f=S.plF||{};
   var scoped=plants.filter(function(p){
     if(f.site&&f.site!=="all"&&p.id!==f.site)return false;
     if(f.project&&f.project!=="all"&&plantProject(p)!==f.project)return false;
     if(f.assignee&&f.assignee!=="all"&&plantEngineer(p)!==f.assignee)return false;
     return true;
   });
   document.querySelectorAll(".content .filter-panel .field").forEach(function(field){
    var lab=field.querySelector(".lbl"),sel=field.querySelector("select");
    if(!lab||!sel)return;
    var n=lab.textContent.trim().toLowerCase();
    var vals=null,key=null;
    if(n==="site code"){vals=scoped.map(p=>p.id);key="site"}
    else if(n==="project"){vals=scoped.map(plantProject);key="project"}
    else if(n==="engineer"){vals=scoped.map(plantEngineer);key="assignee"}
    else return;
    setOptions(sel,vals,f[key]);
   });
 }
 var timer;
 new MutationObserver(function(){
   clearTimeout(timer);
   timer=setTimeout(function(){try{refreshIssueCascade();refreshPlantCascade()}catch(e){}},150);
 }).observe(document.getElementById("app")||document.body,{childList:true,subtree:true});
})();


(function(){
 if(window._ccNoChips)return;window._ccNoChips=true;
 var SEL='[data-act="kpi"],[data-act="plantHealth"],'+
         '.metric[data-act="chip"],.cc-kpi2[data-act],'+
         '.viz-kpi[data-act="chip"],.viz-kpi[data-act="kpi"]';
 
 window.addEventListener("click",function(e){
  try{
   if(!e.target||!e.target.closest)return;
   if(!e.target.closest(SEL))return;
   S._hideChips=true;
   setTimeout(function(){S._hideChips=false;},60);   /* one-shot */
  }catch(err){}
 },true);
})();


function scrollToPlantRegister(){
  requestAnimationFrame(function(){
    setTimeout(function(){
      var el=document.getElementById("plant-register-anchor");
      if(el)el.scrollIntoView({behavior:"smooth",block:"start"});
    },150);
  });
}

/* Rebuilds the ACTIVE FILTERS chip bar that renderDashboard() / renderIssues() call. */
function ccFilterBar(){
  if(S._hideChips) return "";
  const f  = Object.assign(blankIssF(), S.issF || {});
  const pl = S.plF || {};
  const LBL = { plant:"Plant", sev:"Priority", vert:"Type", assignee:"Assignee",
                status:"Status", site:"Site", project:"Project", equip:"Equipment",
                aging:"Aging", maker:"Maker", bucket:"Status", health:"Health",
                chip:"Quick" };
  const chips = [];
  const add = (key,val,text)=>{
    if(!val || val==="all") return;
    chips.push(
      '<span class="pill pillsm gf-chip">'+esc(text || LBL[key]+": "+val)+
      ' <button type="button" data-ccfx="'+key+'" style="border:0;background:none;'+
      'color:inherit;cursor:pointer;padding:0 0 0 4px">×</button></span>'
    );
  };

  ["plant","sev","vert","assignee","status","site","project","equip",
   "aging","maker","bucket","health","chip"].forEach(k => add(k, f[k],k==="equip"?equipmentFilterLabel(f[k]):undefined));

  if(f.from || f.to){
    chips.push(
      '<span class="pill pillsm gf-chip">'+(f.from||"—")+" → "+(f.to||"—")+
      ' <button type="button" data-ccfx="range" style="border:0;background:none;'+
      'color:inherit;cursor:pointer;padding:0 0 0 4px">×</button></span>'
    );
  }
  if(f.q) add("q", f.q, "Search: "+f.q);

  if(pl.health && pl.health!=="all"){
    chips.push(
      '<span class="pill pillsm gf-chip">Plant health: '+esc(pl.health)+
      ' <button type="button" data-ccfx="plHealth" style="border:0;background:none;'+
      'color:inherit;cursor:pointer;padding:0 0 0 4px">×</button></span>'
    );
  }
  if(S.dashPlant && S.dashPlant!=="all"){
    chips.push(
      '<span class="pill pillsm gf-chip">Scope: '+esc(S.dashPlant)+
      ' <button type="button" data-ccfx="dashPlant" style="border:0;background:none;'+
      'color:inherit;cursor:pointer;padding:0 0 0 4px">×</button></span>'
    );
  }

  if(!chips.length) return "";
  return '<div class="panel" style="padding:10px 14px;display:flex;align-items:center;'+
    'gap:8px;flex-wrap:wrap"><span class="kpi-label" style="flex:0 0 auto">ACTIVE FILTERS</span>'+
    chips.join("")+
    '<button class="btn o sm" style="margin-left:auto" '+
    'onclick="S.issF=blankIssF();S.plF=Object.assign({},S.plF||{},{health:\'all\'});'+
    'S.dashPlant=\'all\';S.tablePages.issues=1;persist();render()">Clear all</button></div>';
}

/* SOLAR 91 brand mark — inline SVG, no external file needed. */
function ccLogoMark(size){
  size = size || 36;
  return '<svg width="'+size+'" height="'+size+'" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block">'+
    '<g fill="#ffa400"><path d="M32 2.5 L36.2 8.5 H27.8 Z"/><path d="M32 2.5 L36.2 8.5 H27.8 Z" transform="rotate(45 32 32)"/><path d="M32 2.5 L36.2 8.5 H27.8 Z" transform="rotate(90 32 32)"/><path d="M32 2.5 L36.2 8.5 H27.8 Z" transform="rotate(135 32 32)"/><path d="M32 2.5 L36.2 8.5 H27.8 Z" transform="rotate(180 32 32)"/><path d="M32 2.5 L36.2 8.5 H27.8 Z" transform="rotate(225 32 32)"/><path d="M32 2.5 L36.2 8.5 H27.8 Z" transform="rotate(270 32 32)"/><path d="M32 2.5 L36.2 8.5 H27.8 Z" transform="rotate(315 32 32)"/><circle cx="32" cy="32" r="25"/></g><circle cx="32" cy="32" r="23" fill="#009710"/><circle cx="32" cy="32" r="20.8" fill="none" stroke="#fff" stroke-width="1"/><g fill="#ffa400" transform="translate(27 27.5) rotate(-24) scale(.78) translate(-23.5 -24.5)"><rect x="12" y="13" width="7" height="7" rx=".7"/><rect x="20" y="13" width="7" height="7" rx=".7"/><rect x="28" y="13" width="7" height="7" rx=".7"/><rect x="12" y="21" width="7" height="7" rx=".7"/><rect x="20" y="21" width="7" height="7" rx=".7"/><rect x="28" y="21" width="7" height="7" rx=".7"/><rect x="12" y="29" width="7" height="7" rx=".7"/><rect x="20" y="29" width="7" height="7" rx=".7"/></g><path fill="#fff" d="M30 46 C29 39 36 35 43 37 C48 32 48 22 43 15 C51 19 55 30 51 39 C47 47 38 51 30 46 Z"/><path d="M34 47 C40 45 45 41 47 35" fill="none" stroke="#009710" stroke-width="1.1" stroke-linecap="round"/></svg>';
}
