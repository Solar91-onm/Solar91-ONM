"""UI-only regression test for the aggregate PM register; no Supabase credentials required."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
JS=ROOT/'frontend/static/js/29-pm-live-dashboard.js'
CSS=ROOT/'frontend/static/css/pm-live-dashboard.css'
with sync_playwright() as p:
 args=['--no-sandbox'] if sys.platform.startswith('linux') else []
 browser=p.chromium.launch(headless=True,args=args)
 page=browser.new_page(viewport={'width':1350,'height':900})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content('<div class="content"><div id="area"></div></div>')
 page.add_style_tag(path=str(CSS))
 page.evaluate('''() => {
 window.TODAY='2026-10-10';
 window.S={view:'om-module',omTab:'scheduled',_roleLabel:'O&M Head',plants:[{id:'SP-01',dbId:'uuid-1',name:'Bhadla'},{id:'SP-02',dbId:'uuid-2',name:'Jodhpur'}],tasks:[],pmLive:{plant:'all',plantQuery:'',plantOpen:false,plantTab:'late',equipment:'all',week:'all',age:'all',status:'all',query:'',page:1,covCollapsed:false}};
 window.esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 window.pmDisplayTaskName=t=>String(t.name||'').replace(/\\s+—\\s+unit\\s+\\d+$/i,'');
 window.fmtD=s=>s;window.fmtDT=s=>s;
 window.addDays=(iso,d)=>{const x=new Date(iso+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+d);return x.toISOString().slice(0,10)};
 window.kpiTile=(label,value)=>'<div class="cc-kpi2">'+label+' '+value+'</div>';
 window.renderScheduled=()=>'<p>Legacy</p>';
 window.renderModal=()=>'';window.openModal=(kind,ctx)=>{window._opened={kind,ctx}};
 window.toast=()=>{};
 window.apiFetch=async uri=>{if(uri.includes('/unit-config'))return {configs:[{plant_id:'uuid-1',equipment_type:'Inverter',total_units:12,units_per_day:3},{plant_id:'uuid-2',equipment_type:'Transformer',total_units:2,units_per_day:1}],register:[]};return []};
 window.render=()=>document.getElementById('area').innerHTML=renderScheduled();
 for(let i=1;i<=12;i++){let done=i<=4;S.tasks.push({id:'TASK-'+i,plant:'Bhadla',type:'Inverter',name:'Thermography and torque check',unitNo:i,totalUnits:12,cycleId:'cycle-oct-2026',freq:'Monthly',status:done?'Completed':i<=6?'In Progress':'Scheduled',due:i<=6?'2026-10-08':'2026-10-13',assignee:'Ravi Meena'});}
 S.tasks.push({id:'TR-1',plant:'Jodhpur',type:'Transformer',name:'Oil level test',freq:'Quarterly',quantity:2,status:'Scheduled',due:'2026-10-15',assignee:'Anil Kumar'});
 }''')
 page.add_script_tag(path=str(JS))
 page.evaluate('render()')
 page.wait_for_function("document.querySelector('.pml-coverage-table')")
 assert page.locator('.pml-consolidated-table tbody tr').count()==2,page.locator('.pml-consolidated-table').inner_text()
 assert 'Inverter × 12' in page.locator('.pml-consolidated-table').inner_text()
 assert page.locator('.pml-picker-btn').count()==1
 assert page.locator('[data-pml-select="plant"] option').count()==3
 page.locator('[data-pml-select="plant"]').select_option(label='SP-01 · Bhadla')
 assert page.locator('.pml-consolidated-table tbody tr').count()==1
 assert page.locator('.pml-plant-focus').count()==1
 assert '12' in page.locator('.pml-focus-row').first.inner_text()
 page.locator('.pml-consolidated-table [data-pml-group]').last.click()
 assert page.locator('.pml-unit-drawer').count()==1
 assert '12' in page.locator('.pml-unit-metrics').inner_text()
 assert page.locator('.pml-daily-line').count()==3 # 3 distinct date+status buckets
 assert page.locator('.pml-task-row').count()==12
 page.locator('.pml-task-row button').first.click()
 assert page.evaluate('window._opened && window._opened.kind')=='taskDetail'
 assert page.locator('.pml-unit-drawer').count()==0
 page.set_viewport_size({'width':390,'height':844})
 page.evaluate('render()')
 assert page.locator('.pml-plant-focus').count()==1
 assert page.locator('[data-pml-select="plant"]').is_visible()
 page.evaluate('''() => {S.pmLive={plant:'Bhadla',status:'Overdue'};render()}''')
 assert page.locator('.pml-consolidated-table tbody tr').count()==1
 assert 'Inverter × 12' in page.locator('.pml-consolidated-table').inner_text()
 page.locator('.pml-consolidated-table [data-pml-group]').last.click()
 assert page.locator('.pml-task-row').count()==12
 assert not errors,errors
 print('PASS: portfolio/plant selection, one-row equipment grouping for 12 inverters, unit-level drawer, native task detail link, mobile layout, zero browser errors')
 browser.close()
