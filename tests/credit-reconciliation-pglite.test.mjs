/**
 * The REAL credit reconciliation worker (lib/billing/ledger.ts
 * reconcilePendingCreditTransactions) against a REAL PostgreSQL (PGlite) with
 * every repository migration applied, including 0061 and the 0035/0043
 * credit-ledger RPCs. Only the Supabase client is a thin adapter over that
 * database; the RPCs, constraints, unique keys and ledger state are real.
 *
 * Nothing here touches staging, production, cron or any provider.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const ledger = await import("../lib/billing/ledger.ts");

const OWNER_A = "aaaaaaaa-0000-4000-8000-00000000c0a1";
const OWNER_B = "bbbbbbbb-0000-4000-8000-00000000c0b2";

/** Supabase-shaped client over PGlite for exactly what ledger.ts uses. */
function liteAdmin(db) {
  const state = { rpcFailures: 0, rpcCalls: [] };
  const encode = (value) => (value instanceof Date ? value.toISOString() : value && typeof value === "object" ? JSON.stringify(value) : value);
  return {
    state,
    async rpc(name, args) {
      state.rpcCalls.push(name);
      if (state.rpcFailures > 0) {
        state.rpcFailures -= 1;
        return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      }
      try {
        const r = await db.query(`select public.${name}($1, $2) as r`, [args.p_owner_user_id, args.p_generation_id]);
        return { data: r.rows[0].r, error: null };
      } catch (error) {
        return { data: null, error: { code: error.code ?? "PGRST000", message: error.message } };
      }
    },
    from(table) {
      const where = [];
      const params = [];
      let mode = "select";
      let columns = "*";
      let sets = [];
      let order = "";
      let limit = "";
      const add = (op) => (column, value) => { params.push(encode(value)); where.push(`"${column}" ${op} $${params.length}`); return chain; };
      const run = async () => {
        const clause = where.length ? ` where ${where.join(" and ")}` : "";
        if (mode === "update") {
          const r = await db.query(`update public.${table} set ${sets.join(", ")}${clause} returning *`, params);
          return { data: r.rows, error: null };
        }
        const r = await db.query(`select ${columns} from public.${table}${clause}${order}${limit}`, params);
        return { data: r.rows, error: null };
      };
      const chain = {
        select(cols = "*") { columns = cols === "*" ? "*" : cols.split(",").map((c) => `"${c.trim()}"`).join(","); return chain; },
        update(values) {
          mode = "update";
          sets = Object.entries(values).map(([column, value]) => { params.push(encode(value)); return `"${column}" = $${params.length}`; });
          return chain;
        },
        async upsert(row, options) {
          const keys = Object.keys(row);
          const conflict = options.onConflict.split(",").map((c) => `"${c.trim()}"`).join(",");
          const updates = keys.filter((k) => !options.onConflict.includes(k)).map((k) => `"${k}" = excluded."${k}"`).join(",");
          await db.query(
            `insert into public.${table} (${keys.map((k) => `"${k}"`).join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})
             on conflict (${conflict}) do update set ${updates}`,
            keys.map((k) => encode(row[k])),
          );
          return { data: row, error: null };
        },
        eq: add("="),
        lte: add("<="),
        order(column, opts) { order = ` order by "${column}" ${opts?.ascending === false ? "desc" : "asc"}`; return chain; },
        limit(n) { limit = ` limit ${Number(n)}`; return chain; },
        async maybeSingle() { const r = await run(); return { data: r.data[0] ?? null, error: null }; },
        then(resolve, reject) { return run().then(resolve, reject); },
      };
      return chain;
    },
  };
}

async function setup() {
  const { db } = await createSupabaseLite();
  for (const [id, plan] of [[OWNER_A, "max"], [OWNER_B, "max"]]) {
    await db.query("insert into auth.users (id) values ($1)", [id]);
    await db.query("insert into public.businesses (owner_user_id, plan) values ($1, $2)", [id, plan]);
  }
  return { db, admin: liteAdmin(db) };
}

const reserve = (db, owner, gen, type = "video", credits = 40) =>
  db.query("select public.reserve_media_credits($1, $2, $3, $4, 'autopilot') as r", [owner, gen, type, credits]).then((r) => r.rows[0].r);
