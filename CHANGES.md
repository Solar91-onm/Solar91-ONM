# What changed in this release

Three things: the frontend was replaced, the database was wired into it, and the
equipment register was removed. Sign-in and the Render deployment are untouched.

---

## 1. The portal design is now the application

The redesigned portal is served at `/` behind the existing Clerk sign-in. The
previous layered frontend bundle is gone.

| | Before | After |
|---|---|---|
| Frontend | 52 JS + 35 CSS files, ~25,000 lines | 12 JS + 7 CSS files, ~9,000 lines |
| Served at | `/` (old app), `/portal` (read-only prototype) | `/` only; `/portal` → 308 redirect |
| Data | prototype ran on `mock-data.js` | every figure read from Supabase |

**The sign-in panel is unchanged.** It was extracted byte-for-byte out of
`00-auth-data-and-imports.js` into `frontend/static/js/auth-gate.js`: the Clerk
e-mail-code flow, token refresh, the single 401 retry before sign-out, and
`apiFetch`. `login.css` is untouched. Only what boots *after* a valid session
changed. `tests/test_code_signin.py` and `tests/test_sign_in_gate.py` pin it.

**`render.yaml` and every Render setting are untouched** — same build command,
start command and environment variables.

## 2. The database is wired in

New read-only module `app/portal/` serving `/api/portal/*`: overview, plants,
one plant, activity, calendar. `mock-data.js` is deleted.

Costs are bounded — the Overview is **five grouped queries plus the washing
overview regardless of plant count**, not one request per plant.

Business rules are imported from the modules that own them, each named at its
definition in `app/portal/service.py`: issue state sets and severity storage
from `app/issues`, the PM status set and overdue rule from
`app/scheduled/router.py`, washing compliance from `washing_cycles` itself.

**A plant with no records reads "Not available", never `0`.**

## 3. Plants → Details is one table

Details is the plant table in both places: one plant's own row under
Plants → <plant> → Details, every plant's row under Views → Details. The
columns are the stored record — plant code and name, SPV/project, AC and DC
capacity, district, DISCOM, the real Site Engineers (from
`user_plant_assignments`, not the free-text field), washing assignee, COD,
location and last activity — with CSV and Excel export and the Edit button.
Portfolio-wide Details retains CSV and Excel export. A single plant's Details
page shows only its heading and one table row (with Edit where permitted), with
no search, filter, sort or export controls. Issues, PM and washing have their
own sub-pages, so the details page no longer repeats them.

Editing writes through the existing `PATCH /api/plants/{id}` and is only offered
to roles holding `plants.manage`. It sends **only changed fields**, so a stale
form cannot overwrite someone else's edit.

## 4. The equipment register is removed

Dropped: `equipment`, `equipment_documents`, `user_equipment_assignments`,
`user_equipment_type_assignments`; the columns `issues.equipment_id`,
`issues.equipment_ref`, `issues.maker`, `om_tasks.equipment_ref`; and
`supplier` / `serial_number` inside `issues.legacy_payload`. All `/api/equipment`
routes return 404. Asset & Warranty is gone from the UI and navigation.

**Assignee scope had to change.** It was defined by equipment *types*, and
holding any type exposed every plant. It is now explicit plant rows in
`user_plant_assignments` — one or more plants, unlike a Site Engineer's exactly
one. Migration 032 gives every existing Assignee the plants they could already
see, so nothing breaks; narrow them down in Settings → Team access.

Nothing else about sign-in, roles or permissions changed.

## 5. Categories replaced the register and the hard-coded list

The 32-category list that lived in `app/core/security.py` is gone with the
register — it was the same incomplete list. Categories now live in the
`work_categories` table: the category, **its sub-problems**, **how many a plant
has**, and **your own ID** for it.

It ships **empty**, and is filled either way:

- **Settings → Categories** in the portal — any O&M Head or Assignee.
- **Supabase** — the ready-made `INSERT` in migration 033.

The issue form reads it live: choosing a category offers exactly that category's
sub-problems, and the quick-template buttons are generated from the pairs.

Until one category exists, the dropdowns are empty and a new PM plan or issue
cannot pick one. **Plants and Washing work regardless.**

## 6. Two bugs found and fixed on the way

- **CSV formula injection.** The portal's plant export had lost the guard the old
  frontend had. A plant name starting with `=` would have reached Excel as a live
  formula. `fmt.csvText` now neutralises every cell in both the CSV and Excel
  export, matching the old behaviour exactly.
- **Notification routing.** Replacing the per-asset "in charge" routing with
  plant routing briefly notified the Site Engineer who raised a ticket.
  `plant_responsible_users` is now scoped to Assignees, preserving the original
  audience.

---

## Tests

**531 passed, 0 failed.**

Added: `tests/test_portal_frontend.py` (24 tests on the new shell),
`tests/test_work_categories.py` (9 on the category list),
`tests/test_sign_in_gate.py` and `tests/test_pwa_install.py`.

Removed with the bundle they asserted on: `test_frontend_regression.py`,
`test_equipment_register.py`, `test_simple_issue_pm_ui.py`,
`test_session_nav_assets.py`, `test_operations_calendar_browser.py`,
`test_plant_pulse_simplified_navigation.py`, `test_photo_intelligence.py`, and
individual frontend-asserting tests inside otherwise-good backend files (each
one listed in a comment at the foot of its file).

## What is not in the new design yet

The APIs are intact and tested; only the screens are missing. These still live in
the main O&M app: PM planning and schedule editing, washing setup/reports/review,
issue workflow transitions after creation, photo capture and the evidence
gallery, and team invites.

## Supabase

Two migrations, in order. See `database/SUPABASE_CHANGES_FOR_THIS_RELEASE.md`.

| Order | File |
|---|---|
| 1 | `database/migrations/032_remove_equipment_register.sql` |
| 2 | `database/migrations/033_work_categories.sql` |

Migration 032 backs everything up into an `archive_032` schema before dropping
anything, and migrates Assignee scope **before** the drop, so access is never
interrupted. Drop the archive once production looks healthy.
