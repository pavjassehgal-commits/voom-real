-- LinkedIn personal text publishing. Requires 0059's versioned approvals.
-- Additive: no existing rows, provider queues, cron jobs or grants are changed.
-- Manual, explicit approvals only; LinkedIn is not added to MARA's automatic
-- campaign channel allowlist in this foundation. No external calls in SQL.
begin;

-- Extend only the existing named vocabularies, preserving their old expression.
do $$
declare v_expr text;
begin
  select pg_get_expr(conbin, conrelid) into strict v_expr from pg_constraint
    where conrelid = 'public.mara_drafts'::regclass and conname = 'mara_drafts_kind_check';
  alter table public.mara_drafts drop constraint mara_drafts_kind_check;
  execute format('alter table public.mara_drafts add constraint mara_drafts_kind_check check ((%s) or kind = ''linkedin_text'')', v_expr);
  select pg_get_expr(conbin, conrelid) into strict v_expr from pg_constraint
    where conrelid = 'public.mara_drafts'::regclass and conname = 'mara_drafts_social_pair_check';
  alter table public.mara_drafts drop constraint mara_drafts_social_pair_check;
  execute format('alter table public.mara_drafts add constraint mara_drafts_social_pair_check check ((kind <> ''linkedin_text'' and (%s)) or (kind = ''linkedin_text'' and (social_channel = ''linkedin'' and social_format = ''text'') is true))', v_expr);
  select pg_get_expr(conbin, conrelid) into strict v_expr from pg_constraint
    where conrelid = 'public.content_calendar_items'::regclass and conname = 'content_calendar_items_channel_check';
  alter table public.content_calendar_items drop constraint content_calendar_items_channel_check;
  execute format('alter table public.content_calendar_items add constraint content_calendar_items_channel_check check ((%s) or channel = ''LinkedIn'')', v_expr);
  select pg_get_expr(conbin, conrelid) into strict v_expr from pg_constraint
    where conrelid = 'public.content_calendar_items'::regclass and conname = 'content_calendar_items_social_pair_check';
  alter table public.content_calendar_items drop constraint content_calendar_items_social_pair_check;
  execute format('alter table public.content_calendar_items add constraint content_calendar_items_social_pair_check check ((%s) or (social_channel = ''linkedin'' and social_format = ''text''))', v_expr);
end $$;

create table public.linkedin_connections (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  member_sub text unique check (member_sub ~ '^[A-Za-z0-9_-]{1,200}$'),
  display_name text not null check (char_length(display_name) between 1 and 300),
  scopes text[] not null,
  status text not null check (status in ('connected','disconnected','expired','permission_required')),
  token_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id, owner_user_id)
);
create table public.linkedin_connection_secrets (
  connection_id uuid primary key references public.linkedin_connections(id) on delete cascade,
  encrypted_access_token text not null check (encrypted_access_token like 'v1:%')
);
create table public.linkedin_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  consumed_at timestamptz,
  expires_at timestamptz not null default now() + interval '10 minutes'
);
create index linkedin_oauth_states_expiry on public.linkedin_oauth_states(expires_at);

