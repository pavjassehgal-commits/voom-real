/**
 * MARA Campaign Intelligence (Automated Campaigns v2) — behaviour + safety.
 *
 * The pure modules (`lib/campaign/strategy.ts`, `lib/campaign/planner.ts`) and
 * the REAL text-AI adapter (`lib/ai/openai-compatible.ts`) are executed for
 * real through the server-only/@ alias shim, with `fetch` stubbed — no live
 * provider, no credentials, no media, no send, no publish, no cron.
 *
 * Provider-touching orchestration (`lib/campaign/server.ts`, the routes) is
 * asserted on source text, matching the rest of this suite; the real-database
 * guarantees live in mara-campaign-intelligence-pglite.test.mjs.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { AiError } = await import("../lib/ai/types.ts");
const { OpenAiCompatibleProvider } = await import("../lib/ai/openai-compatible.ts");
const { planCampaign, campaignSpanDays } = await import("../lib/campaign/planner.ts");
const {
  CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT,
  applyCampaignIntelligence,
  buildCampaignIntelligenceContext,
  buildCampaignPerformanceContext,
  campaignIntelligenceJsonSchema,
  campaignIntelligenceSchema,
  campaignStrategySummary,
  deterministicStrategy,
} = await import("../lib/campaign/strategy.ts");
const { generateCampaignIntelligence } = await import("../lib/campaign/intelligence.ts");
const { MAX_CAMPAIGN_ACTIONS, MAX_EMAIL_ACTIONS, CAMPAIGN_ACTION_CHANNELS } = await import("../lib/campaign/types.ts");

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** Comments are documentation, not code paths: provider checks scan code only. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*(\/\/|--).*$/gm, "");

const NOW = new Date("2026-09-20T12:00:00.000Z");
const BRAND = {
  brandName: "SynraPay",
  brandDescription: "A payments startup that lets small merchants take card and wallet payments from a single dashboard.",
  industry: "Fintech",
  targetCustomer: ["Small merchants", "Online sellers"],
  brandPersonality: ["plain-spoken", "confident"],
  mainGoal: "Get merchants onto the new dashboard",
};
const BRIEF = {
  name: "SynraPay website is now LIVE",
  goal: "announce",
  startAt: "2026-09-22",
  endAt: "2026-10-01",
  offerDetails: "",
  targetAudience: "Existing SynraPay merchants",
  notes: "Point people at the new site.",
};

const skeleton = () => planCampaign({ brief: BRIEF, brand: BRAND, now: NOW });

const PERFORMANCE = {
  sampleSize: 12,
  confidence: "moderate",
  bestContentTypeLabel: "Reels",
  winnerLabels: ["Reels about “onboarding”"],
  engagementSignals: ["Saves are up on how-to content"],
  basis: "reach (accounts reached)",
  windowDays: 30,
  strongestTopicLabel: "onboarding",
  underperformerLabels: ["Posts about “pricing”"],
};

/**
 * A valid MARA response for the supplied skeleton: distinct copy per action
 * (per stage), per-channel shapes, and a Reel that carries a script + visual
 * direction. Copy varies per action on purpose — a real response that repeated
 * itself would be refused by the merge, which is asserted separately.
 */
