# Auth security hardening: staging-first rollout plan

Status: **prepared only**. Nothing in this document has been applied to staging or Production. Each step needs the owner's explicit approval at the time.

| | Production | Staging |
|---|---|---|
| Supabase project | `spqkkbznzxxkdtexyqzh` (Voom-real2) | `qcdpegwjofrqnfudyrqq` (voom-staging) |
| App | https://voom.today | http://localhost:3000 |
| Templates in this repo | `supabase/templates/voom-auth/` | `supabase/templates/voom-auth-staging/` |

Live values, read with `supabase config diff` on 2026-11-21. Both projects match unless noted.

| Setting | Live value |
|---|---|
| `minimum_password_length` | 6 |
| `password_requirements` | none |
| `secure_password_change` | false |
| `notification.password_changed.enabled` | false (subject "Your password was changed") |
| `notification.email_changed.enabled` | false (subject "Your email address was changed") |
| `double_confirm_changes` | true |
| `enable_confirmations` | true |
| Production `additional_redirect_urls` | 11 entries, see step 3 |
| Production auth `rate_limit.email_sent` | 30 per hour, custom SMTP: Resend, `no-reply@auth.voom.today` |
| Plan / leaked-password protection | NOT verified. It needs the Pro plan or higher |

## What this branch changes in the app (code only)

- `lib/auth/password-policy.ts`: one password rule for signup and reset.
  - At least 8 Unicode characters, counted the way Supabase counts them.
  - At most 72 **bytes**. Supabase rejects anything longer with `validation_failed`.
  - No character-class rules.
- Signup shows a fixed message for Supabase's `weak_password` code.
  - Supabase checks password strength, including leaked-password protection, **before** it looks up the address (`internal/api/signup.go`), so this message is the same whether or not an account exists.
  - `user_already_exists` still looks like success, and every other failure keeps the generic message.
- Reset uses the same rule and message. It maps `reauthentication_needed` to "request a new link".
- The password-changed and email-changed templates now point to the **planned** `support@voom.today` and name no `no-reply` address. They are generated from `lib/transactional-email/auth-templates.ts`. The confirmation and recovery templates are byte-identical to before.

## Rollout order

Do each step on **staging first**, then Production. Record the before value, change one setting, verify, and only then move on.

Apply each change in the Supabase Dashboard → Authentication. Don't use `supabase config push`: it pushes the whole configuration at once.

### Step 0: deploy this branch first

Its signup and reset messages are what make steps 1 and 5 safe for customers. There are no migrations or environment changes.

### Step 1: minimum password length, 6 → 8

- **Customer impact:** none in practice. Voom's forms already require 8, and existing passwords keep working because Supabase checks the length only when a password is set.
- **Verify:**
  - the Dashboard shows 8;
  - `supabase config diff --remote=<ref>` reports `minimum_password_length = 8`;
  - on staging, a 7-character password set directly through the API is rejected.
- **Rollback:** set it back to 6.

### Step 2: secure password change, off → on

- **Effect:** changing a password needs a session that started within the last 24 hours (`internal/api/user.go`). Otherwise Supabase returns `reauthentication_needed`.
- **Existing sessions:** none are signed out.
- **Voom's reset flow is unaffected,** because it creates a new session right before the change.
- **Customer impact:** none. There's no in-app "change password" for signed-in users. A stolen session older than 24 hours can no longer change the password.
- **Verify:** on staging, a full forgot-password → reset → log in with the new password succeeds.
- **Rollback:** turn it off.

### Step 3: redirect allow-list, Production only

Remove exactly these two malformed entries; they match no real URL:

- `http://localhost:3000/auth/confirm5.`
- `http://localhost:3000/auth/callback4.`

Keep everything else:

| Entries | Why |
|---|---|
| `voom.today` `/auth/callback` and `/auth/recovery`, each with and without `?sb_flow_id=*` | Live Production |
| `voom-real.vercel.app`, the same four | A live Production alias, and the site URL used by the main checkout's local `.env.local`, which points at Production Supabase |
| `http://localhost:3000/**` | Removing it is a separate decision. It only matters to someone running local development against **Production** Supabase, which should move to staging |

- **Verify:** the list shows 9 entries, and a signup or reset link still lands on `voom.today`.
- **Rollback:** re-add the two strings exactly.

### Step 4: create and test the support mailbox (blocker for step 5)

- `support@voom.today` is **NOT yet confirmed to exist, receive mail or be monitored**.
- The owner, or whoever controls the domain, creates it and sends a test message from an outside address, checking that it arrives and that someone reads it.
- They also decide who covers it during absences.
- If a different address is chosen, change `PLANNED_SUPPORT_EMAIL` in `lib/transactional-email/auth-templates.ts`, run `scripts/prepare-voom-auth-emails.mjs` (both commands are at the top of the file), and the tests will check the result.

### Step 5: notification emails

Do this only after step 4 passes and the branch is merged.

1. In Dashboard → Authentication → Emails → "Password changed", paste the body of `supabase/templates/<env>/password-changed.html`. Set the subject to "Your Voom password was changed" and turn it on.
2. In "Email address changed", paste `email-changed.html`. Set the subject to "Your Voom email address was changed" and turn it on.

- **Customer impact:** after a password reset, people get a short confirmation email. After an email change, the **old** address is told. Voom has no email-change screen, so this mainly covers API-level changes. Confirmation from both addresses stays on.
- **Sending failures never block a password change** (`internal/api/user.go`).
- **Verify:**
  - on staging, one reset with a staging test account delivers "Your Voom password was changed" with working links;
  - on Production, optionally one reset on the existing test account `+voomprodtest1`.
- **Rollback:** turn the notification off. The old body is the Supabase default, which was never used.

### Step 6: leaked-password protection (optional)

- **Prerequisite:** the Supabase plan must be Pro or higher. Check it in Dashboard → Billing.
- **Will Voom handle it?** Yes, with this branch deployed. A breached password at signup or reset now shows "That password is too weak or has appeared in a known data breach. Choose a different one."
- **Sign-in is not blocked** for existing users.
- **HIBP outage:** if HaveIBeenPwned can't be reached, Supabase lets the password through and logs a warning, unless fail-closed is configured.
- **Verify:** on staging, sign up with a well-known breached password and see the message.
- **Rollback:** turn it off.

### Step 7: email capacity (separate dependency)

Don't raise Supabase's `rate_limit.email_sent` (30/hour) until the Resend plan's daily and monthly quota and the `auth.voom.today` domain status (SPF, DKIM, DMARC) are confirmed. Voom's own limit on resend and reset requests is separate:

- 5 per IP per 15 minutes;
- 3 per address per hour;
- 30 per hour across all users (`consume_voom_auth_email_limit`).

## Not changed here

- Supabase, Resend and DNS settings.
- The public legal contact (`lib/legal/contact.ts`).
- Migrations, billing, and the Meta, TikTok, Instagram and YouTube integrations.
