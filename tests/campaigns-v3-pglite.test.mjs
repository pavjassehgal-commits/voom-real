/**
 * Campaigns v3 — real-database coverage.
 *
 * Applies the repository's actual migrations to an embedded PostgreSQL and
 * exercises the REAL functions Production calls:
 *   - `create_automated_campaign` (v3 body, migration 0045),
 *   - `add_campaign_action` (new in 0045),
 *   - `update_campaign_action_content` (0038, unchanged),
 *   - the 0037 schedule guard and the new 0045 channel guard.
 *
 * It also proves migration 0045's backfill: one database is built at the 0044
 * Production shape, filled with v2 campaign data, and only then migrated.
 *
 * No provider is called anywhere in this file: no AI, no Resend, no Meta, no
 * Seedream/Seedance, no cron, no credit ledger.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const { planCampaign } = await import("../lib/campaign/planner.ts");
const { applyCampaignIntelligence, toCampaignStrategyView } = await import("../lib/campaign/strategy.ts");

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const OWNER_C = "33333333-3333-4333-8333-333333333333";
const AUD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUD_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const MIGRATION_0045 = "0045_campaigns_v3_unified_channels.sql";

// Every proposed time is relative to the real clock so the 0037 schedule guard
// (>= now() + 10 minutes, inside the campaign window) is satisfied whenever this
// suite runs, not only on the day it was written. The window starts at UTC
// midnight two days out and ends late on the tenth campaign day, so the
// planner's UTC day math and the trigger's instant comparison agree exactly.
const DAY = 86_400_000;
const CAMPAIGN_START = new Date(Math.ceil((Date.now() + 2 * DAY) / DAY) * DAY).toISOString();
const CAMPAIGN_END = new Date(Date.parse(CAMPAIGN_START) + 9 * DAY + 23 * 3_600_000 + 59 * 60_000).toISOString();
const startIso = () => CAMPAIGN_START;
const endIso = () => CAMPAIGN_END;
/** A real instant `dayOffset` campaign days from the start, at `hour` UTC. */
const at = (dayOffset, hour = 9) =>
  new Date(Date.parse(CAMPAIGN_START) + dayOffset * DAY + hour * 3_600_000).toISOString();

const BRAND = {
  brandName: "SynraPay",
  brandDescription: "Payments for small merchants.",
  industry: "Fintech",
  targetCustomer: ["Small merchants"],
  brandPersonality: ["plain-spoken"],
  mainGoal: "Adopt the new dashboard",
};

let keySeq = 0;
/** A deterministic, unique, 36-character idempotency key. */
function nextKey(prefix = "b") {
  keySeq += 1;
  return `${prefix}${String(keySeq).padStart(6, "0")}-4111-8111-111111111111`;
}
function actionKey(buildKey, slot) {
  return `${buildKey.slice(0, 24)}${String(slot).padStart(2, "0")}${buildKey.slice(28)}`;
}

let db;

async function getDb() {
  if (!db) {
    ({ db } = await createSupabaseLite());
    await db.exec(`
      insert into auth.users (id, email) values
        ('${OWNER_A}', 'owner.a@example.com'),
        ('${OWNER_B}', 'owner.b@example.com'),
        ('${OWNER_C}', 'owner.c@example.com');
      insert into public.businesses (owner_user_id, brand_name, industry, automation_level) values
        ('${OWNER_A}', 'SynraPay', 'Fintech', 'assisted'),
        ('${OWNER_B}', 'Other Studio', 'Fashion', 'manual'),
        ('${OWNER_C}', 'Clean Workspace', 'Retail', 'assisted');
      insert into public.audiences (id, owner_id, name, type) values
        ('${AUD_A}', '${OWNER_A}', 'Merchants', 'manual'),
        ('${AUD_C}', '${OWNER_C}', 'Clean List', 'manual');
    `);
  }
  return db;
}

async function all(sql, params = []) {
  const database = await getDb();
  const { rows } = await database.query(sql, params);
  return rows;
}

async function one(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0];
}

/** A minimal, explicit campaign payload — one action per requested channel. */
function payload({ channels, creationMethod = "mara", generationSource = "mara", actions, key = nextKey(), status = "needs_approval", contentSource, audienceId = AUD_A }) {
  return {
    key,
    body: {
      campaign: {
        idempotencyKey: key,
        name: "Summer Sale",
        goal: "drive_sales",
        startAt: startIso(),
        endAt: endIso(),
        offerDetails: "",
        audience: "Existing customers",
        audienceId,
        notes: "",
        summary: "Test campaign.",
        ...(channels === undefined ? {} : { channels }),
        ...(creationMethod === undefined ? {} : { creationMethod }),
        ...(generationSource === undefined ? {} : { generationSource }),
      },
      actions: (actions ?? defaultActions(
        channels,
        status,
        // A self-created campaign records its content as the user's own words.
        contentSource ?? (creationMethod === "self" ? "edited" : "deterministic"),
        audienceId,
      )).map((action, slot) => ({
        ...action,
        slot,
        idempotencyKey: actionKey(key, slot),
      })),
    },
  };
}

