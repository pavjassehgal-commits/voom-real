/** Alias target for `@/utils/supabase/admin` (service client). */
import { scenario } from "../fake-context.mjs";

export function createAdminClient() {
  return scenario().admin;
}
