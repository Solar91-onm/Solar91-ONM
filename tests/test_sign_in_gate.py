"""Sign-in gate regression tests.

The access panel was extracted unchanged from the previous frontend bundle into
``frontend/static/js/auth-gate.js`` when the portal redesign replaced the rest of
the UI. These tests pin the behaviour that must not drift: the single token
retry before sign-out, and readable API error messages.

Tests that asserted on the retired frontend bundle were removed with it; the new
frontend is covered by tests/test_portal_frontend.py.
"""
from __future__ import annotations

import subprocess
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_expired_token_401_is_retried_once_with_a_fresh_token_before_sign_out():
    script=textwrap.dedent(r'''
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const s=fs.readFileSync('frontend/static/js/auth-gate.js','utf8');
      const start=s.indexOf('async function apiFetch(');assert(start>=0);
      let i=s.indexOf('{',start),depth=0,end=-1;
      for(let j=i;j<s.length;j++){if(s[j]==='{')depth++;else if(s[j]==='}'&&--depth===0){end=j+1;break}}
      assert(end>0);
      const run=async statuses=>{
        const auth=[];let signedOut=0,signIn=0;
        const sandbox={AbortController,FormData,clearTimeout,setTimeout,
          clerkToken:async fresh=>fresh?'fresh':'stale',
          window:{Clerk:{signOut:async()=>{signedOut++}}},showClerkSignIn:()=>{signIn++},
          fetch:async(_url,o)=>{auth.push(o.headers.Authorization);const status=statuses[auth.length-1];
            return {status,ok:status<400,headers:{get:()=>null},json:async()=>({saved:true})}}};
        vm.createContext(sandbox);vm.runInContext(s.slice(start,end),sandbox);
        let result,error;
        try{result=await sandbox.apiFetch('/api/pm-plan/import',{method:'POST',body:{a:1}})}catch(e){error=e}
        return {auth,signedOut,signIn,result,error};
      };
      (async()=>{
        const ok=await run([401,200]);
        assert.deepStrictEqual(ok.auth,['Bearer stale','Bearer fresh']);
        assert.strictEqual(ok.signedOut,0);assert.strictEqual(ok.result.saved,true);
        const bad=await run([401,401]);
        assert.strictEqual(bad.auth.length,2,'only one retry');
        assert.strictEqual(bad.signedOut,1);assert.strictEqual(bad.signIn,1);
        assert.strictEqual(bad.error.message,'Authentication required');
      })().catch(error=>{console.error(error);process.exitCode=1});
    ''')
    run=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True,timeout=10)
    assert run.returncode==0,run.stderr


def test_api_errors_read_as_sentences_not_bare_http_codes():
    """FastAPI validation lists and proxy error pages must not reach people as "HTTP 422" / "HTTP 502"."""
    script=textwrap.dedent(r'''
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const s=fs.readFileSync('frontend/static/js/auth-gate.js','utf8');
      const a=s.indexOf('const S91_HTTP_MESSAGES='),b=s.indexOf('async function apiFetch(');
      assert(a>0&&b>a);
      const box={};vm.createContext(box);vm.runInContext(s.slice(a,b)+';this.msg=s91ApiErrorMessage',box);
      assert.strictEqual(box.msg(409,{detail:'Ticket is already closed'}),'Ticket is already closed');
      const v=box.msg(422,{error:'validation_error',detail:[{loc:['body','etc_at'],msg:'Input should be a valid datetime'},{loc:['body','severity'],msg:'Value error, severity must be Critical or Medium'}]});
      assert.strictEqual(v,'Please check: Etc at: Input should be a valid datetime; Severity: severity must be Critical or Medium');
      assert(!/HTTP/.test(box.msg(502,{})),'proxy error page');
      assert(/waking up/.test(box.msg(503,null)));
      assert.strictEqual(box.msg(400,{detail:{message:'Bad file'}}),'Bad file');
      assert(/HTTP 418/.test(box.msg(418,{})));
    ''')
    run=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True,timeout=10)
    assert run.returncode==0,run.stderr

