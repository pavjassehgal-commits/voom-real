-- Native YouTube browser uploads only; no provider/cron invocation or data backfill.
-- 0065 is a separate release: this migration depends on 0064, not 0065.
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('youtube-uploads','youtube-uploads',false,268435456,array['video/mp4']);

create table public.youtube_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete set null,
  draft_id uuid references public.mara_drafts(id) on delete set null,
  request_key uuid not null,
  content_version bigint not null,
  storage_path text not null unique,
  display_name text not null check(length(display_name) between 1 and 180),
  byte_size bigint not null check(byte_size between 1 and 268435456),
  fingerprint text not null check(length(fingerprint)=64),
  status text not null default 'pending' check(status in ('pending','validating','attached','cancelled','deleting','deleted')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '24 hours',
  -- Signed upload grants last 2h; TUS URLs last 24h. Reauthorization is
  -- permitted only inside expires_at. Never delete while a late upload can land.
  cleanup_after timestamptz not null default now()+interval '51 hours',
  claim uuid,
  claimed_until timestamptz,
  attached_at timestamptz,
  deleted_at timestamptz,
  unique(owner_user_id,request_key)
);
create index youtube_upload_cleanup_due on public.youtube_upload_sessions(cleanup_after) where status<>'deleted';
create index youtube_upload_owner_draft on public.youtube_upload_sessions(owner_user_id,draft_id,created_at desc);
alter table public.youtube_upload_sessions enable row level security;
revoke all on public.youtube_upload_sessions from public,anon,authenticated,service_role;
grant select on public.youtube_upload_sessions to service_role;

-- Every other upload keeps the generic size limit this database already has
-- (20MiB on main, a different value where the schema drifted, 50MiB on the
-- TikTok staging history). Only registered YouTube immutable paths may carry
-- larger native MP4 uploads. The check is found by its definition, not its
-- name, and keeps its name; anything unexpected stops the migration.
do $m$
declare c record; v_name text; v_max bigint; v_found integer:=0;
begin
  for c in select conname,pg_get_constraintdef(oid) def from pg_constraint
    where conrelid='public.post_draft_assets'::regclass and contype='c' and pg_get_constraintdef(oid) ~ '\mbyte_size\M' loop
    if c.def !~ '^CHECK \(\(\(byte_size >= 1\) AND \(byte_size <= [0-9]+\)\)\)$' then
      raise exception 'youtube_upload_unexpected_size_check: %',c.conname;end if;
    v_found:=v_found+1;v_name:=c.conname;v_max:=substring(c.def from '<= ([0-9]+)')::bigint;
  end loop;
  if v_found<>1 or v_max>=268435456 then raise exception 'youtube_upload_unexpected_size_check_count';end if;
  execute format('alter table public.post_draft_assets drop constraint %I',v_name);
  execute format($f$alter table public.post_draft_assets add constraint %I check (byte_size between 1 and %s
    or (mime_type='video/mp4' and byte_size between 1 and 268435456
      and storage_path ~ '^[a-f0-9-]{36}/youtube-uploads/[a-f0-9-]{36}[.]mp4$'))$f$,v_name,v_max);
end $m$;

-- Staging's TikTok history (0060, not on main/Production) also caps every
-- non-TikTok asset at 20MB in a trigger. Extend only that exact, reviewed
-- body with the same native-YouTube allowance; TikTok and all other media
-- keep its rules. A differing body stops the migration rather than guessing.
do $m$
declare v_src text;
begin
  select prosrc into v_src from pg_proc where oid=to_regprocedure('public.enforce_post_draft_asset_size()');
  if v_src is null then return;end if;
  if v_src<>$b$
begin
  if new.byte_size > 20971520 then
    if new.mime_type <> 'video/mp4' or not exists (
      select 1
      from public.mara_drafts d
      where d.id = new.draft_id
        and d.owner_user_id = new.owner_user_id
        and d.kind = 'tiktok_video'
    ) then
      raise exception 'post_draft_asset_too_large'
        using errcode = '23514',
              detail = 'Only MP4 videos on TikTok Video drafts may exceed 20 MB.';
    end if;
  end if;
  return new;
end;
$b$ then raise exception 'youtube_upload_unexpected_size_trigger';end if;
  create or replace function public.enforce_post_draft_asset_size()
  returns trigger
  language plpgsql
  set search_path = ''
  as $f$
