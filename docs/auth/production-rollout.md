# Production authentication — operator runbook

**Status: implementation only. No Production settings, users, migration, or email delivery changed by this task. Do not deploy/apply 0050 until the preflight below is signed off.** Canonical deployment: `https://voom-real.vercel.app`.

## 1. Read-only preflight — Work must perform privately

The checkout cannot establish actual Dashboard configuration, SMTP readiness, applied migration ledger, user counts, or historical ownership. Do not paste user lists, tokens or credentials into a PR/chat.

1. Inspect Authentication → Sign In / Providers → Email (labels may vary): current Confirm email state, email provider enabled, anonymous sign-ins, password requirements, Secure email change, token lifetime, CAPTCHA, rate limits. Review deployment/config history for any period with Confirm email off, invitations/admin-created users, or manually confirmed development accounts.
2. Run this **read-only aggregate** in the authorized SQL editor; no PII is returned:

   ```sql
   select
     count(*) filter (where email is not null) as email_accounts,
     count(*) filter (where email is not null and email_confirmed_at is not null) as confirmed,
     count(*) filter (where email is not null and email_confirmed_at is null) as unconfirmed,
     count(*) filter (where coalesce(is_anonymous, false)) as anonymous_accounts,
     count(*) filter (where email is not null and email_confirmed_at is null
       and exists (select 1 from public.businesses b where b.owner_user_id = u.id))
       as unconfirmed_with_business
   from auth.users u;
   ```

3. Privately inspect the affected owner cohort, last sign-ins, identity providers, confirmation audit events and active jobs. **A non-null email_confirmed_at is NOT proof that legacy users clicked a link:** Supabase auto-confirms when Confirm email is disabled. Timestamps near creation are not reliable evidence either. Do not guess cohort membership based on timestamps alone.
4. Review applied migration ledger and public-table RLS in Production. This repo does not prove that all earlier provider migrations are deployed. Do not run an indiscriminate `db push` that applies unrelated pending migrations. 0050 is auth-only and uses existing public RLS tables; reconcile migration ordering with the release owner before applying it. If a product migration is subsequently applied out of order, its new tables need the verification policy too (0050 is re-runnable).
5. Check `NEXT_PUBLIC_SITE_URL` in the Production Vercel environment and confirm only the public Supabase URL/publishable key are NEXT_PUBLIC. Keep `SUPABASE_SECRET_KEY` server-only.

### Existing-user decision / stop conditions

- Legitimately confirmed existing users retain their IDs, data, passwords and onboarding state; no forced reset or new password minimum on sign-in.
- **Any legitimate unconfirmed users: STOP rollout.** Agree a communication/access-restoration plan with the owner. Test a Supabase confirmation resend (or approved recovery flow, which also proves inbox access) in staging first. Give affected owners an actual email-verification path before enabling the product gate. Do not backfill `email_confirmed_at`, whitelist account IDs or set user metadata as proof.
- **Auto-confirmed/unknown history: STOP claiming ownership is proven.** Agree a separately reviewed re-verification rollout using supported Supabase mechanisms. Do not silently revoke/alter all users in this PR. This release preserves current Supabase-confirmed legacy users; it cannot retrospectively distinguish inbox-confirmed from auto-confirmed users.
- If CAPTCHA is already enabled, do not deploy these forms until token collection is integrated/tested in a follow-up or the deployment owner has an approved compatible abuse-control configuration. This PR does not disable CAPTCHA or pretend to supply CAPTCHA tokens.
- Do not deploy if SMTP, templates, old-user access, migration ordering or callback allowlisting is unresolved. Keep an existing verified operator session available for the supervised rollout.

## 2. Exact Supabase configuration (manual, not performed here)

| Setting | Required value / action |
| --- | --- |
| Email provider | Enabled, email/password signup enabled |
| Confirm email | **ON** (`mailer_autoconfirm = false`). Mandatory before exposing signup; timestamp checks cannot compensate for an auto-confirming Auth server. |
| Anonymous sign-ins | Keep disabled unless independently needed/reviewed; anonymous users never receive Voom product access here. |
| Site URL | `https://voom-real.vercel.app` |
| Vercel `NEXT_PUBLIC_SITE_URL` | `https://voom-real.vercel.app` (origin only, no path/query/credentials) |
| New password minimum | 12 characters; application allows 12–128, including spaces/passphrases. Existing shorter valid passwords still sign in. Enable leaked-password protection if available; test provider strength rules. |
| Secure email change | ON; never allow an unauthenticated address change or client metadata to stand in for verification. |
| Email OTP/link expiry | Recommend 3600 seconds; do not increase as an abuse workaround. Supabase separately controls short-lived, single-use PKCE exchange codes. |
| Auth email frequency | At least 60 seconds per user; keep project/IP/verification/token limits enabled and tune for real traffic. |
| Secure password change / reauthentication | Test enabled policy with a fresh recovery session. This flow exchanges immediately before `updateUser`, not from an old login. |

