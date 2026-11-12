-- Commercial marketing safety. Review/apply separately; never bulk-push.
-- Additive to 0072, independent of reserved YouTube migrations 0065/0069.
-- No legacy consent/domain ownership is inferred. No customer records rewritten.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table public.voom_email_domains (
  domain text not null check (domain = lower(domain) and domain ~ '^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$'),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  challenge text not null check (char_length(challenge) = 64),
  provider_domain_id text unique,
  dns_verified_at timestamptz,
  provider_verified_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(owner_user_id,domain)
);
create index voom_email_domains_owner on public.voom_email_domains(owner_user_id);
create unique index voom_email_domains_verified_domain on public.voom_email_domains(domain) where dns_verified_at is not null;

alter table public.voom_email_identities
  add column legal_name text check (char_length(legal_name) between 1 and 160),
  add column postal_address text check (char_length(postal_address) between 10 and 500);

alter table public.contacts
  add column email_consent_at timestamptz,
  add column email_consent_source text check (email_consent_source in ('manual_attestation','csv_attestation'));
create table public.voom_email_consent_events (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid not null,
  email text,
  status text not null,
  source text,
  actor_user_id uuid,
  recorded_at timestamptz not null default now()
);
create index voom_email_consent_events_owner on public.voom_email_consent_events(owner_user_id,recorded_at);

create function public.audit_marketing_email_consent() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- An address change must not inherit consent for a different address.
  if tg_op = 'UPDATE' and new.email is distinct from old.email then
    new.email_status := 'unknown'; new.email_consent_at := null; new.email_consent_source := null;
  end if;
  if new.email_status = 'subscribed' and
    (tg_op = 'INSERT' or new.email_status is distinct from old.email_status
     or new.email_consent_at is distinct from old.email_consent_at) then
    -- Legacy clients may still save a status without evidence. Preserve the
    -- preference, but NEVER authorize a send or invent an attestation for it.
    new.email_consent_at := case when new.email_consent_source is not null and new.email is not null then now() else null end;
  elsif new.email_status <> 'subscribed' then
    new.email_consent_at := null; new.email_consent_source := null;
  end if;
  if tg_op = 'INSERT' or new.email is distinct from old.email
    or new.email_status is distinct from old.email_status
    or new.email_consent_at is distinct from old.email_consent_at then
    insert into public.voom_email_consent_events(owner_user_id,contact_id,email,status,source,actor_user_id)
      values(new.owner_id,new.id,new.email,new.email_status,new.email_consent_source,auth.uid());
  end if;
  return new;
end $$;
revoke all on function public.audit_marketing_email_consent() from public,anon,authenticated;
create trigger audit_marketing_email_consent before insert or update on public.contacts
  for each row execute function public.audit_marketing_email_consent();

-- Operator-controlled limits, not subscription prices/credit allowances.
-- OFF until reviewed staging acceptance and explicit operator activation.
create table public.voom_email_sending_policy (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  business_daily_limit integer not null default 50 check (business_daily_limit between 1 and 10000),
  business_monthly_limit integer not null default 500 check (business_monthly_limit between 1 and 100000),
  provider_daily_limit integer not null default 90 check (provider_daily_limit between 1 and 100000),
  provider_monthly_limit integer not null default 2700 check (provider_monthly_limit between 1 and 1000000),
  provider_interval_ms integer not null default 1000 check (provider_interval_ms between 1000 and 60000),
  next_send_at timestamptz not null default '-infinity',
  next_api_at timestamptz not null default '-infinity'
);
insert into public.voom_email_sending_policy(id) values(true);
create function public.claim_marketing_email_provider_slot() returns integer
language plpgsql security definer set search_path = '' as $$
declare available timestamptz; wait_ms integer;
begin
  select next_api_at into available from public.voom_email_sending_policy where id for update;
  if not found then raise exception 'email_provider_throttle_unavailable'; end if;
  if available>clock_timestamp() then
    wait_ms:=ceil(extract(epoch from (available-clock_timestamp()))*1000)::integer;
    return least(greatest(wait_ms,1),1000);
  end if;
  update public.voom_email_sending_policy set next_api_at=clock_timestamp()+interval '500 milliseconds' where id;
  return 0;
