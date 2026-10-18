# Scalability and reliability audit

## Scope and evidence

This audit covers the checked-in FastAPI application, plain JavaScript frontend, SQLAlchemy/PostgreSQL access, Supabase Storage adapter, Render configuration, migrations, tests and load-test harness. It does not claim access to production Supabase, Render metrics, live schema state or production traffic. The production schema and connection quota must be checked in the target environment.

The application uses SQLAlchemy with psycopg 3 against PostgreSQL (Supabase); SQLite is isolated to tests. Clerk authenticates users, FastAPI enforces Solar91 roles and plant/equipment scope, and the server uses the Supabase service-role credential for private Storage. Render runs the Dockerized app. The frontend remains the existing modular JavaScript application.

## Findings and existing protections

| Area | Existing implementation | Remaining concern |
| --- | --- | --- |
| PostgreSQL connections | Bounded SQLAlchemy pool (`DB_POOL_SIZE`, `DB_MAX_OVERFLOW`), pre-ping, recycle, and psycopg compatibility for transaction-pooler prepared statements. | Combined connections multiply by Render processes/instances. Confirm Supabase pooler quota and configure one worker per process accordingly. |
| Issue/plant/equipment lists | Issue and plant APIs support server-side filters and bounded pages. Equipment page and export lookups batch-load related users/type owners; a regression test asserts query count. | Verify every frontend register uses paged endpoints; legacy state bootstrap still loads broad collections. |
| State bootstrap | `/api/bootstrap?lite=1` omits washing data; revisions guard collection sync against stale tabs. `/api/state/collections` supports targeted collection reads. | `load_state()` still reads full collections for bootstrap and some legacy module routes. Snapshot/collection contracts need staged frontend migration before imposing page boundaries. |
| Concurrency | Issue edits use row locks; washing review/configuration paths and state revisions have protections; PM task completion locks the source task and rejects repeated completion. | Locks in the SQLite suite do not prove PostgreSQL behavior. Recurrence uniqueness across distinct source tasks needs a production duplicate preflight before a database constraint is considered. |
| Uploads | Evidence is handled server-side, private bucket access is authenticated and permission-checked, uploads are size/type validated, and object names are generated. Storage calls now reuse a process-wide synchronous `httpx.Client`, closed during application shutdown. | No live Storage/network measurements were available to quantify the effect. |
| Washing and evidence | Dedicated washing register/cycle/day-evidence workflows and tests cover record association, role checks, table counts and confirmations. | No live Storage/network upload test was possible. Verify private bucket and policy in staging. |
| Frontend freshness | Targeted live refresh uses issue pulse and avoids redraw while users interact; collection revision conflicts are explicit. | The bootstrap payload is still the main data-growth risk. Existing dashboards/export calculations operate on browser-loaded data and grow with that payload. |
| Load testing | `loadtests/` provides a guarded Locust runner requiring explicit staging/synthetic-data confirmation, issue lifecycle and concurrent distinct-field edits, duplicate-close checks and optional private evidence upload. | No staging URL, test credentials or monitoring access were supplied. The current scenario does not exercise every workflow or prove 100-user capacity. |
| Cross-module consistency tests | Existing isolated SQLite tests cover many individual workflows, including issues, PM, washing, equipment, role scope and evidence. A new isolated SQLite fixture generator supplies repeatable 1x/5x/10x distributions across plants, equipment, issues, PM, washing and handovers. | There is not yet one end-to-end create/read/list/update/dashboard/refresh/concurrency matrix covering every record type. The generated SQLite profile is synthetic and does not represent measured production volume or Postgres latency. |

## Implemented protections present in this source tree