const enqueue = (db, owner, gen, action, dueInMinutes = 0) => db.query(
  "insert into public.credit_reconciliation_tasks (owner_user_id, generation_id, action, next_attempt_at) values ($1, $2, $3, now() + make_interval(mins => $4))",
  [owner, gen, action, dueInMinutes],
);
const task = (db, gen, action) => db.query(
  "select status, attempt_count, last_error_code, resolved_at, extract(epoch from (next_attempt_at - now())) / 60 as due_in_min from public.credit_reconciliation_tasks where generation_id = $1 and action = $2",
  [gen, action],
).then((r) => r.rows[0]);
const ledgerStatus = (db, gen) => db.query("select status, credits from public.voom_credit_ledger where generation_id = $1", [gen]).then((r) => r.rows);
const makeDue = (db, gen) => db.query("update public.credit_reconciliation_tasks set next_attempt_at = now() - interval '1 second' where generation_id = $1", [gen]);

test("success: a due settle task settles the real reservation once and resolves", async () => {
  const { db, admin } = await setup();
  assert.equal((await reserve(db, OWNER_A, "gen-ok")).ok, true);
  await enqueue(db, OWNER_A, "gen-ok", "settle");
  assert.deepEqual(await ledger.reconcilePendingCreditTransactions(admin), { checked: 1, resolved: 1, pending: 0 });
  assert.deepEqual(await ledgerStatus(db, "gen-ok"), [{ status: "settled", credits: 40 }]);
  const t = await task(db, "gen-ok", "settle");
  assert.equal(t.status, "resolved");
  assert.equal(t.attempt_count, 1);
  assert.equal(t.last_error_code, null);
  assert.ok(t.resolved_at);
});

test("duplicate processing: a second run finds nothing; repeat ledger actions and enqueues never double-apply", async () => {
  const { db, admin } = await setup();
  await reserve(db, OWNER_A, "gen-dup");
  await enqueue(db, OWNER_A, "gen-dup", "settle");
  await ledger.reconcilePendingCreditTransactions(admin);
  assert.deepEqual(await ledger.reconcilePendingCreditTransactions(admin), { checked: 0, resolved: 0, pending: 0 });
  assert.deepEqual(await ledger.settleCredits(admin, OWNER_A, "gen-dup"), { ok: true, settled: false }, "the ledger RPC is idempotent");
  assert.deepEqual(await ledgerStatus(db, "gen-dup"), [{ status: "settled", credits: 40 }]);
  // A failing direct settlement enqueues through the real upsert; twice stays ONE task.
  await reserve(db, OWNER_A, "gen-dup-2");
  admin.state.rpcFailures = 2;
  await ledger.settleCredits(admin, OWNER_A, "gen-dup-2");
  await ledger.settleCredits(admin, OWNER_A, "gen-dup-2");
  const count = (await db.query("select count(*)::int n from public.credit_reconciliation_tasks where generation_id = 'gen-dup-2'")).rows[0].n;
  assert.equal(count, 1);
  assert.equal((await task(db, "gen-dup-2", "settle")).last_error_code, "57014");
});

test("retry and backoff: a failing RPC keeps the task pending with exponential delay, then resolves when it succeeds", async () => {
  const { db, admin } = await setup();
  await reserve(db, OWNER_A, "gen-retry");
  await enqueue(db, OWNER_A, "gen-retry", "refund");

  admin.state.rpcFailures = 1;
  assert.deepEqual(await ledger.reconcilePendingCreditTransactions(admin), { checked: 1, resolved: 0, pending: 1 });
  let t = await task(db, "gen-retry", "refund");
  assert.equal(t.status, "pending");
  assert.equal(t.attempt_count, 1);
  assert.equal(t.last_error_code, "57014");
  assert.ok(Number(t.due_in_min) > 1.5 && Number(t.due_in_min) <= 2.1, `first retry in ~2 min (got ${t.due_in_min})`);
  assert.deepEqual(await ledger.reconcilePendingCreditTransactions(admin), { checked: 0, resolved: 0, pending: 0 }, "not retried before its backoff");

  await makeDue(db, "gen-retry");
  admin.state.rpcFailures = 1;
  await ledger.reconcilePendingCreditTransactions(admin);
  t = await task(db, "gen-retry", "refund");
  assert.equal(t.attempt_count, 2);
  assert.ok(Number(t.due_in_min) > 3.5 && Number(t.due_in_min) <= 4.1, `second retry in ~4 min (got ${t.due_in_min})`);

  await makeDue(db, "gen-retry");
  assert.deepEqual(await ledger.reconcilePendingCreditTransactions(admin), { checked: 1, resolved: 1, pending: 0 });
  t = await task(db, "gen-retry", "refund");
  assert.equal(t.status, "resolved");
  assert.equal(t.attempt_count, 3);
  assert.deepEqual(await ledgerStatus(db, "gen-retry"), [{ status: "refunded", credits: 40 }]);
});

