# Branded Email Engine v1 — Delivery Report

**PR:** https://github.com/pavjassehgal-commits/voom-real/pull/50 (open — **not merged**, per instructions)
**Head SHA:** the PR's latest commit (this report is part of the branch); the engine code itself landed in `128c4eb7b5a149bb25f61656084271d90dabab3c`
**Branch:** `arena/01a0b49a-voom-real` (from `main` @ `15895219e6a34746284d2359c276720f4d7403a0`)
**Live-traffic safety:** no email sent, Email #2 not triggered, cron untouched, delivered Email #1 untouched, migration 0040 untouched, 0041 not applied anywhere by this work.

---

## 1. PR URL and head SHA

- PR: **https://github.com/pavjassehgal-commits/voom-real/pull/50**
- Head: **`128c4eb7b5a149bb25f61656084271d90dabab3c`** (single commit on `arena/01a0b49a-voom-real`)

## 2. Root cause (confirmed by audit, not guesswork)

Both send paths built `from` from the global env (`EMAIL_FROM_NAME` / `EMAIL_FROM_ADDRESS` = production "Voom") via `lib/email/core.ts`:
- `lib/email-flows/send.ts` (lifecycle flows) — global `from`, text-only.
- `lib/voom/campaign-delivery.ts` `sendEmailCampaign` — global `from`, text-only.

Not the database, not Resend's default domain — a hardcode. Secondary findings from the audit: no rendered unsubscribe link existed anywhere (only a plain-text line via `ensureUnsubscribeFooter` — the "claimed a link without rendering one" bug, confirmed and now fixed); campaign sends had no per-attempt provider idempotency key; the single-recipient campaign path never re-checked suppressions server-side.

## 3. Sender architecture

One resolver (`lib/email/branded/identity.ts`), one decision, used by every send and every preview:
- Input: stored identity row (0041 `voom_email_identities`) + business display name + provider domain state.
- Output: `From: "<display name> <address>"`, `Reply-To`, and a mode of `business_verified` or `voom_fallback`.
- `From display name` / `From email` / `Reply-To` are three distinct fields end to end (DB columns, PATCH API, settings UI, payload).

## 4. Verification & fallback (no spoofing)

- `getProviderDomainStatuses` reads **Resend's own `GET /domains`** response (`status: verified | pending | failing`). It is the **only** writer of "verified".
- The business's `from_address` is used **only** when the provider reports its domain `verified` **at resolve time**. A tampered/stale stored `verification_status` is ignored (covered by test 1b: stored `verified` + provider silence ⇒ still fallback).
- Unverified ⇒ `voom_fallback`: **Voom-managed address + business display name** (e.g. `SynraPay <hello@voommanaged.example>`). No invented fallback domains; the fallback is exactly what the existing Resend config supports.
- Provider unreachable/client without a request surface ⇒ fail safe to unverified (never verified) with **zero** network calls in the injected-seam case.

## 5. Brand profile

`loadEmailBrandProfile` (brand.ts) assembles one authoritative profile from existing business data + 0041 tables: name/description/industry/tone (from `businesses`), logo/primary/secondary colors/website/footer line (`voom_email_brands`, logo FK → `voom_email_assets`), ready assets. Missing 0041 tables degrade to a neutral business-only profile — no competing sources of truth. Only real social/contact data may be entered (owner input; nothing fabricated by Voom).

## 6. Renderer & templates

`renderer.ts`: one deterministic 600px table-based renderer — inline CSS, `<style>` + media query for ≤620px, Gmail/Outlook-conscious (bgcolor, role=presentation, MSO-friendly), hidden preheader, alt text on every image, no JS. Layout families (exactly 5, not 50): **welcome, announcement, product, editorial, minimal** — chosen deterministically (flow type → objective keywords → imagery → minimal default) with an explainable reason string.

## 7. MARA design (structured, validated)

`design.ts` defines the exact zod `.strict()` schema (layout, subject, preheader, headline, sections ≤8 **text-only — there is no html field on purpose**, `cta{label,url|null}`, heroAssetId, tone, visualEmphasis). `validateEmailDesign` refuses unknown fields, html sections, non-allowlisted CTA URLs, unknown assets. `acceptProposedDesign` layers the proposal over the stored copy; any refusal ⇒ deterministic compiler output. MARA can never emit final HTML.

## 8. CTA

Real designed button (bgcolor + inline-styled anchor + visible destination line). Destinations allowlist (`allowedCtaUrls` in dispatch.ts): **the business's configured website + the explicitly configured `cta_url` for this exact send** (campaign column / flow step). Nothing invented; invalid URLs never enter the allowlist; no valid destination ⇒ the reply-oriented non-link action ("Reply to this email — a person will answer").

## 9. Images

Priority honored: published business email assets → (draft asset copy path, owner-checked) → nothing. Zero automatic paid-media generation — the engine contains no image-generation call at all, and the engine test pins this for the flow path. No image ⇒ clean brand-color text layout (verified: no `<img>` rendered without a real asset).

## 10. Unsubscribe (real, working)

- Token: `base64url("v1:<ownerId>:<email>")` + HMAC-SHA256 (key: `EMAIL_UNSUBSCRIBE_SECRET`, falling back to `SUPABASE_SECRET_KEY`), deterministic per owner+address, constant-time compare.
- Links: `NEXT_PUBLIC_SITE_URL` (or request origin) `/unsubscribe?token=…` — rendered in **HTML and plain text** (guard-enforced).
- Processing: public page (no login) → `POST /api/unsubscribe` → verify → `record_email_unsubscribe` RPC (service-role only, idempotent) → durable suppression + `contacts.email_status='unsubscribed'`.
- Tampered/forged/malformed tokens refused with distinct honest messages (test 5b). No secret configured ⇒ `unsubscribe_unavailable` — the send is refused rather than shipping a dead link (test 5c).

