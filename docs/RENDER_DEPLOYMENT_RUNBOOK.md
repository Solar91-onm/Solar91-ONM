# Render deployment runbook

This runbook describes the current FastAPI + Supabase + Render deployment. It does not create a Render service or apply database changes.

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
| `SUPABASE_URL` | Project URL, for example `https://<project-ref>.supabase.co`. |
| `SUPABASE_ANON_KEY` | Supabase publishable/anon key; intentionally public and used by browser Auth. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only service credential for private Storage operations. Never expose it to the frontend. |
| `SUPABASE_STORAGE_BUCKET` | Private evidence bucket name; default is `scheduled-om-evidence`. |
| `ALLOWED_ORIGINS` | Comma-separated exact HTTPS origins; include the Render URL and any active custom domain. |

`PORT` is assigned by Render and must not be set manually. `SUPABASE_JWT_SECRET` is optional and only for projects still using the legacy HS256 signing secret; asymmetric signing keys are verified through the Supabase JWKS endpoint. Other optional settings include `BOOTSTRAP_ADMIN_EMAILS`, `APP_PUBLIC_URL`, `RESEND_API_KEY`, `MAIL_FROM`, `MAX_UPLOAD_MB`, and the `DB_POOL_*` variables. `PM_DAILY_JOB` defaults to `0`.

## Supabase setup

1. Configure Supabase Auth's Site URL to the deployed HTTPS origin, e.g. `https://<service>.onrender.com`.
2. Add that origin to the Auth redirect URL allowlist. Add the custom domain too, if one is used.
3. For this portal's current sign-in screen, create/confirm staff accounts in Supabase Auth and distribute credentials securely. Public self-registration should remain disabled unless the business explicitly chooses otherwise.
4. Configure email confirmation and password recovery policy in Supabase. The browser persists and refreshes sessions using the Supabase JS client.
5. Keep the evidence bucket private. The application uses its server-side service-role key and applies Solar91 route/role checks before file access.
6. Back up the database and Storage objects before schema changes. A database backup does not include Storage objects.

## Database migration safety

The Render startup process runs `scripts/preflight.py` and `scripts/ensure_storage.py`; it does **not** apply SQL migrations. This is intentional: the repository's historical SQL set includes data-changing statements, and `scripts/migrate.py` has no migration ledger or per-file approval mechanism.

Before a test or production deployment:

1. Identify the exact unapplied migration(s) from the database's actual schema and the migration history.
2. Take a database backup and Storage-object backup; confirm restoration access.
3. Review each SQL file, including any `DELETE`, `DROP`, or data rewrite, with the database owner.
4. Apply only the approved SQL against the intended Supabase project using its SQL editor or a controlled migration process. Do not blindly run `scripts/migrate.py` against a populated database.
5. Verify schema and representative records/relationships before routing users to the service.

The application checks PostgreSQL connectivity for readiness but does not prove that every application table is current.

## Deploy and smoke test

1. Review the Git diff and tests, then push the approved branch to GitHub.
2. In Render, create/refresh the Blueprint from `render.yaml`; verify it will create/update only the intended `solar91-om` service.
3. Add the environment variables above in Render and deploy. Do not deploy if preflight fails.
4. Confirm `/health` returns HTTP 200 and `/health/ready` returns HTTP 200 with `status: "ready"` and `auth_configured: true`.
5. Open the service URL, sign in as an existing Supabase Auth user, and verify `/api/auth/session`, plant scope, issue workflows, evidence access, and sign-out.
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

**Supabase project**: the supplied browser-public `SUPABASE_URL` and `SUPABASE_ANON_KEY` are populated in `.env.example` and `render.yaml`. They are not database credentials. The uploaded configuration did **not** contain a completed `DATABASE_URL`. Obtain the **PostgreSQL Session Pooler** connection string from Supabase Dashboard → Connect; paste it into Render Environment (set `sslmode=require`). Ensure the database schema was previously migrated before connecting production.

`SUPABASE_SERVICE_ROLE_KEY` must be configured **only in Render → service → Environment** (and locally in ignored `.env` if needed). Do **not** put the live key into `.env.example`, `render.yaml`, frontend JS, committed source, logs, or a downloadable ZIP. Because a service-role credential was shared in a conversation/file, rotate it in the Supabase dashboard and replace the Render environment value with the newly issued key.

Set `APP_PUBLIC_URL` to your actual deployed HTTPS URL, `ALLOWED_ORIGINS` to that exact origin (plus any custom domain), and `BOOTSTRAP_ADMIN_EMAILS` privately in Render. Redeploy after setting these values. `APP_ENV` must be `production`. Do not rely on `localhost` example origins in production.

Test `https://<your-host>/health/ready`: it must return HTTP 200; a 503 means server bootstrap/database preflight has not completed. Inspect Render deployment logs (do not share secrets). Use a new incognito tab for frontend verification; the new asset query version prevents mixed cached JS generations. Actual Render and real Supabase checks were **not** performed in this build environment.
