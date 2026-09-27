import type { SupabaseClient } from "@supabase/supabase-js";
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
  resetAt: string;
  periodStart: string;
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

interface LedgerSummaryRow {
  credits: number | string | null;
  source: string | null;
  status: string | null;
  created_at: string;
}

type ReserveCreditsRpcResult =
  | { ok: true; already?: boolean; remaining: number; allowance: number; used: number }
  | { ok: false; reason?: string; remaining?: number | null; allowance?: number | null; used?: number | null };

interface RefundCreditsRpcResult {
  refunded?: unknown;
}

interface SettleCreditsRpcResult {
  settled?: unknown;
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function nextMonthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export async function getCreditSummary(
  admin: SupabaseClient,
  ownerId: string,
  planId: PlanId,
  now: Date = new Date(),
): Promise<CreditSummary> {
  const allowance = MONTHLY_CREDIT_ALLOWANCES[planId] ?? 0;
  const periodStart = monthStartUtc(now);
  const resetAt = nextMonthStartUtc(now);

  let used = 0;
  let additional = 0;
  try {
    const { data, error } = await admin
      .from("voom_credit_ledger")
      .select("credits,source,status,created_at")
      .eq("owner_user_id", ownerId)
      .gte("created_at", periodStart.toISOString());

    if (!error && data) {
      for (const row of data as LedgerSummaryRow[]) {
        if (row.status === "refunded") continue;
        if (row.source === "grant" || row.source === "purchase") {
          if (row.status === "granted") additional += Number(row.credits ?? 0);
        } else if (row.status === "reserved" || row.status === "settled") {
          used += Number(row.credits ?? 0);
        }
      }
    }
  } catch {
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

export async function reserveCredits(admin: SupabaseClient, input: ReserveInput): Promise<ReserveResult> {
  const now = input.now ?? new Date();
  const planId = input.planId ?? "free";
  const config = getPlanConfig(planId);
  const credits = input.credits ?? creditCostForMedia({ mediaType: input.mediaType });

  if (!config.allowsExplicitMedia && input.source === "user_request") {
    return { ok: false, reason: "plan_not_allowed", remaining: 0, allowance: config.monthlyCredits, used: 0, message: `Your ${config.name} plan does not include AI media generation. Upgrade to Pro or Max to generate with MARA.` };
  }
  if (input.source === "autopilot" && !config.allowsAutomaticMedia) {
    return { ok: false, reason: "plan_not_allowed", remaining: 0, allowance: config.monthlyCredits, used: 0, message: `Automatic media generation is available on Max plan only.` };
  }

  try {
    const { data, error } = await admin.rpc("reserve_media_credits", {
      p_owner_user_id: input.ownerId,
      p_generation_id: input.generationId,
      p_media_type: input.mediaType,
      p_credits: credits,
      p_source: input.source,
    });
    if (error) throw error;
    if (data) {
      const result = data as ReserveCreditsRpcResult;
      if (result.ok) {
        if (result.already) {
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
  } catch (err) {
    // Failing closed on credit accounting
    const summary = await getCreditSummary(admin, input.ownerId, planId, now);
    return {
      ok: false,
      reason: "invalid",
      remaining: summary.remaining,
      allowance: summary.allowance,
      used: summary.used,
      message: `Could not process credit transaction. Please try again.`,
    };
  }

  const summary = await getCreditSummary(admin, input.ownerId, planId, now);
  return { ok: false, reason: "invalid", remaining: summary.remaining, allowance: summary.allowance, used: summary.used, message: `Unknown credit error.` };
}

export async function refundCredits(admin: SupabaseClient, ownerId: string, generationId: string): Promise<{ ok: boolean; refunded: boolean }> {
  try {
    const { data, error } = await admin.rpc("refund_media_credits", { p_owner_user_id: ownerId, p_generation_id: generationId });
    if (!error && data) {
      return { ok: true, refunded: Boolean((data as RefundCreditsRpcResult).refunded) };
    }
  } catch {
    // Return false on failure
  }
  return { ok: false, refunded: false };
}

export async function settleCredits(admin: SupabaseClient, ownerId: string, generationId: string): Promise<{ ok: boolean; settled: boolean }> {
  try {
    const { data, error } = await admin.rpc("settle_media_credits", { p_owner_user_id: ownerId, p_generation_id: generationId });
    if (!error && data) {
      return { ok: true, settled: Boolean((data as SettleCreditsRpcResult).settled) };
    }
  } catch {
    // Return false on failure
  }
  return { ok: false, settled: false };
}

export function __clearLocks() {
  // Unused now
}
