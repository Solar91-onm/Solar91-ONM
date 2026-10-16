"""Measure representative read-query latency on a generated SQLite scale fixture."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
from time import perf_counter


def percentile(values: list[float], pct: int) -> float:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, (len(ordered) * pct + 99) // 100 - 1))
    return round(ordered[index], 3)


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark representative reads on an isolated scale fixture.")
    parser.add_argument("database", type=Path)
    parser.add_argument("--runs", type=int, default=50)
    parser.add_argument("--prefix", default="LT")
    args = parser.parse_args()
    if not 10 <= args.runs <= 1000:
        parser.error("--runs must be between 10 and 1000")
    temp_root = Path(tempfile.gettempdir()).resolve()
    database = args.database.resolve()
    if not database.is_relative_to(temp_root) or not database.name.startswith("solar91-scale-") or database.suffix != ".sqlite3":
        parser.error("database must be a generated solar91-scale-*.sqlite3 file under the OS temp directory")
    if not database.is_file():
        parser.error("fixture database does not exist")
    if not args.prefix.replace("-", "").isalnum() or len(args.prefix) > 16:
        parser.error("--prefix must contain at most 16 letters, digits, or hyphens")

    os.environ["APP_ENV"] = "test"
    os.environ["DEBUG"] = "false"
    os.environ["DATABASE_URL"] = f"sqlite:///{database.as_posix()}"
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from sqlalchemy import func, select
    from app.core.database import SessionLocal, engine
    from app.core.models import Issue, OMTask, Plant, WashingDailyReport
    import app.core.models  # noqa: F401

    prefix_like = f"{args.prefix}%"
    operations = {
        "plant_page_25": lambda db: db.execute(
            select(Plant.id, Plant.site_code, Plant.plant_name)
            .where(Plant.site_code.like(prefix_like))
            .order_by(Plant.plant_name, Plant.id).limit(25)
        ).all(),
        "issue_page_50": lambda db: db.execute(
            select(Issue.id, Issue.ticket_no, Issue.status, Issue.severity, Issue.occurred_at)
            .join(Plant, Plant.id == Issue.plant_id)
            .where(Plant.site_code.like(prefix_like))
            .order_by(Issue.occurred_at.desc(), Issue.id.desc()).limit(50)
        ).all(),
        "issue_status_summary": lambda db: db.execute(
            select(Issue.status, func.count(Issue.id))
            .join(Plant, Plant.id == Issue.plant_id)
            .where(Plant.site_code.like(prefix_like)).group_by(Issue.status)
        ).all(),
        "washing_plant_summary": lambda db: db.execute(
            select(WashingDailyReport.plant_id, func.count(WashingDailyReport.id),
                   func.sum(WashingDailyReport.tables_cleaned))
            .join(Plant, Plant.id == WashingDailyReport.plant_id)
            .where(Plant.site_code.like(prefix_like)).group_by(WashingDailyReport.plant_id)
        ).all(),
        "pm_status_summary": lambda db: db.execute(
            select(OMTask.status, func.count(OMTask.id))
            .join(Plant, Plant.id == OMTask.plant_id)
            .where(Plant.site_code.like(prefix_like)).group_by(OMTask.status)
        ).all(),
    }
    timings: dict[str, list[float]] = {name: [] for name in operations}
    try:
        with SessionLocal() as db:
            for operation in operations.values():
                operation(db)  # warm-up
            for _ in range(args.runs):
                for name, operation in operations.items():
                    started = perf_counter()
                    operation(db)
                    timings[name].append((perf_counter() - started) * 1000)
            counts = {
                "plants": db.scalar(select(func.count()).select_from(Plant).where(Plant.site_code.like(prefix_like))),
                "issues": db.scalar(select(func.count()).select_from(Issue).join(Plant).where(Plant.site_code.like(prefix_like))),
                "pm_tasks": db.scalar(select(func.count()).select_from(OMTask).join(Plant).where(Plant.site_code.like(prefix_like))),
                "washing_reports": db.scalar(select(func.count()).select_from(WashingDailyReport).join(Plant).where(Plant.site_code.like(prefix_like))),
            }
    finally:
        engine.dispose()

    output = {
        "database": str(database),
        "database_engine": "SQLite (local fixture only)",
        "runs_per_query": args.runs,
        "row_counts": counts,
        "latency_ms": {
            name: {"p50": percentile(values, 50), "p95": percentile(values, 95), "p99": percentile(values, 99)}
            for name, values in timings.items()
        },
        "limitations": "Single-process SQLite read microbench; excludes HTTP, auth, writes, upload, PostgreSQL, and concurrency.",
    }
    print(json.dumps(output, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
