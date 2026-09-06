import "server-only";

import { z } from "zod";

import type { InstagramKeyRing } from "./crypto";

const configSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  graphVersion: z.string().regex(/^v\d+\.\d+$/),
  redirectUri: z.string().url(),
  encryptionKey: z.string().min(32),
  /**
   * Future primary used only as the staged rotation target. It is also a read
   * fallback so migrated rows work before cutover. Optional in steady state.
   */
  nextEncryptionKey: z.string().min(32).optional(),
  /**
   * Historical keys accepted for DECRYPTION ONLY. They are not needed for a
   * staged PRIMARY -> NEXT rotation because PRIMARY remains available.
   */
  legacyEncryptionKeys: z.array(z.string().min(32)).default([]),
});

export type InstagramConfig = z.infer<typeof configSchema>;

export function readInstagramConfig(): InstagramConfig | null {
  const parsed = configSchema.safeParse({
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    graphVersion: process.env.META_GRAPH_VERSION,
    redirectUri: process.env.META_INSTAGRAM_REDIRECT_URI,
    encryptionKey: process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY,
    nextEncryptionKey: optionalValue(process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY_NEXT),
    legacyEncryptionKeys: parseLegacyKeys(process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY_LEGACY),
  });
  return parsed.success ? parsed.data : null;
}

function optionalValue(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** Splits the comma-separated legacy key list, ignoring blanks. */
function parseLegacyKeys(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((key) => key.trim()).filter(Boolean);
}

/**
 * Read order is PRIMARY -> NEXT -> LEGACY. Normal encryption still uses only
 * `primary`; NEXT is never promoted implicitly.
 */
export function instagramKeyRing(config: InstagramConfig): InstagramKeyRing {
  const next = config.nextEncryptionKey && config.nextEncryptionKey !== config.encryptionKey
    ? config.nextEncryptionKey
    : undefined;
  const excluded = new Set([config.encryptionKey, ...(next ? [next] : [])]);
  const legacy = config.legacyEncryptionKeys.filter((key) => !excluded.has(key));
  return next
    ? { primary: config.encryptionKey, next, legacy }
    : { primary: config.encryptionKey, legacy };
}

export function requireInstagramConfig() {
  const config = readInstagramConfig();
  if (!config) throw new InstagramConfigurationError();
  return config;
}

export class InstagramConfigurationError extends Error {
  constructor() { super("instagram_not_configured"); }
}
