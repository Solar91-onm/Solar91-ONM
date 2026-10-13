-- 012: re-link washing tables that lost their plant (plant_id IS NULL).
-- Cause: the plant was saved as free text ("Kerli Nadi " / different case / extra spaces),
-- the exact-name lookup failed and the table was stored without a plant. Those tables still
-- counted as "due" but appeared under no plant. Idempotent: only touches rows with plant_id NULL,
-- and only when exactly one plant matches the normalised name or site code.
-- No schema change. Safe to run more than once.

with norm as (
  select id,
         lower(btrim(regexp_replace(plant_name, '\s+', ' ', 'g'))) as k,
         lower(btrim(site_code)) as c
  from plants
),
cand as (
  select w.id as wid,
         lower(btrim(regexp_replace(coalesce(w.legacy_payload->>'plant', ''), '\s+', ' ', 'g'))) as pk
  from washing_tables w
  where w.plant_id is null
),
hit as (
  select cand.wid, (array_agg(norm.id))[1] as pid
  from cand
  join norm on norm.k = cand.pk or norm.c = cand.pk
  where cand.pk <> ''
  group by cand.wid
  having count(distinct norm.id) = 1
)
update washing_tables w
   set plant_id = hit.pid,
       updated_at = now()
  from hit
 where w.id = hit.wid;

-- Check afterwards (should be 0, or only tables whose plant truly no longer exists):
--   select legacy_payload->>'plant' as plant_text, count(*) from washing_tables where plant_id is null group by 1;
