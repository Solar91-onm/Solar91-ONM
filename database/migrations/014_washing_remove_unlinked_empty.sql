-- 014: remove phantom washing tables that belong to no plant and have no wash/exception history
-- (created by an earlier setup that ran without a real plant). Tables with history are kept so
-- they can be re-assigned from the Washing page. Idempotent.
delete from washing_history where washing_table_id in (
  select w.id from washing_tables w
  where w.plant_id is null
    and not exists (select 1 from washing_history h where h.washing_table_id = w.id)
);
delete from washing_tables w
 where w.plant_id is null
   and not exists (select 1 from washing_history h where h.washing_table_id = w.id);