begin
  if new.byte_size > 20971520 and new.mime_type = 'video/mp4' and new.byte_size <= 268435456
    and new.storage_path ~ ('^' || new.owner_user_id::text || '/youtube-uploads/[a-f0-9-]{36}[.]mp4$')
    and exists (
      select 1
      from public.mara_drafts d
      where d.id = new.draft_id
        and d.owner_user_id = new.owner_user_id
        and d.kind in ('youtube_video', 'youtube_short')
    ) then
    return new;
  end if;
  if new.byte_size > 20971520 and new.storage_path ~ '/youtube-uploads/' then
    raise exception 'post_draft_asset_too_large'
      using errcode = '23514',
            detail = 'Native YouTube uploads may exceed 20 MB only on the owner''s YouTube drafts.';
  end if;
  if new.byte_size > 20971520 then
    if new.mime_type <> 'video/mp4' or not exists (
      select 1
      from public.mara_drafts d
      where d.id = new.draft_id
        and d.owner_user_id = new.owner_user_id
        and d.kind = 'tiktok_video'
    ) then
      raise exception 'post_draft_asset_too_large'
        using errcode = '23514',
              detail = 'Only MP4 videos on TikTok Video drafts may exceed 20 MB.';
    end if;
  end if;
  return new;
end;
$f$;
  revoke all on function public.enforce_post_draft_asset_size() from public, anon, authenticated;
end $m$;

create function public.begin_youtube_upload(p_owner uuid,p_draft uuid,p_key uuid,p_name text,p_bytes bigint,p_fingerprint text)
returns public.youtube_upload_sessions language plpgsql security definer set search_path='' as $$
declare d public.mara_drafts; u public.youtube_upload_sessions; uid uuid:=gen_random_uuid();
begin
  perform pg_advisory_xact_lock(hashtextextended('youtube-upload:'||p_owner::text,0));
  select * into d from public.mara_drafts where id=p_draft and owner_user_id=p_owner for update;
  if d.id is null or d.kind not in ('youtube_video','youtube_short') or d.social_channel is distinct from 'youtube'
    or d.social_format is distinct from (case when d.kind='youtube_short' then 'short' else 'video' end) then raise exception 'upload_owner_required';end if;
  if p_bytes is null or p_bytes<1 or p_bytes>268435456 or p_name is null or length(p_name)>180 or p_name !~* '[.]mp4$'
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' or p_key is null then raise exception 'upload_invalid_file';end if;
  select * into u from public.youtube_upload_sessions where owner_user_id=p_owner and request_key=p_key;
  if found then
    if u.draft_id is distinct from p_draft or u.byte_size<>p_bytes or u.fingerprint<>p_fingerprint then raise exception 'upload_request_conflict';end if;
    return u;
  end if;
  if exists(select 1 from public.youtube_publish_queue where owner_user_id=p_owner and draft_id=p_draft
    and (status in ('uploading','provider_processing','published') or upload_session_url is not null or youtube_video_id is not null)) then raise exception 'upload_provider_owned';end if;
  if exists(select 1 from public.mara_media_generations where owner_user_id=p_owner and draft_id=p_draft
    and (status in ('queued','generating','processing') or provider_status in ('submitting','submission_uncertain'))) then raise exception 'upload_generation_active';end if;
  if exists(select 1 from public.youtube_upload_sessions where owner_user_id=p_owner and draft_id=p_draft and status in ('pending','validating') and expires_at>now()) then raise exception 'upload_already_pending';end if;
  if (select count(*) from public.youtube_upload_sessions where owner_user_id=p_owner and status in ('pending','validating') and expires_at>now())>=3
    or (select count(*) from public.youtube_upload_sessions where owner_user_id=p_owner and created_at>now()-interval '24 hours')>=10 then raise exception 'upload_limit_reached';end if;
  insert into public.youtube_upload_sessions(id,owner_user_id,draft_id,request_key,content_version,storage_path,display_name,byte_size,fingerprint)
    values(uid,p_owner,p_draft,p_key,d.content_version,p_owner::text||'/youtube-uploads/'||uid::text||'.mp4',p_name,p_bytes,p_fingerprint) returning * into u;
  return u;
end $$;

create function public.authorize_youtube_upload(p_owner uuid,p_draft uuid,p_id uuid)
returns public.youtube_upload_sessions language plpgsql security definer set search_path='' as $$
declare u public.youtube_upload_sessions;
begin
  select * into u from public.youtube_upload_sessions where id=p_id and owner_user_id=p_owner and draft_id=p_draft for update;
  if u.id is null or u.status not in ('pending','validating') or u.expires_at<=now() then raise exception 'upload_unavailable';end if;
  if not public.consume_rate_limit(p_owner,'youtube_upload_authorize',30,3600) then raise exception 'upload_limit_reached';end if;
  return u;
end $$;

