/**
 * Marketing Plan lifecycle: what a Replenish click actually did, and what the
 * Marketing Plan's primary view shows as the rolling window moves.
 *
 * The plan is a ROLLING next-7-days horizon that always starts on the
 * account's local today — never a Monday–Sunday week. This module turns the
 * server's own run result into one of four explicit outcomes and their exact
 * owner-facing copy, and splits the shared workflow snapshot into the live
 * window versus older/later work. Every count and every channel/format label
 * comes from the server's run result; the client never infers what was added.
 *
 * Pure (no server-only or `@/` runtime imports), so the route, the client
 * workspace and the Node test suite all execute exactly this code.
 */

import type { SocialFormat, SocialMediaChannel } from "@/lib/social/channels";
import { SOCIAL_FORMATS, SOCIAL_MEDIA_CHANNELS } from "../../social/channels.ts";
import { DEFAULT_HORIZON_DAYS, isWithinHorizon } from "../cadence.ts";
import { addDays, formatLocalDate } from "../timezone.ts";
import { socialFormatLabel } from "./channel-planner.ts";
import type { RollingPlanResult } from "./rolling-plan.ts";
import type { WorkflowSnapshot, WorkflowView } from "./read.ts";

export const PLAN_RUN_OUTCOME_STATUSES = ["added", "up_to_date", "no_channels", "failed"] as const;
export type PlanRunOutcomeStatus = (typeof PLAN_RUN_OUTCOME_STATUSES)[number];

/** One recommendation THIS request persisted, with its real native assignment. */
export interface PlanRunAddedItem {
  /** Local slot date the recommendation is planned for. */
  date: string;
  channel: SocialMediaChannel;
  format: SocialFormat;
  /** Native label, e.g. "TikTok Video" or "YouTube Short". */
  label: string;
}

/** The added recommendations grouped by native format, in slot order. */
export interface PlanRunAddedFormat {
  channel: SocialMediaChannel;
  format: SocialFormat;
  label: string;
  count: number;
}

/**
 * The authoritative outcome of one POST /api/plan request.
 *
 *   added        every uncovered slot now has a persisted recommendation
 *   up_to_date   zero uncovered slots: nothing was generated or duplicated
 *   no_channels  no supported social channel is selected (no Instagram fallback)
 *   failed       at least one uncovered slot could not be persisted, or the
 *                run itself failed — never reported as success, even when
 *                some recommendations were saved first
 */
export interface PlanRunOutcome {
  status: PlanRunOutcomeStatus;
  /** Recommendations this request persisted (server count; may be > 0 on failure). */
  added: number;
  addedItems: PlanRunAddedItem[];
  addedFormats: PlanRunAddedFormat[];
  /** Uncovered slots this request could not fill. */
  unfilled: number;
  /** Last local date of the rolling horizon the plan fully covers; null unless complete. */
  coveredThrough: string | null;
  horizonDays: number;
  /**
   * Failed outcomes only: true when the server re-read the active plan after
   * the failure and verified its items are exactly what they were before.
   */
  planUnchanged?: boolean;
}

/**
 * Maps a completed rolling-plan run onto its outcome. A media or approval
 * refusal (e.g. the AI media spend policy) never makes a run "failed": the
 * recommendations exist and only their media waits. A content-stage failure
 * means a slot was not persisted, so the run is "failed", not a success.
 */
export function planRunOutcome(run: RollingPlanResult): PlanRunOutcome {
  const addedItems: PlanRunAddedItem[] = (run.plan?.items ?? [])
    .filter((item) => item.created)
    .map((item) => ({
      date: item.slot,
      channel: item.channel,
      format: item.format,
      label: socialFormatLabel(item.channel, item.format),
    }));
  const unfilled = run.failures.filter((failure) => failure.stage === "content").length;
  const horizonDays = run.plan?.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const base = {
    added: run.created,
    addedItems,
    addedFormats: groupAddedFormats(addedItems),
    unfilled,
    // The horizon always begins on the run's local today (the plan's
    // validFrom), so full coverage runs through the window's last day. It is
    // only claimed for a plan that actually holds recommendations: late at
    // night a weekly cadence can have no schedulable slot left, and "complete
    // coverage" would then be untrue.
    coveredThrough: run.plan?.items.length ? addDays(run.plan.validFrom, horizonDays - 1) : null,
    horizonDays,
  };
  if (run.blockedReason === "no_supported_social_channels_selected") {
    return { ...base, status: "no_channels", coveredThrough: null };
  }
  if (!run.plan || unfilled > 0) return { ...base, status: "failed", coveredThrough: null, planUnchanged: false };
  return { ...base, status: run.created > 0 ? "added" : "up_to_date" };
}

