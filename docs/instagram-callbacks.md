# Instagram deauthorize and data-deletion callbacks — design and operations runbook

Status: built and tested locally on `fix/instagram-callbacks-narrow` (from `main` 8c32c5f).
**Not merged, not deployed, migration 0078 not applied to staging or Production.**
This branch is opted out of Vercel Preview deployments (`vercel.json`), because the generic
Preview environment points at the Production database.

## 1. Responsible operator

| Role | Who | Access |
|---|---|---|
| Accountable deletion-request operator | **The VOOM owner** | Production Supabase SQL editor; the contact address already published on `/data-deletion` |
| Backup operator | **None designated.** No access is granted to Gurnoor or anyone else. | — |

**Final operational responsibility must be confirmed by the owner before Production
activation** (release step 4 below). Until then the callbacks stay off. If a backup operator
is later named, give them access deliberately and record it in `DECISIONS.md`.

## 2. What the callbacks do

Meta calls two VOOM URLs, configured in App Dashboard → Instagram → API setup with Instagram
login → Business login settings:

| URL | Behaviour |
|---|---|
| `https://voom.today/api/integrations/instagram/deauthorize` | Verify Meta's signature, record a receipt, disconnect every VOOM connection for that exact Instagram id (token row deleted, status `disconnected`). Answers `{"received":true}`. |
| `https://voom.today/api/integrations/instagram/data-deletion` | Same, then open a deletion case and answer `{url, confirmation_code}`; `url` is `https://voom.today/data-deletion/status?code=…`. |

