-- Forward-only correction for already-installed 0066. No data backfill,
-- cleanup invocation, Storage request, worker activation or 0065 dependency.
begin;
do $preflight$
declare f record;
begin
  select p.prosrc,p.prosecdef,p.prorettype,p.proretset into f
    from pg_proc p where p.oid=to_regprocedure('public.claim_youtube_upload_cleanup(integer)');
  if f.prosrc is null or not f.prosecdef or not f.proretset
    or f.prorettype is distinct from to_regtype('public.youtube_upload_sessions')
    or md5(f.prosrc) not in ('858402bd2a9a44b516d8e3badbfd3166','bf5761068b01bf4f3de71518808c28d8') then
    raise exception 'youtube_upload_cleanup_unexpected_prerequisite';
  end if;
end $preflight$;

create or replace function public.claim_youtube_upload_cleanup(p_limit integer default 10)
returns setof public.youtube_upload_sessions language plpgsql security definer set search_path='' as $$
declare u public.youtube_upload_sessions; claimed integer:=0; claim_limit integer:=greatest(1,least(p_limit,25));
begin
  delete from public.youtube_upload_sessions where id in (
    select id from public.youtube_upload_sessions where status='deleted' and deleted_at<now()-interval '7 days' limit 100
  );
  -- Exclude protected references BEFORE selecting candidates. Bound actual
  -- claims, not inspected rows: a skipped/locked candidate must not consume
  -- the batch or indefinitely hide later eligible abandoned uploads.
  for u in select s.* from public.youtube_upload_sessions s
    where s.cleanup_after<now() and s.status<>'deleted'
      and (s.claimed_until is null or s.claimed_until<now())
      and (s.status<>'deleting' or s.claimed_until<now())
      and not exists(select 1 from public.post_draft_assets a where a.storage_path=s.storage_path)
      and not exists(select 1 from public.mara_media_generations g where g.storage_path=s.storage_path)
      and not exists(select 1 from public.reel_draft_assets a where a.storage_path=s.storage_path)
      and not exists(select 1 from public.instagram_media_assets a where a.storage_path=s.storage_path)
    order by s.cleanup_after,s.id loop
    exit when claimed>=claim_limit;
    -- Keep 0066's draft -> session lock order. Never wait behind active work.
    if u.draft_id is not null then
      perform 1 from public.mara_drafts where id=u.draft_id for update skip locked;
      if not found then continue;end if;
    end if;
    select s.* into u from public.youtube_upload_sessions s where s.id=u.id for update skip locked;
    if not found or u.status='deleted' or u.cleanup_after>=now()
      or u.claimed_until>=now() or (u.status='deleting' and u.claimed_until is null) then continue;end if;
    -- Recheck after locks: a reference may have appeared since the cursor
    -- snapshot. Any lookup failure aborts every claim in this transaction.
    if exists(select 1 from public.post_draft_assets where storage_path=u.storage_path)
      or exists(select 1 from public.mara_media_generations where storage_path=u.storage_path)
      or exists(select 1 from public.reel_draft_assets where storage_path=u.storage_path)
      or exists(select 1 from public.instagram_media_assets where storage_path=u.storage_path) then continue;end if;
    update public.youtube_upload_sessions set status='deleting',claim=gen_random_uuid(),claimed_until=now()+interval '10 minutes'
      where id=u.id returning * into u;
    claimed:=claimed+1;
    return next u;
  end loop;
end $$;
revoke all on function public.claim_youtube_upload_cleanup(integer) from public,anon,authenticated;
grant execute on function public.claim_youtube_upload_cleanup(integer) to service_role;
commit;