- Bounded SQLAlchemy PostgreSQL pool and connection health options.
- Weekly report CSV aggregation now makes one pass over washing history and open issues, rather than rescanning all history for every plant; common report KPIs are calculated once per export.
- Supabase Storage HTTP operations reuse one thread-safe client per process, preserving the operation-specific request timeouts and closing the client on app shutdown.
- Server-side filtering/pagination for primary issue and plant/equipment register APIs.
- Batched equipment serialization lookups to remove per-row query patterns.
- Role and plant/equipment scope checks at API boundaries.
- Optimistic collection revision checks and stale-write rejection for legacy state sync.
- Row locking and duplicate-transition rejection for selected issue, washing and PM workflows.
- Private evidence handling with bounded upload size, generated storage paths and authorization checks.
- Health/readiness endpoints and startup preflight without automatic SQL migration execution.
- Staged, opt-in Locust harness with no automatic production targeting or record cleanup.
- Isolated synthetic SQLite fixture generator for repeatable 1x/5x/10x data volumes; Storage evidence remains metadata-only.

These protections are source-code facts; their behavior against the live Supabase project remains unverified.

## Module map

| Module | Main implementation |
| --- | --- |
| Dashboard and Field Desk | `app/field/router.py`, `app/operations/router.py`, `frontend/static/js/02-core-render-and-dashboard.js`, `frontend/static/js/37-work-radar.js` |
| Plant/equipment register | `app/plants/`, `frontend/static/js/20-modern-ui-2026.js` |
| O&M issues and evidence | `app/issues/`, `frontend/static/js/08-actions-exports-and-submission.js`, `frontend/static/js/10-issue-register-and-workflow.js` |
| Scheduled maintenance/PM | `app/scheduled/`, `app/pmplan/`, `frontend/static/js/24-pm-plan.js`, `frontend/static/js/29-pm-live-dashboard.js` |
| Washing and cycle evidence | `app/scheduled/`, `frontend/static/js/21-washing-portfolio.js`, `frontend/static/js/26-washing-cycles.js` |
| Users and permissions | `app/users/`, `app/core/security.py`, `app/auth/` |
| Extra services, audit, SCADA, imports | `app/services/`, `app/audit/`, `app/scada/`, `app/imports/` |

## Database changes

No new SQL is proposed. Checked-in migrations already define indexes for common issue, plant, equipment, PM and washing lookups, but repository files do not prove that production applied them. Compare actual indexes/constraints with `docs/DATABASE_PERFORMANCE_AUDIT_2026-10-14.md`, then collect representative staging query plans before adding indexes. Do not run the historical migration set indiscriminately.

## Validation performed for this delivery

- Full Python suite after the changes: **301 passed** with `DEBUG=false` supplied only to the test process. No `.env` file was changed.
- The scale fixture was generated at all three sizes, and the local benchmark ran 50 iterations per query profile at each size. Observed table totals were 350, 8,450 and 33,650 records at 1x, 5x and 10x respectively; detailed SQLite-only latency results are in `docs/LOAD_TESTING_GUIDE.md`.
- Ran the isolated fixture generator and 50-repeat read microbench at 1x (350 records), 5x (8,450) and 10x (33,650). At 1x/5x/10x, issue-page p95 was 1.148/2.601/8.016 ms; issue-summary p95 0.881/2.191/9.814 ms; washing-summary p95 0.789/1.764/4.906 ms; PM-summary p95 0.739/2.165/7.040 ms. These are local SQLite measurements only, not API, PostgreSQL or concurrency results.
- The browser history test now fulfills its origin locally, so it does not require outbound network access.
- Pytest emitted a cache warning because the existing `.pytest_cache` directory is not writable in this environment; the test results completed successfully.
- A real staging or production load test was **not run**. No 100-concurrent-user capacity claim is made.
- No live Supabase, Render, Storage, or migration verification was performed.
- The weekly CSV aggregation regression and all frontend JavaScript syntax checks passed after the export optimization.
- Storage client reuse/close lifecycle has a local regression test; remote Storage behavior remains unverified.
- Existing uncommitted user edits in `frontend/static/js/02-core-render-and-dashboard.js` and `frontend/static/js/14-topbar-role-picker.js` were preserved.

## Recommended follow-up

