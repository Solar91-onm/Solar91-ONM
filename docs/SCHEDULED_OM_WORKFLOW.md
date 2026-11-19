# Preventive Maintenance — production rev15 workflow

The `/api/scheduled` endpoint and persisted audit module retain their existing identifiers for compatibility; the portal displays this workflow as **Preventive Maintenance**.

## Operational separation

- **Site Issues**: sudden/unplanned plant faults, breakdowns and urgent requests.
- **Preventive Maintenance**: preventive/recurring maintenance that is intentionally planned.
- **Washing**: an internal Preventive Maintenance section, not a separate top-level field workflow.

PM tasks, Site Issues and washing records are persisted through their domain APIs. The compatibility
`/api/state/sync` endpoint excludes those collections; changes to unrelated legacy state use
per-collection revisions so unrelated edits do not conflict with one another.

## Raising a Site Issue

On a plant's Health page, **Raise issue** opens a three-step form: Plant, Classification, and Priority & details. The plant is fixed when opened from a plant page; the portfolio issue page allows choosing an authorized plant. Classification uses the configured issue category and optional sub-problem. The final step captures severity, occurrence date, issue details, optional deadline, up to 10 evidence photos, and an optional Assignee. Creation and photo uploads use the existing authenticated issue APIs; fields unsupported by the current issue schema are not collected.

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

