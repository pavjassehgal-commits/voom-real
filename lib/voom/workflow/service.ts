import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiError, createAiProvider, type AiProvider } from "@/lib/ai";
import { evaluateAutopilotRecommendation } from "@/lib/mara/autopilot-safety";
import { composePostCaption } from "@/lib/post/core";
import { APPROVAL_CONTENT_CHANGED, approvePostDraft, syncPostToCalendar, type AdminClient } from "@/lib/post/server-data";
import { loadPerformancePlanContext } from "@/lib/performance/data";
import type { PerformancePlanContext } from "@/lib/performance/plan-context";
import { mayAutomaticallyGeneratePaidMedia, normalizeAutomationMode, type AutomationModeValue, type WorkflowTrigger } from "@/lib/voom/automation";
import { canUseAutomationMode, normalizePlan } from "@/lib/billing/plans";
import { assertAutonomousWorkAllowed } from "@/lib/voom/automation-safety";
import { CADENCE_LABELS, cadenceAnchorDate, normalizeCadence, type Cadence, type ContentType } from "@/lib/voom/cadence";
import { accountTimezone, formatLocalTime, localDate } from "@/lib/voom/timezone";
import { ensureWorkflowMedia, type WorkflowMediaDeps } from "./media";
import type { TrendPromptContext } from "@/lib/trends/opportunity";
import { checkTrendGroundedContent, checkTrendUsage } from "@/lib/trends/claim-check";
import { loadOwnerTrendPromptContext, type TrendWorkflowClient } from "@/lib/trends/workflow-context";
import { loadBusinessTrendIdeas } from "@/lib/trends/business-trends";
import { buildMarketingState } from "@/lib/coordinator/state";
import { identifyCalendarGaps } from "@/lib/coordinator/engine";
import { MAX_TREND_IDEAS_PER_RUN } from "@/lib/trends/relevance";
import type { TrendRpcClient } from "@/lib/trends/supabase-rpc";
import { buildPlannedContentPayload, plannedContentJsonSchema, plannedContentSchema, plannedContentSystemPrompt } from "./prompt";
import { brandKitPromptContext, loadBrandKit, type BrandKitPromptContext } from "@/lib/brand/context";
import { trendContextEnabled } from "./trend-flag";
import { slotLeaseSeconds } from "./slot-lease";
import { aiRequestTimeoutMs } from "@/lib/ai/config";
import {
  ensureRollingPlan,
  type GeneratedContent,
  type IdeaBasis,
  type PlanSlot,
  type RollingPlanPorts,
  type RollingPlanResult,
  type WorkflowItem,
  type WorkflowStage,
} from "./rolling-plan";
import { calendarChannelForContentType, draftKindForContentType } from "./state";
import { createSocialDraft } from "@/lib/social/server-drafts";
import {
  PLAN_CHANNEL_LABELS,
  planActionChannelFor,
  isPlanChannelFormat,
  type PlanFormat,
  type PlanChannel,
  composeLinkedInPlanText,
} from "./channels";
import {
  normalizeSelectedSocialChannels,
  parseWorkflowSlotIdentity,
  type ChannelCoverage,
  type PlannedContentType,
} from "./channel-planner";

/**
 * Wires the pure rolling-plan engine to Voom's existing production systems.
 *
 * Reused, never re-implemented:
 *   - marketing_plans          -> the plan header + rendered horizon,
 *   - mara_drafts              -> THE executable content item (one per assigned slot),
 *   - TikTok/YouTube drafts    -> the existing social-draft + provider-queue architecture,
 *   - mara_media_generations   -> the existing Instagram media-generation workflow,
 *   - mara_pending_actions     -> existing Instagram approvals,
 *   - content_calendar_items   -> the visual schedule (mirror of the draft),
 *   - instagram_publish_queue  -> the existing Instagram publish queue,
 *   - evaluateAutopilotRecommendation -> the one Instagram safety evaluator.
 */

export const WORKFLOW_CONVERSATION_TITLE = "Voom marketing workflow";

export interface WorkflowRunInput {
  ownerId: string;
  now?: Date;
  cadence?: Cadence;
  /**
   * What started the run. Defaults to "scheduled" (cron). The Marketing Plan
   * route passes "replenish" for the owner's explicit Build/Replenish click.
   */
  trigger?: WorkflowTrigger;
  /**
   * "planning_only" runs the same cadence-aware rolling planner and persists
   * the same drafts/plan items, but stops before `ensureMedia` and
   * `autoApproveAndSchedule`: no provider call, no media job, no approval, no
   * calendar scheduling, no queueing, no publishing. Defaults to "full" —
   * except that the central paid-media policy forces Manual runs to
   * planning-only regardless of what is requested.
   */
  stage?: WorkflowStage;
  /**
   * Test seam only: the provider-side effects of the media stage (see
   * lib/voom/workflow/media.ts). Production callers never pass this, so the
   * real Seedream/Seedance wiring is used.
   */
  mediaDeps?: Partial<WorkflowMediaDeps>;
  /** Actual local-date gaps from the coordinator; when supplied, no other date is generated. */
  targetDates?: string[];
  /** See RollingPlanInput.creatableDates. Replenish derives it when omitted. */
  creatableDates?: string[];
  /**
   * Test seam only: how long a run waits for another worker that holds a
   * slot's generation lease. Production uses the defaults below.
   */
  slotLeaseWait?: { pollMs: number; maxWaitMs: number };
  /** Other channel commitments in the coordinator's authoritative horizon. */
  channelCoverage?: ChannelCoverage[];
  /**
   * Test seam only: MARA's structured-output provider and the performance
   * context loader. Production callers never pass this, so planning uses the
   * real provider and the real stored performance snapshots.
   */
  planningDeps?: WorkflowPlanningDeps;
}

/**
 * The two planning side inputs, injectable for tests. Both default to the
 * production implementations, so a normal run reads real snapshots and calls
 * the real model.
 */
export interface WorkflowPlanningDeps {
  provider?: AiProvider;
  performanceContext?: (db: AdminClient, ownerId: string) => Promise<PerformancePlanContext | null>;
  /**
   * Verified trend evidence for this owner. Consulted ONLY when the
   * VOOM_TREND_CONTEXT_ENABLED flag is on. Production uses the fail-closed
   * service-role loader; tests may inject a deterministic fixture.
   */
  trendContext?: (db: AdminClient, ownerId: string, now: Date) => Promise<TrendPromptContext | null>;
  /**
   * Automatically matched trend ideas for this business (flag-gated; used only
   * when no reviewed owner context exists). Production reads governed evidence
   * and matches it to the business's own profile; tests may inject fixtures.
   */
  trendIdeas?: (db: AdminClient, business: Record<string, unknown>, now: Date) => Promise<TrendPromptContext[]>;
}

