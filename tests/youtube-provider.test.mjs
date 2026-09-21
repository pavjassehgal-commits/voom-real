/**
 * REAL YouTube Provider Integration v1 — focused tests for migration 0047
 * and lib/youtube/*.
 *
 * What is covered, and how truthfully:
 *   1. least-privilege OAuth scopes and the server-side configuration,
 *   2. token crypto (AES-256-GCM ring: encrypt/decrypt/rotate/tamper),
 *   3. the publishing primitives — resumable-upload math, real-video-id
 *      validation, the never-guess audience declaration, videos.insert
 *      metadata (selfDeclaredMadeForKids ALWAYS explicit), the provider
 *      failure taxonomy (quota != auth != media), Pacific quota resets,
 *   4. the Google client against FAKE fetch responses shaped exactly like
 *      the official OAuth / resumable-upload / Data API responses,
 *   5. the publish flow against fake ports: approval re-check, declaration
 *      parking, resumable sessions, interruption recovery, fail-closed
 *      ambiguity, published ONLY on YouTube's own 'processed' evidence,
 *   6. migration 0047's real SQL on an embedded PostgreSQL (PGlite):
 *      idempotent enqueue, atomic claims, the published-row guard, provider
 *      evidence requirements, disconnect semantics, owner isolation,
 *   7. the workers end-to-end (upload, reconciliation, performance) with
 *      PGlite as the database and a fake Google client,
 *   8. route/UI source-level guards (secrets never reach the browser, cron
 *      authentication, truthful banners),
 *   9. migration 0047's boundary: additive, RLS-protected, touching no
 *      Instagram/email/Campaigns object, scheduling no cron.
 *
 * NOTHING here performs a real external action: no real YouTube upload,
 * OAuth, delete or analytics call ever happens. Google is answered by
 * fakes shaped from the official documentation (developers.google.com
 * YouTube Data API v3: videos.insert resumable protocol, OAuth 2.0 for
 * installed/server apps, videos.list processingDetails/statistics).
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const pub = await import("../lib/youtube/publishing.ts");
const scopesMod = await import("../lib/youtube/scopes.ts");
const configMod = await import("../lib/youtube/config.ts");
const ytCrypto = await import("../lib/youtube/crypto.ts");
const clientMod = await import("../lib/youtube/client.ts");
const flowMod = await import("../lib/youtube/publish-flow.ts");
const queueMod = await import("../lib/youtube/publish-queue.ts");
const dataMod = await import("../lib/youtube/data.ts");
const workerMod = await import("../lib/youtube/publish-worker.ts");
const reconcileMod = await import("../lib/youtube/reconcile.ts");
const perfMod = await import("../lib/youtube/performance.ts");
const publishStateMod = await import("../lib/social/publish-state.ts");
const statusMod = await import("../lib/campaign/status.ts");
const channelsMod = await import("../lib/social/channels.ts");

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "99999999-9999-4999-8999-999999999999";
const DRAFT_A = "22222222-2222-4222-8222-222222222222";
const DRAFT_B = "33333333-3333-4333-8333-333333333333";
const VIDEO_ID = "dQw4w9WgXcQ"; // 11 URL-safe characters: a real-shaped id
const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const nowIso = (ms = 0) => new Date(NOW + ms).toISOString();

const KEY = "k".repeat(32);
const KEY_NEXT = "n".repeat(32);
const KEY_LEGACY = "l".repeat(32);

function fakeConfig(extra = {}) {
  return {
    clientId: "google-client-id",
    clientSecret: "google-client-secret",
    redirectUri: "https://app.voom.example/api/integrations/youtube/callback",
    encryptionKey: KEY,
    legacyEncryptionKeys: [],
    projectAudited: false,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// A PostgREST-shaped admin client backed by the REAL embedded PostgreSQL, so
// every RPC below executes migration 0047's actual SQL (that is where the
// guarantees live). Same pattern the branded-email suite proved out.
// ---------------------------------------------------------------------------

const RPC_DEFS = {
  save_youtube_connection: {
    params: [
      ["p_owner_user_id", "uuid"], ["p_channel_id", "text"], ["p_channel_title", "text"],
      ["p_channel_handle", "text"], ["p_thumbnail_url", "text"], ["p_scopes", "text[]"],
      ["p_encrypted_refresh_token", "text"], ["p_refresh_iv", "text"], ["p_refresh_auth_tag", "text"],
      ["p_refresh_key_version", "smallint"], ["p_encrypted_access_token", "text"], ["p_access_iv", "text"],
      ["p_access_auth_tag", "text"], ["p_access_key_version", "smallint"], ["p_access_token_expires_at", "timestamptz"],
    ],
    returns: "scalar",
  },
  disconnect_youtube_connection: { params: [["p_owner_user_id", "uuid"]], returns: "scalar" },
  get_youtube_connection_secret: { params: [["p_owner_user_id", "uuid"]], returns: "setof" },
  update_youtube_access_token: {
    params: [
      ["p_owner_user_id", "uuid"], ["p_encrypted_access_token", "text"], ["p_access_iv", "text"],
      ["p_access_auth_tag", "text"], ["p_access_key_version", "smallint"], ["p_access_token_expires_at", "timestamptz"],
    ],
    returns: "scalar",
  },
  set_youtube_connection_status: { params: [["p_owner_user_id", "uuid"], ["p_status", "text"]], returns: "scalar" },
  set_youtube_publish_defaults: {
    params: [["p_owner_user_id", "uuid"], ["p_default_privacy", "text"], ["p_default_made_for_kids", "boolean"]],
    returns: "scalar",
  },
  upsert_youtube_publish_queue_item: {
    params: [
      ["p_owner_user_id", "uuid"], ["p_draft_id", "uuid"], ["p_calendar_item_id", "uuid"],
      ["p_youtube_format", "text"], ["p_title", "text"], ["p_description", "text"],
      ["p_privacy_status", "text"], ["p_made_for_kids", "boolean"], ["p_category_id", "text"],
      ["p_scheduled_at", "timestamptz"], ["p_waiting_for_media", "boolean"],
    ],
    returns: "composite",
  },
  cancel_youtube_publish_queue_item: { params: [["p_owner_user_id", "uuid"], ["p_draft_id", "uuid"]], returns: "scalar" },
  claim_due_youtube_upload_jobs: {
    params: [["p_limit", "integer"], ["p_now", "timestamptz"], ["p_max_attempts", "integer"], ["p_stale_after", "interval"]],
    returns: "setof",
  },
  claim_youtube_reconcile_jobs: {
    params: [["p_limit", "integer"], ["p_now", "timestamptz"], ["p_max_attempts", "integer"], ["p_stale_after", "interval"]],
    returns: "setof",
  },
  record_youtube_upload_session: {
    params: [["p_id", "uuid"], ["p_owner_user_id", "uuid"], ["p_session_url", "text"], ["p_content_length", "bigint"]],
    returns: "composite",
  },
  record_youtube_upload_progress: {
    params: [["p_id", "uuid"], ["p_owner_user_id", "uuid"], ["p_bytes_sent", "bigint"]],
    returns: "composite",
  },
  record_youtube_video_id: {
    params: [
      ["p_id", "uuid"], ["p_owner_user_id", "uuid"], ["p_youtube_video_id", "text"],
      ["p_provider_upload_status", "text"], ["p_provider_privacy_status", "text"],
    ],
    returns: "composite",
  },
  complete_youtube_publish_job: {
    params: [
      ["p_id", "uuid"], ["p_owner_user_id", "uuid"], ["p_provider_upload_status", "text"],
      ["p_provider_privacy_status", "text"], ["p_provider_note", "text"],
    ],
    returns: "composite",
  },
  fail_youtube_publish_job: {
    params: [
      ["p_id", "uuid"], ["p_owner_user_id", "uuid"], ["p_failure_code", "text"], ["p_failure_message", "text"],
      ["p_status", "text"], ["p_retry_at", "timestamptz"], ["p_reset_attempts", "boolean"],
    ],
    returns: "composite",
  },
  record_youtube_provider_status: {
    params: [
      ["p_id", "uuid"], ["p_owner_user_id", "uuid"], ["p_provider_upload_status", "text"],
      ["p_provider_privacy_status", "text"], ["p_provider_note", "text"], ["p_last_provider_check_at", "timestamptz"],
    ],
    returns: "composite",
  },
  list_youtube_published_for_verification: {
    params: [["p_limit", "integer"], ["p_now", "timestamptz"], ["p_min_age", "interval"]],
    returns: "setof",
  },
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

      // Filter fragments reference their own params as #N; assembleWhere
      // renumbers them into sequential $n placeholders.
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
          // Supports the exact shapes lib/youtube uses: `col.is.null,col.lt.<iso>`.
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

// A fake Google: every response is shaped like the official API's.
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
  };
}

// ---------------------------------------------------------------------------
// 1. Least-privilege scopes and server-side configuration
// ---------------------------------------------------------------------------

test("Voom asks Google for exactly two least-privilege scopes — never delete power, never analytics, never profile", async () => {
  assert.deepEqual([...scopesMod.YOUTUBE_SCOPES], [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
  ]);
  const source = await read("lib/youtube/scopes.ts");
  for (const forbidden of [/youtube\.force-ssl/, /auth\/youtube("|'|\s|$)(?![.a-z])/m, /yt-analytics/, /userinfo/, /openid/]) {
    // force-ssl / bare youtube / analytics / profile scopes must not be REQUESTED.
    const requested = source.slice(source.indexOf("export const YOUTUBE_UPLOAD_SCOPE"), source.indexOf("export function hasUploadPermission"));
    assert.doesNotMatch(requested, forbidden, "the requested scope set stays least-privilege");
  }
  assert.equal(scopesMod.hasUploadPermission([scopesMod.YOUTUBE_UPLOAD_SCOPE]), true);
  assert.equal(scopesMod.hasUploadPermission([scopesMod.YOUTUBE_READONLY_SCOPE]), false);
  assert.equal(scopesMod.hasUploadPermission(null), false);
  assert.equal(scopesMod.hasReadPermission([scopesMod.YOUTUBE_READONLY_SCOPE]), true);
});

test("the authorization URL is the server-side auth-code flow with offline access and the strong state", () => {
  const client = new clientMod.YouTubeClient(fakeConfig());
  const url = new URL(client.authorizationUrl("state-value-abc"));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("access_type"), "offline", "offline access is how Google issues the refresh token");
  assert.equal(url.searchParams.get("prompt"), "consent", "consent is re-prompted so the refresh token is really issued");
  assert.equal(url.searchParams.get("state"), "state-value-abc");
  assert.equal(url.searchParams.get("client_id"), "google-client-id");
  assert.deepEqual(url.searchParams.get("scope").split(" "), [...scopesMod.YOUTUBE_SCOPES]);
  // A server-side flow never embeds a client secret in a browser-bound URL.
  assert.ok(!url.toString().includes("google-client-secret"), "no secret in the authorization URL");
});

test("configuration is server-env only, defaults to the SAFE unaudited assumption, and fails closed when incomplete", () => {
  const saved = { ...process.env };
  try {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.YOUTUBE_REDIRECT_URI;
    delete process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY;
    delete process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY_NEXT;
    delete process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY_LEGACY;
    delete process.env.YOUTUBE_PROJECT_AUDITED;
    assert.equal(configMod.readYouTubeConfig(), null, "an unconfigured deployment reads null, never a guess");

    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.YOUTUBE_REDIRECT_URI = "https://app.example/api/integrations/youtube/callback";
    process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY = "short";
    assert.equal(configMod.readYouTubeConfig(), null, "a weak encryption key is refused");

    process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY = KEY;
    const config = configMod.readYouTubeConfig();
    assert.ok(config, "a complete configuration parses");
    assert.equal(config.projectAudited, false, "projectAudited defaults to FALSE — the documented upload restriction is assumed until proven otherwise");

    process.env.YOUTUBE_PROJECT_AUDITED = "true";
    process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY_NEXT = KEY_NEXT;
    process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY_LEGACY = `${KEY_LEGACY}, ${KEY}`;
    const audited = configMod.readYouTubeConfig();
    assert.equal(audited.projectAudited, true);
    const ring = configMod.youTubeKeyRing(audited);
    assert.equal(ring.primary, KEY, "encryption uses the PRIMARY key only");
    assert.equal(ring.next, KEY_NEXT, "the staged rotation key is a read fallback");
    assert.deepEqual(ring.legacy, [KEY_LEGACY], "the primary key is never duplicated into legacy");
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

// ---------------------------------------------------------------------------
// 2. Token crypto: AES-256-GCM, key ring, tamper evidence
// ---------------------------------------------------------------------------

test("tokens round-trip through AES-256-GCM and the ciphertext never contains the plaintext", () => {
  const encrypted = ytCrypto.encryptYouTubeToken("refresh-token-1//0secret", KEY);
  assert.ok(encrypted.encryptedToken && encrypted.iv && encrypted.authTag);
  assert.ok(!encrypted.encryptedToken.includes("refresh-token-1"), "ciphertext hides the token");
  assert.equal(encrypted.keyVersion, ytCrypto.CURRENT_KEY_VERSION, "new encryptions always use the current key version");
  const decrypted = ytCrypto.decryptYouTubeToken({
    encryptedToken: encrypted.encryptedToken, iv: encrypted.iv, authTag: encrypted.authTag,
  }, KEY);
  assert.equal(decrypted, "refresh-token-1//0secret");

  const again = ytCrypto.encryptYouTubeToken("refresh-token-1//0secret", KEY);
  assert.notEqual(again.iv, encrypted.iv, "every encryption uses a fresh IV (GCM reuse would be catastrophic)");
  assert.notEqual(again.encryptedToken, encrypted.encryptedToken);
});

test("tampered ciphertext, a wrong key and a wrong auth tag all fail closed", () => {
  const encrypted = ytCrypto.encryptYouTubeToken("token-value", KEY);
  const stored = { encryptedToken: encrypted.encryptedToken, iv: encrypted.iv, authTag: encrypted.authTag };

  const flipped = Buffer.from(encrypted.encryptedToken, "base64");
  flipped[0] = flipped[0] ^ 0xff;
  assert.throws(
    () => ytCrypto.decryptYouTubeToken({ ...stored, encryptedToken: flipped.toString("base64") }, KEY),
    ytCrypto.YouTubeTokenDecryptionError,
    "GCM authentication catches ciphertext tampering",
  );
  assert.throws(() => ytCrypto.decryptYouTubeToken(stored, "w".repeat(32)), ytCrypto.YouTubeTokenDecryptionError, "a wrong key cannot decrypt");
  assert.throws(
    () => ytCrypto.decryptYouTubeToken({ ...stored, authTag: "0".repeat(32) }, KEY),
    ytCrypto.YouTubeTokenDecryptionError,
    "a wrong auth tag cannot decrypt",
  );
});

test("the key ring decrypts current, staged and legacy ciphertexts; rotation staging encrypts with the NEXT key", () => {
  const ring = { primary: KEY, next: KEY_NEXT, legacy: [KEY_LEGACY] };
  const legacyCipher = ytCrypto.encryptYouTubeToken("old-token", KEY_LEGACY);
  assert.equal(ytCrypto.decryptYouTubeToken({
    encryptedToken: legacyCipher.encryptedToken, iv: legacyCipher.iv, authTag: legacyCipher.authTag,
  }, ring), "old-token", "a legacy-key ciphertext still decrypts during rotation");

  const staged = ytCrypto.encryptYouTubeTokenForStagedRotation("new-token", KEY_NEXT);
  assert.equal(staged.keyVersion, ytCrypto.STAGED_KEY_VERSION);
  assert.equal(ytCrypto.decryptYouTubeToken({
    encryptedToken: staged.encryptedToken, iv: staged.iv, authTag: staged.authTag,
  }, ring), "new-token", "the staged key is in the read path before it becomes primary");

  const parsed = ytCrypto.parseStoredToken(staged.encryptedToken);
  assert.equal(parsed.version, ytCrypto.STAGED_KEY_VERSION, "the stored token carries its key version");
});

// ---------------------------------------------------------------------------
// 3. Publishing primitives
// ---------------------------------------------------------------------------

test("the queue state machine separates scheduled, submitted, provider-accepted and published", () => {
  for (const state of ["scheduled", "waiting_for_media", "needs_declaration", "permission_required", "uploading", "provider_processing", "published", "failed", "cancelled"]) {
    assert.ok(pub.YOUTUBE_PUBLISH_STATES.includes(state), `${state} exists`);
    assert.ok(pub.YOUTUBE_PUBLISH_STATE_LABELS[state], `${state} has a label`);
  }
  assert.deepEqual(pub.TERMINAL_YOUTUBE_PUBLISH_STATES, ["published", "cancelled"]);
  // The four provider truths are DISTINCT labels, never collapsed.
  const labels = pub.YOUTUBE_PUBLISH_STATE_LABELS;
  assert.notEqual(labels.scheduled, labels.uploading);
  assert.notEqual(labels.uploading, labels.provider_processing);
  assert.notEqual(labels.provider_processing, labels.published);
  assert.equal(labels.published, "Published on YouTube");

  assert.equal(pub.willAutoPublish("scheduled"), true);
  assert.equal(pub.willAutoPublish("uploading"), true);
  assert.equal(pub.willAutoPublish("provider_processing"), true);
  assert.equal(pub.willAutoPublish("waiting_for_media"), true);
  assert.equal(pub.willAutoPublish("published"), false);
  assert.equal(pub.willAutoPublish("failed"), false);
  assert.equal(pub.willAutoPublish("needs_declaration"), false);
  assert.equal(pub.willAutoPublish("permission_required"), false);

  assert.equal(pub.youTubePublishStatusTone("published"), "green");
  assert.equal(pub.youTubePublishStatusTone("provider_processing"), "amber");
  assert.equal(pub.youTubePublishStatusTone("needs_declaration"), "red");
  assert.equal(pub.youTubePublishStatusTone("cancelled"), "grey");
});

test("published requires YouTube's OWN 'processed' evidence — acceptance is not publication", () => {
  assert.deepEqual([...pub.PROVIDER_UPLOAD_STATUSES], ["uploaded", "processed", "rejected", "failed", "deleted"]);
  assert.equal(pub.isPublishedEvidence("processed"), true);
  assert.equal(pub.isPublishedEvidence("uploaded"), false, "provider acceptance (uploaded) is NOT published");
  assert.equal(pub.isPublishedEvidence("rejected"), false);
  assert.equal(pub.isPublishedEvidence(null), false);
  assert.equal(pub.isPublishedEvidence("PROCESSED"), false, "only the exact documented value counts");
});

test("chunk math obeys Google's resumable protocol: 256 KiB granularity, exact final chunk, truthful ranges", () => {
  assert.equal(pub.RESUMABLE_CHUNK_GRANULARITY_BYTES, 262144);
  const size = pub.chunkSize();
  assert.equal(size % pub.RESUMABLE_CHUNK_GRANULARITY_BYTES, 0, "the chunk size is a multiple of 256 KiB as Google requires");

  const total = size + 1000; // one full chunk plus a partial final chunk
  const first = pub.chunkWindow(0, total);
  assert.deepEqual({ start: first.start, end: first.end, length: first.length, final: first.final }, { start: 0, end: size - 1, length: size, final: false });
  const last = pub.chunkWindow(size, total);
  assert.equal(last.final, true);
  assert.equal(last.length, 1000, "the final chunk may be any size");
  assert.equal(pub.chunkWindow(total, total), null, "no window remains when every byte is sent");

  assert.equal(pub.contentRangeFor({ start: 0, end: size - 1 }, total), `bytes 0-${size - 1}/${total}`);
  assert.equal(pub.statusQueryRange(total), `bytes */${total}`, "the status query is Google's documented empty-body PUT");

  assert.equal(pub.receivedBytesFromRange("bytes=0-381"), 382, "Range end is inclusive: 382 bytes received");
  assert.equal(pub.receivedBytesFromRange(null), 0);
  assert.equal(pub.receivedBytesFromRange("garbage"), 0);
});

test("only a real 11-character YouTube video id is ever accepted as provider evidence", () => {
  assert.equal(pub.isRealYouTubeVideoId(VIDEO_ID), true);
  assert.equal(pub.isRealYouTubeVideoId("abcdefghijk"), true);
  assert.equal(pub.isRealYouTubeVideoId("AAAAAAAAAAA"), true);
  for (const fake of ["short-id", "toolongvideoidentifier", "has space11", "", null, undefined, 12345678901, "quote'chars"]) {
    assert.equal(pub.isRealYouTubeVideoId(fake), false, `${String(fake)} is not a real video id`);
  }
});

test("metadata obeys YouTube's documented limits and shapes", () => {
  assert.equal(pub.YOUTUBE_TITLE_MAX, 100);
  assert.equal(pub.YOUTUBE_DESCRIPTION_MAX, 5000);
  assert.equal(pub.truncateYouTubeTitle("x".repeat(150)).length, 100);
  assert.equal(pub.truncateYouTubeTitle("  Trim me  "), "Trim me");
  assert.equal(pub.truncateYouTubeDescription("y".repeat(6000)).length, 5000);
  assert.equal(pub.isYouTubePublishableMime("video/mp4"), true);
  assert.equal(pub.isYouTubePublishableMime("video/quicktime"), true);
  assert.equal(pub.isYouTubePublishableMime("video/webm"), true);
  assert.equal(pub.isYouTubePublishableMime("video/x-matroska"), true);
  assert.equal(pub.isYouTubePublishableMime("image/png"), false);
  assert.equal(pub.isYouTubePublishableMime("application/octet-stream"), false);
});

test("the audience declaration is NEVER guessed: explicit item wins, explicit default fills, otherwise it parks", () => {
  const explicit = pub.resolveAudienceDeclaration({ itemMadeForKids: true, itemPrivacy: "unlisted" });
  assert.deepEqual(explicit, { ok: true, madeForKids: true, privacy: "unlisted" });

  const defaulted = pub.resolveAudienceDeclaration({ itemMadeForKids: null, itemPrivacy: null, defaultMadeForKids: false, defaultPrivacy: "private" });
  assert.deepEqual(defaulted, { ok: true, madeForKids: false, privacy: "private" });

  const itemWins = pub.resolveAudienceDeclaration({ itemMadeForKids: false, itemPrivacy: "public", defaultMadeForKids: true, defaultPrivacy: "private" });
  assert.deepEqual(itemWins, { ok: true, madeForKids: false, privacy: "public" });

  const missingBoth = pub.resolveAudienceDeclaration({});
  assert.equal(missingBoth.ok, false);
  assert.deepEqual(missingBoth.missing.sort(), ["made_for_kids", "privacy"]);

  const missingPrivacy = pub.resolveAudienceDeclaration({ itemMadeForKids: false });
  assert.equal(missingPrivacy.ok, false);
  assert.deepEqual(missingPrivacy.missing, ["privacy"]);

  // An invented privacy value is treated as no declaration at all.
  const invented = pub.resolveAudienceDeclaration({ itemMadeForKids: false, itemPrivacy: "followers-only" });
  assert.equal(invented.ok, false);
});

test("videos.insert metadata always carries the explicit self-declared audience (madeForKids is output-only)", () => {
  const metadata = pub.videoInsertMetadata({
    title: "Launch teaser",
    description: "Our 30-second launch",
    categoryId: "22",
    privacy: "private",
    madeForKids: false,
  });
  assert.deepEqual(metadata.status.privacyStatus, "private");
  assert.equal(metadata.status.selfDeclaredMadeForKids, false, "ALWAYS explicit — Google silently blocks views otherwise");
  assert.ok(!("madeForKids" in metadata.status), "madeForKids is output-only and never sent");
  assert.equal(metadata.snippet.categoryId, "22");
  assert.equal(metadata.snippet.title, "Launch teaser");

  const kids = pub.videoInsertMetadata({ title: "t", description: "d", categoryId: "22", privacy: "public", madeForKids: true });
  assert.equal(kids.status.selfDeclaredMadeForKids, true);

  const disclosed = pub.videoInsertMetadata({ title: "t", description: "d", categoryId: "22", privacy: "public", madeForKids: false, containsSyntheticMedia: true });
  assert.equal(disclosed.status.containsSyntheticMedia, true, "an explicit AI-content disclosure is passed through");
  const undisclosed = pub.videoInsertMetadata({ title: "t", description: "d", categoryId: "22", privacy: "public", madeForKids: false, containsSyntheticMedia: null });
  assert.ok(!("containsSyntheticMedia" in undisclosed.status), "no disclosure is invented when the owner set none");
});

test("the failure taxonomy keeps quota, authorization and media failures DISTINCT with truthful statuses", () => {
  assert.equal(pub.failureForApiError({ kind: "quota", reason: "quotaExceeded" }), "quota_exceeded");
  assert.equal(pub.failureForApiError({ kind: "rate_limited" }), "rate_limited");
  assert.equal(pub.failureForApiError({ kind: "auth", reason: "invalid_grant" }), "authorization_revoked");
  assert.equal(pub.failureForApiError({ kind: "network" }), "upload_interrupted");
  assert.equal(pub.failureForApiError({ kind: "server" }), "upload_interrupted");
  assert.equal(pub.failureForApiError({ kind: "not_found" }), "video_unavailable");

  const quota = pub.YOUTUBE_PUBLISH_FAILURES.quota_exceeded;
  assert.equal(quota.status, "scheduled", "quota exhaustion is a hold, not a failure of the item");
  assert.equal(quota.quotaHold, true);
  assert.match(quota.message, /midnight US Pacific/i);

  const auth = pub.YOUTUBE_PUBLISH_FAILURES.authorization_revoked;
  assert.equal(auth.status, "permission_required");
  assert.match(auth.message, /Reconnect/i);

  const declaration = pub.YOUTUBE_PUBLISH_FAILURES.needs_declaration;
  assert.equal(declaration.status, "needs_declaration");

  const ambiguous = pub.YOUTUBE_PUBLISH_FAILURES.upload_ambiguous;
  assert.equal(ambiguous.status, "failed", "ambiguity FAILS CLOSED");
  assert.equal(ambiguous.retryable, false);
  assert.match(ambiguous.message, /duplicate/i);

  // Every failure message is user-safe: no tokens, URLs or provider internals.
  for (const [key, failure] of Object.entries(pub.YOUTUBE_PUBLISH_FAILURES)) {
    assert.doesNotMatch(failure.message, /https?:\/\//i, `${key} message leaks no URL`);
    assert.doesNotMatch(failure.message, /token|bearer|authorization header/i, `${key} message leaks no credential talk`);
    assert.ok(failure.code && failure.status, `${key} is complete`);
  }

  // After the attempt cap even a retryable hold becomes terminal.
  const exhausted = pub.resolveYouTubeFailure("upload_interrupted", pub.MAX_YOUTUBE_PUBLISH_ATTEMPTS);
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.retryable, false);
  const fresh = pub.resolveYouTubeFailure("upload_interrupted", 1);
  assert.equal(fresh.status, "scheduled");
  assert.equal(fresh.retryable, true);
});

test("retry timing: worker-cadence alignment and the real Pacific quota reset", () => {
  const retry = Date.parse(pub.retryAt(NOW));
  assert.ok(retry > NOW, "a retry is always in the future");
  assert.ok(retry - NOW <= pub.YOUTUBE_WORKER_PERIOD_MS, "and never further than one worker period");

  // 2026-09-21T12:00Z is 05:00 PDT; the next Pacific midnight is 07:00Z on the 22nd.
  assert.equal(pub.nextQuotaResetAt(NOW), "2026-09-22T07:00:00.000Z", "quota resets at midnight US Pacific (DST-correct)");
  // In winter (PST = UTC-8) midnight Pacific is 08:00Z.
  const winter = Date.parse("2026-12-21T12:00:00.000Z");
  assert.equal(pub.nextQuotaResetAt(winter), "2026-12-22T08:00:00.000Z", "the reset follows the real timezone database, not a fixed offset");

  assert.equal(pub.nextCronBoundaryAfter(NOW, pub.YOUTUBE_WORKER_PERIOD_MS) % pub.YOUTUBE_WORKER_PERIOD_MS, 0);

  assert.equal(pub.processingExpired(nowIso(-73 * 3600_000), NOW), true, "processing is bounded at 72h");
  assert.equal(pub.processingExpired(nowIso(-71 * 3600_000), NOW), false);
  assert.equal(pub.processingExpired(null, NOW), false);
});

test("idempotency keys and the performance window are deterministic", () => {
  assert.equal(pub.youTubePublishIdempotencyKey(DRAFT_A), "ytpub_22222222222242228222222222222222");
  assert.equal(pub.youTubePublishIdempotencyKey(DRAFT_A), pub.youTubePublishIdempotencyKey(DRAFT_A));
  assert.notEqual(pub.youTubePublishIdempotencyKey(DRAFT_A), pub.youTubePublishIdempotencyKey(DRAFT_B));

  const windowStart = pub.performanceWindowStart(Date.parse("2026-09-21T12:34:56.000Z"));
  assert.equal(windowStart, "2026-09-21T12:00:00.000Z", "snapshots bucket to the hour, so re-runs refresh one row");
});

// ---------------------------------------------------------------------------
// 4. The Google client against FAKE official-shaped responses
// ---------------------------------------------------------------------------

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SESSION_URL = "https://upload-session.test/videos?upload_id=fake-session";

function fakeFetch(routes) {
  const calls = [];
  const request = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    for (const [match, handler] of routes) {
      if (target.startsWith(match)) return handler(target, init, calls.length);
    }
    throw new Error(`fake fetch: unrouted ${target}`);
  };
  return { request, calls };
}

test("code exchange posts the documented form and returns Google's own token set (refresh token included)", async () => {
  const { request, calls } = fakeFetch([
    [TOKEN_URL, () => jsonResponse(200, {
      access_token: "ya29.access",
      refresh_token: "1//refresh",
      expires_in: 3599,
      scope: scopesMod.YOUTUBE_SCOPES.join(" "),
      token_type: "Bearer",
    })],
  ]);
  const client = new clientMod.YouTubeClient(fakeConfig(), request);
  const tokens = await client.exchangeCode("4/auth-code");
  assert.equal(tokens.accessToken, "ya29.access");
  assert.equal(tokens.refreshToken, "1//refresh", "offline access yields the long-lived refresh token");
  assert.equal(tokens.expiresIn, 3599);
  assert.deepEqual(tokens.grantedScopes, [...scopesMod.YOUTUBE_SCOPES], "the scopes Google ACTUALLY granted are captured");

  const body = calls[0].init.body;
  assert.equal(body.get("code"), "4/auth-code");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("client_secret"), "google-client-secret", "the secret stays in the server-side POST body");
  assert.equal(body.get("redirect_uri"), "https://app.voom.example/api/integrations/youtube/callback");
});

test("a code exchange WITHOUT a refresh token is reported truthfully — Voom needs offline access", async () => {
  const { request } = fakeFetch([
    [TOKEN_URL, () => jsonResponse(200, { access_token: "ya29.access", expires_in: 3599, token_type: "Bearer" })],
  ]);
  const client = new clientMod.YouTubeClient(fakeConfig(), request);
  const tokens = await client.exchangeCode("4/auth-code");
  assert.equal(tokens.refreshToken, null, "no refresh token is invented when Google issued none");
});

test("refresh keeps the existing refresh token and maps invalid_grant to the truthful auth failure", async () => {
  const { request, calls } = fakeFetch([
    [TOKEN_URL, () => jsonResponse(200, { access_token: "ya29.new", expires_in: 3599, token_type: "Bearer" })],
  ]);
  const client = new clientMod.YouTubeClient(fakeConfig(), request);
  const refreshed = await client.refreshAccessToken("1//refresh");
  assert.equal(refreshed.accessToken, "ya29.new");
  assert.equal(refreshed.refreshToken, "1//refresh", "a refresh never returns a new refresh token; the stored one persists");
  assert.equal(calls[0].init.body.get("grant_type"), "refresh_token");

  const revokedFetch = fakeFetch([
    [TOKEN_URL, () => jsonResponse(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })],
  ]);
  const revokedClient = new clientMod.YouTubeClient(fakeConfig(), revokedFetch.request);
  await assert.rejects(
    () => revokedClient.refreshAccessToken("1//revoked"),
    (error) => {
      assert.ok(error instanceof clientMod.YouTubeApiError);
      assert.equal(error.kind, "auth", "invalid_grant is the truthful 'authorization no longer valid'");
      assert.equal(error.reason, "invalid_grant");
      assert.ok(!error.message.includes("1//revoked"), "the token itself never appears in an error message");
      return true;
    },
  );
});

test("revocation is best-effort and never throws for a token Google already forgot", async () => {
  const { request, calls } = fakeFetch([
    ["https://oauth2.googleapis.com/revoke", () => jsonResponse(200, {})],
  ]);
  const client = new clientMod.YouTubeClient(fakeConfig(), request);
  assert.equal(await client.revokeToken("1//refresh"), true);
  assert.equal(calls[0].init.body.get("token"), "1//refresh");

  const failed = fakeFetch([["https://oauth2.googleapis.com/revoke", () => jsonResponse(400, { error: "invalid_token" })]]);
  const failedClient = new clientMod.YouTubeClient(fakeConfig(), failed.request);
  assert.equal(await failedClient.revokeToken("1//gone"), false, "a failed revocation reports false; local destruction does not depend on it");
});

test("channels.list?mine=true yields the authoritative channel identity", async () => {
  const { request, calls } = fakeFetch([
    ["https://www.googleapis.com/youtube/v3/channels", () => jsonResponse(200, {
      items: [{
        id: "UC1234567890abcdef",
        snippet: { title: "Voom Studio", customUrl: "@voomstudio", thumbnails: { default: { url: "https://yt.test/thumb.jpg" } } },
        contentDetails: { relatedPlaylists: { uploads: "UU1234567890abcdef" } },
      }],
    })],
  ]);
  const client = new clientMod.YouTubeClient(fakeConfig(), request);
  const channel = await client.getMyChannel("ya29.access");
  assert.equal(channel.channelId, "UC1234567890abcdef");
  assert.equal(channel.title, "Voom Studio");
  assert.equal(channel.handle, "@voomstudio");
  assert.equal(channel.uploadsPlaylistId, "UU1234567890abcdef", "the uploads playlist powers the read-only recovery scan");
  assert.ok(calls[0].url.includes("mine=true"));
  assert.equal(calls[0].init.headers.Authorization, "Bearer ya29.access");

  const empty = fakeFetch([["https://www.googleapis.com/youtube/v3/channels", () => jsonResponse(200, { items: [] })]]);
  const emptyClient = new clientMod.YouTubeClient(fakeConfig(), empty.request);
  await assert.rejects(() => emptyClient.getMyChannel("ya29.access"), clientMod.YouTubeApiError, "no channel is an error, never an invented identity");
});

test("session initiation is Google's documented resumable POST: part=snippet,status, declared content type/length, Location URI", async () => {
  const { request, calls } = fakeFetch([
    ["https://www.googleapis.com/upload/youtube/v3/videos", () => jsonResponse(200, {}, { Location: SESSION_URL })],
  ]);
  const client = new clientMod.YouTubeClient(fakeConfig(), request);
  const metadata = pub.videoInsertMetadata({ title: "T", description: "D", categoryId: "22", privacy: "private", madeForKids: false });
  const { sessionUrl } = await client.initiateUploadSession("ya29.access", metadata, "video/mp4", 12345);
  assert.equal(sessionUrl, SESSION_URL);

  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("part"), "snippet,status");
  assert.equal(url.searchParams.get("uploadType"), "resumable");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-Upload-Content-Type"], "video/mp4");
  assert.equal(calls[0].init.headers["X-Upload-Content-Length"], "12345");
  assert.deepEqual(JSON.parse(calls[0].init.body), JSON.parse(JSON.stringify(metadata)));

  const noLocation = fakeFetch([["https://www.googleapis.com/upload/youtube/v3/videos", () => jsonResponse(200, {})]]);
  const noLocationClient = new clientMod.YouTubeClient(fakeConfig(), noLocation.request);
  await assert.rejects(
    () => noLocationClient.initiateUploadSession("ya29.access", metadata, "video/mp4", 1),
    (error) => error.kind === "invalid_request" && error.reason === "no_location",
    "a session without a Location header is a hard error, never a guess",
  );
});

test("Google's quota error is classified as quota — distinct from auth and media failures", async () => {
  const { request } = fakeFetch([
    ["https://www.googleapis.com/upload/youtube/v3/videos", () => jsonResponse(403, {
      error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ reason: "quotaExceeded" }] },
    })],
  ]);
  const client = new clientMod.YouTubeClient(fakeConfig(), request);
  await assert.rejects(
    () => client.initiateUploadSession("ya29.access", {}, "video/mp4", 1),
    (error) => {
      assert.equal(error.kind, "quota");
      assert.equal(error.reason, "quotaExceeded");
      assert.equal(error.httpStatus, 403);
      return true;
    },
  );
  assert.equal(pub.failureForApiError({ kind: "quota", reason: "quotaExceeded" }), "quota_exceeded");

  const dailyLimit = fakeFetch([["https://www.googleapis.com/upload/youtube/v3/videos", () => jsonResponse(403, {
    error: { code: 403, message: "Daily Limit for unverified use exceeded", errors: [{ reason: "dailyLimitExceeded" }] },
  })]]);
  const dailyClient = new clientMod.YouTubeClient(fakeConfig(), dailyLimit.request);
  await assert.rejects(
    () => dailyClient.initiateUploadSession("ya29.access", {}, "video/mp4", 1),
    (error) => error.kind === "quota" && error.reason === "dailyLimitExceeded",
    "the unaudited-project daily limit is ALSO quota, not an auth failure",
  );
});

test("chunk upload speaks the documented protocol: 308+Range continues, 200 completes with a REAL id, 410 means gone", async () => {
  const partial = fakeFetch([[SESSION_URL, () => jsonResponse(308, null, { Range: "bytes=0-8388607" })]]);
  const partialClient = new clientMod.YouTubeClient(fakeConfig(), partial.request);
  const continued = await partialClient.uploadChunk(SESSION_URL, new Uint8Array([1]), "video/mp4", "bytes 0-8388607/20000000", 8388608);
  assert.deepEqual(continued, { outcome: "continue", receivedBytes: 8388608 });
  assert.equal(partial.calls[0].init.method, "PUT");
  assert.equal(partial.calls[0].init.headers["Content-Range"], "bytes 0-8388607/20000000");

  const complete = fakeFetch([[SESSION_URL, () => jsonResponse(200, {
    id: VIDEO_ID,
    snippet: { title: "T" },
    status: { uploadStatus: "uploaded", privacyStatus: "private", selfDeclaredMadeForKids: false },
  })]]);
  const completeClient = new clientMod.YouTubeClient(fakeConfig(), complete.request);
  const done = await completeClient.uploadChunk(SESSION_URL, new Uint8Array([1]), "video/mp4", "bytes 0-99/100", 100);
  assert.equal(done.outcome, "complete");
  assert.equal(done.videoId, VIDEO_ID);
  assert.equal(done.uploadStatus, "uploaded", "provider acceptance is reported as-is, not upgraded to published");
  assert.equal(done.privacyStatus, "private");

  const gone = fakeFetch([[SESSION_URL, () => jsonResponse(410, null)]]);
  const goneClient = new clientMod.YouTubeClient(fakeConfig(), gone.request);
  assert.deepEqual(await goneClient.uploadChunk(SESSION_URL, new Uint8Array([1]), "video/mp4", "bytes 0-1/2", 2), { outcome: "gone" });

  // A 200 WITHOUT a real video id is never accepted as completion evidence.
  const fakeId = fakeFetch([[SESSION_URL, () => jsonResponse(200, { id: "not-real", status: {} })]]);
  const fakeIdClient = new clientMod.YouTubeClient(fakeConfig(), fakeId.request);
  await assert.rejects(
    () => fakeIdClient.uploadChunk(SESSION_URL, new Uint8Array([1]), "video/mp4", "bytes 0-1/2", 2),
    (error) => error.kind === "invalid_request" && error.reason === "completion_without_video_id",
    "a completion without a real 11-char id fails closed",
  );
});

test("the session status query is the documented empty PUT with Content-Range bytes */size", async () => {
  const { request, calls } = fakeFetch([[SESSION_URL, () => jsonResponse(308, null, { Range: "bytes=0-99" })]]);
  const client = new clientMod.YouTubeClient(fakeConfig(), request);
  const result = await client.queryUploadStatus(SESSION_URL, 1000);
  assert.deepEqual(result, { outcome: "continue", receivedBytes: 100 });
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.headers["Content-Range"], "bytes */1000");
  assert.equal(calls[0].init.headers["Content-Length"], "0");
  assert.equal(calls[0].init.body, undefined);
});

test("videos.list reads the provider's OWN evidence: processingDetails, applied privacy, real statistics only", async () => {
  const { request, calls } = fakeFetch([
    ["https://www.googleapis.com/youtube/v3/videos", () => jsonResponse(200, {
      items: [{
        id: VIDEO_ID,
        snippet: { title: "Launch teaser", publishedAt: "2026-09-21T11:00:00Z" },
        status: { privacyStatus: "private", rejectionReason: null },
        processingDetails: { uploadStatus: "processed" },
        statistics: { viewCount: "812", likeCount: "44" },
      }],
    })],
  ]);
  const client = new clientMod.YouTubeClient(fakeConfig(), request);
  const video = await client.getVideo("ya29.access", VIDEO_ID);
  assert.equal(video.uploadStatus, "processed");
  assert.equal(video.privacyStatus, "private", "the privacy YouTube ACTUALLY applied");
  assert.deepEqual(video.statistics, { views: 812, likes: 44 }, "commentCount absent = absent, never zero");
  assert.ok(!("comments" in video.statistics));
  assert.ok(calls[0].url.includes("part=snippet%2Cstatus%2CprocessingDetails%2Cstatistics") || calls[0].url.includes("part=snippet,status,processingDetails,statistics"));

  // No item → an honest null, never a zero-filled metric bag.
  const empty = fakeFetch([["https://www.googleapis.com/youtube/v3/videos", () => jsonResponse(200, { items: [] })]]);
  const emptyClient = new clientMod.YouTubeClient(fakeConfig(), empty.request);
  assert.equal(await emptyClient.getVideo("ya29.access", VIDEO_ID), null);

  // An invalid id shape never even reaches the network.
  const { request: noCall, calls: noCalls } = fakeFetch([]);
  const strictClient = new clientMod.YouTubeClient(fakeConfig(), noCall);
  await assert.rejects(() => strictClient.getVideo("ya29.access", "fabricated"), clientMod.YouTubeApiError);
  assert.equal(noCalls.length, 0);
});

test("the recovery scan reads the channel's uploads playlist and drops non-real video ids", async () => {
  const { request, calls } = fakeFetch([
    ["https://www.googleapis.com/youtube/v3/playlistItems", () => jsonResponse(200, {
      items: [
        { contentDetails: { videoId: "bad" }, snippet: { title: "Ignored" } },
        { contentDetails: { videoId: VIDEO_ID }, snippet: { title: "Launch teaser", publishedAt: "2026-09-21T11:00:00Z" } },
      ],
    })],
  ]);
  const client = new clientMod.YouTubeClient(fakeConfig(), request);
  const uploads = await client.listRecentUploads("ya29.access", "UU1234567890abcdef", 15);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].videoId, VIDEO_ID);
  assert.ok(calls[0].url.includes("playlistId=UU1234567890abcdef"));
  assert.ok(calls[0].url.includes("maxResults=15"));
});

// ---------------------------------------------------------------------------
// 5. The publish flow against fake ports — the heart of the truthfulness
// ---------------------------------------------------------------------------

function baseItem(overrides = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    ownerUserId: OWNER_A,
    draftId: DRAFT_A,
    format: "short",
    title: "Launch teaser",
    description: "Our 30-second launch",
    privacyStatus: "private",
    madeForKids: false,
    categoryId: "22",
    attempts: 1,
    sessionUrl: null,
    contentLength: null,
    bytesSent: 0,
    videoId: null,
    lastAttemptAt: null,
    ...overrides,
  };
}

function makePorts(overrides = {}) {
  const events = [];
  const failures = [];
  const published = [];
  const videoIds = [];
  const ports = {
    events, failures, published, videoIds,
    loadDraft: async () => ({ status: "approved" }),
    loadConnection: async () => ({ status: "connected", scopes: [...scopesMod.YOUTUBE_SCOPES] }),
    loadCredentials: async () => ({ channelId: "UC1234567890abcdef", accessToken: "ya29.access", uploadsPlaylistId: "UU1234567890abcdef" }),
    loadAsset: async () => ({ storagePath: "owners/x/video.mp4", mimeType: "video/mp4", status: "uploaded", byteSize: 1000 }),
    openMediaRange: async (path, start, end) => { events.push(`range:${start}-${end}`); return new Uint8Array(end - start + 1); },
    initiateSession: async () => { events.push("initiate"); return SESSION_URL; },
    putChunk: async (input) => {
      events.push(`chunk:${input.contentRange}`);
      return { outcome: "complete", videoId: VIDEO_ID, uploadStatus: "processed", privacyStatus: "private" };
    },
    querySession: async () => ({ outcome: "continue", receivedBytes: 0 }),
    getVideo: async () => ({ videoId: VIDEO_ID, uploadStatus: "processed", privacyStatus: "private", rejectionReason: null, failureReason: null }),
    listRecentUploads: async () => [],
    persistSession: async (item, sessionUrl, contentLength) => { events.push(`session:${sessionUrl}:${contentLength}`); },
    persistProgress: async (item, bytesSent) => { events.push(`progress:${bytesSent}`); return Promise.resolve(); },
    recordVideoId: async (item, videoId, uploadStatus, privacyStatus) => { events.push(`videoId:${videoId}:${uploadStatus}`); videoIds.push({ videoId, uploadStatus, privacyStatus }); },
    markPublished: async (item, privacyStatus, note) => { events.push(`published:${privacyStatus}:${note ?? ""}`); published.push({ videoId: item.videoId, privacyStatus, note }); },
    markFailed: async (item, input) => { events.push(`failed:${input.code}:${input.status}`); failures.push(input); },
    sleep: async () => undefined,
    now: () => NOW,
    ...overrides,
  };
  // persistProgress is awaited with .catch() in the flow — keep it thenable-safe.
  return ports;
}

test("the happy path publishes ONLY with YouTube's own processed evidence, in the right order", async () => {
  const ports = makePorts();
  const result = await flowMod.runYouTubePublishFlow(baseItem(), ports);
  assert.deepEqual(result, { outcome: "published", videoId: VIDEO_ID });

  // Order: session persisted BEFORE the first byte; video id recorded BEFORE published.
  const initiate = ports.events.indexOf("initiate");
  const sessionPersist = ports.events.findIndex((event) => event.startsWith("session:"));
  const firstChunk = ports.events.findIndex((event) => event.startsWith("chunk:"));
  const recorded = ports.events.findIndex((event) => event.startsWith("videoId:"));
  const publishedAt = ports.events.findIndex((event) => event.startsWith("published:"));
  assert.ok(initiate >= 0 && sessionPersist > initiate && firstChunk > sessionPersist, "the session is durable before any byte is sent");
  assert.ok(recorded > firstChunk && publishedAt > recorded, "provider acceptance is recorded before publication is claimed");
  assert.deepEqual(ports.videoIds[0], { videoId: VIDEO_ID, uploadStatus: "processed", privacyStatus: "private" });
  assert.equal(ports.published.length, 1);
  assert.equal(ports.failures.length, 0);
});

test("a completion with uploadStatus 'uploaded' is provider ACCEPTANCE — the flow polls and reports processing, never published", async () => {
  let polls = 0;
  const ports = makePorts({
    putChunk: async (input) => {
      portsEvents(input);
      return { outcome: "complete", videoId: VIDEO_ID, uploadStatus: "uploaded", privacyStatus: "private" };
      function portsEvents() { /* noop */ }
    },
    getVideo: async () => {
      polls += 1;
      return { videoId: VIDEO_ID, uploadStatus: "uploaded", privacyStatus: "private", rejectionReason: null, failureReason: null };
    },
  });
  const result = await flowMod.runYouTubePublishFlow(baseItem(), ports);
  assert.equal(result.outcome, "processing", "submitted + accepted != published");
  assert.equal(result.code, "provider_processing");
  assert.equal(result.videoId, VIDEO_ID);
  assert.equal(ports.published.length, 0, "Voom never claims publication without processed evidence");
  assert.ok(polls >= 1, "the flow reads the provider's own status before reporting");
});

test("processing that later becomes processed publishes on the next evidence read (the reconcile path)", async () => {
  // Right after an upload the invocation's budget is spent, so the flow hands
  // the row to reconciliation as provider_processing. The NEXT run enters the
  // evidence phase with the recorded video id and real budget — and publishes
  // the moment YouTube itself reports 'processed'.
  let calls = 0;
  const ports = makePorts({
    remainingBudgetMs: () => 120_000,
    getVideo: async () => {
      calls += 1;
      return calls < 2
        ? { videoId: VIDEO_ID, uploadStatus: "uploaded", privacyStatus: "private", rejectionReason: null, failureReason: null }
        : { videoId: VIDEO_ID, uploadStatus: "processed", privacyStatus: "private", rejectionReason: null, failureReason: null };
    },
  });
  const result = await flowMod.runYouTubePublishFlow(baseItem({ videoId: VIDEO_ID, lastAttemptAt: nowIso(-60_000) }), ports);
  assert.equal(result.outcome, "published");
  assert.equal(calls, 2, "the evidence loop polls until YouTube's own status flips to processed");
  assert.equal(ports.published[0].videoId, VIDEO_ID);
  assert.ok(!ports.events.includes("initiate"), "the evidence phase never re-uploads");
});

test("YouTube rejection and processing failure are terminal, truthful, and carry Google's own reason", async () => {
  const rejected = makePorts({
    putChunk: async () => ({ outcome: "complete", videoId: VIDEO_ID, uploadStatus: "uploaded", privacyStatus: "private" }),
    getVideo: async () => ({ videoId: VIDEO_ID, uploadStatus: "rejected", privacyStatus: "private", rejectionReason: "termsOfUse", failureReason: null }),
  });
  const rejectedResult = await flowMod.runYouTubePublishFlow(baseItem(), rejected);
  assert.equal(rejectedResult.outcome, "failed");
  assert.equal(rejected.failures[0].code, "provider_rejected");
  assert.equal(rejected.failures[0].status, "failed");
  assert.match(rejected.failures[0].message, /termsOfUse/, "Google's own rejection reason is surfaced");
  assert.equal(rejected.published.length, 0);

  const failedProcessing = makePorts({
    putChunk: async () => ({ outcome: "complete", videoId: VIDEO_ID, uploadStatus: "uploaded", privacyStatus: "private" }),
    getVideo: async () => ({ videoId: VIDEO_ID, uploadStatus: "failed", privacyStatus: "private", rejectionReason: null, failureReason: "uploadFailed" }),
  });
  await flowMod.runYouTubePublishFlow(baseItem(), failedProcessing);
  assert.equal(failedProcessing.failures[0].code, "provider_processing_failed");
});

test("approval is RE-CHECKED server-side at upload time — an un-approved draft never uploads", async () => {
  const ports = makePorts({ loadDraft: async () => ({ status: "draft" }) });
  const result = await flowMod.runYouTubePublishFlow(baseItem(), ports);
  assert.equal(result.outcome, "failed");
  assert.equal(ports.failures[0].code, "not_approved");
  assert.equal(ports.failures[0].status, "failed");
  assert.ok(!ports.events.includes("initiate"), "no Google call happens for an unapproved item");

  const missing = makePorts({ loadDraft: async () => null });
  await flowMod.runYouTubePublishFlow(baseItem(), missing);
  assert.equal(missing.failures[0].code, "draft_unavailable");
  assert.equal(missing.failures[0].status, "scheduled", "an unreadable draft is transient, not a withdrawal");
});

test("connection and scope truths gate the upload", async () => {
  const disconnected = makePorts({ loadConnection: async () => null });
  await flowMod.runYouTubePublishFlow(baseItem(), disconnected);
  assert.equal(disconnected.failures[0].code, "youtube_not_connected");

  const revoked = makePorts({ loadConnection: async () => ({ status: "revoked", scopes: [...scopesMod.YOUTUBE_SCOPES] }) });
  await flowMod.runYouTubePublishFlow(baseItem(), revoked);
  assert.equal(revoked.failures[0].code, "youtube_not_connected");

  const readOnly = makePorts({ loadConnection: async () => ({ status: "connected", scopes: [scopesMod.YOUTUBE_READONLY_SCOPE] }) });
  await flowMod.runYouTubePublishFlow(baseItem(), readOnly);
  assert.equal(readOnly.failures[0].code, "youtube_publish_permission_required");
  assert.equal(readOnly.failures[0].status, "permission_required");
  assert.ok(!readOnly.events.includes("initiate"), "readonly scopes never start an upload");

  const throwing = makePorts({ loadCredentials: async () => { throw new Error("youtube_token_refresh_failed"); } });
  await flowMod.runYouTubePublishFlow(baseItem(), throwing);
  assert.equal(throwing.failures[0].code, "youtube_not_connected");
});

test("policy-sensitive metadata is never guessed: undeclared items park in needs_declaration", async () => {
  for (const overrides of [{ privacyStatus: null }, { madeForKids: null }, { privacyStatus: null, madeForKids: null }, { privacyStatus: "followers" }]) {
    const ports = makePorts();
    const result = await flowMod.runYouTubePublishFlow(baseItem(overrides), ports);
    assert.equal(result.outcome, "failed", JSON.stringify(overrides));
    assert.equal(ports.failures[0].code, "audience_declaration_required", JSON.stringify(overrides));
    assert.equal(ports.failures[0].status, "needs_declaration", JSON.stringify(overrides));
    assert.ok(!ports.events.includes("initiate"), "nothing reaches Google for an undeclared item");
  }
});

test("missing or unsupported media parks truthfully and never uploads bytes that do not exist", async () => {
  const missing = makePorts({ loadAsset: async () => null });
  await flowMod.runYouTubePublishFlow(baseItem(), missing);
  assert.equal(missing.failures[0].code, "media_missing");
  assert.equal(missing.failures[0].status, "waiting_for_media");

  const zero = makePorts({ loadAsset: async () => ({ storagePath: "p", mimeType: "video/mp4", status: "uploaded", byteSize: 0 }) });
  await flowMod.runYouTubePublishFlow(baseItem(), zero);
  assert.equal(zero.failures[0].code, "media_missing");

  const image = makePorts({ loadAsset: async () => ({ storagePath: "p", mimeType: "image/png", status: "uploaded", byteSize: 100 }) });
  await flowMod.runYouTubePublishFlow(baseItem(), image);
  assert.equal(image.failures[0].code, "media_unsupported");
  assert.equal(image.failures[0].status, "failed");
  assert.ok(!image.events.includes("initiate"));
});

test("a persisted matching session is RESUMED from YouTube's own byte count — never re-created (no duplicate video)", async () => {
  const ports = makePorts({
    querySession: async () => ({ outcome: "continue", receivedBytes: 512 }),
    putChunk: async (input) => {
      ports.events.push(`chunk:${input.contentRange}`);
      return { outcome: "complete", videoId: VIDEO_ID, uploadStatus: "processed", privacyStatus: "private" };
    },
  });
  const item = baseItem({ sessionUrl: SESSION_URL, contentLength: 1000, bytesSent: 256 });
  const result = await flowMod.runYouTubePublishFlow(item, ports);
  assert.equal(result.outcome, "published");
  assert.ok(!ports.events.includes("initiate"), "no second session — a second session could create a second video");
  // Resumed from YouTube's count (512), not the stale local bookkeeping (256).
  assert.ok(ports.events.includes("chunk:bytes 512-999/1000"), `resumed from the provider's byte count: ${ports.events.join(",")}`);
});

