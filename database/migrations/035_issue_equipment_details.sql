-- ============================================================================
-- 035  Issue equipment details: serial number, supplier / maker, units
-- ============================================================================
--
-- WHAT THIS DOES
--   Adds three optional columns to `issues`, filled on the Raise Issue form
--   (step 2, Classification) and by the Site Issues spreadsheet upload:
--
--     serial_no       the serial number of the equipment the fault was found on
--     supplier_maker  who made or supplied that equipment
--     unit_count      how many units the fault covers
--
--   They are plain descriptive text and a count on the ticket itself. Every one
--   is nullable, so existing tickets stay valid and nothing is back-filled.
--
-- WHY THIS IS NOT THE OLD EQUIPMENT REGISTER
--   Migration 032 removed the per-asset register and dropped `issues.maker`
--   along with `supplier` / `serial_number` / `units` inside
--   `issues.legacy_payload`. This does NOT bring that register back: it adds no
--   table, no foreign key and no assignment or scope change. Assignee and Site
--   Engineer scope stays by plant, exactly as 032 left it, and the work-category
--   taxonomy (`work_categories`, `issues.vertical`) is untouched. These are
--   three descriptive fields on a ticket, nothing more.
--
-- BEFORE YOU RUN IT
--   * Take a Supabase backup (Database -> Backups), or run it on staging first.
--   * Nothing is dropped and no existing row is modified, so it is additive.
--
-- SAFE TO RE-RUN: every statement is guarded.
-- ============================================================================

BEGIN;

ALTER TABLE issues ADD COLUMN IF NOT EXISTS serial_no      varchar(120);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS supplier_maker varchar(160);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS unit_count     integer;

-- The form and the upload both accept 1..100000; the database refuses anything
-- else so a direct write cannot store 0 or a negative count.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_issues_unit_count') THEN
        ALTER TABLE issues ADD CONSTRAINT ck_issues_unit_count
            CHECK (unit_count IS NULL OR (unit_count >= 1 AND unit_count <= 100000));
    END IF;
END $$;

COMMENT ON COLUMN issues.serial_no IS
'Serial number of the equipment this fault was found on. Optional, free text, entered on the Raise Issue form or the Site Issues upload.';
COMMENT ON COLUMN issues.supplier_maker IS
'Who made or supplied that equipment. Optional, free text. Not a link to any register: migration 032 removed the per-asset register on purpose.';
COMMENT ON COLUMN issues.unit_count IS
'How many units of that equipment this ticket covers. Optional; 1..100000 when set.';

COMMIT;

-- Check what is filled:
-- SELECT ticket_no, vertical, serial_no, supplier_maker, unit_count
-- FROM issues WHERE deleted_at IS NULL AND (serial_no IS NOT NULL OR supplier_maker IS NOT NULL
--                                           OR unit_count IS NOT NULL)
-- ORDER BY created_at DESC LIMIT 50;
