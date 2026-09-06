import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const crypto = await import("../lib/instagram/crypto.ts");
const rotation = await import("../lib/instagram/key-rotation.ts");

const OLD_KEY = "legacy-instagram-key-000000000000000000";
const NEW_KEY = "primary-instagram-key-11111111111111111";
const OTHER_KEY = "unrelated-instagram-key-2222222222222222";

const RING = { primary: NEW_KEY, legacy: [OLD_KEY] };
const PRIMARY_ONLY = { primary: NEW_KEY, legacy: [] };

const SYNRAPAY = "11111111-1111-4111-8111-111111111111";
const VIBEBLING_A = "22222222-2222-4222-8222-222222222222";
const VIBEBLING_B = "33333333-3333-4333-8333-333333333333";

/** The exact pre-rotation on-disk format: bare base64, no version prefix. */
function legacyEncrypt(token, key) {
  const blob = crypto.encryptInstagramToken(token, { primary: key, legacy: [] });
  const { payload } = crypto.parseStoredToken(blob.encryptedToken);
  return { encryptedToken: payload, iv: blob.iv, authTag: blob.authTag };
}

// ---------------------------------------------------------------------------
// Dual-key reads and writes
// ---------------------------------------------------------------------------

test("a token encrypted with the new primary key decrypts", () => {
  const blob = crypto.encryptInstagramToken("IGQV-token-new", RING);
  assert.equal(crypto.decryptInstagramToken(blob, RING), "IGQV-token-new");
  // and with the primary key alone, which is the post-rotation steady state
  assert.equal(crypto.decryptInstagramToken(blob, PRIMARY_ONLY), "IGQV-token-new");
});

test("a legacy token decrypts via the fallback key", () => {
  const stored = legacyEncrypt("IGQV-token-vibebling", OLD_KEY);
  // The legacy row has no version marker at all.
  assert.equal(crypto.parseStoredToken(stored.encryptedToken).version, crypto.LEGACY_KEY_VERSION);
  assert.equal(crypto.decryptInstagramToken(stored, RING), "IGQV-token-vibebling");
});

test("a legacy token is unreadable once the legacy key is removed", () => {
  const stored = legacyEncrypt("IGQV-token-vibebling", OLD_KEY);
  assert.throws(
    () => crypto.decryptInstagramToken(stored, PRIMARY_ONLY),
    (error) => error instanceof crypto.InstagramTokenDecryptionError,
  );
});

test("new writes always use the primary key, never a legacy key", () => {
  const blob = crypto.encryptInstagramToken("IGQV-fresh", RING);
  assert.equal(blob.keyVersion, crypto.CURRENT_KEY_VERSION);
  assert.match(blob.encryptedToken, /^v2:/);
  // Provably not encrypted under the legacy key.
  assert.throws(() => crypto.decryptInstagramToken(blob, { primary: OLD_KEY, legacy: [] }));
  assert.equal(crypto.decryptInstagramToken(blob, PRIMARY_ONLY), "IGQV-fresh");
});

test("a bare string key still works, so existing call sites keep functioning", () => {
  const blob = crypto.encryptInstagramToken("IGQV-compat", NEW_KEY);
  assert.equal(crypto.decryptInstagramToken(blob, NEW_KEY), "IGQV-compat");
  assert.deepEqual(crypto.toKeyRing(NEW_KEY), { primary: NEW_KEY, legacy: [] });
});

test("a key listed as both primary and legacy is not tried twice", () => {
  const ring = crypto.toKeyRing({ primary: NEW_KEY, legacy: [NEW_KEY, OLD_KEY] });
  assert.deepEqual(ring.legacy, [OLD_KEY]);
});

// ---------------------------------------------------------------------------
// Failing safely
// ---------------------------------------------------------------------------

test("unknown ciphertext fails safely with a typed error and no detail", () => {
  const bogus = { encryptedToken: "v2:bm90LXJlYWwtY2lwaGVy", iv: "AAAAAAAAAAAAAAAA", authTag: "AAAAAAAAAAAAAAAAAAAAAA==" };
  assert.throws(
    () => crypto.decryptInstagramToken(bogus, RING),
    (error) => {
      assert.ok(error instanceof crypto.InstagramTokenDecryptionError);
      assert.equal(error.code, "instagram_token_undecryptable");
      return true;
    },
  );
});

