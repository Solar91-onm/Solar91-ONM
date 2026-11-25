/* Solar91 PM: database-assigned checklist tracking. No scheduling write controls. */
(function (global) {
  "use strict";
  const api = () => global.Solar91PortalAPI;
  const nav = () => global.Solar91PortalNav;
  const e = v => global.Solar91PortalFormat.escape(v == null ? "" : v);
  const todayMonth = () => new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit"}).format(new Date());
  const short = {"Inverter":"Inverter","ACCB":"ACCB","IDT Transformer":"IDT","VCB":"VCB","4 Pole + ACDB + Aux. TX":"4 Pole*","Transmission line":"TX line","GSS visit":"GSS","Earth pit":"Earth pit","Miscellaneous":"Misc."};
  const statuses = ["Approved","Pending approval","Overdue","Returned","Locked","Due today","Scheduled","Permission requested","Permission granted","Permission denied","Not assigned","Existing work order"];
  const tones = {"Approved":"green","Pending approval":"amber","Overdue":"red","Returned":"red","Locked":"purple","Due today":"today-tone","Scheduled":"blue","Not assigned":"neutral","Existing work order":"neutral","Existing completed":"green","Existing plan":"neutral"};
  const statusTone = a => tones[a.label] || "neutral";
  let rememberedMonth = "", active = null;
  const roleName = a => a.role || "";
  const dlabel = v => v ? new Intl.DateTimeFormat("en-IN",{day:"numeric",month:"short",year:"numeric",timeZone:"UTC"}).format(new Date(v.slice(0,10)+"T00:00:00Z")) : "—";
  const mlabel = v => new Intl.DateTimeFormat("en-IN",{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(v+"-01T00:00:00Z"));
  const monthKey = v => v && /^\d{4}-\d{2}$/.test(v) ? v : "";
  const shift = (v,n) => {const t=new Date(v+"-01T00:00:00Z"); t.setUTCMonth(t.getUTCMonth()+n); return t.toISOString().slice(0,7);};
  const btn = (label,action,extra="",primary=false) => `<button type="button" class="s91pm-btn${primary?" s91pm-primary":""}" data-pmx="${e(action)}" ${extra}>${e(label)}</button>`;
  const pill = (label,tone) => `<span class="s91pm-pill s91pm-${tone||tones[label]||"neutral"}">${e(label)}</span>`;
  const option = (value,label,current) => `<option value="${e(value)}"${value===current?" selected":""}>${e(label)}</option>`;
  const count = (r, predicate) => r.filter(predicate).length;
  const stats = r => ({total:r.length,approved:count(r,a=>a.status==="Approved"),pending:count(r,a=>a.status==="Pending approval"),late:count(r,a=>a.late),locked:count(r,a=>!!a.blocker),requests:count(r,a=>a.permission==="Requested"&&!!a.blocker)});
  const pct = s => s.total?Math.round(s.approved/s.total*100):null;
  const matches = (a,s) => (!s.equipment||a.equipment===s.equipment) && (!s.status||(s.status==="Overdue"?a.late||a.label==="Overdue":s.status.startsWith("Permission ")?a.permission?.toLowerCase()===s.status.slice(11):a.label===s.status)) && (!s.day||a.date===s.day) && (!s.query||[a.equipment,a.equipment_id,a.label,a.date,a.reference].join(" ").toLowerCase().includes(s.query.toLowerCase()));
  function category(a) {
    const v=String(a.planPhase||a.equipmentType||a.title||"");
    const map={"ACCB Panel":"ACCB","VCB Panel":"VCB","Transformer":"IDT Transformer","Earthing":"Earth pit","4 Pole":"4 Pole + ACDB + Aux. TX","Aux. Transformer":"4 Pole + ACDB + Aux. TX","ACDB":"4 Pole + ACDB + Aux. TX","Aux. Transformer + ACDB":"4 Pole + ACDB + Aux. TX"};
    return map[v]||v;
  }
  function enrich(s) {
    const byCode=new Map(s.data.plants.map(p=>[p.site_code,p]));
    const assigned=new Set(s.data.activities.map(a=>`${a.plant_id}|${a.equipment}|${a.date}`));
    s.activities=s.data.activities.map(a=>({...a,source:"tracking"}));
    s.legacy=s.data.legacy.map(a=>{
      const p=byCode.get(a.plantSiteCode), equipment=category(a), marker=a.source==="cycle_plan";
      return {id:"legacy:"+a.id,plant_id:p?.id,equipment,equipment_id:marker?(a.title+(a.cyclePlanState==="chained"?" · runs":"")):a.title,date:a.date,
        label:marker?(s.data.covered.includes(equipment)?"Not assigned":"Existing plan"):a.status==="Completed"?"Existing completed":a.status==="Overdue"?"Overdue":"Existing work order",
        status:a.status,late:!marker&&a.status==="Overdue",source:marker?"plan":"legacy",reference:a.reference,raw:a};
    }).filter(a=>a.plant_id&&!(a.source==="plan"&&assigned.has(`${a.plant_id}|${a.equipment}|${a.date}`)));
    s.byPlant=indexRows(s.activities);s.oldByPlant=indexRows(s.legacy);
  }
  function indexRows(rows) {const map=new Map();for(const a of rows){if(!map.has(a.plant_id))map.set(a.plant_id,[]);map.get(a.plant_id).push(a);}return map;}
  function rollup(s,p) {return s.byPlant.get(p.id)||[];}
  function old(s,p) {return s.oldByPlant.get(p.id)||[];}
  function plantStatus(r,p) {
    const n=stats(r);
    if(!n.total)return p.configured?"Awaiting SQL assignment":"Not planned";
    if(n.approved===n.total)return "Completed";
    if(n.late)return "Overdue";
    if(n.pending)return "Pending approval";
    return "On track";
  }
  function plantTone(status) {return {"Completed":"green","On track":"green","Pending approval":"amber","Overdue":"red","Awaiting SQL assignment":"neutral","Not planned":"neutral"}[status]||"neutral";}
  function progress(r) {
    const n=stats(r),p=pct(n);
    return `<div class="s91pm-progress"><div class="s91pm-ring" style="--p:${p||0}%;--ring:${n.late?'#c73528':n.pending?'#a35b05':'#00542a'}"><b>${p===null?'—':p+'%'}</b></div><div><strong>${n.approved} / ${n.total}</strong><small>approved activities</small><div class="s91pm-bar"><i style="width:${p||0}%"></i></div></div></div>`;
  }
  function kpis(s,rows,portfolio) {
    const n=stats(rows), plants=s.data.plants, planned=plants.filter(p=>p.configured||rollup(s,p).length||old(s,p).length).length;
    const arr=[portfolio?["Plants planned",`${planned} / ${plants.length}`,"Cycle plan or SQL schedule","green"]:["Approved progress",pct(n)===null?"—":pct(n)+"%",`${n.approved} of ${n.total} approved`,"green"],
      ["Scheduled",n.total,"SQL-assigned activities","blue"],["Approved",n.approved,"O&M Head reviewed","green"],["Pending approval",n.pending,"Awaiting O&M Head","amber"],["Overdue",n.late,"Past due · not approved","red"],["Locked",n.locked,`${n.requests} permission request${n.requests===1?'':'s'}`,"purple"]];
    return `<div class="s91pm-kpis">${arr.map(([t,v,sub,c])=>`<div class="s91pm-kpi s91pm-accent-${c}"><span>${t}</span><strong>${v}</strong><small>${sub}</small></div>`).join("")}</div>`;
  }
  function updatedLabel(s){return s.data?.as_of?"Data checked "+new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(s.data.as_of)):"Data time unavailable";}
  function header(s,p) {
    const title=s.view==="calendar"?(p?p.name+" · PM calendar":"PM calendar"):p?p.name:"Preventive Maintenance";
    const eyebrow=s.view==="calendar"?"PLANT CALENDAR":p?"PLANT PREVENTIVE MAINTENANCE":"PORTFOLIO VIEW";
    const sub=p?`${p.site_code}${p.district?' · '+p.district:''}${p.supervisor?' · Supervisor: '+p.supervisor:''} · ${mlabel(s.month)}`:"Monthly equipment-wise monitoring across all plants";
    const back=s.view==="calendar"?btn("← Back to plant tracker","back-calendar"):p?btn(s.parent==="plants"?"← Plant details":"← All plants","back-plant"):"";
    return `<header class="s91pm-head"><div><div class="s91pm-breadcrumb">${back}</div><small class="s91pm-eyebrow">${eyebrow}</small><h1>${e(title)}</h1><p>${e(sub)} · <span data-pmx-updated>${e(updatedLabel(s))}</span></p></div><div class="s91pm-head-actions"><label>Period<input type="month" data-pmx-filter="month" value="${e(s.month)}" aria-label="Month"></label>${p&&s.view!=="calendar"?btn("Open PM calendar →","calendar","",true):""}${btn("Export","export")}${btn("Refresh","reload")}</div></header>`;
  }
  function legend() {return `<div class="s91pm-legend">${["Approved","Pending approval","Overdue","Returned","Locked","Due today","Scheduled","Not assigned"].map(x=>pill(x)).join("")}${pill("Permission granted","blue")}${pill("Existing plan / work order","neutral")}</div>`;}
  function filters(s,portfolio) {
    const cat=s.data.categories;
    const dateOptions=Array.from(new Set([...s.activities,...s.legacy].map(a=>a.date))).sort();
    return `<div class="s91pm-filters"><input type="search" placeholder="${portfolio?'Search plant or code':'Search equipment or ID'}" aria-label="Search" data-pmx-filter="query" value="${e(s.query)}">${portfolio?`<select aria-label="Plant planning filter" data-pmx-filter="plan">${option("planned","Planned plants",s.plan)}${option("all","All plants",s.plan)}${option("unplanned","Not planned",s.plan)}</select>`:""}<select aria-label="Equipment" data-pmx-filter="equipment">${option("","All equipment",s.equipment)}${cat.map(x=>option(x,x,s.equipment)).join("")}</select><select aria-label="Status" data-pmx-filter="status">${option("","All statuses",s.status)}${statuses.concat(["Existing plan","Existing completed"]).map(x=>option(x,x,s.status)).join("")}</select>${!portfolio?`<select aria-label="Scheduled date" data-pmx-filter="day">${option("","All dates",s.day)}${dateOptions.map(x=>option(x,dlabel(x),s.day)).join("")}</select>`:""}${btn("Clear filters","clear")}${portfolio?`<div class="s91pm-toggle">${btn("Matrix","layout",`data-layout="matrix" aria-pressed="${s.layout==='matrix'}"`)}${btn("Cards","layout",`data-layout="cards" aria-pressed="${s.layout==='cards'}"`)}</div>`:""}</div>`;
  }
  function cell(s,p,cat,compact=false) {
    const r=rollup(s,p).filter(a=>a.equipment===cat), l=old(s,p).filter(a=>a.equipment===cat), n=stats(r);
    if(!r.length) {
      if(l.length) return `<div class="s91pm-cell s91pm-cell-neutral"><b>${l.some(a=>a.label==='Not assigned')?'Assign in SQL':l.some(a=>a.source==='legacy')?'Existing':'Plan only'}</b>${compact?'':`<small>${l.length} record${l.length===1?'':'s'}</small>`}</div>`;
      return `<span class="s91pm-muted">—</span>`;
    }
    const c=n.approved===n.total?"green":n.late?"red":n.pending?"amber":n.locked?"purple":"blue";
    const text=n.approved===n.total?"Approved":n.late?`${n.late} overdue`:n.pending?`${n.pending} review`:n.locked?`${n.locked} locked`:"Scheduled";
    return `<div class="s91pm-cell s91pm-cell-${c}"><div><b>${n.approved}/${n.total}</b><span>${e(text)}</span></div><div class="s91pm-cellbar"><i style="width:${pct(n)||0}%"></i></div></div>`;
  }
  function portfolio(s) {
    const rows=s.data.plants.filter(p=>{
      const r=rollup(s,p),l=old(s,p),planned=p.configured||r.length||l.length;
      return (s.plan==="all"||(s.plan==="planned"?planned:!planned))&&(!s.query||`${p.name} ${p.site_code} ${p.district}`.toLowerCase().includes(s.query.toLowerCase()))&&(!s.status&&!s.equipment||[...r,...l].some(a=>matches(a,{...s,query:""})));}).sort((a,b)=>a.name.localeCompare(b.name)||a.site_code.localeCompare(b.site_code));
    const cats=s.equipment?[s.equipment]:s.data.categories;
    return header(s)+kpis(s,s.activities,true)+`<div class="s91pm-panel"><div class="s91pm-section-head"><div><h2>Plant-wise maintenance</h2><p>Approved / SQL-assigned activities · ${rows.length} plants shown</p></div></div>${filters(s,true)}${legend()}`+
      (s.layout==="cards"?`<div class="s91pm-cards">${rows.map(p=>{const r=rollup(s,p),st=plantStatus(r,p);return `<button type="button" class="s91pm-plantcard s91pm-accent-${plantTone(st)}" data-pmx="plant" data-code="${e(p.site_code)}"><div class="s91pm-cardhead"><strong>${e(p.name)}</strong><small>${e(p.site_code)}</small></div>${progress(r)}<div class="s91pm-mini-grid">${cats.map(c=>`<div><small>${e(short[c]||c)}</small>${cell(s,p,c,true)}</div>`).join("")}</div>${pill(st,plantTone(st))}</button>`;}).join("")}</div>`:
      `<div class="s91pm-scroll"><table class="s91pm-matrix"><thead><tr><th>Plant</th><th>Approved progress</th>${cats.map(c=>`<th title="${e(c)}">${e(short[c]||c)}</th>`).join("")}<th>Attention</th></tr></thead><tbody>${rows.map(p=>{const r=rollup(s,p),n=stats(r),st=plantStatus(r,p);return `<tr><th><button class="s91pm-plant-link" data-pmx="plant" data-code="${e(p.site_code)}">${e(p.name)}<small>${e(p.site_code)} · ${e(p.district)}</small></button></th><td>${progress(r)}</td>${cats.map(c=>`<td>${cell(s,p,c)}</td>`).join("")}<td>${pill(st,plantTone(st))}<small class="s91pm-block">${n.pending} review · ${n.locked} locked</small></td></tr>`;}).join("")}</tbody></table></div>`)+(!rows.length?'<div class="s91pm-empty">No plants match these filters.</div>':"")+`<p class="s91pm-foot">* Four-pole inspection only. Existing plans/work orders are context, not included in the new checklist approval totals. Unassigned plan markers are not counted as completed.</p></div>`;
  }
  function statusBadges(a) {return pill(a.label,statusTone(a))+(a.permission==="Granted"?pill("Permission granted","blue"):a.permission==="Requested"?pill("Permission requested","amber"):a.permission==="Denied"?pill("Permission denied","red"):"")+(a.late&&a.label!=="Overdue"?pill("Past due","red"):"");}
  function rowTable(s,rows) {
    return `<div class="s91pm-scroll"><table class="s91pm-table"><thead><tr><th>Scheduled date</th><th>Equipment / Unit ID</th><th>Status</th><th>Inspected by</th><th>Inspection date</th><th>Next action</th></tr></thead><tbody>${rows.map(a=>`<tr><td>${dlabel(a.date)}</td><td><strong>${e(a.equipment_id)}</strong><small>${e(a.equipment)}</small></td><td><div class="s91pm-wrap">${statusBadges(a)}</div></td><td>${e(a.submitted_name||"—")}</td><td>${dlabel(a.inspected_on)}</td><td>${btn(a.can_review?"Review":a.can_submit?"Record PM":a.can_request?"Request permission":"View","event",`data-id="${e(a.id)}"`)}</td></tr>`).join("")}</tbody></table>${!rows.length?'<div class="s91pm-empty">No assigned activities match the selected filters.</div>':""}</div>`;
  }
  function plant(s,p) {
    const r=rollup(s,p), n=stats(r), l=old(s,p), first=r.find(a=>a.status!=="Approved"), filtered=r.filter(a=>matches(a,s));
    return header(s,p)+kpis(s,r,false)+`<div class="s91pm-plant-grid"><section class="s91pm-panel"><div class="s91pm-section-head"><div><h2>Equipment-wise progress</h2><p>Each inverter is an independent database-assigned activity.</p></div>${pill(plantStatus(r,p),plantTone(plantStatus(r,p)))}</div><div class="s91pm-eq-grid">${s.data.categories.map(c=>`<div class="s91pm-eq"><b>${e(c)}</b>${cell(s,p,c)}${!s.data.covered.includes(c)?'<small>Existing workflow</small>':c.startsWith('4 Pole')?'<small>Four-pole check only</small>':""}</div>`).join("")}</div></section><section class="s91pm-panel"><div class="s91pm-section-head"><div><h2>Sequence control</h2><p>Earlier dates must be approved first.</p></div></div>${first?`<div class="s91pm-next"><small>FIRST UNRESOLVED ACTIVITY</small><strong>${e(first.equipment_id)}</strong><span>${dlabel(first.date)} · ${e(first.label)}</span>${btn(first.can_submit?"Record PM":first.can_review?"Review PM":"Open activity","event",`data-id="${e(first.id)}"`,true)}</div>`:`<div class="s91pm-empty">${n.total?'All assigned activities approved.':'No SQL-assigned activities for this month.'}</div>`}<div class="s91pm-totals"><div><b>${n.locked}</b><small>Locked activities</small></div><div><b>${n.requests}</b><small>Permission requests</small></div><div><b>${n.pending}</b><small>Pending reviews</small></div></div><p class="s91pm-foot">An authorised override unlocks one activity, not the missed earlier task.</p></section></div><section class="s91pm-panel"><div class="s91pm-section-head"><div><h2>Monthly activity register</h2><p>${r.length} SQL-assigned activities · approved completion only</p></div>${btn("Open PM calendar →","calendar","",true)}</div>${filters(s,false)}${legend()}${rowTable(s,filtered)}</section><section class="s91pm-panel"><div class="s91pm-section-head"><div><h2>Existing schedule & work orders</h2><p>${l.length} records · planning context; not part of new checklist totals.</p></div></div>${rowTable(s,l.filter(a=>matches(a,s)))}</section>`;
  }
  function calendar(s,p) {
    const all=[...s.activities,...s.legacy].filter(a=>!p||a.plant_id===p.id).sort((a,b)=>a.date.localeCompare(b.date)||a.equipment_id.localeCompare(b.equipment_id));
    const visible=all.filter(a=>matches(a,s)), byDate={}; visible.forEach(a=>(byDate[a.date]??=[]).push(a));
    const first=new Date(s.month+"-01T00:00:00Z"), offset=first.getUTCDay(), days=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate(), cells=Math.ceil((offset+days)/7)*7;
    const selected=all.find(a=>a.id===s.selected);
    const grid=Array.from({length:cells},(_,i)=>{const day=i-offset+1;if(day<1||day>days)return '<div class="s91pm-day s91pm-outside"></div>';const key=s.month+'-'+String(day).padStart(2,'0');return `<div class="s91pm-day${key===s.data.today?' s91pm-today':''}"><span class="s91pm-daynum">${day}</span>${(byDate[key]||[]).map(a=>`<button type="button" title="${e(a.equipment_id+' · '+a.label)}" class="s91pm-event s91pm-${statusTone(a)}${a.id===s.selected?' s91pm-selected':''}" data-pmx="select" data-id="${e(a.id)}"><b>${a.blocker?'🔒 ':''}${e(a.equipment_id)}</b><small>${e(a.label)}${a.permission==='Granted'?' · Override':a.permission==='Requested'?' · Requested':''}${a.late&&a.label!=='Overdue'?' · Past due':''}</small></button>`).join("")}</div>`;}).join("");
    return header(s,p)+kpis(s,s.activities,false)+`<section class="s91pm-panel"><div class="s91pm-section-head"><div><h2>Maintenance calendar</h2><p>Schedule and equipment IDs are managed in Supabase.</p></div><div class="s91pm-head-actions">${btn("‹","prev")}<strong>${e(mlabel(s.month))}</strong>${btn("›","next")}${btn("Today","today")}</div></div>${filters(s,false)}${legend()}<div class="s91pm-cal-layout"><div class="s91pm-cal-scroll"><div class="s91pm-cal-grid">${['SUN','MON','TUE','WED','THU','FRI','SAT'].map(x=>`<div class="s91pm-weekday">${x}</div>`).join("")}${grid}</div></div><aside class="s91pm-detail" aria-label="Selected activity">${selected?detail(s,selected):'<div class="s91pm-empty"><strong>Select an activity</strong><p>View status, checklist and available actions.</p></div>'}</aside></div><p class="s91pm-foot">Colour-coded gradients indicate status. Pale-blue plan markers are existing records or awaiting SQL assignment; existing work orders are unchanged. Filters affect the calendar, not the approval totals.</p></section>`;
  }
  function detail(s,a) {
    let h=`<div class="s91pm-detail-head"><small class="s91pm-eyebrow">${a.source==='tracking'?'ASSIGNED ACTIVITY':'EXISTING RECORD'}</small><h2>${e(a.equipment_id)}</h2><p>${e(a.equipment)} · ${dlabel(a.date)}</p><div class="s91pm-wrap">${statusBadges(a)}</div></div>`;
    if(a.source!=="tracking")return h+`<p>${a.source==='plan'?(a.label==='Not assigned'?'This plan marker needs an explicit SQL assignment before a checklist can be recorded.':'No Monthly checklist is available for this equipment. Existing workflow retained.'):'Existing PM work order. Its original workflow and history are unchanged.'}</p><p><b>Reference:</b> ${e(a.reference||'—')}</p><p><b>Stored status:</b> ${e(a.raw?.status||'—')}</p>${a.raw?.assignee?`<p><b>Assignee:</b> ${e(a.raw.assignee)}</p>`:''}${a.raw?.completedOn?`<p><b>Completed on:</b> ${dlabel(a.raw.completedOn)}</p>`:''}`;
    if(a.blocker) h+=`<div class="s91pm-callout"><b>Earlier activity is unfinished</b><p>${e(a.blocker.equipment_id)} · ${dlabel(a.blocker.date)}. Approval or specific permission is required before recording this activity.</p></div>`;
    if(a.permission_reason)h+=`<div class="s91pm-note"><b>Permission ${e(a.permission.toLowerCase())}</b><p>${e(a.permission_reason)}</p><small>${e(a.requested_name||'')} · ${dlabel(a.requested_at)}</small>${a.authorisation_note?`<p>${e(a.authorisation_note)}</p><small>${e(a.authorised_name||'')} · ${dlabel(a.authorised_at)}</small>`:''}</div>`;
    if(a.review_note)h+=`<div class="s91pm-note"><b>Review note</b><p>${e(a.review_note)}</p><small>${e(a.reviewed_name||'')} · ${dlabel(a.reviewed_at)}</small></div>`;
    if(a.source==='tracking'&&a.can_submit&&s.form==='submit')return h+checkForm(s,a);
    if(a.checklist?.length)h+=`<h3>Recorded checklist</h3><p>${e(a.submitted_name||'')} · ${dlabel(a.inspected_on)}</p><div class="s91pm-results">${a.checklist.map(c=>`<div><b>${e(c.task)}</b>${pill(c.result,c.result==='OK'?'green':'red')}${c.note?`<p>${e(c.note)}</p>`:''}</div>`).join('')}</div>${a.remarks?`<p><b>Remarks:</b> ${e(a.remarks)}</p>`:''}`;
    else h+=`<h3>Monthly checklist · ${a.checks.length} checks</h3><ol class="s91pm-check-preview">${a.checks.map(c=>`<li>${e(c)}</li>`).join('')}</ol>`;
    if(a.equipment.startsWith('4 Pole'))h+='<p class="s91pm-foot">Partial scope: four-pole structure only; ACDB and auxiliary transformer are not covered.</p>';
    if(a.can_submit)h+=btn("Record PM","record","",true);
    if(a.can_request||a.can_grant||a.can_review){h+=`<form data-pmx-action-form><label>${a.can_request?'Reason for permission':a.can_grant?'Authorisation / denial reason':'Review note (required if returning)'}<textarea name="reason" rows="3" maxlength="4000" ${a.can_review?'':'required'} placeholder="Enter reason"></textarea></label><div class="s91pm-wrap">${a.can_request?`<button class="s91pm-btn s91pm-primary" name="action" value="request">Request permission</button>`:a.can_grant?`<button class="s91pm-btn s91pm-primary" name="action" value="grant">Grant permission</button><button class="s91pm-btn" name="action" value="deny">Deny</button>`:`<button class="s91pm-btn s91pm-primary" name="action" value="approve">Approve PM</button><button class="s91pm-btn s91pm-danger" name="action" value="return">Return for correction</button>`}</div></form>`;}
    if(a.status==='Approved')h+=`<div class="s91pm-note"><b>Approved by ${e(a.reviewed_name||'O&M Head')}</b><p>${dlabel(a.reviewed_at)}</p></div>`;
    if(a.status==='Pending approval'&&!a.can_review)h+='<p class="s91pm-foot">Awaiting O&M Head approval. This activity has not yet been counted as completed.</p>';
    if(!a.can_submit&&!a.can_request&&!a.can_grant&&!a.can_review&&a.status==='Scheduled'&&a.date>s.data.today)h+='<p class="s91pm-foot">Recording opens on the scheduled date.</p>';
    return h;
  }
  function checkForm(s,a) {
    const checks=a.checks.map((c,i)=>{const prev=a.checklist?.[i]||{};return `<fieldset><legend>${i+1}. ${e(c)}</legend><select name="result${i}" required aria-label="Result ${i+1}">${option("","Select result",prev.result||"")}${['OK','Not OK','Abnormality'].map(x=>option(x,x,prev.result||"")).join('')}</select><textarea rows="2" maxlength="2000" name="note${i}" placeholder="Observation (required for Not OK / Abnormality)" aria-label="Observation ${i+1}">${e(prev.note||'')}</textarea></fieldset>`;}).join('');
    return `<form data-pmx-submit-form><label>Inspection date<input name="inspected_on" type="date" min="${e(a.date)}" max="${e(s.data.today)}" value="${e(a.inspected_on||s.data.today)}" required></label>${checks}<label>General remarks<textarea name="reason" maxlength="4000" rows="3">${e(a.remarks||'')}</textarea></label><div class="s91pm-wrap"><button class="s91pm-btn s91pm-primary" type="submit">Submit for approval</button>${btn("Cancel","cancel-record")}</div><p class="s91pm-foot">Engineer identity and submission time are captured automatically. No photo upload.</p></form>`;
  }
  function render(s) {
    if(active!==s)return;
    const p=s.data?.plants.find(x=>x.site_code===s.siteCode);
    if(s.loading&&!s.data){s.host.innerHTML='<div class="s91pm"><div class="s91pm-panel s91pm-empty" role="status">Loading monthly PM tracking…</div></div>';return;}
    if(s.error&&!s.data){s.host.innerHTML=`<div class="s91pm"><div class="s91pm-panel s91pm-empty" role="alert"><b>PM tracking unavailable</b><p>${e(s.error)}</p>${btn("Retry","reload")}</div></div>`;return;}
    if(s.siteCode&&!p){s.host.innerHTML='<div class="s91pm s91pm-empty">Plant not available in your assigned scope.</div>';return;}
    s.host.innerHTML=`<div class="s91pm">${s.notice?`<div class="s91pm-notice" role="status">${e(s.notice)}</div>`:''}${s.error?`<div class="s91pm-callout" role="status">Showing last successful PM data · ${e(s.error)} ${btn("Retry","reload")}</div>`:''}${s.data.legacy_truncated?'<div class="s91pm-callout">Existing record list truncated. Select an individual plant to see its records.</div>':''}${s.view==='calendar'?calendar(s,p):p?plant(s,p):portfolio(s)}</div>`;
  }
  let pollTimer=null;
  const recent=new Map();
  const cacheKey=s=>`${s.siteCode||"portfolio"}|${s.month}`;
  function remember(s){const k=cacheKey(s);recent.delete(k);recent.set(k,{at:Date.now(),data:s.data});while(recent.size>12)recent.delete(recent.keys().next().value);}
  function routeMatches(s){const n=nav()?.getState?.();if(!n)return true;return (n.activeView==='plant-sub'?n.selectedSubPage==='pm'&&n.selectedPlant===s.siteCode:n.activeView==='view-sub'&&n.selectedViewPage==='pm'&&!s.siteCode)&&!!n.pmCalendarOpen===(s.view==='calendar');}
  function visible(s){return active===s&&routeMatches(s)&&s.host.isConnected&&s.host.offsetParent!==null&&document.visibilityState==='visible'&&!!s.host.querySelector('.s91pm');}
  function busy(s){return s.saving||s.form||!!s.host.querySelector('form[data-pmx-action-form] textarea')?.value||!!s.host.querySelector('form :focus')||!!(document.activeElement&&s.host.contains(document.activeElement)&&document.activeElement.matches('input,select,textarea'));}
  function planPoll(s){clearTimeout(pollTimer);if(!visible(s))return;const slow=global.navigator?.connection?.saveData||/2g|3g/.test(global.navigator?.connection?.effectiveType||'');pollTimer=setTimeout(()=>{if(visible(s)&&!busy(s)&&global.navigator?.onLine!==false&&!s.loading)load(s,true);else if(visible(s))planPoll(s);},Math.max(s.backoff||60000,slow?120000:60000)+Math.random()*5000);}
  async function load(s,background=false) {
    const token=++s.token,hadError=!!s.error;s.loading=true;s.error="";if(!s.data)render(s);
    try{const data=await api().request('/api/pm-plan/tracking?month='+encodeURIComponent(s.month)+(s.siteCode?'&site_code='+encodeURIComponent(s.siteCode):'&summary=true'));if(active!==s||s.token!==token||!routeMatches(s))return;
      if(background&&(!visible(s)||busy(s))){s.loading=false;planPoll(s);return;}
      const same=background&&!hadError&&s.data&&JSON.stringify({...s.data,as_of:null})===JSON.stringify({...data,as_of:null});s.data=data;enrich(s);remember(s);s.loading=false;s.backoff=60000;if(!same)render(s);else {const stamp=s.host.querySelector("[data-pmx-updated]");if(stamp)stamp.textContent=updatedLabel(s); }
    }catch(err){if(active!==s||s.token!==token||!routeMatches(s))return;s.loading=false;s.error=err?.message||'Could not load PM tracking.';s.backoff=Math.min(300000,(s.backoff||60000)*2);if(!background||visible(s)&&!busy(s))render(s);}
    planPoll(s);
  }
  function changeMonth(s,m){if(!monthKey(m))return;s.month=rememberedMonth=m;s.day='';s.selected='';s.form='';s.notice='';s.data=null;load(s);}
  function exportRows(s){const rows=[...s.activities,...s.legacy];const plants=new Map(s.data.plants.map(p=>[p.id,p]));const safe=v=>{let x=String(v??'');if(/^[\s]*[=+@-]/.test(x))x="'"+x;return '"'+x.replaceAll('"','""')+'"';};const body=[['Plant','Code','Date','Equipment','Equipment ID','Source','Status','Overdue','Permission','Inspected on','Engineer','Reviewed by'],...rows.map(a=>[plants.get(a.plant_id)?.name,plants.get(a.plant_id)?.site_code,a.date,a.equipment,a.equipment_id,a.source,a.label,a.late?'Yes':'No',a.permission,a.inspected_on,a.submitted_name,a.reviewed_name])].map(r=>r.map(safe).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\ufeff'+body],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='Solar91-PM-'+s.month+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const wired=new WeakSet();
  function wire(host){if(wired.has(host))return;wired.add(host);
    host.addEventListener('click',ev=>{const s=active;if(!s||s.host!==host)return;const b=ev.target.closest('[data-pmx]');if(!b)return;const a=b.dataset.pmx;
      if(a==='plant'){const p=s.data.plants.find(x=>x.site_code===b.dataset.code);if(p)nav().selectPlantPage(p.site_code,'pm',null,{siteCode:p.site_code,displayName:p.name,plantName:p.name,displayCode:p.site_code},{pmParent:'overview'});}
      else if(a==='calendar')nav().openPMCalendar(s.month,null);
      else if(a==='event'){nav().openPMCalendar(s.month,b.dataset.id);}
      else if(a==='back-calendar')nav().closePMCalendar();
      else if(a==='back-plant'){if(s.parent==='plants')nav().selectPlantPage(s.siteCode,'details');else nav().selectView('pm');}
      else if(a==='reload')load(s);
      else if(a==='export')exportRows(s);
      else if(a==='prev'||a==='next')changeMonth(s,shift(s.month,a==='prev'?-1:1));
      else if(a==='today')changeMonth(s,s.data.today.slice(0,7));
      else if(a==='clear'){s.query=s.equipment=s.status=s.day='';render(s);}
      else if(a==='layout'){s.layout=b.dataset.layout==='cards'?'cards':'matrix';render(s);}
      else if(a==='select'){s.selected=b.dataset.id;s.form='';s.notice='';render(s);if(global.matchMedia('(max-width: 950px)').matches)host.querySelector('.s91pm-detail')?.scrollIntoView({block:'nearest'});}
      else if(a==='record'||a==='cancel-record'){s.form=a==='record'?'submit':'';render(s);}
    });
    host.addEventListener('change',ev=>{const s=active,k=ev.target.dataset.pmxFilter;if(!s||s.host!==host||!k||k==='query')return;if(k==='month')changeMonth(s,ev.target.value);else if(['equipment','status','day','plan'].includes(k)){s[k]=ev.target.value;render(s);}});
    host.addEventListener('input',ev=>{const s=active;if(!s||s.host!==host||ev.target.dataset.pmxFilter!=='query')return;const pos=ev.target.selectionStart;s.query=ev.target.value;render(s);const q=host.querySelector('[data-pmx-filter="query"]');q?.focus();try{q?.setSelectionRange(pos,pos);}catch(_){}});
    host.addEventListener('submit',async ev=>{const s=active;if(!s||s.host!==host||!ev.target.matches('[data-pmx-action-form],[data-pmx-submit-form]'))return;ev.preventDefault();if(s.saving)return;
      const form=ev.target, a=s.activities.find(x=>x.id===s.selected);if(!a)return;
      const fd=new FormData(form), submit=form.matches('[data-pmx-submit-form]'), action=submit?'submit':ev.submitter?.value;
      if(!action)return;
      const payload={action,reason:String(fd.get('reason')||'')};
      if(submit){payload.inspected_on=fd.get('inspected_on');payload.checks=a.checks.map((_,i)=>({result:fd.get('result'+i),note:String(fd.get('note'+i)||'')}));}
      const errNode=document.createElement('p');errNode.className='s91pm-form-error';errNode.setAttribute('role','alert');form.querySelector('.s91pm-form-error')?.remove();
      s.saving=true;Array.from(form.querySelectorAll('button')).forEach(b=>b.disabled=true);
      try{await api().request('/api/pm-plan/tracking/'+encodeURIComponent(a.id)+'/action',{method:'POST',body:payload});recent.clear();if(active!==s||!routeMatches(s))return;s.form='';s.notice={submit:'Checklist submitted for O&M Head approval.',approve:'PM approved. Sequence recalculated.',return:'PM returned for correction.',request:'Permission requested.',grant:'Permission granted for this activity only.',deny:'Permission denied.'}[action];await load(s);}
      catch(err){if(active===s){errNode.textContent=err?.message||'Action could not be saved.';form.append(errNode);}}
      finally{s.saving=false;Array.from(form.querySelectorAll('button')).forEach(b=>b.disabled=false);}
    });
  }
  function show(host,opts={}){if(!host)return;const month=monthKey(opts.initialMonth)||rememberedMonth||todayMonth();rememberedMonth=month;const siteCode=opts.siteCode||null;const s={host,siteCode,parent:opts.parent||'overview',view:opts.calendar?'calendar':'overview',month,selected:opts.eventId||'',form:'',query:'',status:'',equipment:'',day:'',plan:'planned',layout:'matrix',loading:true,error:'',notice:'',saving:false,token:0};const cached=recent.get(cacheKey(s));if(cached&&Date.now()-cached.at<60000){s.data=cached.data;enrich(s);}active=s;wire(host);if(s.data)render(s);load(s,!!s.data);}
  function resume(){if(active&&visible(active)&&!busy(active)&&!active.loading&&global.navigator?.onLine!==false)load(active,true);}
  document.addEventListener('portal:data-invalidated',()=>{recent.clear();});
  document.addEventListener('portal:route-changed',()=>{if(active&&!routeMatches(active)){clearTimeout(pollTimer);active=null;}});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')resume();else clearTimeout(pollTimer);});
  global.addEventListener('online',resume);
  global.Solar91PMTracking={show};
}(window));
