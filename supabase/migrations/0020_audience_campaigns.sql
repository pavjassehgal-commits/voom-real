-- Audience targeting for Voom campaigns.
-- Prepared for review; do not apply without explicit approval.
--
-- Links a campaign draft to one owned audience. This changes no 0018/0019
-- semantics: approval stays explicit, sends still go through the 0018
-- per-recipient claim lifecycle, and the linked audience is re-resolved
-- server-side at send time.

begin;

alter table public.voom_campaigns
  add column if not exists audience_id uuid;

-- Cross-owner safe by construction: the composite foreign key can only
-- reference an audience owned by the campaign's own owner_user_id. Deleting
-- an audience clears the link on its campaigns instead of deleting them.
alter table public.voom_campaigns
  drop constraint if exists voom_campaigns_audience_fk;
alter table public.voom_campaigns
  add constraint voom_campaigns_audience_fk
  foreign key (audience_id, owner_user_id)
  references public.audiences (id, owner_id)
  on delete set null (audience_id);

-- Partial index: only campaigns that actually target an audience are indexed.
create index if not exists voom_campaigns_owner_audience_idx
  on public.voom_campaigns (owner_user_id, audience_id)
  where audience_id is not null;

commit;
