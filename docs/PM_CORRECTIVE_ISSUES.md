# PM checklist → corrective Site Issues

> Once a corrective ticket exists, its Assignee records what they did in the Edit drawer's
> **Action log** (`docs/ISSUE_ACTION_LOG.md`).

Site issues are **not** created by submitting a checklist. The plant's PM Assignee reviews the
submitted record and raises the findings they confirm, in one go.

## Flow

1. **Submit.** A check is `OK`, `Not OK` or `N/A`; `Abnormality` was retired and is no longer offered. Non-OK checks still require an observation. A valid **Submit for approval** creates no ticket and performs no routing lookup. Existing date, plant scope, sequence and observation validation stay in place. Site Engineers and Assignees submit eligible work; only O&M Heads approve or return.
2. **Notify.** The existing post-commit PM submission notification goes to its existing recipients (the plant's PM Assignee, equipment fallback if none, and O&M Heads). When the checklist has Not OK findings, its title becomes `PM checklist submitted · N Not OK to review` and the message asks the reader to open the record. The payload is the existing `pm_activity` link, so the bell opens the activity itself.
3. **Review and raise.** On the activity record, the reviewer sees a **Raise site issues** panel listing every Not OK finding not yet raised, each ticked by default with its observation. Unticking leaves a finding alone; it can be raised later. One button raises one site issue per ticked finding. A finding already raised shows its ticket number as a chip that opens the ticket in Health.

## Authorisation and state

* `POST /api/pm-plan/tracking/{activity_id}/raise-issues` with `{"item_ids": [...]}`. Only the plant's PM Assignee (`plant_responsibilities.area='pm'`) or an O&M Head; everyone else gets 403, and the control is not rendered for them. The usual plant scope applies.
* Allowed only while the activity is `Pending approval` or `Approved` (409 otherwise), so a checklist returned for correction is not raised mid-rework. Item IDs must belong to that checklist's Not OK findings (422 otherwise).
* `GET /api/pm-plan/tracking` returns `can_raise_issues` and `raised_issues` ({item id: ticket no}) per activity, from one bounded lookup over the listed rows; `summary=true` responses skip it.
* Results recorded as `Abnormality` before the option was retired remain raisable.

## The ticket

* Stores the plant, equipment and unit ID, checklist wording, result, observation, inspection date and the engineer who recorded it (`Found by`, plus `submitted_by`/`submitted_name` in `pm_source`). Combined PM sections route using explicit equipment headings; GSS uses the existing GSS responsibility aliases. Ordinary checks route by the PM equipment. The active work category name is used where it matches. No category is silently added to the master.
* Existing Site Issue routing hierarchy (plant + equipment, plant-wide, global equipment, default, with eligible backups) applies. If nobody is configured, the ticket is Open and unassigned and active O&M Heads are notified. A PM finding is not proof of downtime: severity defaults to Medium and `equipment_running` stays unknown. The normal default issue deadline applies. The Head may correct the ticket using existing Edit. `created_by` is the reviewer who raised it.
* `issues.source_task` contains `PM:<activity UUID>:<checklist item UUID>`, and `legacy_payload.pm_source` preserves the original observation and source. The Site Issue table and drawer show a From Preventive Maintenance label. PM photo evidence remains in the originating checklist; no duplicate Storage objects are created.
* Deterministic ticket IDs (UUID5 of activity + checklist item) and the shared advisory lock prevent duplicates, including on return/resubmission, after an issue has been archived or closed, on a double click, or when a second reviewer raises the same finding: the existing ticket is returned with `created: false`. Changed observations stay on the PM checklist; existing tickets are not overwritten or reopened. No historical PM backfill.
* The raise, its issue audit history, its notifications and one `PM tracking: raise site issues` audit entry commit together; an error rolls back the batch. Notification recipients are the assigned owner and O&M Heads. After a successful raise the site-issue register and dashboards refetch on their next view.

## Deploy / test

No migration; source metadata uses existing columns. Submission no longer touches the corrective bridge or the ticket-number lock at all.

Run `python -m pytest tests/test_pm_corrective_issues.py tests/test_pm_checklist_v2.py tests/test_pm_tracking.py tests/test_pm_navigation_and_register.py tests/test_site_issue_routing.py tests/test_site_issue_routing_budget.py tests/test_notification_centre.py tests/test_notification_alert_ui.py tests/test_photo_live_api.py tests/test_portfolio_growth_budget.py -q --tb=short`.

Confirm on staging PostgreSQL: submit a checklist with Not OK findings and verify no ticket exists; check the PM Assignee's notification wording and that its link opens the record; raise a subset and verify owner, routing, notifications and register badge; re-raise and confirm the same tickets; verify a Site Engineer and an unrelated Assignee cannot raise; return and resubmit; test simultaneous raises, existing photo links and rollback. No production database or physical phone was tested here. Full production acceptance remains separate.
