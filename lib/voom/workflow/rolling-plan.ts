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
import { addDays, formatLocalTime, isoToLocalDate, localDate, localMinutes, localToUtcIso } from "../timezone.ts";
import type { SocialFormat, SocialMediaChannel } from "@/lib/social/channels";
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
  channel: SocialMediaChannel;
  format: SocialFormat;
  contentType: PlannedContentType;
  /** Absolute UTC instant for the recommended local publish time. */
  publishAt: string;
}

export interface GeneratedContent {
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
  channel: SocialMediaChannel;
  format: SocialFormat;
  contentType: PlannedContentType;
  concept: string;
  caption: string;
  publishAt: string;
  status: string;
  protected?: boolean;
}

export interface RollingPlanPorts {
  /** Active plan id for this owner, creating one if none exists. */
  ensurePlan(input: {
    validFrom: string;
    validUntil: string;
    cadence: Cadence;
    goal: string;
    selectedChannels: SocialMediaChannel[];
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
}

export interface RollingPlanInput {
  now: Date;
  timeZone: string;
  cadence: Cadence;
  mode: AutomationModeValue;
  goal: string;
  horizonDays?: number;
  /** Saved selected social channels. `[]` is an intentional no-selection state. */
  selectedChannels?: SocialMediaChannel[];
  /** Existing plan assignments, used to preserve and balance prior work. */
  existingAssignments?: ExistingPlanAssignment[];
  /** Other channel commitments in the coordinator's authoritative horizon. */
  channelCoverage?: ChannelCoverage[];
  /** When supplied by the coordinator, only these actual gap dates are generated. */
  targetDates?: string[];
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
  channel: SocialMediaChannel;
  format: SocialFormat;
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

/** The only inputs slot planning reads; mode, goal, stage and trigger never move a slot. */
export type SlotPlanningInput = Pick<
  RollingPlanInput,
  "now" | "timeZone" | "cadence" | "horizonDays" | "selectedChannels" | "existingAssignments" | "channelCoverage"
>;

/** Computes canonical slots for the rolling horizon. No connection lookup occurs. */
export function buildSlots(input: SlotPlanningInput): PlanSlot[] {
  const horizon = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const today = localDate(input.now, input.timeZone);
  const nowMinutes = localMinutes(input.now, input.timeZone);
  const dates = slotDates(today, input.cadence, horizon);
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

/**
 * How completely the plan covers the LIVE rolling horizon right now.
 *
 * `complete` means a Replenish at this moment would create nothing: every
 * cadence slot in [today, today + horizonDays) that still has a valid publish
 * time already has an eligible plan item. `incomplete` lists the open slots.
 * `no_channels` means nothing can be planned until a social channel is chosen.
 */
export interface PlanCoverage {
  status: "complete" | "incomplete" | "no_channels";
  /** First and last local date of the live rolling horizon. */
  horizonStart: string;
  horizonEnd: string;
  horizonDays: number;
  /** Cadence slots in the horizon that still have a valid publish time. */
  slots: number;
  /** Slots with no eligible plan item — exactly what Replenish would create. */
  uncovered: number;
  uncoveredDates: string[];
}

/**
 * Evaluates coverage with the SAME slot planning `ensureRollingPlan` runs,
 * without calling any port: `buildSlots` assigns the horizon over the plan's
 * existing items, and a slot counts as covered only when an existing item
 * already holds its stable slot identity — exactly the engine's reuse test.
 * Items the run would detach (unexecuted work on a channel that is no longer
 * selected, unprotected same-date duplicates) never win a slot in that
 * assignment, so they never mark a slot covered; protected work always does.
 * Pure, so it is recomputed on every read and moves with the rolling window.
 */
export function evaluatePlanCoverage(input: SlotPlanningInput & { existing: ExistingPlanAssignment[] }): PlanCoverage {
  const horizonDays = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const today = localDate(input.now, input.timeZone);
  const window = { horizonStart: today, horizonEnd: addDays(today, horizonDays - 1), horizonDays };
  const selectedChannels = normalizeInputChannels(input.selectedChannels);
  if (!selectedChannels.length) {
    return { status: "no_channels", ...window, slots: 0, uncovered: 0, uncoveredDates: [] };
  }
  const slots = buildSlots({ ...input, selectedChannels, existingAssignments: input.existing });
  const heldKeys = new Set(input.existing.map((item) => item.slotKey));
  const open = slots.filter((slot) => !heldKeys.has(slot.slotKey));
  return {
    status: open.length ? "incomplete" : "complete",
    ...window,
    slots: slots.length,
    uncovered: open.length,
    uncoveredDates: open.map((slot) => slot.date),
  };
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
  const baseDates = slotDates(today, input.cadence, horizonDays);
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
  const workSlots = slots.filter((slot) => workDateSet.has(slot.date));
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

  for (const slot of workSlots) {
    let item = existingByKey.get(slot.slotKey) ?? null;
    let created = false;
    if (item) {
      result.reused += 1;
    } else {
      try {
        const content = await ports.generateContent(slot);
        item = await ports.createDraft({ planId, slot, content });
        result.created += 1;
        created = true;
      } catch (reason) {
        result.failures.push({ slot: slot.date, stage: "content", code: codeOf(reason) });
        continue;
      }
    }

    itemsForPlan.set(item.slotKey, item);
    summaryByKey.set(item.slotKey, summaryItem(item, input.timeZone, created));

    // TikTok and YouTube drafts use Social Studio, private video assets and
    // their own durable provider queues. They never enter Instagram media or
    // approval actions from this workflow (and no platform is auto-published).
    if (slot.channel !== "instagram") continue;

    if (stage === "planning_only") continue;
    if (!mayAutomaticallyGeneratePaidMedia(input.mode, trigger)) continue;

    try {
      const media = await ports.ensureMedia(item);
      if (media.ok) result.mediaQueued += 1;
      else result.failures.push({ slot: slot.date, stage: "media", code: media.code ?? "media_failed" });
    } catch (reason) {
      result.failures.push({ slot: slot.date, stage: "media", code: codeOf(reason) });
    }

    if (input.mode === "autopilot") {
      try {
        const decision = await ports.autoApproveAndSchedule(item);
        if (decision.approved) {
          result.autoApproved += 1;
          continue;
        }
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

function normalizeInputChannels(value: SocialMediaChannel[] | undefined): SocialMediaChannel[] {
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
