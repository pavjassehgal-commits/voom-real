import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const engine = await import("../lib/coordinator/engine.ts");
const { evaluateMarketingNeeds, identifyCalendarGaps } = engine;

function createMockMarketingState(overrides = {}) {
  const defaultState = {
    ownerId: "owner-123",
    businessId: "biz-456",
    business: {
      id: "biz-456",
      brandName: "Acme Coffee",
      brandDescription: "Artisanal espresso and pastries",
      industry: "Hospitality",
      targetCustomer: ["Coffee lovers"],
      mainGoal: "Grow awareness",
      brandPersonality: ["Warm", "Craft"],
      preferredChannels: ["Instagram", "Email"],
      contentFrequency: "3x_week",
      automationLevel: "assisted",
      timezone: "Asia/Dubai",
      plan: "pro",
      allowAutomaticPaidMedia: false,
    },
    timezone: "Asia/Dubai",
    now: "2026-09-16T10:00:00.000Z",
    todayLocalDate: "2026-09-16",
    horizonStart: "2026-09-16",
    horizonEnd: "2026-09-22",
    cadence: "3x_week",
    mode: "assisted",
    credits: {
      planId: "pro",
      monthlyAllowance: 150,
      usedThisMonth: 10,
      remainingCredits: 140,
      canGenerateMedia: true,
      canUseAutopilot: false,
    },
    commitments: [],
    activeCampaigns: [],
    pendingApprovals: [],
    emailState: {
      eligibleContactsCount: 50,
      recentCampaignCount: 0,
      lastSentAt: null,
      scheduledEmailCount: 0,
      opportunityAvailable: false,
    },
    performance: {
      hasSufficientData: false,
      confidence: "none",
      sampleSize: 0,
    },
    currentPlanId: "plan-789",
  };

  return { ...defaultState, ...overrides };
}

test("State & Gap: empty upcoming week identifies useful Instagram gaps", () => {
  const state = createMockMarketingState({ commitments: [] });
  const gaps = identifyCalendarGaps(state);
  assert.ok(gaps.length > 0, "Should identify gaps when calendar is empty");
  assert.equal(gaps.length, 3, "3x_week cadence should identify up to 3 gaps");
});

test("Coverage: existing campaign actions count as coverage", () => {
  const state = createMockMarketingState({
    commitments: [
      {
        id: "camp-act-1",
        source: "campaign",
        sourceId: "camp-1",
        channel: "instagram_reel",
        format: "reel",
        title: "Campaign Reel",
        publishAt: "2026-09-16T14:00:00.000Z",
        localDate: "2026-09-16",
        localTime: "2026-09-16T14:00:00.000Z",
        status: "scheduled",
      },
      {
        id: "camp-act-2",
        source: "campaign",
        sourceId: "camp-1",
        channel: "instagram_post",
        format: "post",
        title: "Campaign Post",
        publishAt: "2026-09-18T14:00:00.000Z",
        localDate: "2026-09-18",
        localTime: "2026-09-18T14:00:00.000Z",
        status: "approved",
      },
      {
        id: "camp-act-3",
        source: "campaign",
        sourceId: "camp-1",
        channel: "instagram_story",
        format: "story",
        title: "Campaign Story",
        publishAt: "2026-09-20T14:00:00.000Z",
        localDate: "2026-09-20",
        localTime: "2026-09-20T14:00:00.000Z",
        status: "scheduled",
      },
    ],
  });

  const gaps = identifyCalendarGaps(state);
  assert.equal(gaps.length, 0, "Active campaign actions covering the week should result in zero additional generic recommendations");
});

test("Coverage: pending approval counts as occupied/planned work", () => {
  const state = createMockMarketingState({
    commitments: [
      {
        id: "draft-1",
        source: "workflow_plan",
        sourceId: "plan-1",
        channel: "instagram_reel",
        format: "reel",
        title: "Thursday Reel awaiting approval",
        publishAt: "2026-09-18T14:00:00.000Z",
        localDate: "2026-09-18",
        localTime: "2026-09-18T14:00:00.000Z",
        status: "needs_approval",
      },
    ],
  });

  const gaps = identifyCalendarGaps(state);
  const gapOn18th = gaps.find((g) => g.date === "2026-09-18");
  assert.equal(gapOn18th, undefined, "2026-09-18 should not be identified as a gap because pending approval draft occupies it");
});