function defaultActions(channels, status = "needs_approval", contentSource = "deterministic", audienceId = AUD_A) {
  const selected = channels ?? ["instagram", "email"];
  const actions = [];
  if (selected.includes("instagram")) {
    actions.push({
      channel: "instagram_reel", stage: "awareness", title: "Summer Sale Reel",
      purpose: "Open the campaign with a visible moment.", scheduledFor: at(0, 14), status,
      concept: "Summer Sale Reel", caption: "Our Summer Sale starts now.", hashtags: ["#summer"],
      contentSource, content: { format: "reel", concept: "Summer Sale Reel", script: ["Open", "Show", "Close"] },
    });
    actions.push({
      channel: "instagram_post", stage: "conversion", title: "Summer Sale reminder",
      purpose: "Remind people before the sale closes.", scheduledFor: at(4, 15), status,
      concept: "Summer Sale reminder", caption: "Last days of the Summer Sale.", hashtags: [],
      contentSource, content: { format: "post", concept: "Summer Sale reminder", script: [] },
    });
  }
  if (selected.includes("email")) {
    actions.push({
      channel: "email", stage: "consideration", title: "Summer Sale announcement",
      purpose: "Explain the offer in full.", scheduledFor: at(1, 6), status,
      subject: "Our Summer Sale is live", previewText: "Ten days only.",
      body: "Hi,\n\nThe Summer Sale is live.\n\nCTA: Shop the sale", cta: "Shop the sale",
      audienceId, contentSource,
      content: { cta: "Shop the sale", ctaUrl: null, audienceNote: "Existing customers.", sendTimeNote: null },
    });
    actions.push({
      channel: "email", stage: "retention", title: "Summer Sale follow-up",
      purpose: "One clear last step.", scheduledFor: at(6, 7), status,
      subject: "The Summer Sale closes soon", previewText: "Two days left.",
      body: "Hi,\n\nTwo days left.\n\nCTA: Shop before it closes", cta: "Shop before it closes",
      audienceId, contentSource,
      content: { cta: "Shop before it closes", ctaUrl: null, audienceNote: null, sendTimeNote: null },
    });
  }
  return actions.sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
}

async function build(spec, ownerId = OWNER_A) {
  const rows = await all(
    "select * from public.create_automated_campaign($1::uuid, $2::jsonb)",
    [ownerId, JSON.stringify(spec.body)],
  );
  return rows[0];
}

async function actionsOf(campaignId, ownerId = OWNER_A) {
  return all(
    "select * from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2 order by slot",
    [ownerId, campaignId],
  );
}

/** The exact Postgres error text a statement raises, or null when it succeeds. */
async function errorOf(promise) {
  try { await promise; return null; } catch (error) { return String(error?.message ?? error); }
}

// ─── 1. Migration 0045 backfills Campaigns v2 data deterministically ────────