test("a session that already completed is recovered through the status query — the video id comes from YouTube", async () => {
  const ports = makePorts({
    querySession: async () => ({ outcome: "complete", videoId: VIDEO_ID, uploadStatus: "processed", privacyStatus: "private" }),
  });
  const item = baseItem({ sessionUrl: SESSION_URL, contentLength: 1000, bytesSent: 1000 });
  const result = await flowMod.runYouTubePublishFlow(item, ports);
  assert.equal(result.outcome, "published");
  assert.equal(ports.videoIds[0].videoId, VIDEO_ID);
  assert.ok(!ports.events.some((event) => event.startsWith("chunk:")), "no bytes are re-sent for a completed session");
});

test("a GONE session triggers the READ-ONLY recovery scan before anything else can happen", async () => {
  // Scan finds the video (exact title, recent): recover the real id, publish on evidence.
  const found = makePorts({
    querySession: async () => ({ outcome: "gone" }),
    listRecentUploads: async () => [{ videoId: VIDEO_ID, title: "Launch teaser", publishedAt: nowIso(-60_000) }],
  });
  const foundResult = await flowMod.runYouTubePublishFlow(baseItem({ sessionUrl: SESSION_URL, contentLength: 1000, lastAttemptAt: nowIso(-120_000) }), found);
  assert.equal(foundResult.outcome, "published");
  assert.equal(found.videoIds[0].videoId, VIDEO_ID, "the recovered id is YouTube's own");
  assert.ok(!found.events.includes("initiate"), "no re-upload when the scan proves the video exists");

  // Scan proves NO video was created: only then is a fresh session safe.
  const notFound = makePorts({
    querySession: async () => ({ outcome: "gone" }),
    listRecentUploads: async () => {
      notFound.events.push("scan");
      return [{ videoId: "otherVideo123", title: "Something else", publishedAt: nowIso(-60_000) }];
    },
  });
  const notFoundResult = await flowMod.runYouTubePublishFlow(baseItem({ sessionUrl: SESSION_URL, contentLength: 1000 }), notFound);
  assert.equal(notFoundResult.outcome, "published", "the fresh upload then completes normally");
  const scanIndex = notFound.events.indexOf("scan");
  const initiateIndex = notFound.events.indexOf("initiate");
  assert.ok(scanIndex >= 0 && initiateIndex > scanIndex, "the read-only scan happens BEFORE any fresh session is opened");

  // The scan itself fails → AMBIGUOUS → fail closed, never a blind re-upload.
  const ambiguous = makePorts({
    querySession: async () => ({ outcome: "gone" }),
    listRecentUploads: async () => { throw new Error("network down"); },
  });
  const ambiguousResult = await flowMod.runYouTubePublishFlow(baseItem({ sessionUrl: SESSION_URL, contentLength: 1000 }), ambiguous);
  assert.equal(ambiguousResult.outcome, "failed");
  assert.equal(ambiguous.failures[0].code, "upload_ambiguous");
  assert.equal(ambiguous.failures[0].status, "failed");
  assert.ok(!ambiguous.events.includes("initiate"), "ambiguity NEVER risks a duplicate upload");

  // No uploads playlist known → the scan cannot run → ambiguous as well.
  const noPlaylist = makePorts({
    querySession: async () => ({ outcome: "gone" }),
    loadCredentials: async () => ({ channelId: "UC1", accessToken: "ya29.access", uploadsPlaylistId: null }),
  });
  await flowMod.runYouTubePublishFlow(baseItem({ sessionUrl: SESSION_URL, contentLength: 1000 }), noPlaylist);
  assert.equal(noPlaylist.failures[0].code, "upload_ambiguous");
});