type TrendPlan =
  | { mode: "reviewed"; context: TrendPromptContext }
  | { mode: "matched"; contexts: TrendPromptContext[] }
  | { mode: "none"; enabled: boolean };

function businessTrendProfileInput(business: Record<string, unknown>) {
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    brandName: text(business.brand_name),
    description: text(business.brand_description),
    industry: text(business.industry),
    targetCustomer: Array.isArray(business.target_customer) ? business.target_customer.map(String) : text(business.target_customer),
    goal: text(business.main_goal),
  };
}

function ideaBasisFor(kind: "reviewed_trend" | "verified_trend", context: TrendPromptContext): IdeaBasis {
  return {
    kind,
    topic: context.topic,
    market: context.market.country,
    sources: [...new Set(context.facts.flatMap((fact) => fact.sources))].slice(0, 3),
    observedAt: context.observedAt,
  };
}

/**
 * Runs the rolling workflow for one owner under the account's SAVED automation
 * mode. The mode is deliberately not a parameter: no caller can run a Manual
 * account "as Assisted" (the production Replenish bug) — Manual stays Manual
 * for the whole run, and the paid-media ports refuse accordingly.
 */
export async function runOwnerWorkflow(admin: AdminClient, input: WorkflowRunInput): Promise<RollingPlanResult> {
  const now = input.now ?? new Date();
  const { data: business } = await admin.from("businesses")
    .select("id,brand_name,brand_description,industry,target_customer,main_goal,brand_personality,preferred_channels,content_frequency,automation_level,automation_paused_at,timezone,plan")
    .eq("owner_user_id", input.ownerId).maybeSingle();
  if (!business) throw new Error("business_not_found");

  const timeZone = accountTimezone((business as { timezone?: string | null }).timezone);
  const cadence = input.cadence ?? normalizeCadence(business.content_frequency);
  
  const planId = normalizePlan((business as { plan?: string | null }).plan);
  let mode = normalizeAutomationMode(business.automation_level);
  if (!canUseAutomationMode(planId, mode)) {
    mode = planId === "pro" ? "assisted" : "manual";
  }
  const trigger: WorkflowTrigger = input.trigger === "replenish" ? "replenish" : "scheduled";
  if (trigger === "scheduled" && (business as { automation_paused_at?: string | null }).automation_paused_at) {
    throw new Error("automation_paused");
  }
  const goal = String(business.main_goal ?? "Grow awareness");
  const selectedChannels = normalizeSelectedSocialChannels(business.preferred_channels);
  // Brand Kit v2: read once per run; never throws (no kit = unchanged prompts).
  const brandKit = brandKitPromptContext(await loadBrandKit(admin, input.ownerId));
  // The cadence pattern is pinned to the active plan's start so every run, on
  // any day, plans the same dates (the coordinator resolves the same anchor).
  const { data: activePlan, error: activePlanError } = await admin.from("marketing_plans").select("created_at")
    .eq("owner_user_id", input.ownerId).eq("status", "active")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (activePlanError) throw new Error("plan_read_failed");
  const anchorDate = cadenceAnchorDate(activePlan?.created_at, timeZone, localDate(now, timeZone));
  // An explicit Replenish fills only dates that keep every rolling 7-day
  // window within the cadence, using the same evaluation as scheduled runs
  // (published, approved and later-scheduled work all count). Coordinator runs
  // pass their own gap dates instead.
  let creatableDates = input.creatableDates;
  if (creatableDates === undefined && input.targetDates === undefined) {
    const state = await buildMarketingState(admin, input.ownerId, String(business.id), now);
    creatableDates = identifyCalendarGaps({ ...state, cadence }).map((gap) => gap.date);
  }

  const ports = await buildWorkflowPorts(admin, {
    ownerId: input.ownerId,
    businessId: String(business.id),
    business,
    timeZone,
    cadence,
    goal,
    now,
    mode,
    trigger,
    selectedChannels,
    brandKit,
    targetDates: input.targetDates,
    channelCoverage: input.channelCoverage,
    mediaDeps: input.mediaDeps,
    planningDeps: input.planningDeps,
    slotLeaseWait: input.slotLeaseWait,
  });
  return ensureRollingPlan(ports, {
    now,
    timeZone,
    cadence,
    mode,
    goal,
    selectedChannels,
    targetDates: input.targetDates,
    channelCoverage: input.channelCoverage,
    cadenceAnchorDate: anchorDate,
    creatableDates,
    stage: input.stage,
    trigger,
  });
}

interface PortContext {
  ownerId: string;
  businessId: string;
  business: Record<string, unknown>;
  timeZone: string;
  cadence: Cadence;
  goal: string;
  now: Date;
  /** The account's saved mode and what started the run — the paid-media guard reads both. */
  mode: AutomationModeValue;
  trigger: WorkflowTrigger;
  /** Canonical selected social channels from businesses.preferred_channels. */
  selectedChannels?: PlanChannel[];
  /** Brand Kit extras for every prompt of this run (migration 0075, Brand Kit v2); null = none. */
  brandKit?: BrandKitPromptContext | null;
  /** Coordinator gap dates and the actual existing channel commitments. */
  targetDates?: string[];
  channelCoverage?: ChannelCoverage[];
  /** Test seam only; production uses the module defaults. */
  mediaDeps?: Partial<WorkflowMediaDeps>;
  /** Test seam only; production uses the real provider and stored snapshots. */
  planningDeps?: WorkflowPlanningDeps;
  /** Test seam only; see WorkflowRunInput.slotLeaseWait. */
  slotLeaseWait?: { pollMs: number; maxWaitMs: number };
}

const SLOT_LEASE_WAIT = { pollMs: 1_000, maxWaitMs: 20_000 };

/**
 * Returned by the paid-media / approval ports when the central policy forbids
 * automatic media for this (mode, trigger). The engine never reaches these
 * ports for such a run, so seeing this code means a caller bypassed the
 * engine — and it is refused here regardless. Server-side, not UI-side.
 */
export const AUTOMATIC_MEDIA_FORBIDDEN = "automatic_media_forbidden_for_mode";

