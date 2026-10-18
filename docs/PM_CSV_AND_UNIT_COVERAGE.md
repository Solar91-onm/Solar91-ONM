# Preventive Maintenance: Unit Coverage and CSV Import

## What's changed

- PM **All plants / individual plant** selector filters the existing dashboard, overdue lists and unit coverage.
- The **Equipment maintenance coverage** panel shows stored equipment types even when there are *no* PM tasks. Unit totals come from the active Equipment Register (`Equipment.quantity`) or, when no register entry exists, the saved plant-specific PM unit configuration. No equipment serial identifiers are necessary.
- Each row shows total configured/registered units, units with PM tasks, maintained units, overdue units, and a "Not planned" indicator for inventory with no job. "Not configured" means the unit total is unknown, not zero.
- **Unit counts** opens the existing unit-configuration editor. **Add job** opens the existing API-backed PM task creator, prefilling the current plant and, if selected, the equipment category. It runs an API dry-run before creating tasks.
- **Import CSV / Excel** accepts UTF-8 `.csv` and existing `.xlsx` / `.xlsm` files. Both formats use the same backend validation, role checks, template creation, plant association and duplicate prevention. **CSV template** downloads the correct header row.
- Existing task completion, reminders, reporting, notification preferences, Clerk authentication, Supabase Storage, and API routes remain.
- Removed the duplicate **Day-by-day cleaning** box from the main Washing section. Plant detail overlays and their day-by-day calendars remain.

## CSV columns

| Column name | Purpose |
| --- | --- |
| Equipment type | Required; supported equipment category (e.g. Inverter or Transformer) |
| Plant(s) | Plant site code/name; `All plants` is supported. If omitted, row is saved as a template without assigning plant tasks. |
| Task - what to do | Required; description of preventive work |
| Frequency | Daily, Weekly, Monthly, Quarterly, Half-yearly, or Annual |
| Safety needed | Optional; e.g. `PTW required`, `LOTO required`, `PTW + LOTO required` |
| Est. time (hours) | Optional positive number |
| No. of units | Optional integer (max 500); uses the saved plant quantity when omitted |
| Units per day | Optional integer, cannot exceed total units |
| Start date | Optional `YYYY-MM-DD`, `DD-MM-YYYY`, or `DD/MM/YYYY` |
| Assignee | Optional assignee name(s) |

All fields are validated before writes. Review the dry-run confirmation. Only the O&M Head can import; an Assignee can create PM work only within their assigned scope. Administration is limited to Command Center and Reports.

## Unit coverage interpretation

The coverage panel summarizes available PM task records by equipment type and plant. For unit-numbered PM tasks, the latest recorded job for each unit is counted once in the visual summary. A completed job is evidence of completed work for that recorded cycle; it is **not** a guarantee of compliance with every future scheduled cycle. When no equipment count exists, `Not configured` is displayed instead of an invented number. For full per-cycle audit and detailed records, use the underlying task details and Reports section.

## Testing and deployment

Run from the repository root:

```bash
python -m pip install -r requirements.txt -r requirements-dev.txt
pytest -q
```

Check JavaScript parsing with `node --check frontend/static/js/29-pm-live-dashboard.js` and `node --check frontend/static/js/24-pm-plan.js`.

This change does not require a new database migration. Configure Supabase as described in `.env.example` and `RELEASE_VALIDATION.md`. Actual live service connectivity, production data, security policies, and a complete end-to-end acceptance check require the target environment; they were not verified in the offline test environment.
