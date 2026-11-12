# PR #105: controlled Resend delivery acceptance preparation

Status: code validated; BLOCKED on external isolated credentials, DNS and callback access.
This document does not authorize delivery or commercial activation.

## Confirmed on 2026-11-02

- The signed-in Resend account lists `voom.today` as Verified and ready to send.
  Its existing DNS, tracking, TLS and domain settings were not changed.
- Existing keys `Onboarding` and `voom-deletion-alerts` were not read, copied,
  edited or rotated. No new key has been created.
- The two existing webhook destinations are `https://voom.today/api/webhooks/resend`
  and `https://voom-real.vercel.app/api/webhooks/resend`. Both remain enabled
  and untouched. Adding a webhook exposes event selection, but no visible
  API-key/domain filter or custom authentication-header field. The unsaved
  staging form was cancelled. Do not assume account webhooks are key-isolated.
- Protected Preview:
  `https://voom-real-git-email-safety-staging-pavjassehgal-commits.vercel.app`.
  Its 67 branch-only variables remain verified, provider credentials blank,
  workers disabled and Vercel Authentication unchanged. Existing environment
  records and project configuration remain unchanged against the saved baseline.
- Staging project `qcdpegwjofrqnfudyrqq`: migration 0073 remains installed,
  commercial policy OFF, pre-existing data/functions/policies/crons unchanged.
- Onboarding copy is corrected in the PR follow-up: own verified domain, complete business
  details and enabled sending are required; managed addresses are preview-only.
  No updated application deployment is part of this preparation.

## Credential and webhook blockers

1. IMPLEMENTED: `EMAIL_PROVIDER_API_KEY` sends email; the separate server-only
   `EMAIL_DOMAIN_API_KEY` performs live domain checks. No credential fallback
   is allowed. The domain capability cannot send, delete domains, rotate keys
   or follow redirects; domain mutations require `EMAIL_DOMAIN_SETUP_ENABLED=true`
   in addition to authenticated owner DNS proof. Resend itself currently offers
   only Full access or Sending access, not a domain-read-only credential.
   Consequently a management key from the shared Production Resend account
   must NOT be placed in staging. Use a separate FREE Resend team/account
   containing only an approved non-Production test domain; stop if a paid plan
   is required. Distinct keys in the same account are not full isolation.
2. Provider verification is not business ownership. The existing 0073 path
   still requires the staging owner's exact `_voom-email.<test-domain>` TXT
   challenge. No positive live proof for a synthetic owner was established.
   Do not insert a fabricated verified registry row, mock DNS in a purported
   real acceptance run, or change Production DNS under this authorization.
3. IMPLEMENTED: outgoing marketing tags contain an environment name and an
   HMAC proof bound to environment, owner, source kind and source UUID. The
   receiver first verifies Resend's signature, then the environment/proof and
   persisted submission/message binding. Other environments are ignored with
   zero database access. Forged owners and conflicting message IDs cannot
   update status/suppression; storage failures return retryable 503. Replays
   keep the existing SQL transaction/deduplication gate. Preview missing its
   scope configuration fails closed before sending or processing callbacks.
   Unconfigured Production preserves legacy untagged callbacks, but discards
   scoped traffic rather than applying it through legacy message matching.
   Scope secrets must remain stable while submissions or retries are pending.
4. EXTERNAL BLOCKER: Resend callbacks and mail-client one-click unsubscribe requests cannot be
   assumed to pass Vercel Authentication. A shared-account webhook might also
   forward Production events. An approved isolated ingress must accept only
   the intended test events, verify the real Resend signature and deliver only
   to staging. Do not reuse the Production webhook secret, expose a shared
   Vercel bypass token, change existing endpoints, or turn protection off.

Resolve the external boundaries before creating/configuring a live key or webhook.
A transport-only send is not evidence that the tenant campaign path works.

## Exact dashboard and credential steps (not yet executed)

1. Supply an existing owner-controlled NON-PRODUCTION test domain and confirm
   its DNS administrator. Do not buy a domain or reuse/change `voom.today` DNS.
