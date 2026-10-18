# Database performance and Supabase access audit

## Scope and evidence limits

This review traced the SQLAlchemy query call sites, current ORM models, and checked-in SQL migrations. It did not connect to a Supabase project or inspect production catalog state, query plans, traffic, timings, row counts, or the project's connection quota. No performance gain beyond the measured test query count is claimed.

## Changes made

- Equipment list/page, bulk-create, import, and export serialization now batch-load in-charge users and active equipment-type owners instead of issuing those lookups once per returned equipment row. Export plant names are also loaded in one query rather than per row.
- The equipment-page regression test asserts that a three-row page uses four SELECT statements (equipment, assigned users, type owners, and total count). This measures round trips in SQLite tests, not production elapsed time.
- PM task completion now locks the task row with `SELECT ... FOR UPDATE` on PostgreSQL before checking/updating completion and generating a recurrence. Repeated completion still returns HTTP 409.

## Remaining findings

| Area | Evidence | Risk / follow-up |
| --- | --- | --- |
| Legacy bootstrap/dashboard | `load_state()` loads all plants, equipment, active issues, handovers and their items, tasks, washing tables and history before applying role scoping. Closed-issue retention can be configured, but the other collections have no server-side page boundaries. | Cost and response size grow with retained data. Changing the existing snapshot response risks breaking clients. Consider a versioned, paginated/summary API and migrate dashboard consumers before changing this contract. |
| Scheduled O&M list | `GET /api/scheduled/tasks` reads every `OMTask`, filters visibility in Python, then serializes each row. Serialization and authorization can perform per-task plant, equipment, quantity, and scope lookups. Latest follow-ups are already fetched as a batch. | Full-table transfer and N+1 behavior are possible, especially for scoped roles and legacy tasks without stored quantity. A safe optimization needs role-equivalent SQL filtering and preserved full-list client behavior or an explicitly migrated paginated client. |
| Equipment detail | `GET /api/equipment/{id}/detail` reads every task and active issue for the equipment's plant and filters by equipment reference in Python. It returns up to 100 rows but computes issue metrics over the full matching set. | Large plants can cause unnecessary row transfer. Pushing exact reference matching down is straightforward for displayed maintenance rows; issue metrics need a semantics-preserving aggregate or batched summary to avoid undercounting. |
| Washing overview | `get_overview()` loads all reports for all visible configured plants and then calculates monthly/cycle outputs. | Historical report volume can dominate dashboard reads. The report-date indexes exist in checked-in migrations, but live usage and plans are unknown; trimming history could alter returned report history. |
| Completion recurrence | The recurrence code checks for an existing open task, then inserts if absent. Locking the completed source task prevents two requests completing that same task simultaneously. | Different source tasks with the same plant/task/date/unit recurrence key are not serialized against each other. A database uniqueness strategy would need a duplicate-data preflight and contract review before proposing a constraint; none is added here. |
| Equipment search | Several register filters use `lower(...)` and leading-wildcard `LIKE`; ordinary B-tree indexes generally do not accelerate leading-wildcard searches, and a plain-column index may not serve a lower-expression predicate. | Do not add functional or trigram indexes without staging query plans, extension availability, and measured benefit. |
| Supabase connections | PostgreSQL uses a SQLAlchemy pool with `pool_size=5`, `max_overflow=2`, pre-ping, and a 300-second recycle. The code includes transaction-pooler prepared-statement compatibility; deployment docs recommend the Supabase Session Pooler. | The theoretical app-side ceiling is 7 checked-out connections per process, multiplied by all web instances/processes. Compare that sum (plus migration/admin clients) with the actual Supabase pooler/database quota before scaling. No live quota was available. |
| Supabase Storage | Upload, download, and removal each create a new synchronous `httpx.Client`. | This forgoes connection reuse across operations. A shared client requires application lifespan/close handling and concurrent-use validation; no network measurements justified that lifecycle change in this pass. |

## Indexes and constraints reviewed

Checked-in migrations include indexes for common plant/status/due filters, active issue creation ordering, equipment plant/type and warranty/in-charge lookups, issue history, PM cycle/follow-up lookups, and washing report plant/date queries. These files establish repository intent only; they do not establish that production has run every migration.

No SQL migration is proposed. The missing evidence is the live schema and measured plans; adding another speculative index could duplicate an existing index, increase write/storage costs, or create avoidable locking/load. In particular, do not infer that an index exists merely because an `IF NOT EXISTS` statement appears in a repository migration.

To verify current public-schema indexes and constraints in Supabase SQL Editor:

```sql
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'plants', 'equipment', 'issues', 'om_tasks',
    'pm_followups', 'washing_daily_reports'
  )
ORDER BY tablename, indexname;

SELECT tbl.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint AS con
JOIN pg_class AS tbl ON tbl.oid = con.conrelid
JOIN pg_namespace AS ns ON ns.oid = tbl.relnamespace
WHERE ns.nspname = 'public'
  AND tbl.relname IN (
    'plants', 'equipment', 'issues', 'om_tasks',
    'pm_followups', 'washing_daily_reports'
  )
ORDER BY table_name, conname;
```

For candidate query changes, capture `EXPLAIN (FORMAT JSON)` on staging with representative filters and data. Use `EXPLAIN (ANALYZE, BUFFERS)` only where executing the query and its load are acceptable; neither plan form was run for this audit.

## Concurrency and transaction notes

- Issue edits already use row locking; washing configuration/review paths use `FOR UPDATE`; collection revision sync locks rows and rejects stale revisions.
- The PM completion path now locks its source task before mutation. This is a PostgreSQL row lock; SQLite does not provide equivalent behavior in the unit tests.
- No data cleanup, index creation, or production SQL execution was performed.
