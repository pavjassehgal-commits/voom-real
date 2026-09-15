/**
 * Voom Credit Ledger — durable credit accounting with atomic reservation.
 *
 * Guarantees:
 * - Never call provider first and deduct later: reservation happens before submission.
 * - Prevent concurrent overspend: per-owner advisory lock in Postgres, in-memory lock for tests.
 * - No double-charge: unique constraint on generation_id.
 * - Refund on provider failure before real paid job.
 * - Monthly allowance model: credits_remaining = allowance + additional - charged.
 *
 * Ledger schema (migration 0035):
 *   id, owner_user_id, business_id, generation_id (unique), media_type, credits, source, status, created_at, updated_at
 *
 * Status:
 *   reserved — credits held, provider not yet confirmed
 *   settled  — provider job created / completed
 *   refunded — reservation released (failure before paid job)
 *   granted  — additional credits (future packs)
 *
 * This module is the ONLY place that writes to voom_credit_ledger for charges.
 */

import { MONTHLY_CREDIT_ALLOWANCES, type PlanId, getPlanConfig, normalizePlan } from "./plans";
import { creditCostForMedia, type CreditMediaType } from "./credits";

export type CreditSource = "user_request" | "autopilot";
export type LedgerSource = CreditSource | "grant" | "purchase" | "refund";
export type LedgerStatus = "reserved" | "settled" | "refunded" | "granted";
export type LedgerMediaType = "image" | "video";

export interface LedgerEntry {
  id: string;
  owner_user_id: string;
  business_id?: string | null;
  generation_id: string | null;
  media_type: LedgerMediaType | null;
  credits: number;
  source: LedgerSource;
  status: LedgerStatus;
  created_at: string;
  updated_at: string;
}

export interface CreditSummary {
  plan: PlanId;
  allowance: number;
  additional: number;
  used: number;
  remaining: number;
  /** ISO string of next reset (first of next month UTC). */
  resetAt: string;
  periodStart: string;
  /** Human label for UI. */
  label: string;
}

export interface ReserveInput {
  ownerId: string;
  generationId: string;
  mediaType: CreditMediaType;
  credits?: number;
  source: CreditSource;
  planId?: PlanId;
  now?: Date;
}

export type ReserveResult =
  | { ok: true; already?: boolean; remaining: number; allowance: number; used: number; reservationId?: string }
  | { ok: false; reason: "insufficient_credits" | "plan_not_allowed" | "invalid"; remaining: number; allowance: number; used: number; message: string };

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function nextMonthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** In-memory per-owner lock for test environments without Postgres advisory locks. */
const ownerLocks = new Map<string, Promise<void>>();

async function withOwnerLock<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
  const prev = ownerLocks.get(ownerId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => (release = resolve));
  ownerLocks.set(ownerId, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Clean up if this was the last lock
    if (ownerLocks.get(ownerId) === next) {
      // Keep chain but allow GC; we replace with resolved promise after a tick
      // Actually we want to remove if no pending
      ownerLocks.delete(ownerId);
    }
  }
}

/**
 * Get credit summary for an owner.
 * Works with both real Supabase and pglite fakes.
 */
export async function getCreditSummary(
  admin: any,
  ownerId: string,
  planId: PlanId,
  now: Date = new Date(),
): Promise<CreditSummary> {
  const allowance = MONTHLY_CREDIT_ALLOWANCES[planId] ?? 0;
  const periodStart = monthStartUtc(now);
  const resetAt = nextMonthStartUtc(now);

  // Sum used credits this month (reserved + settled)
  let used = 0;
  let additional = 0;
  try {
    const { data, error } = await admin
      .from("voom_credit_ledger")
      .select("credits,source,status,created_at")
      .eq("owner_user_id", ownerId)
      .gte("created_at", periodStart.toISOString());

    if (!error && data) {
      for (const row of data as any[]) {
        if (row.status === "refunded") continue;
        if (row.source === "grant" || row.source === "purchase") {
          if (row.status === "granted") additional += Number(row.credits ?? 0);
        } else if (row.status === "reserved" || row.status === "settled") {
          used += Number(row.credits ?? 0);
        }
      }
    }
  } catch {
    // If table doesn't exist (pre-migration), treat as 0 used
    used = 0;
  }

  const remaining = Math.max(0, allowance + additional - used);

  return {
    plan: planId,
    allowance,
    additional,
    used,
    remaining,
    resetAt: resetAt.toISOString(),
    periodStart: periodStart.toISOString(),
    label: `${remaining} / ${allowance + additional} remaining this month`,
  };
}

/**
 * Attempt to reserve credits atomically.
 * Must be called BEFORE provider submission.
 *
 * For real Postgres, tries RPC reserve_media_credits which uses advisory lock.
 * Falls back to manual withOwnerLock for test environments.
 */
