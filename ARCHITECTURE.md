# Voom architecture (plain language)

Last verified against the code: 2026-10-20. If the code and this file disagree, the code wins:
update this file in the same change.

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
| Tests | Node's built-in test runner: `npm test` runs `tests/*.test.mjs` (104 files, 1,669 tests; 4 are deliberately skipped in `voom-plans-credits-v1` with notes pointing to their replacements). Some use PGlite (an in-memory Postgres) to test SQL; 25 layout tests render pages in a real headless Chrome (found at `/Applications/Google Chrome.app`, or `VOOM_CHROMIUM_PATH`). Baseline counts live in `docs/baseline.md`. |
| Hosting | Vercel (`vercel.json` has 2 daily crons) |

## Folder map
| Folder | What lives there |
|---|---|
| `app/` | Pages and API. `app/page.tsx` = landing. `app/login`, `app/signup`, `app/forgot-password`, `app/reset-password`, `app/auth/callback`, `app/auth/google` = sign-in. `app/app/…` = the logged-in product. `app/api/…` = 75 backend endpoints. `app/privacy`, `terms`, `data-deletion`, `unsubscribe` = public pages. `app/components/` = logo, legal-text pieces and the Google button used by the public pages. |
| `app/app/(shell)/` | Logged-in screens inside the sidebar layout: today, plan, studio, calendar, performance, approvals, automations, campaigns, contacts, connections, instagram, tiktok, youtube, settings, pricing, mara. `reels` only redirects to `studio`; `ads` is a real "not built yet" screen explaining what paid advertising will do |
| `app/app/onboarding/` | Onboarding wizard page |
| `components/voom/` | UI pieces: `shell/` (sidebar, top bar, nav list in `nav.ts`), `onboarding/`, `operating/` (plan, approvals), `modals/` (post editor, connect modals, campaign modals), `today/`, `contacts/`, `automations/`, `campaigns/`, `performance/`, `workspace/` (loading skeleton and shared workspace bits), `ui/` (buttons, modal, toast) |
| `lib/` | All business logic (see below) |
| `utils/supabase/` | How code talks to Supabase: `server.ts` (as the logged-in user), `admin.ts` (server master key, bypasses database rules: server only), `client.ts` (browser), `proxy.ts` (refreshes login cookie) |
| `proxy.ts` (root) | Runs on every request to keep the login session fresh |
| `supabase/migrations/` | Database changes, numbered `0001`–`0058`, applied in order. **Note:** 0052–0054 are missing from this copy (see DECISIONS) |
| `supabase/ops/schedule-workers.sql` | Sets up the 9 background job timers |
| `supabase/proposed/` | Mostly rollback scripts (how to undo migrations 0055–0058) plus copies of 0055–0057 that are identical to the applied ones, and two older trend-intelligence drafts that never became numbered migrations. Nothing here is waiting to be applied. |
| `tests/` | Automated tests, one file per feature |
| `docs/` | Deploy runbook, audits, trend-intelligence plans, `baseline.md` (test/type/lint counts) |
| `handover/` | For whoever sets up production: `production-setup.md` (every outside-the-code setting, why and how), `changes-log.md` (code changes that need a Supabase/Vercel/provider step) |
| `reference/Voomprot2.html` | Original design prototype. Look-and-feel reference only, not architecture |

