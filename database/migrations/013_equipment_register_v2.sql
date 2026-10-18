-- Equipment Register v2: additive production fields, per-item responsibility and documents.
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS discom varchar(120);
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS feeder_or_gss text;
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS rating varchar(120);
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS capacity_kw numeric(14,3);
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS location_in_plant varchar(255);
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS manufacture_year integer;
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS commissioned_on date;
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS warranty_start date;
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS warranty_end date;
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS amc_vendor varchar(255);
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS amc_end date;
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS supplier varchar(255);
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS purchase_order_no varchar(160);
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS criticality varchar(20);
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS in_charge_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS last_service_on date;
ALTER TABLE IF EXISTS equipment ADD COLUMN IF NOT EXISTS next_service_due date;

CREATE INDEX IF NOT EXISTS ix_equipment_in_charge_user_id ON equipment(in_charge_user_id);
CREATE INDEX IF NOT EXISTS ix_equipment_warranty_end ON equipment(warranty_end);
CREATE INDEX IF NOT EXISTS ix_equipment_next_service_due ON equipment(next_service_due);
CREATE INDEX IF NOT EXISTS ix_equipment_discom ON equipment(discom);

CREATE TABLE IF NOT EXISTS equipment_documents (
    id uuid PRIMARY KEY,
    equipment_id uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    kind varchar(80) NOT NULL,
    original_name varchar(255) NOT NULL,
    storage_path text NOT NULL,
    content_type varchar(120) NOT NULL,
    size_bytes integer NOT NULL,
    uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_equipment_documents_equipment_id ON equipment_documents(equipment_id);

ALTER TABLE IF EXISTS equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS equipment_documents ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE equipment FROM anon;
    REVOKE ALL ON TABLE equipment_documents FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE equipment FROM authenticated;
    REVOKE ALL ON TABLE equipment_documents FROM authenticated;
  END IF;
END $$;
