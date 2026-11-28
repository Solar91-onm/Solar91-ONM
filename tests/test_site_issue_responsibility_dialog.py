"""Browser checks for the header shortcut and its lazy, role-gated routing editor."""
from pathlib import Path
import shutil

import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LAUNCH = '[data-settings-action="open-issue-routing"]'
DIALOG = '[data-issue-routing-dialog]'
PLANT_PICKER = '[data-routing-picker="plant"]'
KEY_PICKER = '[data-routing-picker="key"]'


def pick(page, name, values):
    """Open a checklist, check each value, and close it again with an outside click."""
    picker = f'[data-routing-picker="{name}"]'
    page.locator(picker + " summary").click()
    for value in values:
        page.locator(f'{picker} [data-routing-{name}="{value}"]').check()
    page.locator("#settings-routing-title").click()
    assert page.locator(picker + "[open]").count() == 0


@pytest.fixture(scope="module")
def chromium():
    with sync_playwright() as playwright:
        bundled = Path(playwright.chromium.executable_path)
        executable = str(bundled) if bundled.is_file() else shutil.which("chromium")
        if not executable:
            pytest.skip("Chromium unavailable: run python -m playwright install chromium")
        browser = playwright.chromium.launch(executable_path=executable, args=["--no-sandbox"])
        yield browser
        browser.close()


def setup_page(browser, width, permitted):
    page = browser.new_page(viewport={"width": width, "height": 900})
    page.set_content('<main id="host"></main>')
    for css in ("tokens.css", "settings.css", "mobile-density.css"):
        page.add_style_tag(path=str(ROOT / "assets/css" / css))
    page.evaluate("""(permitted) => {
      window.Solar91PortalFormat={escape(v){return String(v == null ? '' : v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}};
      window.confirm=()=>true;
      window.requests=[];
      window.saves=[];
      let rules={};
      const plants=[{id:'p1',site_code:'LKT01',plant_name:'First Plant',active:true},{id:'p2',site_code:'CRI01',plant_name:'Second Plant',active:true}];
      window.Solar91PortalAPI={can:()=>permitted,request:(path,options)=>{
        requests.push(path);
        if(path==='/api/users')return Promise.resolve([]);
        if(path==='/api/photos/storage-usage')return Promise.resolve({configured:false});
        if(path==='/api/photos/retention')return Promise.resolve({days:30,min_days:1,max_days:365,min_purge_days:1,plants:[]});
        if(path==='/api/equipment-responsibilities?include_routing=false')return Promise.resolve({categories:[{key:'inverter',label:'Inverter',area:'Plant side',entries:[],primary:null,backup:null,status:'Not configured'},{key:'la',label:'LA',area:'Plant side',entries:[],primary:null,backup:null,status:'Not configured'}],holders:[{id:'a',name:'Primary',role:'Assignee'},{id:'b',name:'Backup',role:'Assignee'}]});
        if(path==='/api/equipment-responsibilities/issue-routing' && (!options || options.method!=='PUT'))return Promise.resolve({issue_routing:rules,plants});
        if(path==='/api/equipment-responsibilities/issue-routing') {
          const d=options.body; saves.push(d);
          for(const plant of (d.plant_ids.length?d.plant_ids:['*'])) for(const equipment of d.equipment_keys) {
            const key=plant+':'+equipment;
            if(d.primary_user_id||d.backup_user_id)rules[key]={primary_user_id:d.primary_user_id,backup_user_id:d.backup_user_id};else delete rules[key];
          }
          return Promise.resolve({rules,issues_auto_assigned:0});
        }
        return Promise.reject(new Error(path));
      }};
    }""", permitted)
    page.add_script_tag(path=str(ROOT / "assets/js/settings.js"))
    page.evaluate("Solar91PortalSettings.render(document.getElementById('host'))")
    return page


@pytest.mark.parametrize("width", [390, 1600])
def test_team_header_opens_lazy_routing_dialog(chromium, width):
    page = setup_page(chromium, width, True)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        button = page.locator(LAUNCH)
        button.wait_for()
        assert page.locator(DIALOG).count() == 0
        assert page.evaluate("requests.filter(p=>p.endsWith('/issue-routing')).length") == 0
        bounds = button.bounding_box()
        assert bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= width
        if width == 1600:
            assert bounds["x"] > width / 2
        button.click()
        page.locator(PLANT_PICKER + " summary").wait_for()
        assert page.locator(DIALOG + "[open]").count() == 1
        assert page.evaluate("requests.filter(p=>p.endsWith('/issue-routing')).length") == 1
        assert page.locator(".ep-settings__routing-body").evaluate("e=>e.scrollWidth<=e.clientWidth+1")
        pick(page, "plant",["p1", "p2"])
        assert page.locator(PLANT_PICKER + " summary").inner_text() == "2 plants: LKT01, CRI01"
        pick(page, "key",["inverter"])
        assert page.locator(KEY_PICKER + " summary").inner_text() == "Inverter"
        page.locator('[data-routing-field="primary"]').select_option("a")
        page.locator('[data-routing-field="backup"]').select_option("b")
        page.locator('[data-routing-field="applyExisting"]').check()
        page.locator('[data-settings-action="save-issue-routing"]').click()
        page.get_by_text("2 rules saved. 0 existing issues assigned.").wait_for()
        assert page.evaluate("saves[0]") == {
            "plant_ids": ["p1", "p2"], "equipment_keys": ["inverter"], "primary_user_id": "a",
            "backup_user_id": "b", "apply_existing": True,
        }
        page.keyboard.press("Escape")
        assert page.locator(DIALOG).count() == 0
        assert button.evaluate("e=>document.activeElement===e")
        button.click()
        page.locator(PLANT_PICKER + " summary").wait_for()
        assert page.locator('[data-routing-field="primary"]').input_value() == "a"
        assert page.evaluate("requests.filter(p=>p.endsWith('/issue-routing')).length") == 3  # 2 GETs, 1 PUT
        page.locator('[data-settings-action="view-portfolio-equipment"]').click()
        assert page.locator(DIALOG).count() == 0
        assert page.locator("#settings-equipment-title").evaluate("e=>document.activeElement===e")
        assert not errors
    finally:
        page.close()


