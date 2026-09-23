/**
 * REAL TikTok Provider Integration v1 — focused tests for migration 0049
 * and lib/tiktok/*.
 *
 * What is covered, and how truthfully:
 *   1. least-privilege OAuth scopes and the server-side configuration,
 *   2. token crypto (AES-256-GCM ring v2/v3: encrypt/decrypt/rotate/tamper),
 *   3. the publishing primitives — FILE_UPLOAD chunk math, the never-guess
 *      privacy declaration, Direct Post post_info, the provider failure
 *      taxonomy (rate != auth != media != unaudited != cap), worker-aligned
 *      retry timing, processing expiry,
 *   4. the TikTok client against FAKE fetch responses shaped exactly like
 *      the official OAuth v2 / user info / creator_info / Direct Post /
 *      media-transfer / post-status responses (including the bigInt
 *      publish_id precision guard),
 *   5. the publish flow against fake ports: approval re-check, declaration
 *      parking, creator-info BEFORE every fresh post, live privacy options
 *      validation, unaudited-client refusal, publish id persisted BEFORE
 *      the first byte, resume, 416 re-sync, fail-closed ambiguity,
 *      published ONLY on TikTok's own PUBLISH_COMPLETE evidence,
 *   6. migration 0049's real SQL on an embedded PostgreSQL (PGlite):
 *      idempotent enqueue, atomic claims, the published-row guard, provider
 *      evidence requirements, disconnect semantics, owner isolation,
 *   7. the workers end-to-end (publish + reconciliation) with PGlite as the
 *      database and a fake TikTok client,
 *   8. route/UI source-level guards (secrets never reach the browser, cron
 *      authentication, truthful banners, honest performance semantics),
 *   9. migration 0049's boundary: additive, RLS-protected, touching no
 *      Instagram/YouTube/email object, scheduling no cron.
 *
 * NOTHING here performs a real external action: no real TikTok
 * authorization, post, upload or status call ever happens. TikTok is
 * answered by fakes shaped from the official documentation
 * (developers.tiktok.com: Login Kit Web, OAuth v2, User Info v2,
 * Direct Post video/init, Media Transfer Guide, post status/fetch).
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const pub = await import("../lib/tiktok/publishing.ts");
const scopesMod = await import("../lib/tiktok/scopes.ts");
const configMod = await import("../lib/tiktok/config.ts");
const ttCrypto = await import("../lib/tiktok/crypto.ts");
const clientMod = await import("../lib/tiktok/client.ts");
const flowMod = await import("../lib/tiktok/publish-flow.ts");
const queueMod = await import("../lib/tiktok/publish-queue.ts");
const dataMod = await import("../lib/tiktok/data.ts");
const workerMod = await import("../lib/tiktok/publish-worker.ts");
const reconcileMod = await import("../lib/tiktok/reconcile.ts");

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "99999999-9999-4999-8999-999999999999";
// Real wall clock: the queue SQL compares against `now()` internally
// (record_tiktok_publish stamps scheduled_at = now()), so every fixture must
// be relative to the real clock, not an invented instant.
const NOW = Date.now();
const nowIso = (ms = 0) => new Date(NOW + ms).toISOString();

const KEY = "k".repeat(32);
const KEY_NEXT = "n".repeat(32);
const KEY_LEGACY = "l".repeat(32);

function fakeConfig(extra = {}) {
  return {
    clientKey: "tiktok-client-key",
    clientSecret: "tiktok-client-secret",
    redirectUri: "https://app.voom.example/api/integrations/tiktok/callback",
    encryptionKey: KEY,
    legacyEncryptionKeys: [],
    appAudited: false,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// A PostgREST-shaped admin client backed by the REAL embedded PostgreSQL, so
// every RPC below executes migration 0049's actual SQL (that is where the
// guarantees live). Same pattern the branded-email + YouTube suites proved.
// ---------------------------------------------------------------------------

const RPC_DEFS = {
  save_tiktok_connection: {
    params: [
      ["p_owner_user_id", "uuid"], ["p_open_id", "text"], ["p_display_name", "text"],
      ["p_avatar_url", "text"], ["p_scopes", "text[]"],
      ["p_encrypted_refresh_token", "text"], ["p_refresh_iv", "text"], ["p_refresh_auth_tag", "text"],
      ["p_refresh_key_version", "smallint"], ["p_encrypted_access_token", "text"], ["p_access_iv", "text"],
      ["p_access_auth_tag", "text"], ["p_access_key_version", "smallint"],
      ["p_access_token_expires_at", "timestamptz"], ["p_refresh_token_expires_at", "timestamptz"],
    ],
    returns: "scalar",
  },
  disconnect_tiktok_connection: { params: [["p_owner_user_id", "uuid"]], returns: "scalar" },
  get_tiktok_connection_secret: { params: [["p_owner_user_id", "uuid"]], returns: "setof" },
  update_tiktok_tokens: {
    params: [
      ["p_owner_user_id", "uuid"], ["p_encrypted_access_token", "text"], ["p_access_iv", "text"],
      ["p_access_auth_tag", "text"], ["p_access_key_version", "smallint"], ["p_access_token_expires_at", "timestamptz"],
      ["p_encrypted_refresh_token", "text"], ["p_refresh_iv", "text"], ["p_refresh_auth_tag", "text"],
      ["p_refresh_key_version", "smallint"], ["p_refresh_token_expires_at", "timestamptz"],
    ],
    returns: "scalar",
  },
  set_tiktok_connection_status: { params: [["p_owner_user_id", "uuid"], ["p_status", "text"]], returns: "scalar" },
  set_tiktok_publish_defaults: { params: [["p_owner_user_id", "uuid"], ["p_default_privacy", "text"]], returns: "scalar" },
  upsert_tiktok_publish_queue_item: {
    params: [
      ["p_owner_user_id", "uuid"], ["p_draft_id", "uuid"], ["p_calendar_item_id", "uuid"],
      ["p_title", "text"], ["p_privacy_level", "text"], ["p_disable_comment", "boolean"],
      ["p_disable_duet", "boolean"], ["p_disable_stitch", "boolean"], ["p_brand_content_toggle", "boolean"],
      ["p_brand_organic_toggle", "boolean"], ["p_is_aigc", "boolean"],
      ["p_scheduled_at", "timestamptz"], ["p_waiting_for_media", "boolean"],
    ],
    returns: "composite",
  },
  cancel_tiktok_publish_queue_item: { params: [["p_owner_user_id", "uuid"], ["p_draft_id", "uuid"]], returns: "scalar" },
  claim_due_tiktok_post_jobs: {
    params: [["p_limit", "integer"], ["p_now", "timestamptz"], ["p_max_attempts", "integer"], ["p_stale_after", "interval"]],
    returns: "setof",
  },
  claim_tiktok_reconcile_jobs: {
    params: [["p_limit", "integer"], ["p_now", "timestamptz"], ["p_max_attempts", "integer"], ["p_stale_after", "interval"]],
    returns: "setof",
  },
  record_tiktok_publish: {
    params: [["p_id", "uuid"], ["p_owner_user_id", "uuid"], ["p_publish_id", "text"], ["p_upload_url", "text"], ["p_content_length", "bigint"]],
    returns: "composite",
  },
  set_tiktok_provider_processing: { params: [["p_id", "uuid"], ["p_owner_user_id", "uuid"]], returns: "composite" },
  record_tiktok_upload_progress: { params: [["p_id", "uuid"], ["p_owner_user_id", "uuid"], ["p_bytes_sent", "bigint"]], returns: "composite" },
  complete_tiktok_publish_job: {
    params: [
      ["p_id", "uuid"], ["p_owner_user_id", "uuid"], ["p_provider_status", "text"],
      ["p_provider_post_id", "text"], ["p_provider_note", "text"],
    ],
    returns: "composite",
  },
  fail_tiktok_publish_job: {
    params: [
      ["p_id", "uuid"], ["p_owner_user_id", "uuid"], ["p_failure_code", "text"], ["p_failure_message", "text"],
      ["p_status", "text"], ["p_retry_at", "timestamptz"], ["p_reset_attempts", "boolean"],
    ],
    returns: "composite",
  },
  record_tiktok_provider_status: {
    params: [
      ["p_id", "uuid"], ["p_owner_user_id", "uuid"], ["p_provider_status", "text"],
      ["p_provider_post_id", "text"], ["p_provider_fail_reason", "text"], ["p_provider_note", "text"],
      ["p_last_provider_check_at", "timestamptz"],
    ],
    returns: "composite",
  },
  reset_tiktok_publish_for_resubmit: { params: [["p_id", "uuid"], ["p_owner_user_id", "uuid"]], returns: "composite" },
  list_tiktok_published_for_verification: { params: [["p_limit", "integer"], ["p_now", "timestamptz"], ["p_min_age", "interval"]], returns: "setof" },
};

function createPgliteAdmin(db) {
  return {
    from(table) {
      let columns = "*";
      const filters = []; // [sqlFragment, params[]]
      let orderColumn = null;
      let orderAscending = true;
      let limitValue = null;
      let mode = "select";
      let writeValues = null;
      let upsertConflict = null;

      const assembleWhere = (offset = 0) => {
        const params = [];
        const parts = [];
        for (const [fragmentTemplate, fragParams] of filters) {
          const fragment = fragmentTemplate.replace(/#\d+/g, (m) => {
            const localIndex = Number(m.slice(1));
            return `$${offset + params.length + localIndex + 1}`;
          });
          params.push(...fragParams);
          parts.push(fragment);
        }
        return { sql: parts.length ? ` where ${parts.join(" and ")}` : "", params };
      };

      const run = async () => {
        if (mode === "insert" || mode === "upsert") {
          const keys = Object.keys(writeValues);
          const params = keys.map((key) => writeValues[key]);
          const cols = keys.map((key) => `"${key}"`).join(",");
          const holders = keys.map((_, index) => `$${index + 1}`).join(",");
          let sql = `insert into public.${table} (${cols}) values (${holders})`;
          if (mode === "upsert" && upsertConflict) {
            const conflictCols = upsertConflict.split(",").map((c) => `"${c.trim()}"`).join(",");
            const updates = keys
              .filter((key) => !upsertConflict.split(",").map((c) => c.trim()).includes(key))
              .map((key) => `"${key}" = excluded."${key}"`)
              .join(",");
            sql += ` on conflict (${conflictCols}) do update set ${updates || `"${keys[0]}" = excluded."${keys[0]}"`}`;
          }
          sql += " returning *";
          const result = await db.query(sql, params);
          return { data: mode === "insert" ? null : result.rows, error: null };
        }
        if (mode === "update") {
          const keys = Object.keys(writeValues);
          const params = keys.map((key) => writeValues[key]);
          const sets = keys.map((key, index) => `"${key}" = $${index + 1}`).join(",");
          const { sql: whereSql, params: whereParams } = assembleWhere(keys.length);
          params.push(...whereParams);
          const select = columns === "*" ? "*" : columns.split(",").map((c) => `"${c.trim()}"`).join(",");
          const sql = `update public.${table} set ${sets}${whereSql} returning ${select}`;
          const result = await db.query(sql, params);
          return { data: result.rows, error: null };
        }
        const select = columns === "*" ? "*" : columns.split(",").map((c) => `"${c.trim()}"`).join(",");
        const { sql: whereSql, params } = assembleWhere();
        let sql = `select ${select} from public.${table}${whereSql}`;
        if (orderColumn) sql += ` order by "${orderColumn}" ${orderAscending ? "asc" : "desc"}`;
        if (limitValue !== null) {
          params.push(limitValue);
          sql += ` limit $${params.length}`;
        }
        const result = await db.query(sql, params);
        return { data: result.rows, error: null };
      };

      const wrap = () => {
        const pending = run().catch((error) => ({ data: null, error: { code: error.code ?? "STUB", message: error.message } }));
        return {
          then: (onFulfilled, onRejected) => pending.then(onFulfilled, onRejected),
          maybeSingle: async () => {
            const result = await pending;
            if (result.error) return result;
            const rows = Array.isArray(result.data) ? result.data : [];
            return { data: rows[0] ?? null, error: null };
          },
          single: async () => {
            const result = await pending;
            if (result.error) return result;
            const rows = Array.isArray(result.data) ? result.data : [];
            return rows.length === 1
              ? { data: rows[0], error: null }
              : { data: rows[0] ?? null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
          },
        };
      };

      const builder = {
        select(cols) { columns = cols ?? "*"; return builder; },
        insert(values) { mode = "insert"; writeValues = values; return wrap(); },
        upsert(values, options) { mode = "upsert"; writeValues = values; upsertConflict = options?.onConflict ?? null; return wrap(); },
        update(values) { mode = "update"; writeValues = values; return builder; },
        eq(column, value) { filters.push([`"${column}" = #0`, [value]]); return builder; },
        in(column, values) {
          const holders = values.map((_, index) => `#${index}`).join(",");
          filters.push([`"${column}" in (${holders})`, values]);
          return builder;
        },
        is(column, value) {
          if (value === null) filters.push([`"${column}" is null`, []]);
          else filters.push([`"${column}" is #0`, [value]]);
          return builder;
        },
        gt(column, value) { filters.push([`"${column}" > #0`, [value]]); return builder; },
        gte(column, value) { filters.push([`"${column}" >= #0`, [value]]); return builder; },
        lt(column, value) { filters.push([`"${column}" < #0`, [value]]); return builder; },
        not(column, op, value) {
          if (op === "is") filters.push([`"${column}" is not ${value === null ? "null" : "#0"}`, value === null ? [] : [value]]);
          else filters.push([`not ("${column}" ${op} #0)`, [value]]);
          return builder;
        },
        or(expression) {
          // Supports the exact shapes lib/tiktok uses: `col.is.null,col.lt.<iso>`.
          const parts = String(expression).split(",").map((token) => {
            const bits = token.split(".");
            const column = bits[0];
            if (bits[1] === "is" && bits[2] === "null") return { sql: `"${column}" is null`, params: [] };
            if (bits[1] === "lt") return { sql: `"${column}" < #0`, params: [bits.slice(2).join(".")] };
            throw new Error(`stub: unsupported or() token ${token}`);
          });
          const combined = parts.map((part, index) => part.sql.replace(/#0/g, `#${parts.slice(0, index).reduce((n, p) => n + p.params.length, 0)}`));
          filters.push([`(${combined.join(" or ")})`, parts.flatMap((part) => part.params)]);
          return builder;
        },
        order(column, options) { orderColumn = column; orderAscending = options?.ascending !== false; return builder; },
        limit(n) { limitValue = n; return builder; },
        maybeSingle: () => wrap().maybeSingle(),
        single: () => wrap().single(),
        then: (onFulfilled, onRejected) => wrap().then(onFulfilled, onRejected),
      };
      return builder;
    },

    rpc(name, args = {}) {
      const def = RPC_DEFS[name];
      if (!def) throw new Error(`stub: unexpected rpc ${name}`);
      const params = def.params.map(([paramName, cast], index) => ({ value: args[paramName] === undefined ? null : args[paramName], cast, index }));
      const holders = params.map((_, index) => `$${index + 1}::${params[index].cast}`).join(",");
      const sql = `select * from public.${name}(${holders})`;
      const run = async () => {
        try {
          const result = await db.query(sql, params.map((param) => param.value));
          if (def.returns === "setof") return { data: result.rows, error: null };
          if (def.returns === "composite") return { data: result.rows[0] ?? null, error: null };
          const first = result.rows[0];
          const value = first && typeof first === "object" ? first[name] : first;
          return { data: value ?? null, error: null };
        } catch (error) {
          return { data: null, error: { code: error.code ?? "PGRST000", message: error.message ?? String(error) } };
        }
      };
      const pending = run();
      return {
        then: (onFulfilled, onRejected) => pending.then(onFulfilled, onRejected),
        single: async () => {
          const result = await pending;
          if (result.error) return result;
          if (def.returns === "setof") {
            const rows = result.data;
            return rows.length === 1 ? { data: rows[0], error: null } : { data: rows[0] ?? null, error: { code: "PGRST116", message: "multiple or no rows" } };
          }
          return result;
        },
        maybeSingle: async () => {
          const result = await pending;
          if (result.error) return result;
          if (def.returns === "setof") return { data: result.data[0] ?? null, error: null };
          return result;
        },
      };
    },

    storage: {
      from(bucket) {
        return {
          async createSignedUrl(path, ttl) {
            return { data: { signedUrl: `https://signed.test/${bucket}/${path}?ttl=${ttl}` }, error: null };
          },
        };
      },
    },
  };
}

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const key = String(name).toLowerCase();
        for (const [headerName, value] of Object.entries(headers)) {
          if (headerName.toLowerCase() === key) return value;
        }
        return null;
      },
    },
    json: async () => body,
    text: async () => (body === undefined || body === null ? "" : JSON.stringify(body)),
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let lite = null;
async function liteDb() {
  if (!lite) {
    const created = await createSupabaseLite();
    const admin = createPgliteAdmin(created.db);
    await created.db.query(
      "insert into auth.users (id, email) values ($1, 'a@voom.test'), ($2, 'b@voom.test')",
      [OWNER_A, OWNER_B],
    );
    lite = { db: created.db, applied: created.applied, admin, seq: 0 };
  }
  return lite;
}

async function one(sql, params = []) {
  const { db } = await liteDb();
  return (await db.query(sql, params)).rows[0];
}
async function all(sql, params = []) {
  const { db } = await liteDb();
  return (await db.query(sql, params)).rows;
}

async function makeDraft(ownerId, { kind = "tiktok_video", format = "video", status = "approved", title = "Launch teaser" } = {}) {
  const { db } = await liteDb();
  const conv = (await db.query(
    "insert into public.mara_conversations (owner_user_id, title) values ($1, 'Studio') returning id",
    [ownerId],
  )).rows[0];
  const draft = (await db.query(
    `insert into public.mara_drafts
       (conversation_id, owner_user_id, kind, channel, title, content, social_channel, social_format, content_meta, status)
     values ($1, $2, $3, 'TikTok · 9:16', $4, 'Caption', 'tiktok', $5, '{}'::jsonb, $6) returning id`,
    [conv.id, ownerId, kind, title, format, status],
  )).rows[0];
  return draft.id;
}

async function makeAsset(ownerId, draftId, { mime = "video/mp4", byteSize = 1024, status = "uploaded" } = {}) {
  const { db } = await liteDb();
  await db.query(
    `insert into public.post_draft_assets (owner_user_id, draft_id, storage_path, display_name, mime_type, byte_size, status)
     values ($1, $2, $3, 'video.mp4', $4, $5, $6)`,
    [ownerId, draftId, `tiktok/${ownerId}/${draftId}-video.mp4`, mime, byteSize, status],
  );
}

async function saveConnection(ownerId, overrides = {}) {
  const { admin } = await liteDb();
  await dataMod.saveTikTokConnection(admin, {
    ownerId,
    openId: `73645806670${ownerId.slice(0, 5)}`,
    displayName: "Voom Studio",
    avatarUrl: "https://tiktokcdn.test/avatar.jpg",
    grantedScopes: [...scopesMod.TIKTOK_SCOPES],
    refreshToken: `refresh-${ownerId.slice(0, 8)}`,
    accessToken: `access-${ownerId.slice(0, 8)}`,
    accessTokenExpiresAt: nowIso(24 * 3600_000),
    refreshTokenExpiresAt: nowIso(365 * 24 * 3600_000),
    encryptionKey: KEY,
    ...overrides,
  });
}

/** Removes rows previous tests left in claimable states (published and
 *  provider-owned rows are guard-protected and stay). 'posting' rows from
 *  earlier tests are test data too — a stray in-flight row must never leak
 *  into another test's claim set. */