test("the pure recovery matcher requires an EXACT title and a publish time no earlier than the attempt window", () => {
  const uploads = [
    { videoId: "oldVideo1234", title: "Launch teaser", publishedAt: "2026-09-20T12:00:00.000Z" }, // too old
    { videoId: "wrongTitle12", title: "Different", publishedAt: nowIso(-60_000) },
    { videoId: VIDEO_ID, title: "Launch teaser", publishedAt: nowIso(-60_000) },
    { videoId: "newestId123", title: " Launch teaser ", publishedAt: nowIso(-30_000) }, // trimmed exact match, newest
  ];
  assert.equal(flowMod.findRecoveredUpload(uploads, "Launch teaser", nowIso(-120_000)), "newestId123", "multiple matches take the newest");
  assert.equal(flowMod.findRecoveredUpload(uploads, "No such title", nowIso(-120_000)), null, "no match is never a guess");
  assert.equal(flowMod.findRecoveredUpload([uploads[0]], "Launch teaser", nowIso(-120_000)), null, "a video published before the attempt window is not this item's");
  assert.equal(flowMod.findRecoveredUpload(uploads, "", nowIso(-120_000)), null);
  assert.equal(flowMod.findRecoveredUpload([{ videoId: "bad", title: "Launch teaser", publishedAt: nowIso(-1000) }], "Launch teaser", nowIso(-120_000)), null, "a non-real id is never recovered");
});

