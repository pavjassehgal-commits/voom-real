-- Permit the server-only scheduler to reuse the existing internal approval path.
-- No authenticated-user or anonymous grants and no RLS policies are changed.
begin;

grant insert, update on table public.content_calendar_items to service_role;

commit;
