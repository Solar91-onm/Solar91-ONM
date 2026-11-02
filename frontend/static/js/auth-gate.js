/* ============================================================================
   auth-gate.js — Solar91 sign-in gate.

   Extracted UNCHANGED from the previous frontend bundle
   (00-auth-data-and-imports.js lines 1-277, 313, 331-408). The login panel,
   the Clerk email-code flow, token handling and the API fetch wrapper behave
   exactly as they did before the portal redesign; only the application that
   boots after a successful sign-in has changed.

   Do not restyle or re-order this file: it is the access panel.
   ============================================================================ */



"use strict";

const AUTH_PROVIDER = (window.S91_CONFIG && window.S91_CONFIG.authProvider) || "clerk";
const AUTH_IDENTITY={name:null,role:null};
const S91_CODE_RESEND_SECONDS=60;

function authSetupCard(title, detail){
  document.getElementById("app").innerHTML = '<div style="min-height:100vh;display:grid;place-items:center;padding:24px;background:#F4F6F5;font-family:Inter,system-ui,sans-serif"><div style="width:min(520px,100%);background:#fff;border:1px solid #E4E9E6;border-radius:16px;padding:24px;box-shadow:0 12px 38px rgba(16,24,20,.10)"><div style="display:flex;align-items:center;gap:10px"><img src="/static/brand/solar91-emblem.png" height="34" alt=""><img src="/static/brand/solar91-wordmark.png" height="22" alt="SOLAR 91"></div><h2 style="margin:8px 0 8px;font-size:22px">'+title+'</h2><p style="margin:0;color:#4F5B55;line-height:1.55">'+detail+'</p></div></div>';
}
async function ensureClerkReady(){
  if (AUTH_PROVIDER !== "clerk" || !window.S91_CONFIG?.clerkPublishableKey) {
    authSetupCard("Authentication setup required","Clerk is unavailable. Configure CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, and CLERK_ISSUER on the server, then reload.");
    return false;
  }
  const deadline=Date.now()+10000;
  while(!window.Clerk&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
  if (!window.Clerk || typeof window.Clerk.load !== "function") {
    authSetupCard("Authentication setup required","The Clerk sign-in service could not be loaded. Check your connection and reload.");
    return false;
  }
  await window.Clerk.load();
  return true;
}

function showClerkSignIn(errorMessage){
  const h=new Date().getHours();
  const greet=h<12?"Good morning":h<17?"Good afternoon":"Good evening";
  const EM='<img src="/static/brand/solar91-emblem.png" alt="">';
  const panels=Array.from({length:36},(_,i)=>'<div class="s91-pv" style="--d:'+((i%9)*0.25+Math.floor(i/9)*0.5)+'s"></div>').join("");
  document.getElementById("app").innerHTML=
   '<div class="s91-auth">'+
    '<aside class="s91-hero" aria-hidden="true">'+
      '<div class="s91-tone"></div>'+
      '<canvas class="s91-mesh"></canvas>'+
      '<div class="s91-mark91">91</div>'+
      '<div class="s91-sun"><i class="rip"></i><i class="rip"></i><i class="rip"></i><i class="rays"></i><i class="core">'+EM+'</i></div>'+
      '<div class="s91-cloud c1"></div><div class="s91-cloud c2"></div><div class="s91-cloud c3"></div>'+
      '<div class="s91-float f1">'+EM+'</div><div class="s91-float f2">'+EM+'</div><div class="s91-float f3">'+EM+'</div><div class="s91-float f4">'+EM+'</div>'+
      '<div class="s91-copy">'+
        '<div class="s91-hbrand">'+EM+'<img class="w" src="/static/brand/solar91-wordmark.png" alt="SOLAR 91"><small>Energizing India</small></div>'+
        '<span class="s91-pill">☀️ '+greet+', team!</span>'+
        '<h1>Powering India,<br><em>one sunrise</em> at a time.</h1>'+
        '<p>Every plant, every issue, every scheduled visit — together in one bright place.</p>'+
      '</div>'+
      '<div class="s91-chips">'+
        '<div class="s91-chip s91-ai"><span class="dot"></span><span class="lbl">Solar91 AI</span><span class="typed" id="s91-typed"></span><span class="caret"></span></div>'+
        '<div class="s91-chip s91-curve"><svg viewBox="0 0 200 60" width="200" height="60"><defs><linearGradient id="s91g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16A34A" stop-opacity=".45"/><stop offset="1" stop-color="#16A34A" stop-opacity="0"/></linearGradient></defs><path class="area" d="M0 54 C40 54 60 6 100 6 S160 54 200 54 V60 H0Z" fill="url(#s91g)"/><path class="line" d="M0 54 C40 54 60 6 100 6 S160 54 200 54" fill="none" stroke="#16A34A" stroke-width="3" stroke-linecap="round"/></svg><div class="cap"><i class="blip"></i>Generation curve · always on</div><i class="orb"></i></div>'+
        '<div class="s91-chip"><i>✨</i>Panels sparkling</div>'+
      '</div>'+
      '<svg class="s91-hills" viewBox="0 0 800 300" preserveAspectRatio="none"><path d="M0 170 Q160 90 340 150 T800 120 V300 H0Z" fill="#5CB97A" opacity=".85"/><path d="M0 220 Q220 150 430 205 T800 180 V300 H0Z" fill="#2E9B5A"/></svg>'+
      '<div class="s91-field"><div class="s91-grid">'+panels+'</div></div>'+
      '<div class="s91-ticker"><div class="s91-track">'+Array(8).join('<span>SOLAR 91 &nbsp;✦&nbsp; ENERGIZING INDIA &nbsp;✦&nbsp; </span>')+'</div></div>'+
    '</aside>'+
    '<main class="s91-side"><i class="blob b1"></i><i class="blob b2"></i><i class="blob b3"></i>'+
      '<div class="s91-col">'+
        '<div class="s91-brand">'+EM.replace('<img','<img class="em"')+'<img class="wm" src="/static/brand/solar91-wordmark.png" alt="SOLAR 91"></div>'+
        '<h2 class="s91-title">O&amp;M Plant Operations</h2>'+
        '<p class="s91-sub">Sign in with the email your O&amp;M Head added</p>'+
        '<div class="s91-glow"></div>'+
        '<div class="s91-foot">Solar91 Cleantech Limited · <b>Energizing India</b></div>'+
      '</div>'+
    '</main>'+
   '</div>';
  s91ShowClerkCodeSignIn("",errorMessage);
  s91Alive(document.querySelector(".s91-mesh"));
}

/* ---- Clerk email-code sign-in ---- */
/* Same rule as app/auth/emails.py: Gmail ignores dots and +tags, so one mailbox = one account. Typos are never corrected. */
function s91CanonEmail(v){
  const e=String(v||"").trim().toLowerCase(),i=e.lastIndexOf("@");
  if(i<1)return e;
  const dom=e.slice(i+1);
  if(dom==="gmail.com"||dom==="googlemail.com"){
    const local=e.slice(0,i).split("+")[0].replace(/\./g,"");
    if(local)return local+"@gmail.com";
  }
  return e;
}
function s91CodeError(err){
  const clerkError=err&&Array.isArray(err.errors)&&err.errors[0];
  const m=String(clerkError&&(clerkError.longMessage||clerkError.message)||err&&err.message||"");
  if(err&&err.status===429||/rate limit|only request this after|too many/i.test(m)){
    const secs=(m.match(/(\d+)\s*sec/i)||[])[1];
    return "Clerk is limiting sign-in requests for this email. "+(secs?"Try again in "+secs+" seconds.":"Wait a minute and try again.");
  }
  if(/signups not allowed|sign.?up.*disabled/i.test(m))return "This email has no Clerk account yet. Ask your O&M Head to add you.";
  if(/expired|invalid/i.test(m))return "That code is wrong or has expired. Check the newest email, or ask for a new code.";
  return m||"Something went wrong. Please try again.";
}
function s91ShowClerkCodeSignIn(prefillEmail,errorMessage){
  const box=document.querySelector(".s91-glow");
  if(!box)return;
  const fld='display:grid;gap:5px;font-size:12px;font-weight:600',inp='padding:11px;border:1px solid #D7DFD9;border-radius:8px',
        lnk='background:none;border:0;color:#16794A;font-size:12px;font-weight:600;cursor:pointer;padding:4px';
  box.innerHTML=
    '<form id="clerk-code-form" style="display:grid;gap:12px;background:#fff;padding:20px;border:1px solid #E4E9E6;border-radius:14px">'+
      '<label style="'+fld+'">Email<input id="clerk-code-email" name="email" type="email" autocomplete="email" required value="'+esc(prefillEmail||"")+'" style="'+inp+'"></label>'+
      '<label id="clerk-code-field" style="'+fld+';display:none">Code from your email<input id="clerk-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" style="'+inp+';letter-spacing:4px;font-size:18px;text-align:center"></label>'+
      '<p id="clerk-code-msg" role="status" style="margin:0;color:#2B4033;font-size:12px"></p>'+
      '<p id="clerk-code-error" role="alert" style="margin:0;color:#B42318;font-size:12px"></p>'+
      '<button id="clerk-code-submit" type="submit" style="padding:11px;border:0;border-radius:8px;background:#16A34A;color:white;font-weight:700;cursor:pointer">Email me a code</button>'+
      '<button id="clerk-code-resend" type="button" style="'+lnk+';display:none"></button>'+
    '</form>';
  const $=id=>document.getElementById(id);
  let sent=false,cool=0,timer=null,signInAttempt=null,signUpAttempt=null,flow=null;
  const msg=t=>{$("clerk-code-msg").textContent=t||""},fail=t=>{$("clerk-code-error").textContent=t||""};
  function tick(){
    const b=$("clerk-code-resend");
    if(!b||!document.body.contains(b)){clearInterval(timer);return}
    if(cool>0){b.disabled=true;b.textContent="Send a new code in "+cool+"s";cool-=1}
    else{clearInterval(timer);b.disabled=false;b.textContent="Send a new code"}
  }
  function startCooldown(){cool=S91_CODE_RESEND_SECONDS;clearInterval(timer);timer=setInterval(tick,1000);tick()}
  async function requestCode(){
    const email=s91CanonEmail($("clerk-code-email").value);
    try{
      signInAttempt=await window.Clerk.client.signIn.create({identifier:email});
      const factor=(signInAttempt.supportedFirstFactors||[]).find(item=>item.strategy==="email_code");
      if(!factor)throw new Error("Email sign-in codes are not enabled for this Clerk account.");
      flow="signIn";
      await signInAttempt.prepareFirstFactor({strategy:"email_code",emailAddressId:factor.emailAddressId});
    }catch(err){
      const notFound=err&&Array.isArray(err.errors)&&err.errors.some(item=>item.code==="form_identifier_not_found");
      if(!notFound)throw err;
      signUpAttempt=await window.Clerk.client.signUp.create({emailAddress:email});
      flow="signUp";
      await signUpAttempt.prepareEmailAddressVerification({strategy:"email_code"});
    }
  }
  async function sendCode(){
    const email=$("clerk-code-email").value.trim();
    await requestCode();
    sent=true;
    $("clerk-code-email").readOnly=true;
    $("clerk-code-field").style.display="grid";
    $("clerk-code-resend").style.display="block";
    $("clerk-code-submit").textContent="Verify and sign in";
    msg("Clerk emailed a code to "+email+". Check spam if you do not see it.");
    startCooldown();
    $("clerk-code").focus();
  }
  $("clerk-code-form").addEventListener("submit",async function(ev){
    ev.preventDefault();
    const submit=$("clerk-code-submit");fail("");
    submit.disabled=true;
    try{
      if(!sent){
        submit.textContent="Sending…";
        await sendCode();
      }else{
        const token=$("clerk-code").value.replace(/\D/g,"");
        if(token.length<6){fail("Enter the code from the email.");return}
        submit.textContent="Verifying…";
        const attempt=flow==="signIn"
          ?await signInAttempt.attemptFirstFactor({strategy:"email_code",code:token})
          :await signUpAttempt.attemptEmailAddressVerification({code:token});
        if(attempt.status!=="complete"||!attempt.createdSessionId)throw new Error("Clerk could not complete sign-in. Request a new code and try again.");
        await window.Clerk.setActive({session:attempt.createdSessionId});
        await startSolar91App();
        return;
      }
    }catch(err){
      fail(s91CodeError(err));
      submit.textContent=sent?"Verify and sign in":"Email me a code";
    }finally{
      if(document.body.contains(submit))submit.disabled=false;
    }
  });
  $("clerk-code-resend").addEventListener("click",async function(){
    fail("");
    try{await requestCode();msg("A new code was sent. Use the newest email only.");startCooldown()}catch(err){fail(s91CodeError(err))}
  });
  if(errorMessage)fail(errorMessage);
  $("clerk-code-email").focus();
}

/* ---- sign-in page life: neural mesh + typing AI line. Both stop by themselves once the page is replaced. ---- */
function s91Alive(canvas){
  const still=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
  /* 1. typing "AI" status line */
  const el=document.getElementById("s91-typed");
  const msgs=["Scanning plant health…","Scheduling today’s O&M visits…","Predicting the next panel wash…","Prioritising open site issues…","Syncing every site team…"];
  let mi=0,ci=0,del=false;
  (function type(){
    if(!el||!document.body.contains(el)) return;
    const m=msgs[mi];
    if(still){el.textContent=m;return;}
    ci+=del?-1:1; el.textContent=m.slice(0,ci);
    let wait=del?22:48;
    if(!del&&ci===m.length){del=true;wait=1700;}
    else if(del&&ci===0){del=false;mi=(mi+1)%msgs.length;wait=350;}
    setTimeout(type,wait);
  })();
  /* 2. glowing neural mesh with travelling data packets */
  if(!canvas||!canvas.getContext) return;
  const ctx=canvas.getContext("2d"),dpr=Math.min(window.devicePixelRatio||1,2),LINK=120;
  let w=0,h=0,pts=[];
  function size(){
    const r=canvas.getBoundingClientRect(); w=r.width; h=r.height;
    canvas.width=w*dpr; canvas.height=h*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
    const n=Math.round(Math.min(70,Math.max(22,w*h/14000)));
    pts=Array.from({length:n},()=>({x:Math.random()*w,y:Math.random()*h*0.72,vx:(Math.random()-.5)*.28,vy:(Math.random()-.5)*.28,p:Math.random()*6.28}));
  }
  size(); window.addEventListener("resize",size);
  function frame(t){
    if(!document.body.contains(canvas)){window.removeEventListener("resize",size);return;}
    if(document.hidden){requestAnimationFrame(frame);return;}
    ctx.clearRect(0,0,w,h);
    for(const p of pts){
      p.x+=p.vx; p.y+=p.vy;
      if(p.x<0||p.x>w)p.vx*=-1;
      if(p.y<0||p.y>h*.72)p.vy*=-1;
    }
    for(let i=0;i<pts.length;i++){
      for(let j=i+1;j<pts.length;j++){
        const a=pts[i],b=pts[j],dx=a.x-b.x,dy=a.y-b.y,d=Math.sqrt(dx*dx+dy*dy);
        if(d<LINK){
          ctx.strokeStyle="rgba(255,255,255,"+((1-d/LINK)*.55)+")"; ctx.lineWidth=1;
          ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
          if((i+j)%6===0){                       /* a golden "data packet" riding the link */
            const f=((t/1600)+i*.17)%1,px=a.x+(b.x-a.x)*f,py=a.y+(b.y-a.y)*f;
            ctx.fillStyle="rgba(255,196,40,.95)"; ctx.shadowColor="rgba(255,196,40,.9)"; ctx.shadowBlur=10;
            ctx.beginPath(); ctx.arc(px,py,2.2,0,6.283); ctx.fill(); ctx.shadowBlur=0;
          }
        }
      }
    }
    for(const p of pts){
      const r=1.8+Math.sin(t/650+p.p)*.7;
      ctx.fillStyle="rgba(255,255,255,.95)"; ctx.shadowColor="rgba(255,255,255,.95)"; ctx.shadowBlur=12;
      ctx.beginPath(); ctx.arc(p.x,p.y,r,0,6.283); ctx.fill(); ctx.shadowBlur=0;
    }
    if(!still) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}




async function clerkToken(fresh){
  if (AUTH_PROVIDER !== "clerk") return null;
  try {
    if (window.Clerk?.session) return await window.Clerk.session.getToken(fresh?{skipCache:true}:undefined);
  } catch (err) {
    console.warn("Clerk session could not be read.");
  }
  return null;
}
async function clerkSignOut(){
  try {
    if (window.Clerk && typeof window.Clerk.signOut === "function") await window.Clerk.signOut();
  } finally {
    window.location.assign("/");
  }
}
async function authenticatedFetch(url, options){
  const request=options||{};
  request.headers=Object.assign({},request.headers||{});
  const send=async fresh=>{
    const token=await clerkToken(fresh);
    if(token)request.headers.Authorization="Bearer "+token;else delete request.headers.Authorization;
    return fetch(url,request);
  };
  let response=await send(false);
  // Clerk tokens live about a minute; one that expired on the way (slow upload, server waking up) gets one retry with a fresh token.
  // A 401 is only raised by the sign-in check, before any data is written, so the retry cannot save twice.
  if(response.status===401)response=await send(true);
  if(response.status===401){
    await clerkSignOut();
    throw new Error("Authentication required");
  }
  return response;
}


/* ---------- shared escaping helper (needed by the panel) ---------- */

function esc(q){return String(q==null?"":q).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}

/* ---------- API error messages + authenticated fetch ---------- */

/* A readable message for a failed API response. FastAPI validation errors arrive as a list ("detail":[{loc,msg}]),
   and a proxy error page (Render 502/503 while the service wakes up) has no JSON at all; neither should reach the
   person as a bare "HTTP 422" / "HTTP 502". */
const S91_HTTP_MESSAGES={400:"The request could not be processed. Check the entered values.",403:"You do not have permission to do this.",404:"This record was not found. It may have been removed — refresh the page.",408:"The request timed out. Please retry.",409:"This record was changed by someone else. Refresh and try again.",413:"The file is too large to upload.",415:"This file type is not supported.",422:"Some of the entered values are not valid.",429:"Too many requests at once. Wait a moment and retry.",500:"The server hit an unexpected error. Please retry; if it keeps happening, tell the O&M Head.",502:"The server is starting up or briefly unavailable. Please retry in a minute.",503:"The service is temporarily unavailable (it may be waking up). Please retry in a minute.",504:"The server took too long to respond. Please retry."};
function s91ApiErrorMessage(status,data){
  const raw=data&&data.detail;
  if(typeof raw==="string"&&raw.trim())return raw;
  if(Array.isArray(raw)&&raw.length){
    const parts=raw.slice(0,3).map(item=>{
      const loc=(item&&Array.isArray(item.loc)?item.loc:[]).filter(x=>typeof x==="string"&&!["body","query","path"].includes(x));
      const field=loc.length?loc[loc.length-1].replace(/_/g," "):"";
      const msg=String((item&&item.msg)||"is not valid").replace(/^Value error,\s*/i,"");
      return field?field.charAt(0).toUpperCase()+field.slice(1)+": "+msg:msg;
    });
    return "Please check: "+parts.join("; ")+(raw.length>3?" (and "+(raw.length-3)+" more)":"");
  }
  if(raw&&typeof raw==="object"&&typeof raw.message==="string"&&raw.message)return raw.message;
  return S91_HTTP_MESSAGES[status]||"The request failed (HTTP "+status+"). Please retry.";
}
async function apiFetch(url,opts,latency){
  opts=Object.assign({},opts||{});opts.headers=Object.assign({"Accept":"application/json"},opts.headers||{});
  const token=await clerkToken();
  if(token)opts.headers["Authorization"]="Bearer "+token;
  const isForm=(typeof FormData!=="undefined"&&opts.body instanceof FormData);
  if(opts.body&&typeof opts.body!=="string"&&!isForm)opts.body=JSON.stringify(opts.body);
  if(opts.body&&!isForm)opts.headers["Content-Type"]="application/json";
  const isRead=!opts.method||["GET","HEAD"].includes(String(opts.method).toUpperCase());
  const externalSignal=opts.signal;
  // Bounded requests: a sleeping server must not leave the portal in a permanent spinner.
  // Never retry writes automatically; a timed-out write could already have committed.
  async function attempt(){
    const controller=new AbortController(),abortFromCaller=()=>controller.abort();
    if(externalSignal){
      if(externalSignal.aborted)controller.abort();
      else externalSignal.addEventListener("abort",abortFromCaller,{once:true});
    }
    const timeout=setTimeout(()=>controller.abort(),isRead?45000:60000);
    const fetchStarted=latency&&typeof performance!=="undefined"?performance.now():0;
    try{
      const response=await fetch(url,{...opts,signal:controller.signal});
      if(latency){latency.status=response.status;latency.serverTiming=response.headers.get("Server-Timing")||"";latency.contentLength=Number(response.headers.get("Content-Length"))||null}
      return response;
    }finally{
      if(latency&&fetchStarted)latency.fetchMs+=performance.now()-fetchStarted;
      clearTimeout(timeout);if(externalSignal)externalSignal.removeEventListener("abort",abortFromCaller);
    }
  }
  let res;
  try{res=await attempt();}
  catch(error){
    if(externalSignal&&externalSignal.aborted)throw error;
    if(!isRead)throw new Error(error?.name==="AbortError"?"Request timed out. Check the record before retrying to avoid duplicates.":"No connection. Check connectivity and verify whether the change was saved.");
    await new Promise(resolve=>setTimeout(resolve,600));
    try{res=await attempt();}catch(retryError){if(externalSignal&&externalSignal.aborted)throw retryError;throw new Error("The server is unreachable or timed out. Retry the page once connectivity returns.");}
  }
  if(isRead&&[502,503,504].includes(res.status)){
    await new Promise(resolve=>setTimeout(resolve,600));
    try{res=await attempt();}catch(error){if(externalSignal&&externalSignal.aborted)throw error;throw new Error("The server did not respond. Please retry.");}
  }
  // Expired-on-arrival token: retry once with a fresh one before signing out (401 happens before any write runs).
  if(res.status===401){
    const fresh=await clerkToken(true);
    if(fresh){
      opts.headers["Authorization"]="Bearer "+fresh;
      try{res=await attempt();}catch(error){if(externalSignal&&externalSignal.aborted)throw error;throw new Error(isRead?"The server did not respond. Please retry.":"No connection. Check connectivity and verify whether the change was saved.");}
    }
  }
  if(res.status===401){
    try{await window.Clerk?.signOut();}catch(e){}
    showClerkSignIn();
    throw new Error("Authentication required");
  }
  const data=res.status===204?null:await res.json().catch(()=>({}));
  if(!res.ok){
    const err=new Error(s91ApiErrorMessage(res.status,data));err.status=res.status;err.data=data;throw err;
  }
  return data;
}

