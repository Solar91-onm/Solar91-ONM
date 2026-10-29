"use strict";
/* Server-backed Photo Intelligence. The demo adapter remains isolated for legacy logic tests,
   but the portal uses this authenticated adapter; never display fake operations data. */
(function(){
 const L=window.S91PhotoLogic;
 if(!L)return;
 /* ~640px WebP thumbnails are 20–40 KB: keep a few pages of them so scrolling back or re-rendering the gallery
    does not download the same tiles again (the server sends them with no-store). */
 const thumbCache=new Map(),maxThumbs=240;
 async function fetchFile(id,size){
  const r=await authenticatedFetch('/api/photos/'+encodeURIComponent(id)+'/image?size='+encodeURIComponent(size||'thumb'),{cache:'no-store'});
  if(!r.ok)throw new Error('Photo could not be opened ('+r.status+').');
  return r.blob();
 }
 let catalog=[];
 const adapter={
  mode:'live',
  getCategories:()=>Promise.resolve(L.CATEGORIES),
  async getPlants(){catalog=await apiFetch('/api/photos/plants');return catalog},
  async getLinks(plant,kind,q){const p=catalog.find(x=>x.name===plant||x.id===plant);if(!p||!kind)return [];
   return apiFetch('/api/photos/links?'+new URLSearchParams({plant_id:p.id,kind,q:q||''}));},
  async listPhotos(query){
   const q=L.normalizeQuery(query),wanted=Math.max(1,Math.min(2000,Number(q.limit)||L.PAGE_SIZE)),start=Math.max(0,Number(q.offset)||0);
   const withMeta=!query||query.meta!==false;
   const pages=[];let meta=null,last=null,cursor=query&&query.cursor||null;
   // Backend caps each response at 120 records. Totals, facets and day counts come with the first request only
   // (meta:false asks for rows alone, e.g. the next gallery page); full-resolution images load only when opened.
   while(pages.length<wanted){
    const p=new URLSearchParams(),size=Math.min(120,wanted-pages.length);
    ['q','plant','category','uploader','issue','link','window','sort'].forEach(k=>{if(q[k]!=null)p.set(k,String(q[k]))});
    if(cursor)p.set('cursor',cursor);else p.set('offset',String(start+pages.length));
    p.set('limit',String(size));
    if(meta||!withMeta)p.set('meta','false');
    const batch=await apiFetch('/api/photos?'+p.toString(),query&&query.signal?{signal:query.signal}:undefined);
    if(withMeta&&!meta)meta=batch;
    last=batch;pages.push(...batch.items);cursor=batch.next_cursor||null;
    if(!batch.has_more||!cursor)break;
   }
   return Object.assign({},meta,{items:pages,has_more:!!(last&&last.has_more),next_cursor:last?last.next_cursor||null:null});
  },
  getPhotoDetails:id=>apiFetch('/api/photos/'+encodeURIComponent(id)),
  async getPhotoFile(id){const row=await adapter.getPhotoDetails(id),blob=await fetchFile(id,'original');
   return new File([blob],row.fileName||'site-photo.jpg',{type:blob.type||'image/jpeg'});},
  async preview(id){
   if(thumbCache.has(id)){const v=thumbCache.get(id);thumbCache.delete(id);thumbCache.set(id,v);return v}
   const blob=await fetchFile(id),url=URL.createObjectURL(blob);thumbCache.set(id,url);
   while(thumbCache.size>maxThumbs){const [old,src]=thumbCache.entries().next().value;thumbCache.delete(old);URL.revokeObjectURL(src)}
   return url;
  },
  async createSubmission(sub,onProgress){
   const plant=catalog.find(x=>x.name===sub.plant||x.id===sub.plant);
   if(!plant)throw new Error('Choose a valid plant from the register.');
   const data=new FormData();data.append('plant_id',plant.id);data.append('category',sub.category);
   data.append('description',String(sub.description||''));data.append('tags',JSON.stringify(L.cleanTags(sub.tags)));
   data.append('link_type',sub.linkType||'');data.append('link_id',sub.linkId||'');
   if(sub.submissionId)data.append('submission_id',sub.submissionId);
   // Re-encode as WebP (max 2048 px, the server's limit) on the phone first: far smaller uploads on site mobile data.
   // The server still validates and converts every photo (app/photos/imaging.py); a WebP made here is stored as is.
   const files=sub.files||[];
   for(let i=0;i<files.length;i++){
    const f=files[i],up=typeof compressEvidenceImage==='function'?await compressEvidenceImage(f.file,{maxSide:2048,limit:L.MAX_BYTES}):f.file;
    data.append('files',up,up===f.file?f.name:up.name);
    if(onProgress)onProgress(Math.round(5+45*(i+1)/files.length));
   }
   // No automatic retry of writes: a timeout may happen after the server saved the photo.
   const result=await apiFetch('/api/photos',{method:'POST',body:data});
   if(onProgress)onProgress(100);
   return result;
  },
  clearSession:()=>[],sessionUrls:()=>[]
 };
 window.S91PhotoService=adapter;
 let loading=0;const queue=[],queued=new WeakSet();
 async function dispatch(){
  if(loading>=4||!queue.length)return;
  const item=queue.shift();if(!item.isConnected){dispatch();return}
  loading++;
  try{const url=await adapter.preview(item.dataset.photoId);if(item.isConnected)item.src=url}
  catch(e){if(item.isConnected)item.title='Photo unavailable · tap to retry'}
  finally{loading--;dispatch()}
 }
 const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
  entries.forEach(e=>{if(e.isIntersecting){observer.unobserve(e.target);queue.push(e.target);dispatch()}})
 },{rootMargin:'250px'}):null;
 window.s91PhotoHydrate=function(){document.querySelectorAll('img[data-photo-id]').forEach(img=>{
  if(queued.has(img))return;queued.add(img);if(observer)observer.observe(img);else{queue.push(img);dispatch()}
 })};
 addEventListener('pagehide',()=>{thumbCache.forEach(url=>URL.revokeObjectURL(url));thumbCache.clear()});
})();
