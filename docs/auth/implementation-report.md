# Voom production authentication implementation report

## Scope and audit

Continues from fetched Production-era `main` commit `02787af8916ded7c4069c2a146d3b3ecbb80cce2` on the Arena session branch. [Pre-change audit](audit.md). No Production config/user/data changes, no real email, no provider approval/publishing implementation, billing change, domain acquisition or app-wide redesign.

### 1–2. Old behavior and gaps

Signup redirected to onboarding whenever Supabase returned a session; otherwise it showed inline confirmation copy. Login, `/app` layout and the shared API/data guard accepted JWT claims without checking current email-confirmation state. Proxy only refreshed sessions. Onboarding could create profile/business rows for any claims-authenticated account. Ownership-only RLS allowed direct Supabase database access independently of Voom UI checks. No resend/password-reset flow existed. Signup email redirects could fall back to the incoming Origin. The old callback already allowlisted `/app` and provider callbacks already enforced owner-bound state; those strengths are preserved.

### 3. New signup

Normalize email whitespace/case without rewriting dots/plus suffixes. Validate email and new passwords (12–128 characters) server-side. Supabase `signUp` → dedicated verification-required page, never immediate onboarding. An unexpected signup session is signed out and reported as unavailable verification, not accepted as proof. Obfuscated duplicate success and explicit duplicate/rate-limit errors receive neutral verification guidance. Resend uses `auth.resend({type: 'signup'})`, generic responses, pending controls and a 60-second cooldown; Supabase enforces real server-side rate limits. Callback exchanges the Supabase PKCE code with SDK flow ID, then calls `getUser` and requires confirmed email. The success screen offers a safe internal Continue destination; the existing shell directs users without completed businesses to onboarding.

### 4. Verification enforcement

- `getAuthUser`: request-cached authoritative Supabase `getUser`, not `getSession`, client metadata or JWT-only claims.
- `isVerifiedUser`: email present + `email_confirmed_at` present + not anonymous.
- `getCurrentUser`: verified-only identity consumed by all existing product routes, data readers and server mutations. Direct invocation remains protected even if proxy is skipped.
- `/app` layout: explicit login/verification redirect before profile/business loading. Includes onboarding.
- Proxy: additional default-deny product API guard (401 missing/invalid session, 403 unverified), protected app redirects, same-origin browser mutation checks, and refreshed-cookie propagation across denial/redirect responses. No-cache responses.
- Migration 0050: narrow boolean function reads the authoritative `auth.users` record; a restrictive RLS policy is ANDed with existing ownership policies on every current public RLS table. Direct PostgREST and invoker RPC access cannot bypass confirmation. No auth-user or product-row rewrite.
- Exact non-session exception inventory preserves independently secured cron, administrative rotation, signed webhook/unsubscribe and the 410 MARA tombstone. Provider OAuth callbacks are **not** exempt from verified-owner checks; their state protections remain unchanged. Existing service-role jobs retain BYPASSRLS/ACL behavior.

### 5. Sign-in/session behavior

Supabase email/password sign-in with generic credential/rate failure and dedicated unconfirmed-email handling. Fresh `getUser` validation before continuing; old legitimately confirmed users and shorter existing passwords remain valid. Only exact internal destinations are accepted. Existing SSR refresh/persistence remains; cookies survive proxy redirects. Logout requests local Supabase signout, then explicitly expires local session chunks, PKCE and recovery cookies even on remote failure. No service-role credential is added to auth forms.

### 6. Password reset

Forgot password uses `resetPasswordForEmail` with a fixed recovery callback. Neutral existence/delivery/throttle responses. Recovery callback stores only the opaque Supabase code/flow ID in a 10-minute HttpOnly SameSite=Lax cookie and removes it from the URL; **this cookie is not a recovery authorization grant**. Password POST validates before consuming the code, exchanges PKCE, checks recovery context and authoritative user, then calls `updateUser`. Existing login/forged transport alone never grants reset access. On success, request global Supabase signout, clear local credentials, show success and sign-in. Invalid/expired/reused/cross-browser links lead to a new-link page. Exchange-success/update-failure requires a fresh recovery link. No custom verification code/token table or independent authentication system.