### Redirect URL allowlist

Keep fixed origins and exact callback **paths**, not an all-path/all-Vercel wildcard. Add these patterns (literal backslash escapes the query marker in Supabase glob syntax):

```text
https://voom-real.vercel.app/auth/callback
https://voom-real.vercel.app/auth/callback\?sb_flow_id=*
https://voom-real.vercel.app/auth/recovery
https://voom-real.vercel.app/auth/recovery\?sb_flow_id=*
```

Current SSR/Auth SDK can append `sb_flow_id` for its PKCE verifier slot. Permit that parameter on these paths only. No `next` query is sent in newly requested auth emails; intended navigation defaults safely to `/app`. The app only accepts a small exact internal destination set when `next` is supplied by old/manual links.

For a short, bounded old-link compatibility period, retain the **existing** legacy confirmation callback entry if present (`/auth/callback?next=%2Fapp`, plus its SDK flow-id variant if previously configured). Do not delete working legacy entries during the preflight. Expired legacy links can use the new resend screen. Verify actual generated redirect matching in staging, including flow IDs, before Production enablement.

Preview/local authentication must use a **separate non-Production Supabase project** and an explicit `NEXT_PUBLIC_SITE_URL` for that environment. Add only its exact callback paths/flow-id query patterns there. Do not enable arbitrary preview hosts on Production. No request `Origin`, `Host` or deployment-name fallback supplies auth email URLs.

### Templates

Configure both **Confirm signup** and **Reset password** templates to use Supabase's own supported confirmation URL. Preserve it exactly; do not replace it with `.SiteURL`, an implicit `#access_token` URL, or a custom token-hash route (not implemented).

Confirm signup subject: **Verify your email for Voom**

```html
<h2>Verify your email for Voom</h2>
<p>Confirm that you own this email address before using Voom.</p>
<p><a href="{{ .ConfirmationURL }}">Verify email</a></p>
<p>Open this link in the same browser where you requested it. If you did not create an account, ignore this email.</p>
```

Reset password subject: **Reset your Voom password**

```html
<h2>Reset your Voom password</h2>
<p><a href="{{ .ConfirmationURL }}">Choose a new password</a></p>
<p>Open this link in the same browser where you requested it. If you did not request a reset, ignore this email; your password has not changed.</p>
```

Use only truthful, owner-approved sender/contact details; no invented domain/address. Disable SMTP link tracking/rewriting. Email security scanners can consume Supabase's initial verification link before the person clicks; recovery's Voom callback does not exchange on GET, but cannot prevent a scanner visiting the upstream Supabase link. Invalid/already-used UI must remain available; request a fresh link when needed. Cross-device/browser completion is intentionally not supported by PKCE; request a new link in the browser being used. Do not weaken PKCE to avoid that requirement.

## 3. SMTP / delivery requirements — separate configuration work

The existing Voom marketing email API configuration **does not configure Supabase Auth SMTP**. No auth email is sent through Voom's marketing dispatch code. Supabase owns generation, expiry, verification and delivery of auth links.

Supabase's documented built-in sender only delivers to project organization team addresses, currently caps delivery at **2 emails/hour**, and is best-effort with no SLA. It is not a Production email solution. Custom SMTP is required for public signup. After custom SMTP configuration, Supabase documents an initial **30 messages/hour** limit; tune the actual project limit rather than assuming custom SMTP is unlimited.

Work must supply privately in Dashboard → Authentication → Email/SMTP:
- provider SMTP host, TLS port, username, password;
- an **already owned and provider-verified** sending address, and sender display name `Voom`;
- provider-verified SPF/DKIM and appropriate DMARC, bounce/suppression monitoring;
- separate auth transactional sending identity/stream from marketing, adequate quotas and delivery monitoring.

If the approved existing infrastructure is Resend, use its documented SMTP integration and an appropriately scoped credential in Supabase Dashboard. Do not automatically reuse the application's marketing API key or expose any credential in Vercel NEXT_PUBLIC variables. If no owned verified sender exists, SMTP setup remains a launch blocker; domain acquisition is outside this task.

Documented Auth quotas include 60-second per-user signup/reset/OTP windows, project email limits, signup/sign-in related endpoint IP limits (currently 30 requests/5 minutes with bursts), verify IP limits and token endpoint limits. Consult the live Dashboard/docs before rollout because defaults can change. Server actions use the publishable SSR client: IP limits may aggregate by Vercel egress. This PR does not trust client-supplied forwarded IPs or introduce a secret-key auth client. Tune capacity and add platform/WAF per-IP abuse rules; monitor legitimate throttling. The 60-second browser/cookie cooldown is **UX only**, not a distributed abuse-security boundary. Supabase's own user/project/IP throttling remains authoritative even for requests made directly with the public key. CAPTCHA is recommended as a separately tested enhancement for public-scale bot pressure, not a flag to switch on without frontend integration.

