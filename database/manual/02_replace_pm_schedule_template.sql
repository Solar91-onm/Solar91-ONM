-- MANUAL TEMPLATE ONLY. NOT a schema migration; do NOT run automatically on deploy.
-- Back up database + verify restore; pause application writers/PM generation during the change.
-- Default: ROLLBACK. Edit the commented staging inserts using VERIFIED site codes and actual IDs.
-- This replaces only unstarted NEW checklist assignments in explicitly selected plant/month scopes.
-- It refuses to delete records that contain any submission, approval or override history.
-- It never deletes plants, users, old work orders, unit config, cycle plans or audit logs.
-- Existing recurring cycle definitions can be replaced separately after reviewing your old SQL.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE pm_reset_scope (
  site_code text NOT NULL,
  month_start date NOT NULL CHECK (extract(day FROM month_start)=1),
  PRIMARY KEY(site_code,month_start)
) ON COMMIT DROP;
CREATE TEMP TABLE pm_replacement (
  site_code text NOT NULL,
  equipment text NOT NULL CHECK (equipment IN ('Inverter','ACCB','4 Pole + ACDB + Aux. TX','Transmission line','Earth pit','Miscellaneous')),
  equipment_id text NOT NULL CHECK (equipment_id=btrim(equipment_id) AND length(equipment_id) BETWEEN 1 AND 120),
  scheduled_on date NOT NULL,
  PRIMARY KEY(site_code,equipment,equipment_id,scheduled_on)
) ON COMMIT DROP;
-- FILL ONE ROW PER PLANT AND MONTH THAT YOU ACTUALLY INTEND TO REPLACE:
-- INSERT INTO pm_reset_scope VALUES ('REPLACE_SITE_CODE', DATE '2026-11-01');
-- FILL EVERY CHECKLIST-COVERED MAINTENANCE ACTIVITY FOR THAT SCOPE WITH ACTUAL EQUIPMENT IDs:
-- INSERT INTO pm_replacement VALUES
-- ('REPLACE_SITE_CODE','Inverter','ACTUAL_INVERTER_ID_1',DATE '2026-11-01'),
-- ('REPLACE_SITE_CODE','Inverter','ACTUAL_INVERTER_ID_2',DATE '2026-11-03'),
-- ('REPLACE_SITE_CODE','ACCB','ACTUAL_ACCB_ID',DATE '2026-11-15');
-- Add all actual rows, not just the example. Equipment with no Monthly checklist stays in the legacy plan.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pm_reset_scope) OR NOT EXISTS (SELECT 1 FROM pm_replacement) THEN
    RAISE EXCEPTION 'No explicit scope or replacement data provided. Nothing deleted.';
  END IF;
  IF EXISTS (SELECT 1 FROM pm_reset_scope s LEFT JOIN public.plants p ON p.site_code=s.site_code
             WHERE p.id IS NULL OR lower(coalesce(p.status,''))='inactive') THEN
    RAISE EXCEPTION 'Unknown or inactive site code. Nothing deleted.';
  END IF;
  IF EXISTS (SELECT 1 FROM pm_replacement r LEFT JOIN pm_reset_scope s ON s.site_code=r.site_code
             AND r.scheduled_on>=s.month_start AND r.scheduled_on<(s.month_start+interval '1 month')::date
             WHERE s.site_code IS NULL) THEN
    RAISE EXCEPTION 'Replacement activity outside explicitly selected month/scope.';
  END IF;
  IF EXISTS (SELECT 1 FROM pm_reset_scope s WHERE NOT EXISTS (SELECT 1 FROM pm_replacement r
             WHERE r.site_code=s.site_code AND r.scheduled_on>=s.month_start
             AND r.scheduled_on<(s.month_start+interval '1 month')::date)) THEN
    RAISE EXCEPTION 'Every selected plant/month must have replacement data.';
  END IF;
  IF EXISTS (SELECT 1 FROM pm_replacement WHERE equipment='Inverter'
             GROUP BY site_code, lower(equipment_id), date_trunc('month',scheduled_on::timestamp) HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Duplicate inverter within one plant/month.';
  END IF;
END $$;
-- The app locks each plant before workflow writes. Take the same locks in consistent order.
SELECT p.id,p.site_code FROM public.plants p WHERE p.site_code IN (SELECT site_code FROM pm_reset_scope) ORDER BY p.id FOR UPDATE;
CREATE TEMP VIEW pm_old_target AS
SELECT a.* FROM public.pm_tracking_activities a JOIN public.plants p ON p.id=a.plant_id
JOIN pm_reset_scope s ON s.site_code=p.site_code AND a.scheduled_on>=s.month_start
AND a.scheduled_on<(s.month_start+interval '1 month')::date;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pm_old_target a WHERE a.status <> 'Scheduled' OR a.permission <> 'None'
      OR a.submitted_at IS NOT NULL OR a.reviewed_at IS NOT NULL OR a.requested_at IS NOT NULL OR a.authorised_at IS NOT NULL
      OR a.inspected_on IS NOT NULL OR a.checklist <> '[]'::jsonb OR a.remarks IS NOT NULL
      OR EXISTS (SELECT 1 FROM public.audit_logs l WHERE l.entity_type='pm_tracking_activity' AND l.entity_id=a.id::text)) THEN
    RAISE EXCEPTION 'PM history found. Export and reconcile with O&M Head before replacing; no history deleted.';
  END IF;
END $$;
-- Review old/new counts and actual incoming assignments before ever using COMMIT.
SELECT 'old' AS source, p.site_code, a.equipment, count(*) FROM pm_old_target a JOIN public.plants p ON p.id=a.plant_id GROUP BY p.site_code,a.equipment
UNION ALL SELECT 'replacement',site_code,equipment,count(*) FROM pm_replacement GROUP BY site_code,equipment ORDER BY 2,3,1;
DELETE FROM public.pm_tracking_activities WHERE id IN (SELECT id FROM pm_old_target);
INSERT INTO public.pm_tracking_activities (plant_id,equipment,equipment_id,scheduled_on)
SELECT p.id,r.equipment,r.equipment_id,r.scheduled_on FROM pm_replacement r JOIN public.plants p ON p.site_code=r.site_code;
SELECT p.site_code,a.equipment,a.equipment_id,a.scheduled_on,a.status FROM pm_old_target a JOIN public.plants p ON p.id=a.plant_id ORDER BY p.site_code,a.scheduled_on,a.equipment_id;
-- Dry run by default. Review inventory, exact replacement rows and result before explicitly choosing COMMIT.
ROLLBACK;
