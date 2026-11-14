/**
 * Test doubles for `app/api/posts/[id]/generate/route.ts`.
 *
 * One module stands in for every I/O-bound import of the route (AI provider,
 * image provider, Supabase admin client, logged-in user, Post Studio data,
 * rate limit). The route, the plan rules and the credit entitlement guard
 * stay REAL, so the test proves the route's actual ordering: no AI call and no
 * draft write may happen before the plan/credit check, and a refused or failed
 * generation leaves the draft untouched.
 *
 * Mapped onto the route's `@/…` specifiers by a module hook in the test file.
 */

export const POST_ID = "11111111-1111-4111-8111-111111111111";

export const state = {
  plan: "free",
  imageFails: false,
  aiCalls: 0,
  imageCalls: 0,
  assetPuts: 0,
  updates: [],
  inserts: [],
  rpcCalls: [],
};

export function reset(overrides = {}) {
  state.plan = "free";
  state.imageFails = false;
  state.aiCalls = 0;
  state.imageCalls = 0;
  state.assetPuts = 0;
  state.updates = [];
  state.inserts = [];
  state.rpcCalls = [];
  Object.assign(state, overrides);
}

/** Writes that change what the owner sees in the draft (title / caption). */
export function draftCopyWrites() {
  return state.updates.filter((entry) => entry.table === "mara_drafts" && ("title" in entry.patch || "content" in entry.patch));
}

/* ── @/lib/ai ───────────────────────────────────────────────── */
export class AiError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function createAiProvider() {
  return {
    async structured() {
      state.aiCalls += 1;
      return { concept: "Fresh concept", caption: "New caption", cta: "Shop now", hashtags: ["#voom"], visualPrompt: "a product on a wooden table" };
    },
  };
}

/* ── @/lib/media ────────────────────────────────────────────── */
export class MediaError extends Error {
  constructor(code, diagnostic = null) { super(code); this.code = code; this.diagnostic = diagnostic; }
}
export function getMediaConfig() { return { provider: "fake-image-provider" }; }
export function createMediaProvider() {
  return {
    async generateImage() {
      state.imageCalls += 1;
      if (state.imageFails) throw new MediaError("unavailable");
      return { bytes: Buffer.alloc(64, 1), mimeType: "image/png" };
    },
  };
}

/* ── @/lib/media/media-inspect, @/lib/media/image-overlay ───── */
export function inspectImageBytes() { return { width: 1080, height: 1080, mimeType: "image/png" }; }
export function aspectMatches() { return true; }
export async function applyPostOverlay(input) { return input; }

/* ── @/lib/voom/server-data ─────────────────────────────────── */
export async function getCurrentUser() { return { id: "owner-1", email: "owner@example.com" }; }

/* ── @/lib/post/server-data ─────────────────────────────────── */
export async function getPostDraft() {
  return { id: POST_ID, kind: "instagram_post", format: "1:1", mediaBrief: null, conversationId: "conv-1", concept: null, title: "Old title", content: "Old caption" };
}
export async function loadPostBrandContext() {
  return { brandName: "Acme", brandDescription: "Handmade candles", industry: "Retail", targetCustomer: "Gift buyers", mainGoal: "Sales", brandPersonality: "Warm", contentFrequency: "weekly" };
}
export async function loadPostPlanContext() { return null; }
export function normalizeMediaBrief(value) { return value; }
export async function putPostAsset() {
  state.assetPuts += 1;
  return { storagePath: "posts/owner-1/new.png", previousStoragePath: null };
}
export async function removePostAssetObject() {}
export async function syncPostToCalendar() {}

/* ── @/lib/mara/video-service, @/lib/mara/media-spend ───────── */
export async function startPostStudioVideo() { throw new Error("video path is not under test"); }
export function estimateMediaCostUsd() { return 0.01; }
export function normalizeAllowAutomaticPaidMedia() { return false; }

/* ── @/lib/rate-limit ───────────────────────────────────────── */
export async function consumeAiRateLimit() { return true; }
export function rateLimitedResponse() { return Response.json({ error: "rate limited" }, { status: 429 }); }

/* ── @/utils/supabase/admin ─────────────────────────────────── */
class Query {
  constructor(table) { this.table = table; this.op = "select"; this.patch = null; this.row = null; this.counting = false; }
  select(_columns, options) { this.op = "select"; this.counting = Boolean(options?.count); return this; }
  update(patch) { this.op = "update"; this.patch = patch; return this; }
  insert(row) { this.op = "insert"; this.row = row; return this; }
  eq() { return this; }
  gte() { return this; }
  in() { return this; }
  async maybeSingle() {
    if (this.table === "businesses") return { data: { plan: state.plan, allow_automatic_paid_media: false, automation_level: "manual" }, error: null };
    return { data: null, error: null };
  }
  result() {
    if (this.op === "update") { state.updates.push({ table: this.table, patch: this.patch }); return { error: null }; }
    if (this.op === "insert") { state.inserts.push({ table: this.table, row: this.row }); return { error: null }; }
    if (this.counting) return { count: 0, error: null };
    return { data: null, error: null };
  }
  then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); }
}

const fakeAdmin = {
  from: (table) => new Query(table),
  async rpc(name) {
    state.rpcCalls.push(name);
    if (name === "reserve_media_credits") return { data: { ok: true, remaining: 100, allowance: 150, used: 5 }, error: null };
    if (name === "refund_media_credits") return { data: { refunded: true }, error: null };
    if (name === "settle_media_credits") return { data: { settled: true }, error: null };
    return { data: null, error: null };
  },
};
export function createAdminClient() { return fakeAdmin; }
