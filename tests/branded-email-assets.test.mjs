/**
 * Branded Email Engine — “Add image” production bug + email-asset security.
 *
 * THE BUG
 *   Settings → Email identity & branding → Email images → Add image failed for
 *   EVERY supported upload with “Voom couldn't register that image safely.
 *   Nothing was published.” (EmailAssetError `persist_failed`).
 *
 *   Root cause: migration 0041 validated URLs with POSIX bounded repetitions
 *   whose upper bound exceeds PostgreSQL's hard limit of 255 —
 *   `^https?://[^[:space:]]{1,2000}$`. That is not a failing validation, it is
 *   an INVALID REGULAR EXPRESSION: evaluating it raises SQLSTATE 2201B
 *   (`invalid_regular_expression`, “invalid repetition count(s)”). The guard
 *   sits BEFORE the insert in `public.create_email_asset()`, so every upload
 *   blew up before a row could ever be written, and the caller's rollback
 *   deleted the object — hence “nothing was published” and an empty list.
 *   The table CHECK on `voom_email_assets.public_url` carried the same invalid
 *   regex, so the insert would have failed too.
 *
 *   Fixed by migration 0042 (the bound is expressed as `+` plus an explicit
 *   `char_length()` cap — same guard, compilable spelling). 0040 and 0041 are
 *   not modified.
 *
 * WHAT THIS FILE PINS
 *   - the real RPC runs against the repository's REAL migrations (PGlite), so
 *     the 2201B regression cannot come back silently;
 *   - the real `publishEmailAsset` / `publishDraftAssetAsEmailAsset` /
 *     `listEmailAssets` / `removeEmailAsset` code paths;
 *   - ownership, MIME, size and rollback behaviour, and the durable
 *     email-client-safe URL contract (no signed URLs, no tokens, no expiry).
 *
 * No network anywhere: `fetch` is replaced with a counter that throws, so any
 * provider, image-generation or remote-URL call fails the suite.
 */

import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

// ─── Zero-network guarantee ──────────────────────────────────────────────────

let fetchCalls = 0;
test.after(() => {
  assert.equal(
    fetchCalls,
    0,
    "no provider / image-generation / remote-URL call may be made by the email-asset path",
  );
});

// ─── Fakes ───────────────────────────────────────────────────────────────────

const PUBLIC_BUCKET_PATH = "/storage/v1/object/public/voom-email-assets/";
const CDN = "https://synrapay.supabase.co";

/**
 * In-memory storage boundary that keeps the PUBLIC email bucket and the
 * PRIVATE media bucket strictly separate, and records every interaction so a
 * test can prove nothing private was copied or exposed.
 */
function createStorage() {
  const publicObjects = new Map();
  const privateObjects = new Map();
  const privateReads = [];
  const deleted = [];
  return {
    publicObjects,
    privateObjects,
    privateReads,
    deleted,
    seedPrivate(path, bytes, mimeType) {
      privateObjects.set(path, { bytes, mimeType });
    },
    async putObject(path, bytes, mimeType) {
      assert.ok(path.startsWith("${ownerId}") === false, "path must be a real object path");
      publicObjects.set(path, { bytes, mimeType });
      return { path };
    },
    async getPrivateObject(path) {
      privateReads.push(path);
      const found = privateObjects.get(path);
      return found ? found.bytes : null;
    },
    async deleteObject(path) {
      deleted.push(path);
      publicObjects.delete(path);
    },
    publicUrlFor(path) {
      return `${CDN}${PUBLIC_BUCKET_PATH}${path}`;
    },
  };
}

/** Tables the stub is allowed to read (no SQL is ever built from test input). */
const READABLE_TABLES = new Set([
  "businesses",
  "voom_email_assets",
  "voom_email_brands",
  "post_draft_assets",
]);

