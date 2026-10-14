# Solar91 O&M staging load tests

This suite uses Locust against a **staging deployment only**. It has no production mode and does
not automatically progress through load stages. The runner rejects non-HTTPS URLs, URLs with a
path/query/credentials, hosts that do not match the explicitly approved hostname, and hosts listed
as production. It also requires explicit staging and synthetic-data confirmations before starting
Locust.

## Scope and safety

- `/api/bootstrap` returns broad application state. The staging database must contain only synthetic
  records and must not be a production clone or contain customer/staff personal data.
- Use a dedicated staging O&M Head bearer token and a separate active staging Assignee UUID.
  Never use a production token or service-role key. The token is passed in an HTTP header and is
  never printed by the runner.
- Configure a unique synthetic plant/site code and UUID. The runner scopes issue queries to the
  plant and `LT-<run-id>-` ticket prefix. Plant-search checks only the configured unique synthetic
  site code.
- One issue-lifecycle workflow runs per ten virtual users (the first virtual user runs it, so the
  one-user smoke stage checks writes too). Each workflow creates one uniquely named synthetic issue,
  checks duplicate creation rejection, assigns it, submits two concurrent distinct-field updates,
  checks both values and the record count, opens its activity/steps, and directly closes the issue.
  It verifies a repeated close is rejected. No issue cleanup/delete operation is performed.
- Evidence upload is off by default. If explicitly enabled, it writes a generated 1x1 PNG to the
  configured **private staging** `SUPABASE_STORAGE_BUCKET` (normally `scheduled-om-evidence`),
  verifies authenticated download and anonymous denial, and leaves the object in Storage. Confirm
  the configured bucket is the existing private staging bucket before enabling it; do not create,
  make public, or delete a bucket. Arrange manual cleanup of generated evidence objects afterward.
- This suite never changes Render, Supabase, database, or Storage configuration. It does not execute
  migrations.

## Suggested acceptance criteria (set before a run)

These are proposed gates, not measured results. Replace them only with approved project SLOs before
starting:

| Measure | Suggested gate |
| --- | --- |
| Unexpected request failures | < 1%; expected duplicate-create and duplicate-close 409 responses are treated as successful checks |
| Timeouts | 0 |
| Read p95 / p99 | <= 2.5 s / <= 5 s |
| Write p95 / p99 | <= 3 s / <= 6 s |
| Integrity | No duplicate ticket records, failed duplicate rejection, missing concurrent field update, or wrong final status |
| Render resources | No restart/OOM; CPU and memory below 80% sustained |
| Supabase PostgreSQL | Peak connections below 70% of the configured project limit; no pool exhaustion or sustained saturation |

The Locust CSV files report request counts, failures, throughput, and response-time distributions by
request name. They do not collect Render CPU/memory or Supabase connection metrics. Record those
from the Render and Supabase dashboards for each stage, alongside exact UTC start/end times, stage,
deployment revision, and run ID. Treat any integrity failure as a failed stage regardless of average
latency.

## Staging setup (PowerShell)

Run from the repository root in a dedicated staging test environment:

```powershell
py -3.12 -m venv .venv-load
.\.venv-load\Scripts\python.exe -m pip install --disable-pip-version-check -r requirements-load.txt

$env:SOLAR91_LOADTEST_ENV = "staging"
$env:SOLAR91_LOADTEST_CONFIRM_STAGING = "I_VERIFIED_THIS_IS_STAGING"
$env:SOLAR91_LOADTEST_SYNTHETIC_ONLY = "I_VERIFIED_SYNTHETIC_ONLY"
$env:SOLAR91_LOADTEST_BASE_URL = "https://<your-staging-host>"
$env:SOLAR91_LOADTEST_APPROVED_HOST = "<your-staging-host>"
$env:SOLAR91_LOADTEST_PRODUCTION_HOSTS = "<prod-host-1>,<prod-host-2>"
$env:SOLAR91_LOADTEST_PLANT_ID = "<synthetic-staging-plant-uuid>"
$env:SOLAR91_LOADTEST_PLANT_SITE_CODE = "<unique-synthetic-site-code>"
$env:SOLAR91_LOADTEST_ASSIGNEE_ID = "<active-staging-assignee-uuid>"
$env:SOLAR91_LOADTEST_RUN_ID = "qa-2026-unique"
$env:SOLAR91_LOADTEST_UPLOAD_EVIDENCE = "no"

# Enter a short-lived token for a dedicated staging O&M Head account without echoing it.
$secure = Read-Host "Staging O&M Head bearer token" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $env:SOLAR91_LOADTEST_BEARER_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
```

Before the first request, independently verify the hostname in Render and confirm:

1. It is the staging service, is not any hostname in `SOLAR91_LOADTEST_PRODUCTION_HOSTS`, and contains
   only synthetic records (including application bootstrap state).
2. The plant UUID, exact site code, active Assignee UUID, and bearer token are staging resources.
3. Staging PostgreSQL and Storage have enough headroom, and the configured `SUPABASE_STORAGE_BUCKET`
   is the intended existing private staging bucket. Do not use production or an anonymized production
   clone unless it has been proven free of customer and personal data.
4. A person is monitoring Render and Supabase, with authority to stop the stage.

The confirmations are operator attestations, not automatic proof of the target's environment or
contents. Keep environment values and tokens out of source control and logs. Clear the token from
the current shell after testing:

```powershell
Remove-Item Env:SOLAR91_LOADTEST_BEARER_TOKEN
```

## Run stages manually

Each command launches exactly one stage and writes Locust CSV reports under the ignored
`loadtests/results/` directory. Start small, review the results and infrastructure health, and only
then choose the next command. Stop if a gate fails, errors/timeouts increase, integrity checks fail,
or resource headroom is insufficient.

```powershell
.\.venv-load\Scripts\python.exe .\loadtests\run_locust.py --users 1 --spawn-rate 1 --run-time 2m
.\.venv-load\Scripts\python.exe .\loadtests\run_locust.py --users 10 --spawn-rate 2 --run-time 5m
.\.venv-load\Scripts\python.exe .\loadtests\run_locust.py --users 25 --spawn-rate 2 --run-time 5m
.\.venv-load\Scripts\python.exe .\loadtests\run_locust.py --users 50 --spawn-rate 5 --run-time 5m
.\.venv-load\Scripts\python.exe .\loadtests\run_locust.py --users 100 --spawn-rate 5 --run-time 5m
```

The final stage is not a default or automatic action: require explicit staging-owner approval before
running it. For a smaller first stage, use `--run-time 60s`. The `--users` values are deliberately
limited to 1, 10, 25, 50, and 100; duration and spawn rate are configurable. Do not run concurrent
Locust processes against the target.

Optional upload test (only after confirming private staging Storage, expected retained-object cost,
and manual cleanup ownership):

```powershell
$env:SOLAR91_LOADTEST_UPLOAD_EVIDENCE = "yes"
$env:SOLAR91_LOADTEST_EVIDENCE_BUCKET_PRIVATE = "I_VERIFIED_PRIVATE_STAGING_BUCKET"
.\.venv-load\Scripts\python.exe .\loadtests\run_locust.py --users 1 --spawn-rate 1 --run-time 2m
```

Evidence uploads remain in the bucket; there is intentionally no automated deletion.

## Current execution status

**NOT RUN.** No staging URL, staging credentials, synthetic staging fixture, or resource-monitoring
access was provided. No requests were sent and no pass/fail measurements are claimed. The
requirements file adds only the isolated Locust load-test dependency; normal application
dependencies are unchanged.
