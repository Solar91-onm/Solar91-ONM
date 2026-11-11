# Solar91 performance engineering report (November 2026)

Scope: why the portal feels slow, what was changed, what was measured, and what still needs a staging run.
Everything below was measured on one Windows workstation against **local SQLite with synthetic data**. Nothing was
measured on Render or Supabase, no load test was run, and no production data, migration or setting was touched.
Local timings show *relative* cost (Python work, payload size, query count); they are not production latency.

## 1. Summary

| | Before | After |
|---|---|---|
| Overview API at 10x data (p50) | 664 ms | **157 ms** |
| Plant details API at 10x (p50) | 541 ms | **46 ms** |
| Plant tab, Module Cleaning (washing overview call, 10x) | 1041 ms, 4,767 KB | **19 ms, 10.8 KB** |
| Initial load to usable Overview in a browser, 10x | 922 ms | **486 ms** |
| Plant tab → Health | showed a slice of the portfolio's newest 200 issues (could miss the plant's own issues) | the plant's own issues, paged |
| PM / washing calendar month over 4,000 entries | silently cut at 4,000 | flagged and labelled on screen |
| Washing read failing on the Overview | shown as zeros; on PostgreSQL also broke the rest of the request | rolled back, logged, shown as "not available" with Retry |

The main cause of the slow Overview and plant pages was **not SQL**. At 10x data the Overview spent about 35 ms in the
database and about 600 ms in Python, 93% of it inside the washing overview: it loaded every washing report of the last
90 days as full ORM objects (including the photo-evidence and table-code JSON), then serialised each recent report for
the browser, although the Overview only uses a few per-plant figures. The plant page built that same portfolio-wide
washing overview to show one plant. The plant tab's Module Cleaning page downloaded the **entire portfolio's** washing
overview (4.7 MB at 10x) to read one plant's row.

## 2. How the portal loads (traced)

| Screen | Requests | Notes |
|---|---|---|
| Sign-in | `/api/auth/session` | 1 query |
| Overview | `/api/portal/plants`, `/api/portal/overview`, `/api/portal/overview/range`, `/api/portal/overview/trend`, later `/api/portal/activity` | portfolio shared by Details, calendars, BOM, Movable Assets for 60 s |
| Views → Details | none (reuses the Overview portfolio) | |
| Health (all plants / one plant) | `/api/issues?limit=200[&site_code=]`, `/api/issues/assignees` | now one request per scope, "Load older issues" pages on |
| PM / Washing calendars | `/api/portal/calendar?kind=&month=[&site_code=]` | one request per month (plant tabs: that plant only) |
| Plant → Module Cleaning | `/api/scheduled/washing/overview?month=&plant_id=&include_reports=false`, `/api/scheduled/washing/plants/{id}/cycles` | was the whole portfolio overview |
| Plant details | `/api/portal/plants/{code}` (when opened from links) | |
| Exports | separate endpoints (`/api/issues/export`, ...) | unchanged; exports still read the complete set |

No duplicate API requests were observed in the measured flows (Overview, Details, Health, PM, Washing, plant pages).
The browser now shares identical in-flight GET requests anyway (see 5.4), so future modules cannot introduce them.

## 3. Baseline findings (before any change)

API benchmark, synthetic data, 20 warmed requests per endpoint (`scripts/benchmark_api_latency.py --daily-washing`):

10x data: plants 50, issues 10,000, pm tasks 7,500, washing tables 5,000, washing history 5,000, washing reports 4,000, handovers 500, handover items 1,500, daily washing reports 4,500. `total` is the server's own Server-Timing total.

