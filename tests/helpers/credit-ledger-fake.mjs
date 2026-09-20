/**
 * In-memory model of the Voom credit-ledger RPCs the entitlement guard calls
 * (`lib/billing/ledger.ts` -> `reserve_media_credits`, `refund_media_credits`,
 * `settle_media_credits`, `voom_plan_allowance`; migrations 0035 + 0043).
 *
 * It mirrors the SQL contract so the REAL guard + ledger modules can be run
 * end-to-end against a table-backed fake admin, with no database:
 *   - one reservation per (owner, generation_id): a replay answers
 *     `already: true` and reserves nothing (the unique-key idempotency);
 *   - usage is month-scoped: `reserved` + `settled` rows count as used,
 *     `granted` grant/purchase rows add to the allowance;
 *   - the allowance comes from `businesses.plan` exactly like
 *     `voom_plan_allowance` (free 0 / pro 150 / max 500);
 *   - not enough credits fails closed with `insufficient_credits`;
 *   - refund flips reserved|settled -> refunded, settle flips reserved -> settled,
 *     both idempotent (a second call reports refunded/settled: false).
 *
 * Rows live in `tables.get("voom_credit_ledger")`, so `getCreditSummary`'s
 * ordinary table reads through the same fake admin see them too.
 *
 * The real SQL is exercised against PGlite in voom-plans-credits-safety;
 * this fake exists so behavioural suites can prove "exactly one paid job,
 * exactly one reservation" without a database per test file.
 */

export const PLAN_ALLOWANCES = { free: 0, pro: 150, max: 500 };

const LEDGER_RPCS = new Set(["reserve_media_credits", "refund_media_credits", "settle_media_credits", "voom_plan_allowance"]);

export function createFakeCreditLedger(tables, options = {}) {
  const now = options.now ?? (() => new Date());
  if (!tables.has("voom_credit_ledger")) tables.set("voom_credit_ledger", []);
  const rows = () => tables.get("voom_credit_ledger");
  const calls = [];
  let seq = 0;

  const planOf = (ownerId) => {
    const business = (tables.get("businesses") ?? []).find((row) => row.owner_user_id === ownerId);
    return business?.plan === "pro" || business?.plan === "max" ? business.plan : "free";
  };

  function usage(ownerId) {
    const at = now();
    const monthStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
    let used = 0;
    let additional = 0;
    for (const row of rows()) {
      if (row.owner_user_id !== ownerId) continue;
      if (Date.parse(row.created_at) < monthStart) continue;
      if ((row.status === "reserved" || row.status === "settled") && (row.source === "user_request" || row.source === "autopilot")) used += Number(row.credits);
      if (row.status === "granted" && (row.source === "grant" || row.source === "purchase")) additional += Number(row.credits);
    }
    const allowance = PLAN_ALLOWANCES[planOf(ownerId)];
    return { used, allowance, remaining: Math.max(0, allowance + additional - used) };
  }

  function findLive(ownerId, generationId, statuses) {
    return rows().find((row) => row.owner_user_id === ownerId && row.generation_id === generationId && statuses.includes(row.status)) ?? null;
  }

  /** Answers a Supabase-shaped `rpc(name, args)`; returns null for non-ledger RPCs. */
  async function rpc(name, args) {
    if (!LEDGER_RPCS.has(name)) return null;
    calls.push({ name, args });
    if (name === "reserve_media_credits") {
      const ownerId = args.p_owner_user_id;
      const generationId = args.p_generation_id;
      if (rows().some((row) => row.owner_user_id === ownerId && row.generation_id === generationId)) {
        return { data: { ok: true, already: true, ...usage(ownerId) }, error: null };
      }
      const before = usage(ownerId);
      if (before.remaining < Number(args.p_credits)) {
        return { data: { ok: false, reason: "insufficient_credits", ...before }, error: null };
      }
      const stamp = now().toISOString();
      rows().push({
        id: `ledger-${++seq}`, owner_user_id: ownerId, generation_id: generationId, media_type: args.p_media_type,
        credits: Number(args.p_credits), source: args.p_source, status: "reserved", created_at: stamp, updated_at: stamp,
      });
      return { data: { ok: true, ...usage(ownerId) }, error: null };
    }
    if (name === "refund_media_credits") {
      const row = findLive(args.p_owner_user_id, args.p_generation_id, ["reserved", "settled"]);
      if (row) { row.status = "refunded"; row.updated_at = now().toISOString(); }
      return { data: { ok: true, refunded: Boolean(row) }, error: null };
    }
    if (name === "settle_media_credits") {
      const row = findLive(args.p_owner_user_id, args.p_generation_id, ["reserved"]);
      if (row) { row.status = "settled"; row.updated_at = now().toISOString(); }
      return { data: { ok: true, settled: Boolean(row) }, error: null };
    }
    return { data: PLAN_ALLOWANCES[planOf(args.p_owner_user_id)], error: null };
  }

  return {
    rpc,
    calls,
    rows,
    usage,
    /** Ledger rows that still count against the owner's month (reserved or settled). */
    live: (ownerId) => rows().filter((row) => row.owner_user_id === ownerId && (row.status === "reserved" || row.status === "settled")),
  };
}

/**
 * Bounded wait for an asynchronous condition. Polls `condition` every
 * `intervalMs` and fails with a useful assertion error after `timeoutMs`
 * instead of spinning forever — a test must never be able to hang the suite.
 */
export async function waitFor(condition, { timeoutMs = 2_000, intervalMs = 5, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) {
      const error = new Error(`Timed out after ${timeoutMs}ms waiting for: ${message}`);
      error.code = "ERR_ASSERTION";
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
