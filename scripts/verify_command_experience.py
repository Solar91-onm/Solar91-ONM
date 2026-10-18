import sys
from playwright.sync_api import sync_playwright
from pathlib import Path
base=Path(__file__).resolve().parents[1]/'frontend/static'
with sync_playwright() as p:
 args=['--no-sandbox'] if sys.platform.startswith('linux') else []
 browser=p.chromium.launch(headless=True,args=args)
 page=browser.new_page(viewport={'width':1280,'height':850})
 errors=[];page.on('pageerror',lambda x:errors.append(str(x)))
 page.set_content('<div id="app"><div class="shell"><div class="content"></div></div></div>')
 page.add_style_tag(path=str(base/'css/33-command-intelligence.css'))
 page.add_script_tag(content='let S={};')
 page.evaluate('''() => {
  S={_roleLabel:'O&M Head', view:'dashboard', issF:{plant:'all'}, dashPlant:'all', plants:[{id:'SP-01',dbId:'p1',name:'Bhadla'}], issues:[
   {id:'ISS-1',plant:'Bhadla',status:'Open',severity:'Critical',etc:'2026-10-05'},
   {id:'ISS-2',plant:'Bhadla',status:'In Progress',severity:'Medium',etc:'2026-10-08'},
   {id:'ISS-3',plant:'Bhadla',status:'Closed',severity:'Low',etc:'2026-10-09'}],
   tasks:[{id:'PM-1',plant:'Bhadla',status:'Scheduled',due:'2026-10-01',type:'Inverter'},
   {id:'PM-2',plant:'Bhadla',status:'Completed',due:'2026-10-08',type:'Inverter'}],
   equipment:[{id:'EQ-1',plant_id:'p1',equipment_code:'INV-01',equipment_name:'Inverter 1',equipment_type:'Inverter',status:'Active'}],
   inventory:[{id:'ST-1',plant:'Bhadla',item:'bearing-stock-unique',qty:4}],
   _washCycles:{plants:[{plant_id:'p1',plant:'Bhadla',overdue_days:3,overdue_bucket:'3d',pending_tables_cleaned:2}],reports:[{plant_id:'p1',review_status:'Pending'},{plant_id:'p1',review_status:'Pending'}]},
   tablePages:{},pmLive:{},_washUi:{q:'',show:'all'}
  };
  window.blankIssF=(x)=>Object.assign({plant:'all',chip:'all',sev:'all'},x||{});
  window.taskOD=t=>t.id==='PM-1'?8:0;
  window.isOverdueIssue=t=>t.id==='ISS-1';
  window.renderDashboard=()=>'<div id="old-dashboard">Original dashboard preserved</div>';
  window.renderModal=()=>'';
  window.goTab=tab=>{S.view='om-module';S.omTab=tab;document.querySelector('.content').innerHTML='<div id="section-results">Issue rows</div><div class="pml-register">PM rows</div>'};
  window.goScheduledOM=tab=>{S.view='om-module';S.omTab=tab==='washing'?'washing':'scheduled';document.querySelector('.content').innerHTML='<div id="wc-register">Washing rows</div><div class="pml-register">PM rows</div>'};
  window.washOpenRegister=()=>goScheduledOM('washing');
  window.reportRowsForHub=kind=>({title:'Report '+kind,cols:['Metric','Value'],rows:[['Open issues',2],['Overdue PM',1]]});
  window.goView=page=>{S.view=page;document.querySelector('.content').innerHTML='<div class="ops-report-table">Full report</div>'};
  window.TODAY='2026-10-10';
  // This is a frontend smoke test: the API contract itself is exercised by pytest.
  // The assistant now requires an authenticated identity and reads answers from its API.
  window.AUTH_IDENTITY={userId:'browser-smoke-user'};
  window.apiFetch=async (path,options={})=>{
   if(path!=='/api/field/ask')throw new Error('Unexpected browser smoke API request: '+path);
   const question=JSON.parse(options.body||'{}').question||'';
   if(/pm|preventive|maintenance|task/i.test(question))return {answer:'1 overdue preventive tasks found',records:[],summary:{label:'Overdue preventive tasks',value:1},breakdown:[],source:'Smoke fixture'};
   if(/bearing-stock-unique/i.test(question))return {answer:'No matching records were found.',records:[],summary:null,breakdown:[],source:'Smoke fixture'};
   if(/inverter|inv-01/i.test(question))return {answer:'Found 3 matching records',records:[{module:'equipment',id:'EQ-1',title:'INV-01 · Inverter 1',plant:'Bhadla',site_code:'SP-01',status:'Active'}],summary:null,breakdown:[],source:'Smoke fixture'};
   return {answer:'2 open tickets, including 1 critical',records:[],summary:{label:'Open issues',value:2},breakdown:[],source:'Smoke fixture'};
  };
 }''')
 page.add_script_tag(path=str(base/'js/33-command-intelligence.js'))
 assert page.evaluate("typeof window.S")=='undefined'
 assert page.locator('.s91-assistant-launch').count()==1
 page.evaluate('window.S=S')
 page.add_script_tag(path=str(base/'js/32-operations-experience.js'))
 page.evaluate('''() => document.querySelector('.content').innerHTML=renderDashboard()''')
 assert page.locator('.s91-queue-tile').count()==6
 assert '2' in page.locator('.s91-queue-tile.tone-gold').inner_text()
 page.get_by_role('button',name='Critical faults: 1. Open register').click()
 assert page.evaluate('S.issF.queue')=='critical'
 assert page.locator('#section-results').count()==1
 page.evaluate('''() => {S.view='dashboard';document.querySelector('.content').innerHTML=renderDashboard()}''')
 page.get_by_role('button',name='PM overdue: 1. Open register').click()
 assert page.evaluate('S.pmLive.status')=='Overdue'
 assert page.locator('.pml-register').count()==1
 page.evaluate('''() => {S.view='dashboard';document.querySelector('.content').innerHTML=renderDashboard()}''')
 page.get_by_role('button',name='Reports to review: 2. Open register').click()
 assert page.evaluate('S._washUi.show')=='review'
 page.evaluate('''() => {S.view='dashboard';document.querySelector('.content').innerHTML=renderDashboard()}''')
 page.get_by_role('button',name='Operational report').click()
 assert page.locator('.s91-report-sheet').count()==1
 page.get_by_role('button',name='7 days').click()
 assert 'weekly' in page.locator('.s91-report-summary').inner_text()
 page.locator('[data-s91-close-report]').last.click()
 page.locator('.s91-assistant-launch').click()
 page.locator('[data-s91-question="Overdue PM tasks"]').click()
 page.wait_for_function("document.querySelector('.s91-assistant-conversation')?.innerText.includes('1 overdue preventive tasks found')")
 assert '1 overdue preventive tasks found' in page.locator('.s91-assistant-conversation').inner_text()
 page.locator('#s91-assistant-query').fill('critical tickets')
 page.get_by_role('button',name='Search',exact=True).click()
 page.wait_for_function("document.querySelector('.s91-assistant-conversation')?.innerText.includes('2 open tickets, including 1 critical')")
 assert '2 open tickets, including 1 critical' in page.locator('.s91-assistant-conversation').inner_text()
 page.locator('#s91-assistant-query').fill('inverter at Bhadla')
 page.get_by_role('button',name='Search',exact=True).click()
 page.wait_for_function("document.querySelector('.s91-assistant-conversation')?.innerText.includes('Found 3 matching records')")
 assert 'Found 3 matching records' in page.locator('.s91-assistant-conversation').inner_text()
 assert 'INV-01' in page.locator('.s91-assistant-conversation').inner_text()
 page.evaluate("S._roleLabel='Assignee';window.s91AssistantOpen()")
 assert page.locator('.s91-assistant-launch').count()==1
 page.locator('#s91-assistant-query').fill('INV-01')
 page.get_by_role('button',name='Search',exact=True).click()
 assert 'INV-01' in page.locator('.s91-assistant-conversation').inner_text()
 page.evaluate("S._roleLabel='Administration'")
 page.locator('#s91-assistant-query').fill('critical tickets')
 page.get_by_role('button',name='Search',exact=True).click()
 assert '2 open tickets, including 1 critical' in page.locator('.s91-assistant-conversation').inner_text()
 page.locator('#s91-assistant-query').fill('bearing-stock-unique')
 page.get_by_role('button',name='Search',exact=True).click()
 assert 'No matching records' in page.locator('.s91-assistant-conversation').inner_text()
 page.evaluate("S._roleLabel='Site Engineer';window.s91AssistantOpen()")
 assert page.locator('.s91-assistant-launch').count()==1
 assert not errors,errors
 print('PASS Chrome desktop: dashboard queues -> filtered registers, report layer tabs, read-only assistant, no runtime errors')
 page.evaluate("S._roleLabel='Assignee';window.s91AssistantOpen()")
 page.set_viewport_size({'width':390,'height':844})
 assert page.locator('.s91-assistant-panel').is_visible()
 assert page.locator('.s91-assistant-panel').bounding_box()['width']<=390
 print('PASS Chrome mobile: assistant fits viewport')
 browser.close()