export async function buildWorkflowPorts(admin: AdminClient, context: PortContext): Promise<RollingPlanPorts> {
  const conversationId = await ensureWorkflowConversation(admin, context.ownerId);
  const plannedConcepts: string[] = [];
  // Read measured Instagram results once, lazily. A read failure is advisory
  // only and cannot change the immutable platform assignment.
  let performanceContext: Promise<PerformancePlanContext | null> | null = null;
  const performanceContextForPlanning = () => {
    performanceContext ??= (context.planningDeps?.performanceContext ?? loadPerformancePlanContext)(admin, context.ownerId)
      .catch(() => null);
    return performanceContext;
  };
  // Trend evidence: flag-gated and loaded at most once per run. A reviewed
  // owner context applies to every slot (existing behavior). Otherwise up to
  // MAX_TREND_IDEAS_PER_RUN automatically matched ideas fill the first slots
  // and the rest stay evergreen. Any failure to load simply plans without it.
  let trendPlan: Promise<TrendPlan> | null = null;
  let matchedSlotsUsed = 0;
  const trendPlanForRun = (): Promise<TrendPlan> => {
    if (!trendContextEnabled()) return Promise.resolve({ mode: "none", enabled: false });
    trendPlan ??= (async (): Promise<TrendPlan> => {
      const reviewedLoader = context.planningDeps?.trendContext
        ?? ((db: AdminClient, ownerId: string, now: Date) => loadOwnerTrendPromptContext(db as unknown as TrendWorkflowClient, ownerId, now));
      const reviewed = await reviewedLoader(admin, context.ownerId, context.now).catch(() => null);
      if (reviewed) return { mode: "reviewed", context: reviewed };
      const matcher = context.planningDeps?.trendIdeas
        ?? (async (db: AdminClient, business: Record<string, unknown>, now: Date) => {
          const selection = await loadBusinessTrendIdeas(db as unknown as TrendRpcClient, businessTrendProfileInput(business), now, { max: MAX_TREND_IDEAS_PER_RUN });
          return selection.status === "matched" ? selection.ideas.map((idea) => idea.context) : [];
        });
      const contexts = await matcher(admin, context.business, context.now).catch(() => [] as TrendPromptContext[]);
      return contexts.length > 0
        ? { mode: "matched", contexts: contexts.slice(0, MAX_TREND_IDEAS_PER_RUN) }
        : { mode: "none", enabled: true };
    })();
    return trendPlan;
  };

  return {
    async getActivePlan() {
      const { data, error } = await admin.from("marketing_plans").select("id")
        .eq("owner_user_id", context.ownerId).eq("status", "active")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error("plan_read_failed");
      return data?.id ? String(data.id) : null;
    },

    async ensurePlan({ validFrom, validUntil, cadence, goal, selectedChannels }) {
      const channelLabels = selectedChannels.map((channel) => PLAN_CHANNEL_LABELS[channel]);
      const { data: existing, error: readError } = await admin.from("marketing_plans").select("id")
        .eq("owner_user_id", context.ownerId).eq("status", "active")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (readError) throw new Error("plan_read_failed");
      if (existing?.id) {
        const { error } = await admin.from("marketing_plans")
          .update({
            valid_from: validFrom,
            valid_until: validUntil,
            content_frequency: CADENCE_LABELS[cadence],
            selected_channels: channelLabels,
          })
          .eq("owner_user_id", context.ownerId).eq("id", existing.id);
        if (error) throw new Error("plan_update_failed");
        return String(existing.id);
      }
      const channelSummary = channelLabels.length ? channelLabels.join(", ") : "no selected social channels";
      const { data: created, error } = await admin.from("marketing_plans").insert({
        owner_user_id: context.ownerId,
        business_id: context.businessId,
        status: "active",
        business_goal: goal.slice(0, 1000) || "Grow awareness",
        weekly_strategy: `Rolling ${CADENCE_LABELS[cadence]} social plan for ${channelSummary}, starting ${validFrom}.`,
        selected_channels: channelLabels,
        content_frequency: CADENCE_LABELS[cadence],
        planned_posts: [],
        planned_campaigns: [],
        recommendations: [],
        source_summary: { engine: "rolling_plan_v3", timezone: context.timeZone },
        valid_from: validFrom,
        valid_until: validUntil,
      }).select("id").single();
      if (error?.code === "23505") {
        // A concurrent run (double click, or cron + Build) created the one
        // active plan first; reuse it instead of failing this run.
        const { data: winner } = await admin.from("marketing_plans").select("id")
          .eq("owner_user_id", context.ownerId).eq("status", "active").limit(1).maybeSingle();
        if (winner?.id) return String(winner.id);
      }
      if (error || !created) throw new Error("plan_store_failed");
      return String(created.id);
    },

    async listItems(planId) {
      const { data, error } = await admin.from("mara_drafts")
        .select("id,kind,social_channel,social_format,title,content,content_meta,proposed_publish_at,status,source_plan_item_key,content_version")
        .eq("owner_user_id", context.ownerId).eq("source_plan_id", planId);
      if (error) throw new Error("plan_items_read_failed");
      const rows = (data ?? []) as Record<string, unknown>[];
      if (!rows.length) return [];
      const ids = rows.map((row) => String(row.id));
      const [approvalRows, instagramQueues, tiktokQueues, youtubeQueues, linkedinQueues] = await Promise.all([
        admin.from("mara_pending_actions").select("sanitized_arguments,new_value,status")
          .eq("owner_user_id", context.ownerId).eq("tool_name", "propose_calendar_item").in("status", ["pending", "failed"]),
        admin.from("instagram_publish_queue").select("draft_id,status").eq("owner_user_id", context.ownerId).in("draft_id", ids),
        admin.from("tiktok_publish_queue").select("draft_id,status").eq("owner_user_id", context.ownerId).in("draft_id", ids),
        admin.from("youtube_publish_queue").select("draft_id,status").eq("owner_user_id", context.ownerId).in("draft_id", ids),
        admin.from("linkedin_publish_queue").select("draft_id,status").eq("owner_user_id", context.ownerId).in("draft_id", ids),
      ]);
      if (approvalRows.error || instagramQueues.error || tiktokQueues.error || youtubeQueues.error || linkedinQueues.error) {
        throw new Error("plan_reconcile_state_read_failed");
      }
      const approvalIds = new Set<string>();
      for (const row of approvalRows.data ?? []) {
        const value = (row.new_value ?? row.sanitized_arguments ?? null) as Record<string, unknown> | null;
        if (typeof value?.sourceDraftId === "string") approvalIds.add(value.sourceDraftId);
      }
      const queuedIds = new Set<string>();
      for (const queue of [instagramQueues, tiktokQueues, youtubeQueues, linkedinQueues]) {
        for (const row of queue.data ?? []) {
          if (row.status !== "cancelled") queuedIds.add(String(row.draft_id));
        }
      }
      const items = rows.flatMap((row) => {
        const draftId = String(row.id);
        const item = toWorkflowItem(row, {
          protected: row.status === "approved" || approvalIds.has(draftId) || queuedIds.has(draftId),
        });
        return item ? [item] : [];
      });
      for (const item of items) plannedConcepts.push(item.concept);
      return items;
    },

    async detachDrafts(planId, draftIds) {
      if (!draftIds.length) return;
      const { error } = await admin.from("mara_drafts").update({ source_plan_id: null, source_plan_item_key: null })
        .eq("owner_user_id", context.ownerId).eq("source_plan_id", planId).in("status", ["draft", "rejected"]).in("id", draftIds);
      if (error) throw new Error("plan_reconcile_failed");
    },

    async generateContent(slot) {
      const plan = await trendPlanForRun();
      const base = {
        ownerId: context.ownerId,
        businessId: context.businessId,
        business: context.business,
        goal: context.goal,
        cadence: context.cadence,
        timeZone: context.timeZone,
        slot,
        plannedConcepts,
        brandKit: context.brandKit ?? null,
        performance: slot.channel === "instagram" ? await performanceContextForPlanning() : null,
        ...(context.planningDeps?.provider ? { provider: context.planningDeps.provider } : {}),
      };
      if (plan.mode === "reviewed") {
        const content = await generateWorkflowPlannedContent({ ...base, trendOpportunity: plan.context });
        return { ...content, ideaBasis: ideaBasisFor("reviewed_trend", plan.context) };
      }
      if (plan.mode === "matched" && matchedSlotsUsed < plan.contexts.length) {
        const opportunity = plan.contexts[matchedSlotsUsed];
        matchedSlotsUsed += 1;
        try {
          const content = await generateWorkflowPlannedContent({ ...base, trendOpportunity: opportunity });
          return { ...content, ideaBasis: ideaBasisFor("verified_trend", opportunity) };
        } catch (reason) {
          // A trend idea that cannot be written within its evidence becomes an
          // evergreen idea for this slot. A rate limit is never retried.
          const failure = reason instanceof Error ? reason : null;
          if (failure?.message !== "content_generation_failed") throw reason;
        }
      }
      const content = await generateWorkflowPlannedContent({ ...base, trendOpportunity: null });
      return plan.mode === "none" && !plan.enabled ? content : { ...content, ideaBasis: { kind: "evergreen" } };
    },

    async createDraft({ planId, slot, content }) {
      if (slot.channel !== "instagram" && slot.channel !== "linkedin") {
        const kind = socialDraftKind(slot.channel, slot.format);
        const draftId = await createSocialDraft(admin, context.ownerId, {
          kind,
          title: content.concept,
          caption: composeSocialVideoCaption(content),
          description: content.description,
          concept: content.concept,
          hook: content.hook,
          cta: content.cta,
          hashtags: content.hashtags,
          script: content.script,
          productionGuidance: content.visualBrief,
          ...(content.ideaBasis ? { ideaBasis: content.ideaBasis } : {}),
          scheduledAt: slot.publishAt,
          planSource: { planId, slotKey: slot.slotKey },
        });
        const item: WorkflowItem = {
          draftId,
          slotKey: slot.slotKey,
          channel: slot.channel,
          format: slot.format,
          contentType: slot.contentType,
          concept: content.concept,
          caption: composeSocialVideoCaption(content),
          publishAt: slot.publishAt,
          status: "draft",
          protected: false,
        };
        plannedConcepts.push(content.concept);
        return item;
      }

      const isLinkedIn = slot.channel === "linkedin";
      const caption = isLinkedIn ? composeLinkedInPlanText(content)
        : composePostCaption({ caption: content.caption, cta: content.cta, hashtags: content.hashtags });
      const row = {
        owner_user_id: context.ownerId,
        conversation_id: conversationId,
        source_plan_id: planId,
        source_plan_item_key: slot.slotKey,
        kind: isLinkedIn ? "linkedin_text" : draftKindForContentType(slot.contentType as ContentType),
        channel: isLinkedIn ? "LinkedIn" : calendarChannelForContentType(slot.contentType as ContentType),
        title: content.concept.slice(0, 160),
        content: (caption || content.concept).slice(0, 12000),
        proposed_publish_at: slot.publishAt,
        status: "draft",
        media_brief: isLinkedIn ? null : content.visualBrief.slice(0, 800),
        social_channel: slot.channel,
        social_format: slot.format,
        content_meta: {
          concept: content.concept,
          hook: content.hook,
          cta: content.cta,
          hashtags: content.hashtags,
          ...(content.ideaBasis ? { idea_basis: content.ideaBasis } : {}),
        },
      };
      const { data, error } = await admin.from("mara_drafts")
        .upsert(row, { onConflict: "owner_user_id,source_plan_id,source_plan_item_key", ignoreDuplicates: true })
        .select("id,kind,social_channel,social_format,title,content,content_meta,proposed_publish_at,status,source_plan_item_key")
        .maybeSingle();
      if (error && error.code !== "23505") throw new Error("draft_create_failed");
      if (data) {
        plannedConcepts.push(content.concept);
        const item = toWorkflowItem(data, { protected: false });
        if (!item) throw new Error("draft_create_failed");
        return item;
      }
      const { data: existing, error: existingError } = await admin.from("mara_drafts")
        .select("id,kind,social_channel,social_format,title,content,content_meta,proposed_publish_at,status,source_plan_item_key")
        .eq("owner_user_id", context.ownerId).eq("source_plan_id", planId).eq("source_plan_item_key", slot.slotKey).maybeSingle();
      if (existingError || !existing) throw new Error("draft_create_failed");
      const item = toWorkflowItem(existing, { protected: existing.status === "approved" });
      if (!item) throw new Error("draft_create_failed");
      return item;
    },

    async ensureMedia(item) {
      if (item.channel !== "instagram") return { ok: false, code: "instagram_media_only" };
      if (!mayAutomaticallyGeneratePaidMedia(context.mode, context.trigger)) {
        return { ok: false, code: AUTOMATIC_MEDIA_FORBIDDEN };
      }
      await assertAutonomousWorkAllowed(admin, context.ownerId);
      const { data: draft } = await admin.from("mara_drafts").select("media_brief")
        .eq("owner_user_id", context.ownerId).eq("id", item.draftId).maybeSingle();
      return ensureWorkflowMedia(admin, {
        ownerId: context.ownerId,
        draftId: item.draftId,
        conversationId,
        contentType: item.contentType as ContentType,
        concept: item.concept,
        visualBrief: String(draft?.media_brief ?? item.concept),
        mode: context.mode,
      }, { deps: context.mediaDeps });
    },

    async requestApproval(item) {
      if (item.channel !== "instagram") return;
      // Re-check the authoritative mode, plan entitlement and emergency pause
      // immediately before opening automated approval work. A coordinator run
      // that started before a downgrade or pause must fail closed here.
      await assertAutonomousWorkAllowed(admin, context.ownerId, context.mode);
      await ensureApprovalAction(admin, {
        ownerId: context.ownerId, conversationId, item, timeZone: context.timeZone,
      });
    },

    async autoApproveAndSchedule(item) {
      if (item.channel !== "instagram" || context.mode !== "autopilot") {
        return { approved: false, reason: AUTOMATIC_MEDIA_FORBIDDEN };
      }
      // Complete-content approval: Autopilot approves the FINAL post, media
      // included. A visual still generating (async Reel video) parks the item
      // as awaiting media; when it arrives, media-arrival.ts re-runs these
      // same checks on the final content before approving. No card is opened
      // for it in the meantime, so there is no approval loop.
      if (!(await draftHasVisual(admin, context.ownerId, item.draftId))) {
        await markAutopilotAwaitingMedia(admin, context.ownerId, item.draftId);
        return { approved: false, reason: AUTOPILOT_AWAITING_MEDIA };
      }
      const safety = evaluateAutopilotRecommendation({
        title: item.concept, content: item.caption, publishAt: item.publishAt,
      }, context.now);
      if (!safety.safe) return { approved: false, reason: safety.blockers.join(",") };
      // Reload the authoritative mode, pause state and plan at the final
      // boundary. A run that started before a downgrade/pause cannot approve.
      await assertAutonomousWorkAllowed(admin, context.ownerId);
      // The safety checks above ran on the content read at item.contentVersion;
      // Autopilot approves exactly that version, never a concurrent edit.
      try {
        await approveWorkflowItem(admin, context.ownerId, item.draftId, "autopilot", item.contentVersion);
      } catch (err) {
        if (err instanceof Error && err.message === APPROVAL_CONTENT_CHANGED) return { approved: false, reason: "content_changed" };
        throw err;
      }
      await recordAutoApproval(admin, {
        ownerId: context.ownerId, conversationId, item, checks: safety.checks, timeZone: context.timeZone,
      });
      return { approved: true };
    },

    async savePlanItems(planId, items) {
      const plannedPosts = items.map((item) => {
        const identity = parseWorkflowSlotIdentity(item.slotKey);
        const actionChannel = planActionChannelFor(item.channel, item.format);
        return {
          draftId: item.draftId,
          slotDate: identity?.date ?? item.slotKey,
          slotKey: item.slotKey,
          channelFormat: actionChannel,
          channel: PLAN_CHANNEL_LABELS[item.channel],
          format: item.format,
          contentType: item.contentType,
          title: item.concept,
          content: item.caption,
          proposedPublishAt: item.publishAt,
        };
      });
      const { error } = await admin.from("marketing_plans").update({ planned_posts: plannedPosts })
        .eq("owner_user_id", context.ownerId).eq("id", planId);
      if (error) throw new Error("plan_items_save_failed");
    },

    async claimSlot(planId, slot) {
      // The lease covers the slowest generation this configuration allows; a
      // configuration it cannot cover (or an invalid timeout) starts nothing.
      let leaseSeconds: number | null;
      try {
        leaseSeconds = slotLeaseSeconds({
          requestTimeoutMs: aiRequestTimeoutMs(),
          generationsPerSlot: trendContextEnabled() ? 2 : 1,
        });
      } catch {
        leaseSeconds = null;
      }
      if (leaseSeconds === null) throw new Error("slot_lease_budget_exceeded");
      // Fail closed: without a durable lease no paid generation starts.
      const { data, error } = await admin.rpc("claim_plan_slot_generation", {
        p_owner_user_id: context.ownerId,
        p_plan_id: planId,
        p_slot_key: slot.slotKey,
        p_lease_seconds: leaseSeconds,
      });
      // The function returns a set: one row when claimed, none when held.
      // Anything else is an unknown state and starts no generation.
      if (error || !Array.isArray(data)) throw new Error("slot_lease_unavailable");
      const row = data[0] as { lease_id?: string; fence?: number | string } | undefined;
      if (!row) return { status: "held" };
      if (!row.lease_id) throw new Error("slot_lease_unavailable");
      const leaseId = String(row.lease_id);
      const fence = Number(row.fence);
      const lease = {
        async verify() {
          const { data: held, error: heldError } = await admin.rpc("plan_slot_lease_held", {
            p_owner_user_id: context.ownerId, p_plan_id: planId, p_slot_key: slot.slotKey, p_lease_id: leaseId, p_fence: fence,
          });
          if (heldError || held !== true) throw new Error("slot_lease_lost");
        },
        async release() {
          await admin.rpc("release_plan_slot_generation", {
            p_owner_user_id: context.ownerId, p_plan_id: planId, p_slot_key: slot.slotKey, p_lease_id: leaseId,
          });
        },
      };
      // A worker that finished this slot before our claim already persisted
      // it: reuse that draft instead of generating again.
      const existing = await readSlotItem(admin, context.ownerId, planId, slot.slotKey);
      if (existing) {
        await lease.release().catch(() => undefined);
        return { status: "exists", item: existing };
      }
      return { status: "claimed", lease };
    },

    async awaitSlotItem(planId, slot) {
      const wait = context.slotLeaseWait ?? SLOT_LEASE_WAIT;
      for (let waited = 0; waited <= wait.maxWaitMs; waited += wait.pollMs) {
        const item = await readSlotItem(admin, context.ownerId, planId, slot.slotKey);
        if (item) return item;
        await new Promise((resolve) => setTimeout(resolve, wait.pollMs));
      }
      return null;
    },

    async assertStillAuthorized() {
      // Scheduled runs act on the owner's standing authorization, so a pause,
      // downgrade or mode change mid-run stops them. An explicit Replenish is
      // the owner's own request; its paid media and approvals re-check at
      // their own boundaries.
      if (context.trigger !== "scheduled") return;
      await assertAutonomousWorkAllowed(admin, context.ownerId, context.mode);
    },
  };
}