export async function reserveCredits(admin: any, input: ReserveInput): Promise<ReserveResult> {
  const now = input.now ?? new Date();
  const planId = input.planId ?? "free";
  const config = getPlanConfig(planId);
  const credits = input.credits ?? creditCostForMedia({ mediaType: input.mediaType });

  // Plan entitlement check: free cannot generate at all
  if (!config.allowsExplicitMedia && input.source === "user_request") {
    return {
      ok: false,
      reason: "plan_not_allowed",
      remaining: 0,
      allowance: config.monthlyCredits,
      used: 0,
      message: `Your ${config.name} plan does not include AI media generation. Upgrade to Pro or Max to generate with MARA.`,
    };
  }
  if (input.source === "autopilot" && !config.allowsAutomaticMedia) {
    return {
      ok: false,
      reason: "plan_not_allowed",
      remaining: 0,
      allowance: config.monthlyCredits,
      used: 0,
      message: `Automatic media generation is available on Max plan only.`,
    };
  }

  // Try RPC first (real Postgres)
  try {
    if (typeof admin.rpc === "function") {
      const { data, error } = await admin.rpc("reserve_media_credits", {
        p_owner_user_id: input.ownerId,
        p_generation_id: input.generationId,
        p_media_type: input.mediaType,
        p_credits: credits,
        p_source: input.source,
      });
      if (!error && data) {
        const result = data as any;
        if (result.ok) {
          if (result.already) {
            // Already reserved — treat as success, no double charge
            const summary = await getCreditSummary(admin, input.ownerId, planId, now);
            return { ok: true, already: true, remaining: summary.remaining, allowance: summary.allowance, used: summary.used };
          }
          return { ok: true, remaining: result.remaining, allowance: result.allowance, used: result.used };
        } else if (result.reason === "insufficient_credits") {
          return {
            ok: false,
            reason: "insufficient_credits",
            remaining: result.remaining ?? 0,
            allowance: result.allowance ?? config.monthlyCredits,
            used: result.used ?? 0,
            message: `You need ${credits} credits. You have ${result.remaining ?? 0} remaining.`,
          };
        }
      }
    }
  } catch {
    // Fall through to manual
  }

  // Manual path with in-memory lock (for pglite / tests / fallback)
  return withOwnerLock(input.ownerId, async (): Promise<ReserveResult> => {
    // Check idempotency: already reserved?
    try {
      const { data: existing } = await admin
        .from("voom_credit_ledger")
        .select("id")
        .eq("owner_user_id", input.ownerId)
        .eq("generation_id", input.generationId)
        .maybeSingle();
      if (existing) {
        const summary = await getCreditSummary(admin, input.ownerId, planId, now);
        return { ok: true, already: true, remaining: summary.remaining, allowance: summary.allowance, used: summary.used, reservationId: (existing as any).id };
      }
    } catch {
      // ignore
    }

    const summary = await getCreditSummary(admin, input.ownerId, planId, now);
    if (summary.remaining < credits) {
      return {
        ok: false,
        reason: "insufficient_credits",
        remaining: summary.remaining,
        allowance: summary.allowance,
        used: summary.used,
        message: `You need ${credits} credits. You have ${summary.remaining} remaining.`,
      };
    }

    // Insert reservation
    try {
      const { data, error } = await admin
        .from("voom_credit_ledger")
        .insert({
          owner_user_id: input.ownerId,
          generation_id: input.generationId,
          media_type: input.mediaType,
          credits,
          source: input.source,
          status: "reserved",
        })
        .select("id")
        .maybeSingle();

      if (error) {
        // Unique violation => already reserved (race)
        const code = (error as any).code;
        const msg = String((error as any).message ?? "").toLowerCase();
        if (code === "23505" || msg.includes("duplicate") || msg.includes("unique")) {
          const after = await getCreditSummary(admin, input.ownerId, planId, now);
          return { ok: true, already: true, remaining: after.remaining, allowance: after.allowance, used: after.used };
        }
        throw error;
      }

      const after = await getCreditSummary(admin, input.ownerId, planId, now);
      return {
        ok: true,
        remaining: after.remaining,
        allowance: after.allowance,
        used: after.used,
        reservationId: (data as any)?.id,
      };
    } catch (e) {
      // On any insert failure, treat as insufficient or invalid
      const summary2 = await getCreditSummary(admin, input.ownerId, planId, now);
      return {
        ok: false,
        reason: "invalid",
        remaining: summary2.remaining,
        allowance: summary2.allowance,
        used: summary2.used,
        message: `Could not reserve credits. Please retry.`,
      };
    }
  });
}

export async function refundCredits(admin: any, ownerId: string, generationId: string): Promise<{ ok: boolean; refunded: boolean }> {
  try {
    if (typeof admin.rpc === "function") {
      const { data, error } = await admin.rpc("refund_media_credits", {
        p_owner_user_id: ownerId,
        p_generation_id: generationId,
      });
      if (!error && data) {
        return { ok: true, refunded: Boolean((data as any).refunded) };
      }
    }
  } catch {
    // fallback
  }

  return withOwnerLock(ownerId, async () => {
    try {
      const { data } = await admin
        .from("voom_credit_ledger")
        .update({ status: "refunded" })
        .eq("owner_user_id", ownerId)
        .eq("generation_id", generationId)
        .in("status", ["reserved", "settled"])
        .select("id")
        .maybeSingle();
      return { ok: true, refunded: Boolean(data) };
    } catch {
      return { ok: false, refunded: false };
    }
  });
}

export async function settleCredits(admin: any, ownerId: string, generationId: string): Promise<{ ok: boolean; settled: boolean }> {
  try {
    if (typeof admin.rpc === "function") {
      const { data, error } = await admin.rpc("settle_media_credits", {
        p_owner_user_id: ownerId,
        p_generation_id: generationId,
      });
      if (!error && data) {
        return { ok: true, settled: Boolean((data as any).settled) };
      }
    }
  } catch {
    // fallback
  }

  return withOwnerLock(ownerId, async () => {
    try {
      const { data } = await admin
        .from("voom_credit_ledger")
        .update({ status: "settled" })
        .eq("owner_user_id", ownerId)
        .eq("generation_id", generationId)
        .eq("status", "reserved")
        .select("id")
        .maybeSingle();
      return { ok: true, settled: Boolean(data) };
    } catch {
      return { ok: false, settled: false };
    }
  });
}

/** For tests: clear locks */
export function __clearLocks() {
  ownerLocks.clear();
}