test("quota exhaustion parks the item at the Pacific reset WITHOUT burning its attempts", async () => {
  const quotaError = new clientMod.YouTubeApiError("quota", "upload_session", "quotaExceeded", 403);
  const ports = makePorts({ initiateSession: async () => { throw quotaError; } });
  const result = await flowMod.runYouTubePublishFlow(baseItem({ attempts: 3 }), ports);
  assert.equal(result.outcome, "retrying");
  assert.equal(result.code, "quota_exceeded");
  const failure = ports.failures[0];
  assert.equal(failure.code, "quota_exceeded");
  assert.equal(failure.status, "scheduled", "a quota day is a hold, not a failure");
  assert.equal(failure.resetAttempts, true, "the provider's daily budget never consumes the item's retry allowance");
  assert.equal(failure.retryAt, pub.nextQuotaResetAt(NOW), "the retry waits for the documented midnight-Pacific reset");
});

test("an auth failure during upload marks the truthful permission_required state", async () => {
  const authError = new clientMod.YouTubeApiError("auth", "upload_chunk", "invalid_grant", 400);
  const ports = makePorts({ putChunk: async () => { throw authError; } });
  const result = await flowMod.runYouTubePublishFlow(baseItem(), ports);
  assert.equal(result.outcome, "failed");
  assert.equal(ports.failures[0].code, "authorization_revoked");
  assert.equal(ports.failures[0].status, "permission_required");
});

test("running out of wall clock parks on the next cron boundary with the session intact", async () => {
  let budget = 10_000; // enough for the first allowance check, then gone
  // byteSize huge so the first chunk is not final; the chunk accepts nothing,
  // which forces the park path once the budget is gone.
  const bigAsset = makePorts({
    loadAsset: async () => ({ storagePath: "p", mimeType: "video/mp4", status: "uploaded", byteSize: 40 * 1024 * 1024 }),
    putChunk: async () => ({ outcome: "continue", receivedBytes: 0 }),
    remainingBudgetMs: () => {
      const value = budget;
      budget = 0;
      return value;
    },
  });
  const result = await flowMod.runYouTubePublishFlow(baseItem(), bigAsset);
  assert.equal(result.outcome, "retrying");
  assert.equal(result.code, "upload_interrupted");
  assert.equal(bigAsset.failures[0].status, "scheduled");
  assert.ok(bigAsset.events.some((event) => event.startsWith("session:")), "the session stays persisted for the next run to resume");
});

test("an item that already carries a provider video id skips straight to the evidence phase", async () => {
  const ports = makePorts({
    getVideo: async () => ({ videoId: VIDEO_ID, uploadStatus: "processed", privacyStatus: "unlisted", rejectionReason: null, failureReason: null }),
  });
  const result = await flowMod.runYouTubePublishFlow(baseItem({ videoId: VIDEO_ID }), ports);
  assert.equal(result.outcome, "published");
  assert.ok(!ports.events.includes("initiate"), "no upload phase for an accepted video");
  assert.equal(ports.published[0].privacyStatus, "unlisted", "the privacy YouTube ACTUALLY applied is stored");
});

test("an unaudited project's forced-private upload is reported truthfully, never as the requested public", async () => {
  const ports = makePorts({
    putChunk: async () => ({ outcome: "complete", videoId: VIDEO_ID, uploadStatus: "processed", privacyStatus: "private" }),
    projectAudited: false,
  });
  const result = await flowMod.runYouTubePublishFlow(baseItem({ privacyStatus: "public" }), ports);
  assert.equal(result.outcome, "published");
  assert.equal(ports.published[0].privacyStatus, "private", "the provider's applied privacy wins");
  assert.match(ports.published[0].note, /Compliance Audit/i, "the note explains Google's unaudited-project restriction");

  const audited = makePorts({
    putChunk: async () => ({ outcome: "complete", videoId: VIDEO_ID, uploadStatus: "processed", privacyStatus: "private" }),
    projectAudited: true,
  });
  await flowMod.runYouTubePublishFlow(baseItem({ privacyStatus: "public" }), audited);
  assert.match(audited.published[0].note, /applied 'private' privacy instead of the requested 'public'/);

  const matched = makePorts({
    putChunk: async () => ({ outcome: "complete", videoId: VIDEO_ID, uploadStatus: "processed", privacyStatus: "private" }),
  });
  await flowMod.runYouTubePublishFlow(baseItem({ privacyStatus: "private" }), matched);
  assert.equal(matched.published[0].note, null, "no note when YouTube applied exactly what was requested");
});

test("a fabricated 'complete' with a non-real video id fails closed instead of storing it", async () => {
  const ports = makePorts({
    putChunk: async () => ({ outcome: "complete", videoId: "fabricated-id", uploadStatus: "processed", privacyStatus: "private" }),
  });
  const result = await flowMod.runYouTubePublishFlow(baseItem(), ports);
  assert.equal(result.outcome, "failed");
  assert.equal(ports.failures[0].code, "upload_ambiguous");
  assert.equal(ports.videoIds.length, 0, "no fabricated id is ever recorded");
  assert.equal(ports.published.length, 0);
});

// ---------------------------------------------------------------------------
// 6. Migration 0047 + the queue RPCs on a REAL embedded PostgreSQL
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

async function makeDraft(ownerId, { kind = "youtube_short", format = "short", status = "approved", title = "Launch teaser" } = {}) {
  const { db } = await liteDb();
  const conv = (await db.query(
    "insert into public.mara_conversations (owner_user_id, title) values ($1, 'Studio') returning id",
    [ownerId],
  )).rows[0];
  const draft = (await db.query(
    `insert into public.mara_drafts
       (conversation_id, owner_user_id, kind, channel, title, content, social_channel, social_format, content_meta, status)
     values ($1, $2, $3, $4, $5, 'Caption', 'youtube', $6, '{}'::jsonb, $7) returning id`,
    [conv.id, ownerId, kind, kind === "youtube_short" ? "YouTube · Short" : "YouTube · 16:9", title, format, status],
  )).rows[0];
  return draft.id;
}

