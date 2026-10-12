import "server-only";

import { parseInstant } from "./schema";
import { storeTrendObservation, type StoreResult } from "./storage";
import { callTrendRpc, safeCode, type TrendRpcClient } from "./supabase-rpc";
import type { TrendObservation } from "./types";

/**
 * Trend Intelligence — corrections and retention, through the service-role
 * RPCs of the proposed governance schema.
 *
 * Corrections never edit history. An inaccurate observation is INVALIDATED
 * (append-only record: what, why, when, who, reference) and disappears from
 * reads and recommendations; a corrected observation may then be stored as
 * the next revision of the same identity, through the normal store path, so
 * it passes the same approval, coverage, validation and retention rules.
 *
 * STAFF AUTHORIZATION (Stage 2D). Only authorized Voom staff may invalidate.
 * The actor is never taken from the request: it comes from a server-side
 * TrendStaffAuthorizer that must establish, from the authenticated session,
 * that the caller is active Voom staff. No such authority exists in this
 * codebase yet (the Admin Panel's MFA admin memberships are unmerged), so
 * the only authorizer provided denies, and the database grants
 * trend_invalidate_observation to no API role. Corrections are DISABLED
 * until both are replaced together — see docs/trend-intelligence/STAGE-2D.md.
 */

export const INVALIDATION_REASONS = [
  "wrong_evidence",
  "wrong_item",
  "wrong_market",
  "wrong_metric",
  "source_withdrawn",
  "other_verified_error",
] as const;
export type InvalidationReason = (typeof INVALIDATION_REASONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Opaque actor ids such as "admin:<uuid>" — never names or emails. */
const ACTOR = /^[A-Za-z0-9._:-]{1,120}$/;
/** Ticket or record ids — no spaces or slashes, so no titles or URLs. */
const REFERENCE = /^[A-Za-z0-9._:#-]{1,120}$/;

/** No actor field: who is acting is decided by the authorizer, never the request. */
export type InvalidationRequest = {
  observationId: string;
  reason: InvalidationReason;
  reference: string;
};

/**
 * Server-side staff check for corrections. Must derive the decision from the
 * authenticated server session (never from client input) and return an
 * opaque staff actor id such as "staff:<user uuid>".
 */
export type TrendStaffAuthorizer = {
  authorizeCorrection(): Promise<{ ok: true; actorId: string } | { ok: false }>;
};

/** The only authorizer that exists today: corrections are disabled. */
export const CORRECTIONS_DISABLED: TrendStaffAuthorizer = {
  authorizeCorrection: async () => ({ ok: false }),
};

export type InvalidationResult =
  | { status: "invalidated"; observationId: string; revision: number; invalidatedAt: string }
  | { status: "already_invalidated"; observationId: string }
  | { status: "rejected"; code: "invalid_request" | "staff_authorization_required" | "not_found" | "storage_failed" };

export async function invalidateTrendObservation(
  client: TrendRpcClient,
  request: InvalidationRequest,
  authorizer: TrendStaffAuthorizer = CORRECTIONS_DISABLED,
): Promise<InvalidationResult> {
  if (!UUID.test(request.observationId) || !(INVALIDATION_REASONS as readonly string[]).includes(request.reason)
      || !REFERENCE.test(request.reference)) {
    return { status: "rejected", code: "invalid_request" };
  }
  let decision: Awaited<ReturnType<TrendStaffAuthorizer["authorizeCorrection"]>>;
  try {
    decision = await authorizer.authorizeCorrection();
  } catch {
    decision = { ok: false };
  }
  if (!decision.ok || !ACTOR.test(decision.actorId)) return { status: "rejected", code: "staff_authorization_required" };
  const response = await callTrendRpc(client, "trend_invalidate_observation", {
    p_observation_id: request.observationId,
    p_reason_code: request.reason,
    p_actor: decision.actorId,
    p_reference: request.reference,
  });
  if (!response.ok) return { status: "rejected", code: "storage_failed" };
  const data = response.data;
  if (data.status === "invalidated" && typeof data.observation_id === "string" && Number.isInteger(data.revision)) {
    const at = parseInstant(String(data.invalidated_at));
    if (at !== null) {
      return { status: "invalidated", observationId: data.observation_id, revision: data.revision as number, invalidatedAt: new Date(at).toISOString() };
    }
  }
  if (data.status === "already_invalidated" && typeof data.observation_id === "string") {
    return { status: "already_invalidated", observationId: data.observation_id };
  }
  if (data.status === "rejected" && (data.code === "invalid_request" || data.code === "not_found")) {
    return { status: "rejected", code: data.code };
  }
  return { status: "rejected", code: "storage_failed" };
}

export type CorrectionResult = {
  invalidation: InvalidationResult;
  /** Absent when the invalidation did not succeed. */
  replacement?: StoreResult;
};

/**
 * Invalidates `request.observationId`, then stores `replacement` as its next
 * revision. Two steps by design: if the replacement is refused (e.g. the
 * source is no longer approved), the wrong observation stays hidden and the
 * replacement can be retried later with `replaces`.
 */
export async function correctTrendObservation(
  client: TrendRpcClient,
  request: InvalidationRequest,
  replacement: TrendObservation,
  options: { now: Date | number | string; authorizer?: TrendStaffAuthorizer },
): Promise<CorrectionResult> {
  const invalidation = await invalidateTrendObservation(client, request, options.authorizer ?? CORRECTIONS_DISABLED);
  if (invalidation.status === "rejected") return { invalidation };
  const replaced = await storeTrendObservation(client, replacement, { now: options.now, replaces: request.observationId });
  return { invalidation, replacement: replaced };
}

/* ──────────────────────────────────────────────────────────────
   Retention
   ────────────────────────────────────────────────────────────── */

export type PurgeResult =
  | {
      status: "succeeded" | "failed";
      code?: string;
      observationsDeleted: number;
      auditEventsDeleted: number;
      remainingOverdue: number;
      oldestOverdueAt: string | null;
    }
  | { status: "rejected"; code: "invalid_limit" | "storage_failed" };

/**
 * One bounded retention pass (1–1000 rows per table). Deletes only rows past
 * their database-computed deadline — there is no time argument. Every run is
 * recorded, including failures. NOT scheduled anywhere.
 */
export async function runTrendRetentionPurge(client: TrendRpcClient, options: { limit?: number } = {}): Promise<PurgeResult> {
  const limit = options.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return { status: "rejected", code: "invalid_limit" };
  const response = await callTrendRpc(client, "trend_run_retention_purge", { p_limit: limit });
  if (!response.ok) return { status: "rejected", code: "storage_failed" };
  const data = response.data;
  if ((data.status !== "succeeded" && data.status !== "failed")
      || ![data.observations_deleted, data.audit_events_deleted, data.remaining_overdue].every((n) => Number.isInteger(n))) {
    return { status: "rejected", code: "storage_failed" };
  }
  const oldest = data.oldest_overdue_at === null ? null : parseInstant(String(data.oldest_overdue_at));
  return {
    status: data.status,
    ...(data.status === "failed" ? { code: safeCode(data.code) ?? "purge_failed" } : {}),
    observationsDeleted: data.observations_deleted as number,
    auditEventsDeleted: data.audit_events_deleted as number,
    remainingOverdue: data.remaining_overdue as number,
    oldestOverdueAt: oldest === null ? null : new Date(oldest).toISOString(),
  };
}

export type RetentionStatus = {
  overdue: number;
  oldestOverdueAt: string | null;
  /** Any row more than 24 hours past its deadline, or any YouTube row past 30 days. */
  breach: boolean;
  youtubePolicyBreach: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
};

export async function getTrendRetentionStatus(client: TrendRpcClient): Promise<{ ok: true; status: RetentionStatus } | { ok: false }> {
  const response = await callTrendRpc(client, "trend_retention_status", {});
  if (!response.ok) return { ok: false };
  const data = response.data;
  const instant = (value: unknown) => {
    if (value === null || value === undefined) return null;
    const ms = parseInstant(String(value));
    return ms === null ? null : new Date(ms).toISOString();
  };
  if (!Number.isInteger(data.overdue) || typeof data.breach !== "boolean" || typeof data.youtube_policy_breach !== "boolean") return { ok: false };
  return {
    ok: true,
    status: {
      overdue: data.overdue as number,
      oldestOverdueAt: instant(data.oldest_overdue_at),
      breach: data.breach,
      youtubePolicyBreach: data.youtube_policy_breach,
      lastSuccessAt: instant(data.last_success_at),
      lastFailureAt: instant(data.last_failure_at),
      lastFailureCode: safeCode(data.last_failure_code) ?? null,
    },
  };
}
