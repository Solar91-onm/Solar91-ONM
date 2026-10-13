# Historical Solar91 O&M Command Center — Production Completion Audit

> Historical audit snapshot. References to the earlier identity implementation do not describe the current runtime. Supabase Auth is now the only active identity provider. See the current Render runbook for deployment guidance.

## Phase 1 — Audit

### Prototype
The supplied standalone HTML remains the visual/workflow reference. Its Solar91 visual language is preserved: dark sidebar, green primary actions, white rounded cards, KPI tiles, rings, charts, drawers, issue/task flows, responsive field layout.

The prototype contains multiple historical role implementations and a test role switcher. Production authority is not derived from those controls; the final identity layer now uses the authenticated backend bootstrap.

The Raise Issue UI was checked against the current specification: Equipment Location, Equipment, and Sub-category are no longer required create-form inputs; broader equipment filtering remains available.

### Existing production project
The rev15 ZIP already contained FastAPI, third-party token verification, Supabase/PostgreSQL models/migrations, private Storage evidence handling, role permissions, plant assignments, notifications, audit logging, imports, SCADA, tests, and a legacy state compatibility bridge.

Baseline test suite: 22 passed before modification. Final suite after hardening: 28 passed.

Primary gaps found:
- Site Engineer scope could be inferred from `plants.assigned_engineer` text, which is not a safe authorization boundary.
- Core issue mutations still depended on compatibility `/api/state/sync` from the browser.
- Scheduled O&M assignee identity was text-only.
- Notifications were stored and read, but core issue/task mutations did not consistently create user-specific events.
- Bootstrap did not expose a complete authenticated user/scope/permissions/modules contract to the frontend.
- User role/plant mutations did not create audit records.

## Implemented hardening

### Backend
- Strict Site Engineer assignment scope uses `user_plant_assignments` only.
- Zero Site Engineer assignments become a pending-access bootstrap state; multiple assignments still fail closed.
- Bootstrap returns authenticated user, scope, permissions, modules, and pending-access state.
- Issue creation can generate a unique server-side ticket number.
- Issue creation validates referenced equipment belongs to the selected plant.
- Issue progress/resolution/closure generate targeted notification events.
- Scheduled O&M has an authoritative `assignee_user_id`.
- Scheduled task assignment/reassignment can resolve active Solar91 users and emits notifications.
- Private Before/After evidence remains behind FastAPI and Supabase private Storage.
- Washing log/exception mutations have scoped API endpoints and audit records.
- User role and plant-assignment changes are audited and Site Engineer role requires exactly one plant.
- Migration 008 adds task assignee identity and safely backfills only unambiguous legacy Site Engineer assignments.

### Frontend
- Production identity is sourced from authenticated `/api/bootstrap`.
- Site Engineer plant context is server-provided and locked; no client plant selection is authoritative.
- Production role switcher is neutralized as a test-only legacy artifact.
- Site Engineer gets a dedicated My Plant command view using the existing Solar91 cards/KPIs/charts.
- Site Engineer zero-assignment state is rendered as an explicit access-pending screen.
- Issue creation and core issue actions are connected to the FastAPI domain APIs.
- Site Engineer/Assignee persistence no longer uses the whole-state compatibility sync as the operational source of truth; existing state sync remains for O&M Head legacy administration compatibility.
- Washing log/exception actions are connected to backend endpoints.

## Verification
Historical verification record: `python -m compileall -q app tests`, `pytest -q` → 28 passed. This is not the current test result. Inline JavaScript also passed `node --check` after removing Jinja-only template tokens for syntax validation.

## Phase 8 — Second-pass security hardening

Additional controls completed after the initial 28-test pass:

- PTW/LOTO-required Scheduled O&M tasks now raise a server-side PTW request on first start attempt and remain blocked until an O&M Head approves the permit.
- Completing a task closes its approved PTW record.
- PTW approval/rejection/close endpoints are protected by the same role/scope authorization model.
- Assignee Extra Services reads are limited to assigned plant scope; unscoped vendor administration remains O&M Head-only.
- The persisted role-permission catalogue is aligned with the `services.view/services.manage` vocabulary and `permits(task_id,status,created_at)` is indexed.
- Site Engineer multi-plant configuration is explicitly tested as fail-closed.

Final regression suite after Phase 8: **32 passed**.