async function makeAsset(ownerId, draftId, { mime = "video/mp4", byteSize = 1024 } = {}) {
  const { db } = await liteDb();
  await db.query(
    `insert into public.post_draft_assets (owner_user_id, draft_id, storage_path, display_name, mime_type, byte_size)
     values ($1, $2, $3, 'video.mp4', $4, $5)`,
    [ownerId, draftId, `yt/${ownerId}/${draftId}-video.mp4`, mime, byteSize],
  );
}

let videoSeq = 0;
/** The queue holds a partial UNIQUE index on youtube_video_id: one real video
 *  belongs to exactly one row, so each DB test needs its own real-shaped id. */
function newVideoId() {
  videoSeq += 1;
  return `vid${String(videoSeq).padStart(8, "0")}`;
}

/** Removes rows previous tests left in claimable states (published and
 *  provider-owned rows are guard-protected and stay). */
async function clearClaimable() {
  const { db } = await liteDb();
  await db.query(
    `delete from public.youtube_publish_queue
     where status in ('scheduled', 'waiting_for_media', 'needs_declaration', 'permission_required', 'failed', 'cancelled')`,
  );
}

function enqueueInput(draftId, overrides = {}) {
  return {
    ownerId: OWNER_A,
    draftId,
    calendarItemId: null,
    youtubeFormat: "short",
    title: "Launch teaser",
    description: "Our 30-second launch",
    privacyStatus: "private",
    madeForKids: false,
    categoryId: "22",
    scheduledAt: nowIso(-60_000),
    ...overrides,
  };
}

async function saveConnection(ownerId, overrides = {}) {
  const { admin } = await liteDb();
  await dataMod.saveYouTubeConnection(admin, {
    ownerId,
    channelId: `UC-${ownerId.slice(0, 8)}`,
    channelTitle: "Voom Studio",
    channelHandle: "@voomstudio",
    thumbnailUrl: "https://yt.test/thumb.jpg",
    grantedScopes: [...scopesMod.YOUTUBE_SCOPES],
    refreshToken: `refresh-${ownerId.slice(0, 8)}`,
    accessToken: `access-${ownerId.slice(0, 8)}`,
    accessTokenExpiresAt: new Date(Date.now() + 3599_000).toISOString(),
    encryptionKey: KEY,
    ...overrides,
  });
}

test("migration 0047 applies cleanly and is the checked-in head", async () => {
  const { applied } = await liteDb();
  assert.ok(applied.includes("0047_youtube_provider.sql"), "0047 applied through PGlite");
  assert.equal(applied[applied.length - 1], "0047_youtube_provider.sql");
  const tables = await all(
    "select table_name from information_schema.tables where table_schema = 'public' and table_name like 'youtube_%' order by table_name",
  );
  assert.deepEqual(tables.map((row) => row.table_name), [
    "youtube_connection_secrets", "youtube_connections", "youtube_oauth_states", "youtube_performance_snapshots", "youtube_publish_queue",
  ]);
  for (const table of tables.map((row) => row.table_name)) {
    const rls = await one("select relrowsecurity from pg_class where oid = $1::regclass", [`public.${table}`]);
    assert.equal(rls.relrowsecurity, true, `${table} has RLS enabled`);
  }
});

test("enqueue is idempotent per (owner, draft) and reschedules honestly", async () => {
  const { admin } = await liteDb();
  const draftId = await makeDraft(OWNER_A);
  const first = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(draftId));
  assert.equal(first.status, "scheduled");
  assert.equal(first.idempotency_key, pub.youTubePublishIdempotencyKey(draftId));
  assert.equal(first.privacy_status, "private");
  assert.equal(first.made_for_kids, false);

  const second = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(draftId, { scheduledAt: nowIso(3600_000), title: "Renamed" }));
  assert.equal(second.id, first.id, "ONE row per (owner, draft) forever");
  assert.equal(second.title, "Renamed");
  assert.equal(second.status, "scheduled");
  const count = await one("select count(*)::int as n from public.youtube_publish_queue where draft_id = $1", [draftId]);
  assert.equal(count.n, 1);
});

test("undeclared policy metadata parks in needs_declaration; waiting media parks in waiting_for_media", async () => {
  const { admin } = await liteDb();
  const undeclared = await makeDraft(OWNER_A);
  const row = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(undeclared, { privacyStatus: null, madeForKids: null }));
  assert.equal(row.status, "needs_declaration", "the database itself refuses to guess");
  assert.equal(row.privacy_status, null);

  const partial = await makeDraft(OWNER_A);
  const partialRow = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(partial, { madeForKids: null }));
  assert.equal(partialRow.status, "needs_declaration");

  const waiting = await makeDraft(OWNER_A);
  const waitingRow = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(waiting, { waitingForMedia: true }));
  assert.equal(waitingRow.status, "waiting_for_media");

  // Declaring later promotes the parked row (it is not provider-owned yet).
  const declared = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(undeclared, { privacyStatus: "unlisted", madeForKids: false }));
  assert.equal(declared.id, row.id);
  assert.equal(declared.status, "scheduled");
  assert.equal(declared.privacy_status, "unlisted");
});

test("the database refuses invalid metadata at the RPC and constraint level", async () => {
  const { admin } = await liteDb();
  const draftId = await makeDraft(OWNER_A);
  await assert.rejects(
    () => queueMod.enqueueYouTubePublishItem(admin, enqueueInput(draftId, { youtubeFormat: "reel" })),
    /youtube_publish_enqueue_failed/,
    "an invented format is refused",
  );
  await assert.rejects(
    () => queueMod.enqueueYouTubePublishItem(admin, enqueueInput(draftId, { title: "x".repeat(101) })),
    /youtube_publish_enqueue_failed/,
    "a 101-character title is refused",
  );
  await assert.rejects(
    () => queueMod.enqueueYouTubePublishItem(admin, enqueueInput(draftId, { privacyStatus: "followers" })),
    /youtube_publish_enqueue_failed/,
    "an invented privacy value is refused",
  );
  await assert.rejects(
    one(`insert into public.youtube_publish_queue
         (owner_user_id, draft_id, youtube_format, title, scheduled_at, idempotency_key, category_id)
         values ($1, $2, 'short', 'T', now(), 'ytpub_deadbeefdeadbeef', 'not-a-number')`, [OWNER_A, draftId]),
    /category_id/,
    "the category must be YouTube's numeric string",
  );
});

test("claims are atomic and selective: due rows only, needs_declaration/permission_required never", async () => {
  const { admin } = await liteDb();
  await clearClaimable();
  const due = await makeDraft(OWNER_A);
  const future = await makeDraft(OWNER_A);
  const parked = await makeDraft(OWNER_A);
  await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(due, { scheduledAt: nowIso(-60_000) }));
  await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(future, { scheduledAt: nowIso(3600_000) }));
  await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(parked, { privacyStatus: null }));

  const claimed = await queueMod.claimDueYouTubeUploads(admin, 10, new Date(NOW));
  assert.equal(claimed.length, 1, "only the due, declared, scheduled row is claimed");
  assert.equal(claimed[0].draft_id, due);
  assert.equal(claimed[0].status, "uploading");
  assert.equal(claimed[0].attempts, 1, "the upload phase consumes an attempt");
  assert.ok(claimed[0].claimed_at, "the claim is stamped for stale detection");

  const again = await queueMod.claimDueYouTubeUploads(admin, 10, new Date(NOW));
  assert.equal(again.length, 0, "a claimed row is never claimed twice (duplicate-upload guarantee)");

  // An in-flight row is never re-claimed by the upload worker, and the
  // future row is not due yet at this instant either.
  const later = await queueMod.claimDueYouTubeUploads(admin, 10, new Date(NOW + 1800_000));
  assert.equal(later.length, 0, "an in-flight 'uploading' row is not re-claimed by the upload worker");
});

test("session, progress and video-id bookkeeping keep provider evidence sacrosanct", async () => {
  const { admin } = await liteDb();
  const draftId = await makeDraft(OWNER_A);
  const row = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(draftId));
  await queueMod.claimDueYouTubeUploads(admin, 10, new Date(NOW));

  await queueMod.recordYouTubeUploadSession(admin, row.id, OWNER_A, SESSION_URL, 1024);
  await queueMod.recordYouTubeUploadProgress(admin, row.id, OWNER_A, 512);
  let stored = await one("select upload_session_url, upload_content_length, upload_bytes_sent from public.youtube_publish_queue where id = $1", [row.id]);
  assert.equal(stored.upload_session_url, SESSION_URL);
  assert.equal(Number(stored.upload_content_length), 1024);
  assert.equal(Number(stored.upload_bytes_sent), 512);

  // The same video id may be re-recorded; a DIFFERENT one is a duplicate-upload symptom.
  const videoId = newVideoId();
  await queueMod.recordYouTubeVideoId(admin, row.id, OWNER_A, videoId, "uploaded", "private");
  await queueMod.recordYouTubeVideoId(admin, row.id, OWNER_A, videoId, "uploaded", "private");
  await assert.rejects(
    () => queueMod.recordYouTubeVideoId(admin, row.id, OWNER_A, newVideoId(), "uploaded", "private"),
    /youtube_video_id_record_failed/,
  );
  const conflictId = newVideoId();
  const dbError = await one("select public.record_youtube_video_id($1::uuid, $2::uuid, $3::text, $4::text, $5::text)", [row.id, OWNER_A, conflictId, "uploaded", "private"]).catch((error) => ({ error }));
  assert.match(String(dbError.error?.message ?? ""), /youtube_video_id_conflict/, "the database itself names the conflict");

  stored = await one("select status, youtube_video_id, provider_upload_status, provider_privacy_status from public.youtube_publish_queue where id = $1", [row.id]);
  assert.equal(stored.status, "provider_processing", "a recorded video id is provider ACCEPTANCE, not publication");
  assert.equal(stored.youtube_video_id, videoId);
  assert.equal(stored.provider_upload_status, "uploaded");
});

test("publication requires YouTube's own 'processed' evidence, stamps provider_ref, and is irreversible", async () => {
  const { admin } = await liteDb();
  const draftId = await makeDraft(OWNER_A);
  const row = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(draftId));
  await queueMod.claimDueYouTubeUploads(admin, 10, new Date(NOW));

  // No video id yet: completion is structurally impossible.
  await assert.rejects(
    () => queueMod.completeYouTubePublishJob(admin, row.id, OWNER_A, { privacyStatus: "private" }),
    /youtube_publish_complete_failed/,
  );

  const videoId = newVideoId();
  await queueMod.recordYouTubeVideoId(admin, row.id, OWNER_A, videoId, "uploaded", "private");
  // A video id alone is still only acceptance — 'uploaded' cannot complete.
  const notProcessed = await one(
    "select public.complete_youtube_publish_job($1::uuid, $2::uuid, $3::text, $4::text, $5::text)",
    [row.id, OWNER_A, "uploaded", "private", null],
  ).catch((error) => ({ error }));
  assert.match(String(notProcessed.error?.message ?? ""), /youtube_publish_not_processed/);

  await queueMod.completeYouTubePublishJob(admin, row.id, OWNER_A, { privacyStatus: "private", providerNote: "YouTube locked this upload to private: the API project has not passed the YouTube API Services Compliance Audit." });
  const published = await one("select * from public.youtube_publish_queue where id = $1", [row.id]);
  assert.equal(published.status, "published");
  assert.equal(published.provider_upload_status, "processed");
  assert.ok(published.published_at, "the publication instant is stamped");
  assert.match(published.provider_note, /Compliance Audit/, "the unaudited-project truth is stored, not hidden");

  const draft = await one("select provider_ref from public.mara_drafts where id = $1", [draftId]);
  assert.equal(draft.provider_ref, videoId, "the draft carries YouTube's OWN reference");

  // Re-running completion is a safe no-op.
  await queueMod.completeYouTubePublishJob(admin, row.id, OWNER_A, { privacyStatus: "private" });

  // The terminal guard forbids rewriting the proven fact — status, video id
  // and published_at are untouchable on a published row.
  for (const update of [
    "update public.youtube_publish_queue set status = 'failed' where id = $1",
    "update public.youtube_publish_queue set youtube_video_id = 'tamperedVid1' where id = $1",
    "update public.youtube_publish_queue set published_at = null where id = $1",
    "delete from public.youtube_publish_queue where id = $1",
  ]) {
    await assert.rejects(one(update, [row.id]), /youtube_publish_already_published/, `published evidence is immutable: ${update}`);
  }

  // Provider BOOKKEEPING (what YouTube says now) stays legal.
  await queueMod.recordYouTubeProviderStatus(admin, row.id, OWNER_A, { uploadStatus: "deleted", note: "Removed on YouTube.", checkedAt: nowIso() });
  const after = await one("select status, provider_upload_status, published_at from public.youtube_publish_queue where id = $1", [row.id]);
  assert.equal(after.status, "published", "the publication fact survives later provider changes");
  assert.equal(after.provider_upload_status, "deleted");
  assert.ok(after.published_at);
});

test("check constraints encode the provider truths at the schema level", async () => {
  const draftId = await makeDraft(OWNER_A);
  // 'published' without a video id / processed status / published_at is impossible.
  await assert.rejects(
    one(`insert into public.youtube_publish_queue
         (owner_user_id, draft_id, youtube_format, title, scheduled_at, idempotency_key, status)
         values ($1, $2, 'short', 'T', now(), 'ytpub_aaaaaaaaaaaaaaaa', 'published')`, [OWNER_A, draftId]),
    /youtube_publish_queue_published_is_real/,
  );
  // published_at on a non-published row is impossible.
  await assert.rejects(
    one(`insert into public.youtube_publish_queue
         (owner_user_id, draft_id, youtube_format, title, scheduled_at, idempotency_key, published_at)
         values ($1, $2, 'short', 'T', now(), 'ytpub_bbbbbbbbbbbbbbbb', now())`, [OWNER_A, draftId]),
    /youtube_publish_queue_published_at_requires_published/,
  );
  // A video id without a provider upload status is impossible.
  await assert.rejects(
    one(`insert into public.youtube_publish_queue
         (owner_user_id, draft_id, youtube_format, title, scheduled_at, idempotency_key, youtube_video_id)
         values ($1, $2, 'short', 'T', now(), 'ytpub_cccccccccccccccc', $3)`, [OWNER_A, draftId, newVideoId()]),
    /youtube_publish_queue_video_id_has_status/,
  );
  // Attempts are bounded.
  await assert.rejects(
    one(`insert into public.youtube_publish_queue
         (owner_user_id, draft_id, youtube_format, title, scheduled_at, idempotency_key, attempts)
         values ($1, $2, 'short', 'T', now(), 'ytpub_dddddddddddddddd', 26)`, [OWNER_A, draftId]),
    /attempts/,
  );
});

test("failures, retries and cancellation keep the state machine honest", async () => {
  const { admin } = await liteDb();
  const draftId = await makeDraft(OWNER_A);
  const row = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(draftId));
  await queueMod.claimDueYouTubeUploads(admin, 10, new Date(NOW));

  // A retryable interruption returns to scheduled with a retry instant.
  await queueMod.failYouTubePublishJob(admin, row.id, OWNER_A, {
    code: "upload_interrupted", message: "The upload was interrupted.", status: "scheduled", retryAt: nowIso(300_000),
  });
  let stored = await one("select * from public.youtube_publish_queue where id = $1", [row.id]);
  assert.equal(stored.status, "scheduled");
  assert.equal(stored.failure_code, "upload_interrupted");
  assert.equal(stored.claimed_at, null);
  assert.equal(stored.attempts, 1, "an ordinary failure keeps its attempt count");

  // Quota exhaustion resets attempts — the provider's day is not the item's fault.
  await queueMod.failYouTubePublishJob(admin, row.id, OWNER_A, {
    code: "quota_exceeded", message: "Quota exhausted.", status: "scheduled", retryAt: pub.nextQuotaResetAt(NOW), resetAttempts: true,
  });
  stored = await one("select attempts, failure_code from public.youtube_publish_queue where id = $1", [row.id]);
  assert.equal(stored.attempts, 0);
  assert.equal(stored.failure_code, "quota_exceeded");

  // An invalid failure status is refused.
  await assert.rejects(
    () => queueMod.failYouTubePublishJob(admin, row.id, OWNER_A, { code: "x", message: "y", status: "published" }),
    /youtube_publish_fail_record_failed/,
    "no failure path can write 'published'",
  );

  // Cancellation withdraws a queued item and never touches provider-owned rows.
  assert.equal(await queueMod.cancelYouTubePublishItem(admin, OWNER_A, draftId), true);
  stored = await one("select status, claimed_at from public.youtube_publish_queue where id = $1", [row.id]);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.claimed_at, null);

  const publishedDraft = await makeDraft(OWNER_A);
  const publishedRow = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(publishedDraft));
  await queueMod.recordYouTubeVideoId(admin, publishedRow.id, OWNER_A, newVideoId(), "uploaded", "private");
  assert.equal(await queueMod.cancelYouTubePublishItem(admin, OWNER_A, publishedDraft), false, "a provider-owned row cannot be cancelled");
  const untouched = await one("select status from public.youtube_publish_queue where id = $1", [publishedRow.id]);
  assert.equal(untouched.status, "provider_processing");
});

