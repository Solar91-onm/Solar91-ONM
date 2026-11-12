-- ----------------------------------------------------------------------------
-- SUPERSEDED. The Asset & Warranty page was removed from the portal; no code
-- reads or writes `asset_warranty` any more. This file is kept as the record of
-- what was applied to production, and the table is left in place with its rows.
-- Do not run it on a database that does not already have the table.
-- ----------------------------------------------------------------------------
-- ============================================================================
-- 034  Asset & Warranty records
-- ============================================================================
--
-- WHAT THIS DOES
--   Adds one table, `asset_warranty`: the equipment at a plant, its parts, and
--   the warranty and certification dates for each. It is what the Asset &
--   Warranty page's "Set up" button fills, by spreadsheet upload.
--
-- WHY A NEW TABLE AND NOT THE OLD REGISTER
--   Migration 032 removed the equipment register on purpose and archived it to
--   schema `archive_032`. This does NOT restore it. It is additive and much
--   smaller: no assignment tables, no columns on `issues` or `om_tasks`, and no
--   change to who can see what. Assignee and Site Engineer scope stays exactly
--   as 032 left it — by plant.
--
--   `equipment` here is free text, deliberately. It is a label for the physical
--   item, NOT the work category that drives PM cycles and issue verticals
--   (`work_categories`, `om_tasks.task_type`, `issues.vertical`). Those are
--   untouched, so nothing about PM or Site Issues changes.
--
-- BEFORE YOU RUN IT
--   * Take a Supabase backup (Database -> Backups), or run it on staging first.
--   * Nothing is dropped and no existing row is modified, so it is additive.
--
-- SAFE TO RE-RUN: every statement is guarded.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS asset_warranty (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plant_id             uuid NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    equipment            varchar(160) NOT NULL,
    part                 varchar(160),
    part_number          varchar(120),
    make                 varchar(160),
    serial_no            varchar(120),
    quantity             integer CHECK (quantity IS NULL OR quantity >= 0),
    warranty_start       date,
    warranty_end         date,
    certification_date   date,
    certification_expiry date,
    certification_file   text,
    remarks              text,
    created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_asset_warranty_dates
        CHECK (warranty_start IS NULL OR warranty_end IS NULL OR warranty_end >= warranty_start),
    CONSTRAINT ck_asset_warranty_cert_dates
        CHECK (certification_date IS NULL OR certification_expiry IS NULL
               OR certification_expiry >= certification_date)
);

-- One row per part of one equipment at one plant, whatever case it was typed in.
-- coalesce() because part and part number are optional: without it Postgres
-- treats every NULL as distinct and the same row could be uploaded twice.
CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_warranty_item ON asset_warranty (
    plant_id,
    lower(btrim(equipment)),
    lower(btrim(coalesce(part, ''))),
    lower(btrim(coalesce(part_number, '')))
);
CREATE INDEX IF NOT EXISTS ix_asset_warranty_plant    ON asset_warranty (plant_id, equipment);
-- Partial: "what expires soon" never asks about rows with no end date.
CREATE INDEX IF NOT EXISTS ix_asset_warranty_expiry   ON asset_warranty (warranty_end)
    WHERE warranty_end IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_asset_warranty_cert_exp ON asset_warranty (certification_expiry)
    WHERE certification_expiry IS NOT NULL;

COMMENT ON TABLE asset_warranty IS
'Equipment at a plant, its parts, and their warranty and certification dates. Filled from the Asset & Warranty page (Set up -> Import). Not the retired equipment register of migration 013/032, and not the work-category list that drives PM and issues.';
COMMENT ON COLUMN asset_warranty.equipment IS
'The physical item, e.g. "Inverter INV-03". Free text: a label for the asset, not a work category.';
COMMENT ON COLUMN asset_warranty.part IS
'The part of that equipment the warranty covers, e.g. "Cooling fan". Blank means the equipment as a whole.';
COMMENT ON COLUMN asset_warranty.certification_file IS
'RESERVED. The certificate itself is served by an API that is not built yet, so nothing writes this column today. It exists now so the spreadsheet keeps its column and no later migration is needed. Store a reference (document id or path) here, never file bytes.';

-- Same lock-down as every other table (migration 004): the app connects as the
-- database owner; Supabase's anon/authenticated roles get nothing.
ALTER TABLE IF EXISTS asset_warranty ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE asset_warranty FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE asset_warranty FROM authenticated;
    END IF;
END $$;

COMMIT;

-- Check what is configured:
-- SELECT p.site_code, a.equipment, a.part, a.warranty_end, a.certification_expiry
-- FROM asset_warranty a JOIN plants p ON p.id = a.plant_id
-- ORDER BY p.site_code, a.equipment, a.part;
