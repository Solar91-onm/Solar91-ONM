# Solar91-ONM — cumulative performance and portfolio growth release

## Installation

This archive is an overlay of changed/new files against the latest complete project supplied as `Solar91-ONM.zip`. It consolidates the later Site Issue routing and responsibility button, Other category handling, O&M Head issue corrections, My Issues view, personal notifications, gradient speech bubbles, notification UI synchronization, and the performance follow-up. Earlier PM, mobile/PWA, camera and retention work is already in that baseline. Do not reapply older overlays after this one. No database migration or category insertion is required if the existing category scripts have already been applied. No live database was modified.

## New performance changes

- Reuse the ordinary Module Cleaning summary through the existing bounded 60-second cache when navigating back. Month changes, explicit reloads, report requests and local-write invalidation still fetch fresh data. Failed reads are not cached. A different device's update can remain unseen for up to the cache TTL until a fresh read.
- Consolidate role-scoped PM Action Required counters in one conditional aggregate and issue counts in one aggregate. No new polling, changes to ownership, or reduction in access checks. The notification preview retains its separate bounded read when unread messages exist.
- Add 42/72-plant query/response-byte regression budgets and Chromium repeat-navigation tests. These enforce query and request counts, not unreliable absolute millisecond thresholds.

## Measurements

Synthetic isolated SQLite: 42/72 plants, 33/63 planned, 561/1071 monthly activities (17 per planned plant), 12 months of activities, 420/720 tickets and 1050/1800 notification records. The 42-plant PM fixture is approximate; actual portfolio baseline was 556 per month. Five requests per path, median of the last four; query counts exclude production authentication/dependency lookups and pooler/network overhead. Response bytes are decoded HTTP body bytes, not Supabase egress measurements. Default dashboard entry and inverter aggregate were measured in a subsequent run of the extended same-size fixture.

| Endpoint | 42 queries | 72 queries | 42 ms | 72 ms | 42 bytes | 72 bytes |
|---|---:|---:|---:|---:|---:|---:|
| Overview |10|10|33.99|47.77|100946|172348|
| Default dashboard month entry |14|14|34.91|49.67|100188|171050|
| Inverter equipment summary |1|1|3.12|3.31|1798|3028|
| Monthly PM |7|7|29.19|52.06|198438|377054|
| Daily PM filter |9|9|14.35|22.01|11152|21348|
| Cleaning summary |3|3|18.16|26.02|95422|162983|
| Issue register (limit=200) |1|1|10.07|10.31|138984|139043|
| My Issues (limit=200) |1|1|7.53|9.47|97289|139019|
| Dashboard version check |2|2|5.56|8.47|111|111|
| Head notifications (empty inbox) |3|3|4.63|5.68|659|659|
| Assignee notifications (unread preview) |4|4|6.00|7.24|2520|2522|

Notification summary before/after at 72 plants: Head 6 → 3 SQL statements; Assignee 5 → 4. The first head measurement is an empty inbox; a nonempty inbox may add the bounded preview query. Query counts are not the same as rows scanned. In PostgreSQL, inspect EXPLAIN ANALYZE and pg_stat_statements before tuning indexes or declaring production capacity.

Chromium isolated real cleaning-board rendering with 150 ms mocked API latency, 4 opens per run (first + 3 repeats), two animation frames after render. Repeat median before/after: 42 plants mobile 197/36 ms; 72 plants mobile 190/37 ms; 72 plants desktop 199/54 ms. Requests 4 → 1. Cold opening 237/185, 192/196, 219/211 ms respectively. Cold timing is not a proven speedup. This is a module-level browser test, not a live authenticated full portal navigation or sign-in benchmark.

## Verification

- Focused performance, PM, notification and routing: 41 passed in 25.57 s.
- Broader frontend/navigation, routing, correction and workflow regression: 209 passed in 47.65 s.
- Extended growth test (adds default dashboard and inverter summary): 2 passed in 4.19 s.
- Final deployment validation still requires the entire suite, PostgreSQL integration, authenticated mobile/desktop browser timing, real network egress, concurrent users and production cold-start checks. SQLite and mocked Chromium do not prove those.

## Operating at 72 plants

Use the existing bounded page sizes and date filters; avoid generating full historical portfolios for daily operations. Retain the one-process, 5-connection pool/no-overflow defaults and `prepare_threshold=None` for the Supabase transaction pooler. Verify deployment worker count before scaling processes. Keep the existing rate guards, compression, backoff and hidden-tab poll suspension. Use global responsibility rules with selected plant exceptions: the current exception map is capped at 2,000 entries and a fully enumerated 72-plant × 37-equipment matrix would exceed it. Do not increase the cap without measuring the rule editor payload. Use `/health/ready`, request timings and live database/storage/egress metrics; photo originals may dominate storage. The 72-plant PM monthly payload is ~377 KB decoded; avoid unnecessary background refreshes, use the day filter for field work. Actual historical data density and simultaneous users can change these results.

## Git Bash

Apply this ZIP to the existing project root. Keep your local environment and credentials. Run the following, review the staged files, and push only once tests pass. If main deploys automatically to production, verify staging first.

```bash
source .venv/Scripts/activate
python -m playwright install chromium
python -m pytest tests/test_portfolio_growth_budget.py tests/test_portfolio_navigation_speed.py tests/test_notification_centre.py tests/test_notification_alert_ui.py tests/test_site_issue_routing_budget.py -q --tb=short
python -m pytest tests/ -q --tb=short
git status
git diff --check
```

The exact archive paths to stage are below. Do not stage unrelated files, `.env`, SQL loaders or credentials.

```bash
git add -- \
  app/equipment/issue_routing.py \
  app/equipment/router.py \
  app/equipment/service.py \
  app/issues/importer.py \
  app/issues/repository.py \
  app/issues/router.py \
  app/issues/schemas.py \
  app/issues/service.py \
  app/notifications/router.py \
  app/pmplan/tracking.py \
  app/scheduled/washing_cycles.py \
  assets/css/notifications.css \
  assets/css/settings.css \
  assets/css/site-issues.css \
  assets/js/data-adapter.js \
  assets/js/navigation.js \
  assets/js/notifications.js \
  assets/js/operations-calendar.js \
  assets/js/settings.js \
  assets/js/site-issues.js \
  assets/js/washing-board.js \
  docs/PERSONAL_NOTIFICATION_RELEASE.md \
  docs/PORTFOLIO_GROWTH_PERFORMANCE_RELEASE.md \
  docs/SITE_ISSUE_ROUTING_RELEASE.md \
  tests/test_issue_deadlines_and_assignee_edit.py \
  tests/test_issue_head_corrections.py \
  tests/test_issue_head_corrections_ui.py \
  tests/test_notification_alert_ui.py \
  tests/test_notification_centre.py \
  tests/test_portal_frontend.py \
  tests/test_portfolio_growth_budget.py \
  tests/test_portfolio_navigation_speed.py \
  tests/test_site_issue_responsibility_dialog.py \
  tests/test_site_issue_routing.py \
  tests/test_site_issue_routing_budget.py

git diff --cached --check
git diff --cached --stat
git status
# Commit only the reviewed files; re-run tests after a rebase with remote changes.
git commit -m "perf: consolidate portal updates and guard 72-plant growth"
git pull --rebase origin main
python -m pytest tests/ -q --tb=short && git push origin main
```