| Endpoint | 1x p50 ms | 5x p50 ms | 10x p50 ms | 10x p95 ms | 10x DB ms | 10x queries | 10x KB |
|---|---:|---:|---:|---:|---:|---:|---:|
| `auth_session` | 2 | 2 | 2 | 4 | 0 | 1 | 0.5 |
| `portal_plants` | 7 | 9 | 11 | 12 | 1 | 3 | 24.3 |
| `portal_overview` | 38 | 269 | 664 | 723 | 35 | 10 | 54.1 |
| `overview_range_month` | 12 | 23 | 44 | 45 | 20 | 9 | 51.9 |
| `overview_trend_30d` | 11 | 22 | 46 | 110 | 24 | 8 | 1.0 |
| `portal_activity` | 9 | 13 | 23 | 24 | 12 | 7 | 6.4 |
| `plant_details` | 39 | 255 | 541 | 575 | 29 | 17 | 3.7 |
| `calendar_pm` | 11 | 103 | 303 | 315 | 14 | 6 | 1,533 |
| `calendar_washing` | 12 | 40 | 75 | 76 | 5 | 6 | 375 |
| `issues_health_page` | 12 | 21 | 27 | 30 | 9 | 3 | 144 |
| `issues_plant_tab` | 7 | 13 | 23 | 24 | 5 | 3 | 144 |
| `washing_page` | 55 | 466 | 1021 | 1099 | 8 | 5 | 4,767 |
| `washing_plant_tab` | 56 | 446 | 1041 | 1100 | 8 | 5 | 4,767 |
| `bom_list` | 7 | 8 | 8 | 9 | 1 | 6 | 0.1 |
| `movable_assets` | 6 | 6 | 7 | 8 | 1 | 5 | 0.0 |

Findings, in order of impact:

1. **Washing overview cost grows with plants x days**, and Overview, plant details and the plant tab all paid for the
   full version. cProfile of one Overview call at 10x: 0.97 s total, 0.90 s in `get_overview`; ORM row building
   0.53 s for about 8,600 objects, 17,300 JSON decodes (`evidence`, `cleaned_table_codes`), 4,350 `_report_out` calls
   whose output the Overview discards.
2. **Plant tab, Module Cleaning** fetched the portfolio washing overview (4.7 MB at 10x, 381 KB gzip) to read one row.
3. **Health page truncation (correctness).** It loaded the newest 200 issues of *all* plants and filtered by plant in
   the browser. With more than 200 recent issues portfolio-wide, a plant tab could miss that plant's issues, and the
   all-plants view showed only 200 with no way to see more. Issue paging also had no tie-breaker (`created_at` only),
   so offset pages could repeat or skip rows created in the same instant.
4. **Calendar truncation (correctness).** PM and washing calendars stopped at 4,000 entries per month without saying
   so. The 10x PM month hit exactly 4,000 (1.5 MB). Plant tabs downloaded the whole portfolio month and filtered it, so
   a plant's entries could be among those cut.
5. **Silent zero on failure.** `_washing_rows()` caught every exception and returned no data, which the Overview shows
   like an unconfigured plant. On PostgreSQL a failed statement also aborts the transaction, so the Overview's next
   query would fail anyway.
6. **Overview had no failure state.** `fetchPortfolio().then(...)` had no `catch`: a failed request left the Overview
   blank with no message or retry.
7. **Pool waiting was invisible.** Render runs one uvicorn process (`scripts/render_start.sh`, no `--workers`) with
   `DB_POOL_SIZE=5`, `DB_MAX_OVERFLOW=2`: at most 7 database connections per instance, while FastAPI runs sync routes on
   a 40-thread pool. Under concurrency, requests queue for a connection, but no timing showed it.
8. **The documented browser sampler did not exist.** `docs/SCALABILITY_AUDIT.md` described `Solar91Latency` and
   `?s91_latency=1`; the code only had an unused `latency` parameter in `apiFetch`.
9. **Benchmarks and load tests targeted retired endpoints.** The API benchmark and the Locust dashboard task measured
   `/api/bootstrap` and `/api/state/...`, which no current screen requests.
10. **Two plant-label queries** (code, then name) on every activity and calendar request: one avoidable round trip.

## 4. Root causes and changes

### 4.1 Washing summary path (backend) — `app/scheduled/washing_cycles.py`, `app/portal/service.py`, `app/portal/router.py`, `app/scheduled/router.py`
- `get_overview(..., include_reports=False)`: reports are read as plain rows of the 13 scalar columns the figures use
  (`_SUMMARY_REPORT_COLUMNS`); the JSON columns are never transferred or decoded, no ORM objects are built, and the
  report list is not serialised. `pending_reviews` is counted directly (same rule as before).
