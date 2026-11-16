-- ============================================================================
-- 044  Inverter unit configuration: who made the inverter, and its rating
-- ============================================================================
-- `pm_unit_config` held only how many units a plant has and how many can be
-- maintained per day. The Inverter Health drill-down also has to show WHICH
-- inverter a plant runs, so two optional columns are added beside the counts:
--
--   maker        -- 'Sungrow' | 'Wattpower' | 'Sineng' (free text; no enum, so a
--                   new maker needs no migration)
--   capacity_kw  -- nameplate rating of ONE unit, in kW (300, 275, 295). Numeric,
--                   not integer: a rating may be fractional.
--
-- Both are NULLable: a category configured before this migration simply has no
-- maker or rating recorded, and the portal prints a dash for it.
--
-- No row is deleted and no existing column is touched. SAFE TO RE-RUN.
-- Take a Supabase backup (or run on staging) before applying.
-- ============================================================================
BEGIN;

ALTER TABLE pm_unit_config ADD COLUMN IF NOT EXISTS maker varchar(120);
ALTER TABLE pm_unit_config ADD COLUMN IF NOT EXISTS capacity_kw numeric(10, 2);

-- A rating of zero or less is not a rating. NULL stays allowed (not yet recorded).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'pm_unit_config_capacity_kw_check') THEN
        ALTER TABLE pm_unit_config
            ADD CONSTRAINT pm_unit_config_capacity_kw_check
            CHECK (capacity_kw IS NULL OR capacity_kw > 0);
    END IF;
END $$;

-- Same lock-down as every other table (migration 004); re-asserted so the new
-- columns are never reachable from the public API roles.
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

COMMIT;
