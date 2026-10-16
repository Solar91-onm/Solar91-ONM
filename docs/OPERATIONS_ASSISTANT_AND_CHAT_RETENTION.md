# Ask Solar91: operational answers and chat retention

## Implemented

- Common operational questions for open/overdue issues, issue status breakdowns for this/last week, overdue/open PM work, current-user assignments, washing reports awaiting review, and washing table counts by plant and date use direct database queries.
- These queries apply authenticated plant and equipment scope on the server. Result counts come from database counts/sums; the accompanying record list is bounded to 20 (30 for a washing date) and says when more records exist.
- Washing answers distinguish confirmed tables from reports still pending review. Administration users and Assignees without the washing equipment scope do not receive washing data through Ask Solar91.
- Other record searches remain bounded to 500 records per module. The response marks truncation and describes results as partial so the bounded total is not presented as exhaustive.
- The assistant shows its answer, a compact summary/breakdown, the source date/scope, and supporting records. Suggested questions vary by role. A failed live retrieval reports failure and does not fall back to stale browser state.
- Conversation entries are stored only in the signed-in browser profile, under a user-specific local-storage key. They are pruned on assistant initialization, before display, and on every save using a rolling ten-day UTC-millisecond window. Expired assistant entries are removed from the local store; operational records and audit history are untouched.
- The API does not persist chat messages or maintain server-side conversation history. The optional OpenAI Responses request continues to use `store: false`; prior questions are not included in its model context. Writes are not performed by the assistant.

## Role and workflow behavior

- Ask Solar91 remains read-only. Its record links route into existing issue, preventive-maintenance, washing, plant, and equipment views; existing workflow APIs continue to enforce write permissions and state transitions.
- The assistant does not initiate assignment, issue closure, or washing confirmation.
- Existing role-specific workflow APIs and overlay regression tests remain the authority for editing and confirmation behavior; this change did not replace those forms or workflows.

## Limits and configuration

- The ten-day retention rule applies to this application's local conversation store. There is no database-backed chat-history table, so no database cleanup job or migration is required. Provider-side retention outside the application's `store: false` request setting was not independently verified.
- `AI_ASSISTANT_ENABLED=true` and `OPENAI_API_KEY` enable optional model narration. Without those settings, supported questions use deterministic query answers and other requests use bounded live search. Live provider behavior was not tested here.
- Generic natural-language search is intentionally a bounded record search, not a complete reporting query language. The assistant labels that limitation. Questions requiring an unsupported date/status breakdown should be answered only after adding a targeted, permission-scoped query and regression test.
- Browser-local history is not synchronized between devices. Follow-up expansion uses the latest in-memory question; complex references after a full page reload may need clarification.
