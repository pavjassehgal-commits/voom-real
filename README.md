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
