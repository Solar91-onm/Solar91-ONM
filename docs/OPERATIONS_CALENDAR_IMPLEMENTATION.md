# Solar91 — Operations Calendar implementation and verification

## Scope of change

`Operations Calendar` is a read-only, role-scoped view of **existing** operational entities. It adds no new operational database table, form, or migration. Site Issues, Preventive Maintenance and Washing retain their own authoritative record workflows. Event detail and edit actions open those modules.

The calendar follows the application's shared top-level plant scope (`S.dashPlant`/the locked Site Engineer plant). Its Plant filter is a control for that same scope (it calls `setPlantScope`), not a separate calendar-only scope; it is disabled for Site Engineers. Each day cell shows one chip per activity type (Site Issues, Washing, Preventive Maintenance) with its count; the chip or day opens a searchable summary with one collapsible list per type. It can display multiple plants and individual PM equipment work orders independently. It is available to O&M Head, Assignee, Site Engineer, and Administration accounts; the unapproved `Viewer` role is not granted calendar access. Administration can see the permitted issue/PM data but not washing records. Assignee records are additionally scoped to their assigned equipment types, and the backend rechecks scope for individual popups, not just for listing.

## Actual database mappings

| Calendar item | Source model | Operational date | Reference and key | Visibility/status basis |
| --- | --- | --- | --- | --- |
| Site Issue | `Issue` (`issues`) | `occurred_at`, converted from stored UTC to `Asia/Kolkata` business date | `ticket_no`, `issue:<UUID>` | Non-deleted records; real `severity`, `status`, `vertical`, `subcategory`, `assignee_text`, `Plant.assigned_engineer`; notes, reporter and evidence loaded on demand |
| PM work order | `OMTask` (`om_tasks`) | `due_on` | `work_order_no`, `pm:<UUID>` | Individual work order/equipment `unit_no`; `status`, `task_type`, `equipment_ref`, `assignee_text`, `planned_due_on`, `actual_completed_on` |
| Actual washing report | `WashingDailyReport` (`washing_daily_reports`) | `report_date` | Cycle/month reference, `washing:<UUID>` | `cycle_no`, `cycle_month`, `job_status`, `review_status`, `tables_cleaned`, `reported_by`; remarks, review and evidence on demand |
| Planned washing cycle deadline | `WashingConfig` + existing `_cycle_due_dates` and actual reports | configured cycle `due_date` (10th, 20th and month-end defaults, unless overridden) | `washing-cycle:<plant UUID>:<YYYY-MM>:<1–3>` | Three monthly deadlines per *configured active plant*; `Completed` only when an actual confirmed `cycle_completed` report exists. This is a schedule item, **not** a synthesized report. |

**Important date behavior:** An issue with no `occurred_at` does not gain a fabricated occurrence date from `created_at`. PM completion is detail metadata, not a second counted event. For Washing, the scheduled deadline and a real report on the same date are distinct, identified, labelled activities and can both be shown; no daily report is fabricated from a schedule. Date-only values remain date-only (no invented hour).

## Colour mapping

- Issue with an authoritative Resolved/Closed/Completed/Fixed status: **green**, regardless of original severity. Otherwise Critical/High = deep red, Medium = amber, Low = slate-blue, unknown = neutral. The real backend values are not reclassified by inspecting remarks.
- PM completed = green, cancelled = neutral, genuine past-due unfinished = amber, failed = red, otherwise scheduled = blue. The *Overdue* filter derives from actual `due_on` and status.
- Washing report confirmed with `job_status=Done` = green; rejected or `Not done` = amber; pending review = teal. A configured cycle deadline is green **only** after confirmed completion, amber if overdue and incomplete, teal otherwise.
- Every event also has an `ISS`, `PM` or `WASH` label; no colour-only communication.

## Open work carries forward

Each event has `date` (its own date), `until` (last day it appears) and `done`:

- **Site issue:** shows from the day it occurred on every day until it is Resolved or Closed (`fixed_on`, else `closed_on`); while open it repeats up to today. On its solved day it is `done` and shown green. A solved issue with neither date (older imports) appears on its own date only.
- **PM work order:** shows from its due date until Completed (`actual_completed_on`), repeating while open (overdue) up to today. Completed early or on time: its due date only, green. Cancelled: its due date only.
- **Washing cycle deadline:** a missed cycle repeats until a confirmed cycle-completing report (green on that report's date), or until the day before the next cycle falls due, which then carries the remaining tables. The previous month's cycles are checked so a missed cycle from late last month still shows. Daily washing reports stay on their own date (green when confirmed as done).
- Open work is never projected past today.

The list endpoint returns every event active on any day of the range; the summary counts each day an event spans (`issue`, `pm`, `washing`) plus those solved that day (`issue_done`, `pm_done`, `washing_done`). Rows show *Open Nd* / *Overdue Nd* on carried days and *Resolved* / *Completed* on the solved day; chips show the solved-that-day count with a green ✓.

## Routes and filtering

`GET /api/operations-calendar` requires `start` and `end` (inclusive ISO dates), with a maximum 94-day span. Optional filters: `plant_id`, `activity_type` (`issue`, `pm`, `washing`), `equipment`, `subpart`, `engineer`, `assignee`, `status`, `severity`, `q`, `limit` (1–2000), `offset` (0–10000). Response: `events`, `has_more`, `next_offset`, `start`, `end`.

`GET /api/operations-calendar/summary` takes the same range and filters (no `limit`/`offset`) and returns only `days` (`{date: {issue, pm, washing}}` counts) and `facets` (filter options, at most 150 per field). It runs the same permission-scoped, filtered queries but selects only the date and filter columns. Month and week views load this; a day's records load from the list endpoint (`start`=`end`=that day) when the day or a chip is opened, and are cached in the browser for 60 seconds (at most 60 days, cleared when the period's counts are reloaded). The day view loads its records directly.

