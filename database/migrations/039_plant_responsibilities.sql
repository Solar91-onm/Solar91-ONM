-- ============================================================================
-- 039  Plant responsibilities (Preventive Maintenance and Health scope)
-- ============================================================================
-- Adds one table, `plant_responsibilities`: the Assignee responsible for a
-- plant's Preventive Maintenance ('pm') or Health ('health'). One Assignee per
-- plant per area, exactly like Module Cleaning (washing_config.assigned_user_id).
-- It is set from Login access (Access and scope) and shown in the plant Details table.
--
-- Additive only: nothing is dropped or modified. SAFE TO RE-RUN.
-- Take a Supabase backup (or run on staging) before applying.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS plant_responsibilities (
    plant_id         uuid NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    area             varchar(20) NOT NULL CHECK (area IN ('pm', 'health')),
    assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (plant_id, area)
);

CREATE INDEX IF NOT EXISTS ix_plant_responsibilities_user
    ON plant_responsibilities (assigned_user_id, area);

-- Same lock-down as every other table (migration 004).
ALTER TABLE IF EXISTS plant_responsibilities ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE plant_responsibilities FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE plant_responsibilities FROM authenticated;
    END IF;
END $$;

COMMIT;