def test_plants_and_equipment_are_multi_select(chromium):
    page = setup_page(chromium, 1600, True)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.locator(LAUNCH).click()
        page.locator(PLANT_PICKER + " summary").wait_for()
        save = page.locator('[data-settings-action="save-issue-routing"]')
        remove = page.locator('[data-settings-action="remove-issue-routing"]')
        assert save.is_disabled()

        # Search filters in place; the checklist stays open and keeps the typed text.
        page.locator(PLANT_PICKER + " summary").click()
        page.locator('[data-routing-search="plant"]').fill("cri")
        assert page.locator('[data-routing-plant="p1"]').is_hidden()
        assert page.locator('[data-routing-plant="p2"]').is_visible()
        assert page.locator('[data-routing-plant="*"]').is_visible()
        page.locator('[data-settings-action="routing-clear"][data-picker="plant"]').click()
        page.locator('[data-routing-search="plant"]').fill("")
        page.locator('[data-settings-action="routing-select-all"][data-picker="plant"]').click()
        assert page.locator(PLANT_PICKER + "[open]").count() == 1
        assert page.locator(PLANT_PICKER + ' [data-routing-plant]:checked').count() == 2
        page.keyboard.press("Escape")
        assert page.locator(PLANT_PICKER + "[open]").count() == 0
        assert page.locator(DIALOG + "[open]").count() == 1

        # A specific category replaces "All equipment"; both categories together.
        pick(page, "key",["inverter", "la"])
        assert not page.locator('[data-routing-key="*"]').is_checked()
        assert page.locator(KEY_PICKER + " summary").inner_text() == "2 equipment: Inverter, LA"
        page.get_by_text("4 rules will be saved (2 plants × 2 equipment).").wait_for()
        assert save.inner_text() == "Save 4 rules"
        page.locator('[data-routing-field="primary"]').select_option("a")
        save.click()
        page.get_by_text("4 rules saved. 0 existing issues assigned.").wait_for()
        assert page.evaluate("saves[0]") == {
            "plant_ids": ["p1", "p2"], "equipment_keys": ["inverter", "la"], "primary_user_id": "a",
            "backup_user_id": None, "apply_existing": False,
        }
        assert page.locator(".ep-issue-routing__item.is-selected").count() == 4
        assert remove.inner_text() == "Remove 4 rules"

        # "All equipment" is exclusive the other way too.
        page.locator(KEY_PICKER + " summary").click()
        page.locator('[data-routing-key="*"]').check()
        assert page.locator(KEY_PICKER + ' [data-routing-key]:checked').count() == 1
        page.locator('[data-routing-key="inverter"]').check()
        page.locator('[data-routing-key="la"]').check()
        page.locator("#settings-routing-title").click()

        remove.click()
        page.get_by_text("4 rules removed. 0 existing issues assigned.").wait_for()
        assert page.evaluate("saves[1]")["equipment_keys"] == ["inverter", "la"]
        assert page.evaluate("saves[1]")["primary_user_id"] is None
        assert page.evaluate("saves.length") == 2

        # The portfolio default clears the plants and fixes equipment to All.
        pick(page, "plant",["*"])
        assert page.locator(PLANT_PICKER + ' [data-routing-plant]:checked').count() == 1
        assert page.locator(KEY_PICKER).count() == 0
        assert page.locator(".ep-issue-routing__picker-button.is-disabled").inner_text() == "All equipment"
        page.locator('[data-routing-field="backup"]').select_option("b")
        save.click()
        page.get_by_text("Rule saved. 0 existing issues assigned.").wait_for()
        assert page.evaluate("saves[2]")["plant_ids"] == []
        assert page.evaluate("saves[2]")["equipment_keys"] == ["*"]
        assert not errors
    finally:
        page.close()


def test_team_header_hides_responsibility_from_non_manager(chromium):
    page = setup_page(chromium, 390, False)
    try:
        assert page.locator(LAUNCH).count() == 0
        assert page.locator('[data-settings-action="toggle-issue-routing"]').count() == 0
        assert page.locator(DIALOG).count() == 0
        assert page.evaluate("requests.length") == 0
    finally:
        page.close()
