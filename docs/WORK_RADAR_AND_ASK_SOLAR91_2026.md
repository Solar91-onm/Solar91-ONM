# Solar91 Work Radar + Ask Solar91 — 13 October 2026

## Intent

Add an immediately understandable, visually refined *interaction layer* over the existing backend and original operational modules. No modules were removed and no database schema migration was needed for this release.

## Daily Work Radar (Dashboard)

- Four selectable deadline cards: **Overdue**, **Due Today**, **Next 7 Days**, **Active Work**.
- Each selection instantly filters the worklist below; no entire dashboard rerender or reload on a click.
- Accessible work-type filters: **Site Issues**, **Preventive Maintenance**, **Panel Washing**.
- Equipment chips narrow the selected worklist (including for assigned equipment types across plants).
- Operational register supports local text search, record counts and **Open work** actions.
- An interactive three-category workload donut summarizes the *scoped, returned worklist*.
- Existing Site Engineer **Field Desk** can be expanded on demand, preserving field updates and the original data entry workflows.
- The backend supplies role-scoped issues, PM tasks and washing table due dates from actual PostgreSQL/SQLite models; never hardcoded counts.
- Washing maps to **solar panel tables / Modules cleaning**, not unrelated inverters. It is a table-level record, not a new equipment FK.
- The UI explicitly warns when the underlying worklist is bounded. The full module registers remain the authoritative source for entire historical datasets.
- Issue links open the **filtered Issues Register**, avoiding repeated modal rendering and allowing the usual issue workflow to be used from there.
- Preventive Maintenance links open the filtered PM module; Washing links open the matching plant's Washing Register.

## Ask Solar91

- Existing sidebar placement and appearance are retained, with a revised live-record, clickable-source experience.
- `/api/field/search` and `/api/field/ask` search **approved user scope** on the server. Results include only safe field metadata and direct access links; no raw file attachments, evidence, API credentials or activity notes are returned by search.
- Recent questions support contextual follow-up phrasing such as "and for inverters?".
- Every result can be opened in its supported register. The portal remains the place where changes are saved; assistant responses cannot close issues or alter user permissions.
- Default mode is **grounded read-only search**. It does not claim to be a general conversational AI model.
- Optional AI narration: set `AI_ASSISTANT_ENABLED=true` and a *private* `OPENAI_API_KEY` in Render's Environment section. Default `AI_ASSISTANT_MODEL=gpt-4.1-mini`. When enabled, short role-filtered metadata and the user's questions are sent to that provider; obtain appropriate business/data-processing approval first. No OpenAI API key is included. If the service is unreachable, the search fallback remains functional.
- Answers must stay grounded in returned records. The assistant cannot guarantee answering every possible open-ended question without relevant available records and a configured AI provider.

## Authorization

- O&M Head: approved portfolio worklist, assignment/closure through existing APIs.
- Assignee: assigned equipment types; washing only when **Modules cleaning** is an assigned type.
- Site Engineer: one assigned plant; field updates remain routed through existing protected endpoint.
- Administration: portfolio viewer; assistant cannot write.
- Unapproved Viewer role: field endpoints denied (403).

## Validation performed

- `python -m pytest -q`: **210 passed** (isolated SQLite).
- Node `--check` for edited frontend scripts and all JS files.
- `python scripts/browser_smoke.py`: **passed** using Chromium and the real FastAPI test server, including plant/equipment/ticket persistence, status changes, chart failure isolation, and no uncaught JS errors.
- A second isolated Chromium smoke run exercised Work Radar tiles, filters, PM drilldown, Field Desk toggle, Ask Solar91 live search and navigation to a filtered Issues Register, with no uncaught JS errors. Native localhost network navigation is restricted in this environment; the browser used the documented real-HTTP-API test transport fallback.
- No remote Render deployment, production Supabase PostgreSQL, Storage upload, or external AI request was executed. Those checks remain **unverified**.

## Deployment notes

- Use your own Render **private** `DATABASE_URL` (Supabase PostgreSQL Session Pooler DSN), `SUPABASE_SERVICE_ROLE_KEY`, and optional `OPENAI_API_KEY`; never commit them in the ZIP or repository.
- The supplied configuration had no complete `DATABASE_URL`, so production connectivity cannot be certified.
- Rotate the Supabase service-role key previously shared via a chat attachment before deploying.
- On Render, set `APP_ENV=production`, `APP_PUBLIC_URL`, `ALLOWED_ORIGINS`, `SUPABASE_URL`, the Clerk publishable key and verified private environment variables.
- Check `/health/ready`, log in by role in staging, and force a refresh after updating application files.
