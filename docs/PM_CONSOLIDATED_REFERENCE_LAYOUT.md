# Solar91 O&M — Plant-first PM layout and consolidated unit workflow

## Reference design

This update follows `solar91-pm-section-v3(2).html`, especially its searchable **All plants / individual plant** selector, portfolio dashboard, equipment chart, plant drill-down and concise work register. The original sidebar, header and all non-PM modules remain unchanged. Command Centre filtered register links, report previews and the read-only operational assistant from the previous iteration are retained.

## Important change: quantities, not equipment-number rows

**The PM work register now displays one row per plant + equipment type + maintenance activity + scheduled cycle.** For example, a plant with 12 inverters shows **Inverter × 12** rather than 12 visible rows for Inverter 1–12. Equipment quantities come from the equipment register or saved unit configuration when available. The row includes a single progress bar and counts of completed/overdue units. When the user applies a status filter, the registered count still appears, while the matching task count is separately labelled.

Click **View units** to open a side drawer with the group’s registered and scheduled unit totals, completed/overdue breakdown, combined **workload by day**, and the original task records available behind **Open task**. The underlying individual task data, per-unit schedule, evidence, audit trail and API behavior are deliberately left unchanged because the existing scheduling and completion backend requires those records. This is display-level consolidation, not deletion or merging of stored records.

The selected plant shows a context summary for **Not maintained**, **Coming up**, and **Done** equipment groups. Equipment categories without an active plan still appear under **Equipment maintenance coverage** where unit inventory/configuration exists.

## Working controls

- All plants selector at the top, searchable by name/site code; another plant selector is available at the register itself.
- Grouped PM register with status, equipment, keyword and week/age chart filters, including pagination by **groups** rather than individual unit records.
- Original API-backed **Add job** form prefills the selected plant and equipment type, with unit counts, daily capacity, recurrence and assignment.
- **Unit counts** opens the original equipment unit configuration tool.
- **CSV/Excel import** and template download use the existing validated import API and role checks.
- Chart drill-down and Command Centre PM queue navigation retain live registers.
- Tasks, follow-ups, completion evidence, notifications, Excel compliance export, Supabase Auth, Supabase integration, Reports and other modules remain on existing routes.

## Validation performed

- `APP_ENV=test PM_DAILY_JOB=0 pytest -q`: **150 tests passed**.
- `node --check frontend/static/js/*.js`: all module scripts parsed successfully.
- `python scripts/verify_pm_consolidation.py`: Chromium test passed for two plants, one combined row for twelve inverter records, plant selection, status filtering, group drawer, links to original task detail, responsive layout, and no browser JS errors.
- `python scripts/verify_command_experience.py`: Command Centre queue navigation, report panel and operational assistant passed in Chromium.

## Production limitation

The tests above use fixtures or mocked browser data and do **not** confirm live Supabase login, database connectivity, Storage uploads, live email delivery, or real external export dependencies. Configure the actual site secrets and run an authorised end-to-end test in the production/staging environment before deploying. Do not interpret a count of zero as proof of no equipment when no equipment register/configuration is loaded.
