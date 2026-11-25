# Solar91 — application-managed recurring PM (no Supabase Cron)

## Install

1. Keep the existing migrations 049, 051 and 052 and the permanent schedule SQL `Solar91_PM_Recurring_From_December.sql`. The latter must have committed successfully; it installs `solar91_pm.monthly_rules`, `solar91_pm.generated_months`, and `solar91_pm.ensure_month(date)`. Do **not** re-run a successful data installation or delete any PM records.
2. Apply this changed-files patch on top of `Solar91_Portal_Performance_PM_Final.zip`. The `tracking.py` and PM tracking test include the previously supplied recurring-calendar corrections. Commit the files to the deployment branch and redeploy the backend.
3. `PM_RECURRING_JOB` defaults to `true`. No environment change is needed unless the deployment has explicitly set it to false. Set `PM_RECURRING_JOB=true` in that case. Do not overwrite the real `.env` with `.env.example`. The existing `PM_DAILY_JOB` flag is independent; leave its existing value unchanged.
4. Do not run the old `Solar91_PM_Enable_Automatic_Recurrence.sql`. No pg_cron extension, new database migration, public endpoint or RLS change is required. The application uses its existing trusted PostgreSQL connection. The private SQL functions are SECURITY INVOKER; that database role must already be authorised to access the private schema/functions and relevant tables. Do not grant these privileges to anonymous/authenticated browser roles. If permission errors occur, inspect the application database role and review least-privilege access with the database administrator.
5. Check the hosting service logs for `Application-managed monthly PM scheduler started (no Cron required)`. When new months are inserted, the logs include `PM recurrence committed`. A missing-schema warning means the permanent SQL has not been installed successfully, not that the whole portal is down.

## Scheduling behaviour

- Official start: December 2026. Dates follow the India business calendar. The normal horizon is the current month plus the following 11 months (December 2026 through November 2027 before the start).
- At application startup after deployment readiness, then once per hour, the backend checks for missing month records. A scoped PM page with missing assignments can signal an earlier check; this is coalesced and never performs generation in the request handler. The user may need to refresh or wait for the ordinary page refresh after a successful generation. Dates outside the rolling horizon are not materialized on demand.
- Gaps after downtime are recovered from December 2026 onward, prioritising the current rolling window. The batch size is three months with a one-minute gap while backlog remains. A database error rolls back the whole batch and is retried after five minutes. Persistent validation errors must be reconciled by an administrator; existing records are not changed to force success.
- The app delegates actual inserts to the existing `solar91_pm.ensure_month(date)` function, including month-end clamping and validation against the plant inverter configuration. The same advisory transaction lock, generated-month ledger and unique activity key prevent competing workers from generating duplicate rows. A worker that cannot obtain the lock skips the batch.
- Database work runs off the async event loop, using the existing bounded connection pool and per-statement/lock timeouts. It is independent of legacy reminder and washing jobs. A successful commit invalidates local overview caches. Other instances will see the new records through normal refresh/version checks.
- Existing generated months are immutable to the generator. Changes to future rules require deliberate schedule administration; deleting individual generated records does not make the scheduler recreate them, by design.
- An always-on application is needed for unattended generation. If the server sleeps or stops, pre-generated months remain readable; missed generation catches up when it restarts. No application scheduler runs while the app is stopped.

## Read-only verification (Supabase SQL Editor)

```sql
SELECT count(*) AS permanent_rules FROM solar91_pm.monthly_rules;
SELECT month_start, activity_count, inserted_count, generated_at
FROM solar91_pm.generated_months ORDER BY month_start;
```

Expected at initial installation: 159 rules and 12 generated months, with 159 activities per month for the 13 configured plants. `inserted_count` can be lower if matching records were adopted. The backend may extend the horizon as the current month advances. No new records should predate December 2026.

If you successfully registered a Cron job earlier, do not run two schedulers unnecessarily. First verify whether pg_cron exists (`SELECT extname FROM pg_extension WHERE extname='pg_cron';`). Only if it exists, inspect the named job (`SELECT jobid, jobname, active FROM cron.job WHERE jobname='solar91-pm-monthly-rolling-year';`). If present and no longer wanted, the job owner can unschedule just that job (`SELECT cron.unschedule('solar91-pm-monthly-rolling-year');`). Do not drop the extension or alter other jobs. If installation previously failed, there is usually no job to remove.

## Verification performed

47 focused local tests passed (scheduler unit tests using a fake PostgreSQL engine, SQLite portal PM/navigation/overview tests). Python compilation passed. No live Supabase access was used; actual PostgreSQL execution, RLS permissions, hosting restart and production load remain deployment checks.
