import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * TikTok token encryption — the same proven design as the Instagram and
 * YouTube token vaults, kept as its own module so a TikTok key compromise
 * or rotation can never touch Instagram or YouTube material and vice versa.
 *
 * AES-256-GCM with a random 96-bit IV per value. Ciphertext is
 * self-describing (`v2:<payload>`; `v3:<keyId>:<payload>` for staged
 * rotation output) and decryption tries PRIMARY -> NEXT -> LEGACY, failing
 * closed (authenticated cipher) under a wrong key. The database stores only
 * ciphertext, IV, auth tag and key version — never plaintext, never the key.
 */
const ALGORITHM = "aes-256-gcm";

export const CURRENT_KEY_VERSION = 2;
export const STAGED_KEY_VERSION = 3;
const VERSION_PREFIX = /^v(\d+):/;
const STAGED_PREFIX = /^v3:([A-Za-z0-9_-]{22}):/;

export interface TikTokKeyRing {
  primary: string;
  next?: string;
  legacy: string[];
}

export type TikTokKeyInput = string | TikTokKeyRing;

export function toKeyRing(input: TikTokKeyInput): TikTokKeyRing {
  if (typeof input === "string") return { primary: input, legacy: [] };
  const next = input.next && input.next !== input.primary ? input.next : undefined;
  const seen = new Set([input.primary, ...(next ? [next] : [])]);
  const legacy = input.legacy.filter((key) => {
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return next ? { primary: input.primary, next, legacy } : { primary: input.primary, legacy };
}

/**
 * Fixed-code decryption failure. Carries no key material, no ciphertext and
 * no plaintext, so it is safe to log and safe to surface.
 */
export class TikTokTokenDecryptionError extends Error {
  readonly code = "tiktok_token_undecryptable";
  constructor() {
    super("tiktok_token_undecryptable");
    this.name = "TikTokTokenDecryptionError";
  }
}

function deriveKey(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** Stable non-secret key identifier for staged (v3) values. */
function keyIdentifier(secret: string) {
  return createHash("sha256")
    .update("voom-tiktok-key-id\0", "utf8")
    .update(deriveKey(secret))
    .digest("base64url")
    .slice(0, 22);
}

export interface EncryptedTikTokToken {
  encryptedToken: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

function encryptWithVersion(
  token: string,
  secret: string,
  version: typeof CURRENT_KEY_VERSION | typeof STAGED_KEY_VERSION,
): EncryptedTikTokToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const payload = ciphertext.toString("base64");
  const encryptedToken = version === STAGED_KEY_VERSION
    ? `v${STAGED_KEY_VERSION}:${keyIdentifier(secret)}:${payload}`
    : `v${CURRENT_KEY_VERSION}:${payload}`;
  return {
    encryptedToken,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: version,
  };
}

/** Encrypts a normal token write with PRIMARY only. */
export function encryptTikTokToken(token: string, key: TikTokKeyInput): EncryptedTikTokToken {
  return encryptWithVersion(token, toKeyRing(key).primary, CURRENT_KEY_VERSION);
}

/** Encrypts staged-rotation output with NEXT specifically (v3 envelope). */
export function encryptTikTokTokenForStagedRotation(token: string, nextKey: string): EncryptedTikTokToken {
  return encryptWithVersion(token, nextKey, STAGED_KEY_VERSION);
}

export interface StoredTikTokToken {
  encryptedToken: string;
  iv: string;
  authTag: string;
}

export function parseStoredToken(encryptedToken: string): { version: number; keyId: string | null; payload: string } {
  const staged = STAGED_PREFIX.exec(encryptedToken);
  if (staged) {
    return { version: STAGED_KEY_VERSION, keyId: staged[1], payload: encryptedToken.slice(staged[0].length) };
  }
  const match = VERSION_PREFIX.exec(encryptedToken);
  if (!match) return { version: 1, keyId: null, payload: encryptedToken };
  return { version: Number(match[1]), keyId: null, payload: encryptedToken.slice(match[0].length) };
}

function decryptWith(input: StoredTikTokToken, secret: string): string {
  const parsed = parseStoredToken(input.encryptedToken);
  if (parsed.version === STAGED_KEY_VERSION && parsed.keyId !== keyIdentifier(secret)) {
    throw new Error("key_mismatch");
  }
  const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), Buffer.from(input.iv, "base64"));
  decipher.setAuthTag(Buffer.from(input.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(parsed.payload, "base64")), decipher.final()]).toString("utf8");
}

function keyCandidates(ring: TikTokKeyRing): Array<{ source: "primary" | "next" | "legacy"; secret: string }> {
  return [
    { source: "primary", secret: ring.primary },
    ...(ring.next ? [{ source: "next" as const, secret: ring.next }] : []),
    ...ring.legacy.map((secret) => ({ source: "legacy" as const, secret })),
  ];
}

/** Decrypts in PRIMARY -> NEXT -> LEGACY order, failing closed. */
export function decryptTikTokToken(input: StoredTikTokToken, key: TikTokKeyInput): string {
  const ring = toKeyRing(key);
  for (const { secret } of keyCandidates(ring)) {
    try {
      return decryptWith(input, secret);
    } catch {
      // Never surface cipher errors, key identifiers, ciphertext or plaintext.
    }
  }
  throw new TikTokTokenDecryptionError();
}
