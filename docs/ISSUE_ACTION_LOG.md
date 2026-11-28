# Site issue action log

Inside **Edit &lt;ticket&gt;**, between Issue details and Resolution, the ticket carries an
**Action log**: what its Assignee has done, each entry stamped with who recorded it and when.
It is the existing daily-progress record (`issue.progress`), surfaced in the register for the
first time; no new table, column or endpoint was added.

## Recording

* The box is offered to the ticket's Assignee and to any O&M Head — the same people who may close it. Everyone else who can open the drawer sees the log read-only.
* An entry is a **note** (required), a **work date** (defaults to today, never in the future), a **day status** (Worked, Waiting for parts, Waiting for vendor, Waiting for shutdown or access, Weather or site condition, No work today) and optional **hours**. The time is taken from the server, not typed.
* `POST /api/issues/{id}/progress` (`issues.progress`, workflow role and scope) does the write. The server already enforces that the work date is not before the ticket was raised and not in the future.

## Starting a ticket

The endpoint accepts entries only while a ticket is **Acknowledged** or **In Progress**. Writing
the first action on an **Open** or **Assigned** ticket therefore walks it
`Acknowledged` → `In Progress` first via `POST /status`, then records the entry — the same stage
walk the drawer already performs for Resolve, so the ticket's history still reads correctly and
every step is a real, audited transition. The box says so before it is used.

A ticket parked in **Pending Vendor**, **Pending Parts/Vendor** or **Pending Closure** shows the
log read-only with a line pointing at the Status field above: moving it back to In Progress is a
deliberate act, never a side effect of writing a note. A **Resolved** or **Closed** ticket shows
the log as a finished record.

## Reading

* `GET /api/issues/{id}/activity` returns the ticket's history; the drawer keeps the `issue.progress` entries and shows them newest first. One fetch per ticket each time the drawer opens, so another person's entries are picked up; closing the drawer clears the cached log.
* Each entry shows the actor, the stamp in plant time (`Asia/Kolkata`), the day status (amber when waiting), hours where recorded, the note, the next step where one was given, and the work date when it differs from the day it was entered.
* A failed read shows the error and a Retry, and never renders as "No action recorded yet."
* A draft survives a failed save, so nothing typed is lost. After a successful save the ticket row, the register and the dashboards refresh.

## Tests

`python -m pytest tests/test_issue_action_log.py tests/test_issue_head_corrections_ui.py -q`

Covers: recording an action auto-starts an Assigned ticket (two `/status` calls then `/progress`,
with the right body); the entry renders with actor, plant-time stamp, status and hours; entries
are newest-first and exclude non-progress history; a blank note never reaches the server;
Resolved and Pending tickets are read-only; a failed read offers Retry. Desktop and 390 px.
Not exercised against live Supabase.