test("disconnect withdraws only what never reached YouTube and destroys only credentials — never videos, never history", async () => {
  const { admin } = await liteDb();
  const ownerId = OWNER_B;
  await saveConnection(ownerId);

  const queued = await makeDraft(ownerId);
  const parked = await makeDraft(ownerId);
  const published = await makeDraft(ownerId);
  await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(queued, { ownerId }));
  await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(parked, { ownerId, privacyStatus: null }));
  const publishedRow = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(published, { ownerId }));
  const videoId = newVideoId();
  await queueMod.recordYouTubeVideoId(admin, publishedRow.id, ownerId, videoId, "uploaded", "private");
  await queueMod.completeYouTubePublishJob(admin, publishedRow.id, ownerId, { privacyStatus: "private" });

  const revokedCalls = [];
  const fakeClient = { revokeToken: async (token) => { revokedCalls.push(token); return true; } };
  const outcome = await dataMod.disconnectYouTube(admin, ownerId, KEY, fakeClient);
  assert.equal(outcome.disconnected, true);
  assert.equal(outcome.revokedAtGoogle, true);
  assert.deepEqual(revokedCalls, [`refresh-${ownerId.slice(0, 8)}`], "the stored refresh token is explicitly revoked at Google");

  const connection = await one("select status, disconnected_at, access_token_expires_at from public.youtube_connections where owner_user_id = $1", [ownerId]);
  assert.equal(connection.status, "disconnected");
  assert.ok(connection.disconnected_at);
  assert.equal(connection.access_token_expires_at, null);

  const secrets = await one("select count(*)::int as n from public.youtube_connection_secrets where owner_user_id = $1", [ownerId]);
  assert.equal(secrets.n, 0, "credentials are destroyed locally");

  const queuedRow = await one("select status, failure_code from public.youtube_publish_queue where draft_id = $1", [queued]);
  assert.equal(queuedRow.status, "cancelled");
  assert.equal(queuedRow.failure_code, "connection_disconnected");
  const parkedRow = await one("select status from public.youtube_publish_queue where draft_id = $1", [parked]);
  assert.equal(parkedRow.status, "cancelled");

  // The published fact — and the customer's YouTube video — are untouched.
  const publishedAfter = await one("select status, youtube_video_id, published_at from public.youtube_publish_queue where id = $1", [publishedRow.id]);
  assert.equal(publishedAfter.status, "published");
  assert.equal(publishedAfter.youtube_video_id, videoId);
  assert.ok(publishedAfter.published_at);
  const history = await one("select provider_ref from public.mara_drafts where id = $1", [published]);
  assert.equal(history.provider_ref, videoId, "Voom history keeps the provider reference");

  // The sanitized view reports the truthful disconnected state.
  const view = await dataMod.getYouTubeConnection(admin, ownerId, true, false);
  assert.equal(view.connected, false);
  assert.equal(view.status, "disconnected");
});

test("revoked authorization parks future work truthfully and leaves provider-owned rows alone", async () => {
  const { admin } = await liteDb();
  const ownerId = OWNER_A;
  const scheduledDraft = await makeDraft(ownerId);
  const processingDraft = await makeDraft(ownerId);
  await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(scheduledDraft));
  const processingRow = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(processingDraft));
  await queueMod.recordYouTubeVideoId(admin, processingRow.id, ownerId, newVideoId(), "uploaded", "private");

  await one("select public.set_youtube_connection_status($1::uuid, $2::text)", [ownerId, "revoked"]);

  const scheduledRow = await one("select status, failure_code from public.youtube_publish_queue where draft_id = $1", [scheduledDraft]);
  assert.equal(scheduledRow.status, "permission_required");
  assert.equal(scheduledRow.failure_code, "authorization_revoked");
  const processingAfter = await one("select status from public.youtube_publish_queue where id = $1", [processingRow.id]);
  assert.equal(processingAfter.status, "provider_processing", "a row YouTube already owns is left for reconciliation, not cancelled");

  // An invented status is refused.
  await assert.rejects(
    one("select public.set_youtube_connection_status($1::uuid, $2::text)", [ownerId, "half-connected"]),
    /youtube_connection_status_invalid/,
  );

  // Reset for later tests.
  await one("select public.set_youtube_connection_status($1::uuid, $2::text)", [ownerId, "connected"]);
});

test("reconcile claims poll provider_processing WITHOUT burning attempts and resume only stale uploads", async () => {
  const { admin } = await liteDb();
  const processingDraft = await makeDraft(OWNER_A);
  const processingRow = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(processingDraft));
  await queueMod.recordYouTubeVideoId(admin, processingRow.id, OWNER_A, newVideoId(), "uploaded", "private");

  const staleDraft = await makeDraft(OWNER_A);
  const staleRow = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(staleDraft));
  await queueMod.claimDueYouTubeUploads(admin, 10, new Date(NOW)); // -> uploading, attempts 1
  const freshClaim = await one("select id from public.youtube_publish_queue where draft_id = $1", [staleDraft]);

  const freshDraft = await makeDraft(OWNER_A);
  const freshRow = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(freshDraft));
  const claimNow = NOW + 20 * 60_000; // 20 min after the stale claim (> 15 min stale window)
  await one("update public.youtube_publish_queue set status = 'uploading', claimed_at = $2, attempts = 1 where id = $1", [freshRow.id, nowIso(19 * 60_000)]); // claimed 1 min ago: NOT stale

  const claimed = await queueMod.claimYouTubeReconcileJobs(admin, 10, new Date(claimNow));
  const byId = new Map(claimed.map((row) => [row.id, row]));
  assert.ok(byId.has(processingRow.id), "the processing row is claimed for polling");
  assert.equal(byId.get(processingRow.id).attempts, 0, "waiting for YouTube consumes no attempt");
  assert.ok(byId.has(staleRow.id) || byId.has(freshClaim.id), "the STALE uploading row is claimed for resumption");
  const stale = byId.get(staleRow.id) ?? byId.get(freshClaim.id);
  assert.equal(stale.attempts, 2, "resuming a dead worker's upload consumes an attempt");
  assert.ok(!byId.has(freshRow.id), "an uploading row inside the stale window is left to its worker");
});

test("published verification lists only aged evidence, read-only", async () => {
  const { admin } = await liteDb();
  const draftId = await makeDraft(OWNER_A);
  const row = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(draftId));
  await queueMod.recordYouTubeVideoId(admin, row.id, OWNER_A, newVideoId(), "uploaded", "private");
  await queueMod.completeYouTubePublishJob(admin, row.id, OWNER_A, { privacyStatus: "private" });

  let due = await queueMod.listPublishedForVerification(admin, 25, new Date(Date.now() + 3600_000));
  assert.equal(due.filter((item) => item.id === row.id).length, 0, "a just-published row is not re-checked immediately");

  await one("update public.youtube_publish_queue set last_provider_check_at = now() - interval '25 hours' where id = $1", [row.id]);
  due = await queueMod.listPublishedForVerification(admin, 25, new Date());
  assert.ok(due.some((item) => item.id === row.id), "aged evidence is due for a read-only re-check");
});

// ---------------------------------------------------------------------------
// 6b. OAuth state + server credentials against the real database
// ---------------------------------------------------------------------------

test("OAuth state is a single-use, owner-bound, expiring CSPRNG value stored only as a hash", async () => {
  const { admin, db } = await liteDb();
  const state = await dataMod.createYouTubeOAuthState(admin, OWNER_A);
  assert.ok(state.length >= 32, "the state is high-entropy");

  const rows = await all("select state_hash, owner_user_id, expires_at, consumed_at from public.youtube_oauth_states");
  const row = rows[rows.length - 1];
  assert.ok(!rows.some((candidate) => Object.values(candidate).includes(state)), "the plaintext state is never stored");
  assert.equal(row.owner_user_id, OWNER_A);
  assert.equal(row.consumed_at, null);

  // Double-submit: a mismatching cookie never consumes the state.
  assert.equal(await dataMod.consumeYouTubeOAuthState(admin, OWNER_A, state, "wrong-cookie-value".padEnd(state.length, "x")), false);
  // Another owner presenting the same state fails.
  assert.equal(await dataMod.consumeYouTubeOAuthState(admin, OWNER_B, state, state), false);
  // The rightful consumption succeeds exactly once.
  assert.equal(await dataMod.consumeYouTubeOAuthState(admin, OWNER_A, state, state), true);
  assert.equal(await dataMod.consumeYouTubeOAuthState(admin, OWNER_A, state, state), false, "a replayed callback URL finds a consumed row");

  // An expired state is refused even with matching cookies.
  const expired = await dataMod.createYouTubeOAuthState(admin, OWNER_A);
  await db.query(
    "update public.youtube_oauth_states set expires_at = now() - interval '1 minute' where owner_user_id = $1 and consumed_at is null",
    [OWNER_A],
  );
  assert.equal(await dataMod.consumeYouTubeOAuthState(admin, OWNER_A, expired, expired), false);
});

test("server credentials: stored ciphertext only, on-demand refresh, invalid_grant marks the truthful revoked state", async () => {
  const { admin, db } = await liteDb();
  await saveConnection(OWNER_A);

  // The sanitized view never carries token material.
  const view = await dataMod.getYouTubeConnection(admin, OWNER_A, true, false);
  assert.equal(view.connected, true);
  assert.deepEqual(view.scopes, [...scopesMod.YOUTUBE_SCOPES]);
  const viewJson = JSON.stringify(view);
  assert.ok(!viewJson.includes(`access-${OWNER_A.slice(0, 8)}`), "no plaintext access token in the view");
  assert.ok(!viewJson.includes(`refresh-${OWNER_A.slice(0, 8)}`), "no plaintext refresh token in the view");

  // The secret RPC returns ciphertext that decrypts to the real tokens.
  const secret = await one("select * from public.get_youtube_connection_secret($1::uuid)", [OWNER_A]);
  assert.ok(!secret.encrypted_refresh_token.includes(`refresh-${OWNER_A.slice(0, 8)}`), "the database stores ciphertext only");
  assert.equal(ytCrypto.decryptYouTubeToken({
    encryptedToken: secret.encrypted_refresh_token, iv: secret.refresh_iv, authTag: secret.refresh_auth_tag,
  }, KEY), `refresh-${OWNER_A.slice(0, 8)}`);

  // An unexpired access token is used as stored — no refresh call happens.
  const refreshCalls = [];
  const quietClient = { refreshAccessToken: async (token) => { refreshCalls.push(token); return { accessToken: "ya29.new", refreshToken: token, expiresIn: 3599, grantedScopes: [] }; } };
  const credentials = await dataMod.getYouTubeServerCredentials(admin, OWNER_A, KEY, quietClient);
  assert.equal(credentials.accessToken, `access-${OWNER_A.slice(0, 8)}`);
  assert.equal(credentials.channelId, `UC-${OWNER_A.slice(0, 8)}`);
  assert.equal(refreshCalls.length, 0, "a valid token is never refreshed needlessly");

  // An expired access token triggers exactly one server-side refresh, and the
  // new ciphertext goes straight back into the vault.
  await db.query("update public.youtube_connections set access_token_expires_at = now() - interval '5 minutes' where owner_user_id = $1", [OWNER_A]);
  const refreshed = await dataMod.getYouTubeServerCredentials(admin, OWNER_A, KEY, quietClient);
  assert.deepEqual(refreshCalls, [`refresh-${OWNER_A.slice(0, 8)}`], "the refresh spends the stored refresh token server-side only");
  assert.equal(refreshed.accessToken, "ya29.new");
  const vault = await one("select encrypted_access_token from public.youtube_connection_secrets where owner_user_id = $1", [OWNER_A]);
  assert.ok(!vault.encrypted_access_token.includes("ya29.new"), "the refreshed token is stored encrypted");
  assert.equal(ytCrypto.decryptYouTubeToken({
    encryptedToken: vault.encrypted_access_token,
    iv: (await one("select access_iv as iv from public.youtube_connection_secrets where owner_user_id = $1", [OWNER_A])).iv,
    authTag: (await one("select access_auth_tag as tag from public.youtube_connection_secrets where owner_user_id = $1", [OWNER_A])).tag,
  }, KEY), "ya29.new");

  // Google rejecting the refresh with invalid_grant marks the connection revoked.
  const revokedClient = {
    refreshAccessToken: async () => { throw new clientMod.YouTubeApiError("auth", "token_refresh", "invalid_grant", 400); },
  };
  await db.query("update public.youtube_connections set access_token_expires_at = now() - interval '5 minutes' where owner_user_id = $1", [OWNER_A]);
  await assert.rejects(
    () => dataMod.getYouTubeServerCredentials(admin, OWNER_A, KEY, revokedClient),
    /youtube_token_refresh_failed/,
  );
  const revoked = await one("select status from public.youtube_connections where owner_user_id = $1", [OWNER_A]);
  assert.equal(revoked.status, "revoked", "the truthful state replaces a dead authorization");
  const revokedView = await dataMod.getYouTubeConnection(admin, OWNER_A, true, false);
  assert.equal(revokedView.connected, false);
  assert.equal(dataMod.canPublishWith(revokedView), false);

  // Restore for the worker sections below.
  await one("select public.set_youtube_connection_status($1::uuid, 'connected')", [OWNER_A]);
  await db.query("update public.youtube_connections set access_token_expires_at = now() + interval '59 minutes' where owner_user_id = $1", [OWNER_A]);
  assert.equal(dataMod.canPublishWith(await dataMod.getYouTubeConnection(admin, OWNER_A, true, false)), true);
});

test("owner-level defaults are explicit or null — never invented", async () => {
  const { admin } = await liteDb();
  await one("select public.set_youtube_publish_defaults($1::uuid, 'unlisted', true)", [OWNER_A]);
  let view = await dataMod.getYouTubeConnection(admin, OWNER_A, true, false);
  assert.equal(view.defaultPrivacy, "unlisted");
  assert.equal(view.defaultMadeForKids, true);

  await one("select public.set_youtube_publish_defaults($1::uuid, null, null)", [OWNER_A]);
  view = await dataMod.getYouTubeConnection(admin, OWNER_A, true, false);
  assert.equal(view.defaultPrivacy, null, "clearing a default returns to 'no default', not to a guess");
  assert.equal(view.defaultMadeForKids, null);

  await assert.rejects(
    one("select public.set_youtube_publish_defaults($1::uuid, 'followers', null)", [OWNER_A]),
    /privacy/i,
    "an invented privacy default is refused",
  );
});

test("one YouTube channel belongs to at most ONE connected owner; disconnect frees it", async () => {
  const { admin } = await liteDb();
  const sharedChannel = "UC-shared-channel-1";
  await dataMod.saveYouTubeConnection(admin, {
    ownerId: OWNER_A, channelId: sharedChannel, channelTitle: "Shared", channelHandle: null, thumbnailUrl: null,
    grantedScopes: [...scopesMod.YOUTUBE_SCOPES], refreshToken: "refresh-a", accessToken: "access-a",
    accessTokenExpiresAt: new Date(Date.now() + 3599_000).toISOString(), encryptionKey: KEY,
  });
  await assert.rejects(
    () => dataMod.saveYouTubeConnection(admin, {
      ownerId: OWNER_B, channelId: sharedChannel, channelTitle: "Shared", channelHandle: null, thumbnailUrl: null,
      grantedScopes: [...scopesMod.YOUTUBE_SCOPES], refreshToken: "refresh-b", accessToken: "access-b",
      accessTokenExpiresAt: new Date(Date.now() + 3599_000).toISOString(), encryptionKey: KEY,
    }),
    /youtube_connection_save_failed/,
    "a second owner cannot claim an already-connected channel",
  );
  await one("select public.disconnect_youtube_connection($1::uuid)", [OWNER_A]);
  await dataMod.saveYouTubeConnection(admin, {
    ownerId: OWNER_B, channelId: sharedChannel, channelTitle: "Shared", channelHandle: null, thumbnailUrl: null,
    grantedScopes: [...scopesMod.YOUTUBE_SCOPES], refreshToken: "refresh-b", accessToken: "access-b",
    accessTokenExpiresAt: new Date(Date.now() + 3599_000).toISOString(), encryptionKey: KEY,
  });
  const rows = await all("select owner_user_id, status from public.youtube_connections where channel_id = $1 order by status", [sharedChannel]);
  assert.equal(rows.length, 2, "the disconnected history row stays; only ONE row is connected");
  assert.equal(rows.filter((row) => row.status === "connected").length, 1);
  // Restore owner A's connection for the worker tests.
  await saveConnection(OWNER_A);
});