## 11. Campaign integration

`sendEmailCampaign` now prepares + dispatches through the shared engine with the durable claim's idempotency key as the provider-side dedupe key. Delivery route: suppression check **before** recipient write (409, single-recipient gap closed), approval gate unchanged, 422 needs-attention with the exact failure list on guard hits, audience loop stops entirely on a guard failure (same content ⇒ same result for everyone). Lifecycle states, claim RPCs, and webhook truth (`delivered` only from verified webhook) unchanged.

## 12. Flow integration

`sendFlowEmail` (adapter, same name as before) now fronts `prepareBrandedSend` + `dispatchBrandedEmail`; the engine feeds subject/body/preview/cta/ctaUrl from the frozen snapshot with safe defaults for missing fields. Guard/sender/unsubscribe failures are **terminal** (run failed, no retry — resending can't fix malformed content); provider failures keep the existing bounded retry and `HTTP_<status>` error codes.

## 13. Preview UX

Shared `EmailPreview` component (desktop/mobile toggle, plain-text toggle, sender block with truthful verification badge, quality-guard items) embedded in **both** the flow modal (per step, live on unsaved drafts) and the campaign editor (draft-aware). Backed by GET (saved) + POST (unsaved) preview routes that call **the same `prepareEmailPreview` pipeline as production** — one renderer, one resolver, one guard. No second fake preview exists.

## 14. Migration

`0041_branded_email_engine.sql` — additive only: 4 tables (`voom_email_identities`, `voom_email_assets`, `voom_email_brands`, `voom_email_unsubscribes`), `voom_campaigns.cta_url`, public `voom-email-assets` bucket, RLS (authenticated = select-own only; service_role full), 6 service-role-only security-definer RPCs (`upsert_email_identity` cannot set verified; `record_email_identity_verification` is the only verification writer; `create/remove_email_asset`, `upsert_email_brand`, `record_email_unsubscribe`). 0040 never modified; PGlite auto-applies 0041 in tests (proven in the 26-test pglite suite). **0041 has NOT been applied to production by this work.**

## 15. Tests & gates

- New: `tests/branded-email-engine.test.mjs` — 33 behavioural tests, zero network (fetch asserts), covering spoofing/fallback/reply-to, renderer, MARA validation, personalization, unsubscribe (real/tampered/forged/unconfigured), assets (ownership/magic-bytes/rollback/no-leak), campaign+flow byte-identical pipeline, guard fail-closed.
- Existing: email engine 25/25, flows 24/24, flows-pglite 26/26, campaigns/audience/delivery/security/truthfulness suites all green (220+ assertions across the email/campaign surface).
- `npm run typecheck` ✓ · `git diff --check` ✓ · lint: **40 errors on branch = 40 errors on main (identical pre-existing set)**, 0 new errors, 1 new warning (`<img>` thumbnail).
- Full-suite comparison (per-file runner vs a real `main` worktree): the branch's failing file set is **identical to main's pre-existing set** (13 failures + 1 pre-existing hang in media/workflow/post-studio suites, all in modules this PR never touches). Two pins were updated where this change legitimately supersedes them: `CAMPAIGN_COLUMNS` (+`cta_url`) and "0041 is the newest migration" (the pglite test now also enforces 0041's additive/owner-scoped guarantees).
- Zero real Resend/Meta/OpenRouter/Seedream/Seedance calls; zero media credit reservations — including in tests (injected clients everywhere; `fetch` throws).

## 16. Email #2 impact (exact)

Email #2 (scheduled **2026-09-20 ~09:06 Dubai**, SynraPay welcome, contact Pavjas):
- **Content**: unchanged — the content snapshot was frozen at claim (0040 semantics); this PR does not touch run rows or rewrite history. The stored subject/body (`revision` enrolled at signup) is what it always was.
- **Presentation**: at send time it will be prepared by the new engine — From `SynraPay <…>` **only if** the synrapay domain is provider-verified by then, otherwise `SynraPay <Voom-managed address>`; branded responsive HTML + plain text; real unsubscribe link (requires `EMAIL_UNSUBSCRIBE_SECRET` to be set in production before then — flagged in `.env.example`).
- **Safety**: it will not fire early or at all unless the (still unconfigured) cron runs; nothing in this PR triggers, reschedules, or rewrites it. Delivered Email #1 is untouched.

## 17. Deferrals (explicitly out of scope, per brief)

SMS/WhatsApp/push (permanent), drag-and-drop editor, arbitrary HTML editor, dozens of templates, automatic paid image generation, Campaigns v3, billing changes. Deferred with the platform: provider-side webhook-driven verification sync into `record_email_identity_verification` (today the UI shows live provider state on read; the stored hint column awaits a scheduled checker), per-domain DNS instruction surfacing (owner follows the provider's dashboard for now), List-Unsubscribe headers (RFC 8058 one-click) — the signed URL is ready to be reused there.

## 18. Operator notes for go-live

1. Apply migration 0041 (additive; verified applying cleanly on PostgreSQL via PGlite).
2. Set `EMAIL_UNSUBSCRIBE_SECRET` (long random string) — without it the engine **refuses to send** by design.
3. Verify the business sending domain in the Resend dashboard; the settings card will flip to "Verified" from live provider state — never from manual claims.
4. The email-flow cron remains deliberately unconfigured (unchanged decision — activating it starts the live welcome flow including Email #2).
