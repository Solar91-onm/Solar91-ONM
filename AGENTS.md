# Solar91 O&M engineering instructions

Apply these instructions together with the specific task. Use the existing code, tests, and documentation as the authority for current behavior; do not invent roles, fields, metrics, or workflows.

## Product and architecture

- Solar91 is an operations portal for solar plant O&M. Preserve established modules, terminology, record relationships, permissions, and status transitions. Relevant workflows include plant records, issues, scheduled maintenance, washing, evidence, assignments, confirmations, notifications, and reporting where implemented.
- The database is authoritative. The application uses FastAPI, PostgreSQL/Supabase, and a plain JavaScript/CSS frontend served by FastAPI. Preserve the existing Render and Supabase deployment model unless a verified issue requires a documented change.
- Read the relevant module documentation and implementation before changing behavior. Keep investigations and changes scoped to the task; add infrastructure only when evidence justifies it.

## Priorities

In order, prioritize: (1) data safety and security, (2) correct persisted business behavior, (3) working APIs and user workflows, (4) reliable concurrent operations and evidence handling, (5) consistent views and summaries, (6) performance as data grows, (7) efficient operational UX, and (8) visual polish and grounded AI assistance. Avoid complexity without a clear reliability, performance, or usability benefit.

## Before and during changes

- Inspect relevant code, callers, permissions, persistence, and affected views. Check `git status` first and preserve all existing user changes.
- Make the smallest safe change that fixes the underlying issue. For meaningful changes, establish relevant checks, run them when requested and permitted, inspect the final diff, and report any failures or verification limits honestly.
- A successful edit must persist to the correct record and appear in affected views after refresh. A failure must be visible and must not be reported as success. Prevent duplicate submissions, stale overwrites, incorrect relationships, and unauthorized updates.
- Keep loading, saving, success, failure, and empty states clear. Preserve useful search, filters, clear controls, navigation, role-specific editing, and evidence galleries. Remove a workflow or data display only after confirming it is unnecessary.

## Data, security, and production safety

- Never expose credentials, private evidence, or service-role keys. Preserve authentication, authorization, and row-level security.
- Never delete or recreate production data, run destructive SQL/migrations, drop tables or buckets, or run load tests against production. Review current schema and back up staging before applying only approved missing migrations in order.
- Do not push, deploy, or perform irreversible external actions without explicit authorization. Do not remove migrations, security helpers, tests, or configuration merely because they appear unused.
- Protect user changes. Never use destructive reset or cleanup commands to force a clean working tree.

## Performance and scale

- Avoid unbounded table reads, oversized responses, repeated queries or API requests, and unnecessary frontend rendering. Use appropriate filtering, pagination, timeouts, connection management, and targeted refreshes.
- Do not add Redis, queues, databases, or paid services automatically. Treat 100 concurrent users as a load-testing target, not a claim established by code inspection. Validate with realistic, isolated tests and document what was and was not measured.

## Ask Solar91

- Ground operational answers in current, role-authorized data. Follow the existing assistant contract and documentation; present direct answers with useful supporting records and links when available.
- Keep the assistant read-only unless an explicitly authorized workflow exists. Do not claim an operation succeeded based on model output; verify persistence.
- Enforce the established ten-day chat-history retention in backend retrieval and cleanup. Never apply chat retention to O&M records, evidence, or audit history.

## Verification and reporting

- Use checks appropriate to the touched behavior: focused tests, API checks, frontend syntax/build checks, or isolated integration/browser checks. For broad changes, cover adjacent workflows as well. Do not claim live-service, production-data, or concurrency verification unless actually performed.
- Report what was implemented and tested, what was implemented but not verified against live services, recommended work left unimplemented, and material failures or assumptions. State manual configuration and remaining risks when relevant.

Keep this file concise and actionable. Put detailed, module-specific procedures in the existing documentation rather than duplicating large prompts here.
