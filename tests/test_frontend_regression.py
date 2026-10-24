"""Issue-trend hang regression runs the real source function in a Node VM."""
from pathlib import Path
import subprocess
import textwrap

ROOT=Path(__file__).resolve().parents[1]

def test_trend_extreme_dates_are_bounded_and_validated():
    script=textwrap.dedent(r'''
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const s=fs.readFileSync('frontend/static/js/00-auth-data-and-imports.js','utf8');
      function source(name){const start=s.indexOf('function '+name+'(');assert(start>=0,name);
        let i=s.indexOf('{',start),depth=0;
        for(let j=i;j<s.length;j++){if(s[j]==='{')depth++;else if(s[j]==='}'&&--depth===0)return s.slice(start,j+1)}
        throw Error('no function body: '+name);
      }
      const sandbox={Date,Map,Number,Math,String,Array,Set,console,TODAY:'2026-10-13',S:{issues:[]},
        addDays:(iso,n)=>{const x=new Date(iso+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)},
        dayDiff:(a,b)=>(new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000,
        issueCreatedDay:t=>t.created?String(t.created).slice(0,10):null,
        issueClosedDay:t=>t.closed?String(t.closed).slice(0,10):null};
      vm.createContext(sandbox);
      vm.runInContext(source('s91ValidDate')+'\n'+source('issueTrendRows'),sandbox);
      assert(!sandbox.s91ValidDate('2026-02-31'));
      assert(!sandbox.s91ValidDate('0002-10-12'));
      assert(sandbox.s91ValidDate('2028-02-29'));
      assert.strictEqual(sandbox.issueTrendRows(10,[],'0002-10-12','2026-10-13').length,10);
      assert.strictEqual(sandbox.issueTrendRows(999999,[],'2000-01-01','2100-01-01').length,366);
      assert.strictEqual(sandbox.issueTrendRows(Infinity,[]).length,14);
      const issues=[{created:'2026-10-11',closed:'2026-10-12'},{created:'2026-10-13'}];
      const rows=sandbox.issueTrendRows(3,issues,'2026-10-11','2026-10-13');
      assert.deepStrictEqual(Array.from(rows,r=>[r.o,r.c,r.open]),[[1,0,1],[0,1,0],[1,0,1]]);
      console.log('valid calendar dates, 366-day cap, backlog counts, no runaway loops');
    ''')
    run=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True,timeout=10)
    assert run.returncode==0,run.stderr

def test_no_stale_render_markers_or_debug_overlays():
    guard=(ROOT/'frontend/static/js/00-loop-guard.js').read_text()
    assert 'document.cookie' not in guard
    assert 'document.body.appendChild(b)' not in guard
    assert 'window.MutationObserver=' not in guard
    assert 'window.s91Diagnose' in guard

def test_superseded_equipment_read_can_be_aborted_without_retry():
    script=textwrap.dedent(r'''
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const s=fs.readFileSync('frontend/static/js/00-auth-data-and-imports.js','utf8');
      const start=s.indexOf('async function apiFetch(');assert(start>=0);
      let i=s.indexOf('{',start),depth=0,end=-1;
      for(let j=i;j<s.length;j++){if(s[j]==='{')depth++;else if(s[j]==='}'&&--depth===0){end=j+1;break}}
      assert(end>0);
      let calls=0,started;
      const requestStarted=new Promise(resolve=>{started=resolve});
      const sandbox={AbortController,FormData,clearTimeout,setTimeout,clerkToken:async()=>null,
        fetch:(_url,options)=>{calls++;started();return new Promise((_resolve,reject)=>{
          options.signal.addEventListener('abort',()=>{const error=new Error('aborted');error.name='AbortError';reject(error)},{once:true});
        })}};
      vm.createContext(sandbox);vm.runInContext(s.slice(start,end),sandbox);
      const controller=new AbortController();
      const request=sandbox.apiFetch('/api/equipment/page',{signal:controller.signal});
      requestStarted.then(()=>controller.abort());
      request.then(()=>{throw Error('cancelled request unexpectedly succeeded')},error=>{
        assert.strictEqual(error.name,'AbortError');
        assert.strictEqual(calls,1,'a superseded read must not be retried');
      }).catch(error=>{console.error(error);process.exitCode=1});
    ''')
    run=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True,timeout=10)
    assert run.returncode==0,run.stderr