- In that mode only the reports the per-plant figures read are fetched: from the earliest of the first of the month,
  seven days ago, and each plant's earliest cycle start (a saved start can fall in the previous month), plus every
  report of this cycle month and every report awaiting review. The 12-month chart query and the cycle-event list
  (both whole-window, not used by these callers) are left out: `monthly` and `cycle_events` are empty in this mode.
- `get_overview(..., plant_ids={...})` computes only those plants, still inside the caller's scope (a Site Engineer
  asking for another plant gets no row; tested).
- HTTP: `GET /api/scheduled/washing/overview` accepts optional `plant_id` and `include_reports=false`. Without them
  the response is exactly as before (the Washing page and any other caller are unaffected).
- Overview, plant details and the plant operational profile use the summary; plant details computes one plant.
- **Figures are unchanged.** `tests/test_performance_paths.py` compares the summary with the full overview on data with
  confirmed, pending, rejected and rain-excused days, completed cycles, an old report awaiting review, a cycle start
  moved into the previous month, today and a past month. A mutation check (removing the cycle-start term from the
  shorter read) makes two of these tests fail, so they do guard it.

### 4.2 Failure handling
- `_washing_rows()` rolls back (the request is read-only) and logs `washing_overview_unavailable error=<type>`, and the
  Overview / plant details responses carry `"warnings": ["washing_unavailable"]`. The Overview shows "Module cleaning
  figures could not be read just now ... Retry"; the figures show as not available, never as zero.
- The Overview shows a clear error with Retry if its own request fails, instead of an empty page.

### 4.3 Health issues (correctness + payload) — `assets/js/site-issues.js`, `app/issues/repository.py`
- A plant tab requests that plant's issues (`site_code=`); all plants request the portfolio. Switching scope reloads
  for the new scope instead of slicing another scope's first page.
- When a page comes back full, a "Load older issues" control fetches the next page (deduplicated by ticket). The count
  line states that only the newest N are loaded and that filters apply to loaded issues.
- Issue paging is ordered by `created_at DESC, id DESC`, so pages never repeat or skip.

### 4.4 Calendars — `app/portal/service.py`, `app/portal/router.py`, `assets/js/data-adapter.js`, `assets/js/operations-calendar.js`
- `/api/portal/calendar` returns `truncated` and `limit`; one extra row is read to know. The calendar shows "This month
  has more than 4000 entries; only the first 4000 (earliest due) are shown. Open a single plant ...".
- The portfolio calendar makes one request per month; a plant tab requests only its plant (reusing a complete cached
  portfolio month when there is one). Order is stable (`due, id` / `report_date, id`).
- Plant code and name come from one query instead of two (activity and calendar).

### 4.5 Database connection pool — `app/core/observability.py`, `app/core/database.py`, `app/main.py`
- `TimedQueuePool` (PostgreSQL only) is `QueuePool` with timing: per request it records time spent waiting for a free
  connection (excluding time spent opening a new one, already reported as `conn`), checkouts, and the highest number
  of connections in use. Pool behaviour, sizes, timeouts and the idle-aware health check are unchanged.
- `Server-Timing` gains `pool;dur=<wait ms>;desc="<in use>/<capacity> in use"`; the slow-request log gains
  `pool_wait_ms`, `pool_in_use_max`, `pool_capacity`. `app` time now excludes pool waiting.
- Startup logs `database_pool size=5 max_overflow=2 per_process_max=7 workers=1 per_instance_max=7`.
- Pool sizes were **not** changed: there is no measurement showing waiting yet. See section 9 for how to decide.

### 4.6 Browser — `frontend/static/js/auth-gate.js`, `frontend/static/js/perf.js`, `assets/js/overview.js`, `assets/js/navigation.js`
- **In-flight request sharing.** Identical GETs that are already in flight share one network request. Only the response
  text is shared and every caller parses its own copy, so one module changing its data cannot affect another's.
  Nothing outlives the request; the map is cleared on sign-out. Requests with an abort signal are never shared;
  writes are never shared or retried.
