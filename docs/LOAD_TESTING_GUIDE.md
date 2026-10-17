# Solar91 O&M load-testing guide

## Safety and coverage

Run Locust only against a dedicated HTTPS staging service containing synthetic records. The runner in `loadtests/run_locust.py` refuses to start until staging, synthetic data, approved-host and run-ID settings are provided. Never use production credentials, real user data, production Storage, or production URLs. A host allowlist is an operator confirmation, not proof that the database is synthetic.

The current harness exercises dashboard bootstrap, issue list/filter/search, plant search, issue activity/steps, one synthetic issue lifecycle per ten users, simultaneous edits to distinct fields, duplicate-close rejection, and optional private evidence upload/access denial. It does not yet exercise every module or prove 100-user capacity.

## Generate 1x/5x/10x local data fixtures

`scripts/generate_scale_fixture.py` creates a fresh SQLite database under the operating-system temporary directory. It refuses to overwrite an existing file and accepts no PostgreSQL URL. The default synthetic 1x profile is 5 plants, 10 equipment items, 100 issues, 75 PM tasks, 50 washing tables with history, 40 daily washing reports, and 5 handovers with 15 checklist items. The 5x and 10x profiles scale those counts proportionally. Washing evidence and checklist evidence are metadata placeholders only; the script does not create Storage objects or upload files.

These counts are a reproducible synthetic baseline, not a claim about the portal's present production volume. Adjust `BASE_PROFILE` only in an isolated test branch if a verified representative baseline is available. Each scale creates its own new database:

```powershell
python scripts/generate_scale_fixture.py --scale 1
python scripts/generate_scale_fixture.py --scale 5
python scripts/generate_scale_fixture.py --scale 10
```

The script prints per-table counts and the output database path. Use these fixtures for local query/serialization experiments, and delete them manually only after confirming the path is within the OS temporary directory. The fixture generator does not run the FastAPI app, measure endpoint latency, or establish that PostgreSQL behaves like SQLite; authenticated API and concurrency measurements still require the guarded staging harness.

`scripts/benchmark_scale_fixture.py <database-path> --runs 50` reports p50/p95/p99 for bounded plant and issue pages and grouped issue, washing and PM summaries. It only accepts generated fixture paths under the OS temp directory. A local run on this workstation produced:

| Fixture | Plants / issues / PM tasks / washing reports | Issue page p95 | Issue summary p95 | Washing summary p95 | PM summary p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| 1x | 5 / 100 / 75 / 40 | 1.148 ms | 0.881 ms | 0.789 ms | 0.739 ms |
| 5x | 25 / 2,500 / 1,875 / 1,000 | 2.601 ms | 2.191 ms | 1.764 ms | 2.165 ms |
| 10x | 50 / 10,000 / 7,500 / 4,000 | 8.016 ms | 9.814 ms | 4.906 ms | 7.040 ms |

These are 50-repeat, single-process SQLite query microbenchmarks on one workstation; they exclude HTTP, authentication, writes, uploads, PostgreSQL and concurrent users. The issue page p95 rises with the dataset, though remains milliseconds in this local fixture. Do not use these values as production API latency or capacity evidence.

## Authenticated API latency benchmark

`scripts/benchmark_api_latency.py --scale 1|5|10 --runs 10..200` builds a fresh SQLite database inside a temporary directory, seeds the synthetic scale profile, authenticates as its synthetic Assignee, and measures nine read endpoints through FastAPI TestClient. It does not accept a database URL or a target host. The output includes p50/p95 client wall time, `Server-Timing` app/DB/total, query count, decoded response bytes, and HTTP status/error count. The 10x profile is large; use 10 samples for that profile to avoid repeatedly serializing its full bootstrap payload.

```powershell
python .\scripts\benchmark_api_latency.py --scale 1 --runs 20
python .\scripts\benchmark_api_latency.py --scale 5 --runs 20
python .\scripts\benchmark_api_latency.py --scale 10 --runs 10
```

