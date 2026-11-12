-- ============================================================================
-- 040  BOM: the fields a real plant BOQ needs
-- ============================================================================
-- Migration 038 created `bom_items` for a short parts inventory. A real BOQ
-- (e.g. ABH01: 180 lines in 19 sections) needs four things that table cannot hold:
--
--   * fractional quantities  -- 5368.230 kWp, 7180.800 Mtrs; `integer` truncated them
--   * the unit               -- Nos. / Mtrs / kWp / KG / Meter / Set
--   * the BOQ group heading  -- "PV Section", "AC side - Cables & Accessories", "PROTECTION"
--   * the BOQ line order     -- the sheet's S.No. repeats (four rows can all read "5"),
--                               so it cannot order the lines; `sort_order` does
--
-- `item_name` also becomes text: the sample's longest name is exactly 200 characters,
-- the old varchar(200) limit, so the next BOQ would overflow it.
--
-- Additive only: no column is dropped, no row is changed, every new column is NULL.
-- The quantity widening (integer -> numeric) keeps every existing value as-is.
-- SAFE TO RE-RUN. Take a Supabase backup (or run on staging) before applying.
-- ============================================================================
BEGIN;

-- Quantity: integer -> numeric(14,3). Existing whole numbers are preserved exactly;
-- the bom_items_quantity_check (>= 0) constraint carries over to the wider type.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'bom_items'
                 AND column_name = 'quantity' AND data_type <> 'numeric') THEN
        ALTER TABLE bom_items
            ALTER COLUMN quantity TYPE numeric(14,3) USING quantity::numeric(14,3);
    END IF;
END $$;

-- Item name: varchar(200) -> text (a BOQ description can be longer than 200 characters).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'bom_items'
                 AND column_name = 'item_name' AND data_type <> 'text') THEN
        ALTER TABLE bom_items ALTER COLUMN item_name TYPE text;
    END IF;
END $$;

-- Unit of measure, BOQ group heading and BOQ line order. All optional: a BOQ line
-- may legitimately carry none of them.
ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS unit       varchar(24);
ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS section    varchar(160);
ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS sort_order integer;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bom_items_sort_order_check') THEN
        ALTER TABLE bom_items
            ADD CONSTRAINT bom_items_sort_order_check CHECK (sort_order IS NULL OR sort_order >= 0);
    END IF;
END $$;

-- The BOM page reads a plant's lines in BOQ order: section, then line order.
CREATE INDEX IF NOT EXISTS ix_bom_items_plant_section_order
    ON bom_items (plant_id, section, sort_order);

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
