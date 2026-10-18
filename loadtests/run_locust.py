from __future__ import annotations

import argparse
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from safety import LoadTestSafetyError, load_config


ROOT = Path(__file__).resolve().parents[1]
USER_STAGES = (1, 10, 25, 50, 100)


def positive_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive number") from exc
    if parsed <= 0 or parsed > 10:
        raise argparse.ArgumentTypeError("must be greater than 0 and no more than 10 users per second")
    return parsed


def run_time(value: str) -> str:
    if not re.fullmatch(r"[1-9]\d*(?:s|m|h)?", value):
        raise argparse.ArgumentTypeError("use a positive duration such as 60s, 5m, or 1h")
    match = re.fullmatch(r"([1-9]\d*)(s|m|h)?", value)
    amount = int(match.group(1))
    unit = match.group(2) or "s"
    seconds = amount * {"s": 1, "m": 60, "h": 3600}[unit]
    if seconds > 3600:
        raise argparse.ArgumentTypeError("a single stage may run for no more than 1 hour")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run one guarded Solar91 O&M staging load-test stage."
    )
    parser.add_argument("--users", type=int, choices=USER_STAGES, default=1)
    parser.add_argument("--spawn-rate", type=positive_float, default=1)
    parser.add_argument("--run-time", type=run_time, default="2m")
    parser.add_argument("--csv-prefix", help="Optional output prefix under loadtests/results.")
    args = parser.parse_args()

    try:
        config = load_config()
    except LoadTestSafetyError as exc:
        parser.error(str(exc))

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    prefix = args.csv_prefix or f"{config.run_id}-{args.users}u-{timestamp}"
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", prefix):
        parser.error("--csv-prefix may contain only letters, numbers, hyphens, and underscores.")
    report_dir = ROOT / "loadtests" / "results"
    report_dir.mkdir(parents=True, exist_ok=True)
    csv_base = report_dir / prefix

    command = [
        sys.executable,
        "-m",
        "locust",
        "-f",
        str(ROOT / "loadtests" / "locustfile.py"),
        "--headless",
        "--host",
        config.base_url,
        "--users",
        str(args.users),
        "--spawn-rate",
        str(args.spawn_rate),
        "--run-time",
        args.run_time,
        "--csv",
        str(csv_base),
        "--csv-full-history",
        "--only-summary",
    ]
    print(
        f"Starting one staging load stage: users={args.users}, "
        f"spawn_rate={args.spawn_rate}/s, duration={args.run_time}, "
        f"host={config.base_url}, run_id={config.run_id}"
    )
    print(f"Locust CSV output: {csv_base}_[stats|failures|exceptions].csv")
    try:
        return subprocess.run(command, cwd=ROOT, check=False).returncode
    except FileNotFoundError:
        print("Locust is not installed. Install requirements-load.txt first.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