test("0045 backfills existing Campaigns v2 rows and leaves every one of them readable", async () => {
  // Build the database at the 0044 Production shape, write v2 data, then migrate.
  const { db: legacy, applyPending } = await createSupabaseLite({ stopBefore: MIGRATION_0045 });
  await legacy.exec(`
    insert into auth.users (id, email) values ('${OWNER_A}', 'owner.a@example.com');
    insert into public.businesses (owner_user_id, brand_name, industry, automation_level)
      values ('${OWNER_A}', 'SynraPay', 'Fintech', 'assisted');
    insert into public.audiences (id, owner_id, name, type)
      values ('${AUD_A}', '${OWNER_A}', 'Merchants', 'manual');
  `);

  // A real v2 build through the 0036 RPC: one container, email children and
  // Instagram drafts, with the v2 payload shape (no channels, no creationMethod).
  const skeleton = planCampaign({
    brief: { name: "Autumn Launch", goal: "announce", startAt: startIso(), endAt: endIso(), targetAudience: "Merchants", audienceId: AUD_A },
    brand: BRAND,
    audiences: [{ id: AUD_A, name: "Merchants", eligibleEmailCount: 12 }],
    timeZone: "UTC",
  });
  const merged = applyCampaignIntelligence({
    skeleton: skeleton.actions, summary: skeleton.summary,
    brief: { name: "Autumn Launch", goal: "announce", startAt: startIso(), endAt: endIso() },
    brand: BRAND, goalLabel: "Announce something", intelligence: null, timeZone: "UTC",
  });
  const strategy = toCampaignStrategyView(merged);
  const v2Key = nextKey("v");
  const v2Payload = {
    campaign: {
      idempotencyKey: v2Key, name: "Autumn Launch", goal: "announce",
      startAt: startIso(), endAt: endIso(), offerDetails: "", audience: "Merchants",
      audienceId: AUD_A, notes: "", summary: strategy.summary,
      strategySummary: strategy.summary, generationSource: merged.source,
    },
    actions: merged.actions.map((action) => ({
      slot: action.slot, channel: action.channel, stage: action.stage, title: action.title,
      purpose: action.purpose, scheduledFor: action.scheduledFor, status: "needs_approval",
      idempotencyKey: actionKey(v2Key, action.slot), contentSource: action.contentSource,
      ...(action.channel === "email"
        ? { subject: action.subject ?? action.title, previewText: action.previewText ?? "", body: action.body ?? action.title, cta: action.cta ?? "", audienceId: AUD_A, content: {} }
        : { concept: action.concept ?? action.title, caption: action.caption ?? "", hashtags: action.hashtags ?? [], content: { format: action.format ?? "post", script: action.script ?? [] } }),
    })),
  };
  const v2Container = (await legacy.query(
    "select * from public.create_automated_campaign($1::uuid, $2::jsonb)",
    [OWNER_A, JSON.stringify(v2Payload)],
  )).rows[0];
  const v2ActionCount = (await legacy.query(
    "select count(*)::int as n from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2",
    [OWNER_A, v2Container.id],
  )).rows[0].n;
  assert.ok(v2ActionCount >= 2, "the pre-migration fixture really is a v2 campaign");

  // Historical single-channel rows: one email draft and one retired row.
  await legacy.exec(`
    insert into public.voom_campaigns (owner_user_id, kind, is_automated, name, content, status)
      values ('${OWNER_A}', 'email', false, 'Legacy newsletter', 'Body', 'approved');
    insert into public.voom_campaigns (owner_user_id, kind, is_automated, name, content, status)
      values ('${OWNER_A}', 'sms', false, 'Legacy broadcast', 'Body', 'draft');
  `);

  // ── Migrate ──
  const applied = await applyPending();
  assert.ok(applied.includes(MIGRATION_0045), "0045 is applied to the legacy database");
  assert.equal(applied[applied.length - 1], "0049_tiktok_provider.sql", "0049 (the TikTok provider) is the checked-in successor head");

  const q = async (sql, params = []) => (await legacy.query(sql, params)).rows;

  // The v2 container takes its channels from the actions it already owns.
  const container = (await q("select * from public.voom_campaigns where id = $1", [v2Container.id]))[0];
  assert.deepEqual([...container.channels].sort(), ["email", "instagram"], "derived from its real actions");
  assert.equal(container.creation_method, "mara", "it was produced by the MARA builder");
  assert.equal(container.generation_source, v2Container.generation_source, "v2 provenance is untouched");
  assert.equal(container.strategy_summary, v2Container.strategy_summary, "v2 strategy is untouched");
  assert.equal(container.kind, "multi");
  assert.equal(container.name, "Autumn Launch");

  // Every existing action, email child and draft is still there and unchanged.
  const after = (await q(
    "select count(*)::int as n from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2",
    [OWNER_A, v2Container.id],
  ))[0].n;
  assert.equal(after, v2ActionCount, "no action was added, removed or rewritten");
  const children = await q(
    "select creation_method, channels from public.voom_campaigns where owner_user_id = $1 and parent_campaign_id = $2",
    [OWNER_A, v2Container.id],
  );
  assert.ok(children.length >= 1);
  for (const child of children) {
    assert.deepEqual(child.channels, ["email"], "an email child is an email deliverable");
    assert.equal(child.creation_method, "mara");
  }

  // Historical single-channel rows stay readable and are backfilled truthfully.
  const legacyEmail = (await q(
    "select * from public.voom_campaigns where owner_user_id = $1 and name = 'Legacy newsletter'", [OWNER_A],
  ))[0];
  assert.deepEqual(legacyEmail.channels, ["email"]);
  assert.equal(legacyEmail.creation_method, "self", "a draft the user wrote is recorded as theirs");
  assert.equal(legacyEmail.status, "approved", "its real state is untouched");

  // A retired historical row keeps NO channel selection: it stays readable, but
  // nothing ever claims it runs on an active channel, and it cannot be extended.
  const retired = (await q(
    "select * from public.voom_campaigns where owner_user_id = $1 and name = 'Legacy broadcast'", [OWNER_A],
  ))[0];
  assert.equal(retired.channels, null, "no channel selection is invented for historical rows");
  assert.equal(retired.kind, "sms", "the historical row is still readable");
  assert.equal(retired.creation_method, "self");

  // The whole v2 campaign still reads through the ordinary table surface.
  const readable = await q(
    `select a.id, a.channel, a.status, a.scheduled_for, a.mara_content, a.content_source
       from public.voom_campaign_actions a where a.owner_user_id = $1 and a.campaign_id = $2 order by a.slot`,
    [OWNER_A, v2Container.id],
  );
  assert.equal(readable.length, v2ActionCount);
  assert.ok(readable.every((row) => typeof row.channel === "string" && row.scheduled_for));
});

// ─── 2. The unified channel model ───────────────────────────────────────────

test("an Instagram-only campaign stores one channel and only Instagram actions", async () => {
  const spec = payload({ channels: ["instagram"] });
  const container = await build(spec);

  assert.deepEqual(container.channels, ["instagram"], "the campaign's channels are authoritative");
  assert.equal(container.kind, "multi", "still ONE campaign model, not a separate product");
  assert.equal(container.creation_method, "mara");
  assert.equal(container.is_automated, true);

  const actions = await actionsOf(container.id);
  assert.equal(actions.length, 2);
  for (const action of actions) {
    assert.ok(action.channel.startsWith("instagram_"), `${action.channel} is an Instagram action`);
    assert.equal(action.channel === "email", false);
    assert.ok(action.draft_id, "it keeps the existing Post Studio execution identity");
    assert.equal(action.email_campaign_id, null);
  }
  const children = await all(
    "select id from public.voom_campaigns where owner_user_id = $1 and parent_campaign_id = $2",
    [OWNER_A, container.id],
  );
  assert.equal(children.length, 0, "no email child was created");
});

