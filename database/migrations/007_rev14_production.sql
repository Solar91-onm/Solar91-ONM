-- rev14 -> production backend alignment
-- Four operational roles: O&M Head, Assignee/O&M Team, Administration, Site Engineer.
-- Viewer is a safe pending-access role for newly provisioned users.

alter table om_tasks add column if not exists problem text;
alter table om_tasks add column if not exists problem_source text;
alter table om_tasks add column if not exists evidence jsonb not null default '[]'::jsonb;

-- Retire prototype/legacy external roles safely rather than silently granting access.
update users set role='Assignee' where role='Technician';
update users set role='Viewer' where role in ('Client / Asset Owner','Vendor (limited)','Regional O&M Head');

insert into role_permissions(role, permissions) values
 ('O&M Head', '{"plants":["view","create","edit"],"issues":["view","create","edit","assign","reassign","close"],"tasks":["view","create","edit","assign","execute","complete"],"washing":["view","log","configure"],"admin":["view","manage"],"audit":["view"],"reports":["view"],"performance":["view"]}'::jsonb),
 ('Assignee', '{"plants":["view_assigned"],"issues":["view_assigned","create","progress","resolve"],"tasks":["view_assigned","create_in_scope","execute_assigned","complete_assigned"],"washing":["log_assigned"]}'::jsonb),
 ('Administration', '{"dashboard":["view"],"issues":["view"],"tasks":["view","create_problem_task"],"reports":["view"],"performance":["view"]}'::jsonb),
 ('Site Engineer', '{"dashboard":["view_own_plant"],"issues":["view_own_plant","create","progress","resolve"],"tasks":["view_own_plant","execute","complete"],"washing":["view_own_plant","log"]}'::jsonb),
 ('Viewer', '{}'::jsonb)
on conflict(role) do update set permissions=excluded.permissions, updated_at=now();

delete from role_permissions where role in ('Technician','Client / Asset Owner','Vendor (limited)','Regional O&M Head');

create index if not exists ix_om_tasks_problem on om_tasks(task_type, problem);
