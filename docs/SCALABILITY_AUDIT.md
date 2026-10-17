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