test("owner isolation holds across every queue surface", async () => {
  const { admin } = await liteDb();
  const draftA = await makeDraft(OWNER_A);
  const rowA = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(draftA));

  // Owner B cannot see, cancel, fail, complete or record against A's row.
  assert.equal(await queueMod.getYouTubeQueueItemForDraft(admin, OWNER_B, draftA), null);
  const listB = await queueMod.listYouTubePublishQueue(admin, OWNER_B);
  assert.ok(!listB.some((row) => row.id === rowA.id), "B's queue read never contains A's row");
  assert.equal(await queueMod.cancelYouTubePublishItem(admin, OWNER_B, draftA), false);
  await assert.rejects(
    () => queueMod.completeYouTubePublishJob(admin, rowA.id, OWNER_B, { privacyStatus: "private" }),
    /youtube_publish_complete_failed/,
  );
  await assert.rejects(
    () => queueMod.failYouTubePublishJob(admin, rowA.id, OWNER_B, { code: "x", message: "y", status: "failed" }),
    /youtube_publish_fail_record_failed/,
  );
  await assert.rejects(
    () => queueMod.recordYouTubeVideoId(admin, rowA.id, OWNER_B, newVideoId(), "uploaded", "private"),
    /youtube_video_id_record_failed/,
  );
  const untouched = await one("select status, failure_code from public.youtube_publish_queue where id = $1", [rowA.id]);
  assert.equal(untouched.status, "scheduled");
  assert.equal(untouched.failure_code, null);

  // B's secret read never returns A's connection.
  const secretB = await one("select * from public.get_youtube_connection_secret($1::uuid)", [OWNER_B]).catch(() => null);
  assert.ok(!secretB || !String(secretB.channel_id ?? "").includes(OWNER_A.slice(0, 8)), "no cross-owner secret leakage");
  await queueMod.cancelYouTubePublishItem(admin, OWNER_A, draftA);
});

// ---------------------------------------------------------------------------
// 7. The workers end-to-end: PGlite database + FAKE Google + streaming bytes
// ---------------------------------------------------------------------------

// The worker streams chunk bytes through a signed-URL Range read. In this
// suite the "storage CDN" is answered locally; ANY other URL throws, proving
// no real network call ever happens.
globalThis.fetch = async (url) => {
  if (String(url).startsWith("https://signed.test/")) {
    return { ok: true, status: 206, body: new Uint8Array(64), headers: { get: () => null }, json: async () => ({}) };
  }
  throw new Error(`youtube-provider.test: unexpected real network call to ${url}`);
};

function fakeGoogle(overrides = {}) {
  const calls = [];
  return {
    calls,
    async initiateUploadSession(accessToken, metadata, contentType, contentLength) {
      calls.push(["initiate", { contentType, contentLength: Number(contentLength) }]);
      return { sessionUrl: SESSION_URL };
    },
    async uploadChunk(sessionUrl, body, contentType, contentRange) {
      calls.push(["chunk", { contentRange }]);
      return { outcome: "complete", videoId: overrides.completeVideoId, uploadStatus: overrides.completeUploadStatus ?? "processed", privacyStatus: "private" };
    },
    async queryUploadStatus() { return { outcome: "continue", receivedBytes: 0 }; },
    async getVideo(accessToken, videoId) {
      calls.push(["getVideo", { videoId }]);
      if (overrides.videosById && videoId in overrides.videosById) return overrides.videosById[videoId];
      return {
        videoId, uploadStatus: "processed", privacyStatus: "private",
        rejectionReason: null, failureReason: null, title: null, publishedAt: null, statistics: {},
      };
    },
    async listRecentUploads() { calls.push(["listRecentUploads"]); return []; },
    async refreshAccessToken() { calls.push(["refresh"]); throw new Error("unexpected refresh"); },
    async getMyChannel() { return { channelId: "UC1234567890abcdef", title: "Voom Studio", handle: null, thumbnailUrl: null, uploadsPlaylistId: "UU1234567890abcdef" }; },
    async revokeToken() { return true; },
    ...overrides,
  };
}

const noopSleep = async () => undefined;

test("the publish worker uploads a due, approved, declared item to 'published' — end to end through the real SQL", async () => {
  const { admin } = await liteDb();
  await clearClaimable();
  const draftId = await makeDraft(OWNER_A);
  await makeAsset(OWNER_A, draftId, { byteSize: 1024 });
  const videoId = newVideoId();
  await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(draftId, { scheduledAt: new Date(Date.now() - 60_000).toISOString() }));

  const google = fakeGoogle({ completeVideoId: videoId });
  const result = await workerMod.runYouTubePublishing({
    db: admin, config: fakeConfig(), clientFor: () => google, sleep: noopSleep, pollingBudgetMs: 120_000,
  });
  assert.equal(result.claimed, 1);
  assert.equal(result.published, 1);
  assert.equal(result.failed, 0);

  const row = await one("select * from public.youtube_publish_queue where draft_id = $1", [draftId]);
  assert.equal(row.status, "published");
  assert.equal(row.youtube_video_id, videoId, "the stored id is the provider's own");
  assert.equal(row.provider_upload_status, "processed");
  assert.ok(row.published_at);
  const draft = await one("select provider_ref from public.mara_drafts where id = $1", [draftId]);
  assert.equal(draft.provider_ref, videoId);

  // The upload actually streamed the declared bytes in one final chunk.
  assert.ok(google.calls.some(([kind]) => kind === "initiate"));
  const chunk = google.calls.find(([kind]) => kind === "chunk");
  assert.equal(chunk[1].contentRange, "bytes 0-1023/1024");

  // A second run finds nothing to do: the published row is never re-claimed.
  const second = await workerMod.runYouTubePublishing({
    db: admin, config: fakeConfig(), clientFor: () => google, sleep: noopSleep, pollingBudgetMs: 120_000,
  });
  assert.equal(second.claimed, 0);
  assert.equal(second.published, 0);
});

test("an unconfigured deployment claims NOTHING — a misconfigured cron never burns attempts", async () => {
  const { admin } = await liteDb();
  await clearClaimable();
  const draftId = await makeDraft(OWNER_A);
  await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(draftId, { scheduledAt: new Date(Date.now() - 60_000).toISOString() }));

  const result = await workerMod.runYouTubePublishing({ db: admin, config: null, sleep: noopSleep });
  assert.equal(result.claimed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.results[0].code, "youtube_not_configured");
  const row = await one("select status, attempts from public.youtube_publish_queue where draft_id = $1", [draftId]);
  assert.equal(row.status, "scheduled");
  assert.equal(row.attempts, 0);
});

test("quota exhaustion in the worker parks the row at the Pacific reset without burning attempts", async () => {
  const { admin } = await liteDb();
  await clearClaimable();
  const draftId = await makeDraft(OWNER_A);
  await makeAsset(OWNER_A, draftId, { byteSize: 512 });
  await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(draftId, { scheduledAt: new Date(Date.now() - 60_000).toISOString() }));

  const google = fakeGoogle({
    async initiateUploadSession() { throw new clientMod.YouTubeApiError("quota", "upload_session", "quotaExceeded", 403); },
  });
  const result = await workerMod.runYouTubePublishing({
    db: admin, config: fakeConfig(), clientFor: () => google, sleep: noopSleep, pollingBudgetMs: 120_000,
  });
  assert.equal(result.claimed, 1);
  assert.equal(result.published, 0);
  assert.equal(result.retrying, 1);

  const row = await one("select * from public.youtube_publish_queue where draft_id = $1", [draftId]);
  assert.equal(row.status, "scheduled", "a quota day is a hold, not a failure");
  assert.equal(row.failure_code, "quota_exceeded");
  assert.equal(row.attempts, 0, "the provider's daily budget never consumes the item's retry allowance");
  const retryInstant = Date.parse(row.scheduled_at);
  assert.ok(retryInstant > Date.now(), "the retry waits for the future reset");
  const resetHour = new Date(retryInstant).toISOString().slice(11, 16);
  assert.ok(resetHour === "07:00" || resetHour === "08:00", `the retry lands on midnight US Pacific (got ${resetHour} UTC)`);
});

test("reconciliation publishes on YouTube's own 'processed' evidence and fails truthfully on rejection", async () => {
  const { admin } = await liteDb();
  await clearClaimable();

  const processingDraft = await makeDraft(OWNER_A);
  const processingRow = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(processingDraft));
  const processingVideo = newVideoId();
  await queueMod.recordYouTubeVideoId(admin, processingRow.id, OWNER_A, processingVideo, "uploaded", "private");

  const rejectedDraft = await makeDraft(OWNER_A);
  const rejectedRow = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(rejectedDraft));
  const rejectedVideo = newVideoId();
  await queueMod.recordYouTubeVideoId(admin, rejectedRow.id, OWNER_A, rejectedVideo, "uploaded", "private");

  const google = fakeGoogle({
    videosById: {
      [processingVideo]: { videoId: processingVideo, uploadStatus: "processed", privacyStatus: "private", rejectionReason: null, failureReason: null, title: null, publishedAt: null, statistics: {} },
      [rejectedVideo]: { videoId: rejectedVideo, uploadStatus: "rejected", privacyStatus: "private", rejectionReason: "termsOfUse", failureReason: null, title: null, publishedAt: null, statistics: {} },
    },
  });
  const result = await reconcileMod.runYouTubeReconciliation({
    db: admin, config: fakeConfig(), clientFor: () => google, sleep: noopSleep, pollingBudgetMs: 120_000,
  });
  assert.equal(result.published, 1, "the processed video publishes through reconciliation");
  assert.equal(result.failed, 1, "the rejected video fails with Google's own reason");

  const published = await one("select * from public.youtube_publish_queue where id = $1", [processingRow.id]);
  assert.equal(published.status, "published");
  assert.equal(published.youtube_video_id, processingVideo);
  const rejected = await one("select * from public.youtube_publish_queue where id = $1", [rejectedRow.id]);
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.failure_code, "provider_rejected");
  assert.match(rejected.failure_message, /termsOfUse/);
  assert.equal(rejected.youtube_video_id, rejectedVideo, "the provider's evidence is kept even on rejection");
});

test("daily verification re-checks published evidence read-only and never rewrites the publication fact", async () => {
  const { admin, db } = await liteDb();
  const publishedRow = await one(
    "select id, youtube_video_id from public.youtube_publish_queue where owner_user_id = $1 and status = 'published' order by published_at desc limit 1",
    [OWNER_A],
  );
  await db.query("update public.youtube_publish_queue set last_provider_check_at = now() - interval '25 hours' where id = $1", [publishedRow.id]);

  // YouTube no longer returns the video: it was deleted ON YOUTUBE (by the
  // customer). Voom records the truth and keeps the publication history.
  const google = fakeGoogle({
    videosById: { [publishedRow.youtube_video_id]: null },
  });
  const result = await reconcileMod.runYouTubeReconciliation({
    db: admin, config: fakeConfig(), clientFor: () => google, sleep: noopSleep, pollingBudgetMs: 120_000,
  });
  assert.ok(result.verified >= 1, "the aged published row was re-verified");
  const row = await one("select status, provider_upload_status, provider_note, published_at, youtube_video_id from public.youtube_publish_queue where id = $1", [publishedRow.id]);
  assert.equal(row.status, "published", "deletion on YouTube does not rewrite Voom's publication fact");
  assert.equal(row.provider_upload_status, "deleted", "but the provider's current truth IS recorded");
  assert.match(row.provider_note, /deleted on YouTube/i);
  assert.ok(row.published_at);
  assert.equal(row.youtube_video_id, publishedRow.youtube_video_id);
});

test("performance syncs REAL Data API statistics idempotently; unavailable is never zero", async () => {
  const { admin, db } = await liteDb();
  await clearClaimable();

  // One published video with real statistics, one without any.
  const statsDraft = await makeDraft(OWNER_A);
  const statsRow = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(statsDraft));
  const statsVideo = newVideoId();
  await queueMod.recordYouTubeVideoId(admin, statsRow.id, OWNER_A, statsVideo, "uploaded", "private");
  await queueMod.completeYouTubePublishJob(admin, statsRow.id, OWNER_A, { privacyStatus: "private" });

  const bareDraft = await makeDraft(OWNER_A);
  const bareRow = await queueMod.enqueueYouTubePublishItem(admin, enqueueInput(bareDraft));
  const bareVideo = newVideoId();
  await queueMod.recordYouTubeVideoId(admin, bareRow.id, OWNER_A, bareVideo, "uploaded", "private");
  await queueMod.completeYouTubePublishJob(admin, bareRow.id, OWNER_A, { privacyStatus: "private" });

  // OWNER_B has a published row (from the disconnect test). Revoke the
  // connection the later channel-uniqueness test created, so the sync meets
  // the real "published history, dead credentials" situation.
  await db.query("update public.youtube_connections set status = 'revoked' where owner_user_id = $1", [OWNER_B]);
  const google = fakeGoogle({
    videosById: {
      [statsVideo]: { videoId: statsVideo, uploadStatus: "processed", privacyStatus: "private", rejectionReason: null, failureReason: null, title: null, publishedAt: null, statistics: { views: 812, likes: 44, comments: 7 } },
      [bareVideo]: { videoId: bareVideo, uploadStatus: "processed", privacyStatus: "private", rejectionReason: null, failureReason: null, title: null, publishedAt: null, statistics: {} },
    },
  });

  const run = await perfMod.runYouTubePerformanceSync({ db: admin, config: fakeConfig(), clientFor: () => google });
  const statsItem = run.items.find((item) => item.youtubeVideoId === statsVideo);
  assert.equal(statsItem.outcome, "stored");
  assert.deepEqual([...statsItem.storedMetrics].sort(), ["comments", "likes", "views"]);

  const bareItem = run.items.find((item) => item.youtubeVideoId === bareVideo);
  assert.equal(bareItem.outcome, "statistics_unavailable", "a video without returned statistics is unavailable, NOT zero");
  assert.deepEqual(bareItem.storedMetrics, []);

  const disconnectedItem = run.items.find((item) => item.ownerId === OWNER_B);
  assert.equal(disconnectedItem.outcome, "connection_unavailable", "a disconnected owner is skipped truthfully");

  const snapshot = await one("select * from public.youtube_performance_snapshots where youtube_video_id = $1", [statsVideo]);
  assert.deepEqual(snapshot.metrics, { views: 812, likes: 44, comments: 7 });
  assert.deepEqual(snapshot.metric_sources, { views: "data_api_statistics", likes: "data_api_statistics", comments: "data_api_statistics" });
  assert.equal(snapshot.owner_user_id, OWNER_A);
  const bareSnapshots = await all("select * from public.youtube_performance_snapshots where youtube_video_id = $1", [bareVideo]);
  assert.equal(bareSnapshots.length, 0, "no snapshot row is fabricated for unavailable metrics");
  const bSnapshots = await all("select * from public.youtube_performance_snapshots where owner_user_id = $1", [OWNER_B]);
  assert.equal(bSnapshots.length, 0, "no snapshot under an owner whose connection is gone");

  // Re-running inside the same hourly window REFRESHES the same row (idempotent).
  await perfMod.runYouTubePerformanceSync({ db: admin, config: fakeConfig(), clientFor: () => google });
  const count = await one("select count(*)::int as n from public.youtube_performance_snapshots where youtube_video_id = $1", [statsVideo]);
  assert.equal(count.n, 1, "one snapshot per (owner, video, hourly window)");
});

test("performance snapshots cannot store non-numbers or negatives — the schema refuses fake metrics", async () => {
  const draftId = await makeDraft(OWNER_A);
  await assert.rejects(
    one(`insert into public.youtube_performance_snapshots
         (owner_user_id, youtube_video_id, content_type, published_at, collected_at, metrics, metric_sources, draft_id)
         values ($1, $2, 'short', now(), now(), '{"views": -3}'::jsonb, '{}'::jsonb, $3)`, [OWNER_A, newVideoId(), draftId]),
    /youtube_performance_snapshots_metrics_check/,
  );
  await assert.rejects(
    one(`insert into public.youtube_performance_snapshots
         (owner_user_id, youtube_video_id, content_type, published_at, collected_at, metrics, metric_sources, draft_id)
         values ($1, $2, 'short', now(), now(), '{"views": "lots"}'::jsonb, '{}'::jsonb, $3)`, [OWNER_A, newVideoId(), draftId]),
    /youtube_performance_snapshots_metrics_check/,
  );
});

// ---------------------------------------------------------------------------
// 8. Route + UI source-level guards
// ---------------------------------------------------------------------------

