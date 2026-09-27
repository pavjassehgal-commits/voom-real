-- 0051: Per-owner AI request rate limits.
--
-- Every route that reaches the text AI provider (post suggestions, campaign
-- builds and regenerations, email-flow drafts, plan runs, Post Studio copy)
-- consumes one unit from a fixed-window counter before calling the provider.
-- This bounds how fast one account can spend provider budget, independent of
-- the media credit ledger (which already guards paid image/video generation).
--
-- Service-role only: the browser has no access to the table or the function.
-- Additive and idempotent.

begin;

create table if not exists public.voom_rate_limits (
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  bucket text not null check (char_length(bucket) between 1 and 64),
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (owner_user_id, bucket, window_start)
);

alter table public.voom_rate_limits enable row level security;
revoke all on table public.voom_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.voom_rate_limits to service_role;

create index if not exists voom_rate_limits_window_idx
  on public.voom_rate_limits (window_start);

-- Atomically consumes one request. Returns true when the request is allowed,
-- false when the owner has used `p_limit` requests in the current window.
create or replace function public.consume_rate_limit(
  p_owner_user_id uuid,
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window timestamptz;
  v_count integer;
begin
  if p_owner_user_id is null or p_bucket is null or p_limit < 1 or p_window_seconds < 1 then
    raise exception 'invalid_rate_limit_arguments';
  end if;

  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.voom_rate_limits as r (owner_user_id, bucket, window_start, request_count)
  values (p_owner_user_id, p_bucket, v_window, 1)
  on conflict (owner_user_id, bucket, window_start)
  do update set request_count = r.request_count + 1
    where r.request_count < p_limit
  returning request_count into v_count;

  -- Opportunistic cleanup of this owner's expired windows (bounded, cheap).
  delete from public.voom_rate_limits
   where owner_user_id = p_owner_user_id
     and window_start < now() - interval '2 days';

  return v_count is not null;
end;
$$;

revoke all on function public.consume_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(uuid, text, integer, integer) to service_role;

commit;
