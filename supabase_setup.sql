-- Javi (online-first) — minimal schema + RLS
-- Run this in Supabase SQL Editor (one time).

-- Extensions for UUIDs
create extension if not exists pgcrypto;

-- GEAR
create table if not exists public.gear_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  description text default '',
  asset_tag text default '',
  serial text default '',
  qr_code text default '',
  location text default '',
  image_url text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- For existing projects, add missing QR column safely
alter table public.gear_items add column if not exists qr_code text default '';

-- EVENTS
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  location text default '',
  notes text default '',
  production_docs jsonb not null default '[]'::jsonb,
  assigned_people jsonb not null default '[]'::jsonb,
  status text not null default 'DRAFT',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.events add column if not exists production_docs jsonb not null default '[]'::jsonb;
alter table public.events add column if not exists assigned_people jsonb not null default '[]'::jsonb;


-- TEAM MEMBERS
create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  name text not null,
  title text default '',
  default_role text default '',
  phone text default '',
  email text default '',
  image_url text default '',
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.team_members add column if not exists workspace_id uuid;
alter table public.team_members add column if not exists image_url text default '';

-- KITS
create table if not exists public.kits (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text default '',
  item_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RESERVATIONS (one row per gear item reserved to an event)
create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  gear_item_id uuid not null references public.gear_items(id) on delete restrict,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default now()
);
create index if not exists reservations_event_id_idx on public.reservations(event_id);
create index if not exists reservations_gear_item_id_idx on public.reservations(gear_item_id);

-- CHECKOUTS (one row per checkout action; items is a list of gear ids)
create table if not exists public.checkouts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete set null,
  event_title text,
  custody text default '',
  due_at timestamptz not null,
  notes text default '',
  status text not null default 'OPEN',
  items uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  checked_out_at timestamptz not null default now(),
  returned_at timestamptz
);
create index if not exists checkouts_status_idx on public.checkouts(status);

-- --- RLS (everyone signed-in shares one workspace) ---
alter table public.gear_items enable row level security;
alter table public.events enable row level security;
alter table public.kits enable row level security;
alter table public.reservations enable row level security;
alter table public.checkouts enable row level security;
alter table public.team_members enable row level security;

-- Allow any authenticated user to read/write
do $$ begin
  create policy "auth_select_gear" on public.gear_items for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "auth_write_gear" on public.gear_items for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "auth_select_events" on public.events for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "auth_write_events" on public.events for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "auth_select_kits" on public.kits for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "auth_write_kits" on public.kits for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "auth_select_reservations" on public.reservations for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "auth_write_reservations" on public.reservations for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "auth_select_checkouts" on public.checkouts for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "auth_write_checkouts" on public.checkouts for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "auth_select_team_members" on public.team_members for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "auth_write_team_members" on public.team_members for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