test("an email-only campaign stores one channel and only email actions", async () => {
  const spec = payload({ channels: ["email"] });
  const container = await build(spec);

  assert.deepEqual(container.channels, ["email"]);
  assert.equal(container.kind, "multi");

  const actions = await actionsOf(container.id);
  assert.equal(actions.length, 2);
  for (const action of actions) {
    assert.equal(action.channel, "email");
    assert.ok(action.email_campaign_id, "it keeps the existing email delivery identity");
    assert.equal(action.draft_id, null);
  }
  const drafts = await all(
    `select d.id from public.mara_drafts d
       join public.voom_campaign_actions a on a.draft_id = d.id
      where a.owner_user_id = $1 and a.campaign_id = $2`,
    [OWNER_A, container.id],
  );
  assert.equal(drafts.length, 0, "no Instagram draft was created");

  // The email child still carries the whole 0018/0041 delivery shape.
  const child = await one(
    "select subject, preview_text, content, status, proposed_send_at, channels from public.voom_campaigns where id = $1",
    [actions[0].email_campaign_id],
  );
  assert.ok(child.subject && child.content.length > 10 && child.proposed_send_at);
  assert.deepEqual(child.channels, ["email"]);
});

test("an Instagram + Email campaign holds both, in one ordered timeline", async () => {
  const spec = payload({ channels: ["instagram", "email"] });
  const container = await build(spec);
  assert.deepEqual(container.channels, ["instagram", "email"]);

  const actions = await actionsOf(container.id);
  assert.equal(actions.length, 4);
  assert.deepEqual(actions.filter((a) => a.channel === "email").length, 2);
  assert.deepEqual(actions.filter((a) => a.channel.startsWith("instagram_")).length, 2);

  // ONE timeline: slots are contiguous and follow the real schedule.
  actions.forEach((action, index) => assert.equal(action.slot, index));
  for (let i = 1; i < actions.length; i += 1) {
    assert.ok(actions[i].scheduled_for >= actions[i - 1].scheduled_for, "ordered earliest-first");
  }
  const families = actions.map((action) => (action.channel === "email" ? "email" : "instagram"));
  assert.ok(families.includes("email") && families.includes("instagram"));
});

test("a v2-shaped build still works: channels default to both and the method defaults to MARA", async () => {
  const spec = payload({ channels: undefined, creationMethod: undefined });
  const container = await build(spec);
  assert.deepEqual(container.channels, ["instagram", "email"], "existing callers keep the v2 behaviour");
  assert.equal(container.creation_method, "mara");
  assert.equal((await actionsOf(container.id)).length, 4);
});

// ─── 3. Invalid combinations fail server-side ───────────────────────────────

test("an action on a channel the campaign did not select is refused by the database", async () => {
  // Through the build RPC.
  const spec = payload({
    channels: ["instagram"],
    actions: [{
      channel: "email", stage: "consideration", title: "Sneaked-in email", purpose: "",
      scheduledFor: at(2, 6), status: "needs_approval", subject: "Hi", previewText: "",
      body: "Body", cta: "Shop", contentSource: "deterministic", content: {},
    }],
  });
  await assert.rejects(build(spec), /campaign_action_channel_not_selected/, "the RPC refuses the combination");

  // And on a direct write, through the 0045 trigger.
  const container = await build(payload({ channels: ["instagram"] }));
  const draft = await one(
    `insert into public.mara_drafts (conversation_id, owner_user_id, kind, channel, title, content, proposed_publish_at, status)
     select conversation_id, owner_user_id, kind, channel, title, content, proposed_publish_at, status
       from public.mara_drafts where owner_user_id = $1 limit 1
     returning id`,
    [OWNER_A],
  ).catch(async () => {
    const conversation = await one(
      "select id from public.mara_conversations where owner_user_id = $1 limit 1", [OWNER_A],
    );
    return one(
      `insert into public.mara_drafts (conversation_id, owner_user_id, kind, channel, title, content, proposed_publish_at, status)
       values ($1, $2, 'instagram_post', 'Instagram Post · 4:5', 'Direct draft', 'Caption', $3, 'draft') returning id`,
      [conversation.id, OWNER_A, at(3, 10)],
    );
  });

  const direct = await errorOf(one(
    `insert into public.voom_campaign_actions
       (owner_user_id, campaign_id, slot, channel, stage, title, purpose, scheduled_for, status,
        email_campaign_id, idempotency_key)
     values ($1, $2, 9, 'email', 'consideration', 'Direct email', '', $3, 'needs_approval', $4, $5)`,
    [OWNER_A, container.id, at(3, 6), draft.id, nextKey("d")],
  ));
  assert.match(direct ?? "", /campaign_action_channel_not_selected/, "the trigger is the last line of defence");

  // The same insert on a channel the campaign DID select is accepted.
  const okAction = await one(
    `insert into public.voom_campaign_actions
       (owner_user_id, campaign_id, slot, channel, stage, title, purpose, scheduled_for, status,
        draft_id, idempotency_key)
     values ($1, $2, 9, 'instagram_post', 'consideration', 'Direct post', '', $3, 'needs_approval', $4, $5)
     returning channel`,
    [OWNER_A, container.id, at(3, 10), draft.id, nextKey("d")],
  );
  assert.equal(okAction.channel, "instagram_post");
});