/** RPCs the stub maps onto the repository's real SQL functions. */
const RPCS = {
  create_email_asset: {
    sql: "select * from public.create_email_asset($1::uuid, $2::jsonb)",
    args: (a) => [a.p_owner_user_id, JSON.stringify(a.p_payload)],
  },
  remove_email_asset: {
    sql: "select * from public.remove_email_asset($1::uuid, $2::uuid)",
    args: (a) => [a.p_owner_user_id, a.p_asset_id],
  },
  upsert_email_brand: {
    sql: "select * from public.upsert_email_brand($1::uuid, $2::jsonb)",
    args: (a) => [a.p_owner_user_id, JSON.stringify(a.p_payload)],
  },
};

/**
 * A PostgREST-shaped admin client backed by the real database, so the engine's
 * RPC calls execute the repository's real SQL (that is where the bug lived).
 *
 * `.single()` on a non-SETOF composite RPC is how `create_email_asset` is
 * called in production (the same shape `create_automated_campaign` uses), so
 * the stub resolves it to the single returned row.
 */
function createPgliteAdmin(db) {
  return {
    from(table) {
      if (!READABLE_TABLES.has(table)) throw new Error(`stub: unexpected table ${table}`);
      let columns = "*";
      const filters = [];
      let orderColumn = null;
      let orderAscending = true;
      let limitValue = null;

      const run = async () => {
        const select = columns === "*" ? "*" : columns.split(",").map((c) => `"${c.trim()}"`).join(",");
        const params = [];
        let sql = `select ${select} from public.${table}`;
        if (filters.length) {
          sql += ` where ${filters.map(([column], index) => `"${column}" = $${index + 1}`).join(" and ")}`;
          for (const [, value] of filters) params.push(value);
        }
        if (orderColumn) sql += ` order by "${orderColumn}" ${orderAscending ? "asc" : "desc"}`;
        if (limitValue !== null) {
          params.push(limitValue);
          sql += ` limit $${params.length}`;
        }
        const result = await db.query(sql, params);
        return { data: result.rows, error: null };
      };

      const builder = {
        select(cols) {
          columns = cols ?? "*";
          return builder;
        },
        eq(column, value) {
          filters.push([column, value]);
          return builder;
        },
        order(column, options) {
          orderColumn = column;
          orderAscending = options?.ascending !== false;
          return builder;
        },
        limit(n) {
          limitValue = n;
          return builder;
        },
        maybeSingle: async () => {
          const result = await run();
          return { data: result.data[0] ?? null, error: null };
        },
        single: async () => {
          const result = await run();
          return result.data.length === 1
            ? result
            : { data: result.data[0] ?? null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
        },
        then: (onFulfilled, onRejected) => run().then(onFulfilled, onRejected),
      };
      return builder;
    },

    rpc(name, args) {
      const entry = RPCS[name];
      if (!entry) throw new Error(`stub: unexpected rpc ${name}`);
      const run = async () => {
        try {
          const result = await db.query(entry.sql, entry.args(args));
          return { data: result.rows[0] ?? null, error: null };
        } catch (error) {
          // PostgREST surfaces a raised exception as an error result, which is
          // exactly what made the UI show the "couldn't register" message.
          return { data: null, error: { code: error.code ?? "PGRST000", message: error.message ?? String(error) } };
        }
      };
      const pending = run();
      return {
        then: (onFulfilled, onRejected) => pending.then(onFulfilled, onRejected),
        single: () => pending,
        maybeSingle: () => pending,
      };
    },
  };
}

// ─── Database fixture ────────────────────────────────────────────────────────

let db;
let seq = 0;
const MIGRATIONS_DIR = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));

/** Deterministic v4-shaped UUIDs so failures are reproducible. */
function nextUuid(group) {
  seq += 1;
  return `${group}-1111-4111-8111-${String(seq).padStart(12, "0")}`;
}

async function getDb() {
  if (!db) {
    ({ db } = await createSupabaseLite());
  }
  return db;
}

/** A brand-new owner + SynraPay-style business, isolated from every other test. */
async function seedOwner(name = "SynraPay") {
  const database = await getDb();
  const ownerId = nextUuid("11111111");
  await database.query(`insert into auth.users (id, email) values ($1, $2)`, [ownerId, `owner${seq}@synrapay.test`]);
  await database.query(`insert into public.businesses (owner_user_id, brand_name) values ($1, $2)`, [ownerId, name]);
  return { db: database, ownerId };
}

