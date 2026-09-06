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
   * Old keys accepted for DECRYPTION ONLY during a rotation. Comma-separated
   * so more than one historical key can be carried if ever needed. Optional:
   * absent means "no rotation in flight", which is the steady state.
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
    legacyEncryptionKeys: parseLegacyKeys(process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY_LEGACY),
  });
  return parsed.success ? parsed.data : null;
}

/** Splits the comma-separated legacy key list, ignoring blanks. */
function parseLegacyKeys(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((key) => key.trim()).filter(Boolean);
}

/**
 * The key ring used by every encrypt/decrypt call. The primary key is always
 * the one that encrypts; legacy keys only ever decrypt.
 */
export function instagramKeyRing(config: InstagramConfig): InstagramKeyRing {
  return {
    primary: config.encryptionKey,
    legacy: config.legacyEncryptionKeys.filter((key) => key !== config.encryptionKey),
  };
}

export function requireInstagramConfig() {
  const config = readInstagramConfig();
  if (!config) throw new InstagramConfigurationError();
  return config;
}

export class InstagramConfigurationError extends Error {
  constructor() { super("instagram_not_configured"); }
}
