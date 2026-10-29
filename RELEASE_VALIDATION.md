# Solar91 O&M — integrated release validation

## Scope and merge approach

**Base:** the user's original `solar91-om(1).zip` (not the offline demo). No React rewrite, no data replacement.

- Site Issues: original API-backed creation/assignment/acknowledgement/progress/resolution/verification/closure/reopen workflow retained, with reference-style overlay tabs, activity/evidence sections and updated section styling.
- Washing: original live plant register, summary cards, overdue matrix, cycles, daily reports, confirmation/rejection, evidence and exports retained. Added a data-driven day-by-day calendar to the plant detail overlay.
- Preventive Maintenance: existing PM dashboard, unit/planning controls, task execution, follow-ups, evidence and alerts retained, with reference-style task overlay and section-only styling.
- Dashboard, Reports, Plants, User Management, top header, sidebar, Clerk email-code login and other modules are retained, not overwritten by sample HTML.
- API actions continue to use `apiFetch` with an `Authorization: Bearer <Supabase access token>` header, through FastAPI to Supabase PostgreSQL and private Storage. No mock-only API paths were added.

## Backend corrections

1. Report review authorization: only an active O&M Head or **that plant's assigned washing Assignee** can approve/reject; ordinary other washing Assignees cannot approve a different plant's daily report.
2. Overdue alerts deduplication: notification recipients use keys `washing-overdue:...:<level>:<user_id>`. The check now detects those real keys, instead of checking a nonexistent unsuffixed key and counting repeated sends.
3. Existing tests for these behaviors and the rest of the project pass.

## What was tested in the build environment

- Python API/unit/integration tests against SQLite test fixtures, with fake authenticated user injection.
- JavaScript syntax validation of all frontend scripts with Node.js.
- Python bytecode compile.
- HTML rendering, static asset routes and `/health` using FastAPI's test client.
- Conflict marker check over application source files.

## External/live validation needed before production

**No live Supabase credentials were available for this validation.** The test suite uses a local SQLite database and test identity overrides. Therefore live Supabase sign-in, private Storage uploads, actual Postgres migrations, and remote GitHub Actions cannot be certified from these tests.

