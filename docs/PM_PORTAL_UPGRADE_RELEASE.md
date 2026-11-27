# Solar91-ONM | PM portal and Login Access upgrade

Date: 27 November 2026. Based on the supplied source snapshot, not a remote repository or a live Supabase instance.

## Scope and operational decisions

- Portfolio Date and Compliance filters, with server business date and SQL-side date selection. Compliance is whole-period plant status, not the subset of visible activities. The synthetic portfolio uses 42 plants (33 scheduled, 9 unplanned), 556 activities/month. Counts are dynamic.
- Unified recurring PM schedule editor for both O&M Head and Assignee, regardless of equipment responsibility. The editor validates exact inverter counts and numbers, active plant, history, collisions, month-end clamping, and scope. Changes are staged until a server preview and one save. The preview is revalidated under locks. Started/reviewed activities and evidence are preserved. Recurrence rules and eligible generated activities commit together. Site Engineer checklist submission and Head-only approval/return are unchanged.
- Equipment responsibility in Login Access routes new site issues by canonical equipment category to the active primary Assignee across all plants. Saving an active primary also routes existing open unassigned issues atomically, with ticket history and a summary notification. Existing assigned issues, legacy free-text owners, closed/deleted issues and backup-only categories are not automatically reassigned. Explicit authorized assignment remains an override. If no primary is configured, the old Assignee-reporter self-assignment fallback remains; other reporters' tickets remain open and the Head is notified.
- Existing TrafficGuard, role controls, compression, health routes, pool configuration, and vanilla JS remain in place. The PM change uses bounded caching and visible-tab polling with backoff; this release is not a full portal-wide performance audit.

## Measured local results (SQLite, synthetic data)

| Metric | Before | After |
|---|---:|---:|
| Daily main activity loader rows (includes the old duplicate month read) | 576 | 20 |
| Daily median request time | 20.73 ms | 15.83 ms |
| Daily SQL statements | 8 | 9 |
| Daily JSON bytes, before compression | 9814 | 9798 |
| Monthly main activity loader rows | 556 | 556 |
| Monthly median request time | 34.62 ms | 35.64 ms |
| Monthly SQL statements | 7 | 7 |
| Monthly JSON bytes, before compression | 191286 | 191253 |

Latency is from six requests per scope (first warm-up excluded) on a local test client; these figures are not production latency, actual network transfer, or Supabase egress savings. Daily query count increases by one; monthly performance improvement is not claimed. Production pg_stat_statements, real browser traces, slow-network load testing, and free-tier quota verification are pending. No remote database was reset or modified.

## Deployment: do not skip staging

1. Preserve the original source and back up the existing database. Overlay the changed-files ZIP onto the original checkout, or use the clean full source ZIP. Neither archive contains .git, live .env, generated caches or runtime data. Restore your deployment environment variables from your own secure configuration.
2. Verify that the current PostgreSQL database already contains `solar91_pm.monthly_rules`, `solar91_pm.generated_months`, `solar91_pm.ensure_month(date)`, `public.pm_tracking_activities`, `public.pm_unit_config`, `public.equipment_responsibilities`, and the existing audit/notification tables. This upgrade adds no DDL. Migration 053 in the original source contains historical hardcoded rollout checks for 13 plants; do not rerun it or the old Jodhpur loader on the current 33-plant database. Verify the live constraints, grants and function body first. Missing recurring schema makes the editor return 503 rather than writing to an unexpected schema.
3. In staging, confirm the 33 current schedules, compare existing activities before/after, create one of the unplanned plant schedules, verify every generated month and month-end clamping. Test both scopes, concurrent recurrence, stale previews, evidence protection, rollback, and protection of returned/submitted/approved work. Verify that the existing recurring generator remains compatible with the final rule set. The SQLite suite cannot prove PostgreSQL locking, casts, constraint interactions, permissions or the full transaction path.
4. Test Login Access with Head, Assignee and Site Engineer. Save a primary from each configuration view and confirm open unassigned tickets route once, existing assigned/closed tickets stay put, and the audit and notification are created. Confirm Assignee can manage PM outside their equipment responsibility and cannot approve/return a checklist.
5. Record real PostgreSQL and browser baselines and compare after deploy, including p95 latency, connection-pool waits, cache behavior, actual transferred bytes, mobile rendering, and quota usage. Monitor errors and roll back application code if necessary; do not roll back approved schedule or issue data by blindly restoring old rules.

## Verification commands

```sh
python -m pytest -q tests/test_pm_tracking.py tests/test_pm_recurrence.py tests/test_pm_schedule_edit.py tests/test_pm_schedule_editor.py tests/test_pm_navigation_and_register.py tests/test_pm_scale_budget.py tests/test_equipment_responsibility.py tests/test_issue_workflow_rules.py tests/test_issue_bulk_assign.py tests/test_photo_live_api.py
node --check assets/js/pm-tracking.js
node --check assets/js/settings.js
node --check assets/js/site-issues.js
```

Existing PM regression run: 47 passed in 17.63 s (before the Login Access additions). Login Access, schedule editor and issue workflow regression run: 50 passed in 16.96 s (overlapping test sets). Neither count constitutes full-suite coverage.

The original prompt lists five changes but supplies only four numbered PM items. The additional Login Access request is treated as the fifth implemented workstream, without inferring any other feature.

Final combined targeted regression run: **97 passed in 34.56 seconds**, exit code 0. The three modified JavaScript files passed `node --check`. The full project suite and live PostgreSQL/browser verification are not complete.


## Follow-up release validation (corrected candidate)

- Reproduced a daily filter defect hiding legacy-only PM work. Selection now occurs after authorized legacy work orders and visible plan markers are included. The new regression covers legacy-only, plan-only, empty dates and Site Engineer plant scoping. Compliance continues to describe the recurring checklist system, not legacy work order approval.
- Default DB pool overflow and Render DB_MAX_OVERFLOW are now zero (5 connections maximum per application process). Existing deployment environment variables must be checked; additional replicas or workers multiply this budget. The transaction pooler prepared-statement compatibility setting is unchanged.
- Post-fix focused tests: 36 passed in 16.12 seconds (PM tracking, scale budget, editor planner and equipment responsibility). Previous release: 97 targeted tests passed; a broader repeat did not complete within the available execution window. Full-suite and real browser results are not certified. Browser smoke timed out loading the authenticated shell in the local browser transport; cause unresolved.
- PostgreSQL server, driver and live Supabase credentials were not available in this validation environment. Real schedule commits, locking, schema/grants, storage/auth, live load and rollback remain mandatory staging gates. SQLite tests deliberately return 503 for the permanent editor, which requires PostgreSQL.
- Status: staging candidate only, not a production go-live approval. No migrations added or executed and no live data changed.
