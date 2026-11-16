#!/usr/bin/env python3
"""Delete originals past the configured retention window; keep thumbnails and rows."""
from __future__ import annotations

import argparse
import logging

from app.core.database import SessionLocal
from app.photos.retention import purge_photo_originals


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Report eligible files without deleting them")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    with SessionLocal() as db:
        result = purge_photo_originals(db, dry_run=args.dry_run)
    print(
        f"{'Would purge' if args.dry_run else 'Purged'} {result['photos']} photo original(s); "
        f"{result['bytes_reclaimed']} bytes reclaimed; retention={result['retention_days']} days."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
