"use strict";
/* O&M Photo Intelligence pure filters, validation, tagging, and legacy demo test fixtures.
   The production service is replaced by the authenticated API adapter in 49-photo-live-adapter.js.
   No demo photos are shown in the live portal. 30d is a default display window, not a deletion policy. */
(function(root){
 const DAY=864e5,RETENTION_DAYS=30,PAGE_SIZE=60;
 /* demo volume: about 4.5 photos per plant per day (≈ 150–200 a day across 40–50 plants), at most 220 a day,
    over 35 days (the last 5 fall outside retention) */
 const DEMO_DAYS=35,DEMO_PER_PLANT_DAY=4.5,DEMO_MAX_DAY=220;
 /* one list for categories: labels follow Solar91 module names */
 const CATEGORIES=[
  {id:"washing",label:"Washing"},
  {id:"pm",label:"Preventive Maintenance"},
  {id:"equipment",label:"Equipment"},
  {id:"issue",label:"Site Issue"},
  {id:"safety",label:"Safety"},
  {id:"inventory",label:"Inventory"},
  {id:"other",label:"Other"}
 ];
 const STATUSES=[{id:"queued",label:"Awaiting processing"},{id:"processed",label:"Processed"},{id:"failed",label:"Processing failed"}];
 const WINDOWS=[{id:"24h",label:"Last 24 hours",ms:DAY},{id:"7d",label:"Last 7 days",ms:7*DAY},{id:"30d",label:"Last 30 days",ms:RETENTION_DAYS*DAY},{id:"all",label:"All time",ms:Infinity}];
 const DEFAULT_QUERY={q:"",plant:"all",window:"30d",category:"all",uploader:"all",issue:"all",link:"all",status:"all",sort:"newest"};
 const ACCEPT_TYPES=["image/jpeg","image/png","image/webp"],ACCEPT_EXT=/\.(jpe?g|png|webp)$/i;
 const MAX_BYTES=15*1024*1024,MAX_FILES=10,MAX_DESCRIPTION=300;

 const catLabel=id=>(CATEGORIES.find(c=>c.id===id)||{label:id}).label;
 const statusLabel=id=>(STATUSES.find(s=>s.id===id)||{label:id}).label;
 const sameDay=(a,b)=>{const x=new Date(a),y=new Date(b);return x.getFullYear()===y.getFullYear()&&x.getMonth()===y.getMonth()&&x.getDate()===y.getDate()};
 function normalizeQuery(q){
  const out=Object.assign({},DEFAULT_QUERY,q||{});
  if(!WINDOWS.some(w=>w.id===out.window))out.window="30d";
  if(out.sort!=="oldest")out.sort="newest";
  return out;
 }

 /* ---------- pure logic (unit-tested in tests/test_photo_intelligence.py) ---------- */
 /* The live gallery supports all history. Demo fixtures use the selected date window. */
 function filterPhotos(records,query,now){
  const q=normalizeQuery(query),win=WINDOWS.find(w=>w.id===q.window),from=now-Math.min(win.ms,q.window==="all"?Infinity:RETENTION_DAYS*DAY);
  const words=String(q.q||"").toLowerCase().split(/\s+/).filter(Boolean);
  const rows=(records||[]).filter(r=>{
   const t=Date.parse(r.uploadedAt);
   if(!(t>=from&&t<=now))return false;
   if(q.plant!=="all"&&r.plant!==q.plant)return false;
   if(q.category!=="all"&&r.category!==q.category)return false;
   if(q.uploader!=="all"&&r.uploader!==q.uploader)return false;
   if(q.status!=="all"&&r.status!==q.status)return false;
   if(q.link!=="all"&&(r.linkType||null)!==q.link)return false;
   if(q.issue==="linked"&&!r.issue)return false;
   if(q.issue==="unlinked"&&r.issue)return false;
   if(q.issue!=="all"&&q.issue!=="linked"&&q.issue!=="unlinked"&&(!r.issue||r.issue.id!==q.issue))return false;
   if(words.length){const hay=[r.description,(r.tags||[]).join(" "),r.equipmentId].join(" ").toLowerCase();if(!words.every(w=>hay.includes(w)))return false}
   return true;
  });
  return rows.sort((a,b)=>q.sort==="oldest"?Date.parse(a.uploadedAt)-Date.parse(b.uploadedAt):Date.parse(b.uploadedAt)-Date.parse(a.uploadedAt));
 }
 function summarize(rows,now){
  return{inWindow:rows.length,today:rows.filter(r=>sameDay(r.uploadedAt,now)).length,awaiting:rows.filter(r=>r.status==="queued").length,unlinked:rows.filter(r=>!r.issue).length};
 }
 /* local calendar day "YYYY-MM-DD" of an ISO time; the gallery groups by it */
 const dayKey=iso=>{const d=new Date(iso);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")};
 function countByDay(rows){const out={};rows.forEach(r=>{const k=dayKey(r.uploadedAt);out[k]=(out[k]||0)+1});return out}
 /* files: anything with name / type / size (File objects in the browser) */
 function validateFiles(files,alreadySelected){
  const accepted=[],rejected=[];let room=MAX_FILES-(alreadySelected||0);
  Array.from(files||[]).forEach(f=>{
   const typeOk=ACCEPT_TYPES.includes(String(f.type||"").toLowerCase())||(!f.type&&ACCEPT_EXT.test(f.name||""));
   if(!typeOk)rejected.push({name:f.name,reason:"Please use a JPEG, PNG or WebP photo (convert HEIC to JPEG first)"});
   else if(!(f.size>0))rejected.push({name:f.name,reason:"The file is empty"});
   else if(f.size>MAX_BYTES)rejected.push({name:f.name,reason:"Larger than 15 MB"});
   else if(room<=0)rejected.push({name:f.name,reason:"Up to "+MAX_FILES+" photos per submission"});
   else{accepted.push(f);room--}
  });
  return{accepted,rejected};
 }

 /* photo checks on the phone, before submitting: brightness = mean grey level (0–255) and sharpness = variance of
    a Laplacian (edge strength) over a small grey copy of the photo, at most 400 px on its long side. A low sharpness
    can also mean a plain surface with no detail, so the warning says "may be blurry", never "is blurry". */
 const QUALITY={maxSide:400,darkBelow:55,blurBelow:45};
 function measureGray(gray,w,h){
  const n=w*h;if(!n)return{brightness:0,sharpness:0};
  let sum=0;for(let i=0;i<n;i++)sum+=gray[i];
  let m=0,m2=0,k=0;
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i=y*w+x,v=4*gray[i]-gray[i-1]-gray[i+1]-gray[i-w]-gray[i+w];k++;const d=v-m;m+=d/k;m2+=d*(v-m)}
  return{brightness:Math.round(sum/n),sharpness:k>1?Math.round(m2/(k-1)):0};
 }
 /* a dark photo is reported as dark only: darkness also hides edges */
 const qualityFlags=q=>{const dark=q.brightness<QUALITY.darkBelow;return{dark,blurry:!dark&&q.sharpness<QUALITY.blurBelow}};

 /* quick tags offered when adding photos; free tags are allowed too */
 const QUICK_TAGS=["remark","before","after","urgent","follow-up"],MAX_TAGS=8;
 function cleanTags(list){
  const out=[];
  (Array.isArray(list)?list:String(list||"").split(",")).forEach(t=>{const v=String(t||"").trim().toLowerCase().replace(/^#/,"").replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,"").slice(0,24);if(v&&!out.includes(v)&&out.length<MAX_TAGS)out.push(v)});
  return out;
 }

 /* Fast, transparent suggestions from category and engineer remark; never claims image recognition. */
 function suggestTags(input){
  const category=String(input&&input.category||"").toLowerCase(),remark=String(input&&input.description||"").toLowerCase();
  const out=[category],rules={urgent:/urgent|critical|tripped|breakdown/,before:/\bbefore\b/,after:/\bafter\b/,'follow-up':/follow.?up|pending/,inverter:/inverter|\binv[- ]?\d+/,dust:/dust|soiling/,cleaning:/wash|clean/,safety:/ppe|hazard|safety/,inspection:/check|inspection/};
  Object.entries(rules).forEach(([tag,re])=>{if(re.test(remark))out.push(tag)});
  return cleanTags(out);
 }
 /* ---------- demo sample records (deterministic, generated in the browser) ---------- */
 function rng(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}}
 const pick=(r,list)=>list[Math.floor(r()*list.length)];
 const UPLOADERS=["Demo Engineer 01","Demo Engineer 02","Demo Engineer 03","Demo Engineer 04","Demo Engineer 05","Demo Engineer 06","Demo Engineer 07","Demo Engineer 08"];
 const SAMPLES={
  washing:{eq:["Block A","Block B","Block C","Row 12","Row 27"],text:["Module rows after washing","Dust build-up before washing","Washing in progress, water tanker on site","Bird droppings on module surface"],tags:["washing","modules","dust","cleaning"]},
  pm:{eq:["INV-01","INV-03","SCB-07","ACDB-02","TRF-01"],text:["Inverter filter cleaned during PM","Torque check on busbar joints","Thermal scan of combiner box","Earthing pit resistance check"],tags:["pm","inspection","torque","thermal"]},
  equipment:{eq:["INV-02","INV-05","SCB-12","WMS-01","TRF-01"],text:["Inverter display showing fault code","Damaged MC4 connector","Cable tray cover missing","Weather station sensor misaligned"],tags:["equipment","fault","inverter","cable"]},
  issue:{eq:["SCB-04","INV-04","VCB-01","Fence line"],text:["String fuse blown in combiner box","Water ingress in junction box","Tripped breaker reported by site","Broken module glass found on inspection"],tags:["issue","fault","breakdown"]},
  safety:{eq:["Main gate","Control room","Switchyard"],text:["PPE check before switchyard work","Fire extinguisher inspection tag","Danger signage on transformer fence","Permit to work displayed at site"],tags:["safety","ppe","signage"]},
  handover:{eq:["Control room","Store room","Main gate"],text:["Spares received at handover","As-built drawing set on site","SCADA panel at handover walkdown"],tags:["handover","documents","spares"]},
  other:{eq:[""],text:["General site view","Access road condition after rain","Vegetation growth along fence"],tags:["site","general"]}
 };
 const WEIGHTED=["washing","washing","washing","pm","pm","equipment","equipment","issue","issue","safety","handover","other"];
 const ISSUE_STATUSES=["Open","In Progress","Resolved"];
 function makeMockPhotos(plantNames,now,count){
  const r=rng(91),names=plantNames.length?plantNames:["Plant 01"],out=[];count=count||DEMO_DAYS*Math.min(DEMO_MAX_DAY,Math.max(4,Math.round(names.length*DEMO_PER_PLANT_DAY)));
  for(let i=0;i<count;i++){
   const category=pick(r,WEIGHTED),s=SAMPLES[category];
   const age=Math.floor(r()*DEMO_DAYS*DAY/6e4)*6e4,uploadedAt=new Date(now-age).toISOString();
   const linkChance=category==="issue"?.85:category==="equipment"?.35:category==="safety"?.1:.04;
   const issueNo=1000+Math.floor(r()*60);
   const status=age<6*36e5?(r()<.75?"queued":"processed"):age<2*DAY?(r()<.3?"queued":"processed"):(r()<.04?"failed":"processed");
   out.push({
    id:"DEMO-PH-"+String(i+1).padStart(4,"0"),demo:true,source:"sample",
    plant:pick(r,names),category,uploader:pick(r,UPLOADERS),uploadedAt,
    expiresAt:new Date(now-age+RETENTION_DAYS*DAY).toISOString(),
    description:pick(r,s.text),tags:[pick(r,s.tags),pick(r,s.tags)].filter((t,j,a)=>a.indexOf(t)===j),
    equipmentId:pick(r,s.eq),status,
    issue:r()<linkChance?{id:"DEMO-ISS-"+issueNo,status:ISSUE_STATUSES[issueNo%3]}:null,
    variant:i%4
   });
  }
  return out;
 }
 const demoPlants=()=>Array.from({length:50},(_,i)=>({id:"demo-"+(i+1),name:"Plant "+String(i+1).padStart(2,"0")+" (demo)",demo:true}));

 /* ---------- demo adapter ---------- */
 /* ctx: getPlants() → plant names from the portal's loaded catalogue; now() → ms; delay(ms) → Promise */
 function createDemoAdapter(ctx){
  let mock=[],mockKey=null,session=[],seq=0;
  const plants=()=>{const names=(ctx.getPlants()||[]).filter(Boolean);return names.length?names.map(n=>({id:n,name:n,demo:false})):demoPlants()};
  function records(){
   const p=plants(),key=p.map(x=>x.name).join("|");
   if(key!==mockKey){mock=makeMockPhotos(p.map(x=>x.name),ctx.now());mockKey=key}
   return session.concat(mock);
  }
  const inScope=(rows,viewer)=>viewer&&Array.isArray(viewer.plants)?rows.filter(x=>viewer.plants.includes(x.plant)):rows;
  return{
   mode:"demo",
   getCategories:()=>Promise.resolve(CATEGORIES.map(c=>Object.assign({},c))),
   getPlants:viewer=>Promise.resolve(viewer&&Array.isArray(viewer.plants)?plants().filter(p=>viewer.plants.includes(p.name)):plants()),
   /* query: filters + offset/limit; viewer: {plants:[names]} narrows the demo to a plant-scoped role (the real API decides this server-side) */
   listPhotos(query,viewer){
    const now=ctx.now(),q=normalizeQuery(query),scoped=inScope(records(),viewer);
    const rows=filterPhotos(scoped,q,now),offset=Math.max(0,q.offset|0),limit=Math.max(1,q.limit|0||PAGE_SIZE);
    const retained=scoped.filter(x=>Date.parse(x.uploadedAt)>=now-RETENTION_DAYS*DAY);
    const issues=[...new Map(retained.filter(x=>x.issue).map(x=>[x.issue.id,x.issue])).values()].sort((a,b)=>a.id.localeCompare(b.id));
    return Promise.resolve({items:rows.slice(offset,offset+limit),total:rows.length,summary:summarize(rows,now),days:countByDay(rows),
     facets:{uploaders:[...new Set(retained.map(x=>x.uploader))].sort(),issues},sessionCount:session.length,generatedAt:now});
   },
   getPhotoDetails:id=>Promise.resolve(records().find(x=>x.id===id)||null),
   /* the image file, for attaching a photo to a ticket or a PM work order. Demo: only photos added in this tab
      have a real file; the storage adapter will fetch the stored image instead. */
   getPhotoFile:id=>{const x=records().find(y=>y.id===id);return Promise.resolve(x&&x.file?x.file:null)},
   getProcessingStatus:id=>{const x=records().find(y=>y.id===id);return Promise.resolve(x?{id,status:x.status,label:statusLabel(x.status)}:null)},
   /* sub: {files:[{name,size,type,previewUrl}], plant, category, description, uploader}; onProgress(0–100) is simulated */
   async createSubmission(sub,onProgress){
    if(!sub||!sub.plant)throw new Error("Choose the plant.");
    if(!CATEGORIES.some(c=>c.id===sub.category))throw new Error("Choose a category.");
    if(!sub.files||!sub.files.length)throw new Error("Add at least one photo.");
    const desc=String(sub.description||"").trim().slice(0,MAX_DESCRIPTION),tags=cleanTags(sub.tags);
    const issue=sub.issue&&sub.issue.id?{id:String(sub.issue.id),status:String(sub.issue.status||"Open")}:null;
    for(let p=10;p<=100;p+=15){if(onProgress)onProgress(Math.min(p,100));await ctx.delay(110)}
    if(onProgress)onProgress(100);
    const now=ctx.now(),made=sub.files.map(f=>({
     id:"SESSION-"+(++seq),demo:true,source:"session",plant:sub.plant,category:sub.category,uploader:sub.uploader||"You",
     uploadedAt:new Date(now).toISOString(),expiresAt:new Date(now+RETENTION_DAYS*DAY).toISOString(),
     description:desc,tags:tags.slice(),equipmentId:"",status:"queued",issue,previewUrl:f.previewUrl||null,fileName:f.name,fileSize:f.size,file:f.file||null,
     quality:f.quality&&f.quality.checked?{dark:!!f.quality.dark,blurry:!!f.quality.blurry}:null
    }));
    session=made.concat(session);
    return{records:made,persisted:false};
   },
   /* hands back the preview URLs so the page can revoke them */
   clearSession(){const urls=session.map(x=>x.previewUrl).filter(Boolean);session=[];return urls},
   sessionUrls:()=>session.map(x=>x.previewUrl).filter(Boolean)
  };
 }

 root.S91PhotoLogic={CATEGORIES,STATUSES,WINDOWS,DEFAULT_QUERY,RETENTION_DAYS,PAGE_SIZE,MAX_FILES,MAX_BYTES,MAX_DESCRIPTION,QUICK_TAGS,MAX_TAGS,QUALITY,
  catLabel,statusLabel,normalizeQuery,filterPhotos,summarize,dayKey,countByDay,validateFiles,cleanTags,suggestTags,measureGray,qualityFlags,makeMockPhotos,createDemoAdapter};
 root.S91PhotoService=createDemoAdapter({
  getPlants:()=>typeof S!=="undefined"&&S&&Array.isArray(S.plants)?S.plants.map(p=>p&&p.name):[],
  now:()=>Date.now(),
  delay:ms=>new Promise(res=>setTimeout(res,ms))
 });
})(typeof window!=="undefined"?window:globalThis);
