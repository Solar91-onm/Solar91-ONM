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
- **Days are counted into cycles by date, with carry-over** (`_cycle_sequence` in `app/scheduled/washing_cycles.py`).
  Each cycle fills up to the plant's table count; the day that reaches it completes the cycle, the tables above the
  count carry over to the next cycle (206 per cycle, 234 recorded: cycle 2 shows 206 and cycle 3 starts with 28), and
  later days go to the next cycle. After cycle 3 is full, further days stay on cycle 3 as extra washing. Adding,
  back-filling, editing, deleting, confirming or rejecting a day (and the daily Excel upload) recounts that month, so
  an edit moves the days after it to the right cycle; every move is in the audit log ("Recounted washing cycles").
  Completion counts confirmed tables only. The cycle sheet shows "+28 → C3" on the day that crosses the count.
- **Automatic recount after a rule change**: on start the app recounts every saved plant-month once per
  `CYCLE_RULE_VERSION` (marker `washing_cycle_rule` in `app_settings`; one plant per transaction, idempotent, no
  notifications). Cycle cards, the monthly sheet export and compliance then follow the new rule without any action.
  The O&M team still sees a *Recount cycles* note in a month whose days are out of place
  (`POST /api/scheduled/washing/plants/{id}/recount?month=YYYY-MM`).
- **Cycle compliance** (replaces weekly compliance) follows the cycle whose planned window contains today: cycle 1 =
  days 1–10, cycle 2 = 11–20, cycle 3 = 21–month end, or the plant's own cycle dates. It is the confirmed tables
  counted in that cycle (with tables carried over from the previous one) against the tables due from the window's
  start to today (each day's share of the plant's count; excused days left out), shown as a tables ratio, e.g.
  `60 / 80 tables` (`_cycle_compliance`, overview `cycle_compliance` per plant and for the portfolio). A plant still
  finishing the previous cycle shows low compliance for the current one; in the portfolio total a plant ahead of its
  target counts only up to it. It is compared with the plant's target (default 85%); the Command Center washing tile
  shows the portfolio ratio for the current cycle and how many plants are below target. O&M Head and washing
  Assignees only: Site Engineers keep recording their days and never see compliance or daily targets.
- **Washing page score (hero ring)** is the month's cycle compliance: cycles done / cycles due this month (3 per active
  plant). It starts each month at 0% and only rises as cycles complete. Ring colour: green while no plant is past a
  deadline, amber when some are, red when more than a quarter are. The current-cycle tables compliance above stays on
  the *Compliance · cycle N* card, per plant, in alerts and on the Command Center tile.
- **Cycle progress bars**: a plant's current cycle counts as *In progress* only once tables are reported or carried
  into it; until then it is grey *Not started*.
- **Low-compliance alert** once per cycle and plant, the day after the cycle's window ends below the target
  (`check_cycle_compliance_alerts`, event `washing_cycle_compliance_low`, looks back 3 days), to the O&M Head and
  washing Assignees only. It replaces the weekly alert.
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
