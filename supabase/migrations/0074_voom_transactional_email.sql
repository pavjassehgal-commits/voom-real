-- VOOM account emails only. Independent of business marketing migration 0073.
-- Additive; OFF until an operator explicitly enables both DB policy and app.
-- No backfill, auth trigger, schedule, provider request or existing-row change.
begin;
create table public.voom_transactional_email_policy (
  id boolean primary key default true check(id),
  enabled boolean not null default false,
  welcome_start_at timestamptz,
  next_send_at timestamptz not null default now(),
  quota_day date, day_attempts integer not null default 0,
  quota_month date, month_attempts integer not null default 0,
  check(not enabled or welcome_start_at is not null)
);
insert into public.voom_transactional_email_policy(id) values(true);
create table public.voom_transactional_emails (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'welcome' check(kind='welcome'),
  recipient text not null,
  status text not null default 'pending' check(status in ('pending','sending','retryable','uncertain','accepted','delivered','failed','bounced','complained','cancelled')),
  attempts integer not null default 0 check(attempts between 0 and 3),
  claim_token uuid, claimed_at timestamptz, first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  payload jsonb, provider_message_id text unique, error_code text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(owner_user_id,kind)
);
create index voom_transactional_due_idx on public.voom_transactional_emails(next_attempt_at,created_at)
  where status in ('pending','retryable');
create table public.voom_transactional_email_receipts (
  event_id text primary key check(length(event_id) between 1 and 200),
  email_id uuid not null references public.voom_transactional_emails(id) on delete cascade,
  provider_message_id text not null check(length(provider_message_id) between 1 and 200),
  status text not null check(status in ('accepted','delivered','failed','bounced','complained')),
  received_at timestamptz not null default now()
);
create table public.voom_auth_email_limits (
  subject_hash text not null check(subject_hash ~ '^[a-f0-9]{64}$'),
  window_start timestamptz not null,
  count integer not null check(count>0),
  primary key(subject_hash,window_start)
);