/**
 * The failed outcome, made truthful by comparing the active plan's draft ids
 * read before the request with the ids re-read after it. "Unchanged" is only
 * ever claimed when both reads succeeded and nothing was added or removed.
 */
export function failedPlanRunOutcome(input: {
  run?: RollingPlanResult | null;
  before: readonly string[] | null;
  after: readonly string[] | null;
}): PlanRunOutcome {
  const fromRun = input.run ? planRunOutcome(input.run) : null;
  const verified = input.before !== null && input.after !== null;
  const before = new Set(input.before ?? []);
  const after = new Set(input.after ?? []);
  const addedIds = [...after].filter((id) => !before.has(id)).length;
  const removedIds = [...before].filter((id) => !after.has(id)).length;
  // The re-read plan is the ground truth; the run's own count is the fallback.
  const added = verified ? addedIds : (fromRun?.added ?? 0);
  return {
    status: "failed",
    added,
    addedItems: fromRun?.addedItems ?? [],
    addedFormats: fromRun?.addedFormats ?? [],
    unfilled: fromRun?.unfilled ?? 0,
    coveredThrough: null,
    horizonDays: fromRun?.horizonDays ?? DEFAULT_HORIZON_DAYS,
    planUnchanged: verified && added === 0 && removedIds === 0,
  };
}

/** Groups added items by native format, in product order (Instagram, TikTok, YouTube). */
function groupAddedFormats(items: PlanRunAddedItem[]): PlanRunAddedFormat[] {
  const groups = new Map<string, PlanRunAddedFormat>();
  for (const item of items) {
    const key = `${item.channel}_${item.format}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { channel: item.channel, format: item.format, label: item.label, count: 1 });
  }
  const rank = (group: PlanRunAddedFormat) => SOCIAL_MEDIA_CHANNELS.indexOf(group.channel) * 10
    + (SOCIAL_FORMATS[group.channel] as readonly string[]).indexOf(group.format);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b));
}

/** The exact owner-facing copy for each outcome. */
export const PLAN_OUTCOME_COPY = {
  upToDateTitle: "Your marketing plan is already up to date",
  addedTitle: "Your plan is ready ✓",
  noChannelsTitle: "Choose your marketing channels",
  noChannelsBody: "Select at least one social channel before building your Marketing Plan.",
  failedTitle: "We couldn't replenish your plan",
  failedUnchangedBody: "Your existing plan hasn't been changed. Try again.",
  /** Used when the server could not verify an unchanged plan; the workflow never deletes drafts. */
  failedUnverifiedBody: "None of your existing recommendations were deleted. Try again.",
} as const;

/** The Replenish button label when the live horizon is fully covered. */
export const PLAN_UP_TO_DATE_LABEL = "✓ Plan up to date";

export interface PlanOutcomeFeedback {
  tone: "success" | "info" | "warning" | "error";
  title: string;
  body: string;
  /** Native formats actually added, from the server's run, e.g. "Instagram Reel · TikTok Video". */
  summary: string | null;
}

export function planOutcomeFeedback(outcome: PlanRunOutcome): PlanOutcomeFeedback {
  switch (outcome.status) {
    case "up_to_date": {
      const through = outcome.coveredThrough ? formatLocalDate(outcome.coveredThrough) : null;
      return {
        tone: "info",
        title: PLAN_OUTCOME_COPY.upToDateTitle,
        body: through
          ? `You have complete marketing coverage through ${through}. Voom will add more content when it's needed.`
          : "Nothing more can be scheduled right now. Voom will add more content when it's needed.",
        summary: null,
      };
    }
    case "added":
      return {
        tone: "success",
        title: PLAN_OUTCOME_COPY.addedTitle,
        body: `Added ${outcome.added} ${plural(outcome.added, "recommendation")} for the next ${outcome.horizonDays} days.`,
        summary: outcome.addedFormats.length
          ? outcome.addedFormats.map((group) => (group.count > 1 ? `${group.label} ×${group.count}` : group.label)).join(" · ")
          : null,
      };
    case "no_channels":
      return { tone: "warning", title: PLAN_OUTCOME_COPY.noChannelsTitle, body: PLAN_OUTCOME_COPY.noChannelsBody, summary: null };
    default:
      return {
        tone: "error",
        title: PLAN_OUTCOME_COPY.failedTitle,
        body: outcome.planUnchanged
          ? PLAN_OUTCOME_COPY.failedUnchangedBody
          : outcome.added > 0
            // Partial persistence is still a failure, and says what was saved.
            ? `Voom saved ${outcome.added} new ${plural(outcome.added, "recommendation")} before something went wrong. Try again to finish your plan.`
            : PLAN_OUTCOME_COPY.failedUnverifiedBody,
        summary: null,
      };
  }
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

