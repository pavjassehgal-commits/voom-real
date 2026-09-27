// Migration 0050: authenticated users can read their approval state but can
// no longer write it directly through the Supabase REST API. Every write path
// runs server-side on the owner-filtered service-role client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const TABLES = ["voom_campaigns", "mara_pending_actions", "mara_tool_runs", "mara_drafts", "content_calendar_items"];

test("0050 leaves authenticated with SELECT only on approval-state tables", async () => {
  const { db } = await createSupabaseLite();
  for (const table of TABLES) {
    const { rows } = await db.query(
      `select has_table_privilege('authenticated', $1, 'SELECT') as sel,
              has_table_privilege('authenticated', $1, 'INSERT') as ins,
              has_table_privilege('authenticated', $1, 'UPDATE') as upd,
              has_table_privilege('authenticated', $1, 'DELETE') as del,
              has_table_privilege('service_role', $1, 'UPDATE') as svc_upd`,
      [`public.${table}`],
    );
    assert.deepEqual(rows[0], { sel: true, ins: false, upd: false, del: false, svc_upd: true }, table);
  }
});

test("0050 keeps the approval-card editor callable and pins search paths", async () => {
  const { db } = await createSupabaseLite();
  const { rows } = await db.query(
    `select p.proname, p.prosecdef, p.proconfig
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('edit_mara_calendar_approval', 'protect_business_plan')
      order by p.proname`,
  );
  const byName = Object.fromEntries(rows.map((row) => [row.proname, row]));
  assert.equal(byName.edit_mara_calendar_approval.prosecdef, true);
  assert.ok(byName.edit_mara_calendar_approval.proconfig.some((c) => c.startsWith("search_path=")));
  assert.ok(byName.protect_business_plan.proconfig.some((c) => c.startsWith("search_path=")));
  const { rows: exec } = await db.query(
    `select has_function_privilege('authenticated', 'public.edit_mara_calendar_approval(uuid, text, timestamptz)', 'EXECUTE') as ok`,
  );
  assert.equal(exec[0].ok, true);
});

test("API write paths to approval-state tables use the service-role client", () => {
  const files = [
    "app/api/mara/actions/[id]/route.ts",
    "app/api/mara/drafts/[id]/route.ts",
  ];
  const reels = readFileSync(new URL("../app/api/reels/produce/[actionId]/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(reels, /createClient\(\)/);
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\b(db|supabase)\s*\.from\("(mara_pending_actions|mara_tool_runs|mara_drafts)"\)\s*\.update\(/, file);
  }
  const campaigns = readFileSync(new URL("../app/api/voom/campaigns/[id]/route.ts", import.meta.url), "utf8");
  assert.match(campaigns, /updateCampaign\(createAdminClient\(\)/);
  assert.match(campaigns, /approveCampaign\(createAdminClient\(\)/);
});

test("every cron worker uses the constant-time Bearer check", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = new URL("../app/api/cron/", import.meta.url);
  for (const name of readdirSync(dir)) {
    const source = readFileSync(new URL(`${name}/route.ts`, dir), "utf8");
    assert.match(source, /bearerMatches\(request, secret\)/, name);
    assert.doesNotMatch(source, /headers\.get\("authorization"\)/, name);
  }
});

test("0051 rate limiter allows up to the limit, then refuses, per owner and bucket", async () => {
  const { db } = await createSupabaseLite();
  const owner = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";
  await db.query("insert into auth.users (id) values ($1), ($2) on conflict do nothing", [owner, other]);
  const call = async (id, bucket) => (await db.query("select public.consume_rate_limit($1, $2, 3, 600) as ok", [id, bucket])).rows[0].ok;
  assert.deepEqual([await call(owner, "a"), await call(owner, "a"), await call(owner, "a"), await call(owner, "a")], [true, true, true, false]);
  assert.equal(await call(owner, "b"), true, "buckets are independent");
  assert.equal(await call(other, "a"), true, "owners are independent");
  const { rows } = await db.query("select has_function_privilege('authenticated', 'public.consume_rate_limit(uuid, text, integer, integer)', 'EXECUTE') as ok");
  assert.equal(rows[0].ok, false, "the browser cannot call the limiter");
});
