-- ============================================================================
-- 049  Per-plant monthly Preventive Maintenance cycle plan
-- ============================================================================
-- Until now every plant in the portfolio was planned from ONE hardcoded table
-- in app/pmplan/cycle.py. This table gives each plant its own monthly cycle,
-- loaded from the tracker the team actually works from.
--
-- `phases` is an ORDERED jsonb array. Each element is exactly:
--
--   {
--     "phase":      "4 Pole + ACDB + Aux. TX",
--     "area":       "Plant side",            -- or "GSS side"
--     "categories": ["4 Pole", "ACDB", "Aux. Transformer"],
--     "start_day":  16,
--     "days":       1,
--     "step_days":  1
--   }
--
--   categories  one or more work categories done as ONE visit.
--   start_day   nominal day within the 30-day cycle, 1..30.
--   days        planned working days. NULL on the Inverter phase, whose length
--               follows pm_unit_config (total_units / units_per_day); a value
--               stored on that phase is ignored by the resolver.
--   step_days   spacing between consecutive working days WITHIN the phase.
--               1 = consecutive, 2 = alternate days. Real inverter rounds run
--               days 1,3,5,7,9,11,13, which cannot be expressed without it.
--
-- A phase of N working days with step S occupies (N - 1) * S + 1 CALENDAR days.
-- Gaps BETWEEN phases need nothing extra: each phase carries its own start_day.
--
-- A plant with NO row here is PAUSED: no new PM cycles are generated for it.
-- That is deliberate -- only plants with a tracker are planned. Pausing does
-- NOT withdraw work orders already generated; they are left exactly as they are.
-- Paused plants are excluded from PM compliance, never counted as zero.
--
-- `id` has a real DEFAULT gen_random_uuid(). The project's uuid_pk() helper
-- generates ids in Python only; pm_unit_config was created without a column
-- default and raw SQL inserts failed on a null id. Not repeated here.
--
-- Additive only: nothing is dropped or modified. SAFE TO RE-RUN.
-- The app does NOT run migrations on start-up: paste this whole file into the
-- Supabase SQL editor and run it as one block. Take a backup (or run on
-- staging) before applying.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS pm_cycle_plans (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plant_id    uuid NOT NULL UNIQUE REFERENCES plants(id) ON DELETE CASCADE,
    phases      jsonb NOT NULL DEFAULT '[]'::jsonb,
    notes       text,
    updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One plan per plant. The UNIQUE on the column already enforces it; this index
-- is what the per-request lookup (plan for a set of plants) actually reads.
CREATE INDEX IF NOT EXISTS ix_pm_cycle_plans_plant
    ON pm_cycle_plans (plant_id);

-- phases must be a json ARRAY: the resolver iterates it in order, and an object
-- stored here would plan silently wrong days rather than fail loudly.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pm_cycle_plans_phases_is_array'
    ) THEN
        ALTER TABLE pm_cycle_plans
            ADD CONSTRAINT pm_cycle_plans_phases_is_array
            CHECK (jsonb_typeof(phases) = 'array');
    END IF;
END $$;

-- Same lock-down as every other table (migration 004).
ALTER TABLE IF EXISTS pm_cycle_plans ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE pm_cycle_plans FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE pm_cycle_plans FROM authenticated;
    END IF;
END $$;

COMMIT;
