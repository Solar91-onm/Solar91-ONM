"use strict";
/* Site Issues spreadsheet upload: raise many tickets at once (same rules as Raise Issue). Uses the shared upload
   dialog from 28-washing-import.js. Photos, progress, resolution and closing stay on each ticket in the portal. */
(function(){
 const h=value=>typeof esc==="function"?esc(value==null?"":String(value)):String(value==null?"":value);
 const KINDS=window.s91UploadKinds=window.s91UploadKinds||{};
 const role=()=>S._roleLabel||S.currentRole||(typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role)||"";
 const canRaise=()=>["O&M Head","Assignee","Site Engineer"].includes(role());
 const tone={Critical:"crit",Medium:"warn",Low:"ok"};
 KINDS.issues={
  tabLabel:"Site issues",allowed:canRaise,
  title:"Upload site issues",subtitle:"Raise many tickets from one spreadsheet instead of one by one.",
  step1:()=>'<p>Download the template: one row per issue with <b>Site code</b>, <b>Issue category</b>, <b>Description</b> and <b>Severity</b>. Occurred on, target date, equipment, Assignee and <b>Remarks</b> (what is going on right now) are optional; drop-down lists are included.</p>'+
   '<div class="row wrap"><button class="btn o sm" onclick="s91UploadDownload(\'/api/issues/import/template\',\'Site_Issues_Template.xlsx\')">Download template</button></div>',
  limitText:"An .xlsx or .csv file, up to 2 MB and 500 issue rows.",
  importUrl:"/api/issues/import",
  counts:[["new","Will raise"],["critical","Critical"],["unchanged","Already open"],["problems","Problems"]],
  columns:[["Site code",r=>h(r.site_code)],["Issue",r=>'<b>'+h(r.category)+'</b>'+(r.severity?' <span class="wc-chip wc-'+(tone[r.severity]||"info")+'">'+h(r.severity)+'</span>':'')+'<div class="sub">'+h(r.description)+'</div>'+(r.remarks?'<div class="sub"><b>Remarks:</b> '+h(r.remarks)+'</div>':'')],["Assignee",r=>h(r.assignee||"—")]],
  actionLabel:a=>a==="New"?"Will raise":a,
  canSave:p=>Number(p.new||0)>0,
  readyText:p=>p.new+" ticket"+(p.new===1?"":"s")+" will be raised"+(p.assigned?" ("+p.assigned+" assigned)":"")+(p.unchanged?"; "+p.unchanged+" already open will be skipped.":"."),
  saveLabel:"Raise tickets",
  savedText:r=>r.saved+" ticket"+(r.saved===1?"":"s")+" raised"+(r.tickets&&r.tickets.length?" ("+r.tickets[0]+(r.tickets.length>1?" – "+r.tickets[r.tickets.length-1]:"")+")":"")+".",
  afterSave:async()=>{if(window.s91LiveRefresh&&typeof window.s91LiveRefresh.tick==="function")await window.s91LiveRefresh.tick()}
 };
 window.issueUploadOpen=function(){if(!canRaise()){toast("Your role cannot raise issues.");return}window.s91UploadOpen("issues")};
})();