Request contract (Meta's documentation): HTTPS `POST`, form field `signed_request` =
`base64url(HMAC-SHA256).base64url(JSON)`; payload `algorithm` = `HMAC-SHA256`, app-scoped
`user_id`, usually `issued_at`. Verification code is reused from the audited lifecycle work
(`4aeac7c`): constant-time signature check, canonical base64url, 8 KB cap, exactly one
`signed_request`, strict fields, keyed event fingerprint (Meta retries collapse to one
receipt), generic errors, nothing logged. Code: `lib/instagram/lifecycle.ts`.

### Configuration facts (read-only check of Production, 2026-11-23)

- `META_APP_ID` = `1798088134709951` = the **Instagram App ID** shown in Meta (parent Meta app
  is `2118633802394546`). `META_APP_SECRET` is the Instagram App Secret (live Instagram Login
  token exchange only works with that pair). Callbacks verify with it.
- If the first real callback is rejected (HTTP 400, no receipt), Meta signs with the parent
  app secret: set `INSTAGRAM_LIFECYCLE_FALLBACK_APP_SECRET` (verification only) and
  `INSTAGRAM_LIFECYCLE_PARENT_APP_ID=2118633802394546`. No code change.
- VOOM stores `GET /me` → `id` (documented as the app-scoped id) in
  `instagram_connections.instagram_user_id`. All 6 Production ids are 17-digit numbers, none in
  the `1784…` professional-account format. Matching is exact; a mismatch becomes `no_match`
  (never the wrong account). **Confirm with the first live callback.**
- `issued_at` present and the connection re-authorised later → that connection is left alone
  (`superseded`). Only a fresh connect changes `connected_at` (renewal and key rotation do not).

### How future actions stop (no publishing code changed)

Same effect as the user's own Disconnect. Publishing loads credentials through
`get_instagram_connection_secret` (needs a token row and `connected`); token renewal claims and
writes back only `connected` rows; insights/performance sync require `connected`. Other
Instagram accounts and other channels are untouched. A request already in flight holds a
token Meta has just revoked, so Meta rejects it.

## 3. Where Instagram-derived data lives (inventory)

| Data | Where | Handling |
|---|---|---|
| Access token | `instagram_connection_secrets` | Deleted automatically on receipt (deauthorize and deletion) |
| Profile: id, username, name, type, picture, scopes | `instagram_connections` | Scrubbed by the erase step (`erased`/empty, `disconnected`) |
| Insights and performance metrics | `instagram_insight_snapshots`, `instagram_performance_snapshots` | Deleted by the erase step |
| Pending OAuth state | `instagram_oauth_states` | Deleted by the erase step |
| Meta container/media ids on items that never published | `instagram_publish_queue`, `instagram_publish_jobs` | Cleared by the erase step |
| **Published post history** (Meta media id on published rows) | `instagram_publish_queue`, `instagram_publish_jobs` | **Manual review** (§5.3). A database rule requires a media id on a published row. |
| **AI-derived Instagram information** | `voom_campaigns.generated_summary` (includes MARA's `performanceNote`), `voom_campaign_generations.detail` (`performanceUsed` flag), `marketing_plans` (`recommendations`, `planned_posts`, `weekly_strategy`), `mara_messages.content` (MARA replies that quoted results) | **Manual review** (§5.4). Generated text that may summarise the account's Instagram results. |
| AI usage records | `ai_usage_operations` | Cost metadata only (provider, model, tokens, cost). No prompts or content. Keep. |
| User-authored content | `mara_drafts`, captions, `instagram_media_assets` (uploads) | Kept: the user's own content, not Meta data (delete only if the user asks for full account deletion). |
| External processors | Groq, OpenRouter, Vercel, Supabase | §6 |
| Backups | Supabase backups | §7 |

## 4. Daily open-case check (operator)

Every day while any case is open (and at least weekly otherwise), run in the Production SQL
editor:

```sql
select confirmation_code, kind, status, created_at::date received,
       cardinality(matched_owner_ids) matched, cardinality(superseded_owner_ids) superseded,
       data_erased_at::date erased
from public.instagram_callback_receipts
where status in ('no_match', 'awaiting_erasure', 'awaiting_review')
order by created_at;
```

Target: finish each deletion case within the time stated on `/data-deletion`. There is no
automatic alert yet; this check is the control. Record each case in a private case log kept
outside the database (spreadsheet or notes): case reference, confirmation code, dates, each
check's result and evidence. Never put emails, Meta payloads or customer content in the
database `review_reference`.

- `no_match` (deauthorize): Meta's id matched no connection. Check whether the id format
  differs from stored ids (§2) and whether a connection should have been disconnected. If
  yes, disconnect it from the app's normal Disconnect and note it in the case log.
- `awaiting_erasure` / `awaiting_review`: continue §5.

## 5. Deletion procedure

### 5.1 On receipt (automatic)
Token deleted, connection disconnected, case `awaiting_erasure`. Status page: received, in
progress, not complete.

### 5.2 Erase (operator)
```sql
select public.erase_instagram_deletion_data('<confirmation_code>');
```
Deletes/scrubs the rows marked "erase step" in §3 for each matched VOOM owner and returns
counts. It refuses and changes nothing if the owner reconnected Instagram after the request,
or a newer authorisation was superseded — then decide by hand which data belongs to which
authorisation and record it. Case → `awaiting_review`. Status page: active data removed,
verification pending, not complete.

For an unmatched deletion (`matched = 0`), first search for the account by other means (for
example the user's message or a different id format). If found, resolve the match in the case
log and handle that VOOM owner's data by hand with the same tables as §3.

### 5.3 Published post history (operator)
```sql
select id, status, published_at::date from public.instagram_publish_queue
where owner_user_id = '<owner>' and status = 'published';
```
Decide with the request: either delete those queue/job rows (the post on Instagram is the
user's; VOOM's copy of Meta's media id is Platform Data), or keep VOOM's own publish record
without Meta identifiers by deleting the rows and keeping the user's draft. Record the
decision and row count in the case log.

### 5.4 AI-derived Instagram information (operator)
Search the owner's generated records for text that summarises Instagram results:
```sql
-- Campaigns whose generation used Instagram performance evidence:
select g.campaign_id, g.created_at::date from public.voom_campaign_generations g
where g.owner_user_id = '<owner>' and (g.detail ->> 'performanceUsed')::boolean is true;
-- Their stored summaries (the performance note is part of generated_summary):
select id, generated_summary from public.voom_campaigns
where owner_user_id = '<owner>' and generated_summary is not null;
-- Plans and MARA replies that may quote results:
select id, recommendations, weekly_strategy from public.marketing_plans where owner_user_id = '<owner>';
select id, created_at::date from public.mara_messages
where owner_user_id = '<owner>' and role = 'assistant'
  and content ~* '(reach|impressions|views|likes|engag|followers|top post|insight)';
```
Remove or redact performance statements (the performance sentence in `generated_summary`,
plan recommendations or rationale quoting reach/likes/top posts, MARA replies quoting
results). Record what was changed. If unsure whether a sentence is derived from Instagram
data, remove it.

### 5.5 External processors (operator)
See §6. Confirm nothing beyond the processors' own retention remains and note each
provider's retention term in the case log.

### 5.6 Backups (operator)
Determine the date by which Supabase backups containing the deleted data are overwritten
(depends on the Supabase plan's backup/PITR retention; check Project Settings → Backups).
Use that date as `backups_clear_by`.

### 5.7 Complete (operator, only with evidence)
Evidence required in the case log **before** completing:
1. identity: which VOOM owner(s) matched and why (or the no-data search result);
2. erase summary counts from §5.2;
3. published-history decision and counts (§5.3);
4. AI-derived records reviewed and what was removed (§5.4);
5. processor retention notes (§5.5);
6. backup clear-by date and its source (§5.6).

```sql
select public.complete_instagram_deletion('<confirmation_code>', 'VOOM owner',
  '<case-ref e.g. IGDEL-2026-001>', true, true, true, '<backups clear-by date>');
```
The three booleans are: identity reviewed, publishing history reviewed (§5.3), processors and
AI-derived records reviewed (§5.4–5.5). The function refuses unless erasure ran, all three are
true, a reviewer and an opaque reference are given, and the backup date is not before the
erasure date. On completion the Instagram id is removed from this receipt and from the
person's other receipts (for example the deauthorize receipt), except another deletion for the
same id that is still in progress, which keeps it until its own completion. The status page
then says completed with the backup date. Never complete to "close" a case early.

## 6. External processors and retention

| Processor | Instagram-derived data it may receive | Obligation / check |
|---|---|---|
| **Groq** (Production text AI: planning, captions, recommendations; model `openai/gpt-oss-120b`, observed in `ai_usage_operations`) | Aggregated performance context in MARA prompts | Check Groq's current data-retention terms; VOOM stores no prompts. |
| **OpenRouter** (Production media AI: `bytedance-seed/seedream-4.5`, `bytedance/seedance-2.0-mini`; `MEDIA_PROVIDER=openrouter`) | Visual prompts written by the text AI, which may be shaped by performance hints (no metrics or ids) | Check OpenRouter's and the routed model provider's retention terms. |
| Vercel | Request processing; the callbacks log nothing | Platform log retention. |
| Supabase | Database and backups | §7. |
| Resend, Cloudflare | Not used for Instagram data (email delivery; YouTube deletion record) | None for Instagram. |

`AI_PROVIDER`, `AI_MODEL` and `AI_BASE_URL` are sensitive in Vercel and could not be read;
the provider identity above is from Production usage records (what actually ran).

## 7. Backup restoration and re-applying deletions

Instagram has no deletion record outside the main database (YouTube has one at Cloudflare).
If the Production database is ever restored from a backup or point-in-time:

1. Before serving traffic, compare the restored `instagram_callback_receipts` with the
   private case log.
2. For every case in the log that is missing or less advanced in the restored database,
   re-apply: disconnect the matching connection(s) (app Disconnect), re-run the erase step
   and the §5.3–5.4 removals, then complete again (a new confirmation code may be needed;
   note the mapping in the case log).
3. Record the restore and every re-application in the case log and `DECISIONS.md`.

The case log is therefore the authoritative record and must be kept outside Supabase.

## 8. Configuration (Production only; off until release)

| Variable | Value |
|---|---|
| `INSTAGRAM_LIFECYCLE_ENABLED` | `on` to activate; anything else → callbacks and status page answer 503 |
| `INSTAGRAM_LIFECYCLE_APP_ID` | `1798088134709951` (must equal `META_APP_ID`) |
| `INSTAGRAM_LIFECYCLE_PUBLIC_ORIGIN` | `https://voom.today` |
| `INSTAGRAM_LIFECYCLE_FALLBACK_APP_SECRET` | empty unless the live test proves parent-secret signing |
| `INSTAGRAM_LIFECYCLE_PARENT_APP_ID` | empty unless used with the fallback secret |

Preview/development deployments always refuse (503) even if enabled.

## 9. Release sequence (each step separately authorised)

1. Owner commits and pushes the branch; pull request and review.
2. Optional: rehearse 0078 on staging (`qcdpegwjofrqnfudyrqq`, hash-verified, synthetic checks
   inside a rolled-back transaction).
3. Production SQL editor: apply 0078 (hash-verified, single transaction), add the ledger row
   (`0078`, `instagram_callback_receipts`), verify table, RLS, functions and grants.
4. Owner confirms the accountable operator (§1). Vercel Production env: the three values in §8.
5. Merge to `main` → Production deploy. Smoke: unsigned POST → 400; GET → 405; random status
   code → 404; `/data-deletion` → 200; next Instagram cron → 200.
6. Meta Business login settings: enter the two URLs (not the App Review draft).
7. Live test (owner approval; disconnects a test account): remove VOOM from a test Instagram
   account; check with
   ```sql
   select kind, status, cardinality(matched_owner_ids) matched,
     subject_id = (select instagram_user_id from public.instagram_connections where owner_user_id = '<test owner>') id_matches
   from public.instagram_callback_receipts order by created_at desc limit 3;
   ```
   400 and no receipt → fallback secret (§2). `no_match` → id mapping differs (§4). Reconnect.
8. Submit the Meta App Review.

## 10. Rollback and recovery

- Fast stop: `INSTAGRAM_LIFECYCLE_ENABLED=off` + redeploy (or Vercel Instant Rollback); clear
  the two Meta URLs. Callbacks answer 503/404 and Meta retries later. Open cases stay intact.
- Schema: `supabase/rollbacks/0078_instagram_callback_receipts.sql` refuses once any receipt
  exists (receipts are evidence of acknowledged requests); otherwise leave the table — it is
  inert while disabled. Then remove the ledger row only if the rollback ran.
- Disconnects are never undone; people reconnect from Channels.

## 11. Tests

`tests/instagram-callbacks.test.mjs` (embedded PostgreSQL with every real migration):
signatures, malformed bodies, missing fields, configuration, duplicates, superseded and
missing `issued_at`, unmatched, multiple owners, other tenants untouched, renewal/credential
paths blocked, deletion state machine and refusals, browser roles denied, rollback, status page.
Not covered: true concurrent sessions on native PostgreSQL, and a real Meta-delivered callback.
