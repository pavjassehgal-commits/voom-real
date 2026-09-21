import "server-only";

import { z } from "zod";

import type { TikTokKeyRing } from "./crypto.ts";

/**
 * Server-side TikTok configuration. Nothing here is ever exposed to the
 * browser: the client secret and the token encryption key live only in the
 * server environment, exactly like the Instagram and YouTube configurations.
 *
 * `appAudited` reflects TikTok's Content Sharing Guidelines: until the API
 * client passes TikTok's content-sharing audit, all content it posts is
 * restricted to SELF_ONLY viewership and at most 5 users may post through
 * it in a 24-hour window. Voom defaults this to FALSE (restricted) — the
 * safe, truthful assumption — and even when it is true, the ACTUAL provider
 * response remains authoritative: a rejected privacy choice is recorded as
 * the provider refused it, and this flag only tunes the UI wording. It can
 * never make Voom claim a public publication that did not happen.
 */
const configSchema = z.object({
  clientKey: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectUri: z.string().url(),
  encryptionKey: z.string().min(32),
  /** Staged rotation target (read fallback), mirroring the Instagram ring. */
  nextEncryptionKey: z.string().min(32).optional(),
  /** Historical keys accepted for DECRYPTION ONLY. */
  legacyEncryptionKeys: z.array(z.string().min(32)).default([]),
  /** Whether Voom's TikTok app has passed TikTok's content-sharing audit. */
  appAudited: z.boolean().default(false),
});

export type TikTokConfig = z.infer<typeof configSchema>;

export function readTikTokConfig(): TikTokConfig | null {
  const parsed = configSchema.safeParse({
    clientKey: process.env.TIKTOK_CLIENT_KEY,
    clientSecret: process.env.TIKTOK_CLIENT_SECRET,
    redirectUri: process.env.TIKTOK_REDIRECT_URI,
    encryptionKey: process.env.TIKTOK_TOKEN_ENCRYPTION_KEY,
    nextEncryptionKey: optionalValue(process.env.TIKTOK_TOKEN_ENCRYPTION_KEY_NEXT),
    legacyEncryptionKeys: parseLegacyKeys(process.env.TIKTOK_TOKEN_ENCRYPTION_KEY_LEGACY),
    appAudited: String(process.env.TIKTOK_APP_AUDITED ?? "").trim().toLowerCase() === "true",
  });
  return parsed.success ? parsed.data : null;
}

function optionalValue(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function parseLegacyKeys(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((key) => key.trim()).filter(Boolean);
}

/** Read order is PRIMARY -> NEXT -> LEGACY; encryption uses PRIMARY only. */
export function tikTokKeyRing(config: TikTokConfig): TikTokKeyRing {
  const next = config.nextEncryptionKey && config.nextEncryptionKey !== config.encryptionKey
    ? config.nextEncryptionKey
    : undefined;
  const excluded = new Set([config.encryptionKey, ...(next ? [next] : [])]);
  const legacy = config.legacyEncryptionKeys.filter((key) => !excluded.has(key));
  return next
    ? { primary: config.encryptionKey, next, legacy }
    : { primary: config.encryptionKey, legacy };
}

export function requireTikTokConfig(): TikTokConfig {
  const config = readTikTokConfig();
  if (!config) throw new TikTokConfigurationError();
  return config;
}

export class TikTokConfigurationError extends Error {
  constructor() { super("tiktok_not_configured"); }
}
