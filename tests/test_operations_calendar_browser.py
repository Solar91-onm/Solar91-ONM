"""Offline browser-level interaction smoke test: no live Clerk, Supabase, or remote navigation.

Runs when Playwright and Chromium are installed; otherwise the browser-only test
is skipped and the API/permission tests remain mandatory.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('width', [1365, 390])
def test_calendar_floating_details_and_day_summary_in_real_browser(width):
    pw = pytest.importorskip('playwright.sync_api')
    browser_path = shutil.which('chromium') or shutil.which('google-chrome')
    with pw.sync_playwright() as runner:
        kwargs = {'headless': True}
        if browser_path:
            kwargs['executable_path'] = browser_path
            kwargs['args'] = ['--no-sandbox']
        try:
            browser = runner.chromium.launch(**kwargs)
        except Exception as error:
            pytest.skip(f'Chromium not installed for offline browser test: {error}')
        try:
            page = browser.new_page(viewport={'width': width, 'height': 800})
            errors = []
            page.on('pageerror', lambda exc: errors.append(str(exc)))
            page.set_content('<!doctype html><html><body><main id="fixture"></main></body></html>')
            page.add_style_tag(path=str(ROOT / 'frontend/static/css/55-operations-calendar.css'))
            page.add_script_tag(content=r'''
                window.S={view:'om-module',omTab:'calendar',dashPlant:'all',plants:[],currentRole:'O&M Head'};
                window.s91BusinessDate=()=> '2026-10-29';
                const plant='00000000-0000-0000-0000-000000000001';
                const entry=(kind,id,tone)=>({kind,id,key:kind+':'+id,date:'2026-10-29',plant_id:plant,
                    plant:'Alpha Solar Park',site_code:'ALPHA',title:kind==='issue'?'Inverter':kind==='pm'?'Inverter service':'Panel washing',
                    equipment:'Inverter',subpart:'DC Input',status:tone==='done'?'Resolved':'Open',severity:'Critical',tone,reference:kind.toUpperCase()+'-'+id});
                const rows=[entry('issue','one','critical'),entry('issue','two','done'),
                    entry('pm','three','scheduled'),entry('washing','four','washing'),entry('issue','five','medium')];
                window.apiFetch=async url=>url.startsWith('/api/operations-calendar?')?{events:rows,has_more:false}
                    :({...rows.find(e=>url.includes('/'+e.kind+'/'+e.id)),description:'Inverter voltage issue',
                        remarks:'Actual inspection note',reporter:'Engineer',can_edit:true,
                        evidence:[{name:'before',url:'/api/issues/one/evidence/1'}]});
                const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),c=>c.charCodeAt(0));
                window.authenticatedFetch=async()=>new Response(new Blob([png],{type:'image/png'}));
                window.opened=0;window.open=()=>{window.opened++;return null};
                window.render=()=>{document.getElementById('fixture').innerHTML=renderOperationsCalendar()};
                window.goTab=()=>{};window.toast=()=>{};
            ''')
            page.add_script_tag(path=str(ROOT / 'frontend/static/js/50-operations-calendar.js'))
            page.evaluate('render()')
            page.locator('.oc-event').first.wait_for(state='attached')
            assert page.locator('.oc-weekday').count() == 7
            assert page.locator('.oc-more').count() == 1
            assert page.locator('.oc-event.oc-done').count() == 1  # green resolved issue shown
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')  # no sideways page scroll
            if width <= 800:
                # Phone month grid fits the screen with coloured dots; a day tap opens its summary sheet.
                assert page.locator('.oc-dots').first.is_visible()
                assert not page.locator('.oc-cell .oc-event').first.is_visible()
                page.locator('[data-oc-day="2026-10-29"]').click()
                page.locator('.oc-summary-row [data-oc-event="issue:one"]').click()
            else:
                page.locator('[data-oc-event="issue:one"]').click()
            page.get_by_text('Inverter voltage issue').wait_for()
            assert page.locator('.oc-pop').count() == 1
            assert page.locator('.oc').count() == 1  # calendar remains behind floating popup
            if width <= 800:
                assert page.locator('.oc-pop').evaluate('(el)=>getComputedStyle(el).bottom') != 'auto'
                assert page.locator('.oc-scrim').is_visible()
            # Evidence opens inside the popup, not as a blocked new window.
            page.locator('[data-oc-photo]').click()
            page.locator('.oc-photo-view img').wait_for()
            assert page.evaluate('window.opened') == 0
            page.keyboard.press('Escape')
            assert page.locator('.oc-pop').count() == 0
            assert page.locator('.oc-scrim').count() == 0
            page.locator('[data-oc-summary="2026-10-29"]').first.click()
            assert page.locator('.oc-summary-row').count() == 5
            page.locator('.oc-summary-row [data-oc-event="issue:two"]').click()
            page.get_by_text('Inverter voltage issue').wait_for()
            assert page.locator('.oc-pop').count() == 1
            page.keyboard.press('Escape')
            page.locator('[data-oc-summary="2026-10-29"]').first.click()
            page.get_by_role('button', name='View all activities').click()
            assert page.locator('.oc-day-view .oc-event').count() == 5
            page.locator('[data-oc-view="week"]').click()
            assert page.locator('.oc-week .oc-cell').count() == 7
            page.locator('[data-oc="toggleFilters"]').click()
            assert page.locator('[data-oc-filter]').count() == 9
            assert not errors, errors
        finally:
            browser.close()
