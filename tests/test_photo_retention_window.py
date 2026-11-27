"""Photo retention: the window is set from the portal, and a sweep can clear space early.

Only full-size **originals** are ever deleted. The thumbnail and the photo record stay, so the
issue, PM and cleaning galleries keep showing their evidence — that is the whole point of the
sweep, and it is what the API must keep guaranteeing.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.core.models import AppSetting, AuditLog, Plant, SitePhoto
from app.photos.retention import (MAX_RETENTION_DAYS, MIN_PURGE_DAYS, MIN_RETENTION_DAYS,
                                  RETENTION_SETTING, purge_photo_originals, retention_days)
from tests.conftest import login_user

BASE = "/api/photos/retention"


@pytest.fixture(autouse=True)
def _no_storage_calls(monkeypatch):
    """The sweep's deletes go to Supabase Storage; the tests stand in for the bucket."""
    removed: list[str] = []
    monkeypatch.setattr("app.photos.retention.SupabaseStorage", lambda *a, **k: object())
    monkeypatch.setattr("app.photos.retention.adjust_bucket_usage", lambda *a, **k: None)

    def remove_strict(storage, paths):
        removed.extend(paths)

    monkeypatch.setattr("app.photos.retention.SupabaseStorage", type("FakeStorage", (), {
        "remove_strict": lambda self, paths: removed.extend(paths)}))
    return removed


def _plant(db):
    plant = Plant(site_code="PHO01", plant_name="Photo Plant")
    db.add(plant)
    db.commit()
    db.refresh(plant)
    return plant


