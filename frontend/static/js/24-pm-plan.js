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
  const ONE_JOB=typeof PM_ONE_JOB_TYPES!=="undefined"?PM_ONE_JOB_TYPES:[];   /* one PM job per plant (app/pmplan/cycle.py ONE_JOB_TYPES) */
  const ONE_JOB_NOTE={"ACCB Panel":"ACCB-1 and ACCB-2 are maintained together as one job","Aux. Transformer":"One Aux. Transformer per plant","ACDB":"One ACDB per plant","Miscellaneous":"The chosen items are one job"};
  const MISC_ITEMS=typeof PM_MISC_ITEMS!=="undefined"?PM_MISC_ITEMS:[];
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
    if(!N&&checked(p+"-cycle")){el.textContent="Leave blank to spread each plant's units over this equipment's days in the PM cycle.";return}
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
  /* 30-day PM cycle: Plant side (Inverter days 1–7, ACCB, VCB, …) then GSS side. Source: GET /api/pm-plan/cycle. */
  async function loadCycle(){if(!S._pmCycle)try{S._pmCycle=await apiFetch("/api/pm-plan/cycle")}catch(e){}return S._pmCycle}
  function cycleWin(type,start){
    const ph=(S._pmCycle&&S._pmCycle.phases)||[];if(!ph.length||!start)return null;
    const p=ph.find(x=>x.equipment_types.indexOf(type)>=0)||ph.find(x=>x.phase==="Miscellaneous");if(!p)return null;
    return Object.assign({},p,{start:addDays(start,p.start_day-1),end:addDays(start,p.end_day-1)});
  }
  const cycleText=w=>w.area+" · "+w.phase+" — cycle day"+(w.days>1?"s "+w.start_day+"–"+w.end_day:" "+w.start_day)+": "+fmtD(w.start)+(w.days>1?" → "+fmtD(w.end):"");
  window.pmCycleHint=function(p){
    const el=document.getElementById(p+"-cyc"),on=checked(p+"-cycle");if(!el)return;
    const lbl=document.getElementById(p+"-due-lbl");if(lbl)lbl.textContent=on?"Cycle start date (day 1)":"First due date";
    const type=p==="pq"?v("pq-type"):((S._pmTpl||[]).find(x=>x.id===S.pmAssignId)||{}).equipment_type;
    const w=on?cycleWin(type,v(p+"-due")):null;
    el.textContent=on?(w?cycleText(w)+". Repeats on the same cycle days next month.":"Loading the PM cycle…"):"";
    const d=document.getElementById(p+"-days");if(d&&on&&w)d.placeholder="Cycle: "+w.days+" day"+(w.days===1?"":"s");
    else if(d&&!on&&/^Cycle:/.test(d.placeholder))d.placeholder=p==="pq"?"e.g. 3":"each plant's saved pace";
  };
  const cycleBox=p=>'<label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin:0 0 4px"><input id="'+p+'-cycle" type="checkbox" checked onchange="pmCycleHint(\''+p+'\');pmUnitHint(\''+p+'\')"/> Follow the 30-day PM cycle (Plant side, then GSS side) — dates come from this equipment\'s turn</label>'+
    '<div id="'+p+'-cyc" class="muted" style="font-size:12px;margin:0 0 10px"></div>';

  /* Dry-run first so the person sees the count, then create. */
  async function run(url,body){
    try{
      const pre=await apiFetch(url,{method:"POST",body:Object.assign({},body,{dry_run:true})});
      if(!pre.count){toast(pre.skipped?("Nothing new to create — "+pre.skipped+" already scheduled."):"Nothing to create.");return false}
      const note=pre.open_without_units?"\n\nNote: "+pre.open_without_units+" open task(s) for this job already exist without unit numbers. They are left as they are.":"";
      const moved=(pre.cycle_moved||[]).map(m=>"• "+m.plant+": "+fmtD(m.start)+(m.end!==m.start?" → "+fmtD(m.end):"")+" (moved "+m.moved_days+" day(s) to follow earlier work there)");
      const cyc=pre.cycle?"\n\nPM cycle: "+cycleText(pre.cycle)+"."+(moved.length?"\n"+moved.slice(0,8).join("\n")+(moved.length>8?"\n…and "+(moved.length-8)+" more":""):""):"";
      const noKit=(pre.skipped_plants||[]).length?"\n\nSkipped "+pre.skipped_plants.length+" plant(s) with no "+(body.equipment_type||"such equipment")+" registered: "+pre.skipped_plants.slice(0,8).join(", ")+(pre.skipped_plants.length>8?"…":""):"";
      if((pre.count>1||note||noKit||cyc)&&!confirm("Create "+pre.count+" task(s) across "+pre.plants+" plant(s)"+(pre.days>1?", spread over up to "+pre.days+" day(s)":"")+(pre.skipped?" ("+pre.skipped+" already scheduled will be skipped)":"")+"?"+cyc+note+noKit))return false;
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
    /* ACCB-1 + ACCB-2 and the Miscellaneous items are one job per plant; the server plans them as one unit too */
    const one=ONE_JOB.indexOf(v("pq-type"))>=0;t.disabled=one;
    if(one){t.value="1";t.title=ONE_JOB_NOTE[v("pq-type")]||"One job per plant"}else t.title="";
    const misc=document.getElementById("pq-misc");if(misc)misc.style.display=v("pq-type")==="Miscellaneous"?"":"none";
    const task=document.getElementById("pq-task");if(task&&v("pq-type")==="Miscellaneous"&&!task.value.trim())task.value="Miscellaneous PM";else if(task&&v("pq-type")!=="Miscellaneous"&&task.value==="Miscellaneous PM")task.value="";
    window.pmCycleHint("pq");
    window.pmUnitHint("pq");
  };
  window.pmQuickFill=function(){ /* typed task matches a saved template → copy its settings */
    const t=(S._pmTpl||[]).find(x=>x.equipment_type===v("pq-type")&&x.task_name===v("pq-task").trim());
    if(!t)return;
    const set=(id,val)=>{const e=document.getElementById(id);if(e&&val!==null&&val!==undefined)e.value=val};
    set("pq-freq",t.frequency);set("pq-safety",t.safety);set("pq-hours",t.est_hours);
    window.pmUnitHint("pq");
  };
  window.openProblemScheduledTask=async function(type){
    if(!canCreate()){toast("Site Engineer can execute assigned Preventive Maintenance work, but cannot create it.");return}
    S._pmAddType=typeof type==="string"?type:null;   /* "+ Add job" on an equipment coverage row */
    S.modal="pmQuickTask";S.modalCtx={};render();
    setTimeout(()=>{try{window.pmQuickCfg()}catch(e){}},0);
    Promise.all([loadTemplates(),loadUnitCfg(),loadCycle()]).then(()=>{
     if(S.modal!=="pmQuickTask")return;
     window.pmCycleHint("pq");
     const dl=document.getElementById("pq-sugg");if(dl)dl.innerHTML=suggestions(v("pq-type")).map(x=>'<option value="'+esc(x)+'"></option>').join("");
     const total=document.getElementById("pq-total");if(total&&!total.value)try{window.pmQuickCfg()}catch(e){}
    });
  };
  function quickModal(){
    const types=typeNames(),filteredType=S._pmAddType||(S.pmLive&&S.pmLive.equipment&&S.pmLive.equipment!=="all"?S.pmLive.equipment:null);
    const type=filteredType&&types.includes(filteredType)?filteredType:(types.indexOf("Inverter")>=0?"Inverter":(types[0]||"Other"));
    const activePmPlant=S.pmLive&&S.pmLive.plant&&S.pmLive.plant!=="all"?S.pmLive.plant:null;
    const first=activePmPlant||(S.schedScope&&S.schedScope!=="all"?S.schedScope:"__all");
    const body='<div class="pm-form">'+
      '<div class="kgrid" style="grid-template-columns:1fr 1fr;gap:12px">'+
       '<div class="field"><span class="lbl">Equipment type</span><select id="pq-type" class="inp" onchange="pmQuickType()">'+typeOpts(type)+'</select></div>'+
       '<div class="field"><span class="lbl">Plant</span><select id="pq-plant" class="inp" onchange="pmQuickCfg()"><option value="__all"'+(first==="__all"?" selected":"")+'>All plants</option>'+(S.plants||[]).map(p=>'<option value="'+esc(p.name)+'"'+(p.name===first?" selected":"")+'>'+esc(typeof pmPlantLabelText==="function"?pmPlantLabelText(p.name):p.name)+'</option>').join("")+'</select></div>'+
      '</div>'+
      '<div class="field"><span class="lbl">Task — what to do</span><input id="pq-task" class="inp" list="pq-sugg" oninput="pmQuickFill()" placeholder="Pick a suggestion or type your own"/><datalist id="pq-sugg">'+suggestions(type).map(x=>'<option value="'+esc(x)+'"></option>').join("")+'</datalist></div>'+
      /* Miscellaneous: pick what this one job covers; the choice is saved as the task's remark */
      '<div id="pq-misc" class="field"'+(type==="Miscellaneous"?'':' style="display:none"')+'><span class="lbl">Items in this Miscellaneous job (saved as the remark)</span>'+
       '<div style="display:flex;flex-wrap:wrap;gap:6px 16px;margin:2px 0 6px">'+MISC_ITEMS.map(x=>'<label style="display:flex;gap:6px;align-items:center;font-size:12.5px"><input type="checkbox" class="pq-misc-item" value="'+esc(x)+'"/> '+esc(x)+'</label>').join("")+'</div>'+
       '<input id="pq-misc-other" class="inp" maxlength="200" placeholder="Other item(s), optional — e.g. fire extinguisher"/></div>'+cycleBox("pq")+
      '<div class="kgrid" style="grid-template-columns:1fr 1fr 1fr;gap:12px">'+
       '<div class="field"><span class="lbl">Number of units</span><input id="pq-total" class="inp" type="number" min="1" max="500" oninput="pmUnitHint(\'pq\')"/></div>'+
       '<div class="field"><span class="lbl">Finish within (days)</span><input id="pq-days" class="inp" type="number" min="1" max="366" placeholder="e.g. 3" oninput="pmUnitHint(\'pq\')"/></div>'+
       '<div class="field"><span class="lbl">Daily workload</span><div class="inp" style="display:flex;align-items:center;color:var(--muted-foreground)">Worked out for each plant</div></div></div>'+
      '<div id="pq-hint" class="muted" style="font-size:12px;margin:-2px 0 10px"></div>'+
      (isHead()?'<label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin:0 0 10px"><input id="pq-savecfg" type="checkbox"/> Save these unit counts as the plant default (when one plant is selected)</label>':'')+
      '<div class="kgrid" style="grid-template-columns:1fr 1fr;gap:12px">'+
       '<div class="field"><span class="lbl">Assignee</span><select id="pq-assignee" class="inp"><option value="">Assign later</option>'+opts(TEAM_POOL,S.currentUser)+'</select></div>'+
       '<div class="field"><span class="lbl">How often</span><select id="pq-freq" class="inp">'+opts(FREQS,"Monthly")+'</select></div>'+
       '<div class="field"><span class="lbl" id="pq-due-lbl">Cycle start date (day 1)</span><input id="pq-due" class="inp" type="date" value="'+addDays(TODAY,3)+'" oninput="pmCycleHint(\'pq\')"/></div>'+
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
    let remarks=null;
    if(v("pq-type")==="Miscellaneous"){
      const items=[].slice.call(document.querySelectorAll(".pq-misc-item")).filter(e=>e.checked).map(e=>e.value),other=v("pq-misc-other").trim();
      if(other)items.push(other);
      if(!items.length){toast("Choose at least one item for the Miscellaneous job (e.g. Street Light, ERT).");return}
      remarks=items.join(", ");
    }
    await run("/api/pm-plan/tasks",{remarks,
      equipment_type:v("pq-type"),task_name:task,frequency:v("pq-freq"),safety:v("pq-safety"),
      est_hours:parseFloat(v("pq-hours"))||null,plants:plant?[plantKey(plant)]:["All plants"],
      start_date:v("pq-due"),assignees:v("pq-assignee")?[v("pq-assignee")]:[],
      per_unit:true,save_template:checked("pq-save"),
      total_units:total,spread_days:days,follow_cycle:checked("pq-cycle"),
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
  window.pmAssignOpen=async function(id){await Promise.all([loadUnitCfg(),loadCycle()]);S.pmAssignId=id;S.modal="pmAssign";S.modalCtx={};render();setTimeout(()=>{try{window.pmCycleHint("pa");window.pmUnitHint("pa")}catch(e){}},0)};
  window.pmAssignAll=function(on){document.querySelectorAll(".pa-pl").forEach(e=>{e.checked=on})};
  function assignModal(){
    const t=(S._pmTpl||[]).find(x=>x.id===S.pmAssignId);
    if(!t){setTimeout(()=>{S.modal="pmTemplates";render()},0);return ""}
    const plants=(S.plants||[]).map(p=>'<label style="display:flex;gap:6px;align-items:center;font-size:12.5px"><input type="checkbox" class="pa-pl" value="'+esc(p.name)+'"/> '+esc(p.name)+'</label>').join("");
    const body='<div class="bn-info banner"><b>'+esc(t.task_name)+'</b> · '+esc(t.equipment_type)+' · '+esc(t.frequency)+'</div>'+
      '<div class="field"><span class="lbl">Plants <a href="#" onclick="pmAssignAll(true);return false" style="margin-left:8px;font-size:12.5px">select all</a> <a href="#" onclick="pmAssignAll(false);return false" style="margin-left:6px;font-size:12.5px">clear</a></span><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;max-height:200px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:10px">'+plants+'</div></div>'+
      '<div class="kgrid" style="grid-template-columns:1fr 1fr;gap:12px">'+
       '<div class="field"><span class="lbl">Assignee(s) — hold Ctrl/Cmd for several; each plant gets one assignee, plants are shared between them</span><select id="pa-assignees" class="inp" multiple size="4">'+TEAM_POOL.map(n=>'<option>'+esc(n)+'</option>').join("")+'</select></div>'+
       '<div><div class="field"><span class="lbl" id="pa-due-lbl">Cycle start date (day 1)</span><input id="pa-due" class="inp" type="date" value="'+addDays(TODAY,3)+'" oninput="pmCycleHint(\'pa\')"/></div>'+cycleBox("pa")+
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
      start_date:v("pa-due"),assignees:who,per_unit:true,total_units:parseInt(v("pa-units"),10)||null,spread_days:parseInt(v("pa-days"),10)||null,
      follow_cycle:checked("pa-cycle")});
  };

  /* ───────── Maintenance scope editor (O&M Head) ───────── */
  async function loadScope(){try{const c=await apiFetch("/api/pm-plan/scope");applyScopeConfig(c);return !!(c&&c.customised)}catch(e){return null}}
  window.pmOpenScope=async function(){await loadScope();S.modal="pmScope";S.modalCtx={};render()};
  function scopeModal(){
    const secOf=n=>{if(!pmTypeVisible(n))return "hidden";const s=SCOPE_SECTIONS.find(x=>x.types&&x.types.indexOf(n)>=0);return s?s.key:"misc"};
    const choices=[["pv","PV Area / Photovoltaic Area"],["plant","Plant Side"],["gss","GSS Side"],["misc","Miscellaneous"],["hidden","Hidden — not offered in PM"]];
    const rows=TASK_TYPES.map(t=>t.name).filter(n=>PM_NOT_IN_PM.indexOf(n)<0).map(n=>{const cur=secOf(n);
      return '<div class="row between" style="gap:10px;padding:6px 0;border-top:1px solid var(--border)"><span style="font-size:13px">'+esc(n)+'</span><select class="inp pm-scope-sel" data-type="'+esc(n)+'" style="max-width:250px">'+choices.map(o=>'<option value="'+o[0]+'"'+(o[0]===cur?" selected":"")+'>'+o[1]+'</option>').join("")+'</select></div>'}).join("");
    return modal("Edit maintenance scope","Choose the section for each equipment. Hidden equipment is not offered in Add PM task / template or the scope library. Existing tasks and Washing are not affected.",
      '<div style="max-height:56vh;overflow:auto;padding-right:6px">'+rows+'</div>',
      '<button class="btn o" onclick="pmScopeReset()">Restore standard lists</button><button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="pmScopeSave()">Save scope</button>',true);
  }
  window.pmScopeSave=async function(){
    /* `known`: every type on screen now, so equipment added to the standard lists later can be placed automatically */
    const body={sections:{pv:[],plant:[],gss:[]},hidden:[],known:TASK_TYPES.map(t=>t.name)};
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
  /* Step 1: choose whether the file's dates follow the 30-day PM cycle, and the cycle start. Step 2: pick the file. */
  window.pmImportPick=async function(){S.modal="pmImport";S.modalCtx={};render();await loadCycle();if(S.modal==="pmImport"){render();window.pmImportDates()}};
  function importModal(){
    const body='<label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin:0 0 8px"><input id="im-cycle" type="checkbox" checked onchange="pmImportDates()"/> Set the dates from the 30-day PM cycle (Plant side, then GSS side)</label>'+
      '<div class="field" style="max-width:240px"><span class="lbl">Cycle start date (day 1)</span><input id="im-start" class="inp" type="date" value="'+addDays(TODAY,3)+'" oninput="pmImportDates()"/></div>'+
      '<p id="im-note" class="muted" style="font-size:12px;margin:0 0 8px"></p>'+
      '<p style="font-size:12.5px;margin:0 0 8px">Templates: <a href="/static/templates/PM_Plant_Side_Template.xlsx" download>Plant side Excel</a> · <a href="/static/templates/PM_GSS_Side_Template.xlsx" download>GSS side Excel</a> — each file only accepts its own side\'s equipment.</p>'+
      '<div id="im-table" style="overflow:auto;max-height:46vh"></div>';
    return modal("Upload PM plan (Excel / CSV)","Each row's equipment is scheduled on its own days of the cycle. Next month repeats on the same cycle days.",body,
      '<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" onclick="pmImportChoose()">Choose file…</button>',true);
  }
  window.pmImportDates=function(){
    const tb=document.getElementById("im-table"),note=document.getElementById("im-note");if(!tb)return;
    const on=checked("im-cycle"),start=v("im-start"),ph=(S._pmCycle&&S._pmCycle.phases)||[];
    note.textContent=on?"Equipment is done in the order below, one after the other. If earlier work at a plant runs longer than its days (e.g. a 10-day inverter round), the next equipment starts the day after it and the rest move with it — the confirmation shows the final dates. Inverter units are spread over their days; a single unit (one VCB, one IDT…) is due on the last day of its turn. A row's own Start date (general template only) is that row's cycle start."
      :"Dates are taken exactly as written in each row's Start date (blank = 3 days from today).";
    if(!on){tb.innerHTML="";return}
    if(!ph.length){tb.innerHTML='<div class="muted" style="padding:8px 0">Could not load the PM cycle.</div>';return}
    tb.innerHTML='<table><thead><tr><th>Area</th><th>Equipment</th><th>Cycle days</th><th>Dates</th></tr></thead><tbody>'+ph.map(p=>'<tr><td>'+esc(p.area)+'</td><td><b>'+esc(p.phase)+'</b><div class="muted" style="font-size:12px">'+esc(p.equipment_types.length?p.equipment_types.join(", "):"Every other equipment type")+'</div></td><td>'+(p.days>1?p.start_day+"–"+p.end_day:p.start_day)+'</td><td>'+(start?fmtD(addDays(start,p.start_day-1))+(p.days>1?" → "+fmtD(addDays(start,p.end_day-1)):""):"—")+'</td></tr>').join("")+'</tbody></table>';
  };
  window.pmImportChoose=function(){
    const o={cycle:checked("im-cycle"),start:v("im-start")};
    if(o.cycle&&!o.start){toast("Choose the cycle start date.");return}
    const i=document.createElement("input");i.type="file";i.accept=".xlsx,.xlsm,.csv,text/csv";
    i.onchange=function(){if(i.files[0])pmImportFile(i.files[0],o)};i.click();
  };
  async function pmImportFile(file,o){
    o=o||{};
    const q=o.cycle?"&follow_cycle=true"+(o.start?"&cycle_start="+encodeURIComponent(o.start):""):"";
    const post=async dry=>{const fd=new FormData();fd.append("file",file);return apiFetch("/api/pm-plan/import?dry_run="+dry+q,{method:"POST",body:fd})};
    try{
      const pre=await post(true);
      const sch=(pre.schedule||[]).map(x=>"• "+x.equipment_type+" ("+x.area+"): "+fmtD(x.start)+(x.end!==x.start?" → "+fmtD(x.end):"")+" · "+x.tasks+" task(s)"+((x.plants||[]).length>1?" · "+x.plants.length+" plants":"")+(x.moved_days?" · moved "+x.moved_days+" day(s) after earlier work":"")+(x.past_cycle_days?" · "+x.past_cycle_days+" day(s) past the 30-day cycle":""));
      const msg="Save "+pre.templates+" PM job(s) and create "+pre.tasks+" task(s)"+(pre.skipped?" ("+pre.skipped+" already scheduled will be skipped)":"")+(pre.template_only_rows?"\n"+pre.template_only_rows+" row(s) have no plant — saved as templates only.":"")+"?"+
        (sch.length?"\n\nDates from the 30-day PM cycle:\n"+sch.slice(0,16).join("\n")+(sch.length>16?"\n…and "+(sch.length-16)+" more":""):"");
      if(!confirm(msg))return;
      const res=await post(false);
      if(S.modal==="pmImport"){S.modal=null;S.modalCtx=null}
      await loadTemplates();await refreshTasks();render();
      toast(res.tasks+" task(s) created from the uploaded PM plan.");
    }catch(e){
      const d=e&&e.data&&e.data.detail,probs=d&&d.problems;
      if(probs&&probs.length){alert((d.message||"Please fix these rows")+":\n\n"+probs.slice(0,12).map(p=>"Row "+p.row+": "+p.errors.join("; ")).join("\n")+(probs.length>12?"\n…and "+(probs.length-12)+" more":""))}
      else toast(errText(e));
    }
  }

  window.pmDownloadCsvTemplate=function(){
    const cells=["Equipment type","Plant(s)","Task - what to do","Frequency - when","Safety needed","Est. time (hours)","No. of units","Units per day","Start date","Assignee","Remarks"];
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
    if(S.modal==="pmImport")return importModal();
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
