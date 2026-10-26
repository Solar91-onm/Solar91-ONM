# Scale & operations notes (v4)

## What changed for scale
| Change | Why |
|---|---|
| Navigation (`goView`, `goTab`, `goScheduledOM`) no longer triggers a full-state server comparison | Every click used to JSON-compare all synced data (incl. the audit log) 250 ms later. |
| `34-live-refresh.js` | Every open tab polls `GET /api/issues/pulse` (one aggregate query) every 30 s; only on change does it re-fetch and update lists, with "Assigned to you / Ticket fixed / New ticket" notifications. Waits while the user is typing or a form is open. |
| `GET /api/issues/pulse` | Cheap change detector (count + latest `updated_at`), plant-scoped like the issue list. |
| Bootstrap audit trimmed | Audit rows no longer ship `before`/`after` copies; limit 1000 -> 500. |
| `00-loop-guard.js` | Rate-limits DOM observers and `render()`, and records the running step. If a tab ever freezes, the next load shows a red banner naming the step. |
| Null-safe rows + error card | One bad record can no longer blank a module or block navigation. |
| `render.yaml` | `plan: starter` (free tier sleeps and has 512 MB), DB pool 15 + 10 overflow. |

## Settings (Render environment)
* `BOOTSTRAP_CLOSED_ISSUE_DAYS` (default `0` = send everything). When total issues exceed ~20,000 set it to `365`:
  tickets closed longer ago are not sent to browsers (still in the database and `/api/issues`).
* `BOOTSTRAP_PM_HISTORY_DAYS` (default `180`, `0` = send everything as before October 2026). Finished (Completed /
  Cancelled) PM work orders older than this are not sent at sign-in or by `GET /api/scheduled/tasks`; open work always
  is. `GET /api/scheduled/tasks?history=all` returns everything and the compliance export uses it. On-screen counts of
  finished work (PM report, Completed tile) say "since <date>". See `app/scheduled/history.py`.
* `DB_POOL_SIZE` / `DB_MAX_OVERFLOW`: keep (pool + overflow) below your Supabase pooler connection limit.
* Run ONE web instance / ONE uvicorn worker: startup migrations run in the background and would race with several workers.

## Measured (headless Chrome, synthetic data, 40 plants, 85% closed tickets, 500 audit rows)
| Issues | JSON | gzip | page load | dashboard | issues list | plants | PM |
|---|---|---|---|---|---|---|---|
| 152 | 0.5 MB | 0.02 MB | 0.5 s | 22 ms | 38 ms | 31 ms | 46 ms |
| 2,000 | 2.4 MB | 0.08 MB | 0.6 s | 62 ms | 67 ms | 74 ms | 145 ms |
| 10,000 | 9.3 MB | 0.29 MB | 1.4 s | 151 ms | 297 ms | 273 ms | 452 ms |
| 30,000 | 22 MB | 0.73 MB | 2.1 s | 299 ms | 326 ms | 326 ms | 477 ms |
Phones are typically 3-6x slower than this desktop run. Real text compresses worse than synthetic text.

## Not verified / known limits
* Backend was only syntax-checked in the build environment (no network to install FastAPI/SQLAlchemy): run `pytest` in CI before relying on it
  (new tests: `tests/test_issues_pulse.py`).
* No load test of the real server. `load_state()` rebuilds the full state per login and per live refresh; a refresh happens only when something changed (at most every 15 s per tab).
  If many tickets change per minute, add server-side caching or a partial-sync endpoint next.
* Notifications are in-app toasts plus browser notifications while a tab is open (not WhatsApp/SMS/push to a closed phone).
* No offline mode: the service worker caches nothing.
