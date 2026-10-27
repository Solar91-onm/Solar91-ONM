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

## Finish-within-days, equipped plants and the morning plan (October 2026)
- **Finish within (days)** replaces "Max units per day" on *Add PM task* and *Assign to plants* (`spread_days` on `/api/pm-plan/tasks` and template apply). Each plant paces its own units: 8 inverters in 4 days = 2 a day; 1 transformer is done on day 1. `units_per_day` is still accepted and still wins when sent; the plant *Unit configuration* keeps its per-day crew capacity.
- **All plants** jobs go only to plants that have that equipment in the Equipment Register or saved unit counts; the response lists `skipped_plants`. If no plant has the equipment recorded anywhere, every plant is kept (previous behaviour).
- **Equipment coverage** shows one row per equipment type with a per-plant dropdown. `/api/pm-plan/unit-config` register rows now include `critical` (units with High criticality) and `faulty` (status `fault`).
- **Maintenance by day** lists, for a chosen day, every plant and the equipment on that day's plan (a job is on every day from its start date to its due date).
- **Morning plan notification** (`pm_daily_plan`, on by default, in-app; email optional under PM alerts): from 06:00 plant time the daily job sends each person one message — Assignees their own jobs, Site Engineers their plants, the O&M Head the portfolio (respecting "assignee only" team routing). Clicking it opens the day planner on that date. Deduplicated per person per day.

## 30-day PM cycle (October 2026)
Defined once in `app/pmplan/cycle.py` and served read-only at `GET /api/pm-plan/cycle` (O&M Head, Assignee). A cycle is 30 days, the same as the Monthly recurrence, so each unit repeats on the same cycle day next month.

| Area | Equipment | Cycle days |
| --- | --- | --- |
| Plant side | Inverter (all units, spread over the week) | 1–7 |
| Plant side | ACCB Panel (ACCB-1 + ACCB-2 as one job) + MCCB, together | 8–9 |
| Plant side | VCB Panel | 10–11 |
| Plant side | Transformer (IDT) | 12–13 |
| Plant side | Aux. Transformer | 14–15 |
| Plant side | 4 Pole | 16–17 |
| Plant side | Earthing (earth pit) | 18–19 |
| Plant side | Miscellaneous — the *Miscellaneous* job (Street Light, ERT, …; one job), plus every type not named here (RMS, CCTV, LA, ABT meters, OLTC(RTCC), WMS…) | 20–22 |
| Plant side | Transmission line | 23–24 |
| GSS side | VCB - GSS side | 25–26 |
| GSS side | 4 Pole - GSS side | 27–28 |
| GSS side | Transmission line - GSS side | 29–30 |

The two Transmission line phases share the days left after the fixed phases.
- **Add PM task / Assign to plants**: *Follow the 30-day PM cycle* is ticked by default (`follow_cycle` on `/api/pm-plan/tasks` and template apply). The date becomes the cycle start (day 1); the job starts on its equipment's first cycle day and its units spread over that phase (*Finish within* still overrides). A single unit is due on the last day of its phase. Unticked = previous behaviour.
- **Upload (Excel/CSV)**: the upload dialog asks for the cycle start (`follow_cycle=true&cycle_start=YYYY-MM-DD` on `/api/pm-plan/import`). A row's own Start date is that row's cycle start; blank rows use the dialog date. The dry run returns `schedule` (equipment, area, dates, task count), shown in the confirmation.
- `4 Pole - GSS side` and `Transmission line - GSS side` are new equipment types (like `VCB - GSS side`) so 4 Pole and Transmission line can be planned on both sides. Assignees need these types in their equipment assignment to work on them.
- **One job per plant** (`ONE_JOB_TYPES` in `app/pmplan/cycle.py`): *ACCB Panel* (ACCB-1 and ACCB-2 are maintained together) and *Miscellaneous* are always planned as a single unit (unit 1 of 1), whatever the request, Unit configuration, Equipment Register or upload says. Add PM task locks *Number of units* to 1 for them and Equipment coverage counts their inventory as 1. Work orders created earlier (e.g. two ACCB units) are left as they are.
- **Miscellaneous** is an equipment type on the Plant side between Earthing and Transmission line. Its task suggestions are Street Light, ERT and other small items, done in one visit. Assignees need *Miscellaneous* in their equipment assignment to work on it.
- Scope library defaults follow the cycle: Plant Side = Inverter, ACCB Panel, MCCB, VCB Panel, Transformer, Aux. Transformer, 4 Pole, Earthing, Miscellaneous, Transmission line; GSS Side = the three GSS-side types; PV Area = Piling and Foundation, WMS; everything else is Miscellaneous. A scope the O&M Head already saved is kept; use *Restore standard lists* to adopt the new defaults.

