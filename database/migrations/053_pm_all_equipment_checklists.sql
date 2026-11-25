-- Solar91 PM checklist coverage upgrade: 159 -> 198 activities per month.
-- Prerequisite: successful Solar91_PM_Recurring_From_December.sql and existing PM migrations.
-- Backup and test on staging first. Execute the ENTIRE file in one query.
-- No DELETE, TRUNCATE, status reset, changes to plant assignments, or changes to dates.
-- This migration intentionally targets the existing 13-plant setup only.
-- Deploy the matching application patch immediately after this migration.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(91391020261201);

CREATE TEMP TABLE pm_v2_sites(code text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO pm_v2_sites VALUES ('ABH01'),('ALN01'),('ALN02'),('ALN03'),('AVK01'),('BST01'),('DDS01'),('GUL01'),('IND01'),('KH001'),('MNP01'),('MUW01'),('NKD01');
DO $$ BEGIN
    IF EXISTS (SELECT s.code FROM pm_v2_sites s LEFT JOIN public.plants p
        ON regexp_replace(upper(p.site_code),'[^A-Z0-9]','','g')=s.code
        GROUP BY s.code HAVING count(p.id)<>1) THEN
        RAISE EXCEPTION 'Missing or ambiguous plant code; no PM data changed';
    END IF;
END $$;
CREATE TEMP TABLE pm_v2_plants ON COMMIT DROP AS
SELECT p.id AS plant_id, s.code FROM public.plants p JOIN pm_v2_sites s
ON regexp_replace(upper(p.site_code),'[^A-Z0-9]','','g')=s.code;
-- Match the API and recurrence lock order. Run in a short maintenance window.
SELECT p.id FROM public.plants p JOIN pm_v2_plants v ON v.plant_id=p.id ORDER BY p.id FOR UPDATE OF p;
LOCK TABLE solar91_pm.monthly_rules IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.pm_tracking_activities IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE solar91_pm.generated_months IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM public.plants p JOIN pm_v2_plants v ON p.id=v.plant_id WHERE lower(coalesce(p.status,''))='inactive') THEN
        RAISE EXCEPTION 'A planned plant is inactive; review its schedule';
    END IF;
    IF EXISTS (SELECT 1 FROM solar91_pm.monthly_rules r WHERE r.plant_id NOT IN (SELECT plant_id FROM pm_v2_plants)) THEN
        RAISE EXCEPTION 'Additional plants have PM rules; review before applying this 13-plant migration';
    END IF;
    IF (SELECT count(*) FROM solar91_pm.monthly_rules WHERE equipment NOT IN ('IDT Transformer','VCB','GSS visit'))<>159 OR
       (SELECT count(*) FROM solar91_pm.monthly_rules WHERE equipment='Inverter')<>94 OR
       (SELECT count(DISTINCT plant_id) FROM solar91_pm.monthly_rules)<>13 THEN
        RAISE EXCEPTION 'Existing 159-rule baseline is not present; verify permanent recurrence setup';
    END IF;
    IF EXISTS (SELECT 1 FROM pm_v2_plants v LEFT JOIN public.pm_cycle_plans cp ON cp.plant_id=v.plant_id
        WHERE cp.id IS NULL OR strpos(coalesce(cp.notes,''),'[PM_TRACKING_START=2026-12-01]')=0) THEN
        RAISE EXCEPTION 'Missing recurring plan or December start marker; verify permanent recurrence setup';
    END IF;
    IF EXISTS (SELECT 1 FROM (SELECT plant_id,count(*) AS n,min(inverter_no) AS lo,max(inverter_no) AS hi
          FROM solar91_pm.monthly_rules WHERE equipment='Inverter' GROUP BY plant_id) r
        LEFT JOIN LATERAL (SELECT count(*) AS n,max(total_units) AS total FROM public.pm_unit_config c
          WHERE c.plant_id=r.plant_id AND lower(btrim(c.equipment_type))='inverter') c ON true
        WHERE c.n<>1 OR c.total IS DISTINCT FROM r.n OR r.lo<>1 OR r.hi<>r.n) THEN
        RAISE EXCEPTION 'Inverter count/number mismatch; reconcile pm_unit_config and rules';
    END IF;
