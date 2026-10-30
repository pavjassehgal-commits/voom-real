-- 0060 — TikTok draft videos up to 50 MB (direct, resumable uploads).
--
-- STATUS: NOT APPLIED anywhere. Apply to STAGING only, after review and
-- explicit approval. Rollback: supabase/proposed/0060_tiktok_video_upload_50mb.rollback.sql
--
-- What changes (and nothing else):
--   * post_draft_assets.byte_size may now be up to 52,428,800 bytes (50 MB),
--     replacing the 20 MB check from 0021;
--   * a trigger keeps every other upload at the old 20 MB limit: only an MP4
--     attached to the same owner's `tiktok_video` draft may exceed 20 MB.
--
-- Additive in effect: every existing row already satisfies both rules, no
-- data is rewritten, no policy or grant changes, and the storage bucket is
-- untouched (its 500 MB limit and the project's 50 MB global limit stay).

begin;

-- Drop the 0021 byte_size check by definition rather than by name, so this
-- works whatever name the database gave it.
do $$
declare
  v_name text;
begin
  for v_name in
    select conname
    from pg_constraint
    where conrelid = 'public.post_draft_assets'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%byte_size%'
  loop
    execute format('alter table public.post_draft_assets drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.post_draft_assets
  add constraint post_draft_assets_byte_size_limit check (byte_size between 1 and 52428800);

create or replace function public.enforce_post_draft_asset_size()
returns trigger
language plpgsql
set search_path = ''
as $$
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
$$;

revoke all on function public.enforce_post_draft_asset_size() from public, anon, authenticated;

drop trigger if exists enforce_post_draft_asset_size on public.post_draft_assets;
create trigger enforce_post_draft_asset_size
  before insert or update of byte_size, mime_type, draft_id, owner_user_id on public.post_draft_assets
  for each row execute function public.enforce_post_draft_asset_size();

commit;
