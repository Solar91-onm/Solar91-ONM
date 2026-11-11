# Solar91 O&M Portal

Web portal for running operations and maintenance on Solar91's solar plants: plant records, site issues,
preventive maintenance (PM), module washing, BOM and movable assets.

- Backend: Python, FastAPI, SQLAlchemy
- Database: PostgreSQL on Supabase (tests use SQLite)
- Files and photos: Supabase Storage (private bucket)
- Sign-in: Clerk email codes. Roles and plant access are stored in our own database.
- Frontend: plain JavaScript and CSS, served by FastAPI
- Hosting: Render (Docker)

## Folders

```
app/            backend, one folder per feature (issues, scheduled, portal, bom, ...)
assets/         portal frontend (css/, js/, images/), served at /assets
frontend/       page template, sign-in screen, brand images, PWA files, Excel templates
database/       SQL migrations (database/migrations/) and Supabase notes
scripts/        start-up checks, migrations, seed data, backups, benchmarks
tests/          automated tests (pytest)
loadtests/      Locust load tests (staging only, never production)
launchers/      double-click start files for Windows, Mac and Linux
docs/           deployment runbook, workflow and performance notes
```

## Pages

- **Overview**: portfolio tiles, PM and washing compliance, plant comparison, critical issues, recent activity.
- **Plants → a plant**: Details (with Design/MDL, Purchase, Liasoning and BOM), Health (issues), PM, Washing.
- **Views**: the same pages for all plants together, plus Movable Assets and Asset & Warranty.
- **Settings**: team access and work categories.

The server decides what each person can see. O&M Head and Administration see every plant, an Assignee sees their
assigned plants, a Site Engineer sees one plant, and a new Viewer waits until the O&M Head gives them a role.
When a figure has no data it shows "Not available", not 0.

## Run it on your computer

Use Python 3.12 and a **test** Supabase project, never production.

Windows (PowerShell):

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
notepad .env
```

Linux / Mac:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
```

Fill in `.env` with the database URL, Supabase URL and keys, and the Clerk keys and issuer. Keep `.env` private and
never commit it. Then:

```bash
python scripts/preflight.py
python scripts/ensure_storage.py
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Open http://127.0.0.1:8000 and sign in with the code Clerk emails you. `/health` shows the server is running and
`/health/ready` shows it can reach the database. On Windows you can also double-click
`launchers\START_SOLAR91_WINDOWS.bat`.

## Tests

Node.js must be installed (some tests run the frontend JavaScript).

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

Optional browser check on a throwaway local database (no real accounts or data):

```bash
python -m playwright install chromium
python scripts/browser_smoke.py
```

## Database changes

SQL migrations are in `database/migrations/`, numbered in order. The app does **not** run them on start-up.
Before applying one, check what the database already has, take a backup, and apply only the missing migrations in
order. `database/SUPABASE_CHANGES_FOR_THIS_RELEASE.md` lists the steps for the latest changes.

## Deploying

Render builds the `Dockerfile` using `render.yaml` and starts it with `scripts/render_start.sh`. Secret values are set
in the Render dashboard, not in files. Step-by-step instructions and troubleshooting:
[docs/RENDER_DEPLOYMENT_RUNBOOK.md](docs/RENDER_DEPLOYMENT_RUNBOOK.md).

If the site hangs after a deploy, open `/health/ready` first. A 503 there means the database settings on Render
need fixing, not the frontend.

## More notes

- [docs/SCHEDULED_OM_WORKFLOW.md](docs/SCHEDULED_OM_WORKFLOW.md): how PM and washing work
- [docs/PM_UNIT_SCHEDULING.md](docs/PM_UNIT_SCHEDULING.md) and [docs/PM_CSV_AND_UNIT_COVERAGE.md](docs/PM_CSV_AND_UNIT_COVERAGE.md): PM planning and CSV import
- [docs/OPERATIONS_CALENDAR_IMPLEMENTATION.md](docs/OPERATIONS_CALENDAR_IMPLEMENTATION.md): the PM and washing calendars
- [docs/ISSUE_EDIT_DELETE_2026.md](docs/ISSUE_EDIT_DELETE_2026.md): editing, deleting and restoring issues
- [docs/OPERATIONS_ASSISTANT_AND_CHAT_RETENTION.md](docs/OPERATIONS_ASSISTANT_AND_CHAT_RETENTION.md): Ask Solar91 and chat history
- [docs/LOAD_TESTING_GUIDE.md](docs/LOAD_TESTING_GUIDE.md) and [docs/SCALABILITY_AUDIT.md](docs/SCALABILITY_AUDIT.md): load testing and scaling
