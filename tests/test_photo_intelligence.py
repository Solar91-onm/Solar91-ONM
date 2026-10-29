"""O&M Photo Intelligence demo: filter logic, demo submissions, PWA files and navigation wiring."""
import json
import re
import subprocess
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVICE = "frontend/static/js/46-photo-service.js"


def run_node(body: str) -> None:
    script = textwrap.dedent(r'''
      const fs=require('fs'),vm=require('vm'),assert=require('assert');
      const ctx={console,setTimeout,Promise,Date,Math,JSON,Map,Set,Array,Object,String,Number};ctx.globalThis=ctx;
      vm.createContext(ctx);vm.runInContext(fs.readFileSync('%s','utf8'),ctx);
      const L=ctx.S91PhotoLogic,DAY=864e5,NOW=Date.parse('2026-10-28T12:00:00Z');
      const rec=(id,ageDays,o)=>Object.assign({id,plant:'Plant A',category:'washing',uploader:'U1',status:'processed',issue:null,
        description:'Module rows after washing',tags:['washing'],equipmentId:'Block A',uploadedAt:new Date(NOW-ageDays*DAY).toISOString()},o||{});
      (async()=>{
    ''' % SERVICE) + textwrap.dedent(body) + "\n})().catch(e=>{console.error(e);process.exitCode=1});"
    run = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=20)
    assert run.returncode == 0, run.stderr or run.stdout


def test_date_windows_and_30_day_retention():
    run_node(r'''
      const rows=[rec('h1',0.5),rec('d3',3),rec('d10',10),rec('d29',29),rec('d31',31),rec('d39',39)];
      const ids=q=>Array.from(L.filterPhotos(rows,q,NOW),r=>r.id);
      assert.deepStrictEqual(ids({}),['h1','d3','d10','d29'],'default view = last 30 days, newest first');
      assert.deepStrictEqual(ids({window:'7d'}),['h1','d3']);
      assert.deepStrictEqual(ids({window:'24h'}),['h1']);
      assert.deepStrictEqual(ids({window:'bogus'}),['h1','d3','d10','d29'],'an unknown window falls back to 30 days');
      assert.deepStrictEqual(ids({sort:'oldest'}),['d29','d10','d3','h1']);
      assert.ok(!ids({}).includes('d31')&&!ids({}).includes('d39'),'records past retention never show');
    ''')


def test_category_uploader_status_issue_and_search_filters():
    run_node(r'''
      const rows=[
        rec('a',1,{category:'pm',uploader:'U2',status:'queued',description:'Inverter filter cleaned',tags:['pm','inspection'],equipmentId:'INV-03'}),
        rec('b',2,{category:'issue',issue:{id:'ISS-9',status:'Open'},description:'String fuse blown',tags:['fault'],equipmentId:'SCB-04'}),
        rec('c',3,{category:'washing',plant:'Plant B'})
      ];
      const ids=q=>Array.from(L.filterPhotos(rows,q,NOW),r=>r.id);
      assert.deepStrictEqual(ids({category:'pm'}),['a']);
      assert.deepStrictEqual(ids({uploader:'U2'}),['a']);
      assert.deepStrictEqual(ids({status:'queued'}),['a']);
      assert.deepStrictEqual(ids({issue:'linked'}),['b']);
      assert.deepStrictEqual(ids({issue:'unlinked'}),['a','c']);
      assert.deepStrictEqual(ids({issue:'ISS-9'}),['b']);
      assert.deepStrictEqual(ids({plant:'Plant B'}),['c']);
      assert.deepStrictEqual(ids({q:'inv-03'}),['a'],'search covers the equipment identifier');
      assert.deepStrictEqual(ids({q:'fault'}),['b'],'search covers tags');
      assert.deepStrictEqual(ids({q:'fuse blown'}),['b'],'every word must match the description, tags or equipment');
      assert.deepStrictEqual(ids({q:'nothing-like-this'}),[],'no match gives an empty result');
      assert.deepStrictEqual(ids(Object.assign({},L.DEFAULT_QUERY)),['a','b','c'],'reset query shows everything in 30 days');
      const s=L.summarize(L.filterPhotos(rows,{},NOW),NOW);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(s)),{inWindow:3,today:0,awaiting:1,unlinked:2});
    ''')