async function readSlotItem(admin: AdminClient, ownerId: string, planId: string, slotKey: string): Promise<WorkflowItem | null> {
  const { data, error } = await admin.from("mara_drafts")
    .select("id,kind,social_channel,social_format,title,content,content_meta,proposed_publish_at,status,source_plan_item_key,content_version")
    .eq("owner_user_id", ownerId).eq("source_plan_id", planId).eq("source_plan_item_key", slotKey).maybeSingle();
  if (error) throw new Error("plan_items_read_failed");
  return data ? toWorkflowItem(data, { protected: data.status === "approved" }) : null;
}

/** Approves a workflow draft and advances it into Scheduled. */
export async function approveWorkflowItem(
  admin: AdminClient,
  ownerId: string,
  draftId: string,
  approvalOrigin: "user" | "autopilot" = "user",
  expectedContentVersion?: number,
) {
  // approvePostDraft -> syncPostToCalendar -> syncPostToPublishQueue reuses the
  // existing calendar mirror and the existing Instagram publishing queue. No
  // new scheduler exists.
  const view = await approvePostDraft(admin, ownerId, draftId, {
    approvalOrigin,
    ...(expectedContentVersion !== undefined ? { expectedContentVersion } : {}),
  });
  if (!view) throw new Error("draft_not_found");
  return view;
}

