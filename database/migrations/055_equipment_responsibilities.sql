-- ============================================================================
-- 055  Equipment responsibility (who answers for one equipment category,
--      across every plant)
-- ============================================================================
-- Adds one table, `equipment_responsibilities`. A row says that a user is the
-- primary or backup responsible person for one canonical equipment category on the
-- whole portfolio. It is configured from Login Access (Equipment responsibility, and
-- the responsibility matrix) by an O&M Head.
--
-- What this does NOT do, deliberately:
--   * It does not touch `users`, `user_plant_assignments`, `plant_responsibilities`,
--     `issues`, `pm_tracking_activities` or any cleaning record. Plant visibility and
--     existing ticket assignees are left exactly as they are.
--   * It infers nothing from the existing plant-based assignments. The table starts
--     EMPTY and management fills it in through the portal; until then the portal
--     behaves exactly as before and new tickets stay unassigned with a notification
--     to the O&M Head, never discarded.
--   * It grants no approval or sequence-override authority. Those stay with the role.
--
-- Additive only: nothing is dropped, altered or deleted. SAFE TO RE-RUN.
-- Take a Supabase backup (or run on staging) before applying.
-- ============================================================================
BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS equipment_responsibilities (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Canonical category key from app/equipment/service.py (CATALOGUE), e.g. 'inverter',
    -- 'idt_transformer', 'gss'. One key per category, shared by every module, so the PM
    -- module's "4 Pole + ACDB + Aux. TX" and an issue's "VCB Panel" resolve to the same
    -- responsibility instead of creating a duplicate category.
    equipment_key    varchar(60) NOT NULL,
    -- The label as shown at the time of configuration (the work_categories name where the
    -- category comes from that master list). Display only; equipment_key is the identity.
    equipment_label  varchar(160) NOT NULL,
    user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    position         varchar(10) NOT NULL DEFAULT 'primary'
                     CHECK (position IN ('primary', 'backup')),
    active           boolean NOT NULL DEFAULT true,
    note             text,
    updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_equipment_responsibility_user UNIQUE (equipment_key, user_id)
);

-- One active primary per equipment category. Taking a category over moves the previous
-- primary to backup in the same transaction (the API does this), so this never blocks a
-- legitimate change - only a second, conflicting write.
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipment_responsibility_primary
    ON equipment_responsibilities (equipment_key)
    WHERE active AND position = 'primary';

-- Routing lookups: by equipment (ticket creation, PM actions) and by user (their page).
CREATE INDEX IF NOT EXISTS ix_equipment_responsibility_key
    ON equipment_responsibilities (equipment_key, active, position);
CREATE INDEX IF NOT EXISTS ix_equipment_responsibility_user
    ON equipment_responsibilities (user_id, active);

-- Same lock-down as every other table (migration 004): the API is the only reader.
ALTER TABLE IF EXISTS equipment_responsibilities ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE equipment_responsibilities FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE equipment_responsibilities FROM authenticated;
    END IF;
END $$;

COMMIT;

-- What is configured (expected after a fresh install: no rows):
SELECT equipment_key, equipment_label, position, active, user_id, updated_at
FROM equipment_responsibilities
ORDER BY equipment_key, position;