end $$;
revoke all on function public.claim_marketing_email_provider_slot() from public,anon,authenticated;
grant execute on function public.claim_marketing_email_provider_slot() to service_role;
create table public.voom_email_business_controls (
  owner_user_id uuid primary key references auth.users(id) on delete cascade,
  suspended boolean not null default false
);
create table public.voom_email_submissions (
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  logical_key text not null check (char_length(logical_key) between 16 and 200),
  source_kind text not null check (source_kind in ('campaign','flow')),
  source_id uuid not null,
  recipient text not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('submitting','accepted','rejected','uncertain')),
  attempts integer not null default 1 check (attempts between 1 and 3),
  provider_message_id text unique,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(owner_user_id,logical_key),
  unique(owner_user_id,source_kind,source_id)
);
create index voom_email_submissions_budget on public.voom_email_submissions(created_at,owner_user_id);
create table public.voom_email_send_meter (
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  logical_key text not null,
  attempt integer not null,
  created_at timestamptz not null default now(),
  primary key(owner_user_id,logical_key,attempt)
);
create index voom_email_send_meter_budget on public.voom_email_send_meter(created_at,owner_user_id);
create function public.guard_uncertain_campaign_email_retry() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.last_error_code='provider_outcome_ambiguous' and new.internal_status='sending' then
    raise exception 'email_delivery_uncertain_do_not_resend';
  end if;
  return new;
end $$;
revoke all on function public.guard_uncertain_campaign_email_retry() from public,anon,authenticated;
create trigger guard_uncertain_campaign_email_retry before update on public.campaign_sends
  for each row execute function public.guard_uncertain_campaign_email_retry();
create table public.voom_email_webhook_receipts (
  event_id text primary key,
  provider_message_id text not null,
  event_type text not null,
  provider_status text,
  source_id uuid,
  source_kind text check (source_kind in ('campaign','flow')),
  received_at timestamptz not null,
  processed_at timestamptz
);
create index voom_email_webhooks_pending on public.voom_email_webhook_receipts(received_at) where processed_at is null;

-- Migration-first rollout: OFF blocks new claims in old and new application
-- versions. Already in-flight requests must be drained before installation.
create function public.guard_marketing_email_claim_activation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name='campaign_sends' then
    if new.internal_status<>'sending' or new.channel<>'email' then return new; end if;
  else
    if new.status<>'sending' then return new; end if;
  end if;
  if (select enabled from public.voom_email_sending_policy where id) is distinct from true then raise exception 'marketing_email_disabled'; end if;
  return new;
end $$;
revoke all on function public.guard_marketing_email_claim_activation() from public,anon,authenticated;
create trigger guard_marketing_email_claim_activation before insert or update on public.campaign_sends
  for each row execute function public.guard_marketing_email_claim_activation();
create trigger guard_marketing_email_claim_activation before insert or update on public.voom_email_flow_step_runs
  for each row execute function public.guard_marketing_email_claim_activation();

