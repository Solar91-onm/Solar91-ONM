CREATE TABLE IF NOT EXISTS pm_alert_log (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES om_tasks(id) ON DELETE CASCADE,
    level varchar(80) NOT NULL,
    due_on date,
    sent_at timestamptz NOT NULL DEFAULT now(),
    recipients_text text NOT NULL DEFAULT '',
    dedupe_key varchar(255) NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS ix_pm_alert_log_task_sent
    ON pm_alert_log(task_id, sent_at);

CREATE TABLE IF NOT EXISTS notification_preferences (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module varchar(40) NOT NULL,
    plant_id uuid REFERENCES plants(id) ON DELETE CASCADE,
    preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_preferences_global
    ON notification_preferences(user_id, module) WHERE plant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_preferences_plant
    ON notification_preferences(user_id, module, plant_id) WHERE plant_id IS NOT NULL;

ALTER TABLE IF EXISTS pm_alert_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS notification_preferences ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE pm_alert_log, notification_preferences FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE pm_alert_log, notification_preferences FROM authenticated;
  END IF;
END $$;