async function clearClaimable() {
  const { db } = await liteDb();
  await db.query(
    `delete from public.tiktok_publish_queue
     where status in ('scheduled', 'waiting_for_media', 'needs_declaration', 'permission_required', 'failed', 'cancelled', 'posting')`,
  );
}
/** Removes provider-owned rows too (test data only) — used by tests that
 *  must see exactly their own rows (e.g. reconciliation claims). Published
 *  rows are EXEMPT by design: the guard trigger makes them permanently
 *  immutable (publication history), and no claim path ever touches them, so
 *  they are inert for every test that follows. */
async function clearAllQueueRows() {
  const { db } = await liteDb();
  await db.query("delete from public.tiktok_publish_queue where status <> 'published'");
}

function enqueueInput(draftId, overrides = {}) {
  return {
    ownerId: OWNER_A,
    draftId,
    calendarItemId: null,
    title: "Launch teaser",
    privacyLevel: "SELF_ONLY",
    scheduledAt: nowIso(-60_000),
    ...overrides,
  };
}

let publishSeq = 0;
/** The queue holds a partial UNIQUE index on tiktok_publish_id: one real
 *  publish id belongs to exactly one row, so each DB test needs its own
 *  real-shaped id (a big numeric string, as TikTok returns). */
function newPublishId() {
  publishSeq += 1;
  return String(7364580667000000000n + BigInt(publishSeq) * 101n);
}

function fakeCreatorInfo(overrides = {}) {
  return {
    creatorUsername: "voomstudio",
    creatorNickname: "Voom Studio",
    creatorAvatarUrl: null,
    privacyLevelOptions: ["FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
    commentDisabled: false,
    duetDisabled: false,
    stitchDisabled: false,
    maxVideoPostDurationSec: 180,
    ...overrides,
  };
}

// A fake TikTok: every response is shaped like the official API's.
function fakeTikTok(overrides = {}) {
  const calls = [];
  return {
    calls,
    async queryCreatorInfo(accessToken) {
      calls.push(["creatorInfo", { accessToken }]);
      return overrides.creatorInfo ?? fakeCreatorInfo();
    },
    async initDirectPost(accessToken, metadata, sourceInfo) {
      calls.push(["init", { metadata, sourceInfo }]);
      if (overrides.initError) throw overrides.initError;
      return { publishId: overrides.publishId ?? newPublishId(), uploadUrl: overrides.uploadUrl ?? `https://upload.tiktok.test/${(overrides.publishId ?? "p").slice(0, 8)}` };
    },
    async uploadChunk(uploadUrl, body, contentType, contentRange, contentLength) {
      calls.push(["chunk", { contentRange, contentLength: Number(contentLength) }]);
      if (overrides.chunkError) throw overrides.chunkError;
      if (overrides.chunkResult) return overrides.chunkResult;
      return { outcome: "complete", uploadedBytes: Number(contentLength) };
    },
    async fetchPostStatus(accessToken, publishId) {
      calls.push(["status", { publishId }]);
      if (overrides.statusError) throw overrides.statusError;
      if (overrides.statuses) {
        const status = overrides.statuses.shift() ?? overrides.statusesFinal ?? "PUBLISH_COMPLETE";
        return typeof status === "function" ? status(publishId) : status;
      }
      return { status: "PUBLISH_COMPLETE", postIds: [], failReason: null };
    },
    async refreshAccessToken(refreshToken) {
      calls.push(["refresh", { refreshToken }]);
      throw overrides.refreshError ?? new Error("unexpected refresh");
    },
    async getBasicUser(accessToken) {
      calls.push(["basicUser", { accessToken }]);
      return overrides.basicUser ?? { openId: null, unionId: null, displayName: "Voom Studio", avatarUrl: "https://tiktokcdn.test/avatar.jpg" };
    },
    async revokeAccessToken(accessToken) {
      calls.push(["revoke", { accessToken }]);
      return true;
    },
    ...overrides,
  };
}

const noopSleep = async () => undefined;

// ---------------------------------------------------------------------------
// 1. Least-privilege scopes and server-side configuration
// ---------------------------------------------------------------------------

test("Voom asks TikTok for exactly two least-privilege scopes — never video.list, never username, never profile", async () => {
  assert.deepEqual([...scopesMod.TIKTOK_SCOPES], ["user.info.basic", "video.publish"]);
  const source = await read("lib/tiktok/scopes.ts");
  const requested = source.slice(source.indexOf("export const TIKTOK_BASIC_SCOPE"), source.indexOf("export function hasPublishPermission"));
  for (const forbidden of [/video\.list/, /video\.upload/, /user\.info\.username/, /user\.info\.profile/]) {
    assert.doesNotMatch(requested, forbidden, "the requested scope set stays least-privilege");
  }
  assert.equal(scopesMod.hasPublishPermission([scopesMod.TIKTOK_PUBLISH_SCOPE]), true);
  assert.equal(scopesMod.hasPublishPermission([scopesMod.TIKTOK_BASIC_SCOPE]), false);
  assert.equal(scopesMod.hasPublishPermission(null), false);
  assert.equal(scopesMod.hasBasicInfoPermission([scopesMod.TIKTOK_BASIC_SCOPE]), true);
});

test("the authorization URL is the server-side auth-code flow with the exact registered redirect URI and the strong state", () => {
  const client = new clientMod.TikTokClient(fakeConfig());
  const url = new URL(client.authorizationUrl("state-value-abc"));
  assert.equal(url.origin + url.pathname, "https://www.tiktok.com/v2/auth/authorize/");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_key"), "tiktok-client-key");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.voom.example/api/integrations/tiktok/callback", "the redirect URI must match the registered one exactly");
  assert.equal(url.searchParams.get("state"), "state-value-abc");
  assert.deepEqual(url.searchParams.get("scope").split(","), [...scopesMod.TIKTOK_SCOPES]);
  assert.ok(!url.toString().includes("tiktok-client-secret"), "no secret in the authorization URL");
});

test("configuration is server-env only, defaults to the SAFE unaudited assumption, and fails closed when incomplete", () => {
  const saved = { ...process.env };
  try {
    for (const name of ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REDIRECT_URI", "TIKTOK_TOKEN_ENCRYPTION_KEY", "TIKTOK_TOKEN_ENCRYPTION_KEY_NEXT", "TIKTOK_TOKEN_ENCRYPTION_KEY_LEGACY", "TIKTOK_APP_AUDITED"]) {
      delete process.env[name];
    }
    assert.equal(configMod.readTikTokConfig(), null, "nothing configured — the integration reports 'not configured', not an error");
    process.env.TIKTOK_CLIENT_KEY = "tk";
    process.env.TIKTOK_CLIENT_SECRET = "ts";
    process.env.TIKTOK_REDIRECT_URI = "https://app.voom.example/api/integrations/tiktok/callback";
    process.env.TIKTOK_TOKEN_ENCRYPTION_KEY = KEY;
    const config = configMod.readTikTokConfig();
    assert.ok(config);
    assert.equal(config.appAudited, false, "the unaudited assumption is the DEFAULT — no audit override is invented");
    process.env.TIKTOK_APP_AUDITED = "true";
    assert.equal(configMod.readTikTokConfig()?.appAudited, true, "wording flag only — provider truth still wins");
    delete process.env.TIKTOK_TOKEN_ENCRYPTION_KEY;
    assert.equal(configMod.readTikTokConfig(), null, "an encryption-less deployment cannot safely store tokens");
    process.env.TIKTOK_TOKEN_ENCRYPTION_KEY = "short";
    assert.equal(configMod.readTikTokConfig(), null, "weak keys are refused");
  } finally {
    process.env = saved;
  }
});

// ---------------------------------------------------------------------------
// 2. Token crypto — AES-256-GCM ring, versioned envelopes, staged rotation
// ---------------------------------------------------------------------------

test("tokens round-trip through AES-256-GCM with a versioned envelope and a fresh IV each write", () => {
  const access = ttCrypto.encryptTikTokToken("tt-access-token", KEY);
  assert.equal(access.keyVersion, ttCrypto.CURRENT_KEY_VERSION);
  assert.match(access.encryptedToken, /^v2:/, "normal writes carry the current version prefix");
  assert.equal(ttCrypto.decryptTikTokToken({ encryptedToken: access.encryptedToken, iv: access.iv, authTag: access.authTag }, KEY), "tt-access-token");
  const again = ttCrypto.encryptTikTokToken("tt-access-token", KEY);
  assert.notEqual(access.iv, again.iv, "a fresh IV per write — the same token never produces identical ciphertext");
  assert.notEqual(access.encryptedToken, again.encryptedToken);
});

test("tampered ciphertext or the wrong key fails closed — never a plaintext leak", () => {
  const token = ttCrypto.encryptTikTokToken("tt-refresh-token", KEY);
  const flipped = token.encryptedToken.slice(0, 20) + (token.encryptedToken[20] === "A" ? "B" : "A") + token.encryptedToken.slice(21);
  assert.throws(
    () => ttCrypto.decryptTikTokToken({ encryptedToken: flipped, iv: token.iv, authTag: token.authTag }, KEY),
    ttCrypto.TikTokTokenDecryptionError,
  );
  assert.throws(
    () => ttCrypto.decryptTikTokToken({ encryptedToken: token.encryptedToken, iv: token.iv, authTag: token.authTag }, KEY_NEXT),
    ttCrypto.TikTokTokenDecryptionError,
    "the wrong key fails closed with a generic error (no key identifiers surface)",
  );
});

test("staged rotation: v3 envelopes bind to the NEXT key, old rows still decrypt, decryption order is PRIMARY -> NEXT -> LEGACY", () => {
  // A row encrypted with the OLD primary before rotation:
  const oldRow = ttCrypto.encryptTikTokToken("refresh-old", KEY_LEGACY);
  // Rotation: NEXT becomes primary; the old primary drops to LEGACY.
  const ring = { primary: KEY_NEXT, legacy: [KEY_LEGACY] };
  assert.equal(ttCrypto.decryptTikTokToken({ encryptedToken: oldRow.encryptedToken, iv: oldRow.iv, authTag: oldRow.authTag }, ring), "refresh-old");

  // Staged-rotation output is written with NEXT specifically (v3 + key id):
  const staged = ttCrypto.encryptTikTokTokenForStagedRotation("refresh-rotated", KEY_NEXT);
  assert.equal(staged.keyVersion, 3);
  assert.match(staged.encryptedToken, /^v3:[A-Za-z0-9_-]{22}:/, "the v3 envelope binds the 22-char base64url key identifier");
  assert.equal(ttCrypto.decryptTikTokToken({ encryptedToken: staged.encryptedToken, iv: staged.iv, authTag: staged.authTag }, { primary: KEY_NEXT, legacy: [] }), "refresh-rotated");
  assert.throws(
    () => ttCrypto.decryptTikTokToken({ encryptedToken: staged.encryptedToken, iv: staged.iv, authTag: staged.authTag }, { primary: KEY, next: KEY_LEGACY, legacy: [] }),
    ttCrypto.TikTokTokenDecryptionError,
    "a v3 envelope is refused by a ring whose NEXT key does not match its bound key id",
  );

  // Legacy-only ring cannot decrypt current rows:
  assert.throws(
    () => ttCrypto.decryptTikTokToken({ encryptedToken: oldRow.encryptedToken, iv: oldRow.iv, authTag: oldRow.authTag }, { primary: KEY, legacy: [] }),
    ttCrypto.TikTokTokenDecryptionError,
  );
});

// ---------------------------------------------------------------------------
// 3. Publishing primitives — FILE_UPLOAD chunk math, declarations, taxonomy
// ---------------------------------------------------------------------------

test("FILE_UPLOAD chunk planning follows the documented TikTok limits exactly", () => {
  const MB = 1024 * 1024;
  // Under 5 MB: the WHOLE file is one chunk (chunk_size = total size).
  assert.deepEqual(pub.tiktokChunkPlan(1 * MB), { chunkSize: 1 * MB, totalChunkCount: 1 });
  assert.deepEqual(pub.tiktokChunkPlan(5 * MB - 1), { chunkSize: 5 * MB - 1, totalChunkCount: 1 });
  // 5 MB exactly: one 5 MB chunk.
  assert.deepEqual(pub.tiktokChunkPlan(5 * MB), { chunkSize: 5 * MB, totalChunkCount: 1 });
  // 10 MB: one 10 MB chunk (chunk size cap is 64 MB).
  assert.deepEqual(pub.tiktokChunkPlan(10 * MB), { chunkSize: 10 * MB, totalChunkCount: 1 });
  // 200 MB: 64 MB chunks, floor(200/64) = 3 chunks, final 200 - 2*64 = 72 MB.
  assert.deepEqual(pub.tiktokChunkPlan(200 * MB), { chunkSize: 64 * MB, totalChunkCount: 3 });
  // 4 GB ceiling: exactly 64 chunks of 64 MB.
  assert.deepEqual(pub.tiktokChunkPlan(pub.TIKTOK_MAX_VIDEO_BYTES), { chunkSize: 64 * MB, totalChunkCount: 64 });
  // Above the ceiling or invalid: refused.
  assert.equal(pub.tiktokChunkPlan(pub.TIKTOK_MAX_VIDEO_BYTES + 1), null);
  assert.equal(pub.tiktokChunkPlan(0), null);
  assert.equal(pub.tiktokChunkPlan(-1), null);
  assert.equal(pub.tiktokChunkPlan(1024.5), null);
  assert.equal(pub.tiktokChunkPlan(NaN), null);
});

test("chunk windows are sequential, end-inclusive and the final window carries the trailing bytes", () => {
  const size = 200 * 1024 * 1024;
  const plan = pub.tiktokChunkPlan(size);
  const w0 = pub.tiktokChunkWindow(plan, size, 0);
  const w1 = pub.tiktokChunkWindow(plan, size, 1);
  const w2 = pub.tiktokChunkWindow(plan, size, 2);
  assert.deepEqual(w0, { start: 0, end: 64 * 1024 * 1024 - 1, length: 64 * 1024 * 1024, final: false });
  assert.equal(w1.start, 64 * 1024 * 1024);
  assert.equal(w2.final, true);
  assert.equal(w2.start, 128 * 1024 * 1024);
  assert.equal(w2.end, size - 1, "the final window ends at the LAST byte");
  assert.equal(w2.length, 72 * 1024 * 1024, "the final window carries the trailing bytes (200 - 2x64 = 72 MB)");
  assert.equal(pub.tiktokChunkWindow(plan, size, 3), null, "nothing left after the final chunk");
  assert.equal(pub.tiktokChunkWindow(plan, size, -1), null);
  assert.equal(pub.tiktokContentRangeFor(w0, size), `bytes 0-${64 * 1024 * 1024 - 1}/${size}`);
});

test("TikTok's Content-Range progress header is the trusted resume source", () => {
  assert.equal(pub.uploadedBytesFromRange("bytes 0-99/1000"), 100);
  assert.equal(pub.uploadedBytesFromRange("bytes 0-67108863/209715200"), 67108864);
  assert.equal(pub.uploadedBytesFromRange(null), 0);
  assert.equal(pub.uploadedBytesFromRange("not a range"), 0);
});