-- All sensitive writes are server-only. Owners can inspect only their own rows.
do $$ declare t text; begin
  foreach t in array array['voom_email_domains','voom_email_consent_events','voom_email_submissions','voom_email_send_meter','voom_email_business_controls'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('grant all on public.%I to service_role',t);
    execute format('create policy select_own on public.%I for select to authenticated using(owner_user_id = (select auth.uid()))',t);
  end loop;
end $$;
alter table public.voom_email_sending_policy enable row level security;
alter table public.voom_email_webhook_receipts enable row level security;
revoke all on public.voom_email_sending_policy,public.voom_email_webhook_receipts from public,anon,authenticated;
grant all on public.voom_email_sending_policy,public.voom_email_webhook_receipts to service_role;

create function public.claim_marketing_email_domain(p_owner uuid,p_domain text,p_challenge text)
returns public.voom_email_domains language plpgsql security definer set search_path = '' as $$
declare b uuid; r public.voom_email_domains;
begin
  perform pg_catalog.pg_advisory_xact_lock(7341001); -- serializes overlapping parent/subdomain claims
  select id into b from public.businesses where owner_user_id=p_owner;
  if b is null then raise exception 'business_not_found'; end if;
  if exists(select 1 from public.voom_email_domains where owner_user_id<>p_owner and dns_verified_at is not null and
    (domain=p_domain or domain like '%.'||p_domain or p_domain like '%.'||domain)) then
    raise exception 'domain_unavailable';
  end if;
  if (select count(*) from public.voom_email_domains where owner_user_id=p_owner)>=3
    and not exists(select 1 from public.voom_email_domains where domain=p_domain and owner_user_id=p_owner) then
    raise exception 'domain_limit_reached';
  end if;
  insert into public.voom_email_domains(domain,owner_user_id,business_id,challenge)
    values(p_domain,p_owner,b,p_challenge) on conflict(owner_user_id,domain) do nothing;
  select * into r from public.voom_email_domains where domain=p_domain and owner_user_id=p_owner;
  if not found then raise exception 'domain_unavailable'; end if;
  return r;
end $$;

-- Pending DNS challenges do not reserve somebody else's domain. Binding only
-- happens after the server proves this owner's unique TXT challenge.
create function public.bind_marketing_email_domain(p_owner uuid,p_domain text,p_provider text,p_verified boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(7341001);
  if exists(select 1 from public.voom_email_domains where owner_user_id<>p_owner and dns_verified_at is not null and
    (domain=p_domain or domain like '%.'||p_domain or p_domain like '%.'||domain)) then raise exception 'domain_unavailable'; end if;
  update public.voom_email_domains set provider_domain_id=p_provider,dns_verified_at=now(),
    provider_verified_at=case when p_verified then now() else null end
    where owner_user_id=p_owner and domain=p_domain;
  if not found then raise exception 'domain_claim_not_found'; end if;
end $$;

create function public.reserve_marketing_email_submission(
 p_owner uuid,p_key text,p_kind text,p_source uuid,p_to text,p_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 policy public.voom_email_sending_policy; prior public.voom_email_submissions;
 c public.contacts; identity public.voom_email_identities; ok_source boolean := false;
 n integer; day_start timestamptz := date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
 month_start timestamptz := date_trunc('month',now() at time zone 'UTC') at time zone 'UTC';
begin
  -- One shared short transaction enforces tenant + provider budgets under concurrency.
  select * into policy from public.voom_email_sending_policy where id for update;
  if not found or not policy.enabled then raise exception 'marketing_email_disabled'; end if;
  if exists(select 1 from public.voom_email_business_controls where owner_user_id=p_owner and suspended) then raise exception 'email_business_suspended'; end if;
  if p_key is null or p_kind is null or p_source is null or p_hash is null or p_to is null then raise exception 'invalid_submission'; end if;
  select * into prior from public.voom_email_submissions where owner_user_id=p_owner and logical_key=p_key for update;
  if found then
    if prior.source_kind<>p_kind or prior.source_id<>p_source or prior.recipient<>p_to or prior.payload_sha256<>p_hash then raise exception 'email_payload_changed'; end if;
    if prior.state<>'rejected' then
      return jsonb_build_object('submit',false,'state',prior.state,'messageId',prior.provider_message_id);
    end if;
    if prior.attempts>=3 or prior.created_at<now()-interval '23 hours' then raise exception 'email_retry_window_closed'; end if;
    if prior.updated_at>now()-interval '1 minute' then raise exception 'email_retry_not_due'; end if;
  end if;
  if p_kind='campaign' then
    select true into ok_source from public.campaign_sends s
      join public.voom_campaigns ca on ca.id=s.campaign_id and ca.owner_user_id=s.owner_user_id
      join public.campaign_recipients r on r.id=s.recipient_id and r.owner_user_id=s.owner_user_id
      where s.id=p_source and s.owner_user_id=p_owner and s.internal_status='sending'
      and ca.status='approved' and ca.approved_at is not null and r.opt_out_at is null and r.contact=p_to
      for share of ca,r,s;
  elsif p_kind='flow' then
    select true into ok_source from public.voom_email_flow_step_runs r
      join public.voom_email_flows f on f.id=r.flow_id and f.owner_user_id=r.owner_user_id
      join public.voom_email_flow_enrollments e on e.id=r.enrollment_id and e.owner_user_id=r.owner_user_id
      join public.contacts ct on ct.id=e.contact_id and ct.owner_id=r.owner_user_id
      where r.id=p_source and r.owner_user_id=p_owner and r.status='sending'
      and f.status='active' and f.activated_by='user' and e.status='active' and ct.email=p_to
      for share of f,e,r;
  end if;
  if ok_source is distinct from true then raise exception 'email_source_not_authorized'; end if;
  select * into c from public.contacts where owner_id=p_owner and email=p_to for share;
  if not found or c.email_status<>'subscribed' or c.email_consent_at is null or c.email_consent_source is null then
    raise exception 'consent_evidence_required';
  end if;
  if exists(select 1 from public.voom_email_suppressions where owner_id=p_owner and email=p_to) then raise exception 'recipient_suppressed'; end if;
  select * into identity from public.voom_email_identities where owner_user_id=p_owner for share;
  if not found or identity.legal_name is null or identity.postal_address is null then raise exception 'sender_information_required'; end if;
  if not exists(select 1 from public.voom_email_domains d where d.owner_user_id=p_owner
    and d.business_id=identity.business_id and d.domain=split_part(identity.from_address,'@',2)
    and d.dns_verified_at>now()-interval '24 hours' and d.provider_verified_at>now()-interval '24 hours') then
    raise exception 'sender_domain_not_verified';
  end if;
  if (select count(*) from public.voom_email_send_meter where created_at>=day_start and owner_user_id=p_owner)>=policy.business_daily_limit
    or (select count(*) from public.voom_email_send_meter where created_at>=month_start and owner_user_id=p_owner)>=policy.business_monthly_limit then raise exception 'email_business_allowance_reached'; end if;
  if (select count(*) from public.voom_email_send_meter where created_at>=day_start)>=policy.provider_daily_limit
    or (select count(*) from public.voom_email_send_meter where created_at>=month_start)>=policy.provider_monthly_limit then raise exception 'email_provider_allowance_reached'; end if;
  if policy.next_send_at>clock_timestamp() then raise exception 'email_provider_throttled'; end if;
  update public.voom_email_sending_policy set next_send_at=clock_timestamp()+policy.provider_interval_ms*interval '1 millisecond' where id;
  if prior.logical_key is null then
    insert into public.voom_email_submissions(owner_user_id,logical_key,source_kind,source_id,recipient,payload_sha256,state)
      values(p_owner,p_key,p_kind,p_source,p_to,p_hash,'submitting'); n:=1;
  else
    n:=prior.attempts+1;
    update public.voom_email_submissions set state='submitting',attempts=n,updated_at=now() where owner_user_id=p_owner and logical_key=p_key;
  end if;
  insert into public.voom_email_send_meter(owner_user_id,logical_key,attempt) values(p_owner,p_key,n);
  return jsonb_build_object('submit',true,'state','submitting');
end $$;

create function public.record_marketing_email_submission(p_owner uuid,p_key text,p_state text,p_message text,p_error text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare prior public.voom_email_submissions;
begin
  if p_state is null or p_state not in ('accepted','rejected','uncertain') then raise exception 'invalid_submission_outcome'; end if;
  if p_state='accepted' and nullif(p_message,'') is null then raise exception 'provider_message_id_required'; end if;
  select * into prior from public.voom_email_submissions where owner_user_id=p_owner and logical_key=p_key for update;
  if prior.state='accepted' then return jsonb_build_object('state','accepted','messageId',prior.provider_message_id); end if;
  update public.voom_email_submissions set state=p_state,provider_message_id=p_message,error_code=p_error,updated_at=now()
    where owner_user_id=p_owner and logical_key=p_key and state='submitting';
  if not found then raise exception 'submission_not_claimed'; end if;
  return jsonb_build_object('state',p_state,'messageId',p_message);
end $$;

-- Persist unmatched provider events for retry/reconciliation. Matched status and
-- suppression changes are atomic; any failure rolls back and returns HTTP 503.
create function public.record_marketing_email_webhook(p_event text,p_message text,p_type text,p_status text,p_received timestamptz,p_source uuid default null,p_kind text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare s public.campaign_sends; r public.voom_email_flow_step_runs; receipt public.voom_email_webhook_receipts; submission public.voom_email_submissions; address text; affected_owner uuid;
begin
  insert into public.voom_email_webhook_receipts(event_id,provider_message_id,event_type,provider_status,received_at,source_id,source_kind)
    values(p_event,p_message,p_type,p_status,p_received,p_source,p_kind) on conflict(event_id) do nothing;
  select * into receipt from public.voom_email_webhook_receipts where event_id=p_event for update;
  if receipt.provider_message_id is distinct from p_message or receipt.event_type is distinct from p_type or receipt.provider_status is distinct from p_status or receipt.source_id is distinct from p_source or receipt.source_kind is distinct from p_kind then raise exception 'webhook_identity_conflict'; end if;
  if receipt.processed_at is not null then return true; end if;
  -- Provider-signed tags recover accepted submissions whose HTTP response was
  -- lost. Tags contain only the internal source UUID/type, never credentials.
  if p_source is not null and p_kind is not null then
    select * into submission from public.voom_email_submissions where source_id=p_source and source_kind=p_kind for update;
    if not found then return false; end if;
    if submission.provider_message_id is not null and submission.provider_message_id<>p_message then raise exception 'provider_message_conflict'; end if;
    if submission.state='rejected' then raise exception 'unexpected_provider_acceptance'; end if;
    update public.voom_email_submissions set state='accepted',provider_message_id=p_message,updated_at=now()
      where owner_user_id=submission.owner_user_id and logical_key=submission.logical_key;
    if p_kind='campaign' then
      select * into s from public.campaign_sends where id=p_source and owner_user_id=submission.owner_user_id for update;
      if not found then raise exception 'webhook_source_missing'; end if;
      if s.provider_message_id is null then
        perform public.record_campaign_send_provider_result(submission.owner_user_id,p_source,'accepted','accepted',p_message);
      elsif s.provider_message_id<>p_message then raise exception 'provider_message_conflict'; end if;
    elsif p_kind='flow' then
      select * into r from public.voom_email_flow_step_runs where id=p_source and owner_user_id=submission.owner_user_id for update;
      if not found then raise exception 'webhook_source_missing'; end if;
      if r.provider_message_id is null then
        perform public.record_email_flow_step_provider_result(submission.owner_user_id,p_source,'accepted','accepted',p_message);
      elsif r.provider_message_id<>p_message then raise exception 'provider_message_conflict'; end if;
    end if;
  end if;
  select * into s from public.campaign_sends where provider='resend' and provider_message_id=p_message;
  select * into r from public.voom_email_flow_step_runs where provider='resend' and provider_message_id=p_message;
  if s.id is not null and r.id is not null then raise exception 'webhook_ambiguous_owner'; end if;
  if s.id is not null then
    affected_owner:=s.owner_user_id;
    perform public.record_campaign_delivery_event(s.owner_user_id,s.id,'resend',p_event,p_type,p_received,p_status);
    if p_status in ('bounced','complained') then
      select contact into address from public.campaign_recipients where id=s.recipient_id and owner_user_id=s.owner_user_id;
      if address is null then raise exception 'suppression_recipient_missing'; end if;
      perform public.record_email_suppression(s.owner_user_id,address,p_status,'resend',p_event,'Verified provider event');
    end if;
  elsif r.id is not null then
    affected_owner:=r.owner_user_id;
    perform public.record_email_flow_delivery_event(r.owner_user_id,r.id,'resend',p_event,p_type,p_received,p_status);
  else
    -- Shared transactional/legacy webhooks are durably received, not marked
    -- reconciled. Existing email cron retries only newly matchable receipts;
    -- unrelated messages cannot starve that bounded batch.
    return true;
  end if;
  -- Conservative, owner-scoped abuse circuit breaker. No automatic recovery:
  -- operator reviews consent/list hygiene before explicitly lifting suspension.
  if p_status='complained' or (p_status='bounced' and
    (select count(*) from public.voom_email_suppressions where owner_id=affected_owner
      and reason='bounced' and created_at>now()-interval '24 hours')>=5) then
    insert into public.voom_email_business_controls(owner_user_id,suspended) values(affected_owner,true)
      on conflict(owner_user_id) do update set suspended=true;
  end if;
  update public.voom_email_webhook_receipts set processed_at=now() where event_id=p_event;
  return true;
end $$;

create function public.reconcile_marketing_email_webhooks() returns integer
language plpgsql security definer set search_path = '' as $$
declare e public.voom_email_webhook_receipts; n integer:=0;
begin
  for e in select w.* from public.voom_email_webhook_receipts w where w.processed_at is null and
    (exists(select 1 from public.campaign_sends s where s.provider='resend' and s.provider_message_id=w.provider_message_id)
     or exists(select 1 from public.voom_email_flow_step_runs r where r.provider='resend' and r.provider_message_id=w.provider_message_id)
     or exists(select 1 from public.voom_email_submissions s where s.source_id=w.source_id and s.source_kind=w.source_kind))
    order by w.received_at limit 50 for update skip locked loop
    if public.record_marketing_email_webhook(e.event_id,e.provider_message_id,e.event_type,e.provider_status,e.received_at,e.source_id,e.source_kind) then n:=n+1; end if;
  end loop;
  return n;
end $$;

revoke all on function public.claim_marketing_email_domain(uuid,text,text),public.bind_marketing_email_domain(uuid,text,text,boolean),
 public.reserve_marketing_email_submission(uuid,text,text,uuid,text,text),
 public.record_marketing_email_submission(uuid,text,text,text,text),
 public.record_marketing_email_webhook(text,text,text,text,timestamptz,uuid,text),public.reconcile_marketing_email_webhooks() from public,anon,authenticated;
grant execute on function public.claim_marketing_email_domain(uuid,text,text),public.bind_marketing_email_domain(uuid,text,text,boolean),
 public.reserve_marketing_email_submission(uuid,text,text,uuid,text,text),
 public.record_marketing_email_submission(uuid,text,text,text,text),
 public.record_marketing_email_webhook(text,text,text,text,timestamptz,uuid,text),public.reconcile_marketing_email_webhooks() to service_role;
commit;
