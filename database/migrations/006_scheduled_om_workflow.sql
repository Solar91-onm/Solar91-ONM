-- Scheduled O&M / Preventive Maintenance workflow enhancements
-- Keeps unplanned O&M Issues separate from recurring planned maintenance.

alter table om_tasks add column if not exists actual_completed_on date;
alter table om_tasks add column if not exists delay_days integer;
alter table om_tasks add column if not exists problem_found boolean not null default false;
alter table om_tasks add column if not exists recurrence_parent_no text;

alter table washing_tables add column if not exists secondary_inverter_no integer;
alter table washing_tables add column if not exists next_due_on date;

create index if not exists ix_om_tasks_due_status on om_tasks(due_on, status);
create index if not exists ix_om_tasks_plant_due on om_tasks(plant_id, due_on);
create index if not exists ix_washing_tables_plant_due on washing_tables(plant_id, next_due_on);
create index if not exists ix_washing_history_table_date on washing_history(washing_table_id, event_date desc);
