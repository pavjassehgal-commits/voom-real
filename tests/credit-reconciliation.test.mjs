import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const ledger = await import("../lib/billing/ledger.ts");

function fakeAdmin({ rpcFailures = 0, tasks = [] } = {}) {
  let failures = rpcFailures;
  const writes = [];
  class Query {
    constructor(table) { this.table = table; this.patch = null; }
    select() { return this; }
    eq() { return this; }
    lte() { return this; }
    order() { return this; }
    limit() { return this; }
    update(patch) { this.patch = patch; writes.push({ table: this.table, kind: "update", patch }); return this; }
    upsert(row) { writes.push({ table: this.table, kind: "upsert", row }); return Promise.resolve({ data: row, error: null }); }
    then(resolve, reject) { return Promise.resolve({ data: this.table === "credit_reconciliation_tasks" && !this.patch ? tasks : [], error: null }).then(resolve, reject); }
  }
  return {
    writes,
    rpc: async (name) => {
      if (failures-- > 0) return { data: null, error: { code: "TEMPORARY" } };
      return { data: name === "settle_media_credits" ? { settled: true } : { refunded: true }, error: null };
    },
    from: (table) => new Query(table),
  };
}

test("failed settlement is durably queued instead of silently ignored", async () => {
  const admin = fakeAdmin({ rpcFailures: 1 });
  assert.deepEqual(await ledger.settleCredits(admin, "owner-1", "generation-1"), { ok: false, settled: false });
  const task = admin.writes.find((write) => write.kind === "upsert");
  assert.equal(task.table, "credit_reconciliation_tasks");
  assert.equal(task.row.action, "settle");
  assert.equal(task.row.status, "pending");
  assert.equal(task.row.last_error_code, "TEMPORARY");
});

test("failed refund is durably queued", async () => {
  const admin = fakeAdmin({ rpcFailures: 1 });
  assert.deepEqual(await ledger.refundCredits(admin, "owner-1", "generation-2"), { ok: false, refunded: false });
  assert.equal(admin.writes.find((write) => write.kind === "upsert").row.action, "refund");
});

test("reconciliation retries an idempotent ledger action and resolves the task", async () => {
  const admin = fakeAdmin({ tasks: [{ id: "task-1", owner_user_id: "owner-1", generation_id: "generation-1", action: "settle", attempt_count: 1 }] });
  assert.deepEqual(await ledger.reconcilePendingCreditTransactions(admin), { checked: 1, resolved: 1, pending: 0 });
  const update = admin.writes.find((write) => write.kind === "update");
  assert.equal(update.patch.status, "resolved");
  assert.equal(update.patch.attempt_count, 2);
});
