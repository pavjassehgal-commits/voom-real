-- Real Email/SMS delivery schema and truthful server-only send lifecycle.
-- Prepared for review; do not apply without explicit approval.

begin;

alter table public.voom_campaigns
  add column if not exists approved_at timestamptz;

alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_approved_at_requires_approved_status;
alter table public.voom_campaigns
  add constraint voom_campaigns_approved_at_requires_approved_status
  check (approved_at is null or status = 'approved');

update public.voom_campaigns
set approved_at = coalesce(approved_at, updated_at, created_at, now())
where status = 'approved' and approved_at is null;

revoke all on table public.voom_campaigns from anon, authenticated;
grant select on table public.voom_campaigns to authenticated;
grant insert (
  owner_user_id, kind, name, objective, audience, subject, preview_text, content, proposed_send_at
) on table public.voom_campaigns to authenticated;
grant update (
  name, objective, audience, subject, preview_text, content, proposed_send_at
) on table public.voom_campaigns to authenticated;
grant select, update on table public.voom_campaigns to service_role;

create table if not exists public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  campaign_id uuid not null,
  kind text not null check (kind in ('email', 'sms')),
  contact text not null check (
    (kind = 'email' and contact = lower(contact) and contact ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$')
    or
    (kind = 'sms' and contact ~ '^\+[1-9][0-9]{7,14}$')
  ),
  contact_name text check (contact_name is null or char_length(contact_name) <= 200),
  consent_at timestamptz not null,
  consent_source text not null check (char_length(consent_source) between 1 and 200),
  opt_out_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  unique (owner_user_id, campaign_id, contact),
  foreign key (campaign_id, owner_user_id)
    references public.voom_campaigns (id, owner_user_id) on delete cascade,
  check (opt_out_at is null or opt_out_at >= consent_at)
);

create table if not exists public.campaign_sends (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  campaign_id uuid not null,
  recipient_id uuid not null,
  channel text not null check (channel in ('email', 'sms')),
  provider text not null check (provider in ('resend', 'twilio')),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) between 1 and 200),
  provider_status text check (provider_status is null or char_length(provider_status) <= 120),
  internal_status text not null default 'queued' check (internal_status in ('queued', 'sending', 'accepted', 'delivered', 'failed', 'skipped')),
  attempts integer not null default 0 check (attempts between 0 and 20),
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 120),
  last_error_message text check (last_error_message is null or char_length(last_error_message) <= 1000),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 200),
  claimed_at timestamptz,
  accepted_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_user_id),
  foreign key (campaign_id, owner_user_id)
    references public.voom_campaigns (id, owner_user_id) on delete cascade,
  foreign key (recipient_id, owner_user_id)
    references public.campaign_recipients (id, owner_user_id) on delete cascade,
  check ((channel = 'email' and provider = 'resend') or (channel = 'sms' and provider = 'twilio')),
  check (claimed_at is not null or internal_status not in ('sending', 'accepted', 'delivered')),
  check (accepted_at is not null or internal_status not in ('accepted', 'delivered')),
  check (delivered_at is not null or internal_status <> 'delivered')
);

create table if not exists public.campaign_delivery_events (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  send_id uuid not null,
  provider text not null check (provider in ('resend', 'twilio')),
  event_id text not null check (char_length(event_id) between 1 and 200),
  event_type text not null check (char_length(event_type) between 1 and 120),
  received_at timestamptz not null default now(),
  unique (id, owner_user_id),
  foreign key (send_id, owner_user_id)
    references public.campaign_sends (id, owner_user_id) on delete cascade
);

create index if not exists campaign_recipients_owner_campaign_idx
  on public.campaign_recipients (owner_user_id, campaign_id, created_at desc);
create index if not exists campaign_sends_owner_campaign_idx
  on public.campaign_sends (owner_user_id, campaign_id, created_at desc);
create index if not exists campaign_sends_status_idx
  on public.campaign_sends (internal_status, updated_at)
  where internal_status in ('queued', 'sending', 'accepted');
create index if not exists campaign_delivery_events_send_received_idx
  on public.campaign_delivery_events (send_id, received_at desc);
create unique index if not exists campaign_sends_idempotency_idx
  on public.campaign_sends (owner_user_id, idempotency_key);
create unique index if not exists campaign_sends_campaign_recipient_idx
  on public.campaign_sends (owner_user_id, campaign_id, recipient_id);
create unique index if not exists campaign_sends_provider_message_idx
  on public.campaign_sends (provider, provider_message_id)
  where provider_message_id is not null;
create unique index if not exists campaign_delivery_events_dedupe_idx
  on public.campaign_delivery_events (owner_user_id, provider, event_id);

