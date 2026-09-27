import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const crypto = await import("../lib/instagram/crypto.ts");
const dataApi = await import("../lib/instagram/data.ts");
const rotation = await import("../lib/instagram/key-rotation.ts");

const OLD_KEY = "old-primary-instagram-key-0000000000000";
const NEW_KEY = "new-next-instagram-key-111111111111111";
const LEGACY_KEY = "older-legacy-instagram-key-22222222222";
const OTHER_KEY = "unrelated-instagram-key-333333333333333";

const STAGED_RING = { primary: OLD_KEY, next: NEW_KEY, legacy: [] };
const OLD_ONLY = { primary: OLD_KEY, legacy: [] };
const NEW_ONLY = { primary: NEW_KEY, legacy: [] };

const SYNRAPAY = "11111111-1111-4111-8111-111111111111";
const VIBEBLING_A = "22222222-2222-4222-8222-222222222222";
const VIBEBLING_B = "33333333-3333-4333-8333-333333333333";

/** Exact original v1 storage shape: bare base64 and key_version=1. */
function legacyEncrypt(token, key) {
  const blob = crypto.encryptInstagramToken(token, { primary: key, legacy: [] });
  const { payload } = crypto.parseStoredToken(blob.encryptedToken);
  return { encryptedToken: payload, iv: blob.iv, authTag: blob.authTag, keyVersion: 1 };
}

function primaryRow(ownerUserId, token) {
  return { ownerUserId, ...crypto.encryptInstagramToken(token, OLD_ONLY) };
}

function stagedRow(ownerUserId, token) {
  return { ownerUserId, ...crypto.encryptInstagramTokenForStagedRotation(token, NEW_KEY) };
}

/** In-memory equivalent of the two 0023 RPCs. */
function makeStore(rows) {
  const state = rows.map((row) => ({ ...row }));
  const writes = [];
  return {
    state,
    writes,
    async listRows() {
      return state.map((row) => ({
        ownerUserId: row.ownerUserId,
        encryptedToken: row.encryptedToken,
        iv: row.iv,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
      }));
    },
    async writeRow(ownerUserId, next) {
      const row = state.find((entry) => entry.ownerUserId === ownerUserId);
      if (!row) throw new Error("missing row");
      Object.assign(row, next);
      writes.push(ownerUserId);
    },
  };
}

