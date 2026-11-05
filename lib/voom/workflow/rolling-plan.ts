/**
 * Deterministic channel-aware rolling social planner.
 *
 * One cadence slot is one item on one selected channel and one native format.
 * The server owns that assignment before content generation; Build, Replenish
 * and scheduled gap filling all use the same planner and stable slot identity.
 *
 * Planning never checks connection state. Connection readiness is an execution
 * concern, and email remains in Campaigns + Email Automation rather than this
 * social cadence.
 */

import {
  mayAutomaticallyGeneratePaidMedia,
  type AutomationModeValue,
  type WorkflowTrigger,
} from "../automation.ts";
import {
  DEFAULT_HORIZON_DAYS,
  resolveSlotMinutes,
  slotDates,
  type Cadence,
  type ContentType,
} from "../cadence.ts";
import { formatLocalTime, isoToLocalDate, localDate, localMinutes, localToUtcIso } from "../timezone.ts";
import type { PlanFormat, PlanChannel } from "./channels";
import {
  normalizeSelectedSocialChannels,
  parseWorkflowSlotIdentity,
  planChannelAssignments,
  type ChannelCoverage,
  type ExistingPlanAssignment,
  type PlannedContentType,
} from "./channel-planner.ts";

/**
 * Execution stages for the existing Instagram workflow.
 * TikTok/YouTube use social drafts and their own provider queues; they do not
 * enter Instagram media, approval, or queue actions from this engine.
 */
export const WORKFLOW_STAGES = ["full", "planning_only"] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export interface PlanSlot {
  /** Local YYYY-MM-DD cadence date. */
  date: string;
  /** Legacy date-only identities remain unchanged; all new slots use date|channel_format. */
  slotKey: string;
  index: number;
  channel: PlanChannel;
  format: PlanFormat;
  contentType: PlannedContentType;
  /** Absolute UTC instant for the recommended local publish time. */
  publishAt: string;
}

/**
 * Where a planned idea came from. Present only while trend context is enabled:
 * "reviewed_trend" (owner-reviewed context), "verified_trend" (automatically
 * matched governed evidence) or "evergreen" (no current signal was used).
 */
export type IdeaBasis =
  | { kind: "reviewed_trend" | "verified_trend"; topic: string; market: string; sources: string[]; observedAt: string }
  | { kind: "evergreen" };

export interface GeneratedContent {
  ideaBasis?: IdeaBasis;
  concept: string;
  hook: string;
  caption: string;
  cta: string;
  hashtags: string[];
  description: string;
  script: string[];
  visualBrief: string;
}

export interface WorkflowItem extends ExistingPlanAssignment {
  draftId: string;
  slotKey: string;
  channel: PlanChannel;
  format: PlanFormat;
  contentType: PlannedContentType;
  concept: string;
  caption: string;
  publishAt: string;
  status: string;
  protected?: boolean;
  /** Draft content version this item was read at (migration 0059); approvals are bound to it. */
  contentVersion?: number;
}

export interface RollingPlanPorts {
  /** Active plan id for this owner, creating one if none exists. */
  ensurePlan(input: {
    validFrom: string;
    validUntil: string;
    cadence: Cadence;
    goal: string;
    selectedChannels: PlanChannel[];
  }): Promise<string>;
  /** Existing workflow items for the plan, keyed by stable slot identity. */
  listItems(planId: string): Promise<WorkflowItem[]>;
  /** Existing active plan, used to reconcile a saved preference of no channels. */
  getActivePlan?(): Promise<string | null>;
  /** Detaches only safe, unexecuted drafts; it never changes or deletes content. */
  detachDrafts?(planId: string, draftIds: string[]): Promise<void>;
  /** MARA content generation for one server-assigned slot. */
  generateContent(slot: PlanSlot): Promise<GeneratedContent>;
  /** Persists one new draft for a stable slot identity. */
  createDraft(input: { planId: string; slot: PlanSlot; content: GeneratedContent }): Promise<WorkflowItem>;
  /** Existing Instagram media workflow; called for Instagram slots only. */
  ensureMedia(item: WorkflowItem): Promise<{ ok: boolean; code?: string }>;
  /** Opens (or reuses) the existing Instagram approval action. */
  requestApproval(item: WorkflowItem): Promise<void>;
  /** Existing deterministic Instagram safety evaluation, then approve + schedule. */
  autoApproveAndSchedule(item: WorkflowItem): Promise<{ approved: boolean; reason?: string }>;
  /** Mirrors the current horizon onto the marketing plan row. */
  savePlanItems(planId: string, items: WorkflowItem[]): Promise<void>;
  /**
   * Durable single-flight for one slot, taken BEFORE any paid generation:
   * "claimed" carries a lease the worker must still hold when it persists;
   * "exists" means another worker already persisted the slot; "held" means
   * another worker is generating it right now.
   */
  claimSlot?(planId: string, slot: PlanSlot): Promise<SlotClaim>;
  /** Waits briefly for the worker holding a slot to persist it; null if it did not. */
  awaitSlotItem?(planId: string, slot: PlanSlot): Promise<WorkflowItem | null>;
  /**
   * Re-checks that this run is still authorized (pause, mode, entitlement)
   * immediately before a generation and before a draft write. Throws to stop.
   */
  assertStillAuthorized?(): Promise<void>;
}

