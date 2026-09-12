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
- Not yet implemented: Stripe billing, paid advertising connections. The UI
  says so truthfully instead of simulating them
- No demo/sample data ships in the product: every screen renders real account
  data or an honest empty state
