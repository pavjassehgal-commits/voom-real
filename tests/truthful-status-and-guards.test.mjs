/**
 * Three truthfulness fixes (2026-10-17), one test each. Every test failed
 * before its fix and passes after it:
 *
 *   A. The Connections page shows Instagram's REAL connection status.
 *   B. "Generate" refuses the Free plan BEFORE any AI call, and a refused or
 *      failed generation leaves the draft untouched and says why.
 *   C. "Build plan" with no social channel selected tells the owner the real
 *      reason and the next step instead of showing nothing.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importApp, react, renderToStaticMarkup } from "./helpers/rendered-surface.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (relative) => readFile(path.join(ROOT, relative), "utf8");

/* ── A ──────────────────────────────────────────────────────── */
test("A. the Connections page shows Instagram's real connection status, never an assumed one", async () => {
  const source = await read("app/app/(shell)/connections/page.tsx");
  const instagramCard = source.slice(source.indexOf('name="Instagram"'), source.indexOf('name="TikTok"'));
  assert.ok(instagramCard.length > 0, "the Instagram card exists");
  // The redesigned Channels page (merged 2026-11-01) derives the card's status from
  // `instagramConnected`, itself read from the real connection row.
  assert.match(instagramCard, /instagramConnected\s*\?/, "the Instagram card must derive its status from the real connected value");
  assert.match(source, /const instagramConnected = Boolean\(instagram\?\.connected\)/, "connected means the row says so");
  assert.match(source, /getInstagramConnection\(/, "the status must be read from the stored Instagram connection row");
  assert.doesNotMatch(source, /connected = true/, "no connection card may default to Connected");
});

/* ── B ──────────────────────────────────────────────────────── */
const doublesUrl = pathToFileURL(path.join(ROOT, "tests/helpers/generate-route-doubles.mjs")).href;
const DOUBLED = new Set([
  "@/lib/ai",
  "@/lib/media",
  "@/lib/media/media-inspect",
  "@/lib/media/image-overlay",
  "@/lib/voom/server-data",
  "@/lib/post/server-data",
  "@/lib/mara/video-service",
  "@/lib/mara/media-spend",
  "@/lib/rate-limit",
  "@/utils/supabase/admin",
]);
// Registered after the rendered-surface hooks, so it runs first. It doubles
// exactly these specifiers and ONLY when the generate route itself imports
// them; everything else (the route, plan rules, credit guard, prompt builders,
// and every other test's imports) is the real TypeScript.
registerHooks({
  resolve(specifier, context, nextResolve) {
    // The parent URL percent-encodes the `[id]` folder, hence the decode.
    if (DOUBLED.has(specifier) && decodeURIComponent(context.parentURL ?? "").endsWith("/app/api/posts/[id]/generate/route.ts")) {
      return { url: doublesUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

test("B. Generate refuses the Free plan before any AI call, and a refused or failed generation leaves the draft untouched", async () => {
  const doubles = await import(doublesUrl);
  const route = await importApp("app/api/posts/[id]/generate/route.ts");
  const call = () => route.POST(
    new Request("http://voom.test/api/posts/x/generate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    { params: Promise.resolve({ id: doubles.POST_ID }) },
  );

  // Refused: Free plan.
  doubles.reset({ plan: "free" });
  let response = await call();
  let body = await response.json();
  assert.equal(response.status, 402, `Free plan is refused (got ${response.status}: ${JSON.stringify(body)})`);
  assert.equal(body.upgradeRequired, true);
  assert.match(body.error, /plan/i, "the refusal says why");
  assert.equal(doubles.state.aiCalls, 0, "no AI call may happen before the plan check");
  assert.equal(doubles.state.imageCalls, 0, "no image call may happen for a refused plan");
  assert.deepEqual(doubles.draftCopyWrites(), [], "a refused generation must not change the draft's title or caption");

  // Failed: Pro plan, the image provider fails after the copy was written.
  doubles.reset({ plan: "pro", imageFails: true });
  response = await call();
  body = await response.json();
  assert.equal(response.status, 503, "a failed visual is reported as a failure");
  assert.match(body.error, /could not be generated|couldn't/i, "the failure says why");
  assert.doesNotMatch(body.error, /saved the copy/i, "the message must not claim the copy was saved");
  assert.equal(doubles.state.aiCalls, 1, "the copy step ran once");
  assert.deepEqual(doubles.draftCopyWrites(), [], "a failed generation must leave the draft untouched");
  assert.ok(doubles.state.rpcCalls.includes("refund_media_credits"), "the reserved credits are refunded");

  // Success: Pro plan, image generated — the new copy is saved exactly once.
  doubles.reset({ plan: "pro" });
  response = await call();
  body = await response.json();
  assert.equal(response.status, 200, `a successful generation returns 200 (got ${response.status}: ${JSON.stringify(body)})`);
  assert.equal(doubles.state.assetPuts, 1, "the visual was stored");
  const writes = doubles.draftCopyWrites();
  assert.equal(writes.length, 1, "the draft copy is saved once, after the visual exists");
  assert.equal(writes[0].patch.title, "Fresh concept");
  assert.match(writes[0].patch.content, /New caption/);
  assert.ok(doubles.state.rpcCalls.includes("settle_media_credits"), "the reservation is settled on success");
});

/* ── C ──────────────────────────────────────────────────────── */
test("C. Build plan with no social channel selected tells the owner the real reason and the next step", async () => {
  const plan = await importApp("components/voom/operating/PlanWorkspace.tsx");
  assert.equal(typeof plan.PlanOutcomeNotice, "function", "the outcome notice is exported so it can be rendered on its own");
  const outcome = { state: "no_supported_social_channels_selected", added: 0, horizonStart: null, horizonEnd: null, addedChannelFormats: [] };
  const readiness = [{ channel: "instagram", connected: false, configured: true }];
  const html = renderToStaticMarkup(react.createElement(plan.PlanOutcomeNotice, { outcome, error: "", readiness }));
  assert.ok(html.length > 0, "the no-channel outcome must render something");
  assert.match(html, /no social channel/i, "it states the real reason");
  assert.match(html, /\/app\/settings/, "it links to where channels are chosen");
  assert.match(html, /Connect Instagram first/, "it names the next step for the channel that is not connected");
});