def test_file_validation_limits():
    run_node(r'''
      const f=(name,type,size)=>({name,type,size});
      const v=L.validateFiles([f('a.jpg','image/jpeg',1000),f('b.pdf','application/pdf',1000),f('c.png','image/png',0),
        f('d.webp','image/webp',16*1024*1024),f('e.HEIC','',2000)],0);
      assert.deepStrictEqual(Array.from(v.accepted,x=>x.name),['a.jpg']);
      assert.deepStrictEqual(Array.from(v.rejected,x=>x.name),['b.pdf','c.png','d.webp','e.HEIC']);
      const many=Array.from({length:4},(_,i)=>f('p'+i+'.jpg','image/jpeg',10));
      const capped=L.validateFiles(many,L.MAX_FILES-2);
      assert.strictEqual(capped.accepted.length,2,'at most MAX_FILES per submission');
      assert.strictEqual(capped.rejected.length,2);
      assert.deepStrictEqual(Array.from(L.cleanTags(['Remark','#After','remark',' follow up ','x$y'])),['remark','after','follow-up','xy']);
    ''')


def test_demo_adapter_lists_pages_scopes_and_takes_session_submissions():
    run_node(r'''
      let plants=[];
      const svc=L.createDemoAdapter({getPlants:()=>plants,now:()=>NOW,delay:()=>Promise.resolve()});
      const p0=await svc.getPlants();
      assert.strictEqual(p0.length,50,'no catalogue yet: 50 clearly labelled demo plants');
      assert.ok(p0.every(p=>p.demo&&/\(demo\)$/.test(p.name)));
      plants=['Alpha Solar','Beta Solar'];
      const p1=await svc.getPlants();
      assert.deepStrictEqual(Array.from(p1,p=>p.name),plants,'the real plant catalogue is reused when loaded');
      const all=await svc.listPhotos({limit:24});
      assert.ok(all.total>24&&all.items.length===24,'results are paged');
      assert.ok(all.items.every(r=>NOW-Date.parse(r.uploadedAt)<=30*DAY),'the default list keeps to 30 days');
      assert.ok(all.items.every(r=>r.demo===true),'every record is marked as demo');
      const scoped=await svc.listPhotos({limit:500},{plants:['Beta Solar']});
      assert.ok(scoped.total>0&&scoped.items.every(r=>r.plant==='Beta Solar'),'a plant-scoped viewer sees only that plant');
      const progress=[];
      const res=await svc.createSubmission({files:[{name:'x.jpg',size:10,type:'image/jpeg',previewUrl:'blob:one'},{name:'y.jpg',size:10,type:'image/jpeg',previewUrl:'blob:two'}],
        plant:'Alpha Solar',category:'issue',description:'  Water ingress in JB  ',tags:['remark','Urgent'],issue:{id:'ISS-7',status:'Open'},uploader:'Tester (you)'},p=>progress.push(p));
      assert.strictEqual(res.persisted,false,'demo submissions are never reported as stored');
      assert.strictEqual(progress[progress.length-1],100);
      const top=await svc.listPhotos({limit:2});
      assert.deepStrictEqual(Array.from(top.items,r=>r.source),['session','session'],'new demo photos appear first in the gallery');
      assert.strictEqual(top.sessionCount,2);
      const one=top.items[0];
      assert.strictEqual(one.description,'Water ingress in JB');
      assert.deepStrictEqual(Array.from(one.tags),['remark','urgent']);
      assert.strictEqual(one.issue.id,'ISS-7');
      assert.strictEqual(one.status,'queued');
      const linked=await svc.listPhotos({issue:'ISS-7'});
      assert.strictEqual(linked.total,2,'photos linked to an issue are found by that issue');
      const detail=await svc.getPhotoDetails(one.id);
      assert.strictEqual(detail.previewUrl,one.previewUrl);
      const st=await svc.getProcessingStatus(one.id);
      assert.strictEqual(st.label,'Awaiting processing');
      await assert.rejects(svc.createSubmission({files:[],plant:'Alpha Solar',category:'pm'}),/at least one photo/);
      await assert.rejects(svc.createSubmission({files:[{name:'z'}],plant:'',category:'pm'}),/plant/);
      await assert.rejects(svc.createSubmission({files:[{name:'z'}],plant:'Alpha Solar',category:'nope'}),/category/);
      assert.deepStrictEqual(Array.from(svc.clearSession()).sort(),['blob:one','blob:two'],'clearing hands back the preview URLs to revoke');
      assert.strictEqual((await svc.listPhotos({})).sessionCount,0);
    ''')