function intelligenceFor(plan, mutate) {
  const emailSlots = plan.actions.filter((a) => a.channel === "email");
  const igSlots = plan.actions.filter((a) => a.channel !== "email");
  const EMAIL_ANGLES = [
    {
      subject: "The SynraPay website is live — here is what changed for you",
      previewText: "One dashboard for card and wallet payments, now public.",
      body: "Hi,\n\nThe SynraPay website is now live. Your existing payment setup carries over unchanged, and the new dashboard puts settlement history and payout dates in one place.\n\nNothing is required from you today. When you next log in, take a look at the payouts page — it now shows the exact date funds land.\n\nIf something looks wrong, reply to this email and a human will pick it up.\n\nCTA: Open the new dashboard",
      cta: "Open the new dashboard",
      purpose: "Announces the launch to existing merchants and states plainly that nothing breaks.",
    },
    {
      subject: "Where your payouts land now that the site is live",
      previewText: "The payouts page shows the exact date funds arrive.",
      body: "Hi,\n\nFollowing the launch, the question we hear most is: when does the money actually arrive?\n\nThe payouts page now lists every settlement with the date it lands in your bank account, so you no longer have to work it out from a statement. Exporting a month of settlements takes one click.\n\nHave a look at last week's settlements and tell us if anything is unclear.\n\nCTA: Check this week's payouts",
      cta: "Check this week's payouts",
      purpose: "Explains the concrete benefit of the new site for merchants who already process with SynraPay.",
    },
    {
      subject: "Last look: the SynraPay dashboard is ready for you",
      previewText: "Two minutes to set up your team's access.",
      body: "Hi,\n\nThis is the last note about the launch. The dashboard is live, your payment methods are already connected, and the only thing left is to invite anyone on your team who reconciles the accounts.\n\nIf you would rather we walked you through it, reply with a time and we will set up fifteen minutes.\n\nCTA: Invite your team",
      cta: "Invite your team",
      purpose: "Final, direct next step for merchants who have not opened the dashboard yet.",
    },
    {
      subject: "Your SynraPay account moved to the new site",
      previewText: "Same login, one clearer place for everything.",
      body: "Hi,\n\nYour account now runs on the new SynraPay website. Your login is unchanged.\n\nWhat is different: settlement history, payout dates and payment methods live on one page instead of three.\n\nCTA: Sign in to the new site",
      cta: "Sign in to the new site",
      purpose: "Reassures merchants that the move needs no action from them.",
    },
  ];
  const IG_ANGLES = [
    { concept: "Launch announcement", hook: "The SynraPay site is finally live", caption: "The SynraPay website is live. Settlement history, payout dates and your payment methods now sit in one dashboard. Built with merchants who asked for fewer tabs.", cta: "See the new site", direction: "Clean product screenshot on a dark desk, single light source." },
    { concept: "Payouts explained", hook: "Where your money actually lands", caption: "Every settlement now shows the exact date it reaches your bank account. No more working it out from a statement at the end of the month.", cta: "Read the payout guide", direction: "Screen recording of the payouts page scrolling to a highlighted date." },
    { concept: "Behind the build", hook: "We rebuilt this around one question", caption: "Merchants kept asking the same thing: when does the money land. The new site was built to answer that in one screen, with the export button next to it.", cta: "Follow for the build notes", direction: "Handheld desk shot of the dashboard on a laptop, ending on the brand mark." },
    { concept: "Closing reminder", hook: "Still on the old bookmarks?", caption: "The new SynraPay site has been live for a week. Update your bookmark — the old links redirect, but the dashboard is faster.", cta: "Update your bookmark", direction: "Split frame of the old and new navigation, ending on the new one." },
  ];

  const actions = plan.actions.map((action) => {
    if (action.channel === "email") {
      const index = emailSlots.indexOf(action);
      const angle = EMAIL_ANGLES[index % EMAIL_ANGLES.length];
      return {
        slot: action.slot,
        channel: "email",
        title: `Email ${index + 1}: ${angle.concept ?? angle.subject.slice(0, 40)}`,
        email: {
          purpose: `${angle.purpose} (email ${index + 1} of ${emailSlots.length})`,
          subject: angle.subject,
          previewText: angle.previewText,
          body: angle.body,
          cta: angle.cta,
          ctaUrl: null,
          audienceNote: "Existing merchants who already process with SynraPay.",
          sendTimeNote: "Mid-morning, when merchants are reconciling.",
          proposedSendAt: null,
        },
        instagram: null,
      };
    }
    const index = igSlots.indexOf(action);
    const angle = IG_ANGLES[index % IG_ANGLES.length];
    const format = action.channel === "instagram_reel" ? "reel" : action.channel === "instagram_story" ? "story" : "post";
    return {
      slot: action.slot,
      channel: action.channel,
      title: `Instagram ${format} ${index + 1}: ${angle.concept}`,
      email: null,
      instagram: {
        format,
        purpose: `Carries the ${angle.concept.toLowerCase()} moment on Instagram (${format} ${index + 1} of ${igSlots.length}).`,
        concept: angle.concept,
        hook: angle.hook,
        caption: angle.caption,
        cta: angle.cta,
        visualDirection: format === "reel" ? angle.direction : `${angle.direction} Static 4:5 frame, no readable text baked in.`,
        script: format === "reel"
          ? [`Open on ${angle.hook.toLowerCase()}`, "Cut to the dashboard with the relevant line highlighted", "End on the brand mark"]
          : [],
        proposedSendAt: null,
      },
    };
  });
  const payload = {
    strategy: {
      objective: "Get existing merchants onto the newly launched SynraPay website.",
      coreMessage: "The SynraPay website is live and your setup already works with it.",
      audienceAngle: "Merchants want to know nothing breaks and where their payouts are.",
      narrative: "Announce the launch, prove what the site actually does, then ask for the visit.",
      ctaStrategy: "Open with a look, then a direct visit to the dashboard.",
      sequenceRationale: "Start with a strong launch announcement, follow with a product-benefit Reel, then use email to explain the website in more detail and drive visits.",
    },
    actions,
    performanceNote: null,
  };
  return mutate ? mutate(payload) : payload;
}

const mergeWith = (intelligence, plan = skeleton()) => applyCampaignIntelligence({
  skeleton: plan.actions,
  summary: plan.summary,
  brief: BRIEF,
  brand: BRAND,
  goalLabel: "Announce something",
  intelligence,
  now: NOW,
});

// ─── 1. The deterministic skeleton stays authoritative ─────────────────────

