# Brand Kit v2: onboarding, Brand Hub and what generation reads

Design agreed with Gurnoor on 2026-10-21 and 2026-10-22. Slice 1 (storage + reader) is built;
the rest is the plan. If the code and this file disagree, the code wins; update this file in the
same change.

## Goals and rules
- Extract, don't interrogate: the user types as little as possible; MARA reads the website, the
  description and the uploaded posts, then asks the user to confirm or correct.
- Every stored field names the generation path that reads it (field map below). A field no
  generation path reads is cut or moved to the collect-later list.
- At most 5 required answers: your name, description, category, main goal, automation level.
- One topic per screen, tappable options, visible progress, MARA's voice, under 5 minutes.
- Per-screen Skip where allowed. No global Skip.
- Instagram is never scraped. Posts come only through the official API after the user connects
  their account on the last screen, or as files the user uploads themselves.

## Decisions taken on the way (see DECISIONS.md 2026-10-22)
- **Removed from onboarding:** the monthly ad budget question (nothing live reads it; paid ads are
  not built) and the "should MARA ask before publishing?" question (nothing live reads it; the
  automation level already answers it and the two could contradict each other). The database
  columns stay; the Settings form still shows them until the Brand Hub replaces that form.
- **Kept:** the automation level screen. Manual / Assisted / Autopilot is read by the planner,
  the coordinator, the credit guard, campaigns, email flows and the Today page. The screen will
  show the three real modes with the plan each needs (Free: Manual; Pro: Manual + Assisted;
  Max: all three) and save the real values. Today the wizard saves the card's title text (for
  example "I decide everything"), which every reader treats as Assisted; slice 3 fixes that and
  migrates existing rows.
- **Screen 2 asks for past posts as files**, not an Instagram connection. Connecting Instagram
  stays on the last screen with the other channels.

## Screens (12, "Step n of 12")

