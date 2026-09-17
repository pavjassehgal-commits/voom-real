# Voom

Voom is a marketing platform for small businesses. MARA, its AI marketing
manager, plans, drafts, and reports on campaigns on the business's behalf.

Voom runs on Next.js (App Router) with the approved Voom visual identity
(ink/dark background, signal-orange accent, deep-teal support colour). The
authenticated product is backed by Supabase: a rolling marketing plan, an
approvals board, a content calendar, Instagram publishing, contacts,
campaigns and truthful delivery tracking.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Other scripts:

```bash
npm run lint    # ESLint
npm run build   # production build
npm run start   # serve the production build
```

## Environment variables

Copy `.env.example` to `.env.local` and fill in values as integrations are
added. `.env.example` only contains placeholder variable names — never commit
real secrets. `.env`, `.env.local`, and other secret env files are gitignored.

```bash
cp .env.example .env.local
```

## Project structure

```
app/
  layout.tsx        Root layout — fonts (Bricolage Grotesque, Public Sans), metadata
  globals.css        Design tokens (colours, brand gradient) and Tailwind entry
  page.tsx            /       — landing placeholder
  login/page.tsx      /login  — login placeholder (no auth wired up)
  app/page.tsx        /app    — dashboard placeholder
  components/
    Logo.tsx          Shared Voom wordmark used across pages
reference/
  Voomprot2.html      Approved product-flow and visual reference (do not edit,
                        do not use as the architecture for this app)
```

## Status

- Framework: Next.js (App Router), TypeScript, Tailwind CSS, ESLint
- Supabase auth + data (RLS owner-scoped), Instagram publishing, OpenRouter
  media generation with Magic Hour fallback, Resend/ClickSend campaign
  delivery with verified callbacks
- Asynchronous video jobs are polled server-side by
  `/api/cron/media-generation` every two minutes through the existing Supabase
  Cron/Vault pattern. The browser only refreshes display state; it is never the
  provider lifecycle owner. The route polls persisted provider job ids only,
  stores validated MP4s, and enforces the 30-minute `provider_timeout`.
- Lifecycle **Email Flows** (Email Automation v2) run alongside Campaigns and
  standalone emails: persistent rules that greet a new subscriber or re-engage
  an inactive one, proposed by MARA inside deterministic safety limits and
  activated only by the business owner
- Not yet implemented: Stripe billing, paid advertising connections. The UI
  says so truthfully instead of simulating them
- No demo/sample data ships in the product: every screen renders real account
  data or an honest empty state

### MARA Campaign Intelligence (Campaigns v2)

Campaign creation is now *"tell MARA what you want to achieve → MARA designs the
campaign → you review it → Voom executes it according to your automation mode"*.

The pipeline is strictly one-directional:

```
deterministic skeleton  →  MARA intelligence  →  validated structured plan
```

`lib/campaign/planner.ts` (v1, unchanged) remains the **only** authority on
structure: the date range, the action count (`MAX_CAMPAIGN_ACTIONS`), the
channels (Email + Instagram Post/Reel/Story only), the allowed action types and
the per-day timing boundaries. MARA fills strategy and content **inside** that
structure and can never add, drop, re-channel or re-date an action — LLM output
is never inserted as-is.

- **Provider**: the existing MARA text provider (`@/lib/ai`, the same
  OpenAI-compatible/Groq adapter used by the chat, weekly plan and Post Studio
  flows) with strict `json_schema` structured output. No second AI provider was
  added, and no media provider is reachable from campaign generation.
- **Validation**: `campaignIntelligenceSchema` (zod) is the second safety layer
  on every response. Per action, `applyCampaignIntelligence` refuses content
  that duplicates another action's copy, a Reel with no script, a proposed time
  outside the slot's own campaign day, or a CTA repeated across the campaign —
  and substitutes the deterministic v1 draft for that action only. Autopilot
  safety blockers are re-evaluated on the final merged content.
