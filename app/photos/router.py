"""Authenticated, plant-scoped Photo Intelligence with private Supabase objects.

No public image URLs or browser-side service keys. Submissions are committed only after
all bytes are stored; on a partial failure, newly uploaded objects are cleaned up.
"""
from __future__ import annotations

import base64
from io import BytesIO
import json
import re
from sqlalchemy import Text
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from PIL import Image, ImageDraw
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db, release_connection
from app.core.fastjson import json_response
from app.core.models import AuditLog, InventoryItem, Issue, IssueHistory, OMTask, Plant, SitePhoto, User, WashingConfig, WashingDailyReport, WashingTable
from app.core.security import get_current_user, require_csrf, user_scoped_plant_ids, ensure_plant_scope
from app.photos.imaging import PhotoSettings, header_matches, optimize_photo
from app.storage.service import SupabaseStorage
from app.storage.usage import adjust_bucket_usage, bucket_usage_bytes

router = APIRouter(prefix="/api/photos", tags=["Photo Intelligence"])
CATEGORIES = {"issue", "pm", "washing", "inventory", "safety", "other"}
LINK_TYPES = {"issue", "pm", "washing", "inventory"}
EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAX_FILES = 10
MAX_ISSUE_PHOTOS = 4   # one ticket's evidence; the Raise issue form offers the same four
MAX_SIZE = 15 * 1024 * 1024
MAX_WASHING_PDF_SIZE = 10 * 1024 * 1024
PHOTO_STORAGE_FULL = "Photo storage is full — contact an administrator."


def _role(user: User, write=False):
    allowed = {"O&M Head", "Assignee", "Site Engineer"} if write else {"O&M Head", "Assignee", "Site Engineer", "Administration"}
    if not user.is_active or user.role not in allowed:
        raise HTTPException(403, "Photo Intelligence is not available for this account")


def _plant(db: Session, user: User, plant_id: uuid.UUID) -> Plant:
    ensure_plant_scope(db, user, plant_id)
    plant = db.get(Plant, plant_id)
    if not plant:
        raise HTTPException(404, "Plant was not found")
    return plant


def _resolve_link(db: Session, plant_id: uuid.UUID, kind: str | None, ref: str | None):
    kind, ref = (kind or "").strip(), (ref or "").strip()
    if not kind and not ref:
        return None, None
    if kind not in LINK_TYPES or not ref or len(ref) > 120:
        raise HTTPException(422, "Choose a valid linked record or leave both fields empty")
    models = {
        "issue": (Issue, Issue.ticket_no),
        "pm": (OMTask, OMTask.work_order_no),
        "washing": (WashingDailyReport, WashingDailyReport.id),
        "inventory": (InventoryItem, InventoryItem.legacy_id),
    }
    model, field = models[kind]
    if kind == "washing":
        try:
            val = uuid.UUID(ref)
        except ValueError:
            raise HTTPException(422, "Choose a valid module cleaning report") from None
    else:
        val = ref
    obj = db.scalar(select(model).where(model.plant_id == plant_id, field == val))
    if not obj or (kind == "issue" and obj.deleted_at is not None):
        raise HTTPException(422, "Linked record was not found at the selected plant")
    return kind, ref


def _row(photo: SitePhoto, plant: Plant) -> dict:
    iso = photo.created_at
    if iso.tzinfo is None:
        iso = iso.replace(tzinfo=timezone.utc)
    issue = {"id": photo.link_id, "status": "Linked"} if photo.link_type == "issue" else None
    return {"id": str(photo.id), "source": "server", "plant": plant.plant_name, "plantId": str(plant.id),
            "category": photo.category, "description": photo.description or "", "tags": photo.tags or [],
            "uploader": photo.uploader_name, "uploadedAt": iso.isoformat(),
            "expiresAt": None, "status": "processed", "issue": issue,
            "linkType": photo.link_type, "linkId": photo.link_id,
            "inventoryId": photo.link_id if photo.link_type == "inventory" else "",
            "fileName": photo.file_name, "fileSize": photo.size_bytes, "previewUrl": None,
            "contentType": photo.content_type,
            "thumbnailUrl": f"/api/photos/{photo.id}/image?size=thumb",
            "originalUrl": f"/api/photos/{photo.id}/image?size=original",
            "thumbnailSizeBytes": photo.thumbnail_size_bytes,
            "width": photo.width, "height": photo.height,
            "originalPurgedAt": photo.original_purged_at.isoformat() if photo.original_purged_at else None,
            "phase": photo.phase, "slot": photo.slot}