create table public.linkedin_publish_queue (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  draft_id uuid not null,
  connection_id uuid not null,
  member_sub text not null check (member_sub ~ '^[A-Za-z0-9_-]{1,200}$'),
  approved_content_version bigint not null,
  caption text not null check (char_length(btrim(caption)) between 1 and 3000),
  scheduled_at timestamptz not null,
  next_attempt_at timestamptz not null default now(),
  status text not null default 'scheduled' check (status in
    ('scheduled','claimed','submitting','published','failed','permission_required','cancelled','uncertain')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  claim_token uuid,
  claimed_at timestamptz,
  provider_ref text check (provider_ref ~ '^urn:li:(share|ugcPost):[0-9]+$'),
  published_at timestamptz,
  failure_code text check (char_length(failure_code) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_user_id, draft_id),
  foreign key(draft_id, owner_user_id) references public.mara_drafts(id, owner_user_id) on delete cascade,
  foreign key(connection_id, owner_user_id) references public.linkedin_connections(id, owner_user_id),
  check ((status = 'published') = (provider_ref is not null and published_at is not null))
);
create index linkedin_publish_queue_due on public.linkedin_publish_queue(scheduled_at) where status = 'scheduled';
create index linkedin_publish_queue_owner on public.linkedin_publish_queue(owner_user_id, created_at desc);

alter table public.linkedin_connections enable row level security;
alter table public.linkedin_connection_secrets enable row level security;
alter table public.linkedin_oauth_states enable row level security;
alter table public.linkedin_publish_queue enable row level security;
revoke all on public.linkedin_connections, public.linkedin_connection_secrets, public.linkedin_oauth_states,
  public.linkedin_publish_queue from public, anon, authenticated;
grant select on public.linkedin_connections, public.linkedin_publish_queue to authenticated;
grant select, insert, update, delete on public.linkedin_connections, public.linkedin_connection_secrets,
  public.linkedin_oauth_states, public.linkedin_publish_queue to service_role;
create policy linkedin_connections_owner on public.linkedin_connections for select to authenticated
  using (owner_user_id = (select auth.uid()));
create policy linkedin_queue_owner on public.linkedin_publish_queue for select to authenticated
  using (owner_user_id = (select auth.uid()));

create function public.save_linkedin_connection(p_owner uuid, p_business uuid, p_member text, p_name text,
  p_scopes text[], p_expiry timestamptz, p_encrypted_token text, p_state_hash text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_old public.linkedin_connections;
begin
  if not exists (select 1 from public.businesses where id = p_business and owner_user_id = p_owner)
    or not (array['openid','profile','w_member_social']::text[] <@ p_scopes)
    or p_expiry <= now() or p_member is null then raise exception 'linkedin_connection_invalid'; end if;
  -- Serialize connect/disconnect with publishing, including reconnect attempts.
  perform 1 from public.businesses where id = p_business for update;
  delete from public.linkedin_oauth_states where state_hash=p_state_hash and owner_user_id=p_owner
    and business_id=p_business and consumed_at is not null and expires_at>now();
  if not found then raise exception 'linkedin_oauth_invalidated'; end if;
  select * into v_old from public.linkedin_connections where owner_user_id = p_owner for update;
  if found and v_old.member_sub is not null and v_old.member_sub <> p_member then
    raise exception 'linkedin_disconnect_before_switching_account';
  end if;
  insert into public.linkedin_connections(owner_user_id,business_id,member_sub,display_name,scopes,status,token_expires_at)
    values(p_owner,p_business,p_member,p_name,p_scopes,'connected',p_expiry)
    on conflict(owner_user_id) do update set member_sub=excluded.member_sub, display_name=excluded.display_name,
      scopes=excluded.scopes, status='connected', token_expires_at=excluded.token_expires_at, updated_at=now()
    returning id into v_id;
  insert into public.linkedin_connection_secrets values(v_id,p_encrypted_token)
    on conflict(connection_id) do update set encrypted_access_token=excluded.encrypted_access_token;
  -- Reconnection never automatically re-queues cancelled/failed work.
  return v_id;
end $$;

create function public.consume_linkedin_oauth_state(p_owner uuid, p_hash text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_business uuid;
begin
  update public.linkedin_oauth_states s set consumed_at=now() from public.businesses b
    where s.state_hash=p_hash and s.owner_user_id=p_owner and s.expires_at > now() and s.consumed_at is null
      and b.id=s.business_id and b.owner_user_id=p_owner returning s.business_id into v_business;
  return v_business;
end $$;

create function public.disconnect_linkedin_connection(p_owner uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform 1 from public.businesses where owner_user_id=p_owner for update;
  select id into v_id from public.linkedin_connections where owner_user_id=p_owner for update;
  delete from public.linkedin_oauth_states where owner_user_id=p_owner;
  if v_id is null then return false; end if;
  delete from public.linkedin_connection_secrets where connection_id=v_id;
  update public.linkedin_connections set status='disconnected',member_sub=null,updated_at=now() where id=v_id;
  update public.linkedin_publish_queue set status='cancelled',claim_token=null,claimed_at=null,
      failure_code='disconnected',updated_at=now()
    where owner_user_id=p_owner and status in ('scheduled','claimed','permission_required','failed');
  -- Submitting/uncertain/published jobs are NOT described as cancelled.
  return true;
end $$;

-- Edits and rejection use the existing 0059 approval versioning. They also
-- withdraw LinkedIn's unsubmitted jobs; submitted history cannot be rewritten.
create function public.guard_linkedin_draft_edit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.kind <> 'linkedin_text' then return new; end if;
  if new.content is distinct from old.content or new.title is distinct from old.title
    or new.proposed_publish_at is distinct from old.proposed_publish_at
    or new.status is distinct from old.status or new.kind is distinct from old.kind
    or new.social_channel is distinct from old.social_channel or new.social_format is distinct from old.social_format
    or new.content_meta is distinct from old.content_meta then
    perform 1 from public.linkedin_publish_queue where draft_id=old.id and owner_user_id=old.owner_user_id
      and status in ('claimed','submitting','published','uncertain') for update;
    if found then raise exception 'linkedin_provider_owned'; end if;
    update public.linkedin_publish_queue set status='cancelled',updated_at=now()
      where draft_id=old.id and owner_user_id=old.owner_user_id
        and status in ('scheduled','permission_required','failed');
  end if;
  return new;
end $$;
create trigger linkedin_draft_edit_guard before update on public.mara_drafts
  for each row execute function public.guard_linkedin_draft_edit();

-- Save/edit/reject always clears approval, and uses optimistic version checking.
create function public.edit_linkedin_draft(p_owner uuid,p_draft uuid,p_version bigint,p_text text,
  p_schedule timestamptz,p_reject boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_text is null or char_length(btrim(p_text)) not between 1 and 3000 then raise exception 'linkedin_text_invalid'; end if;
  update public.mara_drafts set content=p_text,proposed_publish_at=p_schedule,
    status=case when p_reject then 'rejected' else 'draft' end, approval_origin='user'
    where id=p_draft and owner_user_id=p_owner and kind='linkedin_text' and content_version=p_version returning id into v_id;
  if v_id is null then raise exception 'linkedin_draft_changed'; end if;
  update public.content_calendar_items set status='draft',content=p_text,publish_at=coalesce(p_schedule,publish_at)
    where owner_user_id=p_owner and source_draft_id=p_draft;
  return v_id;
end $$;

create function public.approve_linkedin_draft(p_owner uuid,p_draft uuid,p_version bigint,
  p_connection uuid,p_member text,p_schedule timestamptz) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_d public.mara_drafts; v_c public.linkedin_connections; v_q public.linkedin_publish_queue; v_id uuid;
begin
  select * into v_d from public.mara_drafts where id=p_draft and owner_user_id=p_owner for update;
  if not found or v_d.kind <> 'linkedin_text' or v_d.content_version <> p_version
    or v_d.status='rejected' or char_length(btrim(v_d.content)) not between 1 and 3000 then
    raise exception 'linkedin_draft_changed'; end if;
  select * into v_c from public.linkedin_connections where id=p_connection and owner_user_id=p_owner for update;
  if not found or v_c.status <> 'connected' or v_c.member_sub is distinct from p_member
    or v_c.token_expires_at <= now() + interval '1 minute' or not ('w_member_social'=any(v_c.scopes)) then
    raise exception 'linkedin_reconnect'; end if;
  select * into v_q from public.linkedin_publish_queue where draft_id=p_draft and owner_user_id=p_owner for update;
  if found and v_q.status='scheduled' and v_q.approved_content_version=p_version and v_q.member_sub=p_member
    and v_q.scheduled_at=p_schedule and v_d.status='approved' then return v_q.id; end if;
  if found and v_q.status in ('claimed','submitting','published','uncertain') then
    -- Same approval replay is a read, never another submission.
    if v_q.approved_content_version=p_version and v_q.member_sub=p_member and v_d.status='approved' then return v_q.id; end if;
    raise exception 'linkedin_provider_owned';
  end if;
  if p_schedule is null or p_schedule < now() - interval '1 minute' then raise exception 'linkedin_schedule_invalid'; end if;
  -- Separate status write ensures the existing content-version trigger covers
  -- exactly the new send time as well as the displayed text.
  if v_d.proposed_publish_at is distinct from p_schedule then
    update public.mara_drafts set proposed_publish_at=p_schedule,status='draft' where id=p_draft;
  end if;
  update public.mara_drafts set status='approved',approval_origin='user' where id=p_draft returning * into v_d;
  insert into public.linkedin_publish_queue(owner_user_id,draft_id,connection_id,member_sub,
    approved_content_version,caption,scheduled_at)
    values(p_owner,p_draft,p_connection,p_member,v_d.content_version,v_d.content,p_schedule)
    on conflict(owner_user_id,draft_id) do update set connection_id=excluded.connection_id,member_sub=excluded.member_sub,
      approved_content_version=excluded.approved_content_version,caption=excluded.caption,
      scheduled_at=excluded.scheduled_at,next_attempt_at=now(),status='scheduled',attempts=0,claim_token=null,claimed_at=null,failure_code=null,updated_at=now()
    returning id into v_id;
  if not exists(select 1 from public.content_calendar_items where owner_user_id=p_owner and source_draft_id=p_draft) then
    insert into public.content_calendar_items(owner_user_id,title,channel,content,publish_at,status,source_draft_id,social_channel,social_format)
      values(p_owner,v_d.title,'LinkedIn',v_d.content,p_schedule,'scheduled',p_draft,'linkedin','text');
  else
    update public.content_calendar_items set content=v_d.content,publish_at=p_schedule,status='scheduled'
      where owner_user_id=p_owner and source_draft_id=p_draft;
  end if;
  insert into public.mara_tool_runs(owner_user_id,conversation_id,tool_name,status,idempotency_key,result_summary,completed_at)
    values(p_owner,v_d.conversation_id,'linkedin_approve_schedule','succeeded',
      'linkedin-approve:' || p_draft::text || ':' || v_d.content_version::text,'Owner explicitly approved LinkedIn text and schedule.',now())
    on conflict(owner_user_id,idempotency_key) where idempotency_key is not null do nothing;
  return v_id;
end $$;

create function public.claim_linkedin_jobs(p_limit integer default 5) returns setof public.linkedin_publish_queue
language plpgsql security definer set search_path = '' as $$
begin
  -- A stale claim never sent bytes. A stale submission might have: never resend.
  update public.linkedin_publish_queue set status='uncertain',failure_code='submission_unconfirmed',updated_at=now()
    where status='submitting' and claimed_at < now() - interval '5 minutes';
  update public.linkedin_publish_queue set status=case when attempts<5 then 'scheduled' else 'failed' end,
    claim_token=null,claimed_at=null,updated_at=now()
    where status='claimed' and claimed_at < now() - interval '5 minutes';
  return query with due as (
    select q.id from public.linkedin_publish_queue q
      where q.status='scheduled' and q.scheduled_at <= now() and q.next_attempt_at <= now() and q.attempts<5
      order by q.scheduled_at limit greatest(1,least(p_limit,10)) for update skip locked
  ) update public.linkedin_publish_queue q set status='claimed',claimed_at=now(),claim_token=gen_random_uuid(),
      attempts=q.attempts+1,updated_at=now() from due where q.id=due.id returning q.*;
end $$;

-- Final durable submission gate: approval snapshot + current member binding +
-- token expiry. Lock order matches approve/edit/disconnect, no provider I/O in SQL.
create function public.start_linkedin_submission(p_id uuid,p_owner uuid,p_claim uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_q public.linkedin_publish_queue; v_d public.mara_drafts; v_c public.linkedin_connections;
begin
  select * into v_q from public.linkedin_publish_queue where id=p_id and owner_user_id=p_owner;
  if not found then return false; end if;
  select * into v_d from public.mara_drafts where id=v_q.draft_id and owner_user_id=p_owner for update;
  select * into v_c from public.linkedin_connections where id=v_q.connection_id and owner_user_id=p_owner for update;
  select * into v_q from public.linkedin_publish_queue where id=p_id and owner_user_id=p_owner for update;
  if v_q.status<>'claimed' or v_q.claim_token is distinct from p_claim or v_q.claimed_at < now()-interval '5 minutes' then return false; end if;
  if v_d.id is null or v_d.status<>'approved' or v_d.approval_origin<>'user'
    or v_d.content_version is distinct from v_q.approved_content_version
    or v_d.approved_content_version is distinct from v_q.approved_content_version
    or v_d.content is distinct from v_q.caption or v_d.kind<>'linkedin_text'
    or v_d.proposed_publish_at is distinct from v_q.scheduled_at then
    update public.linkedin_publish_queue set status='cancelled',failure_code='approval_changed' where id=p_id;
    return false;
  end if;
  if v_c.id is null or v_c.status<>'connected' or v_c.member_sub is distinct from v_q.member_sub
    or v_c.token_expires_at <= now()+interval '1 minute' or not ('w_member_social'=any(v_c.scopes)) then
    update public.linkedin_publish_queue set status='permission_required',failure_code='reconnect' where id=p_id;
    return false;
  end if;
  update public.linkedin_publish_queue set status='submitting',claimed_at=now(),updated_at=now() where id=p_id;
  return true;
end $$;

create function public.finish_linkedin_job(p_id uuid,p_owner uuid,p_claim uuid,p_outcome text,p_ref text default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_q public.linkedin_publish_queue;
begin
  select * into v_q from public.linkedin_publish_queue where id=p_id and owner_user_id=p_owner;
  if not found then return false; end if;
  perform 1 from public.mara_drafts where id=v_q.draft_id and owner_user_id=p_owner for update;
  select * into v_q from public.linkedin_publish_queue where id=p_id and owner_user_id=p_owner for update;
  if not found or v_q.status not in ('claimed','submitting') or v_q.claim_token is distinct from p_claim then return false; end if;
  if p_outcome='published' then
    if v_q.status<>'submitting' or p_ref is null or p_ref !~ '^urn:li:(share|ugcPost):[0-9]+$' then raise exception 'linkedin_evidence_required'; end if;
    update public.linkedin_publish_queue set status='published',provider_ref=p_ref,published_at=now(),failure_code=null,updated_at=now() where id=p_id;
    update public.mara_drafts set provider_ref=p_ref where id=v_q.draft_id and owner_user_id=p_owner;
  elsif p_outcome in ('rate_limited','reconnect','rejected','uncertain','unavailable') then
    -- Only an explicit 429 can retry after submission. Preflight failures are
    -- safe to retry; transport errors / 5xx after POST are always uncertain.
    update public.linkedin_publish_queue set
      status=case when p_outcome='reconnect' then 'permission_required'
        when p_outcome='uncertain' or (p_outcome='unavailable' and v_q.status='submitting') then 'uncertain'
        when p_outcome in ('rate_limited','unavailable') and attempts<5 then 'scheduled' else 'failed' end,
      failure_code=p_outcome,claimed_at=null,claim_token=null,updated_at=now(),
      next_attempt_at=case when p_outcome in ('rate_limited','unavailable') then now()+interval '15 minutes' else next_attempt_at end
      where id=p_id;
    -- Do not change the approved send-time snapshot for retry backoff: start
    -- compares against the original approval, not this queue's next attempt.
  else raise exception 'linkedin_outcome_invalid'; end if;
  return true;
end $$;

-- Explicit names only: no grants or privilege changes to existing providers.
do $$
declare f record;
begin
  for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace
    and proname in ('save_linkedin_connection','consume_linkedin_oauth_state','disconnect_linkedin_connection',
      'guard_linkedin_draft_edit','edit_linkedin_draft','approve_linkedin_draft','claim_linkedin_jobs',
      'start_linkedin_submission','finish_linkedin_job') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
    execute format('grant execute on function %s to service_role', f.signature);
  end loop;
end $$;
commit;
