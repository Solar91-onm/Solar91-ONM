# Solar91 O&M Command Center — Source Audit

## Audit basis

The migration uses the uploaded standalone HTML as the visual and workflow source of truth. The audited source is **8,829 lines** and contains **475 named JavaScript function declarations (441 unique names)**. Source SHA-256: `698e879d111e766bec975a21e07922d5898b9d6b5d9aa865854a7c6d9fbf8f93`.

The migration deliberately preserves the existing HTML/CSS/JavaScript presentation layer rather than replacing it with a generic frontend framework. The complete `<style>` block is byte-for-byte unchanged in the migrated template (SHA-256 `1e8e0188250a9730fac09feb8867656cdcbca3246da9200e0eef209f18f8b2ae`).

## Views and navigation found

### Command Center
- Command Center / portfolio dashboard
- Plants
- O&M Issues
- Work / Assignments
- Performance
- Reports
- Data / Imports
- Settings

### Operations
- Project Handover
- Scheduled O&M
- Washing
- Extra Services
- Analytics is present as an internal O&M tab/view

### Shared shell
- Fixed desktop sidebar
- Sticky top bar and breadcrumbs
- Quick search
- Notification bell/dropdown
- Date and plant/context controls
- SCADA status
- User/role presentation
- Mobile bottom navigation
- Right-side modal/drawer system
- Toasts, banners, tabs, filters, tables, pagination, charts, status rings, KPI cards

## Major workflows found

### Plants
- Plant register with filters/search/sort/pagination
- Add/edit plant
- Plant detail page
- Location coordinates and map preview
- Plant information spreadsheet import
- Location spreadsheet import
- Plant Excel/CSV export
- User-defined/custom plant columns
- Plant enrichment layer
- Assigned Site Engineer
- Equipment relationship and equipment filtering

### O&M Issues
- Raise issue
- Edit issue
- Assign / reassign
- Acknowledge
- Start / progress
- Resolve
- Verify / close
- Reopen
- Severity, status, vertical/subcategory, equipment, maker, assignee and date filtering
- ETC/SLA logic and ageing views
- Issue history/progress
- Notification/ring workflow and “request update” workflow
- Direct close-ticket behavior exists and is retained for the authorized role

### Project Handover
- Commission/project wizard
- Standard checklist template
- Add checklist item
- Evidence
- Start/submit/verify/reject checklist items
- Approval/rejection
- Handover certificate/log

### Scheduled O&M
- Create recurring task
- CSV import
- Assignee and equipment
- Start/complete
- Completion readings/evidence/anomaly flag
- Reassign
- Overdue/escalation logic
- Convert anomaly/task to issue

### Washing
- Per-plant setup/frequency/team
- Inverter/table register
- Washing log/history
- Exceptions and rescheduling
- Compliance/due logic
- Bulk wash action

### Extra services / support records
- Inventory and stock movements
- Permit to Work (PTW)
- Incidents
- Documents
- Vendors
- Service requests
- SLA records
- Notification rules
- Offline queue
- Audit history

### Data/telemetry
- SCADA adapter/config and telemetry normalization
- Portfolio generation/availability/PR/alarm values
- Excel-derived plant master data
- Reports/export helpers

## Role concepts found

The source explicitly defines:
- O&M Head
- Regional O&M Head
- Site Engineer
- Technician
- Client / Asset Owner
- Vendor (limited)

A later workflow patch removes **Regional O&M Head** from the active role selector and adds stricter Site Engineer plant scoping. The backend therefore treats the later behavior as authoritative and exposes the production role set as O&M Head, Site Engineer, Technician, Client / Asset Owner, Vendor (limited), plus a safe Viewer role for newly authenticated users.

## Original persistence/state found

The prototype persisted business and UI state with the prefix `s91v1_`. Keys found:

`plants`, `handovers`, `tasks`, `washing`, `washMeta`, `washPlant`, `schedScope`, `issues`, `inventory`, `movements`, `ptw`, `incidents`, `docs`, `vendors`, `rules`, `sla`, `audit`, `offlineQueue`, `serviceRequests`, `scada`, `scadaConfig`, `view`, `omTab`, `extSub`, `hoOpen`, `events`, `opsDate`, `plantId`, `_seq`, `plantEnrich`, `customPlantColumns`, `plantCustomValues`.

The source also contained a partial browser-side Supabase implementation for only `plants` and `equipment`. It still relied on localStorage for the rest of the system, so it was not a complete production persistence layer.

## Seed/demo data found

- 38 embedded plant master records
- Location seed data
- Plant enrichment seed data
- 8 notification rules
- Most operational seed functions (`issues`, `tasks`, `handovers`, `inventory`, etc.) currently return empty arrays in this uploaded revision

The migrated project places plant seed data in `scripts/legacy_plants.json` and uses `scripts/seed.py`; it does not silently seed operational demo records into production.

## Audit conclusion

The uploaded file is a single-page operational prototype with a large in-browser state machine. The safest migration path is not a frontend rewrite. The project therefore retains the original rendering and interaction code while replacing browser persistence and browser Supabase responsibility with authenticated FastAPI APIs and normalized PostgreSQL tables.


## Rev03 workflow clarification — planned vs unplanned O&M

The additional field workflow supplied for rev03 clarifies that the operational system must keep two distinct queues:

- **O&M Issues** for sudden/unplanned faults or urgent requests.
- **Scheduled O&M** for routine preventive/recurring maintenance.

The scheduled workflow records planned date, actual completion, delay, measurements/readings, evidence and remarks; a discovered problem can become a linked issue. Washing belongs to planned maintenance and uses inverter/table mapping, per-table logging, exceptions/rescheduling, cleaning history, compliance/delay and productivity reporting. The rev03 frontend therefore places Scheduled O&M directly below O&M Issues and nests Washing inside it.

## Rev 21 — Washing portfolio view & plant-link repair
- Washing tab now opens on **All plants** (every plant, every table) instead of forcing one plant; pick a single plant from the dropdown.
- "N due" badge (tab, sidebar, mobile) uses one definition covering all tables, so it matches what the tab lists.
- Tables whose plant text differs by spaces/case are auto re-linked; tables with a plant that no longer exists are shown in a red banner with an "Assign to plant" action (O&M Head).
- Backend plant lookup (`_plant_maps`) is whitespace/case tolerant, so new saves no longer create plant-less washing rows.
- Sidebar: Preventive Maintenance, Washing and Equipment Register moved into their own **Planned Maintenance** group; breadcrumb reads Planned Maintenance › Washing.
- `012_washing_plant_relink.sql` repairs existing rows (idempotent, no schema change).

### Rev 21b — Washing register editing
- O&M Head can **Edit / Add / Delete** a washing table and **Move all tables** of a plant (Washing tab; Edit button on every row, "+ Add table" in the plant bar).
- New endpoints (permission `washing.manage`): `POST /api/scheduled/washing/register`, `PATCH|DELETE /api/scheduled/washing/{id}/register`, `POST /api/scheduled/washing/move`.
- Validation (client + server): plant must exist, table ID required and unique within the plant, inverter 1–999, secondary ≠ main inverter, valid next-due date. Plant text is matched ignoring spaces/case.
- Deletes are real: the generic state sync is upsert-only, so register edits go through these endpoints, which also bump the state revision (stale tabs get a reload prompt instead of re-creating deleted tables).
- "Set up washing" now refuses to run for a plant that already has tables (prevents duplicate tables).
- Every change is written to the audit log.
