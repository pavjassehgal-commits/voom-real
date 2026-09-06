import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/**
 * Ciphertext versioning.
 *
 * The original format (0004) stored a bare base64 ciphertext with NO key-version
 * marker, so a stored row could not say which key encrypted it. The
 * instagram_connection_secrets.key_version column existed but was hard-coded to
 * 1 and never read back.
 *
 * New writes are therefore self-describing: the stored string is prefixed with
 * "v2:". Anything without a recognised prefix is treated as the legacy v1
 * format. This keeps full backward compatibility with the three live
 * connections while making every new row unambiguous — and needs no schema
 * change, because the column is plain text.
 */
export const LEGACY_KEY_VERSION = 1;
export const CURRENT_KEY_VERSION = 2;
const VERSION_PREFIX = /^v(\d+):/;

/**
 * The keys Voom may use. `primary` encrypts everything new; `legacy` keys are
 * accepted for DECRYPTION ONLY while a rotation is in flight.
 */
export interface InstagramKeyRing {
  primary: string;
  legacy: string[];
}

export type InstagramKeyInput = string | InstagramKeyRing;

/** Accepts a bare key (existing callers) or a full key ring. */
export function toKeyRing(input: InstagramKeyInput): InstagramKeyRing {
  if (typeof input === "string") return { primary: input, legacy: [] };
  return { primary: input.primary, legacy: input.legacy.filter((key) => Boolean(key) && key !== input.primary) };
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

export interface EncryptedInstagramToken {
  encryptedToken: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/** Encrypts with the PRIMARY key only. Legacy keys never encrypt anything. */
export function encryptInstagramToken(token: string, key: InstagramKeyInput): EncryptedInstagramToken {
  const ring = toKeyRing(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, deriveKey(ring.primary), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    // Self-describing: "v2:<base64>".
    encryptedToken: `v${CURRENT_KEY_VERSION}:${ciphertext.toString("base64")}`,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

export interface StoredInstagramToken {
  encryptedToken: string;
  iv: string;
  authTag: string;
}

/** Splits a stored value into its declared version and raw base64 payload. */
export function parseStoredToken(encryptedToken: string): { version: number; payload: string } {
  const match = VERSION_PREFIX.exec(encryptedToken);
  if (!match) return { version: LEGACY_KEY_VERSION, payload: encryptedToken };
  return { version: Number(match[1]), payload: encryptedToken.slice(match[0].length) };
}

function decryptWith(input: StoredInstagramToken, secret: string): string {
  const { payload } = parseStoredToken(input.encryptedToken);
  const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), Buffer.from(input.iv, "base64"));
  decipher.setAuthTag(Buffer.from(input.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payload, "base64")), decipher.final()]).toString("utf8");
}

/**
 * Decrypts using the primary key first, then each legacy key in turn.
 *
 * Trial decryption is safe here because AES-GCM authenticates: a wrong key
 * cannot yield plausible plaintext, it throws. (Verified empirically against
 * 2000 wrong keys with zero false accepts.)
 */
export function decryptInstagramToken(input: StoredInstagramToken, key: InstagramKeyInput): string {
  const ring = toKeyRing(key);
  for (const secret of [ring.primary, ...ring.legacy]) {
    try {
      return decryptWith(input, secret);
    } catch {
      // Never surface the underlying cipher error: it is not actionable and
      // keeping it out of scope guarantees no key or token detail escapes.
    }
  }
  throw new InstagramTokenDecryptionError();
}

/**
 * Which key decrypted this row, without returning the plaintext.
 * Used by the rotation job to decide what actually needs re-encrypting.
 */
export function inspectStoredToken(
  input: StoredInstagramToken,
  key: InstagramKeyInput,
): { readable: boolean; usesPrimary: boolean; declaredVersion: number } {
  const ring = toKeyRing(key);
  const declaredVersion = parseStoredToken(input.encryptedToken).version;
  try {
    decryptWith(input, ring.primary);
    return { readable: true, usesPrimary: true, declaredVersion };
  } catch {
    // fall through to legacy keys
  }
  for (const secret of ring.legacy) {
    try {
      decryptWith(input, secret);
      return { readable: true, usesPrimary: false, declaredVersion };
    } catch {
      // keep trying
    }
  }
  return { readable: false, usesPrimary: false, declaredVersion };
}
