# Historical Solar91 O&M Production Migration Report (rev15)

> Historical snapshot only. Its original third-party-authentication statements describe an earlier implementation and have been superseded. The active application now uses Supabase Auth only; see `README.md` and `docs/RENDER_DEPLOYMENT_RUNBOOK.md`.

## 1. Goal

Convert the latest standalone Solar91 UI (through rev14) into a real FastAPI application without treating browser storage as the database, while preserving the established design and operational workflow.

## 2. Identity architecture at the time of this report (superseded)

The earlier version used a third-party identity provider and verified its session JWTs in FastAPI. Solar91 roles and plant assignments lived in PostgreSQL, independent from that identity. The current runtime instead uses Supabase Auth only.
- Mutating APIs require an explicit Bearer token.
- The standalone test-role selector is not a production authority mechanism and is removed at runtime.

## 3. Current role model

- O&M Head
- Assignee / O&M Team
- Administration
- Site Engineer
- Viewer (pending access)

Site Engineer has exactly one plant and only Command Center, Site Issues and Scheduled O&M. Zero/multiple assigned plants fail closed.

Legacy test roles are safely mapped/retired in migration `007_rev14_production.sql`.

## 4. Frontend changes carried from rev14

- visible **O&M Issues** label changed to **Site Issues**
- Scheduled O&M remains directly available as planned maintenance
- Scheduled O&M filter panel requested for removal remains removed
- problem-based Add Task flow retained
- Site Engineer cannot create new planned tasks
- evidence simplified to exactly **Before + After**
- Site Engineer remains own-plant only
- no production browser `localStorage` business persistence

## 5. Scheduled O&M production APIs

New dedicated module: `app/scheduled/`

- list tasks with role/plant scope
- create task by Site Issues-style asset/problem
- start task
- upload Before/After evidence
- authenticated evidence download
- remove evidence before completion
- complete task
- generate recurrence server-side
- create linked Site Issue when an anomaly is reported
- O&M Head reassignment

## 6. Supabase responsibilities

### PostgreSQL

Operational source of truth for users, plants, issues, scheduled tasks, washing, handover, audit, notifications and supporting records.

### Private Storage

Scheduled O&M Before/After images. FastAPI alone holds the Storage service credential.

`python scripts/ensure_storage.py` verifies or creates the configured private evidence bucket.

## 7. Compatibility bridge

The original frontend is a large monolithic state machine. A compatibility `/api/bootstrap` + `/api/state/sync` bridge is retained for older handlers, but:

- the backend scopes data before returning it
- field changes are checked server-side
- PostgreSQL is authoritative
- dedicated REST APIs are used for security-sensitive latest workflows such as Scheduled O&M evidence/problem creation

## 8. Deployment boundary

The project contained placeholders at the time of this report. Live provider credentials had to be supplied by the operator in `.env`; the build environment did not exercise a production identity tenant or Supabase project.

## 9. Verification

rev15 verification includes:

- Python compile
- automated API/permission tests
- Site Engineer single-plant fail-closed test
- problem-task creator role tests
- private evidence adapter tests with Storage mocked
- Before/After completion requirement
- recurring task generation
- linked Site Issue generation
- Bearer-token write requirement
- frontend source/render checks
- JavaScript syntax validation
- scan for production `localStorage`
- scan for Supabase service key leakage

## 10. Phase 8 hardening

`009_role_permission_alignment.sql` aligns persisted permission metadata for Extra Services and adds a Scheduled O&M permit lookup index. The FastAPI task lifecycle now enforces PTW approval for any task whose safety requirement contains PTW or LOTO, with server-side permit creation, approval/rejection, and closure.

The Extra Services read APIs are now permission-gated; Assignee requests are plant-scoped, while vendor administration remains O&M Head-only because the legacy vendor model has no reliable plant assignment field.

Final automated verification: **32 tests passed**.
