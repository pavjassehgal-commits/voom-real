-- Separate approval required. No automatic rollback or media deletion.
-- Stop the new uploader/cleanup callers first. Rollback is forbidden once
-- any session or object exists: prefer a forward fix instead of losing data.
begin;
do $$declare object_count bigint;v_name text;v_max bigint;
begin
  -- The size check 0066 extended (whatever its name) and its generic limit.
  select conname,substring(pg_get_constraintdef(oid) from 'byte_size <= ([0-9]+)')::bigint into v_name,v_max
    from pg_constraint where conrelid='public.post_draft_assets'::regclass and contype='c'
      and pg_get_constraintdef(oid) ~ 'youtube-uploads';
  if v_name is null or v_max is null then raise exception 'youtube_upload_rollback_unexpected_schema';end if;
  if exists(select 1 from public.youtube_upload_sessions)
    or exists(select 1 from public.post_draft_assets where storage_path like '%/youtube-uploads/%' or byte_size>v_max)
    then raise exception 'youtube_upload_rollback_data_present';end if;
  if to_regclass('storage.objects') is not null then
    execute 'select count(*) from storage.objects where bucket_id=$1' into object_count using 'youtube-uploads';
    if object_count>0 then raise exception 'youtube_upload_rollback_objects_present';end if;
  end if;
end $$;
drop function public.finish_youtube_upload(uuid,uuid,uuid,uuid);
drop function public.attach_youtube_uploaded_video(uuid,uuid,bigint,text,text,bigint);
alter function public.attach_youtube_uploaded_video_pre_direct(uuid,uuid,bigint,text,text,bigint) rename to attach_youtube_uploaded_video;
revoke all on function public.attach_youtube_uploaded_video(uuid,uuid,bigint,text,text,bigint) from public,anon,authenticated;
grant execute on function public.attach_youtube_uploaded_video(uuid,uuid,bigint,text,text,bigint) to service_role;
drop function public.begin_youtube_upload(uuid,uuid,uuid,text,bigint,text);
drop function public.authorize_youtube_upload(uuid,uuid,uuid);
drop function public.claim_youtube_upload_validation(uuid,uuid,uuid);
drop function public.release_youtube_upload(uuid,uuid,uuid,uuid,boolean);
drop function public.claim_youtube_upload_cleanup(integer);
drop function public.finish_youtube_upload_cleanup(uuid,uuid,boolean);
drop table public.youtube_upload_sessions;
-- Restore the same-named generic size check with this database's own limit.
do $$declare v_name text;v_max bigint;
begin
  select conname,substring(pg_get_constraintdef(oid) from 'byte_size <= ([0-9]+)')::bigint into v_name,v_max
    from pg_constraint where conrelid='public.post_draft_assets'::regclass and contype='c'
      and pg_get_constraintdef(oid) ~ 'youtube-uploads';
  execute format('alter table public.post_draft_assets drop constraint %I',v_name);
  execute format('alter table public.post_draft_assets add constraint %I check (byte_size between 1 and %s)',v_name,v_max);
end $$;
-- Staging's TikTok trigger (0060) only: restore its exact reviewed body.
do $$declare v_src text;
begin
  select prosrc into v_src from pg_proc where oid=to_regprocedure('public.enforce_post_draft_asset_size()');
  if v_src ~ 'youtube-uploads' then
    create or replace function public.enforce_post_draft_asset_size()
    returns trigger
    language plpgsql
    set search_path = ''
    as $f$
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
$f$;
    revoke all on function public.enforce_post_draft_asset_size() from public, anon, authenticated;
  end if;
end $$;
delete from storage.buckets where id='youtube-uploads';
notify pgrst,'reload schema';
commit;
