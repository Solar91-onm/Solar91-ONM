
BEGIN;

CREATE TABLE IF NOT EXISTS work_categories (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          varchar(120) NOT NULL,
    code          varchar(60),
    sub_problems  jsonb   NOT NULL DEFAULT '[]'::jsonb,
    default_units integer CHECK (default_units IS NULL OR default_units >= 0),
    area          varchar(60),
    notes         text,
    sort_order    integer NOT NULL DEFAULT 100,
    active        boolean NOT NULL DEFAULT true,
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per category, whatever case it was typed in.
CREATE UNIQUE INDEX IF NOT EXISTS ux_work_categories_name ON work_categories (lower(btrim(name)));
CREATE INDEX IF NOT EXISTS ix_work_categories_order      ON work_categories (sort_order, name);

COMMENT ON TABLE  work_categories IS
'Work categories an issue is raised against and a PM cycle maintains. Replaced the hard-coded list in app/core/security.py and the per-asset equipment register. Editable in the portal (Settings -> Categories) or here.';
COMMENT ON COLUMN work_categories.sub_problems IS
'Faults reportable for this category, as a JSON array of strings, e.g. ["Fan failure","IGBT fault"]. Offered as the ticket subcategory.';
COMMENT ON COLUMN work_categories.default_units IS
'How many of these a plant typically has. A default for pm_unit_config only, never a limit.';
COMMENT ON COLUMN work_categories.code IS
'Your own identifier for the category, if you use one.';
COMMENT ON COLUMN work_categories.area IS
'"Plant side" or "GSS side", used by the 30-day PM cycle.';

-- Same lock-down as every other table (migration 004): the app connects as the
-- database owner; Supabase's anon/authenticated roles get nothing.
ALTER TABLE IF EXISTS work_categories ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE work_categories FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE work_categories FROM authenticated;
    END IF;
END $$;

COMMIT;


-- ============================================================================
-- FILL IT IN  — edit and run this block when your list is ready
-- ============================================================================
-- `sort_order` sets the order in every dropdown. `sub_problems` is a JSON array.
-- Re-running is safe: a name that already exists is updated, not duplicated.
--
-- INSERT INTO work_categories (name, code, sub_problems, default_units, area, sort_order)
-- VALUES
--   ('Inverter',    'INV', '["Fan failure","IGBT fault","Communication loss","Derating","Earth fault"]'::jsonb,  8, 'Plant side', 10),
--   ('Module',      'MOD', '["Hotspot","Cell crack","Delamination","Snail trail","PID"]'::jsonb,              2400, 'Plant side', 20),
--   ('Transformer', 'TRF', '["Oil leak","Temperature high","Buchholz alarm","Bushing damage"]'::jsonb,           1, 'Plant side', 30),
--   ('ACDB',        'ACDB','["MCCB trip","Busbar heating","Loose termination"]'::jsonb,                          1, 'Plant side', 40),
--   ('VCB Panel',   'VCB', '["Trip coil fault","SF6 low","Relay fault"]'::jsonb,                                 1, 'GSS side',   50)
-- ON CONFLICT (lower(btrim(name))) DO UPDATE SET
--   code          = excluded.code,
--   sub_problems  = excluded.sub_problems,
--   default_units = excluded.default_units,
--   area          = excluded.area,
--   sort_order    = excluded.sort_order,
--   active        = true,
--   updated_at    = now();

-- Check what is configured:
SELECT name, code, default_units, area, sort_order, active,
       jsonb_array_length(sub_problems) AS sub_problem_count
FROM work_categories
ORDER BY sort_order, name;
