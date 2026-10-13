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