## No overlap: each equipment follows the one before it (October 2026)
- The cycle is an **order**, not only fixed days. At each plant a phase starts on its own cycle day or the day after the previous phase's last due date there, whichever is later (`chained_window` in `app/pmplan/cycle.py`). Example: cycle start Nov 1, 20 inverters at 2 a day run Nov 1–10, so ACCB + MCCB move to Nov 11–12, VCB to Nov 13–14, and so on; the GSS side moves too. Work that finishes early never pulls later phases forward.
- "Previous phase" means PM work already in the register at that plant in this cycle's 30 days (any status except Cancelled; Daily/Weekly jobs ignored; e.g. inverters set up earlier with Add PM task) plus earlier rows of the same upload. For Miscellaneous only *Miscellaneous* work orders count from the register; the other types in that phase count only within the same request.
- Uploads are processed in cycle order whatever the row order in the file. Each plant gets its own dates. The dry run's `schedule` entries carry `plants`, `moved_days` and `past_cycle_days`. Add PM task / Assign to plants return `cycle_moved` (plants whose turn moved).
- Tasks that already exist are never moved. Only new tasks are placed after them.

## Plant side and GSS side Excel templates
`frontend/static/templates/PM_Plant_Side_Template.xlsx` and `PM_GSS_Side_Template.xlsx` (buttons *Plant side Excel* / *GSS side Excel* on Preventive Maintenance and in the upload dialog). They come pre-filled with one row per equipment in cycle order. Fill in *Plant(s)*; there is **no Start date column**, because the cycle start (day 1) is chosen in the portal's upload dialog. The dropdowns list only that side's equipment. The workbook Keywords (`solar91-pm-side:plant` / `:gss`) make the importer reject a GSS-side type in the Plant side file and any non-GSS type in the GSS side file. Rebuild both files with `python scripts/build_pm_side_templates.py` after changing the cycle. The general `PM_Task_Plan_Template.xlsx` and CSV upload are unchanged.

## At-a-glance PM page (October 2026)
Presentation only (`29-pm-live-dashboard.js`, `46-pm-command.css`); no API, schema or stored-record changes.
- **Toolbar**: *+ Add job*, an *Upload plan* menu (upload, Plant side / GSS side / general Excel, CSV template; O&M Head) and a *More* menu (Unit counts, Alerts, Export compliance, Print).
- **Hero pills and KPI tiles**: Overdue · Due today (open work on today's plan) · Due this week · Unassigned (open work with no assignee) · Completed. Each filters the register; the filter shows as a chip.
- **Plants needing attention**: overdue first, then work due this week; *Show all plants* lists every plant with its next due date and unassigned count.
- **Equipment coverage** is collapsed to its summary by default. With no Equipment Register rows or saved unit counts anywhere, unit totals come from the PM jobs ("in PM jobs") and one notice replaces the per-row "not in register" chips.
- **Maintenance by day**: the day strip shows a workload bar; the chosen day is a compact list (plant · equipment × units · progress · assignee · status), searchable, filtered by All / To do / Overdue / Done, 12 rows until *Show all*. An empty day offers a jump to the next planned day.
- **Register**: 15 rows a page, people filter, sort (due date / most overdue / plant / equipment), overdue rows tinted with "N d late", "due today / in N d" for work due this week, an *Unassigned* chip.
- **Assign** (O&M Head; register row, day list, unit drawer): assigns a plant's open work orders in one group through the existing `PATCH /api/scheduled/tasks/{id}/assignee`, one request per work order, so role and equipment-scope checks and the task log stay on the server. If one is rejected it stops, says how many were saved and leaves the rest unchanged.
- Browser check: `python scripts/verify_pm_command_view.py` (mock data and API, no credentials).

## Views instead of one long page (October 2026)
Presentation only (`29-pm-live-dashboard.js`, `47-pm-views.css`); no API, schema or stored-record changes. The hero and the five KPI tiles stay on top; below them one tab bar:
- **Overview** — status donut, jobs by due week, how late overdue work is, **Upcoming 7 days** (units and plants per day, top equipment, share done; a day opens the calendar), plants needing attention, equipment rings. With one plant chosen, its focus card comes first.
- **Calendar** — month heat map (darker = more units that day, red badge = overdue work due that day, green line = share done) above the existing *Maintenance by day* list. *+ Plan job on …* opens *Add job* with that day as the start date.
- **Plants** — every plant against every equipment type, coloured by the most urgent state (overdue / due this week / planned / all done / no PM job) with the work-order count. Filter chips (with overdue work, due this week, on track, without PM jobs), plant search, sort, 30 rows until *Show all*. A cell opens that plant + equipment in the register.
- **Coverage** — the equipment coverage table (always expanded here).
- **Work register** — unchanged register, filters, assign and edit. KPI tiles, hero pills, chart bars/slices and Command Centre / Work Radar / Plant Pulse links open this view (Plant Pulse "today" opens the Calendar).

Scale: one render reuses its coverage, plant lookups and grouping instead of recomputing them per row, and search boxes redraw 150 ms after typing stops. Measured in local headless Chromium with mock data (100 plants, 2,208 work orders): about 250–380 ms per render before, 35–105 ms per view after. Not measured against live data or on a phone CPU. `/api/scheduled/tasks` and the bootstrap still send every PM record the user may see (see `docs/SCALABILITY_AUDIT.md`).
Browser checks: `python scripts/verify_pm_command_view.py`, `python scripts/verify_pm_consolidation.py`.
