-- Solar91 O&M Command Center — initial relational schema for Supabase PostgreSQL
-- Historical initial schema comment: authentication was later migrated to Supabase Auth.
create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  auth_provider text not null,
  external_subject text not null,
  email text,
  display_name text not null,
  role text not null default 'Viewer',
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(auth_provider, external_subject)
);

create table if not exists user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  csrf_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  user_agent text,
  ip_address inet
);

create table if not exists plants (
  id uuid primary key default gen_random_uuid(),
  site_code text not null unique,
  plant_name text not null,
  project_company text,
  district text,
  discom text,
  location text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  dc_capacity_kw numeric(14,3),
  ac_capacity_kw numeric(14,3),
  commissioned_on date,
  status text not null default 'active',
  assigned_engineer text,
  source text not null default 'database',
  custom_fields jsonb not null default '{}'::jsonb,
  legacy_payload jsonb not null default '{}'::jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_plant_assignments (
  user_id uuid not null references users(id) on delete cascade,
  plant_id uuid not null references plants(id) on delete cascade,
  assignment_role text,
  created_at timestamptz not null default now(),
  primary key(user_id, plant_id)
);

create table if not exists plant_custom_fields (
  id uuid primary key default gen_random_uuid(),
  field_key text not null unique,
  label text not null,
  data_type text not null default 'text',
  sort_order integer not null default 0,
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists plant_custom_values (
  plant_id uuid not null references plants(id) on delete cascade,
  field_id uuid not null references plant_custom_fields(id) on delete cascade,
  value jsonb,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key(plant_id, field_id)
);

create table if not exists equipment (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references plants(id) on delete cascade,
  equipment_code text,
  equipment_name text not null,
  equipment_type text,
  maker text,
  model text,
  serial_number text,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(plant_id, equipment_code)
);

create table if not exists issues (
  id uuid primary key default gen_random_uuid(),
  ticket_no text not null unique,
  plant_id uuid references plants(id) on delete set null,
  equipment_id uuid references equipment(id) on delete set null,
  equipment_ref text,
  vertical text,
  subcategory text,
  description text not null,
  severity text not null,
  status text not null default 'Open',
  occurred_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  etc_at timestamptz,
  assignee_text text,
  assigned_to uuid references users(id) on delete set null,
  maker text,
  impact text,
  photo_count integer not null default 0,
  vendor jsonb,
  closure jsonb,
  source_task text,
  reopened_from text,
  reopen_count integer not null default 0,
  legacy_payload jsonb not null default '{}'::jsonb,
  created_by uuid references users(id) on delete set null
);

create table if not exists issue_history (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues(id) on delete cascade,
  action text not null,
  status_from text,
  status_to text,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  actor_id uuid references users(id) on delete set null,
  actor_name text,
  created_at timestamptz not null default now()
);

create table if not exists handovers (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,
  handover_no text unique,
  plant_id uuid references plants(id) on delete set null,
  project_name text not null,
  location text,
  project_type text,
  capacity_mw numeric(14,3),
  dc_capacity text,
  gps text,
  asset_layout text,
  commissioned_text text,
  epc text,
  client text,
  status text not null,
  approval jsonb,
  certificate jsonb,
  log jsonb not null default '[]'::jsonb,
  legacy_payload jsonb not null default '{}'::jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists handover_items (
  id uuid primary key default gen_random_uuid(),
  handover_id uuid not null references handovers(id) on delete cascade,
  legacy_id text not null,
  category text,
  title text not null,
  mandatory boolean not null default false,
  assignee_text text,
  due_on date,
  status text not null,
  evidence jsonb not null default '[]'::jsonb,
  instructions text,
  payload jsonb not null default '{}'::jsonb,
  unique(handover_id, legacy_id)
);

create table if not exists om_tasks (
  id uuid primary key default gen_random_uuid(),
  work_order_no text not null unique,
  plant_id uuid references plants(id) on delete set null,
  task_name text not null,
  task_type text,
  equipment_ref text,
  frequency text,
  due_on date,
  assignee_text text,
  status text not null,
  sop text,
  safety text,
  tools text,
  duration text,
  completion jsonb,
  linked_issue text,
  log jsonb not null default '[]'::jsonb,
  legacy_payload jsonb not null default '{}'::jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists washing_config (
  plant_id uuid primary key references plants(id) on delete cascade,
  team jsonb not null default '[]'::jsonb,
  frequency_days integer not null default 14,
  updated_at timestamptz not null default now()
);

create table if not exists washing_tables (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,
  plant_id uuid references plants(id) on delete cascade,
  inverter_no integer,
  table_code text,
  rescheduled_to date,
  legacy_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists washing_history (
  id uuid primary key default gen_random_uuid(),
  washing_table_id uuid not null references washing_tables(id) on delete cascade,
  event_type text not null,
  event_date date,
  actor text,
  reason text,
  notes text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists inventory_items (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,
  plant_id uuid references plants(id) on delete set null,
  item_name text,
  sku text,
  quantity numeric(14,3),
  minimum_quantity numeric(14,3),
  unit text,
  location text,
  status text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists inventory_movements (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,
  inventory_item_id uuid references inventory_items(id) on delete set null,
  plant_id uuid references plants(id) on delete set null,
  movement_type text,
  quantity numeric(14,3),
  movement_at timestamptz,
  actor text,
  notes text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists permits (
  id uuid primary key default gen_random_uuid(),
  permit_no text not null unique,
  task_id uuid references om_tasks(id) on delete set null,
  plant_id uuid references plants(id) on delete set null,
  permit_type text,
  hazard text,
  loto boolean,
  valid_from timestamptz,
  valid_to timestamptz,
  status text,
  requested_by text,
  approver text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  incident_no text not null unique,
  plant_id uuid references plants(id) on delete set null,
  category text,
  severity text,
  status text,
  occurred_at timestamptz,
  description text,
  reported_by text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,
  plant_id uuid references plants(id) on delete set null,
  title text,
  document_type text,
  owner text,
  expires_on date,
  status text,
  storage_path text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,
  vendor_name text not null,
  contact text,
  email text,
  status text,
  categories jsonb not null default '[]'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists service_requests (
  id uuid primary key default gen_random_uuid(),
  request_no text not null unique,
  plant_id uuid references plants(id) on delete set null,
  project text,
  category text,
  priority text,
  provider text,
  owner text,
  estimate numeric(14,2),
  progress integer,
  status text,
  target_on date,
  history jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists notification_rules (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,
  event_name text not null,
  channel text,
  recipients text,
  tiers text,
  enabled boolean not null default true,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  user_id uuid references users(id) on delete cascade,
  event_type text,
  title text not null,
  message text,
  target_type text,
  target_id text,
  dedupe_key text,
  read_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists sla_contracts (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,
  plant_id uuid references plants(id) on delete set null,
  name text,
  severity text,
  target_hours numeric(12,2),
  status text,
  breach boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists offline_queue (
  id uuid primary key default gen_random_uuid(),
  legacy_id text not null unique,
  user_id uuid references users(id) on delete cascade,
  operation text,
  entity_type text,
  entity_id text,
  status text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists scada_telemetry (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid references plants(id) on delete cascade,
  site_ref text,
  source text,
  generation numeric(16,4),
  availability numeric(8,4),
  performance_ratio numeric(8,4),
  alarms integer,
  status text,
  observed_at timestamptz not null,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  legacy_id text,
  user_id uuid references users(id) on delete set null,
  actor_name text,
  action text not null,
  module text,
  entity_type text,
  entity_id text,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists app_settings (
  setting_key text primary key,
  setting_value jsonb not null,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists state_revisions (
  id smallint primary key default 1 check (id = 1),
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into state_revisions(id, revision) values (1,0) on conflict (id) do nothing;
