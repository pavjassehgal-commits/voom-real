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

  // No client component may reference AI credentials; the demo chat client
  // that once consumed this API was removed outright.
  const client = await read("app/app/(shell)/settings/page.tsx");
  assert.doesNotMatch(client, /AI_API_KEY|AI_BASE_URL/);
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

/**
 * The free-form MARA chat endpoint (POST /api/mara) was retired: it answers
 * 410 and does no work. MARA now runs through the Marketing Plan workflow
 * (lib/voom/workflow/service.ts), so the security properties that used to be
 * asserted on the chat route are asserted on that live path — and on the
 * stub, which must stay inert.
 */
test("the retired MARA chat endpoint is an inert 410 stub and nothing calls it", async () => {
  const route = await read("app/api/mara/route.ts");
  assert.match(route, /status: 410/);
  assert.match(route, /Use the Marketing Plan workflow/);
  assert.doesNotMatch(route, /^import /m, "the stub imports nothing: no auth, no database, no provider");
  assert.doesNotMatch(route, /createAiProvider|createAdminClient|createClient|fetch\(|process\.env|request\.json/);
  // No screen depends on the dead route.
  const { readdir } = await import("node:fs/promises");
  const uiFiles = (await readdir(new URL("../components/voom/", import.meta.url), { recursive: true })).filter((name) => name.endsWith(".tsx"));
  for (const name of uiFiles) {
    assert.doesNotMatch(await read(`components/voom/${name}`), /["'`]\/api\/mara["'`?]/, `${name} must not call the retired chat endpoint`);
  }
});

test("MARA prompt uses only the authenticated user's persisted brand records", async () => {
  const service = await read("lib/voom/workflow/service.ts");
  const prompt = await read("lib/voom/workflow/prompt.ts");
  // The business row is read for the owner only, then projected into the
  // prompt payload field by field — never a free-form record dump.
  assert.match(service, /from\("businesses"\)[\s\S]*?\.eq\("owner_user_id", input\.ownerId\)/);
  for (const field of ["brand_name", "brand_description", "industry", "target_customer", "main_goal", "brand_personality"]) {
    assert.match(service, new RegExp(`business\\.${field}`), `the prompt payload carries ${field} from the owner's persisted record`);
  }
  assert.match(prompt, /authenticated user's own business/);
  assert.match(prompt, /Ground everything ONLY in the supplied business context/);
  assert.doesNotMatch(prompt, /process\.env|fetch\(|supabase/i, "the prompt module is pure");
});

test("AI failures are friendly and provider secrets are never echoed", async () => {
  const service = await read("lib/voom/workflow/service.ts");
  // Content generation failures surface as fixed codes, never provider text.
  assert.match(service, /if \(reason instanceof AiError && reason\.code === "rate_limited"\) throw new Error\("content_rate_limited"\)/);
  assert.match(service, /throw new Error\("content_generation_failed"\)/);
  assert.doesNotMatch(service, /reason\.message|error\.message|AI_API_KEY|Authorization.*Bearer/);

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
  const actions = await read("app/api/mara/actions/[id]/route.ts");
  assert.match(tools, /satisfies Record<string, z\.ZodType>/);
  assert.doesNotMatch(tools, /user[_I]d:\s*z\./i);
  assert.match(tools, /owner_user_id: context\.ownerId/);
  assert.match(tools, /mara_tool_runs/);
  assert.match(tools, /idempotencyKey/);
  // With the chat loop retired, the ONLY remaining way a tool executes is the
  // owner's explicit confirmation of a pending action: authenticated, scoped
  // to the owner's own pending row, and never re-executed once handled.
  assert.match(actions, /getCurrentUser\(\)/);
  assert.match(actions, /executeConfirmedAction/);
  assert.match(actions, /\.eq\("owner_user_id", user\.id\)/);
  assert.match(tools, /if \(action\.status !== "executing"\) return \{ ok: true, summary: "This action was already handled\." \}/);
  assert.doesNotMatch(actions, /createAiProvider|selectRelevantTools|maraToolDefinitions/, "confirming an action never re-enters an AI tool loop");
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
  // Pending MARA actions are now surfaced on the Approvals board (the demo
  // chat client that also rendered them was removed).
  const board = await read("components/voom/operating/ApprovalsBoard.tsx");
  const actionRoute = await read("app/api/mara/actions/[id]/route.ts");
  assert.match(board, /failed \? "Retry" : "Confirm"/);
  assert.match(board, />Cancel</);
  assert.match(board, /voom:data-changed/);
  assert.match(board, /View in calendar|View calendar|detail\.href/);
  assert.match(actionRoute, /eq\("status", "pending"\)|in\("status", \["pending", "failed"\]\)/);
  assert.match(actionRoute, /mara_tool_runs/);
  const tools = await read("lib/mara/tools.ts");
  assert.match(tools, /eq\("status", "executing"\)\.select\("id"\)\.maybeSingle\(\)/);
});

test("content drafts render with persistent, explicit actions", async () => {
  // Drafts now live in the Create Content studio with an explicit editor.
  const studio = await read("app/app/(shell)/studio/page.tsx");
  const editor = await read("components/voom/modals/PostEditorModal.tsx");
  assert.match(studio, /PostEditorModal/);
  assert.match(editor, /"Save Draft"/);
  assert.match(editor, /"Approve"/);
  // The editor previews the concept as a heading inside the modal.
  assert.match(editor, /\{concept \|\| "Untitled"\}/);
  assert.match(editor, /Saved inside Voom only\. Nothing is published to Instagram\./);
});

test("incomplete content generation is validated against a schema and fails with a clear code", async () => {
  const service = await read("lib/voom/workflow/service.ts");
  const prompt = await read("lib/voom/workflow/prompt.ts");
  // Every planned piece is structured output parsed by the schema; an
  // incomplete or invalid answer cannot become a draft.
  assert.match(service, /jsonSchema: plannedContentJsonSchema/);
  assert.match(service, /parse: \(value\) => plannedContentSchema\.parse\(value\)/);
  assert.match(service, /throw new Error\("content_generation_failed"\)/);
  assert.match(prompt, /caption: the complete caption in the brand's voice/);
  assert.match(prompt, /Never invent prices, discounts, offers, opening hours, links, awards, reviews, guarantees or statistics/);
  // A failed slot is reported, never silently dropped or half-saved.
  const rolling = await read("lib/voom/workflow/rolling-plan.ts");
  assert.match(rolling, /result\.failures\.push\(\{ slot: slot\.date, stage: "content", code: codeOf\(reason\) \}\)/);
});

test("plan generation stays a draft; calendar mutations go through owner-scoped explicit actions", async () => {
  const service = await read("lib/voom/workflow/service.ts");
  const actions = await read("lib/voom/workflow/actions-server.ts");
  // The workflow writes drafts only — approval is a separate, explicit step.
  assert.match(service, /status: "draft"/);
  assert.match(service, /onConflict: "owner_user_id,source_plan_id,source_plan_item_key"/);
  // Calendar changes are owner-scoped server actions, never free-form chat.
  assert.match(actions, /^"use server";/m);
  assert.match(actions, /const user = await getCurrentUser\(\)/);
  assert.match(actions, /\.eq\("owner_user_id", ownerId\)\.eq\("id", draftId\)/, "a draft is loaded only when the caller owns it");
  assert.match(actions, /\.eq\("owner_user_id", ctx\.userId\)/);
  assert.doesNotMatch(actions, /createAiProvider|selectRelevantTools/, "calendar actions never route through an AI tool loop");
});

test("Asia/Dubai relative dates resolve deterministically", async () => {
  const { resolveRelativeDateTime } = await import("../lib/mara/relative-date.ts");
  assert.equal(resolveRelativeDateTime("Add an Instagram post next Tuesday at 10 AM.", undefined, new Date("2026-08-25T19:53:00.000Z")), "2026-09-01T06:00:00.000Z");
});
