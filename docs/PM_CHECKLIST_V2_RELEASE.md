# Monthly PM checklist v2 — December 2026

## Scope

Source: all seven inspection sheets in `PM check sheet Updated.xls`, merged with the previous tracked monthly checklist catalogue. Equivalent workbook checks retain the old exact task string (the stable UUID5 key); the new workbook wording and the full Parameters to Check, Signs of Abnormalities and Corrective Actions columns are visible inside the expandable guidance. Distinct old checks remain; old visual vs functional alarm checks and measured earthing/IR checks are not conflated. No workbook guidance was invented for retained-only tasks.

| Group | Previous | Updated |
| --- | ---: | ---: |
| Inverter | 14 | 22 |
| ACCB | 18 | 28 |
| VCB | 11 | 22 |
| IDT Transformer | 17 | 28 |
| 4 Pole + ACDB + Aux. TX | 32 | 54 |
| GSS visit | 23 | 49 |
| Transmission line | 12 | 27 |
| Earth pit | 1 | 1 |
| Miscellaneous | 4 | 4 |
| Total | 132 | 235 |

Combined visit 54 = plant-side Four Pole 24 + existing ACDB 2 + Auxiliary Transformer 28. GSS 49 = GSS-side VCB/Kiosk 22 + switchyard 27. Same nine equipment keys, same calendar activities, no rule or date changes. Guidance is current reference material, not historic approved work instructions. Workbook limits, salt-water treatments, invasive tests and shutdown operations require site-specific engineering verification, OEM-approved procedures, authorisation and appropriate PTW/LOTO. Never assume that a generic checklist is permission to operate equipment or utility assets. Leave deferred work unsubmitted; use N/A only where truly inapplicable with justification.

## Install in a maintenance window

1. Back up Supabase and validate the release in a staging PostgreSQL database first. Stop application writers, including the recurrence job, and close existing open PM forms. Do not apply during field recording. Review the SQL and verify the deployed database includes the existing `pm_tracking_activities`, `site_photos`, `audit_logs` and recurring PM schema. Do not rerun historical SQL loaders.
2. Execute the separate `Solar91_PM_Checklists_v2_Safe_Upgrade.sql` in Supabase SQL Editor as an authorised database administrator. The transaction pins the **old** task list on empty Scheduled rows carrying PM photo evidence; it upgrades exact old task-only snapshots only when there are no signs of work, permissions, evidence, or PM audit history. It preserves the original entries (including stored IDs) wherever a task is retained. All other nonempty snapshots, recorded inspections and approvals remain unchanged. The final query reports the groups and snapshot counts. No new tables, roles, buckets or indexes are created permanently. Lock/statement timeouts cause failure rather than indefinite blocking. Roll back if an error occurs. The script was not executed against live PostgreSQL in this validation environment.
3. Overlay the changed-files archive onto the repository AFTER the cumulative 72-plant performance update, corrective Site Issues patch and String Breakdown test fix. Apply the SQL and code in the same maintenance window, then restart the updated application and refresh the PWA. Blank rows use the bundled catalogue automatically; all future generated activities use it too. We deliberately do not fill thousands of pristine activities with redundant JSON. SQL alone cannot upgrade the running Python defaults. No equipment rules, generated-month ledger entries, dates, PM approval statuses, existing results or photo storage objects are changed by SQL.
4. Open a December plant calendar, confirm the new checklist counts on untouched activities, verify older approved/returned/photo-bearing records remain pinned, verify one safe test submission on staging and the corrective ticket/notifications. Do not generate production test tickets. Test physical phone camera, concurrency and live Supabase performance before production approval.

## Architecture and data integrity

- `app/pmplan/checklist_templates.py` is the versioned bundled catalogue. Legacy strings are retained so UUID5 task/photo/issue IDs do not change. The nine group names and combined section prefixes remain exactly as before, preserving assignment rules.
- `GET /api/pm-plan/tracking/guidance/{equipment}` serves one equipment's static source guidance; role gated and fetched only on expansion. Cache and deduplicate one request per equipment per page session. No guidance in list responses.
- `compact=true` is opt-in on single-plant GETs. Empty rows share a `templates` dictionary rather than repeat descriptions. Historical snapshots retain their original checklist and full `checks` array. Old clients still get the previous response contract. No new SQL query is required.
- Six optional readings per checkpoint, with finite numeric value, supported unit, and optional context (phase, string, pit etc.). No automatic threshold judgement. Reading fields are stored in the existing JSON checklist, included in audit snapshots and in newly created corrective issue descriptions/source metadata where supplied. Existing older clients omitting readings cannot erase them. The result/justification/photo/approval rules are unchanged. New client submits item IDs to reject mismatched or stale checklist versions. The prior API length validation still applies.
- Evidence uploads pin the exact current task list when the first checkpoint photograph commits, using the existing plant/activity lock and the same transaction. Evidence is not re-uploaded or copied. Not OK / Abnormality still create at most one corrective issue per activity/checkpoint, with existing automatic routing and notifications. A repeat does not overwrite a prior corrective issue. Prior issue/approval history stays unchanged.
- Native collapsed disclosure panels and lazy-created measurement inputs avoid constructing hundreds of inputs on every form open. No new polling, external libraries, permanent schema migration or background job.

## Local verification

Synthetic single-plant fixture (16 inverter activities, one pinned original inspection): legacy full response 31,813 bytes, expanded uncompressed full response 41,263 bytes, compact v2 response 27,097 bytes; all use eight SQL statements. Compact v2 is 14.8% smaller than the legacy full response. GSS/combined guidance under 25 KB decoded per equipment; fetched only on expansion. Portfolio summaries exclude details and guidance. These are local SQLite and mocked browser tests, not production network timings. Real PostgreSQL SQL execution and physical phone testing remain outstanding.

### Git Bash (after applying changed files)

```bash
(
set -e
source .venv/Scripts/activate
python -m playwright install chromium
python -m compileall -q app tests
node --check assets/js/pm-tracking.js
python -m pytest tests/test_pm_checklist_v2.py tests/test_pm_tracking.py tests/test_pm_corrective_issues.py tests/test_pm_corrective_issues_ui.py tests/test_pm_navigation_and_register.py tests/test_pm_schedule_editor.py tests/test_photo_live_api.py tests/test_notification_centre.py tests/test_pm_scale_budget.py tests/test_portfolio_growth_budget.py tests/test_lazy_loading_and_payloads.py -q --tb=short
python -m pytest tests/ -q --tb=short
git status
git diff --check
git add -- app/pmplan/checklist_templates.py app/pmplan/tracking.py app/pmplan/issue_bridge.py app/photos/router.py assets/js/pm-tracking.js assets/css/pm-tracking.css tests/test_pm_tracking.py tests/test_photo_live_api.py tests/test_pm_checklist_v2.py docs/PM_CHECKLIST_TRACKING.md docs/PM_CHECKLIST_V2_RELEASE.md
git diff --cached --check
git diff --cached --stat
# Review staged files, then commit. Never stage .env or separate loader SQL.
)
```