END $$;

-- Read the existing phase start days, not new or invented calendar dates.
CREATE TEMP TABLE pm_v2_new_rules ON COMMIT DROP AS
SELECT v.plant_id, ph->>'phase' AS equipment,
    CASE ph->>'phase'
        WHEN 'IDT Transformer' THEN 'IDT Transformer — plant visit'
        WHEN 'VCB' THEN 'VCB — plant visit'
        WHEN 'GSS visit' THEN 'GSS visit — GSS side'
    END AS equipment_id,
    (ph->>'start_day')::integer AS day_no
FROM pm_v2_plants v JOIN public.pm_cycle_plans cp ON cp.plant_id=v.plant_id
CROSS JOIN LATERAL jsonb_array_elements(cp.phases::jsonb) AS phases(ph)
WHERE ph->>'phase' IN ('IDT Transformer','VCB','GSS visit');
DO $$ BEGIN
    IF (SELECT count(*) FROM pm_v2_new_rules)<>39 OR
       (SELECT count(DISTINCT (plant_id,equipment)) FROM pm_v2_new_rules)<>39 OR
       EXISTS (SELECT 1 FROM pm_v2_new_rules WHERE day_no IS NULL OR day_no NOT BETWEEN 1 AND 31) THEN
        RAISE EXCEPTION 'Expected exactly one IDT, VCB and GSS phase per plant';
    END IF;
    IF EXISTS (SELECT 1 FROM solar91_pm.monthly_rules r WHERE r.equipment IN ('IDT Transformer','VCB','GSS visit')
        AND NOT EXISTS (SELECT 1 FROM pm_v2_new_rules n WHERE (n.plant_id,n.equipment,n.equipment_id,n.day_no)=(r.plant_id,r.equipment,r.equipment_id,r.day_no))) THEN
        RAISE EXCEPTION 'Existing new-category rule conflicts; no schedule overwritten';
    END IF;
END $$;

-- Expand only the equipment constraints. Keep RLS, foreign keys and unique indexes.
ALTER TABLE public.pm_tracking_activities DROP CONSTRAINT IF EXISTS pm_tracking_activities_equipment_check;
ALTER TABLE public.pm_tracking_activities ADD CONSTRAINT pm_tracking_activities_equipment_check
    CHECK (equipment IN ('Inverter','ACCB','IDT Transformer','VCB','4 Pole + ACDB + Aux. TX','Transmission line','GSS visit','Earth pit','Miscellaneous'));
ALTER TABLE solar91_pm.monthly_rules DROP CONSTRAINT IF EXISTS monthly_rules_equipment_check;
ALTER TABLE solar91_pm.monthly_rules ADD CONSTRAINT monthly_rules_equipment_check
    CHECK (equipment IN ('Inverter','ACCB','IDT Transformer','VCB','4 Pole + ACDB + Aux. TX','Transmission line','GSS visit','Earth pit','Miscellaneous'));
INSERT INTO solar91_pm.monthly_rules(plant_id,equipment,equipment_id,day_no,inverter_no)
SELECT plant_id,equipment,equipment_id,day_no,NULL FROM pm_v2_new_rules
ON CONFLICT (plant_id,equipment,equipment_id) DO NOTHING;
DO $$ BEGIN
    IF (SELECT count(*) FROM solar91_pm.monthly_rules)<>198 THEN
        RAISE EXCEPTION 'Expected 198 total recurring rules';
    END IF;
END $$;

-- Prepare all already generated months. Existing activities are immutable.
CREATE TEMP TABLE pm_v2_expected ON COMMIT DROP AS
SELECT g.month_start, r.plant_id,r.equipment,r.equipment_id,
    g.month_start + least(r.day_no,((g.month_start+interval '1 month')::date-g.month_start))-1 AS scheduled_on
