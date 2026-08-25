-- Voom: profiles and businesses tables with Row Level Security.
--
-- How to apply: open the Supabase Dashboard for this project, go to
-- SQL Editor > New query, paste this entire file, and click Run.
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / DROP ... IF EXISTS).

create extension if not exists "pgcrypto";

-- ============================================================
-- profiles — one row per auth user, holds display-name only for now
-- ============================================================
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- businesses — one row per user's brand/workspace
-- ============================================================
create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users (id) on delete cascade,
  brand_name text,
  brand_description text,
  industry text,
  target_customer text[] not null default '{}',
  main_goal text,
  brand_personality text[] not null default '{}',
  preferred_channels text[] not null default '{}',
  monthly_ad_budget text,
  content_frequency text,
  automation_level text,
  publishing_permission text,
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists businesses_owner_user_id_idx on public.businesses (owner_user_id);

-- ============================================================
-- keep updated_at current on every update
-- ============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists set_businesses_updated_at on public.businesses;
create trigger set_businesses_updated_at
  before update on public.businesses
  for each row execute function public.set_updated_at();

-- ============================================================
-- Row Level Security — a user may only read/write their own rows
-- ============================================================
alter table public.profiles enable row level security;
alter table public.businesses enable row level security;

-- RLS decides which rows an authenticated user may access, but the API role
-- still needs table-level privileges before PostgREST can evaluate those
-- policies. Keep anonymous visitors locked out.
revoke all on table public.profiles from anon;
revoke all on table public.businesses from anon;
grant select, insert, update on table public.profiles to authenticated;
grant select, insert, update on table public.businesses to authenticated;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "businesses_select_own" on public.businesses;
create policy "businesses_select_own" on public.businesses
  for select to authenticated
  using (auth.uid() = owner_user_id);

drop policy if exists "businesses_insert_own" on public.businesses;
create policy "businesses_insert_own" on public.businesses
  for insert to authenticated
  with check (auth.uid() = owner_user_id);

drop policy if exists "businesses_update_own" on public.businesses;
create policy "businesses_update_own" on public.businesses
  for update to authenticated
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);
