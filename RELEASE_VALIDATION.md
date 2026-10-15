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
