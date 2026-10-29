"use strict";
/* Plants · Operations pulse (Plants dashboard page).
   Gauges, activity bars, an open-work pie, trend lines and a washing "battery", filtered by plant, equipment type,
   district / SPV project and engineer. On a laptop or desktop the whole pulse fits one screen; on smaller screens
   the cards stack. Read-only: it uses the loaded Site Issues and Preventive Maintenance records plus the washing
   overview (GET /api/scheduled/washing/overview, loaded once and cached). Every card opens the matching module with
   the same filters; nothing here writes to the server. */
(function(){
 if(window.s91PlantPulse)return;
 const h=v=>typeof esc==="function"?esc(v==null?"":String(v)):String(v==null?"":v);
 const pct=(n,t)=>t?Math.round(100*n/t):0;
 const COLORS={raised:"#C93BE6",resolved:"#5B84F5",pm:"#EBCB1C"};
 const LABELS={raised:"Raised",resolved:"Resolved",pm:"PM done"};
 const st=()=>{
  const f=S.plPulse=S.plPulse||{};
  const d={plant:S.dashPlant||"all",eq:"all",area:"all",eng:"all",bars:"day",issues:"day",pm:"day"};
  Object.keys(d).forEach(k=>{if(f[k]===undefined)f[k]=d[k]});
  if(!f.show)f.show={raised:true,resolved:true,pm:true};
  return f;
 };

 /* ---------- periods: Day / Week / Month buckets ending on the operations date ---------- */
 function buckets(range,days){
  const out=[];
  if(range==="month"){
   const base=new Date(TODAY+"T00:00:00");
   for(let i=5;i>=0;i--){
    const d=new Date(base.getFullYear(),base.getMonth()-i,1),y=d.getFullYear(),m=d.getMonth();
    const start=y+"-"+pad2(m+1)+"-01",last=new Date(y,m+1,0).getDate();
    let end=y+"-"+pad2(m+1)+"-"+pad2(last);if(end>TODAY)end=TODAY;
    out.push({label:d.toLocaleDateString("en-GB",{month:"short"}),start,end});
   }
  }else if(range==="week"){
   for(let i=7;i>=0;i--){const end=addDays(TODAY,-7*i),start=addDays(end,-6);out.push({label:i===0?"This wk":"−"+i+"w",start,end})}
  }else{
   for(let i=days-1;i>=0;i--){const d=addDays(TODAY,-i),dt=new Date(d+"T00:00:00");out.push({label:days>7?String(dt.getDate()):dt.getDate()+" "+dt.toLocaleDateString("en-GB",{month:"short"}),start:d,end:d})}
  }
  return out;
 }
 const RANGE_NOTE={day:"days",week:"weeks",month:"months"};
 /* axis top that splits into 4 whole-number steps (counts never show 2.5 or 7.5) */
 const niceMax=v=>{if(v<=4)return 4;const raw=Math.ceil(v/4),p=Math.pow(10,Math.floor(Math.log10(raw)));const step=[1,1.5,2,2.5,3,4,5,6,8,10].map(m=>m*p).filter(Number.isInteger).find(s=>s>=raw)||10*p;return step*4};
 const narrow=()=>typeof window.matchMedia==="function"&&window.matchMedia("(max-width:720px)").matches;
 /* one screen on a laptop or desktop; below this the cards stack and the page scrolls */
 const fitMode=()=>innerWidth>1100&&innerHeight>620;
 const doneDay=t=>{const c=t.completion&&t.completion.date;const v=c||t.actualCompleted||"";return /^\d{4}-\d{2}-\d{2}/.test(v)?String(v).slice(0,10):null};
 /* charts are drawn at the size their box had on the last paint, so axis text stays at its real size */
 const dims=(key,dw,dh)=>{const d=(S._ppDims||{})[key];return d&&d[0]>60&&d[1]>24?d:[dw,dh]};

 /* ---------- filters: plant, equipment type, district / SPV project, engineer ---------- */
 const districtOf=p=>p.district||(p.geo&&p.geo.city)||p.location||"";
 const projectOf=p=>typeof plantProject==="function"&&typeof plantProjectKey==="function"?plantProjectKey(plantProject(p)):"";
 function areaMatch(p,area){
  if(area==="all")return true;
  if(area.indexOf("d:")===0)return districtOf(p)===area.slice(2);
  if(area.indexOf("p:")===0)return projectOf(p)===area.slice(2);
  return true;
 }
 const uniq=a=>[...new Set(a.filter(Boolean))].sort((x,y)=>String(x).localeCompare(String(y),undefined,{numeric:true}));
 const projectLabel=k=>/^\d+$/.test(k)?"Project "+k:k;

 /* ---------- data for the selected scope ---------- */
 function scopeData(sp){
  const f=st(),names=new Set(sp.map(p=>p.name));
  if(f.plant!=="all"&&!names.has(f.plant))f.plant="all";
  const plants=sp.filter(p=>(f.plant==="all"||p.name===f.plant)&&areaMatch(p,f.area)),pick=new Set(plants.map(p=>p.name));
  const eqOk=v=>f.eq==="all"||v===f.eq,engOk=v=>f.eng==="all"||v===f.eng;
  const issues=(S.issues||[]).filter(t=>pick.has(t.plant)&&eqOk(t.vertical)&&engOk(t.assignee));
  const tasks=(S.tasks||[]).filter(t=>pick.has(t.plant)&&t.status!=="Cancelled"&&eqOk(t.type)&&engOk(t.assignee));
  const open=openTk(issues),overdueIssues=open.filter(isOverdueIssue);
  const resolved=issues.filter(t=>t.status==="Resolved"||t.status==="Closed");
  const pmOverdue=tasks.filter(t=>t.status!=="Completed"&&taskOD(t)>0);
  const pmDueSoon=tasks.filter(t=>t.status!=="Completed"&&taskOD(t)===0&&t.due&&dayDiff(TODAY,t.due)>=0&&dayDiff(TODAY,t.due)<=7);
  /* washing has no equipment or engineer: it follows the plant filters only */
  const wc=S._washCycles,washRows=wc?(wc.plants||[]).filter(p=>pick.has(p.plant)):[];
  const thr=(washRows[0]&&washRows[0].compliance_threshold_percent)||85;
  /* washing compliance = cycles completed this month / the month's cycles (3 a plant): one plant's own cycles, or the
     total for every plant in scope. It only rises as cycles complete; the colour compares it with the cycles due by today. */
  const cyclesDone=washRows.reduce((a,p)=>a+Math.min(p.cycles_this_month||0,p.monthly_target||3),0),cyclesTarget=washRows.reduce((a,p)=>a+(p.monthly_target||3),0);
  const washDue=washRows.reduce((a,p)=>a+(p.cycles||[]).filter(c=>c.due_date&&c.due_date<TODAY).length,0);
  const washPct=wc&&cyclesTarget?Math.round(100*cyclesDone/cyclesTarget):null,washDuePct=cyclesTarget?Math.round(100*washDue/cyclesTarget):0,washDone=cyclesDone;
  const washLate=washRows.filter(p=>p.overdue_bucket&&p.overdue_bucket!=="on_track").length;
  const whole=f.plant==="all"&&f.area==="all";
  const tablesToday=whole&&wc&&wc.portfolio?(wc.portfolio.tables_washed_today||0):washRows.reduce((a,p)=>{const d=(p.daily_status||[]).find(x=>x.date===TODAY);return a+(d?(d.confirmed||0):0)},0);
  return{f,plants,pick,issues,tasks,open,overdueIssues,resolved,pmOverdue,pmDueSoon,wc,washRows,thr,washPct,washDuePct,washDone,washDue,cyclesDone,cyclesTarget,washLate,tablesToday,
   washAll:f.eq!=="all"||f.eng!=="all",notSetUp:wc?(wc.unconfigured||[]).filter(p=>pick.has(p.plant)).length:0};
 }

 /* ---------- gauge (270° dial with Low / Moderate / High bands and a needle) ----------
    Higher is always better: 0 sits in the red Low band and 100 in the green High band. The bands are a faint track;
    a solid arc fills from 0 up to the value in its band colour, so a rising score visibly moves toward green. */
 function gauge(o){
  const cx=60,cy=56,r=38,A=a=>[cx+r*Math.cos(a*Math.PI/180),cy+r*Math.sin(a*Math.PI/180)];
  const ang=v=>135+270*Math.max(0,Math.min(100,v))/100;
  const arc=(v1,v2,color,cls,gap)=>{gap=gap==null?1.2:gap;const a1=ang(v1)+gap,a2=ang(v2)-gap;if(a2<=a1)return "";const p1=A(a1),p2=A(a2);return '<path d="M'+p1[0].toFixed(2)+' '+p1[1].toFixed(2)+' A'+r+' '+r+' 0 '+(a2-a1>180?1:0)+' 1 '+p2[0].toFixed(2)+' '+p2[1].toFixed(2)+'" stroke="'+color+'" stroke-width="9" fill="none" stroke-linecap="butt" class="'+(cls||"")+'"/>'};
  const ticks=[0,20,40,60,80,100].map(v=>{const a=ang(v)*Math.PI/180,x=cx+(r+11)*Math.cos(a),y=cy+(r+11)*Math.sin(a);return '<text x="'+x.toFixed(1)+'" y="'+(y+2.5).toFixed(1)+'" text-anchor="middle">'+v+'</text>'}).join("");
  let needle="";
  if(typeof o.value==="number"){const a=ang(o.value)*Math.PI/180,x=cx+(r-9)*Math.cos(a),y=cy+(r-9)*Math.sin(a);needle='<line x1="'+cx+'" y1="'+cy+'" x2="'+x.toFixed(2)+'" y2="'+y.toFixed(2)+'" class="pp-needle"/><circle cx="'+cx+'" cy="'+cy+'" r="4.2" class="pp-hub"/>'}
  const has=typeof o.value==="number";
  const tone=!has?"var(--gx-mut)":o.value>=o.high?"#16A34A":o.value>=o.low?"#F97316":"#DC2626";
  const track=has?arc(0,o.low,"#DC2626","pp-track")+arc(o.low,o.high,"#F97316","pp-track")+arc(o.high,100,"#22C55E","pp-track"):arc(0,100,"var(--gx-line)","",0);
  const fill=has&&o.value>0?arc(0,o.value,tone==="#16A34A"?"#22C55E":tone,"pp-fill",0):"";
  const band=typeof o.value!=="number"?"No data":o.value>=o.high?"High":o.value>=o.low?"Moderate":"Low";
  return '<button type="button" class="pp-card pp-gauge" onclick="s91PulseGo(\''+o.go+'\')" title="'+h(o.tip+" · Low <"+o.low+"%, Moderate "+o.low+"–"+(o.high-1)+"%, High ≥"+o.high+"%")+'"><div class="pp-gauge-top"><b>'+h(o.title)+'</b>'+
   '<div class="pp-legend"><span><i style="background:#DC2626"></i>Low &lt;'+o.low+'%</span><span><i style="background:#F97316"></i>Moderate '+o.low+'–'+(o.high-1)+'%</span><span><i style="background:#16A34A"></i>High ≥'+o.high+'%</span></div></div>'+
   '<div class="pp-gauge-body"><div class="pp-gauge-copy"><strong style="color:'+tone+'">'+(typeof o.value==="number"?o.value+"%":"—")+'</strong><small>'+h(o.sub)+'</small><em class="pp-band" style="--c:'+tone+'">'+band+'</em></div>'+
   '<svg class="pp-dial" viewBox="0 0 120 104" aria-hidden="true"><circle cx="'+cx+'" cy="'+cy+'" r="'+(r-6)+'" class="pp-dial-face"/>'+track+fill+ticks+'<text x="'+cx+'" y="'+(cy+19)+'" text-anchor="middle" class="pp-dial-unit">(0-100%)</text>'+needle+'</svg></div></button>';
 }

 /* ---------- grouped capsule bars (activity) ---------- */
 function barsCard(d){
  const f=st(),small=narrow(),bs=buckets(f.bars,small?7:14),keys=["raised","resolved","pm"].filter(k=>f.show[k]);
  const rows=bs.map(b=>{
   const inB=day=>day&&day>=b.start&&day<=b.end;
   return{b,raised:d.issues.filter(t=>inB(issueCreatedDay(t))).length,resolved:d.issues.filter(t=>inB(issueClosedDay(t))).length,pm:d.tasks.filter(t=>inB(doneDay(t))).length};
  });
  const [W,H]=dims("bars",small?360:640,small?220:250),L=30,R=8,T=10,B=24,pw=W-L-R,ph=H-T-B;
  const max=niceMax(Math.max(1,...rows.map(r=>keys.reduce((a,k)=>a+r[k],0))));
  const step=pw/rows.length,cap=Math.max(4,Math.min(12,step*.42)),gap=3;
  let g="";
  for(let i=0;i<=4;i++){const v=max*i/4,y=T+ph-ph*i/4;g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" class="pp-grid"/><text x="'+(L-6)+'" y="'+(y+3.5)+'" text-anchor="end" class="pp-axis">'+(Number.isInteger(v)?v:v.toFixed(1))+'</text>'}
  const bars=rows.map((r,i)=>{
   const x=L+step*i+step/2-cap/2;let y=T+ph,segs="";
   keys.forEach(k=>{if(!r[k])return;const hgt=Math.max(cap,r[k]/max*ph-gap);y-=hgt;segs+='<rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+cap.toFixed(1)+'" height="'+hgt.toFixed(1)+'" rx="'+(cap/2).toFixed(1)+'" fill="'+COLORS[k]+'"/>';y-=gap});
   const tip=r.b.start===r.b.end?fmtD(r.b.start):fmtD(r.b.start)+" – "+fmtD(r.b.end);
   return '<g class="pp-bar" data-pp-from="'+r.b.start+'" data-pp-to="'+r.b.end+'"><title>'+h(tip)+' · '+r.raised+' raised · '+r.resolved+' resolved · '+r.pm+' PM completed · click to open these issues</title><rect x="'+(L+step*i+2).toFixed(1)+'" y="'+T+'" width="'+Math.max(1,step-4).toFixed(1)+'" height="'+ph+'" class="pp-hit"/>'+segs+'<text x="'+(L+step*i+step/2).toFixed(1)+'" y="'+(H-7)+'" text-anchor="middle" class="pp-axis">'+h(r.b.label)+'</text></g>';
  }).join("");
  const toggles=["raised","resolved","pm"].map(k=>'<button type="button" class="pp-switch'+(f.show[k]?" on":"")+'" style="--c:'+COLORS[k]+'" onclick="s91PulseSeries(\''+k+'\')" aria-pressed="'+!!f.show[k]+'">'+LABELS[k]+'<i><b></b></i></button>').join("");
  const TOTAL_LABEL={raised:"raised",resolved:"resolved",pm:"PM completed"};
  const totals=keys.map(k=>'<span><i style="background:'+COLORS[k]+'"></i>'+rows.reduce((a,r)=>a+r[k],0)+' '+TOTAL_LABEL[k]+'</span>').join("");
  return '<article class="pp-card pp-wide"><header class="pp-head"><div><h3>Work activity</h3><p>Records per '+(f.bars==="day"?"day":f.bars==="week"?"week":"month")+', last '+bs.length+' '+RANGE_NOTE[f.bars]+' · click a bar to open those issues</p></div>'+seg("bars",f.bars)+'</header>'+
   '<div class="pp-toggles">'+toggles+'</div>'+
   (keys.length?'<div class="pp-plot" data-pp-dim="bars"><svg class="pp-chart" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Work activity bar chart">'+g+bars+'</svg></div>':'<div class="pp-empty">Turn on a series above to draw the chart.</div>')+
   '<div class="pp-totals">'+totals+'</div></article>';
 }
 /* short = D / W / M on the small trend cards (full names stay for screen readers and on hover) */
 function seg(key,val,short){return '<div class="pp-seg" role="group" aria-label="Period">'+[["day","Day"],["week","Week"],["month","Month"]].map(x=>'<button type="button" class="'+(val===x[0]?"on":"")+'" aria-pressed="'+(val===x[0])+'" aria-label="'+x[1]+'" title="'+x[1]+'" onclick="s91PulseRange(\''+key+'\',\''+x[0]+'\')">'+(short?x[1][0]:x[1])+'</button>').join("")+'</div>'}

 /* ---------- open-work pie ---------- */
 function pieCard(d){
  const slices=[
   {key:"issOpen",label:"Open issues (on time)",n:d.open.length-d.overdueIssues.length,color:"#5B84F5"},
   {key:"issOver",label:"Issues past ETC",n:d.overdueIssues.length,color:"#DC4C3E"},
   {key:"pmOver",label:"PM overdue",n:d.pmOverdue.length,color:"#F97316"},
   {key:"pmSoon",label:"PM due this week",n:d.pmDueSoon.length,color:"#EBCB1C"},
   {key:"washLate",label:"Plants behind on washing",n:d.washLate,color:"#0891B2"}
  ];
  const total=slices.reduce((a,s)=>a+s.n,0),cx=100,cy=100,r=92;
  let acc=-90,paths="",labels="";
  if(!total)paths='<circle cx="100" cy="100" r="92" fill="#22A35A"/><text x="100" y="96" text-anchor="middle" class="pp-pie-clear">All clear</text><text x="100" y="114" text-anchor="middle" class="pp-pie-sub">no open work</text>';
  else slices.forEach(s=>{
   if(!s.n)return;
   const sweep=s.n/total*360,a1=acc,a2=acc+sweep,rad=a=>a*Math.PI/180;acc=a2;
   const p1=[cx+r*Math.cos(rad(a1)),cy+r*Math.sin(rad(a1))],p2=[cx+r*Math.cos(rad(a2)),cy+r*Math.sin(rad(a2))];
   const path=sweep>=359.99?'<circle cx="100" cy="100" r="92" fill="'+s.color+'" class="pp-slice" data-pp-go="'+s.key+'"><title>'+h(s.label)+': '+s.n+'</title></circle>'
    :'<path d="M100 100 L'+p1[0].toFixed(2)+' '+p1[1].toFixed(2)+' A92 92 0 '+(sweep>180?1:0)+' 1 '+p2[0].toFixed(2)+' '+p2[1].toFixed(2)+' Z" fill="'+s.color+'" class="pp-slice" data-pp-go="'+s.key+'"><title>'+h(s.label)+': '+s.n+' ('+pct(s.n,total)+'%) · click to open</title></path>';
   paths+=path;
   if(s.n/total>=.07){const m=rad(a1+sweep/2);labels+='<text x="'+(cx+r*.6*Math.cos(m)).toFixed(1)+'" y="'+(cy+r*.6*Math.sin(m)+4).toFixed(1)+'" text-anchor="middle" class="pp-pie-label">'+pct(s.n,total)+'%</text>'}
  });
  return '<article class="pp-card pp-pie-card"><header class="pp-head"><div><h3>Open work mix</h3><p>What is waiting right now · click a slice</p></div><span class="pp-total">'+total+'<small>open items</small></span></header>'+
   '<div class="pp-plot pp-pie-plot"><svg class="pp-pie" viewBox="-4 -4 208 208" role="img" aria-label="Open work mix pie chart">'+paths+(total?'<circle cx="100" cy="100" r="13" class="pp-pie-hole"/>':'')+labels+'</svg></div>'+
   '<div class="pp-pie-legend">'+slices.map(s=>'<button type="button" data-pp-go="'+s.key+'" class="'+(s.n?"":"zero")+'"><i style="background:'+s.color+'"></i><span>'+h(s.label)+'</span><b>'+s.n+'</b></button>').join("")+'</div></article>';
 }

 /* ---------- smooth line + area chart ---------- */
 function lineCard(o){
  const [W,H]=dims("line-"+o.key,360,170),L=30,R=10,T=10,B=20,pw=W-L-R,ph=H-T-B,vals=o.points.map(p=>p.v);
  const max=niceMax(Math.max(1,...vals)),n=o.points.length;
  const X=i=>L+(n===1?pw/2:pw*i/(n-1)),Y=v=>T+ph-ph*v/max;
  const pts=o.points.map((p,i)=>[X(i),Y(p.v)]);
  let path="M"+pts[0][0].toFixed(1)+" "+pts[0][1].toFixed(1);
  for(let i=0;i<pts.length-1;i++){
   const p0=pts[i-1]||pts[i],p1=pts[i],p2=pts[i+1],p3=pts[i+2]||p2,t=.18;
   const c1=[p1[0]+(p2[0]-p0[0])*t,Math.min(T+ph,Math.max(T,p1[1]+(p2[1]-p0[1])*t))],c2=[p2[0]-(p3[0]-p1[0])*t,Math.min(T+ph,Math.max(T,p2[1]-(p3[1]-p1[1])*t))];
   path+=" C"+c1[0].toFixed(1)+" "+c1[1].toFixed(1)+" "+c2[0].toFixed(1)+" "+c2[1].toFixed(1)+" "+p2[0].toFixed(1)+" "+p2[1].toFixed(1);
  }
  const area=path+" L"+pts[pts.length-1][0].toFixed(1)+" "+(T+ph)+" L"+pts[0][0].toFixed(1)+" "+(T+ph)+" Z";
  const lines=ph<70?2:4;
  let g="";for(let i=0;i<=lines;i++){const v=max*i/lines,y=T+ph-ph*i/lines;g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" class="pp-grid dashed"/><text x="'+(L-5)+'" y="'+(y+3.5)+'" text-anchor="end" class="pp-axis">'+(Number.isInteger(v)?v:v.toFixed(1))+'</text>'}
  const avg=vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:0;
  const avgLine=o.avg&&avg>0?'<line x1="'+L+'" x2="'+(W-R)+'" y1="'+Y(avg).toFixed(1)+'" y2="'+Y(avg).toFixed(1)+'" class="pp-avg" stroke="'+o.color+'"/><text x="'+(W-R)+'" y="'+(Y(avg)-4).toFixed(1)+'" text-anchor="end" class="pp-avg-label" fill="'+o.color+'">avg '+(Math.round(avg*10)/10)+'</text>':'';
  const dots=pts.map((p,i)=>'<circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="3.4" fill="'+o.color+'" class="pp-dot"><title>'+h(o.points[i].tip)+': '+vals[i]+'</title></circle>').join("");
  /* a narrow chart shows "22" instead of "22 Oct" so the day labels do not run together */
  const xl=o.points.map((p,i)=>'<text x="'+X(i).toFixed(1)+'" y="'+(H-5)+'" text-anchor="middle" class="pp-axis">'+h(W<330?String(p.label).split(" ")[0]:p.label)+'</text>').join("");
  const id="ppg-"+o.key;
  const now=vals[vals.length-1]||0,prev=vals.length>1?vals[vals.length-2]:now,delta=now-prev;
  return '<article class="pp-card pp-line" role="button" tabindex="0" onclick="if(!event.target.closest(\'.pp-seg\'))s91PulseGo(\''+o.go+'\')"><header class="pp-head"><div><h3 title="'+h(o.sub)+'">'+h(o.title)+'</h3></div>'+seg(o.key,o.range,true)+'</header>'+
   '<div class="pp-line-now"><b style="color:'+o.color+'">'+now+'</b><span>'+h(o.nowLabel)+'</span>'+(delta?'<em class="'+((delta>0)===o.upIsBad?"bad":"good")+'">'+(delta>0?"▲ ":"▼ ")+Math.abs(delta)+' vs previous</em>':'<em>no change</em>')+'</div>'+
   '<div class="pp-plot" data-pp-dim="line-'+o.key+'"><svg class="pp-chart" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+h(o.title)+' trend"><defs><linearGradient id="'+id+'" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="'+o.color+'" stop-opacity=".32"/><stop offset="1" stop-color="'+o.color+'" stop-opacity=".02"/></linearGradient></defs>'+g+avgLine+
   '<path d="'+area+'" fill="url(#'+id+')"/><path d="'+path+'" fill="none" stroke="'+o.color+'" stroke-width="2.4" stroke-linecap="round"/>'+dots+xl+'</svg></div></article>';
 }

 /* ---------- washing battery ---------- */
 function batteryCard(d){
  const f=st();
  let body;
  if(S._washCycleError&&!d.wc)body='<div class="pp-empty">Washing data is not available for your role right now.</div>';
  else if(!d.wc)body='<div class="pp-empty">Loading washing status…</div>';
  else if(!d.washRows.length)body='<div class="pp-empty">'+(d.notSetUp?(d.plants.length>1?"No plant in this scope has washing set up yet.":"Washing is not set up for this plant yet."):"No washing records in this scope.")+'</div>';
  else{
   const v=typeof d.washPct==="number"?d.washPct:0,tone=v>=d.washDuePct?"#22C55E":v>=d.washDuePct-15?"#F59E0B":"#EF4444";
   const fillH=Math.max(0,Math.min(100,v))*1.36,warnY=24+136-136*d.washDuePct/100;
   body='<div class="pp-batt-meta"><span>Cycles this month: <b>'+d.cyclesDone+' / '+d.cyclesTarget+'</b></span><span class="warn">Due by today: '+d.washDue+' ('+d.washDuePct+'%)</span>'+(d.washLate?'<span class="late">'+d.washLate+' plant'+(d.washLate===1?"":"s")+' behind a deadline</span>':'')+'</div>'+
    '<div class="pp-batt-row"><svg class="pp-battery" viewBox="0 0 90 170" aria-hidden="true"><rect x="30" y="6" width="30" height="14" rx="4" class="pp-batt-cap"/><rect x="8" y="18" width="74" height="148" rx="14" class="pp-batt-body"/>'+
    '<clipPath id="ppBattClip"><rect x="14" y="24" width="62" height="136" rx="9"/></clipPath><g clip-path="url(#ppBattClip)"><rect x="14" y="24" width="62" height="136" class="pp-batt-empty"/><rect x="14" y="'+(160-fillH).toFixed(1)+'" width="62" height="'+fillH.toFixed(1)+'" fill="'+tone+'" class="pp-batt-fill"/></g>'+
    '<line x1="14" x2="76" y1="'+warnY.toFixed(1)+'" y2="'+warnY.toFixed(1)+'" class="pp-batt-warn"/><path d="M49 52 L33 98 L45 98 L40 132 L58 82 L46 82 L52 52 Z" class="pp-bolt"/></svg>'+
    '<div class="pp-batt-val"><b style="color:'+tone+'">'+(typeof d.washPct==="number"?d.washPct+"%":"—")+'</b><small>cycles done this month</small><span>'+d.tablesToday+' tables cleaned today</span></div></div>';
  }
  return '<article class="pp-card pp-batt" role="button" tabindex="0" onclick="s91PulseGo(\'wash\')"><header class="pp-head"><div><h3>Washing level</h3><p>'+(d.washAll?"All equipment and people · plant filters only":"Cycles done this month · click to open")+'</p></div></header>'+body+'</article>';
 }

 /* ---------- "Today" card ---------- */
 function todayCard(d){
  const dt=new Date(TODAY+"T00:00:00");
  const due=d.tasks.filter(t=>t.status!=="Completed"&&t.due===TODAY).length,raised=d.issues.filter(t=>issueCreatedDay(t)===TODAY).length;
  return '<article class="pp-card pp-today"><div class="pp-today-h"><b>Today</b><span>'+h(dt.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short",year:"numeric"}))+'</span></div>'+
   '<button type="button" onclick="s91PulseGo(\'pmToday\')"><span>PM due today</span><b>'+due+'</b></button>'+
   '<button type="button" onclick="s91PulseGo(\'issToday\')"><span>Issues raised today</span><b>'+raised+'</b></button>'+
   '<button type="button" onclick="s91PulseGo(\'wash\')"><span>Tables cleaned today</span><b>'+(d.wc?d.tablesToday:"—")+'</b></button></article>';
 }

 /* ---------- filter pills (top right) ---------- */
 function filtersHtml(sp){
  const f=st(),plants=sp.slice().sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  const inSp=new Set(sp.map(p=>p.name));
  const eqs=uniq((S.issues||[]).filter(t=>inSp.has(t.plant)).map(t=>t.vertical).concat((S.tasks||[]).filter(t=>inSp.has(t.plant)).map(t=>t.type)));
  const engs=uniq((S.issues||[]).filter(t=>inSp.has(t.plant)).map(t=>t.assignee).concat((S.tasks||[]).filter(t=>inSp.has(t.plant)).map(t=>t.assignee)));
  const districts=uniq(sp.map(districtOf)),projects=uniq(sp.map(projectOf));
  const opt=(v,l,cur)=>'<option value="'+h(v)+'"'+(String(cur)===String(v)?" selected":"")+'>'+h(l)+'</option>';
  const pill=(k,label,inner)=>'<label class="pp-pill'+(f[k]!=="all"?" on":"")+'"><span>'+label+'</span><select aria-label="'+h(label)+'" onchange="s91PulseFilter(\''+k+'\',this.value)">'+inner+'</select></label>';
  const active=["plant","eq","area","eng"].filter(k=>f[k]!=="all").length;
  return '<div class="pp-filters">'+
   pill("plant","Plant",opt("all","All plants ("+sp.length+")",f.plant)+plants.map(p=>opt(p.name,(p.id?displayCode(p.id)+" · ":"")+p.name,f.plant)).join(""))+
   pill("eq","Equipment",opt("all","All equipment",f.eq)+eqs.map(x=>opt(x,x,f.eq)).join(""))+
   pill("area","Area",opt("all","All districts & SPVs",f.area)+(districts.length?'<optgroup label="District">'+districts.map(x=>opt("d:"+x,x,f.area)).join("")+'</optgroup>':'')+(projects.length?'<optgroup label="SPV / project">'+projects.map(x=>opt("p:"+x,projectLabel(x),f.area)).join("")+'</optgroup>':''))+
   pill("eng","Engineer",opt("all","Everyone",f.eng)+engs.map(x=>opt(x,x,f.eng)).join(""))+
   (active?'<button type="button" class="pp-reset" onclick="s91PulseReset()">Reset ('+active+')</button>':'')+'</div>';
 }

 /* ---------- one-screen fit: height to the window, charts redrawn at their real size ---------- */
 let fitPass=0;
 function fit(){
  const el=document.getElementById("plant-pulse");if(!el)return;
  const on=fitMode();el.classList.toggle("pp-fit",on);
  if(on){const hgt=Math.max(470,Math.floor(innerHeight-(el.getBoundingClientRect().top+scrollY)-14));S._ppH=hgt;el.style.height=hgt+"px"}else el.style.height="";
  const store=S._ppDims=S._ppDims||{};let changed=false;
  el.querySelectorAll("[data-pp-dim]").forEach(p=>{const r=p.getBoundingClientRect(),w=Math.round(r.width),ht=Math.round(r.height),k=p.getAttribute("data-pp-dim"),o=store[k];
   if(w>60&&ht>24&&(!o||Math.abs(o[0]-w)>6||Math.abs(o[1]-ht)>6)){store[k]=[w,ht];changed=true}});
  if(changed&&fitPass<3&&S.view==="plants"){fitPass++;render()}else fitPass=0;
 }
 let fitTimer=0;
 addEventListener("resize",()=>{clearTimeout(fitTimer);fitTimer=setTimeout(()=>{if(S.view==="plants"&&document.getElementById("plant-pulse"))render()},150)});

 /* ---------- main ---------- */
 window.s91PlantPulse=function(sp){
  try{
   if(!S._washCycles&&!S._washCycleError&&typeof window.washCyclesEnsureLoaded==="function"){
    window.washCyclesEnsureLoaded();
    const pending=S._washCycleLoading;
    if(pending&&!S._pulseWashWait){S._pulseWashWait=true;const done=()=>{S._pulseWashWait=false;if(S.view==="plants")render()};pending.then(done,done)}
   }
   requestAnimationFrame(fit);
   const d=scopeData(sp||[]),f=d.f;
   const pmPct=d.tasks.length?pct(d.tasks.length-d.pmOverdue.length,d.tasks.length):null;
   const issPct=d.issues.length?pct(d.resolved.length,d.issues.length):null;
   const lineB=key=>buckets(f[key],7);
   const issuePts=lineB("issues").map(b=>({label:b.label,tip:b.start===b.end?fmtD(b.end):fmtD(b.start)+" – "+fmtD(b.end),v:d.issues.filter(t=>{const c=issueCreatedDay(t),x=issueClosedDay(t);return c&&c<=b.end&&!(x&&x<=b.end)}).length}));
   const pmPts=lineB("pm").map(b=>({label:b.label,tip:b.start===b.end?fmtD(b.end):fmtD(b.start)+" – "+fmtD(b.end),v:d.tasks.filter(t=>{if(!t.due||t.due>=b.end)return false;const c=doneDay(t);if(c)return c>b.end;return t.status!=="Completed"}).length}));
   const areaName=f.area==="all"?"":f.area.indexOf("p:")===0?projectLabel(f.area.slice(2)):f.area.slice(2);
   const scope=[f.plant!=="all"?f.plant:areaName?areaName+" ("+d.plants.length+" plant"+(d.plants.length===1?"":"s")+")":"All plants ("+sp.length+")"].concat(f.eq!=="all"?[f.eq]:[],f.eng!=="all"?[f.eng]:[]).join(" · ");
   const capBadge=(label,field,unit,getKw)=>{const missing=d.plants.filter(p=>getKw(p)==null).length,kw=totalPlantCapacitykW(d.plants,field);
    return '<span class="pp-cap" title="'+h("Total "+label+" capacity of "+d.plants.length+" plant"+(d.plants.length===1?"":"s")+(missing?" · "+missing+" without "+label+" value":""))+'"><em>'+label+'</em><b>'+(missing===d.plants.length?"—":s91Mw(kw)+" "+unit)+'</b></span>'};
   const caps='<div class="pp-caps">'+capBadge("DC","capacitykW","MWp",plantDcKw)+capBadge("AC","acCapacitykW","MW",plantAcKw)+'</div>';
   const on=fitMode();
   return '<section class="pp'+(on?" pp-fit":"")+'" id="plant-pulse" aria-label="Plant operations pulse"'+(on&&S._ppH?' style="height:'+S._ppH+'px"':'')+'>'+
    '<div class="pp-top"><div class="pp-title"><div class="pp-eyeline"><span class="pp-eyebrow">OPERATIONS PULSE · '+h(scope.toUpperCase())+'</span>'+caps+'</div><h2>Site Issues, Preventive Maintenance &amp; Washing at a glance</h2></div>'+filtersHtml(sp||[])+'</div>'+
    '<div class="pp-row pp-row-1">'+
     gauge({title:"PM on schedule",value:pmPct,low:70,high:90,go:"pm",sub:d.tasks.length?d.pmOverdue.length+" overdue of "+d.tasks.length+" work orders":"No PM work orders",tip:"Preventive Maintenance work orders not past their due date · click to open"})+
     gauge({title:"Washing compliance",value:typeof d.washPct==="number"?d.washPct:null,low:Math.max(0,d.washDuePct-15),high:d.washDuePct,go:"wash",sub:d.washRows.length?d.cyclesDone+" / "+d.cyclesTarget+" cycles done this month · "+d.washDue+" due by today":d.wc?"Washing not set up":"Loading washing status…",tip:"Washing cycles completed this month out of the month's cycles"+(d.f.plant!=="all"?" for this plant":" for all plants in scope")+"; green when every cycle due by today is done"+(d.washAll?" (washing follows the plant filters only)":"")+" · click to open Washing"})+
     gauge({title:"Site issues resolved",value:issPct,low:50,high:80,go:"issues",sub:d.issues.length?d.open.length+" open · "+d.overdueIssues.length+" past ETC":"No site issues recorded",tip:"Share of Site Issues resolved or closed · click to open Site Issues"})+
     todayCard(d)+'</div>'+
    '<div class="pp-row pp-row-2">'+barsCard(d)+pieCard(d)+
     '<div class="pp-stack">'+
      lineCard({key:"issues",range:f.issues,title:"Open site issues",sub:"Backlog at the end of each period",nowLabel:"open now",color:"#1F5FA8",points:issuePts,go:"issues",upIsBad:true,avg:false})+
      lineCard({key:"pm",range:f.pm,title:"Overdue PM",sub:"Preventive Maintenance work orders past due at the end of each period",nowLabel:"overdue now",color:"#E0403A",points:pmPts,go:"pm",upIsBad:true,avg:true})+
     '</div>'+batteryCard(d)+'</div></section>';
  }catch(error){
   console.error("[Plant pulse]",error);
   return '<div class="bn-warn banner">The operations pulse could not be drawn: '+h(error.message)+'. The plants table is unaffected.</div>';
  }
 };

 window.s91PulseFilter=function(k,v){
  if(k==="plant"){setPlantScope(v||"all");return}
  st()[k]=v||"all";render();
 };
 window.s91PulseReset=function(){Object.assign(st(),{eq:"all",area:"all",eng:"all"});setPlantScope("all")};
 /* kept for older links that set one plant */
 window.s91PulsePlant=function(v){setPlantScope(v||"all")};
 window.s91PulseRange=function(key,v){st()[key]=v;render()};
 window.s91PulseSeries=function(k){const f=st();f.show[k]=!f.show[k];render()};
 /* every card opens its module with the same plant, equipment, district and engineer filters */
 window.s91PulseGo=function(key){
  const f=st(),plant=f.plant,d=scopeData(typeof dashScope==="function"?dashScope():(S.plants||[]));
  const iss=Object.assign(blankIssF(),{plant,q:"",from:"",to:"",vert:f.eq,assignee:f.eng},f.area.indexOf("d:")===0?{district:f.area.slice(2)}:{});
  if(key==="issues"){drillIssues(Object.assign(iss,{chip:"all"}));return}
  if(key==="issOpen"){drillIssues(Object.assign(iss,{chip:"Open"}));return}
  if(key==="issOver"){drillIssues(Object.assign(iss,{chip:"Overdue"}));return}
  if(key==="issToday"){drillIssues(Object.assign(iss,{chip:"all",from:TODAY,to:TODAY}));return}
  if(key==="pmToday"){
   S.pmLive=Object.assign(S.pmLive||{},{plant,day:TODAY,dayFrom:addDays(TODAY,-2),dayEquip:f.eq,plantOpen:false,view:"schedule",calMonth:TODAY.slice(0,7)});
   S._glanceScroll="pm-day-planner";goScheduledOM("maintenance");return;
  }
  if(key==="pm"||key==="pmOver"||key==="pmSoon"){
   const status=key==="pmSoon"?"Due soon":key==="pmOver"?"Overdue":"all";
   S.pmLive=Object.assign(S.pmLive||{},{plant,status,week:"all",age:"all",equipment:f.eq,person:f.eng,query:"",page:1,plantOpen:false,view:"register"});
   S._glanceScroll="pm-unit-register";goScheduledOM("maintenance");return;
  }
  if(key==="wash"||key==="washLate"){
   const ui=S._washUi=S._washUi||{q:"",bucket:"all",show:"all",assignee:"all",region:"all",sort:"late",page:1,pageSize:12,selected:[]};
   const wc=S._washCycles||{},rec=(S.plants||[]).find(p=>p.name===plant),row=plant==="all"?null:(wc.plants||[]).concat(wc.unconfigured||[]).find(p=>p.plant===plant);
   const plantId=plant==="all"?"all":String(row&&row.plant_id||rec&&(rec.dbId||rec.id)||"all");
   Object.assign(ui,{plant:plantId,region:f.area.indexOf("d:")===0?f.area.slice(2):"all",state:key==="washLate"?"late":"all",show:"all",bucket:"all",cyc:"all",q:"",page:1,view:"tiles"});
   S.washF=Object.assign({},ui);S._glanceScroll="wc-results";goScheduledOM("washing");return;
  }
 };
 /* bars and pie slices live inside SVG, so they are wired with one delegated listener */
 document.addEventListener("click",e=>{
  const t=e.target&&e.target.closest?e.target.closest("[data-pp-go],.pp-bar"):null;if(!t||!t.closest(".pp"))return;
  if(t.dataset.ppGo){s91PulseGo(t.dataset.ppGo);return}
  const f=st();drillIssues(Object.assign({plant:f.plant,chip:"all",q:"",from:t.dataset.ppFrom,to:t.dataset.ppTo,vert:f.eq,assignee:f.eng},f.area.indexOf("d:")===0?{district:f.area.slice(2)}:{}));
 });
})();
