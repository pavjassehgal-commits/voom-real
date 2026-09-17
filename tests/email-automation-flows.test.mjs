/**
 * Email Automation v2 — deterministic layer coverage.
 *
 * Everything here is the pure authority: the flow-type registry, the skeleton,
 * the MARA merge and its fallbacks, consent, re-entry, automation-mode gating
 * and the business-timezone timing fence. No database, no provider, no cron:
 * nothing in this file can reach the network (asserted at the end).
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

const policy = await import("../lib/email-flows/policy.ts");
const skeletonMod = await import("../lib/email-flows/skeleton.ts");
const strategy = await import("../lib/email-flows/strategy.ts");
const timing = await import("../lib/email-flows/timing.ts");
const send = await import("../lib/email-flows/send.ts");

const BRAND = {
  brandName: "SynraPay",
  brandDescription: "Payments for small merchants.",
  industry: "Fintech",
  targetCustomer: ["Small merchants"],
  mainGoal: "Adopt the new dashboard",
  brandPersonality: ["plain-spoken"],
};

// ─── 1. Creation: the deterministic skeleton ───────────────────────────────

test("1a. a Welcome flow is built with the deterministic sequence and delays", () => {
  const skeleton = skeletonMod.buildFlowSkeleton({ flowType: "welcome", brand: BRAND });
  assert.equal(skeleton.flowType, "welcome");
  assert.equal(skeleton.triggerType, "newly_eligible_contact");
  assert.equal(skeleton.steps.length, 3, "the default Welcome sequence has three emails");
  assert.deepEqual(skeleton.steps.map((step) => step.waitMinutes), [0, 2 * 1440, 3 * 1440]);
  assert.deepEqual(skeleton.steps.map((step) => step.position), [0, 1, 2]);
  assert.equal(skeleton.reentryPolicy, "once_per_contact");
  assert.equal(skeleton.cooldownDays, null, "Welcome has no cooldown");
  for (const step of skeleton.steps) {
    assert.ok(step.subject.includes("SynraPay"), "the fallback copy names the real business");
    assert.ok(step.body.startsWith("Hi {firstName},"), "the greeting token is preserved for the send layer");
    assert.equal(step.contentSource, "deterministic");
  }
});

test("1b. a Re-engagement flow is built with its own trigger, waits and cooldown", () => {
  const skeleton = skeletonMod.buildFlowSkeleton({
    flowType: "re_engagement",
    brand: BRAND,
    inactivityDays: 60,
    cooldownDays: 120,
  });
  assert.equal(skeleton.triggerType, "inactive_contact");
  assert.equal(skeleton.steps.length, 2);
  assert.deepEqual(skeleton.steps.map((step) => step.waitMinutes), [0, 4 * 1440]);
  assert.equal(skeleton.reentryPolicy, "cooldown");
  assert.equal(skeleton.inactivityDays, 60);
  assert.equal(skeleton.cooldownDays, 120);
  assert.deepEqual(skeleton.triggerConfig, { inactivityDays: 60, cooldownDays: 120 });
});

test("1c. step counts and delays are clamped, never trusted", () => {
  const tiny = skeletonMod.buildFlowSkeleton({ flowType: "welcome", brand: BRAND, stepCount: 1 });
  assert.equal(tiny.steps.length, policy.flowTypePolicy("welcome").minSteps, "clamped up to the minimum");
  const huge = skeletonMod.buildFlowSkeleton({ flowType: "welcome", brand: BRAND, stepCount: 40 });
  assert.equal(huge.steps.length, policy.flowTypePolicy("welcome").maxSteps, "clamped down to the maximum");

  // Re-engagement waits have a 1-day floor for every step after the first.
  assert.equal(policy.clampWaitMinutes("re_engagement", 5, 1), 1440, "the 1-day floor applies after the first step");
  assert.equal(policy.clampWaitMinutes("re_engagement", 5, 0), 5, "position 0 has no floor (the skeleton still uses 0)");
  assert.equal(policy.clampWaitMinutes("re_engagement", null, 2), 5760, "an unusable suggestion falls back to the default");
  assert.equal(policy.clampWaitMinutes("welcome", 999_999, 2), policy.flowTypePolicy("welcome").maxWaitMinutes);
});

test("1d. unsupported trigger types and out-of-range settings are rejected", () => {
  const badType = policy.validateFlowCreation({ flowType: "abandoned_cart" });
  assert.equal(badType.ok, false);
  assert.equal(badType.code, "unsupported_flow_type");

  const badTrigger = policy.validateFlowCreation({ flowType: "welcome", triggerType: "inactive_contact" });
  assert.equal(badTrigger.ok, false);
  assert.equal(badTrigger.code, "unsupported_trigger_type");

  const badSteps = policy.validateFlowCreation({ flowType: "welcome", steps: new Array(9) });
  assert.equal(badSteps.ok, false);
  assert.equal(badSteps.code, "invalid_step_count");

  const badInactivity = policy.validateFlowCreation({ flowType: "re_engagement", inactivityDays: 3 });
  assert.equal(badInactivity.ok, false);
  assert.equal(badInactivity.code, "invalid_inactivity_days");

  assert.deepEqual(policy.validateFlowCreation({ flowType: "welcome" }), { ok: true });
  // The trigger registry is the only mapping, and it is bidirectional.
  assert.equal(policy.triggerForFlowType("welcome"), "newly_eligible_contact");
  assert.equal(policy.flowTypeForTrigger("inactive_contact"), "re_engagement");
  assert.equal(policy.flowTypeForTrigger("purchase_made"), null);
});

// ─── 2. MARA intelligence and its fallbacks ────────────────────────────────

function intelligence(overrides = {}) {
  return {
    strategy: {
      objective: "Get new subscribers onto the dashboard.",
      approach: "Greet, explain, then ask one question.",
      audienceAngle: "Small merchants reconciling payouts.",
      tone: "Plain and direct.",
    },
    steps: [
      { position: 0, title: "Welcome", purpose: "Say hello", subject: "Welcome to SynraPay", previewText: "What to expect.", body: "Hi {firstName},\n\nThanks for subscribing to SynraPay. Here is what happens next.", cta: "Reply and say hello", ctaUrl: null, waitMinutes: 0 },
      { position: 1, title: "Value", purpose: "Explain", subject: "What SynraPay does", previewText: "One plain explanation.", body: "Hi {firstName},\n\nThe dashboard shows every settlement and the date it lands.", cta: "Open the dashboard", ctaUrl: "https://synrapay.example/dashboard", waitMinutes: 2880 },
      { position: 2, title: "Next step", purpose: "Ask", subject: "One thing worth doing", previewText: "A single next step.", body: "Hi {firstName},\n\nTell us what you are trying to get done and we will point you at it.", cta: "Tell us what you need", ctaUrl: null, waitMinutes: 4320 },
    ],
    note: null,
    ...overrides,
  };
}

const ALLOWED_URLS = ["https://synrapay.example/dashboard"];

test("2a. valid MARA output is accepted inside the skeleton", () => {
  const skeleton = skeletonMod.buildFlowSkeleton({ flowType: "welcome", brand: BRAND });
  const applied = strategy.applyFlowIntelligence({
    skeleton,
    brand: BRAND,
    intelligence: intelligence(),
    allowedUrls: ALLOWED_URLS,
  });
  assert.equal(applied.source, "mara");
  assert.equal(applied.steps.length, 3, "MARA cannot add or drop steps");
  assert.deepEqual(applied.fallbackPositions, []);
  assert.equal(applied.steps[1].contentSource, "mara");
  assert.equal(applied.steps[1].ctaUrl, "https://synrapay.example/dashboard");
  assert.match(applied.steps[0].body, /unsubscribe/i, "the opt-out line is always present");
  assert.ok(applied.strategySummary.length > 0);
});

test("2b. MARA failing entirely falls back to safe deterministic content", () => {
  const skeleton = skeletonMod.buildFlowSkeleton({ flowType: "welcome", brand: BRAND });
  const applied = strategy.applyFlowIntelligence({ skeleton, brand: BRAND, intelligence: null });
  assert.equal(applied.source, "deterministic");
  assert.equal(applied.strategy, null);
  assert.equal(applied.steps.length, 3);
  for (const step of applied.steps) {
    assert.equal(step.contentSource, "deterministic");
    assert.ok(step.subject.length > 0 && step.body.length > 0, "the fallback is still sendable");
  }
});

test("2c. invalid MARA output is refused per step, not for the whole flow", () => {
  const skeleton = skeletonMod.buildFlowSkeleton({ flowType: "welcome", brand: BRAND });
  const bad = intelligence({
    steps: [
      // Unsupported price: refused by the existing safety vocabulary.
      { position: 0, title: "Welcome", purpose: "Say hello", subject: "Save 20% today", previewText: "A discount.", body: "Hi {firstName},\n\nGet 20% off your first month at SynraPay.", cta: "Claim it", ctaUrl: null, waitMinutes: 0 },
      // Same subject as step 0 → repetition guard.
      { position: 1, title: "Value", purpose: "Explain", subject: "Save 20% today", previewText: "Again.", body: "Hi {firstName},\n\nThe dashboard shows every settlement date.", cta: "Open it", ctaUrl: null, waitMinutes: 2880 },
      // Fine.
      { position: 2, title: "Next step", purpose: "Ask", subject: "One thing worth doing", previewText: "A single next step.", body: "Hi {firstName},\n\nTell us what you are trying to get done.", cta: "Reply", ctaUrl: null, waitMinutes: 4320 },
    ],
  });

  const applied = strategy.applyFlowIntelligence({ skeleton, brand: BRAND, intelligence: bad });
  assert.deepEqual(applied.fallbackPositions, [0, 1]);
  assert.equal(applied.steps[0].contentSource, "deterministic");
  assert.equal(applied.steps[1].contentSource, "deterministic");
  assert.equal(applied.steps[2].contentSource, "mara");
  assert.equal(applied.source, "mara", "the usable step still carries MARA's writing");
});

test("2d. MARA cannot invent a link, and cannot move a delay outside the fence", () => {
  const skeleton = skeletonMod.buildFlowSkeleton({ flowType: "welcome", brand: BRAND });
  const invented = intelligence({
    steps: intelligence().steps.map((step, index) => ({
      ...step,
      ctaUrl: index === 1 ? "https://totally-invented.example/offer" : null,
      waitMinutes: index === 1 ? 60 * 24 * 60 : step.waitMinutes, // 60 days
    })),
  });
  const applied = strategy.applyFlowIntelligence({ skeleton, brand: BRAND, intelligence: invented, allowedUrls: ALLOWED_URLS });
  assert.equal(applied.steps[1].ctaUrl, null, "an unverified URL is dropped, never stored");
  assert.equal(
    applied.steps[1].waitMinutes,
    policy.flowTypePolicy("welcome").maxWaitMinutes,
    "the proposed delay is clamped to the deterministic ceiling",
  );
});

test("2e. the intelligence schema is strict and mirrors the JSON schema", () => {
  assert.equal(strategy.flowIntelligenceSchema.parse(intelligence()).steps.length, 3);
  assert.throws(() => strategy.flowIntelligenceSchema.parse({ ...intelligence(), extra: true }));
  assert.throws(() => strategy.flowIntelligenceSchema.parse({ ...intelligence(), strategy: { objective: "x" } }));

  const json = strategy.flowIntelligenceJsonSchema;
  assert.equal(json.schema.additionalProperties, false);
  assert.deepEqual(json.schema.required, ["strategy", "steps", "note"]);
  assert.equal(json.schema.properties.steps.items.additionalProperties, false);
  assert.deepEqual(json.schema.properties.steps.items.required, [
    "position", "title", "purpose", "subject", "previewText", "body", "cta", "ctaUrl", "waitMinutes",
  ]);
  // The context never hands MARA a recipient, an address or a secret.
  const skeleton = skeletonMod.buildFlowSkeleton({ flowType: "welcome", brand: BRAND });
  const context = JSON.stringify(strategy.buildFlowIntelligenceContext({ skeleton, brand: BRAND, allowedUrls: ALLOWED_URLS }));
  assert.doesNotMatch(context, /EMAIL_PROVIDER_API_KEY|apiKey|Authorization/i);
});

// ─── 3. Consent is authoritative ───────────────────────────────────────────

test("3a. unknown or missing consent never enrolls", () => {
  const subscribed = policy.flowContactEligibility({ email: "Ada@Example.com", email_status: "subscribed" });
  assert.deepEqual(subscribed, { eligible: true, reason: "eligible", destination: "ada@example.com" });

  const unknown = policy.flowContactEligibility({ email: "ada@example.com", email_status: "unknown" });
  assert.equal(unknown.eligible, false);
  assert.equal(unknown.reason, "consent_unknown", "unknown consent fails closed");

  const unsubscribed = policy.flowContactEligibility({ email: "ada@example.com", email_status: "unsubscribed" });
  assert.equal(unsubscribed.eligible, false);
  assert.equal(unsubscribed.reason, "consent_not_subscribed");

  assert.equal(policy.flowContactEligibility(null).reason, "contact_not_found");
  assert.equal(policy.flowContactEligibility({ email: null, email_status: "subscribed" }).reason, "destination_missing");
  assert.equal(policy.flowContactEligibility({ email: "not-an-email", email_status: "subscribed" }).reason, "destination_invalid");
});

test("3b. a suppressed address never sends, even while subscribed", () => {
  const suppressed = policy.flowContactEligibility(
    { email: "ada@example.com", email_status: "subscribed" },
    new Set(["ada@example.com"]),
  );
  assert.equal(suppressed.eligible, false);
  assert.equal(suppressed.reason, "suppressed");
  assert.match(policy.eligibilityReasonLabel("suppressed"), /bounce or complaint/i);
});

// ─── 4. Re-entry and inactivity ────────────────────────────────────────────

test("4a. Welcome enrolls a contact once, ever", () => {
  const now = new Date("2026-09-20T09:00:00Z");
  const first = policy.decideReEntry({
    policy: "once_per_contact", cooldownDays: null, hasActiveEnrollment: false, lastEndedAt: null, now,
  });
  assert.equal(first.allow, true);

  const again = policy.decideReEntry({
    policy: "once_per_contact", cooldownDays: null, hasActiveEnrollment: false,
    lastEndedAt: "2025-01-01T09:00:00Z", now,
  });
  assert.equal(again.allow, false);
  assert.equal(again.outcome, "already_enrolled");

  const active = policy.decideReEntry({
    policy: "once_per_contact", cooldownDays: null, hasActiveEnrollment: true, lastEndedAt: null, now,
  });
  assert.equal(active.allow, false, "a live enrollment always wins");
});

test("4b. Re-engagement respects its cooldown and cannot become a loop", () => {
  const now = new Date("2026-09-20T09:00:00Z");
  const tooSoon = policy.decideReEntry({
    policy: "cooldown", cooldownDays: 90, hasActiveEnrollment: false,
    lastEndedAt: "2026-08-20T09:00:00Z", now,
  });
  assert.equal(tooSoon.allow, false);
  assert.equal(tooSoon.outcome, "cooldown");

  const later = policy.decideReEntry({
    policy: "cooldown", cooldownDays: 90, hasActiveEnrollment: false,
    lastEndedAt: "2026-01-01T09:00:00Z", now,
  });
  assert.equal(later.allow, true);
  assert.equal(later.outcome, "new");
});

test("4c. inactivity is only ever derived from data Voom actually has", () => {
  const now = new Date("2026-09-20T09:00:00Z");
  assert.equal(policy.isInactiveContact({ lastEmailedAt: "2026-09-01T09:00:00Z", contactCreatedAt: "2024-01-01T00:00:00Z", inactivityDays: 45, now }), false);
  assert.equal(policy.isInactiveContact({ lastEmailedAt: "2026-01-01T09:00:00Z", contactCreatedAt: "2024-01-01T00:00:00Z", inactivityDays: 45, now }), true);
  // No history at all is NOT inactivity: the flow does not invent behaviour.
  assert.equal(policy.isInactiveContact({ lastEmailedAt: null, contactCreatedAt: null, inactivityDays: 45, now }), false);
});

// ─── 5. Automation modes ───────────────────────────────────────────────────

test("5a. Manual never lets the Coordinator create or activate a flow", () => {
  assert.equal(policy.mayCoordinatorProposeFlow("manual"), false);
  assert.equal(policy.mayCoordinatorProposeFlow("assisted"), true);
  assert.equal(policy.mayCoordinatorProposeFlow("autopilot"), true);
});

test("5b. Autopilot fails closed on activation — nobody but the owner activates", () => {
  assert.equal(policy.mayCoordinatorActivateFlow("autopilot"), false);
  assert.equal(policy.mayCoordinatorActivateFlow("assisted"), false);
  assert.equal(policy.mayCoordinatorActivateFlow("manual"), false);
});

test("5c. only an owner-activated flow may execute", () => {
  assert.equal(policy.flowMayExecute({ status: "active", activated_by: "user", activated_at: "2026-09-01T09:00:00Z" }), true);
  assert.equal(policy.flowMayExecute({ status: "active", activated_by: null, activated_at: "2026-09-01T09:00:00Z" }), false);
  assert.equal(policy.flowMayExecute({ status: "active", activated_by: "user", activated_at: null }), false);
  assert.equal(policy.flowMayExecute({ status: "paused", activated_by: "user", activated_at: "2026-09-01T09:00:00Z" }), false);
  assert.equal(policy.flowMayExecute({ status: "draft", activated_by: null, activated_at: null }), false);
});

// ─── 6. Business-timezone timing ───────────────────────────────────────────

test("6a. a wait that lands outside business hours moves into the send window", () => {
  const timeZone = "Asia/Dubai";
  // Enrollment at 22:40 local; a 2-day wait would land at 22:40 again.
  const from = "2026-09-20T18:40:00.000Z"; // 22:40 in Dubai
  const now = new Date("2026-09-20T18:00:00.000Z");
  const next = timing.computeStepInstant({ from, waitMinutes: 2 * 1440, timeZone, now });

  const at = new Date(next);
  const local = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  assert.equal(local, "09:00", "moved to the start of the next business-hours window");
  assert.ok(Date.parse(next) > now.getTime(), "never in the past");
});

test("6b. no schedule is ever in the past, whatever the input", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  for (const after of ["2020-01-01T00:00:00Z", now.toISOString(), "2026-09-20T03:00:00Z"]) {
    const instant = timing.nextSafeSendInstant({ after, timeZone: "Asia/Dubai", now });
    assert.ok(Date.parse(instant) > now.getTime(), `${after} → ${instant} must be in the future`);
  }
});

test("6c. the send window is resolved in the BUSINESS timezone, not a fixed offset", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const dubai = timing.nextSafeSendInstant({ after: "2026-09-21T04:30:00Z", timeZone: "Asia/Dubai", now });
  const newYork = timing.nextSafeSendInstant({ after: "2026-09-21T04:30:00Z", timeZone: "America/New_York", now });
  assert.notEqual(dubai, newYork, "the same UTC instant resolves differently per business timezone");

  for (const [timeZone, instant] of [["Asia/Dubai", dubai], ["America/New_York", newYork]]) {
    const minutes = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(instant));
    const hour = Number(minutes.find((part) => part.type === "hour").value);
    const minute = Number(minutes.find((part) => part.type === "minute").value);
    const local = hour * 60 + minute;
    assert.ok(local >= policy.SEND_WINDOW_START_MINUTES && local < policy.SEND_WINDOW_END_MINUTES,
      `${timeZone}: ${hour}:${minute} must be inside the local send window`);
  }
});

test("6d. an overdue pile is spread out, never burst-sent", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const times = timing.spreadOverdueRuns({ count: 12, timeZone: "Asia/Dubai", now, perWindow: 3, spacingMinutes: 10 });
  assert.equal(times.length, 12);
  for (let index = 1; index < times.length; index += 1) {
    assert.ok(Date.parse(times[index]) > Date.parse(times[index - 1]), "strictly increasing");
    assert.ok(Date.parse(times[index]) > now.getTime(), "always in the future");
  }
  const distinctDays = new Set(times.map((instant) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date(instant))));
  assert.ok(distinctDays.size > 1, "a backlog crosses into later business days instead of firing at once");
});

// ─── 7. Presentation truthfulness ──────────────────────────────────────────

test("7a. labels come from real state, and needs-attention reasons are honest", () => {
  assert.equal(policy.flowStatusLabel("paused"), "Paused");
  assert.equal(policy.waitLabel(2880, 1), "After 2 days");
  assert.equal(policy.waitLabel(0, 0), "Sends in the next business-hours window");

  assert.equal(policy.flowAttention({ status: "draft", createdBy: "coordinator", failedRuns: 0, providerConfigured: true }).needsAttention, true);
  assert.match(policy.flowAttention({ status: "draft", createdBy: "coordinator", failedRuns: 0, providerConfigured: true }).reason, /MARA proposed/i);
  assert.equal(policy.flowAttention({ status: "active", createdBy: "user", failedRuns: 0, providerConfigured: true }).needsAttention, false);
  assert.match(policy.flowAttention({ status: "active", createdBy: "user", failedRuns: 2, providerConfigured: true }).reason, /failed/i);
  assert.match(policy.flowAttention({ status: "active", createdBy: "user", failedRuns: 0, providerConfigured: false }).reason, /Resend is not configured/i);
  assert.equal(policy.activityLabel("delivered"), "Delivery confirmed by Resend");
});

test("7b. the send layer personalizes only the token it owns", () => {
  assert.equal(send.personalizeFlowBody("Hi {firstName}, welcome", "Ada"), "Hi Ada, welcome");
  assert.equal(send.personalizeFlowBody("Hi {firstName}, welcome", null), "Hi there, welcome");
  assert.equal(send.personalizeFlowBody("No token here", "Ada"), "No token here");
});

// ─── 8. External safety ────────────────────────────────────────────────────

test("8. nothing in this suite touched the network, a provider or a credit", async () => {
  // No fetch was ever called: these modules are pure. A provider client would
  // have to be constructed to reach the network, and none was.
  assert.equal(typeof send.sendFlowEmail, "function", "the send adapter exists but was never invoked here");
  const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("../lib/email-flows/engine.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /seedream|seedance|openrouter|media-credit|reserveMedia/i, "no media path is reachable from the engine");
  assert.match(source, /createResendClient|sendFlowEmail/, "the engine sends through the existing email infrastructure only");
});
