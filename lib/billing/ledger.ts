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

type ReconciliationAction = "settle" | "refund";

interface CreditReconciliationRow {
  id: string;
  owner_user_id: string;
  generation_id: string;
  action: ReconciliationAction;
  attempt_count: number;
}

async function recordReconciliationFailure(
  admin: SupabaseClient,
  ownerId: string,
  generationId: string,
  action: ReconciliationAction,
  errorCode: string,
): Promise<void> {
  try {
    await admin.from("credit_reconciliation_tasks").upsert({
      owner_user_id: ownerId,
      generation_id: generationId,
      action,
      status: "pending",
      last_error_code: errorCode,
      next_attempt_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_user_id,generation_id,action" });
  } catch {
    // The failed settlement remains visible in server logs even if the
    // reconciliation table itself is temporarily unavailable.
    console.error("credit_reconciliation_enqueue_failed", { action, generationId });
  }
}

async function resolveReconciliationTask(
  admin: SupabaseClient,
  ownerId: string,
  generationId: string,
  action: ReconciliationAction,
): Promise<void> {
  try {
    await admin.from("credit_reconciliation_tasks").update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error_code: null,
    }).eq("owner_user_id", ownerId).eq("generation_id", generationId).eq("action", action);
  } catch {
    // Resolution bookkeeping can be retried; the idempotent ledger RPC is
    // authoritative and prevents a duplicate charge/refund.
  }
}

async function runCreditAction(admin: SupabaseClient, action: ReconciliationAction, ownerId: string, generationId: string) {
  const rpcName = action === "settle" ? "settle_media_credits" : "refund_media_credits";
  const { data, error } = await admin.rpc(rpcName, { p_owner_user_id: ownerId, p_generation_id: generationId });
  if (error) throw error;
  const applied = action === "settle"
    ? Boolean((data as SettleCreditsRpcResult | null)?.settled)
    : Boolean((data as RefundCreditsRpcResult | null)?.refunded);
  return applied;
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
    const refunded = await runCreditAction(admin, "refund", ownerId, generationId);
    await resolveReconciliationTask(admin, ownerId, generationId, "refund");
    return { ok: true, refunded };
  } catch (error) {
    await recordReconciliationFailure(admin, ownerId, generationId, "refund", safeCreditErrorCode(error));
  }
  return { ok: false, refunded: false };
}

export async function settleCredits(admin: SupabaseClient, ownerId: string, generationId: string): Promise<{ ok: boolean; settled: boolean }> {
  try {
    const settled = await runCreditAction(admin, "settle", ownerId, generationId);
    await resolveReconciliationTask(admin, ownerId, generationId, "settle");
    return { ok: true, settled };
  } catch (error) {
    await recordReconciliationFailure(admin, ownerId, generationId, "settle", safeCreditErrorCode(error));
  }
  return { ok: false, settled: false };
}

export async function reconcilePendingCreditTransactions(
  admin: SupabaseClient,
  limit = 25,
): Promise<{ checked: number; resolved: number; pending: number }> {
  const now = new Date();
  const { data, error } = await admin.from("credit_reconciliation_tasks")
    .select("id,owner_user_id,generation_id,action,attempt_count")
    .eq("status", "pending")
    .lte("next_attempt_at", now.toISOString())
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw error;

  const rows = (data ?? []) as CreditReconciliationRow[];
  let resolved = 0;
  for (const row of rows) {
    try {
      const applied = await runCreditAction(admin, row.action, row.owner_user_id, row.generation_id);
      // "Not applied" is only success when the owner's ledger entry is already
      // in the target state (an earlier attempt landed). A missing entry or a
      // conflicting state (e.g. settling a refunded entry) stays pending and
      // flagged with backoff instead of being silently resolved.
      if (!applied) await assertLedgerAlreadyReconciled(admin, row.action, row.owner_user_id, row.generation_id);
      await admin.from("credit_reconciliation_tasks").update({
        status: "resolved",
        attempt_count: row.attempt_count + 1,
        last_error_code: null,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", row.id).eq("status", "pending");
      resolved += 1;
    } catch (actionError) {
      const attemptCount = row.attempt_count + 1;
      const delayMinutes = Math.min(2 ** Math.min(attemptCount, 8), 360);
      await admin.from("credit_reconciliation_tasks").update({
        attempt_count: attemptCount,
        last_error_code: safeCreditErrorCode(actionError),
        next_attempt_at: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", row.id).eq("status", "pending");
    }
  }
  return { checked: rows.length, resolved, pending: rows.length - resolved };
}

async function assertLedgerAlreadyReconciled(
  admin: SupabaseClient,
  action: ReconciliationAction,
  ownerId: string,
  generationId: string,
): Promise<void> {
  const { data, error } = await admin.from("voom_credit_ledger").select("status")
    .eq("owner_user_id", ownerId).eq("generation_id", generationId).maybeSingle();
  if (error) throw error;
  if (!data) throw { code: "ledger_entry_missing" };
  const target = action === "settle" ? "settled" : "refunded";
  if ((data as { status?: unknown }).status !== target) throw { code: "ledger_state_conflict" };
}

function safeCreditErrorCode(error: unknown): string {
  if (typeof error === "object" && error && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 80);
  }
  return "credit_rpc_failed";
}

export function __clearLocks() {
  // Unused now
}
