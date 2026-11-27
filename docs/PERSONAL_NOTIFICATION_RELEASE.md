# Personal notifications and incoming task alerts

Apply these changed files on top of the Issue Edit / My Issues update and previous Site Issue routing patches. No SQL migration. Keep the existing notifications indexes (including migration 054) and existing authentication and CSRF checks.

## Routing

- Site Issues: the current assigned user receives new ticket and workflow updates; unassigned tickets go to the O&M Head rather than unrelated plant Assignees. Spreadsheet uploads follow the same rule. Explicit reporting participants and management oversight remain supported. Non-critical auto-assigned tickets send one assignment notification to the owner rather than a second creation notification.
- PM: explicit plant PM owner takes priority; the existing equipment responsibility fallback remains if no active plant owner is configured. Submit, approval/return, sequence request and permission decision alerts reach the relevant owner and explicit participants. Approval permissions are unchanged.
- Module Cleaning: only the configured active washing Assignee (`washing_config.assigned_user_id`) receives Assignee notifications for that plant. The O&M Head and explicit field reporters retain their existing oversight/report updates. An unconfigured or inactive owner does not cause a broadcast to other Assignees. Future alerts follow the new owner after a transfer.
- Assignee inbox and unread badge are recipient-only; portal-wide broadcast rows are excluded. Action Required counts only assigned active issues and relevant PM. Previously delivered personal notifications remain historical records; they are not retroactively deleted or re-routed.

## UI and performance

- Top-right alert cards, a ringing bell animation, clear category/action label, direct View details and dismiss controls. Optional sound is enabled by clicking Enable sound in the notification panel (browser autoplay policy requires user interaction). No audio files or third-party service.
- Normal-priority personal alerts now pop up for Assignees. Each notification ID is announced once per tab/session; unread history remains in the bell. Up to five recent unread items are previewed at a time. Dismiss is not mark-read. Viewing marks read but never resolves work.
- Reuse the existing visibility-aware 60-second summary poll (three minutes on slow connections/data saver), with existing failure backoff. No new interval or external service. A bounded preview is included in that same request; one additional limited database read when unread notifications exist, no preview query when count is zero. More than five unread items remain available in the notification panel.
- Issue links use the scoped exact-ticket endpoint rather than downloading the latest 200 open inverter issues. The existing register and owner filter remain unchanged.
- In-app alerts only: closed/background PWA OS push notifications and guaranteed delivery across sleeping server instances are not implemented. Existing notification write-failure handling and operational history are preserved. No historical notification records are deleted.

## Validation

Focused backend run: 95 passed (notification centre, equipment responsibility, washing cycles and issue workflow). Subsequent 14-test run (issue editor browser, routing, query-budget and notification popup) passed. Final targeted notification centre, popup and issue import run: 20 passed. Tests overlap; do not sum them. Browser popup initially overflowed at 390 and 1600 px; corrected box sizing and both browser tests passed. Broader run timed out before completion; full suite, live PostgreSQL, real device audio and live network latency remain deployment checks.
