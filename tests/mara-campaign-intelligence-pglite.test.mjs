/**
 * MARA Campaign Intelligence (Automated Campaigns v2) — real-database coverage.
 *
 * Applies the repository's actual migrations (0001..0038) to an embedded
 * PostgreSQL and exercises the REAL RPCs Production calls:
 * `create_automated_campaign` and `update_campaign_action_content`.
 *
 * The payloads are produced by the REAL pure modules (`planCampaign` +
 * `applyCampaignIntelligence`), mapped exactly as `buildAutomatedCampaign`
 * maps them, so the database sees the shape the build layer actually sends.
 *
 * No provider is called anywhere in this file: no AI, no Resend, no Meta, no
 * Seedream/Seedance, no cron.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const { planCampaign } = await import("../lib/campaign/planner.ts");
const { applyCampaignIntelligence, toCampaignStrategyView } = await import("../lib/campaign/strategy.ts");

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const AUD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const KEY_MARA = "44444444-4444-4444-8444-444444444444";
const KEY_FALLBACK = "55555555-5555-4555-8555-555555555555";
const KEY_MANUAL = "66666666-6666-4666-8666-666666666666";
const KEY_ASSISTED = "77777777-7777-4777-8777-777777777777";
const KEY_AUTOPILOT = "88888888-8888-4888-8888-888888888888";
const KEY_LOCKED = "99999999-9999-4999-8999-999999999999";

const START_UTC = new Date("2026-09-22T00:00+04:00").toISOString();
const END_UTC = new Date("2026-10-01T23:59+04:00").toISOString();
const NOW = new Date("2026-09-20T12:00:00.000Z");

const BRAND = {
  brandName: "SynraPay",
  brandDescription: "Payments for small merchants.",
  industry: "Fintech",
  targetCustomer: ["Small merchants"],
  brandPersonality: ["plain-spoken"],
  mainGoal: "Adopt the new dashboard",
};
const BRIEF = {
  name: "SynraPay website is now LIVE",
  goal: "announce",
  startAt: "2026-09-22",
  endAt: "2026-10-01",
  offerDetails: "",
  targetAudience: "Existing SynraPay merchants",
  notes: "",
  audienceId: AUD_A,
};

let db;

async function getDb() {
  if (!db) {
    ({ db } = await createSupabaseLite());
    await db.exec(`
      insert into auth.users (id, email) values
        ('${OWNER_A}', 'owner.a@example.com'),
        ('${OWNER_B}', 'owner.b@example.com');
      insert into public.businesses (owner_user_id, brand_name, industry, automation_level) values
        ('${OWNER_A}', 'SynraPay', 'Fintech', 'assisted'),
        ('${OWNER_B}', 'Other Studio', 'Fashion', 'manual');
      insert into public.audiences (id, owner_id, name, type) values
        ('${AUD_A}', '${OWNER_A}', 'Merchants', 'manual');
    `);
  }
  return db;
}

async function all(sql, params = []) {
  const d = await getDb();
  const { rows } = await d.query(sql, params);
  return rows;
}

async function one(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0];
}

/** The deterministic skeleton for the fixture brief. */
function plan() {
  return planCampaign({
    brief: BRIEF,
    brand: BRAND,
    audiences: [{ id: AUD_A, name: "Merchants", eligibleEmailCount: 12 }],
    now: NOW,
  });
}

/**
 * A schema-valid MARA response with distinct copy per action (the same shape
 * the real provider must return, validated by campaignIntelligenceSchema).
 */
