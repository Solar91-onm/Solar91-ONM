# Preventive Maintenance — production rev15 workflow

The `/api/scheduled` endpoint and persisted audit module retain their existing identifiers for compatibility; the portal displays this workflow as **Preventive Maintenance**.

## Operational separation

- **Site Issues**: sudden/unplanned plant faults, breakdowns and urgent requests.
- **Preventive Maintenance**: preventive/recurring maintenance that is intentionally planned.
- **Washing**: an internal Preventive Maintenance section, not a separate top-level field workflow.

PM tasks, Site Issues and washing records are persisted through their domain APIs. The compatibility
`/api/state/sync` endpoint excludes those collections; changes to unrelated legacy state use
per-collection revisions so unrelated edits do not conflict with one another.

## Who can create planned work

Problem-based Preventive Maintenance creation is allowed to:

- O&M Head
- Assignee / O&M Team for explicitly assigned registered equipment; assignments may span plants

Administration is limited to the read-only Command Center and Reports. A **Site Engineer cannot create planned work** and executes the existing schedule for exactly one assigned plant. O&M Head manages team roles, including Assignees and Site Engineers.

## Problem-based task creation

The creator chooses:

1. plant
2. maintenance asset/category
3. known problem
4. suggested/planned task
5. equipment reference
6. assignee
7. recurrence frequency
8. first due date
9. safety requirement / SOP

The backend persists the link back to the **Site Issues problem library** using `problem` and `problem_source`.

Supported maintenance categories include Inverter, Module, Transformer, Aux. Transformer, VCB Panel, VCB-Kiosk, ACCB Panel, plant/GSS switchyard, transmission line, RMS, WMS, CCTV, boundary wall, String, Earthing, LA, water pipeline, Vegetation, Modules cleaning, ABT meters, Street Light, MMS and Other.

## Execution

1. Authorized field user starts the work order.
2. **Before** photo is uploaded through FastAPI.
3. Checklist/readings/remarks are completed.
4. **After** photo is uploaded through FastAPI.
5. Both evidence slots must exist before completion.
6. FastAPI stores actual completion date and delay.
7. If an anomaly/problem is found, FastAPI creates a linked **Site Issue**.
8. If recurring, FastAPI creates the next occurrence with a fresh/empty evidence set.

Task schedule edits, execution checklist changes, resets and task-to-issue links also use dedicated
Preventive Maintenance endpoints rather than the compatibility state sync.

## Evidence

Exactly two photo slots are supported:

- `before`
- `after`

Files are uploaded to a **private Supabase Storage bucket** by FastAPI. Browser JavaScript never receives the Supabase service key. PostgreSQL stores evidence metadata/object references, and the authenticated backend proxies evidence viewing.

Completed task evidence is immutable through the normal workflow.

## Plant scope

- O&M Head: portfolio
- Administration: read-only Command Center and Reports
- Assignee: explicitly assigned registered equipment and matching work, including across plants
- Site Engineer: exactly one plant, fail closed if account configuration resolves to zero or multiple plants

## PM follow-up and alert ladder

An unfinished PM job uses its planned due date for escalation, including legacy unit jobs grouped by plant, equipment type and cycle. The alert ladder sends an Assignee reminder 3 days before the due date and on the due date; at 1 day late it notifies the Assignee and O&M Head, at 3 days late it also notifies the plant's Site Engineer, and at 7 days late it marks the job critical and notifies the Assignee and O&M Head. A future promised date pauses only the no-follow-up reminder. A missed promise notifies the Assignee and O&M Head once; a late job without contact is reminded every 2 days. Completed and cancelled jobs receive no further alerts. The optional Monday summary is off by default.

The notification worker remains hourly and idempotent. It records each alert in `pm_alert_log`, keyed by job/group, due date and alert level. Per-user, optional per-plant settings are stored in `notification_preferences` with module `pm`; event switches control in-app and email delivery. Team recipient rules can be changed by the O&M Head.

Routes:

- `GET /api/scheduled/tasks/{work_order_no}/alerts` returns the alert history and levels reached for the current due date.
- `GET /api/pm-plan/alert-preferences?plant_id={id}` reads effective settings with defaults.
- CSRF-protected `PUT /api/pm-plan/alert-preferences` saves event delivery choices and, for the O&M Head, the team recipient rule.
- The existing CSRF-protected `POST /api/pm-plan/run-daily` remains available for authorized manual runs.

Apply `database/migrations/023_pm_alerts_and_preferences.sql` after migration 022, or run the updated `database/SUPABASE_RUN_THIS.sql`.

## Washing

Washing retains:

- inverter → table/string mapping
- optional secondary inverter mapping
- unique table identifiers
- plant frequency / crew
- individual/bulk logging
- history
- rain, water shortage, breakdown, access restriction, safety stand-down and Other exceptions
- rescheduling and next-due date
- days-since-last-wash / compliance reporting

### Washing setup spreadsheet

O&M users can download a validated Excel template, export the current setup, and import `.xlsx` or UTF-8 `.csv` files from the Washing portfolio. Match plants using the existing **Site code**; the plant name is informational. Imports support up to 500 rows and 2 MB, validate all rows before applying changes, and offer a dry-run preview. Blank values preserve existing settings. A new setup needs a table count; Assignee and other settings may be added later. Table-count reductions are blocked when recorded reports or washing history would be affected.

The API routes are `GET /api/scheduled/washing/template`, `GET /api/scheduled/washing/export`, and CSRF-protected `POST /api/scheduled/washing/import`. Apply `database/migrations/020_washing_import_setup.sql` before deploying this feature; the migration adds setup active/notes fields and an index supporting batched report lookups. Regenerate the bundled blank template with `scripts/build_washing_template.py`.

## Persistence

Core tables:

- `om_tasks`
- `issues`
- `washing_config`
- `washing_tables`
- `washing_history`
- `pm_followups`
- `pm_due_changes`
- `pm_alert_log`
- `notification_preferences`
- `audit_logs`

Latest production fields are introduced by `007_rev14_production.sql`.
