/* ================================================================
   PM PLAN — simple "Add PM task", PM templates, bulk assign, Excel plan upload.
   Replaces the long "Add task by problem" form. Backend: /api/pm-plan/*
   (daily unit workload is spread across days using each plant's configured capacity)
   ================================================================ */
(function(){
  const FREQS=["Daily","Weekly","Monthly","Quarterly","Half-yearly","Annual"];
  const SAFE=["—","PTW required","LOTO required","PTW + LOTO required"];
  const role=()=>S._roleLabel||S.currentRole||"O&M Head";
  const canCreate=()=>["O&M Head","Administration","Assignee"].indexOf(role())>=0;
  const isPlanner=()=>["O&M Head","Administration"].indexOf(role())>=0;
  const isHead=()=>role()==="O&M Head";
  const unitEd=()=>isHead()||role()==="Assignee";
  const v=id=>{const e=document.getElementById(id);return e?e.value:""};
  const checked=id=>{const e=document.getElementById(id);return !!(e&&e.checked)};
  const opts=(arr,sel)=>arr.map(x=>'<option'+(x===sel?' selected':'')+'>'+esc(x)+'</option>').join("");
  /* Equipment offered for PM tasks/templates: every type except those the O&M Head hid in the scope editor. */
  const typeNames=()=>(typeof TASK_TYPES!=="undefined"?TASK_TYPES:[]).map(t=>t.name).filter(n=>typeof pmTypeVisible!=="function"||pmTypeVisible(n));
  const plantObj=name=>(S.plants||[]).find(p=>p.name===name||p.id===name);
  const plantKey=p=>p.dbId||p.id;
  const mdash=a=>a.length>1?a[0]+"–"+a[a.length-1]:String(a[0]);
  /* Equipment <select> grouped by scope section. EVERY type stays selectable, whatever its section. */
  function typeOpts(sel){
    const names=typeNames(),secs=(typeof SCOPE_SECTIONS!=="undefined"?SCOPE_SECTIONS:[]).filter(s=>s.types),named=[];
    const groups=secs.map(s=>{const l=names.filter(n=>s.types.indexOf(n)>=0);l.forEach(n=>named.push(n));return{t:s.title,l}});
    groups.push({t:"Miscellaneous",l:names.filter(n=>named.indexOf(n)<0)});
    return groups.filter(g=>g.l.length).map(g=>'<optgroup label="'+esc(g.t)+'">'+opts(g.l,sel)+'</optgroup>').join("");
  }
  /* Plant unit configuration (units + max units per day), per plant and equipment type. */
  async function loadUnitCfg(){try{S._pmCfg=await apiFetch("/api/pm-plan/unit-config")}catch(e){S._pmCfg=S._pmCfg||{configs:[],register:[]}}return S._pmCfg}
  function cfgFor(plantName,type){
    const p=plantObj(plantName);if(!p)return null;const id=String(plantKey(p)),c=S._pmCfg||{};
    const cfg=(c.configs||[]).find(x=>x.plant_id===id&&x.equipment_type===type),reg=(c.register||[]).find(x=>x.plant_id===id&&x.equipment_type===type);
    return{cfg:cfg||null,reg:reg?reg.units:null};
  }
  /* Job forms ask "finish within how many days?" — every plant paces its own units, so 1 transformer and
     40 inverters can share one job without a per-day number that only fits some plants. */
  window.pmDaysHint=function(p){
    const el=document.getElementById(p+"-hint");if(!el)return;
    const T=parseInt(v(p==="pq"?"pq-total":"pa-units"),10),N=parseInt(v(p+"-days"),10),all=p==="pa"||v("pq-plant")==="__all";el.style.color="";
    if(!N){el.textContent=all?"Leave blank to use each plant's saved pace. With All plants, plants that have none of this equipment are skipped.":"Leave blank to do every unit on the first due date (or the plant's saved pace).";return}
    if(!T){el.textContent="Every plant spreads its own units over "+N+" day"+(N===1?"":"s")+" — e.g. 8 inverters in "+N+" day"+(N===1?"":"s")+" = "+Math.ceil(8/N)+" a day, while a single transformer is simply done on day 1.";return}
    const per=Math.ceil(T/N),days=Math.ceil(T/per),parts=[];
    for(let i=0;i<Math.min(days,4);i++){const count=Math.min(per,T-i*per);parts.push("Day "+(i+1)+" → "+count)}
    el.textContent=T+" unit"+(T===1?"":"s")+" in "+N+" day"+(N===1?"":"s")+" = "+per+" a day ("+days+" working day"+(days===1?"":"s")+"): "+parts.join(" · ")+(days>4?" …":"");
  };
  window.pmUnitHint=function(p){
    if(p==="pq"||p==="pa")return window.pmDaysHint(p);
    const el=document.getElementById(p+"-hint");if(!el)return;
    const T=parseInt(v(p+"-total"),10),D=parseInt(v(p+"-perday"),10);el.style.color="";
    if(!T||!D){el.textContent=(p==="pq"&&v("pq-plant")==="__all")?"All plants: each plant uses its own saved unit configuration unless you enter numbers here.":"Enter the number of units and the maximum units per day to see the day plan.";return}
    if(D>T){el.textContent="Units per day cannot exceed the number of units.";el.style.color="var(--danger)";return}
    const days=Math.ceil(T/D),parts=[];
    for(let i=0;i<Math.min(days,4);i++){const count=Math.min(D,T-i*D);parts.push("Day "+(i+1)+" → "+count+" unit"+(count===1?"":"s"))}
    el.textContent=T+" units at "+D+" per day = "+days+" day(s): "+parts.join(" · ")+(days>4?" …":"");
  };

  function errText(e){
    const d=e&&e.data&&e.data.detail;
    if(Array.isArray(d))return d.map(x=>(x.loc?x.loc[x.loc.length-1]+": ":"")+(x.msg||"")).join("; ");
    return (e&&e.message)||"Something went wrong.";
  }
  async function loadTemplates(){try{S._pmTpl=await apiFetch("/api/pm-plan/templates")}catch(e){S._pmTpl=S._pmTpl||[]}return S._pmTpl}
  async function refreshTasks(){try{S.tasks=await apiFetch("/api/scheduled/tasks")}catch(e){}}

  /* Dry-run first so the person sees the count, then create. */
  async function run(url,body){
    try{
      const pre=await apiFetch(url,{method:"POST",body:Object.assign({},body,{dry_run:true})});
      if(!pre.count){toast(pre.skipped?("Nothing new to create — "+pre.skipped+" already scheduled."):"Nothing to create.");return false}
      const note=pre.open_without_units?"\n\nNote: "+pre.open_without_units+" open task(s) for this job already exist without unit numbers. They are left as they are.":"";
      const noKit=(pre.skipped_plants||[]).length?"\n\nSkipped "+pre.skipped_plants.length+" plant(s) with no "+(body.equipment_type||"such equipment")+" registered: "+pre.skipped_plants.slice(0,8).join(", ")+(pre.skipped_plants.length>8?"…":""):"";
      if((pre.count>1||note||noKit)&&!confirm("Create "+pre.count+" task(s) across "+pre.plants+" plant(s)"+(pre.days>1?", spread over up to "+pre.days+" day(s)":"")+(pre.skipped?" ("+pre.skipped+" already scheduled will be skipped)":"")+"?"+note+noKit))return false;
      const res=await apiFetch(url,{method:"POST",body:Object.assign({},body,{dry_run:false})});
      await refreshTasks();
      S.modal=null;S.modalCtx=null;S.tablePages=S.tablePages||{};S.tablePages.scheduled=1;render();
      toast(res.count+" PM task(s) created"+((res.skipped_plants||[]).length?" · "+res.skipped_plants.length+" plant(s) without this equipment skipped.":"."));
      return true;
    }catch(e){toast(errText(e));return false}
  }

  /* ───────── Add PM task (one simple form) ───────── */
  function suggestions(type){
    const saved=(S._pmTpl||[]).filter(x=>x.equipment_type===type).map(x=>x.task_name);
    const ideas=(typeof TSUB!=="undefined"&&TSUB[type])||[];
    return saved.concat(ideas.filter(x=>saved.indexOf(x)<0));
  }
  window.pmQuickType=function(){
    const dl=document.getElementById("pq-sugg");
    if(dl)dl.innerHTML=suggestions(v("pq-type")).map(x=>'<option value="'+esc(x)+'"></option>').join("");
    window.pmQuickCfg();
    window.pmQuickFill();
  };
  /* Pre-fill Number of units / units per day from the plant configuration (else the Equipment Register). */
  window.pmQuickCfg=function(){
    const t=document.getElementById("pq-total"),d=document.getElementById("pq-days");if(!t||!d)return;
    if(v("pq-plant")==="__all"){t.value="";t.placeholder="Each plant's own count";d.placeholder="e.g. 3"}
    else{const r=cfgFor(v("pq-plant"),v("pq-type"));t.placeholder=(r&&r.reg)?"Register: "+r.reg:"e.g. 10";
      t.value=r&&r.cfg?r.cfg.total_units:(r&&r.reg)||"";
      d.placeholder=r&&r.cfg&&r.cfg.total_units&&r.cfg.units_per_day?"Saved pace: "+Math.ceil(r.cfg.total_units/r.cfg.units_per_day)+" day(s)":"e.g. 3"}
    window.pmUnitHint("pq");
  };
  window.pmQuickFill=function(){ /* typed task matches a saved template → copy its settings */
    const t=(S._pmTpl||[]).find(x=>x.equipment_type===v("pq-type")&&x.task_name===v("pq-task").trim());
    if(!t)return;
    const set=(id,val)=>{const e=document.getElementById(id);if(e&&val!==null&&val!==undefined)e.value=val};
    set("pq-freq",t.frequency);set("pq-safety",t.safety);set("pq-hours",t.est_hours);
    window.pmUnitHint("pq");
  };
  window.openProblemScheduledTask=async function(){
    if(!canCreate()){toast("Site Engineer can execute assigned Preventive Maintenance work, but cannot create it.");return}
    S.modal="pmQuickTask";S.modalCtx={};render();
    setTimeout(()=>{try{window.pmQuickCfg()}catch(e){}},0);
    Promise.all([loadTemplates(),loadUnitCfg()]).then(()=>{
     if(S.modal!=="pmQuickTask")return;
     const dl=document.getElementById("pq-sugg");if(dl)dl.innerHTML=suggestions(v("pq-type")).map(x=>'<option value="'+esc(x)+'"></option>').join("");
     const total=document.getElementById("pq-total");if(total&&!total.value)try{window.pmQuickCfg()}catch(e){}
    });
  };
  function quickModal(){
    const types=typeNames(),filteredType=S.pmLive&&S.pmLive.equipment&&S.pmLive.equipment!=="all"?S.pmLive.equipment:null;
    const type=filteredType&&types.includes(filteredType)?filteredType:(types.indexOf("Inverter")>=0?"Inverter":(types[0]||"Other"));
    const activePmPlant=S.pmLive&&S.pmLive.plant&&S.pmLive.plant!=="all"?S.pmLive.plant:null;
    const first=activePmPlant||(S.schedScope&&S.schedScope!=="all"?S.schedScope:"__all");
    const body='<div class="pm-form">'+
      '<div class="kgrid" style="grid-template-columns:1fr 1fr;gap:12px">'+
       '<div class="field"><span class="lbl">Equipment type</span><select id="pq-type" class="inp" onchange="pmQuickType()">'+typeOpts(type)+'</select></div>'+
       '<div class="field"><span class="lbl">Plant</span><select id="pq-plant" class="inp" onchange="pmQuickCfg()"><option value="__all"'+(first==="__all"?" selected":"")+'>All plants</option>'+(S.plants||[]).map(p=>'<option value="'+esc(p.name)+'"'+(p.name===first?" selected":"")+'>'+esc(typeof pmPlantLabelText==="function"?pmPlantLabelText(p.name):p.name)+'</option>').join("")+'</select></div>'+
      '</div>'+
      '<div class="field"><span class="lbl">Task — what to do</span><input id="pq-task" class="inp" list="pq-sugg" oninput="pmQuickFill()" placeholder="Pick a suggestion or type your own"/><datalist id="pq-sugg">'+suggestions(type).map(x=>'<option value="'+esc(x)+'"></option>').join("")+'</datalist></div>'+
      '<div class="kgrid" style="grid-template-columns:1fr 1fr 1fr;gap:12px">'+
       '<div class="field"><span class="lbl">Number of units</span><input id="pq-total" class="inp" type="number" min="1" max="500" oninput="pmUnitHint(\'pq\')"/></div>'+
       '<div class="field"><span class="lbl">Finish within (days)</span><input id="pq-days" class="inp" type="number" min="1" max="366" placeholder="e.g. 3" oninput="pmUnitHint(\'pq\')"/></div>'+
       '<div class="field"><span class="lbl">Daily workload</span><div class="inp" style="display:flex;align-items:center;color:var(--muted-foreground)">Worked out for each plant</div></div></div>'+
      '<div id="pq-hint" class="muted" style="font-size:12px;margin:-2px 0 10px"></div>'+
      (isHead()?'<label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin:0 0 10px"><input id="pq-savecfg" type="checkbox"/> Save these unit counts as the plant default (when one plant is selected)</label>':'')+
      '<div class="kgrid" style="grid-template-columns:1fr 1fr;gap:12px">'+
       '<div class="field"><span class="lbl">Assignee</span><select id="pq-assignee" class="inp"><option value="">Assign later</option>'+opts(TEAM_POOL,S.currentUser)+'</select></div>'+
       '<div class="field"><span class="lbl">How often</span><select id="pq-freq" class="inp">'+opts(FREQS,"Monthly")+'</select></div>'+
       '<div class="field"><span class="lbl">First due date</span><input id="pq-due" class="inp" type="date" value="'+addDays(TODAY,3)+'"/></div>'+
       '<div class="field"><span class="lbl">Safety needed</span><select id="pq-safety" class="inp">'+opts(SAFE,"—")+'</select></div>'+
       '<div class="field"><span class="lbl">Est. time (hours)</span><input id="pq-hours" class="inp" type="number" min="0" step="0.5" value="2"/></div>'+
      '</div>'+
      (isHead()?'<label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin-top:8px"><input id="pq-save" type="checkbox"/> Also save as a PM template (reuse later for other plants)</label>':'')+
    '</div>';
    return modal("Add PM task","Choose the equipment, the task and who does it. Frequency repeats automatically after completion.",body,
      '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="pmQuickSubmit()">'+I.plus(14)+'Create task(s)</button>',true);
  }
  window.pmQuickSubmit=async function(){
    const task=v("pq-task").trim();
    if(task.length<2){toast("Enter the task.");return}
    const sel=v("pq-plant"),plant=sel==="__all"?null:plantObj(sel);
    if(sel!=="__all"&&!plant){toast("Select a valid plant.");return}
    const total=parseInt(v("pq-total"),10)||null,days=parseInt(v("pq-days"),10)||null;
    await run("/api/pm-plan/tasks",{
      equipment_type:v("pq-type"),task_name:task,frequency:v("pq-freq"),safety:v("pq-safety"),
      est_hours:parseFloat(v("pq-hours"))||null,plants:plant?[plantKey(plant)]:["All plants"],
      start_date:v("pq-due"),assignees:v("pq-assignee")?[v("pq-assignee")]:[],
      per_unit:true,save_template:checked("pq-save"),
      total_units:total,spread_days:days,
      save_unit_config:!!(plant&&total&&days&&checked("pq-savecfg"))});
  };

  /* ───────── PM templates ───────── */
  window.pmOpenTemplates=async function(){S.pmEditId=null;await loadTemplates();S.modal="pmTemplates";S.modalCtx={};render()};
  function tplModal(){
    const list=S._pmTpl||[],ed=(S._pmTpl||[]).find(x=>x.id===S.pmEditId)||null;
    const ev=(k,d)=>ed&&ed[k]!=null?esc(ed[k]):(d||"");
    const rows=list.map(t=>'<tr><td>'+esc(t.equipment_type)+'</td><td><b>'+esc(t.task_name)+'</b>'+(t.checks&&t.checks.length?'<div class="muted" style="font-size:12.5px">'+t.checks.length+' reading(s) to record</div>':'')+'</td><td>'+esc(t.frequency)+'</td><td>'+(t.est_hours!=null?t.est_hours+" h":"—")+'</td><td>'+(t.units_per_day?t.units_per_day+"/day":"—")+'</td><td>'+esc(t.safety)+'</td><td style="white-space:nowrap">'+
      (isPlanner()?'<button class="btn o sm" onclick="pmAssignOpen(\''+t.id+'\')">Assign to plants</button> ':'')+
      (isHead()?'<button class="btn o sm" onclick="pmTplEdit(\''+t.id+'\')">Edit</button> <button class="btn o sm" onclick="pmTplDelete(\''+t.id+'\')">Delete</button>':'')+'</td></tr>').join("");
    const table=list.length?'<div style="overflow:auto;max-height:260px"><table><thead><tr><th>Type</th><th>Task</th><th>Frequency</th><th>Time</th><th>Units/day</th><th>Safety</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>':'<div class="muted" style="padding:12px 0">No templates yet. Add one below, or upload an Excel plan.</div>';
    const form=isHead()?'<h4 style="margin:16px 0 8px;font-size:13px">'+(ed?"Edit template":"New template")+'</h4>'+
      '<div class="kgrid" style="grid-template-columns:1fr 2fr;gap:12px">'+
       '<div class="field"><span class="lbl">Equipment type</span><select id="pt-type" class="inp">'+typeOpts(ed?ed.equipment_type:"Inverter")+'</select></div>'+
       '<div class="field"><span class="lbl">Task name</span><input id="pt-task" class="inp" value="'+ev("task_name")+'" placeholder="e.g. Inverter monthly service"/></div></div>'+
      '<div class="field"><span class="lbl">How to do it (steps)</span><textarea id="pt-steps" class="inp" rows="3" placeholder="1. Take PTW + LOTO  2. Clean fans and filters  3. Check tightness">'+ev("steps")+'</textarea></div>'+
      '<div class="kgrid" style="grid-template-columns:1fr 1fr 1fr 1fr;gap:12px">'+
       '<div class="field"><span class="lbl">How often</span><select id="pt-freq" class="inp">'+opts(FREQS,ed?ed.frequency:"Monthly")+'</select></div>'+
       '<div class="field"><span class="lbl">Safety needed</span><select id="pt-safety" class="inp">'+opts(SAFE,ed?ed.safety:"—")+'</select></div>'+
       '<div class="field"><span class="lbl">Est. time (hours)</span><input id="pt-hours" class="inp" type="number" min="0" step="0.5" value="'+ev("est_hours","2")+'"/></div>'+
       '<div class="field"><span class="lbl">Units per day</span><input id="pt-perday" class="inp" type="number" min="1" max="500" value="'+ev("units_per_day")+'" placeholder="plant setting wins"/></div></div>'+
      '<div class="field"><span class="lbl">Readings to record (one per line: Name | unit | min | max)</span><textarea id="pt-checks" class="inp" rows="3" placeholder="Heatsink temperature | C | | 75&#10;Insulation resistance | MOhm | 1">'+(ed?esc((ed.checks||[]).map(c=>[c.name,c.unit||"",c.min!=null?c.min:"",c.max!=null?c.max:""].join(" | ")).join("\n")):"")+'</textarea></div>'+
      '<button class="btn p" onclick="pmTplSave()">'+(ed?"Save changes":I.plus(14)+"Save template")+'</button>'+(ed?' <button class="btn o" onclick="pmTplEdit(null)">Cancel edit</button>':''):'';
    return modal("PM templates","Reusable jobs per equipment type. Use “Assign to plants” to create the tasks.",table+form,'<button class="btn o" onclick="closeModal()">Close</button>',true);
  }
  function parseChecks(text){
    return String(text||"").split("\n").map(l=>l.trim()).filter(Boolean).map(l=>{
      const c=l.split("|").map(x=>x.trim());
      return {name:c[0],unit:c[1]||null,min:c[2]!==undefined&&c[2]!==""?parseFloat(c[2]):null,max:c[3]!==undefined&&c[3]!==""?parseFloat(c[3]):null};
    });
  }
  window.pmTplEdit=function(id){S.pmEditId=id||null;render()};
  window.pmTplSave=async function(){
    const name=v("pt-task").trim();
    if(name.length<2){toast("Enter the task name.");return}
    try{
      const body={equipment_type:v("pt-type"),task_name:name,steps:v("pt-steps")||null,frequency:v("pt-freq"),safety:v("pt-safety"),est_hours:parseFloat(v("pt-hours"))||null,checks:parseChecks(v("pt-checks")),units_per_day:parseInt(v("pt-perday"),10)||null};
      if(S.pmEditId)await apiFetch("/api/pm-plan/templates/"+encodeURIComponent(S.pmEditId),{method:"PUT",body});
      else await apiFetch("/api/pm-plan/templates",{method:"POST",body});
      S.pmEditId=null;
      await loadTemplates();render();toast("Template saved.");
    }catch(e){toast(errText(e))}
  };
  window.pmTplDelete=async function(id){
    if(!confirm("Delete this template? Tasks already created are not affected."))return;
    try{await apiFetch("/api/pm-plan/templates/"+encodeURIComponent(id),{method:"DELETE"});await loadTemplates();render()}catch(e){toast(errText(e))}
  };

  /* ───────── Assign a template to plants ───────── */
  window.pmAssignOpen=async function(id){await loadUnitCfg();S.pmAssignId=id;S.modal="pmAssign";S.modalCtx={};render()};
  window.pmAssignAll=function(on){document.querySelectorAll(".pa-pl").forEach(e=>{e.checked=on})};
  function assignModal(){
    const t=(S._pmTpl||[]).find(x=>x.id===S.pmAssignId);
    if(!t){setTimeout(()=>{S.modal="pmTemplates";render()},0);return ""}
    const plants=(S.plants||[]).map(p=>'<label style="display:flex;gap:6px;align-items:center;font-size:12.5px"><input type="checkbox" class="pa-pl" value="'+esc(p.name)+'"/> '+esc(p.name)+'</label>').join("");
    const body='<div class="bn-info banner"><b>'+esc(t.task_name)+'</b> · '+esc(t.equipment_type)+' · '+esc(t.frequency)+'</div>'+
      '<div class="field"><span class="lbl">Plants <a href="#" onclick="pmAssignAll(true);return false" style="margin-left:8px;font-size:12.5px">select all</a> <a href="#" onclick="pmAssignAll(false);return false" style="margin-left:6px;font-size:12.5px">clear</a></span><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;max-height:200px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:10px">'+plants+'</div></div>'+
      '<div class="kgrid" style="grid-template-columns:1fr 1fr;gap:12px">'+
       '<div class="field"><span class="lbl">Assignee(s) — hold Ctrl/Cmd for several; each plant gets one assignee, plants are shared between them</span><select id="pa-assignees" class="inp" multiple size="4">'+TEAM_POOL.map(n=>'<option>'+esc(n)+'</option>').join("")+'</select></div>'+
       '<div><div class="field"><span class="lbl">First due date</span><input id="pa-due" class="inp" type="date" value="'+addDays(TODAY,3)+'"/></div>'+
       '<div class="field"><span class="lbl">Number of units (optional — else each plant\'s configuration)</span><input id="pa-units" class="inp" type="number" min="1" max="500" oninput="pmUnitHint(\'pa\')" placeholder="e.g. 10"/></div>'+
       '<div class="field"><span class="lbl">Finish within (days, optional)</span><input id="pa-days" class="inp" type="number" min="1" max="366" oninput="pmUnitHint(\'pa\')" placeholder="each plant\'s saved pace"/></div>'+
       '<div id="pa-hint" class="muted" style="font-size:12px"></div></div></div>';
    return modal("Assign to plants","Creates the tasks; plants already having an open copy are skipped.",body,
      '<button class="btn o" onclick="pmOpenTemplates()">Back</button><button class="btn p" onclick="pmAssignGo()">Create tasks</button>',true);
  }
  window.pmAssignGo=async function(){
    const names=[].slice.call(document.querySelectorAll(".pa-pl")).filter(e=>e.checked).map(e=>e.value);
    if(!names.length){toast("Tick at least one plant.");return}
    const all=names.length===(S.plants||[]).length;
    const sel=document.getElementById("pa-assignees");
    const who=sel?[].slice.call(sel.selectedOptions).map(o=>o.value):[];
    await run("/api/pm-plan/templates/"+encodeURIComponent(S.pmAssignId)+"/apply",{
      plants:all?["All plants"]:names.map(n=>{const p=plantObj(n);return p?plantKey(p):n}),
      start_date:v("pa-due"),assignees:who,per_unit:true,total_units:parseInt(v("pa-units"),10)||null,spread_days:parseInt(v("pa-days"),10)||null});
  };

  /* ───────── Maintenance scope editor (O&M Head) ───────── */
  async function loadScope(){try{const c=await apiFetch("/api/pm-plan/scope");applyScopeConfig(c);return !!(c&&c.customised)}catch(e){return null}}
  window.pmOpenScope=async function(){await loadScope();S.modal="pmScope";S.modalCtx={};render()};
  function scopeModal(){
    const secOf=n=>{if(!pmTypeVisible(n))return "hidden";const s=SCOPE_SECTIONS.find(x=>x.types&&x.types.indexOf(n)>=0);return s?s.key:"misc"};
    const choices=[["pv","PV Area / Photovoltaic Area"],["plant","Plant Side"],["gss","GSS Side"],["misc","Miscellaneous"],["hidden","Hidden — not offered in PM"]];
    const rows=TASK_TYPES.map(t=>t.name).map(n=>{const cur=secOf(n);
      return '<div class="row between" style="gap:10px;padding:6px 0;border-top:1px solid var(--border)"><span style="font-size:13px">'+esc(n)+'</span><select class="inp pm-scope-sel" data-type="'+esc(n)+'" style="max-width:250px">'+choices.map(o=>'<option value="'+o[0]+'"'+(o[0]===cur?" selected":"")+'>'+o[1]+'</option>').join("")+'</select></div>'}).join("");
    return modal("Edit maintenance scope","Choose the section for each equipment. Hidden equipment is not offered in Add PM task / template or the scope library. Existing tasks and Washing are not affected.",
      '<div style="max-height:56vh;overflow:auto;padding-right:6px">'+rows+'</div>',
      '<button class="btn o" onclick="pmScopeReset()">Restore standard lists</button><button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="pmScopeSave()">Save scope</button>',true);
  }
  window.pmScopeSave=async function(){
    const body={sections:{pv:[],plant:[],gss:[]},hidden:[]};
    [].slice.call(document.querySelectorAll(".pm-scope-sel")).forEach(e=>{const k=e.value,n=e.getAttribute("data-type");if(k==="hidden")body.hidden.push(n);else if(body.sections[k])body.sections[k].push(n)});
    try{const c=await apiFetch("/api/pm-plan/scope",{method:"PUT",body});applyScopeConfig(c);closeModal();render();toast("Maintenance scope saved.")}catch(e){toast(errText(e))}
  };
  window.pmScopeReset=async function(){
    if(!confirm("Restore the standard scope lists?"))return;
    try{await apiFetch("/api/pm-plan/scope",{method:"DELETE"});applyScopeConfig(null);closeModal();render();toast("Standard scope restored.")}catch(e){toast(errText(e))}
  };

  /* ───────── Plant unit configuration ───────── */
  window.pmOpenUnitCfg=async function(){await loadUnitCfg();S.modal="pmUnitCfg";S.modalCtx={};render()};
  function cfgModal(){
    const c=S._pmCfg||{configs:[],register:[]},regOf=x=>{const r=c.register.find(y=>y.plant_id===x.plant_id&&y.equipment_type===x.equipment_type);return r?r.units:"—"};
    const rows=c.configs.map(x=>'<tr><td>'+esc(x.plant)+'</td><td>'+esc(x.equipment_type)+'</td><td>'+x.total_units+'</td><td>'+x.units_per_day+'</td><td>'+x.days+' day(s)</td><td>'+regOf(x)+'</td>'+
      (unitEd()?'<td><button class="btn o sm" onclick="pmCfgDelete(\''+x.id+'\')">Remove</button></td>':'<td></td>')+'</tr>').join("");
    const table=c.configs.length?'<div style="overflow:auto;max-height:260px"><table><thead><tr><th>Plant</th><th>Equipment</th><th>Units</th><th>Max / day</th><th>Cycle</th><th>Register</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>':'<div class="muted" style="padding:12px 0">No unit configuration saved yet. Add one below.</div>';
    const form=unitEd()?'<h4 style="margin:16px 0 8px;font-size:13px">Set units for a plant</h4>'+
      '<div class="kgrid" style="grid-template-columns:1fr 1fr;gap:12px">'+
       '<div class="field"><span class="lbl">Plant</span><select id="uc-plant" class="inp" onchange="pmCfgPick()">'+(S.plants||[]).map(p=>'<option value="'+esc(p.name)+'">'+esc(typeof pmPlantLabelText==="function"?pmPlantLabelText(p.name):p.name)+'</option>').join("")+'</select></div>'+
       '<div class="field"><span class="lbl">Equipment type</span><select id="uc-type" class="inp" onchange="pmCfgPick()">'+typeOpts("Inverter")+'</select></div>'+
       '<div class="field"><span class="lbl">Number of units</span><input id="uc-total" class="inp" type="number" min="1" max="500" oninput="pmUnitHint(\'uc\')"/></div>'+
       '<div class="field"><span class="lbl">Max units maintained per day</span><input id="uc-perday" class="inp" type="number" min="1" max="500" oninput="pmUnitHint(\'uc\')"/></div></div>'+
      '<div id="uc-hint" class="muted" style="font-size:12px;margin:0 0 10px"></div>'+
      '<button class="btn p" onclick="pmCfgSave()">'+I.plus(14)+'Save configuration</button>':'<p class="muted" style="font-size:12px;margin-top:10px">Only the O&amp;M Head can change unit counts and daily capacity.</p>';
    return modal("PM unit configuration","How many units each plant has for an equipment type, and how many can be maintained per day. New PM tasks use these numbers.",table+form,'<button class="btn o" onclick="closeModal()">Close</button>',true);
  }
  window.pmCfgPick=function(){const r=cfgFor(v("uc-plant"),v("uc-type")),t=document.getElementById("uc-total"),d=document.getElementById("uc-perday");if(!t)return;
    t.value=r&&r.cfg?r.cfg.total_units:(r&&r.reg)||"";d.value=r&&r.cfg?r.cfg.units_per_day:"";t.placeholder=(r&&r.reg)?"Register: "+r.reg:"e.g. 10";window.pmUnitHint("uc")};
  window.pmCfgSave=async function(){
    const plant=plantObj(v("uc-plant")),total=parseInt(v("uc-total"),10),per=parseInt(v("uc-perday"),10);
    if(!plant||!total||!per){toast("Choose a plant and enter both numbers.");return}
    if(per>total){toast("Units per day cannot exceed the number of units.");return}
    try{await apiFetch("/api/pm-plan/unit-config",{method:"PUT",body:{plant:plantKey(plant),equipment_type:v("uc-type"),total_units:total,units_per_day:per}});
      await loadUnitCfg();render();toast("Unit configuration saved.")}catch(e){toast(errText(e))}
  };
  window.pmCfgDelete=async function(id){
    if(!confirm("Remove this configuration? Existing scheduled work orders will remain unchanged."))return;
    try{await apiFetch("/api/pm-plan/unit-config/"+encodeURIComponent(id),{method:"DELETE"});await loadUnitCfg();render()}catch(e){toast(errText(e))}
  };

  /* ───────── Unit schedule by day (Preventive Maintenance page) ───────── */
  window.pmUnitDays=function(tasks){
    const g={};
    (tasks||[]).filter(t=>t.unitNo&&t.status!=="Completed"&&t.status!=="Cancelled"&&t.cycleId).forEach(t=>{const k=t.plant+"|"+t.type+"|"+t.cycleId;(g[k]=g[k]||{plant:t.plant,type:t.type,total:t.totalUnits,days:{},missed:0,n:0}).n++;
      g[k].days[t.due]=(g[k].days[t.due]||0)+1;if(t.missedDays)g[k].missed++});
    return Object.values(g).sort((a,b)=>Object.keys(a.days).sort()[0].localeCompare(Object.keys(b.days).sort()[0]));
  };
  function schedulePanel(){
    let tasks=S.tasks||[];if(S.schedScope&&S.schedScope!=="all")tasks=tasks.filter(t=>t.plant===S.schedScope);
    const gs=window.pmUnitDays(tasks);if(!gs.length)return "";
    const rows=gs.slice(0,8).map(x=>{const ds=Object.keys(x.days).sort();
      return '<div style="padding:10px 0;border-top:1px solid var(--border)"><div class="row between wrap" style="gap:8px"><div><b>'+esc(x.type)+'</b> · '+esc(x.plant)+'<div class="muted" style="font-size:12.5px">'+x.n+' of '+x.total+' units open · '+ds.length+' day(s)'+(x.missed?' · <span style="color:var(--danger)">'+x.missed+' delayed unit(s) rolled</span>':'')+'</div></div></div>'+
        '<div class="row wrap" style="gap:6px;margin-top:6px">'+ds.map((d,i)=>'<span class="pill pillsm '+(d<TODAY?'b-danger':d===TODAY?'b-warning':'b-info')+'">Day '+(i+1)+' · '+fmtD(d)+' · '+x.days[d]+' unit'+(x.days[d]===1?'':'s')+'</span>').join("")+'</div></div>'}).join("");
    return '<div class="panel" id="pm-unit-days"><div class="pm-section-heading"><div><h2>Daily PM workload</h2><p>Planned unit counts by day, plant, and equipment type</p></div><span>'+gs.length+' cycle(s)</span></div>'+rows+'</div>';
  }

  /* ───────── Excel plan upload ───────── */
  window.pmImportPick=function(){
    const i=document.createElement("input");i.type="file";i.accept=".xlsx,.xlsm,.csv,text/csv";
    i.onchange=function(){if(i.files[0])pmImportFile(i.files[0])};i.click();
  };
  async function pmImportFile(file){
    const post=async dry=>{const fd=new FormData();fd.append("file",file);return apiFetch("/api/pm-plan/import?dry_run="+dry,{method:"POST",body:fd})};
    try{
      const pre=await post(true);
      const msg="Save "+pre.templates+" PM job(s) and create "+pre.tasks+" task(s)"+(pre.skipped?" ("+pre.skipped+" already scheduled will be skipped)":"")+(pre.template_only_rows?"\n"+pre.template_only_rows+" row(s) have no plant — saved as templates only.":"")+"?";
      if(!confirm(msg))return;
      const res=await post(false);
      await loadTemplates();await refreshTasks();render();
      toast(res.tasks+" task(s) created from the uploaded PM plan.");
    }catch(e){
      const d=e&&e.data&&e.data.detail,probs=d&&d.problems;
      if(probs&&probs.length){alert((d.message||"Please fix these rows")+":\n\n"+probs.slice(0,12).map(p=>"Row "+p.row+": "+p.errors.join("; ")).join("\n")+(probs.length>12?"\n…and "+(probs.length-12)+" more":""))}
      else toast(errText(e));
    }
  }

  window.pmDownloadCsvTemplate=function(){
    const cells=["Equipment type","Plant(s)","Task - what to do","Frequency - when","Safety needed","Est. time (hours)","No. of units","Units per day","Start date","Assignee"];
    const text=cells.join(",")+"\r\n";
    const blob=new Blob(["\uFEFF",text],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="Solar91_PM_CSV_Template.csv";
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
  };

  /* ───────── wire into the Preventive Maintenance page ───────── */
  const oldRM=renderModal;
  renderModal=function(){
    if(S.modal==="pmQuickTask")return quickModal();
    if(S.modal==="pmTemplates")return tplModal();
    if(S.modal==="pmAssign")return assignModal();
    if(S.modal==="pmUnitCfg")return cfgModal();
    if(S.modal==="pmScope")return scopeModal();
    return oldRM.apply(this,arguments);
  };
  function patchCard(){
    const c=document.getElementById("rev12-problem-task-card");
    if(!c)return;
    let pan=document.getElementById("pm-unit-days");const html=schedulePanel();
    if(html){if(!pan){pan=document.createElement("div");c.insertAdjacentElement("afterend",pan)}pan.outerHTML=html}else if(pan)pan.remove();
    if(c.dataset.pm)return;
    c.dataset.pm="1";
    c.innerHTML='<div class="row between wrap" style="gap:8px;align-items:center"><div title="Choose an equipment category, task, plant, unit count, daily capacity, and assignee. Work is distributed across days and repeats after completion."><div class="kpi-label" style="margin:0">PLAN PREVENTIVE MAINTENANCE</div><h2 style="font-size:14px;font-weight:800;margin:2px 0 0">Add PM tasks</h2></div>'+
      '<div class="row wrap" style="gap:8px"><button id="rev12-add-problem-task" class="btn p" onclick="openProblemScheduledTask()">'+I.plus(14)+'Add PM task</button>'+
      ((isPlanner()||role()==="Assignee")?'<button class="btn o" onclick="pmOpenUnitCfg()">Unit configuration</button><button class="btn o" onclick="pmOpenTemplates()">PM templates</button><button class="btn o" onclick="pmImportPick()">Upload Excel plan</button>':'')+'</div></div>';
  }
  const oldRender=render;
  let scopeAt=0;
  render=function(){
    oldRender.apply(this,arguments);try{patchCard()}catch(e){console.warn("[PM plan]",e)}
    /* pick up the O&M Head's saved scope once signed in (retry at most every 30 s while signed out) */
    if(S.currentUser&&["O&M Head","Assignee"].includes(AUTH_IDENTITY.role)&&Date.now()-scopeAt>30000&&!window._pmScopeOk){scopeAt=Date.now();loadScope().then(r=>{if(r!==null){window._pmScopeOk=true;if(r)render()}})}
  };
})();