## Washing cycle dates, assignment and plant search (October 2026)
- **Plant Washing calendar**: hovering or focusing a date shows the selected plant's saved cleaned-table count for each cycle on that date, including its report status; dates with no completed cleaning show only the saved remark, or the recorded not-done reason when no remark was entered. The hover content updates from the month data already loaded. O&M Heads and washing Assignees can open **Set up washing** in the calendar header to set the cycle table count and assigned Assignee.
- **Cycle dates for any month**: the washing plant overlay has a *Cycles & dates* tab with a month switcher (two years back to one year ahead). The O&M Head / washing Assignee can set every cycle's start and deadline to any day of that month and save all three at once (`PUT /api/scheduled/washing/plants/{id}/cycle-schedule`). Ticking *Use these dates every month from … on* stores a repeating pattern (`cycle_overrides["pattern"]`, day numbers clamped to short months) and clears one-off dates of later months. `GET /api/scheduled/washing/plants/{id}/cycles?month=YYYY-MM` returns a month's cycles; Site Engineers can read their own plant only.
- **Past data**: the O&M team can record washing for any past date (it counts towards that month's cycles); Site Engineers keep the 45-day limit.
- **Washing scope**: in Settings → Team access, washing is given to an Assignee like an equipment type ("💧 Washing (module cleaning)" = `Modules cleaning`).
- **Assignee role only**: PM jobs, task reassignment and schedule edits refuse a person who is an O&M Head, Administration or Site Engineer; "Assign to" lists show active Assignees only. Older free-text names that match no portal user are left as they are.
- **Plant search**: every plant drop-down (top bar, Site Issues, PM, washing, raise-issue wizard, Team access) opens a type-to-search list.

## Washing cycle sheet (October 2026)
- **Record washing** in the plant calendar opens the selected cycle's daily sheet. Enter the table numbers or ranges cleaned for each day, in either ascending or descending order; the saved record and display preserve that entered order, while the inclusive count is calculated from the selected tables. Saving submits only days with a range, with optional remarks, in one request. A table cannot be recorded twice in a cycle; rejected reports do not reserve tables, and tables can be recorded again in a new cycle. Days already reported show their count, table range, status and remarks. Site Engineers can report within the existing 45-day limit; O&M Head / washing Assignees can back-fill within the API's supported date range.
- `POST /api/scheduled/washing/daily-reports/sheet` saves up to 62 days of one plant in one transaction (all or nothing). Days that already have a pending or confirmed report are refused (edit those instead). A Site Engineer's days stay *Pending* and raise **one** review notification for the whole sheet; O&M Head / washing Assignee entries are saved as confirmed.
- `POST /api/scheduled/washing/daily-reports/confirm` lets the O&M Head or the plant's washing Assignee confirm several pending days at once (never their own; all or nothing), with one summary notification plus a cycle-completed notification when a cycle finishes.
- **Photos**: a day entered within 3 days of the work (`PHOTO_REQUIRED_DAYS`) still needs before and after photos before it can be confirmed. Days entered 3 or more days later (back-filled) can be confirmed without photos; reports carry `backfilled` / `photos_required` and the sheet flags *No photos · back-filled* for the reviewer.
- Cleaning and issue evidence uses the authenticated `/api/photos` pipeline. Field evidence uses 480px/q65 thumbnails; originals are removed after `PHOTO_RETENTION_DAYS` (default 30), while thumbnails and metadata remain. Configure `PHOTO_RETENTION_DAILY_JOB=1` on one continuously running worker for the daily Storage API sweep; the job logs reclaimed bytes. `python scripts/purge_photo_originals.py --dry-run` previews eligible originals. The shared gallery keeps its 640px/q70 default.
- **Module Cleaning photos**: each daily record carries a Before row and an After row of two slots each. A slot holds one photo; uploading to an occupied slot replaces it and the replaced objects are removed from Storage. A partial unique index (`ux_site_photos_washing_slot`, migration 042) makes the one-photo-per-slot rule the database's, not the form's. Who may add evidence is unchanged: the report's submitter, the O&M Head, or the plant's module cleaning Assignee, before review. Other roles see the photos read-only.
- **Raise Issue photos**: at most four per ticket. Each is downscaled in the browser (2048 px, WebP q0.8, falling back to the original file where the browser cannot encode one) before it is sent. The ticket is created first and the photos follow, linked by its ticket number under a browser-generated `submission_id`; if the upload fails the ticket still stands and the retry re-sends under the same id, which the API answers with the photos already saved rather than storing a second copy. `Issue.photo_count` is maintained by the API across both linked photos and legacy evidence, so the register shows the server's number. Issue detail adds and removes photos in place.
- `GET /api/scheduled/washing/plants/{id}/cycles?month=` now also returns that month's reports (all statuses) for the sheet.
- **Compliance and 0 days**: weekly compliance is tables cleaned ÷ tables due over the last 7 days. A day with 0 tables cleaned is left out of "due" only when its remark names an **excused reason** (whole words, any case: "Heavy rain since morning" matches *Rain*; "training" does not). This applies as soon as the day is reported (awaiting confirmation or confirmed); a rejected report never excuses its day, and a day where tables were also cleaned is never left out. Any other 0 day (e.g. "Labour absent", or no remark) counts as 0 cleaned against that day's target. Older entries saved with a specific not-done reason (e.g. *Rain*) still count. The same rule drives the weekly compliance alert and the day view's "vs target".
- **Delayed by reason**: a plant behind a cycle deadline is "delayed by reason" when the excused days in that late cycle (from its start, or the day after the previous cycle was completed if later, up to today) are at least as many as the days it is late, e.g. 3 days late with 3 rain days. The overview sends `excused_days_late_cycle` and `delay_excused` per plant (O&M team only). The Command Center's *Panel washing* card counts active plants as **On track** (every cycle due by today's date completed), **Delayed by reason** or **Not on track**; each slice opens the washing register filtered to those plants.
- **Excused reasons list** (backend only, no portal screen): defaults *Work not started*, *Rain*, *Water shortage*; stored in `app_settings` (`washing_excused_reasons`). `GET /api/scheduled/washing/compliance-reasons` (O&M Head and washing Assignees) returns the list; the O&M Head changes it with `POST` `{"reason": "…"}` (add one), `DELETE ?reason=…` (remove one) or `PUT` `{"reasons": [...]}` (replace the list; up to 50 reasons of up to 80 characters, duplicates ignored). Every change is written to the audit log.

