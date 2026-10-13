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
- In staging with live Supabase Auth, verify O&M Head operation plus 403s for other roles; check audit trail, two-browser stale state behavior, and attachment access after restoration.