test("media constraints: only documented container/codecs' mimes, a real publish_id shape, the 2200-char title", () => {
  assert.equal(pub.isTikTokPublishableMime("video/mp4"), true);
  assert.equal(pub.isTikTokPublishableMime("video/webm"), true);
  assert.equal(pub.isTikTokPublishableMime("video/quicktime"), true);
  assert.equal(pub.isTikTokPublishableMime("video/x-matroska"), false, "MKV is not a documented input");
  assert.equal(pub.isTikTokPublishableMime("image/png"), false);

  // A real publish_id is a big numeric string; anything beyond 2^53 MUST stay
  // a string end to end (json-bigint style), so the guard accepts 64 chars.
  assert.equal(pub.isRealTikTokPublishId("7364580667079849985"), true);
  assert.equal(pub.isRealTikTokPublishId("9".repeat(64)), true);
  assert.equal(pub.isRealTikTokPublishId("9".repeat(65)), false);
  assert.equal(pub.isRealTikTokPublishId(""), false);
  assert.equal(pub.isRealTikTokPublishId(7364580667079849985), false, "a JS number is NOT proof of a real id");
  assert.equal(pub.isRealTikTokPublishId("abc/def"), false);

  const long = "x".repeat(pub.TIKTOK_TITLE_MAX + 1);
  assert.equal(pub.truncateTikTokTitle(long).length, pub.TIKTOK_TITLE_MAX);
  assert.equal(pub.truncateTikTokTitle("short"), "short");
});

test("privacy is NEVER guessed: item declaration wins, explicit owner default fills a gap, nothing else may", () => {
  assert.deepEqual(pub.resolveTikTokDeclaration({ itemPrivacy: "SELF_ONLY" }), { ok: true, privacy: "SELF_ONLY" });
  assert.deepEqual(pub.resolveTikTokDeclaration({ itemPrivacy: null, defaultPrivacy: "MUTUAL_FOLLOW_FRIENDS" }), { ok: true, privacy: "MUTUAL_FOLLOW_FRIENDS" });
  assert.deepEqual(pub.resolveTikTokDeclaration({}), { ok: false, missing: ["privacy"] }, "no declaration, no default — TikTok has no default privacy, so Voom parks the item instead of choosing");
  assert.deepEqual(pub.resolveTikTokDeclaration({ itemPrivacy: "PUBLIC_TO_EVERYONE", defaultPrivacy: "SELF_ONLY" }), { ok: true, privacy: "PUBLIC_TO_EVERYONE" }, "the explicit item choice always wins over the default");
  assert.equal(pub.TIKTOK_PRIVACY_VALUES.length, 4);
});

test("Direct Post post_info sends only documented fields and only explicitly declared toggles", () => {
  const minimal = pub.tiktokDirectPostMetadata({ title: "t", privacy: "SELF_ONLY" });
  assert.deepEqual(minimal, { post_info: { title: "t", privacy_level: "SELF_ONLY" } }, "toggles the owner never declared are OMITTED — TikTok's own defaults stay in place");
  const full = pub.tiktokDirectPostMetadata({
    title: "t", privacy: "SELF_ONLY", disableComment: true, disableDuet: false, disableStitch: null,
    brandContentToggle: false, brandOrganicToggle: null, isAigc: true,
  });
  // Explicit booleans (true AND false) ride along — they are declarations;
  // nulls are omitted entirely.
  assert.deepEqual(full.post_info, {
    title: "t", privacy_level: "SELF_ONLY", disable_comment: true, disable_duet: false,
    brand_content_toggle: false, is_aigc: true,
  });
  assert.ok(!("disable_stitch" in full.post_info), "null means 'not declared', never an invented false");
  assert.ok(!("brand_organic_toggle" in full.post_info));
});

test("the provider failure taxonomy keeps rate, auth, media, unaudited, cap and ambiguity apart", () => {
  const failures = pub.TIKTOK_PUBLISH_FAILURES;
  assert.equal(Object.keys(failures).length, 22, "every documented outcome class has its own key");
  // Rate limit: retryable, parks, and is NOT an auth failure.
  assert.equal(failures.rate_limited.retryable, true);
  assert.equal(failures.rate_limited.status, "scheduled");
  assert.notEqual(failures.rate_limited.code, failures.authorization_revoked.code);
  // Auth: parks the item for reconnection, never retried blindly.
  assert.equal(failures.authorization_revoked.status, "permission_required");
  assert.equal(failures.authorization_revoked.retryable, false);
  // Unaudited client: a REAL provider restriction, terminal, distinct from a
  // generic 403 and from a privacy mismatch.
  assert.equal(failures.unaudited_client_restricted.retryable, false);
  assert.equal(failures.unaudited_client_restricted.status, "failed");
  assert.notEqual(failures.unaudited_client_restricted.code, failures.privacy_not_allowed.code);
  assert.equal(failures.privacy_not_allowed.status, "needs_declaration");
  // The posting cap is terminal (it resets on TIKTOK's schedule, not ours).
  assert.equal(failures.posting_cap.retryable, false);
  // Ambiguous outcomes FAIL CLOSED.
  assert.equal(failures.publish_ambiguous.retryable, false);
  assert.equal(failures.upload_task_gone.retryable, false);
  // A published row can never be downgraded: only PUBLISH_COMPLETE is proof.
  assert.equal(pub.isTikTokPublishedEvidence("PUBLISH_COMPLETE"), true);
  assert.equal(pub.isTikTokPublishedEvidence("PROCESSING_UPLOAD"), false);
  assert.equal(pub.isTikTokPublishedEvidence("SEND_TO_USER_INBOX"), false);
  assert.deepEqual([...pub.TIKTOK_PROVIDER_STATUSES], ["PROCESSING_UPLOAD", "PROCESSING_DOWNLOAD", "SEND_TO_USER_INBOX", "PUBLISH_COMPLETE", "FAILED"]);
});

test("retryable failures become terminal only after the worker has spent all its attempts", () => {
  const max = pub.MAX_TIKTOK_PUBLISH_ATTEMPTS;
  assert.equal(pub.resolveTikTokFailure("rate_limited", max - 1).status, "scheduled");
  assert.equal(pub.resolveTikTokFailure("rate_limited", max - 1).retryable, true);
  const exhausted = pub.resolveTikTokFailure("rate_limited", max);
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.retryable, false, "no aggressive retries: the allowance is the hard stop");
  assert.equal(pub.resolveTikTokFailure("posting_cap", 0).status, "failed", "a terminal failure stays terminal at any attempt count");
});

test("API error kinds map onto the taxonomy — the two documented 403s keep their own reasons", () => {
  assert.equal(pub.failureForApiError({ kind: "rate_limited" }), "rate_limited");
  assert.equal(pub.failureForApiError({ kind: "auth" }), "authorization_revoked");
  assert.equal(pub.failureForApiError({ kind: "server" }), "upload_interrupted");
  assert.equal(pub.failureForApiError({ kind: "network" }), "upload_interrupted");
  assert.equal(pub.failureForApiError({ kind: "not_found" }), "post_unavailable");
  assert.equal(pub.failureForApiError({ kind: "invalid_request", reason: "unaudited_client_can_only_post_to_private_accounts" }), "unaudited_client_restricted");
  assert.equal(pub.failureForApiError({ kind: "invalid_request", reason: "privacy_level_option_mismatch" }), "privacy_not_allowed");
  assert.equal(pub.failureForApiError({ kind: "invalid_request", reason: "something_else" }), "post_init_failed");
  assert.equal(pub.failureForApiError({ kind: "unknown" }), "unknown");
});

test("retry times align to the worker's own 5-minute cron cadence; processing expires after 72 hours", () => {
  const boundary = pub.nextTikTokCronBoundaryAfter(NOW);
  assert.equal(boundary % pub.TIKTOK_WORKER_PERIOD_MS, 0);
  assert.ok(boundary > NOW);
  const retry = Date.parse(pub.tiktokRetryAt(NOW));
  assert.ok(retry > NOW && retry <= boundary);
  assert.equal(pub.tiktokProcessingExpired(null), false);
  assert.equal(pub.tiktokProcessingExpired(nowIso(-71 * 3600_000), NOW), false);
  assert.equal(pub.tiktokProcessingExpired(nowIso(-73 * 3600_000), NOW), true, "72 hours without a provider answer is a truthful timeout, not a silent drop");
  assert.equal(pub.tiktokPublishIdempotencyKey("22222222-2222-4222-8222-222222222222"), "ttpub_22222222222242228222222222222222");
  assert.equal(pub.tiktokWillAutoPublish("provider_processing"), true);
  assert.equal(pub.tiktokWillAutoPublish("published"), false);
  assert.equal(pub.tiktokPublishStatusTone("published"), "green");
  assert.equal(pub.tiktokPublishStatusTone("posting"), "amber");
  assert.equal(pub.tiktokPublishStatusTone("failed"), "red");
});

test("worker timing: the function ceiling, the upload budget and the cron route stay in lockstep", async () => {
  assert.equal(pub.TIKTOK_WORKER_MAX_DURATION_MS, 300_000);
  assert.ok(pub.TIKTOK_UPLOAD_BUDGET_MS <= pub.TIKTOK_WORKER_MAX_DURATION_MS - pub.TIKTOK_WORKER_SAFETY_BUFFER_MS);
  const route = await read("app/api/cron/tiktok-publish/route.ts");
  assert.match(route, /maxDuration\s*=\s*300/, "the route's declared ceiling equals the worker's");
  const reconcileRoute = await read("app/api/cron/tiktok-reconcile/route.ts");
  assert.match(reconcileRoute, /maxDuration\s*=\s*300/);
});

// ---------------------------------------------------------------------------
// 4. The TikTok client against FAKE fetch responses (official shapes)
// ---------------------------------------------------------------------------

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  fn.calls = calls;
  return fn;
}

const tokenBody = {
  data: {
    open_id: "7364580667079849985",
    scope: "user.info.basic,video.publish",
    access_token: "tt-access-1",
    expires_in: 86400,
    refresh_token: "tt-refresh-1",
    refresh_expires_in: 31536000,
    token_type: "Bearer",
  },
  error: { code: "ok", message: "Success", log_id: "log-1" },
};

test("the token exchange is server-side, parses the documented 24h/365d tokens, and refuses a response without the authoritative identity", async () => {
  const seen = [];
  const fetchFn = fakeFetch((url, init) => {
    seen.push({ url, body: String(init.body) });
    return jsonResponse(200, tokenBody);
  });
  const client = new clientMod.TikTokClient(fakeConfig(), fetchFn);
  const tokens = await client.exchangeCode("auth-code-1");
  assert.equal(tokens.openId, "7364580667079849985");
  assert.equal(tokens.accessToken, "tt-access-1");
  assert.equal(tokens.refreshToken, "tt-refresh-1");
  assert.equal(tokens.expiresIn, 86400);
  assert.equal(tokens.refreshExpiresIn, 31536000);
  assert.deepEqual(tokens.grantedScopes, ["user.info.basic", "video.publish"]);
  assert.equal(seen[0].url, "https://open.tiktokapis.com/v2/oauth/token/");
  const form = new URLSearchParams(seen[0].body);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("client_key"), "tiktok-client-key");
  assert.equal(form.get("client_secret"), "tiktok-client-secret", "the secret is sent ONLY in the server-side POST body");
  assert.equal(form.get("code"), "auth-code-1");
  assert.ok(!seen[0].url.includes("tt-refresh-1"));

  // No open_id -> refuse (Voom cannot bind the connection to the provider identity).
  const noId = fakeFetch(() => jsonResponse(200, { ...tokenBody, data: { ...tokenBody.data, open_id: "" }, error: tokenBody.error }));
  await assert.rejects(new clientMod.TikTokClient(fakeConfig(), noId).exchangeCode("auth-code-1"), clientMod.TikTokApiError);

  // invalid_grant (expired/used code) classifies as an AUTH failure.
  const badGrant = fakeFetch(() => jsonResponse(400, { error: { code: "invalid_grant", message: "code expired", log_id: "x" } }));
  await assert.rejects(
    async () => new clientMod.TikTokClient(fakeConfig(), badGrant).exchangeCode("auth-code-1"),
    (err) => err instanceof clientMod.TikTokApiError && err.kind === "auth" && err.reason === "invalid_grant",
  );
});

test("a 429 or a rate code classifies as RATE LIMITED — never as an auth failure", async () => {
  const rate429 = fakeFetch(() => jsonResponse(429, { error: { code: "rate_limit_exceeded", message: "slow down", log_id: "x" } }));
  await assert.rejects(
    async () => new clientMod.TikTokClient(fakeConfig(), rate429).exchangeCode("c"),
    (err) => err instanceof clientMod.TikTokApiError && err.kind === "rate_limited",
  );
  const refresh = { ...tokenBody, data: { ...tokenBody.data, refresh_token: "tt-refresh-2" } };
  const rateCode = fakeFetch(() => jsonResponse(200, { error: { code: "api_rate_limited", message: "no", log_id: "x" } }));
  await assert.rejects(
    async () => new clientMod.TikTokClient(fakeConfig(), rateCode).refreshAccessToken("tt-refresh-1"),
    (err) => err instanceof clientMod.TikTokApiError && err.kind === "rate_limited",
  );
  void refresh;
});

test("token refresh persists the ROTATED refresh token the provider returns (the old one is dead)", async () => {
  const rotated = { ...tokenBody, data: { ...tokenBody.data, access_token: "tt-access-2", refresh_token: "tt-refresh-2" } };
  const fetchFn = fakeFetch((url) => {
    assert.equal(url, "https://open.tiktokapis.com/v2/oauth/token/");
    return jsonResponse(200, rotated);
  });
  const client = new clientMod.TikTokClient(fakeConfig(), fetchFn);
  const tokens = await client.refreshAccessToken("tt-refresh-1");
  assert.equal(tokens.refreshToken, "tt-refresh-2", "the returned refresh token is the only valid one now");
  assert.equal(tokens.accessToken, "tt-access-2");
  const form = new URLSearchParams(fetchFn.calls[0].init.body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "tt-refresh-1");
});

test("user info reads only the basic-identity fields and tolerates TikTok's envelope", async () => {
  const fetchFn = fakeFetch((url) => {
    assert.equal(new URL(url).origin + new URL(url).pathname, "https://open.tiktokapis.com/v2/user/info/");
    assert.match(new URL(url).searchParams.get("fields"), /open_id,union_id,avatar_url/);
    assert.doesNotMatch(new URL(url).searchParams.get("fields"), /follower|signature|bio/);
    return jsonResponse(200, {
      data: { user: { open_id: "7364580667079849985", union_id: "u-1", display_name: "Voom Studio", avatar_url: "https://tiktokcdn.test/a.jpg" } },
      error: { code: "ok", message: "Success", log_id: "x" },
    });
  });
  const user = await new clientMod.TikTokClient(fakeConfig(), fetchFn).getBasicUser("tt-access-1");
  assert.deepEqual(user, { openId: "7364580667079849985", unionId: "u-1", displayName: "Voom Studio", avatarUrl: "https://tiktokcdn.test/a.jpg" });
  assert.equal(fetchFn.calls[0].init.headers.Authorization, "Bearer tt-access-1");
});