function intelligence(skeleton) {
  const angles = [
    ["The SynraPay website is live", "One dashboard for card and wallet payments.", "Your existing setup carries over unchanged and the payouts page now shows the exact date funds land.", "Open the dashboard"],
    ["Where your payouts land now", "Every settlement shows its arrival date.", "Following the launch, the payouts page lists each settlement with the date it reaches your bank account.", "Check this week's payouts"],
    ["Last look at the new site", "Two minutes to invite your team.", "The dashboard is live and your payment methods are already connected; the only step left is inviting whoever reconciles.", "Invite your team"],
    ["Your account moved to the new site", "Same login, one clearer place.", "Your account now runs on the new website. Settlement history, payout dates and payment methods live on one page.", "Sign in to the new site"],
  ];
  const igAngles = [
    ["Launch announcement", "The site is finally live", "Settlement history, payout dates and payment methods now sit in one dashboard."],
    ["Payouts explained", "Where your money lands", "Every settlement shows the exact date it reaches your bank account."],
    ["Behind the build", "We rebuilt this around one question", "Merchants kept asking when the money lands; the new site answers it on one screen."],
    ["Closing reminder", "Still using the old bookmark?", "The new site has been live for a week — update your bookmark."],
  ];
  let emailIndex = 0;
  let igIndex = 0;
  return {
    strategy: {
      objective: "Get existing merchants onto the newly launched SynraPay website.",
      coreMessage: "The website is live and your setup already works with it.",
      audienceAngle: "Merchants want to know nothing breaks and where their payouts are.",
      narrative: "Announce the launch, prove what the site does, then ask for the visit.",
      ctaStrategy: "Open with a look, then a direct visit to the dashboard.",
      sequenceRationale: "Start with a strong launch announcement, follow with a product-benefit Reel, then use email to explain the website in more detail and drive visits.",
    },
    actions: skeleton.map((action) => {
      if (action.channel === "email") {
        const angle = angles[emailIndex++ % angles.length];
        return {
          slot: action.slot,
          channel: "email",
          title: angle[0],
          email: {
            purpose: `Explains the launch to existing merchants (email ${emailIndex}).`,
            subject: angle[0],
            previewText: angle[1],
            body: `Hi,\n\n${angle[2]}\n\nNothing else is required from you today.\n\nCTA: ${angle[3]}`,
            cta: angle[3],
            ctaUrl: null,
            audienceNote: "Existing SynraPay merchants.",
            sendTimeNote: "Mid-morning, when merchants reconcile.",
            proposedSendAt: null,
          },
          instagram: null,
        };
      }
      const angle = igAngles[igIndex++ % igAngles.length];
      const format = action.channel === "instagram_reel" ? "reel" : action.channel === "instagram_story" ? "story" : "post";
      return {
        slot: action.slot,
        channel: action.channel,
        title: angle[0],
        email: null,
        instagram: {
          format,
          purpose: `Carries the ${angle[0].toLowerCase()} moment on Instagram.`,
          concept: angle[0],
          hook: angle[1],
          caption: angle[2],
          cta: format === "story" ? "Tap through" : "See the new site",
          visualDirection: "Clean product screenshot on a dark desk, single light source.",
          script: format === "reel" ? ["Open on the dashboard loading", "Cut to the payouts page", "End on the brand mark"] : [],
          proposedSendAt: null,
        },
      };
    }),
    performanceNote: null,
  };
}

/**
 * Builds the exact `create_automated_campaign` payload the build layer sends,
 * using the real planner + merge, for a given automation mode and MARA state.
 */
function buildPayload({ key, mode = "assisted", withMara = true }) {
  const skeleton = plan();
  const merged = applyCampaignIntelligence({
    skeleton: skeleton.actions,
    summary: skeleton.summary,
    brief: BRIEF,
    brand: BRAND,
    goalLabel: "Announce something",
    intelligence: withMara ? intelligence(skeleton.actions) : null,
    now: NOW,
  });
  const strategy = toCampaignStrategyView(merged);

  const actions = merged.actions.map((action) => {
    const status = mode === "autopilot" && action.autopilotSafe
      ? "approved"
      : mode === "manual"
        ? "proposed"
        : "needs_approval";
    const base = {
      slot: action.slot,
      channel: action.channel,
      stage: action.stage,
      title: action.title,
      purpose: action.purpose,
      scheduledFor: action.scheduledFor,
      status,
      safetyBlockers: action.autopilotBlockers,
      idempotencyKey: `${key.slice(0, 24)}${String(action.slot).padStart(2, "0")}${key.slice(28)}`,
      contentSource: action.contentSource,
    };
    if (action.channel === "email") {
      return {
        ...base,
        subject: action.subject ?? action.title,
        previewText: action.previewText ?? "",
        body: action.body ?? action.title,
        cta: action.cta ?? "",
        audienceId: AUD_A,
        content: { cta: action.cta ?? null, ctaUrl: action.ctaUrl ?? null, audienceNote: action.audienceNote ?? null, sendTimeNote: action.sendTimeNote ?? null },
      };
    }
    return {
      ...base,
      concept: action.concept ?? action.title,
      caption: action.caption ?? "",
      hashtags: action.hashtags ?? [],
      content: {
        format: action.format ?? "post",
        concept: action.concept ?? null,
        hook: action.hook ?? null,
        cta: action.cta ?? null,
        visualDirection: action.visualDirection ?? null,
        script: action.script ?? [],
        hashtags: action.hashtags ?? [],
      },
    };
  });

  return {
    campaign: {
      idempotencyKey: key,
      name: BRIEF.name,
      goal: BRIEF.goal,
      startAt: START_UTC,
      endAt: END_UTC,
      offerDetails: "",
      audience: BRIEF.targetAudience,
      audienceId: AUD_A,
      notes: "",
      summary: [strategy.summary].join(" "),
      strategy: { ...strategy, summary: undefined, source: undefined },
      strategySummary: strategy.summary,
      generationSource: merged.source,
      fallbackSlots: merged.fallbackSlots,
      performanceUsed: false,
    },
    actions,
  };
}

