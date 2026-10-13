"use strict";
/* Non-invasive navigation resilience. Does not override role checks, APIs, or server state. */
(function(){
  var lastNavigate=0;
  var renders=0, period=0, rendering=false;
  var overlaySelectors=".pml-overlay,.m26-drawer-overlay,.s91-modal-overlay,.s91-drawer-overlay";
  function closeDetachedOverlays(){
    document.querySelectorAll(overlaySelectors).forEach(function(node){
      // Only detach overlays opened on the preceding screen; the next screen may open new ones.
      if(node && node.parentNode)node.remove();
    });
  }
  function onNavigation(fnName){
    var old=window[fnName];if(typeof old!=="function"||old.__s91NavigationSafe)return;
    function safe(){
      lastNavigate=Date.now();
      closeDetachedOverlays();
      try{return old.apply(this,arguments)}
      catch(error){
        console.error("Solar91 navigation failed",fnName,error);
        // Keep navigation usable even if a legacy UI enhancement throws.
        if(typeof S!=="undefined"){
          S.modal=null;S.modalCtx=null;
          try{if(typeof render==="function")render()}catch(second){console.error("Solar91 recovery failed",second)}
        }
        var app=document.getElementById("app");
        if(app&&!app.querySelector(".shell"))showRecovery(app,"A page could not be displayed.");
      }
    }
    safe.__s91NavigationSafe=true;window[fnName]=safe;
  }
  function showRecovery(container,message){
    if(container.querySelector("#s91-recovery"))return;
    var box=document.createElement("div");box.id="s91-recovery";
    box.style.cssText="padding:16px;margin:16px;border:1px solid #d3dfd7;border-radius:12px;background:white;font:14px system-ui;color:#25382b";
    var title=document.createElement("b");title.textContent=message;
    var button=document.createElement("button");button.type="button";button.textContent="Reload portal";
    button.style.cssText="margin-left:12px;padding:8px 12px;border-radius:8px;cursor:pointer";
    button.addEventListener("click",function(){location.reload()});
    box.append(title,button);container.append(box);
  }
  ["goView","goTab","goScheduledOM","openPlantPage"].forEach(onNavigation);
  var originalRender=window.render;
  if(typeof originalRender==="function"&&!originalRender.__s91StabilityGuard){
    function guardedRender(){
      var now=Date.now();if(now-period>1000){period=now;renders=0}
      // A broken legacy wrapper can synchronously recurse; never let it freeze the browser.
      if(rendering||++renders>24){if(renders===25)console.warn("Solar91: render storm prevented");return}
      rendering=true;
      try{return originalRender.apply(this,arguments)}
      finally{rendering=false}
    }
    guardedRender.__s91StabilityGuard=true;
    window.render=guardedRender;
  }
  window.addEventListener("keydown",function(event){
    if(event.key!=="Escape"||typeof S==="undefined")return;
    if(S.modal){S.modal=null;S.modalCtx=null;closeDetachedOverlays();try{render()}catch(e){}return}
    // Some older dialogs do not respond to Escape, which previously blocked navigation.
    var overlays=document.querySelectorAll(overlaySelectors);
    if(overlays.length){overlays.forEach(function(node){node.remove()});}
  });
  // If Auth/DB initialization takes unusually long, expose a recovery action instead of an endless splash.
  setTimeout(function(){
    var app=document.getElementById("app");
    if(app&&app.querySelector(".s91-boot")&&!app.querySelector(".shell")){
      showRecovery(app,"Solar91 is taking longer than expected to load. Check the connection or retry.");
    }
  },16000);
  window.s91NavigationStatus=function(){return {lastNavigationAt:lastNavigate,renderCountLastSecond:renders,activeView:(typeof S!=="undefined"?S.view:null)}};
})();
