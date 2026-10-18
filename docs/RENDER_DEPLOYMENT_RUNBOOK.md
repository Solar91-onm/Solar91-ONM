# Render deployment runbook

This runbook describes the current FastAPI + Clerk + Supabase + Render deployment. It does not create a Render service or apply database changes.

## Runtime configuration

- Render Blueprint: `render.yaml`
- Build: Render builds the root `Dockerfile` (Python 3.12 slim; installs `requirements.txt`).
- Start: `sh scripts/render_start.sh`
- Process: `uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers --forwarded-allow-ips="*"`
- Health check: `/health/ready`
- Static files and templates are served by FastAPI from the packaged `frontend/` directory.
- Render Free may sleep after inactivity. The service is for testing/demo use, not continuous operations.

## Required Render environment variables

Configure these in the Render service environment. Never place secret values in Git or browser code.

| Name | Purpose |
| --- | --- |
| `APP_ENV` | Set to `production`. |
| `DEBUG` | Set to `false`. |
| `DATABASE_URL` | Supabase PostgreSQL Session Pooler URI using `postgresql+psycopg://`, port `5432`, and `sslmode=require`. |
| `SUPABASE_URL` | Project URL, for example `https://<project-ref>.supabase.co`; used for Storage. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only service credential for private Storage operations. Never expose it to the frontend. |
| `SUPABASE_STORAGE_BUCKET` | Private evidence bucket name; default is `scheduled-om-evidence`. |
| `CLERK_PUBLISHABLE_KEY` | Clerk publishable key; safe to send to the browser. |
| `CLERK_SECRET_KEY` | Server-only Clerk API key used to confirm verified email identity. |
| `CLERK_ISSUER` | Exact issuer origin of Clerk session tokens, such as `https://<instance>.clerk.accounts.dev`. |
| `ALLOWED_ORIGINS` | Comma-separated exact HTTPS origins; include the Render URL and any active custom domain. |

`PORT` is assigned by Render and must not be set manually. Other optional settings include `BOOTSTRAP_ADMIN_EMAILS`, `APP_PUBLIC_URL`, `RESEND_API_KEY`, `MAIL_FROM`, `MAX_UPLOAD_MB`, and the `DB_POOL_*` variables. `PM_DAILY_JOB` defaults to `0`.

## Clerk setup

1. Add the deployed HTTPS origin and any active custom domain to Clerk's allowed origins.
2. Enable email address verification with email codes in the Clerk Dashboard. The portal sends codes for sign-in and uses verified email to match existing Solar91 invitations and accounts.
3. Copy Clerk's publishable key and secret key to the service environment. Set `CLERK_ISSUER` to the issuer origin shown in a Clerk session token; do not set a JWKS URL here.
4. Existing Supabase Auth accounts are not used for login. On first Clerk sign-in, the portal links the Clerk identity to a matching verified Solar91 email while preserving that user's role and assignments.
5. Keep the Supabase evidence bucket private. The application uses its server-side service-role key and applies Solar91 route/role checks before file access.
6. Back up the database and Storage objects before schema changes. A database backup does not include Storage objects.

## Database migration safety

The Render startup process runs `scripts/preflight.py` and `scripts/ensure_storage.py`; it does **not** apply SQL migrations. This is intentional: the repository's historical SQL set includes data-changing statements, and `scripts/migrate.py` has no migration ledger or per-file approval mechanism.

Before a test or production deployment:

1. Identify the exact unapplied migration(s) from the database's actual schema and the migration history.
2. Take a database backup and Storage-object backup; confirm restoration access.
3. Review each SQL file, including any `DELETE`, `DROP`, or data rewrite, with the database owner.
4. Apply only the approved SQL against the intended Supabase project using its SQL editor or a controlled migration process. Do not blindly run `scripts/migrate.py` against a populated database.
5. Verify schema and representative records/relationships before routing users to the service.

The application checks PostgreSQL connectivity for readiness but does not prove that every application table is current. The `SUPABASE_URL` setting must be the HTTPS project origin (or a localhost origin for local development), without `/rest/v1`, `/auth/v1`, query parameters, or fragments. Validation errors do not include the configured URL.

Production startup retries transient PostgreSQL/Storage connection failures with exponential backoff capped at 60 seconds while readiness remains unavailable. Deterministic configuration errors and a missing or public Storage bucket do not retry. Startup verifies the configured bucket only; it never creates, changes, or deletes a bucket. Verify that the existing `scheduled-om-evidence` bucket is private before deployment; if it is missing or public, stop and investigate without recreating or changing it.

