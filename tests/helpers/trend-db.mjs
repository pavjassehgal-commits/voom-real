/**
 * Local PGlite database with every repository migration plus the PROPOSED
 * trend SQL (the 0055 integration candidate), with Supabase's default privileges
 * reproduced first so the proposed revokes are really exercised.
 *
 * `rpcClient(db, role)` mimics supabase-js `.rpc()` for the trend functions:
 * it never throws and reports errors as `{ data: null, error }`.
 * `sqlPort(db, role)` is the TrendDatabase port used by the read model.
 */
import { readFileSync } from "node:fs";

import { createSupabaseLite } from "./pglite-supabase.mjs";

const PROPOSED = new URL("../../supabase/proposed/", import.meta.url);
export const STORAGE_SQL = readFileSync(new URL("trend_intelligence_storage.sql", PROPOSED), "utf8");
export const GOVERNANCE_SQL = readFileSync(new URL("trend_intelligence_governance.sql", PROPOSED), "utf8");
export const GOVERNANCE_ROLLBACK_SQL = readFileSync(new URL("trend_intelligence_governance.rollback.sql", PROPOSED), "utf8");
export const STORAGE_ROLLBACK_SQL = readFileSync(new URL("trend_intelligence_storage.rollback.sql", PROPOSED), "utf8");
/** The single integration candidate (both components in one transaction). */
export const CANDIDATE_SQL = readFileSync(new URL("0055_trend_intelligence.sql", PROPOSED), "utf8");
export const CANDIDATE_ROLLBACK_SQL = readFileSync(new URL("0055_trend_intelligence.rollback.sql", PROPOSED), "utf8");
export const MARA_CONTEXT_SQL = readFileSync(new URL("0056_trend_mara_workflow_context.sql", PROPOSED), "utf8");
export const MARA_CONTEXT_ROLLBACK_SQL = readFileSync(new URL("0056_trend_mara_workflow_context.rollback.sql", PROPOSED), "utf8");

export const SUPABASE_DEFAULT_PRIVILEGES = `
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

/**
 * The full schema is the integration candidate; `{ governance: false }` gives
 * the Stage 2A storage component alone.
 */
export async function createTrendDb({ governance = true } = {}) {
  const lite = await createSupabaseLite({ stopBefore: "0055" });
  await lite.db.exec(SUPABASE_DEFAULT_PRIVILEGES);
  await lite.db.exec(governance ? CANDIDATE_SQL : STORAGE_SQL);
  return lite;
}

const ROLES = new Set(["service_role", "anon", "authenticated"]);
/** "owner" runs as the migration owner (no role switch): test-only, for owner-only functions. */
const RPC_ROLES = new Set([...ROLES, "owner"]);
const RPC_NAME = /^trend_[a-z_]+$/;
const ARG_NAME = /^p_[a-z_]+$/;

export function rpcClient(db, role = "service_role") {
  if (!RPC_ROLES.has(role)) throw new Error(`unknown role ${role}`);
  return {
    async rpc(fn, args = {}) {
      if (!RPC_NAME.test(fn)) return { data: null, error: { code: "PGRST202" } };
      const names = Object.keys(args);
      if (!names.every((name) => ARG_NAME.test(name))) return { data: null, error: { code: "PGRST202" } };
      try {
        const data = await db.transaction(async (tx) => {
          if (role !== "owner") await tx.query(`set local role ${role}`);
          const call = `select public.${fn}(${names.map((name, i) => `${name} => $${i + 1}`).join(", ")}) as r`;
          const values = names.map((name) => {
            const value = args[name];
            // supabase-js sends JSON: objects, and anything bound for a jsonb argument, are encoded.
            return value !== null && (typeof value === "object" || name === "p_observation") ? JSON.stringify(value) : value;
          });
          return (await tx.query(call, values)).rows[0].r;
        });
        return { data, error: null };
      } catch (error) {
        return { data: null, error: { code: error?.code ?? "unknown", message: String(error?.message) } };
      }
    },
  };
}

export function sqlPort(db, role = "service_role") {
  if (!ROLES.has(role)) throw new Error(`unknown role ${role}`);
  return {
    query: (sql, params) => db.transaction(async (tx) => {
      await tx.query(`set local role ${role}`);
      return tx.query(sql, params);
    }),
    transaction: (fn) => db.transaction(async (tx) => {
      await tx.query(`set local role ${role}`);
      return fn(tx);
    }),
  };
}
