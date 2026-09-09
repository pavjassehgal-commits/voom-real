-- Durable video generation jobs for MARA Reel/Story video production.
--
-- Reuses public.mara_media_generations (migration 0008) as the durable
-- generation-job model. This migration only ADDS to that table:
--   * a 'generating' status value (a real provider job is in flight; the
--     provider job id is already persisted on the row),
--   * generation_mode — how the output was produced (text-to-video,
--     image-to-video from a user asset, or image-to-video from a MARA
--     generated base image), so cost/usage accounting can be added later,
--   * source_asset_id — the private asset that seeded an image-to-video job,
--   * overlay — the deterministic Voom overlay plan (JSON) applied to the
--     base media, never rendered by the provider,
--   * started_at / attempt_count — lifecycle and retry accounting,
--   * a partial unique index guaranteeing at most ONE active generation per
--     (owner, draft), which is the database-level duplicate-job guard.
--
-- Nothing here touches the publishing pipeline, the bucket, or any existing
-- row. RLS, policies and grants from 0008 stay exactly as they were.

begin;

alter table public.mara_media_generations
  drop constraint if exists mara_media_generations_status_check;
alter table public.mara_media_generations
  add constraint mara_media_generations_status_check
  check (status in ('pending_confirmation','queued','generating','processing','completed','failed','cancelled'));

alter table public.mara_media_generations
  add column if not exists generation_mode text
  check (generation_mode is null or generation_mode in
    ('text_to_image','text_to_video','image_to_video','generated_image_to_video'));

alter table public.mara_media_generations
  add column if not exists source_asset_id uuid;

alter table public.mara_media_generations
  add column if not exists overlay text
  check (overlay is null or char_length(overlay) <= 4000);

alter table public.mara_media_generations
  add column if not exists started_at timestamptz;

alter table public.mara_media_generations
  add column if not exists attempt_count integer not null default 0
  check (attempt_count >= 0);

-- Duplicate-generation protection: a draft may never have more than one
-- active job. Terminal states (completed/failed/cancelled) do not block a
-- regeneration; a new job replaces the draft's asset only after it completes
-- and validates, so a failed regeneration can never destroy the current
-- good asset.
create unique index if not exists mara_media_active_per_draft_uq
  on public.mara_media_generations(owner_user_id, draft_id)
  where draft_id is not null and status in ('queued','generating','processing');

-- Owner-scoped status reads for the studio UI (latest job per draft).
create index if not exists mara_media_owner_draft_created_idx
  on public.mara_media_generations(owner_user_id, draft_id, created_at desc);

commit;
