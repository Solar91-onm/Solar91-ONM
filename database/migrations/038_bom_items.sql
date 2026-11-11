-- ============================================================================
-- 038  Bill of Materials (parts inventory per plant)
-- ============================================================================
-- Adds one table, `bom_items`: the parts held at each plant (item, maker or
-- supplier, quantity, specs, test report, warranty certificate, serial no.,
-- invoice, invoice link). It feeds the "BOM" page (Views > Details > BOM and each plant's
-- Details > BOM).
--
-- Additive only: nothing is dropped or modified. SAFE TO RE-RUN.
-- Take a Supabase backup (or run on staging) before applying.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS bom_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plant_id       uuid NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    item_name      varchar(200) NOT NULL,
    maker_supplier varchar(160),
    quantity       integer CHECK (quantity IS NULL OR quantity >= 0),
    specs          text,
    test_report    varchar(200),
    warranty_cert  varchar(200),
    serial_no      varchar(120),
    invoice        varchar(200),
    invoice_url    text CHECK (invoice_url IS NULL OR invoice_url ~* '^https?://'),
    row_version    integer NOT NULL DEFAULT 1,
    updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Invoice link (shown as a clickable Invoice cell). Paste a full http(s) URL here in the
-- Supabase table editor, or enter it in the portal's Add/Edit item dialog.
ALTER TABLE bom_items ADD COLUMN IF NOT EXISTS invoice_url text;

CREATE INDEX IF NOT EXISTS ix_bom_items_plant ON bom_items (plant_id, lower(item_name));
CREATE INDEX IF NOT EXISTS ix_bom_items_maker ON bom_items (lower(btrim(maker_supplier)));

-- Same lock-down as every other table (migration 004).
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
