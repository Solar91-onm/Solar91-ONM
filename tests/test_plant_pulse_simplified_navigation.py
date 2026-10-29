"""Regression tests for the reduced navigation and plant-scoped dashboard handoffs."""
from pathlib import Path
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def test_navigation_markup_and_pwa_manifest():
    core = (ROOT / 'frontend/static/js/02-core-render-and-dashboard.js').read_text(encoding='utf-8')
    pulse = (ROOT / 'frontend/static/js/42-plant-pulse.js').read_text(encoding='utf-8')
    html = (ROOT / 'frontend/templates/index.html').read_text(encoding='utf-8')
    manifest = json.loads((ROOT / 'frontend/static/pwa/manifest.webmanifest').read_text(encoding='utf-8'))
    assert 'S.view==="dashboard"?renderPlantsDashboard()' in core
    assert 'sub("table","Plants table")+sub("dashboard","Plants dashboard")' in core
    assert 's91SidePlantFilter()+' in core
    assert 'data-pp aria-label="Select plant by name or plant code"' in core
    assert 'link("issues","Site Issues"' not in core
    assert 'link("scheduled","Preventive Maintenance"' not in core
    assert 'link("dashboard","Command Center"' not in core
    assert 'PM on schedule' in pulse and 'Washing compliance' in pulse and 'Site issues resolved' in pulse
    assert '/static/css/52-navigation-and-mobile.css' in html
    assert '/static/css/45-command-center.css' not in html
    assert 'Command Center' not in manifest['name']
    for name in ('02-core-render-and-dashboard.js','42-plant-pulse.js','17-site-engineer-access-lock.js','18-role-and-maintenance-upgrades.js','19-production-identity-and-domain-bridge.js'):
        check = subprocess.run(['node','--check',str(ROOT/'frontend/static/js'/name)],capture_output=True,text=True,timeout=12)
        assert check.returncode == 0, check.stderr


def test_pulse_cards_keep_exact_plant_scope_and_open_full_modules():
    script = r"""
    const fs=require('fs'),vm=require('vm'),assert=require('assert');
    const root='frontend/static/js/';
    const S={plants:[{id:'A01',dbId:'uuid-a',name:'Plant A'},{id:'B02',dbId:'uuid-b',name:'Plant B'}],
      tasks:[{plant:'Plant A',status:'Scheduled',due:'2026-11-10',type:'Inverter'}],issues:[],
      dashPlant:'Plant A',plPulse:{plant:'Plant A',eq:'all',eng:'all',area:'all'},
      issF:{plant:'all'},tablePages:{plants:1,issues:1,scheduled:1,washing:1},_roleLabel:'O&M Head',currentRole:'O&M Head',
      currentUser:'Tester',_washCycles:{plants:[],unconfigured:[]},schedF:{},washF:{}};
    const visits=[],issueFilters=[];
    const window={};
    const document={addEventListener:()=>{},activeElement:null};
    const sandbox={window,document,S,TODAY:'2026-10-29',OM_HEAD:'Tester',
      requestAnimationFrame:()=>{},addEventListener:()=>{},
      esc:s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'),
      displayCode:s=>s,I:{dash:()=>'',sun:()=>'',ftext:()=>'',clipc:()=>'',gauge:()=>''},
      persist:()=>{},render:()=>{},toast:()=>{},
      openTk:rows=>rows,isOverdueIssue:()=>false,taskOD:()=>0,dayDiff:()=>0,
      blankIssF:()=>({plant:'all',chip:'all',queue:'',bucket:'all'}),
      drillIssues:f=>issueFilters.push(f),
      goScheduledOM:part=>visits.push(part),
      dashScope:()=>S.plants.filter(p=>S.dashPlant==='all'||p.name===S.dashPlant),
      console,Date,Math,Set,Number,String,Array,Object};
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(root+'02-core-render-and-dashboard.js','utf8'),sandbox);
    // Top-level declaration overrides sandbox render; no DOM render needed for scope setter.
    vm.runInContext(fs.readFileSync(root+'42-plant-pulse.js','utf8'),sandbox);
    window.s91PulseGo('pm');
    assert.equal(visits.pop(),'maintenance');
    assert.equal(S.pmLive.plant,'Plant A');
    assert.equal(S.pmLive.status,'all','PM on schedule must open the full PM register');
    window.s91PulseGo('issues');
    assert.equal(issueFilters.pop().plant,'Plant A');
    assert.equal(S.plPulse.plant,'Plant A');
    window.s91PulseGo('wash');
    assert.equal(visits.pop(),'washing');
    assert.equal(S._washUi.plant,'uuid-a','Unconfigured plant must still remain selected');
    // A dashboard selection for All Plants must clear washing and PM filters.
    S.plPulse.plant='all';S.dashPlant='all';
    window.s91PulseGo('wash');
    assert.equal(S._washUi.plant,'all');
    window.s91PulseGo('pm');
    assert.equal(S.pmLive.plant,'all');
    const nav=sandbox.mobileNav({});
    assert(!nav.includes('Preventive')&&!nav.includes('Site Issues'));
    assert(nav.includes('Dashboard')&&nav.includes('Plants table'));
    const sidebar=sandbox.s91SidePlantFilter();
    assert(sidebar.includes('A01 · Plant A')&&sidebar.includes('B02 · Plant B'));
    assert(sidebar.includes('data-pp'));
    console.log('dashboard drill-down, all-plants and sidebar scope passed');
    """
    run=subprocess.run(['node','-e',script],cwd=ROOT,capture_output=True,text=True,timeout=15)
    assert run.returncode == 0, run.stderr
