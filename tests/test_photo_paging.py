"""Photo gallery keyset paging: ties, inserts between pages, filters, scope and flat query counts."""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.core.models import Plant, SitePhoto, UserPlantAssignment
from tests.conftest import login_user
from tests.test_photo_live_api import fake_storage  # noqa: F401  (autouse storage stub)

T0 = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=2)


def add_photos(db, plant, n, *, at=None, step=0, category="other", link=None):
    rows = []
    for i in range(n):
        rows.append(SitePhoto(id=uuid.uuid4(), plant_id=plant.id, uploader_name="Field", category=category,
                              link_type=link[0] if link else None, link_id=link[1] if link else None,
                              storage_path=f"x/{i}", file_name="p.webp", content_type="image/webp", size_bytes=10,
                              created_at=(at or T0) + timedelta(seconds=i * step)))
    db.add_all(rows); db.commit()
    return rows


def walk(client, **params):
    seen, cursor, pages = [], None, 0
    while True:
        q = dict(params, limit=params.get("limit", 4), **({"cursor": cursor, "meta": "false"} if cursor else {}))
        body = client.get("/api/photos", params=q).json()
        seen += [x["id"] for x in body["items"]]; pages += 1
        if not body["has_more"]:
            assert body["next_cursor"] is None
            return seen, pages
        cursor = body["next_cursor"]


def plant(db, code="PG1"):
    p = Plant(site_code=code, plant_name=f"Plant {code}"); db.add(p); db.commit(); db.refresh(p); return p


def test_equal_timestamps_page_without_gaps_or_duplicates(client, db):
    login_user(client, db); p = plant(db)
    rows = add_photos(db, p, 11, step=0)  # all saved in the same instant
    seen, pages = walk(client)
    assert len(seen) == 11 == len(set(seen)) and pages == 3
    assert seen == [str(r.id) for r in sorted(rows, key=lambda r: r.id, reverse=True)]


@pytest.mark.parametrize("sort", ["newest", "oldest"])
def test_order_is_stable_for_both_sorts(client, db, sort):
    login_user(client, db); p = plant(db)
    rows = add_photos(db, p, 5, step=60) + add_photos(db, p, 4, at=T0 + timedelta(seconds=120), step=0)
    seen, _ = walk(client, sort=sort, limit=3)
    key = lambda r: (r.created_at, r.id)
    assert seen == [str(r.id) for r in sorted(rows, key=key, reverse=sort == "newest")]


def test_new_upload_between_pages_does_not_shift_the_next_page(client, db):
    login_user(client, db); p = plant(db)
    add_photos(db, p, 8, step=60)
    first = client.get("/api/photos", params={"limit": 4}).json()
    add_photos(db, p, 2, at=T0 + timedelta(hours=1))  # newer than everything shown
    rest = client.get("/api/photos", params={"limit": 4, "cursor": first["next_cursor"], "meta": "false"}).json()
    ids = [x["id"] for x in first["items"] + rest["items"]]
    assert len(ids) == 8 == len(set(ids))
    assert set(rest) == {"items", "has_more", "next_cursor"}


def test_cursor_respects_filters_and_plant_scope(client, db):
    engineer = login_user(client, db, role="Site Engineer")
    mine, other = plant(db, "MINE"), plant(db, "OTHR")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=mine.id)); db.commit()
    own = add_photos(db, mine, 5, step=1, category="safety") + add_photos(db, mine, 3, step=1, category="other")
    add_photos(db, other, 6, step=1, category="safety")
    seen, _ = walk(client, category="safety", limit=2)
    assert set(seen) == {str(r.id) for r in own if r.category == "safety"}


def test_invalid_cursor_and_deep_offset_rejected(client, db):
    login_user(client, db); plant(db)
    assert client.get("/api/photos", params={"cursor": "not-a-cursor"}).status_code == 422
    assert client.get("/api/photos", params={"offset": 100000}).status_code == 422


def _queries(response):
    return int(response.headers["server-timing"].split('desc="')[1].split()[0])


def test_query_count_does_not_grow_with_page_size_or_plants(client, db):
    login_user(client, db)
    p = plant(db)
    add_photos(db, p, 3, step=1)
    small = (_queries(client.get("/api/photos", params={"limit": 3})),
             _queries(client.get("/api/photos", params={"limit": 3, "meta": "false"})))
    for i in range(6):
        add_photos(db, plant(db, f"PX{i}"), 10, step=1, link=("issue", f"ISS-{i}"))
    big = (_queries(client.get("/api/photos", params={"limit": 60})),
           _queries(client.get("/api/photos", params={"limit": 60, "meta": "false"})))
    assert big == small
    assert small[1] < small[0], "a further page skips the totals, facets and day counts"
