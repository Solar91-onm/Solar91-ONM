# PM unit scheduling (migration 016)

- **Plant unit configuration** (`pm_unit_config`): per plant + equipment type -> number of units, max units maintained per day. O&M Head edits and views; Assignees may view and edit only their assigned equipment types. UI: Preventive Maintenance -> *Unit configuration*.
- **Add PM task / Add PM template / Assign to plants** carry *Number of units*, *Max units per day*, *Units to maintain* (subset). Templates store only *units per day*; the plant setting wins. Resolution: request > plant config > Equipment Register > template default.
- **Scheduling**: units 1..N go on consecutive calendar days, `units per day` per day from the first due date (10 at 2/day = 5 days). One task per unit; one assignee per plant.
- **PM register dates**: the register shows the planned start-date window and due-date window; O&M Head can edit both from each work order, while an Assignee can edit dates only for assigned equipment.
- **Next period**: each unit repeats on its own planned day by frequency after completion.
- **Missed units**: the daily job (hourly loop, idempotent; also `POST /api/pm-plan/run-daily`) stores `missed_days`/`rolled_count`, moves the unit to the front of today's capacity and shifts later units. Set `PM_DAILY_JOB=0` to disable the loop.
- **Reminders / escalation** (workflow 2.1.2, 2.1.3): 3 days before and on the due date -> assignee; overdue from the planned date: 1 day assignee, 3 days Site Engineer of the plant, 7 days O&M Head.
- **Existing tasks** are untouched (all new columns nullable); the Add PM task confirmation warns when open tasks without unit numbers exist.
- **Maintenance Scope Library** is grouped (PV Area / Plant Side / GSS Side / Miscellaneous) for filtering only; Add PM task/template list every equipment type.

## Scope editing and equipment list (migration 017)
- O&M Head: *Edit scope* on the Maintenance Scope Library moves each equipment between PV Area / Plant Side / GSS Side / Miscellaneous or hides it from PM (`GET/PUT/DELETE /api/pm-plan/scope`). Defaults: PV Area = Inverter, Piling and Foundation, WMS; hidden = Module, String, Modules cleaning, MMS, Switchyard (Plant/GSS), VCB-Kiosk. RTCC is named OLTC(RTCC).
- Plants: AC/DC capacity comes from one accessor (`plantDcKw`/`plantAcKw`: plant record > Excel registry > legacy MW) used by the table, KPI totals, profile, export and capacity filters, so plants added later are counted and totals equal the table.

## Excel plan template
`frontend/static/templates/PM_Task_Plan_Template.xlsx` follows the supplied style: sheets *How to fill*, *PM Tasks*, *Task ideas*, *Lists*; columns A-G (Equipment type, Plant(s), Task, Frequency, Assignee(s), Safety needed, Est. time). Optional columns H-K: How to do it, Start date, No. of units, Units per day (blank = use the plant's Unit configuration). Dropdowns read the *Lists* sheet.