test("garbage input never returns plausible plaintext under a wrong key", () => {
  const stored = legacyEncrypt("IGQV-real-token", OLD_KEY);
  let falseAccepts = 0;
  for (let index = 0; index < 500; index++) {
    try {
      crypto.decryptInstagramToken(stored, { primary: `wrong-key-${index}-aaaaaaaaaaaaaaaaaaaaaaaa`, legacy: [] });
      falseAccepts += 1;
    } catch {
      // expected: AES-GCM authenticates
    }
  }
  assert.equal(falseAccepts, 0, "AES-GCM must make trial decryption safe");
});

test("no error ever carries token plaintext or key material", () => {
  const token = "IGQV-super-secret-token-value";
  const stored = legacyEncrypt(token, OLD_KEY);
  try {
    crypto.decryptInstagramToken(stored, { primary: OTHER_KEY, legacy: [] });
    assert.fail("should have thrown");
  } catch (error) {
    const text = `${error.message}${error.stack}${JSON.stringify(Object.entries(error))}`;
    assert.ok(!text.includes(token), "the token must never appear in an error");
    assert.ok(!text.includes(OLD_KEY) && !text.includes(OTHER_KEY), "no key may appear in an error");
    assert.ok(!text.includes(stored.encryptedToken), "ciphertext must not appear either");
  }
});

// ---------------------------------------------------------------------------
// Re-encryption
// ---------------------------------------------------------------------------

/** In-memory store mirroring the production RPC store. */
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

function legacyRow(ownerUserId, token) {
  return { ownerUserId, ...legacyEncrypt(token, OLD_KEY) };
}

test("migration converts legacy rows onto the primary key and preserves the token", async () => {
  const tokens = {
    [SYNRAPAY]: "IGQV-synrapay-token",
    [VIBEBLING_A]: "IGQV-vibebling-a-token",
    [VIBEBLING_B]: "IGQV-vibebling-b-token",
  };
  const store = makeStore(Object.entries(tokens).map(([owner, token]) => legacyRow(owner, token)));

  const outcome = await rotation.rotateInstagramTokens(store, RING);

  assert.deepEqual(
    { scanned: outcome.scanned, migrated: outcome.migrated, alreadyCurrent: outcome.alreadyCurrent, failed: outcome.failed },
    { scanned: 3, migrated: 3, alreadyCurrent: 0, failed: 0 },
  );

  // Every row now reads under the PRIMARY key alone, and the plaintext survived.
  for (const row of store.state) {
    assert.equal(row.keyVersion, crypto.CURRENT_KEY_VERSION);
    assert.match(row.encryptedToken, /^v2:/);
    assert.equal(crypto.decryptInstagramToken(row, PRIMARY_ONLY), tokens[row.ownerUserId]);
  }
});

test("migration is idempotent: a second run changes nothing", async () => {
  const store = makeStore([legacyRow(SYNRAPAY, "IGQV-a"), legacyRow(VIBEBLING_A, "IGQV-b")]);

  const first = await rotation.rotateInstagramTokens(store, RING);
  assert.equal(first.migrated, 2);
  const afterFirst = store.state.map((row) => ({ ...row }));

  const second = await rotation.rotateInstagramTokens(store, RING);
  assert.deepEqual(
    { migrated: second.migrated, alreadyCurrent: second.alreadyCurrent, failed: second.failed },
    { migrated: 0, alreadyCurrent: 2, failed: 0 },
  );
  // Byte-for-byte untouched, and no further writes were issued.
  assert.deepEqual(store.state, afterFirst);
  assert.deepEqual(store.writes, [SYNRAPAY, VIBEBLING_A]);
});

