# Solar91 O&M — Site Issue correction, reversible deletion, and restoration

## User workflow

Only a signed-in **O&M Head** sees **Edit**, **Move to Deleted**, and **Deleted tickets**.

- Open Site Issues → ticket → **Edit details** to correct severity, description, category, maker, equipment or occurrence date. Add a correction reason and **Save changes**. Fields are patched through the authenticated `/api/issues/{id}` endpoint. Changes are recorded with old/new values in the audit history.
- Open the same ticket → **Move to Deleted**. Enter a reason (at least 8 characters) and the **exact ticket number**. The server archives the ticket without destroying private evidence, work-step records, history or ticket number. It disappears from active registers, search, dashboard counts and reports.
- Open **Site Issues → Deleted tickets**, find the ticket and choose **Restore**. Enter a reason and confirm. Its original status, work history, attached photos and ticket number return to the active system. There is no automatic irreversible purge.

Administration, Site Engineers, Assignees and Viewers **cannot** list, delete, restore or edit tickets using these management endpoints. Role enforcement is server-side, not just a hidden button. Mutations require a verified Supabase bearer token.

## Database requirements

**Before deploying the new application**, review and back up the database, then apply the approved `database/migrations/025_issue_safe_deletion.sql` using a controlled Supabase migration process. Do not use `python scripts/migrate.py` as a bulk production runner; it does not track applied migrations and includes historical data-changing SQL.

The migration adds nullable `issues.deleted_at`, `issues.deleted_by`, and `issues.deletion_reason` columns and two indexes. No ticket data is removed or renumbered. Existing issue_history and audit_logs remain unchanged.

Take a Supabase backup before applying migrations. Use staging before production. The original O&M workflows, PM group-by-equipment quantities, Washing, Command Centre drill-downs, reports, and read-only Ask Solar91 search are preserved in this release.

## API changes

- `PATCH /api/issues/{uuid}` — existing endpoint improved to record before/after changes, accepts optional `change_reason`.
- `DELETE /api/issues/{uuid}` — O&M Head only; JSON body `{ "reason": "Duplicate entered by mistake", "confirm_ticket": "ISS-0009" }`. Soft deletion only.
- `GET /api/issues/deleted?limit=100` — O&M Head only, newest deleted first.
- `POST /api/issues/{uuid}/restore` — O&M Head only; JSON body `{ "reason": "Restored after verification" }`.

`GET /api/issues`, bootstrap/state collections and site issue counts exclude deleted records. Browser state-sync cannot recreate a ticket if an archived record with the same ticket number exists. Archived tickets cannot be edited or progressed until restored.

## Verification

- `pytest -q` — includes `tests/test_issue_admin_archive.py`.
- `for f in frontend/static/js/*.js; do node --check "$f"; done`.
- Browser UI test was performed against simulated `apiFetch` responses, validating the edit button, confirmation dialog, archive listing and restore controls at desktop and mobile widths. This is not a live Supabase acceptance test.
- In staging with Clerk email-code sign-in, verify O&M Head operation plus 403s for other roles; check audit trail, two-browser stale state behavior, and attachment access after restoration.

## Edit, dates and close by the ticket's Assignee; configurable deadlines (October 2026)

- **Who can edit / close.** The O&M Head on any ticket, and an **Assignee on a ticket assigned to them**. Site Engineers, Administration and other Assignees get 403. An Assignee cannot edit a Closed ticket (409) and cannot move a ticket to equipment outside their own equipment types (403). Deleting and restoring stay O&M Head only.
- **One edit dialog** (*⋯ → Edit details* on the ticket desk, or *Edit* in the register): priority, issue type, sub-category, equipment, description, maker, start date and deadline, with a required reason. It sends one `PATCH /api/issues/{id}`; a deadline change made there is also written to `issue_etc_changes`, and a deadline before the start (or, without a start, before the ticket was raised) is refused. Changing the priority moves an untouched deadline to that priority's default so the effect is visible before saving.
- **Close.** `POST /api/issues/{id}/close` accepts the O&M Head or the ticket's Assignee. A Resolved ticket is verified and closed; any other open ticket is closed directly and needs a reason. Both are logged with the person's name; reopening remains O&M Head only.
- **Default deadlines.** *Site Issues → ⏱ Deadlines* (O&M Head): hours or days for new Critical and Medium tickets (standard 48 h / 96 h, 1 h – 90 days). Stored in `app_settings` (`issue_deadline_hours`, no migration), audited in `audit_logs`, served by `GET /api/issues/deadlines` and changed by `PUT /api/issues/deadlines` (`{"critical_hours":24,"medium_hours":72}`). They apply to tickets raised afterwards: the raise form, the Excel upload and any ticket created without a deadline. Ticking *Also move open tickets that still have the old default* (preview via `dry_run`, then `apply_to_open`) moves open tickets whose deadline is still the old default — counted from when each was raised — and logs each move in the ticket's deadline history. A ticket whose deadline was ever changed by hand, or that was given its own target date, keeps it; Resolved and Closed tickets are never touched.
- **Time zone fix.** The raise form and *Change dates* sent plant-local times without a zone, so the server stored e.g. a 10:00 deadline as 10:00 UTC (15:30 IST). They now send exact UTC instants (`s91LocalToUtc`). Tickets saved before the fix keep their stored value; open ones still on the default are corrected the next time the O&M Head moves open tickets to a new default.
- Tests: `tests/test_issue_deadlines_and_assignee_edit.py`, `tests/test_issue_workflow_rules.py`; browser: `python scripts/browser_smoke.py` (O&M Head path against a local SQLite server).