@router.get("/plants")
def plants(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    _role(user)
    allowed = user_scoped_plant_ids(db, user)
    q = select(Plant).order_by(Plant.site_code)
    if allowed is not None:
        q = q.where(Plant.id.in_(allowed))
    return [{"id": str(p.id), "name": p.plant_name, "code": p.site_code} for p in db.scalars(q)]


@router.get("/links")
def links(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
          plant_id: uuid.UUID, kind: str, q: str = ""):
    _role(user)
    _plant(db, user, plant_id)
    if kind not in LINK_TYPES:
        raise HTTPException(422, "Unsupported link type")
    q = q.strip()[:80]
    if kind == "issue":
        stmt = select(Issue).where(Issue.plant_id == plant_id, Issue.deleted_at.is_(None))
        if q: stmt = stmt.where(or_(Issue.ticket_no.ilike(f"%{q}%"), Issue.description.ilike(f"%{q}%")))
        rows = db.scalars(stmt.order_by(Issue.created_at.desc()).limit(60))
        return [{"id": r.ticket_no, "label": f"{r.ticket_no} · {r.description[:65]}"} for r in rows]
    if kind == "pm":
        stmt = select(OMTask).where(OMTask.plant_id == plant_id)
        if q: stmt = stmt.where(or_(OMTask.work_order_no.ilike(f"%{q}%"), OMTask.task_name.ilike(f"%{q}%")))
        return [{"id": r.work_order_no, "label": f"{r.work_order_no} · {r.task_name[:65]}"} for r in db.scalars(stmt.order_by(OMTask.created_at.desc()).limit(60))]
    if kind == "washing":
        stmt = select(WashingDailyReport).where(WashingDailyReport.plant_id == plant_id)
        if q: stmt = stmt.where(WashingDailyReport.remarks.ilike(f"%{q}%"))
        return [{"id": str(r.id), "label": f"{r.report_date} · Cycle {r.cycle_no} · {r.job_status}"} for r in db.scalars(stmt.order_by(WashingDailyReport.report_date.desc()).limit(60))]
    stmt = select(InventoryItem).where(InventoryItem.plant_id == plant_id)
    if q: stmt = stmt.where(or_(InventoryItem.legacy_id.ilike(f"%{q}%"), InventoryItem.item_name.ilike(f"%{q}%")))
    return [{"id": r.legacy_id, "label": f"{r.item_name or 'Inventory'} · {r.sku or r.legacy_id}"} for r in db.scalars(stmt.order_by(InventoryItem.created_at.desc()).limit(60))]


@router.get("")
def list_photos(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
                plant: str = "all", q: str = "", category: str = "all", uploader: str = "all", issue: str = "all",
                link: str = "all", link_id: str | None = Query(None, max_length=120),
                window: str = "30d", sort: str = "newest", offset: int = Query(0, ge=0, le=5000), limit: int = Query(60, ge=1, le=120),
                meta: bool = True, cursor: str | None = Query(None, max_length=200),
                phase_slots: bool = False):
    _role(user)
    if phase_slots and (link != "washing" or not link_id):
        raise HTTPException(422, "Photo slot lookup requires a module cleaning report link")
    allowed = user_scoped_plant_ids(db, user)
    if allowed is not None and not allowed:
        return {"items": [], "total": 0, "summary": {"inWindow":0,"today":0,"awaiting":0,"unlinked":0}, "days": {}, "facets": {"uploaders":[],"issues":[]},
                "has_more": False, "next_cursor": None}
    now = datetime.now(timezone.utc)
    days = {"24h": 1, "7d": 7, "30d": 30, "all": None}.get(window, 30)
    stmt = select(SitePhoto).join(Plant, SitePhoto.plant_id == Plant.id)
    if days is not None: stmt = stmt.where(SitePhoto.created_at >= now-timedelta(days=days))
    if allowed is not None: stmt = stmt.where(SitePhoto.plant_id.in_(allowed))
    if plant != "all":
        stmt = stmt.where(or_(Plant.id == uuid.UUID(plant) if _valid_uuid(plant) else Plant.id == uuid.UUID(int=0), Plant.plant_name == plant))
    if category != "all": stmt = stmt.where(SitePhoto.category == category)
    if uploader != "all": stmt = stmt.where(SitePhoto.uploader_name == uploader)
    if issue == "linked": stmt = stmt.where(SitePhoto.link_type.is_not(None))
    elif issue == "unlinked": stmt = stmt.where(SitePhoto.link_type.is_(None))
    elif issue != "all": stmt = stmt.where(SitePhoto.link_type == "issue", SitePhoto.link_id == issue)
    if link != "all": stmt = stmt.where(SitePhoto.link_type == link)
    if link_id is not None:
        stmt = stmt.where(SitePhoto.link_id == link_id.strip())
    if phase_slots:
        # Match the washing-slot partial index so opening a daily record doesn't scan
        # the full evidence table as it grows.
        stmt = stmt.where(
            SitePhoto.category == "washing",
            SitePhoto.phase.is_not(None),
            SitePhoto.phase.in_(("before", "after")),
        )
    if q.strip():
        words = q.strip().split()[:8]
        for word in words:
            term = f"%{word[:70]}%"
            stmt = stmt.where(or_(SitePhoto.description.ilike(term), SitePhoto.file_name.ilike(term),
                                  SitePhoto.link_id.ilike(term), Plant.site_code.ilike(term),
                                  Plant.plant_name.ilike(term), SitePhoto.uploader_name.ilike(term),
                                  SitePhoto.tags.cast(Text).ilike(term)))
    oldest = sort == "oldest"
    # Stable order: time, then id for photos saved in the same instant (one submission shares a timestamp).
    ordered = stmt.order_by(*((SitePhoto.created_at.asc(), SitePhoto.id.asc()) if oldest else (SitePhoto.created_at.desc(), SitePhoto.id.desc())))
    page = ordered.add_columns(Plant)
    if cursor:
        # Keyset paging: continue after the last photo shown, however deep, and unaffected by new uploads.
        at, after_id = _decode_cursor(cursor)
        later = (SitePhoto.created_at > at) | ((SitePhoto.created_at == at) & (SitePhoto.id > after_id))
        earlier = (SitePhoto.created_at < at) | ((SitePhoto.created_at == at) & (SitePhoto.id < after_id))
        page = page.where(later if oldest else earlier)
    else:
        page = page.offset(offset)
    # The plant row comes back with each photo from the join already in the query (no second lookup).
    rows = db.execute(page.limit(limit + 1)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = [_row(photo, p) for photo, p in rows]
    paging = {"has_more": has_more, "next_cursor": _encode_cursor(rows[-1][0]) if has_more else None}
    if not meta:
        # A further page of a gallery that already has its totals, facets and day counts: rows only.
        return json_response({"items": items, **paging})
    # Aggregate within the filtered selection; never pull entire photo metadata into application memory.
    filtered = stmt.order_by(None).subquery()
    today_start = datetime.combine(now.date(), datetime.min.time(), tzinfo=timezone.utc)
    count, today, unlinked = db.execute(select(func.count(filtered.c.id),
        func.sum(case((filtered.c.created_at >= today_start, 1), else_=0)),
        func.sum(case((filtered.c.link_type.is_(None), 1), else_=0)))).one()
    count = int(count or 0)
    summary = {"inWindow": count, "today": int(today or 0), "awaiting": 0, "unlinked": int(unlinked or 0)}
    # Facets from the most recent 200 matches, three columns only; never an unbounded historical register.
    recent = db.execute(select(filtered.c.uploader_name, filtered.c.link_type, filtered.c.link_id)
                        .order_by(filtered.c.created_at.desc()).limit(200)).all()
    uploaders = sorted({name for name, _, _ in recent})
    issues = sorted({ref for _, kind, ref in recent if kind == "issue" and ref})
    dates = {str(date): int(n) for date,n in db.execute(
        select(func.date(filtered.c.created_at),func.count()).group_by(func.date(filtered.c.created_at)))}
    return json_response({"items": items, **paging, "total": count, "summary": summary, "days": dates,
                          "facets": {"uploaders": uploaders, "issues": [{"id": v, "status":"Linked"} for v in issues]}})


def _encode_cursor(photo: SitePhoto) -> str:
    return base64.urlsafe_b64encode(f"{photo.created_at.isoformat()}|{photo.id}".encode()).decode().rstrip("=")


def _decode_cursor(value: str) -> tuple[datetime, uuid.UUID]:
    try:
        at, ident = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode().split("|")
        return datetime.fromisoformat(at), uuid.UUID(ident)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(422, "Invalid page cursor; reload the gallery") from None


def _valid_uuid(s):
    try: uuid.UUID(s); return True
    except (ValueError, AttributeError): return False


def _admin(user: User) -> None:
    if not user.is_active or user.role not in {"O&M Head", "Administration"}:
        raise HTTPException(403, "Administrator access is required")


@router.get("/storage-usage")
def storage_usage(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
                  refresh: bool = False):
    _admin(user)
    release_connection(db)
    settings = get_settings()
    if not settings.storage_configured:
        # Not a failure: show the admin screen a clear configured=false state rather than an error.
        return {
            "configured": False, "used_bytes": None,
            "capacity_bytes": 1_000_000_000,
            "warn_bytes": settings.storage_warn_bytes,
            "block_bytes": settings.storage_block_bytes,
        }
    used = bucket_usage_bytes(SupabaseStorage(), force_refresh=refresh)
    return {
        "configured": True, "used_bytes": used,
        "capacity_bytes": 1_000_000_000,
        "warn_bytes": settings.storage_warn_bytes,
        "block_bytes": settings.storage_block_bytes,
    }


class RetentionWindow(BaseModel):
    days: int = Field(ge=7, le=365)


class RetentionPurge(BaseModel):
    """An optional age for this one sweep, and a dry run to show what it would remove."""
    older_than_days: int | None = Field(default=None, ge=1, le=365)
    dry_run: bool = False


@router.get("/retention")
def photo_retention(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    """The window originals are kept for, where it came from and who last changed it."""
    _admin(user)
    from app.photos.retention import retention_settings

    return retention_settings(db)


@router.put("/retention", dependencies=[Depends(require_csrf)])
def set_photo_retention(payload: RetentionWindow, db: Annotated[Session, Depends(get_db)],
                        user: Annotated[User, Depends(get_current_user)]):
    """Change how long originals are kept. Only the O&M Head, and nothing is deleted here."""
    if user.role != "O&M Head":
        raise HTTPException(403, "Only the O&M Head can change the photo retention window")
    from app.photos.retention import set_retention_days

    try:
        return set_retention_days(db, user, payload.days)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.post("/retention/purge", dependencies=[Depends(require_csrf)])
def manual_retention_purge(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
                           payload: RetentionPurge | None = None):
    _admin(user)
    from app.photos.retention import purge_photo_originals

    request = payload or RetentionPurge()
    try:
        return purge_photo_originals(db, dry_run=request.dry_run, older_than_days=request.older_than_days)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.delete("/{photo_id}", dependencies=[Depends(require_csrf)])
def delete_photo(photo_id: uuid.UUID, db: Annotated[Session, Depends(get_db)],
                 user: Annotated[User, Depends(get_current_user)]):
    _role(user, write=True)
    photo = db.get(SitePhoto, photo_id)
    if photo is None:
        raise HTTPException(404, "Photo not found")
    plant = _plant(db, user, photo.plant_id)
    link_type, link_id = photo.link_type, photo.link_id
    if photo.link_type == "washing":
        report = _check_washing_photo_write(db, user, link_id)
        report.evidence = [
            entry for entry in (report.evidence or [])
            if not isinstance(entry, dict) or entry.get("photo_id") != str(photo.id)
        ]
    elif photo.link_type == "issue":
        issue = db.scalar(select(Issue).where(Issue.ticket_no == link_id, Issue.deleted_at.is_(None)))
        if issue is None or issue.plant_id != plant.id:
            raise HTTPException(404, "Linked issue was not found")
        db.add(IssueHistory(
            issue_id=issue.id, action="issue.photo_removed",
            note="Removed linked evidence photo", actor_id=user.id,
            actor_name=user.display_name, metadata_json={"photo_id": str(photo_id)},
        ))
    elif photo.link_type == "washing":
        db.add(AuditLog(
            user_id=user.id, actor_name=user.display_name,
            action="Removed washing photo evidence", module="Washing",
            entity_type="washing_daily_report", entity_id=str(link_id),
            metadata_json={"photo_id": str(photo_id)},
        ))
    release_connection(db)
    paths = [path for path in (photo.storage_path, photo.thumbnail_path) if path]
    db.delete(photo)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    storage = SupabaseStorage()
    warning = None
    try:
        storage.remove_strict(paths)
        adjust_bucket_usage(storage, -photo.size_bytes - int(photo.thumbnail_size_bytes or 0))
    except HTTPException as exc:
        warning = exc.detail
    issue_photo_count = _sync_issue_photo_count(db, link_id) if link_type == "issue" else None
    return {"deleted": True, "cleanup_warning": warning, "issue_photo_count": issue_photo_count}


@router.get("/{photo_id}")
def detail(photo_id: uuid.UUID, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]):
    _role(user)
    obj = db.get(SitePhoto, photo_id)
    if not obj: raise HTTPException(404, "Photo not found")
    p = _plant(db, user, obj.plant_id)
    return _row(obj, p)


@router.get("/{photo_id}/image")
def image(photo_id: uuid.UUID, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)], size: str = "thumb"):
    if size not in {"thumb", "original"}: raise HTTPException(422, "Invalid image size")
    _role(user)
    obj = db.get(SitePhoto, photo_id)
    if not obj: raise HTTPException(404, "Photo not found")
    _plant(db, user, obj.plant_id)
    original_purged = size == "original" and obj.original_purged_at is not None
    path = obj.thumbnail_path if (size == "thumb" or original_purged) and obj.thumbnail_path else obj.storage_path
    release_connection(db)  # a gallery fetches several thumbnails at once; none of them may hold a pooled connection
    contents, mime = SupabaseStorage().download(path)
    headers = {"Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"}
    if original_purged:
        headers["X-Photo-Original-Purged"] = "true"
    if size == "original" and not original_purged and obj.content_type == "application/pdf":
        mime = "application/pdf"
        headers["Content-Disposition"] = 'attachment; filename="module-cleaning-evidence.pdf"'
    return Response(content=contents, media_type=mime, headers=headers)


