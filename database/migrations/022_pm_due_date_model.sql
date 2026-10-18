ALTER TABLE om_tasks ADD COLUMN IF NOT EXISTS quantity integer;

CREATE TABLE IF NOT EXISTS pm_followups (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES om_tasks(id) ON DELETE CASCADE,
    at timestamptz NOT NULL DEFAULT now(),
    by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    by_name varchar(255) NOT NULL,
    how varchar(40) NOT NULL,
    spoke_to varchar(255),
    outcome varchar(80) NOT NULL,
    promised_on date,
    next_follow_up_on date,
    note text
);
CREATE INDEX IF NOT EXISTS ix_pm_followups_task_at ON pm_followups(task_id, at);

CREATE TABLE IF NOT EXISTS pm_due_changes (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES om_tasks(id) ON DELETE CASCADE,
    old_due date,
    new_due date NOT NULL,
    reason text NOT NULL,
    by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    by_name varchar(255) NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_pm_due_changes_task_at ON pm_due_changes(task_id, at);

ALTER TABLE IF EXISTS pm_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS pm_due_changes ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE pm_followups, pm_due_changes FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE pm_followups, pm_due_changes FROM authenticated;
  END IF;
END $$;