- **`Solar91Perf` monitor** (`perf.js`, also available as `Solar91Latency`). Off by default; on with `?s91_perf=1` or
  `?s91_latency=1`, or `Solar91Perf.enable()`. `Solar91Perf.report()` prints, per API family: requests, shared, errors,
  client p50/p95, server total/db p50, queries, pool-wait p95, JSON parse time, decoded and transfer KB; plus UI timings
  (`navigate <page>`, `render overview tiles`, `render plants table`, `render issues`) and the `overview_usable`
  milestone. It keeps no URL, query string, body, token, user or record data and sends nothing. Correlate a slow
  request with its `X-Request-ID` / `Rndr-Id` headers and the server's `slow_or_failed_request` log.
- **Refresh without polling.** A background tab makes no requests. When the tab becomes visible and the Overview data
  is older than 60 s, the Overview (only if it is on screen and nothing is open or being typed into) reads its figures
  again, keeping filters and period. "Updated" now shows when the figures were read from the database (`asOf`), not
  when the page was opened.

### 4.7 Measurement tooling
- `scripts/benchmark_api_latency.py`: `--set portal` (default, the endpoints the portal requests today, including the
  plant tab's washing call), `--set legacy`, `--daily-washing` (one report per plant per day for 90 days).
- `loadtests/locustfile.py`: the dashboard task now performs the real sign-in sequence; the washing task uses the plant
  tab call; a calendar task replaces the retired lite bootstrap. Safety guards unchanged.

## 5. Results after the changes

Same data and method as section 3. `before → after` is shown where the change is larger than run-to-run noise (10%); otherwise only the current value. Single p95 spikes (for example `calendar_washing` 76 → 139 ms) are one slow sample out of 20 on a shared workstation, not a regression: those endpoints' code paths only lost a query.

| Endpoint | 1x p50 ms | 5x p50 ms | 10x p50 ms | 10x p95 ms | 10x queries | 10x KB |
|---|---:|---:|---:|---:|---:|---:|
| `auth_session` | 2 | 2 | 2 | 3 | 1 | 0.5 |
| `portal_plants` | 7 | 9 | 11 | 12 | 3 | 24.3 |
| `portal_overview` | 38 → **22** | 269 → **69** | 664 → **157** | 723 → **221** | 10 → **9** | 54.2 |
| `overview_range_month` | 13 | 22 | 44 | 47 | 9 | 51.9 |
| `overview_trend_30d` | 10 | 20 | 45 | 110 → **49** | 8 | 1.0 |
| `portal_activity` | 9 | 12 | 22 | 24 | 7 → **6** | 6.4 |
| `plant_details` | 39 → **16** | 255 → **24** | 541 → **46** | 575 → **48** | 17 → **15** | 3.7 |
| `calendar_pm` | 10 | 103 → **88** | 303 → **239** | 293 | 6 → **5** | 1,533 |
| `calendar_washing` | 12 | 38 | 74 | 76 → **139** | 6 → **5** | 375 |
| `issues_health_page` | 12 | 22 | 27 → **31** | 30 → **34** | 3 | 144 |
| `issues_plant_tab` | 7 | 13 | 24 | 25 | 3 | 144 |
| `washing_page` | 55 | 466 → **415** | 987 | 1027 | 5 | 4,767 |
| `washing_plant_tab` | 56 → **11** | 446 → **14** | 1041 → **19** | 1100 → **21** | 5 → **4** | 4,767 → **10.8** |
| `bom_list` | 6 | 7 | 8 | 9 | 6 | 0.1 |
| `movable_assets` | 5 | 6 | 6 | 8 | 5 | 0.0 |

Browser, 10x synthetic data, isolated local server (Chromium, warm assets; time to content = click until the screen's
data is drawn):

| Step | Before ms | After ms | API requests (after) | API KB before → after | Duplicate requests |
|---|---:|---:|---:|---:|---|
| initial load -> Overview KPIs | 922 | **486** | 5 | 131 → 131 | none |
| Views > Details (plants table) | 136 | **92** | 0 | 0 → 0 | none |
| Views > Health (issues) | 135 | **120** | 2 | 143 → 143 | none |
| Views > Preventive Maintenance | 434 | **355** | 1 | 1,517 → 1,517 | none |
| Views > Module Cleaning | 127 | **140** | 1 | 373 → 373 | none |
| Overview again (warm) | 40 | **30** | 0 | 0 → 0 | none |
| Plant > Details | 20 | **9** | 0 | 0 → 0 | none |
| Plant > Health | 18 | **49** | 2 | 0 → 143 | none |

`Plant > Health` is slower on purpose: before, it showed a slice of the portfolio's newest 200 issues that was already in memory (and could miss the plant's own issues, finding 3); now it requests that plant's issues.