create function public.claim_youtube_upload_validation(p_owner uuid,p_draft uuid,p_id uuid)
returns public.youtube_upload_sessions language plpgsql security definer set search_path='' as $$
declare u public.youtube_upload_sessions;
begin
  select * into u from public.youtube_upload_sessions where id=p_id and owner_user_id=p_owner and draft_id=p_draft for update;
  if u.id is null or u.status not in ('pending','validating','attached') then raise exception 'upload_unavailable';end if;
  if u.status='attached' then return u;end if;
  if u.expires_at<=now() then raise exception 'upload_expired';end if;
  if u.status='validating' and u.claimed_until>now() then raise exception 'upload_validation_busy';end if;
  update public.youtube_upload_sessions set status='validating',claim=gen_random_uuid(),claimed_until=now()+interval '5 minutes' where id=p_id returning * into u;
  return u;
end $$;

-- Same canonical attachment operation, extended only for a validated session.
-- Retain the exact previous implementation privately for a guarded rollback.
alter function public.attach_youtube_uploaded_video(uuid,uuid,bigint,text,text,bigint) rename to attach_youtube_uploaded_video_pre_direct;
revoke all on function public.attach_youtube_uploaded_video_pre_direct(uuid,uuid,bigint,text,text,bigint) from public,anon,authenticated,service_role;
create or replace function public.attach_youtube_uploaded_video(p_owner uuid,p_draft uuid,p_version bigint,p_path text,p_name text,p_bytes bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare d public.mara_drafts;
begin
  select * into d from public.mara_drafts where id=p_draft and owner_user_id=p_owner for update;
  if d.id is null or d.kind not in ('youtube_video','youtube_short') or d.social_channel is distinct from 'youtube'
    or d.social_format is distinct from (case when d.kind='youtube_short' then 'short' else 'video' end) then raise exception 'youtube_upload_owner_required';end if;
  perform 1 from public.youtube_publish_queue where owner_user_id=p_owner and draft_id=p_draft for update;
  if exists(select 1 from public.youtube_publish_queue where owner_user_id=p_owner and draft_id=p_draft
    and (status in ('uploading','provider_processing','published') or upload_session_url is not null or youtube_video_id is not null)) then raise exception 'youtube_upload_provider_owned';end if;
  if exists(select 1 from public.mara_media_generations where owner_user_id=p_owner and draft_id=p_draft
    and (status in ('queued','generating','processing') or provider_status in ('submitting','submission_uncertain'))) then raise exception 'youtube_upload_generation_active';end if;
  if p_path is null or p_bytes is null or p_bytes<1 or p_name is null or length(p_name)>180 then raise exception 'youtube_upload_invalid_asset';end if;
  if p_path ~ ('^'||p_owner::text||'/post-assets/[a-f0-9]{16}-'||p_draft::text||'[.]mp4$') and p_bytes<=4194304 then null;
  elsif not exists(select 1 from public.youtube_upload_sessions where owner_user_id=p_owner and draft_id=p_draft and storage_path=p_path
    and byte_size=p_bytes and byte_size<=268435456 and content_version=p_version and status='validating' and claimed_until>now()) then raise exception 'youtube_upload_invalid_asset';end if;
  if exists(select 1 from public.post_draft_assets where owner_user_id=p_owner and draft_id=p_draft and storage_path=p_path and mime_type='video/mp4' and byte_size=p_bytes and status='uploaded') then return true;end if;
  if p_version is null or d.content_version<>p_version then return false;end if;
  update public.mara_drafts set status='draft',content_meta=coalesce(content_meta,'{}'::jsonb)-'containsSyntheticMedia' where id=p_draft and owner_user_id=p_owner;
  update public.youtube_publish_queue set status='cancelled',claimed_at=null where owner_user_id=p_owner and draft_id=p_draft and upload_session_url is null and youtube_video_id is null
    and status in ('scheduled','waiting_for_media','needs_declaration','permission_required','failed');
  delete from public.content_calendar_items where owner_user_id=p_owner and source_draft_id=p_draft;
  insert into public.post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status)
    values(p_owner,p_draft,p_path,p_name,'video/mp4',p_bytes,'uploaded_existing','uploaded')
    on conflict(owner_user_id,draft_id) do update set storage_path=excluded.storage_path,display_name=excluded.display_name,mime_type=excluded.mime_type,byte_size=excluded.byte_size,origin=excluded.origin,status=excluded.status;
  return true;
end $$;

