-- Automated Campaigns v1 hotfix: corrected row-shape constraint.
--
-- Migration 0033 joined the two allowed voom_campaigns row shapes with AND
-- instead of OR. Under AND, every automated email child row fails the check
-- (its parent_campaign_id is not null, which makes the container branch
-- false), so every build containing an email raised Postgres 23514 and the
-- whole create_automated_campaign RPC rolled back.
--
-- This migration replaces ONLY public.voom_campaigns_automated_shape_check
-- with the corrected OR logic. It is idempotent (drop if exists + add),
-- touches no existing rows, makes no destructive data changes, and is safe
-- to re-run: every row that exists under the broken constraint already
-- satisfies the corrected one, so the constraint add validates cleanly.
--
-- Fresh installs already carry the corrected constraint from 0033; re-running
-- this file there simply re-adds an identical constraint.

begin;

alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_automated_shape_check;

alter table public.voom_campaigns
  add constraint voom_campaigns_automated_shape_check
  check (
    -- An automated top-level container must be multi-channel and carry goal + dates.
    (parent_campaign_id is null and (
      is_automated = false
      or (kind = 'multi' and goal is not null and start_at is not null and end_at is not null and end_at >= start_at)
    ))
    -- An automated child action campaign is email-only (never SMS).
    or (parent_campaign_id is not null and is_automated = true and kind = 'email')
  );

commit;
