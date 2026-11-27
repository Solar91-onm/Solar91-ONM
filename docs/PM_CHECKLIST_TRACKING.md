# Solar91 — PM checklist tracking (changes-only deployment)

## Install

1. Back up your Supabase database and test on staging. Run `database/migrations/051_pm_checklist_tracking.sql` in the Supabase SQL editor before deploying the application files. It creates the new `pm_tracking_activities` table; existing work orders, cycle plans and equipment schedules are not modified.
2. Overlay the changed files from this archive onto the matching paths in the original Solar91-ONM project, then deploy the existing application normally. No new Python or JavaScript dependencies are required.
3. For the permanent recurring workflow, use Manage PM schedule as O&M Head or Assignee after verifying the existing recurrence schema. No sample records have been inserted into your live database.
4. Sign in as a Site Engineer assigned to one plant to record a checklist. Sign in as O&M Head to approve/return it. An O&M Head or an Assignee can grant/deny a permission request. Existing portal authentication and Site Engineer plant scope are used.

## SQL scheduling

Allowed `equipment` values (exact case/spelling):

- `Inverter`
- `ACCB`
- `4 Pole + ACDB + Aux. TX` (four-pole structure inspection only; use an equipment ID such as the actual four-pole structure ID)
- `Transmission line`
- `Earth pit`
- `Miscellaneous`

Use your actual database values. The following is a **commented example**, not a preloaded schedule:

```sql
-- Verify the plant ID and site code first:
SELECT id, site_code, plant_name FROM plants ORDER BY site_code;

-- Replace the example site code, equipment IDs and dates with the approved actual schedule.
-- INSERT INTO pm_tracking_activities (plant_id, equipment, equipment_id, scheduled_on)
-- SELECT p.id, v.equipment, v.equipment_id, v.scheduled_on::date
-- FROM plants p
-- CROSS JOIN (VALUES
--   ('Inverter', 'REPLACE_WITH_ACTUAL_INVERTER_ID_1', '2026-11-01'),
--   ('Inverter', 'REPLACE_WITH_ACTUAL_INVERTER_ID_2', '2026-11-03'),
--   ('ACCB', 'REPLACE_WITH_ACTUAL_ACCB_ID', '2026-11-15')
-- ) AS v(equipment, equipment_id, scheduled_on)
-- WHERE p.site_code = 'REPLACE_WITH_ACTUAL_SITE_CODE';

-- Review the resulting monthly assignments:
SELECT p.site_code, a.equipment, a.equipment_id, a.scheduled_on, a.status, a.permission
FROM pm_tracking_activities a JOIN plants p ON p.id = a.plant_id
WHERE a.scheduled_on >= DATE '2026-11-01' AND a.scheduled_on < DATE '2026-12-01'
ORDER BY p.site_code, a.scheduled_on, a.equipment_id;
```

Enter one row for each physical inverter. The migration prohibits repeating the same inverter ID (ignoring case and surrounding spaces) in the same plant/calendar month. Other equipment can have multiple independent visits where the schedule calls for them. Do not edit workflow fields or delete submitted activities through SQL. For schedule changes, coordinate with the O&M Head and use a maintenance window; application actions serialize by plant row lock, but direct SQL writes must explicitly acquire the same lock if done concurrently. The database administrator is trusted.

## Workflow and metrics

