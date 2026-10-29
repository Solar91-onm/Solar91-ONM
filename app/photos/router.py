"""Authenticated, plant-scoped Photo Intelligence with private Supabase objects.

No public image URLs or browser-side service keys. Submissions are committed only after
all bytes are stored; on a partial failure, newly uploaded objects are cleaned up.
"""
from __future__ import annotations

import base64
import json
import re
from sqlalchemy import Text
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db, release_connection
from app.core.fastjson import json_response
from app.core.models import InventoryItem, Issue, OMTask, Plant, SitePhoto, User, WashingDailyReport, WashingTable
from app.core.security import get_current_user, require_csrf, user_scoped_plant_ids, ensure_plant_scope
from app.photos.imaging import PhotoSettings, header_matches, optimize_photo
from app.storage.service import SupabaseStorage

router = APIRouter(prefix="/api/photos", tags=["Photo Intelligence"])
CATEGORIES = {"issue", "pm", "washing", "inventory", "equipment", "safety", "other"}
LINK_TYPES = {"issue", "pm", "washing", "inventory"}
EXTENSIONS = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAX_FILES = 10
MAX_SIZE = 15 * 1024 * 1024
PHOTO_WINDOW = timedelta(days=30)


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
            raise HTTPException(422, "Choose a valid washing report") from None
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
            "equipmentId": photo.link_id if photo.link_type == "inventory" else "",
            "fileName": photo.file_name, "fileSize": photo.size_bytes, "previewUrl": None}


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
                link: str = "all", window: str = "30d", sort: str = "newest", offset: int = Query(0, ge=0, le=5000), limit: int = Query(60, ge=1, le=120),
                meta: bool = True, cursor: str | None = Query(None, max_length=200)):
    _role(user)
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
    path = obj.thumbnail_path if size == "thumb" and obj.thumbnail_path else obj.storage_path
    release_connection(db)  # a gallery fetches several thumbnails at once; none of them may hold a pooled connection
    contents, mime = SupabaseStorage().download(path)
    return Response(content=contents, media_type=mime, headers={"Cache-Control":"private, no-store", "X-Content-Type-Options":"nosniff"})


def _photo_settings() -> PhotoSettings:
    s = get_settings()
    return PhotoSettings(max_side=max(256, s.photo_max_side), quality=min(95, max(40, s.photo_webp_quality)),
                         thumb_side=max(160, min(s.photo_thumb_side, s.photo_max_side)),
                         thumb_quality=min(90, max(30, s.photo_thumb_quality)), method=min(6, max(0, s.photo_webp_method)))


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
                  submission_id: uuid.UUID | None = Form(None),
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
    # Cheap checks of every file (type, size, magic bytes) before anything is decoded or stored.
    for file in files:
        mime = (file.content_type or "").lower()
        if mime not in EXTENSIONS: raise HTTPException(415, "Upload JPEG, PNG, or WebP photos")
        size = _upload_size(file)
        if size > MAX_SIZE: raise HTTPException(413, "Each photo must be 15 MB or smaller")
        if size < 32: raise HTTPException(422, "Photo is empty or invalid")
        head = file.file.read(16); file.file.seek(0)
        if not header_matches(mime, head): raise HTTPException(415, "The selected file is not a valid JPEG, PNG, or WebP photo")
    # Checks are done: hand the pooled connection back while photos are decoded and sent to Storage.
    release_connection(db)
    settings = _photo_settings()
    storage = SupabaseStorage()
    uploaded: list[str] = []
    records: list[SitePhoto] = []
    try:
        # One photo at a time: only one original and its WebP copies are in memory, never the whole batch.
        for index, file in enumerate(files):
            mime = (file.content_type or "").lower()
            data = file.file.read(MAX_SIZE + 1)
            file.file.close()
            photo = optimize_photo(data, mime, settings)
            del data
            photo_id = uuid.uuid4()
            path = f"site-photos/{plant.id}/{photo_id}.webp"
            storage.upload(path, photo.data, photo.content_type)
            uploaded.append(path)
            thumb_path = f"site-photo-thumbnails/{plant.id}/{photo_id}.webp"
            storage.upload(thumb_path, photo.thumbnail, "image/webp")
            uploaded.append(thumb_path)
            records.append(SitePhoto(id=photo_id, plant_id=plant.id, uploaded_by=user.id,
                            uploader_name=user.display_name, category=category, description=description.strip(),
                            tags=parsed_tags, link_type=kind, link_id=ref, storage_path=path, thumbnail_path=thumb_path,
                            file_name=(file.filename or "photo")[:255], content_type=photo.content_type, size_bytes=len(photo.data),
                            submission_id=submission_id, submission_index=index if submission_id else None))
            del photo
        db.add_all(records)
        db.flush()
        result = [_row(x, plant) for x in records]
        db.commit()
        return {"records": result, "persisted": True}
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
