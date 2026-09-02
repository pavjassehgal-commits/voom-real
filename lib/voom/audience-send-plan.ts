/**
 * Pure send planning for audience campaigns. No I/O, no env, no third-party
 * imports — safe to unit test and trivially auditable.
 *
 * STRICT cap semantics: if the number of eligible destinations exceeds the
 * per-send cap, the ENTIRE send is refused and no batch is ever produced.
 * The eligible list is never sliced and a partial send is impossible — a
 * refused plan structurally carries no `batch` to iterate, so zero recipients
 * are contacted and zero provider calls are made.
 */
export type AudienceSendPlan<T> =
  | { ok: true; batch: T[]; total: number; cap: number; overLimit: 0 }
  | { ok: false; reason: "over_cap"; total: number; cap: number; overLimit: number };

export function planAudienceSend<T>(destinations: readonly T[], cap: number): AudienceSendPlan<T> {
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new Error("invalid_send_cap");
  }
  if (destinations.length > cap) {
    return {
      ok: false,
      reason: "over_cap",
      total: destinations.length,
      cap,
      overLimit: destinations.length - cap,
    };
  }
  return { ok: true, batch: [...destinations], total: destinations.length, cap, overLimit: 0 };
}
