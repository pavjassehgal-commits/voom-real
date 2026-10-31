import "server-only";

import {
  STRUCTURED_FORMAT_FALLBACKS,
  STRUCTURED_MAX_ATTEMPTS,
  STRUCTURED_RETRY_MAX_DELAY_MS,
} from "@/lib/ai/openai-compatible";

/** Bounds enforced by claim_plan_slot_generation (migration 0070). */
export const SLOT_LEASE_MIN_SECONDS = 10;
export const SLOT_LEASE_MAX_SECONDS = 600;
/** Authorization re-checks, the fencing check and the draft write after generation. */
export const SLOT_PERSISTENCE_OVERHEAD_SECONDS = 30;

/**
 * The slot-generation lease must outlast the slowest generation a live worker
 * can still be running, or another worker takes the slot over while the first
 * is still paying for a provider call. The worst case for one slot is every
 * generation it may run (a matched-trend idea that falls back to an evergreen
 * one runs two), each making every provider request structured() allows
 * (retries + format fallbacks) at the configured timeout, plus retry backoff
 * and the persistence work after it.
 *
 * Returns null when that worst case cannot fit in the database's maximum
 * lease: the caller must then fail closed instead of starting a generation.
 */
export function slotLeaseSeconds(input: { requestTimeoutMs: number; generationsPerSlot: number }): number | null {
  const requests = STRUCTURED_MAX_ATTEMPTS + STRUCTURED_FORMAT_FALLBACKS;
  const backoffMs = (STRUCTURED_MAX_ATTEMPTS - 1) * STRUCTURED_RETRY_MAX_DELAY_MS;
  const perGenerationMs = requests * input.requestTimeoutMs + backoffMs;
  const worstMs = Math.max(1, input.generationsPerSlot) * perGenerationMs + SLOT_PERSISTENCE_OVERHEAD_SECONDS * 1000;
  const seconds = Math.ceil(worstMs / 1000);
  if (!Number.isFinite(seconds) || seconds > SLOT_LEASE_MAX_SECONDS) return null;
  return Math.max(SLOT_LEASE_MIN_SECONDS, seconds);
}
