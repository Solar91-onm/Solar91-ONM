/* Solar91 render safety and opt-in diagnostics. No cookie markers, DOM banners,
   or per-cell tracing: those caused a stale `START renderIssues` message to appear
   on otherwise healthy sessions and amplified rendering cost. */
(function () {
  "use strict";
  const events={renders:[],errors:[]};
  const keep=(items,value)=>{items.push(value);if(items.length>40)items.shift();};
  window.__s91Perf=events;
  window.addEventListener("error",event=>{
    keep(events.errors,{type:"script",message:String(event.message||"Unknown error").slice(0,180)});
  });
  window.addEventListener("unhandledrejection",event=>{
    keep(events.errors,{type:"promise",message:String(event.reason?.message||event.reason||"Unknown rejection").slice(0,180)});
  });
  window.s91Diagnose=function(){
    const summary={page:location.pathname+location.hash,renderSamples:events.renders,errors:events.errors};
    console.info("Solar91 diagnostics",summary);
    return JSON.stringify(summary,null,2);
  };
  window.addEventListener("load",function () {
    const base=window.render;
    if(typeof base!=="function"||base.__s91Guarded)return;
    let rendering=false,windowStart=0,renderCount=0;
    function safeRender(){
      const now=Date.now();
      if(now-windowStart>=1000){windowStart=now;renderCount=0;}
      if(rendering){console.warn("[Solar91] Prevented recursive render");return;}
      if(++renderCount>30){
        if(renderCount===31)console.warn("[Solar91] Excessive render requests blocked");
        return;
      }
      const started=performance.now();
      rendering=true;
      try{return base.apply(this,arguments);}
      finally{
        rendering=false;
        const elapsed=Math.round(performance.now()-started);
        keep(events.renders,{view:typeof S!=="undefined"?S.view+"/"+S.omTab:"unknown",ms:elapsed});
        if(elapsed>1200)console.warn("[Solar91] Slow render: "+elapsed+" ms");
      }
    }
    safeRender.__s91Guarded=true;
    window.render=safeRender;
  });
})();