test("the deterministic skeleton stays authoritative: MARA cannot add, drop or re-channel actions", async () => {
  const plan = skeleton();
  const valid = mergeWith(intelligenceFor(plan), plan);

  assert.equal(valid.actions.length, plan.actions.length, "MARA cannot change the action count");
  assert.ok(plan.actions.length <= MAX_CAMPAIGN_ACTIONS, "the cap still comes from the planner");
  valid.actions.forEach((action, index) => {
    assert.equal(action.slot, index, "slots stay contiguous");
    assert.equal(action.channel, [...plan.actions].sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))[index].channel
      ?? action.channel);
    assert.ok(CAMPAIGN_ACTION_CHANNELS.includes(action.channel), "only Email + Instagram channels exist");
  });

  // MARA invents three extra actions and re-channels one email into a Reel.
  const hostile = intelligenceFor(plan, (payload) => {
    payload.actions = payload.actions.map((action) => (
      action.channel === "email" ? { ...action, channel: "instagram_reel", email: null, instagram: payload.actions.find((a) => a.instagram)?.instagram ?? null } : action
    ));
    payload.actions.push(
      { slot: 90, channel: "instagram_post", title: "Invented", email: null, instagram: { format: "post", purpose: "x", concept: "x", hook: "", caption: "Extra invented post", cta: "Look", visualDirection: "", script: [], proposedSendAt: null } },
      { slot: 91, channel: "sms", title: "Invented SMS", email: null, instagram: null },
      { slot: 92, channel: "email", title: "Invented email", email: null, instagram: null },
    );
    return payload;
  });
  const refused = mergeWith(hostile, plan);
  assert.equal(refused.actions.length, plan.actions.length, "invented actions are dropped, never inserted");
  assert.ok(refused.actions.every((action) => action.channel !== "sms"), "SMS can never be introduced by the model");
  // Every slot whose channel or payload did not match kept its deterministic draft.
  assert.ok(refused.fallbackSlots.length > 0, "a re-channelled slot falls back to the deterministic draft");
  for (const slot of refused.fallbackSlots) {
    const merged = refused.actions.find((action) => action.slot === slot);
    const original = plan.actions.find((action) => action.slot === slot);
    assert.equal(merged.channel, original.channel, "the skeleton's channel wins");
    assert.equal(merged.contentSource, "deterministic");
  }
});

test("MARA cannot move an action outside its own campaign day, so the timeline stays spread out", async () => {
  const plan = skeleton();
  const collapsed = intelligenceFor(plan, (payload) => {
    // Try to pull every action onto the first campaign day at 09:00 Dubai.
    for (const action of payload.actions) {
      const target = action.email ?? action.instagram;
      target.proposedSendAt = "2026-09-22T09:00:00+04:00";
    }
    return payload;
  });
  const merged = mergeWith(collapsed, plan);
  const days = new Set(merged.actions.map((action) => action.scheduledFor.slice(0, 10)));
  const skeletonDays = new Set(plan.actions.map((action) => action.scheduledFor.slice(0, 10)));
  assert.deepEqual([...days].sort(), [...skeletonDays].sort(), "out-of-day proposals are refused");
  assert.equal(campaignSpanDays(BRIEF.startAt, BRIEF.endAt), 10);
});

test("a proposed time inside the slot's own day is accepted", async () => {
  const plan = skeleton();
  const first = plan.actions[0];
  const moved = intelligenceFor(plan, (payload) => {
    const target = payload.actions.find((action) => action.slot === first.slot);
    (target.email ?? target.instagram).proposedSendAt = "2026-09-22T18:30:00+04:00";
    return payload;
  });
  const merged = mergeWith(moved, plan);
  const action = merged.actions.find((item) => item.slot === 0);
  assert.equal(action.scheduledFor, new Date("2026-09-22T18:30:00+04:00").toISOString());
});

// ─── 2. Context handed to MARA ─────────────────────────────────────────────

test("MARA receives the real business, campaign, audience, mode and skeleton context", async () => {
  const plan = skeleton();
  const context = buildCampaignIntelligenceContext({
    businessName: BRAND.brandName,
    brand: BRAND,
    brief: BRIEF,
    goalLabel: "Announce something",
    audiences: [{ id: "a1", name: "Merchants", eligibleEmailCount: 42 }],
    selectedAudience: { id: "a1", name: "Merchants", eligibleEmailCount: 42 },
    automationMode: "assisted",
    skeleton: plan.actions,
    summary: plan.summary,
    performance: PERFORMANCE,
    now: NOW,
  });

  assert.equal(context.business.name, "SynraPay");
  assert.match(context.business.description, /payments startup/);
  assert.deepEqual(context.brandVoice, ["plain-spoken", "confident"]);
  assert.equal(context.campaign.idea, BRIEF.name);
  assert.equal(context.campaign.goal, "announce");
  assert.equal(context.campaign.goalLabel, "Announce something");
  assert.equal(context.campaign.targetAudience, "Existing SynraPay merchants");
  assert.equal(context.campaign.notes, "Point people at the new site.");
  assert.equal(context.campaign.startsOn, "2026-09-22");
  assert.equal(context.campaign.endsOn, "2026-10-01");
  assert.equal(context.campaign.selectedAudience.name, "Merchants");
  assert.equal(context.campaign.selectedAudience.eligibleEmailCount, 42);
  assert.equal(context.automationMode, "assisted");
  assert.match(context.automationModeRules, /nothing is sent, published or paid for automatically/i);

  // The skeleton — the guardrail — is described slot by slot.
  assert.equal(context.skeleton.slots.length, plan.actions.length);
  assert.equal(context.skeleton.maxActions, MAX_CAMPAIGN_ACTIONS);
  assert.deepEqual(context.skeleton.channelsAllowed, ["email", "instagram_post", "instagram_reel", "instagram_story"]);
  context.skeleton.slots.forEach((slot, index) => {
    assert.equal(slot.slot, plan.actions[index].slot);
    assert.equal(slot.channel, plan.actions[index].channel);
    assert.equal(slot.proposedTime, plan.actions[index].scheduledFor);
    assert.equal(slot.campaignDay, plan.actions[index].dayOffset + 1);
  });

  assert.equal(context.recentPerformance.sampleSize, 12);
  assert.equal(context.recentPerformance.bestFormat, "Reels");

  // Nothing that could leak or spend: no media, no recipients, no secrets.
  const serialized = JSON.stringify(context);
  assert.doesNotMatch(serialized, /seedream|seedance|openrouter|resend|api[_-]?key|bearer/i);
  assert.equal(context.task, "fill_campaign_skeleton");
});

