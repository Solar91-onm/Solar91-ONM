-- Editable Maintenance Scope Library (O&M Head). One row; empty/absent = built-in defaults.
CREATE TABLE IF NOT EXISTS pm_scope_config (
    id uuid PRIMARY KEY,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE IF EXISTS pm_scope_config ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE pm_scope_config FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE pm_scope_config FROM authenticated;
  END IF;
END $$;