function credentialsDb(blob) {
  return {
    rpc(name) {
      assert.equal(name, "get_instagram_connection_secret");
      return {
        async maybeSingle() {
          return {
            error: null,
            data: {
              connection_status: "connected",
              instagram_user_id: "17841400000000000",
              encrypted_access_token: blob.encryptedToken,
              token_iv: blob.iv,
              token_auth_tag: blob.authTag,
              key_version: blob.keyVersion,
              token_expires_at: null,
            },
          };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// PRIMARY -> NEXT read behavior and version compatibility
// ---------------------------------------------------------------------------

test("1. a token encrypted with the current old PRIMARY decrypts", () => {
  const blob = crypto.encryptInstagramToken("IGQV-primary-old", OLD_ONLY);
  assert.equal(blob.keyVersion, crypto.CURRENT_KEY_VERSION);
  assert.match(blob.encryptedToken, /^v2:/);
  assert.equal(crypto.decryptInstagramToken(blob, STAGED_RING), "IGQV-primary-old");
});

test("2. getInstagramServerCredentials decrypts a NEXT row while PRIMARY is still old", async () => {
  const blob = crypto.encryptInstagramTokenForStagedRotation("IGQV-next-before-cutover", NEW_KEY);
  const credentials = await dataApi.getInstagramServerCredentials(credentialsDb(blob), SYNRAPAY, STAGED_RING);
  assert.equal(credentials.accessToken, "IGQV-next-before-cutover");
  assert.equal(crypto.inspectStoredToken(blob, STAGED_RING).keySource, "next");
});

test("existing unprefixed v1 and prefixed v2 values remain readable", () => {
  const v1 = legacyEncrypt("IGQV-v1", LEGACY_KEY);
  const v2 = crypto.encryptInstagramToken("IGQV-v2", OLD_ONLY);
  const ring = { primary: OLD_KEY, next: NEW_KEY, legacy: [LEGACY_KEY] };

  assert.equal(crypto.parseStoredToken(v1.encryptedToken).version, crypto.LEGACY_KEY_VERSION);
  assert.equal(crypto.parseStoredToken(v2.encryptedToken).version, crypto.CURRENT_KEY_VERSION);
  assert.equal(crypto.decryptInstagramToken(v1, ring), "IGQV-v1");
  assert.equal(crypto.decryptInstagramToken(v2, ring), "IGQV-v2");
});

test("staged v3 records identify the exact NEXT key without exposing it", () => {
  const blob = crypto.encryptInstagramTokenForStagedRotation("IGQV-v3", NEW_KEY);
  const parsed = crypto.parseStoredToken(blob.encryptedToken);

  assert.equal(blob.keyVersion, crypto.STAGED_KEY_VERSION);
  assert.equal(parsed.version, crypto.STAGED_KEY_VERSION);
  assert.match(blob.encryptedToken, /^v3:[A-Za-z0-9_-]{22}:/);
  assert.equal(crypto.inspectStoredToken(blob, STAGED_RING).keySource, "next");
  assert.throws(() => crypto.decryptInstagramToken(blob, OLD_ONLY));
  assert.equal(crypto.decryptInstagramToken(blob, NEW_ONLY), "IGQV-v3");
  assert.ok(!blob.encryptedToken.includes(NEW_KEY));
});

test("key-ring fallback order is PRIMARY, NEXT, LEGACY and duplicate keys are removed", () => {
  const ring = crypto.toKeyRing({
    primary: OLD_KEY,
    next: NEW_KEY,
    legacy: [OLD_KEY, NEW_KEY, LEGACY_KEY, LEGACY_KEY],
  });
  assert.deepEqual(ring, { primary: OLD_KEY, next: NEW_KEY, legacy: [LEGACY_KEY] });

  assert.equal(crypto.inspectStoredToken(crypto.encryptInstagramToken("old", OLD_ONLY), ring).keySource, "primary");
  assert.equal(crypto.inspectStoredToken(crypto.encryptInstagramTokenForStagedRotation("new", NEW_KEY), ring).keySource, "next");
  assert.equal(crypto.inspectStoredToken(legacyEncrypt("legacy", LEGACY_KEY), ring).keySource, "legacy");
});

// ---------------------------------------------------------------------------
// Normal writes stay on PRIMARY
// ---------------------------------------------------------------------------

test("3. normal saveInstagramConnection writes with PRIMARY, never NEXT", async () => {
  let call;
  const db = {
    async rpc(name, args) {
      call = { name, args };
      return { error: null };
    },
  };

  await dataApi.saveInstagramConnection(db, {
    ownerId: SYNRAPAY,
    instagramUserId: "17841400000000000",
    username: "synrapay.ai",
    name: "Synra Pay",
    accountType: "BUSINESS",
    profilePictureUrl: null,
    accessToken: "IGQV-normal-write",
    expiresIn: 3600,
    encryptionKey: STAGED_RING,
  });

  assert.equal(call.name, "save_instagram_connection");
  const stored = {
    encryptedToken: call.args.p_encrypted_access_token,
    iv: call.args.p_token_iv,
    authTag: call.args.p_token_auth_tag,
  };
  assert.equal(call.args.p_key_version, crypto.CURRENT_KEY_VERSION);
  assert.match(stored.encryptedToken, /^v2:/);
  assert.equal(crypto.decryptInstagramToken(stored, OLD_ONLY), "IGQV-normal-write");
  assert.throws(() => crypto.decryptInstagramToken(stored, NEW_ONLY));
});

// ---------------------------------------------------------------------------
// Staged dry run and real migration
// ---------------------------------------------------------------------------

test("4. staged dry run reports migratable/already/failed counts and writes nothing", async () => {
  const store = makeStore([
    primaryRow(SYNRAPAY, "IGQV-old"),
    stagedRow(VIBEBLING_A, "IGQV-next"),
    { ownerUserId: VIBEBLING_B, ...crypto.encryptInstagramToken("IGQV-orphan", OTHER_KEY) },
  ]);
  const before = structuredClone(store.state);

  const outcome = await rotation.rotateInstagramTokens(store, STAGED_RING, { dryRun: true });

  assert.deepEqual(outcome, {
    scanned: 3,
    migratable: 1,
    migrated: 0,
    alreadyOnNext: 1,
    failed: 1,
  });
  assert.deepEqual(store.writes, []);
  assert.deepEqual(store.state, before);
  assert.deepEqual(rotation.publicRotationResult(outcome, true), {
    scanned: 3,
    migratable: 1,
    alreadyOnNext: 1,
    failed: 1,
  });
});

test("5. real migration re-encrypts all old PRIMARY rows specifically onto NEXT", async () => {
  const tokens = {
    [SYNRAPAY]: "IGQV-synrapay-token",
    [VIBEBLING_A]: "IGQV-vibebling-a-token",
    [VIBEBLING_B]: "IGQV-vibebling-b-token",
  };
  const store = makeStore(Object.entries(tokens).map(([owner, token]) => primaryRow(owner, token)));

  const outcome = await rotation.rotateInstagramTokens(store, STAGED_RING);

  assert.deepEqual(outcome, {
    scanned: 3,
    migratable: 0,
    migrated: 3,
    alreadyOnNext: 0,
    failed: 0,
  });
  for (const row of store.state) {
    assert.equal(row.keyVersion, crypto.STAGED_KEY_VERSION);
    assert.match(row.encryptedToken, /^v3:[A-Za-z0-9_-]{22}:/);
    assert.equal(crypto.inspectStoredToken(row, STAGED_RING).keySource, "next");
    assert.equal(crypto.decryptInstagramToken(row, NEW_ONLY), tokens[row.ownerUserId]);
    assert.throws(() => crypto.decryptInstagramToken(row, OLD_ONLY));
  }
});

test("6. each planned replacement is round-trip verified with NEXT alone", async () => {
  const plan = rotation.planRowRotation(primaryRow(SYNRAPAY, "IGQV-verify-next"), STAGED_RING);
  assert.equal(plan.result, "migratable");
  assert.equal(plan.next.keyVersion, crypto.STAGED_KEY_VERSION);
  assert.equal(crypto.decryptInstagramToken(plan.next, NEW_ONLY), "IGQV-verify-next");
  assert.throws(() => crypto.decryptInstagramToken(plan.next, OLD_ONLY));

  const source = await read("lib/instagram/key-rotation.ts");
  assert.match(source, /const verified = decryptInstagramToken\([\s\S]*?nextKey,/);
});

test("7. a migrated row remains readable through normal credentials before cutover", async () => {
  const store = makeStore([primaryRow(SYNRAPAY, "IGQV-before-cutover")]);
  await rotation.rotateInstagramTokens(store, STAGED_RING);

  const credentials = await dataApi.getInstagramServerCredentials(
    credentialsDb(store.state[0]),
    SYNRAPAY,
    STAGED_RING,
  );
  assert.equal(credentials.accessToken, "IGQV-before-cutover");
});

test("8. a migrated row remains readable after NEXT becomes PRIMARY and NEXT is absent", async () => {
  const store = makeStore([primaryRow(SYNRAPAY, "IGQV-after-cutover")]);
  await rotation.rotateInstagramTokens(store, STAGED_RING);

  const credentials = await dataApi.getInstagramServerCredentials(
    credentialsDb(store.state[0]),
    SYNRAPAY,
    NEW_ONLY,
  );
  assert.equal(credentials.accessToken, "IGQV-after-cutover");
});

test("9. a second migration run is idempotent and byte-for-byte unchanged", async () => {
  const store = makeStore([
    primaryRow(SYNRAPAY, "IGQV-a"),
    primaryRow(VIBEBLING_A, "IGQV-b"),
  ]);

  const first = await rotation.rotateInstagramTokens(store, STAGED_RING);
  assert.equal(first.migrated, 2);
  const afterFirst = structuredClone(store.state);

  const second = await rotation.rotateInstagramTokens(store, STAGED_RING);
  assert.deepEqual(second, {
    scanned: 2,
    migratable: 0,
    migrated: 0,
    alreadyOnNext: 2,
    failed: 0,
  });
  assert.deepEqual(store.state, afterFirst);
  assert.deepEqual(store.writes, [SYNRAPAY, VIBEBLING_A]);
});

test("10. an undecryptable row is failed and left byte-for-byte untouched", async () => {
  const good = primaryRow(SYNRAPAY, "IGQV-good");
  const orphan = { ownerUserId: VIBEBLING_A, ...crypto.encryptInstagramToken("IGQV-orphan", OTHER_KEY) };
  const store = makeStore([good, orphan]);
  const beforeOrphan = structuredClone(store.state[1]);

  const outcome = await rotation.rotateInstagramTokens(store, STAGED_RING);

  assert.equal(outcome.migrated, 1);
  assert.equal(outcome.failed, 1);
  assert.deepEqual(store.state[1], beforeOrphan);
  assert.equal(crypto.decryptInstagramToken(store.state[0], NEW_ONLY), "IGQV-good");
});

test("a per-row RPC failure is counted failed and preserves the original row", async () => {
  const store = makeStore([primaryRow(SYNRAPAY, "IGQV-atomic")]);
  const before = structuredClone(store.state);
  store.writeRow = async () => { throw new Error("database unavailable"); };

  const outcome = await rotation.rotateInstagramTokens(store, STAGED_RING);
  assert.equal(outcome.migrated, 0);
  assert.equal(outcome.failed, 1);
  assert.deepEqual(store.state, before);
});

test("a v1 PRIMARY row is normalized directly to explicit staged v3", () => {
  const row = { ownerUserId: SYNRAPAY, ...legacyEncrypt("IGQV-v1-primary", OLD_KEY) };
  const plan = rotation.planRowRotation(row, STAGED_RING);
  assert.equal(plan.result, "migratable");
  assert.equal(plan.next.keyVersion, crypto.STAGED_KEY_VERSION);
  assert.match(plan.next.encryptedToken, /^v3:[A-Za-z0-9_-]{22}:/);
  assert.equal(crypto.decryptInstagramToken(plan.next, NEW_ONLY), "IGQV-v1-primary");
});

test("a NEXT-encrypted row with an older marker is normalized to explicit staged v3", () => {
  const nextV2 = crypto.encryptInstagramToken("IGQV-next-v2", NEW_ONLY);
  const plan = rotation.planRowRotation({ ownerUserId: SYNRAPAY, ...nextV2 }, STAGED_RING);
  assert.equal(plan.result, "migratable");
  assert.equal(plan.next.keyVersion, crypto.STAGED_KEY_VERSION);
  assert.match(plan.next.encryptedToken, /^v3:[A-Za-z0-9_-]{22}:/);
});

// ---------------------------------------------------------------------------
// Refusal and non-disclosure
// ---------------------------------------------------------------------------

test("11. NEXT absent (or equal to PRIMARY) refuses before scanning rows", async () => {
  let scans = 0;
  const store = {
    async listRows() { scans += 1; return []; },
    async writeRow() { assert.fail("must not write"); },
  };

  for (const ring of [OLD_ONLY, { primary: OLD_KEY, next: OLD_KEY, legacy: [] }]) {
    await assert.rejects(
      rotation.rotateInstagramTokens(store, ring),
      (error) => error instanceof rotation.InstagramStagedRotationConfigurationError,
    );
  }
  assert.equal(scans, 0);
});

test("12. outcomes, public responses, errors and logs never expose secrets or row bytes", async () => {
  const plaintext = "IGQV-super-secret-token";
  const sourceRow = primaryRow(SYNRAPAY, plaintext);
  const store = makeStore([sourceRow]);
  const outcome = await rotation.rotateInstagramTokens(store, STAGED_RING, { dryRun: true });
  // Simulate accidental extra properties on an internal object: the public
  // allowlist must still discard all of them.
  outcome.plaintext = plaintext;
  outcome.encryptedToken = sourceRow.encryptedToken;
  outcome.primary = OLD_KEY;
  outcome.next = NEW_KEY;
  const response = rotation.publicRotationResult(outcome, true);
  const serialized = JSON.stringify(response);

  assert.deepEqual(Object.keys(response).sort(), ["alreadyOnNext", "failed", "migratable", "scanned"]);
  for (const secret of [plaintext, sourceRow.encryptedToken, OLD_KEY, NEW_KEY, LEGACY_KEY]) {
    assert.ok(!serialized.includes(secret));
  }

  const bogus = { encryptedToken: "v3:AAAAAAAAAAAAAAAAAAAAAA:bm90LXJlYWw=", iv: "AAAAAAAAAAAAAAAA", authTag: "AAAAAAAAAAAAAAAAAAAAAA==" };
  try {
    crypto.decryptInstagramToken(bogus, STAGED_RING);
    assert.fail("should throw");
  } catch (error) {
    const text = `${error.message}${error.stack}${JSON.stringify(Object.entries(error))}`;
    for (const secret of [plaintext, OLD_KEY, NEW_KEY, bogus.encryptedToken]) assert.ok(!text.includes(secret));
  }

  for (const path of [
    "lib/instagram/crypto.ts",
    "lib/instagram/key-rotation.ts",
    "app/api/admin/instagram/rotate-token-key/route.ts",
  ]) {
    assert.doesNotMatch(await read(path), /console\.(?:log|info|warn|error)/);
  }
});

// ---------------------------------------------------------------------------
// Configuration, endpoint and existing 0023 database support
// ---------------------------------------------------------------------------

test("all normal token call sites pass the PRIMARY/NEXT/LEGACY key ring", async () => {
  for (const path of [
    "app/api/integrations/instagram/callback/route.ts",
    "app/api/integrations/instagram/insights/route.ts",
  ]) {
    const source = await read(path);
    assert.match(source, /instagramKeyRing\(config\)/, `${path} must use the key ring`);
    assert.doesNotMatch(source, /config\.encryptionKey/, `${path} must not bypass the key ring`);
  }
});

test("NEXT is optional, server-only and distinct from LEGACY", async () => {
  const config = await read("lib/instagram/config.ts");
  const example = await read(".env.example");

  assert.match(config, /import "server-only"/);
  assert.match(config, /INSTAGRAM_TOKEN_ENCRYPTION_KEY_NEXT/);
  assert.match(config, /INSTAGRAM_TOKEN_ENCRYPTION_KEY_LEGACY/);
  assert.match(example, /^INSTAGRAM_TOKEN_ENCRYPTION_KEY_NEXT=$/m);
  assert.match(example, /^INSTAGRAM_TOKEN_ENCRYPTION_KEY_LEGACY=$/m);
  assert.match(example, /^INSTAGRAM_KEY_ROTATION_SECRET=$/m);
  assert.doesNotMatch(`${config}\n${example}`, /NEXT_PUBLIC_INSTAGRAM_TOKEN_ENCRYPTION/);
});

test("the protected endpoint rejects missing NEXT before creating a store", async () => {
  const route = await read("app/api/admin/instagram/rotate-token-key/route.ts");
  assert.match(route, /INSTAGRAM_KEY_ROTATION_SECRET/);
  assert.match(route, /bearerMatches\(request, secret\)/);
  const bearer = await read("utils/bearer-auth.ts");
  assert.match(bearer, /Bearer \$\{secret\}/, "the shared helper compares the full Bearer header");
  assert.match(bearer, /timingSafeEqual/, "the shared helper compares in constant time");
  assert.match(route, /!config\.nextEncryptionKey \|\| config\.nextEncryptionKey === config\.encryptionKey/);
  assert.ok(
    route.indexOf("if (!config.nextEncryptionKey") < route.indexOf("createRotationStore(createAdminClient())"),
    "NEXT must be validated before rows are scanned",
  );
  assert.match(route, /publicRotationResult\(outcome, dryRun\)/);
  assert.match(route, /runtime = "nodejs"/);
  assert.match(route, /Cache-Control/);
});

test("rotation uses only 0023 service-role security-definer RPCs", async () => {
  const source = await read("lib/instagram/key-rotation.ts");
  assert.match(source, /import "server-only"/);
  assert.match(source, /list_instagram_connection_secrets/);
  assert.match(source, /update_instagram_connection_secret/);
  assert.doesNotMatch(source, /from\("instagram_connection_secrets"\)/);
});

test("live migration 0023 already provides atomic row updates and keeps secret protections", async () => {
  const sql = await read("supabase/migrations/0023_instagram_token_key_rotation.sql");
  assert.match(sql, /begin;[\s\S]*commit;/);
  assert.match(sql, /create or replace function public\.list_instagram_connection_secrets/);
  assert.match(sql, /create or replace function public\.update_instagram_connection_secret/);
  assert.match(sql, /p_key_version smallint default 1/);
  assert.match(sql, /key_version = coalesce\(p_key_version, 1\)/);

  for (const fn of [
    "list_instagram_connection_secrets\\(\\)",
    "update_instagram_connection_secret\\(uuid, text, text, text, smallint\\)",
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn} from public, anon, authenticated`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn} to service_role`));
  }
  assert.match(sql, /security definer[\s\S]*?set search_path = ''/);
  assert.doesNotMatch(sql, /grant[^;]*on table public\.instagram_connection_secrets/i);
  assert.match(sql, /Instagram secret RLS must remain enabled/);

  const updateFn = sql.slice(sql.indexOf("create or replace function public.update_instagram_connection_secret"));
  const body = updateFn.slice(0, updateFn.indexOf("$$;"));
  for (const column of ["username", "scopes", "status", "token_expires_at"]) {
    assert.ok(!body.includes(column), `secret update must not touch ${column}`);
  }
});

test("live 0023 is not modified; 0024-0027 remain intact; 0028 is OpenRouter video metadata", async () => {
  const files = await readdir(new URL("supabase/migrations/", root));
  assert.deepEqual(files.filter((name) => /^002[3-9]/.test(name)).sort(), [
    "0023_instagram_token_key_rotation.sql",
    "0024_instagram_story_publishing.sql",
    "0025_mara_media_video_generation.sql",
    "0026_mara_media_brief.sql",
    "0027_mara_media_provider_diagnostics.sql",
    "0028_openrouter_video_job_metadata.sql",
    "0029_workflow_timezone_and_slots.sql",
  ]);
  const keyRotation = await read("supabase/migrations/0023_instagram_token_key_rotation.sql");
  assert.doesNotMatch(keyRotation, /instagram_publish_/);
  // 0024 never touches the key-rotation surface either.
  const stories = await read("supabase/migrations/0024_instagram_story_publishing.sql");
  for (const guarded of [
    "save_instagram_connection",
    "list_instagram_connection_secrets",
    "update_instagram_connection_secret",
    "instagram_connection_secrets",
  ]) {
    assert.doesNotMatch(stories, new RegExp(guarded), `0024 must not touch ${guarded}`);
  }
});