async function build(payload, ownerId = OWNER_A) {
  const rows = await all("select * from public.create_automated_campaign($1::uuid, $2::jsonb)", [ownerId, JSON.stringify(payload)]);
  return rows[0];
}

// ─── 1. v2 columns are written by the real build RPC ───────────────────────

test("a MARA build stores the strategy, per-action structured content and exactly one generation row", async () => {
  const container = await build(buildPayload({ key: KEY_MARA }));
  assert.ok(container.id, "a container was created");
  assert.equal(container.kind, "multi");
  assert.equal(container.generation_source, "mara");
  assert.ok(container.strategy_summary.length > 20, "the short approach line is stored");
  assert.match(container.strategy_summary, /launch announcement/i);
  assert.equal(container.strategy.objective.length > 10, true);
  assert.equal(container.strategy.coreMessage.length > 10, true);
  assert.equal(container.strategy.audienceAngle.length > 10, true);
  assert.equal(container.strategy.ctaStrategy.length > 10, true);

  const actions = await all(
    "select * from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2 order by slot",
    [OWNER_A, container.id],
  );
  assert.ok(actions.length >= 5, "the deterministic skeleton was persisted");
  for (const action of actions) {
    assert.equal(action.content_source, "mara", "every action was written by MARA");
    assert.ok(action.mara_content && Object.keys(action.mara_content).length > 0, "structured content is stored");
    if (action.channel === "email") {
      assert.ok(action.mara_content.cta, "the email CTA is stored");
      assert.equal(action.mara_content.audienceNote, "Existing SynraPay merchants.");
    } else {
      assert.ok(["post", "reel", "story"].includes(action.mara_content.format), "the Instagram format is stored");
      assert.ok(action.mara_content.concept, "the concept is stored");
      if (action.channel === "instagram_reel") {
        assert.ok(action.mara_content.script.length >= 3, "the Reel script is stored");
        assert.ok(action.mara_content.visualDirection.length > 5, "the visual direction is stored");
      }
    }
  }

  const generations = await all(
    "select * from public.voom_campaign_generations where owner_user_id = $1 and campaign_id = $2",
    [OWNER_A, container.id],
  );
  assert.equal(generations.length, 1, "exactly one build generation row");
  assert.equal(generations[0].kind, "build");
  assert.equal(generations[0].provider, "mara");
  assert.equal(generations[0].idempotency_key, KEY_MARA);
});

test("a fallback build is labelled deterministic, still complete, and still audited", async () => {
  const container = await build(buildPayload({ key: KEY_FALLBACK, withMara: false }));
  assert.equal(container.generation_source, "deterministic");
  assert.ok(container.strategy_summary.length > 20, "a deterministic campaign still has an approach line");

  const actions = await all(
    "select * from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2 order by slot",
    [OWNER_A, container.id],
  );
  assert.ok(actions.length >= 5);
  assert.ok(actions.every((action) => action.content_source === "deterministic"));
  const emails = await all(
    "select subject, preview_text, content from public.voom_campaigns where owner_user_id = $1 and parent_campaign_id = $2",
    [OWNER_A, container.id],
  );
  assert.ok(emails.length >= 1);
  for (const email of emails) {
    assert.ok(email.subject && email.subject.length > 3, "subject present");
    assert.ok(email.preview_text, "preview text present");
    assert.ok(email.content.length > 40, "body present");
  }
  const generation = await one(
    "select provider, status from public.voom_campaign_generations where owner_user_id = $1 and campaign_id = $2",
    [OWNER_A, container.id],
  );
  assert.deepEqual({ provider: generation.provider, status: generation.status }, { provider: "fallback", status: "fallback" });
});

