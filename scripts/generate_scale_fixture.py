"""Create a synthetic 1x/5x/10x SQLite fixture in the system temp directory only.

This is a local query/data-volume fixture, not a production seeder and not a substitute
for exercising the authenticated API against a staging deployment.
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
import tempfile
from uuid import uuid4


BASE_PROFILE = {
    "plants": 5,
    "equipment_per_plant": 2,
    "issues_per_plant": 20,
    "pm_tasks_per_plant": 15,
    "washing_tables_per_plant": 10,
    "washing_reports_per_plant": 8,
    "handovers_per_plant": 1,
    "items_per_handover": 3,
}


def seed_synthetic_data(db, scale: int, prefix: str = "LT") -> dict[str, int]:
    """Add a deterministic distribution (apart from IDs) to an empty test database."""
    if scale not in {1, 5, 10}:
        raise ValueError("scale must be 1, 5, or 10")

    from app.core.models import (
        Equipment, Handover, HandoverItem, Issue, OMTask, Plant, User,
        WashingConfig, WashingDailyReport, WashingHistory, WashingTable,
    )

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    today = date.today()
    user = User(
        auth_provider="synthetic",
        external_subject=f"{prefix}-assignee",
        email=f"{prefix.lower()}-assignee@example.invalid",
        display_name="Synthetic Assignee",
        role="Assignee",
        is_active=True,
    )
    db.add(user)
    db.flush()
    counts = {key: 0 for key in (
        "plants", "equipment", "issues", "pm_tasks", "washing_tables",
        "washing_history", "washing_reports", "handovers", "handover_items",
    )}

    for plant_no in range(1, BASE_PROFILE["plants"] * scale + 1):
        plant = Plant(
            site_code=f"{prefix}{plant_no:05d}",
            plant_name=f"Synthetic Plant {plant_no:05d}",
            status="active",
            source="synthetic-load-fixture",
        )
        db.add(plant)
        db.flush()
        counts["plants"] += 1
        db.add(WashingConfig(plant_id=plant.id, team=[user.display_name], assigned_user_id=user.id))
        equipment = [
            Equipment(
                plant_id=plant.id,
                equipment_code=f"{prefix}-{plant_no:05d}-INV-{n:02d}",
                equipment_name=f"Inverter {n:02d}",
                equipment_type="Inverter",
                status="active",
                quantity=1,
                in_charge_user_id=user.id,
            )
            for n in range(1, BASE_PROFILE["equipment_per_plant"] + 1)
        ]
        db.add_all(equipment)
        db.flush()
        counts["equipment"] += len(equipment)

        issues = []
        for n in range(BASE_PROFILE["issues_per_plant"] * scale):
            issues.append(Issue(
                ticket_no=f"{prefix}-{plant_no:05d}-ISS-{n:06d}",
                plant_id=plant.id,
                equipment_id=equipment[n % len(equipment)].id,
                equipment_ref=equipment[n % len(equipment)].equipment_code,
                description=f"Synthetic inverter observation {n % 7}",
                severity=("Critical", "High", "Medium", "Low")[n % 4],
                status=("Open", "Assigned", "In Progress", "Resolved")[n % 4],
                occurred_at=now - timedelta(days=n % 730),
                assigned_to=user.id,
                assignee_text=user.display_name,
                created_by=user.id,
            ))
        db.add_all(issues)
        counts["issues"] += len(issues)

        tasks = [
            OMTask(
                work_order_no=f"{prefix}-{plant_no:05d}-PM-{n:06d}",
                plant_id=plant.id,
                task_name=f"Synthetic preventive check {n % 5}",
                task_type="Inverter",
                equipment_ref=equipment[n % len(equipment)].equipment_code,
                due_on=today + timedelta(days=(n % 31) - 15),
                assignee_text=user.display_name,
                assignee_user_id=user.id,
                status=("Pending", "In Progress", "Completed")[n % 3],
                completion={"date": today.isoformat()} if n % 3 == 2 else None,
                evidence=[],
                log=[],
            )
            for n in range(BASE_PROFILE["pm_tasks_per_plant"] * scale)
        ]
        db.add_all(tasks)
        counts["pm_tasks"] += len(tasks)

        tables = [
            WashingTable(
                legacy_id=f"{prefix}-{plant_no:05d}-WT-{n:05d}",
                plant_id=plant.id,
                inverter_no=(n // 5) + 1,
                table_code=f"T-{n + 1:05d}",
                next_due_on=today + timedelta(days=n % 14),
                legacy_payload={"synthetic_fixture": True},
            )
            for n in range(BASE_PROFILE["washing_tables_per_plant"] * scale)
        ]
        db.add_all(tables)
        db.flush()
        counts["washing_tables"] += len(tables)
        histories = [
            WashingHistory(
                washing_table_id=table.id,
                event_type="washed",
                event_date=today - timedelta(days=index % 60),
                actor=user.display_name,
                payload={"synthetic_fixture": True},
            )
            for index, table in enumerate(tables)
        ]
        db.add_all(histories)
        counts["washing_history"] += len(histories)

        for n in range(BASE_PROFILE["washing_reports_per_plant"] * scale):
            db.add(WashingDailyReport(
                plant_id=plant.id,
                cycle_month=(today - timedelta(days=30 * (n % 12))).strftime("%Y-%m"),
                cycle_no=(n // 12) + 1,
                report_date=today - timedelta(days=n % 365),
                job_status=("Completed", "Partial", "Exception")[n % 3],
                tables_cleaned=n % (len(tables) + 1),
                cleaned_table_codes=[tables[n % len(tables)].table_code] if n % 2 == 0 else [],
                remarks="Synthetic scale fixture",
                evidence=[{
                    "id": str(uuid4()),
                    "file_name": "synthetic-evidence-metadata.png",
                    "content_type": "image/png",
                    "storage_path": f"synthetic-fixture/{prefix}/{plant_no}/{n}.png",
                    "synthetic_metadata_only": True,
                }] if n % 2 == 0 else [],
                reported_by_id=user.id,
                reported_by=user.display_name,
                review_status=("Pending", "Approved", "Rejected")[n % 3],
                reviewed_by_id=user.id if n % 3 else None,
                reviewed_by=user.display_name if n % 3 else None,
                reviewed_at=now if n % 3 else None,
                cycle_completed=n % 3 == 1,
            ))
            counts["washing_reports"] += 1

        for n in range(BASE_PROFILE["handovers_per_plant"] * scale):
            handover = Handover(
                legacy_id=f"{prefix}-{plant_no:05d}-HO-{n:04d}",
                handover_no=f"{prefix}-HOV-{plant_no:05d}-{n:04d}",
                plant_id=plant.id,
                project_name=f"Synthetic handover {plant_no}-{n}",
                status=("in_progress", "active_om", "pending_checklist")[n % 3],
                log=[],
                legacy_payload={"synthetic_fixture": True},
            )
            db.add(handover)
            db.flush()
            for item_no in range(BASE_PROFILE["items_per_handover"]):
                db.add(HandoverItem(
                    handover_id=handover.id,
                    legacy_id=f"{prefix}-{plant_no:05d}-{n:04d}-ITEM-{item_no:02d}",
                    title=f"Synthetic checklist item {item_no}",
                    status=("not_started", "submitted", "completed")[item_no % 3],
                    assignee_text=user.display_name,
                    evidence=[{"synthetic_metadata_only": True}] if item_no == 2 else [],
                ))
                counts["handover_items"] += 1
            counts["handovers"] += 1

        db.commit()
        if plant_no % 25 == 0:
            print(f"Seeded {plant_no} / {BASE_PROFILE['plants'] * scale} synthetic plants")

    db.commit()
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description="Build an isolated synthetic SQLite scale fixture.")
    parser.add_argument("--scale", type=int, choices=(1, 5, 10), required=True)
    parser.add_argument("--output", type=Path, help="New .sqlite3 file under the OS temp directory")
    parser.add_argument("--prefix", default="LT", help="Short synthetic ID prefix (letters/digits/hyphens)")
    args = parser.parse_args()
    if not args.prefix.replace("-", "").isalnum() or len(args.prefix) > 16:
        parser.error("--prefix must contain at most 16 letters, digits, or hyphens")

    temp_root = Path(tempfile.gettempdir()).resolve()
    output = args.output or (temp_root / f"solar91-scale-{args.scale}x-{uuid4().hex[:8]}.sqlite3")
    output = output.resolve()
    if output.suffix.lower() != ".sqlite3" or not output.is_relative_to(temp_root):
        parser.error("--output must be a .sqlite3 file within the system temporary directory")
    if output.exists():
        parser.error("Refusing to overwrite an existing fixture database")
    output.parent.mkdir(parents=True, exist_ok=True)

    os.environ["APP_ENV"] = "test"
    os.environ["DEBUG"] = "false"
    os.environ["DATABASE_URL"] = f"sqlite:///{output.as_posix()}"
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from app.core.database import Base, SessionLocal, engine
    import app.core.models  # Register the full ORM metadata before creating tables.

    Base.metadata.create_all(engine)
    try:
        with SessionLocal() as db:
            counts = seed_synthetic_data(db, args.scale, args.prefix)
        summary = {
            "database": str(output),
            "scale": f"{args.scale}x",
            "base_profile": BASE_PROFILE,
            "counts": counts,
            "total_records": sum(counts.values()),
            "evidence_files_uploaded": 0,
        }
        print(json.dumps(summary, indent=2))
    except Exception:
        engine.dispose()
        output.unlink(missing_ok=True)
        raise
    engine.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
