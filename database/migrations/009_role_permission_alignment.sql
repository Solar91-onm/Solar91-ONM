-- rev16: keep the persisted role-permission catalogue aligned with the
-- FastAPI permission vocabulary used by the production authorization layer.

UPDATE role_permissions
SET permissions = jsonb_set(
    permissions,
    '{services}',
    '["view","manage"]'::jsonb,
    true
),
updated_at = now()
WHERE role = 'O&M Head';

UPDATE role_permissions
SET permissions = jsonb_set(
    permissions,
    '{services}',
    '["view"]'::jsonb,
    true
),
updated_at = now()
WHERE role = 'Assignee';

CREATE INDEX IF NOT EXISTS ix_permits_task_status
    ON permits(task_id, status, created_at DESC);