## 4. Reviewed release sequence

1. Review the audit and preflight, record approved cohort/SMTP/settings decisions privately. Stop on unresolved existing-user ownership/access issues. No auto-confirm backfill.
2. Use local Supabase/Mailpit or a separate staging project; never point automated tests at Production. Run mock/PGlite suites and the browser checklist below with locally captured mail. Operator-controlled real delivery smoke tests, if later approved, are separate from this Arena task.
3. Review migration 0050 against the actual deployed schema/ledger. It creates one narrow security-definer boolean function and a **restrictive** policy on all existing public RLS tables. It changes no user or product records, grants no new table/storage privileges and leaves service-role BYPASSRLS and job RPC ACLs intact. Existing ownership policies still apply. Re-run the catalog coverage query/test for any additional deployed tables or callable SECURITY DEFINER functions not represented by this checkout.
4. In an approved release window, configure SMTP/templates/URLs and **Confirm email ON first**. Verify the allowlist with the installed SDK behavior and operator-authorized test addresses. Never disable confirmation to repair delivery.
5. Deploy the reviewed application commit with Production env values. Apply **only the reviewed auth migration** using the team's controlled migration process, not pending provider work. Keep public signup/product access closed at the deployment edge during this coordinated application+database change until both are live and probes pass. Do not claim direct-database protection until 0050 is applied.
6. Run the browser checklist, API unauthorized probes and read-only schema verification. Confirm a legitimate existing verified operator account works; cron secrets/provider callback state/signatures still work without broad session exemptions.
7. Open traffic. Monitor auth error codes/aggregate delivery failures, 401/403 rates, link failures, callback latency, SMTP bounces and existing-owner access. Redact full callback queries/codes and passwords from hosting/APM logs; application code does not log them. Do not add tokens to analytics.
8. Leave the PR unmerged until review and release authorization. This task creates no Production users and sends no emails.

### Browser / integration checklist (Mailpit or separately approved staging)
- New email/password signup has no normal app session; `/app`, onboarding actions, MARA/campaign/provider APIs and direct PostgREST access deny an unconfirmed test account.
- Verify newest link in requesting browser → verified screen → `/app` → onboarding if no completed business. Refresh/new tab persists session. No profile/business exists until authorized onboarding.
- Existing confirmed operator/password and completed onboarding still work; old shorter passwords remain usable. Duplicate signup and unknown reset/resend show neutral text, not account status.
- Invalid/expired/replayed link, another browser, rejected callback flow ID and malicious `next` show safe failure/fallback. Clicking an already-used confirmation link can still lead an already-confirmed signed-in user to the true success state.
- Resend and reset do not auto-retry; repeat requests cool down; throttling/errors never promise email delivery.
- Recovery callback transports a code into a ten-minute HttpOnly SameSite=Lax cookie and strips it from the Voom URL. No session is created by that GET. Submit valid password → exchange Supabase PKCE → fresh `getUser` verification → `updateUser` → global signout → success/sign-in. An existing login alone or a forged/stale cookie fails. A fresh link is needed if exchange succeeds but update fails.
- Logout expires local auth/PKCE/recovery cookies even if remote logout is unavailable. Successful reset requests global refresh-token revocation; already-issued JWTs may live until their Supabase expiry (do not promise instantaneous worldwide access-token revocation).
- Provider callbacks still require verified owner and original single-use owner-bound state; cron/webhook/unsubscribe endpoints retain their independent authorization. Test jobs without actually publishing or sending.
- Mobile keyboard, labels, alert/status announcements, disabled pending controls, and navigation are usable. No auth query secrets in external referrers, analytics or caches.

## 5. Rollback

Prefer a forward fix. If a rollout problem affects confirmed users, restrict public access and investigate authoritative Auth availability/configuration; do not disable Confirm email, weaken verification policies, or blanket-confirm users. App rollback while 0050 remains in place retains direct DB protection but an old server build may use service-role paths after claims-only checks: **keep product traffic closed** until verification-aware code is restored. Back up schema/policies via the normal release process. Dropping `voom_verified_email` policies/function would deliberately reopen the direct DB bypass and is not a safe routine rollback. No data rollback is required because 0050 rewrites no rows.

## Official references (reviewed 2026-09-22)

- [Supabase password authentication / PKCE / recovery](https://supabase.com/docs/guides/auth/passwords)
- [Supabase redirect allowlists and glob syntax](https://supabase.com/docs/guides/auth/redirect-urls)
- [Supabase custom SMTP requirements and limits](https://supabase.com/docs/guides/auth/auth-smtp)
- [Supabase Auth rate limits and server IP forwarding constraints](https://supabase.com/docs/guides/auth/rate-limits)
- [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates)

Dashboard state and historical users remain **unknown until Work's authorized read-only preflight**; these references describe requirements, not observed Production configuration.
