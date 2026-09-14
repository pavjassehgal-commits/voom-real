/**
 * The cadence-aware rolling plan engine.
 *
 * This replaces the legacy "generate exactly 3 Instagram recommendations once
 * per week" rule. It maintains a rolling horizon (7 days by default) of
 * executable content items starting on the account's real current local date,
 * with as many items as the user's selected posting cadence requires.
 *
 * Guarantees:
 *   - one workflow item per (plan, local slot date); an existing item for a
 *     date is always reused, never duplicated, however often the cron runs,
 *   - the horizon is replenished forward only; past dates are never planned,
 *   - Manual creates nothing on a scheduled run; on an explicit Replenish it
 *     plans (drafts + MARA copy) but NEVER generates paid media, approves or
 *     schedules — Manual stays Manual throughout the run. Assisted stops at
 *     Needs approval, Autopilot runs the existing deterministic safety
 *     evaluator and only then auto-approves and schedules,
 *   - every stage failure is recorded on the item instead of aborting the run.
 *
 * It performs no I/O: everything is expressed against injected ports, so the
 * end-to-end acceptance test drives the real logic with mocked providers.
 */

import {
  mayAutomaticallyGeneratePaidMedia,
  type AutomationModeValue,
  type WorkflowTrigger,
} from "../automation.ts";
import {
  DEFAULT_HORIZON_DAYS,
  planContentTypes,
  resolveSlotMinutes,
  slotDates,
  type Cadence,
  type ContentType,
} from "../cadence.ts";
import { formatLocalTime, isoToLocalDate, localDate, localMinutes, localToUtcIso } from "../timezone.ts";

/**
 * Execution stages for the rolling workflow.
 *
 *   - "full"          -> plan/reuse slots, MARA copy, paid media generation,
 *                        approval, scheduling and the Instagram queue.
 *   - "planning_only" -> plan/reuse slots + MARA copy only. Stops before the
 *                        existing `ensureMedia` and `autoApproveAndSchedule`
 *                        stages, so it can never spend on media, approve,
 *                        schedule, queue or publish anything.
 */
export const WORKFLOW_STAGES = ["full", "planning_only"] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export interface PlanSlot {
  /** Local YYYY-MM-DD. Doubles as the durable per-plan slot key. */
  date: string;
  index: number;
  contentType: ContentType;
  /** Absolute UTC instant for the recommended local publish time. */
  publishAt: string;
}

export interface GeneratedContent {
  concept: string;
  caption: string;
  cta: string;
  hashtags: string[];
  visualBrief: string;
}

export interface WorkflowItem {
  draftId: string;
  slotKey: string;
  contentType: ContentType;
  concept: string;
  caption: string;
  publishAt: string;
  status: string;
}

export interface RollingPlanPorts {
  /** Active plan id for this owner, creating one if none exists. */
  ensurePlan(input: { validFrom: string; validUntil: string; cadence: Cadence; goal: string }): Promise<string>;
  /** Existing workflow items for the plan, keyed by slot date. */
  listItems(planId: string): Promise<WorkflowItem[]>;
  /** MARA content generation for one slot. */
  generateContent(slot: PlanSlot): Promise<GeneratedContent>;
  /** Persists a new draft for a slot. Must be idempotent on (plan, slotKey). */
  createDraft(input: { planId: string; slot: PlanSlot; content: GeneratedContent }): Promise<WorkflowItem>;
  /** Creates the media-generation job for an item if one is not already live. */
  ensureMedia(item: WorkflowItem): Promise<{ ok: boolean; code?: string }>;
  /** Opens (or reuses) the approval action for an item. */
  requestApproval(item: WorkflowItem): Promise<void>;
  /** Deterministic safety evaluation, then approve + schedule. Autopilot only. */
  autoApproveAndSchedule(item: WorkflowItem): Promise<{ approved: boolean; reason?: string }>;
  /** Mirrors the resolved horizon onto the marketing plan row. */
  savePlanItems(planId: string, items: WorkflowItem[]): Promise<void>;
}

export interface RollingPlanInput {
  now: Date;
  timeZone: string;
  cadence: Cadence;
  mode: AutomationModeValue;
  goal: string;
  horizonDays?: number;
  /** Defaults to "full". Unknown values fall back to "full". */
  stage?: WorkflowStage;
  /**
   * What started this run. Defaults to "scheduled" (the cron worker), where a
   * Manual account creates nothing at all. "replenish" is the owner's explicit
   * Build/Replenish plan click: Manual then plans, but planning-only.
   */
  trigger?: WorkflowTrigger;
}

/**
 * Resolves the effective stage for one (mode, trigger, requested stage).
 *
 * The requested stage can only ever NARROW a run (an explicit "planning_only"
 * always wins). On top of that, the central paid-media policy decides whether
 * the run may reach `ensureMedia` at all: when `mayAutomaticallyGeneratePaidMedia`
 * says no, the run is forced to "planning_only" regardless of what was asked
 * for. This is the engine-level half of the cost-safety invariant — the
 * service ports hold the other half — so no caller can "opt in" a Manual
 * Replenish to paid media by passing a different stage.
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

/** One resolved horizon slot, for the run summary. */
export interface PlanSummaryItem {
  /** Local slot date (YYYY-MM-DD); the durable per-plan slot key. */
  slot: string;
  /** Absolute UTC publish instant for the slot. */
  publishAt: string;
  /** Local date/time of `publishAt` in the account timezone. */
  localDate: string;
  localTime: string;
  contentType: ContentType;
  draftId: string;
  /** False when an existing slot item was reused instead of created. */
  created: boolean;
}

