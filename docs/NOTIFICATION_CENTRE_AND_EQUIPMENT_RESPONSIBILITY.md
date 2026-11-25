# Solar91 — notification centre, equipment responsibility, PM navigation

Three changes that ship together, and what has to happen to deploy them.

| Part | What it is | Where it lives |
| --- | --- | --- |
| Notification centre | The top-bar bell, its panel, Action Required, and the bottom-right toasts | `app/notifications/`, `assets/js/notifications.js`, `assets/css/notifications.css` |
| Equipment responsibility | Who answers for one equipment category across every plant, and automatic ticket assignment from it | `app/equipment/`, Login access section in `assets/js/settings.js` |
| PM navigation and register | The all-plants PM dashboard opens a plant's calendar directly; the plant page's register is equipment-wise | `assets/js/pm-tracking.js`, `assets/js/navigation.js` |

---

## 1. Deployment

Run in this order. Both migrations are additive: they create nothing that existing code depends
on, delete nothing, and are safe to re-run.

1. **Back up Supabase, and apply on staging first.**
2. `database/migrations/054_notification_centre_indexes.sql` — the `notifications` table itself is
   unchanged (it has existed since migration 001). This adds a partial UNIQUE index on
   `(user_id, dedupe_key)` so a retry or two workers cannot write the same notification twice,
   plus the unread and broadcast read-path indexes. If the UNIQUE index is rejected, the table
   already holds duplicates; the `SELECT` printed after the COMMIT lists them.
3. `database/migrations/055_equipment_responsibilities.sql` — creates `equipment_responsibilities`.
   It starts **empty**. Nothing is inferred from the existing plant assignments and no existing
   ticket, plant assignment or maintenance record is touched.
4. Deploy the application files. No new Python or JavaScript dependencies.
5. Sign in as the O&M Head and open **Login access → Equipment responsibility**. Until a category
   has a primary Assignee, new tickets for it stay unassigned and the O&M Head is notified; they
   are never discarded.

Nothing here adds Supabase Cron, Redis, a queue or any paid service. The periodic PM reminder runs
inside the existing hourly job in `app/main.py` (`_start_pm_daily_job_loop`).

---

## 2. Notification centre

### What a notification is

The `notifications` table is unchanged. **Category**, **priority** and **tone** are derived from
`event_type` in `app/notifications/service.py`, so no column was added and every row already in
the table is presented correctly. `payload` carries the context the bell needs to open the record:
`page`, `site_code`, `plant_name`, `month`, `activity_id`, `equipment`.

| Tone | Used for |
| --- | --- |
| Green | approved, completed |
| Blue | information, a new assignment or ticket |
| Amber | pending approval, action required |
| Red | critical issue, overdue, failed operation |
| Purple | PM sequence permission request |

### API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/notifications?unread=&limit=&before=&before_id=` | One page, newest first. Keyset cursor. |
| `GET /api/notifications/summary` | Unread count **and** Action Required, in one cheap call. |
| `POST /api/notifications/{id}/read`, `POST /api/notifications/read-all` | Read state, stored per user. |
| `GET /api/notifications/plants` | Site codes this user may open, for linking. |

Every query is restricted to the signed-in user's own rows plus portal-wide broadcasts
(`user_id IS NULL`). Marking another person's notification read returns 404.

**The cursor.** Notifications written by one transaction share a timestamp, and a timestamp that
has been through JSON can come back with different precision. The list therefore anchors on the
cursor **row** (read back from the database), filters coarsely in SQL (`created_at <=`) and applies
the exact "strictly after the anchor" test in Python. That is why `before_id` exists; sending
`before` alone still works but cannot break ties.

### Action Required

Computed from the live records under the same plant scope the pages use — never from
notifications. Marking a notification read therefore resolves nothing. Each entry is one indexed
aggregate: PM approvals waiting (O&M Head), sequence permission requests (O&M Head / Assignee),
returned checklists and your own submissions awaiting review (Site Engineer), overdue PM, open
critical tickets, and tickets with nobody responsible (O&M Head / Administration).

### Polling

One poller for the whole portal, started once by `app.js`. It calls `/summary` every 60 s while the
tab is visible, pauses when it is hidden, resumes on `visibilitychange` and `online`, doubles its
interval on failure up to 10 minutes, slows to 3 minutes on a metered or 2G/3G connection, and
never has two requests in flight. The unread list is only fetched when the badge actually grows,
and the panel's list is fetched when the panel opens. No page starts its own interval.

### Toasts

At most three on screen, identical messages collapse instead of stacking, a success disappears
after ~4.5 s, an important incoming alert stays ~10 s and carries a **View** action, and an error
stays until it is dismissed. Toasts are raised **after** the server has confirmed a write — never
before — so a toast never claims something that was not saved. Going offline raises one toast
saying nothing is lost; no write is ever replayed automatically.

### What creates notifications

Already existed: issue created / assigned / status changes, work-order assignment, washing alerts,
the PM daily plan. Added here:

| Event | Who is told |
| --- | --- |
| `pm_submitted` | O&M Heads, the plant's PM Assignee, and the equipment's responsible people |
| `pm_approved`, `pm_returned` | the engineer who submitted it |
| `pm_permission_requested` | O&M Heads and Assignees who can grant it |
| `pm_permission_granted`, `pm_permission_denied` | the engineer who asked |
| `pm_overdue`, pending-approval digest | once per plant per day, from the hourly job |
| `issue_unassigned` | O&M Heads, when no responsibility is configured for that equipment |
| `equipment_responsibility_assigned` / `_removed` | the person whose responsibility changed |

Each carries a dedupe key derived from the record's own saved timestamps, so a retried request
cannot produce a second copy, and the hourly job's reminders are keyed by the day. Notifications
are created **after** the workflow's own transaction commits, and a failure to write one is logged
and swallowed: a step the database accepted is never undone or hidden because of a notification.
A future activity that is merely sequence-locked raises no reminder.

---

## 3. Equipment responsibility

### The canonical catalogue

`app/equipment/service.py` holds one list of categories with the aliases the other modules use, so
PM's `4 Pole + ACDB + Aux. TX` and an issue's `VCB Panel` resolve to the same responsibility
instead of creating a second category. Categories configured in `work_categories` that match no
alias are added as they are, so that master table stays authoritative.

- A combined PM activity maps to **each** of its sections: `4 Pole + ACDB + Aux. TX` →
  `four_pole`, `acdb`, `aux_transformer`.
- `GSS visit` maps to `gss` only, keeping GSS-side responsibility distinct from plant-side.

### Configuration

Login access carries two ways in, both writing the same rows:

- **Equipment responsibility matrix** — category, primary Assignee, backup Assignee, coverage,
  status, Save.
- **A person's own dialog** — searchable list of every category with None / Primary / Backup, plus
  "select all as primary" and "clear all".

Only `users.manage` (the O&M Head) may read or write the configuration; `GET /mine` is open to any
signed-in user and tells them only about themselves. One active primary per category is enforced
by a partial unique index and by moving the previous primary to backup in the same transaction.
Every change is written to `audit_logs`, which the panel's **Change history** reads back.

Responsibility routes work and notifications. It grants **no** approval or sequence-override
authority: those stay with the role, and the PM approval requirement is unchanged.

### Automatic ticket assignment

When a site issue is created and no assignee was chosen, the equipment's active primary Assignee
takes it, whatever plant it is on. The ticket's history records why
(`issue.auto_assigned`), and the new owner is notified. Assignees have portfolio-wide plant
visibility, so equipment responsibility routes work without granting plant access.

With nobody configured, the ticket is still created, marked in its history as
`issue.assignment_skipped` ("Unassigned — responsibility not configured"), and the O&M Head is
notified so it can be assigned by hand. Existing tickets keep their assignees; configuration
applies to tickets created after it. An Assignee raising their own ticket still keeps it, and the
O&M Head can still reassign anything manually.

### Plant access

Assignees have portfolio-wide plant visibility. Plant assignments are not required for Assignees
and equipment responsibility does not grant or restrict plant access. Site Engineers remain
restricted to their assigned plants.

---

## 4. PM navigation and the equipment-wise register

- Clicking a plant on the all-plants PM dashboard — in Matrix **or** Cards view — opens that
  plant's own PM calendar, in the month the dashboard was showing. The plant page is not opened on
  the way; it remains reachable from the Plants tab, with its own "Open PM calendar" button.
- The calendar shows **← Back to all plants** when it was opened that way, and **← Back to plant
  tracker** when it was opened from the plant's page. Back pops the history entry this session
  pushed, so the dashboard returns with its search, filters, layout and scroll position intact;
  if there is no such entry (a reload, or Forward), it closes by state instead.
- The plant page's **Monthly activity register** is one row per equipment category — Approved /
  Scheduled, completion, pending approval, overdue, locked, next scheduled, status — with that
  equipment's individual units expanded inline on request. Groups start collapsed; "Collapse all"
  closes them. A unit's action opens that activity in the calendar, which is where the existing
  checklist and approval interface lives.
- Every figure is counted from the plant's own assigned activities. **Approved** means O&M Head
  approved; a submitted checklist awaiting review is never counted as completed.
- An activity that is not open to you for recording can still be **opened read-only**: the
  checklist renders with a "Preview only — nothing is saved" banner, the submit button is
  disabled, and the submit handler refuses to send it. The server would refuse it too.

Nothing in this change touches PM schedules, recurrence, checklist definitions, inverter
assignments, sequence locking, the approval workflow, the calendar's design, or Module Cleaning.

---

## 5. Validation

```
pytest -q tests/test_pm_navigation_and_register.py   # navigation, register, preview (Node + DOM)
pytest -q tests/test_notification_centre.py          # list, badge, Action Required, PM routing
pytest -q tests/test_equipment_responsibility.py     # catalogue, configuration, auto-assignment
pytest -q tests/test_add_plant.py                    # Add New Plant: API permissions and overlay
pytest -q                                            # the whole suite
```

Not verified here, and worth doing before production: a browser pass on the live portal for the
bell, the toasts and the register on desktop, tablet and phone; the two migrations against a
staging Supabase instance; and behaviour under a real slow connection. No migration has been run
against any database from this change, and no live-service or concurrency testing was performed.
