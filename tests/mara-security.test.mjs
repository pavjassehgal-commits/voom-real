import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("AI credentials are server-only placeholders", async () => {
  const example = await read(".env.example");
  for (const name of ["AI_PROVIDER", "AI_API_KEY", "AI_BASE_URL", "AI_MODEL"]) {
    assert.match(example, new RegExp(`^${name}=$`, "m"));
  }
  assert.doesNotMatch(example, /NEXT_PUBLIC_AI_/);

  const client = await read("components/voom/mara/LegacyMaraChat.tsx");
  assert.doesNotMatch(client, /AI_API_KEY|AI_BASE_URL|process\.env/);
});

test("MARA storage isolates conversations, messages, and drafts by owner", async () => {
  const migration = await read("supabase/migrations/0002_mara_ai.sql");
  for (const table of ["mara_conversations", "mara_messages", "mara_drafts"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`public\\.${table}.*from anon`, "s"));
  }
  assert.ok((migration.match(/\(select auth\.uid\(\)\) = owner_user_id/g) ?? []).length >= 5);
  assert.match(migration, /foreign key \(conversation_id, owner_user_id\)/);
});

test("MARA prompt uses only the authenticated user's persisted brand records", async () => {
  const route = await read("app/api/mara/route.ts");
  const prompt = await read("lib/mara/prompt.ts");
  assert.match(route, /getCurrentUser\(\)/);
  assert.match(route, /getBusinessRecord\(\)/);
  assert.match(route, /getProfileRecord\(\)/);
  for (const field of ["display_name", "brand_name", "brand_description", "industry", "target_customer", "main_goal", "brand_personality", "preferred_channels", "content_frequency", "monthly_ad_budget", "automation_level", "publishing_permission"]) {
    assert.match(prompt, new RegExp(field));
  }
});