def _photo(db, plant, *, days_old: int, name: str, size: int = 1_000_000):
    row = SitePhoto(
        plant_id=plant.id, uploader_name="Field Person", category="issue",
        file_name=f"{name}.jpg", content_type="image/webp",
        storage_path=f"site-photos/{plant.id}/{name}.webp",
        thumbnail_path=f"site-photos/{plant.id}/{name}-thumb.webp", size_bytes=size,
        created_at=datetime.now(timezone.utc) - timedelta(days=days_old),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# ── the window ─────────────────────────────────────────────────────────────


def test_the_window_defaults_to_the_deployment_value_and_is_saved_from_the_portal(client, db):
    head = login_user(client, db, role="O&M Head", email="retention-head@example.com")

    before = client.get(BASE)
    assert before.status_code == 200, before.text
    body = before.json()
    assert body["days"] == 30 and body["default_days"] == 30
    assert body["source"] == "deployment"
    assert body["min_days"] == MIN_RETENTION_DAYS and body["max_days"] == MAX_RETENTION_DAYS

    saved = client.put(BASE, json={"days": 90})
    assert saved.status_code == 200, saved.text
    assert saved.json()["days"] == 90 and saved.json()["source"] == "portal"
    assert saved.json()["updated_by"] == head.display_name

    # Stored where the portal's other settings live, and the sweep reads it from there.
    assert db.get(AppSetting, RETENTION_SETTING).setting_value == {"days": 90}
    assert retention_days(db) == 90
    assert client.get(BASE).json()["days"] == 90

    # And the change is on the record.
    entries = [row for row in db.scalars(select(AuditLog))
               if row.action == "Changed photo retention window"]
    assert len(entries) == 1
    assert entries[0].before_state == {"days": 30} and entries[0].after_state == {"days": 90}


def test_an_impossible_window_is_refused_and_nothing_is_stored(client, db):
    login_user(client, db, role="O&M Head", email="retention-bounds@example.com")

    for days in (0, 1, 6, 366, 4000):
        assert client.put(BASE, json={"days": days}).status_code == 422, days
    assert db.get(AppSetting, RETENTION_SETTING) is None
    assert client.get(BASE).json()["days"] == 30


def test_only_the_head_changes_the_window(client, db):
    login_user(client, db, role="Administration", email="retention-admin@example.com")
    # Administration may look at storage, but not change how long evidence is kept.
    assert client.get(BASE).status_code == 200
    assert client.put(BASE, json={"days": 60}).status_code == 403

    login_user(client, db, role="Assignee", email="retention-assignee@example.com")
    assert client.get(BASE).status_code == 403
    assert client.put(BASE, json={"days": 60}).status_code == 403

    login_user(client, db, role="Site Engineer", email="retention-se@example.com")
    assert client.post("/api/photos/retention/purge", json={}).status_code == 403
    assert db.get(AppSetting, RETENTION_SETTING) is None


# ── the sweep ──────────────────────────────────────────────────────────────


def test_a_sweep_deletes_originals_older_than_the_window_and_keeps_the_record(client, db):
    login_user(client, db, role="O&M Head", email="sweep-head@example.com")
    plant = _plant(db)
    old = _photo(db, plant, days_old=45, name="old")
    recent = _photo(db, plant, days_old=5, name="recent")

    done = client.post("/api/photos/retention/purge", json={})
    assert done.status_code == 200, done.text
    assert done.json()["photos"] == 1 and done.json()["retention_days"] == 30

    db.expire_all()
    old_row, recent_row = db.get(SitePhoto, old.id), db.get(SitePhoto, recent.id)
    assert old_row is not None, "the photo record must survive its original being purged"
    assert old_row.original_purged_at is not None
    assert old_row.thumbnail_path, "the thumbnail is what keeps the gallery working"
    assert recent_row.original_purged_at is None, "a recent original is untouched"

    # Running it again is harmless: the work is already done.
    assert client.post("/api/photos/retention/purge", json={}).json()["photos"] == 0


def test_clearing_space_early_uses_its_own_age_without_changing_the_window(client, db):
    login_user(client, db, role="O&M Head", email="early-head@example.com")
    plant = _plant(db)
    _photo(db, plant, days_old=20, name="twenty", size=2_000_000)
    _photo(db, plant, days_old=3, name="three")

    # A dry run says what it would remove, and removes nothing.
    preview = client.post("/api/photos/retention/purge", json={"older_than_days": 10, "dry_run": True})
    assert preview.status_code == 200, preview.text
    assert preview.json() == {"dry_run": True, "photos": 1, "bytes_reclaimed": 2_000_000,
                              "retention_days": 10, "more_remaining": False}
    assert not [row for row in db.scalars(select(SitePhoto)) if row.original_purged_at]

    done = client.post("/api/photos/retention/purge", json={"older_than_days": 10})
    assert done.status_code == 200 and done.json()["photos"] == 1
    db.expire_all()
    purged = [row for row in db.scalars(select(SitePhoto)) if row.original_purged_at]
    assert [row.storage_path.endswith("twenty.webp") for row in purged] == [True]

    # The standing window is untouched by a one-off sweep.
    assert client.get(BASE).json()["days"] == 30
    assert db.get(AppSetting, RETENTION_SETTING) is None


def test_a_sweep_can_never_reach_todays_originals(client, db):
    login_user(client, db, role="O&M Head", email="today-head@example.com")
    plant = _plant(db)
    _photo(db, plant, days_old=0, name="today")

    for days in (0, -5, 400):
        assert client.post("/api/photos/retention/purge", json={"older_than_days": days}).status_code == 422, days
    assert MIN_PURGE_DAYS == 1
    with pytest.raises(ValueError):
        purge_photo_originals(db, older_than_days=0)

    db.expire_all()
    assert not [row for row in db.scalars(select(SitePhoto)) if row.original_purged_at]


def test_the_daily_job_follows_the_window_set_in_the_portal(client, db):
    login_user(client, db, role="O&M Head", email="job-head@example.com")
    plant = _plant(db)
    _photo(db, plant, days_old=45, name="forty-five")
    _photo(db, plant, days_old=100, name="hundred")

    assert client.put(BASE, json={"days": 90}).status_code == 200
    # This is the call the hourly/daily job makes: no age of its own.
    result = purge_photo_originals(db, dry_run=True)
    assert result["retention_days"] == 90
    assert result["photos"] == 1, "only the 100-day-old original is past a 90-day window"


def test_saved_scoped_policy_and_manual_override(client, db, _no_storage_calls):
    login_user(client, db, role="O&M Head", email="scoped-retention@example.com")
    plant = _plant(db)
    other = Plant(site_code="PHO02", plant_name="Other Plant")
    db.add(other)
    db.commit()
    match = _photo(db, plant, days_old=45, name="match")
    pm = _photo(db, plant, days_old=45, name="pm")
    pm.category = "pm"
    pdf = _photo(db, plant, days_old=45, name="pdf")
    pdf.content_type = "application/pdf"
    outside = _photo(db, other, days_old=45, name="outside")
    recent = _photo(db, plant, days_old=5, name="recent")
    db.commit()
    ids = [match.id, pm.id, pdf.id, outside.id, recent.id]
    assert client.put(BASE, json={"days": 30, "category": "issue", "plant_id": str(plant.id), "automatic": True}).status_code == 200
    assert client.get(BASE).json()["automatic"] is True
    assert client.get(BASE).json()["plant_id"] == str(plant.id)
    assert purge_photo_originals(db, dry_run=True)["photos"] == 1
    assert not _no_storage_calls
    assert purge_photo_originals(db)["photos"] == 1
    db.expire_all()
    assert [db.get(SitePhoto, i).original_purged_at is not None for i in ids] == [True, False, False, False, False]
    preview = client.post(BASE + "/purge", json={"older_than_days": 30, "category": "pm", "plant_id": None, "dry_run": True})
    assert preview.json()["photos"] == 1
    assert client.post(BASE + "/purge", json={"older_than_days": 30, "category": "pm", "plant_id": None}).json()["photos"] == 1
    assert client.get(BASE).json()["category"] == "issue"
    assert client.put(BASE, json={"days": 30, "category": "invalid"}).status_code == 422
    assert client.post(BASE + "/purge", json={"category": "invalid"}).status_code == 422
    assert len(_no_storage_calls) == 2
