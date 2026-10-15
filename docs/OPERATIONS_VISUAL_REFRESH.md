# Solar91 O&M — operations experience refresh (10 October 2026)

## Scope

The existing **FastAPI + Supabase** application is the baseline. This release updates presentation and navigation without copying HTML mockup data into the live app. The sidebar, brand identity, top bar, reports, and existing backend models, routes, and storage remain intact.

## New UI assets

- `frontend/static/css/32-solar91-operations-experience.css`: operational dashboard, section-wide design system, responsive issue/washing/PM drawers, spacing and focus styles.
- `frontend/static/js/32-operations-experience.js`: Command Centre links to real app modules and a contextual summary in the existing ticket, washing plant, and PM task overlays. The summary reads the current `S` state and does **not** create a parallel datastore.
- Included by `frontend/templates/index.html` after the earlier section-only and reference-workflow enhancements.

## Behavior retained

- Site Issues: issue registration, assignment, acknowledgment, progress logging, evidence, resolution, secondary verification, closure, reopen and server-side role checks.
- Washing: plant progress, cycle and calendar view, report/photograph review and server-side confirmation/rejection.
- PM: All Plants / single-plant selection, equipment unit quantities, coverage, task planning, follow-ups, CSV/Excel templates and import, checklist, proof of work and completion.
- Other modules: Plants, Command Centre, work assignments, performance, reports, imports, project handover, services and settings.

## Checklist for live acceptance

1. Sign in through **Clerk email code** under O&M Head; confirm plant scoping and access control.
2. Load Command Centre and open Site Issues, PM, Washing, Plants and Reports using both sidebar and shortcut cards.
3. In Site Issues, create a ticket, assign, acknowledge, add notes/photos, resolve, verify and reopen. Confirm database values persist on reload.
4. In Washing, open a plant, review daily calendar and report evidence; test confirm and reject (reason required).
5. In PM, switch between All Plants and one plant; compare registered equipment quantities to the equipment coverage table. Create a job, import a CSV, complete with before/after evidence and verify status on reload.
6. Recheck existing reports, search, exports, plant detail views, settings and responsive layouts.
7. Test a Site Engineer account against a plant it does not have permission to access.

### Test limitations

Local test suite and browser mocks do not verify production secrets, live network, row-level security, Supabase Storage bucket configuration or Auth redirect settings. Run the acceptance checklist using the real deployment before production approval.

## Release packaging

This ZIP intentionally omits `.git`, caches, `.env` and user-specific credential files. Existing `.github` CI configuration and the deployment scripts are retained. Apply the existing database migrations on the target Supabase project following `README.md` and release instructions; no new database migration was required for this frontend refresh.
