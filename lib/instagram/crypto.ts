import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/**
 * Ciphertext and key-generation versioning.
 *
 * v1 is the original bare-base64 format. v2 is the self-describing format
 * introduced by the first key-rotation change; normal application writes keep
 * using v2 and always encrypt with PRIMARY. v3 is reserved for staged-rotation
 * output and includes a non-secret, deterministic key identifier. That makes a
 * staged row unambiguously attributable to the exact NEXT key without changing
 * the existing database schema. Existing v1 and v2 values remain readable.
 */
export const LEGACY_KEY_VERSION = 1;
export const CURRENT_KEY_VERSION = 2;
export const STAGED_KEY_VERSION = 3;
const VERSION_PREFIX = /^v(\d+):/;
const STAGED_PREFIX = /^v3:([A-Za-z0-9_-]{22}):/;

/**
 * The keys Voom may use. `primary` encrypts all normal writes. `next` is read
 * fallback plus the staged rotation target. `legacy` keys are decryption-only.
 */
export interface InstagramKeyRing {
  primary: string;
  next?: string;
  legacy: string[];
}

export type InstagramKeyInput = string | InstagramKeyRing;

/** Accepts a bare key (existing callers) or a full, de-duplicated key ring. */
export function toKeyRing(input: InstagramKeyInput): InstagramKeyRing {
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
 * Raised when no available key could authenticate the ciphertext.
 *
 * Deliberately carries a fixed code and no provider detail, no key material and
 * no token bytes, so it is safe to log and safe to surface.
 */
export class InstagramTokenDecryptionError extends Error {
  readonly code = "instagram_token_undecryptable";
  constructor() {
    super("instagram_token_undecryptable");
    this.name = "InstagramTokenDecryptionError";
  }
}

function deriveKey(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * A stable 132-bit identifier for matching a v3 value to a configured key.
 * This is not key material and is never returned by the rotation endpoint.
 * Ciphertext plus its GCM tag already permits validation of a guessed key, so
 * this identifier does not weaken a securely generated encryption key.
 */
function keyIdentifier(secret: string) {
  return createHash("sha256")
    .update("voom-instagram-key-id\0", "utf8")
    .update(deriveKey(secret))
    .digest("base64url")
    .slice(0, 22);
}

export interface EncryptedInstagramToken {
  encryptedToken: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

function encryptWithVersion(token: string, secret: string, version: typeof CURRENT_KEY_VERSION | typeof STAGED_KEY_VERSION): EncryptedInstagramToken {
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

/**
 * Encrypts a normal OAuth/token write with PRIMARY only. NEXT and legacy keys
 * never affect normal encryption, including while a staged rotation is active.
 */
export function encryptInstagramToken(token: string, key: InstagramKeyInput): EncryptedInstagramToken {
  return encryptWithVersion(token, toKeyRing(key).primary, CURRENT_KEY_VERSION);
}

/** Encrypts rotation output with NEXT specifically and marks it as staged v3. */
export function encryptInstagramTokenForStagedRotation(token: string, nextKey: string): EncryptedInstagramToken {
  return encryptWithVersion(token, nextKey, STAGED_KEY_VERSION);
}

export interface StoredInstagramToken {
  encryptedToken: string;
  iv: string;
  authTag: string;
}

/** Splits a stored value into its declared version, key id and raw payload. */
export function parseStoredToken(encryptedToken: string): { version: number; keyId: string | null; payload: string } {
  const staged = STAGED_PREFIX.exec(encryptedToken);
  if (staged) {
    return {
      version: STAGED_KEY_VERSION,
      keyId: staged[1],
      payload: encryptedToken.slice(staged[0].length),
    };
  }
  const match = VERSION_PREFIX.exec(encryptedToken);
  if (!match) return { version: LEGACY_KEY_VERSION, keyId: null, payload: encryptedToken };
  return { version: Number(match[1]), keyId: null, payload: encryptedToken.slice(match[0].length) };
}

function decryptWith(input: StoredInstagramToken, secret: string): string {
  const parsed = parseStoredToken(input.encryptedToken);
  if (parsed.version === STAGED_KEY_VERSION && parsed.keyId !== keyIdentifier(secret)) {
    throw new Error("key_mismatch");
  }
  const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), Buffer.from(input.iv, "base64"));
  decipher.setAuthTag(Buffer.from(input.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(parsed.payload, "base64")), decipher.final()]).toString("utf8");
}

function keyCandidates(ring: InstagramKeyRing): Array<{ source: "primary" | "next" | "legacy"; secret: string }> {
  return [
    { source: "primary", secret: ring.primary },
    ...(ring.next ? [{ source: "next" as const, secret: ring.next }] : []),
    ...ring.legacy.map((secret) => ({ source: "legacy" as const, secret })),
  ];
}

/**
 * Decrypts in the safe intermediate-state order: PRIMARY, NEXT, then LEGACY.
 * AES-GCM authentication makes fallback attempts fail closed under a wrong key.
 */
export function decryptInstagramToken(input: StoredInstagramToken, key: InstagramKeyInput): string {
  const ring = toKeyRing(key);
  for (const { secret } of keyCandidates(ring)) {
    try {
      return decryptWith(input, secret);
    } catch {
      // Never surface cipher errors, key identifiers, ciphertext or plaintext.
    }
  }
  throw new InstagramTokenDecryptionError();
}

/**
 * Identifies which configured key authenticated a row without returning the
 * plaintext. Rotation uses this to recognize exact NEXT output idempotently.
 */
export function inspectStoredToken(
  input: StoredInstagramToken,
  key: InstagramKeyInput,
): {
  readable: boolean;
  usesPrimary: boolean;
  usesNext: boolean;
  keySource: "primary" | "next" | "legacy" | null;
  declaredVersion: number;
} {
  const ring = toKeyRing(key);
  const declaredVersion = parseStoredToken(input.encryptedToken).version;
  for (const candidate of keyCandidates(ring)) {
    try {
      decryptWith(input, candidate.secret);
      return {
        readable: true,
        usesPrimary: candidate.source === "primary",
        usesNext: candidate.source === "next",
        keySource: candidate.source,
        declaredVersion,
      };
    } catch {
      // Keep trying in PRIMARY -> NEXT -> LEGACY order.
    }
  }
  return { readable: false, usesPrimary: false, usesNext: false, keySource: null, declaredVersion };
}
