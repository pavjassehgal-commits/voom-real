-- One private, owner-scoped user asset per Reel draft. Uploads remain internal.
begin;

create table public.reel_draft_assets (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  draft_id uuid not null,
  storage_path text not null check (char_length(storage_path) between 20 and 500),
  display_name text not null check (char_length(display_name) between 1 and 180),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','video/mp4','video/quicktime')),
  byte_size bigint not null check (byte_size between 1 and 4194304),
  status text not null default 'uploaded' check (status = 'uploaded'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, draft_id),
  unique (owner_user_id, storage_path),
  foreign key (draft_id, owner_user_id) references public.mara_drafts(id, owner_user_id) on delete cascade
);

alter table public.reel_draft_assets enable row level security;
revoke all on table public.reel_draft_assets from public, anon, authenticated;
grant select (id, draft_id, display_name, mime_type, byte_size, status, created_at, updated_at) on table public.reel_draft_assets to authenticated;
grant select, insert, update, delete on table public.reel_draft_assets to service_role;

create policy "reel_draft_assets_select_own" on public.reel_draft_assets
  for select to authenticated using ((select auth.uid()) = owner_user_id);

create trigger set_reel_draft_assets_updated_at before update on public.reel_draft_assets
  for each row execute function public.set_updated_at();

update storage.buckets set
  public = false,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime']
where id = 'mara-media';

create or replace function public.replace_reel_draft_asset(
  p_owner_user_id uuid, p_action_id uuid, p_draft_id uuid, p_storage_path text,
  p_display_name text, p_mime_type text, p_byte_size bigint
) returns table(previous_storage_path text)
language plpgsql security definer set search_path = '' as $$
declare v_action public.mara_pending_actions%rowtype; v_previous text;
begin
  if p_byte_size < 1 or p_byte_size > 4194304 or p_mime_type not in ('image/jpeg','image/png','image/webp','video/mp4','video/quicktime') then raise exception 'invalid_asset'; end if;
  select * into v_action from public.mara_pending_actions where id = p_action_id and owner_user_id = p_owner_user_id and tool_name = 'choose_reel_production' and status = 'pending' for update;
  if not found or v_action.new_value->>'draftId' <> p_draft_id::text or v_action.new_value->>'selectedProductionMethod' not in ('upload_asset','film_yourself') then raise exception 'invalid_reel_action'; end if;
  if p_mime_type like 'image/%' and not coalesce(v_action.new_value->'allowedAssetKinds' ? 'image', true) then raise exception 'image_not_allowed'; end if;
  if p_mime_type like 'video/%' and not coalesce(v_action.new_value->'allowedAssetKinds' ? 'video', true) then raise exception 'video_not_allowed'; end if;
  select storage_path into v_previous from public.reel_draft_assets where owner_user_id = p_owner_user_id and draft_id = p_draft_id for update;
  insert into public.reel_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size)
  values (p_owner_user_id,p_draft_id,p_storage_path,p_display_name,p_mime_type,p_byte_size)
  on conflict (owner_user_id,draft_id) do update set storage_path=excluded.storage_path,display_name=excluded.display_name,mime_type=excluded.mime_type,byte_size=excluded.byte_size,status='uploaded';
  update public.mara_pending_actions set
    sanitized_arguments = sanitized_arguments || jsonb_build_object('selectedProductionMethod',v_action.new_value->>'selectedProductionMethod','productionStatus','ready_for_mara_production','assetReceived',true),
    new_value = new_value || jsonb_build_object('productionStatus','ready_for_mara_production','assetReceived',true,'assetName',p_display_name,'assetMimeType',p_mime_type,'assetByteSize',p_byte_size),
    result_summary = 'Asset received. Ready for future MARA production. No Reel was generated or published.', error_summary = null
  where id = p_action_id and owner_user_id = p_owner_user_id;
  return query select v_previous;
end $$;

revoke all on function public.replace_reel_draft_asset(uuid,uuid,uuid,text,text,text,bigint) from public, anon, authenticated;
grant execute on function public.replace_reel_draft_asset(uuid,uuid,uuid,text,text,text,bigint) to service_role;

commit;