create function public.consume_voom_auth_email_limit(p_ip_hash text,p_email_hash text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_key text; v_window timestamptz; v_limit integer; v_count integer; i integer;
begin
  if p_ip_hash is null or p_email_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$' or p_email_hash !~ '^[a-f0-9]{64}$' then return false; end if;
  -- Fixed order, bounded global budget; hash inputs are HMACs, not raw email/IP.
  for i in 1..3 loop
    v_key:=case i when 1 then p_ip_hash when 2 then p_email_hash else repeat('0',64) end;
    v_limit:=case i when 1 then 5 when 2 then 3 else 30 end;
    v_window:=to_timestamp(floor(extract(epoch from now()) / case i when 1 then 900 else 3600 end) * case i when 1 then 900 else 3600 end);
    v_count:=null;
    insert into public.voom_auth_email_limits as r values(v_key,v_window,1)
    on conflict(subject_hash,window_start) do update set count=r.count+1 where r.count<v_limit returning count into v_count;
    if v_count is null then return false; end if;
  end loop;
  delete from public.voom_auth_email_limits where ctid in
    (select ctid from public.voom_auth_email_limits where window_start<now()-interval '2 days' limit 200);
  return true;
end $$;

create function public.queue_voom_welcome(p_owner uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  insert into public.voom_transactional_emails(owner_user_id,recipient)
  select u.id,u.email from auth.users u cross join public.voom_transactional_email_policy p
  where p.id and p.enabled and u.id=p_owner and u.email is not null and u.email_confirmed_at is not null and u.confirmation_sent_at is not null
    and u.created_at>=p.welcome_start_at
  on conflict(owner_user_id,kind) do nothing;
end $$;

create function public.claim_voom_transactional_email()
returns setof public.voom_transactional_emails language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.voom_transactional_email_policy; e public.voom_transactional_emails; v_email text; v_confirmed timestamptz;
  v_day date:=(now() at time zone 'UTC')::date; v_month date:=date_trunc('month',now() at time zone 'UTC')::date;
begin
  select * into p from public.voom_transactional_email_policy where id for update;
  if p.enabled is distinct from true or p.next_send_at>now() then return; end if;
  if (p.quota_day=v_day and p.day_attempts>=50) or (p.quota_month=v_month and p.month_attempts>=500) then return; end if;
  -- Recover an interrupted signup/callback enqueue without an auth trigger.
  -- Auto-confirmed/unverified signups and pre-activation accounts are excluded.
  insert into public.voom_transactional_emails(owner_user_id,recipient)
    select u.id,u.email from auth.users u where u.created_at>=p.welcome_start_at
      and u.email is not null and u.email_confirmed_at is not null and u.confirmation_sent_at is not null
      and not exists(select 1 from public.voom_transactional_emails x where x.owner_user_id=u.id and x.kind='welcome')
    order by u.created_at,u.id limit 50 on conflict(owner_user_id,kind) do nothing;
  -- A crashed/uncertain submission is NEVER automatically reclaimed or resent.
  update public.voom_transactional_emails set status='uncertain',error_code='stale_claim',updated_at=now()
    where status='sending' and claimed_at<now()-interval '90 seconds';
  update public.voom_transactional_emails set status='failed',error_code='retry_window_expired',updated_at=now()
    where status='retryable' and first_attempt_at<now()-interval '23 hours';
  select * into e from public.voom_transactional_emails
    where status in ('pending','retryable') and attempts<3 and next_attempt_at<=now()
    order by next_attempt_at,created_at limit 1 for update skip locked;
  if not found then return; end if;
  select email,email_confirmed_at into v_email,v_confirmed from auth.users where id=e.owner_user_id and confirmation_sent_at is not null for share;
  if v_confirmed is null or v_email is distinct from e.recipient then
    update public.voom_transactional_emails set status='cancelled',error_code='identity_changed',updated_at=now() where id=e.id;
    return;
  end if;
  update public.voom_transactional_email_policy set next_send_at=now()+interval '1 second',quota_day=v_day,
    day_attempts=case when quota_day=v_day then day_attempts+1 else 1 end,quota_month=v_month,
    month_attempts=case when quota_month=v_month then month_attempts+1 else 1 end where id;
  return query update public.voom_transactional_emails set status='sending',attempts=attempts+1,
    claim_token=gen_random_uuid(),claimed_at=now(),first_attempt_at=coalesce(first_attempt_at,now()),updated_at=now()
    where id=e.id returning *;
end $$;

create function public.prepare_voom_transactional_email(p_id uuid,p_claim uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.voom_transactional_emails;
begin
  select * into e from public.voom_transactional_emails where id=p_id for update;
  if not found or e.status<>'sending' or e.claim_token is distinct from p_claim or e.claimed_at<now()-interval '60 seconds' then raise exception 'transactional_claim_invalid'; end if;
  if e.payload is not null then return e.payload; end if;
  if p_payload is null or p_payload->'to' is distinct from jsonb_build_array(e.recipient)
     or jsonb_typeof(p_payload->'html') is distinct from 'string' or jsonb_typeof(p_payload->'text') is distinct from 'string' then raise exception 'transactional_payload_invalid'; end if;
  update public.voom_transactional_emails set payload=p_payload where id=e.id;
  return p_payload;
end $$;

create function public.finish_voom_transactional_email(p_id uuid,p_claim uuid,p_status text,p_message_id text,p_error text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_status is null or p_status not in ('accepted','failed','uncertain','retryable') or (p_status='accepted' and nullif(p_message_id,'') is null)
    or (p_error is not null and p_error !~ '^[a-z0-9_]{1,64}$') then raise exception 'transactional_result_invalid'; end if;
  update public.voom_transactional_emails set status=case when p_status='retryable' and attempts>=3 then 'failed' else p_status end,
    provider_message_id=p_message_id,error_code=p_error,next_attempt_at=now()+interval '1 minute',updated_at=now()
    where id=p_id and claim_token=p_claim and status='sending';
end $$;

create function public.record_voom_transactional_receipt(p_id uuid,p_event_id text,p_message_id text,p_status text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.voom_transactional_emails; v_receipt public.voom_transactional_email_receipts;
begin
  if p_status is null or p_status not in ('accepted','delivered','failed','bounced','complained') then raise exception 'transactional_event_invalid'; end if;
  select * into e from public.voom_transactional_emails where id=p_id for update;
  if not found or e.payload is null then raise exception 'transactional_event_unbound'; end if;
  if e.provider_message_id is not null and e.provider_message_id<>p_message_id then raise exception 'transactional_message_conflict'; end if;
  insert into public.voom_transactional_email_receipts(event_id,email_id,provider_message_id,status)
    values(p_event_id,p_id,p_message_id,p_status) on conflict(event_id) do nothing;
  select * into v_receipt from public.voom_transactional_email_receipts where event_id=p_event_id;
  if v_receipt.email_id<>p_id or v_receipt.provider_message_id<>p_message_id or v_receipt.status<>p_status then raise exception 'transactional_event_conflict'; end if;
  update public.voom_transactional_emails set provider_message_id=p_message_id,
    status=case when array_position(array['pending','sending','retryable','uncertain','accepted','delivered','failed','bounced','complained'],p_status)
      >coalesce(array_position(array['pending','sending','retryable','uncertain','accepted','delivered','failed','bounced','complained'],status),100)
      then p_status else status end,updated_at=now() where id=p_id;
end $$;

alter table public.voom_transactional_email_policy enable row level security;
alter table public.voom_transactional_emails enable row level security;
alter table public.voom_transactional_email_receipts enable row level security;
alter table public.voom_auth_email_limits enable row level security;
revoke all on public.voom_transactional_email_policy,public.voom_transactional_emails,public.voom_transactional_email_receipts,public.voom_auth_email_limits from public,anon,authenticated;
grant select,insert,update,delete on public.voom_transactional_email_policy,public.voom_transactional_emails,public.voom_transactional_email_receipts,public.voom_auth_email_limits to service_role;
revoke all on function public.consume_voom_auth_email_limit(text,text),public.queue_voom_welcome(uuid),public.claim_voom_transactional_email(),public.prepare_voom_transactional_email(uuid,uuid,jsonb),public.finish_voom_transactional_email(uuid,uuid,text,text,text),public.record_voom_transactional_receipt(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.consume_voom_auth_email_limit(text,text),public.queue_voom_welcome(uuid),public.claim_voom_transactional_email(),public.prepare_voom_transactional_email(uuid,uuid,jsonb),public.finish_voom_transactional_email(uuid,uuid,text,text,text),public.record_voom_transactional_receipt(uuid,text,text,text) to service_role;
commit;
