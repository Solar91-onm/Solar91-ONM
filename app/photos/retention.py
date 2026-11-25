"""Storage API maintenance for full-resolution photo originals."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import release_connection
from app.core.models import AppSetting, AuditLog, SitePhoto, User
from app.storage.service import SupabaseStorage
from app.storage.usage import adjust_bucket_usage

logger = logging.getLogger("solar91.photos")


MAX_PHOTOS_PER_RUN = 5000

# How long a full-size original is kept. The deployment's PHOTO_RETENTION_DAYS is the default;
# an O&M Head can change it from Login access, and that choice is stored here (app_settings,
# the same place the issue deadlines live) so it survives a redeploy and is audited.
RETENTION_SETTING = "photo_retention_days"
MIN_RETENTION_DAYS = 7
MAX_RETENTION_DAYS = 365
# A manual sweep may reach further back than the standing window, but never to today's photos:
# an original uploaded this morning must still be downloadable at full size.
MIN_PURGE_DAYS = 1


def retention_days(db: Session) -> int:
    """The window in force: the stored value when it is valid, else the deployment default."""
    row = db.get(AppSetting, RETENTION_SETTING)
    value = row.setting_value if row is not None else None
    if isinstance(value, dict):
        value = value.get("days")
    try:
        days = int(value)
    except (TypeError, ValueError):
        return get_settings().photo_retention_days
    return days if MIN_RETENTION_DAYS <= days <= MAX_RETENTION_DAYS else get_settings().photo_retention_days


def retention_settings(db: Session) -> dict:
    row = db.get(AppSetting, RETENTION_SETTING)
    author = db.get(User, row.updated_by) if row is not None and row.updated_by else None
    return {
        "days": retention_days(db),
        "default_days": get_settings().photo_retention_days,
        "min_days": MIN_RETENTION_DAYS,
        "max_days": MAX_RETENTION_DAYS,
        "min_purge_days": MIN_PURGE_DAYS,
        "source": "portal" if row is not None else "deployment",
        "updated_by": author.display_name if author else None,
        "updated_at": row.updated_at.isoformat() if row is not None and row.updated_at else None,
    }


def set_retention_days(db: Session, user: User, days: int) -> dict:
    """Store the window and record who changed it. Nothing is deleted by this call."""
    if not MIN_RETENTION_DAYS <= int(days) <= MAX_RETENTION_DAYS:
        raise ValueError(f"Keep originals for {MIN_RETENTION_DAYS}-{MAX_RETENTION_DAYS} days")
    before = retention_days(db)
    row = db.get(AppSetting, RETENTION_SETTING)
    if row is None:
        db.add(AppSetting(setting_key=RETENTION_SETTING, setting_value={"days": int(days)}, updated_by=user.id))
    else:
        row.setting_value = {"days": int(days)}
        row.updated_by = user.id
    db.add(AuditLog(
        user_id=user.id, actor_name=user.display_name, action="Changed photo retention window",
        module="Photos", entity_type="app_setting", entity_id=RETENTION_SETTING,
        before_state={"days": before}, after_state={"days": int(days)},
    ))
    db.commit()
    return retention_settings(db)


def purge_photo_originals(db: Session, *, dry_run: bool = False, batch_size: int = 100,
                          max_photos: int = MAX_PHOTOS_PER_RUN,
                          older_than_days: int | None = None) -> dict:
    """Delete full-size originals older than the window; thumbnails and photo records stay.

    ``older_than_days`` runs this one sweep against a different age than the standing window —
    what Login access sends when an administrator clears space ahead of time. It is bounded the
    same way the setting is, so no call can reach today's uploads.
    """
    if older_than_days is None:
        days = retention_days(db)
    else:
        days = int(older_than_days)
        if not MIN_PURGE_DAYS <= days <= MAX_RETENTION_DAYS:
            raise ValueError(f"Purge originals older than {MIN_PURGE_DAYS}-{MAX_RETENTION_DAYS} days")
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days)
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
            "retention_days": days,
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
        "retention_days": days,
        # True when this run hit its ceiling: run it again to continue the backlog.
        "more_remaining": more_remaining,
    }
    logger.info("Photo retention sweep: photos=%s bytes_reclaimed=%s", purged, bytes_reclaimed)
    return result
