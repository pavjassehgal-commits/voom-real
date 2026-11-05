import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const { OpenAiCompatibleProvider } = await import("../lib/ai/openai-compatible.ts");
const { estimateTextCostUsd, AI_PRICING_VERSION } = await import("../lib/ai/pricing.ts");
const credits = await import("../lib/billing/credits.ts");

const config = {
  provider: "openrouter",
  apiKey: "test-only",
  baseUrl: "https://provider.invalid/v1",
  model: "openai/gpt-oss-20b",
  requestTimeoutMs: 1000,
};

const usage = {
  ownerId: "00000000-0000-4000-8000-000000000001",
  businessId: "00000000-0000-4000-8000-000000000002",
  operationKey: "test:caption:1",
  operationType: "caption_generation",
  category: "caption",
};

test("records provider token usage and keeps observed cost distinct from estimates", async () => {
  const attempts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    id: "provider-request-1",
    choices: [{ message: { content: "caption" } }],
    usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, cost: 0.0002 },
  });
  try {
    const provider = new OpenAiCompatibleProvider(config, async (attempt) => attempts.push(attempt));
    assert.equal(await provider.complete({ messages: [{ role: "user", content: "test" }], usage }), "caption");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].inputTokens, 1000);
  assert.equal(attempts[0].outputTokens, 500);
  assert.equal(attempts[0].observedCostUsd, 0.0002);
  assert.equal(attempts[0].confirmedProviderChargeUsd, null);
  assert.equal(attempts[0].pricingVersion, AI_PRICING_VERSION);
});

test("records every provider retry as its own attempt", async () => {
  const attempts = [];
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) return new Response("provider failed", { status: 500 });
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
  };
  try {
    const provider = new OpenAiCompatibleProvider(config, async (attempt) => attempts.push(attempt));
    const result = await provider.structured({
      messages: [{ role: "user", content: "test" }],
      usage: { ...usage, operationKey: "test:retry:1" },
      jsonSchema: { name: "test", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } },
      parse(value) { return value; },
    });
    assert.deepEqual(result, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((entry) => [entry.attemptNumber, entry.status]), [[1, "failed"], [2, "succeeded"]]);
});

test("missing provider usage remains unknown rather than fabricated", async () => {
  const attempts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: "caption" } }] });
  try {
    const provider = new OpenAiCompatibleProvider(config, async (attempt) => attempts.push(attempt));
    await provider.complete({ messages: [{ role: "user", content: "test" }], usage });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(attempts[0].inputTokens, null);
  assert.equal(attempts[0].estimatedCostUsd, null);
  assert.equal(attempts[0].observedCostUsd, null);
});

test("pricing is versioned and existing media credit prices remain unchanged", () => {
  assert.deepEqual(estimateTextCostUsd({ provider: "openrouter", model: "openai/gpt-oss-20b", inputTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 0 }), {
    costUsd: 0.17,
    pricingVersion: AI_PRICING_VERSION,
  });
  assert.equal(credits.creditCostForMedia({ mediaType: "image" }), 5);
  assert.equal(credits.creditCostForMedia({ mediaType: "video" }), 40);
});

test("migration enforces owner isolation, server-only writes, attempt idempotency, and business ownership", async () => {
  const sql = await readFile(new URL("../supabase/migrations/0061_ai_usage_cost_tracking.sql", import.meta.url), "utf8");
  assert.match(sql, /unique \(operation_id, attempt_number\)/i);
  assert.match(sql, /unique \(owner_user_id, operation_key\)/i);
  assert.match(sql, /auth\.uid\(\) = owner_user_id/i);
  assert.match(sql, /business_owner_mismatch/i);
  assert.match(sql, /revoke all on public\.ai_usage_operations, public\.ai_provider_attempts, public\.credit_reconciliation_tasks from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.record_ai_usage_attempt[\s\S]+to service_role/i);
});

