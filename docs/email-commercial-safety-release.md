# Customer email commercial safety — release and acceptance

This is an implementation candidate, NOT hosted/live commercial acceptance.
No real email, DNS mutation, provider configuration or Production database
change is part of local validation. No paid service is introduced. This work
is independent of YouTube compliance migrations 0065/0069 and Cloudflare.

## Implemented boundaries

- A provider's shared verified-domain list is no longer business authorization.
  Each owner gets a distinct `_voom-email.<domain>` TXT challenge. Pending
  challenges do not squat domains. Proof of that exact challenge is required
  before binding a provider domain ID. A serialized database guard excludes
  cross-owner exact/parent/subdomain overlap. Existing verified domains are NOT
  silently grandfathered or transferred. At most three claims per owner.
- Owner-authenticated/origin-checked setup shows the real provider SPF/DKIM DNS
  records. It creates/adopts a provider domain only after independent ownership
  proof; it never modifies DNS, upgrades a provider plan, rotates credentials,
  or sends an email. Unsupported provider permissions/capacity fail closed.
- Every marketing send rechecks DNS, exact provider domain ID/name/status,
  sender identity, approval/owner activation, stored recipient consent and
  suppressions. Missing schema, failed lookups or missing legal/business name,
  postal address and reply contact block sending. Managed-address fallback is
  preview-only, never commercial authorization.
- Contacts have timestamped, append-recorded owner consent attestations. CSV
  unknown consent remains unknown. Existing subscribed preferences are kept
  but are not retrospectively assigned evidence. Address changes reset consent.
  Attestation is NOT double opt-in or legal proof that a recipient consented;
  the business remains responsible for its source records and lawful list.
- Campaigns and lifecycle sequences share a durable submission gate, immutable
  payload fingerprint and stable provider key. Lost responses, 5xx, missing IDs,
  crashed submissions or failed result persistence never authorize a second
  provider POST. Only definitive rejections may retry, identical payload/key,
  one-minute cooldown, max three attempts, within 23 hours. Provider keys expire
  after 24 hours, so later retries require review, not a new key.
- Provider-signed delivery tags can reconcile a lost response to its original
  source. Webhook status and suppression writes are atomic. Failed processing
  returns 503. Unmatched legacy/transactional callbacks are durably received but
  NOT marked processed or delivered. The existing email cron reconciles only
  matchable pending receipts (50/pass); unrelated callbacks cannot starve them.
- Visible unsubscribe URLs remain. RFC8058 headers use an HTTPS form-POST
  endpoint requiring only the signed URL token, no login/cookies/redirect. It
  returns empty 200 only after durable suppression succeeds; failures return
  503. JSON processing used by the existing visible page remains compatible.
  The visible page requires an explicit unsubscribe click; GET/link scanners
  cannot change a subscription.
- Defaults: **sending disabled**, per-business 50 attempted submissions/UTC day,
  500/UTC month; provider-wide 90/day, 2700/month. Attempts include explicit
  rejected retries; these are safety allowances, NOT customer credit charges.
  Global new-submission spacing is >=1 second. All marketing Resend API calls
  are independently limited to <=2/second across serverless instances, with
  bounded outside-transaction waiting. A complaint or five distinct bounced
  addresses/24 hours suspends ONLY the affected business pending operator review.
  These defaults need operator approval; they do not read live provider usage
  or reserve capacity for unrelated systems. Shared transactional/inbound usage
  must be included when approving the overall provider budget.

## Staging approval and acceptance required

1. Review 0073 checksums/schema against isolated staging. It requires existing
   email migrations 0018–0044 and current main; no 0065/0069 dependency. Apply
   ONLY 0073 transactionally after checking backups, locks and active email
   claims. Migration changes no existing subscriptions, drafts, campaigns,
   preferences, provider credentials, schedules or credit ledger entries.