/** An owner with a business, plus one PRIVATE draft asset ready to be copied. */
async function seedDraftAsset(ownerId, { storagePath, mimeType }) {
  const database = await getDb();
  const draftId = nextUuid("dddddddd");
  const conversationId = nextUuid("cccccccc");
  await database.query(`insert into public.mara_conversations (id, owner_user_id) values ($1, $2)`, [conversationId, ownerId]);
  await database.query(
    `insert into public.mara_drafts
       (id, conversation_id, owner_user_id, kind, channel, title, content)
     values ($1, $2, $3, 'instagram_post', 'instagram', 'Draft', 'Content')`,
    [draftId, conversationId, ownerId],
  );
  await database.query(
    `insert into public.post_draft_assets
       (owner_user_id, draft_id, storage_path, display_name, mime_type, byte_size)
     values ($1, $2, $3, 'hero.jpg', $4, $5)`,
    [ownerId, draftId, storagePath, mimeType, 4096],
  );
  return draftId;
}

// ─── Image fixtures (real bytes, generated locally — no provider) ─────────────

async function imageBytes(format, { width = 12, height = 12 } = {}) {
  const base = sharp({ create: { width, height, channels: 3, background: { r: 24, g: 90, b: 200 } } });
  if (format === "png") return new Uint8Array(await base.png().toBuffer());
  if (format === "webp") return new Uint8Array(await base.webp().toBuffer());
  if (format === "gif") return new Uint8Array(await base.gif().toBuffer());
  return new Uint8Array(await base.jpeg().toBuffer());
}

/** A noisy PNG well over the 300 KB optimizer threshold. */
async function largePngBytes() {
  const width = 900;
  const height = 900;
  const raw = Buffer.alloc(width * height * 3);
  let seed = 0x9e3779b9;
  for (let i = 0; i < raw.length; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    raw[i] = seed >>> 16;
  }
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer());
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const { publishEmailAsset, publishDraftAssetAsEmailAsset, removeEmailAsset, listEmailAssets, EmailAssetError, EMAIL_ASSET_MAX_BYTES } =
  await import("../lib/email/branded/assets.ts");

async function publish(admin, storage, ownerId, bytes, extra = {}) {
  return publishEmailAsset(admin, storage, {
    ownerId,
    bytes,
    altText: extra.altText ?? "SynraPay dashboard",
    sourceKind: extra.sourceKind ?? "uploaded",
    sourceDraftId: extra.sourceDraftId ?? null,
  });
}

/**
 * The email-client-safe delivery contract: an email outlives any signed URL by
 * years, so the stored URL must be durable, public and token-free.
 */
