-- ============================================================================
-- 048  Explicit "extra cleaning" flag on a daily washing report
-- ============================================================================
-- Re-cleaning that happens WHILE a cycle is still running cannot be derived from
-- counts, so it needs a stored flag. ("Extra" after Cycle 3 is full stays derived
-- as it is today; this flag is only for the mid-cycle case.)
--
--   is_extra = true  -> the entry is exempt from the once-per-cycle rule, never
--                       advances or completes a cycle, never reaches compliance,
--                       and is tagged to the cycle that was running when it
--                       happened. It joins the month's extra-cleaning total only
--                       once all three cycles of that month are complete.
--
-- NOT NULL DEFAULT false, so every existing row keeps today's meaning exactly.
--
-- The app does NOT run migrations on start-up: paste this whole file into the
-- Supabase SQL editor and run it as one block.
--
-- SAFE TO RE-RUN: every statement is guarded.
-- ============================================================================
BEGIN;

ALTER TABLE washing_daily_reports
    ADD COLUMN IF NOT EXISTS is_extra boolean NOT NULL DEFAULT false;

-- The register and the calendar read a month's extra entries for one plant; the
-- existing (plant_id, report_date) index does not help a flag-only filter.
CREATE INDEX IF NOT EXISTS ix_washing_daily_reports_plant_month_extra
    ON washing_daily_reports (plant_id, cycle_month)
    WHERE is_extra;

-- Same lock-down as every other table (migration 004); re-asserted so the new
-- column is never reachable from the public API roles.
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

COMMIT;
