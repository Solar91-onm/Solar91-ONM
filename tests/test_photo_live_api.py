"""Isolated database + fake private storage: real photo persistence, permissions and failure states."""
import io
import uuid
from datetime import date

import pytest
from fastapi import HTTPException
from PIL import Image

from app.core.models import Issue, OMTask, Plant, SitePhoto, UserPlantAssignment, WashingDailyReport, InventoryItem
from app.storage import service as storage_mod
from app.photos.router import _resolve_link
from tests.conftest import login_user


class StorageStub:
    objects = {}
    fail_after = 0
    def __init__(self): pass
    def upload(self, path, data, content_type):
        if self.fail_after and len(self.objects) >= self.fail_after:
            raise HTTPException(502, 'Storage unavailable')
        self.objects[path] = (data, content_type)
    def download(self, path):
        if path not in self.objects: raise HTTPException(404, 'Not found')
        return self.objects[path]
    def remove(self, paths):
        for path in paths: self.objects.pop(path, None)


@pytest.fixture(autouse=True)
def fake_storage(monkeypatch):
    StorageStub.objects = {}
    StorageStub.fail_after = 0
    monkeypatch.setattr('app.photos.router.SupabaseStorage', StorageStub)


def plant(db, name):
    x=Plant(site_code=name.replace(' ', '').upper(), plant_name=name)
    db.add(x); db.commit(); db.refresh(x); return x


def photo_file(name='pump.jpg'):
    image=Image.new('RGB',(100,80),'#168d47');out=io.BytesIO();image.save(out,format='JPEG');out.seek(0);return ('files',(name,out,'image/jpeg'))


def submit(client, p, *, kind='', ref='', category='issue', count=1):
    return client.post('/api/photos', data={'plant_id':str(p.id),'category':category,'tags':'["inspection"]',
             'description':'INV-03 cabinet after service', 'link_type':kind, 'link_id':ref},
             files=[photo_file('image-%s.jpg'%i) for i in range(count)])


def test_saved_photo_search_refresh_image_and_issue_link(client, db):
    login_user(client, db)
    p=plant(db, 'Plant Alpha'); other=plant(db, 'Plant Beta')
    issue=Issue(ticket_no='ISS-42',plant_id=p.id,description='Inverter stopped',severity='Major',status='Open')
    db.add(issue);db.commit()
    created=submit(client,p,kind='issue',ref='ISS-42',count=2)
    assert created.status_code == 201, created.text
    assert created.json()['persisted'] is True
    assert len(created.json()['records']) == 2
    assert db.query(SitePhoto).count()==2
    result=client.get('/api/photos',params={'q':'INV-03','issue':'ISS-42','plant':p.plant_name})
    assert result.status_code==200,result.text
    assert result.json()['total']==2
    row=result.json()['items'][0]
    assert row['linkType']=='issue' and row['linkId']=='ISS-42'
    assert row['plant']=='Plant Alpha' and not row['previewUrl']
    assert client.get(f"/api/photos/{row['id']}").json()['id']==row['id']
    image=client.get(f"/api/photos/{row['id']}/image")
    assert image.status_code==200 and image.content[:4]==b'RIFF' and image.content[8:12]==b'WEBP'
    assert image.headers['content-type']=='image/webp'
    assert image.headers['cache-control']=='private, no-store'
    original=client.get(f"/api/photos/{row['id']}/image?size=original")
    assert original.status_code==200 and original.content[8:12]==b'WEBP' and original.headers['content-type']=='image/webp'
    assert len(StorageStub.objects)==4, 'both originals and separate thumbnails must exist'
    assert db.query(SitePhoto).first().thumbnail_path
    assert client.get(f"/api/photos/{row['id']}/image?size=bogus").status_code==422
    assert client.get('/api/photos',params={'link':'issue'}).json()['total']==2
    assert client.get('/api/photos',params={'link':'pm'}).json()['total']==0
    assert client.get('/api/photos', params={'plant':other.plant_name}).json()['total']==0


def test_scope_for_site_engineer_read_and_write(client, db):
    engineer=login_user(client,db,role='Site Engineer')
    own=plant(db,'Mine');other=plant(db,'Others')
    db.add(UserPlantAssignment(user_id=engineer.id,plant_id=own.id));db.commit()
    assert [x['name'] for x in client.get('/api/photos/plants').json()]==['Mine']
    denied=submit(client,other)
    assert denied.status_code==403 and not StorageStub.objects
    good=submit(client,own,category='other')
    assert good.status_code==201,good.text
    assert client.get('/api/photos',params={'plant':other.plant_name}).json()['items']==[]
    assert client.get('/api/photos/links',params={'plant_id':other.id,'kind':'issue'}).status_code==403
    id=good.json()['records'][0]['id']
    assert client.get(f'/api/photos/{id}/image').status_code==200


def test_admin_can_read_not_create(client,db):
    login_user(client,db,role='Administration')
    p=plant(db,'Admin Plant')
    assert client.get('/api/photos/plants').status_code==200
    assert submit(client,p).status_code==403


