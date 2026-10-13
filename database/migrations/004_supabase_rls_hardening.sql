-- Defense-in-depth for Supabase: this application does not use the browser Supabase client.
-- The FastAPI server connects directly to PostgreSQL. Enabling RLS with no anon/authenticated
-- policies prevents accidental exposure through Supabase REST/PostgREST if an anon key leaks.
do $$
declare
  t text;
begin
  foreach t in array array[
    'users','user_sessions','plants','user_plant_assignments','plant_custom_fields','plant_custom_values',
    'equipment','issues','issue_history','handovers','handover_items','om_tasks','washing_config','washing_tables',
    'washing_history','inventory_items','inventory_movements','permits','incidents','documents','vendors',
    'service_requests','notification_rules','notifications','sla_contracts','offline_queue','scada_telemetry',
    'audit_logs','app_settings','state_revisions','role_permissions'
  ] loop
    execute format('alter table if exists %I enable row level security', t);
    if exists (select 1 from pg_roles where rolname='anon') then
      execute format('revoke all on table %I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname='authenticated') then
      execute format('revoke all on table %I from authenticated', t);
    end if;
  end loop;
end $$;
