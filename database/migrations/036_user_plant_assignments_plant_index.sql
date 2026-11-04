-- 036: index user_plant_assignments by plant.
--
-- The table's only index is its primary key (user_id, plant_id), which leads with user_id, so every
-- lookup by plant scans the table: the portal plant list / Overview people join, the Site Engineer
-- lookup per plant and the washing assignee picker all filter or join on plant_id.
--
-- Additive and safe to re-run. No data is changed. The table is small, so a plain (non-concurrent)
-- build finishes immediately and can be pasted into the Supabase SQL editor as is.
create index if not exists ix_user_plant_assignments_plant on public.user_plant_assignments (plant_id);