create function public.finish_youtube_upload(p_owner uuid,p_draft uuid,p_id uuid,p_claim uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare u public.youtube_upload_sessions;
begin
  -- draft -> queue -> session, same order as attachment and cleanup.
  perform 1 from public.mara_drafts where id=p_draft and owner_user_id=p_owner for update;
  perform 1 from public.youtube_publish_queue where owner_user_id=p_owner and draft_id=p_draft for update;
  select * into u from public.youtube_upload_sessions where id=p_id and owner_user_id=p_owner and draft_id=p_draft for update;
  if u.id is null then raise exception 'upload_unavailable';end if;
  if u.status='attached' then return exists(select 1 from public.post_draft_assets where draft_id=p_draft and owner_user_id=p_owner and storage_path=u.storage_path);end if;
  if u.status<>'validating' or u.claim is distinct from p_claim or u.claimed_until<=now() or u.expires_at<=now() then raise exception 'upload_unavailable';end if;
  if not public.attach_youtube_uploaded_video(p_owner,p_draft,u.content_version,u.storage_path,u.display_name,u.byte_size) then raise exception 'upload_draft_changed';end if;
  update public.youtube_upload_sessions set status='attached',attached_at=now(),claim=null,claimed_until=null where id=p_id;
  return true;
end $$;

create function public.release_youtube_upload(p_owner uuid,p_draft uuid,p_id uuid,p_claim uuid,p_cancel boolean default false)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  -- Cancel and final attachment contend on the same session row. Never detach
  -- an already-attached upload; uncertain completion must first be reread.
  update public.youtube_upload_sessions set status=case when p_cancel then 'cancelled' else 'pending' end,claim=null,claimed_until=null
    where id=p_id and owner_user_id=p_owner and draft_id=p_draft and status in ('pending','validating')
      and (p_cancel or claim is not distinct from p_claim);
  return found;
end $$;

create function public.claim_youtube_upload_cleanup(p_limit integer default 10)
returns setof public.youtube_upload_sessions language plpgsql security definer set search_path='' as $$
declare u public.youtube_upload_sessions;
begin
  delete from public.youtube_upload_sessions where id in (
    select id from public.youtube_upload_sessions where status='deleted' and deleted_at<now()-interval '7 days' limit 100
  );
  for u in select * from public.youtube_upload_sessions where cleanup_after<now() and status<>'deleted'
    and (status<>'deleting' or claimed_until<now()) order by cleanup_after limit greatest(1,least(p_limit,25)) loop
    if u.draft_id is not null then
      perform 1 from public.mara_drafts where id=u.draft_id for update skip locked;
      if not found then continue;end if;
    end if;
    select * into u from public.youtube_upload_sessions where id=u.id for update skip locked;
    if not found or u.status='deleted' or u.cleanup_after>=now() or (u.status='deleting' and u.claimed_until>now()) then continue;end if;
    -- No uncertain reference lookup authorizes storage deletion. All reads are
    -- in one transaction; an error aborts the claim. No external table scan.
    if exists(select 1 from public.post_draft_assets where storage_path=u.storage_path)
      or exists(select 1 from public.mara_media_generations where storage_path=u.storage_path)
      or exists(select 1 from public.reel_draft_assets where storage_path=u.storage_path)
      or exists(select 1 from public.instagram_media_assets where storage_path=u.storage_path) then continue;end if;
    update public.youtube_upload_sessions set status='deleting',claim=gen_random_uuid(),claimed_until=now()+interval '10 minutes' where id=u.id returning * into u;
    return next u;
  end loop;
end $$;

create function public.finish_youtube_upload_cleanup(p_id uuid,p_claim uuid,p_success boolean)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  update public.youtube_upload_sessions set status=case when p_success then 'deleted' else 'cancelled' end,
    deleted_at=case when p_success then now() else null end,cleanup_after=case when p_success then cleanup_after else now()+interval '1 hour' end,claim=null,claimed_until=null
    where id=p_id and status='deleting' and claim=p_claim;
  return found;
end $$;

revoke all on function public.begin_youtube_upload(uuid,uuid,uuid,text,bigint,text),public.authorize_youtube_upload(uuid,uuid,uuid),public.claim_youtube_upload_validation(uuid,uuid,uuid),public.finish_youtube_upload(uuid,uuid,uuid,uuid),public.release_youtube_upload(uuid,uuid,uuid,uuid,boolean),public.claim_youtube_upload_cleanup(integer),public.finish_youtube_upload_cleanup(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.begin_youtube_upload(uuid,uuid,uuid,text,bigint,text),public.authorize_youtube_upload(uuid,uuid,uuid),public.claim_youtube_upload_validation(uuid,uuid,uuid),public.finish_youtube_upload(uuid,uuid,uuid,uuid),public.release_youtube_upload(uuid,uuid,uuid,uuid,boolean),public.claim_youtube_upload_cleanup(integer),public.finish_youtube_upload_cleanup(uuid,uuid,boolean) to service_role;
revoke all on function public.attach_youtube_uploaded_video(uuid,uuid,bigint,text,text,bigint) from public,anon,authenticated;
grant execute on function public.attach_youtube_uploaded_video(uuid,uuid,bigint,text,text,bigint) to service_role;
notify pgrst,'reload schema';
commit;