export interface SlotLease {
  /** Throws "slot_lease_lost" when the lease expired or was taken over (fencing). */
  verify(): Promise<void>;
  release(): Promise<void>;
}

export type SlotClaim =
  | { status: "claimed"; lease: SlotLease }
  | { status: "exists"; item: WorkflowItem }
  | { status: "held" };

/** Failure codes that mean the run itself is no longer authorized: stop all further work. */
const AUTHORIZATION_STOP_CODES = new Set([
  "automation_paused",
  "automation_mode_unconfirmed",
  "automation_mode_changed",
  "automation_subscription_restricted",
  "automation_state_unavailable",
]);

export interface RollingPlanInput {
  now: Date;
  timeZone: string;
  cadence: Cadence;
  mode: AutomationModeValue;
  goal: string;
  horizonDays?: number;
  /** Saved selected social channels. `[]` is an intentional no-selection state. */
  selectedChannels?: PlanChannel[];
  /** Existing plan assignments, used to preserve and balance prior work. */
  existingAssignments?: ExistingPlanAssignment[];
  /** Other channel commitments in the coordinator's authoritative horizon. */
  channelCoverage?: ChannelCoverage[];
  /** When supplied by the coordinator, only these actual gap dates are generated. */
  targetDates?: string[];
  /**
   * When supplied, NEW drafts are created only on these dates (the dates that
   * fit the cadence in every rolling 7-day window); existing items on other
   * plan dates are still reused. Omitted, every plan date may be created.
   */
  creatableDates?: string[];
  /**
   * Local date the cadence pattern is pinned to (see `slotDates`). Supplied by
   * the service from the active plan's start; omitted, the pattern starts today.
   */
  cadenceAnchorDate?: string;
  /** Defaults to "full". Unknown values fall back to "full". */
  stage?: WorkflowStage;
  /** Manual only plans on an explicit owner Replenish, and then planning-only. */
  trigger?: WorkflowTrigger;
}

/**
 * Resolves the effective stage for one (mode, trigger, requested stage). A
 * caller may narrow a run, never widen the central paid-media policy.
 */
export function resolveWorkflowStage(input: {
  mode: AutomationModeValue;
  trigger: WorkflowTrigger;
  stage?: WorkflowStage | string;
}): WorkflowStage {
  if (input.stage === "planning_only") return "planning_only";
  if (!mayAutomaticallyGeneratePaidMedia(input.mode, input.trigger)) return "planning_only";
  return "full";
}

export interface PlanSummaryItem {
  /** Local date portion of the slot identity; legacy date keys remain readable. */
  slot: string;
  slotKey: string;
  publishAt: string;
  localDate: string;
  localTime: string;
  channel: PlanChannel;
  format: PlanFormat;
  contentType: PlannedContentType;
  draftId: string;
  created: boolean;
}

