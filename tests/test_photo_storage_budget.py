"""The Supabase Free-plan photo budget: thresholds, field-evidence thumbnails, slot
replacement, retention and the issue photo count.

The bucket is 1 GB. Three things keep it inside that: every photo is stored as a WebP
display copy rather than a camera original, field evidence carries a 480px/q65 thumbnail
(the shared gallery keeps its 640px/q70 default), and full-resolution originals are purged
after the retention window while the thumbnail and the record remain; PDF evidence
is excluded because its placeholder thumbnail cannot replace the report. Above the block
threshold a photo upload is refused — but never at the cost of the cleaning record or the
ticket it belonged to, which are saved first and stay saved.
"""
from __future__ import annotations

import io
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from PIL import Image

from app.core.models import Issue, Plant, SitePhoto, UserPlantAssignment, WashingConfig, WashingDailyReport
from app.photos.router import PHOTO_STORAGE_FULL
from tests.conftest import grant_assignee_plants, login_user
from tests.test_photo_live_api import StorageStub

WASH = "/api/scheduled/washing"


@pytest.fixture(autouse=True)
def storage(monkeypatch):
    from app.core.config import get_settings
    from app.storage.usage import clear_bucket_usage_cache
    StorageStub.objects = {}
    StorageStub.fail_after = 0
    monkeypatch.setattr("app.photos.router.SupabaseStorage", StorageStub)
    monkeypatch.setattr("app.scheduled.router.SupabaseStorage", StorageStub)
    monkeypatch.setattr("app.photos.retention.SupabaseStorage", StorageStub)
    clear_bucket_usage_cache()
    yield StorageStub
    clear_bucket_usage_cache()
    # Settings are read through an lru_cache, so a threshold set for one test has to be
    # dropped again or it leaks into every test that runs after it.
    monkeypatch.undo()
    get_settings.cache_clear()


@pytest.fixture
def budget(monkeypatch):
    """Set a storage threshold for one test, past the settings cache."""
    from app.core.config import get_settings

    def apply(**values):
        for key, value in values.items():
            monkeypatch.setenv(key, str(value))
        get_settings.cache_clear()

    return apply


def _photo_bytes(width=1600, height=1200):
    """Noise + gradient, so it compresses like a real site photo rather than a flat colour."""
    noise = Image.effect_noise((width, height), 25).convert("RGB")
    grad = Image.linear_gradient("L").resize((width, height)).convert("RGB")
    out = io.BytesIO()
    Image.blend(noise, grad, 0.6).save(out, format="JPEG", quality=92)
    return out.getvalue()


def _plant(db, code="BUD01", name="Budget Plant"):
    plant = Plant(site_code=code, plant_name=name)
    db.add(plant)
    db.commit()
    db.refresh(plant)
    return plant


def _post(client, plant, *, category="issue", link_type="", link_id="", count=1, **extra):
    data = {"plant_id": str(plant.id), "category": category, "tags": "[]",
            "description": "evidence", "link_type": link_type, "link_id": link_id}
    data.update({k: str(v) for k, v in extra.items() if v is not None})
    return client.post("/api/photos", data=data,
                       files=[("files", (f"p{i}.jpg", io.BytesIO(_photo_bytes()), "image/jpeg"))
                              for i in range(count)])


def _post_pdf(client, plant, report, data, *, phase="before", slot=1, category="washing"):
    form = {
        "plant_id": str(plant.id),
        "category": category,
        "tags": "[]",
        "description": "module cleaning evidence",
        "link_type": "washing" if category == "washing" else "",
        "link_id": str(report.id) if category == "washing" else "",
    }
    if category == "washing":
        form.update({"phase": phase, "slot": str(slot)})
    return client.post(
        "/api/photos",
        data=form,
        files=[("files", ("before.pdf", io.BytesIO(data), "application/pdf"))],
    )


def _issue(db, plant, ticket="BUD-1"):
    issue = Issue(ticket_no=ticket, plant_id=plant.id, vertical="Inverter",
                  description="Inverter stopped", severity="Medium", status="Open")
    db.add(issue)
    db.commit()
    db.refresh(issue)
    return issue


def _washing_day(db, plant, *, reported_by="Field Engineer"):
    db.add(WashingConfig(plant_id=plant.id, tables_per_cycle=6, team=["Washer"]))
    report = WashingDailyReport(
        plant_id=plant.id, report_date=date.today(), cycle_month=date.today().strftime("%Y-%m"),
        cycle_no=1, tables_cleaned=2, job_status="Done", review_status="Pending",
        reported_by=reported_by)
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