2. Keep sending OFF and providers mocked initially. Validate RLS with two
   authenticated businesses, direct-write denial, DNS claim conflicts, missing
   schema/read failures, counters, worker/approval races and receipt recovery.
   Local PGlite tests exercise actual SQL but are NOT multi-connection hosted
   concurrency proof. Hosted concurrent sessions remain a release gate.
3. Confirm the approved business's real sender/legal information and consent
   source records. Configure the existing server-side Resend permission for
   domain management if absent; do not expose keys to customers. Keep
   `EMAIL_UNSUBSCRIBE_SECRET` stable and site URL HTTPS. Preserve existing
   transactional credentials. No new signing secret/service is required.
4. Obtain separate approval for a protected, staging-only Preview and controlled
   provider acceptance using owner-controlled recipients. This feature branch
   opts out of inherited Vercel Git previews. Do not deploy it against generic
   Preview credentials. Verify actual SPF/DKIM/DMARC, headers, inbox delivery,
   unsubscribe, bounce/complaint events and uncertain-result recovery before
   describing the feature as commercially verified.

## Production rollout (NOT authorized by this document)

1. Back up and drain in-flight marketing requests; get explicit migration and
   deployment approval. Migration 0073 defaults OFF and blocks new campaign/flow
   claims in both old and new code. Already-dispatched emails cannot be recalled.
2. Apply ONLY 0073, verify all introduced objects/grants, unchanged customer
   fingerprints/schedules, and the OFF claim guard. Do not apply 0065/0069.
3. Deploy reviewed application code; keep OFF until every active runtime uses
   the safety gate. Old application versions do not implement the final gate.
4. Verify operator-approved quotas, provider account allowance/overage policy,
   verified business ownership, real footer information, customer consent and
   webhook processing. Only then explicitly enable marketing sending and run a
   separately approved controlled live acceptance. Never activate customer flows
   or rewrite preferences merely to test the release.

## Recovery and rollback

Keep uncertain submissions and receipts. Never clear a source/key, create a
replacement campaign or retry an uncertain email to force it through. Use the
provider's message reference and signed callbacks; investigate unmatched cases
without resending. Rejection retries stop before the provider's dedupe expires.

Use `enabled=false` as the safe application/claim stop, after explicit approval.
Do not blindly roll back application code after enabling sends: older code lacks
these boundaries. Do not drop 0073 tables or columns containing consent evidence,
domain ownership, submission meters or webhook receipts. Schema rollback is
permitted only before use and with a reviewed guarded script; a forward repair
is preferred once any real evidence exists. No automatic rollback is performed.

Operational confirmations still required: real sender addresses, consent
documentation, approved limits/overages, who monitors suspensions/unmatched
receipts, handling deadlines and retention for new consent/delivery evidence.
No personnel, legal identities or retention promises are invented here.

## Official references

- https://resend.com/docs/api-reference/domains/create-domain
- https://resend.com/docs/api-reference/domains/get-domain
- https://resend.com/docs/api-reference/domains/verify-domain
- https://resend.com/docs/dashboard/emails/idempotency-keys
- https://resend.com/docs/dashboard/emails/add-unsubscribe-to-transactional-emails
- https://resend.com/docs/webhooks/emails/sent
- https://resend.com/pricing

## Local validation evidence

237 focused tests passed across the commercial-safety, branded-email,
sequence, contacts/audiences, campaign-delivery and provider-security suites.
These include the actual migration/RPCs in isolated PGlite: owner isolation,
claim/consent restrictions, duplicate requests, uncertain provider outcomes,
failed persistence, quotas, atomic webhook recovery and RLS/privileges.
Provider requests are mocked; no real email or customer data is involved.
TypeScript and targeted ESLint pass (one existing image warning).
The production Webpack build passes. The default Turbopack build encounters
this execution environment's local-port permission restriction; no product
configuration was changed to suppress it. Hosted concurrency, DNS/provider
permissions and live deliverability remain explicitly unverified.