### 7. Existing-user findings

Production settings and user history are **not available in this checkout**. No assertion is made about actual Production confirmation counts. Supabase auto-confirm can populate `email_confirmed_at` without inbox proof; this PR cannot retrospectively identify those accounts. Known confirmed accounts remain compatible. Unconfirmed legitimate accounts or unknown auto-confirmed history are a **rollout stop condition**, requiring a privately reviewed real re-verification plan, not fabricated confirmation or a silent bypass. See the runbook's read-only aggregate SQL and decision tree.

### 8–9. Production configuration and SMTP

[Exact manual settings, redirect patterns, templates, SMTP requirements and live-documentation limits](production-rollout.md#2-exact-supabase-configuration-manual-not-performed-here).

Mandatory: Confirm email ON; canonical Site URL and Vercel auth origin `https://voom-real.vercel.app`; only fixed auth callback/recovery paths with bounded SDK flow-ID query patterns; templates use `{{ .ConfirmationURL }}`. Built-in Supabase mail is not sufficient for public Production signup. Configure an approved existing verified SMTP sender privately; Voom's marketing-email API env is not Auth SMTP configuration. No sender address/domain is invented. Project/user/IP rate limits remain authoritative; CAPTCHA, if already enabled, is a compatibility blocker until frontend token collection is separately integrated and tested. Do not turn it on blindly or disable it in this task.

### 10. Migration

`0050_verified_email_access.sql`, not applied to Production. Additive access-control only; no user confirmation backfill or data updates. Deployment must reconcile the actual migration ledger and must not bulk-apply pending provider migrations. Future RLS tables require the same restrictive policy. Tests inspect all public RLS tables and user-callable definer functions to catch new bypasses.

### 11. Tests added

- `auth-flows.test.mjs`: validation, verification-required signup, disabled-confirmation session rejection, duplicate handling, existing-user compatibility, login outcomes, verification/recovery/invalid/replayed callbacks, resend/recovery rate-limit-neutral responses, password update, malicious destinations, transport constraints, and the **installed Supabase SDK's real PKCE recovery behavior with mock HTTP**.
- `auth-boundaries.test.mjs`: authoritative guard, direct app proxy denial, API 401/403, refresh-cookie preservation, same-origin checks, all **58 protected product API route modules invoked without proxy** as unverified user, onboarding writes blocked, verified provider callbacks still enforcing state, actual callback/action routing, email cooldown, logout cleanup and machine-route exceptions. Any unexpected network or admin access throws.
- `auth-rls.test.mjs`: actual migrations on PGlite, confirmed/unconfirmed legacy data, direct SELECT/INSERT/UPDATE denial, immediate confirmation-state changes, unchanged users, ownership preservation, full policy/definer inventory and service-role behavior.

### 12–13. Validation results

| Check | Result |
| --- | --- |
| `node --test tests/auth-*.test.mjs` | **98 passed**, 0 failed |
| Adjacent auth/provider/job/contact/campaign/billing-safety suites | **388 passed**, 0 failed |
| `npm test` | **1,352 passed**, 0 failed, **4 existing skips** (1,356 total) |
| `npm run typecheck` | Passed |
| Changed-file ESLint | Passed, no errors/warnings after removing an existing unused test binding |
| `git diff --check` | Passed |
| `npm audit` / production dependencies | 0 reported vulnerabilities after patch updates |
| Additional `npm run build` attempt | **Environment-blocked:** existing `next/font/google` imports cannot fetch Bricolage Grotesque, Public Sans and IBM Plex Mono from Google Fonts. Not represented as a successful build. |
| Real email/live Production/browser delivery testing | **Not performed.** Operator-controlled Mailpit/staging checklist remains required. |

The adjacent run included Instagram security/queue/key rotation, YouTube/TikTok, contacts, MARA security, email provider/hardening, credits safety, Campaigns v3 and multi-social core. The four existing full-suite skips are legacy table-only credit fakes; their comments point to real SQL/RPC coverage. No new test was skipped.

Baseline comparison: the unmodified baseline source reproduced **22 failures** (1,232 passed, 4 skipped), using the installed dependency tree. Causes: historical campaign fixture times had expired against real Postgres `now()`, and a TikTok test assumed its own feature branch was still unmerged. Test-only future-relative fixture shifts preserve their time relationships and all production schedule guards; the branch-dependent assertion now protects frozen migrations on successor branches. Migration inventory assertions deliberately recognize 0050, legacy confirmed-owner fixtures explicitly model confirmed users, and ownership policy assertions account for the additional **restrictive** gate. No provider, campaign, billing or publishing implementation was modified.

Dependency audit also found pre-existing critical Next 16.3.2 advisories and a js-yaml dev-tool advisory. Updated Next + matching lint config to **16.3.6** and js-yaml lockfile resolution to the patched version. No auth library replacement.

### 14. Files changed

See the exact manifest below. Most non-auth test changes are minimal migration-inventory/confirmed-fixture compatibility adjustments; historical fixture repairs are test-only.

### 15–16. PR and head

One focused, unmerged PR from `arena/01a0c9ec-voom-real`; its URL and final head SHA are provided in the delivery message/PR metadata. No Production release/merge is authorized by this report.

### 17. Safe Production rollout

Follow [the complete gated procedure](production-rollout.md#4-reviewed-release-sequence): private read-only existing-user/configuration audit → resolve confirmation-history/access/SMTP blockers → local/staging mail validation → enable supported Dashboard confirmation/URLs/templates → coordinated app + auth-only migration deployment with traffic restricted → verified-owner/API/DB/job smoke checks → open traffic and monitor. Never disable confirmation or fabricate ownership to fix rollout trouble. No user data rollback is needed; do not roll back to claims-only server code under open product traffic.

## Exact file manifest
- `.env.example`
- `README.md`
- `app/app/actions.ts`
- `app/app/layout.tsx`
- `app/auth/AuthCard.tsx`
- `app/auth/EmailForm.tsx`
- `app/auth/actions.ts`
- `app/auth/callback/route.ts`
- `app/auth/recovery/route.ts`
- `app/forgot-password/page.tsx`
- `app/login/LoginForm.tsx`
- `app/login/actions.ts`
- `app/login/page.tsx`
- `app/reset-password/ResetForm.tsx`
- `app/reset-password/page.tsx`
- `app/reset-password/success/page.tsx`
- `app/signup/SignupForm.tsx`
- `app/signup/actions.ts`
- `app/signup/page.tsx`
- `app/verify-email/page.tsx`
- `app/verify-email/success/page.tsx`
- `docs/auth/audit.md`
- `docs/auth/implementation-report.md`
- `docs/auth/production-rollout.md`
- `lib/auth/boundaries.ts`
- `lib/auth/cookies.ts`
- `lib/auth/flows.ts`
- `lib/auth/policy.ts`
- `lib/auth/recovery.ts`
- `lib/auth/server.ts`
- `lib/auth/site.ts`
- `lib/voom/server-data.ts`
- `next.config.ts`
- `package-lock.json`
- `package.json`
- `supabase/migrations/0050_verified_email_access.sql`
- `tests/auth-boundaries.test.mjs`
- `tests/auth-flows.test.mjs`
- `tests/auth-rls.test.mjs`
- `tests/automated-campaigns-pglite.test.mjs`
- `tests/campaign-production-hardening.test.mjs`
- `tests/campaigns-v3-pglite.test.mjs`
- `tests/campaigns-v3-unified-channels.test.mjs`
- `tests/email-automation-flows-pglite.test.mjs`
- `tests/helpers/future-campaign-fixture.mjs`
- `tests/helpers/pglite-supabase.mjs`
- `tests/mara-campaign-intelligence-pglite.test.mjs`
- `tests/mara-media-brief.test.mjs`
- `tests/multi-social-core.test.mjs`
- `tests/post-format-persistence.test.mjs`
- `tests/post-studio-production-0021.test.mjs`
- `tests/post-studio.test.mjs`
- `tests/tiktok-provider.test.mjs`
- `tests/voom-plans-credits-safety.test.mjs`
- `tests/youtube-provider.test.mjs`
- `utils/supabase/proxy.ts`