def _photo_settings(category: str = "") -> PhotoSettings:
    s = get_settings()
    field_evidence = category.casefold() in {"washing", "issue"}
    return PhotoSettings(max_side=max(256, s.photo_max_side), quality=min(95, max(40, s.photo_webp_quality)),
                         thumb_side=480 if field_evidence else max(160, min(s.photo_thumb_side, s.photo_max_side)),
                         thumb_quality=65 if field_evidence else min(90, max(30, s.photo_thumb_quality)),
                         method=min(6, max(0, s.photo_webp_method)))


def _pdf_thumbnail(settings: PhotoSettings) -> bytes:
    width = settings.thumb_side
    height = round(width * 3 / 4)
    image = Image.new("RGB", (width, height), "#f1f4f8")
    draw = ImageDraw.Draw(image)
    left, top = round(width * 0.35), round(height * 0.12)
    right, bottom = round(width * 0.65), round(height * 0.88)
    draw.rounded_rectangle((left, top, right, bottom), radius=max(4, width // 40),
                           fill="#ffffff", outline="#cbd5e1", width=max(1, width // 160))
    draw.polygon(
        [(right - width // 12, top), (right, top + height // 10), (right - width // 12, top + height // 10)],
        fill="#e2e8f0",
    )
    badge_top = top + height // 3
    draw.rounded_rectangle((left, badge_top, right, badge_top + height // 5),
                           radius=max(3, width // 60), fill="#b42318")
    line_left = left + width // 18
    line_right = right - width // 18
    for offset in (height // 2, height * 3 // 5, height * 7 // 10):
        draw.rounded_rectangle((line_left, top + offset, line_right, top + offset + max(2, width // 100)),
                               radius=max(1, width // 120), fill="#cbd5e1")
    output = BytesIO()
    image.save(output, format="WEBP", quality=settings.thumb_quality, method=settings.method)
    return output.getvalue()


def _check_washing_photo_write(db: Session, user: User, link_id: str | None) -> WashingDailyReport:
    try:
        report_id = uuid.UUID(link_id or "")
    except ValueError:
        raise HTTPException(422, "Choose a valid module cleaning report") from None
    report = db.get(WashingDailyReport, report_id)
    if report is None:
        raise HTTPException(404, "Daily module cleaning report not found")
    config = db.get(WashingConfig, report.plant_id)
    from app.scheduled.washing_cycles import _can_access_plant, _can_add_washing_evidence

    if not config or not _can_access_plant(db, user, report.plant_id, config):
        raise HTTPException(403, "This module cleaning report is outside your plant scope")
    if not _can_add_washing_evidence(user, report, config):
        raise HTTPException(403, "Only the report submitter, the O&M Head or this plant's module cleaning Assignee can add evidence before review")
    return report


def _sync_issue_photo_count(db: Session, ticket_no: str | None) -> int | None:
    if not ticket_no:
        return None
    issue = db.scalar(select(Issue).where(Issue.ticket_no == ticket_no).with_for_update())
    if issue is None:
        return None
    linked_count = db.scalar(select(func.count(SitePhoto.id)).where(
        SitePhoto.link_type == "issue", SitePhoto.link_id == ticket_no
    )) or 0
    legacy_count = len([
        entry for entry in (issue.legacy_payload or {}).get("evidence", [])
        if isinstance(entry, dict)
    ])
    issue.photo_count = int(linked_count) + legacy_count
    db.commit()
    return issue.photo_count


def _upload_size(file: UploadFile) -> int:
    handle = file.file
    handle.seek(0, 2); size = handle.tell(); handle.seek(0)
    return size


def _existing_submission(db: Session, user: User, submission: uuid.UUID, plant: Plant) -> list[dict] | None:
    rows = list(db.scalars(select(SitePhoto).where(SitePhoto.uploaded_by == user.id, SitePhoto.submission_id == submission)
                           .order_by(SitePhoto.submission_index)))
    if not rows:
        return None
    if any(r.plant_id != plant.id for r in rows):
        raise HTTPException(409, "This upload was already saved for a different plant")
    return [_row(r, plant) for r in rows]


@router.post("", status_code=201, dependencies=[Depends(require_csrf)])
def create_photos(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)],
                  plant_id: uuid.UUID = Form(...), category: str = Form(...), description: str = Form(""),
                  tags: str = Form("[]"), link_type: str = Form(""), link_id: str = Form(""),
                  submission_id: uuid.UUID | None = Form(None), phase: str | None = Form(None),
                  slot: int | None = Form(None),
                  files: list[UploadFile] = File(...)):
    _role(user, write=True)
    plant = _plant(db, user, plant_id)
    if category not in CATEGORIES: raise HTTPException(422, "Choose a valid photo category")
    if len(description) > 300: raise HTTPException(422, "Remark cannot exceed 300 characters")
    if not 1 <= len(files) <= MAX_FILES: raise HTTPException(422, "Choose between 1 and 10 photos")
    try: parsed_tags = json.loads(tags)
    except (ValueError, TypeError): raise HTTPException(422, "Invalid tags") from None
    if not isinstance(parsed_tags, list) or len(parsed_tags) > 8 or any(not isinstance(t, str) or not re.fullmatch(r"[a-z0-9-]{1,24}", t) for t in parsed_tags):
        raise HTTPException(422, "Use up to eight short tags")
    if submission_id and (saved := _existing_submission(db, user, submission_id, plant)) is not None:
        return JSONResponse({"records": saved, "persisted": True, "duplicate": True}, status_code=200)
    kind, ref = _resolve_link(db, plant.id, link_type, link_id)
    phase = (phase or "").strip().lower() or None
    washing_report = None
    if kind == "washing":
        if phase is not None or slot is not None:
            if category != "washing" or phase not in {"before", "after"} or slot is None:
                raise HTTPException(422, "Module cleaning photos require category, phase and slot")
            if slot not in {1, 2}:
                occupied = sorted(db.scalars(select(SitePhoto.slot).where(
                    SitePhoto.link_type == "washing", SitePhoto.link_id == ref,
                    SitePhoto.phase == phase, SitePhoto.slot.is_not(None)
                )))
                used = ", ".join(str(value) for value in occupied) or "none"
                raise HTTPException(409, f"Only slots 1 and 2 are available for {phase}; occupied slots: {used}")
            if len(files) != 1:
                raise HTTPException(409, f"Upload one photo at a time to {phase} slot {slot}")
            washing_report = _check_washing_photo_write(db, user, ref)
        elif category == "other":
            # A generic evidence attachment (no slot) through the daily-report evidence endpoint:
            # the stricter submitter/O&M-Head/Assignee-before-review rule still applies.
            washing_report = _check_washing_photo_write(db, user, ref)
        # category == "washing" with no phase/slot: a direct link from Photo Intelligence,
        # not a slotted evidence upload — the plant scope check above is enough.
    elif phase is not None or slot is not None:
        raise HTTPException(422, "Photo phase and slot are only valid for module cleaning")
    if kind == "issue":
        # A ticket carries at most four photos. The form caps it too, but a cap only the
        # browser applies is not a cap: this is what keeps the bucket's per-ticket cost fixed.
        attached = db.scalar(select(func.count(SitePhoto.id)).where(
            SitePhoto.link_type == "issue", SitePhoto.link_id == ref
        )) or 0
        if attached + len(files) > MAX_ISSUE_PHOTOS:
            raise HTTPException(
                409,
                f"A ticket can carry {MAX_ISSUE_PHOTOS} photos; {attached} are already attached",
            )
    if category == "washing" and kind != "washing":
        raise HTTPException(422, "Module cleaning photos must be linked to a daily report")
    # Cheap checks of every file (type, size, magic bytes) before anything is decoded or stored.
    for file in files:
        mime = (file.content_type or "").lower()
        size = _upload_size(file)
        if mime == "application/pdf":
            if category != "washing" or phase not in {"before", "after"} or slot not in {1, 2}:
                raise HTTPException(415, "PDF files are only allowed in module cleaning Before/After slots")
            if size > MAX_WASHING_PDF_SIZE:
                raise HTTPException(413, "Each module cleaning PDF must be 10 MB or smaller")
            if size < 8:
                raise HTTPException(422, "PDF file is empty or invalid")
        else:
            if mime not in EXTENSIONS:
                raise HTTPException(415, "Upload JPEG, PNG, WebP photos, or a PDF in a module cleaning slot")
            if size > MAX_SIZE:
                raise HTTPException(413, "Each photo must be 15 MB or smaller")
            if size < 32:
                raise HTTPException(422, "Photo is empty or invalid")
        head = file.file.read(16); file.file.seek(0)
        if mime == "application/pdf":
            if not head.startswith(b"%PDF-"):
                raise HTTPException(415, "The selected file is not a valid PDF")
        elif not header_matches(mime, head):
            raise HTTPException(415, "The selected file is not a valid JPEG, PNG, or WebP photo")
    # Checks are done: hand the pooled connection back while photos are decoded and sent to Storage.
    replacing = None
    if kind == "washing":
        if phase is not None:
            replacing = db.scalar(select(SitePhoto).where(
                SitePhoto.link_type == "washing", SitePhoto.link_id == ref,
                SitePhoto.phase == phase, SitePhoto.slot == slot
            ))
    release_connection(db)
    settings = _photo_settings(category)
    storage = SupabaseStorage()
    usage = bucket_usage_bytes(storage)
    uploaded: list[str] = []
    records: list[SitePhoto] = []
    old_paths = [path for path in (
        replacing.storage_path if replacing else None,
        replacing.thumbnail_path if replacing else None,
    ) if path]
    replaced_bytes = 0
    if replacing:
        replaced_bytes = (0 if replacing.original_purged_at else replacing.size_bytes) + int(replacing.thumbnail_size_bytes or 0)
    projected_usage = usage
    if replacing:
        projected_usage = max(0, projected_usage - replaced_bytes)
    try:
        # One photo at a time: only one original and its WebP copies are in memory, never the whole batch.
        for index, file in enumerate(files):
            mime = (file.content_type or "").lower()
            data = file.file.read(MAX_SIZE + 1)
            file.file.close()
            if mime == "application/pdf":
                thumbnail = _pdf_thumbnail(settings)
                stored_data = data
                stored_type = mime
                width = settings.thumb_side
                height = round(settings.thumb_side * 3 / 4)
                extension = ".pdf"
            else:
                photo = optimize_photo(data, mime, settings)
                stored_data = photo.data
                thumbnail = photo.thumbnail
                stored_type = photo.content_type
                width = photo.width
                height = photo.height
                extension = ".webp"
            del data
            projected_usage += len(stored_data) + len(thumbnail)
            app_settings = get_settings()
            if projected_usage > app_settings.storage_block_bytes:
                raise HTTPException(507, PHOTO_STORAGE_FULL)
            photo_id = uuid.uuid4()
            path = f"site-photos/{plant.id}/{photo_id}{extension}"
            storage.upload(path, stored_data, stored_type)
            uploaded.append(path)
            thumb_path = f"site-photo-thumbnails/{plant.id}/{photo_id}.webp"
            storage.upload(thumb_path, thumbnail, "image/webp")
            uploaded.append(thumb_path)
            if replacing is not None:
                db.delete(replacing)
                db.flush()
                replacing = None
            records.append(SitePhoto(id=photo_id, plant_id=plant.id, uploaded_by=user.id,
                            uploader_name=user.display_name, category=category, description=description.strip(),
                            tags=parsed_tags, link_type=kind, link_id=ref, storage_path=path, thumbnail_path=thumb_path,
                            file_name=(file.filename or ("evidence.pdf" if mime == "application/pdf" else "photo"))[:255],
                            content_type=stored_type, size_bytes=len(stored_data),
                            thumbnail_size_bytes=len(thumbnail), width=width, height=height,
                            phase=phase if kind == "washing" else None, slot=slot if kind == "washing" else None,
                            submission_id=submission_id, submission_index=index if submission_id else None))
            if mime != "application/pdf":
                del photo
            del stored_data, thumbnail
        db.add_all(records)
        db.flush()
        issue_photo_count = None
        if kind == "washing" and washing_report:
            retained = list(washing_report.evidence or [])
            if phase is not None:
                retained = [
                    entry for entry in retained
                    if not isinstance(entry, dict) or not (
                        entry.get("phase") == phase and entry.get("slot") == slot
                    )
                ]
            washing_report.evidence = retained + [{
                "id": str(photo.id),
                "photo_id": str(photo.id),
                "phase": photo.phase,
                "kind": photo.phase or "other",
                "slot": photo.slot,
                "at": photo.created_at.isoformat(),
                "by": user.display_name,
                "name": photo.file_name,
                "size": photo.size_bytes,
            } for photo in records]
            db.add(AuditLog(
                user_id=user.id, actor_name=user.display_name,
                action="Uploaded washing photo evidence", module="Washing",
                entity_type="washing_daily_report", entity_id=str(ref),
                metadata_json={"photo_ids": [str(photo.id) for photo in records]},
            ))
        if kind == "issue":
            issue = db.scalar(select(Issue).where(Issue.ticket_no == ref))
            if issue:
                db.add(IssueHistory(
                    issue_id=issue.id, action="issue.evidence_uploaded",
                    note=f"Uploaded {len(records)} evidence photo(s)",
                    actor_id=user.id, actor_name=user.display_name,
                    metadata_json={"photo_ids": [str(photo.id) for photo in records]},
                ))
            issue_photo_count = _sync_issue_photo_count(db, ref)
        result = [_row(x, plant) for x in records]
        db.commit()
        added_bytes = sum(record.size_bytes + int(record.thumbnail_size_bytes or 0) for record in records)
        adjust_bucket_usage(storage, added_bytes)
        cleanup_warning = None
        if old_paths:
            try:
                storage.remove_strict(old_paths)
                adjust_bucket_usage(storage, -replaced_bytes)
            except HTTPException as exc:
                cleanup_warning = exc.detail
        warning = "Photo storage is nearing its limit. Contact an administrator." if projected_usage > get_settings().storage_warn_bytes else None
        return {
            "records": result, "persisted": True, "storage_warning": warning,
            "cleanup_warning": cleanup_warning, "issue_photo_count": issue_photo_count,
        }
    except IntegrityError:
        # the same submission finished first in a parallel request: keep that one, discard this copy
        db.rollback()
        storage.remove(uploaded)
        saved = _existing_submission(db, user, submission_id, plant) if submission_id else None
        if saved is None: raise
        return JSONResponse({"records": saved, "persisted": True, "duplicate": True}, status_code=200)
    except Exception:
        db.rollback()
        storage.remove(uploaded)
        raise