/** Re-syncs an item after an edit without changing its approval state. */
export async function resyncWorkflowItem(admin: AdminClient, ownerId: string, draftId: string) {
  return syncPostToCalendar(admin, ownerId, draftId);
}

async function ensureWorkflowConversation(admin: AdminClient, ownerId: string): Promise<string> {
  const { data: existing } = await admin.from("mara_conversations").select("id")
    .eq("owner_user_id", ownerId).eq("title", WORKFLOW_CONVERSATION_TITLE).limit(1).maybeSingle();
  if (existing?.id) return String(existing.id);
  const { data, error } = await admin.from("mara_conversations")
    .insert({ owner_user_id: ownerId, title: WORKFLOW_CONVERSATION_TITLE }).select("id").single();
  if (error || !data) throw new Error("workflow_conversation_failed");
  return String(data.id);
}

/**
 * Opens the approval card for an item, if one is not already open. Approvals
 * therefore only ever contains items that genuinely still need a decision.
 */
async function ensureApprovalAction(
  admin: AdminClient,
  input: { ownerId: string; conversationId: string; item: WorkflowItem; timeZone: string },
): Promise<void> {
  const { item } = input;
  await ensureWorkflowApprovalCard(admin, input.ownerId, {
    draftId: item.draftId,
    conversationId: input.conversationId,
    concept: item.concept,
    caption: item.caption,
    publishAt: item.publishAt,
    contentType: item.contentType as "post" | "reel" | "story",
    timeZone: input.timeZone,
    approved: item.status === "approved",
  });
}

