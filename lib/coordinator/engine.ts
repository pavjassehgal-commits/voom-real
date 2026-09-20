import { localMinutes, localToUtcIso } from "@/lib/voom/timezone";
import { slotDates, planContentTypes, resolveSlotMinutes, type ContentType } from "@/lib/voom/cadence";
import type {
  AuthoritativeMarketingState,
  CalendarCommitment,
  CoordinatorDecision,
  CoordinatorEvaluation,
  GapIdentification,
} from "./types";

/**
 * Deterministic Coordinator Decision Engine.
 *
 * Examines the authoritative marketing state and identifies:
 * 1. Campaign issues that require attention (missing media, failed actions, pending approvals)
 * 2. Pending approvals waiting on the owner
 * 3. Calendar coverage gaps over the 7-day horizon (respecting existing campaign & calendar commitments)
 * 4. High-value email opportunities
 * 5. Available performance learnings (if sufficient real data exists)
 *
 * Never duplicates work or overlaps with active campaigns.
 */
export function evaluateMarketingNeeds(state: AuthoritativeMarketingState): CoordinatorEvaluation {
  const needs: CoordinatorDecision[] = [];

  // Priority 1: Campaign needs attention
  // Campaigns have strict priority. If an active campaign has an action that failed or needs visual/approval,
  // surface it immediately.
  for (const campaign of state.activeCampaigns) {
    const troubledActions = campaign.actions.filter((a) => a.needsAttention);
    if (troubledActions.length > 0) {
      const reasons = troubledActions.map((a) => `${a.title}: ${a.attentionReason}`).join("; ");
      needs.push({
        type: "campaign_needs_attention",
        priority: 10,
        title: `Campaign "${campaign.name}" needs attention`,
        description: `${troubledActions.length} action${troubledActions.length === 1 ? "" : "s"} require attention (${reasons}).`,
        meta: {
          campaignId: campaign.id,
          campaignName: campaign.name,
          troubledCount: troubledActions.length,
          actionIds: troubledActions.map((a) => a.id),
        },
      });
    }
  }

  // Priority 1.5: Lifecycle email flows that need the owner.
  // A flow MARA proposed, or one with failed sends, is real marketing work that
  // is waiting — it is surfaced instead of being silently re-proposed.
  //
  // Read defensively: a state built before Email Automation v2 (or one
  // reconstructed from a stored coordinator run) has no flow fields, and the
  // Coordinator must keep working rather than throw.
  const lifecycleFlows = state.emailState?.flows ?? [];
  const lifecycleOpportunities = state.emailState?.flowOpportunities ?? [];
  const attentionFlows = lifecycleFlows.filter((flow) => flow.needsAttention);
  if (attentionFlows.length > 0) {
    const draft = attentionFlows.filter((flow) => flow.status === "draft");
    needs.push({
      type: "email_flow_needs_attention",
      priority: 15,
      title: draft.length > 0
        ? `${draft.length} email flow${draft.length === 1 ? "" : "s"} waiting for your approval`
        : `Email flow${attentionFlows.length === 1 ? "" : "s"} need attention`,
      description: attentionFlows
        .map((flow) => `${flow.name}: ${flow.attentionReason ?? "needs a decision"}`)
        .join(" "),
      meta: {
        flowIds: attentionFlows.map((flow) => flow.id),
        flows: attentionFlows.map((flow) => ({
          id: flow.id,
          name: flow.name,
          flowType: flow.flowType,
          status: flow.status,
          reason: flow.attentionReason ?? null,
        })),
      },
    });
  }

  // Priority 2: General pending approvals (workflow items or other actions)
  if (state.pendingApprovals.length > 0) {
    needs.push({
      type: "pending_approval",
      priority: 20,
      title: `${state.pendingApprovals.length} item${state.pendingApprovals.length === 1 ? "" : "s"} waiting for approval`,
      description: `Review upcoming marketing proposals in Approvals to keep your calendar moving.`,
      meta: {
        count: state.pendingApprovals.length,
        items: state.pendingApprovals.slice(0, 5).map((p) => ({ id: p.id, title: p.title })),
      },
    });
  }

  // Priority 3: Calendar Gap Intelligence (the ONE marketing calendar)
  // Instead of blindly generating N items, see what days in the 7-day horizon
  // are covered by ANY valid marketing commitment on ANY channel (Instagram,
  // TikTok, YouTube campaign actions, approved/scheduled calendar items,
  // pending approval drafts). Multi-Social Core: a TikTok or YouTube planning
  // commitment covers its date just like an Instagram one — the coordinator
  // understands every channel. Gap filling itself still only proposes
  // Instagram drafts; nothing here creates autonomous TikTok/YouTube work.
  const gaps = identifyCalendarGaps(state);
  if (gaps.length > 0) {
    needs.push({
      type: "content_calendar_gap",
      priority: 30,
      title: `${gaps.length} upcoming content gap${gaps.length === 1 ? "" : "s"} identified`,
      description: `Your marketing calendar has unallocated slots on ${gaps.map((g) => g.date).join(", ")}.`,
      meta: {
        gapCount: gaps.length,
        dates: gaps.map((g) => g.date),
        details: gaps,
      },
    });
  }

  // Priority 4: Email opportunity
  if (state.emailState.opportunityAvailable) {
    needs.push({
      type: "email_opportunity",
      priority: 40,
      title: `Email campaign opportunity`,
      description: state.emailState.opportunityReason ?? "Audience contacts are ready for a targeted email update.",
      meta: {
        eligibleCount: state.emailState.eligibleContactsCount,
      },
    });
  }

  // Priority 4.5: Lifecycle email opportunities.
  // Only flow types that do NOT already exist reach here — an existing Welcome
  // or Re-engagement flow (draft, paused or active) suppresses its own
  // opportunity, so a repeated Coordinator run proposes nothing new.
  if (lifecycleOpportunities.length > 0) {
    const opportunities = lifecycleOpportunities;
    needs.push({
      type: "email_flow_opportunity",
      priority: 45,
      title: `MARA can prepare ${opportunities.length === 1 ? "a" : opportunities.length} lifecycle email flow${opportunities.length === 1 ? "" : "s"}`,
      description: opportunities.map((opportunity) => opportunity.reason).join(" "),
      meta: {
        opportunities,
        eligibleCount: state.emailState.eligibleContactsCount,
        existingFlows: lifecycleFlows.map((flow) => ({
          id: flow.id,
          flowType: flow.flowType,
          status: flow.status,
        })),
      },
    });
  }

  // Priority 5: Performance learning available (only when sufficient real data exists)
  if (state.performance.hasSufficientData) {
    const bestFormat = state.performance.bestContentTypeLabel ?? "Reels";
    needs.push({
      type: "performance_learning_available",
      priority: 50,
      title: `Performance intelligence available`,
      description: `Measured insights indicate ${bestFormat} are driving strongest engagement for your brand.`,
      meta: {
        bestFormat,
        sampleSize: state.performance.sampleSize,
        strongestTopic: state.performance.strongestTopicLabel,
      },
    });
  }

  // If nothing needed
  if (needs.length === 0) {
    needs.push({
      type: "nothing_needed",
      priority: 100,
      title: `Marketing is well covered`,
      description: `Your upcoming 7-day marketing schedule has complete coverage and no items require immediate attention.`,
    });
  }

  // Sort needs by priority ascending
  needs.sort((a, b) => a.priority - b.priority);

  // Can execute autonomous work?
  // Only Autopilot or Assisted (for planning) can execute autonomously without direct user request.
  // Manual accounts can NEVER execute autonomous work.
  const canExecuteAutonomousWork = state.mode !== "manual";

  // Friendly summary message for Today / Automations
  const summaryMessage = generateSummaryMessage(state, needs, gaps);

  return {
    ownerId: state.ownerId,
    businessId: state.businessId,
    state,
    needs,
    gaps,
    summaryMessage,
    canExecuteAutonomousWork,
  };
}

