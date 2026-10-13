-- Assignees are responsible for explicitly assigned registered equipment,
-- which may belong to plants across the portfolio.
CREATE TABLE IF NOT EXISTS user_equipment_assignments (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, equipment_id)
);

CREATE INDEX IF NOT EXISTS ix_user_equipment_assignments_equipment_id
    ON user_equipment_assignments(equipment_id);

COMMENT ON TABLE user_equipment_assignments IS
'Authoritative equipment scope for Assignee accounts. Site Engineer access remains plant-scoped.';

ALTER TABLE IF EXISTS user_equipment_assignments ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE user_equipment_assignments FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE user_equipment_assignments FROM authenticated;
  END IF;
END $$;
