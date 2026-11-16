"""Storage API maintenance for full-resolution photo originals."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import release_connection
from app.core.models import SitePhoto
from app.storage.service import SupabaseStorage
from app.storage.usage import adjust_bucket_usage

logger = logging.getLogger("solar91.photos")


MAX_PHOTOS_PER_RUN = 5000


def purge_photo_originals(db: Session, *, dry_run: bool = False, batch_size: int = 100,
                          max_photos: int = MAX_PHOTOS_PER_RUN) -> dict:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=settings.photo_retention_days)
    # Oldest first, and never the whole table at once: a long-neglected backlog must not be
    # read into memory in one go. The sweep is idempotent, so the remainder goes on the next run.
    limit = max(1, int(max_photos))
    rows = list(db.execute(
        select(SitePhoto.id, SitePhoto.storage_path, SitePhoto.size_bytes)
        .where(
            SitePhoto.created_at < cutoff,
            SitePhoto.original_purged_at.is_(None),
            SitePhoto.thumbnail_path.is_not(None),
        )
        .order_by(SitePhoto.created_at, SitePhoto.id)
        .limit(limit)
    ))
    entries = [(photo_id, path, int(size or 0)) for photo_id, path, size in rows]
    more_remaining = len(entries) == limit
    bytes_reclaimed = sum(size for _, _, size in entries)
    if dry_run:
        result = {
            "dry_run": True,
            "photos": len(entries),
            "bytes_reclaimed": bytes_reclaimed,
            "retention_days": settings.photo_retention_days,
            "more_remaining": more_remaining,
        }
        logger.info("Photo retention dry run: photos=%s reclaimable_bytes=%s", len(entries), bytes_reclaimed)
        return result

    release_connection(db)
    storage = SupabaseStorage()
    purged = 0
    for offset in range(0, len(entries), max(1, batch_size)):
        batch = entries[offset:offset + max(1, batch_size)]
        storage.remove_strict([path for _, path, _ in batch])
        adjust_bucket_usage(storage, -sum(size for _, _, size in batch))
        ids = [photo_id for photo_id, _, _ in batch]
        db.execute(
            update(SitePhoto)
            .where(SitePhoto.id.in_(ids), SitePhoto.original_purged_at.is_(None))
            .values(original_purged_at=now)
        )
        db.commit()
        purged += len(batch)
    result = {
        "dry_run": False,
        "photos": purged,
        "bytes_reclaimed": bytes_reclaimed,
        "retention_days": settings.photo_retention_days,
        # True when this run hit its ceiling: run it again to continue the backlog.
        "more_remaining": more_remaining,
    }
    logger.info("Photo retention sweep: photos=%s bytes_reclaimed=%s", purged, bytes_reclaimed)
    return result
