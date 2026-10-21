"use strict";
/* Data / Imports upgrades:
   · Preventive Maintenance tasks: task, type, frequency, assignee(s), start_date (+ how-to, safety, hours) — plant is assigned later
   · Issues: past + current records (real dates, resolved status/date, keeps ticket ids, skips duplicates)
   · Washing: one simple list — plant, table, inverter, (optional) second inverter
   Excel (.xlsx) and CSV both accepted. */
(function(){
 if(typeof ccImpSpec!=="function"||typeof ccDoImport!=="function")return;
 const origSpec=ccImpSpec,origDo=ccDoImport,origTpl=ccTemplate;
 const NEW=["tasks","issues","wash_tables"];
 const normH=h=>String(h||"").split(/\s[–—-]\s/)[0].toLowerCase().replace(/\(.*?\)/g,"").replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");
 const SPEC={
  tasks:{label:"Preventive Maintenance tasks",cols:["task","type","plant","frequency","assignee","start_date","how_to_do_it","safety","est_hours"],req:[["task","task_name","name"],["Task name is required · plant is optional (blank = assign later; several plants separated by commas; \"All plants\" works)"]],
   map:[["task","task","task_name","name","what_to_do"],["type","type","equipment_type","equipment","maintenance_type"],["frequency","frequency","freq","when"],["assignee","assignee","assignees","owner","assigned_to"],["plant","plant","plants","plant_name","site"],["start_date","start_date","start","due","due_date"],["how","how_to_do_it","how_to","steps","procedure","checklist"],["safety","safety","safety_needed"],["hours","est_hours","est_time","duration","hours"]]},
  issues:{label:"Issue tickets (past + current)",cols:["ticket_id","plant","issue_type","sub","equipment","maker","severity","description","occurred","assignee","status","resolved_on","resolution"],req:[["plant","plant_name","site"],["Plant name must match an existing plant"]],
   map:[["id","ticket_id","ticket","id"],["plant","plant","plant_name","site"],["type","issue_type","type","vertical","category"],["sub","sub","subcategory"],["equip","equipment","equip"],["maker","maker","manufacturer"],["sev","severity","priority"],["desc","description","details","desc","issue"],["occ","occurred","occurred_on","date","occurrence_date"],["who","assignee","engineer","owner"],["status","status"],["resolved","resolved_on","closed_on","resolved_date"],["res","resolution","remarks","corrective_action"]]},
  wash_tables:{label:"Washing (plant → tables)",cols:["plant","table_id","inverter","second_inverter"],req:[["plant"],["Plant, table_id and inverter are required · second_inverter is optional"]],
   map:[["plant","plant","plant_name","site"],["tid","table_id","table","table_code"],["inv","inverter","inv","primary_inverter"],["sec","second_inverter","secondary_inverter","secondary_inv","split_inverter"],["freq","frequency_days","wash_frequency_days","frequency"],["next","next_due","due","scheduled_date"],["crew","crew","team","assignee"],["last","last_washed","last_wash","last_washed_on"]]}
 };
 ccImpSpec=function(type){return SPEC[type]||origSpec(type)};
 window.ccImpTypes=["plants","issues","tasks","wash_tables"];

 const pad=n=>String(n).padStart(2,"0");
 function pdate(v){v=String(v||"").trim();if(!v)return"";let m;
  if((m=v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)))return m[1]+"-"+pad(m[2])+"-"+pad(m[3]);
  if((m=v.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/))){let y=+m[3];if(y<100)y+=2000;return y+"-"+pad(m[2])+"-"+pad(m[1])}  /* day-first (India) */
  const d=new Date(v);return isNaN(d)?"":d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())}
 const FQ={daily:"Daily",weekly:"Weekly",monthly:"Monthly",quarterly:"Quarterly","half-yearly":"Half-yearly","half yearly":"Half-yearly",halfyearly:"Half-yearly","semi-annual":"Half-yearly","6 monthly":"Half-yearly",annual:"Annual",annually:"Annual",yearly:"Annual"};
 const names=s=>String(s||"").split(/[,;\/&\n]| and /i).map(x=>x.trim()).filter(Boolean);
 const findPlant=v=>{v=String(v||"").trim().toLowerCase();return(S.plants||[]).find(p=>String(p.name).toLowerCase()===v||String(p.id).toLowerCase()===v)};
 const isExample=r=>r.some(x=>/^example\b/i.test(String(x||"").trim()));

 ccPickFile=function(input){
  const f=input.files&&input.files[0];if(!f)return;const t=S.impType||"plants";
  readTableFile(f,tab=>{
   if(!tab||!tab.headers){toast("Could not read "+f.name+" — use .xlsx or .csv");return}
   S.impName=f.name;S.impHeaders=tab.headers.map(h=>NEW.includes(t)?normH(h):String(h||"").trim().toLowerCase());
   S.impRows=tab.rows.map(r=>r.map(c=>String(c==null?"":c).trim()));
   render();toast("Loaded "+f.name+" — "+S.impRows.length+" row(s). Review the preview, then press Import.");
  });
 };
 ccTemplate=function(){
  const t=S.impType||"plants";if(!NEW.includes(t))return origTpl();
  const ex={tasks:"EXAMPLE - Clean inverter fans,Inverter,\"Kerli, Nagaur\",Monthly,\"Ravi Kumar, Anita Sharma\",2026-11-01,Isolate; clean filter; record temperature,PTW + LOTO required,2",
   issues:"EXAMPLE,Plant name,Inverter,Fan failure,INV-03,ABB,High,Fan not running,2026-03-14,Ravi Kumar,Resolved,2026-03-16,Fan replaced",
   wash_tables:"EXAMPLE - Plant name,INV-01-T-01,1,2"}[t];
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["\ufeff"+SPEC[t].cols.join(",")+"\r\n"+ex+"\r\n"],{type:"text/csv;charset=utf-8"}));
  a.download="solar91-"+t.replace("_","-")+"-template.csv";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),800);
  toast("Template downloaded — the EXAMPLE row is ignored on import.");
 };

 function run(t){
  const spec=SPEC[t],rows=(S.impRows||[]).filter(r=>!isExample(r)),H=S.impHeaders||[];
  if(!rows.length){toast("Nothing to import — only the EXAMPLE row was found.");return}
  const col={};spec.map.forEach(m=>{let i=-1;for(const a of m.slice(1)){i=H.indexOf(a);if(i>=0)break}col[m[0]]=i});
  const g=(r,k)=>col[k]>=0?String(r[col[k]]||"").trim():"";
  const first=spec.map[0][0];if(col[first]<0){toast("Missing required column: "+spec.map[0][1]);return}
  let made=0,upd=0,dup=0;const skipped=[];
  if(t==="tasks"){
   rows.forEach((r,ln)=>{const name=g(r,"task");if(!name){skipped.push("row "+(ln+2)+" · no task name");return}
    const tn=g(r,"type").toLowerCase(),type=(TASK_TYPES.find(x=>x.name.toLowerCase()===tn)||{}).name||"Other";
    const freq=FQ[g(r,"frequency").toLowerCase()]||(FREQ_MAP[g(r,"frequency")]?g(r,"frequency"):"Monthly");
    const due=pdate(g(r,"start_date"))||addDays(TODAY,3),who=names(g(r,"assignee")),hrs=parseFloat(g(r,"hours"));
    const pl=g(r,"plant");let plantList=["—"];
    if(pl){if(/^all(\s+plants)?$/i.test(pl))plantList=(S.plants||[]).map(x=>x.name);
     else{plantList=[];names(pl).forEach(n=>{const x=findPlant(n);if(x)plantList.push(x.name);else skipped.push("row "+(ln+2)+" · unknown plant \""+n+"\"")});}
     if(!plantList.length)return}
    plantList.forEach(plantName=>(who.length?who:["Unassigned"]).forEach(a=>{
     S.tasks.unshift({id:uid("WO"),plant:plantName,name,type,equip:"—",freq,due,assignee:a,status:"Scheduled",sop:g(r,"how")||"From uploaded schedule",safety:g(r,"safety")||"—",tools:"—",duration:(hrs>0?hrs:4)+" hrs",completion:null,evidence:[],linkedIssue:null,
      log:[{at:stamp(),text:"Imported from "+(S.impName||"file")+(plantName==="—"?" — plant to be assigned later":""),actor:OM_HEAD}]});made++}));
   });
  }
  if(t==="issues"){
   const OK=["Open","Assigned","Acknowledged","In Progress","Pending Vendor","Resolved","Closed"];
   rows.forEach((r,ln)=>{const p=findPlant(g(r,"plant"));if(!p){skipped.push("row "+(ln+2)+" · unknown plant \""+g(r,"plant")+"\"");return}
    const want=g(r,"id");if(want&&S.issues.some(x=>x.id===want)){dup++;return}
    const sev=SEV.find(x=>x===normalizeIssueSeverity(g(r,"sev")))||"Medium";
    const occ=pdate(g(r,"occ"))||TODAY,resd=pdate(g(r,"resolved"));
    let status=OK.find(x=>x.toLowerCase()===g(r,"status").toLowerCase())||(resd?"Resolved":(g(r,"who")?"Assigned":"Open"));
    if(resd&&status!=="Closed")status="Resolved";
    const created=occ+"T09:00",done=status==="Resolved"||status==="Closed",closedAt=(resd||occ)+"T17:00",note=g(r,"res");
    const vt=g(r,"type"),vert=VERTICALS.find(x=>x.toLowerCase()===vt.toLowerCase())||(vt?vt:"Other");
    S.issues.unshift({id:want||newTicketId(),plant:p.name,vertical:vert,sub:g(r,"sub")||null,equip:g(r,"equip")||"—",desc:g(r,"desc")||"Imported record — add details",
     severity:sev,created,etc:addHoursISO(created,etcHrs(sev)),photos:0,impact:null,maker:g(r,"maker"),occurred:created,assignee:g(r,"who")||null,vendor:null,status,
     progress:[{at:created,note:"Imported historical record"+(done&&note?" — "+note:""),parts:"—",hrs:0}],
     closure:done?{rootCause:"—",corrective:note||"Imported historical record",photos:0,closedAt,hrs:0,resolutionHrs:Math.max(0,Math.round(hrsBetween(created,closedAt)))}:null,
     sourceTask:null,reopenedFrom:null,reopenCount:0,updated:done?closedAt:created});made++;
   });
  }
  if(t==="wash_tables"){
   rows.forEach((r,ln)=>{const p=findPlant(g(r,"plant")),tid=g(r,"tid"),inv=parseInt(g(r,"inv").replace(/[^0-9]/g,""))||null;
    if(!p||!tid||!inv){skipped.push("row "+(ln+2)+" · needs plant, table_id and inverter");return}
    const sec=parseInt(g(r,"sec").replace(/[^0-9]/g,""))||null,next=pdate(g(r,"next"))||null,last=pdate(g(r,"last"));
    const meta=S.washMeta[p.name]||{team:[],freq:14},freq=Math.max(1,parseInt(g(r,"freq"))||meta.freq||14),team=names(g(r,"crew"));
    const cur=(S.washing||[]).find(x=>x.plant===p.name&&x.tableId===tid);
    let hist=cur?cur.history:[];if(last&&!hist.some(h=>h.type==="wash"&&h.date===last))hist=hist.concat([{type:"wash",date:last,by:(team[0]||(meta.team||[])[0]||"Imported")}]);
    const patch={plant:p.name,inv,invSecondary:sec,tableId:tid,nextDue:next||(last?addDays(last,freq):null),rescheduledTo:cur?cur.rescheduledTo:null,history:hist};
    if(cur){S.washing=S.washing.map(x=>x.id===cur.id?{...x,...patch}:x);upd++}else{S.washing.push({id:uid("TBL"),...patch});made++}
    S.washMeta[p.name]={team:team.length?team:(meta.team&&meta.team.length?meta.team:["—"]),freq};
   });
  }
  audit("Data imports","Imported "+made+" "+t+(upd?" · "+upd+" updated":"")+(dup?" · "+dup+" duplicate(s) skipped":"")+(skipped.length?" · "+skipped.length+" row(s) skipped":"")+" from "+(S.impName||"file"),OM_HEAD);
  const nm=S.impName;S.impRows=null;S.impHeaders=null;S.impName=null;persist();render();
  ccPopup("Import complete — "+made+" added"+(upd?", "+upd+" updated":""),(dup?dup+" duplicate ticket(s) ignored. ":"")+(skipped.length?skipped.length+" row(s) skipped — details in the notification.":"From "+(nm||"your file")+"."),"s",t==="issues"?(()=>goTab("issues")):null);
  if(skipped.length)toast("Skipped: "+skipped.slice(0,3).join(" · ")+(skipped.length>3?" +"+(skipped.length-3)+" more":""));
 }
 ccDoImport=function(){const t=S.impType||"plants";if(NEW.includes(t))return run(t);return origDo()};
})();
