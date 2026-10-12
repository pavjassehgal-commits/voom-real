-- PROPOSED, NOT APPLIED. voom-staging (qcdpegwjofrqnfudyrqq) ONLY.
-- First end-to-end MARA test with an automatically collected event.
--
-- Prerequisite (done by the owner in the dashboard, not by this script):
--   Authentication > Users > Add user > Create new user
--   email trend-detailing-test@voom.today, auto-confirm. Synthetic test
--   account only; no real customer data.
--
-- This script, in one transaction:
--   1. refuses unless that synthetic user exists, has no business yet, and
--      the Wikidata observation 5d32a918-4af0-455c-8ae4-0e19f0253aaa is
--      still stored, unexpired and not invalidated;
--   2. creates the SYNTHETIC business "Gulf Gloss Auto Detailing (TEST)"
--      (manual mode, automatic paid media OFF, media budget 0);
--   3. records ONE owner-reviewed MARA trend context for that owner only,
--      valid until the linked observation expires (2026-10-26 00:00 UTC).
-- Dates were verified on 2026-10-12 against formula1.com (2026 calendar)
-- and fia.com (FIA and Formula 1 announce 2026 calendar, 9 June 2025).

begin;

do language plpgsql '
begin
  if not exists (select 1 from auth.users where email = ''trend-detailing-test@voom.today'') then
    raise exception ''09 requires the synthetic user trend-detailing-test@voom.today'';
  end if;
  if exists (select 1 from public.businesses b join auth.users u on u.id = b.owner_user_id
              where u.email = ''trend-detailing-test@voom.today'') then
    raise exception ''09 refuses: the synthetic user already has a business'';
  end if;
  if not exists (
    select 1 from public.trend_observations o
     where o.id = ''5d32a918-4af0-455c-8ae4-0e19f0253aaa''
       and o.source_id = ''wikidata_events'' and o.subject_text = ''2026 Abu Dhabi Grand Prix''
       and o.platform = ''web'' and o.country = ''AE'' and o.language = ''en''
       and o.expires_at > now() and o.delete_after > now()
       and not exists (select 1 from public.trend_observation_invalidations i where i.observation_id = o.id)
  ) then
    raise exception ''09 requires the usable 2026 Abu Dhabi Grand Prix observation'';
  end if;
end';

insert into public.businesses
  (owner_user_id, brand_name, brand_description, industry, target_customer, main_goal, brand_personality,
   preferred_channels, content_frequency, automation_level, onboarding_completed, timezone,
   allow_automatic_paid_media, monthly_media_budget_usd)
select u.id,
       'Gulf Gloss Auto Detailing (TEST)',
       'SYNTHETIC TEST BUSINESS. Premium hand car detailing, paint correction and ceramic coating in Abu Dhabi and Dubai.',
       'Premium car detailing',
       array['Car owners in Abu Dhabi and Dubai who care about how their car looks'],
       'Get more detailing bookings in the weeks before December',
       array['precise', 'premium', 'calm'],
       array['Instagram', 'TikTok', 'YouTube'],
       '3x_week',
       'manual',
       true,
       'Asia/Dubai',
       false,
       0
  from auth.users u
 where u.email = 'trend-detailing-test@voom.today';

insert into public.trend_mara_contexts
  (owner_user_id, trend_key, platform, market_country, market_language, topic, event_start, event_end,
   facts, observed_at, confidence, caveats, observation_ids, status, reviewed_by, reviewed_at, valid_until)
select u.id,
       'topic|web|AE|en|topic|2026 abu dhabi grand prix',
       'web', 'AE', 'en',
       '2026 Abu Dhabi Grand Prix',
       date '2026-12-04', date '2026-12-06',
       jsonb_build_array(
         jsonb_build_object(
           'statement', 'The 2026 Abu Dhabi Grand Prix, a Formula 1 race, takes place on 4-6 December 2026.',
           'sources', jsonb_build_array(
             'Formula 1 official 2026 calendar, formula1.com (checked 2026-10-12)',
             'FIA and Formula 1 announce 2026 calendar, fia.com (9 June 2025)',
             'Wikidata Q115910679 (CC0)')),
         jsonb_build_object(
           'statement', 'It is held at Yas Marina in Abu Dhabi and is the final race of the 2026 Formula 1 season.',
           'sources', jsonb_build_array(
             'FIA and Formula 1 announce 2026 calendar, fia.com (9 June 2025)',
             'Formula 1 official 2026 calendar, formula1.com (checked 2026-10-12)'))),
       timestamptz '2026-10-12T16:51:07.482Z',
       'low',
       jsonb_build_array(
         'Do not imply any partnership, sponsorship or official link with Formula 1, the FIA, Yas Marina or the event, and do not use their logos.',
         'Voom has no attendance, popularity or traffic figures for this event; do not state any.',
         'Mention only services the business actually offers; no invented offers, discounts, prices or results.',
         'Dates verified against formula1.com and fia.com on 2026-10-12. This context expires on 2026-10-26 with its source observation.'),
       array['5d32a918-4af0-455c-8ae4-0e19f0253aaa'::uuid],
       'approved',
       'owner:pavjassehgal-commits',
       now(),
       timestamptz '2026-10-26T00:00:00Z'
  from auth.users u
 where u.email = 'trend-detailing-test@voom.today';

-- Expected: one row, approved, valid until 2026-10-26 00:00 UTC.
select b.brand_name, c.topic, c.status, c.event_start, c.event_end, c.valid_until, c.observation_ids
  from public.trend_mara_contexts c
  join public.businesses b on b.owner_user_id = c.owner_user_id
 where b.brand_name = 'Gulf Gloss Auto Detailing (TEST)';

commit;
