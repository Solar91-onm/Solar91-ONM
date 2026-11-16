-- ============================================================================
-- 045  Was the equipment still running when the ticket was raised?
-- ============================================================================
-- The Raise Issue form now asks, for an Inverter ticket, "Is the inverter
-- running?" -- Running or Breakdown. One nullable boolean records the answer:
--
--   equipment_running = true   the equipment was still running (a fault was
--                              reported, but no unit is down)
--   equipment_running = false  BREAKDOWN: the named units are not running
--   equipment_running IS NULL  NOT ASKED -- every row that existed before this
--                              migration, and every ticket raised for a
--                              category the question does not apply to
--
-- WHY IT MATTERS
--   The Inverter Health drill-down and the Dashboard's Inverters tile count how
--   many units are DOWN. Until now they counted the units of every open
--   Inverter ticket, which marked units down for a ticket raised while the
--   inverter was still running and dropped the fleet below 100% for no reason.
--   With this column, only tickets with equipment_running = false contribute to
--   the "not running" count. True and NULL contribute ZERO, while still showing
--   as open tickets -- which is why NULL must stay NULL and must NOT be
--   back-filled to false.
--
-- BEFORE YOU RUN IT
--   * Take a Supabase backup (Database -> Backups), or run it on staging first.
--   * Nothing is dropped and no existing row is modified, so it is additive.
--
-- SAFE TO RE-RUN: every statement is guarded.
-- ============================================================================
BEGIN;

ALTER TABLE issues ADD COLUMN IF NOT EXISTS equipment_running boolean;

COMMENT ON COLUMN issues.equipment_running IS
'Was the equipment still running when this ticket was raised? false = breakdown (its unit_count units are down), true = still running, NULL = not asked (every row before migration 045). Only false counts towards the Inverter Health "not running" figure.';

-- Same lock-down as every other table (migration 004); re-asserted so the new
-- column is never reachable from the public API roles.
ALTER TABLE IF EXISTS issues ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE issues FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE issues FROM authenticated;
    END IF;
END $$;

COMMIT;

-- Check what is recorded:
-- SELECT equipment_running, count(*) FROM issues
-- WHERE deleted_at IS NULL AND lower(vertical) = 'inverter'
-- GROUP BY equipment_running;
