-- Washing import metadata. Existing washing setups stay active by default.
ALTER TABLE washing_config ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE washing_config ADD COLUMN IF NOT EXISTS notes varchar(500);
CREATE INDEX IF NOT EXISTS ix_washing_daily_reports_plant_date
    ON washing_daily_reports(plant_id, report_date);
