/**
 * Migration 0072: a coordinator-created email flow can only be written while
 * the owner is authorized, checked inside the insert's own transaction (real
 * SQL on PGlite), and a concurrent pause is serialized against the insert.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const OWNER = "7b1d2c3e-0000-4000-8000-000000000072";

async function db(business) {
  const { db: pg } = await createSupabaseLite();
  await pg.query("insert into auth.users(id) values ($1)", [OWNER]);
  await pg.query("insert into public.businesses(owner_user_id, brand_name, plan, automation_level, automation_paused_at) values ($1, 'Owner', $2, $3, $4)",
    [OWNER, business.plan, business.level, business.paused ?? null]);
  return pg;
}
const insertFlow = (pg, createdBy, key = "coordinator-proposal-key-0001") => pg.query(
  `insert into public.voom_email_flows(owner_user_id, flow_type, trigger_type, name, created_by, idempotency_key)
   values ($1, 'welcome', 'newly_eligible_contact', 'Welcome', $2, $3)`, [OWNER, createdBy, key]);

for (const [label, business, allowed] of [
  ["Pro Assisted", { plan: "pro", level: "assisted" }, true],
  ["Max Autopilot", { plan: "max", level: "autopilot" }, true],
  ["Max Assisted", { plan: "max", level: "assisted" }, true],
  ["Free with a forged 'assisted'", { plan: "free", level: "assisted" }, false],
  ["Free with a forged 'autopilot'", { plan: "free", level: "autopilot" }, false],
  ["Pro with 'autopilot' (not entitled)", { plan: "pro", level: "autopilot" }, false],
  ["Manual", { plan: "max", level: "manual" }, false],
  ["an unconfirmed onboarding answer", { plan: "max", level: "MARA drafts, I approve" }, false],
  ["no mode", { plan: "max", level: null }, false],
  ["paused Max Autopilot", { plan: "max", level: "autopilot", paused: "2026-10-31T00:00:00Z" }, false],
]) {
  test(`coordinator flow write for ${label}: ${allowed ? "allowed" : "refused"}`, async () => {
    const pg = await db(business);
    const write = insertFlow(pg, "coordinator");
    if (allowed) await write; else await assert.rejects(write, /coordinator_flow_not_authorized/);
    // The owner's own flows are never blocked by this check.
    await insertFlow(pg, "user", "owner-created-flow-key-0002");
  });
}

test("a pause committed before the write wins; a write already holding the lock commits first", async () => {
  const pg = await db({ plan: "pro", level: "assisted" });
  // Pause lands, then the coordinator's (stale) write arrives: refused.
  await pg.query("update public.businesses set automation_paused_at = now() where owner_user_id = $1", [OWNER]);
  await assert.rejects(insertFlow(pg, "coordinator"), /coordinator_flow_not_authorized/);
  // Resume; a write inside a transaction holds FOR SHARE on the row, so the
  // pause issued by the owner applies after it (serialized, never interleaved).
  await pg.query("update public.businesses set automation_paused_at = null where owner_user_id = $1", [OWNER]);
  await pg.exec("begin");
  await insertFlow(pg, "coordinator", "coordinator-proposal-key-0003");
  const locked = await pg.query(`select count(*)::int as n from pg_locks l join pg_class c on c.oid = l.relation
    where c.relname = 'businesses' and l.mode = 'RowShareLock'`);
  await pg.exec("commit");
  assert.equal(locked.rows[0].n, 1, "the write takes a row share lock on the owner's business");
  const flows = await pg.query("select count(*)::int as n from public.voom_email_flows where owner_user_id = $1 and created_by = 'coordinator'", [OWNER]);
  assert.equal(flows.rows[0].n, 1);
});