1. Use `.env.example` as a guide; configure secure **server-side** variables. Only the Supabase anon key is public; never put the service-role key or JWT signing secret in frontend JavaScript.
2. Run `python scripts/preflight.py` with the test project's credentials and `python scripts/ensure_storage.py`. Review/backup the database, then apply only approved SQL manually. Consult `docs/RENDER_DEPLOYMENT_RUNBOOK.md`.
3. In a staging Supabase project, sign in with each role (O&M Head, the plant's assigned Assignee, other Assignee, Site Engineer); verify all role/plant access rules.
4. Create and progress a ticket through Closed, then reopen; verify refresh consistency, comments, and attachments.
5. Submit washing counts with before/after evidence, confirm/reject as authorized, check cycle rollover and overdue notification deduplication.
6. Create and finish a PM unit task, upload evidence, verify reloaded task state and reports. Review the scheduled-job runtime with a single active worker.
7. Check the existing GitHub backup jobs' secrets and run Actions on GitHub; CI tests are supplied, but no push or remote deployment was performed.

## Repository / Git notes

The uploaded archive included an internal `.git` folder with a stale `REBASE_HEAD` and editor swap files, but Git reported **no unmerged index entries**. This release is a clean **source ZIP** without `.git` internals; it does not silently complete or rewrite the user's remote Git history. The included `.github/workflows/ci.yml` validates pushes and PRs after you import the source to your GitHub repository.

## 2026-10-10 — Command Centre / grouped PM / safe Issue management additions

- Based on `Solar91-OM-2026-PM-Plant-Unit-Consolidated-FINAL.zip`; included the prior dashboard navigation, report preview/export, read-only Ask Solar91 panel, Washing updates, and compact PM equipment-unit grouping and plant selection.
- Added O&M Head ticket correction with reason + before/after audit, reversible soft deletion, and restoration via Archived tickets register. Migration 025 required.
- See `docs/ISSUE_EDIT_DELETE_2026.md` for workflow and database setup. Browser tests were simulated and live credentials were not provided.

## Browser checks (local, no credentials) — October 2026

Run after frontend changes; each starts its own isolated server or mock page:

- `python scripts/browser_smoke.py` — real app on a temporary SQLite server: plants, ticket workflow, deadlines, the edit / close dialogs as O&M Head and as the ticket's Assignee, readable API errors, and closing a dialog and opening another screen in one click.
- `python scripts/verify_laptop_layout.py` — every main screen at 1280×720, 1366×768, 1440×900, 1536×864, 1728×1117 and 1920×1080 (14", 15.6" and 16" laptops at their usual scaling). Fails on sideways scroll, content sticking out of the page or top bar, or a JavaScript error; keeps screenshots for a visual review.
- `python scripts/verify_pm_command_view.py`, `python scripts/verify_pm_consolidation.py`, `python scripts/verify_command_experience.py` — Preventive Maintenance views and Command Centre with mock data.

Laptop fixes from the October 2026 check (`frontend/static/css/48-laptop-fit.css` unless noted): sidebar labels shorten instead of pushing count badges off the edge; page heroes keep their score beside the text; Preventive Maintenance shows its large hero on Overview only, so the other tabs start with their work on a 720–768 px tall screen; the Command Centre overview cards keep readable labels at ~315 px wide; several newly overdue tickets raise one summary pop-up instead of four cards, and at most two stack under 800 px height (`08-actions-exports-and-submission.js`); closing a dialog and navigating in the same click no longer bounces back (`44-session-nav.js`); a ticket's conversation no longer stays on "Loading conversation…" when its work steps arrive first (`08-actions-exports-and-submission.js`).

## 2026-10-29 — Minimal navigation, centered Site Issues and PM views

The product now uses the Plants dashboard as its primary O&M starting point instead of the old standalone Command Center. Site Issues uses a flat, ten-column, centered register with small status/overdue indicators instead of red overdue rows; PM keeps its current task workflow but gains centered, quieter and mobile-scrollable tables. For field mappings, tests, browser checks and the existing-schema limitation on independent subpart IDs, see [`docs/UI_SIMPLIFICATION_2026_10_29.md`](docs/UI_SIMPLIFICATION_2026_10_29.md).

## 2026-10-29 — Persistent field photos, mobile-first portal

Photo Intelligence now has authenticated private storage, SQL metadata and record links (issue/PM/washing/inventory, optional), searchable thumbnail gallery, deterministic suggested tags, and direct re-use of saved images from the Issue and PM evidence forms. Navigation hides the four removed modules, desktop Plants table columns fit the frame, and phone widths get responsive plants and photo screens. Ask Solar91 retains existing grounded/read-only behavior and gained a plant-preserving Photos shortcut. Deployment requires `database/migrations/030_site_photos.sql` and the updated Pillow dependency. See [`docs/PHOTO_INTELLIGENCE_MOBILE_RELEASE_2026_10_29.md`](docs/PHOTO_INTELLIGENCE_MOBILE_RELEASE_2026_10_29.md) for tests, setup, security and nonproduction limitations.

## 2026-10-29 — Upload size, query and payload overhead

- **WebP uploads**: `compressEvidenceImage` (`08-actions-exports-and-submission.js`) now re-encodes Issue, PM, washing and Photo Intelligence photos as WebP (JPEG where the browser cannot write WebP) and keeps the original only when it is already smaller. Re-encoding drops camera EXIF (time/GPS); the server records upload time and uploader. Photo Intelligence thumbnails are generated as WebP (`app/photos/router.py`).
- **Connection pool**: evidence/document downloads and photo uploads return their pooled connection (`release_connection`, `app/core/database.py`) before Storage I/O, so slow Storage calls cannot exhaust the 5+2 pool.
- **Query overhead**: `/api/state/collections` and `/api/tasks|handovers|washing` build only the requested collections (`load_state(only=…)`); further Photo Intelligence pages request rows only (`meta=false`) and append instead of refetching every loaded page. Synthetic 5x SQLite benchmark (`scripts/benchmark_api_latency.py --scale 5`): issues collection refresh 28 → 12 queries, ~510 → ~255 ms app time; not measured against Supabase.
- **Compression**: `TextGZipMiddleware` (`app/core/compression.py`) gzips text at level 6 and skips images, PDFs and spreadsheets that are already compressed.
- **Frontend**: the 8-second plant-link repair uses lookup maps instead of scanning every plant per ticket/PM task; the washing day summary and PM task-record drawer show 50/40 rows with "Show more".
- **Follow-up (same day)**: server-side WebP pipeline with EXIF/GPS removal and one-photo-at-a-time uploads, duplicate-upload guard (**requires migration `031_site_photo_submissions.sql` before deploying**), keyset gallery paging, module-scoped live refresh. Measurements, deployment checklist, rollback and unverified items: [`docs/PERFORMANCE_OPTIMIZATION_REPORT.md`](docs/PERFORMANCE_OPTIMIZATION_REPORT.md).
