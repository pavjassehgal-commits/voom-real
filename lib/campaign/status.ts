/**
 * Pure lifecycle derivation for Automated Campaigns.
 *
 * The campaign's overall status is NEVER a manual toggle. It is computed from
 * the real states of its actions, which themselves are derived from:
 *   - email actions: the child email campaign's approval state and its
 *     provider-confirmed delivery rows,
 *   - Instagram actions: the content draft's state and the durable Instagram
 *     publish queue (only Meta-confirmed media reads as Published).
 *
 * No provider, no database, no "server-only" — the Node suite executes this.
 */

import {
  CAMPAIGN_LIFECYCLE_LABELS,
  type CampaignActionStatus,
  type CampaignLifecycle,
} from "./types";

/** Live, derived execution state for one timeline action. */
export type ActionExecutionState =
  | "proposed"
  | "needs_approval"
  | "approved"
  | "scheduled"
  | "executing"
  | "executed"
  | "failed"
  | "skipped";

export const ACTION_EXECUTION_LABELS: Record<ActionExecutionState, string> = {
  proposed: "Draft",
  needs_approval: "Needs approval",
  approved: "Approved",
  scheduled: "Scheduled",
  executing: "In progress",
  executed: "Done",
  failed: "Needs attention",
  skipped: "Skipped",
};

export interface EmailActionFacts {
  kind: "email";
  /** Persisted plan status from voom_campaign_actions. */
  planStatus: CampaignActionStatus;
  /** Child voom_campaigns.status, or null if the child is missing. */
  childStatus: "draft" | "approved" | "rejected" | null;
  /** Latest campaign_sends.internal_status for the child, if any. */
  sendStatus: "queued" | "sending" | "accepted" | "delivered" | "failed" | "skipped" | null;
  scheduledFor: string;
}

export interface InstagramActionFacts {
  kind: "instagram";
  planStatus: CampaignActionStatus;
  /** mara_drafts.status, or null when the draft is missing. */
  draftStatus: "draft" | "approved" | "rejected" | null;
  /** instagram_publish_queue.status for the draft, if any. */
  queueStatus:
    | "scheduled"
    | "waiting_for_media"
    | "permission_required"
    | "publishing"
    | "published"
    | "failed"
    | "cancelled"
    | null;
  scheduledFor: string;
}

export type ActionFacts = EmailActionFacts | InstagramActionFacts;

/**
 * How long after an action's proposed time it is "late" rather than still
 * waiting. Mirrors the Instagram workflow's 20-minute missed grace.
 */
export const ACTION_MISSED_GRACE_MINUTES = 20;

export function deriveActionState(facts: ActionFacts): ActionExecutionState {
  if (facts.kind === "email") return deriveEmailState(facts);
  return deriveInstagramState(facts);
}

function deriveEmailState(facts: EmailActionFacts): ActionExecutionState {
  // A missing child means the plan references something that never existed —
  // the timeline must not pretend it is fine.
  if (!facts.childStatus) return "failed";
  if (facts.sendStatus === "sending" || facts.sendStatus === "queued") return "executing";
  if (facts.sendStatus === "accepted" || facts.sendStatus === "delivered") return "executed";
  if (facts.sendStatus === "failed") return "failed";
  if (facts.sendStatus === "skipped" || facts.childStatus === "rejected") return "skipped";
  if (facts.childStatus === "approved") {
    // Approved and timed in the future: scheduled to the user's explicit send.
    // Email is never auto-sent in any mode, so "Approved · ready to send" is
    // surfaced as scheduled once its time is within its day.
    return "approved";
  }
  return facts.planStatus === "needs_approval" ? "needs_approval" : "proposed";
}

function deriveInstagramState(facts: InstagramActionFacts): ActionExecutionState {
  if (!facts.draftStatus) return "failed";
  switch (facts.queueStatus) {
    case "published": return "executed";
    case "publishing": return "executing";
    case "failed": return "failed";
    case "cancelled": return "skipped";
    case "scheduled":
    case "waiting_for_media":
    case "permission_required":
      return "scheduled";
    default:
  }
  if (facts.draftStatus === "rejected") return "skipped";
  if (facts.draftStatus === "approved") return "approved";
  return facts.planStatus === "needs_approval" ? "needs_approval" : "proposed";
}

const TERMINAL: ReadonlySet<ActionExecutionState> = new Set(["executed", "skipped"]);
const PENDING_APPROVAL: ReadonlySet<ActionExecutionState> = new Set(["proposed", "needs_approval"]);

export interface CampaignLifecycleFacts {
  actions: ActionFacts[];
  startAt: string | null;
  endAt: string | null;
  /** True only while the build request is in flight (client-side reality). */
  building?: boolean;
  now?: Date;
}

export function deriveCampaignLifecycle(facts: CampaignLifecycleFacts): CampaignLifecycle {
  const now = facts.now ?? new Date();

  // "Building" is the one transient value: it reflects a real in-flight build
  // request rather than a persisted toggle.
  if (facts.building) return "building";
  if (facts.actions.length === 0) return "draft";

  const states = facts.actions.map((action) => deriveActionState(action));

  if (states.includes("failed")) return "needs_attention";

  // An overdue action that has not run is attention-worthy.
  if (states.some((state, i) => isOverdue(states[i], facts.actions[i].scheduledFor, now))) {
    return "needs_attention";
  }

  if (states.every((state) => TERMINAL.has(state))) return "completed";

  const anyExecuted = states.includes("executed") || states.includes("executing");
  const beforeStart = facts.startAt ? now.getTime() < Date.parse(facts.startAt) - ACTION_MISSED_GRACE_MINUTES * 60_000 : true;
  const afterEnd = facts.endAt ? now.getTime() > Date.parse(facts.endAt) + 24 * 60 * 60_000 : false;

  if (anyExecuted) return afterEnd && states.every((s) => TERMINAL.has(s) || s === "failed") ? "completed" : "active";

  if (states.some((state) => PENDING_APPROVAL.has(state))) return "needs_approval";

  // Everything is approved/scheduled and nothing has run yet.
  if (states.every((state) => state === "approved" || state === "scheduled")) {
    return beforeStart ? "scheduled" : "active";
  }

  return "needs_approval";
}

function isOverdue(state: ActionExecutionState, scheduledFor: string, now: Date): boolean {
  if (state !== "proposed" && state !== "needs_approval" && state !== "approved") return false;
  const due = Date.parse(scheduledFor);
  if (!Number.isFinite(due)) return false;
  return due + ACTION_MISSED_GRACE_MINUTES * 60_000 < now.getTime();
}

export function lifecycleLabel(status: CampaignLifecycle): string {
  return CAMPAIGN_LIFECYCLE_LABELS[status];
}

export function lifecycleTone(status: CampaignLifecycle): string {
  switch (status) {
    case "completed": return "t-green";
    case "active": return "t-blue";
    case "scheduled": return "t-blue";
    case "needs_attention": return "t-red";
    case "needs_approval": return "t-amber";
    case "building": return "t-brand";
    default: return "t-grey";
  }
}

export function actionStateTone(state: ActionExecutionState): string {
  switch (state) {
    case "executed": return "t-green";
    case "executing":
    case "scheduled": return "t-blue";
    case "approved": return "t-blue";
    case "failed": return "t-red";
    case "needs_approval": return "t-amber";
    case "skipped": return "t-grey";
    default: return "t-grey";
  }
}
