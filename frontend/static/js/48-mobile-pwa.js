"use strict";
/* Phone / installed-app support for the whole portal:
   - install: a one-time "Install Solar91" bar on phones (Android prompt, iPhone Share → Add to Home Screen steps)
   - update: when a new version is deployed (GET /health/version differs from this page's build), offer a reload
   - App & permissions: one place to install, allow the camera and allow notifications, with honest status
   - notifications go through the service worker so they also show on Android; nothing is asked without a tap.
   Nothing here stores operational data; the only browser storage is the "Not now" choice for the install bar. */
(function(){
 if(window.s91AppSettings)return;
 const h=v=>typeof esc==="function"?esc(v==null?"":String(v)):String(v==null?"":v);
 const ua=navigator.userAgent||"";
 const isIOS=/iPad|iPhone|iPod/.test(ua)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
 const standalone=()=>(window.matchMedia&&matchMedia("(display-mode: standalone)").matches)||navigator.standalone===true;
 const phone=()=>window.matchMedia&&matchMedia("(max-width:900px)").matches;
 const store={get:k=>{try{return localStorage.getItem(k)}catch(e){return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}}};
 const root=document.documentElement;
 root.classList.toggle("s91-standalone",standalone());root.classList.toggle("s91-ios",isIOS);

 /* ---------- install ---------- */
 let canPrompt=false;
 addEventListener("beforeinstallprompt",()=>{canPrompt=true;bars()}); /* pwa.js keeps the event and shows the prompt */
 addEventListener("appinstalled",()=>{canPrompt=false;root.classList.add("s91-standalone");store.set("s91-install-bar","installed");bars();toast("Solar91 is installed. Open it from your home screen.")});
 /* iPhone / iPad: Apple lets no web page install itself, so the person adds it from Safari's Share menu.
    This sheet walks them through it; it lives on <body>, so it also works on the sign-in screen. */
 const inAppOrOther=/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|WhatsApp|Line\//.test(ua); /* not Safari: Add to Home Screen may be missing */
 const isIPad=/iPad/.test(ua)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
 const SHARE='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
 const ADD='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
 function iosSteps(){
  let el=document.getElementById("s91-ios-guide");if(el)el.remove();
  el=document.createElement("div");el.id="s91-ios-guide";el.setAttribute("role","dialog");el.setAttribute("aria-modal","true");el.setAttribute("aria-labelledby","s91-ios-title");
  el.className=isIPad?"ipad":"";
  el.innerHTML='<div class="s91-ios-sheet"><h2 id="s91-ios-title">Install Solar91 on your '+(isIPad?"iPad":"iPhone")+'</h2>'+
   (inAppOrOther?'<div class="s91-ios-warn"><b>First, open this page in Safari.</b> Other browsers and in-app browsers (WhatsApp, Gmail…) may not offer Add to Home Screen. Copy the link, open Safari and paste it.<button type="button" class="btn o sm" data-ios="copy">Copy link</button></div>':'')+
   '<ol class="s91-ios-steps">'+
    '<li><i>'+SHARE+'</i><span>Tap <b>Share</b> in Safari\'s toolbar '+(isIPad?'at the <b>top</b> of the screen':'at the <b>bottom</b> of the screen')+'. On newer iPhones it may be inside the <b>•••</b> menu.</span></li>'+
    '<li><i>'+ADD+'</i><span>Scroll down and tap <b>Add to Home Screen</b>.</span></li>'+
    '<li><i><img src="/static/pwa/apple-touch-icon.png" alt="" width="22" height="22"/></i><span>Tap <b>Add</b>. Solar91 then opens from your home screen, full screen like an app.</span></li></ol>'+
   '<p class="s91-ios-note">Apple does not allow websites to install themselves, so this takes three taps in Safari.</p>'+
   '<button type="button" class="btn p" data-ios="close">Got it</button></div>'+
   (isIPad?'':'<div class="s91-ios-arrow" aria-hidden="true">↓</div>');
  el.addEventListener("click",e=>{
   const a=e.target.closest("[data-ios]");if(!a&&e.target!==el)return;
   if(a&&a.dataset.ios==="copy"){const done=()=>{a.textContent="Link copied";};try{navigator.clipboard.writeText(location.origin+"/").then(done,()=>prompt("Copy this link:",location.origin+"/"))}catch(err){prompt("Copy this link:",location.origin+"/")}return}
   el.remove();
  });
  document.addEventListener("keydown",function esc(e){if(e.key==="Escape"){el.remove();document.removeEventListener("keydown",esc)}});
  document.body.appendChild(el);
  const btn=el.querySelector('[data-ios="close"]');if(btn)btn.focus();
 }
 /* the sign-in screen's "Install app" button (pwa.js) shows this guide on iPhone / iPad instead of the generic help */
 document.addEventListener("click",e=>{if(isIOS&&!standalone()&&e.target.closest&&e.target.closest("#installApp")){e.preventDefault();e.stopImmediatePropagation();iosSteps()}},true);
 window.s91Install=function(){
  if(standalone()){toast("Solar91 is already installed on this device.");return}
  if(isIOS){iosSteps();return}
  const b=document.getElementById("installApp");if(b)b.click();else toast("Use your browser menu: Install app or Add to Home screen.");
 };

 /* ---------- notifications (shown by the service worker so Android shows them too) ---------- */
 window.s91ShowNotification=function(title,body,tag){
  try{
   if(!("Notification" in window)||Notification.permission!=="granted")return false;
   const opts={body:body||"",tag:tag||"s91",icon:"/static/pwa/icon-192.png",badge:"/static/pwa/favicon-32.png"};
   if(navigator.serviceWorker&&navigator.serviceWorker.ready){navigator.serviceWorker.ready.then(r=>r.showNotification(title,opts)).catch(()=>{try{new Notification(title,opts)}catch(e){}});return true}
   new Notification(title,opts);return true;
  }catch(e){return false}
 };

 /* ---------- permissions ---------- */
 const P={camera:"unknown",notify:"unknown",busy:""};
 async function readStatus(){
  P.notify=!("Notification" in window)?"unsupported":Notification.permission; /* granted | denied | default */
  if(!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia))P.camera="unsupported";
  else try{const q=await navigator.permissions.query({name:"camera"});P.camera=q.state}catch(e){if(P.camera==="unknown")P.camera="ask"} /* Safari / Firefox cannot report it */
 }
 window.s91AllowCamera=async function(){
  P.busy="camera";render();
  try{const s=await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"},audio:false});s.getTracks().forEach(t=>t.stop());P.camera="granted";toast("Camera allowed.")}
  catch(e){P.camera=e&&e.name==="NotAllowedError"?"denied":P.camera;toast(e&&e.name==="NotAllowedError"?"Camera blocked. Allow it in your browser or phone settings.":"The camera could not be opened on this device.")}
  P.busy="";await readStatus();render();
 };
 window.s91AllowNotifications=async function(){
  if(!("Notification" in window)){toast("This browser cannot show notifications.");return}
  P.busy="notify";render();
  try{const r=await Notification.requestPermission();P.notify=r;if(r==="granted")s91ShowNotification("Solar91 notifications are on","You will be alerted about ticket changes while Solar91 is open or in the background.","s91-test");else if(r==="denied")toast("Notifications blocked. Allow them in your browser or phone settings.")}
  catch(e){toast("Notifications could not be turned on.")}
  P.busy="";render();
 };
 window.s91TestNotification=function(){if(!s91ShowNotification("Test from Solar91","Notifications are working on this device.","s91-test"))toast("Allow notifications first.")};
 const pill=(state)=>{const m={granted:["Allowed","ok"],denied:["Blocked","bad"],prompt:["Not yet allowed","warn"],default:["Not yet allowed","warn"],ask:["Asked when needed","warn"],unsupported:["Not available on this browser","mut"],unknown:["Checking…","mut"]};const x=m[state]||m.unknown;return '<span class="s91-perm-st '+x[1]+'">'+x[0]+'</span>'};
 function settingsModal(){
  const installed=standalone();
  const row=(icon,title,status,text,actions)=>'<section class="s91-perm"><div class="s91-perm-h"><b>'+icon+' '+title+'</b>'+status+'</div><p>'+text+'</p>'+(actions?'<div class="s91-perm-a">'+actions+'</div>':'')+'</section>';
  const body=
   row("📲","Install on this device",'<span class="s91-perm-st '+(installed?"ok":"warn")+'">'+(installed?"Installed":"Not installed")+'</span>',
    installed?"You are using the installed Solar91 app.":(isIOS?"On iPhone: open this page in Safari, tap Share, then Add to Home Screen. Solar91 then opens full screen like an app.":"Add Solar91 to your home screen so it opens full screen like an app, without the browser bar."),
    installed?"":'<button type="button" class="btn p sm" onclick="s91Install()">'+(isIOS?"Show iPhone steps":"Install Solar91")+'</button>')+
   row("📷","Camera",pill(P.camera),
    "Take photo opens your phone camera for site photos. Most phones ask the first time. If the camera is blocked, allow it here or in your phone settings.",
    P.camera==="granted"||P.camera==="unsupported"?"":'<button type="button" class="btn o sm" onclick="s91AllowCamera()"'+(P.busy?" disabled":"")+'>'+(P.busy==="camera"?"Asking…":"Allow camera")+'</button>')+
   row("🔔","Notifications",pill(P.notify),
    "Alerts about new and changed tickets while Solar91 is open or running in the background."+(isIOS&&!installed?" On iPhone, install Solar91 to your home screen first: iPhone only allows notifications for installed apps.":"")+" Alerts to a phone with Solar91 fully closed need push notifications, planned for a later release.",
    (P.notify==="default"?'<button type="button" class="btn o sm" onclick="s91AllowNotifications()"'+(P.busy?" disabled":"")+'>'+(P.busy==="notify"?"Asking…":"Allow notifications")+'</button>':'')+(P.notify==="granted"?'<button type="button" class="btn g sm" onclick="s91TestNotification()">Send a test</button>':''))+
   (P.camera==="denied"||P.notify==="denied"?'<p class="s91-perm-note">Blocked permissions can only be changed in your browser or phone settings: open site settings for this portal and allow Camera or Notifications, then come back.</p>':'');
  return modal("App &amp; permissions","Install Solar91 and choose what it may use on this device",body,'<button class="btn o" onclick="closeModal()">Close</button>');
 }
 window.s91AppSettings=function(){S.userMenuOpen=false;S.modal="s91AppSettings";S.modalCtx={};readStatus().then(()=>{if(S.modal==="s91AppSettings")render()});render()};
 if(typeof renderModal==="function"){const prev=renderModal;renderModal=function(){if(S.modal==="s91AppSettings")return settingsModal();return prev.apply(this,arguments)}}

 /* ---------- bottom bars: install (phones, once) and update (everyone) ---------- */
 let updateReady=false;
 function bars(){
  let el=document.getElementById("s91-pwa-bar");
  const signedIn=!!document.querySelector("#app .shell");
  const showUpdate=updateReady;
  const showInstall=!showUpdate&&signedIn&&phone()&&!standalone()&&!store.get("s91-install-bar")&&(canPrompt||isIOS);
  if(!showUpdate&&!showInstall){if(el)el.remove();return}
  if(!el){el=document.createElement("div");el.id="s91-pwa-bar";el.setAttribute("role","status");document.body.appendChild(el)}
  const kind=showUpdate?"update":"install";if(el.dataset.kind===kind)return;el.dataset.kind=kind;
  el.innerHTML=showUpdate
   ?'<span><b>A new version of Solar91 is ready.</b> Reload to use it. Save anything you are typing first.</span><button type="button" class="btn p sm" onclick="location.reload()">Reload</button><button type="button" class="btn g sm" aria-label="Later" onclick="s91PwaLater(\'update\')">Later</button>'
   :'<span><b>Install Solar91</b> on this phone for full-screen use and faster access.</span><button type="button" class="btn p sm" onclick="s91Install()">'+(isIOS?"How":"Install")+'</button><button type="button" class="btn g sm" aria-label="Not now" onclick="s91PwaLater(\'install\')">Not now</button>';
 }
 window.s91PwaLater=function(kind){if(kind==="install")store.set("s91-install-bar","later");else{updateReady=false;nextCheck=Date.now()+30*60e3}bars()};
 const pageBuild=()=>{const m=document.querySelector('meta[name="s91-build"]');return m?m.content:""};
 let nextCheck=0,checking=false;
 async function checkVersion(){
  if(checking||updateReady||Date.now()<nextCheck||!navigator.onLine)return;checking=true;nextCheck=Date.now()+10*60e3;
  try{
   const r=await fetch("/health/version",{cache:"no-store",credentials:"same-origin"});if(!r.ok)return;
   const v=await r.json(),live=(v.commit_short||"local")+"."+v.frontend_bundle,mine=pageBuild();
   if(mine&&mine.indexOf("{{")<0&&live!==mine){updateReady=true;bars()}
  }catch(e){}finally{checking=false}
  try{if(navigator.serviceWorker)navigator.serviceWorker.getRegistration().then(reg=>reg&&reg.update()).catch(()=>{})}catch(e){}
 }
 window.s91CheckVersion=()=>{nextCheck=0;return checkVersion()};
 document.addEventListener("visibilitychange",()=>{if(!document.hidden)checkVersion()});
 setInterval(checkVersion,5*60e3);
 setTimeout(checkVersion,20e3);

 /* the account menu and other re-renders: keep the bars in step with sign-in state */
 if(typeof render==="function"){const prev=render;render=function(){const out=prev.apply(this,arguments);try{bars()}catch(e){}return out}}
 /* the first paint can happen before this file wraps render(): look again once sign-in has settled */
 [1500,5000].forEach(ms=>setTimeout(()=>{try{bars()}catch(e){}},ms));
 matchMedia&&matchMedia("(display-mode: standalone)").addEventListener&&matchMedia("(display-mode: standalone)").addEventListener("change",()=>{root.classList.toggle("s91-standalone",standalone());bars()});
})();
