-- After migration 052. Read current values first. NULL is valid for every plant.
SELECT site_code, plant_name, supervisor FROM public.plants ORDER BY site_code;
-- Example only; use verified plant code and actual name. Do not assign a fictional person.
-- UPDATE public.plants SET supervisor = 'ACTUAL_SUPERVISOR_NAME', updated_at = now() WHERE site_code = 'ACTUAL_SITE_CODE';
-- To clear a supervisor for one plant:
-- UPDATE public.plants SET supervisor = NULL, updated_at = now() WHERE site_code = 'ACTUAL_SITE_CODE';
