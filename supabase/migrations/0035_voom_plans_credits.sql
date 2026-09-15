-- 0035_voom_plans_credits.sql
-- Voom Plans + Credits + Clean Automation Modes v1
--
-- Additive, preserves data, no Stripe, no invoices, no team seats.
-- Guarantees:
--   - businesses.plan column default 'free' (free | pro | max)
--   - preserve existing allow_automatic_paid_media values; do NOT auto-enable
--   - new default for allow_automatic_paid_media becomes false (safe by default)
--   - voom_credit_ledger table: durable ledger with unique generation_id, owner-scoped RLS
--   - indexes for owner+month queries and generation_id lookups
--   - RPCs reserve_media_credits, refund_media_credits, settle_media_credits using pg_advisory_xact_lock for per-owner atomicity
--   - No double charge, no backbilling, no deletion of existing data

begin;

-- 1) Plans column on businesses
alter table public.businesses
  add column if not exists plan text not null default 'free'
  check (plan in ('free', 'pro', 'max'));

-- Preserve existing allow_automatic_paid_media = false and do not auto-enable.
-- Change default for future inserts to false (safe by default per v1).
alter table public.businesses
  alter column allow_automatic_paid_media set default false;

-- Ensure existing NULLs (if any) become false, but do NOT overwrite explicit true to false blindly?
-- Spec says preserve existing false, do not auto-enable. We keep existing values as-is.
-- Only ensure column is boolean not null (already is from 0031). No data rewrite needed.

-- 2) Credit ledger table
create table if not exists public.voom_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  generation_id text not null,
  media_type text check (media_type in ('image', 'video')),
  credits integer not null check (credits > 0),
  source text not null check (source in ('user_request', 'autopilot', 'grant', 'purchase', 'refund')),
  status text not null default 'reserved' check (status in ('reserved', 'settled', 'refunded', 'granted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Unique generation_id per owner prevents double-charge; global unique also safe because generation_id is uuid.
create unique index if not exists voom_credit_ledger_generation_id_uq
  on public.voom_credit_ledger (generation_id);

-- Owner + month index for allowance calculations
create index if not exists voom_credit_ledger_owner_created_idx
  on public.voom_credit_ledger (owner_user_id, created_at);

-- Owner + status for quick remaining calculations
create index if not exists voom_credit_ledger_owner_status_idx
  on public.voom_credit_ledger (owner_user_id, status);

-- Updated_at trigger
create or replace function public.voom_credit_ledger_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists voom_credit_ledger_updated_at on public.voom_credit_ledger;
create trigger voom_credit_ledger_updated_at
  before update on public.voom_credit_ledger
  for each row execute function public.voom_credit_ledger_touch_updated_at();

-- 3) RLS: owner-scoped, service_role bypasses
alter table public.voom_credit_ledger enable row level security;

drop policy if exists "owner can read own ledger" on public.voom_credit_ledger;
create policy "owner can read own ledger"
  on public.voom_credit_ledger for select
  using (auth.uid() = owner_user_id);

-- No insert/update/delete for authenticated role; only service_role (admin client) may write.
-- This enforces hard boundary: UI cannot write ledger directly.

-- 4) RPCs for atomic reservation with advisory lock

