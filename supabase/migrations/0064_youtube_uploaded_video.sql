-- Link private uploads through the existing uploader. No jobs or providers run.
-- Apply before deploying the native YouTube upload control.
begin;

create function public.attach_youtube_uploaded_video(
  p_owner uuid, p_draft uuid, p_version bigint, p_path text, p_name text, p_bytes bigint
) returns boolean language plpgsql security definer set search_path = '' as $$
declare d public.mara_drafts;
begin
  -- Match existing draft-edit/native-generation lock order: draft, queue.
  -- The queue lock then excludes claims while media/approval are changed.
  select * into d from public.mara_drafts where id=p_draft and owner_user_id=p_owner for update;
  if d.id is null or d.kind not in ('youtube_video','youtube_short')
    or d.social_channel is distinct from 'youtube'
    or d.social_format is distinct from (case when d.kind='youtube_short' then 'short' else 'video' end) then
    raise exception 'youtube_upload_owner_required';
  end if;
  perform 1 from public.youtube_publish_queue
    where owner_user_id=p_owner and draft_id=p_draft for update;
  if exists(select 1 from public.youtube_publish_queue where owner_user_id=p_owner and draft_id=p_draft
    and (status in ('uploading','provider_processing','published') or upload_session_url is not null or youtube_video_id is not null)) then
    raise exception 'youtube_upload_provider_owned';
  end if;
  if exists(select 1 from public.mara_media_generations where owner_user_id=p_owner and draft_id=p_draft
    and (status in ('queued','generating','processing') or provider_status in ('submitting','submission_uncertain'))) then
    raise exception 'youtube_upload_generation_active';
  end if;
  if p_path is null or p_path !~ ('^' || p_owner::text || '/post-assets/[a-f0-9]{16}-' || p_draft::text || '[.]mp4$')
    or p_bytes is null or p_bytes<1 or p_bytes>4194304 or p_name is null or length(p_name)>180 then
    raise exception 'youtube_upload_invalid_asset';
  end if;
  -- Retrying the same bytes is a no-op, not a new attachment or approval.
  if exists(select 1 from public.post_draft_assets where owner_user_id=p_owner and draft_id=p_draft
    and storage_path=p_path and mime_type='video/mp4' and byte_size=p_bytes and status='uploaded') then return true; end if;
  if p_version is null or d.content_version<>p_version then return false; end if;

  -- Preserve copy, proposed time, privacy and COPPA choice. Media changes need
  -- new approval; a former generated video's synthetic declaration is stale.
  update public.mara_drafts set status='draft',
    content_meta=coalesce(content_meta,'{}'::jsonb)-'containsSyntheticMedia'
    where id=p_draft and owner_user_id=p_owner;
  update public.youtube_publish_queue set status='cancelled',claimed_at=null
    where owner_user_id=p_owner and draft_id=p_draft and upload_session_url is null and youtube_video_id is null
      and status in ('scheduled','waiting_for_media','needs_declaration','permission_required','failed');
  delete from public.content_calendar_items where owner_user_id=p_owner and source_draft_id=p_draft;
  insert into public.post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status)
    values(p_owner,p_draft,p_path,p_name,'video/mp4',p_bytes,'uploaded_existing','uploaded')
    on conflict(owner_user_id,draft_id) do update set storage_path=excluded.storage_path,
      display_name=excluded.display_name,mime_type=excluded.mime_type,byte_size=excluded.byte_size,
      origin=excluded.origin,status=excluded.status;
  return true;
end $$;

revoke all on function public.attach_youtube_uploaded_video(uuid,uuid,bigint,text,text,bigint) from public,anon,authenticated;
grant execute on function public.attach_youtube_uploaded_video(uuid,uuid,bigint,text,text,bigint) to service_role;
commit;
