/**
 * TEMPORARY — planning-only preview control. Safe to delete.
 *
 * This module exists only to back the temporary "Preview 7-Day Plan (No Media)"
 * button on the authenticated Marketing Plan screen. It calls the existing,
 * already-authenticated `POST /api/plan` endpoint with exactly
 * `{ "stage": "planning_only" }` and formats the returned run summary for
 * display. It contains no owner identity, no cadence override and no write of
 * its own: the server keeps scoping the run to the logged-in owner, and the
 * planning-only stage stops before paid media generation, approval, calendar
 * scheduling, the Instagram queue and publishing.
 *
 * To remove the experiment, delete:
 *   - this file,
 *   - components/voom/operating/PlanningOnlyPreview.tsx,
 *   - the one <PlanningOnlyPreviewCard /> line in
 *     components/voom/operating/PlanWorkspace.tsx,
 *   - tests/planning-only-preview-control.test.mjs.
 *
 * It is deliberately free of `server-only` / `@/` imports so the behaviour can
 * be executed directly by the Node test suite.
 */

import { CADENCE_LABELS, type Cadence } from "./cadence.ts";

/** The only endpoint the preview control talks to. */
export const PLANNING_ONLY_ENDPOINT = "/api/plan";

/** The exact, complete request body the preview button sends. */
export const PLANNING_ONLY_BODY = JSON.stringify({ stage: "planning_only" });

export type PlanningContentType = "post" | "reel" | "story";

/** The subset of the workflow run summary the preview panel renders. */
export interface PlanningPreviewRun {
  stage: string;
  planId: string | null;
  created: number;
  reused: number;
  slots: number;
  mediaQueued: number;
  awaitingApproval: number;
  autoApproved: number;
  heldForReview: number;
  plan: {
    cadence: Cadence;
    timeZone: string;
    horizonDays: number;
    validFrom: string;
    validUntil: string;
    items: {
      slot: string;
      publishAt: string;
      localDate: string;
      localTime: string;
      contentType: PlanningContentType;
      draftId: string;
      created: boolean;
    }[];
  } | null;
}

/** Minimal fetch contract, so the request shape can be driven by tests. */
export type PlanningPreviewFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * Asks the server for a planning-only run of the real rolling planner, using
 * the caller's existing authenticated session (cookies are sent by the
 * browser). Nothing else is sent: no owner id, no cadence, no stage override.
 */
export async function requestPlanningOnlyPreview(
  fetchImpl: PlanningPreviewFetch = fetch,
): Promise<PlanningPreviewRun> {
  const response = await fetchImpl(PLANNING_ONLY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: PLANNING_ONLY_BODY,
  });
  const payload = (await response.json()) as { run?: PlanningPreviewRun; error?: string };
  if (!response.ok || !payload.run) {
    throw new Error(payload.error ?? "Voom couldn't preview your plan right now.");
  }
  // Belt and braces: a preview may only ever show a planning-only run. If the
  // server ever answered with a full run, surface it instead of quietly
  // rendering media-backed results.
  if (payload.run.stage !== "planning_only") {
    throw new Error("Voom returned a full workflow run. Nothing was shown.");
  }
  return payload.run;
}

/**
 * One planning-only request in flight per browser session, ever.
 *
 * Production showed two `POST /api/plan` planning-only runs 40s apart from one
 * button click. The button was already disabled while busy, but `disabled`
 * only exists after React commits the state update: a second click inside that
 * window (double-click/double-tap, or a click after the card remounted and
 * reset its local `busy` state while the first request was still running)
 * reached the handler again and issued a second run. This module-level gate is
 * synchronous and survives remounts, so no UI path can start a second
 * planning-only request before the first one finishes. It is a UI-side guard
 * only — the backend's idempotent (owner, plan, slot-date) reuse stays intact.
 */
let inFlightPreview: Promise<PlanningPreviewRun> | null = null;

/**
 * Starts the preview request unless one is already in flight, in which case it
 * returns `null` and sends nothing. Resolve/rejection of the first request
 * clears the gate, so the next click always starts a fresh run.
 */
export function beginPlanningOnlyPreview(
  fetchImpl: PlanningPreviewFetch = fetch,
): Promise<PlanningPreviewRun> | null {
  if (inFlightPreview) return null;
  inFlightPreview = requestPlanningOnlyPreview(fetchImpl).finally(() => {
    inFlightPreview = null;
  });
  return inFlightPreview;
}

/** Test/debug visibility: is a planning-only request currently in flight? */
export function planningOnlyPreviewInFlight(): boolean {
  return inFlightPreview !== null;
}

export interface PlanningPreviewSlot {
  /** Local slot date (YYYY-MM-DD). */
  slot: string;
  localDate: string;
  localTime: string;
  contentType: PlanningContentType;
  contentTypeLabel: string;
  created: boolean;
}

/** Everything the temporary panel displays, derived from one run. */
export interface PlanningPreviewSummary {
  stage: string;
  created: number;
  reused: number;
  totalItems: number;
  cadenceLabel: string;
  timeZone: string;
  horizonDays: number;
  validFrom: string | null;
  validUntil: string | null;
  slots: PlanningPreviewSlot[];
  /** Read-out proving the run stopped before media, approval and queueing. */
  mediaQueued: number;
  awaitingApproval: number;
  autoApproved: number;
  heldForReview: number;
}

const CONTENT_TYPE_LABELS: Record<PlanningContentType, string> = {
  post: "Instagram Post",
  reel: "Reel",
  story: "Instagram Story",
};

/** Formats a planning-only run for display. Pure, so tests can assert it. */
export function planningPreviewSummary(run: PlanningPreviewRun): PlanningPreviewSummary {
  const plan = run.plan;
  return {
    stage: run.stage,
    created: run.created,
    reused: run.reused,
    totalItems: plan ? plan.items.length : run.slots,
    cadenceLabel: plan ? CADENCE_LABELS[plan.cadence] ?? plan.cadence : "—",
    timeZone: plan ? plan.timeZone : "—",
    horizonDays: plan ? plan.horizonDays : 0,
    validFrom: plan ? plan.validFrom : null,
    validUntil: plan ? plan.validUntil : null,
    slots: (plan?.items ?? []).map((item) => ({
      slot: item.slot,
      localDate: item.localDate,
      localTime: item.localTime,
      contentType: item.contentType,
      contentTypeLabel: CONTENT_TYPE_LABELS[item.contentType] ?? item.contentType,
      created: item.created,
    })),
    mediaQueued: run.mediaQueued,
    awaitingApproval: run.awaitingApproval,
    autoApproved: run.autoApproved,
    heldForReview: run.heldForReview,
  };
}