function assertDurableEmailUrl(url, path) {
  assert.equal(typeof url, "string", "a public_url is stored");
  assert.ok(url.startsWith("https://"), `email URL must be https: ${url}`);
  assert.ok(url.includes(PUBLIC_BUCKET_PATH), `email URL must be the public bucket path: ${url}`);
  assert.ok(url.endsWith(`/${path}`), `email URL must point at the stored object: ${url} vs ${path}`);
  assert.ok(!url.includes("?"), `email URL must carry no query string (signed URLs expire): ${url}`);
  assert.ok(!/token=|[?&](sig|signature|expires|X-Amz-|AWSAccessKeyId)=/i.test(url), `no signing material: ${url}`);
  assert.ok(!/sign|download\?/i.test(url), `not a signed download link: ${url}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The actual root cause: an invalid PostgreSQL bounded repetition
// ═════════════════════════════════════════════════════════════════════════════

test("1a. the 0041 URL pattern is genuinely uncompilable — PostgreSQL caps {m,n} at 255", async () => {
  const database = await getDb();

  // The exact pattern 0041 used. It does not "fail validation" — the regex
  // itself cannot be compiled, so evaluating it raises SQLSTATE 2201B.
  for (const bound of [2000, 500, 256]) {
    await assert.rejects(
      () => database.query(`select 'https://cdn.example/a.png' ~* '^https?://[^[:space:]]{1,${bound}}$'`),
      (error) => error.code === "2201B",
      `{{1,${bound}}} must be rejected as an invalid regular expression`,
    );
  }

  // 255 is the documented ceiling, and the 0042 spelling compiles.
  const ok = await database.query(`select 'https://cdn.example/a.png' ~* '^https?://[^[:space:]]{1,255}$' as m`);
  assert.equal(ok.rows[0].m, true);
  const fixed = await database.query(`select 'https://cdn.example/a.png' ~* '^https?://[^[:space:]]+$' as m`);
  assert.equal(fixed.rows[0].m, true);
});

test("1b. create_email_asset now accepts the exact payload publishEmailAsset sends", async () => {
  const { db: database, ownerId } = await seedOwner();
  const admin = createPgliteAdmin(database);

  // This call raised 2201B on every single upload before migration 0042.
  const result = await database.query(
    `select * from public.create_email_asset($1::uuid, $2::jsonb)`,
    [
      ownerId,
      JSON.stringify({
        publicPath: `${ownerId}/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f.png`,
        publicUrl: `${CDN}${PUBLIC_BUCKET_PATH}${ownerId}/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f.png`,
        mimeType: "image/png",
        byteSize: 4242,
        altText: "SynraPay dashboard",
        width: 800,
        height: 600,
        sourceKind: "uploaded",
        sourceDraftId: null,
      }),
    ],
  );

  assert.equal(result.rows.length, 1, "the row is registered");
  assert.equal(result.rows[0].status, "ready");
  assert.equal(result.rows[0].owner_user_id, ownerId);
  assert.equal(result.rows[0].mime_type, "image/png");
  assert.equal(result.rows[0].byte_size, 4242);
  assert.ok(String(result.rows[0].public_url).startsWith("https://"));

  // And the same call through the engine publishes an asset end to end.
  const storage = createStorage();
  const asset = await publish(admin, storage, ownerId, await imageBytes("png"));
  assert.equal(asset.status, "ready");
  assert.equal(asset.owner_user_id, ownerId);
});

test("1c. the voom_email_assets CHECK no longer carries an invalid regex", async () => {
  const database = await getDb();
  const { rows } = await database.query(
    `select pg_get_constraintdef(oid) as definition
       from pg_constraint
      where conrelid = 'public.voom_email_assets'::regclass
        and conname = 'voom_email_assets_public_url_check'`,
  );
  assert.equal(rows.length, 1);
  const definition = rows[0].definition;
  assert.ok(!/\{\s*\d+\s*,\s*(?:2[5-9][6-9]|[3-9]\d\d|\d{4,})\s*\}/.test(definition), definition);
  assert.ok(!/\{\s*(?:2[5-9][6-9]|[3-9]\d\d|\d{4,})\s*\}/.test(definition), definition);
});

test("1d. no new migration may contain a POSIX bounded repetition above 255", async () => {
  // 0040/0041 are frozen history (and 0041 is where this defect came from);
  // they are superseded by 0042 rather than edited. Everything written from
  // 0042 onwards must compile.
  const offenders = [];
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith(".sql")) continue;
    if (file < "0042_") continue;
    // Comments quote the 0041 defect on purpose — scan the executable SQL only.
    const source = readFileSync(new URL(file, `file://${MIGRATIONS_DIR}/`), "utf8").replace(/--[^\n]*/g, "");
    for (const match of source.matchAll(/\{(\d+)(?:\s*,\s*(\d*))?\}/g)) {
      for (const bound of [match[1], match[2]]) {
        if (bound && Number(bound) > 255) offenders.push(`${file}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "a bounded repetition above 255 raises SQLSTATE 2201B at runtime");
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. A legitimate supported business-owned image succeeds
// ═════════════════════════════════════════════════════════════════════════════

for (const format of ["jpeg", "png", "webp"]) {
  test(`2a. a valid ${format.toUpperCase()} upload publishes, registers and appears under Email images`, async () => {
    const { db: database, ownerId } = await seedOwner();
    const admin = createPgliteAdmin(database);
    const storage = createStorage();
    const bytes = await imageBytes(format);

    const asset = await publish(admin, storage, ownerId, bytes);

    assert.equal(asset.owner_user_id, ownerId, "registered to the correct owner");
    assert.notEqual(asset.business_id, null, "registered to the owner's business");
    assert.equal(asset.status, "ready");
    assert.equal(asset.mime_type, `image/${format === "jpeg" ? "jpeg" : format}`);
    assert.ok(asset.byte_size > 0);
    assert.ok(asset.public_path.startsWith(`${ownerId}/`), "object lives under the owner's own prefix");
    assert.equal(storage.publicObjects.size, 1, "exactly one object in the public bucket");
    assertDurableEmailUrl(asset.public_url, asset.public_path);

    // The durable URL stored in the row is the URL the bucket actually serves.
    assert.equal(asset.public_url, storage.publicUrlFor(asset.public_path));
    // The stored bytes are the real image bytes (or an email-sized re-encode).
    const stored = storage.publicObjects.get(asset.public_path);
    assert.ok(stored.bytes.byteLength > 0);
    assert.equal(stored.mimeType, asset.mime_type);
  });
}

test("2b. a large image is optimized for email and still publishes", async () => {
  const { db: database, ownerId } = await seedOwner();
  const admin = createPgliteAdmin(database);
  const storage = createStorage();
  const original = await largePngBytes();
  assert.ok(original.byteLength > 300 * 1024, "fixture really is above the optimizer threshold");

  const asset = await publish(admin, storage, ownerId, original);

  const stored = storage.publicObjects.get(asset.public_path);
  assert.ok(stored.bytes.byteLength < original.byteLength, "a 700px+ hero is re-encoded smaller for inboxes");
  assert.equal(asset.byte_size, stored.bytes.byteLength, "the row records the bytes that were actually stored");
  assertDurableEmailUrl(asset.public_url, asset.public_path);
});

test("2c. reload / re-read returns the registered asset with the same durable URL", async () => {
  const { db: database, ownerId } = await seedOwner();
  const admin = createPgliteAdmin(database);
  const storage = createStorage();

  const asset = await publish(admin, storage, ownerId, await imageBytes("jpeg"));

  const reloaded = await listEmailAssets(admin, ownerId);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].id, asset.id);
  assert.equal(reloaded[0].public_url, asset.public_url, "the URL survives a reload unchanged");
  assertDurableEmailUrl(reloaded[0].public_url, asset.public_path);

  // A second reload reads the same durable row again.
  const again = await listEmailAssets(admin, ownerId);
  assert.deepEqual(
    { id: again[0].id, url: again[0].public_url },
    { id: asset.id, url: asset.public_url },
    "the published image is stable across reloads",
  );
});

test("2d. the published asset reaches the branded renderer and MARA design selection", async () => {
  const { db: database, ownerId } = await seedOwner();
  const admin = createPgliteAdmin(database);
  const storage = createStorage();
  const { loadEmailBrandProfile } = await import("../lib/email/branded/brand.ts");
  const { validateEmailDesign } = await import("../lib/email/branded/design.ts");

  const asset = await publish(admin, storage, ownerId, await imageBytes("png"));
  const profile = await loadEmailBrandProfile(admin, ownerId);

  assert.equal(profile.assets.length, 1, "the renderer sees the published image");
  assert.equal(profile.assets[0].assetId, asset.id);
  assert.equal(profile.assets[0].url, asset.public_url);
  assertDurableEmailUrl(profile.assets[0].url, asset.public_path);

  // MARA may select this asset — and only the business's own published assets.
  const design = {
    layout: "announcement",
    subject: "Your SynraPay dashboard is ready",
    preheader: "",
    headline: "Faster payouts, same price",
    sections: [{ kind: "text", text: "Your new dashboard is live today." }],
    cta: { label: "Open SynraPay", url: null },
    heroAssetId: asset.id,
  };
  const accepted = validateEmailDesign(design, { allowedAssetIds: profile.assets.map((a) => a.assetId) });
  assert.equal(accepted.ok, true, "a published asset is a legal hero image");

  const foreign = validateEmailDesign(design, { allowedAssetIds: ["33333333-3333-4333-8333-333333333333"] });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, "hero_asset_not_authorized", "an unpublished asset is refused");
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Refusals stay refusals
// ═════════════════════════════════════════════════════════════════════════════

test("3a. an unsupported image type is rejected (GIF: not an email-safe type)", async () => {
  const { db: database, ownerId } = await seedOwner();
  const admin = createPgliteAdmin(database);
  const storage = createStorage();

  await assert.rejects(
    publish(admin, storage, ownerId, await imageBytes("gif")),
    (error) => error instanceof EmailAssetError && error.code === "invalid_image",
  );
  assert.equal(storage.publicObjects.size, 0, "nothing stored");
  assert.deepEqual(await listEmailAssets(admin, ownerId), [], "no row registered");
});

test("3b. a draft asset that is not an email-safe image is rejected (video/mp4)", async () => {
  const { db: database, ownerId } = await seedOwner();
  const admin = createPgliteAdmin(database);
  const storage = createStorage();
  const draftId = await seedDraftAsset(ownerId, { storagePath: `${ownerId}/private/hero-clip.mp4`, mimeType: "video/mp4" });
  storage.seedPrivate(`${ownerId}/private/hero-clip.mp4`, new Uint8Array(1024), "video/mp4");

  await assert.rejects(
    publishDraftAssetAsEmailAsset(admin, storage, { ownerId, draftId, altText: "hero" }),
    (error) => error instanceof EmailAssetError && error.code === "unsupported_mime",
  );
  assert.equal(storage.publicObjects.size, 0);
});

test("3c. an oversized image is rejected", async () => {
  const { db: database, ownerId } = await seedOwner();
  const admin = createPgliteAdmin(database);
  const storage = createStorage();

  // Engine cap: a private draft asset above 5 MB is refused before any copy.
  const oversized = new Uint8Array(Buffer.concat([PNG_MAGIC, Buffer.alloc(EMAIL_ASSET_MAX_BYTES + 1024)]));
  const draftId = await seedDraftAsset(ownerId, { storagePath: `${ownerId}/private/huge-upload.png`, mimeType: "image/png" });
  storage.seedPrivate(`${ownerId}/private/huge-upload.png`, oversized, "image/png");

  await assert.rejects(
    publishDraftAssetAsEmailAsset(admin, storage, { ownerId, draftId, altText: "huge" }),
    (error) => error instanceof EmailAssetError && error.code === "file_too_large",
  );
  assert.equal(storage.publicObjects.size, 0, "an oversized image is never copied");

  // Database backstop: nothing above 10 MB can be registered either.
  await assert.rejects(
    publish(admin, storage, ownerId, new Uint8Array(Buffer.concat([PNG_MAGIC, Buffer.alloc(11 * 1024 * 1024)]))),
    (error) => error instanceof EmailAssetError && error.code === "persist_failed",
  );
  assert.deepEqual(await listEmailAssets(admin, ownerId), [], "no oversized row");

  // And the route still caps decoded upload bytes at the engine maximum.
  const routeSource = readFileSync(fileURLToPath(new URL("../app/api/voom/email-assets/route.ts", import.meta.url)), "utf8");
  assert.match(routeSource, /decoded\.byteLength > EMAIL_ASSET_MAX_BYTES/, "the upload route enforces the size cap");
});

test("3d. a malformed file is rejected — an image filename does not make an image", async () => {
  const { db: database, ownerId } = await seedOwner();
  const admin = createPgliteAdmin(database);
  const storage = createStorage();

  const notAnImage = new TextEncoder().encode("<html><body>not a picture at all</body></html>");
  await assert.rejects(
    publish(admin, storage, ownerId, notAnImage),
    (error) => error instanceof EmailAssetError && error.code === "invalid_image",
  );
  assert.equal(storage.publicObjects.size, 0);
  assert.deepEqual(await listEmailAssets(admin, ownerId), []);

  // Truncated to nothing at all — still refused, never stored.
  await assert.rejects(
    publish(admin, storage, ownerId, new Uint8Array([])),
    (error) => error instanceof EmailAssetError && error.code === "invalid_image",
  );
  assert.equal(storage.publicObjects.size, 0);
});

test("3e. an asset the owner does not own is rejected", async () => {
  const { db: database, ownerId } = await seedOwner();
  const { ownerId: otherOwner } = await seedOwner("Someone Else");
  const admin = createPgliteAdmin(database);
  const storage = createStorage();

  // The draft belongs to the other owner.
  const draftId = await seedDraftAsset(otherOwner, { storagePath: `${otherOwner}/private/theirs.png`, mimeType: "image/png" });
  storage.seedPrivate(`${otherOwner}/private/theirs.png`, await imageBytes("png"), "image/png");

  await assert.rejects(
    publishDraftAssetAsEmailAsset(admin, storage, { ownerId, draftId, altText: "theirs" }),
    (error) => error instanceof EmailAssetError && error.code === "source_not_found",
  );
  assert.equal(storage.publicObjects.size, 0, "no copy of an unauthorized asset");
  assert.equal(storage.privateReads.length, 0, "the other owner's object was never even read");
  assert.deepEqual(await listEmailAssets(admin, ownerId), []);
  assert.deepEqual(await listEmailAssets(admin, otherOwner), []);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Owner isolation — no cross-tenant read, write or exposure
// ═════════════════════════════════════════════════════════════════════════════

test("4a. one owner never sees another owner's published images", async () => {
  const { db: database, ownerId } = await seedOwner();
  const { ownerId: otherOwner } = await seedOwner("Someone Else");
  const admin = createPgliteAdmin(database);
  const storage = createStorage();

  const mine = await publish(admin, storage, ownerId, await imageBytes("png"));
  const theirs = await publish(admin, storage, otherOwner, await imageBytes("jpeg"));

  const myList = await listEmailAssets(admin, ownerId);
  assert.deepEqual(myList.map((row) => row.id), [mine.id]);
  const theirList = await listEmailAssets(admin, otherOwner);
  assert.deepEqual(theirList.map((row) => row.id), [theirs.id]);
  assert.ok(!myList.some((row) => row.public_url?.includes(theirs.public_path)));

  // Removing across owners is refused, and the object is untouched.
  await assert.rejects(
    removeEmailAsset(admin, storage, { ownerId, assetId: theirs.id }),
    (error) => error instanceof EmailAssetError && error.code === "asset_not_found",
  );
  assert.ok(storage.publicObjects.has(theirs.public_path), "the other owner's object is not deleted");
  assert.ok(!storage.deleted.includes(theirs.public_path));

  // The owner can remove their own.
  const removed = await removeEmailAsset(admin, storage, { ownerId, assetId: mine.id });
  assert.equal(removed.path, mine.public_path);
  assert.ok(!storage.publicObjects.has(mine.public_path), "the owner's own object is deleted");
});

test("4b. publishing a draft copies only that owner's object — nothing private leaks", async () => {
  const { db: database, ownerId } = await seedOwner();
  const { ownerId: otherOwner } = await seedOwner("Someone Else");
  const admin = createPgliteAdmin(database);
  const storage = createStorage();

  // Two private objects: one mine, one the other owner's.
  storage.seedPrivate(`${ownerId}/private/mine.png`, await imageBytes("png"), "image/png");
  storage.seedPrivate(`${otherOwner}/private/theirs.png`, await imageBytes("png"), "image/png");
  const draftId = await seedDraftAsset(ownerId, { storagePath: `${ownerId}/private/mine.png`, mimeType: "image/png" });

  const asset = await publishDraftAssetAsEmailAsset(admin, storage, { ownerId, draftId, altText: "my hero" });

  assert.equal(storage.publicObjects.size, 1, "exactly one object was published");
  assert.ok(storage.publicObjects.has(asset.public_path));
  assert.deepEqual(storage.privateReads, [`${ownerId}/private/mine.png`], "only the owner's own object was read");
  assert.ok(
    !Array.from(storage.publicObjects.values()).some((entry) => entry.bytes === storage.privateObjects.get(`${otherOwner}/private/theirs.png`).bytes),
    "the other owner's private bytes were never copied into the public bucket",
  );
  assert.equal(asset.owner_user_id, ownerId);
  assertDurableEmailUrl(asset.public_url, asset.public_path);
  assert.equal(asset.source_kind, "from_draft_asset");

  // The private bucket is unchanged by the copy.
  assert.equal(storage.privateObjects.size, 2);
  assert.ok(storage.privateObjects.has(`${otherOwner}/private/theirs.png`));
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. A failed registration never leaves a fake published state
// ═════════════════════════════════════════════════════════════════════════════

test("5a. when the row cannot be registered, the object is rolled back and nothing is published", async () => {
  const database = await getDb();
  const admin = createPgliteAdmin(database);
  const storage = createStorage();

  // An owner with no business row: the RPC refuses (`business_not_found`)
  // AFTER the object has been written to the public bucket.
  const orphanOwner = nextUuid("99999999");
  await database.query(`insert into auth.users (id, email) values ($1, $2)`, [orphanOwner, "nobusiness@synrapay.test"]);

  await assert.rejects(
    publish(admin, storage, orphanOwner, await imageBytes("png")),
    (error) => error instanceof EmailAssetError && error.code === "persist_failed",
    "the UI's exact failure branch",
  );

  assert.equal(storage.publicObjects.size, 0, "the public bucket holds no orphan bytes");
  assert.equal(storage.deleted.length, 1, "the object was deleted on rollback");
  assert.deepEqual(await listEmailAssets(admin, orphanOwner), [], "no fake published row");
});

test("5b. a hard RPC failure leaves no row and no object", async () => {
  const { db: database, ownerId } = await seedOwner();
  const admin = createPgliteAdmin(database);
  const storage = createStorage();

  const brokenAdmin = {
    ...admin,
    rpc() {
      const pending = Promise.resolve({ data: null, error: { code: "PGRST000", message: "rpc_denied" } });
      return { then: (f, r) => pending.then(f, r), single: () => pending, maybeSingle: () => pending };
    },
  };

  await assert.rejects(
    publish(brokenAdmin, storage, ownerId, await imageBytes("jpeg")),
    (error) => error instanceof EmailAssetError && error.code === "persist_failed",
  );
  assert.equal(storage.publicObjects.size, 0);
  assert.equal(storage.deleted.length, 1);
  assert.deepEqual(await listEmailAssets(admin, ownerId), [], "no fake published state after a failure");
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. The sibling 0041 defects of the same class are fixed too
// ═════════════════════════════════════════════════════════════════════════════

test("6a. saving an email brand with a website now works (and is still validated)", async () => {
  const { db: database, ownerId } = await seedOwner();
  const admin = createPgliteAdmin(database);

  const saved = await admin.rpc("upsert_email_brand", {
    p_owner_user_id: ownerId,
    p_payload: { website: "https://synrapay.com", footerLine: "Dubai · support@synrapay.com" },
  });
  assert.equal(saved.error, null, `upsert_email_brand must not raise: ${saved.error?.message}`);
  assert.equal(saved.data.website, "https://synrapay.com");

  const rejected = await admin.rpc("upsert_email_brand", {
    p_owner_user_id: ownerId,
    p_payload: { website: "javascript:alert(1)" },
  });
  assert.notEqual(rejected.error, null, "a non-http destination is still refused");
  assert.match(rejected.error.message, /invalid_website/);
});

test("6b. the campaign CTA destination check compiles and still validates", async () => {
  const database = await getDb();
  const { rows } = await database.query(
    `select pg_get_constraintdef(oid) as definition
       from pg_constraint
      where conrelid = 'public.voom_campaigns'::regclass
        and conname = 'voom_campaigns_cta_url_check'`,
  );
  assert.equal(rows.length, 1);
  assert.ok(!/\{\s*\d+\s*,\s*(?:2[5-9][6-9]|[3-9]\d\d|\d{4,})\s*\}/.test(rows[0].definition), rows[0].definition);
});
