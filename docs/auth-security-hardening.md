# Auth security hardening: staging-first rollout plan

| | Production | Staging |
|---|---|---|
| Supabase project | `spqkkbznzxxkdtexyqzh` (Voom-real2) | `qcdpegwjofrqnfudyrqq` (voom-staging) |
| App | https://voom.today | http://localhost:3000 |
| Templates in this repo | `supabase/templates/voom-auth/` | `supabase/templates/voom-auth-staging/` |
| Auth email sender | `no-reply@auth.voom.today` (Resend SMTP) | `no-reply@auth-staging.voom.today` |

Each step needs the owner's explicit approval at the time.

## Status, 2026-11-21

| Step | Staging | Production |
|---|---|---|
| 0. App code (PR #116: password rule, weak-password message) | n/a | **Deployed** (`9988497`) |
| 1. Minimum password length 6 → 8 | **Applied** | **Applied** |
| 2. Secure password change on | **Applied**; reset flow tested: PASS | **Applied** |
| 3. Remove the two malformed redirect URLs | n/a | **Applied** (9 entries remain) |
| 4. Password-changed notification | Not yet: template ready, see step 4 | Not yet |
| 5. Email-changed notification | **Blocked**, stays off | **Blocked**, stays off |
| 6. Leaked-password protection | Not yet: needs the Pro plan | Not yet |
| 7. Email capacity | Separate dependency | Separate dependency |

The evidence and exact rollback configs for steps 1–3 are in `~/Documents/voom-backups/staging-auth-hardening-2026-11-21/` and `~/Documents/voom-backups/prod-auth-hardening-2026-11-21/`.

## How settings are applied

Use `supabase config push --remote=<ref> --yes` with a config that declares **only** the one property being changed. The current CLI leaves undeclared properties unchanged.

1. Preview with `supabase config diff`. It must show exactly one `[update]`.
2. Apply.
3. Read back the full auth configuration, and compare it with the saved before-snapshot.

The CLI does **not** compare or return email template bodies. Install template bodies in the Dashboard by pasting the committed file.

## Owner decision: no support mailbox (2026-11-21)

- Voom keeps the existing no-reply sender.
- There is no `support@` mailbox and no ticket system for now.
- No template names a contact address or invites a reply. The public legal contact (`lib/legal/contact.ts`) is unchanged and is not used in security emails.

## Step 4: password-changed notification (template ready)

`supabase/templates/<env>/password-changed.html`, generated from `lib/transactional-email/auth-templates.ts`. The full text is:

> **Your Voom password was changed.** The password for your Voom account was just changed. If you made this change, you don't need to do anything. If you didn't, reset your password now with the button below; resetting signs you out on every device. Replies to this email aren't read.
>
> Button: **Reset your password** → `<app>/forgot-password`

**Why this advice is safe:**
- After a password change, the person still controls their email address. The forgot-password flow emails that address.
- A completed reset signs out every session (`signOut({ scope: "global" })` in `app/forgot-password/actions.ts`).
- Changing the email address as well requires confirming from the current inbox, because double confirmation is on.

**When Supabase sends it:** after every successful password change. For Voom that means a completed reset, because there is no in-app "change password" screen. Sending failures never block the password change (`internal/api/user.go`).

**Rollout:**
1. **Staging.** In Dashboard → Authentication → Emails → "Password changed":
   - paste `supabase/templates/voom-auth-staging/password-changed.html`;
   - set the subject to "Your Voom password was changed";
   - turn it on.
   Then run one reset with synthetic staging account A: check the email arrives from the staging sender, its button opens `http://localhost:3000/forgot-password`, and the reset still works.
2. **Production.** Do the same with `supabase/templates/voom-auth/password-changed.html`. Optionally verify with one reset on the existing Production test account (`+voomprodtest1`).
3. **Rollback:** turn the notification off.

## Step 5: email-changed notification: blocked

Leave `notification.email_changed.enabled = false` in both projects. There is deliberately **no** email-changed template in this repo.

**Why it's blocked.** These facts come from Supabase Auth's source (`internal/api/recover.go`, `internal/api/verify.go`):
- The notice goes to the **old** address, only after the change has completed.
- With double confirmation on (`double_confirm_changes = true`, both projects), the change completes only after links sent to **both** the current and the new address are opened. So an unauthorized change already needs the old inbox, or a confirmation the owner was tricked into clicking.
- Password recovery finds the account by its **current** address only. An unknown address gets an empty 200 and no email. **After the change, the old address cannot recover the account.**
- Voom has no in-app email change, no support mailbox and no ticket system.

So a notice could tell the person something went wrong, but couldn't truthfully tell them how to get their account back. A notice that implies a recovery path that doesn't exist would mislead.

**What unblocks it** (owner decision needed):
- a monitored contact path for account-takeover reports; or
- an admin recovery procedure (for example, restoring the email after identity checks).

When one exists, add an email-changed template that names it, plus tests, and roll it out like step 4.

**Related observation:** the "Confirm email change" email (`template.email_change`, subject "Confirm your new email address") is what actually protects against unauthorized changes today: it goes to the current address. Its live body is Supabase's default and isn't in this repo. The CLI can't read template bodies, so check it in the Dashboard.

## Step 6: leaked-password protection (optional)

- **Prerequisite:** the Pro plan or higher (Dashboard → Billing).
- **Voom handles it** since PR #116: signup and reset show "That password is too weak or has appeared in a known data breach. Choose a different one."
- **Existing sign-ins** aren't blocked.
- **Verify:** on staging, sign up with a well-known breached password and check the message.
- **Rollback:** turn it off.

## Step 7: email capacity (separate dependency)

Don't raise Supabase's `rate_limit.email_sent` (30/hour) until the Resend plan's quota and the `auth.voom.today` domain status (SPF, DKIM, DMARC) are confirmed. Voom's own limit on resend and reset requests is separate:

- 5 per IP per 15 minutes;
- 3 per address per hour;
- 30 per hour across all users (`consume_voom_auth_email_limit`).

## Not changed by this document

- Resend and DNS settings.
- The public legal contact.
- Migrations, billing, and the Meta, TikTok, Instagram and YouTube integrations.
