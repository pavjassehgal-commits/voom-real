import "server-only";

import { z } from "zod";

const configSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  graphVersion: z.string().regex(/^v\d+\.\d+$/),
  redirectUri: z.string().url(),
  encryptionKey: z.string().min(32),
});

export type InstagramConfig = z.infer<typeof configSchema>;

export function readInstagramConfig(): InstagramConfig | null {
  const parsed = configSchema.safeParse({
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    graphVersion: process.env.META_GRAPH_VERSION,
    redirectUri: process.env.META_INSTAGRAM_REDIRECT_URI,
    encryptionKey: process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY,
  });
  return parsed.success ? parsed.data : null;
}

export function requireInstagramConfig() {
  const config = readInstagramConfig();
  if (!config) throw new InstagramConfigurationError();
  return config;
}

export class InstagramConfigurationError extends Error {
  constructor() { super("instagram_not_configured"); }
}
