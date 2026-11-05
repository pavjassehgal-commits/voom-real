-- Rollback for 0072: removes the write-time coordinator email-flow check. No
-- data is changed; the app-side checks before generation and write remain.
drop trigger if exists ensure_coordinator_email_flow_authorized on public.voom_email_flows;
drop function if exists public.guard_coordinator_email_flow();
