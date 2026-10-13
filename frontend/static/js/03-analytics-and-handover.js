"use strict";
/* ---------------- ANALYTICS & REPORTING ---------------- */
function washCompliancePct(){let ok=0,tot=0;S.plants.forEach(p=>{const freq=(S.washMeta[p.name]||{freq:14}).freq;S.washing.filter(t=>t.plant===p.name).forEach(t=>{tot++;if(daysSince(t)<=freq)ok++;});});return tot?Math.round(100*ok/tot):100;}
function pmOnTimePct(){const done=S.tasks.filter(t=>t.completion);return done.length?Math.round(100*done.filter(t=>t.completion.date<=t.due).length/done.length):100;}
function healthScores(){
 const hoAll=S.handovers.map(hoProg).reduce((s,p)=>({d:s.d+p.done,t:s.t+p.total}),{d:0,t:0});
 const ho=hoAll.t?Math.round(100*hoAll.d/hoAll.t):100;
 const open=openTk(S.issues),br=open.filter(t=>slaState(t)==="breach").length;
 const iss=open.length?Math.round(100*(open.length-br)/open.length):100;
 const grade=v=>v>=85?["Good","#22C55E"]:v>=70?["Attention","#D97706"]:["Critical","#DC4C3E"];
 const has=[hoAll.t>0,S.tasks.length>0,(typeof washHasData==="function"?washHasData():S.washing.length>0),S.issues.length>0];
 return [["Handover",ho],["Sched. O&M",pmOnTimePct()],["Washing",washCompliancePct()],["Issues",iss]].map((x,k)=>has[k]?{label:x[0],pct:x[1],color:grade(x[1])[1],note:grade(x[1])[0]}:{label:x[0],pct:null,color:"#94A3B8",note:"No data"});
}
function gen7rows(){return trendFor(S.plants,7).map(r=>({label:r.day,gen:Math.round(r.generation),tgt:Math.round(r.target||0)}))}
function genTargetChart(rows){
 if(!rows.length)return '<div style="padding:28px 0;text-align:center;font-size:12px;color:var(--muted-foreground)">No generation data available</div>';
 const w=900,h=230,left=42,right=14,top=14,bottom=30;
 const max=Math.max(1,...rows.flatMap(r=>[r.gen,r.tgt]))*1.15;
 const x=i=>left+i*((w-left-right)/Math.max(1,rows.length-1)),y=v=>h-bottom-(v/max)*(h-top-bottom);
 const pts=k=>rows.map((r,i)=>x(i).toFixed(1)+","+y(r[k]).toFixed(1)).join(" ");
 const area=left+","+(h-bottom)+" "+pts("gen")+" "+x(rows.length-1).toFixed(1)+","+(h-bottom);
 let grid="";[.25,.5,.75,1].forEach(f=>{const yy=y(max*f).toFixed(1);grid+='<line x1="'+left+'" x2="'+(w-right)+'" y1="'+yy+'" y2="'+yy+'" stroke="#E4E9E6" stroke-dasharray="3 4"/><text x="'+(left-6)+'" y="'+(+yy+3)+'" text-anchor="end" font-size="8.5" fill="#69756F">'+Math.round(max*f)+'</text>'});
 const labels=rows.map((r,i)=>'<text x="'+x(i).toFixed(1)+'" y="'+(h-8)+'" text-anchor="middle" font-size="9" fill="#69756F">'+r.label+'</text>').join("");
 const hits=rows.map((r,i)=>{const b2=(w-left-right)/Math.max(1,rows.length-1);return '<rect class="hit" x="'+(x(i)-b2/2).toFixed(1)+'" y="0" width="'+b2.toFixed(1)+'" height="'+h+'" data-tip="'+esc(r.label+"\nGeneration: "+r.gen+" mWh\nPV Syst target: "+r.tgt+" mWh"+(r.tgt?"\nAchievement: "+Math.round(r.gen/r.tgt*100)+"%":""))+'"/>'}).join("");
 return '<div class="line-chart-wrap"><svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none"><defs><linearGradient id="gen-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#22C55E" stop-opacity=".26"/><stop offset="100%" stop-color="#22C55E" stop-opacity=".02"/></linearGradient></defs>'+grid+
  '<polygon points="'+area+'" fill="url(#gen-fill)"/><polyline points="'+pts("tgt")+'" fill="none" stroke="#94A3B8" stroke-width="1.6" stroke-dasharray="5 5"/>'+
  '<polyline points="'+pts("gen")+'" fill="none" stroke="#22C55E" stroke-width="2.4"/>'+rows.map((r,i)=>'<circle cx="'+x(i).toFixed(1)+'" cy="'+y(r.gen).toFixed(1)+'" r="2.4" fill="#22C55E"/>').join("")+labels+hits+'</svg>'+
  '<div class="row" style="gap:14px;justify-content:flex-end;margin-top:6px;font-size:11px;color:var(--muted-foreground)"><span class="row" style="gap:5px"><span class="dot" style="width:7px;height:7px;background:#22C55E"></span>Generation</span><span class="row" style="gap:5px"><span class="dot" style="width:7px;height:7px;background:#94A3B8"></span>Target</span></div></div>';
}
function trend6(){const rows=xlMonthly(S.plants,6),g=rows.map(r=>Math.round(r.cg/1000)),t=rows.map(r=>Math.round(r.ct/1000));
 return {labels:rows.map(monthLabel),max:Math.max(10,...g,...t)*1.1,series:[{name:"Generation (mWh)",color:"#22C55E",vals:g},{name:"PV Syst target (mWh)",color:"#94A3B8",vals:t}]};
}
function multiLineChart(labels,series,yMin,yMax){
 if(!labels.length)return '<div style="padding:28px 0;text-align:center;font-size:12px;color:var(--muted-foreground)">No monthly generation data available</div>';
 const w=900,h=230,left=36,right=14,top=14,bottom=30;
 const x=i=>left+i*((w-left-right)/Math.max(1,labels.length-1)),y=v=>h-bottom-((v-yMin)/(yMax-yMin))*(h-top-bottom);
 let grid="";for(let k=0;k<=4;k++){const v=yMin+(yMax-yMin)*k/4,yy=y(v).toFixed(1);grid+='<line x1="'+left+'" x2="'+(w-right)+'" y1="'+yy+'" y2="'+yy+'" stroke="#E4E9E6" stroke-dasharray="3 4"/><text x="'+(left-6)+'" y="'+(+yy+3)+'" text-anchor="end" font-size="8.5" fill="#69756F">'+Math.round(v)+'</text>';}
 const xl=labels.map((l,i)=>'<text x="'+x(i).toFixed(1)+'" y="'+(h-8)+'" text-anchor="middle" font-size="9" fill="#69756F">'+l+'</text>').join("");
 const hits=labels.map((l,i)=>{const b2=(w-left-right)/Math.max(1,labels.length-1);return '<rect class="hit" x="'+(x(i)-b2/2).toFixed(1)+'" y="0" width="'+b2.toFixed(1)+'" height="'+h+'" data-tip="'+esc(l+series.map(s=>"\n"+s.name+": "+s.vals[i]).join(""))+'"/>'}).join("");
 const lines=series.map(s=>'<polyline points="'+s.vals.map((v,i)=>x(i).toFixed(1)+","+y(v).toFixed(1)).join(" ")+'" fill="none" stroke="'+s.color+'" stroke-width="2"/>'+s.vals.map((v,i)=>'<circle cx="'+x(i).toFixed(1)+'" cy="'+y(v).toFixed(1)+'" r="2.2" fill="'+s.color+'"/>').join("")).join("");
 return '<div class="line-chart-wrap"><svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'+grid+lines+xl+hits+'</svg>'+
  '<div class="row" style="gap:14px;justify-content:flex-end;margin-top:6px;font-size:11px;color:var(--muted-foreground)">'+series.map(s=>'<span class="row" style="gap:5px"><span class="dot" style="width:7px;height:7px;background:'+s.color+'"></span>'+s.name+'</span>').join("")+'</div></div>';
}
const REPORT_DEFS=[["daily","Daily operations snapshot","Daily 18:00","O&M Head, regional heads"],
 ["weekly","Weekly client report — per plant","Weekly Mon 08:00","Client / asset owners"],
 ["monthly","Monthly O&M compliance pack","Monthly 1st","All clients"],
 ["handover","Handover status digest","Weekly Fri 16:00","O&M Head"]];