FROM solar91_pm.generated_months g CROSS JOIN solar91_pm.monthly_rules r;
CREATE UNIQUE INDEX ON pm_v2_expected(plant_id,equipment,equipment_id,scheduled_on);
DO $$ BEGIN
    -- Detect unexpected records rather than creating duplicate-looking schedules.
    IF EXISTS (SELECT 1 FROM public.pm_tracking_activities a JOIN pm_v2_plants v ON v.plant_id=a.plant_id
        JOIN solar91_pm.generated_months g ON a.scheduled_on>=g.month_start AND a.scheduled_on<(g.month_start+interval '1 month')::date
        WHERE NOT EXISTS (SELECT 1 FROM pm_v2_expected e WHERE (e.plant_id,e.equipment,e.equipment_id,e.scheduled_on)=(a.plant_id,a.equipment,a.equipment_id,a.scheduled_on))) THEN
        RAISE EXCEPTION 'An existing generated month contains unexpected assignments; review before upgrade';
    END IF;
    IF EXISTS (SELECT 1 FROM pm_v2_expected e WHERE e.equipment NOT IN ('IDT Transformer','VCB','GSS visit')
        AND NOT EXISTS (SELECT 1 FROM public.pm_tracking_activities a WHERE (a.plant_id,a.equipment,a.equipment_id,a.scheduled_on)=(e.plant_id,e.equipment,e.equipment_id,e.scheduled_on))) THEN
        RAISE EXCEPTION 'An existing generated month is missing a baseline assignment; repair before upgrade';
    END IF;
    -- Do not introduce earlier blockers or change a historical compliance denominator mid-cycle.
    IF EXISTS (SELECT 1 FROM pm_v2_expected e WHERE e.equipment IN ('IDT Transformer','VCB','GSS visit')
        AND NOT EXISTS (SELECT 1 FROM public.pm_tracking_activities a WHERE (a.plant_id,a.equipment,a.equipment_id,a.scheduled_on)=(e.plant_id,e.equipment,e.equipment_id,e.scheduled_on))
        AND EXISTS (SELECT 1 FROM public.pm_tracking_activities a JOIN pm_v2_plants v ON v.plant_id=a.plant_id
            WHERE a.scheduled_on>=e.month_start AND a.scheduled_on<(e.month_start+interval '1 month')::date
              AND (a.status<>'Scheduled' OR a.permission<>'None' OR a.submitted_at IS NOT NULL OR a.reviewed_at IS NOT NULL OR a.requested_at IS NOT NULL OR a.authorised_at IS NOT NULL OR a.checklist::jsonb<>'[]'::jsonb))) THEN
        RAISE EXCEPTION 'A month needing expansion already has activity history; review with O&M Head before adding new blockers';
    END IF;
    IF EXISTS (SELECT 1 FROM pm_v2_expected e WHERE e.equipment IN ('IDT Transformer','VCB','GSS visit')
        AND NOT EXISTS (SELECT 1 FROM public.pm_tracking_activities a WHERE (a.plant_id,a.equipment,a.equipment_id,a.scheduled_on)=(e.plant_id,e.equipment,e.equipment_id,e.scheduled_on))
        AND EXISTS (SELECT 1 FROM public.om_tasks t WHERE t.plant_id=e.plant_id
          AND ((t.due_on>=e.month_start AND t.due_on<(e.month_start+interval '1 month')::date) OR (t.planned_due_on>=e.month_start AND t.planned_due_on<(e.month_start+interval '1 month')::date) OR (t.start_on>=e.month_start AND t.start_on<(e.month_start+interval '1 month')::date))
          AND CASE e.equipment
            WHEN 'IDT Transformer' THEN lower(btrim(t.task_type)) IN ('idt','idt transformer','transformer')
            WHEN 'VCB' THEN lower(btrim(t.task_type)) IN ('vcb','vcb panel')
            WHEN 'GSS visit' THEN lower(btrim(t.task_type)) IN ('gss visit','vcb - gss side','4 pole - gss side','switchyard')
            ELSE false END)) THEN
        RAISE EXCEPTION 'Overlapping legacy PM work orders; reconcile before inserting new activities';
    END IF;
