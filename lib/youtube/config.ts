import "server-only";

import { z } from "zod";

import type { YouTubeKeyRing } from "./crypto.ts";

/**
 * Server-side YouTube (Google) configuration. Nothing here is ever exposed
 * to the browser: the client secret and the token encryption key live only
 * in the server environment, exactly like the Instagram configuration.
 *
 * `projectAudited` reflects Google's documented restriction: videos.insert
 * from API projects created after 2020-07-28 that have NOT passed the
 * YouTube API Services Compliance Audit is locked to private viewing mode.
 * Voom defaults this to FALSE (restricted) — the safe, truthful assumption —
 * and even when it is true, the actual privacy YouTube applied is read back
 * from the provider and stored. Configuration can never make Voom claim a
 * public publication that did not happen.
 */
const configSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  redirectUri: z.string().url(),
  encryptionKey: z.string().min(32),
  /** Staged rotation target (read fallback), mirroring the Instagram ring. */
  nextEncryptionKey: z.string().min(32).optional(),
  /** Historical keys accepted for DECRYPTION ONLY. */
  legacyEncryptionKeys: z.array(z.string().min(32)).default([]),
  projectAudited: z.boolean().default(false),
});

export type YouTubeConfig = z.infer<typeof configSchema>;

export function readYouTubeConfig(): YouTubeConfig | null {
  const parsed = configSchema.safeParse({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.YOUTUBE_REDIRECT_URI,
    encryptionKey: process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY,
    nextEncryptionKey: optionalValue(process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY_NEXT),
    legacyEncryptionKeys: parseLegacyKeys(process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY_LEGACY),
    projectAudited: String(process.env.YOUTUBE_PROJECT_AUDITED ?? "").trim().toLowerCase() === "true",
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
export function youTubeKeyRing(config: YouTubeConfig): YouTubeKeyRing {
  const next = config.nextEncryptionKey && config.nextEncryptionKey !== config.encryptionKey
    ? config.nextEncryptionKey
    : undefined;
  const excluded = new Set([config.encryptionKey, ...(next ? [next] : [])]);
  const legacy = config.legacyEncryptionKeys.filter((key) => !excluded.has(key));
  return next
    ? { primary: config.encryptionKey, next, legacy }
    : { primary: config.encryptionKey, legacy };
}

export function requireYouTubeConfig(): YouTubeConfig {
  const config = readYouTubeConfig();
  if (!config) throw new YouTubeConfigurationError();
  return config;
}

export class YouTubeConfigurationError extends Error {
  constructor() { super("youtube_not_configured"); }
}
