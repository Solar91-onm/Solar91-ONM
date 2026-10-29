/* Solar91 live refresh.
   Without this, every browser shows the data it loaded at login until the user reloads. Here each open tab asks a
   very cheap server endpoint ("pulse": count + latest change time of issues and of PM work orders) every 30 s. Only when that changes
   does it fetch fresh data, update the lists in place, and raise a notification for fixed / newly assigned tickets. */
(function(){
  "use strict";
  var POLL_MS=Number(window.S91_POLL_MS)||30000, MIN_REFRESH_GAP=Math.min(15000,POLL_MS);
  var base=null, busy=false, lastRefresh=0, lastTick=0;

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
    /* through the service worker (48-mobile-pwa.js) so Android shows it too; the person turns this on in App & permissions */
    try{if(document.hidden){if(typeof window.s91ShowNotification==="function")window.s91ShowNotification(title,body,"s91-live");else if("Notification" in window&&Notification.permission==="granted")new Notification(title,{body:body||"",tag:"s91-live"})}}catch(e){}
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

  /* Only the collections whose pulse changed are fetched (state/collections builds just those on the server):
     an issue change does not re-download every PM work order, and nothing else of the application state is re-read. */
  async function refresh(what){
    var before=snap();
    var keys=["plants","events"].concat(what.issues?["issues","equipment"]:[]).concat(what.tasks?["tasks"]:[]);
    var res=await apiFetch("/api/state/collections?keys="+encodeURIComponent(keys.join(",")));
    var st=(res&&res.state)||{};
    if(uiBusy())return false;                       /* user started typing / opened a form meanwhile: try again next tick */
    ["issues","tasks","equipment","events"].forEach(function(k){if(Array.isArray(st[k]))S[k]=st[k]});
    /* Plants added or edited elsewhere (another user, Excel import) appear without a reload; unsynced local edits are kept. */
    try{if(Array.isArray(st.plants)&&typeof mergeServerCollection==="function"&&typeof _lastServerState!=="undefined"){S.plants=mergeServerCollection(S.plants||[],st.plants,_lastServerState.plants);_lastServerState.plants=cloneStateValue(st.plants)}}catch(e){}
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
      var fp={issues:String(p&&p.count)+"|"+String(p&&p.latest),tasks:String(p&&p.tasks)};   /* issues and PM work orders */
      if(base===null){base=fp;return}
      var what={issues:fp.issues!==base.issues,tasks:fp.tasks!==base.tasks};
      if((what.issues||what.tasks)&&!uiBusy()&&Date.now()-lastRefresh>=MIN_REFRESH_GAP){
        if(await refresh(what))base=fp;
      }
    }catch(e){/* offline / server asleep / session expired: stay quiet and try again next tick */}
    finally{busy=false}
  }

  setInterval(tick,POLL_MS);
  document.addEventListener("visibilitychange",function(){if(!document.hidden&&Date.now()-lastTick>POLL_MS/2)tick()});
  window.addEventListener("online",function(){tick()});
  /* no automatic permission prompt: notifications are switched on from the account menu → App & permissions */
  window.s91LiveRefresh={tick:tick,state:function(){return{base:base,lastRefresh:lastRefresh}}};
})();
