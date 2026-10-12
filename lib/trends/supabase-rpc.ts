import "server-only";

import { createAdminClient } from "@/utils/supabase/admin";

/**
 * Trend Intelligence — the server-only RPC adapter.
 *
 * Every trend write goes through a service-role-only Postgres function
 * (supabase/proposed/trend_intelligence_governance.sql). This module is the
 * single place that binds those functions to Voom's existing Supabase admin
 * client, following the `consume_rate_limit` pattern (lib/rate-limit.ts).
 *
 * createTrendAdminRpcClient() remains unused by production ingestion. The
 * flag-gated MARA context loader may call the read RPC through Voom's existing
 * admin client after the proposed SQL is approved, numbered and applied.
 */

export const TREND_RPC_FUNCTIONS = [
  "trend_store_observation",
  "trend_list_usable_observations",
  "trend_invalidate_observation",
  "trend_run_retention_purge",
  "trend_retention_status",
] as const;

export type TrendRpcFunction = (typeof TREND_RPC_FUNCTIONS)[number];

export type TrendRpcResponse = { data: unknown; error: { code?: string; message?: string } | null };

/** The subset of the Supabase client the trend modules use. */
export type TrendRpcClient = {
  rpc(fn: TrendRpcFunction, args: Record<string, unknown>): PromiseLike<TrendRpcResponse>;
};

/** Binds the trend RPCs to the service-role Supabase client. Server-only. */
export function createTrendAdminRpcClient(): TrendRpcClient {
  const client = createAdminClient();
  return {
    rpc: (fn, args) => client.rpc(fn, args).then(({ data, error }) => ({ data, error: error ? { code: error.code } : null })),
  };
}

/**
 * Calls one trend RPC. Never throws and never returns database messages:
 * transport and database errors become `{ ok: false }`.
 */
export async function callTrendRpc(
  client: TrendRpcClient,
  fn: TrendRpcFunction,
  args: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false }> {
  try {
    const { data, error } = await client.rpc(fn, args);
    if (error || data === null || typeof data !== "object" || Array.isArray(data)) return { ok: false };
    return { ok: true, data: data as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/** A database result code, only if it has the safe `[a-z_]` shape. */
export function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : undefined;
}