END $$;

-- Only insert the missing categories. Update the existing ledger without regenerating history.
WITH added AS (
    INSERT INTO public.pm_tracking_activities(plant_id,equipment,equipment_id,scheduled_on)
    SELECT plant_id,equipment,equipment_id,scheduled_on FROM pm_v2_expected
    WHERE equipment IN ('IDT Transformer','VCB','GSS visit')
    ON CONFLICT (plant_id,equipment,equipment_id,scheduled_on) DO NOTHING
    RETURNING scheduled_on
), per_month AS (
    SELECT date_trunc('month',scheduled_on::timestamp)::date AS month_start,count(*)::integer AS n
    FROM added GROUP BY 1
)
UPDATE solar91_pm.generated_months g SET activity_count=198,
    inserted_count=g.inserted_count+coalesce((SELECT n FROM per_month p WHERE p.month_start=g.month_start),0)
WHERE g.activity_count<>198 OR EXISTS (SELECT 1 FROM per_month p WHERE p.month_start=g.month_start);
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pm_v2_expected e WHERE NOT EXISTS (SELECT 1 FROM public.pm_tracking_activities a
        WHERE (a.plant_id,a.equipment,a.equipment_id,a.scheduled_on)=(e.plant_id,e.equipment,e.equipment_id,e.scheduled_on))) THEN
        RAISE EXCEPTION 'Upgrade verification failed: missing assignment';
    END IF;
END $$;

-- Update future generation to recognise all nine categories; preserve the existing function grants.
CREATE OR REPLACE FUNCTION solar91_pm.ensure_month(p_month date)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
    v_end date;
    v_days integer;
    v_count integer;
    v_inserted integer;
