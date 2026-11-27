"""Chromium rendering with a controlled 150 ms summary API delay.
No production services or secrets; timing is diagnostic, request counts are the gate.
"""
from pathlib import Path
import pytest
from tests.test_site_issue_responsibility_dialog import chromium

ROOT = Path(__file__).resolve().parents[1]


def setup_board(browser, width, size):
    page = browser.new_page(viewport={'width': width, 'height': 900})
    page.set_content('<main id="host"></main>')
    for css in ('tokens.css', 'washing-board.css', 'mobile-density.css'):
        page.add_style_tag(path=str(ROOT / 'assets/css' / css))
    page.evaluate('''size => {
      window.reads=0; window.failNext=false;
      window.Solar91PortalAPI={currentUser:()=>({id:'owner',role:'O&M Head'}),can:()=>true,
        request:async url=>{
          if(!url.startsWith('/api/scheduled/washing/overview?'))throw Error(url);
          reads++; await new Promise(r=>setTimeout(r,150));
          if(failNext){failNext=false;throw Error('Simulated read failure');}
          return {month:new URL(url, 'https://test.invalid').searchParams.get('month'),today:'2026-11-27',
            plants:Array.from({length:size},(_,i)=>({plant:'Plant '+i,site_code:'G'+String(i).padStart(3,'0'),plant_id:String(i),table_count:500,current_cycle:1,monthly_target:3,monthly_compliance_percent:20,confirmed_tables_cleaned:100,overdue_bucket:'on_track'})),summary:{}};
        }};
    }''',size)
    for js in ('format.js','table-sort.js','table-column-filter.js','extra-cleaning.js','data-adapter.js','washing-board.js'):
        page.add_script_tag(path=str(ROOT / 'assets/js' / js))
    return page


def open_board(page, explicit=False):
    return page.evaluate('''async explicit=>{
      const start=performance.now();
      await Solar91PortalWashingBoard.show(document.querySelector('#host'),explicit?'2026-11':undefined);
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      return Math.round(performance.now()-start);
    }''',explicit)


@pytest.mark.parametrize('size,width',[(42,390),(72,390),(72,1600)])
def test_cleaning_navigation_reuses_summary_and_invalidates(chromium,size,width):
    page=setup_board(chromium,width,size)
    try:
        cold=open_board(page)
        assert page.locator('[data-wb-plant]').count()==size
        warm=[open_board(page) for _ in range(3)]
        assert page.evaluate('reads')==1
        assert page.locator('[data-wb-plant]').count()==size
        page.evaluate('Solar91PortalData.invalidate(true)')
        open_board(page)
        assert page.evaluate('reads')==2
        open_board(page,True)
        assert page.evaluate('reads')==3
        page.evaluate('Solar91PortalData.invalidate(); failNext=true')
        open_board(page)
        assert page.get_by_text('Simulated read failure',exact=False).is_visible()
        open_board(page)
        assert page.evaluate('reads')==5
        assert page.locator('[data-wb-plant]').count()==size
        print(f'NAV {size} plants {width}px cold={cold}ms warm={warm}ms')
    finally:
        page.close()
