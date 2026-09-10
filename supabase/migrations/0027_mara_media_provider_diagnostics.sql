-- Store bounded, server-only provider rejection diagnostics for support investigations.
begin;

alter table public.mara_media_generations
  add column if not exists provider_diagnostic jsonb;

alter table public.mara_media_generations
  add constraint mara_media_provider_diagnostic_object
  check (provider_diagnostic is null or jsonb_typeof(provider_diagnostic) = 'object');

-- Deliberately not added to the authenticated select grant; diagnostics are service-role only.
commit;