def test_module_cleaning_pdf_is_saved_unmodified_and_replaces_the_slot(client, db):
    head = login_user(client, db, role="O&M Head", name="Budget Head",
                      email="budget-pdf-head@example.com")
    plant = _plant(db, "BUD-PDF", "PDF Evidence Plant")
    report = _washing_day(db, plant, reported_by=head.display_name)
    existing = _post(client, plant, category="washing", link_type="washing",
                     link_id=str(report.id), phase="before", slot=1)
    assert existing.status_code == 201, existing.text
    old_photo = db.query(SitePhoto).one()
    old_paths = {old_photo.storage_path, old_photo.thumbnail_path}

    pdf = b"%PDF-1.7\n" + b"x" * (10 * 1024 * 1024 - len(b"%PDF-1.7\n"))
    response = _post_pdf(client, plant, report, pdf)
    assert response.status_code == 201, response.text
    row = response.json()["records"][0]
    saved = db.query(SitePhoto).one()
    assert row["contentType"] == saved.content_type == "application/pdf"
    assert saved.size_bytes == len(pdf) == 10 * 1024 * 1024
    assert saved.storage_path.endswith(".pdf") and saved.phase == "before" and saved.slot == 1
    assert StorageStub.objects[saved.storage_path] == (pdf, "application/pdf")
    assert all(path not in StorageStub.objects for path in old_paths)

    thumb = client.get(f"/api/photos/{saved.id}/image?size=thumb")
    assert thumb.status_code == 200 and thumb.content[:4] == b"RIFF"
    original = client.get(f"/api/photos/{saved.id}/image?size=original")
    assert original.status_code == 200 and original.content == pdf
    assert original.headers["content-type"] == "application/pdf"
    assert original.headers["content-disposition"].startswith("attachment;")
    assert original.headers["x-content-type-options"] == "nosniff"

    # Retention applies only to image originals. A PDF thumbnail is a generic
    # placeholder, not a usable copy of the report, so retain the entire PDF.
    from app.photos.retention import purge_photo_originals
    _age(db, saved.id, 40)
    for scope in ({}, {"older_than_days": 30, "category": "washing",
                       "plant_id": str(plant.id), "override_scope": True}):
        for dry_run in (True, False):
            retention = purge_photo_originals(db, dry_run=dry_run, **scope)
            assert retention["photos"] == 0
            assert retention["bytes_reclaimed"] == 0
    db.refresh(saved)
    assert saved.original_purged_at is None
    assert db.query(SitePhoto).count() == 1
    assert StorageStub.objects[saved.storage_path] == (pdf, "application/pdf")
    assert saved.thumbnail_path in StorageStub.objects
    retained = client.get(f"/api/photos/{saved.id}/image?size=original")
    assert retained.status_code == 200 and retained.content == pdf
    assert retained.headers.get("x-photo-original-purged") != "true"
    assert retained.headers["content-type"] == "application/pdf"
    assert retained.headers["content-disposition"].startswith("attachment;")


def test_module_cleaning_pdf_rejects_oversize_bad_signature_and_non_slot_uploads(client, db):
    head = login_user(client, db, role="O&M Head", name="Budget Head",
                      email="budget-pdf-check-head@example.com")
    plant = _plant(db, "BUD-PDF2", "PDF Limit Plant")
    report = _washing_day(db, plant, reported_by=head.display_name)

    oversized = b"%PDF-1.7\n" + b"x" * (10 * 1024 * 1024 - len(b"%PDF-1.7\n") + 1)
    response = _post_pdf(client, plant, report, oversized, phase="after", slot=2)
    assert response.status_code == 413
    assert "10 MB" in response.json()["detail"]

    invalid = _post_pdf(client, plant, report, b"not a PDF document", phase="after", slot=2)
    assert invalid.status_code == 415
    assert _post_pdf(client, plant, report, b"%PDF-1.7\ninvalid", category="safety").status_code == 415
    assert db.query(SitePhoto).count() == 0
    assert StorageStub.objects == {}


# ── Thresholds ──────────────────────────────────────────────────────────────

