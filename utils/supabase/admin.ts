import "server-only";

import { createClient } from "@supabase/supabase-js";

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new Error("supabase_admin_not_configured");
  return createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });
}
