-- Older tickets were assigned by NAME only (assigned_to empty), so the Assignee could not acknowledge them.
-- Link each such open ticket to the matching Assignee user. Only unambiguous, exact name matches are changed.
-- Safe to run more than once.
UPDATE issues i
SET assigned_to = u.id
FROM users u
WHERE i.assigned_to IS NULL
  AND i.assignee_text IS NOT NULL
  AND i.status <> 'Closed'
  AND u.role = 'Assignee' AND u.is_active
  AND lower(btrim(u.display_name)) = lower(btrim(i.assignee_text))
  AND (SELECT count(*) FROM users u2
       WHERE u2.role = 'Assignee' AND u2.is_active
         AND lower(btrim(u2.display_name)) = lower(btrim(i.assignee_text))) = 1;