/**
 * Identifies genuine gaps in the 7-day rolling horizon.
 *
 * Rules:
 * - A date is considered COVERED if there is at least one commitment on that local date
 *   that is proposed, needs_approval, approved, scheduled, publishing, or published.
 * - Failed or skipped actions DO NOT count as coverage.
 * - If cadence is e.g. 3x_week, the target dates are determined by slotDates.
 * - But if the business already has enough commitments spread across the week (e.g. from campaigns),
 *   we do NOT create unnecessary extra posts.
 */
export function identifyCalendarGaps(state: AuthoritativeMarketingState): GapIdentification[] {
  const { cadence, todayLocalDate, timezone, commitments, performance } = state;

  // Determine the baseline target dates for this cadence
  const targetDates = slotDates(todayLocalDate, cadence, 7);

  // Map commitments by local date
  const commitmentsByDate = new Map<string, CalendarCommitment[]>();
  for (const c of commitments) {
    // Only count active/valid commitments (not failed)
    if (c.status === "failed") continue;
    const list = commitmentsByDate.get(c.localDate) ?? [];
    list.push(c);
    commitmentsByDate.set(c.localDate, list);
  }

  const gaps: GapIdentification[] = [];
  const now = new Date(state.now);
  const nowMinutes = localMinutes(now, timezone);

  // Balanced content types for the targets
  const types = planContentTypes({ cadence, count: targetDates.length, goal: state.business.mainGoal });

  // If performance intelligence strongly favors a format, adapt
  let preferredFormat: ContentType | null = null;
  if (performance.hasSufficientData && performance.bestContentTypeLabel) {
    const label = performance.bestContentTypeLabel.toLowerCase();
    if (label.includes("reel")) preferredFormat = "reel";
    else if (label.includes("story")) preferredFormat = "story";
    else if (label.includes("post")) preferredFormat = "post";
  }

  for (let i = 0; i < targetDates.length; i++) {
    const date = targetDates[i];
    const existingOnDate = commitmentsByDate.get(date) ?? [];

    // Multi-Social Core: a date covered by ANY active social channel
    // commitment (Instagram, TikTok, YouTube) is COVERED — the coordinator
    // reads the ONE marketing calendar, so it never stacks Instagram work on
    // top of a day another channel already fills. Email keeps its own cadence
    // and does not cover a social slot.
    const isCovered = existingOnDate.some((c) => isSocialCommitmentChannel(c.channel));
    if (isCovered) {
      continue;
    }

    // Also check: if the total number of social-channel commitments this week
    // already equals or exceeds the cadence target count, and they are
    // reasonably distributed, do not add more!
    const totalSocialCommitments = commitments.filter(
      (c) => isSocialCommitmentChannel(c.channel) && c.status !== "failed"
    ).length;

    if (totalSocialCommitments >= targetDates.length) {
      // Fleet has enough marketing coverage already
      continue;
    }

    const defaultType = types[i] ?? "post";
    const contentType: ContentType = (preferredFormat && i % 2 === 1) ? preferredFormat : defaultType;
    const minutes = resolveSlotMinutes({
      contentType,
      index: i,
      isToday: date === todayLocalDate,
      nowMinutes,
    });

    // If minutes is null, the day is already past the latest posting window
    if (minutes === null) continue;

    const publishAt = localToUtcIso(date, minutes, timezone);

    // Verify it is not in the past
    if (new Date(publishAt).getTime() <= now.getTime()) {
      continue;
    }

    gaps.push({
      date,
      recommendedFormat: contentType,
      recommendedPublishAt: publishAt,
      reason: `No marketing scheduled on ${date}. Maintaining ${cadence.replace("_", " ")} coverage.`,
    });
  }

  return gaps;
}

