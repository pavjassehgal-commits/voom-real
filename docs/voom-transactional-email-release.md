# VOOM account email release — OFF, not yet delivery-accepted

## Confirmed read-only on 2026-11-03

- Main baseline `1fc916e27493e96a2adce94fe02f9b1b9b376f2c`.
- Signup calls Supabase Auth; password login itself sends no email. The existing
  callback exchanges a Supabase PKCE code. No custom VOOM welcome/reset sender
  existed. Business `welcome` flows are businesses emailing their contacts,
  not VOOM welcoming its own account holders.
- Production Supabase `spqkkbznzxxkdtexyqzh`: site URL `https://voom.today`, email
  provider enabled, **mailer_autoconfirm=true** (signup confirmation OFF),
  **no custom SMTP / Send Email hook**, default email rate limit 2/hour. Default
  templates exist; their existence does not prove sending or delivery. Security
  notification activation was not established by this read.
- Existing Production variables: `EMAIL_PROVIDER_API_KEY`, `EMAIL_FROM_ADDRESS`,
  `EMAIL_FROM_NAME`, `EMAIL_WEBHOOK_SECRET`, `EMAIL_UNSUBSCRIBE_SECRET`.
  Configured shared sender is **Voom <hello@voom.today>**, not no-reply. No
  provider key was decrypted; only sender strings were read.
- Owner confirms `no-reply@voom.today` exists in Workspace and `voom.today` is
  Verified in the ORIGINAL Resend account. No real account email was sent or
  its inbox delivery independently established in this task.

## Implemented, separately from business marketing

- Real Forgot password and confirmation-resend pages/actions. Supabase Auth
  remains the sender and security authority for verification/reset tokens;
  the application never generates links with an admin bypass. Public responses
  do not distinguish unknown accounts, provider errors or throttling.
- Recovery GET does not exchange/consume the token. An explicit POST supports
  the existing PKCE callback and recovery token-hash templates. Password update
  revalidates the actual user and session plus a 10-minute HMAC/HttpOnly proof;
  another logged-in session or a forged client user ID cannot use that proof.
  Replayed Supabase reset codes remain subject to Supabase single-use/expiry.
- Four local branded, responsive Auth templates; do not install them silently.
  Confirmation retains Supabase's `{{ .ConfirmationURL }}`. The prepared recovery
  template uses the app's non-consuming `/auth/recovery?token_hash={{ .TokenHash }}`
  page; only its explicit POST verifies the Supabase recovery token. No homemade
  auth token or client-controlled redirect. Use SMTP link tracking OFF. Existing
  default recovery links remain compatible via PKCE, but a scanner hitting the
  upstream default verification URL may consume them. Substitute the isolated
  staging hostname in templates for staging; never use Production callbacks there.
- 0074 adds a private service-role-only account-email outbox, delivery receipts,
  policy and HMAC-subject request counters. No 0073 dependency or changes to
  customer campaigns, contacts, marketing sending policy, billing or credits.
  No auth trigger, existing-row rewrite or cron installation.
- Welcome enqueue is deduplicated per account and recovered by the worker if
  an app callback enqueue was interrupted. Only mail-confirmed email/password
  accounts created after the explicit activation cutoff qualify. A non-null
  `confirmation_sent_at` is required as well as `email_confirmed_at`; current
  auto-confirmed signups do not receive welcome mail. No retrospective welcome
  campaign for existing customers, and no promotional content.
- Both application flag and database policy default OFF. Auth/email queue
  failure never blocks existing signup/login. Operator monitors sanitized
  `welcome_queue_unavailable` logs and outbox state. Welcome mail waits for a
  separately configured worker; authentication never directly sends via Resend.
- One job/pass, durable immutable body and stable Resend key, 1-second spacing,
  50 attempted submits/day and 500/month for THIS subsystem. These are NOT
  account-wide provider usage limits; approve capacity alongside existing
  transactional/marketing traffic. A 429 may retry the identical body/key up to
  three attempts, minimum one minute apart, before 23 hours. Network/5xx/lost
  responses/stale claims are **uncertain**, never automatically resubmitted.
  Signed delivery tags/receipts can reconcile them. Accepted != Delivered.
- New `/api/webhooks/transactional-email` is separate from existing campaign
  webhooks. Requires its own signing secret plus environment-bound HMAC tags,
  immutable message binding and deduplicated SQL receipts; DB failures return
  retryable 503. Production cannot accept another site's tagged receipt.
- New cron endpoint requires the existing CRON_SECRET, but is NOT registered in
  Vercel or Supabase. Existing schedules/endpoints/timeouts are untouched.
- Subscription hooks are types only. No billing integration, fabricated
  payment events, account-notification batch or subscription emails execute.

## Configuration and rollout approvals still required

1. Approve isolated staging first. Apply ONLY 0074 after schema review/backup
   and dependency check; 0073/YouTube compliance work is not a dependency.
   Keep app flag and DB policy OFF; use mocked providers or local Mailpit.
   Do not repurpose `email-safety-staging`, its vibebling9 credentials, or
   Claude's compliance Preview/Worker. This branch opts out of automatic Preview.
