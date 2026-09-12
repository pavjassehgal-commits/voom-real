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
 *   - Manual creates nothing automatically, Assisted stops at Needs approval,
 *     Autopilot runs the existing deterministic safety evaluator and only then
 *     auto-approves and schedules,
 *   - every stage failure is recorded on the item instead of aborting the run.
 *
 * It performs no I/O: everything is expressed against injected ports, so the
 * end-to-end acceptance test drives the real logic with mocked providers.
 */

import {
  contentTypeForSlot,
  DEFAULT_HORIZON_DAYS,
  resolveSlotMinutes,
  slotDates,
  type Cadence,
  type ContentType,
} from "../cadence.ts";
import { localDate, localMinutes, localToUtcIso } from "../timezone.ts";

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
  mode: "manual" | "assisted" | "autopilot";
  goal: string;
  horizonDays?: number;
}

export interface RollingPlanResult {
  planId: string | null;
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
  const slots: PlanSlot[] = [];
  for (const [index, date] of slotDates(today, input.cadence, horizon).entries()) {
    const contentType = contentTypeForSlot(date, index);
    const minutes = resolveSlotMinutes({ contentType, index, isToday: date === today, nowMinutes });
    // A slot whose local day has no usable time left is skipped rather than
    // scheduled in the past — stale dates can never enter the workflow.
    if (minutes === null) continue;
    slots.push({ date, index, contentType, publishAt: localToUtcIso(date, minutes, input.timeZone) });
  }
  return slots;
}

export async function ensureRollingPlan(ports: RollingPlanPorts, input: RollingPlanInput): Promise<RollingPlanResult> {
  const result: RollingPlanResult = {
    planId: null, slots: 0, created: 0, reused: 0, mediaQueued: 0,
    awaitingApproval: 0, autoApproved: 0, heldForReview: 0, failures: [],
  };
  if (input.mode === "manual") return result;

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

  for (const slot of slots) {
    let item = existing.get(slot.date) ?? null;
    if (item) {
      result.reused += 1;
    } else {
      try {
        const content = await ports.generateContent(slot);
        item = await ports.createDraft({ planId, slot, content });
        result.created += 1;
      } catch (reason) {
        result.failures.push({ slot: slot.date, stage: "content", code: codeOf(reason) });
        continue;
      }
    }
    items.push(item);

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
  return result;
}

function codeOf(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message.slice(0, 80) : "unknown_error";
}