- **Strategy**: stored on `voom_campaigns.strategy` / `strategy_summary` /
  `generation_source`, shown as a compact **"MARA's approach"** block. No AI
  essays are surfaced.
- **Fallback**: if the text provider is not configured, fails, or returns
  anything unusable, the deterministic v1 plan is used unchanged
  (`generation_source = 'deterministic'`) and the campaign is still created.
  Every build and every regeneration writes exactly one
  `voom_campaign_generations` row, idempotent on its key.
- **Performance Intelligence** is passed to MARA only when
  `buildPerformancePlanContext` returns real evidence (≥ 3 measured published
  items). It is advisory: the deterministic mix is identical with and without
  it, and no performance section is invented when the data is absent.
- **Editing / regeneration**: `PATCH …/actions/[actionId]` edits one draft
  (email subject/preview/body/CTA/time; Instagram concept/hook/caption/time)
  and `POST …/actions/[actionId]/regenerate` asks MARA to rewrite that one
  draft. Both go through the guarded `update_campaign_action_content` RPC,
  which refuses an action with a real send in flight/completed or an Instagram
  queue row that is publishing or published, never duplicates the action, never
  touches another action, and is a no-op when its idempotency key is replayed.
- **Safety is unchanged**: campaign generation sends no email, enqueues no
  Instagram publish, submits no Seedream/Seedance job and spends no media
  credit in any mode. Paid media stays behind the central
  `guardAndReserveMedia` entitlement/credit guard (Autopilot + Max plan +
  toggle + credits + safety).

Requires migration `0036_mara_campaign_intelligence.sql` (additive: two new
nullable campaign columns, two new action columns, the generation audit table
and the guarded content writer).

### Performance Intelligence (v1)

Voom reads Instagram performance metrics only for content it has already
published and Meta has confirmed with a real media id
(`instagram_publish_queue.status = 'published'`). Readings are normalized into
`public.instagram_performance_snapshots` (migration
`0032_instagram_performance_intelligence.sql` — additive, owner-scoped RLS) and
drive the Performance page, the single Today insight, and the advisory
performance evidence MARA receives when it plans the next rolling 7 days.

To collect them in Production, add one Supabase Cron job that calls
`/api/cron/instagram-performance` with `Authorization: Bearer <CRON_SECRET>`
(a few times a day is enough; the collector is idempotent per hour-long window).
This route is deliberately not in `vercel.json` and is not scheduled by the
repository — the existing Instagram publishing worker keeps its five-minute
cadence, unchanged. The collector only reads: it never publishes, never edits
media or captions, and never starts a generation.

Per-media insights (reach, views, plays, saves, shares, interactions) require
Meta's `instagram_business_manage_insights` permission, which Voom now asks for
at connect time alongside the existing permissions — enable it for the app's
Instagram use case in the Meta dashboard, and note that connections made before
this change must reconnect once to grant it. When the stored connection does not
include it, the collector still stores the real media-node metrics (likes,
comments) and reports every unread metric as unavailable — it never invents a
value, and never stores a zero.

### Email Automation v2 (Lifecycle Flows)

A **Flow** is a persistent rule; a **Campaign** is a finite mission. They are
separate in the schema, the API and the UI — a flow is never turned into a
campaign, and it never borrows `voom_campaigns` or `campaign_recipients`.

Two flow types ship: **Welcome** (trigger: a contact becomes newly eligible) and
**Re-engagement** (trigger: an eligible contact Voom has not emailed for the
inactivity period you choose). New trigger types are added by extending the
registry in `lib/email-flows/policy.ts`; the engine does not change.

The pipeline is strictly one-directional, exactly like Campaigns v2:

```
deterministic skeleton  →  MARA intelligence  →  validated structured flow
```

`buildFlowSkeleton()` is the only authority on structure (step count, order,
waits, trigger, re-entry). MARA fills the writing inside it through the existing
text AI provider, and every field is schema-validated and safety-checked before
it can be stored. If MARA fails, times out, is rate-limited or returns an
unusable shape, the flow is still created from the deterministic copy — flow
creation never depends on a provider.

