/* Solar91 PM: database-assigned checklist tracking and recurring schedule management. */
(function (global) {
  "use strict";
  const api = () => global.Solar91PortalAPI;
  const nav = () => global.Solar91PortalNav;
  const e = v => global.Solar91PortalFormat.escape(v == null ? "" : v);
  const todayMonth = () => new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit"}).format(new Date());
  const short = {"Inverter":"Inverter","ACCB":"ACCB","IDT Transformer":"IDT","VCB":"VCB","4 Pole + ACDB + Aux. TX":"4 Pole + ACDB + Aux","Transmission line":"TX line","GSS visit":"GSS","Earth pit":"Earth pit","Miscellaneous":"Misc."};
  const statuses = ["Approved","Pending approval","Overdue","Returned","Locked","Due today","Scheduled","Permission requested","Permission granted","Permission denied","Not assigned","Existing work order"];
  const tones = {"Approved":"green","Pending approval":"amber","Overdue":"red","Returned":"red","Locked":"purple","Due today":"today-tone","Scheduled":"blue","Not assigned":"neutral","Existing work order":"neutral","Existing completed":"green","Existing plan":"neutral"};
  const statusTone = a => tones[a.label] || "neutral";
  let rememberedMonth = "", active = null, portfolioMemo = null;
  const roleName = a => a.role || "";
  const dlabel = v => v ? new Intl.DateTimeFormat("en-IN",{day:"numeric",month:"short",year:"numeric",timeZone:"UTC"}).format(new Date(v.slice(0,10)+"T00:00:00Z")) : "—";
  const mlabel = v => new Intl.DateTimeFormat("en-IN",{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(v+"-01T00:00:00Z"));
  const monthKey = v => v && /^\d{4}-\d{2}$/.test(v) ? v : "";
  const shift = (v,n) => {const t=new Date(v+"-01T00:00:00Z"); t.setUTCMonth(t.getUTCMonth()+n); return t.toISOString().slice(0,7);};
  // Opening a plant's calendar leaves the all-plants dashboard behind; coming back puts it back
  // as it was - same search, filters, layout and scroll position. One-shot: the next portfolio
  // render consumes it, so an unrelated later visit still opens clean.
  const keepPortfolio = s => {if(s.siteCode||s.view==="calendar")return;portfolioMemo={query:s.query,status:s.status,equipment:s.equipment,day:s.day,selectedDate:s.selectedDate,compliance:s.compliance,plan:s.plan,layout:s.layout,filtersOpen:s.filtersOpen,scroll:global.scrollY||global.pageYOffset||0};};
  function takePortfolio(s) {
    if(!portfolioMemo)return;
    const m=portfolioMemo; portfolioMemo=null;
    s.query=m.query;s.status=m.status;s.equipment=m.equipment;s.day=m.day;s.selectedDate=m.selectedDate?.slice(0,7)===s.month?m.selectedDate:"";s.compliance=m.compliance;s.plan=m.plan;s.layout=m.layout;s.filtersOpen=m.filtersOpen;s.restoreScroll=m.scroll;
  }
  const toTop = () => {if(typeof global.scrollTo==="function")global.scrollTo(0,0);};
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
    s.activities=s.data.activities.map(a=>({...a,source:"tracking",
      equipment_id:a.equipment==="4 Pole + ACDB + Aux. TX"&&a.equipment_id==="4 Pole — structure inspection"?"4 Pole + ACDB + Aux. TX — plant visit":a.equipment_id}));
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
  const complianceLabels={on_schedule:"On schedule",behind:"Behind",not_started:"Not started",not_planned:"Not planned"};
  const complianceTones={on_schedule:"green",behind:"red",not_started:"amber",not_planned:"neutral"};
  const complianceBadge=p=>p.compliance?pill(complianceLabels[p.compliance]||p.compliance,complianceTones[p.compliance]||"neutral"):"";
  function progress(r) {
    const n=stats(r),p=pct(n);
    return `<div class="s91pm-progress"><div class="s91pm-ring" style="--p:${p||0}%;--ring:${n.late?'#c73528':n.pending?'#a35b05':'#00542a'}"><b>${p===null?'—':p+'%'}</b></div><div><strong>${n.approved} / ${n.total}</strong><small>approved activities</small><div class="s91pm-bar"><i style="width:${p||0}%"></i></div></div></div>`;
  }
  function kpis(s,rows,portfolio) {
    const n=stats(rows), plants=s.data.plants, planned=plants.filter(p=>p.configured||rollup(s,p).length||old(s,p).length).length;
    const arr=[portfolio?["Plants planned",`${planned} / ${plants.length}`,s.selectedDate||s.compliance?"Within selected filters":"Cycle plan or SQL schedule","green"]:["Approved progress",pct(n)===null?"—":pct(n)+"%",`${n.approved} of ${n.total} approved`,"green"],
      ["Scheduled",n.total,"SQL-assigned activities","blue"],["Approved",n.approved,"O&M Head reviewed","green"],["Pending approval",n.pending,"Awaiting O&M Head","amber"],["Overdue",n.late,"Past due · not approved","red"],["Locked",n.locked,`${n.requests} permission request${n.requests===1?'':'s'}`,"purple"]];
    return `<div class="s91pm-kpis">${arr.map(([t,v,sub,c])=>`<div class="s91pm-kpi s91pm-accent-${c}"><span>${t}</span><strong>${v}</strong><small>${sub}</small></div>`).join("")}</div>`;
  }
  function updatedLabel(s){return s.data?.as_of?"Data checked "+new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}).format(new Date(s.data.as_of)):"Data time unavailable";}
  const canManageSchedule = s => !s.siteCode && s.view === "overview" && ["O&M Head","Assignee"].includes(s.data?.role);
  function header(s,p) {
    const title=s.view==="calendar"?(p?p.name+" · PM calendar":"PM calendar"):p?p.name:"Preventive Maintenance";
    const eyebrow=s.view==="calendar"?"PLANT CALENDAR":p?"PLANT PREVENTIVE MAINTENANCE":"PORTFOLIO VIEW";
    const sub=p?p.site_code+" · PM Assignee: "+(p.pm_assignee||"Unassigned"):"Monthly equipment-wise monitoring across all plants";
    const back=s.view==="calendar"?btn(s.calendarParent==="overview"?"← Back to all plants":"← Back to plant tracker","back-calendar"):p?btn(s.parent==="plants"?"← Plant details":"← All plants","back-plant"):"";
    const summaryExportBtn=!p?`<button type="button" class="s91pm-btn" data-pmx-export-summary title="Export plant summary as XLSX (two sheets: summary + equipment matrix)">Export Summary XLSX</button>`:"";
    return `<header class="s91pm-head"><div><div class="s91pm-breadcrumb">${back}</div><small class="s91pm-eyebrow">${eyebrow}</small><h1>${e(title)}</h1><p>${e(sub)}${!p?` · <span data-pmx-updated>${e(updatedLabel(s))}</span>`:''}</p></div><div class="s91pm-head-actions">${!p&&s.view!=="calendar"?"":`<label>Period<input type="month" data-pmx-filter="month" value="${e(s.month)}" aria-label="Month"></label>`}${p&&s.view!=="calendar"?btn("Open PM calendar →","calendar","",true):""}${canManageSchedule(s)?btn("Manage PM schedule","schedule-editor","",true):""}${summaryExportBtn}${btn("Export","export")}${btn("Refresh","reload")}</div></header>`;
  }
  function legend() {return `<div class="s91pm-legend">${["Approved","Pending approval","Overdue","Returned","Locked","Due today","Scheduled","Not assigned"].map(x=>pill(x)).join("")}${pill("Permission granted","blue")}${pill("Existing plan / work order","neutral")}</div>`;}
  function viewToggle(s){return `<div class="s91pm-toggle">${btn("Matrix","layout",`data-layout="matrix" aria-pressed="${s.layout==='matrix'}"`)}${btn("Cards","layout",`data-layout="cards" aria-pressed="${s.layout==='cards'}"`)}</div>`;}
  function filters(s,portfolio) {
    const cat=s.data.categories;
    const dateOptions=Array.from(new Set([...s.activities,...s.legacy].map(a=>a.date))).sort();
    return `<div class="s91pm-filters${portfolio?' s91pm-filters-portfolio':''}${s.filtersOpen?' is-expanded':''}">${portfolio?`<label>Period<input type="month" data-pmx-filter="month" value="${e(s.month)}" aria-label="Month"></label><label>Date<input type="date" data-pmx-filter="selectedDate" value="${e(s.selectedDate)}" min="${e(s.month)}-01" max="${e(new Date(new Date(shift(s.month,1)+"-01T00:00:00Z").getTime()-86400000).toISOString().slice(0,10))}" aria-label="Scheduled date"></label>`:""}<input type="search" placeholder="${portfolio?'Search plant or code':'Search equipment or ID'}" aria-label="Search" data-pmx-filter="query" value="${e(s.query)}">${portfolio?`<button type="button" class="s91pm-btn s91pm-filter-toggle" data-pmx="filters-toggle" aria-expanded="${!!s.filtersOpen}">${s.filtersOpen?'Fewer filters':'More filters'}${[s.plan!=='all',s.equipment,s.status,s.compliance].filter(Boolean).length?' ('+[s.plan!=='all',s.equipment,s.status,s.compliance].filter(Boolean).length+')':''}</button>`:""}${portfolio?`<select aria-label="Plant planning filter" data-pmx-filter="plan">${option("planned","Planned plants",s.plan)}${option("all","All plants",s.plan)}${option("unplanned","Not planned",s.plan)}</select>`:""}<select aria-label="Equipment" data-pmx-filter="equipment">${option("","All equipment",s.equipment)}${cat.map(x=>option(x,x,s.equipment)).join("")}</select><select aria-label="Status" data-pmx-filter="status">${option("","All statuses",s.status)}${statuses.concat(["Existing plan","Existing completed"]).map(x=>option(x,x,s.status)).join("")}</select>${portfolio?`<select aria-label="Compliance" data-pmx-filter="compliance">${option("","All compliance",s.compliance)}${option("on_schedule","On schedule",s.compliance)}${option("behind","Behind",s.compliance)}${option("not_started","Not started",s.compliance)}${option("not_planned","Not planned",s.compliance)}</select>`:`<select aria-label="Scheduled date" data-pmx-filter="day">${option("","All dates",s.day)}${dateOptions.map(x=>option(x,dlabel(x),s.day)).join("")}</select>`}${btn("Clear filters","clear")}</div>`;
  }
  function cell(s,p,cat,compact=false) {
    const filter=a=>a.equipment===cat&&(!s.selectedDate||matches(a,{...s,query:""}));const r=rollup(s,p).filter(filter), l=old(s,p).filter(filter), n=stats(r);
    const listed=s.selectedDate?r.filter(a=>matches(a,{...s,query:""})):r;
    if(!r.length) {
      if(l.length) return `<div class="s91pm-cell s91pm-cell-neutral"><b>${l.some(a=>a.label==='Not assigned')?'Assign in SQL':l.some(a=>a.source==='legacy')?'Existing':'Plan only'}</b>${compact?'':`<small>${l.length} record${l.length===1?'':'s'}</small>`}</div>`;
      return `<span class="s91pm-muted">—</span>`;
    }
    const c=n.approved===n.total?"green":n.late?"red":n.pending?"amber":n.locked?"purple":"blue";
    const text=n.approved===n.total?"Approved":n.late?`${n.late} overdue`:n.pending?`${n.pending} review`:n.locked?`${n.locked} locked`:"Scheduled";
    return `<div class="s91pm-cell s91pm-cell-${c}"><div><b>${n.approved}/${n.total}</b><span>${e(text)}</span></div><div class="s91pm-cellbar"><i style="width:${pct(n)||0}%"></i></div>${s.selectedDate?`<small class="s91pm-day-units">${listed.map(a=>e(a.equipment_id)).join(", ")}</small>`:""}</div>`;
  }
  function portfolio(s) {
    const rows=s.data.plants.filter(p=>{
      const r=rollup(s,p),l=old(s,p),planned=p.configured||r.length||l.length;
      return (s.plan==="all"||(s.plan==="planned"?planned:!planned))&&(!s.query||`${p.name} ${p.site_code} ${p.district} ${p.pm_assignee||""}`.toLowerCase().includes(s.query.toLowerCase()))&&(!s.status&&!s.equipment||[...r,...l].some(a=>matches(a,{...s,query:""})));}).sort((a,b)=>a.name.localeCompare(b.name)||a.site_code.localeCompare(b.site_code));
    const cats=s.equipment?[s.equipment]:s.data.categories;
    return header(s)+kpis(s,s.activities,true)+`<div class="s91pm-panel"><div class="s91pm-section-head"><div><h2>Plant-wise maintenance</h2><p>Approved / SQL-assigned activities · ${rows.length} plants shown</p></div>${viewToggle(s)}</div>${s.selectedDate?`<div class="s91pm-note s91pm-date-scope" role="status">Showing work scheduled on ${e(dlabel(s.selectedDate))}.${btn("Clear date","clear-date")}</div>`:""}${filters(s,true)}${legend()}`+
      (!rows.length?`<div class="s91pm-empty" role="status">${s.selectedDate?`No plants have work scheduled on ${e(dlabel(s.selectedDate))} that matches these filters.`:"No plants match these filters."}</div>`:
      s.layout==="cards"?`<div class="s91pm-cards">${rows.map(p=>{const r=rollup(s,p),st=plantStatus(r,p);return `<button type="button" class="s91pm-plantcard s91pm-accent-${plantTone(st)}" data-pmx="plant" data-code="${e(p.site_code)}"><div class="s91pm-cardhead"><strong>${e(p.name)}</strong><small>${e(p.site_code)} · ${e(p.pm_assignee||"PM unassigned")}</small></div>${progress(r)}<div class="s91pm-mini-grid">${cats.map(c=>`<div><small>${e(short[c]||c)}</small>${cell(s,p,c,true)}</div>`).join("")}</div><div class="s91pm-wrap">${pill(st,plantTone(st))}${complianceBadge(p)}</div></button>`;}).join("")}</div>`:
      `<div class="s91pm-scroll" tabindex="0" role="region" aria-label="Plant maintenance matrix, scroll for more columns"><table class="s91pm-matrix"><thead><tr><th>Plant</th><th>Approved progress</th>${cats.map(c=>`<th title="${e(c)}">${e(short[c]||c)}</th>`).join("")}<th>Attention</th></tr></thead><tbody>${rows.map(p=>{const r=rollup(s,p),n=stats(r),st=plantStatus(r,p);return `<tr><th><button class="s91pm-plant-link" data-pmx="plant" data-code="${e(p.site_code)}">${e(p.name)}<small>${e(p.site_code)} · ${e(p.pm_assignee||"PM unassigned")}</small></button></th><td>${progress(r)}</td>${cats.map(c=>`<td>${cell(s,p,c)}</td>`).join("")}<td><div class="s91pm-wrap">${pill(st,plantTone(st))}${complianceBadge(p)}</div><small class="s91pm-block">${n.pending} review · ${n.locked} locked</small></td></tr>`;}).join("")}</tbody></table></div>`)+`<p class="s91pm-foot">Existing plans/work orders are context, not included in the new checklist approval totals. Unassigned plan markers are not counted as completed.</p></div>`;
  }
  function statusBadges(a) {return pill(a.label,statusTone(a))+(a.permission==="Granted"?pill("Permission granted","blue"):a.permission==="Requested"?pill("Permission requested","amber"):a.permission==="Denied"?pill("Permission denied","red"):"")+(a.late&&a.label!=="Overdue"?pill("Past due","red"):"");}
  const catTone = status => ({"Completed":"green","On track":"green","Pending approval":"amber","Overdue":"red","Locked":"purple"}[status]||"neutral");
  function catStatus(n,hasLegacy,covered) {
    if(!n.total)return hasLegacy?(covered?"Not assigned":"Existing workflow"):"Not scheduled";
    if(n.approved===n.total)return "Completed";
    if(n.late)return "Overdue";
    if(n.pending)return "Pending approval";
    if(n.locked)return "Locked";
    return "On track";
  }
  /** The activity this equipment is waiting on: the next unapproved one due, else the oldest. */
  function nextDue(rows,today) {
    const open=rows.filter(a=>a.status!=="Approved").sort((a,b)=>a.date.localeCompare(b.date));
    return open.find(a=>a.date>=today)||open[0]||null;
  }
  function miniBar(n) {
    const p=pct(n);
    return `<div class="s91pm-mini"><b>${p===null?'—':p+'%'}</b><div class="s91pm-bar"><i style="width:${p||0}%"></i></div></div>`;
  }
  /** One equipment category's own units, listed inside its register row only once expanded. */
  function unitRows(s,rows) {
    if(!rows.length)return '<p class="s91pm-foot">No activity of this equipment matches the selected filters.</p>';
    return `<table class="s91pm-subtable"><thead><tr><th>Unit ID</th><th>Scheduled date</th><th>Status</th><th>Inspected by</th><th>Inspection date</th><th>Next action</th></tr></thead><tbody>${rows.map(a=>`<tr><td><strong>${e(a.equipment_id)}</strong></td><td>${dlabel(a.date)}</td><td><div class="s91pm-wrap">${statusBadges(a)}</div></td><td>${e(a.submitted_name||"—")}</td><td>${dlabel(a.inspected_on)}</td><td>${btn(a.can_review?"Review":a.can_submit?"Record PM":a.can_request?"Request permission":"Open in calendar","event",`data-id="${e(a.id)}"`)}</td></tr>`).join("")}</tbody></table>`;
  }
  /**
   * Monthly activity register: one row per equipment category, counted from the plant's own
   * assigned activities, with that equipment's units expanded inline on request. Approved means
   * O&M Head approved - a submitted checklist awaiting review is never counted as completed.
   */
  function registerPanel(s,p,r,filtered) {
    const narrowing=!!(s.query||s.status||s.day), legacyRows=old(s,p);
    const cats=(s.equipment?[s.equipment]:s.data.categories).filter(c=>!narrowing||filtered.some(a=>a.equipment===c));
    const rows=cats.map((c,i)=>{
      const all=r.filter(a=>a.equipment===c), shown=filtered.filter(a=>a.equipment===c), n=stats(all);
      const open=s.open.has(c), id="s91pm-reg-"+i, due=nextDue(all,s.data.today);
      const status=catStatus(n,legacyRows.some(a=>a.equipment===c),s.data.covered.includes(c)), tone=catTone(status);
      const sub=(all.length?`${all.length} activit${all.length===1?'y':'ies'}`:'No assigned activity')+
        (narrowing&&shown.length!==all.length?` · ${shown.length} shown`:'')+
        (c.startsWith('4 Pole')?' · Four Pole · ACDB · Auxiliary TX':'');
      const dash='<span class="s91pm-muted">—</span>';
      return `<tr class="s91pm-reg-row s91pm-accent-${tone}${open?' s91pm-reg-on':''}" data-pmx="expand" data-cat="${e(c)}">`+
        `<th scope="row"><button type="button" class="s91pm-reg-toggle" data-pmx="expand" data-cat="${e(c)}" aria-expanded="${open}" aria-controls="${id}"><span class="s91pm-chev" aria-hidden="true"></span><span><b>${e(c)}</b><small>${e(sub)}</small></span></button></th>`+
        `<td><b class="s91pm-num">${n.approved} / ${n.total}</b></td><td>${miniBar(n)}</td>`+
        `<td class="s91pm-num">${n.pending||dash}</td><td class="s91pm-num">${n.late||dash}</td><td class="s91pm-num">${n.locked||dash}</td>`+
        `<td>${due?`${dlabel(due.date)}<small>${e(due.label)}</small>`:dash}</td>`+
        `<td>${pill(status,tone)}</td><td>${btn(open?"Hide details":"View details","expand",`data-cat="${e(c)}" aria-expanded="${open}" aria-controls="${id}"`)}</td></tr>`+
        `<tr class="s91pm-reg-detail" id="${id}"${open?'':' hidden'}><td colspan="9">${open?unitRows(s,shown):''}</td></tr>`;
    }).join("");
    return `<section class="s91pm-panel"><div class="s91pm-section-head"><div><h2>Monthly activity register</h2><p>Equipment-wise summary · ${r.length} database-assigned activities · approved completion only</p></div><div class="s91pm-head-actions">${s.open.size?btn("Collapse all","collapse-all"):""}${btn("Open PM calendar →","calendar","",true)}</div></div>${filters(s,false)}${legend()}<div class="s91pm-scroll"><table class="s91pm-reg"><thead><tr><th>Equipment category</th><th>Approved / Scheduled</th><th>Completion</th><th>Pending approval</th><th>Overdue</th><th>Locked</th><th>Next scheduled</th><th>Status</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table>${!cats.length?'<div class="s91pm-empty">No equipment matches the selected filters.</div>':''}</div><p class="s91pm-foot">Open an equipment row for its individual units, their engineers and approval state. An activity's action opens its checklist in the calendar.</p></section>`;
  }
  function rowTable(s,rows) {
    return `<div class="s91pm-scroll"><table class="s91pm-table"><thead><tr><th>Scheduled date</th><th>Equipment / Unit ID</th><th>Status</th><th>Inspected by</th><th>Inspection date</th><th>Next action</th></tr></thead><tbody>${rows.map(a=>`<tr><td>${dlabel(a.date)}</td><td><strong>${e(a.equipment_id)}</strong><small>${e(a.equipment)}</small></td><td><div class="s91pm-wrap">${statusBadges(a)}</div></td><td>${e(a.submitted_name||"—")}</td><td>${dlabel(a.inspected_on)}</td><td>${btn(a.can_review?"Review":a.can_submit?"Record PM":a.can_request?"Request permission":"View","event",`data-id="${e(a.id)}"`)}</td></tr>`).join("")}</tbody></table>${!rows.length?'<div class="s91pm-empty">No assigned activities match the selected filters.</div>':""}</div>`;
  }
  function plant(s,p) {
    const r=rollup(s,p), n=stats(r), l=old(s,p), first=r.find(a=>a.status!=="Approved"), filtered=r.filter(a=>matches(a,s));
    return header(s,p)+kpis(s,r,false)+`<div class="s91pm-plant-grid"><section class="s91pm-panel"><div class="s91pm-section-head"><div><h2>Equipment-wise progress</h2><p>Each inverter is an independent database-assigned activity.</p></div>${pill(plantStatus(r,p),plantTone(plantStatus(r,p)))}</div><div class="s91pm-eq-grid">${s.data.categories.map(c=>`<div class="s91pm-eq"><b>${e(c)}</b>${cell(s,p,c)}${!s.data.covered.includes(c)?'<small>Existing workflow</small>':c.startsWith('4 Pole')?'<small>Four Pole · ACDB · Auxiliary TX</small>':""}</div>`).join("")}</div></section><section class="s91pm-panel"><div class="s91pm-section-head"><div><h2>Sequence control</h2><p>Earlier dates must be approved first.</p></div></div>${first?`<div class="s91pm-next"><small>FIRST UNRESOLVED ACTIVITY</small><strong>${e(first.equipment_id)}</strong><span>${dlabel(first.date)} · ${e(first.label)}</span>${btn(first.can_submit?"Record PM":first.can_review?"Review PM":"Open activity","event",`data-id="${e(first.id)}"`,true)}</div>`:`<div class="s91pm-empty">${n.total?'All assigned activities approved.':'No SQL-assigned activities for this month.'}</div>`}<div class="s91pm-totals"><div><b>${n.locked}</b><small>Locked activities</small></div><div><b>${n.requests}</b><small>Permission requests</small></div><div><b>${n.pending}</b><small>Pending reviews</small></div></div><p class="s91pm-foot">An authorised override unlocks one activity, not the missed earlier task.</p></section></div>${registerPanel(s,p,r,filtered)}<section class="s91pm-panel"><div class="s91pm-section-head"><div><h2>Existing schedule & work orders</h2><p>${l.length} records · planning context; not part of new checklist totals.</p></div></div>${rowTable(s,l.filter(a=>matches(a,s)))}</section>`;
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
    if(a.equipment==='GSS visit')h+='<div class="s91pm-note"><b>GSS side only</b><p>Record authorised inspections or verified utility-maintenance records. Do not operate utility-owned equipment without authorisation.</p></div>';
    if(a.checklist?.length)h+=`<h3>Recorded checklist</h3><p>${e(a.submitted_name||'')} · ${dlabel(a.inspected_on)}</p><div class="s91pm-results">${a.checklist.map(c=>`<div><b>${e(c.task)}</b>${pill(c.result,c.result==='OK'?'green':c.result==='N/A'?'neutral':'red')}${c.note?`<p>${e(c.note)}</p>`:''}</div>`).join('')}</div>${a.remarks?`<p><b>Remarks:</b> ${e(a.remarks)}</p>`:''}`;
    else h+=`<h3>Monthly checklist · ${a.checks.length} checks</h3><ol class="s91pm-check-preview">${a.checks.map(c=>`<li>${e(c)}</li>`).join('')}</ol>`;
    if(a.equipment.startsWith('4 Pole'))h+='<p class="s91pm-foot">Four Pole, shared ACDB panel checks and Auxiliary Transformer. Each section must be reviewed.</p>';
    if(a.can_submit)h+=btn("Record PM","record","",true);
    else if(a.source==='tracking'&&a.checks?.length)h+=btn("Open checklist (preview)","record");
    if(a.can_request||a.can_grant||a.can_review){h+=`<form data-pmx-action-form><label>${a.can_request?'Reason for permission':a.can_grant?'Authorisation / denial reason':'Review note (required if returning)'}<textarea name="reason" rows="3" maxlength="4000" ${a.can_review?'':'required'} placeholder="Enter reason"></textarea></label><div class="s91pm-wrap">${a.can_request?`<button class="s91pm-btn s91pm-primary" name="action" value="request">Request permission</button>`:a.can_grant?`<button class="s91pm-btn s91pm-primary" name="action" value="grant">Grant permission</button><button class="s91pm-btn" name="action" value="deny">Deny</button>`:`<button class="s91pm-btn s91pm-primary" name="action" value="approve">Approve PM</button><button class="s91pm-btn s91pm-danger" name="action" value="return">Return for correction</button>`}</div></form>`;}
    if(a.status==='Approved')h+=`<div class="s91pm-note"><b>Approved by ${e(a.reviewed_name||'O&M Head')}</b><p>${dlabel(a.reviewed_at)}</p></div>`;
    if(a.status==='Pending approval'&&!a.can_review)h+='<p class="s91pm-foot">Awaiting O&M Head approval. This activity has not yet been counted as completed.</p>';
    if(!a.can_submit&&!a.can_request&&!a.can_grant&&!a.can_review&&a.status==='Scheduled'&&a.date>s.data.today)h+='<p class="s91pm-foot">Recording opens on the scheduled date. The checklist can be opened and read before then; nothing is saved.</p>';
    return h;
  }
  function checkForm(s,a) {
    let section="";
    const preview=!a.can_submit;
    const checks=a.checks.map((c,i)=>{const prev=a.checklist?.find(x=>x.task===c)||{};const parts=c.split(" — ");const group=parts.length>1?parts[0]:"";const label=group?parts.slice(1).join(" — "):c;const heading=group&&group!==section?`<h3 class="s91pm-check-group">${e(group)}</h3>`:"";section=group;const itemId=a.checklistItemIds?.[i]||"";const photoAttrs=itemId&&!preview?` data-pmx-photo-btn data-item-id="${e(itemId)}" data-activity-id="${e(a.id)}" data-plant-id="${e(a.plant_id)}"`:' disabled';return `${heading}<fieldset><legend>${i+1}. ${e(label)}</legend><select name="result${i}" required aria-label="Result ${i+1}">${option("","Select result",prev.result||"")}${['OK','Not OK','Abnormality','N/A'].map(x=>option(x,x,prev.result||"")).join('')}</select><textarea rows="2" maxlength="2000" name="note${i}" placeholder="Observation / N/A justification (required unless OK)" aria-label="Observation ${i+1}">${e(prev.note||'')}</textarea><div class="s91pm-check-photos"><button type="button" class="s91pm-photo-slot" data-slot="1"${photoAttrs} title="${preview?'Photo visible in preview':'Upload Before photo'}">📷 Before</button><button type="button" class="s91pm-photo-slot" data-slot="1" data-gallery${photoAttrs}>Before file</button><button type="button" class="s91pm-photo-slot" data-slot="2"${photoAttrs} title="${preview?'Photo visible in preview':'Upload After photo'}">📷 After</button><button type="button" class="s91pm-photo-slot" data-slot="2" data-gallery${photoAttrs}>After file</button></div></fieldset>`;}).join('');
    return `<form class="s91pm-modal-form" data-pmx-submit-form${preview?' data-pmx-preview':''}><div class="s91pm-modal-body">${preview?`<div class="s91pm-callout"><b>Preview only — nothing is saved</b><p>This checklist is not open to you for recording${a.date>s.data.today?' until '+dlabel(a.date):''}. You can read and walk through it; no entry is created and no approval is requested.</p></div>`:''}<div class="s91pm-note"><b>Safety and applicability</b><p>Use approved OEM limits, authorised personnel and applicable isolation/permit-to-work procedures. Mark N/A only for genuinely absent or inapplicable components, with justification. Leave incomplete or deferred work unsubmitted.</p></div><label>Inspection date<input name="inspected_on" type="date" min="${e(a.date)}" max="${e(s.data.today)}" value="${e(a.inspected_on||s.data.today)}" required></label>${checks}<label>General remarks<textarea name="reason" maxlength="4000" rows="3">${e(a.remarks||'')}</textarea></label></div><footer class="s91pm-modal-foot"><div class="s91pm-wrap"><button class="s91pm-btn s91pm-primary" type="submit"${preview?' disabled title="Preview only: this activity is not open to you for recording"':''}>Submit for approval</button>${btn(preview?"Close preview":"Cancel","cancel-record")}</div><p class="s91pm-foot">${preview?'Preview only: the entry is not stored and no approval is requested.':'Engineer identity and submission time are captured automatically. Photos upload separately; wait for confirmation before submitting.'}</p></footer></form>`;
  }
  /**
   * The checklist as an overlay box, not a column that grows down the page. One per page, over
   * whichever view is open, closed by its × button, the backdrop or Escape. The form inside is
   * the same one as before, so the preview guard and the submit path are unchanged.
   */
  function formOverlay(s,p) {
    if(s.form!=='submit')return "";
    const a=s.activities.find(x=>x.id===s.selected);
    if(!a||a.source!=='tracking'||!a.checks?.length)return "";
    const preview=!a.can_submit, plant=p||s.data.plants.find(x=>x.id===a.plant_id);
    return `<div class="s91pm-modal" data-pmx="cancel-record"><section class="s91pm-modal-card" role="dialog" aria-modal="true" aria-labelledby="s91pm-modal-title" data-pmx="dialog">`+
      `<header class="s91pm-modal-head"><div><small class="s91pm-eyebrow">${preview?'CHECKLIST PREVIEW':'RECORD PM'}</small>`+
      `<h2 id="s91pm-modal-title">${e(a.equipment_id)}</h2><p>${e(a.equipment)} · ${dlabel(a.date)}${plant?' · '+e(plant.name):''}</p></div>`+
      `<button type="button" class="s91pm-modal-x" data-pmx="cancel-record" aria-label="Close">×</button></header>`+
      `${checkForm(s,a)}</section></div>`;
  }
  function render(s) {
    if(active!==s)return;
    const p=s.data?.plants.find(x=>x.site_code===s.siteCode);
    if(s.loading&&!s.data){s.host.innerHTML='<div class="s91pm"><div class="s91pm-panel s91pm-empty" role="status">Loading monthly PM tracking…</div></div>';return;}
    if(s.error&&!s.data){s.host.innerHTML=`<div class="s91pm"><div class="s91pm-panel s91pm-empty" role="alert"><b>PM tracking unavailable</b><p>${e(s.error)}</p>${btn("Retry","reload")}</div></div>`;return;}
    if(s.siteCode&&!p){s.host.innerHTML='<div class="s91pm s91pm-empty">Plant not available in your assigned scope.</div>';return;}
    if(s.restoreScroll!=null){const y=s.restoreScroll;s.restoreScroll=null;setTimeout(()=>{if(typeof global.scrollTo==="function")global.scrollTo(0,y);},0);}
    s.host.innerHTML=`<div class="s91pm">${s.notice?`<div class="s91pm-notice" role="status">${e(s.notice)}</div>`:''}${s.error?`<div class="s91pm-callout" role="status">Showing last successful PM data · ${e(s.error)} ${btn("Retry","reload")}</div>`:''}${s.data.legacy_truncated?'<div class="s91pm-callout">Existing record list truncated. Select an individual plant to see its records.</div>':''}${s.view==='calendar'?calendar(s,p):p?plant(s,p):portfolio(s)}${formOverlay(s,p)}</div>`;
  }
  let pollTimer=null;
  const recent=new Map();
  const cacheKey=s=>`${s.siteCode||"portfolio"}|${s.month}|${s.view}|${s.selectedDate||""}|${s.compliance||""}`;
  function remember(s){const k=cacheKey(s);recent.delete(k);recent.set(k,{at:Date.now(),data:s.data});while(recent.size>12)recent.delete(recent.keys().next().value);}
  function routeMatches(s){const n=nav()?.getState?.();if(!n)return true;return (n.activeView==='plant-sub'?n.selectedSubPage==='pm'&&n.selectedPlant===s.siteCode:n.activeView==='view-sub'&&n.selectedViewPage==='pm'&&!s.siteCode)&&!!n.pmCalendarOpen===(s.view==='calendar');}
  function visible(s){return active===s&&routeMatches(s)&&s.host.isConnected&&s.host.offsetParent!==null&&document.visibilityState==='visible'&&!!s.host.querySelector('.s91pm');}
  function busy(s){return s.saving||s.editorOpen||s.form||!!s.host.querySelector('form[data-pmx-action-form] textarea')?.value||!!s.host.querySelector('form :focus')||!!(document.activeElement&&s.host.contains(document.activeElement)&&document.activeElement.matches('input,select,textarea'));}
  function planPoll(s){clearTimeout(pollTimer);if(!visible(s))return;const slow=global.navigator?.connection?.saveData||/2g|3g/.test(global.navigator?.connection?.effectiveType||'');pollTimer=setTimeout(()=>{if(visible(s)&&!busy(s)&&global.navigator?.onLine!==false&&!s.loading)load(s,true);else if(visible(s))planPoll(s);},Math.max(s.backoff||60000,slow?120000:60000)+Math.random()*5000);}
  async function load(s,background=false) {
    const token=++s.token,hadError=!!s.error;s.loading=true;s.error="";if(!s.data)render(s);
    try{let url='/api/pm-plan/tracking?month='+encodeURIComponent(s.month)+(s.siteCode?'&site_code='+encodeURIComponent(s.siteCode):'&summary=true');if(!s.siteCode&&s.view==="overview"){if(s.selectedDate)url+='&date='+encodeURIComponent(s.selectedDate);if(s.compliance)url+='&compliance='+encodeURIComponent(s.compliance);}const data=await api().request(url);if(active!==s||s.token!==token||!routeMatches(s))return;
      if(background&&(!visible(s)||busy(s))){s.loading=false;planPoll(s);return;}
      const same=background&&!hadError&&s.data&&JSON.stringify({...s.data,as_of:null})===JSON.stringify({...data,as_of:null});s.data=data;enrich(s);remember(s);s.loading=false;s.backoff=60000;if(!same)render(s);else {const stamp=s.host.querySelector("[data-pmx-updated]");if(stamp)stamp.textContent=updatedLabel(s); }
    }catch(err){if(active!==s||s.token!==token||!routeMatches(s))return;s.loading=false;s.error=err?.message||'Could not load PM tracking.';s.backoff=Math.min(300000,(s.backoff||60000)*2);if(!background||visible(s)&&!busy(s))render(s);}
    planPoll(s);
  }
  function changeMonth(s,m){if(!monthKey(m))return;s.month=rememberedMonth=m;s.day='';s.selectedDate='';s.selected='';s.form='';s.notice='';s.data=null;load(s);}
  function changeSelectedDate(s,value){if(value&&value.slice(0,7)!==s.month){render(s);return;}s.selectedDate=value||'';s.selected='';s.form='';s.data=null;load(s);}
  function changeCompliance(s,value){s.compliance=value;s.data=null;load(s);}
  function exportRows(s){const rows=[...s.activities,...s.legacy];const plants=new Map(s.data.plants.map(p=>[p.id,p]));const safe=v=>{let x=String(v??'');if(/^[\s]*[=+@-]/.test(x))x="'"+x;return '"'+x.replaceAll('"','""')+'"';};const body=[['Plant','Code','Date','Equipment','Equipment ID','Source','Status','Overdue','Permission','Inspected on','Engineer','Reviewed by'],...rows.map(a=>[plants.get(a.plant_id)?.name,plants.get(a.plant_id)?.site_code,a.date,a.equipment,a.equipment_id,a.source,a.label,a.late?'Yes':'No',a.permission,a.inspected_on,a.submitted_name,a.reviewed_name])].map(r=>r.map(safe).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\ufeff'+body],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='Solar91-PM-'+s.month+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function openSchedule(s){
    if(active!==s||!routeMatches(s)||!canManageSchedule(s)||s.editorOpen)return;s.editorOpen=true;
    const d=document.createElement('dialog');d.className='s91pm-editor';d.setAttribute('aria-labelledby','pm-editor-title');
    document.body.append(d);const base='/api/pm-plan/schedules';let model=null,scope='future',draft={},preview=null,working=false,code='',period=s.month,seq=0,plantOptions=[];
    const key=x=>x.equipment+'|'+(x.inverter_no||'');const label=x=>x.inverter_no?'Inverter '+x.inverter_no:x.equipment;
    const dirty=()=>Object.keys(draft).length>0;
    function close(){if(working)return;if(dirty()&&!global.confirm('Discard unsaved schedule changes?'))return;d.close();}
    d.addEventListener('cancel',ev=>{ev.preventDefault();close();});d.addEventListener('close',()=>{s.editorOpen=false;seq++;d.remove();if(active===s)planPoll(s);});
    function draw(message=''){
      if(!d.isConnected)return;
      const monthDays=new Date(Date.UTC(+period.slice(0,4),+period.slice(5,7),0)).getUTCDate();
      const original=x=>scope==='future'?x.rule_day:x.day;const value=x=>Object.hasOwn(draft,key(x))?draft[key(x)]:original(x);
      const changes=model?model.items.filter(x=>Object.hasOwn(draft,key(x))&&value(x)!==original(x)).length:0;
      const items=model?.items||[];const days=Array.from({length:monthDays},(_,i)=>i+1);
      const offset=(new Date(period+'-01T00:00:00Z').getUTCDay()+6)%7;
      d.innerHTML=`<div class="s91pm-editor-head"><div><h2 id="pm-editor-title">PM schedule editor</h2><p>Assign exact maintenance days. Save one batch.</p></div><button type="button" data-ed="close" aria-label="Close schedule editor" ${working?'disabled':''}>×</button></div><div class="s91pm-editor-body"><div class="s91pm-editor-controls"><label>Plant<select data-ed="plant" ${working?'disabled':''}><option value="">Select a plant</option>${plantOptions.map(p=>option(p.site_code,p.name+' · '+p.site_code,code)).join('')}</select></label><label>Period<input type="month" min="2026-12" value="${e(period)}" data-ed="period" ${working?'disabled':''}></label>${model?.exists?`<label>Apply scope<select data-ed="scope" ${working?'disabled':''}>${option('future','From now on',scope)}${option('month','This month only',scope)}</select></label>`:''}</div>${message?`<p role="status" class="s91pm-editor-message">${e(message)}</p>`:''}${model?`<p><strong>${e(model.name)}</strong> · ${model.inverter_count} configured inverters · ${model.exists?'Edit recurring schedule':'Create recurring schedule'}</p>${scope==='future'&&model.exists&&period!==model.effective_month?`<p>Recurring changes start ${e(model.effective_month)}. Select that period or use this month only.</p>`:''}<div class="s91pm-editor-layout"><div class="s91pm-editor-items">${items.map((x,i)=>`<label>${e(label(x))}${x.protected?' <small>Protected this month</small>':''}<select aria-label="${e(label(x))} day" data-ed-item="${i}" ${working||(scope==='month'&&x.protected)?'disabled':''}>${option('','Not scheduled',String(value(x)??''))}${Array.from({length:31},(_,j)=>option(String(j+1),'Day '+(j+1),String(value(x)??''))).join('')}</select></label>`).join('')}</div><div><div class="s91pm-editor-grid">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(t=>`<b>${t}</b>`).join('')}${'<div></div>'.repeat(offset)}${days.map(day=>`<div class="s91pm-editor-day"><b>${day}</b>${items.filter(x=>value(x)!=null&&Math.min(value(x),monthDays)===day).map(x=>`<span title="${e(label(x))}">${e(x.inverter_no?'INV '+x.inverter_no:short[x.equipment]||x.equipment)}</span>`).join('')}</div>`).join('')}</div><p>Days beyond month end are clamped to the last day. Multiple inverters may share a day.</p></div></div>`:''}${preview?`<section class="s91pm-editor-preview"><h3>Confirm batch</h3><p>Generated months considered: ${e(preview.months.join(', ')||'None yet')}. ${preview.changes.length} activity changes · ${preview.rule_changes.length} rule changes · ${preview.refused.length} protected/conflicting items skipped.</p><p>Months with activity changes: ${e([...new Set(preview.changes.map(x=>x.month))].join(', ')||'None')}.</p><details><summary>Review proposed changes</summary>${preview.rule_changes.map(x=>`<div>${e(x.equipment)}: day ${e(x.from_day??'—')} → ${e(x.to_day??'remove')}</div>`).join('')}${preview.changes.map(x=>`<div>${e(x.month+' · '+x.equipment+' · '+(x.from||'New')+' → '+(x.to||'Remove'))}</div>`).join('')}${preview.refused.map(x=>`<div>${e(x.month+' · '+x.equipment+' · '+x.reason)}</div>`).join('')}</details></section>`:''}</div><footer class="s91pm-editor-foot"><span>${changes} unsaved assignments</span><button type="button" data-ed="close" ${working?'disabled':''}>Cancel</button><button type="button" data-ed="preview" ${working||!model||!changes?'disabled':''}>Preview changes</button>${preview?`<button type="button" class="s91pm-primary" data-ed="save" ${working?'disabled':''}>Confirm &amp; save</button>`:''}</footer>`;
    }
    async function read(){const token=++seq;model=null;draft={};preview=null;working=true;draw('Loading schedule…');try{if(code){const result=await api().request(base+'/'+encodeURIComponent(code)+'?month='+encodeURIComponent(period));if(token!==seq)return;model=result;scope='future';} }catch(err){if(token===seq){working=false;draw(err.message);return;}}if(token===seq){working=false;draw();}}
    function payload(){return {month:period,mode:model.exists?'edit':'create',scope,changes:model.items.filter(x=>Object.hasOwn(draft,key(x))&&draft[key(x)]!==(scope==='future'?x.rule_day:x.day)).map(x=>({equipment:x.equipment,inverter_no:x.inverter_no,day:draft[key(x)]}))};}
    d.addEventListener('change',ev=>{const el=ev.target;if(working)return;const a=el.dataset.ed;if(a==='plant'||a==='period'||a==='scope'){if(a!=='scope'&&dirty()&&!global.confirm('Discard unsaved assignments to change this selection?')){draw();return;}if(a==='plant'){code=el.value;read();}else if(a==='period'){if(el.value&&el.value>='2026-12'){period=el.value;read();}else draw('Choose December 2026 or later.');}else{scope=el.value;preview=null;draw();}return;}if(el.dataset.edItem!==undefined&&model){const x=model.items[Number(el.dataset.edItem)];const val=el.value?Number(el.value):null;const original=scope==='future'?x.rule_day:x.day;if(val===original)delete draft[key(x)];else draft[key(x)]=val;preview=null;const idx=el.dataset.edItem;draw();d.querySelector('[data-ed-item="'+idx+'"]')?.focus();}});
    d.addEventListener('click',async ev=>{const a=ev.target.closest('[data-ed]')?.dataset.ed;if(a==='close'){close();return;}if(!['preview','save'].includes(a)||working||!model)return;working=true;draw(a==='save'?'Saving atomically…':'Validating schedule…');try{const body=payload();if(a==='save')body.token=preview.token;const result=await api().request(base+'/'+encodeURIComponent(code)+'/'+a,{method:'POST',body});working=false;if(a==='preview'){preview=result;draw();}else{draft={};preview=null;recent.clear();if(global.Solar91PortalData?.invalidate)global.Solar91PortalData.invalidate(true);else document.dispatchEvent(new CustomEvent('portal:data-invalidated'));d.close();if(active===s&&routeMatches(s)){s.notice=`Schedule saved: ${result.changes.length} activities changed; ${result.refused.length} skipped.`;load(s);}}}catch(err){working=false;preview=null;draw(err.message||'Request failed. Preview again before retrying.');}});
    d.showModal();working=true;draw('Loading available plants…');try{plantOptions=await api().request(base);if(!d.isConnected)return;if(period<'2026-12')period='2026-12';await read();}catch(err){working=false;draw(err.message||'Could not load plants.');}
  }
  const wired=new WeakSet();
  function wire(host){if(wired.has(host))return;wired.add(host);
    host.addEventListener('click',ev=>{const s=active;if(!s||s.host!==host)return;const summaryExport=ev.target.closest('[data-pmx-export-summary]');if(summaryExport){summaryExport.disabled=true;api().downloadFile('/api/pm-plan/tracking/summary/export?month='+encodeURIComponent(s.month),'Solar91_PM_Summary.xlsx').catch(err=>global.alert(err?.message||'The PM summary could not be downloaded.')).then(()=>{summaryExport.disabled=false;});return;}
      const photoBtn=ev.target.closest('[data-pmx-photo-btn]');
      if(photoBtn&&!photoBtn.disabled){
        const {activityId,itemId,slot,plantId}=photoBtn.dataset;
        const form=photoBtn.closest('form');
        if(!form||s.saving||s.photoBusy)return;
        const key=activityId+'|'+itemId+'|'+slot;
        s.photoPending=s.photoPending||new Map();
        async function send(pending){
          s.photoBusy=true;photoBtn.disabled=true;photoBtn.textContent='Uploading…';
          try{
            const result=await global.Solar91PhotoEvidence.upload({plantId,category:'pm',linkType:'pm',linkId:activityId,checklistItemId:itemId,phase:slot==='1'?'before':'after',slot:Number(slot),files:[pending.file],submissionId:pending.id});
            if(!result.persisted)throw new Error('Upload not confirmed');
            s.photoPending.delete(key);photoBtn.textContent=slot==='1'?'✓ Before':'✓ After';photoBtn.classList.add('s91pm-photo-done');
            form.querySelectorAll('[data-pmx-photo-btn]').forEach(b=>{if(b.dataset.itemId===itemId&&b.dataset.slot===slot){b.disabled=true;b.classList.add('s91pm-photo-done');}});
          }catch(err){photoBtn.disabled=false;photoBtn.textContent='Retry upload';global.Solar91PortalToast?.error('Photo not saved',err.message||'Reconnect and retry.');}
          finally{s.photoBusy=false;}
        }
        if(s.photoPending.has(key)){send(s.photoPending.get(key));return;}
        const inp=global.document.createElement('input');
        inp.type='file';inp.accept='image/jpeg,image/png,image/webp';if(!photoBtn.hasAttribute('data-gallery'))inp.capture='environment';
        inp.addEventListener('change',()=>{
          const file=inp.files[0];if(!file)return;
          if(!global.Solar91PhotoEvidence){global.Solar91PortalToast?.error('Photo not saved','Photo module unavailable; reload and retry.');return;}
          const pending={file,id:global.Solar91PhotoEvidence.submissionId()};s.photoPending.set(key,pending);send(pending);
        });
        inp.click();
        return;
      }
      const b=ev.target.closest('[data-pmx]');if(!b)return;const a=b.dataset.pmx;
      if(a==='plant'){const p=s.data.plants.find(x=>x.site_code===b.dataset.code);if(p){keepPortfolio(s);nav().selectPlantPage(p.site_code,'pm',null,{siteCode:p.site_code,displayName:p.name,plantName:p.name,displayCode:p.site_code},{pmParent:'overview',pmCalendar:true,pmCalendarMonth:s.month});toTop();}}
      else if(a==='calendar')nav().openPMCalendar(s.month,null);
      else if(a==='event'){nav().openPMCalendar(s.month,b.dataset.id);}
      else if(a==='back-calendar')nav().closePMCalendar();
      else if(a==='back-plant'){if(s.parent==='plants')nav().selectPlantPage(s.siteCode,'details');else nav().selectView('pm');}
      else if(a==='schedule-editor')openSchedule(s);
      else if(a==='reload')load(s);
      else if(a==='export')exportRows(s);
      else if(a==='prev'||a==='next')changeMonth(s,shift(s.month,a==='prev'?-1:1));
      else if(a==='today')changeMonth(s,s.data.today.slice(0,7));
      else if(a==='clear'){s.query=s.equipment=s.status=s.day=s.selectedDate=s.compliance='';s.plan='all';s.data=null;load(s);}
      else if(a==='clear-date'){changeSelectedDate(s,'');}
      else if(a==='filters-toggle'){s.filtersOpen=!s.filtersOpen;const bar=b.closest(".s91pm-filters");bar.classList.toggle("is-expanded",s.filtersOpen);b.setAttribute("aria-expanded",String(s.filtersOpen));const n=[s.plan!=="all",s.equipment,s.status,s.compliance].filter(Boolean).length;b.textContent=(s.filtersOpen?"Fewer filters":"More filters")+(n?" ("+n+")":"");}
      else if(a==='layout'){s.layout=b.dataset.layout==='cards'?'cards':'matrix';render(s);}
      else if(a==='select'){s.selected=b.dataset.id;s.form='';s.notice='';render(s);if(global.matchMedia('(max-width: 950px)').matches)host.querySelector('.s91pm-detail')?.scrollIntoView({block:'nearest'});}
      else if(a==='expand'){const c=b.dataset.cat;if(c){if(s.open.has(c))s.open.delete(c);else s.open.add(c);render(s);}}
      else if(a==='collapse-all'){s.open.clear();render(s);}
      else if(a==='record'||a==='cancel-record'){if(s.photoBusy)return;if(a==='cancel-record'&&s.photoPending?.size){if(!global.confirm('Discard photos that have not uploaded?'))return;s.photoPending.clear();}s.form=a==='record'?'submit':'';render(s);}
    });
    host.addEventListener('change',ev=>{const s=active,k=ev.target.dataset.pmxFilter;if(!s||s.host!==host||!k||k==='query')return;if(k==='month')changeMonth(s,ev.target.value);else if(k==='selectedDate')changeSelectedDate(s,ev.target.value);else if(k==='compliance')changeCompliance(s,ev.target.value);else if(['equipment','status','day','plan'].includes(k)){s[k]=ev.target.value;render(s);}});
    host.addEventListener('input',ev=>{const s=active;if(!s||s.host!==host||ev.target.dataset.pmxFilter!=='query')return;const pos=ev.target.selectionStart;s.query=ev.target.value;render(s);const q=host.querySelector('[data-pmx-filter="query"]');q?.focus();try{q?.setSelectionRange(pos,pos);}catch(_){}});
    host.addEventListener('submit',async ev=>{const s=active;if(!s||s.host!==host||!ev.target.matches('[data-pmx-action-form],[data-pmx-submit-form]'))return;ev.preventDefault();if(s.saving)return;
      const form=ev.target, a=s.activities.find(x=>x.id===s.selected);if(!a)return;
      const submit=form.matches('[data-pmx-submit-form]');
      if(submit&&(s.photoBusy||s.photoPending?.size)){global.Solar91PortalToast?.error('Photo upload incomplete','Wait for the upload or retry before submitting.');return;}
      if(submit&&!a.can_submit){
        // The checklist was opened to be read, not recorded. Nothing is sent; the server would
        // refuse it in any case, and a refusal must never look like a saved entry.
        global.Solar91PortalToast?.info('Preview only','This checklist is not open to you for recording, so nothing was saved.');
        return;
      }
      const fd=new FormData(form), action=submit?'submit':ev.submitter?.value;
      if(!action)return;
      const payload={action,reason:String(fd.get('reason')||'')};
      if(submit){payload.inspected_on=fd.get('inspected_on');payload.checks=a.checks.map((_,i)=>({result:fd.get('result'+i),note:String(fd.get('note'+i)||'')}));}
      const errNode=document.createElement('p');errNode.className='s91pm-form-error';errNode.setAttribute('role','alert');form.querySelector('.s91pm-form-error')?.remove();
      s.saving=true;Array.from(form.querySelectorAll('button')).forEach(b=>b.disabled=true);
      try{await api().request('/api/pm-plan/tracking/'+encodeURIComponent(a.id)+'/action',{method:'POST',body:payload});recent.clear();if(active!==s||!routeMatches(s))return;s.form='';s.notice={submit:'Checklist submitted for O&M Head approval.',approve:'PM approved. Sequence recalculated.',return:'PM returned for correction.',request:'Permission requested.',grant:'Permission granted for this activity only.',deny:'Permission denied.'}[action];
      global.Solar91PortalToast?.success(s.notice,`${a.equipment_id} · ${dlabel(a.date)}`);
      global.Solar91PortalNotifications?.refresh();
      await load(s);}
      catch(err){const text=err?.message||'Action could not be saved.';global.Solar91PortalToast?.error('PM action not saved',text);if(active===s){errNode.textContent=text;form.append(errNode);}}
      finally{s.saving=false;Array.from(form.querySelectorAll('button')).forEach(b=>b.disabled=false);}
    });
  }
  function show(host,opts={}){if(!host)return;const month=monthKey(opts.initialMonth)||rememberedMonth||todayMonth();rememberedMonth=month;const siteCode=opts.siteCode||null;const s={host,siteCode,parent:opts.parent||'overview',view:opts.calendar?'calendar':'overview',calendarParent:opts.calendarParent==='overview'?'overview':'plant',month,selected:opts.eventId||'',form:'',query:'',status:'',equipment:'',day:'',selectedDate:'',compliance:'',plan:'all',layout:'matrix',filtersOpen:false,open:new Set(),loading:true,error:'',notice:'',saving:false,token:0};if(!siteCode&&!opts.calendar)takePortfolio(s);const cached=recent.get(cacheKey(s));if(cached&&Date.now()-cached.at<60000){s.data=cached.data;s.loading=false;enrich(s);}active=s;wire(host);if(s.data){render(s);planPoll(s);}else load(s);}
  function resume(){if(active&&visible(active)&&!busy(active)&&!active.loading&&global.navigator?.onLine!==false)load(active,true);}
  document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&active&&active.form==='submit'&&!active.saving){active.form='';render(active);}});
  document.addEventListener('portal:data-invalidated',()=>{recent.clear();});
  document.addEventListener('portal:route-changed',()=>{if(active&&!routeMatches(active)){clearTimeout(pollTimer);active=null;}});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')resume();else clearTimeout(pollTimer);});
  global.addEventListener('online',resume);
  global.Solar91PMTracking={show};
}(window));