def test_pwa_manifest_shortcut_and_service_worker_cache_nothing_private():
    manifest = json.loads((ROOT / "frontend/static/pwa/manifest.webmanifest").read_text(encoding="utf-8"))
    assert manifest["start_url"] == "/" and manifest["scope"] == "/" and manifest["display"] == "standalone"
    assert "Photo Intelligence" in manifest["name"]
    for icon in manifest["icons"] + [i for s in manifest["shortcuts"] for i in s["icons"]]:
        assert (ROOT / "frontend" / icon["src"].lstrip("/")).is_file(), icon["src"]
    shortcut = manifest["shortcuts"][0]
    assert shortcut["url"] == "/#/photos"
    sw = (ROOT / "frontend/static/pwa/sw.js").read_text(encoding="utf-8")
    # the worker only answers failed page navigations with an offline page: no Cache API, no API or photo responses kept
    assert "caches." not in sw and "cache.put" not in sw.lower()
    assert "request.mode === 'navigate'" in sw


def test_page_assets_routes_and_role_navigation_are_wired():
    page = (ROOT / "frontend/templates/index.html").read_text(encoding="utf-8")
    assert page.index("/static/js/46-photo-service.js") < page.index("/static/js/47-photo-intelligence.js")
    assert "/static/css/50-photo-intelligence.css" in page
    js = lambda name: (ROOT / "frontend/static/js" / name).read_text(encoding="utf-8")
    assert '"photos"' in js("01-state-and-init.js")
    assert 'S.view==="photos")return "/photos"' in js("21-washing-portfolio.js")
    assert 'link("photos","Photo Intelligence"' in js("02-core-render-and-dashboard.js")
    for name in ("17-site-engineer-access-lock.js", "19-production-identity-and-domain-bridge.js"):
        assert len(re.findall(r"Photo Intelligence", js(name))) >= 4, name
    assert 'txt==="Photos"' in js("18-role-and-maintenance-upgrades.js")
    for name in ("46-photo-service.js", "47-photo-intelligence.js"):
        source = js(name)
        assert "service_role" not in source.lower() and "supabase" not in source.lower(), "no storage keys or direct storage calls in the page"
        # demo photos are never stored in the browser: the only browser storage is the Grid / List preference
        assert "indexedDB" not in source, "demo photos must not be stored in the browser"
        uses = re.findall(r"localStorage\.(?:get|set)Item\(([^,)]*)", source)
        assert all(key.strip() == '"s91-photo-layout"' for key in uses), uses
        run = subprocess.run(["node", "--check", f"frontend/static/js/{name}"], cwd=ROOT, capture_output=True, text=True, timeout=10)
        assert run.returncode == 0, run.stderr


def test_photo_quality_check_flags_dark_and_flat_photos_but_not_detailed_ones():
    run_node(r'''
      const W=120,H=90,img=f=>{const g=new Uint8ClampedArray(W*H);for(let y=0;y<H;y++)for(let x=0;x<W;x++)g[y*W+x]=f(x,y);return g};
      const dark=L.measureGray(img(()=>20),W,H),flat=L.measureGray(img(()=>170),W,H);
      const detail=L.measureGray(img((x,y)=>((x>>2)+(y>>2))%2?220:60),W,H);
      const smooth=L.measureGray(img(x=>80+x),W,H);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(L.qualityFlags(dark))),{dark:true,blurry:false},'a dark photo is reported as dark only');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(L.qualityFlags(flat))),{dark:false,blurry:true},'no detail at all may be blurry');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(L.qualityFlags(smooth))),{dark:false,blurry:true},'a soft gradient has no sharp edges');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(L.qualityFlags(detail))),{dark:false,blurry:false},'a detailed, bright photo passes');
      assert.ok(detail.sharpness>L.QUALITY.blurBelow*10);
    ''')