drop trigger if exists set_campaign_recipients_updated_at on public.campaign_recipients;
create trigger set_campaign_recipients_updated_at before update on public.campaign_recipients
  for each row execute function public.set_updated_at();
drop trigger if exists set_campaign_sends_updated_at on public.campaign_sends;
create trigger set_campaign_sends_updated_at before update on public.campaign_sends
  for each row execute function public.set_updated_at();

alter table public.campaign_recipients enable row level security;
alter table public.campaign_sends enable row level security;
alter table public.campaign_delivery_events enable row level security;

revoke all on table public.campaign_recipients, public.campaign_sends, public.campaign_delivery_events from public, anon, authenticated;
grant select on table public.campaign_recipients to authenticated;
grant select on table public.campaign_sends to authenticated;
grant select, insert, update on table public.campaign_recipients to service_role;
grant select, insert, update on table public.campaign_sends to service_role;
grant select, insert on table public.campaign_delivery_events to service_role;

drop policy if exists "campaign_recipients_select_own" on public.campaign_recipients;
create policy "campaign_recipients_select_own" on public.campaign_recipients
  for select to authenticated using ((select auth.uid()) = owner_user_id);
drop policy if exists "campaign_sends_select_own" on public.campaign_sends;
create policy "campaign_sends_select_own" on public.campaign_sends
  for select to authenticated using ((select auth.uid()) = owner_user_id);

create or replace function public.set_voom_campaign_approval(
  p_owner_user_id uuid,
  p_campaign_id uuid,
  p_action text
) returns public.voom_campaigns
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text := lower(trim(p_action));
  v_campaign public.voom_campaigns;
begin
  if v_action not in ('approve', 'reject') then
    raise exception 'invalid_campaign_action';
  end if;

  update public.voom_campaigns
  set status = case when v_action = 'approve' then 'approved' else 'rejected' end,
      approved_at = case when v_action = 'approve' then coalesce(approved_at, now()) else null end
  where id = p_campaign_id
    and owner_user_id = p_owner_user_id
  returning * into v_campaign;

  if not found then
    raise exception 'campaign_not_found';
  end if;

  return v_campaign;
end;
$$;

create or replace function public.add_campaign_recipient(
  p_owner_user_id uuid,
  p_campaign_id uuid,
  p_contact text,
  p_contact_name text,
  p_consent_at timestamptz,
  p_consent_source text
) returns public.campaign_recipients
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign_kind text;
  v_contact text;
  v_name text := nullif(trim(coalesce(p_contact_name, '')), '');
  v_source text := trim(coalesce(p_consent_source, ''));
  v_recipient public.campaign_recipients;
begin
  if p_consent_at is null or p_consent_at > now() + interval '5 minutes' then
    raise exception 'invalid_consent_at';
  end if;
  if v_source = '' or char_length(v_source) > 200 then
    raise exception 'invalid_consent_source';
  end if;

  select kind into v_campaign_kind
  from public.voom_campaigns
  where id = p_campaign_id
    and owner_user_id = p_owner_user_id;

  if v_campaign_kind is null then
    raise exception 'campaign_not_found';
  end if;

  v_contact := case
    when v_campaign_kind = 'email' then lower(trim(coalesce(p_contact, '')))
    else trim(coalesce(p_contact, ''))
  end;

  if v_campaign_kind = 'email' then
    if v_contact !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
      raise exception 'invalid_email_contact';
    end if;
  elsif v_contact !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid_sms_contact';
  end if;

  insert into public.campaign_recipients (
    owner_user_id, campaign_id, kind, contact, contact_name, consent_at, consent_source
  ) values (
    p_owner_user_id, p_campaign_id, v_campaign_kind, v_contact, v_name, p_consent_at, v_source
  )
  on conflict (owner_user_id, campaign_id, contact) do update set
    contact_name = excluded.contact_name,
    consent_at = excluded.consent_at,
    consent_source = excluded.consent_source
  returning * into v_recipient;

  return v_recipient;
end;
$$;

create or replace function public.claim_campaign_send(
  p_owner_user_id uuid,
  p_campaign_id uuid,
  p_recipient_id uuid,
  p_idempotency_key text
) returns public.campaign_sends
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign public.voom_campaigns;
  v_recipient public.campaign_recipients;
  v_send public.campaign_sends;
  v_provider text;
  v_idempotency_key text := trim(coalesce(p_idempotency_key, ''));