BEGIN
    IF p_month IS NULL OR p_month < DATE '2026-12-01' OR extract(day FROM p_month)<>1 THEN
        RAISE EXCEPTION 'Month must be its first day, on or after December 2026';
    END IF;
    PERFORM pg_advisory_xact_lock(91391020261201);
    -- A generated month is immutable to automation; manual changes and history stay intact.
    IF EXISTS (SELECT 1 FROM solar91_pm.generated_months WHERE month_start=p_month) THEN RETURN 0; END IF;
    LOCK TABLE solar91_pm.monthly_rules IN SHARE MODE;
    SELECT count(*) INTO v_count FROM solar91_pm.monthly_rules;
    IF v_count=0 THEN RAISE EXCEPTION 'No PM rules configured'; END IF;
    v_end := (p_month + interval '1 month')::date;
    v_days := v_end-p_month;
    PERFORM p.id FROM public.plants p WHERE p.id IN (SELECT plant_id FROM solar91_pm.monthly_rules) ORDER BY p.id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM solar91_pm.monthly_rules r JOIN public.plants p ON p.id=r.plant_id WHERE lower(coalesce(p.status,''))='inactive') THEN
        RAISE EXCEPTION 'A plant with PM rules is inactive; review its rules';
    END IF;
    IF EXISTS (
        SELECT 1 FROM (SELECT plant_id,count(*) AS n,min(inverter_no) AS lo,max(inverter_no) AS hi
          FROM solar91_pm.monthly_rules WHERE equipment='Inverter' GROUP BY plant_id) r
        LEFT JOIN LATERAL (SELECT count(*) AS n,max(total_units) AS total FROM public.pm_unit_config c
          WHERE c.plant_id=r.plant_id AND lower(btrim(c.equipment_type))='inverter') c ON true
        WHERE c.n<>1 OR c.total IS DISTINCT FROM r.n OR r.lo<>1 OR r.hi<>r.n
    ) THEN RAISE EXCEPTION 'Inverter count/number mismatch; reconcile pm_unit_config and rules'; END IF;
    -- Reject a conflicting existing assignment; preserve matching rows and all recorded status.
    IF EXISTS (SELECT 1 FROM public.pm_tracking_activities a
      WHERE a.plant_id IN (SELECT plant_id FROM solar91_pm.monthly_rules)
      AND a.scheduled_on>=p_month AND a.scheduled_on<v_end
      AND NOT EXISTS (SELECT 1 FROM solar91_pm.monthly_rules r WHERE r.plant_id=a.plant_id AND r.equipment=a.equipment AND r.equipment_id=a.equipment_id
        AND a.scheduled_on=p_month+least(r.day_no,v_days)-1)) THEN
        RAISE EXCEPTION 'Different existing checklist schedule in %; no records overwritten',p_month;
    END IF;
    -- If legacy orders overlap covered equipment, require manual reconciliation before new inserts.
    IF EXISTS (SELECT 1 FROM solar91_pm.monthly_rules r
      WHERE NOT EXISTS (SELECT 1 FROM public.pm_tracking_activities a WHERE (a.plant_id,a.equipment,a.equipment_id,a.scheduled_on)=(r.plant_id,r.equipment,r.equipment_id,p_month+least(r.day_no,v_days)-1))
      AND EXISTS (SELECT 1 FROM public.om_tasks t WHERE t.plant_id=r.plant_id
        AND ((t.due_on>=p_month AND t.due_on<v_end) OR (t.planned_due_on>=p_month AND t.planned_due_on<v_end) OR (t.start_on>=p_month AND t.start_on<v_end))
        AND CASE r.equipment
          WHEN 'Inverter' THEN lower(btrim(t.task_type))='inverter'
          WHEN 'IDT Transformer' THEN lower(btrim(t.task_type)) IN ('idt','idt transformer','transformer')
          WHEN 'VCB' THEN lower(btrim(t.task_type)) IN ('vcb','vcb panel')
          WHEN 'GSS visit' THEN lower(btrim(t.task_type)) IN ('gss visit','vcb - gss side','4 pole - gss side','switchyard')
          WHEN 'ACCB' THEN lower(btrim(t.task_type)) IN ('accb','accb panel')
          WHEN '4 Pole + ACDB + Aux. TX' THEN lower(btrim(t.task_type)) IN ('4 pole','4 pole + acdb + aux. tx','acdb','aux. transformer','auxiliary transformer','aux. transformer + acdb')
          WHEN 'Transmission line' THEN lower(btrim(t.task_type))='transmission line'
          WHEN 'Earth pit' THEN lower(btrim(t.task_type)) IN ('earthing','earth pit')
          WHEN 'Miscellaneous' THEN lower(btrim(t.task_type))='miscellaneous'
          ELSE false END)) THEN
        RAISE EXCEPTION 'Overlapping legacy PM work orders in %; reconcile before creating new activities',p_month;
    END IF;
    INSERT INTO public.pm_tracking_activities(plant_id,equipment,equipment_id,scheduled_on)
    SELECT plant_id,equipment,equipment_id,p_month+least(day_no,v_days)-1 FROM solar91_pm.monthly_rules
    ON CONFLICT (plant_id,equipment,equipment_id,scheduled_on) DO NOTHING;
    GET DIAGNOSTICS v_inserted=ROW_COUNT;
    IF (SELECT count(*) FROM public.pm_tracking_activities a WHERE a.plant_id IN (SELECT plant_id FROM solar91_pm.monthly_rules) AND a.scheduled_on>=p_month AND a.scheduled_on<v_end)<>v_count THEN
        RAISE EXCEPTION 'Generated activity count did not match rules for %',p_month;
    END IF;
    INSERT INTO solar91_pm.generated_months(month_start,activity_count,inserted_count) VALUES(p_month,v_count,v_inserted);
    RETURN v_inserted;
END $$;

-- Fill any missing months using the existing rolling-year function. No Cron required.
SELECT solar91_pm.ensure_rolling_year() AS newly_generated_activities;
SELECT month_start,activity_count,inserted_count FROM solar91_pm.generated_months ORDER BY month_start;
COMMIT;