test("a retired or invented channel can never be stored on a campaign", async () => {
  for (const channels of [["sms"], ["instagram", "sms"], ["email", "sms", "instagram"], ["push"], []]) {
    const spec = payload({ channels, actions: [] , creationMethod: "self" });
    await assert.rejects(
      build(spec),
      /invalid_campaign_channels/,
      `${JSON.stringify(channels)} must be refused`,
    );
  }

  // And the column CHECK refuses a direct write too.
  const container = await build(payload({ channels: ["email"], creationMethod: "self", actions: [] }));
  const direct = await errorOf(one(
    "update public.voom_campaigns set channels = $2 where id = $1 returning id",
    [container.id, ["sms"]],
  ));
  assert.match(direct ?? "", /voom_campaigns_channels_check|23514/, "the allowlist is enforced by the schema");

  const tooMany = await errorOf(one(
    "update public.voom_campaigns set channels = $2 where id = $1 returning id",
    [container.id, ["email", "email"]],
  ));
  assert.match(tooMany ?? "", /voom_campaigns_channels_check|23514/, "a repeated channel is refused");

  const empty = await errorOf(one(
    "update public.voom_campaigns set channels = $2 where id = $1 returning id",
    [container.id, []],
  ));
  assert.match(empty ?? "", /voom_campaigns_channels_check|23514/, "an empty selection is refused");
});

test("a campaign container always has channels; the creation method has its own vocabulary", async () => {
  const container = await build(payload({ channels: ["instagram"], creationMethod: "self", actions: [] }));

  const nullChannels = await errorOf(one(
    "update public.voom_campaigns set channels = null where id = $1 returning id", [container.id],
  ));
  assert.match(nullChannels ?? "", /voom_campaigns_container_channels_check|23514/,
    "a container can never lose its authoritative channels");

  const badMethod = await errorOf(one(
    "update public.voom_campaigns set creation_method = 'manual' where id = $1 returning id", [container.id],
  ));
  assert.match(badMethod ?? "", /voom_campaigns_creation_method_check|23514/,
    "an automation-mode word is not a creation method");

  const automation = await one("select automation_level from public.businesses where owner_user_id = $1", [OWNER_A]);
  assert.equal(automation.automation_level, "assisted", "the automation mode still lives on the business");
  assert.equal(container.creation_method, "self", "and the creation method on the campaign");
});

// ─── 4. Create myself ───────────────────────────────────────────────────────

test("a self-created campaign claims no generation layer and no strategy", async () => {
  const key = nextKey("s");
  const container = await build(payload({
    key,
    channels: ["instagram", "email"],
    creationMethod: "self",
    generationSource: null,
    status: "proposed",
  }));

  assert.equal(container.creation_method, "self");
  assert.equal(container.generation_source, null, "nothing generated it, so nothing is claimed");
  assert.equal(container.strategy, null, "no strategy is invented for the user");
  assert.equal(container.strategy_summary, null);
  assert.deepEqual(container.channels, ["instagram", "email"]);

  const actions = await actionsOf(container.id);
  assert.equal(actions.length, 4);
  for (const action of actions) {
    assert.equal(action.content_source, "edited", "the user wrote this content");
    assert.equal(action.status, "proposed", "the caller's mode gating is stored as given");
  }

  const generation = await one(
    "select kind, provider, status, detail from public.voom_campaign_generations where owner_user_id = $1 and idempotency_key = $2",
    [OWNER_A, key],
  );
  assert.deepEqual(
    { kind: generation.kind, provider: generation.provider, status: generation.status },
    { kind: "build", provider: "self", status: "self" },
    "the audit row says a person wrote it — not MARA, and not a fallback",
  );
  assert.deepEqual(generation.detail.creationMethod, "self");
  assert.deepEqual([...generation.detail.channels].sort(), ["email", "instagram"]);
});

test("a self-created campaign may start empty and grow one action at a time", async () => {
  const container = await build(payload({ channels: ["instagram", "email"], creationMethod: "self", actions: [] }));
  assert.equal((await actionsOf(container.id)).length, 0, "an empty campaign is a real draft");

  // A MARA build must still produce a plan.
  await assert.rejects(
    build(payload({ channels: ["instagram", "email"], creationMethod: "mara", actions: [] })),
    /invalid_action_count/,
    "an empty plan is not a MARA campaign",
  );
});

