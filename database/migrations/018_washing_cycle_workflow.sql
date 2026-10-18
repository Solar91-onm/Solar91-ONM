ALTER TABLE washing_config
    ADD COLUMN IF NOT EXISTS assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE washing_config ADD COLUMN IF NOT EXISTS compliance_threshold_percent integer NOT NULL DEFAULT 85;

CREATE TABLE IF NOT EXISTS washing_daily_reports (
    id uuid PRIMARY KEY,
    plant_id uuid NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    cycle_month varchar(7) NOT NULL,
    cycle_no integer NOT NULL,
    report_date date NOT NULL,
    job_status varchar(40) NOT NULL,
    tables_cleaned integer NOT NULL DEFAULT 0,
    cleaned_table_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
    remarks text,
    exception_reason varchar(80),
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    reported_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    reported_by varchar(255) NOT NULL,
    review_status varchar(40) NOT NULL DEFAULT 'Pending',
    reviewed_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by varchar(255),
    reviewed_at timestamptz,
    review_note text,
    cycle_completed boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE washing_daily_reports ADD COLUMN IF NOT EXISTS exception_reason varchar(80);
ALTER TABLE washing_daily_reports ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE washing_daily_reports ADD COLUMN IF NOT EXISTS cleaned_table_codes jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS ix_washing_daily_reports_plant_month_cycle
    ON washing_daily_reports(plant_id, cycle_month, cycle_no);

ALTER TABLE IF EXISTS washing_daily_reports ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE washing_daily_reports FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE washing_daily_reports FROM authenticated;
  END IF;
END $$;
