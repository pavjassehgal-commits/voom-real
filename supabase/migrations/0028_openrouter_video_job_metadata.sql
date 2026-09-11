-- Durable OpenRouter video metadata for the existing MARA generation state machine.
-- The provider job id, polling URL and provider status are server-only fields;
-- they let a poll retry resume the same paid job without submitting another one.

begin;

alter table public.mara_media_generations
  add column if not exists provider_polling_url text
  check (provider_polling_url is null or char_length(provider_polling_url) <= 2048);

alter table public.mara_media_generations
  add column if not exists provider_status text
  check (provider_status is null or char_length(provider_status) <= 80);

alter table public.mara_media_generations
  add column if not exists provider_retry_after_at timestamptz;

-- provider_diagnostic already exists in 0027 and remains service-role only.
-- No client grants, RLS changes, publishing changes, or image-provider changes.

commit;