def test_a_photo_above_the_block_threshold_is_refused_with_the_exact_message(client, db, budget):
    login_user(client, db)
    plant = _plant(db)
    budget(STORAGE_BLOCK_BYTES=1)   # any photo at all overshoots

    response = _post(client, plant)
    assert response.status_code == 507, response.text
    assert response.json()["detail"] == PHOTO_STORAGE_FULL
    assert PHOTO_STORAGE_FULL == "Photo storage is full — contact an administrator."
    # Nothing was kept: no row, and no half-written object left in the bucket.
    assert db.query(SitePhoto).count() == 0
    assert StorageStub.objects == {}


def test_crossing_the_warning_threshold_still_saves_and_tells_an_administrator(client, db, budget):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    budget(STORAGE_WARN_BYTES=1, STORAGE_BLOCK_BYTES=999999999)

    response = _post(client, plant)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["persisted"] is True
    assert body["storage_warning"] == "Photo storage is nearing its limit. Contact an administrator."
    assert db.query(SitePhoto).count() == 1


def test_below_the_warning_threshold_no_warning_is_raised(client, db, budget):
    login_user(client, db, role="O&M Head")
    plant = _plant(db)
    budget(STORAGE_WARN_BYTES=999999999, STORAGE_BLOCK_BYTES=1000000000)

    body = _post(client, plant).json()
    assert body["storage_warning"] is None


def test_a_full_bucket_never_costs_the_cleaning_record_its_photos_belonged_to(client, db, budget):
    """The day is already saved. A refused photo must leave it exactly as it was."""
    head = login_user(client, db, role="O&M Head", name="Budget Head", email="budget-head@example.com")
    plant = _plant(db, "BUD02", "Budget Cleaning")
    report = _washing_day(db, plant, reported_by=head.display_name)
    budget(STORAGE_BLOCK_BYTES=1)

    refused = client.post(f"{WASH}/daily-reports/{report.id}/evidence",
                          files=[("files", ("before.jpg", io.BytesIO(_photo_bytes()), "image/jpeg"))],
                          data={"kind": "before"})
    assert refused.status_code == 507
    assert refused.json()["detail"] == PHOTO_STORAGE_FULL

    db.expire_all()
    kept = db.get(WashingDailyReport, report.id)
    assert kept is not None, "the cleaning record must survive a refused photo"
    assert kept.tables_cleaned == 2 and kept.job_status == "Done"
    assert not (kept.evidence or []), "no evidence entry for a photo that was never stored"
    assert db.query(SitePhoto).count() == 0


def test_a_full_bucket_never_costs_the_ticket_its_photos_belonged_to(client, db, budget):
    login_user(client, db)
    plant = _plant(db, "BUD03", "Budget Issue")
    issue = _issue(db, plant, "BUD-3")
    budget(STORAGE_BLOCK_BYTES=1)

    refused = _post(client, plant, link_type="issue", link_id=issue.ticket_no)
    assert refused.status_code == 507

    db.expire_all()
    kept = db.get(Issue, issue.id)
    assert kept is not None and kept.status == "Open"
    assert kept.photo_count == 0


# ── Thumbnails ──────────────────────────────────────────────────────────────

def _thumb_side(photo: SitePhoto) -> int:
    data, _mime = StorageStub.objects[photo.thumbnail_path]
    image = Image.open(io.BytesIO(data))
    image.load()
    return max(image.size)


def test_field_evidence_uses_480px_thumbnails_and_the_gallery_keeps_640(client, db):
    login_user(client, db)
    plant = _plant(db)
    issue = _issue(db, plant)

    assert _post(client, plant, category="issue", link_type="issue",
                 link_id=issue.ticket_no).status_code == 201
    field = db.query(SitePhoto).filter(SitePhoto.category == "issue").one()
    assert _thumb_side(field) == 480, "issue evidence is a 480px thumbnail"

    assert _post(client, plant, category="safety").status_code == 201
    gallery = db.query(SitePhoto).filter(SitePhoto.category == "safety").one()
    assert _thumb_side(gallery) == 640, "the shared gallery keeps its 640px default"

    # A thumbnail is a small fraction of its original; that is the whole storage argument.
    assert field.thumbnail_size_bytes < field.size_bytes