test("a row that no key can decrypt is reported failed and left intact", async () => {
  const good = legacyRow(SYNRAPAY, "IGQV-good");
  const orphan = { ownerUserId: VIBEBLING_A, ...legacyEncrypt("IGQV-orphan", OTHER_KEY) };
  const store = makeStore([good, orphan]);
  const before = store.state.map((row) => ({ ...row }));

  const outcome = await rotation.rotateInstagramTokens(store, RING);

  assert.deepEqual(
    { scanned: outcome.scanned, migrated: outcome.migrated, alreadyCurrent: outcome.alreadyCurrent, failed: outcome.failed },
    { scanned: 2, migrated: 1, alreadyCurrent: 0, failed: 1 },
  );
  assert.deepEqual(outcome.failedOwnerIds, [VIBEBLING_A]);

  // The undecryptable row is byte-for-byte unchanged — never destroyed.
  const after = store.state.find((row) => row.ownerUserId === VIBEBLING_A);
  const originalOrphan = before.find((row) => row.ownerUserId === VIBEBLING_A);
  assert.deepEqual(after, originalOrphan);
  // The healthy row still migrated.
  assert.equal(crypto.decryptInstagramToken(store.state.find((r) => r.ownerUserId === SYNRAPAY), PRIMARY_ONLY), "IGQV-good");
});

test("a write failure is counted as failed and never loses the original token", async () => {
  const store = makeStore([legacyRow(SYNRAPAY, "IGQV-a")]);
  const before = store.state.map((row) => ({ ...row }));
  store.writeRow = async () => { throw new Error("database unavailable"); };

  const outcome = await rotation.rotateInstagramTokens(store, RING);
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.migrated, 0);
  assert.deepEqual(store.state, before, "the original ciphertext must survive a failed write");
});

test("rotation reports counts and owner ids only — never secrets", async () => {
  const token = "IGQV-secret-value-must-not-leak";
  const store = makeStore([legacyRow(SYNRAPAY, token), { ownerUserId: VIBEBLING_A, ...legacyEncrypt("x", OTHER_KEY) }]);
  const outcome = await rotation.rotateInstagramTokens(store, RING);

  const serialized = JSON.stringify(outcome);
  assert.ok(!serialized.includes(token));
  assert.ok(!serialized.includes(OLD_KEY) && !serialized.includes(NEW_KEY) && !serialized.includes(OTHER_KEY));
  for (const row of store.state) assert.ok(!serialized.includes(row.encryptedToken));
  assert.deepEqual(Object.keys(outcome).sort(), ["alreadyCurrent", "failed", "failedOwnerIds", "migrated", "scanned"]);
});

test("a v1-prefixed row already on the primary key is still upgraded to v2", () => {
  // Readable with the primary key but not yet self-describing: must be rewritten
  // so the stored format becomes unambiguous.
  const blob = crypto.encryptInstagramToken("IGQV-x", PRIMARY_ONLY);
  const { payload } = crypto.parseStoredToken(blob.encryptedToken);
  const plan = rotation.planRowRotation(
    { ownerUserId: SYNRAPAY, encryptedToken: payload, iv: blob.iv, authTag: blob.authTag },
    RING,
  );
  assert.equal(plan.result, "migrated");
  assert.match(plan.next.encryptedToken, /^v2:/);
});

test("planRowRotation verifies the new ciphertext before proposing a write", () => {
  const row = legacyRow(SYNRAPAY, "IGQV-verify-me");
  const plan = rotation.planRowRotation(row, RING);
  assert.equal(plan.result, "migrated");
  // The proposed value must already be readable under the primary key alone.
  assert.equal(crypto.decryptInstagramToken(plan.next, PRIMARY_ONLY), "IGQV-verify-me");
  assert.equal(plan.next.keyVersion, crypto.CURRENT_KEY_VERSION);
});

// ---------------------------------------------------------------------------
// Wiring, config and the protected entry point
// ---------------------------------------------------------------------------

test("every token call site passes the full key ring, not a bare primary key", async () => {
  for (const path of [
    "app/api/integrations/instagram/callback/route.ts",
    "app/api/integrations/instagram/insights/route.ts",
  ]) {
    const source = await read(path);
    assert.match(source, /instagramKeyRing\(config\)/, `${path} must use the key ring`);
    assert.doesNotMatch(source, /config\.encryptionKey/, `${path} must not use the bare key`);
  }
});