test("missing generation: an orphaned settle or refund task is NOT resolved; it stays pending, flagged, with backoff", async () => {
  const { db, admin } = await setup();
  await enqueue(db, OWNER_A, "gen-missing", "settle");
  await enqueue(db, OWNER_A, "gen-missing-refund", "refund");
  assert.deepEqual(await ledger.reconcilePendingCreditTransactions(admin), { checked: 2, resolved: 0, pending: 2 });
  for (const [gen, action] of [["gen-missing", "settle"], ["gen-missing-refund", "refund"]]) {
    const t = await task(db, gen, action);
    assert.equal(t.status, "pending", `${action}: an orphan is never silently closed`);
    assert.equal(t.last_error_code, "ledger_entry_missing");
    assert.equal(t.attempt_count, 1);
    assert.ok(Number(t.due_in_min) > 1.5, "retried with backoff, not in a hot loop");
  }
  assert.deepEqual(await ledgerStatus(db, "gen-missing"), [], "no ledger row is invented");
});

test("ledger already in the target state resolves; a conflicting state is flagged, never forced", async () => {
  const { db, admin } = await setup();
  await reserve(db, OWNER_A, "gen-already");
  await ledger.settleCredits(admin, OWNER_A, "gen-already");
  await enqueue(db, OWNER_A, "gen-already", "settle");
  await reserve(db, OWNER_A, "gen-conflict");
  await ledger.refundCredits(admin, OWNER_A, "gen-conflict");
  await enqueue(db, OWNER_A, "gen-conflict", "settle");
  assert.deepEqual(await ledger.reconcilePendingCreditTransactions(admin), { checked: 2, resolved: 1, pending: 1 });
  const done = await task(db, "gen-already", "settle");
  assert.equal(done.status, "resolved", "an already-settled entry is a successful no-op");
  assert.equal(done.last_error_code, null);
  const conflict = await task(db, "gen-conflict", "settle");
  assert.equal(conflict.status, "pending");
  assert.equal(conflict.last_error_code, "ledger_state_conflict");
  assert.deepEqual(await ledgerStatus(db, "gen-conflict"), [{ status: "refunded", credits: 40 }], "a refunded entry is never settled");
});

test("owner scoping: a task for another owner's generation cannot settle it", async () => {
  const { db, admin } = await setup();
  await reserve(db, OWNER_A, "gen-owned-by-a");
  await enqueue(db, OWNER_B, "gen-owned-by-a", "settle");
  await ledger.reconcilePendingCreditTransactions(admin);
  assert.deepEqual(await ledgerStatus(db, "gen-owned-by-a"), [{ status: "reserved", credits: 40 }]);
  const t = await task(db, "gen-owned-by-a", "settle");
  assert.equal(t.status, "pending");
  assert.equal(t.last_error_code, "ledger_entry_missing");
});

test("only due, pending tasks are processed, oldest first, bounded by the limit", async () => {
  const { db, admin } = await setup();
  for (const gen of ["gen-1", "gen-2", "gen-3"]) {
    await reserve(db, OWNER_A, gen, "image", 5);
    await enqueue(db, OWNER_A, gen, "settle");
  }
  await reserve(db, OWNER_A, "gen-future", "image", 5);
  await enqueue(db, OWNER_A, "gen-future", "settle", 60);
  await db.query("update public.credit_reconciliation_tasks set status = 'resolved' where generation_id = 'gen-3'");
  assert.deepEqual(await ledger.reconcilePendingCreditTransactions(admin, 1), { checked: 1, resolved: 1, pending: 0 });
  assert.equal((await task(db, "gen-1", "settle")).status, "resolved", "oldest first");
  assert.equal((await task(db, "gen-2", "settle")).status, "pending");
  assert.deepEqual(await ledgerStatus(db, "gen-3"), [{ status: "reserved", credits: 5 }], "a resolved task is not re-run");
  assert.equal((await task(db, "gen-future", "settle")).status, "pending", "not due yet");
});