const REPLENISH_FALLBACK_ERROR = "Voom couldn't build your plan right now.";

/**
 * What the Marketing Plan shows for one POST /api/plan response. Success is
 * only ever shown for a 2xx whose server outcome says so; a failed outcome
 * shows the failure copy; anything else (429, 401, a malformed body) shows the
 * server's error. The client never infers an outcome of its own.
 */
export function replenishResponseFeedback(
  ok: boolean,
  body: { outcome?: PlanRunOutcome | null; error?: string | null } | null,
): { feedback: PlanOutcomeFeedback | null; error: string | null } {
  const outcome = body?.outcome ?? null;
  if (outcome?.status === "failed") return { feedback: planOutcomeFeedback(outcome), error: null };
  if (ok && outcome && (PLAN_RUN_OUTCOME_STATUSES as readonly string[]).includes(outcome.status)) {
    return { feedback: planOutcomeFeedback(outcome), error: null };
  }
  if (ok && !outcome) return { feedback: null, error: null };
  return { feedback: null, error: body?.error || REPLENISH_FALLBACK_ERROR };
}

/** Compact label for the live window, e.g. "Sat, 12 Sep → Fri, 18 Sep". */
export function rollingWindowLabel(start: string, end: string): string {
  if (!start || !end) return "";
  const format = new Intl.DateTimeFormat("en-AE", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
  const label = (date: string) => format.format(new Date(`${date}T12:00:00Z`));
  return `${label(start)} → ${label(end)}`;
}

/**
 * True when the live rolling horizon is fully covered: every schedulable slot
 * already holds a recommendation, so a Replenish now would add nothing. With
 * no schedulable slot at all (e.g. late at night on a weekly cadence) nothing
 * is covered, so the button does not claim "up to date".
 */
export function planIsUpToDate(snapshot: Pick<WorkflowSnapshot, "coverage">): boolean {
  return snapshot.coverage?.status === "complete" && snapshot.coverage.slots > 0;
}

/** Finished history: it belongs to the Content Calendar and Performance, not the working plan. */
export function isFinishedPlanHistory(item: Pick<WorkflowView, "status" | "failedStage">): boolean {
  return item.status === "published" || item.failedStage === "rejected";
}

export interface PlanWorkspaceView {
  /** First and last local date of the live rolling window. */
  start: string;
  end: string;
  days: number;
  /** The primary view: items dated inside today → today + (days - 1). */
  current: WorkflowView[];
  /**
   * Older or later items that still need the owner (missed, failed, held for
   * media, scheduled beyond the window), kept reachable so they can still be
   * posted, rescheduled or cancelled. Finished history is in neither list.
   */
  outside: WorkflowView[];
}

/**
 * Splits the shared snapshot for the Marketing Plan. Nothing is deleted or
 * archived: Today, Approvals and the Content Calendar keep reading the full
 * snapshot, and every record stays in the database.
 */
export function planWorkspaceView(snapshot: Pick<WorkflowSnapshot, "items" | "today" | "coverage">): PlanWorkspaceView {
  const days = snapshot.coverage?.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const start = snapshot.today;
  const current: WorkflowView[] = [];
  const outside: WorkflowView[] = [];
  for (const item of snapshot.items) {
    if (isWithinHorizon(start, item.localDate || item.slotDate, days)) current.push(item);
    else if (!isFinishedPlanHistory(item)) outside.push(item);
  }
  return { start, end: start ? addDays(start, days - 1) : "", days, current, outside };
}
