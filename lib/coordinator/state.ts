import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { accountTimezone, isoToLocalDate, localDate, localToUtcIso } from "@/lib/voom/timezone";
import { normalizeCadence, slotDates, type ContentType } from "@/lib/voom/cadence";
import { normalizeAutomationMode } from "@/lib/voom/automation";
import { normalizePlan, canUseAutopilot, canGenerateExplicitMedia } from "@/lib/billing/plans";
import { getCreditSummary } from "@/lib/billing/ledger";
import { loadPerformancePlanContext } from "@/lib/performance/data";
import type {
  AuthoritativeMarketingState,
  CalendarCommitment,
  ActiveCampaignState,
  PendingApprovalState,
  EmailMarketingState,
  EmailFlowState,
  EmailFlowOpportunity,
  PerformanceIntelligenceState,
  MarketingStateBusinessProfile,
  CreditAvailability,
} from "./types";

/**
 * Builds the authoritative single marketing state for an owner and business.
 *
 * Safe bounded windows:
 * - Rolling 7-day upcoming horizon for calendar & gaps
 * - Past 14-day history for recent marketing activity
 * - Never loads infinite history
 * - Authoritative workspace isolation (owner_user_id)
 * - Exposes ZERO provider secrets or tokens
 */
export async function buildMarketingState(
  admin: SupabaseClient,
  ownerId: string,
  businessId?: string,
  now = new Date(),
): Promise<AuthoritativeMarketingState> {
  let businessQuery = admin.from("businesses")
    .select("id,owner_user_id,brand_name,brand_description,industry,target_customer,main_goal,brand_personality,preferred_channels,content_frequency,automation_level,timezone,plan,allow_automatic_paid_media")
    .eq("owner_user_id", ownerId);

  if (businessId) {
    businessQuery = businessQuery.eq("id", businessId);
  }

  const { data: businessRow, error: bErr } = await businessQuery.limit(1).maybeSingle();
  if (bErr || !businessRow) {
    throw new Error("business_not_found");
  }

  const tz = accountTimezone((businessRow as { timezone?: string | null }).timezone);
  const today = localDate(now, tz);
  const cadence = normalizeCadence((businessRow as { content_frequency?: string | null }).content_frequency);
  const mode = normalizeAutomationMode((businessRow as { automation_level?: string | null }).automation_level);
  const planId = normalizePlan((businessRow as { plan?: string | null }).plan);
  const allowAutomaticPaidMedia = Boolean((businessRow as { allow_automatic_paid_media?: boolean }).allow_automatic_paid_media);

  // Compute 7-day horizon: today up to today + 6
  const horizonDates = slotDates(today, "daily", 7);
  const horizonStart = horizonDates[0] || today;
  const horizonEnd = horizonDates[horizonDates.length - 1] || today;
  const horizonStartIso = localToUtcIso(horizonStart, 0, tz);
  const horizonEndIso = localToUtcIso(horizonEnd, 23 * 60 + 59, tz);

  // 1. Credit availability
  let creditSummary = { allowance: 0, additional: 0, used: 0, remaining: 0 };
  try {
    creditSummary = await getCreditSummary(admin, ownerId, planId, now);
  } catch {
    // Fail closed or default to 0
  }

  const credits: CreditAvailability = {
    planId,
    monthlyAllowance: creditSummary.allowance,
    usedThisMonth: creditSummary.used,
    remainingCredits: creditSummary.remaining,
    canGenerateMedia: canGenerateExplicitMedia(planId) && creditSummary.remaining >= 5,
    canUseAutopilot: canUseAutopilot(planId) && allowAutomaticPaidMedia && creditSummary.remaining >= 5,
  };

  // 2. Performance Intelligence
  let performanceState: PerformanceIntelligenceState = {
    hasSufficientData: false,
    confidence: "none",
    sampleSize: 0,
  };

  try {
    const perfContext = await loadPerformancePlanContext(admin, ownerId);
    if (perfContext && perfContext.sampleSize >= 3) {
      performanceState = {
        hasSufficientData: true,
        confidence: perfContext.confidence === "moderate" ? "moderate" : "low",
        sampleSize: perfContext.sampleSize,
        bestContentTypeLabel: perfContext.bestContentType?.label ?? null,
        strongestTopicLabel: perfContext.strongestTopic?.label ?? null,
        winnerLabels: perfContext.recentWinners.map((w) => w.label),
        underperformerLabels: perfContext.underperformingThemes.map((u) => u.label),
      };
    }
  } catch {
    // Stay deterministic with empty/low data
  }

  // 3. Active Marketing Plan
  const { data: activePlan } = await admin.from("marketing_plans")
    .select("id,business_goal,valid_from,valid_until,status")
    .eq("owner_user_id", ownerId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // 4. Pending Approvals
  const { data: pendingActions } = await admin.from("mara_pending_actions")
    .select("id,tool_name,summary,sanitized_arguments,new_value,created_at,status")
    .eq("owner_user_id", ownerId)
    .in("status", ["pending", "failed"])
    .order("created_at", { ascending: false })
    .limit(50);

  const pendingApprovals: PendingApprovalState[] = (pendingActions ?? []).map((action) => {
    const args = (action.new_value ?? action.sanitized_arguments ?? {}) as Record<string, unknown>;
    const sourceDraftId = typeof args.sourceDraftId === "string" ? args.sourceDraftId : undefined;
    const isWorkflow = action.tool_name === "propose_calendar_item" || action.tool_name === "choose_reel_production";
    return {
      id: String(action.id),
      source: isWorkflow ? "workflow" : "other",
      title: String(args.title ?? action.summary ?? "Pending approval"),
      summary: String(action.summary ?? ""),
      createdAt: String(action.created_at),
      scheduledFor: typeof args.publishAt === "string" ? args.publishAt : undefined,
      sourceId: sourceDraftId,
    };
  });

  // 5. Active Campaigns & Campaign Actions
  // Load automated campaigns that overlap with the horizon window or were recently created
  const { data: campaignRows } = await admin.from("voom_campaigns")
    .select("id,name,goal,status,start_at,end_at,created_at")
    .eq("owner_user_id", ownerId)
    .eq("is_automated", true)
    .gte("end_at", horizonStartIso)
    .order("created_at", { ascending: false })
    .limit(20);

  const activeCampaigns: ActiveCampaignState[] = [];
  const campaignActionCommitments: CalendarCommitment[] = [];

  if (campaignRows && campaignRows.length > 0) {
    const campaignIds = campaignRows.map((c) => c.id);
    const { data: actionRows } = await admin.from("voom_campaign_actions")
      .select("id,campaign_id,slot,channel,stage,title,purpose,scheduled_for,status,draft_id,email_campaign_id,safety_blockers")
      .eq("owner_user_id", ownerId)
      .in("campaign_id", campaignIds)
      .gte("scheduled_for", horizonStartIso)
      .lte("scheduled_for", horizonEndIso);

    // Also check if any actions have failed or have missing media
    const draftIds = (actionRows ?? []).map((a) => a.draft_id).filter((id): id is string => Boolean(id));
    let assetsByDraft = new Set<string>();
    if (draftIds.length > 0) {
      const { data: assets } = await admin.from("mara_draft_assets")
        .select("draft_id,storage_path")
        .eq("owner_user_id", ownerId)
        .in("draft_id", draftIds);
      assetsByDraft = new Set((assets ?? []).filter((a) => Boolean(a.storage_path)).map((a) => String(a.draft_id)));
    }

    const actionsByCampaign = new Map<string, Array<Record<string, unknown>>>();
    for (const a of (actionRows ?? []) as Array<Record<string, unknown>>) {
      const campId = String(a.campaign_id);
      const list = actionsByCampaign.get(campId) ?? [];
      list.push(a);
      actionsByCampaign.set(campId, list);

      // Add every active social channel action as a date commitment. The
      // coordinator only computes coverage; execution remains in each
      // channel's existing approval and durable provider-queue workflow.
      const ch = String(a.channel);
      const isSocialVideo = ch === "tiktok_video" || ch === "youtube_short" || ch === "youtube_video";
      if ((ch.startsWith("instagram_") || isSocialVideo) && a.status !== "failed" && a.status !== "skipped") {
        const sched = String(a.scheduled_for);
        const localD = isoToLocalDate(sched, tz);
        const format: ContentType | "video" | "short" = ch === "instagram_reel" ? "reel"
          : ch === "instagram_story" ? "story"
          : ch === "youtube_short" ? "short"
          : isSocialVideo ? "video"
          : "post";
        campaignActionCommitments.push({
          id: String(a.id),
          source: "campaign",
          sourceId: campId,
          channel: ch as CalendarCommitment["channel"],
          format,
          title: String(a.title),
          publishAt: sched,
          localDate: localD,
          localTime: sched,
          // Coverage needs only the review decision. Provider publication
          // truth is owned by the separate durable queue and its worker.
          status: isSocialVideo
            ? (a.status === "approved" ? "approved" : "needs_approval")
            : a.status === "executed" ? "published" : a.status === "approved" ? "approved" : "needs_approval",
        });
      }
    }

    for (const camp of campaignRows) {
      const actions = actionsByCampaign.get(camp.id) ?? [];
      activeCampaigns.push({
        id: String(camp.id),
        name: String(camp.name),
        goal: String(camp.goal ?? "awareness"),
        lifecycle: String(camp.status),
        startAt: String(camp.start_at),
        endAt: String(camp.end_at),
        actions: actions.map((act) => {
          const ch = String(act.channel ?? "");
          const isInstagram = ch.startsWith("instagram_");
          const hasVisual = act.draft_id ? assetsByDraft.has(String(act.draft_id)) : true;
          const isFailed = act.status === "failed";
          const needsVisual = isInstagram && !hasVisual && act.status !== "executed";
          const needsApproval = act.status === "needs_approval";
          const needsAttn = isFailed || needsVisual || needsApproval;
          let reason: string | undefined;
          if (isFailed) reason = "Action execution failed";
          else if (needsVisual) reason = "Media asset missing";
          else if (needsApproval) reason = "Action awaits approval";

          return {
            id: String(act.id),
            channel: ch,
            stage: String(act.stage ?? "awareness"),
            title: String(act.title ?? ""),
            scheduledFor: String(act.scheduled_for ?? ""),
            status: String(act.status ?? "proposed"),
            needsAttention: needsAttn,
            attentionReason: reason,
          };
        }),
      });
    }
  }

  // 6. Marketing Plan Drafts & Calendar Items
  // Bounded query for drafts in horizon
  const { data: drafts } = await admin.from("mara_drafts")
    .select("id,source_plan_id,source_plan_item_key,kind,title,content,proposed_publish_at,status")
    .eq("owner_user_id", ownerId)
    .gte("proposed_publish_at", horizonStartIso)
    .lte("proposed_publish_at", horizonEndIso);

  // Calendar items in horizon
  const { data: calendarItems } = await admin.from("content_calendar_items")
    .select("id,source_draft_id,title,channel,publish_at,status")
    .eq("owner_user_id", ownerId)
    .gte("publish_at", horizonStartIso)
    .lte("publish_at", horizonEndIso);

  // Queue rows in horizon
  const { data: queueItems } = await admin.from("instagram_publish_queue")
    .select("id,draft_id,status,scheduled_at,failure_message")
    .eq("owner_user_id", ownerId)
    .gte("scheduled_at", horizonStartIso)
    .lte("scheduled_at", horizonEndIso);

  const queueByDraft = new Map((queueItems ?? []).map((q) => [String(q.draft_id), q]));

  const draftCommitments: CalendarCommitment[] = [];
  for (const d of drafts ?? []) {
    // Avoid double counting if it is already in campaignActionCommitments
    const alreadyCampaign = campaignActionCommitments.some((c) => c.id === String(d.id) || c.sourceId === String(d.id));
    if (alreadyCampaign) continue;

    const kind = String(d.kind ?? "instagram_post");
    // TikTok/YouTube planning drafts carry their real channel. This state is
    // used only for date coverage; the provider queue owns execution status.
    const isSocialDraft = kind === "tiktok_video" || kind === "youtube_short" || kind === "youtube_video";
    const format: ContentType | "video" | "short" = kind === "reel" ? "reel"
      : kind === "story" ? "story"
      : kind === "youtube_short" ? "short"
      : isSocialDraft ? "video"
      : "post";
    const publishAt = String(d.proposed_publish_at);
    const localD = isoToLocalDate(publishAt, tz);
    const qRow = queueByDraft.get(String(d.id));

    let status: CalendarCommitment["status"] = "proposed";
    if (isSocialDraft) {
      status = d.status === "approved" ? "approved" : d.status === "rejected" ? "failed" : "proposed";
    } else {
      if (qRow?.status === "published") status = "published";
      else if (qRow?.status === "publishing") status = "publishing";
      else if (qRow?.status === "failed") status = "failed";
      else if (qRow?.status === "waiting_for_media") status = "waiting_for_media";
      else if (qRow?.status === "scheduled") status = "scheduled";
      else if (d.status === "approved") status = "approved";
      else if (pendingApprovals.some((p) => p.sourceId === String(d.id))) status = "needs_approval";
    }

    draftCommitments.push({
      id: String(d.id),
      source: "workflow_plan",
      sourceId: String(d.source_plan_id ?? d.id),
      // In the non-social branch `format` is always post/reel/story at
      // runtime; the cast keeps the template inside the channel union.
      channel: isSocialDraft ? (kind as CalendarCommitment["channel"]) : `instagram_${format as ContentType}`,
      format,
      title: String(d.title),
      publishAt,
      localDate: localD,
      localTime: publishAt,
      status,
    });
  }

  // Also include standalone calendar items (direct user creation)
  const standaloneCalendarCommitments: CalendarCommitment[] = [];
  for (const c of calendarItems ?? []) {
    if (c.source_draft_id && (draftCommitments.some((dc) => dc.id === String(c.source_draft_id)) || campaignActionCommitments.some((cc) => cc.id === String(c.source_draft_id)))) {
      continue;
    }
    const channelLabel = String(c.channel ?? "").toLowerCase();
    // The calendar's native channel label decides the commitment identity.
    // This read is for date coverage only; queue state is read by the Calendar
    // and provider surfaces, not inferred from the mirror.
    const isTikTok = channelLabel === "tiktok";
    const isYouTubeShort = channelLabel === "youtube short";
    const isYouTubeVideo = channelLabel === "youtube video";
    const isSocialCalendar = isTikTok || isYouTubeShort || isYouTubeVideo;
    const format: ContentType | "video" | "short" = isYouTubeShort ? "short"
      : isSocialCalendar ? "video"
      : channelLabel.includes("reel") ? "reel"
      : channelLabel.includes("story") ? "story"
      : "post";
    const publishAt = String(c.publish_at);
    standaloneCalendarCommitments.push({
      id: String(c.id),
      source: "direct_calendar",
      sourceId: String(c.id),
      // In the non-social branch `format` is always post/reel/story at
      // runtime; the cast keeps the template inside the channel union.
      channel: isTikTok ? "tiktok_video" : isYouTubeShort ? "youtube_short" : isYouTubeVideo ? "youtube_video" : `instagram_${format as ContentType}`,
      format,
      title: String(c.title),
      publishAt,
      localDate: isoToLocalDate(publishAt, tz),
      localTime: publishAt,
      // A social mirror is presentation for an approved draft — 'scheduled'
      // would imply an execution path that does not exist.
      status: isSocialCalendar ? "approved" : c.status === "scheduled" ? "scheduled" : "approved",
    });
  }

  const allCommitments = [
    ...campaignActionCommitments,
    ...draftCommitments,
    ...standaloneCalendarCommitments,
  ];

  // 7. Email Marketing State
  let eligibleCount = 0;
  try {
    const { count } = await admin.from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", ownerId)
      .eq("email_status", "subscribed")
      .not("email", "is", null);
    eligibleCount = count ?? 0;
  } catch {
    // 0
  }

  // Recent campaign sends
  const { data: recentSends } = await admin.from("campaign_sends")
    .select("sent_at")
    .eq("owner_user_id", ownerId)
    .order("sent_at", { ascending: false })
    .limit(1);

  const lastSentAt = recentSends?.[0]?.sent_at ? String(recentSends[0].sent_at) : null;

  // Recent email campaign actions scheduled
  const { data: scheduledEmails } = await admin.from("voom_campaign_actions")
    .select("id")
    .eq("owner_user_id", ownerId)
    .eq("channel", "email")
    .in("status", ["proposed", "needs_approval", "approved", "scheduled"])
    .gte("scheduled_for", horizonStartIso);

  const scheduledEmailCount = scheduledEmails?.length ?? 0;

  // 7b. Lifecycle email flows (Email Automation v2) are authoritative
  // marketing state. They are read here so the Coordinator knows what already
  // exists and never proposes a duplicate Welcome or Re-engagement flow.
  // Missing 0040 schema degrades to "no flows" instead of throwing.
  const flows: EmailFlowState[] = [];
  let scheduledLifecycleEmailCount = 0;
  let lastLifecycleSendAt: string | null = null;
  try {
    const { data: flowRows } = await admin.from("voom_email_flows")
      .select("id,flow_type,name,status,created_by")
      .eq("owner_user_id", ownerId)
      .neq("status", "archived")
      .order("created_at", { ascending: false })
      .limit(20);

    const flowList = (flowRows ?? []) as Array<Record<string, unknown>>;
    if (flowList.length > 0) {
      const flowIds = flowList.map((flow) => String(flow.id));
      const [{ data: enrollmentRows }, { data: runRows }] = await Promise.all([
        admin.from("voom_email_flow_enrollments")
          .select("flow_id,status")
          .eq("owner_user_id", ownerId)
          .in("flow_id", flowIds)
          .limit(5000),
        admin.from("voom_email_flow_step_runs")
          .select("flow_id,status,scheduled_for,accepted_at,delivered_at")
          .eq("owner_user_id", ownerId)
          .in("flow_id", flowIds)
          .limit(5000),
      ]);

      const enrollments = (enrollmentRows ?? []) as Array<{ flow_id: string; status: string }>;
      const runs = (runRows ?? []) as Array<{ flow_id: string; status: string; scheduled_for: string | null; accepted_at: string | null; delivered_at: string | null }>;

      scheduledLifecycleEmailCount = runs.filter((run) => run.status === "scheduled" || run.status === "sending").length;
      for (const run of runs) {
        const at = run.delivered_at ?? run.accepted_at;
        if (!at) continue;
        if (!lastLifecycleSendAt || Date.parse(at) > Date.parse(lastLifecycleSendAt)) lastLifecycleSendAt = at;
      }

      for (const row of flowList) {
        const flowId = String(row.id);
        const flowEnrollments = enrollments.filter((e) => String(e.flow_id) === flowId);
        const nextScheduled = runs
          .filter((run) => String(run.flow_id) === flowId && run.status === "scheduled" && run.scheduled_for)
          .map((run) => String(run.scheduled_for))
          .sort()[0] ?? null;
        const failedRuns = runs.filter((run) => String(run.flow_id) === flowId && run.status === "failed").length;
        const status = String(row.status);
        const createdBy = String(row.created_by ?? "user") === "coordinator" ? "coordinator" : "user";
        const needsAttention = status === "draft" || (status === "active" && failedRuns > 0);

        flows.push({
          id: flowId,
          flowType: String(row.flow_type) === "re_engagement" ? "re_engagement" : "welcome",
          name: String(row.name ?? ""),
          status: status as EmailFlowState["status"],
          createdBy,
          enrolled: flowEnrollments.length,
          activeEnrollments: flowEnrollments.filter((e) => e.status === "active").length,
          nextScheduledAt: nextScheduled,
          needsAttention,
          attentionReason: status === "draft"
            ? (createdBy === "coordinator"
              ? "MARA proposed this flow; it needs your approval before anyone is enrolled."
              : "This flow is still a draft.")
            : failedRuns > 0
              ? `${failedRuns} lifecycle email${failedRuns === 1 ? "" : "s"} failed.`
              : null,
        });
      }
    }
  } catch {
    // 0040 not applied yet: no lifecycle flows, and the Coordinator still works.
  }

  const welcomeCovered = flows.some((flow) => flow.flowType === "welcome");
  const reEngagementCovered = flows.some((flow) => flow.flowType === "re_engagement");
  const activeLifecycleEnrollments = flows.reduce((total, flow) => total + flow.activeEnrollments, 0);

  // A lifecycle flow that already covers the need is never re-proposed.
  const flowOpportunities: EmailFlowOpportunity[] = [];
  if (!welcomeCovered && eligibleCount >= 1) {
    flowOpportunities.push({
      flowType: "welcome",
      reason: `You have ${eligibleCount} subscribed contact${eligibleCount === 1 ? "" : "s"} and no Welcome flow. MARA can prepare a welcome sequence; nothing is sent until you activate it.`,
    });
  }
  if (!reEngagementCovered && eligibleCount >= 5) {
    flowOpportunities.push({
      flowType: "re_engagement",
      reason: `You have ${eligibleCount} subscribed contacts and no Re-engagement flow. MARA can prepare one for contacts Voom has not emailed in a while; nothing is sent until you activate it.`,
    });
  }

  // The most recent real send of ANY kind, so "you haven't emailed in a week"
  // is never claimed while a lifecycle flow is sending.
  const effectiveLastSentAt = [lastSentAt, lastLifecycleSendAt]
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;

  const daysSinceLastSend = effectiveLastSentAt ? (now.getTime() - new Date(effectiveLastSentAt).getTime()) / (1000 * 60 * 60 * 24) : 999;
  const emailOpportunityAvailable = eligibleCount >= 5
    && scheduledEmailCount === 0
    && scheduledLifecycleEmailCount === 0
    && daysSinceLastSend >= 7;

  const emailState: EmailMarketingState = {
    eligibleContactsCount: eligibleCount,
    recentCampaignCount: scheduledEmailCount,
    lastSentAt: effectiveLastSentAt,
    scheduledEmailCount,
    opportunityAvailable: emailOpportunityAvailable,
    opportunityReason: emailOpportunityAvailable
      ? `You have ${eligibleCount} contacts ready and haven't sent an email update in over a week.`
      : undefined,
    flows,
    scheduledLifecycleEmailCount,
    activeLifecycleEnrollments,
    welcomeCovered,
    reEngagementCovered,
    flowOpportunities,
  };

  const businessProfile: MarketingStateBusinessProfile = {
    id: String(businessRow.id),
    brandName: String(businessRow.brand_name ?? "Your Business"),
    brandDescription: String(businessRow.brand_description ?? ""),
    industry: String(businessRow.industry ?? ""),
    targetCustomer: Array.isArray(businessRow.target_customer) ? businessRow.target_customer : [],
    mainGoal: String(businessRow.main_goal ?? "Grow awareness"),
    brandPersonality: Array.isArray(businessRow.brand_personality) ? businessRow.brand_personality : [],
    preferredChannels: Array.isArray(businessRow.preferred_channels) ? businessRow.preferred_channels : ["Instagram"],
    contentFrequency: String(businessRow.content_frequency ?? "3x_week"),
    automationLevel: mode,
    timezone: tz,
    plan: planId,
    allowAutomaticPaidMedia,
  };

  return {
    ownerId,
    businessId: String(businessRow.id),
    business: businessProfile,
    timezone: tz,
    now: now.toISOString(),
    todayLocalDate: today,
    horizonStart,
    horizonEnd,
    cadence,
    mode,
    credits,
    commitments: allCommitments,
    activeCampaigns,
    pendingApprovals,
    emailState,
    performance: performanceState,
    currentPlanId: activePlan?.id ? String(activePlan.id) : null,
  };
}