begin
  if char_length(v_idempotency_key) < 16 or char_length(v_idempotency_key) > 200 then
    raise exception 'invalid_idempotency_key';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_owner_user_id::text || ':' || p_campaign_id::text || ':' || p_recipient_id::text,
      0
    )
  );

  select * into v_campaign
  from public.voom_campaigns
  where id = p_campaign_id
    and owner_user_id = p_owner_user_id
  for update;

  if not found then
    raise exception 'campaign_not_found';
  end if;
  if v_campaign.status <> 'approved' or v_campaign.approved_at is null then
    raise exception 'campaign_not_approved';
  end if;

  select * into v_recipient
  from public.campaign_recipients
  where id = p_recipient_id
    and owner_user_id = p_owner_user_id
    and campaign_id = p_campaign_id
  for update;

  if not found then
    raise exception 'recipient_not_found';
  end if;
  if v_recipient.opt_out_at is not null then
    raise exception 'recipient_opted_out';
  end if;
  if v_recipient.kind <> v_campaign.kind then
    raise exception 'recipient_kind_mismatch';
  end if;

  v_provider := case when v_campaign.kind = 'email' then 'resend' else 'twilio' end;

  select * into v_send
  from public.campaign_sends
  where owner_user_id = p_owner_user_id
    and campaign_id = p_campaign_id
    and recipient_id = p_recipient_id
  for update;

  if found then
    if v_send.idempotency_key = v_idempotency_key then
      return v_send;
    end if;

    if v_send.internal_status in ('queued', 'sending', 'accepted', 'delivered', 'skipped')
      or v_send.provider_message_id is not null
      or v_send.accepted_at is not null
      or v_send.delivered_at is not null then
      return v_send;
    end if;

    if v_send.internal_status = 'failed' then
      update public.campaign_sends
      set channel = v_campaign.kind,
          provider = v_provider,
          provider_status = null,
          internal_status = 'sending',
          attempts = greatest(v_send.attempts, 0) + 1,
          last_error_code = null,
          last_error_message = null,
          idempotency_key = v_idempotency_key,
          claimed_at = now(),
          accepted_at = null,
          delivered_at = null
      where id = v_send.id
      returning * into v_send;

      return v_send;
    end if;
  end if;

  insert into public.campaign_sends (
    owner_user_id, campaign_id, recipient_id, channel, provider,
    internal_status, attempts, idempotency_key, claimed_at
  ) values (
    p_owner_user_id, p_campaign_id, p_recipient_id, v_campaign.kind, v_provider,
    'sending', 1, v_idempotency_key, now()
  )
  returning * into v_send;

  return v_send;
end;
$$;

create or replace function public.record_campaign_send_provider_result(
  p_owner_user_id uuid,
  p_send_id uuid,
  p_outcome text,
  p_provider_status text default null,
  p_provider_message_id text default null,
  p_error_code text default null,
  p_error_message text default null
) returns public.campaign_sends
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outcome text := lower(trim(coalesce(p_outcome, '')));
  v_provider_status text := nullif(trim(coalesce(p_provider_status, '')), '');
  v_provider_message_id text := nullif(trim(coalesce(p_provider_message_id, '')), '');
  v_error_code text := nullif(trim(coalesce(p_error_code, '')), '');
  v_error_message text := nullif(trim(coalesce(p_error_message, '')), '');
  v_send public.campaign_sends;
begin
  if v_outcome not in ('accepted', 'failed') then
    raise exception 'invalid_provider_outcome';
  end if;
  if v_provider_status is not null and char_length(v_provider_status) > 120 then
    raise exception 'invalid_provider_status';
  end if;
  if v_provider_message_id is not null and char_length(v_provider_message_id) > 200 then
    raise exception 'invalid_provider_message_id';
  end if;
  if v_error_code is not null and char_length(v_error_code) > 120 then
    raise exception 'invalid_error_code';
  end if;
  if v_error_message is not null and char_length(v_error_message) > 1000 then
    raise exception 'invalid_error_message';
  end if;

  select * into v_send
  from public.campaign_sends
  where id = p_send_id
    and owner_user_id = p_owner_user_id
  for update;

  if not found then
    raise exception 'campaign_send_not_found';
  end if;
  if v_send.internal_status = 'delivered' then
    return v_send;
  end if;

  if v_outcome = 'accepted' then
    if v_provider_message_id is null then
      raise exception 'provider_message_id_required';
    end if;

    update public.campaign_sends
    set provider_message_id = v_provider_message_id,
        provider_status = coalesce(v_provider_status, 'accepted'),
        internal_status = 'accepted',
        accepted_at = coalesce(accepted_at, now()),
        last_error_code = null,
        last_error_message = null
    where id = p_send_id
      and owner_user_id = p_owner_user_id
    returning * into v_send;
  else
    update public.campaign_sends
    set provider_message_id = coalesce(provider_message_id, v_provider_message_id),
        provider_status = coalesce(v_provider_status, provider_status, 'failed'),
        internal_status = 'failed',
        last_error_code = v_error_code,
        last_error_message = v_error_message
    where id = p_send_id
      and owner_user_id = p_owner_user_id
    returning * into v_send;
  end if;

  return v_send;