test("AI failures are friendly and provider secrets are never echoed", async () => {
  const route = await read("app/api/mara/route.ts");
  assert.match(route, /MARA couldn't answer just now/);
  assert.match(route, /MARA is busy right now/);
  assert.doesNotMatch(route, /AI_API_KEY|Authorization.*Bearer/);

  const provider = await read("lib/ai/openai-compatible.ts");
  assert.match(provider, /async complete/);
  assert.match(provider, /async \*stream/);
  assert.match(provider, /async structured/);
  assert.doesNotMatch(provider, /console\.(log|error)/);
});

test("structured JSON validation failures are retryable without exposing provider details", async () => {
  const provider = await read("lib/ai/openai-compatible.ts");
  assert.match(provider, /json && response\.status === 400/);
  assert.match(provider, /throw new AiError\("malformed_response"/);
  assert.doesNotMatch(provider, /console\.(log|error).*body/);
});

test("approval cannot publish content", async () => {
  const draftRoute = await read("app/api/mara/drafts/[id]/route.ts");
  const actions = await read("app/api/mara/actions/[id]/route.ts");
  const tools = await read("lib/mara/tools.ts");
  assert.match(draftRoute, /"approve_draft"/);
  assert.match(draftRoute, /Review and confirm the approval/);
  assert.match(actions, /in\("status", \["pending", "failed"\]\)/);
  assert.match(tools, /status: "approved"/);
  assert.doesNotMatch(draftRoute, /fetch\(|sendgrid|twilio|graph\.facebook|ads api/i);
});

test("MARA internal tools are allowlisted, owner-derived, validated, bounded, and audited", async () => {
  const tools = await read("lib/mara/tools.ts");
  const route = await read("app/api/mara/route.ts");
  assert.match(tools, /satisfies Record<string, z\.ZodType>/);
  assert.doesNotMatch(tools, /user[_I]d:\s*z\./i);
  assert.match(tools, /owner_user_id: context\.ownerId/);
  assert.match(tools, /mara_tool_runs/);
  assert.match(tools, /idempotencyKey/);
  assert.match(route, /iteration < 4/);
  assert.match(route, /> 8/);
  assert.match(route, /selectRelevantTools/);
  assert.match(route, /maraToolDefinitions\.filter/);
});

test("internal records use owner RLS and least privilege", async () => {
  const migration = await read("supabase/migrations/0003_mara_internal_tools.sql");
  for (const table of ["content_calendar_items", "voom_campaigns", "mara_pending_actions", "mara_tool_runs"]) assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  assert.match(migration, /revoke all on table[\s\S]*from anon, authenticated/);
  assert.match(migration, /auth\.uid\(\)\) = owner_user_id/g);
  assert.doesNotMatch(migration, /grant all/i);
});

test("external execution is unavailable to the tool registry", async () => {
  const tools = await read("lib/mara/tools.ts");
  assert.doesNotMatch(tools, /publish_instagram|send_email|send_sms|spend_ad|launch_ad/);
  assert.match(tools, /publishingAvailable: false/);
  assert.match(tools, /sendingAvailable: false/);
  assert.match(tools, /adSpendAvailable: false/);
});

test("the allowlist contains every approved Voom tool and no execution tools", async () => {
  const tools = await read("lib/mara/tools.ts");
  const approved = [
    "get_brand_profile", "list_content_calendar", "get_calendar_item", "list_drafts", "get_draft",
    "list_campaigns", "get_campaign", "get_connected_channels", "get_instagram_connection_status",
    "get_subscription_and_feature_limits", "create_content_draft", "update_content_draft", "approve_draft",
    "reject_draft", "propose_calendar_item", "update_calendar_item", "delete_calendar_item",
    "create_campaign_draft", "update_campaign_draft",
  ];
  for (const name of approved) assert.match(tools, new RegExp(`\\b${name}:`));
  assert.doesNotMatch(tools, /publish_content:|send_campaign:|spend_budget:/);
});

test("pending action cards persist, confirm or cancel explicitly, and refresh product data", async () => {
  const client = await read("components/voom/mara/LegacyMaraChat.tsx");
  const actionRoute = await read("app/api/mara/actions/[id]/route.ts");
  assert.match(client, /data-mara-pending-action/);
  assert.match(client, /failed \? "Retry" : "Confirm"/);
  assert.match(client, />Cancel</);
  assert.match(client, /voom:data-changed/);
  assert.match(client, /View in calendar/);
  assert.match(client, /View campaign/);
  assert.match(actionRoute, /eq\("status", "pending"\)|in\("status", \["pending", "failed"\]\)/);
  assert.match(actionRoute, /mara_tool_runs/);
  const tools = await read("lib/mara/tools.ts");
  assert.match(tools, /eq\("status", "executing"\)\.select\("id"\)\.maybeSingle\(\)/);
});

test("content drafts render inline with persistent actions", async () => {
  const client = await read("components/voom/mara/LegacyMaraChat.tsx");
  assert.match(client, /item\.message_id === message\.id/);
  assert.match(client, /<DraftCard draft=\{item\} inline/);
  for (const action of ["Copy", "Edit", "Regenerate", "Approve", "Reject"]) {
    assert.match(client, new RegExp(`>${action}<`));
  }
  assert.match(client, /whitespace-pre-wrap/);
  assert.match(client, /Nothing is published, sent, or funded/);
});

test("incomplete content generation retries once before returning a clear error", async () => {
  const route = await read("app/api/mara/route.ts");
  const prompt = await read("lib/mara/prompt.ts");
  assert.match(route, /generateMaraResult/);
  assert.match(route, /previous output was incomplete or invalid/i);
  assert.match(route, /couldn't generate the complete deliverable/);
  assert.match(prompt, /exactly seven named days/);
  for (const requirement of ["full caption", "scene-by-scene", "preview text", "complete send-ready message", "objective, audience, channels"]) {
    assert.match(prompt, new RegExp(requirement));
  }
});

test("calendar reads and mutations route to tools while weekly-plan generation stays a draft", async () => {
  const route = await read("app/api/mara/route.ts");
  assert.match(route, /readsCalendar \|\| changesVoom/);
  assert.match(route, /what\(\?:'s\| is\)\?/);
  assert.match(route, /add\|schedule\|reschedule\|move\|delete\|remove/);
  assert.match(route, /if \(expectedKind/);
});

test("Asia/Dubai relative dates resolve deterministically", async () => {
  const { resolveRelativeDateTime } = await import("../lib/mara/relative-date.ts");
  assert.equal(resolveRelativeDateTime("Add an Instagram post next Tuesday at 10 AM.", undefined, new Date("2026-08-25T19:53:00.000Z")), "2026-09-01T06:00:00.000Z");
});
