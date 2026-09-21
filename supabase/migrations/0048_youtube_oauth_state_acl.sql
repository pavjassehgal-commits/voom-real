-- 0048_youtube_oauth_state_acl.sql
--
-- The YouTube OAuth connect/callback routes persist and consume CSRF state
-- with the server-side Supabase service-role client. Migration 0047 revoked
-- public/anon/authenticated access but did not grant the service role the
-- direct table privileges required by those two deliberately narrow writes.
--
-- Keep RLS enabled and keep browser roles fully revoked. This migration only
-- restores the least privileges used by server code:
--   * sanitized connection metadata reads in server-side workflow workers;
--   * OAuth state insert + single-use consume (UPDATE ... RETURNING requires
--     SELECT as well as UPDATE through PostgREST).

begin;

grant select on table public.youtube_connections to service_role;
grant select, insert, update on table public.youtube_oauth_states to service_role;

commit;
