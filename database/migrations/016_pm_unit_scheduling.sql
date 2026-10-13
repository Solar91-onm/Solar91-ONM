-- PM unit-level scheduling: per-plant unit counts / daily capacity, unit fields on PM tasks.
-- Safe to run more than once. Existing rows are NOT modified (new columns are nullable / default 0).
CREATE TABLE IF NOT EXISTS pm_unit_config (
    id uuid PRIMARY KEY,
    plant_id uuid NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    equipment_type varchar(120) NOT NULL,
    total_units integer NOT NULL CHECK (total_units >= 1),
    units_per_day integer NOT NULL CHECK (units_per_day >= 1),
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (plant_id, equipment_type)
);
CREATE INDEX IF NOT EXISTS ix_pm_unit_config_plant ON pm_unit_config(plant_id);

ALTER TABLE pm_templates ADD COLUMN IF NOT EXISTS units_per_day integer;

ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS unit_no integer;
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS total_units integer;
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS cycle_id varchar(60);
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS cycle_day integer;
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS planned_due_on date;
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS missed_days integer NOT NULL DEFAULT 0;
ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS rolled_count integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_om_tasks_cycle_id ON om_tasks(cycle_id);

-- Same lock-down pattern as 010/011/013/015: only the FastAPI server touches this table.
ALTER TABLE IF EXISTS pm_unit_config ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE pm_unit_config FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE pm_unit_config FROM authenticated;
  END IF;
END $$;