def test_opt_in_api_latency_sampler_records_safe_browser_and_server_timings():
    script=textwrap.dedent(r'''
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const s=fs.readFileSync('frontend/static/js/00-auth-data-and-imports.js','utf8');
      const start=s.indexOf('async function apiFetch(');assert(start>=0);
      let i=s.indexOf('{',start),depth=0,end=-1;
      for(let j=i;j<s.length;j++){if(s[j]==='{')depth++;else if(s[j]==='}'&&--depth===0){end=j+1;break}}
      assert(end>0);
      const monitor=s.indexOf('// Opt-in browser sampling');
      const monitorEnd=s.indexOf('\nlet _syncTimer',monitor);
      assert(monitor>=0&&monitorEnd>monitor);
      let now=0;
      const sandbox={AbortController,FormData,URL,Map,Math,Number,String,Array,Promise,Set,location:{href:'https://solar91.example/'},
        performance:{now:()=>++now},window:{},clerkToken:async()=>null,clearTimeout,setTimeout,
        fetch:async()=>({status:200,ok:true,headers:{get:name=>name==='Server-Timing'?'app;dur=4, db;dur=2;desc="1 queries", total;dur=6':name==='Content-Length'?'256':null},json:async()=>({ok:true})})};
      vm.createContext(sandbox);
      vm.runInContext(s.slice(start,end)+'\n'+s.slice(monitor,monitorEnd),sandbox);
      (async()=>{
        sandbox.window.Solar91Latency.enable();
        await sandbox.apiFetch('/api/issues/SECRET-RECORD?access_token=SECRET');
        const report=sandbox.window.Solar91Latency.report();
        assert.strictEqual(report.sample_count,1);
        assert.strictEqual(report.groups[0].route,'GET /api/issues');
        assert.strictEqual(report.groups[0].server_db_ms.p50,2);
        assert.strictEqual(report.groups[0].content_length_bytes.p50,256);
        assert(!JSON.stringify(report).includes('SECRET'));
      })().catch(error=>{console.error(error);process.exitCode=1});
    ''')
    run=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True,timeout=10)
    assert run.returncode==0,run.stderr

def test_equipment_register_aborts_superseded_page_request():
    script=textwrap.dedent(r'''
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const s=fs.readFileSync('frontend/static/js/20-modern-ui-2026.js','utf8');
      const start=s.indexOf('async function m26EqLoadPage(');assert(start>=0);
      let i=s.indexOf('{',start),depth=0,end=-1;
      for(let j=i;j<s.length;j++){if(s[j]==='{')depth++;else if(s[j]==='}'&&--depth===0){end=j+1;break}}
      assert(end>0);
      const requests=[];
      const sandbox={AbortController,M26R:{page:1,loading:false,items:[],total:0},S:{view:'equipment'},
        m26EqPersist:()=>{},m26EqQuery:()=>({toString:()=>''}),render:()=>{},toast:()=>{},
        apiFetch:(_url,{signal})=>new Promise((resolve,reject)=>{
          requests.push({signal,resolve});
          signal.addEventListener('abort',()=>{const error=new Error('aborted');error.name='AbortError';reject(error)},{once:true});
        })};
      vm.createContext(sandbox);vm.runInContext('let m26EqLoadController=null;\n'+s.slice(start,end),sandbox);
      (async()=>{
        const oldRequest=sandbox.m26EqLoadPage(false);
        const latestRequest=sandbox.m26EqLoadPage(false);
        assert.strictEqual(requests.length,2);
        assert.strictEqual(requests[0].signal.aborted,true);
        requests[1].resolve({items:[{id:'latest'}],total:1});
        await Promise.all([oldRequest,latestRequest]);
        assert.deepStrictEqual(Array.from(sandbox.M26R.items,item=>item.id),['latest']);
        assert.strictEqual(sandbox.M26R.loading,false);
      })().catch(error=>{console.error(error);process.exitCode=1});
    ''')
    run=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True,timeout=10)
    assert run.returncode==0,run.stderr