This is a warmed, single-process local API benchmark. Client wall time includes TestClient and response decompression, not an actual browser/network; it excludes live PostgreSQL, Render cold starts, browser rendering, Storage and concurrent users. API timing results and dataset sizes are recorded in `docs/SCALABILITY_AUDIT.md`.

## Prerequisites

- A dedicated Render staging service and isolated Supabase staging database/bucket.
- A staging bearer token for an O&M Head, a synthetic plant UUID/site code, an active staging Assignee UUID, and a unique ticket prefix.
- A person monitoring Render and Supabase resource metrics with authority to stop the run.
- Python dependencies from `requirements-load.txt` installed in a separate virtual environment.

Set the variables exactly as documented in `loadtests/README.md`: `SOLAR91_LOADTEST_ENV`, `SOLAR91_LOADTEST_CONFIRM_STAGING`, `SOLAR91_LOADTEST_SYNTHETIC_ONLY`, `SOLAR91_LOADTEST_BASE_URL`, `SOLAR91_LOADTEST_APPROVED_HOST`, `SOLAR91_LOADTEST_PRODUCTION_HOSTS`, `SOLAR91_LOADTEST_RUN_ID`, `SOLAR91_LOADTEST_BEARER_TOKEN`, `SOLAR91_LOADTEST_PLANT_ID`, `SOLAR91_LOADTEST_PLANT_SITE_CODE`, and `SOLAR91_LOADTEST_ASSIGNEE_ID`. The bearer token is read from the environment and is not printed. Do not put secret values in a committed file.

## Run stages

Use the guarded runner to execute one stage at a time. Begin with one user, inspect errors and resource headroom, then proceed only if the staging owner approves the next stage:

```powershell
py -3.12 -m venv .venv-load
.\.venv-load\Scripts\python.exe -m pip install -r requirements-load.txt
.\.venv-load\Scripts\python.exe .\loadtests\run_locust.py --users 1 --spawn-rate 1 --run-time 2m
.\.venv-load\Scripts\python.exe .\loadtests\run_locust.py --users 25 --spawn-rate 2 --run-time 5m
.\.venv-load\Scripts\python.exe .\loadtests\run_locust.py --users 50 --spawn-rate 5 --run-time 5m
.\.venv-load\Scripts\python.exe .\loadtests\run_locust.py --users 100 --spawn-rate 5 --run-time 5m
```

Each run writes CSV files under ignored `loadtests/results/`. Do not run multiple Locust processes against one target. Prepare staging data separately; the local SQLite fixtures are not staging seeds and must never be copied into production.

## Evidence upload stage

Upload testing is opt-in and leaves an evidence object in Storage. Confirm the bucket is private staging and assign manual cleanup ownership first. Then set `SOLAR91_LOADTEST_UPLOAD_EVIDENCE=yes` and `SOLAR91_LOADTEST_EVIDENCE_BUCKET_PRIVATE=I_VERIFIED_PRIVATE_STAGING_BUCKET` for a single-user validation before combining uploads with concurrent traffic. The runner never deletes objects automatically.

## Interpret results

Review requests per second, median and p95/p99 latency, failures, timeouts, and workflow integrity checks in the Locust summary and CSV output. Inspect Render CPU/memory/restarts and application logs; inspect Supabase connection usage, database CPU, query latency and pooler errors. Separate application errors from harness/setup errors. Investigate every lost/duplicate update, authorization leak, timeout increase or error-rate regression before increasing concurrency.

Initial targets from the engineering brief are p95 <= 1 second for common indexed reads, p95 <= 1.5 seconds for ordinary database writes, under 1% application errors, and zero unexplained lost/duplicated writes. These are targets for a defined workload, not guarantees. Define upload targets by realistic file size and network conditions. Record dataset size, user count, duration, build, environment, percentiles, error rate, resource use and evidence outcome for each stage.

No external load stage was run for this delivery. A 100-user run is a staging task requiring the prerequisites above; this guide does not certify capacity.