-- Helper to compute allowance from plan (reads businesses.plan if present, else free)
create or replace function public.voom_plan_allowance(p_owner_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan text;
begin
  select plan into v_plan from public.businesses where owner_user_id = p_owner_user_id limit 1;
  if v_plan = 'pro' then return 150; end if;
  if v_plan = 'max' then return 500; end if;
  return 0;
end;
$$;

-- Reserve credits: atomic per-owner
create or replace function public.reserve_media_credits(
  p_owner_user_id uuid,
  p_generation_id text,
  p_media_type text,
  p_credits integer,
  p_source text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowance integer;
  v_used integer;
  v_additional integer;
  v_remaining integer;
  v_month_start timestamptz;
  v_exists uuid;
begin
  -- Advisory lock per owner (transaction-scoped)
  perform pg_advisory_xact_lock(hashtext(p_owner_user_id::text));

  v_month_start := date_trunc('month', now() at time zone 'utc');

  -- Idempotency: if generation_id already exists, return already=true
  select id into v_exists from public.voom_credit_ledger
    where generation_id = p_generation_id
    and owner_user_id = p_owner_user_id
    limit 1;

  if v_exists is not null then
    -- Compute remaining for response
    select
      coalesce(sum(case when status in ('reserved','settled') and source in ('user_request','autopilot') then credits else 0 end),0),
      coalesce(sum(case when status = 'granted' and source in ('grant','purchase') then credits else 0 end),0)
    into v_used, v_additional
    from public.voom_credit_ledger
    where owner_user_id = p_owner_user_id
      and created_at >= v_month_start;

    v_allowance := public.voom_plan_allowance(p_owner_user_id);
    v_remaining := greatest(0, v_allowance + coalesce(v_additional,0) - coalesce(v_used,0));

    return jsonb_build_object('ok', true, 'already', true, 'remaining', v_remaining, 'allowance', v_allowance, 'used', v_used);
  end if;

  -- Compute current usage this month
  select
    coalesce(sum(case when status in ('reserved','settled') and source in ('user_request','autopilot') then credits else 0 end),0),
    coalesce(sum(case when status = 'granted' and source in ('grant','purchase') then credits else 0 end),0)
  into v_used, v_additional
  from public.voom_credit_ledger
  where owner_user_id = p_owner_user_id
    and created_at >= v_month_start;

  v_allowance := public.voom_plan_allowance(p_owner_user_id);
  v_remaining := greatest(0, v_allowance + coalesce(v_additional,0) - coalesce(v_used,0));

  if v_remaining < p_credits then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_credits', 'remaining', v_remaining, 'allowance', v_allowance, 'used', v_used);
  end if;

  -- Insert reservation
  insert into public.voom_credit_ledger (owner_user_id, generation_id, media_type, credits, source, status)
  values (p_owner_user_id, p_generation_id, p_media_type, p_credits, p_source, 'reserved');

  -- Recompute after insert
  v_used := v_used + p_credits;
  v_remaining := greatest(0, v_allowance + coalesce(v_additional,0) - v_used);

  return jsonb_build_object('ok', true, 'remaining', v_remaining, 'allowance', v_allowance, 'used', v_used);
exception when unique_violation then
  -- Race: generation_id inserted concurrently
  select
    coalesce(sum(case when status in ('reserved','settled') and source in ('user_request','autopilot') then credits else 0 end),0),
    coalesce(sum(case when status = 'granted' and source in ('grant','purchase') then credits else 0 end),0)
  into v_used, v_additional
  from public.voom_credit_ledger
  where owner_user_id = p_owner_user_id
    and created_at >= v_month_start;

  v_allowance := public.voom_plan_allowance(p_owner_user_id);
  v_remaining := greatest(0, v_allowance + coalesce(v_additional,0) - coalesce(v_used,0));

  return jsonb_build_object('ok', true, 'already', true, 'remaining', v_remaining, 'allowance', v_allowance, 'used', v_used);
end;
$$;

create or replace function public.refund_media_credits(
  p_owner_user_id uuid,
  p_generation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_owner_user_id::text));

  update public.voom_credit_ledger
    set status = 'refunded'
    where owner_user_id = p_owner_user_id
      and generation_id = p_generation_id
      and status in ('reserved','settled')
    returning id into v_row;

  if v_row is null then
    return jsonb_build_object('ok', true, 'refunded', false);
  end if;

  return jsonb_build_object('ok', true, 'refunded', true);
end;
$$;

create or replace function public.settle_media_credits(
  p_owner_user_id uuid,
  p_generation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_owner_user_id::text));

  update public.voom_credit_ledger
    set status = 'settled'
    where owner_user_id = p_owner_user_id
      and generation_id = p_generation_id
      and status = 'reserved'
    returning id into v_row;

  if v_row is null then
    return jsonb_build_object('ok', true, 'settled', false);
  end if;

  return jsonb_build_object('ok', true, 'settled', true);
end;
$$;

-- Grants for RPCs
revoke all on function public.voom_plan_allowance(uuid) from public;
revoke all on function public.reserve_media_credits(uuid,text,text,integer,text) from public;
revoke all on function public.refund_media_credits(uuid,text) from public;
revoke all on function public.settle_media_credits(uuid,text) from public;

grant execute on function public.reserve_media_credits(uuid,text,text,integer,text) to service_role;
grant execute on function public.refund_media_credits(uuid,text) to service_role;
grant execute on function public.settle_media_credits(uuid,text) to service_role;
grant execute on function public.voom_plan_allowance(uuid) to service_role;

-- Authenticated can call reserve/refund/settle only via service_role path (admin client), not directly.
-- No grant to authenticated or anon.

commit;
