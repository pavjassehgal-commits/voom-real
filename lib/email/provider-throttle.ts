import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export class EmailProviderThrottleError extends Error {
  constructor() { super("email_provider_throttled"); }
}
/** Database-backed across instances, <=2 marketing API requests/second.
 * Bounded waiting happens OUTSIDE the transaction. No background job is added. */
export async function waitForEmailProviderSlot(db: SupabaseClient, sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await db.rpc("claim_marketing_email_provider_slot");
    if (error || typeof data !== "number" || data < 0 || data > 1000) throw new EmailProviderThrottleError();
    if (data === 0) return;
    if (attempt < 3) await sleep(data);
  }
  throw new EmailProviderThrottleError();
}