test("add_campaign_action appends one action, keeps slots ordered and is idempotent", async () => {
  const container = await build(payload({ channels: ["instagram", "email"], creationMethod: "self", actions: [] }));
  const addKey = nextKey("a");

  const added = await one(
    "select * from public.add_campaign_action($1::uuid, $2::uuid, $3::jsonb)",
    [OWNER_A, container.id, JSON.stringify({
      idempotencyKey: addKey,
      channel: "instagram_reel", stage: "awareness", title: "Launch Reel",
      purpose: "Open the campaign.", scheduledFor: at(1, 14), status: "needs_approval",
      caption: "Our Summer Sale starts now.", concept: "Launch Reel",
      contentSource: "edited", content: { format: "reel", concept: "Launch Reel", script: ["Open", "Show", "Close"] },
    })],
  );
  assert.equal(added.slot, 0, "the first added action takes the first slot");
  assert.equal(added.channel, "instagram_reel");
  assert.equal(added.content_source, "edited");
  assert.ok(added.draft_id, "it reuses the existing Post Studio draft identity");
  assert.equal(added.email_campaign_id, null);

  // Replay creates nothing twice.
  const replay = await one(
    "select * from public.add_campaign_action($1::uuid, $2::uuid, $3::jsonb)",
    [OWNER_A, container.id, JSON.stringify({
      idempotencyKey: addKey, channel: "instagram_reel", title: "Launch Reel",
      scheduledFor: at(1, 14), status: "needs_approval",
    })],
  );
  assert.equal(replay.id, added.id, "the replay returns the same action");
  assert.equal((await actionsOf(container.id)).length, 1, "no duplicate row");

  // A second action appends, and an email action gets an email child.
  const emailKey = nextKey("a");
  const emailAction = await one(
    "select * from public.add_campaign_action($1::uuid, $2::uuid, $3::jsonb)",
    [OWNER_A, container.id, JSON.stringify({
      idempotencyKey: emailKey,
      channel: "email", stage: "consideration", title: "Announcement email",
      purpose: "Explain the offer.", scheduledFor: at(2, 6), status: "needs_approval",
      subject: "Our Summer Sale is live", previewText: "Ten days only.",
      body: "Hi,\n\nThe sale is live.\n\nCTA: Shop", contentSource: "edited", content: { cta: "Shop" },
    })],
  );
  assert.equal(emailAction.slot, 1);
  assert.ok(emailAction.email_campaign_id, "the email child campaign exists");
  assert.equal(emailAction.draft_id, null);

  const child = await one(
    "select subject, content, status, creation_method, channels, parent_campaign_id from public.voom_campaigns where id = $1",
    [emailAction.email_campaign_id],
  );
  assert.equal(child.subject, "Our Summer Sale is live");
  assert.equal(child.creation_method, "self", "the child follows its container");
  assert.deepEqual(child.channels, ["email"]);
  assert.equal(child.parent_campaign_id, container.id);
  assert.equal(child.status, "draft", "an unapproved action is a draft, never approved");

  const generations = await all(
    "select kind, provider, status, action_id from public.voom_campaign_generations where owner_user_id = $1 and campaign_id = $2 and kind = 'action_add'",
    [OWNER_A, container.id],
  );
  assert.equal(generations.length, 2, "each added action is audited exactly once");
  assert.ok(generations.every((row) => row.provider === "self" && row.status === "self"));
});

test("add_campaign_action refuses a channel the campaign did not select", async () => {
  const container = await build(payload({ channels: ["instagram"], creationMethod: "self", actions: [] }));

  await assert.rejects(
    one("select * from public.add_campaign_action($1::uuid, $2::uuid, $3::jsonb)", [
      OWNER_A, container.id, JSON.stringify({
        idempotencyKey: nextKey("x"), channel: "email", title: "Not allowed",
        scheduledFor: at(1, 6), subject: "Hi", body: "Body", status: "needs_approval",
      }),
    ]),
    /campaign_action_channel_not_selected/,
    "an email cannot be added to an Instagram-only campaign",
  );

  const retired = await errorOf(one(
    "select * from public.add_campaign_action($1::uuid, $2::uuid, $3::jsonb)",
    [OWNER_A, container.id, JSON.stringify({
      idempotencyKey: nextKey("x"), channel: "sms", title: "Retired", scheduledFor: at(1, 6),
    })],
  ));
  assert.match(retired ?? "", /invalid_action_channel/, "a retired action channel is refused");

  const wrongCampaign = await errorOf(one(
    "select * from public.add_campaign_action($1::uuid, $2::uuid, $3::jsonb)",
    [OWNER_B, container.id, JSON.stringify({
      idempotencyKey: nextKey("x"), channel: "instagram_post", title: "Other workspace", scheduledFor: at(1, 6),
    })],
  ));
  assert.match(wrongCampaign ?? "", /campaign_not_found/, "another workspace cannot extend this campaign");
  assert.equal((await actionsOf(container.id)).length, 0, "nothing was written");
});

test("an approved added Instagram action mirrors to the calendar but never to the publish queue", async () => {
  const container = await build(payload({ channels: ["instagram"], creationMethod: "self", actions: [] }));
  const added = await one(
    "select * from public.add_campaign_action($1::uuid, $2::uuid, $3::jsonb)",
    [OWNER_A, container.id, JSON.stringify({
      idempotencyKey: nextKey("p"), channel: "instagram_post", stage: "awareness", title: "Approved post",
      purpose: "Autopilot-safe.", scheduledFor: at(2, 15), status: "approved",
      caption: "Summer Sale.", concept: "Approved post", contentSource: "edited", content: { format: "post", script: [] },
    })],
  );
  assert.equal(added.status, "approved");

  const mirror = await one(
    "select channel, status, source_draft_id from public.content_calendar_items where owner_user_id = $1 and source_draft_id = $2",
    [OWNER_A, added.draft_id],
  );
  assert.equal(mirror.status, "approved", "the mirror is an approved draft, never a scheduled publish");
  assert.equal(mirror.channel, "Instagram");

  const queued = await one(
    `select count(*)::int as n from public.instagram_publish_queue q
       join public.voom_campaign_actions a on a.draft_id = q.draft_id
      where q.owner_user_id = $1 and a.campaign_id = $2`,
    [OWNER_A, container.id],
  );
  assert.equal(queued.n, 0, "no publish job exists: the draft has no visual");

  const media = await one("select count(*)::int as n from public.mara_media_generations where owner_user_id = $1", [OWNER_A]);
  assert.equal(media.n, 0, "no paid media was generated");
  const credits = await one("select count(*)::int as n from public.voom_credit_ledger where owner_user_id = $1", [OWNER_A]);
  assert.equal(credits.n, 0, "no credit was reserved or spent");
});