### `relation "users" does not exist` / `/health/ready` returns `schema_missing`

The service reached a PostgreSQL database that has no Solar91 tables. This usually happens after switching to a new Supabase project: `DATABASE_URL` points at the new project but its schema was never created, or it still points at a different project than the one holding the data.

- Startup preflight now checks for the core tables (`users`, `plants`, `issues`, `om_tasks`), logs `ERROR: ... Solar91 tables are missing` with the user/host it used, keeps the portal unavailable, and re-checks with back-off. It becomes ready by itself once the schema exists; no redeploy is needed.
- API requests that hit a missing core table return `503 database_schema_missing` with one concise log line per minute instead of a traceback on every refresh.
- To fix: in Supabase SQL editor for the intended project run `select to_regclass('public.users');`. Or, from a machine whose `.env` has that project's `DATABASE_URL`: `python scripts/migrate.py --check` (read-only). For a brand-new empty project, `python scripts/migrate.py` applies every migration in one transaction; it refuses to run when Solar91 tables already exist. `NULL` means the schema is absent. Confirm you are on the right project first, then apply the approved migrations in order as described above. Moving existing data from the old project is a separate, explicitly approved step.

## Deploy and smoke test

1. Review the Git diff and tests, then push the approved branch to GitHub.
2. In Render, create/refresh the Blueprint from `render.yaml`; verify it will create/update only the intended `solar91-om` service.
3. Add the environment variables above in Render and deploy. Do not deploy if preflight fails.
4. Confirm `/health` returns HTTP 200 and `/health/ready` returns HTTP 200 with `status: "ready"` and `auth_configured: true`.
5. Open the service URL, sign in with a Clerk email code, and verify `/api/auth/session`, plant scope, issue workflows, evidence access, and sign-out.
6. Review Render logs for startup/preflight errors without copying credentials or tokens into tickets.
7. Record the actual deployed URL and smoke-test results. A successful build alone is not a deployment smoke test.

The PM/washing reminder loop is disabled by default. If it is required, operate it on exactly one continuously running worker after confirming its schedule, idempotency, and alerting. Do not enable it on multiple web replicas. Render Free sleep/restarts can interrupt the loop.

## Rollback and recovery

- Application rollback: use Render's prior known-good deployment/commit. Verify the previous image starts and passes `/health/ready`.
- Database rollback: no automatic rollback is provided. Restore only from a verified backup under the database owner's change procedure; never use a destructive reset to recover.
- Storage rollback: restore evidence objects separately and verify object metadata/paths against database references.
- Restore the required environment variables from the organization's secret manager/approved record, not from logs or committed files.

## Release limitations

No Render service is created or deployed by repository changes alone. Before production use, demonstrate database and Storage restoration, confirm monitoring/alerts, run end-to-end Auth and resource-scope tests against a non-production Supabase project, and select hosting that meets availability and background-job requirements.

## October 2026: browser-freeze recovery and Supabase settings

This release makes frontend assets revalidate after deployment, clears old modals during navigation, limits recursive render storms, and avoids live-refresh redraws while the operator interacts with the UI.

**Supabase project**: `SUPABASE_URL` is used for Storage; it is not the database credential. The configuration does **not** contain a completed `DATABASE_URL`. Obtain the **PostgreSQL Session Pooler** connection string from Supabase Dashboard → Connect; paste it into Render Environment (set `sslmode=require`). Ensure the database schema was previously migrated before connecting production.

`SUPABASE_SERVICE_ROLE_KEY` must be configured **only in Render → service → Environment** (and locally in ignored `.env` if needed). Do **not** put the live key into `.env.example`, `render.yaml`, frontend JS, committed source, logs, or a downloadable ZIP. Because a service-role credential was shared in a conversation/file, rotate it in the Supabase dashboard and replace the Render environment value with the newly issued key.

Set `APP_PUBLIC_URL` to your actual deployed HTTPS URL, `ALLOWED_ORIGINS` to that exact origin (plus any custom domain), and `BOOTSTRAP_ADMIN_EMAILS` privately in Render. Redeploy after setting these values. `APP_ENV` must be `production`. Do not rely on `localhost` example origins in production.

Test `https://<your-host>/health/ready`: it must return HTTP 200; a 503 means server bootstrap/database preflight has not completed. Inspect Render deployment logs (do not share secrets). Use a new incognito tab for frontend verification; the new asset query version prevents mixed cached JS generations. Actual Render and real Supabase checks were **not** performed in this build environment.