test("creator info keeps ONLY the privacy options TikTok offers this creator — nothing is backfilled", async () => {
  const fetchFn = fakeFetch(() => jsonResponse(200, {
    data: {
      creator_avatar_url: "https://tiktokcdn.test/c.jpg", creator_username: "voomstudio", creator_nickname: "Voom Studio",
      privacy_level_options: ["PUBLIC_TO_EVERYONE", "SOMETHING_UNDOCUMENTED", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
      comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 180,
    },
    error: { code: "ok", message: "Success", log_id: "x" },
  }));
  const info = await new clientMod.TikTokClient(fakeConfig(), fetchFn).queryCreatorInfo("tt-access-1");
  assert.deepEqual(info.privacyLevelOptions, ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"], "undocumented options are dropped, not invented");
  assert.equal(info.creatorUsername, "voomstudio");
  assert.equal(info.duetDisabled, true);
  assert.equal(info.maxVideoPostDurationSec, 180);
});

test("Direct Post init: the bigInt publish_id survives beyond 2^53, FILE_UPLOAD source info is exact, a malformed id is refused", async () => {
  const BIG_ID = "9007199254740999123456789012345678901234567"; // 43 digits, > 2^53
  const fetchFn = fakeFetch((url, init) => {
    assert.equal(url, "https://open.tiktokapis.com/v2/post/publish/video/init/");
    const body = JSON.parse(init.body);
    assert.equal(body.post_info.privacy_level, "SELF_ONLY");
    assert.deepEqual(body.source_info, { source: "FILE_UPLOAD", video_size: 1024, chunk_size: 1024, total_chunk_count: 1 });
    return jsonResponse(200, {
      data: { publish_id: BIG_ID, upload_url: "https://upload.tiktok.test/task?token=abc" },
      error: { code: "ok", message: "Success", log_id: "x" },
    });
  });
  const client = new clientMod.TikTokClient(fakeConfig(), fetchFn);
  const started = await client.initDirectPost("tt-access-1", { post_info: { title: "t", privacy_level: "SELF_ONLY" } }, {
    source: "FILE_UPLOAD", video_size: 1024, chunk_size: 1024, total_chunk_count: 1,
  });
  assert.equal(started.publishId, BIG_ID, "the id stays EXACT — a rounded id would track the wrong post");
  assert.equal(started.uploadUrl, "https://upload.tiktok.test/task?token=abc");

  // A publish_id beyond the documented 64 chars is never stored.
  const long = fakeFetch(() => jsonResponse(200, {
    data: { publish_id: "9".repeat(65), upload_url: "https://upload.tiktok.test/x" },
    error: { code: "ok", message: "Success", log_id: "x" },
  }));
  await assert.rejects(
    async () => new clientMod.TikTokClient(fakeConfig(), long).initDirectPost("a", {}, { source: "FILE_UPLOAD", video_size: 1, chunk_size: 1, total_chunk_count: 1 }),
    (err) => err instanceof clientMod.TikTokApiError && err.reason === "malformed_publish_id",
  );
  // No upload_url (e.g. PULL_FROM_URL mode) — Voom is FILE_UPLOAD-only and refuses to guess.
  const noUrl = fakeFetch(() => jsonResponse(200, {
    data: { publish_id: "1234567890123456789" },
    error: { code: "ok", message: "Success", log_id: "x" },
  }));
  await assert.rejects(
    async () => new clientMod.TikTokClient(fakeConfig(), noUrl).initDirectPost("a", {}, { source: "FILE_UPLOAD", video_size: 1, chunk_size: 1, total_chunk_count: 1 }),
    (err) => err instanceof clientMod.TikTokApiError && err.reason === "missing_upload_url",
  );
});

test("the two documented 403 policy errors keep their exact codes for the failure taxonomy", async () => {
  const unaudited = fakeFetch(() => jsonResponse(403, {
    error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "unaudited client", log_id: "x" },
  }));
  await assert.rejects(
    async () => new clientMod.TikTokClient(fakeConfig(), unaudited).initDirectPost("a", {}, { source: "FILE_UPLOAD", video_size: 1, chunk_size: 1, total_chunk_count: 1 }),
    (err) => err instanceof clientMod.TikTokApiError && err.reason === "unaudited_client_can_only_post_to_private_accounts",
  );
  const mismatch = fakeFetch(() => jsonResponse(403, {
    error: { code: "privacy_level_option_mismatch", message: "not offered", log_id: "x" },
  }));
  await assert.rejects(
    async () => new clientMod.TikTokClient(fakeConfig(), mismatch).initDirectPost("a", {}, { source: "FILE_UPLOAD", video_size: 1, chunk_size: 1, total_chunk_count: 1 }),
    (err) => err instanceof clientMod.TikTokApiError && err.reason === "privacy_level_option_mismatch",
  );
});

test("chunk upload: 200+Content-Range is progress, 416 re-syncs to TikTok's actual position, 404 is the gone signal, 5xx is transient", async () => {
  const complete = fakeFetch(() => jsonResponse(200, null, { "content-range": "bytes 0-1023/1024" }));
  const okResult = await new clientMod.TikTokClient(fakeConfig(), complete).uploadChunk("https://upload.tiktok.test/x", new Uint8Array(1024), "video/mp4", "bytes 0-1023/1024", 1024);
  assert.deepEqual(okResult, { outcome: "complete", uploadedBytes: 1024 });
  assert.equal(complete.calls[0].init.method, "PUT");
  assert.equal(complete.calls[0].init.headers["Content-Range"], "bytes 0-1023/1024");
  assert.equal(complete.calls[0].init.headers["Content-Length"], "1024");

  const mismatch = fakeFetch(() => jsonResponse(416, null, { "content-range": "bytes 0-511/1024" }));
  const mis = await new clientMod.TikTokClient(fakeConfig(), mismatch).uploadChunk("https://upload.tiktok.test/x", new Uint8Array(512), "video/mp4", "bytes 512-1023/1024", 512);
  assert.deepEqual(mis, { outcome: "range_mismatch", uploadedBytes: 512 }, "416 tells us where TikTok REALLY is");

  const gone = fakeFetch(() => jsonResponse(404, { error: { code: "not_found", message: "task gone", log_id: "x" } }));
  assert.deepEqual(await new clientMod.TikTokClient(fakeConfig(), gone).uploadChunk("u", new Uint8Array(1), "video/mp4", "bytes 0-0/1", 1), { outcome: "gone" });

  const server = fakeFetch(() => jsonResponse(503, { error: { code: "server_error", message: "down", log_id: "x" } }));
  await assert.rejects(
    async () => new clientMod.TikTokClient(fakeConfig(), server).uploadChunk("u", new Uint8Array(1), "video/mp4", "bytes 0-0/1", 1),
    (err) => err instanceof clientMod.TikTokApiError && err.kind === "server",
  );
  const network = fakeFetch(() => { throw new Error("socket hang up"); });
  await assert.rejects(
    async () => new clientMod.TikTokClient(fakeConfig(), network).uploadChunk("u", new Uint8Array(1), "video/mp4", "bytes 0-0/1", 1),
    (err) => err instanceof clientMod.TikTokApiError && err.kind === "network",
  );
});

test("post status: PUBLISH_COMPLETE is the only evidence, invalid_publish_id means the post does not exist, 5xx is transient", async () => {
  const status = fakeFetch((url, init) => {
    assert.equal(url, "https://open.tiktokapis.com/v2/post/publish/status/fetch/");
    const body = JSON.parse(init.body);
    assert.equal(body.publish_id, "7364580667079849985");
    return jsonResponse(200, {
      data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["7364580667079849986"], fail_reason: "" },
      error: { code: "ok", message: "Success", log_id: "x" },
    });
  });
  const read = await new clientMod.TikTokClient(fakeConfig(), status).fetchPostStatus("tt-access-1", "7364580667079849985");
  assert.equal(read.status, "PUBLISH_COMPLETE");
  assert.deepEqual(read.postIds, ["7364580667079849986"]);

  const failed = fakeFetch(() => jsonResponse(200, {
    data: { status: "FAILED", publicaly_available_post_id: [], fail_reason: "creator frequency limit exceeded" },
    error: { code: "ok", message: "Success", log_id: "x" },
  }));
  const failRead = await new clientMod.TikTokClient(fakeConfig(), failed).fetchPostStatus("a", "123");
  assert.equal(failRead.status, "FAILED");
  assert.equal(failRead.failReason, "creator frequency limit exceeded");

  const missing = fakeFetch(() => jsonResponse(400, {
    error: { code: "invalid_publish_id", message: "no such post", log_id: "x" },
  }));
  await assert.rejects(
    async () => new clientMod.TikTokClient(fakeConfig(), missing).fetchPostStatus("a", "123"),
    (err) => err instanceof clientMod.TikTokApiError && err.kind === "not_found" && err.reason === "invalid_publish_id",
  );
  const wrongOwner = fakeFetch(() => jsonResponse(400, {
    error: { code: "token_not_authorized_for_specified_publish_id", message: "not yours", log_id: "x" },
  }));
  await assert.rejects(
    async () => new clientMod.TikTokClient(fakeConfig(), wrongOwner).fetchPostStatus("a", "123"),
    (err) => err instanceof clientMod.TikTokApiError && err.kind === "not_found",
  );
  // A malformed publish id is refused BEFORE any request leaves the process.
  const malformed = fakeFetch(() => jsonResponse(200, { data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok", message: "s", log_id: "x" } }));
  await assert.rejects(
    async () => new clientMod.TikTokClient(fakeConfig(), malformed).fetchPostStatus("a", "nope/with/slashes"),
    (err) => err instanceof clientMod.TikTokApiError && err.reason === "publish_id_shape",
  );
  assert.equal(malformed.calls.length, 0, "no request was sent for a fabricated id");
});

test("revocation is best-effort: a network failure reports false, it never throws", async () => {
  const ok = fakeFetch(() => jsonResponse(200, { error: { code: "ok", message: "Success", log_id: "x" } }));
  assert.equal(await new clientMod.TikTokClient(fakeConfig(), ok).revokeAccessToken("tt-access-1"), true);
  const down = fakeFetch(() => { throw new Error("econnreset"); });
  assert.equal(await new clientMod.TikTokClient(fakeConfig(), down).revokeAccessToken("tt-access-1"), false);
});

// ---------------------------------------------------------------------------
// 5. The publish flow against fake ports — documented order, fail-closed
// ---------------------------------------------------------------------------

const BASE_ITEM = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  ownerUserId: OWNER_A,
  draftId: "22222222-2222-4222-8222-222222222222",
  status: "posting",
  title: "Launch teaser",
  privacyLevel: "SELF_ONLY",
  disableComment: null,
  disableDuet: null,
  disableStitch: null,
  brandContentToggle: null,
  brandOrganicToggle: null,
  isAigc: null,
  attempts: 1,
  publishId: null,
  uploadUrl: null,
  contentLength: null,
  bytesSent: 0,
  lastAttemptAt: null,
  providerPostId: null,
};

function fakePorts(overrides = {}) {
  const calls = [];
  // Record the real arguments: calls[i] = [name, ...args].
  const record = (name) => (async (...args) => {
    calls.push([name, ...args]);
    if (overrides[name]) return overrides[name](...args);
    return undefined;
  });
  const ports = {
    calls,
    appAudited: overrides.appAudited ?? false,
    now: overrides.now ?? (() => NOW),
    remainingBudgetMs: overrides.remainingBudgetMs,
    sleep: async (ms) => { calls.push(["sleep", { ms }]); },
    async loadDraft() { calls.push(["loadDraft"]); return "draft" in overrides ? overrides.draft : { status: "approved" }; },
    async loadConnection() { calls.push(["loadConnection"]); return "connection" in overrides ? overrides.connection : { status: "connected", scopes: [...scopesMod.TIKTOK_SCOPES] }; },
    async loadCredentials() { calls.push(["loadCredentials"]); if (overrides.credentialError) throw overrides.credentialError; return { openId: "7364580667079849985", accessToken: "tt-access-1" }; },
    async loadAsset() {
      calls.push(["loadAsset"]);
      return "asset" in overrides ? overrides.asset : { status: "uploaded", mimeType: "video/mp4", byteSize: 1024, storagePath: "tiktok/a/video.mp4" };
    },
    async openMediaRange(storagePath, start, end) { calls.push(["openMediaRange", { start, end }]); return new Uint8Array(end - start + 1); },
    async queryCreatorInfo() { calls.push(["queryCreatorInfo"]); if (overrides.creatorInfoError) throw overrides.creatorInfoError; return "creatorInfo" in overrides ? overrides.creatorInfo : fakeCreatorInfo(); },
    async initDirectPost(accessToken, metadata, sourceInfo) { calls.push(["initDirectPost", { metadata, sourceInfo }]); if (overrides.initError) throw overrides.initError; return { publishId: "7364580667079849990", uploadUrl: "https://upload.tiktok.test/task" }; },
    async putChunk(input) {
      calls.push(["putChunk", { contentRange: input.contentRange }]);
      if (overrides.putChunkError) throw overrides.putChunkError;
      if (overrides.putChunkResult) return overrides.putChunkResult;
      // The real TikTok 200 response reports CUMULATIVE progress in the
      // Content-Range header (`bytes 0-N/total`), so a faithful fake derives
      // it from the window's end, not the chunk's length.
      const m = /-(\d+)\/\d+$/.exec(input.contentRange);
      return { outcome: "complete", uploadedBytes: m ? Number(m[1]) + 1 : input.contentLength };
    },
    async fetchPostStatus(accessToken, publishId) {
      calls.push(["fetchPostStatus", { publishId }]);
      if (overrides.statusError) throw overrides.statusError;
      if (overrides.statuses) { const next = overrides.statuses.shift(); if (next) return next; }
      return { status: "PUBLISH_COMPLETE", postIds: [], failReason: null };
    },
    persistPublish: record("persistPublish"),
    persistProgress: record("persistProgress"),
    recordProviderStatus: record("recordProviderStatus"),
    enterProviderProcessing: record("enterProviderProcessing"),
    markPublished: record("markPublished"),
    markFailed: record("markFailed"),
    reArmForResubmit: record("reArmForResubmit"),
  };
  return ports;
}

const callNames = (ports) => ports.calls.map(([name]) => name);

test("the flow follows the documented order: approval re-check, connection+scopes, privacy, creator info, validated options, init, bytes, evidence", async () => {
  const ports = fakePorts({
    statuses: [{ status: "PROCESSING_UPLOAD", postIds: [], failReason: null }, { status: "PUBLISH_COMPLETE", postIds: [], failReason: null }],
  });
  const result = await flowMod.runTikTokPublishFlow({ ...BASE_ITEM }, ports);
  assert.equal(result.outcome, "published");
  assert.equal(result.code, "PUBLISH_COMPLETE");
  const names = callNames(ports);
  const order = [
    "loadDraft", "loadConnection", "loadCredentials", "loadAsset",
    "queryCreatorInfo", "initDirectPost", "persistPublish",
    "openMediaRange", "putChunk", "persistProgress",
    "enterProviderProcessing",
    "loadCredentials", "fetchPostStatus", "recordProviderStatus",
    "sleep", "fetchPostStatus", "recordProviderStatus",
    "markPublished",
  ];
  assert.deepEqual(names, order, "creator info BEFORE init; the publish id persisted BEFORE the first byte; evidence before markPublished");
  assert.ok(names.indexOf("queryCreatorInfo") < names.indexOf("initDirectPost"), "documented order: creator info before every fresh post");
  assert.ok(names.indexOf("persistPublish") < names.indexOf("putChunk"), "the publish id is persisted before any byte leaves the process");
  assert.ok(names.indexOf("enterProviderProcessing") < names.indexOf("fetchPostStatus"), "only then does the provider own the row");
  const init = ports.calls.find(([n]) => n === "initDirectPost")[1];
  assert.deepEqual(init.metadata, { post_info: { title: "Launch teaser", privacy_level: "SELF_ONLY" } });
  assert.deepEqual(init.sourceInfo, { videoSize: 1024, chunkSize: 1024, totalChunkCount: 1 });
  // A private post of an unaudited client gets NO post id — that is not a failure.
  assert.equal(result.providerPostId, null);
  const published = ports.calls.find(([n]) => n === "markPublished");
  assert.match(String(published[3]), /unaudited|private/i, "the unaudited-private note travels with the publication");
});

test("without a privacy declaration the item parks in needs_declaration — Voom never chooses a policy-sensitive value", async () => {
  const ports = fakePorts();
  const result = await flowMod.runTikTokPublishFlow({ ...BASE_ITEM, privacyLevel: null }, ports);
  assert.equal(result.outcome, "failed");
  assert.equal(result.code, "privacy_declaration_required");
  assert.ok(!callNames(ports).includes("queryCreatorInfo"), "no provider call is made for an undeclared item");
  const failed = ports.calls.find(([n]) => n === "markFailed");
  assert.equal(failed[2].status, "needs_declaration");
});

test("the draft's approval is re-verified at publish time; a no-longer-approved draft is never posted", async () => {
  const ports = fakePorts({ draft: { status: "pending" } });
  const result = await flowMod.runTikTokPublishFlow({ ...BASE_ITEM }, ports);
  assert.equal(result.code, "not_approved");
  assert.equal(result.outcome, "failed");
  assert.ok(!callNames(ports).includes("initDirectPost"));
});

test("a disconnected or unscoped connection fails truthfully before any provider call", async () => {
  const disconnected = fakePorts({ connection: null });
  assert.equal((await flowMod.runTikTokPublishFlow({ ...BASE_ITEM }, disconnected)).code, "tiktok_not_connected");
  const wrongScopes = fakePorts({ connection: { status: "connected", scopes: [scopesMod.TIKTOK_BASIC_SCOPE] } });
  const scoped = await flowMod.runTikTokPublishFlow({ ...BASE_ITEM }, wrongScopes);
  assert.equal(scoped.code, "tiktok_publish_permission_required");
  assert.equal(scoped.outcome, "failed");
  assert.ok(!callNames(wrongScopes).includes("initDirectPost"));
  const revoked = fakePorts({ connection: { status: "revoked", scopes: [...scopesMod.TIKTOK_SCOPES] } });
  assert.equal((await flowMod.runTikTokPublishFlow({ ...BASE_ITEM }, revoked)).code, "tiktok_not_connected");
});

test("creator info auth failure is a reconnection problem; a rate limit parks without consuming a real attempt; a network blip is transient", async () => {
  const auth = fakePorts({ creatorInfoError: new clientMod.TikTokApiError("auth", "creator_info", "access_token_invalid", 401) });
  const authResult = await flowMod.runTikTokPublishFlow({ ...BASE_ITEM }, auth);
  assert.equal(authResult.code, "authorization_revoked");
  assert.equal(authResult.outcome, "failed");

  const rate = fakePorts({ creatorInfoError: new clientMod.TikTokApiError("rate_limited", "creator_info", "rate_limit_exceeded", 429) });
  const rateResult = await flowMod.runTikTokPublishFlow({ ...BASE_ITEM }, rate);
  assert.equal(rateResult.code, "rate_limited");
  assert.equal(rateResult.outcome, "retrying");
  const rateFailed = rate.calls.find(([n]) => n === "markFailed");
  assert.equal(rateFailed[2].status, "scheduled");
  assert.ok(rateFailed[2].retryAt, "the retry waits for the next cron boundary");

  const network = fakePorts({ creatorInfoError: new clientMod.TikTokApiError("network", "creator_info") });
  const netResult = await flowMod.runTikTokPublishFlow({ ...BASE_ITEM }, network);
  assert.equal(netResult.code, "post_init_failed");
  assert.equal(netResult.outcome, "retrying");
});

test("a privacy choice TikTok no longer offers is refused BEFORE init — the live options win over the stored declaration", async () => {
  const ports = fakePorts({ creatorInfo: fakeCreatorInfo({ privacyLevelOptions: ["MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"] }) });
  const result = await flowMod.runTikTokPublishFlow({ ...BASE_ITEM, privacyLevel: "FOLLOWER_OF_CREATOR" }, ports);
  assert.equal(result.code, "privacy_option_not_offered");
  assert.equal(result.outcome, "failed");
  assert.ok(!callNames(ports).includes("initDirectPost"), "no post is started for an unoffered option");
  const failed = ports.calls.find(([n]) => n === "markFailed");
  assert.equal(failed[2].status, "needs_declaration");
});

test("the unaudited-client 403 at init is a REAL provider restriction: terminal, distinct, no re-post with different privacy", async () => {
  // The public account offers PUBLIC_TO_EVERYONE, so the live-options check
  // passes and the provider's audit refusal is the answer under test.
  const ports = fakePorts({
    creatorInfo: fakeCreatorInfo({ privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"] }),
    initError: new clientMod.TikTokApiError("invalid_request", "direct_post_init", "unaudited_client_can_only_post_to_private_accounts", 403),
  });
  const result = await flowMod.runTikTokPublishFlow({ ...BASE_ITEM, privacyLevel: "PUBLIC_TO_EVERYONE" }, ports);
  assert.equal(result.code, "unaudited_client_restricted");
  assert.equal(result.outcome, "failed");
  const failed = ports.calls.find(([n]) => n === "markFailed");
  assert.equal(failed[2].status, "failed");
  assert.equal(failed[2].retryAt, null, "re-posting with a different privacy on the creator's behalf is not an option");
});

test("init failures: rate parks, auth reconnects, generic 400 is a transient init failure", async () => {
  const rate = fakePorts({ initError: new clientMod.TikTokApiError("rate_limited", "direct_post_init", "api_rate_limited", 429) });
  assert.equal((await flowMod.runTikTokPublishFlow({ ...BASE_ITEM }, rate)).code, "rate_limited");
  const auth = fakePorts({ initError: new clientMod.TikTokApiError("auth", "direct_post_init", "access_token_invalid", 401) });
  assert.equal((await flowMod.runTikTokPublishFlow({ ...BASE_ITEM }, auth)).code, "authorization_revoked");
  const generic = fakePorts({ initError: new clientMod.TikTokApiError("invalid_request", "direct_post_init", "bad_request", 400) });
  const genericResult = await flowMod.runTikTokPublishFlow({ ...BASE_ITEM }, generic);
  assert.equal(genericResult.code, "post_init_failed");
  assert.equal(genericResult.outcome, "retrying");
});

test("media validation: missing, unsupported and oversized media never reach the provider", async () => {
  const missing = fakePorts({ asset: null });
  const missingResult = await flowMod.runTikTokPublishFlow({ ...BASE_ITEM }, missing);
  assert.equal(missingResult.code, "media_missing");
  assert.equal(missingResult.outcome, "retrying");
  const unsupported = fakePorts({ asset: { status: "uploaded", mimeType: "video/x-matroska", byteSize: 1024, storagePath: "p" } });
  const unsupportedResult = await flowMod.runTikTokPublishFlow({ ...BASE_ITEM }, unsupported);
  assert.equal(unsupportedResult.code, "media_unsupported");
  assert.equal(unsupportedResult.outcome, "failed");
  const tooLarge = fakePorts({ asset: { status: "uploaded", mimeType: "video/mp4", byteSize: pub.TIKTOK_MAX_VIDEO_BYTES + 1, storagePath: "p" } });
  const tooLargeResult = await flowMod.runTikTokPublishFlow({ ...BASE_ITEM }, tooLarge);
  assert.equal(tooLargeResult.code, "media_too_large");
  assert.equal(tooLargeResult.outcome, "failed");
  assert.ok(!callNames(tooLarge).includes("initDirectPost"));
});

test("resume: a persisted publish id means NO creator-info and NO re-init — bytes continue from TikTok's own progress", async () => {
  const MB = 1024 * 1024;
  // 200 MB file, 64 MB chunks (3 chunks). The first chunk is already with
  // TikTok (64 MB persisted), so the transfer resumes at the 64 MB boundary.
  const item = { ...BASE_ITEM, publishId: "7364580667079849991", uploadUrl: "https://upload.tiktok.test/task", contentLength: 200 * MB, bytesSent: 64 * MB };
  const ports = fakePorts({
    asset: { status: "uploaded", mimeType: "video/mp4", byteSize: 200 * MB, storagePath: "tiktok/a/video.mp4" },
    statuses: [{ status: "PUBLISH_COMPLETE", postIds: [], failReason: null }],
  });
  const result = await flowMod.runTikTokPublishFlow(item, ports);
  assert.equal(result.outcome, "published");
  assert.ok(!callNames(ports).includes("queryCreatorInfo"), "the provider already owns this post — the live options no longer matter");
  assert.ok(!callNames(ports).includes("initDirectPost"), "a second post is structurally impossible");
  const ranges = ports.calls.filter(([n]) => n === "putChunk").map(([, e]) => e.contentRange);
  assert.deepEqual(ranges, [
    `bytes ${64 * MB}-${128 * MB - 1}/${200 * MB}`,
    `bytes ${128 * MB}-${200 * MB - 1}/${200 * MB}`,
  ], "the resume starts at the persisted chunk boundary and runs to the end");
  const progress = ports.calls.filter(([n]) => n === "persistProgress").map(([, , bytesSent]) => bytesSent);
  assert.deepEqual(progress, [128 * MB, 200 * MB], "TikTok's own cumulative progress is persisted chunk by chunk");
});

test("a 416 that reports TikTok's true position re-syncs the resume instead of re-sending", async () => {
  const MB = 1024 * 1024;
  const item = { ...BASE_ITEM, publishId: "7364580667079849911", uploadUrl: "u", contentLength: 200 * MB, bytesSent: 64 * MB };
  let mismatchCount = 0;
  const ports = fakePorts({
    asset: { status: "uploaded", mimeType: "video/mp4", byteSize: 200 * MB, storagePath: "p" },
    statuses: [{ status: "PUBLISH_COMPLETE", postIds: [], failReason: null }],
  });
  const originalPut = ports.putChunk.bind(ports);
  ports.putChunk = async (input) => {
    await originalPut(input);
    if (mismatchCount === 0) {
      mismatchCount += 1;
      // TikTok says it actually already has 96 MB: the next window must start there.
      return { outcome: "range_mismatch", uploadedBytes: 96 * MB };
    }
    const m = /-(\d+)\/\d+$/.exec(input.contentRange);
    return { outcome: "complete", uploadedBytes: Number(m[1]) + 1 };
  };
  const result = await flowMod.runTikTokPublishFlow(item, ports);
  assert.equal(result.outcome, "published");
  const progress = ports.calls.filter(([n]) => n === "persistProgress").map(([, , bytesSent]) => bytesSent);
  assert.ok(progress.includes(96 * MB), "the 416 position (96 MB) is persisted before continuing");
  assert.ok(progress.includes(200 * MB));
});

test("a 416 that did not advance progress parks instead of looping; a 404 mid-upload fails CLOSED with the id retained", async () => {
  const MB = 1024 * 1024;
  const stalled = fakePorts({
    asset: { status: "uploaded", mimeType: "video/mp4", byteSize: 3 * MB, storagePath: "p" },
    putChunkResult: { outcome: "range_mismatch", uploadedBytes: 0 },
  });
  const stalledItem = { ...BASE_ITEM, publishId: "7364580667079849992", uploadUrl: "u", contentLength: 3 * MB, bytesSent: 2 * MB };
  const stalledResult = await flowMod.runTikTokPublishFlow(stalledItem, stalled);
  assert.equal(stalledResult.code, "upload_interrupted");
  assert.equal(stalledResult.outcome, "retrying");

  const gone = fakePorts({
    asset: { status: "uploaded", mimeType: "video/mp4", byteSize: 3 * MB, storagePath: "p" },
    putChunkError: new clientMod.TikTokApiError("not_found", "upload_chunk", null, 404),
  });
  const goneItem = { ...BASE_ITEM, publishId: "7364580667079849993", uploadUrl: "u", contentLength: 3 * MB, bytesSent: 1 * MB };
  const goneResult = await flowMod.runTikTokPublishFlow(goneItem, gone);
  assert.equal(goneResult.code, "upload_task_gone");
  assert.equal(goneResult.outcome, "failed");
  const failed = gone.calls.find(([n]) => n === "markFailed");
  assert.equal(failed[2].status, "failed");
  assert.equal(failed[2].retryAt, null, "no blind retry: reconciliation reads the status read-only");
});

test("the wall-clock budget parks the upload mid-transfer; the next claim resumes, it does not restart", async () => {
  const item = { ...BASE_ITEM, privacyLevel: "SELF_ONLY" };
  let budget = 1000; // below the 15s per-call allowance before the first chunk
  const ports = fakePorts({ remainingBudgetMs: () => budget });
  const result = await flowMod.runTikTokPublishFlow(item, ports);
  assert.equal(result.code, "upload_interrupted");
  assert.equal(result.outcome, "retrying");
  assert.equal(ports.calls.filter(([n]) => n === "putChunk").length, 0);
  const failed = ports.calls.find(([n]) => n === "markFailed");
  assert.equal(failed[2].status, "scheduled");
  assert.ok(failed[2].retryAt);
});

test("stored media that changed after init fails CLOSED instead of corrupting the post with different bytes", async () => {
  const item = { ...BASE_ITEM, publishId: "7364580667079849994", uploadUrl: "u", contentLength: 1024, bytesSent: 0 };
  const ports = fakePorts({ asset: { status: "uploaded", mimeType: "video/mp4", byteSize: 2048, storagePath: "p" } });
  const result = await flowMod.runTikTokPublishFlow(item, ports);
  assert.equal(result.code, "publish_ambiguous");
  assert.equal(result.outcome, "failed");
  assert.ok(!callNames(ports).includes("putChunk"));
});

test("evidence collection: PUBLISH_COMPLETE publishes, FAILED carries TikTok's own reason, processing keeps polling without consuming attempts", async () => {
  // 1) Published:
  const published = fakePorts({
    statuses: [{ status: "PROCESSING_UPLOAD", postIds: [], failReason: null }, { status: "PUBLISH_COMPLETE", postIds: ["7364580667079849987"], failReason: "" }],
  });
  const publishedItem = { ...BASE_ITEM, publishId: "7364580667079849995", uploadUrl: "u", contentLength: 1024, bytesSent: 1024 };
  const pubResult = await flowMod.runTikTokPublishFlow(publishedItem, published);
  assert.equal(pubResult.outcome, "published");
  assert.equal(pubResult.providerPostId, "7364580667079849987");
  assert.equal(published.calls.filter(([n]) => n === "fetchPostStatus").length, 2, "it polled until the evidence arrived");

  // 2) Rejected with a cap-like reason:
  const cap = fakePorts({ statuses: [{ status: "FAILED", postIds: [], failReason: "creator frequency limit exceeded" }] });
  const capItem = { ...BASE_ITEM, publishId: "7364580667079849996", uploadUrl: "u", contentLength: 1024, bytesSent: 1024 };
  const capResult = await flowMod.runTikTokPublishFlow(capItem, cap);
  assert.equal(capResult.code, "posting_cap_reached", "a cap reason is classified as the cap, not a generic rejection");
  assert.equal(capResult.outcome, "failed");
  const capFailed = cap.calls.find(([n]) => n === "markFailed");
  assert.equal(capFailed[2].status, "failed");
  assert.match(capFailed[2].message, /limit/i);

  // 3) Rejected with a content reason:
  const rejected = fakePorts({ statuses: [{ status: "FAILED", postIds: [], failReason: "video content not allowed" }] });
  const rejectedItem = { ...BASE_ITEM, publishId: "7364580667079849997", uploadUrl: "u", contentLength: 1024, bytesSent: 1024 };
  const rejectedResult = await flowMod.runTikTokPublishFlow(rejectedItem, rejected);
  assert.equal(rejectedResult.code, "provider_rejected");

  // 4) Still processing after the full poll budget: the row STAYS in provider processing.
  const processing = fakePorts({ statuses: Array.from({ length: 30 }, () => ({ status: "PROCESSING_UPLOAD", postIds: [], failReason: null })) });
  const processingItem = { ...BASE_ITEM, publishId: "7364580667079849998", uploadUrl: "u", contentLength: 1024, bytesSent: 1024 };
  const processingResult = await flowMod.runTikTokPublishFlow(processingItem, processing);
  assert.equal(processingResult.outcome, "processing");
  assert.equal(processingResult.code, "provider_processing");
  assert.equal(processing.calls.filter(([n]) => n === "markFailed").length, 0, "waiting for TikTok is NOT a failure");
  assert.equal(processing.calls.filter(([n]) => n === "markPublished").length, 0, "no evidence, no publication");
});

test("processing that never ends expires after 72 hours — a truthful timeout, not a silent drop", async () => {
  const ports = fakePorts({
    now: () => NOW + 73 * 3600_000,
    statuses: Array.from({ length: 30 }, () => ({ status: "PROCESSING_UPLOAD", postIds: [], failReason: null })),
  });
  const item = { ...BASE_ITEM, publishId: "7364580667079849999", uploadUrl: "u", contentLength: 1024, bytesSent: 1024, lastAttemptAt: nowIso(0) };
  const result = await flowMod.runTikTokPublishFlow(item, ports);
  assert.equal(result.code, "processing_timeout");
  assert.equal(result.outcome, "failed");
  const failed = ports.calls.find(([n]) => n === "markFailed");
  assert.equal(failed[2].status, "failed");
});

test("evidence reads: invalid_publish_id on a hand-off row re-arms GUARDED (TikTok itself attested the post does not exist)", async () => {
  const item = { ...BASE_ITEM, publishId: "7364580667080000000", uploadUrl: "u", contentLength: 1024, bytesSent: 1024 };
  // Without the hand-off flag: truthfully failed, no re-arm.
  const plain = fakePorts({ statusError: new clientMod.TikTokApiError("not_found", "post_status", "invalid_publish_id", 400) });
  const plainResult = await flowMod.runTikTokPublishFlow(item, plain);
  assert.equal(plainResult.code, "post_unavailable");
  assert.equal(plain.calls.filter(([n]) => n === "reArmForResubmit").length, 0);

  // With forceEvidenceOnly (the reconciliation hand-off): the guarded re-arm is allowed.
  const handOff = fakePorts({ statusError: new clientMod.TikTokApiError("not_found", "post_status", "invalid_publish_id", 400) });
  const handOffResult = await flowMod.runTikTokPublishFlow(item, handOff, { forceEvidenceOnly: true });
  assert.equal(handOffResult.code, "post_unavailable");
  assert.equal(handOffResult.outcome, "failed");
  assert.equal(handOff.calls.filter(([n]) => n === "reArmForResubmit").length, 1, "the provider's own answer is the no-duplicate attestation");
  assert.equal(handOff.calls.filter(([n]) => n === "initDirectPost").length, 0, "and still NO re-init inside the flow — the fresh start happens on a later claim of the re-armed row");
});

test("evidence reads: auth failure re-parks for reconnection; rate limit and transient reads retry WITHOUT consuming a claim", async () => {
  const auth = fakePorts({ statusError: new clientMod.TikTokApiError("auth", "post_status", "access_token_invalid", 401) });
  const authItem = { ...BASE_ITEM, publishId: "7364580667080000001", uploadUrl: "u", contentLength: 1024, bytesSent: 1024 };
  const authResult = await flowMod.runTikTokPublishFlow(authItem, auth, { forceEvidenceOnly: true });
  assert.equal(authResult.code, "authorization_revoked");
  const authFailed = auth.calls.find(([n]) => n === "markFailed");
  assert.equal(authFailed[2].status, "permission_required");

  const rate = fakePorts({ statusError: new clientMod.TikTokApiError("rate_limited", "post_status", "rate_limit_exceeded", 429) });
  const rateResult = await flowMod.runTikTokPublishFlow({ ...authItem }, rate, { forceEvidenceOnly: true });
  assert.equal(rateResult.outcome, "retrying");
  assert.equal(rateResult.code, "rate_limited");
  assert.equal(rate.calls.filter(([n]) => n === "markFailed").length, 0, "a rate-limited read is not a failure at all");

  const transient = fakePorts({ statusError: new clientMod.TikTokApiError("server", "post_status", null, 503) });
  const transientResult = await flowMod.runTikTokPublishFlow({ ...authItem }, transient, { forceEvidenceOnly: true });
  assert.equal(transientResult.outcome, "retrying");
  assert.equal(transientResult.code, "evidence_read_failed");
  assert.equal(transient.calls.filter(([n]) => n === "markFailed").length, 0);
});

test("retry exhaustion: a retryable failure becomes terminal once the attempts are spent", async () => {
  const ports = fakePorts({ creatorInfoError: new clientMod.TikTokApiError("network", "creator_info") });
  const item = { ...BASE_ITEM, attempts: pub.MAX_TIKTOK_PUBLISH_ATTEMPTS };
  const result = await flowMod.runTikTokPublishFlow(item, ports);
  assert.equal(result.outcome, "failed", "no aggressive retries — the allowance is exhausted");
  const failed = ports.calls.find(([n]) => n === "markFailed");
  assert.equal(failed[2].status, "failed");
  assert.equal(failed[2].retryAt, null);
});

// ---------------------------------------------------------------------------
// 6. Migration 0049 + the queue RPCs on a REAL embedded PostgreSQL
// ---------------------------------------------------------------------------

test("migration 0049 applies cleanly, creates the four tables, and every one has RLS enabled", async () => {
  const { applied } = await liteDb();
  assert.ok(applied.includes("0049_tiktok_provider.sql"), "0049 applied through PGlite");
  const tables = await all(
    "select table_name from information_schema.tables where table_schema = 'public' and table_name like 'tiktok_%' order by table_name",
  );
  assert.deepEqual(tables.map((row) => row.table_name), [
    "tiktok_connection_secrets", "tiktok_connections", "tiktok_oauth_states", "tiktok_publish_queue",
  ]);
  for (const table of tables.map((row) => row.table_name)) {
    const rls = await one("select relrowsecurity from pg_class where oid = $1::regclass", [`public.${table}`]);
    assert.equal(rls.relrowsecurity, true, `${table} has RLS enabled`);
  }
});

test("oauth state is strong, owner-bound, expiring and SINGLE-USE — replays and other owners fail closed", async () => {
  const { admin, db } = await liteDb();
  const state = await dataMod.createTikTokOAuthState(admin, OWNER_A);
  assert.equal(Buffer.from(state, "base64url").length, 32, "256 bits of entropy");
  const row = await one(
    "select owner_user_id, expires_at, consumed_at, state_hash from public.tiktok_oauth_states where owner_user_id = $1 order by created_at desc limit 1",
    [OWNER_A],
  );
  assert.equal(row.owner_user_id, OWNER_A);
  assert.ok(Date.parse(row.expires_at) > Date.now(), "it expires");
  assert.match(row.state_hash, /^[0-9a-f]{64}$/, "only a SHA-256 hash is stored — the raw state never touches the database");
  assert.ok(!JSON.stringify(row).includes(state), "the raw state is not stored");
  const stateHash = row.state_hash;

  // Correct owner + matching cookie + unconsumed: succeeds ONCE.
  assert.equal(await dataMod.consumeTikTokOAuthState(admin, OWNER_A, state, state), true);
  // Replay of the captured callback URL: consumed row, fails.
  assert.equal(await dataMod.consumeTikTokOAuthState(admin, OWNER_A, state, state), false, "single-use");
  // Another owner cannot consume it even with a matching cookie.
  assert.equal(await dataMod.consumeTikTokOAuthState(admin, OWNER_B, state, state), false, "owner-bound");
  // Cookie mismatch: constant-time refusal.
  const other = await dataMod.createTikTokOAuthState(admin, OWNER_A);
  assert.equal(await dataMod.consumeTikTokOAuthState(admin, OWNER_A, other, other + "x"), false);
  // Expired state: fails.
  const expired = await dataMod.createTikTokOAuthState(admin, OWNER_A);
  const { createHash } = await import("node:crypto");
  const expiredHash = createHash("sha256").update(expired).digest("hex");
  assert.equal(expiredHash.length, 64, "the database row is addressed by the hash, computed the same way the app computes it");
  await db.query("update public.tiktok_oauth_states set expires_at = now() - interval '1 minute' where state_hash = $1", [expiredHash]);
  assert.equal(await dataMod.consumeTikTokOAuthState(admin, OWNER_A, expired, expired), false, "expired states cannot be used");
  assert.equal(stateHash.length, 64);
});

test("the connection vault stores ciphertext only; get returns no plaintext; update rotates exactly the fields given", async () => {
  const { admin } = await liteDb();
  await saveConnection(OWNER_A);
  const row = await one("select * from public.tiktok_connection_secrets where owner_user_id = $1", [OWNER_A]);
  assert.ok(row.encrypted_refresh_token.startsWith("v2:"), "the refresh token is a versioned ciphertext");
  assert.ok(!JSON.stringify(row).includes(`refresh-${OWNER_A.slice(0, 8)}`), "no plaintext token anywhere in the row");
  assert.equal(row.refresh_key_version, 2);

  const { data } = await admin.rpc("get_tiktok_connection_secret", { p_owner_user_id: OWNER_A });
  assert.equal(data[0].connection_status, "connected");
  assert.ok(!JSON.stringify(data).includes("access-" + OWNER_A.slice(0, 8)), "the secret RPC never returns plaintext either");

  // Rotate the access token: refresh stays untouched.
  const rotated = ttCrypto.encryptTikTokToken("access-rotated", KEY);
  await admin.rpc("update_tiktok_tokens", {
    p_owner_user_id: OWNER_A,
    p_encrypted_access_token: rotated.encryptedToken, p_access_iv: rotated.iv, p_access_auth_tag: rotated.authTag, p_access_key_version: rotated.keyVersion,
    p_access_token_expires_at: nowIso(86_400_000),
  });
  const after = await one("select * from public.tiktok_connection_secrets where owner_user_id = $1", [OWNER_A]);
  assert.equal(after.refresh_key_version, 2);
  assert.equal(after.encrypted_refresh_token, row.encrypted_refresh_token, "a partial update must not clobber the other token");
});

test("set_tiktok_publish_defaults accepts only the four real values (or null to clear); the worker's settings endpoint enforces the same", async () => {
  const { admin } = await liteDb();
  await saveConnection(OWNER_A);
  const { data: ok } = await admin.rpc("set_tiktok_publish_defaults", { p_owner_user_id: OWNER_A, p_default_privacy: "MUTUAL_FOLLOW_FRIENDS" });
  assert.equal(ok, true);
  const { error: badError } = await admin.rpc("set_tiktok_publish_defaults", { p_owner_user_id: OWNER_A, p_default_privacy: "PUBLIC" });
  assert.ok(badError, "a value TikTok does not define is refused at the database");
  const { data: cleared } = await admin.rpc("set_tiktok_publish_defaults", { p_owner_user_id: OWNER_A, p_default_privacy: null });
  assert.equal(cleared, true, "null clears the default — 'no default' is a real, honest setting");
});

test("enqueue is idempotent per (owner, draft): one row forever, reschedules and re-declares honestly", async () => {
  const { admin } = await liteDb();
  const draftId = await makeDraft(OWNER_A);
  const first = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(draftId));
  assert.equal(first.status, "scheduled");
  assert.equal(first.idempotency_key, pub.tiktokPublishIdempotencyKey(draftId));
  assert.equal(first.privacy_level, "SELF_ONLY");

  const second = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(draftId, { scheduledAt: nowIso(3600_000), title: "Renamed", privacyLevel: "MUTUAL_FOLLOW_FRIENDS" }));
  assert.equal(second.id, first.id, "ONE row per (owner, draft) forever");
  assert.equal(second.title, "Renamed");
  assert.equal(second.privacy_level, "MUTUAL_FOLLOW_FRIENDS");
  const count = await one("select count(*)::int as n from public.tiktok_publish_queue where draft_id = $1", [draftId]);
  assert.equal(count.n, 1);
});

test("an undeclared privacy parks the item in needs_declaration; missing media parks it in waiting_for_media — both are honest blocked states", async () => {
  const { admin } = await liteDb();
  const undeclared = await makeDraft(OWNER_A);
  const undeclaredRow = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(undeclared, { privacyLevel: null }));
  assert.equal(undeclaredRow.status, "needs_declaration");

  const noMedia = await makeDraft(OWNER_A);
  const noMediaRow = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(noMedia, { waitingForMedia: true }));
  assert.equal(noMediaRow.status, "waiting_for_media");

  // The database itself refuses a title beyond TikTok's 2200-character limit
  // (the app layer truncates before enqueuing — see truncateTikTokTitle).
  const tooLong = await makeDraft(OWNER_A);
  await assert.rejects(
    queueMod.enqueueTikTokPublishItem(admin, enqueueInput(tooLong, { title: "x".repeat(2300) })),
    /tiktok_publish_enqueue_failed/,
    "a 2300-char title is refused at the database, never silently stored",
  );
  const long = await makeDraft(OWNER_A);
  const longRow = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(long, { title: "x".repeat(2200) }));
  assert.equal(longRow.title.length, 2200, "the documented maximum itself is accepted");
});

