"use strict";
/* Edit a Preventive Maintenance schedule: change name, frequency, due date, assignee, how-to, safety, duration —
   for one task, or for every other open task with the same name + equipment type (other plants / units).
   Entry points: "Edit" in the work-order register, "Edit schedule" in the task detail, and any chip on the weekly calendar. */
(function(){
 const FREQS=["Daily","Weekly","Monthly","Quarterly","Half-yearly","Annual"];
 const SAFE=["—","PTW required","LOTO required","PTW + LOTO required"];
 const isHead=()=>typeof scheduledAdmin==="function"?scheduledAdmin():((S._roleLabel||S.currentRole||"O&M Head")==="O&M Head");
 const roleNow=()=>(typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role)||S._roleLabel||S.currentRole||"";
 const canEditDates=()=>isHead()||roleNow()==="Assignee";   /* Site Engineers can never move PM dates */
 const canEditUnitPlan=()=>["O&M Head","Assignee"].includes(S._roleLabel||S.currentRole||"");
 const $v=id=>{const e=document.getElementById(id);return e?e.value:""};
 const sel=(arr,cur)=>arr.map(x=>'<option'+(x===cur?" selected":"")+'>'+esc(x)+'</option>').join("");
 const similar=t=>(S.tasks||[]).filter(x=>x.id!==t.id&&x.name===t.name&&x.type===t.type&&x.status!=="Completed");

 window.pmEditOpen=function(id){
  if(!canEditDates()){toast("Only the O&M Head or an Assignee can edit PM dates.");return}
  const t=(S.tasks||[]).find(x=>x.id===id);if(!t)return;
  if(t.status==="Completed"){toast("Completed tasks cannot be edited.");return}
  S.modal="pmEdit";S.modalCtx={id};render();
 };
 function editModal(){
  const t=(S.tasks||[]).find(x=>x.id===(S.modalCtx||{}).id);if(!t){S.modal=null;return ""}
  const n=similar(t).length,pool=[...new Set([t.assignee].concat(TEAM_POOL||[]).filter(Boolean))];
  const dateOnly=!isHead();
  const html=modal(dateOnly?"Change start date / deadline":"Edit schedule",esc(t.id)+" · "+esc(t.plant||"Plant not assigned")+" · "+esc(t.type||""),
   '<div class="field"><span class="lbl">Task name</span><input id="pe-name" class="inp" value="'+esc(t.name)+'"/></div>'+
   '<div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'+
    '<div class="field"><span class="lbl">Start date</span><input id="pe-start" type="date" class="inp" value="'+esc(t.start||"")+'"/></div>'+
    '<div class="field"><span class="lbl">Deadline (due date)</span><input id="pe-due" type="date" class="inp" value="'+esc(t.due||"")+'"/></div>'+
    '<div class="field"><span class="lbl">Frequency</span><select id="pe-freq" class="inp">'+sel(FREQS,t.freq)+'</select></div>'+
    '<div class="field"><span class="lbl">Assignee</span><select id="pe-who" class="inp">'+sel(pool,t.assignee)+'</select></div>'+
    '<div class="field"><span class="lbl">Safety needed</span><select id="pe-safe" class="inp">'+sel(SAFE,t.safety||"—")+'</select></div>'+
    '<div class="field"><span class="lbl">Estimated time</span><input id="pe-dur" class="inp" value="'+esc(t.duration||"")+'" placeholder="e.g. 2 hrs"/></div></div>'+
   '<div class="field"><span class="lbl">How to do it</span><textarea id="pe-sop" class="inp" rows="3">'+esc(t.sop||"")+'</textarea></div>'+
   (n?'<label class="row" style="gap:8px;align-items:flex-start;background:var(--muted);border-radius:10px;padding:10px 12px;font-size:12.5px;cursor:pointer"><input id="pe-all" type="checkbox" style="margin-top:3px"/><span><b>Apply to the other '+n+' open task'+(n>1?"s":"")+' with the same name</b> ('+esc(t.type||"same equipment")+', other plants / units).<br><span class="muted">Frequency, assignee, safety, how-to and time are copied. Their due dates move by the same number of days as this one.</span></span></label>':'<div class="muted" style="font-size:12px">No other open task has the same name and equipment type.</div>')+
   '<div class="muted" style="font-size:12.5px;margin-top:8px">Every change is logged on the task and in the audit trail. Completed tasks are never changed.</div>',
   '<button class="btn o" style="margin-right:auto;color:#B42318;border-color:#F3C9C4" onclick="pmDelete(\''+t.id+'\')">Delete task</button><button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="pmEditSave()">Save changes</button>');
  if(!dateOnly)return html;
  /* an Assignee moves the start date and deadline only: other fields are shown read-only, Delete is hidden */
  return html.replace(/id="pe-(name|freq|who|safe|dur|sop)"/g,'id="pe-$1" disabled')
   .replace(/<button class="btn o" style="margin-right:auto;[^>]*>Delete task<\/button>/,'')
   .replace('<div class="field"><span class="lbl">Start date</span>','<div class="field" style="grid-column:1/-1"><span class="muted" style="font-size:12px">You can change the start date and deadline. Other details are managed by the O&amp;M Head.</span></div><div class="field"><span class="lbl">Start date</span>')
   .replace('<div class="muted" style="font-size:12.5px;margin-top:8px">Every change','<div class="field" style="margin-top:8px"><span class="lbl">Reason (required if you move an overdue job later)</span><input id="pe-reason" class="inp" placeholder="e.g. Rain delay"/></div><div class="muted" style="font-size:12.5px;margin-top:8px">Every change');
 }
 window.pmEditSave=async function(){
  const id=(S.modalCtx||{}).id,t=(S.tasks||[]).find(x=>x.id===id);if(!t)return;
  const dateOnly=!isHead();
  const body=dateOnly?{start_on:$v("pe-start")||null,due_on:$v("pe-due")||null,reason:$v("pe-reason").trim()||undefined,apply_to_similar:!!(document.getElementById("pe-all")||{}).checked}
   :{name:$v("pe-name").trim(),frequency:$v("pe-freq"),start_on:$v("pe-start")||null,due_on:$v("pe-due")||null,assignee:$v("pe-who")||null,safety:$v("pe-safe"),duration:$v("pe-dur"),sop:$v("pe-sop"),apply_to_similar:!!(document.getElementById("pe-all")||{}).checked};
  if($v("pe-start")&&$v("pe-due")&&$v("pe-start")>$v("pe-due")){toast("The start date cannot be after the deadline.");return}
  if(!dateOnly&&!body.name){toast("Task name is required.");return}
  if(body.apply_to_similar&&!confirm("Apply these changes to "+similar(t).length+" other open task(s) as well?"))return;
  try{
   const res=await apiFetch("/api/scheduled/tasks/"+encodeURIComponent(id)+"/schedule",{method:"PATCH",body});
   [res.task].concat(res.updated||[]).forEach(row=>{const i=(S.tasks||[]).findIndex(x=>x.id===row.id);if(i>=0)S.tasks[i]=Object.assign({},S.tasks[i],row)});
   S.modal=null;S.modalCtx=null;render();
   toast(res.count>1?res.count+" tasks updated and logged.":res.count?"Schedule updated and logged.":"No changes to save.");
  }catch(e){const d=e&&e.data&&e.data.detail;toast(typeof d==="string"?d:(e&&e.message)||"Could not update the schedule.")}
 };

 window.pmUnitPlanOpen=function(id){
  const t=(S.tasks||[]).find(x=>x.id===id);if(!t)return;
  if(!canEditUnitPlan()){toast("Only the O&M Head or an Assignee for this equipment type can change daily workload.");return}
  if(t.status!=="Scheduled"){toast("Only scheduled tasks can have their unit plan changed.");return}
  const cycle=(S.tasks||[]).filter(x=>t.cycleId&&x.cycleId===t.cycleId);
  const days={};cycle.filter(x=>x.status!=="Cancelled"&&x.due).forEach(x=>days[x.due]=(days[x.due]||0)+1);
  const total=t.totalUnits||Math.max(1,cycle.length||1),perDay=Math.max(1,...Object.values(days));
  S.modal="pmUnitPlan";S.modalCtx={id,total,perDay};render();
 };
 function unitPlanModal(){
  const t=(S.tasks||[]).find(x=>x.id===(S.modalCtx||{}).id);if(!t){S.modal=null;return ""}
  const ctx=S.modalCtx||{};
  return modal("Edit daily workload",esc(t.id)+" · "+esc(t.plant||"Plant not assigned")+" · "+esc(t.type||""),
   '<p class="muted" style="font-size:12px;margin-bottom:12px">Set the total unit count for this PM cycle and the maximum workload per day. Removed workload is cancelled and retained in the task history.</p>'+
   '<div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'+
    '<div class="field"><span class="lbl">Number of units</span><input id="pu-total" class="inp" type="number" min="1" max="500" value="'+ctx.total+'"/></div>'+
    '<div class="field"><span class="lbl">Maximum units per day</span><input id="pu-perday" class="inp" type="number" min="1" max="500" value="'+ctx.perDay+'"/></div></div>'+
   '<div class="muted" style="font-size:12.5px;margin-top:8px">Completed work cannot be removed. Changes are recorded in the task log and audit trail.</div>',
   '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="pmUnitPlanSave()">Save daily workload</button>');
 }
 window.pmUnitPlanSave=async function(){
  const id=(S.modalCtx||{}).id,total=parseInt($v("pu-total"),10),perDay=parseInt($v("pu-perday"),10);
  if(!total||!perDay){toast("Enter the unit count and daily limit.");return}
  if(perDay>total){toast("Units per day cannot exceed the number of units.");return}
  try{
   const res=await apiFetch("/api/scheduled/tasks/"+encodeURIComponent(id)+"/units",{method:"PATCH",body:{total_units:total,units_per_day:perDay}});
   await refreshTasks();
   S.modal=null;S.modalCtx=null;S.tablePages=S.tablePages||{};S.tablePages.scheduled=1;render();
   toast(res.count+" daily workload item(s) updated. Removed work remains in cancelled history.");
  }catch(e){const d=e&&e.data&&e.data.detail;toast(typeof d==="string"?d:(e&&e.message)||"Could not update the unit plan.")}
 };

 window.pmDelete=async function(id){
  const t=(S.tasks||[]).find(x=>x.id===id);if(!t)return;
  const n=similar(t).length;let all=false;
  if(!confirm('Delete "'+t.name+'"'+(t.plant&&t.plant!=="—"?" at "+t.plant:"")+"? This cannot be undone."))return;
  if(n)all=confirm("Also delete the other "+n+" open task(s) with the same name and equipment type?\n\nOK = delete all "+(n+1)+"   ·   Cancel = delete only this one");
  try{
   const res=await apiFetch("/api/scheduled/tasks/"+encodeURIComponent(id)+(all?"?similar=true":""),{method:"DELETE"});
   const gone=new Set(res.deleted||[id]);S.tasks=(S.tasks||[]).filter(x=>!gone.has(x.id));
   S.modal=null;S.modalCtx=null;render();toast((res.count||1)+" task"+((res.count||1)>1?"s":"")+" deleted.");
  }catch(e){const d=e&&e.data&&e.data.detail;toast(typeof d==="string"?d:(e&&e.message)||"Could not delete the task.")}
 };

 /* modal + button wiring */
 const oldRM=renderModal;
 renderModal=function(){
  if(S.modal==="pmEdit")return editModal();
  if(S.modal==="pmUnitPlan")return unitPlanModal();
  let h=oldRM.apply(this,arguments);
  if(S.modal==="taskDetail"&&typeof h==="string"){
   const t=(S.tasks||[]).find(x=>x.id===(S.modalCtx||{}).id);
   if(t&&t.status==="Scheduled"&&canEditUnitPlan())h=h.replace('<button class="btn o sm" onclick="closeModal()">Close</button>','<button class="btn o sm" onclick="closeModal();pmUnitPlanOpen(\''+t.id+'\')">Edit daily workload</button><button class="btn o sm" onclick="closeModal()">Close</button>');
   if(t&&t.status!=="Completed"&&canEditDates())h=h.replace('<button class="btn o sm" onclick="closeModal()">Close</button>','<button class="btn p sm" onclick="closeModal();pmEditOpen(\''+t.id+'\')">Edit schedule</button><button class="btn o sm" onclick="closeModal()">Close</button>');
  }
  return h;
 };
 const oldRS=renderScheduled;
 renderScheduled=function(){
  let h=oldRS.apply(this,arguments);
  if(typeof h==="string"&&canEditDates())h=h.replace(/(<button class="btn g sm" onclick="openModal\(\\?'reassignTask\\?',\{id:\\?'([^'\\]+)\\?'\}\)">Reassign<\/button>)/g,(m,all,id)=>{
   const t=(S.tasks||[]).find(x=>x.id===id);return (t&&t.status!=="Completed"?'<button class="btn o sm" onclick="pmEditOpen(\''+id+'\')">Edit</button>':'')+all});
  return h;
 };
})();
