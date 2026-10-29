"""Presentation regressions: issue hierarchy, assignment, SLA, and PM scanability."""
from pathlib import Path
import subprocess
import textwrap

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'frontend/static/js/22-site-issues-redesign.js'
STYLE = ROOT / 'frontend/static/css/53-simple-issues-pm.css'


def test_issue_register_column_order_and_safe_status():
    src = SRC.read_text(encoding='utf-8')
    headers = ['Issue ID', 'Equipment', 'Subpart', 'Subpart / unit ID', 'Problem',
               'Plant code', 'Supplier / maker', 'Assigned to', 'Status', 'Action']
    positions = [src.index(f'>{heading}</th>', src.index('si-register dense')) for heading in headers]
    assert positions == sorted(positions)
    assert 'const company=t.supplier||t.maker||""' in src
    assert 'const done=t.status==="Closed"||t.status==="Resolved"' in src
    assert 'sla==="breach"?"Overdue"' in src
    assert 'issueQuickActs(t)' in src  # Existing action rail remains, not replaced with a new workflow.
    assert 'grouped=S.siGroup===true' in src # Uncomplicated flat list initially, optional grouping.
    assert 'colspan="10"' in src
    assert 'class="si-r click\'+cls+(S.flashId' in src
    styles = STYLE.read_text(encoding='utf-8')
    assert '.si-status-overdue' in styles and '.si-status-complete' in styles
    assert 'th.cc-cbcell{width:38px' in styles
    assert 'tr.si-r.od td' in styles # Old whole-red row rule neutralized.


def test_issue_row_display_and_status_render_with_real_js_function():
    script = textwrap.dedent(r'''
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const source=fs.readFileSync('frontend/static/js/22-site-issues-redesign.js','utf8');
      const block=source.slice(source.indexOf(' function siRow(t,cls){'),source.indexOf('\n const MIXC='));
      const stubs={
        S:{flashId:null}, PRI:{Critical:'#be3026',Medium:'#bb8900'},
        plantRec:()=>({id:'PL-0001',name:'Test Solar Plant'}),
        slaState:t=>t.status==='Resolved'?'ok':'breach', issueLevel:t=>t.severity,
        siUnitCodes:t=>[t[0].equip],ccIni:s=>s.slice(0,2).toUpperCase(),
        issueQuickActs:t=>'<button data-act="issue" data-id="'+t.id+'">View</button>',
        esc:x=>String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')
      };
      vm.createContext(stubs);vm.runInContext(block,stubs);
      let issue={id:'ISS-1001',plant:'Test Solar Plant',vertical:'Inverter',sub:'Cooling fan',
        equip:'INV-008',desc:'Fan stopped working',supplier:'Supplier Co',maker:'Maker Co',
        status:'In Progress',assignee:'Ravi Kumar',severity:'Critical'};
      let html=stubs.siRow(issue,'');
      for(const v of ['ISS-1001','Inverter','Cooling fan','INV-008','Fan stopped working','PL-0001','Supplier Co','Ravi Kumar','Overdue'])
        assert(html.includes(v),v);
      assert(!html.includes(' class="si-r click od"'));
      assert.equal((html.match(/<td\b/g)||[]).length,10,'one aligned cell per issue header');
      assert(html.indexOf('ISS-1001')<html.indexOf('Inverter'));
      assert(html.indexOf('Inverter')<html.indexOf('Cooling fan'));
      assert(html.indexOf('Cooling fan')<html.indexOf('INV-008'));
      assert(html.indexOf('INV-008')<html.indexOf('Fan stopped working'));
      assert(html.indexOf('Fan stopped working')<html.indexOf('PL-0001'));
      issue={...issue,status:'Resolved',supplier:null,assignee:null};
      html=stubs.siRow(issue,'');
      assert(html.includes('si-status-complete')&&html.includes('Completed'));
      assert(html.includes('Maker Co')&&html.includes('Unassigned'));
      console.log('10 centered cells, ordered ticket fields, maker fallback, SLA badges passed');
    ''')
    run = subprocess.run(['node', '-e', script], cwd=ROOT, text=True, capture_output=True, timeout=12)
    assert run.returncode == 0, run.stderr


def test_pm_keeps_existing_actions_and_css_only_layout_change():
    src = (ROOT / 'frontend/static/js/29-pm-live-dashboard.js').read_text(encoding='utf-8')
    assert 'data-pmc-assign' in src and 'data-pml-group' in src
    assert 'data-pml-select="plant"' in src
    style = STYLE.read_text(encoding='utf-8')
    assert '.pml-consolidated-table th' in style
    assert '.pmd-table th' in style
    assert '.pml-badge.overdue::before' in style
    assert 'tr.pmc-late td' in style
    assert '@media(max-width:760px)' in style
    html = (ROOT / 'frontend/templates/index.html').read_text(encoding='utf-8')
    assert html.index('51-mobile-pwa.css') < html.index('53-simple-issues-pm.css') < html.index('48-laptop-fit.css')
    run = subprocess.run(['node', '--check', str(SRC)], text=True, capture_output=True, timeout=12)
    assert run.returncode == 0, run.stderr
