"""Browser checks for incoming task popups, with stubbed authenticated APIs."""
from pathlib import Path
import pytest
from tests.test_site_issue_responsibility_dialog import chromium

ROOT = Path(__file__).resolve().parents[1]

@pytest.mark.parametrize('width',[390,1600])
def test_personal_alerts_ring_without_extra_poll_and_open_ticket(chromium,width):
    page=chromium.new_page(viewport={'width':width,'height':844})
    try:
        errors=[]; page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_content('''<div data-notification-centre><button data-notification-toggle><svg width="24" height="24"></svg><span data-notification-count hidden></span></button><div data-notification-panel hidden></div></div>''')
        page.add_style_tag(path=str(ROOT/'assets/css/notifications.css'))
        page.evaluate('''() => {
          window.calls=[]; window.opened=[];
          const item=(id, title, priority='normal',category='issue')=>({id,title,priority,category,event_type:'issue_created',message:'CCTV · Plant 01',target_type:'issue',target_id:'CCTV-1',created_at:new Date().toISOString(),read:false});
          window.summary={unread_count:1,personal_alerts:true,actions:[],recent_unread:[item('n1','Ticket assigned to you')]};
          window.Solar91PortalAPI={request:(url,options)=>{calls.push([url,options||null]);if(url.includes('/summary'))return Promise.resolve(summary);if(url.endsWith('/read'))return Promise.resolve({unread_count:0});if(url.includes('?limit='))return Promise.resolve({notifications:summary.recent_unread,unread_count:summary.unread_count});return Promise.reject(new Error(url));}};
          window.Solar91PortalNav={selectView:(name)=>opened.push(name)};
          window.Solar91PortalIssues={openTicket:(id,site,mode)=>opened.push([id,site,mode])};
          window.makeItem=item;
        }''')
        page.add_script_tag(path=str(ROOT/'assets/js/notifications.js'))
        page.evaluate('Solar91PortalNotifications.init()')
        popup=page.locator('.ep-notification-alert')
        popup.wait_for(timeout=5000)
        assert popup.get_by_text('Ticket assigned to you').is_visible()
        assert page.locator('[data-notification-toggle]').evaluate("el=>el.classList.contains('is-ringing')")
        box=popup.bounding_box(); assert box['y']<100 and box['x']>=0 and box['x']+box['width']<=width+1
        assert page.evaluate('calls.map(x=>x[0])')==['/api/notifications/summary?preview=true']
        page.evaluate('Solar91PortalNotifications.refresh()')
        page.wait_for_function('calls.length===2')
        assert popup.count()==1
        # Count stays at one: an older message was read on another device as a new one arrived.
        page.evaluate("summary.recent_unread=[makeItem('n2','New message')];Solar91PortalNotifications.refresh()")
        page.get_by_text('New message',exact=True).wait_for(timeout=5000)
        assert popup.count()==2
        popup.filter(has_text='New message').get_by_role('button',name='View details').click()
        page.wait_for_function('opened.length===2')
        assert page.evaluate('opened')==['health',['CCTV-1','','details']]
        assert page.evaluate("calls.some(x=>x[0]==='/api/notifications/n2/read')")
        assert not errors, errors
    finally:
        page.close()


@pytest.mark.parametrize('width', [320, 390, 1600])
def test_speech_bubble_icons_and_touch_targets(chromium, width):
    page = chromium.new_page(viewport={'width': width, 'height': 844}, reduced_motion='reduce')
    try:
        page.set_content('<div data-notification-centre><button data-notification-toggle><svg width="24" height="24"></svg><span data-notification-count hidden></span></button><div data-notification-panel hidden></div></div>')
        for css in ('tokens.css', 'notifications.css'):
            page.add_style_tag(path=str(ROOT / 'assets/css' / css))
        page.add_script_tag(path=str(ROOT / 'assets/js/notifications.js'))
        page.evaluate('window.runs = 0')
        page.evaluate('''() => ['issue', 'pm', 'washing'].forEach(category => Solar91PortalToast.show({
            key:category, title: 'New task for your plant', message: 'LongEquipmentName'.repeat(12),
            notification: true, category, label: 'Action required', tone: 'notification',
            action: {label:'View details', run:()=>runs++}
        }))''')
        bubbles = page.locator('.ep-notification-alert')
        assert bubbles.count() == 3
        for kind in ('issue', 'pm', 'washing'):
            bubble = page.locator(f'[data-alert-kind="{kind}"]')
            assert bubble.locator('svg').count() == 1
            assert bubble.evaluate("el=>getComputedStyle(el).animationName") == 'none'
            assert bubble.evaluate("el=>getComputedStyle(el,'::before').clipPath") != 'none'
            box = bubble.bounding_box()
            assert box['x'] >= 0 and box['x'] + box['width'] + 13 <= width
            for name in ('View details', 'Dismiss'):
                btn = bubble.get_by_role('button', name=name)
                bounds = btn.bounding_box()
                assert bounds['x'] >= box['x'] and bounds['x'] + bounds['width'] <= box['x'] + box['width']
                if width <= 600:
                    assert bounds['height'] >= 44 and bounds['width'] >= 44
        bubbles.first.get_by_role('button', name='Dismiss').click()
        page.wait_for_function("document.querySelectorAll('.ep-notification-alert').length===2")
        assert page.evaluate('runs') == 0
        page.evaluate("Solar91PortalToast.show({key:'urgent', notification:true, category:'issue', tone:'critical', title:'Critical issue', label:'Critical'})")
        critical = page.locator('[data-alert-kind="critical"]')
        assert critical.is_visible()
        assert critical.get_attribute('role') == 'alert'
        assert critical.evaluate("el=>getComputedStyle(el).getPropertyValue('--bubble-ink').trim()") == '#a32724'
        page.locator('[data-alert-kind="pm"]').get_by_role('button', name='View details').click()
        assert page.evaluate('runs') == 1
    finally:
        page.close()


