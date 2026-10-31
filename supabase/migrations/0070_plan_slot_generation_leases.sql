-- Marketing Plan slot generation leases (single-flight before paid generation).
--
-- Two concurrent Build/Replenish runs (a double click, or cron + Build) used to
-- generate MARA content for the same plan slot twice and keep only one draft:
-- the unique draft index deduplicated the WRITE, not the paid provider call.
-- A worker must now hold the slot's lease before it calls the provider:
--
--   claim   → one worker gets (lease_id, fence); every other worker gets no row
--             until the lease is released or expires (crash recovery);
--   held    → the fencing check a worker runs immediately before persisting, so
--             a stale worker whose lease expired and was re-claimed never writes;
--   release → ends the lease early (success or failure) so a retry can proceed.
--
-- The fence increases on every takeover. Rows hold no content and no secrets.
-- Service-role only: browsers and API roles can neither read nor call these.

create table if not exists public.plan_slot_generation_leases (
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid not null references public.marketing_plans(id) on delete cascade,
  slot_key text not null check (char_length(slot_key) between 1 and 80),
  lease_id uuid not null,
  fence bigint not null default 1 check (fence >= 1),
  leased_until timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (owner_user_id, plan_id, slot_key)
);

alter table public.plan_slot_generation_leases enable row level security;
revoke all on public.plan_slot_generation_leases from public, anon, authenticated;
grant all on public.plan_slot_generation_leases to service_role;

create or replace function public.claim_plan_slot_generation(
  p_owner_user_id uuid,
  p_plan_id uuid,
  p_slot_key text,
  p_lease_seconds integer
) returns table (lease_id uuid, fence bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_owner_user_id is null or p_plan_id is null or p_slot_key is null
    or char_length(p_slot_key) not between 1 and 80
    or p_lease_seconds is null or p_lease_seconds not between 10 and 600 then
    raise exception 'invalid_plan_slot_lease';
  end if;
  if not exists (
    select 1 from public.marketing_plans
    where id = p_plan_id and owner_user_id = p_owner_user_id
  ) then
    raise exception 'plan_slot_lease_plan_not_found';
  end if;

  return query
  insert into public.plan_slot_generation_leases as l
    (owner_user_id, plan_id, slot_key, lease_id, fence, leased_until, updated_at)
  values
    (p_owner_user_id, p_plan_id, p_slot_key, gen_random_uuid(), 1,
     now() + make_interval(secs => p_lease_seconds), now())
  on conflict (owner_user_id, plan_id, slot_key) do update set
    lease_id = excluded.lease_id,
    fence = l.fence + 1,
    leased_until = excluded.leased_until,
    updated_at = now()
  where l.leased_until <= now()
  returning l.lease_id, l.fence;
end;
$$;

create or replace function public.plan_slot_lease_held(
  p_owner_user_id uuid,
  p_plan_id uuid,
  p_slot_key text,
  p_lease_id uuid,
  p_fence bigint
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.plan_slot_generation_leases
    where owner_user_id = p_owner_user_id and plan_id = p_plan_id and slot_key = p_slot_key
      and lease_id = p_lease_id and fence = p_fence and leased_until > now()
  );
$$;

create or replace function public.release_plan_slot_generation(
  p_owner_user_id uuid,
  p_plan_id uuid,
  p_slot_key text,
  p_lease_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released integer;
begin
  update public.plan_slot_generation_leases
     set leased_until = now(), updated_at = now()
   where owner_user_id = p_owner_user_id and plan_id = p_plan_id and slot_key = p_slot_key
     and lease_id = p_lease_id and leased_until > now();
  get diagnostics v_released = row_count;
  return v_released > 0;
end;
$$;

revoke all on function public.claim_plan_slot_generation(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.plan_slot_lease_held(uuid, uuid, text, uuid, bigint) from public, anon, authenticated;
revoke all on function public.release_plan_slot_generation(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_plan_slot_generation(uuid, uuid, text, integer) to service_role;
grant execute on function public.plan_slot_lease_held(uuid, uuid, text, uuid, bigint) to service_role;
grant execute on function public.release_plan_slot_generation(uuid, uuid, text, uuid) to service_role;