// ─── 5. Schedule validation and editability ─────────────────────────────────

test("schedule validation still holds for v3 campaigns and added actions", async () => {
  const container = await build(payload({ channels: ["instagram", "email"] }));

  // Past.
  const past = await errorOf(one(
    "select * from public.add_campaign_action($1::uuid, $2::uuid, $3::jsonb)",
    [OWNER_A, container.id, JSON.stringify({
      idempotencyKey: nextKey("t"), channel: "instagram_post", title: "In the past",
      scheduledFor: new Date(Date.now() - DAY).toISOString(), status: "needs_approval",
    })],
  ));
  assert.match(past ?? "", /campaign_action_schedule_in_past/);

  // Before the campaign starts.
  const beforeStart = await errorOf(one(
    "select * from public.add_campaign_action($1::uuid, $2::uuid, $3::jsonb)",
    [OWNER_A, container.id, JSON.stringify({
      idempotencyKey: nextKey("t"), channel: "instagram_post", title: "Too early",
      scheduledFor: new Date(Date.now() + 30 * 60_000).toISOString(), status: "needs_approval",
    })],
  ));
  assert.match(beforeStart ?? "", /campaign_action_before_campaign_start/);

  // After the campaign ends.
  const afterEnd = await errorOf(one(
    "select * from public.add_campaign_action($1::uuid, $2::uuid, $3::jsonb)",
    [OWNER_A, container.id, JSON.stringify({
      idempotencyKey: nextKey("t"), channel: "instagram_post", title: "Too late",
      scheduledFor: new Date(Date.now() + 200 * DAY).toISOString(), status: "needs_approval",
    })],
  ));
  assert.match(afterEnd ?? "", /campaign_action_after_campaign_end/);

  // Moving an EXISTING action into the past is refused too.
  const [action] = await actionsOf(container.id);
  const moved = await errorOf(one(
    "select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)",
    [OWNER_A, action.id, JSON.stringify({ scheduledFor: new Date(Date.now() - DAY).toISOString() })],
  ));
  assert.match(moved ?? "", /campaign_action_schedule_in_past/);
});

test("an unsent action is editable and an executed one is not, on both v3 paths", async () => {
  const container = await build(payload({ channels: ["email"], creationMethod: "self", status: "proposed" }));
  const [action] = await actionsOf(container.id);
  assert.equal(action.channel, "email");

  // Before any send: editable.
  const edited = await one(
    "select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)",
    [OWNER_A, action.id, JSON.stringify({ subject: "Rewritten subject", body: "Hi,\n\nRewritten body.\n\nCTA: Shop" })],
  );
  assert.equal(edited.content_source, "edited");
  const child = await one("select subject, content from public.voom_campaigns where id = $1", [action.email_campaign_id]);
  assert.equal(child.subject, "Rewritten subject");
  assert.match(child.content, /Rewritten body/);

  // Once a real send exists the content is frozen — provider truth wins.
  const recipient = await one(
    "insert into public.campaign_recipients (owner_user_id, campaign_id, kind, contact, contact_name, consent_at, consent_source) values ($1, $2, 'email', 'merchant@example.com', 'Merchant', now(), 'import') returning id",
    [OWNER_A, action.email_campaign_id],
  );
  await one(
    `insert into public.campaign_sends
       (owner_user_id, campaign_id, recipient_id, channel, provider, internal_status, attempts, claimed_at, accepted_at, idempotency_key)
     values ($1, $2, $3, 'email', 'resend', 'accepted', 1, now(), now(), $4)`,
    [OWNER_A, action.email_campaign_id, recipient.id, nextKey("send0000000000000000")],
  );

  await assert.rejects(
    one("select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)",
      [OWNER_A, action.id, JSON.stringify({ subject: "Falsified after sending" })]),
    /campaign_action_locked/,
    "a provider-accepted email can never be rewritten",
  );

  const unchanged = await one("select subject from public.voom_campaigns where id = $1", [action.email_campaign_id]);
  assert.equal(unchanged.subject, "Rewritten subject", "history is not falsified");
});

test("an Instagram action stays editable until it is publishing, then locks", async () => {
  const container = await build(payload({ channels: ["instagram"], creationMethod: "self" }));
  const [action] = await actionsOf(container.id);
  assert.ok(action.draft_id);

  const edited = await one(
    "select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)",
    [OWNER_A, action.id, JSON.stringify({ caption: "A rewritten caption.", title: "Rewritten title" })],
  );
  assert.equal(edited.content_source, "edited");

  // A real queue row that Meta owns makes the action immutable.
  await one(
    `insert into public.instagram_publish_queue
       (owner_user_id, draft_id, idempotency_key, media_kind, caption, scheduled_at, status)
     values ($1, $2, $3, 'image', 'A rewritten caption.', $4, 'publishing')`,
    [OWNER_A, action.draft_id, nextKey("pq000000000000000000"), at(3, 12)],
  );
  await assert.rejects(
    one("select * from public.update_campaign_action_content($1::uuid, $2::uuid, $3::jsonb, null, false)",
      [OWNER_A, action.id, JSON.stringify({ caption: "Rewritten after publishing started." })]),
    /campaign_action_locked/,
    "a publishing Instagram item can never be rewritten",
  );
});

