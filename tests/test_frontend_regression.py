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
      const sandbox={AbortController,FormData,clearTimeout,setTimeout,supabaseToken:async()=>null,
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
