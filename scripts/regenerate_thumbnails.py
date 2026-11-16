#!/usr/bin/env python3
"""Regenerate field-evidence thumbnails at 480px / q65 when originals still exist."""
from __future__ import annotations

import argparse
import logging
import uuid

from fastapi import HTTPException
from sqlalchemy import select

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.core.models import SitePhoto
from app.photos.imaging import PhotoSettings, optimize_photo
from app.storage.service import SupabaseStorage
from app.storage.usage import adjust_bucket_usage, bucket_usage_bytes


def regenerate(*, dry_run: bool = False) -> dict[str, int]:
    with SessionLocal() as db:
        rows = list(db.scalars(select(SitePhoto).where(
            SitePhoto.category.in_(("washing", "issue")),
            SitePhoto.original_purged_at.is_(None),
            SitePhoto.thumbnail_path.is_not(None),
        ).order_by(SitePhoto.created_at, SitePhoto.id)))
        storage = SupabaseStorage()
        old_sizes = storage.object_sizes([row.thumbnail_path for row in rows if row.thumbnail_path])
        qualified = len(rows)
        if dry_run:
            old_bytes = sum(
                row.thumbnail_size_bytes or old_sizes.get(row.thumbnail_path or "", 0)
                for row in rows
            )
            result = {
                "photos": qualified,
                "bytes_reclaimed": int(old_bytes * 0.43),
                "dry_run": 1,
            }
            logging.getLogger("solar91.photos").info(
                "Thumbnail regeneration dry run: photos=%s estimated_bytes_reclaimed=%s",
                qualified, result["bytes_reclaimed"],
            )
            return result

        used = bucket_usage_bytes(storage)
        settings = get_settings()
        photo_settings = PhotoSettings(
            max_side=max(256, settings.photo_max_side),
            quality=min(95, max(40, settings.photo_webp_quality)),
            thumb_side=480,
            thumb_quality=65,
            method=min(6, max(0, settings.photo_webp_method)),
        )
        reclaimed = 0
        replaced = 0
        for row in rows:
            data, mime = storage.download(row.storage_path)
            photo = optimize_photo(data, mime, photo_settings)
            previous_size = row.thumbnail_size_bytes or old_sizes.get(row.thumbnail_path or "", 0)
            next_path = f"site-photo-thumbnails/{row.plant_id}/{row.id}-{uuid.uuid4()}.webp"
            next_size = len(photo.thumbnail)
            projected = used + next_size
            if projected > settings.storage_block_bytes:
                raise RuntimeError("Photo storage is full; thumbnail regeneration stopped before replacing the existing thumbnail.")
            storage.upload(next_path, photo.thumbnail, "image/webp")
            old_path = row.thumbnail_path
            row.thumbnail_path = next_path
            row.thumbnail_size_bytes = next_size
            row.width = photo.width
            row.height = photo.height
            db.commit()
            adjust_bucket_usage(storage, next_size)
            if old_path:
                try:
                    storage.remove_strict([old_path])
                    adjust_bucket_usage(storage, -previous_size)
                    used = max(0, used - previous_size) + next_size
                    reclaimed += max(0, previous_size - next_size)
                except HTTPException:
                    used += next_size
                    logging.getLogger("solar91.photos").exception(
                        "Could not remove the replaced thumbnail for photo %s", row.id
                    )
            else:
                used += next_size
            replaced += 1
        result = {"photos": replaced, "bytes_reclaimed": reclaimed, "dry_run": 0}
        logging.getLogger("solar91.photos").info(
            "Thumbnail regeneration complete: photos=%s bytes_reclaimed=%s",
            replaced, reclaimed,
        )
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Report eligible rows and estimated savings only")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    result = regenerate(dry_run=args.dry_run)
    qualifier = "estimated " if args.dry_run else ""
    print(
        f"{'Would regenerate' if args.dry_run else 'Regenerated'} {result['photos']} thumbnail(s); "
        f"{qualifier}{result['bytes_reclaimed']} bytes reclaimed."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
