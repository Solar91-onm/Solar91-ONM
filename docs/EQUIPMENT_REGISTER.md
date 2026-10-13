# Equipment Register

Solar91 O&M Equipment Register is the plant-scoped asset register used by Preventive Maintenance and Site Issues. The v2 work is additive: the existing equipment API, status values, type ownership and free-text PM/issue equipment entry remain compatible.

## Access

| Role | Register access | Write access | Scope |
| --- | --- | --- | --- |
| O&M Head | Yes | Add, edit, bulk/import, move, retire, permanent delete, documents | Portfolio |
| Administration | Yes | No | Portfolio |
| Assignee | Yes | No | Existing equipment-type assignment scope |
| Site Engineer | Yes, from the plant page | No | Assigned plant only |

Per-item `in_charge_user_id` is the named responsible person. Existing equipment-type owners remain visible and still define Assignee visibility. For notification routing only, a per-item in-charge takes precedence over the type owner.

## Database migration

Apply `database/migrations/013_equipment_register_v2.sql`. It only adds nullable/defaulted columns and the `equipment_documents` table. Old rows stay valid. RLS is enabled and direct `anon` / `authenticated` table access is revoked in the same pattern as migrations 010 and 011.

New fields include DISCOM, feeder/GSS, rating/capacity/quantity, plant location, manufacturing and commissioning dates, warranty/AMC/supplier/PO fields, criticality, notes, in-charge user, and service dates.

## Register UI

The existing Solar91 classes and visual identity are retained. The screen now includes server-side pagination, persisted filters, DISCOM/in-charge/warranty/service columns, data-completeness shortcuts, Excel/CSV import with dry-run validation, filtered Excel export, atomic bulk add, Move, Retire, and typed-confirmation permanent delete.

Click a row to open the right-side detail drawer:

1. **Overview** — full asset data, plant/DISCOM, in-charge and type owners, warranty state.
2. **Assignment history** — plant moves and in-charge changes derived from AuditLog.
3. **Maintenance** — Preventive Maintenance tasks whose equipment reference matches the equipment code or name.
4. **Issues** — linked tickets plus open count and MTTR/MTBF when enough timestamps exist.
5. **Documents** — datasheet, warranty certificate and test report using the existing Supabase storage service/size limit.

## API additions

- `GET /api/equipment/page` — scoped, filtered server-side pagination.
- `POST /api/equipment/bulk` — one transaction; any duplicate returns 409 and rolls back the batch.
- `POST /api/equipment/{id}/move`
- `POST /api/equipment/{id}/retire`
- `GET /api/equipment/{id}/detail`
- `POST/GET/DELETE /api/equipment/{id}/documents...`
- `GET /api/equipment/import/template.xlsx`
- `POST /api/equipment/import` — `dry_run=true` validates without committing.
- `GET /api/equipment/export.xlsx`

Existing `GET/POST/PATCH/DELETE /api/equipment` contracts remain available.

## Washing specification retained

The Washing screen was deliberately not redesigned. Its existing workflow remains aligned to the supplied requirements: project inverter-to-table/string mapping, unique table IDs, project frequency, date-stamped per-table logging, bulk wash entry that retains per-table history, valid-reason exceptions, rescheduling, cleaning history, days-since-last-wash indicators, compliance/delay rollups, productivity views and supervisor threshold alerts.

## Manual QA

1. Sign in as **O&M Head**. Open Equipment Register, add an item with the new fields, edit it, move it to another plant, and verify Assignment history contains the change. Retire it; verify status becomes inactive. Confirm permanent delete requires typing `DELETE`.
2. Add two records with **Add many** and confirm one request creates both. Repeat with a duplicate code and confirm the entire operation fails with no partial creation.
3. Download the import template, populate a valid and invalid row, run preview, correct the invalid row, then commit. Export the filtered register and open the XLSX.
4. Exercise DISCOM, in-charge, warranty, no-in-charge and maker-missing filters. Refresh the browser and verify the filter/page state returns. Use Back/Forward and verify the hash route restores the page.
5. Open an equipment row and check all five drawer tabs. Upload/open/remove a test document. Confirm linked PM tasks/issues appear for matching code/name.
6. Sign in as **Administration**: register is visible but editing actions are absent/forbidden.
7. Sign in as **Assignee**: only assigned equipment types appear; editing is unavailable.
8. Sign in as **Site Engineer**: use the plant-detail “Equipment at this plant” link; only that plant is visible and no register sidebar/mobile shortcut is added.
9. In PM “new task” and “raise issue”, select a plant and confirm registered equipment is suggested while free-text entry still works.
10. On phone width, open **More → Equipment Register**, scroll the table, open a drawer/modal, use Tab/Shift+Tab and Esc, and confirm the bottom nav does not cover controls.
11. Washing regression: record a single-table wash, bulk wash, rain exception and reschedule; verify table history and compliance remain unchanged in layout/behaviour.
12. Run `pytest -q` and the JS syntax checks before deployment.