1. In staging, establish row counts and query plans for the main operational tables and compare the deployed index catalog with the checked-in migrations; the local SQLite microbenchmark does not replace this.
2. Migrate the legacy full-state bootstrap consumers incrementally to bounded list/detail and aggregate APIs. Keep the old response until all consumers are migrated and cross-module parity is proven.
3. Expand the synthetic load profile to washing, plant, PM, role denial and confirmation workflows; run the guarded 25/50/100 stages in staging while observing Render and Supabase.
4. Verify private bucket access, upload size/type policy, RLS/role rules, restoration procedures, and the connection budget before production rollout.

No additional paid infrastructure is supported by the available evidence. Scale the existing Render/PostgreSQL setup based on measured staging headroom and latency.

## Addendum 2026-10-17: bootstrap cost, request timing and washing payload

Measured on a synthetic SQLite database (not production; 40 plants, 10,000 washing tables, 30,000 history rows):

- `load_state` (full bootstrap) took 1.84 s before and 0.87 s after reading washing tables/history as plain column rows instead of ORM entities (same output; a shape test covers it). Lite bootstrap takes about 0.01 s.
- Washing is about 99.7% of the raw bootstrap JSON (2.49 MB of 2.50 MB); gzip reduces the response to about 42 KB.
- The washing overview used to send every report of the last 90 days (8.4 MB in a 25-plant, 3-reports-per-day stress case). It now sends 35 days plus anything still pending (about 3.4 MB in the same case); `?report_days=90` returns the full window.
- On Render, `/api/bootstrap` took 11.27 s (97 kB) and `/api/scheduled/washing/overview` 3.91 s (7.9 kB). The small payloads and the roughly constant 0.43-0.45 s per database query (about 25 and 9 queries) point at database round-trip latency or a slow free-tier CPU. This is an inference; the new request timing below distinguishes the two.

Added: `app/core/observability.py` sets `X-Request-ID` and `Server-Timing` (total ms, database ms, query count) and logs `slow_or_failed_request` lines for requests slower than `SLOW_REQUEST_MS` (default 1000) or with status 500+. Credentials, query strings and bodies are never logged. `DB_POOL_TIMEOUT_SECONDS` and `DB_POOL_PRE_PING` (default true, unchanged behaviour) are now configurable.

Not implemented (needs a decision or a schema change): an idempotency key for washing report submissions. A time-window duplicate check was tried and removed because it would swallow a legitimate second report with the same count.

### Addendum 2026-10-17: request-timing edge cases

- Failed SQL statements now clear their per-connection timer in SQLAlchemy's `handle_error` event. Without this cleanup, a pooled connection could carry a stale start time into a later request and report misleading database duration/query counts.
- Exception logs use the matched route template (or `unmatched`) rather than a raw URL path, avoiding accidental disclosure of path values.
- CORS allows `X-Request-ID` on preflight requests and exposes `X-Request-ID` and `Server-Timing` to approved browser origins.
- The isolated browser smoke pins `DEBUG=false` in its child process so an unrelated host environment value cannot prevent the test server from starting.
- Verification on 2026-10-17: all 316 pytest cases passed; the focused observability file passed 9 tests; the isolated browser smoke passed; all 40 frontend JavaScript files passed `node --check`. No Render, Supabase, production data, or network service was used.

### Addendum 2026-10-17: scheduled API round trips

- `GET /api/scheduled/tasks` now batches plant names, equipment resolution and per-plant/type quantity totals, and selects only each task's newest follow-up in SQL. Its query count is bounded at three for the O&M Head list in an isolated API regression test with eight tasks; inactive equipment remains excluded from reference resolution but is included in the existing quantity total.
- `GET /api/scheduled/washing/overview` now returns plant/configuration/assignee data together with table counts and latest report dates in one query; reports and monthly completion totals remain batched reads. An isolated API regression test asserts no more than three database queries for the O&M Head overview.
- The existing Render measurements (11.27 s for `/api/bootstrap`, 3.91 s for washing overview) are historical. The washing query reduction should lower cold-request time where database round-trip latency dominates, but has not been measured against Render/Supabase and does not prove a 1.5 s ceiling. The bootstrap still loads broad legacy collections and remains the principal unbounded latency risk; replacing its response safely requires migrating frontend consumers to the existing bounded module APIs and checking parity. No production connection, service setting, or load test was used for this follow-up.

