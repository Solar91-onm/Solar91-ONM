-- PM templates: reusable Preventive Maintenance jobs per equipment type.
-- Safe to run more than once. Paste into the Supabase SQL editor, or run `python scripts/migrate.py`.
CREATE TABLE IF NOT EXISTS pm_templates (
    id uuid PRIMARY KEY,
    equipment_type varchar(120) NOT NULL,
    task_name varchar(255) NOT NULL,
    steps text,
    frequency varchar(80) NOT NULL DEFAULT 'Monthly',
    safety varchar(80),
    est_hours numeric(6,2),
    tools text,
    checks jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (equipment_type, task_name)
);
CREATE INDEX IF NOT EXISTS ix_pm_templates_equipment_type ON pm_templates(equipment_type);

-- Same lock-down pattern as migrations 010/011/013: only the FastAPI server touches this table.
ALTER TABLE IF EXISTS pm_templates ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE pm_templates FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE pm_templates FROM authenticated;
  END IF;
END $$;

-- Starter inverter template (edit or delete in the portal).
INSERT INTO pm_templates (id, equipment_type, task_name, steps, frequency, safety, est_hours, checks)
SELECT gen_random_uuid(), 'Inverter', 'Inverter monthly service - clean fans/filters and check tightness',
       '1. Take PTW and apply LOTO. 2. Open cover, blow-clean fans, filters and heatsink. 3. Check DC/AC terminal tightness. 4. Check alarm/fault history. 5. Close, remove LOTO, record readings.',
       'Monthly', 'PTW + LOTO required', 2,
       '[{"name":"Heatsink temperature","unit":"C","min":null,"max":75},{"name":"Insulation resistance","unit":"MOhm","min":1,"max":null}]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM pm_templates WHERE equipment_type = 'Inverter');