test("the posting claim is atomic: a due row becomes posting with attempts+1, a second claim gets nothing, provider-owned rows are never re-claimed", async () => {
  const { admin } = await liteDb();
  await clearClaimable();
  const draftId = await makeDraft(OWNER_A);
  await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(draftId));
  // A future-scheduled row must NOT be claimed.
  const futureDraft = await makeDraft(OWNER_A);
  await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(futureDraft, { scheduledAt: nowIso(3600_000) }));

  const first = await queueMod.claimDueTikTokPosts(admin, 5, new Date());
  assert.equal(first.length, 1);
  assert.equal(first[0].draft_id, draftId);
  const row = await one("select status, attempts from public.tiktok_publish_queue where draft_id = $1", [draftId]);
  assert.equal(row.status, "posting");
  assert.equal(row.attempts, 1, "the claim itself is the attempt");

  // A concurrent second claim finds nothing (for update skip locked).
  const second = await queueMod.claimDueTikTokPosts(admin, 5, new Date());
  assert.equal(second.length, 0, "no double claim, ever — this is the duplicate-post guarantee");

  // A row that already carries a publish id is provider-owned: the FRESH branch never claims it.
  const resumeDraft = await makeDraft(OWNER_A);
  const resumeRow = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(resumeDraft));
  await queueMod.recordTikTokPublish(admin, resumeRow.id, OWNER_A, newPublishId(), "https://upload.tiktok.test/r", 1024);
  const withId = await queueMod.claimDueTikTokPosts(admin, 5, new Date());
  assert.equal(withId.length, 0, "a row with a publish id is not a fresh candidate (record_tiktok_publish left it in 'posting', which the fresh branch does not claim)");
});