test("0061 applies to a fresh database without changing existing credit ledger rows", async () => {
  const ownerId = "10000000-0000-4000-8000-000000000001";
  const { db, applied, applyPending } = await createSupabaseLite({
    stopBefore: "0061_ai_usage_cost_tracking.sql",
  });

  try {
    await db.exec(`
      insert into auth.users (id, email)
      values ('${ownerId}', 'credit-preservation@example.invalid');

      insert into public.voom_credit_ledger
        (owner_user_id, generation_id, media_type, credits, source, status)
      values
        ('${ownerId}', 'existing-image-generation', 'image', 5, 'user_request', 'settled'),
        ('${ownerId}', 'existing-video-generation', 'video', 40, 'user_request', 'reserved');
    `);

    const before = await db.query(`
      select generation_id, media_type, credits, source, status
      from public.voom_credit_ledger
      where owner_user_id = $1
      order by generation_id
    `, [ownerId]);

    await applyPending();

    assert.ok(applied.includes("0061_ai_usage_cost_tracking.sql"));
    // 0062 follows 0061 directly; the newest file is Brand Kit v2 (0075, merged 2026-11-01).
    assert.equal(applied[applied.indexOf("0061_ai_usage_cost_tracking.sql") + 1], "0062_linkedin_personal.sql");
    assert.equal(applied.at(-1), "0075_brand_kits.sql");
    const after = await db.query(`
      select generation_id, media_type, credits, source, status
      from public.voom_credit_ledger
      where owner_user_id = $1
      order by generation_id
    `, [ownerId]);
    assert.deepEqual(after.rows, before.rows);

    const created = await db.query(`
      select tablename, rowsecurity
      from pg_tables
      where schemaname = 'public'
        and tablename in ('ai_usage_operations', 'ai_provider_attempts', 'credit_reconciliation_tasks')
      order by tablename
    `);
    assert.deepEqual(created.rows, [
      { tablename: "ai_provider_attempts", rowsecurity: true },
      { tablename: "ai_usage_operations", rowsecurity: true },
      { tablename: "credit_reconciliation_tasks", rowsecurity: true },
    ]);
  } finally {
    await db.close();
  }
});

test("0061 rollback refuses accounting data, removes only 0061 objects, and permits reapplication", async () => {
  const ownerId = "20000000-0000-4000-8000-000000000001";
  const rollbackSql = await readFile(new URL("../supabase/proposed/0061_ai_usage_cost_tracking.rollback.sql", import.meta.url), "utf8");
  const migrationSql = await readFile(new URL("../supabase/migrations/0061_ai_usage_cost_tracking.sql", import.meta.url), "utf8");
  const { db } = await createSupabaseLite();

  try {
    await db.exec(`
      create table public.rollback_sentinel (id integer primary key);
      insert into public.rollback_sentinel values (1);
      insert into auth.users (id, email) values ('${ownerId}', 'rollback-guard@example.invalid');
      insert into public.voom_credit_ledger
        (owner_user_id, generation_id, media_type, credits, source, status)
      values ('${ownerId}', 'rollback-preserved-credit', 'image', 5, 'user_request', 'settled');
      insert into public.ai_usage_operations
        (owner_user_id, operation_key, operation_type, category, provider, model, status)
      values ('${ownerId}', 'rollback-guard', 'caption_generation', 'caption', 'test', 'test', 'succeeded');
    `);

    await assert.rejects(db.exec(rollbackSql), /rollback refused: AI usage or reconciliation records exist/);
    await db.exec("rollback");
    assert.equal((await db.query("select count(*)::int as n from public.ai_usage_operations")).rows[0].n, 1);

    await db.exec("delete from public.ai_usage_operations");
    await db.exec(`
      insert into public.credit_reconciliation_tasks
        (owner_user_id, generation_id, action)
      values ('${ownerId}', 'rollback-guard-reconciliation', 'refund');
    `);
    await assert.rejects(db.exec(rollbackSql), /rollback refused: AI usage or reconciliation records exist/);
    await db.exec("rollback");
    await db.exec("delete from public.credit_reconciliation_tasks");
    await db.exec(rollbackSql);

    assert.equal((await db.query("select to_regclass('public.ai_usage_operations') is null as absent")).rows[0].absent, true);
    assert.equal((await db.query("select to_regclass('public.ai_provider_attempts') is null as absent")).rows[0].absent, true);
    assert.equal((await db.query("select to_regclass('public.credit_reconciliation_tasks') is null as absent")).rows[0].absent, true);
    assert.equal((await db.query("select count(*)::int as n from public.rollback_sentinel")).rows[0].n, 1);
    assert.equal((await db.query("select count(*)::int as n from public.voom_credit_ledger where generation_id = 'rollback-preserved-credit'")).rows[0].n, 1);

    await db.exec(migrationSql);
    assert.equal((await db.query("select to_regclass('public.ai_usage_operations') is not null as present")).rows[0].present, true);
    assert.equal((await db.query("select count(*)::int as n from public.voom_credit_ledger where generation_id = 'rollback-preserved-credit'")).rows[0].n, 1);
  } finally {
    await db.close();
  }
});