## Spreadsheet uploads (October 2026)
- **Daily washing upload** (Washing → *Upload Excel* → *Daily washing*): download a month's sheet (`GET /api/scheduled/washing/daily-template?month=YYYY-MM[&plant_ids=…]`), pre-filled with one row per set-up plant and day up to today; saved days show their values and status. Type *Tables cleaned* (0 when no washing was done; there is no reason column), leave empty days empty, and upload (`POST /api/scheduled/washing/daily-import?dry_run=true|false`, .xlsx or UTF-8 .csv, 2 MB, 3,000 day rows). A user's own file with the columns *Site code*, *Date* (DD-MM-YYYY), *Tables cleaned*, *Remarks* also works. Rules match the cycle sheet: O&M Head / washing Assignee rows are saved as confirmed; a Site Engineer's rows (own plant, last 45 days) stay pending with one review notification per plant; cycle numbers and completion are worked out exactly as day-by-day entry would. Every row is checked first and nothing is saved while any row has a problem. A day already saved with the same values is reported as *Already saved* and skipped; a different value for a saved day is a problem (edit that day in the portal). Dates older than two years are refused (the cycle sheet cannot show them).
- The *Plant setup* tab keeps the existing washing setup import.
- **Site Issues upload** (Site Issues → *Upload Excel*): `GET /api/issues/import/template` and `POST /api/issues/import?dry_run=true|false` (500 rows). Required: Site code, Issue category, Description, Severity. Optional: Problem, Equipment / unit (linked to a registered unit of the plant when it matches), Occurred on, Target date (default deadline by severity: 2 / 4 / 10 days, as in the Raise Issue form), Assignee email, Maker, Impact. Same scope rules as Raise Issue; tickets start as Open or Assigned with an `issue.created` history entry. A row matching a ticket that is not closed (same plant, category, equipment, description) is skipped. Heads and Assignees get one summary notification each; critical tickets still alert individually. Resolving and closing stay in the portal (evidence and root cause are required there).
- **Preventive Maintenance**: the existing plan upload now offers the *Excel template* (`/static/templates/PM_Task_Plan_Template.xlsx`) next to the CSV template; the upload buttons are shown to the O&M Head only, matching the server rule. Completing PM work by spreadsheet is not supported because completion requires before/after photos.
- **Remarks column in every upload sheet**: daily washing (stored on the day's report), washing setup (the column formerly called *Notes*; files with *Notes* still import), Site Issues (saved as the ticket's first message, shown in its activity) and the PM plan (added to the log of every task the row creates). Use it for the current situation, e.g. "vendor called, spare expected Friday".
- **Washing beyond three cycles** (e.g. robot cleaning finishing the month early): once all three cycles of a month are complete, further days are no longer refused — by the upload, the cycle sheet or the single-day report. They are saved on cycle 3 as extra washing; no fourth cycle is created and the completed cycles stay as they were (a confirmation of an extra day never re-announces a completed cycle). The month's record counts **times washed** (confirmed tables ÷ tables per cycle, e.g. 4.5) and **extra washes after 3 cycles**. Both appear in the *Monthly summary* sheet of the downloaded month workbook (with cycle completion dates, tables awaiting review, days worked and days not done), in the cycle sheet header, and as `summary` in `GET /api/scheduled/washing/plants/{id}/cycles?month=`.

## Sequential Module Cleaning cycles (November 2026)
- Cycles advance by **distinct tables cleaned**, not by the calendar date range. Cycle 2 begins only after all configured tables in Cycle 1 are cleaned; Cycle 3 begins only after Cycle 2 is complete. A table already recorded in an incomplete cycle is refused for every role, except on the day that completes the cycle (see *One date finishing a cycle and starting the next*). Cycle 3 is the last cycle; extra washing after all three cycles is recorded on Cycle 3.
- Cycle date ranges and deadlines remain rate targets: they show how quickly the plant is being cleaned, but do not start or skip a cycle. The record sheet keeps the active cycle selectable after its scheduled date window and prevents selecting a cycle that has not started.
- Back-filling, editing or deleting a day re-numbers later records in date order using `_cycle_sequence` in `app/scheduled/washing_cycles.py`. A new cycle is assigned only after the preceding cycle reaches its table count. The cycle-rule version change triggers the existing one-time historical recount on startup, with audit entries; do not run it directly against production without approval.