test("Coverage: failed content is treated as needs-attention, not silently covered", () => {
  const state = createMockMarketingState({
    commitments: [
      {
        id: "draft-fail",
        source: "workflow_plan",
        sourceId: "plan-1",
        channel: "instagram_post",
        format: "post",
        title: "Failed Post",
        publishAt: "2026-09-18T14:00:00.000Z",
        localDate: "2026-09-18",
        localTime: "2026-09-18T14:00:00.000Z",
        status: "failed",
      },
    ],
  });

  const gaps = identifyCalendarGaps(state);
  const gapOn18th = gaps.find((g) => g.date === "2026-09-18");
  assert.ok(gapOn18th, "Failed content must NOT count as coverage; slot should remain open for gap remediation");
});

test("Campaign priority: campaign needs attention is surfaced over generic content creation", () => {
  const state = createMockMarketingState({
    activeCampaigns: [
      {
        id: "camp-troubled",
        name: "Autumn Launch",
        goal: "drive_sales",
        lifecycle: "needs_attention",
        startAt: "2026-09-16",
        endAt: "2026-09-22",
        actions: [
          {
            id: "act-1",
            channel: "instagram_reel",
            stage: "awareness",
            title: "Reel without visual",
            scheduledFor: "2026-09-17T10:00:00Z",
            status: "needs_approval",
            needsAttention: true,
            attentionReason: "Media asset missing",
          },
        ],
      },
    ],
  });

  const evalResult = evaluateMarketingNeeds(state);
  assert.equal(evalResult.needs[0]?.type, "campaign_needs_attention", "Top priority need must be campaign_needs_attention");
});

test("Performance: insufficient performance data does not create fake insights", () => {
  const state = createMockMarketingState({
    performance: {
      hasSufficientData: false,
      confidence: "none",
      sampleSize: 1,
    },
  });

  const evalResult = evaluateMarketingNeeds(state);
  const hasPerf = evalResult.needs.some((n) => n.type === "performance_learning_available");
  assert.equal(hasPerf, false, "Must not surface fake performance insights when insufficient data exists");
});

test("Performance: sufficient real history influences strategy without changing committed campaigns", () => {
  const state = createMockMarketingState({
    performance: {
      hasSufficientData: true,
      confidence: "moderate",
      sampleSize: 8,
      bestContentTypeLabel: "Reels",
      strongestTopicLabel: "Product Demos",
    },
  });

  const evalResult = evaluateMarketingNeeds(state);
  const perfNeed = evalResult.needs.find((n) => n.type === "performance_learning_available");
  assert.ok(perfNeed, "Should surface genuine performance insights when sufficient data exists");
  assert.match(perfNeed.description, /Reels/);
});

test("Manual mode: canExecuteAutonomousWork is false for Manual", () => {
  const state = createMockMarketingState({ mode: "manual" });
  const evalResult = evaluateMarketingNeeds(state);
  assert.equal(evalResult.canExecuteAutonomousWork, false, "Manual mode must never execute autonomous background work");
});

test("Assisted mode: canExecuteAutonomousWork is true for planning preparation only", () => {
  const state = createMockMarketingState({ mode: "assisted" });
  const evalResult = evaluateMarketingNeeds(state);
  assert.equal(evalResult.canExecuteAutonomousWork, true, "Assisted mode allows autonomous planning preparation");
});

test("Time: no proposed work is created in the past", () => {
  const state = createMockMarketingState({
    now: "2026-09-16T23:55:00.000Z", // Late at night
    todayLocalDate: "2026-09-17",
  });
  const gaps = identifyCalendarGaps(state);
  for (const gap of gaps) {
    assert.ok(new Date(gap.recommendedPublishAt).getTime() > new Date(state.now).getTime(), "Gaps must be strictly in the future");
  }
});