/**
 * Opens the approval card for one workflow item, if one is not already open.
 * Shared by the rolling workflow and the in-place Marketing Plan actions, so
 * "open a card" has exactly one implementation and re-running anything never
 * creates a second card (stable per-draft idempotency key).
 */
export async function ensureWorkflowApprovalCard(
  admin: AdminClient,
  ownerId: string,
  input: {
    draftId: string;
    conversationId: string;
    concept: string;
    caption: string;
    publishAt: string;
    contentType: "post" | "reel" | "story";
    timeZone: string;
    approved?: boolean;
    productionStatus?: string;
    statusNote?: string;
  },
): Promise<void> {
  // The card shows the draft exactly as stored, read in ONE row read together
  // with its content version, so a confirmation can approve exactly what the
  // owner saw (lib/mara/draft-approval.ts) — never a later edit or media swap.
  const { data: source, error: sourceError } = await admin.from("mara_drafts")
    .select("title,content,proposed_publish_at,content_version")
    .eq("owner_user_id", ownerId).eq("id", input.draftId).maybeSingle();
  if (sourceError || !source) throw new Error("approval_source_unavailable");
  input = {
    ...input,
    concept: String(source.title ?? input.concept),
    caption: String(source.content ?? input.caption),
    publishAt: typeof source.proposed_publish_at === "string" ? source.proposed_publish_at : input.publishAt,
  };
  const contentVersion = Number(source.content_version);
  const { data: open } = await admin.from("mara_pending_actions").select("id,sanitized_arguments,new_value")
    .eq("owner_user_id", ownerId).eq("tool_name", "propose_calendar_item")
    .in("status", ["pending", "failed"]).contains("sanitized_arguments", { sourceDraftId: input.draftId })
    .limit(1).maybeSingle();
  if (open?.id) {
    // Refresh the EXISTING card from the draft source of truth. This makes a
    // retry idempotent and ensures a user never confirms an outdated caption,
    // title or schedule after editing the draft.
    const argumentsValue = (open.sanitized_arguments ?? {}) as Record<string, unknown>;
    const newValue = (open.new_value ?? {}) as Record<string, unknown>;
    const next = {
      ...argumentsValue,
      title: input.concept,
      content: input.caption,
      publishAt: input.publishAt,
      sourceDraftId: input.draftId,
      contentVersion,
    };
    const { error } = await admin.from("mara_pending_actions").update({
      sanitized_arguments: next,
      new_value: { ...newValue, ...next, ...(input.productionStatus ? { productionStatus: input.productionStatus } : {}) },
      status: "pending",
      error_summary: null,
      result_summary: input.statusNote ?? "Draft is ready for your review. Nothing has been scheduled or published.",
      executed_at: null,
    }).eq("id", String(open.id)).eq("owner_user_id", ownerId).in("status", ["pending", "failed"]);
    if (error) throw new Error("approval_refresh_failed");
    return;
  }
  if (input.approved) return;
  const item = {
    draftId: input.draftId,
    concept: input.concept,
    caption: input.caption,
    publishAt: input.publishAt,
    contentType: input.contentType,
  };

  const args = {
    title: item.concept,
    channel: item.contentType === "reel" ? "Reel" : item.contentType === "story" ? "Story" : "Instagram",
    content: item.caption,
    topic: item.concept,
    publishAt: item.publishAt,
    sourceDraftId: item.draftId,
    contentVersion,
    reason: "Part of your rolling Voom content plan.",
  };
  const { error } = await admin.from("mara_pending_actions").insert({
    owner_user_id: ownerId,
    conversation_id: input.conversationId,
    tool_name: "propose_calendar_item",
    sanitized_arguments: args,
    summary: `Approve “${item.concept}” for ${formatLocalTime(item.publishAt, input.timeZone)} on ${localDate(new Date(item.publishAt), input.timeZone)}.`,
    new_value: input.productionStatus ? { ...args, productionStatus: input.productionStatus } : args,
    // Stable per-draft key: re-running the plan never creates a second card.
    idempotency_key: `workflow-approval:${item.draftId}`,
  });
  // A concurrent coordinator/restart may win the same stable key after our
  // read. That is successful idempotent reuse; every other storage failure is
  // surfaced so the run cannot falsely claim an actionable approval exists.
  if (error && error.code !== "23505") throw new Error("approval_create_failed");
}