export interface RollingPlanResult {
  planId: string | null;
  mode: AutomationModeValue;
  trigger: WorkflowTrigger;
  stage: WorkflowStage;
  blockedReason: "no_supported_social_channels_selected" | null;
  plan: {
    cadence: Cadence;
    timeZone: string;
    horizonDays: number;
    validFrom: string;
    validUntil: string;
    items: PlanSummaryItem[];
  } | null;
  /** Number of dates this run attempted (all cadence dates for Build/Replenish). */
  slots: number;
  created: number;
  reused: number;
  mediaQueued: number;
  awaitingApproval: number;
  autoApproved: number;
  heldForReview: number;
  failures: { slot: string; stage: string; code: string }[];
}

/** Computes canonical slots for the rolling horizon. No connection lookup occurs. */
export function buildSlots(input: RollingPlanInput): PlanSlot[] {
  const horizon = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const today = localDate(input.now, input.timeZone);
  const nowMinutes = localMinutes(input.now, input.timeZone);
  const dates = slotDates(today, input.cadence, horizon, input.cadenceAnchorDate);
  const selectedChannels = normalizeInputChannels(input.selectedChannels);
  if (!selectedChannels.length) return [];

  const assignment = planChannelAssignments({
    dates,
    today,
    selectedChannels,
    existing: input.existingAssignments,
    coverage: input.channelCoverage,
  });
  const dateIndex = new Map(dates.map((date, index) => [date, index]));
  const slots: PlanSlot[] = [];
  for (const planned of assignment.assignments) {
    const index = dateIndex.get(planned.date) ?? 0;
    // Native video formats retain their platform identity. Existing timing
    // bands are reused only as timing guidance, never as a format conversion.
    const timingType: ContentType = planned.channel === "instagram"
      ? planned.contentType as ContentType
      : planned.channel === "youtube" && planned.format === "video" ? "post" : "reel";
    const minutes = resolveSlotMinutes({
      contentType: timingType,
      index,
      isToday: planned.date === today,
      nowMinutes,
    });
    if (minutes === null) continue;
    slots.push({
      date: planned.date,
      slotKey: planned.slotKey,
      index,
      channel: planned.channel,
      format: planned.format,
      contentType: planned.contentType,
      publishAt: localToUtcIso(planned.date, minutes, input.timeZone),
    });
  }
  return slots.sort((a, b) => a.date.localeCompare(b.date));
}