def test_a_washing_slot_photo_also_uses_the_480px_field_thumbnail(client, db):
    head = login_user(client, db, role="O&M Head", name="Slot Head", email="slot-head@example.com")
    plant = _plant(db, "BUD04", "Slot Plant")
    report = _washing_day(db, plant, reported_by=head.display_name)

    assert client.post(f"{WASH}/daily-reports/{report.id}/evidence",
                       files=[("files", ("b.jpg", io.BytesIO(_photo_bytes()), "image/jpeg"))],
                       data={"kind": "before"}).status_code == 200
    photo = db.query(SitePhoto).one()
    assert photo.phase == "before" and photo.slot == 1
    assert _thumb_side(photo) == 480


# ── Slots: replacement and the duplicate constraint ─────────────────────────

def test_replacing_a_slot_keeps_one_photo_and_removes_the_objects_it_replaced(client, db):
    head = login_user(client, db, role="O&M Head", name="Rep Head", email="rep-head@example.com")
    plant = _plant(db, "BUD05", "Replace Plant")
    report = _washing_day(db, plant, reported_by=head.display_name)

    first = _post(client, plant, category="washing", link_type="washing",
                  link_id=str(report.id), phase="before", slot=1)
    assert first.status_code == 201, first.text
    original = db.query(SitePhoto).one()
    original_id = original.id
    old_paths = [original.storage_path, original.thumbnail_path]
    assert len(StorageStub.objects) == 2

    second = _post(client, plant, category="washing", link_type="washing",
                   link_id=str(report.id), phase="before", slot=1)
    assert second.status_code == 201, second.text

    db.expire_all()
    rows = db.query(SitePhoto).all()
    assert len(rows) == 1, "a slot holds one photo; the replaced row is gone"
    assert rows[0].id != original_id
    for path in old_paths:
        assert path not in StorageStub.objects, "the replaced objects are removed from Storage"
    assert len(StorageStub.objects) == 2


def test_both_slots_of_a_phase_can_be_filled_and_a_third_is_refused(client, db):
    head = login_user(client, db, role="O&M Head", name="Two Head", email="two-head@example.com")
    plant = _plant(db, "BUD06", "Two Slot Plant")
    report = _washing_day(db, plant, reported_by=head.display_name)

    for slot in (1, 2):
        response = _post(client, plant, category="washing", link_type="washing",
                         link_id=str(report.id), phase="before", slot=slot)
        assert response.status_code == 201, response.text
    assert db.query(SitePhoto).count() == 2

    # Only 1 and 2 exist. A third slot is refused, and says which are taken.
    third = _post(client, plant, category="washing", link_type="washing",
                  link_id=str(report.id), phase="before", slot=3)
    assert third.status_code == 409
    assert "1, 2" in third.json()["detail"]

    # The evidence endpoint, which picks the slot itself, reports both as in use.
    full = client.post(f"{WASH}/daily-reports/{report.id}/evidence",
                       files=[("files", ("b.jpg", io.BytesIO(_photo_bytes()), "image/jpeg"))],
                       data={"kind": "before"})
    assert full.status_code == 409 and "slots are in use" in full.json()["detail"]


def test_before_and_after_are_separate_pairs(client, db):
    head = login_user(client, db, role="O&M Head", name="Pair Head", email="pair-head@example.com")
    plant = _plant(db, "BUD07", "Pair Plant")
    report = _washing_day(db, plant, reported_by=head.display_name)

    for phase in ("before", "after"):
        for slot in (1, 2):
            assert _post(client, plant, category="washing", link_type="washing",
                         link_id=str(report.id), phase=phase, slot=slot).status_code == 201
    assert db.query(SitePhoto).count() == 4
    assert {(p.phase, p.slot) for p in db.query(SitePhoto)} == {
        ("before", 1), ("before", 2), ("after", 1), ("after", 2)}


def test_a_phase_or_slot_outside_module_cleaning_is_refused(client, db):
    login_user(client, db)
    plant = _plant(db, "BUD08", "Phase Plant")
    issue = _issue(db, plant, "BUD-8")
    response = _post(client, plant, category="issue", link_type="issue",
                     link_id=issue.ticket_no, phase="before", slot=1)
    assert response.status_code == 422
    assert "module cleaning" in response.json()["detail"].lower()


# ── Retention ───────────────────────────────────────────────────────────────

def _age(db, photo_id, days):
    photo = db.get(SitePhoto, photo_id)
    photo.created_at = datetime.now(timezone.utc) - timedelta(days=days)
    db.commit()