def test_portal_is_ready_to_install_on_phones():
    page = (ROOT / "frontend/templates/index.html").read_text(encoding="utf-8")
    assert "viewport-fit=cover" in page, "safe areas need the full-screen viewport"
    for tag in ('name="apple-mobile-web-app-capable" content="yes"', 'name="apple-mobile-web-app-title"',
                'name="mobile-web-app-capable" content="yes"', 'rel="apple-touch-icon"', 'rel="manifest"'):
        assert tag in page, tag
    assert page.index("/static/js/47-photo-intelligence.js") < page.index("/static/js/48-mobile-pwa.js")
    assert page.index("/static/css/51-mobile-pwa.css") < page.index("/static/css/48-laptop-fit.css") < page.index("/static/css/52-navigation-and-mobile.css"), "responsive navigation styles load last"
    sw = (ROOT / "frontend/static/pwa/sw.js").read_text(encoding="utf-8")
    assert "notificationclick" in sw and "caches." not in sw
    pwa = (ROOT / "frontend/static/js/48-mobile-pwa.js").read_text(encoding="utf-8")
    assert '"/health/version"' in pwa and 'meta[name="s91-build"]' in pwa, "update prompt compares the deployed build"
    assert "showNotification" in pwa and "requestPermission" in pwa and "getUserMedia" in pwa
    live = (ROOT / "frontend/static/js/34-live-refresh.js").read_text(encoding="utf-8")
    assert "requestPermission" not in live, "notifications are switched on from App & permissions, never on a stray click"
    css = (ROOT / "frontend/static/css/51-mobile-pwa.css").read_text(encoding="utf-8")
    assert "safe-area-inset-bottom" in css and "html.s91-ios #app select" in css
    run = subprocess.run(["node", "--check", "frontend/static/js/48-mobile-pwa.js"], cwd=ROOT, capture_output=True, text=True, timeout=10)
    assert run.returncode == 0, run.stderr


def test_gallery_volume_day_counts_and_attachable_files():
    run_node(r'''
      const names=Array.from({length:41},(_,i)=>'Plant '+i);
      const svc=L.createDemoAdapter({getPlants:()=>names,now:()=>NOW,delay:()=>Promise.resolve()});
      const all=await svc.listPhotos({limit:60});
      const perDay=all.total/30;
      assert.ok(perDay>=150&&perDay<=220,'demo volume is about 150–200 photos a day for 41 plants, got '+perDay.toFixed(0));
      assert.strictEqual(all.items.length,60,'the gallery loads 60 at a time');
      const days=Object.keys(all.days);
      assert.ok(days.length>=29&&days.length<=31,'photos are counted per calendar day');
      assert.strictEqual(Object.values(all.days).reduce((a,b)=>a+b,0),all.total,'day counts add up to the total');
      assert.strictEqual(all.days[L.dayKey(all.items[0].uploadedAt)]>0,true);
      const one=L.createDemoAdapter({getPlants:()=>['Only Plant'],now:()=>NOW,delay:()=>Promise.resolve()});
      const mine=await one.listPhotos({});
      assert.ok(mine.total>=100&&mine.total<=160,'one plant gets about 4 photos a day, not the whole fleet volume');
      const file={name:'x.png',size:10,type:'image/png'};
      const sub=await svc.createSubmission({files:[{name:'x.png',size:10,type:'image/png',previewUrl:'blob:x',file}],plant:'Plant 1',category:'pm'},()=>{});
      assert.strictEqual(await svc.getPhotoFile(sub.records[0].id),file,'a photo added in this tab hands back its file for attaching');
      assert.strictEqual(await svc.getPhotoFile(all.items.find(r=>r.source==='sample').id),null,'sample photos have no file to attach');
    ''')