test("the legacy key is read from its own env var and never exposed to the browser", async () => {
  const config = await read("lib/instagram/config.ts");
  assert.match(config, /import "server-only"/);
  assert.match(config, /INSTAGRAM_TOKEN_ENCRYPTION_KEY_LEGACY/);
  assert.doesNotMatch(config, /NEXT_PUBLIC_INSTAGRAM_TOKEN_ENCRYPTION_KEY/);
  const example = await read(".env.example");
  assert.match(example, /^INSTAGRAM_TOKEN_ENCRYPTION_KEY_LEGACY=$/m);
  assert.match(example, /^INSTAGRAM_KEY_ROTATION_SECRET=$/m);
  assert.doesNotMatch(example, /NEXT_PUBLIC_INSTAGRAM_TOKEN_ENCRYPTION_KEY/);
});

test("the rotation endpoint is disabled by default and secret-protected", async () => {
  const route = await read("app/api/admin/instagram/rotate-token-key/route.ts");
  assert.match(route, /INSTAGRAM_KEY_ROTATION_SECRET/);
  assert.match(route, /status: 503/);
  assert.match(route, /Bearer \$\{secret\}/);
  assert.match(route, /status: 401/);
  assert.match(route, /runtime = "nodejs"/);
  assert.match(route, /dryRun/);
  // It must never echo secrets back. Check the response payload construction,
  // not comments: the body spreads the rotation outcome (counts + owner ids)
  // and a legacy-key COUNT, never key material or ciphertext.
  const body = route.slice(route.indexOf("return Response.json("));
  assert.match(body, /\.\.\.outcome/);
  assert.match(body, /legacyKeysConfigured: keyRing\.legacy\.length/);
  assert.doesNotMatch(body, /keyRing\.primary|keyRing\.legacy\[|encryptedToken|accessToken/);
});

test("rotation reaches secrets only through service-role security-definer RPCs", async () => {
  const source = await read("lib/instagram/key-rotation.ts");
  assert.match(source, /import "server-only"/);
  assert.match(source, /list_instagram_connection_secrets/);
  assert.match(source, /update_instagram_connection_secret/);
  // 0005 revokes direct table access, so nothing may query the table directly.
  assert.doesNotMatch(source, /from\("instagram_connection_secrets"\)/);
});

test("migration 0023 adds rotation RPCs without weakening secret protections", async () => {
  const sql = await read("supabase/migrations/0023_instagram_token_key_rotation.sql");
  assert.match(sql, /PREPARED FOR REVIEW/i);
  assert.match(sql, /begin;[\s\S]*commit;/);

  assert.match(sql, /create or replace function public\.list_instagram_connection_secrets/);
  assert.match(sql, /create or replace function public\.update_instagram_connection_secret/);
  assert.match(sql, /p_key_version smallint default 1/);

  for (const fn of [
    "list_instagram_connection_secrets\\(\\)",
    "update_instagram_connection_secret\\(uuid, text, text, text, smallint\\)",
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn} from public, anon, authenticated`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn} to service_role`));
  }
  assert.match(sql, /security definer[\s\S]*?set search_path = ''/);

  // The 0005 invariant must survive: no direct table grants are handed out.
  assert.doesNotMatch(sql, /grant[^;]*on table public\.instagram_connection_secrets/i);
  assert.match(sql, /Instagram secret RLS must remain enabled/);

  // Metadata must be untouchable by the secret-update path.
  const updateFn = sql.slice(sql.indexOf("create or replace function public.update_instagram_connection_secret"));
  const body = updateFn.slice(0, updateFn.indexOf("$$;"));
  for (const column of ["username", "scopes", "status", "token_expires_at"]) {
    assert.ok(!body.includes(column), `update_instagram_connection_secret must not touch ${column}`);
  }
});

test("0023 is the only new migration and 0022 is left untouched", async () => {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(new URL("supabase/migrations/", root));
  assert.deepEqual(
    files.filter((name) => /^002[3-9]_/.test(name)),
    ["0023_instagram_token_key_rotation.sql"],
  );
  const sql = await read("supabase/migrations/0023_instagram_token_key_rotation.sql");
  // 0023 must not depend on anything the auto-publishing migration (0022)
  // introduces. Every 0022 object is named after instagram_publish_*, so
  // requiring none of that namespace here proves independence from 0022.
  assert.doesNotMatch(sql, /instagram_publish_/);
});