def test_the_sweep_removes_originals_keeps_thumbnails_and_is_idempotent(client, db):
    from app.photos.retention import purge_photo_originals
    login_user(client, db)
    plant = _plant(db, "BUD09", "Retention Plant")
    assert _post(client, plant, category="safety").status_code == 201
    photo = db.query(SitePhoto).one()
    _age(db, photo.id, 40)
    original_path, thumb_path = photo.storage_path, photo.thumbnail_path
    expected_bytes = photo.size_bytes

    first = purge_photo_originals(db, dry_run=False)
    assert first["photos"] == 1
    assert first["bytes_reclaimed"] == expected_bytes
    assert first["retention_days"] == 30

    db.expire_all()
    kept = db.get(SitePhoto, photo.id)
    assert kept is not None, "the metadata row stays"
    assert kept.original_purged_at is not None
    assert kept.thumbnail_path == thumb_path
    assert original_path not in StorageStub.objects, "the full-resolution object is gone"
    assert thumb_path in StorageStub.objects, "its thumbnail remains"

    # Running it again reclaims nothing and touches nothing: the stamp is the guard.
    second = purge_photo_originals(db, dry_run=False)
    assert second["photos"] == 0 and second["bytes_reclaimed"] == 0
    db.expire_all()
    assert db.get(SitePhoto, photo.id).original_purged_at == kept.original_purged_at
    assert thumb_path in StorageStub.objects


def test_a_photo_inside_the_retention_window_is_left_alone(client, db):
    from app.photos.retention import purge_photo_originals
    login_user(client, db)
    plant = _plant(db, "BUD10", "Fresh Plant")
    assert _post(client, plant, category="safety").status_code == 201
    photo = db.query(SitePhoto).one()
    _age(db, photo.id, 5)

    result = purge_photo_originals(db, dry_run=False)
    assert result["photos"] == 0
    db.expire_all()
    assert db.get(SitePhoto, photo.id).original_purged_at is None
    assert photo.storage_path in StorageStub.objects


def test_a_dry_run_reports_what_it_would_reclaim_and_changes_nothing(client, db):
    from app.photos.retention import purge_photo_originals
    login_user(client, db)
    plant = _plant(db, "BUD11", "Dry Plant")
    assert _post(client, plant, category="safety").status_code == 201
    photo = db.query(SitePhoto).one()
    _age(db, photo.id, 40)

    result = purge_photo_originals(db, dry_run=True)
    assert result["dry_run"] is True and result["photos"] == 1
    assert result["bytes_reclaimed"] == photo.size_bytes
    db.expire_all()
    assert db.get(SitePhoto, photo.id).original_purged_at is None
    assert photo.storage_path in StorageStub.objects


def test_a_purged_original_falls_back_to_its_thumbnail_and_says_so(client, db):
    from app.photos.retention import purge_photo_originals
    login_user(client, db)
    plant = _plant(db, "BUD12", "Fallback Plant")
    assert _post(client, plant, category="safety").status_code == 201
    photo = db.query(SitePhoto).one()
    photo_id, thumb_path = photo.id, photo.thumbnail_path
    _age(db, photo_id, 40)
    purge_photo_originals(db, dry_run=False)

    served = client.get(f"/api/photos/{photo_id}/image?size=original")
    assert served.status_code == 200, served.text
    assert served.headers["x-photo-original-purged"] == "true"
    assert served.content == StorageStub.objects[thumb_path][0], "the thumbnail stands in"

    # The row still describes the photo, and says when its original went.
    row = client.get(f"/api/photos/{photo_id}").json()
    assert row["originalPurgedAt"] is not None
    assert row["thumbnailUrl"].endswith("size=thumb")


def test_only_an_administrator_can_read_usage_or_run_the_sweep(client, db):
    engineer = login_user(client, db, role="Site Engineer", name="Budget Eng",
                          email="budget-eng@example.com")
    plant = _plant(db, "BUD13", "Admin Gate Plant")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plant.id,
                               assignment_role="Site Engineer"))
    db.commit()
    assert client.get("/api/photos/storage-usage").status_code == 403
    assert client.post("/api/photos/retention/purge").status_code == 403

    login_user(client, db, role="O&M Head", name="Budget Admin", email="budget-admin@example.com")
    usage = client.get("/api/photos/storage-usage")
    assert usage.status_code == 200, usage.text
    body = usage.json()
    assert body["capacity_bytes"] == 1_000_000_000
    assert body["warn_bytes"] == 800_000_000 and body["block_bytes"] == 950_000_000
    assert client.post("/api/photos/retention/purge").status_code == 200