| # | Screen and copy | Required | Prefilled from |
|---|---|---|---|
| 1 | **What should MARA call you?** "This is how she'll greet you." | yes | nothing |
| 2 | **Give MARA your brand.** "Anything here saves you typing later. All optional." Rows: Website (URL field, "MARA reads your public pages, nothing private"). Logo upload. Product or service photos (up to 10, each with a one-line "what is this?" that MARA fills and you can fix). **Past posts you're proud of** (4 to 5 images or short videos from anywhere you've posted before Voom). One line under the uploads: *"MARA uses these to keep your current look and voice. Only share work you'd be happy to see more of. Anything you upload here shapes the images and captions she creates, so leave out posts that don't represent your brand."* | no | nothing |
| 3a | **Describe your brand in your own words.** As today, 5-word minimum. | yes | nothing |
| 3b | **Here's what I learned.** "From your description, website and posts. Correct anything wrong, confirm what's right." Cards with Confirm / Edit: Name · Category · What you offer · Who it's for · How you sound · Facts you claim. Unconfirmed facts are never used in captions. If extraction isn't finished: "Still reading your site. I'll put this on your Brand page." | no | description, website, uploads |
| 4 | **The basics.** Business name + category tiles as today, prefilled and marked "from your website". | category yes | extraction |
| 5 | **Who you serve, and why.** Audience chips + goal tiles as today; suggested chips highlighted "MARA's guess". | goal yes | extraction |
| 6 | **How you sound.** Personality chips as today, then three captions MARA wrote from what she knows so far, each with "Sounds like us" / "Not us". If the AI call fails or takes over 8 s: chips only, "I'll show you samples on your Brand page." | no | extraction |
| 7 | **What you DON'T want.** Six tappable cards: Not salesy · No "buy now" or discount shouting · No stock-photo people · No AI-looking faces · No meme or trend-chasing · No invented or unprovable claims. Then "Words, topics or emoji to ban" (free text) and "Anything specific MARA should know or do?" | no | nothing |
| 8 | **How often should MARA post?** Pace tiles as today, "2–3 times a week" preselected so Skip is safe. (Budget question removed.) | no | default |
| 9 | **How much should MARA do.** Three cards: Manual · Assisted (recommended) · Autopilot, each with the plan it needs. Saves `manual` / `assisted` / `autopilot`. A choice above the account's plan saves the allowed mode and keeps the wanted one in the kit (`wanted_automation`) for the upgrade prompt. (Permission question removed.) | yes | nothing |
| 10a | **Your Brand Brief.** MARA writes 4 to 6 short paragraphs (what you are, what you offer, who it's for, how you sound, what to avoid, facts she may state). Each editable inline. Button "Looks right". This is the Brand Hub component in onboarding mode. | no | everything above |
| 10b | **Your channels.** Chips Instagram, TikTok; LinkedIn chip disabled "Coming soon". Connection rows for Instagram and TikTok only ("Connect Instagram" lives here). YouTube and Email rows removed from onboarding; they stay available in Settings for existing accounts. | no | nothing |

## Data

### `brand_kits` (migration 0059, built)
Append-only. Every edit inserts a new row; the version list is the history.

| Column | Type | Notes |
|---|---|---|
| id | uuid | |
| owner_user_id | uuid → auth.users | RLS: select and insert own rows only; no update or delete for users |
| version | int ≥ 1 | unique with owner; newest = highest |
| answers | jsonb object | field-map keys below, plus later `provenance` (per key: user / description / website / upload) and `unconfirmed` (keys not yet confirmed) |
| brief | text ≤ 6000 | the confirmed Brand Brief |
| assets | jsonb array | `{ id, kind: logo / product / past_post, path, description, chips }`; references only, never bytes |
| source | onboarding / brand_hub / extraction | |
| change_summary | text ≤ 300 | "Audience changed", shown in history |
| changed_keys | text[] | history filter |
| created_at | timestamptz | |

Bucket `brand-kit`: private, images only (jpeg, png, webp), 10 MB per file, path
`<owner_user_id>/<kind>/<uuid>.<ext>`. Uploads go through server code with the service role,
like `mara-media`. Website snapshots live under `answers.sources.website`, never in a table of
their own.

**Version rule (built).** A new version starts from the previous one and replaces only the
fields the save owns (by field, never by word); every other field carries over. Clearing a field
the screen shows really clears it. `changed_keys` records what actually changed.

**Dual write (built).** `saveOnboarding` and `saveBrandSettings` keep writing the existing
`businesses` columns and also append a kit version (source `onboarding` / `brand_hub`). The kit
insert is best-effort: a failure is logged and never fails the user's save, because the core
fields are read from `businesses`.

**Reader (built): `lib/brand/context.ts`.** `loadBrandContext()` = core fields from `businesses`
+ `loadBrandKit()` extras from the newest kit row (brief, offerings, avoid rules, banned words,
facts, notes, voice samples). Reading never throws: any failure is logged and read as "no kit".
`brandKitPromptContext()` turns the extras into the `brandKit` payload block (null when empty)
and `withBrandKitRules()` appends the BRAND KIT rules to a system prompt only when a block
exists, so prompts for accounts without a kit are byte-for-byte unchanged.

### Field map
"Reads it today" = live code after slice 1. Keys are `answers.<key>` unless noted.

| Field | Reads it today | When missing |
|---|---|---|
| `profiles.display_name` | Post Studio name fallback | business name used |
| name (`businesses.brand_name`) | Post Studio, weekly plan, Reel/Story visuals, campaigns, coordinator | your name, then "Your business" |
| description | all of the above | plan still runs, generic copy |
| category (`industry`) | all of the above | required |
| audience (`target_customer`) | all of the above | captions go broad |
| goal (`main_goal`) | plan, Post Studio, visuals, trend grounding | required |
| personality (`brand_personality`) | Post Studio, plan, visuals, campaign voice, coordinator | neutral tone |
| pace (`content_frequency`) | plan cadence, Post Studio scheduling suggestion | default "2–3 times a week" |
| automation (`automation_level`) | plan mode, coordinator, credit guard, campaigns, email flows, Today | Assisted (Manual on Free) |
| channels (`preferred_channels`) | plan channel selection | no social slots, "no channel selected" notice |
| `brief` (column) | Post Studio copy/Story/suggestions, weekly plan (via `brandKit`) | raw description used |
| offerings[] | same, as `brandKit.offerings` | MARA infers from description |
| avoid.rules[] | same, as hard rules (`brandKit.mustAvoid`) | no rules |
| avoid.words[] | same, `brandKit.bannedWords` | nothing banned |
| facts_confirmed[] | same, the only specific facts MARA may state | MARA states no facts |
| notes | same, `brandKit.ownerNotes` | nothing |
| voice_samples {liked, disliked} | same, `brandKit.voiceSamples` | no examples |
| website_url | email engine (link, button) via `voom_email_brands`; reading pipeline (slice 7) | no extraction |
| assets.logo | email engine logo (synced to `voom_email_brands`); colours (slice 5) | no logo in emails |
| colours {primary, secondary} | email engine; visual prompts (slice 5) | no colour hints |
| assets.products[] + description | visual prompts read the descriptions (slice 5); reference-image generation not built | visuals invented from text |
| assets.past_posts[] + chips | style hints in visual prompts (slice 5) | no hints |
| sources.website snapshot | extraction input only (slice 7) | no prefill |
| sources.instagram_posts[] | extraction input after connect (slice 8), official API only | no prefill |
| budget (`monthly_ad_budget`) | **nothing live** (retired chat prompt only); removed from onboarding | nothing |
| publishing_permission | **nothing live**; removed from onboarding | nothing |

**Collect later** (Brand Hub, optional, `answers.extra`; no reader today so no screens): personas,
visual-direction picking, filming comfort, customer-photo permission, awards and years beyond
confirmed facts, competitor and admired accounts, languages (incl. Hinglish), city and key dates,
shop/booking/WhatsApp links, FAQs, testimonials, hashtags, regulated-industry limits.

## Website reading pipeline (slice 7)
Server action starts a read when a URL is entered; progress in `answers.sources.website.status`.
Normalise URL (http/https only, ports 80/443) → resolve DNS and refuse private, loopback,
link-local and internal ranges, re-checked on every redirect, max 3 redirects, same host only →
obey robots.txt → GET homepage with 10 s and 2 MB caps, no cookies, no JavaScript, plain Voom
user agent → up to 4 more same-host pages whose path contains about, services, products, menu,
shop or pricing → per page take title, meta description, headings, paragraphs (≤ 8,000 chars),
og:image, images with "logo" in src/alt/class, up to 10 product-looking images with alt text →
download those images under the same guards into the bucket → two dominant colours from the
logo with sharp, labelled "computed from your logo" → one structured AI call (zod-validated)
returns name, category guess, offerings, audience hints, voice notes, claimed facts → stored
with provenance `website` and every key in `unconfirmed`. Rate limit: 3 reads per user per hour
through the existing limiter. The same extraction call runs on the description alone from
slice 4, so screen 3b works before the website reader exists.

## Instagram import (slice 8)
After the user connects on screen 10b, the existing official-API call
(`lib/instagram/client.ts getMedia`, max 25 posts) returns caption, type, permalink, timestamp,
likes and comments. Store those; media URLs expire, so the gallery re-fetches thumbnails. The
three best-performing captions become voice examples. Until Meta review passes, connect works
only for accounts with a role on Voom's Meta app; the screen says so when the status endpoint
reports it.

## Brand Hub (slice 2)
Route `/app/brand`, nav item "Brand" in the Primary group after Today. One scrolling page, each
section a paragraph block with an Edit button that turns it into fields in place: Brand Brief ·
What we offer · Who we're for · How we sound (chips, liked and disliked samples, "write 3 new
samples") · What we avoid · Facts MARA may state ("needs confirmation" badge on extracted items)
· Assets (logo, products, past posts; upload and remove) · What MARA may do (pace, automation
level, channels; the same values Settings saves) · History (one line per version, click to see
what changed). Banner: "Edits apply from the next generation." Every Save appends a kit version
and updates the `businesses` columns. Same component as onboarding screen 10a, with a `mode`
prop that hides History and the gallery in onboarding.

## OnboardingWizard.tsx: keep, change, drop (slice 3)
- Keep: `StepName`, `StepDescribe`, `QBlock`, `IndustryPicks`, `RadioTile`, the header progress
  bar, the footer, the `need[]` validation pattern, `AnalyzingScreen`.
- Change: `LAST_STEP` and `OB_STEPS` to 12 entries; remove the header Skip and add a per-screen
  Skip to the footer; `StepBasics` loses the website field (moved to screen 2) and gains prefill
  badges; `StepAudienceGoal` gains "MARA's guess" highlighting; `StepVoiceChannels` splits into
  `StepVoice` and `StepChannels` (last); `StepBudgetPace` becomes pace only; `StepAutomation`
  shows the three real modes with plan badges and saves the real values; `StepConnect` drops the
  YouTube and Email rows. Required: name, description, industry, goal, automation.
- New: `StepAssets`, `StepLearned`, `StepAvoid`, `StepBrief` (renders the Brand Hub component).
- Drop: the `MaraUnderstands` box (replaced by 3b); `detectIndustry` becomes the fallback when AI
  extraction fails; the budget and permission questions.
- Store: `OnboardingAnswers` gains the new keys; `finishOnboarding` writes `businesses` + kit.
- `onboardingData.ts`: new `ONBOARDING_CHANNELS` (Instagram, TikTok, LinkedIn coming soon)
  separate from the canonical `SOCIAL_CHANNELS`; `Q_CHANNELS` stays for Settings.

## Build order (each slice: tests + browser check, useful on its own)
1. **Brand kit storage and reader. BUILT 2026-10-22.** Migration 0059, `lib/brand/context.ts`,
   `lib/brand/versions.ts`, wired into Post Studio (copy, Story, suggestions) and the weekly
   plan; dual write from onboarding and Settings. Tests: `tests/brand-kit-context.test.mjs`.
2. **Brand Hub page. BUILT 2026-10-23.** `/app/brand`, "Brand" in the Primary nav, eight
   sections editable in place (`lib/brand/sections.ts` owns the field lists), History with
   before/after, `saveBrandSection` action, onboarding mode ready for slice 3. Tests:
   `tests/brand-hub.test.mjs`. Not yet: the asset gallery (slice 5), "write 3 new samples"
   (slice 6), the "needs confirmation" badge (slice 4), replacing the Settings form (slice 3).
3. **Onboarding pass A. BUILT 2026-10-24.** Ten screens (the design's 1, 3a, 4, 5, 6 chips
   only, 7, 8, 9, 10a, 10b), per-screen Skip, five required answers, automation saves the real
   value within the plan (`wanted_automation` kept), Brand Hub component in local-persist mode
   on the brief screen, Settings brand form replaced by a link card. No placeholder screens:
   slices 4 to 6 insert screens 2, 3b and the sample captions when their engines exist. No data
   migration for old label-text `automation_level` rows (they run as Assisted; re-pick on the
   Automations page). Tests: `tests/onboarding-v2.test.mjs`.
4. **Extraction from the description. BUILT 2026-10-24.** `lib/brand/extract.ts` (strict
   schema whose choice fields are enums of our lists, the prompt, the one call) and
   `lib/brand/extract-actions.ts` (server action: login, `brand_extract` limiter bucket 10/hour,
   plain failure reasons). "Send to MARA" shows a reading panel for up to 12 s, then goes to
   the basics with every guess (name, category, offerings, audience, goal, tones, brief draft)
   prefilled into the screen that asks for it, marked "MARA's guess". **Screen 3b was built
   and then removed the same day**: confirming on 3b and again on the asking screens read as a
   double ask (DECISIONS 2026-10-24, slice 4), so each answer is now confirmed exactly once.
   Facts she found wait as "Needs confirmation" under Facts on the Brand Brief screen with a
   one-tap Confirm; only confirmed facts become `facts_confirmed`, the rest are stored as
   `facts_unconfirmed` (never read by generation) and shown on the Brand page's Facts section
   with Confirm / Remove behind Edit. `provenance` records which saved values are MARA's
   reading accepted unchanged (editing a field drops the claim). Failed, slow, empty or
   off-list reads keep the keyword category guess and say so on the basics screen; the same
   description text is never sent twice. Not built: the "from your website" badge (slice 7)
   and the generic `unconfirmed` key list (the facts list covers the only unconfirmed data
   that exists). Tests: `tests/brand-extract.test.mjs`.
5. **Assets.** Screen 2 uploads (logo, products, past posts with the disclaimer), bucket writes,
   product descriptions, past-post chips, colours from the logo, logo and colours synced to the
   email brand. Tests: upload limits, path ownership, colour computation on a fixture.
6. **Voice samples.** Three captions on screen 6 and "write 3 new samples" in the hub.
7. **Website reading** with every guard above. Tests: private-address refusal incl. on redirect,
   robots.txt, size and time caps, page selection, snapshot stored unconfirmed.
8. **Instagram import** after connect. Tests: official client only, 25-post cap, no fetch
   without a connection.
9. **Optional:** Reel/Story visuals, campaigns and the coordinator switch to `loadBrandContext()`.
