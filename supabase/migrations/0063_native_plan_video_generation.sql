-- Native TikTok/Shorts generation uses existing jobs, credits and assets.
-- No backfill, worker activation, provider call or customer-data mutation.
begin;

-- Same lock order as draft edits: draft, then publishing queues. An already
-- claimed/submitted/published job is never represented as cancellable.
create function public.lock_native_video_draft(p_owner uuid, p_draft uuid)
returns public.mara_drafts language plpgsql security definer set search_path = '' as $$
declare d public.mara_drafts;
begin
  select * into d from public.mara_drafts
    where id=p_draft and owner_user_id=p_owner for update;
  if d.id is null or d.kind not in ('tiktok_video','youtube_short')
     or d.status='rejected' or d.source_plan_id is null
     or d.source_plan_item_key is null then raise exception 'native_video_draft_unavailable'; end if;
  if (d.kind='tiktok_video' and (d.social_channel is distinct from 'tiktok' or d.social_format is distinct from 'video'))
     or (d.kind='youtube_short' and (d.social_channel is distinct from 'youtube' or d.social_format is distinct from 'short')) then
    raise exception 'native_video_draft_unavailable';
  end if;
  perform 1 from public.tiktok_publish_queue where owner_user_id=p_owner and draft_id=p_draft for update;
  perform 1 from public.youtube_publish_queue where owner_user_id=p_owner and draft_id=p_draft for update;
  if exists(select 1 from public.tiktok_publish_queue where owner_user_id=p_owner and draft_id=p_draft
       and (status in ('posting','provider_processing','published') or tiktok_publish_id is not null))
     or exists(select 1 from public.youtube_publish_queue where owner_user_id=p_owner and draft_id=p_draft
       and (status in ('uploading','provider_processing','published') or upload_session_url is not null or youtube_video_id is not null)) then
    raise exception 'native_video_provider_owned';
  end if;
  return d;
end $$;