test("the posting claim RESUME branch re-claims a scheduled row that already holds a publish id (the worker crashed after init)", async () => {
  const { admin } = await liteDb();
  await clearAllQueueRows();
  const draftId = await makeDraft(OWNER_A);
  const row0 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(draftId));
  const publishId = newPublishId();
  await queueMod.recordTikTokPublish(admin, row0.id, OWNER_A, publishId, "https://upload.tiktok.test/resume", 1024);
  // Simulate the crash: a retryable park put the row back to scheduled, but
  // it keeps its publish id (record_tiktok_publish stamped scheduled_at =
  // now(), so it is due for the real-clock claim).
  await (await liteDb()).db.query(
    "update public.tiktok_publish_queue set status = 'scheduled', attempts = 0, claimed_at = null where id = $1",
    [row0.id],
  );
  const claimed = await queueMod.claimDueTikTokPosts(admin, 5, new Date());
  assert.equal(claimed.length, 1, "the resume branch claims it");
  assert.equal(claimed[0].tiktok_publish_id, publishId, "the SAME publish id rides along — no second post can start");
  const row = await one("select status from public.tiktok_publish_queue where id = $1", [row0.id]);
  assert.equal(row.status, "posting");
});

test("needs_declaration and not-yet-due rows are never claimed; waiting_for_media rows are claimed so the worker re-verifies media at run time", async () => {
  const { admin } = await liteDb();
  await clearClaimable();
  const undeclared = await makeDraft(OWNER_A);
  await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(undeclared, { privacyLevel: null }));
  const noMedia = await makeDraft(OWNER_A);
  await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(noMedia, { waitingForMedia: true }));
  const future = await makeDraft(OWNER_A);
  await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(future, { scheduledAt: nowIso(3600_000) }));
  const claimed = await queueMod.claimDueTikTokPosts(admin, 10, new Date());
  // needs_declaration needs the owner; a future schedule is not due. A
  // waiting_for_media row IS claimed: the media state is a snapshot, and the
  // flow re-checks the asset at run time (parking it back honestly if it is
  // still missing) — that is how media arriving between claims publishes.
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].draft_id, noMedia);

  // And the positive control: declared privacy + due time is claimed too.
  const ready = await makeDraft(OWNER_A);
  await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(ready));
  const readyClaimed = await queueMod.claimDueTikTokPosts(admin, 10, new Date());
  assert.equal(readyClaimed.length, 1);
  assert.equal(readyClaimed[0].draft_id, ready, "only the fully-ready row is started");
});

test("the reconcile claim: provider_processing rows are polled WITHOUT consuming attempts; stale posting rows are resumed with an attempt", async () => {
  const { admin, db } = await liteDb();
  await clearAllQueueRows();
  // 1) A provider_processing row (publish id persisted, transfer complete):
  //    claimed for polling, attempts untouched.
  const d1 = await makeDraft(OWNER_A);
  const r1 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d1));
  await queueMod.recordTikTokPublish(admin, r1.id, OWNER_A, newPublishId(), "u", 1024);
  await queueMod.setTikTokProviderProcessing(admin, r1.id, OWNER_A);
  // 2) A stale posting row (claimed 20 minutes ago): resumed with an attempt.
  const d2 = await makeDraft(OWNER_A);
  const r2 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d2));
  await db.query("update public.tiktok_publish_queue set status = 'posting', attempts = 1, claimed_at = now() - interval '20 minutes' where id = $1", [r2.id]);

  const claimed = await queueMod.claimTikTokReconcileJobs(admin, 10, new Date());
  const ids = claimed.map((row) => row.id).sort();
  assert.deepEqual(ids, [r1.id, r2.id].sort(), "both kinds of owed work are claimed");
  const r1row = await one("select attempts, status from public.tiktok_publish_queue where id = $1", [r1.id]);
  assert.equal(r1row.attempts, 0, "waiting for the provider is not a failure — no attempt burned");
  assert.equal(r1row.status, "provider_processing");
  const r2row = await one("select attempts, claimed_at from public.tiktok_publish_queue where id = $1", [r2.id]);
  assert.equal(r2row.attempts, 2, "the stale resume consumes its attempt budget");
  assert.ok(r2row.claimed_at, "the fresh claim timestamp is recorded");

  // A fresh (non-stale) posting row is NOT reconciled.
  const d3 = await makeDraft(OWNER_A);
  const r3 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d3));
  await db.query("update public.tiktok_publish_queue set status = 'posting', attempts = 1, claimed_at = now() - interval '1 minute' where id = $1", [r3.id]);
  const again = await queueMod.claimTikTokReconcileJobs(admin, 10, new Date());
  assert.ok(!again.some((row) => row.id === r3.id), "a healthy in-flight upload is left alone");
});

test("record_tiktok_publish persists the id + upload URL + length; a conflicting id for the same row is refused", async () => {
  const { admin } = await liteDb();
  await clearClaimable();
  const draftId = await makeDraft(OWNER_A);
  const row = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(draftId));
  const publishId = newPublishId();
  await queueMod.recordTikTokPublish(admin, row.id, OWNER_A, publishId, "https://upload.tiktok.test/a", 2048);
  const stored = await one("select tiktok_publish_id, upload_url, upload_content_length from public.tiktok_publish_queue where id = $1", [row.id]);
  assert.equal(stored.tiktok_publish_id, publishId);
  assert.equal(stored.upload_url, "https://upload.tiktok.test/a");
  assert.equal(Number(stored.upload_content_length), 2048);

  // A second, DIFFERENT id for the same row would corrupt tracking: refused.
  const { error } = await admin.rpc("record_tiktok_publish", {
    p_id: row.id, p_owner_user_id: OWNER_A, p_publish_id: newPublishId(), p_upload_url: "https://upload.tiktok.test/b", p_content_length: 1,
  });
  assert.ok(error, "a conflicting publish id is a database error, never a silent overwrite");

  // A fabricated id is refused too.
  const { error: badError } = await admin.rpc("record_tiktok_publish", {
    p_id: row.id, p_owner_user_id: OWNER_A, p_publish_id: "not-a-real-id!!", p_upload_url: "u", p_content_length: 1,
  });
  assert.ok(badError, "malformed ids are refused at the database");
});

test("upload progress is monotonic: a smaller value can never rewind TikTok's position", async () => {
  const { admin } = await liteDb();
  await clearClaimable();
  const draftId = await makeDraft(OWNER_A);
  const row = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(draftId));
  await queueMod.recordTikTokPublish(admin, row.id, OWNER_A, newPublishId(), "u", 1000);
  await queueMod.recordTikTokUploadProgress(admin, row.id, OWNER_A, 500);
  await queueMod.recordTikTokUploadProgress(admin, row.id, OWNER_A, 300);
  const stored = await one("select upload_bytes_sent from public.tiktok_publish_queue where id = $1", [row.id]);
  assert.equal(Number(stored.upload_bytes_sent), 500, "greatest() — the max ever reported wins");
});