def test_wrong_plant_link_and_invalid_type_rejected_before_upload(client,db):
    login_user(client,db)
    p=plant(db,'Plant A');q=plant(db,'Plant B')
    db.add(Issue(ticket_no='ISS-99',plant_id=q.id,description='Broken',severity='Major',status='Open'));db.commit()
    assert submit(client,p,kind='issue',ref='ISS-99').status_code==422
    assert submit(client,p,kind='pm',ref='NOT-REAL').status_code==422
    assert submit(client,p,kind='inventory',ref='NOT-REAL').status_code==422
    assert submit(client,p,kind='washing',ref='not-a-uuid').status_code==422
    assert submit(client,p,kind='unknown',ref='ID').status_code==422
    assert submit(client,p,kind='issue',ref='').status_code==422
    assert db.query(SitePhoto).count()==0
    assert not StorageStub.objects


def test_storage_failure_rolls_back_all_metadata_and_objects(client,db):
    login_user(client,db)
    p=plant(db,'Plant C')
    StorageStub.fail_after=1
    r=submit(client,p,count=3)
    assert r.status_code==502
    assert db.query(SitePhoto).count()==0
    assert not StorageStub.objects


def test_invalid_photo_content_is_rejected(client,db):
    login_user(client,db)
    p=plant(db,'Plant D')
    r=client.post('/api/photos',data={'plant_id':str(p.id),'category':'other'},files=[('files',('fake.jpg',io.BytesIO(b'notajpeg'*6),'image/jpeg'))])
    assert r.status_code==415 and not StorageStub.objects


def test_real_pm_link(client,db):
    login_user(client,db)
    p=plant(db,'Plant E')
    db.add(OMTask(work_order_no='PM-191',plant_id=p.id,task_name='Check inverter',status='Scheduled'))
    db.commit()
    assert client.get('/api/photos/links',params={'plant_id':p.id,'kind':'pm'}).status_code==200
    r=submit(client,p,kind='pm',ref='PM-191',category='pm')
    assert r.status_code==201,r.text
    assert r.json()['records'][0]['linkType']=='pm'


def test_washing_and_inventory_links_are_searchable_and_plant_checked(client,db):
    login_user(client,db)
    p=plant(db,'Linked Plant')
    washing=WashingDailyReport(plant_id=p.id, cycle_month='2026-10',cycle_no=1,report_date=date(2026,10,29),job_status='Completed',reported_by='Field Engineer')
    item=InventoryItem(legacy_id='INV-PART-24',plant_id=p.id,item_name='Fuse')
    db.add_all([washing,item]);db.commit();db.refresh(washing)
    for kind,ref,category in [('washing',str(washing.id),'washing'),('inventory','INV-PART-24','inventory')]:
        options=client.get('/api/photos/links',params={'plant_id':p.id,'kind':kind})
        assert options.status_code==200 and ref in [o['id'] for o in options.json()]
        response=submit(client,p,kind=kind,ref=ref,category=category)
        assert response.status_code==201,response.text
        row=response.json()['records'][0]
        assert row['linkType']==kind and row['linkId']==ref
        listing=client.get('/api/photos',params={'link':kind})
        assert listing.status_code==200 and listing.json()['total']==1
        assert listing.json()['items'][0]['linkId']==ref


def test_further_gallery_pages_return_rows_only_and_thumbnails_are_small_webp(client,db):
    login_user(client,db)
    p=plant(db,'Paged Plant')
    big=Image.new('RGB',(2400,1800),'#3a6f9e');out=io.BytesIO();big.save(out,format='JPEG',quality=90);out.seek(0)
    r=client.post('/api/photos',data={'plant_id':str(p.id),'category':'other'},files=[('files',('big.jpg',out,'image/jpeg'))])
    assert r.status_code==201,r.text
    assert submit(client,p,count=3).status_code==201
    first=client.get('/api/photos',params={'limit':2}).json()
    assert first['total']==4 and len(first['items'])==2 and 'summary' in first and 'facets' in first
    nxt=client.get('/api/photos',params={'limit':2,'offset':2,'meta':'false'}).json()
    assert set(nxt)=={'items','has_more','next_cursor'} and len(nxt['items'])==2 and nxt['has_more'] is False
    assert {x['id'] for x in first['items']}.isdisjoint({x['id'] for x in nxt['items']})
    thumb_path=next(k for k in StorageStub.objects if k.startswith('site-photo-thumbnails/'))
    assert thumb_path.endswith('.webp')
    with Image.open(io.BytesIO(StorageStub.objects[thumb_path][0])) as im:
        assert im.format=='WEBP' and max(im.size)<=640


def test_photo_responses_are_not_gzipped_again_but_json_is(client,db):
    login_user(client,db)
    p=plant(db,'Gzip Plant')
    assert submit(client,p,count=8).status_code==201
    listing=client.get('/api/photos',headers={'Accept-Encoding':'gzip'})
    assert listing.headers.get('content-encoding')=='gzip'
    noisy=Image.effect_noise((800,800),90).convert('RGB');out=io.BytesIO();noisy.save(out,format='JPEG');out.seek(0)
    r=client.post('/api/photos',data={'plant_id':str(p.id),'category':'other'},files=[('files',('noise.jpg',out,'image/jpeg'))])
    pid=r.json()['records'][0]['id']
    original=client.get(f'/api/photos/{pid}/image?size=original',headers={'Accept-Encoding':'gzip'})
    assert original.status_code==200 and len(original.content)>1000
    assert 'content-encoding' not in original.headers


def test_release_connection_never_commits_pending_writes(db):
    from app.core.database import release_connection
    db.add(Plant(site_code='PENDING1', plant_name='Pending'))
    release_connection(db)
    db.rollback()
    assert db.query(Plant).filter_by(site_code='PENDING1').count()==0
