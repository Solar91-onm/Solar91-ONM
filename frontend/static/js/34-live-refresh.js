/* Solar91 live refresh.
   Without this, every browser shows the data it loaded at login until the user reloads. Here each open tab asks a
   very cheap server endpoint ("pulse": count + latest change time of issues) every 30 s. Only when that changes
   does it fetch fresh data, update the lists in place, and raise a notification for fixed / newly assigned tickets. */
(function(){
  "use strict";
  var POLL_MS=Number(window.S91_POLL_MS)||30000, MIN_REFRESH_GAP=Math.min(15000,POLL_MS);
  var base=null, busy=false, lastRefresh=0, lastTick=0, asked=false;

  function ready(){try{return typeof S!=="undefined"&&S&&typeof S._serverRevision==="number"&&typeof apiFetch==="function"&&Array.isArray(S.issues)}catch(e){return false}}
  function typing(){var a=document.activeElement;if(!a)return false;var t=String(a.tagName||"").toUpperCase();return t==="INPUT"||t==="TEXTAREA"||t==="SELECT"||!!a.isContentEditable}
  var lastInteraction=0;
  ["pointerdown","keydown","touchstart"].forEach(function(name){
    document.addEventListener(name,function(){lastInteraction=Date.now()},{passive:true,capture:true});
  });
  function uiBusy(){return !!S.modal||typing()||Date.now()-lastInteraction<6000}
  function who(){return String(S.currentUser||"").trim().toLowerCase()}
  function snap(){var m={};(S.issues||[]).forEach(function(t){m[t.id]={status:String(t.status||""),assignee:String(t.assignee||"").trim().toLowerCase(),plant:t.plant||"",desc:t.desc||""}});return m}
  function isClosed(st){return /^(closed|resolved|completed|fixed|done)$/i.test(String(st||"").trim())}
  function label(id,r){return id+(r.plant?" · "+r.plant:"")}

  function notify(title,body){
    try{if(typeof toast==="function")toast(title+(body?" — "+body:""))}catch(e){}
    try{if("Notification" in window&&Notification.permission==="granted"&&document.hidden)new Notification(title,{body:body||"",tag:"s91-live"})}catch(e){}
  }
  function describe(before,after){
    var fixed=[],mine=[],fresh=[];
    Object.keys(after).forEach(function(id){
      var a=after[id],b=before[id];
      if(!b){fresh.push(label(id,a));if(a.assignee&&a.assignee===who())mine.push(label(id,a));return}
      if(a.status!==b.status&&isClosed(a.status))fixed.push(label(id,a));
      if(a.assignee&&a.assignee!==b.assignee&&a.assignee===who())mine.push(label(id,a));
    });
    if(mine.length)notify("Assigned to you",mine.slice(0,3).join(", ")+(mine.length>3?" +"+(mine.length-3)+" more":""));
    if(fixed.length)notify("Ticket fixed",fixed.slice(0,3).join(", ")+(fixed.length>3?" +"+(fixed.length-3)+" more":""));
    if(fresh.length)notify(fresh.length+" new ticket"+(fresh.length>1?"s":""),fresh.slice(0,2).join(", ")+(fresh.length>2?" …":""));
    return fixed.length+mine.length+fresh.length;
  }

  async function refresh(){
    var before=snap();
    var boot=await apiFetch("/api/bootstrap");
    var st=(boot&&boot.state)||{};
    if(uiBusy())return false;                       /* user started typing / opened a form meanwhile: try again next tick */
    ["issues","tasks","washing","equipment","events"].forEach(function(k){if(Array.isArray(st[k]))S[k]=st[k]});
    if(typeof s91NormalizeRows==="function")s91NormalizeRows();
    try{if(typeof _lastServerState!=="undefined"&&typeof cloneStateValue==="function")_lastServerState.events=cloneStateValue(S.events||[])}catch(e){}
    describe(before,snap());
    if(uiBusy())return false;  /* Data stays in memory; postpone DOM rebuild until the user is idle. */
    var sc=document.querySelector(".content"),top=sc?sc.scrollTop:0;
    if(typeof render==="function")render();
    var sc2=document.querySelector(".content");if(sc2)sc2.scrollTop=top;
    lastRefresh=Date.now();
    return true;
  }

  async function tick(){
    if(busy||document.hidden||(typeof navigator!=="undefined"&&navigator.onLine===false)||!ready())return;
    busy=true;lastTick=Date.now();
    try{
      var p=await apiFetch("/api/issues/pulse");
      var fp=String(p&&p.count)+"|"+String(p&&p.latest);
      if(base===null){base=fp;return}
      if(fp!==base&&!uiBusy()&&Date.now()-lastRefresh>=MIN_REFRESH_GAP){
        if(await refresh())base=fp;
      }
    }catch(e){/* offline / server asleep / session expired: stay quiet and try again next tick */}
    finally{busy=false}
  }

  setInterval(tick,POLL_MS);
  document.addEventListener("visibilitychange",function(){if(!document.hidden&&Date.now()-lastTick>POLL_MS/2)tick()});
  window.addEventListener("online",function(){tick()});
  document.addEventListener("click",function ask(){
    if(asked)return;asked=true;
    try{if("Notification" in window&&Notification.permission==="default")Notification.requestPermission()}catch(e){}
  },{once:true});
  window.s91LiveRefresh={tick:tick,state:function(){return{base:base,lastRefresh:lastRefresh}}};
})();
