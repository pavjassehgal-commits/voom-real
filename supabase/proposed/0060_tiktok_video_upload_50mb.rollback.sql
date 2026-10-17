-- Rollback for 0060_tiktok_video_upload_50mb.sql.
-- Refuses to run while any stored asset is larger than 20 MB, because the
-- restored 0021 check would reject those rows. Remove or replace those
-- videos first.

begin;

do $$
begin
  if exists (select 1 from public.post_draft_assets where byte_size > 20971520) then
    raise exception 'rollback_blocked: post_draft_assets contains files larger than 20 MB';
  end if;
end;
$$;

drop trigger if exists enforce_post_draft_asset_size on public.post_draft_assets;
drop function if exists public.enforce_post_draft_asset_size();
alter table public.post_draft_assets drop constraint if exists post_draft_assets_byte_size_limit;
alter table public.post_draft_assets
  add constraint post_draft_assets_byte_size_check check (byte_size between 1 and 20971520);

commit;
