"use strict";
/* Spreadsheet uploads: get a workbook (pre-filled where possible), choose the filled file, check the preview
   (a dry run that saves nothing), then save. Every kind is checked row by row on the server and saved all or nothing.
   Kinds registered here: washDaily (tables cleaned per plant per day) and washSetup (plant washing setup).
   Site Issues registers its own kind in 43-issue-upload.js. */
(function(){
 const h=value=>typeof esc==="function"?esc(value==null?"":String(value)):String(value==null?"":value);
 const KINDS=window.s91UploadKinds=window.s91UploadKinds||{};
 const state=()=>S._upload||(S._upload={kind:null,file:null,preview:null,busy:false,error:"",month:""});
 const errorText=(error,fallback)=>{
  const detail=error&&error.data&&error.data.detail;
  return typeof detail==="string"?detail:(detail&&detail.message)||(error&&error.message)||fallback||"The file could not be uploaded.";
 };
 const role=()=>S._roleLabel||S.currentRole||(typeof AUTH_IDENTITY!=="undefined"&&AUTH_IDENTITY.role)||"";
 const thisMonth=()=>String(typeof TODAY==="string"&&TODAY?TODAY:new Date().toISOString()).slice(0,7);

 async function download(url,name){
  try{
   const response=await authenticatedFetch(url);
   if(!response.ok){let message="Download failed (HTTP "+response.status+").";try{const body=await response.json();if(typeof body.detail==="string")message=body.detail}catch(e){}throw new Error(message)}
   const objectUrl=URL.createObjectURL(await response.blob()),anchor=document.createElement("a");
   anchor.href=objectUrl;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),1500);
  }catch(error){toast(errorText(error,"Download failed."))}
 }
 window.s91UploadDownload=download;

 window.s91UploadOpen=function(kind){
  const s=state();Object.assign(s,{kind,file:null,preview:null,busy:false,error:""});if(!s.month)s.month=thisMonth();
  S.modal="s91Upload";S.modalCtx={};render();
 };
 window.s91UploadSwitch=function(kind){const s=state();if(s.busy||s.kind===kind)return;Object.assign(s,{kind,file:null,preview:null,error:""});render()};
 window.s91UploadFileChanged=async function(input){
  const s=state(),k=KINDS[s.kind],file=input&&input.files&&input.files[0];
  if(!file||!k)return;
  s.file=file;s.preview=null;s.error="";
  if(file.size>2*1024*1024){s.error="The file must be 2 MB or smaller.";render();return}
  const extension=(file.name.split(".").pop()||"").toLowerCase();
  if(extension!=="xlsx"&&extension!=="csv"){s.error="Choose an .xlsx or .csv file.";render();return}
  await window.s91UploadCheck();
 };
 async function post(dry){
  const s=state(),body=new FormData();body.append("file",s.file,s.file.name);
  return apiFetch(KINDS[s.kind].importUrl+"?dry_run="+(dry?"true":"false"),{method:"POST",body});
 }
 window.s91UploadCheck=async function(){
  const s=state();if(!s.file||s.busy)return;
  s.busy=true;s.error="";s.preview=null;render();
  try{s.preview=await post(true)}
  catch(error){s.error=errorText(error)}
  finally{s.busy=false;render()}
 };
 window.s91UploadSave=async function(){
  const s=state(),k=KINDS[s.kind];if(!k||!s.file||!s.preview||s.preview.problems.length||!k.canSave(s.preview)||s.busy)return;
  s.busy=true;s.error="";render();
  let result;
  try{result=await post(false)}
  catch(error){s.error=errorText(error);s.busy=false;render();return}
  if(result.problems&&result.problems.length){  // the data changed after the check: show what is wrong now, nothing was saved
   s.preview=result;s.busy=false;s.error="Nothing was saved: the portal changed since the check. Fix the rows below and try again.";render();return;
  }
  S.modal=null;S.modalCtx=null;s.busy=false;render();
  toast(k.savedText(result));
  try{await k.afterSave(result)}catch(e){console.warn("[upload] refresh after save",e)}
 };

 function resultTable(k,p){
  const rows=(p.rows||[]).slice().sort((a,b)=>(a.action==="Problem"?0:1)-(b.action==="Problem"?0:1)||a.row-b.row);
  if(!rows.length)return "";
  const tone=a=>a==="Problem"?"crit":a==="New"?"info":a==="Changed"?"warn":"ok";
  const shown=rows.slice(0,80);
  return '<div class="wc-import-table-wrap"><table class="wc-table wc-import-table"><thead><tr><th>Row</th>'+k.columns.map(c=>'<th>'+c[0]+'</th>').join("")+'<th>Result</th></tr></thead><tbody>'+shown.map(row=>
   '<tr><td>'+row.row+'</td>'+k.columns.map(c=>'<td>'+c[1](row)+'</td>').join("")+'<td><span class="wc-chip wc-'+tone(row.action)+'">'+h(k.actionLabel?k.actionLabel(row.action):row.action)+'</span>'+
   (row.detail?'<div class="sub">'+h(row.detail)+'</div>':'')+(row.errors&&row.errors.length?'<div class="wc-import-errors">'+row.errors.map(h).join("<br>")+'</div>':'')+'</td></tr>').join("")+
   '</tbody></table></div>'+(rows.length>shown.length?'<p class="sub">Showing the first '+shown.length+' of '+rows.length+' rows (problems first).</p>':'');
 }

 function uploadModal(){
  const s=state(),k=KINDS[s.kind];
  if(!k)return modal("Upload","This upload is not available.","",'<button class="btn o" onclick="closeModal()">Close</button>');
  const p=s.preview,clean=p&&p.problems.length===0,ready=clean&&k.canSave(p);
  const tabs=(k.tabs||[]).filter(t=>KINDS[t]&&KINDS[t].allowed());
  const tabBar=tabs.length>1?'<div class="row wrap" role="tablist" style="gap:6px;margin-bottom:12px">'+tabs.map(t=>'<button type="button" role="tab" aria-selected="'+(t===s.kind)+'" class="btn sm '+(t===s.kind?'p':'o')+'" onclick="s91UploadSwitch(\''+t+'\')">'+h(KINDS[t].tabLabel)+'</button>').join("")+'</div>':'';
  const summary=p?'<div class="wc-import-counts">'+k.counts.map(([key,label])=>{const v=key==="problems"?p.problems.length:Number(p[key]||0);return '<div><span>'+label+'</span><b>'+v+'</b></div>'}).join("")+'</div>':'';
  const verdict=p?(clean?(ready?'<div class="bn-info banner">'+h(k.readyText(p))+'</div>':'<div class="bn-info banner">Nothing new to save in this file.</div>'):'<div class="bn-warn banner">Fix the listed rows in the file, then choose it again. Nothing has been saved.</div>'):"";
  const body='<div class="wc-import">'+tabBar+
   '<div class="wc-import-step"><b>1. Get a workbook</b>'+k.step1()+'</div>'+
   '<div class="wc-import-step"><b>2. Choose the filled file</b><p>'+h(k.limitText)+'</p><label class="wc-import-drop"><span>'+(s.file?h(s.file.name):"Choose file")+'</span><input type="file" accept=".xlsx,.csv" onchange="s91UploadFileChanged(this)"'+(s.busy?" disabled":"")+'/></label></div>'+
   '<div class="wc-import-step"><b>3. Check and save</b><p>Every row is checked first. Nothing is saved until the whole file is correct.</p>'+
   (s.busy?'<div class="wc-empty">'+(p?"Saving…":"Checking the file…")+'</div>':"")+(s.error?'<div class="bn-warn banner">'+h(s.error)+'</div>':"")+summary+verdict+(p?resultTable(k,p):"")+'</div></div>';
  const foot='<button class="btn o" onclick="closeModal()"'+(s.busy?" disabled":"")+'>Cancel</button><button class="btn p" '+(ready&&!s.busy?"":"disabled")+' onclick="s91UploadSave()">'+h(k.saveLabel)+'</button>';
  return modal(k.title,k.subtitle,body,foot,true);
 }
 const previousRenderModal=renderModal;
 renderModal=function(){
  if(S.modal==="s91Upload")return uploadModal();
  return previousRenderModal.apply(this,arguments);
 };

 /* ───────── washing ───────── */
 const washTeam=()=>role()==="O&M Head"||role()==="Assignee";
 const washReporter=()=>washTeam()||role()==="Site Engineer";
 async function refreshWashing(){
  S._washCycles=null;S._washCycleError=null;
  if(typeof window.washCyclesReload==="function")await window.washCyclesReload();
  else if(typeof window.washCyclesEnsureLoaded==="function")window.washCyclesEnsureLoaded();
 }
 const dateText=iso=>{if(!iso)return "—";const d=new Date(iso+"T00:00:00");return isNaN(d)?iso:d.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})};
 window.s91UploadMonth=function(value){const s=state();s.month=/^\d{4}-\d{2}$/.test(value||"")?value:thisMonth()};
 window.washDailyDownload=function(){
  const s=state(),month=s.month||thisMonth();
  if(month>thisMonth()){toast("Choose the current month or an earlier one.");return}
  download("/api/scheduled/washing/daily-template?month="+encodeURIComponent(month),"Daily_Washing_"+month+".xlsx");
 };
 KINDS.washDaily={
  tabLabel:"Daily washing",tabs:["washDaily","washSetup"],allowed:washReporter,
  title:"Upload washing",subtitle:"Record the tables cleaned for many plants and days from one spreadsheet.",
  step1:()=>{const s=state();return '<p>Download a month\'s sheet. It already lists every plant and every day up to today: type the <b>tables cleaned</b> (<b>0</b> if no washing was done, with what happened in <b>Remarks</b>), and leave days with nothing to report empty. Days already saved show their values.</p>'+
   '<div class="row wrap" style="gap:8px;align-items:flex-end"><label class="field" style="margin:0"><span class="lbl">Month</span><input class="inp" type="month" value="'+h(s.month||thisMonth())+'" max="'+thisMonth()+'" onchange="s91UploadMonth(this.value)"/></label><button class="btn o sm" onclick="washDailyDownload()">Download month sheet</button></div>'+
   '<p class="sub" style="margin-top:8px">Your own file also works: one row per plant per day with the columns <b>Site code</b>, <b>Date</b> (DD-MM-YYYY), <b>Tables cleaned</b> (0 if no washing) and <b>Remarks</b> (what happened that day).</p>'},
  limitText:"An .xlsx or .csv file, up to 2 MB and 3,000 day rows.",
  importUrl:"/api/scheduled/washing/daily-import",
  counts:[["new","Will save"],["unchanged","Already saved"],["blank","Left empty"],["problems","Problems"]],
  columns:[["Site code",r=>h(r.site_code)],["Date",r=>h(dateText(r.date))]],
  actionLabel:a=>a==="New"?"Will save":a==="Unchanged"?"Already saved":a,
  canSave:p=>Number(p.new||0)>0,
  readyText:p=>p.new+" day"+(p.new===1?"":"s")+" for "+p.plants+" plant"+(p.plants===1?"":"s")+" ("+p.tables+" tables"+(p.extra?"; "+p.extra+" day"+(p.extra===1?"":"s")+" as extra washing after all 3 cycles were complete":"")+") "+(p.review_status==="Confirmed"?"will be saved as confirmed.":"will be sent to the O&M team for review."),
  saveLabel:"Save washing days",
  savedText:r=>r.saved+" washing day"+(r.saved===1?"":"s")+" saved"+(r.review_status==="Confirmed"?".":" and sent for review."),
  afterSave:refreshWashing
 };
 KINDS.washSetup={
  tabLabel:"Plant setup",tabs:["washDaily","washSetup"],allowed:washTeam,
  title:"Upload washing",subtitle:"Set up or update plant washing from one spreadsheet.",
  step1:()=>'<p>Download the template or export the current washing setup to make updates. Blank cells leave saved values unchanged.</p><div class="row wrap"><button class="btn o sm" onclick="washImportDownloadTemplate()">Download template</button><button class="btn o sm" onclick="washImportExport()">Export current setup</button></div>',
  limitText:"An .xlsx or .csv file, up to 2 MB and 500 plant rows.",
  importUrl:"/api/scheduled/washing/import",
  counts:[["created","Will create"],["updated","Will update"],["unchanged","No change"],["problems","Problems"]],
  columns:[["Plant",r=>h(r.plant)],["Site code",r=>h(r.site_code)]],
  canSave:()=>true,
  readyText:()=>"No problems found. You can save these changes.",
  saveLabel:"Save washing setup",
  savedText:r=>r.updated+" plants updated, "+r.created+" plants set up.",
  afterSave:refreshWashing
 };

 window.washImportDownloadTemplate=function(){download("/api/scheduled/washing/template","Washing_Setup_Template.xlsx")};
 window.washImportExport=function(ids){
  const query=ids&&ids.length?"?plant_ids="+encodeURIComponent(ids.join(",")):"";
  download("/api/scheduled/washing/export"+query,ids&&ids.length?"Washing_Setup_Selected.xlsx":"Washing_Setup.xlsx");
 };
 window.washImportExportSelected=function(){
  const ui=S._washUi||{},ids=Array.from(ui.selected||[]);
  if(!ids.length){toast("Select at least one plant to export.");return}
  window.washImportExport(ids);
 };
 /* "Upload Excel" on the washing page opens daily washing first (the everyday use); the O&M team can switch to plant setup. */
 window.washImportOpen=function(kind){window.s91UploadOpen(kind||"washDaily")};
})();
