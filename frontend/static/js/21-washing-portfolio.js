"use strict";
/* Lightweight hash routing. Existing navigation functions remain intact; this
   only mirrors their state into the URL so refresh, sharing and Back work. */
/* moving to a different module/tab starts at the top (render() otherwise keeps the old scroll position) */
let _navKey="";
function s91NavTop(){
 const k=S.view+"|"+(S.view==="om-module"?S.omTab:"")+"|"+(S.view==="plant"?S.plantId:"");
 if(k!==_navKey){const first=!_navKey;_navKey=k;if(!first){try{window.scrollTo(0,0);const c=document.querySelector(".content");if(c)c.scrollTop=0}catch(e){}}}
}
let _s91RouteApplying=false;
function s91RouteParts(){const raw=String(location.hash||"").replace(/^#\/?/,"");const i=raw.indexOf("?");return{path:(i<0?raw:raw.slice(0,i)),params:new URLSearchParams(i<0?"":raw.slice(i+1))}}
function s91RouteHash(){
 if(S.view==="equipment")return "/equipment";
 if(S.view==="plant"&&S.plantId)return "/plant/"+encodeURIComponent(S.plantId);
 if(S.view==="dashboard"||["plants","work","performance","reports","data","settings"].includes(S.view))return "/"+S.view;
 if(S.view==="om-module")return S.omTab==="scheduled"?"/preventive":S.omTab==="washing"?"/washing":"/"+(S.omTab||"issues");
 return "/dashboard";
}
function s91EquipmentRoute(){
 const q=new URLSearchParams();
 [["q",M26R.q],["plant",M26R.plant],["type",M26R.type],["status",M26R.status],["maker",M26R.maker],["discom",M26R.discom],["incharge",M26R.inCharge],["warranty",M26R.warranty]].forEach(x=>{if(x[1])q.set(x[0],x[1])});
 if(M26R.noInCharge)q.set("no_incharge","1");if(M26R.makerMissing)q.set("maker_missing","1");if(M26R.serialMissing)q.set("serial_missing","1");if(M26R.page>1)q.set("page",String(M26R.page));if(M26R.pageSize!==50)q.set("size",String(M26R.pageSize));
 return "/equipment"+(q.toString()?"?"+q.toString():"");
}
function s91SetRoute(route,replace){if(_s91RouteApplying)return;const h="#"+route;if(location.hash===h)return;history[replace?"replaceState":"pushState"](null,"",h)}
function s91SyncRoute(replace){if(typeof S==="undefined")return;s91SetRoute(S.view==="equipment"&&typeof M26R!=="undefined"?s91EquipmentRoute():s91RouteHash(),!!replace)}
function s91ApplyRoute(initial){
 const r=s91RouteParts();if(!r.path)return false;const seg=r.path.split("/").filter(Boolean),p=seg[0]||"dashboard",role=(S._roleLabel||S.currentRole||"O&M Head");
 _s91RouteApplying=true;
 try{
  if(p==="plant"&&seg[1]){S.view="plant";S.plantId=decodeURIComponent(seg.slice(1).join("/"));S.modal=null}
  else if(p==="equipment"&&typeof M26R!=="undefined"){
   S.view="equipment";S.omTab="equipment";S.modal=null;
   Object.assign(M26R,{q:r.params.get("q")||"",plant:r.params.get("plant")||"",type:r.params.get("type")||"",status:r.params.get("status")||"",maker:r.params.get("maker")||"",discom:r.params.get("discom")||"",inCharge:r.params.get("incharge")||"",warranty:r.params.get("warranty")||"",noInCharge:r.params.get("no_incharge")==="1",makerMissing:r.params.get("maker_missing")==="1",serialMissing:r.params.get("serial_missing")==="1",page:Math.max(1,parseInt(r.params.get("page")||"1",10)||1),pageSize:[25,50,100].includes(parseInt(r.params.get("size")||"50",10))?parseInt(r.params.get("size")||"50",10):50});
  }else if(["issues","handover","services","analytics","washing","preventive"].includes(p)){
   if(role==="Site Engineer"&&["handover","services","analytics"].includes(p)){S.view="dashboard"}else{S.view="om-module";S.omTab=p==="preventive"?"scheduled":p}
  }else if(["dashboard","plants","work","performance","reports","data","settings"].includes(p)){
   if(role==="Site Engineer"&&["plants","work","performance","reports","data","settings"].includes(p))S.view="dashboard";else S.view=p;
  }
  if(!initial){persist();render();if(S.view==="equipment"&&typeof m26EqLoadPage==="function")m26EqLoadPage(false)}
  return true;
 }finally{_s91RouteApplying=false}
}
window.addEventListener("popstate",function(){s91ApplyRoute(false)});
if(typeof goView==="function"){const _s91GoView=goView;goView=function(){const r=_s91GoView.apply(this,arguments);s91NavTop();s91SyncRoute(false);return r}}
if(typeof goTab==="function"){const _s91GoTab=goTab;goTab=function(){const r=_s91GoTab.apply(this,arguments);s91NavTop();s91SyncRoute(false);return r}}
if(typeof goScheduledOM==="function"){const _s91GoScheduled=goScheduledOM;goScheduledOM=function(){const r=_s91GoScheduled.apply(this,arguments);s91NavTop();s91SyncRoute(false);return r}}
if(typeof openPlantPage==="function"){const _s91Plant=openPlantPage;openPlantPage=function(){const r=_s91Plant.apply(this,arguments);s91SyncRoute(false);return r}}
if(typeof m26GoEq==="function"){const _s91Equipment=m26GoEq;m26GoEq=function(){const r=_s91Equipment.apply(this,arguments);s91SyncRoute(false);return r}}
if(typeof m26EqPersist==="function"){const _s91EqPersist=m26EqPersist;m26EqPersist=function(){const r=_s91EqPersist.apply(this,arguments);if(S.view==="equipment")s91SetRoute(s91EquipmentRoute(),true);return r}}