2. New separately protected Preview must override EVERY inherited production
   secret/provider setting, use staging Supabase, independent auth HMAC/webhook
   secrets, no publishing/marketing worker credentials and a single approved
   owner-controlled test inbox. Do NOT copy any Production Resend key. A new
   dedicated Sending-only testing credential is required for later live
   acceptance; the exact free account/domain choice needs owner approval.
3. Supabase staging Auth SMTP changes require separate approval; they affect
   the whole staging Auth service, so check for other ongoing tests first.
   Default Auth SMTP is not ordinary-customer delivery infrastructure. Use
   local Supabase Mailpit for non-delivery tests if shared Auth changes conflict.
4. After staging acceptance, approve Production migration/config/deployment
   separately. 0074 may be installed before app code while OFF. Do not drop a
   populated outbox/receipt table or blindly resubmit uncertain mail on rollback.
   No business marketing migration/activation belongs in this release.
5. In Production Supabase Authentication → Email → SMTP Settings, configure
   ORIGINAL-account Resend SMTP (documented host `smtp.resend.com`, port 465,
   username `resend`, password a separately approved sending credential),
   sender **no-reply@voom.today**, sender name **Voom**. Do not use Google
   Workspace SMTP passwords or the vibebling9 domain-manager key. Supabase
   SMTP settings are NOT Vercel environment variables.
6. After explicit approval, enable Confirm Email, install confirmation/recovery
   and password/email-change notification templates, and enable the appropriate
   Supabase security notifications. Confirm the Workspace reply mailbox is
   monitored; do not promise a response SLA. Preserve every existing redirect
   and only add exact needed callbacks. `https://voom.today/auth/recovery` is
   already allowlisted; include `sb_flow_id` variants exactly if required.
7. Add Production-only `VOOM_AUTH_EMAIL_SECRET` (new >=32-char random secret),
   `VOOM_TRANSACTIONAL_RESEND_API_KEY` (ORIGINAL Resend account, Sending only),
   `VOOM_TRANSACTIONAL_FROM_ADDRESS=no-reply@voom.today`,
   `VOOM_TRANSACTIONAL_WEBHOOK_SECRET` (new separate webhook), and OFF flag.
   Do not change existing EMAIL_* variables/credentials/campaign webhook.
8. Approve an immutable new-account `welcome_start_at` cutoff at activation,
   then enable the DB policy/app flag only after every runtime has 0074 code.
   Add an authenticated schedule for the dedicated endpoint only after approval
   (recommended once/minute, bounded 60-second HTTP timeout; one welcome/pass).
   A future activation/configuration can send email: it is NOT authorized here.
9. A separate approval must name the owner-controlled recipient and exact
   confirmation/reset/welcome test messages. Verify actual inbox headers/from,
   mobile templates, link expiry/single-use, recovery/session binding, unique
   welcome acceptance, signed delivery event and no unintended customer sends.
   Read-only evidence/transport mocks are not a delivery-acceptance claim.

## Staging acceptance (prepared, not executed remotely)

- Synthetic users only; no Production secrets. Default OFF must yield no mail.
- Exercise signup → confirmation → onboarding/welcome enqueue, repeated login,
  Forgot password → Continue securely → new password → login, unknown-address
  requests, expired links and cross-owner/session replay via real app actions.
- Provider mocks cover 429, timeouts/5xx, acceptance lost before DB response,
  duplicate receipts, webhook storage failure, changed email and stale claims.
- Verify actual DB uniqueness/grants, per-IP/address budgets, daily/monthly cap,
  immutable retry payload/key, cutoff excludes existing/auto-confirmed users,
  and existing customer campaigns/contacts/credits/cron fingerprints unchanged.
- Hosted concurrent multi-connection behavior and provider/SMTP delivery still
  require isolated acceptance. Local embedded SQL tests are not hosted proof.

## Official references

- https://supabase.com/docs/guides/auth/auth-smtp
- https://supabase.com/docs/guides/auth/passwords
- https://supabase.com/docs/guides/auth/auth-email-templates
- https://resend.com/docs/send-with-smtp
- https://resend.com/docs/dashboard/emails/idempotency-keys
- https://vercel.com/docs/headers/request-headers

## Local validation completed (not hosted/live acceptance)

- 56 focused tests passed: real 0074 SQL/RLS/unique constraints in isolated
  PGlite; actual server-action functions with mocked Auth; mocked Resend and
  signed receipts; existing auth/branding/provider compatibility regressions.
- TypeScript and targeted ESLint passed. The actual default Production
  Turbopack build passed, including 69 static pages. No compiler override.
- Seven fresh local Chrome checks passed at 1440×900, 320×640 and a 390px
  email preview: real form navigation/POSTs, anonymous reset denial, invalid
  recovery, responsive layout and a full-length synthetic recovery token.
  No overlays, console/runtime errors or external requests. Browser plugin was
  unavailable; existing Playwright was used. Providers were OFF throughout.
- 0074 SHA-256: `f672166284ec33f3728b60ed5c935e43a8dc3a7f64fac3448ddd2d8262069c84`.
  Migration remains UNAPPLIED remotely. No auth/SMTP/environment/cron changes,
  Production deploy, real email or customer-data mutation occurred.