export interface RollingPlanResult {
  planId: string | null;
  /** The mode the run actually executed under — always the account's own mode. */
  mode: AutomationModeValue;
  trigger: WorkflowTrigger;
  stage: WorkflowStage;
  /** Resolved horizon summary. Null when nothing was planned (manual/empty). */
  plan: {
    cadence: Cadence;
    timeZone: string;
    horizonDays: number;
    validFrom: string;
    validUntil: string;
    items: PlanSummaryItem[];
  } | null;
  slots: number;
  created: number;
  reused: number;
  mediaQueued: number;
  awaitingApproval: number;
  autoApproved: number;
  heldForReview: number;
  failures: { slot: string; stage: string; code: string }[];
}

/** Computes the deterministic slots for the horizon, starting today. */
export function buildSlots(input: RollingPlanInput): PlanSlot[] {
  const horizon = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const today = localDate(input.now, input.timeZone);
  const nowMinutes = localMinutes(input.now, input.timeZone);
  const dates = slotDates(today, input.cadence, horizon);
  // Content types are balanced across the WHOLE horizon by cadence + goal
  // (posts/reels/stories), never by a per-slot modulo that can collapse into
  // one repeated format. The same horizon always resolves to the same types.
  const types = planContentTypes({ cadence: input.cadence, count: dates.length, goal: input.goal });
  const slots: PlanSlot[] = [];
  for (const [index, date] of dates.entries()) {
    const contentType = types[index] ?? "post";
    const minutes = resolveSlotMinutes({ contentType, index, isToday: date === today, nowMinutes });
    // A slot whose local day has no usable time left is skipped rather than
    // scheduled in the past — stale dates can never enter the workflow.
    if (minutes === null) continue;
    slots.push({ date, index, contentType, publishAt: localToUtcIso(date, minutes, input.timeZone) });
  }
  return slots;
}

export async function ensureRollingPlan(ports: RollingPlanPorts, input: RollingPlanInput): Promise<RollingPlanResult> {
  const trigger: WorkflowTrigger = input.trigger === "replenish" ? "replenish" : "scheduled";
  // The requested stage can only narrow the run (an explicit "planning_only"
  // wins; anything else — including an unknown value — asks for "full"). The
  // central paid-media policy then decides whether "full" is even permitted
  // for this (mode, trigger): Manual + Replenish is forced to planning-only.
  const stage = resolveWorkflowStage({ mode: input.mode, trigger, stage: input.stage });
  const horizonDays = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const result: RollingPlanResult = {
    planId: null, mode: input.mode, trigger, stage, plan: null, slots: 0, created: 0, reused: 0, mediaQueued: 0,
    awaitingApproval: 0, autoApproved: 0, heldForReview: 0, failures: [],
  };
  // Manual never plans on a scheduled run: nothing runs for it on a timer.
  // Only the owner's explicit Replenish click plans a Manual account — and
  // then planning-only (see resolveWorkflowStage), never as Assisted.
  if (input.mode === "manual" && trigger !== "replenish") return result;

  const slots = buildSlots(input);
  result.slots = slots.length;
  if (!slots.length) return result;

  const planId = await ports.ensurePlan({
    validFrom: slots[0].date,
    validUntil: slots[slots.length - 1].date,
    cadence: input.cadence,
    goal: input.goal,
  });
  result.planId = planId;

  const existing = new Map((await ports.listItems(planId)).map((item) => [item.slotKey, item]));
  const items: WorkflowItem[] = [];
  const summary: PlanSummaryItem[] = [];

  for (const slot of slots) {
    let item = existing.get(slot.date) ?? null;
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
    items.push(item);
    summary.push({
      slot: slot.date,
      publishAt: item.publishAt,
      localDate: isoToLocalDate(item.publishAt, input.timeZone),
      localTime: formatLocalTime(item.publishAt, input.timeZone),
      contentType: item.contentType,
      draftId: item.draftId,
      created,
    });

    // Planning-only stops here: before `ensureMedia`, before any approval, and
    // therefore before any scheduling, calendar mirroring or queueing. The
    // ports below are never invoked, so no provider, job or publish side
    // effect is even reachable.
    if (stage === "planning_only") continue;
    // Belt and braces: the stage above is derived from this same policy, so
    // this branch is unreachable for Manual — but the paid path is guarded by
    // the policy itself, not by trusting the derivation.
    if (!mayAutomaticallyGeneratePaidMedia(input.mode, trigger)) continue;

    // Media. A failure here must not kill the workflow: the item stays visible
    // with a failed media stage and can be retried without paying twice.
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
        // Risky content is never silently dropped: it stays in Approvals.
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

  await ports.savePlanItems(planId, items);
  result.plan = {
    cadence: input.cadence,
    timeZone: input.timeZone,
    horizonDays,
    validFrom: slots[0].date,
    validUntil: slots[slots.length - 1].date,
    items: summary,
  };
  return result;
}

function codeOf(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message.slice(0, 80) : "unknown_error";
}