function slaMetPct(sev){
 const ts=S.issues.filter(t=>normalizeIssueSeverity(t.severity)===normalizeIssueSeverity(sev));if(!ts.length)return 100;
 const met=ts.filter(t=>(t.status==="Closed"||t.status==="Resolved")?(t.closure&&new Date(t.closure.closedAt)<=new Date(t.etc)):slaState(t)!=="breach").length;
 return Math.round(100*met/ts.length);
}


function renderAnalytics(){
 const hs=healthScores(),g7=gen7rows(),t6=trend6();
 const mbx=Math.max(1,...EQUIP_MTB.map(e=>e.mtbf)),mrx=Math.max(1,...EQUIP_MTB.map(e=>e.mttr));
 const pal=["#F59E0B","#22C55E","#DC4C3E","#3B82F6","#8B5CF6"];
 const slaRows=[["Critical Issues ("+etcHrs("Critical")+"h)",S.issues.some(isCriticalIssue)?slaMetPct("Critical"):null,"#DC4C3E"],["Medium Issues ("+etcHrs("Medium")+"h)",S.issues.some(t=>t.severity==="Medium")?slaMetPct("Medium"):null,"#3B82F6"],["Low Issues ("+etcHrs("Low")+"h)",S.issues.some(t=>t.severity==="Low")?slaMetPct("Low"):null,"#94A3B8"],["Wash Frequency",S.washing.length?washCompliancePct():null,"#8B5CF6"],["PM On-Time",S.tasks.some(t=>t.completion)?pmOnTimePct():null,"#22C55E"]];
 let h='<div class="row between wrap" style="align-items:flex-end;gap:12px"><div><h1 style="font-size:20px;font-weight:700">Analytics &amp; Reporting</h1><p style="font-size:12.5px;color:var(--muted-foreground);margin:4px 0 0">Cross-section performance, trends, and SLA compliance</p></div>'+
  '<button class="btn p" onclick="downloadReport(\'pack\')">'+I.dl(14)+'Download report pack</button></div>';
 h+='<div class="panel"><h2 style="font-size:14px;font-weight:700">Section Health Scores</h2><p style="font-size:11.5px;color:var(--muted-foreground);margin:3px 0 4px">Composite per-section score — checklist progress, on-time delivery, wash compliance and SLA adherence</p>'+
  '<div class="row wrap" style="justify-content:center;gap:64px;padding:16px 0 8px">'+hs.map(x=>'<div style="text-align:center">'+ring(x.pct,x.color,92)+'<div style="font-size:12.5px;font-weight:600;margin-top:10px">'+x.label+'</div><div style="font-size:11px;color:var(--muted-foreground);margin-top:2px">'+x.note+'</div></div>').join("")+'</div></div>';
 h+='<div class="kgrid" style="grid-template-columns:1fr 1fr;align-items:start">'+
  '<div class="panel"><h2 style="font-size:14px;font-weight:700">Generation vs Target — 7 Days</h2><p style="font-size:11.5px;color:var(--muted-foreground);margin:3px 0 10px">Fleet output (mWh) against the PV Syst daily target · Excel DGR, last 7 reported days · like-for-like on plants with a target</p>'+genTargetChart(g7)+'</div>'+
  '<div class="panel"><h2 style="font-size:14px;font-weight:700">Monthly Generation vs PV Syst Target — 6 Months</h2><p style="font-size:11.5px;color:var(--muted-foreground);margin:3px 0 10px">Fleet mWh, like-for-like on plants with a PV Syst target · latest month is month-to-date · PR / availability history is not in the Excel data</p>'+multiLineChart(t6.labels,t6.series,0,t6.max)+'</div></div>';
 h+='<div class="kgrid" style="grid-template-columns:1.6fr 1fr;align-items:start">'+
  '<div class="panel"><h2 style="font-size:14px;font-weight:700">MTBF &amp; MTTR by Equipment Type</h2><p style="font-size:11.5px;color:var(--muted-foreground);margin:3px 0 14px">Reliability &amp; maintainability per equipment vertical (3.4)</p><div class="col" style="gap:14px">'+
   (EQUIP_MTB.length?'':'<div style="font-size:12px;color:var(--muted-foreground);padding:6px 0">No equipment reliability data yet — MTBF / MTTR are derived once Issues and Preventive Maintenance records exist.</div>')+EQUIP_MTB.map((e,i)=>'<div style="display:grid;grid-template-columns:130px 1fr 1fr;gap:18px;align-items:center"><div style="font-size:12px;font-weight:500">'+e.type+'</div>'+
   '<div><div class="row between" style="font-size:10px;color:var(--muted-foreground);margin-bottom:4px"><span>MTBF</span><span>'+e.mtbf+'h</span></div><div class="hbar"><i style="width:'+Math.round(100*e.mtbf/mbx)+'%;background:'+pal[i%pal.length]+'"></i></div></div>'+
   '<div><div class="row between" style="font-size:10px;color:var(--muted-foreground);margin-bottom:4px"><span>MTTR</span><span>'+e.mttr+'h</span></div><div class="hbar"><i style="width:'+Math.max(4,Math.round(100*e.mttr/mrx))+'%;background:#FCA5A5"></i></div></div></div>').join("")+'</div></div>'+
  '<div class="panel"><h2 style="font-size:14px;font-weight:700">SLA Compliance</h2><p style="font-size:11.5px;color:var(--muted-foreground);margin:3px 0 14px">Adherence against committed contractual thresholds</p><div class="col" style="gap:14px">'+
   slaRows.map(r=>'<div><div class="row between" style="font-size:12px;margin-bottom:5px"><span>'+r[0]+'</span><b style="color:'+r[2]+'">'+(r[1]==null?'N/A':r[1]+'%')+'</b></div><div class="hbar"><i style="width:'+(r[1]||0)+'%;background:'+r[2]+'"></i></div></div>').join("")+'</div></div></div>';
 h+=renderSecReports();
 h+='<div class="panel"><h2 style="font-size:14px;font-weight:700">Report downloads (3.10)</h2><p style="font-size:11.5px;color:var(--muted-foreground);margin:3px 0 12px">Client-facing packs generated from live data — CSV export here, emailed on schedule by the 3.8 engine</p><div class="col" style="gap:10px">'+
  REPORT_DEFS.map(r=>'<div class="row between wrap" style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;gap:10px"><div><div style="font-weight:600;font-size:13px">'+r[1]+'</div><div style="font-size:11px;color:var(--muted-foreground)">'+r[2]+' → '+r[3]+'</div></div>'+
  '<button class="btn o sm" onclick="downloadReport(\''+r[0]+'\')">'+I.dl(12)+'Download</button></div>').join("")+'</div></div>';
 return h;
}
