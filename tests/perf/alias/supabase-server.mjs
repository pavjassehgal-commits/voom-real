/** Alias target for `@/utils/supabase/server` (session client). */
import { scenario } from "../fake-context.mjs";

export async function createClient() {
  return scenario().session;
}
