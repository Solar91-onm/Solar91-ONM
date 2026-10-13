# Solar91 O&M Portal — stabilization record (13 October 2026)

## What was changed in this release

- **Freeze/diagnostic fix:** Replaced the global, per-render-subfunction cookie tracer and DOM MutationObserver monkey-patch with a lightweight render re-entrancy/rate guard and opt-in diagnostics (`s91Diagnose()`). No persistent `START renderIssues` cookie or red stale-freeze banner is displayed. Uncaught errors are still recorded to the developer console.
- **Issue trend date defense:** Added strict calendar-day validation (including leap-year checks), bounded the chart dataset to **366 days**, rejected nonsensical/partially entered filters, and avoided sorting every issue date on each render.
- **Issues isolation:** An exception while constructing the trend chart shows an actionable chart error but **does not prevent the issue table from rendering**.
- **Networking:** Frontend API requests now have explicit timeouts, a bounded retry for reads, a clear failure state, and **no automatic retry of writes** (to prevent duplicate requests when the server may have committed).
- **Interface clarity:** Removed an outdated hardcoded minimum operations date and inaccurate “demo” label.
- **Automated regression:** Added executable Node tests for extreme date ranges, malformed dates, leap years and open-backlog calculations; added static-asset validation and an isolated browser/HTTP/SQLite smoke harness.
- **Deployment footprint:** Retained the working FastAPI, Supabase Auth, PostgreSQL and Render architecture and 28 existing SQL migration files. No production schema or hosted records were modified.

## Rendering problem: what is known

The earlier freeze notes in `CHANGELOG_FREEZE_FIX_2026-10-13.md` identify a partially typed year such as `0002-10-12`. The original trend builder generated hundreds of thousands of days and plotted enormous SVG output, hanging the browser. The supplied code already contained a preliminary range cap. This release tightens validation, guarantees an explicit 366-row upper bound, and adds automated regression and isolated chart fallback checks.

The visible red marker was emitted by `00-loop-guard.js`, which wrote markers such as `START renderIssues` to a cookie and then treated the previous marker as evidence of a freeze on the next navigation. That mechanism was **diagnostic, not a business record**, and could display misleading or stale information even after recovery. This release removes that banner and the cookie marker mechanism rather than hiding it with CSS.

## Validation carried out locally

- All existing backend/API tests plus new frontend and asset regression tests run against an **isolated SQLite test database** with a synthetic authenticated user. Test overrides never run in production.
- Every JavaScript file was checked with Node `--check`; Python source was compiled.
- FastAPI was launched as an actual `uvicorn` process and `/health/ready` checked.
- Playwright/Chromium executed the real browser JavaScript. It created/edited a plant, created equipment, created an issue via the 3-step form, refreshed and verified the records persisted, assigned the issue, acknowledged it, started work, recorded progress, and directly closed it with an explicit reason. Issue rendering, invalid dates, chart failure isolation and uncaught-error detection were checked.
- **Browser environment limitation:** This execution environment's managed Chromium blocks local HTTP navigation. The browser runner therefore fell back to loading the exact frontend source scripts and CSS into `about:blank` and relaying API `fetch` requests to a real local FastAPI test server. It did **not** verify native browser loading of HTTP assets, service-worker installation, redirects, or live Supabase sign-in. The runner attempts ordinary HTTP navigation first on an unrestricted machine.

## Not certified / external dependencies

- Real Supabase Auth user sign-in, JWT validation against live keys, authorization setup for actual users.
- Live PostgreSQL/Supabase connectivity, migration application, RLS rules and private Storage evidence uploads.
- Render deployment, live TLS/domain/auth redirects, notification delivery, SCADA integration, or actual production persistence.
- Every workflow in preventive maintenance, washing, handover, inventory, reports and administration. Their existing code and tests were retained, but they were **not all manually verified in the browser** as part of this stabilization pass.
- Normal resolution workflow requires uploaded fix-photo evidence and was already covered by backend tests; the browser smoke test uses O&M Head's documented direct-close-with-reason branch without simulating a fake photo.

**Modules intentionally removed:** None. Core backend routes and existing optional modules remain. Inherited JS contains several layers of UI enhancement wrappers; they were not comprehensively rewritten because doing so would jeopardize currently passing operational workflows.

## Safety and deployment

No existing hosted data, credentials, databases or migrations were altered by the local verification. Use a **staging** Supabase project and review/backup the schema before applying migrations. `scripts/migrate.py` runs historical SQL files indiscriminately and is not an appropriate first-time command against a populated production database. The browser test server is guarded by `SOLAR91_E2E_TEST_MODE=1` and requires a SQLite URL. It must never be deployed as a production entry point.
