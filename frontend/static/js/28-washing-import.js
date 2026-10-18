"use strict";
(function(){
 const h=value=>typeof esc==="function"?esc(value==null?"":String(value)):String(value==null?"":value);
 const state=()=>S._washImport||(S._washImport={file:null,preview:null,busy:false,error:""});
 const errorText=error=>{
  const detail=error&&error.data&&error.data.detail;
  return typeof detail==="string"?detail:(error&&error.message)||"The washing setup could not be imported.";
 };

 async function download(url,name){
  try{
   const response=await authenticatedFetch(url);
   if(!response.ok){let message="Download failed (HTTP "+response.status+").";try{const body=await response.json();if(typeof body.detail==="string")message=body.detail}catch(e){}throw new Error(message)}
   const objectUrl=URL.createObjectURL(await response.blob()),anchor=document.createElement("a");
   anchor.href=objectUrl;anchor.download=name;anchor.click();URL.revokeObjectURL(objectUrl);
  }catch(error){toast(errorText(error))}
 }
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
 window.washImportOpen=function(){
  const s=state();s.file=null;s.preview=null;s.error="";s.busy=false;
  S.modal="washingImport";S.modalCtx={};render();
 };
 window.washImportFileChanged=async function(input){
  const s=state(),file=input&&input.files&&input.files[0];
  if(!file)return;
  s.file=file;s.preview=null;s.error="";
  if(file.size>2*1024*1024){s.error="The file must be 2 MB or smaller.";render();return}
  const extension=(file.name.split(".").pop()||"").toLowerCase();
  if(extension!=="xlsx"&&extension!=="csv"){s.error="Choose an .xlsx or .csv file.";render();return}
  await window.washImportCheck();
 };
 window.washImportCheck=async function(){
  const s=state();if(!s.file||s.busy)return;
  s.busy=true;s.error="";s.preview=null;render();
  try{
   const body=new FormData();body.append("file",s.file,s.file.name);
   s.preview=await apiFetch("/api/scheduled/washing/import?dry_run=true",{method:"POST",body});
  }catch(error){s.error=errorText(error)}
  finally{s.busy=false;render()}
 };
 window.washImportSave=async function(){
  const s=state();if(!s.file||!s.preview||s.preview.problems.length||s.busy)return;
  s.busy=true;s.error="";render();
  try{
   const body=new FormData();body.append("file",s.file,s.file.name);
   const result=await apiFetch("/api/scheduled/washing/import?dry_run=false",{method:"POST",body});
   S._washCycles=null;S._washCycleError=null;
   await loadOverview();
   S.modal=null;S.modalCtx=null;render();
   toast(result.updated+" plants updated, "+result.created+" plants set up.");
  }catch(error){s.error=errorText(error);s.busy=false;render()}
 };

 function importModal(){
  const s=state(),p=s.preview,clean=p&&p.problems.length===0;
  const summary=p?'<div class="wc-import-counts">'+[
   ["created","Will create"],["updated","Will update"],["unchanged","No change"],["problems","Problems"]
  ].map(([key,label])=>'<div><span>'+label+'</span><b>'+Number(p[key]||0)+'</b></div>').join("")+'</div>':'';
  const rows=p&&p.rows&&p.rows.length?'<div class="wc-import-table-wrap"><table class="wc-table wc-import-table"><thead><tr><th>Row</th><th>Plant</th><th>Site code</th><th>Result</th></tr></thead><tbody>'+p.rows.slice(0,50).map(row=>{
   const tone=row.action==="Problem"?"crit":row.action==="New"?"info":row.action==="Changed"?"warn":"ok";
   return '<tr><td>'+row.row+'</td><td>'+h(row.plant)+'</td><td>'+h(row.site_code)+'</td><td><span class="wc-chip wc-'+tone+'">'+h(row.action)+'</span>'+(row.errors&&row.errors.length?'<div class="wc-import-errors">'+row.errors.map(h).join("<br>")+'</div>':'')+'</td></tr>';
  }).join("")+'</tbody></table></div>'+(p.rows.length>50?'<p class="sub">Showing the first 50 of '+p.rows.length+' rows.</p>':''):'';
  const body='<div class="wc-import">'+
   '<div class="wc-import-step"><b>1. Get a workbook</b><p>Download the template or export current washing setup to make updates. Blank cells leave saved values unchanged.</p><div class="row wrap"><button class="btn o sm" onclick="washImportDownloadTemplate()">Download template</button><button class="btn o sm" onclick="washImportExport()">Export current setup</button></div></div>'+
   '<div class="wc-import-step"><b>2. Choose a file</b><p>Upload an .xlsx or .csv file (up to 2 MB, with no more than 500 plant rows).</p><label class="wc-import-drop"><span>'+(s.file?h(s.file.name):"Choose file")+'</span><input type="file" accept=".xlsx,.csv" onchange="washImportFileChanged(this)"/></label></div>'+
   '<div class="wc-import-step"><b>3. Check and save</b><p>Check the preview. Any problem must be corrected in the file before saving.</p>'+
   (s.busy?'<div class="wc-empty">Checking washing setup…</div>':"")+ (s.error?'<div class="bn-warn banner">'+h(s.error)+'</div>':"")+summary+rows+
   (p&&clean?'<div class="bn-info banner">No problems found. You can save these changes.</div>':p?'<div class="bn-warn banner">Fix the listed rows, then choose the corrected file.</div>':"")+'</div></div>';
  const foot='<button class="btn o" onclick="closeModal()">Cancel</button><button class="btn p" '+(clean&&!s.busy?"":"disabled")+' onclick="washImportSave()">Save washing setup</button>';
  return modal("Upload washing setup","Set up or update plant washing from one spreadsheet.",body,foot,true);
 }
 const previousRenderModal=renderModal;
 renderModal=function(){
  if(S.modal==="washingImport")return importModal();
  return previousRenderModal.apply(this,arguments);
 };
})();
