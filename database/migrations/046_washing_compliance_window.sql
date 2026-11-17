-- ============================================================================
-- 046  Fast-window setting for module-cleaning compliance scoring
-- ============================================================================
-- The compliance score has a 10-day cycle window, but the operator also wants a
-- "fast" window to distinguish a cycle that reached the compliance target in a
-- week from one that only made the 10-day deadline.
--
--   fast_window_days = 7 by default, and is only a target-quality marker: it
--                      never turns an on-time cycle into a failure.
--
-- SAFE TO RE-RUN: every statement is guarded.
-- ============================================================================
BEGIN;

ALTER TABLE washing_config ADD COLUMN IF NOT EXISTS fast_window_days integer NOT NULL DEFAULT 7;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'washing_config_fast_window_days_check') THEN
        ALTER TABLE washing_config
            ADD CONSTRAINT washing_config_fast_window_days_check
            CHECK (fast_window_days BETWEEN 1 AND 31);
    END IF;
END $$;

-- Same lock-down as every other table (migration 004); re-asserted so the new
-- column is never reachable from the public API roles.
ALTER TABLE IF EXISTS washing_config ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE washing_config FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE washing_config FROM authenticated;
    END IF;
END $$;

COMMIT;
