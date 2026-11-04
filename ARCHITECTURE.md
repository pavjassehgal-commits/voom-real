# Voom architecture (plain language)

Last verified against the code: 2026-11-02 (Phase C of `handover/merge-plan.md`: the full pass
after the 2026-11-01 merge with `main`, 73 commits). The section "What `main` built" below is the
map of that work; each theme points at the document the other developer wrote for it. If the
code and this file disagree, the code wins: update this file in the same change.

## The big picture

Voom is one Next.js app. The same project serves the website pages **and** the backend API.
Data, logins and file storage live in **Supabase** (a hosted Postgres database). It is hosted on
**Vercel**. Background jobs (publishing at the scheduled time, checking results) are triggered by
timers in Supabase Cron and Vercel Cron, which call secret-protected API routes.

```
Browser ──► Next.js pages (app/…)  ──► Supabase (database, logins, files)
        ──► Next.js API routes (app/api/…) ──► Supabase
                                         ──► AI text provider (Groq/OpenAI-compatible)
                                         ──► AI image/video (OpenRouter: Seedream, Seedance)
                                         ──► Instagram / TikTok / YouTube APIs, Resend (email)
Timers (Supabase Cron, Vercel Cron) ──► app/api/cron/* ──► same as above
```

## Tech stack
| Thing | What we use |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript. **This Next.js version differs from older docs**: check `node_modules/next/dist/docs/` before writing code (see `AGENTS.md`). |
| Styling | Tailwind CSS 4, tokens in `app/globals.css` |
| Database + auth + storage | Supabase. Packages `@supabase/ssr`, `@supabase/supabase-js` |
| Validation | zod |
| Images | sharp (inspect/resize), image overlays |
| Tests | Node's built-in test runner: `npm test` runs `tests/*.test.mjs` (157 files, about 2,300 tests, around 130 s; 4 are deliberately skipped in `voom-plans-credits-v1` with notes pointing to their replacements). Some use PGlite (an in-memory Postgres) to test SQL; the layout, motion and notification tests render pages in a real headless Chrome (found at `/Applications/Google Chrome.app`, or `VOOM_CHROMIUM_PATH`) through `tests/helpers/rendered-surface.mjs`. Expected counts and the named failures live in `docs/baseline.md`. |
| Hosting | Vercel (`vercel.json` has 3 crons: weekly plans daily, trend collection daily, LinkedIn publish every 5 min; it also switches off preview deployments for the other developer's feature branches) |

## Folder map
| Folder | What lives there |
|---|---|
| `app/` | Pages and API. `app/page.tsx` = landing (redesigned by `main`). `app/login`, `app/signup`, `app/forgot-password`, `app/reset-password`, `app/auth/callback`, `app/auth/google` = sign-in. `app/app/…` = the logged-in product. `app/api/…` = 90 backend endpoints. `app/privacy`, `terms`, `data-deletion`, `unsubscribe` = public pages. `app/components/` = logo, legal-text pieces and the Google button used by the public pages. |
| `app/app/(shell)/` | Logged-in screens inside the redesigned sidebar layout (`main`, 2026-10): today, brand (the Brand Hub: everything MARA knows, editable, with version history; since Phase C laid out with the redesign's `PageHeader` and `voom-card` sections), studio (Create: format picker, preview, schedule), content (the content library), calendar, performance, approvals, automations (automation mode, emergency Pause all / Resume, email flows), plan (the rolling 7-day Marketing Plan), mara (read-only overview of MARA's work), campaigns, contacts, connections ("Channels"), instagram, tiktok, youtube, linkedin (manual LinkedIn workspace), settings (sectioned; the brand section links to the Brand page), pricing. `reels` only redirects to `studio`; `ads` is a real "not built yet" screen explaining what paid advertising will do |
| `app/app/onboarding/` | Onboarding wizard page. It passes `completedOnServer` to the wizard instead of redirecting a finished account itself (see Onboarding below) |
| `components/voom/` | UI pieces: `shell/` (`AppShell`, sidebar, top bar, bottom bar on phones, nav list in `nav.ts`; Brand sits right after Today), `redesign/` (`main`'s shared redesign pieces: `ui.tsx` with `PageHeader`, `BTN`, `StatCard`, `StatusChip`, `ChannelGlyph`, `EmptyPanel`; our additions `FORM` + `Pill` + `Badge`, the form kit our Brand and onboarding screens use, and `MaraMark.tsx`, MARA's ribbon mark from `public/redesign/mara-mark.webp`), `auth/` (`main`'s login/signup frame), `icons.tsx` (`main`'s icon set), `motion/` (page transitions, the haptics and `data-haptic` runtime), `brand/` (the Brand Hub component, also an onboarding screen; the images editor; the voice sample cards), `onboarding/` (our 11-screen wizard in the redesign's setup layout, `onboardingIcons.tsx` mapping every answer to the designers' 3D icons in `public/redesign/onboarding-icons/`, `SetupComplete.tsx` "Your workspace is ready"), `operating/` (plan, approvals, automation mode), `modals/` (post editor, connect modals, YouTube upload), `create/`, `content/`, `linkedin/`, `mara/`, `today/`, `contacts/`, `automations/`, `campaigns/`, `performance/`, `workspace/`, `ui/` (primitives still used by the shell and every modal, not by our Brand/onboarding screens since 2026-11-04; modal; toast host with stacking and `data-toast-clearance`) |
| `lib/` | All business logic (see below) |
| `utils/supabase/` | How code talks to Supabase: `server.ts` (as the logged-in user), `admin.ts` (server master key, bypasses database rules: server only), `client.ts` (browser), `proxy.ts` (refreshes login cookie) |
| `proxy.ts` (root) | Runs on every request to keep the login session fresh |
| `supabase/migrations/` | Database changes, numbered `0001`–`0075`, applied in order, with gaps: 0052–0054 (see DECISIONS), 0060, 0065, 0069 and 0071–0074 (the Brand Kit migration was written as 0059 and renumbered 0075 at the 2026-11-01 merge with `main`, which had its own 0059; see DECISIONS 2026-10-31) |
| `supabase/ops/schedule-workers.sql` | Sets up the 9 background job timers |
| `supabase/proposed/` | Mostly rollback scripts (how to undo migrations 0055–0058) plus copies of 0055–0057 that are identical to the applied ones, and two older trend-intelligence drafts that never became numbered migrations. Nothing here is waiting to be applied. |
| `tests/` | Automated tests, one file per feature |
| `docs/` | Deploy runbook, audits, trend-intelligence plans, `baseline.md` (test/type/lint counts), `brand-kit-v2-design.md` (the onboarding + Brand Hub redesign and its build order), and the other developer's notes per theme: `mara-automation-launch.md`, `scheduled-workers.md`, `linkedin-personal-publishing.md`, `native-plan-video-generation.md`, `youtube-canonical-oauth.md`, `youtube-native-mp4-upload.md`, `youtube-resumable-uploads.md`, `youtube-refresh-diagnostic.md`, `instagram-token-renewal.md` |
| `handover/` | For whoever sets up production: `production-setup.md` (every outside-the-code setting, why and how), `changes-log.md` (code changes that need a Supabase/Vercel/provider step). Also `next-session.md`: the status board for the next working session (where we are, what is next, open items, the pull-from-main checklist), read at the start of every task and updated at the end |
| `reference/Voomprot2.html` | Original design prototype. Look-and-feel reference only, not architecture |

## `lib/` by feature
| Folder | Job |
|---|---|
| `lib/voom/` | Core app: types, client state store (`store.tsx`), onboarding questions (`onboardingData.ts`), saving onboarding/settings (`mutations.ts`), "who is logged in" (`server-data.ts` → `getCurrentUser`), timezone, cadence, schedule guards |
| `lib/voom/workflow/` | The rolling 7-day marketing plan: builds slots, assigns channels, asks MARA to fill them, moves items through plan → draft → approval → schedule. `main` (PRs #101–#102, `docs/mara-automation-launch.md`): `rolling-plan.ts` and `channel-planner.ts` decide every slot's date, channel and native format on the server before any paid generation, with the cadence a hard limit on every 7-day window; `slot-lease.ts` takes a short database lease per slot (migration 0070) so two clicks or a cron and a click never generate the same slot twice; the AI call is given a fail-closed timeout (`lib/ai/config.ts`, `aiRequestTimeoutMs`) that the lease length is derived from; failed provider publishes are held for the owner, never retried on their own. `lib/voom/cadence.ts` holds the cadence rules; `lib/voom/automation-pause-state.ts` reads the emergency pause (migration 0059) |
| `lib/brand/` | Brand Kit v2 (migration 0075, formerly 0059): `context.ts` is the ONE reader generation uses (`loadBrandContext()` = core fields from `businesses` + the newest `brand_kits` row's brief, offerings, avoid rules, banned words, facts, notes, voice samples; fails open to "no kit"); `versions.ts` appends a kit version on every onboarding/Settings/Brand Hub save, carrying the previous version forward and replacing only the fields that save owns; `sections.ts` defines the Brand Hub sections and which fields and `businesses` columns each owns; `actions.ts` is the hub's save action; `read.ts` loads the version history; `extract.ts` + `extract-actions.ts` are the one AI read of the onboarding description (strict schema over our own option lists, never stored); slice 5 images: `assets.ts` (reference rules, caps, path ownership, list edits, the text-only visual style), `asset-storage.ts` (private `brand-kit` bucket, service role, one-hour signed previews, and the sweep that deletes the owner's files the newest kit version no longer references, run after onboarding Finish and after a Brand page images save), `image.ts` (logo colours from pixels, small JPEG for vision, with sharp), `vision.ts` (one image-reading call), `email-sync.ts` (logo and colours fill the email brand only where empty); slice 6 voice samples: `voice.ts` (one text-model call that writes three sample captions from a snapshot of the answers, and drops any using a banned word or copying a sorted sample) + `voice-actions.ts` (the server action, 20 per user per hour, stores nothing); slice 7 website: `website.ts` (address rules that refuse every non-public host, robots.txt, HTML to text, follow-up links, the capped text block, the homepage-look schema and prompt), `website-fetch.ts` (the guarded text fetch: every host checked, redirects re-checked, 10 s and 2 MB caps), `website-screenshot.ts` (headless Chromium through puppeteer-core, every request the page makes checked the same way), `website-actions.ts` (the two server actions, text and look, 10 per user per hour each, store nothing). Routes: `app/api/brand/assets` (upload, remove unsaved) and `app/api/brand/assets/describe` |
| `lib/ai/` | Connection to the AI text model (any OpenAI-compatible API; default Groq), plus the optional image-reading model (`AI_VISION_*`, off until `AI_VISION_MODEL` is set; Groq, OpenRouter or any OpenAI-compatible vision model). `main` added `usage.ts` + `pricing.ts`: every call records its provider attempts, tokens and estimated cost under an operation key (migration 0061, `ai_usage_*` tables) so credits can be reconciled against real spend; our vision calls go through the same recorder |
| `lib/mara/` | MARA's brain: chat prompt, tools, Reel production, video generation and polling, paid-media spending rules, Autopilot safety. `main` added native TikTok Video and YouTube Shorts plan cards on the same video engine, bucket, polling worker and 40-credit ledger (migration 0063, `docs/native-plan-video-generation.md`) |
| `lib/coordinator/` | The background "what should MARA propose next" engine: reads the plan, approvals and pause state, proposes and replenishes slots inside the cadence (`main`, PR #81 and #102: emergency pause/resume, approval integrity, rejected ideas replaced once) |
| `lib/media/` | Image/video generation providers, checking uploaded files, overlays |
| `lib/post/` | Post Studio: drafts, copy prompts (`prompt.ts`), brand context loader for posts (`server-data.ts`), assets, and `vision.ts` (slice 5b: one look at an uploaded photo with a brand hint before MARA suggests its caption) |
| `lib/social/` | Shared channel layer: channel list (`channels.ts`), connection status, readiness, publishing state |
| `lib/instagram/`, `lib/tiktok/`, `lib/youtube/`, `lib/linkedin/` | One folder per platform: OAuth connect, encrypted tokens, publish queue, publish worker, reconcile, insights. `main` added: **LinkedIn** personal-profile text posts only, owner-approved and manually published from `/app/linkedin`, own durable queue, five `LINKEDIN_*` env vars (migration 0062, `docs/linkedin-personal-publishing.md`); **YouTube** one canonical OAuth host, native MP4 upload of the owner's own file into a private `youtube-uploads` bucket with resumable 6 MiB chunks up to 50 MiB, verified before attaching, plus a cleanup worker (migrations 0064, 0066, 0067, `docs/youtube-*.md`); **Instagram** automatic renewal of the 60-day tokens by a 6-hourly cron, expired ones marked for reconnect (migration 0068, `docs/instagram-token-renewal.md`) |
| `lib/performance/` | Reads results (Instagram insights), ranks what worked, feeds hints into the next plan (`plan-context.ts`) |
| `lib/billing/` | Plans (free/pro/max), credits ledger, the guard that reserves credits before paid AI calls |
| `lib/campaign/` | Multi-channel campaigns |
| `lib/email/`, `lib/email-flows/`, `lib/contacts/` | Email sending (Resend), lifecycle email flows, contacts and audiences |
| `lib/trends/` | Trend intelligence (built, switched off by flags, not released) |
| `lib/rate-limit.ts` | Per-user limits on AI requests |
| `lib/legal/` | Contact details shown on the privacy/terms pages |

## Key flows
**Sign up / log in.** `app/signup/actions.ts` → Supabase sends a confirmation email → link lands on
`app/auth/callback/route.ts` (allowlist: `/app` and `/reset-password` only) → `/app`. Login:
`app/login/actions.ts` → `/app`. Every page/API checks the user with `getCurrentUser()` in
`lib/voom/server-data.ts`. `app/app/layout.tsx` sends logged-out users to `/login`;
`app/app/(shell)/layout.tsx` sends users without a finished onboarding to `/app/onboarding`.

**Continue with Google.** `app/components/GoogleButton.tsx` (on `/login` and `/signup`) submits
`continueWithGoogle` in `app/auth/google/actions.ts`, which asks Supabase for the Google sign-in
URL (`signInWithOAuth`, return address `/auth/callback?next=/app`) and sends the browser there.
Google → Supabase → the same callback route, which exchanges the code for a session → `/app`;
a new user has no business row, so the onboarding gate above takes over. Same email as an
existing email/password account → Supabase links the two to one account. The Google client ID
and secret live only in the Supabase dashboard (`handover/production-setup.md` A9); the
`GOOGLE_*` env vars are YouTube's, not login's.

**Forgot password.** `/login` → `app/forgot-password/` (action `requestPasswordReset`: always
replies "if that email has an account, we've sent a link", never reveals whether one exists) →
Supabase emails a link → `app/auth/callback/route.ts?next=/reset-password` exchanges the code for
a recovery session → `app/reset-password/` (page shows the form only with a live session; action
`resetPassword` validates like signup, calls `updateUser`, signs out every session for the
account with `signOut({ scope: "global" })`, then sends the user to `/login?notice=password_reset`
to log in with the new password; the login page shows a fixed notice for that key only). A dead
link goes to `/reset-password?error=link_invalid`, which offers a new one. The email sender and
link expiry are Supabase dashboard settings, not code: see `handover/production-setup.md`.
Missing today: 2FA.

**Onboarding.** `components/voom/onboarding/OnboardingWizard.tsx` (11 screens, one topic each,
five required answers, per-screen Skip and no global Skip; option lists in `lib/voom/onboardingData.ts`;
the Brand Brief screen is the Brand Hub component in local mode). Since Phase C (2026-11-02) it
wears the redesign's setup layout from `main`: a sticky header with the step list, a sticky intro
column with the designers' artwork on large screens, white answer cards with the 3D icons
(`onboardingIcons.tsx`; Manual / Assisted / Autopilot reuse main's three automation icons), the
"Need inspiration?" chips under the description box, and a light footer that notifications stack
above. Finish shows `SetupComplete.tsx` ("Your workspace is ready": the saved answers, the real
plan items from `/api/voom/workflow`, Edit links to the Brand page, "Go to dashboard"). A finished
account that opens `/app/onboarding` is sent to `/app` by the wizard itself, decided once at mount
from the page's `completedOnServer` flag; the page does not redirect, because the save's own
revalidation re-renders it and a server redirect there would hide the summary. Screen 2, "Give MARA your brand", takes
the website, a logo, up to 10 product photos and up to 5 past posts
(`components/voom/brand/BrandAssetsEditor.tsx`, shared with the Brand page): each file uploads
at once to the private `brand-kit` bucket, a logo gets two colours computed from its pixels,
and when image reading is configured MARA fills one line per image (marked as her guess; asked
for one short sentence under 160 characters, stored up to 240; a longer line is cut at a sentence
end by `trimToSentence` in `lib/brand/assets.ts`, never mid-word).
A "Read my website" button next to the field (or Continue / Skip with an address not yet read)
starts two server actions side by side in the background (slice 7, `lib/brand/website-actions.ts`):
the site's text (homepage plus up to four same-site pages about, services, products, menu, shop or
pricing), from which MARA's text model drafts the description into the empty box ("From your
website"), and, with image reading on, one homepage screenshot the vision model turns into the
site's look (two colours, a look line, style tags). Status shows under the field and above the
description box; a failure offers "Try again" / "Try reading again" / "Back to the website". The site's colours
become the "From your website" palette, kept beside the logo's and used only when nothing else is;
the owner chooses which palette and which colour leads (`components/voom/brand/BrandAssetsEditor.tsx`).
"Send to MARA" on the description screen
calls `extractBrandDescription` (`lib/brand/extract-actions.ts`, one structured AI read via
`lib/brand/extract.ts`, 12 s wait, 10 reads per user per hour; since slice 7 the site's text goes in
the same call, the description winning on conflicts): what she found is prefilled
into the screen that asks for it, marked as her guess, and facts wait under Facts on the
Brand Brief screen until confirmed; a failed read falls back to the keyword guess
(`detectIndustry`) for the category as before. The voice screen (slice 6) asks MARA for three
sample captions when it opens (`lib/brand/voice-actions.ts`, 8 s wait, the same answers never
asked twice); the owner taps "Sounds like us" / "Not us" (`components/voom/brand/VoiceSamples.tsx`,
shared with the Brand page's "Write 3 new samples") and only tapped captions are saved as the
kit's `voice_samples`. Finish →
`saveOnboarding` in `lib/voom/mutations.ts` → writes `profiles` and `businesses` (website goes
only to the email brand table; the automation level is saved as the real mode the plan allows)
and appends `brand_kits` version 1 with the brief, offerings, rules, banned words, notes,
confirmed facts, plus `facts_unconfirmed` (facts MARA found that were not ticked; never read
by generation), `provenance` (which saved values are MARA's reading, accepted unchanged),
the image references (`assets` column) and `colours` (best-effort). The logo and colours then
fill the email brand only where Settings → Email identity is still empty. Design and remaining
slices: `docs/brand-kit-v2-design.md`.

**Plan → content → approval → publish.**
1. Daily cron `/api/cron/weekly-plans` or the "Build plan" button (`/api/plan`) runs `lib/voom/workflow/service.ts`.
2. It creates slots for the next 7 days from posting frequency and chosen channels, and MARA writes drafts.
3. User edits/approves in Studio or Approvals (`/api/posts/*`). Approval state is locked server-side. The editor can also cancel an approval (stops auto-publishing, removes the calendar entry) or delete a post for good (`DELETE /api/posts/[id]` → `deletePostDraft`: calendar entry, queue row, stored file, then the draft; refused while Instagram is publishing it and always once published).
4. Approved + scheduled + has a visual → goes into the platform's publish queue table.
5. Worker crons (`/api/cron/instagram-publish` etc., every 5 min) publish and record only provider-confirmed results.

**AI generation.** Copy: `lib/ai` with strict JSON output validated by zod. Post Studio (copy,
Story, import suggestions) and the weekly plan read the brand through `lib/brand/context.ts`;
when the account has a Brand Kit with content, the prompt payload gains a `brandKit` block and
the system prompt a BRAND KIT rules section, otherwise both are exactly as before. With brand
images or colours the block also carries `visualStyle` (palette, logo, product and past-post
descriptions as text, never files) and one extra rule tells MARA to fit every visual prompt to
it. Caption suggestions for an uploaded photo ("Existing content", `POST /api/posts/[id]/suggest`):
when the vision model is configured, MARA first looks at a small JPEG copy of the photo with a
brand hint (name, kind, offerings, product photo descriptions; `lib/post/vision.ts`, 40 looks
per user per hour) and the text model writes for that reading next to the brand context; the
response returns what she saw. Videos, vision off, or a failed look: metadata only, as before,
and the response says MARA has not seen the file. Images: `lib/media/provider.ts` (text prompt
only today; the image model never sees the owner's files). Reel video plans (`lib/mara/video-ports.ts`) do not read the brand kit yet. Videos: `lib/mara/video-*` with a polling worker
every 2 min. Credits are reserved first by `lib/billing/entitlement-guard.ts`.

**Analytics.** `/api/cron/instagram-performance` (every 6 h) stores snapshots →
`lib/performance/*` → shown on Performance and passed as hints to the next plan (Instagram only).

## Database (main tables)
- Account: `profiles`, `businesses` (brand answers + plan + settings, one row per user), `brand_kits` (Brand Kit versions: append-only, one row per save; users can read and add their own, never edit or delete)
- Plan and content: `marketing_plans`, `content_calendar_items`, `mara_drafts`, `post_draft_assets`, `reel_draft_assets`, `mara_media_generations`
- MARA chat: `mara_conversations`, `mara_messages`, `mara_pending_actions`, `mara_tool_runs`
- Per platform: `*_connections`, `*_connection_secrets` (encrypted tokens), `*_oauth_states`, `*_publish_queue`, `*_performance_snapshots` (instagram, tiktok, youtube)
- Billing: `voom_credit_ledger`, `voom_rate_limits`
- Email/contacts/campaigns: `contacts`, `audiences`, `voom_campaigns*`, `voom_email_*`, `campaign_*`
- Trends: `trend_*` (unreleased)

Every table has row-level security: a user can only read their own rows. Server code that uses
the admin key (`utils/supabase/admin.ts`) bypasses that, so it **must** filter by the owner itself.

## What `main` built (16 to 31 October 2026, merged 2026-11-01)
The other developer's 73 commits, by theme, with the file to read for each. Everything here is
in this branch and described in the tables above where it changed a folder.

| Theme | What it does | Read |
|---|---|---|
| Figma redesign (PRs #84–#91) | Every screen rebuilt on one light design system: shell with sidebar, top bar and phone bottom bar; Today, Create, Content, Marketing Plan, Approvals, Automations, MARA, Calendar, Contacts, Channels, Performance, Settings; homepage, login, signup; the setup wizard's layout, artwork and 3D icons (now worn by our 11-screen wizard); a motion system with page transitions, `data-haptic` taps and a reduced-motion switch; stacking notifications that coalesce repeats. No dark design exists for the public screens. | `components/voom/redesign/ui.tsx`, `components/voom/shell/*`, `components/voom/motion/*`, `components/voom/ui/ToastHost.tsx`, `tests/redesign-batch-*.test.mjs` |
| LinkedIn (PRs #92–#94) | Personal-profile text posts, approved by the owner and published manually from the LinkedIn workspace; LinkedIn is a planning channel in the Marketing Plan but not in MARA's automatic generation allowlist. Needs the five `LINKEDIN_*` env vars (unset on dev). | `docs/linkedin-personal-publishing.md`, `lib/linkedin/*`, migration 0062 |
| Native TikTok / Shorts videos (PR #95) | TikTok Video and YouTube Shorts plan cards generate through the existing video engine and 40-credit ledger; one generation per draft at a time. | `docs/native-plan-video-generation.md`, migration 0063 |
| YouTube uploads (PRs #96–#99) | One canonical OAuth host; the owner's own MP4 uploaded in resumable chunks to a private bucket, verified, then attached to the draft; fair cleanup of abandoned uploads. | `docs/youtube-canonical-oauth.md`, `docs/youtube-native-mp4-upload.md`, `docs/youtube-resumable-uploads.md`, migrations 0064, 0066, 0067 |
| Instagram token renewal (PR #100) | A 6-hourly cron renews long-lived tokens before their 60 days end; lapsed ones are marked expired so the owner reconnects. Vercel production only. | `docs/instagram-token-renewal.md`, migration 0068 |
| AI usage and cost (PR #82) | Every AI call records attempts, tokens and estimated cost under an operation key; credits can be reconciled against spend. | `lib/ai/usage.ts`, `lib/ai/pricing.ts`, migration 0061 |
| Automation safety (PRs #81, #101, #102) | Emergency Pause all / Resume for MARA's automation, approval integrity (approved content is versioned and locked), cadence as a hard limit on every rolling 7-day window, single-flight slot generation with a database lease, a fail-closed AI timeout, failed publishes held for the owner. | `docs/mara-automation-launch.md`, `lib/coordinator/*`, `lib/voom/workflow/{rolling-plan,slot-lease,channel-planner}.ts`, migrations 0059 and 0070 |
| Worker schedules (PR #102) | The Supabase Cron definitions rewritten as one guarded file; secrets read from Vault. Not yet re-run on the dev project. | `docs/scheduled-workers.md`, `supabase/ops/schedule-workers.sql` |
| Test harness | Next.js entry-point export rules; the headless-Chrome helper used by every layout test. Its known weaknesses (a leaked profile folder per scenario, no page-script timeout) are open items in `handover/next-session.md`. | `tests/helpers/rendered-surface.mjs`, `docs/baseline.md` Notes |

## Background jobs (Supabase Cron unless noted)
instagram-publish (5 min) · youtube-publish (5 min) · tiktok-publish (5 min) · youtube-reconcile
(10 min) · tiktok-reconcile (10 min) · media-generation (2 min) · email-flows (15 min) ·
instagram-performance (6 h) · youtube-performance (hourly) · instagram-token-refresh (6 h, `main`) ·
weekly-plans (daily, Vercel) · linkedin-publish (every 5 min, Vercel; `main`) ·
trend-collection (daily, Vercel, off by flag). All require `Authorization: Bearer <CRON_SECRET>`.
The routes live in `app/api/cron/*` (13 today). `main` rewrote the Supabase schedules
(`supabase/ops/schedule-workers.sql`, `docs/scheduled-workers.md`); they are not yet re-run on the
dev project (`handover/changes-log.md`).

## Configuration
All keys go in `.env.local` (copy from `.env.example`). Never commit real values. Anything starting
`NEXT_PUBLIC_` is visible in the browser; everything else is server-only.

## Not built yet
2FA · LinkedIn company pages (personal text posts exist since the merge) · Stripe billing ·
Instagram import (`docs/brand-kit-v2-design.md`, slice 8) · the brand kit in Reel video
plans (slice 9) · reference images in image generation · 3D icons for the six avoid-rules and the
LinkedIn "coming soon" card (plain cards today).
