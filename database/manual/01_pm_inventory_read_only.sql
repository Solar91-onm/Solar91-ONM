-- READ ONLY. Run on Supabase after taking a backup and applying 051 and 052 if not present.
-- Export these results to identify live plants, old phase plans and real assignments.
BEGIN READ ONLY;
SELECT id, site_code, plant_name, status, supervisor FROM public.plants ORDER BY site_code;
SELECT p.site_code, c.* FROM public.pm_cycle_plans c JOIN public.plants p ON p.id=c.plant_id ORDER BY p.site_code;
SELECT p.site_code, u.* FROM public.pm_unit_config u JOIN public.plants p ON p.id=u.plant_id ORDER BY p.site_code,u.equipment_type;
SELECT p.site_code, date_trunc('month', a.scheduled_on::timestamp)::date AS month,
       a.equipment, a.status, a.permission, count(*) AS records
FROM public.pm_tracking_activities a JOIN public.plants p ON p.id=a.plant_id
GROUP BY p.site_code, month, a.equipment, a.status, a.permission ORDER BY p.site_code,month,a.equipment,a.status,a.permission;
SELECT p.site_code, t.id, t.work_order_no, t.task_name, t.task_type, t.status, t.due_on, t.planned_due_on,
       t.actual_completed_on, t.cycle_id
FROM public.om_tasks t LEFT JOIN public.plants p ON p.id=t.plant_id ORDER BY p.site_code,t.due_on,t.work_order_no;
COMMIT;