## One date finishing a cycle and starting the next (November 2026)
- A cycle is often filled in the morning and the next round started the same afternoon. In **Record module cleaning**, type everything cleaned that day in the day's one box, e.g. `1-25, 26-35`: the tables the cycle still needs complete it and the already-cleaned tables are split off and saved as a **second entry for the same date**, which the cycle engine numbers as the next cycle. The row shows the split before saving ("25 tables complete cycle 1 · 10 tables (26–35) start cycle 2 on this same date") and its count is the whole day's work. Both entries are saved together or not at all, follow the normal review rules for the role, and the billing reads the second entry on the date it was cleaned.
- The split is only offered on the day the cycle actually closes. A repeat entered without the cycle's remaining tables keeps the existing refusal and names the tables still open, so a mistyped table can never roll into the next cycle silently.
- In the month's **last cycle** there is no next cycle to open, so the repeated tables are saved as extra cleaning (`is_extra`, migration 048) and join the month's extra-cleaning total once all three cycles are complete. They never stand in for cycle work.
- A cycle's sheet now opens **on** the day the cycle before it was completed, not the day after, so that afternoon's work can also be added after the fact from the next cycle's tab, and a cycle that was only ever started that afternoon has a row.
- Each cycle's tab shows only its own entries. A date may carry an entry in two cycles, and the sheet gives each one its own row.
- Entries of one date are ordered by `created_at`; the sheet request stamps each entry a distinct, increasing value, because the database default is the transaction timestamp and would make them tie. Without that order the roll-over can be counted against the cycle still running and the save is refused as a repeat.

## Cleaning activity compliance
- Dashboard, plant profile and Module Cleaning monthly compliance use confirmed cleaning work against the month's plan, rounded to one decimal place. A plant's own score can exceed 100% when all three cycles are confirmed and extra tables are confirmed cleanings; the surplus counts fractionally as extra washes. Portfolio scores remain capped so one plant's surplus cannot cover another plant's shortfall. Pending and rejected reports do not count as confirmed work.
- The Module Cleaning board's card ring and table percentage show the plant's monthly compliance rate; the C1/C2/C3 bars show per-cycle table progress. Cycle dates and the existing lateness threshold continue to measure pace; they do not determine the activity-compliance score.
- The Module Cleaning board defaults to cards and offers a per-user cards/table view preference. Its table view shows the saved cleaning range and table count for the selected date, or the selected cycle's month-to-date reports when All dates is selected; All cycles uses the plant's current cycle. These values come from the existing overview payload and refresh when the board is opened. The “Compliance (%)” column matches the card ring. Switching views only rerenders the already-loaded rows.
- A period with no planned activity reports 0% and is labeled as unscheduled. The current washing schema has no cancelled-activity status/history, so no status is invented or excluded as cancelled. It also has no reliable module-area values; Cleaning Coverage is therefore not shown. Actual module area per table or report would be required to calculate it.

## Washing day summary and cycle sheet view (October 2026)
- **Record washing** shows at least 10 days without scrolling (rows are one line: status chips and reporter side by side; the sheet is up to 66% of the screen tall). The plant overlay no longer has its own inner scroll box, and a re-render of the same view (month loaded, days saved or confirmed) keeps the overlay and the sheet where the user had scrolled.
- **Cycle updates & confirmations** shows *Today*: the plants whose tables were cleaned today and confirmed, cleaned but awaiting confirmation, and not cleaned / not reported (each plant opens its overlay). **Day summary** opens any day, for all plants or one plant: plants grouped by that day's status (same rules as *Day by day*: confirmed, awaiting review, not done with reason, rejected, not reported), tables cleaned, the day's target and the difference (O&M team only; field users never receive targets), cycles completed on that washing date, and confirmations made that day (by confirmation time, India time, whatever day was washed) with who confirmed. Backed by `GET /api/scheduled/washing/day-activity?day=YYYY-MM-DD[&plant_id=…]` (read-only; O&M team: every set-up plant, Site Engineer: own plants).