def test_plant_list_aggregates_issue_stats_once_per_issue_and_preserves_filters():
    script=textwrap.dedent(r'''
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const s=fs.readFileSync('frontend/static/js/00-auth-data-and-imports.js','utf8');
      const start=s.indexOf('function plantListRows(');assert(start>=0);
      let i=s.indexOf('{',start),depth=0,end=-1;
      for(let j=i;j<s.length;j++){if(s[j]==='{')depth++;else if(s[j]==='}'&&--depth===0){end=j+1;break}}
      assert(end>0);
      const plants=[{id:'A',name:'Plant A'},{id:'B',name:'Plant B'}];
      const issues=[
        {plant:'Plant A',status:'Open',maker:'Brand A'},
        {plant:'Plant A',status:'In Progress',maker:'Brand B'},
        {plant:'Plant A',status:'Resolved',maker:'Brand B'},
        {plant:'Plant B',status:'Open',maker:'Brand A'}
      ];
      let visits=0;
      const originalForEach=issues.forEach;
      issues.forEach=function(fn){return originalForEach.call(this,(...args)=>{visits++;fn(...args)})};
      const sandbox={S:{issues,plF:{sort:'issues'}},XL_BY:{},XL_LAST:'',Object,Array,Map,Set,Math,String,
        xlPlantMtd:()=>null,plantEngineer:()=>'',plantProject:()=>'',plantCapMw:()=>null,plantHealth:()=>'Healthy'};
      vm.createContext(sandbox);vm.runInContext(s.slice(start,end),sandbox);
      assert.deepStrictEqual(Array.from(sandbox.plantListRows(plants),p=>p.id),['A','B']);
      assert.strictEqual(visits,issues.length,'issue statistics should require one pass per list render');
      sandbox.S.plF={sort:'name',maker:'Brand B'};
      assert.deepStrictEqual(Array.from(sandbox.plantListRows(plants),p=>p.id),['A']);
      assert.strictEqual(visits,issues.length*2);
    ''')
    run=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True,timeout=10)
    assert run.returncode==0,run.stderr

def test_weekly_export_aggregates_operational_rows_in_single_pass():
    script=textwrap.dedent(r'''
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const s=fs.readFileSync('frontend/static/js/08-actions-exports-and-submission.js','utf8');
      const start=s.indexOf('function reportRowsExport(');assert(start>=0);
      let i=s.indexOf('{',start),depth=0,end=-1;
      for(let j=i;j<s.length;j++){if(s[j]==='{')depth++;else if(s[j]==='}'&&--depth===0){end=j+1;break}}
      assert(end>0);
      let washingVisits=0,issueVisits=0,openCalls=0,pmCalls=0;
      const washing=[{plant:'A',age:2},{plant:'A',age:30},{plant:'B',age:4}];
      washing.forEach=((original)=>function(fn){return original.call(this,row=>{washingVisits++;fn(row)})})(washing.forEach);
      const issues=[{plant:'A',severity:'Critical'},{plant:'B',severity:'Low'},{plant:'A',severity:'Critical'}];
      issues.forEach=((original)=>function(fn){return original.call(this,row=>{issueVisits++;fn(row)})})(issues.forEach);
      const plants=[{name:'A'},{name:'B'},{name:'C'}];
      const sandbox={S:{plants,washing,washMeta:{A:{freq:14},B:{freq:14}},issues},Map,Array,
        openTk:rows=>{openCalls++;return rows},isCriticalIssue:x=>x.severity==='Critical',
        daysSince:x=>x.age,pmOnTimePct:()=>{pmCalls++;return 90},
        washCompliancePct:()=>80,XL_LAST:'today',xlNA:x=>x==null?'N/A':x};
      vm.createContext(sandbox);vm.runInContext(s.slice(start,end),sandbox);
      const rows=sandbox.reportRowsExport('weekly');
      const report=Array.from(rows,row=>Array.from(row));
      assert.deepStrictEqual(report.slice(2,5),[
        ['A',50,2,90,2],['B',100,1,90,0],['C',100,0,90,0]
      ]);
      assert.strictEqual(washingVisits,washing.length,'washing history should be visited once');
      assert.strictEqual(issueVisits,issues.length,'open issues should be visited once');
      assert.strictEqual(openCalls,1,'open issue filtering should run once');
      assert.strictEqual(pmCalls,1,'shared PM percentage should be calculated once');
    ''')
    run=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True,timeout=10)
    assert run.returncode==0,run.stderr