test("set_tiktok_provider_processing only moves posting rows WITH a publish id; it never touches published or failed rows", async () => {
  const { admin } = await liteDb();
  await clearClaimable();
  // A real posting row: publish id persisted (record also moves it to posting).
  const d1 = await makeDraft(OWNER_A);
  const r1 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d1));
  await queueMod.recordTikTokPublish(admin, r1.id, OWNER_A, newPublishId(), "u", 1024);
  await queueMod.setTikTokProviderProcessing(admin, r1.id, OWNER_A);
  const r1row = await one("select status from public.tiktok_publish_queue where id = $1", [r1.id]);
  assert.equal(r1row.status, "provider_processing");

  // A row that never reached the provider: untouched.
  const d2 = await makeDraft(OWNER_A);
  const r2 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d2));
  await queueMod.setTikTokProviderProcessing(admin, r2.id, OWNER_A);
  const r2row = await one("select status from public.tiktok_publish_queue where id = $1", [r2.id]);
  assert.equal(r2row.status, "scheduled", "only a row that was actually uploading (with a publish id) can become provider-owned");

  // A failed row: untouched.
  const d3 = await makeDraft(OWNER_A);
  const r3 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d3));
  await queueMod.failTikTokPublishJob(admin, r3.id, OWNER_A, { code: "media_unsupported", message: "no", status: "failed" });
  await queueMod.setTikTokProviderProcessing(admin, r3.id, OWNER_A);
  const r3row = await one("select status from public.tiktok_publish_queue where id = $1", [r3.id]);
  assert.equal(r3row.status, "failed");
});

test("complete_tiktok_publish_job requires the persisted publish id AND PUBLISH_COMPLETE — the database itself enforces publication evidence", async () => {
  const { admin } = await liteDb();
  await clearClaimable();
  // No publish id: refused.
  const d1 = await makeDraft(OWNER_A);
  const r1 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d1));
  const { error: noId } = await admin.rpc("complete_tiktok_publish_job", {
    p_id: r1.id, p_owner_user_id: OWNER_A, p_provider_status: "PUBLISH_COMPLETE", p_provider_post_id: null, p_provider_note: null,
  });
  assert.ok(noId, "no persisted publish id, no publication — the DB refuses");
  const s1 = await one("select status from public.tiktok_publish_queue where id = $1", [r1.id]);
  assert.notEqual(s1.status, "published");

  // PROCESSING_UPLOAD with a publish id: still refused.
  const d2 = await makeDraft(OWNER_A);
  const r2 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d2));
  await queueMod.recordTikTokPublish(admin, r2.id, OWNER_A, newPublishId(), "u", 10);
  const { error: processing } = await admin.rpc("complete_tiktok_publish_job", {
    p_id: r2.id, p_owner_user_id: OWNER_A, p_provider_status: "PROCESSING_UPLOAD", p_provider_post_id: null, p_provider_note: null,
  });
  assert.ok(processing, "acceptance/processing is NOT publication evidence");

  // PUBLISH_COMPLETE: publishes, stamps the draft's provider_ref.
  const d3 = await makeDraft(OWNER_A);
  const r3 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d3));
  const pid = newPublishId();
  await queueMod.recordTikTokPublish(admin, r3.id, OWNER_A, pid, "u", 10);
  const { data: done, error: doneError } = await admin.rpc("complete_tiktok_publish_job", {
    p_id: r3.id, p_owner_user_id: OWNER_A, p_provider_status: "PUBLISH_COMPLETE", p_provider_post_id: null, p_provider_note: "private note",
  });
  assert.equal(doneError, null);
  assert.equal(done.status, "published");
  const draft = await one("select provider_ref from public.mara_drafts where id = $1", [d3]);
  assert.equal(draft.provider_ref, pid, "the durable provider reference is stamped on the draft");
  assert.ok(done.published_at, "the publication timestamp is set exactly once");
});

test("the published-row guard: a published row can never be rewritten or deleted by the queue paths", async () => {
  const { admin, db } = await liteDb();
  await clearClaimable();
  const draftId = await makeDraft(OWNER_A);
  const row = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(draftId));
  const pid = newPublishId();
  await queueMod.recordTikTokPublish(admin, row.id, OWNER_A, pid, "u", 10);
  await admin.rpc("complete_tiktok_publish_job", { p_id: row.id, p_owner_user_id: OWNER_A, p_provider_status: "PUBLISH_COMPLETE", p_provider_post_id: null, p_provider_note: null });

  // A direct rewrite of the publication fact is refused.
  await assert.rejects(db.query("update public.tiktok_publish_queue set status = 'failed' where id = $1", [row.id]));
  await assert.rejects(db.query("delete from public.tiktok_publish_queue where id = $1", [row.id]));
  // Bookkeeping (provider status) is still allowed — the guard protects the fact, not the evidence columns.
  const { error: noteError } = await admin.rpc("record_tiktok_provider_status", {
    p_id: row.id, p_owner_user_id: OWNER_A, p_provider_status: "PUBLISH_COMPLETE", p_provider_post_id: null, p_provider_fail_reason: null, p_provider_note: "re-verified", p_last_provider_check_at: new Date(NOW).toISOString(),
  });
  assert.equal(noteError, null, "read-only verification can annotate a published row");
  const after = await one("select status, provider_note from public.tiktok_publish_queue where id = $1", [row.id]);
  assert.equal(after.status, "published");
  assert.equal(after.provider_note, "re-verified");
});

test("fail_tiktok_publish_job: terminal states are final, retryable states park at the given time, and published rows cannot fail", async () => {
  const { admin } = await liteDb();
  await clearClaimable();
  const d1 = await makeDraft(OWNER_A);
  const r1 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d1));
  await queueMod.failTikTokPublishJob(admin, r1.id, OWNER_A, { code: "media_unsupported", message: "no", status: "failed" });
  const r1row = await one("select status, failure_code from public.tiktok_publish_queue where id = $1", [r1.id]);
  assert.equal(r1row.status, "failed");
  assert.equal(r1row.failure_code, "media_unsupported");

  const d2 = await makeDraft(OWNER_A);
  const r2 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d2));
  await queueMod.failTikTokPublishJob(admin, r2.id, OWNER_A, { code: "rate_limited", message: "slow", status: "scheduled", retryAt: new Date(NOW + 300_000).toISOString() });
  const r2row = await one("select status, scheduled_at from public.tiktok_publish_queue where id = $1", [r2.id]);
  assert.equal(r2row.status, "scheduled");
  assert.ok(Date.parse(r2row.scheduled_at) > NOW, "the park time is honored");

  // A published row cannot be failed: the RPC is a safe no-op and the row
  // keeps its proven publication fact (the guard trigger would refuse any
  // direct rewrite as well).
  const d3 = await makeDraft(OWNER_A);
  const r3 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d3));
  const pid = newPublishId();
  await queueMod.recordTikTokPublish(admin, r3.id, OWNER_A, pid, "u", 10);
  await admin.rpc("complete_tiktok_publish_job", { p_id: r3.id, p_owner_user_id: OWNER_A, p_provider_status: "PUBLISH_COMPLETE", p_provider_post_id: null, p_provider_note: null });
  const { data: failedRow } = await admin.rpc("fail_tiktok_publish_job", {
    p_id: r3.id, p_owner_user_id: OWNER_A, p_failure_code: "x", p_failure_message: "y", p_status: "failed", p_retry_at: null, p_reset_attempts: false,
  });
  assert.equal(failedRow.status, "published", "publication is a fact; the fail path never downgrades it");
  const r3row = await one("select status, failure_code from public.tiktok_publish_queue where id = $1", [r3.id]);
  assert.equal(r3row.status, "published");
  assert.equal(r3row.failure_code, null, "no failure was recorded on the proven publication");
});

test("reset_tiktok_publish_for_resubmit: ONLY fail-closed rows with the right codes and a publish id may be re-armed", async () => {
  const { admin } = await liteDb();
  await clearClaimable();
  // A fail-closed upload_task_gone row: re-armed.
  const d1 = await makeDraft(OWNER_A);
  const r1 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d1));
  const pid1 = newPublishId();
  await queueMod.recordTikTokPublish(admin, r1.id, OWNER_A, pid1, "u", 10);
  await queueMod.failTikTokPublishJob(admin, r1.id, OWNER_A, { code: "upload_task_gone", message: "gone", status: "failed" });
  const { data: re1 } = await admin.rpc("reset_tiktok_publish_for_resubmit", { p_id: r1.id, p_owner_user_id: OWNER_A });
  const r1row = await one("select status, tiktok_publish_id, upload_url, attempts from public.tiktok_publish_queue where id = $1", [r1.id]);
  assert.equal(r1row.status, "scheduled", "the re-armed row is a fresh candidate again");
  assert.equal(r1row.tiktok_publish_id, null, "the dead id is cleared");
  assert.equal(r1row.upload_url, null);
  assert.equal(Number(r1row.attempts), 0, "the attempt budget resets with the post");
  void re1;

  // A generic failed row: NOT re-armed (blind re-init could duplicate).
  const d2 = await makeDraft(OWNER_A);
  const r2 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d2));
  await queueMod.failTikTokPublishJob(admin, r2.id, OWNER_A, { code: "media_unsupported", message: "no", status: "failed" });
  await admin.rpc("reset_tiktok_publish_for_resubmit", { p_id: r2.id, p_owner_user_id: OWNER_A });
  const r2row = await one("select status, failure_code from public.tiktok_publish_queue where id = $1", [r2.id]);
  assert.equal(r2row.status, "failed", "only the provider-attested codes may re-arm");
  assert.equal(r2row.failure_code, "media_unsupported", "the row is untouched");
});

test("disconnect: secrets destroyed locally FIRST, pre-provider queue rows cancelled, provider-owned and published rows untouched, nothing on TikTok is deleted", async () => {
  const { admin } = await liteDb();
  await saveConnection(OWNER_A);
  // A scheduled row (never reached the provider) and a published row.
  const d1 = await makeDraft(OWNER_A);
  const r1 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d1));
  const d2 = await makeDraft(OWNER_A);
  const r2 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d2));
  const pid = newPublishId();
  await queueMod.recordTikTokPublish(admin, r2.id, OWNER_A, pid, "u", 10);
  await admin.rpc("complete_tiktok_publish_job", { p_id: r2.id, p_owner_user_id: OWNER_A, p_provider_status: "PUBLISH_COMPLETE", p_provider_post_id: null, p_provider_note: null });

  const { data: disconnected } = await admin.rpc("disconnect_tiktok_connection", { p_owner_user_id: OWNER_A });
  assert.equal(disconnected, true);
  const secrets = await one("select count(*)::int as n from public.tiktok_connection_secrets where owner_user_id = $1", [OWNER_A]);
  assert.equal(secrets.n, 0, "the local vault is empty after disconnect");
  const conn = await one("select status from public.tiktok_connections where owner_user_id = $1", [OWNER_A]);
  assert.equal(conn.status, "disconnected");
  const r1row = await one("select status from public.tiktok_publish_queue where id = $1", [r1.id]);
  assert.equal(r1row.status, "cancelled", "a never-submitted item is cancelled — it will never post");
  const r2row = await one("select status from public.tiktok_publish_queue where id = $1", [r2.id]);
  assert.equal(r2row.status, "published", "the publication fact survives the disconnect");
});

test("set_tiktok_connection_status revoked parks pre-provider rows for reconnection without destroying history", async () => {
  const { admin } = await liteDb();
  await saveConnection(OWNER_A);
  const d1 = await makeDraft(OWNER_A);
  const r1 = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(d1));
  await admin.rpc("set_tiktok_connection_status", { p_owner_user_id: OWNER_A, p_status: "revoked" });
  const r1row = await one("select status from public.tiktok_publish_queue where id = $1", [r1.id]);
  assert.equal(r1row.status, "permission_required", "the item is truthfully parked: the connection is gone");
  const conn = await one("select status from public.tiktok_connections where owner_user_id = $1", [OWNER_A]);
  assert.equal(conn.status, "revoked");
});

test("owner isolation: OWNER_B can never enqueue, cancel or claim OWNER_A's rows through the RPCs", async () => {
  const { admin } = await liteDb();
  await clearClaimable();
  const draftA = await makeDraft(OWNER_A);
  const draftB = await makeDraft(OWNER_B);
  await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(draftA));

  // Enqueue against someone else's draft: refused.
  const { error: foreignEnqueue } = await admin.rpc("upsert_tiktok_publish_queue_item", {
    p_owner_user_id: OWNER_B, p_draft_id: draftA, p_calendar_item_id: null, p_title: "x", p_privacy_level: "SELF_ONLY",
    p_scheduled_at: nowIso(-60_000), p_waiting_for_media: false,
  });
  assert.ok(foreignEnqueue, "the RPC refuses to act on a draft the caller does not own");

  // Cancel someone else's item: a safe no-op that cannot touch the row.
  const { data: foreignCancel } = await admin.rpc("cancel_tiktok_publish_queue_item", { p_owner_user_id: OWNER_B, p_draft_id: draftA });
  assert.equal(foreignCancel, false, "cancelling across owners affects nothing");
  const still = await one("select status from public.tiktok_publish_queue where draft_id = $1", [draftA]);
  assert.equal(still.status, "scheduled");

  // A row owned by OWNER_B can be cancelled by OWNER_B.
  await queueMod.enqueueTikTokPublishItem(admin, { ...enqueueInput(draftB), ownerId: OWNER_B });
  const { data: ownCancel } = await admin.rpc("cancel_tiktok_publish_queue_item", { p_owner_user_id: OWNER_B, p_draft_id: draftB });
  assert.equal(ownCancel, true);
});

// ---------------------------------------------------------------------------
// 7. Workers end-to-end: PGlite database + FAKE TikTok + streaming bytes
// ---------------------------------------------------------------------------

// The worker streams chunk bytes through a signed-URL Range read. In this
// suite the "storage CDN" is answered locally; ANY other URL throws, proving
// no real network call ever happens.
globalThis.fetch = async (url) => {
  if (String(url).startsWith("https://signed.test/")) {
    return { ok: true, status: 206, body: new Uint8Array(64), headers: { get: () => null }, json: async () => ({}) };
  }
  throw new Error(`tiktok-provider.test: unexpected real network call to ${url}`);
};

test("an unconfigured deployment claims NOTHING — a misconfigured cron never burns attempts", async () => {
  const { admin } = await liteDb();
  await clearClaimable();
  const draftId = await makeDraft(OWNER_A);
  await makeAsset(OWNER_A, draftId, { byteSize: 1024 });
  await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(draftId));

  const result = await workerMod.runTikTokPublishing({ db: admin, config: null, sleep: noopSleep });
  assert.equal(result.claimed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.results[0].code, "tiktok_not_configured");
  const row = await one("select status, attempts from public.tiktok_publish_queue where draft_id = $1", [draftId]);
  assert.equal(row.status, "scheduled");
  assert.equal(row.attempts, 0);
});

test("the publish worker drives a due, approved, declared item to 'published' — end to end through the real SQL", async () => {
  const { admin } = await liteDb();
  await clearAllQueueRows();
  await saveConnection(OWNER_A);
  const draftId = await makeDraft(OWNER_A);
  await makeAsset(OWNER_A, draftId, { byteSize: 1024 });
  const publishId = newPublishId();
  await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(draftId));

  const tiktok = fakeTikTok({ publishId });
  const result = await workerMod.runTikTokPublishing({ db: admin, config: fakeConfig(), clientFor: () => tiktok, sleep: noopSleep });
  assert.equal(result.claimed, 1);
  assert.equal(result.published, 1);
  assert.equal(result.failed, 0);

  const row = await one("select * from public.tiktok_publish_queue where draft_id = $1", [draftId]);
  assert.equal(row.status, "published");
  assert.equal(row.tiktok_publish_id, publishId, "the stored id is the provider's own");
  assert.equal(row.provider_status, "PUBLISH_COMPLETE", "publication is backed by the provider's own status");
  assert.ok(row.published_at);
  const draft = await one("select provider_ref from public.mara_drafts where id = $1", [draftId]);
  assert.equal(draft.provider_ref, publishId);

  // The documented order held: creator info BEFORE init, one upload chunk.
  assert.ok(tiktok.calls.some(([kind]) => kind === "creatorInfo"));
  assert.ok(tiktok.calls.some(([kind]) => kind === "init"));
  const init = tiktok.calls.find(([kind]) => kind === "init");
  assert.deepEqual(init[1].sourceInfo, { source: "FILE_UPLOAD", video_size: 1024, chunk_size: 1024, total_chunk_count: 1 });
  const chunk = tiktok.calls.find(([kind]) => kind === "chunk");
  assert.equal(chunk[1].contentRange, "bytes 0-1023/1024");

  // A second run finds nothing to do: the published row is never re-claimed.
  const second = await workerMod.runTikTokPublishing({ db: admin, config: fakeConfig(), clientFor: () => tiktok, sleep: noopSleep });
  assert.equal(second.claimed, 0);
  assert.equal(second.published, 0);
});