// ─── 2. Idempotency ────────────────────────────────────────────────────────

test("repeated builds with the same key duplicate nothing: campaigns, emails, actions or generation rows", async () => {
  const payload = buildPayload({ key: KEY_MARA });
  const before = await one("select count(*)::int as n from public.voom_campaigns where owner_user_id = $1", [OWNER_A]);
  const first = await build(payload);
  const second = await build(payload);
  const third = await build(payload);
  assert.equal(second.id, first.id, "the replay returns the same container");
  assert.equal(third.id, first.id);

  const after = await one("select count(*)::int as n from public.voom_campaigns where owner_user_id = $1", [OWNER_A]);
  assert.equal(after.n, before.n, "no extra container or email child was created");

  const counts = await one(`
    select
      (select count(*)::int from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2) as actions,
      (select count(*)::int from public.voom_campaigns where owner_user_id = $1 and parent_campaign_id = $2) as emails,
      (select count(*)::int from public.voom_campaign_generations where owner_user_id = $1 and campaign_id = $2) as generations
  `, [OWNER_A, first.id]);
  assert.equal(counts.actions, payload.actions.length, "one action row per planned slot");
  assert.equal(counts.emails, payload.actions.filter((a) => a.channel === "email").length, "one email child per email action");
  assert.equal(counts.generations, 1, "one generation row, however many times the build was replayed");
});

// ─── 3. Nothing external happens during generation ─────────────────────────

test("campaign generation sends zero emails, publishes zero Instagram posts and spends zero media credits", async () => {
  // Manual, Assisted and Autopilot builds.
  await build(buildPayload({ key: KEY_MANUAL, mode: "manual" }));
  await build(buildPayload({ key: KEY_ASSISTED, mode: "assisted" }));
  await build(buildPayload({ key: KEY_AUTOPILOT, mode: "autopilot" }));

  const sent = await one("select count(*)::int as n from public.campaign_sends where owner_user_id = $1", [OWNER_A]);
  assert.equal(sent.n, 0, "no email was sent by campaign generation in any mode");

  const queued = await one("select count(*)::int as n from public.instagram_publish_queue where owner_user_id = $1", [OWNER_A]);
  assert.equal(queued.n, 0, "no Instagram publish job was queued (the drafts have no visual)");

  const media = await one("select count(*)::int as n from public.mara_media_generations where owner_user_id = $1", [OWNER_A]);
  assert.equal(media.n, 0, "no paid image or video generation was created");

  const credits = await one("select count(*)::int as n from public.voom_credit_ledger where owner_user_id = $1", [OWNER_A]);
  assert.equal(credits.n, 0, "no media credit was reserved or spent");

  const assets = await one(`
    select count(*)::int as n from public.post_draft_assets a
    join public.voom_campaign_actions act on act.draft_id = a.draft_id
    where act.owner_user_id = $1
  `, [OWNER_A]);
  assert.equal(assets.n, 0, "every campaign Instagram draft still needs a visual, so nothing can auto-publish");
});

test("mode gating still holds: Manual proposes, Assisted gates, Autopilot approves only safe actions", async () => {
  const statuses = async (key) => {
    const container = await one("select id from public.voom_campaigns where owner_user_id = $1 and build_idempotency_key = $2", [OWNER_A, key]);
    const rows = await all("select status, safety_blockers from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2", [OWNER_A, container.id]);
    return rows;
  };
  const manual = await statuses(KEY_MANUAL);
  assert.ok(manual.length > 0);
  assert.ok(manual.every((row) => row.status === "proposed"), "Manual auto-approves nothing");

  const assisted = await statuses(KEY_ASSISTED);
  assert.ok(assisted.every((row) => row.status === "needs_approval"), "Assisted waits for approval");

  const autopilot = await statuses(KEY_AUTOPILOT);
  for (const row of autopilot) {
    if (row.safety_blockers.length > 0) assert.notEqual(row.status, "approved", "a blocked action is never auto-approved");
  }
  assert.ok(autopilot.some((row) => row.status === "approved") || autopilot.every((row) => row.safety_blockers.length > 0),
    "Autopilot approves only what the existing safety evaluator allows");
});

