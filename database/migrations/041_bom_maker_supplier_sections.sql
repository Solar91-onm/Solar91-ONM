-- ============================================================================
-- 041  BOM: Maker and Supplier are two things, and a section has its own order
-- ============================================================================
-- Migration 038 stored one `maker_supplier` column, and 040 added the BOQ group
-- heading `section`. A real BOQ needs three corrections to that shape:
--
--   * maker != supplier   -- the panel maker and the firm that supplied it are
--                            different parties and the BOQ names both. The single
--                            column is RENAMED to `maker` (every stored value is
--                            a maker) and `supplier` is added beside it, empty.
--   * section order       -- the BOM page ordered sections by their TEXT, which is
--                            alphabetical, so "14x2 MMS Hardware Quantity" sorted
--                            above "PV Section". A BOQ has its own section order;
--                            `section_order` holds it (same value on every row of
--                            a section) and the page orders by it.
--   * the read index      -- (plant_id, section, sort_order) can no longer serve
--                            that ordering; it becomes (plant_id, section_order,
--                            sort_order).
--
-- `section_order` is BACKFILLED from the existing BOQ line order, so current data
-- is in BOQ order the moment this runs -- no manual reordering needed. The backfill
-- only touches rows that have no section_order yet, so re-running it never undoes
-- a reorder someone saved from the portal.
--
-- No row is deleted, no data is lost: the rename keeps every stored maker value.
-- SAFE TO RE-RUN. Take a Supabase backup (or run on staging) before applying.
-- ============================================================================
BEGIN;

-- a) maker_supplier -> maker. Guarded both ways, so a second run is a no-op.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'bom_items'
                 AND column_name = 'maker_supplier')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = 'bom_items'
                         AND column_name = 'maker') THEN
        ALTER TABLE bom_items RENAME COLUMN maker_supplier TO maker;
    END IF;
END $$;

-- b) The supplying firm, separate from the maker. Optional: a BOQ line may name neither.
ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS supplier varchar(160);

-- c) Display order of the SECTION within a plant. Every row of a section carries
--    the same value; the portal's "Reorder sections" dialog rewrites it.
ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS section_order integer;

-- Backfill from the BOQ line order already stored: the section whose first line comes
-- first in the sheet is section 1. Only rows still missing a section_order are touched.
WITH s AS (SELECT plant_id, section, MIN(sort_order) AS first_line
           FROM bom_items WHERE section IS NOT NULL
           GROUP BY plant_id, section),
     r AS (SELECT plant_id, section,
                  row_number() OVER (PARTITION BY plant_id ORDER BY first_line, section) AS pos
           FROM s)
UPDATE bom_items b SET section_order = r.pos
FROM r
WHERE r.plant_id = b.plant_id AND r.section = b.section AND b.section_order IS NULL;

-- d) The BOM page reads a plant's lines in BOQ order: section order, then line order.
DROP INDEX IF EXISTS ix_bom_items_plant_section_order;
CREATE INDEX IF NOT EXISTS ix_bom_items_plant_section_order
    ON bom_items (plant_id, section_order, sort_order);

-- Same lock-down as every other table (migration 004); re-asserted so the new
-- columns are never reachable from the public API roles.
ALTER TABLE IF EXISTS bom_items ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE bom_items FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE bom_items FROM authenticated;
    END IF;
END $$;

COMMIT;
