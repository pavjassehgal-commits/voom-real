import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("MARA chat is preserved but removed from navigation and redirected", async () => {
  const [nav, route, legacy] = await Promise.all([read("components/voom/shell/nav.ts"), read("app/app/(shell)/mara/page.tsx"), read("components/voom/mara/LegacyMaraChat.tsx")]);
  assert.doesNotMatch(nav, /n: "MARA"/);
  assert.match(route, /redirect\("\/app\/today"\)/);
  assert.match(legacy, /LegacyMaraChat/);
  assert.match(legacy, /fetch\("\/api\/mara"/);
  assert.match(legacy, /pendingActions/);
});

test("marketing plans are owner-scoped, anonymous-blocked, and server-written", async () => {
  const migration = await read("supabase/migrations/0009_marketing_plans.sql");
  assert.match(migration, /^begin;/m); assert.match(migration, /^commit;/m);
  assert.match(migration, /alter table public\.marketing_plans enable row level security/);
  assert.match(migration, /revoke all on table public\.marketing_plans from anon, authenticated/);
  assert.match(migration, /grant select on table public\.marketing_plans to authenticated/);
  assert.match(migration, /grant select, insert, update on table public\.marketing_plans to service_role/);
  assert.match(migration, /auth\.uid\(\)\) = owner_user_id/);
  assert.doesNotMatch(migration, /grant .*insert.*authenticated/);
});

test("planning is server-only, structured, grounded, and never creates chat messages", async () => {
  const [service, route] = await Promise.all([read("lib/mara/planning.ts"), read("app/api/plan/route.ts")]);
  assert.match(service, /import "server-only"/);
  assert.match(service, /provider\.structured/);
  for (const source of ["getBrandProfile", "listCalendarItems", "listCampaigns", "getInstagramConnection", "instagram_insight_snapshots"]) assert.match(service, new RegExp(source));
  assert.doesNotMatch(service + route, /from\("mara_messages"\).*insert/s);
  assert.match(route, /getCurrentUser/);
  assert.match(route, /owner_user_id: user\.id/);
});

test("automation modes preserve confirmation safety", async () => {
  const [route, page] = await Promise.all([read("app/api/automation-mode/route.ts"), read("app/app/(shell)/automations/page.tsx")]);
  for (const mode of ["manual", "assisted", "autopilot"]) assert.match(route, new RegExp(`"${mode}"`));
  assert.match(page, /No mode can publish externally, send a campaign, delete content, or spend advertising money/);
  assert.match(route, /externalActionsRequirePermission: true/);
});
