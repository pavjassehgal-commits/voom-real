-- Reel asset pack: up to six private owner-scoped assets per Reel draft.
-- PREPARED ONLY — this migration has NOT been applied. It must be explicitly
-- approved before it runs against any database.
--
-- What changes:
--   1. Lifts the one-asset-per-draft restriction (unique (owner_user_id, draft_id)).
--   2. Adds index for stable upload-order reads.
--   3. Adds add_reel_draft_asset / remove_reel_draft_asset RPCs (service_role
--      only) that enforce the 6-asset pack limit inside a locked transaction.
--   4. Keeps the original replace_reel_draft_asset RPC untouched so pre-migration
--      single-asset requests keep working; its ON CONFLICT (owner_user_id,
--      draft_id) branch becomes unused because an existing row is now updated
--      through the pack RPCs instead. The old RPC remains valid for the very
--      first asset insert (no conflict) and for rollback-ordered deployments.
-- What does NOT change:
--   - Bucket 'mara-media' stays private; allowed mime types unchanged.
--   - Table grants and RLS policies unchanged (authenticated may only SELECT
--     own rows; anon has none; writes are service_role only).
--   - Every asset keeps owner_user_id scoping, random server-only storage
--     paths, magic-byte validation, 4 MB cap, and short-lived signed URLs.
--   - Existing rows are preserved as-is; no asset is deleted or orphaned.
-- Rollback considerations:
--   - Dropping the unique constraint is not reversible by re-adding it while a
--     draft has more than one asset. Rollback = delete duplicate pack rows for
--     any draft (or move them), then re-add:
--       alter table public.reel_draft_assets
--         add constraint reel_draft_assets_owner_user_id_draft_id_key
--         unique (owner_user_id, draft_id);
--   - New functions can be dropped independently:
--       drop function public.add_reel_draft_asset(uuid,uuid,uuid,text,text,text,bigint);
--       drop function public.remove_reel_draft_asset(uuid,uuid,uuid,uuid);

begin;

-- 1) Lift the one-asset-per-draft restriction. Existing rows are preserved
--    unchanged; scenes order the pack by (created_at, id) = upload order.
alter table public.reel_draft_assets drop constraint if exists reel_draft_assets_owner_user_id_draft_id_key;

create index if not exists reel_draft_assets_pack_order
  on public.reel_draft_assets (owner_user_id, draft_id, created_at, id);

-- 2) Add one asset to a pack (max 6), checking the limit inside the same
--    locked transaction as the pending-action state update.
create or replace function public.add_reel_draft_asset(
  p_owner_user_id uuid, p_action_id uuid, p_draft_id uuid,
  p_storage_path text, p_display_name text, p_mime_type text, p_byte_size bigint
) returns table(asset_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_action public.mara_pending_actions%rowtype; v_count integer; v_id uuid;
begin
  if p_byte_size < 1 or p_byte_size > 4194304 or p_mime_type not in ('image/jpeg','image/png','image/webp','video/mp4','video/quicktime') then raise exception 'invalid_asset'; end if;
  select * into v_action from public.mara_pending_actions where id = p_action_id and owner_user_id = p_owner_user_id and tool_name = 'choose_reel_production' and status = 'pending' for update;
  if not found or v_action.new_value->>'draftId' <> p_draft_id::text or v_action.new_value->>'selectedProductionMethod' not in ('upload_asset','film_yourself') then raise exception 'invalid_reel_action'; end if;
  if p_mime_type like 'image/%' and not coalesce(v_action.new_value->'allowedAssetKinds' ? 'image', true) then raise exception 'image_not_allowed'; end if;
  if p_mime_type like 'video/%' and not coalesce(v_action.new_value->'allowedAssetKinds' ? 'video', true) then raise exception 'video_not_allowed'; end if;
  select count(*) into v_count from public.reel_draft_assets where owner_user_id = p_owner_user_id and draft_id = p_draft_id;
  if v_count >= 6 then raise exception 'asset_pack_full'; end if;
  insert into public.reel_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size)
  values (p_owner_user_id,p_draft_id,p_storage_path,p_display_name,p_mime_type,p_byte_size)
  returning id into v_id;
  update public.mara_pending_actions set
    sanitized_arguments = sanitized_arguments || jsonb_build_object('selectedProductionMethod',v_action.new_value->>'selectedProductionMethod','productionStatus','ready_for_mara_production','assetReceived',true,'assetCount',v_count + 1),
    new_value = new_value || jsonb_build_object('productionStatus','ready_for_mara_production','assetReceived',true,'assetCount',v_count + 1),
    result_summary = 'Asset received. ' || (v_count + 1) || ' of 6 possible assets added. Ready for future MARA production. No Reel was generated or published.',
    error_summary = null
  where id = p_action_id and owner_user_id = p_owner_user_id;
  return query select v_id;
end $$;

-- 3) Remove one asset from a pack; returns its storage path so the caller can
--    delete the private object afterwards. State falls back to waiting when
--    the pack becomes empty.
create or replace function public.remove_reel_draft_asset(
  p_owner_user_id uuid, p_action_id uuid, p_draft_id uuid, p_asset_id uuid
) returns table(storage_path text)
language plpgsql security definer set search_path = '' as $$
declare v_action public.mara_pending_actions%rowtype; v_storage text; v_count integer;
begin
  select * into v_action from public.mara_pending_actions where id = p_action_id and owner_user_id = p_owner_user_id and tool_name = 'choose_reel_production' and status = 'pending' for update;
  if not found or v_action.new_value->>'draftId' <> p_draft_id::text or v_action.new_value->>'selectedProductionMethod' not in ('upload_asset','film_yourself') then raise exception 'invalid_reel_action'; end if;
  select storage_path into v_storage from public.reel_draft_assets where id = p_asset_id and owner_user_id = p_owner_user_id and draft_id = p_draft_id for update;
  if not found then raise exception 'asset_not_found'; end if;
  delete from public.reel_draft_assets where id = p_asset_id and owner_user_id = p_owner_user_id and draft_id = p_draft_id;
  select count(*) into v_count from public.reel_draft_assets where owner_user_id = p_owner_user_id and draft_id = p_draft_id;
  update public.mara_pending_actions set
    sanitized_arguments = sanitized_arguments || jsonb_build_object('selectedProductionMethod',v_action.new_value->>'selectedProductionMethod','productionStatus', case when v_count = 0 then 'waiting_for_asset_upload' else 'ready_for_mara_production' end,'assetReceived', v_count > 0,'assetCount', v_count),
    new_value = new_value || jsonb_build_object('productionStatus', case when v_count = 0 then 'waiting_for_asset_upload' else 'ready_for_mara_production' end,'assetReceived', v_count > 0,'assetCount', v_count),
    result_summary = case when v_count = 0 then 'Asset removed. Waiting for at least one asset.' else v_count || ' of 6 possible assets remain. Ready for future MARA production.' end,
    error_summary = null
  where id = p_action_id and owner_user_id = p_owner_user_id;
  return query select v_storage;
end $$;

revoke all on function public.add_reel_draft_asset(uuid,uuid,uuid,text,text,text,bigint) from public, anon, authenticated;
grant execute on function public.add_reel_draft_asset(uuid,uuid,uuid,text,text,text,bigint) to service_role;
revoke all on function public.remove_reel_draft_asset(uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.remove_reel_draft_asset(uuid,uuid,uuid,uuid) to service_role;

commit;
