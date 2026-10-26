# Scalability deployment checklist

Use this checklist for a controlled staging rollout first. Configure secret values through Render's private environment settings or an approved secret manager; this file intentionally lists names only.

## Configuration and Render

- [ ] Set `APP_ENV`, `DEBUG`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_ISSUER`, and `ALLOWED_ORIGINS`.
- [ ] Review optional `DB_POOL_SIZE`, `DB_MAX_OVERFLOW`, `DB_POOL_RECYCLE_SECONDS`, `MAX_UPLOAD_MB`, `BOOTSTRAP_CLOSED_ISSUE_DAYS`, `BOOTSTRAP_PM_HISTORY_DAYS`, `STATE_SYNC_ENABLED`, and background-job settings.
- [ ] Confirm aggregate pool connections across every Render process/instance remain below the Supabase pooler quota with operational headroom.
- [ ] Use the documented Supabase PostgreSQL Session Pooler connection mode for the Render service; do not infer that a successful app start proves schema completeness.
- [ ] Keep one worker for the current single-process background-job/startup assumptions; only increase process/instance counts after reviewing pool capacity and scheduled-job behavior.
- [ ] Verify Docker build/start command and `/health/ready`; observe startup logs for preflight errors without exposing credentials.

## Supabase, roles and storage

- [ ] Compare live schema and index catalog to the migration history; take and verify a backup before any manual SQL.
- [ ] Apply only individually reviewed, missing migrations. Application startup does not apply SQL automatically.
- [ ] Verify Clerk issuer/origin and a test account for each applicable Solar91 role.
- [ ] Verify plant/equipment scoping and denied access for out-of-scope records.
- [ ] Verify the configured evidence bucket exists and is private. Check storage policies and confirm service-role credentials remain server-only.
- [ ] Exercise allowed file types, upload-size limits, unauthorized retrieval denial, failed upload behavior and evidence-to-record association.

## Smoke tests by module

- [ ] Dashboard/Field Desk: role-scoped counts, refresh and next-fetch freshness.
- [ ] Plants/equipment: filtered page, detail, assignment and document access.
- [ ] O&M issues: create, list/search, assign, update, close/reopen, activity and evidence.
- [ ] Scheduled PM: list, start, complete, follow-up and recurrence behavior.
- [ ] Washing: cycle/day report, table counts, before/after evidence, assignee and O&M Head confirm/reject.
- [ ] Handover: checklist assignment, evidence, submit, verify/reject and persisted refresh.
- [ ] Extra services, notifications, audit, imports, SCADA and exports: verify permissions and persisted values for enabled modules.
- [ ] Confirm a second authorized user sees saved assignment/status after the next fetch; do not describe the app as globally real-time.

## Rollout, monitoring and rollback

- [ ] Run unit/integration and frontend checks in CI; record staging build and test evidence.
- [ ] Run guarded staging load stages at 1, 25, 50 and 100 users only with synthetic data, monitoring and owner approval.
- [ ] Record p50/p95/p99, RPS, error/timeout rate, Render CPU/memory, database latency/connections and upload outcome.
- [ ] Stop and investigate if integrity checks fail, authorization is incorrect, errors exceed the agreed target, or resource headroom is exhausted.
- [ ] After deployment, confirm `/health/ready`, login, representative role scope, module smoke tests, error logs and resource headroom.
- [ ] Roll back application code to the last known-good Render deployment if required. Database and Storage recovery are separate; restore only from verified backups under the database owner's process.

## Known limits

The current state bootstrap still has unbounded legacy collection reads. No live schema, Render, Supabase Storage or concurrent-user measurements are included in this source delivery. Do not infer production capacity from local SQLite tests.