/** Autopilot parked this item until its generated media exists (rolling-plan holds it without a card). */
export const AUTOPILOT_AWAITING_MEDIA = "autopilot_awaiting_media";

/** True once the draft has its stored image/video. */
export async function draftHasVisual(admin: AdminClient, ownerId: string, draftId: string): Promise<boolean> {
  const { data, error } = await admin.from("post_draft_assets").select("id")
    .eq("owner_user_id", ownerId).eq("draft_id", draftId).eq("status", "uploaded").maybeSingle();
  if (error) throw new Error("workflow_media_read_failed");
  return Boolean(data);
}

/**
 * Durable marker that Autopilot is waiting for THIS draft's media before it
 * evaluates and approves the final content. Kept in content_meta, which is
 * not publishable content (0059 draft_publishable_meta), so writing it never
 * moves the content version.
 */
export async function markAutopilotAwaitingMedia(admin: AdminClient, ownerId: string, draftId: string): Promise<void> {
  const { data, error } = await admin.from("mara_drafts").select("content_meta")
    .eq("owner_user_id", ownerId).eq("id", draftId).maybeSingle();
  if (error || !data) throw new Error("workflow_media_mark_failed");
  const meta = data.content_meta && typeof data.content_meta === "object" ? data.content_meta as Record<string, unknown> : {};
  if (meta.autopilotAwaitingMedia) return;
  const { error: writeError } = await admin.from("mara_drafts")
    .update({ content_meta: { ...meta, autopilotAwaitingMedia: { since: new Date().toISOString() } } })
    .eq("owner_user_id", ownerId).eq("id", draftId);
  if (writeError) throw new Error("workflow_media_mark_failed");
}

/** Records the Autopilot auto-approval in the existing audit trail. */
export async function recordAutoApproval(
  admin: AdminClient,
  input: { ownerId: string; conversationId: string; item: WorkflowItem; checks: string[]; timeZone: string },
): Promise<void> {
  const summary = `Auto-approved by Autopilot after deterministic safety checks and scheduled for ${formatLocalTime(input.item.publishAt, input.timeZone)}.`;
  await admin.from("mara_tool_runs").insert({
    owner_user_id: input.ownerId,
    conversation_id: input.conversationId,
    tool_name: "propose_calendar_item",
    sanitized_arguments: {
      sourceDraftId: input.item.draftId,
      autopilotApproval: { automatic: true, mode: "autopilot", deterministicSafetyChecks: "passed", checks: input.checks },
    },
    status: "succeeded",
    idempotency_key: `workflow-autopilot:${input.item.draftId}`,
    result_summary: summary.slice(0, 1000),
    completed_at: new Date().toISOString(),
  });
  // Any approval card that was previously opened for this item is resolved, so
  // safely auto-approved content never sits in Approvals.
  await admin.from("mara_pending_actions")
    .update({ status: "confirmed", result_summary: summary.slice(0, 1000), executed_at: new Date().toISOString() })
    .eq("owner_user_id", input.ownerId).eq("tool_name", "propose_calendar_item")
    .in("status", ["pending", "failed"]).contains("sanitized_arguments", { sourceDraftId: input.item.draftId });
}

/**
 * MARA's content generation for ONE planned slot, isolated from the ports so
 * the planning payload — including the performance context — is directly
 * testable without a network call.
 */