Rules that hold in every automation mode:

- **Consent is authoritative and fails closed.** Only an explicit `subscribed`
  status with a valid, unsuppressed address may enroll, and consent is
  re-checked immediately before *every* send. An unsubscribe mid-flow blocks the
  next email and stops the enrollment.
- **Activation belongs to the owner.** Manual never creates a flow on its own;
  Assisted and Autopilot may *propose* a draft, and no policy authorises
  automatic activation — so Autopilot fails closed and leaves the flow
  proposed, waiting for approval.
- **Provider acceptance is not delivery.** A Resend `accepted` response is
  recorded as accepted; only a verified Resend webhook can set `delivered`.
  A bounce or complaint suppresses the address for every future send.
- **Sending is owned by exactly one worker.** Each step run carries a durable
  idempotency key and a claim lease, and the same key is passed to Resend as its
  `Idempotency-Key` header. A duplicate or delayed cron tick cannot double-send.
- **Retries are bounded** (three attempts), after which the run fails, the
  enrollment stops, and the flow surfaces as needing attention.
- **Timing uses the business timezone**, never the browser's and never a fixed
  offset. Sends land inside a 09:00–18:00 local window, never in the past, and a
  backlog after a pause or an outage is spread across later windows instead of
  burst-sending.
- **Editing a live flow writes a new revision.** Contacts already enrolled keep
  the revision they were promised; historical sends, provider ids and delivery
  events are immutable.
- **No paid media is involved anywhere.** Flow creation and execution make no
  media-generation call and reserve no media credits.

Data model (migration `0040_email_automation_v2.sql`, additive, owner-scoped
RLS): `voom_email_flows`, `voom_email_flow_steps`, `voom_email_flow_enrollments`,
`voom_email_flow_step_runs`, `voom_email_flow_delivery_events`,
`voom_email_flow_events`, `voom_email_suppressions`. All writes go through
service-role-only RPCs (`create_email_flow`, `enroll_email_flow_contact`,
`claim_email_flow_step_run`, `record_email_flow_step_provider_result`,
`record_email_flow_delivery_event`, `advance_email_flow_enrollment`,
`stop_email_flow_enrollment`, `set_email_flow_status`,
`reschedule_email_flow_step_run`, `revise_email_flow`, `record_email_suppression`);
the browser has read access to its own rows only.

The Automation Coordinator reads live and proposed flows, the lifecycle emails
they have scheduled and their recent activity. It suppresses a Welcome or
Re-engagement opportunity once a flow of that type exists, and its proposals are
deduplicated three ways (the opportunity list, an owner-scoped proposal key, and
a partial unique index), so a daily cron tick can never pile up duplicates.

### Supabase Cron workers

Configure the existing Supabase Cron job runner to call
`/api/cron/media-generation` every two minutes with
`Authorization: Bearer <CRON_SECRET>` (the secret should come from Supabase
Vault, not a migration or source file). Do not add this route to Vercel Cron:
Vercel Hobby's cadence is not suitable for asynchronous media polling. The
Instagram worker keeps its existing five-minute schedule. The worker reuses
`mara_media_generations.updated_at` (already maintained by the existing trigger)
for its two-minute due check and poll lease, so no schema migration or live
schedule migration is required.

Email Automation v2 adds one more worker: point Supabase Cron at
`/api/cron/email-flows` **every 15 minutes** (`*/15 * * * *`) with the same
`Authorization: Bearer <CRON_SECRET>` header. That cadence matches
`EMAIL_FLOW_CRON_CADENCE_MINUTES` in `lib/email-flows/engine.ts` and is the
shortest one lifecycle email needs: enrollment happens in the next business-hours
window anyway, so a finer cadence would only add load. The route is race-safe
(a claim lease plus a durable idempotency key per step run), returns 503 when
`CRON_SECRET` is unset and 401 on a mismatch, and is deliberately **not** in
`vercel.json` — Vercel Hobby's minimum cadence cannot express it, and the route
was not triggered manually in Production while this was built.