### Addendum 2026-10-17: end-to-end API latency and portal startup

#### Changes

- Request timing now reports `app` (total server time less measured SQL execution), `db` (SQL execute time and query count), and `total`; exceptions and slow responses include the sanitized request ID, Render `Rndr-Id` when available, instance ID, and deployed commit. It never logs query strings, bodies, credentials, or record IDs. CORS exposes the timing and correlation headers.
- The browser now has an opt-in `window.Solar91Latency` sampler. It keeps at most 500 in-memory samples, groups only by HTTP method and API family, and summarizes client elapsed time (Clerk wait, network/retry, JSON parse), server timings and response `Content-Length`. It sends nothing and stores no URLs, query strings, record identifiers, payloads, tokens, or error messages. Enable it for the initial load by opening the portal with `?s91_latency=1`; for later actions run `Solar91Latency.enable()` and then `Solar91Latency.report()` in DevTools.
- Initial rendering no longer waits for the independent `/api/users` and `/api/issues/assignees` calls. They start after the first screen is rendered; those results only populate pickers.
- Assignee bootstrap reuses the issue rows it already loaded and resolves equipment references from the bootstrap's batched equipment map. This removes a second issue-table read and per-issue scope lookups. The field overview now loads an Assignee's equipment-type scope once and applies it in SQL / in-memory checks rather than requerying it for each issue, task and washing table. Regression checks confirm its query count stays flat after adding work rows and the bootstrap query count stays flat as scoped issue rows grow.

#### Local API benchmark

`scripts/benchmark_api_latency.py` was run against a fresh temporary SQLite database with only synthetic records, as the synthetic Assignee, using warmed FastAPI TestClient requests. Each 1x and 5x endpoint has 20 measured samples; 10x has 10 samples, so its p95 is a preliminary high-rank sample. Client wall time includes TestClient and response decompression. `Server-Timing` app/db figures below are p95; payload is median decoded response size. All sampled requests returned 200 with zero errors.

| Endpoint | Rows (1x / 5x) | Wall p50/p95 ms (1x) | Wall p50/p95 ms (5x) | Server app/db p95 ms (5x) | Queries (5x) | Decoded bytes p50 (5x) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `/api/bootstrap` | 100 / 2,500 issues | 47 / 80 | 743 / 809 | 788 / 16 | 38 | 3,178,424 |
| `/api/bootstrap?lite=1` | same | 44 / 56 | 645 / 731 | 712 / 12 | 34 | 2,826,651 |
| `/api/state/collections?keys=issues` | same | 35 / 50 | 510 / 571 | 555 / 11 | 29 | 1,672,558 |
| `/api/field/overview?limit=15` | same | 13 / 19 | 44 / 106 | 98 / 7 | 7 | 8,820 |
| `/api/issues?limit=50` | same | 14 / 17 | 18 / 21 | 12 / 8 | 5 | 40,951 |
| `/api/issues/pulse` | same | 7 / 9 | 7 / 8 | 5 / 2 | 4 | 45 |
| `/api/scheduled/tasks` | 75 / 1,875 tasks | 23 / 32 | 388 / 417 | 408 / 6 | 5 | 1,750,476 |
| `/api/scheduled/washing/overview` | 50 / 1,250 tables | 21 / 29 | 165 / 254 | 245 / 4 | 5 | 957,108 |
| `/api/plants?limit=50` | 5 / 25 plants | 8 / 10 | 9 / 10 | 8 / 1 | 4 | 11,076 |