export async function generateWorkflowPlannedContent(input: {
  ownerId?: string;
  businessId?: string;
  business: Record<string, unknown>;
  goal: string;
  cadence: Cadence;
  timeZone: string;
  slot: PlanSlot;
  plannedConcepts: string[];
  performance?: PerformancePlanContext | null;
  /** Verified trend evidence (flag-gated by the caller); null/absent = none. */
  trendOpportunity?: TrendPromptContext | null;
  /** Brand Kit extras (migration 0075); null/absent = prompts unchanged. */
  brandKit?: BrandKitPromptContext | null;
  /** Test seam only; production uses the configured AI provider. */
  provider?: AiProvider;
}): Promise<GeneratedContent> {
  const { slot, business } = input;
  if (!isPlanChannelFormat(slot.channel, slot.format)) throw new Error("content_generation_failed");
  const payload = buildPlannedContentPayload({
    business: {
      name: String(business.brand_name ?? "Your business"),
      description: String(business.brand_description ?? "").slice(0, 800),
      industry: String(business.industry ?? ""),
      targetCustomer: arrayText(business.target_customer),
      mainGoal: String(business.main_goal ?? ""),
      brandPersonality: arrayText(business.brand_personality),
    },
    goal: input.goal,
    cadenceLabel: CADENCE_LABELS[input.cadence],
    channel: slot.channel,
    format: slot.format,
    localDate: slot.date,
    localTime: formatLocalTime(slot.publishAt, input.timeZone),
    timezone: input.timeZone,
    recentConcepts: input.plannedConcepts,
    performance: input.performance ?? null,
    trendOpportunity: input.trendOpportunity ?? null,
    brandKit: input.brandKit ?? null,
  });
  try {
    const plan = await (input.provider ?? createAiProvider()).structured({
      messages: [
        { role: "system", content: plannedContentSystemPrompt({ trendEvidence: Boolean(input.trendOpportunity), brandKit: input.brandKit ?? null }) },
        { role: "user", content: JSON.stringify(payload) },
      ],
      temperature: 0.7,
      maxTokens: slot.channel === "youtube" && slot.format === "video" ? 2200 : 1500,
      ...(input.ownerId ? { usage: {
        ownerId: input.ownerId,
        businessId: input.businessId ?? null,
        // One key per generation call: a replacement for a rejected idea, a
        // re-run after a failed save or a trend fallback is a separate paid
        // call and must be recorded, not merged into the slot's first attempt.
        operationKey: `workflow-plan:${input.businessId ?? input.ownerId}:${slot.channel}:${slot.format}:${slot.publishAt}:${randomUUID()}`,
        operationType: "mara_workflow_plan",
        category: "recommendation" as const,
      } } : {}),
      jsonSchema: plannedContentJsonSchema,
      parse: (value) => plannedContentSchema.parse(value),
    });
    const script = plan.script.map((line) => line.trim()).filter(Boolean);
    if (slot.channel === "linkedin") {
      if (!plan.caption.trim() || slot.format !== "text" || script.length || plan.description.trim() || plan.visualBrief.trim() || plan.hook.trim()
        || plan.hashtags.length > 3 || composeLinkedInPlanText(plan).length > 3000) throw new Error("linkedin_text_invalid");
    } else if (!plan.visualBrief.trim()) throw new Error("visual_brief_required");
    if (slot.channel === "instagram" && plan.caption.length > 2200) throw new Error("caption_too_long");
    if (slot.channel !== "instagram" && slot.channel !== "linkedin") {
      const minimumBeats = slot.channel === "youtube" && slot.format === "video" ? 4 : 3;
      if (script.length < minimumBeats) throw new Error("native_video_outline_too_thin");
      if (slot.channel === "youtube" && plan.description.trim().length < 20) throw new Error("youtube_description_required");
      if (slot.channel === "youtube" && plan.concept.trim().length > 100) throw new Error("youtube_title_too_long");
      if (slot.channel === "tiktok" && composeSocialVideoCaption({ ...plan, script }).length > 2200) {
        throw new Error("tiktok_caption_too_long");
      }
    }
    if (input.trendOpportunity) {
      const generated = { ...plan, script };
      if (!checkTrendUsage(generated, input.trendOpportunity).grounded) throw new Error("trend_not_referenced");
      const claims = checkTrendGroundedContent(generated, input.trendOpportunity, {
        name: String(business.brand_name ?? "Your business"),
        description: String(business.brand_description ?? ""),
        industry: String(business.industry ?? ""),
        goal: input.goal,
        targetCustomer: Array.isArray(business.target_customer)
          ? business.target_customer.map(String)
          : business.target_customer ? [String(business.target_customer)] : [],
      });
      if (!claims.clean) throw new Error("trend_unsupported_claim");
    }
    return {
      concept: plan.concept,
      hook: plan.hook,
      caption: plan.caption,
      cta: plan.cta,
      hashtags: slot.channel === "instagram" && slot.format === "story" ? [] : plan.hashtags,
      description: plan.description,
      script,
      visualBrief: plan.visualBrief,
    };
  } catch (reason) {
    if (reason instanceof AiError && reason.code === "rate_limited") throw new Error("content_rate_limited");
    throw new Error("content_generation_failed");
  }
}

function toWorkflowItem(
  row: Record<string, unknown>,
  options: { protected?: boolean } = {},
): WorkflowItem | null {
  const kind = String(row.kind ?? "");
  const slotKey = String(row.source_plan_item_key ?? "");
  if (!slotKey) return null;
  const keyIdentity = parseWorkflowSlotIdentity(slotKey);
  const kindPair = pairForDraftKind(kind);
  const persistedPair = isPlanChannelFormat(row.social_channel, row.social_format)
    ? { channel: row.social_channel as PlanChannel, format: row.social_format as PlanFormat }
    : null;
  // A composite source key is the immutable assignment. Old date-only keys
  // continue to read the actual persisted pair (or the legacy Instagram kind).
  const pair = keyIdentity?.channel && keyIdentity.format
    ? { channel: keyIdentity.channel, format: keyIdentity.format }
    : persistedPair ?? kindPair;
  if (!pair || !isPlanChannelFormat(pair.channel, pair.format)) return null;
  const contentType: PlannedContentType = pair.channel === "instagram"
    ? pair.format as "post" | "reel" | "story"
    : pair.channel === "linkedin" ? "text" : pair.channel === "youtube" && pair.format === "short" ? "short" : "video";
  return {
    draftId: String(row.id),
    slotKey,
    channel: pair.channel,
    format: pair.format,
    contentType,
    concept: String(row.title ?? ""),
    caption: String(row.content ?? ""),
    publishAt: String(row.proposed_publish_at ?? ""),
    status: String(row.status ?? "draft"),
    protected: options.protected === true,
    ...(row.content_version !== undefined && row.content_version !== null ? { contentVersion: Number(row.content_version) } : {}),
  };
}

function pairForDraftKind(kind: string): { channel: PlanChannel; format: PlanFormat } | null {
  switch (kind) {
    case "instagram_post": return { channel: "instagram", format: "post" };
    case "reel": return { channel: "instagram", format: "reel" };
    case "story": return { channel: "instagram", format: "story" };
    case "tiktok_video": return { channel: "tiktok", format: "video" };
    case "youtube_short": return { channel: "youtube", format: "short" };
    case "youtube_video": return { channel: "youtube", format: "video" };
    case "linkedin_text": return { channel: "linkedin", format: "text" };
    default: return null;
  }
}

function socialDraftKind(channel: PlanChannel, format: PlanFormat): "tiktok_video" | "youtube_short" | "youtube_video" {
  if (channel === "tiktok" && format === "video") return "tiktok_video";
  if (channel === "youtube" && format === "short") return "youtube_short";
  if (channel === "youtube" && format === "video") return "youtube_video";
  throw new Error("social_channel_format_invalid");
}

function composeSocialVideoCaption(content: GeneratedContent): string {
  const hashtags = content.hashtags.map((tag) => `#${tag.replace(/^#+/, "")}`).join(" ");
  return [content.caption.trim(), content.cta.trim(), hashtags].filter(Boolean).join("\n\n").slice(0, 4000);
}

function arrayText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(", ") : String(value ?? "");
}

export type { RollingPlanResult, WorkflowStage };
export type WorkflowAdmin = SupabaseClient;
