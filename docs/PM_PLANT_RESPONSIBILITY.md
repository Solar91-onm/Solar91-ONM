# PM plant responsibility

In Login Access, use **PM plants** on an active Assignee's row. Select the plants, review existing owners, confirm any transfer, and save. Clearing selected plants releases them. One active Assignee owns PM responsibility for a plant across all equipment; the O&M Head retains oversight. The existing plant responsibility table (migration 039) is reused. Existing schedules and work history are untouched.

Responsibility is not authorization: the recurring PM editor remains portfolio-wide for Assignees and O&M Heads, and approval stays with the O&M Head. Existing legacy cycle-plan edit permissions are unchanged. New site issues continue to use equipment responsibility. PM checklist notifications go to the O&M Head and the plant owner, or to the existing equipment recipient fallback if no active plant owner is set. Owners are displayed in the PM portfolio and plant header. The assignment is audited in one transaction; the new endpoint locks affected plant rows. No new SQL migration is required if 039 is installed. Verify PostgreSQL concurrency and the installed PWA on staging.

The included PDF regression correction verifies retention of full PDF evidence, not deletion. It does not alter the production upload or retention logic.
