"use strict";
/* Section overlays only: decorate the existing server-backed forms and actions.
 * Does not replace an API handler, alter global navigation or store a second copy of state.
 */
(function(){
  const previous = window.renderModal;
  if (typeof previous !== "function") return;
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  const LABELS = {
    ticket: ["Overview", "Work log", "Updates", "Photos"],
    washing: ["Progress", "Daily status", "Reports & photos"],
    pm: ["Overview", "Work steps", "Evidence & history"]
  };
  function navigation(kind){
    return '<nav class="s91-ref-tabs" aria-label="'+(kind === 'ticket'?'Site issue':kind === 'washing'?'Washing':'Maintenance')+' details">'+
      LABELS[kind].map((label,index)=>'<button type="button" class="s91-ref-tab'+(!index?' active':'')+'" data-s91-ref-tab="'+index+'" aria-pressed="'+(!index)+'">'+label+'</button>').join("")+'</nav>';
  }
  function calendar(){
    const state=window.S;
    const plant=state?._washCycles?.plants?.find(row=>row.plant_id===state.washDetailsPlant);
    if(!plant)return "";
    const days=plant.daily_status||[],dates=days.filter(day=>day.date);
    const first=dates[0]?.date;
    const today=new Date(),year=first?Number(first.slice(0,4)):today.getFullYear(),month=first?Number(first.slice(5,7))-1:today.getMonth();
    if(!Number.isInteger(year)||!Number.isInteger(month)||month<0||month>11)return "";
    const entries=new Map(dates.filter(day=>Number(day.date.slice(5,7))-1===month).map(day=>[Number(day.date.slice(-2)),day]));
    const padding=new Date(year,month,1).getDay(),length=new Date(year,month+1,0).getDate();
    let tiles="";
    for(let n=0;n<padding;n++)tiles+='<span class="s91-cal-blank" aria-hidden="true"></span>';
    for(let day=1;day<=length;day++){
      const entry=entries.get(day),status=String(entry?.status||"").toLowerCase();
      const confirmed=Number(entry?.confirmed||0),pending=Number(entry?.pending||0);
      const tone=confirmed>0 || status.includes("confirm") && !status.includes("await") ? "done" :
        pending>0||status.includes("await")||status.includes("pending")||status.includes("wait") ? "pending" :
        status.includes("not done")||status.includes("miss")||entry?.exception ? "missed":"future";
      const iso=year+"-"+String(month+1).padStart(2,"0")+"-"+String(day).padStart(2,"0");
      const label=iso+": "+(entry?.status||"No report");
      tiles+='<button type="button" class="s91-cal-day '+tone+'" data-s91-wash-day="'+iso+'" aria-label="'+escapeHtml(label)+'" title="'+escapeHtml(label)+'">'+day+'</button>';
    }
    return '<section class="s91-ref-calendar" aria-label="Washing calendar"><header><b>'+new Date(year,month,1).toLocaleString("en-IN",{month:"long",year:"numeric"})+' · Day by day</b><small>Choose a date to review saved reports and photographs</small></header><div class="s91-cal-grid">'+["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(day=>'<strong>'+day+'</strong>').join("")+tiles+'</div><div class="s91-cal-legend"><span>● Confirmed</span><span>● Waiting</span><span>● Not done</span></div></section>';
  }
  function anchor(html, search, replace){return html.includes(search)?html.replace(search,replace):html;}
  function addAnchors(html,kind){
    if(kind==="ticket"){
      html=anchor(html,'<section class="issue-updates">','<section class="issue-updates" data-s91-ref-section="updates">');
      html=anchor(html,'<div style="font-size:12.5px;font-weight:600;margin-bottom:6px">Work log','<div data-s91-ref-section="worklog" style="font-size:12.5px;font-weight:600;margin-bottom:6px">Work log');
      html=anchor(html,'<div style="font-size:12.5px;color:var(--muted-foreground);margin:10px 0">📎','<div data-s91-ref-section="photos" style="font-size:12.5px;color:var(--muted-foreground);margin:10px 0">📎');
      html=anchor(html,'<div class="issue-workflow"','<div data-s91-ref-section="overview" class="issue-workflow"');
    }else if(kind==="washing"){
      html=anchor(html,'<div class="wc-cycles">','<div class="wc-cycles" data-s91-ref-section="progress">');
      html=anchor(html,'<div class="wc-sec">','<div class="wc-sec" data-s91-ref-section="daily">');
      html=anchor(html,'<div class="wc-sec"><div class="row between wrap">','<div class="wc-sec" data-s91-ref-section="reports"><div class="row between wrap">');
    }else{
      html=anchor(html,'Execution checklist</div>','Execution checklist</div>');
    }
    return html;
  }
  window.renderModal=function(){
    let html=previous.apply(this,arguments);
    if(!html||!window.S)return html;
    const name=S.modal,kind=name==="ticket"?"ticket":name==="washingPlantDetails"?"washing":name==="taskDetail"?"pm":null;
    if(!kind)return html;
    html=anchor(html,'class="modal ','class="modal s91-reference-modal s91-ref-'+kind+' ');
    html=addAnchors(html,kind);
    const extra=kind==="washing"?calendar():"";
    return anchor(html,'<div class="modal-b">','<div class="s91-reference-navigation">'+navigation(kind)+'</div><div class="modal-b">'+extra);
  };
  const targetFor=(body,kind,index)=>{
    const selectors={
      ticket:["[data-s91-ref-section=overview]","[data-s91-ref-section=worklog]","[data-s91-ref-section=updates]","[data-s91-ref-section=photos]"],
      washing:["[data-s91-ref-section=progress]","[data-s91-ref-section=daily]","[data-s91-ref-section=reports]"],
      pm:[".issue-workflow",".task-checklist",".task-evidence"]
    };
    const found=body.querySelector(selectors[kind]?.[index]||"");
    if(found)return found;
    if(kind==="pm"){
      const labels=index===1?["Execution checklist"]:["Completion evidence","Activity"];
      return [...body.querySelectorAll("div")].find(element=>labels.some(label=>element.textContent.trim()===label))||null;
    }
    return null;
  };
  document.addEventListener("click",event=>{
    const day=event.target.closest("[data-s91-wash-day]");
    if(day){event.preventDefault();if(typeof window.washFocusDay==="function")window.washFocusDay(day.dataset.s91WashDay);return;}
    const tab=event.target.closest("[data-s91-ref-tab]");
    if(!tab)return;
    const modal=tab.closest(".s91-reference-modal");if(!modal)return;
    const body=modal.querySelector(".modal-b");if(!body)return;
    modal.querySelectorAll(".s91-ref-tab").forEach(button=>{
      const selected=button===tab;button.classList.toggle("active",selected);button.setAttribute("aria-pressed",String(selected));
    });
    const kind=modal.classList.contains("s91-ref-ticket")?"ticket":modal.classList.contains("s91-ref-washing")?"washing":"pm";
    const index=Number(tab.dataset.s91RefTab),target=targetFor(body,kind,index);
    if(index===0&&!target){body.scrollTo({top:0,behavior:"smooth"});return;}
    if(!target){body.scrollTo({top:0,behavior:"smooth"});return;}
    const offset=target.getBoundingClientRect().top-body.getBoundingClientRect().top;
    body.scrollTo({top:Math.max(0,body.scrollTop+offset-12),behavior:"smooth"});
  });
})();