// ─── 4. Editing one action ─────────────────────────────────────────────────

test("editing one action rewrites only that action's draft", async () => {
  const container = await one("select id from public.voom_campaigns where owner_user_id = $1 and build_idempotency_key = $2", [OWNER_A, KEY_MARA]);
  const actions = await all("select * from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2 order by slot", [OWNER_A, container.id]);
  const email = actions.find((action) => action.channel === "email");
  const other = actions.find((action) => action.id !== email.id);

  const patch = {
    title: "Edited subject line",
    subject: "Edited subject line",
    previewText: "Edited preview",
    body: "Hi,\n\nThis body was edited by the merchant before approval.\n\nCTA: Open the dashboard",
    scheduledFor: "2026-09-23T07:00:00.000Z",
    content: { cta: "Open the dashboard", ctaUrl: null, audienceNote: "Existing SynraPay merchants." },
    contentSource: "edited",
  };
  const updated = await one(
    "select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)",
    [OWNER_A, email.id, JSON.stringify(patch)],
  );
  assert.equal(updated.id, email.id);
  assert.equal(updated.content_source, "edited");
  assert.equal(updated.mara_content.cta, "Open the dashboard");
  assert.equal(new Date(updated.scheduled_for).toISOString(), "2026-09-23T07:00:00.000Z");

  const child = await one("select subject, preview_text, content, proposed_send_at from public.voom_campaigns where id = $1", [email.email_campaign_id]);
  assert.equal(child.subject, "Edited subject line");
  assert.equal(child.preview_text, "Edited preview");
  assert.match(child.content, /edited by the merchant/);

  // The rest of the campaign is untouched.
  const untouched = await one("select title, content_source, scheduled_for from public.voom_campaign_actions where id = $1", [other.id]);
  assert.equal(untouched.title, other.title);
  assert.equal(untouched.content_source, other.content_source);
  assert.equal(new Date(untouched.scheduled_for).toISOString(), new Date(other.scheduled_for).toISOString());
  const actionCount = await one("select count(*)::int as n from public.voom_campaign_actions where campaign_id = $1", [container.id]);
  assert.equal(actionCount.n, actions.length, "editing never adds or removes an action");
});

test("editing an Instagram action keeps the caption limits and mirrors the calendar", async () => {
  const container = await one("select id from public.voom_campaigns where owner_user_id = $1 and build_idempotency_key = $2", [OWNER_A, KEY_AUTOPILOT]);
  const action = await one(
    "select * from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2 and channel = 'instagram_post' order by slot limit 1",
    [OWNER_A, container.id],
  );
  assert.ok(action, "an autopilot-safe Instagram action exists");

  const patch = {
    title: "Edited concept",
    caption: "Edited caption written by the merchant before approval.",
    queueCaption: "Edited caption written by the merchant before approval.",
    scheduledFor: "2026-09-24T15:00:00.000Z",
    content: { hook: "Edited hook" },
    contentSource: "edited",
  };
  await one("select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)", [OWNER_A, action.id, JSON.stringify(patch)]);

  const draft = await one("select title, content, proposed_publish_at from public.mara_drafts where id = $1", [action.draft_id]);
  assert.equal(draft.title, "Edited concept");
  assert.match(draft.content, /Edited caption written by the merchant/);
  assert.equal(new Date(draft.proposed_publish_at).toISOString(), "2026-09-24T15:00:00.000Z");

  const calendar = await one("select title, content from public.content_calendar_items where owner_user_id = $1 and source_draft_id = $2", [OWNER_A, action.draft_id]);
  assert.equal(calendar.title, "Edited concept", "the approved calendar mirror stays truthful");
  assert.match(calendar.content, /Edited caption/);

  // A caption longer than Instagram's limit is refused by the column check.
  await assert.rejects(
    one("select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)", [
      OWNER_A, action.id, JSON.stringify({ queueCaption: "x".repeat(2201) }),
    ]),
    /instagram_caption_too_long/,
    "Instagram's own 2200-character caption limit is enforced in the database",
  );
});

