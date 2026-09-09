-- Persisted `What should MARA create?` brief for Post/Reel/Story media generation.
--
-- Adds a nullable text column `media_brief` to public.mara_drafts so the user's
-- free-form direction to MARA survives a reload, a close/reopen of the editor,
-- and a regeneration. The column is:
--   * nullable (old rows stay valid, empty means no brief),
--   * limited to 800 characters (the same limit the API already enforces),
--   * never grants extra privileges, never touches RLS, storage, or publishing.
--
-- No other table is touched. The existing 0021-0025 migrations stay exactly as
-- they were. This file is additive only.

begin;

alter table public.mara_drafts
  add column if not exists media_brief text
  check (media_brief is null or char_length(media_brief) <= 800);

commit;