- The new PM pages read the SQL-assigned checklist activities. All-plant matrix/cards, plant tracker and calendar use the same API and data. A scheduled date must arrive before an engineer can submit. Actual inspection dates can be later than the scheduled date, but cannot be future dates or earlier than the scheduled date.
- Site Engineers scoped to the plant and portfolio Assignees can submit eligible activities. Every check requires an OK / Not OK / Abnormality / N/A result. Non-OK checks require observations. Photos remain linked to the PM checklist. Not OK and Abnormality create corrective Site Issues on a successful submission; see `docs/PM_CORRECTIVE_ISSUES.md`.
- Submission is `Pending approval`. Only O&M Head can approve or return for correction. Approval is the only status included in the new checklist completion percentage. Overdue includes any unapproved activity past its scheduled date, so overdue, pending approval and locked counts can overlap.
- Within a plant and calendar month, any earlier-date unapproved assigned activity blocks subsequent assigned activities. Same-date activities can proceed together. A grant from the O&M Head or Assignee allows only that requested activity to proceed; it does not complete or move the earlier activity. All writes enforce role/state and sequence server-side and save an audit log. The existing cycle-plan and work-order systems are not changed.
- Existing cycle-plan markers stay visible if there is no corresponding tracking assignment for the same plant/category/date. Unassigned checklist-covered markers show `Not assigned`; they do not enter the tracking denominator or sequence. Populate **every** checklist-covered planned activity through SQL before using the new workflow operationally. For IDT Transformer, VCB and GSS visit, no checklist was invented. Their existing records remain visible separately and are not included in the new locking/approval system. Legacy work orders remain separate, with their original statuses and history; do not duplicate work by creating new tracking assignments for already completed legacy jobs without reconciling them first. The combined four-pole category tracks the four-pole check only, not completion of ACDB or auxiliary transformer. Weather Station & UPS, Fire & Safety and separate module/structure/robot schedules are excluded. The five inverter-group checks remain as in the Monthly worksheet.
- The new CSV export includes assigned records and existing schedule/work-order context, with source and status distinguished. The main Overview displays the new monthly scoped checklist progress when assigned records exist, with legacy work-order counts labelled separately. Legacy trend and health calculations still use their original data sources to avoid silently mixing metrics. The recurring schedule editor appears for O&M Head and Assignee roles. Approval remains restricted to O&M Head; checklist submission follows the separate role/state rules above.

## Navigation and the monthly register

- The all-plants dashboard opens a plant straight on **that plant's PM calendar**, in the month the dashboard was showing, from both the Matrix and the Cards view. The calendar carries **← Back to all plants**, which returns the dashboard with its search, filters, layout and scroll position unchanged. The plant's own PM page is unchanged and still reached from the Plants tab, where its **Open PM calendar** button opens the same calendar with **← Back to plant tracker**.
- The portfolio's **Date** filter requests only activities scheduled for that day; the date must belong to the selected **Period**; changing Period clears an incompatible date. **Compliance** filters plants by their period status: On schedule, Behind, Not started or Not planned. Clear filters resets both. The date and compliance filters do not change activity scheduling, approvals or locking.
- The plant page's **Monthly activity register** is equipment-wise: one row per category with approved / scheduled, completion, pending approval, overdue, locked, next scheduled date and status, and that equipment's individual units expanded inline on request. Groups start collapsed. A unit's action opens that activity in the calendar, where the checklist and approval interface already live. Counts come from the plant's own assigned activities; a submitted checklist awaiting review is not counted as completed.
- An activity that is not open to the signed-in user for recording can still be opened read-only: the checklist renders with a "Preview only — nothing is saved" banner, its submit button disabled, and the submit path refuses to send it. The server refuses it as well.
- Checklist actions now also raise notifications (submission, approval, return, permission request and decision) and a daily reminder for overdue activities and the approval queue. See `docs/NOTIFICATION_CENTRE_AND_EQUIPMENT_RESPONSIBILITY.md`.

## Validation

`pytest -q tests/test_pm_tracking.py` exercises cross-plant scope, incomplete/abnormal check validation, locked submission, independent inverter approval, permission override, return/resubmit, same-date unlock and legacy marker visibility. The new frontend was rendered using a browser with representative mock API data. The standalone design preview is illustrative and is not a live database or an authentication system. Run the complete project test suite and verify on a staging Supabase/PostgreSQL instance before production. No live Supabase credentials were provided and no migration has been executed against your database.
