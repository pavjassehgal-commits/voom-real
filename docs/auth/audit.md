# Authentication audit — 2026-09-22 (before implementation)

Baseline: `02787af8916ded7c4069c2a146d3b3ecbb80cce2`, fetched origin/main matches the session baseline. No Production configuration/users queried or changed. No real emails sent. No local Supabase config or checked-in auth user exports exist; Dashboard settings and historical ownership cannot be established from this repository.

## Observed behavior
- `app/signup/actions.ts`: trims email, simple email regex, 8-character password minimum; `signUp` uses PKCE SSR client. Any returned session immediately redirects to onboarding; otherwise inline success claims an email was sent. No resend screen.
- `app/login/actions.ts`: password sign-in, generic credential failure, then `/app`. Login/signup pages redirect on any claims. No unverified state or reset flow.
- `app/auth/callback/route.ts`: exchanges PKCE code (including SDK flow ID), permits only `/app` as destination (already resistant to open redirects), then generic login error. No authoritative confirmation check.
- `utils/site-url.ts`: explicit env, deployment URL, then request Origin fallback. Signup trusted this Origin fallback for email redirects.
- `utils/supabase/proxy.ts`: refreshes claims/cookies only; explicitly no route guard.
- `/app` layout and `lib/voom/server-data.ts#getCurrentUser`: JWT claims only. The shared helper is the guard for product API routes and server actions (including onboarding, contacts, MARA/workflow, campaigns, providers, publish/generation controls). Reel asset endpoints delegate to `ownedReelAction`, which uses this helper. `/api/mara` is a 410 tombstone.
- Profile/business rows are created by `saveOnboarding`, not an auth-user trigger. It uses the same claims-only helper. Shell routes require completed onboarding, not confirmation.
- Migrations 0001–0049: ownership RLS, not email-confirmation RLS. Publishable key permits direct Supabase access; UI/server guards alone would leave a database bypass. User-callable approval RPC is security invoker; job/provider RPCs are service-role-only. Migration 0043 already closes credit RPC access.
- Server admin client is `server-only`, reads `SUPABASE_SECRET_KEY`, never NEXT_PUBLIC. No new admin auth client is needed.
- Provider OAuth callbacks require current user plus owner-bound, single-use state + HttpOnly cookie. They must keep those checks; verified users continue normally.
- Cron routes use CRON_SECRET; token rotation has its own secret; Resend webhook verifies signatures; unsubscribe uses signed recipient tokens. These are not user-session boundaries and must not be blanket-gated.
- No dedicated behavioral auth regression suite existed. Existing tests cover provider, job, owner isolation, and database behavior.

## Existing-user caveat / deployment stop condition
Supabase `email_confirmed_at` is authoritative for its current confirmation state, but disabling Confirm email can auto-confirm users without inbox proof. Neither JWTs nor timestamps reveal that history reliably. Existing confirmed users must remain compatible; this work must not invent historical evidence or silently rewrite auth users. Work must review Dashboard configuration/history and aggregated user cohorts privately before enabling enforcement. Unconfirmed legitimate users need an approved real confirmation/recovery campaign and tested access path before rollout. If auto-confirmed history is present/unknown, agree a separate re-verification plan; do not claim this PR retrospectively proves those addresses.

## Security gaps addressed by planned change
Unverified JWT access, claims-only authorization, direct database bypass, missing recovery/resend, configuration-dependent instant signup access, request-origin email redirect fallback, and missing explicit auth error/recovery states. Existing fixed callback destination and provider state protections are preserved.

## Additional finding
`npm ci`/audit reported existing Next 16.3.2 critical advisories and a high js-yaml dev dependency advisory. Patch-level remediation will be included and validated, not a framework redesign.