end;
$$;

create or replace function public.record_campaign_delivery_event(
  p_owner_user_id uuid,
  p_send_id uuid,
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_received_at timestamptz default now(),
  p_provider_status text default null
) returns public.campaign_sends
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text := lower(trim(coalesce(p_provider, '')));
  v_event_id text := trim(coalesce(p_event_id, ''));
  v_event_type text := trim(coalesce(p_event_type, ''));
  v_provider_status text := nullif(trim(coalesce(p_provider_status, '')), '');
  v_normalized text;
  v_inserted_event_id uuid;
  v_send public.campaign_sends;
begin
  if v_provider not in ('resend', 'twilio') then
    raise exception 'invalid_event_provider';
  end if;
  if char_length(v_event_id) < 1 or char_length(v_event_id) > 200 then
    raise exception 'invalid_event_id';
  end if;
  if char_length(v_event_type) < 1 or char_length(v_event_type) > 120 then
    raise exception 'invalid_event_type';
  end if;
  if v_provider_status is not null and char_length(v_provider_status) > 120 then
    raise exception 'invalid_provider_status';
  end if;

  select * into v_send
  from public.campaign_sends
  where id = p_send_id
    and owner_user_id = p_owner_user_id
  for update;

  if not found then
    raise exception 'campaign_send_not_found';
  end if;
  if v_send.provider <> v_provider then
    raise exception 'provider_mismatch';
  end if;

  insert into public.campaign_delivery_events (
    owner_user_id, send_id, provider, event_id, event_type, received_at
  ) values (
    p_owner_user_id, p_send_id, v_provider, v_event_id, v_event_type, coalesce(p_received_at, now())
  )
  on conflict (owner_user_id, provider, event_id) do nothing
  returning id into v_inserted_event_id;

  if v_inserted_event_id is null then
    return v_send;
  end if;

  v_normalized := lower(coalesce(v_provider_status, v_event_type));

  if (
    v_provider = 'resend' and v_normalized in ('email.delivered', 'delivered')
  ) or (
    v_provider = 'twilio' and v_normalized = 'delivered'
  ) then
    update public.campaign_sends
    set provider_status = coalesce(v_provider_status, v_event_type),
        internal_status = 'delivered',
        accepted_at = coalesce(accepted_at, p_received_at, now()),
        delivered_at = coalesce(delivered_at, p_received_at, now()),
        last_error_code = null,
        last_error_message = null
    where id = p_send_id
      and owner_user_id = p_owner_user_id
    returning * into v_send;
  elsif (
    v_provider = 'resend' and v_normalized in ('email.bounced', 'email.complained', 'email.failed', 'email.canceled', 'failed', 'bounced', 'complained', 'canceled', 'undelivered')
  ) or (
    v_provider = 'twilio' and v_normalized in ('failed', 'undelivered')
  ) then
    if v_send.internal_status <> 'delivered' then
      update public.campaign_sends
      set provider_status = coalesce(v_provider_status, v_event_type),
          internal_status = 'failed',
          last_error_code = left(v_normalized, 120),
          last_error_message = 'The provider reported that delivery failed.'
      where id = p_send_id
        and owner_user_id = p_owner_user_id
      returning * into v_send;
    end if;
  elsif v_send.internal_status = 'sending' then
    update public.campaign_sends
    set provider_status = coalesce(v_provider_status, v_event_type),
        internal_status = 'accepted',
        accepted_at = coalesce(accepted_at, p_received_at, now())
    where id = p_send_id
      and owner_user_id = p_owner_user_id
    returning * into v_send;
  elsif coalesce(v_provider_status, v_event_type) is not null then
    update public.campaign_sends
    set provider_status = coalesce(v_provider_status, v_event_type)
    where id = p_send_id
      and owner_user_id = p_owner_user_id
    returning * into v_send;
  end if;

  return v_send;
end;
$$;

revoke all on function public.set_voom_campaign_approval(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.add_campaign_recipient(uuid, uuid, text, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.claim_campaign_send(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.record_campaign_send_provider_result(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.record_campaign_delivery_event(uuid, uuid, text, text, text, timestamptz, text) from public, anon, authenticated;

grant execute on function public.set_voom_campaign_approval(uuid, uuid, text) to service_role;
grant execute on function public.add_campaign_recipient(uuid, uuid, text, text, timestamptz, text) to service_role;
grant execute on function public.claim_campaign_send(uuid, uuid, uuid, text) to service_role;
grant execute on function public.record_campaign_send_provider_result(uuid, uuid, text, text, text, text, text) to service_role;
grant execute on function public.record_campaign_delivery_event(uuid, uuid, text, text, text, timestamptz, text) to service_role;

commit;
