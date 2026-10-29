"""Compare JSON serialisers on a synthetic issue/PM-sized payload (local CPU only, no network or database).

Run: python scripts/benchmark_json.py [--rows 15000]
Measures FastAPI's default path (jsonable_encoder + JSONResponse), app/core/fastjson.json_response, and orjson when
it happens to be installed (it is NOT a project dependency), plus gzip level 6 vs 9 size and time for the result.
"""
from __future__ import annotations

import argparse
import gzip
import json
import statistics
import sys
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from time import perf_counter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from app.core.fastjson import json_response


def payload(rows: int) -> dict:
    now = datetime(2026, 10, 29, 9, 30, tzinfo=timezone.utc)
    return {"state": {"tasks": [{
        "id": f"PM-{i:06d}", "dbId": uuid.UUID(int=i), "plant": f"Plant {i % 120}", "name": "Inverter monthly service",
        "type": "Inverter", "due": date(2026, 11, 1 + i % 28), "start": now, "assignee": f"Engineer {i % 40}",
        "status": ("Scheduled", "Completed", "Overdue")[i % 3], "duration": Decimal("1.5"), "evidence": [],
        "log": [{"at": now, "by": "System", "text": "Created"}], "problem": None, "delayDays": i % 9,
    } for i in range(rows)]}}


def timed(fn, runs: int) -> tuple[float, bytes]:
    out, times = b"", []
    for _ in range(runs):
        t = perf_counter(); out = fn(); times.append((perf_counter() - t) * 1000)
    return statistics.median(times), out


def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--rows", type=int, default=15000); ap.add_argument("--runs", type=int, default=5)
    args = ap.parse_args()
    data = payload(args.rows)
    results = {}
    results["fastapi_default"] = timed(lambda: JSONResponse(jsonable_encoder(data)).body, args.runs)
    results["fastjson"] = timed(lambda: json_response(data).body, args.runs)
    try:
        import orjson  # optional, measurement only
        results["orjson"] = timed(lambda: orjson.dumps(data, option=orjson.OPT_PASSTHROUGH_DATACLASS, default=str), args.runs)
    except ImportError:
        results["orjson"] = None
    body = results["fastjson"][1]
    for level in (6, 9):
        ms, packed = timed(lambda: gzip.compress(body, compresslevel=level), args.runs)
        results[f"gzip_{level}"] = (ms, packed)
    print(json.dumps({
        "rows": args.rows,
        "serialise_ms_median": {k: round(v[0], 1) for k, v in results.items() if v and not k.startswith("gzip")},
        "json_bytes": len(body),
        "same_json_as_fastapi": json.loads(results["fastapi_default"][1]) == json.loads(body),
        "gzip": {k: {"ms": round(v[0], 1), "bytes": len(v[1])} for k, v in results.items() if k.startswith("gzip")},
        "orjson": "not installed (not a project dependency)" if results["orjson"] is None else "measured above",
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
