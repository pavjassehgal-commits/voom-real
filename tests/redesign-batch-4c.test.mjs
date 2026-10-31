import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
// What a screen shows or does, without the comments that explain what it leaves out.
const code = async (path) => (await read(path)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

test("Channels reads every real connection, including manual LinkedIn text publishing", async () => {
  const page = await code("app/app/(shell)/connections/page.tsx");
  for (const reader of ["getInstagramConnection", "getTikTokConnection", "getYouTubeConnection", "getLinkedInConnection", "getResendAvailability"]) assert.match(page, new RegExp(reader));
  assert.match(page, /scopes\.includes\("video\.publish"\)/, "TikTok counts as connected only with the granted publish scope");
  assert.match(page, /scopes\.includes\(YOUTUBE_UPLOAD_SCOPE\)/, "YouTube counts as connected only with the granted upload scope");
  for (const href of ["/app/instagram", "/app/tiktok", "/app/youtube", "/app/linkedin", "/app/settings#email"]) assert.match(page, new RegExp(`"${href}"`), `account actions go to ${href}`);
  assert.match(page, /Personal profile · text posts/);
  assert.match(page, /explicit review and approval/);
  assert.doesNotMatch(page, /Facebook|Pinterest|WhatsApp|Threads|Google Business|Notify me|Connect X/, "no unsupported channel or dead control");
  assert.doesNotMatch(page, /\.(insert|update|upsert|delete)\(/, "the page only reads");
});

test("Performance shows only provider-returned numbers and keeps unavailable channels honest", async () => {
  const view = await code("components/voom/performance/PerformanceView.tsx");
  assert.match(view, /filter\(\(value\): value is number => typeof value === "number"\)/, "totals add only values a provider returned");
  assert.match(view, /Not reported for this window/, "a metric nobody returned is said to be missing, not zero");
  assert.match(view, /TikTok performance data is unavailable/);
  assert.match(view, /official YouTube Data API/);
  assert.doesNotMatch(view, /Export report|Compare to previous period|All formats|Facebook|LinkedIn|vs previous 30 days/, "no unbacked filter, export, comparison or channel");
  assert.doesNotMatch(view, /score/i, "never a performance score");
  assert.doesNotMatch(view, /"use client"/, "the page stays a server render");
});

test("Settings keeps every real save path and shows no control without a backend", async () => {
  const page = await code("app/app/(shell)/settings/page.tsx");
  for (const action of ["saveBrandSettings", "saveMediaSpend", "restartOnboarding", "setTheme", "toggleTone", "logoutAction"]) assert.match(page, new RegExp(action), `${action} is wired`);
  assert.match(page, /\/api\/billing\/summary/, "credits come from the real ledger summary");
  assert.match(page, /<EmailIdentityCard \/>/, "the email identity editor is kept");
  assert.match(page, /preferredChannels: channels/, "channel choices save through the existing profile payload");
  assert.doesNotMatch(page, /visual-only|disabled in this prototype/i, "the old dead toasts are gone");
  assert.doesNotMatch(page, /Buy credits|Add card|Change logo|Team & permissions|Export your data|Change password|Ask MARA/i, "no unbacked control");
  assert.doesNotMatch(page, /stripe|checkout|card number/i, "no payment collection");
});