Reading the results:
- Overview and plant details no longer grow with the number of washing reports in the 90-day window; they grow with the
  current month's reports. Plant details no longer depends on the number of plants.
- The plant tab's Module Cleaning call is now one plant's figures (a few KB) instead of the portfolio's 4.7 MB.
- Query counts are flat across 1x/5x/10x for every portal endpoint (no per-plant queries).
- Unchanged by design: `/api/scheduled/washing/overview` without parameters (the full Washing page payload) and the
  portfolio PM calendar (1.5 MB at 10x). See section 7.

## 6. Tests

Full suite: **668 passed** (`python -m pytest -q`, SQLite test configuration, about 10 minutes on this workstation). New: `tests/test_performance_paths.py` (11 tests: summary figures equal the full washing overview for today and a past month, including a cycle start moved into the previous month; the summary never reads the JSON columns; the one-plant filter returns exactly that plant and cannot widen a Site Engineer's scope; plant details match the Overview; a washing failure is reported, not shown as zero; calendar truncation is flagged; issue paging is stable when `created_at` ties; pool waiting is recorded) and three sign-in tests in `tests/test_sign_in_gate.py`. All frontend files pass `node --check`.

## 7. Remaining bottlenecks (measured, not fixed here)

1. **Washing page payload.** `/api/scheduled/washing/overview` (no parameters) is 4.7 MB / 1.0 s at 10x because it sends
   35 days of reports for every plant (and every report awaiting review). The current portal no longer requests it
   (the plant tab uses the one-plant form). If another screen starts using it, send reports per plant or per day on
   demand (the `day-activity` endpoint exists) instead.
2. **Portfolio PM calendar month.** 1.5 MB, about 0.3 s at 10x, and it hits the 4,000-entry limit (now labelled). Real
   portfolios with many PM units per plant will reach it. Next step: send the month as per-day counts per plant, and
   entries for a day or plant on demand.
3. **Overview at 10x is still about 157 ms locally**, mostly the per-plant Python passes over this month's
   reports. A further step is to compute per-plant monthly aggregates in SQL; this touches compliance code paths and
   was not done without a staging comparison.
4. **Round trips.** The Overview makes 10 queries. On Supabase each costs at least one network round trip; the startup
   log `database_latency round_trip_ms` shows its size. If it is 50 ms or more, the region (section 9) matters more than
   any code change.
5. **Cross-worker cache invalidation.** The washing overview cache (20 s) is per process; a write invalidates only the
   process that handled it. With one worker per instance (today) this is exact; with several workers or instances
   another process can show figures up to 20 s old.

## 8. Database indexes (candidates, not added)

No index was added: the rules require a PostgreSQL plan (`EXPLAIN (ANALYZE, BUFFERS)`) as evidence, and no staging
PostgreSQL was available here. Existing indexes already cover the hot filters (`issues(plant_id,status)`,
`issues(created_at DESC) WHERE deleted_at IS NULL`, `om_tasks(plant_id,status,due_on)`,
`washing_daily_reports(plant_id,report_date)` and `(plant_id,cycle_month,cycle_no)`). Candidates to evaluate on staging:

```sql
-- Overview "last activity" (max(updated_at) per plant) and the activity feed (ORDER BY updated_at DESC LIMIT n):
EXPLAIN (ANALYZE, BUFFERS) SELECT plant_id, max(updated_at) FROM issues WHERE plant_id = ANY(:plant_ids) GROUP BY plant_id;
EXPLAIN (ANALYZE, BUFFERS) SELECT plant_id, max(updated_at) FROM om_tasks WHERE plant_id = ANY(:plant_ids) GROUP BY plant_id;
-- if these show a sequential scan or a large heap read:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_issues_plant_updated ON issues (plant_id, updated_at DESC);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_om_tasks_plant_updated ON om_tasks (plant_id, updated_at DESC);

-- Health, one plant (newest first):
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM issues WHERE deleted_at IS NULL AND plant_id = :plant_id
  ORDER BY created_at DESC, id DESC LIMIT 200;
-- if it sorts many rows:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_issues_plant_active_created ON issues (plant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

-- PM calendar month (planned date wins over due date):
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM om_tasks WHERE plant_id = ANY(:plant_ids)
  AND coalesce(planned_due_on, due_on) BETWEEN :first AND :last ORDER BY coalesce(planned_due_on, due_on), id LIMIT 4001;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_om_tasks_plant_effective_due ON om_tasks (plant_id, (coalesce(planned_due_on, due_on)));
```

If a plan justifies one, add it as a new numbered migration (check `pg_indexes` first so nothing is duplicated),
apply on a backed-up staging database, re-run the plan, then promote. `CREATE INDEX CONCURRENTLY` cannot run inside a
transaction block, unlike the existing migrations' `BEGIN ... COMMIT`.

## 9. Required configuration checks (Render / Supabase) — nothing was changed

| Check | Why | How |
|---|---|---|
| Render plan | `render.yaml` declares `plan: free`; Free services sleep after 15 min idle and take about a minute to wake. That alone explains slow first loads. | Render dashboard. A paid instance removes the cold start. |
| Same region | `render.yaml` declares `singapore`. The Supabase project region was not visible here. Every query pays the round trip; the Overview makes about 10. | Supabase dashboard → project region; Render startup log `database_latency round_trip_ms` (50 ms or more means different regions). |
| Connection mode | `DATABASE_URL` must be the Session Pooler (port 5432). The code tolerates 6543 (transaction pooler) by disabling prepared statements. | Render environment panel. |
| Connection budget | Per instance 1 worker x (5 + 2) = 7. Total = instances x workers x 7 must stay under the Supabase pooler's client limit for the project's compute size. | Startup log `database_pool ... per_instance_max=7`; Supabase dashboard → Database → connection pooling. |
| Pool size | Only raise `DB_POOL_SIZE`/`DB_MAX_OVERFLOW` when `pool;dur` in Server-Timing (or `pool_wait_ms` in slow logs) shows waiting under real load, and the budget above allows it. | `Solar91Perf.report()` → `pool_wait_p95_ms`; Render logs. |

## 10. Deployment (manual, not performed)

1. No migration is required by these changes. (`038_bom_items.sql` from the BOM work is separate and still needs its
   own staging application.)
2. Deploy to staging. Confirm `/health/ready`, sign in, open Overview, a plant's Details/Health/Module Cleaning, and
   Views → PM/Module Cleaning.
3. Open the portal with `?s91_perf=1`, use it for a few minutes, run `Solar91Perf.report()`; compare with section 5.
4. Check the startup log lines `database_latency` and `database_pool`, and any `slow_or_failed_request` lines.
5. Only then promote to production.

## 11. Staging load test (not run)

Follow `docs/LOAD_TESTING_GUIDE.md` with `loadtests/run_locust.py` against a dedicated staging service with synthetic
data only, in stages of 1, 10, 25, 50 and 100 users. Record p50/p95 per request name, error rate, and from the server
logs `pool_wait_ms` / `pool_in_use_max`. Stop at the first stage where errors appear or p95 exceeds the objectives,
and fix that bottleneck before going further. Do not run it against production.

## 12. Limitations and unverified claims

- All timings are local SQLite on one machine, single process; Supabase adds a network round trip per query, Render
  adds its CPU and cold starts. The direction of the improvements (less Python work, fewer bytes, fewer queries) carries
  over; the absolute numbers do not.
- No concurrency was measured; the 100-user target remains unverified.
- No PostgreSQL query plan was examined; index candidates are hypotheses.
- Browser numbers come from headless Chromium on the same machine as the server (no real network).
- The synthetic fixture's PM distribution puts many tasks in the current month; real months may be smaller or larger.
- `tests/e2e_server.py` imports `tests/conftest.py`, which replaces `DATABASE_URL` with the test suite's own database,
  so browser runs through it never use the database they are given. The measurements here used a separate scratch
  server without that import; the e2e server itself was left unchanged.
