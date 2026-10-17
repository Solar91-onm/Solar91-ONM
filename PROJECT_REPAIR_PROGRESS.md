# Solar91 O&M — Repair Progress Log

Resume point for the October 2026 handover repair. Update this file at the end of every batch.

## Phase 1 — Baseline (2026-10-17)

### Workspace identity
- Path `D:\Solar91-ONM`, branch `main`, HEAD `4dc0ac0` ("Harden request timing observability"), tracking `origin/main` (https://github.com/Solar91-onm/Solar91-ONM.git).
- Other local branches: `audit/solar91-full-portal`, `fix/solar91-clerk-auth-review`, `fix/solar91-login-update`. Not merged; not touched.
- No uploaded ZIP or second project copy was found in the workspace. The open workspace is treated as the latest source.
- **Pre-existing uncommitted work (preserved, not reverted):** 16 modified files plus untracked `scripts/benchmark_api_latency.py`. Content: batched equipment/plant lookups in `GET /api/scheduled/tasks`, single-query washing overview, Assignee scope without per-row queries, deferred team-pool load on first paint, opt-in browser latency sampler (`?s91_latency=1`), `Server-Timing` split into app/db/total, Render request-ID propagation. All baseline tests pass with this work in place.

### Architecture map (verified from source)
| Layer | Implementation |
|---|---|
| Backend | FastAPI 0.116 + SQLAlchemy 2.0, sync route handlers (threadpool), `app/main.py` entry |
| Database | Supabase PostgreSQL via psycopg 3 (Session Pooler, port 5432). SQLite only for tests |
| Auth | Clerk session JWT verified server-side (JWKS cached); Solar91 roles/scopes in `users` tables |
| Storage | Supabase Storage private bucket `scheduled-om-evidence`, service-role key server-only, downloads proxied by FastAPI |
| Frontend | Plain JS (40 files, ~1.2 MB) + CSS (20 files, ~240 KB) served from `/static`, single template `frontend/templates/index.html` |
| Deploy | Render web service, `runtime: docker`, `region: singapore`, `plan: free` in `render.yaml`; health check `/health/ready` |
| Roles | O&M Head, Assignee (equipment-type scope), Administration (read-only), Site Engineer (exactly one plant), Viewer (pending) |

Modules and their APIs: Plants/Equipment (`app/plants`), Site Issues (`app/issues`), PM + Washing (`app/scheduled`, `app/pmplan`), Field Desk / Ask Solar91 (`app/field`), Users/Invites (`app/users`), Notifications, Audit, Imports, SCADA adapter, legacy whole-state bootstrap/sync (`app/operations`, `app/core/legacy_state.py`).

Initialization: `GET /api/bootstrap` (full state) → render → team pool (`/api/users`, `/api/issues/assignees`) in parallel → washing overview on demand. Live refresh polls `/api/issues/pulse` every 30 s and pulls `/api/bootstrap?lite=1` only when the pulse changes.

### Baseline checks
| Check | Result |
|---|---|
| `pytest -q` (SQLite) | 321 passed, 156 s |
| `node --check` on 40 JS files | 0 failures |
| `scripts/browser_smoke.py` | PASS (8 checks) |
| `scripts/verify_command_experience.py` | PASS (desktop + mobile) |
| Route inventory vs. frontend `apiFetch` calls | 149 routes, 95 calls; no path/method mismatch |
| Local tooling | Python 3.12.10, Node 22, Playwright Chromium. No Docker, no PostgreSQL, no Render/Supabase access |

### Verified defects found in Phase 1 (evidence-backed)
| ID | Severity | Defect | Evidence |
|---|---|---|---|
| D1 | High | Business dates use server UTC (`date.today()`) and browser UTC (`toISOString().slice(0,10)`). Between 00:00–05:30 IST, washing reports default to the previous day; a correct IST date is rejected as "future". | `washing_cycles._build_overview` → `today` → `26-washing-cycles.js todayIso()` → POST `report_date` |
| D2 | High | Topbar "Operations date" picker writes the shared `opsDate` app setting. Any change freezes "today" (SLA/overdue maths) for every user until changed back. | `02-core…js:99` → `setOpsDate` → `persist()` → `/api/state/sync` → `AppSetting.opsDate` → every bootstrap |
| D3 | High | O&M Head marking a notification read duplicates every server-created notification (sync upserts by `legacy_id`, server rows have none). | Reproduced in isolated test: 1 row → 2 rows, both returned by bootstrap |
| D4 | Medium | Mobile bottom navigation hides Issues, Preventive and More for O&M Head/Assignee/Administration (label match includes badge digits; "Preventive"/"More" unmapped). | Live DOM probe at 390 px: 3 of 5 items `display:none` |
| D5 | Medium | Spreadsheet formula injection: openpyxl exports write user text starting with `=` as live formulas; client CSV exports do not neutralise `= + - @`. | `app/plants/router.py export_equipment`, `washing_import.export_bytes`, `csvCell`, `08…js:685`, `00…js:1293` |
| D6 | Medium | Storage download maps timeouts/5xx to 404 "not found", hiding outages as missing evidence. | `app/storage/service.py download()` |
| D7 | Medium | Static asset versions are hand-edited `?v=` strings; CSS is cached for 1 hour. A deploy that forgets to bump a version serves stale CSS. | `frontend/templates/index.html`, `security_headers` middleware |
| D8 | Low | No endpoint reports the deployed commit, so "is my change live?" cannot be answered from the browser. | No version endpoint in route inventory |
| D9 | Low | PM task logs and some timestamps use naive server-local `datetime.now()`; browsers interpret them as local time (5.5 h shift on display). | `app/scheduled/router.py` log entries |
| D10 | UX | Floating "Ask Solar91" button covers the last table rows/actions; phone topbar truncates page title. | Screenshots at 1440 px and 390 px |

### Infrastructure observations (not code defects; require owner decision)
- `render.yaml` declares `plan: free`. Render free web services sleep when idle and cold-start on the next request, and have limited CPU/RAM. If the live service really is on the free plan, the first request after idle will be slow regardless of code. **Unverified:** no Render dashboard access.
- One uvicorn process; sync handlers share the default 40-thread pool against a DB pool of 5+2. Under load, requests wait for connections (30 s pool timeout).
- Render (Singapore) ↔ Supabase (believed Mumbai): every DB round trip pays cross-region latency. Request cost scales with query count, which is now reported in `Server-Timing`.

## Plan and status
| Phase | Scope | Status |
|---|---|---|
| 1 | Baseline, inventory, architecture map | Done |
| 2 | D1 business date, D2 shared ops date, D3 notification duplication, D6 storage errors | In progress |
| 3 | Bootstrap/initial-load measurement and optimisation on a production-like fixture | Pending |
| 4 | D5 formula injection (server + client) | Pending |
| 5 | D4 mobile nav, D10 overlay/layout fixes, UI consistency pass | Pending |
| 6 | D7 asset fingerprinting, D8 version endpoint, deploy diagnostics | Pending |
| 7 | Regression tests for every fix; full suite; browser smoke | Pending |
| 8 | CHANGELOG, VERIFICATION_REPORT, DEPLOYMENT_RUNBOOK, PRODUCTION_READINESS_CHECKLIST, ZIP | Pending |

## Modified files
(updated per batch)

## Blockers
- No Render, GitHub-remote, or Supabase credentials in this session: deployment state, live latency, production schema/RLS, and storage objects cannot be verified.
- No PostgreSQL locally: query plans and pool behaviour are measured on SQLite only.