// ─── 6. Approval states, modes and ownership ────────────────────────────────

test("only review states can be persisted, so no build can claim an execution", async () => {
  for (const status of ["executed", "scheduled", "sending", "published", "delivered"]) {
    await assert.rejects(
      build(payload({
        channels: ["instagram"],
        status,
        actions: [{
          channel: "instagram_post", stage: "awareness", title: "Bad status", purpose: "",
          scheduledFor: at(1, 10), status, concept: "Bad status", caption: "Caption.", hashtags: [],
          contentSource: "deterministic", content: { format: "post", script: [] },
        }],
      })),
      /invalid_action_status/,
      `${status} must be refused`,
    );
  }
  // The three states the mode gating can produce are all accepted.
  for (const status of ["proposed", "needs_approval", "approved"]) {
    const container = await build(payload({
      channels: ["instagram"],
      actions: [{
        channel: "instagram_post", stage: "awareness", title: `Mode ${status}`, purpose: "",
        scheduledFor: at(1, 10), status, concept: `Mode ${status}`, caption: "Caption.", hashtags: [],
        contentSource: "deterministic", content: { format: "post", script: [] },
      }],
    }));
    const [action] = await actionsOf(container.id);
    assert.equal(action.status, status);
  }
});

test("email approval is still state-only: nothing is sent by approving", async () => {
  const container = await build(payload({ channels: ["email"], creationMethod: "self" }));
  const [action] = await actionsOf(container.id);

  const approved = await one(
    "select * from public.set_campaign_action_email_approval($1::uuid, $2::uuid, 'approve')",
    [OWNER_A, action.id],
  );
  assert.equal(approved.status, "approved");
  const child = await one("select status, approved_at from public.voom_campaigns where id = $1", [action.email_campaign_id]);
  assert.equal(child.status, "approved");
  assert.ok(child.approved_at, "the approval is timestamped");

  const sends = await one(
    `select count(*)::int as n from public.campaign_sends s
       join public.voom_campaigns c on c.id = s.campaign_id
      where s.owner_user_id = $1 and c.parent_campaign_id = $2`,
    [OWNER_A, container.id],
  );
  assert.equal(sends.n, 0, "approving never sends");

  const rejected = await one(
    "select * from public.set_campaign_action_email_approval($1::uuid, $2::uuid, 'reject')",
    [OWNER_A, action.id],
  );
  assert.equal(rejected.status, "skipped");
});

test("v3 campaign rows stay owner-scoped and the new function is service-role only", async () => {
  const container = await build(payload({ channels: ["instagram", "email"] }), OWNER_A);

  const other = await all(
    "select id from public.voom_campaign_actions where owner_user_id = $1 and campaign_id = $2",
    [OWNER_B, container.id],
  );
  assert.equal(other.length, 0, "another workspace sees nothing");

  const crossOwner = await errorOf(one(
    "select * from public.add_campaign_action($1::uuid, $2::uuid, $3::jsonb)",
    [OWNER_B, container.id, JSON.stringify({
      idempotencyKey: nextKey("z"), channel: "email", title: "Cross-owner", scheduledFor: at(2, 6),
      subject: "Hi", body: "Body", status: "needs_approval",
    })],
  ));
  assert.match(crossOwner ?? "", /campaign_not_found/);

  const grants = await all(`
    select p.proname,
           has_function_privilege('service_role', p.oid, 'execute') as svc,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as auth
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('add_campaign_action', 'create_automated_campaign', 'guard_campaign_action_channel')
  `);
  assert.equal(grants.length, 3);
  for (const row of grants) {
    assert.equal(row.svc, true, `${row.proname} is callable by service_role`);
    assert.equal(row.anon, false, `${row.proname} is not callable by anon`);
    assert.equal(row.auth, false, `${row.proname} is not callable by authenticated`);
  }
});

test("v3 creation writes nothing external: no send, no publish, no media, no credit", async () => {
  // A workspace of its own, so the counts are about campaign creation only and
  // not about the delivery fixtures the editability tests above install.
  const clean = { audienceId: AUD_C, key: nextKey("n") };
  const containerAll = await build(payload({ ...clean, channels: ["instagram", "email"], creationMethod: "self" }), OWNER_C);
  const containerIg = await build(payload({ ...clean, channels: ["instagram"], creationMethod: "mara" }), OWNER_C);
  const containerEmail = await build(payload({ ...clean, channels: ["email"], creationMethod: "mara" }), OWNER_C);
  assert.ok(containerAll.id && containerIg.id && containerEmail.id);

  for (const [table, why] of [
    ["campaign_sends", "no email was sent"],
    ["instagram_publish_queue", "no Instagram publish job was queued"],
    ["mara_media_generations", "no paid image or video was generated"],
    ["voom_credit_ledger", "no credit was reserved or spent"],
    ["post_draft_assets", "every campaign draft still needs a visual"],
  ]) {
    const row = await one(`select count(*)::int as n from public.${table} where owner_user_id = $1`, [OWNER_C]);
    assert.equal(row.n, 0, why);
  }
});
