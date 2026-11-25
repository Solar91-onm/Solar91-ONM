-- Additive; run in Supabase SQL editor BEFORE deploying the changed application.
-- No existing om_tasks or pm_cycle_plans are altered. SQL is the scheduling interface.
BEGIN;
CREATE TABLE IF NOT EXISTS pm_tracking_activities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plant_id uuid NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    equipment varchar(100) NOT NULL CHECK (equipment IN ('Inverter','ACCB','4 Pole + ACDB + Aux. TX','Transmission line','Earth pit','Miscellaneous')),
    equipment_id varchar(120) NOT NULL CHECK (length(btrim(equipment_id)) > 0),
    scheduled_on date NOT NULL,
    status varchar(30) NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled','Pending approval','Approved','Returned')),
    checklist jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checklist) = 'array'),
    remarks text, inspected_on date,
    submitted_by uuid REFERENCES users(id) ON DELETE SET NULL, submitted_name varchar(255), submitted_at timestamptz,
    reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL, reviewed_name varchar(255), reviewed_at timestamptz, review_note text,
    permission varchar(20) NOT NULL DEFAULT 'None' CHECK (permission IN ('None','Requested','Granted','Denied')),
    permission_reason text, requested_by uuid REFERENCES users(id) ON DELETE SET NULL, requested_name varchar(255), requested_at timestamptz,
    authorised_by uuid REFERENCES users(id) ON DELETE SET NULL, authorised_name varchar(255), authorised_at timestamptz, authorisation_note text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (plant_id, equipment, equipment_id, scheduled_on)
);
CREATE INDEX IF NOT EXISTS ix_pm_tracking_plant_date ON pm_tracking_activities(plant_id, scheduled_on);
CREATE INDEX IF NOT EXISTS ix_pm_tracking_activities_plant_id ON pm_tracking_activities(plant_id);
CREATE INDEX IF NOT EXISTS ix_pm_tracking_activities_scheduled_on ON pm_tracking_activities(scheduled_on);
-- One maintenance slot per individual inverter per calendar month; same-date different IDs allowed.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pm_tracking_inverter_month ON pm_tracking_activities
    (plant_id, lower(btrim(equipment_id)), (date_trunc('month', scheduled_on::timestamp))) WHERE equipment = 'Inverter';
ALTER TABLE pm_tracking_activities ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON pm_tracking_activities FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON pm_tracking_activities FROM authenticated;
    END IF;
END $$;
COMMIT;
