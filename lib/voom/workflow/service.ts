import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { AiError, createAiProvider, type AiProvider } from "@/lib/ai";
import { evaluateAutopilotRecommendation } from "@/lib/mara/autopilot-safety";
import { composePostCaption } from "@/lib/post/core";
import { approvePostDraft, syncPostToCalendar, type AdminClient } from "@/lib/post/server-data";
import { loadPerformancePlanContext } from "@/lib/performance/data";
import type { PerformancePlanContext } from "@/lib/performance/plan-context";
import { mayAutomaticallyGeneratePaidMedia, normalizeAutomationMode, type AutomationModeValue, type WorkflowTrigger } from "@/lib/voom/automation";
import { canUseAutomationMode, normalizePlan } from "@/lib/billing/plans";
import { CADENCE_LABELS, normalizeCadence, type Cadence, type ContentType } from "@/lib/voom/cadence";
import { accountTimezone, formatLocalTime, localDate } from "@/lib/voom/timezone";
import { ensureWorkflowMedia, type WorkflowMediaDeps } from "./media";
import { buildPlannedContentPayload, plannedContentJsonSchema, plannedContentSchema, PLANNED_CONTENT_SYSTEM_PROMPT } from "./prompt";
import {
  ensureRollingPlan,
  type GeneratedContent,
  type PlanSlot,
  type RollingPlanPorts,
  type RollingPlanResult,
  type WorkflowItem,
  type WorkflowStage,
} from "./rolling-plan";
import { calendarChannelForContentType, draftKindForContentType } from "./state";
import { createSocialDraft } from "@/lib/social/server-drafts";
import {
  SOCIAL_CHANNEL_LABELS,
  actionChannelFor,
  isValidChannelFormat,
  type SocialFormat,
  type SocialMediaChannel,
} from "@/lib/social/channels";
import {
  normalizeSelectedSocialChannels,
  parseWorkflowSlotIdentity,
  type ChannelCoverage,
  type ExistingPlanAssignment,
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
    .select("id,brand_name,brand_description,industry,target_customer,main_goal,brand_personality,preferred_channels,content_frequency,automation_level,timezone,plan")
    .eq("owner_user_id", input.ownerId).maybeSingle();
  if (!business) throw new Error("business_not_found");

  const timeZone = accountTimezone((business as { timezone?: string | null }).timezone);
  const cadence = input.cadence ?? normalizeCadence(business.content_frequency);
  
  const planId = normalizePlan((business as any).plan);
  let mode = normalizeAutomationMode(business.automation_level);
  if (!canUseAutomationMode(planId, mode)) {
    mode = planId === "pro" ? "assisted" : "manual";
  }
  const trigger: WorkflowTrigger = input.trigger === "replenish" ? "replenish" : "scheduled";
  const goal = String(business.main_goal ?? "Grow awareness");
  const selectedChannels = normalizeSelectedSocialChannels(business.preferred_channels);

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
    targetDates: input.targetDates,
    channelCoverage: input.channelCoverage,
    mediaDeps: input.mediaDeps,
    planningDeps: input.planningDeps,
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
  selectedChannels?: SocialMediaChannel[];
  /** Coordinator gap dates and the actual existing channel commitments. */
  targetDates?: string[];
  channelCoverage?: ChannelCoverage[];
  /** Test seam only; production uses the module defaults. */
  mediaDeps?: Partial<WorkflowMediaDeps>;
  /** Test seam only; production uses the real provider and stored snapshots. */
  planningDeps?: WorkflowPlanningDeps;
}

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

  return {
    async getActivePlan() {
      const { data, error } = await admin.from("marketing_plans").select("id")
        .eq("owner_user_id", context.ownerId).eq("status", "active")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error("plan_read_failed");
      return data?.id ? String(data.id) : null;
    },

    async ensurePlan({ validFrom, validUntil, cadence, goal, selectedChannels }) {
      const channelLabels = selectedChannels.map((channel) => SOCIAL_CHANNEL_LABELS[channel]);
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
      if (error || !created) throw new Error("plan_store_failed");
      return String(created.id);
    },

    async listItems(planId) {
      const { data, error } = await admin.from("mara_drafts")
        .select("id,kind,social_channel,social_format,title,content,content_meta,proposed_publish_at,status,source_plan_item_key")
        .eq("owner_user_id", context.ownerId).eq("source_plan_id", planId);
      if (error) throw new Error("plan_items_read_failed");
      const rows = (data ?? []) as Record<string, unknown>[];
      if (!rows.length) return [];
      const ids = rows.map((row) => String(row.id));
      const [approvalRows, instagramQueues, tiktokQueues, youtubeQueues] = await Promise.all([
        admin.from("mara_pending_actions").select("sanitized_arguments,new_value,status")
          .eq("owner_user_id", context.ownerId).eq("tool_name", "propose_calendar_item").in("status", ["pending", "failed"]),
        admin.from("instagram_publish_queue").select("draft_id,status").eq("owner_user_id", context.ownerId).in("draft_id", ids),
        admin.from("tiktok_publish_queue").select("draft_id,status").eq("owner_user_id", context.ownerId).in("draft_id", ids),
        admin.from("youtube_publish_queue").select("draft_id,status").eq("owner_user_id", context.ownerId).in("draft_id", ids),
      ]);
      if (approvalRows.error || instagramQueues.error || tiktokQueues.error || youtubeQueues.error) {
        throw new Error("plan_reconcile_state_read_failed");
      }
      const approvalIds = new Set<string>();
      for (const row of approvalRows.data ?? []) {
        const value = (row.new_value ?? row.sanitized_arguments ?? null) as Record<string, unknown> | null;
        if (typeof value?.sourceDraftId === "string") approvalIds.add(value.sourceDraftId);
      }
      const queuedIds = new Set<string>();
      for (const queue of [instagramQueues, tiktokQueues, youtubeQueues]) {
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
        .eq("owner_user_id", context.ownerId).eq("source_plan_id", planId).eq("status", "draft").in("id", draftIds);
      if (error) throw new Error("plan_reconcile_failed");
    },

    async generateContent(slot) {
      return generateWorkflowPlannedContent({
        business: context.business,
        goal: context.goal,
        cadence: context.cadence,
        timeZone: context.timeZone,
        slot,
        plannedConcepts,
        performance: slot.channel === "instagram" ? await performanceContextForPlanning() : null,
        ...(context.planningDeps?.provider ? { provider: context.planningDeps.provider } : {}),
      });
    },

    async createDraft({ planId, slot, content }) {
      if (slot.channel !== "instagram") {
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

      const caption = composePostCaption({ caption: content.caption, cta: content.cta, hashtags: content.hashtags });
      const row = {
        owner_user_id: context.ownerId,
        conversation_id: conversationId,
        source_plan_id: planId,
        source_plan_item_key: slot.slotKey,
        kind: draftKindForContentType(slot.contentType as ContentType),
        channel: calendarChannelForContentType(slot.contentType as ContentType),
        title: content.concept.slice(0, 160),
        content: (caption || content.concept).slice(0, 12000),
        proposed_publish_at: slot.publishAt,
        status: "draft",
        media_brief: content.visualBrief.slice(0, 800),
        social_channel: slot.channel,
        social_format: slot.format,
        content_meta: {
          concept: content.concept,
          hook: content.hook,
          cta: content.cta,
          hashtags: content.hashtags,
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
      await ensureApprovalAction(admin, {
        ownerId: context.ownerId, conversationId, item, timeZone: context.timeZone,
      });
    },

    async autoApproveAndSchedule(item) {
      if (item.channel !== "instagram" || context.mode !== "autopilot") {
        return { approved: false, reason: AUTOMATIC_MEDIA_FORBIDDEN };
      }
      const safety = evaluateAutopilotRecommendation({
        title: item.concept, content: item.caption, publishAt: item.publishAt,
      }, context.now);
      if (!safety.safe) return { approved: false, reason: safety.blockers.join(",") };
      await approveWorkflowItem(admin, context.ownerId, item.draftId);
      await recordAutoApproval(admin, {
        ownerId: context.ownerId, conversationId, item, checks: safety.checks, timeZone: context.timeZone,
      });
      return { approved: true };
    },

    async savePlanItems(planId, items) {
      const plannedPosts = items.map((item) => {
        const identity = parseWorkflowSlotIdentity(item.slotKey);
        const actionChannel = actionChannelFor(item.channel, item.format);
        return {
          draftId: item.draftId,
          slotDate: identity?.date ?? item.slotKey,
          slotKey: item.slotKey,
          channelFormat: actionChannel,
          channel: SOCIAL_CHANNEL_LABELS[item.channel],
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
  };
}

/** Approves a workflow draft and advances it into Scheduled. */
export async function approveWorkflowItem(admin: AdminClient, ownerId: string, draftId: string) {
  // approvePostDraft -> syncPostToCalendar -> syncPostToPublishQueue reuses the
  // existing calendar mirror and the existing Instagram publishing queue. No
  // new scheduler exists.
  const view = await approvePostDraft(admin, ownerId, draftId);
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
  const { data: open } = await admin.from("mara_pending_actions").select("id,new_value")
    .eq("owner_user_id", ownerId).eq("tool_name", "propose_calendar_item")
    .in("status", ["pending", "failed"]).contains("sanitized_arguments", { sourceDraftId: input.draftId })
    .limit(1).maybeSingle();
  if (open?.id) {
    // Record a production choice on the EXISTING card instead of a new one.
    if (input.productionStatus) {
      const value = (open.new_value ?? {}) as Record<string, unknown>;
      await admin.from("mara_pending_actions").update({
        new_value: { ...value, productionStatus: input.productionStatus },
        result_summary: input.statusNote ?? "Production choice recorded.",
      }).eq("id", String(open.id)).eq("owner_user_id", ownerId);
    }
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
    reason: "Part of your rolling Voom content plan.",
  };
  await admin.from("mara_pending_actions").insert({
    owner_user_id: ownerId,
    conversation_id: input.conversationId,
    tool_name: "propose_calendar_item",
    sanitized_arguments: args,
    summary: `Approve “${item.concept}” for ${formatLocalTime(item.publishAt, input.timeZone)} on ${localDate(new Date(item.publishAt), input.timeZone)}.`,
    new_value: input.productionStatus ? { ...args, productionStatus: input.productionStatus } : args,
    // Stable per-draft key: re-running the plan never creates a second card.
    idempotency_key: `workflow-approval:${item.draftId}`,
  });
}

/** Records the Autopilot auto-approval in the existing audit trail. */
async function recordAutoApproval(
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
  business: Record<string, unknown>;
  goal: string;
  cadence: Cadence;
  timeZone: string;
  slot: PlanSlot;
  plannedConcepts: string[];
  performance?: PerformancePlanContext | null;
  /** Test seam only; production uses the configured AI provider. */
  provider?: AiProvider;
}): Promise<GeneratedContent> {
  const { slot, business } = input;
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
  });
  try {
    const plan = await (input.provider ?? createAiProvider()).structured({
      messages: [
        { role: "system", content: PLANNED_CONTENT_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(payload) },
      ],
      temperature: 0.7,
      maxTokens: slot.channel === "youtube" && slot.format === "video" ? 2200 : 1500,
      jsonSchema: plannedContentJsonSchema,
      parse: (value) => plannedContentSchema.parse(value),
    });
    const script = plan.script.map((line) => line.trim()).filter(Boolean);
    if (slot.channel === "instagram" && plan.caption.length > 2200) throw new Error("caption_too_long");
    if (slot.channel !== "instagram") {
      const minimumBeats = slot.channel === "youtube" && slot.format === "video" ? 4 : 3;
      if (script.length < minimumBeats) throw new Error("native_video_outline_too_thin");
      if (slot.channel === "youtube" && plan.description.trim().length < 20) throw new Error("youtube_description_required");
      if (slot.channel === "youtube" && plan.concept.trim().length > 100) throw new Error("youtube_title_too_long");
      if (slot.channel === "tiktok" && composeSocialVideoCaption({ ...plan, script }).length > 2200) {
        throw new Error("tiktok_caption_too_long");
      }
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
  const persistedPair = isValidChannelFormat(row.social_channel, row.social_format)
    ? { channel: row.social_channel as SocialMediaChannel, format: row.social_format as SocialFormat }
    : null;
  // A composite source key is the immutable assignment. Old date-only keys
  // continue to read the actual persisted pair (or the legacy Instagram kind).
  const pair = keyIdentity?.channel && keyIdentity.format
    ? { channel: keyIdentity.channel, format: keyIdentity.format }
    : persistedPair ?? kindPair;
  if (!pair || !isValidChannelFormat(pair.channel, pair.format)) return null;
  const contentType: PlannedContentType = pair.channel === "instagram"
    ? pair.format as "post" | "reel" | "story"
    : pair.channel === "youtube" && pair.format === "short" ? "short" : "video";
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
  };
}

function pairForDraftKind(kind: string): { channel: SocialMediaChannel; format: SocialFormat } | null {
  switch (kind) {
    case "instagram_post": return { channel: "instagram", format: "post" };
    case "reel": return { channel: "instagram", format: "reel" };
    case "story": return { channel: "instagram", format: "story" };
    case "tiktok_video": return { channel: "tiktok", format: "video" };
    case "youtube_short": return { channel: "youtube", format: "short" };
    case "youtube_video": return { channel: "youtube", format: "video" };
    default: return null;
  }
}

function socialDraftKind(channel: SocialMediaChannel, format: SocialFormat): "tiktok_video" | "youtube_short" | "youtube_video" {
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
