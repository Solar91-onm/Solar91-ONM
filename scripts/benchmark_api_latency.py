"""Measure authenticated FastAPI reads on a fresh synthetic SQLite database only."""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
from collections import defaultdict
import io
import json
import logging
import os
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
from time import perf_counter


def percentile(values: list[float], pct: int) -> float:
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, (len(ordered) * pct + 99) // 100 - 1))
    return round(ordered[index], 2)


def _metric(header: str, name: str) -> float | None:
    match = re.search(rf"(?:^|,\s*){re.escape(name)};dur=([0-9.]+)", header)
    return float(match.group(1)) if match else None


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark representative read APIs with isolated synthetic data.")
    parser.add_argument("--scale", type=int, choices=(1, 5, 10), required=True)
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--prefix", default="APILT")
    args = parser.parse_args()
    if not 10 <= args.runs <= 200:
        parser.error("--runs must be between 10 and 200")
    if not args.prefix.replace("-", "").isalnum() or len(args.prefix) > 16:
        parser.error("--prefix must contain at most 16 letters, digits, or hyphens")

    # This harness does not accept a URL or a caller-provided database path.
    with TemporaryDirectory(prefix="solar91-api-bench-") as temp_dir:
        database = (Path(temp_dir) / "synthetic.sqlite3").resolve()
        os.environ["APP_ENV"] = "test"
        os.environ["DEBUG"] = "false"
        os.environ["PM_DAILY_JOB"] = "0"
        os.environ["DATABASE_URL"] = f"sqlite:///{database.as_posix()}"
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        sys.path.insert(0, str(Path(__file__).resolve().parent))

        from sqlalchemy import func, select
        from fastapi.testclient import TestClient
        from app.core.database import Base, SessionLocal, engine
        from app.core.models import Issue, OMTask, Plant, User, UserEquipmentTypeAssignment
        from app.core.security import WASHING_TYPE, get_current_user
        from app.main import app as fastapi_app
        from generate_scale_fixture import seed_synthetic_data
        import app.core.models as _models  # noqa: F401

        logging.getLogger("httpx").setLevel(logging.WARNING)

        Base.metadata.create_all(engine)
        with SessionLocal() as db:
            with redirect_stdout(io.StringIO()):
                counts = seed_synthetic_data(db, args.scale, args.prefix)
            user = db.scalar(select(User).where(User.external_subject == f"{args.prefix}-assignee"))
            assert user is not None
            db.add_all([
                UserEquipmentTypeAssignment(user_id=user.id, equipment_type="Inverter"),
                UserEquipmentTypeAssignment(user_id=user.id, equipment_type=WASHING_TYPE),
            ])
            db.commit()
            user_id = user.id

        def synthetic_user():
            with SessionLocal() as db:
                result = db.get(User, user_id)
                assert result is not None
                return result

        old_override = fastapi_app.dependency_overrides.get(get_current_user)
        fastapi_app.dependency_overrides[get_current_user] = synthetic_user
        paths = [
            ("bootstrap_full", "/api/bootstrap"),
            ("bootstrap_lite", "/api/bootstrap?lite=1"),
            ("state_collections_issues", "/api/state/collections?keys=issues"),
            # what 34-live-refresh.js fetches when the issue pulse changes (it used to fetch bootstrap_lite)
            ("live_refresh_issues", "/api/state/collections?keys=plants,events,issues,equipment"),
            ("field_overview", "/api/field/overview?limit=15"),
            ("issue_list", "/api/issues?limit=50"),
            ("issue_pulse", "/api/issues/pulse"),
            ("scheduled_tasks", "/api/scheduled/tasks"),
            ("washing_overview", "/api/scheduled/washing/overview"),
            ("plant_list", "/api/plants?limit=50"),
            ("photo_list", "/api/photos?limit=60"),
        ]
        samples: dict[str, dict[str, list[float]]] = {
            name: defaultdict(list) for name, _ in paths
        }
        errors: dict[str, int] = {name: 0 for name, _ in paths}
        payload_bytes: dict[str, list[int]] = {name: [] for name, _ in paths}
        transfer_bytes: dict[str, list[int]] = {name: [] for name, _ in paths}
        status_codes: dict[str, set[int]] = {name: set() for name, _ in paths}
        try:
            with TestClient(fastapi_app) as client:
                for _, path in paths:
                    warm = client.get(path, headers={"Accept-Encoding": "gzip"})
                    if warm.status_code != 200:
                        raise RuntimeError(f"warm-up {path} returned HTTP {warm.status_code}: {warm.text[:200]}")
                for _ in range(args.runs):
                    for name, path in paths:
                        started = perf_counter()
                        response = client.get(path, headers={"Accept-Encoding": "gzip"})
                        wall_ms = (perf_counter() - started) * 1000
                        status_codes[name].add(response.status_code)
                        if response.status_code != 200:
                            errors[name] += 1
                            continue
                        payload_bytes[name].append(len(response.content))
                        # httpx decodes gzip for us; Content-Length is what actually crossed the network
                        transfer_bytes[name].append(int(response.headers.get("content-length") or len(response.content)))
                        timing = response.headers.get("server-timing", "")
                        samples[name]["wall_ms"].append(wall_ms)
                        for metric in ("total", "app", "db"):
                            value = _metric(timing, metric)
                            if value is not None:
                                samples[name][metric + "_ms"].append(value)
                        queries = re.search(r'desc="(\d+) queries"', timing)
                        if queries:
                            samples[name]["db_queries"].append(float(queries.group(1)))

            with SessionLocal() as db:
                row_counts = {
                    "plants": int(db.scalar(select(func.count()).select_from(Plant)) or 0),
                    "issues": int(db.scalar(select(func.count()).select_from(Issue)) or 0),
                    "pm_tasks": int(db.scalar(select(func.count()).select_from(OMTask)) or 0),
                    **counts,
                }
            results = {}
            for name, _ in paths:
                fields = {}
                for metric, values in samples[name].items():
                    fields[metric] = {
                        "p50": percentile(values, 50),
                        "p95": percentile(values, 95),
                    }
                fields["decoded_payload_bytes_p50"] = percentile(payload_bytes[name], 50) if payload_bytes[name] else None
                fields["transfer_bytes_p50"] = percentile(transfer_bytes[name], 50) if transfer_bytes[name] else None
                fields["status_codes"] = sorted(status_codes[name])
                fields["errors"] = errors[name]
                fields["samples"] = len(samples[name].get("wall_ms", []))
                results[name] = fields
            print(json.dumps({
                "environment": "local FastAPI TestClient + isolated SQLite; synthetic only",
                "scale": args.scale,
                "runs_per_endpoint": args.runs,
                "row_counts": row_counts,
                "results": results,
                "limitations": "One local process, warmed reads, no external network, PostgreSQL/Supabase, storage, browser render, or concurrent users. TestClient wall time is not production latency.",
            }, indent=2))
        finally:
            if old_override is None:
                fastapi_app.dependency_overrides.pop(get_current_user, None)
            else:
                fastapi_app.dependency_overrides[get_current_user] = old_override
            engine.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
