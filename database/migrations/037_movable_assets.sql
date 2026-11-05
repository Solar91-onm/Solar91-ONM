-- ============================================================================
-- 037  Movable assets
-- ============================================================================
-- Adds one table, `movable_assets`: how many units of each named part a plant
-- holds. It feeds the "Movable Assets" page (Views tab and each plant's tab).
--
-- Additive only: nothing is dropped or modified. SAFE TO RE-RUN.
-- Take a Supabase backup (or run on staging) before applying.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS movable_assets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plant_id    uuid NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    part        varchar(160) NOT NULL,
    units       integer NOT NULL DEFAULT 0 CHECK (units >= 0),
    updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per part per plant, whatever case it was typed in.
CREATE UNIQUE INDEX IF NOT EXISTS ux_movable_assets_item
    ON movable_assets (plant_id, lower(btrim(part)));
CREATE INDEX IF NOT EXISTS ix_movable_assets_part
    ON movable_assets (lower(btrim(part)));

-- Same lock-down as every other table (migration 004).
ALTER TABLE IF EXISTS movable_assets ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE movable_assets FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE movable_assets FROM authenticated;
    END IF;
END $$;

COMMIT;