test("the campaign system prompt forbids structural changes, invention and fake sends", async () => {
  assert.match(CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT, /SAME slot index and the SAME channel/);
  assert.match(CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT, /Never invent prices, discounts, offers/);
  assert.match(CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT, /must never restate an email body/);
  assert.match(CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT, /Never claim an email was sent, a post was published, or a visual was generated/);
  assert.match(CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT, /advisory/i);
});

// ─── 3. Schema validation ──────────────────────────────────────────────────

test("the MARA response is schema validated: bad shapes are rejected, not parsed", async () => {
  const plan = skeleton();
  const valid = intelligenceFor(plan);
  assert.ok(campaignIntelligenceSchema.safeParse(valid).success, "a well-formed response parses");

  const invalid = [
    { ...valid, strategy: { ...valid.strategy, objective: "" } },
    { ...valid, strategy: { ...valid.strategy, extraEssay: "a very long essay" } },
    { ...valid, actions: [] },
    { ...valid, actions: [{ slot: 0, channel: "sms", title: "x", email: null, instagram: null }] },
    { ...valid, actions: [{ slot: 0, channel: "email", title: "x", email: { purpose: "p" }, instagram: null }] },
    { ...valid, actions: [{ slot: "zero", channel: "email", title: "x", email: null, instagram: null }] },
    { ...valid, performanceNote: 42 },
    { ...valid, actions: [{ ...valid.actions[0], inventedField: true }] },
  ];
  for (const payload of invalid) {
    assert.equal(campaignIntelligenceSchema.safeParse(payload).success, false, `rejected: ${JSON.stringify(payload).slice(0, 90)}`);
  }
});

