BEGIN;

DO $$
BEGIN
    IF to_regclass('public.user_equipment_type_assignments') IS NULL THEN
        RAISE NOTICE 'Assignee type assignments already removed; nothing to migrate.';
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

    RAISE NOTICE 'Assignee plant scope granted.';
END $$;

COMMIT;

-- Check: any row with plants = 0 will see "access pending" after the deploy
SELECT u.display_name, u.email, count(a.plant_id) AS plants
FROM users u
LEFT JOIN user_plant_assignments a ON a.user_id = u.id
WHERE u.role = 'Assignee' AND u.is_active
GROUP BY u.id, u.display_name, u.email
ORDER BY plants, u.display_name;