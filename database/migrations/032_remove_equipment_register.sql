-- ============================================================================
-- 032  Remove the equipment register; move Assignee scope to plants
-- ============================================================================
--
-- WHAT THIS DOES
--   1. Backs up everything it is about to drop into schema `archive_032`.
--   2. Migrates Assignee scope from equipment TYPES to PLANTS (this is the only
--      step that changes who can see what, so it runs BEFORE anything is dropped).
--   3. Drops the equipment register: `equipment`, `equipment_documents`,
--      `user_equipment_assignments`, `user_equipment_type_assignments`.
--   4. Drops the register columns on `issues` and `om_tasks`.
--
-- WHAT IT DOES NOT TOUCH
--   * Authentication, `users`, roles or `role_permissions` — the sign-in and
--     access panel are unchanged.
--   * `pm_templates.equipment_type`, `pm_unit_config.equipment_type`,
--     `om_tasks.task_type`, `issues.vertical` — these hold WORK CATEGORIES
--     (Inverter, Transformer, ACDB …), which Preventive Maintenance cycles and
--     issue categories are built on. They keep their column names so no PM data
--     or saved spreadsheet import has to change.
--
-- BEFORE YOU RUN IT
--   * Take a Supabase backup (Database → Backups), or run it on staging first.
--   * Read section 2: if an Assignee ends up with no plants they land in the
--     "access pending" state until an O&M Head assigns their plants. The last
--     query in this file lists anyone affected.
--
-- SAFE TO RE-RUN: every step is guarded, so running it twice changes nothing.
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Archive first. Nothing below is destructive until section 3.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS archive_032;

COMMENT ON SCHEMA archive_032 IS
'Backup taken by migration 032 before the equipment register was removed. Safe to drop once the change is confirmed in production.';

DO $$
BEGIN
    IF to_regclass('public.equipment') IS NOT NULL
       AND to_regclass('archive_032.equipment') IS NULL THEN
        EXECUTE 'CREATE TABLE archive_032.equipment AS TABLE public.equipment';
    END IF;

    IF to_regclass('public.equipment_documents') IS NOT NULL
       AND to_regclass('archive_032.equipment_documents') IS NULL THEN
        EXECUTE 'CREATE TABLE archive_032.equipment_documents AS TABLE public.equipment_documents';
    END IF;

    IF to_regclass('public.user_equipment_assignments') IS NOT NULL
       AND to_regclass('archive_032.user_equipment_assignments') IS NULL THEN
        EXECUTE 'CREATE TABLE archive_032.user_equipment_assignments AS TABLE public.user_equipment_assignments';
    END IF;

    IF to_regclass('public.user_equipment_type_assignments') IS NOT NULL
       AND to_regclass('archive_032.user_equipment_type_assignments') IS NULL THEN
        EXECUTE 'CREATE TABLE archive_032.user_equipment_type_assignments AS TABLE public.user_equipment_type_assignments';
    END IF;
END $$;

-- The two issue columns that are about to disappear, kept per ticket so a
-- historical ticket's asset reference can still be looked up after the change.
DO $$
BEGIN
    IF to_regclass('archive_032.issue_equipment_links') IS NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'issues'
                     AND column_name = 'equipment_ref') THEN
        EXECUTE $q$
            CREATE TABLE archive_032.issue_equipment_links AS
            SELECT id AS issue_id, ticket_no, plant_id, equipment_id, equipment_ref, maker
            FROM public.issues
            WHERE equipment_id IS NOT NULL
               OR nullif(btrim(coalesce(equipment_ref, '')), '') IS NOT NULL
               OR nullif(btrim(coalesce(maker, '')), '') IS NOT NULL
        $q$;
    END IF;

    IF to_regclass('archive_032.om_task_equipment_refs') IS NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'om_tasks'
                     AND column_name = 'equipment_ref') THEN
        EXECUTE $q$
            CREATE TABLE archive_032.om_task_equipment_refs AS
            SELECT id AS task_id, work_order_no, plant_id, task_type, equipment_ref
            FROM public.om_tasks
            WHERE nullif(btrim(coalesce(equipment_ref, '')), '') IS NOT NULL
        $q$;
    END IF;
END $$;