def test_plant_code_normalization_and_embedded_seed_codes_are_canonical():
      script=textwrap.dedent(r'''
        const fs=require('fs'),vm=require('vm'),assert=require('assert');
        const source=fs.readFileSync('frontend/static/js/00-auth-data-and-imports.js','utf8');
        function sourceFunction(name){const start=source.indexOf('function '+name+'(');assert(start>=0,name);
          let i=source.indexOf('{',start),depth=0;
          for(let j=i;j<source.length;j++){if(source[j]==='{')depth++;else if(source[j]==='}'&&--depth===0)return source.slice(start,j+1)}
          throw Error('no function body: '+name)}
        const sandbox={String,Array};
        vm.createContext(sandbox);
        vm.runInContext('const PLANT_MATCH_KEY="id";const PLANT_CODE_ALIASES={"KHO01":"KH001"};'+
          sourceFunction('normalizeSiteCode')+sourceFunction('plantIndexByCode')+
          sourceFunction('resolvePlantByCode'),sandbox);
        for(const [input,expected] of [['abh_01','ABH01'],['KRN_01','KRN01'],
          ['KH0_01','KH001'],['KHO01','KH001'],['ABO01','ABO01'],['AB001','AB001']])
          assert.strictEqual(sandbox.normalizeSiteCode(input),expected);
        const plants=[{id:'KH001'},{id:'ABO01'},{id:'AB001'}];
        const index=sandbox.plantIndexByCode(plants);
        assert.strictEqual(sandbox.resolvePlantByCode('KHO01',index).id,'KH001');
        assert.notStrictEqual(sandbox.resolvePlantByCode('ABO01',index).id,
          sandbox.resolvePlantByCode('AB001',index).id);
        const codes=Array.from(source.matchAll(/"siteCode"\s*:\s*"([^"]+)"/g),match=>match[1]);
        assert(codes.length>0,'embedded plant seeds should be present');
        assert(codes.every(code=>code===sandbox.normalizeSiteCode(code)),
          'all embedded siteCode seed values should already be canonical');
        const legacy=JSON.parse(fs.readFileSync('scripts/legacy_plants.json','utf8'));
        assert(legacy.every(plant=>plant.siteCode===sandbox.normalizeSiteCode(plant.siteCode)));
      ''')
      run=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True,timeout=10)
      assert run.returncode==0,run.stderr

def test_expired_token_401_is_retried_once_with_a_fresh_token_before_sign_out():
    script=textwrap.dedent(r'''
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const s=fs.readFileSync('frontend/static/js/00-auth-data-and-imports.js','utf8');
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

def test_pm_command_stylesheet_loads_last_and_pm_page_parses():
    index=(ROOT/'frontend/templates/index.html').read_text(encoding='utf-8')
    assert '/static/css/46-pm-command.css' in index
    assert index.index('/static/css/46-pm-command.css')>index.index('/static/css/45-command-center.css')
    js=(ROOT/'frontend/static/js/29-pm-live-dashboard.js').read_text(encoding='utf-8')
    # group assignment goes through the existing per-task API so role, equipment scope and audit stay server-side
    assert '"/api/scheduled/tasks/"+encodeURIComponent(task.id)+"/assignee"' in js
    run=subprocess.run(['node','--check','frontend/static/js/29-pm-live-dashboard.js'],cwd=ROOT,capture_output=True,text=True,timeout=10)
    assert run.returncode==0,run.stderr
