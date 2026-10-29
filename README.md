# Solar91 O&M Portal — Field Desk + stabilized source release

FastAPI operations portal for Solar91's solar plants, equipment, Site Issues, scheduled maintenance, washing, reports and administrative access. The **database is authoritative**: the browser sends operational writes to FastAPI, backed by Supabase PostgreSQL. Clerk sends email sign-in codes; Solar91 roles and access scopes remain in the application database.

The portal includes a **site-engineer-first Field Desk** for daily issue and scheduled maintenance work, plus a top-left Ask Solar91 entry. The search assistant is read-only and grounded in role-authorized operational data. See [`docs/FIELD_DESK_RELEASE_2026-10-13.md`](docs/FIELD_DESK_RELEASE_2026-10-13.md) for access rights and verification.

## Operations Calendar

The new **Operations Calendar** combines authorised Site Issues, individual PM work orders, actual washing reports and configured washing-cycle deadlines in compact month/week/day views, with plant-scoped filtering, severity/status colours and anchored detail popups. It keeps all existing record workflows intact. Implementation, security and local verification are documented in [`docs/OPERATIONS_CALENDAR_IMPLEMENTATION.md`](docs/OPERATIONS_CALENDAR_IMPLEMENTATION.md).

## Daily field operations

**Site Engineers are the principal on-plant workers.** An O&M Head assigns each Site Engineer one plant via Team & Access. On sign-in, the first dashboard displays a live Field Desk: open issues, critical priorities, scheduled PM and overdue PM. Engineers can record a field observation directly against an active issue; the note enters PostgreSQL issue history without changing ownership or closing the ticket. Existing PM and Washing modules remain available for executing scheduled jobs and evidence. The O&M Head and Assignee continue their existing workflows. An approved **Administration** account is the read-only observer role; newly created **Viewer** accounts stay blocked until promoted.

The **Ask Solar91** entry under the upper-left sidebar brand searches the currently loaded, role-authorized operational data. It never writes records.

## Architecture

- Python/FastAPI and SQLAlchemy (PostgreSQL production; SQLite **tests only**).
- Plain JavaScript/CSS frontend served by FastAPI at `/`; asset files at `/static/`.
- Clerk email-code sign-in; session tokens and verified email identity are checked on the server before loading Solar91 roles and plant permissions.
- Supabase PostgreSQL for operational records, Supabase Storage for protected evidence.
- Render web-service deployment configuration: `render.yaml` and `scripts/render_start.sh`.

## Windows PowerShell: local development

Use Python 3.12 (also tested with Python 3.13 in this environment), Node.js for frontend regression checks, and a **nonproduction** Supabase project.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
notepad .env
```

Replace placeholders in `.env` with the **staging/test project's** credentials. `DATABASE_URL`, `SUPABASE_URL`, the Clerk publishable/secret keys, and the exact Clerk session issuer are required to operate the application. `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_STORAGE_BUCKET` are required for protected evidence file operations. **Never** put the Clerk secret key, service-role key, or DB password in browser code.

Once the staging database schema is in the required state, check it and launch:

```powershell
python scripts/preflight.py
python scripts/ensure_storage.py
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Open `http://127.0.0.1:8000/` and sign in using the emailed code for a Clerk account whose Solar91 role/scope is configured. Set Clerk's allowed origin and enable email-code verification in its dashboard. Check `/health` for process liveness, `/health/ready` for live database access and `/docs` for the FastAPI API reference. `/health` **alone does not prove** database connectivity.

**Migrations:** `database/migrations/001_*.sql` through `028_*.sql` are the supplied historical migration set. Review current schema, back up staging, and apply **only missing, approved migrations in order**. Do not indiscriminately re-run all SQL on an existing instance. No new migration was required for this release.

## Linux/macOS: local development

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
# Fill in .env with staging Supabase credentials
python scripts/preflight.py
python scripts/ensure_storage.py
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

## Execute tests

Install test dependencies and Node.js (used by the extreme-date regression test):

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

To perform the optional full browser/HTTP/SQLite smoke test, have Chromium on PATH or install the Playwright Chromium browser, then run:

```powershell
python -m playwright install chromium
python scripts/browser_smoke.py
```

On Linux/macOS, the same Python commands work once a browser is available. The smoke test launches an **isolated test-only** FastAPI server, SQLite database, and synthetic identity; it does **not** authenticate against Supabase or modify hosted data. The smoke script exits nonzero on a failure. On managed systems that block local HTTP navigation, it has a browser inlining/real-API fallback and prints that limitation.

Check JS syntax manually with Node:

```powershell
Get-ChildItem frontend/static/js/*.js | ForEach-Object { node --check $_.FullName }
```

Or on Linux/macOS: `for f in frontend/static/js/*.js; do node --check "$f" || exit 1; done`.

## Deployment

`render.yaml`, `Dockerfile`, and the [Render runbook](docs/RENDER_DEPLOYMENT_RUNBOOK.md) are provided for the existing Render service. Set private environment variables through the Render dashboard. Configure Clerk's allowed origins and email-code sign-in, then follow [`RELEASE_VALIDATION.md`](RELEASE_VALIDATION.md) to verify readiness and permissions in staging. This source has not been deployed to Render or connected to production services.

Production entry point: `uvicorn app.main:app`; test-only entry point `tests.e2e_server:app` is strictly for local browser smoke tests and is guarded against accidental production execution.

### Portal hangs after a Render deployment? (October 2026 stability release)

Check `/health/ready` first. If it returns 503, solve the Render database/service configuration before changing frontend files. Clerk keys configure authentication; Supabase credentials configure PostgreSQL and private Storage, which still require their own **PostgreSQL Session Pooler `DATABASE_URL`**. Copy `.env.example` locally and fill missing private values in ignored `.env`; for Render, add private values in its Environment panel. Never commit private credentials. See `docs/RENDER_DEPLOYMENT_RUNBOOK.md` for the exact variable names.

If the backend is ready but navigation seems blocked, refresh in a private browsing window to eliminate old JS caches. Press **Escape** to close a stuck modal. If startup cannot complete in 16 seconds, the login splash displays a Reload portal control.

### Interactive Work Radar & Ask Solar91 (13 Oct 2026)

The dashboard includes an interactive Work Radar for Overdue, Due Today, Next 7 Days, and Active Work. Click the cards, the work-type legend (Issues / PM / Washing), or equipment chips to filter the action list; **Open work** enters the matching real register. The older Field Desk can be expanded, so no issue/PM/Washing features were removed. Ask Solar91 uses role-authorized live search and clickable records, with **optional** opt-in AI narration if you configure `OPENAI_API_KEY` and `AI_ASSISTANT_ENABLED=true` privately on Render. Without this opt-in it remains a grounded, read-only search assistant. Full details and scope limitations: [Work Radar and Ask Solar91 guide](docs/WORK_RADAR_AND_ASK_SOLAR91_2026.md).