// ─── 5. Sent / published actions are frozen ────────────────────────────────

test("a sent email action cannot be edited or regenerated", async () => {
  const container = await build(buildPayload({ key: KEY_LOCKED, mode: "assisted" }));
  const email = await one(
    "select * from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2 and channel = 'email' order by slot limit 1",
    [OWNER_A, container.id],
  );
  const recipient = await one(
    "insert into public.campaign_recipients (owner_user_id, campaign_id, kind, contact, contact_name, consent_at, consent_source) values ($1, $2, 'email', 'merchant@example.com', 'Merchant', now(), 'import') returning id",
    [OWNER_A, email.email_campaign_id],
  );
  await one(
    `insert into public.campaign_sends
       (owner_user_id, campaign_id, recipient_id, channel, provider, internal_status, attempts, claimed_at, accepted_at, idempotency_key)
     values ($1, $2, $3, 'email', 'resend', 'accepted', 1, now(), now(), 'send-idempotency-key-0001')`,
    [OWNER_A, email.email_campaign_id, recipient.id],
  );

  await assert.rejects(
    one("select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)", [
      OWNER_A, email.id, JSON.stringify({ subject: "Rewritten after sending" }),
    ]),
    /campaign_action_locked/,
    "a sent email is locked",
  );
  await assert.rejects(
    one("select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, $4, true)", [
      OWNER_A, email.id, JSON.stringify({ subject: "Regenerated after sending" }), "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    ]),
    /campaign_action_locked/,
    "a sent email cannot be regenerated either",
  );

  const unchanged = await one("select subject from public.voom_campaigns where id = $1", [email.email_campaign_id]);
  assert.notEqual(unchanged.subject, "Rewritten after sending");
  assert.notEqual(unchanged.subject, "Regenerated after sending");
});

test("a published Instagram action cannot be edited or regenerated", async () => {
  const container = await one("select id from public.voom_campaigns where owner_user_id = $1 and build_idempotency_key = $2", [OWNER_A, KEY_AUTOPILOT]);
  const action = await one(
    "select * from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2 and channel <> 'email' order by slot limit 1",
    [OWNER_A, container.id],
  );
  await one(
    `insert into public.instagram_publish_queue
       (owner_user_id, draft_id, media_kind, caption, scheduled_at, status, idempotency_key, instagram_media_id, published_at)
     values ($1, $2, 'image', 'published caption', now(), 'published', 'publish-idempotency-0001', '1789 real-media-id', now())`,
    [OWNER_A, action.draft_id],
  );

  await assert.rejects(
    one("select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)", [
      OWNER_A, action.id, JSON.stringify({ caption: "Rewritten after publishing" }),
    ]),
    /campaign_action_locked/,
    "a published Instagram item is locked",
  );
  await assert.rejects(
    one("select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, $4, true)", [
      OWNER_A, action.id, JSON.stringify({ caption: "Regenerated after publishing" }), "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    ]),
    /campaign_action_locked/,
  );

  const draft = await one("select content from public.mara_drafts where id = $1", [action.draft_id]);
  assert.doesNotMatch(draft.content, /Rewritten after publishing|Regenerated after publishing/);
  const queue = await one("select status, instagram_media_id from public.instagram_publish_queue where draft_id = $1", [action.draft_id]);
  assert.deepEqual({ status: queue.status, id: queue.instagram_media_id }, { status: "published", id: "1789 real-media-id" }, "the published record is untouched");
});

// ─── 6. Regenerating one action ────────────────────────────────────────────

test("regenerating one action rewrites it in place, resets review and never duplicates it", async () => {
  const container = await one("select id from public.voom_campaigns where owner_user_id = $1 and build_idempotency_key = $2", [OWNER_A, KEY_ASSISTED]);
  const before = await all("select id, channel from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2 order by slot", [OWNER_A, container.id]);
  const target = await one(
    "select * from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2 and channel = 'email' order by slot limit 1",
    [OWNER_A, container.id],
  );

  const key = "cccccccc-3333-4333-8333-cccccccccccc";
  const patch = {
    title: "MARA rewrite",
    purpose: "Rewritten by MARA.",
    subject: "MARA rewrite",
    previewText: "Rewritten preview",
    body: "Hi,\n\nMARA rewrote this email with a different angle.\n\nCTA: Open the dashboard",
    scheduledFor: target.scheduled_for instanceof Date ? target.scheduled_for.toISOString() : target.scheduled_for,
    content: { cta: "Open the dashboard", audienceNote: "Existing SynraPay merchants." },
    contentSource: "mara",
    safetyBlockers: [],
  };
  const updated = await one(
    "select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, $4, true)",
    [OWNER_A, target.id, JSON.stringify(patch), key],
  );

  assert.equal(updated.id, target.id, "the same action row was rewritten, not duplicated");
  assert.equal(updated.status, "needs_approval", "new content goes back to review");
  assert.equal(updated.content_source, "mara");
  const child = await one("select subject, status, approved_at from public.voom_campaigns where id = $1", [target.email_campaign_id]);
  assert.equal(child.subject, "MARA rewrite");
  assert.equal(child.status, "draft", "the previous approval no longer describes the content");
  assert.equal(child.approved_at, null);

  const after = await all("select id, channel from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2 order by slot", [OWNER_A, container.id]);
  assert.deepEqual(after.map((row) => row.id), before.map((row) => row.id), "no action was added, removed or reordered");
  const emails = await one("select count(*)::int as n from public.voom_campaigns where owner_user_id = $1 and parent_campaign_id = $2", [OWNER_A, container.id]);
  assert.equal(emails.n, before.filter((row) => row.channel === "email").length, "no duplicate email child");

  const generations = await all("select * from public.voom_campaign_generations where owner_user_id = $1 and action_id = $2", [OWNER_A, target.id]);
  assert.equal(generations.length, 1, "one generation row for the regeneration");
  assert.equal(generations[0].kind, "action_regenerate");
  assert.equal(generations[0].provider, "mara");

  // A retried regenerate with the SAME key is a no-op.
  const replay = await one(
    "select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, $4, true)",
    [OWNER_A, target.id, JSON.stringify({ ...patch, subject: "Second attempt", body: "Second attempt body" }), key],
  );
  assert.equal(replay.id, target.id);
  const afterReplay = await one("select subject from public.voom_campaigns where id = $1", [target.email_campaign_id]);
  assert.equal(afterReplay.subject, "MARA rewrite", "the replay did not apply a second time");
  const generationCount = await one("select count(*)::int as n from public.voom_campaign_generations where owner_user_id = $1 and action_id = $2", [OWNER_A, target.id]);
  assert.equal(generationCount.n, 1, "still exactly one generation row");
});

test("regenerating an Instagram action withdraws its calendar mirror so nothing stale can publish", async () => {
  const container = await one("select id from public.voom_campaigns where owner_user_id = $1 and build_idempotency_key = $2", [OWNER_A, KEY_MANUAL]);
  // Approve one Instagram action the way Autopilot/the user would, creating the mirror.
  const action = await one(
    "select * from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2 and channel = 'instagram_post' order by slot limit 1",
    [OWNER_A, container.id],
  );
  await one("update public.mara_drafts set status = 'approved' where id = $1", [action.draft_id]);
  await one(
    `insert into public.content_calendar_items (owner_user_id, title, channel, content, topic, publish_at, status, source_draft_id)
     values ($1, 'Old title', 'Instagram', 'Old caption', 'Campaign', now(), 'approved', $2)
     on conflict (owner_user_id, source_draft_id) do update set status = 'approved'`,
    [OWNER_A, action.draft_id],
  );

  await one(
    "select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, $4, true)",
    [OWNER_A, action.id, JSON.stringify({ title: "New concept", caption: "New caption from MARA", contentSource: "mara", content: { hook: "New hook" } }), "dddddddd-4444-4444-8444-dddddddddddd"],
  );

  const draft = await one("select status, content from public.mara_drafts where id = $1", [action.draft_id]);
  assert.equal(draft.status, "draft", "regenerated content needs approval again");
  assert.match(draft.content, /New caption from MARA/);
  const mirror = await one("select count(*)::int as n from public.content_calendar_items where owner_user_id = $1 and source_draft_id = $2", [OWNER_A, action.draft_id]);
  assert.equal(mirror.n, 0, "the stale approved mirror is withdrawn");
});

// ─── 7. Owner isolation ────────────────────────────────────────────────────

test("another workspace cannot read or rewrite these campaign rows", async () => {
  const container = await one("select id from public.voom_campaigns where owner_user_id = $1 and build_idempotency_key = $2", [OWNER_A, KEY_MARA]);
  const action = await one(
    "select id, email_campaign_id from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2 and channel = 'email' order by slot limit 1",
    [OWNER_A, container.id],
  );
  assert.ok(action.email_campaign_id, "the fixture action is an email action");

  // The RPCs are owner-scoped: another owner's id finds nothing.
  await assert.rejects(
    one("select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)", [OWNER_B, action.id, JSON.stringify({ subject: "Hijacked" })]),
    /campaign_action_not_found/,
  );
  const untouched = await one("select subject from public.voom_campaigns where id = $1", [action.email_campaign_id]);
  assert.notEqual(untouched.subject, "Hijacked");

  // The composite foreign keys make a cross-owner action row impossible.
  await assert.rejects(
    one(
      `insert into public.voom_campaign_actions
         (owner_user_id, campaign_id, slot, channel, stage, title, scheduled_for, email_campaign_id, idempotency_key)
       values ($1, $2, 15, 'email', 'awareness', 'Cross owner', now(), $3, 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee')`,
      [OWNER_B, container.id, action.email_campaign_id],
    ),
    /23503|violates foreign key/i,
  );

  // RLS: as owner B, none of owner A's campaign rows are visible.
  const d = await getDb();
  await d.exec("begin");
  await d.exec(`select set_config('request.jwt.claim.sub', '${OWNER_B}', true)`);
  await d.exec("set local role authenticated");
  const { rows: visibleCampaigns } = await d.query("select id from public.voom_campaigns where id = $1", [container.id]);
  const { rows: visibleActions } = await d.query("select id from public.voom_campaign_actions where campaign_id = $1", [container.id]);
  const { rows: visibleGenerations } = await d.query("select id from public.voom_campaign_generations where campaign_id = $1", [container.id]);
  await d.exec("rollback");
  assert.equal(visibleCampaigns.length, 0, "RLS hides another owner's campaigns");
  assert.equal(visibleActions.length, 0, "RLS hides another owner's campaign actions");
  assert.equal(visibleGenerations.length, 0, "RLS hides another owner's generation rows");
});

test("the v2 tables are RLS-protected and service-role written only", async () => {
  const policies = await all(
    `select tablename, policyname, cmd, roles::text as roles, qual
       from pg_policies where tablename in ('voom_campaign_generations', 'voom_campaign_actions') order by tablename`,
  );
  const generations = policies.filter((row) => row.tablename === "voom_campaign_generations");
  assert.equal(generations.length, 1, "the generation table has exactly one policy");
  assert.equal(generations[0].cmd, "SELECT");
  assert.match(generations[0].qual, /auth\.uid\(\).*owner_user_id|owner_user_id.*auth\.uid\(\)/);
  assert.match(generations[0].roles, /authenticated/);
  assert.doesNotMatch(generations[0].roles, /anon/);

  const rls = await all(
    `select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relname in ('voom_campaign_generations', 'voom_campaign_actions')`,
  );
  assert.ok(rls.every((row) => row.relrowsecurity), "row level security is enabled on both tables");

  const grants = await all(
    `select grantee, privilege_type from information_schema.role_table_grants
      where table_name = 'voom_campaign_generations' order by grantee, privilege_type`,
  );
  assert.ok(grants.some((row) => row.grantee === "service_role" && row.privilege_type === "INSERT"));
  assert.ok(!grants.some((row) => row.grantee === "authenticated" && row.privilege_type !== "SELECT"),
    "the browser role can only read its own rows");
  assert.ok(!grants.some((row) => row.grantee === "anon"), "anon has no access at all");
});