test("an interrupted upload parks at the cron boundary with the id persisted; the next run RESUMES the same post (one init, ever)", async () => {
  const { admin, db } = await liteDb();
  await clearAllQueueRows();
  await saveConnection(OWNER_A);
  const draftId = await makeDraft(OWNER_A);
  await makeAsset(OWNER_A, draftId, { byteSize: 1024 });
  await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(draftId));

  // Run 1: the upload dies mid-transfer (network).
  const flaky = fakeTikTok({
    uploadChunk: async () => { throw new clientMod.TikTokApiError("network", "upload_chunk"); },
  });
  const first = await workerMod.runTikTokPublishing({ db: admin, config: fakeConfig(), clientFor: () => flaky, sleep: noopSleep });
  assert.equal(first.claimed, 1);
  assert.equal(first.retrying, 1);
  const parked = await one("select * from public.tiktok_publish_queue where draft_id = $1", [draftId]);
  assert.equal(parked.status, "scheduled", "an interruption is a park, not a failure");
  assert.equal(parked.failure_code, "upload_interrupted");
  assert.ok(parked.tiktok_publish_id, "the publish id survived the crash — the resume can never init a second post");
  assert.ok(Date.parse(parked.scheduled_at) > Date.now(), "the retry waits for the future cron boundary");

  // Run 2 (network recovered): the boundary arrives, the same post resumes.
  await db.query("update public.tiktok_publish_queue set scheduled_at = now() where draft_id = $1", [draftId]);
  const stable = fakeTikTok({ publishId: parked.tiktok_publish_id });
  const second = await workerMod.runTikTokPublishing({ db: admin, config: fakeConfig(), clientFor: () => stable, sleep: noopSleep });
  assert.equal(second.claimed, 1);
  assert.equal(second.published, 1);
  assert.equal(stable.calls.filter(([kind]) => kind === "init").length, 0, "RESUME: the persisted id means no second init, ever");
  assert.ok(stable.calls.some(([kind]) => kind === "chunk"), "the transfer finished from the persisted state");
  const row = await one("select status, tiktok_publish_id from public.tiktok_publish_queue where draft_id = $1", [draftId]);
  assert.equal(row.status, "published");
  assert.equal(row.tiktok_publish_id, parked.tiktok_publish_id, "the SAME post was completed");
});

test("reconciliation: PUBLISH_COMPLETE publishes, a fail-closed row is recovered read-only, and a provider-attested 'does not exist' re-arms guarded", async () => {
  const { admin } = await liteDb();
  await clearAllQueueRows();
  await saveConnection(OWNER_A);

  // A) provider_processing row: the provider owes the outcome.
  const dA = await makeDraft(OWNER_A);
  const rA = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(dA));
  const pidA = newPublishId();
  await queueMod.recordTikTokPublish(admin, rA.id, OWNER_A, pidA, "u", 1024);
  await queueMod.setTikTokProviderProcessing(admin, rA.id, OWNER_A);

  // B) fail-closed upload_task_gone row: read-only recovery.
  const dB = await makeDraft(OWNER_A);
  const rB = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(dB));
  const pidB = newPublishId();
  await queueMod.recordTikTokPublish(admin, rB.id, OWNER_A, pidB, "u", 1024);
  await queueMod.failTikTokPublishJob(admin, rB.id, OWNER_A, { code: "upload_task_gone", message: "gone", status: "failed" });

  // C) fail-closed publish_ambiguous row: TikTok says the id does not exist.
  const dC = await makeDraft(OWNER_A);
  const rC = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(dC));
  const pidC = newPublishId();
  await queueMod.recordTikTokPublish(admin, rC.id, OWNER_A, pidC, "u", 1024);
  await queueMod.failTikTokPublishJob(admin, rC.id, OWNER_A, { code: "publish_ambiguous", message: "ambiguous", status: "failed" });

  const tiktok = fakeTikTok({
    fetchPostStatus: async (accessToken, publishId) => {
      if (publishId === pidC) throw new clientMod.TikTokApiError("not_found", "post_status", "invalid_publish_id", 400);
      return { status: "PUBLISH_COMPLETE", postIds: [], failReason: null };
    },
  });
  const result = await reconcileMod.runTikTokReconciliation({ db: admin, config: fakeConfig(), clientFor: () => tiktok, sleep: noopSleep });
  assert.equal(result.claimed, 3);
  assert.equal(result.published, 2, "A and B complete on the provider's own evidence");

  const a = await one("select status from public.tiktok_publish_queue where id = $1", [rA.id]);
  assert.equal(a.status, "published");
  const b = await one("select status from public.tiktok_publish_queue where id = $1", [rB.id]);
  assert.equal(b.status, "published", "the fail-closed row is recovered READ-ONLY — no re-init, no duplicate");
  const c = await one("select status, tiktok_publish_id, attempts from public.tiktok_publish_queue where id = $1", [rC.id]);
  assert.equal(c.status, "scheduled", "the guarded re-arm clears the provider-attested-dead id");
  assert.equal(c.tiktok_publish_id, null);
  assert.equal(c.attempts, 0, "the fresh submission gets a fresh attempt budget");

  // No upload was re-attempted by reconciliation: zero init calls.
  assert.equal(tiktok.calls.filter(([kind]) => kind === "init").length, 0);
});

test("reconciliation polls provider_processing WITHOUT burning attempts, and re-checks published evidence daily without rewriting the fact", async () => {
  const { admin, db } = await liteDb();
  await clearAllQueueRows();
  await saveConnection(OWNER_A);
  const draftId = await makeDraft(OWNER_A);
  const row = await queueMod.enqueueTikTokPublishItem(admin, enqueueInput(draftId));
  const publishId = newPublishId();
  await queueMod.recordTikTokPublish(admin, row.id, OWNER_A, publishId, "u", 1024);
  await queueMod.setTikTokProviderProcessing(admin, row.id, OWNER_A);

  // Still processing: stays processing, no attempt burned, no publication.
  const stillProcessing = fakeTikTok({ statuses: Array.from({ length: 20 }, () => ({ status: "PROCESSING_UPLOAD", postIds: [], failReason: null })) });
  const first = await reconcileMod.runTikTokReconciliation({ db: admin, config: fakeConfig(), clientFor: () => stillProcessing, sleep: noopSleep });
  assert.equal(first.processing, 1);
  assert.equal(first.published, 0);
  const after = await one("select status, attempts from public.tiktok_publish_queue where id = $1", [row.id]);
  assert.equal(after.status, "provider_processing");
  assert.equal(after.attempts, 0, "waiting for TikTok is not a failure");

  // Complete: the NEXT reconciliation publishes. The claim throttles
  // provider-processing polls to one per 2 minutes — age the claim to let
  // the next poll through (simulating elapsed time).
  await db.query("update public.tiktok_publish_queue set claimed_at = now() - interval '5 minutes' where id = $1", [row.id]);
  const complete = fakeTikTok({ publishId });
  const second = await reconcileMod.runTikTokReconciliation({ db: admin, config: fakeConfig(), clientFor: () => complete, sleep: noopSleep });
  assert.equal(second.published, 1);
  const published = await one("select status from public.tiktok_publish_queue where id = $1", [row.id]);
  assert.equal(published.status, "published");

  // Freshly published rows sit INSIDE the 24h verification window — the
  // default run does not even pick them up (and the fact stays untouched).
  const removed = fakeTikTok({
    fetchPostStatus: async () => { throw new clientMod.TikTokApiError("not_found", "post_status", "invalid_publish_id", 400); },
  });
  const fresh = await reconcileMod.runTikTokReconciliation({ db: admin, config: fakeConfig(), clientFor: () => removed, sleep: noopSleep });
  assert.equal(fresh.verified, 0, "the 24h window excludes fresh publications");

  // Once the row ages past the window, the re-check is READ-ONLY: a provider
  // read failure is skipped truthfully and the fact is never rewritten.
  // (Crossing the window is done via the injected min-age — backdating
  // published_at is exactly what the terminal guard forbids, by design.)
  const aged = await reconcileMod.runTikTokReconciliation({ db: admin, config: fakeConfig(), clientFor: () => removed, sleep: noopSleep, verificationMinAgeHours: 0 });
  assert.equal(aged.verified, 0, "a read failure during verification is skipped truthfully");
  const afterFailedRead = await one("select status, tiktok_publish_id from public.tiktok_publish_queue where id = $1", [row.id]);
  assert.equal(afterFailedRead.status, "published", "a failed read never rewrites the publication fact");
  assert.equal(afterFailedRead.tiktok_publish_id, publishId);

  // And a successful re-check records the provider's CURRENT truth
  // (post id, status) on the bookkeeping columns — still never the fact.
  // (The list is owner-scoped and may include other due published rows from
  // earlier tests, so the fake answers per publish id and the assertion is
  // on this row's recorded facts, not a global count.)
  const stillUp = {
    async fetchPostStatus(_accessToken, queriedId) {
      return queriedId === publishId
        ? { status: "PUBLISH_COMPLETE", postIds: ["7600000000000000001"], failReason: null }
        : { status: "PUBLISH_COMPLETE", postIds: [], failReason: null };
    },
  };
  const checked = await reconcileMod.runTikTokReconciliation({ db: admin, config: fakeConfig(), clientFor: () => stillUp, sleep: noopSleep, verificationMinAgeHours: 0 });
  assert.ok(checked.verified >= 1, "the due published rows were re-checked");
  const final = await one("select status, tiktok_publish_id, provider_status, provider_post_id from public.tiktok_publish_queue where id = $1", [row.id]);
  assert.equal(final.status, "published", "verification NEVER rewrites the publication fact");
  assert.equal(final.tiktok_publish_id, publishId);
  assert.equal(final.provider_status, "PUBLISH_COMPLETE");
  assert.equal(final.provider_post_id, "7600000000000000001", "the provider's public post id is recorded from its own evidence");
});

// ---------------------------------------------------------------------------
// 8. Route/UI source-level guards
// ---------------------------------------------------------------------------

test("the OAuth routes keep the secret server-side, the state double-submit, and the callback consumes before exchange", async () => {
  const connect = await read("app/api/integrations/tiktok/connect/route.ts");
  assert.match(connect, /httpOnly: true/, "the state cookie is httpOnly");
  assert.match(connect, /path: "\/api\/integrations\/tiktok\/callback"/, "scoped to the callback path");
  assert.match(connect, /maxAge: 600/, "the state cookie expires with the state");
  assert.doesNotMatch(connect, /client_secret/, "the secret is never referenced in a browser-bound response");

  const callback = await read("app/api/integrations/tiktok/callback/route.ts");
  assert.match(callback, /consumeTikTokOAuthState\(admin, user\.id, state, cookieState\)/, "double-submit: URL state + cookie state + DB row");
  assert.match(callback, /\^\[A-Za-z0-9_-\]\{43\}\$/.source.replace(/\\/g, "") ? /43/ : /43/, "the state shape is validated");
  assert.match(callback, /\{43\}/, "the 43-char base64url state shape is validated");
  const consumeIdx = callback.indexOf("consumeTikTokOAuthState(admin, user.id, state, cookieState)");
  const exchangeIdx = callback.indexOf("client.exchangeCode(code)");
  assert.ok(consumeIdx > -1 && exchangeIdx > consumeIdx, "the state is consumed BEFORE the code is exchanged");
  assert.match(callback, /if \(!tokens\.refreshToken\)/, "no refresh token, no unattended publishing — refused truthfully");
  assert.doesNotMatch(callback, /searchParams\.set\("(access_token|refresh_token|token)"/, "no token ever appears in a redirect URL");
});

test("the status/queue/settings routes sanitize: no tokens, no upload URLs, only the four real privacy values", async () => {
  const status = await read("app/api/integrations/tiktok/status/route.ts");
  assert.doesNotMatch(status, /refresh_token|access_token",/);
  const queue = await read("app/api/integrations/tiktok/queue/route.ts");
  assert.doesNotMatch(queue, /upload_url/, "the signed upload URL never leaves the server");
  assert.doesNotMatch(queue, /refresh_token/, "no token material in the queue payload");
  assert.match(queue, /providerStatus|provider_status/, "the provider's own status is surfaced next to Voom's state");
  const settings = await read("app/api/integrations/tiktok/settings/route.ts");
  assert.match(settings, /z\.enum\(\["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"\]\)\.nullable\(\)/, "only the four real values, and null to clear");
  assert.match(settings, /\.strict\(\)/, "no undocumented field is accepted");
});

test("the cron routes require CRON_SECRET, declare the 300s ceiling, and the worker is the only thing they run", async () => {
  for (const name of ["tiktok-publish", "tiktok-reconcile"]) {
    const route = await read(`app/api/cron/${name}/route.ts`);
    assert.match(route, /maxDuration = 300/, "the declared ceiling matches the worker's budget math");
    assert.match(route, /CRON_SECRET/, "Bearer-secret protected like the other workers");
    assert.match(route, /Bearer \$\{secret\}/, "the header must equal Bearer + secret");
    assert.match(route, /runTikTokPublishing|runTikTokReconciliation/, "the route runs exactly the worker and nothing else");
  }
});

test("the TikTok hub page tells the provider truth: identity, scopes, unaudited warning, no invented performance numbers", async () => {
  const page = await read("app/app/(shell)/tiktok/page.tsx");
  assert.match(page, /integrations\/tiktok\/status/, "the hub reads the real status endpoint");
  assert.match(page, /integrations\/tiktok\/queue/, "the hub reads the real queue endpoint");
  assert.match(page, /integrations\/tiktok\/settings/, "the privacy default is a real, persisted owner choice");
  assert.match(page, /TikTokConnectModal/, "connect is a real flow");
  assert.match(page, /DisconnectTikTokModal/, "disconnect is a real flow");
  assert.match(page, /unaudited/i, "the unaudited restriction is disclosed");
  assert.match(page, /SELF_ONLY|private/i, "the SELF_ONLY viewership truth is shown");
  assert.match(page, /performance data is not available/i, "performance is honestly unavailable");
  assert.doesNotMatch(page, /loadPerformanceReport|PerformanceIntelligence|PerformanceSignals/i, "no performance plumbing — no fake TikTok analytics numbers");

  const connections = await read("app/app/(shell)/connections/page.tsx");
  assert.match(connections, /getTikTokConnection/, "the connections tile reads the REAL connection");
  assert.match(connections, /video\.publish/, "the tile requires the actual granted publish scope");
  assert.doesNotMatch(connections, /publishing connections do not exist/i, "the stale planning-only claim is gone");
});

test("the publisher boundary is real: the registry builds a live TikTok publisher and the guard blocks unconnected execution", async () => {
  const publisher = await read("lib/social/publisher.ts");
  assert.match(publisher, /createTikTokPublisher/, "the real TikTok publisher is registered");
  assert.doesNotMatch(publisher, /TikTok publishing is not connected yet/i);
  const serverDrafts = await read("lib/social/server-drafts.ts");
  assert.match(serverDrafts, /syncSocialDraftToTikTokQueue/, "approval syncs into the durable queue");
  assert.match(serverDrafts, /enqueueTikTokPublishItem/, "approved + scheduled enqueues");
  assert.match(serverDrafts, /cancelTikTokPublishItem/, "un-approving cancels the queued item");
});

test(".env.example documents the TikTok variables the rollout needs (placeholders only)", async () => {
  const env = await read(".env.example");
  for (const name of ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REDIRECT_URI", "TIKTOK_TOKEN_ENCRYPTION_KEY", "TIKTOK_TOKEN_ENCRYPTION_KEY_NEXT", "TIKTOK_TOKEN_ENCRYPTION_KEY_LEGACY", "TIKTOK_APP_AUDITED"]) {
    // The line must be exactly `NAME=` — documented, but no real value committed.
    const line = env.split("\n").find((l) => l.startsWith(`${name}=`));
    assert.equal(line, `${name}=`, `${name} is documented as an empty placeholder`);
  }
});

// ---------------------------------------------------------------------------
// 9. Migration 0049 boundary: additive, RLS-protected, touching no other object
// ---------------------------------------------------------------------------

test("migration 0049 is additive: it creates only tiktok_* objects and schedules no cron", async () => {
  const rawSql = await read("supabase/migrations/0049_tiktok_provider.sql");
  // Scan the live statements only — comment blocks (including the documented
  // rollback snippet) are not part of what the migration executes.
  const sql = rawSql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  // Only tiktok objects are created (tables are tiktok_*; the RPCs are
  // named save_/claim_/..._tiktok_*, all of them tiktok-scoped).
  const creates = [...sql.matchAll(/create (?:or replace )?(?:table|function|trigger|index|policy)[^\n]*public\.(\w+)/g)].map((m) => m[1]);
  for (const name of new Set(creates)) {
    assert.match(name, /tiktok/, `0049 only creates TikTok-scoped objects (found ${name})`);
  }
  // Every drop targets a tiktok object (the drop-if-exists re-creations of its
  // own triggers included); nothing pre-existing is ever dropped.
  const drops = [...sql.matchAll(/\bdrop (?:table|function|index|policy|trigger)(?: if exists)? ["']?(\w+)/g)].map((m) => m[1]);
  for (const name of new Set(drops)) {
    assert.match(name, /tiktok_/, `0049 only drops its own tiktok_* objects (found ${name})`);
  }
  assert.doesNotMatch(sql, /\balter (table|schema) public\.(?!tiktok_)/i, "no pre-existing table is altered");
  assert.doesNotMatch(sql, /\brecreate/i);
  // It schedules nothing: no pg_cron, no pgmq, no webhook.
  assert.doesNotMatch(sql, /pg_cron|cron\.job|pgmq/i, "no cron is configured by the migration itself");
});

test("rolling-plan channel assignment requires no database migration", async () => {
  const { execSync } = await import("node:child_process");
  const ls = (cmd) => execSync(cmd, { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
  const mainFiles = ls("git ls-tree -r --name-only main -- supabase/migrations/");
  const current = ls("git ls-files supabase/migrations/").concat(ls("git ls-files --others --exclude-standard supabase/migrations/")).sort();
  const added = current.filter((file) => !mainFiles.includes(file));
  const removed = mainFiles.filter((file) => !current.includes(file));
  assert.deepEqual(added, [], "no new migration was needed for server-owned slot assignment");
  assert.deepEqual(removed, [], "all pre-existing migrations remain untouched");
});