The 1x fixture is 5 plants, 100 issues, 75 PM tasks and 50 washing tables. The 5x fixture is 25 plants, 2,500 issues, 1,875 PM tasks, 1,250 washing tables and 1,000 washing reports. Common bounded reads remained far below 1.5 seconds in these local samples. Full bootstrap was 0.81 seconds p95 at 5x, while its application portion was 0.79 seconds and SQL portion 0.016 seconds.

At 10x (50 plants, 10,000 issues, 7,500 PM tasks, 5,000 washing tables and 4,000 washing reports), the full bootstrap reached 3.67 seconds p95 (3.59 s app, 67 ms SQL, 38 queries, 12.62 MB decoded), lite bootstrap 3.17 seconds (3.10 s app, 52 ms SQL, 34 queries, 11.21 MB), issue collection refresh 2.80 seconds (2.74 s app, 47 ms SQL, 29 queries, 6.69 MB), and scheduled task list 1.97 seconds (1.92 s app, 34 ms SQL, 5 queries, 7.00 MB). Washing overview was 0.63 seconds p95. These results identify full response construction/serialization and unbounded legacy collections as the local scale boundary; this is not a Postgres or Render measurement and app residual is not a standalone CPU profile.

The full bootstrap and scheduled task list still return records consumed by multiple legacy screens, charts, reports and exports. Changing them to silently return fewer records would break existing features, so pagination requires a planned frontend migration with list/detail loading and parity checks. The `state/collections` endpoint similarly rebuilds a full state snapshot before selecting the requested keys; the issue-key sample above is diagnostic and is not currently used by the frontend's ordinary refresh paths. This remains a useful follow-up for bounded collection refresh.

No before/after Render comparison is available. The previous 11.27 s bootstrap and 3.91 s washing-overview results are historical. After an authorized deploy, use `?s91_latency=1` for browser measurements, compare `client_ms` with the server `app/db/total` fields, and correlate the response `Rndr-Id` with `slow_or_failed_request` logs. The checked-in `render.yaml` declares the Free plan, but the live dashboard plan and instance settings were not inspected; Render's current documentation says Free web services spin down after 15 minutes without traffic and take about one minute to restart. This is a possible cold-start contribution, not an explanation proven for the historical 11-second requests. See [Render Free service limitations](https://render.com/docs/free), [Render environment variables](https://render.com/docs/environment-variables), and [Render request ID logging](https://render.com/docs/logging).

No production/staging connection, load test, setting change, migration, or deploy was performed. Local SQLite p95 values do not establish the 1.5-second goal on PostgreSQL/Render. A measured 100-user capacity claim is not made.

### Addendum 2026-10-19: database round trips seen in Render logs

- Render logs showed `slow_or_failed_request` warnings with `status=200` (slow, not failed) and about 275-315 ms per SQL statement (e.g. 4 queries, `db_ms=1104`), with `app_ms` up to about 1.6 s. Per-statement time that high for small queries indicates network distance between the service and the database, not slow SQL. The unmeasured `app_ms` also contained pool pre-ping round trips and new-connection handshakes (TCP, TLS, login), which `DB_POOL_RECYCLE_SECONDS=300` forced every five minutes.
- Changes: an idle-aware health check replaces pinging before every request (a connection used in the last `DB_PING_IDLE_SECONDS`, default 10, is reused directly; an idle one is pinged and, if dead, replaced via SQLAlchemy's DisconnectionError handling; `DB_PING_IDLE_SECONDS=0` restores the previous behaviour); new-connection and health-check time are reported in `Server-Timing` (`conn`) and in the slow-request line (`new_connections`, `connect_ms`, `health_checks`, `health_check_ms`), and excluded from `app_ms`; the default and `render.yaml` recycle interval is 1800 s; on startup the service logs `database_latency round_trip_ms=…` (WARNING at 50 ms or more); the washing month endpoint reads the plant and its setup in one query.
- Not changed and not verified: the live Render region/plan and the Supabase project region. If `round_trip_ms` is high, put the service and the database in the same region (the Render region is fixed at service creation). These changes were tested on SQLite only; no Render, Supabase or production connection was used.