## `lib/` by feature
| Folder | Job |
|---|---|
| `lib/voom/` | Core app: types, client state store (`store.tsx`), onboarding questions (`onboardingData.ts`), saving onboarding/settings (`mutations.ts`), "who is logged in" (`server-data.ts` → `getCurrentUser`), timezone, cadence, schedule guards |
| `lib/voom/workflow/` | The rolling 7-day marketing plan: builds slots, assigns channels, asks MARA to fill them, moves items through plan → draft → approval → schedule |
| `lib/ai/` | Connection to the AI text model (any OpenAI-compatible API; default Groq) |
| `lib/mara/` | MARA's brain: chat prompt, tools, Reel production, video generation and polling, paid-media spending rules, Autopilot safety |
| `lib/media/` | Image/video generation providers, checking uploaded files, overlays |
| `lib/post/` | Post Studio: drafts, copy prompts (`prompt.ts`), brand context loader for posts (`server-data.ts`), assets |
| `lib/social/` | Shared channel layer: channel list (`channels.ts`), connection status, readiness, publishing state |
| `lib/instagram/`, `lib/tiktok/`, `lib/youtube/` | One folder per platform: OAuth connect, encrypted tokens, publish queue, publish worker, reconcile, insights |
| `lib/performance/` | Reads results (Instagram insights), ranks what worked, feeds hints into the next plan (`plan-context.ts`) |
| `lib/billing/` | Plans (free/pro/max), credits ledger, the guard that reserves credits before paid AI calls |
| `lib/campaign/` | Multi-channel campaigns |
| `lib/email/`, `lib/email-flows/`, `lib/contacts/` | Email sending (Resend), lifecycle email flows, contacts and audiences |
| `lib/coordinator/` | Background "what should MARA propose next" engine |
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

**Onboarding.** `components/voom/onboarding/OnboardingWizard.tsx` (8 steps, questions in
`lib/voom/onboardingData.ts`; `AnalyzingScreen.tsx` is the "we're setting things up" screen shown
at the end) → `saveOnboarding` in `lib/voom/mutations.ts` → writes `profiles`
and `businesses` (website goes only to the email brand table).

**Plan → content → approval → publish.**
1. Daily cron `/api/cron/weekly-plans` or the "Build plan" button (`/api/plan`) runs `lib/voom/workflow/service.ts`.
2. It creates slots for the next 7 days from posting frequency and chosen channels, and MARA writes drafts.
3. User edits/approves in Studio or Approvals (`/api/posts/*`). Approval state is locked server-side.
4. Approved + scheduled + has a visual → goes into the platform's publish queue table.
5. Worker crons (`/api/cron/instagram-publish` etc., every 5 min) publish and record only provider-confirmed results.

**AI generation.** Copy: `lib/ai` with strict JSON output validated by zod. Images:
`lib/media/provider.ts` (text prompt only today). Videos: `lib/mara/video-*` with a polling worker
every 2 min. Credits are reserved first by `lib/billing/entitlement-guard.ts`.

**Analytics.** `/api/cron/instagram-performance` (every 6 h) stores snapshots →
`lib/performance/*` → shown on Performance and passed as hints to the next plan (Instagram only).

## Database (main tables)
- Account: `profiles`, `businesses` (brand answers + plan + settings, one row per user)
- Plan and content: `marketing_plans`, `content_calendar_items`, `mara_drafts`, `post_draft_assets`, `reel_draft_assets`, `mara_media_generations`
- MARA chat: `mara_conversations`, `mara_messages`, `mara_pending_actions`, `mara_tool_runs`
- Per platform: `*_connections`, `*_connection_secrets` (encrypted tokens), `*_oauth_states`, `*_publish_queue`, `*_performance_snapshots` (instagram, tiktok, youtube)
- Billing: `voom_credit_ledger`, `voom_rate_limits`
- Email/contacts/campaigns: `contacts`, `audiences`, `voom_campaigns*`, `voom_email_*`, `campaign_*`
- Trends: `trend_*` (unreleased)

Every table has row-level security: a user can only read their own rows. Server code that uses
the admin key (`utils/supabase/admin.ts`) bypasses that, so it **must** filter by the owner itself.

## Background jobs (Supabase Cron unless noted)
instagram-publish (5 min) · youtube-publish (5 min) · tiktok-publish (5 min) · youtube-reconcile
(10 min) · tiktok-reconcile (10 min) · media-generation (2 min) · email-flows (15 min) ·
instagram-performance (6 h) · youtube-performance (hourly) · weekly-plans (daily, Vercel) ·
trend-collection (daily, Vercel, off by flag). All require `Authorization: Bearer <CRON_SECRET>`.

## Configuration
All keys go in `.env.local` (copy from `.env.example`). Never commit real values. Anything starting
`NEXT_PUBLIC_` is visible in the browser; everything else is server-only.

## Not built yet
2FA · LinkedIn · Stripe billing · brand asset uploads / website
reading in onboarding · reference images in image generation.
