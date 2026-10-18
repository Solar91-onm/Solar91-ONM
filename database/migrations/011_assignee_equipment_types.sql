-- Assignees own an equipment TYPE (Inverter, Module, ...) across ALL plants.
-- Every issue, scheduled task and washing job of that type routes to them; no equipment register needed.
CREATE TABLE IF NOT EXISTS user_equipment_type_assignments (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    equipment_type varchar(120) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, equipment_type)
);
CREATE INDEX IF NOT EXISTS ix_user_equipment_type_assignments_type
    ON user_equipment_type_assignments(equipment_type);

ALTER TABLE IF EXISTS user_equipment_type_assignments ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE user_equipment_type_assignments FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE user_equipment_type_assignments FROM authenticated;
  END IF;
END $$;
