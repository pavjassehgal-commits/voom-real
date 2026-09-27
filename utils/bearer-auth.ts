import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of `Authorization: Bearer <secret>`.
 *
 * Both sides are hashed to a fixed length first, so neither the comparison
 * time nor an early length mismatch reveals anything about the secret.
 * Returns false when the secret is unset — callers keep their own 503 for
 * "not configured" so workers stay fail-closed.
 */
export function bearerMatches(request: Request, secret: string | undefined | null): boolean {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const actual = createHash("sha256").update(header).digest();
  return timingSafeEqual(expected, actual);
}