@pytest.mark.parametrize('width', [320, 390, 1600])
def test_translucent_notification_palette_contrast(chromium, width):
    page = chromium.new_page(viewport={'width': width, 'height': 844}, reduced_motion='reduce')
    try:
        page.set_content('<main></main>')
        page.add_style_tag(path=str(ROOT / 'assets/css/tokens.css'))
        page.add_style_tag(path=str(ROOT / 'assets/css/notifications.css'))
        page.add_script_tag(path=str(ROOT / 'assets/js/notifications.js'))
        page.evaluate('''() => {
          window.checkColors = el => {
            const luminance = value => {
              const rgb = value.map(n => {
                const v = n/255; return v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4;
              });
              return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
            };
            const contrast = (a,b) => {
              const x=luminance(a), y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
            };
            const parse = value => value.match(/[\\d.]+/g).map(Number);
            const style = getComputedStyle(el);
            const gradient = style.backgroundImage;
            const stops = [...gradient.matchAll(/rgba?\\(([^)]+)\\)/g)].map(m=>parse(m[1]));
            const elements=['.ep-alert-label','.ep-toast__title','.ep-toast__text','.ep-toast__close'];
            const ratios=[];
            // Composite each translucent endpoint over black and white (worst-case bounds).
            for(const stop of stops) for(const backdrop of [0,255]) {
              const alpha=stop[3]??1;
              const bg=stop.slice(0,3).map(n=>n*alpha+backdrop*(1-alpha));
              for(const sel of elements) ratios.push(contrast(parse(getComputedStyle(el.querySelector(sel)).color).slice(0,3),bg));
            }
            const btn=getComputedStyle(el.querySelector('.ep-toast__view'));
            ratios.push(contrast(parse(btn.color).slice(0,3),parse(btn.backgroundColor).slice(0,3)));
            return {ink:style.getPropertyValue('--bubble-ink').trim(), ratios, gradient, stops, bg:style.backgroundColor};
          };
        }''')
        for category, tone, kind, color in [
            ('issue','notification','issue','#185b41'),
            ('pm','alert','pm','#214b80'),
            ('washing','notification','washing','#87530c'),
            ('general','alert','general','#65427f'),
            ('issue','critical','critical','#a32724'),
        ]:
            page.evaluate('''([category,tone,kind])=>Solar91PortalToast.show({key:kind,title:'New task',message:'Review this activity',notification:true,category,tone,label:'Action required',action:{label:'View details',run:()=>{}}})''',[category,tone,kind])
            bubble=page.locator(f'[data-alert-kind="{kind}"]')
            page.mouse.move(0, 0)
            colors=bubble.evaluate('el=>checkColors(el)')
            assert colors['ink']==color
            assert colors['bg']=='rgba(0, 0, 0, 0)'
            assert colors['gradient'].startswith('linear-gradient(')
            assert len(colors['stops']) == 2
            assert all(.85 <= stop[3] < 1 for stop in colors['stops'])
            assert min(colors['ratios']) >= 4.5, colors
            close=bubble.get_by_role('button',name='Dismiss')
            close.hover()
            assert close.evaluate("el=>getComputedStyle(el).backgroundColor") != 'rgba(0, 0, 0, 0)'
            close.click()
            bubble.wait_for(state='detached')
    finally:
        page.close()
