-- Solar91 O&M Command Center
-- 008_multi_user_scope_hardening
-- Explicitly tie Scheduled O&M work to a Solar91 user and remove authorization
-- dependence on the plants.assigned_engineer display field.

ALTER TABLE om_tasks
    ADD COLUMN IF NOT EXISTS assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_om_tasks_assignee_user_id
    ON om_tasks(assignee_user_id);

-- Backfill Site Engineer assignments only when the legacy text assignment maps
-- unambiguously to exactly one plant. Ambiguous/no-match users remain pending
-- until an authorized O&M Head assigns them explicitly.
WITH matches AS (
    SELECT u.id AS user_id, p.id AS plant_id, count(*) OVER (PARTITION BY u.id) AS n
    FROM users u
    JOIN plants p
      ON lower(trim(coalesce(p.assigned_engineer, ''))) = lower(trim(coalesce(u.display_name, '')))
       OR lower(trim(coalesce(p.assigned_engineer, ''))) = lower(trim(coalesce(u.email, '')))
    WHERE u.role = 'Site Engineer'
),
unique_matches AS (
    SELECT DISTINCT user_id, plant_id
    FROM matches
    WHERE n = 1
)
INSERT INTO user_plant_assignments (user_id, plant_id, assignment_role)
SELECT um.user_id, um.plant_id, 'Site Engineer'
FROM unique_matches um
WHERE NOT EXISTS (
    SELECT 1
    FROM user_plant_assignments upa
    WHERE upa.user_id = um.user_id
      AND upa.plant_id = um.plant_id
);

COMMENT ON TABLE user_plant_assignments IS
'Authoritative server-side plant scope for non-portfolio roles. Site Engineer must have exactly one assignment.';

COMMENT ON COLUMN om_tasks.assignee_user_id IS
'Authoritative Solar91 assignee identity; assignee_text is display/legacy compatibility only.';
