# Voom

Voom is a marketing platform for small businesses. MARA, its AI marketing
manager, plans, drafts, and reports on campaigns on the business's behalf.

Voom runs on Next.js (App Router) with the approved Voom visual identity
(ink/dark background, signal-orange accent, deep-teal support colour). The
authenticated product is backed by Supabase: a rolling marketing plan, an
approvals board, a content calendar, Instagram publishing, contacts,
campaigns and truthful delivery tracking.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Other scripts:

```bash
npm run lint    # ESLint
npm run build   # production build
npm run start   # serve the production build
```

## Environment variables

Copy `.env.example` to `.env.local` and fill in values as integrations are
added. `.env.example` only contains placeholder variable names — never commit
real secrets. `.env`, `.env.local`, and other secret env files are gitignored.

```bash
cp .env.example .env.local
```

## Project structure

```
app/
  layout.tsx        Root layout — fonts (Bricolage Grotesque, Public Sans), metadata
  globals.css        Design tokens (colours, brand gradient) and Tailwind entry
  page.tsx            /       — landing placeholder
  login/page.tsx      /login  — login placeholder (no auth wired up)
  app/page.tsx        /app    — dashboard placeholder
  components/
    Logo.tsx          Shared Voom wordmark used across pages
reference/
  Voomprot2.html      Approved product-flow and visual reference (do not edit,
                        do not use as the architecture for this app)
```

## Status

- Framework: Next.js (App Router), TypeScript, Tailwind CSS, ESLint
- Supabase auth + data (RLS owner-scoped), Instagram publishing, OpenRouter
  media generation with Magic Hour fallback, Resend/ClickSend campaign
  delivery with verified callbacks
- Asynchronous video jobs are polled server-side by
  `/api/cron/media-generation` every two minutes through the existing Supabase
  Cron/Vault pattern. The browser only refreshes display state; it is never the
  provider lifecycle owner. The route polls persisted provider job ids only,
  stores validated MP4s, and enforces the 30-minute `provider_timeout`.
- Not yet implemented: Stripe billing, paid advertising connections. The UI
  says so truthfully instead of simulating them
- No demo/sample data ships in the product: every screen renders real account
  data or an honest empty state

### Performance Intelligence (v1)

Voom reads Instagram performance metrics only for content it has already
published and Meta has confirmed with a real media id
(`instagram_publish_queue.status = 'published'`). Readings are normalized into
`public.instagram_performance_snapshots` (migration
`0032_instagram_performance_intelligence.sql` — additive, owner-scoped RLS) and
drive the Performance page, the single Today insight, and the advisory
performance evidence MARA receives when it plans the next rolling 7 days.

To collect them in Production, add one Supabase Cron job that calls
`/api/cron/instagram-performance` with `Authorization: Bearer <CRON_SECRET>`
(a few times a day is enough; the collector is idempotent per hour-long window).
This route is deliberately not in `vercel.json` and is not scheduled by the
repository — the existing Instagram publishing worker keeps its five-minute
cadence, unchanged. The collector only reads: it never publishes, never edits
media or captions, and never starts a generation.

Per-media insights (reach, views, plays, saves, shares, interactions) require
Meta's `instagram_business_manage_insights` permission, which Voom now asks for
at connect time alongside the existing permissions — enable it for the app's
Instagram use case in the Meta dashboard, and note that connections made before
this change must reconnect once to grant it. When the stored connection does not
include it, the collector still stores the real media-node metrics (likes,
comments) and reports every unread metric as unavailable — it never invents a
value, and never stores a zero.

### Supabase Cron workers

Configure the existing Supabase Cron job runner to call
`/api/cron/media-generation` every two minutes with
`Authorization: Bearer <CRON_SECRET>` (the secret should come from Supabase
Vault, not a migration or source file). Do not add this route to Vercel Cron:
Vercel Hobby's cadence is not suitable for asynchronous media polling. The
Instagram worker keeps its existing five-minute schedule. The worker reuses
`mara_media_generations.updated_at` (already maintained by the existing trigger)
for its two-minute due check and poll lease, so no schema migration or live
schedule migration is required.