export async function ensureRollingPlan(ports: RollingPlanPorts, input: RollingPlanInput): Promise<RollingPlanResult> {
  const trigger: WorkflowTrigger = input.trigger === "replenish" ? "replenish" : "scheduled";
  const stage = resolveWorkflowStage({ mode: input.mode, trigger, stage: input.stage });
  const horizonDays = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const result: RollingPlanResult = {
    planId: null,
    mode: input.mode,
    trigger,
    stage,
    blockedReason: null,
    plan: null,
    slots: 0,
    created: 0,
    reused: 0,
    mediaQueued: 0,
    awaitingApproval: 0,
    autoApproved: 0,
    heldForReview: 0,
    failures: [],
  };
  if (input.mode === "manual" && trigger !== "replenish") return result;

  const today = localDate(input.now, input.timeZone);
  const baseDates = slotDates(today, input.cadence, horizonDays, input.cadenceAnchorDate);
  const validFrom = baseDates[0] ?? today;
  const validUntil = baseDates.at(-1) ?? today;
  const selectedChannels = normalizeInputChannels(input.selectedChannels);

  // With no channels, don't invent Instagram work. Existing future unexecuted
  // drafts are safely detached from an active plan so the read model does not
  // keep presenting work on a channel the owner no longer selected.
  let planId: string | null;
  if (!selectedChannels.length) {
    planId = await ports.getActivePlan?.() ?? null;
    result.planId = planId;
    if (planId) {
      await ports.ensurePlan({ validFrom, validUntil, cadence: input.cadence, goal: input.goal, selectedChannels: [] });
      const existing = await ports.listItems(planId);
      const reconciliation = planChannelAssignments({
        dates: baseDates,
        today,
        selectedChannels,
        existing,
        coverage: input.channelCoverage,
      });
      let retainedItems = existing;
      if (reconciliation.detachDraftIds.length) {
        if (!ports.detachDrafts) throw new Error("plan_reconcile_unavailable");
        await ports.detachDrafts(planId, reconciliation.detachDraftIds);
        retainedItems = await ports.listItems(planId);
      }
      // Keep the stored read model aligned with the surviving protected work;
      // an empty selected-channel set must not leave stale plan cards behind.
      await ports.savePlanItems(planId, retainedItems);
    }
    result.blockedReason = "no_supported_social_channels_selected";
    return result;
  }

  planId = await ports.ensurePlan({
    validFrom,
    validUntil,
    cadence: input.cadence,
    goal: input.goal,
    selectedChannels,
  });
  result.planId = planId;

  const initialItems = await ports.listItems(planId);
  const reconciliation = planChannelAssignments({
    dates: baseDates,
    today,
    selectedChannels,
    existing: initialItems,
    coverage: input.channelCoverage,
  });
  if (reconciliation.detachDraftIds.length) {
    if (!ports.detachDrafts) throw new Error("plan_reconcile_unavailable");
    await ports.detachDrafts(planId, reconciliation.detachDraftIds);
  }

  // Re-read after safe detaches. A retry now sees either the original protected
  // row or the new assignment, never an old unselected draft reused cross-channel.
  const existingItems = reconciliation.detachDraftIds.length
    ? await ports.listItems(planId)
    : initialItems;
  const slots = buildSlots({
    ...input,
    selectedChannels,
    existingAssignments: existingItems,
    channelCoverage: input.channelCoverage,
  });
  const workDateSet = input.targetDates === undefined
    ? new Set(baseDates)
    : new Set(input.targetDates.filter((date) => baseDates.includes(date)));
  const creatable = input.creatableDates === undefined ? null : new Set(input.creatableDates);
  const workSlots = slots.filter((slot) => workDateSet.has(slot.date)
    && (!creatable || creatable.has(slot.date) || existingItems.some((item) => item.slotKey === slot.slotKey)));
  result.slots = workSlots.length;

  const existingByKey = new Map(existingItems.map((item) => [item.slotKey, item]));
  const itemsForPlan = new Map<string, WorkflowItem>();
  const summaryByKey = new Map<string, PlanSummaryItem>();
  for (const slot of slots) {
    const existingItem = existingByKey.get(slot.slotKey);
    if (existingItem) {
      itemsForPlan.set(existingItem.slotKey, existingItem);
      summaryByKey.set(existingItem.slotKey, summaryItem(existingItem, input.timeZone, false));
    }
  }

  let stopped: string | null = null;
  for (const slot of workSlots) {
    // A pause, downgrade or mode change during the run stops every remaining
    // slot: nothing further is generated or written, and each unfinished slot
    // is reported, so the run can never read as complete.
    if (stopped) {
      result.failures.push({ slot: slot.date, stage: "authorization", code: stopped });
      continue;
    }
    let item = existingByKey.get(slot.slotKey) ?? null;
    let created = false;
    if (item) {
      result.reused += 1;
    } else {
      let lease: SlotLease | null = null;
      try {
        if (ports.claimSlot) {
          const claim = await ports.claimSlot(planId, slot);
          if (claim.status === "exists") item = claim.item;
          else if (claim.status === "held") item = await ports.awaitSlotItem?.(planId, slot) ?? null;
          else lease = claim.lease;
          if (!item && !lease) throw new Error("slot_in_progress");
        }
        if (item) {
          result.reused += 1;
        } else {
          await ports.assertStillAuthorized?.();
          const content = await ports.generateContent(slot);
          // Fencing + authorization at the write boundary: a worker whose
          // lease was taken over, or a run paused mid-generation, writes nothing.
          await lease?.verify();
          await ports.assertStillAuthorized?.();
          item = await ports.createDraft({ planId, slot, content });
          result.created += 1;
          created = true;
        }
      } catch (reason) {
        const code = codeOf(reason);
        if (AUTHORIZATION_STOP_CODES.has(code)) {
          stopped = code;
          result.failures.push({ slot: slot.date, stage: "authorization", code });
        } else {
          result.failures.push({ slot: slot.date, stage: "content", code: codeOf(reason) });
        }
        continue;
      } finally {
        await lease?.release().catch(() => undefined);
      }
    }

    itemsForPlan.set(item.slotKey, item);
    summaryByKey.set(item.slotKey, summaryItem(item, input.timeZone, created));

    // TikTok/YouTube use Social Studio; LinkedIn text uses its existing review
    // workspace and explicit, account/version-bound approval. None enters
    // Instagram media generation or automatic approval from this workflow.
    if (slot.channel !== "instagram") continue;

    // Assisted deliberately remains planning-only for paid media, but its
    // normal scheduled/Replenish workflow must still hand the finished draft
    // to the existing human-approval queue. An explicitly requested
    // planning_only run remains a strict preview with no approval side effect.
    if (input.mode === "assisted" && input.stage !== "planning_only") {
      if (item.status === "draft") {
        try {
          await ports.requestApproval(item);
          result.awaitingApproval += 1;
        } catch (reason) {
          result.failures.push({ slot: slot.date, stage: "approval", code: codeOf(reason) });
        }
      }
      continue;
    }

    if (stage === "planning_only") continue;
    if (!mayAutomaticallyGeneratePaidMedia(input.mode, trigger)) continue;

    try {
      const media = await ports.ensureMedia(item);
      if (media.ok) result.mediaQueued += 1;
      else result.failures.push({ slot: slot.date, stage: "media", code: media.code ?? "media_failed" });
    } catch (reason) {
      result.failures.push({ slot: slot.date, stage: "media", code: codeOf(reason) });
    }

    // Approved work already belongs to its schedule (media above is
    // idempotent and only fills a missing visual). Automation never
    // re-approves or re-syncs it: a re-sync would re-arm a FAILED publish job
    // (upsert_instagram_publish_queue_item) and retry it without the owner.
    if (item.status === "approved") continue;

    if (input.mode === "autopilot") {
      try {
        const decision = await ports.autoApproveAndSchedule(item);
        if (decision.approved) {
          result.autoApproved += 1;
          continue;
        }
        // Media still generating: Autopilot evaluates and approves the final
        // post when the media arrives (no card, no loop). See media-arrival.ts.
        if (decision.reason === "autopilot_awaiting_media") continue;
        result.heldForReview += 1;
        await ports.requestApproval(item);
        result.awaitingApproval += 1;
        continue;
      } catch (reason) {
        result.failures.push({ slot: slot.date, stage: "approval", code: codeOf(reason) });
      }
    }

    try {
      await ports.requestApproval(item);
      result.awaitingApproval += 1;
    } catch (reason) {
      result.failures.push({ slot: slot.date, stage: "approval", code: codeOf(reason) });
    }
  }

  // Keep non-gap existing items in planned_posts when the coordinator fills a
  // subset of dates. This prevents a gap-only run from shrinking the plan
  // header or erasing its current read-model representation.
  const allItems = [...itemsForPlan.values()].sort((a, b) => a.slotKey.localeCompare(b.slotKey));
  const summary = [...summaryByKey.values()].sort((a, b) => a.slot.localeCompare(b.slot));
  await ports.savePlanItems(planId, allItems);
  result.plan = {
    cadence: input.cadence,
    timeZone: input.timeZone,
    horizonDays,
    validFrom,
    validUntil,
    items: summary,
  };
  return result;
}

function normalizeInputChannels(value: PlanChannel[] | undefined): PlanChannel[] {
  // Production runOwnerWorkflow supplies the saved selection explicitly,
  // including an empty list. Missing or invalid input is never an Instagram
  // fallback.
  return normalizeSelectedSocialChannels(value);
}

function summaryItem(item: WorkflowItem, timeZone: string, created: boolean): PlanSummaryItem {
  const identity = parseWorkflowSlotIdentity(item.slotKey);
  const date = identity?.date ?? item.slotKey;
  return {
    slot: date,
    slotKey: item.slotKey,
    publishAt: item.publishAt,
    localDate: isoToLocalDate(item.publishAt, timeZone),
    localTime: formatLocalTime(item.publishAt, timeZone),
    channel: item.channel,
    format: item.format,
    contentType: item.contentType,
    draftId: item.draftId,
    created,
  };
}

function codeOf(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message.slice(0, 80) : "unknown_error";
}
