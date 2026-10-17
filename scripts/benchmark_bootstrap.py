"""Measure start-up and refresh API cost on a production-like synthetic SQLite database.

Safety: the database is always a fresh file inside a TemporaryDirectory; the script accepts no
database URL, never reads .env credentials, and never contacts Supabase, Clerk or Render.

What it reports per endpoint and role: p50/p95 wall time inside the app, database time and query
count (from the app's own Server-Timing header), raw and gzip payload size. SQLite runs in-process,
so database round trips cost microseconds here. ``--rtt-ms`` adds an *estimate* of network cost for
a remote database (queries x round-trip time); it is labelled as an estimate in the output and is
not a measurement of Supabase.

Example:
    python scripts/benchmark_bootstrap.py --runs 15 --rtt-ms 60 --json-out bootstrap.json
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from contextlib import redirect_stdout
from datetime import date, datetime, timedelta, timezone
import gzip
import io
import json
import logging
import os
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
from time import perf_counter
import uuid

PROFILE = {
    "plants": 100,
    "equipment_per_plant": 4,
    "issues_per_plant": 40,
    "closed_share": 0.6,
    "tasks_per_plant": 40,
    "tables_per_plant": 60,
    "history_per_table": 6,
    "reports_per_plant": 20,
    "notifications": 1500,
    "audit_rows": 800,
}


def percentile(values: list[float], pct: int) -> float:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, (len(ordered) * pct + 99) // 100 - 1))
    return round(ordered[index], 1)


def _metric(header: str, name: str) -> float | None:
    match = re.search(rf"(?:^|,\s*){re.escape(name)};dur=([0-9.]+)", header)
    return float(match.group(1)) if match else None


def _queries(header: str) -> int | None:
    match = re.search(r'db;dur=[0-9.]+;desc="(\d+) queries"', header)
    return int(match.group(1)) if match else None


def seed(db, profile: dict) -> dict[str, int]:
    from sqlalchemy import insert
    from app.core.models import (
        AuditLog, Equipment, Issue, Notification, OMTask, Plant, User, UserEquipmentTypeAssignment,
        UserPlantAssignment, WashingConfig, WashingDailyReport, WashingHistory, WashingTable,
    )
    try:
        from app.core.timeutil import business_today
    except ImportError:  # older releases (used for before/after comparisons)
        business_today = date.today

    now = datetime.now(timezone.utc)
    today = business_today()
    head = User(id=uuid.uuid4(), auth_provider="synthetic", external_subject="bench-head", email="head@example.invalid",
                display_name="Bench Head", role="O&M Head", is_active=True)
    assignee = User(id=uuid.uuid4(), auth_provider="synthetic", external_subject="bench-assignee",
                    email="assignee@example.invalid", display_name="Bench Assignee", role="Assignee", is_active=True)
    engineer = User(id=uuid.uuid4(), auth_provider="synthetic", external_subject="bench-engineer",
                    email="engineer@example.invalid", display_name="Bench Engineer", role="Site Engineer", is_active=True)
    db.add_all([head, assignee, engineer])
    db.flush()
    db.add_all([UserEquipmentTypeAssignment(user_id=assignee.id, equipment_type="Inverter"),
                UserEquipmentTypeAssignment(user_id=assignee.id, equipment_type="Modules cleaning")])
    counts: dict[str, int] = defaultdict(int)
    plants, equipment, issues, tasks, tables, history, reports, configs = [], [], [], [], [], [], [], []
    for p in range(profile["plants"]):
        pid = uuid.uuid4()
        plants.append({"id": pid, "site_code": f"BN{p:04d}", "plant_name": f"Bench Plant {p:04d}", "status": "active",
                       "dc_capacity_kw": 2000, "ac_capacity_kw": 1600, "source": "benchmark", "custom_fields": {},
                       "legacy_payload": {}})
        configs.append({"id": uuid.uuid4(), "plant_id": pid, "team": ["Bench Assignee"], "assigned_user_id": assignee.id,
                        "frequency_days": 10, "active": True, "cycle_overrides": {}})
        eq_ids = []
        for e in range(profile["equipment_per_plant"]):
            eid = uuid.uuid4(); eq_ids.append((eid, f"BN{p:04d}-INV-{e:02d}"))
            equipment.append({"id": eid, "plant_id": pid, "equipment_code": f"BN{p:04d}-INV-{e:02d}",
                              "equipment_name": f"Inverter {e:02d}", "equipment_type": "Inverter", "status": "active",
                              "quantity": 1, "metadata_json": {}})
        closed_cut = int(profile["issues_per_plant"] * profile["closed_share"])
        for n in range(profile["issues_per_plant"]):
            eid, code = eq_ids[n % len(eq_ids)]
            created = now - timedelta(days=(n * 7) % 700, hours=n % 24)
            issues.append({"id": uuid.uuid4(), "ticket_no": f"BN{p:04d}-ISS-{n:05d}", "plant_id": pid, "equipment_id": eid,
                           "equipment_ref": code, "vertical": "Inverter", "description": f"Inverter fault pattern {n % 9}",
                           "severity": ("Critical", "High", "Medium", "Low")[n % 4],
                           "status": "Closed" if n < closed_cut else ("Open", "Assigned", "In Progress", "Resolved")[n % 4],
                           "occurred_at": created, "created_at": created, "updated_at": created + timedelta(hours=6),
                           "etc_at": created + timedelta(hours=48), "assigned_to": assignee.id, "assignee_text": "Bench Assignee",
                           "created_by": head.id, "photo_count": 0, "reopen_count": 0,
                           "legacy_payload": {"evidence": [], "history": [{"at": created.isoformat(), "text": "Raised"}]}})
        for n in range(profile["tasks_per_plant"]):
            tasks.append({"id": uuid.uuid4(), "work_order_no": f"BN{p:04d}-PM-{n:05d}", "plant_id": pid,
                          "task_name": f"Preventive check {n % 6}", "task_type": "Inverter",
                          "equipment_ref": eq_ids[n % len(eq_ids)][1], "frequency": "Monthly",
                          "due_on": today + timedelta(days=(n % 60) - 30), "assignee_text": "Bench Assignee",
                          "assignee_user_id": assignee.id, "status": ("Scheduled", "In Progress", "Completed")[n % 3],
                          "evidence": [], "log": [{"at": now.isoformat(), "text": "Created", "actor": "System"}],
                          "legacy_payload": {}})
        for t in range(profile["tables_per_plant"]):
            tid = uuid.uuid4()
            tables.append({"id": tid, "legacy_id": f"BN{p:04d}-WT-{t:04d}", "plant_id": pid, "inverter_no": t // 10 + 1,
                           "table_code": f"T-{t + 1:04d}", "next_due_on": today + timedelta(days=t % 10),
                           "legacy_payload": {"inv": t // 10 + 1}})
            for h in range(profile["history_per_table"]):
                history.append({"id": uuid.uuid4(), "washing_table_id": tid, "event_type": "wash",
                                "event_date": today - timedelta(days=10 * h + t % 10), "actor": "Bench Engineer",
                                "payload": {"cycle": h}})
        for r in range(profile["reports_per_plant"]):
            day = today - timedelta(days=r * 3)
            reports.append({"id": uuid.uuid4(), "plant_id": pid, "cycle_month": day.strftime("%Y-%m"), "cycle_no": 1 + (r % 3),
                            "report_date": day, "job_status": "Done", "tables_cleaned": 5, "cleaned_table_codes": [],
                            "evidence": [], "reported_by_id": engineer.id, "reported_by": "Bench Engineer",
                            "review_status": ("Pending", "Confirmed")[r % 2], "cycle_completed": False})
    db.execute(insert(Plant), plants)
    db.add(UserPlantAssignment(user_id=engineer.id, plant_id=plants[0]["id"], assignment_role="Site Engineer"))
    for model, rows in ((WashingConfig, configs), (Equipment, equipment), (Issue, issues), (OMTask, tasks),
                        (WashingTable, tables), (WashingHistory, history), (WashingDailyReport, reports)):
        for start in range(0, len(rows), 5000):
            db.execute(insert(model), rows[start:start + 5000])
        counts[model.__tablename__] = len(rows)
    notes = [{"id": uuid.uuid4(), "user_id": head.id if n % 2 else None, "title": f"Event {n}", "message": "Synthetic",
              "event_type": "issue_assigned", "payload": {}, "created_at": now - timedelta(minutes=n)}
             for n in range(profile["notifications"])]
    db.execute(insert(Notification), notes); counts["notifications"] = len(notes)
    audit = [{"id": uuid.uuid4(), "user_id": head.id, "actor_name": "Bench Head", "action": "Synthetic action",
              "module": "Bench", "metadata_json": {}, "created_at": now - timedelta(minutes=n)} for n in range(profile["audit_rows"])]
    db.execute(insert(AuditLog), audit); counts["audit_logs"] = len(audit)
    db.commit()
    return dict(counts), {"head": head.id, "assignee": assignee.id, "engineer": engineer.id}


ENDPOINTS = {
    "head": [
        ("GET", "/api/bootstrap"),
        ("GET", "/api/bootstrap?lite=1"),
        ("GET", "/api/issues/pulse"),
        ("GET", "/api/scheduled/washing/overview"),
        ("GET", "/api/scheduled/tasks"),
        ("GET", "/api/field/overview"),
        ("GET", "/api/issues?limit=50"),
        ("GET", "/api/equipment/page?page=1&page_size=50"),
        ("GET", "/api/users"),
        ("GET", "/api/issues/assignees"),
    ],
    "assignee": [
        ("GET", "/api/bootstrap"),
        ("GET", "/api/bootstrap?lite=1"),
        ("GET", "/api/issues/pulse"),
        ("GET", "/api/scheduled/tasks"),
    ],
    "engineer": [
        ("GET", "/api/bootstrap"),
        ("GET", "/api/bootstrap?lite=1"),
        ("GET", "/api/issues/pulse"),
        ("GET", "/api/field/overview"),
        ("GET", "/api/scheduled/washing/overview"),
    ],
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--runs", type=int, default=15)
    parser.add_argument("--scale", type=float, default=1.0, help="multiplier for the per-plant profile (0.1-5)")
    parser.add_argument("--rtt-ms", type=float, default=0.0, help="assumed DB round trip for the labelled estimate column")
    parser.add_argument("--json-out", type=Path)
    args = parser.parse_args()
    if not 3 <= args.runs <= 200 or not 0.1 <= args.scale <= 5:
        parser.error("--runs must be 3-200 and --scale 0.1-5")
    profile = {k: (max(1, int(v * args.scale)) if isinstance(v, int) and k != "plants" else v) for k, v in PROFILE.items()}

    with TemporaryDirectory(prefix="solar91-bootstrap-bench-") as temp_dir:
        database = (Path(temp_dir) / "bench.sqlite3").resolve()
        os.environ.update({"APP_ENV": "test", "DEBUG": "false", "PM_DAILY_JOB": "0",
                           "DATABASE_URL": f"sqlite:///{database.as_posix()}"})
        root = Path(__file__).resolve().parents[1]
        sys.path.insert(0, str(root))
        logging.disable(logging.WARNING)
        from fastapi.testclient import TestClient
        from app.core.database import Base, SessionLocal, engine
        from app.core.models import User
        from app.core.security import get_current_user
        from app.main import app as fastapi_app

        Base.metadata.create_all(engine)
        started = perf_counter()
        with SessionLocal() as db, redirect_stdout(io.StringIO()):
            counts, user_ids = seed(db, profile)
        seed_s = perf_counter() - started
        current: dict[str, uuid.UUID] = {}

        def bench_user():
            with SessionLocal() as db:
                user = db.get(User, current["id"])
                db.expunge(user)
                return user

        fastapi_app.dependency_overrides[get_current_user] = bench_user
        results = []
        try:
            with TestClient(fastapi_app, headers={"Authorization": "Bearer benchmark"}) as client:
                for role, endpoints in ENDPOINTS.items():
                    current["id"] = user_ids[role]
                    for method, path in endpoints:
                        client.request(method, path)  # warm-up (imports, caches)
                        totals, dbs, queries, sizes, statuses = [], [], [], [], set()
                        for _ in range(args.runs):
                            response = client.request(method, path)
                            timing = response.headers.get("server-timing", "")
                            # Older releases reported the whole request as "app"; newer ones split app/db and add "total".
                            totals.append(_metric(timing, "total") or _metric(timing, "app") or 0.0)
                            dbs.append(_metric(timing, "db") or 0.0)
                            queries.append(_queries(timing) or 0)
                            sizes.append(len(response.content))
                            statuses.add(response.status_code)
                        body = response.content
                        row = {
                            "role": role, "method": method, "path": path, "status": sorted(statuses), "runs": args.runs,
                            "p50_ms": percentile(totals, 50), "p95_ms": percentile(totals, 95),
                            "db_p50_ms": percentile(dbs, 50), "queries": max(queries),
                            "raw_kb": round(len(body) / 1024, 1), "gzip_kb": round(len(gzip.compress(body, 9)) / 1024, 1),
                        }
                        if args.rtt_ms:
                            row["est_remote_db_ms"] = round(row["queries"] * args.rtt_ms)
                        results.append(row)
        finally:
            fastapi_app.dependency_overrides.pop(get_current_user, None)
            engine.dispose()

    report = {"profile": profile, "rows_seeded": counts, "seed_seconds": round(seed_s, 1), "runs": args.runs,
              "rtt_ms_assumed": args.rtt_ms, "environment": "in-process FastAPI TestClient + SQLite (temp file)",
              "results": results}
    print(f"Seeded {counts} in {seed_s:.1f}s; {args.runs} runs per endpoint; SQLite in-process.")
    header = f"{'role':9} {'endpoint':42} {'p50':>7} {'p95':>7} {'db50':>6} {'qry':>4} {'raw KB':>8} {'gz KB':>7}"
    if args.rtt_ms:
        header += f" {'est+RTT':>8}"
    print(header)
    for row in results:
        line = (f"{row['role']:9} {row['method']+' '+row['path']:42.42} {row['p50_ms']:7.1f} {row['p95_ms']:7.1f} "
                f"{row['db_p50_ms']:6.1f} {row['queries']:4d} {row['raw_kb']:8.1f} {row['gzip_kb']:7.1f}")
        if args.rtt_ms:
            line += f" {row['est_remote_db_ms']:8d}"
        print(line + ("" if row["status"] == [200] else f"  status={row['status']}"))
    if args.rtt_ms:
        print(f"est+RTT = queries x {args.rtt_ms:g} ms assumed round trip. Estimate only; not measured against Supabase.")
    if args.json_out:
        args.json_out.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