-- Lock the archive down the same way every other table is locked down.
DO $$
DECLARE t text;
BEGIN
    FOR t IN
        SELECT tablename FROM pg_tables WHERE schemaname = 'archive_032'
    LOOP
        EXECUTE format('ALTER TABLE archive_032.%I ENABLE ROW LEVEL SECURITY', t);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            EXECUTE format('REVOKE ALL ON TABLE archive_032.%I FROM anon', t);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            EXECUTE format('REVOKE ALL ON TABLE archive_032.%I FROM authenticated', t);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON SCHEMA archive_032 FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON SCHEMA archive_032 FROM authenticated;
    END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Assignee scope: equipment types  →  plants
--
--    An Assignee used to hold equipment TYPES, and any assigned type exposed
--    EVERY plant. Scope is now explicit rows in `user_plant_assignments`.
--
--    To keep every Assignee working exactly as before this change, each one
--    with at least one equipment type is given every plant they could already
--    see. Narrow them down afterwards in Settings → Team access; that is a
--    tightening of access, never a widening.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF to_regclass('public.user_equipment_type_assignments') IS NULL THEN
        RAISE NOTICE 'Assignee type assignments already removed; skipping scope migration.';
        RETURN;
    END IF;

    INSERT INTO user_plant_assignments (user_id, plant_id, assignment_role)
    SELECT DISTINCT u.id, p.id, 'Assignee'
    FROM users u
    JOIN user_equipment_type_assignments t ON t.user_id = u.id
    CROSS JOIN plants p
    WHERE u.role = 'Assignee'
      AND u.is_active
    ON CONFLICT (user_id, plant_id) DO NOTHING;

    RAISE NOTICE 'Assignee plant scope migrated from equipment types.';
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Drop the register
-- ─────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS equipment_documents              CASCADE;
DROP TABLE IF EXISTS user_equipment_assignments       CASCADE;
DROP TABLE IF EXISTS user_equipment_type_assignments  CASCADE;
DROP TABLE IF EXISTS equipment                        CASCADE;   -- drops the FKs below with it

DROP INDEX IF EXISTS ix_equipment_plant_type;
DROP INDEX IF EXISTS ix_equipment_maker;
DROP INDEX IF EXISTS ix_user_equipment_assignments_equipment_id;
DROP INDEX IF EXISTS ix_user_equipment_type_assignments_type;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Drop the register columns on work records
--
--    `issues.vertical`, `issues.subcategory` and `om_tasks.task_type` stay:
--    they are the work category, not an asset record.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE issues    DROP COLUMN IF EXISTS equipment_id;
ALTER TABLE issues    DROP COLUMN IF EXISTS equipment_ref;
ALTER TABLE issues    DROP COLUMN IF EXISTS maker;
ALTER TABLE om_tasks  DROP COLUMN IF EXISTS equipment_ref;

-- `supplier` and `serial_number` were never columns; they lived inside
-- issues.legacy_payload. Strip them so no asset identity survives in JSON.
UPDATE issues
SET legacy_payload = (legacy_payload - 'supplier' - 'serial_number' - 'units')
WHERE legacy_payload IS NOT NULL
  AND (legacy_payload ? 'supplier' OR legacy_payload ? 'serial_number' OR legacy_payload ? 'units');

COMMENT ON COLUMN issues.vertical IS
'Work category the issue is raised against (Inverter, Transformer, ...). Not an asset-register reference.';

COMMENT ON COLUMN om_tasks.task_type IS
'Work category this PM job maintains. Unit counts come from pm_unit_config, not from an asset register.';

COMMIT;


-- ============================================================================
-- AFTER RUNNING: check whether anyone lost access
-- ============================================================================
-- Any Assignee listed here has no plants and will see "access pending" until an
-- O&M Head assigns their plants in Settings → Team access.
SELECT u.display_name, u.email, u.role
FROM users u
WHERE u.role = 'Assignee'
  AND u.is_active
  AND NOT EXISTS (
      SELECT 1 FROM user_plant_assignments a WHERE a.user_id = u.id
  )
ORDER BY u.display_name;

-- Once production is confirmed healthy, the backup can go:
--   DROP SCHEMA archive_032 CASCADE;