`GET /api/operations-calendar/{kind}/{UUID}` loads an authorised Issue, PM or actual Washing report, including real comments, review data and protected evidence URLs as available. `GET /api/operations-calendar/washing-cycle/{plant-UUID}/{YYYY-MM}/{cycle-number}` loads a scheduled cycle detail using the existing washing schedule/ledger service. Only the record's existing module handles any edit. Listing responses intentionally exclude full remarks/evidence. The frontend uses the API, not combined/synthetic localStorage operational data.

The SQL query bounds issue occurrence, PM due and report date to the requested period; cycle status queries are restricted to months in the displayed period and the caller's permitted plants. Each source query has a server-side limit and the API supports pagination. `Load more` fetches additional events without resetting filters. The standard range remains 42 days at most for a month grid (42 including spillover days). Unknown filters do not gain unrestricted scopes.

## UI interaction

- **Sidebar**: Operations Calendar (also accessible in the mobile More navigation); hash route `/#/calendar`.
- **Month / Week / Day**: compact 7-column month and week views; grouped full-day event rows. Previous, next, Today, date-range presets, search and linked filters.
- **Compact events**: individual cards and `+N more` for densely populated cells, preserving all record identities; clicking a date opens an anchored daily summary (with per-type counts), while clicking a card opens an anchored record detail. Escape/close/outside click dismisses overlays without changing the current date/filter.
- **Detail data**: issue equipment/subpart, plant and site code, reporter/engineer/assignee, true status/severity, actual remarks/evidence when present; PM work order/unit/dates/observations/checklist; washing daily reports or scheduled cycles with their real workflow state.
- **Mobile / installed app (≤720px)**: no sideways scrolling. The month grid fits the screen and shows coloured status dots; tapping a day opens its summary as a bottom sheet (with scrim, grab handle and safe-area padding), and tapping an activity opens its detail sheet. The week view is a stacked agenda with one row per day. The popup closes only on a real width change, so the address bar hiding during scroll does not close it. Touch targets are 40px or more on touch screens. The PWA manifest has an "Operations Calendar" shortcut (`/#/calendar`).
- **Evidence**: retrieved only on user request, using the existing authenticated fetch, and shown inline in the popup (not in a new tab, which is unreliable in the installed app).
- **Theme**: uses the portal's brand green and follows light/dark mode (`prefers-color-scheme` and `data-theme`).

## Local setup / exact verification

The app's existing [README](../README.md) explains its Clerk + Supabase **staging** configuration. Do not use production secrets for local validation. No migrations are added.

```bash
python -m pip install -r requirements.txt
python -m pip install -r requirements-dev.txt
python scripts/preflight.py                # requires configured staging environment
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Open `http://127.0.0.1:8000/#/calendar` and sign in with a role-scoped **staging** user. Inspect a date with issue, PM and washing entries. Switch All Plants to a single plant, then back. Confirm counts, source IDs, colour changes on closing issues and confirming washing, scheduled cycles, `+N more`, filtering, browser back/forward and full-details navigation. Repeat as Site Engineer (must not see another plant), Assignee (must not see unassigned equipment), and Administration (must not see washing). Check the mobile viewport and event popup at the right/bottom edges.

Automated tests:

```bash
python -m pytest -q tests/test_operations_calendar.py tests/test_api.py
node --check frontend/static/js/50-operations-calendar.js
python -m pytest -q
```

Some existing integration tests use Playwright/Chromium or external URLs. Install the compatible browser where external access is allowed (`python -m playwright install chromium`), and run against a test environment that permits the required test requests. Separately run the repository's existing `python scripts/browser_smoke.py` when browser execution is available. A browser smoke check with simulated read-only data is **not** a substitute for staging tests against the real database.

## After review — Git and deployment

If using the **full source ZIP** supplied with this change, unpack into a *new* working directory and connect it to your own existing Git repository/history. If using the `.patch`, apply to a copy of the original repository (with Git history preserved):

```bash
git status --short
# From the existing Solar91-ONM Git repository:
git apply --check Solar91-ONM-Operations-Calendar.patch
git apply Solar91-ONM-Operations-Calendar.patch
python -m pytest -q tests/test_operations_calendar.py tests/test_api.py
git diff --check
git status --short
git add app/calendar app/main.py app/core/security.py frontend/static/js frontend/static/css/55-operations-calendar.css frontend/templates/index.html tests/test_operations_calendar.py tests/test_api.py docs/OPERATIONS_CALENDAR_IMPLEMENTATION.md README.md
git commit -m "Add permission-scoped O&M operations calendar"
git push origin HEAD
```

Deploy only **after** a human review, staging smoke test and confirmation of the configured Render service and branch. Follow `docs/RENDER_DEPLOYMENT_RUNBOOK.md` and `render.yaml`; there is no automatic deployment or credentials change in this work. Check `/health/ready` and the real user flow after staging deployment.

## Known verification limits

Local SQLite/API tests exercise seeded synthetic records. No live Supabase, Clerk authentication flow, object storage, Render deployment, or 100-concurrent-user load test was performed. Use the application's staging facilities and existing load-test harness before claiming production readiness. Browser smoke tests using synthetic data verify the interaction, not actual production record values. Full-suite environment-dependent failures must be investigated separately rather than suppressed.