2. In Resend's team selector, select/create an isolated FREE test team/account
   (subject to the owner's consent/login). Confirm no Production domains,
   API keys, webhooks, recipients or paid plan are present. If the service
   cannot provide this isolation for free, stop rather than silently granting
   the staging server access to the Production provider account.
3. Domains → Add domain: enter that exact approved test domain, use the
   provider's actual SPF/DKIM records, and verify it. DNS values must be copied
   from the live provider page, never invented. Separately use VOOM Settings
   → Email identity → domain setup to obtain the synthetic business's own
   `_voom-email.<test-domain>` challenge; its DNS administrator must publish
   that exact TXT value. Provider verification alone is not ownership proof.

Resend → API keys → Create API key:

- Name: `VOOM PR105 staging acceptance`.
- Permission: **Sending access**, never Full access.
- Domain: **the approved test domain**, not All domains.
- Once the prerequisites above are resolved, enter the new secret through a
  hidden local prompt directly into `EMAIL_PROVIDER_API_KEY` scoped exclusively
  to **Preview → email-safety-staging**. Never paste it into chat or copy an
  existing key. Verify the new key's permissions in the dashboard without
  sending. Keep customer marketing policy OFF.
- Create a SECOND key, name `VOOM PR105 staging domains`, permission **Full
  access**, ONLY in that isolated test team/account. Securely enter it as
  `EMAIL_DOMAIN_API_KEY` in the same branch-only Preview scope. It cannot be
  limited to domain reads at Resend; the server capability restricts its use.
  Leave `EMAIL_DOMAIN_SETUP_ENABLED=false` when adopting an already verified
  provider domain. Do not reuse either Production/YouTube-alert key.
- Generate independent random `EMAIL_DELIVERY_SCOPE_SECRET` (>=32 characters)
  locally; set `EMAIL_DELIVERY_SCOPE=email-safety-staging`. Neither belongs in
  NEXT_PUBLIC variables, chat, browser storage or the repository.
- Any real staging webhook must have its own signing secret, stored only as
  that branch's `EMAIL_WEBHOOK_SECRET`, not the current synthetic secret.
- After callback access is independently proven, in the ISOLATED Resend team:
  Webhooks → Add webhook → endpoint ending `/api/webhooks/resend` on the
  protected email staging deployment only; events `email.sent`,
  `email.delivered`, `email.delivery_delayed`, `email.bounced`,
  `email.complained`, `email.failed`, `email.opened`, `email.clicked`.
  Do not add this endpoint to the shared Production Resend team. Never copy
  its Production signing secret. A Vercel project-wide automation secret must
  NOT be disclosed to Resend. A deployment/branch-specific share authorization
  is a candidate only after its exact scope and direct POST/no-redirect
  behavior are verified. If unavailable, stop for an approved staging-only
  ingress; do not make the full Preview public. Unsubscribe must also work
  without login, cookies or redirects; callback reachability alone is insufficient.
- Keep workers disabled and policy OFF. Once those external prerequisites
  exist, update ONLY the protected email staging Preview, recheck its actual
  runtime configuration, and run unsigned/synthetic callback checks before
  requesting explicit real-send approval. The existing hosted deployment
  still serves the previous PR head; local tests do not prove its new code.

## Controlled test proposal — separate explicit send approval required

1. Confirm an owner-controlled receiving inbox and a monitored owner-controlled
   Reply-To. `pavjassehgal@gmail.com` is a candidate, not an approved recipient
   for this test until the owner confirms. No customer contact lists.
2. Confirm the real sender identity/footer. A proposed From address is
   `staging-acceptance@<approved-test-domain>`, subject to approval. A verified domain does
   not prove this mailbox is monitored; use the confirmed Reply-To separately.
3. Use one synthetic staging owner, one consent-recorded contact and one short
   campaign: subject `VOOM staging delivery acceptance`; body explicitly says
   it is an owner-requested test, includes truthful sender details and the
   existing visible unsubscribe link. No sequence, schedule or cron activation.
4. Review exact sender, recipient, content and a maximum of one provider
   submission before requesting approval. Keep global/customer sending OFF;
   there is currently no approved one-shot exception. Any necessary narrow
   exception needs separate implementation/review, not a global policy toggle.
5. After separate authorization, verify inbox delivery, original headers,
   provider message ID, unique submission, authenticated delivery receipt and
   durable owner-scoped one-click unsubscribe. Observe only after an uncertain
   send; never resend to force a successful result. Negative bounce/complaint
   tests must use provider-documented test addresses or signed synthetic events,
   never third-party inboxes. Do not claim those are real customer deliveries.
6. Retain evidence and stop. No automatic retry, additional recipients or
   commercial activation. Revoke the dedicated key only when separately approved.

## References

- https://resend.com/docs/api-reference/api-keys/create-api-key
- https://resend.com/changelog/new-api-key-permissions
- https://resend.com/docs/api-reference/webhooks/create-webhook
- https://resend.com/docs/webhooks/introduction

Validation: 168 focused tests passed; TypeScript, targeted ESLint and production
Webpack build passed. Signed HTTP callbacks were exercised through the real
0073 SQL gate in isolated PGlite, including lost-response recovery, duplicate
receipts and owner-only complaint suppression. No migration changes are needed;
0073 SHA-256 remains fd153acd68062ff94167d9965bf6e6e0810e60078dc8b7ef32898435fc36fe26.
The build reported optional cache ENOSPC warnings but exited successfully; only
the generated Webpack cache in this worktree was removed to recover space.
No emails, provider sends, DNS writes, remote configuration changes or deployments occurred.
