-- Role definitions mirror the prototype terminology. Authorization is enforced by FastAPI.
create table if not exists role_permissions (
  role text primary key,
  permissions jsonb not null,
  updated_at timestamptz not null default now()
);
insert into role_permissions(role, permissions) values
 ('O&M Head', '{"plants":["view","create","edit"],"issues":["view","create","edit","assign","reassign","close"],"handover":["view","create","edit","approve"],"tasks":["view","create","edit","assign","complete"],"washing":["view","log","configure"],"admin":["view","manage"],"audit":["view"]}'::jsonb),
 ('Site Engineer', '{"plants":["view"],"issues":["view","create","progress","resolve"],"handover":["view","execute"],"tasks":["view","execute","complete"],"washing":["view","log"]}'::jsonb),
 ('Technician', '{"plants":["view"],"issues":["view","create","progress"],"tasks":["view","execute"],"washing":["view","log"]}'::jsonb),
 ('Client / Asset Owner', '{"plants":["view"],"issues":["view"],"tasks":["view"],"washing":["view"],"documents":["view"]}'::jsonb),
 ('Vendor (limited)', '{"issues":["view_assigned","progress"]}'::jsonb),
 ('Viewer', '{"plants":["view"],"issues":["view"]}'::jsonb)
on conflict(role) do update set permissions = excluded.permissions, updated_at = now();
