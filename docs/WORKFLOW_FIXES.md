# Workflow fixes — Site Issues, plant washing setup, PM

## Root causes found
1. **State sync overwrote tickets.** Every time the O&M Head's browser synced, it rewrote the status and assignee of every
   ticket from its own (possibly stale) copy, which could undo an Assignee's *Acknowledge*. Existing tickets are now changed
   only through `/api/issues/...`.
2. **Assign sent only a name.** The Assign dialog stored a name without the user's id, so the Assignee later got
   "Only the assigned Assignee can advance this ticket". Assignment now uses the Assignee's user id from the database.
3. **Several buttons changed the screen only** (inline Assign in the triage queue, bulk Assign/Close, Direct close, the stage
   strip, Edit ticket) and never reached the server. They now all call the API.
4. **Washing setup lost the chosen plant** whenever the page redrew in the background, and the Assignee list was empty unless
   someone already had *Modules cleaning* in Team access.

## Behaviour now
- Assignees are the active users with the Assignee role (from the database). Those matching the issue category are listed
  first. The O&M Head may pick anyone; the category is then added to that person's scope automatically (audited).
- Only the O&M Head can assign, edit, close (including direct close, which needs a reason) or move a ticket's stage.
- Edit cannot change a ticket's status; status changes only through Acknowledge → Start → Resolve → Verify & close.
- Re-assigning a ticket returns it to *Assigned* so the new owner acknowledges it.
- Notifications are sent after the ticket change is saved; a failing notification can no longer block or undo a step.
- Ticket numbers are retried automatically if two people raise an issue at the same moment.
- Site Engineers can raise equipment-referenced issues for their assigned plant. Issue creation notifies active
  O&M Heads and the selected Assignee; acknowledgements, work status and messages remain in the issue activity history.
- PM due-soon, due-today and overdue alerts include Site Engineers assigned to the task's plant, regardless of the
  O&M team's recipient mode. Opening a task alert takes the Site Engineer to that work order's detail and report controls.
- Site Engineers can start, evidence and submit completion reports for PM tasks at their assigned plant. Completion
  alerts O&M Heads and the task Assignee, and completed work is removed from active overdue alerts. Only O&M Heads and
  in-scope Assignees can change PM start or due dates.
- Washing setup keeps the plant and values typed until Save; every Assignee is listed; the *Modules cleaning* scope is
  granted on save (audited).
- PM list: the plant drop-down shows units per plant and the total for "All plants".

## Manual steps
1. Run `database/migrations/019_issue_assignee_backfill.sql` once in the Supabase SQL editor (links older name-only
   assignments to the matching Assignee user).
2. Redeploy the app. Users should hard-refresh (Ctrl + Shift + R) once.

---
# Washing redesign (tables only, no inverters)

- **Site engineer reports the actual daily count** ("29 tables cleaned today") plus before / after photos. Daily
  counts can vary; there is no fixed daily target for field users. A cycle completes when the O&M team confirms
  the full registered table count. Before and after evidence must be stored before a Done report can be confirmed. The next free tables of the
  cycle are assigned automatically. When all tables of the plant are cleaned **and confirmed by the O&M team**, the cycle
  completes and the next cycle starts. 3 cycles are due every month (deadlines: 10th, 20th, month-end).
- **Weekly compliance** is compared with the plant's target (default 85%) for O&M team tracking only; Site Engineers see neither compliance scores nor daily targets.
- **Overdue matrix (1 / 3 / 7 days)**: how many days a plant is past the deadline of its next cycle — On track, 1+ day,
  3+ days, 7+ days. Alerts are sent once at each level (daily job `check_washing_overdue`).
- **Register of all plants** (including plants not yet set up), sortable by lateness, with cycle progress, monthly cycle
  dots, today's status, weekly compliance, overdue badge and assignee.
- **Plant overlay**: cycle cards, day-by-day status for the month, before/after photo gallery per report, and
  Confirm / Reject for the O&M team. If photo storage fails after the report is created, the overlay reopens on
  that report so the Site Engineer can retry the missing evidence; confirmation is blocked until both photo types exist.
- **Cycle updates feed**: "Cycle 1 completed — Cycle 2 has started" (and a notification with the same text).
- **Command Center**: new "Plant washing" panel (matrix + most overdue plants); washing badges and the Section Health
  washing score now come from the cycle data. Other modules are unchanged.
- The old inverter/table register screens were removed. Database columns and the old per-table API endpoints are left
  in place so no data is lost (they are no longer used by the UI).

## Integrated reviewer and alert fixes (10 October 2026)
- Washing report review now checks the configured Assignee for the plant, or an active O&M Head. Other Assignees can view the portfolio but cannot approve another person's assigned plant.
- Overdue notification deduplication now matches the per-user key suffix used by the notification service.
- Existing authenticated FastAPI and Supabase API paths are retained; verify production connections using `scripts/preflight.py` with real server-side secrets.