# ── Issue photo count and retry ─────────────────────────────────────────────

def test_the_issue_photo_count_follows_its_linked_photos(client, db):
    login_user(client, db)
    plant = _plant(db, "BUD14", "Count Plant")
    issue = _issue(db, plant, "BUD-14")

    created = _post(client, plant, category="issue", link_type="issue",
                    link_id=issue.ticket_no, count=2)
    assert created.status_code == 201, created.text
    assert created.json()["issue_photo_count"] == 2
    db.expire_all()
    assert db.get(Issue, issue.id).photo_count == 2

    photo_id = created.json()["records"][0]["id"]
    removed = client.delete(f"/api/photos/{photo_id}")
    assert removed.status_code == 200, removed.text
    assert removed.json()["issue_photo_count"] == 1
    db.expire_all()
    assert db.get(Issue, issue.id).photo_count == 1


def test_a_retry_under_the_same_submission_id_never_stores_the_photos_twice(client, db):
    """A dropped field connection means the browser retries. The submission id makes the
    repeat the same submission, so the bucket is not billed for it a second time."""
    login_user(client, db)
    plant = _plant(db, "BUD15", "Retry Plant")
    issue = _issue(db, plant, "BUD-15")
    submission = str(uuid.uuid4())

    first = _post(client, plant, category="issue", link_type="issue", link_id=issue.ticket_no,
                  count=2, submission_id=submission)
    assert first.status_code == 201, first.text
    assert first.json().get("duplicate") is not True
    objects_after_first = dict(StorageStub.objects)
    assert db.query(SitePhoto).count() == 2

    retry = _post(client, plant, category="issue", link_type="issue", link_id=issue.ticket_no,
                  count=2, submission_id=submission)
    assert retry.status_code == 200, retry.text
    assert retry.json()["duplicate"] is True
    assert retry.json()["persisted"] is True
    assert [r["id"] for r in retry.json()["records"]] == [r["id"] for r in first.json()["records"]]

    db.expire_all()
    assert db.query(SitePhoto).count() == 2, "a retry must not double the rows"
    assert StorageStub.objects.keys() == objects_after_first.keys(), "nor the stored objects"
    assert db.get(Issue, issue.id).photo_count == 2


def test_a_photo_cannot_be_linked_to_a_ticket_at_another_plant(client, db):
    login_user(client, db)
    mine = _plant(db, "BUD16", "Mine")
    theirs = _plant(db, "BUD17", "Theirs")
    issue = _issue(db, theirs, "BUD-17")

    response = _post(client, mine, category="issue", link_type="issue", link_id=issue.ticket_no)
    assert response.status_code == 422
    assert db.query(SitePhoto).count() == 0


def test_a_site_engineer_cannot_attach_photos_outside_their_plant(client, db):
    engineer = login_user(client, db, role="Site Engineer", name="Scoped Eng",
                          email="scoped-eng@example.com")
    mine = _plant(db, "BUD18", "Scoped Mine")
    outside = _plant(db, "BUD19", "Scoped Outside")
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=mine.id,
                               assignment_role="Site Engineer"))
    db.commit()

    assert _post(client, mine, category="safety").status_code == 201
    assert _post(client, outside, category="safety").status_code == 403
    assert db.query(SitePhoto).count() == 1


# ── Caching ─────────────────────────────────────────────────────────────────

def test_photo_responses_are_immutably_cacheable(client, db):
    """A stored photo never changes, so the browser may keep it. That is what stops a
    month view re-downloading every thumbnail each time it is opened."""
    login_user(client, db)
    plant = _plant(db, "BUD20", "Cache Plant")
    assert _post(client, plant, category="safety").status_code == 201
    photo = db.query(SitePhoto).one()

    for size in ("thumb", "original"):
        served = client.get(f"/api/photos/{photo.id}/image?size={size}")
        assert served.status_code == 200
        cache = served.headers["cache-control"]
        assert "immutable" in cache and "max-age=31536000" in cache
        # Private: a shared proxy must never keep plant evidence.
        assert cache.startswith("private")
        assert served.headers["x-content-type-options"] == "nosniff"