function generateSummaryMessage(
  state: AuthoritativeMarketingState,
  needs: CoordinatorDecision[],
  gaps: GapIdentification[],
): string {
  const topNeed = needs[0];
  if (!topNeed || topNeed.type === "nothing_needed") {
    return "Marketing is covered for the next 7 days.";
  }

  if (topNeed.type === "campaign_needs_attention") {
    return `Campaign "${topNeed.meta?.campaignName ?? "Active"}" needs attention.`;
  }

  if (topNeed.type === "pending_approval") {
    const count = state.pendingApprovals.length;
    return `${count} item${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} your approval.`;
  }

  if (topNeed.type === "content_calendar_gap") {
    return `MARA found ${gaps.length} content gap${gaps.length === 1 ? "" : "s"} in your upcoming schedule.`;
  }

  if (topNeed.type === "email_flow_needs_attention") {
    const drafts = state.emailState.flows.filter((flow) => flow.status === "draft");
    return drafts.length > 0
      ? `Your ${drafts[0].name} needs approval.`
      : "An email flow needs your attention.";
  }

  if (topNeed.type === "email_opportunity") {
    return "Email opportunity available for your audience.";
  }

  if (topNeed.type === "email_flow_opportunity") {
    const first = state.emailState.flowOpportunities[0];
    return first?.flowType === "welcome"
      ? "MARA found a welcome-flow opportunity."
      : "MARA found a re-engagement opportunity.";
  }

  return "MARA is preparing upcoming marketing.";
}

/**
 * Multi-Social Core vocabulary: the active social channels whose commitments
 * cover a calendar date. The retired SMS channel is deliberately absent —
 * historical SMS rows never count as coverage, and email keeps its own
 * cadence rather than filling a social slot.
 */
function isSocialCommitmentChannel(channel: string): boolean {
  return channel.startsWith("instagram_")
    || channel === "tiktok_video"
    || channel === "youtube_short"
    || channel === "youtube_video";
}
