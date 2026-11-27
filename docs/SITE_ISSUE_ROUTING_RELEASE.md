# Site Issue routing release

Baseline: user-supplied `Solar91-ONM.zip` (already includes the earlier PM plant responsibility, portfolio PM editor, mobile UI and PDF preservation changes). This is an overlay, not a replacement project. No change to PM approvals, schedules, photo retention or the existing authentication roles.

## Database

Run the separately supplied `Add_9_Site_Issue_Categories.sql` in Supabase SQL Editor. The schema was checked against the supplied CSV; the script only inserts missing `work_categories` rows and validates all nine are active before commit. The exported master contained 25 categories; expected 34 if unchanged. The new problem names, equipment codes and area classifications are suggested operational defaults. Existing names are preserved; conflicting reused codes and inactive matching names abort the transaction. Do not stage the SQL loader in Git. The script was not executed against live PostgreSQL.

No new schema migration is needed for routing. The existing `app_settings` table stores the rule map under `site_issue_routing_v1`. The existing `equipment_responsibilities` table remains the portfolio equipment authority. The three previously supported equipment concepts use the existing canonical keys (`module`, `mms`, `washing`) and now display the supplied names. The other six use the pre-existing dynamic `cat_` key naming convention. The new SQL marks added categories as reporting-only; the legacy PM setup picker excludes them unless PM parts are deliberately configured. Existing permanent recurring PM equipment and rules are unaffected.

## Configuration

Login Access → Equipment responsibility → Site issue plant exceptions and default.

1. Configure portfolio equipment primary and backup owners in the existing matrix.
2. Configure exceptions for one or multiple selected plants, either one equipment category or all equipment. Batch updates require confirmation. The rule is specific to Site Issues and does not grant any additional permissions.
3. Configure the portfolio default primary and backup for unmatched issues. This is important if all new site issues must receive an Assignee automatically.
4. If desired, select “Also assign matching open, unassigned issues”. Only open tickets without either an assigned user or a legacy assignee name will be backfilled. Already assigned and closed tickets stay unchanged. The existing global equipment save retains its established automatic backfill behavior, now using the same priority resolver.

Routing precedence is plant+equipment primary/backup → plant-wide primary/backup → portfolio equipment primary/backup → default primary/backup. Each tier chooses an active user whose role is Assignee. If no eligible rule exists, the existing reporting-Assignee fallback or unassigned escalation to O&M Head remains in place. Existing explicit assignment authorization is unchanged. Backup activation follows account active status and eligibility; there is no temporary-leave schedule or SLA-driven reassignment in this release. The current owner of an existing ticket is not changed automatically by an account status change.

Settings are authorized server-side (`users.manage`, O&M Head) and CSRF guarded. The existing ticket advisory transaction lock serializes configuration and issue creation on PostgreSQL. Assignment and audit history are written in the ticket transaction. Rule changes are stored in the existing audit log and shown in Change history. The resolver queries only relevant rule entries for each new ticket (no stale process cache), and uses one owner snapshot for bulk routing. The rule document is bounded to 2,000 entries.

## Validation performed

- 63 backend tests passed: site issue routing, equipment responsibility, categories, PM/health scope, issue workflow, GET sweep.
- 149 frontend/navigation tests passed: portal frontend and PM navigation/register.
- JavaScript syntax validation: settings, site issues, operations calendar.
- Python compilation of changed modules.
- Chromium 390px mocked API smoke: save selected plants, select backup, optional backfill, remove rule, configure portfolio default, no field-grid horizontal overflow, no page errors.
- SQL schema inspected from Supabase export. PostgreSQL JSON query compiled using SQLAlchemy PostgreSQL dialect; live PostgreSQL execution, concurrent writer behavior, real browser authentication and mobile device testing remain unverified. A first combined frontend/PM/PDF run timed out after one observed failure; the subsequent full frontend/navigation rerun passed all 149 tests. The PDF test was not separately completed in that run; its files are unchanged by this overlay.

## Local verification and Git

From the project root, Git Bash:

```bash
source .venv/Scripts/activate
python -m pytest tests/test_site_issue_routing.py tests/test_equipment_responsibility.py tests/test_work_categories.py tests/test_scope_and_liasoning.py tests/test_issue_workflow_rules.py tests/test_zz_sweep.py tests/test_portal_frontend.py tests/test_pm_navigation_and_register.py -q --tb=short
node --check assets/js/settings.js
node --check assets/js/site-issues.js
node --check assets/js/operations-calendar.js
python -m pytest tests/ -q --tb=short
```

Only proceed to commit after the tests pass and staging is verified. Do not use `git add .`. See final response for explicit changed-file list. Production deployment remains conditional on live PostgreSQL and authenticated browser verification.

## Performance follow-up (supersedes the original routing overlay)

The manager matrix initially calls `/api/equipment-responsibilities?include_routing=false`.
Plant rules and plant labels load only after opening the dedicated editor, from the manager-only
GET `/api/equipment-responsibilities/issue-routing`; refresh and reopen read current rules.
The original GET without a query parameter keeps its response contract for existing clients.
The ticket resolver combines global and scoped eligible-owner lookup into one query after
its targeted JSON lookup; no stale ownership cache, no new polling or schema migration.
The existing assignment precedence, audit and authorization remain unchanged.

Synthetic local SQLite TestClient fixture: 42 plants, 34 category labels (33 canonical keys),
200 issues, 556 PM activities, 1,386 plant/equipment rules. Seven warm request timings per API,
18 warm timings for the resolver; sizes are decoded JSON bytes, not wire bytes or Supabase egress.
Original project / original routing overlay / optimized overlay:

| Path | SQL count before / overlay / optimized | Bytes before / overlay / optimized | Median ms before / overlay / optimized |
|---|---|---|---|
| Issues list | 1 / 1 / 1 | 33373 / 33373 / 33371 | 4.37 / 4.59 / 4.58 |
| Plant list | 1 / 1 / 1 | 23196 / 23196 / 23196 | 8.14 / 7.27 / 7.56 |
| Dashboard version check | 2 / 2 / 2 | 92 / 92 / 92 | 5.32 / 5.64 / 4.72 |
| Monthly PM summary | 7 / 7 / 7 | 190270 / 190270 / 190270 | 36.41 / 38.78 / 29.00 |
| Initial responsibility matrix | 4 / 5 / 3 | 7186 / 246398 / 7011 | 4.86 / 15.44 / 4.06 |
| Assignment resolver | 1 / 3 / 2 | n/a | 0.307 / 1.331 / 1.166 |

The matrix's deferred rules endpoint measured 2 queries, 239388 decoded bytes, 11.20 ms.
Its request occurs only on explicit open/refresh; the full document is still fetched by the
administrator then. No claim that the entire portal is faster or that production latency is
unchanged: timings are small local samples, not a network or concurrency load test. The
old resolver did not support overrides and backups; one additional query is intentional.
The 2-byte list difference is generated fixture serialization variation. Query/size guards
are in `tests/test_site_issue_routing_budget.py` (1,428 distinct rules); no timing assertions.
28 focused routing, authorization, sweep and PM scale tests passed (7.47s), and 4 selected
frontend tests passed (0.74s). The 390px mocked Chromium workflow passed including zero
rule reads on initial settings render and exactly one on opening the editor. Python compile
and settings JS syntax passed. Live PostgreSQL execution/plans, physical phone testing and
full-suite execution after this optimization remain pending. If the nine categories are
already installed, do not run the SQL loader again.