test("the provider-side JSON Schema is strict and mirrors the zod schema", async () => {
  assert.equal(campaignIntelligenceJsonSchema.name, "mara_campaign_intelligence");
  assert.equal(campaignIntelligenceJsonSchema.strict, true);

  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${path}[${i}]`)); return; }
    if (!node || typeof node !== "object") return;
    if (node.type === "object" || node.properties) {
      assert.equal(node.additionalProperties, false, `${path} is closed`);
      const props = Object.keys(node.properties ?? {});
      assert.deepEqual([...(node.required ?? [])].sort(), [...props].sort(), `${path} requires every property (strict mode)`);
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
  };
  walk(campaignIntelligenceJsonSchema.schema, "schema");

  // Nullable optionals are unions, never omitted keys.
  const actionProps = campaignIntelligenceJsonSchema.schema.properties.actions.items.properties;
  assert.deepEqual(actionProps.email.type, ["object", "null"]);
  assert.deepEqual(actionProps.instagram.type, ["object", "null"]);
  assert.deepEqual(actionProps.email.properties.ctaUrl.type, ["string", "null"]);
  assert.deepEqual(actionProps.instagram.properties.proposedSendAt.type, ["string", "null"]);
  assert.equal(actionProps.instagram.properties.script.maxItems, 8);
  assert.equal(campaignIntelligenceJsonSchema.schema.properties.actions.maxItems, MAX_CAMPAIGN_ACTIONS);
});

test("the intelligence call goes through the existing MARA text provider over strict json_schema", async () => {
  const CONFIG = { provider: "groq", apiKey: "gsk_test_placeholder", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" };
  const plan = skeleton();
  const payload = intelligenceFor(plan);
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)), headers: init.headers });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
  };

  const result = await generateCampaignIntelligence({ task: "fill_campaign_skeleton" }, {
    ai: new OpenAiCompatibleProvider(CONFIG),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.intelligence, campaignIntelligenceSchema.parse(payload));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.groq.com/openai/v1/chat/completions", "the existing provider endpoint is reused");
  assert.equal(calls[0].headers.Authorization, `Bearer ${CONFIG.apiKey}`);
  assert.equal(calls[0].body.response_format.type, "json_schema");
  assert.equal(calls[0].body.response_format.json_schema.name, "mara_campaign_intelligence");
  assert.equal(calls[0].body.response_format.json_schema.strict, true);
  assert.equal(calls[0].body.messages[0].content, CAMPAIGN_INTELLIGENCE_SYSTEM_PROMPT);
});

// ─── 4. Reliability: AI failure falls back to the deterministic plan ───────

test("a failed or malformed MARA response falls back to the deterministic v1 plan", async () => {
  const plan = skeleton();

  const throwing = await generateCampaignIntelligence({}, {
    ai: { structured: async () => { throw new AiError("not_configured", "MARA's AI provider is not configured."); } },
  });
  assert.deepEqual(throwing, { ok: false, reason: "not_configured" });

  const malformed = await generateCampaignIntelligence({}, {
    ai: { structured: async () => { throw new Error("ZodError: invalid shape"); } },
  });
  assert.deepEqual(malformed, { ok: false, reason: "malformed_response" });

  // With no intelligence the plan is still complete, ordered and deterministic.
  const fallback = mergeWith(null, plan);
  assert.equal(fallback.actions.length, plan.actions.length);
  assert.equal(fallback.source, "deterministic");
  assert.ok(fallback.actions.every((action) => action.contentSource === "deterministic"));
  for (const action of fallback.actions) {
    if (action.channel === "email") {
      assert.ok(action.subject && action.previewText && action.body && action.cta, "the deterministic email is still a complete draft");
    } else {
      assert.ok(action.caption && action.concept, "the deterministic Instagram draft is still complete");
    }
  }
  assert.equal(fallback.strategySummary.length > 0, true, "a campaign always has a strategy line");
  assert.equal(deterministicStrategy({ skeleton: plan.actions, summary: plan.summary, brief: BRIEF, brand: BRAND, goalLabel: "Announce something" }).objective.length > 0, true);
});

test("a single unusable action falls back without breaking the rest of the campaign", async () => {
  const plan = skeleton();
  const partial = intelligenceFor(plan, (payload) => {
    // One email with an empty subject, one Instagram action with a caption that
    // duplicates an email body — both must be refused, the rest kept.
    const emailIndex = payload.actions.findIndex((action) => action.channel === "email");
    payload.actions[emailIndex].email.subject = "";
    const igIndex = payload.actions.findIndex((action) => action.instagram);
    payload.actions[igIndex].instagram.caption = payload.actions.find((action) => action.email).email.body;
    return payload;
  });
  // The empty subject fails the schema itself, so the whole response is unusable.
  assert.equal(campaignIntelligenceSchema.safeParse(partial).success, false);

  const schemaValidButBad = intelligenceFor(plan, (payload) => {
    const igIndex = payload.actions.findIndex((action) => action.instagram);
    const emailIndex = payload.actions.findIndex((action) => action.email);
    // The caption restates an email body verbatim: cross-channel repetition.
    payload.actions[igIndex].instagram.caption = payload.actions[emailIndex].email.body.slice(0, 2000);
    return payload;
  });
  assert.ok(campaignIntelligenceSchema.safeParse(schemaValidButBad).success);
  const merged = mergeWith(schemaValidButBad, plan);
  const igSlot = plan.actions[igIndexOf(plan)].slot;
  const emailSlot = plan.actions.find((action) => action.channel === "email").slot;
  assert.ok(
    merged.fallbackSlots.includes(igSlot) || merged.fallbackSlots.includes(emailSlot),
    "the repeated copy is refused — whichever of the pair comes second keeps the deterministic draft",
  );
  const bodies = merged.actions.filter((a) => a.channel === "email").map((a) => a.body.trim());
  const captions = merged.actions.filter((a) => a.channel !== "email").map((a) => a.caption.trim());
  for (const body of bodies) for (const caption of captions) assert.notEqual(body, caption, "no caption equals an email body after the merge");
  assert.ok(merged.actions.some((action) => action.contentSource === "mara"), "the usable actions are still applied");
});

function igIndexOf(plan) {
  return [...plan.actions].sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor)).findIndex((action) => action.channel !== "email");
}

// ─── 5. Cross-channel copy quality ─────────────────────────────────────────

test("email and Instagram copy complement each other and are never identical", async () => {
  const plan = skeleton();
  const merged = mergeWith(intelligenceFor(plan), plan);
  const emails = merged.actions.filter((action) => action.channel === "email");
  const instagram = merged.actions.filter((action) => action.channel !== "email");
  assert.ok(emails.length >= 1 && instagram.length >= 1);

  const bodies = emails.map((action) => action.body);
  const captions = instagram.map((action) => action.caption);
  for (const body of bodies) {
    for (const caption of captions) {
      assert.notEqual(body.trim(), caption.trim(), "no caption restates an email body");
      assert.ok(!caption.includes(body.slice(0, 120)), "no caption embeds an email body");
    }
  }
  // Two Instagram actions never carry the same caption either.
  assert.equal(new Set(captions.map((c) => c.trim())).size, captions.length, "captions differ per action");

  // And when the model does repeat itself, the merge refuses it.
  const repeated = intelligenceFor(plan, (payload) => {
    const first = payload.actions.find((action) => action.instagram).instagram.caption;
    for (const action of payload.actions) if (action.instagram) action.instagram.caption = first;
    return payload;
  });
  const guarded = mergeWith(repeated, plan);
  const guardedCaptions = guarded.actions.filter((a) => a.channel !== "email").map((a) => a.caption.trim());
  assert.equal(new Set(guardedCaptions).size, guardedCaptions.length, "duplicated captions fall back to distinct deterministic copy");
});

test("repetitive CTAs are limited instead of repeated across every action", async () => {
  const plan = skeleton();
  const sameCta = intelligenceFor(plan, (payload) => {
    for (const action of payload.actions) {
      if (action.email) action.email.cta = "Visit the site";
      if (action.instagram) action.instagram.cta = "Visit the site";
    }
    return payload;
  });
  const merged = mergeWith(sameCta, plan);
  const ctas = merged.actions.map((action) => (action.cta ?? "").trim()).filter(Boolean);
  const counts = new Map();
  for (const cta of ctas) counts.set(cta, (counts.get(cta) ?? 0) + 1);
  assert.ok(Math.max(...counts.values()) <= 2, "no CTA is repeated across the whole campaign");
});

// ─── 6. Per-channel deliverables ───────────────────────────────────────────

test("every email action carries subject, preview text, body, CTA, audience and a proposed time", async () => {
  const plan = skeleton();
  const merged = mergeWith(intelligenceFor(plan), plan);
  const emails = merged.actions.filter((action) => action.channel === "email");
  assert.ok(emails.length >= 2, "a 10-day announce campaign has an email sequence");
  assert.ok(emails.length <= MAX_EMAIL_ACTIONS, "the email cap still comes from the planner");
  for (const email of emails) {
    assert.ok(email.subject.length > 5 && !/^exciting news/i.test(email.subject), "a specific subject, not a generic teaser");
    assert.ok(email.previewText.length > 0);
    assert.ok(email.body.length > 120, "a real, concise body");
    assert.ok(email.cta.length > 0);
    assert.ok(email.purpose.length > 0, "purpose/stage present");
    assert.ok(email.audienceNote.length > 0, "intended audience present");
    assert.equal(email.ctaUrl, null, "no invented destination URL");
    assert.ok(Number.isFinite(Date.parse(email.scheduledFor)), "proposed send time present");
    assert.ok(email.contentSource === "mara");
  }
});

test("every Reel carries a hook, a shot script and visual direction; Posts and Stories do not", async () => {
  const plan = skeleton();
  const merged = mergeWith(intelligenceFor(plan), plan);
  const reels = merged.actions.filter((action) => action.channel === "instagram_reel");
  assert.ok(reels.length >= 1, "the plan includes a Reel");
  for (const reel of reels) {
    assert.equal(reel.format, "reel");
    assert.ok(reel.hook.length > 0, "hook present");
    assert.ok(reel.script.length >= 3, "a short shot-by-shot script");
    assert.ok(reel.visualDirection.length > 10, "visual direction present");
    assert.ok(reel.caption.length > 0);
    assert.ok(reel.purpose.length > 0);
  }
  for (const action of merged.actions.filter((a) => a.channel === "instagram_post" || a.channel === "instagram_story")) {
    assert.deepEqual(action.script, [], "Posts and Stories carry no Reel script");
    assert.equal(action.format, action.channel === "instagram_story" ? "story" : "post");
  }

  // A Reel with no script is refused and keeps the deterministic draft.
  const noScript = intelligenceFor(plan, (payload) => {
    for (const action of payload.actions) if (action.instagram?.format === "reel") action.instagram.script = [];
    return payload;
  });
  const guarded = mergeWith(noScript, plan);
  const guardedReel = guarded.actions.find((action) => action.channel === "instagram_reel");
  assert.equal(guardedReel.contentSource, "deterministic", "a scriptless Reel is refused");
});

// ─── 7. Timeline ───────────────────────────────────────────────────────────

test("the merged timeline stays ordered, contiguous and inside the campaign window", async () => {
  const plan = skeleton();
  const merged = mergeWith(intelligenceFor(plan), plan);
  const times = merged.actions.map((action) => Date.parse(action.scheduledFor));
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] >= times[i - 1], "ordered earliest-first");
  merged.actions.forEach((action, index) => assert.equal(action.slot, index));
  const start = Date.parse(new Date("2026-09-22T00:00+04:00").toISOString());
  const end = Date.parse(new Date("2026-10-01T23:59+04:00").toISOString());
  for (const action of merged.actions) {
    const at = Date.parse(action.scheduledFor);
    assert.ok(at >= start && at <= end, "every action stays inside the campaign window");
  }
  // Safety is re-evaluated on the FINAL merged content, not on the skeleton.
  for (const action of merged.actions) {
    assert.ok(Array.isArray(action.autopilotBlockers));
    assert.equal(action.autopilotSafe, action.autopilotBlockers.length === 0);
  }
});

// ─── 8. Performance context is advisory and never faked ────────────────────

test("performance context is supplied only when enough real data exists", async () => {
  const plan = skeleton();
  const base = {
    businessName: BRAND.brandName, brand: BRAND, brief: BRIEF, goalLabel: "Announce something",
    audiences: [], selectedAudience: null, automationMode: "manual",
    skeleton: plan.actions, summary: plan.summary, now: NOW,
  };

  const without = buildCampaignIntelligenceContext({ ...base, performance: null });
  assert.equal("recentPerformance" in without, false, "no performance key at all when there is no data");
  assert.equal(buildCampaignPerformanceContext(null), null);
  assert.equal(buildCampaignPerformanceContext({ sampleSize: 2, confidence: "low" }), null, "two measured items are not enough");

  const withPerf = buildCampaignIntelligenceContext({ ...base, performance: PERFORMANCE });
  assert.equal(withPerf.recentPerformance.sampleSize, 12);
  assert.equal(withPerf.recentPerformance.confidence, "moderate");
  assert.equal(withPerf.recentPerformance.bestFormat, "Reels");
  assert.equal(withPerf.recentPerformance.strongestTopic, "onboarding");
  assert.deepEqual(withPerf.recentPerformance.weakerTopics, ["Posts about “pricing”"]);
  assert.ok(withPerf.recentPerformance.guidance.every((rule) => /advisory|diverse|never invent/i.test(rule)));

  // Advisory only: the deterministic mix (counts per channel) is unchanged with
  // and without the evidence, and both plans stay inside the same limits. The
  // v1 planner may space a format slightly differently, never re-mix it.
  const planA = planCampaign({ brief: BRIEF, brand: BRAND, performance: null, now: NOW });
  const planB = planCampaign({ brief: BRIEF, brand: BRAND, performance: PERFORMANCE, now: NOW });
  const mixOf = (plan) => ({
    total: plan.actions.length,
    email: plan.actions.filter((a) => a.channel === "email").length,
    post: plan.actions.filter((a) => a.channel === "instagram_post").length,
    reel: plan.actions.filter((a) => a.channel === "instagram_reel").length,
    story: plan.actions.filter((a) => a.channel === "instagram_story").length,
  });
  assert.deepEqual(mixOf(planB), mixOf(planA), "performance never changes the deterministic mix");
  assert.equal(planB.summary.performanceUsed, true);
  assert.equal(planA.summary.performanceUsed, false);
  assert.ok(planB.actions.length <= MAX_CAMPAIGN_ACTIONS);

  // MARA's performance sentence is surfaced only when MARA actually wrote it.
  const noted = mergeWith(intelligenceFor(plan, (payload) => ({
    ...payload,
    performanceNote: "Recent educational Reels outperform this account's Reel baseline, so one educational Reel is used here.",
  })), plan);
  assert.match(noted.performanceNote, /educational Reels/);
  assert.equal(mergeWith(intelligenceFor(plan), plan).performanceNote, null);
});

// ─── 9. Mode / plan / credit safety ────────────────────────────────────────

test("campaign generation is text-only: no media provider, credit ledger, sender or publisher is reachable", async () => {
  const files = [
    "lib/campaign/server.ts",
    "lib/campaign/planner.ts",
    "lib/campaign/strategy.ts",
    "lib/campaign/intelligence.ts",
    "app/api/voom/campaigns/build/route.ts",
    "app/api/voom/campaigns/[id]/actions/[actionId]/route.ts",
    "app/api/voom/campaigns/[id]/actions/[actionId]/regenerate/route.ts",
  ];
  for (const file of files) {
    const source = stripComments(await read(file));
    for (const forbidden of [
      /lib\/media/, /lib\/mara\/media-plan/, /lib\/mara\/video/, /createMediaProvider/, /createVideoProvider/,
      /seedream/i, /seedance/i,
      /lib\/billing\/ledger/, /lib\/billing\/entitlement-guard/, /reserveCredits/, /guardAndReserveMedia/,
      /lib\/email\/client/, /createResendClient/, /lib\/voom\/campaign-delivery/,
      // The only publish-queue symbol allowed in this layer is cancelPublishItem
      // (v1: rejecting an action withdraws its queued publish). Nothing here may
      // enqueue, schedule or run a publish.
      /syncPostToPublishQueue/, /publish-worker/, /publish-flow/, /enqueuePublish/, /queuePublish/,
      /api\/cron/,
    ]) {
      assert.doesNotMatch(source, forbidden, `${file} must not reach ${forbidden}`);
    }
  }
  // cancelPublishItem is the ONLY publish-queue symbol used, and only to withdraw.
  const server = stripComments(await read("lib/campaign/server.ts"));
  assert.match(server, /import \{ cancelPublishItem \} from "@\/lib\/instagram\/publish-queue"/);
  assert.equal((server.match(/cancelPublishItem/g) ?? []).length, 2, "imported once and used once, in the v1 reject-withdrawal path");
  assert.doesNotMatch(server, /from "@\/lib\/instagram\/(publishing|publish-flow|publish-worker|publish-timeline)"/);
});

test("Manual and Assisted never auto-approve, auto-send, auto-publish or auto-generate paid media", async () => {
  const source = stripComments(await read("lib/campaign/server.ts"));
  // The only place the mode changes persisted state.
  assert.match(source, /mode === "autopilot" && action\.autopilotSafe/);
  assert.match(source, /mode === "manual"\s*\?\s*"proposed"/);
  assert.match(source, /"needs_approval"/);
  // Autopilot approval is still bounded by the existing safety evaluator.
  assert.match(source, /evaluateAutopilotRecommendation/);
  // No send/publish/media call exists anywhere in the build path.
  assert.doesNotMatch(source, /deliverCampaign|sendCampaign|publishDraft|syncPostToPublishQueue/);

  const automation = await read("lib/voom/automation.ts");
  assert.match(automation, /export function mayAutomaticallyGeneratePaidMedia\(mode: AutomationModeValue, trigger: WorkflowTrigger\): boolean \{\s*if \(mode !== "autopilot"\) return false;/);
  const guard = await read("lib/billing/entitlement-guard.ts");
  assert.match(guard, /allowsAutopilot/, "the central guard still requires the Max plan for Autopilot");
  assert.match(guard, /canGenerateAutomaticMedia/, "the central guard still checks the plan's automatic-media entitlement");
  assert.match(guard, /allowAutomaticPaidMedia/, "the central guard still requires the toggle");
  assert.match(guard, /reserveCredits/, "the central guard still reserves credits atomically");
});

test("regenerating one action cannot duplicate it, cannot touch sent/published items and spends no credits", async () => {
  const source = stripComments(await read("lib/campaign/server.ts"));
  // One action, in place: the guarded RPC is the only writer.
  assert.match(source, /update_campaign_action_content/);
  assert.match(source, /actionContentLock/, "sent/published actions are refused before anything is written");
  assert.match(source, /internal_status/, "the email lock reads real send rows");
  assert.match(source, /'publishing', 'published'|"publishing" \|\| status === "published"|publishing/, "the Instagram lock reads real queue state");
  // Regeneration is text-only and never inserts an action row.
  assert.doesNotMatch(source, /from\("voom_campaign_actions"\)\s*\n?\s*\.insert\(/);
  const start = source.indexOf("export async function regenerateCampaignAction");
  const end = source.indexOf("async function loadCampaignAction", start);
  const regenerate = source.slice(start, end);
  assert.ok(regenerate.length > 500, "the regenerate implementation was located");
  assert.match(regenerate, /generateCampaignIntelligence/, "regeneration uses the existing text provider");
  assert.match(regenerate, /actionContentLock/, "regeneration checks the sent/published lock first");
  assert.match(regenerate, /writeActionContent/, "regeneration writes through the guarded single-action RPC");
  assert.match(regenerate, /contentSource !== "mara"/, "an unusable response writes nothing at all");
  for (const forbidden of [/lib\/media/, /createMediaProvider/, /reserveCredits/, /createResendClient/, /deliverCampaign/, /syncPostToPublishQueue/]) {
    assert.doesNotMatch(regenerate, forbidden, `regeneration must not reach ${forbidden}`);
  }

  const route = stripComments(await read("app/api/voom/campaigns/[id]/actions/[actionId]/regenerate/route.ts"));
  assert.match(route, /idempotencyKey: z\.string\(\)\.trim\(\)\.uuid\(\)/, "a client-minted key makes retries a no-op");
  assert.doesNotMatch(route, /media|credit|resend|meta/i);
});

test("editing one action preserves the existing validation limits", async () => {
  const route = stripComments(await read("app/api/voom/campaigns/[id]/actions/[actionId]/route.ts"));
  assert.match(route, /subject: z\.string\(\)\.trim\(\)\.max\(300\)/);
  assert.match(route, /previewText: z\.string\(\)\.trim\(\)\.max\(500\)/);
  assert.match(route, /body: z\.string\(\)\.trim\(\)\.max\(12000\)/);
  assert.match(route, /caption: z\.string\(\)\.trim\(\)\.max\(2200\)/);
  assert.match(route, /\.strict\(\)/, "unknown fields are refused");
  const server = stripComments(await read("lib/campaign/server.ts"));
  assert.match(server, /composePostCaption/, "Instagram edits reuse the existing caption composition");
});

// ─── 10. Presentation ──────────────────────────────────────────────────────

test("the strategy block is compact — no AI essay reaches the user", async () => {
  const plan = skeleton();
  const merged = mergeWith(intelligenceFor(plan), plan);
  assert.ok(merged.strategySummary.length <= 322, `summary is short (${merged.strategySummary.length} chars)`);
  assert.match(merged.strategySummary, /launch announcement/);
  for (const value of Object.values(merged.strategy)) {
    assert.ok(typeof value === "string" && value.length <= 600, "every strategy field stays bounded");
  }
  assert.equal(campaignStrategySummary({
    objective: "x".repeat(300), coreMessage: "y", audienceAngle: "z",
    narrative: "n", ctaStrategy: "c", sequenceRationale: "s".repeat(600),
  }).length <= 322, true);
});

test("the campaign workspace shows MARA's approach, one timeline, editing and regeneration", async () => {
  const modal = await read("components/voom/modals/AutomatedCampaignModal.tsx");
  assert.match(modal, /MARA&apos;s approach|MARA's approach/);
  assert.match(modal, /Written by MARA/);
  assert.match(modal, /Deterministic plan/);
  assert.match(modal, /Regenerate draft with MARA/);
  assert.match(modal, /Edit draft/);
  assert.match(modal, /method: "PATCH"/, "editing patches one action");
  assert.match(modal, /\/regenerate/);
  assert.match(modal, /crypto\.randomUUID\(\)/, "regeneration is idempotent per click");
  assert.match(modal, /canEditContent/, "locked actions cannot be edited or regenerated");
  // One unified chronological timeline, not a project-management tool.
  assert.match(modal, /view\.actions\.map/);
  assert.doesNotMatch(modal, /drag|kanban|board column/i);
});
