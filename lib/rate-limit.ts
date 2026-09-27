import "server-only";

import { createAdminClient } from "@/utils/supabase/admin";

/**
 * Per-owner limits for routes that call the text AI provider. Each bucket is a
 * fixed window counted in Postgres (migration 0051), so limits hold across
 * every serverless instance.
 */
export const AI_RATE_LIMITS = {
  post_suggest: { limit: 30, windowSeconds: 600 },
  post_generate: { limit: 20, windowSeconds: 600 },
  campaign_build: { limit: 6, windowSeconds: 3600 },
  campaign_regenerate: { limit: 30, windowSeconds: 3600 },
  email_flow_create: { limit: 10, windowSeconds: 3600 },
  plan_run: { limit: 6, windowSeconds: 3600 },
  reel_produce: { limit: 20, windowSeconds: 3600 },
} as const;

export type AiRateLimitBucket = keyof typeof AI_RATE_LIMITS;

type RpcClient = Pick<ReturnType<typeof createAdminClient>, "rpc">;

/**
 * Consumes one request from the owner's bucket. Returns true when allowed.
 *
 * Fails open (allows the request and logs) only when the limiter itself is
 * unavailable — e.g. before migration 0051 is applied — so a missing counter
 * never takes the product down. A real "limit reached" answer always blocks.
 */
export async function consumeAiRateLimit(ownerId: string, bucket: AiRateLimitBucket, client?: RpcClient): Promise<boolean> {
  const { limit, windowSeconds } = AI_RATE_LIMITS[bucket];
  try {
    const db = client ?? createAdminClient();
    const { data, error } = await db.rpc("consume_rate_limit", {
      p_owner_user_id: ownerId,
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) {
      console.error("[rate-limit] limiter unavailable", { bucket, code: error.code });
      return true;
    }
    return data === true;
  } catch {
    console.error("[rate-limit] limiter unavailable", { bucket });
    return true;
  }
}

export function rateLimitedResponse(message = "You're making requests too quickly. Please wait a few minutes and try again.") {
  return Response.json({ error: message }, { status: 429, headers: { "Retry-After": "300" } });
}