create function public.begin_native_video_generation(p_owner uuid,p_draft uuid,p_generation uuid,p_key text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare d public.mara_drafts;
begin
  d := public.lock_native_video_draft(p_owner,p_draft);
  if exists(select 1 from public.mara_media_generations where owner_user_id=p_owner and draft_id=p_draft
      and provider_job_id is null and provider_status in ('submitting','submission_uncertain')) then
    raise exception 'native_video_submission_uncertain';
  end if;
  if not exists(select 1 from public.businesses where owner_user_id=p_owner and plan in ('pro','max'))
     or not exists(select 1 from public.voom_credit_ledger where owner_user_id=p_owner
       and generation_id=p_generation::text and media_type='video' and credits=40
       and source='user_request' and status in ('reserved','settled')) then
    raise exception 'native_video_credit_reservation_required';
  end if;
  if p_key not like ('video:post:' || p_draft::text || ':%') then raise exception 'native_video_invalid_key'; end if;
  -- Reserve the existing active-job uniqueness constraint BEFORE paid AI or
  -- base-image work. A losing concurrent click cannot call any provider.
  insert into public.mara_media_generations(id,owner_user_id,draft_id,conversation_id,
    media_type,prompt,aspect_ratio,status,idempotency_key,spend_source)
    values(p_generation,p_owner,p_draft,d.conversation_id,'video','Preparing native video','9:16','queued',p_key,'user_request');
  update public.mara_drafts set status='draft',
    content_meta=coalesce(content_meta,'{}'::jsonb)-'tiktokPost'
    where id=p_draft and owner_user_id=p_owner;
  -- 0059 withdraws approved jobs. Also close any unclaimed stale queue row.
  update public.tiktok_publish_queue set status='cancelled',claimed_at=null
    where owner_user_id=p_owner and draft_id=p_draft and tiktok_publish_id is null
      and status in ('scheduled','waiting_for_media','needs_declaration','permission_required');
  update public.youtube_publish_queue set status='cancelled',claimed_at=null
    where owner_user_id=p_owner and draft_id=p_draft and upload_session_url is null
      and status in ('scheduled','waiting_for_media','needs_declaration','permission_required');
  delete from public.content_calendar_items where owner_user_id=p_owner and source_draft_id=p_draft;
  return true;
exception when unique_violation then return false;
end $$;

create function public.complete_native_video_generation(p_owner uuid,p_generation uuid,
  p_path text,p_bytes bigint,p_duration numeric,p_name text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare g public.mara_media_generations; d public.mara_drafts;
begin
  select * into g from public.mara_media_generations where id=p_generation and owner_user_id=p_owner;
  if g.id is null then return false; end if;
  d := public.lock_native_video_draft(p_owner,g.draft_id);
  select * into g from public.mara_media_generations where id=p_generation and owner_user_id=p_owner for update;
  if g.status <> 'processing' or g.media_type <> 'video'
     or exists(select 1 from public.mara_media_generations x where x.owner_user_id=p_owner
       and x.draft_id=g.draft_id and x.media_type='video' and x.created_at>g.created_at) then return false; end if;
  if p_path is distinct from (p_owner::text || '/native-video/' || g.draft_id::text || '/' || p_generation::text || '.mp4')
     or p_bytes is null or p_bytes<=0 or p_bytes>20971520
     or p_duration is null or p_duration<4 or p_duration>15 then raise exception 'native_video_invalid_asset'; end if;
  -- Copy, hashtags, script, proposed time, privacy and audience stay untouched.
  -- Media changes revoke approval via 0059; TikTok's previous per-post consent
  -- is removed, never reused for generated/replaced bytes.
  update public.mara_drafts set status='draft',content_meta=
    (case when d.kind='youtube_short' then coalesce(content_meta,'{}'::jsonb)-'tiktokPost'-'containsSyntheticMedia'
      else coalesce(content_meta,'{}'::jsonb)-'tiktokPost' end) || '{"maraGeneratedVideo":true}'::jsonb
    where id=d.id and owner_user_id=p_owner;
  insert into public.post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status)
    values(p_owner,d.id,p_path,left(p_name,180),'video/mp4',p_bytes,'uploaded_existing','uploaded')
    on conflict(owner_user_id,draft_id) do update set storage_path=excluded.storage_path,
      display_name=excluded.display_name,mime_type=excluded.mime_type,byte_size=excluded.byte_size,
      origin=excluded.origin,status=excluded.status;
  update public.mara_media_generations set status='completed',storage_path=p_path,mime_type='video/mp4',
    byte_size=p_bytes,duration_seconds=round(p_duration),completed_at=now(),error_code=null,
    provider_status='completed',provider_retry_after_at=null where id=p_generation and owner_user_id=p_owner;
  return true;
end $$;

-- A native draft cannot be approved while generation is in flight. The same
-- draft lock serializes this check against begin/complete, including races.
create function public.guard_native_video_generation_approval()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind='youtube_short' and new.status='approved'
     and new.content_meta->>'maraGeneratedVideo'='true'
     and jsonb_typeof(new.content_meta->'containsSyntheticMedia') is distinct from 'boolean' then
    raise exception 'youtube_synthetic_declaration_required';
  end if;
  if new.kind in ('tiktok_video','youtube_short') and new.status='approved'
     and exists(select 1 from public.mara_media_generations where owner_user_id=new.owner_user_id
       and draft_id=new.id and media_type='video' and status in ('queued','generating','processing')) then
    raise exception 'native_video_review_after_generation';
  end if;
  return new;
end $$;
create trigger native_video_generation_approval_guard before update on public.mara_drafts
  for each row execute function public.guard_native_video_generation_approval();

revoke all on function public.lock_native_video_draft(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.begin_native_video_generation(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.complete_native_video_generation(uuid,uuid,text,bigint,numeric,text) from public,anon,authenticated;
revoke all on function public.guard_native_video_generation_approval() from public,anon,authenticated,service_role;
grant execute on function public.begin_native_video_generation(uuid,uuid,uuid,text) to service_role;
grant execute on function public.complete_native_video_generation(uuid,uuid,text,bigint,numeric,text) to service_role;
commit;
