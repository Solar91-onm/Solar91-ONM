# Solar91 Field Desk release — site-engineer-first daily operations

**Purpose:** retain the existing layered Solar91 portal and add a simple live work surface for a small (1–5 person) team. This is a targeted production-oriented improvement, **not** a verified live production deployment.

## Roles and day-to-day flow

| Role | Primary daily use | Restrictions |
|---|---|---|
| **O&M Head** | View portfolio queues, assign/close issues, review scheduled work and teams, audit site updates. | Existing head permissions and workflows preserved. |
| **Assignee (O&M team)** | Execute equipment-type responsibilities across plants, advance owned issue workflows, scheduled PM and washing. | Existing server-scoped equipment-type authorization. |
| **Site Engineer** | **Primary plant worker:** see their assigned plant's urgent tickets and due PM, inspect site, log observations/actual hours/blockers, raise site issues, submit PM or washing activity using retained modules. | **Exactly one authorized plant**; may **not** assign, resolve or close an O&M issue. Their field update cannot change issue status. |
| **Administration (read-only observer)** | View operational activity in the Command Center, Field Desk and Reports. | No field updates, assignments or closures. Use this approved role when someone should merely observe. |
| **Viewer (unapproved signup)** | Await O&M Head authorization. | No operational access. **Do not grant automatic fleet access to newly signed-up accounts.** |

## Implemented

- `GET /api/field/overview?limit=15` returns an authenticated role-scoped daily worklist, critical/open issues, due/overdue maintenance and assigned plants. Queries and result sizes are bounded. A `limited` indicator warns when counts are based on truncated worklists.
- `POST /api/field/issues/{uuid}/updates` accepts validated inspection notes, field work status, work hours, work date, next step. **Site Engineer write scope is validated against server-side one-plant assignments, not browser-selected plants.** Closed/resolved issues are rejected. Audited notes are persisted in the issue's `legacy_payload.progress` and `IssueHistory` — visible again after refresh. No migration is needed.
- Field Desk appears **above the existing dashboard** with Issue and PM action links. Other navigation modules, dashboards, washing and assignments remain in place. A startup repaint handles async-auth load ordering.
- `Ask Solar91` appears under the desktop sidebar brand/top-left and remains reachable on phones. Site Engineers can now search their **own authorized plant's** loaded records and check issue, PM and washing queues. It is an explainable **read-only search assistant**, not an external AI model, and cannot take actions or invent data.
- Source styling is additive in `36-field-desk.css`; no legacy UI files were deleted. Regression coverage added in `tests/test_field_desk.py`.

## Evidence and safety

Use the included PM/task screens for their existing safety instructions, evidence-upload process, work completion and approvals. Site field notes do not replace technical inspection, electrical isolation or safe work authorization.

The overview is optimized for a small active team. Counts are based on up to the latest 500 matching active issues and 500 matching scheduled tasks and may be partial for larger portfolios; it sets `limited=true` when truncated. For full historical reports, use the original registers. The assistant searches **currently loaded** state, and may not cover older records excluded from initial bootstrap.

## Test evidence in the isolated QA environment

- Existing and new Python tests: **206 passed** (SQLite, test identities).
- Chromium smoke (O&M Head): loaded full frontend (39 JavaScript files), opened the assistant and Field Desk on first load; repeatedly switched Issues, Dashboard, PM, Plants and Reports with no uncaught JS exceptions.
- Chromium smoke (Site Engineer): restricted to one test plant, saw a real issue and PM work order, saved field notes through the HTTP API, read them back in IssueHistory, searched Ask Solar91, and confirmed Reports was blocked.
- Node syntax check for all scripts and Python compile checks included in release validation.

**Not verified**: hosted Supabase PostgreSQL, live Supabase Auth, Storage evidence/photographs, Render deployment, notification delivery to actual phones or production load testing. The supplied configuration lacks a real `DATABASE_URL` and private key setup in the hosting environment. These are external prerequisites, not artifacts hidden in this ZIP.

## Render / Supabase

Set the following **server-side in Render → Environment** (or ignored local `.env`):

```text
APP_ENV=production
DATABASE_URL=postgresql+psycopg://<db-user>:<password>@<session-pooler-host>:5432/postgres?sslmode=require
SUPABASE_SERVICE_ROLE_KEY=<newly-rotated-service-role-secret>
BOOTSTRAP_ADMIN_EMAILS=<approved-head-email>
APP_PUBLIC_URL=https://<your-render-app>
ALLOWED_ORIGINS=https://<your-render-app>
```

The provided public Supabase URL and publishable key are already in `.env.example`/`render.yaml` and can go to the browser. **The uploaded service-role key is a private credential and was intentionally not embedded in source or the distributable ZIP. Rotate it in Supabase because it was previously shared in chat, then save the replacement in Render Environment.** A proper PostgreSQL password and Session Pooler connection URL must also be provided; the publishable key is not a database password.

Before serving real users, verify staging `/health/ready`, migrations, signed-in role assignments, issue creation/progress, site updates, PM, washing and Storage evidence with real credentials. A passing SQLite/browser smoke suite is **not** certification of hosted production availability.

## Industry reference

Work orders, plant monitoring, on-site inspections, safety practices and performance/documentation processes were prioritized with reference to SolarPower Europe's *Operation & Maintenance: Best Practice Guidelines Version 6.0* (18 February 2025, https://www.solarpowereurope.org/insights/thematic-reports/operation-and-maintenance-best-practice-guidelines-version-6-0-1), and the SolarPower Europe/NSEFI *O&M Best Practice Guidelines: India* (14 December 2020, https://www.solarpowereurope.org/insights/thematic-reports/operations-and-maintenance-o-and-m-best-practice-guidelines-india). This app has not been independently audited against those standards.