test("the connect/callback routes are the server-side auth-code flow with double-submit state and no secrets outward", async () => {
  const connect = await read("app/api/integrations/youtube/connect/route.ts");
  const callback = await read("app/api/integrations/youtube/callback/route.ts");

  assert.match(connect, /createYouTubeOAuthState/, "the state is the CSPRNG database-backed value");
  assert.match(connect, /voom_youtube_oauth_state/, "the state is double-submitted through a cookie");
  assert.match(connect, /httpOnly: true/, "the state cookie is httpOnly");
  assert.match(connect, /authorizationUrl/, "Google's own authorization URL is used");
  assert.doesNotMatch(connect, /GOOGLE_CLIENT_SECRET|clientSecret/, "the secret never reaches the connect response");

  assert.match(callback, /consumeYouTubeOAuthState/, "the callback consumes the single-use state");
  assert.match(callback, /exchangeCode/, "the code exchange happens server-side");
  assert.match(callback, /refreshToken/, "offline access is verified");
  assert.match(callback, /token_no_offline_access/, "a token response without a refresh token is refused");
  assert.match(callback, /getMyChannel/, "the channel identity comes from YouTube itself");
  assert.match(callback, /saveYouTubeConnection/, "credentials are stored encrypted server-side");
  assert.match(callback, /youtube.*connected|"connected"/, "success redirects with a status code, not tokens");
  // Tokens and codes are never logged or rendered.
  for (const [name, source] of [["connect", connect], ["callback", callback]]) {
    assert.doesNotMatch(source, /console\.(log|info|warn|error)\([^)]*(token|code|secret|state)/i, `${name} logs no secret material`);
    assert.doesNotMatch(source, /NextResponse\.json\([^)]*(token|secret)/i, `${name} returns no secret material`);
  }
});

test("disconnect stops publishing and destroys credentials — and NEVER deletes a customer's YouTube video", async () => {
  const route = await read("app/api/integrations/youtube/disconnect/route.ts");
  assert.match(route, /disconnectYouTube/, "the route uses the safe disconnect path");
  const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*(\/\/).*$/gm, "");
  assert.doesNotMatch(routeCode, /videos\.delete|deleteVideo|removeVideo/i, "no video deletion exists in the route");
  assert.doesNotMatch(routeCode, /\.delete\(|videos\.delete/i, "the route contains no deletion call of any kind");
  assert.match(routeCode, /disconnect_youtube_connection|disconnectYouTube/, "the only write path is the safe disconnect");

  const data = await read("lib/youtube/data.ts");
  assert.match(data, /revokeToken/, "Google is asked to revoke the token");
  assert.doesNotMatch(data, /videos\.delete|deleteVideo/i, "the data layer has no video-deletion concept at all");

  const client = await read("lib/youtube/client.ts");
  assert.doesNotMatch(client, /method:\s*"DELETE"/, "the Google client never issues a DELETE");
  assert.doesNotMatch(client, /videos\.delete|playlistItems\.delete/i, "no delete endpoint exists in the client");

  const modal = await read("components/voom/modals/DisconnectYouTubeModal.tsx");
  assert.match(modal, /never touched|never deletes|cannot delete/i, "the modal tells the truth about videos");
});

test("the status/queue/settings/performance routes stay owner-scoped and sanitized", async () => {
  const status = await read("app/api/integrations/youtube/status/route.ts");
  assert.match(status, /getCurrentUser/, "authenticated");
  assert.match(status, /getYouTubeConnection/, "the sanitized view is the only output");
  assert.doesNotMatch(status, /youtube_connection_secrets|encrypted_|refresh_token/i, "no secret column is ever selected");

  const queue = await read("app/api/integrations/youtube/queue/route.ts");
  assert.match(queue, /getCurrentUser/);
  assert.match(queue, /listYouTubePublishQueue/, "owner-scoped queue read");
  assert.doesNotMatch(queue, /upload_session_url/, "session URLs never reach the browser");

  const settings = await read("app/api/integrations/youtube/settings/route.ts");
  assert.match(settings, /set_youtube_publish_defaults/);
  assert.match(settings, /z\.(enum|boolean)/, "declarations are validated, never free-form");

  const performance = await read("app/api/integrations/youtube/performance/route.ts");
  assert.match(performance, /getCurrentUser/);
  assert.match(performance, /youtube_performance_snapshots/);
  assert.match(performance, /owner_user_id/, "snapshots are read owner-scoped");
});

test("the three cron workers are secret-protected, bounded to 300s, and call the real runners", async () => {
  for (const [file, runner] of [
    ["app/api/cron/youtube-publish/route.ts", "runYouTubePublishing"],
    ["app/api/cron/youtube-reconcile/route.ts", "runYouTubeReconciliation"],
    ["app/api/cron/youtube-performance/route.ts", "runYouTubePerformanceSync"],
  ]) {
    const source = await read(file);
    assert.match(source, /CRON_SECRET/, `${file} requires the cron secret`);
    assert.match(source, /export const maxDuration = 300/, `${file} is bounded to the plan's 300s`);
    assert.match(source, /export const dynamic = "force-dynamic"/, `${file} is never statically cached`);
    assert.match(source, new RegExp(runner), `${file} calls ${runner}`);
    assert.match(source, /export async function GET/, `${file} supports the cron GET`);
    assert.match(source, /timingSafeEqual|Bearer \$\{secret\}/, `${file} checks the bearer secret`);
  }
  // The worker budget constant matches the route ceiling.
  assert.equal(pub.YOUTUBE_WORKER_MAX_DURATION_MS, 300_000);
  assert.ok(pub.YOUTUBE_UPLOAD_BUDGET_MS < pub.YOUTUBE_WORKER_MAX_DURATION_MS, "uploads stop before the platform kills them");
});

test("the social drafts route records declarations without inventing them, and its messages stay truthful", async () => {
  const route = await read("app/api/social-drafts/[id]/route.ts");
  assert.match(route, /madeForKids: z\.boolean\(\)\.nullable\(\)\.optional\(\)/, "the audience declaration is a real boolean or explicitly null");
  assert.match(route, /privacy: z\.enum\(\["public", "private", "unlisted"\]\)\.nullable\(\)\.optional\(\)/, "privacy is one of YouTube's three values or null");
  assert.match(route, /durable YouTube publish queue|YouTube publish queue/i, "approval messages describe the real queue");
  assert.match(route, /not connected/i, "TikTok keeps its truthful refusal message");
});

test("the YouTube hub and editor surfaces tell the provider truth", async () => {
  const page = await read("app/app/(shell)/youtube/page.tsx");
  assert.match(page, /integrations\/youtube\/status|integrations\/youtube\/queue/, "the hub reads the real endpoints");
  assert.match(page, /Compliance Audit/i, "the unaudited-project private lock is disclosed");
  assert.match(page, /YouTubeConnectModal|DisconnectYouTubeModal/, "connect/disconnect are real flows");
  assert.match(page, /never revenue/i, "monetary analytics are explicitly out of scope");
  assert.match(page, /views|likes|comments/i, "only real Data API statistics are surfaced");

  const editor = await read("components/voom/modals/SocialEditorModal.tsx");
  assert.match(editor, /Not declared yet/, "the declaration selectors start empty — never a guess");
  assert.match(editor, /Not made for kids|Made for kids/, "both COPPA options are explicit choices");
  assert.match(editor, /approval is never publication/i, "the banner keeps approval ≠ publication");
  assert.doesNotMatch(editor, /publishing is not connected yet\. You can plan, approve and schedule this video inside Voom; Voom will never claim it was published\."$/, "");

  const connectModal = await read("components/voom/modals/YouTubeConnectModal.tsx");
  assert.match(connectModal, /Upload videos to your channel/i, "the modal discloses the upload permission in human terms");
  assert.match(connectModal, /Read your channel identity/i, "the modal discloses the read-only permission");
  assert.match(connectModal, /Read public statistics/i, "the modal discloses the statistics read");
  assert.match(connectModal, /Edit or delete your existing YouTube videos/i, "the modal states what Voom NEVER asks for");
  assert.match(connectModal, /Read revenue or any monetary analytics/i, "monetary analytics are explicitly never requested");
  assert.match(connectModal, /encrypted on Voom/i, "token handling is disclosed");
  assert.doesNotMatch(connectModal, /force-ssl|yt-analytics/, "no hidden extra scope is mentioned");

  const connections = await read("app/app/(shell)/connections/page.tsx");
  assert.match(connections, /getYouTubeConnection/, "the connections tile reads the REAL connection");
  assert.match(connections, /youtube\.upload|YOUTUBE_UPLOAD_SCOPE|scopes\.includes/, "the tile requires the actual granted upload scope");
});

test("state mapping keeps the four provider truths distinct across the product", () => {
  // The channel matrix itself: YouTube is a real publishing channel now —
  // gated at runtime by the connection, never by a planning-only flag —
  // while TikTok truthfully stays unconnected.
  assert.equal(channelsMod.CHANNEL_PUBLISHING_AVAILABILITY.youtube.publishable, true);
  assert.equal(channelsMod.isChannelPublishable("youtube"), true);
  assert.equal(channelsMod.CHANNEL_PUBLISHING_AVAILABILITY.tiktok.publishable, false);
  assert.match(channelsMod.CHANNEL_PUBLISHING_AVAILABILITY.youtube.reason, /durable YouTube publish queue/i);
  assert.deepEqual([...channelsMod.formatsForChannel("youtube")].sort(), ["short", "video"]);

  const { publishStateFromYouTubeQueue } = publishStateMod;
  assert.equal(publishStateFromYouTubeQueue("scheduled"), "scheduled");
  assert.equal(publishStateFromYouTubeQueue("uploading"), "submitting", "submitted to YouTube ≠ accepted");
  assert.equal(publishStateFromYouTubeQueue("provider_processing"), "provider_processing", "accepted ≠ published");
  assert.equal(publishStateFromYouTubeQueue("published"), "published");
  assert.equal(publishStateFromYouTubeQueue("waiting_for_media"), "blocked");
  assert.equal(publishStateFromYouTubeQueue("needs_declaration"), "blocked");
  assert.equal(publishStateFromYouTubeQueue("permission_required"), "connection_required");
  assert.equal(publishStateFromYouTubeQueue("failed"), "failed");
  assert.equal(publishStateFromYouTubeQueue("cancelled"), "draft");
  assert.equal(publishStateFromYouTubeQueue(null), null);

  const { deriveActionState } = statusMod;
  const facts = (queueStatus) => ({
    kind: "social",
    channel: "youtube",
    planStatus: "ready",
    draftStatus: "approved",
    hasAsset: true,
    queueStatus,
    scheduledFor: "2026-09-21T12:00:00.000Z",
  });
  assert.equal(deriveActionState(facts("published")), "executed", "only queue-published counts as executed");
  assert.equal(deriveActionState(facts("provider_processing")), "executing");
  assert.equal(deriveActionState(facts("uploading")), "executing");
  assert.equal(deriveActionState(facts("failed")), "failed");
  assert.equal(deriveActionState(facts("cancelled")), "skipped");
  assert.equal(deriveActionState(facts("scheduled")), "scheduled");
  assert.equal(deriveActionState(facts("waiting_for_media")), "scheduled");
  assert.equal(deriveActionState(facts("needs_declaration")), "blocked");
  assert.equal(deriveActionState(facts("permission_required")), "blocked");
  // Approved with NO queue row: still blocked — nothing will happen until the
  // durable queue mirror exists.
  assert.equal(deriveActionState(facts(null)), "blocked");
  // TikTok keeps its planning-only truth.
  assert.equal(deriveActionState({ ...facts(null), channel: "tiktok" }), "blocked");
  assert.equal(deriveActionState({ ...facts("published"), channel: "tiktok", queueStatus: null }), "blocked", "TikTok can never claim execution");
});

test("the campaign layer derives YouTube execution from the QUEUE, never from the approval alone", async () => {
  const server = await read("lib/campaign/server.ts");
  assert.match(server, /youtube_publish_queue/, "the campaign view reads the real queue");
  assert.match(server, /publishStateFromYouTubeQueue/, "publish state comes from the queue mapping");
  assert.match(server, /provider_ref/, "the provider's own reference is surfaced");
  assert.match(server, /canEditContent = !\(youtubeQueue && \["uploading", "provider_processing", "published"\]/,
    "content locks while YouTube owns the item");
  assert.match(server, /publishStateFromYouTubeQueue\(youtubeQueue\.status\)/, "the publish label comes from the queue state");
});

// ---------------------------------------------------------------------------
// 9. Migration 0047 boundary: additive, RLS-protected, service-role-only
// ---------------------------------------------------------------------------

test("migration 0047 is additive and touches no Instagram, email or Campaigns object", async () => {
  // Comments (the rollback plan, prior-art references) are documentation; the
  // EXECUTED statements are what must stay additive.
  const sql = (await read("supabase/migrations/0047_youtube_provider.sql"))
    .toLowerCase()
    .replace(/^\s*--.*$/gm, "");
  assert.doesNotMatch(sql, /instagram_publish_queue|instagram_connections|instagram_connection_secrets/, "the Instagram integration is untouched");
  assert.doesNotMatch(sql, /voom_email_flow/, "email flows are untouched");
  assert.doesNotMatch(sql, /voom_email_identity|voom_email_brand|voom_email_asset|voom_email_suppression|voom_email_unsubscribe/, "the Branded Email Engine is untouched");
  assert.doesNotMatch(sql, /voom_campaigns|campaign_actions/, "the Campaigns v3 tables are untouched");
  assert.doesNotMatch(sql, /pg_cron|cron\.schedule/, "0047 schedules no cron (Vercel cron is configured in vercel.json)");
  assert.doesNotMatch(sql, /^\s*drop table(?!\s+if exists public\.youtube_)/m, "no non-YouTube table is ever dropped");
  assert.doesNotMatch(sql, /drop column|truncate/, "0047 destroys nothing");
  assert.doesNotMatch(sql, /alter table public\.(?!youtube_)/, "no existing table is altered");

  // Every definer function pins an empty search_path (the 0007 hardening rule).
  const definers = (sql.match(/security definer/g) ?? []).length;
  const pinned = (sql.match(/set search_path = ''/g) ?? []).length;
  assert.ok(definers >= 17, `every RPC is security definer (found ${definers})`);
  assert.equal(pinned, definers, "every definer function pins search_path");

  // Secrets and OAuth state have NO authenticated grant at all; the sanitized
  // connection and queue views are owner-read through RLS.
  assert.match(sql, /revoke all on table public\.youtube_connections, public\.youtube_connection_secrets, public\.youtube_oauth_states from public, anon, authenticated/);
  assert.match(sql, /grant select on table public\.youtube_connections to authenticated/);
  assert.ok(!/grant (insert|update|delete)[^;]*youtube_connection_secrets[^;]*to authenticated/s.test(sql), "clients can never write secrets");
  for (const fn of ["save_youtube_connection", "disconnect_youtube_connection", "get_youtube_connection_secret", "claim_due_youtube_upload_jobs", "complete_youtube_publish_job", "upsert_youtube_publish_queue_item"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\(`), `${fn} is revoked from clients`);
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`), `${fn} executes server-side only`);
  }

  // The rollback plan is documented in the header comments, in reverse
  // dependency order, and the production posture is explicit.
  const raw = (await read("supabase/migrations/0047_youtube_provider.sql")).toLowerCase();
  const header = raw.slice(0, raw.indexOf("begin;"));
  assert.match(header, /rollback/, "the migration documents its rollback");
  assert.match(header, /do not apply to production/i, "the production posture is documented in the header");
  assert.match(header, /never re-runs anything from 0001-0046/i, "0001-0046 are declared untouched");
});

test("the publish-flow module buffers no whole video and every route stays server-side", async () => {
  const worker = await read("lib/youtube/publish-worker.ts");
  assert.match(worker, /createSignedUrl/, "bytes stream from private storage through short-lived signed URLs");
  assert.match(worker, /Range: `bytes=/, "chunk reads are HTTP Range reads");
  assert.doesNotMatch(worker, /arrayBuffer\(\)|download\(\)/, "the worker never buffers a whole video");

  const flow = await read("lib/youtube/publish-flow.ts");
  assert.match(flow, /persistSession/, "the session is persisted before bytes");
  assert.match(flow, /recoverCompletedUpload/, "ambiguous outcomes go through read-only recovery");
  assert.match(flow, /upload_ambiguous/, "undecidable recovery fails closed");

  for (const route of [
    "app/api/integrations/youtube/connect/route.ts",
    "app/api/integrations/youtube/callback/route.ts",
    "app/api/integrations/youtube/disconnect/route.ts",
    "app/api/integrations/youtube/status/route.ts",
    "app/api/integrations/youtube/queue/route.ts",
    "app/api/integrations/youtube/settings/route.ts",
    "app/api/integrations/youtube/performance/route.ts",
  ]) {
    const source = await read(route);
    assert.doesNotMatch(source, /"use client"/, `${route} is a server route`);
    assert.match(source, /getCurrentUser/, `${route} is authenticated`);
  }
});