def test_a_tickets_photos_can_be_read_back_by_its_number(client, db):
    """What the register asks for when a ticket is opened: that ticket's photos, rows only."""
    login_user(client, db)
    plant = _plant(db, "BUD21", "Read Back Plant")
    mine = _issue(db, plant, "BUD-21")
    other = _issue(db, plant, "BUD-21-OTHER")
    assert _post(client, plant, category="issue", link_type="issue",
                 link_id=mine.ticket_no, count=2).status_code == 201
    assert _post(client, plant, category="issue", link_type="issue",
                 link_id=other.ticket_no).status_code == 201

    found = client.get(f"/api/photos?link=issue&link_id={mine.ticket_no}&window=all&meta=false&limit=4")
    assert found.status_code == 200, found.text
    body = found.json()
    assert len(body["items"]) == 2, "only this ticket's photos"
    assert {row["linkId"] for row in body["items"]} == {mine.ticket_no}
    # Rows only: no gallery facets or day counts on this read.
    assert "facets" not in body and "days" not in body
    for row in body["items"]:
        assert row["thumbnailUrl"].endswith("size=thumb")
        assert row["width"] and row["height"], "dimensions travel with the row, for the <img>"


def test_a_ticket_carries_at_most_four_photos_however_they_are_sent(client, db):
    """The form caps it at four; so does the API, because a cap only the browser applies
    is not a cap on what reaches the bucket."""
    from app.photos.router import MAX_ISSUE_PHOTOS
    assert MAX_ISSUE_PHOTOS == 4
    login_user(client, db)
    plant = _plant(db, "BUD22", "Cap Plant")
    issue = _issue(db, plant, "BUD-22")

    assert _post(client, plant, category="issue", link_type="issue",
                 link_id=issue.ticket_no, count=4).status_code == 201
    db.expire_all()
    assert db.get(Issue, issue.id).photo_count == 4

    fifth = _post(client, plant, category="issue", link_type="issue", link_id=issue.ticket_no)
    assert fifth.status_code == 409, fifth.text
    assert "4 photos" in fifth.json()["detail"] and "4 are already attached" in fifth.json()["detail"]
    db.expire_all()
    assert db.query(SitePhoto).count() == 4, "the refused photo was never stored"
    assert db.get(Issue, issue.id).photo_count == 4


def test_a_batch_that_would_overshoot_the_ticket_cap_is_refused_whole(client, db):
    login_user(client, db)
    plant = _plant(db, "BUD23", "Batch Cap Plant")
    issue = _issue(db, plant, "BUD-23")

    assert _post(client, plant, category="issue", link_type="issue",
                 link_id=issue.ticket_no, count=3).status_code == 201
    over = _post(client, plant, category="issue", link_type="issue",
                 link_id=issue.ticket_no, count=2)
    assert over.status_code == 409
    db.expire_all()
    assert db.query(SitePhoto).count() == 3, "nothing from the refused batch was stored"


def test_the_sweep_never_reads_the_whole_backlog_at_once(client, db):
    """A long-neglected backlog must not be pulled into memory in one go. The sweep takes
    the oldest slice, says more is waiting, and the next run continues — it is idempotent."""
    from app.photos.retention import MAX_PHOTOS_PER_RUN, purge_photo_originals
    assert MAX_PHOTOS_PER_RUN == 5000
    login_user(client, db)
    plant = _plant(db, "BUD24", "Backlog Plant")
    for _ in range(3):
        assert _post(client, plant, category="safety").status_code == 201
    for photo in db.query(SitePhoto).all():
        _age(db, photo.id, 40)

    first = purge_photo_originals(db, dry_run=False, max_photos=2)
    assert first["photos"] == 2
    assert first["more_remaining"] is True, "the caller must know a backlog is left"
    db.expire_all()
    assert db.query(SitePhoto).filter(SitePhoto.original_purged_at.is_(None)).count() == 1

    second = purge_photo_originals(db, dry_run=False, max_photos=2)
    assert second["photos"] == 1 and second["more_remaining"] is False
    db.expire_all()
    assert db.query(SitePhoto).filter(SitePhoto.original_purged_at.is_(None)).count() == 0
    # Every thumbnail survived the sweep; only the originals went.
    assert len(StorageStub.objects) == 3
    assert all(photo.thumbnail_path in StorageStub.objects for photo in db.query(SitePhoto))
